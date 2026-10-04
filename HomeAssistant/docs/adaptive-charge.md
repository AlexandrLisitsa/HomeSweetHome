# Adaptive night charge

`config/packages/adaptive_charge.yaml`. While the night tariff runs
(23:00–07:00), this picks the **lowest** Max AC Charge Current that still fills
the pack before 07:00, and re-sizes it every 10 minutes. A lower current keeps the
pack cooler and puts less strain on it than charging at a fixed high current and
then sitting full from 01:00.

| Entity | What it is |
| --- | --- |
| `input_boolean.adaptive_night_charge` | the on/off: the adaptive icon (`mdi:tune-variant`) on the dashboard's **AC charge** chip |
| `sensor.adaptive_charge_plan` | what it intends to do, and why |
| `input_number.adaptive_charge_saved_current` | your own current, kept so it can be put back at 07:00 (0 means nothing is saved) |

It drives one firmware entity: `select.powmr_inverter_max_ac_charge_current`
(PI30 `MUCHGC`).

## When it works

The firmware already charges at night. **Auto** puts the inverter on Utility
First, and **Night only** opens the BMS charger. Adaptive only chooses the amps,
so it works only while one of those two is on:

- With both off, the icon on the card is dimmed and a tap on it does nothing.
  Switching it on from the more-info dialog is turned straight back off by the
  `adaptive_charge_guard` automation.
- **It goes off with the charger.** Switching **AC charge** off by hand switches
  adaptive off too, and it can't be switched on while the charger is off. The
  one exception is Night only: then the firmware owns the charger and turns it
  off at 07:00 every morning by design, so a charger that is off under Night
  only doesn't count.
- If Auto and Night only both go off while it is on, the plan reads `inactive`
  and your current is put back. The boolean stays on, because the firmware turns
  one of the two off as the other comes on, and that blip must not cancel
  adaptive.

**An outage schedule switches adaptive off** ([outage-precharge.md](outage-precharge.md)).
When the power company (DTEK) publishes an outage window and the pre-charge plan leaves `idle`
(`waiting_night`, `charging` or `full`), the `adaptive_charge_outage_off`
automation switches adaptive off and sends a phone notification on the
`Adaptive charge` channel. From then on, pre-charge owns the charge current on
its own.

- **It stays off** until you switch it back on after the outage. While a window
  is pending, the icon is dimmed and the guard refuses to switch it on.
- **Switching off hands your current back,** and that is the one moment the two
  could still collide. If a pre-charge is already charging, the drive
  automation holds the hand-back until it ends. A pre-charge counts as running
  while its plan reads `charging`, or until 6 minutes after the firmware's
  `Pre-charge Until` deadline. The firmware puts back the current it saved on
  its next 5-minute check after the deadline, so the hand-back lands after
  that, not under it.

## The plan

`sensor.adaptive_charge_plan` is re-rendered every 10 minutes (:00, :10, :20 …;
23:00 is one of those), whenever the icon, Auto or Night only changes, and when HA
starts. It used to be hourly, which left a step change waiting up to an hour to
reach the select; now it lands within 10 minutes.

| State | Meaning | Chip sub-label |
| --- | --- | --- |
| `off` | the icon is off | — |
| `inactive` | on, but Auto and Night only are both off | — |
| `day` | on, outside 23:00–07:00 | **tonight** |
| `unknown` | no battery reading; the current is left alone | — |
| `full` | the pack is within 1 % of full; `current` is the 2 A trickle | **full** |
| `charging` | `current` amps, re-sized every 10 minutes, until `until` (07:00) | **20 A → 07:00** |

The arithmetic uses the same constants as the pre-charge plan:

```
need     = (280 Ah − capacity_remaining) × 1.15     # CV taper and charger losses
deadline = 06:30                                    # 30 min early, so the taper finishes in the tariff
current  = need ÷ hours to the deadline, rounded up to 2, 10, 20 … 60 A
```

- Between 06:30 and 07:00, the deadline is 07:00 itself.
- With under 15 minutes left, it charges at 60 A.
- The inverter only has 10 A steps (plus 2 A), so the first hours often round
  up. As the pack fills, the next renders bring the current down.
- If charging falls behind (a heavy load ate the charger's budget, or the taper
  came early), the next render, at most 10 minutes later, raises it again.

## Driving the select

The `adaptive_charge_drive` automation writes the select only when the value
differs. It also re-checks every 5 minutes, so an ESP that
rebooted onto its default is corrected within 5 minutes.

- **First write of the night:** your current is saved to
  `input_number.adaptive_charge_saved_current`.
- **Plan becomes `day`, `off` or `inactive`:** the saved current goes back on
  the select, and the saved value is cleared.

If you change the select by hand during the night, the next render (within
10 minutes) overrides it. Your hand-set value still won't be the one restored at 07:00: that
is the value saved at the first write.

Nothing here is a fail-safe, and nothing needs to be. If HA dies at night, the
current stays where it was last set, which is never more than the pack needed.
The firmware still decides when the charger runs.

## Testing

```sh
python tools/test_adaptive_charge.py
```

It renders the real template from the package for each case: the gating (off,
inactive, day, unknown), the sizing at different hours and charge levels, the 2 A
trickle when full, and the 10-minute re-size (the trigger itself, a step drop
10 minutes on, falling behind, the last 15 minutes, inside the buffer).
