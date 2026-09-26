"""
HTTP front end for the meter reader. One request in, one answer out.

    METERCAM_CONFIG=config.json METERCAM_TOKEN=... python -m service.app
    docker compose up

---------------------------------------------------------------------------
Why there is no scheduler in here

Home Assistant owns the clock. It polls `/read` on its own `scan_interval`, and
it passes the previous reading in as a query parameter, so this service holds no
opinion about when to look at the meter and no memory of what the meter last
said. That makes it trivially testable -- image in, prevalue in, verdict out --
and it leaves exactly one place in the house that knows what the gas meter
reads, which is the Home Assistant helper that has always known.

The only state here is images on disk, which are a debugging artifact rather
than a source of truth. Delete `/data/images` and nothing breaks.

There is deliberately no call FROM this service INTO Home Assistant. Whether a
reading is good enough to keep is Home Assistant's decision, made in an
automation that anyone can read, against the `accepted` flag below.

---------------------------------------------------------------------------
Auth

`X-Auth-Token`, the same shape the IR bridge uses (see
`HomeAssistant/config/irbridge/rest_commands.yaml`). Also accepted as `?token=`
because the ROI editor is a browser page and a browser cannot set a header on a
plain navigation. That is a LAN service with no TLS either way; the token stops
a stray script on the network, not a determined attacker.

If METERCAM_TOKEN is unset, auth is OFF and `/health` says so out loud. That is
a legitimate way to run on the bench and a bad way to run on the LAN.
"""

from __future__ import annotations

import base64
import io
import json
import os
import pathlib
import threading
import time
import urllib.error
import urllib.request
import zipfile

import cv2
import numpy as np
from flask import Flask, Response, jsonify, request, send_file

from . import reader

APP = Flask(__name__)

CONFIG_PATH = os.environ.get("METERCAM_CONFIG", "/config/config.json")
TOKEN = os.environ.get("METERCAM_TOKEN") or None
IMAGE_DIR = pathlib.Path(os.environ.get("METERCAM_IMAGES", "/data/images"))
FIRMWARE_DIR = pathlib.Path(os.environ.get("METERCAM_FIRMWARE", "/data/firmware"))

# Home Assistant's long-lived token. In the environment rather than the config
# by preference: config.json is readable in the ROI editor's directory listing
# and gets pasted into issues, and a token that can write to the house does not
# belong in either. The config field stays as a fallback for a bench run.
HA_TOKEN = os.environ.get("METERCAM_HA_TOKEN") or None

_LOCK = threading.Lock()          # one camera, one reader, one request at a time
_MODELS = reader.ModelCache()
_LAST = {}                        # meter -> {"frame": jpeg, "annotated": jpeg, ...}
_STARTED = time.time()


def load_config():
    with open(CONFIG_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def authorised():
    if TOKEN is None:
        return True
    supplied = request.headers.get("X-Auth-Token") or request.args.get("token")
    return supplied == TOKEN


def deny():
    return jsonify({"error": "unauthorised"}), 401


def get_meter(cfg, name):
    meters = cfg.get("meters") or {}
    if name not in meters:
        raise KeyError("no meter %r in config; have %s"
                       % (name, ", ".join(sorted(meters)) or "none"))
    return meters[name]


def ha_cfg(cfg, meter):
    """Home Assistant's address and entities: per meter, else global."""
    base = dict((cfg.get("home_assistant") or {}))
    base.update(dict((meter or {}).get("home_assistant") or {}))
    if not base.get("url"):
        return None
    base["token"] = HA_TOKEN or base.get("token") or None
    return base if base["token"] else None


def ha_call(ha, path, payload=None):
    """One request to Home Assistant. GET, or POST when given a payload."""
    url = "%s/%s" % (ha["url"].rstrip("/"), path.lstrip("/"))
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, headers={
        "Authorization": "Bearer %s" % ha["token"],
        "Content-Type": "application/json",
        "User-Agent": "MeterCam/1",
    })
    with urllib.request.urlopen(req, timeout=float(ha.get("timeout_s", 10))) as resp:
        body = resp.read()
    return json.loads(body) if body else None


def ha_prevalue(ha):
    """What the house currently believes the meter reads.

    The pull model had Home Assistant pass this in, which kept this service
    stateless and kept the decision where anyone could read it. A camera in
    deep sleep cannot be asked to carry it -- it does not know the number and
    has no way to learn it -- so the fetch moves here.

    A failure is not fatal and must not be. `gate()` treats a missing prevalue
    as a cold start and reads the meter anyway; what it loses is the
    carry-rule check against the previous value, which is exactly what the
    verdict will then say.
    """
    entity = ha.get("prevalue_entity")
    if not entity:
        return None
    state = (ha_call(ha, "/api/states/%s" % entity) or {}).get("state")
    if state in (None, "", "unknown", "unavailable"):
        return None
    try:
        value = float(state)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def ha_publish(ha, value):
    """Write an accepted reading into the helper the house has always used.

    This is the line app.py's header used to say did not exist, and reversing
    it was not free. The reason it now does: with the camera pushing on its
    own clock there is no poll left to hand a verdict back to. Something has
    to write, and the choice is between this service and an automation woken
    by a webhook -- one more moving part that fails silently when it is the
    one thing nobody looks at.

    So the rule that mattered is kept where it can still be enforced: this is
    called ONLY for a reading that already passed the gate. Whether a number
    is good enough to keep is still decided by `gate()`, in this repo, in code
    with tests -- not by whoever is holding the token.
    """
    entity = ha.get("write_entity")
    if not entity or not ha.get("write", True):
        return None
    ha_call(ha, "/api/services/input_number/set_value",
            {"entity_id": entity, "value": value})
    return entity


def archive(meter_name, meter, result, save):
    """Persist the frame, foldered by date and named for what was read.

    Keeping the bad ones is the point. A reading that failed the gate is the
    only evidence of why, and by the time anyone looks the meter has moved on.

        gas/rejected/2026-09-05/2026-09-05-16-11-2246.91.jpg

    Two things about that shape are load-bearing.

    The value is in the NAME because comparing a frame against what the model
    made of it is the entire reason these are kept. Off a flat list of
    timestamps that means opening each one beside the JSON it produced; here
    the answer is already in the listing, and a run of frames where the number
    jumps and comes back is visible without opening anything.

    raw/ and rejected/ stay ABOVE the date folder rather than below it. They
    carry different retention -- 7 days against 90 -- and metercam-prune
    selects with `-path '*/raw/*'`, which keeps working only while the split
    is a fixed path segment. Date-first would put every day's directory in
    both retention classes at once.
    """
    if not save:
        return None
    sub = "raw" if result.get("accepted") else "rejected"
    now = time.localtime()
    directory = IMAGE_DIR / meter_name / sub / time.strftime("%Y-%m-%d", now)

    value = result.get("value")
    if value is None:
        # No number at all -- a capture or alignment failure. Worth keeping
        # under a name that says so rather than skipping: those are the frames
        # that explain an outage, and they are the rarest ones.
        shown = "none"
    else:
        # reported_decimals, not the dial's own: the name should be the
        # number that was published, so a frame can be matched to the value in
        # the statistics without mental arithmetic.
        shown = "%.*f" % (reader.reported_decimals(meter), value)
    stem = "%s-%s" % (time.strftime("%Y-%m-%d-%H-%M", now), shown)

    try:
        directory.mkdir(parents=True, exist_ok=True)
        # Minute resolution collides when two reads land in the same minute.
        # HA polls every five, but a hand-run /read or a burst from the editor
        # will, and silently overwriting the earlier frame loses exactly the
        # one someone was looking at. Suffix instead.
        path = directory / ("%s.jpg" % stem)
        nth = 2
        while path.exists():
            path = directory / ("%s-%d.jpg" % (stem, nth))
            nth += 1
        with open(path, "wb") as fh:
            fh.write(reader.to_jpeg(result["_frame"]))
        # A disagreeing burst is the one case where every frame matters: which
        # sample differed, and what it saw. read() attaches them only then --
        # archiving all five on every poll would be 3 MB a read, and the whole
        # archive is capped at 1 GB.
        for nth, extra in enumerate(result.get("_frames") or [], start=1):
            if extra is result["_frame"]:
                continue
            try:
                with open(directory / ("%s~s%d.jpg" % (stem, nth)), "wb") as fh:
                    fh.write(reader.to_jpeg(extra))
            except OSError:
                break
        if not result.get("accepted"):
            with open(path.with_suffix(".txt"), "w", encoding="utf-8") as fh:
                fh.write("%s\nvalue=%s prevalue=%s\n"
                         % (result.get("reason"), result.get("value"),
                            result.get("prevalue")))
    except OSError:
        return None  # a full disk must not break the reading
    return str(path)


def remember(meter_name, result):
    """Keep the newest frame, in memory and on disk.

    On disk as well because of deep sleep. `/roi` draws its rectangles over
    whatever `/capture` hands back, and `/capture` asks the camera -- which is
    now asleep and will not answer for another five minutes. Pointing the
    camera URL at this file is what makes the editor usable at all, and a
    memory-only copy meant the first restart emptied it and the editor showed
    a 404 to somebody standing at a gas meter with a laptop.

    Written next to the archive rather than into it: the archive is foldered
    by date and named for the reading, and a fixed path cannot live there
    without breaking the retention globs that select on it.
    """
    frame = reader.to_jpeg(result["_frame"])
    annotated = reader.to_jpeg(result["_annotated"])
    _LAST[meter_name] = {"frame": frame, "annotated": annotated,
                         "at": time.time()}
    try:
        directory = IMAGE_DIR / meter_name
        directory.mkdir(parents=True, exist_ok=True)
        for name, blob in (("last.jpg", frame),
                           ("last_annotated.jpg", annotated)):
            tmp = directory / ("%s.part" % name)
            with open(tmp, "wb") as fh:
                fh.write(blob)
            # Replace atomically: the editor may be fetching this exact file
            # while the next read is writing it, and half a JPEG is not an
            # error anyone enjoys diagnosing.
            os.replace(tmp, directory / name)
    except OSError:
        pass  # a full disk must not break the reading


def strip(result):
    out = {k: v for k, v in result.items() if not k.startswith("_")}
    return out


# ---------------------------------------------------------------------------

@APP.route("/health")
def health():
    try:
        cfg = load_config()
        meters = sorted((cfg.get("meters") or {}).keys())
        config_ok = True
        error = None
    except Exception as exc:            # noqa: BLE001 - health must never 500
        meters, config_ok, error = [], False, "%s: %s" % (type(exc).__name__, exc)

    return jsonify({
        "status": "ok" if config_ok else "error",
        "config": CONFIG_PATH,
        "config_ok": config_ok,
        "error": error,
        "meters": meters,
        "auth": "token" if TOKEN else "DISABLED",
        "uptime_s": int(time.time() - _STARTED),
        "last_read": {k: int(time.time() - v["at"]) for k, v in _LAST.items()},
    })


def pushed_frames():
    """Every frame in this POST, in the order they were sent.

    Two shapes, because the node on the other end is a microcontroller and the
    cheaper one should stay available:

      raw body            one JPEG, exactly as before
      multipart/form-data any number of file parts

    Several frames matter more than it looks. `read()` requires the frames of
    a burst to agree, which is what removes a flicker or a drum caught
    mid-tick, and a push of one frame cannot run that check -- the answer
    comes back `unconfirmed`. The camera is already awake with the lights on;
    sending two is nearly free there and restores the guarantee.
    """
    out = []
    for key in sorted(request.files):
        for storage in request.files.getlist(key):
            blob = storage.read()
            if blob:
                out.append(blob)
    if out:
        return out
    body = request.get_data()
    return [body] if body else []


@APP.route("/read", methods=["GET", "POST"])
def do_read():
    if not authorised():
        return deny()

    name = request.args.get("meter", "gas")
    save = request.args.get("save", "1") not in ("0", "false", "no")

    prevalue = request.args.get("prevalue")
    # Home Assistant templates an unavailable entity as the literal strings
    # below, and float("unknown") is a 500. Treat them as "no prevalue" so a
    # cold start reads the meter instead of erroring.
    if prevalue in (None, "", "unknown", "unavailable", "none", "None"):
        prevalue = None
    else:
        try:
            prevalue = float(prevalue)
        except ValueError:
            return jsonify({"error": "prevalue %r is not a number" % prevalue}), 400
        if prevalue <= 0:
            prevalue = None

    elapsed = request.args.get("elapsed_s", type=float)

    frames = pushed_frames() if request.method == "POST" else []

    try:
        cfg = load_config()
        meter = get_meter(cfg, name)
    except (KeyError, OSError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400

    # Where the previous reading comes from, in order: what the caller passed,
    # then Home Assistant. The pull model always passed it; a camera on its own
    # clock cannot, so this side asks. A caller that DID pass one is believed
    # without the round trip -- that path still has to work for the tests and
    # for anyone driving /read by hand.
    ha = ha_cfg(cfg, meter)
    prevalue_from = "caller" if prevalue is not None else None
    if prevalue is None and ha:
        try:
            prevalue = ha_prevalue(ha)
            prevalue_from = "home assistant" if prevalue is not None else None
        except (urllib.error.URLError, OSError, ValueError) as exc:
            # Not fatal, and deliberately so: gate() treats a missing prevalue
            # as a cold start and reads the meter anyway. What is lost is the
            # carry check, which the verdict will then say out loud.
            prevalue_from = "unavailable: %s" % exc

    with _LOCK:
        try:
            result = reader.read(meter, _MODELS,
                                 image_bytes=frames or None,
                                 prevalue=prevalue, elapsed_s=elapsed)
        except Exception as exc:        # noqa: BLE001
            return jsonify({
                "meter": name, "value": None, "accepted": False,
                "reason": "%s: %s" % (type(exc).__name__, exc),
            }), 502
        remember(name, result)
        stored = archive(name, meter, result, save)

    payload = strip(result)
    payload["meter"] = name
    payload["image"] = stored
    payload["frames_supplied"] = len(frames)
    payload["prevalue_from"] = prevalue_from

    # The write, and only for a reading that already passed the gate. Its
    # outcome is reported rather than raised: the reading itself is good news
    # and the caller is a sleepy microcontroller that can do nothing useful
    # with a 502 except go back to sleep.
    if result.get("accepted") and ha:
        try:
            payload["published_to"] = ha_publish(ha, result.get("value"))
        except (urllib.error.URLError, OSError, ValueError) as exc:
            payload["published_to"] = None
            payload["publish_error"] = "%s: %s" % (type(exc).__name__, exc)

    return jsonify(payload)


@APP.route("/capture")
def do_capture():
    """A photo and nothing else. This is the endpoint for aiming the camera."""
    if not authorised():
        return deny()
    name = request.args.get("meter", "gas")
    try:
        meter = get_meter(load_config(), name)
    except (KeyError, OSError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400
    with _LOCK:
        try:
            # Corrected AND aligned: what you aim and draw ROIs on has to be
            # the exact space the reader works in. Orientation, or a mirrored
            # front camera, gives rectangles over the wrong drums; an unaligned
            # frame gives rectangles in the wrong coordinate system, which is
            # the same bug one level up and even quieter.
            img = reader.capture_frame(meter, aligned=True)
        except Exception as exc:        # noqa: BLE001
            return jsonify({"error": "%s: %s" % (type(exc).__name__, exc)}), 502
        blob = reader.to_jpeg(img)
        _LAST[name] = {"frame": blob, "annotated": blob, "at": time.time()}
    return Response(blob, mimetype="image/jpeg",
                    headers={"X-Frame-Size": "%dx%d" % (img.shape[1], img.shape[0])})


def _last_blob(name, which):
    """The newest frame: from memory, else from disk, else nothing."""
    held = _LAST.get(name)
    if held:
        return held[which]
    filename = "last.jpg" if which == "frame" else "last_annotated.jpg"
    try:
        with open(IMAGE_DIR / name / filename, "rb") as fh:
            return fh.read()
    except OSError:
        return None


@APP.route("/last.jpg")
def last_jpg():
    if not authorised():
        return deny()
    name = request.args.get("meter", "gas")
    blob = _last_blob(name, "frame")
    if blob is None:
        return jsonify({"error": "nothing read yet for %r" % name}), 404
    return Response(blob, mimetype="image/jpeg")


@APP.route("/last_annotated.jpg")
def last_annotated_jpg():
    if not authorised():
        return deny()
    name = request.args.get("meter", "gas")
    blob = _last_blob(name, "annotated")
    if blob is None:
        return jsonify({"error": "nothing read yet for %r" % name}), 404
    return Response(blob, mimetype="image/jpeg")


@APP.route("/preview", methods=["POST"])
def preview():
    """Try a set of ROIs without saving them. The ROI editor's Test button.

    Returns each crop as a data URI alongside what the model made of it, so a
    bad rectangle is visible as a bad rectangle rather than inferred from a
    wrong total.
    """
    if not authorised():
        return deny()
    payload = request.get_json(force=True, silent=True) or {}
    name = payload.get("meter", "gas")
    rois = payload.get("rois") or []
    use_last = payload.get("use_last", True)

    try:
        meter = get_meter(load_config(), name)
    except (KeyError, OSError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400

    blob = None
    if use_last and name in _LAST:
        blob = _LAST[name]["frame"]

    # Preview asks "do these rectangles land on the drums", which is a question
    # about this one frame -- alignment is irrelevant to it. More to the point,
    # the setup order is aim, set reference, draw ROIs, and anyone who draws
    # first would otherwise get eight question marks and a message about a
    # missing file instead of an answer. Production keeps rejecting on a failed
    # align; only the editor is forgiving, and the align block below still
    # reports what happened.
    tolerant = dict(meter)
    tolerant["align"] = dict(meter.get("align") or {}, on_failure="passthrough")

    # One frame, never five. The editor is pressed repeatedly by someone
    # crouched next to a gas meter, and "do these rectangles land on the drums"
    # is a question about a single frame. Confirmation belongs to /read, where
    # the answer is written somewhere; here it would only add ten seconds to
    # every press. Without this the fallback path -- no cached frame, so blob
    # stays None -- would capture the full burst.
    tolerant["confirm"] = {"samples": 1}

    with _LOCK:
        try:
            result = reader.read(tolerant, _MODELS, image_bytes=blob,
                                 prevalue=payload.get("prevalue"),
                                 rois_override=rois)
        except Exception as exc:        # noqa: BLE001
            return jsonify({"error": "%s: %s" % (type(exc).__name__, exc)}), 502

        crops = []
        img = result["_frame"]
        for roi in rois:
            try:
                patch = reader.crop(img, roi)
                crops.append("data:image/jpeg;base64," + base64.b64encode(
                    reader.to_jpeg(patch, quality=92)).decode())
            except Exception:           # noqa: BLE001
                crops.append(None)
        remember(name, result)

    out = strip(result)
    out["crops"] = crops
    return jsonify(out)


@APP.route("/autofit", methods=["POST"])
def autofit():
    """Fit N evenly pitched ROIs inside one rough box the user dragged.

    The drums share a shaft, so their pitch is uniform and this is a five
    parameter fit rather than 32 loose numbers -- and the model's own
    confidence is the only sane thing to maximise, because nobody can eyeball
    what a CNN finds legible.
    """
    if not authorised():
        return deny()
    payload = request.get_json(force=True, silent=True) or {}
    name = payload.get("meter", "gas")
    bbox = payload.get("bbox")
    count = int(payload.get("count") or 8)
    if not bbox or count < 1:
        return jsonify({"error": "need bbox {x,y,w,h} and count"}), 400

    try:
        meter = get_meter(load_config(), name)
    except (KeyError, OSError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400

    with _LOCK:
        if name in _LAST:
            img = reader.decode(_LAST[name]["frame"])
        else:
            try:
                img = reader.capture_frame(meter)
            except Exception as exc:    # noqa: BLE001
                return jsonify({"error": "%s: %s" % (type(exc).__name__, exc)}), 502
            _LAST[name] = {"frame": reader.to_jpeg(img),
                           "annotated": reader.to_jpeg(img), "at": time.time()}
        try:
            model = _MODELS.get_model(meter["model"])
            rois, info = reader.autofit(img, model, bbox, count,
                                         reader.prep_for(meter, None))
        except Exception as exc:        # noqa: BLE001
            return jsonify({"error": "%s: %s" % (type(exc).__name__, exc)}), 502

    return jsonify({"rois": rois, "fit": info})


@APP.route("/reference", methods=["POST"])
def set_reference():
    """Store the current frame as the alignment reference for this meter.

    Do this once, after the camera is aimed and before defining ROIs -- the
    ROIs are coordinates in this exact frame, and every later photo is warped
    back onto it.
    """
    if not authorised():
        return deny()
    name = request.args.get("meter", "gas")
    try:
        meter = get_meter(load_config(), name)
    except (KeyError, OSError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400

    path = (meter.get("align") or {}).get("reference")
    if not path:
        return jsonify({"error": "meter %r has no align.reference path" % name}), 400

    with _LOCK:
        # Both branches yield a frame that has already been through
        # transform(): _LAST is written by /read and /capture, and the fallback
        # goes through capture_frame(). The reference must live in the same
        # orientation as everything matched against it -- ORB descriptors are
        # not mirror-invariant, so a raw reference and a flipped frame simply
        # fail to align, and the reading is rejected with a confusing reason.
        blob = (_LAST[name]["frame"] if name in _LAST
                else reader.to_jpeg(reader.capture_frame(meter)))
        pathlib.Path(path).parent.mkdir(parents=True, exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(blob)
        _LAST[name] = {"frame": blob, "annotated": blob, "at": time.time()}
    return jsonify({"ok": True, "reference": path, "bytes": len(blob)})


@APP.route("/roi")
def roi_editor():
    here = pathlib.Path(__file__).with_name("roi.html")
    return send_file(str(here), mimetype="text/html")


@APP.route("/aim")
def aim_page():
    """A button that takes a photo, and the photo. Nothing else.

    /capture already returns a frame, but a bare JPEG in a browser gives you
    no way to ask for the next one -- and aiming a camera or turning a lens is
    entirely a matter of asking for the next one. /roi has the same button
    buried in a ROI editor. This is that button on its own.
    """
    here = pathlib.Path(__file__).with_name("aim.html")
    return send_file(str(here), mimetype="text/html")


# ---------------------------------------------------------------------------
# The archive
# ---------------------------------------------------------------------------

_DAY_FMT = "%Y-%m-%d"


class _Sink:
    """A write-only file object that hands its bytes straight to a generator.

    zipfile needs somewhere to write; Flask needs something to yield. This is
    the join between them, and it is the whole reason no temp file appears
    anywhere below. Python 3.7+ zipfile copes with a non-seekable stream by
    emitting data descriptors instead of seeking back to patch headers, so it
    never asks for anything this cannot do.
    """

    def __init__(self):
        self._buf = bytearray()
        self._written = 0

    def write(self, data):
        self._buf += data
        self._written += len(data)
        return len(data)

    def tell(self):
        return self._written

    def flush(self):
        pass

    def take(self):
        out = bytes(self._buf)
        del self._buf[:]
        return out


def _archive_day(path, rel):
    """The day a stored file belongs to.

    Normally the date directory, which archive() writes and is the cheapest and
    most honest source. Frames written before that layout existed sit directly
    under raw/ with no date folder, so fall back to mtime rather than skipping
    them: a download called "all" that quietly omits files is worse than one
    that dates a handful of old frames from the filesystem.
    """
    for part in rel.parts:
        try:
            time.strptime(part, _DAY_FMT)
            return part
        except ValueError:
            continue
    return time.strftime(_DAY_FMT, time.localtime(path.stat().st_mtime))


def _days_between(day, today):
    a = time.mktime(time.strptime(day, _DAY_FMT))
    b = time.mktime(time.strptime(today, _DAY_FMT))
    return int(round((b - a) / 86400.0))


def _archive_walk(meter=None, days=None):
    """Yield (relative path, absolute path, day) for every archived file.

    The .txt sidecars come too. They carry the rejection reason, which is the
    thing that makes a rejected frame worth keeping at all -- a download
    without them is a download of unexplained pictures.

    `days` counts CALENDAR days back from today, so days=1 is today and days=3
    is today plus the two before it. Someone asking for three days means three
    dated folders, not a rolling 72 hours that slices the earliest one in half.
    """
    if not IMAGE_DIR.is_dir():
        return
    cutoff = None
    if days is not None and days > 0:
        cutoff = time.strftime(_DAY_FMT,
                               time.localtime(time.time() - (days - 1) * 86400))
    for path in sorted(IMAGE_DIR.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(IMAGE_DIR)
        if meter and rel.parts[0] != meter:
            continue
        day = _archive_day(path, rel)
        # ISO dates sort lexicographically, which is the entire reason the
        # folders are named this way.
        if cutoff is not None and day < cutoff:
            continue
        yield rel, path, day


# ---------------------------------------------------------------------------
# Firmware, for a node that pulls its own updates
# ---------------------------------------------------------------------------
#
# The camera wakes, shoots, asks one question -- "is there a newer build?" --
# and sleeps. Pull rather than push for the same reason everything else here
# changed: nothing can reach a board that is asleep, so the board has to do
# the reaching, in the one window where it is awake anyway.
#
# Drop a build in /data/firmware and write its version into version.txt. Both
# are served with the same token as everything else; ESP32 HTTPUpdate sends
# headers, so the header form works and the ?token= form is there for curl.

def _firmware_version():
    try:
        with open(FIRMWARE_DIR / "version.txt", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return None


@APP.route("/firmware/version.txt")
def firmware_version():
    if not authorised():
        return deny()
    version = _firmware_version()
    if version is None:
        # 404, not an empty 200. A node comparing itself against "" would read
        # that as a version it does not have and download whatever answers the
        # next request -- which is the one failure mode a self-updating board
        # must never have.
        return jsonify({"error": "no firmware published"}), 404
    return Response(version + "\n", mimetype="text/plain")


@APP.route("/firmware/<path:name>")
def firmware_binary(name):
    if not authorised():
        return deny()
    # No traversal, no surprises: one directory, one extension.
    if not name.endswith(".bin") or "/" in name or ".." in name:
        return jsonify({"error": "not a firmware image"}), 400
    path = FIRMWARE_DIR / name
    if not path.is_file():
        return jsonify({"error": "no such firmware %r" % name}), 404
    return send_file(str(path), mimetype="application/octet-stream",
                     as_attachment=True, download_name=name)


@APP.route("/archive/days")
def archive_days():
    """What is on disk, newest first, and how far back each day sits.

    This exists to be read BEFORE /archive. A full download can be most of a
    gigabyte -- retention keeps a week of raw frames at 175 MB a day -- and the
    byte counts here are what stop that being a surprise on a 1 GB container.
    """
    if not authorised():
        return deny()

    meter = request.args.get("meter")
    days = request.args.get("days", type=int)

    today = time.strftime(_DAY_FMT)
    buckets = {}
    for rel, path, day in _archive_walk(meter, days):
        bucket = buckets.setdefault(day, {
            "day": day, "frames": 0, "bytes": 0, "meters": {},
        })
        parts = rel.parts
        name = parts[0] if len(parts) > 1 else "?"
        klass = parts[1] if len(parts) > 2 else "?"
        try:
            bucket["bytes"] += path.stat().st_size
        except OSError:
            continue
        if path.suffix == ".jpg":
            bucket["frames"] += 1
            counts = bucket["meters"].setdefault(name, {})
            counts[klass] = counts.get(klass, 0) + 1

    out = []
    for day in sorted(buckets, reverse=True):
        bucket = buckets[day]
        bucket["age_days"] = _days_between(day, today)
        out.append(bucket)

    return jsonify({
        "now": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "days": out,
        "total": {
            "frames": sum(d["frames"] for d in out),
            "bytes": sum(d["bytes"] for d in out),
        },
    })


@APP.route("/archive")
def archive_download():
    """Every stored frame as one zip, streamed.

    Streamed rather than assembled. Retention allows about 1.2 GB of raw
    frames; this container has 1 GB of RAM and 5 GB of free disk, so building
    the zip anywhere -- memory or a temp file -- is the one implementation that
    cannot work here.

    ZIP_STORED because JPEGs are already compressed. Deflating them again costs
    the whole archive's worth of CPU on a 1.5 GHz Celeron with no AVX and saves
    a percent or two, and a read may fall due while this is still running.

    No Content-Length: knowing it means walking and sizing the tree before
    sending a byte, and the cost of not knowing is a browser progress bar that
    spins instead of filling. /archive/days answers "how big is this" first,
    which is the better place for that question.

        GET /archive                      everything
        GET /archive?days=3               today and the two before it
        GET /archive?meter=gas&days=1     one meter, today
    """
    if not authorised():
        return deny()

    meter = request.args.get("meter")
    days = request.args.get("days", type=int)

    # Materialised before streaming starts, so the prune timer firing mid
    # download cannot make the generator disagree with itself. Paths only --
    # a week of frames is a few thousand strings.
    files = list(_archive_walk(meter, days))

    name = "metercam-%s%s%s.zip" % (
        (meter + "-") if meter else "",
        ("last%dd-" % days) if days else "",
        time.strftime("%Y%m%d-%H%M%S"),
    )

    def generate():
        sink = _Sink()
        with zipfile.ZipFile(sink, "w", zipfile.ZIP_STORED) as zf:
            for rel, path, _day in files:
                try:
                    zf.write(str(path), arcname=rel.as_posix())
                except OSError:
                    # Pruned between listing and writing, or unreadable. The
                    # rest of the archive is still worth having.
                    continue
                chunk = sink.take()
                if chunk:
                    yield chunk
        yield sink.take()

    # json.dumps quotes and escapes the filename for the header, which beats
    # hand-quoting it -- the name carries a meter id from the query string.
    return Response(generate(), mimetype="application/zip", headers={
        "Content-Disposition": "attachment; filename=%s" % json.dumps(name),
        "X-Archive-Files": str(len(files)),
    })


def create_app():
    return APP


if __name__ == "__main__":
    APP.run(host="0.0.0.0", port=int(os.environ.get("METERCAM_PORT", "8770")))
