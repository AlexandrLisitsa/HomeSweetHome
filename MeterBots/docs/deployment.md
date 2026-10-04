# Deployment

MeterBots runs in **LXC 105** (`meterbots`) on the Proxmox host, at the house's
next fixed address (root README, "Network"). The container is unprivileged
with `nesting=1,keyctl=1` for Docker, and is sized at the house defaults: 1
core, 512 MB, 2 GB.

## First setup

1. `deploy/lxc.env` from `deploy/lxc.env.example`, with the real address and
   gateway. Check that nothing answers on the address first.
2. `sh MeterBots/deploy/lxc_create.sh`, then `sh MeterBots/deploy/lxc_provision.sh`.
3. `/opt/meterbots/.env` in the LXC, from [`.env.example`](../.env.example):

   | Key | What |
   | --- | --- |
   | `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | https://my.telegram.org → API development tools |
   | `GASBOT_TOKEN`, `GASBOT_ACCOUNT`, `GASBOT_COUNTER` | the gas bot ([`gas-bot.md`](gas-bot.md)) |
   | `YASNOBOT_TOKEN`, `YASNOBOT_ACCOUNT` | the YASNO bot ([`yasno-bot.md`](yasno-bot.md)); the account is saved in the bot once with `explore` |

4. `sh MeterBots/deploy/deploy.sh`.
5. The session: log in (below), or move an existing one in (further below).
6. In Home Assistant's `secrets.yaml`, point the bot URLs at this box
   (`http://<meterbots-ip>:8770/gas/bot/status` and `/submit`, the same for
   `/yasno/bot/`), then restart.

`deploy.sh` ships code only (`service/`, `tests/`, `Dockerfile`, `compose`,
`requirements.txt`). It never touches `.env` or `data/`. After editing `.env`,
run `docker compose up -d --force-recreate` in `/opt/meterbots`.

## Logging in, once

As the household's Telegram user. The code arrives in the Telegram app
between the two steps:

```sh
docker exec meterbots python -m service.tgclient login --phone +380XXXXXXXXX
docker exec meterbots python -m service.tgclient login --code 12345      # --password <2FA> if set
```

The first step reports `delivered_via`: `App` means the «Telegram» service
chat, and other values mean SMS, a call or email. Telegram can report `App`
and deliver nothing. If that happens, log in by QR:

```sh
docker exec meterbots python -m service.tgclient login --qr
```

The QR code is written to `data/telegram/login-qr.svg` and redrawn about
every 30 s, for up to 4 minutes. Scan it in Telegram → Settings → Devices →
Link Desktop Device. Then do a dry run: `python -m service.gasbot status`.

## Moving the session

The session can move between boxes without a new login, because it's just the
file. **It must never be in use in two places at once**
([`architecture.md`](architecture.md)), so:

1. Stop whatever uses it at the source: remove its routes or stop its
   container.
2. On the Proxmox host: `pct pull <from> <path>/telegram.session /tmp/s`, then
   `pct push 105 /tmp/s /opt/meterbots/data/telegram/telegram.session`, then
   delete both `/tmp/s` and the source copy.
3. Inside 105: `chmod 600` the file (`700` on the directory).
4. Do a dry run (`/gas/bot/status` with the token).

The file may be renamed while it moves (MeterCam's was `gasbot.session`): the
name is not part of the login.

## The session is a logged-in account

Whoever has `telegram.session` can read and send as the household. So:

- It stays on the box (`chmod 600`, directory `700`) and is git-ignored with
  the rest of `data/`.
- It goes off-site only inside the **encrypted** weekly upload, as a few-KB
  `meterbots-state-*.tar.zst` archive (`.env`, `docker-compose.yml`,
  `data/telegram`). LXC 105 itself is not dumped: its image rebuilds from git
  ([`Proxmox/docs/backups.md`](../../Proxmox/docs/backups.md)).
- It shows up in Telegram → Settings → Devices under the API app's name.
  Ending it there logs MeterBots out, and every call answers
  `Telegram session is not logged in` until someone logs in again.

## Keeping it logged in

The session is used about once a month, and Telegram ends sessions that sit
unused. Two things keep that from surfacing at the monthly ask:

- **Telegram's own timer.** In the household account, Telegram → Settings →
  Privacy and Security → Devices → *Automatically terminate old sessions*: set
  it to the longest period (1 year). With 1 month, a quiet session can be
  ended between two monthly readings.
- **The weekly check.** Every Monday at 12:00 Home Assistant calls `GET
  /session` (`HomeAssistant/config/packages/meterbots_session.yaml`). It asks
  Telegram whether the session is still authorised, which is also a use of the
  session, and notifies the household if it is not, or if MeterBots does not
  answer. `/health` cannot tell: a session ended in Telegram leaves its file.

To check by hand: `curl -H "X-Gasbot-Token: <token>" http://<meterbots-ip>:8770/session`.
