# The HTTP endpoints

MeterCam listens on `:8770` in LXC 104.

| Endpoint | Who calls it | What |
| --- | --- | --- |
| `POST /read?meter=gas&fw=<version>` | the camera, once per wake | Read the frames, gate, write an accepted reading to Home Assistant, answer |
| `GET /firmware/gas-cam.bin` | the camera, when offered a newer build | The firmware image |
| `GET /firmware/version.txt` | gas-cam-5 and older boards, or a human with curl | The version on offer; 404 when none is published. gas-cam-6 and later read it from the `/read` answer instead |
| `GET /last.jpg?meter=gas` | a human | The frame behind the last answer, exactly as the camera sent it |
| `GET /last_accepted.jpg?meter=gas` | Home Assistant (`gas_submit.py`) | The frame behind the last *accepted* reading; headers `X-Value`, `X-At`, `X-At-Epoch` carry that reading |
| `GET /gas/bot/status` | Home Assistant (`gas_submit.py`) | Dry run of `@mygrmu_bot`: walks to the reading prompt and back, answers `{ok, previous, previous_date, transcript}`. Sends no reading |
| `POST /gas/bot/submit` | Home Assistant, on a button press | `{"value": 2262}` sends the monthly gas reading through the bot; `{ok, value, reply, transcript}` or `{ok: false, error, transcript}` |
| `GET /archive/days` | a human | What is archived, newest day first, with frame counts and bytes. Read this before the one below |
| `GET /archive` | a human | Every archived frame and its sidecars as one streamed zip. `?meter=gas` `?days=3` (today and the two before) |
| `GET /health` | Docker's healthcheck, deploy.sh | Config status, meters, auth, firmware on offer, seconds since each meter's last read |

## Auth

`X-Auth-Token`, the same shape as `HomeAssistant/config/irbridge/rest_commands.yaml`,
or `?token=` (which is what makes `/last.jpg` and `/archive` usable from a
browser). With `METERCAM_TOKEN` unset, auth is off and `/health` says
`"auth": "DISABLED"`. That is how the LAN deployment runs today, and it means
`/last.jpg` and `/archive` hand photographs of the house to anything on the
LAN that asks.

The two `/gas/bot/*` routes ignore all of that: they always need
`X-Gasbot-Token` equal to `GASBOT_TOKEN`, and with `GASBOT_TOKEN` unset they
refuse everyone. They send a reading to the gas operator as the household,
which nothing on the LAN should be able to do by accident. The conversation
itself, and its checks, are in [`gas-bot.md`](gas-bot.md).

## `POST /read`

The body is `multipart/form-data` with one file part per frame, in order. A
single raw JPEG body is also accepted, and refused as unconfirmed while
`confirm.samples` asks for more than one frame. `fw` is optional and only
logged.

```json
{
  "meter": "gas", "value": 2261.72, "accepted": true, "reason": null,
  "dial": 2261.72, "digits": [0, 2, 2, 6, 1, 7, 2], "raw": "0226172",
  "drums": [0.0, 2.0, 2.0, 6.0, 1.0, 7.0, 2.0],
  "prevalue": 2261.71, "prevalue_from": "home assistant", "delta": 0.01,
  "elapsed_s": 1800,
  "confidence": {"per_drum": [0.998, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0], "min": 0.998},
  "align": {"ok": true, "inliers": 1845, "matches": 1848, "dx": 0.0, "dy": 0.0, "rotation_deg": 0.0},
  "samples": {"wanted": 2, "taken": 2, "values": [2261.72, 2261.72]},
  "frames_supplied": 2, "firmware_running": "gas-cam-6",
  "published_to": "input_number.gas_meter_camera_reading",
  "image": "/data/images/gas/raw/2026-10-02/2026-10-02-01-42-2261.72.jpg",
  "firmware": "gas-cam-6"
}
```

- `accepted: false` always carries a `reason` and still fills in whatever was
  read, so a refusal can be looked at rather than guessed at. `image` is the
  archived frame, in `raw/` for an accepted read and `rejected/` for a refusal.
- `published_to` is the helper that was written. `publish_error` replaces it
  when Home Assistant refused the write. Nothing is lost: each reading is an
  absolute total, so the next accepted wake writes the newer one.
- `firmware` is present on every answer, including the 502 a crashed read
  returns. A board whose reads are failing is exactly the board that may need
  the next build.
- The status is 200 for any verdict, 400 for a malformed request, and 502 when
  the reader itself raised an exception.
