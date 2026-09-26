#!/usr/bin/env python3
"""Find and remove orphaned entity registry entries, over HA's own API.

    python HomeAssistant/tools/ha_registry.py --orphans
    python HomeAssistant/tools/ha_registry.py --repairs
    python HomeAssistant/tools/ha_registry.py --remove input_number.old_thing

`--remove` CHANGES THE HOUSE and prompts, like ha_call.sh does.

WHY THIS EXISTS, GIVEN THE README ALREADY HAS A PROCEDURE

The README's "Renaming an entity id" section says to stop Home Assistant and
edit `.storage/core.entity_registry` by hand, because HA holds the registry in
memory and overwrites the file on its next save. That is the right procedure
for a *rename that has to land across the registry, a dashboard and
configuration.yaml at the same time* -- it is a sledgehammer for deleting one
dead row. It costs a full stop/start of the house, it is the one edit in this
repo with no dry run, and a mistake in an 856 KB JSON file is not obvious.

`config/entity_registry/remove` is HA's own WebSocket command, the one the UI
calls when you press Delete on an unavailable entity. It takes effect
immediately, needs no restart, and cannot corrupt the file. Anything it
refuses, it refuses for a reason worth hearing.

WHAT COUNTS AS AN ORPHAN, AND WHAT EMPHATICALLY DOES NOT

An orphan is a registry row whose provider is gone: a template sensor or an
input_number deleted from YAML, whose entry survives and reads `unavailable`
forever. Three things look identical from a distance and must not be touched:

  - DISABLED entities. zigbee2mqtt creates `_linkquality` and `_last_seen` for
    every device and leaves them disabled; they have no state at all, which is
    not the same as having lost one. `--orphans` skips anything with a
    `disabled_by`.
  - Entities that are unavailable ON PURPOSE. `binary_sensor.dtek_scheduled_dark`
    has read unavailable since DTEK suspended stabilisation schedules, and the
    README calls that the correct answer rather than a fault. So does every
    sensor whose `availability:` template is currently false -- half of
    bedroom_ac_energy.yaml goes unavailable whenever that unit is unplugged.
  - Entities owned by an integration. A config entry that is merely offline
    still owns its rows, and deleting them makes it recreate them with `_2`
    suffixes on its next startup -- which is where stale suffixes come from in
    the first place.

So `--orphans` only ever reports rows whose platform is one this repo's YAML
creates AND which no longer appear in any YAML file under `config/`. That last
check is the one that makes it safe: it is the difference between "this entity
has no value right now" and "nothing in this repo asks for this entity".
"""

import argparse
import json
import pathlib
import re
import sys

try:
    import websocket  # websocket-client
except ImportError:
    sys.exit("needs websocket-client:  python -m pip install -r "
             + str(pathlib.Path(__file__).parent / "requirements.txt"))

HERE = pathlib.Path(__file__).resolve().parent
MOD = HERE.parent
SECRETS = MOD / "secrets.env"
CONFIG = MOD / "config"

# Platforms this repo's YAML creates. Everything else belongs to an
# integration and is not ours to prune -- see the module docstring.
YAML_PLATFORMS = {
    "input_number", "input_text", "input_boolean", "input_select",
    "template", "utility_meter", "history_stats", "derivative",
    "integration", "command_line", "rest", "min_max", "statistics",
    "trend", "group", "counter", "timer", "script",
}


def load_env():
    if not SECRETS.exists():
        sys.exit(f"{SECRETS} not found -- copy secrets.env.example and fill it in")
    env = {}
    for line in SECRETS.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.strip().startswith("#"):
            key, _, value = line.partition("=")
            env[key.strip()] = value.strip().strip('"').strip("'")
    for required in ("HA_URL", "HA_TOKEN"):
        if not env.get(required):
            sys.exit(f"{required} missing from {SECRETS}")
    return env


class HA:
    """One authenticated WebSocket connection, commands numbered as HA wants."""

    def __init__(self, env):
        url = env["HA_URL"].rstrip("/")
        url = "ws" + url[4:] if url.startswith("http") else url
        self.ws = websocket.create_connection(url + "/api/websocket", timeout=20)
        self._id = 0
        hello = json.loads(self.ws.recv())
        if hello.get("type") != "auth_required":
            sys.exit(f"unexpected greeting from HA: {hello}")
        self.ws.send(json.dumps({"type": "auth", "access_token": env["HA_TOKEN"]}))
        ack = json.loads(self.ws.recv())
        if ack.get("type") != "auth_ok":
            sys.exit(f"auth refused: {ack.get('message', ack)}")

    def __enter__(self):
        return self

    def __exit__(self, *_):
        try:
            self.ws.close()
        except OSError:
            pass

    def cmd(self, type_, **fields):
        self._id += 1
        self.ws.send(json.dumps({"id": self._id, "type": type_, **fields}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self._id and msg.get("type") == "result":
                if not msg.get("success"):
                    err = msg.get("error", {})
                    sys.exit("%s failed: %s %s"
                             % (type_, err.get("code"), err.get("message")))
                return msg.get("result")


def yaml_text():
    """Every YAML file under config/, comments stripped, as one blob.

    Crude on purpose. Parsing would mean resolving !secret and !include and
    knowing how each platform derives an entity id -- which
    check_ha_entities.py already does, and got wrong for tariff meters until it
    was corrected. Here a substring hit is enough: this only has to answer
    "does anything still ask for this", and a false hit leaves an orphan in
    place, which is the safe direction to be wrong in.

    COMMENTS ARE STRIPPED, AND THAT IS THE WHOLE DIFFERENCE BETWEEN THIS
    WORKING AND NOT.

    The first thing anyone does when deleting an entity from YAML is leave a
    note saying where it went -- `irbridge_ac_energy.yaml` has one reading
    "the old `irbridge_ac_tariff` was never set on this box". With comments
    included, that sentence is indistinguishable from a live definition, and
    the one orphan this tool was written to find was the one it could not see.
    check_ha_entities.py has the same blind spot pointing the other way: it
    reads entity ids out of prose and reports them dangling.

    A `#` inside a quoted string is not a comment, but nothing in this config
    has one, and mistaking a value for a comment can only shorten the blob --
    which again errs toward leaving an orphan alone.
    """
    parts = []
    for path in sorted(CONFIG.rglob("*.yaml")):
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        parts.append("\n".join(re.sub(r"#.*$", "", line) for line in text.splitlines()))
    return "\n".join(parts)


def mentioned(blob, token):
    """True when `token` appears in `blob` as a whole word."""
    return re.search(r"(?<!\w)" + re.escape(token) + r"(?!\w)", blob) is not None


def orphans(ha):
    entities = ha.cmd("config/entity_registry/list")
    states = {s["entity_id"]: s["state"] for s in ha.cmd("get_states")}
    blob = yaml_text()
    out = []
    for e in entities:
        eid = e["entity_id"]
        if e.get("platform") not in YAML_PLATFORMS:
            continue
        # Disabled is not orphaned: somebody switched it off on purpose.
        if e.get("disabled_by"):
            continue
        if states.get(eid) not in (None, "unavailable"):
            continue
        # The object_id is what a YAML key or a slugified name looks like.
        #
        # Matched as a WHOLE TOKEN, not as a substring, and this is the second
        # thing that hid the orphan this tool was written for: the dead helper
        # `irbridge_ac_tariff` is a prefix of the live meter key
        # `irbridge_ac_tariff_daily`, so a substring test found it "still
        # referenced" by the very file that replaced it. Underscore is a word
        # character, so the lookarounds keep `foo` from matching `foo_bar`.
        obj = eid.split(".", 1)[1]
        unique = str(e.get("unique_id") or "")
        if mentioned(blob, obj) or (unique and mentioned(blob, unique)):
            continue
        out.append(e)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--orphans", action="store_true",
                    help="list registry rows nothing in config/ asks for (read-only)")
    ap.add_argument("--repairs", action="store_true",
                    help="list open repair issues (read-only)")
    ap.add_argument("--remove", metavar="ENTITY_ID", action="append", default=[],
                    help="delete one registry row -- CHANGES THE HOUSE, prompts")
    ap.add_argument("--clear-stats", metavar="STATISTIC_ID", action="append", default=[],
                    dest="clear_stats",
                    help="drop one statistic series -- CHANGES THE HOUSE, prompts")
    ap.add_argument("--yes", action="store_true", help="skip the prompt")
    args = ap.parse_args(argv)
    if not (args.orphans or args.repairs or args.remove or args.clear_stats):
        ap.print_help()
        return 2

    with HA(load_env()) as ha:
        if args.repairs:
            issues = ha.cmd("repairs/list_issues").get("issues", [])
            live = [i for i in issues if not i.get("dismissed_version")]
            print("open repair issues: %d" % len(live))
            for i in live:
                print("  %-14s %s%s" % (i.get("domain"), i.get("issue_id"),
                                        "  (ignored)" if i.get("ignored") else ""))
            if not live:
                print("  none")

        if args.orphans:
            found = orphans(ha)
            print("orphaned registry rows: %d" % len(found))
            for e in found:
                print("  %-46s platform=%-14s unique_id=%s"
                      % (e["entity_id"], e.get("platform"), e.get("unique_id")))
            if found:
                print("\nremove them with:")
                print("  python HomeAssistant/tools/ha_registry.py "
                      + " ".join("--remove " + e["entity_id"] for e in found))

        for eid in args.remove:
            known = {e["entity_id"] for e in ha.cmd("config/entity_registry/list")}
            if eid not in known:
                print("not in the registry (already gone?): " + eid)
                continue
            if not args.yes:
                # THIS CHANGES THE HOUSE, so it asks -- same rule as ha_call.sh.
                sys.stderr.write("remove %s from the entity registry? [y/N] " % eid)
                sys.stderr.flush()
                if (sys.stdin.readline() or "").strip().lower() not in ("y", "yes"):
                    print("skipped " + eid)
                    continue
            ha.cmd("config/entity_registry/remove", entity_id=eid)
            print("removed " + eid)

        for sid in args.clear_stats:
            """
            The resolution for a `state_class_removed` or `units_changed`
            repair, and the only one there is.

            Both are raised by the statistics compiler when a sensor stops
            being the shape its stored series expects -- a state_class taken
            off, or a unit that changed after the first row was written. The
            series cannot be reconciled, only dropped; HA's own repair flow
            does exactly this call behind its Fix button.

            It is irreversible and it is not always right: clearing the series
            for a sensor that SHOULD have kept its state_class throws away real
            history to silence a warning about a mistake. Read the repair
            first. Where it is right -- a sensor that was never meant to be a
            statistic, or whose rows are all zeros from before it was wired up
            -- there is nothing of value in the series.

            Clearing alone does not retire the notification: the issue is only
            re-evaluated at startup, and being non-persistent it is dropped by
            the next restart and not recreated once the mismatch is gone. The
            README says the same about the gas and water meters.
            """
            if not args.yes:
                sys.stderr.write("clear ALL recorded statistics for %s? [y/N] " % sid)
                sys.stderr.flush()
                if (sys.stdin.readline() or "").strip().lower() not in ("y", "yes"):
                    print("skipped " + sid)
                    continue
            ha.cmd("recorder/clear_statistics", statistic_ids=[sid])
            print("cleared statistics for " + sid)
    return 0


if __name__ == "__main__":
    sys.exit(main())
