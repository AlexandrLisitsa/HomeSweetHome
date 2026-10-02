# Roadmap

What is left between stage one (seeing the blinks, done) and an electricity
meter Home Assistant can put on the Energy dashboard. The steps run in order.
Each one says what "done" means, so it is clear when to move on.

What stage one established, which everything below builds on:

- The NIK 2102 blinks 6400 times per kWh. At the 6 kW supply limit that is at
  most one blink every 94 ms.
- At 10 ms sampling a flash is 3 samples (about 30 ms). The baseline between
  flashes is about 760 and the peak about 1014.
- Hysteresis counts the boiler capture exactly: **on above 950, off below 820**.
  A single threshold near the midpoint sits on the edge samples and miscounts.
- The board misses about 0.07% of slots while a phone is polling, plus a
  ~0.9 s block while WiFi connects at boot. A counter must treat a reported
  miss as "a blink may be missing here".

## 1. Write the detector offline

Add `tools/detect.py`. It replays a golden CSV through the same hysteresis the
firmware will use and prints the blink count. It also reports every `# MISSED`
or `# HOLE` note it crosses, together with whether a blink could have been lost
there.

**Done when** it prints 163 for the clean stretch of
`data/golden/2026-10-01-1441-boiler.csv` (seq 18613–23307). Every later
capture gets its count checked the same way.

## 2. Record more golden data

At the meter, with [`tools/capture.py`](../tools/capture.py):

- **Low load.** Only standby, so blinks come seconds apart. This checks that a
  slowly drifting baseline does not trip the detector.
- **High load.** Boiler, kettle and oven together, so blinks come towards the
  94 ms limit. This checks that consecutive flashes stay separate.
- **Room light.** Room lights on and off, and daylight, with the sensor
  mounted. This checks the shielding.

**Done when** each capture is in `data/golden/` and listed in its README with
a verified count, and `detect.py` matches all of them.

## 3. Stage-two firmware: count

- Run the detector inside the sampling timer callback, so a count never waits
  on WiFi.
- Keep the running pulse total across restarts. Write it to RTC memory on every
  pulse, and to flash rarely (every N pulses and before an OTA update) so
  flash wear stays low.
- Count missed slots that could have hidden a flash separately, as
  "uncertain".
- Add a `/count` endpoint returning pulses, kWh, the current W (from the
  interval between the last two pulses), missed slots and uptime. Keep
  `/samples` and the live page for debugging.

**Done when** the board's count over a timed run at the meter matches the
blinks counted by hand or from a capture made at the same time.

## 4. Report to Home Assistant

Two entities, and no more (see the repo's no-sensor-sprawl rule):

- an energy sensor in kWh, `state_class: total_increasing`, for the Energy
  dashboard's grid consumption;
- a power sensor in W.

Both get the area prefix the other devices use.

**Open decision:** how the numbers get to HA.

- **HA polls `/count`** with a REST sensor. This is the recommendation:
  nothing on the board needs the HA token, and the firmware stays dumb.
- The board pushes to HA's REST API, the way MeterCam does.
- MQTT.

**Done when** the energy sensor is on the Energy dashboard and a board restart
does not make it jump.

## 5. Calibrate and mount for good

- Compare the count with the meter's register over at least a day:
  Δregister × 6400 should equal Δpulses.
- Mount the sensor and board permanently on a USB supply, with a fixed DHCP
  lease.

**Done when** a day's kWh from HA agrees with the register to within one
displayed digit.

## 6. Merge

Open a PR from `feature/electricity-meter` into `master`. Then remove the
project from the "unfinished" lists in the root `README.md` and
`MANIFEST.md`, and list it under Modules.
