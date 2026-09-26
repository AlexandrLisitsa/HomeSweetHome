# Stateful climate control

The current app is stateless: you hand it a frame, it emits it. A real
`climate` entity in Home Assistant needs the other half, and this is the part
people get wrong, so it is worth stating before you build it:

**A/C remotes are stateful.** There is no "temperature up" code. Every press
transmits the *entire* state — power, mode, target temp, fan speed, swing,
sometimes a checksum — as one long frame. So a climate entity means keeping an
assumed model of the unit's state in the bridge, rebuilding and re-encoding the
whole frame on every change, and accepting that the model drifts the moment
anyone touches the physical remote. The usual mitigation is a cheap
temperature sensor in the room and a "resend current state" button.

Which means the next step depends on what you find. If the winning index turns
out to be a Midea/Coolix protocol, you get a documented bit layout from
[IRremoteESP8266's `ir_Coolix.cpp`](https://github.com/crankyoldgit/IRremoteESP8266)
and can encode any state you like. If it is something obscure, the pragmatic
path is to bundle SmartIR's whole code set for that one manufacturer — it
already contains a frame per mode/fan/temperature combination — and have the
bridge look up frames by state instead of computing them.

---

Sources consulted:
[python-broadlink protocol.md](https://github.com/mjg59/python-broadlink/blob/master/protocol.md) ·
[SmartIR climate codes](https://github.com/smartHomeHub/SmartIR/tree/master/codes/climate) ·
[IRremoteESP8266 supported protocols](https://github.com/crankyoldgit/IRremoteESP8266/blob/master/SupportedProtocols.md) ·
[irdb](https://github.com/probonopd/irdb) ·
[ESPHome climate_ir](https://esphome.io/components/climate/climate_ir/)
