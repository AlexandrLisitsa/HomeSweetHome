# MeterBots

Files the monthly meter readings with the suppliers, through their Telegram
bots, as the household's own Telegram user. It runs as a small service in its
own Proxmox LXC (105), and Home Assistant calls it when someone taps *Submit*
on the phone.

It decides nothing. Home Assistant decides when and what (the notification,
the buttons, the values), and MeterCam reads the meters. MeterBots only walks a
bot's menus, checks every screen before acting on it, and reports back what the
bot said.

| Bot | Supplier | Reading | Doc |
| --- | --- | --- | --- |
| `@mygrmu_bot` | Gazmerezhi (gas distribution) | the gas meter, whole m³ | [`docs/gas-bot.md`](docs/gas-bot.md) |
| `@Yasnoonlinebot` | YASNO (electricity supply) | the electricity meter's day and night registers, whole kWh | [`docs/yasno-bot.md`](docs/yasno-bot.md) |

```
Home Assistant ── rest_command, a token per bot ──► MeterBots :8770 ── Telethon ──► Telegram ──► the bots
```

## Why a separate container

Before 2026-10, the gas bot ran inside MeterCam. A Telegram session is a
logged-in account that has nothing to do with reading a dial, so it now lives
in its own LXC with its own backups, and MeterCam stays a camera service.
[`docs/architecture.md`](docs/architecture.md) covers this and the one rule
that comes with it: one session, one process, one conversation at a time.

## Layout

| Path | What |
| --- | --- |
| `service/tgclient.py` | The Telegram session: login, the lock every bot shares, and `Walk`, a conversation that records what the bot said |
| `service/gasbot.py` | The gas reading's walk through `@mygrmu_bot` |
| `service/yasnobot.py` | The electricity reading's walk through `@Yasnoonlinebot`, and `explore` for linking and re-mapping it |
| `service/app.py` | `/health`, `/gas/bot/*`, `/yasno/bot/*`; `VERSION` |
| `tests/` | `test_gasbot.py`, `test_yasnobot.py`, `test_tgclient.py`, `test_app.py` |
| `deploy/` | Creates LXC 105 on the Proxmox host and deploys the service into it |
| `.env.example` | Template for the box's `.env`: API credentials, tokens, account numbers |

## Tools

| Script | What it does | Changes anything live? |
| --- | --- | --- |
| `deploy/lxc_create.sh` | `pct create` LXC 105, start it, wait for DNS | **yes**: creates a container. Refuses if 105 exists |
| `deploy/lxc_provision.sh` | installs Docker in the LXC, creates `data/telegram` | yes, idempotent |
| `deploy/deploy.sh` | ships the code, builds, recreates, health-checks | yes, idempotent; never touches `.env` or the session |
| `deploy/_lxc_env.sh` | the container's spec, sourced by the three above | no |

## Tests

```sh
python tests/test_gasbot.py      # the gas walk, against a fake bot
python tests/test_yasnobot.py    # the YASNO walk, against a fake bot that edits in place
python tests/test_tgclient.py    # the shared walker, the lock, the JSON on failure
python tests/test_app.py         # the routes and tokens (needs flask)
sh Proxmox/tools/pve_ssh.sh "pct exec 105 -- docker exec meterbots python tests/test_gasbot.py"
```

None of them need Telegram or Telethon. CI runs them on every push.

## Setting it up

[`docs/deployment.md`](docs/deployment.md): the LXC, `.env`, the one-time
Telegram login, moving the session, and backups. HTTP:
[`docs/api.md`](docs/api.md).

## Docs

| Doc | About |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | Why its own LXC, why a Telegram user and not a bot, one session and one lock |
| [`docs/api.md`](docs/api.md) | The routes, their tokens, what they answer |
| [`docs/deployment.md`](docs/deployment.md) | LXC 105, `.env`, logging in, moving the session, backups |
| [`docs/gas-bot.md`](docs/gas-bot.md) | The gas reading: why a bot, the conversation, its checks |
| [`docs/yasno-bot.md`](docs/yasno-bot.md) | The electricity reading: the conversation, its checks, linking the account |
