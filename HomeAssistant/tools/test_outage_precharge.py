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
"""
import ast
import sys
from datetime import datetime, timedelta
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

    env.globals.update(states=_states, is_state=lambda e, v: _states(e) == v,
                       now=lambda: now, as_datetime=_as_datetime,
                       timedelta=timedelta)
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

print("\n%s" % ("FAILED: " + ", ".join(FAILED) if FAILED else "all checks passed"))
sys.exit(1 if FAILED else 0)
