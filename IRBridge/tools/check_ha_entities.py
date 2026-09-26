"""Cross-check every entity id referenced in a Home Assistant config's *.yaml
against the ids those same files actually create, using Home Assistant's own
slugify rule. Run from HomeAssistant/, against the mirrored config:

    python ../IRBridge/tools/check_ha_entities.py config

Catches the failure mode these packages are most exposed to. Nothing in Home
Assistant declares an entity id: they are derived from `name:` by slugify (and
from the *config key* for helpers and scripts, which is a different rule in the
same file). So a template referencing sensor.a_c_energy_today while the
utility_meter is named something that slugifies to anything else is not a
config error - `ha core check` passes, the deploy succeeds, and the sensor
renders 'unknown' for as long as nobody notices.

Run this before deploying. It knows two things Home Assistant will not tell
you until runtime: which ids these files create, and which ones they expect
somebody else to have created (EXTERNAL, below - the zigbee2mqtt sensors).
"""
import re
import sys
import unicodedata
from pathlib import Path

import yaml


class HaLoader(yaml.SafeLoader):
    """SafeLoader that shrugs at !secret / !include instead of dying."""


HaLoader.add_multi_constructor("!", lambda loader, suffix, node: None)

def slugify(text):
    """Mirror homeassistant.util.slugify closely enough for these names."""
    text = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-zA-Z0-9]+", "_", text).strip("_").lower()
    return re.sub(r"_+", "_", text)


def created(files):
    """Entity ids these YAML files bring into being."""
    out = {}

    def add(eid, where):
        out.setdefault(eid, where)

    for path in files:
        doc = yaml.load(path.read_text(encoding="utf-8"), HaLoader) or {}
        if not isinstance(doc, dict):
            continue  # automations.yaml / scenes.yaml: a top-level list

        # template: -> [{sensor: [...], binary_sensor: [...]}]
        for block in doc.get("template", []) or []:
            for kind, items in block.items():
                if kind in ("sensor", "binary_sensor", "switch", "button"):
                    for item in items:
                        add(f"{kind}.{slugify(item['name'])}", path.name)

        # rest: -> [{sensor: [...]}]
        for block in doc.get("rest", []) or []:
            for kind in ("sensor", "binary_sensor"):
                for item in block.get(kind, []) or []:
                    add(f"{kind}.{slugify(item['name'])}", path.name)

        # command_line: -> [{sensor: {...}}, {binary_sensor: {...}}]
        # One mapping per platform, NOT a list of them like template: and rest:
        # above. Reading it the same way silently finds nothing.
        for block in doc.get("command_line", []) or []:
            for kind in ("sensor", "binary_sensor"):
                item = block.get(kind)
                if isinstance(item, dict) and "name" in item:
                    add(f"{kind}.{slugify(item['name'])}", path.name)

        # mqtt: -> {climate: [...], sensor: [...]}
        for kind, items in (doc.get("mqtt") or {}).items():
            for item in items:
                add(f"{kind}.{slugify(item['name'])}", path.name)

        # utility_meter / counter style: dict of meters.
        #
        # The entity id comes from `name:` -- EXCEPT when the meter has
        # `tariffs:`, where it comes from the config KEY, gains the tariff as a
        # suffix, and `name:` survives only as the friendly name. A tariff
        # meter also creates a select to switch between its tariffs.
        #
        # Both halves of that were established by deploying it and reading the
        # registry back; the docs do not say. Getting it wrong is quiet --
        # cost sensors whose availability template guards on a meter that does
        # not exist simply sit `unavailable` forever.
        for key, cfg in (doc.get("utility_meter") or {}).items():
            tariffs = cfg.get("tariffs") or []
            if tariffs:
                for tariff in tariffs:
                    add(f"sensor.{slugify(key)}_{slugify(str(tariff))}", path.name)
                add(f"select.{slugify(key)}", path.name)
            else:
                add(f"sensor.{slugify(cfg.get('name', key))}", path.name)

        # sensor: -> [{platform: history_stats, name: ...}]
        node = doc.get("sensor")
        if isinstance(node, list):
            for item in node:
                if isinstance(item, dict) and "name" in item:
                    add(f"sensor.{slugify(item['name'])}", path.name)

        # helpers: entity id is the CONFIG KEY, not the name
        for domain in ("input_number", "input_text", "input_boolean", "input_select",
                       "script", "counter", "timer"):
            for key in (doc.get(domain) or {}):
                add(f"{domain}.{key}", path.name)

    return out


# The trailing lookahead skips recorder glob patterns like `sensor.google_*`
# in configuration.yaml, which filter over many entities rather than refer to
# one. It has to exclude word characters as well as the star, or the match
# just backtracks a character and reports `sensor.google` instead.
REF = re.compile(
    r"\b(sensor|binary_sensor|climate|switch|script|input_number|input_text|"
    r"input_boolean|input_select|button|number|select)\.[a-z0-9_]+(?![a-z0-9_*])"
)

# Entities that come from elsewhere in the Home Assistant install, not from
# these files. Anything referenced and not created has to be listed here on
# purpose, so a typo cannot hide among them.
# Service calls look exactly like entity ids to the regex below
# (`input_text.set_value`), so the verb half is filtered out by name. Add to
# this when a new service starts appearing in the packages.
SERVICE_VERBS = {
    "set_value", "turn_on", "turn_off", "toggle", "reload", "select_option",
    "increment", "decrement", "publish", "create", "dismiss", "set_datetime",
}

EXTERNAL = {
    "sensor.0xa4c13858c97f07f8_temperature",   # Aqara room sensor, zigbee2mqtt
    "sensor.0xa4c13858c97f07f8_humidity",
    "sensor.0x70b3d52b600fddcb_power",         # A/C energy meter, zigbee2mqtt
    "sensor.0x70b3d52b600fddcb_energy",

    # Created in the UI, so they exist in .storage/core.entity_registry and
    # nowhere in this repo. Listed one by one on purpose: they are few, and a
    # typo in one is exactly the kind of thing this script is for.
    "input_boolean.kitchen_light_block",
    "input_boolean.hallway_light_sensor",
    "input_boolean.bathroom_light_sensor",
    "input_boolean.kitchen_light_force_on",
    "select.grid_real_tariff",                 # utility_meter config entry, UI
    "sensor.ir_blaster_battery_level",         # the phone, via mobile_app
}

# Whole namespaces owned by one device, where enumerating every entity would be
# a list that rots the next time somebody edits the firmware. The trade is
# real and worth naming: a typo INSIDE one of these prefixes is not caught.
#
# The honest fix is to check references against .state/core.entity_registry.json,
# which is already pulled by ha_pull.sh and lists every entity that genuinely
# exists. It is gitignored, so this script would have to treat it as optional.
# Worth doing if this list grows again.
EXTERNAL_PREFIXES = (
    "sensor.powmr_inverter_",         # ESPHome, PowerStation/power-station.yaml
    "switch.powmr_inverter_",
    "select.powmr_inverter_",
    "binary_sensor.powmr_inverter_",
    "sensor.jkbms_gateway_",          # ESPHome, JK BMS over BLE, same firmware
    # The bedroom A/C, via midea_ac_lan -- a config entry, so every one of its
    # ~30 entities is named after the appliance id and none of them are in this
    # repo. They all go unavailable together when the unit drops off the LAN,
    # which is a normal state here and not a missing entity.
    "climate.153931629566331_",
    "sensor.153931629566331_",
    "switch.153931629566331_",
    "number.153931629566331_",
    "binary_sensor.0x",               # zigbee2mqtt names entities by IEEE address
    "switch.0x",
    "sensor.0x",
)


def check_line_endings(ha_dir="homeassistant"):
    """Refuse to let a CRLF shell script reach the Home Assistant box.

    HA OS runs BusyBox ash, which does not tolerate carriage returns: a blank
    line becomes the command `\\r` and `do\\r` stops being the `do` keyword.
    The reason this needs checking from here is that it cannot be caught by
    testing - Git Bash strips the CR and runs a CRLF script happily, so a
    locally rehearsed deploy passes and the scp'd copy dies with a syntax
    error pointing at correct code.
    """
    print("-- line endings ------------------------------------------------")
    bad = 0
    for pattern in ("tools/*.sh", "tools/*.py", f"{ha_dir}/**/*.yaml"):
        for path in sorted(Path(".").glob(pattern)):  # ** needs no rglob here
            crs = path.read_bytes().count(b"\r")
            if crs:
                kind = "FATAL on the box" if path.suffix == ".sh" else "untidy"
                print(f"   CRLF  {str(path):42s} {crs} CR  ({kind})")
                bad += 1
    if bad:
        print(f"\n   {bad} file(s) carry carriage returns. Fix before scp:")
        print("      git add --renormalize .        (with .gitattributes in place)")
        return 1
    print(f"   LF throughout tools/ and {ha_dir}/")
    return 0


def main(ha_dir="homeassistant"):
    endings = check_line_endings(ha_dir)
    print()

    files = sorted(f for f in Path(ha_dir).rglob("*.yaml")
                   if "blueprints" not in f.parts)
    packages = files
    made = created(packages)

    print(f"-- entities created by {len(packages)} package files "
          f"({len(made)}) ------------")
    for eid in sorted(made):
        print(f"   {eid:48s} {made[eid]}")

    bad = 0
    print("\n-- references --------------------------------------------------")
    for path in files:
        text = path.read_text(encoding="utf-8")
        refs = sorted({m.group(0) for m in REF.finditer(text)})
        unknown = [
            r for r in refs
            if r not in made
            and r not in EXTERNAL
            and not r.startswith(EXTERNAL_PREFIXES)
            and r.split(".", 1)[1] not in SERVICE_VERBS
        ]
        status = "ok" if not unknown else f"{len(unknown)} DANGLING"
        print(f"   {path.name:28s} {len(refs):3d} refs  {status}")
        for r in unknown:
            print(f"      DANGLING  {r}")
            bad += 1

    print("\n-- external (must be real entities in your HA) ------------------")
    for e in sorted(EXTERNAL):
        print(f"   {e}")
    for prefix in sorted(EXTERNAL_PREFIXES):
        print(f"   {prefix}*")

    if bad or endings:
        problems = []
        if bad:
            problems.append(f"{bad} dangling reference(s)")
        if endings:
            problems.append("carriage returns in files bound for the box")
        print(f"\nFAIL: {', '.join(problems)}")
        return 1
    print("\nOK: every reference resolves, LF throughout")
    return 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:2]))
