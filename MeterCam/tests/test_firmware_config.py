"""The camera firmware's two builds, read from platformio.ini and
config.h.example without a compiler.

    python tests/test_firmware_config.py

One source, two boards: gas-cam (the kitchen, live since 2026-10-02) and
water-cam (the bathroom). The water env overrides the meter, the version and
the binary with -D flags, which only works while config.h guards those three
with #ifndef. What must never happen: the gas env picking up a water override,
the two builds sharing a version prefix or a binary (MeterCam would hand one
board the other's image), or a bare `pio run -t upload` flashing both.
"""
import configparser
import pathlib
import re
import sys

FW = pathlib.Path(__file__).resolve().parent.parent / "firmware" / "gas-cam"
GUARDED = ("METERCAM_METER", "FIRMWARE_VERSION", "FIRMWARE_BINARY")

checks = 0


def check(name, cond, got=""):
    global checks
    checks += 1
    print("  %s %s %s" % ("ok  " if cond else "FAIL", name, "" if cond else got))
    if not cond:
        sys.exit(1)


ini = configparser.ConfigParser(interpolation=None)
ini.read(FW / "platformio.ini", encoding="utf-8")


def flags(env):
    """-D defines an env sets, as {name: value}; ${...} lines are inherited."""
    out = {}
    for line in ini[env].get("build_flags", "").split("\n"):
        m = re.match(r'\s*-D(\w+)(?:=(.*))?$', line)
        if m:
            out[m.group(1)] = (m.group(2) or "").replace('\\"', '"').strip('"')
    return out


print("platformio.ini")
check("a gas-cam env", ini.has_section("env:gas-cam"), ini.sections())
check("a water-cam env", ini.has_section("env:water-cam"), ini.sections())
check("a bare pio run means gas-cam only",
      ini.get("platformio", "default_envs", fallback="").strip() == "gas-cam",
      ini.get("platformio", "default_envs", fallback=None))
check("water-cam builds the same board as gas-cam",
      ini["env:water-cam"].get("extends", "").strip() == "env:gas-cam")
check("water-cam keeps gas-cam's flags (PSRAM)",
      "${env:gas-cam.build_flags}" in ini["env:water-cam"].get("build_flags", ""))

gas, water = flags("env:gas-cam"), flags("env:water-cam")
check("gas-cam overrides none of the per-meter defines",
      not (set(GUARDED) & set(gas)), gas)
check("gas-cam still has PSRAM", "BOARD_HAS_PSRAM" in gas, gas)
check("water-cam sets all three", set(GUARDED) <= set(water), water)
check("water-cam reads the water meter", water.get("METERCAM_METER") == "water", water)
check("water-cam versions as water-cam-<n>",
      re.fullmatch(r"water-cam-\d+", water.get("FIRMWARE_VERSION", "")) is not None, water)
check("water-cam fetches water-cam.bin", water.get("FIRMWARE_BINARY") == "water-cam.bin", water)

print("config.h.example")
cfg = (FW / "include" / "config.h.example").read_text(encoding="utf-8")


def define(name):
    m = re.search(r'^#define %s\s+"([^"]*)"' % name, cfg, re.M)
    return m.group(1) if m else None


for name in GUARDED:
    guarded = re.search(r"^#ifndef %s\n#define %s\b[^\n]*\n#endif" % (name, name), cfg, re.M)
    check("%s is #ifndef-guarded" % name, guarded is not None)
check("the default meter is gas", define("METERCAM_METER") == "gas", define("METERCAM_METER"))
check("the default version is gas-cam-<n>",
      re.fullmatch(r"gas-cam-\d+", define("FIRMWARE_VERSION") or "") is not None,
      define("FIRMWARE_VERSION"))
check("the default binary is gas-cam.bin", define("FIRMWARE_BINARY") == "gas-cam.bin",
      define("FIRMWARE_BINARY"))
check("the two builds never share a binary",
      define("FIRMWARE_BINARY") != water.get("FIRMWARE_BINARY"))
check("nor a version prefix",
      (define("FIRMWARE_VERSION") or "").rsplit("-", 1)[0]
      != water.get("FIRMWARE_VERSION", "").rsplit("-", 1)[0])

print("main.cpp")
src = (FW / "src" / "main.cpp").read_text(encoding="utf-8")
check("asks MeterCam for its own meter",
      'String("/read?meter=") + METERCAM_METER' in src)
check("fetches its own binary", '"/firmware/" + FIRMWARE_BINARY' in src)

print("%d checks passed" % checks)
