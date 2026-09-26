# Finding your A/C's protocol

Turn the A/C **off** at the remote, put the phone 1–2 m away pointing at the
indoor unit, and start a sweep:

```bash
T=your-token-here
curl -s -XPOST http://<phone-ip>:8765/sweep/start \
     -H "X-Auth-Token: $T" -H 'Content-Type: application/json' \
     -d '{"from":0,"to":60,"delayMs":4000,"command":"on"}'
```

That sends 61 candidate "turn on, cool, mid fan, mid temp" frames, one every
four seconds — about four minutes. Watch and listen. The instant the unit
beeps or the compressor starts:

```bash
curl -s -XPOST http://<phone-ip>:8765/sweep/mark \
     -H "X-Auth-Token: $T" -d '{}'
```

```json
{
  "windowMs": 12000,
  "suspects": [
    {"idx": 23, "label": "Midea (RG58E3/BGEF)", "atEpochMs": 1755870000123, "ok": true},
    {"idx": 22, "label": "Midea (KFR-32GW)",    "atEpochMs": 1755869996100, "ok": true},
    {"idx": 21, "label": "Midea (Unknown)",     "atEpochMs": 1755869992087, "ok": true}
  ],
  "note": "newest first — retry each with POST /codes/{idx}/send to confirm"
}
```

**`mark` deliberately returns a window, not a single index.** You will react
late — by the time you have registered a beep and typed a command, the sweep
has moved on one or two frames. Narrowing three candidates by hand takes
thirty seconds; restarting a twenty-minute sweep because the index was off by
two does not. Confirm each one on its own:

```bash
curl -s -XPOST http://<phone-ip>:8765/codes/22/send \
     -H "X-Auth-Token: $T" -d '{"command":"off"}'
```

The winning index is the seed for everything after this. Write it down.

## When the sweep finds nothing

Work through this in order — the first two are far more likely than a genuine
protocol miss.

| Symptom | Cause | Fix |
|---|---|---|
| `hasIrEmitter: true`, nothing ever reacts | aim or distance | 1–2 m, direct line of sight to the IR window on the indoor unit. Confirm the emitter physically fires: point a phone camera (front cameras usually have no IR filter) at the top edge and send anything — you should see a faint purple flicker. |
| Some frames error in `GET /log` | pattern too long for the emitter | Note the failing indices and skip them; `sweepd` logs each `!!`. |
| The whole 0–314 range does nothing | protocol genuinely not in the set | Capture the real code. See below. |

Capturing beats guessing, and the hardware is trivial: an ESP8266 or ESP32
plus a TSOP38238 receiver, running
[IRremoteESP8266](https://github.com/crankyoldgit/IRremoteESP8266)'s
`IRrecvDumpV2`. Point your KT-9018E at it, press a button, and it prints the
raw microsecond array — which you paste straight into `POST /ir/raw`. That is
about €5 and one evening, and it ends the guessing permanently.

Worth saying plainly: once you own that ESP32, wiring an IR LED to it and
running [ESPHome's `remote_transmitter`](https://esphome.io/components/climate/climate_ir/)
gives you a native Home Assistant climate entity with no phone, no Doze, no
battery optimisation, and no HTTP layer at all. The phone bridge is the more
interesting build and it reuses hardware you already own; the ESP32 is the one
that still works in two years without being plugged in and babysat. Your call
which matters more — I'd keep the phone version and buy the receiver.
