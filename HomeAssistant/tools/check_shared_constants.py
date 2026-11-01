"""The numbers that live in more than one place, checked against their source.

    python HomeAssistant/tools/check_shared_constants.py

Three facts about the power station are written down in several files, and
nothing but this keeps them equal:

  * the night tariff, 23:00-07:00. The source is the firmware's substitutions
    (`night_tariff_start` / `night_tariff_end` in PowerStation/power-station.yaml),
    since the firmware is what actually opens the charger at night. Home
    Assistant repeats the hours in its tariff automations, the two charge
    plans, the A/C tariff zones and a card's help text.
  * the pack, 280 Ah. The source is packages/battery_runtime.yaml, which
    says why it is written down rather than derived. The two charge plans and
    the battery card repeat it.
  * the charge-current steps. The source is the firmware's Max AC Charge
    Current select. The plans may only ask for a step the select offers --
    an option that does not exist is simply not set.

Change one and this fails until every copy follows. Plain regexes over the
files: the YAML carries !secret and !lambda tags and the templates are text,
so a parser would only get in the way. Exit 0 or 1, like the other checks.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FAILED = []


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


def check(label, got, want):
    ok = got == want
    if not ok:
        FAILED.append(label)
    print("  %-4s %-62s %r%s" % ("ok" if ok else "FAIL", label, got, "" if ok else "  want %r" % (want,)))


def one(pattern, text, label):
    m = re.findall(pattern, text)
    if len(m) != 1:
        FAILED.append(label)
        print("  FAIL %-62s found %d matches for %s" % (label, len(m), pattern))
        return None
    return m[0]


# --- the sources ------------------------------------------------------------------
ps = read("PowerStation/power-station.yaml")
start = int(one(r'night_tariff_start:\s*"(\d+)"', ps, "firmware night start"))
end = int(one(r'night_tariff_end:\s*"(\d+)"', ps, "firmware night end"))
sel = re.search(r'id: select_max_charge[\s\S]*?options:\s*\[([^\]]*)\]', ps)
options = sorted(int(o.strip().strip('"')) for o in sel.group(1).split(",")) if sel else []
rt = read("HomeAssistant/config/packages/battery_runtime.yaml")
pack = float(one(r"\{% set full = ([\d.]+) %\}", rt, "battery_runtime pack size"))
print("source: night %02d:00-%02d:00 (firmware), pack %.1f Ah (battery_runtime), steps %s (firmware select)"
      % (start, end, pack, options))
hh = lambda h: "%02d:00:00" % h  # noqa: E731

print("\nthe night tariff")
for rel in ("HomeAssistant/config/packages/adaptive_charge.yaml",
            "HomeAssistant/config/packages/outage_precharge.yaml"):
    t = read(rel)
    name = rel.rsplit("/", 1)[1]
    check(name + ": night_start / night_end",
          (int(one(r"set night_start = (\d+)", t, name)), int(one(r"set night_end = (\d+)", t, name))),
          (start, end))
for rel in ("HomeAssistant/config/packages/ac_tariffs.yaml",
            "HomeAssistant/config/packages/electricity_meter.yaml"):
    t = read(rel)
    name = rel.rsplit("/", 1)[1]
    hours = re.findall(r"now\(\)\.hour >= (\d+) or now\(\)\.hour < (\d+)", t)
    check(name + ": every zone template's hours", sorted(set(hours)), [(str(start), str(end))])
for rel in ("HomeAssistant/config/automations.yaml",
            "HomeAssistant/config/packages/ac_tariffs.yaml",
            "HomeAssistant/config/packages/electricity_meter.yaml"):
    t = read(rel)
    name = rel.rsplit("/", 1)[1]
    ats = sorted(set(re.findall(r"""at:\s*['"]?(\d\d:\d\d:\d\d)""", t)))
    check(name + ": triggers at both boundaries", {hh(end), hh(start)} <= set(ats), True)
card = read("HomeAssistant/config/www/climate-console-card.js")
check("climate card help text names the window",
      "%02d:00–%02d:00 is night" % (start, end) in card, True)

print("\nthe pack")
for rel in ("HomeAssistant/config/packages/adaptive_charge.yaml",
            "HomeAssistant/config/packages/outage_precharge.yaml"):
    name = rel.rsplit("/", 1)[1]
    check(name + ": full_ah", float(one(r"set full_ah = ([\d.]+)", read(rel), name)), pack)
check("jkbms card: pack_capacity_ah",
      float(one(r"pack_capacity_ah: ([\d.]+),", read("HomeAssistant/config/www/jkbms-battery-console-card.js"), "jkbms card")),
      pack)

print("\nthe charge-current steps")
check("the firmware select has options", bool(options), True)
ad = read("HomeAssistant/config/packages/adaptive_charge.yaml")
steps = [int(x) for x in one(r"set steps = \[([^\]]*)\]", ad, "adaptive steps").split(",")]
check("adaptive: exactly the select's options", steps, options)
check("adaptive: max_a is the top step", int(one(r"set max_a = (\d+)", ad, "adaptive max_a")), max(options))
op = read("HomeAssistant/config/packages/outage_precharge.yaml")
steps = [int(x) for x in one(r"set steps = \[([^\]]*)\]", op, "pre-charge steps").split(",")]
check("pre-charge: the select's options without the 2 A trickle", steps, [o for o in options if o != 2])
check("pre-charge: max_a is the top step", int(one(r"set max_a = (\d+)", op, "pre-charge max_a")), max(options))

print("\n%s" % ("FAILED: " + ", ".join(FAILED) if FAILED else "all checks passed"))
sys.exit(1 if FAILED else 0)
