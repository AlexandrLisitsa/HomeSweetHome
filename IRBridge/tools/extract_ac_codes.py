#!/usr/bin/env python3
"""
Build the full state table for ONE A/C protocol, for stateful climate control.

`extract_codes.py` reduces every SmartIR set to a single on/off pair, because
its job is a brute-force sweep. Once you know which set your unit answers to,
that reduction is exactly the wrong shape: an A/C remote transmits its entire
state in every frame, so "set 23 degrees" is a different frame from
"set 24 degrees", not a delta applied to the last one.

This script keeps the whole mode/fan/temperature matrix for a single set.

Usage:
    python3 tools/extract_ac_codes.py 1380 /tmp/SmartIR/codes/climate/1380.json

Output: app/src/main/assets/ac_codes.json

Patterns are stored as microsecond arrays rather than the original Broadlink
base64. Two reasons: the phone does no decoding at send time (this runs on a
2018 handset), and the arrays are the exact form already proven on real
hardware, so there is no second decoder implementation to keep honest.

Identical patterns are pooled and referenced by index. It is not a
space-saving trick — 157 codes collapse to 95 because some axes genuinely do
not vary. On Midea, `heat_cool` emits the same frame for every fan speed,
because the unit chooses its own fan in auto mode. Pooling makes that visible
instead of hiding it behind duplicated data.
"""
import json
import os
import sys

# Reuse the decoder that produced candidates.json, rather than writing a
# second one that can drift from it.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract_codes import decode_broadlink  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "app/src/main/assets/ac_codes.json")


def build(set_id: str, src_path: str) -> dict:
    with open(src_path, encoding="utf-8") as fh:
        sm = json.load(fh)

    if sm.get("commandsEncoding") != "Base64":
        raise SystemExit(f"{src_path}: expected Base64 encoding, got "
                         f"{sm.get('commandsEncoding')!r}")

    commands = sm["commands"]
    if "off" not in commands:
        raise SystemExit(f"{src_path}: no 'off' command — cannot model power")

    pool: list[list[int]] = []
    index: dict[tuple[int, ...], int] = {}

    def intern(b64: str) -> int:
        us, _ = decode_broadlink(b64)
        key = tuple(us)
        if key not in index:
            index[key] = len(pool)
            pool.append(us)
        return index[key]

    off_ref = intern(commands["off"])

    modes: dict[str, dict[str, dict[str, int]]] = {}
    temps_seen: set[float] = set()
    for mode, by_fan in commands.items():
        if mode == "off":
            continue
        if not isinstance(by_fan, dict):
            # A mode with a single code and no fan/temperature axis. None of
            # the Midea sets look like this, but other manufacturers' do.
            modes[mode] = {"_": {"_": intern(by_fan)}}
            continue
        modes[mode] = {}
        for fan, by_temp in by_fan.items():
            modes[mode][fan] = {}
            for temp, b64 in by_temp.items():
                modes[mode][fan][str(int(float(temp)))] = intern(b64)
                temps_seen.add(float(temp))

    return {
        "source": f"smartHomeHub/SmartIR codes/climate/{set_id}.json",
        "setId": set_id,
        "manufacturer": sm.get("manufacturer", "Unknown"),
        "supportedModels": sm.get("supportedModels", []),
        "carrierHz": 38000,
        "minTemp": int(float(sm.get("minTemperature", min(temps_seen)))),
        "maxTemp": int(float(sm.get("maxTemperature", max(temps_seen)))),
        "tempStep": int(float(sm.get("precision", 1))),
        "modes": list(modes.keys()),
        "fans": sm.get("fanModes", []),
        "off": off_ref,
        "map": modes,
        "patterns": pool,
    }


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: extract_ac_codes.py <set-id> <path-to-smartir-json>")
    set_id, src = sys.argv[1], sys.argv[2]
    data = build(set_id, src)

    with open(OUT, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, separators=(",", ":"))

    combos = sum(len(t) for m in data["map"].values() for t in m.values())
    print(f"{data['manufacturer']} set {set_id}: {combos} combinations -> "
          f"{len(data['patterns'])} unique patterns")
    print(f"  modes {data['modes']}")
    print(f"  fans  {data['fans']}")
    print(f"  temps {data['minTemp']}..{data['maxTemp']} step {data['tempStep']}")
    print(f"  wrote {OUT} ({os.path.getsize(OUT)} bytes)")


if __name__ == "__main__":
    main()
