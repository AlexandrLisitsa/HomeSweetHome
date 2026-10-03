# The HTTP endpoints

MeterCam listens on `:8770` in LXC 104.

| Endpoint | Who calls it | What |
| --- | --- | --- |
| `POST /read?meter=gas&fw=<version>` | the camera, once per wake | Read the frames, gate, write an accepted reading to Home Assistant, answer |
| `GET /firmware/gas-cam.bin` | the camera, when offered a newer build | The firmware image |
| `GET /firmware/version.txt` | gas-cam-5 and older boards, or a human with curl | The version on offer; 404 when none is published. gas-cam-6 and later read it from the `/read` answer instead |
| `GET /last.jpg?meter=gas` | a human | The frame behind the last answer, exactly as the camera sent it |
| `GET /last_accepted.jpg?meter=gas` | Home Assistant (`gas_submit.py`) | The frame behind the last *accepted* reading; headers `X-Value`, `X-At`, `X-At-Epoch` carry that reading |
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

Filing the monthly reading with the gas operator is not MeterCam's job: that
is MeterBots ([`MeterBots/docs/api.md`](../../MeterBots/docs/api.md)), which
Home Assistant calls with the number MeterCam's `/last_accepted.jpg` reported.
