/**
 * Tests for config/www/card-fx.js, the visual effects the console cards share.
 *
 *     node HomeAssistant/tools/test_card_fx.js
 *
 * The module decides whether a card draws any effect at all (only with an
 * `fx` list), rejects a misspelt effect where the editor shows it, and pauses
 * a card's animations off screen. Each card's own effects are tested in
 * test_power_cards.js; this is the shared part.
 *
 * Exit status is 0 when every case passes, 1 otherwise.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { WWW, Element } = require("./fake_dom");

let pass = 0;
const failures = [];
let group = "";

function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(group + name + (detail ? " -- " + detail : ""));
}

function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  check(name, g === w, "got " + g + ", wanted " + w);
}

function throws(name, fn, re) {
  try { fn(); } catch (e) { check(name, !re || re.test(e.message), "threw " + e.message); return; }
  check(name, false, "did not throw");
}

/** The module in a fresh sandbox, with a controllable observer and document. */
function load() {
  const docListeners = {};
  const observers = [];
  const sandbox = {
    window: {
      IntersectionObserver: class {
        constructor(cb) { this.cb = cb; this.off = false; observers.push(this); }
        observe(el) { this.el = el; }
        disconnect() { this.off = true; }
      },
    },
    document: {
      hidden: false,
      addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
      removeEventListener: (t, fn) => { docListeners[t] = (docListeners[t] || []).filter((f) => f !== fn); },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(WWW, "card-fx.js"), "utf8").replace(/^export /gm, "")
    + "\n;globalThis.M = { VERSION, EFFECTS, fxConfig, fxOn, fxList, fxSetup, FX_CSS };";
  vm.runInContext(src, sandbox, { filename: "card-fx.js" });
  return { M: sandbox.M, sandbox: sandbox, docListeners: docListeners, observers: observers };
}

/* --- registry ------------------------------------------------------------- */
group = "registry: ";
{
  const { M } = load();
  eq("eight effects", M.EFFECTS.map((e) => e.id), ["power_glow", "liquid_soc", "balance_pulse",
    "chart_polish", "gradient_dial", "tinted_rooms", "live_thresholds", "danger_zone"]);
  check("every effect names a card and a tip", M.EFFECTS.every((e) => e.cards.length && e.tip && e.label));
  check("VERSION is semver", /^\d+\.\d+\.\d+$/.test(M.VERSION));
}

/* --- config ------------------------------------------------------------- */
group = "fxConfig: ";
{
  const { M } = load();
  eq("absent -> null", M.fxConfig("c", undefined), null);
  eq("false -> null", M.fxConfig("c", false), null);
  eq("a list is kept", M.fxConfig("c", ["power_glow", "danger_zone"]), ["power_glow", "danger_zone"]);
  throws("unknown id", () => M.fxConfig("my-card", ["glw"]), /my-card: unknown fx glw/);
  throws("the dropped odometer", () => M.fxConfig("c", ["odometer"]), /unknown fx odometer/);
  throws("the retired playground mode", () => M.fxConfig("c", "playground"), /fx must be a list/);
}

/* --- on / off ------------------------------------------------------------- */
group = "fxOn: ";
{
  const { M } = load();
  check("no fx: never on", !M.fxOn(null, "power_glow"));
  check("listed: on", M.fxOn(["liquid_soc"], "liquid_soc"));
  check("not listed: off", !M.fxOn(["liquid_soc"], "power_glow"));
  eq("fxList in registry order", M.fxList(["danger_zone", "power_glow"]), "power_glow danger_zone");
}

/* --- setup ------------------------------------------------------------------ */
group = "fxSetup: ";
{
  const { M, sandbox, docListeners, observers } = load();
  const host = new Element("host");
  M.fxSetup(host, null)();
  eq("no fx: no data-fx", host.getAttribute("data-fx"), null);
  eq("no fx: nothing observed", observers.length, 0);
  const stop = M.fxSetup(host, ["liquid_soc", "power_glow"]);
  eq("data-fx lists the effects", host.getAttribute("data-fx"), "power_glow liquid_soc");
  observers[0].cb([{ isIntersecting: false }]);
  check("off screen: paused", host.hasAttribute("data-fx-paused"));
  observers[0].cb([{ isIntersecting: true }]);
  check("back on screen: running", !host.hasAttribute("data-fx-paused"));
  sandbox.document.hidden = true;
  docListeners.visibilitychange.forEach((f) => f());
  check("hidden tab: paused", host.hasAttribute("data-fx-paused"));
  stop();
  check("teardown disconnects the observer", observers[0].off);
  eq("teardown drops the visibility listener", docListeners.visibilitychange.length, 0);
  check("reduced motion stops every effect animation",
    /prefers-reduced-motion[\s\S]*animation: none !important/.test(M.FX_CSS));
}

const total = pass + failures.length;
if (failures.length) {
  console.log("test_card_fx: " + failures.length + " failure(s), " + pass + " passed");
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("test_card_fx: ok — " + total + " checks passed");
