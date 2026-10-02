# Architecture

**The camera owns the clock, and MeterCam owns the verdict.** Home Assistant
only receives readings that have already passed.

## The wake

The ESP32-CAM spends almost all its time in deep sleep: the OV2640 is powered
down and held down, GPIO13/14 (the LEDs) and GPIO4 (the on-board flash) are held
LOW, and the radio is off. Every `SLEEP_SECONDS` (1800) the timer wakes it, and
`setup()` runs once:

1. Join WiFi. With no network it goes straight back to sleep.
2. Power the sensor, light both LEDs, and throw away about 20 frames while
   auto-exposure converges. The sensor starts every wake cold.
3. Keep two frames. Switch the lights and the sensor off **before** the upload.
   With the sensor streaming, uploads stalled on this board's weak link, and the
   sensor is most of the heat.
4. `POST /read?meter=gas&fw=<version>` with both frames, multipart.
5. Read the answer. The verdict is only logged. The `firmware` field is acted on:
   if its number is higher than the board's own, download
   `/firmware/gas-cam.bin` and reboot into it.
6. Deep sleep.

There is no web server, no stream, no SD card and no retry queue. Nothing can
call a sleeping board, so the board does all the reaching, in the one window
when it is awake anyway. A wake that fails costs half an hour of resolution,
not a reading: the meter is a totaliser and the next accepted reading includes
everything since.

## The read

`POST /read` (`service/app.py`) holds one lock and runs `reader.read()`. For
each frame it orients, aligns to `data/ref/gas.jpg`, crops the seven ROIs,
infers each drum with `dig-class100` and assembles the number. Then:

- **`align_gate`**: a transform that exists is not necessarily one to trust.
- **`confirm_samples`**: the two frames must agree.
- **`gate`**: zero, decrease, rate (scaled by the time since the last accepted
  reading), confidence, and a required prevalue.

The prevalue comes from Home Assistant (`input_number.gas_meter_camera_reading`).
While that helper is 0 (just created) or Home Assistant is unreachable, the
service's own `last_accepted.json` stands in. With neither, the read is
refused: an unguarded first reading is exactly the one that can set a
`total_increasing` sensor's baseline wrong for good.

An accepted reading is written with `input_number.set_value` and its frame
archived under `data/images/gas/raw/<date>/`. A refused one is archived, frames
and reason, under `data/images/gas/rejected/<date>/`. The newest frame is also
`last.jpg`. Either way the answer carries `"firmware"`, the contents of
`data/firmware/version.txt`.

## Home Assistant

```
input_number.gas_meter_camera_reading   ← MeterCam, accepted readings only
input_number.gas_meter_manual_reading   ← a human; MeterCam never writes it
            └──────── max ────────┘
                       ▼
sensor.gas_meter_reading   (device_class gas, total_increasing, m³)
   ├── Energy dashboard "Gas" source
   ├── utility_meter gas_meter_daily
   └── utility_meter gas_meter_monthly
```

`sensor.gas_meter_reading` keeps the `unique_id` it had when readings were
typed, because the Energy dashboard stores the statistic id and a new sensor
would orphan every m³ recorded before it. Taking the **higher** of the two
helpers is safe because the dial only climbs: the camera is normally ahead,
and a typed value only wins if someone types the dial while the camera is
down. A stale typed value can never pull the reading back, which matters
because a decrease of more than 10% is booked as a meter reset.

The monthly bill goes the other way. On the 1st, Home Assistant fetches
`/last_accepted.jpg` (the frame **and** its reading in one answer, so the two
cannot disagree), asks on the phone, and on *Submit* calls `/gas/bot/submit`.
MeterCam then files the number with the gas operator's Telegram bot
([`gas-bot.md`](gas-bot.md)). MeterCam holds the bot client because it has what
HAOS lacks: a persistent `/data` for the Telegram session, and a Python where
packages can be installed.

## Why the deciding stays in the service

Home Assistant writes nothing it was not told to. Whether a number is good
enough is decided by `gate()`, in this repo, in code with tests. The token
gives the service write access, not the judgement. `ha_publish()` is called
only after the gate has passed.

## Firmware updates

The update offer rides on the answer the board already waits for, so checking
costs no extra request. "Newer" means a higher number after the last `-` (for
example `gas-cam-6` → `6`). Only forward, never "different": a board flashed
over USB ahead of the server would otherwise update itself straight back to
whatever `version.txt` still names. That happened once, when a USB-flashed
gas-cam-4 replaced itself with gas-cam-3. [`firmware.md`](firmware.md) has the
publishing procedure.
