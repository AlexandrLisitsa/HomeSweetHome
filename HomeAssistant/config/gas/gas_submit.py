"""The monthly gas reading: the local half, photo and memory.

    python3 /config/gas/gas_submit.py prepare          # photo + value + state
    python3 /config/gas/gas_submit.py record 2262      # remember it was sent

Prints one JSON object on stdout and always exits 0, so Home Assistant's
shell_command hands the answer to the automation (response_variable) instead
of swallowing it as a failed command. `ok: false` plus `error` is a failure.

The Telegram half is NOT here. Walking @mygrmu_bot takes up to a minute, and
shell_command has a fixed 60 s limit, so packages/gas_submit.yaml calls
MeterCam's /gas/bot/status and /gas/bot/submit as rest_commands with a
5-minute timeout, and only asks this script for what is quick and local:

    prepare   the frame MeterCam last accepted (GET /last_accepted.jpg, whose
              X-Value / X-At-Epoch headers carry its reading), saved under
              /config/www/gas_meter for the notification; the value rounded
              down; whether this month already went in
    record    after the bot accepted: write the month to .state.json, which
              stops the reminders

From secrets.yaml next door: metercam_url (default http://192.168.0.8:8770).
"""
import argparse
import json
import math
import os
import re
import secrets as pysecrets
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

KYIV = ZoneInfo("Europe/Kyiv")
HERE = Path(__file__).resolve().parent
# On the box HERE is /config/gas: secrets in /config, photos in /config/www.
SECRETS_PATH = Path(os.environ.get("GAS_SECRETS") or HERE.parent / "secrets.yaml")
WWW_DIR = Path(os.environ.get("GAS_WWW") or HERE.parent / "www" / "gas_meter")
STATE_PATH = Path(os.environ.get("GAS_STATE") or HERE / ".state.json")
PHOTO_KEEP_DAYS = 92
# The Dniprovska filiia's own rule (dp.grmu.com.ua, 2026-09-30 notice):
# readings for the past month on the 1st..5th. The bot is the judge; this
# only keeps the buttons off a notification that could not succeed.
# packages/gas_submit.yaml repeats the 5 for the button handler.
WINDOW_DAYS = range(1, 6)
# A camera answer older than this is not "the meter now" any more. The board
# wakes every 30 min; six hours means several refused or missed wakes.
STALE_S = 6 * 3600
# An upper bound on a typed correction: the camera's reading plus this. A
# fat-fingered extra digit is the mistake worth catching; a month is ~30.
MAX_ABOVE_CAMERA = 50


class Fail(Exception):
    """A failure worth a sentence in the notification."""


def read_secrets(*keys):
    """Flat scalars from secrets.yaml; a line scan, like dtek_poll.py."""
    try:
        text = SECRETS_PATH.read_text(encoding="utf-8")
    except OSError:
        return {}
    out = {}
    for line in text.splitlines():
        m = re.match(r'^([A-Za-z0-9_]+):\s*(.*?)\s*$', line)
        if not m or m.group(1) not in keys:
            continue
        value = m.group(2)
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        out[m.group(1)] = value
    return out


def config():
    sec = read_secrets("metercam_url")
    return {"metercam": (os.environ.get("METERCAM_URL") or sec.get("metercam_url")
                         or "http://192.168.0.8:8770").rstrip("/")}


def period(today):
    """The month a reading is for: on the 1st..5th, the month just ended."""
    y, m = (today.year - 1, 12) if today.month == 1 else (today.year, today.month - 1)
    return "%04d-%02d" % (y, m)


def load_state():
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_state(state):
    tmp = STATE_PATH.with_suffix(".part")
    tmp.write_text(json.dumps(state, indent=1), encoding="utf-8")
    os.replace(tmp, STATE_PATH)


def fetch_photo(base):
    """The last accepted frame and its reading, saved under www/gas_meter."""
    url = base + "/last_accepted.jpg?meter=gas"
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            blob = resp.read()
            value = float(resp.headers["X-Value"])
            at_epoch = float(resp.headers.get("X-At-Epoch") or time.time())
    except (urllib.error.URLError, OSError, TypeError, ValueError) as exc:
        raise Fail("MeterCam has no accepted frame: %s" % exc)
    taken = datetime.fromtimestamp(at_epoch, KYIV)
    WWW_DIR.mkdir(parents=True, exist_ok=True)
    # The random part: /local/ needs no login, so the name must not be
    # guessable from the date alone.
    name = "%s-%s.jpg" % (taken.strftime("%Y-%m-%d-%H-%M"), pysecrets.token_hex(8))
    (WWW_DIR / name).write_bytes(blob)
    cutoff = time.time() - PHOTO_KEEP_DAYS * 86400
    for old in WWW_DIR.glob("*.jpg"):
        try:
            if old.stat().st_mtime < cutoff:
                old.unlink()
        except OSError:
            pass
    return {"value_raw": value, "taken_at": taken.strftime("%Y-%m-%d %H-%M"),
            "age_s": round(time.time() - at_epoch),
            "image": "/local/gas_meter/" + name}


def cmd_prepare(cfg):
    today = datetime.now(KYIV)
    out = {"ok": True, "period": period(today), "window_open": today.day in WINDOW_DAYS,
           "window": "%d..%d" % (WINDOW_DAYS.start, WINDOW_DAYS.stop - 1)}
    try:
        out.update(fetch_photo(cfg["metercam"]))
        out["value_floor"] = int(math.floor(out["value_raw"]))
        out["camera_stale"] = out["age_s"] > STALE_S
    except Fail as exc:
        out.update({"camera_error": str(exc), "camera_stale": True,
                    "value_raw": None, "value_floor": None, "image": None,
                    "taken_at": today.strftime("%Y-%m-%d %H-%M")})

    sent = load_state().get("submitted", {}).get(out["period"])
    out["already_submitted"] = sent is not None
    out["submitted_value"] = sent
    out["max_above_camera"] = MAX_ABOVE_CAMERA
    return out


def cmd_record(raw_value):
    """The bot accepted `raw_value`: remember the month, stop the reminders."""
    try:
        value = int(float(str(raw_value).replace(",", ".")))
    except ValueError:
        raise Fail("'%s' is not a number" % raw_value)
    today = datetime.now(KYIV)
    state = load_state()
    state.setdefault("submitted", {})[period(today)] = value
    state["last"] = {"value": value, "at": today.isoformat(timespec="seconds")}
    save_state(state)
    return {"ok": True, "value": value, "period": period(today)}


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("command", choices=("prepare", "record"))
    ap.add_argument("value", nargs="?")
    args = ap.parse_args()
    cfg = config()
    try:
        if args.command == "prepare":
            out = cmd_prepare(cfg)
        else:
            if args.value is None:
                raise Fail("record needs a value")
            out = cmd_record(args.value)
    except Fail as exc:
        out = {"ok": False, "error": str(exc)}
    except Exception as exc:        # noqa: BLE001 -- the automation needs JSON
        out = {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
