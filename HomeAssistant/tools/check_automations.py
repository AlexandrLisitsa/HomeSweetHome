"""Render and shape-check automations.yaml and the IR bridge package.

    python HomeAssistant/tools/check_automations.py

`ha core check` proves this YAML parses. It says nothing about whether an
alert survives a restart, whether two automations fight, or whether a
template picks the right branch -- and every one of those was wrong once
(2026-09-30 review). This pins the fixes:

  * the inverter tariff is set on every start, from the clock
  * the grid alert ignores reconnects and blips, and "restored" only follows it
  * battery-low ignores a reconnect and recovers with hysteresis
  * the leak alarm restarts after a restart and keeps one notification
  * the two kitchen helpers cannot both drive the relay
  * the IR phone charges below 21% on every path, and is re-checked
  * irbridge_send_candidate honours idx 0
  * the weekly MeterBots session check says why whenever it fails

Same approach as check_dtek_templates.py: just enough of HA's template
environment to render these templates, not an HA emulator.
"""
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import jinja2
import yaml

KYIV = ZoneInfo("Europe/Kyiv")
CONFIG = Path(__file__).resolve().parents[1] / "config"
FAILED = []


class HaLoader(yaml.SafeLoader):
    """SafeLoader that shrugs at !secret / !include instead of dying."""


HaLoader.add_multi_constructor("!", lambda loader, suffix, node: None)


def check(label, got, want):
    ok = got == want
    if not ok:
        FAILED.append(label)
    print("  %-4s %-58s %r%s" % ("ok" if ok else "FAIL", label, got,
                                 "" if ok else "  want %r" % (want,)))


def render(tpl, now=None, states=None, **context):
    env = jinja2.Environment(undefined=jinja2.StrictUndefined)
    states = states or {}
    env.globals.update(
        now=lambda: now,
        states=lambda e: str(states.get(e, "unknown")),
        is_state=lambda e, v: str(states.get(e, "unknown")) == v)
    env.filters["int"] = lambda v, d=0: int(float(v)) if str(v).replace(
        ".", "", 1).lstrip("-").isdigit() else d
    return env.from_string(tpl).render(**context).strip()


def by_alias(autos, fragment):
    hits = [a for a in autos if fragment in a["alias"]]
    assert len(hits) == 1, (fragment, [a["alias"] for a in hits])
    return hits[0]


def walk(node):
    """Every dict under a node, for structural searches."""
    if isinstance(node, dict):
        yield node
        for v in node.values():
            yield from walk(v)
    elif isinstance(node, list):
        for v in node:
            yield from walk(v)


autos = yaml.load((CONFIG / "automations.yaml").read_text(encoding="utf-8"), HaLoader)

print("\n0. automations.yaml")
check("ids are unique", len({a["id"] for a in autos}), len(autos))

# --- tariff ---------------------------------------------------------------
print("\n1. inverter tariff: set on start, from the clock")
tariff = by_alias(autos, "Auto Switch Day/Night")
check("has a homeassistant start trigger",
      any(t.get("trigger") == "homeassistant" and t.get("event") == "start"
          for t in tariff["triggers"]), True)
option = tariff["actions"][0]["data"]["option"]
for hour, want in ((0, "night"), (6, "night"), (7, "day"), (15, "day"),
                   (22, "day"), (23, "night")):
    check("%02d:05 -> %s" % (hour, want),
          render(option, now=datetime(2026, 9, 30, hour, 5, tzinfo=KYIV)), want)

# --- grid outage / restored --------------------------------------------------
print("\n2. grid outage: once per real outage")
outage = by_alias(autos, "Grid Outage")
trig = outage["triggers"][0]
check("state trigger on the grid sensor",
      (trig.get("trigger"), trig.get("entity_id")),
      ("state", "binary_sensor.powmr_inverter_grid_condition_safe"))
check("from off (a reconnect is not an outage)", trig.get("from"), "off")
check("to on (on = UNSAFE)", trig.get("to"), "on")
check("held 20 s (a blip is not an outage)", trig.get("for"), {"seconds": 20})
check("waits for the runtime figure first",
      "wait_template" in outage["actions"][0], True)

restored = by_alias(autos, "Power Restored")
cond = restored["conditions"][0]["value_template"]
t0 = datetime(2026, 9, 30, 12, 0, tzinfo=KYIV)
for secs, want in ((5, "False"), (19, "False"), (20, "True"), (3600, "True")):
    trigger = {"from_state": {"last_changed": t0},
               "to_state": {"last_changed": t0 + timedelta(seconds=secs)}}
    check("restored after a %ds outage -> %s" % (secs, want),
          render(cond, trigger=trigger), want)

# --- battery low -----------------------------------------------------------
print("\n3. battery low: crossings, not reconnects")
low = by_alias(autos, "Battery Low")
cond = low["conditions"][0]["value_template"]
for frm, want in (("30", "True"), ("unavailable", "False"), ("unknown", "False")):
    check("from %s -> %s" % (frm, want),
          render(cond, trigger={"from_state": {"state": frm}}), want)
recovered = by_alias(autos, "Battery Recovered")
check("recovers above 25, not at the alarm line",
      recovered["triggers"][0].get("above"), 25)

# --- water leak ------------------------------------------------------------
print("\n4. water leak: survives a restart, one notification")
leak = by_alias(autos, "Water Leak Detected")
kinds = sorted(t.get("trigger") for t in leak["triggers"])
check("wet edge + start + watchdog", kinds, ["homeassistant", "state", "time_pattern"])
check("all gated on the sensor being wet",
      leak["conditions"], [{"condition": "state",
                            "entity_id": "binary_sensor.0xa4c13898ee89fea1_water_leak",
                            "state": "on"}])
check("a running loop swallows the watchdog quietly",
      leak.get("max_exceeded"), "silent")
ids = {d.get("data", {}).get("notification_id") for d in walk(leak["actions"])
       if d.get("action") == "persistent_notification.create"}
check("one persistent notification, replaced not stacked", ids, {"water_leak"})
text = " ".join(str(d.get("data", {}).get("message", "")) for d in walk(leak["actions"]))
check("text matches the 1-minute loop", "every\n            minute" in text
      or "every minute" in text.replace("\n", " ").replace("  ", " "), True)
resolved = by_alias(autos, "Water Leak Resolved")
check("resolved dismisses it",
      any(d.get("action") == "persistent_notification.dismiss"
          for d in walk(resolved["actions"])), True)
offline = by_alias(autos, "Leak Sensor Offline")
check("offline alert after 10 min unavailable",
      (offline["triggers"][0]["to"], offline["triggers"][0]["for"]),
      ("unavailable", {"minutes": 10}))

# --- kitchen ---------------------------------------------------------------
print("\n5. kitchen: the helpers exclude each other")
for alias, mine, other in (("Force Light On", "kitchen_light_force_on", "kitchen_light_block"),
                           ("Block Light On", "kitchen_light_block", "kitchen_light_force_on")):
    a = by_alias(autos, alias)
    turned_off = [d["target"]["entity_id"] for d in walk(a["actions"])
                  if d.get("action") == "input_boolean.turn_off"]
    check("%s: switching on turns %s off" % (mine, other),
          turned_off, ["input_boolean." + other])
    gates = [d for d in a["actions"] if d.get("condition") == "state"]
    check("%s: drives the relay only while %s is off" % (mine, other),
          [(g["entity_id"], g["state"]) for g in gates],
          [("input_boolean." + other, "off")])

# --- IR blaster charging ---------------------------------------------------
print("\n6. IR blaster: charges below 21% on every path")
charge = by_alias(autos, "IR Blaster: Battery Safe Charge")
belows = sorted({d["below"] for d in walk(charge) if "below" in d})
check("one low threshold everywhere", belows, [21])
check("re-checked on start and hourly",
      sorted(t.get("trigger") for t in charge["triggers"] if t.get("id") == "recheck"),
      ["homeassistant", "time_pattern"])

# --- idx 0 -----------------------------------------------------------------
print("\n7. irbridge_send_candidate: idx 0 is a real index")
pkg = yaml.load((CONFIG / "packages" / "irbridge_package.yaml").read_text(encoding="utf-8"),
                HaLoader)
tpl = pkg["script"]["irbridge_send_candidate"]["sequence"][0]["data"]["idx"]
held = {"input_number.irbridge_candidate": "47.0"}
check("idx 0 is sent as 0", render(tpl, states=held, idx=0), "0")
check("idx 12 is sent as 12", render(tpl, states=held, idx=12), "12")
check("no idx -> the input_number", render(tpl, states=held), "47")
check("empty idx -> the input_number", render(tpl, states=held, idx=""), "47")

# --- MeterBots session -------------------------------------------------------
print("\n8. MeterBots session: weekly, and every failure says why")
pkg = yaml.load((CONFIG / "packages" / "meterbots_session.yaml").read_text(encoding="utf-8"),
                HaLoader)
auto = pkg["automation"][0]
check("Mondays at 12:00",
      (auto["trigger"][0]["at"], auto["condition"][0]["weekday"]), ("12:00:00", "mon"))
call, var_step, notify_step = auto["action"]
check("a MeterBots that is down does not stop the run", call.get("continue_on_error"), True)
ok_tpl, why_tpl = var_step["variables"]["ok"], var_step["variables"]["why"]
cases = [
    ("logged in", {"status": 200, "content": {"ok": True, "authorized": True}}, "True", ""),
    ("logged out", {"status": 200, "content": {"ok": False,
                                               "error": "Telegram session is not logged in"}},
     "False", "Telegram session is not logged in"),
    ("wrong token", {"status": 401, "content": {"error": "unauthorised"}}, "False", "unauthorised"),
    ("not JSON", {"status": 502, "content": "Bad Gateway"}, "False", "MeterBots answered 502"),
]
for label, sess, want_ok, want_why in cases:
    check("%s -> ok %s" % (label, want_ok), render(ok_tpl, sess=sess), want_ok)
    check("%s -> why" % label, render(why_tpl, sess=sess, ok=want_ok == "True"), want_why)
check("no answer at all -> not ok", render(ok_tpl), "False")
check("no answer at all -> why",
      render(why_tpl, ok=False), "MeterBots did not answer, or refused (see the HA log)")
check("only a failure notifies", notify_step["if"][0]["value_template"], "{{ not ok }}")

print("\n%s" % ("FAILED: " + ", ".join(FAILED) if FAILED else "all checks passed"))
sys.exit(1 if FAILED else 0)
