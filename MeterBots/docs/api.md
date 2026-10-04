# The HTTP endpoints

MeterBots listens on `:8770` in LXC 105. Home Assistant calls it with
`rest_command`s (5-minute timeout: a walk takes up to a minute).

| Endpoint | Who calls it | What |
| --- | --- | --- |
| `GET /health` | Docker's healthcheck, `deploy.sh`, a human | `{status, version, bots: {gas, yasno}, session}`. `bots` says which bots have a token; `session` says whether a session file exists, not whether it is still logged in. No secrets |
| `GET /session` | Home Assistant (`meterbots_session.yaml`), every Monday | `{ok: true, authorized: true}` while the Telegram session is logged in, else `{ok: false, error}`. One round trip to Telegram, nothing sent to any bot. Either bot's token opens it. Waits out a running walk |
| `GET /gas/bot/status` | Home Assistant (`gas_submit.yaml`) | Dry run of `@mygrmu_bot`: walks to the reading prompt and back, answers `{ok, previous, previous_date, transcript}`. Sends no reading |
| `POST /gas/bot/submit` | Home Assistant, on a button press | `{"value": 2262}` (> 0, < 100000, at most 2 decimals) sends the monthly gas reading; `{ok, value, reply, transcript}` or `{ok: false, error, transcript}` |
| `GET /yasno/bot/status` | Home Assistant (`electricity_submit.yaml`) | Dry run of `@Yasnoonlinebot`: walks to the reading prompt and back, answers `{ok, previous: {day, night, date}, transcript}`. Sends no reading |
| `POST /yasno/bot/submit` | Home Assistant, on a button press | `{"day": 38500, "night": 6450}`, whole kWh each, > 0 and < 1000000, sends the monthly electricity reading; `{ok, day, night, reply, transcript}` or `{ok: false, error, transcript}` |

## Tokens

Each bot has its own token, sent as its own header:

| Routes | Header | `.env` | Home Assistant `secrets.yaml` |
| --- | --- | --- | --- |
| `/gas/bot/*` | `X-Gasbot-Token` | `GASBOT_TOKEN` | `gasbot_token` |
| `/yasno/bot/*` | `X-Yasnobot-Token` | `YASNOBOT_TOKEN` | `yasnobot_token` |

A wrong or missing token gets `401`, and one bot's token never opens another's
routes. `/session` is the exception: it walks no bot, so either token opens it. **With the token unset, the route refuses
everyone**, an empty header included: filing a reading as the household is not
something a stray script on the LAN may do. `/health` needs no token and
carries none.

## Errors

Every bot route answers JSON, whatever happens:

| Answer | Meaning |
| --- | --- |
| `400 {ok: false, error}` | the body was refused before any bot was asked |
| `200 {ok: false, error, transcript}` | the bot was asked and the walk stopped; `transcript` shows the screen it stopped on |
| `200 {ok: false, error}` | the walk could not start (not configured, not logged in, Telegram unreachable) |
