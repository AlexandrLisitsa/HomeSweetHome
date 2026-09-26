# Air conditioner features

The feature inventory the climate dashboard was designed from. Two air conditioners, one per room.

`tools/check_climate_card.py` reads the **Feature toggles** table under **Bedroom** and fails when the
climate card draws a different set, so a feature added to one and not the other cannot silently
disappear from the grid. **Hidden** and **Not exposed** are the inventory the grid is deliberately
shorter than: *hidden* has a working entity the card does not draw, *not exposed* is something the unit
can do but this installation creates no entity for.

## Hall

Controlled by infrared. The unit cannot report its own state, so every control is 'what we last told it' rather than a confirmed reading. Temperature and humidity come from a separate room sensor. What the unit is actually doing is inferred from its electricity use.

### Controls

| Feature | Type | Options / range | Unit |
| --- | --- | --- | --- |
| Power | toggle | On, Off |  |
| Mode | selector | Cool, Heat, Auto, Fan only, Dry |  |
| Target temperature | slider | 18–30, step 1 | °C |
| Fan speed | selector | Low, Medium, High |  |
| Swing | toggle | On, Off |  |

### Actions

| Feature | Type | Options / range | Unit |
| --- | --- | --- | --- |
| Resend current state | button |  |  |
| Nudge vane one step | button |  |  |
| Force swing toggle | button |  |  |

### Readouts

| Feature | Type | Options / range | Unit |
| --- | --- | --- | --- |
| Room temperature |  |  | °C |
| Room humidity |  |  | % |
| Activity |  | Off, Idle, Cooling, Heating, Drying, Fan |  |
| Running | status |  |  |
| Compressor running | status |  |  |
| State drift warning (see note) | status |  |  |
| Bridge online | status |  |  |
| Power now |  |  | W |
| Average draw today |  |  | W |
| Energy today |  |  | kWh |
| Energy this month |  |  | kWh |
| Cost today |  |  | UAH |
| Cost this month |  |  | UAH |
| Runtime today |  |  | h |
| Compressor hours today |  |  | h |
| Compressor starts today |  |  | count |
| Setpoint delta (see note) |  |  | °C |

**State drift warning.** Raised when the physical remote was used and our picture is stale

**Setpoint delta.** Gap between room temperature and target

### Settings

| Feature | Type | Options / range | Unit |
| --- | --- | --- | --- |
| Electricity tariff | number |  | UAH/kWh |
| Standby power threshold | number |  | W |
| Compressor power threshold | number |  | W |

## Bedroom

Controlled over the local network with full two-way feedback. Every value is a real reading from the unit. Powered through a metered smart plug, so it can be cut off entirely.

### Controls

| Feature | Type | Options / range | Unit |
| --- | --- | --- | --- |
| Power | toggle | On, Off |  |
| Mode | selector | Auto, Cool, Heat, Dry, Fan only |  |
| Target temperature (see note) | slider | 16–30, step 0.5 | °C |
| Fan speed | selector | Silent, Low, Medium, High, Full, Auto |  |
| Fan speed (fine) | slider | 0–100 | % |
| Preset | selector | None, Comfort, Eco, Boost, Sleep, Away |  |
| Swing direction (see note) | selector | Off, Vertical, Horizontal, Both |  |
| Swing vertical | toggle |  |  |
| Swing horizontal | toggle |  |  |

**Target temperature.** The whole 16-30 range is settable in Cool, but not reliably: the same request from the same starting point landed 5 times out of 8, and a miss either leaves the old setpoint or overshoots by a degree. There is no unreachable value and no floor above 16.0 -- both 16.0 and 16.5 land sometimes and fail sometimes. The unit also wanders on its way to a setpoint -- asked for 16.5 from 17.0 the entity reported 17.5 after one second, 16.5 three seconds later, and 17.5 again sixteen seconds after that -- and has been seen to creep back up on its own minutes later. Nothing in Home Assistant writes this entity; the logbook shows only the card's own calls. The card ignores the values passed through, re-sends a setpoint once, and then says on the tab that it did not take. In Fan only the unit ignores set_temperature completely, keeping its setpoint and answering nothing, though min_temp still reads 16.0 and supported_features still claims TARGET_TEMPERATURE; the card freezes the dial and the steps there. Dry, Heat and Auto were not measured.

**Swing direction.** All four work. Asking for Horizontal also switches Frost protect on: the switch entity flips and the unit shows FP on its front panel for about fifteen seconds before clearing itself. Measured every two seconds against the live unit -- Horizontal did it in two runs of three, Both in one of two, Off and Vertical never. All four are offered; the card watches its own swing command for 25s and switches Frost protect back off if it comes on, unless it was already on before the command.

### Feature toggles

| Feature |
| --- |
| Boost mode |
| Eco mode |
| Sleep mode |
| Dry |
| Frost protect |
| Self clean |
| Ionizer |
| Screen display |
| Screen display alternate |
| Prompt tone |

### Hidden

| Feature | Why |
| --- | --- |
| Aux heating | Works; taken off the card's grid because nobody reaches for it on this unit. |
| Comfort mode | Works; taken off the card's grid because nobody reaches for it on this unit. |
| Sound | Works; taken off the card's grid because nobody reaches for it on this unit. |

### Not exposed

| Feature | Why |
| --- | --- |
| Fresh air | Supported by the unit, switched off in this installation, so midea_ac_lan creates no entity for it. Kept here as inventory; the card draws only toggles that can be pressed. |

### Readouts

| Feature | Type | Options / range | Unit |
| --- | --- | --- | --- |
| Indoor temperature |  |  | °C |
| Indoor humidity |  |  | % |
| Outdoor temperature |  |  | °C |
| Compressor frequency |  |  | Hz |
| Indoor fan speed |  |  | rpm |
| Error code |  |  |  |
| Indoor ambient temperature |  |  | °C |
| Indoor coil temperature |  |  | °C |
| Outdoor coil temperature |  |  | °C |
| Outdoor ambient temperature |  |  | °C |
| Discharge pipe temperature |  |  | °C |

### Power plug

| Feature | Type | Options / range | Unit |
| --- | --- | --- | --- |
| Plug power | toggle | On, Off |  |
| Power draw |  |  | W |
| Current |  |  | A |
| Voltage |  |  | V |
| Total energy |  |  | kWh |
| Child lock | toggle |  |  |
| Countdown timer | number |  | s |
| Power outage memory | selector | Restore, On, Off |  |
| Indicator mode | selector | Off, On, Position, Status |  |
