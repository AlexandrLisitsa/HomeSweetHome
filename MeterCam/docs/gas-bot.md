# The gas bot: the monthly reading to Gazmerezhi

Once a month the household files its gas reading with the distribution
operator, the Dniprovska filiia of Gazmerezhi. `service/gasbot.py` does that
through the operator's Telegram bot, `@mygrmu_bot`, logged in as the
household's own Telegram user. It never sends anything on its own. Home
Assistant asks on the phone, and only a button press there reaches
`POST /gas/bot/submit`. The Home Assistant side (the notification, the buttons,
the schedule) is in
[`HomeAssistant/docs/gas-reading-submission.md`](../../HomeAssistant/docs/gas-reading-submission.md).

```
Home Assistant ── X-Gasbot-Token ──► MeterCam :8770 ── Telethon (MTProto) ──► Telegram ──► @mygrmu_bot
  rest_command (5 min)                /gas/bot/status   walk to the prompt, read, back out
                                      /gas/bot/submit   walk, type, check the echo, confirm
```

## Why a Telegram bot

Every web channel for this operator is closed to code, and none of that is
worked around here:

| channel | why not |
| --- | --- |
| my.gas.ua (the supplier's cabinet) | Cloudflare challenges every client that is not a browser; the login answers 403 |
| my.grmu.com.ua (the operator's cabinet) | Turnstile captcha on the login |
| gas.ua's public form | a Turnstile token on every submit |
| SMS 4647, phone | needs a SIM; ruled out |
| @GASUA_bot, Viber, Privat24 | stopped taking readings in 2025 |

`@mygrmu_bot` is official (Gazmerezhi, since 2025-10-27), and Telegram's client
API exists to be used from code. The bot gets exactly what a person would
type.

## The conversation, as of 2026-10-02

```
/start                          → main menu
[📁 Особові рахунки]            → the account card: "Особовий рахунок 031…"
[📝 Передати показання]         → "Оберіть номер лічильника" + a button per meter
[<serial>]                      → "Внесіть актуальні показання …
                                    Показання за попередній період: 2262,00 м³
                                    Дата останнього показання: 30.09.2026"
"2290"                          → "Ви підтверджуєте відправку показань 2290
                                    по лічильнику <serial>?"   [Так] [Ні]
[Так]                           → "…Ваші показання успішно прийняті"
[🔙 До головного меню]
```

`status` stops at the reading prompt, reads the previous reading and its date,
and backs out to the main menu without typing anything.

## What it checks before every step

A menu that changed has to fail loudly. It must never send a number to a
screen the code does not recognise. So each step checks the bot's own words
first:

- **The account card has to name our account.** The main menu has a
  «📩 Передати показання» of its own that does not say which account it is
  for, and the walk never presses it. It goes through «Особові рахунки» and
  presses the button only on a message that shows `GASBOT_ACCOUNT`. On
  another account's card, the reading would land on someone else's meter.
- **The meter list has to show `GASBOT_COUNTER`**, and that is the button the
  walk presses.
- **A value below the previous reading is never typed.**
- **The confirmation has to repeat our number and our meter.** Anything else
  gets «Ні».
- **Success means the reply says «успішно прийняті».** Any other answer is
  reported as a failure, with the bot's text.

Every answer includes a `transcript` of what the bot said and what was
pressed, so a failure shows the exact screen it stopped on. The labels it
matches are constants at the top of `gasbot.py`. `tests/test_gasbot.py` replays
the conversation against a fake bot that says what the real one says,
including each failure above.

The whole walk takes 40–60 s. The bot itself is slow, and each step also
waits until the bot has been quiet for 1.5 s, because it often answers with two
messages. Callers need a timeout well past a minute: Home Assistant uses
5 minutes. One walk runs at
a time.

## Configuration

All of it is in `.env` on the box, because the repo is public and the account
number is private:

| key | what |
| --- | --- |
| `GASBOT_API_ID`, `GASBOT_API_HASH` | the Telegram app, from https://my.telegram.org → API development tools |
| `GASBOT_ACCOUNT` | the Gazmerezhi personal account, 10 digits, `031…` for the Dniprovska filiia (not the Naftogaz supply account) |
| `GASBOT_COUNTER` | the meter serial as the bot lists it |
| `GASBOT_TOKEN` | a random string. Home Assistant sends it as `X-Gasbot-Token`, and it is `gasbot_token` in HA's `secrets.yaml` |
| `GASBOT_BOT` | optional, default `mygrmu_bot` |

**`/gas/bot/*` ignores `METERCAM_TOKEN`.** These routes always need
`X-Gasbot-Token`, and with `GASBOT_TOKEN` unset they refuse everyone. A stray
script on the LAN must not be able to file a reading.

After editing `.env`, run `docker compose up -d --force-recreate`. A running
container does not reread it.

## Logging in

You log in once, as the household's Telegram user. The session is stored as
`data/telegram/gasbot.session`.

**With a login code**, sent to the Telegram app between the two steps:

```sh
docker exec metercam python -m service.gasbot login --phone +380XXXXXXXXX
docker exec metercam python -m service.gasbot login --code 12345      # --password <2FA> if set
```

The first step reports `delivered_via`: `App` means the code is in the
«Telegram» service chat, and other values mean SMS, a call or email.
Telegram can report `App` and deliver nothing, which is what happened here.

**With a QR code**, for when the code never arrives:

```sh
docker exec metercam python -m service.gasbot login --qr
```

The QR code is written to `data/telegram/login-qr.svg` and redrawn every
time Telegram rotates the token (about every 30 s), for up to 4 minutes.
Scan it in Telegram → Settings → Devices → Link Desktop Device. The file is
deleted afterwards either way.

**Then a dry run:**

```sh
docker exec metercam python -m service.gasbot status
```

## The session is a logged-in Telegram account

Whoever has `gasbot.session` can read and send as the household's Telegram
account. So:

- It stays on the box (`chmod 600`, directory `700`) and is git-ignored with
  the rest of `data/`.
- It goes off-site only **encrypted**, in the weekly MeterCam state archive
  ([`Proxmox/docs/backups.md`](../../Proxmox/docs/backups.md)).
- It shows up in Telegram → Settings → Devices as the app's name. Ending it
  there logs MeterCam out, and every call then answers
  `Telegram session is not logged in`. Log in again as above.

## When it breaks

| error | meaning |
| --- | --- |
| `not configured: … missing in .env` | a `GASBOT_*` key is empty, or the container was not recreated after the edit |
| `Telegram session is not logged in` | the session was ended; log in again |
| `the bot did not answer within 25 s` | the bot or Telegram is slow or down; try again later |
| `no '…' button where it used to be`, `expected …`, `no account card …` | the bot's menu changed. Read the transcript, update the constants at the top of `gasbot.py` and the fake bot in `tests/test_gasbot.py`, and run the test |
| `the bot already took a reading from this account today …` | a reading already went in today, by hand or by an earlier tap. The bot keeps the first one and takes nothing new that day. Its own words: «Сьогодні я прийняв Ваші показання і вже працюю над їх обробкою» |
| `the bot did not accept it: …` | the bot refused the value; its reason is quoted |

By hand, the reading can always go in through the bot itself, the Kub app,
or my.grmu.com.ua.
