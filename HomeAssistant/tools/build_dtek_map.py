"""Build static hex-mosaic geometry and YASNO queue mapping for the DTEK map.

    python HomeAssistant/tools/build_dtek_map.py
    python HomeAssistant/tools/build_dtek_map.py --refresh   # ignore cached HTTP lookups

Generates HomeAssistant/config/www/dtek-map-data.json from:
  1. Official Ukrainian oblast & 7-raion boundaries (GeoJSON on GitHub).
  2. GeoNames UA.zip populated places in Dnipropetrovsk Oblast (admin1=04).
  3. YASNO public address lookup API (regionId=3, dsoId=301) for settlements,
     major cities, and sampled streets across Dnipro.
  4. OSM Nominatim geocoder for street-level coordinates inside Dnipro and major
     oblast cities (and fallback for small settlements missing in GeoNames).

Intermediate downloads and API caches live under HomeAssistant/.state/ (which is
gitignored), so re-runs resume cleanly and only the aggregated, non-personal hex
file HomeAssistant/config/www/dtek-map-data.json is committed.
"""
import argparse
import io
import json
import math
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

KYIV = ZoneInfo("Europe/Kyiv")
ROOT = Path(__file__).resolve().parents[1]
CACHE_DIR = ROOT / ".state" / "dtek-map-cache"
OUT_PATH = ROOT / "config" / "www" / "dtek-map-data.json"

REGIONY_URL = "https://raw.githubusercontent.com/slawomirmatuszak/ukrainian_geodata/main/regiony.geojson"
RAYONY_URL = "https://raw.githubusercontent.com/slawomirmatuszak/ukrainian_geodata/main/rayony.geojson"
GEONAMES_UA_URL = "https://download.geonames.org/export/dump/UA.zip"
YASNO_ADDR_BASE = "https://app.yasno.ua/api/blackout-service/public/shutdowns/addresses/v2"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
_LAST_NOMINATIM_AT = 0.0
_NOMINATIM_MISSES = 0

MAJOR_CITY_STREET_CAP = {
    "Кривий Ріг": 12,
    "Кам'янське": 8,
    "Павлоград": 6,
    "Нікополь": 6,
}
DEFAULT_MAJOR_CITY_CAP = 4
PRIORITY_DNIPRO_TOKENS = (
    "Калинова", "Слобожан", "Перемоги", "Робоча", "Тітова", "Науки", "Поля",
    "Яворницького", "Парус", "Покров", "Придніпр", "Лівобереж", "Топол",
    "Сокол", "Ігрень", "Березин", "Криворіз", "Донецьке", "Запоріз", "Метробуд",
)

# Post-2020 Dnipropetrovsk Oblast raions in rayony.geojson (fid -> current Ukrainian label)
DNIPRO_RAION_FIDS = {
    40: "Синельниківський",
    41: "Дніпровський",
    42: "Самарівський",   # renamed from Новомосковський in 2024
    43: "Криворізький",
    44: "Нікопольський",
    45: "Кам'янський",
    46: "Павлоградський",
}

# Real polylines (lon, lat) for Dnipro and Samara rivers inside Dnipropetrovsk Oblast
OBLAST_RIVERS = [
    # Dnipro River from NW oblast border through Kamianske, Dnipro, to southern edge
    [[34.06, 48.84], [34.26, 48.72], [34.48, 48.59], [34.60, 48.53], [34.86, 48.49],
     [35.04, 48.475], [35.09, 48.45], [35.13, 48.35], [35.13, 48.20], [35.12, 48.03]],
    # Former Kakhovka reservoir shore (Zaporizhzhia / Nikopol / Pokrov)
    [[34.86, 47.74], [34.62, 47.62], [34.36, 47.55], [34.12, 47.56], [33.90, 47.47]],
    # Samara River through Pavlohrad & Samar into Dnipro
    [[36.58, 48.57], [36.22, 48.54], [35.87, 48.53], [35.52, 48.56], [35.24, 48.63],
     [35.15, 48.52], [35.10, 48.47]],
]

DNIPRO_RIVERS = [
    # Dnipro River channel across Dnipro city bounds (lon 34.82..35.22, lat 48.36..48.56)
    [[34.81, 48.462], [34.88, 48.475], [34.95, 48.485], [35.01, 48.476],
     [35.055, 48.471], [35.082, 48.456], [35.095, 48.422], [35.12, 48.382], [35.14, 48.35]],
    # Samara River mouth joining Dnipro on the Left Bank
    [[35.23, 48.525], [35.17, 48.495], [35.125, 48.476], [35.092, 48.458]],
]

REFERENCE_CITIES = [
    {"name": "Дніпро", "lon": 35.046, "lat": 48.465, "major": True},
    {"name": "Кривий Ріг", "lon": 33.394, "lat": 47.906, "major": True},
    {"name": "Кам'янське", "lon": 34.606, "lat": 48.517, "major": True},
    {"name": "Павлоград", "lon": 35.869, "lat": 48.532, "major": True},
    {"name": "Нікополь", "lon": 34.391, "lat": 47.568, "major": True},
    {"name": "Самар", "lon": 35.259, "lat": 48.629, "major": False},
    {"name": "Синельникове", "lon": 35.526, "lat": 48.324, "major": False},
    {"name": "Жовті Води", "lon": 33.497, "lat": 48.345, "major": False},
    {"name": "Марганець", "lon": 34.625, "lat": 47.631, "major": False},
    {"name": "Покров", "lon": 34.115, "lat": 47.654, "major": False},
    {"name": "Шахтарське", "lon": 36.396, "lat": 48.348, "major": False},
]

# Multi-hex oblast cities where street-level geocoding enriches spatial fidelity
MAJOR_OBLAST_CITIES = {
    "Кривий Ріг": (33.394, 47.906, 0.19, 0.16),
    "Кам'янське": (34.606, 48.517, 0.12, 0.09),
    "Павлоград": (35.869, 48.532, 0.10, 0.07),
    "Нікополь": (34.391, 47.568, 0.09, 0.06),
    "Самар": (35.259, 48.629, 0.09, 0.07),
    "Новомосковськ": (35.259, 48.629, 0.09, 0.07),
    "Синельникове": (35.526, 48.324, 0.07, 0.05),
    "Марганець": (34.625, 47.631, 0.07, 0.05),
    "Покров": (34.115, 47.654, 0.07, 0.05),
    "Жовті Води": (33.497, 48.345, 0.06, 0.05),
    "Підгороднє": (35.106, 48.575, 0.07, 0.05),
    "Тернівка": (36.082, 48.524, 0.06, 0.05),
    "Шахтарське": (36.396, 48.348, 0.06, 0.05),
    "Першотравенськ": (36.396, 48.348, 0.06, 0.05),
}

# GeoNames spelling differences / 2024 renames
CITY_ALIASES = {
    "самар": ["новомосковськ", "novomoskovsk", "samar"],
    "шахтарське": ["першотравенськ", "pershotravensk", "shakhtarske"],
    "слабожанське": ["слобожанське", "ювілейне"],
    "слобожанське": ["ювілейне", "slobozhanske"],
    "підгороднє": ["підгородне", "pidhorodne"],
    "брагинівка": ["богинівка", "bohinivka"],
    "іларіонове": ["яворницьке", "ilarionove"],
    "кринички": ["krynychky"],
    "пятихатки": ["п'ятихатки", "pyatykhatky"],
    "камянське": ["кам'янське", "kamyanske", "dniprodzerzhynsk"],
    "марївка": ["мар'ївка"],
}

DNIPRO_CITY_BBOX = (34.82, 48.35, 35.24, 48.57)  # min_lon, min_lat, max_lon, max_lat
DNIPRO_ZOOM_BOUNDS = (34.84, 48.365, 35.22, 48.56)

DNIPRO_DISTRICT_LABELS = [
    {"name": "Лівий берег", "lon": 35.065, "lat": 48.545, "bank": True},
    {"name": "Правий берег", "lon": 34.935, "lat": 48.382, "bank": True},
    {"name": "Центр", "lon": 35.046, "lat": 48.464},
    {"name": "Перемога", "lon": 35.068, "lat": 48.420},
    {"name": "Тополя", "lon": 35.016, "lat": 48.404},
    {"name": "Парус / Покровський", "lon": 34.935, "lat": 48.485},
    {"name": "Лівобережний", "lon": 35.035, "lat": 48.532},
    {"name": "Калинова", "lon": 35.075, "lat": 48.514},
    {"name": "Придніпровськ", "lon": 35.125, "lat": 48.402},
    {"name": "Робоча / Тітова", "lon": 35.002, "lat": 48.436},
]

UKR_LETTERS = list("АБВГҐДЕЄЖЗИІЇЙКЛМНОПРСТУФХЦЧШЩЮЯ")


def log(msg):
    print("[map-build] " + msg, flush=True)


def http_get(url, params=None, retries=4, timeout=18, binary=False):
    if params:
        url = url + ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    last_exc = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": "HomeSweetHome-dtek-map-builder/1.0",
                    "Accept": "*/*",
                    "Connection": "close",
                },
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                return raw if binary else raw.decode("utf-8", "replace")
        except Exception as exc:
            last_exc = exc
            time.sleep(0.35 * (attempt + 1))
    raise RuntimeError(f"GET failed for {url}: {last_exc}")


def cached_download(filename, url, refresh=False, binary=False):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / filename
    if path.exists() and not refresh:
        return path.read_bytes() if binary else path.read_text(encoding="utf-8")
    log(f"Downloading {filename} ...")
    data = http_get(url, retries=4, timeout=45, binary=True)
    path.write_bytes(data)
    return data if binary else data.decode("utf-8", "replace")


def load_json_cache(name, default):
    path = CACHE_DIR / name
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return default


def save_json_cache(name, data):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CACHE_DIR / (name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    tmp.replace(CACHE_DIR / name)


def norm_name(s):
    s = (s or "").strip().lower()
    s = s.replace("’", "'").replace("ʼ", "'").replace("`", "'").replace("'", "")
    s = re.sub(r"^(м\.|смт\.?|с-ще|с\.|сел\.|місто)\s*", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def queue_sort_key(q):
    m = re.match(r"^(\d+)\.(\d+)$", str(q))
    if m:
        return (int(m.group(1)), int(m.group(2)), "")
    return (9999, 9999, str(q))


# --- Geometry helpers ---

def dp_simplify(pts, eps):
    if len(pts) <= 3:
        return pts
    x1, y1 = pts[0]
    x2, y2 = pts[-1]
    dx, dy = x2 - x1, y2 - y1
    denom = math.hypot(dx, dy)
    best_d, best_i = -1.0, 0
    for i in range(1, len(pts) - 1):
        px, py = pts[i]
        if denom == 0:
            d = math.hypot(px - x1, py - y1)
        else:
            d = abs(dy * px - dx * py + x2 * y1 - y2 * x1) / denom
        if d > best_d:
            best_d, best_i = d, i
    if best_d > eps:
        left = dp_simplify(pts[: best_i + 1], eps)
        right = dp_simplify(pts[best_i:], eps)
        return left[:-1] + right
    return [pts[0], pts[-1]]


def point_in_poly(x, y, poly):
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def make_projector(bounds, vb_w, vb_h, pad):
    min_lon, min_lat, max_lon, max_lat = bounds
    mid_lat = (min_lat + max_lat) / 2.0
    cos_lat = math.cos(math.radians(mid_lat))
    span_x = (max_lon - min_lon) * cos_lat
    span_y = max_lat - min_lat
    usable_w = vb_w - 2 * pad
    usable_h = vb_h - 2 * pad
    scale = min(usable_w / span_x, usable_h / span_y)
    ox = (vb_w - span_x * scale) / 2.0
    oy = (vb_h - span_y * scale) / 2.0

    def proj(lon, lat):
        x = ox + (lon - min_lon) * cos_lat * scale
        y = vb_h - (oy + (lat - min_lat) * scale)
        return [round(x, 1), round(y, 1)]

    return proj


def hex_points_str(cx, cy, r):
    pts = []
    for k in range(6):
        ang = math.radians(60 * k - 30)
        pts.append(f"{cx + r * math.cos(ang):.1f},{cy + r * math.sin(ang):.1f}")
    return " ".join(pts)


def load_boundaries(refresh=False):
    reg_raw = json.loads(cached_download("regiony.geojson", REGIONY_URL, refresh=refresh))
    dn_feat = next(f for f in reg_raw["features"] if f["properties"].get("region") == "Дніпропетровська область")
    geom = dn_feat["geometry"]
    rings = geom["coordinates"] if geom["type"] == "Polygon" else [p[0] for p in geom["coordinates"]]
    main_ring = max(rings, key=len)
    border_geo = dp_simplify([(round(pt[0], 4), round(pt[1], 4)) for pt in main_ring[:-1]], 0.0055)

    ray_raw = json.loads(cached_download("rayony.geojson", RAYONY_URL, refresh=refresh))
    raions = []
    for f in ray_raw["features"]:
        fid = f["properties"].get("fid")
        if fid not in DNIPRO_RAION_FIDS:
            continue
        g = f["geometry"]
        r_rings = g["coordinates"] if g["type"] == "Polygon" else [p[0] for p in g["coordinates"]]
        outer = max(r_rings, key=len)
        simp = dp_simplify([(round(pt[0], 4), round(pt[1], 4)) for pt in outer[:-1]], 0.0065)
        raions.append({"name": DNIPRO_RAION_FIDS[fid], "ring": simp})

    return border_geo, raions


def load_geonames(border_geo, refresh=False):
    raw_zip = cached_download("UA.zip", GEONAMES_UA_URL, refresh=refresh, binary=True)
    zf = zipfile.ZipFile(io.BytesIO(raw_zip))
    lines = zf.read("UA.txt").decode("utf-8").splitlines()
    index = defaultdict(list)
    all_places = []
    for ln in lines:
        p = ln.split("\t")
        if len(p) < 15 or p[10] != "04" or p[6] != "P":
            continue
        lat, lon = float(p[4]), float(p[5])
        if not point_in_poly(lon, lat, border_geo):
            continue
        pop = int(p[14] or 0)
        names = {p[1], p[2]}
        if p[3]:
            names.update(x.strip() for x in p[3].split(",") if x.strip())
        rec = {"name": p[1], "lon": lon, "lat": lat, "pop": pop}
        all_places.append(rec)
        for nm in names:
            k = norm_name(nm)
            if k:
                index[k].append(rec)
    for k in index:
        index[k].sort(key=lambda r: -r["pop"])
    log(f"Loaded {len(all_places)} Dnipropetrovsk GeoNames places ({len(index)} normalized keys)")
    return index, all_places


# --- YASNO & Photon fetchers ---

def yasno_get(path, params):
    txt = http_get(f"{YASNO_ADDR_BASE}/{path}", params=params, retries=4, timeout=14)
    return json.loads(txt)


def fetch_all_yasno_cities(refresh=False):
    cache = {} if refresh else load_json_cache("yasno_cities.json", {})
    if cache.get("cities"):
        return cache["cities"]
    seen = {}
    for pref in ("м.", "смт", "с-ще", "с."):
        items = yasno_get("cities", {"regionId": 3, "dsoId": 301, "query": pref})
        for it in items:
            seen[int(it["id"])] = it["value"]
    cities = [{"id": cid, "value": val} for cid, val in sorted(seen.items())]
    save_json_cache("yasno_cities.json", {"cities": cities})
    log(f"Fetched {len(cities)} YASNO settlements")
    return cities


def match_city_coords(city_val, geonames_idx):
    key = norm_name(city_val)
    cands = geonames_idx.get(key)
    if cands:
        return cands[0]["lon"], cands[0]["lat"]
    for alias in CITY_ALIASES.get(key, []):
        cands = geonames_idx.get(norm_name(alias))
        if cands:
            return cands[0]["lon"], cands[0]["lat"]
    # Try stripping trailing parenthetical or hyphenated part
    if "(" in key:
        base = key.split("(", 1)[0].strip()
        if geonames_idx.get(base):
            return geonames_idx[base][0]["lon"], geonames_idx[base][0]["lat"]
    return None


def expand_street_prefix(s):
    s = (s or "").strip()
    repl = (
        (r"^вул\.\s*", "вулиця "),
        (r"^просп\.\s*", "проспект "),
        (r"^пров\.\s*", "провулок "),
        (r"^наб\.\s*", "набережна "),
        (r"^пл\.\s*", "площа "),
        (r"^ж/м\s*", "житловий масив "),
    )
    for pat, sub in repl:
        ns = re.sub(pat, sub, s, flags=re.I)
        if ns != s:
            return ns
    return s


def nominatim_geocode(query, bbox, geo_cache):
    global _LAST_NOMINATIM_AT, _NOMINATIM_MISSES
    ckey = f"{query}|{bbox}"
    if ckey in geo_cache:
        return geo_cache[ckey], False
    min_lon, min_lat, max_lon, max_lat = bbox
    params = {
        "q": query,
        "format": "json",
        "limit": 2,
        "viewbox": f"{min_lon},{max_lat},{max_lon},{min_lat}",
        "bounded": 1,
    }
    url = NOMINATIM_URL + "?" + urllib.parse.urlencode(params)
    best = None
    for attempt in range(2):
        wait = 1.05 - (time.monotonic() - _LAST_NOMINATIM_AT)
        if wait > 0:
            time.sleep(wait)
        _LAST_NOMINATIM_AT = time.monotonic()
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": "HomeSweetHome-dtek-map-builder/1.0 (local-ha-tool)",
                    "Accept": "application/json",
                    "Accept-Language": "uk",
                    "Connection": "close",
                },
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8", "replace"))
            for item in data or []:
                lon = float(item["lon"])
                lat = float(item["lat"])
                if min_lon <= lon <= max_lon and min_lat <= lat <= max_lat:
                    best = [round(lon, 5), round(lat, 5)]
                    break
            break
        except Exception as exc:
            _NOMINATIM_MISSES += 1
            if _NOMINATIM_MISSES <= 5:
                log(f"Nominatim warn on {query!r}: {exc}")
            time.sleep(0.5 * (attempt + 1))
    geo_cache[ckey] = best
    return best, True


def sample_city_queue(city_id, city_val):
    """Query 1-2 streets and up to 3 houses for a non-major settlement."""
    streets = []
    for sq in ("вул.", "Центр", "Шевч", "Миру", "Садов", "Молод", "Степ"):
        try:
            res = yasno_get("streets", {"regionId": 3, "dsoId": 301, "cityId": city_id, "query": sq})
            if res:
                streets = res
                break
        except Exception:
            continue
    if not streets:
        return []
    queues = []
    for st in streets[:2]:
        houses = []
        for hq in ("1", "2", "5", "10"):
            try:
                res = yasno_get("houses", {"regionId": 3, "dsoId": 301, "cityId": city_id, "streetId": st["id"], "query": hq})
                if res:
                    houses = res
                    break
            except Exception:
                continue
        for h in houses[:2]:
            try:
                g = yasno_get("group", {"regionId": 3, "dsoId": 301, "cityId": city_id, "streetId": st["id"], "houseId": h["id"]})
                grp = g.get("group")
                sub = g.get("subgroup") or 1
                if grp:
                    queues.append(f"{grp}.{sub}")
            except Exception:
                continue
        if len(queues) >= 2:
            break
    return queues


def collect_dnipro_streets(refresh=False):
    cache = {} if refresh else load_json_cache("dnipro_streets.json", {})
    if cache.get("streets"):
        return cache["streets"]

    queries = ["просп. ", "ж/м ", "наб.", "шосе", "узв", "пл."]
    queries += [f"вул. {ch}" for ch in UKR_LETTERS]
    queries += [f"пров. {ch}" for ch in ("А", "Б", "В", "Г", "Д", "К", "Л", "М", "Н", "О", "П", "Р", "С", "Т", "Ш")]
    # Named major arterials across Left and Right banks so sparse letters stay well covered
    queries += [
        "Калинова", "Слобожан", "Перемоги", "Робоча", "Тітова", "Науки", "Поля",
        "Хмельницького", "Яворницького", "Парус", "Покров", "Придніпр", "Мануйл",
        "Янтарна", "Березин", "Криворіз", "Донецьке", "Запоріз", "Косміч", "Соняч",
        "Метробуд", "Зоряна", "Київська", "Топол", "Сокол", "Ігрень", "Амур",
    ]
    seen = {}

    def fetch_q(q):
        return yasno_get("streets", {"regionId": 3, "dsoId": 301, "cityId": 5, "query": q})

    with ThreadPoolExecutor(max_workers=6) as pool:
        futs = {pool.submit(fetch_q, q): q for q in queries}
        for fut in as_completed(futs):
            try:
                for it in fut.result() or []:
                    seen[int(it["id"])] = it["value"]
            except Exception:
                pass

    streets = [{"id": sid, "value": val} for sid, val in sorted(seen.items())]
    save_json_cache("dnipro_streets.json", {"streets": streets})
    log(f"Collected {len(streets)} unique Dnipro streets from YASNO")
    return streets


def sample_street_queues(city_id, street_id):
    houses = []
    for hq in ("1", "2", "3", "5", "10", "12"):
        try:
            res = yasno_get("houses", {"regionId": 3, "dsoId": 301, "cityId": city_id, "streetId": street_id, "query": hq})
            if res:
                houses = res
                break
        except Exception:
            continue
    out = []
    for h in houses[:3]:
        try:
            g = yasno_get("group", {"regionId": 3, "dsoId": 301, "cityId": city_id, "streetId": street_id, "houseId": h["id"]})
            grp = g.get("group")
            sub = g.get("subgroup") or 1
            if grp:
                out.append(f"{grp}.{sub}")
        except Exception:
            continue
    return out


def collect_major_city_street_samples(cities, refresh=False):
    cache = {} if refresh else load_json_cache("major_city_samples.json", {})
    if cache.get("samples"):
        return cache["samples"]
    geo_cache = {} if refresh else load_json_cache("nominatim_cache.json", {})
    targets = []
    for c in cities:
        base = norm_name(c["value"])
        for mname, info in MAJOR_OBLAST_CITIES.items():
            if base == norm_name(mname):
                targets.append((c["id"], c["value"], mname, info))
                break

    street_queries = ["просп. ", "вул. А", "вул. В", "вул. Г", "вул. К", "вул. М", "вул. П", "вул. С", "вул. Т", "вул. Ш"]
    street_jobs = []
    seen_street = set()
    for cid, cval, mname, info in targets:
        cap = MAJOR_CITY_STREET_CAP.get(mname, DEFAULT_MAJOR_CITY_CAP)
        city_added = 0
        for sq in street_queries:
            if city_added >= cap:
                break
            try:
                res = yasno_get("streets", {"regionId": 3, "dsoId": 301, "cityId": cid, "query": sq})
            except Exception:
                res = []
            for st in (res or [])[:3]:
                if city_added >= cap:
                    break
                key = (cid, st["id"])
                if key not in seen_street:
                    seen_street.add(key)
                    street_jobs.append((cid, cval, mname, info, st["id"], st["value"]))
                    city_added += 1

    log(f"Sampling YASNO queues for {len(street_jobs)} streets across {len(targets)} major oblast cities ...")
    street_queues = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        futs = {pool.submit(sample_street_queues, cid, sid): (cid, cval, mname, info, sid, sval)
                for cid, cval, mname, info, sid, sval in street_jobs}
        for fut in as_completed(futs):
            cid, cval, mname, info, sid, sval = futs[fut]
            try:
                qs = fut.result()
            except Exception:
                qs = []
            if qs:
                street_queues.append((cval, mname, info, sval, qs))

    log(f"Geocoding {len(street_queues)} major-city streets via Nominatim ...")
    samples = []
    live_calls = 0
    for idx, (cval, mname, info, sval, qs) in enumerate(street_queues, 1):
        clon, clat, dlon, dlat = info
        bbox = (clon - dlon, clat - dlat, clon + dlon, clat + dlat)
        pt, did_http = nominatim_geocode(f"{expand_street_prefix(sval)}, {mname}", bbox, geo_cache)
        if did_http:
            live_calls += 1
            if live_calls % 20 == 0:
                save_json_cache("nominatim_cache.json", geo_cache)
                log(f"  major-city Nominatim lookups: {idx}/{len(street_queues)} ({live_calls} live)")
        lon, lat = pt if pt else (clon, clat)
        for q in qs:
            samples.append({"lon": lon, "lat": lat, "q": q, "place": f"{cval} · {sval}"})

    save_json_cache("nominatim_cache.json", geo_cache)
    save_json_cache("major_city_samples.json", {"samples": samples})
    log(f"Collected {len(samples)} street samples in major oblast cities")
    return samples


def collect_oblast_settlement_samples(cities, geonames_idx, refresh=False):
    cache = {} if refresh else load_json_cache("oblast_samples.json", {})
    if cache.get("samples"):
        return cache["samples"], cache.get("matched", 0)

    geo_cache = {} if refresh else load_json_cache("nominatim_cache.json", {})
    to_query = []
    matched = 0
    nom_fallback = 0
    live_calls = 0
    for c in cities:
        cid, cval = c["id"], c["value"]
        if cid == 5:
            continue  # Dnipro handled separately in detail
        coords = match_city_coords(cval, geonames_idx)
        if not coords:
            pt, did_http = nominatim_geocode(f"{cval}, Дніпропетровська область", (33.0, 47.4, 37.0, 49.2), geo_cache)
            if did_http:
                live_calls += 1
                if live_calls % 20 == 0:
                    save_json_cache("nominatim_cache.json", geo_cache)
                    log(f"  settlement Nominatim fallbacks: {live_calls}")
            if pt:
                nom_fallback += 1
                coords = tuple(pt)
        if coords:
            matched += 1
            to_query.append((cid, cval, coords[0], coords[1]))

    save_json_cache("nominatim_cache.json", geo_cache)
    log(f"Matched coordinates for {matched}/{len(cities)-1} oblast settlements ({nom_fallback} via Nominatim); sampling YASNO queues ...")
    samples = []
    done = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        futs = {pool.submit(sample_city_queue, cid, cval): (cid, cval, lon, lat)
                for cid, cval, lon, lat in to_query}
        for fut in as_completed(futs):
            cid, cval, lon, lat = futs[fut]
            done += 1
            try:
                qs = fut.result()
            except Exception:
                qs = []
            for q in qs:
                samples.append({"lon": lon, "lat": lat, "q": q, "place": cval})
            if done % 150 == 0:
                log(f"  settlements sampled: {done}/{len(to_query)} ({len(samples)} queue points)")

    save_json_cache("oblast_samples.json", {"samples": samples, "matched": matched})
    log(f"Collected {len(samples)} oblast settlement queue samples")
    return samples, matched


def collect_dnipro_samples(streets, refresh=False):
    cache = {} if refresh else load_json_cache("dnipro_samples.json", {})
    if cache.get("samples"):
        return cache["samples"], cache.get("streets_geocoded", 0)

    geo_cache = {} if refresh else load_json_cache("nominatim_cache.json", {})
    # Prioritize signature arterials across all banks, then evenly sample up to 160 streets total
    priority = []
    rest = []
    for st in streets:
        if any(tok.lower() in st["value"].lower() for tok in PRIORITY_DNIPRO_TOKENS):
            priority.append(st)
        else:
            rest.append(st)
    prio_step = max(1, len(priority) // 45)
    picked = priority[::prio_step][:45]
    need = max(0, 160 - len(picked))
    rest_step = max(1, len(rest) // max(1, need))
    picked += rest[::rest_step][:need]
    log(f"Sampling {len(picked)} Dnipro streets on YASNO ({len(priority)} priority matches available) ...")

    street_queues = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futs = {pool.submit(sample_street_queues, 5, st["id"]): st for st in picked}
        for fut in as_completed(futs):
            st = futs[fut]
            try:
                qs = fut.result()
            except Exception:
                qs = []
            if qs:
                street_queues[st["id"]] = (st["value"], qs)

    log(f"Got YASNO queues for {len(street_queues)} Dnipro streets; geocoding via Nominatim ...")
    samples = []
    geocoded = 0
    live_calls = 0
    for i, (sid, (sval, qs)) in enumerate(street_queues.items(), 1):
        expanded = expand_street_prefix(sval)
        pt, did_http = nominatim_geocode(f"{expanded}, Дніпро", DNIPRO_CITY_BBOX, geo_cache)
        if did_http:
            live_calls += 1
        if not pt:
            bare = re.sub(r"^(вул\.|пров\.|просп\.|ж/м|наб\.|пл\.|узвіз|тупик)\s*", "", sval, flags=re.I)
            if bare and bare != expanded:
                pt, did_http2 = nominatim_geocode(f"{bare}, Дніпро", DNIPRO_CITY_BBOX, geo_cache)
                if did_http2:
                    live_calls += 1
        if pt:
            geocoded += 1
            for q in qs:
                samples.append({"lon": pt[0], "lat": pt[1], "q": q, "place": sval})
        if live_calls and live_calls % 20 == 0:
            save_json_cache("nominatim_cache.json", geo_cache)
        if i % 20 == 0 or i == len(street_queues):
            log(f"  geocoded {i}/{len(street_queues)} Dnipro streets ({geocoded} located, {live_calls} live calls)")

    save_json_cache("nominatim_cache.json", geo_cache)
    save_json_cache("dnipro_samples.json", {"samples": samples, "streets_geocoded": geocoded})
    log(f"Collected {len(samples)} geocoded Dnipro street samples ({geocoded} streets)")
    return samples, geocoded


# --- Hex binning ---

def shares_from_counts(counts):
    total = sum(counts.values())
    if total <= 0:
        return {}, None
    top = sorted(counts.items(), key=lambda kv: (-kv[1], queue_sort_key(kv[0])))[:4]
    sub_tot = sum(v for _, v in top)
    raw_pcts = [(k, v * 100.0 / sub_tot) for k, v in top]
    ints = {k: int(math.floor(p)) for k, p in raw_pcts}
    rem = 100 - sum(ints.values())
    for k, p in sorted(raw_pcts, key=lambda kv: -(kv[1] - math.floor(kv[1]))):
        if rem <= 0:
            break
        ints[k] += 1
        rem -= 1
    ints = {k: v for k, v in sorted(ints.items(), key=lambda kv: (-kv[1], queue_sort_key(kv[0]))) if v > 0}
    dom = next(iter(ints))
    return ints, dom


def build_oblast_hexes(border_xy, samples, proj):
    vb_w, vb_h = 620, 400
    r = 12.8
    dx = math.sqrt(3) * r
    dy = 1.5 * r

    pts_xy = []
    for s in samples:
        x, y = proj(s["lon"], s["lat"])
        pts_xy.append((x, y, s["q"], s["place"]))

    hexes = []
    idx = 0
    for row in range(32):
        cy = 10.0 + row * dy
        if cy > vb_h - 6:
            break
        off = (row % 2) * (dx / 2.0)
        for col in range(36):
            cx = 10.0 + off + col * dx
            if cx > vb_w - 6:
                break
            if not point_in_poly(cx, cy, border_xy):
                continue
            hexes.append({"id": f"o{idx}", "cx": round(cx, 1), "cy": round(cy, 1), "counts": Counter(), "places": Counter()})
            idx += 1

    # Assign each sample to nearest hex center within hex radius * 1.15
    max_d2 = (r * 1.15) ** 2
    for x, y, q, place in pts_xy:
        best = None
        best_d2 = max_d2
        for h in hexes:
            d2 = (x - h["cx"]) ** 2 + (y - h["cy"]) ** 2
            if d2 <= best_d2:
                best_d2 = d2
                best = h
        if best is not None:
            best["counts"][q] += 1
            best["places"][place] += 1

    out = []
    sampled_hexes = [h for h in hexes if h["counts"]]
    for h in hexes:
        n = sum(h["counts"].values())
        if n > 0:
            shares, dom = shares_from_counts(h["counts"])
            place = h["places"].most_common(1)[0][0]
        else:
            # Interpolate from up to 3 nearest sampled hexes (<= 55 px)
            dists = sorted(
                (((h["cx"] - s["cx"]) ** 2 + (h["cy"] - s["cy"]) ** 2, s) for s in sampled_hexes),
                key=lambda it: it[0],
            )
            near = [(d2, s) for d2, s in dists[:3] if d2 <= 65 ** 2]
            if not near:
                near = dists[:1]
            w_counts = defaultdict(float)
            for d2, s in near:
                w = 1.0 / (math.sqrt(d2) + 8.0)
                for q, cnt in s["counts"].items():
                    w_counts[q] += w * cnt
            shares, dom = shares_from_counts(w_counts)
            nearest_place = near[0][1]["places"].most_common(1)[0][0] if near else "Дніпропетровська обл."
            place = f"Near {nearest_place}"

        out.append({
            "id": h["id"],
            "pts": hex_points_str(h["cx"], h["cy"], r - 0.9),
            "cx": h["cx"],
            "cy": h["cy"],
            "p": place,
            "d": dom,
            "s": shares,
            "n": n,
        })
    return out


def build_dnipro_hexes(samples, proj):
    vb_w, vb_h = 620, 400
    r = 18.0
    dx = math.sqrt(3) * r
    dy = 1.5 * r

    pts_xy = []
    for s in samples:
        x, y = proj(s["lon"], s["lat"])
        if 10 <= x <= vb_w - 10 and 10 <= y <= vb_h - 10:
            pts_xy.append((x, y, s["q"], s["place"]))

    grid = {}
    idx = 0
    for row in range(20):
        cy = 24.0 + row * dy
        if cy > vb_h - 18:
            break
        off = (row % 2) * (dx / 2.0)
        for col in range(24):
            cx = 24.0 + off + col * dx
            if cx > vb_w - 18:
                break
            grid[(row, col)] = {"id": f"d{idx}", "row": row, "col": col, "cx": round(cx, 1), "cy": round(cy, 1),
                                "counts": Counter(), "places": Counter()}
            idx += 1

    max_d2 = (r * 1.15) ** 2
    for x, y, q, place in pts_xy:
        best = None
        best_d2 = max_d2
        for h in grid.values():
            d2 = (x - h["cx"]) ** 2 + (y - h["cy"]) ** 2
            if d2 <= best_d2:
                best_d2 = d2
                best = h
        if best is not None:
            best["counts"][q] += 1
            best["places"][place] += 1

    def neighbors(row, col):
        if row % 2 == 0:
            offs = [(-1, -1), (-1, 0), (0, -1), (0, 1), (1, -1), (1, 0)]
        else:
            offs = [(-1, 0), (-1, 1), (0, -1), (0, 1), (1, 0), (1, 1)]
        return [grid[(row + dr, col + dc)] for dr, dc in offs if (row + dr, col + dc) in grid]

    kept = []
    for (row, col), h in grid.items():
        n = sum(h["counts"].values())
        if n > 0:
            shares, dom = shares_from_counts(h["counts"])
            top_places = [p for p, _ in h["places"].most_common(2)]
            kept.append({
                "id": h["id"], "pts": hex_points_str(h["cx"], h["cy"], r - 1.3),
                "cx": h["cx"], "cy": h["cy"], "p": " / ".join(top_places),
                "d": dom, "s": shares, "n": n,
            })
        else:
            nb_sampled = [nb for nb in neighbors(row, col) if nb["counts"]]
            if len(nb_sampled) >= 2:
                w_counts = Counter()
                for nb in nb_sampled:
                    w_counts.update(nb["counts"])
                shares, dom = shares_from_counts(w_counts)
                near_p = nb_sampled[0]["places"].most_common(1)[0][0]
                kept.append({
                    "id": h["id"], "pts": hex_points_str(h["cx"], h["cy"], r - 1.3),
                    "cx": h["cx"], "cy": h["cy"], "p": f"Near {near_p}",
                    "d": dom, "s": shares, "n": 0,
                })
    return kept


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--refresh", action="store_true", help="ignore cached HTTP downloads and re-fetch")
    args = ap.parse_args(argv)

    border_geo, raions_geo = load_boundaries(refresh=args.refresh)
    geonames_idx, _ = load_geonames(border_geo, refresh=args.refresh)
    cities = fetch_all_yasno_cities(refresh=args.refresh)

    oblast_samples, matched_cities = collect_oblast_settlement_samples(cities, geonames_idx, refresh=args.refresh)
    major_samples = collect_major_city_street_samples(cities, refresh=args.refresh)
    dnipro_streets = collect_dnipro_streets(refresh=args.refresh)
    dnipro_samples, dnipro_geocoded = collect_dnipro_samples(dnipro_streets, refresh=args.refresh)

    all_oblast_samples = oblast_samples + major_samples + dnipro_samples

    lons = [p[0] for p in border_geo]
    lats = [p[1] for p in border_geo]
    oblast_bounds = (min(lons), min(lats), max(lons), max(lats))
    proj_ob = make_projector(oblast_bounds, 620, 400, 14)

    border_xy = [proj_ob(lo, la) for lo, la in border_geo]
    raions_xy = [{"name": r["name"], "ring": [proj_ob(lo, la) for lo, la in r["ring"]]} for r in raions_geo]
    rivers_ob_xy = [[proj_ob(lo, la) for lo, la in rv] for rv in OBLAST_RIVERS]
    cities_ob_xy = [{"name": c["name"], "x": proj_ob(c["lon"], c["lat"])[0],
                     "y": proj_ob(c["lon"], c["lat"])[1], "major": c["major"]} for c in REFERENCE_CITIES]
    oblast_hexes = build_oblast_hexes(border_xy, all_oblast_samples, proj_ob)

    proj_dn = make_projector(DNIPRO_ZOOM_BOUNDS, 620, 400, 14)
    rivers_dn_xy = [[proj_dn(lo, la) for lo, la in rv] for rv in DNIPRO_RIVERS]
    labels_dn_xy = [{"name": lb["name"], "x": proj_dn(lb["lon"], lb["lat"])[0],
                     "y": proj_dn(lb["lon"], lb["lat"])[1], "bank": bool(lb.get("bank"))}
                    for lb in DNIPRO_DISTRICT_LABELS]
    dnipro_hexes = build_dnipro_hexes(dnipro_samples, proj_dn)

    queues_seen = sorted({q for h in oblast_hexes + dnipro_hexes for q in h["s"]}, key=queue_sort_key)

    payload = {
        "version": 1,
        "generated_at": datetime.now(KYIV).replace(microsecond=0).isoformat(),
        "queues_seen": queues_seen,
        "stats": {
            "settlements_total": len(cities),
            "settlements_matched": matched_cities,
            "oblast_samples": len(all_oblast_samples),
            "dnipro_streets_listed": len(dnipro_streets),
            "dnipro_streets_geocoded": dnipro_geocoded,
            "oblast_hexes": len(oblast_hexes),
            "oblast_hexes_verified": sum(1 for h in oblast_hexes if h["n"] > 0),
            "dnipro_hexes": len(dnipro_hexes),
            "dnipro_hexes_verified": sum(1 for h in dnipro_hexes if h["n"] > 0),
        },
        "oblast": {
            "vb": [620, 400],
            "border": border_xy,
            "raions": raions_xy,
            "rivers": rivers_ob_xy,
            "cities": cities_ob_xy,
            "hexes": oblast_hexes,
        },
        "dnipro": {
            "vb": [620, 400],
            "rivers": rivers_dn_xy,
            "labels": labels_dn_xy,
            "hexes": dnipro_hexes,
        },
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
    OUT_PATH.write_bytes(text.encode("utf-8"))
    log(f"Wrote {OUT_PATH} ({len(text.encode('utf-8'))} bytes)")
    log("Stats: " + json.dumps(payload["stats"], ensure_ascii=False))
    log("Queues seen: " + ", ".join(queues_seen))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
