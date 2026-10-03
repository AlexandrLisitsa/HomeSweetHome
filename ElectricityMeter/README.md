# ElectricityMeter

Counts the electricity meter's imp/kWh LED with a photodiode, so Home Assistant
gets energy use from the meter itself instead of estimating it: the **power**
now, and the **consumption split day / night** for the Energy dashboard.

An ESP8266 samples the photodiode 100 times a second, counts the meter's blinks
(6400 per kWh) and reports the register and the power to Home Assistant over
MQTT. Home Assistant splits the register by tariff zone
([`HomeAssistant/docs/electricity-meter.md`](../HomeAssistant/docs/electricity-meter.md)).

**To set it up, follow [`docs/setup.md`](docs/setup.md)**: wiring, the MQTT
login, flashing, mounting, and setting the meter reading.

## Status

| Stage | State |
| --- | --- |
| 1. See what a blink looks like | **Done** (2026-10-01). The first [golden capture](data/golden/README.md) has a verified count of 163 blinks. |
| 2. Count blinks | **Done** in code: [`include/detector.h`](firmware/electricity-meter/include/detector.h) counts all 163, tested on every push. Not yet run on the meter. |
| 3. Report to Home Assistant | **Done** in code: MQTT discovery, the day/night [package](../HomeAssistant/config/packages/electricity_meter.yaml). Not yet deployed. |
| 4. Commission at the meter | **Next**: flash, set the reading, compare with the display. [`docs/setup.md`](docs/setup.md). |

[`docs/roadmap.md`](docs/roadmap.md) has what is left and what "done" means for
each step.

## Hardware

- **Lolin NodeMCU V3** (ESP8266, CH340 USB serial).
- **MH-Sensor-Series photodiode module**: the common LM393 board with `VCC`,
  `GND`, `DO` and `AO` pins.
- A **USB charger** in the inverter-backed socket next to the meter, so the
  board keeps counting through grid outages. It draws about 80 mA.

| Module pin | Lolin V3 pin | Note |
| --- | --- | --- |
| `VCC` | `3V` | **Not `VIN`/5 V.** The module's `AO` swings up to its supply voltage, and A0 must stay at or below 3.3 V. |
| `GND` | `G` | |
| `AO` | `A0` | |
| `DO` | — | Not used. The firmware thresholds `AO` itself, with the hysteresis the comparator lacks. |

The ESP8266's ADC itself reads 0–1 V. The Lolin V3 has a 220k/100k divider in
front of it, so the `A0` pin takes 0–3.3 V and reads it as 0–1023.

On this module **more light gives a higher reading**: about 760 between
flashes and 1014 at the peak, with the module taped over the LED.

## How it counts

[`include/detector.h`](firmware/electricity-meter/include/detector.h) is plain
C++, compiled into the firmware and, unchanged, into the tests.

- **Hysteresis, not a threshold.** A flash starts above **on** (950) and must
  fall below **off** (820) before the next one can start. A flash's edge
  samples land anywhere between baseline and peak (`761, 937, 1018, 1018, 833,
  761`), so a single midpoint level counts some flashes twice. Both levels can
  be set from Home Assistant.
- **Time is samples.** A blink's time is its slot number × 10 ms, which carries
  no clock jitter. Power is the energy of the blinks in the last 10 s (562.5 J
  each) over the time they span. It is capped at one blink's energy over the
  time since the last one, so it falls towards 0 when the load stops instead
  of freezing.
- **A gap is not ignored.** If the sampler misses 3 or more slots in a row
  (≥ 30 ms, room for a whole flash), the energy sensor's `uncertain`
  attribute goes up by one.

**The register never goes backwards.** Home Assistant reads a drop in a
`total_increasing` sensor as a new meter. The board keeps the register in three
places and boots from the highest
([`include/persist.h`](firmware/electricity-meter/include/persist.h)):

| Copy | Written | Survives |
| --- | --- | --- |
| RTC memory | every blink | soft restart, watchdog, OTA |
| LittleFS `/state` | every 5 min, and on every deliberate change | power loss (minus the last few minutes) |
| The broker's retained state | every 10 s | anything, if the broker is up |

## Home Assistant

The board announces itself by MQTT discovery as one device, **Electricity
meter**:

| Entity | What |
| --- | --- |
| `sensor.electricity_meter_energy` | The register, kWh. **Unavailable until the meter reading has been set**, so the statistics never start from 0. |
| `sensor.electricity_meter_power` | W |
| `number.electricity_meter_reading` | Set the register to the meter's display |
| `number.electricity_meter_threshold_on` / `_off` | The detector's levels |
| `button.electricity_meter_restart` | |

The topics, retained state and commands are listed in
[`include/mqtt_link.h`](firmware/electricity-meter/include/mqtt_link.h).
Commands are checked before they are applied. A non-number never sets the
register, and a level outside `1 ≤ off < on ≤ 1023` snaps back.

## Building

Copy `firmware/electricity-meter/include/config.h.example` to `config.h`
(git-ignored) and fill in WiFi, the OTA password and the MQTT login.

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

- the register (kWh), the power (W) and the two detection levels;
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
| `/samples?since=<seq>` | JSON: `seq` (the number to ask for next), `total` (samples taken since boot), `from` (where this reply starts), `up` (ms), `rssi`, `missed`, `gap` (longest gap, µs), `interval` (ms), `pulses` (the register), `watts`, `on`, `off` and the `v` (0–1023) array. Sample *n* was taken *n* × `interval` ms after the first. A reply carries at most 250 samples; if `seq` < `total`, ask again. The board keeps the last 4096 samples (about 40 s). |

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
| [`tools/test_firmware.py`](tools/test_firmware.py) | Compiles the firmware's detector and MQTT code for the PC (g++, or the `gcc:13` Docker image on Windows). It replays the golden captures, drives the MQTT commands against [stubs](tools/stubs), and parses every discovery payload as JSON. CI runs it on every push. | No. |
