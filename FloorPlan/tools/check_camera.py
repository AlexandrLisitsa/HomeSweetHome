"""Check the camera in the render copy is the one base.png was actually taken with.

    python FloorPlan/tools/check_camera.py

Projects every wall top at a range of heights and scores how well each lands on edges in
base.png. The real wall height (120 cm in the render copy) must win by a wide margin; if it
does not, the view was moved after the copy was saved, every icon and mask will be off, and
the fix is to save the render copy from the view the photos were taken with.
"""
import math
import re
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

from sh3d_camera import load, projector

ROOT = Path(__file__).resolve().parents[1]
xml, cam = load(ROOT / "build" / "MySweetHome-render.sh3d")
img = np.asarray(Image.open(ROOT / "renders" / "base.png").convert("L"), dtype=float)
H, W = img.shape
edges = np.hypot(ndimage.sobel(img, 0), ndimage.sobel(img, 1))
P = projector(cam, W, H)

walls = []
for m in re.findall(r"<wall [^>]*>", xml):
    g = lambda k: float(re.search(rf" {k}='([^']*)'", m).group(1))
    walls.append((g("xStart"), g("yStart"), g("xEnd"), g("yEnd"), g("thickness"), g("height")))


def score(z):
    pts = []
    for x0, y0, x1, y1, t, _ in walls:
        L = math.hypot(x1 - x0, y1 - y0)
        if L < 1:
            continue
        nx, ny = -(y1 - y0) / L * t / 2, (x1 - x0) / L * t / 2
        for s in np.linspace(0.03, 0.97, max(6, int(L / 8))):
            for k in (-1, 1):
                pts.append(P(x0 + (x1 - x0) * s + k * nx, y0 + (y1 - y0) * s + k * ny, z))
    uv = np.array(pts)
    return ndimage.map_coordinates(edges, [uv[:, 1], uv[:, 0]], order=1, mode="constant").mean()


real = walls[0][5]
scores = {z: score(z) for z in sorted({80.0, 100.0, real, 140.0, 160.0, 200.0})}
for z, s in scores.items():
    print(f"  wall tops at {z:5.0f} cm: {s:6.1f}{'   <- the render copy' if z == real else ''}")
others = max(s for z, s in scores.items() if z != real)
ok = scores[real] > 2 * others
print("OK: camera matches the photos" if ok else "MISMATCH: the photos were not taken from this camera")
raise SystemExit(0 if ok else 1)
