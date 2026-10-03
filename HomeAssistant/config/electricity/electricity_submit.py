"""The monthly electricity reading: the local half, the window and the memory.

    python3 /config/electricity/electricity_submit.py prepare           # period, window, state
    python3 /config/electricity/electricity_submit.py record 38500 6450  # remember it was sent

Prints one JSON object on stdout and always exits 0, so Home Assistant's
shell_command hands the answer to the script (response_variable) instead of
swallowing it as a failed command. `ok: false` plus `error` is a failure.

The values themselves are not here: they are Home Assistant's own
sensor.electricity_meter_register_day / _night. The Telegram half is not here
either: packages/electricity_submit.yaml calls MeterBots' /yasno/bot/status
and /yasno/bot/submit as rest_commands, because walking the bot takes longer
than shell_command's fixed 60 s.

YASNO takes a reading in the last 2 days of a month and the first 3 of the
next. Either way it is the reading for the month that is ending or has just
ended, and that month is the key in .state.json: one reading per month.
"""
import argparse
import calendar
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

KYIV = ZoneInfo("Europe/Kyiv")
HERE = Path(__file__).resolve().parent
STATE_PATH = Path(os.environ.get("ELECTRICITY_STATE") or HERE / ".state.json")
# YASNO's window: the last LAST_DAYS days of a month, the first FIRST_DAYS of
# the next. packages/electricity_submit.yaml repeats it for the send script.
LAST_DAYS = 2
FIRST_DAYS = 3


class Fail(Exception):
    """A failure worth a sentence in the notification."""


def window_open(today):
    last = calendar.monthrange(today.year, today.month)[1]
    return today.day <= FIRST_DAYS or today.day > last - LAST_DAYS


def period(today):
    """The month a reading is for: this one at its end, the last one at the
    start of the next."""
    if today.day > FIRST_DAYS:
        return "%04d-%02d" % (today.year, today.month)
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


def cmd_prepare(today):
    sent = load_state().get("submitted", {}).get(period(today))
    return {"ok": True, "period": period(today), "window_open": window_open(today),
            "window": "the last %d days of a month and the first %d of the next"
                      % (LAST_DAYS, FIRST_DAYS),
            "already_submitted": sent is not None, "submitted": sent}


def cmd_record(today, day, night):
    """The bot accepted DAY NIGHT: remember the month, stop the reminders."""
    try:
        values = {"day": int(day), "night": int(night)}
    except (TypeError, ValueError):
        raise Fail("'%s %s' is not two whole numbers" % (day, night))
    state = load_state()
    state.setdefault("submitted", {})[period(today)] = values
    state["last"] = dict(values, at=today.isoformat(timespec="seconds"))
    save_state(state)
    return {"ok": True, "period": period(today), **values}


def main(argv=None, now=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("command", choices=("prepare", "record"))
    ap.add_argument("values", nargs="*")
    args = ap.parse_args(argv)
    today = now or datetime.now(KYIV)
    try:
        if args.command == "prepare":
            out = cmd_prepare(today)
        else:
            if len(args.values) != 2:
                raise Fail("record needs DAY and NIGHT")
            out = cmd_record(today, *args.values)
    except Fail as exc:
        out = {"ok": False, "error": str(exc)}
    except Exception as exc:        # noqa: BLE001 -- the script needs JSON
        out = {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
