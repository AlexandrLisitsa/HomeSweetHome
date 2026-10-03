"""MeterBots' HTTP side: what Home Assistant calls to file a meter reading.

Home Assistant decides when and what; this only walks the supplier's bot and
answers JSON. Every bot route needs its own token, and with that token unset
the route refuses everyone: filing a reading as the household is not something
a stray script on the LAN may do.

    GET  /health              alive, which bots are configured, the session
    GET  /gas/bot/status      dry run of @mygrmu_bot, sends nothing
    POST /gas/bot/submit      {"value": 2262}

Routes and tokens: docs/api.md.
"""
import os

from flask import Flask, jsonify, request

from . import gasbot, tgclient

VERSION = "1.0.0"

APP = Flask(__name__)

GASBOT_TOKEN = os.environ.get("GASBOT_TOKEN") or None


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
                    "bots": {"gas": GASBOT_TOKEN is not None},
                    "session": tgclient.session_present()})


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


def create_app():
    return APP
