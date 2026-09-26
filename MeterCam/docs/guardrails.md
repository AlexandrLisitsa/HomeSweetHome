# The guardrails, and what each one is worth

The model has no "not a digit" class. `dig-class100` emits 100 probabilities
and argmax always returns one, so a photograph of a blank wall produces a
number. Measured 2026-09-05, alignment disabled so the value guards stood
alone:

| Frame | Reads as | Confidence | Refused by |
| --- | --- | --- | --- |
| white | `11111111` | 0.38 | confidence, barely |
| black | `11111111` | 0.78 | rate limit |
| **grey** | `00000000` | **0.99** | the zero rule |
| noise | `46243242` | 0.07 | confidence |
| blurred dial | `00000000` | 0.24 | the zero rule |

A blank grey wall reading zero at 99% confidence is the number to remember
whenever `min_confidence` looks like the answer. It is the model grading its
own homework, and on inputs unlike its training set it grades generously. What
actually refuses trash is **plausibility against the previous reading** — the
zero rule and the rate limit — neither of which asks the model anything.

Four guards, in the order they run:

**1. Alignment quality** (`align_gate`, `service/digits.py`). The only one that
sees a *systematic* error. A frame that is sharp, correctly exposed and aligned
to the wrong place produces a stable, confident, wrong number that every other
guard passes and that repeating the measurement only reproduces. Measured on
this meter: a real match runs ~1000 inliers, and the frame that motivated this
ran 21 of 147 with `dx = -808`. It was accepted by the old bar of 12.

**2. Agreement across five frames** (`confirm_samples`). Removes the random
class — a flicker, sensor noise, a drum caught mid-tick — because none of those
repeat. It is **blind to systematic error**: misplaced ROIs agree five times
out of five. Five green ticks are not verification.

**3. The gate** (`gate`). Zero, decrease, rate, confidence. Refuses when there
is no `prevalue` at all, because without one the rate and decrease checks do
not exist and the first poll after a restart would be the least guarded reading
of the day — which is exactly when a wrong value sets a `total_increasing`
sensor's baseline permanently.

**4. The corpus** (`tools/score.py`). The only one that *proves* anything. The
other three establish that a reading is plausible, agreed and well-aligned;
none of them can tell you it is **right**. Only comparing against a number a
human read off the dial does that.

```sh
docker compose exec metercam python tools/score.py
```

```
gas -- 214 labelled frames (203 readable, 11 deliberately bad)
  accepted            184/203  (90.6%)
  correct             184
  WRONG               0
  bad-frame accepted  0
```

## The threshold

| | |
| --- | --- |
| wrong among accepted | **0** — not 99%, zero |
| deliberately-bad frames accepted | **0** |
| accept rate | **≥10%** |

The asymmetry is total, which is why the first row is not a percentage. A
refused frame costs one polling interval. An accepted wrong one books bad
statistics into a `total_increasing` sensor, and the repair is Developer tools
→ Statistics → Adjust sum, by hand.

The accept rate is the number allowed to be mediocre. At five-minute polls
there are 288 attempts a day and the hourly Energy bars need about 24 of them,
so one poll in ten is enough. One in twenty still beats a hand-typed reading a
month.

---
