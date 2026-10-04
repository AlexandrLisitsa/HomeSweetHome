# Architecture

## Who decides what

| Part | Job |
| --- | --- |
| MeterCam (LXC 104) | reads meter dials; reports a reading only if it can stand behind it |
| Home Assistant | when to ask, what to offer, the phone notification and its buttons, which months already went in |
| MeterBots (LXC 105) | walks a supplier's Telegram bot and reports exactly what the bot said |

MeterBots never starts anything itself. Every conversation is a request from
Home Assistant (or a person running a dry run), and a reading reaches a bot
only through a `POST` that a tap on the phone caused.

## Why its own LXC

A Telegram session is a logged-in account. It can read and send as the
household, so it deserves a small box of its own:

- its own backups, as a small encrypted state archive (`.env` and the
  session, not the whole container) rather than files inside a camera's state;
- nothing else running next to it that could read `/data`;
- MeterCam can be rebuilt, resized or moved without touching the session.

It used to live in MeterCam (LXC 104) and moved out on 2026-10-04, when a
second bot was about to join it.

## Why a Telegram user and not a Telegram bot

The suppliers' bots talk to people. A Bot API bot cannot message another bot,
so the only way to drive `@mygrmu_bot` from code is as a user, through
Telegram's client API (MTProto, here Telethon). The suppliers' web cabinets are
behind captchas and Cloudflare challenges; their Telegram bots are official
channels that code may use (see each bot's doc).

## One session, one process, one conversation

- **One session file**, `data/telegram/telegram.session`, used by every bot.
- **One lock** (`tgclient.LOCK`): Telethon cannot run two conversations on one
  session file, so a second request waits until the first is done. A walk
  takes up to a minute, and Home Assistant's `rest_command` timeout is 5.
- **Never two places at once.** Telegram may revoke an authorisation key that
  it sees in use from two connections (`AUTH_KEY_DUPLICATED`), which logs the
  household out. So the session file is only ever **moved**, never copied to a
  second running service ([`deployment.md`](deployment.md)).

## What every walk does

`tgclient.Walk` sends a text or presses a button, then collects the bot's
answer once it has been quiet for 1.5 s, because bots often answer in two
messages. Every step checks the bot's own words before taking the next one.
A menu that changed stops the walk with the screen quoted (`BotError` plus a
transcript), and never sends a number to a screen the code does not recognise.
Each bot's doc lists its own checks.
