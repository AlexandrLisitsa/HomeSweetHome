"""The control panel (service/panel.py) against a throwaway archive.

    docker compose exec metercam python tests/test_panel.py

Imports the real app, so it needs Flask and OpenCV: run it in the container,
like test_reader.py. Nothing here touches /data -- every path is a temp dir.
"""
import json
import os
import pathlib
import sys
import tempfile
import time

TMP = pathlib.Path(tempfile.mkdtemp(prefix="metercam-panel-"))
IMAGES = TMP / "images"
FIRMWARE = TMP / "firmware"
CONFIG = TMP / "config.json"
CONFIG.write_text(json.dumps({"meters": {"gas": {
    "rois": [{"x": 0, "y": 0, "w": 10, "h": 10}],
    "gate": {"min_confidence": 0.5, "min_confidence_last_digit": 0.3},
    "home_assistant": {"write": True, "write_entity": "input_number.x"},
}}}), encoding="utf-8")
os.environ.update(METERCAM_CONFIG=str(CONFIG), METERCAM_IMAGES=str(IMAGES),
                  METERCAM_FIRMWARE=str(FIRMWARE), METERCAM_TOKEN="s3cret")

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from service import app as core, panel  # noqa: E402

client = core.create_app().test_client()
checks = 0


def check(name, cond, got=""):
    global checks
    checks += 1
    print("  %s %s %s" % ("ok  " if cond else "FAIL", name, "" if cond else got))
    if not cond:
        sys.exit(1)


def frame(kind, day, stem, side=None, jpg=b"\xff\xd8fake\xff\xd9"):
    d = IMAGES / "gas" / kind / day
    d.mkdir(parents=True, exist_ok=True)
    (d / (stem + ".jpg")).write_bytes(jpg)
    if side is not None:
        (d / (stem + ".json")).write_text(json.dumps(side), encoding="utf-8")


today = time.strftime("%Y-%m-%d")
frame("raw", today, today + "-01-00-2262.10",
      {"accepted": True, "value": 2262.10, "confidence": {"per_drum": [0.9], "min": 0.9},
       "drums": [1.0], "firmware_running": "gas-cam-7"})
frame("rejected", today, today + "-01-30-none",
      {"accepted": False, "value": None, "reason": "align: inliers: 12, below 60"})
frame("rejected", today, today + "-02-00-2262.40",
      {"accepted": False, "value": 2262.40, "reason": "confidence: drum 3 at 0.21, below 0.50"})
frame("rejected", today, today + "-02-00-2262.40~s1")          # an extra of that wake
frame("raw", today, today + "-02-30-2262.12")                  # no sidecar at all

print("open on the LAN")
check("/ renders without a token", client.get("/").status_code == 200)
check("/api/reads without a token", client.get("/api/reads").status_code == 200)
check("/read still wants the token", client.post("/read", data=b"x").status_code == 401)
check("/last.jpg still wants the token", client.get("/last.jpg").status_code == 401)
check("/archive still wants the token", client.get("/archive").status_code == 401)

print("reads")
reads = client.get("/api/reads?day=" + today).get_json()["reads"]
check("four reads, the ~s extra is not one", len(reads) == 4, [r["file"] for r in reads])
check("oldest first", [r["at"][11:] for r in reads] == ["01:00", "01:30", "02:00", "02:30"],
      [r["at"] for r in reads])
check("reason class", reads[1]["reason_class"] == "align", reads[1])
check("the extra frame is listed with its wake", reads[2]["extras"] == [today + "-02-00-2262.40~s1.jpg"],
      reads[2]["extras"])
check("a raw frame without a sidecar counts as accepted", reads[3]["accepted"] and not reads[3]["has_sidecar"])
only = client.get("/api/reads?day=%s&kind=rejected" % today).get_json()["reads"]
check("kind=rejected filters", {r["kind"] for r in only} == {"rejected"} and len(only) == 2)
check("bad day refused", client.get("/api/reads?day=../../etc").status_code == 400)
check("bad kind refused", client.get("/api/reads?kind=ref").status_code == 400)
check("bad meter refused", client.get("/api/reads?meter=../x").status_code == 400)

print("series and overview")
s = client.get("/api/series?days=999").get_json()
check("days capped at 30", s["days"] == 30, s["days"])
check("refusals counted by class", s["per_day"][-1]["refused"] == {"align": 1, "confidence": 1}, s["per_day"][-1])
check("thresholds from the gate", s["thresholds"] == {"min_confidence": 0.5, "min_confidence_last_digit": 0.3})
o = client.get("/api/overview").get_json()
check("overview: newest read", o["last"]["file"] == today + "-02-30-2262.12.jpg", o["last"])
check("overview: next wake = last push + 1800", o["next_wake_epoch"] == o["last_push_epoch"] + 1800)
check("overview: publish settings", o["publish"] == {"write": True, "entity": "input_number.x"})

print("images: no way out of the archive")
check("archived frame served",
      client.get("/img/gas/raw/%s/%s-01-00-2262.10.jpg" % (today, today)).status_code == 200)
for bad in ("/img/gas/raw/%s/..%%2f..%%2fconfig.json" % today,
            "/img/gas/ref/%s/x.jpg" % today,
            "/img/gas/raw/2026-1-1/x.jpg",
            "/img/gas/raw/%s/x.json" % today,
            "/img/..%%2f/raw/%s/x.jpg" % today):
    # 400 from the panel, or a 308 from werkzeug normalising the path: never a 200.
    check("refused: %s" % bad, client.get(bad).status_code != 200)
check("/live: only last and last_accepted", client.get("/live/gas/config.jpg").status_code == 404)

print("thumbnails")
real = None
try:
    import cv2
    import numpy as np
    ok, buf = cv2.imencode(".jpg", np.full((600, 800, 3), 128, np.uint8))
    real = buf.tobytes()
except ImportError:
    pass
if real:
    frame("raw", today, today + "-03-00-2262.20", {"accepted": True, "value": 2262.2}, jpg=real)
    r = client.get("/img/gas/raw/%s/%s-03-00-2262.20.jpg?thumb=1" % (today, today))
    thumb = IMAGES / "gas" / "raw" / today / ".thumbs" / (today + "-03-00-2262.20.jpg")
    check("thumbnail made on first view", r.status_code == 200 and thumb.is_file())
    check("thumbnail is small", cv2.imdecode(np.frombuffer(thumb.read_bytes(), np.uint8), 1).shape[1] == 360)
    src = thumb.parent.parent / thumb.name
    check("thumbnail carries the frame's mtime (pruned with it)",
          abs(thumb.stat().st_mtime - src.stat().st_mtime) < 1)
    days = core.days_summary()
    check("archive/days does not count thumbnails",
          days["total"]["frames"] == 6, days["total"])
    names = [rel.as_posix() for rel, _p, _d in core._archive_walk()]
    check("the archive zip skips .thumbs", not any(".thumbs" in n for n in names), names)
else:
    print("  skip (no OpenCV here)")

print("firmware")
good = b"\xe9" + b"\0" * 1000
check("a version without a number is refused",
      panel.publish_firmware(FIRMWARE, good, "gas-cam", None) is not None)
check("not an ESP32 image is refused",
      panel.publish_firmware(FIRMWARE, b"MZ" + b"\0" * 100, "gas-cam-8", "gas-cam-7") is not None)
check("the same version is refused",
      panel.publish_firmware(FIRMWARE, good, "gas-cam-7", "gas-cam-7") is not None)
check("a lower version is refused",
      panel.publish_firmware(FIRMWARE, good, "gas-cam-6", "gas-cam-7") is not None)
check("nothing written by a refusal", not (FIRMWARE / "version.txt").exists())
check("a higher version is published",
      panel.publish_firmware(FIRMWARE, good, "gas-cam-8", "gas-cam-7") is None)
check(".bin and version.txt both there",
      (FIRMWARE / "gas-cam.bin").read_bytes() == good
      and (FIRMWARE / "version.txt").read_text().strip() == "gas-cam-8")
check(".bin written before version.txt",
      (FIRMWARE / "gas-cam.bin").stat().st_mtime_ns <= (FIRMWARE / "version.txt").stat().st_mtime_ns)
r = client.post("/api/firmware", data={"version": "gas-cam-8"})
check("the route refuses a missing .bin", r.status_code == 400, r.get_json())

print("%d checks passed" % checks)
