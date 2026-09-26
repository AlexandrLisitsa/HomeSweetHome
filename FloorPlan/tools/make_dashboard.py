"""Write the Home dashboard's card config from rooms.py.

    python FloorPlan/tools/make_dashboard.py

Run after build_overlays.py (it reads build/layout.json and the room masks). Projects
every SPOTS point through the camera into % of the cropped picture, gives each room a
zoom box for the phone layout, and rewrites the floorplan card in
HomeAssistant/dashboards/lovelace.dashboard_home.json -- the rest of that file is kept.
Every image URL carries a hash of the file, so a changed image always has a new ?v=
and no browser can keep showing the old one.

Also marks every spot and zoom box on build/icon_check.png, to check by eye.
"""
import hashlib
import json
import math
import re
from pathlib import Path

from PIL import Image, ImageDraw

from rooms import ITEMS, ROOMS, SPOTS
from sh3d_camera import load, projector

ROOT = Path(__file__).resolve().parents[1]
WWW = ROOT.parent / "HomeAssistant" / "config" / "www" / "floorplan"
DASHBOARD = ROOT.parent / "HomeAssistant" / "dashboards" / "lovelace.dashboard_home.json"
layout = json.load(open(ROOT / "build" / "layout.json"))
CROP = layout["crop"]
xml, cam = load(ROOT / "build" / "MySweetHome-render.sh3d")
P = projector(cam, *layout["render_size"])
w, h = CROP[2] - CROP[0], CROP[3] - CROP[1]


def url(name):
    digest = hashlib.sha1((WWW / (name + ".png")).read_bytes()).hexdigest()[:8]
    return f"/local/floorplan/{name}.png?v={digest}"


def pct(x, y, z):
    u, v = P(x, y, z)
    return (round((u - CROP[0]) / w * 100, 2), round((v - CROP[1]) / h * 100, 2))


pos = {}
for name, (x, y, z) in SPOTS.items():
    px, py = pct(x, y, z)
    pos[name] = (round(px, 1), round(py, 1))

# An A/C's air: streamlines leaving the outlet along the bottom of its front face, as
# hung in the render copy (on the cut wall), fanning out over FAN degrees and sinking a
# little as they cross REACH cm of the room, each with a slight sideways wave so it reads as moving air
# rather than a ruler line. A piece at angle 0 faces +y on the plan. Each stream keeps
# only its longest stretch over the room's mask: air behind a wall would float over it.
# Paths are in pixels of the picture, so the card can draw them unstretched.
REACH, STREAMS, STEPS, FAN = 180.0, 7, 24, 70.0


def flow(piece, room):
    tag = re.search(rf"<pieceOfFurniture [^>]*name='{re.escape(piece)}'[^>]*>", xml).group(0)
    get = lambda k, d="0": float((re.search(rf" {k}='([^']*)'", tag) or [0, d])[1])
    mask = Image.open(ROOT / "build" / f"mask_{room}.png").convert("L")
    seen = lambda u, v: 0 <= u < 100 and 0 <= v < 100 and mask.getpixel((u / 100 * w, v / 100 * h)) > 128
    a = get("angle")
    fx, fy = -math.sin(a), math.cos(a)      # forward on the plan
    sx, sy = fy, -fx                        # along the unit's width
    ox, oy = get("x") + fx * get("depth") / 2, get("y") + fy * get("depth") / 2
    z0 = get("elevation") + 3
    paths = []
    for i in range(STREAMS):
        f = i / (STREAMS - 1) - 0.5
        lateral = f * get("width") * 0.7
        turn = math.radians(f * FAN)
        dx, dy = fx * math.cos(turn) + sx * math.sin(turn), fy * math.cos(turn) + sy * math.sin(turn)
        runs, run = [], []
        for k in range(STEPS + 1):
            t = k / STEPS
            d = 15 + REACH * t
            wave = 6 * math.sin(t * math.pi * 2 + i * 1.3) * t
            x = ox + sx * (lateral + wave) + dx * d
            y = oy + sy * (lateral + wave) + dy * d
            u, v = pct(x, y, z0 - 25 * t * t)
            if seen(u, v):
                run.append((u, v))
            elif run:
                runs.append(run)
                run = []
        runs.append(run)
        best = max(runs, key=len)
        if len(best) >= STEPS // 2:
            paths.append("M" + " L".join(f"{u / 100 * w:.1f} {v / 100 * h:.1f}" for u, v in best))
    return paths


# A room's zoom box: its mask's bounding box, grown by a margin so the icons near its
# edge are not cut off, then brought to between 4:3 and 3:2 by growing its short side:
# a narrow room would be a sliver, a wide one a strip a phone shows 150 px tall.
M = 0.05
ASPECT = (4 / 3, 3 / 2)
rooms = []
for rid, room in ROOMS.items():
    mask = Image.open(ROOT / "build" / f"mask_{rid}.png").point(lambda v: 255 if v > 32 else 0)
    x0, y0, x1, y1 = mask.getbbox()
    fx0, fy0, fx1, fy1 = x0 / w - M, y0 / h - M, x1 / w + M, y1 / h + M
    ar = (fx1 - fx0) * w / ((fy1 - fy0) * h)
    if ar < ASPECT[0]:
        grow = ((fy1 - fy0) * h * ASPECT[0] / w - (fx1 - fx0)) / 2
        fx0, fx1 = fx0 - grow, fx1 + grow
    elif ar > ASPECT[1]:
        grow = ((fx1 - fx0) * w / ASPECT[1] / h - (fy1 - fy0)) / 2
        fy0, fy1 = fy0 - grow, fy1 + grow
    clamp = lambda v: round(min(1.0, max(0.0, v)) * 100, 1)
    rooms.append({"id": rid, "name": room["name"],
                  "focus": {"x0": clamp(fx0), "y0": clamp(fy0), "x1": clamp(fx1), "y1": clamp(fy1)}})

card = {"type": "custom:floorplan-card", "image": url("base"), "rooms": rooms,
        "lights": [], "devices": [], "badges": []}
for item in ITEMS:
    x, y = pos[item["spot"]]
    common = {"x": x, "y": y, "room": item["room"]}
    if item["kind"] == "light":
        entry = {"entity": item["entity"], "overlay": url(item["overlay"]),
                 "name": item["name"], "icon": item["icon"], **common}
        if item.get("color"):
            entry["color"] = item["color"]
        card["lights"].append(entry)
    elif item["kind"] == "device":
        entry = {"entity": item["entity"], "name": item["name"], "icon": item["icon"], **common}
        if item.get("value"):
            entry["value"] = item["value"]
        if item.get("flow"):
            entry["flow"] = flow(item["flow"], item["room"])
        card["devices"].append(entry)
    else:
        card["badges"].append({"entities": item["entities"], "name": item.get("name", "Climate"), **common})

doc = json.load(open(DASHBOARD, encoding="utf-8"))
cards = doc["data"]["config"]["views"][0]["cards"]
at = next(i for i, c in enumerate(cards) if c.get("type") == "custom:floorplan-card")
cards[at] = card
DASHBOARD.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
print(f"{DASHBOARD.name}: {len(rooms)} rooms, {len(card['lights'])} lights, "
      f"{len(card['devices'])} devices, {len(card['badges'])} badges")

im = Image.open(ROOT / "build" / "preview_all_on.png").convert("RGB")
d = ImageDraw.Draw(im)
for r in rooms:
    f = r["focus"]
    d.rectangle((f["x0"] / 100 * w, f["y0"] / 100 * h, f["x1"] / 100 * w, f["y1"] / 100 * h), outline=(80, 200, 255))
    d.text((f["x0"] / 100 * w + 4, f["y0"] / 100 * h + 2), r["id"], fill=(80, 200, 255))
for name, (px, py) in pos.items():
    cx, cy = px / 100 * w, py / 100 * h
    d.ellipse((cx - 7, cy - 7, cx + 7, cy + 7), outline=(255, 0, 80), width=3)
    d.text((cx + 9, cy - 6), name, fill=(255, 0, 80))
for dev in card["devices"]:
    for path in dev.get("flow", []):
        d.line([tuple(map(float, p.split())) for p in path[1:].split(" L")], fill=(80, 255, 160), width=2)
im.save(ROOT / "build" / "icon_check.png")
