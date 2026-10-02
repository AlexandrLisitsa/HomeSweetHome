# Power station dashboard

`dashboards/lovelace.dashboard_inverter.json`, at the URL `dashboard-inverter`:
the home's power system on two tabs, each drawn by one custom card. The
inverter's data comes from the ESPHome firmware in
[`../../PowerStation`](../../PowerStation/README.md); the battery's from the JK
BMS gateway.

| Tab | Card | Version | Side of the system |
| --- | --- | --- | --- |
| Inverter | `config/www/powmr-inverter-console-card.js` (`custom:powmr-inverter-console-card`) | 2.1.3 | AC: grid → inverter → house |
| Battery (`/battery`) | `config/www/jkbms-battery-console-card.js` (`custom:jkbms-battery-console-card`) | 1.4.1 | DC: inverter bus ↔ battery pack |

## Why custom cards

The tab used to be three sections of stock `tile` cards: every number was there
and none of the relationships were. Nothing showed that the grid was feeding the
house **and** charging the battery at once, or how hard. A flow diagram needs
styling that Home Assistant's own cards can't do here: card-mod, button-card and
power-flow-card-plus aren't installed, and HA's Markdown filter drops `style`. A
custom element has its own shadow root and none of those limits.

Both cards are registered as Lovelace resources, so they receive `hass` directly
(no token, no iframe). They build their DOM once and then only patch it, and the
history chart stays live from `set hass` rather than by polling.

## Inverter tab

Blocks, top to bottom (`blocks:` in the card config chooses and orders them):

| Block | Shows |
| --- | --- |
| `header` | the device name and lifetime uptime, and a status pill: **Grid connected** (green), **Grid down** (red), or **Grid returning** with a countdown (amber) |
| `flow` | a live flow diagram: grid → inverter → house, plus the battery leg, each run's speed scaled to its power |
| `controls` | the inverter's switches as chips (**Auto** tariff, **Protect** grid, **AC charge**, **Night only**, **Pre-charge**) and its three selects (power priority, AC input mode, max AC charge current), plus the day and night tariff meters |
| `history` | grid, load and battery power over 30 min, 1 h, 24 h, 7 or 14 days, from the recorder |

**The grid-return countdown.** After an outage the firmware waits for five minutes
of stable voltage before it trusts the grid again (`delayed_off: 300s` on
`binary_sensor.powmr_inverter_grid_condition_safe`). The unfiltered
`binary_sensor.powmr_inverter_grid_voltage_in_range` turns on the moment the
voltage is back, so while it is on and the safe sensor is still unsafe, the pill
counts down from its `last_changed`. It is shown only in that window. The delay
is the card option `grid_return_s` (default 300) and must match the firmware.

**The Pre-charge chip** toggles `switch.powmr_inverter_outage_pre_charge`, the
on/off for charging the pack before a scheduled DTEK outage
([outage-precharge.md](outage-precharge.md)). ON only arms it. While the plan
has something to do, a sub-label from `sensor.outage_pre_charge_plan` shows
what: **30 A → 09:30** while charging, **at night → 09:30** while the night
tariff will cover it, or **full**. Tapping the sub-label opens the plan, and the
chip's tooltip gives the reason.

**The AC charge chip has a second dot** for adaptive night charge
(`input_boolean.adaptive_night_charge`, see [adaptive-charge.md](adaptive-charge.md)).
It sits after the chip's own dot and lights orange when it is on, whatever the
BMS charger switch is doing. A sub-label from `sensor.adaptive_charge_plan`
shows **20 A → 07:00** while it is sizing the night charge, **tonight** by day,
or **full**. Switching the charger off switches adaptive off with it, and so
does a DTEK outage window, which hands the night to pre-charge. The dot is
dimmed and a tap on it does nothing in any of these cases: Auto and Night only
both off, the charger off under Auto, or an outage window pending.

Two firmware quirks the card handles:

- `grid_condition_safe` is `device_class: safety`, so **on means unsafe**.
- `sensor.powmr_inverter_grid_real_power_calculated` is derived, not measured: it
  returns 0 below 150 V and adds a fixed 30 W of inverter overhead. There is no
  export and no PV on this system, and the card draws neither.

## Battery tab

| Block | Shows |
| --- | --- |
| `header` | the title, a status pill and the clock |
| `switches` | the BMS switches: **Charging**, **Discharging**, **Balancer** |
| `pack` | the pack-state meters (state of charge, capacity, voltage), on tracks coloured by state of charge |
| `flow` | the live power flow between the inverter's DC bus and the pack, with the pack's cells in miniature |
| `cells` | the cell voltages and how far each drifts from the others |
| `timing` | when the pack will be full or empty at the current rate |
| `temps` | the BMS temperature probes |
| `history` | pack power and state of charge over time |

The BMS is the source of truth for the pack: `sensor.jkbms_gateway_bms_power` is
**signed** (+ charging, − discharging) and its state of charge is a real reading,
so neither direction nor level is guessed from the inverter's unsigned currents.

Colour follows state rather than decoration:

- **State of charge**: red below 20 %, amber below 70 %, green from 70 % (the
  card's `SOC_RED` / `SOC_GREEN`; the meter's track and its tick labels use the
  same two numbers).
- **The flow tile** is green only while charging. While discharging it is drawn
  in greys and white on purpose: the energy leaving the pack is the number to
  read, not an alert.

## Palette

Both cards share one semantic palette, deliberately muted so no status colour
shouts over the others:

| Meaning | Colour |
| --- | --- |
| OK / charging / grid connected | `#589569` sage green |
| Warning / grid returning / tariff | `#AE8446` amber |
| Fault / grid down | `#BB635B` muted red |
| House load | `#6EA8FE` blue |

The Inverter tab is drawn on neutral graphite in Space Grotesk; the Battery tab
uses the same grounds with IBM Plex Sans, and IBM Plex Mono for every number.
The fonts are served locally from `config/www/fonts/`.

## Changing it

1. Edit the card in `config/www/`, and bump its `const VERSION`
   ([MANIFEST, Versions](../../MANIFEST.md#6-versions)).
2. Push it and register the new version:

   ```sh
   sh tools/ha_www_push.sh
   python tools/ha_dashboard.py --card powmr-inverter-console-card.js
   python tools/ha_dashboard.py --card jkbms-battery-console-card.js
   ```

3. For a change to the dashboard itself (views, card options), edit
   `dashboards/lovelace.dashboard_inverter.json` and push it:

   ```sh
   python tools/ha_dashboard.py --push dashboards/lovelace.dashboard_inverter.json --url-path dashboard-inverter
   ```

4. Finish with `sh tools/ha_pull.sh`: an empty diff proves the box matches the repo.
