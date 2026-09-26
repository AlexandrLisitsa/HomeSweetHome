"""Render-only copy of the model: walls and tall furniture cut, doors and windows hidden, night.

    python FloorPlan/tools/make_render_copy.py

The model is only read. `Home` is left out so Sweet Home 3D loads the edited Home.xml.
"""
import os
import re
from datetime import datetime, timezone
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "model" / "MySweetHome.sh3d"
DST = ROOT / "build" / "MySweetHome-render.sh3d"
DST.parent.mkdir(exist_ok=True)
WALL = 120.0
# 22:00 Kyiv (19:00 UTC) on 2026-09-22: no sun, so only the lamps light the rooms.
NIGHT_MS = int(datetime(2026, 9, 22, 19, 0, tzinfo=timezone.utc).timestamp() * 1000)


def hide(m):
    tag = re.sub(r" visible='[^']*'", "", m.group(0))
    return tag.replace("<doorOrWindow ", "<doorOrWindow visible='false' ", 1)


src = zipfile.ZipFile(SRC)
xml = src.read("Home.xml").decode("utf-8")
xml, walls = re.subn(r"(<wall [^>]*?height=')[0-9.]+'", rf"\g<1>{WALL}'", xml)
xml = re.sub(r" heightAtEnd='[0-9.]+'", f" heightAtEnd='{WALL}'", xml)
xml, openings = re.subn(r"<doorOrWindow [^>]*>", hide, xml)
xml = re.sub(r"(<(?:observerCamera|camera) [^>]*? time=')[0-9]+'", rf"\g<1>{NIGHT_MS}'", xml)


# Tall furniture standing on the floor is cut down with the walls: a 238 cm wardrobe
# over a 120 cm wall reads as a tower, and hides the room behind it. Only floor-standing
# pieces: wall-hung ones (kitchen cabinets, the mirror, the A/Cs) are dealt with below.
def cut(m):
    tag = m.group(0)
    elev = float((re.search(r" elevation='([^']*)'", tag) or [0, "0"])[1])
    height = float(re.search(r" height='([^']*)'", tag).group(1))
    if elev < 10 and height > TALL:
        return re.sub(r" height='[^']*'", f" height='{CUT}'", tag)
    return tag


TALL, CUT = 150.0, 125.0
xml, _ = re.subn(r"<pieceOfFurniture [^>]*>", cut, xml)
cut_down = [n for n in re.findall(rf"<pieceOfFurniture [^>]*name='([^']*)'[^>]*height='{CUT}'", xml)]


# A/Cs hang at about 205 cm, the wall light at 150, the inverter at 110-155, on walls that are now 120 cm: they
# float over nothing. Hang them on the cut wall instead, just below its top. Only these:
# the kitchen's upper cabinets are above the cut too, but they read as cabinets.
def drop(m):
    tag = m.group(0)
    height = float(re.search(r" height='([^']*)'", tag).group(1))
    return re.sub(r" elevation='[^']*'", f" elevation='{WALL - height - 2:.2f}'", tag)


xml, dropped = re.subn(r"<(?:pieceOfFurniture|light) [^>]*name='[^']*(?:A/C|sconce|inverter)'[^>]*>", drop, xml)


# The hall mirror is 120 cm tall from 60 cm up, its shelf on top at 180: both stand
# well over the cut wall, and the mirror alone is as tall as the wall. Shrink it to
# fit under the wall's top, and rest the shelf on it again.
MIRROR = 90.0
MIRROR_TOP = WALL - 4


def set_attrs(tag, **attrs):
    for k, v in attrs.items():
        tag = re.sub(rf" {k}='[^']*'", f" {k}='{v:.2f}'", tag)
    return tag


xml = re.sub(r"<pieceOfFurniture [^>]*name='Hall mirror'[^>]*>",
             lambda m: set_attrs(m.group(0), elevation=MIRROR_TOP - MIRROR, height=MIRROR), xml)
xml = re.sub(r"<pieceOfFurniture [^>]*name='Hall mirror shelf'[^>]*>",
             lambda m: set_attrs(m.group(0), elevation=MIRROR_TOP), xml)


# Ceiling lamps hang at ceiling height over walls cut to 120 cm, so they float too. A
# lamp with a light cannot move -- its light would come from somewhere else -- so its
# shape shrinks to a speck around the same light point: the light sources sit at
# fractions of the shape and the shape keeps its bottom (elevation), so a source on the
# bottom face (z 0) stays exactly where it was. A lamp that is only furniture is hidden.
SPECK = 0.2
CEILING_LAMP = 180.0          # a light hung this high is a ceiling lamp


def speck(m):
    tag = m.group(0)
    if float((re.search(r" elevation='([^']*)'", tag) or [0, "0"])[1]) < CEILING_LAMP:
        return tag                       # the strip under the cabinets, the TV's panel
    # Shrinking keeps x, y (the centre) and elevation (the bottom). The light points
    # move onto the speck's bottom face (z 0): a catalog lamp may put its point inside
    # its shape -- a pendant's sits mid-globe -- and a point inside a closed shape emits
    # nothing. The lamp's light then comes from its bottom, a few cm from where it was.
    for dim in ("width", "depth", "height"):
        tag = re.sub(rf" {dim}='[^']*'", f" {dim}='{SPECK}'", tag)
    return tag


def speck_light(m):
    head = speck(re.match(r"<light [^>]*>", m.group(0)))
    if head == re.match(r"<light [^>]*>", m.group(0)).group(0):
        return m.group(0)                # not a ceiling lamp: untouched
    body = re.sub(r"(<lightSource [^>]*? z=')[^']*'", r"\g<1>0.0'", m.group(0)[m.group(0).index(">") + 1:])
    return head + body


xml = re.sub(r"<light [^>]*>.*?</light>", speck_light, xml, flags=re.S)
xml, hidden_lamps = re.subn(r"<pieceOfFurniture (?![^>]*visible=)([^>]*name='[^']*ceiling lamp'[^>]*)>",
                            r"<pieceOfFurniture visible='false' \1>", xml)

# Bigger photos: the flat fills about half of the frame, so 1600 x 1200 gives it ~830 px,
# stretched onto a Full HD screen. FP_PHOTO=WxH overrides, for a quick test.
PHOTO = tuple(int(v) for v in os.environ.get("FP_PHOTO", "2400x1800").split("x"))
xml = re.sub(r" photoWidth='[^']*'", f" photoWidth='{PHOTO[0]}'", xml, count=1)
xml = re.sub(r" photoHeight='[^']*'", f" photoHeight='{PHOTO[1]}'", xml, count=1)

with zipfile.ZipFile(DST, "w") as out:
    for info in src.infolist():
        if info.filename == "Home":
            continue
        out.writestr(info, xml.encode("utf-8") if info.filename == "Home.xml" else src.read(info.filename))

check = zipfile.ZipFile(DST)
y = check.read("Home.xml").decode("utf-8")
print("zip test:", check.testzip(), "| walls:", walls, "| openings hidden:", openings)
print("cut to", CUT, "cm:", ", ".join(cut_down) or "nothing", "| hung on the cut wall:", dropped)
print("ceiling lamps shrunk to a speck:", ", ".join(re.findall(rf"<light [^>]*name='([^']*)'[^>]*width='{SPECK}'", xml)),
      "| furniture lamps hidden:", hidden_lamps, "| photo", PHOTO)
print("camera in use:", re.search(r"<home [^>]*camera='([^']*)'", y).group(1))
print("aerial camera:", re.search(r"<camera attribute='topCamera'[^>]*>", y).group(0))
print("environment:", re.search(r"<environment[^>]*>", y).group(0))
print("light powers:", re.findall(r"name='(Kitchen[^']*)'[^>]*power='([^']*)'", y))
