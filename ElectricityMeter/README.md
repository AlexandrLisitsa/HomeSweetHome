# ElectricityMeter

Counts the electricity meter's imp/kWh LED with a photodiode, so Home Assistant
gets energy use from the meter itself instead of estimating it.

**Stage one only reads.** The firmware samples the photodiode's raw analog value
and shows it live on a web page you open on a phone while standing at the meter.
Before writing any pulse detection we need to see what a blink looks like on
this sensor: the level in the dark, the level during a flash, and how long the
flash lasts. Counting, thresholds and reporting to Home Assistant come later.

## Status

| Stage | State |
| --- | --- |
| 1. See what a blink looks like | **Done** (2026-10-01). The board samples A0 at 100 Hz and serves it live, and the first [golden capture](data/golden/README.md) has a verified count of 163 blinks. |
| 2. Count blinks | **Next.** A detector is first written offline against the golden data, then ported to the firmware. |
| 3. Report to Home Assistant | Not started. |

[`docs/roadmap.md`](docs/roadmap.md) has each remaining step, what "done" means
for it, and the decisions still open.

## Hardware

- **Lolin NodeMCU V3** (ESP8266, CH340 USB serial).
- **Photodiode module with an analog output** (the common LM393 board with
  `VCC`, `GND`, `DO` and `AO` pins).
- A **USB charger or power bank** at the meter. The board draws about 80 mA.

| Module pin | Lolin V3 pin | Note |
| --- | --- | --- |
| `VCC` | `3V3` | **Not `VIN`/5 V.** The module's `AO` swings up to its supply voltage, and A0 must stay at or below 3.3 V. |
| `GND` | `G` | |
| `AO` | `A0` | |
| `DO` | — | Not used. The comparator's threshold pot will matter once we know the levels to set it between. |

The ESP8266's ADC itself reads 0–1 V. The Lolin V3 has a 220k/100k divider in
front of it, so the `A0` pin takes 0–3.3 V and reads it as 0–1023.

Tape the photodiode over the meter's pulse LED and shield it from room light.
On most of these modules **more light gives a *lower* reading** (the diode pulls
`AO` towards ground), but check yours: the dark-versus-torch test below tells you
which way round it is.

## Setup

Copy `firmware/electricity-meter/include/config.h.example` to `config.h` (git-ignored)
and fill in the WiFi credentials and an OTA password.

Build from **PowerShell**, never from Git Bash. PlatformIO refuses MSys/Mingw and
leaves a broken esptool behind (the same trap as `PowerStation/`).

```powershell
cd ElectricityMeter\firmware\electricity-meter

# First time, over the cable. The monitor prints the board's address.
pio run -e usb -t upload -t monitor

# Afterwards, over WiFi, with the board mounted at the meter.
$env:ELECTRICITY_METER_OTA_PASSWORD = '<OTA_PASSWORD from config.h>'
pio run -e ota -t upload --upload-port <board-ip>
```

Give the board a fixed DHCP lease in the router so its address does not move.
`http://electricity-meter.local/` also works on iPhones and laptops, but most Android
phones do not resolve `.local` names, so use the IP there.

## Watching it

Open `http://<board-ip>/` on the phone. The page polls the board four times a
second and shows:

- the current value, and the minimum, maximum and spread over the last 10 s;
- a 10-second graph. **Scale** switches between auto-zoom and the full 0–1023;
- a log of every sample with the board's uptime, plus `#` notes when the board
  restarted or the phone fell behind. **Pause** freezes both the graph and the
  log so you can read them.

The status line shows uptime, WiFi signal strength, `missed` and the longest gap
between two samples. It turns red if any slot was missed.

| Endpoint | Returns |
| --- | --- |
| `/` | The live page. |
| `/samples?since=<seq>` | JSON: `seq` (the number to ask for next), `total` (samples taken since boot), `from` (where this reply starts), `up` (ms), `rssi`, `missed`, `gap` (longest gap, µs), `interval` (ms) and the `v` (0–1023) array. Sample *n* was taken *n* × `interval` ms after the first. A reply carries at most 250 samples; if `seq` < `total`, ask again. The board keeps the last 4096 samples (about 40 s). |

### Sampling, and its limits

Sampling runs from a timer (the SDK's `os_timer`), not from the main loop, so
answering the phone or writing to serial never holds it up. Serial and HTTP read
the samples from a ring buffer. If they fall behind, they catch up afterwards
rather than skip anything. Each sample is checked against the previous one, and
any gap longer than 1.5 slots is counted in `missed`.

**What this cannot guarantee is a sample in every slot.** The ESP8266's WiFi
stack runs ahead of every timer a sketch can use. Measured on the bench:

| Interval | Result |
| --- | --- |
| 2, 4, 5 ms | The board never joins WiFi: the ADC is shared with the radio's calibration. Started after the join, 2 ms drops the connection within seconds. |
| 10 ms | WiFi holds. About 88 slots are missed in one 0.9 s block while WiFi connects at boot, then about 0.07% while a phone is polling (9 slots in 2 minutes). |

The meter is a NIK 2102 at 6400 imp/kWh. At the 6 kW supply limit it blinks at
most 10.7 times a second (one blink every 94 ms). Each flash lasts about 30 ms, which is 3
samples at 10 ms (see the golden capture below). A miss is usually a single
slot, so it costs one of a flash's three samples, not the whole flash. A miss
long enough to swallow a flash is possible, though: the 0.9 s block at boot is
one. A counter built on this has to treat a reported miss as "a blink may be
missing here", not ignore it.

The board still prints every sample over USB serial as one integer per line
(lines starting with `#` are status), so the PlatformIO monitor and the Arduino
Serial Plotter keep working on the bench.

WiFi adds a few counts of noise to the ESP8266's ADC: on the bench it reads a
spread of about 5 counts with WiFi up, compared with 3 without it. A meter flash
should move the value by far more than that.

To check the sensor works:

1. Cover the sensor. The value settles at the dark level.
2. Shine a phone torch on it. The value moves well away from the dark level.
3. Mount it on the meter. Each LED blink shows up as a short run of samples
   away from the dark level.

On this meter, with the module taped over the LED, the level between flashes is
about 760, a flash peaks at about 1014, and it lasts about 30 ms.

## Golden data

[`data/golden/`](data/golden/README.md) holds raw recordings from the meter,
each with its clean stretch and the blink count a detector must reproduce. The
first is 47 s of the boiler heating: 163 blinks, at 1.99 kW.

## Tools

| Script | What it does | Changes anything live? |
| --- | --- | --- |
| [`tools/capture.py`](tools/capture.py) | Records every sample from the board to `data/golden/<date>-<time>-<label>.csv`, marking any slot the board missed. Also records Home Assistant's inverter power readings next to it. | No. It only reads. |
