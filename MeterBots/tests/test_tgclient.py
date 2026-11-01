"""service/tgclient.py on its own: the walker every bot uses, the lock they
share, and the JSON the routes get back whatever goes wrong. A fake client,
no Telegram, no Telethon.

    python tests/test_tgclient.py
"""
import asyncio
import os
import pathlib
import sys
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from service import tgclient  # noqa: E402

tgclient.QUIET_S, tgclient.REPLY_TIMEOUT_S, tgclient.POLL_S = 0.05, 0.5, 0.01

checks = 0


def check(name, cond, got=""):
    global checks
    checks += 1
    print("  %s %s %s" % ("ok  " if cond else "FAIL", name, "" if cond else got))
    if not cond:
        sys.exit(1)


class Btn:
    def __init__(self, text):
        self.text = text


class Msg:
    def __init__(self, mid, text, rows=(), out=False):
        self.id, self.raw_text, self.out = mid, text, out
        self.buttons = [[Btn(t) for t in row] for row in rows] or None
        self.clicked = []

    async def click(self, text):
        self.clicked.append(text)


class FakeClient:
    """A chat whose bot answers each text with `replies[text]`: a list of
    (delay_s, text, rows) sent after the given delay."""

    def __init__(self, replies):
        self.msgs, self.next_id, self.replies, self.pending = [], 10, replies, []

    def add(self, text, rows=(), out=False):
        self.next_id += 1
        self.msgs.append(Msg(self.next_id, text, rows, out))
        return self.msgs[-1]

    async def get_messages(self, entity, limit=20, min_id=0):
        now = time.monotonic()
        for due, text, rows in [p for p in self.pending if p[0] <= now]:
            self.add(text, rows)
        self.pending = [p for p in self.pending if p[0] > now]
        got = [m for m in self.msgs if m.id > min_id]
        return list(reversed(got))[:limit]

    async def send_message(self, entity, text):
        m = self.add(text, out=True)
        now = time.monotonic()
        for delay, reply, rows in self.replies.get(text, []):
            self.pending.append((now + delay, reply, rows))
        return m


def walk(client):
    w = tgclient.Walk(client, "bot")
    asyncio.run(w.start())
    return w


print("the walker")
c = FakeClient({"/start": [(0, "Menu", [["A"], ["B"]]), (0.02, "Second message", ())]})
w = walk(c)
got = asyncio.run(w.say("/start"))
check("collects both messages of a two-part answer", [m.raw_text for m in got] ==
      ["Menu", "Second message"], [m.raw_text for m in got])
check("the transcript has what was said and the buttons",
      w.transcript[0] == {"me": "/start"} and w.transcript[1]["buttons"] == ["A", "B"],
      w.transcript)
check("its own messages are not answers", all(not m.out for m in got))

c = FakeClient({})
w = walk(c)
try:
    asyncio.run(w.say("/start"))
    check("silence raises", False)
except tgclient.BotError as exc:
    check("silence raises BotError, with the transcript so far",
          "did not answer" in str(exc) and exc.transcript == [{"me": "/start"}])

c = FakeClient({"/start": [(0, "Menu", [["📊 Передати показання"], ["Інше"]])]})
w = walk(c)
msgs = asyncio.run(w.say("/start"))
try:
    asyncio.run(w.press(msgs, "Видалити"))
    check("a missing button raises", False)
except tgclient.BotError as exc:
    check("a missing button raises BotError naming it", "Видалити" in str(exc))
msg, text = tgclient._find_button(msgs, "передати  ПОКАЗАННЯ")
check("buttons match loosely: case, spacing, emoji", text == "📊 Передати показання")

print("a bot that edits its message instead of answering")


class EditingClient(FakeClient):
    """Pressing a button edits that very message, as YASNO's bot does."""

    async def get_messages(self, entity, limit=20, min_id=0, ids=None):
        if ids is not None:
            return next((m for m in self.msgs if m.id == ids), None)
        return await super().get_messages(entity, limit, min_id)


c = EditingClient({"/start": [(0, "Menu", [["📊 Передати показання"]])]})
w = tgclient.Walk(c, "bot", watch_edits=True)
asyncio.run(w.start())
msgs = asyncio.run(w.say("/start"))
menu = msgs[0]


async def edit_on_click(text):
    menu.clicked.append(text)
    menu.raw_text = "Оберіть особовий рахунок"
    menu.buttons = [[Btn("520000000000")]]
menu.click = edit_on_click
got = asyncio.run(w.press(msgs, "Передати"))
check("with watch_edits, the edited message is the answer",
      [m.raw_text for m in got] == ["Оберіть особовий рахунок"], [m.raw_text for m in got])

c = EditingClient({"/start": [(0, "Menu", [["A"]])]})
w = tgclient.Walk(c, "bot", watch_edits=True)
asyncio.run(w.start())
msgs = asyncio.run(w.say("/start"))
try:
    asyncio.run(w.press(msgs, "A"))     # the click changes nothing
    check("an unchanged message is not an answer", False)
except tgclient.BotError:
    check("an unchanged message is not an answer: it still times out", True)

c = EditingClient({"/start": [(0, "Menu", [["A"]])]})
w = tgclient.Walk(c, "bot")             # watch_edits off, as for the gas bot
asyncio.run(w.start())
msgs = asyncio.run(w.say("/start"))
menu = msgs[0]


async def edit_quietly(text):
    menu.raw_text = "edited"
menu.click = edit_quietly
try:
    asyncio.run(w.press(msgs, "A"))
    check("without watch_edits an edit is not seen", False)
except tgclient.BotError:
    check("without watch_edits an edit is not seen (the gas walk is unchanged)", True)

print("parsing")
for raw, want in [("2245", 2245.0), ("2245,50", 2245.5), ("2 245,50", 2245.5),
                  ("2 245.5", 2245.5)]:
    check("_number(%r) == %r" % (raw, want), tgclient._number(raw) == want)

print("configuration")
for k in ("TELEGRAM_API_ID", "TELEGRAM_API_HASH"):
    os.environ.pop(k, None)
try:
    tgclient.api_settings()
    check("missing API credentials raise", False)
except tgclient.BotError as exc:
    check("missing API credentials raise, naming both",
          "TELEGRAM_API_ID" in str(exc) and "TELEGRAM_API_HASH" in str(exc))

print("blocking(): the lock and the JSON")


async def boom():
    raise tgclient.BotError("the bot changed", [{"me": "/start"}])


async def crash():
    raise RuntimeError("socket closed")


r = tgclient.blocking(boom)
check("a BotError becomes {ok: false, error, transcript}",
      r == {"ok": False, "error": "the bot changed", "transcript": [{"me": "/start"}]}, r)
r = tgclient.blocking(crash)
check("anything else becomes {ok: false, error}",
      r == {"ok": False, "error": "RuntimeError: socket closed"}, r)

order = []


async def slow(name):
    order.append(name + " in")
    await asyncio.sleep(0.2)
    order.append(name + " out")
    return {"ok": True}


threads = [threading.Thread(target=tgclient.blocking, args=(slow, n)) for n in ("gas", "yasno")]
for t in threads:
    t.start()
    time.sleep(0.02)
for t in threads:
    t.join()
check("two bots never talk at once: one conversation ends before the next starts",
      order == ["gas in", "gas out", "yasno in", "yasno out"], order)

print("session_check")
import tempfile
import types

events = []


class FakeTelegramClient:
    authorized = True

    def __init__(self, session, api_id, api_hash):
        events.append(("new", api_id))

    async def connect(self):
        events.append("connect")

    async def is_user_authorized(self):
        return FakeTelegramClient.authorized

    async def disconnect(self):
        events.append("disconnect")


sys.modules["telethon"] = types.SimpleNamespace(TelegramClient=FakeTelegramClient)
os.environ["TELEGRAM_API_ID"], os.environ["TELEGRAM_API_HASH"] = "12345", "hash"
tmp = pathlib.Path(tempfile.mkdtemp())
tgclient.SESSION = tmp / "telegram"
check("no session file: says so, Telegram not asked",
      tgclient.session_check() == {"ok": False, "error": "no session file -- run the login steps"}
      and events == [])
(tmp / "telegram.session").write_bytes(b"x")
check("logged in: authorized", tgclient.session_check() == {"ok": True, "authorized": True})
check("connected once and disconnected", events == [("new", 12345), "connect", "disconnect"],
      events)
FakeTelegramClient.authorized = False
events.clear()
r = tgclient.session_check()
check("logged out: a failure that says to log in",
      not r["ok"] and "not logged in" in r["error"], r)
check("and it still disconnects", events[-1] == "disconnect", events)
os.environ.pop("TELEGRAM_API_ID")
r = tgclient.session_check()
check("no API credentials: a failure, not an exception",
      not r["ok"] and "TELEGRAM_API_ID" in r["error"], r)

print("%d checks passed" % checks)
