"""Render the load-shedding engine in packages/load_shedding.yaml against fake states.

    python HomeAssistant/tools/test_load_shedding.py

The rules are data built on the dashboard; this package is the engine that
carries them out, in Jinja. `ha core check` only parses that Jinja, and an
outage is not something to wait for: a branch that is wrong either changes a
device on a sunny afternoon with the grid up, or lets the pack run flat with
everything on. This renders the real template text, out of the package, for
every rule the header promises:

  * the decision (load_shedding_evaluate): which devices are due at which
    step, and which have been overridden
  * the rules validator (script.load_shedding_save_config)
  * load_shed_apply's snapshot, service resolution and "turns off" test
  * both stores, and the restore list

Same approach as test_outage_precharge.py.
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
       / "load_shedding.yaml")
NOW = datetime(2026, 11, 2, 14, 0, tzinfo=KYIV)
FAILED = []


class HaLoader(yaml.SafeLoader):
    """SafeLoader that shrugs at !secret / !include instead of dying."""


HaLoader.add_multi_constructor("!", lambda loader, suffix, node: None)

PACKAGE = yaml.load(PKG.read_text(encoding="utf-8"), Loader=HaLoader)


def automation(aid):
    return next(a for a in PACKAGE["automation"] if a["id"] == aid)


def script_vars(name, i):
    return PACKAGE["script"][name]["sequence"][i]["variables"]


DECISION = automation("load_shedding_evaluate")["action"][0]["variables"]["decision"]
RESTORE = automation("load_shedding_restore")["action"][0]["variables"]
STORE = PACKAGE["template"][1]["action"][0]["variables"]["loads"]
VALIDATE = script_vars("load_shedding_save_config", 0)["errors"]
APPLY0 = script_vars("load_shed_apply", 0)
APPLY2 = script_vars("load_shed_apply", 2)
APPLY4 = script_vars("load_shed_apply", 4)
SEED = PACKAGE["script"]["load_shedding_seed"]["sequence"][0]["data"]["config"]


def is_number(value):
    if isinstance(value, bool):
        return False
    try:
        float(value)
    except (TypeError, ValueError):
        return False
    return True


def render(tpl, states=None, attrs=None, **variables):
    states = states or {}
    attrs = attrs or {}
    env = ImmutableSandboxedEnvironment()

    def _states(eid):
        return str(states.get(eid, "unknown"))

    def _as_datetime(value):
        try:
            return datetime.fromisoformat(str(value))
        except (TypeError, ValueError):
            return None

    env.globals.update(states=_states, is_state=lambda e, v: _states(e) == v,
                       state_attr=lambda e, a: attrs.get((e, a)),
                       now=lambda: NOW, as_datetime=_as_datetime)
    env.filters["is_number"] = is_number
    env.tests["is_number"] = is_number
    out = env.from_string(tpl).render(**variables).strip()
    # HA parses a rendered variable back into a native value the same way.
    try:
        return ast.literal_eval(out)
    except (ValueError, SyntaxError):
        return out


def check(label, got, want):
    ok = got == want
    if not ok:
        FAILED.append(label)
    print("  %-4s %-64s %r%s" % ("ok" if ok else "FAIL", label, got,
                                 "" if ok else "  want %r" % (want,)))


# --- a house to test against ------------------------------------------------

AC = "climate.daewoo_a_c"
LED = "light.0xa4c1385443844c1e"
PLUG = "switch.0x70b3d52b600fddcb"
RUN = "binary_sensor.a_c_running"


def ac_dev(steps=((80, "climate.set_temperature", {"temperature": 27}),
                  (60, "climate.set_hvac_mode", {"hvac_mode": "off"})), enabled=True):
    return {"id": "ac", "name": "Hall A/C", "entity": AC, "enabled": enabled,
            "guard": {"plug": PLUG, "running": RUN},
            "steps": [{"soc": s, "action": a, "data": d} for s, a, d in steps]}


def led_dev(enabled=True):
    return {"id": "led", "name": "LED", "entity": LED, "enabled": enabled,
            "steps": [{"soc": 70, "action": "light.turn_on", "data": {"brightness_pct": 30}},
                      {"soc": 40, "action": "light.turn_off", "data": {}}]}


def decide(soc=70, devices=None, shed=None, grid_bad=True, master=True,
           ac="cool", ac_temp=24, running="on", plug="on", led="on", led_b=255, ostep=10,
           margin=1):
    states = {
        "sensor.jkbms_gateway_bms_state_of_charge": soc,
        "binary_sensor.powmr_inverter_grid_condition_safe": "on" if grid_bad else "off",
        "input_boolean.load_shedding_enabled": "on" if master else "off",
        AC: ac, RUN: running, PLUG: plug, LED: led,
    }
    attrs = {
        ("sensor.load_shedding_config", "devices"): [ac_dev(), led_dev()] if devices is None else devices,
        ("sensor.load_shedding_config", "override_step"): ostep,
        ("sensor.load_shedding_config", "warn_margin"): margin,
        ("sensor.load_shedding", "loads"): shed or {},
        (AC, "temperature"): ac_temp,
        (LED, "brightness"): led_b if led == "on" else None,
    }
    return render(DECISION, states, attrs)


def due(**kw):
    return decide(**kw)["due"]


def over(**kw):
    return decide(**kw)["overridden"]


def rec(step_soc, minutes_ago=10, applied=None, override_soc=None, plug_cut=False):
    return {"entity": AC, "name": "x", "since": (NOW - timedelta(minutes=minutes_ago)).isoformat(),
            "soc": step_soc, "step_soc": float(step_soc), "snapshot": {"state": "cool", "temperature": 24},
            "applied": applied, "plug": PLUG if plug_cut else None, "plug_cut": plug_cut,
            "override_soc": override_soc}


AC_APPLIED = {"state": "cool", "temperature": 27}

print("the gate")
check("grid up -> nothing, whatever the battery", due(soc=10, grid_bad=False), [])
check("master switch off -> nothing", due(soc=10, master=False), [])
check("no battery reading -> nothing", due(soc="unavailable"), [])

print("which step")
check("85% -> nothing reached", due(soc=85), [])
check("78% -> A/C step 80, LED nothing yet", due(soc=78), [{"id": "ac", "soc": 80.0}])
check("65% -> A/C still 80, LED its 70 step", due(soc=65),
      [{"id": "ac", "soc": 80.0}, {"id": "led", "soc": 70.0}])
check("55% -> A/C straight to its deepest reached, 60", due(soc=55)[0], {"id": "ac", "soc": 60.0})
check("steps listed out of order still pick the deepest",
      due(soc=55, devices=[ac_dev(steps=((60, "climate.set_hvac_mode", {"hvac_mode": "off"}),
                                         (80, "climate.set_temperature", {"temperature": 27})))]),
      [{"id": "ac", "soc": 60.0}])
check("order: the device with the higher first step goes first",
      [d["id"] for d in due(soc=30)], ["ac", "led"])
check("disabled device -> skipped", due(soc=30, devices=[ac_dev(enabled=False), led_dev()]),
      [{"id": "led", "soc": 40.0}])
check("device with no steps -> skipped",
      due(soc=30, devices=[{"id": "x", "name": "x", "entity": LED, "steps": []}]), [])

print("devices that are off")
check("A/C off and not running -> left alone", due(soc=78, ac="off", running="off"), [])
check("A/C 'off' but its guard says running (IR missed) -> still due",
      due(soc=78, ac="off", running="on"), [{"id": "ac", "soc": 80.0}])
check("LED off -> left alone", [d for d in due(soc=30, led="off") if d["id"] == "led"], [])

print("already stepped")
check("at step 80, still 75% -> nothing",
      due(soc=75, ac_temp=27, shed={"ac": rec(80, applied=AC_APPLIED)}), [])
check("at step 80, now 58% -> the deeper step 60",
      due(soc=58, ac_temp=27, devices=[ac_dev()], shed={"ac": rec(80, applied=AC_APPLIED)}), [{"id": "ac", "soc": 60.0}])
check("at step 60 (off), plug cut and still off -> nothing, no override",
      {k: v for k, v in decide(soc=50, ac="unavailable", plug="off", devices=[ac_dev()],
                               shed={"ac": rec(60, plug_cut=True)}).items() if k != "warn"},
      {"due": [], "overridden": []})

print("overrides")
check("setpoint put back from 27 to 24, 10 min after -> overridden",
      over(soc=75, ac_temp=24, shed={"ac": rec(80, applied=AC_APPLIED)}), ["ac"])
check("...but 1 min after (still settling) -> not yet",
      over(soc=75, ac_temp=24, shed={"ac": rec(80, minutes_ago=1, applied=AC_APPLIED)}), [])
check("27.3 against 27 is inside the tolerance -> no override",
      over(soc=75, ac_temp=27.3, shed={"ac": rec(80, applied=AC_APPLIED)}), [])
check("no `applied` yet (inside the first 30 s) -> no override",
      over(soc=75, ac_temp=24, shed={"ac": rec(80, applied=None)}), [])
check("A/C switched back on after a step that turned it off -> overridden",
      over(soc=55, ac="cool", shed={"ac": rec(60, applied={"state": "off"})}), ["ac"])
check("plug switched back on after a plug cut -> overridden",
      over(soc=55, ac="cool", plug="on", shed={"ac": rec(60, plug_cut=True)}), ["ac"])
check("LED brightness within 3 of applied -> no override",
      over(soc=65, led_b=78, devices=[led_dev()],
           shed={"led": rec(70, applied={"state": "on", "brightness": 76})}), [])
check("LED raised to full -> overridden",
      over(soc=65, led_b=255, devices=[led_dev()],
           shed={"led": rec(70, applied={"state": "on", "brightness": 76})}), ["led"])
check("overridden at 78%, now 70% -> respected",
      due(soc=70, ac_temp=24, devices=[ac_dev()], shed={"ac": rec(80, applied=AC_APPLIED, override_soc=78)}), [])
check("overridden at 78%, now 68% -> deepest step reached again (80)",
      due(soc=68, ac_temp=24, devices=[ac_dev()], shed={"ac": rec(80, applied=AC_APPLIED, override_soc=78)}),
      [{"id": "ac", "soc": 80.0}])
check("overridden at 78%, now 55% -> straight to 60",
      due(soc=55, ac_temp=24, devices=[ac_dev()], shed={"ac": rec(80, applied=AC_APPLIED, override_soc=78)}),
      [{"id": "ac", "soc": 60.0}])
check("override step 20 -> 68% still respected",
      due(soc=68, ostep=20, ac_temp=24, devices=[ac_dev()], shed={"ac": rec(80, applied=AC_APPLIED, override_soc=78)}), [])

print("warnings, one step ahead")


def warn(**kw):
    return decide(devices=[ac_dev()], **kw)["warn"]


W60 = [{"id": "ac", "at": 60.0, "key": "ac@60.0"}]
check("step at 60, battery 61 -> warned", warn(soc=61, shed={"ac": rec(80, applied=AC_APPLIED)},
                                               ac_temp=27), W60)
check("battery 62 -> not yet", warn(soc=62, shed={"ac": rec(80, applied=AC_APPLIED)}, ac_temp=27), [])
check("battery 60 -> the step itself, no warning", warn(soc=60, shed={"ac": rec(80, applied=AC_APPLIED)},
                                                        ac_temp=27), [])
check("first step: battery 81 warns for 80",
      warn(soc=81), [{"id": "ac", "at": 80.0, "key": "ac@80.0"}])
check("margin 3 -> battery 63 warns for 60",
      warn(soc=63, margin=3, shed={"ac": rec(80, applied=AC_APPLIED)}, ac_temp=27), W60)
check("margin 0 -> never", warn(soc=61, margin=0, shed={"ac": rec(80, applied=AC_APPLIED)}, ac_temp=27), [])
check("device off -> no warning", warn(soc=81, ac="off", running="off"), [])
check("already at the deepest step -> nothing to warn about",
      warn(soc=55, shed={"ac": rec(60, applied={"state": "off"})}, ac="off", running="off"), [])
check("held at 78% (step 10) -> warned at 69 for 68",
      warn(soc=69, ac_temp=24, shed={"ac": rec(80, applied=AC_APPLIED, override_soc=78)}),
      [{"id": "ac", "at": 68.0, "key": "ac@68.0"}])

print("holds placed before any step")
HOLD = {"ac": dict(rec(80), step_soc=None, snapshot=None, override_soc=61)}
check("held at 61 before the 60 step -> not at 55", due(soc=55, devices=[ac_dev()], shed=HOLD), [])
check("...and at 51 (61 - 10) -> the deepest step reached, 60",
      due(soc=51, devices=[ac_dev()], shed=HOLD), [{"id": "ac", "soc": 60.0}])
check("a hold is not reported as an override", over(soc=55, devices=[ac_dev()], shed=HOLD), [])
check("a hold without a snapshot is not restored when the grid returns",
      render(RESTORE["back"], shed=HOLD), [])

print("the rules validator")


def errors(cfg):
    return render(VALIDATE, config=cfg)


GOOD = {"override_step": 10, "devices": [ac_dev(), led_dev()]}
check("the test rules are valid", errors(GOOD), [])
check("the seed rules are valid", errors(SEED), [])
check("not a config at all", errors("nope"), ["the config needs a list of devices"])
check("an action from another domain is refused",
      errors({"devices": [dict(led_dev(), steps=[{"soc": 50, "action": "switch.turn_off"}])]}),
      ["LED: step at 50% must be a light action"])
check("a step without a battery %",
      errors({"devices": [dict(led_dev(), steps=[{"action": "light.turn_off"}])]}),
      ["LED: step 1 needs a battery % of 1-100"])
check("two steps at the same %",
      errors({"devices": [dict(led_dev(), steps=[{"soc": 50, "action": "light.turn_off"},
                                                 {"soc": 50, "action": "light.turn_on"}])]}),
      ["LED: two steps at 50%"])
check("duplicate device ids", errors({"devices": [led_dev(), led_dev()]}), ["LED: duplicate id led"])
check("a device with no entity", errors({"devices": [{"id": "x", "name": "X"}]}),
      ["X: needs an id and an entity"])
check("override step out of range", errors({"override_step": 0, "devices": []}),
      ["override_step must be 1-50"])
check("warn margin out of range", errors({"warn_margin": 25, "devices": []}),
      ["warn_margin must be 0-20"])
check("adjust_temperature is a climate action, so it passes",
      errors({"devices": [ac_dev(steps=((80, "climate.adjust_temperature", {"by": 2}),))]}), [])

print("applying a step")


def snapshot(prev=None, temp=24, state="cool"):
    attrs = {(AC, "temperature"): temp, (AC, "fan_mode"): "low"}
    return render(APPLY2["snapshot"], {AC: state}, attrs, e=AC, prev=prev, keys=APPLY0["keys"])


check("snapshot takes the state and the attributes it has",
      snapshot(), {"state": "cool", "temperature": 24, "fan_mode": "low"})
check("a second step keeps the first step's snapshot",
      snapshot(prev={"snapshot": {"state": "cool", "temperature": 22}}, temp=27),
      {"state": "cool", "temperature": 22})


def resolve(action, data, snap_temp=24):
    step = {"action": action, "data": data}
    snap = {"state": "cool", "temperature": snap_temp}
    svc = render(APPLY4["service"], step=step)
    d = render(APPLY4["data"], step=step, snapshot=snap)
    off = render(APPLY4["turns_off"], service=svc, data=d)
    return svc, d, off


check("adjust_temperature +3 from 24 -> set_temperature 27",
      resolve("climate.adjust_temperature", {"by": 3}),
      ("climate.set_temperature", {"temperature": 27.0}, False))
check("hvac_mode off counts as switching off",
      resolve("climate.set_hvac_mode", {"hvac_mode": "off"})[2], True)
check("hvac_mode fan_only does not", resolve("climate.set_hvac_mode", {"hvac_mode": "fan_only"})[2], False)
check("light.turn_off counts as switching off", resolve("light.turn_off", {})[2], True)
check("a dim does not", resolve("light.turn_on", {"brightness_pct": 30})[2], False)

print("stores and restore")


def store(cur, **event):
    return render(STORE, attrs={("sensor.load_shedding", "loads"): cur},
                  trigger={"event": {"data": event}})


one = store(None, id="ac", value=rec(80))
check("set into an empty store", sorted(one), ["ac"])
two = store(one, id="led", value=rec(70))
check("a second id keeps the first", sorted(two), ["ac", "led"])
check("replacing an id replaces only it",
      store(two, id="ac", value=rec(60))["ac"]["step_soc"], 60.0)
check("a non-mapping value deletes the id", sorted(store(two, id="ac", value=None)), ["led"])
check("reset empties it", store(two, reset=True), {})
WARNED = PACKAGE["template"][1]["action"][0]["variables"]["warned"]


def warned(cur, **event):
    return render(WARNED, attrs={("sensor.load_shedding", "warned"): cur},
                  trigger={"event": {"data": event}})


check("a warning is remembered", warned(None, warned="ac@60.0"), ["ac@60.0"])
check("...once", warned(["ac@60.0"], warned="ac@60.0"), ["ac@60.0"])
check("a warning event leaves the loads alone", store(two, warned="ac@60.0"), two)
check("reset forgets the warnings", warned(["ac@60.0"], reset=True), [])

shed = {"ac": rec(80), "led": dict(rec(70), name="LED", override_soc=55)}
check("only what was not overridden comes back", render(RESTORE["back"], shed=shed), ["ac"])
check("names for the message", render(RESTORE["names"], shed=shed, back=["ac", "led"]), "x, LED")


print("corner cases")
check("battery exactly at a step (80%) -> that step is due", due(soc=80), [{"id": "ac", "soc": 80.0}])
check("80.01% -> not yet", due(soc=80.01), [])
check("battery as a string with decimals '78.0' -> same as 78",
      due(soc="78.0"), [{"id": "ac", "soc": 80.0}])
check("battery 'unknown' -> nothing", due(soc="unknown"), [])
check("battery '' -> nothing", due(soc=""), [])
check("battery 100 -> nothing", due(soc=100), [])
check("battery 0 -> every device at its deepest step",
      due(soc=0), [{"id": "ac", "soc": 60.0}, {"id": "led", "soc": 40.0}])
check("grid sensor 'unavailable' -> nothing (only 'on' is an outage)",
      render(DECISION, {"sensor.jkbms_gateway_bms_state_of_charge": 10,
                        "binary_sensor.powmr_inverter_grid_condition_safe": "unavailable",
                        "input_boolean.load_shedding_enabled": "on", AC: "cool", LED: "on"},
             {("sensor.load_shedding_config", "devices"): [ac_dev(), led_dev()]})["due"], [])
check("no rules at all (devices attribute missing) -> nothing",
      render(DECISION, {"sensor.jkbms_gateway_bms_state_of_charge": 10,
                        "binary_sensor.powmr_inverter_grid_condition_safe": "on",
                        "input_boolean.load_shedding_enabled": "on"}, {}),
      {"due": [], "overridden": [], "warn": []})
check("step % written as a string '80' -> still a step",
      due(soc=78, devices=[ac_dev(steps=(("80", "climate.set_temperature", {"temperature": 27}),))]),
      [{"id": "ac", "soc": 80.0}])
check("step % garbage 'x' -> ignored, the other step still works",
      due(soc=55, devices=[ac_dev(steps=(("x", "climate.set_hvac_mode", {"hvac_mode": "off"}),
                                         (60, "climate.set_temperature", {"temperature": 27})))]),
      [{"id": "ac", "soc": 60.0}])
check("device 'unavailable' and no guard -> left alone",
      [d for d in due(soc=30, led="unavailable") if d["id"] == "led"], [])
check("override exactly 180 s after the step -> not yet (strictly more)",
      over(soc=75, ac_temp=24, shed={"ac": rec(80, minutes_ago=3, applied=AC_APPLIED)}), [])
check("store record with a garbage `since` -> age 0, no override",
      over(soc=75, ac_temp=24, shed={"ac": dict(rec(80, applied=AC_APPLIED), since="garbage")}), [])
check("validator: step at 0% is refused",
      errors({"devices": [dict(led_dev(), steps=[{"soc": 0, "action": "light.turn_off"}])]}),
      ["LED: step 1 needs a battery % of 1-100"])
check("validator: step at 100% is fine",
      errors({"devices": [dict(led_dev(), steps=[{"soc": 100, "action": "light.turn_off"}])]}), [])
check("validator: devices as a string is refused",
      errors({"devices": "light.x"}), ["the config needs a list of devices"])
check("validator: step data that is not an object",
      errors({"devices": [dict(led_dev(), steps=[{"soc": 50, "action": "light.turn_off", "data": "x"}])]}),
      ["LED: step at 50% has data that is not an object"])

print("\n%s" % ("FAILED: " + ", ".join(FAILED) if FAILED else "all checks passed"))
sys.exit(1 if FAILED else 0)
