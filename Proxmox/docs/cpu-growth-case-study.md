# Case study: why the HA guest's CPU grew

The guest's CPU climbs in **steps with flat plateaus between**, not as drift —
which rules out anything accumulating, including database growth:

```
week of 03-30   0.93%          baseline, before the inverter
week of 04-27   1.59%  +0.60   ESPHome inverter added 04-24; disk steps too
week of 06-22   2.03%  +0.34   CPU up, disk FLAT
week of 08-24   2.43%  +0.22   IR Bridge energy package, deployed 08-23
```

The model that fits: **CPU tracks state-change rate at ~0.025pp per 1,000
writes/hour, whether or not those changes reach disk.** ESPHome at 21,886/h
gives +0.60pp and the `sensor.google_*` shims at 14,291/h give +0.34pp — within
15% of each other. Disk bytes do *not* predict it: April→May added 43 KB/s for
+0.58pp, while May→August added 2 KB/s for another +0.59pp.

The 06-22 step is CPU with no disk at all, which is the shims' signature, but it
is inferred rather than proved — they had no registry entries to date until they
were given `unique_id`s on 2026-08-28.

**Open prediction.** 11,262 writes/hour were removed on 2026-08-28. The model
says −0.28pp, so a quiet day should read ~2.15% against 2.43%. If it holds,
halving the ESPHome telemetry is worth ~0.55pp and the firmware work is
justified; if it does not, the model is wrong and the cost is somewhere not yet
measured.

**Measure quiet days only.** Every restart, log pull and API poll lands on this
same graph. The week of 08-24 rose from 2.43% to 2.50% during the session that
produced these numbers — that was the session, not the house.
