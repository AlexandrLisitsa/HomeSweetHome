/**
 * Every meaningful element on every custom card has a tooltip in the house
 * format (docs/dashboard-tooltips.md, MANIFEST.md §8):
 *
 *     <Name> — <live state>
 *     <What it is or does.>
 *     E.g. <a concrete example>
 *     <optional: a limit or a non-obvious tap>
 *
 *     node HomeAssistant/tools/test_card_tooltips.js            fail on any miss
 *     node HomeAssistant/tools/test_card_tooltips.js --list     also print every tooltip
 *
 * Each card is rendered with the config the dashboards really use
 * (dashboards/*.json) against a fake `hass` in which every entity exists: a
 * plausible state by domain, overridden per card in FIXTURES where a card needs
 * more than that to draw everything. Then every element in scope is checked:
 *
 *   - in scope: anything you can tap or type into ([data-more], [data-act],
 *     [role=button], [role=switch], button, select, input, textarea), plus the
 *     read-only selectors each card lists in READ_ONLY;
 *   - its tooltip is its own `data-tip`, or else the nearest ancestor's (the
 *     card's tooltip box shows that one);
 *   - three or four lines, none over 90 characters, the third starting "E.g.".
 *
 * Every string in a card's HELP map is checked on its own as well (lines 2-4
 * of a tooltip: two or three lines, the second starting "E.g."), so a
 * description for a state the fixtures never draw is still held to the format.
 * A second `set hass` must leave every tooltip as it was: none may stack.
 *
 * The tooltips are drawn by the shared config/www/card-tip.js, never by a native
 * `title`: a browser closes a native tooltip the moment its text changes, and
 * line 1 carries a live state. So no rendered element may carry `title` or an
 * SVG <title>, every card must import the module at its current VERSION, and a tooltip
 * opened over a tile must stay open, with the new text, across a sensor
 * update -- on a card that patches in place and on one that redraws whole.
 *
 * Exit status is 0 when everything passes, 1 otherwise.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { WWW, Element, loadCard, mkHass, S } = require("./fake_dom");

const DASH = path.join(__dirname, "..", "dashboards");
const LIST = process.argv.includes("--list");
const MAX_LINE = 90;

const FILES = {
  "custom:floorplan-card": "floorplan-card.js",
  "custom:climate-console-card": "climate-console-card.js",
  "custom:powmr-inverter-console-card": "powmr-inverter-console-card.js",
  "custom:jkbms-battery-console-card": "jkbms-battery-console-card.js",
  "custom:dtek-shutdowns-card": "dtek-shutdowns-card.js",
  "custom:load-shedding-card": "load-shedding-card.js",
};

const INTERACTIVE = "[data-more], [data-act], [role=button], [role=switch], button, select, input, textarea";

/** Elements that show something without being tappable, per card. */
const READ_ONLY = {
  "powmr-inverter-console-card.js": [".tile", ".pill", ".erow", ".stat", ".t-state", ".ret", ".hname .w"],
  "jkbms-battery-console-card.js": [".meter", ".fcard", ".ttile", ".trow", ".stat"],
  "load-shedding-card.js": ["h1", ".tile", ".mark", ".st", "tbody tr"],
  "climate-console-card.js": [".badge", ".tile", ".well", ".row", ".fval", ".zone", ".vbox",
    ".st-v", ".ch-name", ".win", ".dial", ".dial-v", ".rmark", ".fine", "#bed-fan-fine",
    ".cost-c", ".feat-l"],
  "dtek-shutdowns-card.js": [".eyebrow", ".ident", "h1", ".reason", ".tile", ".c", ".dtot",
    ".legend span", ".stamp", ".kv div"],
  "floorplan-card.js": [".badge", ".row .value", ".pct"],
};

/** Selectors that are in scope by the rules above but exempt by the standard. */
const EXEMPT = {
  "powmr-inverter-console-card.js": [],
  "jkbms-battery-console-card.js": [],
  "load-shedding-card.js": [],
  "climate-console-card.js": [],
  "dtek-shutdowns-card.js": [],
  "floorplan-card.js": [],
};

/**
 * Per-card state overrides on top of the domain defaults, so the card draws
 * its full layout. Return a map of entity id -> state object.
 */
const FIXTURES = {
  // A night charge two minutes into a grid return: both plans charging, so
  // the AC charge chip's sub-labels draw, and the pill's countdown runs.
  "powmr-inverter-console-card.js": () => {
    const until = new Date(Date.now() + 6 * 3600000).toISOString();
    return {
      "sensor.powmr_inverter_grid_voltage": S("231.4"),
      "binary_sensor.powmr_inverter_grid_voltage_in_range": S("on", {},
        { last_changed: new Date(Date.now() - 120000).toISOString() }),
      "sensor.jkbms_gateway_bms_power": S("1450"),
      "sensor.jkbms_gateway_bms_state_of_charge": S("62"),
      "select.powmr_inverter_max_ac_charge_current": S("30", { options: ["02", "10", "20", "30", "40", "50", "60"] }),
      "select.powmr_inverter_power_priority": S("Utility First", { options: ["Utility First", "Solar First", "SBU Battery"] }),
      "select.powmr_inverter_inverter_ac_input_mode": S("APL", { options: ["APL", "UPS"] }),
      "sensor.adaptive_charge_plan": S("charging", { current: 30, until: until, reason: "needs 21.5 A to be full by 06:30" }),
      "sensor.outage_pre_charge_plan": S("charging", { current: 30, until: until, reason: "filling within the night tariff" }),
    };
  },
  "jkbms-battery-console-card.js": () => ({}),
  // The seeded rules (packages/load_shedding.yaml), with the hall A/C's +3°
  // step from docs/load-shedding.md, mid-outage at 61 %: the hall A/C stepped
  // down, the bedroom A/C about to, LED ambient held.
  "load-shedding-card.js": () => {
    const since = new Date(Date.now() - 40 * 60000).toISOString();
    return {
      "sensor.load_shedding_config": S("ok", { override_step: 10, warn_margin: 1, devices: [
        { id: "hall_ac", name: "Hall A/C", entity: "climate.daewoo_a_c", enabled: true,
          guard: { plug: "switch.0x70b3d52b600fddcb", running: "binary_sensor.a_c_running",
            online: "binary_sensor.ir_bridge_online" },
          steps: [{ soc: 80, action: "climate.adjust_temperature", data: { by: 3 } },
            { soc: 60, action: "climate.set_hvac_mode", data: { hvac_mode: "off" } }] },
        { id: "bedroom_ac", name: "Bedroom A/C", entity: "climate.153931629566331_climate", enabled: true,
          guard: { plug: "switch.0xa4c13820fe9ec412", running: "binary_sensor.bedroom_a_c_running" },
          steps: [{ soc: 60, action: "climate.set_hvac_mode", data: { hvac_mode: "off" } }] },
        { id: "led_ambient", name: "LED ambient", entity: "light.0xa4c1385443844c1e", enabled: true,
          steps: [{ soc: 80, action: "light.turn_on", data: { brightness_pct: 30 } },
            { soc: 50, action: "light.turn_off", data: {} }] },
      ] }),
      "sensor.load_shedding": S("2", { loads: {
        hall_ac: { entity: "climate.daewoo_a_c", name: "Hall A/C", since: since, soc: 79, step_soc: 80,
          plug_cut: false, override_soc: null },
        led_ambient: { entity: "light.0xa4c1385443844c1e", name: "LED ambient", since: since, soc: 79,
          step_soc: 80, plug_cut: false, override_soc: 70 },
      } }),
      "input_boolean.load_shedding_enabled": S("on"),
      "binary_sensor.powmr_inverter_grid_condition_safe": S("on"),
      "sensor.jkbms_gateway_bms_state_of_charge": S("61"),
      "sensor.battery_runtime_remaining": S("4.3"),
    };
  },
  // A summer night on the night tariff: the hall A/C cooling with the room
  // above the setpoint, and the bedroom unit in Fan only, so its banner (and
  // the frozen dial it explains) draws. Rates are ac_tariffs.yaml's.
  "climate-console-card.js": () => {
    const bed = { hvac_modes: ["off", "auto", "cool", "heat", "dry", "fan_only"],
      fan_modes: ["silent", "low", "medium", "high", "full", "auto"], fan_mode: "low",
      swing_modes: ["off", "vertical", "horizontal", "both"], swing_mode: "off",
      current_temperature: 24.6, temperature: 23, min_temp: 16, max_temp: 30, target_temp_step: 0.5 };
    return {
      "climate.daewoo_a_c": S("cool", { hvac_modes: ["off", "cool", "heat", "heat_cool", "fan_only", "dry"],
        fan_modes: ["low", "mid", "high"], fan_mode: "mid", swing_modes: ["off", "on"], swing_mode: "off",
        current_temperature: 25.8, current_humidity: 52, temperature: 23, min_temp: 18, max_temp: 30,
        target_temp_step: 1 }),
      "climate.153931629566331_climate": S("fan_only", bed),
      "sensor.a_c_activity": S("Cooling"),
      "sensor.bedroom_a_c_activity": S("Fan only"),
      "sensor.153931629566331_indoor_temperature": S("24.6"),
      "sensor.153931629566331_indoor_humidity": S("48"),
      "sensor.electricity_tariff_zone": S("night"),
      "input_number.electricity_tariff_day": S("4.32", { min: 0, max: 100, step: 0.01 }),
      "input_number.electricity_tariff_night": S("2.16", { min: 0, max: 100, step: 0.01 }),
      "sensor.a_c_cost_today": S("11.23", { day_kwh: 1.2, night_kwh: 2.8, battery_kwh: 0.0 }),
    };
  },
  // DTEK's 29.09.2026 emergency notice while mains is present, with a live
  // recurring week (16 possible-outage hours and two half hours a day), a
  // drift warning, and a placeholder address -- MANIFEST.md §4.
  "dtek-shutdowns-card.js": () => {
    const now = Date.now();
    const day = "mmmmmFyyyyyySmmmmmmmmmmm";
    const week = [day, "mmmmmfyyyyyysnnnmmmmmmmm", day, day, day, day, day];
    return {
      "sensor.dtek_shutdowns": S("outage_emergency", {
        friendly_name: "DTEK shutdowns", address: "Example St, 1",
        queue: "3.1", queue_code: "GPV3.1", queues: ["GPV3.1"], multi_line: false,
        cek: false, voluntarily: false, outage_active: true, outage_type: "2",
        outage_reason: "Аварійні ремонтні роботи",
        outage_start: new Date(now - 36e5).toISOString(),
        outage_end: new Date(now + 72e5).toISOString(),
        outage_start_raw: "11:05 29.09.2026", outage_end_raw: "15:25 29.09.2026",
        street_outages: 1, street_houses: 288, updated_at: "14:01 29.09.2026",
        warnings: ["unknown outage type '3'"],
        schedule_in_effect: false, schedule_update: "24.07.2026 08:30",
        today: null, tomorrow: null, next_outage_start: null, next_outage_end: null,
        week: week, week_in_effect: true, schedule_visible: false, hidden_reason: null,
        fetched_at: new Date(now).toISOString(), stale: false, error: null,
      }),
      "binary_sensor.powmr_inverter_grid_condition_safe": S("off", {}),
      "binary_sensor.grid_outage_unscheduled": S("off", {}),
      "binary_sensor.dtek_data_stale": S("off", {}),
    };
  },
  // A dimmable lamp at 25 %, relays on/off only, readings with their units.
  "floorplan-card.js": (cfg) => {
    const out = {};
    (cfg.lights || []).forEach((l) => {
      if (!l.entity.startsWith("light.")) return;
      out[l.entity] = /relay/.test(l.entity) ? S("on", { supported_color_modes: ["onoff"] })
        : S("on", { supported_color_modes: ["brightness"], brightness: 64 });
    });
    (cfg.devices || []).forEach((d) => {
      if (d.value) out[d.value] = S("40", { unit_of_measurement: "W" });
      if (!d.entity.startsWith("sensor.")) return;
      out[d.entity] = /state_of_charge/.test(d.entity) ? S("80", { unit_of_measurement: "%" })
        : /download/.test(d.entity) ? S("12", { unit_of_measurement: "Mbit/s" })
          : S("450", { unit_of_measurement: "W" });
    });
    (cfg.badges || []).forEach((b) => {
      out[b.entities[0]] = S("24.3", { unit_of_measurement: "°C" });
      if (b.entities[1]) out[b.entities[1]] = S("48", { unit_of_measurement: "%" });
    });
    return out;
  },
};

/* --- the fake house -------------------------------------------------------- */

const ON_DOMAINS = new Set(["switch", "light", "fan", "input_boolean", "binary_sensor", "automation", "script"]);

function defaultState(id) {
  const domain = id.split(".")[0];
  const name = id.split(".")[1].replace(/_/g, " ");
  const a = { friendly_name: name.charAt(0).toUpperCase() + name.slice(1) };
  if (ON_DOMAINS.has(domain)) return S("on", a);
  if (domain === "select" || domain === "input_select") return S("one", Object.assign(a, { options: ["one", "two"] }));
  if (domain === "climate") {
    return S("cool", Object.assign(a, { hvac_modes: ["off", "cool", "heat", "auto", "dry", "fan_only"],
      current_temperature: 24, temperature: 23, fan_mode: "auto", fan_modes: ["auto", "low", "medium", "high"],
      swing_mode: "off", swing_modes: ["off", "vertical", "horizontal", "both"], min_temp: 16, max_temp: 30 }));
  }
  if (domain === "input_number" || domain === "number") return S("50", Object.assign(a, { min: 0, max: 100, step: 1 }));
  if (domain === "input_text" || domain === "text") return S("", a);
  if (domain === "media_player") return S("playing", a);
  return S("12.5", a);
}

/** States where every entity id exists: the fixture's, or a default by domain. */
function house(overrides) {
  const fixed = Object.assign({}, overrides);
  Object.keys(fixed).forEach((k) => { if (fixed[k]) fixed[k].entity_id = k; });
  return new Proxy(fixed, {
    get: (t, k) => {
      if (typeof k !== "string") return t[k];
      if (k in t) return t[k];
      if (!/^[a-z_]+\.[a-z0-9_]+$/.test(k)) return undefined;
      t[k] = Object.assign(defaultState(k), { entity_id: k });
      return t[k];
    },
    has: (t, k) => typeof k === "string" && /^[a-z_]+\.[a-z0-9_]+$/.test(k) ? true : k in t,
  });
}

/* --- reading tooltips ------------------------------------------------------ */

function ownTip(el) {
  return el.hasAttribute("data-tip") ? el.getAttribute("data-tip") : null;
}

/** The tooltip a browser shows over `el`: its own, or the nearest ancestor's. */
function tipOf(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
    const t = ownTip(n);
    if (t !== null && t !== "") return t;
  }
  return null;
}

function describe(el) {
  const bits = [el.localName];
  const cls = el.className;
  if (cls) bits.push("." + cls.trim().split(/\s+/).join("."));
  ["data-ref", "id", "data-more", "data-act", "data-ent", "data-key"].forEach((a) => {
    if (el.hasAttribute(a)) bits.push("[" + a + "=" + el.getAttribute(a) + "]");
  });
  const text = el.textContent.replace(/\s+/g, " ").trim();
  return bits.join("") + (text ? " \"" + text.slice(0, 30) + "\"" : "");
}

/** Problems with a full tooltip, or [] when it meets the format. */
function tipProblems(t) {
  if (t === null) return ["no tooltip"];
  const lines = t.split("\n");
  const out = [];
  if (lines.length < 3 || lines.length > 4) out.push(lines.length + " lines, want 3-4");
  if (!lines[0] || !lines[0].trim()) out.push("line 1 empty");
  if (lines.length > 1 && (!lines[1].trim() || /^E\.g\./.test(lines[1]))) out.push("line 2 is not a description");
  if (lines.length > 2 && !/^E\.g\. \S/.test(lines[2])) out.push("line 3 does not start \"E.g.\"");
  lines.forEach((l, i) => { if (l.length > MAX_LINE) out.push("line " + (i + 1) + " is " + l.length + " chars"); });
  return out;
}

/** Problems with one HELP entry: lines 2-4 of a tooltip. */
function helpProblems(h) {
  const lines = h.split("\n");
  const out = [];
  if (lines.length < 2 || lines.length > 3) out.push(lines.length + " lines, want 2-3");
  if (!lines[0].trim() || /^E\.g\./.test(lines[0])) out.push("first line is not a description");
  if (lines.length > 1 && !/^E\.g\. \S/.test(lines[1])) out.push("second line does not start \"E.g.\"");
  lines.forEach((l, i) => { if (l.length > MAX_LINE) out.push("line " + (i + 2) + " is " + l.length + " chars"); });
  return out;
}

/* --- runner ---------------------------------------------------------------- */

function cardConfigs() {
  const out = [];
  const walk = (o, where) => {
    if (Array.isArray(o)) { o.forEach((x) => walk(x, where)); return; }
    if (!o || typeof o !== "object") return;
    if (typeof o.type === "string" && FILES[o.type]) out.push({ cfg: o, where: where });
    Object.keys(o).forEach((k) => walk(o[k], where));
  };
  fs.readdirSync(DASH).filter((f) => /^lovelace\.dashboard_.*\.json$/.test(f)).sort().forEach((f) => {
    const views = JSON.parse(fs.readFileSync(path.join(DASH, f), "utf8")).data.config.views || [];
    views.forEach((v) => walk(v, f.replace(/^lovelace\.|\.json$/g, "") + "/" + (v.path || v.title)));
  });
  return out;
}

const failures = [];
let checked = 0;

function fail(where, what, problems) {
  failures.push(where + ": " + what + " -- " + problems.join("; "));
}

function inScope(root, file) {
  const sel = [INTERACTIVE].concat(READ_ONLY[file] || []).join(", ");
  const exempt = EXEMPT[file] && EXEMPT[file].length ? root.querySelectorAll(EXEMPT[file].join(", ")) : [];
  return root.querySelectorAll(sel).filter((el) => exempt.indexOf(el) < 0);
}

function checkCard(entry) {
  const file = FILES[entry.cfg.type];
  const where = entry.where + " " + file + (entry.cfg.tab ? "#" + entry.cfg.tab : "");
  const L = loadCard(file);
  const card = new L.Card();
  card.setConfig(entry.cfg);
  const states = house(FIXTURES[file](entry.cfg));
  card.hass = mkHass(states);
  L.flushTimers();
  const root = card.shadowRoot || card;

  root.querySelectorAll("[title], title").forEach((el) => {
    fail(where, describe(el), ["a native title: it closes on every update, use data-tip"]);
  });

  const els = inScope(root, file);
  const first = new Map();
  els.forEach((el) => {
    checked++;
    const t = tipOf(el);
    first.set(el, t);
    const p = tipProblems(t);
    if (p.length) fail(where, describe(el), p);
    if (LIST) console.log(where + "  " + describe(el) + "\n    " + String(t).replace(/\n/g, "\n    "));
  });

  card.hass = mkHass(states);
  L.flushTimers();
  inScope(root, file).forEach((el) => {
    if (!first.has(el)) return;
    const t = tipOf(el);
    if (t !== first.get(el)) fail(where, describe(el), ["tooltip changed on a re-patch with the same states: "
      + JSON.stringify(t)]);
  });
  return L;
}

const helpSeen = new Set();
function checkHelp(file, L) {
  if (helpSeen.has(file)) return;
  helpSeen.add(file);
  let help = null;
  try { help = vm.runInContext("typeof HELP === 'undefined' ? null : HELP", L.sandbox); } catch (e) { help = null; }
  if (!help) { fail(file, "HELP", ["the card has no HELP map"]); return; }
  Object.keys(help).forEach((k) => {
    if (typeof help[k] !== "string") return;
    checked++;
    const p = helpProblems(help[k]);
    if (p.length) fail(file, "HELP." + k, p);
  });
}

const entries = cardConfigs();
Object.values(FILES).forEach((f) => {
  if (!entries.some((e) => FILES[e.cfg.type] === f)) fail(f, "card", ["not used on any dashboard"]);
});
entries.forEach((e) => {
  try {
    checkHelp(FILES[e.cfg.type], checkCard(e));
  } catch (err) {
    fail(e.where + " " + FILES[e.cfg.type], "render", ["threw " + (err && err.stack)]);
  }
});

/* --- the tooltip box ------------------------------------------------------ */

const TIP_SRC = fs.readFileSync(path.join(WWW, "card-tip.js"), "utf8");
const TIP_VERSION = (TIP_SRC.match(/^export const VERSION = "([^"]+)";$/m) || [])[1];
checked++;
if (!TIP_VERSION) fail("card-tip.js", "VERSION", ["no `export const VERSION`"]);
Object.values(FILES).forEach((f) => {
  const src = fs.readFileSync(path.join(WWW, f), "utf8");
  checked++;
  const m = src.match(/^import \{ cardTip \} from "\.\/card-tip\.js\?v=([^"]+)";$/m);
  if (!m) fail(f, "cardTip", ["does not import cardTip from ./card-tip.js"]);
  else if (m[1] !== TIP_VERSION) fail(f, "cardTip", ["imports card-tip.js?v=" + m[1] + ", but its VERSION is " + TIP_VERSION]);
  if (/function cardTip\(/.test(src)) fail(f, "cardTip", ["carries its own copy; import the shared one"]);
  if (src.indexOf("cardTip(this, this.shadowRoot);") < 0) fail(f, "cardTip", ["never started in the constructor"]);
});

/* The parser that turns a data-tip string into the design's parts. */
{
  const sb = { document: undefined };
  vm.createContext(sb);
  vm.runInContext(TIP_SRC.replace(/^export /gm, "") + "\nthis.parseTip = parseTip;", sb);
  const cases = [
    ["Grid — 231.4 V · NOMINAL\nd\nE.g. e", { label: "Grid", value: "231.4 V", state: "NOMINAL", tone: "nominal" }],
    ["Grid — NO GRID\nd\nE.g. e", { label: "Grid", value: "", state: "NO GRID", tone: "fault" }],
    ["Grid — returning · APL\nd\nE.g. e", { value: "returning · APL", state: "" }],
    ["24 h\nd\nE.g. e", { label: "24 h", value: "", desc: "d", example: "e", note: "" }],
    ["P — on\nd\nE.g. e\nTap the icon: on or off.", { note: "Tap the icon: on or off.", noteKind: "tap" }],
    ["P — on\nd\nE.g. e\nCannot be on with Auto.", { noteKind: "rule" }],
  ];
  cases.forEach(([text, want]) => {
    checked++;
    const got = sb.parseTip(text);
    Object.keys(want).forEach((k) => {
      if (got[k] !== want[k]) fail("card-tip.js", "parseTip " + JSON.stringify(text), [k + " is " + JSON.stringify(got[k])]);
    });
  });
}

/**
 * Hover `sel` on `file`'s card, let the box open, change the house with
 * `change`, and check the box is still open and shows the element's new text.
 */
function hoverSurvivesUpdate(file, cfg, states, sel, change) {
  const where = file + " hover";
  const timers = [];
  let observed = null;
  const body = new Element("body");
  const doc = {
    body: body,
    head: null,
    getElementById: (id) => body.querySelector("#" + id),
    addEventListener: () => {},
    createElement: (t) => new Element(t),
    createElementNS: (_ns, t) => new Element(t),
  };
  const L = loadCard(file, {
    document: doc,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    MutationObserver: class { constructor(cb) { observed = cb; } observe() {} },
  });
  const card = new L.Card();
  card.setConfig(cfg);
  card.hass = mkHass(house(states));
  L.flushTimers();
  const root = card.shadowRoot;
  root.elementFromPoint = () => root.querySelector(sel);
  checked++;
  if (!observed) { fail(where, sel, ["cardTip did not start"]); return; }
  (card._listeners.pointermove || []).forEach((fn) => fn({ pointerType: "mouse", clientX: 100, clientY: 100 }));
  if (timers.length) timers.pop()();
  const box = doc.getElementById("card-tip");
  const before = root.querySelector(sel) && root.querySelector(sel).getAttribute("data-tip");
  const shown = () => box.getAttribute("data-text");
  if (!box || box.style.display !== "flex" || shown() !== before) {
    fail(where, sel, ["the box did not open on hover with the element's text"]);
    return;
  }
  card.hass = mkHass(house(Object.assign({}, states, change)));
  L.flushTimers();
  observed();
  const after = root.querySelector(sel) && root.querySelector(sel).getAttribute("data-tip");
  if (after === before) { fail(where, sel, ["the change did not reach line 1; pick another"]); return; }
  if (box.style.display !== "flex") fail(where, sel, ["the box closed on a sensor update"]);
  else if (shown() !== after) fail(where, sel, ["the box kept the old text: " + JSON.stringify(shown())]);
  else if (box.querySelector(".ct-label").textContent !== after.split("\n")[0].split(" — ")[0]) {
    fail(where, sel, ["the header does not show the element's name"]);
  }
}

const cfgOf = (file) => (entries.find((e) => FILES[e.cfg.type] === file) || {}).cfg || {};
hoverSurvivesUpdate("powmr-inverter-console-card.js", cfgOf("powmr-inverter-console-card.js"),
  FIXTURES["powmr-inverter-console-card.js"](), ".tile.t-load",
  { "sensor.powmr_inverter_ac_output_power": S("1234") });
hoverSurvivesUpdate("load-shedding-card.js", cfgOf("load-shedding-card.js"),
  FIXTURES["load-shedding-card.js"](), ".tile",
  { "sensor.jkbms_gateway_bms_state_of_charge": S("47") });

if (failures.length) {
  console.log("test_card_tooltips: " + failures.length + " problem(s) in " + checked + " checks");
  failures.forEach((f) => console.log("  FAIL " + f));
  process.exit(1);
}
console.log("test_card_tooltips: ok — " + checked + " tooltips checked");
