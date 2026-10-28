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
import heapq
import json
import math
import re
from pathlib import Path

from PIL import Image, ImageDraw

from rooms import DAY, ITEMS, POWER, ROOMS, SPOTS
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


# The power path runs like real wiring: along the tops of the walls, which the render copy
# cuts to WALL_Z, and only at the end straight to the thing's icon, from the point on a
# wall top that looks nearest to it in the picture, so the bit in the air is as short as
# it can be. The walls are a graph: the model does not split a wall where another meets it
# mid-length, draws some twice, and stops some a few cm short of the wall they meet, so
# every wall is split at every wall end lying on it and points closer than SNAP (a wall's
# thickness) are one node. A doorway is no gap: the model's wall runs on through it, as
# wiring runs over the lintel. Shared walls carry overlapping wires, so a run reads as one
# trunk. Paths are in pixels of the picture.
WALL_Z = 120.0
SNAP = 8.0
STEP = 5.0
HUB = POWER["hub"]


def pixel(x, y, z):
    u, v = pct(x, y, z)
    return (u / 100 * w, v / 100 * h)


def wall_graph():
    walls = []
    for tag in re.findall(r"<wall [^>]*>", xml):
        a = dict(re.findall(r" (\w+)='([^']*)'", tag))
        walls.append(((float(a["xStart"]), float(a["yStart"])), (float(a["xEnd"]), float(a["yEnd"])),
                      float(a["thickness"])))
    nodes, edges = [], {}

    def node(p):
        for i, q in enumerate(nodes):
            if math.dist(p, q) < SNAP:
                return i
        nodes.append(p)
        edges[len(nodes) - 1] = {}
        return len(nodes) - 1

    ends = [p for a, b, _ in walls for p in (a, b)]
    for a, b, thick in walls:
        length = math.dist(a, b)
        if length < SNAP:
            continue
        ux, uy = (b[0] - a[0]) / length, (b[1] - a[1]) / length
        on = []
        for p in ends:
            t = (p[0] - a[0]) * ux + (p[1] - a[1]) * uy
            if -SNAP <= t <= length + SNAP and abs((p[0] - a[0]) * uy - (p[1] - a[1]) * ux) <= thick / 2 + 1:
                on.append(min(length, max(0.0, t)))
        stops = sorted({node((a[0] + ux * t, a[1] + uy * t)) for t in on + [0.0, length]},
                       key=lambda i: (nodes[i][0] - a[0]) * ux + (nodes[i][1] - a[1]) * uy)
        for i, j in zip(stops, stops[1:]):
            if i != j:
                edges[i][j] = edges[j][i] = math.dist(nodes[i], nodes[j])
    return nodes, edges


def attach(graph, spot):
    """The node on a wall top that looks nearest the icon of `spot`, splitting that wall there."""
    nodes, edges = graph
    icon = pixel(*spot)
    best = None
    for i in edges:
        for j in edges[i]:
            if i > j:
                continue
            (ax, ay), (bx, by) = nodes[i], nodes[j]
            n = max(1, int(math.dist(nodes[i], nodes[j]) / STEP))
            for s in range(n + 1):
                q = (ax + (bx - ax) * s / n, ay + (by - ay) * s / n)
                d = math.dist(icon, pixel(*q, WALL_Z))
                if best is None or d < best[0]:
                    best = (d, q, i, j)
    _, q, i, j = best
    for k in (i, j):
        if math.dist(q, nodes[k]) < SNAP:
            return k
    nodes.append(q)
    k = len(nodes) - 1
    del edges[i][j], edges[j][i]
    edges[k] = {i: math.dist(q, nodes[i]), j: math.dist(q, nodes[j])}
    edges[i][k], edges[j][k] = edges[k][i], edges[k][j]
    return k


def shortest(graph, a, b):
    nodes, edges = graph
    dist, back, todo = {a: 0.0}, {}, [(0.0, a)]
    while todo:
        d, i = heapq.heappop(todo)
        if i == b:
            break
        if d > dist[i]:
            continue
        for j, length in sorted(edges[i].items()):
            if d + length < dist.get(j, math.inf):
                dist[j], back[j] = d + length, i
                heapq.heappush(todo, (d + length, j))
    path = [b]
    while path[-1] != a:
        path.append(back[path[-1]])
    return path[::-1]


def bevel(points, r=5.0):
    """Corners cut by r px each way: crisp like wiring, without a hairline spike."""
    out = [points[0]]
    for prev, p, nxt in zip(points, points[1:], points[2:]):
        for q in (prev, nxt):
            d = math.dist(p, q)
            k = min(r, d / 2) / d if d else 0
            out.append((p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k))
    out.append(points[-1])
    return "M" + " L".join(f"{u:.1f} {v:.1f}" for u, v in out)


WALLS = wall_graph()
ATTACHED = {}


def route(start, end):
    """From the icon at spot `start`, up onto the wall tops, along them, down to spot `end`."""
    for s in (start, end):
        if s not in ATTACHED:
            ATTACHED[s] = attach(WALLS, SPOTS[s])
    on_walls = [WALLS[0][i] for i in shortest(WALLS, ATTACHED[start], ATTACHED[end])]
    return bevel([pixel(*SPOTS[start])] + [pixel(x, y, WALL_Z) for x, y in on_walls] + [pixel(*SPOTS[end])])


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
    entry = {"id": rid, "name": room["name"],
             "focus": {"x0": clamp(fx0), "y0": clamp(fy0), "x1": clamp(fx1), "y1": clamp(fy1)}}
    # A room with a thermometer: its floor tints by the badge's first reading, the °C.
    badge = next((i for i in ITEMS if i["kind"] == "badge" and i["room"] == rid), None)
    if badge:
        entry["tint"] = url(f"tint_{rid}")
        entry["temperature"] = badge["entities"][0]
    rooms.append(entry)

card = {"type": "custom:floorplan-card", "image": url("base"),
        "day_image": url(DAY["image"]), "sun": DAY["sun"], "rooms": rooms,
        "lights": [], "devices": [], "badges": [], "presence": []}
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
    elif item["kind"] == "presence":
        card["presence"].append({"entity": item["entity"], "name": item["name"], "icon": item["icon"], **common})
    else:
        card["badges"].append({"entities": item["entities"], "name": item.get("name", "Climate"), **common})

# What the inverter feeds: every lamp, plug and screen, each by its own path. A sensor
# is not a load, and an A/C draws through its plug, so the plug carries its stream.
loads = []
for item in ITEMS:
    domain = item.get("entity", "").split(".")[0]
    if item["kind"] == "light" or domain in ("switch", "media_player"):
        load = {"entity": item["entity"], "room": item["room"], "path": route(HUB, item["spot"])}
        if item.get("value"):
            load["value"] = item["value"]
        loads.append(load)
card["power"] = {
    **{k: v for k, v in POWER.items() if k not in ("hub", "grid_in", "battery")},
    "grid_path": route(POWER["grid_in"], HUB),
    "battery_path": route(POWER["battery"], HUB),
    "battery_entity": next(i["entity"] for i in ITEMS if i.get("spot") == POWER["battery"]),
    "loads": loads,
}

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
for path, colour in ([(l["path"], (110, 168, 254)) for l in loads]
                     + [(card["power"]["grid_path"], (174, 132, 70)), (card["power"]["battery_path"], (88, 149, 105))]):
    d.line([tuple(map(float, p.split())) for p in path[1:].split(" L")], fill=colour, width=2)
im.save(ROOT / "build" / "icon_check.png")
