"""Render the Jinja in packages/dtek_shutdowns.yaml against fake states.

    python HomeAssistant/tools/check_dtek_templates.py

`ha core check` parses YAML. It does not render templates, so a template that
is syntactically fine and logically inverted deploys cleanly and then quietly
reports the opposite of the truth until somebody notices. Two things in that
package are exactly that shape:

  * binary_sensor.grid_outage_unscheduled reads a sensor called "Grid Condition
    Safe" whose `on` means UNSAFE. Getting that backwards produces an entity
    that is true whenever everything is fine, which looks plausible on a
    dashboard for a long time.
  * binary_sensor.dtek_scheduled_dark has to pick the right half of the hour
    out of DTEK's first/second/mfirst/msecond states. Off-by-one there is
    thirty minutes of blackout invented or missed, twice per window.

Same approach as IRBridge/tools/check_ha_templates.py, which does this for the
A/C energy package: reimplement just enough of Home Assistant's template
environment to prove the templates parse, produce one clean token, and branch
the way the comments in the package claim they do. It is not an HA emulator.
"""
import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import jinja2
import yaml

# Sections 7 and 8 check the package and the card against the poller -- the
# state alphabet, and the set of keys resolve() actually emits -- so they need
# the real module rather than a third copy of its constants.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "config" / "dtek"))
import dtek_poll                                                # noqa: E402
from dtek_poll import HIDDEN_REASONS, STATE_LETTER              # noqa: E402

KYIV = ZoneInfo("Europe/Kyiv")
PKG = (Path(__file__).resolve().parents[1] / "config" / "packages"
       / "dtek_shutdowns.yaml")
SENSOR = "sensor.dtek_shutdowns"
FAILED = []


class HaLoader(yaml.SafeLoader):
    """SafeLoader that shrugs at !secret / !include instead of dying."""


HaLoader.add_multi_constructor("!", lambda loader, suffix, node: None)


def make_env(states, attrs, now):
    env = jinja2.Environment(undefined=jinja2.StrictUndefined)

    def _states(eid):
        # HA hands back the string 'unknown' for an entity it has never seen,
        # never a Python None, and several templates lean on that.
        return str(states.get(eid, "unknown"))

    def _is_state(eid, value):
        return _states(eid) == value

    def _as_datetime(value):
        try:
            return datetime.fromisoformat(str(value))
        except (TypeError, ValueError):
            return None

    def _bool(value, default=False):
        if isinstance(value, bool):
            return value
        if value is None:
            return default
        return str(value).strip().lower() in ("true", "on", "yes", "1")

    def is_number(value):
        try:
            float(value)
        except (TypeError, ValueError):
            return False
        return True

    env.globals.update(states=_states, is_state=_is_state,
                       state_attr=lambda e, a: attrs.get((e, a)),
                       now=lambda: now, as_datetime=_as_datetime,
                       timedelta=timedelta, is_number=is_number)
    env.filters["bool"] = _bool
    env.filters["is_number"] = is_number
    env.filters["as_datetime"] = _as_datetime
    env.filters["as_local"] = lambda d: d.astimezone(KYIV)
    env.filters["as_timestamp"] = lambda d: d.timestamp()
    env.filters["timestamp_custom"] = (
        lambda ts, fmt, local=True: datetime.fromtimestamp(ts, KYIV).strftime(fmt))
    env.filters["round"] = lambda v, n=0: round(float(v), n)
    env.tests["number"] = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)
    return env


def templates_in(node, path=()):
    """Every (key-path, template string) pair under a mapping."""
    if isinstance(node, dict):
        for key, value in node.items():
            yield from templates_in(value, path + (str(key),))
    elif isinstance(node, list):
        for i, value in enumerate(node):
            yield from templates_in(value, path + (str(i),))
    elif isinstance(node, str) and ("{{" in node or "{%" in node):
        yield path, node


def entities(pkg):
    """name -> {template key: template string} for the template: entities."""
    out = {}
    for block in pkg.get("template", []):
        for _kind, items in block.items():
            for item in items:
                out[item["name"]] = item
    return out


def render(tpl, states, attrs, now):
    return make_env(states, attrs, now).from_string(tpl).render().strip()


def check(label, got, want):
    ok = got == want
    if not ok:
        FAILED.append(label)
    print("  %-4s %-52s %r%s" % ("ok" if ok else "FAIL", label, got,
                                 "" if ok else "  want %r" % (want,)))


def base_attrs(**over):
    """The attribute payload the command_line sensor publishes, with overrides."""
    data = {"queue": "3.2", "queue_code": "GPV3.2", "queue_label": "Черга 3.2",
            "queues": ["GPV3.2"], "multi_line": False, "cek": False,
            "voluntarily": False, "outage_active": False, "outage_type": None,
            "outage_reason": None, "outage_start": None, "outage_end": None,
            "schedule_in_effect": True, "schedule_update": "01.09.2026 08:30",
            "now_state": "yes", "today": "y" * 24, "tomorrow": "y" * 24,
            "next_outage_start": None, "next_outage_end": None, "week": None,
            "week_in_effect": True, "schedule_visible": True,
            "hidden_reason": None, "updated_at": "12:00 01.09.2026",
            "dtek_flags": {k: True for k in dtek_poll.FLAG_KEYS},
            "fetched_at": "2026-09-01T12:00:00+03:00", "stale": False,
            "error": None}
    data.update(over)
    return {(SENSOR, k): v for k, v in data.items()}


pkg = yaml.load(PKG.read_text(encoding="utf-8"), HaLoader)
ents = entities(pkg)
NOON = datetime(2026, 9, 1, 12, 0, tzinfo=KYIV)

# --- 1. everything parses --------------------------------------------------
print("\n1. parse")
total = 0
for path, tpl in templates_in(pkg):
    total += 1
    try:
        jinja2.Environment().parse(tpl)
    except jinja2.TemplateSyntaxError as exc:
        print("   SYNTAX ERROR at %s: %s" % (".".join(path), exc))
        sys.exit(1)
print("  ok   %d templates parse" % total)

# --- 2. the half-hour logic ------------------------------------------------
# Hour states map onto two half hours. `maybe` is dark on purpose: it is DTEK
# hedging, not DTEK saying no.
print("\n2. DTEK scheduled dark: state x minute")
dark = ents["DTEK scheduled dark"]["state"]
for state, at_10, at_40 in [
        ("yes", "False", "False"),
        ("no", "True", "True"),
        ("maybe", "True", "True"),
        ("first", "True", "False"),
        ("mfirst", "True", "False"),
        ("second", "False", "True"),
        ("msecond", "False", "True")]:
    for minute, want in ((10, at_10), (40, at_40)):
        got = render(dark, {}, base_attrs(now_state=state),
                     NOON.replace(minute=minute))
        check("%-8s at :%02d" % (state, minute), got, want)

check("certain for 'no'",
      render(ents["DTEK scheduled dark"]["attributes"]["certain"], {},
             base_attrs(now_state="no"), NOON), "True")
check("not certain for 'maybe'",
      render(ents["DTEK scheduled dark"]["attributes"]["certain"], {},
             base_attrs(now_state="maybe"), NOON), "False")
check("unavailable when no schedule",
      render(ents["DTEK scheduled dark"]["availability"], {},
             base_attrs(schedule_in_effect=False), NOON), "False")

# --- 3. the polarity trap --------------------------------------------------
# binary_sensor.powmr_inverter_grid_condition_safe is `on` for UNSAFE.
print("\n3. Grid outage unscheduled: on == UNSAFE, not safe")
unsched = ents["Grid outage unscheduled"]["state"]
GRID = "binary_sensor.powmr_inverter_grid_condition_safe"
for label, grid, sched_dark, dtek_out, want in [
        ("grid up, nothing scheduled", "off", "off", "off", "False"),
        ("grid DOWN, nothing scheduled", "on", "off", "off", "True"),
        ("grid DOWN, on the schedule", "on", "on", "off", "False"),
        ("grid DOWN, DTEK owns it", "on", "off", "on", "False"),
        ("grid up during a scheduled window", "off", "on", "off", "False"),
        ("grid DOWN, dark sensor unavailable", "on", "unavailable", "off", "True")]:
    got = render(unsched, {GRID: grid,
                           "binary_sensor.dtek_scheduled_dark": sched_dark,
                           "binary_sensor.dtek_outage_now": dtek_out},
                 base_attrs(), NOON)
    check(label, got, want)

# --- 4. queue, staleness, nulls -------------------------------------------
print("\n4. queue / staleness / nulls")
q = ents["DTEK queue"]["state"]
check("single queue", render(q, {}, base_attrs(), NOON), "3.2")
check("two lines joined",
      render(q, {}, base_attrs(queues=["GPV3.1", "GPV3.2"], multi_line=True), NOON),
      "3.1 / 3.2")
# HA turns a rendered "None" back into None, which becomes state `unknown`.
check("no queue -> None", render(q, {}, base_attrs(queues=None), NOON), "None")

stale = ents["DTEK data stale"]["state"]
check("fresh", render(stale, {SENSOR: "ok"}, base_attrs(), NOON), "False")
check("script reported stale",
      render(stale, {SENSOR: "stale"}, base_attrs(stale=True), NOON), "True")
check("sensor never seen",
      render(stale, {}, base_attrs(stale=None), NOON), "True")

nxt = ents["DTEK next outage start"]["state"]
check("no upcoming outage -> None", render(nxt, {}, base_attrs(), NOON), "None")
check("upcoming outage passes through",
      render(nxt, {}, base_attrs(next_outage_start="2026-09-01T14:00:00+03:00"), NOON),
      "2026-09-01T14:00:00+03:00")

reason = ents["DTEK outage reason"]["state"]
check("long reason truncated to fit a state",
      len(render(reason, {}, base_attrs(outage_reason="x" * 400), NOON)), 250)

# --- 5. the alert ----------------------------------------------------------
print("\n5. '15 min' automation")
auto = {a["id"]: a for a in pkg["automation"]}["dtek_outage_starting_soon"]
trigger = auto["trigger"][0]["value_template"]
for label, value, want in [
        ("no outage scheduled", "unknown", "False"),
        ("sensor unavailable", "unavailable", "False"),
        ("literal none", "none", "False"),
        ("40 min away", "2026-09-01T12:40:00+03:00", "False"),
        ("10 min away", "2026-09-01T12:10:00+03:00", "True"),
        ("exactly 15 min", "2026-09-01T12:15:00+03:00", "True"),
        ("already started", "2026-09-01T11:50:00+03:00", "False")]:
    got = render(trigger, {"sensor.dtek_next_outage_start": value},
                 base_attrs(), NOON)
    check(label, got, want)

# The variables render in order and the last one reads the earlier two, exactly
# as HA evaluates an action-level `variables:` block.
states = {"sensor.dtek_next_outage_start": "2026-09-01T14:00:00+03:00",
          "sensor.dtek_next_outage_end": "2026-09-01T17:30:00+03:00",
          "sensor.dtek_queue": "3.2",
          "sensor.battery_runtime_remaining": "9.4",
          "sensor.jkbms_gateway_bms_state_of_charge": "87"}
env = make_env(states, base_attrs(), NOON)
rendered = {}
for name, tpl in auto["action"][0]["variables"].items():
    rendered[name] = env.from_string(tpl).render(**rendered).strip()
check("window", rendered["window_line"], "14:00 to 17:30 (3.5 h)")
# round(0) renders a float in HA, so "87.0%" is what the existing
# grid-outage alert prints too. Copied deliberately, not a bug.
check("message", rendered["message"],
      "DTEK queue 3.2 is scheduled off 14:00 to 17:30 (3.5 h). "
      "Battery 87.0%, about 9.4 h left at the current draw.")

# No end published: say what is known rather than rendering a broken range.
env = make_env(dict(states, **{"sensor.dtek_next_outage_end": "unknown"}),
               base_attrs(), NOON)
rendered = {}
for name, tpl in auto["action"][0]["variables"].items():
    rendered[name] = env.from_string(tpl).render(**rendered).strip()
check("open-ended window", rendered["window_line"], "starting 14:00")

# Battery unknown: the sentence still has to end cleanly.
env = make_env(dict(states, **{"sensor.battery_runtime_remaining": "unknown",
                               "sensor.jkbms_gateway_bms_state_of_charge": "87"}),
               base_attrs(), NOON)
rendered = {}
for name, tpl in auto["action"][0]["variables"].items():
    rendered[name] = env.from_string(tpl).render(**rendered).strip()
check("degraded battery line", rendered["battery_line"], "Battery 87.0%.")

# --- 5b. the other end of the window ---------------------------------------
# next_outage_end needs a guard next_outage_start does not: the two sensors
# bracket ONE window and swap roles across its start, so before a window opens
# `end` is that window's end and counting down to it would announce power
# coming back that never went away. `end < start` is what says we are inside a
# window -- the rows below are the whole point of this subsection.
print("\n5b. 'ends in 15 min' automation")
ends = {a["id"]: a for a in pkg["automation"]}["dtek_outage_ending_soon"]
etrig = ends["trigger"][0]["value_template"]
OPEN = "2026-09-01T19:30:00+03:00"        # a window that has not started
for label, end, start, want in [
        ("no schedule at all", "unknown", "unknown", "False"),
        ("end unavailable", "unavailable", OPEN, "False"),
        ("inside a window, 10 min to go", "2026-09-01T12:10:00+03:00", OPEN, "True"),
        ("inside a window, exactly 15", "2026-09-01T12:15:00+03:00", OPEN, "True"),
        ("inside a window, 40 min to go", "2026-09-01T12:40:00+03:00", OPEN, "False"),
        ("just ended", "2026-09-01T11:50:00+03:00", OPEN, "False"),
        # The one that a bare countdown gets wrong: power is ON, the window is
        # hours away, and its END happens to fall inside the next 15 minutes.
        ("window not started, end 10 min away",
         "2026-09-01T12:10:00+03:00", "2026-09-01T12:05:00+03:00", "False"),
        # Last window of the schedule: no next start to compare against.
        ("no further window published",
         "2026-09-01T12:10:00+03:00", "unknown", "True")]:
    got = render(etrig, {"sensor.dtek_next_outage_end": end,
                         "sensor.dtek_next_outage_start": start},
                 base_attrs(), NOON)
    check(label, got, want)

estates = {"sensor.dtek_next_outage_end": "2026-09-01T12:15:00+03:00",
           "sensor.dtek_next_outage_start": "2026-09-01T19:30:00+03:00",
           "sensor.dtek_queue": "3.2",
           "sensor.battery_runtime_remaining": "9.4",
           "sensor.jkbms_gateway_bms_state_of_charge": "87"}
env = make_env(estates, base_attrs(), NOON)
rendered = {}
for name, tpl in ends["action"][0]["variables"].items():
    rendered[name] = env.from_string(tpl).render(**rendered).strip()
check("message", rendered["message"],
      "DTEK queue 3.2 is scheduled back on at 12:15. Next window at 19:30. "
      "Battery 87.0%, about 9.4 h left at the current draw.")

# No next window: the sentence must not grow a stray "None" or a double space.
env = make_env(dict(estates, **{"sensor.dtek_next_outage_start": "unknown"}),
               base_attrs(), NOON)
rendered = {}
for name, tpl in ends["action"][0]["variables"].items():
    rendered[name] = env.from_string(tpl).render(**rendered).strip()
check("last window of the day", rendered["message"],
      "DTEK queue 3.2 is scheduled back on at 12:15. "
      "Battery 87.0%, about 9.4 h left at the current draw.")

# --- 5c. the channels ------------------------------------------------------
# Android fixes a channel's importance the first time a notification carrying
# that name reaches the phone, so a typo here is not a cosmetic bug: it creates
# a second channel at default importance that nobody has silenced, and the real
# one stops being used. Both alerts must also go to notify.household, the group
# (packages/household_notify.yaml, git-ignored) that reaches every phone.
print("\n5c. notification channels")
PHONES = {"notify.household"}
for aid, want_channel in [("dtek_outage_starting_soon", "DTEK emergency starts"),
                          ("dtek_outage_ending_soon", "DTEK emergency ends"),
                          ("dtek_outage_reported", "DTEK emergency starts"),
                          ("dtek_outage_cleared", "DTEK emergency ends"),
                          ("dtek_outage_overdue", "DTEK emergency starts")]:
    a = {x["id"]: x for x in pkg["automation"]}[aid]
    sends = [x for x in a["action"] if x.get("service", "").startswith("notify.")]
    push = [x for x in sends if x["service"] in PHONES]
    check("%s reaches the household group" % aid,
          sorted(x["service"] for x in push), sorted(PHONES))
    check("%s uses one channel" % aid,
          sorted({x["data"]["data"]["channel"] for x in push}), [want_channel])
    check("%s is high priority with no ttl" % aid,
          all(x["data"]["data"].get("priority") == "high"
              and x["data"]["data"].get("ttl") == 0 for x in push), True)
    check("%s also lands in HA itself" % aid,
          any(x["service"] == "notify.persistent_notification" for x in sends), True)
# Distinct channels, or silencing one silences the other.
allch = {x["data"]["data"]["channel"]
         for a in pkg["automation"] for x in a["action"]
         if x.get("service") in PHONES}
check("the two channels are distinct", len(allch), 2)
check("neither reuses the shared Emergency channel",
      sorted(allch & {"Emergency", "Emergency resolved"}), [])

# --- 5d. DTEK's own outage record ------------------------------------------
# Rendered against the attributes the poller published for the 29.09.2026
# emergency (tools/fixtures/dtek_emergency_20260929.json), start and end
# included -- they were null on the day, which is the bug this pair came with.
print("\n5d. 'DTEK reports an outage' automation")
autos = {a["id"]: a for a in pkg["automation"]}
rep = autos["dtek_outage_reported"]
GOLD = base_attrs(queue="1.1", outage_active=True, outage_type="2",
                  outage_reason="Аварійні ремонтні роботи",
                  outage_start="2026-09-29T11:05:00+03:00",
                  outage_end="2026-09-29T15:25:00+03:00")
AT = datetime(2026, 9, 29, 14, 17, tzinfo=KYIV)
rstates = {"sensor.dtek_queue": "1.1", GRID: "off",
           "sensor.battery_runtime_remaining": "9.4",
           "sensor.jkbms_gateway_bms_state_of_charge": "87"}


def fire(auto, states, attrs, trig):
    env = make_env(states, attrs, AT)
    out = {}
    for name, tpl in auto["action"][0]["variables"].items():
        out[name] = env.from_string(tpl).render(trigger=trig, **out).strip()
    return out


def gate(auto, trig):
    tpl = [c for c in auto["condition"] if c["condition"] == "template"][0]
    return make_env({}, GOLD, AT).from_string(
        tpl["value_template"]).render(trigger=trig).strip()


def st(state, **attrs):
    return {"state": state, "attributes": attrs}


def status(frm, to):
    return {"id": "status", "from_state": frm, "to_state": to}


EMERG = st("outage_emergency", outage_active=True, outage_type="2",
           outage_end="2026-09-29T15:25:00+03:00")
PLANNED = st("outage_planned", outage_active=True, outage_type="1")
OK = st("ok", outage_active=False, outage_type=None)
STARTED = status(OK, EMERG)

out = fire(rep, rstates, GOLD, STARTED)
check("title names the kind", out["title"], "⚠️ Alert: DTEK emergency outage")
check("message, mains present", out["message"],
      "Аварійні ремонтні роботи, queue 1.1: off since 11:05, expected back by "
      "15:25. The inverter still sees mains. "
      "Battery 87.0%, about 9.4 h left at the current draw.")
out = fire(rep, dict(rstates, **{GRID: "on"}), GOLD, STARTED)
check("grid line follows the UNSAFE polarity", out["grid_line"],
      "The inverter sees no mains.")
out = fire(rep, rstates, {**GOLD, (SENSOR, "outage_end"): None,
                          (SENSOR, "outage_start"): None}, STARTED)
check("no times published: no dangling colon", out["message"],
      "Аварійні ремонтні роботи, queue 1.1. The inverter still sees mains. "
      "Battery 87.0%, about 9.4 h left at the current draw.")
check("planned title", fire(rep, rstates, GOLD, status(OK, PLANNED))["title"],
      "⚠️ Alert: DTEK planned outage")

# Which status changes are a message. The stale rows are the reason the
# template rebuilds the previous status from attributes instead of reading it.
STALE_OUT = st("stale", outage_active=True, outage_type="2")
STALE_OK = st("stale", outage_active=False, outage_type=None)
for label, trig, want in [
        ("ok -> emergency", status(OK, EMERG), "True"),
        ("ok -> planned", status(OK, PLANNED), "True"),
        ("planned -> emergency (reclassified)", status(PLANNED, EMERG), "True"),
        ("emergency -> emergency (attributes moved)", status(EMERG, EMERG), "False"),
        ("emergency -> stale -> emergency: same outage", status(STALE_OUT, EMERG), "False"),
        ("ok -> stale -> emergency: a new one", status(STALE_OK, EMERG), "True"),
        ("restart: unavailable -> emergency", status(st("unavailable"), EMERG), "False"),
        ("emergency -> ok is the other automation", status(EMERG, OK), "False"),
        ("ok -> stale", status(OK, STALE_OK), "False"),
        # command_line.reload recreates the entity: no from_state at all. The
        # first version of this alert pushed "restore time revised" to both
        # phones on exactly that, at 14:28 on 29.09.2026.
        ("entity recreated: from_state None", status(None, EMERG), "False")]:
    check("status gate: " + label, gate(rep, trig), want)

REV = {"id": "revised",
       "from_state": st("outage_emergency", outage_end="2026-09-29T15:25:00+03:00"),
       "to_state": st("outage_emergency", outage_end="2026-09-29T17:00:00+03:00")}
check("revision title", fire(rep, rstates, GOLD, REV)["title"],
      "⚠️ DTEK: restore time revised")
check("revision gate: estimate moved", gate(rep, REV), "True")
check("revision gate: end appearing is the start, not a revision",
      gate(rep, {"id": "revised",
                 "from_state": st("outage_emergency", outage_end=None),
                 "to_state": REV["to_state"]}), "False")
check("revision gate: entity recreated, from_state None",
      gate(rep, {"id": "revised", "from_state": None,
                 "to_state": REV["to_state"]}), "False")
check("revision gate: status changed too -> the status message covers it",
      gate(rep, {"id": "revised", "from_state": st("outage_planned",
                 outage_end="2026-09-29T15:25:00+03:00"),
                 "to_state": REV["to_state"]}), "False")

clr = autos["dtek_outage_cleared"]
for label, frm, want in [("emergency -> ok", EMERG, "True"),
                         ("planned -> ok", PLANNED, "True"),
                         ("outage, stale, then ok", STALE_OUT, "True"),
                         ("stale -> ok, no outage before", STALE_OK, "False"),
                         ("restart: unavailable -> ok", st("unavailable"), "False"),
                         ("entity recreated: from_state None", None, "False")]:
    check("clear gate: " + label, gate(clr, status(frm, OK)), want)
check("both edges share one tag, so the clear replaces the warning",
      sorted({x["data"]["data"].get("tag")
              for aid in ("dtek_outage_reported", "dtek_outage_cleared")
              for x in autos[aid]["action"] if x.get("service") in PHONES}),
      ["dtek_outage"])
check("cleared message",
      fire(autos["dtek_outage_cleared"], rstates, GOLD, {})["message"],
      "DTEK no longer reports an outage for queue 1.1. The inverter sees mains.")

# The street scope, straight off the golden answer: 1 of 288.
for label, n, of, want in [("only this building", 1, 288, "Only this building on the street."),
                           ("a dozen houses", 12, 288, "12 of 288 houses on the street."),
                           ("no street data", None, None, "")]:
    check("scope: " + label,
          fire(rep, rstates, {**GOLD, (SENSOR, "street_outages"): n,
                              (SENSOR, "street_houses"): of}, STARTED)["scope_line"], want)
check("scope lands in the message",
      fire(rep, rstates, {**GOLD, (SENSOR, "street_outages"): 1,
                          (SENSOR, "street_houses"): 288}, STARTED)["message"],
      "Аварійні ремонтні роботи, queue 1.1: off since 11:05, expected back by "
      "15:25. Only this building on the street. The inverter still sees mains. "
      "Battery 87.0%, about 9.4 h left at the current draw.")

# --- 5e. the estimate passing ----------------------------------------------
print("\n5e. 'DTEK estimate passed' automation")
over = autos["dtek_outage_overdue"]
otrig = over["trigger"][0]["value_template"]
for label, active, end, at, want in [
        ("before the estimate", True, "2026-09-29T15:25:00+03:00", AT, "False"),
        ("a minute after", True, "2026-09-29T15:25:00+03:00",
         AT.replace(hour=15, minute=26), "True"),
        ("cleared by then", False, "2026-09-29T15:25:00+03:00",
         AT.replace(hour=15, minute=26), "False"),
        ("no estimate published", True, None, AT.replace(hour=15, minute=26), "False")]:
    check(label, render(otrig, {}, {**GOLD, (SENSOR, "outage_active"): active,
                                    (SENSOR, "outage_end"): end}, at), want)
check("message", fire(over, rstates, GOLD, {})["message"],
      "DTEK's 15:25 estimate has passed and the outage is still on record "
      "(Аварійні ремонтні роботи, queue 1.1). The inverter still sees mains.")

# --- 5f. the grid alerts in automations.yaml carry DTEK's side -------------
print("\n5f. Grid Outage / Power Restored mention DTEK")
AUTOS_YAML = yaml.load((PKG.parents[1] / "automations.yaml").read_text(encoding="utf-8"),
                       HaLoader)
grid_autos = {a["alias"]: a for a in AUTOS_YAML}


def dtek_line(alias, states):
    for step in grid_autos[alias]["actions"]:
        if "variables" in step and "dtek_line" in step["variables"]:
            return render(step["variables"]["dtek_line"], states, GOLD, AT)
    return None


check("outage alert, DTEK has it",
      dtek_line("❌ Alert: Grid Outage!", {"binary_sensor.dtek_outage_now": "on"}),
      "DTEK: Аварійні ремонтні роботи, expected back by 15:25.")
check("outage alert, DTEK has nothing",
      dtek_line("❌ Alert: Grid Outage!", {"binary_sensor.dtek_outage_now": "off"}),
      "DTEK has nothing on record yet.")
check("restored, DTEK still has it",
      dtek_line("✅ Power Restored", {"binary_sensor.dtek_outage_now": "on"}),
      "DTEK still reports an outage until 15:25.")
check("restored, DTEK agrees", dtek_line("✅ Power Restored",
      {"binary_sensor.dtek_outage_now": "off"}), "")
check("every grid-alert message uses it",
      all("{{ dtek_line }}" in step["data"]["message"]
          for alias in ("❌ Alert: Grid Outage!", "✅ Power Restored")
          for step in grid_autos[alias]["actions"] if "action" in step), True)

# --- 6. every template renders to one clean token where it must ------------
print("\n6. no template leaks whitespace or a stray token")
for name, item in ents.items():
    for key in ("state", "availability"):
        if key not in item:
            continue
        out = render(item[key], {GRID: "off",
                                 "binary_sensor.dtek_scheduled_dark": "off",
                                 "binary_sensor.dtek_outage_now": "off",
                                 SENSOR: "ok"}, base_attrs(), NOON)
        check("%s.%s is one token" % (name, key), len(out.split()), 1)

# --- 7. the dashboard ------------------------------------------------------
# The two schedule tables are no longer markdown. They are drawn by
# config/www/dtek-shutdowns-card.js, because HA sanitises markdown through
# filterXSS and that allowlist has no `style` attribute, no <style> tag and no
# `title` -- there is no inline CSS to be had in a markdown card. So what is
# worth checking here changed shape with them.
#
# What has not changed is that `ha core check` never looks at any of this. A
# dashboard naming an entity that does not exist shows an "Entity not
# available" tile, and a card whose letter table has drifted from the poller's
# draws hatched unknowns and undercounts the hours. Both read as bad data
# rather than as a bad deploy.
# Every key resolve() returns has to be listed under json_attributes or HA
# silently drops it, which is how the visibility flags could have been added to
# the poller and never reached a dashboard. Derived from the real payload
# rather than from a hand-kept list, so adding a key to the poller and
# forgetting the package fails here instead of on the box.
print()
print("6b. json_attributes covers the poller's payload")
_probe = dtek_poll.resolve(
    {"sub_type": "", "start_date": "", "end_date": "", "type": "",
     "sub_type_reason": ["GPV3.2"], "voluntarily": None, "cek": None},
    {k: True for k in dtek_poll.FLAG_KEYS},
    {"data": [], "update": "24.07.2026 08:30"}, {}, NOON)
# Written by poll(), after resolve() returns.
_probe.update(address=None, status="ok", fetched_at=None, stale=False,
              error=None)
_listed = set()
for _block in pkg.get("command_line") or []:
    for _item in _block.values():
        _listed |= set(_item.get("json_attributes") or [])
check("no payload key is unpublished", sorted(set(_probe) - _listed - {"status"}),
      [])
check("no published key is absent from the payload",
      sorted(_listed - set(_probe)), [])

print()
print("7. dashboards/lovelace.dashboard_dtek.json")
DASH = (Path(__file__).resolve().parents[1] / "dashboards"
        / "lovelace.dashboard_dtek.json")
CARD_JS = (Path(__file__).resolve().parents[1] / "config" / "www"
           / "dtek-shutdowns-card.js")
CARD_TYPE = "custom:dtek-shutdowns-card"
REGISTRY = (Path(__file__).resolve().parents[1] / ".state"
            / "core.entity_registry.json")


def slug(name):
    """HA's entity-id slug, near enough for the names this package uses."""
    return re.sub(r"_+", "_", re.sub(r"[^a-z0-9]+", "_", name.lower())).strip("_")


def declared(package):
    """Every entity id this package creates."""
    out = set()
    for block in package.get("command_line") or []:
        for kind, item in block.items():
            out.add("%s.%s" % (kind, slug(item["name"])))
    for block in package.get("template") or []:
        for kind, items in block.items():
            for item in items:
                out.add("%s.%s" % (kind, slug(item["name"])))
    return out


def nodes_in(node):
    """Every dict in the config that carries a `type` -- views, cards, badges."""
    if isinstance(node, dict):
        if isinstance(node.get("type"), str):
            yield node
        for value in node.values():
            yield from nodes_in(value)
    elif isinstance(node, list):
        for value in node:
            yield from nodes_in(value)


if not DASH.exists():
    print("  skip  dashboard not built yet")
else:
    dash = json.loads(DASH.read_text(encoding="utf-8"))
    view = dash["data"]["config"]["views"][0]
    nodes = list(nodes_in(view))
    types = [n["type"] for n in nodes]

    check("the custom card is on the dashboard", CARD_TYPE in types, True)

    # The card is placed twice on purpose: [hero, week] above the
    # claim-against-measurement section and [source] below it, because that
    # section is a sibling and a card cannot reorder around it. What must hold
    # is that between them every block is drawn exactly once -- a typo in one
    # `blocks` list would silently drop a third of the dashboard, or draw the
    # hero twice, and both still render without an error.
    ours = [n for n in nodes if n["type"] == CARD_TYPE]
    drawn = []
    for c in ours:
        drawn += c.get("blocks") or ["hero", "week", "source"]
    check("every block drawn exactly once", sorted(drawn),
          ["hero", "source", "week"])
    check("and each instance draws at least one", min(
        len(c.get("blocks") or [1, 2, 3]) for c in ours) > 0, True)

    # Every entity id the dashboard names, from badges, tiles and the
    # history-graph alike. The custom card names none of its own: its defaults
    # live in the JS, which section 8 checks separately.
    named = set()
    for node in nodes:
        if isinstance(node.get("entity"), str):
            named.add(node["entity"])
        for sub in node.get("entities") or []:
            eid = sub.get("entity") if isinstance(sub, dict) else sub
            if isinstance(eid, str):
                named.add(eid)

    known = declared(pkg)
    if REGISTRY.exists():
        known |= {e["entity_id"] for e
                  in json.loads(REGISTRY.read_text(encoding="utf-8"))["data"]["entities"]}
    else:
        # .state/ is gitignored, so a fresh clone has no registry to check the
        # ESPHome half against. Check what this package owns and say so.
        print("  note  no .state/core.entity_registry.json -- run ha_pull.sh to "
              "cover the non-DTEK entities too")
        named = {e for e in named if e in known}

    check("the dashboard names entities at all", len(named) > 0, True)
    check("every one of them exists", sorted(named - known), [])

    # Markdown survives only in the comparison section. Deliberately
    # count-agnostic: this proves they render, it does not freeze the layout,
    # which is what made the old version of this check break on a redesign.
    md = [n for n in nodes if n["type"] == "markdown"]
    for i, card in enumerate(md):
        try:
            out = render(card["content"], {}, base_attrs(), NOON)
            check("markdown card %d renders to something" % i, bool(out), True)
        except Exception as exc:  # noqa: BLE001  -- any failure is the finding
            check("markdown card %d renders" % i,
                  "%s: %s" % (type(exc).__name__, exc), True)

# --- 8. the custom card's copy of the alphabet -----------------------------
# The card carries its own letter table because it draws a colour per letter
# and dtek_poll.py cannot reach into a browser. A letter the card has never
# heard of renders as a hatched "unknown" cell AND drops out of the hour
# totals, so a drift here is a silent undercount on a dashboard that otherwise
# looks fine. Assert the two agree instead of hoping.
print()
print("8. config/www/dtek-shutdowns-card.js")
if not CARD_JS.exists():
    check("the card module exists", False, True)
else:
    js = CARD_JS.read_text(encoding="utf-8")
    table = re.search(r"const STATE = \{(.*?)\n\};", js, re.S)
    check("its STATE table is findable", bool(table), True)
    if table:
        found = {a or b for a, b in
                 re.findall(r'^\s*(?:"(.)"|(\w)):\s*\{', table.group(1), re.M)}
        check("covers every letter dtek_poll.py emits",
              sorted(found), sorted(set(STATE_LETTER.values()) | {"?"}))
    check("maybe counts as dark, as OFF_HALVES does",
          bool(re.search(r"\bm:\s*\{[^}]*\boff:\s*1\b", js)), True)
    check("the four half-hour states are half an hour",
          len(re.findall(r"\b[fsFS]:\s*\{[^}]*\boff:\s*0\.5\b", js)), 4)
    check("the dashboard's card type is the one it defines",
          'const CARD = "%s"' % CARD_TYPE.split(":", 1)[1] in js, True)

    # The grid must be gated on the flag, and gated the safe way round: a
    # payload predating week_in_effect has to keep drawing rather than blank.
    # `!== false` is the whole guarantee, so assert the operator itself.
    check("the grid is gated on week_in_effect",
          bool(re.search(r"a\.week_in_effect\s*!==\s*false", js)), True)
    check("nothing gates on === true instead",
          bool(re.search(r"week_in_effect\s*===\s*true", js)), False)
    # A reason with no sentence falls back to the plan_off copy, which would
    # tell a CEK address to await schedules that are never coming.
    withheld = re.search(r"const WITHHELD = \{(.*?)\n\};", js, re.S)
    check("its WITHHELD map is findable", bool(withheld), True)
    if withheld:
        keys = set(re.findall(r"^\s*(\w+):", withheld.group(1), re.M))
        check("has a sentence for every hidden_reason",
              sorted(set(HIDDEN_REASONS) - keys), [])
    check("both week-derived tiles can blank",
          len(re.findall(r'tile\("(?:Next window|Off this week)"', js)), 2)
    # green = all good, warn = DTEK has a notice but mains is present, red =
    # the power is actually off. In that order of precedence.
    check("hero accent: red, then warn for a DTEK notice, then green",
          bool(re.search(r"accent:\s*gridDown\s*\?\s*RED\s*:\s*dtekOutage\s*\?"
                         r"\s*ORANGE\s*:\s*GREEN", js)), True)
    check("weekOff is null rather than 0h when withheld",
          bool(re.search(r"weekOff:\s*weekLive\s*\?", js)), True)


print("\n%s" % ("FAILED: " + ", ".join(FAILED) if FAILED else "all checks passed"))
sys.exit(1 if FAILED else 0)
