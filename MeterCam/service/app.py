"""
HTTP front end for the meter reader.

    METERCAM_CONFIG=config.json METERCAM_TOKEN=... python -m service.app
    docker compose up

---------------------------------------------------------------------------
The whole conversation

The camera sleeps. Every 30 minutes it wakes, lights the meter, takes a few
frames and makes ONE request:

    POST /read?meter=gas&fw=gas-cam-6      multipart, one file part per frame

This service reads the frames, gates the number, writes an accepted reading
into Home Assistant, and answers with the verdict plus the newest firmware
version on offer. The camera compares that version with its own, updates
itself from `/firmware/gas-cam.bin` when the offer is newer, and goes back to
sleep. Nothing here ever calls the camera: a sleeping board answers nothing,
so the board does all the reaching, in the one window where it is awake.

There is no scheduler in here. The camera owns the clock.

---------------------------------------------------------------------------
Auth

`X-Auth-Token`, the same shape the IR bridge uses (see
`HomeAssistant/config/irbridge/rest_commands.yaml`), or `?token=` for curl.
That is a LAN service with no TLS either way; the token stops a stray script
on the network, not a determined attacker.

If METERCAM_TOKEN is unset, auth is OFF and `/health` says so out loud.
"""

from __future__ import annotations

import json
import os
import pathlib
import threading
import time
import urllib.error
import urllib.request

from flask import Flask, Response, jsonify, request, send_file

from . import digits, reader

APP = Flask(__name__)

CONFIG_PATH = os.environ.get("METERCAM_CONFIG", "/config/config.json")
TOKEN = os.environ.get("METERCAM_TOKEN") or None
IMAGE_DIR = pathlib.Path(os.environ.get("METERCAM_IMAGES", "/data/images"))
FIRMWARE_DIR = pathlib.Path(os.environ.get("METERCAM_FIRMWARE", "/data/firmware"))

# Home Assistant's long-lived token. In the environment, never in config.json:
# a token that can write to the house does not belong in a file that gets
# pasted into issues. The config field stays as a fallback for a bench run.
HA_TOKEN = os.environ.get("METERCAM_HA_TOKEN") or None

_LOCK = threading.Lock()          # one reader, one request at a time
_MODELS = reader.ModelCache()
_LAST_READ = {}                   # meter -> epoch of its last /read
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


# ---------------------------------------------------------------------------
# Home Assistant
# ---------------------------------------------------------------------------

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

    A failure is not fatal and must not be. The caller falls back to this
    service's own last accepted reading, and with neither the gate refuses
    (require_prevalue) rather than accept an unguarded number.

    Zero is "no value", not a reading: an input_number with nothing to restore
    comes up at its `min:`, which is 0 for every meter helper in the house.
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
    """Write an accepted reading into the camera's helper in Home Assistant.

    Called ONLY for a reading that already passed the gate. Whether a number
    is good enough to keep is decided by `gate()`, in this repo, in code with
    tests -- not by whoever is holding the token.
    """
    entity = ha.get("write_entity")
    if not entity or not ha.get("write", True):
        return None
    ha_call(ha, "/api/services/input_number/set_value",
            {"entity_id": entity, "value": value})
    return entity


# ---------------------------------------------------------------------------
# Local state: the last accepted reading, and frames worth looking at
# ---------------------------------------------------------------------------

def last_accepted(name, value=None):
    """This service's own memory of the last accepted reading.

    Written on every accept. Read as the prevalue only when Home Assistant has
    none to give AND the config asks for it (`prevalue_fallback:
    "last_accepted"`), which is what carries the first read after a helper is
    created, or a read while Home Assistant restarts.
    """
    path = IMAGE_DIR / name / "last_accepted.json"
    if value is not None:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".part")
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump({"value": value, "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                           "at_epoch": time.time()}, fh)
            os.replace(tmp, path)
        except OSError:
            pass
        return value
    try:
        with open(path, encoding="utf-8") as fh:
            got = float(json.load(fh)["value"])
        return got if got > 0 else None
    except (OSError, ValueError, KeyError, TypeError):
        return None


def last_accepted_record(name):
    """The whole last_accepted.json, for its timestamp. None if unreadable."""
    try:
        with open(IMAGE_DIR / name / "last_accepted.json", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def archive(meter_name, meter, result):
    """Keep a refused read's frames, foldered by date and named for the value.

        gas/rejected/2026-10-02/2026-10-02-00-42-none.jpg

    A reading that failed the gate is the only evidence of why, and by the
    time anyone looks the meter has moved on. Accepted reads are not kept: the
    number is in Home Assistant, and the frame adds nothing to it.

    Beside each frame, the whole answer as .json and the reason as .txt. When
    the frames of a wake disagreed, every one of them is kept (~sN.jpg), since
    which sample differed is the question.

    Pruned by the LXC's metercam-prune timer (deploy/lxc_provision.sh).
    """
    if result.get("accepted"):
        return None
    now = time.localtime()
    directory = IMAGE_DIR / meter_name / "rejected" / time.strftime("%Y-%m-%d", now)

    value = result.get("value")
    # reported_decimals, not the dial's own: the name is the number that would
    # have been published.
    shown = "none" if value is None else "%.*f" % (reader.reported_decimals(meter), value)
    stem = "%s-%s" % (time.strftime("%Y-%m-%d-%H-%M", now), shown)

    try:
        directory.mkdir(parents=True, exist_ok=True)
        # Minute resolution collides when two reads land in the same minute.
        path = directory / ("%s.jpg" % stem)
        nth = 2
        while path.exists():
            path = directory / ("%s-%d.jpg" % (stem, nth))
            nth += 1
        # The camera's own bytes: the decoded frame has already been
        # transformed and warped, and reading it again would apply both twice.
        blob = result.get("_jpeg") or reader.to_jpeg(result["_frame"])
        with open(path, "wb") as fh:
            fh.write(blob)
        for nth, extra in enumerate(result.get("_frames") or [], start=1):
            if extra is result["_frame"]:
                continue
            try:
                with open(path.with_name("%s~s%d.jpg" % (path.stem, nth)), "wb") as fh:
                    fh.write(reader.to_jpeg(extra))
            except OSError:
                break
        with open(path.with_suffix(".txt"), "w", encoding="utf-8") as fh:
            fh.write("%s\nvalue=%s prevalue=%s\n"
                     % (result.get("reason"), result.get("value"),
                        result.get("prevalue")))
        with open(path.with_suffix(".json"), "w", encoding="utf-8") as fh:
            json.dump(strip(result), fh, indent=1, default=str)
    except OSError:
        return None  # a full disk must not break the reading
    return str(path)


def strip(result):
    return {k: v for k, v in result.items() if not k.startswith("_")}


# ---------------------------------------------------------------------------
# Routes
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
        "firmware": _firmware_version(),
        "uptime_s": int(time.time() - _STARTED),
        "last_read_s_ago": {k: int(time.time() - v) for k, v in _LAST_READ.items()},
    })


def pushed_frames():
    """Every frame in this POST, in the order they were sent.

    multipart/form-data with one file part per frame, or a raw JPEG body for a
    single frame. Several frames matter: `read()` requires the frames of a
    wake to agree, which is what removes a flicker or a drum caught mid-tick.
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


@APP.route("/read", methods=["POST"])
def do_read():
    if not authorised():
        return deny()

    name = request.args.get("meter", "gas")
    # The camera says which build it runs, so the running version is visible
    # here -- in the log and beside every refused frame -- without a cable.
    fw = (request.args.get("fw") or "").strip()[:32] or None

    frames = pushed_frames()
    if not frames:
        return jsonify({"error": "no frames in the request"}), 400

    try:
        cfg = load_config()
        meter = get_meter(cfg, name)
    except (KeyError, OSError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400

    # The previous reading: Home Assistant first, else this service's own
    # memory when the config allows it.
    ha = ha_cfg(cfg, meter)
    prevalue, prevalue_from = None, None
    if ha:
        try:
            prevalue = ha_prevalue(ha)
            prevalue_from = "home assistant" if prevalue is not None else None
        except (urllib.error.URLError, OSError, ValueError) as exc:
            prevalue_from = "unavailable: %s" % exc
    if prevalue is None and ha and ha.get("prevalue_fallback") == "last_accepted":
        prevalue = last_accepted(name)
        if prevalue is not None:
            prevalue_from = "last accepted (local)"

    # The rate limit needs the gap since the prevalue was last confirmed, and
    # the camera cannot send it. Without it every read got a flat max_delta
    # however long the camera slept -- see digits.seconds_since().
    elapsed = None
    if prevalue is not None:
        elapsed = digits.seconds_since(last_accepted_record(name), time.time())

    with _LOCK:
        try:
            result = reader.read(meter, _MODELS, frames,
                                 prevalue=prevalue, elapsed_s=elapsed)
        except Exception as exc:        # noqa: BLE001
            result = None
            error = "%s: %s" % (type(exc).__name__, exc)
        else:
            result["prevalue_from"] = prevalue_from
            result["firmware_running"] = fw
            stored = archive(name, meter, result)
            if result.get("accepted") and result.get("value") is not None:
                last_accepted(name, result["value"])
        _LAST_READ[name] = time.time()

    latest = _firmware_version()
    if result is None:
        print("read %s fw=%s -> error %s" % (name, fw, error), flush=True)
        # Still carries the firmware offer: a board whose reads are failing is
        # exactly the board that may need the next build.
        return jsonify({"meter": name, "value": None, "accepted": False,
                        "reason": error, "firmware": latest}), 502

    payload = strip(result)
    payload["meter"] = name
    payload["image"] = stored
    payload["frames_supplied"] = len(frames)
    payload["elapsed_s"] = None if elapsed is None else round(elapsed)
    payload["firmware"] = latest

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

    print("read %s fw=%s -> %s %s%s" % (
        name, fw, result.get("value"),
        "accepted" if result.get("accepted") else "refused: %s" % result.get("reason"),
        (" published to %s" % payload["published_to"]) if payload.get("published_to")
        else (" publish failed: %s" % payload["publish_error"])
        if payload.get("publish_error") else ""), flush=True)
    return jsonify(payload)


# ---------------------------------------------------------------------------
# Firmware, for a board that updates itself
# ---------------------------------------------------------------------------
#
# Drop a build in /data/firmware as gas-cam.bin, then write its version into
# version.txt -- in that order, so a board never sees the new version paired
# with the old binary. Every /read answer carries that version; the board
# updates only when the number after its last '-' is higher than its own.

def _firmware_version():
    try:
        with open(FIRMWARE_DIR / "version.txt", encoding="utf-8") as fh:
            return fh.read().strip() or None
    except OSError:
        return None


@APP.route("/firmware/version.txt")
def firmware_version():
    if not authorised():
        return deny()
    version = _firmware_version()
    if version is None:
        # 404, not an empty 200. A board comparing itself against "" would
        # read that as a version it does not have.
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
    print("firmware %s served" % name, flush=True)
    return send_file(str(path), mimetype="application/octet-stream",
                     as_attachment=True, download_name=name)


def create_app():
    return APP


if __name__ == "__main__":
    APP.run(host="0.0.0.0", port=int(os.environ.get("METERCAM_PORT", "8770")))
