# The cold-water reading: Dniprovodokanal's web cabinet

`service/waterweb.py` files the monthly cold-water reading in the utility's
web cabinet, [dneprvoda.com.ua](https://dneprvoda.com.ua). It is the one reading
MeterBots files without Telegram.

## Why the website

Dniprovodokanal lists four ways to hand in a reading (vodokanal.dp.ua, March
2024): a phone line, the web cabinet, the ЄРЦ КП chat-bot in Telegram or Viber,
and a "write to us" form. On 2026-10-12 the Telegram bot,
[@dniprovoda_bot](https://t.me/dniprovoda_bot), answered `/start` with a
notice that it is blocked: the National Cybersecurity Coordination Centre's
decision № 16/2005/24 of 24.09.2024 bans Telegram there. Viber has no client
API for a person's own account, and a phone line is a voice menu. The cabinet
is an ordinary Yii2 site with a plain login form and no captcha.

## The pages

As read on 2026-10-12:

| Step | Request | What is checked |
| --- | --- | --- |
| 1 | `GET /` | the login form's `_csrf` |
| 2 | `POST /` with `_csrf`, `LoginForm[email]`, `LoginForm[passw]` | the answer carries the logout form, so the login took. If not, the site's own error is quoted |
| 3 | `GET /user/indication` | the reading form, with exactly one meter, whose row says `<WATERWEB_METER> - <place> (<internal id>)` and whose hidden `User[number][]` is that same id. Also the last reading (`dd-mm-yyyy - N`) and what is filed under «Нові показники» |
| 4 | `POST /user/indication` with `_csrf`, `User[date]` (from the form), `User[indicat][]` (the reading), `User[number][]` | nothing on the answer itself |
| 5 | `GET /user/indication` again | the new reading is **listed** under «Нові показники» with today's date. Only then is the answer `ok` |
| 6 | `POST /site/logout` | best effort |

The reading is whole m³, the dial's black drums. Home Assistant sends a whole
number. `status` (`GET /water/web/status`) stops after step 3 and posts nothing.

## What it refuses, before sending anything

- a value below the last reading, or more than 100 m³ above it (a month here is
  single digits; a jump that size is a misread)
- another value already filed today. The same value already filed today answers
  `ok` with `already: true` and is not posted again, so a retried tap is harmless
- a form with more than one meter, a meter row that is not `WATERWEB_METER`, or
  an internal id that does not match the hidden field: filling the wrong row
  would file the water against another meter
- no form at all (maintenance), or a session that ended before the form

After a post, a reading the cabinet does not list is an error, with whatever
the site said quoted. It is never reported as filed.

## Configuration

In `.env` next to `docker-compose.yml`:

| Key | What |
| --- | --- |
| `WATERWEB_EMAIL`, `WATERWEB_PASSWORD` | the cabinet login. Compose expands `$`, so write a `$` in the password as `$$` |
| `WATERWEB_METER` | the meter's factory serial, as on the dial and in the cabinet's meter list |
| `WATERWEB_TOKEN` | a random string. Home Assistant sends it as `X-Waterweb-Token` (`waterweb_token` in its `secrets.yaml`) |
| `WATERWEB_URL` | optional, default `https://dneprvoda.com.ua` |

With `WATERWEB_TOKEN` unset, `/water/web/*` refuses everyone. The password never
appears in an answer or a log line. After editing `.env`, run
`docker compose up -d --force-recreate`.

A dry run:

```sh
docker exec meterbots python -m service.waterweb status
```

## When it breaks

| error | meaning |
| --- | --- |
| `not configured: … missing in .env` | a `WATERWEB_*` key is empty, or the container was not recreated after the edit |
| `login refused: …` | wrong e-mail or password; the site's reason is quoted |
| `no reading form on the page` | maintenance, or the cabinet changed. Look at the page in a browser, then update `parse_form` and the fake site in `tests/test_waterweb.py` together |
| `the form has N meters`, `meter … is not on the form`, `… files against …` | the account's meters changed. Check `WATERWEB_METER` |
| `… is already on file for today` | someone filed a different value today, by hand or by phone |
| `the cabinet does not list … after the submit` | the post was not taken; the site's words are quoted. File it by hand |

By hand: the cabinet itself, the Viber bot, or the phone line 056 719 93 86.
The deadline is the 28th of the month. This household files on the 1st–4th.
