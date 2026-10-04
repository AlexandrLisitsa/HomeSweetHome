"""The monthly electricity reading, handed to YASNO's Telegram bot
(@Yasnoonlinebot): the day (T1) and night (T2) registers of a two-zone meter.

Same approach as gasbot.py, and the same Telegram session (tgclient.py): the
household's own Telegram user walks the bot's buttons the way a person would,
checking the bot's words before every step. The bot answers a button by
EDITING its message in place, so the walk watches edits (tgclient.Walk).

The screens, as of 2026-10-04:

    /start -> main menu ............................ [📊 Передати показання]
    "Для передачі показань оберіть особовий рахунок" -> [<account> <address>]
    "Особовий рахунок: <account> … Зонність лічильника: 2
     Останні активні показання на 31.08.2026  День: 38108  Ніч: 6384
     Введіть показання ДЕНЬ пробіл НІЧ (всі цифри до коми)."  -> "38500 6450"

What it answers to the two numbers had not been seen when this was written
(it takes a real submission). So that step is strict both ways: it confirms
only a question that repeats BOTH numbers, counts only an answer with a
success word and no refusal word as accepted, and reports anything else word
for word as a failure -- including "it may have gone in, check the chat".
`status` walks to the prompt, reads the previous readings and backs out.

Configuration, all in the environment (.env next to docker-compose.yml):

    TELEGRAM_API_ID, TELEGRAM_API_HASH   the session's credentials (tgclient.py)
    YASNOBOT_ACCOUNT                 the YASNO personal account
    YASNOBOT_TOKEN                   what Home Assistant must send to use this
    YASNOBOT_BOT                     default Yasnoonlinebot

`explore` drives the bot one step at a time and prints what it answered, for
linking the account and for mapping the screens when they change:

    docker exec meterbots python -m service.yasnobot explore --start
    docker exec meterbots python -m service.yasnobot explore --press "<button label>"
    docker exec meterbots python -m service.yasnobot explore --say "<text>"
    docker exec meterbots python -m service.yasnobot explore            (just read)

It never types a number on its own; `--say` sends exactly what it is given.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

from . import tgclient
from .tgclient import BotError, _norm, _number, _text


def settings(need_account=True):
    env = os.environ
    if need_account and not env.get("YASNOBOT_ACCOUNT"):
        raise BotError("not configured: YASNOBOT_ACCOUNT missing in .env")
    return {**tgclient.api_settings(),
            "account": env.get("YASNOBOT_ACCOUNT", "").strip(),
            "bot": env.get("YASNOBOT_BOT", "Yasnoonlinebot").lstrip("@")}


# The bot's words, as of 2026-10-04. Matched loosely (case, emoji, spacing).
BTN_SUBMIT = "Передати показання"
BTN_MENU = "Головне меню"
TXT_PICK_ACCOUNT = "оберіть особовий рахунок"
TXT_ENTER = "Введіть показання ДЕНЬ пробіл НІЧ"
TXT_TWO_ZONES = "Зонність лічильника: 2"
# After the numbers: the button that confirms, the one that backs out, and
# the words that mean taken / not taken. Refusals are checked first.
# A button is a confirm (cancel) button when its label's FIRST WORD, emoji
# and punctuation stripped, is one of these exactly or starts with one of the
# stems. Never a substring anywhere: "так" is inside "Контакти" and "ні" is
# inside "Ніч", and a menu keyboard sent alongside the answer must not be
# taken for "yes".
BTN_CONFIRM = {"words": ("так",), "stems": ("підтверд",)}
BTN_CANCEL = {"words": ("ні",), "stems": ("скасув",)}
TXT_REFUSED = ("помилк", "не прийнят", "некоректн", "неможлив", "менш")
TXT_ACCEPTED = ("прийнят", "успішн", "збережен")


def _has(text, words):
    t = _norm(text)
    return any(_norm(w) in t for w in words)


async def _to_prompt(walk, cfg):
    """From /start to "Введіть показання ДЕНЬ пробіл НІЧ" for THIS account.

    Returns (messages, {"day", "night", "date"} of the previous readings).
    """
    msgs = await walk.say("/start")
    if tgclient._find_button(msgs, BTN_SUBMIT)[0] is None:
        walk.fail("no '%s' in the main menu" % BTN_SUBMIT)
    msgs = await walk.press(msgs, BTN_SUBMIT)
    text = _text(msgs)
    if _norm(TXT_PICK_ACCOUNT) not in _norm(text):
        walk.fail("expected the account list")
    if tgclient._find_button(msgs, cfg["account"])[0] is None:
        walk.fail("account %s is not saved in the bot; link it with `explore`"
                  % cfg["account"])
    msgs = await walk.press(msgs, cfg["account"])
    text = _text(msgs)
    # The prompt must name THIS account, and be the two-zone one: a single
    # number typed into a three-zone prompt would land somewhere else.
    if ("Особовий рахунок: %s" % cfg["account"]) not in text:
        walk.fail("the reading prompt does not name account %s" % cfg["account"])
    if _norm(TXT_TWO_ZONES) not in _norm(text) or _norm(TXT_ENTER) not in _norm(text):
        walk.fail("expected the two-zone prompt (ДЕНЬ пробіл НІЧ)")
    day = re.search(r"День:[ \u00a0]*(\d[\d \u00a0]*)", text)
    night = re.search(r"Ніч:[ \u00a0]*(\d[\d \u00a0]*)", text)
    date = re.search(r"показання на\s*([\d.]+)", text)
    prev = {"day": int(_number(day.group(1))) if day else None,
            "night": int(_number(night.group(1))) if night else None,
            "date": date.group(1).rstrip(".") if date else None}
    return msgs, prev


async def _leave(walk, msgs):
    """Back to the main menu, so no half-finished entry is left waiting."""
    try:
        if tgclient._find_button(msgs, BTN_MENU)[0] is not None:
            await walk.press(msgs, BTN_MENU)
    except BotError:
        pass


def _first_word(label):
    """'✅ Так' -> 'так', '❌ Скасувати' -> 'скасувати', '📞 Контакти' -> 'контакти'."""
    words = re.findall(r"[^\W\d_]+", _norm(label))
    return words[0] if words else ""


def _is(label, kind):
    w = _first_word(label)
    return w in kind["words"] or any(w.startswith(s) for s in kind["stems"])


def _button_on(msg, kind):
    """The label of `msg`'s confirm (or cancel) button, or None."""
    return next((t for t in tgclient._buttons(msg) if _is(t, kind)), None)


def _names_both(text, day, night):
    return all(re.search(r"(?<!\d)%d(?!\d)" % v, text or "") for v in (day, night))


async def _submit(walk, msgs, day, night, prev):
    """From the prompt: type "DAY NIGHT", confirm if asked, read the verdict."""
    for zone, value in (("day", day), ("night", night)):
        if prev.get(zone) is not None and value < prev[zone]:
            await _leave(walk, msgs)
            walk.fail("%s %d is below the previous %d" % (zone, value, prev[zone]))

    typed = "%d %d" % (day, night)
    msgs = await walk.say(typed)
    text = _text(msgs)

    # A question first? It is a message carrying a confirm button, and it is
    # pressed only on the message that repeats both of OUR numbers.
    asking = [m for m in msgs if _button_on(m, BTN_CONFIRM) is not None]
    if asking and not _has(text, TXT_REFUSED):
        question = next((m for m in reversed(asking) if _names_both(m.raw_text, day, night)),
                        None)
        # The numbers in one message and the yes/no in the next: fine while
        # that is the only yes/no in the answer.
        if question is None and len(asking) == 1 and _names_both(text, day, night):
            question = asking[0]
        if question is None:
            other = asking[-1]
            cancel = _button_on(other, BTN_CANCEL)
            if cancel is not None:
                await walk.press([other], cancel)
            else:
                await _leave(walk, msgs)
            walk.fail("the confirmation names other numbers: %s"
                      % (other.raw_text or "").strip()[:300])
        msgs = await walk.press([question], _button_on(question, BTN_CONFIRM))
        text = _text(msgs)

    await _leave(walk, msgs)
    if _has(text, TXT_REFUSED):
        walk.fail("the bot refused %s: %s" % (typed, text.strip()[:300]))
    if not _has(text, TXT_ACCEPTED):
        walk.fail("the bot's answer to %s is not one this knows; it may or may not "
                  "have been taken, check the chat: %s" % (typed, text.strip()[:300]))
    reply = next((m.raw_text for m in msgs if _has(m.raw_text, TXT_ACCEPTED)), text)
    return {"ok": True, "day": day, "night": night, "previous": prev,
            "reply": reply.strip()}


async def _run(cfg, day=None, night=None):
    async with tgclient.conversation(cfg, cfg["bot"], watch_edits=True) as walk:
        msgs, prev = await _to_prompt(walk, cfg)
        if day is None:
            await _leave(walk, msgs)
            return {"ok": True, "previous": prev, "transcript": walk.transcript}
        out = await _submit(walk, msgs, day, night, prev)
        out["transcript"] = walk.transcript
        return out


def run(day=None, night=None):
    """Blocking entry point for the Flask routes: status without values,
    submit with both. One conversation at a time, across both bots."""
    def go():
        return _run(settings(), day, night)
    return tgclient.blocking(go)


def _screen(msgs):
    return [{"text": m.raw_text, "buttons": tgclient._buttons(m)} for m in msgs]


async def _explore(cfg, start=False, press=None, say=None, last=4):
    """One step: /start, a button press or a typed text; or none, to read the
    last `last` messages. Returns what the bot said in answer."""
    # YASNO's bot answers a press by editing the message in place.
    async with tgclient.conversation(cfg, cfg["bot"], watch_edits=True) as walk:
        if start:
            return {"ok": True, "answer": _screen(await walk.say("/start"))}
        if say is not None:
            return {"ok": True, "answer": _screen(await walk.say(say))}
        recent = await walk.client.get_messages(walk.bot, limit=last)
        recent = sorted(recent, key=lambda m: m.id)
        if press is not None:
            bot_msgs = [m for m in recent if not m.out]
            return {"ok": True, "answer": _screen(await walk.press(bot_msgs, press))}
        return {"ok": True, "recent": [{"from": "me" if m.out else "bot",
                                        "text": m.raw_text,
                                        "buttons": tgclient._buttons(m)} for m in recent]}


def main():
    ap = argparse.ArgumentParser(description="Electricity reading via @Yasnoonlinebot")
    sub = ap.add_subparsers(dest="cmd", required=True)
    ex = sub.add_parser("explore", help="one step with the bot, printing its answer")
    ex.add_argument("--start", action="store_true", help="send /start")
    ex.add_argument("--press", help="press the button whose label contains this")
    ex.add_argument("--say", help="type exactly this")
    ex.add_argument("--last", type=int, default=4, help="messages to show when only reading")
    sub.add_parser("status", help="walk to the reading prompt, read the previous "
                                  "readings, back out")
    args = ap.parse_args()
    if args.cmd == "status":
        out = run()
        print(json.dumps(out, ensure_ascii=False, indent=1))
        return 0 if out.get("ok") else 1

    def go():
        return _explore(settings(need_account=False), args.start, args.press, args.say,
                        args.last)
    out = tgclient.blocking(go)
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
