"""Poll DTEK Dnipro for this address: current outage, queue, and hourly schedule.

    python HomeAssistant/config/dtek/dtek_poll.py
    python HomeAssistant/config/dtek/dtek_poll.py --verbose      # request log on stderr
    python HomeAssistant/config/dtek/dtek_poll.py --find Dnipro  # spell the address right

Prints one JSON object on stdout and always exits 0. On the Home Assistant box
the command_line sensor in packages/dtek_shutdowns.yaml runs this every five
minutes; a non-zero exit or an empty line there blanks every dependent entity
to `unknown`, so every failure path below still prints the last good payload
with stale=true rather than nothing at all.

Address comes from DTEK_CITY / DTEK_STREET / DTEK_HOUSE if those are set, and
otherwise from dtek_city / dtek_street / dtek_house in secrets.yaml next door.
The strings must match DTEK's own spelling exactly, which is less obvious than
it sounds: Dnipro lists two separate streets whose names differ only in word
order, and they sit in different queues. Use --find before guessing.

---------------------------------------------------------------------------
The API

There is no documented API. This drives the same endpoint the address form on
https://www.dtek-dnem.com.ua/ua/shutdowns drives, which is Yii2 behind an
Imperva CDN: no login, no JS challenge, but a session cookie AND an
X-CSRF-Token header, both harvested from the page itself. Missing either one
returns "Bad Request (#400)".

THE ONE REAL GOTCHA, and the first thing to check if this ever starts failing:
the data[0][name] parameter names must be PERCENT-ENCODED (data%5B0%5D%5Bname%5D).
Sent with literal brackets the server answers {"result":false,"text":"Error"},
which is indistinguishable from a wrong address and sends you hunting in the
wrong place for an afternoon. jQuery's $.param encodes them, which is why the
site works and the obvious hand-rolled request does not. See encode_form().

Steady state is two small POSTs per run. The 190 KB page is fetched only to
establish a session, because checkDisconUpdate answers in 18 bytes when the
schedule has not changed and returns the whole thing when it has.

THE OTHER THING THAT IS NOT OBVIOUS: the getHomeNum answer carries six booleans
next to `data` -- showCurOutageParam, showCurSchedule, showTableSchedule,
showTablePlan, showTableFact, showUserGroup -- and DTEK's own page draws nothing
it has not been given permission to draw. src/js/static/discon-schedule.js:712
gates the whole recurring weekly table on `showTablePlan`, with no else branch,
so when that flag is false the site simply shows no grid; the pattern is still
sitting in preset.data, it just does not apply. Reading `data` and dropping the
flags means publishing a schedule DTEK has withdrawn. visibility() below is a
transcription of the site's own rules, including the two client-side overrides
it applies on top of the flags (discon-schedule.js:48-53 and :1107-1112) and the
tableHidden() cases at :413.

Absent flags default to True on purpose. A field DTEK renames must not blank a
valid grid -- that is this same bug inverted, and harder to notice.
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, time as dtime
from pathlib import Path
from urllib.parse import quote
from zoneinfo import ZoneInfo

BASE = "https://www.dtek-dnem.com.ua"
SHUTDOWNS_URL = BASE + "/ua/shutdowns"
AJAX_URL = BASE + "/ua/ajax"
KYIV = ZoneInfo("Europe/Kyiv")
TIMEOUT = 15

# A real browser UA. Not evasion -- the site serves a different (broken) page to
# clients it does not recognise, and this is the one its own JS is written for.
USER_AGENT = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

HERE = Path(__file__).resolve().parent
# On the box HERE is /config/dtek, so these land on /config/dtek/.cache.json and
# /config/secrets.yaml without special-casing anything.
CACHE_PATH = Path(os.environ.get("DTEK_CACHE") or HERE / ".cache.json")
# Raw answers, one file per status change -- see save_capture(). Excluded from
# ha_pull.sh and .gitignore: promoting one to tools/fixtures/ is a decision.
CAPTURE_DIR = Path(os.environ.get("DTEK_CAPTURES") or HERE / "captures")
CAPTURE_KEEP = 30
SECRETS_PATH = Path(os.environ.get("DTEK_SECRETS") or HERE.parent / "secrets.yaml")

# The seven states DTEK uses, from preset.time_type, compressed to one character
# each so that today/tomorrow ride in a 24-byte attribute instead of a kilobyte
# of JSON. Uppercase is the "possible" variant of the lowercase one.
STATE_LETTER = {"yes": "y", "no": "n", "maybe": "m",
                "first": "f", "second": "s", "mfirst": "F", "msecond": "S"}

# Which halves of the hour are dark. `maybe` counts as dark for scheduling
# purposes: an alert that stayed quiet for "possible outage" ("mozhlyvo vidkliuchennia") would be quiet
# for most of a real Ukrainian outage schedule.
OFF_HALVES = {"yes": (False, False), "no": (True, True), "maybe": (True, True),
              "first": (True, False), "mfirst": (True, False),
              "second": (False, True), "msecond": (False, True)}

# Worst-case ordering, used only to merge the two queues of a house fed by two
# lines. Ranked by how much of the hour could be dark, so `maybe` (up to 60 min,
# uncertain) outranks `first` (exactly 30 min, certain). The merge never
# promises power it cannot deliver, which is the only property that matters.
SEVERITY = {"yes": 0, "msecond": 1, "mfirst": 1,
            "second": 2, "first": 2, "maybe": 3, "no": 4}

# The six booleans getHomeNum returns beside `data`. Named the way DTEK names
# them, mismatched first one included, so that this list can be diffed against
# discon-schedule.js:948-953 without a translation step.
FLAG_KEYS = ("showCurOutageParam", "showCurSchedule", "showTableSchedule",
             "showTablePlan", "showTableFact", "showUserGroup")

# Every token visibility() can put in hidden_reason, in the order the rules
# fire. Named here rather than only inline so the card's copy of the sentences
# can be checked against it -- a reason with no sentence falls back to "awaiting
# updated schedules", which is a lie for the three that never lift.
HIDDEN_REASONS = ("table_off", "empty_preset", "plan_off", "no_queue",
                  "unknown_queue", "cek", "voluntarily",
                  "emergency_no_schedule")

# Everything DTEK has ever sent in a house record and beside `data`. Anything
# outside these is reported in `warnings` rather than ignored: the 29.09.2026
# outage was published with no times at all because a format changed and
# nothing said so. See drift_warnings().
ENTRY_KEYS = frozenset(("sub_type", "start_date", "end_date", "type",
                        "sub_type_reason", "voluntarily", "cek"))
ANSWER_KEYS = frozenset(("result", "data", "updateTimestamp") + FLAG_KEYS)
OUTAGE_TYPES = frozenset(("1", "2"))

# The one sub_type that voids the schedule outright rather than suspending it.
# Matched verbatim against discon-schedule.js:492, which does the same.
EMERGENCY_SUB_TYPE = ("Екстренні відключення (Аварійне без застосування "
                      "графіку погодинних відключень)")


def log(msg):
    if VERBOSE:
        print("[dtek] " + msg, file=sys.stderr)


# --- address ---------------------------------------------------------------

def read_secrets():
    """city, street, house from the environment, falling back to secrets.yaml.

    PyYAML ships inside the Home Assistant container, but this also has to run
    from a laptop that may not have it, so a missing import degrades to a line
    scan rather than to an error. secrets.yaml is flat scalars; there is no
    structure here worth a parser.
    """
    env = (os.environ.get("DTEK_CITY"), os.environ.get("DTEK_STREET"),
           os.environ.get("DTEK_HOUSE"))
    if all(env):
        log("address from environment")
        return env

    if not SECRETS_PATH.exists():
        raise RuntimeError("no DTEK_CITY/STREET/HOUSE in the environment and "
                           "no %s to read them from" % SECRETS_PATH)
    text = SECRETS_PATH.read_text(encoding="utf-8")
    data = {}
    try:
        import yaml
        data = yaml.safe_load(text) or {}
    except ImportError:
        for line in text.splitlines():
            m = re.match(r'^\s*(dtek_\w+)\s*:\s*(.*?)\s*$', line)
            if m:
                data[m.group(1)] = m.group(2).strip('"\'')

    missing = [k for k in ("dtek_city", "dtek_street", "dtek_house")
               if not str(data.get(k, "")).strip()]
    if missing:
        raise RuntimeError("%s: missing %s" % (SECRETS_PATH, ", ".join(missing)))
    log("address from %s" % SECRETS_PATH)
    return (str(data["dtek_city"]).strip(), str(data["dtek_street"]).strip(),
            str(data["dtek_house"]).strip())


# --- cache -----------------------------------------------------------------

def load_cache():
    try:
        return json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_cache(cache):
    """Best effort. A read-only /config must not be able to break the sensor."""
    try:
        CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = CACHE_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(cache), encoding="utf-8")
        tmp.replace(CACHE_PATH)
    except OSError as exc:
        log("cache not written: %s" % exc)


# --- HTTP ------------------------------------------------------------------

class Session:
    """Just enough of a browser: a cookie dict and the CSRF token off the page.

    http.cookiejar would work too, but this has to survive as JSON between runs
    five minutes apart, and a name->value dict is the whole of what the site
    actually needs back.
    """

    def __init__(self, cache):
        self.cookies = dict(cache.get("cookies") or {})
        self.csrf = cache.get("csrf")
        self.preset = cache.get("preset")
        self.fact = cache.get("fact")
        self.bootstrapped = False

    def _open(self, req):
        if self.cookies:
            req.add_header("Cookie", "; ".join(
                "%s=%s" % kv for kv in self.cookies.items()))
        req.add_header("User-Agent", USER_AGENT)
        req.add_header("Accept-Language", "uk-UA,uk;q=0.9")
        resp = urllib.request.urlopen(req, timeout=TIMEOUT)
        for raw in resp.headers.get_all("Set-Cookie") or []:
            name, _, rest = raw.partition("=")
            self.cookies[name.strip()] = rest.split(";", 1)[0]
        return resp

    def bootstrap(self):
        """GET the page for a session cookie, a CSRF token, preset and fact.

        All four arrive in one response, which is the only reason this is worth
        190 KB. Called lazily -- a warm cache never touches it.
        """
        log("GET %s" % SHUTDOWNS_URL)
        req = urllib.request.Request(SHUTDOWNS_URL)
        req.add_header("Accept-Encoding", "identity")
        html = self._open(req).read().decode("utf-8", "replace")

        m = re.search(r'<meta name="csrf-token" content="([^"]+)"', html)
        if not m:
            raise RuntimeError("no csrf-token meta on the shutdowns page")
        self.csrf = m.group(1)
        self.preset = extract_inline(html, "DisconSchedule.preset") or self.preset
        self.fact = extract_inline(html, "DisconSchedule.fact") or self.fact
        self.bootstrapped = True

    def post(self, fields):
        req = urllib.request.Request(
            AJAX_URL, data=encode_form(fields).encode("ascii"), method="POST")
        req.add_header("Content-Type",
                       "application/x-www-form-urlencoded; charset=UTF-8")
        req.add_header("X-Requested-With", "XMLHttpRequest")
        req.add_header("X-CSRF-Token", self.csrf or "")
        req.add_header("Referer", SHUTDOWNS_URL)
        log("POST %s method=%s" % (AJAX_URL, dict(fields).get("method")))
        return json.loads(self._open(req).read().decode("utf-8"))


def encode_form(fields):
    """Percent-encode names as well as values -- see THE ONE REAL GOTCHA above.

    urlencode() would leave the brackets in data[0][name] alone, the CDN in
    front of the site would take exception, and the app would answer "Error".
    """
    return "&".join("%s=%s" % (quote(k, safe=""), quote(str(v), safe=""))
                    for k, v in fields)


def extract_inline(html, name):
    """Pull one `DisconSchedule.<name> = {...}` object out of the page HTML.

    Decoded with raw_decode rather than a regex, because the objects are large,
    nested, and full of braces inside Ukrainian strings.
    """
    i = html.find(name + " = ")
    if i < 0:
        return None
    try:
        obj, _ = json.JSONDecoder().raw_decode(html[i + len(name) + 3:])
        return obj
    except ValueError:
        return None


def address_fields(city, street, house):
    return [("method", "getHomeNum"),
            ("data[0][name]", "city"), ("data[0][value]", city),
            ("data[1][name]", "street"), ("data[1][value]", street),
            ("data[2][name]", "house_num"), ("data[2][value]", house)]


# --- schedule --------------------------------------------------------------

def merge_states(states):
    """Collapse one hour's state across every queue feeding the house.

    A house with two entries in sub_type_reason is fed by two lines and DTEK
    will not say which one this flat is on -- it points at its chat bots and
    gives up. The pessimistic merge is the only honest answer available here.
    """
    known = [s for s in states if s in SEVERITY]
    if not known:
        return None
    return max(known, key=lambda s: SEVERITY[s])


def day_states(fact_day, queues):
    """24 hour-states for one day, or None if the day is not in the data."""
    if not isinstance(fact_day, dict):
        return None
    out = []
    for hour in range(1, 25):
        per_queue = [(fact_day.get(q) or {}).get(str(hour)) for q in queues]
        out.append(merge_states(per_queue))
    return out


def encode_day(states):
    if states is None:
        return None
    return "".join(STATE_LETTER.get(s, "?") for s in states)


def week_states(preset, queues):
    """The recurring weekly table for this house, Monday first.

    Once a weekday is fixed, preset.data[queue][weekday] has exactly the
    {queue: {hour: state}} shape day_states() already wants, so this is the same
    merge the applied schedule gets -- including the pessimistic union for a
    house fed by two lines.

    Built even when fact.data is empty, which is deliberate and is the whole
    reason this exists: DTEK has served an empty fact since 24.07.2026, and the
    recurring table is the only schedule there is to show until that changes.

    It is what MIGHT be applied, never what IS being applied. Anything that
    displays it has to say so, or it reads as tonight's outages.
    """
    data = (preset or {}).get("data") or {}
    if not data or not queues:
        return None
    out = []
    for weekday in range(1, 8):                      # 1 = Monday, as DTEK keys it
        day = {q: (data.get(q) or {}).get(str(weekday)) or {} for q in queues}
        out.append(encode_day(day_states(day, queues)))
    # All "?" means the queue is absent from the table rather than idle.
    if all(set(d) <= {"?"} for d in out):
        return None
    return out


def visibility(answer, fact, preset, queues, entry):
    """Whether DTEK is showing the weekly grid and the day tables, and why not.

    A transcription of discon-schedule.js. The site never renders a block it has
    not been told to render, and it says so per address in the getHomeNum answer;
    everything below is that answer plus the two overrides the page applies to it
    locally. Returns (flags, week_in_effect, schedule_visible, hidden_reason).

    hidden_reason names the FIRST rule that fired, so a card can pick the right
    sentence: `plan_off` comes back when the schedules do, `cek` does not.
    """
    # Absent means shown. See the module docstring: a renamed field must not
    # blank a grid that DTEK is still publishing.
    flags = {k: answer.get(k, True) is not False for k in FLAG_KEYS}

    preset = preset or {}
    fact = fact or {}
    has_preset = bool(preset.get("data"))
    has_fact = bool(fact.get("data"))

    # discon-schedule.js:48-53, repeated verbatim at :960-965 and :1142-1147.
    if (not has_fact and not has_preset) or not preset.get("time_zone"):
        for key in ("showCurSchedule", "showTableFact", "showTableSchedule",
                    "showUserGroup"):
            flags[key] = False
    # discon-schedule.js:1107-1112, applied after every checkDisconUpdate.
    if not has_preset:
        flags["showTableSchedule"] = False

    reason = None
    if not flags["showTableSchedule"]:          # :711, an outright return
        reason = "empty_preset" if not has_preset else "table_off"
    elif not flags["showTablePlan"]:            # :712, the branch with no else
        reason = "plan_off"
    elif not queues:                            # :437-438, :486-488
        reason = "no_queue"
    elif len(queues) == 1 and not (preset.get("sch_names") or {}).get(queues[0]):
        reason = "unknown_queue"                # :524-526
    elif entry.get("cek"):                      # :447-451
        reason = "cek"
    elif entry.get("voluntarily") and (entry.get("sub_type") or "").strip():
        reason = "voluntarily"                  # :481-484
    elif (entry.get("sub_type") or "").strip() == EMERGENCY_SUB_TYPE:
        reason = "emergency_no_schedule"        # :492-496

    # :533 and :555 gate today/tomorrow, which is a different question from
    # whether the recurring pattern applies -- hence a second boolean.
    schedule_visible = bool(
        flags["showCurSchedule"] and flags["showTableFact"] and queues
        and reason not in ("cek", "voluntarily", "emergency_no_schedule"))

    return flags, reason is None, schedule_visible, reason


def half_hour_slots(day_date, states):
    """(datetime, is_dark) every 30 minutes through one local day.

    Built from wall-clock times rather than by adding timedeltas to midnight,
    so that the twice-yearly DST step cannot slide the whole grid by an hour.
    """
    slots = []
    for hour, state in enumerate(states):
        if state is None:
            continue
        first, second = OFF_HALVES.get(state, (False, False))
        base = datetime.combine(day_date, dtime(hour=hour), tzinfo=KYIV)
        slots.append((base, first))
        slots.append((base.replace(minute=30), second))
    return slots


def find_edges(slots, now):
    """The next light->dark and dark->light transitions strictly after `now`.

    Edges, not "the next dark slot": during an outage the next dark slot is the
    one you are already sitting in, and an alert built on that would fire
    continuously for four hours.

    Both are always meaningful, and the pair describes one window. With the
    power on they are the start and end of the next outage. During an outage
    the dark->light edge is when this one ends and the light->dark edge is the
    following window. That is why the second is called next_outage_end and not
    next_power_on: only one of those two names is true in both states.
    """
    next_off = next_on = None
    for prev, cur in zip(slots, slots[1:]):
        moment, was_dark, is_dark = cur[0], prev[1], cur[1]
        if moment <= now or was_dark == is_dark:
            continue
        if is_dark and next_off is None:
            next_off = moment
        if not is_dark and next_on is None:
            next_on = moment
    return next_off, next_on


# Time FIRST is what getHomeNum actually sends ("11:05 29.09.2026", captured in
# tools/fixtures/dtek_emergency_20260929.json). Parsing only the date-first
# shape turned a live emergency outage into outage_start/_end = null without a
# single error, so both are accepted and the observed one is tried first.
DTEK_DATETIME_FORMATS = ("%H:%M %d.%m.%Y", "%d.%m.%Y %H:%M")


def parse_dtek_datetime(text):
    """'HH:MM dd.mm.yyyy' (or 'dd.mm.yyyy HH:MM') -> ISO 8601 in Kyiv, or None."""
    if not text:
        return None
    for fmt in DTEK_DATETIME_FORMATS:
        try:
            naive = datetime.strptime(text.strip(), fmt)
        except ValueError:
            continue
        return naive.replace(tzinfo=KYIV).isoformat()
    return None


def drift_warnings(entry, answer, start, end):
    """Everything in this answer the poller could not fully read, as sentences.

    Empty on a normal poll. Not an error: the payload is still published with
    whatever did parse, and the raw strings ride along beside it, so a changed
    format degrades to "shown verbatim, flagged" instead of to null.
    """
    out = []
    for name, raw in (("start_date", start), ("end_date", end)):
        if raw and parse_dtek_datetime(raw) is None:
            out.append("unreadable %s %r" % (name, raw))
    otype = (entry.get("type") or "").strip()
    if otype and otype not in OUTAGE_TYPES:
        out.append("unknown outage type %r" % otype)
    extra = sorted(set(entry) - ENTRY_KEYS)
    if extra:
        out.append("new field(s) in the house record: " + ", ".join(extra))
    extra = sorted(set(answer or {}) - ANSWER_KEYS)
    if extra:
        out.append("new field(s) beside data: " + ", ".join(extra))
    return out


def street_scope(answer):
    """(houses with an outage record, houses listed) for the whole street.

    getHomeNum answers for every house on the street, not just ours, so this
    costs nothing. It separates a fault in this building (1 of 288, as on
    29.09.2026) from one on the line or the queue.
    """
    data = (answer or {}).get("data")
    if not isinstance(data, dict) or not data:
        return None, None
    hit = sum(1 for e in data.values() if isinstance(e, dict) and any(
        (e.get(k) or "").strip() for k in ("sub_type", "start_date", "end_date")))
    return hit, len(data)


def resolve(entry, answer, fact, preset, now):
    """Turn one getHomeNum entry plus the current fact/preset into the payload."""
    queues = [q for q in (entry.get("sub_type_reason") or []) if q]
    names = (preset or {}).get("sch_names") or {}
    label = names.get(queues[0]) if len(queues) == 1 else None

    sub_type = (entry.get("sub_type") or "").strip()
    start = (entry.get("start_date") or "").strip()
    end = (entry.get("end_date") or "").strip()
    # DTEK signals "nothing recorded" by clearing all three, not by a flag.
    active = bool(sub_type or start or end)
    otype = (entry.get("type") or "").strip() or None

    out = {
        "queue": queues[0].replace("GPV", "") if len(queues) == 1 else None,
        "queue_code": queues[0] if len(queues) == 1 else None,
        "queue_label": label,
        "queues": queues,
        "multi_line": len(queues) > 1,
        "cek": bool(entry.get("cek")),
        "voluntarily": bool(entry.get("voluntarily")),
        "outage_active": active,
        "outage_type": otype,
        "outage_reason": sub_type or None,
        "outage_start": parse_dtek_datetime(start),
        "outage_end": parse_dtek_datetime(end),
        # Verbatim, so a format the parser misses is still on the dashboard.
        "outage_start_raw": start or None,
        "outage_end_raw": end or None,
        "warnings": drift_warnings(entry, answer, start, end),
        "schedule_update": (fact or {}).get("update"),
        # From preset, not fact, so this survives the early return below.
        "week": week_states(preset, queues),
    }

    # Whether DTEK is drawing any of this on its own site. `week` above stays
    # populated either way -- the pattern is still the last one published, and
    # nulling it would lose it from recorder history -- but week_in_effect is
    # what says whether it currently means anything.
    flags, week_ok, sched_ok, hidden = visibility(
        answer or {}, fact, preset, queues, entry)
    out["street_outages"], out["street_houses"] = street_scope(answer)
    out.update(
        week_in_effect=week_ok,
        schedule_visible=sched_ok,
        hidden_reason=hidden,
        # DTEK's own "information updated" date, minutes old, as against
        # schedule_update which is the stamp on the last published schedule and
        # has read 24.07.2026 since the day they suspended them.
        updated_at=(answer or {}).get("updateTimestamp"),
        dtek_flags=flags,
    )

    # fact.data is [] whenever stabilisation schedules are not in force, which
    # is a normal state of the world and not a failure. Everything schedule
    # shaped stays null rather than falling back to the weekly preset, which
    # would advertise outages that nobody has actually scheduled.
    days = (fact or {}).get("data") or {}
    if not isinstance(days, dict) or not days or not queues:
        out.update(schedule_in_effect=False, now_state=None, today=None,
                   tomorrow=None, next_outage_start=None, next_outage_end=None)
        return out

    # Day keys are epoch seconds at Kyiv midnight; fact.today names the first.
    # Taken from the data rather than computed from the local clock, so a box
    # in the wrong timezone reads the right column.
    keys = sorted(days, key=int)
    dates = [datetime.fromtimestamp(int(k), KYIV).date() for k in keys]
    states = [day_states(days[k], queues) for k in keys]

    today_idx = next((i for i, d in enumerate(dates) if d == now.date()), None)
    slots = []
    for date, day in zip(dates, states):
        if day:
            slots.extend(half_hour_slots(date, day))
    slots.sort()
    next_off, next_on = find_edges(slots, now)

    now_state = None
    if today_idx is not None and states[today_idx]:
        now_state = states[today_idx][now.hour]

    out.update(
        schedule_in_effect=True,
        now_state=now_state,
        today=encode_day(states[today_idx]) if today_idx is not None else None,
        tomorrow=encode_day(states[today_idx + 1])
        if today_idx is not None and today_idx + 1 < len(states) else None,
        next_outage_start=next_off.isoformat() if next_off else None,
        next_outage_end=next_on.isoformat() if next_on else None,
    )
    return out


# --- the poll --------------------------------------------------------------

def house_entry(data, house):
    """Find our house in the street's house->record map, tolerantly."""
    if not isinstance(data, dict):
        return None
    if house in data:
        return data[house]
    want = house.strip().lower().replace(" ", "")
    for key, value in data.items():
        if key.strip().lower().replace(" ", "") == want:
            return value
    return None


def fetch_entry(session, city, street, house):
    """getHomeNum -> (entry, answer), re-establishing a stale session once.

    Exactly one retry. A tight loop against a CDN is how a five-minute poll
    turns into a block, and nothing here is worth that.
    """
    for attempt in (1, 2):
        try:
            answer = session.post(address_fields(city, street, house))
        except urllib.error.HTTPError as exc:
            if exc.code != 400 or attempt == 2:
                raise
            log("400 -- session expired, re-bootstrapping")
            session.bootstrap()
            continue

        if answer.get("result"):
            entry = house_entry(answer.get("data"), house)
            if entry is None:
                raise RuntimeError(
                    "no house %r on %r in %r -- check the spelling against "
                    "--find" % (house, street, city))
            # The answer, not just the entry: the visibility flags sit beside
            # `data` and are the whole point of visibility().
            return entry, answer

        # {"result": false, "text": "Error"} is ambiguous by design: a dead
        # session and a misspelt street look identical. Assume the session on
        # the first pass, and only then blame the address.
        if attempt == 1 and not session.bootstrapped:
            log("result=false -- re-bootstrapping before blaming the address")
            session.bootstrap()
            continue
        raise RuntimeError(
            "DTEK rejected the lookup for %r / %r / %r. Either the address is "
            "not spelled the way DTEK spells it (try --find), or the form "
            "encoding regressed -- see THE ONE REAL GOTCHA at the top."
            % (city, street, house))
    raise RuntimeError("unreachable")


def refresh_schedule(session):
    """checkDisconUpdate: 18 bytes when nothing changed, everything when it did."""
    # A stamp DTEK can only consider stale, so a cold cache gets the full
    # fact+preset without paying for the page.
    last = (session.fact or {}).get("update") or "01.01.2020 00:00"
    try:
        answer = session.post([("method", "checkDisconUpdate"), ("update", last)])
    except (urllib.error.URLError, ValueError) as exc:
        log("checkDisconUpdate failed, keeping cached schedule: %s" % exc)
        return
    if answer.get("result") and answer.get("fact"):
        log("schedule changed: %s -> %s"
            % (last, answer["fact"].get("update")))
        session.fact = answer["fact"]
        session.preset = answer.get("preset") or session.preset


def status_for(payload):
    if not payload.get("outage_active"):
        return "ok"
    return {"1": "outage_planned", "2": "outage_emergency"}.get(
        payload.get("outage_type"), "outage")


def save_capture(answer, payload, session, house):
    """Keep the raw answer whenever the status or the warnings change.

    The 29.09.2026 golden fixture was captured by hand with the outage an hour
    from ending. This makes the next one a file copy. Same shape as
    tools/fixtures/dtek_emergency_20260929.json, so a capture drops into
    test_dtek_schedule.py unchanged. No cookies, no CSRF, no street name.
    Best effort, like save_cache().
    """
    stamp = payload["fetched_at"][:19].replace(":", "").replace("-", "")
    body = {"_meta": {"captured_at": payload["fetched_at"], "house": house,
                      "status": payload["status"],
                      "warnings": payload["warnings"]},
            "getHomeNum": answer, "fact": session.fact, "preset": session.preset}
    try:
        CAPTURE_DIR.mkdir(parents=True, exist_ok=True)
        path = CAPTURE_DIR / ("%s_%s.json" % (stamp, payload["status"]))
        path.write_text(json.dumps(body, ensure_ascii=False, indent=1),
                        encoding="utf-8")
        log("captured %s" % path.name)
        for old in sorted(CAPTURE_DIR.glob("*.json"))[:-CAPTURE_KEEP]:
            old.unlink()
    except OSError as exc:
        log("capture not written: %s" % exc)


def poll(cache):
    city, street, house = read_secrets()
    session = Session(cache)
    if not session.csrf or not session.cookies or not session.preset:
        session.bootstrap()

    entry, answer = fetch_entry(session, city, street, house)
    refresh_schedule(session)

    now = datetime.now(KYIV).replace(microsecond=0)
    payload = resolve(entry, answer, session.fact, session.preset, now)
    # The address DTEK matched, so the dashboard can say which building this
    # schedule is for. Published from here rather than typed into the Lovelace
    # card, because dashboards/ IS committed and secrets.yaml deliberately is
    # not -- a card option would put the home address into git.
    #
    # Street and house only. The city never varies for one house and would just
    # eat the width of the line that shows this.
    payload["address"] = ", ".join(p for p in (street, house) if p) or None
    payload["status"] = status_for(payload)
    payload["fetched_at"] = now.isoformat()
    payload["stale"] = False
    payload["error"] = None

    prev = cache.get("last_good") or {}
    if (prev.get("status"), prev.get("warnings")) != (payload["status"],
                                                      payload["warnings"]):
        save_capture(answer, payload, session, house)

    cache.update(cookies=session.cookies, csrf=session.csrf,
                 preset=session.preset, fact=session.fact, last_good=payload)
    save_cache(cache)
    return payload


# --- address lookup --------------------------------------------------------

def find(term, street_term):
    """Print DTEK's own spelling of a city, or of a street inside one.

    getStreets is 582 KB and is never called by the poll -- it exists so that
    filling in secrets.yaml is a lookup instead of a guess.
    """
    session = Session({})
    session.bootstrap()
    streets = session.post([("method", "getStreets")]).get("streets") or {}

    cities = [c for c in streets if term.lower() in c.lower()]
    if not cities:
        print("no city matching %r among %d" % (term, len(streets)))
        return 1
    for city in sorted(cities)[:20]:
        if street_term is None:
            print(city)
            continue
        matches = [s for s in streets[city] if street_term.lower() in s.lower()]
        print("%s  (%d streets, %d matching)"
              % (city, len(streets[city]), len(matches)))
        for name in sorted(matches)[:40]:
            print("    " + name)
    return 0


# --- entry point -----------------------------------------------------------

VERBOSE = False


def main(argv=None):
    global VERBOSE
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--verbose", action="store_true", help="request log on stderr")
    ap.add_argument("--find", metavar="CITY",
                    help="print DTEK's spelling of matching cities and exit")
    ap.add_argument("--street", metavar="TEXT",
                    help="with --find, also list matching streets in each city")
    args = ap.parse_args(argv)
    VERBOSE = args.verbose

    if args.find:
        return find(args.find, args.street)

    cache = load_cache()
    try:
        payload = poll(cache)
    except Exception as exc:                      # noqa: BLE001 - see below
        # Deliberately bare. This is the last line before a command_line sensor,
        # and the difference between a wrong number and no number at all is the
        # difference between a stale reading and every dependent entity in the
        # house going unavailable at once.
        log("poll failed: %r" % exc)
        payload = dict(cache.get("last_good") or {})
        payload["status"] = "stale" if payload else "error"
        payload["stale"] = True
        payload["error"] = "%s: %s" % (type(exc).__name__, exc)
        payload.setdefault("fetched_at", None)

    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
