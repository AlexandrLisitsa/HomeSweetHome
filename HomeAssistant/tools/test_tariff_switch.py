"""Run the day/night tariff switches against a fake clock.

    python HomeAssistant/tools/test_tariff_switch.py

Two automations book a grid counter to the day or night zone at 07:00 and
23:00, and again on every Home Assistant start:

  'Tariff: Auto Switch Day/Night' (config/automations.yaml), the inverter's
      counter, select.grid_real_tariff;
  'Electricity meter: switch the tariff meter day/night'
      (config/packages/electricity_meter.yaml), the meter's,
      select.electricity_meter_tariff.

The zone comes from the clock, not from which trigger fired, so a restart
across a boundary still lands on the right one. A wrong boundary books a whole
night at day rates.

This runs each automation through ha_automation_sim.py at the boundaries:
which moments trigger it, and what each run writes to its select. It also
guards the YAML itself: an unquoted `23:00:00` is a YAML 1.1 sexagesimal
integer (82800), not a time.
"""
import sys
from datetime import datetime, timedelta
from pathlib import Path

from ha_automation_sim import KYIV, START, House, Simulator, TimeTick, find, load_package

CONFIG = Path(__file__).resolve().parents[1] / "config"
SWITCHES = [
    ("inverter", find(load_package(CONFIG / "automations.yaml"), "alias",
                      "Tariff: Auto Switch Day/Night"),
     "select.grid_real_tariff"),
    ("meter", find(load_package(CONFIG / "packages" / "electricity_meter.yaml")["automation"],
                   "id", "electricity_meter_tariff_switch"),
     "select.electricity_meter_tariff"),
    # The same automation also switches the lifetime T1/T2 split.
    ("meter T1/T2", find(load_package(CONFIG / "packages" / "electricity_meter.yaml")["automation"],
                         "id", "electricity_meter_tariff_switch"),
     "select.electricity_meter_register"),
]
FAILED = []


PREFIX = [""]


def check(label, got, want):
    label = PREFIX[0] + label
    ok = got == want
    if not ok:
        FAILED.append(label)
    print("  %-4s %-62s %r%s" % ("ok" if ok else "FAIL", label, got,
                                 "" if ok else "  want %r" % (want,)))


def at(day, hhmmss, month=11, year=2026, fold=0):
    h, m, *s = map(int, hhmmss.split(":"))
    return datetime(year, month, day, h, m, s[0] if s else 0, tzinfo=KYIV, fold=fold)


CURRENT = [None, None]


def suite(TARIFF, SELECT):
    CURRENT[:] = [TARIFF, SELECT]

    def fire(now, event=None, before="night"):
        TARIFF, SELECT = CURRENT
        """What the select reads after `event` (default: the clock tick) at `now`."""
        h = House(now)
        h.set(SELECT, before)
        runs = Simulator(h, [TARIFF]).fire(event or TimeTick(now))
        return len(runs), h.state(SELECT)


    print("the YAML")
    check("the trigger times load as strings, not sexagesimal ints",
          [t["at"] for t in TARIFF["triggers"] if t["trigger"] == "time"],
          ["07:00:00", "23:00:00"])
    check("mode single", TARIFF["mode"], "single")

    print("the clock triggers")
    check("07:00:00 -> runs, day", fire(at(2, "07:00:00"), before="night"), (1, "day"))
    check("23:00:00 -> runs, night", fire(at(2, "23:00:00"), before="day"), (1, "night"))
    check("06:59:59 -> no run", fire(at(2, "06:59:59"), before="night"), (0, "night"))
    check("07:00:01 -> no run", fire(at(2, "07:00:01"), before="night"), (0, "night"))
    check("22:59:59 -> no run", fire(at(2, "22:59:59"), before="day"), (0, "day"))
    check("23:00:01 -> no run", fire(at(2, "23:00:01"), before="day"), (0, "day"))
    check("12:00:00 -> no run", fire(at(2, "12:00:00"), before="day"), (0, "day"))
    check("00:00:00 -> no run", fire(at(3, "00:00:00"), before="night"), (0, "night"))
    check("07:00 already day -> runs anyway, stays day (idempotent)",
          fire(at(2, "07:00:00"), before="day"), (1, "day"))

    print("HA start picks the zone from the clock")
    for hhmmss, zone in (("00:00:00", "night"), ("03:00:00", "night"), ("06:59:59", "night"),
                         ("07:00:00", "day"), ("12:00:00", "day"), ("22:59:59", "day"),
                         ("23:00:00", "night"), ("23:59:59", "night")):
        check("start at %s -> %s" % (hhmmss, zone),
              fire(at(2, hhmmss), START, before="day" if zone == "night" else "night"),
              (1, zone))
    check("start with the select unavailable -> written anyway",
          fire(at(2, "12:00:00"), START, before="unavailable"), (1, "day"))

    print("DST weekends (Europe/Kyiv)")
    check("spring forward: start at 04:00 EEST (just after the jump) -> night",
          fire(at(28, "04:00:00", month=3, year=2027), START, before="day"), (1, "night"))
    check("spring forward: 07:00 EEST still triggers -> day",
          fire(at(28, "07:00:00", month=3, year=2027)), (1, "day"))
    check("fall back: start at the second 03:30 (EET) -> night",
          fire(at(25, "03:30:00", month=10, fold=1), START, before="day"), (1, "night"))
    check("fall back: 07:00 EET triggers -> day",
          fire(at(25, "07:00:00", month=10)), (1, "day"))

    print("a whole day, minute by minute")
    h = House(at(2, "00:00:00"))
    h.set(SELECT, "night")
    sim = Simulator(h, [TARIFF])
    seen = []
    t = at(2, "00:00:00")
    while t < at(3, "00:00:00"):
        for r in sim.fire(h.tick(t)):
            seen.append((t.strftime("%H:%M"), h.state(SELECT)))
        t += timedelta(minutes=1)
    check("two runs: 07:00 day, 23:00 night", seen, [("07:00", "day"), ("23:00", "night")])


for name, automation, select in SWITCHES:
    PREFIX[0] = name + ": "
    print("\n=== %s (%s)" % (name, select))
    suite(automation, select)

print("\n%s" % ("FAILED: " + ", ".join(FAILED) if FAILED else "all checks passed"))
sys.exit(1 if FAILED else 0)
