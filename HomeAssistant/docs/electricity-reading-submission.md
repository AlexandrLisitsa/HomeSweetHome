# Electricity reading submission

Once a month the phone shows the meter's day and night readings, and one tap
sends them to YASNO through its Telegram bot. Nothing is sent without that tap.

- **What:** the meter's day (T1) and night (T2) registers, in whole kWh.
  YASNO takes "all digits before the comma".
- **Where to:** [@Yasnoonlinebot](https://t.me/Yasnoonlinebot), walked by
  MeterBots ([`MeterBots/docs/yasno-bot.md`](../../MeterBots/docs/yasno-bot.md)).
- **When:** YASNO takes readings in the last 2 days of a month and the first
  3 of the next.
- **Package:** [`config/packages/electricity_submit.yaml`](../config/packages/electricity_submit.yaml)
  and [`config/electricity/electricity_submit.py`](../config/electricity/electricity_submit.py).

## Where T1 and T2 come from

The ElectricityMeter board counts one total, `sensor.electricity_meter_energy`
([`electricity-meter.md`](electricity-meter.md)).
[`electricity_meter.yaml`](../config/packages/electricity_meter.yaml) splits it
twice on the same 07:00 / 23:00 clock:

| Meter | Resets | Used for |
| --- | --- | --- |
| `sensor.electricity_meter_tariff_day` / `_night` | monthly | the Energy dashboard |
| `sensor.electricity_meter_register_day` / `_night` | never | this reading: the meter's own T1 / T2 |

The registers start at 0, so they're set once from the display.

### Calibrating, once

1. Read the zones off the meter's display. The NIK 2102 cycles through:

   | Code | What |
   | --- | --- |
   | `T21` | day (zone 1): the register YASNO calls ДЕНЬ |
   | `T22` | night (zone 2): НІЧ |
   | `T2` | the total since the meter was made: what the board's register is set to |
   | `CH` | the serial number |

2. Right away, set each register to its value: Developer tools → Actions →
   `utility_meter.calibrate` on `sensor.electricity_meter_register_day` with
   `T21`, and on `_night` with `T22`.
3. Check: `T2` − (`T21` + `T22`) is the same before and after. **It isn't 0.**
   The zone registers only started counting when the two-zone tariff was
   switched on, and everything before that is in the total alone. Here it's
   2,279.92 kWh (2026-10-04), and it never changes. So
   `sensor.electricity_meter_energy` − day − night should stay at that figure.

Done on 2026-10-04: day 38335.62, night 6653.39, with the total at 47268.93 on
both the display and the board.

### Checking the clock

The total is exact, but the split between day and night relies on Home
Assistant's 07:00 / 23:00 matching the meter's own clock. A few days after
calibrating, read T1 and T2 off the display again and compare them with the
registers:
- **They match:** the clocks agree.
- **Day runs ahead and night behind by about the same amount:** the meter
  switches zones at a different time. Shift the times in
  `electricity_meter_tariff_switch` to match, then calibrate again.

## The month

| When | What happens |
| --- | --- |
| Last day of the month, 21:00 | `automation.electricity_reading_monthly_ask` runs `script.electricity_submit_ask` |
| 1st–3rd, 21:00 | The same again, until this month's reading has gone in |
| The second-to-last day | Inside YASNO's window too, but not asked; send by hand if needed |

`script.electricity_submit_ask`:
1. Asks `electricity_submit.py prepare` which month the reading is for,
   whether the window is open, and whether it's already been sent.
2. Asks the bot for a dry run (`rest_command.yasno_bot_status`), which returns
   the previous readings and sends nothing.
3. Sends a sticky notification to the phone (`notify.meter_readings`): "Send day D, night N kWh? Last on
   record d / n (date)", with two buttons:

   | Button | Action id | Sends |
   | --- | --- | --- |
   | **Submit** | `ELEC_SUBMIT_<day>_<night>` | the two counted numbers |
   | **Correct & submit** | `ELEC_EDIT_<max day>_<max night>` | what you type, as `DAY NIGHT`. Each value may be at most 300 kWh above what was counted |

   **Submit** is only offered when the registers have values, neither is
   below the previous reading, the bot answered, and the window is open.
   Otherwise the message says what's missing.

`automation.electricity_reading_notification_buttons` handles the buttons and
calls `script.electricity_submit_send`. That script:
1. Checks the window.
2. Calls `rest_command.yasno_bot_submit`.
3. On success, records the month in `/config/electricity/.state.json`, which
   stops the reminders.
4. Answers with ✅ and the bot's reply, or ❌ and the reason plus **Try again**
   (`ELEC_REASK`).

If MeterBots didn't answer at all, the reading may still have gone in, so the
message says to check the chat before trying again.

To ask now, by hand: run `script.electricity_submit_ask` with `force: true`.

## Secrets

In the box's `secrets.yaml` (template:
[`examples/secrets.yaml.example`](../examples/secrets.yaml.example)):

```yaml
yasnobot_token: "<same value as MeterBots' YASNOBOT_TOKEN>"
yasnobot_status_url: "http://<meterbots-ip>:8770/yasno/bot/status"
yasnobot_submit_url: "http://<meterbots-ip>:8770/yasno/bot/submit"
```

## Tests

`tools/test_electricity_submit.py` checks three copies of the same window
rule against each other for every day of 2026–2028: the script's, the send
script's template, and the monthly ask's. It also covers the button handler's
parsing of action ids and typed corrections, and the state file.
`tools/test_tariff_switch.py` covers the clock automation for both splits.
