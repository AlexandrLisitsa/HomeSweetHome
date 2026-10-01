#!/usr/bin/env python3
"""
Tests for the reading arithmetic. Plain asserts, run directly:

    python tests/test_reader.py

Two tiers, and the split matters.

Sections 1-3 are pure arithmetic: the carry rule and the plausibility gate.
They need no models, no camera and no OpenCV, so they run anywhere
and they run now. These guard the failure that cannot be undone -- a misread
that comes out as a DECREASE, which Home Assistant takes as a meter reset and
which retyping the value afterwards does not repair. Section 2 exists because
that failure is a plausible consequence of getting one comparison backwards.

The rest needs OpenCV, Flask or the model weights, so on a bare workstation it
skips and in the container it runs:

    docker compose exec metercam python tests/test_reader.py

The weights are not in git: no stated licence upstream.

Matches the house convention in HomeAssistant/tools/test_dtek_schedule.py:
no pytest, no fixtures framework, exit 0 or 1.
"""

from __future__ import annotations

import glob
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

FAILURES = []
CHECKS = [0]
MARK = [0]


def check(label, got, want):
    CHECKS[0] += 1
    if got != want:
        FAILURES.append("%s\n     got  %r\n     want %r" % (label, got, want))


def section(title):
    print("\n%s" % title)
    print("-" * len(title))
    MARK[0] = CHECKS[0]


def done():
    print("  %d checks" % (CHECKS[0] - MARK[0]))


# ---------------------------------------------------------------------------

def test_resolve():
    section("1. resolve(): one drum, decided by the drum to its right")
    from service.digits import resolve

    # Steady state: the fraction agrees with the neighbour, nothing to fix.
    check("mid-digit, right high", resolve(1.69, 6), 1)
    check("mid-digit, right low", resolve(2.10, 1), 2)

    # The two corrections this function exists for. Both are the CNN reading a
    # drum on the wrong side of a boundary it is physically sitting on.
    check("overshoot: reads 2.01, right drum says 9 -> not rolled yet",
          resolve(2.01, 9), 1)
    check("undershoot: reads 1.98, right drum says 0 -> has rolled",
          resolve(1.98, 0), 2)

    # Wrap-around. 0 minus one is 9, not -1; 9 plus one is 0, not 10.
    check("wrap down", resolve(0.01, 9), 9)
    check("wrap up", resolve(9.98, 0), 0)

    done()


def test_assemble():
    section("2. assemble(): eight drums into one number")
    from service.digits import assemble

    # 4821.637 as the drums would actually sit: each drum carries the fraction
    # of the one to its right, because they are geared continuously.
    #  position:  10000      1000     100     10     1     .1   .01  .001
    steady = [0.4821637, 4.821637, 8.21637, 2.1637, 1.637, 6.37, 3.7, 7.0]
    value, digits, raw = assemble(steady, decimals=3)
    check("steady value", value, 4821.637)
    check("steady digits", digits, [0, 4, 8, 2, 1, 6, 3, 7])
    check("steady raw", raw, "04821637")

    # The last drum keeps its fraction: 0.001 m3 per digit means a drum at 7.4
    # is 0.0074, and truncating it would quantise every reading to the litre.
    frac = list(steady)
    frac[-1] = 7.4
    value, _, _ = assemble(frac, decimals=3)
    check("last drum keeps its fraction", value, 4821.6374)

    # A rollover, read correctly.
    rolling = [0.4821999, 4.821999, 8.21999, 2.1999, 1.999, 9.99, 9.9, 9.0]
    value, digits, _ = assemble(rolling, decimals=3)
    check("just before rollover", value, 4821.999)

    # The same rollover with the units drum misread one step past the boundary.
    # Without the carry rule this reads 4822.999 -- a jump of a whole cubic
    # metre that would sail through any rate check tuned for real gas use.
    overshot = list(rolling)
    overshot[4] = 2.01
    value, digits, _ = assemble(overshot, decimals=3)
    check("overshoot corrected, not +1 m3", value, 4821.999)

    # And one step short of it, just after the roll.
    after = [0.4822001, 4.822001, 8.22001, 2.2001, 1.98, 0.01, 0.1, 1.0]
    value, _, _ = assemble(after, decimals=3)
    check("undershoot corrected", value, 4822.001)

    done()


def test_home_assistant():
    """Fetching the prevalue and writing the reading back.

    A board that wakes on its own timer cannot carry the previous reading or
    act on the verdict, so this service fetches the one and writes the other.

    What these pin is the boundary, not the plumbing: no url or no token means
    no Home Assistant at all, and `write: false` reads and reports without
    touching the house.
    """
    section("8. home assistant: fetch the prevalue, write the reading")
    from service import app as A

    calls = []
    real = A.ha_call

    def fake(ha, path, payload=None):
        calls.append((path, payload))
        return {"state": "2246.916"} if path.startswith("/api/states/") else {}

    A.ha_call = fake
    try:
        cfg = {"home_assistant": {
            "url": "http://ha:8123", "token": "t",
            "prevalue_entity": "input_number.gas",
            "write_entity": "input_number.gas"}}
        ha = A.ha_cfg(cfg, {})
        check("ha: configured when there is a url and a token", bool(ha), True)
        check("ha: the prevalue comes back as a number",
              A.ha_prevalue(ha), 2246.916)
        check("ha: publishing calls the helper's own service",
              A.ha_publish(ha, 2246.92), "input_number.gas")
        check("ha: with the value and nothing else", calls[-1],
              ("/api/services/input_number/set_value",
               {"entity_id": "input_number.gas", "value": 2246.92}))

        # A second meter can point at its own helper without repeating the url.
        ha2 = A.ha_cfg(cfg, {"home_assistant": {"write_entity": "input_number.water"}})
        check("ha: a meter may override one field and inherit the rest",
              (ha2["write_entity"], ha2["url"]),
              ("input_number.water", "http://ha:8123"))

        # No Home Assistant is said by saying nothing.
        check("ha: no url means no home assistant", A.ha_cfg({}, {}), None)
        # The environment's token stands in for a missing config one, and in
        # the container the environment HAS one -- so take it away for this.
        real_token, A.HA_TOKEN = A.HA_TOKEN, None
        try:
            check("ha: and neither does a url without a token",
                  A.ha_cfg({"home_assistant": {"url": "http://ha:8123"}}, {}), None)
        finally:
            A.HA_TOKEN = real_token
        check("ha: write:false reads and reports, and touches nothing",
              A.ha_publish(dict(ha, write=False), 1.0), None)

        # A helper Home Assistant cannot answer for is a cold start, which
        # gate() already knows how to read the meter through.
        A.ha_call = lambda ha, path, payload=None: {"state": "unavailable"}
        check("ha: an unavailable helper is no prevalue, not an error",
              A.ha_prevalue(ha), None)
        A.ha_call = lambda ha, path, payload=None: {"state": "0"}
        check("ha: and neither is a zero", A.ha_prevalue(ha), None)
    finally:
        A.ha_call = real
    done()


def test_align_gate():
    """Section 2b: is this alignment trustworthy, not merely possible?

    The fixtures are measurements, not inventions. The rejecting case is the
    real frame this guard was written for -- 21 inliers of 147 matches at
    dx=-808.3, which the service accepted as ok=True on 2026-09-05 and read
    confidently off the wrong part of the dial. The accepting case is the
    quality config.example.json records for a genuine match on this meter:
    around a thousand inliers, correcting tens of pixels.

    If either of those ever flips, something has quietly loosened.
    """
    from service.digits import align_gate

    section("2c. align_gate(): trustworthy, not merely possible")

    good = {"ok": True, "inliers": 1000, "matches": 1200,
            "dx": -26.0, "dy": 4.0, "rotation_deg": 0.4}
    check("a genuine match passes", align_gate(good, {}), (True, None))

    # The frame that motivated the guard.
    bad = {"ok": True, "inliers": 21, "matches": 147,
           "dx": -808.3, "dy": 8.0, "rotation_deg": -0.0}
    ok, why = align_gate(bad, {})
    check("the 808 px frame is refused", ok, False)
    check("  and says which bar it missed", why, "inliers: 21, below 60")

    # Same frame once the inlier floor is lowered: the RATIO must still catch
    # it. These are two independent bars on purpose -- a count alone scales
    # with how textured the scene is.
    ok, why = align_gate(bad, {"min_inliers": 10})
    check("ratio catches it when the count does not", ok, False)
    check("  and shows the arithmetic", why, "inlier ratio: 21/147 = 0.14, below 0.35")

    # Correcting drift is what alignment is FOR, so the shift bound has to be
    # generous enough not to defeat it. 120 px with 2 degrees is the largest
    # correction config.example.json records as having worked.
    stretch = {"ok": True, "inliers": 900, "matches": 1100,
               "dx": 120.0, "dy": -40.0, "rotation_deg": 2.0}
    check("a large but real correction still passes", align_gate(stretch, {}), (True, None))

    huge = dict(good, dx=400.0)
    ok, why = align_gate(huge, {})
    check("a shift no bracket could make is refused", ok, False)
    check("  naming the axis", why, "dx: 400.0 px, beyond 300")

    spun = dict(good, rotation_deg=25.0)
    check("a spun frame is refused", align_gate(spun, {})[0], False)

    # align() itself failing must not be reported as a quality problem.
    check("an outright failure passes its own reason through",
          align_gate({"ok": False, "reason": "too few features"}, {}),
          (False, "too few features"))
    check("a missing result is refused", align_gate(None, {})[0], False)
    check("an empty result is refused", align_gate({}, {})[0], False)

    # A reference adopted from this very frame was never warped: there is no
    # transform to score, and scoring it as absent would refuse every first run.
    check("an adopted reference is exempt",
          align_gate({"ok": True, "adopted": True}, {}), (True, None))

    # A guard that silently does nothing when unconfigured reads like
    # protection and is not. Defaults must apply to an empty config -- which
    # every check above relies on, passing {}.
    check("bars can be switched off explicitly",
          align_gate(bad, {"min_inliers": None, "min_inlier_ratio": None,
                           "max_shift_px": None, "max_rotation_deg": None}),
          (True, None))

    done()


def test_confirm_samples():
    """Section 2d: do several readings of the same dial agree?

    The point of the section is one thing the function CANNOT do, which is
    easy to forget once five green ticks are on screen: sampling catches
    random error and is blind to systematic error. Five identical readings of
    misplaced ROIs agree perfectly and are perfectly wrong. The last check
    here exists to keep that fact written down next to the code.
    """
    from service.digits import confirm_samples

    section("2d. confirm_samples(): agreement across a burst")

    v = 2246.916
    check("five identical readings pass",
          confirm_samples([v] * 5, 3, {}), (True, None, v))

    # The last drum advances about once every two minutes on this house's
    # burn rate, so across a ten-second burst it legitimately can.
    ticked = [2246.916, 2246.916, 2246.917, 2246.917, 2246.917]
    check("the last drum may tick once",
          confirm_samples(ticked, 3, {}), (True, None, 2246.917))
    check("  and the freshest sample is what is reported",
          confirm_samples(ticked, 3, {})[2], ticked[-1])

    # Comparing values rather than digit lists makes a carry free: 919 -> 920
    # is one tick, where a digit-wise comparison would see four changes.
    carry = [2246.919, 2246.919, 2246.920, 2246.920, 2246.920]
    check("a carry is one tick, not four changed digits",
          confirm_samples(carry, 3, {})[0], True)

    check("two ticks is too many",
          confirm_samples([2246.916] * 3 + [2246.918] * 2, 3, {})[0], False)

    # The meter only counts up. A sample below the one before it is a misread
    # however small, and never a real reading.
    ok, why, val = confirm_samples([2246.917] + [2246.916] * 4, 3, {})
    check("a reading that falls is refused", ok, False)
    check("  with no value returned", val, None)
    check("  naming the sample", why,
          "confirm: sample 2 fell to 2246.916 from 2246.917")

    ok, why, _ = confirm_samples([v, v, 2251.004, v, v], 3, {})
    check("one wild sample is refused", ok, False)

    check("a short burst is refused",
          confirm_samples([v] * 3, 3, {})[0], False)
    check("no samples at all is refused",
          confirm_samples([], 3, {})[0], False)
    check("a sample with no value is refused",
          confirm_samples([v, v, None, v, v], 3, {})[0], False)

    # Exactness matters: these are floats that must compare as displayed.
    check("float noise does not create disagreement",
          confirm_samples([2246.916, 2246.9160000000001] + [2246.916] * 3,
                          3, {})[0], True)

    check("samples: 1 short-circuits to the single reading",
          confirm_samples([v], 3, {"samples": 1}), (True, None, v))
    check("max_last_digit_step: 0 demands identical readings",
          confirm_samples(ticked, 3, {"max_last_digit_step": 0})[0], False)
    check("  which five identical readings still satisfy",
          confirm_samples([v] * 5, 3, {"max_last_digit_step": 0})[0], True)

    # THE LIMIT OF THIS GUARD. Misplaced ROIs read the same wrong number off
    # every frame, so agreement is unanimous and meaningless. Nothing in this
    # function can see that; align_gate() is what stands against it.
    wrong = 61964.220          # the digits reversed, as a mirrored frame reads
    check("five agreeing samples of a WRONG number also pass",
          confirm_samples([wrong] * 5, 3, {}), (True, None, wrong))

    done()


def test_report_decimals():
    """Section 2e: what of the dial reaches Home Assistant.

    All eight drums are read. The fastest one is dropped from the VALUE,
    because a drum that turns once every 1.8 seconds with the boiler firing
    cannot be made to agree with itself across a ten-second burst -- see the
    boiler check below, which is the failure this section exists for.
    """
    from service.digits import confirm_samples, gate, reported_decimals, truncate

    section("2e. reported_decimals()/truncate(): what gets published")

    check("absent, the whole dial is published",
          reported_decimals({"decimals": 3}), 3)
    check("report_decimals trims it",
          reported_decimals({"decimals": 3, "report_decimals": 2}), 2)
    check("it cannot invent drums the meter does not have",
          reported_decimals({"decimals": 3, "report_decimals": 5}), 3)
    check("nor go below zero",
          reported_decimals({"decimals": 3, "report_decimals": -1}), 0)

    # Truncation, not rounding: .916 is 2246.91 burned so far, and 2246.92 is
    # gas that is still in the pipe.
    check("the dropped drum is cut, not rounded", truncate(2246.916, 3, 2), 2246.91)
    check("  even at .919", truncate(2246.919, 3, 2), 2246.91)
    check("  and the carry still lands", truncate(2246.920, 3, 2), 2246.92)
    check("whole cubic metres, if it ever came to that",
          truncate(2246.916, 3, 0), 2246.0)
    check("nothing to drop, nothing changed", truncate(2246.916, 3, 3), 2246.916)
    check("no value, nothing to do", truncate(None, 3, 2), None)

    # THE property, and the reason it is truncation. A dial that only rises
    # must never produce a value that falls: a decrease is what Home Assistant
    # takes for a meter reset, and retyping afterwards does not repair it.
    # Rounding fails this the moment a fast drum reads a shade low near a
    # boundary; truncation of a rising sequence cannot fall, full stop.
    dial = [round(2246.900 + n / 1000.0, 3) for n in range(200)]
    published = [truncate(v, 3, 2) for v in dial]
    check("a rising dial never publishes a fall",
          all(b >= a for a, b in zip(published, published[1:])), True)
    check("  and never runs ahead of the dial",
          all(0 <= d - p < 0.01 + 1e-9 for d, p in zip(dial, published)), True)

    # ------------------------------------------------------------------
    # The boiler. Firing at ~1.5 m3/h the 0.001 drum steps every 2.4 s, so a
    # five-frame burst spans several steps and can never agree with itself.
    # Published to 0.001 that refused every read while the gas was actually
    # being burned -- the meter went blind exactly when there was something to
    # see. Published to 0.01 the same burst is one tick, which is allowed.
    burst = [2246.916, 2246.918, 2246.920, 2246.922, 2246.924]
    check("at 0.001 a burst under load cannot agree",
          confirm_samples(burst, 3, {})[0], False)
    published = [truncate(v, 3, 2) for v in burst]
    check("  at 0.01 it is one tick and passes",
          confirm_samples(published, 2, {}), (True, None, 2246.92))

    # ------------------------------------------------------------------
    # read() truncates the PREVALUE too. Home Assistant's input_number holds
    # whatever a human last typed -- the whole dial -- and comparing that
    # against a trimmed reading manufactures a decrease out of nothing.
    cfg = {"max_delta": 0.6, "max_delta_window_s": 300,
           "tolerance_down": 0.0, "min_confidence": 0.5}
    ok = dict(digit_count=8, expected_digits=8, confidences=[0.9] * 8)

    accepted, reason = gate(truncate(2246.916, 3, 2), 2246.916, cfg, **ok)
    check("an untrimmed prevalue would read as a decrease", accepted, False)
    accepted, reason = gate(truncate(2246.916, 3, 2),
                            truncate(2246.916, 3, 2), cfg, **ok)
    check("  trimmed on both sides it is simply no change",
          (accepted, reason), (True, None))

    # ------------------------------------------------------------------
    # Why the trimming stops at 2 decimals and not at whole cubic metres. A
    # misread units drum is exactly +1 m3. At 0.01 the rate limit still sees it
    # against an allowance of 0.6 and refuses. Quantized to 1 m3, max_delta
    # would have to rise past 1.5 to let legitimate ticks through, and this
    # check would pass silently.
    accepted, reason = gate(2247.91, 2246.91, cfg, **ok)
    check("a misread units drum is still caught at 0.01", accepted, False)
    check("  by the rate limit", "rate" in (reason or ""), True)

    done()


def test_gate():
    section("3. gate(): the checks that cannot be undone afterwards")
    from service.digits import gate

    cfg = {"max_delta": 0.6, "max_delta_window_s": 300,
           "tolerance_down": 0.0, "min_confidence": 0.5}
    conf = [0.9] * 8
    ok = dict(digit_count=8, expected_digits=8, confidences=conf)

    accepted, reason = gate(4821.7, 4821.6, cfg, **ok)
    check("a normal step is accepted", (accepted, reason), (True, None))

    # Zero is not merely implausible. It is the exact input that sets a
    # total_increasing sensor's statistics zero point to 0, after which the
    # first real reading is booked as thousands of cubic metres of consumption.
    accepted, reason = gate(0.0, 4821.6, cfg, **ok)
    check("zero is refused", accepted, False)
    check("zero says why", "zero" in (reason or ""), True)

    accepted, reason = gate(4821.5, 4821.6, cfg, **ok)
    check("a decrease is refused", accepted, False)
    check("decrease says why", "decrease" in (reason or ""), True)

    accepted, reason = gate(4831.6, 4821.6, cfg, **ok)
    check("a 10 m3 jump is refused", accepted, False)
    check("jump says why", "rate" in (reason or ""), True)

    # A wake that was missed for an hour must not reject the gas that was
    # genuinely burned while nobody was looking.
    accepted, _ = gate(4823.0, 4821.6, cfg, elapsed_s=3600, **ok)
    check("the rate limit scales with the gap", accepted, True)

    short = dict(ok, digit_count=7)
    accepted, reason = gate(482.163, 4821.6, cfg, **short)
    check("a short read is refused", accepted, False)
    check("short read says why", "digit_count" in (reason or ""), True)

    low = dict(ok, confidences=[0.9, 0.2] + [0.9] * 6)
    accepted, reason = gate(4821.7, 4821.6, cfg, **low)
    check("a low-confidence drum is refused", accepted, False)

    # The last drum turns continuously and is mid-transition most of the time.
    # Holding it to the same bar rejects good frames all day long.
    tail = dict(ok, confidences=[0.9] * 7 + [0.1])
    accepted, reason = gate(4821.7, 4821.6, cfg, **tail)
    check("a low-confidence LAST drum is allowed", (accepted, reason), (True, None))

    # Without a prevalue there is no rate limit and no decrease check, so the
    # first reading after a restart would be the least guarded one of the day
    # -- and it is the one that sets the statistics baseline. Refuse it. The
    # cost is one wake; the alternative is permanent.
    accepted, reason = gate(4821.7, None, cfg, **ok)
    check("no prevalue is refused by default", accepted, False)
    check("  and says why", reason,
          "no prevalue: refusing an unguarded first reading")

    relaxed = dict(cfg, require_prevalue=False)
    accepted, reason = gate(4821.7, None, relaxed, **ok)
    check("unless require_prevalue is off", (accepted, reason), (True, None))

    # The other gates still run first: an unguarded reading of zero is refused
    # for being zero, not for lacking a prevalue.
    accepted, reason = gate(0.0, None, relaxed, **ok)
    check("zero is still refused with no prevalue", accepted, False)

    # THE LOCKOUT. The camera sleeps 1800 s and never sends elapsed_s, so
    # without the server working the gap out, a busy winter half hour (1.0 m3
    # at 2 m3/h) was over the flat 0.6 -- and the prevalue only moves on an
    # accept, so every read after it was refused against the same number.
    from service.digits import seconds_since
    now = 1_790_000_000.0
    record = {"value": 4821.6, "at_epoch": now - 1800}
    check("gap from the stored epoch", seconds_since(record, now), 1800.0)
    accepted, _ = gate(4822.6, 4821.6, cfg, **ok)
    check("without a gap, 1.0 m3 in half an hour is refused", accepted, False)
    accepted, _ = gate(4822.6, 4821.6, cfg,
                       elapsed_s=seconds_since(record, now), **ok)
    check("with the gap it is accepted", accepted, True)
    # ...and a refusal does not strand the next read: the gap keeps growing
    # from the last ACCEPT, so the allowance grows with it.
    accepted, _ = gate(4823.8, 4821.6, cfg,
                       elapsed_s=seconds_since(record, now + 1800), **ok)
    check("an hour after the last accept, 2.2 m3 is accepted", accepted, True)
    check("records from before at_epoch still parse",
          seconds_since({"at": "2026-09-30T10:00:00+0300"},
                        1790751600.0 + 600), 600.0)
    check("nothing stored -> no gap", seconds_since(None, now), None)
    check("garbage -> no gap", seconds_since({"at": "yesterday"}, now), None)
    check("a clock that went backwards -> no gap",
          seconds_since({"at_epoch": now + 60}, now), None)

    done()


def test_jump_counter():
    section("2b. assemble(counter_type='jump'): the Itron Gallus 2000")
    from service.digits import assemble

    # The exact floats dig-class100 returned from a sharp frame of the real
    # meter, whose dial read 02246.916 at the time. This is a regression test
    # against a bug that shipped: the continuous carry rule was applied to a
    # jump counter and turned four correctly-read drums into wrong ones, at
    # 100% model confidence.
    measured = [0.3, 2.2, 2.1, 4.0, 5.9, 8.8, 0.8, 5.7]

    value, digits, raw = assemble(measured, decimals=3, counter_type="jump")
    check("reads the dial exactly", raw, "02246916")
    check("and as a number", value, 2246.916)
    check("digits", digits, [0, 2, 2, 4, 6, 9, 1, 6])

    # What the wrong setting did to the very same input. Note the units drum:
    # the model returned a perfect 4.0 and the carry rule made it a 3, because
    # the drum to its right had already been dragged down to 5.
    _, wrong_digits, wrong = assemble(measured, decimals=3,
                                      counter_type="continuous")
    check("continuous mangles a jump counter", wrong, "02235905")
    check("including a drum the model read perfectly",
          (measured[3], wrong_digits[3], digits[3]), (4.0, 3, 4))

    # Rounding is what absorbs the model's small negative bias -- a digit sits
    # slightly low in its box and the network reads height as phase. Truncating
    # would keep every one of those errors.
    truncated = "".join(str(int(v)) for v in measured)
    check("truncating would not have worked", truncated, "02245805")

    check("9.6 rounds up and wraps to 0",
          assemble([9.6], decimals=0, counter_type="jump")[1], [0])

    try:
        assemble([1.0], decimals=0, counter_type="sideways")
        check("an unknown counter_type is rejected", "accepted", "ValueError")
    except ValueError:
        check("an unknown counter_type is rejected", True, True)

    done()


def test_transform():
    section("4. transform(): un-mirroring and rotating a frame")
    try:
        import cv2
        import numpy as np
    except ImportError:
        print("  SKIPPED - needs cv2 and numpy (run it in the container)")
        return

    from service.digits import assemble
    from service.reader import transform

    strip = np.full((40, 80, 3), 235, np.uint8)
    strip[10:30, 0:10] = 0          # an asymmetric mark, at the left
    mirrored = cv2.flip(strip, 1)

    check("mirroring is undone exactly",
          bool(np.array_equal(strip, transform(mirrored, {"flip": "horizontal"}))),
          True)
    check("no transform is a no-op",
          bool(np.array_equal(strip, transform(strip, None))), True)
    check("rotate 90 swaps the axes",
          transform(strip, {"rotate": 90}).shape[:2], strip.shape[:2][::-1])
    check("rotate 360 is a no-op",
          bool(np.array_equal(strip, transform(strip, {"rotate": 360}))), True)

    # Refuse a value rather than silently ignoring it. A typo in `flip` that
    # quietly did nothing would leave a mirrored frame being read as though it
    # were correct, which is the failure below.
    for bad in ({"flip": "sideways"}, {"rotate": 45}):
        try:
            transform(strip, bad)
            check("%r is rejected" % bad, "accepted", "ValueError")
        except ValueError:
            check("%r is rejected" % bad, True, True)

    # Why any of this matters: a mirror does not merely flip the glyphs, it
    # reverses the ORDER of the drums. Reading a mirrored frame does not give a
    # slightly wrong number, it gives a different one entirely -- and on a cold
    # start with no prevalue there is nothing to catch it.
    forward = [0.4821637, 4.821637, 8.21637, 2.1637, 1.637, 6.37, 3.7, 7.0]
    value, _, raw = assemble(forward, decimals=3)
    _, _, backwards = assemble(list(reversed(forward)), decimals=3)
    check("drum order reverses under a mirror", raw, "04821637")
    check("and the reversed read differs", backwards != raw, True)

    done()


def test_adversarial():
    """Section 6: trash must never be accepted, whatever the model says.

    The model has no "not a digit" class. dig-class100 emits 100 class
    probabilities and argmax always returns one, so a photograph of a blank
    wall produces a number -- and not always a hesitant one. Measured
    2026-09-05, with alignment disabled so the value guards are on their own:

        white   -> 11111111 at 0.38
        black   -> 11111111 at 0.78
        grey    -> 00000000 at 0.99
        noise   -> 46243242 at 0.07

    A blank grey wall reading zero at 99% confidence is the number to keep in
    mind whenever someone proposes trusting `min_confidence` alone. What
    actually refused these was the zero rule and the rate limit -- plausibility
    against a previous reading, neither of which asks the model's opinion.

    This section asserts the outcome, not the mechanism: any of the guards may
    do the catching, but nothing here may ever come back accepted.
    """
    section("5. adversarial frames: trash is never accepted")

    try:
        import cv2
        import numpy as np
    except ImportError as exc:
        raise ImportError("needs cv2 and numpy (run it in the container)") from exc

    import glob as _glob
    from service import reader

    here = pathlib.Path(__file__).resolve().parent.parent
    models = sorted(_glob.glob(str(here / "models" / "*.tflite"))) \
        or sorted(_glob.glob("/models/*.tflite"))
    if not models:
        print("  SKIPPED - no .tflite weights (sh models/fetch.sh)")
        return

    h, w = 480, 640
    rng = np.random.default_rng(0)
    frames = {
        "white": np.full((h, w, 3), 255, np.uint8),
        "black": np.zeros((h, w, 3), np.uint8),
        "grey": np.full((h, w, 3), 128, np.uint8),
        "noise": rng.integers(0, 256, (h, w, 3), dtype=np.uint8),
    }

    # Eight boxes across the middle, as if a dial were there. Alignment is off:
    # this section is about what the VALUE guards do once a number exists, and
    # with it on nothing would reach them.
    rois = [{"x": 40 + i * 70, "y": 200, "w": 60, "h": 80} for i in range(8)]
    meter = {
        "align": {"enabled": False},
        "confirm": {"samples": 1},
        "model": models[0],
        "decimals": 3,
        "counter_type": "jump",
        "rois": rois,
        "gate": {"max_delta": 0.6, "max_delta_window_s": 300,
                 "tolerance_down": 0.0, "min_confidence": 0.5},
    }

    cache = reader.ModelCache()
    for name, frame in frames.items():
        blob = cv2.imencode(".jpg", frame)[1].tobytes()
        out = reader.read(meter, cache, [blob],
                          prevalue=2246.916, elapsed_s=300)
        check("%s is refused" % name, out.get("accepted"), False)
        check("  %s says why" % name, out.get("reason") is not None, True)

        # And with nothing to compare against -- the restart case, where the
        # rate limit and decrease check are both absent -- it must still refuse.
        bare = reader.read(meter, cache, [blob], prevalue=None)
        check("  %s refused with no prevalue too" % name,
              bare.get("accepted"), False)

    done()


def test_publishing():
    """Section 7: report_decimals through the real pipeline, not the arithmetic.

    Section 2e proves the trimming; this proves it is actually wired into
    read(). Every check here is STRUCTURAL -- the published value is the dial
    with its fast drums cut off, and the prevalue was trimmed the same way
    before anything compared it -- so it holds whatever the model happens to
    read off a synthetic frame, and needs no true reading.

    The frame is refused, as trash should be. That is not what is under test:
    a refused read still carries `value`, `dial` and `prevalue`, which is the
    whole reason those are populated on the way out.
    """
    section("6. report_decimals: what read() actually publishes")

    try:
        import cv2
        import numpy as np
    except ImportError as exc:
        raise ImportError("needs cv2 and numpy (run it in the container)") from exc

    import glob as _glob
    from service import reader
    from service.digits import truncate

    here = pathlib.Path(__file__).resolve().parent.parent
    models = sorted(_glob.glob(str(here / "models" / "*.tflite")))         or sorted(_glob.glob("/models/*.tflite"))
    if not models:
        print("  SKIPPED - no .tflite weights (sh models/fetch.sh)")
        return

    rng = np.random.default_rng(0)
    frame = rng.integers(0, 256, (480, 640, 3), dtype=np.uint8)
    blob = cv2.imencode(".jpg", frame)[1].tobytes()

    meter = {
        "align": {"enabled": False},
        "confirm": {"samples": 1},
        "model": models[0],
        "decimals": 3,
        "report_decimals": 2,
        "counter_type": "jump",
        "rois": [{"x": 40 + i * 70, "y": 200, "w": 60, "h": 80} for i in range(8)],
        "gate": {"max_delta": 0.6, "max_delta_window_s": 300,
                 "tolerance_down": 0.0, "min_confidence": 0.5},
    }

    out = reader.read(meter, reader.ModelCache(), [blob],
                      prevalue=2246.916, elapsed_s=300)

    dial, value = out.get("dial"), out.get("value")
    check("the whole dial is still read", dial is not None, True)
    check("the published value is the dial, trimmed",
          value, truncate(dial, 3, 2))
    check("  and lands on a whole 0.01",
          value is not None and abs(value * 100 - round(value * 100)) < 1e-9, True)
    check("  while the dial keeps all three decimals",
          round(dial, 3), dial)

    # The prevalue a human typed is trimmed before any comparison, so 2246.916
    # against a 2246.91 reading is not a decrease invented by arithmetic.
    check("the prevalue is trimmed to match", out.get("prevalue"), 2246.91)

    # Unset, the whole dial is published -- a config written before
    # report_decimals existed behaves exactly as it did.
    plain = dict(meter)
    del plain["report_decimals"]
    was = reader.read(plain, reader.ModelCache(), [blob],
                      prevalue=2246.916, elapsed_s=300)
    check("without report_decimals the dial is published whole",
          was.get("value"), was.get("dial"))
    check("  and the prevalue is left alone", was.get("prevalue"), 2246.916)

    done()


def test_seven_drums():
    """Section 2f: the mounted camera sees seven drums, not eight.

    The ESP32-CAM on its bracket frames 0 2 2 6 1 | 4 2 -- the 0.001 drum is
    out of shot. That drum was never published (report_decimals: 2), so the
    meter is configured as what the camera sees: seven drums, two decimals.
    Two things change and both are checked here: nothing is truncated any
    more, and the LAST drum is now a published one.
    """
    from service.digits import assemble, gate, reported_decimals, truncate

    section("2f. seven drums: decimals 2, the 0.001 drum out of frame")

    meter = {"decimals": 2, "report_decimals": 2}
    check("reports what it reads", reported_decimals(meter), 2)

    # As dig-class100 would return them off the frame taken 2026-09-27.
    value, digits, raw = assemble([0.1, 2.0, 1.9, 6.1, 0.8, 4.2, 1.7],
                                  decimals=2, counter_type="jump")
    check("assembles to the dial", (value, raw), (2261.42, "0226142"))

    # round_last_drum_down. The overnight frames of 2026-09-28: last drum
    # mid-roll at 1.6, dial labelled .41, rounding published .42.
    mid = [0.1, 2.0, 2.0, 6.1, 1.0, 4.0, 1.6]
    check("mid-roll rounds to the arriving digit",
          assemble(mid, 2, "jump")[0], 2261.42)
    check("  and down to the leaving one with last_down",
          assemble(mid, 2, "jump", last_down=True)[0], 2261.41)
    check("  a clean digit is untouched",
          assemble(mid[:-1] + [7.1], 2, "jump", last_down=True)[0], 2261.47)
    check("  nor one read a little low",
          assemble(mid[:-1] + [6.8], 2, "jump", last_down=True)[0], 2261.47)
    check("  only the last drum: a low 5.8 upstream still rounds",
          assemble(mid[:-2] + [5.8, 1.6], 2, "jump", last_down=True)[0], 2261.61)
    # 9 -> 0: the neighbour has already snapped to 5, so a floored 9 would say
    # .59 for a dial at .50. It must round, as it did before.
    check("  and 9 -> 0 still rounds (no .59 for a dial at .50)",
          assemble(mid[:-2] + [5.0, 9.6], 2, "jump", last_down=True)[0], 2261.50)
    check("  a centred 9 stays 9",
          assemble(mid[:-2] + [4.0, 9.0], 2, "jump", last_down=True)[0], 2261.49)
    check("truncate is a no-op when nothing is dropped",
          truncate(value, 2, 2), 2261.42)
    check("  and does not mangle a value that is not a clean float",
          truncate(2261.4200000001, 2, 2), 2261.4200000001)

    # THE trap. gate() exempts the last drum from min_confidence by position.
    # On eight drums that was the unpublished 0.001 drum; on seven it is the
    # 0.01 drum, which IS published. So the published drum must have a floor
    # of its own -- min_confidence_last_digit -- or a 0.05-confidence guess
    # at it would sail through.
    cfg = {"max_delta": 0.6, "max_delta_window_s": 300, "tolerance_down": 0.0,
           "min_confidence": 0.5, "require_prevalue": True}
    shaky = [0.9] * 6 + [0.05]
    check("without a last-digit floor a 5% last drum is accepted",
          gate(2261.42, 2261.40, cfg, 7, 7, shaky)[0], True)
    floored = dict(cfg, min_confidence_last_digit=0.3)
    accepted, reason = gate(2261.42, 2261.40, floored, 7, 7, shaky)
    check("  with one it is refused", accepted, False)
    check("  for the last drum", "last drum" in (reason or ""), True)
    check("wrong drum count is still refused",
          gate(2261.42, 2261.40, floored, 8, 7, [0.9] * 8)[0], False)

    done()


def test_single_push():
    """A single pushed frame must not skip confirm.samples.

    The camera sends one frame when a grab or an allocation fails, and anyone
    on the LAN can POST one. read() used to mark it `unconfirmed` and pass it
    to the gate, while three frames against samples: 5 were refused. The image
    work is stubbed: this is about the control flow, not the vision.
    """
    section("7. read(): one pushed frame against confirm.samples")
    from service import reader

    real = reader.read_once

    def fake(meter, models, image_bytes, prevalue=None):
        return {"value": 4821.7, "digits": [4, 8, 2, 1, 7, 0, 0, 0],
                "reason": None, "_confidences": [0.9] * 8, "_frame": None}

    reader.read_once = fake
    try:
        meter = {"decimals": 1, "rois": [{}] * 8, "confirm": {"samples": 2},
                 "gate": {"max_delta": 0.6, "min_confidence": 0.5}}
        one = reader.read(meter, None, [b"x"], prevalue=4821.6)
        check("one frame against samples: 2 is refused", one["accepted"], False)
        check("  saying why", (one["reason"] or "").split(":")[0], "unconfirmed")
        two = reader.read(meter, None, [b"x", b"y"], prevalue=4821.6)
        check("two agreeing frames are accepted", two["accepted"], True)
        allowed = dict(meter, confirm={"samples": 2, "allow_unconfirmed_push": True})
        check("allow_unconfirmed_push accepts the single frame",
              reader.read(allowed, None, [b"x"],
                          prevalue=4821.6)["accepted"], True)
        single = dict(meter, confirm={"samples": 1})
        check("samples: 1 never asked for more",
              reader.read(single, None, [b"x"],
                          prevalue=4821.6)["accepted"], True)
    finally:
        reader.read_once = real
    done()


# ---------------------------------------------------------------------------

def main():
    test_resolve()
    test_assemble()
    test_jump_counter()
    test_align_gate()
    test_confirm_samples()
    test_report_decimals()
    test_seven_drums()
    test_gate()
    test_transform()
    try:
        test_adversarial()
    except ImportError as exc:
        print("  SKIPPED - %s" % exc)
    try:
        test_publishing()
    except ImportError as exc:
        print("  SKIPPED - %s" % exc)
    # Control flow, not vision -- but reader.py imports cv2 at module scope, so
    # it skips here and runs in the container with everything else that does.
    try:
        test_single_push()
    except ImportError as exc:
        print("  SKIPPED - %s" % exc)
    # app.py pulls in Flask, which lives in the image rather than on a
    # workstation, so this joins the tier that skips here.
    try:
        test_home_assistant()
    except ImportError as exc:
        print("  SKIPPED - %s" % exc)

    print("\n" + "=" * 60)
    if FAILURES:
        for f in FAILURES:
            print("FAIL %s" % f)
        print("\n%d of %d checks failed" % (len(FAILURES), CHECKS[0]))
        return 1
    print("%d checks passed" % CHECKS[0])
    return 0


if __name__ == "__main__":
    sys.exit(main())
