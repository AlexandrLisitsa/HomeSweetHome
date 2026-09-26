# HTTP API

`/health` is open; everything else needs `X-Auth-Token` (or `?token=`).

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/health` | — | liveness, emitter presence, carrier ranges |
| GET | `/log?limit=60` | — | the in-memory log, newest first |
| POST | `/ir/raw` | `{pattern:[µs…], carrierHz?, repeat?, gapMs?}` | send a raw frame |
| POST | `/ir/pronto` | `{hex, repeat?}` | send a Pronto `0000 …` code |
| POST | `/ir/broadlink` | `{base64, repeat?}` | send a Broadlink/SmartIR code |
| GET | `/codes?q=midea&limit=50` | — | search the candidate table |
| POST | `/codes/{idx}/send` | `{command:"on"\|"off", repeat?}` | send one candidate |
| POST | `/sweep/start` | `{from?, to?, delayMs?, command?}` | begin a sweep |
| POST | `/sweep/step` | `{idx?, command?}` | send exactly one and advance |
| POST | `/sweep/stop` | `{}` | halt |
| GET | `/sweep/status` | — | cursor, ETA, recent trail, confirmed hits |
| POST | `/sweep/mark` | `{windowMs?}` | "that one did something" |

The token is a shared secret over plain HTTP. It stops a stray script or a
guest on the wifi from cycling your air conditioner; it is not protection
against someone already sniffing the network. If that matters to you, the
answer is an IoT VLAN, not TLS on a 2018 phone.
