# Outage pre-charge

When DTEK publishes a schedule with an outage in it, the house makes sure the
battery is full before that outage starts. It switches the inverter to grid and
charges, at the lowest AC charge current that still finishes in time, and it
uses the cheap night tariff when that is enough on its own. The **Pre-charge**
icon on the Power station dashboard's AC charge chip turns the whole thing on
or off.

| File | What it holds |
| --- | --- |
| `config/packages/outage_precharge.yaml` | the plan sensor and the two automations |
| [`../PowerStation/power-station.yaml`](../../PowerStation/power-station.yaml) | the override itself, as rule 1b ([architecture §11](../../PowerStation/docs/architecture.md#11-outage-pre-charge)) |
| `config/www/powmr-inverter-console-card.js` | the icon ([power-station-dashboard.md](power-station-dashboard.md)) |
| `tools/test_outage_precharge.py` | renders the plan against fake states |

## What counts as an outage

Only a window in a schedule DTEK has published, which is
`sensor.dtek_next_outage_start` ([dtek-outage-schedule.md](dtek-outage-schedule.md)).
The poller builds it from the `fact` schedule and leaves it null whenever no
schedule is in force, so two things DTEK also publishes are not used:

- **The weekly preset table**, the `maybe` heatmap on the Shutdowns card. It is
  not a schedule, and charging for it would mean charging at day rates most days.
- **An emergency outage recorded against the address.** It is published after
  the lights are already out.

Inside a published schedule, a `maybe` hour counts as dark, the same as it does
for the DTEK alerts.

DTEK suspended the stabilisation schedules on 24.07.2026, so the plan reads
`idle` until they come back. Then it starts working without any change.

## Who decides what

The firmware owns the inverter. By day its tariff rule puts the inverter on SBU
Battery, and `Night Charging Only` blocks the charger. Anything Home Assistant
changed behind their backs would be undone within five minutes. So the override
is a rule inside the firmware, ranked below grid protection and above the
tariff, and HA does two things:

| Home Assistant | The ESP |
| --- | --- |
| knows the schedule and works out the plan | puts the inverter on Utility First and opens the BMS charger |
| writes `datetime.powmr_inverter_pre_charge_until` (the outage start) | ends the override when its own clock passes that time |
| sets `select.powmr_inverter_max_ac_charge_current` | saves the user's current at the start and puts it back at the end |

Because the deadline is on the ESP, an HA that dies mid-charge cannot leave the
inverter stuck on the grid.

## The plan

`sensor.outage_pre_charge_plan` is re-rendered on every DTEK poll, every 5
minutes, and whenever the switch changes. Each poll replaces the plan; nothing
from the last one is kept. If a window moves earlier, the current goes up. If it
moves later, the current goes down, or the plan goes back to waiting for the
night. If it disappears, the override is released straight away.

| State | Meaning |
| --- | --- |
| `off` | the icon is off |
| `idle` | no scheduled outage ahead, or no battery reading |
| `full` | the pack is within 1 % of full |
| `waiting_night` | it is daytime, and the night tariff before the outage can fill the pack at 60 A |
| `charging` | the override is on: `current` amps until `until` |

The arithmetic, using the same 280 Ah pack constant as `battery_runtime.yaml`:

```
need     = (280 Ah − capacity_remaining) × 1.15     # CV taper and charger losses
deadline = outage start − 30 min                    # aim to be full a bit early
night    = hours of 23:00–07:00 between now and the deadline
```

- **Daytime, `night × 60 A ≥ need`:** `waiting_night`. Nothing is sent to the
  ESP, and at 23:00 the plan becomes `charging`.
- **Night, the rest of the night is enough:** `current = need ÷ night`. That
  spreads the charge over the cheap hours instead of rushing it.
- **Night, the rest of the night is not enough:** 60 A.
- **Daytime, the night won't do it, or there is no night before the window:**
  `current = need ÷ hours to the deadline`.

The current is rounded up to the next inverter step (10, 20 … 60 A). It is never
below 10 A, and it is 60 A when the deadline is under 15 minutes away. The ESP
holds the override until the outage start itself, so the 30-minute buffer only
affects the sizing.

Pre-charge outranks [adaptive night charge](adaptive-charge.md). When this plan
leaves `idle` (a window is published), adaptive is switched off, and a
notification says so. It stays off until you switch it back on. If you switch
it off while a pre-charge is charging, adaptive waits to hand back your own
current until the pre-charge is over.

When a pre-charge starts, `notify.household` sends one message on the
`Outage pre-charge` channel, with the time and the amps. A day-rate charge is
never a surprise. Re-targets after that are silent.

## Testing

```sh
python tools/test_outage_precharge.py
```

It renders the real template from the package for each case: every state, the
current sizing, the night-tariff preference, and the re-poll cases (moved
earlier, moved later, removed).

To try it live, overwrite `sensor.dtek_shutdowns` through the REST API with its
own attributes plus a `next_outage_start` a few hours out. The plan reacts at
once, and the next real poll (at most 300 s later) puts everything back. To try
the firmware alone, set **Pre-charge Until** to ten minutes from now from the
device page. You should see the priority go to Utility First and the charger
open, then both come back at the next 5-minute tick after the deadline.
