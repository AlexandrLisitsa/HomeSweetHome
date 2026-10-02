# Golden captures

Raw A0 recordings from the board on the meter, made with
[`tools/capture.py`](../../tools/capture.py). The file format is described in
that script. Each capture is listed below with the stretch that is clean and the
answer a pulse detector must give on it.

## 2026-10-01-1441-boiler.csv

Boiler heating, nothing else switched during the capture. 76.4 s, 7639 samples
at 10 ms. The board missed no slots and the sequence has no holes.

| Rows by time | What it is |
| --- | --- |
| 0–12.6 s | Handling: the sensor being put on the meter. Values from 494 to 1023. |
| **12.66–59.6 s** (seq 18613–23307) | **Clean. Use this for development.** |
| 59.6 s–end | Handling: the sensor being taken off, settling at about 679. |

In the clean stretch:

| | |
| --- | --- |
| Blinks | **163** |
| Blink interval | 270–290 ms (122 × 280, 38 × 290, 2 × 270): 3.543 blinks/s, 1.99 kW at 6400 imp/kWh. The meter's display read 1.91 kW at some point during the capture. |
| Baseline between flashes | median 760. Edge samples on the way into and out of a flash reach 889. |
| Flash peak | 909–1018, median 1014 |
| Flash length | 3 samples (about 30 ms) in all but one: there is a typical rising edge, two samples at the peak, then a falling edge (`761, 937, 1018, 1018, 833, 761`) |

The count was made with hysteresis: on above 950, off below 820. A single
threshold near the midpoint (about 890) sits on the edge samples and miscounts.
The 163 is believed exact because the intervals are so regular: one missed blink
would leave a gap of about 560 ms, and the longest interval is 290 ms.

The Home Assistant columns (`.ha.csv`) read 0 W grid power throughout. The
inverter does not see the boiler's circuit, so they are no cross-check here.
