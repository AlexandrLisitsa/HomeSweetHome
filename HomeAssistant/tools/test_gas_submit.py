#!/usr/bin/env python3
"""config/gas/gas_submit.py, offline: where it finds MeterCam, the month a
reading is for, prepare against a fake MeterCam, and the state file.

    python HomeAssistant/tools/test_gas_submit.py

MeterCam is a local HTTP server on a free port that answers
/last_accepted.jpg the way the real one does (the frame, plus X-Value and
X-At-Epoch). Nothing leaves the machine.
"""
import http.server
import importlib
import io
import json
import os
import sys
import tempfile
import threading
import time
from contextlib import redirect_stdout
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "config" / "gas"))
TMP = Path(tempfile.mkdtemp())
os.environ["GAS_SECRETS"] = str(TMP / "secrets.yaml")
os.environ["GAS_WWW"] = str(TMP / "www")
os.environ["GAS_STATE"] = str(TMP / ".state.json")
os.environ.pop("METERCAM_URL", None)
import gas_submit as gs  # noqa: E402

FAILED = []


def check(label, got, want):
    ok = got == want
    if not ok:
        FAILED.append(label)
    print("  %-4s %-62s %r%s" % ("ok" if ok else "FAIL", label, got,
                                 "" if ok else "  want %r" % (want,)))


def run(*argv):
    sys.argv = ["gas_submit.py", *argv]
    buf = io.StringIO()
    with redirect_stdout(buf):
        gs.main()
    return json.loads(buf.getvalue())


print("where MeterCam is")
check("no metercam_url anywhere: a clear failure, no guessed address",
      run("prepare"), {"ok": False, "error": "metercam_url is not set in secrets.yaml"})
(TMP / "secrets.yaml").write_text('gasbot_token: "x"\nmetercam_url: "http://192.0.2.8:8770/"\n',
                                  encoding="utf-8")
check("from secrets.yaml, trailing slash dropped", gs.config(), {"metercam": "http://192.0.2.8:8770"})
os.environ["METERCAM_URL"] = "http://192.0.2.9:8770"
check("METERCAM_URL wins over secrets.yaml", gs.config(), {"metercam": "http://192.0.2.9:8770"})
os.environ.pop("METERCAM_URL")

print("the month a reading is for")
for day, want in [(datetime(2026, 11, 1), "2026-10"), (datetime(2026, 11, 5), "2026-10"),
                  (datetime(2027, 1, 3), "2026-12")]:
    check("%s -> %s" % (day.date(), want), gs.period(day), want)


class FakeMeterCam(http.server.BaseHTTPRequestHandler):
    value = "2290.47"
    at = time.time() - 600

    def do_GET(self):
        if not self.path.startswith("/last_accepted.jpg"):
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("X-Value", FakeMeterCam.value)
        self.send_header("X-At-Epoch", str(FakeMeterCam.at))
        self.end_headers()
        self.wfile.write(b"\xff\xd8 fake jpeg \xff\xd9")

    def log_message(self, *a):
        pass


server = http.server.HTTPServer(("127.0.0.1", 0), FakeMeterCam)
threading.Thread(target=server.serve_forever, daemon=True).start()
(TMP / "secrets.yaml").write_text('metercam_url: "http://127.0.0.1:%d"\n' % server.server_port,
                                  encoding="utf-8")
importlib.reload(gs)

print("prepare, against a fake MeterCam")
p = run("prepare")
check("ok", p["ok"], True)
check("the camera's value, and rounded down", (p["value_raw"], p["value_floor"]), (2290.47, 2290))
check("ten minutes old is not stale", p["camera_stale"], False)
check("the photo is saved under www, with a random name",
      p["image"].startswith("/local/gas_meter/") and len(list((TMP / "www").glob("*.jpg"))) == 1,
      True)
FakeMeterCam.at = time.time() - 7 * 3600
check("seven hours old is stale", run("prepare")["camera_stale"], True)
server.shutdown()
p = run("prepare")
check("MeterCam down: ok, but no value and a reason",
      (p["ok"], p["value_floor"], "camera_error" in p), (True, None, True))

print("the state file")
check("nothing sent yet", run("prepare")["already_submitted"], False)
r = run("record", "2290")
check("record", (r["ok"], r["value"]), (True, 2290))
p = run("prepare")
check("now this month counts as sent", (p["already_submitted"], p["submitted_value"]),
      (True, 2290))
check("record refuses a non-number", run("record", "abc")["ok"], False)

print("\n%s" % ("FAILED: " + ", ".join(FAILED) if FAILED else "all checks passed"))
sys.exit(1 if FAILED else 0)
