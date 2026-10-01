# The HTTP endpoints

MeterCam listens on `:8770` in LXC 104.

| Endpoint | Who calls it | What |
| --- | --- | --- |
| `POST /read?meter=gas&fw=<version>` | the camera, once per wake | Read the frames, gate, write an accepted reading to Home Assistant, answer |
| `GET /firmware/gas-cam.bin` | the camera, when offered a newer build | The firmware image |
| `GET /firmware/version.txt` | gas-cam-5 and older boards, or a human with curl | The version on offer; 404 when none is published. gas-cam-6 and later read it from the `/read` answer instead |
| `GET /health` | Docker's healthcheck, deploy.sh | Config status, meters, auth, firmware on offer, seconds since each meter's last read |

## Auth

`X-Auth-Token`, the same shape as `HomeAssistant/config/irbridge/rest_commands.yaml`,
or `?token=`. With `METERCAM_TOKEN` unset, auth is off and `/health` says
`"auth": "DISABLED"`. That is how the LAN deployment runs today.

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
  "image": null,
  "firmware": "gas-cam-6"
}
```

- `accepted: false` always carries a `reason` and still fills in whatever was
  read, so a refusal can be looked at rather than guessed at. `image` is then
  the path of the archived frame.
- `published_to` is the helper that was written. `publish_error` replaces it
  when Home Assistant refused the write. Nothing is lost: each reading is an
  absolute total, so the next accepted wake writes the newer one.
- `firmware` is present on every answer, including the 502 a crashed read
  returns. A board whose reads are failing is exactly the board that may need
  the next build.
- The status is 200 for any verdict, 400 for a malformed request, and 502 when
  the reader itself raised an exception.
