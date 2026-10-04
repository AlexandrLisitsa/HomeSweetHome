"""service/yasnobot.py against a fake @Yasnoonlinebot that says what the real
one said on 2026-10-04. No network, no Telegram, no Telethon needed.

    python tests/test_yasnobot.py

The real bot answers a button by editing its message in place, and so does
this one. What it says after the two numbers had not been seen when this was
written, so both shapes are played: a confirmation question first, and a
verdict straight away.
"""
import asyncio
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

ACCOUNT = "520000000000"
ADDRESS = "м. Дніпро, вул. Тестова, буд. 1, к. 1"
MENU = ["📊 Передати показання", "📄 Мої особові рахунки", "💳 Оплатити",
        "⚡️ Відключення світла", "💬 Чат з оператором"]


class Btn:
    def __init__(self, text):
        self.text = text


class Msg:
    def __init__(self, bot, mid, text, rows=(), out=False):
        self.bot, self.id, self.out = bot, mid, out
        self.edit(text, rows)

    def edit(self, text, rows=()):
        self.raw_text = text
        self.buttons = [[Btn(t) for t in row] for row in rows] or None

    async def click(self, text):
        self.bot.clicked.append(text)
        self.bot.on_press(self, text)


class FakeBot:
    """The real bot's states. `quirk` changes one step; `after` is what it does
    with the two numbers: "confirm" asks first, "direct" answers at once."""

    def __init__(self, quirk=None, after="confirm", prev=("38108", "6384")):
        self.msgs, self.next_id, self.clicked, self.sent = [], 100, [], []
        self.quirk, self.after, self.prev = quirk, after, prev
        self.state, self.accepted = "menu", None

    def add(self, text, rows=(), out=False):
        self.next_id += 1
        self.msgs.append(Msg(self, self.next_id, text, rows, out))
        return self.msgs[-1]

    def accounts(self):
        rows = [] if self.quirk == "not_linked" else [["%s %s" % (ACCOUNT, ADDRESS)]]
        return rows + [["➕ Додати особовий рахунок"], ["🗑️ Видалити"], ["🏠 Головне меню"]]

    def prompt(self):
        account = ACCOUNT if self.quirk != "other_account" else "520000009999"
        zones = "3" if self.quirk == "three_zones" else "2"
        return ("Особовий рахунок: %s\nАдреса: %s\n\nЗонність лічильника: %s\n"
                "Останні активні показання на 31.08.2026\n\nДень: %s\nНіч: %s\n\n"
                "Введіть показання ДЕНЬ пробіл НІЧ (всі цифри до коми)."
                % (account, ADDRESS, zones, self.prev[0], self.prev[1]))

    def on_press(self, msg, t):
        """Buttons edit the message they are on, as the real bot does."""
        if "Головне меню" in t:
            self.state = "menu"
            msg.edit("Вас вітає електронний помічник YASNO!", [[b] for b in MENU])
        elif "Передати показання" in t and self.state == "menu":
            if self.quirk == "menu_changed":
                msg.edit("Сервіс тимчасово недоступний", [["🏠 Головне меню"]])
                return
            msg.edit("Для передачі показань оберіть особовий рахунок.", self.accounts())
        elif t.startswith(ACCOUNT):
            self.state = "value"
            msg.edit(self.prompt(), [["⬅️ Назад"], ["🏠 Головне меню"]])
        elif self.state == "confirm" and t.startswith("✅"):
            self.state, self.accepted = "menu", True
            msg.edit(self.verdict(), [["🏠 Головне меню"]])
        elif self.state == "confirm" and t.startswith("❌"):
            self.state = "menu"
            msg.edit("Передачу скасовано.", [["🏠 Головне меню"]])

    def verdict(self):
        if self.quirk == "rejected":
            return "Помилка: показання не прийнято, перевірте дані."
        if self.quirk == "unknown_answer":
            return "Ваш запит у роботі."
        return "Дякуємо! Ваші показання успішно прийнято."

    def on_text(self, t):
        if t == "/start":
            self.state = "menu"
            self.add("Вас вітає електронний помічник YASNO! Оберіть послугу.",
                     [[b] for b in MENU])
        elif self.state == "value":
            day, night = t.split()
            if self.quirk == "echo_wrong":
                day = "99999"
            if self.after == "confirm":
                self.state = "confirm"
                if self.quirk == "split_confirm":
                    self.add("Перевірте показання:\nДень: %s\nНіч: %s" % (day, night))
                    self.add("Підтверджуєте?", [["✅ Так", "❌ Ні"]])
                else:
                    self.add("Перевірте показання:\nДень: %s\nНіч: %s\nПідтверджуєте?"
                             % (day, night), [["✅ Так", "❌ Ні"]])
            else:
                self.state, self.accepted = "menu", self.quirk not in ("rejected",)
                self.add(self.verdict(), [["🏠 Головне меню"]])
            if self.quirk == "menu_alongside":
                # A menu keyboard after the answer: "так" is inside
                # "Контакти", "ні" inside "Ніч". Pressing either does nothing.
                self.add("Оберіть послугу:", [["📞 Контакти"], ["🌙 Показання за ніч"],
                                              ["🏠 Головне меню"]])


class FakeClient:
    def __init__(self, bot):
        self.bot = bot

    async def get_messages(self, entity, limit=20, min_id=0, ids=None):
        if ids is not None:
            return next((m for m in self.bot.msgs if m.id == ids), None)
        got = [m for m in self.bot.msgs if m.id > min_id]
        return list(reversed(got))[:limit]

    async def send_message(self, entity, text):
        self.bot.sent.append(text)
        m = self.bot.add(text, out=True)
        self.bot.on_text(text)
        return m


def walk(bot, day=None, night=None):
    from service import tgclient, yasnobot
    tgclient.QUIET_S, tgclient.REPLY_TIMEOUT_S, tgclient.POLL_S = 0.05, 2, 0.01
    cfg = {"account": ACCOUNT}

    async def go():
        w = tgclient.Walk(FakeClient(bot), "bot", watch_edits=True)
        await w.start()
        msgs, prev = await yasnobot._to_prompt(w, cfg)
        if day is None:
            await yasnobot._leave(w, msgs)
            return {"ok": True, "previous": prev}
        out = await yasnobot._submit(w, msgs, day, night, prev)
        return {"ok": out["ok"], "reply": out["reply"]}

    try:
        return asyncio.run(go())
    except tgclient.BotError as exc:
        return {"ok": False, "error": str(exc)}


checks = 0


def check(name, cond):
    global checks
    checks += 1
    print("  %s %s" % ("ok  " if cond else "FAIL", name))
    if not cond:
        sys.exit(1)


def typed_numbers(bot):
    return [s for s in bot.sent if s != "/start"]


print("yasnobot walk")
b = FakeBot()
r = walk(b)
check("status reads both previous readings and their date",
      r == {"ok": True, "previous": {"day": 38108, "night": 6384, "date": "31.08.2026"}})
check("status types nothing but /start", typed_numbers(b) == [])
check("status backs out to the main menu", b.state == "menu" and b.accepted is None)

b = FakeBot(after="confirm")
r = walk(b, 38500, 6450)
check("submit with a confirmation question is accepted", r["ok"] and b.accepted)
check("it typed exactly 'DAY NIGHT'", typed_numbers(b) == ["38500 6450"])
check("and pressed the confirm button", "✅ Так" in b.clicked)

b = FakeBot(after="direct")
r = walk(b, 38500, 6450)
check("submit answered at once is accepted", r["ok"] and "успішно" in r["reply"])

b = FakeBot(quirk="echo_wrong")
r = walk(b, 38500, 6450)
check("a confirmation with another number is refused",
      not r["ok"] and "✅ Так" not in b.clicked and "❌ Ні" in b.clicked)

b = FakeBot(quirk="rejected")
check("a refusal after confirming is a failure", not walk(b, 38500, 6450)["ok"])
b = FakeBot(quirk="rejected", after="direct")
r = walk(b, 38500, 6450)
check("a refusal straight away is a failure, and nothing is confirmed",
      not r["ok"] and not any(c.startswith("✅") for c in b.clicked))

b = FakeBot(quirk="unknown_answer")
r = walk(b, 38500, 6450)
check("an answer it does not know is a failure that says to check the chat",
      not r["ok"] and "check the chat" in r["error"])

b = FakeBot()
r = walk(b, 38000, 6450)
check("a day value below the previous one is never typed",
      not r["ok"] and typed_numbers(b) == [])
b = FakeBot()
r = walk(b, 38500, 6000)
check("a night value below the previous one is never typed",
      not r["ok"] and typed_numbers(b) == [])

b = FakeBot(quirk="not_linked")
r = walk(b, 38500, 6450)
check("an account not saved in the bot stops the walk",
      not r["ok"] and "not saved" in r["error"] and typed_numbers(b) == [])

b = FakeBot(quirk="other_account")
r = walk(b, 38500, 6450)
check("a prompt for another account stops before any number",
      not r["ok"] and typed_numbers(b) == [])

b = FakeBot(quirk="three_zones")
r = walk(b, 38500, 6450)
check("a prompt that is not two-zone stops before any number",
      not r["ok"] and typed_numbers(b) == [])

b = FakeBot(quirk="menu_changed")
r = walk(b, 38500, 6450)
check("a changed menu stops before any number", not r["ok"] and typed_numbers(b) == [])

print("which button is yes")
from service import yasnobot as yb
for label, want in [("✅ Так", "confirm"), ("Так", "confirm"), ("Так, підтверджую", "confirm"),
                    ("✔️ Підтвердити", "confirm"), ("❌ Ні", "cancel"), ("Скасувати", "cancel"),
                    ("📞 Контакти", None), ("🌙 Показання за ніч", None), ("Ніч", None),
                    ("Інші питання", None), ("🏠 Головне меню", None), ("", None)]:
    got = ("confirm" if yb._is(label, yb.BTN_CONFIRM)
           else "cancel" if yb._is(label, yb.BTN_CANCEL) else None)
    check("%r -> %s" % (label, want), got == want)

b = FakeBot(after="direct", quirk="menu_alongside")
r = walk(b, 38500, 6450)
check("a menu sent with the verdict is not a question: accepted, nothing pressed",
      r["ok"] and "📞 Контакти" not in b.clicked and "🌙 Показання за ніч" not in b.clicked)

b = FakeBot(after="confirm", quirk="menu_alongside")
r = walk(b, 38500, 6450)
check("a menu sent after the question: the question's yes is pressed, not Контакти",
      r["ok"] and b.accepted and "✅ Так" in b.clicked and "📞 Контакти" not in b.clicked)

b = FakeBot(after="confirm", quirk="split_confirm")
r = walk(b, 38500, 6450)
check("numbers in one message, yes/no in the next: confirmed", r["ok"] and b.accepted)

b = FakeBot(prev=("38 108", "6 384"))
check("'38 108' parses", walk(b)["previous"]["day"] == 38108)

print("%d checks passed" % checks)
