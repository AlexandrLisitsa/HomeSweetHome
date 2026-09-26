"""Project Sweet Home 3D plan coordinates (cm, y pointing down the plan) into a photo."""
import math
import re
import zipfile


def load(path):
    xml = zipfile.ZipFile(path).read("Home.xml").decode("utf-8")
    cam = re.search(r"<camera attribute='topCamera'[^>]*>", xml).group(0)
    get = lambda k: float(re.search(rf" {k}='([^']*)'", cam).group(1))
    return xml, dict(x=get("x"), y=get("y"), z=get("z"), yaw=get("yaw"),
                     pitch=get("pitch"), fov=get("fieldOfView"))


def projector(cam, width, height, fov_axis="h", mirror=False):
    # World: X east, Y north (plan y flipped), Z up.
    C = (cam["x"], -cam["y"], cam["z"])
    yaw, p = cam["yaw"], cam["pitch"]
    f = (-math.sin(yaw) * math.cos(p), -math.cos(yaw) * math.cos(p), -math.sin(p))
    r = (f[1], -f[0], 0.0)
    n = math.hypot(r[0], r[1]); r = (r[0] / n, r[1] / n, 0.0)
    u = (r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0])
    half = width / 2 if fov_axis == "h" else height / 2
    focal = half / math.tan(cam["fov"] / 2)
    s = -1 if mirror else 1

    def project(x, y, z):
        d = (x - C[0], -y - C[1], z - C[2])
        xc = sum(a * b for a, b in zip(d, r))
        yc = sum(a * b for a, b in zip(d, u))
        zc = sum(a * b for a, b in zip(d, f))
        return (width / 2 + s * focal * xc / zc, height / 2 - focal * yc / zc)
    return project
