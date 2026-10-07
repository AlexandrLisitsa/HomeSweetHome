# Power station dashboard

`dashboards/lovelace.dashboard_inverter.json`, at the URL `dashboard-inverter`:
the home's power system on two tabs, each drawn by one custom card. The
inverter's data comes from the ESPHome firmware in
[`../../PowerStation`](../../PowerStation/README.md); the battery's from the JK
BMS gateway.

| Tab | Card | Version | Side of the system |
| --- | --- | --- | --- |
| Inverter | `config/www/powmr-inverter-console-card.js` (`custom:powmr-inverter-console-card`) | 2.10.0 | AC: grid → inverter → house |
| Battery (`/battery`) | `config/www/jkbms-battery-console-card.js` (`custom:jkbms-battery-console-card`) | 1.6.0 | DC: inverter bus ↔ battery pack |

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
| `flow` | a live flow diagram: grid → inverter → house, plus the battery leg under the inverter and the **Meter** under the grid, each run's speed scaled to its power |
| `controls` | the inverter's switches as three chips (**Auto** tariff, **Protect** grid, **AC charge**, which also carries **Night only**, adaptive charge and **Pre-charge** as icons) and its three selects (power priority, AC input mode, max AC charge current), plus the electricity meter's day and night kWh this month with their cost, and its lifetime total |
| `history` | grid, load and battery power over 30 min, 1 h, 24 h, 7 or 14 days, from the recorder |

**The electricity meter** ([electricity-meter.md](electricity-meter.md)) is
the truth about the grid; the inverter's `grid_real_power_calculated` is an
estimate (load + 30 W + charging) and only sees what goes through the inverter.

- **The Meter tile** hangs under Grid, as Battery hangs under Inverter: the
  meter's real power, the whole flat, the boiler's circuit included. Its scale
  runs to the 6000 W breaker (`max_meter_w`) with the load gauge's bands and
  words: **NORMAL** to 3600 W (green), **ELEVATED** to 5100 W (amber),
  **HEAVY** above (red), **OVERLOAD** past the breaker; the sub-label gives the
  share of the breaker. Its run reaches full speed at the same 6000 W. The tile
  is styled like Grid, whose own figure it is. Without a `meter_power` entity
  it is hidden.
- **The Grid tile** keeps the voltage, frequency and the inverter's grid input
  (`… W in`, the inverter's estimate, so it does not repeat the meter).
- **The energy rows** are the meter's this-month day and night kWh, each with
  its cost in ₴ from the Energy dashboard, and the meter's lifetime total. The
  row of the current tariff (`select.electricity_meter_tariff`) is marked
  **active**. The month counters started on 2026-10-04, so October reads low.

On a phone (under ~900 px) the tiles stack: Grid, Inverter, House load,
Battery, then Meter last, without its run (stacked, a run from Grid would
point at the wrong tile).

**The grid-return countdown.** After an outage the firmware waits for five minutes
of stable voltage before it trusts the grid again (`delayed_off: 300s` on
`binary_sensor.powmr_inverter_grid_condition_safe`). The unfiltered
`binary_sensor.powmr_inverter_grid_voltage_in_range` turns on the moment the
voltage is back, so while it is on and the safe sensor is still unsafe, the pill
counts down from its `last_changed`. It is shown only in that window. The delay
is the card option `grid_return_s` (default 300) and must match the firmware.

**The AC charge chip carries the charger's features, as small icons.**
Everything that shapes AC charging sits on that one chip, so the header has
three chips, not five. The chip's own icon on the left is the main switch, the
charger itself (`switch.powmr_inverter_ac_charging_enabled`, the BMS charge
MOSFET): it pulses while the pack is taking current from the grid, and the
chip's label opens its dialog. After the label come the features, each its own
switch: dark when off, lit in its colour when on, whatever the others are
doing. A tap toggles it, and its tooltip names it and its state. In order:

| Icon | Toggles | Lit |
| --- | --- | --- |
| `mdi:weather-night` | **Night only**, `switch.powmr_inverter_night_charging_only` | blue |
| `mdi:tune-variant` | **adaptive night charge**, `input_boolean.adaptive_night_charge` | amber |
| `mdi:battery-clock` | **Pre-charge**, `switch.powmr_inverter_outage_pre_charge` | amber |

**An icon pulses while it acts**, not merely while it is on: the charger while
the pack takes grid current, Night only while the pack charges under its night
window, adaptive while its plan reads `charging` (it is sizing the current),
Pre-charge while its plan reads `charging` (it is filling the pack for an
outage). On and idle is lit and still.

The card options `chip_night_only` and `chip_precharge` still override the two
switches that used to be chips.

**Every tooltip explains its element.** Hovering a chip, an icon, a tile or a
control shows its name and state, then what it does and an example (`HELP` in
the card), e.g. Night only: "charging stops at 07:00 and starts again at 23:00".
That covers the status pill and its return countdown, the uptime, the five
tiles and their status words (whose tooltips give the bands), the four flow
runs, the three selects, the energy rows, and the chart's range and series
buttons, its title, window and Now/Min/Max/Mean. The two chip sub-labels open
the plan sensors, so each has a tooltip of its own. The format is
[the dashboard tooltip standard](dashboard-tooltips.md).

**Adaptive** ([adaptive-charge.md](adaptive-charge.md)) has a sub-label from
`sensor.adaptive_charge_plan`: **20 A → 07:00** while it is sizing the night
charge, **tonight** by day, or **full**. Switching the charger off switches
adaptive off with it, and so does a DTEK outage window, which hands the night
to pre-charge. Its icon is dimmed and a tap on it does nothing in any of these
cases: Auto and Night only both off, the charger off under Auto, or an outage
window pending.

**Pre-charge** ([outage-precharge.md](outage-precharge.md)) only arms the
feature when it is on. While the plan has something to do, a sub-label from
`sensor.outage_pre_charge_plan` shows what: **30 A → 09:30** while charging,
**at night → 09:30** while the night tariff will cover it, or **full**. The
icon's tooltip gives the plan's reason. Tapping either sub-label opens its
plan.

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
- **Colours fade, words snap.** Every banded reading on both tabs (voltages,
  load, state of charge, current, cell voltages, cell spread, temperatures)
  fades between its two colours across each threshold instead of jumping:
  solid inside a band, half of each on the threshold itself, so a bar, its
  number and its chart line shift a little with every step of the reading. The
  status word (HEALTHY, HIGH, ...) still changes exactly on the threshold, and
  so do the "out of tolerance" counts. Both cards get the fade from the shared
  `config/www/card-ramp.js`; each card's `*_FADE` constants say how wide it is
  (10 % for state of charge, 5 V for grid voltage, 0.05 V for a cell).
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
