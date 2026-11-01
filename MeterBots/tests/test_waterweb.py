"""service/waterweb.py against a fake dneprvoda.com.ua on localhost, whose
pages copy the real cabinet's structure as read on 2026-10-12 (the reading form
opens inside a table, the meter row says "<serial> - <place>" then
"(<internal id>)", the last reading is "dd-mm-yyyy - N", and the filed ones are
"dd.mm.yyyy" / "Показники - N" under "Нові показники"). No network beyond
127.0.0.1, no Telegram; stdlib only.

    python tests/test_waterweb.py
"""
import http.server
import os
import pathlib
import sys
import threading
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from service import waterweb  # noqa: E402

EMAIL, PASSWORD, METER, NUMBER = "home@example.com", "s3cret-pass", "211039", "27896"
TODAY = "2026-11-02"

checks = 0


def check(name, cond, got=""):
    global checks
    checks += 1
    print("  %s %s %s" % ("ok  " if cond else "FAIL", name, "" if cond else got))
    if not cond:
        sys.exit(1)


class State:
    def __init__(self, quirk=None, prev=2861, filed=(("04.10.2026", 2861),)):
        self.quirk, self.prev, self.filed = quirk, prev, list(filed)
        self.posts, self.sessions, self.logins = [], set(), 0


def page(body, logged=True):
    logout = ('<form action="/site/logout" method="post"><input type="hidden" name="_csrf" '
              'value="tok-123"><button type="submit">Вихід</button></form>') if logged else ""
    return ('<html><head><meta name="csrf-token" content="tok-123"></head><body>'
            '<div class="wrap">%s%s</div></body></html>' % (logout, body))


LOGIN = ('<form id="login-form" action="/" method="post">'
         '<input type="hidden" name="_csrf" value="tok-123">'
         '<input type="text" id="loginform-email" name="LoginForm[email]">'
         '<input type="password" id="loginform-passw" name="LoginForm[passw]">%s'
         '<button type="submit" name="login-button">Вхід</button></form>')


def indication(st):
    rows = []
    meters = [(METER, NUMBER)]
    if st.quirk == "two_meters":
        meters.append(("300001", "27897"))
    for serial, number in meters:
        shown = number if st.quirk != "number_mismatch" else "99999"
        label = serial if st.quirk != "other_meter" else "555555"
        rows.append(
            '<tr><td><p>%s - САНУЗЕЛ<br>(%s)</p></td>'
            '<td>%s<div class="form-group field-user-date"><input type="hidden" id="user-date" '
            'class="form-control" name="User[date]" value="%s"><p class="help-block help-block-error"></p></div></td>'
            '<td><div class="form-group field-user-indicat"><input type="number" id="user-indicat" '
            'class="form-control" name="User[indicat][]"><p class="help-block help-block-error"></p></div>'
            '<div class="form-group field-user-number"><input type="hidden" id="user-number" '
            'class="form-control" name="User[number][]" value="%s"><p class="help-block help-block-error"></p></div></td>'
            '<td><b>04-10-2026</b>&nbsp; - %d</td></tr>'
            % (label, number, ".".join(reversed(TODAY.split("-"))), TODAY, shown, st.prev))
    filed = "".join('<tr><td>%s</td><td>Показники - %d</td></tr>' % f for f in st.filed)
    return page(
        '<table><tr><td><a class="btn btn-success" href="/user/indication">Передати показники</a></td></tr>'
        '<tr><th><p>Тут ви можете ввести показники лічильника для передачі в службу</p></th></tr>'
        '<tr><th></th><th><p>Місяць</p></th><th><p>Показники</p></th></tr>'
        '<form id="inds-form" class="form" action="/user/indication" method="post">'
        '<input type="hidden" name="_csrf" value="tok-123">%s'
        '<tr><td>Нові показники</td></tr>%s'
        '<tr><td><button type="submit" class="btn btn-primary" name="contact-button">Відправити</button>'
        '</form></td></tr></table>' % ("".join(rows), filed))


def serve(st):
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def session(self):
            cookie = self.headers.get("Cookie") or ""
            return "PHPSESSID=ok" in cookie and "ok" in st.sessions

        def send(self, code, body="", location=None, cookie=None):
            self.send_response(code)
            if location:
                self.send_header("Location", location)
            if cookie:
                self.send_header("Set-Cookie", cookie)
            data = body.encode("utf-8")
            self.send_header("Content-Type", "text/html; charset=UTF-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            path = urllib.parse.urlparse(self.path).path
            if path == "/":
                if self.session():
                    return self.send(302, location="/user/111")
                return self.send(200, page(LOGIN % "", logged=False))
            if st.quirk == "logged_out_form" and path == "/user/indication":
                st.sessions.discard("ok")       # the session expired under us
            if not self.session():
                return self.send(302, location="/")
            if path == "/user/111":
                return self.send(200, page("<p>Інформація</p>"))
            if path == "/user/indication":
                if st.quirk == "no_form":
                    return self.send(200, page("<p>Технічні роботи</p>"))
                return self.send(200, indication(st))
            return self.send(404, "nope")

        def do_POST(self):
            path = urllib.parse.urlparse(self.path).path
            n = int(self.headers.get("Content-Length") or 0)
            fields = urllib.parse.parse_qs(self.rfile.read(n).decode("utf-8"), keep_blank_values=True)
            one = {k: v[0] if len(v) == 1 else v for k, v in fields.items()}
            if path == "/":
                st.logins += 1
                ok = (one.get("_csrf") == "tok-123" and one.get("LoginForm[email]") == EMAIL
                      and one.get("LoginForm[passw]") == PASSWORD and st.quirk != "bad_login")
                if not ok:
                    return self.send(200, page(LOGIN % '<p class="help-block help-block-error">'
                                                       'Невірний e-mail або пароль.</p>', logged=False))
                st.sessions.add("ok")
                return self.send(302, location="/user/111", cookie="PHPSESSID=ok; Path=/")
            if path == "/site/logout":
                st.sessions.discard("ok")
                return self.send(302, location="/")
            if not self.session():
                return self.send(302, location="/")
            if path == "/user/indication":
                st.posts.append(one)
                if one.get("_csrf") != "tok-123":
                    return self.send(400, "Bad Request (#400)")
                if st.quirk == "post_ignored":
                    return self.send(200, indication(st))
                if st.quirk == "post_refused":
                    return self.send(200, page('<div class="alert alert-danger">Період подачі '
                                               'показників завершено</div>'))
                st.filed.append((".".join(reversed(one["User[date]"].split("-"))),
                                 int(one["User[indicat][]"])))
                return self.send(302, location="/user/indication")
            return self.send(404, "nope")

    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def run(st, value=None, **env):
    httpd = serve(st)
    os.environ.update({"WATERWEB_EMAIL": EMAIL, "WATERWEB_PASSWORD": PASSWORD,
                       "WATERWEB_METER": METER,
                       "WATERWEB_URL": "http://127.0.0.1:%d" % httpd.server_address[1]})
    os.environ.update(env)
    try:
        return waterweb.run(value)
    finally:
        httpd.shutdown()


print("reading the pages")
st = State()
form = waterweb.parse_form(indication(st), METER)
check("the meter's internal id", form["number"] == NUMBER, form)
check("the form's date", form["date"] == TODAY, form)
check("the last reading and its date", (form["previous"], form["previous_date"]) == (2861, "04.10.2026"), form)
check("what is already filed", form["filed"] == [("04.10.2026", 2861)], form)
check("csrf from the hidden field", waterweb.csrf(indication(st)) == "tok-123")
check("csrf from the meta tag when there is no field",
      waterweb.csrf('<meta name="csrf-token" content="m-tok">') == "m-tok")
check("attributes in any order", waterweb.csrf('<input value="v2" name="_csrf" type="hidden">') == "v2")
check("logged in is the logout form", waterweb.logged_in(indication(st)) and not waterweb.logged_in(LOGIN))
check("2026-11-02 is 02.11.2026 in the list", waterweb.dotted("2026-11-02") == "02.11.2026")
for quirk, why in (("two_meters", "only one is supported"), ("other_meter", "is not on the form"),
                   ("number_mismatch", "files against")):
    try:
        waterweb.parse_form(indication(State(quirk)), METER)
        check(quirk + ": refused", False, "parsed")
    except waterweb.SiteError as exc:
        check(quirk + ": refused (%s)" % why, why in str(exc), str(exc))

print("status: log in, read, post nothing")
st = State()
out = run(st)
check("ok", out.get("ok") is True, out)
check("previous reading and date", (out["previous"], out["previous_date"]) == (2861, "04.10.2026"), out)
check("nothing posted to the form", st.posts == [], st.posts)
check("logged out at the end", "ok" not in st.sessions)
check("no password anywhere in the answer", PASSWORD not in repr(out), out)
check("a trace of the steps", [t["step"] for t in out["trace"]][:3] == ["GET /", "POST /", "GET /user/indication"],
      out["trace"])

print("submit")
st = State()
out = run(st, 2875)
check("ok", out.get("ok") is True, out)
check("one post to the form", len(st.posts) == 1, st.posts)
p = st.posts[0]
check("with the reading, the form's date and the meter's id",
      (p["User[indicat][]"], p["User[date]"], p["User[number][]"], p["_csrf"]) == ("2875", TODAY, NUMBER, "tok-123"), p)
check("listed by the cabinet afterwards", ("02.11.2026", 2875) in out["filed"], out)
check("logged out at the end", "ok" not in st.sessions)
check("no password anywhere in the answer", PASSWORD not in repr(out), out)

st = State(filed=(("04.10.2026", 2861), ("02.11.2026", 2875)))
out = run(st, 2875)
check("the same reading already filed today: ok, not posted again",
      (out.get("ok"), out.get("already"), st.posts) == (True, True, []), (out, st.posts))

print("refusals: nothing is sent")
cases = [
    ("below the previous reading", State(), 2860, "below the previous reading", 0),
    ("a jump of more than 100 m³", State(), 2962, "refusing a jump", 0),
    ("another reading already filed today", State(filed=(("02.11.2026", 2870),)), 2875,
     "already on file for today", 0),
    ("a wrong login", State("bad_login"), 2875, "login refused: Невірний e-mail або пароль.", 0),
    ("no form (maintenance)", State("no_form"), 2875, "no reading form", 0),
    ("two meters on the form", State("two_meters"), 2875, "only one is supported", 0),
    ("the form names another meter", State("other_meter"), 2875, "is not on the form", 0),
    ("logged out before the form", State("logged_out_form"), 2875, "logged us out", 0),
    # Posted, but the cabinet does not list it: never reported as filed.
    ("the post is ignored", State("post_ignored"), 2875, "does not list 2875 for 02.11.2026", 1),
    ("the post is refused, with the site's reason", State("post_refused"), 2875,
     "Період подачі показників завершено", 1),
]
for name, st, value, why, posts in cases:
    out = run(st, value)
    check("%s: refused" % name, out.get("ok") is False and why in out.get("error", ""), out)
    check("%s: %d post(s)" % (name, posts), len(st.posts) == posts, st.posts)
    check("%s: no password in the answer" % name, PASSWORD not in repr(out), out)

out = run(State(), 2875, WATERWEB_URL="http://127.0.0.1:9")
check("the site down: refused with the step", out["ok"] is False and "GET /" in out["error"], out)

for key in ("WATERWEB_EMAIL", "WATERWEB_PASSWORD", "WATERWEB_METER"):
    saved = os.environ.pop(key, None)
    out = waterweb.run()
    check("%s missing: says so" % key, out["ok"] is False and key in out["error"], out)
    if saved is not None:
        os.environ[key] = saved

print("%d checks passed" % checks)
