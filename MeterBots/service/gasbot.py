"""The monthly gas reading, handed to Gazmerezhi's Telegram bot (@mygrmu_bot).

Why a Telegram bot: every web channel for this operator is closed to code --
my.gas.ua challenges non-browser clients at Cloudflare, my.grmu.com.ua puts a
Turnstile captcha on its login, gas.ua's public form wants a Turnstile token
per submit. The bot is an official channel (Gazmerezhi, since 2025-10-27)
and Telegram's client API is meant to be driven by code. This logs in as the
household's own Telegram user (Telethon, MTProto) and walks the same buttons
a person would:

    account message ........ [📝 Передати показання]     inline button
    "Оберіть номер лічильника"  -> "<serial>"           keyboard button
    "Внесіть актуальні показання" (shows the last one) -> "2262"
    "Ви підтверджуєте відправку показань 2262 по лічильнику <serial>?" -> "Так"
    "…Ваші показання успішно прийняті"

Every step checks the bot's own words before taking the next one, and stops
with the bot's text when they do not match: a menu that changed must fail
loudly, never send a number to the wrong place. `status` walks to the value
prompt, reads the previous reading and backs out without sending anything.

Configuration, all in the environment (.env next to docker-compose.yml):

    TELEGRAM_API_ID, TELEGRAM_API_HASH   the session's credentials (tgclient.py)
    GASBOT_ACCOUNT                   the Gazmerezhi personal account (031...)
    GASBOT_COUNTER                   the meter serial as the bot shows it
    GASBOT_TOKEN                     what Home Assistant must send to use this
    GASBOT_BOT                       default mygrmu_bot

The Telegram session, its login and the conversation walker are shared by
every bot here and live in tgclient.py. A dry run from the command line:

    docker exec meterbots python -m service.gasbot status
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

from . import tgclient
from .tgclient import BotError, _buttons, _find_button, _norm, _number
from .tgclient import Walk  # noqa: F401 -- tests drive the walk through gasbot

# The bot's words, as of 2026-10-02. Matched loosely (case, emoji, spacing)
# but every one of them must appear before the next step is taken.
BTN_SUBMIT = "Передати показання"
BTN_MENU = "До головного меню"
BTN_ACCOUNTS = "До моїх рахунків"
BTN_YES = "Так"
TXT_PICK_COUNTER = "Оберіть номер лічильника"
TXT_ENTER_VALUE = "Внесіть актуальні показання"
TXT_CONFIRM = "Ви підтверджуєте відправку показань"
TXT_ACCEPTED = "успішно прийняті"
# What it says instead when a reading already went in today: it keeps the
# first one and takes nothing new, so this is NOT a success for the new value.
TXT_ALREADY_TODAY = "Сьогодні я прийняв Ваші показання"



def settings():
    env = os.environ
    missing = [k for k in ("GASBOT_ACCOUNT", "GASBOT_COUNTER") if not env.get(k)]
    if missing:
        raise BotError("not configured: %s missing in .env" % ", ".join(missing))
    return {**tgclient.api_settings(),
            "account": env["GASBOT_ACCOUNT"].strip(),
            "counter": env["GASBOT_COUNTER"].strip(),
            "bot": env.get("GASBOT_BOT", "mygrmu_bot").lstrip("@")}


async def _to_value_prompt(walk, cfg):
    """From wherever the chat is, to "Внесіть актуальні показання".

    Returns (messages, previous_reading, previous_date).
    """
    # The account card carries the button. /start lands on the main menu,
    # whose route to the card is "my accounts" and then the account itself.
    # The main menu has a "Передати показання" of its own, but it does not
    # say for which account; only the account card does. So the walk goes
    # "📁 Особові рахунки" -> the account -> the card's button, and presses
    # it only on a message that names THIS account -- on another account's
    # card it would file the reading against someone else's meter.
    def card_of(msgs):
        for msg in reversed(msgs):
            if (cfg["account"] in (msg.raw_text or "")
                    and any(_norm(BTN_SUBMIT) in _norm(t) for t in _buttons(msg))):
                return msg
        return None

    msgs = await walk.say("/start")
    for _ in range(4):
        card = card_of(msgs)
        if card is not None:
            break
        if _find_button(msgs, cfg["account"])[0] is not None:
            msgs = await walk.press(msgs, cfg["account"])
        elif _find_button(msgs, "рахунк")[0] is not None:
            msgs = await walk.press(msgs, "рахунк")
        else:
            walk.fail("cannot find the way from the main menu to account %s" % cfg["account"])
    else:
        walk.fail("no account card for %s after four steps" % cfg["account"])

    label = next(t for t in _buttons(card) if _norm(BTN_SUBMIT) in _norm(t))
    walk.transcript.append({"me": "[%s]" % label})
    await card.click(text=label)
    msgs = await walk._collect()
    text = "\n".join(m.raw_text or "" for m in msgs)
    if _norm(TXT_PICK_COUNTER) not in _norm(text) or cfg["counter"] not in text:
        walk.fail("expected the meter list with %s" % cfg["counter"])

    msgs = await walk.press(msgs, cfg["counter"])
    text = "\n".join(m.raw_text or "" for m in msgs)
    if _norm(TXT_ENTER_VALUE) not in _norm(text):
        walk.fail("expected the prompt for the new reading")
    prev = re.search(r"попередній період:\s*([\d\s ]+[.,]?\d*)", text)
    date = re.search(r"останнього показання:\s*([\d.]+)", text)
    return (msgs, _number(prev.group(1)) if prev else None,
            date.group(1) if date else None)


async def _leave(walk, msgs):
    """Back to the main menu, so no half-finished entry is left waiting."""
    try:
        if _find_button(msgs, BTN_MENU)[0] is not None:
            await walk.press(msgs, BTN_MENU)
    except BotError:
        pass


async def _run(cfg, value=None):
    async with tgclient.conversation(cfg, cfg["bot"]) as walk:
        msgs, prev, prev_date = await _to_value_prompt(walk, cfg)

        if value is None:
            await _leave(walk, msgs)
            return {"ok": True, "previous": prev, "previous_date": prev_date,
                    "transcript": walk.transcript}
        out = await _submit(walk, cfg, msgs, value, prev)
        out["transcript"] = walk.transcript
        return out


async def _submit(walk, cfg, msgs, value, prev):
    """From the value prompt: type the reading, check the echo, confirm."""
    if prev is not None and value < prev:
        await _leave(walk, msgs)
        walk.fail("%s is below the previous reading %s" % (value, prev))

    shown = str(int(value)) if float(value).is_integer() else "%.2f" % value
    msgs = await walk.say(shown)
    text = "\n".join(m.raw_text or "" for m in msgs)
    # The confirmation repeats both numbers. Both must be ours.
    if _norm(TXT_CONFIRM) not in _norm(text):
        await _leave(walk, msgs)
        if _norm(TXT_ALREADY_TODAY) in _norm(text):
            walk.fail("the bot already took a reading from this account today and "
                      "kept that one; %s was not sent." % shown)
        walk.fail("the bot did not ask to confirm: %s" % text.strip()[:300])
    if not re.search(r"\b%s\b" % re.escape(shown), text) or cfg["counter"] not in text:
        await walk.press(msgs, "Ні")
        walk.fail("the confirmation names another value or meter: %s" % text.strip()[:300])

    msgs = await walk.press(msgs, BTN_YES)
    text = "\n".join(m.raw_text or "" for m in msgs)
    accepted = _norm(TXT_ACCEPTED) in _norm(text)
    await _leave(walk, msgs)
    if not accepted and _norm(TXT_ALREADY_TODAY) in _norm(text):
        walk.fail("the bot already took a reading from this account today and "
                  "kept that one; %s was not sent. Try again tomorrow if it "
                  "should replace it." % shown)
    if not accepted:
        walk.fail("the bot did not accept it: %s" % text.strip()[:300])
    reply = next((m.raw_text for m in msgs if _norm(TXT_ACCEPTED) in _norm(m.raw_text)), text)
    return {"ok": True, "value": shown, "previous": prev, "reply": reply.strip()}


def run(value=None):
    """Blocking entry point for the Flask routes. One conversation at a time,
    across every bot (tgclient.LOCK)."""
    def go():
        return _run(settings(), value)
    return tgclient.blocking(go)


def main():
    ap = argparse.ArgumentParser(description="Gas reading via @mygrmu_bot")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status", help="walk to the reading prompt and back; send nothing")
    ap.parse_args()
    out = run()
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
