"""MeterBots' HTTP side: what Home Assistant calls to file a meter reading.

Home Assistant decides when and what; this only walks the supplier's bot and
answers JSON. Every bot route needs its own token, and with that token unset
the route refuses everyone: filing a reading as the household is not something
a stray script on the LAN may do.

    GET  /health              alive, which bots are configured, the session
    GET  /session             is the Telegram session still logged in
    GET  /gas/bot/status     dry run of @mygrmu_bot, sends nothing
    POST /gas/bot/submit      {"value": 2262}
    GET  /yasno/bot/status    dry run of @Yasnoonlinebot, sends nothing
    POST /yasno/bot/submit    {"day": 38500, "night": 6450}

Routes and tokens: docs/api.md.
"""
import os

from flask import Flask, jsonify, request

from . import gasbot, tgclient, yasnobot

VERSION = "1.2.0"

APP = Flask(__name__)

GASBOT_TOKEN = os.environ.get("GASBOT_TOKEN") or None
YASNOBOT_TOKEN = os.environ.get("YASNOBOT_TOKEN") or None


def deny():
    return jsonify({"error": "unauthorised"}), 401


def gasbot_authorised():
    supplied = request.headers.get("X-Gasbot-Token")
    return GASBOT_TOKEN is not None and supplied == GASBOT_TOKEN


@APP.route("/health")
def health():
    """Never a secret: which bots have their token, and whether a session
    file exists -- not whether it is still logged in, which takes a network
    round trip."""
    return jsonify({"status": "ok", "version": VERSION,
                    "bots": {"gas": GASBOT_TOKEN is not None,
                             "yasno": YASNOBOT_TOKEN is not None},
                    "session": tgclient.session_present()})


@APP.route("/session")
def session():
    """Whether the Telegram session is still logged in: one round trip to
    Telegram, nothing sent to any bot. Either bot's token opens it. Home
    Assistant asks weekly, so a logged-out session is found weeks before the
    monthly ask instead of at it."""
    if not (gasbot_authorised() or yasnobot_authorised()):
        return deny()
    return jsonify(tgclient.session_check())


@APP.route("/gas/bot/status")
def gas_bot_status():
    """Walk @mygrmu_bot to the value prompt and back; send nothing."""
    if not gasbot_authorised():
        return deny()
    return jsonify(gasbot.run())


@APP.route("/gas/bot/submit", methods=["POST"])
def gas_bot_submit():
    """Send ONE monthly reading to @mygrmu_bot. Body: {"value": 2262}."""
    if not gasbot_authorised():
        return deny()
    body = request.get_json(silent=True) or {}
    try:
        value = float(str(body.get("value", "")).replace(",", "."))
    except ValueError:
        return jsonify({"ok": False, "error": "value must be a number"}), 400
    if value <= 0 or value >= 100000 or round(value, 2) != value:
        return jsonify({"ok": False, "error": "value out of range: %r" % body.get("value")}), 400
    result = gasbot.run(value)
    print("gas bot submit %s -> %s" % (value, "ok" if result.get("ok")
                                        else result.get("error")), flush=True)
    return jsonify(result)


def yasnobot_authorised():
    supplied = request.headers.get("X-Yasnobot-Token")
    return YASNOBOT_TOKEN is not None and supplied == YASNOBOT_TOKEN


@APP.route("/yasno/bot/status")
def yasno_bot_status():
    """Walk @Yasnoonlinebot to the reading prompt and back; send nothing.
    Answers the previous day/night readings."""
    if not yasnobot_authorised():
        return deny()
    return jsonify(yasnobot.run())


@APP.route("/yasno/bot/submit", methods=["POST"])
def yasno_bot_submit():
    """Send ONE monthly electricity reading. Body: {"day": 38500, "night": 6450},
    whole kWh, as the meter's T21 and T22 read before the comma."""
    if not yasnobot_authorised():
        return deny()
    body = request.get_json(silent=True) or {}
    values = {}
    for zone in ("day", "night"):
        raw = str(body.get(zone, "")).strip()
        if not raw.isdigit():
            return jsonify({"ok": False, "error": "%s must be whole kWh: %r"
                            % (zone, body.get(zone))}), 400
        values[zone] = int(raw)
        if not 0 < values[zone] < 1000000:
            return jsonify({"ok": False, "error": "%s out of range: %r"
                            % (zone, body.get(zone))}), 400
    result = yasnobot.run(values["day"], values["night"])
    print("yasno bot submit %d %d -> %s" % (values["day"], values["night"],
                                           "ok" if result.get("ok") else result.get("error")),
          flush=True)
    return jsonify(result)


def create_app():
    return APP
