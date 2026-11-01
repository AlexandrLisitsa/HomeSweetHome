"""The monthly cold-water reading, filed in Dniprovodokanal's web cabinet.

Why the website and not a bot: the utility's Telegram bot (@dniprovoda_bot,
ТОВ «ЄРЦ КП») answers every message with "заблоковано" since the 2024 ban on
Telegram for state-linked bodies, and Viber has no client API for a user's own
account. The cabinet (dneprvoda.com.ua, a Yii2 site, no captcha as of
2026-10-12) is an ordinary HTML form:

    GET  /                    login page, carries _csrf
    POST /                    _csrf, LoginForm[email], LoginForm[passw]
    GET  /user/indication     the reading form: the meter, its internal id,
                              the last reading, and "Нові показники" -- the
                              readings already filed through the cabinet
    POST /user/indication     _csrf, User[date], User[indicat][], User[number][]

Readings are whole m³. Every step checks the page before the next one, and a
submit only counts once the cabinet LISTS it under "Нові показники" with
today's date: what the POST answers is not trusted, the record is. `status`
logs in, reads the form and the last reading, and posts nothing.

Configuration, all in the environment (.env next to docker-compose.yml):

    WATERWEB_EMAIL, WATERWEB_PASSWORD   the cabinet login
    WATERWEB_METER                      the meter's factory serial (on the dial)
    WATERWEB_TOKEN                      what Home Assistant must send to use this
    WATERWEB_URL                        default https://dneprvoda.com.ua

No Telegram here, so no tgclient.LOCK: this has a lock of its own. A dry run
from the command line:

    docker exec meterbots python -m service.waterweb status
"""
from __future__ import annotations

import argparse
import html
import http.cookiejar
import json
import os
import re
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT_S = 30
LOCK = threading.Lock()
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/128.0 Safari/537.36")

# The page's words, as of 2026-10-12.
TXT_FORM = "Тут ви можете ввести показники"
TXT_NEW = "Нові показники"

# A month of this flat is single-digit m³. A jump of more than this in one
# filing is a misread or a typo, never water.
MAX_STEP_M3 = 100


class SiteError(Exception):
    """The cabinet did not answer the way it did when this was written."""

    def __init__(self, msg, trace=None):
        super().__init__(msg)
        self.trace = trace or []


def settings():
    env = os.environ
    missing = [k for k in ("WATERWEB_EMAIL", "WATERWEB_PASSWORD", "WATERWEB_METER")
               if not env.get(k)]
    if missing:
        raise SiteError("not configured: %s missing in .env" % ", ".join(missing))
    return {"email": env["WATERWEB_EMAIL"].strip(),
            "password": env["WATERWEB_PASSWORD"],
            "meter": env["WATERWEB_METER"].strip(),
            "url": (env.get("WATERWEB_URL") or "https://dneprvoda.com.ua").rstrip("/")}


# ---------------------------------------------------------------------------
# Reading the pages. Pure functions: the tests feed them HTML.
# ---------------------------------------------------------------------------

def _inputs(page):
    """Every <input>, as a dict of its attributes (any order, any quoting)."""
    out = []
    for tag in re.findall(r"<input\b[^>]*>", page, re.I):
        attrs = dict((k.lower(), html.unescape(v[1:-1]))
                     for k, v in re.findall(r'([\w\-\[\]]+)\s*=\s*("[^"]*"|\'[^\']*\')', tag))
        out.append(attrs)
    return out


def text_of(page):
    """The page as a person reads it: tags dropped, entities decoded, spaces folded."""
    page = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", page)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", page))).strip()


def csrf(page):
    for attrs in _inputs(page):
        if attrs.get("name") == "_csrf" and attrs.get("value"):
            return attrs["value"]
    m = re.search(r'<meta\s+name="csrf-token"\s+content="([^"]+)"', page)
    return html.unescape(m.group(1)) if m else None


def logged_in(page):
    return "/site/logout" in page


def parse_form(page, meter):
    """The reading form for `meter`, or a SiteError saying what is missing.

    Returns {date, number, previous, previous_date, filed: [(dd.mm.yyyy, m3)]}.
    """
    text = text_of(page)
    if TXT_FORM not in text:
        raise SiteError("no reading form on the page")
    numbers = [a.get("value", "") for a in _inputs(page) if a.get("name") == "User[number][]"]
    readings = [a for a in _inputs(page) if a.get("name") == "User[indicat][]"]
    dates = [a.get("value", "") for a in _inputs(page) if a.get("name") == "User[date]"]
    if len(numbers) != 1 or len(readings) != 1:
        # Several meters share one form, in an order this has never seen.
        # Filling the wrong row files someone's water against another meter.
        raise SiteError("the form has %d meters; only one is supported" % len(numbers))
    label = re.search(r"\b%s\s*-\s*[^()]*\((\d+)\)" % re.escape(meter), text)
    if not label:
        raise SiteError("meter %s is not on the form" % meter)
    if label.group(1) != numbers[0]:
        raise SiteError("meter %s is listed as (%s) but the form files against %s"
                        % (meter, label.group(1), numbers[0]))
    if len(dates) != 1 or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", dates[0]):
        raise SiteError("no reading date on the form")
    last = re.search(r"\b(\d{2})-(\d{2})-(\d{4})\s*-\s*(\d+)\b", text)
    tail = text.split(TXT_NEW, 1)[1] if TXT_NEW in text else ""
    filed = [(d, int(v)) for d, v in re.findall(r"(\d{2}\.\d{2}\.\d{4})\s*Показники\s*-\s*(\d+)", tail)]
    return {"date": dates[0], "number": numbers[0],
            "previous": int(last.group(4)) if last else None,
            "previous_date": "%s.%s.%s" % last.group(1, 2, 3) if last else None,
            "filed": filed}


def form_errors(page):
    """What the site said was wrong, from Yii's error blocks and alerts."""
    found = re.findall(r'(?is)<(?:p|div)[^>]*class="[^"]*(?:help-block-error|alert)[^"]*"[^>]*>(.*?)</(?:p|div)>', page)
    return "; ".join(t for t in (text_of(f) for f in found) if t)


def dotted(iso):
    """2026-11-02 -> 02.11.2026, the cabinet's own spelling in its list."""
    y, m, d = iso.split("-")
    return "%s.%s.%s" % (d, m, y)


# ---------------------------------------------------------------------------
# Talking to the site
# ---------------------------------------------------------------------------

class Site:
    """One logged-in visit: a cookie jar and a trace of every request."""

    def __init__(self, base):
        self.base = base
        self.trace = []
        jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def fail(self, msg):
        raise SiteError(msg, self.trace)

    def _go(self, method, path, fields=None):
        data = urllib.parse.urlencode(fields).encode() if fields is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"User-Agent": UA, "Accept-Language": "uk"})
        try:
            with self.opener.open(req, timeout=TIMEOUT_S) as resp:
                page = resp.read().decode("utf-8", "replace")
                where = urllib.parse.urlparse(resp.geturl()).path
                self.trace.append({"step": "%s %s" % (method, path), "status": resp.status, "at": where})
                return page, where
        except urllib.error.HTTPError as exc:
            self.trace.append({"step": "%s %s" % (method, path), "status": exc.code})
            self.fail("%s %s answered %s" % (method, path, exc.code))
        except (urllib.error.URLError, OSError) as exc:
            self.trace.append({"step": "%s %s" % (method, path), "error": str(exc)})
            self.fail("%s %s: %s" % (method, path, exc))

    def get(self, path):
        return self._go("GET", path)

    def post(self, path, fields):
        return self._go("POST", path, fields)

    def login(self, cfg):
        page, _ = self.get("/")
        token = csrf(page)
        if not token:
            self.fail("no login form on the start page")
        page, _ = self.post("/", {"_csrf": token, "LoginForm[email]": cfg["email"],
                                  "LoginForm[passw]": cfg["password"], "login-button": ""})
        if not logged_in(page):
            why = form_errors(page)
            self.fail("login refused%s" % (": " + why if why else ""))

    def form(self, cfg):
        page, _ = self.get("/user/indication")
        if not logged_in(page):
            self.fail("the cabinet logged us out before the form")
        try:
            return parse_form(page, cfg["meter"]), page
        except SiteError as exc:
            self.fail(str(exc))

    def logout(self, page):
        token = csrf(page)
        if token:
            try:
                self.post("/site/logout", {"_csrf": token})
            except SiteError:
                pass


def _run(cfg, value=None):
    site = Site(cfg["url"])
    site.login(cfg)
    form, page = site.form(cfg)
    out = {"ok": True, "meter": cfg["meter"], "previous": form["previous"],
           "previous_date": form["previous_date"], "filed": form["filed"]}
    if value is None:
        site.logout(page)
        out["trace"] = site.trace
        return out

    today = dotted(form["date"])
    prev = form["previous"]
    if prev is not None and value < prev:
        site.logout(page)
        site.fail("%s is below the previous reading %s" % (value, prev))
    if prev is not None and value - prev > MAX_STEP_M3:
        site.logout(page)
        site.fail("%s is %s m³ above the previous reading %s; refusing a jump that size"
                  % (value, value - prev, prev))
    on_file = [v for d, v in form["filed"] if d == today]
    if value in on_file:
        # Filed already today: a retried tap must not file it twice.
        site.logout(page)
        out.update(value=value, already=True, trace=site.trace)
        return out
    if on_file:
        site.logout(page)
        site.fail("%s is already on file for today; %s was not sent" % (on_file[-1], value))

    token = csrf(page)
    if not token:
        site.fail("no _csrf on the reading form")
    answer, _ = site.post("/user/indication", {
        "_csrf": token, "User[date]": form["date"], "User[indicat][]": str(value),
        "User[number][]": form["number"], "contact-button": ""})

    # The record, not the answer: read the form again and find it listed.
    after, after_page = site.form(cfg)
    site.logout(after_page)
    if (today, value) not in after["filed"]:
        why = form_errors(answer)
        site.fail("the cabinet does not list %s for %s after the submit%s"
                  % (value, today, ": " + why if why else ""))
    out.update(value=value, previous=prev, filed=after["filed"], trace=site.trace)
    return out


def run(value=None):
    """Blocking entry point for the Flask routes: one visit at a time, always
    JSON back. Never a password in what it returns."""
    with LOCK:
        try:
            return _run(settings(), value)
        except SiteError as exc:
            return {"ok": False, "error": str(exc), "trace": exc.trace}
        except Exception as exc:        # noqa: BLE001 -- the caller needs JSON
            return {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}


def main():
    ap = argparse.ArgumentParser(description="Cold-water reading via the dneprvoda.com.ua cabinet")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status", help="log in, read the form and the last reading; send nothing")
    ap.parse_args()
    out = run()
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
