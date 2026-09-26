# Climate dashboard

`dashboards/lovelace.dashboard_climate.json` is three views, each holding one
instance of `config/www/climate-console-card.js` with a different `tab:` —
the same split as the Power station dashboard, so the tab strip is Home
Assistant's real one and the URL and back button keep working.

| view | `tab` | what it draws |
| --- | --- | --- |
| Rooms | `rooms` | the three Aqara sensors: value, comfort band, today's min/max and dew point, over a shared temperature chart and a shared humidity chart |
| Living room A/C | `hall` | `climate.daewoo_a_c`, the metered plug it hangs off, and everything `irbridge_ac_energy.yaml` derives from that plug's meter |
| Bedroom A/C | `bedroom` | `climate.153931629566331_climate`, its fourteen feature switches, its eleven readouts and the metered plug it hangs off |

What it replaced was a single `history-graph` carrying all six room sensors.
Three temperatures and three humidities on **one axis** is the whole problem
with it: humidity sat near 50 and squeezed every temperature into a band a few
pixels tall, so the card could not answer the question it existed for. Neither
A/C was on the dashboard at all. Two charts with an axis each is the fix, and
the reason this is a custom card rather than two `history-graph`s is the other
two thirds of it — see the card's own header for why markdown and `tile` cards
cannot draw them.

**The two A/C tabs deliberately do not look alike.** The hall unit is infrared,
which is write-only: mode, setpoint, fan and swing are records of what was
transmitted, and the tab says so on its face. Only the activity is measured, off
the meter, which is also what raises `binary_sensor.a_c_drift` — and a drift
puts a banner across the hero with the sensor's own `detail` attribute in it and
a **Resend state** button. The bedroom unit talks over the LAN with full
feedback, so nothing on that tab is hedged; it is also the tab that can go
`unavailable` as a whole, which it does whenever its plug is off. That is drawn:
the banner names the plug as the cause and offers to switch it back on.

Three places the card knowingly departs from the design it was built from — the
filter-life row (no entity exists, replaced by the bridge's assumed state),
"today min / max" (its own midnight-to-now window, so the range buttons cannot
change what "today" means) and the target line (the setpoint's real attribute
history, not a flat line at the current value) — are listed with their reasons
in the card's header comment.

**The room charts are the Power station chart.** Same viewport machinery, same
gestures: drag to move through time, scroll or pinch to zoom about the cursor,
double-click or pick a range to go back to live. Hovering gives a vertical
cursor, a dot per room and a bubble with the timestamp and all three readings,
and the cursor is drawn on *both* charts at once — two stacked charts over one
time axis exist to answer "what was the humidity when the kitchen hit 31", and
a cursor on only one of them cannot. Under each chart is Now / Min / Max / Mean
per room, computed over **what is on screen**, so zooming in narrows them.

Two things it does that the inverter's does not, because three series need
them: the y axis snaps its step to a 1-2-2.5-5 ladder so five grid lines get
five round labels, and one viewport drives both charts. Two things it
deliberately does not do: no robust-percentile y domain (the kitchen hitting
31 °C while someone cooks is the most interesting row in the window, not an
outlier to clip) and no off-scale counter, because nothing is ever clipped.

**Both A/C dials are draggable**, like HA's own thermostat: grab the knob or
tap anywhere on the ring. The service call fires on *release* and only if the
value changed — on the hall unit every `set_temperature` is an infrared frame,
and one per `pointermove` would fill the bridge's queue with setpoints nobody
asked for. The ring also carries a tick at the **current** temperature, so the
gap between the mark and the knob is the work the unit has to do.

## Running cost, on both units, on two tariffs

`config/packages/ac_tariffs.yaml` bills both air conditioners on the same
two-zone tariff the inverter already uses, switching at **23:00 and 07:00** —
boundaries owned by `PowerStation/power-station.yaml`, which declares them once
as substitutions and gates the battery charger with them. If the window moves,
it moves there first.

Each unit gets two `utility_meter`s with `tariffs: [day, night]` beside its
existing totals, and cost is `day kWh × day rate + night kWh × night rate`.
The old behaviour was one flat `input_number`, which under-billed by half for
everything that ran overnight — and the A/C is exactly the load that runs
overnight. The card shows the split under each figure and the zone in force as
a chip, so a tariff select that failed to switch is visible as a disagreement
rather than as a bill that is quietly wrong.

`config/packages/bedroom_ac_energy.yaml` is the bedroom's half of what
`irbridge_ac_energy.yaml` does for the hall: running/compressor binary sensors
off the plug, activity, average draw, setpoint delta, energy today and this
month, and the three `history_stats` counters. It is built on **watts, not on
the unit's own compressor frequency**, even though this unit reports one — the
unit reports nothing at all when it is off, and "what did it draw today" is
asked precisely then.

Three traps this cost, all now written into the files:

1. **A `utility_meter` with `tariffs:` is not named like one without.** Without
   tariffs the entity id comes from `name:`; with them it comes from the config
   **key**, gains the tariff as a suffix, and `name:` survives only as the
   friendly name. So `key: irbridge_ac_tariff_daily` is
   `sensor.irbridge_ac_tariff_daily_day`, not `sensor.a_c_tariff_today_day`.
   Nothing failed loudly — the cost sensors just sat `unavailable`.
2. **`device_class: monetary` rejects `state_class: measurement`.** A price per
   kWh is a rate, not an amount of money; `sensor.electricity_tariff_now`
   carries a unit and neither class.
3. **`curl` exits 0 on a 401.** Four "successful" service calls had done
   nothing. Use `tools/ha_call.sh`, which sets `--fail-with-body`.

The split meters were created at the restart that deployed them, so they start
at zero: today's and this month's split under-report everything that ran before
that moment, while the plain `sensor.a_c_energy_today` total does not. The two
agree from the first full day onward, and that identity is worth checking if a
figure ever looks wrong:

```
sensor.irbridge_ac_tariff_daily_day + sensor.irbridge_ac_tariff_daily_night
  == sensor.a_c_energy_today
```

Rates live in `input_number.electricity_tariff_day` / `_night`, set to
**4.32** and **2.16 UAH/kWh** — Ukraine's household single rate and its half-
price night zone. Both `min: 0`, deliberately against this repo's "each `min:`
IS the default" rule and for the same reason `gas_meter.yaml` breaks it: a
tariff you cannot zero is a tariff you cannot switch off while working it out.

```sh
python tools/check_climate_card.py            # live, against the box
python tools/check_climate_card.py --offline  # structure only
node tools/test_climate_chart.js              # chart maths, no network
```

`test_climate_chart.js` loads the card against a DOM stub and asserts the
arithmetic: that every y axis divides into one step, that decimation never
drops a window's extreme, that a zoom keeps the instant under the cursor under
the cursor, that the mean is weighted by time rather than by row count, that
the hover hit-test agrees with the drawn path, and that the dial's angle
maths round-trips. Everything in that list fails *silently* when it is wrong —
a chart with a lost extreme still looks like a chart.

That is this card's `check_dtek_templates.py`. A Lovelace card pointed at an
entity id nobody publishes does not fail — it renders, lays out correctly and
reads an em dash forever, which on this dashboard is indistinguishable from the
bedroom unit being offline, a state it draws on purpose. So the checker diffs
the card's entity list against `/api/states`, asserts the card and
[`docs/ac-features.md`](../docs/ac-features.md) list the same feature toggles, and asserts every view
asks for a `tab` the card implements. An *unavailable* entity passes; a missing
one does not.

Deploying it is the same three steps as any card, and the resource registration
is the one the checker will keep failing on until it is done:

```sh
sh tools/ha_www_push.sh
python tools/ha_dashboard.py --card climate-console-card.js
python tools/ha_dashboard.py --push dashboards/lovelace.dashboard_climate.json \
    --url-path dashboard-climate
```

Bump the card's `VERSION` on every edit and re-run `--card`, for the reason
`ha_www_push.sh` gives. The checker fails while the mirrored `?v=` and the
card's `VERSION` disagree.
