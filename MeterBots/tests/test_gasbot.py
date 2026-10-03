"""service/gasbot.py against a fake @mygrmu_bot that says what the real one
said on 2026-10-02. No network, no Telegram, no Telethon needed.

    python tests/test_gasbot.py
"""
import asyncio
import os
import pathlib
import sys
import types

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

ACCOUNT, COUNTER = "0310000000", "06000000"
CARD = ("Особовий рахунок %s.\nАдреса: Дніпро\n\nБаланс Вашого рахунку: 0 грн." % ACCOUNT)


class Btn:
    def __init__(self, text):
        self.text = text


class Msg:
    def __init__(self, bot, mid, text, rows=(), out=False):
        self.bot, self.id, self.raw_text, self.out = bot, mid, text, out
        self.buttons = [[Btn(t) for t in row] for row in rows] or None

    async def click(self, text):
        self.bot.clicked.append(text)
        self.bot.on_input(text)


class FakeBot:
    """The real bot's states, from the screenshots. `quirk` breaks one step."""

    def __init__(self, quirk=None, prev="2245,00"):
        self.msgs, self.next_id, self.clicked, self.sent = [], 100, [], []
        self.quirk, self.prev, self.state, self.accepted = quirk, prev, "menu", None
        self.used_menu_submit = False

    def add(self, text, rows=(), out=False):
        self.next_id += 1
        self.msgs.append(Msg(self, self.next_id, text, rows, out))
        return self.msgs[-1]

    def on_input(self, t):
        if "До головного меню" in t:
            self.state = "menu"
            self.add("Головне меню", [["Мої рахунки"]])
        elif t == "/start":
            # As on 2026-10-02: the main menu has its own, account-less
            # "Передати показання", which the walk must NOT use.
            self.add("Оберіть потрібний розділ меню послуг:",
                     [["📁 Особові рахунки"], ["📩 Передати показання"], ["Завантажити Куб"],
                      ["🤝Сплатити"], ["👋 Мій профіль"]])
        elif t == "📩 Передати показання":
            self.used_menu_submit = True
            self.add("Оберіть особовий рахунок", [[ACCOUNT]])
        elif t in ("📁 Особові рахунки", "Мої рахунки"):
            self.add("Ваші рахунки:", [[ACCOUNT], ["До головного меню"]])
        elif t == ACCOUNT:
            card = CARD if self.quirk != "other_account" else CARD.replace(ACCOUNT, "0319999999")
            self.add(card, [["💳 Сплатити", "📝 Передати показання"],
                            ["📁 До моїх рахунків", "⏪ До головного меню"]])
        elif "Передати показання" in t:
            if self.quirk == "menu_changed":
                self.add("Сервіс тимчасово недоступний", [["⏪ До головного меню"]])
                return
            self.add("За цим особовим рахунком %s зареєстровано лічильник:\n✅ №%s - "
                     "останні показання %s м³;\nОберіть номер лічильника, натиснувши "
                     "відповідну кнопку." % (ACCOUNT, COUNTER, self.prev),
                     [[COUNTER, "⬅️ Назад"], ["До головного меню"]])
        elif t == COUNTER:
            self.state = "value"
            self.add("Внесіть актуальні показання по лічильнику:\n▪️ Показання за попередній "
                     "період: %s м³\n▪️ Дата останнього показання: 31.08.2026\n\n✅Введіть нові "
                     "показання у форматі числа із точністю до 2 знаків після крапки." % self.prev,
                     [["⬅️ Назад", "До головного меню"]])
        elif self.state == "value":
            self.state = "confirm"
            shown = t if self.quirk != "echo_wrong" else "9999"
            self.add("Ви підтверджуєте відправку показань %s по лічильнику %s?" % (shown, COUNTER),
                     [["Так", "Ні"]])
        elif self.state == "confirm" and t == "Так":
            self.state, self.accepted = "menu", True
            if self.quirk == "already_today":
                # What the real bot said on 2026-10-02 to a second reading
                # on the same day: it keeps the first, takes nothing new.
                self.add("Сьогодні я прийняв Ваші показання і вже працюю над їх обробкою☺️")
                return
            if self.quirk == "rejected":
                self.add("Помилка: показання не прийняті")
                return
            self.add("Вітаю!\nШановний клієнте, Ваші показання успішно прийняті☺️")
            self.add("За цим особовим рахунком ... Оберіть номер лічильника",
                     [[COUNTER, "⬅️ Назад"], ["До головного меню"]])
        elif self.state == "confirm" and t == "Ні":
            self.state = "menu"
            self.add("Скасовано", [["До головного меню"]])


class FakeClient:
    def __init__(self, bot):
        self.bot = bot

    async def get_messages(self, entity, limit=20, min_id=0):
        got = [m for m in self.bot.msgs if m.id > min_id]
        return list(reversed(got))[:limit]

    async def send_message(self, entity, text):
        self.bot.sent.append(text)
        m = self.bot.add(text, out=True)
        self.bot.on_input(text)
        return m


def walk(bot, value=None):
    from service import gasbot, tgclient
    tgclient.QUIET_S, tgclient.REPLY_TIMEOUT_S, tgclient.POLL_S = 0.05, 2, 0.01
    cfg = {"account": ACCOUNT, "counter": COUNTER}

    async def go():
        w = gasbot.Walk(FakeClient(bot), "bot")
        await w.start()
        msgs, prev, date = await gasbot._to_value_prompt(w, cfg)
        if value is None:
            await gasbot._leave(w, msgs)
            return {"ok": True, "previous": prev, "previous_date": date}
        out = await gasbot._submit(w, cfg, msgs, value, prev)
        return {"ok": out["ok"]}

    try:
        return asyncio.run(go())
    except gasbot.BotError as exc:
        return {"ok": False, "error": str(exc)}


checks = 0


def check(name, cond):
    global checks
    checks += 1
    print("  %s %s" % ("ok  " if cond else "FAIL", name))
    if not cond:
        sys.exit(1)


print("gasbot walk")
b = FakeBot()
r = walk(b)
check("status reads the previous reading", r == {"ok": True, "previous": 2245.0,
                                                  "previous_date": "31.08.2026"})
check("status sends no number", not any(s.isdigit() for s in b.sent if s != COUNTER))
check("status backs out to the main menu", b.state == "menu" and b.accepted is None)

b = FakeBot()
check("submit is accepted", walk(b, 2262) == {"ok": True})
check("submit typed exactly the value", "2262" in b.sent and b.accepted)
check("the main menu's account-less button is never used", not b.used_menu_submit)

b = FakeBot(quirk="echo_wrong")
r = walk(b, 2262)
check("a confirmation with another number is refused", not r["ok"] and "Так" not in b.clicked
      and "Ні" in b.clicked)

b = FakeBot(quirk="other_account")
r = walk(b, 2262)
check("another account's card stops the walk", not r["ok"] and "2262" not in b.sent)

b = FakeBot(quirk="menu_changed")
r = walk(b, 2262)
check("a changed menu stops before any number", not r["ok"] and "2262" not in b.sent)

b = FakeBot(quirk="rejected")
check("a refusal is reported as a failure", not walk(b, 2262)["ok"])

b = FakeBot(quirk="already_today")
r = walk(b, 2262)
check("'already accepted today' is a clear failure, not a success",
      not r["ok"] and "already took a reading" in r["error"])

b = FakeBot()
r = walk(b, 2200)
check("a value below the previous one is never typed", not r["ok"] and "2200" not in b.sent)

b = FakeBot(prev="2 245,50")
check("'2 245,50' parses", walk(b)["previous"] == 2245.5)

print("%d checks passed" % checks)
