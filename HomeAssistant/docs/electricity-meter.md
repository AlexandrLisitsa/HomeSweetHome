# Electricity meter

The flat's consumption, read straight off the meter. A photodiode on the NIK
2102's imp/kWh LED counts blinks (6400 per kWh), and an ESP8266 reports them
over MQTT (see [`ElectricityMeter/`](../../ElectricityMeter/README.md)). This
is the grid figure on the Energy dashboard. The inverter's own grid counter only
sees the circuits behind it; the boiler, for one, isn't.

## Entities

From the board, by MQTT discovery (one device, "Electricity meter"). Nothing
for these lives in this repo's YAML:

| Entity | What |
| --- | --- |
| `sensor.electricity_meter_energy` | The register, kWh, `total_increasing`. Attributes `uncertain` (gaps long enough to have hidden a blink) and `missed_slots`. |
| `sensor.electricity_meter_power` | W, averaged over the last 10 s of blinks. |
| `number.electricity_meter_reading` | Sets the register. Configuration. |
| `number.electricity_meter_threshold_on` / `_off` | The detector's hysteresis levels, raw 0–1023. Configuration. |
| `button.electricity_meter_restart` | Configuration. |

From [`config/packages/electricity_meter.yaml`](../config/packages/electricity_meter.yaml):

| Entity | What |
| --- | --- |
| `sensor.electricity_meter_tariff_day` / `_night` | The register split by zone, reset monthly. The Energy dashboard's two grid sources. |
| `select.electricity_meter_tariff` | Which zone is counting. Switched by the clock: night 23:00–07:00, set again on every start. |

The zone is the clock's, not `sensor.electricity_tariff_zone`. That sensor's
third zone, `battery`, prices the A/C's off-grid use, and the meter has
nothing to count during an outage anyway. The boundaries match
`night_tariff_start` / `night_tariff_end` in `PowerStation/power-station.yaml`.
`tools/test_tariff_switch.py` checks this automation alongside the inverter's.

## Order matters the first time

1. The board is flashed and online. The energy sensor reads **unavailable**,
   not 0. A `total_increasing` sensor takes its first value as the statistics
   zero point, and 0 followed by the real register would be stored as one
   hour's consumption. The firmware holds it unavailable until step 2.
2. Set **Meter reading** to the meter's display.
3. Deploy the package and restart: `utility_meter` has no reload.
4. On the Energy dashboard, swap the grid sources (below).

Steps 3 and 4 must come after step 2. A utility meter that already exists
counts the jump from 0 to the register as consumption in whichever zone is
running.

## The Energy dashboard swap

The dashboard is a config entry, not YAML, so it changes by websocket
(`energy/get_prefs` → edit → `energy/save_prefs`). Save the old prefs first so
the change can be undone. Only the two `grid` entries change:

| Field | Was (inverter) | Becomes (meter) |
| --- | --- | --- |
| day `stat_energy_from` | `sensor.powmr_inverter_grid_real_tariff_day` | `sensor.electricity_meter_tariff_day` |
| night `stat_energy_from` | `sensor.powmr_inverter_grid_real_tariff_night` | `sensor.electricity_meter_tariff_night` |
| `stat_rate` (power) | `sensor.powmr_inverter_grid_real_power_calculated` | `sensor.electricity_meter_power` |
| prices | 4.32 / 2.16 UAH | unchanged |

The battery, gas and water entries stay as they are. The inverter's
statistics stay in the database; the dashboard shows the meter from the day
of the swap.

## Correcting the register later

Avoid it if you can. If the board ever has to be set again (a replaced meter,
a bad count):

1. Set **Meter reading** to the display.
2. The day/night meters have now counted the jump. Put each back with
   `utility_meter.calibrate` on `sensor.electricity_meter_tariff_day` and
   `_night`, using the value it had just before the jump (from its history).
3. The Energy dashboard's hourly statistics have the jump too. Fix that hour
   in **Developer tools → Statistics**: find the sensor, click the adjust icon,
   and subtract the jump from that hour.

The board never lowers the register by itself. It keeps the register in RTC
memory, in flash and in the broker's retained state, and takes the highest
of the three at boot, so a restart doesn't show up as a drop.
