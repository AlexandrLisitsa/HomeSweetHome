"""Render the outage pre-charge plan in packages/outage_precharge.yaml against fake states.

    python HomeAssistant/tools/test_outage_precharge.py

The plan is one Jinja template that decides, every DTEK poll, whether the
inverter charges for the next outage and at how many amps. `ha core check` only
parses it, and DTEK has published no schedule since 24.07.2026, so production
cannot exercise it either: a wrong branch would sit unnoticed until the first
real window, and then either charge at day rates for nothing or let the outage
arrive with the pack half empty. This proves the branches the package header
promises, including the re-pull cases (a window that moves or vanishes).

Same approach as check_dtek_templates.py: just enough of Home Assistant's
template environment to render the real template text out of the package.

The package's two automations (drive, started) run through
ha_automation_sim.py against a fake house: what is written to the ESP's
Pre-charge Until and the charge-current select, and when the phones hear
about it. `known_bug()` is kept for the next finding: it prints intended
behaviour the YAML does not deliver yet without failing the run.
"""
import ast
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml
from jinja2.sandbox import ImmutableSandboxedEnvironment

KYIV = ZoneInfo("Europe/Kyiv")
PKG = (Path(__file__).resolve().parents[1] / "config" / "packages"
       / "outage_precharge.yaml")
SWITCH = "switch.powmr_inverter_outage_pre_charge"
START = "sensor.dtek_next_outage_start"
CAP = "sensor.jkbms_gateway_bms_capacity_remaining"
FAILED = []


class HaLoader(yaml.SafeLoader):
    """SafeLoader that shrugs at !secret / !include instead of dying."""


HaLoader.add_multi_constructor("!", lambda loader, suffix, node: None)


def is_number(value):
    try:
        float(value)
    except (TypeError, ValueError):
        return False
    return True


def make_env(states, now):
    env = ImmutableSandboxedEnvironment()

    def _states(eid):
        return str(states.get(eid, "unknown"))

    def _as_datetime(value):
        try:
            return datetime.fromisoformat(str(value))
        except (TypeError, ValueError):
            return None

    def _as_timestamp(value, default=None):
        # HA reads a naive time as local, and returns real (UTC) seconds.
        d = value if isinstance(value, datetime) else _as_datetime(value)
        if d is None:
            return default
        return (d if d.tzinfo else d.replace(tzinfo=KYIV)).timestamp()

    env.globals.update(states=_states, is_state=lambda e, v: _states(e) == v,
                       now=lambda: now, as_datetime=_as_datetime,
                       as_timestamp=_as_timestamp, timedelta=timedelta)
    env.filters["is_number"] = is_number
    env.tests["is_number"] = is_number
    return env


def plan_template():
    pkg = yaml.load(PKG.read_text(encoding="utf-8"), Loader=HaLoader)
    block = pkg["template"][0]
    return block["action"][0]["variables"]["plan"]


TEMPLATE = plan_template()


def plan(now, start, cap, enabled=True):
    states = {SWITCH: "on" if enabled else "off", CAP: cap,
              START: start.isoformat() if start else "unknown"}
    out = make_env(states, now).from_string(TEMPLATE).render().strip()
    # HA parses a rendered variable back into a native dict the same way.
    return ast.literal_eval(out)


def at(day, hhmm):
    h, m = map(int, hhmm.split(":"))
    return datetime(2026, 11, day, h, m, tzinfo=KYIV)


def check(label, got, want):
    ok = got == want
    if not ok:
        FAILED.append(label)
    print("  %-4s %-58s %r%s" % ("ok" if ok else "FAIL", label, got,
                                 "" if ok else "  want %r" % (want,)))


def state_current(p):
    return (p["state"], p["current"])


print("plan states")
check("no window published -> idle",
      plan(at(2, "12:00"), None, 112)["state"], "idle")
check("switch off -> off, whatever the schedule",
      plan(at(2, "12:00"), at(2, "14:00"), 112, enabled=False)["state"], "off")
check("window already started -> idle",
      plan(at(2, "12:00"), at(2, "11:00"), 112)["state"], "idle")
check("no battery reading -> idle",
      plan(at(2, "12:00"), at(2, "14:00"), "unavailable")["state"], "idle")
check("battery at 279 of 280 Ah -> full",
      plan(at(2, "12:00"), at(2, "14:00"), 279)["state"], "full")

print("currents")
check("40% with 2 h to go, day -> charging, 60 A",
      state_current(plan(at(2, "12:00"), at(2, "14:00"), 112)), ("charging", 60))
check("90% with 4 h to go, day -> 10 A floor",
      state_current(plan(at(2, "09:00"), at(2, "13:00"), 252)), ("charging", 10))
check("outage in 10 min -> 60 A until it starts",
      state_current(plan(at(2, "12:00"), at(2, "12:10"), 252)), ("charging", 60))
check("deadline is the outage start, not start - buffer",
      plan(at(2, "12:00"), at(2, "14:00"), 112)["until"], at(2, "14:00").isoformat())

print("night tariff first")
check("10:00 outage seen at 14:00 the day before -> waiting_night",
      state_current(plan(at(2, "14:00"), at(3, "10:00"), 140)), ("waiting_night", None))
check("the same window at 01:00 -> charging, sized to the night (27 A -> 30)",
      state_current(plan(at(3, "01:00"), at(3, "10:00"), 140)), ("charging", 30))
check("night left is too short at 02:00 -> charging, 60 A",
      state_current(plan(at(3, "02:00"), at(3, "05:00"), 28)), ("charging", 60))
check("evening, night before the window too short -> charging now, 60 A",
      state_current(plan(at(2, "21:00"), at(3, "00:30"), 28)), ("charging", 60))
check("night hours counted up to the deadline only (23:00-04:30 = 5.5 h)",
      plan(at(2, "14:00"), at(3, "05:00"), 196)["night_hours"], 5.5)

print("every DTEK pull re-plans")
first = plan(at(2, "12:00"), at(2, "18:00"), 196)
check("70% for 18:00 -> 20 A", state_current(first), ("charging", 20))
check("window moves earlier to 15:00 -> current goes up to 40 A",
      state_current(plan(at(2, "12:00"), at(2, "15:00"), 196)), ("charging", 40))
check("window moves later to 05:00 tomorrow -> waiting_night",
      plan(at(2, "12:00"), at(3, "05:00"), 196)["state"], "waiting_night")
check("window removed -> idle, override released",
      plan(at(2, "12:00"), None, 196)["state"], "idle")


print("plan corner cases")
check("window starts right now -> idle (start == now)",
      plan(at(2, "12:00"), at(2, "12:00"), 112)["state"], "idle")
check("window in 1 min (deadline already past) -> charging, 60 A",
      state_current(plan(at(2, "12:00"), at(2, "12:01"), 252)), ("charging", 60))
check("window in exactly 30 min -> hours_left 0, 60 A",
      (plan(at(2, "12:00"), at(2, "12:30"), 252)["hours_left"],
       plan(at(2, "12:00"), at(2, "12:30"), 252)["current"]), (0.0, 60))
check("0.25 h to the deadline is not > 0.25 -> 60 A even when nearly full",
      state_current(plan(at(2, "12:00"), at(2, "12:45"), 275)), ("charging", 60))
check("0.27 h -> sized: 5.75 Ah / 0.27 h = 21.6 A -> 30",
      state_current(plan(at(2, "12:00"), at(2, "12:46"), 275)), ("charging", 30))
check("capacity 280 -> full", plan(at(2, "12:00"), at(2, "14:00"), 280)["state"], "full")
check("capacity above 280 (300) -> full, no current",
      state_current(plan(at(2, "12:00"), at(2, "14:00"), 300)), ("full", None))
check("277.25 Ah (under 1% short) -> full",
      plan(at(2, "12:00"), at(2, "14:00"), 277.25)["state"], "full")
check("277.1 Ah (just over 1%) -> charging",
      plan(at(2, "12:00"), at(2, "14:00"), 277.1)["state"], "charging")
check("negative capacity (-5) -> charging, 60 A",
      state_current(plan(at(2, "12:00"), at(2, "14:00"), -5)), ("charging", 60))
check("capacity garbage 'abc' -> idle, capacity unknown",
      (plan(at(2, "12:00"), at(2, "14:00"), "abc")["state"],
       plan(at(2, "12:00"), at(2, "14:00"), "abc")["reason"]),
      ("idle", "battery capacity unknown"))
check("capacity '' -> idle", plan(at(2, "12:00"), at(2, "14:00"), "")["state"], "idle")
check("capacity as a string '112.0' -> same as 112",
      state_current(plan(at(2, "12:00"), at(2, "14:00"), "112.0")), ("charging", 60))

print("night boundaries")
check("window at 23:00 today, seen at 14:00 -> no night before it, charge now",
      (state_current(plan(at(2, "14:00"), at(2, "23:00"), 140)),
       plan(at(2, "14:00"), at(2, "23:00"), 140)["night_hours"]), (("charging", 20), 0.0))
check("window at 07:00 tomorrow -> waiting_night, 23:00-06:30 = 7.5 h",
      (plan(at(2, "14:00"), at(3, "07:00"), 140)["state"],
       plan(at(2, "14:00"), at(3, "07:00"), 140)["night_hours"]), ("waiting_night", 7.5))
check("window at 07:30 -> deadline on the tariff end, the whole 8 h night",
      plan(at(2, "14:00"), at(3, "07:30"), 140)["night_hours"], 8.0)
check("window far ahead (10:00 in 3 days) -> waiting_night",
      plan(at(2, "14:00"), at(5, "10:00"), 140)["state"], "waiting_night")
check("23:00 exactly is night: sized to the 8 h night (20.1 A -> 30)",
      (state_current(plan(at(2, "23:00"), at(3, "10:00"), 140)),
       plan(at(2, "23:00"), at(3, "10:00"), 140)["reason"]),
      (("charging", 30), "filling within the night tariff"))
check("22:59 is day -> waiting_night",
      plan(at(2, "22:59"), at(3, "10:00"), 140)["state"], "waiting_night")
check("06:59, 1 min of night left -> night too short, 60 A",
      (state_current(plan(at(3, "06:59"), at(3, "09:00"), 140)),
       plan(at(3, "06:59"), at(3, "09:00"), 140)["reason"]),
      (("charging", 60), "night tariff too short, charging at full current"))
check("07:00 exactly is day, no night left -> charging now",
      (plan(at(3, "07:00"), at(3, "09:00"), 140)["night_hours"],
       plan(at(3, "07:00"), at(3, "09:00"), 140)["reason"]),
      (0.0, "night tariff too short or past, charging now"))

print("DST weekends (Europe/Kyiv)")
SPRING_DAY = datetime(2027, 3, 27, 14, 0, tzinfo=KYIV)       # EET, +02
SPRING_NIGHT = datetime(2027, 3, 27, 23, 0, tzinfo=KYIV)
SPRING_10 = datetime(2027, 3, 28, 10, 0, tzinfo=KYIV)        # EEST, +03
FALL_DAY = datetime(2026, 10, 24, 14, 0, tzinfo=KYIV)        # EEST, +03
FALL_10 = datetime(2026, 10, 25, 10, 0, tzinfo=KYIV)         # EET, +02
check("spring: window 10:00 after the jump -> waiting_night",
      plan(SPRING_DAY, SPRING_10, 140)["state"], "waiting_night")
check("spring: until keeps the +03:00 offset",
      plan(SPRING_DAY, SPRING_10, 140)["until"], "2027-03-28T10:00:00+03:00")
check("spring: deadline inside the short night is counted in real hours (4.5)",
      plan(SPRING_DAY, datetime(2027, 3, 28, 5, 0, tzinfo=KYIV), 140)["night_hours"], 4.5)
check("fall: window 10:00 after the fall-back -> waiting_night",
      plan(FALL_DAY, FALL_10, 140)["state"], "waiting_night")
check("fall: hours_left to 09:30 EET is 20.5 real hours",
      plan(FALL_DAY, FALL_10, 140)["hours_left"], 20.5)

# --- HA-faithful rendering and the automations, through ha_automation_sim ----

from ha_automation_sim import (House, Simulator, START as HA_START,  # noqa: E402
                               TimeTick, find, load_package, render)


def sim_plan(now, start_state, cap, switch="on"):
    h = House(now)
    h.set(SWITCH, switch)
    h.set(START, start_state)
    h.set(CAP, cap)
    return render(TEMPLATE, h)


print("rendered the HA way (ha_automation_sim)")
check("HA is_number: capacity 'nan' -> idle (not a number to HA)",
      sim_plan(at(2, "12:00"), at(2, "14:00").isoformat(), "nan")["state"], "idle")
check("capacity 'inf' -> idle",
      sim_plan(at(2, "12:00"), at(2, "14:00").isoformat(), "inf")["state"], "idle")
check("outage start garbage 'soon' -> idle",
      sim_plan(at(2, "12:00"), "soon", 112)["state"], "idle")
check("outage start 'None' -> idle", sim_plan(at(2, "12:00"), "None", 112)["state"], "idle")
check("outage start '' -> idle", sim_plan(at(2, "12:00"), "", 112)["state"], "idle")
check("outage start in UTC -> same as local",
      state_current(sim_plan(at(2, "12:00"), "2026-11-02T12:00:00+00:00", 112)),
      ("charging", 60))
check("switch 'unavailable' (ESP offline) -> off",
      sim_plan(at(2, "12:00"), at(2, "14:00").isoformat(), 112, switch="unavailable")["state"],
      "off")
check("the sim's HA env agrees with this file's on the base case",
      sim_plan(at(2, "12:00"), at(2, "14:00").isoformat(), 112),
      plan(at(2, "12:00"), at(2, "14:00"), 112))

print("drive")
KNOWN = []


def known_bug(label, got, want):
    """Intended behaviour that the YAML does not deliver yet: printed, not failed."""
    ok = got == want
    if not ok:
        KNOWN.append(label)
    print("  %-4s %-58s %r%s" % ("ok" if ok else "BUG", label, got,
                                 "" if ok else "  want %r" % (want,)))


PACKAGE = load_package(PKG)
DRIVE = find(PACKAGE["automation"], "id", "outage_precharge_drive")
STARTED = find(PACKAGE["automation"], "id", "outage_precharge_started")
PLAN = "sensor.outage_pre_charge_plan"
UNTIL = "datetime.powmr_inverter_pre_charge_until"
SELECT = "select.powmr_inverter_max_ac_charge_current"
SOC = "sensor.jkbms_gateway_bms_state_of_charge"
NOON = at(2, "12:00")
SET = "datetime.set_value"
OPT = "select.select_option"


def utc_iso(local):
    """A datetime entity's state: ISO, in UTC, as HA stores it."""
    return local.astimezone(timezone.utc).isoformat()


RELEASED_STATE = utc_iso(datetime(2000, 1, 1, tzinfo=KYIV))
W14 = at(2, "14:00").isoformat()


def drive_house(state="charging", amps=60, until=W14, have=RELEASED_STATE,
                select="30", now=NOON):
    h = House(now)
    h.set(PLAN, state, current=amps, until=until)
    h.set(UNTIL, have)
    h.set(SELECT, select)
    return h


def drive(**kw):
    """One self-healing tick of the drive. (runs, house)."""
    h = drive_house(**kw)
    return Simulator(h, [DRIVE]).fire(TimeTick(h.now)), h


def calls(runs):
    return [(c.service, dict(c.data)) for r in runs for c in r.calls]


def writes(runs, service):
    return [dict(c.data) for r in runs for c in r.calls if c.service == service]


runs, h = drive()
check("charging for 14:00 -> deadline written as UTC, then 60 A",
      calls(runs), [(SET, {"datetime": "2026-11-02T12:00:00+00:00"}), (OPT, {"option": 60})])
check("... the datetime now reads 12:00 UTC", h.state(UNTIL), "2026-11-02T12:00:00+00:00")
check("the next tick writes nothing",
      calls(Simulator(h, [DRIVE]).fire(TimeTick(at(2, "12:05")))), [])
check("until given in UTC -> the same UTC write",
      writes(drive(until="2026-11-02T12:00:00+00:00")[0], SET),
      [{"datetime": "2026-11-02T12:00:00+00:00"}])
check("until with fractional seconds -> truncated, and then stable",
      calls(drive(until="2026-11-02T14:00:00.700000+02:00",
                  have="2026-11-02T12:00:00+00:00", select="60")[0]), [])
check("window moves earlier (13:00) -> rewritten",
      writes(drive(until=at(2, "13:00").isoformat(),
                   have="2026-11-02T12:00:00+00:00")[0], SET),
      [{"datetime": "2026-11-02T11:00:00+00:00"}])
check("waiting_night with a future deadline set -> released",
      writes(drive(state="waiting_night", amps=None,
                   have="2026-11-02T12:00:00+00:00")[0], SET),
      [{"datetime": "2000-01-01 00:00:00"}])
runs, h = drive(state="off", amps=None, until=None, have="2026-11-02T12:00:00+00:00")
check("switched off with a future deadline -> released", writes(runs, SET),
      [{"datetime": "2000-01-01 00:00:00"}])
check("... the release value reads back as 1999-12-31 22:00 UTC",
      h.state(UNTIL), "1999-12-31T22:00:00+00:00")
check("idle, deadline already past (10:00 today) -> nothing (past == released)",
      calls(drive(state="idle", amps=None, until=None,
                  have="2026-11-02T08:00:00+00:00")[0]), [])
check("idle, released -> nothing", calls(drive(state="idle", amps=None, until=None)[0]), [])
check("deadline 1 s ahead still counts as future -> released",
      writes(drive(state="idle", amps=None, until=None,
                   have=utc_iso(NOON + timedelta(seconds=1)))[0], SET),
      [{"datetime": "2000-01-01 00:00:00"}])
check("deadline exactly now counts as past -> nothing",
      calls(drive(state="idle", amps=None, until=None, have=utc_iso(NOON))[0]), [])
check("stale plan: charging but until already past -> no deadline write",
      writes(drive(until=at(2, "11:00").isoformat())[0], SET), [])
check("charging with no until -> no deadline write", writes(drive(until=None)[0], SET), [])
check("charging, select already 60 -> only the deadline",
      calls(drive(select="60")[0]), [(SET, {"datetime": "2026-11-02T12:00:00+00:00"})])
check("charging 10 A -> '10'",
      [str(d["option"]) for d in writes(drive(amps=10)[0], OPT)], ["10"])
check("charging, current as a string '60' -> treated as 60",
      writes(drive(amps="60", select="60")[0], OPT), [])
check("charging, no current -> no select write", writes(drive(amps=None)[0], OPT), [])
check("select 'unavailable' -> still tried (HA logs the failed call)",
      writes(drive(select="unavailable")[0], OPT), [{"option": 60}])
for st in ("full", "waiting_night", "idle", "off"):
    check("%s -> never touches the select" % st,
          writes(drive(state=st, amps=None, until=None)[0], OPT), [])
for bad in ("unavailable", "unknown"):
    check("datetime %s -> does not run at all" % bad, drive(have=bad)[0], [])

print("drive: triggers")
h = drive_house(select="60", have="2026-11-02T12:00:00+00:00")
sim = Simulator(h, [DRIVE])
check("12:03 is not a 5-minute tick", sim.fire(TimeTick(at(2, "12:03"))), [])
check("HA start runs it", len(sim.fire(HA_START)), 1)
runs = sim.fire(h.change(PLAN, until=at(2, "13:00").isoformat()))
check("until-only change -> the state and the until triggers (2 runs)", len(runs), 2)
check("... one write", len(writes(runs, SET)), 1)
runs = sim.fire(h.change(PLAN, "idle", current=None, until=None))
check("charging -> idle with both attributes cleared -> 3 runs (max 3)", len(runs), 3)
check("... released once", writes(runs, SET), [{"datetime": "2000-01-01 00:00:00"}])

print("started")


def started_house(state="idle", soc="40.4"):
    h = House(NOON)
    h.set(PLAN, state, current=None, until=None, reason="")
    h.set(SOC, soc)
    return h


CHARGING = dict(current=60, until=W14, reason="night tariff too short or past, charging now")


def start_msgs(h, event):
    return [n.data["message"] for r in Simulator(h, [STARTED]).fire(event)
            for n in r.notifications]


h = started_house()
runs = Simulator(h, [STARTED]).fire(h.change(PLAN, "charging", **CHARGING))
check("idle -> charging: one line, with time, amps, battery and reason",
      [n.data["message"] for r in runs for n in r.notifications],
      ["Charging for the 14:00 DTEK outage at 60 A "
       "(battery 40%, night tariff too short or past, charging now)."])
check("... title and channel",
      [(n.data["title"], n.data["data"]) for r in runs for n in r.notifications],
      [("\U0001f50b Outage pre-charge started", {"channel": "Outage pre-charge"})])
h = started_house(state="waiting_night")
check("waiting_night -> charging -> notifies",
      len(start_msgs(h, h.change(PLAN, "charging", **CHARGING))), 1)
h = started_house(state="charging")
h.change(PLAN, **CHARGING)
check("charging -> charging (re-target) -> nothing",
      start_msgs(h, h.change(PLAN, current=40, until=at(2, "13:00").isoformat())), [])
h = House(NOON)
check("entity appears already charging (no from_state) -> nothing",
      start_msgs(h, h.change(PLAN, "charging", **CHARGING)), [])
h = started_house(state="unknown")
check("unknown -> charging (e.g. after a reload) -> notifies",
      len(start_msgs(h, h.change(PLAN, "charging", **CHARGING))), 1)
h = started_house()
check("until in UTC -> the local 14:00",
      start_msgs(h, h.change(PLAN, "charging",
                             **dict(CHARGING, until="2026-11-02T12:00:00+00:00")))[0][:22],
      "Charging for the 14:00")
h = started_house(soc="unavailable")
check("SOC unavailable -> the line says 'battery 0%' (float(0) default)",
      "(battery 0%," in start_msgs(h, h.change(PLAN, "charging", **CHARGING))[0], True)
h = started_house()
check("idle -> full -> nothing", start_msgs(h, h.change(PLAN, "full")), [])

print("DST nights (were known bugs, fixed 2026-10-02)")
# The plan adds and subtracts datetimes that share now()'s ZoneInfo, which
# Python does in WALL-CLOCK time: a DST night is counted as 8 h.
check("spring: the 23:00-07:00 night before 10:00 is 7 real hours",
          plan(SPRING_DAY, SPRING_10, 140)["night_hours"], 7.0)
check("spring, at 23:00: 80 Ah needs 230 Ah / 7 h = 32.9 A -> 40",
          plan(SPRING_NIGHT, SPRING_10, 80)["current"], 40)
check("fall: the 23:00-07:00 night before 10:00 is 9 real hours",
          plan(FALL_DAY, FALL_10, 140)["night_hours"], 9.0)
# A window inside the repeated hour of the fall-back (03:30 EET, the second
# 03:30) cannot be written as naive local time: datetime.set_value reads it
# with fold=0, i.e. 03:30 EEST, an hour early. The drive then never matches
# and rewrites it on every run.
FALL_0330 = datetime(2026, 10, 25, 3, 30, fold=1, tzinfo=KYIV)
runs, h = drive(until=FALL_0330.isoformat(), select="60",
                now=datetime(2026, 10, 25, 1, 0, tzinfo=KYIV))
check("fall-back 03:30 EET window: ESP deadline == window start",
          h.state(UNTIL), utc_iso(FALL_0330))
runs2 = Simulator(h, [DRIVE]).fire(TimeTick(datetime(2026, 10, 25, 1, 5, tzinfo=KYIV)))
check("... and the next tick writes nothing", writes(runs2, SET), [])

if KNOWN:
    print("\n%d known bug(s) still present: %s" % (len(KNOWN), ", ".join(KNOWN)))

print("\n%s" % ("FAILED: " + ", ".join(FAILED) if FAILED else "all checks passed"))
sys.exit(1 if FAILED else 0)
