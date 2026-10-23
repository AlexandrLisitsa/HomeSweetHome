"""The floor plan's one list, checked against itself, the dashboard and the house.

    python FloorPlan/tools/check_rooms.py

rooms.py is the one list, and make_dashboard.py turns it into the Home
dashboard's card config. Neither needs the other to be right, so this checks:

  * rooms.py hangs together: every item's room, spot and overlay exist, every
    POWER spots exist;
  * every image the card serves is committed, and every URL's ?v= is the hash of
    the file as committed -- a picture rebuilt without re-running
    make_dashboard.py would be served stale;
  * the dashboard says what rooms.py says: the same lights, devices, badges,
    rooms, tints, power entities and loads, in the same order -- a rooms.py
    edit without re-running make_dashboard.py fails here. The projected
    positions and paths need the model and its render copy, which are not in
    the repo, so they are not checked;
  * every entity it names exists in Home Assistant -- only where the registry
    pulled by HomeAssistant/tools/ha_pull.sh is on disk
    (HomeAssistant/.state/core.entity_registry.json, gitignored). Without it,
    as in CI, that part is skipped and says so.

Exit 0 or 1, like the other checks.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rooms import ITEMS, LIGHTS, POWER, ROOMS, SPOTS  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
WWW = ROOT / "HomeAssistant" / "config" / "www" / "floorplan"
DASHBOARD = ROOT / "HomeAssistant" / "dashboards" / "lovelace.dashboard_home.json"
REGISTRY = ROOT / "HomeAssistant" / ".state" / "core.entity_registry.json"
FAILED = []


def check(label, ok, detail=""):
    if not ok:
        FAILED.append(label)
    print("  %-4s %s%s" % ("ok" if ok else "FAIL", label, "" if ok else "  -- " + detail))


def is_load(item):
    return item["kind"] == "light" or item.get("entity", "").split(".")[0] in ("switch", "media_player")


print("rooms.py")
for i, item in enumerate(ITEMS):
    where = "item %d (%s)" % (i, item.get("entity") or item.get("entities", ["?"])[0])
    check(where + ": room", item["room"] in ROOMS, item["room"])
    check(where + ": spot", item["spot"] in SPOTS, item["spot"])
    if item["kind"] == "light":
        check(where + ": overlay", item.get("overlay") in LIGHTS, str(item.get("overlay")))
for name, light in LIGHTS.items():
    check("light %s: room" % name, light["room"] in ROOMS, light["room"])
for key in ("hub", "grid_in", "battery"):
    check("POWER %s: spot" % key, POWER[key] in SPOTS, POWER[key])

print("images")
doc = json.loads(DASHBOARD.read_text(encoding="utf-8"))
card = next(c for c in doc["data"]["config"]["views"][0]["cards"] if c.get("type") == "custom:floorplan-card")
urls = [card["image"]] + [l["overlay"] for l in card["lights"]] + [r["tint"] for r in card["rooms"] if "tint" in r]
for url in urls:
    m = re.fullmatch(r"/local/floorplan/([\w-]+\.png)\?v=([0-9a-f]{8})", url)
    if not m:
        check(url, False, "not /local/floorplan/<name>.png?v=<hash>")
        continue
    f = WWW / m[1]
    check(m[1] + " is committed and its ?v= is its hash", f.is_file() and
          hashlib.sha1(f.read_bytes()).hexdigest()[:8] == m[2],
          "missing" if not f.is_file() else "hash is " + hashlib.sha1(f.read_bytes()).hexdigest()[:8])

print("the dashboard says what rooms.py says")
by_kind = lambda k: [i for i in ITEMS if i["kind"] == k]
check("rooms", [r["id"] for r in card["rooms"]] == list(ROOMS), str([r["id"] for r in card["rooms"]]))
who = lambda e: (e["entity"], e.get("name"), e.get("icon"), e["room"])
check("lights", [who(l) for l in card["lights"]] == [who(i) for i in by_kind("light")])
check("light overlays", [re.sub(r"\.png\?.*", "", l["overlay"].rsplit("/", 1)[1]) for l in card["lights"]]
      == [i["overlay"] for i in by_kind("light")])
check("devices", [(who(d), d.get("value")) for d in card["devices"]]
      == [(who(i), i.get("value")) for i in by_kind("device")])
check("A/C airflow", [bool(d.get("flow")) for d in card["devices"]] == [bool(i.get("flow")) for i in by_kind("device")])
check("badges", [b["entities"] for b in card["badges"]] == [i["entities"] for i in by_kind("badge")])
badge_rooms = {i["room"]: i["entities"][0] for i in by_kind("badge")}
check("tints", {r["id"]: r.get("temperature") for r in card["rooms"] if "tint" in r} == badge_rooms)
power = card.get("power", {})
want = {k: v for k, v in POWER.items() if k not in ("hub", "grid_in", "battery")}
check("power entities", {k: power.get(k) for k in want} == want,
      str({k: power.get(k) for k in want if power.get(k) != want[k]}))
check("power loads", [(l["entity"], l.get("value"), l["room"]) for l in power.get("loads", [])]
      == [(i["entity"], i.get("value"), i["room"]) for i in ITEMS if is_load(i)])
check("power paths", all(str(p).startswith("M") for p in
                         [power.get("grid_path"), power.get("battery_path")] + [l["path"] for l in power.get("loads", [])]))

print("entities exist in Home Assistant")
entities = set()
for i in ITEMS:
    entities.update([i["entity"]] if "entity" in i else [])
    entities.update(i.get("entities", []))
    entities.update([i["value"]] if "value" in i else [])
entities.update(v for k, v in POWER.items() if "." in str(v))
if REGISTRY.is_file():
    known = {e["entity_id"] for e in json.loads(REGISTRY.read_text(encoding="utf-8"))["data"]["entities"]}
    for e in sorted(entities):
        check(e, e in known, "not in the pulled registry")
else:
    print("  skip no %s (pull it with HomeAssistant/tools/ha_pull.sh)" % REGISTRY.relative_to(ROOT).as_posix())

if FAILED:
    print("check_rooms: %d failed" % len(FAILED))
    sys.exit(1)
print("check_rooms: ok")
