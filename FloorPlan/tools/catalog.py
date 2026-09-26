"""Search every furniture catalog installed with Sweet Home 3D.

    python FloorPlan/tools/catalog.py wardrobe
    python FloorPlan/tools/catalog.py "air cond|conditioner"      # a regex

Reads the default catalog in lib/Furniture.jar and every library in data/furniture/*.sh3f
of the portable copy in FloorPlan/SweetHome3D/ (SH3D=<dir> overrides; same default as render.sh), and prints id,
name, category, size and elevation of each match -- the id is what a piece's `catalogId`
names. The furniture in model/MySweetHome.sh3d came from here: the default catalog plus
the Blend Swap, Contributions, Kator Legaz, Luca Presidente, Reallusion and Scopia
libraries.
"""
import glob
import os
import re
import sys
import zipfile

SH3D = os.environ.get("SH3D", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "SweetHome3D"))


def parse(text):
    """Java .properties, enough of it: continuation lines and \\u escapes."""
    props, buf = {}, ""
    for raw in text.splitlines():
        line = raw.rstrip()
        if not buf and (not line.strip() or line.lstrip().startswith(("#", "!"))):
            continue
        buf += line.lstrip() if buf else line
        if buf.endswith("\\") and not buf.endswith("\\\\"):
            buf = buf[:-1]
            continue
        m = re.match(r"\s*([^=:\s]+)\s*[=:]\s*(.*)", buf)
        if m:
            v = m.group(2)
            if "\\u" in v:
                v = v.encode("latin-1", "replace").decode("unicode_escape", "replace")
            props[m.group(1)] = v
        buf = ""
    return props


def items():
    sources = [(os.path.join(SH3D, "lib", "Furniture.jar"), "com/eteks/sweethome3d/io/DefaultFurnitureCatalog.properties")]
    sources += [(f, "PluginFurnitureCatalog.properties") for f in sorted(glob.glob(os.path.join(SH3D, "data", "furniture", "*.sh3f")))]
    for path, entry in sources:
        props = parse(zipfile.ZipFile(path).read(entry).decode("latin-1"))
        for i in sorted({int(k.split("#")[1]) for k in props if k.startswith("id#") and k.split("#")[1].isdigit()}):
            g = lambda k: props.get(f"{k}#{i}", "")
            yield {"lib": os.path.basename(path), "id": g("id"), "name": g("name"), "category": g("category"),
                   "size": f"{g('width')} x {g('depth')} x {g('height')}", "elevation": g("elevation") or "0",
                   "light": bool(g("lightSourceX") or g("lightSourceMaterialName")), "tags": g("tags"),
                   "door": g("doorOrWindow") == "true"}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    pattern = re.compile(" ".join(sys.argv[1:]), re.I)
    hits = [i for i in items() if pattern.search(f"{i['name']} {i['tags']}")]
    for i in hits:
        print(f"{i['id']:48s} {i['name'][:34]:34s} {i['category'][:14]:14s} {i['size']:24s} "
              f"el {i['elevation']:>6s}{'  light' if i['light'] else ''}{'  door/window' if i['door'] else ''}")
    print(f"{len(hits)} match(es)")
