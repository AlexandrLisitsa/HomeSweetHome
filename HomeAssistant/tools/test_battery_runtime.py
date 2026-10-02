"""Render the battery time estimates in packages/battery_runtime.yaml against fake states.

    python HomeAssistant/tools/test_battery_runtime.py

Two template sensors -- hours until flat at the current draw, hours until
full at the current charge -- plus the two edge triggers that recompute them
the moment the pack starts discharging or charging. They are small, but the
Grid Outage alert quotes the runtime in the one moment it matters, so a
wrong sign or a missed guard is a wrong number on every phone. `ha core check`
only parses the Jinja; this renders the real text out of the package, with
the corner cases the header promises: idle and near-zero current, the sign
convention, unavailable BMS readings, a flat pack, a full one, and a pack
re-specified above 280 Ah.

A template that renders `None` is how the sensor publishes `unknown`; the
render here parses the result back into a native value as HA does, so that
reads as None.

Rendered with ha_automation_sim.py's HA environment (HA's is_number, which
rejects nan/inf, and HA's round).
"""
import sys
from datetime import datetime
from pathlib import Path

from ha_automation_sim import KYIV, House, load_package, render

PKG = (Path(__file__).resolve().parents[1] / "config" / "packages"
       / "battery_runtime.yaml")
CAP = "sensor.jkbms_gateway_bms_capacity_remaining"
CUR = "sensor.jkbms_gateway_bms_current"
NOW = datetime(2026, 11, 2, 14, 0, tzinfo=KYIV)
FAILED = []

BLOCK = load_package(PKG)["template"][0]
SENSORS = {s["unique_id"]: s for s in BLOCK["sensor"]}
RUNTIME = SENSORS["battery_runtime_remaining"]
TO_FULL = SENSORS["battery_time_to_full"]
EDGES = [t["value_template"] for t in BLOCK["trigger"] if t.get("platform") == "template"]


def house(cap, cur):
    h = House(NOW)
    for eid, v in ((CAP, cap), (CUR, cur)):
        if v is not None:
            h.set(eid, v)
    return h


def state(sensor, cap, cur):
    h = house(cap, cur)
    if not render(sensor["availability"], h):
        return "unavailable"
    return render(sensor["state"], h)


def runtime(cap, cur):
    return state(RUNTIME, cap, cur)


def to_full(cap, cur):
    return state(TO_FULL, cap, cur)


def edge(i, cur):
    return render(EDGES[i], house(140, cur))


def check(label, got, want):
    ok = got == want and type(got) is type(want)
    if not ok:
        FAILED.append(label)
    print("  %-4s %-62s %r%s" % ("ok" if ok else "FAIL", label, got,
                                 "" if ok else "  want %r" % (want,)))


print("the package")
check("two sensors, both 'h', both measurement",
      sorted((s["unique_id"], s["unit_of_measurement"], s["state_class"])
             for s in SENSORS.values()),
      [("battery_runtime_remaining", "h", "measurement"),
       ("battery_time_to_full", "h", "measurement")])
check("two edge triggers (discharge, charge)", len(EDGES), 2)

print("runtime remaining: discharging")
check("140 Ah at -10 A -> 14.0 h", runtime("140", "-10"), 14.0)
check("280 Ah at the median -6.5 A -> 43.1 h", runtime("280", "-6.5"), 43.1)
check("100 Ah at -3 A -> 33.3 h (rounded to 0.1)", runtime("100", "-3"), 33.3)
check("a compressor start, 140 Ah at -60 A -> 2.3 h", runtime("140", "-60"), 2.3)
check("140 Ah at -1.42 A -> 98.6 h, just under the clamp", runtime("140", "-1.42"), 98.6)
check("140 Ah at -1.414 A -> 99.0 h (the clamp)", runtime("140", "-1.414"), 99.0)
check("quiet night, 280 Ah at -0.5 A -> clamped to 99.0", runtime("280", "-0.5"), 99.0)
check("capacity above 280 (300 Ah) -> still divides, 30.0 h", runtime("300", "-10"), 30.0)
check("numeric strings with decimals -> fine", runtime("140.000", "-10.00"), 14.0)

print("runtime remaining: no answer")
check("idle, 0 A -> unknown", runtime("140", "0"), None)
check("-0.19 A (under the 0.2 A floor) -> unknown", runtime("140", "-0.19"), None)
check("-0.2 A exactly -> computed (floor is strict), clamped 99.0",
      runtime("140", "-0.2"), 99.0)
check("charging +10 A -> unknown, not a negative runtime", runtime("140", "10"), None)
check("flat pack, 0 Ah -> unknown", runtime("0", "-10"), None)
check("negative capacity reading -> unknown", runtime("-5", "-10"), None)
check("current unavailable -> unavailable", runtime("140", "unavailable"), "unavailable")
check("capacity unknown -> unavailable", runtime("unknown", "-10"), "unavailable")
check("capacity missing altogether -> unavailable", runtime(None, "-10"), "unavailable")
check("current 'nan' -> unavailable (HA's is_number)", runtime("140", "nan"), "unavailable")
check("capacity 'inf' -> unavailable", runtime("inf", "-10"), "unavailable")

print("time to full: charging")
check("140 Ah at +10 A -> 14.0 h", to_full("140", "10"), 14.0)
check("SOC 0, flat pack at +10 A -> 28.0 h (the most to do)", to_full("0", "10"), 28.0)
check("negative capacity -5 Ah at +10 A -> 28.5 h", to_full("-5", "10"), 28.5)
check("279.9 Ah at +0.5 A (taper) -> 0.2 h", to_full("279.9", "0.5"), 0.2)
check("140 Ah at +1 A -> clamped 99.0", to_full("140", "1"), 99.0)
check("+0.2 A exactly -> computed, clamped 99.0", to_full("140", "0.2"), 99.0)

print("time to full: no answer")
check("SOC 100, 280 Ah -> unknown (full is not zero hours)", to_full("280", "10"), None)
check("280.0 as a string with decimals -> unknown", to_full("280.000", "10"), None)
check("capacity above 280 (300 Ah) -> unknown, 'already full'", to_full("300", "10"), None)
check("discharging -10 A -> unknown", to_full("140", "-10"), None)
check("idle 0 A -> unknown", to_full("140", "0"), None)
check("+0.19 A float -> unknown", to_full("140", "0.19"), None)
check("current unavailable -> unavailable", to_full("140", "unavailable"), "unavailable")
check("capacity unavailable -> unavailable", to_full("unavailable", "10"), "unavailable")

print("only one of the two ever has a number")
for cur in ("-10", "-0.2", "0", "0.2", "10"):
    both = (runtime("140", cur), to_full("140", cur))
    check("at %s A: at most one is a number" % cur,
          sum(v is not None for v in both) <= 1, True)

print("edge triggers")
check("discharge edge: -0.21 A -> true", edge(0, "-0.21"), True)
check("discharge edge: -0.2 A -> false (strict)", edge(0, "-0.2"), False)
check("discharge edge: 0 A -> false", edge(0, "0"), False)
check("discharge edge: current unavailable -> false (float(0))", edge(0, "unavailable"), False)
check("charge edge: 0.21 A -> true", edge(1, "0.21"), True)
check("charge edge: 0.2 A -> false (strict)", edge(1, "0.2"), False)
check("charge edge: -10 A -> false", edge(1, "-10"), False)
check("charge edge: current unknown -> false", edge(1, "unknown"), False)

print("\n%s" % ("FAILED: " + ", ".join(FAILED) if FAILED else "all checks passed"))
sys.exit(1 if FAILED else 0)
