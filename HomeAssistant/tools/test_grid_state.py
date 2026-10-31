"""Render the grid sensors in packages/grid_state.yaml against fake states.

    python HomeAssistant/tools/test_grid_state.py

grid_down (no mains, under 150 V) and house_on_battery (no mains, or out of
range with grid protection on). Every outage alert, load shedding and the
dashboards read these, so the case that started it is pinned here: a low but
live grid with protection off is neither down nor on battery.

Rendered with ha_automation_sim.py's HA environment.
"""
import sys
from datetime import datetime
from pathlib import Path

from ha_automation_sim import KYIV, House, load_package, render

PKG = (Path(__file__).resolve().parents[1] / "config" / "packages"
       / "grid_state.yaml")
VOLT = "sensor.powmr_inverter_grid_voltage"
UNSAFE = "binary_sensor.powmr_inverter_grid_condition_safe"
PROTECT = "switch.powmr_inverter_auto_grid_protection"
DOWN = "binary_sensor.grid_down"
NOW = datetime(2026, 10, 31, 16, 0, tzinfo=KYIV)
FAILED = []

SENSORS = {s["unique_id"]: s for s in load_package(PKG)["template"][0]["binary_sensor"]}
GRID_DOWN = SENSORS["grid_down"]
ON_BATTERY = SENSORS["house_on_battery"]


def state(sensor, **states):
    h = House(NOW)
    for eid, v in states.items():
        h.set(eid, v)
    if not render(sensor["availability"], h):
        return "unavailable"
    return render(sensor["state"], h)


def down(volts):
    return state(GRID_DOWN, **{VOLT: volts})


def on_battery(grid_down, unsafe, protect):
    return state(ON_BATTERY, **{DOWN: grid_down, UNSAFE: unsafe, PROTECT: protect})


def check(label, got, want):
    ok = got == want and type(got) is type(want)
    if not ok:
        FAILED.append(label)
    print("  %-4s %-62s %r%s" % ("ok" if ok else "FAIL", label, got,
                                 "" if ok else "  want %r" % (want,)))


print("the package")
check("two binary sensors", sorted(SENSORS), ["grid_down", "house_on_battery"])
check("grid_down held 5 s on", GRID_DOWN.get("delay_on"), {"seconds": 5})
check("grid_down turns off at once", "delay_off" in GRID_DOWN, False)

print("grid_down")
check("outage, 0 V -> on", down("0"), True)
check("outage noise, 3.2 V -> on", down("3.2"), True)
check("149.9 V -> on", down("149.9"), True)
check("150 V -> off (strict)", down("150"), False)
check("31 Oct: 179.9 V, low but live -> off", down("179.9"), False)
check("186.3 V -> off", down("186.3"), False)
check("230 V -> off", down("230"), False)
check("voltage unknown (dead link) -> unavailable", down("unknown"), "unavailable")
check("voltage unavailable -> unavailable", down("unavailable"), "unavailable")
check("voltage 'nan' -> unavailable", down("nan"), "unavailable")

print("house_on_battery")
check("31 Oct: low grid, unsafe, protection off -> off",
      on_battery("off", "on", "off"), False)
check("low grid, unsafe, protection on -> on (forced SBU)",
      on_battery("off", "on", "on"), True)
check("outage, protection off -> on", on_battery("on", "on", "off"), True)
check("outage, protection on -> on", on_battery("on", "on", "on"), True)
check("healthy grid, protection on -> off", on_battery("off", "off", "on"), False)
check("healthy grid, protection off -> off", on_battery("off", "off", "off"), False)
check("quality sensor unavailable, not down -> off",
      on_battery("off", "unavailable", "on"), False)
check("grid_down unavailable -> unavailable",
      on_battery("unavailable", "on", "on"), "unavailable")

print("\n%s" % ("FAILED: " + ", ".join(FAILED) if FAILED else "all checks passed"))
sys.exit(1 if FAILED else 0)
