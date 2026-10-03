"""MeterCam's routes, read from service/app.py without importing it (the
import needs OpenCV): which ones exist, and that no bot route has crept back.

    python tests/test_routes.py

MeterCam reads meters and does nothing else. Filing a reading with a
supplier's Telegram bot is MeterBots, in its own LXC: a /gas/bot/* or
/yasno/bot/* route here would mean the Telegram session is back in this
container, which is exactly what must not happen (MeterBots/docs/architecture.md).
"""
import ast
import pathlib
import sys

APP = pathlib.Path(__file__).resolve().parent.parent / "service" / "app.py"

tree = ast.parse(APP.read_text(encoding="utf-8"))
routes = set()
imports = set()
for node in ast.walk(tree):
    if isinstance(node, ast.FunctionDef):
        for dec in node.decorator_list:
            if (isinstance(dec, ast.Call) and getattr(dec.func, "attr", "") == "route"
                    and dec.args and isinstance(dec.args[0], ast.Constant)):
                routes.add(dec.args[0].value)
    if isinstance(node, ast.ImportFrom):
        imports.update(a.name for a in node.names)
    if isinstance(node, ast.Import):
        imports.update(a.name for a in node.names)

checks = 0


def check(name, cond, got=""):
    global checks
    checks += 1
    print("  %s %s %s" % ("ok  " if cond else "FAIL", name, "" if cond else got))
    if not cond:
        sys.exit(1)


print("routes")
for path in ("/read", "/last.jpg", "/last_accepted.jpg", "/archive", "/archive/days",
             "/firmware/version.txt", "/health"):
    check("%s is served" % path, path in routes, sorted(routes))
check("no bot route", not any("/bot/" in r for r in routes), sorted(routes))
check("no Telegram anywhere in the app",
      not ({"gasbot", "yasnobot", "tgclient", "telethon"} & imports), sorted(imports))

req = (APP.parent.parent / "requirements.txt").read_text(encoding="utf-8")
check("telethon is not a dependency", "telethon" not in req)

print("%d checks passed" % checks)
