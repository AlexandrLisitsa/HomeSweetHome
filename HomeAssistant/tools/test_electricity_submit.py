#!/usr/bin/env python3
"""The monthly electricity reading's local half and its YAML, checked offline.

    python HomeAssistant/tools/test_electricity_submit.py

config/electricity/electricity_submit.py decides the window and the month a
reading is for; packages/electricity_submit.yaml repeats the window in the
send script and asks on some of its days. Three copies of one rule, so this
renders the YAML's templates for every day of three years and checks they
agree with the script. Then the button handler's parsing of the action ids
and typed corrections, and the state file.
"""
import io
import json
import os
import sys
import tempfile
from contextlib import redirect_stdout
from datetime import date, datetime, timedelta
from pathlib import Path

from ha_automation_sim import KYIV, House, find, load_package, render

HERE = Path(__file__).resolve().parent
CONFIG = HERE.parent / "config"
sys.path.insert(0, str(CONFIG / "electricity"))
STATE = Path(tempfile.mkdtemp()) / ".state.json"
os.environ["ELECTRICITY_STATE"] = str(STATE)
import electricity_submit as es  # noqa: E402

PKG = load_package(CONFIG / "packages" / "electricity_submit.yaml")
SEND_WINDOW = PKG["script"]["electricity_submit_send"]["sequence"][0]["if"][0]["value_template"]
ASK = find(PKG["automation"], "id", "electricity_submit_monthly")
ASK_WHEN = ASK["condition"][0]["value_template"]
HANDLER = find(PKG["automation"], "id", "electricity_submit_button")
EDIT = HANDLER["action"][1]["choose"][2]["sequence"][0]["variables"]
SUBMIT = HANDLER["action"][1]["choose"][1]["sequence"][0]["data"]

FAILED = []


def check(label, got, want):
    ok = got == want
    if not ok:
        FAILED.append(label)
    print("  %-4s %-64s %r%s" % ("ok" if ok else "FAIL", label, got,
                                 "" if ok else "  want %r" % (want,)))


def at(d, hh=21):
    return datetime(d.year, d.month, d.day, hh, 0, tzinfo=KYIV)


def tpl(template, now, **variables):
    return render(template, House(now), variables)


print("window and period, by the script")
for d, open_, per in [
        (date(2026, 10, 29), False, "2026-10"), (date(2026, 10, 30), True, "2026-10"),
        (date(2026, 10, 31), True, "2026-10"), (date(2026, 11, 1), True, "2026-10"),
        (date(2026, 11, 3), True, "2026-10"), (date(2026, 11, 4), False, "2026-11"),
        (date(2026, 4, 28), False, "2026-04"), (date(2026, 4, 29), True, "2026-04"),
        (date(2027, 2, 26), False, "2027-02"), (date(2027, 2, 27), True, "2027-02"),
        (date(2028, 2, 28), True, "2028-02"), (date(2028, 2, 29), True, "2028-02"),
        (date(2026, 12, 31), True, "2026-12"), (date(2027, 1, 2), True, "2026-12")]:
    check("%s: open %s, for %s" % (d, open_, per),
          (es.window_open(at(d)), es.period(at(d))), (open_, per))

print("the YAML agrees with the script, every day of 2026-2028")
send_off, ask_off, asks = [], [], 0
d = date(2026, 1, 1)
while d < date(2029, 1, 1):
    now = at(d)
    if tpl(SEND_WINDOW, now) != (not es.window_open(now)):
        send_off.append(str(d))
    if tpl(ASK_WHEN, now):
        asks += 1
        if not es.window_open(now):
            ask_off.append(str(d))
    d += timedelta(days=1)
check("send script's window == electricity_submit.window_open", send_off, [])
check("the monthly ask only runs inside the window", ask_off, [])
check("it asks 4 times a month (last day, 1st..3rd)", asks, 4 * 36)

print("the button handler")
act = "ELEC_SUBMIT_38500_6450"
check("submit: day from the action id",
      render(SUBMIT["day"], House(at(date(2026, 11, 1))), {"act": act}), 38500)
check("submit: night from the action id",
      render(SUBMIT["night"], House(at(date(2026, 11, 1))), {"act": act}), 6450)


def edit(typed, act="ELEC_EDIT_38800_6750"):
    v = {"act": act, "typed": typed}
    h = House(at(date(2026, 11, 1)))
    v["bounds"] = render(EDIT["bounds"], h, v)
    v["parts"] = render(EDIT["parts"], h, v)
    return render(EDIT["valid"], h, v)


for typed, want in [("38500 6450", True), ("38500  6450", True), ("38800 6750", True),
                    ("38801 6450", False), ("38500 6751", False), ("38500", False),
                    ("38500,6450", False), ("38500.5 6450", False), ("abc def", False),
                    ("", False), ("38500 6450 1", False), ("-1 6450", False)]:
    check("typed %r -> %s" % (typed, "sent" if want else "refused"), edit(typed), want)
check("no bounds (registers had no value) refuses everything",
      edit("38500 6450", "ELEC_EDIT_0_0"), False)

print("the state file")


def run(*argv, now):
    buf = io.StringIO()
    with redirect_stdout(buf):
        es.main(list(argv), now=now)
    return json.loads(buf.getvalue())


oct31, nov2, nov4 = at(date(2026, 10, 31)), at(date(2026, 11, 2)), at(date(2026, 11, 4))
check("nothing sent yet", run("prepare", now=oct31)["already_submitted"], False)
check("record", run("record", "38500", "6450", now=oct31),
      {"ok": True, "period": "2026-10", "day": 38500, "night": 6450})
p = run("prepare", now=nov2)
check("on the 2nd, October counts as sent", (p["already_submitted"], p["submitted"]),
      (True, {"day": 38500, "night": 6450}))
check("on the 4th, November is a new month", run("prepare", now=nov4)["already_submitted"],
      False)
check("record refuses non-numbers", run("record", "38500", "x", now=oct31)["ok"], False)
check("record needs both values", run("record", "38500", now=oct31)["ok"], False)

print("\n%s" % ("FAILED: " + ", ".join(FAILED) if FAILED else "all checks passed"))
sys.exit(1 if FAILED else 0)
