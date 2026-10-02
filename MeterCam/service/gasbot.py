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

    GASBOT_API_ID, GASBOT_API_HASH   https://my.telegram.org -> API development tools
    GASBOT_ACCOUNT                   the Gazmerezhi personal account (031...)
    GASBOT_COUNTER                   the meter serial as the bot shows it
    GASBOT_TOKEN                     what Home Assistant must send to use this
    GASBOT_BOT                       default mygrmu_bot

The Telegram session is /data/telegram/gasbot.session. It is a logged-in
Telegram account: whoever has the file can read and send as the household.
It ends when the device is terminated in Telegram -> Settings -> Devices.

Login, once, inside the container (two non-interactive steps, because the
code arrives in the Telegram app between them):

    docker exec metercam python -m service.gasbot login --phone +380XXXXXXXXX
    docker exec metercam python -m service.gasbot login --code 12345 [--password <2FA>]
    docker exec metercam python -m service.gasbot status

If the code never arrives (Telegram can say it sent one "in the app" and
deliver nothing), log in by QR instead: `login --qr` draws a code to
data/telegram/login-qr.svg; scan it in Telegram -> Settings -> Devices ->
Link Desktop Device.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import pathlib
import re
import sys
import threading
import time

SESSION_DIR = pathlib.Path(os.environ.get("GASBOT_SESSION_DIR", "/data/telegram"))
SESSION = SESSION_DIR / "gasbot"           # Telethon appends .session
PENDING = SESSION_DIR / "login_pending.json"

# How long to wait for the bot after each action, and how long it must stay
# quiet before its answer counts as complete (it often sends two messages).
REPLY_TIMEOUT_S = 25
QUIET_S = 1.5
POLL_S = 0.4

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

_LOCK = threading.Lock()


class BotError(Exception):
    """The bot did not answer the way it did when this was written."""

    def __init__(self, msg, transcript=None):
        super().__init__(msg)
        self.transcript = transcript or []


def settings():
    env = os.environ
    missing = [k for k in ("GASBOT_API_ID", "GASBOT_API_HASH", "GASBOT_ACCOUNT",
                           "GASBOT_COUNTER") if not env.get(k)]
    if missing:
        raise BotError("not configured: %s missing in .env" % ", ".join(missing))
    return {"api_id": int(env["GASBOT_API_ID"]), "api_hash": env["GASBOT_API_HASH"],
            "account": env["GASBOT_ACCOUNT"].strip(),
            "counter": env["GASBOT_COUNTER"].strip(),
            "bot": env.get("GASBOT_BOT", "mygrmu_bot").lstrip("@")}


def _norm(s):
    return re.sub(r"\s+", " ", (s or "")).strip().lower()


def _buttons(msg):
    """Every button label on a message, inline or keyboard."""
    out = []
    for row in (msg.buttons or []):
        for b in row:
            out.append(b.text or "")
    return out


def _find_button(msgs, label):
    """The newest message carrying a button whose label contains `label`."""
    want = _norm(label)
    for msg in reversed(msgs):
        for text in _buttons(msg):
            if want in _norm(text):
                return msg, text
    return None, None


def _number(text):
    """'2245,00' / '2245.00' / '2 245,00' -> 2245.0"""
    return float(text.replace(" ", "").replace(" ", "").replace(",", "."))


class Walk:
    """One conversation with the bot, with a transcript of what it said."""

    def __init__(self, client, bot):
        self.client = client
        self.bot = bot
        self.transcript = []
        self.last_id = 0

    async def start(self):
        latest = await self.client.get_messages(self.bot, limit=1)
        self.last_id = latest[0].id if latest else 0

    async def _collect(self):
        """Bot messages newer than the last action, once it has gone quiet."""
        deadline = time.monotonic() + REPLY_TIMEOUT_S
        got, quiet_since = [], None
        while time.monotonic() < deadline:
            new = await self.client.get_messages(self.bot, min_id=self.last_id, limit=20)
            new = sorted((m for m in new if not m.out), key=lambda m: m.id)
            if new:
                got.extend(new)
                self.last_id = max(m.id for m in new)
                quiet_since = time.monotonic()
                for m in new:
                    self.transcript.append({"bot": m.raw_text, "buttons": _buttons(m)})
            elif got and time.monotonic() - quiet_since >= QUIET_S:
                return got
            await asyncio.sleep(POLL_S)
        if got:
            return got
        raise BotError("the bot did not answer within %d s" % REPLY_TIMEOUT_S,
                       self.transcript)

    async def say(self, text):
        self.transcript.append({"me": text})
        sent = await self.client.send_message(self.bot, text)
        self.last_id = max(self.last_id, sent.id)
        return await self._collect()

    async def press(self, msgs, label):
        msg, text = _find_button(msgs, label)
        if msg is None:
            raise BotError("no '%s' button where it used to be" % label, self.transcript)
        self.transcript.append({"me": "[%s]" % text})
        await msg.click(text=text)
        return await self._collect()

    def fail(self, msg):
        raise BotError(msg, self.transcript)


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
    from telethon import TelegramClient

    client = TelegramClient(str(SESSION), cfg["api_id"], cfg["api_hash"])
    await client.connect()
    try:
        if not await client.is_user_authorized():
            raise BotError("Telegram session is not logged in -- run the login steps")
        bot = await client.get_entity(cfg["bot"])
        walk = Walk(client, bot)
        await walk.start()
        msgs, prev, prev_date = await _to_value_prompt(walk, cfg)

        if value is None:
            await _leave(walk, msgs)
            return {"ok": True, "previous": prev, "previous_date": prev_date,
                    "transcript": walk.transcript}
        out = await _submit(walk, cfg, msgs, value, prev)
        out["transcript"] = walk.transcript
        return out
    finally:
        await client.disconnect()


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
    """Blocking entry point for the Flask routes. One conversation at a time."""
    with _LOCK:
        try:
            return asyncio.run(_run(settings(), value))
        except BotError as exc:
            return {"ok": False, "error": str(exc), "transcript": exc.transcript}
        except Exception as exc:        # noqa: BLE001 -- the caller needs JSON
            return {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}


# ---------------------------------------------------------------------------
# Login, from the command line inside the container
# ---------------------------------------------------------------------------

QR_FILE = SESSION_DIR / "login-qr.svg"
QR_WAIT_S = 240


async def _qr_login(client, password=None):
    """Log in by scanning a QR code: Telegram -> Settings -> Devices -> Link
    Desktop Device. For when the login code never shows up in the app.

    The code is drawn to data/telegram/login-qr.svg and redrawn every time
    Telegram rotates the token (about every 30 s), until it is scanned or
    QR_WAIT_S runs out. The file is deleted afterwards either way.
    """
    import qrcode
    import qrcode.image.svg
    from telethon.errors import SessionPasswordNeededError

    deadline = time.monotonic() + QR_WAIT_S
    qr = await client.qr_login()
    try:
        while True:
            img = qrcode.make(qr.url, image_factory=qrcode.image.svg.SvgPathFillImage,
                              box_size=12, border=4)
            tmp = QR_FILE.with_suffix(".part")
            with open(tmp, "wb") as fh:
                img.save(fh)
            os.chmod(tmp, 0o600)
            os.replace(tmp, QR_FILE)
            left = deadline - time.monotonic()
            if left <= 0:
                return {"ok": False, "error": "nobody scanned the QR code in time"}
            try:
                await qr.wait(timeout=min(left, 25))
                break
            except asyncio.TimeoutError:
                await qr.recreate()
            except SessionPasswordNeededError:
                if not password:
                    return {"ok": False, "error": "scanned, but this account has a 2FA "
                                                  "password; run login --qr --password <pw>"}
                await client.sign_in(password=password)
                break
    finally:
        QR_FILE.unlink(missing_ok=True)
    me = await client.get_me()
    return {"ok": True, "logged_in_as": me.first_name}


async def _login(cfg, phone=None, code=None, password=None, qr=False):
    from telethon import TelegramClient
    from telethon.errors import SessionPasswordNeededError

    SESSION_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(SESSION_DIR, 0o700)
    client = TelegramClient(str(SESSION), cfg["api_id"], cfg["api_hash"])
    await client.connect()
    try:
        if await client.is_user_authorized():
            me = await client.get_me()
            return {"ok": True, "logged_in_as": me.first_name}
        if phone:
            from telethon.errors import FloodWaitError
            try:
                sent = await client.send_code_request(phone)
            except FloodWaitError as exc:
                return {"ok": False, "error": "Telegram asks to wait %d s before "
                                              "another code" % exc.seconds}
            PENDING.write_text(json.dumps({"phone": phone, "hash": sent.phone_code_hash}))
            os.chmod(PENDING, 0o600)
            # Where the code went: SentCodeTypeApp is the "Telegram" service
            # chat in the app, SentCodeTypeSms a text message, and so on.
            via = type(sent.type).__name__.replace("SentCodeType", "")
            nxt = type(sent.next_type).__name__.replace("CodeType", "") if sent.next_type else None
            return {"ok": True, "delivered_via": via, "fallback_if_resent": nxt,
                    "next": "run login --code <code>"}
        if code:
            pending = json.loads(PENDING.read_text())
            try:
                await client.sign_in(pending["phone"], code,
                                     phone_code_hash=pending["hash"])
            except SessionPasswordNeededError:
                if not password:
                    return {"ok": False, "error": "this account has a 2FA password; "
                                                  "run login --code <code> --password <pw>"}
                await client.sign_in(password=password)
            PENDING.unlink(missing_ok=True)
            me = await client.get_me()
            return {"ok": True, "logged_in_as": me.first_name}
        if qr:
            return await _qr_login(client, password)
        return {"ok": False, "error": "login needs --phone, --code or --qr"}
    finally:
        await client.disconnect()
        for f in SESSION_DIR.glob("gasbot.session*"):
            os.chmod(f, 0o600)


def main():
    ap = argparse.ArgumentParser(description="Gas reading via @mygrmu_bot")
    sub = ap.add_subparsers(dest="cmd", required=True)
    lg = sub.add_parser("login")
    lg.add_argument("--phone")
    lg.add_argument("--code")
    lg.add_argument("--password")
    lg.add_argument("--qr", action="store_true",
                    help="scan a QR code instead of typing a login code")
    sub.add_parser("status")
    args = ap.parse_args()
    if args.cmd == "login":
        try:
            out = asyncio.run(_login(settings(), args.phone, args.code, args.password,
                                     args.qr))
        except Exception as exc:        # noqa: BLE001
            out = {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}
    else:
        out = run()
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
