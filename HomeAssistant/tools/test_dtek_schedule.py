"""Exercise dtek_poll's schedule maths against fixtures. No network.

    python HomeAssistant/tools/test_dtek_schedule.py

This exists because the code it tests cannot currently be tested any other way.
DTEK suspended stabilisation schedules on 24.07.2026, so the live endpoint has
returned `fact.data: []` ever since -- every schedule path in dtek_poll.py
(now_state, the 24-character day strings, the next_outage_start/next_outage_end
edges) is dead code against production right now and will stay that way until
the schedules come back, probably in the middle of a night in November.

The fixtures below are real: `preset` is the weekly table the site actually
serves, which IS populated, reshaped into the `fact` layout. The handmade days
cover the cases the real table happens not to contain.
"""
import copy
import json
import sys
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "config" / "dtek"))
import dtek_poll as p                                          # noqa: E402

KYIV = p.KYIV
FAILED = []


def check(label, got, want):
    ok = got == want
    if not ok:
        FAILED.append(label)
    print("  %-4s %-46s %r%s" % ("ok" if ok else "FAIL", label, got,
                                 "" if ok else "   want %r" % (want,)))


def midnight(d):
    return int(datetime.combine(d, datetime.min.time(), tzinfo=KYIV).timestamp())


def fact_from(day_map):
    """{date: {queue: {hour: state}}} -> the shape fact.data really has."""
    return {"update": "01.01.2026 00:00",
            "today": midnight(min(day_map)),
            "data": {str(midnight(d)): q for d, q in day_map.items()}}


def entry(queues):
    return {"sub_type": "", "start_date": "", "end_date": "", "type": "",
            "sub_type_reason": queues, "voluntarily": None, "cek": None}


def day(states):
    """24 hour-states given as a 24-item list -> the {hour: state} DTEK sends."""
    return {str(i + 1): s for i, s in enumerate(states)}


def weekly(queue_states):
    """{queue: [7 lists of 24 states]} -> the preset.data shape DTEK sends."""
    return {"sch_names": {q: "queue " + q.replace("GPV", "") for q in queue_states},
            "data": {q: {str(d + 1): day(week[d]) for d in range(7)}
                     for q, week in queue_states.items()}}


def marked(weekday_index):
    """A distinct day per weekday, so a transposed index cannot pass by luck."""
    states = ["yes"] * 24
    states[weekday_index] = "no"        # hour N+1 dark on weekday N
    return states


# --- 1. a handmade day, to pin the arithmetic ------------------------------
# Hours are 1-based and hour N covers wall-clock N-1:00 to N:00, so hour 9 is
# 08:00-09:00. Everything below is stated in wall-clock to keep that honest.
print("\n1. handmade day: dark 08:00-10:00, then 14:30-15:00")
states = ["yes"] * 24
states[8] = "no"        # hour 9  -> 08:00-09:00 dark
states[9] = "no"        # hour 10 -> 09:00-10:00 dark
states[14] = "second"   # hour 15 -> 14:30-15:00 dark
today = date(2026, 6, 10)
fact = fact_from({today: {"GPV3.2": day(states)},
                  today + timedelta(days=1): {"GPV3.2": day(["yes"] * 24)}})
preset = {"sch_names": {"GPV3.2": "Черга 3.2"}}

r = p.resolve(entry(["GPV3.2"]), {}, fact, preset,
              datetime(2026, 6, 10, 7, 15, tzinfo=KYIV))
check("schedule_in_effect", r["schedule_in_effect"], True)
check("today string", r["today"], "yyyyyyyynnyyyysyyyyyyyyy")
check("tomorrow string", r["tomorrow"], "y" * 24)
check("queue_label", r["queue_label"], "Черга 3.2")
check("now_state at 07:15", r["now_state"], "yes")
check("next_outage_start", r["next_outage_start"], "2026-06-10T08:00:00+03:00")
# While the power is on, the pair brackets the coming outage: 08:00-10:00.
check("next_outage_end brackets it", r["next_outage_end"],
      "2026-06-10T10:00:00+03:00")

# Mid-outage: the next dark slot is the one you are sitting in, so an edge
# detector is the only thing that gives a useful answer here.
r = p.resolve(entry(["GPV3.2"]), {}, fact, preset,
              datetime(2026, 6, 10, 8, 40, tzinfo=KYIV))
check("now_state at 08:40", r["now_state"], "no")
check("power back at", r["next_outage_end"], "2026-06-10T10:00:00+03:00")
check("next outage after that", r["next_outage_start"],
      "2026-06-10T14:30:00+03:00")

# The half-hour states are the reason slots are 30 minutes and not 60.
r = p.resolve(entry(["GPV3.2"]), {}, fact, preset,
              datetime(2026, 6, 10, 14, 10, tzinfo=KYIV))
check("second-half state darkens at :30", r["next_outage_start"],
      "2026-06-10T14:30:00+03:00")
check("and lifts on the hour", r["next_outage_end"], "2026-06-10T15:00:00+03:00")

# --- 2. a house fed by two lines -------------------------------------------
print("\n2. two queues: the merge must never promise power")
a = ["yes"] * 24
b = ["yes"] * 24
a[8] = "no"          # line A dark 08:00-09:00
b[9] = "maybe"       # line B might be dark 09:00-10:00
b[14] = "first"      # line B dark 14:00-14:30
fact2 = fact_from({today: {"GPV3.1": day(a), "GPV3.2": day(b)}})
r = p.resolve(entry(["GPV3.1", "GPV3.2"]), {}, fact2, preset,
              datetime(2026, 6, 10, 0, 5, tzinfo=KYIV))
check("multi_line", r["multi_line"], True)
check("queue is not guessed", r["queue"], None)
check("union of both lines", r["today"], "yyyyyyyynmyyyyfyyyyyyyyy")
check("first dark edge", r["next_outage_start"], "2026-06-10T08:00:00+03:00")
check("severity: maybe beats first", p.merge_states(["first", "maybe"]), "maybe")
check("severity: no beats everything", p.merge_states(["maybe", "no"]), "no")
check("severity: yes loses to all", p.merge_states(["yes", "msecond"]), "msecond")
check("unknown states ignored", p.merge_states([None, "yes"]), "yes")
check("nothing known -> None", p.merge_states([None, ""]), None)

# --- 3. schedules not in force (today's live behaviour) --------------------
print("\n3. fact.data empty -- the normal state of the world since 24.07.2026")
r = p.resolve(entry(["GPV3.2"]), {}, {"data": [], "update": "24.07.2026 08:30"},
              preset, datetime(2026, 6, 10, 12, 0, tzinfo=KYIV))
check("schedule_in_effect", r["schedule_in_effect"], False)
for key in ("now_state", "today", "tomorrow", "next_outage_start",
            "next_outage_end"):
    check("%s is null, not invented" % key, r[key], None)
check("queue still known", r["queue"], "3.2")
check("update stamp still surfaced", r["schedule_update"], "24.07.2026 08:30")

# THE one that matters. `week` is built from preset, not fact, so it has to
# survive the early return that nulls everything else. Get this wrong and the
# dashboard ships with its main table permanently blank -- while every test
# that assumes schedules are running still passes.
pw = weekly({"GPV3.2": [marked(i) for i in range(7)]})
r = p.resolve(entry(["GPV3.2"]), {}, {"data": [], "update": "24.07.2026 08:30"},
              pw, datetime(2026, 6, 10, 12, 0, tzinfo=KYIV))
check("schedule_in_effect still false", r["schedule_in_effect"], False)
check("but week IS populated", r["week"] is not None, True)
check("seven days", len(r["week"]), 7)
check("Monday row", r["week"][0], "n" + "y" * 23)
check("Sunday row", r["week"][6], "y" * 6 + "n" + "y" * 17)

# --- 4. an outage record ---------------------------------------------------
print("\n4. current outage record")
e = entry(["GPV3.2"])
e.update(type="2", sub_type="Аварійні відключення",
         start_date="10.06.2026 08:14", end_date="10.06.2026 12:00")
r = p.resolve(e, {}, fact, preset, datetime(2026, 6, 10, 9, 0, tzinfo=KYIV))
check("outage_active", r["outage_active"], True)
check("start parsed to ISO", r["outage_start"], "2026-06-10T08:14:00+03:00")
check("end parsed to ISO", r["outage_end"], "2026-06-10T12:00:00+03:00")
check("status", p.status_for(r), "outage_emergency")
e["type"] = "1"
check("planned repairs", p.status_for(p.resolve(e, {}, fact, preset,
      datetime(2026, 6, 10, 9, 0, tzinfo=KYIV))), "outage_planned")
check("time-first, as DTEK really sends it",
      p.parse_dtek_datetime("11:05 29.09.2026"), "2026-09-29T11:05:00+03:00")
check("unparseable date -> None", p.parse_dtek_datetime("garbage"), None)
check("empty date -> None", p.parse_dtek_datetime(""), None)

# --- 5. DST ----------------------------------------------------------------
# Ukraine moves the clock on the last Sunday of March and October. Building the
# slots by adding timedeltas to midnight would silently shift the whole day by
# an hour on exactly two days a year; combine() on wall-clock does not.
print("\n5. DST boundaries (29 Mar and 25 Oct 2026)")
for d, label in ((date(2026, 3, 29), "spring forward"),
                 (date(2026, 10, 25), "fall back")):
    slots = p.half_hour_slots(d, ["yes"] * 24)
    offsets = sorted({s[0].strftime("%z") for s in slots})
    hours = [s[0].strftime("%H:%M") for s in slots[::2]]
    check("%s: 48 slots" % label, len(slots), 48)
    check("%s: wall clock intact" % label, hours[:3] + hours[-1:],
          ["00:00", "01:00", "02:00", "23:00"])
    check("%s: offset changes mid-day" % label, len(offsets), 2)

# --- 6. round trip through the encoder -------------------------------------
print("\n6. every state DTEK can send survives encoding")
all_states = ["yes", "no", "maybe", "first", "second", "mfirst", "msecond"]
check("letters are distinct", len(set(p.STATE_LETTER.values())), 7)
check("all seven encode", p.encode_day(all_states + ["yes"] * 17),
      "ynmfsFS" + "y" * 17)
check("unknown state -> ?", p.encode_day(["wat"] + ["yes"] * 23), "?" + "y" * 23)
check("every state has halves", sorted(p.OFF_HALVES), sorted(all_states))
check("every state has severity", sorted(p.SEVERITY), sorted(all_states))

# --- 7. the recurring weekly table -----------------------------------------
print()
print("7. week: shape, weekday order, merge, and the absent-queue cases")
NOW = datetime(2026, 6, 10, 12, 0, tzinfo=KYIV)
pw = weekly({"GPV3.2": [marked(i) for i in range(7)]})
r = p.resolve(entry(["GPV3.2"]), {}, fact, pw, NOW)
check("all rows 24 chars", sorted({len(d) for d in r["week"]}), [24])
check("only known letters", set("".join(r["week"])) <= set("ynmfsFS"), True)
check("Monday first, in order", [d.index("n") for d in r["week"]], list(range(7)))

# Two lines merge pessimistically here too, exactly as the applied table does.
a = [["yes"] * 24 for _ in range(7)]
b = [["yes"] * 24 for _ in range(7)]
a[0][3] = "no"
b[0][5] = "maybe"
r = p.resolve(entry(["GPV3.1", "GPV3.2"]), {}, fact,
              weekly({"GPV3.1": a, "GPV3.2": b}), NOW)
check("union across both lines", r["week"][0], "yyynymyyyyyyyyyyyyyyyyyy")

check("no preset at all -> None",
      p.resolve(entry(["GPV3.2"]), {}, fact, {}, NOW)["week"], None)
check("queue absent from the table -> None",
      p.resolve(entry(["GPV9.9"]), {}, fact, pw, NOW)["week"], None)
check("house has no queue -> None",
      p.resolve(entry([]), {}, fact, pw, NOW)["week"], None)

# --- 8. the real weekly table, reshaped ------------------------------------
print("\n8. the real preset table, reshaped into fact")
cache = Path(__file__).resolve().parents[1] / "config" / "dtek" / ".cache.json"
raw = json.loads(cache.read_text(encoding="utf-8")) if cache.exists() else {}
real = (raw.get("preset") or {}).get("data") or {}
if not real:
    print("  skip  no cached preset -- run dtek_poll.py once first")
else:
    queue = sorted(real)[0]
    d0 = date(2026, 6, 10)                       # a Wednesday -> weekday key 3
    fact3 = fact_from({d0: {queue: real[queue]["3"]},
                       d0 + timedelta(days=1): {queue: real[queue]["4"]}})
    r = p.resolve(entry([queue]), {}, fact3, raw["preset"],
                  datetime(2026, 6, 10, 0, 30, tzinfo=KYIV))
    check("%s today is 24 chars" % queue, len(r["today"]), 24)
    check("no unknown letters", set(r["today"]) <= set("ynmfsFS"), True)
    check("tomorrow is 24 chars", len(r["tomorrow"]), 24)
    check("label resolved", bool(r["queue_label"]), True)
    print("       %s  %s / %s" % (queue, r["today"], r["tomorrow"]))
# --- 9. visibility: whether DTEK is drawing any of this itself -------------
#
# Unlike everything above, this IS testable against production: the flags are
# live and showTablePlan has been false throughout. The case that matters most
# is the one that cannot be observed -- flags absent -- because that is what a
# renamed field looks like, and it must leave the grid alone rather than blank
# it. Every other row here is a failure mode; that row guards the fix itself.
print("\n9. visibility flags")

SHOWN = {"showCurOutageParam": True, "showCurSchedule": True,
         "showTableSchedule": True, "showTablePlan": True,
         "showTableFact": True, "showUserGroup": True}
PRESET = weekly({"GPV3.2": [marked(d) for d in range(7)]})
PRESET["time_zone"] = {str(h): "%02d:00" % (h - 1) for h in range(1, 25)}
# fact.data has been [] since 24.07.2026, so this is production's own shape.
FACT = {"data": [], "update": "24.07.2026 08:30"}


def flags(**over):
    out = dict(SHOWN)
    out.update(over)
    return out


def vis(answer=None, preset=None, queues=("GPV3.2",), **over):
    e = entry(list(queues))
    e.update(over)
    _, week_ok, sched_ok, why = p.visibility(
        SHOWN if answer is None else answer, FACT,
        PRESET if preset is None else preset, list(queues), e)
    return week_ok, sched_ok, why


check("everything on -> shown", vis(), (True, True, None))
check("showTablePlan false -> hidden", vis(flags(showTablePlan=False)),
      (False, True, "plan_off"))
check("showTableSchedule false -> hidden", vis(flags(showTableSchedule=False)),
      (False, True, "table_off"))
# The row that guards the fix: DTEK renames a field, we keep drawing.
check("no flags reported at all -> shown", vis({}), (True, True, None))
check("only showTablePlan reported, false -> hidden",
      vis({"showTablePlan": False}), (False, True, "plan_off"))
# Both empty, so the init() override at discon-schedule.js:48-53 fires and
# takes the day tables down with the grid.
check("empty preset.data -> hidden", vis(preset={"time_zone": {"1": "x"}}),
      (False, False, "empty_preset"))
check("empty preset.time_zone -> hidden, day tables off too",
      vis(preset={"data": PRESET["data"], "sch_names": PRESET["sch_names"],
                  "time_zone": {}}),
      (False, False, "table_off"))
check("house has no queue -> hidden", vis(queues=()), (False, False, "no_queue"))
check("queue not in sch_names -> hidden", vis(queues=("GPV9.9",)),
      (False, True, "unknown_queue"))
check("cek address -> hidden", vis(cek=True), (False, False, "cek"))
check("voluntarily, during an outage -> hidden",
      vis(voluntarily=True, sub_type="Аварійне"), (False, False, "voluntarily"))
check("voluntarily, nothing recorded -> shown", vis(voluntarily=True),
      (True, True, None))
check("emergency without a schedule -> hidden",
      vis(sub_type=p.EMERGENCY_SUB_TYPE), (False, False, "emergency_no_schedule"))
check("a different emergency reason -> shown",
      vis(sub_type="Аварійне відключення"), (True, True, None))
check("showTableFact false -> day tables off, grid still on",
      vis(flags(showTableFact=False)), (True, False, None))

# ...and resolve() must carry all of it into the payload the sensor publishes.
r = p.resolve(entry(["GPV3.2"]),
              flags(showTablePlan=False, updateTimestamp="15:02 03.09.2026"),
              FACT, PRESET, NOW)
check("payload week_in_effect", r["week_in_effect"], False)
check("payload schedule_visible", r["schedule_visible"], True)
check("payload hidden_reason", r["hidden_reason"], "plan_off")
check("payload updated_at", r["updated_at"], "15:02 03.09.2026")
check("payload keeps `week` regardless", len(r["week"] or []), 7)
check("payload flags are the six", sorted(r["dtek_flags"]), sorted(p.FLAG_KEYS))

# --- 10. golden: the emergency outage of 29.09.2026 ------------------------
# Verbatim production answers, captured while DTEK's site showed an emergency
# repair (reason "Аварійні ремонтні роботи"), 11:05 -> by 15:25. The poller published that outage with
# start and end both null, because DTEK writes the time before the date. Every
# assertion below is what the site itself displayed at the time.
print("\n10. golden: emergency outage, 29.09.2026")
GOLDEN = json.loads((Path(__file__).resolve().parent / "fixtures"
                     / "dtek_emergency_20260929.json").read_text(encoding="utf-8"))
ans = GOLDEN["getHomeNum"]
ent = p.house_entry(ans["data"], GOLDEN["_meta"]["house"])
r = p.resolve(ent, ans, GOLDEN["fact"], GOLDEN["preset"],
              datetime(2026, 9, 29, 14, 17, tzinfo=KYIV))
check("house found in the street's answer", ent is not None, True)
check("outage_active", r["outage_active"], True)
check("outage_reason", r["outage_reason"], "Аварійні ремонтні роботи")
check("outage_start", r["outage_start"], "2026-09-29T11:05:00+03:00")
check("outage_end", r["outage_end"], "2026-09-29T15:25:00+03:00")
check("status", p.status_for(r), "outage_emergency")
check("updated_at verbatim", r["updated_at"], "14:17 29.09.2026")
check("queue", r["queue"], "1.1")
check("weekly table withheld", (r["week_in_effect"], r["hidden_reason"]),
      (False, "plan_off"))
check("no stabilisation schedule", r["schedule_in_effect"], False)
check("raw start kept verbatim", r["outage_start_raw"], "11:05 29.09.2026")
check("nothing unreadable in the golden answer", r["warnings"], [])
check("scope: only this building of 288", (r["street_outages"], r["street_houses"]),
      (1, 288))
check("the neighbours have no outage",
      p.resolve(p.house_entry(ans["data"], "house-001"), ans, GOLDEN["fact"],
                GOLDEN["preset"], datetime(2026, 9, 29, 14, 17,
                                           tzinfo=KYIV))["outage_active"], False)

# --- 11. drift: a format DTEK changes must be flagged, not nulled -----------
# The golden answer with the dates rewritten into a third shape, a new outage
# type, and a field nobody has seen. Every one of these is exactly how the
# 29.09.2026 times went missing: parsed to None and published as if normal.
print("\n11. drift warnings")
drift = copy.deepcopy(ans)
de = drift["data"]["1"]
de.update(start_date="2026-09-29T11:05", type="3", new_thing="x")
drift["showSomethingNew"] = True
r = p.resolve(de, drift, GOLDEN["fact"], GOLDEN["preset"],
              datetime(2026, 9, 29, 14, 17, tzinfo=KYIV))
check("unreadable start -> null, raw still there",
      (r["outage_start"], r["outage_start_raw"]), (None, "2026-09-29T11:05"))
check("the end still parses", r["outage_end"], "2026-09-29T15:25:00+03:00")
check("four warnings", len(r["warnings"]), 4)
check("they name the problem", [w.split()[0] for w in r["warnings"]],
      ["unreadable", "unknown", "new", "new"])
check("the outage itself still reads as active", r["outage_active"], True)
check("no street data -> scope unknown", p.street_scope({}), (None, None))

# --- 12. captures ----------------------------------------------------------
print("\n12. automatic captures")
with tempfile.TemporaryDirectory() as tmp:
    p.CAPTURE_DIR = Path(tmp) / "captures"

    class _Session:
        fact, preset = GOLDEN["fact"], GOLDEN["preset"]

    payload = dict(r, status="outage_emergency")
    for i in range(p.CAPTURE_KEEP + 3):
        payload["fetched_at"] = "2026-09-29T14:%02d:00+03:00" % i
        p.save_capture(ans, payload, _Session, "1")
    files = sorted(p.CAPTURE_DIR.glob("*.json"))
    check("keeps the last %d" % p.CAPTURE_KEEP, len(files), p.CAPTURE_KEEP)
    got = json.loads(files[-1].read_text(encoding="utf-8"))
    check("fixture-shaped", sorted(got), ["_meta", "fact", "getHomeNum", "preset"])
    check("replays like the fixture",
          p.resolve(p.house_entry(got["getHomeNum"]["data"], got["_meta"]["house"]),
                    got["getHomeNum"], got["fact"], got["preset"],
                    datetime(2026, 9, 29, 14, 17, tzinfo=KYIV))["outage_end"],
          "2026-09-29T15:25:00+03:00")
    check("named by time and status", files[-1].name,
          "20260929T143200_outage_emergency.json")
    check("no session secrets inside",
          any(k in files[-1].read_text(encoding="utf-8").lower()
              for k in ("csrf", "cookie")), False)


print("\n%s" % ("FAILED: " + ", ".join(FAILED) if FAILED else "all checks passed"))
sys.exit(1 if FAILED else 0)
