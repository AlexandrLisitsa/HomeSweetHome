"""
Mirror of app/src/main/java/ua/pp/homesweeethome/irbridge/Codecs.kt, line for line,
so the Kotlin logic can be exercised without an Android SDK.

Any divergence between this and Codecs.kt is a bug in one of them.
"""
import base64
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ASSET = os.path.join(ROOT, "app/src/main/assets/candidates.json")
SMARTIR = os.environ.get("SMARTIR", "/tmp/SmartIR")

TICK_MICROS = 8192.0 / 269.0
PRONTO_CLOCK_MICROS = 0.241246
LONG_GAP_MICROS = 20_000


def _trim_trailing_gap(us):
    while us and us[-1] > LONG_GAP_MICROS:
        us.pop()
    if us and len(us) % 2 == 0:
        us.pop()
    return us


def from_broadlink_base64(b64):
    s = b64.strip()
    s += "=" * ((4 - len(s) % 4) % 4)
    raw = base64.b64decode(s)
    if len(raw) < 5:
        raise ValueError(f"packet too short ({len(raw)} bytes)")
    if raw[0] != 0x26:
        raise ValueError(f"first byte is 0x{raw[0]:02x}, expected 0x26")
    repeat = raw[1]
    declared = raw[2] | (raw[3] << 8)
    end = min(4 + declared, len(raw))
    ticks, i = [], 4
    while i < end:
        b = raw[i]
        if b == 0x00:
            if i + 2 >= end:
                break
            ticks.append((raw[i + 1] << 8) | raw[i + 2])
            i += 3
        else:
            ticks.append(b)
            i += 1
    if not ticks:
        raise ValueError("zero durations")
    us = [int(round(t * TICK_MICROS)) for t in ticks]
    return _trim_trailing_gap(us), 38000, repeat


def from_pronto(hex_str):
    words = [int(w, 16) for w in hex_str.replace(",", " ").split()]
    if len(words) < 4:
        raise ValueError("need >= 4 words")
    if words[0] != 0x0000:
        raise ValueError(f"leading word 0x{words[0]:04x} is not a learned code")
    unit = words[1] * PRONTO_CLOCK_MICROS
    carrier = int(round(1_000_000.0 / unit))
    intro, rep = words[2] * 2, words[3] * 2
    if len(words) < 4 + intro + rep:
        raise ValueError("truncated")
    body = words[4:4 + intro] if intro else words[4 + intro:4 + intro + rep]
    us = [int(round(w * unit)) for w in body]
    return _trim_trailing_gap(us), carrier, 1


# ---------------------------------------------------------------- test vectors

fails = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  {detail}" if detail else ""))
    if not cond:
        fails.append(name)


# 1. Pronto: canonical NEC1 code. Header must be ~9000us mark / 4500us space,
#    bits 560/560 and 560/1690, carrier ~38.4 kHz.
nec = "0000 006D 0022 0000 0156 00AB 0015 0040 0015 0015 0015 0040 0015 0015 0015 0040 0015 0015 0015 0040 0015 0015 0015 0015 0015 0040 0015 0015 0015 0040 0015 0015 0015 0040 0015 0015 0015 0040 0015 0040 0015 0040 0015 0040 0015 0040 0015 0015 0015 0015 0015 0015 0015 0015 0015 0015 0015 0015 0015 0015 0015 0015 0015 0040 0015 0040 0015 0040 0015 0040 0015 05F1"
p, carrier, _ = from_pronto(nec)
check("pronto NEC carrier ~38.4kHz", 38000 <= carrier <= 38800, f"got {carrier}Hz")
check("pronto NEC header mark ~9000us", 8800 <= p[0] <= 9200, f"got {p[0]}us")
check("pronto NEC header space ~4500us", 4300 <= p[1] <= 4700, f"got {p[1]}us")
check("pronto NEC zero-bit mark ~560us", 520 <= p[2] <= 600, f"got {p[2]}us")
# bit 0 of the test payload is a 1, so its space is the long one.
check("pronto NEC one-bit space ~1690us", 1600 <= p[3] <= 1750, f"got {p[3]}us")
check("pronto NEC zero-bit space ~560us", 520 <= p[5] <= 600, f"got {p[5]}us")
check("pronto uses intro seq (34 pairs -> 68, minus trailing gap)",
      len(p) == 67, f"got {len(p)} marks")
check("pronto pattern ends on a mark", len(p) % 2 == 1)

# 2. Pronto: a predefined (0100) code must be refused, not silently mangled.
try:
    from_pronto("0100 000A 0000 0000")
    check("pronto rejects 0x0100 codes", False)
except ValueError:
    check("pronto rejects 0x0100 codes", True)

# 3. Broadlink: real frames out of the SmartIR database must decode to the
#    header timings their protocols actually specify.
import json
midea_json = os.path.join(SMARTIR, "codes/climate/1380.json")
if not os.path.exists(midea_json):
    print("SKIP broadlink real-frame checks: no SmartIR checkout at " + SMARTIR)
    print("      git clone --depth 1 https://github.com/smartHomeHub/SmartIR.git /tmp/SmartIR")
    raise SystemExit(0)
db = json.load(open(midea_json))   # Midea
midea = db["commands"]["off"]
p, c, _ = from_broadlink_base64(midea)
check("broadlink Midea header 4400/4400", 4200 <= p[0] <= 4600 and 4200 <= p[1] <= 4600,
      f"got {p[0]}/{p[1]}us")
check("broadlink Midea frame ends on a mark", len(p) % 2 == 1, f"{len(p)} marks")
check("broadlink Midea no zero/negative durations", all(v > 0 for v in p))
check("broadlink Midea no leftover 100ms terminator", max(p) < 20000, f"max {max(p)}us")

# 4. RF codes must be refused: they cannot be emitted by an IR LED.
rf = base64.b64encode(bytes([0xb2, 0x00, 0x04, 0x00, 0x10, 0x10, 0x10, 0x10])).decode()
try:
    from_broadlink_base64(rf)
    check("broadlink rejects 0xb2 RF packets", False)
except ValueError as e:
    check("broadlink rejects 0xb2 RF packets", "0xb2" in str(e), str(e))

# 5. The >=256 escape must be decoded as big-endian, not as three durations.
#    0x00 0x01 0x2C = 300 ticks = ~9136us
esc = base64.b64encode(bytes([0x26, 0x00, 0x05, 0x00, 0x00, 0x01, 0x2C, 0x10, 0x10])).decode()
p, _, _ = from_broadlink_base64(esc)
check("broadlink decodes the 0x00 hi lo escape", len(p) == 3 and 9100 <= p[0] <= 9200,
      f"got {p}")

# 6. Unpadded base64 (SmartIR ships some) must still decode.
stripped = midea.rstrip("=")
p2, _, _ = from_broadlink_base64(stripped)
check("broadlink tolerates missing padding", p2 == from_broadlink_base64(midea)[0])

# 7. Every bundled candidate must survive the transmitter's own sanity checks.
cands = json.load(open(ASSET))["candidates"]
bad = [c["idx"] for c in cands
       if not c["on"] or len(c["on"]) % 2 == 0 or min(c["on"]) <= 0
       or len(c["on"]) > 1024 or sum(c["on"]) > 2_000_000]
check("all 'on' frames pass IrTransmitter.sanitise", not bad, f"offenders: {bad[:10]}")
bad_off = [c["idx"] for c in cands if c["off"] and
           (len(c["off"]) % 2 == 0 or min(c["off"]) <= 0
            or len(c["off"]) > 1024 or sum(c["off"]) > 2_000_000)]
check("all 'off' frames pass IrTransmitter.sanitise", not bad_off, f"offenders: {bad_off[:10]}")
check("candidate indices are dense and 0-based",
      [c["idx"] for c in cands] == list(range(len(cands))))

print()
print(f"{len(cands)} candidates, "
      f"{sum(1 for c in cands if c['off'])} with an off frame")
print("FAILURES:", fails if fails else "none")
raise SystemExit(1 if fails else 0)
