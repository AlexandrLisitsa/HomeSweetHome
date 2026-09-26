"""Render the Jinja in HomeAssistant/config/packages/irbridge_ac_energy.yaml against fake states.

    python tools/check_ha_templates.py

`ha core check` parses YAML. It does not render templates, so a template that
is syntactically fine and logically wrong deploys cleanly and then quietly
reports the wrong thing for the rest of the summer. This renders every
`state:`, `availability:` and `icon:` template in the energy package across a
matrix of situations and asserts the results.

It reimplements just enough of Home Assistant's template environment to be
useful: states(), state_attr(), is_number, and the `number` test. It is not a
Home Assistant emulator - what it proves is that the templates parse, produce
exactly one clean token, and branch the way the comments in the package claim
they do.

The scenarios at the bottom are the interesting ones: a unit at standby, a
unit running the fan only, a compressor pulling 700 W, and both directions of
disagreement between the meter and what the bridge believes.
"""
import json
import re
import sys
from pathlib import Path

import jinja2
import yaml


class HaLoader(yaml.SafeLoader):
    """SafeLoader that shrugs at !secret / !include instead of dying."""


HaLoader.add_multi_constructor("!", lambda loader, suffix, node: None)


def make_env(states, attrs):
    """A Jinja environment with the handful of HA globals these templates use."""
    env = jinja2.Environment(undefined=jinja2.StrictUndefined)

    def _states(eid):
        # HA returns the string 'unknown' for an entity it has never seen,
        # never a Python None, and several templates below lean on that.
        return str(states.get(eid, "unknown"))

    def _state_attr(eid, attr):
        return attrs.get((eid, attr))

    def is_number(value):
        try:
            float(value)
        except (TypeError, ValueError):
            return False
        return True

    env.globals.update(states=_states, state_attr=_state_attr, is_number=is_number)
    env.filters["is_number"] = is_number
    env.filters["round"] = lambda v, n=0: round(float(v), n)
    env.filters["to_json"] = lambda v: json.dumps(v)
    env.tests["number"] = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)
    return env


def attribute_payload(pkg, env, states):
    """Render the json_attributes payload the way the automation builds it.

    Worth its own check because the failure mode is silent: Home Assistant's
    MQTT attributes parser drops a malformed payload without logging anything
    useful, so the dialog just keeps showing whatever it had last.
    """
    autos = {a["id"]: a for a in pkg.get("automation", [])}
    auto = autos["irbridge_ac_publish_attributes"]

    # `variables:` are rendered first, then referenced by the payload template.
    rendered = {}
    for name, tpl in auto["variables"].items():
        if isinstance(tpl, str) and ("{{" in tpl or "{%" in tpl):
            local = env.from_string(tpl)
            rendered[name] = local.render(**rendered).strip()
        else:
            rendered[name] = tpl

    payload_tpl = auto["action"][0]["data"]["payload"]
    return env.from_string(payload_tpl).render(**rendered).strip()


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
    """name -> {template key: template string} for template: entities."""
    out = {}
    for block in pkg.get("template", []):
        for kind, items in block.items():
            for item in items:
                eid = f"{kind}.{re.sub(r'[^a-z0-9]+', '_', item['name'].lower()).strip('_')}"
                templates = {
                    k: v for k, v in item.items()
                    if isinstance(v, str) and ("{{" in v or "{%" in v)
                }
                # attributes: is a nested mapping, and the drift sensor's
                # explanation of itself lives in there.
                for k, v in (item.get("attributes") or {}).items():
                    if isinstance(v, str):
                        templates[k] = v
                out[eid] = templates
    return out


POWER = "sensor.0x70b3d52b600fddcb_power"

# Every scenario worth distinguishing, with what each derived entity must say.
# `believed` is what the bridge thinks it last transmitted (the REST sensor),
# `live` is the optimistic climate entity.
SCENARIOS = [
    # label                  watts  live        believed   action     running drift
    ("unit off, agreed",         1, "off",      "off",     "off",     False, False),
    ("standby, at the ceiling",  5, "off",      "off",     "off",     False, False),
    ("fan only",                45, "fan_only", "fan_only", "fan",    True,  False),
    ("cool, reached setpoint",  45, "cool",     "cool",    "idle",    True,  False),
    ("cool, compressor on",    700, "cool",     "cool",    "cooling", True,  False),
    ("heat, compressor on",    850, "heat",     "heat",    "heating", True,  False),
    ("dry",                    500, "dry",      "dry",     "drying",  True,  False),
    ("heat_cool, room warm",   700, "heat_cool", "heat_cool", "cooling", True, False),
    ("heat_cool, room cold",   700, "heat_cool", "heat_cool", "heating", True, False),
    # The two that matter: the remote was used behind our back.
    ("remote turned it OFF",     1, "cool",     "cool",    "off",     False, True),
    ("remote turned it ON",    700, "off",      "off",     "cooling", True,  True),
    # Post-restart: the optimistic climate entity has forgotten, the bridge
    # has not. The mode label must come from the bridge, not default to cool.
    ("after HA restart, drying", 500, "unknown", "dry",    "drying",  True,  False),
]


def main():
    pkg_path = (Path(__file__).resolve().parents[2]
                / "HomeAssistant/config/packages/irbridge_ac_energy.yaml")
    pkg = yaml.load(pkg_path.read_text(encoding="utf-8"), HaLoader)
    ents = entities(pkg)

    # 1. everything parses, including the automations and attributes
    print("-- parse -------------------------------------------------------")
    total = 0
    for path, tpl in templates_in(pkg):
        total += 1
        try:
            jinja2.Environment().parse(tpl)
        except jinja2.TemplateSyntaxError as exc:
            print(f"   SYNTAX ERROR at {'.'.join(path)}: {exc}")
            return 1
    print(f"   {total} templates parse")

    # 2. behaviour
    print("\n-- rendered ----------------------------------------------------")
    header = f"   {'scenario':28s} {'W':>4s}  {'action':9s} {'activity':20s} run drift"
    print(header)
    bad = 0
    for label, watts, live, believed, want_action, want_run, want_drift in SCENARIOS:
        ambient = 19.0 if "room cold" in label else 27.0
        states = {
            POWER: watts,
            "input_number.irbridge_ac_standby_watts": 5,
            "input_number.irbridge_ac_compressor_watts": 100,
            "climate.daewoo_a_c": live,
            "sensor.a_c_assumed_state": believed,
            "sensor.a_c_energy_today": 3.5,
            "sensor.a_c_energy_this_month": 84.2,
            "sensor.a_c_runtime_today": 6.0,
        }
        attrs = {
            ("climate.daewoo_a_c", "current_temperature"): ambient,
            ("climate.daewoo_a_c", "temperature"): 22.0,
        }
        env = make_env(states, attrs)

        def render(eid, key):
            tpl = ents[eid].get(key)
            if tpl is None:
                return None
            return env.from_string(tpl).render().strip()

        # binary sensors first, since the later ones read them
        for eid in ("binary_sensor.a_c_running", "binary_sensor.a_c_compressor"):
            states[eid] = "on" if render(eid, "state") == "True" else "off"

        action = render("sensor.a_c_hvac_action", "state")
        states["sensor.a_c_hvac_action"] = action
        activity = render("sensor.a_c_activity", "state")
        icon = render("sensor.a_c_activity", "icon")
        running = states["binary_sensor.a_c_running"] == "on"
        drift = render("binary_sensor.a_c_drift", "state") == "True"
        detail = " ".join(render("binary_sensor.a_c_drift", "detail").split())
        avg = render("sensor.a_c_average_draw_today", "state")
        delta = render("sensor.a_c_setpoint_delta", "state")

        flag = ""
        if action != want_action:
            flag += f"  WRONG action (wanted {want_action})"
        if running != want_run:
            flag += f"  WRONG running (wanted {want_run})"
        if drift != want_drift:
            flag += f"  WRONG drift (wanted {want_drift})"
        if " " in action or action != action.strip():
            flag += "  action is not a single clean token"
        if action not in ("off", "heating", "cooling", "drying", "idle", "fan"):
            flag += "  action is not a value MQTT climate accepts"
        if flag:
            bad += 1

        print(f"   {label:28s} {watts:4d}  {action:9s} {activity:20s} "
              f"{'on ' if running else 'off'} {'YES' if drift else '-'}{flag}")
        if drift:
            print(f"        detail: {detail}")

    print(f"\n   average draw {avg} W, "
          f"setpoint delta {delta} °C (last scenario)")
    print(f"   activity icon resolves, e.g. {icon}")

    # --- the attributes published onto the climate entity ------------------
    #
    # Two states matter: everything reading, and the meter having dropped off
    # the Zigbee mesh. The second is where a naive payload emits `unknown` or a
    # confident 0.00, and where invalid JSON would come from a stray quote.
    print("\n-- json_attributes payload -------------------------------------")
    base = {
        POWER: 612,
        "input_number.irbridge_ac_standby_watts": 5,
        "input_number.irbridge_ac_compressor_watts": 100,
        "climate.daewoo_a_c": "cool",
        "sensor.a_c_assumed_state": "cool",
        "sensor.a_c_hvac_action": "cooling",
        "sensor.a_c_activity": "Cooling",
        "sensor.a_c_energy_today": 3.456,
        "sensor.a_c_energy_this_month": 84.21,
        "sensor.a_c_cost_today": 14.93,
        "sensor.a_c_cost_this_month": 363.78,
        "sensor.a_c_runtime_today": 6.04,
        "sensor.a_c_compressor_hours_today": 4.11,
        "sensor.a_c_compressor_cycles_today": 7,
        "sensor.a_c_average_draw_today": 572,
    }
    # A climate entity's own attributes are off limits: a collision either
    # overwrites a real one or gets dropped.
    reserved = {"temperature", "current_temperature", "current_humidity",
                "hvac_modes", "hvac_action", "fan_mode", "fan_modes",
                "swing_mode", "swing_modes", "min_temp", "max_temp",
                "target_temp_step", "friendly_name", "supported_features"}

    for label, overrides in (
        ("all readings present", {}),
        ("meter offline", {POWER: "unavailable",
                           "sensor.a_c_energy_today": "unknown",
                           "sensor.a_c_cost_today": "unavailable",
                           "sensor.a_c_average_draw_today": "unavailable"}),
    ):
        st = dict(base)
        st.update(overrides)
        raw = attribute_payload(pkg, make_env(st, {}), st)
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            print(f"   {label}: INVALID JSON — {exc}")
            print(f"      {raw!r}")
            bad += 1
            continue
        print(f"   {label}: valid JSON, {len(parsed)} attributes")
        for key, value in parsed.items():
            print(f"      {key:28s} {value}")
        clash = reserved & {k.lower().replace(" ", "_") for k in parsed}
        if clash:
            print(f"      COLLIDES with climate's own attributes: {sorted(clash)}")
            bad += 1
        if any(str(v).lower() in ("unknown", "unavailable", "none")
               for v in parsed.values()):
            print("      LEAKED a raw unknown/unavailable into a display string")
            bad += 1

    if bad:
        print(f"\nFAIL: {bad} check(s) rendered wrong")
        return 1
    print("\nOK: every scenario renders the expected value")
    return 0


if __name__ == "__main__":
    sys.exit(main())
