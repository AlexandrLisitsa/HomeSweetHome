"""Create, push and order Lovelace dashboards over the Home Assistant WebSocket API.

    python HomeAssistant/tools/ha_dashboard.py --list
    python HomeAssistant/tools/ha_dashboard.py --whoami
    python HomeAssistant/tools/ha_dashboard.py --create dashboard-dtek \\
        --title Shutdowns --icon mdi:transmission-tower-off
    python HomeAssistant/tools/ha_dashboard.py --push dashboards/lovelace.dashboard_dtek.json \\
        --url-path dashboard-dtek
    python HomeAssistant/tools/ha_dashboard.py --order dashboard-dtek --after dashboard-inverter
    python HomeAssistant/tools/ha_dashboard.py --order dashboard-home --first
    python HomeAssistant/tools/ha_dashboard.py --list-resources
    python HomeAssistant/tools/ha_dashboard.py --card climate-console-card.js
    python HomeAssistant/tools/ha_dashboard.py --resource "/local/dtek-shutdowns-card.js?v=1.1.0"

THIS CHANGES THE HOUSE. Like ha_call.sh it is kept out of
.claude/settings.local.json on purpose, so every run prompts. --list and
--whoami are read-only but share the file, so they prompt too.

Why the WebSocket API and not the files
---------------------------------------
Dashboards live in /config/.storage, and README.md's rename procedure explains
what editing that by hand costs: Home Assistant holds those files in memory and
overwrites your edit on its next save, so it needs `ha core stop` first, not a
restart. Every operation here has a WebSocket command instead, HA performs the
write itself, and nothing has to be stopped or restarted.

That also makes this the restore path the README currently describes as manual.
`--push` sends a mirrored dashboard straight back into a running HA, where the
"an edit without a restart is silently discarded" failure mode does not exist.

Needs websocket-client (see requirements.txt) and HA_URL / HA_TOKEN in
HomeAssistant/secrets.env, the same file tools/_ha_env.sh sources.
"""
import argparse
import json
import re
import sys
from pathlib import Path

try:
    import websocket
except ImportError:
    sys.exit("needs websocket-client:  python -m pip install -r "
             "HomeAssistant/tools/requirements.txt")

SECRETS = Path(__file__).resolve().parent.parent / "secrets.env"
WWW = Path(__file__).resolve().parent.parent / "config" / "www"

# Every version in the repo is MAJOR.MINOR.PATCH, and a card's ?v= is the
# card's own VERSION constant -- see "Versions" in the top-level README.
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")
CARD_VERSION = re.compile(r'^const VERSION = "([^"]+)";', re.M)


def card_url(name):
    """The resource URL a card in config/www should be loaded at: its path,
    and its own VERSION as the cache-buster. Reading the version from the file
    is the point -- a ?v= typed by hand is how the two drifted apart."""
    src = WWW / name
    if not src.is_file():
        sys.exit(f"{src} not found -- --card takes a file name in config/www")
    m = CARD_VERSION.search(src.read_text(encoding="utf-8"))
    if not m:
        sys.exit(f'{name} has no `const VERSION = "X.Y.Z";` line')
    return "/local/%s?v=%s" % (name, m.group(1))


def load_env():
    if not SECRETS.exists():
        sys.exit(f"{SECRETS} not found -- copy secrets.env.example and fill it in")
    env = {}
    for line in SECRETS.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.strip().startswith("#"):
            key, _, value = line.partition("=")
            env[key.strip()] = value.strip().strip('"').strip("'")
    for required in ("HA_URL", "HA_TOKEN"):
        if not env.get(required):
            sys.exit(f"{required} missing from {SECRETS}")
    return env


class HA:
    """One authenticated WebSocket connection, commands numbered as HA wants."""

    def __init__(self, env):
        url = env["HA_URL"].rstrip("/")
        url = "ws" + url[4:] if url.startswith("http") else url
        self.ws = websocket.create_connection(url + "/api/websocket", timeout=20)
        self._id = 0
        hello = json.loads(self.ws.recv())
        if hello.get("type") != "auth_required":
            sys.exit(f"unexpected greeting from HA: {hello}")
        self.ws.send(json.dumps({"type": "auth",
                                 "access_token": env["HA_TOKEN"]}))
        ack = json.loads(self.ws.recv())
        if ack.get("type") != "auth_ok":
            sys.exit(f"auth refused: {ack.get('message', ack)}")

    def __enter__(self):
        return self

    def __exit__(self, *_):
        try:
            self.ws.close()
        except OSError:
            pass

    def cmd(self, type_, **fields):
        self._id += 1
        self.ws.send(json.dumps({"id": self._id, "type": type_, **fields}))
        # Events for other subscriptions can interleave; only our id matters.
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self._id and msg.get("type") == "result":
                if not msg.get("success"):
                    err = msg.get("error", {})
                    sys.exit("%s failed: %s %s"
                             % (type_, err.get("code"), err.get("message")))
                return msg.get("result")


def do_list(ha):
    me = ha.cmd("auth/current_user")
    print("connected as %s (%s)" % (me.get("name"), me.get("id")))
    print("\ndashboards:")
    for d in ha.cmd("lovelace/dashboards/list"):
        print("  %-22s %-18s sidebar=%-5s mode=%s"
              % (d.get("url_path"), d.get("title"), d.get("show_in_sidebar"),
                 d.get("mode")))
    sidebar = ha.cmd("frontend/get_user_data", key="sidebar").get("value") or {}
    print("\nsidebar order (this user only -- not mirrored by ha_pull.sh):")
    for i, panel in enumerate(sidebar.get("panelOrder") or []):
        print("  %2d  %s" % (i, panel))
    print("hidden: %s" % (sidebar.get("hiddenPanels") or []))


def do_create(ha, url_path, title, icon):
    existing = {d["url_path"] for d in ha.cmd("lovelace/dashboards/list")}
    if url_path in existing:
        print("%s already exists -- nothing to create" % url_path)
        return
    fields = {"url_path": url_path, "title": title, "mode": "storage",
              "show_in_sidebar": True, "require_admin": False}
    if icon:
        fields["icon"] = icon
    ha.cmd("lovelace/dashboards/create", **fields)
    print("created %s (%s)" % (url_path, title))


def do_resources(ha):
    resources = ha.cmd("lovelace/resources")
    if not resources:
        print("no Lovelace resources registered")
        return
    print("resources:")
    for r in resources:
        print("  %-7s %-46s id=%s"
              % (r.get("type"), r.get("url"), r.get("id")))


def do_resource(ha, url, res_type):
    """Register url as a Lovelace resource, or repoint the one already there.

    The path is the identity, not the whole URL. The ?v= on the end is a
    cache-buster for the browser, and bumping it is an UPDATE -- registering it
    again would leave HA loading the same module twice, once per version, which
    is a confusing way to find out you have two copies of a card.
    """
    path, _, query = url.partition("?")
    ver = dict(q.partition("=")[::2] for q in query.split("&") if q).get("v")
    if ver is not None and not SEMVER.match(ver):
        sys.exit(f"?v={ver} is not MAJOR.MINOR.PATCH -- use the card's VERSION, "
                 "or pass --card and let it be read from the file")
    for r in ha.cmd("lovelace/resources"):
        if (r.get("url") or "").split("?")[0] != path:
            continue
        if r.get("url") == url and r.get("type") == res_type:
            print("%s already registered -- unchanged" % url)
            return
        ha.cmd("lovelace/resources/update", resource_id=r["id"], url=url,
               res_type=res_type)
        print("repointed %s -> %s" % (r.get("url"), url))
        return
    ha.cmd("lovelace/resources/create", url=url, res_type=res_type)
    print("registered %s (%s)" % (url, res_type))
    print("NOTE: /local/ only exists if /config/www did at startup -- if this "
          "is the first card, `ha core restart` once.")


def do_push(ha, path, url_path):
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    # Accept either a bare config or the .storage wrapper the mirror stores,
    # so a file straight out of dashboards/ can be pushed back untouched.
    config = raw.get("data", {}).get("config", raw)
    if "views" not in config:
        sys.exit(f"{path} has no views -- is it a dashboard?")
    ha.cmd("lovelace/config/save", url_path=url_path, config=config)
    back = ha.cmd("lovelace/config", url_path=url_path, force=True)
    if back != config:
        sys.exit("pushed, but HA read back something different -- inspect it")
    print("pushed %d view(s) to %s, read back identical"
          % (len(config["views"]), url_path))


def do_order(ha, url_path, after):
    """Put url_path immediately after `after` in this user's sidebar, or first
    when `after` is None.

    Read-modify-write, never a blind write: set_user_data replaces the whole
    `sidebar` key, so writing just panelOrder would drop hiddenPanels and pop
    every hidden panel back into the sidebar.
    """
    sidebar = dict(ha.cmd("frontend/get_user_data", key="sidebar").get("value") or {})
    order = list(sidebar.get("panelOrder") or [])
    if not order:
        sys.exit("this user has no panelOrder yet -- drag one sidebar item in "
                 "the UI to create it, then re-run")
    if after is not None and after not in order:
        sys.exit(f"anchor {after!r} is not in panelOrder: {order}")

    order = [p for p in order if p != url_path]          # idempotent
    order.insert(0 if after is None else order.index(after) + 1, url_path)
    if order == (sidebar.get("panelOrder") or []):
        print("%s already sits %s -- unchanged"
              % (url_path, "first" if after is None else "after " + after))
        return

    sidebar["panelOrder"] = order
    ha.cmd("frontend/set_user_data", key="sidebar", value=sidebar)
    check = (ha.cmd("frontend/get_user_data", key="sidebar").get("value") or {})
    if check.get("panelOrder") != order:
        sys.exit("wrote the order but HA read back something else")
    if check.get("hiddenPanels") != sidebar.get("hiddenPanels"):
        sys.exit("hiddenPanels changed -- that is the read-modify-write bug")
    print("sidebar: %s" % " -> ".join(order))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--list", action="store_true",
                    help="dashboards, sidebar order and the connected user")
    ap.add_argument("--whoami", action="store_true")
    ap.add_argument("--create", metavar="URL_PATH",
                    help="create a storage-mode dashboard (needs --title)")
    ap.add_argument("--title")
    ap.add_argument("--icon")
    ap.add_argument("--push", metavar="FILE",
                    help="save a dashboard config (needs --url-path)")
    ap.add_argument("--url-path")
    ap.add_argument("--order", metavar="URL_PATH",
                    help="move a panel in this user's sidebar (needs --after or --first)")
    ap.add_argument("--after", metavar="URL_PATH")
    ap.add_argument("--first", action="store_true", help="with --order: to the top")
    ap.add_argument("--list-resources", action="store_true",
                    help="the Lovelace resources this HA loads into the frontend")
    ap.add_argument("--resource", metavar="URL",
                    help="register or repoint a Lovelace resource, e.g. "
                         "/local/dtek-shutdowns-card.js?v=1.1.0")
    ap.add_argument("--card", metavar="FILE",
                    help="register a card from config/www at ?v=<its VERSION>, "
                         "e.g. climate-console-card.js")
    ap.add_argument("--res-type", default="module", choices=("module", "css"))
    args = ap.parse_args(argv)

    with HA(load_env()) as ha:
        if args.whoami:
            me = ha.cmd("auth/current_user")
            print(json.dumps({k: me.get(k) for k in ("id", "name", "is_admin")},
                             indent=2))
        if args.list:
            do_list(ha)
        if args.create:
            if not args.title:
                sys.exit("--create needs --title")
            do_create(ha, args.create, args.title, args.icon)
        if args.list_resources:
            do_resources(ha)
        # Before --push, so a dashboard is never saved naming a custom card
        # whose module HA has not been told to load.
        if args.resource:
            do_resource(ha, args.resource, args.res_type)
        if args.card:
            do_resource(ha, card_url(args.card), "module")
        if args.push:
            if not args.url_path:
                sys.exit("--push needs --url-path")
            do_push(ha, args.push, args.url_path)
        if args.order:
            if bool(args.after) == args.first:
                sys.exit("--order needs exactly one of --after and --first")
            do_order(ha, args.order, None if args.first else args.after)
    return 0


if __name__ == "__main__":
    sys.exit(main())
