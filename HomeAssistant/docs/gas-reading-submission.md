# Monthly gas reading to Gazmerezhi

Once a month the phone asks whether to send the gas reading. It shows the
photo the reading came from, and when you press a button it sends the reading
to Gazmerezhi's Telegram bot, `@mygrmu_bot`.

| piece | where |
| --- | --- |
| the ask and the buttons | `config/packages/gas_submit.yaml` |
| the photo, the value, which month went in | `config/gas/gas_submit.py` (`prepare`, `record`) |
| the calls to the bot | `rest_command.gas_bot_status` / `gas_bot_submit` in the same package, 5-minute timeout |
| the Telegram conversation | MeterBots `service/gasbot.py`, routes `/gas/bot/status` and `/gas/bot/submit` ([`MeterBots/docs/gas-bot.md`](../../MeterBots/docs/gas-bot.md)) |
| the photo | MeterCam `GET /last_accepted.jpg?meter=gas` |
| secrets | `gasbot_token` (MeterBots' `GASBOT_TOKEN`), `gasbot_status_url`, `gasbot_submit_url` (MeterBots), `metercam_url` (the photo) in `secrets.yaml` |

## Why a Telegram bot

Every web channel for this operator is closed to code: the cabinets and the
public form sit behind Cloudflare challenges and captchas, and none of that is
worked around here. `@mygrmu_bot` is an official Gazmerezhi channel, and
MeterBots talks to it as the household's own Telegram user.
[`MeterBots/docs/gas-bot.md`](../../MeterBots/docs/gas-bot.md) has the reasons
channel by channel, the conversation, the checks made before each step, the
Telegram login and what to do when the bot's menu changes.

## What happens

1. **21:00 on the 1st.** `script.gas_submit_ask` does two things:
   - **`gas_submit.py prepare`** saves the frame MeterCam last *accepted* as
     `www/gas_meter/<YYYY-MM-DD-HH-MM>-<random>.jpg`, and reads this month's
     entry in the state file.
   - **`rest_command.gas_bot_status`** asks MeterBots for a dry run of the bot.
     It walks to the reading prompt, reads the previous reading and backs out,
     so nothing is sent. This takes about 45 s, which is why the notification
     comes about a minute after 21:00.
2. **The Pixel** (`notify.mobile_app_pixel_10_pro_xl`, tag `gas-submit`) shows:
   - the title `Gas reading 2026-11-01 20-57`, which is when the photo was
     taken
   - the photo
   - `Send 2290 m³? Camera 2290.47. Last sent 2262.`
   - two buttons: **Submit 2290**, and **Correct & submit** (a text field in
     the notification)
3. **The button** runs `rest_command.gas_bot_submit`, which asks MeterBots to
   send the reading. That takes about a minute, and `gas_submit.py record`
   then notes the month. The notification is then replaced with ✅ and the bot's own reply
   («Ваші показання успішно прийняті»), or with ❌ and the reason plus a
   *Try again* button.
4. **The 2nd to the 4th, 21:00:** the ask repeats while nothing has been sent.
   A successful submit writes the month to `gas/.state.json`, which stops it.
   Run `script.gas_submit_ask` with `force: true` to ask anyway.

## Why rest_command, not shell_command

Walking the bot takes 40–60 s, and HA's `shell_command` has a fixed 60 s
limit that cannot be changed. The first live submit hit it: the bot answered,
but the phone showed a timeout. So the two bot calls are `rest_command`s with
`timeout: 300`. Only the quick local work (the photo and the state file) runs
as a shell command. If MeterBots gives no answer at all, the ❌ says to check
the chat with `@mygrmu_bot` before retrying, because the reading may have
gone through anyway.

## The rules it applies

- **Whole m³, rounded down.** 2290.47 is sent as 2290. The branch asks for the
  first five digits, and the remainder lands in next month's reading.
- **1st to 5th only.** This is the Dniprovska filiia's rule. Outside it the
  notification has no buttons.
- **Typed values are checked before the bot is touched.** The value must be a
  whole number, no more than the camera reading + 50, and no less than the
  previous reading (`gasbot.py` refuses that too).
- **No buttons for a doubtful photo.** If the photo is more than 6 h old, or
  the camera reads below the previous reading, only *Correct & submit* is
  offered.
- **No entities.**

## Setting it up, and when it breaks

- **MeterBots side:** the `.env` keys, the one-time Telegram login, and the
  bot's own errors. See [`MeterBots/docs/gas-bot.md`](../../MeterBots/docs/gas-bot.md).
- **HA side:** `gasbot_token` in `secrets.yaml`. It must equal MeterBots'
  `GASBOT_TOKEN`; if they differ, MeterBots answers 401 and the notification
  says `MeterBots did not answer, or refused`. `metercam_url` must be set for
  the photo.
- **Every failure reaches the phone.** If the bot cannot be reached, the
  notification still arrives with the photo and says why.

By hand, the reading can always go in through the bot itself, the Kub app, or
my.grmu.com.ua.
