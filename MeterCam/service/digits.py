"""
Drums into a number, and the decision about whether to believe it.

Stdlib only, on purpose. Everything here is arithmetic over floats the model
already produced, so it imports without numpy, without OpenCV and without a
TFLite runtime -- which means `python tests/test_reader.py` runs on a bare
workstation and in CI, not only inside the container.

That split is not tidiness. The two functions below are the ones whose failure
mode is irreversible (see `gate`), so they are the ones that most need a test
that nobody has an excuse to skip.

---------------------------------------------------------------------------
The carry rule

Meter drums are geared continuously: the tens drum advances a tenth of a turn
for every full turn of the units drum. So when the units drum reads 9.5, the
tens drum is already 95% of the way to its next digit and LOOKS like that next
digit. Truncate and you are wrong for half a rotation; round and you are wrong
for the other half.

The drum to the right settles it:

    right drum >= 5  ->  this drum should be in the UPPER part of its digit.
                         A low fraction means the model crossed the boundary
                         early; step back one.
    right drum <  5  ->  this drum should have COMPLETED its transition.
                         A high fraction means the model has not caught up;
                         step forward one.

Worked, on the two real misreads it exists to fix:

    true 4821.999, units drum inferred 2.01 instead of 1.999
        right drum reads 9, so >= 5; frac 0.01 < 0.5 -> step back -> 1
        4821.999, not 4822.999

    true 4822.001, units drum inferred 1.98 instead of 2.0001
        right drum reads 0, so < 5; frac 0.98 > 0.5 -> step on -> 2
        4822.001, not 4821.001

Note what the second one would have been: a DECREASE. Not a wrong digit -- a
number lower than the last good reading, from a meter that only counts up.
"""

from __future__ import annotations


def resolve(this_raw, right_digit):
    """Decide one drum's digit, given the already-decided drum to its right.

    `this_raw` is the model's continuous reading in [0,10). `right_digit` is an
    int 0-9. Returns an int 0-9.
    """
    this_int = int(this_raw)
    frac = this_raw - this_int
    if right_digit >= 5:
        if frac < 0.5:
            this_int -= 1
    else:
        if frac > 0.5:
            this_int += 1
    return this_int % 10


def _last_down(raw):
    """The last drum of a jump counter, rounded DOWN rather than to nearest.

    A drum caught mid-roll is labelled as the digit that is leaving, the lower
    one: that is the gas already burned. Rounding publishes the arriving digit
    from half-way through, 0.01 m3 early. On 2026-09-28 the drum sat at 1.6
    for two hours overnight and every one of those reads came out .42 against
    a dial showing .41.

    Not a plain floor. The model reads a centred digit a little low when the
    frame is off level (0.2-0.4 on the first real frame, see deskew in
    config.example.json), and floor(6.8) would turn a clean 7 into a 6. So a
    digit counts as arrived from 0.7 of the way through: LAST_DOWN_MARGIN.

    And never across 9 -> 0. On a jump counter the drum to the left snaps
    during exactly that roll, and it is rounded; flooring this one back to 9
    while it already shows its next digit would publish .59 for a dial at .50
    -- a reading too high by 0.09, and the next correct one a DECREASE. There
    it rounds as before.
    """
    down = int(raw + LAST_DOWN_MARGIN) % 10
    nearest = int(round(raw)) % 10
    if down == 9 and nearest == 0:
        return nearest
    return down


LAST_DOWN_MARGIN = 0.3


def assemble(values, decimals, counter_type="continuous", last_down=False):
    """Turn per-drum readings into a number.

    `values` runs most-significant first. Returns (value, digits, raw_string).
    `last_down` rounds a jump counter's last drum down instead -- `_last_down`
    has why and where it must not.

    `counter_type` says how the drums are geared, and it is not a detail --
    getting it wrong corrupts digits that the model read correctly.

    ------------------------------------------------------------------
    "jump" -- an intermittent or Geneva-style counter. THIS METER.

    Each whole-number drum stays put until the drum to its right completes a
    revolution, then snaps forward. So every drum shows a digit squarely in its
    window and there is no fraction to interpret: round to the nearest, drum by
    drum, and never let a neighbour vote.

    You can read the gearing straight off a photograph. This meter stood at
    02246.916 -- the decimals were 91.6% of the way through -- and yet the units
    drum showed a clean, centred 6. On a continuously geared counter that drum
    would have been at 6.916, showing mostly the 7 coming up behind it. It was
    not, so the counter jumps.

    ------------------------------------------------------------------
    "continuous" -- every drum geared to its neighbour.

    Common on water meters. The tens drum advances a tenth of a turn for each
    full turn of the units drum, so at 9.5 on the units the tens drum is already
    95% of the way to its next digit and LOOKS like that digit. Truncating is
    wrong for half a rotation, rounding for the other half, and `resolve()`
    settles it against the drum to the right.

    ------------------------------------------------------------------
    Why the distinction earned its own parameter, the hard way

    Applied to a jump counter, the continuous carry rule reads a correctly
    identified digit and moves it DOWN. On the first sharp frame off this meter
    the model returned 0.3 2.2 2.1 4.0 5.9 8.8 0.8 5.7, which rounds to exactly
    02246916 -- the true reading. The carry rule turned that into 02235905, four
    digits wrong, at 100% model confidence. It even took the units drum's
    perfect 4.0 and made it a 3, because the drum to its right had already been
    pulled down to 5.

    A wrong reading from a confident model is the worst failure this code has,
    and it was arithmetic, not vision.
    """
    if not values:
        raise ValueError("no drums")
    if any(v is None for v in values):
        raise ValueError("unreadable drum at position %d" % values.index(None))

    n = len(values)

    if counter_type == "jump":
        # Round, independently, and stop there. The small negative bias the
        # models show on this meter (a digit sits a little low in its box, and
        # the network reads height as phase) is absorbed by rounding, which is
        # the other reason not to truncate.
        digits = [int(round(float(v))) % 10 for v in values]
        if last_down:
            digits[-1] = _last_down(float(values[-1]))
        value = sum(digits[i] * (10.0 ** (n - 1 - decimals - i))
                    for i in range(n))
        return round(value, decimals), digits, "".join(str(d) for d in digits)

    if counter_type != "continuous":
        raise ValueError("counter_type %r: expected 'jump' or 'continuous'"
                         % counter_type)

    digits = [0] * n
    last = float(values[-1])
    digits[-1] = int(last) % 10

    right = digits[-1]
    for i in range(n - 2, -1, -1):
        digits[i] = resolve(float(values[i]), right)
        right = digits[i]

    # The rightmost drum keeps its fraction: it is the one drum with no
    # neighbour to correct it, and on a continuous counter that fraction is
    # real sub-digit resolution.
    value = 0.0
    for i in range(n - 1):
        value += digits[i] * (10.0 ** (n - 1 - decimals - i))
    value += last * (10.0 ** (-decimals))

    return round(value, decimals + 1), digits, "".join(str(d) for d in digits)


def reported_decimals(meter):
    """How much of the dial reaches Home Assistant. Defaults to all of it.

    `decimals` is a FACT about the meter -- how many drums sit right of the
    comma. `report_decimals` is a CHOICE about what to publish, and the two are
    separate because the drums we stop publishing are still worth reading: on a
    continuously geared decimal train, the drum to the right is the only thing
    that says whether its neighbour is arriving or departing.

    Absent, it reports the whole dial, so a config written before this existed
    behaves exactly as it did.
    """
    decimals = int(meter.get("decimals", 0) or 0)
    report = meter.get("report_decimals")
    if report is None:
        return decimals
    return max(0, min(int(report), decimals))


def truncate(value, decimals, report):
    """Drop the drums right of `report` -- what a human copying the dial writes.

    TRUNCATION, NOT ROUNDING, and the difference is load-bearing twice.

    Rounding 2246.916 to 2246.92 reports gas that has not been burned yet, and
    on a total_increasing sensor every reading is a claim about a total. Worse,
    rounding is not monotone in the way this needs: a dial creeping through
    .915 -> .916 can round to .92 and then, on a frame where the fast drum
    reads a shade low, back to .91 -- a DECREASE manufactured by arithmetic out
    of a meter that only counted up. Truncation of a rising sequence cannot
    fall, so the guard in `gate` never fires on our own rounding.

    The cost is a bounded, non-accumulating offset: the published total is
    always within one step of the dial, forever, because each reading is an
    absolute total and not a sum of deltas. At 0.01 m3 that is under 0.1 kWh.

    Integer arithmetic in the dial's own units throughout -- 2246.916 is 2246916
    thousandths -- so no float ever decides where the comma falls.
    """
    if value is None or report >= decimals:
        return value
    counts = int(round(float(value) * (10 ** decimals)))
    per_step = 10 ** (decimals - report)
    return (counts // per_step) / float(10 ** report)


def align_gate(info, cfg):
    """Return (ok, reason) for one alignment result. `reason` is None when ok.

    ORB reports how well a frame matched the reference; nothing used to read
    that report. `align()` refused only when it could not produce a transform
    at all, which is a much lower bar than producing a *trustworthy* one.

    The frame that motivated this returned ok=True on 21 inliers out of 147
    matches with dx=-808.3 -- an 800-pixel offset on a 2592-pixel frame,
    declared good. Every later guard passed it: the digits were confident and
    the assembled number was plausible, because the ROIs had simply landed on
    a different part of a real photograph of a real meter.

    That is the failure mode worth naming. A blurred or blank frame is caught
    everywhere -- by confidence, by the zero rule, by the rate limit. A frame
    that is sharp, correctly exposed and aligned to the WRONG PLACE produces a
    stable, confident, wrong reading, and repeating the measurement only
    reproduces it. Alignment quality is the only signal that sees it, which is
    why this function exists and why it runs before anything reads a drum.

    What the numbers mean:

      min_inlier_ratio -- the primary signal. A genuine match on this meter
        runs about 1000 inliers; the bad frame ran 21 of 147, a 14% ratio.
        Real matches agree in bulk, bogus ones agree by accident.

      min_inliers -- a floor for the ratio to be meaningful at all. Two
        inliers out of two is a ratio of 1.0 and means nothing.

      max_shift_px -- deliberately generous, because correcting drift is the
        whole POINT of alignment and a tight bound would defeat it. This is
        not here to police movement; it is here to catch a match so wrong that
        no camera on a bracket could have produced it. 300 px is 12% of the
        frame width.

      max_rotation_deg -- likewise. A bracket sags; it does not spin.

    Absent config keys take the defaults below rather than being skipped. A
    guard that silently does nothing when it is not configured is worse than
    no guard, because it reads like protection.
    """
    if not info:
        return False, "no alignment result"

    # A reference adopted from this very frame is an identity transform, and
    # was never warped -- there is nothing to score and nothing to distrust.
    if info.get("adopted"):
        return True, None

    if not info.get("ok"):
        return False, info.get("reason") or "alignment failed"

    inliers = info.get("inliers")
    matches = info.get("matches")

    min_inliers = cfg.get("min_inliers", 60)
    if min_inliers is not None:
        if inliers is None:
            return False, "no inlier count"
        if inliers < min_inliers:
            return False, "inliers: %d, below %d" % (inliers, min_inliers)

    min_ratio = cfg.get("min_inlier_ratio", 0.35)
    if min_ratio is not None and matches:
        ratio = float(inliers or 0) / float(matches)
        if ratio < min_ratio:
            return False, "inlier ratio: %d/%d = %.2f, below %.2f" % (
                inliers or 0, matches, ratio, min_ratio)

    max_shift = cfg.get("max_shift_px", 300)
    if max_shift is not None:
        for axis in ("dx", "dy"):
            shift = info.get(axis)
            if shift is not None and abs(shift) > max_shift:
                return False, "%s: %.1f px, beyond %s" % (axis, shift, max_shift)

    max_rot = cfg.get("max_rotation_deg", 10)
    if max_rot is not None:
        rot = info.get("rotation_deg")
        if rot is not None and abs(rot) > max_rot:
            return False, "rotation: %.2f deg, beyond %s" % (rot, max_rot)

    return True, None


def confirm_samples(values, decimals, cfg):
    """Do several readings of the same dial agree? Returns (ok, reason, value).

    One frame can be wrong for reasons that leave no trace in the number: a
    flicker, a drum caught mid-tick, sensor noise on a dark frame. Reading the
    dial several times in a few seconds and demanding agreement removes that
    entire class, because those causes do not repeat identically.

    WHAT THIS DOES NOT DO, and it matters more than what it does: repeated
    sampling catches RANDOM error and is blind to SYSTEMATIC error. If the ROIs
    sit over the wrong drums, every sample agrees perfectly on the same wrong
    number, at high confidence. Five green ticks are not verification. That
    case belongs to align_gate().

    Comparison is on values rather than digit lists, which handles a carry for
    free: 2246.919 -> 2246.920 is one legitimate tick of the last drum, and
    comparing digit-by-digit would call it four changed digits.

    Values are compared as integer counts of the last PUBLISHED drum's step, so
    no float ever decides anything. `decimals` here is `reported_decimals()`,
    not the dial's own: the drums that no longer reach the value cannot make
    two samples disagree, which is most of the point of dropping them.

    The last published drum can legitimately advance during a burst, and
    `max_last_digit_step` allows that and nothing else. It cannot go backwards:
    the meter only counts up, so a sample lower than the one before it is a
    misread however small.

    THAT BUDGET IS A FLOW CEILING, which is the thing to understand here. A
    burst is five frames at about 1.84 s each plus the gaps -- call it ten
    seconds -- so one step per burst permits one step per ten seconds and no
    more. Published to the dial's full 0.001 m3 that ceiling was 0.36 m3/h,
    barely above the pilot flame: every read taken while the boiler was firing
    disagreed with itself and was refused, and the meter went blind exactly
    when there was something to see. Nothing was lost permanently -- it is a
    totalizer and it catches up -- but the gas landed in the wrong hour.

    At the published 0.01 m3 the same budget permits 3.6 m3/h, above anything
    this house burns and below the meter's Qmax of 6. If a read is ever refused
    for spread while the boiler is on, that ceiling is what was hit: raise
    `max_last_digit_step` to 2 rather than reaching for the model.

    Set `max_last_digit_step: 0` to demand identical readings. That refuses a
    real tick perhaps one burst in twenty, which costs one 30-minute wake and
    is a defensible trade if you would rather be certain.
    """
    required = cfg.get("samples", 5)

    if not values:
        return False, "confirm: no samples", None

    if required is None or required <= 1:
        return True, None, values[-1]

    if len(values) < required:
        return False, "confirm: %d samples, need %d" % (len(values), required), None

    if any(v is None for v in values):
        return False, "confirm: a sample produced no value", None

    # Integer counts of the least significant drum. decimals=3 makes the unit
    # 0.001, so 2246.916 becomes 2246916 and comparisons are exact.
    unit = 10.0 ** -decimals
    counts = [int(round(float(v) / unit)) for v in values]

    for i in range(1, len(counts)):
        if counts[i] < counts[i - 1]:
            return False, "confirm: sample %d fell to %s from %s" % (
                i + 1, values[i], values[i - 1]), None

    max_step = cfg.get("max_last_digit_step", 1)
    spread = max(counts) - min(counts)
    if spread > max_step:
        return False, "confirm: samples span %s steps (%s to %s), beyond %s" % (
            spread, min(values), max(values), max_step), None

    # The most recent sample: the burst takes seconds, and the freshest
    # reading is the one closest to true at the moment it is written.
    return True, None, values[-1]


def gate(value, prevalue, cfg, digit_count, expected_digits, confidences,
         elapsed_s=None):
    """Return (accepted, reason). `reason` is None only when accepted.

    The last thing standing between a misread and a permanently wrong
    statistics series. `HomeAssistant/config/packages/gas_meter.yaml` sets out
    both traps in full:

      * a first observed value of 0 sets a total_increasing sensor's statistics
        zero point to 0, and the next real reading is then booked as thousands
        of cubic metres of consumption, permanently;

      * a downward correction of more than 10% is taken as a meter reset, and
        is NOT undone by correcting the value afterwards -- the repair is
        Developer tools -> Statistics -> Adjust sum, by hand.

    So the bias is to refuse. A rejected frame costs one 30-minute wake; an
    accepted wrong one costs a manual `recorder/clear_statistics`.
    """
    if digit_count != expected_digits:
        return False, "digit_count: read %d drums, expected %d" % (
            digit_count, expected_digits)

    if value is None:
        return False, "no value"

    if value <= 0:
        return False, "zero: a reading of 0 would reset the statistics baseline"

    min_conf = cfg.get("min_confidence")
    if min_conf is not None:
        # The last drum turns while it is photographed and is mid-transition
        # much of the time, so it is held to its own bar,
        # min_confidence_last_digit, rather than this one.
        #
        # The slice is POSITIONAL. On an 8-drum dial with report_decimals 2
        # the exempt drum was the unpublished 0.001 one, so leaving its floor
        # at null cost nothing. The mounted camera reads 7 drums, which makes
        # the exempt drum the published 0.01 one -- so on that config the
        # last-digit floor must be set, or a published digit goes unpoliced.
        # tests/test_reader.py section 2f pins exactly that.
        head = [c for c in confidences[:-1] if c is not None]
        if head:
            worst_i = min(range(len(head)), key=lambda i: head[i])
            if head[worst_i] < min_conf:
                return False, "confidence: drum %d at %.2f, below %.2f" % (
                    worst_i, head[worst_i], min_conf)
        tail_min = cfg.get("min_confidence_last_digit")
        if tail_min is not None and confidences and confidences[-1] is not None:
            if confidences[-1] < tail_min:
                return False, "confidence: last drum at %.2f, below %.2f" % (
                    confidences[-1], tail_min)

    if prevalue is None:
        # No previous reading means no rate limit and no decrease check -- the
        # two guards that actually catch a misread, since neither asks the
        # model's opinion and a confident model will not catch itself. The
        # adversarial frames measured on 2026-09-05 bear that out: a blank grey
        # wall reads as 0 at 0.992 confidence, black reads 11111111 at 0.775,
        # and what refused them was the zero rule and the rate limit, not
        # confidence.
        #
        # Accepting here would make the LEAST guarded reading of the day the
        # first one after a Home Assistant restart -- precisely the moment a
        # wrong value sets a total_increasing sensor's statistics baseline,
        # permanently, and retyping does not undo it.
        #
        # The cost is one refused wake. input_number restores its last value,
        # and app.py falls back to the last accepted reading, so prevalue is
        # populated on every wake after that.
        if cfg.get("require_prevalue", True):
            return False, "no prevalue: refusing an unguarded first reading"
        return True, None

    if value < prevalue:
        drop = prevalue - value
        if drop <= cfg.get("tolerance_down", 0.0):
            return True, None
        return False, "decrease: %.3f below prevalue %.3f" % (drop, prevalue)

    delta = value - prevalue
    max_delta = cfg.get("max_delta")
    if max_delta is not None:
        window = cfg.get("max_delta_window_s")
        allowed = max_delta
        if window and elapsed_s:
            # Scale to the real gap, so a wake missed for an hour is not
            # rejected for the gas that was legitimately burned meanwhile.
            allowed = max_delta * max(1.0, elapsed_s / float(window))
        if delta > allowed:
            return False, "rate: +%.3f exceeds %.3f" % (delta, allowed)

    return True, None


def seconds_since(record, now):
    """Seconds between a stored `last_accepted.json` record and `now` (epoch).

    The rate limit in gate() scales max_delta by the time since the prevalue
    was last TRUE, and that is the last accepted read -- not the last change:
    an idle meter re-confirms the same number every wake. A camera on its own
    clock never sends that gap, and without it gate() allowed a flat max_delta per read however long the camera
    had slept. One busy winter half hour then became a refusal, and since the
    prevalue only moves on an accept, every read after it was compared with the
    same stale number and refused too: a lockout with no way out.

    Accepts the `at_epoch` this service writes now and the older `at` text
    ("%Y-%m-%dT%H:%M:%S%z"). None when there is nothing usable, which leaves
    gate() on its old flat allowance rather than inventing a gap.
    """
    if not isinstance(record, dict):
        return None
    at = record.get("at_epoch")
    if not isinstance(at, (int, float)):
        text = record.get("at")
        if not text:
            return None
        from datetime import datetime
        try:
            at = datetime.strptime(str(text), "%Y-%m-%dT%H:%M:%S%z").timestamp()
        except ValueError:
            return None
    gap = now - float(at)
    # A clock that stepped backwards is not a reason to widen the gate.
    return gap if gap > 0 else None
