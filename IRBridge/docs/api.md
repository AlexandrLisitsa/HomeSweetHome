# HTTP API

`/health` is open; everything else needs `X-Auth-Token` (or `?token=`).

## Raw IR, the candidate table and the sweep

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/health` | — | liveness, emitter presence, carrier ranges |
| GET | `/log?limit=60` | — | the in-memory log, newest first |
| POST | `/ir/raw` | `{pattern:[µs…], carrierHz?, repeat?, gapMs?}` | send a raw frame |
| POST | `/ir/pronto` | `{hex, repeat?}` | send a Pronto `0000 …` code |
| POST | `/ir/broadlink` | `{base64, repeat?}` | send a Broadlink/SmartIR code |
| GET | `/codes?q=midea&limit=50` | — | search the candidate table |
| POST | `/codes/{idx}/send` | `{command:"on"\|"off", repeat?}` | send one candidate |
| POST | `/sweep/start` | `{from?, to?, delayMs?, command?, repeat?}` | begin a sweep |
| POST | `/sweep/step` | `{idx?, command?, repeat?}` | send exactly one and advance |
| POST | `/sweep/stop` | `{}` | halt |
| GET | `/sweep/status` | — | cursor, ETA, recent trail, confirmed hits |
| POST | `/sweep/mark` | `{windowMs?}` | "that one did something": the candidates sent in the window, newest first |
| POST | `/sweep/clear-hits` | `{}` | forget the confirmed hits; answers the status |

## The air conditioner

The stateful half ([stateful-climate.md](stateful-climate.md)): the bridge
keeps an *assumed* state for one A/C, from `assets/ac_codes.json` (this unit:
SmartIR set 1380, a Coolix protocol), and sends the whole frame for it on every
change. Home Assistant's `config/irbridge/rest_commands.yaml` drives these.

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/ac/capabilities` | — | what the code set can do: `manufacturer`, `setId`, `modes`, `fans`, `minTemp`/`maxTemp`/`tempStep`, `carrierHz`, `frameCount`, `invariants` (axes a mode ignores, e.g. fan in `heat_cool`), `synthesizedModes` (modes built rather than looked up, e.g. `dry`), `swingSupported` |
| GET | `/ac/state` | — | what the bridge **last sent**, not what the unit is doing: `power`, `hvacMode` (`off` or the mode), `mode`, `temp`, `fan`, `swing` |
| POST | `/ac/set` | `{power?, mode?, temp?, fan?, repeat?}` | merge onto the current state and send the frame for the result |
| POST | `/ac/resend` | `{repeat?}` | send the current state again: the fix for a model that drifted (someone used the remote) |
| POST | `/ac/swing` | `{on?, force?, repeat?}` | start or stop the vane swinging |
| POST | `/ac/swing/step` | `{repeat?}` | move the vertical vane one position; no state is kept |

Every `/ac/*` answer that transmitted carries a `sent` block (`format`,
`marks`, `frameMicros`, `repeats`, `carrierHz`, `wallMillis`), the same one the
raw routes return.

**`/ac/set` is a partial update.** An A/C remote has no deltas: every press
sends power, mode, temperature and fan as one frame. So any field left out
keeps its last value, and the frame always holds all four.

- `mode: "off"` means `power: false`, as Home Assistant's climate entity says
  it. The mode is kept, so switching back on restores what it was doing.
- Naming any other mode also switches the unit on: `hvac_mode: cool` starts
  cooling, it does not arm a mode for later.
- An unknown mode or fan, or a combination the code set has no frame for, is a
  `400` with the reason; nothing is sent.

**Swing is not part of the state frame.** On Coolix it is a separate toggle
message, so it has its own routes and `/ac/set` and `/ac/resend` never touch
it (a resend that pressed swing would reverse the vane).

- `{on: true}` / `{on: false}`: reach that state. If the bridge believes the
  vane is already there, nothing is sent and the answer has no `sent` block.
- `{}`: toggle unconditionally, the honest choice when nobody knows where the
  vane is.
- `{on: …, force: true}`: press even if the belief says it is already there,
  for after someone used the physical remote.
- Both swing routes refuse (`400`) if the code set does not decode as Coolix,
  rather than send an invented frame.

`repeat` everywhere is how many times the frame is sent back to back (default
1); raise it for a unit that misses the odd frame.

## The token

The token is a shared secret over plain HTTP. It stops a stray script or a
guest on the wifi from cycling your air conditioner; it is not protection
against someone already sniffing the network. If that matters to you, the
answer is an IoT VLAN, not TLS on a 2018 phone.
