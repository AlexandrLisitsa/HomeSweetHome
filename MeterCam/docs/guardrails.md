# The guardrails, and what each one is worth

The model has no "not a digit" class. `dig-class100` emits 100 probabilities
and argmax always returns one, so a photograph of a blank wall produces a
number. Measured with alignment disabled, so that the value guards stood alone:

| Frame | Reads as | Confidence | Refused by |
| --- | --- | --- | --- |
| white | `11111111` | 0.38 | confidence, barely |
| black | `11111111` | 0.78 | rate limit |
| **grey** | `00000000` | **0.99** | the zero rule |
| noise | `46243242` | 0.07 | confidence |
| blurred dial | `00000000` | 0.24 | the zero rule |

A blank grey wall reading zero at 99% confidence is the number to remember
whenever `min_confidence` looks like the answer. It is the model grading its
own homework. What actually refuses trash is **plausibility against the
previous reading** (the zero rule and the rate limit), and neither of those
asks the model anything. `tests/test_reader.py` section 5 pushes these frames
through the real pipeline on every test run and requires all of them refused.

Three guards, in the order they run:

**1. Alignment quality** (`align_gate`, `service/digits.py`). The only one that
sees a *systematic* error. A frame that is sharp, well exposed and aligned to
the wrong place produces a stable, confident, wrong number that every other
guard passes and that repeating the measurement only reproduces. A real match
on this meter runs well over a thousand inliers. The frame that motivated this
guard ran 21 of 147 with `dx = -808`. The bars are `min_inliers`,
`min_inlier_ratio`, `max_shift_px` and `max_rotation_deg` in the config.

**2. Agreement across the frames of a wake** (`confirm_samples`). Removes the
random class (a flicker, sensor noise, a drum caught mid-tick), because none of
those repeat. It is **blind to systematic error**: misplaced ROIs agree every
time. Two green ticks are not verification.

**3. The gate** (`gate`). Zero, decrease, rate, confidence. It refuses when
there is no prevalue at all. Without one, the rate and decrease checks do not
exist, and the first reading after a restart would be the least guarded of
the day, which is exactly when a wrong value sets a `total_increasing`
sensor's baseline permanently.

## The asymmetry

A refused wake costs half an hour of resolution, because the meter is a
totaliser and the next accepted reading includes everything since. An
accepted wrong reading books bad statistics into a `total_increasing` sensor,
and the repair is Developer tools → Statistics → Adjust sum, by hand. Every
threshold here leans towards refusing.
