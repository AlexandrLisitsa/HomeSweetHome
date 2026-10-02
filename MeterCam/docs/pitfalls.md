# The things that are easy to get wrong

## How the drums are geared

There are two kinds of counter, and the wrong `counter_type` corrupts digits
the model read correctly.

- **`continuous`** (common on water meters): every drum is geared to the one on
  its right. When the units drum reads 9.5, the tens drum is already 95% of the
  way to its next digit and *looks* like it, so each drum has to be resolved
  against its right-hand neighbour. Truncate and you are wrong for half a turn;
  round and you are wrong for the other half.
- **`jump`** (this meter): each whole-number drum stays put until the drum to
  its right completes a turn, then snaps forward. Every drum shows a digit
  squarely in its window, so each one is rounded on its own.

The Gallus is `jump`. You can read that off a photograph: at 02246.916 the
units drum showed a clean, centred 6, not mostly 7. Read with the continuous
rule, the same model output turned 02246916 into 02235905: four digits wrong
at 100% confidence.

This is also why the models are jomjol's `dig-class100` and not an OCR engine.
A drum caught between positions is not a character. `dig-class100` emits one
class per tenth, so a half-rolled drum reads 6.5, and that fraction is the
signal.

## What is published

The camera frames seven drums, `0 2 2 6 1 | 7 2`. The 0.001 drum is out of
shot, so the meter is read with `decimals: 2` and publishes to 0.01 m³.

The 0.001 drum would not be published even if it were in frame. It turns once
every two minutes at idle and **once every 1.8 seconds with the boiler
firing**, so two frames of one wake would routinely disagree on it and the
meter would go blind exactly when gas was being burned.

**Do not coarsen past 2 decimals without reading `max_delta` first.** It is
0.6 m³ per 300 s, scaled by the time since the last accepted reading, and just
above the meter's physical 0.5. Quantizing to R makes a real advance look up
to R larger, so whole cubic metres would force `max_delta` up to 1.6. A
misread units drum is exactly +1 m³, which would then pass unnoticed. The rate
limit is one of only two guards that catch a confident misread.

`round_last_drum_down: true` publishes a last drum caught mid-roll as the digit
**leaving** the window (gas already burned) once it is 0.7 of the way through,
never across 9 → 0, where the neighbour snaps.

## The traps in a `total_increasing` sensor

`HomeAssistant/config/packages/gas_meter.yaml` sets these out at length:

- **A reading of 0** sets the statistics zero point to 0, and the next real
  reading is booked as thousands of cubic metres in one hour. The gate refuses
  zero. The template counts each helper only when it is > 0, and both helpers
  have `min: 0` with no `initial:`.
- **A drop of more than 10%** is taken as a meter reset, and correcting the
  value afterwards does **not** undo it. The repair is Developer tools →
  Statistics → Adjust sum, by hand. The gate refuses every decrease
  (`tolerance_down: 0.0`), and the template takes the higher of the camera's
  and the hand-typed helper, so a stale typed value cannot cause one.

## The reference and the ROIs

Every ROI is a pixel rectangle **in the reference frame**. Change the
reference without redoing the ROIs, or the other way round, and the reader
reads rectangles in a coordinate space they were not drawn in. It returns a
confident wrong number, with no error. They are always redone together (see
[`operations.md`](operations.md)), and a deploy never ships either.

A missing or unreadable reference is a refusal, never a fallback to raw
coordinates.

## The camera's own settings

- **Sensor powered down between wakes.** Every wake starts from a cold AGC, and
  against a close light the first frames come back dark and green. Warm-up is
  counted in frames (`ADAPT_FRAMES`), not milliseconds: a dark scene exposes
  for longer, so a time budget gives the darkest scenes the fewest frames to
  converge in.
- **Sensor off before the upload.** With the sensor streaming into PSRAM during
  the send, uploads stalled on this board's weak link.
- **JPEG quality is part of the reference.** The reference is one of the
  camera's own frames. Change `JPEG_QUALITY` or the LEDs, and take a new
  reference.
