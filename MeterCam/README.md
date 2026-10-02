# MeterCam

Reads the gas meter's dial with a camera and feeds the reading into Home
Assistant's Energy dashboard, but only a reading it can stand behind. Once a
month it also files that reading with the gas operator, through the operator's
Telegram bot, when someone presses *Submit* on the phone
([`docs/gas-bot.md`](docs/gas-bot.md)).

The meter is an **Itron Gallus 2000 G4** (2011; Qmax 6 m³/h, Qmin 0.04, Pmax
0.5 bar). Its index is eight drums behind a glass window: five black (whole m³),
then three **red** decimals. The camera frames seven of them, so the reading
goes to 0.01 m³, which is also the most this project will publish. See
[What is published](docs/pitfalls.md#what-is-published).

---

## How it works

```
ESP32-CAM (deep sleep)                  MeterCam, LXC 104 :8770              Home Assistant
   │ wakes every 30 min                                                         │
   │ lights the meter, 2 frames                                                 │
   ├── POST /read?meter=gas&fw=gas-cam-6 ──►  align, read, confirm, gate        │
   │                                          │ accepted? ── set_value ───────► input_number.gas_meter_camera_reading
   │◄── {value, accepted, …, firmware} ───────┘                                 │        │
   │ newer firmware offered? → download /firmware/gas-cam.bin, reboot           │        ▼
   └── sleep                                                                    │ sensor.gas_meter_reading → Energy "Gas"
```

1. **The board sleeps.** It wakes on its own timer every 30 minutes. Asleep,
   the sensor is powered down, the LEDs and the on-board flash are held low and
   the radio is off. Awake, it runs for a few seconds.
2. **It pushes two frames** to MeterCam in one request. MeterCam aligns each
   frame to a stored reference, reads every drum with a digit CNN, and requires
   the two frames to agree.
3. **The gate decides.** The reading has to be plausible against the previous
   one: no decrease, no impossible jump, confident digits. Only then does
   MeterCam write it to Home Assistant. A refused reading writes nothing, and
   its frames are kept with the reason beside them. Every frame is archived;
   the newest one is at `/last.jpg`, and `/archive` downloads the lot.
4. **Every answer carries the newest firmware version.** If it is higher than
   the board's own, the board updates itself before going back to sleep.

In Home Assistant, `sensor.gas_meter_reading` (the Energy dashboard's gas
source) shows the **higher** of the camera's helper and the hand-typed one. So
the history recorded by hand continues as one series, and a stale typed value
can never drag the reading back. That logic lives in
`HomeAssistant/config/packages/gas_meter.yaml`.

[`docs/architecture.md`](docs/architecture.md) explains why it is built this way.

---

## Why this exists

Before this, the gas reading was an `input_number` somebody typed after
crouching down to look at the dial. The monthly total was right, but every
reading landed in the hour it was typed, so the Energy dashboard's daily and
hourly bars were fiction. Two readings an hour turn them into a real
consumption curve, and a leak or a jammed boiler becomes something you notice
rather than something you reconstruct from a bill.

A reed switch was tried first and failed: there is no magnet in either red
drum. Optical reading depends on nothing hidden inside the meter.

---

## Layout

| Path | What |
| --- | --- |
| `service/digits.py` | The carry rule, the agreement check and the gate. Stdlib only, so the tests that guard the irreversible failures run anywhere |
| `service/reader.py` | Decode, orient, align, crop, infer, assemble |
| `service/app.py` | `POST /read`, `/last.jpg`, `/last_accepted.jpg`, `/archive`, `/firmware/*`, `/gas/bot/*`, `/health`; the Home Assistant prevalue fetch and write |
| `service/gasbot.py` | The monthly reading to Gazmerezhi's Telegram bot (Telethon): the checked walk through the bot's menus, and the one-time login |
| `service/config.example.json` | Template for the box's `config.json`, with the reasoning for each setting |
| `tests/test_reader.py` | Plain asserts, no pytest |
| `tests/test_gasbot.py` | `gasbot.py` against a fake bot that says what the real one says, including every way it must refuse |
| `models/fetch.sh` | Downloads the weights. Not committed: no stated licence upstream |
| `firmware/gas-cam/` | The camera: AI-Thinker ESP32-CAM, PlatformIO |
| `deploy/` | Creates LXC 104 on the Proxmox host and deploys the service into it |

---

## Tests

```sh
python tests/test_reader.py                                   # the arithmetic: no dependencies
python tests/test_gasbot.py                                   # the bot walk, against a fake bot
sh Proxmox/tools/pve_ssh.sh "pct exec 104 -- docker exec metercam python tests/test_reader.py"
sh Proxmox/tools/pve_ssh.sh "pct exec 104 -- docker exec metercam python tests/test_gasbot.py"
```

The first runs on a bare workstation. `digits.py` imports nothing third-party
on purpose, because its functions are the ones whose failure cannot be undone.
The second runs everything, including the real model and synthetic trash
frames, which must never be accepted. Both must pass before a deploy.

---

## Docs

| Doc | About |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | The wake cycle, who decides what, and how Home Assistant is wired |
| [`docs/api.md`](docs/api.md) | The service's HTTP endpoints |
| [`docs/firmware.md`](docs/firmware.md) | The board: wiring, building, the first USB flash, publishing an update, rolling back |
| [`docs/deployment.md`](docs/deployment.md) | LXC 104: creating it, first setup, deploying code, frame retention, the gas bot's keys |
| [`docs/operations.md`](docs/operations.md) | Day to day: checking reads, the camera moved, a reading went wrong |
| [`docs/gas-bot.md`](docs/gas-bot.md) | The monthly reading to Gazmerezhi's Telegram bot: why a bot, the conversation, its checks, the Telegram login |
| [`docs/guardrails.md`](docs/guardrails.md) | Each guard against a bad reading, and what it is worth |
| [`docs/pitfalls.md`](docs/pitfalls.md) | The things that are easy to get wrong when reading a dial |
