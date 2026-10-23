# Kitchen light button

An Aqara D1 wireless double rocker (WXKG07LM, `lumi.remote.b286acn02`) on the
kitchen wall. It is battery-powered, paired with Zigbee2MQTT as
**Kitchen light button**, and sits in the kitchen area. The automation and its
three scripts are in
[`config/packages/kitchen_button.yaml`](../config/packages/kitchen_button.yaml).

| Rocker | Press | Does |
| --- | --- | --- |
| Left | click | toggles the kitchen light, `light.kitchen_relay` |
| Right | click | toggles the LED strip, `light.led_ambient` |
| Left | hold | the strip glides dimmer, down to 5 % |
| Right | hold | the strip glides brighter, up to full, and switches on if it was off |
| Either | click while gliding | stops the glide where it is, and toggles nothing |
| Both | click | if either light is on, both go off; if both are off, both go on |

## How the glide works, and why it's not "dim while held"

The button sends one `hold_left` / `hold_right` about half a
second into a hold, and **nothing on release**. Home Assistant never finds
out how long a rocker was held, so it can't dim only while you hold it.

So a hold starts the strip's own Zigbee level move: Zigbee2MQTT's
`brightness_move`, at 32 of 255 per second, about 7 s from end to end.
`script.led_ambient_glide` is on exactly while a glide runs, and that's how a
click knows to stop the glide instead of toggling. With no click, the
glide stops by itself after 8 s. Either way `script.led_ambient_glide_stop`
sends the stop and lifts the strip back to 5 % if the move went below it.

The strip is addressed by its IEEE address (`zigbee2mqtt/0xa4c1385443844c1e/set`),
so renaming it doesn't break anything.

## Things that look like bugs and are not

- **The kitchen light can refuse to switch off.** If
  `input_boolean.kitchen_light_force_on` is on, the Force Light On automation
  in `config/automations.yaml` switches it straight back on, just as it does
  after the wall switch. With force-on on, a click on both rockers turns only
  the strip off.
- **Holding the left rocker for about 5 s starts pairing mode** on the button
  itself. Its LED blinks. That's the button, not this automation.
- **The button's entities show `unknown` after a restart.** It is a sleepy end
  device and reports its battery about once an hour. Presses still work at once.

## Renaming it

The automation listens on the Zigbee2MQTT topic
`zigbee2mqtt/Kitchen light button`, which uses the friendly name. Renaming
the device in **Zigbee2MQTT** means changing that topic in the package as
well. Renaming it in **Home Assistant** doesn't affect the automation.

## Pairing again

In Zigbee2MQTT, turn on *Permit join*. Hold the left rocker for about 5 s,
until the LED blinks, then keep pressing a rocker every few seconds until
the interview finishes. Pair it close to the coordinator. If the friendly name
comes back as the IEEE address, rename it to `Kitchen light button`.
