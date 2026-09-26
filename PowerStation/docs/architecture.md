# PowerStation — How it works

This document explains what `power-station.yaml` does in plain language: the decisions it makes, the rules it follows, the numbers in the code, and why they are what they are. Read it before changing anything non-cosmetic in the YAML.

---

## 1. What this firmware is

An ESP32 sitting between three things:

```
        ┌──────────────┐
        │ Home Assist. │
        └──────▲───────┘
               │ WiFi + ESPHome API
               │
        ┌──────┴───────┐
        │    ESP32     │
        ├──────────────┤
   UART │   2400 baud  │ BLE
   ┌────┴──────┐ ┌─────┴──────┐
   │ PowMr     │ │ JK BMS     │
   │ Inverter  │ │ (LiFePO4)  │
   └───────────┘ └────────────┘
```

The ESP does three jobs:

1. **Speaks to the inverter** over UART using the PI30 protocol — reads live state (`QPIGS`) and sends control commands (priority mode, charge current, charge voltages).
2. **Reads the battery** over Bluetooth Low Energy using the [`syssi/esphome-jk-bms`](https://github.com/syssi/esphome-jk-bms) external component (JK02_32S protocol).
3. **Decides what mode the inverter should be in** based on grid health, time-of-day tariff, and user toggles — then exposes everything to Home Assistant. Two independent scripts do this: `evaluate_power_mode` (§3) picks the power priority, and `evaluate_charge_window` (§10) decides whether the battery may charge.

It is designed to keep running with no internet and no Home Assistant. WiFi loss and HA disconnect both have `reboot_timeout: 0s` — the ESP never reboots itself for connectivity. The decision logic is local.

---

## 2. Hardware wiring

| Component | Connection | Details |
| --- | --- | --- |
| Inverter UART | `GPIO17` TX, `GPIO16` RX | 2400 baud, 1024-byte RX buffer |
| JK BMS | BLE | MAC from `secrets.yaml` (`bms_mac_address`), scan interval 1100 ms |
| Board | `esp32dev` | Arduino framework |

The BMS MAC comes from `secrets.yaml`. Replacing the battery means changing `bms_mac_address`.

The battery is **8S** (8 cells in series, ~25.6 V nominal). The YAML reads `cell_voltage_1` through `cell_voltage_8`. Despite an inline comment saying "16 cells", only 8 are exposed.

---

## 3. The logic brain — `evaluate_power_mode`

The single ESPHome `script` named `evaluate_power_mode` decides the inverter's **power priority**. It runs whenever the world changes:

**Triggers:**
- Boot (after grid voltage is available, and after NTP either syncs or times out — see §7)
- Start of the day tariff (07:00 by default — §8)
- Start of the night tariff (23:00 by default — §8)
- Grid fault detected (after 5 s of bad voltage)
- Grid normalized (after 5 min of good voltage)
- User toggles `Auto Grid Protection`
- User toggles `Auto Tariff Mode`

Boot and the two tariff boundaries also run `evaluate_charge_window` (§10). The two scripts are independent: neither reads the other's state, and this one never touches the charger.

`mode: restart` means a new run cancels any in-progress run — the latest signal wins.

### Decision rules, in priority order

The script picks one of these three target modes — **Utility First**, **Solar First** (unused by automation), or **SBU Battery** — by walking this if/else chain top to bottom.

| # | Condition | Action | Why |
| --- | --- | --- | --- |
| 1 | `Auto Grid Protection` ON **and** grid is bad | Force **SBU Battery** | Protect loads from a sick grid. Bypasses NTP entirely — works during a complete network outage. |
| 2 | (else) `Auto Tariff Mode` ON, NTP failed | **Utility First** | Without trustworthy time we can't know the tariff window, so play it safe by using the grid. |
| 3 | (else) `Auto Tariff Mode` ON, night (23:00 ≤ hour < 07:00) | **Utility First** | Night electricity is cheap — use the grid, save the battery. |
| 4 | (else) `Auto Tariff Mode` ON, day (07:00 ≤ hour < 23:00) | **SBU Battery** | Day electricity is expensive — discharge the battery (and solar, when present). |
| 5 | (else) `Auto Grid Protection` ON, grid OK, tariff OFF | **Utility First** | Plain "use the grid unless it goes bad" mode. |
| 6 | (else) both switches OFF | **no change** | Full manual control. The script doesn't touch the priority. |

### Quirk worth knowing

`Auto Tariff Mode` and `Night Charging Only` (§10) are mutually exclusive — turning either one on turns the other off — so rules 2–4 and the charge gate can never both be active.

Rule 1 requires **both** `Auto Grid Protection` ON *and* grid bad. If protection is OFF and the grid is bad, the tariff rules still run as if the grid were healthy — the script will happily pick Utility First at night even on a sick grid. This is intentional: grid protection is the *only* switch that overrides tariff logic. If you want tariff behavior to also yield to bad grid, you'd need to add that check.

### How the command actually reaches the inverter

The script only updates the Home Assistant-facing `select` entity (`select_power_priority`). The `on_value` handler on that select pushes the corresponding PI30 command (`POP00`/`POP01`/`POP02`) onto the queue. The UART loop (§6) then sends it.

Exception: rule 1 also pushes `POP02` directly onto the queue, in addition to flipping the select. This is belt-and-suspenders for emergency mode.

---

## 4. Grid health detection

The `grid_safe` binary sensor (despite the name, **true means UNSAFE**) decides whether the grid is bad.

```
unsafe := grid_voltage ≤ 185 V  OR  grid_voltage ≥ 250 V
```

### Why 185–250 V

Ukrainian residential standard is 230 V ±10% (207–253 V). The chosen bounds are stricter on the low end (185 V vs 207 V) to account for measurement noise and brownouts, and slightly stricter on the high end (250 V) to trip before sensitive electronics see anything above 250 V.

### Why the asymmetric hysteresis

```yaml
filters:
  - delayed_on: 5s     # bad → declared bad after 5 s
  - delayed_off: 300s  # good → declared good after 5 min
```

- **5 s on**: the UART polls every 3 s, so 5 s is roughly two clean polls. Filters out single corrupt packets that survive the EMI sanity check.
- **300 s off**: brownouts can pulse — voltage drops, recovers for 10 s, drops again. Switching back to Utility prematurely would slam the inverter through repeated mode changes. Five minutes of stable grid is required before trusting it.

The 300 s wait is invisible from outside the filter, so a second, unfiltered sensor — `Grid Voltage In Range` — publishes the raw bounds check. While it is ON and `Grid Condition Safe` is still ON (unsafe), the delay is running, and its `last_changed` is when it started; the dashboard counts down from that. The power logic never reads it.

### Why `trigger_on_initial_state: true` is mandatory here

ESPHome suppresses an entity's state callbacks for its **first** published state unless this is set — `entity_base.h` fires them only `if (trigger_on_initial_state_ || had_state)`, and the option defaults to false. `on_press` / `on_release` are wired to exactly those callbacks.

The filters above turn that into the normal case rather than an edge case. Nothing is published until 5 s after the grid first goes bad, or 300 s after it is first seen healthy — so the first transition after **any** reboot is the initial state, and without this option it is silently swallowed. Rule 1 is then never reached and grid protection sits dormant while the grid is out of range. This was observed on the device: 45 s continuously above 250 V produced no fault trigger at all.

A ~5 s window still remains at boot, because `on_boot` runs `evaluate_power_mode` before `delayed_on` has elapsed, so `grid_safe.state` is still its default `false`. The fault trigger corrects the decision a few seconds later. If that matters, rule 1 could fall back to the raw `sns_grid_v` reading when `!id(grid_safe).has_state()`.

---

## 5. The PI30 command set

The PowMr inverter speaks a Voltronic-derived ASCII protocol called **PI30**. Each message is `<ASCII command><CRC-16 high><CRC-16 low><\r>`. Replies are wrapped in parentheses, e.g. `(QPIGS reply data here\r)`.

### Commands used here

| Command | Meaning | Sent by |
| --- | --- | --- |
| `QPIGS` | Query general status — returns grid V, freq, output V, output power, batt V, load %, charge A, discharge A, etc. | UART idle loop (every 3 s) |
| `POP00` | Set output priority: **Utility First** | `select_power_priority` on_value, plus emergency rule 1 |
| `POP01` | Set output priority: **Solar First** | `select_power_priority` on_value (manual only) |
| `POP02` | Set output priority: **SBU Battery** | `select_power_priority` on_value, plus emergency rule 1 |
| `MUCHGC<NNN>` | Set max AC charge current, 3-digit padded (e.g. `MUCHGC010` = 10 A) | `select_max_charge` on_value |
| `PCVV<XX.XX>` | Set CV/bulk voltage | `num_bulk_voltage` on_value |
| `PBFT<XX.XX>` | Set float voltage | `num_float_voltage` on_value |
| `PGR00` / `PGR01` | Set AC input voltage range: Appliance (`PGR00`, ~90–280 V) / UPS (`PGR01`, ~170–280 V) | `select_inverter_mode` on_value |

### CRC byte substitution

PI30's CRC-16 (XMODEM polynomial 0x1021) can produce bytes that collide with framing characters. The code substitutes them:

```
if (crc_byte == 0x28 || crc_byte == 0x0D || crc_byte == 0x0A) crc_byte++;
```

- `0x28` = `(` — start-of-reply
- `0x0D` = `\r` — end-of-message
- `0x0A` = `\n`

Without this, a CRC byte could prematurely terminate or open a frame.

### Reply parsing

`QPIGS` returns space-separated fields inside parentheses. We use **positional** indices — the inverter firmware revision determines field count, and we silently drop replies with fewer than 16 fields:

| Index | Field | Sensor ID |
| --- | --- | --- |
| 0 | Grid voltage (V) | `sns_grid_v` |
| 1 | Grid frequency (Hz) | `sns_grid_f` |
| 2 | Output voltage (V) | `sns_out_v` |
| 5 | Output power (W) | `sns_watt` |
| 6 | Load percentage (%) | `sns_load_pct` |
| 8 | Battery voltage (V) | `sns_batt_v` |
| 9 | Battery charge current (A) | `sns_batt_charge_a` |
| 15 | Battery discharge current (A) | `sns_batt_discharge_a` |

### EMI sanity check

UART at 2400 baud near a high-current inverter picks up noise. Replies that pass framing but contain impossible values are dropped:

```
batt_v < 10.0      → drop  (8S LiFePO4 never goes below ~20 V even discharged)
watt   > 15000     → drop  (way above inverter rating)
grid_v > 300       → drop  (grid spike beyond hardware tolerance)
out_v  > 300       → drop  (same)
```

Dropped frames log a warning (`Ignored corrupted frame (EMI spike detected)`) and the next poll cycle replaces them.

---

## 6. The command queue

UART is half-duplex and the inverter responds slowly. Commands are queued and sent one at a time:

- **Queue**: `std::vector<std::string>` (used as a FIFO).
- **Retries**: each command gets up to 20 attempts. At 3 s per attempt, that's a 60 s window before giving up.
- **Idle behavior**: when the queue is empty, the 3 s loop sends `QPIGS` to refresh sensor data.

### Send loop (every 3 s)

```
if queue not empty:
  if retries > 0:
    send queue.front(); decrement retries
  else:
    log error; pop queue.front(); reset retries to 20 for next command
else:
  send QPIGS
```

### Reply loop (every 50 ms)

Reads incoming bytes into a buffer until `\r`. Then:

1. If the buffer contains `(ACK` — command accepted. Pop the queue. Reset retries for the next command (or to 0 if queue is now empty).
2. If the buffer contains `(NAK` — command rejected. **Don't pop.** The send loop retries on the next tick.
3. Otherwise, assume it's QPIGS data. Parse and publish (subject to the §5 sanity check).
4. Buffer length capped at 200 bytes — overflow drops the frame as corrupt.

### Why 20 retries

Empirically: the inverter occasionally NAKs valid commands during heavy load. 20 retries (~60 s) covers transient busy states. Anything that fails 20 times in a row is genuinely broken — log and move on rather than block the queue forever.

---

## 7. Boot sequence

The `on_boot` handler (priority `-10`, runs late) performs two sequential waits:

```yaml
# Step 1 — wait indefinitely for the first clean QPIGS reply
wait_until:
  condition:
    lambda: 'return id(sns_grid_v).has_state();'

# Step 2 — wait up to 2 minutes for NTP
wait_until:
  condition:
    lambda: 'return id(sntp_time).now().is_valid();'
  timeout: 2min
```

**Why two separate waits:**

- **Grid voltage** (step 1) is unbounded. Without a clean inverter reading, `grid_is_bad` is unknowable and no safety decision can be made. This wait cannot have a timeout.
- **NTP time** (step 2) gets a 2-minute window. If the internet is down and NTP never syncs, execution continues anyway. The `evaluate_power_mode` script handles this via rule 2 (falls back to Utility First when `!time.is_valid()`). Grid protection (rule 1) never needed time — it activates immediately regardless of NTP state.

**The critical failure this prevents:** if the grid goes bad and the ESP32 reboots during a network outage (a likely scenario — power cuts often take the router with them), the old single `wait_until` with both conditions would stall forever, preventing emergency grid protection from ever activating. The 2-minute timeout bounds that window.

---

## 8. Tariff times

Two-zone Ukrainian residential tariff schedule:

| Window | Hours | Tariff |
| --- | --- | --- |
| Day | 07:00 – 22:59 | Expensive |
| Night | 23:00 – 06:59 | Cheap |

The boundaries live in exactly one place — the `substitutions:` block at the top of the YAML:

```yaml
substitutions:
  night_tariff_start: "23"
  night_tariff_end: "7"
```

The two `on_time` triggers and the `is_night` expression in *both* logic scripts are written in terms of those values:

```cpp
bool is_night = (time.hour >= ${night_tariff_start} || time.hour < ${night_tariff_end});
```

So shifting the window is a one-line edit, and the two scripts cannot drift apart on where the night starts.

Two cron-like time triggers (`on_time`) fire the logic at the boundaries. Between boundaries `evaluate_power_mode` is only re-evaluated on other events (grid changes, user toggles). That's fine — within a tariff window the answer doesn't change. `evaluate_charge_window` additionally re-runs every 5 minutes; §10 explains why it can't rely on the boundaries alone.

---

## 9. Charge voltages

Two `number` entities set the charge targets directly. They are the user's charge profile — nothing in the automation writes to them.

| Entity | Command | Default | Range |
| --- | --- | --- | --- |
| Bulk Charge Voltage (`num_bulk_voltage`) | `PCVV<XX.XX>` | 28.0 V | 24.0 – 29.0 V |
| Float Charge Voltage (`num_float_voltage`) | `PBFT<XX.XX>` | 27.2 V | 24.0 – 28.5 V |

The defaults sit above the resting voltage of a full 8S LiFePO4 pack (~26.8 V), which is what lets the inverter push current into it.

**The inverter rejects any configuration where float > bulk.** Such a command NAKs, retries 20 times, and is then dropped (§6). The two entities are independent sliders, so the order you move them in is the order the commands queue: when lowering both, lower float first; when raising both, raise bulk first. A `PCVV`/`PBFT` command that dies after 20 retries is almost always this.

> **Historical note.** A `switch_ac_charging` template switch used to drive this pair as an on/off control for charging — dropping both to 25.00 V (below the pack's resting voltage, so the inverter never injects current) and restoring 28.0/27.2 V to re-enable. It was removed in favour of the two `number` entities. Charging is now gated at the BMS instead (§10). This is why 25.00 V appears in the git history and in nothing else.

---

## 10. Night charging only — `evaluate_charge_window`

The second logic script. Where `evaluate_power_mode` decides *which source runs the house*, this one decides *whether the battery is allowed to charge* — and nothing else. It never touches `select_power_priority`.

**What the mode is for.** With `Night Charging Only` ON and `Auto Grid Protection` ON, rule 5 (§3) keeps the inverter on Utility First all day: the grid runs the house and the battery is never spent for savings, while the charger is opened only during the cheap night window. The battery ends up acting as a UPS that only ever buys electricity at the night rate. That is the opposite trade from `Auto Tariff Mode`, which spends the battery every day to dodge day-rate consumption — which is why the two are mutually exclusive.

**The lever.** The gate is the JK BMS charge MOSFET — the `jk_bms_ble` `charging:` switch, exposed to HA as "AC Charging Enabled" (holding register `0x1D`, written over BLE). The inverter has no PI30 "charger off" command, so this is a hard cutoff at the battery rather than a charge-voltage trick.

### The rules

| Condition | Action |
| --- | --- |
| `Night Charging Only` OFF | **Nothing.** The BMS charging switch belongs to the user; the script returns immediately. |
| ON, NTP time invalid | **Allow charging** (fail open) and log a warning. |
| ON, inside the night window | **Allow charging.** |
| ON, inside the day window | **Block charging.** |

**Why fail open on invalid time.** Blocking the charger against a clock we don't trust could leave the pack stranded empty, which is a hazard; buying a few hours at the day rate is only money. This mirrors rule 2 in §3, which also picks the battery-preserving option when the time is unknowable.

**Consequence worth knowing: there is no recovery charging.** A daytime grid outage will drain the pack (rule 1 switches to SBU Battery, and the house runs off the battery), and the charger stays shut until the night window opens — so the battery can sit depleted for the rest of the day, with no reserve if the grid fails again. That is what "charge only at night" means, not a bug. If you want an immediate top-up, switch the mode off until the pack is full.

### Mutual exclusion

`Auto Tariff Mode` and `Night Charging Only` each turn the other off in their `on_turn_on` handler, wrapped in a `switch.is_on` condition. There is no cycle: an `on_turn_on` handler only ever turns the *other* switch off, and no `on_turn_off` handler turns anything on.

The `switch.is_on` guards are belt-and-braces rather than strictly required. `on_turn_on`/`on_turn_off` are `SwitchTurnOnTrigger`/`SwitchTurnOffTrigger`, which hook `add_on_state_callback` and therefore fire from `Switch::publish_state` — and that drops repeated values through `publish_dedup_`, so turning off an already-off switch fires nothing anyway. The guards just make the intent explicit instead of resting on dedup behaviour.

Because those triggers run from `publish_state`, which assigns `this->state` *before* calling the state callbacks, a script executed straight from a handler already reads the switch's **new** state. No deferral is needed.

Turning `Night Charging Only` on does **not** re-evaluate the power priority itself. If the exclusion fired, `Auto Tariff Mode`'s own `on_turn_off` does that; if it did not fire, the priority is deliberately left exactly where it was.

### Ownership of the charging switch

While the mode is engaged it **owns** "AC Charging Enabled" and re-asserts it every 5 minutes — so a manual flip in Home Assistant is undone within 5 minutes. To charge during the day, turn the mode off.

When the mode is switched off, the charger is released **on** once and then left alone — otherwise a mode turned off during the day would leave charging silently blocked. That one-shot release is gated on the `restore_replay_done` global, because ESPHome replays every switch's restored state during setup: `TemplateSwitch::setup` calls `turn_off()`, and the resulting `publish_state(false)` is the switch's first, so it passes the deduplicator and fires `on_turn_off` for real. Without the guard, *every reboot* would force the BMS charge MOSFET on and quietly override a deliberate manual "charging off". The flag is set as the first action of `on_boot`, which runs at priority -10 — after every component has been set up, so the replay is guaranteed to be over, and before the boot waits in §7, so a silent inverter can't leave the flag stuck false.

A user who had charging deliberately off before engaging the mode will therefore find it on afterwards. That is the accepted cost of not tracking prior state.

### Why the 5-minute re-assertion

The BLE write is `esp_ble_gattc_write_char` with `ESP_GATT_WRITE_TYPE_NO_RSP` — fire and forget. Two things can go wrong, and the interval covers both:

- **The write fails outright** (BLE disconnected). `JkSwitch::write_state` only calls `publish_state` when `write_register` returns true, so the switch keeps its old state — the script sees the mismatch on the next tick and retries.
- **The write is queued but the BMS never applies it.** The component republishes the charging switch from the polled settings frame (`jk_bms_ble.cpp`, `data[118]`), reverting the switch to the BMS's actual setting — again producing a mismatch the next tick fixes.

Without the interval, a write lost at a tariff boundary would persist for up to 12 hours, because the boundaries only fire twice a day. The script is a no-op whenever the charger already agrees with the window, so it costs nothing when idle.

---

## 11. The Calculated Grid Real Power sensor

The inverter doesn't directly report how much power it's pulling from the grid. We infer it from other facts. The lambda for `sns_grid_real_power` runs every 3 s and walks three rules:

1. **No grid present** (`grid_v < 150 V`) → grid power = **0 W**. Self-evident.
2. **Inverter is in SBU mode** (charge current = 0 A AND BMS power is negative beyond −2 W) → grid relay is open, grid power = **0 W**.
3. **Otherwise** (bypass/Utility mode):
   ```
   grid_power = load + 30 W              (load + inverter self-consumption)
   if BMS is charging (bms_power > 0):
     grid_power += bms_power             (charging power comes from grid too)
   ```

The 30 W is the empirically-measured idle draw of the inverter's control board.

A second sensor (`Grid Real Energy Consumption`) integrates this with the ESPHome `integration` platform → kWh, marked as `total_increasing` so HA's Energy Dashboard sees it correctly.

---

## 12. Home Assistant interface

### Sensors exposed (read-only)

**Inverter:** Grid V, Grid Hz, AC Output V, AC Output Power, Battery Voltage (inverter-side), Load %, Battery Charge Current, Battery Discharge Current, Total Energy Consumption (kWh), Grid Real Power (W, calculated), Grid Real Energy Consumption (kWh, integrated), ESP Uptime, Total Uptime.

`ESP Uptime` resets to zero on every boot. `Total Uptime` (days) is the lifetime figure: a `60s` interval adds the elapsed delta to the `total_uptime_sec` global, which has `restore_value: true` and so survives reboots and OTA updates. Two details make that cheap and accurate:

- **NVS wear.** `RestoringGlobalsComponent` compares against the last saved value and writes only on change, and its `update_interval` controls how often that check runs. Setting it to `5min` means one small NVS write per five minutes rather than one per tick. It also saves from `on_shutdown()`, so a clean reboot or an OTA flash persists the exact value; only a hard power cut loses time, and at most five minutes of it.
- **Rollover.** The delta is taken in raw milliseconds. `millis()` wraps at exactly 2^32, so unsigned subtraction stays correct across the ~49.7-day rollover. Dividing before subtracting (`millis()/1000`) would wrap at 4,294,967 instead and produce a garbage delta once every 49.7 days. The sub-second remainder is carried between ticks so the total doesn't creep low.

**BMS:** Total Voltage, Current, Power, SOC, Capacity Remaining, Temp 1, Temp 2, Min/Max/Delta Cell Voltage, Cell 1–8 individual voltages.

### Controls exposed (writable)

| Entity | Type | Effect |
| --- | --- | --- |
| Power Priority | select | `Utility First` / `Solar First` / `SBU Battery` — sends `POP00`/`01`/`02` |
| Inverter AC Input Mode | select | `APL` / `UPS` — sends `PGR00`/`PGR01` (AC input voltage tolerance window) |
| Max AC Charge Current | select | `02`/`10`/`20`/`30`/`40`/`50`/`60` A — sends `MUCHGC` |
| Bulk Charge Voltage | number | Sends `PCVV` (§9) |
| Float Charge Voltage | number | Sends `PBFT` (§9) |
| Auto Grid Protection | switch | Master switch for emergency rule 1 |
| Auto Tariff Mode | switch | Master switch for tariff rules 2–4. Mutually exclusive with `Night Charging Only` |
| Night Charging Only | switch | Gates battery charging to the night window and leaves the power priority alone (§10). Mutually exclusive with `Auto Tariff Mode` |
| AC Charging Enabled | switch | The JK BMS charge MOSFET (register `0x1D`) — *not* an inverter setting, despite the name. Owned by the charge gate while `Night Charging Only` is on (§10) |
| BMS Discharging Switch / BMS Balancer Switch | switches | Forwarded directly to the JK BMS via BLE |

All `select` and `switch` entities use `optimistic: true` and `restore_value`/`restore_mode` so they survive reboots without waiting for HA round-trips.

---

## 13. Failure modes — what the firmware does under stress

| What goes wrong | What happens |
| --- | --- |
| WiFi drops | ESP keeps running. Sensors keep updating locally. Decision logic keeps making decisions. HA reconnects when WiFi comes back. |
| Home Assistant offline | Same as above — HA is a consumer, not a controller. |
| Internet (NTP) drops mid-day | Tariff rule 2 fires: fall back to **Utility First**. The charge gate fails open and allows charging (§10). Grid protection (rule 1) still works because it doesn't need time. |
| Internet (NTP) drops at boot | Boot proceeds after the 2-minute wait (§7). `evaluate_power_mode` falls back to **Utility First**; `evaluate_charge_window` fails open and allows charging. |
| Inverter UART silent | All inverter sensors stay in "unknown" state. Decision logic refuses to run because `sns_grid_v.has_state()` is false (the very first guard in the script). |
| Inverter NAKs a command | Retried up to 20 times. If still NAK, dropped with an error log. Next command in the queue gets its own 20-retry budget. |
| BMS BLE link drops | BMS sensors go stale, and `sns_grid_real_power` returns `NAN` while BMS power is unavailable. `evaluate_power_mode` is unaffected — it reads no BMS data. The night-charging gate **is** affected: the charge MOSFET cannot be written, so the 5-minute re-assertion keeps retrying until BLE returns (§10). Inverter control over UART continues throughout. |
| Grid voltage spike (EMI noise on UART) | Sanity check drops the frame, warning logged. Next poll cycle (3 s) replaces it. |
| Grid genuinely bad | `grid_safe` flips after 5 s of bad voltage → if protection is on, inverter switches to SBU Battery. Stays there until grid is stable for 5 minutes. |

---

## 14. Things to know before changing the YAML

- **Don't change either logic script to `mode: queued` or `parallel`.** Both are `restart` because events can fire faster than a script completes, and you want the most recent signal to win.
- **The tariff window lives in `substitutions:`** (§8). Change `night_tariff_start` / `night_tariff_end` in one place — the `on_time` triggers and both scripts follow. Don't re-hardcode 23 or 7.
- **Know which switch trigger you are using.** `on_turn_on:` / `on_turn_off:` are `SwitchTurnOnTrigger` / `SwitchTurnOffTrigger`: they hook `add_on_state_callback`, so they fire from `publish_state` *after* `state` is assigned, and repeated writes are deduplicated. The template switch's `turn_on_action:` / `turn_off_action:` are different — those fire from `write_state`, *before* the state is updated. This config uses only the former, which is why handlers can read their own switch's state directly.
- **Don't add real credentials.** WiFi password, OTA password, and the API encryption key live in `secrets.yaml` (gitignored). Use `!secret <name>`.
- **The `select_power_priority` on_value handler is the single source of truth for sending POP commands.** Rule 1 in the logic brain queues `POP02` directly, but it also flips the select — which queues it *again*. This is intentional redundancy, not a bug. If you remove one, keep the other.
- **The UART CRC table is byte-for-byte the PI30 spec.** Don't optimize it.
- **The 8S configuration is wired in via `cell_voltage_1` through `cell_voltage_8`.** If you swap to a 16S battery, add entries 9–16.
- **Validate before flashing:** `docker compose run --rm esphome config power-station.yaml`. The build is fast but the device is across the room — catch typos in YAML first.