"""Turn the renders into a base image plus one light-only overlay per lamp, each masked to its room.

Each overlay is (lit - base), clipped to its room's pixels, so light that spilled over the
cut-down walls onto other rooms or the ground outside is dropped. On the dashboard the
overlays are added onto the base with `mix-blend-mode: plus-lighter`, so any combination of
lights adds up the way light does.

    python FloorPlan/tools/build_overlays.py

Reads renders/ and the camera from the render copy the photos were taken with; writes the
dashboard images straight into HomeAssistant/config/www/floorplan/, and the crop plus the
review images into build/.
"""
import json
import math
import os
import re
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage

from rooms import LIGHTS, ROOMS
from sh3d_camera import load, projector

ROOT = Path(__file__).resolve().parents[1]
RENDER = ROOT / "build" / "MySweetHome-render.sh3d"
SRC = ROOT / "renders"
OUT = ROOT.parent / "HomeAssistant" / "config" / "www" / "floorplan"
BUILD = ROOT / "build"
WALL = 120.0


def denoise(img, r=2, eps=40.0):
    """Edge-preserving smoothing of render speckle: a guided filter, each channel guided
    by the image's own luminance (He et al.). Where the neighbourhood is flat (variance
    well under eps -- SunFlow's grain is a few dozen in 0-255 units) a pixel becomes its
    neighbourhood's mean; across an edge (variance in the thousands) it is kept."""
    a = np.asarray(img, dtype=np.float32)
    guide = a @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    box = lambda x: ndimage.uniform_filter(x, size=2 * r + 1, mode="reflect")
    mg, vg = box(guide), box(guide * guide) - box(guide) ** 2
    out = np.empty_like(a)
    for c in range(3):
        p = a[..., c]
        mp = box(p)
        k = (box(guide * p) - mg * mp) / (vg + eps)
        out[..., c] = box(k) * guide + box(mp - k * mg)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


xml, cam = load(RENDER)
base = denoise(Image.open(os.path.join(SRC, "base.png")).convert("RGB"))
W, H = base.size
P = projector(cam, W, H)


def attrs(tag):
    return {k: v for k, v in re.findall(r" (\w+)='([^']*)'", tag)}


def box_corners(a):
    x, y = float(a["x"]), float(a["y"])
    w, d, h = float(a["width"]), float(a["depth"]), float(a["height"])
    z0 = float(a.get("elevation", 0))
    ang = float(a.get("angle", 0))
    c, s = math.cos(ang), math.sin(ang)
    out = []
    for dx in (-w / 2, w / 2):
        for dy in (-d / 2, d / 2):
            for z in (z0, z0 + h):
                out.append((x + dx * c - dy * s, y + dx * s + dy * c, z))
    return out


def hull(points):
    pts = sorted(set(points))
    if len(pts) < 3:
        return pts
    cross = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


rooms = []
for block in re.findall(r"<room .*?</room>", xml, re.S):
    rooms.append([(float(a), float(b)) for a, b in re.findall(r"<point x='([^']*)' y='([^']*)'", block)])
T = max(float(attrs(t)["thickness"]) for t in re.findall(r"<wall [^>]*>", xml))


def inside(pt, poly):
    x, y = pt
    hit = False
    for (ax, ay), (bx, by) in zip(poly, poly[1:] + poly[:1]):
        if (ay > y) != (by > y) and x < ax + (y - ay) * (bx - ax) / (by - ay):
            hit = not hit
    return hit


def room_mask(poly):
    """The pixels that show this room: floor and inner wall faces up to the wall tops,
    minus its walls that stand between it and the camera (their outer faces belong to
    the room or the ground beyond), plus whatever stands in it and rises above them."""
    mask = Image.new("L", (W, H), 0)
    draw = ImageDraw.Draw(mask)

    def prism(pts, z0, z1, fill):
        for (ax, ay), (bx, by) in zip(pts, pts[1:] + pts[:1]):
            draw.polygon([P(ax, ay, z0), P(bx, by, z0), P(bx, by, z1), P(ax, ay, z1)], fill=fill)
        draw.polygon([P(x, y, z0) for x, y in pts], fill=fill)
        draw.polygon([P(x, y, z1) for x, y in pts], fill=fill)

    prism(poly, 0, WALL, 255)
    # Outward normals depend on the winding; the shoelace sign says which way it runs.
    area = sum(ax * by - bx * ay for (ax, ay), (bx, by) in zip(poly, poly[1:] + poly[:1]))
    turn = 1 if area > 0 else -1
    for (ax, ay), (bx, by) in zip(poly, poly[1:] + poly[:1]):
        L = math.hypot(bx - ax, by - ay)
        if L < 1:
            continue
        nx, ny = turn * (by - ay) / L, -turn * (bx - ax) / L        # outward
        mx, my = (ax + bx) / 2, (ay + by) / 2
        if (cam["x"] - mx) * nx + (cam["y"] - my) * ny > 0:         # camera is outside this edge
            prism([(ax, ay), (bx, by), (bx + nx * T, by + ny * T), (ax + nx * T, ay + ny * T)], 0, WALL, 0)
    for tag in re.findall(r"<(?:pieceOfFurniture|light) [^>]*>", xml):
        a = attrs(tag)
        if a.get("visible") == "false" or not inside((float(a["x"]), float(a["y"])), poly):
            continue
        z0 = float(a.get("elevation", 0))
        z1 = z0 + float(a["height"])
        if z1 > WALL:
            a = dict(a, elevation=str(max(z0, WALL)), height=str(z1 - max(z0, WALL)))
            draw.polygon(hull([P(*c) for c in box_corners(a)]), fill=255)
    return mask.filter(ImageFilter.GaussianBlur(1.5))


# Every room's mask: the lamps' overlays are clipped to theirs, and make_dashboard.py
# zooms the phone layout to each one.
masks = {}
for rid, room in ROOMS.items():
    poly = next((r for r in rooms if inside(room["point"], r)), None)
    if poly is None:
        raise SystemExit(f"{rid}: no room contains {room['point']}")
    masks[rid] = room_mask(poly)
for name, spec in LIGHTS.items():
    spec["mask"] = masks[spec["room"]]

# One crop for all images: the whole apartment, projected, plus a margin.
xs, ys = [], []
for tag in re.findall(r"<wall [^>]*>", xml):
    a = attrs(tag)
    for x, y in ((float(a["xStart"]), float(a["yStart"])), (float(a["xEnd"]), float(a["yEnd"]))):
        for z in (0, WALL):
            u, v = P(x, y, z); xs.append(u); ys.append(v)
for tag in re.findall(r"<(?:pieceOfFurniture|light) [^>]*>", xml):
    for c in box_corners(attrs(tag)):
        u, v = P(*c); xs.append(u); ys.append(v)
M = 24
crop = (max(0, int(min(xs)) - M), max(0, int(min(ys)) - M), min(W, int(max(xs)) + M), min(H, int(max(ys)) + M))

os.makedirs(OUT, exist_ok=True)
os.makedirs(BUILD, exist_ok=True)
json.dump({"crop": crop, "render_size": [W, H]}, open(BUILD / "layout.json", "w"))
b = np.asarray(base, dtype=np.float32)
base.crop(crop).save(os.path.join(OUT, "base.png"), optimize=True)
for rid, mk in masks.items():
    mk.crop(crop).save(os.path.join(BUILD, f"mask_{rid}.png"))
composite = b.copy()
for name, spec in LIGHTS.items():
    m = np.asarray(spec["mask"], dtype=np.float32)[..., None] / 255
    lit = np.asarray(denoise(Image.open(os.path.join(SRC, name + ".png")).convert("RGB")), dtype=np.float32)
    delta = np.clip((lit - b) * spec["gain"], 0, 255) * m
    delta[delta < 2] = 0   # render noise: keeps the black truly black, and the file small
    composite += delta
    Image.fromarray(delta.astype(np.uint8)).crop(crop).save(os.path.join(OUT, name + ".png"), optimize=True)
Image.fromarray(np.clip(composite, 0, 255).astype(np.uint8)).crop(crop).save(os.path.join(BUILD, "preview_all_on.png"))

print("crop", crop, "->", crop[2] - crop[0], "x", crop[3] - crop[1])
for f in sorted(os.listdir(OUT)):
    print(f"  {f:28s} {os.path.getsize(os.path.join(OUT, f)) // 1024:5d} KB")
