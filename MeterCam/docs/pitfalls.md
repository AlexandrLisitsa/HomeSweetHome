# The things that are easy to get wrong

## The carry rule

Drums are geared continuously: the tens drum advances a tenth of a turn for
every full turn of the units drum. When the units drum reads 9.5, the tens drum
is already 95% of the way to its next digit and *looks* like that digit.
Truncate and you are wrong for half a rotation; round and you are wrong for the
other half.

`service/digits.py` resolves each drum against the one to its right. The failure
it prevents is not a wrong digit — it is a **decrease**, from a meter that only
counts up.

This is also why the models are jomjol's `dig-class100` and not an OCR engine.
A drum caught between positions is not a character; Tesseract and friends return
a confident 6, a confident 7, or nothing. `dig-class100` emits 100 classes, one
per tenth, so that drum reads 6.5 and the fraction is the signal.

## What is published, and what is only read

`value` is what Home Assistant is asked to believe and what every guard judges.
`dial` is the whole eight-drum index, kept for the eye and for `tools/score.py`.
`report_decimals: 2` is what separates them: all eight drums are read, drawn on
the annotated frame and scored — the 0.001 drum simply stops deciding anything.

It is dropped because it turns once every two minutes at idle and **once every
1.8 seconds with the boiler firing**. A confirmation burst is five frames over
about ten seconds and `max_last_digit_step` allows one step across it, so
publishing 0.001 m³ imposed a flow ceiling of **0.36 m³/h** — barely above the
pilot flame. Every read taken while the gas was actually being burned disagreed
with itself and was refused. Nothing was lost permanently, since the meter is a
totalizer and catches up, but the gas landed in the wrong hour. At 0.01 m³ the
same budget permits 3.6 m³/h, above anything this house burns and below the
meter's Qmax of 6.

Trimming is **truncation, not rounding**: 2246.916 publishes as 2246.91, which
is gas burned, where 2246.92 is gas still in the pipe. Truncation of a rising
sequence also cannot fall, so the arithmetic can never manufacture the one
failure the gate exists to prevent. The offset is bounded and does not
accumulate — each reading is an absolute total, not a sum of deltas — so the
published figure is always within 0.01 m³ (under 0.1 kWh) of the dial, forever.

The prevalue is truncated the same way before anything compares it, because the
`input_number` holds whatever a human last typed, to the full 0.001.

**Do not coarsen this past 2 decimals without reading `max_delta` first.**
It is 0.6 m³ per five minutes, just above the meter's physical maximum of 0.5.
Quantizing to R makes a legitimate advance look up to R larger, so whole cubic
metres would force `max_delta` to 1.6 — and a misread units drum is exactly
+1 m³, which would then pass unnoticed. The rate limit is one of only two
guards that catch a confident misread.

## The gate

`gas_meter.yaml` sets out both traps at length. A reading of 0 sets a
`total_increasing` sensor's statistics zero point to 0, and the next real
reading is then booked as thousands of cubic metres of consumption. A downward
correction of more than 10% is taken as a meter reset, and is **not** undone by
correcting the value afterwards — the repair is Developer tools → Statistics →
Adjust sum, by hand.

So the bias is to refuse. A rejected frame costs one polling interval; an
accepted wrong one costs a manual `recorder/clear_statistics`. Rejected frames
are kept with the reason beside them, because by the time anyone looks the
meter has moved on.

## The archive

Every read is filed under `data/images/`, foldered by day and named for what
the model made of it:

```
data/images/gas/
  raw/2026-09-05/2026-09-05-16-11-2246.91.jpg
  rejected/2026-09-05/2026-09-05-16-11-111.111.jpg
                      2026-09-05-16-11-111.111.txt   <- the reason
```

The value is in the **name** because checking a frame against what was read off
it is the only reason these are kept. From a flat list of timestamps that means
opening each one beside the JSON it produced; here a run where the number jumps
and comes back is visible without opening anything.

`raw/` and `rejected/` sit **above** the date folder, not below. They carry
different retention — 7 days against 90 — and the prune timer selects on
`*/raw/*`, which works only while that split is a fixed path segment.

Minute resolution means two reads in one minute would collide; the second gets
`-2`, because silently overwriting the first loses exactly the frame someone
was looking at. A frame that produced no number at all is filed as `-none`
rather than dropped — those are the rarest and they explain outages.

**Getting them out.** `GET /archive` streams the lot as one zip, sidecars
included, and `?days=3` or `?meter=gas` narrows it. Ask `GET /archive/days`
first — it reports each day's frame count and byte total, which is the number
that decides whether you want the whole thing:

```sh
curl -s 'http://<metercam-ip>:8770/archive/days' | jq
curl -O -J 'http://<metercam-ip>:8770/archive?days=3'
```

The zip is streamed and stored uncompressed: JPEGs do not deflate, and the
container has 1 GB of RAM and no AVX, so neither building the archive in
memory nor re-compressing it is something this box should be asked to do. The
cost is a browser progress bar that spins rather than fills, since the length
is not known before the first byte goes out.

**The archive is capped at 1 GB** (`MAX_ARCHIVE_MB` in `deploy/_lxc_env.sh`).
Age alone does not bound it — seven days of raw frames is already ~1.2 GB, and
the rejected tree holds 90 days, so a camera that has drifted out of alignment
refuses every read and fills that side at the full poll rate for a quarter of a
year. Over the ceiling, the hourly prune deletes oldest-first, raw before
rejected.

---
