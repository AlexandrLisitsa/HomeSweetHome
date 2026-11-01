# Dashboard effects

Visual effects on the console cards. All of them run in the browser, as CSS
and a little DOM. Home Assistant stores nothing for them and the box spends no
CPU on them. Each was tried on a temporary Playground dashboard on live data
and kept. Odometer numbers were tried there and dropped.

| | |
|---|---|
| Shared module | `config/www/card-fx.js` (imported like `card-tip.js`, versioned by its `?v=`) |
| Switched on in | `dashboards/lovelace.dashboard_inverter.json`, `…_climate.json`, `…_dtek.json` |
| Tests | `tools/test_card_fx.js`; each card's effects in `tools/test_power_cards.js` |

## The effects

| Effect | Card, dashboard | What it shows |
|---|---|---|
| `power_glow` | inverter, battery (Power station) | A flow tile glows, and its line thickens, with the watts through it. It uses the same ceiling as the line's speed. |
| `liquid_soc` | battery | The SOC bar is taller and glassy, with a wavy edge. It shimmers only while charging. |
| `balance_pulse` | battery | The top cells (within 2 mV of the highest) pulse while the balancer has work: switched on and a spread over 10 mV. This BMS reports no balancing current. |
| `chart_polish` | inverter, battery | A gradient fill under the history line and a pulsing dot on the latest value. |
| `gradient_dial` | climate, A/C tabs | The setpoint arc runs cold blue → the mode's colour → warm amber. A dashed ring turns while the compressor runs. |
| `tinted_rooms` | climate, Rooms tab | Room tiles are tinted blue under 20 °C and red over 26 °C, deeper the further out. |
| `live_thresholds` | load shedding hero (Shutdowns) | A step within 10 % of the battery glows, and pulses faster and brighter the closer it is. |
| `danger_zone` | load shedding hero | The band below the lowest step is a red gradient with a drifting hatch. |

Every effect pauses while its card is off screen or the tab is hidden. Under
`prefers-reduced-motion` they all stand still.

## The `fx` key

| Value | Behaviour |
|---|---|
| absent | No effects. No effect node or style is built: the card looks as it did before effects existed. |
| `fx: [power_glow, chart_polish]` | Those effects. An unknown name fails in the card editor. |

So an effect goes off for one card by removing its name from that card's `fx`
list in `dashboards/`, then `ha_dashboard.py --push`. No card release is
needed.
