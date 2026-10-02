# Testing the firmware logic

The decision logic in `power-station.yaml` is C++ inside YAML lambdas. It can't
be tested on the ESP itself, and a hand-written copy would drift from what is
flashed. So the harness pulls the lambdas out of the YAML on every run and
compiles them on the host against small fakes of the ESPHome objects they use.

## Running it

From the repository root:

```sh
python PowerStation/tools/test_firmware_logic.py
```

The script needs Python 3 with PyYAML, plus either a native `g++` (Linux/macOS)
or Docker. On Windows it always uses the `gcc:13` image. Start Docker Desktop
first. The first run pulls the image, and later runs take a few seconds. The
script never touches the device, Home Assistant or ESPHome/PlatformIO.

The exit status is non-zero if extraction fails, compilation fails or a test
fails. Everything it writes goes to `PowerStation/tools/build/`, which is
git-ignored.

## How it works

| File | Role |
| --- | --- |
| `tools/extract_lambdas.py` | Reads the YAML (tags such as `!secret` are kept as text) and fills in `${...}` substitutions. Writes `build/firmware_logic.gen.h`: one function per script, switch handler, `on_value`, number `set_action`, binary sensor trigger, `on_time` and `interval`. Lambda bodies go in verbatim. |
| `tools/firmware_stubs.h` | Fakes for the ESPHome objects: switches, selects, numbers, the datetime, sensors, the SNTP clock, the UART, scripts, `App.scheduler` and `millis()`. They copy the ESPHome behaviour the logic depends on, listed below. |
| `tools/test_firmware_logic.cpp` | The tests, with a minimal assertion framework and no external dependencies. |
| `tools/test_firmware_logic.py` | Runs the extractor, compiles and runs the tests. |

The generator only translates `lambda`, `logger.log`, `script.execute`,
`switch.turn_on/off` and `if` (with `switch.is_on`/`switch.is_off` or a lambda
condition). Any other action stops it with an error. It also counts every
`lambda:` key in the YAML and fails if it didn't extract all of them. A lambda
added in a new place or with a new action is reported this way, not silently
left untested. `on_boot` is skipped on purpose (see below).

ESPHome behaviour the fakes reproduce:

- `Switch::publish_state` drops repeated values, sets `state` before
  `on_turn_on`/`on_turn_off` run, and always lets the first publish through.
  That first publish is the boot-time restore replay.
- The JK BMS charging switch is not optimistic. Its state changes only when the
  BMS confirms the write. Setting `follow_writes = false` simulates a lost BLE
  write.
- A select rejects an option that is not in its list, and publishes and fires
  `on_value` on every accepted call.
- A template number rejects a value outside min..max. Otherwise `control()`
  runs `set_action`, publishes only if the number is optimistic, and then saves
  the value to flash (`saved`) whatever `set_action` did. `boot()` is
  `TemplateNumber::setup`: it publishes the saved value, or the initial one.
- `App.scheduler.set_timeout` callbacks wait until the test calls
  `App.scheduler.run()`, which stands for the next main-loop pass. A second
  timeout with the same key replaces the first.
- `script.execute` on a lambda-only script runs synchronously.
- Clock and datetime timestamps share one local-time conversion. The lambdas
  only compare the two, so this is enough. A clock that has not synced reads
  1970 and `is_valid()` returns false.

## What is covered

| Group | Covers |
| --- | --- |
| `power_mode` | `evaluate_power_mode`: the data guard; rule 1 (protection plus bad grid gives SBU and a direct `POP02`, even with an invalid clock); rule 1b pre-charge beating the tariff and losing to protection; rules 2-4 at 22:59/23:00/23:59/00:00/06:59/07:00; invalid clock; rule 5; manual mode; the bad-grid quirk with protection off; no command when the priority is already right; pre-charge deadline exactly now, ±1 s, far future, the `2000-01-01` release value and across midnight |
| `charge_window` | Night-only gate at every hour boundary, hands-off while the mode is off, failing open on an invalid clock, no repeat BLE write when the charger already agrees, re-assertion after a lost write |
| `precharge` | Start saves `Max AC Charge Current` and runs the power mode once. End restores it (including the `02` and `60` bounds) on the deadline, on the switch going off and on HA's release value. Also: overriding night-only by day and handing back; night-only switched off mid-charge; bad grid during a pre-charge; invalid clock; reboot mid-charge with a valid and with an invalid clock; an end with nothing saved |
| `interlock`, `triggers` | Auto Tariff and Night Charging Only exclusion; charger hand-back; the restore replay before `restore_replay_done`; dedup; protection and pre-charge switch handlers; the 07:00/23:00 `on_time` triggers; `grid_safe` press/release |
| `commands` | `MUCHGC` for every option and zero padding; rejected options; `POP00/01/02`; `PGR00/01`; `PCVV`/`PBFT` at every 0.1 V step from 24.0 to the maximum, at the bounds, with off-step rounding (27.25 gives 27.2); bulk-below-float and float-above-bulk refusals, which leave the entity on the accepted value, write it back to flash without re-sending, and are not replayed at boot; NaN on the other side; retry counter priming only when the queue was empty; duplicate commands |
| `dispatcher` | Idle QPIGS, command/poll alternation, CRC against known PI30 values (QPIGS, QPIRI, QMOD), no reserved CRC byte for any command the firmware can build, ACK, 20 tries on silence with polls still going, NAK cutting retries to 2, a command queued during the front command's last try not reviving it, give-up priming the next command, stray ACK |
| `reply` | QPIGS parsing into the sensors, EMI sanity limits (exactly at and just over each limit), short and truncated frames, a frame split across ticks, buffer overflow recovery, ACK ending the tick |
| `grid`, `uptime` | `grid_safe` thresholds (185.0 and 250.0 are unsafe); `grid_in_range` as the exact inverse from 150 to 280 V; Grid Real Power rules; uptime accumulation with millisecond carry and across the `millis()` wrap |

### Known-bug groups

A test whose group starts with `KNOWN_BUG` asserts the intended behaviour of a
defect that is still in the firmware. It prints `KNOWN-BUG (still present)` and
does not fail the run. Once a fix makes it pass, it prints `KNOWN-BUG FIXED?`.
At that point, move the test to a normal group.

There are none at the moment. The last two were fixed on 2026-10-02 and now
run as normal tests:

- `commands.refused_voltage_does_not_stick_as_entity_state`: a refused bulk or
  float value used to stay as the entity's state. The numbers now validate in
  `set_action` and publish only accepted values.
- `dispatcher.push_during_last_try_does_not_revive_refused_command`: producers
  primed `command_retries` whenever it was 0, which also meant "the front
  command has used its last try". They now prime only when their command is
  the new front of the queue.

## Not covered

- **`on_boot`.** It waits for the UART and NTP: framework sequencing with no
  decisions of its own. Its effects are covered through the scripts it runs and
  through the restore-replay tests.
- **`grid_safe`'s `delayed_on: 5s` / `delayed_off: 300s` filters.** These are
  ESPHome filter components, not lambdas. The tests cover the threshold lambda
  and the press/release handlers.
- **`mode: restart` cancellation.** Every script is one synchronous lambda, so
  no run can be in progress when another starts.
- **Component setup order during boot.** For example, the order in which
  restored switches replay relative to restored globals. That order comes from
  ESPHome, not from this YAML.
- **Static state inside the reply, uptime and number lambdas** (`static
  std::string buffer`, `last_ms`, `writing_back`). It persists across tests.
  The tests always end on a complete frame, measure uptime as deltas, and
  `writing_back` is only true while a write-back runs, so this does not matter
  in practice.
