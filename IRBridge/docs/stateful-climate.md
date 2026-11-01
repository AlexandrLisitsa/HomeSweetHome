# Stateful climate control

The bridge started stateless: hand it a frame, it emits it. A real `climate`
entity in Home Assistant needs the other half, and this is the part people get
wrong, so it is worth stating plainly:

**A/C remotes are stateful.** There is no "temperature up" code. Every press
transmits the *entire* state — power, mode, target temperature, fan, sometimes
a checksum — as one long frame. So a climate entity means keeping an assumed
model of the unit's state in the bridge, rebuilding and re-encoding the whole
frame on every change, and accepting that the model drifts the moment anyone
touches the physical remote.

## How the bridge does it

The sweep ([protocol-sweep.md](protocol-sweep.md)) found this unit's protocol:
SmartIR set **1380**, a Midea/Coolix code set. That is the good case: a
documented protocol, so the bridge can both look frames up and build them.

- **The code set.** `tools/extract_ac_codes.py` cuts set 1380's whole
  mode × fan × temperature matrix out of SmartIR into
  `app/src/main/assets/ac_codes.json`, with identical frames pooled (on Midea,
  `heat_cool` sends the same frame for every fan speed, because the unit picks
  its own fan).
- **The state.** `AcController` holds power, mode, temperature and fan, and
  persists them, so a reboot does not reset the model while the unit keeps
  running. `POST /ac/set` merges a partial update onto it and sends the frame
  for the result ([api.md](api.md#the-air-conditioner)). `GET /ac/state` is
  what the bridge last sent, never a measurement: `ConsumerIrManager` cannot
  receive.
- **Frames it can build.** Because the set's own power-off frame decodes as
  Coolix, `Codecs.Coolix` can assemble messages the set does not contain: the
  `dry` mode, and swing. If a future `ac_codes.json` belonged to some other
  protocol, those routes would refuse rather than fire invented frames.
- **Swing is separate.** On Coolix it is a toggle sent as its own message, not
  a bit in the state frame. So it has its own routes, keeps only a *belief*
  about the vane, and is never re-sent by `/ac/set` or `/ac/resend`, which
  would reverse it.
- **Drift.** Anyone using the physical remote desynchronises the model
  silently. The mitigation is `POST /ac/resend` (send the believed state
  again) and a room temperature sensor in Home Assistant to notice when the
  room disagrees with the setpoint.

On the Home Assistant side, `config/packages/irbridge_ac.yaml` is the climate
entity (over MQTT, since Home Assistant has no template `climate`), and
`config/irbridge/rest_commands.yaml` calls the routes above; see the
[README](../README.md).

## For a unit that is not Coolix

If the winning index is some other documented protocol, IRremoteESP8266 (for
example
[`ir_Coolix.cpp`](https://github.com/crankyoldgit/IRremoteESP8266) for this
one) gives the bit layout. If it is something obscure, the pragmatic path is
the one this bridge also takes for its looked-up frames: bundle SmartIR's
whole code set for that one manufacturer, which already has a frame per
mode/fan/temperature combination, and look frames up by state instead of
computing them.

---

Sources consulted:
[python-broadlink protocol.md](https://github.com/mjg59/python-broadlink/blob/master/protocol.md) ·
[SmartIR climate codes](https://github.com/smartHomeHub/SmartIR/tree/master/codes/climate) ·
[IRremoteESP8266 supported protocols](https://github.com/crankyoldgit/IRremoteESP8266/blob/master/SupportedProtocols.md) ·
[irdb](https://github.com/probonopd/irdb) ·
[ESPHome climate_ir](https://esphome.io/components/climate/climate_ir/)
