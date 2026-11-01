"""
The control panel: a browser view of what the reader has been doing.

    http://cam.lan/            (Caddy on the Portal LXC -> this service)

Everything it shows is already on disk. archive() keeps every frame with its
whole answer beside it as .json; this module only reads those back and draws
them. Two actions, both safe by construction:

  * Replay -- run ONE archived frame through read_once() with the CURRENT
    config. Nothing is published, archived or remembered, so it doubles as a
    test of a ROI or threshold edit against the frames that went wrong.
  * Firmware -- publish a build for the board's next wake, the same two writes
    docs/firmware.md describes, with the same order and the same rule (the
    number after the last '-' must go up).

config.json stays read-only here. It is changed in git and deployed; a panel
that edited it would let the box drift from the repo without anyone noticing.

---------------------------------------------------------------------------
No login

The panel is open on the LAN, like the house dashboard at home.lan. Its
routes do not call authorised(); the service's own routes (/read, /last.jpg,
/archive, /firmware/*) still do, so the camera's API keeps its token. The
panel's own copy of the newest frames is /live/<meter>/<which>.jpg.

---------------------------------------------------------------------------
Zero idle cost

Nothing in this module runs unless a request asks for it: no thread, no timer,
no index, no cache in memory. A listing reads one day's sidecars; a thumbnail
is made the first time it is viewed and kept next to its frame (so
metercam-prune ages it out with the day); a replay runs on a click. The camera's
POST /read path is untouched.
"""

from __future__ import annotations

import base64
import json
import os
import pathlib
import re
import time

from flask import Blueprint, jsonify, render_template, request, send_file

PANEL = Blueprint("panel", __name__, template_folder="templates",
                  static_folder="static", static_url_path="/static")

KINDS = ("raw", "rejected")
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# archive() names: 2026-10-02-01-42-2261.72.jpg, -none.jpg, -2.jpg on a clash.
# ~sN.jpg extras are excluded on purpose: they are the TRANSFORMED frames of a
# disagreeing wake, and replaying one would transform it a second time.
_FRAME = re.compile(r"^[0-9A-Za-z.\-]+\.jpg$")
_THUMB_W = 360
_SERIES_MAX_DAYS = 30
# The board sleeps SLEEP_SECONDS (firmware/gas-cam/include/config.h) between
# wakes. The service cannot ask it, so the panel takes it from the meter's
# config, or this default.
_WAKE_S = 1800

_core = None          # service.app, handed over by init()


def init(app, core):
    """Register on the service's app. `core` is service.app itself.

    Passed in rather than imported: under `python -m service.app` that module
    is __main__, and importing service.app again would build a second app with
    a second reader lock.
    """
    global _core
    _core = core
    app.register_blueprint(PANEL)


# ---------------------------------------------------------------------------
# The page
# ---------------------------------------------------------------------------

@PANEL.route("/")
def index():
    try:
        meters = sorted((_core.load_config().get("meters") or {}).keys())
    except Exception:                   # noqa: BLE001 - the page says why instead
        meters = []
    return render_template("panel.html", meters=meters or ["gas"])


# ---------------------------------------------------------------------------
# Reading the archive back
# ---------------------------------------------------------------------------

def _meter_name(value):
    """A meter id from the query string, safe to use as a path segment."""
    name = (value or "gas").strip()
    if not re.match(r"^[A-Za-z0-9_-]{1,32}$", name):
        raise ValueError("bad meter name")
    return name


def _frame_path(meter, kind, day, name):
    """The archived frame, or ValueError. Never a path outside the archive."""
    if kind not in KINDS or not _DAY.match(day or "") or not _FRAME.match(name or ""):
        raise ValueError("not an archived frame")
    root = _core.IMAGE_DIR.resolve()
    path = (_core.IMAGE_DIR / _meter_name(meter) / kind / day / name).resolve()
    # The regexes already exclude separators and '..'; this is the belt.
    if root not in path.parents:
        raise ValueError("not an archived frame")
    return path


def _reason_class(reason):
    """'confidence: drum 3 at 0.21, below 0.50' -> 'confidence'."""
    if not reason:
        return None
    head = str(reason).split(":", 1)[0].strip()
    return head if len(head) <= 24 else head[:24]


def _sidecar(jpg):
    try:
        with open(jpg.with_suffix(".json"), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _stamp(name):
    """'2026-10-02-01-42-2261.72.jpg' -> '2026-10-02T01:42', or None."""
    m = re.match(r"^(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})-", name)
    return "%sT%s:%s" % m.groups() if m else None


def day_reads(meter, day, kinds=KINDS):
    """Every read archived on `day`, oldest first, from the sidecars.

    One directory per kind: a few dozen small files, read on request.
    """
    out = []
    for kind in kinds:
        directory = _core.IMAGE_DIR / meter / kind / day
        if not directory.is_dir():
            continue
        for jpg in directory.glob("*.jpg"):
            if "~s" in jpg.name or not _FRAME.match(jpg.name):
                continue
            side = _sidecar(jpg) or {}
            conf = side.get("confidence") or {}
            align = side.get("align") or {}
            try:
                mtime = jpg.stat().st_mtime
            except OSError:
                continue
            out.append({
                "kind": kind,
                "day": day,
                "file": jpg.name,
                "at": _stamp(jpg.name),
                "epoch": mtime,
                "accepted": bool(side.get("accepted")) if side else kind == "raw",
                "value": side.get("value"),
                "prevalue": side.get("prevalue"),
                "delta": side.get("delta"),
                "reason": side.get("reason"),
                "reason_class": _reason_class(side.get("reason")),
                "digits": side.get("digits"),
                "drums": side.get("drums"),
                "confidence": conf.get("per_drum"),
                "confidence_min": conf.get("min"),
                "align": {k: align.get(k) for k in
                          ("ok", "inliers", "matches", "dx", "dy", "rotation_deg", "reason")
                          } if align else None,
                "firmware": side.get("firmware_running"),
                "duration_ms": side.get("duration_ms"),
                "extras": sorted(p.name for p in directory.glob(jpg.stem + "~s*.jpg")),
                "has_sidecar": bool(side),
            })
    out.sort(key=lambda r: (r["at"] or "", r["epoch"]))
    return out


@PANEL.route("/api/reads")
def api_reads():
    try:
        meter = _meter_name(request.args.get("meter"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    day = request.args.get("day") or time.strftime("%Y-%m-%d")
    if not _DAY.match(day):
        return jsonify({"error": "day is YYYY-MM-DD"}), 400
    kind = request.args.get("kind", "all")
    kinds = KINDS if kind == "all" else (kind,) if kind in KINDS else None
    if kinds is None:
        return jsonify({"error": "kind is all, raw or rejected"}), 400
    reads = day_reads(meter, day, kinds)
    return jsonify({"meter": meter, "day": day, "reads": reads})


@PANEL.route("/api/series")
def api_series():
    """Points for the trend chart: one per read, plus per-day counts.

    Capped at 30 days. Called only when someone opens the Trend tab.
    """
    try:
        meter = _meter_name(request.args.get("meter"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    days = max(1, min(_SERIES_MAX_DAYS, request.args.get("days", 7, type=int) or 7))

    points, per_day = [], []
    now = time.time()
    for back in range(days - 1, -1, -1):
        day = time.strftime("%Y-%m-%d", time.localtime(now - back * 86400))
        reads = day_reads(meter, day)
        refused = {}
        for r in reads:
            points.append({
                "at": r["at"], "accepted": r["accepted"], "value": r["value"],
                "confidence_min": r["confidence_min"], "reason_class": r["reason_class"],
            })
            if not r["accepted"]:
                key = r["reason_class"] or "unknown"
                refused[key] = refused.get(key, 0) + 1
        per_day.append({
            "day": day,
            "accepted": sum(1 for r in reads if r["accepted"]),
            "refused": refused,
        })

    gate = {}
    try:
        gate = dict(_core.get_meter(_core.load_config(), meter).get("gate") or {})
    except (KeyError, OSError, ValueError):
        pass
    return jsonify({
        "meter": meter, "days": days, "points": points, "per_day": per_day,
        "thresholds": {k: gate.get(k) for k in ("min_confidence", "min_confidence_last_digit")},
    })


@PANEL.route("/api/days")
def api_days():
    """The Storage tab and the gallery's day picker: /archive/days, open.

    The whole archive, every meter: the ceiling below is for all of it, and
    each day already breaks its frames down per meter.
    """
    out = _core.days_summary()
    # metercam-prune's ceiling (deploy/_lxc_env.sh MAX_ARCHIVE_MB), for the bar.
    out["cap_bytes"] = int(os.environ.get("METERCAM_MAX_ARCHIVE_MB", "1024")) * 1024 * 1024
    return jsonify(out)


@PANEL.route("/api/overview")
def api_overview():
    """The Live tab: the last read, the last accepted one, and when the next wake is due."""
    try:
        meter = _meter_name(request.args.get("meter"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    now = time.time()
    cfg, cfg_error, meter_cfg = None, None, {}
    try:
        cfg = _core.load_config()
        meter_cfg = _core.get_meter(cfg, meter)
    except Exception as exc:            # noqa: BLE001 - shown, not raised
        cfg_error = "%s: %s" % (type(exc).__name__, exc)

    # The newest read on disk: today, else yesterday (a read just after
    # midnight is a new folder with nothing in it yet).
    last = None
    for back in (0, 1):
        reads = day_reads(meter, time.strftime("%Y-%m-%d", time.localtime(now - back * 86400)))
        if reads:
            last = reads[-1]
            break

    pushed = _core._LAST_READ.get(meter) or (last or {}).get("epoch")
    wake_s = int((meter_cfg or {}).get("wake_interval_s") or _WAKE_S)
    accepted = _core.last_accepted_record(meter) or {}
    ha = (meter_cfg or {}).get("home_assistant") or {}

    return jsonify({
        "meter": meter,
        "now": now,
        "config_ok": cfg_error is None,
        "config_error": cfg_error,
        "auth": "token" if _core.TOKEN else "DISABLED",
        "uptime_s": int(now - _core._STARTED),
        "firmware_offered": _core._firmware_version(),
        "last": last,
        "last_push_epoch": pushed,
        "wake_interval_s": wake_s,
        "next_wake_epoch": (pushed + wake_s) if pushed else None,
        "last_accepted": accepted or None,
        "publish": {"write": ha.get("write", True), "entity": ha.get("write_entity")},
    })


@PANEL.route("/live/<meter>/<which>.jpg")
def live(meter, which):
    """The newest frame (last) or the last accepted one, for the Live tab."""
    if which not in ("last", "last_accepted"):
        return jsonify({"error": "last or last_accepted"}), 404
    try:
        path = _core.IMAGE_DIR / _meter_name(meter) / ("%s.jpg" % which)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    if not path.is_file():
        return jsonify({"error": "nothing yet"}), 404
    return send_file(str(path), mimetype="image/jpeg", max_age=0)


@PANEL.route("/img/<meter>/<kind>/<day>/<name>")
def image(meter, kind, day, name):
    try:
        path = _frame_path(meter, kind, day, name)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    if not path.is_file():
        return jsonify({"error": "no such frame"}), 404
    if request.args.get("thumb"):
        path = _thumbnail(path) or path
    # Archived frames never change once written, so the browser may keep them.
    return send_file(str(path), mimetype="image/jpeg", max_age=86400)


def _thumbnail(path):
    """A small copy beside the frame, made the first time it is asked for.

    Kept in <day>/.thumbs/ with the frame's own mtime, so metercam-prune's
    age rule removes the pair together. The archive routes skip dot-folders.
    """
    thumb = path.parent / ".thumbs" / path.name
    if thumb.is_file():
        return thumb
    try:
        import cv2                      # lazy: already loaded by the reader anyway
        img = cv2.imread(str(path))
        if img is None:
            return None
        h, w = img.shape[:2]
        if w > _THUMB_W:
            img = cv2.resize(img, (_THUMB_W, int(h * _THUMB_W / w)),
                             interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
        if not ok:
            return None
        thumb.parent.mkdir(exist_ok=True)
        tmp = thumb.with_name(thumb.name + ".part")
        tmp.write_bytes(buf.tobytes())
        os.replace(tmp, thumb)
        st = path.stat()
        os.utime(thumb, (st.st_atime, st.st_mtime))
        return thumb
    except (ImportError, OSError):
        return None


# ---------------------------------------------------------------------------
# Replay: one archived frame through today's config
# ---------------------------------------------------------------------------

@PANEL.route("/api/replay", methods=["POST"])
def api_replay():
    body = request.get_json(silent=True) or {}
    try:
        meter_name = _meter_name(body.get("meter"))
        path = _frame_path(meter_name, body.get("kind"), body.get("day"), body.get("file"))
        cfg = _core.load_config()
        meter = _core.get_meter(cfg, meter_name)
    except (KeyError, OSError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400
    if not path.is_file():
        return jsonify({"error": "no such frame"}), 404

    # The reader's own lock: the models and the interpreter are shared with
    # POST /read. Wait briefly, never long -- a board mid-wake comes first,
    # and the person clicking can click again.
    if not _core._LOCK.acquire(timeout=5):
        return jsonify({"error": "the reader is busy with a camera read; try again"}), 409
    try:
        from . import reader
        original = _sidecar(path) or {}
        result = reader.read_once(meter, _core._MODELS, path.read_bytes(),
                                  prevalue=original.get("prevalue"))
        annotated = _annotate(result.get("_frame"), meter, result)
    except Exception as exc:            # noqa: BLE001 - a replay that fails says so
        return jsonify({"error": "%s: %s" % (type(exc).__name__, exc)}), 502
    finally:
        _core._LOCK.release()

    out = _core.strip(result)
    out["original"] = {k: original.get(k) for k in
                       ("value", "accepted", "reason", "digits", "drums", "confidence")}
    out["annotated"] = ("data:image/jpeg;base64,%s" % base64.b64encode(annotated).decode("ascii")
                        if annotated else None)
    return jsonify(out)


def _annotate(img, meter, result):
    """The aligned frame with every ROI drawn, its digit and its confidence.

    Coloured against the gate's thresholds: green passes, amber is the last
    drum's looser bar, red would refuse. Boxes are drawn in the corrected
    space, the same one the ROIs are written in.
    """
    if img is None:
        return None
    import cv2
    out = img.copy()
    gate = meter.get("gate") or {}
    floor = gate.get("min_confidence")
    last_floor = gate.get("min_confidence_last_digit", floor)
    rois = meter.get("rois") or []
    confs = result.get("_confidences") or []
    drums = result.get("drums") or []
    scale = max(1.0, out.shape[1] / 1000.0)
    for i, roi in enumerate(rois):
        conf = confs[i] if i < len(confs) else None
        bar = last_floor if i == len(rois) - 1 else floor
        if conf is None:
            colour = (160, 160, 160)
        elif bar is not None and conf < bar:
            colour = (40, 40, 220)          # BGR: red
        elif i == len(rois) - 1 and floor is not None and conf < floor:
            colour = (0, 170, 240)          # amber: passes only the last-drum bar
        else:
            colour = (60, 180, 60)          # green
        x, y, w, h = (int(roi[k]) for k in ("x", "y", "w", "h"))
        cv2.rectangle(out, (x, y), (x + w, y + h), colour, max(2, int(2 * scale)))
        label = "%s %s" % ("?" if i >= len(drums) or drums[i] is None else "%.1f" % drums[i],
                           "" if conf is None else "%.0f%%" % (conf * 100))
        org = (x + 4, max(20, y - 8))
        cv2.putText(out, label, org, cv2.FONT_HERSHEY_SIMPLEX, 0.9 * scale,
                    (0, 0, 0), int(5 * scale), cv2.LINE_AA)
        cv2.putText(out, label, org, cv2.FONT_HERSHEY_SIMPLEX, 0.9 * scale,
                    colour, int(2 * scale), cv2.LINE_AA)
    ok, buf = cv2.imencode(".jpg", out, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    return buf.tobytes() if ok else None


# ---------------------------------------------------------------------------
# Firmware: publish a build for the board's next wake
# ---------------------------------------------------------------------------

_BIN_NAME = "gas-cam.bin"
_VERSION = re.compile(r"^[A-Za-z0-9_.]+(?:-[A-Za-z0-9_.]+)*-(\d+)$")
_MAX_BIN = 4 * 1024 * 1024         # an ESP32-CAM OTA slot is ~1.9 MB; generous


def version_number(version):
    """'gas-cam-7' -> 7. The board compares exactly this, so must we."""
    m = _VERSION.match(version or "")
    return int(m.group(1)) if m else None


def publish_firmware(firmware_dir, blob, version, offered):
    """The two writes, in the order the board relies on. Returns an error or None.

    The .bin first, then version.txt: a board waking between the two sees the
    OLD version beside the new binary and does nothing, never the new version
    beside the old binary.
    """
    number = version_number(version)
    if number is None:
        return "version must look like gas-cam-8 (a number after the last '-')"
    current = version_number(offered)
    if current is not None and number <= current:
        return "version %s is not higher than the one on offer (%s)" % (version, offered)
    if not blob or len(blob) > _MAX_BIN:
        return "the .bin is empty or larger than %d bytes" % _MAX_BIN
    # An ESP32 application image starts with the 0xE9 magic byte. Anything
    # else is not a firmware the board could boot.
    if blob[0] != 0xE9:
        return "that file is not an ESP32 application image (no 0xE9 magic byte)"

    firmware_dir = pathlib.Path(firmware_dir)
    firmware_dir.mkdir(parents=True, exist_ok=True)
    tmp = firmware_dir / (_BIN_NAME + ".part")
    tmp.write_bytes(blob)
    os.replace(tmp, firmware_dir / _BIN_NAME)
    vtmp = firmware_dir / "version.txt.part"
    vtmp.write_text(version + "\n", encoding="utf-8")
    os.replace(vtmp, firmware_dir / "version.txt")
    return None


@PANEL.route("/api/firmware", methods=["POST"])
def api_firmware():
    version = (request.form.get("version") or "").strip()
    upload = request.files.get("bin")
    blob = upload.read() if upload else b""
    error = publish_firmware(_core.FIRMWARE_DIR, blob, version, _core._firmware_version())
    if error:
        return jsonify({"error": error}), 400
    print("firmware %s published from the panel (%d bytes)" % (version, len(blob)), flush=True)
    return jsonify({"published": version, "bytes": len(blob)})


@PANEL.after_request
def _no_store(resp):
    # The JSON is live state; a cached copy is a wrong answer. Images set
    # their own max_age above.
    if resp.mimetype == "application/json":
        resp.headers["Cache-Control"] = "no-store"
    return resp
