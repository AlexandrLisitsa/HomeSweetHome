#!/usr/bin/env python3
"""
Build a candidate IR-code sweep table for the Android IR bridge.

Source: SmartIR climate code database (Broadlink Base64 sets only).
Output: candidates.json  -- raw microsecond patterns ready for
        Android ConsumerIrManager.transmit(38000, pattern).

Broadlink packet layout (mjg59/python-broadlink protocol.md):
  [0]      0x26 = IR
  [1]      repeat count
  [2..3]   payload length, little endian
  [4..]    durations in ticks; a tick is 2^-15 s.
           A value >= 256 is escaped as 0x00 <hi> <lo> (big endian).
  tail     0x00 0x0d 0x05  (~102 ms of silence, the capture timeout)

Ticks -> microseconds uses the community-standard 8192/269 factor
(the inverse of the us*269/8192 in python-broadlink), i.e. ~30.45 us.
"""
import base64, json, os, collections

TICK_US = 8192.0 / 269.0          # ~30.4535 us
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(os.environ.get("SMARTIR", "/tmp/SmartIR"), "codes/climate")
OUT = os.path.join(ROOT, "app/src/main/assets/candidates.json")
MIN_MARKS = 40                    # an A/C frame is long; drop TV-sized blips
MAX_MARKS = 600                   # ConsumerIrManager chokes on huge patterns


def decode_broadlink(b64: str):
    """Broadlink base64 -> (list of microsecond durations, repeat count)."""
    s = b64.strip()
    s += "=" * (-len(s) % 4)          # some SmartIR entries ship unpadded
    raw = base64.b64decode(s)
    if len(raw) < 5 or raw[0] != 0x26:
        raise ValueError(f"not an IR packet (first byte 0x{raw[0]:02x})")
    repeat = raw[1]
    length = raw[2] | (raw[3] << 8)
    body = raw[4:4 + length]

    out, i = [], 0
    while i < len(body):
        v = body[i]
        if v == 0x00:
            if i + 2 >= len(body):
                break                     # trailing terminator, discard
            v = (body[i + 1] << 8) | body[i + 2]
            i += 3
        else:
            i += 1
        out.append(v)

    us = [int(round(t * TICK_US)) for t in out]
    # A pattern must start with a mark and end with a mark: ConsumerIrManager
    # reads it as on,off,on,off,... and a trailing gap is wasted airtime.
    while us and us[-1] > 20000:
        us.pop()
    if len(us) % 2 == 0 and us:
        us.pop()
    return us, repeat


def pick(commands: dict):
    """Return (on_pattern_b64, off_pattern_b64) from a SmartIR command tree."""
    off = commands.get("off")
    on = None
    # prefer cool -> a middling fan -> a middling temperature
    modes = [m for m in ("cool", "heat_cool", "heat", "dry", "fan_only") if m in commands]
    for m in modes:
        node = commands[m]
        while isinstance(node, dict):
            keys = list(node.keys())
            # aim for the middle of whatever this level offers
            node = node[keys[len(keys) // 2]]
        if isinstance(node, str):
            on = node
            break
    return on, off


def main():
    cands, seen = [], {}
    skipped = collections.Counter()

    for fn in sorted(os.listdir(SRC), key=lambda s: int(s.split(".")[0])):
        if not fn.endswith(".json"):
            continue
        try:
            d = json.load(open(os.path.join(SRC, fn)))
        except Exception:
            skipped["unparseable"] += 1
            continue
        if d.get("commandsEncoding") != "Base64":
            skipped["not-broadlink"] += 1
            continue

        on_b64, off_b64 = pick(d.get("commands", {}))
        if not on_b64:
            skipped["no-on-command"] += 1
            continue
        try:
            on_us, _ = decode_broadlink(on_b64)
            off_us = decode_broadlink(off_b64)[0] if off_b64 else []
        except Exception as e:
            skipped[f"decode:{e}"] += 1
            continue

        if not (MIN_MARKS <= len(on_us) <= MAX_MARKS):
            skipped["bad-length"] += 1
            continue

        # dedupe: quantise to 50us buckets so near-identical captures collapse
        sig = tuple(v // 50 for v in on_us)
        if sig in seen:
            seen[sig]["models"] = sorted(set(
                seen[sig]["models"] + d.get("supportedModels", [])))[:6]
            skipped["duplicate"] += 1
            continue

        entry = {
            "id": fn.split(".")[0],
            "manufacturer": d.get("manufacturer", "?"),
            "models": d.get("supportedModels", [])[:6],
            "on": on_us,
            "off": off_us,
        }
        seen[sig] = entry
        cands.append(entry)

    # Midea/Coolix-family first: IRremoteESP8266 lists COOLIX for Beko+Midea,
    # and Daewoo split units in this region are commonly OEM'd from that family.
    PRIORITY = ("Midea", "Coolix", "Beko", "Gree", "TCL", "Tornado",
                "Electra", "Samsung", "LG")
    def rank(c):
        try:
            return PRIORITY.index(c["manufacturer"])
        except ValueError:
            return len(PRIORITY)
    cands.sort(key=lambda c: (rank(c), c["manufacturer"], c["id"]))
    for i, c in enumerate(cands):
        c["idx"] = i

    out = {
        "source": "smartHomeHub/SmartIR codes/climate (Broadlink Base64 sets)",
        "tickMicros": round(TICK_US, 4),
        "carrierHz": 38000,
        "count": len(cands),
        "candidates": cands,
    }
    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"))

    print(f"candidates: {len(cands)}")
    print("skipped:", dict(skipped))
    print("wrote:", OUT, os.path.getsize(OUT), "bytes")
    print("\nfirst 12:")
    for c in cands[:12]:
        print(f"  [{c['idx']:3d}] {c['manufacturer']:22s} marks={len(c['on']):3d} "
              f"{','.join(c['models'])[:40]}")
    lens = [len(c["on"]) for c in cands]
    print(f"\nmark counts: min={min(lens)} max={max(lens)} median={sorted(lens)[len(lens)//2]}")


if __name__ == "__main__":
    main()
