/**
 * History loading in the battery and inverter console cards.
 *
 *     node HomeAssistant/tools/test_console_history.js
 *
 * The recorder keeps raw states for two days, and both cards offer 7 and 14
 * day windows. Fetching those from raw history drew a sliver at the right edge
 * under a "last 14 days" label, with min/max/mean worked out from the sliver
 * (2026-09-30 review). Past the horizon they now take the hourly long-term
 * statistics, as the climate card does; this pins which query each window
 * uses and what comes back, against a fake Home Assistant.
 *
 * Same approach as test_climate_chart.js: the card is loaded as-is into a
 * small DOM stub and its methods are called on the real prototype.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const WWW = path.join(__dirname, "..", "config", "www");
const HOUR = 3600000, DAY = 24 * HOUR;

function loadCard(file) {
  let Klass = null;
  const sandbox = {
    HTMLElement: class {},
    CustomEvent: class {},
    customElements: { get: () => undefined, define: (_n, k) => { Klass = k; } },
    window: { customCards: [], setInterval: () => 0, clearInterval: () => {},
              setTimeout: () => 0, clearTimeout: () => {} },
    document: { head: null, getElementById: () => null, createElement: () => ({}) },
    console: { info: () => {} },
    Math: Math, Date: Date, Number: Number, JSON: JSON,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(WWW, file), "utf8"), sandbox, { filename: file });
  if (!Klass) throw new Error(file + " did not define a custom element");
  return Klass;
}

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(name + (detail ? " -- " + detail : ""));
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  check(name, g === w, "got " + g + ", wanted " + w);
}

/** A card instance wired to a fake HA that answers from `stats` and `raw`. */
function rig(Card, entity, stats, raw) {
  const calls = [];
  const c = Object.assign(Object.create(Card.prototype), {
    _hist: new Map(), _inflight: new Map(),
    _config: { probe: entity },
    _hass: {
      callWS: async (msg) => {
        calls.push(msg.type);
        if (msg.type === "recorder/statistics_during_period") return stats;
        return raw;
      },
    },
  });
  return { c, calls };
}

async function suite(file, spec) {
  const Card = loadCard(file);
  const E = "sensor.probe";
  const now = Date.now();
  const hourly = { [E]: Array.from({ length: 24 * 14 }, (_, i) => ({
    start: now - 14 * DAY + i * HOUR, mean: 50 + (i % 10) })) };
  const lastTwoDays = { [E]: Array.from({ length: 48 }, (_, i) => ({
    s: String(40 + (i % 5)), lu: (now - 2 * DAY + i * HOUR) / 1000 })) };

  // 24 h: inside the raw horizon, raw history as before.
  let { c, calls } = rig(Card, E, hourly, lastTwoDays);
  let rec = await c._load(spec, "k24", now - DAY, now, 1500, 0);
  eq(file + ": 24 h reads raw history", calls, ["history/history_during_period"]);
  check(file + ": 24 h has points", rec.pts.length > 0);

  // 14 d: hourly statistics, spanning the whole window.
  ({ c, calls } = rig(Card, E, hourly, lastTwoDays));
  rec = await c._load(spec, "k14", now - 14 * DAY, now, 1500, 0);
  eq(file + ": 14 d reads statistics only", calls, ["recorder/statistics_during_period"]);
  check(file + ": 14 d starts two weeks back, not two days",
        rec.pts.length && rec.pts[0][0] <= now - 13 * DAY,
        rec.pts.length ? new Date(rec.pts[0][0]).toISOString() : "no points");
  eq(file + ": 14 d carries no note", rec.note, null);

  // 14 d on a sensor with no statistics: falls back, and says so.
  ({ c, calls } = rig(Card, E, {}, lastTwoDays));
  rec = await c._load(spec, "k14b", now - 14 * DAY, now, 1500, 0);
  eq(file + ": no statistics -> raw history", calls,
     ["recorder/statistics_during_period", "history/history_during_period"]);
  eq(file + ": ...and says only two days are kept", rec.note,
     "only the last two days are kept for this sensor");
}

(async () => {
  await suite("jkbms-battery-console-card.js", { cfg: "probe" });
  await suite("powmr-inverter-console-card.js", { cfg: "probe" });
  if (failures.length) {
    console.log("test_console_history: " + failures.length + " failure(s), " + pass + " passed");
    failures.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
  console.log("test_console_history: ok — " + pass + " checks passed");
})().catch((e) => { console.log("test_console_history: crashed -- " + e.stack); process.exit(1); });
