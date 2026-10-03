"""The household's Telegram session, shared by every bot this service drives.

One logged-in Telegram user (Telethon, MTProto) talks to the suppliers' bots
the way a person would. This module holds what they share: the session, the
login, the lock, and Walk, a conversation that records everything the bot said.
Each bot (gasbot.py, yasnobot.py) holds only its own conversation.

The session file is /data/telegram/telegram.session. It is a logged-in
Telegram account: whoever has the file can read and send as the household. It
ends when the device is terminated in Telegram -> Settings -> Devices.

ONE PROCESS, ONE CONVERSATION AT A TIME. Telethon cannot use one session file
from two conversations at once, so every conversation, whichever bot it is
with, holds LOCK for its whole length. And never run the same session in two
places: Telegram may revoke an authorisation key it sees used from two
connections at once (AUTH_KEY_DUPLICATED). Moving it is in docs/deployment.md.

    TELEGRAM_API_ID, TELEGRAM_API_HASH   https://my.telegram.org -> API development tools

Login, once, inside the container (two non-interactive steps, because the
code arrives in the Telegram app between them):

    docker exec meterbots python -m service.tgclient login --phone +380XXXXXXXXX
    docker exec meterbots python -m service.tgclient login --code 12345 [--password <2FA>]

If the code never arrives (Telegram can say it sent one "in the app" and
deliver nothing), log in by QR instead: `login --qr` draws a code to
data/telegram/login-qr.svg; scan it in Telegram -> Settings -> Devices ->
Link Desktop Device.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import pathlib
import re
import sys
import threading
import time

SESSION_DIR = pathlib.Path(os.environ.get("TELEGRAM_SESSION_DIR", "/data/telegram"))
SESSION = SESSION_DIR / "telegram"           # Telethon appends .session
PENDING = SESSION_DIR / "login_pending.json"

# How long to wait for the bot after each action, and how long it must stay
# quiet before its answer counts as complete (bots often send two messages).
REPLY_TIMEOUT_S = 25
QUIET_S = 1.5
POLL_S = 0.4

# One conversation at a time, across all bots: they share the session file.
LOCK = threading.Lock()


class BotError(Exception):
    """The bot did not answer the way it did when this was written."""

    def __init__(self, msg, transcript=None):
        super().__init__(msg)
        self.transcript = transcript or []


def api_settings():
    """The Telegram API credentials: the part of the config every bot needs."""
    env = os.environ
    missing = [k for k in ("TELEGRAM_API_ID", "TELEGRAM_API_HASH") if not env.get(k)]
    if missing:
        raise BotError("not configured: %s missing in .env" % ", ".join(missing))
    return {"api_id": int(env["TELEGRAM_API_ID"]), "api_hash": env["TELEGRAM_API_HASH"]}


def session_present():
    return SESSION.with_suffix(".session").exists()


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


def _text(msgs):
    return "\n".join(m.raw_text or "" for m in msgs)


def _look(msg):
    return (msg.raw_text or "", tuple(_buttons(msg)))


class Walk:
    """One conversation with a bot, with a transcript of what it said.

    Some bots answer a button press by EDITING the message the button was on
    (YASNO's does) instead of sending a new one. With watch_edits, a press
    also watches that message, and its new text and buttons count as the
    answer. Off by default: Gazmerezhi's bot sends new messages, and its walk
    is tested that way.
    """

    def __init__(self, client, bot, watch_edits=False):
        self.client = client
        self.bot = bot
        self.watch_edits = watch_edits
        self.transcript = []
        self.last_id = 0
        self._watched = None        # (message id, how it looked before the press)

    async def start(self):
        latest = await self.client.get_messages(self.bot, limit=1)
        self.last_id = latest[0].id if latest else 0

    async def _edited(self):
        """The watched message, if the bot has changed it since the press."""
        if self._watched is None:
            return []
        mid, before = self._watched
        msg = await self.client.get_messages(self.bot, ids=mid)
        if msg is None or _look(msg) == before:
            return []
        self._watched = (mid, _look(msg))
        return [msg]

    async def _collect(self):
        """Bot messages newer than the last action (and, with watch_edits, the
        pressed message once the bot has changed it), once it has gone quiet."""
        deadline = time.monotonic() + REPLY_TIMEOUT_S
        got, quiet_since = [], None
        while time.monotonic() < deadline:
            new = await self.client.get_messages(self.bot, min_id=self.last_id, limit=20)
            new = sorted((m for m in new if not m.out), key=lambda m: m.id)
            if new:
                self.last_id = max(m.id for m in new)
            new += await self._edited()
            if new:
                got.extend(new)
                quiet_since = time.monotonic()
                for m in new:
                    self.transcript.append({"bot": m.raw_text, "buttons": _buttons(m)})
            elif got and time.monotonic() - quiet_since >= QUIET_S:
                self._watched = None
                return got
            await asyncio.sleep(POLL_S)
        self._watched = None
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
        if self.watch_edits:
            self._watched = (msg.id, _look(msg))
        await msg.click(text=text)
        return await self._collect()

    def fail(self, msg):
        raise BotError(msg, self.transcript)


@contextlib.asynccontextmanager
async def conversation(api, bot_name, watch_edits=False):
    """A connected, logged-in client and a started Walk with `bot_name`."""
    from telethon import TelegramClient

    client = TelegramClient(str(SESSION), api["api_id"], api["api_hash"])
    await client.connect()
    try:
        if not await client.is_user_authorized():
            raise BotError("Telegram session is not logged in -- run the login steps")
        bot = await client.get_entity(bot_name)
        walk = Walk(client, bot, watch_edits)
        await walk.start()
        yield walk
    finally:
        await client.disconnect()


def blocking(coro_fn, *args):
    """Run one conversation from a Flask route: locked, always JSON back."""
    with LOCK:
        try:
            return asyncio.run(coro_fn(*args))
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


async def login(api, phone=None, code=None, password=None, qr=False):
    from telethon import TelegramClient
    from telethon.errors import SessionPasswordNeededError

    SESSION_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(SESSION_DIR, 0o700)
    client = TelegramClient(str(SESSION), api["api_id"], api["api_hash"])
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
        for f in SESSION_DIR.glob("telegram.session*"):
            os.chmod(f, 0o600)


def main():
    ap = argparse.ArgumentParser(description="The household's Telegram session")
    sub = ap.add_subparsers(dest="cmd", required=True)
    lg = sub.add_parser("login")
    lg.add_argument("--phone")
    lg.add_argument("--code")
    lg.add_argument("--password")
    lg.add_argument("--qr", action="store_true",
                    help="scan a QR code instead of typing a login code")
    args = ap.parse_args()
    try:
        out = asyncio.run(login(api_settings(), args.phone, args.code, args.password,
                                args.qr))
    except Exception as exc:        # noqa: BLE001
        out = {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
