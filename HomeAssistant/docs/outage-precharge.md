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

A window in a schedule DTEK has published, which is
`sensor.dtek_next_outage_start` ([dtek-outage-schedule.md](dtek-outage-schedule.md)).
The poller builds it from the `fact` schedule and leaves it null whenever no
schedule is in force. The **weekly preset table**, the `maybe` heatmap on the
Shutdowns card, is not used: it is not a schedule, and charging for it would
mean charging at day rates most days.

## Emergency outages

An **emergency** outage recorded against the address (`sensor.dtek_shutdowns`
state `outage_emergency`, `outage_type` 2) is handled differently. It is
published after the lights are already out, so there is nothing to plan. But
while it stays on record the grid comes and goes. On 31 Oct the grid came back
at 180 V at 09:26 and the record ran to 21:00. Every minute of mains is a
minute to fill the pack. So while the record is up:

- the plan reads `charging` at the full 60 A, whatever the tariff and the hour,
  or `holding` (on grid, Utility First, still 60 A) once the pack is full;
- `until` is DTEK's `outage_end`; with no end, or once it has passed with the
  record still up, it rolls an hour ahead on every render, so the ESP's own
  deadline still ends the override within an hour of HA going quiet;
- the plan's `emergency` attribute is `true`. When mains comes back, the
  message says "Mains is back with a DTEK emergency outage on record until
  21:00".

The rule is two lines: **on schedule, charge gently; in an emergency, as fast
as possible.** DTEK files its schedule outages as type 2 as well, with the
reason `Стабілізаційне відключення (Згідно графіку погодинних відключень)`
(17.10 and 03.11.2026). That record is the schedule, so it gets the normal
sized plan below, not 60 A. Every other type-2 reason counts as an
emergency: `Аварійні ремонтні роботи` (31 Oct), `Екстренні відключення…`, and
any new reason DTEK adds.

**Ukrenergo's emergency outages** count the same way, and they are the common
case. They leave the address record blank, so `sensor.dtek_shutdowns` stays
`ok`, and DTEK says "Графіки не діють". They come from
`binary_sensor.dtek_emergency_shutdowns`, the flag behind the ⚠️ Ukrenergo
alert. It is on when YASNO marks our queue `EmergencyShutdowns` or the DTEK
banner says so, confirmed over 10 minutes
([dtek-outage-schedule.md](dtek-outage-schedule.md)). Ukrenergo gives no end
time, so `until` rolls an hour ahead. The plan's `emergency_source` says which
source drives it: `dtek_record`, `yasno`, `banner` or `both`.

**An emergency outranks the schedule.** On 08.11 the flag was on all evening,
but the plan only read the address record. It sat `idle` when mains came back
at 23:51. At 00:25 DTEK published a 07:30 window, and the plan charged at the
night tariff's 20 A. The drive put that back over a hand-set 60 A every five
minutes. Now an emergency from any source means 60 A, window or not.

The flag drops for a poll when YASNO rolls over to the new day (00:00–00:15 on
09.11, including the 10-minute confirmation). So an emergency holds for 30
minutes after the last render that saw a live source (`emergency_seen`). A held
render does not restart the 30 minutes. After that the schedule's own plan
takes over.

A **planned** outage on record (`outage_planned`, type 1) does not count.
Neither does the published schedule. Those keep the normal plan. A stale or
failed poll re-serves the last emergency, so the charge holds through a missed
poll. The Pre-charge switch gates this too: with it off, nothing charges
automatically. Grid protection still ranks above the override, so a grid out of
185–250 V with protection on stays on battery.

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
minutes, and whenever the switch changes. Each poll replaces the plan, and the
only thing it keeps from the last one is whether a charge has started (see
[Once it starts, it holds](#once-it-starts-it-holds)). If a window moves earlier, the current goes up. If it
moves later, the current goes down, or the plan goes back to waiting for the
night. If it disappears, the override is released straight away.

| State | Meaning |
| --- | --- |
| `off` | the icon is off |
| `idle` | no scheduled outage ahead, or no battery reading |
| `full` | the pack is within 1 % of full |
| `waiting_night` | it is daytime, and the night tariff before the outage can fill the pack at 60 A |
| `charging` | the override is on: `current` amps until `until` |
| `holding` | charged after a `charging` start: still on grid (Utility First) at `current` amps until `until` |

**The current follows two rules, and nothing else.** While the plan has the
inverter on grid (`charging` or `holding`), an emergency means 60 A, and a
scheduled window means the gentle sizing below. `holding` writes its current
too. On 10.11 at 00:00 the plan went from `charging` to `holding` in the same
second. `holding` wrote no current, so a 99 % pack took the 60 A that had been
set by hand that evening. Now a scheduled `holding` sizes its current like
`charging`, which near full is the 10 A floor.

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
below 10 A. Once the deadline is under 15 minutes away, it is sized to the
window start itself, with at least 15 minutes assumed, so a nearly full pack
gets 10 A rather than a burst of 60 A just before the outage. The ESP
holds the override until the outage start itself, so the 30-minute buffer only
affects the sizing.

The gentle current still has the pack full before the next window. It is
rounded up, it carries the 15 % margin, and it is re-sized every 5 minutes from
what is still missing and the time left. A charge that lags therefore asks for
more amps as the deadline nears, up to 60 A in the last 15 minutes.
`test_outage_precharge.py` steps the plan every 5 minutes against a pack that
takes only 87 % of the current, and then only 70 %. It checks that every case
60 A could reach is at 99 % or more when the window starts.

### Once it starts, it holds

The first real outage (17.10.2026, 13:30) showed the problem with a stateless
plan. The pack reached 99 %, the plan said `full`, and the drive released the
deadline. The ESP went back to SBU, the house drew 2.8 Ah from the pack, and
the plan said `charging` again. Power Priority flipped 20 times in three hours,
and every flip sent another "pre-charge started".

So the plan reads its own previous state. Once it is `charging` or `holding`,
it is committed until the window starts or the switch goes off:

- within 5 % of full, it is `holding`. The deadline stays armed, so the ESP
  keeps Utility First and the charger on, at the gentle current (60 A in an
  emergency). The pack floats on grid and the house runs from the grid.
- more than 5 % short, it is `charging` again, silently. It never goes back
  to `waiting_night` by day.

A pack that is already full when a window appears is `full` and is not held:
the house stays on SBU until the pack drops below 99 %, and from then on the
latch applies.

Pre-charge outranks [adaptive night charge](adaptive-charge.md). When this plan
leaves `idle` (a window is published), adaptive is switched off, and a
notification says so. It comes back on by itself once the outage is over. If you switch
it off while a pre-charge is charging, adaptive waits to hand back your own
current until the pre-charge is over.

There is one message, on the `Outage pre-charge` channel of
`notify.household`: when mains comes back after an outage and the plan is
`charging`. It gives the outage time, the amps and the battery. "Outage" means
at least 20 s with no mains, the same rule as ✅ Power Restored, so blips stay
quiet.

The plan going to `charging` sends nothing. With a schedule running, it does
that in the dark after every window, as soon as the pack drains under 99 %.
On 05.11 that pinged at 00:43 with no mains to charge from. `holding`,
re-targets and the swaps between `charging` and `holding` are silent too.

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
