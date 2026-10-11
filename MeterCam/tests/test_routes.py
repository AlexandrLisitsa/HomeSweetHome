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

print("auth")
# authorised() lifted out of the module and run against a fake request: the
# same function, without the OpenCV import.
fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "authorised")
src = ast.get_source_segment(APP.read_text(encoding="utf-8"), fn)


class FakeRequest:
    def __init__(self, header=None, query=None):
        self.headers = {"X-Auth-Token": header} if header is not None else {}
        self.args = {"token": query} if query is not None else {}


def authorised(token, **req):
    import hmac
    env = {"hmac": hmac, "TOKEN": token, "request": FakeRequest(**req)}
    exec(src, env)
    return env["authorised"]()


check("no METERCAM_TOKEN: open", authorised(None))
check("token set, none supplied: refused", not authorised("s3cret"))
check("right header: let in", authorised("s3cret", header="s3cret"))
check("right ?token= (the board's firmware download): let in", authorised("s3cret", query="s3cret"))
check("wrong token: refused", not authorised("s3cret", header="s3cres"))
check("a prefix of the token: refused", not authorised("s3cret", header="s3c"))
check("empty header: refused", not authorised("s3cret", header=""))
check("non-ASCII token compares without raising", not authorised("s3cret", header="тест"))

print("health: age of the last accepted reading")
fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "_accepted_ages")
src_ages = ast.get_source_segment(APP.read_text(encoding="utf-8"), fn)


def ages(records, now=1000000.0, meters=("gas",)):
    import types
    env = {"time": types.SimpleNamespace(time=lambda: now),
           "last_accepted_record": lambda name: records.get(name)}
    exec(src_ages, env)
    return env["_accepted_ages"](list(meters))


check("an hour-old accept reads 3600", ages({"gas": {"value": 2262.5, "at_epoch": 1000000.0 - 3600}}) == {"gas": 3600})
check("no file yet: the meter is absent, not 0", ages({}) == {})
check("a file without at_epoch: absent", ages({"gas": {"value": 1}}) == {})
check("garbage at_epoch: absent, no exception", ages({"gas": {"at_epoch": "x"}}) == {})
check("a clock behind the file: 0, never negative", ages({"gas": {"at_epoch": 1000050.0}}) == {"gas": 0})
check("each meter its own", ages({"gas": {"at_epoch": 999990.0}, "water": {"at_epoch": 999000.0}},
                                meters=("gas", "water")) == {"gas": 10, "water": 1000})
check("/health reports it", '"last_accepted_s_ago": _accepted_ages(meters)' in APP.read_text(encoding="utf-8"))

print("firmware: one channel per meter")
# _firmware_version() lifted out like authorised() above, run against a real
# temporary directory.
fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "_firmware_version")
src_fw = ast.get_source_segment(APP.read_text(encoding="utf-8"), fn)
name_rule = next(n for n in tree.body if isinstance(n, ast.Assign)
                 and getattr(n.targets[0], "id", "") == "_METER_NAME")
src_fw = ast.get_source_segment(APP.read_text(encoding="utf-8"), name_rule) + "\n" + src_fw


def offered(files, meter):
    import re
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        for fname, text in files.items():
            (root / fname).write_text(text, encoding="utf-8")
        env = {"FIRMWARE_DIR": root, "re": re}
        exec(src_fw, env)
        return env["_firmware_version"](meter)


legacy = {"version.txt": "gas-cam-7\n"}
check("gas with only the old version.txt: offered as before", offered(legacy, "gas") == "gas-cam-7")
check("gas: version-gas.txt wins over version.txt",
      offered(dict(legacy, **{"version-gas.txt": "gas-cam-8"}), "gas") == "gas-cam-8")
check("water with no file of its own: nothing, never the gas build", offered(legacy, "water") is None)
check("water with its own file: its version",
      offered(dict(legacy, **{"version-water.txt": "water-cam-2"}), "water") == "water-cam-2")
check("water never reads version-gas.txt",
      offered({"version-gas.txt": "gas-cam-8"}, "water") is None)
check("an empty file is no offer", offered({"version-water.txt": "\n"}, "water") is None)
check("no files at all: nothing", offered({}, "gas") is None)
check("a meter name with a path in it: nothing", offered(legacy, "../version") is None)
check("an empty meter name: nothing", offered(legacy, "") is None)

app_src = APP.read_text(encoding="utf-8")
read_fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "do_read")
calls = [n for n in ast.walk(read_fn) if isinstance(n, ast.Call)
         and getattr(n.func, "id", "") == "_firmware_version"]
check("/read asks for its own meter's version",
      calls and all(len(c.args) == 1 and getattr(c.args[0], "id", "") == "name" for c in calls),
      [ast.dump(c) for c in calls])
check("/firmware/version.txt takes ?meter=, gas by default",
      '_firmware_version(request.args.get("meter", "gas"))' in app_src)
check("/health still reports the gas version", '"firmware": _firmware_version("gas")' in app_src)
check("no call without a meter is left", "_firmware_version()" not in app_src)

print("%d checks passed" % checks)
