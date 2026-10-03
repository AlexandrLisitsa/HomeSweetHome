# Roadmap

How the meter became the Energy dashboard's grid source. **Finished
2026-10-03**: steps 1–5 and 8 are done; 6 and 7 were dropped (below).

## Decisions taken

- **Reporting: MQTT with Home Assistant discovery** (2026-10-03). It was
  chosen over HA polling a REST endpoint and over the board pushing to HA's
  REST API, because it gives one device, availability for free, retained
  state, and commands back to the board (meter reading, levels, restart)
  behind a broker login. The board never holds an HA admin token.
- **Day/night by the clock in Home Assistant**, not on the board: a
  `utility_meter` with `day` / `night` tariffs, switched at 07:00 and 23:00
  like the inverter's. The board needs no clock.
- **The meter replaces the inverter** as the Energy dashboard's grid source.
  The inverter misses the boiler's circuit.
- **Power from the inverter-backed socket**, so the board counts through
  outages.

## Done in code

1. **Detector.** [`include/detector.h`](../firmware/electricity-meter/include/detector.h)
   uses on > 950 / off < 820 hysteresis, uncertain gaps and power. It counts
   the boiler capture's 163 exactly and reads about 2 kW on it.
2. **Firmware.** It counts in the sampling timer, keeps the register in RTC,
   flash and the broker, and reports over MQTT discovery. The energy sensor
   stays unavailable until the meter reading is set.
3. **Home Assistant.** [`electricity_meter.yaml`](../../HomeAssistant/config/packages/electricity_meter.yaml)
   holds the day/night meters and the switch, tested with the inverter's in
   `test_tariff_switch.py`.

`tools/test_firmware.py` covers 1 and 2 on every push. It replays the
golden data, drives the MQTT commands, and parses the discovery payloads.

## 4. Commission at the meter

Follow [`setup.md`](setup.md) steps 1–8. **Done** (2026-10-03): wired,
2.2.0 on a fixed address, levels 990 / 940, reading set to 47267.64 kWh.

**Done when** the device is in Home Assistant, a torch flash counts exactly
one, the blinks on the phone page clear both levels, and the meter reading is
set.

## 5. Deploy the Home Assistant side

**Done** 2026-10-03: the package is on the box, and the Energy dashboard's grid
sources were swapped once the reading was set
([`HomeAssistant/docs/electricity-meter.md`](../../HomeAssistant/docs/electricity-meter.md)).

**Done when** `select.electricity_meter_tariff` follows the clock and the
Energy tab shows the meter.

## 6. More golden data

**Not needed** (2026-10-03). The counts at the meter matched the boiler and
the inverter from the first night, so the extra captures were dropped. Kept
here in case the count ever drifts.

Record these with [`tools/capture.py`](../tools/capture.py), with the sensor
mounted for good:

- **Low load**, blinks seconds apart, to check that a drifting baseline
  doesn't trip the detector.
- **High load** (boiler, kettle and oven), blinks towards the 94 ms limit.
- **Room light** on and off, plus daylight.

**Done when** each one is in `data/golden/` with a verified count and
`test_detector.cpp` checks it.

## 7. Prove it against the register

**Not needed** (2026-10-03), for the same reason. Run it if the Energy
dashboard and the bill ever disagree.

Compare HA with the display over at least a day: Δdisplay × 6400 should equal
Δpulses.

**Done when** a day's kWh agrees with the display to its last digit, and
`uncertain` stays at or near 0.

## 8. Merge

**Done** (2026-10-03): PR #22 merged, and the project moved from the
"unfinished" lists in the root `README.md` and `MANIFEST.md` to Modules.
