"""Render the adaptive night charge plan in packages/adaptive_charge.yaml against fake states.

    python HomeAssistant/tools/test_adaptive_charge.py

The plan is one Jinja template that decides, every hour of the night, the
smallest Max AC Charge Current that still fills the pack before the night
tariff ends at 07:00. `ha core check` only parses it, and a wrong branch shows
up as a pack that is half empty at 07:00 or charged at 60 A for nothing. This
proves the gating and the sizing, including the hourly re-size as the pack
fills or falls behind.

Same approach as test_outage_precharge.py: just enough of Home Assistant's
template environment to render the real template text out of the package.

The package's three automations (drive, outage_off, guard) run through
ha_automation_sim.py against a fake house: what is written to the select and
the saved-current helper, when a pre-charge holds the writes, and what the
guard refuses. `known_bug()` is kept for the next finding: it prints intended
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
       / "adaptive_charge.yaml")
ENABLED = "input_boolean.adaptive_night_charge"
AUTO = "switch.powmr_inverter_auto_tariff_mode"
NIGHT_ONLY = "switch.powmr_inverter_night_charging_only"
PRECHARGE = "sensor.outage_pre_charge_plan"
PRECHARGE_SWITCH = "switch.powmr_inverter_outage_pre_charge"
PRECHARGE_UNTIL = "datetime.powmr_inverter_pre_charge_until"
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

    def _as_timestamp(value, default=None):
        # HA reads a naive string as local time, as datetime.set_value wrote it.
        if isinstance(value, datetime):
            return value.timestamp()
        try:
            d = datetime.fromisoformat(str(value))
        except (TypeError, ValueError):
            return default
        return (d if d.tzinfo else d.replace(tzinfo=KYIV)).timestamp()

    env.globals.update(states=_states, is_state=lambda e, v: _states(e) == v,
                       now=lambda: now, timedelta=timedelta,
                       as_timestamp=_as_timestamp)
    env.filters["is_number"] = is_number
    env.tests["is_number"] = is_number
    return env


def plan_template():
    pkg = yaml.load(PKG.read_text(encoding="utf-8"), Loader=HaLoader)
    block = pkg["template"][0]
    return block["action"][0]["variables"]["plan"]


TEMPLATE = plan_template()


# The ESP's release value: any past moment means "no pre-charge".
RELEASED = "2000-01-01 00:00:00"


def plan(now, cap, enabled=True, auto="on", night_only="off", precharge="idle",
         precharge_on="on", until=RELEASED):
    states = {ENABLED: "on" if enabled else "off", AUTO: auto,
              NIGHT_ONLY: night_only, PRECHARGE: precharge, CAP: cap,
              PRECHARGE_SWITCH: precharge_on, PRECHARGE_UNTIL: until}
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


print("gating")
check("switched off -> off",
      plan(at(2, "23:00"), 140, enabled=False)["state"], "off")
check("Auto and Night only both off -> inactive",
      plan(at(2, "23:00"), 140, auto="off", night_only="off")["state"], "inactive")
check("Night only alone is enough",
      plan(at(2, "23:00"), 140, auto="off", night_only="on")["state"], "charging")
check("Auto unavailable (ESP offline), Night only off -> inactive",
      plan(at(2, "23:00"), 140, auto="unavailable")["state"], "inactive")
check("12:00 -> day", state_current(plan(at(2, "12:00"), 140)), ("day", None))
check("22:59 -> still day", plan(at(2, "22:59"), 140)["state"], "day")
check("07:00 -> day again", plan(at(3, "07:00"), 140)["state"], "day")
check("no battery reading -> unknown, no current",
      state_current(plan(at(2, "23:00"), "unavailable")), ("unknown", None))
check("battery reading 'unknown' -> unknown",
      plan(at(2, "23:00"), "unknown")["state"], "unknown")

print("pre-charge is not the plan's business any more")
# An outage window switches adaptive off (adaptive_charge_outage_off), so the
# plan no longer looks at pre-charge at all: a lagging pre-charge state must
# not change what it computes.
check("pre-charge charging, adaptive still on -> sizes as normal",
      plan(at(2, "23:00"), 140, precharge="charging")["state"], "charging")
check("pre-charge deadline ahead -> sizes as normal",
      plan(at(3, "02:00"), 140, until="2026-11-03 09:00:00")["state"], "charging")

print("sizing")
p = plan(at(2, "23:00"), 140)
check("50% at 23:00: 161 Ah over 7.5 h = 21.5 A -> 30", state_current(p), ("charging", 30))
check("hours to the 06:30 deadline", p["hours_left"], 7.5)
check("until is the tariff end, the next morning", p["until"], at(3, "07:00").isoformat())
check("at 02:00 with 220 Ah: 69 Ah over 4.5 h = 15.3 A -> 20",
      state_current(plan(at(3, "02:00"), 220)), ("charging", 20))
check("at 05:00 with 270 Ah: 11.5 Ah over 1.5 h = 7.7 A -> 10",
      state_current(plan(at(3, "05:00"), 270)), ("charging", 10))
check("nearly full at 03:00: 5.75 Ah over 3.5 h -> 2 A trickle step",
      state_current(plan(at(3, "03:00"), 275)), ("charging", 2))
check("full (278 of 280 Ah) -> full, 2 A",
      state_current(plan(at(3, "01:00"), 278)), ("full", 2))

print("the hourly re-size")
check("fell behind: 200 Ah at 05:00 needs 61 A -> 60, full current",
      state_current(plan(at(3, "05:00"), 200)), ("charging", 60))
check("... and its reason says so",
      plan(at(3, "05:00"), 200)["reason"], "behind, charging at full current")
check("10 min to the deadline -> 60 A",
      state_current(plan(at(3, "06:20"), 270)), ("charging", 60))
check("inside the buffer, 06:40: sized to 07:00 (34.5 A -> 40)",
      state_current(plan(at(3, "06:40"), 270)), ("charging", 40))
check("after midnight the deadline is the same morning",
      plan(at(3, "00:30"), 140)["hours_left"], 6.0)


print("plan corner cases")
check("capacity above 280 (re-specified pack) -> full, 2 A",
      state_current(plan(at(3, "01:00"), 300)), ("full", 2))
check("under 1% short (277.25 Ah) -> full",
      plan(at(3, "01:00"), 277.25)["state"], "full")
check("just over 1% short (277.1 Ah) -> charging",
      plan(at(3, "01:00"), 277.1)["state"], "charging")
check("negative capacity reading -> charging, sized on the whole pack + more",
      state_current(plan(at(3, "05:00"), -5)), ("charging", 60))
check("capacity as a numeric string '140.0' -> same as 140",
      state_current(plan(at(2, "23:00"), "140.0")), ("charging", 30))
check("capacity garbage 'abc' -> unknown",
      plan(at(2, "23:00"), "abc")["state"], "unknown")
check("capacity empty string -> unknown", plan(at(2, "23:00"), "")["state"], "unknown")
check("06:59 is still night, inside the buffer: sized to 07:00, 1 min -> 60 A",
      state_current(plan(at(3, "06:59"), 270)), ("charging", 60))
check("06:45: 0.25 h left is not > 0.25 -> 60 A",
      state_current(plan(at(3, "06:45"), 270)), ("charging", 60))
check("23:00 exactly is night", plan(at(2, "23:00"), 140)["state"], "charging")
check("00:00 exactly is night, deadline the same morning",
      plan(at(3, "00:00"), 140)["hours_left"], 6.5)
check("switched off wins over everything (no battery reading)",
      plan(at(2, "23:00"), "unavailable", enabled=False)["state"], "off")
check("Auto 'on' but Night only 'unavailable' -> still charging",
      plan(at(2, "23:00"), 140, night_only="unavailable")["state"], "charging")


# Kyiv springs forward on 2027-03-28 03:00 -> 04:00 and falls back on
# 2026-10-25 04:00 -> 03:00. The plan subtracts two datetimes that share
# now()'s ZoneInfo, and Python then subtracts WALL-CLOCK times: the
# spring-forward night is counted 1 h too long (under-sizing the current
# until the jump), the fall-back night 1 h too short (over-sizing, safe side).
KYIV_SPRING = datetime(2027, 3, 27, 23, 0, tzinfo=KYIV)
KYIV_FALL = datetime(2026, 10, 24, 23, 0, tzinfo=KYIV)

# --- the automations, through ha_automation_sim -------------------------------

from ha_automation_sim import (House, Simulator, START, TimeTick, find,  # noqa: E402
                               load_package)

KNOWN = []


def known_bug(label, got, want):
    """Intended behaviour that the YAML does not deliver yet: printed, not failed."""
    ok = got == want
    if not ok:
        KNOWN.append(label)
    print("  %-4s %-58s %r%s" % ("ok" if ok else "BUG", label, got,
                                 "" if ok else "  want %r" % (want,)))


PACKAGE = load_package(PKG)
DRIVE = find(PACKAGE["automation"], "id", "adaptive_charge_drive")
OUTAGE_OFF = find(PACKAGE["automation"], "id", "adaptive_charge_outage_off")
GUARD = find(PACKAGE["automation"], "id", "adaptive_charge_guard")
PLAN = "sensor.adaptive_charge_plan"
SELECT = "select.powmr_inverter_max_ac_charge_current"
SAVED = "input_number.adaptive_charge_saved_current"
CHARGER = "switch.powmr_inverter_ac_charging_enabled"
NIGHT = at(2, "23:00")


def utc_iso(local):
    """A datetime entity's state: ISO, in UTC, as HA stores it."""
    return local.astimezone(timezone.utc).isoformat()


RELEASED_STATE = utc_iso(datetime(2000, 1, 1, tzinfo=KYIV))


def drive_house(plan_state="charging", amps=30, have="40", saved="0.0",
                pre="idle", pre_on="on", until=RELEASED_STATE, now=NIGHT):
    h = House(now)
    h.set(PLAN, plan_state, current=amps)
    h.set(SELECT, have)
    h.set(SAVED, saved)
    h.set(PRECHARGE, pre)
    h.set(PRECHARGE_SWITCH, pre_on)
    h.set(PRECHARGE_UNTIL, until)
    return h


def drive(**kw):
    """One self-healing tick of the drive. (runs, house)."""
    h = drive_house(**kw)
    return Simulator(h, [DRIVE]).fire(TimeTick(h.now)), h


def calls(runs):
    return [(c.service, c.entity_id, dict(c.data)) for r in runs for c in r.calls]


def options(runs):
    return [str(c.data["option"]) for r in runs for c in r.calls
            if c.service == "select.select_option"]


print("drive: the first write of the night")
runs, h = drive()
check("saves the user's 40 A, then writes 30",
      calls(runs), [("input_number.set_value", SAVED, {"value": 40}),
                    ("select.select_option", SELECT, {"option": 30})])
check("... the select now reads 30, saved reads 40.0",
      (h.state(SELECT), h.state(SAVED)), ("30", "40.0"))
runs2 = Simulator(h, [DRIVE]).fire(TimeTick(at(2, "23:05")))
check("the next tick writes nothing (already 30)", calls(runs2), [])
check("already saved (40) -> only the select, saved untouched",
      calls(drive(amps=20, have="30", saved="40.0")[0]),
      [("select.select_option", SELECT, {"option": 20})])
check("select reads garbage -> written, but nothing saved (have = -1)",
      calls(drive(have="abc")[0]), [("select.select_option", SELECT, {"option": 30})])
check("select reads '0' -> written, 0 is not a user value to save",
      calls(drive(have="0")[0]), [("select.select_option", SELECT, {"option": 30})])
check("select '30', plan 30 -> no write", calls(drive(have="30")[0]), [])
check("select '02' and plan 2 (zero-padded) -> no write",
      calls(drive(plan_state="full", amps=2, have="02", saved="40.0")[0]), [])
check("full -> the 2 A trickle goes out as '02' (keeps its zero)",
      options(drive(plan_state="full", amps=2, have="30", saved="40.0")[0]), ["02"])
check("10 A -> '10'", options(drive(amps=10, have="30", saved="40.0")[0]), ["10"])
check("current attribute as a string '30' -> treated as 30",
      calls(drive(amps="30", have="30")[0]), [])
check("charging but no current -> nothing", calls(drive(amps=None)[0]), [])
check("charging with current 'unknown' -> nothing", calls(drive(amps="unknown")[0]), [])

print("drive: the hand-back")
for st in ("day", "off", "inactive"):
    runs, h = drive(plan_state=st, amps=None, have="30", saved="40.0")
    check("%s, saved 40 -> select back to 40, saved cleared" % st,
          calls(runs), [("select.select_option", SELECT, {"option": 40}),
                        ("input_number.set_value", SAVED, {"value": 0})])
check("... saved now reads 0.0", h.state(SAVED), "0.0")
check("day, saved 40, select already 40 -> only saved cleared",
      calls(drive(plan_state="day", amps=None, have="40", saved="40.0")[0]),
      [("input_number.set_value", SAVED, {"value": 0})])
check("day, nothing saved -> nothing",
      calls(drive(plan_state="day", amps=None, have="30", saved="0.0")[0]), [])
check("day, saved 5 -> restored as '05'",
      options(drive(plan_state="day", amps=None, have="30", saved="5.0")[0]), ["05"])
check("day, saved 'unknown' (helper not restored) -> nothing",
      calls(drive(plan_state="day", amps=None, have="30", saved="unknown")[0]), [])
check("unknown (no battery reading), saved 40 -> nothing, saved kept",
      calls(drive(plan_state="unknown", amps=None, have="30", saved="40.0")[0]), [])
check("plan sensor unavailable, saved 40 -> nothing",
      calls(drive(plan_state="unavailable", amps=None, have="30", saved="40.0")[0]), [])

print("drive: a running pre-charge holds every write")
OFF_SAVED = dict(plan_state="off", amps=None, have="60", saved="40.0")
check("pre-charge plan charging -> held",
      drive(pre="charging", **OFF_SAVED)[0][0].stopped, "condition")
check("... nothing written", calls(drive(pre="charging", **OFF_SAVED)[0]), [])
check("deadline ahead, switch on -> held",
      calls(drive(until=utc_iso(at(3, "02:00")), **OFF_SAVED)[0]), [])
check("deadline 5 min past -> still held (the ESP's 5-min tick)",
      calls(drive(until=utc_iso(NIGHT - timedelta(minutes=5)), **OFF_SAVED)[0]), [])
check("deadline 5 min 59 s past -> still held",
      calls(drive(until=utc_iso(NIGHT - timedelta(seconds=359)), **OFF_SAVED)[0]), [])
check("deadline exactly 6 min past -> released",
      options(drive(until=utc_iso(NIGHT - timedelta(minutes=6)), **OFF_SAVED)[0]), ["40"])
check("deadline 7 min past -> released, user's 40 back",
      options(drive(until=utc_iso(NIGHT - timedelta(minutes=7)), **OFF_SAVED)[0]), ["40"])
check("release value 2000-01-01 -> released",
      options(drive(**OFF_SAVED)[0]), ["40"])
check("deadline ahead but pre-charge switched off -> released",
      options(drive(pre_on="off", until=utc_iso(at(3, "02:00")), **OFF_SAVED)[0]), ["40"])
check("deadline 'unavailable' (ESP offline) -> released",
      options(drive(until="unavailable", **OFF_SAVED)[0]), ["40"])
check("deadline written naive-local by hand '2026-11-03 02:00:00' -> held",
      calls(drive(until="2026-11-03 02:00:00", **OFF_SAVED)[0]), [])
check("pre-charge waiting_night with the deadline released -> not held",
      options(drive(pre="waiting_night", **OFF_SAVED)[0]), ["40"])

print("drive: gate and triggers")
for bad in ("unavailable", "unknown"):
    check("select %s -> the automation does not run" % bad,
          drive(have=bad)[0], [])
h = drive_house(have="30")
sim = Simulator(h, [DRIVE])
check("23:03 is not a 5-minute tick", sim.fire(TimeTick(at(2, "23:03"))), [])
check("23:05:30 is not either (seconds default to 0)",
      sim.fire(TimeTick(at(2, "23:05") + timedelta(seconds=30))), [])
check("23:05:00 is", len(sim.fire(TimeTick(at(2, "23:05")))), 1)
check("HA start runs it", len(sim.fire(START)), 1)
runs = sim.fire(h.change(PLAN, current=20))
check("current-only change -> both state triggers fire (2 queued runs)", len(runs), 2)
check("... and only the first writes", options(runs), ["20"])
check("a pre-charge plan change runs it", len(sim.fire(h.change(PRECHARGE, "off"))), 1)
check("an unrelated entity does not", sim.fire(h.change(CAP, "150")), [])

print("drive: condition at trigger time, step condition at run time")
h = drive_house(**OFF_SAVED)
sim = Simulator(h, [DRIVE])
sim.fire(TimeTick(h.now), run=False)
h.change(PRECHARGE, "charging")   # a pre-charge starts while the run is queued
runs = sim.drain()
check("queued run reads the hold when it starts -> held", calls(runs), [])
h = drive_house(**OFF_SAVED)
sim = Simulator(h, [DRIVE])
sim.fire(TimeTick(h.now), run=False)
h.change(SELECT, "unavailable")   # the gate was passed at trigger time
check("select goes unavailable after the trigger -> the run still goes",
      options(sim.drain()), ["40"])

print("drive: a whole night")
h = drive_house(plan_state="day", amps=None, have="40", now=at(2, "22:55"))
sim = Simulator(h, [DRIVE])
check("22:55 day, nothing saved -> nothing", calls(sim.fire(TimeTick(h.now))), [])
h.now = NIGHT
check("23:00 charging 30 -> saves 40, writes 30",
      calls(sim.fire(h.change(PLAN, "charging", current=30)))[-1][2], {"option": 30})
h.now = at(3, "02:00")
sim.fire(h.change(PLAN, current=20))
check("02:00 re-sized to 20", (h.state(SELECT), h.state(SAVED)), ("20", "40.0"))
h.now = at(3, "04:00")
sim.fire(h.change(PLAN, "full", current=2))
check("04:00 full -> trickle '02', saved still 40", (h.state(SELECT), h.state(SAVED)), ("02", "40.0"))
h.now = at(3, "07:00")
sim.fire(h.change(PLAN, "day", current=None))
check("07:00 day -> 40 back, saved 0", (h.state(SELECT), h.state(SAVED)), ("40", "0.0"))

print("drive: hand-back deferred past a pre-charge")
h = drive_house(pre="charging", until=utc_iso(at(3, "02:00")), **OFF_SAVED)
sim = Simulator(h, [DRIVE])
check("off while pre-charge charges -> held", calls(sim.fire(TimeTick(h.now))), [])
h.now = at(3, "02:00")
h.change(PRECHARGE_UNTIL, RELEASED_STATE)
runs = sim.fire(h.change(PRECHARGE, "idle"))
check("pre-charge ends (plan idle, deadline released) -> 40 back at once",
      options(runs), ["40"])

print("outage_off")


def outage_house(adaptive="on", pre="idle", until=None):
    h = House(at(2, "14:00"))
    h.set(ENABLED, adaptive)
    h.set(PRECHARGE, pre, until=until)
    return h


def notes(runs):
    return [c.data for r in runs for c in r.notifications]


h = outage_house()
sim = Simulator(h, [OUTAGE_OFF])
runs = sim.fire(h.change(PRECHARGE, "waiting_night", until="2026-11-03T10:00:00+02:00"))
check("idle -> waiting_night: adaptive off", h.state(ENABLED), "off")
check("... and one notification with the window's local time",
      [n["message"].split(", so")[0] for n in notes(runs)],
      ["DTEK scheduled an outage at 03.11 10:00"])
check("... title and channel",
      [(n["title"], n["data"]) for n in notes(runs)],
      [("\U0001f50b Adaptive night charge off", {"channel": "Adaptive charge"})])
h = outage_house()
runs = Simulator(h, [OUTAGE_OFF]).fire(
    h.change(PRECHARGE, "charging", until="2026-11-03T08:00:00+00:00"))
check("until given in UTC -> shown in Kyiv time (10:00)",
      "03.11 10:00" in notes(runs)[0]["message"], True)
h = outage_house()
runs = Simulator(h, [OUTAGE_OFF]).fire(h.change(PRECHARGE, "full", until=None))
check("to full, until missing -> 'soon'", "outage at soon," in notes(runs)[0]["message"], True)
h = outage_house(adaptive="off")
check("already off -> nothing",
      Simulator(h, [OUTAGE_OFF]).fire(h.change(PRECHARGE, "charging")), [])
for to in ("idle", "off", "unavailable", "unknown"):
    h = outage_house(pre="charging")
    check("charging -> %s does not trigger" % to,
          Simulator(h, [OUTAGE_OFF]).fire(h.change(PRECHARGE, to)), [])
h = outage_house(pre="charging", until="2026-11-03T10:00:00+02:00")
check("attribute-only change while charging does not trigger",
      Simulator(h, [OUTAGE_OFF]).fire(h.change(PRECHARGE, current=40)), [])
h = outage_house(pre="waiting_night", until="2026-11-03T10:00:00+02:00")
runs = Simulator(h, [OUTAGE_OFF]).fire(h.change(PRECHARGE, "charging"))
check("waiting_night -> charging with adaptive on again -> off again",
      (h.state(ENABLED), len(notes(runs))), ("off", 1))
h = outage_house(pre="waiting_night", until="2026-11-03T10:00:00+02:00")
runs = Simulator(h, [OUTAGE_OFF]).fire(START)
check("HA start with a window pending -> off + notify",
      (h.state(ENABLED), len(notes(runs))), ("off", 1))
h = outage_house(pre="idle")
check("HA start with no window -> nothing", Simulator(h, [OUTAGE_OFF]).fire(START), [])
h = outage_house(pre="unavailable")
check("HA start with the plan unavailable -> nothing",
      Simulator(h, [OUTAGE_OFF]).fire(START), [])

print("guard")


def guard_house(auto="on", night_only="off", charger="on", pre="idle", adaptive="off"):
    h = House(at(2, "14:00"))
    h.set(ENABLED, adaptive)
    h.set(AUTO, auto)
    h.set(NIGHT_ONLY, night_only)
    h.set(CHARGER, charger)
    h.set(PRECHARGE, pre)
    return h


def switch_on(**kw):
    """Switch adaptive on; what is it afterwards?"""
    h = guard_house(**kw)
    Simulator(h, [GUARD]).fire(h.change(ENABLED, "on"))
    return h.state(ENABLED)


check("Auto on, charger on -> stays on", switch_on(), "on")
check("Night only on, Auto off -> stays on", switch_on(auto="off", night_only="on"), "on")
check("Auto and Night only both off -> refused", switch_on(auto="off"), "off")
check("Auto on but the charger off (Night only off) -> refused",
      switch_on(charger="off"), "off")
check("Night only on, charger off (the firmware's, by day) -> stays on",
      switch_on(auto="off", night_only="on", charger="off"), "on")
for pre in ("waiting_night", "charging", "full"):
    check("outage window pending (%s) -> refused, even with Auto on" % pre,
          switch_on(pre=pre), "off")
    check("... and even with Night only on (%s)" % pre,
          switch_on(night_only="on", pre=pre), "off")
for pre in ("idle", "off", "unavailable"):
    check("pre-charge %s -> not a pending window, stays on" % pre, switch_on(pre=pre), "on")
check("Auto 'unavailable' (ESP offline), Night only off -> not refused (not 'off')",
      switch_on(auto="unavailable"), "on")


def charger_change(old, new, **kw):
    h = guard_house(adaptive="on", charger=old, **kw)
    Simulator(h, [GUARD]).fire(h.change(CHARGER, new))
    return h.state(ENABLED)


check("charger on -> off by hand, Night only off -> adaptive off",
      charger_change("on", "off"), "off")
check("charger on -> off, Night only on (07:00 by design) -> adaptive stays",
      charger_change("on", "off", night_only="on"), "on")
check("charger unavailable -> off (ESP reconnect) -> not a trigger",
      charger_change("unavailable", "off"), "on")
check("charger on -> unavailable -> not a trigger",
      charger_change("on", "unavailable"), "on")
check("charger off -> on -> nothing", charger_change("off", "on"), "on")
h = guard_house(adaptive="off", charger="on")
check("charger on -> off with adaptive already off -> no run",
      Simulator(h, [GUARD]).fire(h.change(CHARGER, "off")), [])

print("DST nights (were known bugs, fixed 2026-10-02)")
# 2027-03-27 23:00 EET to 2027-03-28 06:30 EEST is 6.5 real hours.
check("spring-forward night: hours to 06:30 at 23:00 are 6.5",
          plan(KYIV_SPRING, 100)["hours_left"], 6.5)
check("... so 100 Ah needs 207 Ah / 6.5 h = 31.8 A -> 40 A",
          plan(KYIV_SPRING, 100)["current"], 40)
# 2026-10-24 23:00 EEST to 2026-10-25 06:30 EET is 8.5 real hours (safe side).
check("fall-back night: hours to 06:30 at 23:00 are 8.5",
          plan(KYIV_FALL, 100)["hours_left"], 8.5)

print()
if KNOWN:
    print("%d known bug(s) still present: %s" % (len(KNOWN), ", ".join(KNOWN)))
if FAILED:
    print("%d FAILED" % len(FAILED))
    sys.exit(1)
print("all passed")
