# Load shedding

During a grid outage the house runs on a 280 Ah pack. With an air conditioner
running, that lasts about 7 h; at idle, a day and a half. Load shedding steps
devices down one by one as the battery drains: it switches them off, dims them,
raises a setpoint, or does anything else they support. It does this in the order
and at the percentages you set, warns you one step ahead, and puts everything
back when the grid returns.

The rules are built on the **Load shedding** tab of the Shutdowns dashboard,
which works as a constructor. Nothing about the devices is hard-coded.

| File | What it holds |
| --- | --- |
| `config/packages/load_shedding.yaml` | the engine: two stores, the scripts, and four automations |
| `config/www/load-shedding-card.js` | the constructor, in four blocks: `hero`, `upcoming`, `rules`, `backup` |
| `dashboards/lovelace.dashboard_dtek.json` | the tab: a `sections` view laid out like the Shutdowns tab |
| `tools/test_load_shedding.py` | renders the engine's templates against fake states |

## Only during an outage

The battery level alone doesn't mean there's an outage. By day, Auto Tariff mode
runs the house off the pack on purpose
([PowerStation architecture, rule 4](../../PowerStation/docs/architecture.md#3-the-logic-brain--evaluate_power_mode)).
So nothing happens unless the inverter itself reports the grid as unsafe
(`binary_sensor.powmr_inverter_grid_condition_safe` is `on`). That includes a
brownout, because the inverter is on battery then too. The master switch is
`input_boolean.load_shedding_enabled`, the toggle in the hero.

## The rules

```json
{
  "override_step": 10,
  "warn_margin": 1,
  "devices": [
    { "id": "hall_ac", "name": "Hall A/C", "entity": "climate.daewoo_a_c", "enabled": true,
      "guard": { "plug": "switch.0x70b3d52b600fddcb", "running": "binary_sensor.a_c_running",
                 "online": "binary_sensor.ir_bridge_online" },
      "steps": [
        { "soc": 80, "action": "climate.adjust_temperature", "data": { "by": 3 } },
        { "soc": 60, "action": "climate.set_hvac_mode", "data": { "hvac_mode": "off" } } ] }
  ]
}
```

- **Device:** any entity whose domain has actions: climate, light, switch, fan,
  cover, media player, and so on. The **+ Add device** list searches them all.
- **Step:** "at N % battery, do this action". The action is any service of the
  device's own domain, and the panel draws its fields from Home Assistant's own
  service descriptions:
  - a choice of the device's own modes (`hvac_modes`, `fan_modes`, `effect_list`, …)
  - a number with its range and unit
  - a checkbox
  - text, or JSON for anything else

  Only the fields the device supports are shown. **more fields** reveals the
  advanced ones.
- **`climate.adjust_temperature`** (shown as "Change temperature by") is the one
  extra. It sets the setpoint to what it was *before the first step* plus `by`,
  so "+3°" never stacks.
- **The deepest step reached wins.** At 70 % the device above is 3° warmer, and
  at 60 % it's off. If an outage starts at 55 %, it goes straight to off.
  Devices go in the order of their first step.
- **A device that is off is left alone,** so it isn't "restored" into running
  when the grid comes back.

Rules live in `sensor.load_shedding_config`, a trigger-based template sensor
that HA restores across restarts. The panel writes them only through
`script.load_shedding_save_config`. That script checks them and answers
`{ok, errors}`; the panel shows the errors and keeps your draft:
- steps need a battery % of 1–100;
- one device can't have two steps at the same %;
- actions must be of the device's own domain;
- ids must be unique.

Edits happen on a draft. Nothing reaches HA until **Save**.

## Making sure it's really off: the guard

This is optional, per device, for a device whose "off" might not arrive. The hall A/C is
infrared and write-only. After a step that switches the device off, the plug is
cut in either of two cases:
- `running` still says on 90 s later;
- `online` (the IR bridge) is down.

When the grid returns, the plug comes back on first, then the device.

## Warned one step ahead, and holding a device

When an armed device is within `warn_margin` % of its next step, the phones get
one notification for that step (`notify.household`, *Load shedding* channel).
With the default 1 %, a step at 50 % warns at 51 %. The notification has a
**Keep it on** button.

The **Coming up** table on the tab shows every armed device's next step, how far
away it is, and highlights those inside the margin. It has three buttons:

| Button | When | What it does |
| --- | --- | --- |
| **Keep on** | before a step | holds the device: its steps wait until the battery has fallen `override_step` further |
| **Put back** | after a step | restores the device the way it was, then holds it the same way |
| **Release** | while held | ends the hold, so the deepest step reached applies at the next evaluation |

The buttons work only during an outage. The phone button and the table call the
same `script.load_shedding_hold`.

## Overrides

Thirty seconds after a step, the device's state is recorded as `applied`. If,
more than 3 minutes after the step, the device no longer looks like that, it's
an override: you put the setpoint back, raised the lamp, or switched it on.
Numbers get a tolerance: brightness ±3, temperature ±0.5, percentage ±2. An
override wins until the battery has fallen `override_step` further. Then the
deepest step reached is applied again. A hold from the table is the same thing,
placed in advance.

## When the grid returns

The trigger is the grid sensor's unsafe → safe edge, which already includes the
firmware's 5 minutes of stable voltage. Every device the system changed, and
you didn't override or hold, is put back with `scene.apply` from the snapshot
taken before its first step. That is Home Assistant's own reproduce-state, so it
restores any domain correctly. The same check runs when HA starts, so an outage
that ended while HA was down is still cleaned up. One message lists what was put
back.

## Backup

The rules aren't in git, because the panel edits them in HA. **Settings and
backup** has:
- **Export:** show, copy or download the JSON.
- **Import:** paste JSON into the editor as unsaved changes, then **Save**.

`script.load_shedding_seed` writes the starting rules again. The
`load_shedding_seed_when_empty` automation runs it at HA start when there are
no rules at all.

## Bookkeeping

`sensor.load_shedding`, fed by the `load_shedding_set` event:
- **`loads` attribute:** `id → {entity, name, since, soc, step_soc, snapshot,
  applied, plug, plug_cut, override_soc}`. A hold placed before any step has no
  snapshot and a null `step_soc`.
- **`warned` attribute:** the `id@soc` warnings already sent this outage.

Both are wiped when the grid returns. The wipe field is `reset`, not `clear`:
in Jinja, `d.clear` resolves to the dict's own `.clear` method before the key.

## Not built yet: DTEK-aware shedding

During a scheduled outage, `sensor.dtek_next_outage_end` says when the power
comes back. If `sensor.battery_runtime_remaining` already covers that with
margin, a step could be skipped. This is worth adding once DTEK publishes
schedules again ([dtek-outage-schedule.md](dtek-outage-schedule.md)).
