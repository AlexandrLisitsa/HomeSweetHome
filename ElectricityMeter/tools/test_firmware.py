#!/usr/bin/env python3
"""Compile the firmware's logic for a PC, run its tests, check what it publishes.

    python ElectricityMeter/tools/test_firmware.py

Two test programs, both built from the firmware's own sources:

  test_detector.cpp   include/detector.h fed the golden captures in data/golden/:
                      the blink count each capture's README states, plus
                      hysteresis, missed slots and power.
  test_mqtt_link.cpp  src/mqtt_link.cpp against the stubs in tools/stubs/:
                      restoring the register from the broker, the meter-reading
                      and level commands, rejected payloads, the restart button.

Then every MQTT discovery payload the second one published is parsed as JSON
and checked for what Home Assistant needs. A malformed payload is the failure
that matters most here and shows least: Home Assistant drops the entity and
logs one line nobody reads.

Uses a native g++ when one is on PATH, otherwise the gcc:13 Docker image.
Everything it writes goes to ElectricityMeter/tools/build/ (git-ignored).
"""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
FIRMWARE = "../firmware/electricity-meter"
CXXFLAGS = ["-std=c++17", "-O1", "-g", "-Wall", "-Wextra"]
GCC_IMAGE = "gcc:13"

BUILDS = [
    ["g++", *CXXFLAGS, f"-I{FIRMWARE}/include", "test_detector.cpp",
     "-o", "build/test_detector"],
    # stubs/ first, so its config.h wins over a real include/config.h on the
    # developer's machine (and stands in for the missing one in CI).
    ["g++", *CXXFLAGS, "-Wno-unused-parameter", "-Istubs", f"-I{FIRMWARE}/include",
     "test_mqtt_link.cpp", f"{FIRMWARE}/src/mqtt_link.cpp", "-o", "build/test_mqtt_link"],
]
RUNS = ["./build/test_detector", "./build/test_mqtt_link"]

# What every discovery payload must carry, and what each one adds.
COMMON = {"name", "unique_id", "default_entity_id", "device"}
EXPECTED = {
    "homeassistant/sensor/electricity_meter/energy/config": {
        "default_entity_id": "sensor.electricity_meter_energy",
        "device_class": "energy", "state_class": "total_increasing",
        "unit_of_measurement": "kWh"},
    "homeassistant/sensor/electricity_meter/power/config": {
        "default_entity_id": "sensor.electricity_meter_power",
        "device_class": "power", "state_class": "measurement",
        "unit_of_measurement": "W"},
    "homeassistant/number/electricity_meter/reading/config": {
        "default_entity_id": "number.electricity_meter_reading",
        "entity_category": "config", "unit_of_measurement": "kWh"},
    "homeassistant/number/electricity_meter/threshold_on/config": {
        "default_entity_id": "number.electricity_meter_threshold_on",
        "entity_category": "config", "min": 1, "max": 1023},
    "homeassistant/number/electricity_meter/threshold_off/config": {
        "default_entity_id": "number.electricity_meter_threshold_off",
        "entity_category": "config", "min": 1, "max": 1022},
    "homeassistant/button/electricity_meter/restart/config": {
        "default_entity_id": "button.electricity_meter_restart",
        "entity_category": "config", "device_class": "restart"},
}


def compile_and_run():
    (HERE / "build").mkdir(exist_ok=True)
    if shutil.which("g++") and os.name != "nt":
        for cmd in BUILDS:
            if subprocess.call(cmd, cwd=HERE):
                return 1
        rc = 0
        for run in RUNS:
            print("\n$ " + run)
            rc |= subprocess.call([run], cwd=HERE)
        return rc
    script = " && ".join(" ".join(c) for c in BUILDS)
    script += " && " + " ; ".join(f"echo; echo '$ {r}'; {r} || fail=1" for r in RUNS)
    script = "fail=0; " + script + "; exit $fail"
    cmd = ["docker", "run", "--rm", "-v", f"{PROJECT}:/src", "-w", "/src/tools",
           GCC_IMAGE, "sh", "-c", script]
    return subprocess.call(cmd, env=dict(os.environ, MSYS_NO_PATHCONV="1"))


def check_discovery():
    print("\ndiscovery payloads")
    failed = 0

    def check(label, ok, got=""):
        nonlocal failed
        failed += not ok
        print("  %-4s %-60s %s" % ("ok" if ok else "FAIL", label, got))

    rows = (HERE / "build" / "published.tsv").read_text(encoding="utf-8").splitlines()
    seen = {}
    for row in rows:
        topic, payload = row.split("\t", 1)
        if topic.startswith("homeassistant/"):
            try:
                seen[topic] = json.loads(payload)
            except json.JSONDecodeError as e:
                check(f"{topic} is JSON", False, str(e))
    check("one payload per expected entity", set(seen) == set(EXPECTED),
          sorted(set(seen) ^ set(EXPECTED)))
    devices = {json.dumps(p.get("device"), sort_keys=True) for p in seen.values()}
    check("all on one device", len(devices) == 1)
    for topic, want in EXPECTED.items():
        p = seen.get(topic, {})
        short = topic.split("/")[3]
        missing = COMMON - set(p)
        check(f"{short}: has {', '.join(sorted(COMMON))}", not missing, sorted(missing))
        wrong = {k: p.get(k) for k, v in want.items() if p.get(k) != v}
        check(f"{short}: {', '.join(want)}", not wrong, wrong)
        avail = "availability_topic" in p or "availability" in p
        check(f"{short}: goes unavailable with the board", avail)
    energy = seen.get("homeassistant/sensor/electricity_meter/energy/config", {})
    check("energy: unavailable until the register is set",
          energy.get("availability_mode") == "all" and
          any("value_json.set" in a.get("value_template", "")
              for a in energy.get("availability", [])))

    states = [json.loads(r.split("\t", 1)[1]) for r in rows
              if r.startswith("electricity-meter/state\t")]
    check("every state message is JSON", bool(states), len(states))
    keys = {"energy", "power", "pulses", "uncertain", "missed", "rssi", "uptime",
            "on", "off", "set"}
    check("state carries every field the templates read",
          all(keys <= set(s) for s in states))
    return failed


def main():
    rc = compile_and_run()
    if (HERE / "build" / "published.tsv").exists():
        rc |= 1 if check_discovery() else 0
    else:
        rc = 1
    print("\n" + ("FAILED" if rc else "all firmware checks passed"))
    return rc


if __name__ == "__main__":
    sys.exit(main())
