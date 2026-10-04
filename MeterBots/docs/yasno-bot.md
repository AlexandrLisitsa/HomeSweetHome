# YASNO reading bot

`service/yasnobot.py` sends the monthly electricity reading, the meter's day
(T21) and night (T22) registers, to YASNO's Telegram bot,
[@Yasnoonlinebot](https://t.me/Yasnoonlinebot). Home Assistant decides when and
what (see
[`HomeAssistant/docs/electricity-reading-submission.md`](../../HomeAssistant/docs/electricity-reading-submission.md));
this service only walks the bot.

It's the gas bot's twin ([`gas-bot.md`](gas-bot.md)). It runs on the same
Telegram session, the household's own Telegram user logged in through
Telethon, and the same walker, `service/tgclient.py`. A lock in `tgclient.py`
keeps the two bots from talking at once, because Telethon can't share one
session file between two conversations.

## Why the bot

YASNO is the supplier behind yasno.ua/my, where the reading used to be typed by
hand. Its Telegram bot is an official channel for the same readings, and a
Telegram user session is something code may drive. The account was linked to
the bot once, on 2026-10-04, with `explore` (below).

## The conversation

As of 2026-10-04. The account and address are made up here.

| Step | The bot says | The walk does |
| --- | --- | --- |
| 1 | `/start` → main menu | Press **📊 Передати показання** |
| 2 | "Для передачі показань оберіть особовий рахунок" | Press the button starting with the account number |
| 3 | "Особовий рахунок: 520000000000 … Зонність лічильника: 2. Останні активні показання на 31.08.2026. День: 38108, Ніч: 6384. Введіть показання ДЕНЬ пробіл НІЧ (всі цифри до коми)." | Read the previous readings; type `"DAY NIGHT"` |
| 4 | Not yet seen | See below |

**The bot answers a button by editing its own message**, not by sending a new
one. The walker therefore watches the pressed message for changes
(`Walk(watch_edits=True)`). The gas bot sends new messages, so its walk
doesn't use this.

**Step 4 hadn't been seen when this was written**, because seeing it takes a
real submission. So the code is strict in both directions:

- If the answer asks a question (a **Так** / **Підтверд…** button), the
  question must repeat **both** numbers, or the walk presses **Ні** /
  **Скасув…** and fails. The confirm button is pressed on that question's own
  message (or, when the numbers come in one message and the yes/no in the
  next, on the only yes/no in the answer).
- A button counts as yes or no only by the **first word** of its label, with
  emoji and punctuation stripped. A substring match would take a menu sent
  with the answer for a question: "так" is inside **Контакти** and "ні" is
  inside **Ніч**.
- The answer counts as accepted only if it contains a success word
  (`прийнят`, `успішн`, `збережен`) and no refusal word (`помилк`,
  `не прийнят`, `некоректн`, `неможлив`, `менш`).
- Any other answer fails with the bot's text quoted. Home Assistant passes
  that on, saying the reading may or may not have gone in and to check the
  chat.

After the first real submission, record the screen in this table, tighten
`_submit` to the exact words, and update `tests/test_yasnobot.py`.

## What it refuses before typing

- The account isn't saved in the bot.
- The prompt names another account, or isn't the two-zone one.
- A day or night value below the previous reading.

`status` (`GET /yasno/bot/status`) walks to step 3, returns
`{day, night, date}` and backs out to the main menu without typing anything.

## Configuration

In `.env` next to `docker-compose.yml`. Recreate the container after editing
(`docker compose up -d --force-recreate`).

| Key | What |
| --- | --- |
| `YASNOBOT_ACCOUNT` | The 12-digit YASNO personal account. Private: never in git |
| `YASNOBOT_TOKEN` | What Home Assistant sends as `X-Yasnobot-Token`. Unset, `/yasno/bot/*` refuses everyone |
| `YASNOBOT_BOT` | Optional, defaults to `Yasnoonlinebot` |
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | The session's, shared with the gas bot ([`deployment.md`](deployment.md)) |

## `explore`: linking and re-mapping

One step at a time, printing exactly what the bot answered. It never types a
number by itself; `--say` sends exactly the text it's given.

```sh
docker exec meterbots python -m service.yasnobot explore --start            # /start
docker exec meterbots python -m service.yasnobot explore --press "Мої особові"
docker exec meterbots python -m service.yasnobot explore --say "<12 digits>"
docker exec meterbots python -m service.yasnobot explore                    # read the last messages
docker exec meterbots python -m service.yasnobot status
```

Linking went **Мої особові рахунки** → region **Дніпропетровська обл.** → the
account number. The bot keeps up to five accounts per Telegram user.

## Tests

`tests/test_yasnobot.py` runs a fake bot that edits its messages in place
like the real one. It plays both possible shapes of step 4 (a question first,
or a verdict at once) and every refusal listed above.

```sh
python tests/test_yasnobot.py
```
