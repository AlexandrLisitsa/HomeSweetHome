#!/usr/bin/env python3
"""Check that every entity climate-console-card.js names actually exists.

    python HomeAssistant/tools/check_climate_card.py            # live, over REST
    python HomeAssistant/tools/check_climate_card.py --offline  # structure only

WHY THIS EXISTS

A Lovelace card that points at an entity id nobody publishes does not fail. It
renders, it lays out correctly, and every tile in it reads an em dash forever.
There is no log line, no repair, no red card -- the failure looks exactly like
a sensor that happens to be quiet, which is a state this dashboard draws on
purpose for the bedroom unit. So an id typo is invisible precisely where it
matters most.

The same trap that `check_ha_entities.py` covers for YAML, in other words, and
the same answer: list what the card references, list what the box publishes,
and diff them.

WHAT IT CHECKS

  1. Every entity id in the card's DEFAULTS block exists on the box.
  2. Every one of the bedroom unit's feature switches exists. An unavailable
     entity is FINE -- the bedroom A/C is unavailable whenever its plug is
     off, and the card draws that state. Missing from the registry is not.
  3. The card and docs/ac-features.md agree on the feature list. The card
     colours a switch per feature and the doc is the inventory it was built
     from; a feature added to one and not the other silently disappears from
     the grid. Only the doc's Bedroom "Feature toggles" table takes part in
     that comparison. Its "Hidden" and "Not exposed" tables are the inventory
     the grid is deliberately shorter than: not exposed is what the unit can
     do and this installation creates no entity for, hidden is what has a
     working entity that the card does not draw because nobody reaches for it.
  4. The dashboard points every view at this card, with a `tab` the card
     accepts, and the Lovelace resource list carries the card's URL.

Exit status is 0 when everything lines up, 1 otherwise, so it can gate a
deploy. --offline skips the two live checks and still does 3 and 4, which is
what runs when the box is not reachable.
"""

import argparse
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MOD = os.path.dirname(HERE)
CARD = os.path.join(MOD, "config", "www", "climate-console-card.js")
DASHBOARD = os.path.join(MOD, "dashboards", "lovelace.dashboard_climate.json")
RESOURCES = os.path.join(MOD, "dashboards", "lovelace_resources.json")
FEATURES = os.path.join(MOD, "docs", "ac-features.md")

CARD_TYPE = "custom:climate-console-card"
CARD_URL = "/local/climate-console-card.js"

# Labels the card is allowed to draw with no entity behind them. Empty on
# purpose: `Fresh air` used to sit here, drawn dashed and dimmed, and read as
# a broken tile -- it now lives in ac-features.md's "Not exposed" table and is
# not drawn at all. A null slug in BED_FEATURES is therefore a mistake, and
# this set is what makes it say so.
KNOWN_ABSENT = set()


def read_card():
    with open(CARD, encoding="utf-8") as fh:
        return fh.read()


def card_defaults(src):
    """Every entity id in the DEFAULTS object, keyed by its config name."""
    block = re.search(r"const DEFAULTS = \{(.*?)\n\};", src, re.S)
    if not block:
        raise SystemExit("check_climate_card: no DEFAULTS block in the card")
    out = {}
    for key, value in re.findall(r'^\s*(\w+):\s*"([^"]+)",', block.group(1), re.M):
        if key == "tab":
            continue
        out[key] = value
    if not out:
        raise SystemExit("check_climate_card: DEFAULTS parsed empty")
    return out


def card_features(src):
    """[(label, entity id or None)] for the bedroom unit's feature switches."""
    prefix = re.search(r'const BED_SWITCH_PREFIX = "([^"]+)";', src)
    block = re.search(r"const BED_FEATURES = \[(.*?)\n\];", src, re.S)
    if not prefix or not block:
        raise SystemExit("check_climate_card: no BED_FEATURES block in the card")
    out = []
    for label, slug in re.findall(r'\["([^"]+)",\s*(null|"[^"]+")\]', block.group(1)):
        out.append((label, None if slug == "null" else prefix.group(1) + slug.strip('"')))
    return out


def card_tabs(src):
    block = re.search(r"const TABS = \[(.*?)\];", src, re.S)
    return re.findall(r'"([^"]+)"', block.group(1)) if block else []


def live_entities():
    """Every entity id the box currently publishes, via the read-only helper."""
    script = os.path.join(HERE, "ha_get.sh")
    try:
        raw = subprocess.run(
            ["sh", script, "/api/states"],
            capture_output=True, check=True, text=True, encoding="utf-8",
        ).stdout
    except (OSError, subprocess.CalledProcessError) as err:
        raise SystemExit(
            "check_climate_card: could not reach Home Assistant (%s).\n"
            "  Fix secrets.env, or run with --offline to skip the live checks." % err
        )
    try:
        states = json.loads(raw)
    except ValueError:
        raise SystemExit("check_climate_card: /api/states did not return JSON")
    return {s["entity_id"]: s["state"] for s in states}


def load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def check_live(src, problems):
    states = live_entities()
    for key, entity in sorted(card_defaults(src).items()):
        if entity not in states:
            problems.append("DEFAULTS.%s points at %s, which does not exist" % (key, entity))

    for label, entity in card_features(src):
        if entity is None:
            if label not in KNOWN_ABSENT:
                problems.append("feature %r has no entity and is not in KNOWN_ABSENT" % label)
            continue
        if label in KNOWN_ABSENT:
            problems.append(
                "feature %r is drawn as permanently absent but %s now exists -- "
                "give it its slug in BED_FEATURES" % (label, entity)
            )
        elif entity not in states:
            problems.append("feature %r points at %s, which does not exist" % (label, entity))


def doc_table(path, room, section):
    """First-column cells of the table under `## room` / `### section` in a
    Markdown doc, or None when that section does not exist."""
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    in_room = in_section = False
    cells = None
    for line in lines:
        if line.startswith("## "):
            in_room = line[3:].strip().lower() == room.lower()
            in_section = False
        elif line.startswith("### "):
            in_section = in_room and line[4:].strip().lower() == section.lower()
            if in_section:
                cells = []
        elif in_section and line.startswith("|"):
            first = line.strip("|").split("|")[0].strip()
            if first and first != "Feature" and not set(first) <= set("-: "):
                cells.append(first)
    return cells


def check_features_doc(src, problems):
    """The card and the inventory it was built from have to list the same set."""
    documented = doc_table(FEATURES, "Bedroom", "Feature toggles")
    if documented is None:
        problems.append("ac-features.md has no Bedroom / Feature toggles table")
        return
    drawn = [label for label, _ in card_features(src)]
    for missing in sorted(set(documented) - set(drawn)):
        problems.append("ac-features.md lists %r and the card does not draw it" % missing)
    for extra in sorted(set(drawn) - set(documented)):
        problems.append("the card draws %r and ac-features.md does not list it" % extra)


def check_dashboard(src, problems):
    tabs = card_tabs(src)
    views = load_json(DASHBOARD)["data"]["config"]["views"]
    if not views:
        problems.append("the climate dashboard has no views")
    seen = []
    for view in views:
        cards = [c for s in view.get("sections", []) for c in s.get("cards", [])]
        cards += view.get("cards", [])
        if not cards:
            problems.append("view %r holds no cards" % view.get("title"))
        for card in cards:
            if card.get("type") != CARD_TYPE:
                problems.append("view %r holds a %s, not %s"
                                % (view.get("title"), card.get("type"), CARD_TYPE))
                continue
            tab = card.get("tab")
            if tab not in tabs:
                problems.append("view %r asks for tab %r; the card knows %s"
                                % (view.get("title"), tab, ", ".join(tabs)))
            else:
                seen.append(tab)
    for missing in [t for t in tabs if t not in seen]:
        problems.append("tab %r is implemented and no view shows it" % missing)

    urls = [i.get("url", "") for i in load_json(RESOURCES)["data"]["items"]]
    register = ("    python HomeAssistant/tools/ha_dashboard.py --card "
                + CARD_URL.rsplit("/", 1)[-1])
    ours = [u for u in urls if u.split("?")[0] == CARD_URL]
    if not ours:
        problems.append("lovelace_resources.json does not carry %s -- register it with\n%s"
                        % (CARD_URL, register))
    else:
        # The ?v= is the card's VERSION (top-level README, "Versions"). A
        # mismatch means the card was edited and never re-registered, so every
        # browser that already has it cached is still drawing the old one.
        version = re.search(r'^const VERSION = "([^"]+)";', read_card(), re.M)
        want = "%s?v=%s" % (CARD_URL, version.group(1) if version else "?")
        if ours[0] != want:
            problems.append("lovelace_resources.json loads %s but the card is %s -- "
                            "re-register it with\n%s" % (ours[0], want, register))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--offline", action="store_true",
                    help="skip the checks that need the box, keep the local ones")
    args = ap.parse_args()

    src = read_card()
    problems = []
    check_features_doc(src, problems)
    check_dashboard(src, problems)
    if not args.offline:
        check_live(src, problems)

    if problems:
        print("check_climate_card: %d problem(s)" % len(problems))
        for p in problems:
            print("  - %s" % p)
        return 1
    n = len(card_defaults(src))
    print("check_climate_card: ok — %d configured entities, %d feature switches%s"
          % (n, len(card_features(src)), ", live check skipped" if args.offline else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
