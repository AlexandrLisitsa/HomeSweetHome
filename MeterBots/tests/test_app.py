"""service/app.py's routes, through Flask's test client, with every bot's run()
stubbed: the tokens, the input checks, and exactly what reaches a bot. No
Telegram, no Telethon; needs only flask.

    python tests/test_app.py
"""
import importlib
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

TOKEN = "test-token"

checks = 0


def check(name, cond, got=""):
    global checks
    checks += 1
    print("  %s %s %s" % ("ok  " if cond else "FAIL", name, "" if cond else got))
    if not cond:
        sys.exit(1)


def load(gas_token, yasno_token=None):
    """The app as it starts with these tokens in its environment. Both bots'
    run() are stubbed and record into the same list, tagged by bot."""
    for name, value in (("GASBOT_TOKEN", gas_token), ("YASNOBOT_TOKEN", yasno_token)):
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value
    from service import app as appmod, gasbot, yasnobot
    appmod = importlib.reload(appmod)
    calls = []

    def stub(tag):
        def run(*args):
            calls.append(args if tag == "gas" else (tag,) + args)
            return {"ok": True, "args": list(args)}
        return run
    gasbot.run = stub("gas")
    yasnobot.run = stub("yasno")
    return appmod.create_app().test_client(), calls


print("health")
client, _ = load(TOKEN)
r = client.get("/health")
body = r.get_json()
check("200 and ok", r.status_code == 200 and body["status"] == "ok")
check("carries the version", body.get("version") == "1.1.0", body)
check("says which bots are configured", body.get("bots") == {"gas": True, "yasno": False}, body)
check("no secret in it", TOKEN not in r.get_data(as_text=True))

print("tokens")
client, calls = load(TOKEN)
check("status without a token -> 401", client.get("/gas/bot/status").status_code == 401)
check("status with a wrong token -> 401",
      client.get("/gas/bot/status", headers={"X-Gasbot-Token": "nope"}).status_code == 401)
check("submit without a token -> 401",
      client.post("/gas/bot/submit", json={"value": 2262}).status_code == 401)
check("and the bot was never called", calls == [])
r = client.get("/gas/bot/status", headers={"X-Gasbot-Token": TOKEN})
check("status with the token reaches the bot, with no value",
      r.status_code == 200 and calls == [()], calls)

client, calls = load(None)
check("token unset: status refused even with an empty header",
      client.get("/gas/bot/status", headers={"X-Gasbot-Token": ""}).status_code == 401)
check("token unset: submit refused",
      client.post("/gas/bot/submit", json={"value": 2262},
                  headers={"X-Gasbot-Token": ""}).status_code == 401)
check("token unset: health says the gas bot is off",
      client.get("/health").get_json()["bots"] == {"gas": False, "yasno": False})
check("and the bot was never called", calls == [])

print("gas submit: what reaches the bot")
client, calls = load(TOKEN)
H = {"X-Gasbot-Token": TOKEN}
for value, want in [(2262, 2262.0), ("2262", 2262.0), ("2262,5", 2262.5), (2262.25, 2262.25)]:
    calls.clear()
    r = client.post("/gas/bot/submit", json={"value": value}, headers=H)
    check("%r -> run(%r)" % (value, want), r.status_code == 200 and calls == [(want,)], calls)
for value in ["", "abc", 0, -5, 100000, 2262.125, "nan", "inf", None]:
    calls.clear()
    r = client.post("/gas/bot/submit", json={"value": value}, headers=H)
    check("%r -> 400, bot not called" % (value,), r.status_code == 400 and calls == [],
          (r.status_code, calls))
calls.clear()
r = client.post("/gas/bot/submit", data="not json", headers=H)
check("a body that is not JSON -> 400", r.status_code == 400 and calls == [])

print("yasno: tokens")
client, calls = load(TOKEN, "yasno-token")
Y = {"X-Yasnobot-Token": "yasno-token"}
check("no token -> 401", client.get("/yasno/bot/status").status_code == 401)
check("the gas token does not open the YASNO routes",
      client.get("/yasno/bot/status", headers={"X-Yasnobot-Token": TOKEN}).status_code == 401)
check("nor the other way round",
      client.get("/gas/bot/status", headers={"X-Gasbot-Token": "yasno-token"}).status_code == 401)
check("and no bot was called", calls == [])
r = client.get("/yasno/bot/status", headers=Y)
check("status with the token reaches the YASNO bot, with no values",
      r.status_code == 200 and calls == [("yasno",)], calls)
client, calls = load(TOKEN, None)
check("YASNO token unset: refused even with an empty header",
      client.post("/yasno/bot/submit", json={"day": 1, "night": 1},
                  headers={"X-Yasnobot-Token": ""}).status_code == 401 and calls == [])

print("yasno submit: what reaches the bot")
client, calls = load(TOKEN, "yasno-token")
for body, want in [({"day": 38500, "night": 6450}, ("yasno", 38500, 6450)),
                   ({"day": "38500", "night": " 6450 "}, ("yasno", 38500, 6450))]:
    calls.clear()
    r = client.post("/yasno/bot/submit", json=body, headers=Y)
    check("%r -> run%r" % (body, want[1:]), r.status_code == 200 and calls == [want], calls)
for body in [{}, {"day": 38500}, {"night": 6450}, {"day": "abc", "night": 6450},
             {"day": 38500.5, "night": 6450}, {"day": "38500.0", "night": 6450},
             {"day": 0, "night": 6450}, {"day": 38500, "night": 1000000},
             {"day": -1, "night": 6450}, {"day": "38 500", "night": 6450}]:
    calls.clear()
    r = client.post("/yasno/bot/submit", json=body, headers=Y)
    check("%r -> 400, bot not called" % (body,), r.status_code == 400 and calls == [],
          (r.status_code, calls))

print("%d checks passed" % checks)
