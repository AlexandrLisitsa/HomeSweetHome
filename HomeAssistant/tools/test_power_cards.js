/**
 * Render and logic tests for the three power cards on the Power station and
 * Shutdowns dashboards:
 *
 *     config/www/powmr-inverter-console-card.js   (Inverter tab)
 *     config/www/jkbms-battery-console-card.js    (Battery tab)
 *     config/www/load-shedding-card.js            (Load shedding tab)
 *
 *     node HomeAssistant/tools/test_power_cards.js
 *
 * WHY A DOM AND NOT ONLY THE PURE METHODS
 *
 * test_climate_chart.js and test_console_history.js call pure methods on a
 * bare prototype, which is right for chart maths. These cards go wrong
 * somewhere else: in which class lands on which chip, which sub-label a plan
 * state prints, which service a tap calls, and what a card full of
 * `unavailable` draws. That lives in _build/_patch and the click handlers, so
 * this file carries a small DOM -- an HTML parser good enough for the cards'
 * own templates, classList, style, dataset, querySelector, and event bubbling
 * through a shadow root -- and drives the real setConfig / `set hass` /
 * click / change paths. The card files are loaded as-is, no build step, and
 * nothing here talks to Home Assistant: `hass` is a fake that records calls.
 *
 * KNOWN-BUG checks assert the intended behaviour of something the card gets
 * wrong today. They are printed but do not fail the run; when one starts
 * passing, the card was fixed and the check can move into the main groups.
 *
 * Exit status is 0 when every regular case passes, 1 otherwise.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const WWW = path.join(__dirname, "..", "config", "www");

/* ========================================================================== */
/* A small DOM                                                                */
/* ========================================================================== */

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr"]);
const RAW = new Set(["style", "script", "textarea"]);

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === "#") {
      return String.fromCodePoint(k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    }
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" }[k];
  });
}

function escText(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

class Node0 {
  constructor(type) {
    this.nodeType = type;
    this.parentNode = null;
    this.childNodes = [];
    this._listeners = {};
  }
  appendChild(n) {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstElementChild() { return this.children[0] || null; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v) {
    this.childNodes.forEach((c) => { c.parentNode = null; });
    this.childNodes = [];
    const s = v === null || v === undefined ? "" : String(v);
    if (s) this.appendChild(new TextNode(s));
  }
  get innerHTML() { return this.childNodes.map(serialize).join(""); }
  set innerHTML(html) {
    this.childNodes.forEach((c) => { c.parentNode = null; });
    this.childNodes = [];
    if (this._selIdx !== undefined) delete this._selIdx;
    parseHTML(String(html), this);
  }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn) {
    const l = this._listeners[type] || [];
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  /** Every element under this node, in document order. */
  _all() {
    const out = [];
    const walk = (n) => n.childNodes.forEach((c) => {
      if (c.nodeType === 1) { out.push(c); walk(c); }
    });
    walk(this);
    return out;
  }
  querySelectorAll(sel) {
    const groups = parseSelector(sel);
    return this._all().filter((el) => groups.some((g) => matchComplex(el, g)));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

class TextNode extends Node0 {
  constructor(data) { super(3); this.data = data; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

function makeClassList(el) {
  const get = () => (el.getAttribute("class") || "").split(/\s+/).filter(Boolean);
  const put = (arr) => el.setAttribute("class", arr.join(" "));
  return {
    contains: (c) => get().indexOf(c) >= 0,
    add: (...cs) => { const a = get(); cs.forEach((c) => { if (a.indexOf(c) < 0) a.push(c); }); put(a); },
    remove: (...cs) => put(get().filter((c) => cs.indexOf(c) < 0)),
    toggle: (c, force) => {
      const has = get().indexOf(c) >= 0;
      const want = force === undefined ? !has : !!force;
      if (want && !has) put(get().concat([c]));
      if (!want && has) put(get().filter((x) => x !== c));
      return want;
    },
    get length() { return get().length; },
    toString: () => get().join(" "),
  };
}

function makeStyle() {
  const props = {};
  const style = {
    setProperty: (k, v) => { props[k] = String(v); },
    getPropertyValue: (k) => {
      if (k in props) return props[k];
      const camel = k.replace(/-([a-z])/g, (_m, ch) => ch.toUpperCase());
      return style[camel] !== undefined && typeof style[camel] !== "function" ? String(style[camel]) : "";
    },
    removeProperty: (k) => { delete props[k]; },
    _props: props,
  };
  return style;
}

function datasetProxy(el) {
  const attr = (k) => "data-" + String(k).replace(/[A-Z]/g, (ch) => "-" + ch.toLowerCase());
  return new Proxy({}, {
    get: (_t, k) => (typeof k === "string" && el.hasAttribute(attr(k)) ? el.getAttribute(attr(k)) : undefined),
    set: (_t, k, v) => { el.setAttribute(attr(k), v); return true; },
    has: (_t, k) => el.hasAttribute(attr(k)),
    deleteProperty: (_t, k) => { el.removeAttribute(attr(k)); return true; },
  });
}

class Element extends Node0 {
  constructor(tag) {
    super(1);
    this.localName = String(tag || "div").toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this._attrs = new Map();
    this.classList = makeClassList(this);
    this.style = makeStyle();
    this.dataset = datasetProxy(this);
  }
  getAttribute(n) { return this._attrs.has(n) ? this._attrs.get(n) : null; }
  hasAttribute(n) { return this._attrs.has(n); }
  removeAttribute(n) { this._attrs.delete(n); }
  setAttribute(n, v) {
    this._attrs.set(n, String(v));
    if (n === "style") {
      String(v).split(";").forEach((decl) => {
        const i = decl.indexOf(":");
        if (i > 0) this.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
      });
    }
  }
  get id() { return this.getAttribute("id") || ""; }
  get className() { return this.getAttribute("class") || ""; }
  get title() { return this.getAttribute("title") || ""; }
  set title(v) { this.setAttribute("title", v); }
  get hidden() { return this.hasAttribute("hidden"); }
  set hidden(v) { if (v) this.setAttribute("hidden", ""); else this.removeAttribute("hidden"); }
  get disabled() { return this.hasAttribute("disabled"); }
  set disabled(v) { if (v) this.setAttribute("disabled", ""); else this.removeAttribute("disabled"); }
  get checked() { return this._checked !== undefined ? this._checked : this.hasAttribute("checked"); }
  set checked(v) { this._checked = !!v; }
  get options() { return this.querySelectorAll("option"); }
  get value() {
    if (this.localName === "select") {
      const opts = this.options;
      if (this._selIdx !== undefined) return this._selIdx >= 0 && opts[this._selIdx] ? opts[this._selIdx].value : "";
      const sel = opts.find((o) => o.hasAttribute("selected")) || opts[0];
      return sel ? sel.value : "";
    }
    if (this.localName === "option") {
      return this.hasAttribute("value") ? this.getAttribute("value") : this.textContent.replace(/\s+/g, " ").trim();
    }
    if (this._value !== undefined) return this._value;
    if (this.localName === "textarea") return this.textContent;
    return this.getAttribute("value") || "";
  }
  set value(v) {
    if (this.localName === "select") {
      this._selIdx = this.options.findIndex((o) => o.value === String(v));
      return;
    }
    this._value = String(v);
  }
  click() { this._clicked = (this._clicked || 0) + 1; }
}

class ShadowRoot0 extends Node0 {
  constructor(host) { super(11); this.host = host; this.activeElement = null; }
}

class HostElement extends Element {
  constructor() { super("host-element"); this.shadowRoot = null; this.dispatched = []; }
  attachShadow() { this.shadowRoot = new ShadowRoot0(this); return this.shadowRoot; }
  dispatchEvent(ev) {
    this.dispatched.push(ev);
    (this._listeners[ev.type] || []).forEach((fn) => fn(ev));
    return true;
  }
}

function serialize(n) {
  if (n.nodeType === 3) return escText(n.data);
  const attrs = Array.from(n._attrs.entries())
    .map(([k, v]) => " " + k + '="' + String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;") + '"').join("");
  if (VOID.has(n.localName)) return "<" + n.localName + attrs + ">";
  return "<" + n.localName + attrs + ">" + n.childNodes.map(serialize).join("") + "</" + n.localName + ">";
}

/** Enough HTML for the cards' own templates: tags, quoted attributes, raw text, implied </option>. */
function parseHTML(html, parent) {
  const stack = [parent];
  const top = () => stack[stack.length - 1];
  const len = html.length;
  let i = 0;
  while (i < len) {
    if (html[i] === "<" && html.startsWith("<!--", i)) {
      const e = html.indexOf("-->", i);
      i = e < 0 ? len : e + 3;
      continue;
    }
    if (html[i] === "<" && html[i + 1] === "/") {
      const e = html.indexOf(">", i);
      const name = html.slice(i + 2, e).trim().toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].localName === name) { stack.length = k; break; }
      }
      i = e + 1;
      continue;
    }
    if (html[i] === "<" && /[a-zA-Z]/.test(html[i + 1] || "")) {
      let j = i + 1;
      while (j < len && !/[\s/>]/.test(html[j])) j++;
      const name = html.slice(i + 1, j).toLowerCase();
      const el = new Element(name);
      let selfClose = false;
      for (;;) {
        while (j < len && /\s/.test(html[j])) j++;
        if (j >= len) break;
        if (html[j] === ">") { j++; break; }
        if (html[j] === "/" && html[j + 1] === ">") { selfClose = true; j += 2; break; }
        if (html[j] === "/") { j++; continue; }
        let k = j;
        while (k < len && !/[\s=/>]/.test(html[k])) k++;
        const an = html.slice(j, k);
        j = k;
        while (j < len && /\s/.test(html[j])) j++;
        let av = "";
        if (html[j] === "=") {
          j++;
          while (j < len && /\s/.test(html[j])) j++;
          const q = html[j];
          if (q === '"' || q === "'") {
            const e = html.indexOf(q, j + 1);
            av = html.slice(j + 1, e);
            j = e + 1;
          } else {
            let e = j;
            while (e < len && !/[\s>]/.test(html[e])) e++;
            av = html.slice(j, e);
            j = e;
          }
        }
        if (an) el.setAttribute(an, decode(av));
      }
      if (name === "option" && top().localName === "option") stack.pop();
      top().appendChild(el);
      if (RAW.has(name) && !selfClose) {
        const close = html.toLowerCase().indexOf("</" + name, j);
        const end = close < 0 ? len : close;
        const raw = html.slice(j, end);
        if (raw) el.appendChild(new TextNode(name === "textarea" ? decode(raw) : raw));
        i = close < 0 ? len : html.indexOf(">", close) + 1;
        continue;
      }
      if (!VOID.has(name) && !selfClose) stack.push(el);
      i = j;
      continue;
    }
    let e = html.indexOf("<", i + 1);
    if (e < 0) e = len;
    top().appendChild(new TextNode(decode(html.slice(i, e))));
    i = e;
  }
}

/* --- selectors: tag, .class, #id, [attr], [attr="v"], descendant, comma ---- */

function parseCompound(s) {
  const out = { tag: null, classes: [], id: null, attrs: [] };
  const re = /^([a-zA-Z][\w-]*|\*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g;
  let m;
  let pos = 0;
  while ((m = re.exec(s)) && m.index === pos) {
    pos = re.lastIndex;
    if (m[1]) out.tag = m[1] === "*" ? null : m[1].toLowerCase();
    else if (m[2]) out.classes.push(m[2]);
    else if (m[3]) out.id = m[3];
    else if (m[4]) out.attrs.push([m[4], m[5] !== undefined ? m[5] : m[6] !== undefined ? m[6] : m[7]]);
    if (pos >= s.length) break;
  }
  if (pos !== s.length) throw new Error("test DOM: unsupported selector part " + JSON.stringify(s));
  return out;
}

function parseSelector(sel) {
  return sel.split(",").map((g) => {
    const parts = [];
    let cur = "";
    let q = null;
    let br = 0;
    for (const ch of g.trim()) {
      if (q) { cur += ch; if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === "[") br++;
      if (ch === "]") br--;
      if (/\s/.test(ch) && !br) { if (cur) parts.push(cur); cur = ""; continue; }
      cur += ch;
    }
    if (cur) parts.push(cur);
    return parts.map(parseCompound);
  });
}

function matchCompound(el, c) {
  if (!el || el.nodeType !== 1) return false;
  if (c.tag && el.localName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  if (c.classes.some((k) => !el.classList.contains(k))) return false;
  return c.attrs.every(([n, v]) => el.hasAttribute(n) && (v === undefined || el.getAttribute(n) === v));
}

function matchComplex(el, parts) {
  if (!matchCompound(el, parts[parts.length - 1])) return false;
  let node = el.parentNode;
  for (let i = parts.length - 2; i >= 0; i--) {
    while (node && !matchCompound(node, parts[i])) node = node.parentNode;
    if (!node) return false;
    node = node.parentNode;
  }
  return true;
}

/* --- events --------------------------------------------------------------- */

class CustomEvent0 {
  constructor(type, init) {
    init = init || {};
    this.type = type;
    this.detail = init.detail;
    this.bubbles = !!init.bubbles;
    this.composed = !!init.composed;
  }
}
class Event0 extends CustomEvent0 {}

/**
 * Fire an event at `node` and bubble it out through the shadow root to the
 * host, as a composed UI event does. Returns the event, with `stopped` and
 * `defaultPrevented` readable.
 */
function fire(node, type, extra) {
  const pathArr = [];
  let n = node;
  while (n) {
    pathArr.push(n);
    n = n.nodeType === 11 ? n.host : n.parentNode;
  }
  const ev = Object.assign({
    type: type,
    target: node,
    stopped: false,
    defaultPrevented: false,
    composedPath: () => pathArr.slice(),
    stopPropagation() { this.stopped = true; },
    preventDefault() { this.defaultPrevented = true; },
  }, extra || {});
  for (const p of pathArr) {
    ev.currentTarget = p;
    (p._listeners[type] || []).slice().forEach((fn) => fn(ev));
    if (ev.stopped) break;
  }
  return ev;
}

/* ========================================================================== */
/* Loading a card                                                             */
/* ========================================================================== */

function loadCard(file) {
  let Klass = null;
  const timers = [];
  const clipboard = [];
  const created = [];
  const sandbox = {
    HTMLElement: HostElement,
    CustomEvent: CustomEvent0,
    Event: Event0,
    customElements: { get: () => undefined, define: (_n, k) => { Klass = k; } },
    window: {
      customCards: [],
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
    },
    document: {
      head: null,
      getElementById: () => null,
      createElement: (t) => { const e = new Element(t); created.push(e); return e; },
    },
    navigator: { clipboard: { writeText: (t) => { clipboard.push(t); return Promise.resolve(); } } },
    Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; } },
    URL: { createObjectURL: () => "blob:test", revokeObjectURL: () => {} },
    console: { info: () => {} },
    Math: Math, Date: Date, Number: Number, JSON: JSON,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(WWW, file), "utf8"), sandbox, { filename: file });
  if (!Klass) throw new Error(file + " did not define a custom element");
  return {
    Card: Klass,
    sandbox: sandbox,
    timers: timers,
    clipboard: clipboard,
    created: created,
    flushTimers: () => { while (timers.length) timers.shift()(); },
  };
}

/** A fake hass: states map, a service-call recorder, and a websocket stub. */
function mkHass(states, opts) {
  opts = opts || {};
  const calls = [];
  const raw = [];
  const ws = [];
  return {
    states: states,
    calls: calls,
    raw: raw,
    ws: ws,
    services: opts.services || {},
    localize: opts.localize,
    callService: function (domain, service, data) {
      calls.push([domain, service, data]);
      raw.push(Array.from(arguments));
      return opts.svc ? opts.svc(domain, service, data, arguments) : Promise.resolve();
    },
    callWS: async (msg) => {
      ws.push(msg);
      return opts.callWS ? opts.callWS(msg) : {};
    },
  };
}

/** A state object; `id` fills entity_id, which the load-shedding picker needs. */
function S(state, attributes, extra) {
  return Object.assign({ state: String(state), attributes: attributes || {},
    last_changed: new Date().toISOString(), last_updated: new Date().toISOString() }, extra || {});
}

function withIds(states) {
  Object.keys(states).forEach((k) => { if (states[k]) states[k].entity_id = k; });
  return states;
}

const flush = () => new Promise((r) => setImmediate(r));

/** HH:MM as the cards print it, in whatever locale this machine runs. */
function hm(iso) {
  return new Date(Date.parse(iso)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** An ISO stamp for a local wall-clock time today. */
function localIso(h, m) {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

/* ========================================================================== */
/* Runner                                                                     */
/* ========================================================================== */

let pass = 0;
const failures = [];
const known = [];
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
  try {
    fn();
  } catch (e) {
    check(name, !re || re.test(e.message), "threw " + JSON.stringify(e.message));
    return;
  }
  check(name, false, "did not throw");
}

function noThrow(name, fn) {
  try { fn(); check(name, true); } catch (e) { check(name, false, "threw " + (e && e.stack)); }
}

/*
 * A card's promise that rejects with nobody listening is a console error in
 * the browser and would kill this process, so collect them. A test that
 * expects one takes it with takeUnhandled(); any left at the end fail the run.
 */
let unhandled = [];
process.on("unhandledRejection", (e) => { unhandled.push(e); });
function takeUnhandled() { const u = unhandled; unhandled = []; return u; }

/** Intended behaviour the card does not have yet. Printed, never fatal. */
function knownBug(name, cond, detail, where) {
  known.push({ name: name, fixed: !!cond, detail: detail, where: where });
}

const OK_C = "#589569", WARN_C = "#AE8446", BAD_C = "#BB635B";

/* ========================================================================== */
/* 1. powmr-inverter-console-card.js                                          */
/* ========================================================================== */

async function inverterSuite() {
  const L = loadCard("powmr-inverter-console-card.js");
  const Card = L.Card;

  const E = {
    gv: "sensor.powmr_inverter_grid_voltage",
    gf: "sensor.powmr_inverter_grid_frequency",
    gp: "sensor.powmr_inverter_grid_real_power_calculated",
    safe: "binary_sensor.powmr_inverter_grid_condition_safe",
    rng: "binary_sensor.powmr_inverter_grid_voltage_in_range",
    acv: "sensor.powmr_inverter_ac_output_voltage",
    lw: "sensor.powmr_inverter_ac_output_power",
    lp: "sensor.powmr_inverter_load_percentage",
    up: "sensor.powmr_inverter_total_uptime",
    bw: "sensor.jkbms_gateway_bms_power",
    soc: "sensor.jkbms_gateway_bms_state_of_charge",
    bv: "sensor.powmr_inverter_battery_voltage_inverter",
    cc: "sensor.powmr_inverter_battery_charge_current",
    dc: "sensor.powmr_inverter_battery_discharge_current",
    td: "sensor.electricity_meter_tariff_day",
    tn: "sensor.electricity_meter_tariff_night",
    tdc: "sensor.electricity_meter_tariff_day_cost",
    tnc: "sensor.electricity_meter_tariff_night_cost",
    tot: "sensor.electricity_meter_energy",
    mw: "sensor.electricity_meter_power",
    maxc: "select.powmr_inverter_max_ac_charge_current",
    prio: "select.powmr_inverter_power_priority",
    mode: "select.powmr_inverter_inverter_ac_input_mode",
    tariff: "select.electricity_meter_tariff",
    pplan: "sensor.outage_pre_charge_plan",
    ad: "input_boolean.adaptive_night_charge",
    aplan: "sensor.adaptive_charge_plan",
    auto: "switch.powmr_inverter_auto_tariff_mode",
    prot: "switch.powmr_inverter_auto_grid_protection",
    acc: "switch.powmr_inverter_ac_charging_enabled",
    night: "switch.powmr_inverter_night_charging_only",
    pre: "switch.powmr_inverter_outage_pre_charge",
  };

  /** A healthy house: grid up, pack idle at 80 %, everything reporting. */
  function base() {
    return {
      [E.gv]: S("230.0"), [E.gf]: S("50.00"), [E.gp]: S("300"),
      [E.safe]: S("off"), [E.rng]: S("on"),
      [E.acv]: S("230.0"), [E.lw]: S("500"), [E.lp]: S("21"), [E.up]: S("3.5"),
      [E.bw]: S("0"), [E.soc]: S("80"), [E.bv]: S("26.8"), [E.cc]: S("0"), [E.dc]: S("0"),
      [E.td]: S("123.456"), [E.tn]: S("78.9"), [E.tot]: S("202.3457"),
      [E.maxc]: S("30", { options: ["2", "10", "20", "30", "40", "50", "60"] }),
      [E.prio]: S("Utility first", { options: ["Utility first", "Solar first", "SBU"] }),
      [E.mode]: S("UPS", { options: ["APL", "UPS"] }),
      [E.tariff]: S("day", { options: ["day", "night"] }),
      [E.pplan]: S("idle", { reason: "" }),
      [E.ad]: S("off"), [E.aplan]: S("off", { reason: "switched off" }),
      [E.auto]: S("on", { friendly_name: "Auto tariff mode" }),
      [E.prot]: S("on", { friendly_name: "Auto grid protection" }),
      [E.acc]: S("on", { friendly_name: "AC charging" }),
      [E.night]: S("off", { friendly_name: "Night charging only" }),
      [E.pre]: S("off", { friendly_name: "Outage pre-charge" }),
    };
  }

  function mk(states, config, hassOpts) {
    const c = new Card();
    c.setConfig(config || {});
    const h = mkHass(states, hassOpts);
    c.hass = h;
    return { c: c, h: h, el: c._el, set: (st) => { h.states = st; c.hass = Object.assign({}, h, { states: st }); } };
  }

  /** A tooltip's first line: name, state and the plan's reason; the help follows. */
  const head = (t) => String(t).split("\n")[0];

  /** Re-render with a modified copy of the states. */
  function rerender(r, mutate) {
    const st = Object.assign({}, r.h.states);
    mutate(st);
    r.h.states = st;
    const h2 = Object.assign(Object.create(Object.getPrototypeOf(r.h)), r.h, { states: st });
    r.c.hass = h2;
    return h2;
  }

  /* --- config ------------------------------------------------------------- */
  group = "inverter/config: ";
  {
    const c = new Card();
    eq("card size before config", c.getCardSize(), 29);
    c.setConfig({});
    eq("card size, all blocks", c.getCardSize(), 29);
    c.setConfig({ blocks: ["header"] });
    eq("card size, header only", c.getCardSize(), 3);
    c.setConfig({ blocks: ["controls"] });
    eq("card size, controls only is 0", c.getCardSize(), 0);
    eq("stub config", Card.getStubConfig(), {});
    eq("grid options", c.getGridOptions(), { columns: "full", rows: "auto", min_columns: 6 });
    noThrow("null config is the defaults", () => c.setConfig(null));
    throws("empty blocks", () => c.setConfig({ blocks: [] }), /non-empty list/);
    throws("blocks not a list", () => c.setConfig({ blocks: "header" }), /non-empty list/);
    throws("unknown block", () => c.setConfig({ blocks: ["header", "pv"] }), /unknown block\(s\) pv/);
    throws("max_grid_w 0", () => c.setConfig({ max_grid_w: 0 }), /max_grid_w must be a positive/);
    throws("max_load_w negative", () => c.setConfig({ max_load_w: -5 }), /max_load_w/);
    throws("max_batt_w not a number", () => c.setConfig({ max_batt_w: "abc" }), /max_batt_w/);
    throws("max_batt_w null", () => c.setConfig({ max_batt_w: null }), /max_batt_w/);
    c.setConfig({ max_grid_w: "1200" });
    eq("numeric string ceiling is coerced", c._config.max_grid_w, 1200);
    throws("entity typo without a dot", () => c.setConfig({ grid_voltage: "gridvoltage" }), /grid_voltage must be an entity id/);
    throws("entity starting with a dot", () => c.setConfig({ grid_safe: ".x" }), /grid_safe/);
    throws("chip entity not a string", () => c.setConfig({ chip_auto: 42 }), /chip_auto must be an entity id/);
    throws("adaptive entity empty", () => c.setConfig({ adaptive_charge: "" }), /adaptive_charge/);
    noThrow("non-entity strings are free text", () => c.setConfig({ title: "x", device_label: "" }));
  }

  /* --- pure derivations ---------------------------------------------------- */
  group = "inverter/bands: ";
  {
    const c = new Card();
    c.setConfig({});
    const vl = [[null, "NO DATA"], [199.9, "UNDERVOLTAGE"], [200, "LOW"], [220, "LOW"], [220.1, "NOMINAL"],
      [239.9, "NOMINAL"], [240, "HIGH"], [250, "HIGH"], [250.1, "OVERVOLTAGE"], [0, "UNDERVOLTAGE"]];
    vl.forEach(([v, w]) => eq("_vLabel(" + v + ")", c._vLabel(v), w));
    const vc = [[null, "#5C616B"], [199.9, BAD_C], [200, WARN_C], [220, WARN_C], [230, OK_C], [240, WARN_C],
      [250, WARN_C], [250.1, BAD_C]];
    vc.forEach(([v, w]) => eq("_vColor(" + v + ")", c._vColor(v), w));
    const ll = [[null, "NO DATA"], [0, "NORMAL"], [60, "NORMAL"], [60.1, "ELEVATED"], [85, "ELEVATED"],
      [85.1, "HEAVY"], [100, "HEAVY"], [100.1, "OVERLOAD"]];
    ll.forEach(([v, w]) => eq("_loadLabel(" + v + ")", c._loadLabel(v), w));
    eq("_loadColor(60)", c._loadColor(60), OK_C);
    eq("_loadColor(61)", c._loadColor(61), WARN_C);
    eq("_loadColor(86)", c._loadColor(86), BAD_C);
    const sl = [[null, "NO DATA"], [0, "CRITICAL"], [19.9, "CRITICAL"], [20, "MODERATE"], [69.9, "MODERATE"],
      [70, "HEALTHY"], [94.9, "HEALTHY"], [95, "FULL"], [100, "FULL"], [-3, "CRITICAL"]];
    sl.forEach(([v, w]) => eq("_socLabel(" + v + ")", c._socLabel(v), w));
    eq("_socColor(19)", c._socColor(19), BAD_C);
    eq("_socColor(20)", c._socColor(20), WARN_C);
    eq("_socColor(70)", c._socColor(70), OK_C);
    eq("_pct null is 0", c._pct(null, 190, 70), 0);
    eq("_pct clamps low", c._pct(100, 190, 70), 0);
    eq("_pct clamps high", c._pct(400, 190, 70), 100);
    eq("_fmt null", c._fmt(null, 1), "—");
    eq("_fmt undefined", c._fmt(undefined, 1), "—");
    eq("_fmt 0", c._fmt(0, 2), "0.00");
    eq("_esc", c._esc('<a href="x">&</a>'), "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
    eq("_esc null", c._esc(null), "");

    // _uptime truncates whole hours rather than rounding into the next day.
    c._hass = mkHass({ [E.up]: S("14.9999") });
    eq("_uptime truncates", c._uptime(), "up 14d 23h");
    c._hass = mkHass({ [E.up]: S("0") });
    eq("_uptime zero", c._uptime(), "up 0d 0h");
    c._hass = mkHass({ [E.up]: S("unavailable") });
    eq("_uptime unavailable", c._uptime(), "—");
    c._hass = mkHass({});
    eq("_uptime missing", c._uptime(), "—");

    // _num: what counts as a number.
    const nums = [["230.5", 230.5], ["unknown", null], ["unavailable", null], ["", null], ["NaN", null],
      ["Infinity", null], ["-12", -12], ["1e3", 1000], [" 7 ", 7], ["12abc", 12]];
    nums.forEach(([s, w]) => {
      c._hass = mkHass({ "sensor.x": S(s) });
      eq("_num(" + JSON.stringify(s) + ")", c._num("sensor.x"), w);
    });
    c._hass = mkHass({ "sensor.x": { state: null } });
    eq("_num of a null state", c._num("sensor.x"), null);
    c._hass = { };
    eq("_state with no states map", c._state("sensor.x"), "unknown");
    eq("_opts with no options attr", c._opts("sensor.x"), []);
    c._hass = mkHass({ "select.x": S("a", { options: "a,b" }) });
    eq("_opts ignores a non-list", c._opts("select.x"), []);
  }

  group = "inverter/flow: ";
  {
    const c = new Card();
    c.setConfig({});
    const el = new Element("i");
    c._setFlow(el, null, 2400, true);
    eq("null watts is idle", [el.style._props["--dur"], el.style._props["--op"], el.style._props["--play"], el.style._props["--dir"]],
      ["2.40s", ".18", "paused", "normal"]);
    c._setFlow(el, 4.9, 2400, false);
    eq("4.9 W still idle", el.style._props["--play"], "paused");
    c._setFlow(el, 5, 2400, false);
    eq("5 W runs", [el.style._props["--play"], el.style._props["--op"]], ["running", ".85"]);
    c._setFlow(el, 2400, 2400, false);
    eq("full scale is 0.30 s", el.style._props["--dur"], "0.30s");
    c._setFlow(el, 9999, 2400, false);
    eq("over scale clamps", el.style._props["--dur"], "0.30s");
    c._setFlow(el, -800, 1600, true);
    eq("negative signed runs reverse", el.style._props["--dir"], "reverse");
    eq("negative magnitude sets the speed", el.style._props["--dur"], (2.4 - 2.1 * Math.pow(0.5, 0.55)).toFixed(2) + "s");
    const el2 = new Element("i");
    c._setFlow(el2, -800, 1600, false);
    eq("unsigned leg never sets a direction", el2.style._props["--dir"], undefined);
    noThrow("missing element is ignored", () => c._setFlow(null, 5, 10, true));
  }

  /* --- a healthy render ---------------------------------------------------- */
  group = "inverter/render: ";
  {
    const r = mk(base());
    const el = r.el;
    check("built", r.c._built === true);
    ["uptime", "livedot", "mode", "ret", "retsep", "clock", "chip0", "chip2", "chipNt2", "chipAd2", "chipPc2",
      "chipAdSub2", "chipPcSub2",
      "gridVal", "invVal", "loadVal", "socVal", "maxChg", "prio", "acMode", "erow0", "chLine", "stats"]
      .forEach((k) => check("has data-ref " + k, !!el[k]));
    check("three chips: Night only and Pre-charge are not chips any more", !el.chip3 && !el.chip4);
    check("only AC charge carries the extra icons",
      ["Nt", "Ad", "Pc"].every((k) => !el["chip" + k + "0"] && !el["chip" + k + "1"] && !!el["chip" + k + "2"]));
    const icons = el.chip2.querySelectorAll(".dw.i ha-icon").map((n) => n.getAttribute("icon"));
    eq("AC charge's feature toggles are icons, in order", icons,
      ["mdi:weather-night", "mdi:tune-variant", "mdi:battery-clock"]);
    check("AC charge has no dot or icon of its own after the label: the left icon is the switch",
      el.chip2.querySelector(".dw .dot") === null && el.chip2.classList.contains("nodot"));
    check("Auto and Protect keep their plain dot", !!el.chip0.querySelector(".dw .dot") && !el.chip0.querySelector(".dw.i"));
    eq("Night only lights blue", el.chipNt2.style._props["--dc"], "#6EA8FE");
    eq("adaptive and Pre-charge light amber",
      [el.chipAd2.style._props["--dc"], el.chipPc2.style._props["--dc"]], ["#AE8446", "#AE8446"]);
    eq("uptime", el.uptime.textContent, "up 3d 12h");
    eq("mode word", el.mode.textContent, "Grid connected · UPS");
    eq("live dot green", el.livedot.style.background, OK_C);
    check("countdown hidden", el.ret.hidden && el.retsep.hidden);
    check("clock ticked on build", /^\d\d:\d\d:\d\d$/.test(el.clock.textContent), el.clock.textContent);
    eq("grid value", el.gridVal.textContent, "230.0V");
    eq("grid value keeps its unit element", el.gridVal.innerHTML, "230.0<i>V</i>");
    eq("grid state", el.gridState.textContent, "NOMINAL");
    eq("grid colour", el.gridVal.style.color, OK_C);
    eq("grid sub", el.gridSub.textContent, "50.00 Hz · 300 W in");
    eq("grid mark", el.gridMark.style.left, "57.14%");
    eq("inverter sub", el.invSub.textContent, "UPS · Utility first");
    eq("load value", el.loadVal.textContent, "500W");
    eq("load state", el.loadState.textContent, "NORMAL");
    eq("load sub", el.loadSub.textContent, "21.0 % of 2400 W");
    eq("load mark", el.loadMark.style.left, "21.00%");
    eq("soc value", el.socVal.textContent, "80%");
    eq("soc fill", el.socFill.style.width, "80%");
    eq("soc fill colour", el.socFill.style._props["--fc"], OK_C);
    eq("battery state idle", el.battState.textContent, "IDLE · HEALTHY");
    eq("battery sub idle", el.battSub.textContent, "26.8 V · 0 W idle");
    eq("battery sub links to voltage when no current", el.battSub.getAttribute("data-more"), E.bv);
    eq("flow grid running", el.runGrid.style._props["--play"], "running");
    eq("flow battery idle", el.runBatt.style._props["--play"], "paused");
    eq("title escaped default", r.c.shadowRoot.querySelector(".title").textContent, "Power Station");
    // The CSS gates the pulse on BOTH classes; the patch only sets `live`.
    const css = r.c.shadowRoot.querySelector("style").textContent;
    check("pulse needs .on AND .live", css.indexOf(".chip.on.live {") >= 0);
    check("dimmed adaptive icon is styled", css.indexOf(".chip .dw.i.dis {") >= 0);
    check("a lit icon takes its own colour", css.indexOf(".chip .dw.i.on ha-icon { color: var(--dc);") >= 0);
    check("the chip's main icon pulses when it has no dot", css.indexOf(".chip.on.live.nodot .ic ha-icon { animation: pmpulse") >= 0);
    check("...and stops under reduced motion", css.indexOf(".chip.on.live.nodot .ic ha-icon, .chip .dw.i.on.act ha-icon { animation-play-state: paused; }") >= 0);
  }

  group = "inverter/escaping: ";
  {
    const r = mk(base(), { title: "<b>Power</b>", device_label: 'A & "B"' });
    const t = r.c.shadowRoot.querySelector(".title");
    eq("title is text, not markup", t.textContent, "<b>Power</b>");
    check("no element injected", !t.querySelector("b"));
    eq("device label text", r.c.shadowRoot.querySelector(".kicker span").textContent, 'A & "B"');
  }

  /* --- chips ---------------------------------------------------------------- */
  group = "inverter/chips: ";
  {
    const st = base();
    st[E.night] = S("unavailable", { friendly_name: "Night charging only" });
    delete st[E.pre];
    const r = mk(st);
    const el = r.el;
    eq("Auto on", el.chip0.classList.contains("on"), true);
    eq("Protect on", el.chip1.classList.contains("on"), true);
    eq("AC charge on", el.chip2.classList.contains("on"), true);
    eq("Night only unavailable is off", el.chipNt2.classList.contains("on"), false);
    eq("Pre-charge missing is off", el.chipPc2.classList.contains("on"), false);
    eq("title from friendly_name", head(el.chip0.title), "Auto tariff mode — on");
    eq("icon title for unavailable", head(el.chipNt2.title), "Night charging only — unavailable");
    eq("icon title for a missing entity is the label", head(el.chipPc2.title), "Pre-charge — unknown");
    rerender(r, (s) => { s[E.night] = S("on", { friendly_name: "Night charging only" }); });
    check("Night only on lights its icon, not the chip's own", el.chipNt2.classList.contains("on"));
    rerender(r, (s) => { s[E.acc] = S("off", { friendly_name: "AC charging" }); });
    check("charger off, Night only on: chip off, Night icon still lit",
      !el.chip2.classList.contains("on") && el.chipNt2.classList.contains("on"));
    rerender(r, (s) => { s[E.acc] = S("on", { friendly_name: "AC charging" }); s[E.night] = S("unavailable", { friendly_name: "Night charging only" }); });
    // The print reads states, not attributes: a friendly_name change alone
    // waits for the next state change, which is fine for a name.
    rerender(r, (s) => { s[E.prot] = S("on", {}); });
    eq("attribute-only change does not re-patch", head(el.chip1.title), "Auto grid protection — on");
    rerender(r, (s) => { s[E.prot] = S("off", {}); });
    eq("title without friendly_name falls back to label", head(el.chip1.title), "Protect — off");
    check("no chip is live while the pack idles", [0, 1, 2].every((i) => !el["chip" + i].classList.contains("live")));
    // Every toggle's tooltip says what it does, with an example, after the state line.
    const tips = { chip0: "SBU Battery", chip1: "185–250 V", chip2: "BMS charge switch",
      chipNt2: "night tariff", chipAd2: "lowest current", chipPc2: "DTEK outage" };
    Object.keys(tips).forEach((k) => {
      const t = el[k].title.split("\n");
      check(k + ": a description after the state line", t.length >= 3 && t[1].indexOf(tips[k]) >= 0, el[k].title);
      check(k + ": with an example", t.some((l) => l.indexOf("E.g.") === 0), el[k].title);
    });
    check("the chip's own icon and dot inherit its description (no title of their own)",
      el.chip2.querySelector(".ic").getAttribute("title") === null
      && el.chip0.querySelector(".dw").getAttribute("title") === null);
    rerender(r, (s) => { s[E.ad] = S("on"); });
    eq("a re-patch does not stack descriptions", el.chipAd2.title.split("E.g.").length, 2);
  }

  group = "inverter/live: ";
  {
    const cases = [
      ["charging on grid", { [E.bw]: "2.1" }, true],
      ["exactly 2 W is not charging", { [E.bw]: "2" }, false],
      ["discharging", { [E.bw]: "-500" }, false],
      ["battery power unavailable", { [E.bw]: "unavailable" }, false],
      ["grid unsafe (safe=on)", { [E.bw]: "800", [E.safe]: "on" }, false],
      ["grid at 149.9 V", { [E.bw]: "800", [E.gv]: "149.9" }, false],
      ["grid at exactly 150 V is up", { [E.bw]: "800", [E.gv]: "150" }, true],
      ["voltage unknown, safe off: up", { [E.bw]: "800", [E.gv]: "unknown" }, true],
      ["safe sensor unavailable, voltage fine", { [E.bw]: "800", [E.safe]: "unavailable" }, true],
    ];
    cases.forEach(([name, over, want]) => {
      const st = base();
      Object.keys(over).forEach((k) => { st[k] = S(over[k]); });
      const r = mk(st);
      eq(name + ": AC charge live", r.el.chip2.classList.contains("live"), want);
      check(name + ": no other chip ever live",
        [0, 1].every((i) => !r.el["chip" + i].classList.contains("live")));
    });
    // `live` follows the charging, the switch only decides whether CSS shows it.
    const st = base();
    st[E.bw] = S("900");
    st[E.acc] = S("off");
    const r = mk(st);
    check("charger switch off: live set, .on not, so no pulse",
      r.el.chip2.classList.contains("live") && !r.el.chip2.classList.contains("on"));
  }

  group = "inverter/grid: ";
  {
    const c = new Card();
    c.setConfig({});
    const g = (o) => { c._hass = mkHass(Object.assign(base(), o)); return c._gridDown(); };
    eq("healthy", g({}), false);
    eq("safety sensor on means down", g({ [E.safe]: S("on") }), true);
    eq("149 V is down", g({ [E.gv]: S("149") }), true);
    eq("0 V is down", g({ [E.gv]: S("0") }), true);
    eq("150 V is up", g({ [E.gv]: S("150") }), false);
    eq("nothing known is not down", g({ [E.gv]: S("unknown"), [E.safe]: S("unknown") }), false);

    const st = base();
    st[E.safe] = S("on");
    st[E.rng] = S("off");
    st[E.gv] = S("0");
    const r = mk(st);
    eq("down: header word", r.el.mode.textContent, "Grid down · UPS");
    eq("down: dot red", r.el.livedot.style.background, BAD_C);
    eq("down: tile word", r.el.gridState.textContent, "NO GRID");
    eq("down: tile red", r.el.gridVal.style.color, BAD_C);
    check("down: no countdown", r.el.ret.hidden);
    eq("down: mark clamps at the left", r.el.gridMark.style.left, "0.00%");
  }

  group = "inverter/return: ";
  {
    const c = new Card();
    c.setConfig({});
    const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
    const rl = (safe, rng, lc, cfg) => {
      if (cfg) c.setConfig(cfg); else c.setConfig({});
      const st = base();
      if (safe === null) delete st[E.safe]; else st[E.safe] = S(safe);
      if (rng === null) delete st[E.rng]; else st[E.rng] = S(rng, {}, { last_changed: lc });
      c._hass = mkHass(st);
      return c._returnLeft();
    };
    const left = rl("on", "on", ago(60));
    check("60 s in: ~240 s left", left > 239 && left <= 240, String(left));
    eq("long past: clamps at 0", rl("on", "on", ago(400)), 0);
    eq("grid safe: nothing counting", rl("off", "on", ago(60)), null);
    eq("still out of range: nothing counting", rl("on", "off", ago(60)), null);
    eq("unavailable range sensor", rl("on", "unavailable", ago(60)), null);
    eq("no last_changed", rl("on", "on", undefined), null);
    eq("garbage last_changed", rl("on", "on", "not a date"), null);
    eq("missing safe sensor", rl(null, "on", ago(60)), null);
    eq("missing range sensor", rl("on", null, ago(60)), null);
    const l2 = rl("on", "on", ago(60), { grid_return_s: 600 });
    check("grid_return_s is honoured", l2 > 539 && l2 <= 540, String(l2));
    const skew = rl("on", "on", new Date(Date.now() + 60000).toISOString());
    eq("a last_changed ahead of the browser clock never counts above grid_return_s", skew, 300);

    // Rendered: the header pill.
    const st = base();
    st[E.safe] = S("on");
    st[E.rng] = S("on", {}, { last_changed: ago(55) });
    const r = mk(st);
    eq("returning: word", r.el.mode.textContent, "Grid returning · UPS");
    eq("returning: amber dot", r.el.livedot.style.background, WARN_C);
    check("returning: countdown shown", !r.el.ret.hidden && !r.el.retsep.hidden);
    eq("returning: m:ss", r.el.ret.textContent, "4:05");
    // _tick moves it without a state change, and hides it once nothing counts.
    r.h.states[E.rng] = S("on", {}, { last_changed: ago(299.5) });
    r.c._tick();
    eq("tick: last second rounds up", r.el.ret.textContent, "0:01");
    r.h.states[E.rng] = S("on", {}, { last_changed: ago(1000) });
    r.c._tick();
    eq("tick: clamped at 0:00", r.el.ret.textContent, "0:00");
    r.h.states[E.safe] = S("off");
    r.c._tick();
    check("tick: hidden once the grid is trusted", r.el.ret.hidden && r.el.retsep.hidden);
    eq("tick: word back to connected", r.el.mode.textContent, "Grid connected · UPS");
  }

  /* --- Pre-charge sub-label ------------------------------------------------- */
  group = "inverter/precharge: ";
  {
    const until = localIso(9, 30);
    const plan = (state, attrs, sw) => {
      const st = base();
      st[E.pre] = S(sw === undefined ? "on" : sw, { friendly_name: "Outage pre-charge" });
      if (state === null) delete st[E.pplan];
      else st[E.pplan] = S(state, attrs);
      return mk(st).el;
    };
    let el = plan("charging", { current: 30, until: until, reason: "outage at 10:00" });
    eq("charging", el.chipPcSub2.textContent, "30 A → " + hm(until));
    check("time is HH:MM", /^\d\d:\d\d$/.test(hm(until)), hm(until));
    eq("tooltip carries state and reason", head(el.chipPc2.title), "Outage pre-charge — on · charging: outage at 10:00");
    check("switch on lights the Pre-charge icon", el.chipPc2.classList.contains("on"));
    el = plan("waiting_night", { until: until, reason: "night will do" });
    eq("waiting_night", el.chipPcSub2.textContent, "at night → " + hm(until));
    el = plan("waiting_night", { until: "garbage" });
    eq("waiting_night with a bad until: no dangling arrow", el.chipPcSub2.textContent, "at night");
    el = plan("full", { reason: "already full" });
    eq("full", el.chipPcSub2.textContent, "full");
    el = plan("idle", { reason: "" });
    eq("idle prints nothing", el.chipPcSub2.textContent, "");
    eq("empty reason adds nothing to the tooltip", head(el.chipPc2.title), "Outage pre-charge — on");
    el = plan("charging", { current: 30, until: until, reason: "x" }, "off");
    eq("switch off: nothing, whatever the plan", el.chipPcSub2.textContent, "");
    eq("switch off: reason still explains", head(el.chipPc2.title), "Outage pre-charge — off · charging: x");
    check("switch off: icon dark", !el.chipPc2.classList.contains("on"));
    el = plan("charging", { current: 30, until: until }, "unavailable");
    eq("switch unavailable: nothing", el.chipPcSub2.textContent, "");
    el = plan(null);
    eq("plan sensor missing: nothing", el.chipPcSub2.textContent, "");
    eq("plan sensor missing: plain tooltip", head(el.chipPc2.title), "Outage pre-charge — on");
    el = plan("unavailable", {});
    eq("plan unavailable: nothing", el.chipPcSub2.textContent, "");

    // The tooltip is rebuilt, not appended to, on every patch.
    const st = base();
    st[E.pre] = S("on", { friendly_name: "P" });
    st[E.pplan] = S("charging", { current: 30, until: until, reason: "r" });
    const r = mk(st);
    rerender(r, (s) => { s[E.pplan] = S("charging", { current: 40, until: until, reason: "r" }); });
    eq("re-patched sub-label", r.el.chipPcSub2.textContent, "40 A → " + hm(until));
    eq("tooltip carries the reason once", head(r.el.chipPc2.title), "P — on · charging: r");

    el = plan("charging", { until: until });
    eq("charging plan with no `current` does not print \"undefined A\"", el.chipPcSub2.textContent, "charging → " + hm(until));
    el = plan("charging", { current: 30 });
    eq("charging plan with no `until` leaves no dangling arrow", el.chipPcSub2.textContent, "30 A");
    el = plan("charging", {});
    eq("charging plan with neither", el.chipPcSub2.textContent, "charging");
    el = plan("charging", { current: "unknown", until: "garbage" });
    eq("charging plan with garbage in both", el.chipPcSub2.textContent, "charging");
  }

  /* --- the adaptive dot ----------------------------------------------------- */
  group = "inverter/adaptive: ";
  {
    const run = (o) => {
      const st = base();
      Object.keys(o).forEach((k) => {
        if (o[k] === null) delete st[k];
        else st[k] = typeof o[k] === "string" ? S(o[k]) : o[k];
      });
      return mk(st).el;
    };
    const dis = (el) => el.chipAd2.classList.contains("dis");
    const on = (el) => el.chipAd2.classList.contains("on");
    const NEEDS = "Adaptive night charge — needs Auto or Night only, and the AC charger on";
    const OUTAGE = "Adaptive night charge — off while an outage is scheduled (pre-charge)";

    let el = run({ [E.ad]: "on" });
    check("on: lit, not dimmed", on(el) && !dis(el));
    el = run({ [E.ad]: "off", [E.auto]: "off", [E.night]: "off" });
    check("off, neither Auto nor Night only: dimmed", dis(el) && !on(el));
    eq("...with the why", head(el.chipAd2.title), NEEDS);
    el = run({ [E.ad]: "off", [E.auto]: "on", [E.acc]: "on", [E.night]: "off" });
    check("off, Auto with charger on: usable", !dis(el));
    eq("...tooltip says off", head(el.chipAd2.title), "Adaptive night charge — off · off: switched off");
    el = run({ [E.ad]: "off", [E.auto]: "on", [E.acc]: "off", [E.night]: "off" });
    check("off, Auto but charger off, no Night only: dimmed", dis(el));
    el = run({ [E.ad]: "off", [E.auto]: "off", [E.acc]: "off", [E.night]: "on" });
    check("off, Night only (charger off by design): usable", !dis(el));
    el = run({ [E.ad]: "off", [E.auto]: "on", [E.acc]: "off", [E.night]: "on" });
    check("off, Auto + Night only, charger off: usable", !dis(el));
    el = run({ [E.ad]: "off", [E.auto]: "unavailable", [E.acc]: "unavailable", [E.night]: "unavailable" });
    check("off, every switch unavailable: dimmed", dis(el));
    ["waiting_night", "charging", "full"].forEach((p) => {
      el = run({ [E.ad]: "off", [E.night]: "on", [E.pplan]: p });
      check("off, pre-charge " + p + ": dimmed", dis(el));
      eq("off, pre-charge " + p + ": outage tooltip", head(el.chipAd2.title), OUTAGE);
      el = run({ [E.ad]: "on", [E.night]: "on", [E.pplan]: p });
      check("ON, pre-charge " + p + ": not dimmed, so it can be turned off", !dis(el) && on(el));
    });
    ["idle", "unknown", "unavailable"].forEach((p) => {
      el = run({ [E.ad]: "off", [E.pplan]: p });
      check("off, pre-charge " + p + ": usable", !dis(el));
    });
    el = run({ [E.ad]: "off", [E.pplan]: null });
    check("off, pre-charge plan missing: usable", !dis(el));
    el = run({ [E.ad]: "unavailable", [E.auto]: "off", [E.night]: "off" });
    check("unavailable and unusable: dimmed, not lit", dis(el) && !on(el));
    el = run({ [E.ad]: null });
    check("boolean missing, usable: neither lit nor dimmed", !dis(el) && !on(el));
    eq("...tooltip says unknown", head(el.chipAd2.title), "Adaptive night charge — unknown · off: switched off");
    // An ON dot under unusable switches is still not dimmed.
    el = run({ [E.ad]: "on", [E.auto]: "off", [E.night]: "off" });
    check("on while unusable: still clickable", !dis(el) && on(el));

    // Sub-label.
    const seven = localIso(7, 0);
    const sub = (adState, planState, attrs) => run({ [E.ad]: adState, [E.aplan]: planState === null ? null : S(planState, attrs) }).chipAdSub2.textContent;
    eq("charging", sub("on", "charging", { current: 20, until: seven }), "20 A → " + hm(seven));
    eq("charging at 07:00 local", hm(seven), "07:00");
    eq("charging with no current", sub("on", "charging", { until: seven }), "charging → 07:00");
    eq("charging with no until", sub("on", "charging", { current: 20 }), "20 A");
    eq("charging with a bad until", sub("on", "charging", { current: 20, until: "garbage" }), "20 A");
    eq("full", sub("on", "full", { current: 2 }), "full");
    eq("day", sub("on", "day", {}), "tonight");
    eq("off", sub("on", "off", {}), "");
    eq("inactive", sub("on", "inactive", {}), "");
    eq("unknown", sub("on", "unknown", {}), "");
    eq("plan missing", sub("on", null), "");
    eq("boolean off hides a charging plan", sub("off", "charging", { current: 20, until: seven }), "");
    eq("boolean unavailable hides it too", sub("unavailable", "day", {}), "");
    el = run({ [E.ad]: "on", [E.aplan]: S("charging", { current: 20, until: seven, reason: "needs 18.2 A" }) });
    eq("tooltip with plan reason", head(el.chipAd2.title), "Adaptive night charge — on · charging: needs 18.2 A");
    el = run({ [E.ad]: "on", [E.aplan]: S("charging", { current: 20, until: seven }) });
    eq("tooltip without a reason", head(el.chipAd2.title), "Adaptive night charge — on");
  }

  /* --- acting icons pulse --------------------------------------------------- */
  group = "inverter/acting: ";
  {
    const until = localIso(7, 0);
    const act = (k, el) => el["chip" + k + "2"].classList.contains("act");
    const run = (o) => { const st = base(); Object.keys(o).forEach((k) => { st[k] = o[k]; }); return mk(st).el; };
    // Night only: on AND the pack charging now.
    check("Night only on, pack idle: lit, still",
      !act("Nt", run({ [E.night]: S("on") })));
    let el = run({ [E.night]: S("on"), [E.bw]: S("900") });
    check("Night only on, pack charging: pulses", act("Nt", el) && el.chipNt2.classList.contains("on"));
    check("Night only off, pack charging: still", !act("Nt", run({ [E.night]: S("off"), [E.bw]: S("900") })));
    check("Night only on, charging but grid down: still",
      !act("Nt", run({ [E.night]: S("on"), [E.bw]: S("900"), [E.safe]: S("on") })));
    // Adaptive: on AND its plan charging.
    check("adaptive on, plan charging: pulses",
      act("Ad", run({ [E.ad]: S("on"), [E.aplan]: S("charging", { current: 20, until: until }) })));
    ["day", "full", "off", "inactive", "unknown"].forEach((p) => {
      check("adaptive on, plan " + p + ": still", !act("Ad", run({ [E.ad]: S("on"), [E.aplan]: S(p, {}) })));
    });
    check("adaptive off, plan charging: still",
      !act("Ad", run({ [E.ad]: S("off"), [E.aplan]: S("charging", { current: 20 }) })));
    // Pre-charge: on AND its plan charging.
    check("pre-charge on, plan charging: pulses",
      act("Pc", run({ [E.pre]: S("on"), [E.pplan]: S("charging", { current: 30, until: until }) })));
    ["idle", "waiting_night", "full"].forEach((p) => {
      check("pre-charge on, plan " + p + ": still", !act("Pc", run({ [E.pre]: S("on"), [E.pplan]: S(p, {}) })));
    });
    check("pre-charge off, plan charging: still",
      !act("Pc", run({ [E.pre]: S("off"), [E.pplan]: S("charging", { current: 30 }) })));
    // And it stops when the action does.
    const r = mk(Object.assign(base(), { [E.ad]: S("on"), [E.aplan]: S("charging", { current: 20 }) }));
    rerender(r, (s) => { s[E.aplan] = S("full", { current: 2 }); });
    check("adaptive stops pulsing when the plan goes full", !r.el.chipAd2.classList.contains("act"));
    const css = r.c.shadowRoot.querySelector("style").textContent;
    check("only a lit AND acting icon animates", css.indexOf(".chip .dw.i.on.act ha-icon { animation: pmpulse") >= 0);
    check("reduced motion pauses it", css.indexOf(".chip .dw.i.on.act ha-icon { animation-play-state: paused; }") >= 0);
  }

  /* --- clicks ---------------------------------------------------------------- */
  group = "inverter/click: ";
  {
    const r = mk(base());
    const root = r.c.shadowRoot;
    const q = (s) => root.querySelector(s);
    const last = () => r.c._hass.calls[r.c._hass.calls.length - 1];
    const ncalls = () => r.c._hass.calls.length;

    let ev = fire(r.el.chip0.querySelector(".ic"), "click");
    eq("icon toggles its switch", last(), ["switch", "toggle", { entity_id: E.auto }]);
    check("toggle stops propagation and the default", ev.stopped && ev.defaultPrevented);
    fire(r.el.chip1.querySelector(".dw .dot"), "click");
    eq("a plain chip's dot toggles its switch", last(), ["switch", "toggle", { entity_id: E.prot }]);
    fire(r.el.chip2.querySelector(".ic ha-icon"), "click");
    eq("the AC charge chip's left icon toggles the charger", last(), ["switch", "toggle", { entity_id: E.acc }]);
    fire(r.el.chipNt2, "click");
    eq("the Night icon toggles Night only", last(), ["switch", "toggle", { entity_id: E.night }]);
    fire(r.el.chipPc2.querySelector("ha-icon"), "click");
    eq("a click on the Pre-charge glyph toggles pre-charge", last(), ["switch", "toggle", { entity_id: E.pre }]);

    const before = ncalls();
    fire(r.el.chip1.querySelector(".lbl"), "click");
    eq("label opens more-info", r.c.dispatched.map((e) => [e.type, e.detail.entityId]).pop(),
      ["hass-more-info", E.prot]);
    const mi = r.c.dispatched[r.c.dispatched.length - 1];
    check("more-info is composed and bubbles", mi.composed && mi.bubbles);
    eq("label calls no service", ncalls(), before);

    // Adaptive dot: usable (Auto + charger on) -> input_boolean.toggle.
    fire(r.el.chipAd2, "click");
    eq("adaptive dot toggles the input_boolean", last(), ["input_boolean", "toggle", { entity_id: E.ad }]);
    fire(r.el.chipAd2.querySelector("ha-icon"), "click");
    eq("adaptive glyph too", last(), ["input_boolean", "toggle", { entity_id: E.ad }]);

    // Dimmed: nothing at all -- no service, no dialog, and the click stops here.
    rerender(r, (s) => { s[E.auto] = S("off"); s[E.night] = S("off"); });
    check("now dimmed", r.el.chipAd2.classList.contains("dis"));
    const n0 = ncalls(), d0 = r.c.dispatched.length;
    ev = fire(r.el.chipAd2.querySelector("ha-icon"), "click");
    eq("dimmed dot: no service", ncalls(), n0);
    eq("dimmed dot: no dialog", r.c.dispatched.length, d0);
    check("dimmed dot: click still swallowed", ev.stopped);
    ev = fire(r.el.chipAd2, "keydown", { key: "Enter" });
    eq("dimmed dot: Enter does nothing", ncalls(), n0);

    fire(r.el.chipAdSub2, "click");
    eq("adaptive sub-label opens the plan", r.c.dispatched.pop().detail.entityId, E.aplan);
    fire(r.el.chipPcSub2, "click");
    eq("pre-charge sub-label opens its plan", r.c.dispatched.pop().detail.entityId, E.pplan);
    fire(q(".tile.t-grid .t-val"), "click");
    eq("a tile's child opens the tile's entity", r.c.dispatched.pop().detail.entityId, E.gv);
    fire(q(".pill"), "click");
    eq("header pill opens grid_safe", r.c.dispatched.pop().detail.entityId, E.safe);
    fire(r.el.battSub, "click");
    eq("battery sub opens what it shows", r.c.dispatched.pop().detail.entityId, E.bv);
    const d1 = r.c.dispatched.length, n1 = ncalls();
    fire(q(".plabel"), "click");
    check("a plain label does nothing", r.c.dispatched.length === d1 && ncalls() === n1);

    // Keyboard.
    fire(r.el.chip0.querySelector(".ic"), "keydown", { key: "Enter" });
    eq("Enter on an icon toggles", last(), ["switch", "toggle", { entity_id: E.auto }]);
    fire(r.el.chip0.querySelector(".lbl"), "keydown", { key: " " });
    eq("Space on a label opens more-info", r.c.dispatched.pop().detail.entityId, E.auto);
    const n2 = ncalls(), d2 = r.c.dispatched.length;
    fire(r.el.chip0.querySelector(".ic"), "keydown", { key: "a" });
    check("other keys do nothing", ncalls() === n2 && r.c.dispatched.length === d2);

    // Range and tab.
    const seg = r.el.ranges.querySelector('[data-val="24h"]');
    r.c._view = { start: 0, end: 1, follow: false };
    fire(seg, "click");
    eq("range click sets the window", r.c._range, "24h");
    eq("range click drops a zoom", r.c._view, null);
    eq("range pressed", r.el.ranges.querySelectorAll(".seg").filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.getAttribute("data-val")), ["24h"]);
    fire(r.el.tabs.querySelector('[data-val="soc"]'), "click");
    eq("tab click picks the series", r.c._sel, "soc");
    eq("tab pressed", r.el.tabs.querySelectorAll(".tab").filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.getAttribute("data-val")), ["soc"]);
    eq("chart title follows", r.el.chName.textContent, "Battery SOC");
    eq("chart title opens the series entity", r.el.chName.getAttribute("data-more"), E.soc);

    // No hass: a toggle does nothing rather than throw.
    const bare = new Card();
    bare.setConfig({});
    bare._hass = null;
    const ic = new Element("span");
    ic.setAttribute("data-act", "toggle");
    ic.setAttribute("data-ent", "switch.x");
    noThrow("toggle without hass", () => bare._onClick({ composedPath: () => [ic], stopPropagation() {}, preventDefault() {} }));
    noThrow("event without composedPath falls back to target",
      () => bare._onClick({ target: ic, stopPropagation() {}, preventDefault() {} }));
    noThrow("more-info with no entity is ignored", () => bare._moreInfo(""));
    eq("...and dispatches nothing", bare.dispatched.length, 0);
  }

  group = "inverter/overrides: ";
  {
    const st = base();
    st["switch.my_auto"] = S("on", { friendly_name: "My auto" });
    st[E.auto] = S("off");
    st["input_boolean.my_ac"] = S("on");
    const r = mk(st, { chip_auto: "switch.my_auto", chip_ac_charge: "input_boolean.my_ac",
      adaptive_charge: "input_boolean.other_adaptive" });
    eq("overridden chip reads its own entity", r.el.chip0.classList.contains("on"), true);
    eq("overridden chip title", head(r.el.chip0.title), "My auto — on");
    eq("icon data-ent", r.el.chip0.querySelector(".ic").getAttribute("data-ent"), "switch.my_auto");
    eq("label data-more", r.el.chip0.querySelector(".lbl").getAttribute("data-more"), "switch.my_auto");
    fire(r.el.chip0.querySelector(".ic"), "click");
    eq("toggle goes to the override", r.h.calls.pop(), ["switch", "toggle", { entity_id: "switch.my_auto" }]);
    fire(r.el.chip2.querySelector(".ic"), "click");
    eq("domain comes from the entity id", r.h.calls.pop(), ["input_boolean", "toggle", { entity_id: "input_boolean.my_ac" }]);
    eq("adaptive dot follows its override", r.el.chipAd2.getAttribute("data-ent"), "input_boolean.other_adaptive");
    const r2 = mk(base(), { chip_night_only: "switch.my_night", chip_precharge: "switch.my_pre" });
    eq("chip_night_only still overrides the Night icon", r2.el.chipNt2.getAttribute("data-ent"), "switch.my_night");
    eq("chip_precharge still overrides the Pre-charge icon", r2.el.chipPc2.getAttribute("data-ent"), "switch.my_pre");
    throws("chip_night_only is still validated", () => r2.c.setConfig({ chip_night_only: "x" }), /chip_night_only must be an entity id/);
    // The adaptive usability rule reads the overridden chips too.
    check("usable through the overridden Auto + charger", !r.el.chipAd2.classList.contains("dis"));
  }

  /* --- selects ---------------------------------------------------------------- */
  group = "inverter/select: ";
  {
    const r = mk(base());
    const sel = r.el.maxChg;
    eq("options carry the unit", sel.options.map((o) => o.textContent), ["2 A", "10 A", "20 A", "30 A", "40 A", "50 A", "60 A"]);
    eq("option values are bare", sel.options.map((o) => o.value)[3], "30");
    eq("current value selected", sel.value, "30");
    check("enabled", !sel.disabled);
    eq("priority has no suffix", r.el.prio.options.map((o) => o.textContent), ["Utility first", "Solar first", "SBU"]);

    sel.value = "40";
    const ev = fire(sel, "change");
    eq("change -> select.select_option", r.h.calls.pop(), ["select", "select_option", { entity_id: E.maxc, option: "40" }]);
    check("change does not bubble further", ev.stopped);
    const d0 = r.c.dispatched.length;
    fire(sel, "click");
    eq("a click on the select opens no dialog", r.c.dispatched.length, d0);
    fire(r.el.prio, "change");
    eq("priority change", r.h.calls.pop()[2], { entity_id: E.prio, option: "Utility first" });

    // Same options: the list is not rebuilt (an open dropdown would close).
    const opt0 = sel.options[0];
    rerender(r, (s) => { s[E.maxc] = S("50", { options: ["2", "10", "20", "30", "40", "50", "60"] }); });
    check("same options: same nodes", sel.options[0] === opt0);
    eq("value follows the state", sel.value, "50");
    rerender(r, (s) => { s[E.maxc] = S("10", { options: ["10", "20"] }); });
    check("new options: rebuilt", sel.options[0] !== opt0);
    eq("new options list", sel.options.map((o) => o.value), ["10", "20"]);
    rerender(r, (s) => { s[E.maxc] = S("unavailable", { options: ["10", "20"] }); });
    eq("state outside the options selects nothing", sel.value, "");
    rerender(r, (s) => { s[E.maxc] = S("unavailable", {}); });
    check("options-only change waits for a state change (print reads states)", !sel.disabled);
    rerender(r, (s) => { s[E.maxc] = S("unknown", {}); });
    check("no options: disabled", sel.disabled);
    eq("no options: a dash", sel.options.map((o) => o.textContent), ["—"]);
    eq("no options: signature cleared", sel.dataset.sig, "");
    rerender(r, (s) => { s[E.maxc] = S("20", { options: ["10", "20"] }); });
    check("options back: enabled", !sel.disabled);
    eq("options back: rebuilt with values", sel.options.map((o) => o.value), ["10", "20"]);
    eq("options back: selected", sel.value, "20");

    const bare = new Card();
    bare.setConfig({});
    noThrow("select without hass", () => bare._onSelect({ target: sel, stopPropagation() {} }));
    noThrow("select without data-ent", () => bare._onSelect({ target: new Element("select"), stopPropagation() {} }));
  }

  /* --- energy rows ---------------------------------------------------------- */
  group = "inverter/energy: ";
  {
    const r = mk(base());
    check("day row active", r.el.erow0.classList.contains("on") && !r.el.erow1.classList.contains("on"));
    eq("day tag", [r.el.etag0.textContent, r.el.etag1.textContent, r.el.etag2.textContent], ["active", "", ""]);
    eq("values and decimals", [r.el.eval0.textContent, r.el.eval1.textContent, r.el.eval2.textContent],
      ["123.46 kWh", "78.90 kWh", "202.3 kWh"]);
    check("labelled as this month's, from the meter",
      r.c.shadowRoot.querySelectorAll(".erow .en").map((n) => n.textContent).join("|") === "Day this month|Night this month|Meter total");
    eq("rows open the meter's entities", [0, 1, 2].map((i) => r.el["erow" + i].getAttribute("data-more")), [E.td, E.tn, E.tot]);
    rerender(r, (s) => { s[E.tdc] = S("12.3456"); s[E.tnc] = S("5.263"); });
    eq("with costs", [r.el.eval0.textContent, r.el.eval1.textContent], ["123.46 kWh12.35 ₴", "78.90 kWh5.26 ₴"]);
    eq("cost is its own element", r.el.eval0.innerHTML, "123.46 kWh<small>12.35 ₴</small>");
    rerender(r, (s) => { s[E.tdc] = S("unavailable"); });
    eq("an unavailable cost is left out", r.el.eval0.textContent, "123.46 kWh");
    rerender(r, (s) => { s[E.tariff] = S("night"); });
    check("night row active", !r.el.erow0.classList.contains("on") && r.el.erow1.classList.contains("on"));
    rerender(r, (s) => { s[E.tariff] = S("unavailable"); s[E.td] = S("unknown"); });
    check("unknown tariff: no row active", [0, 1, 2].every((i) => !r.el["erow" + i].classList.contains("on")));
    eq("unknown meter", r.el.eval0.textContent, "— kWh");
    check("the total never shows a cost", r.el.eval2.innerHTML.indexOf("<small>") < 0);
    check("the total is never 'active'", !r.el.erow2.classList.contains("on"));
  }

  /* --- the Meter tile ------------------------------------------------------------ */
  group = "inverter/meter: ";
  {
    // base(): grid input (calculated) 300 W, no meter entity at all.
    let r = mk(base());
    check("no meter entity: the Meter tile and run are hidden", r.el.dirTile.hidden && r.el.dirRun.hidden);
    eq("the Grid tile shows the inverter's grid input", r.el.gridSub.textContent, "50.00 Hz · 300 W in");

    r = mk(Object.assign(base(), { [E.mw]: S("2450") }));
    check("meter present: shown", !r.el.dirTile.hidden && !r.el.dirRun.hidden);
    eq("the Grid tile does not repeat the meter", r.el.gridSub.textContent, "50.00 Hz · 300 W in");
    eq("named Meter", r.el.dirTile.querySelector(".t-name").textContent, "Meter");
    eq("big number: the meter's real power", r.el.dirVal.textContent, "2450W");
    eq("sub: share of the breaker", r.el.dirSub.textContent, "40.8 % of the 6000 W breaker");
    eq("normal under 60 %", [r.el.dirState.textContent, r.el.dirVal.style.color], ["NORMAL", OK_C]);
    eq("the scale's marker", r.el.dirMark.style.left, "40.83%");
    eq("ticks: 0 · 3600 · 6000 (the breaker)",
      r.el.dirTile.querySelectorAll(".ticks span").map((n) => n.textContent), ["0", "3600", "6000"]);
    eq("the run flows", r.el.runDir.style._props["--play"], "running");
    eq("opens the meter", r.el.dirTile.getAttribute("data-more"), E.mw);
    check("no bypass arithmetic anywhere", r.el.dirTile.textContent.indexOf("inverter") < 0);
    const css0 = r.c.shadowRoot.querySelector("style").textContent;
    check("styled like the Grid tile: solid border, same amber family",
      css0.indexOf(".tile.t-dir { border: 1px solid #241D14; background: #0F0D0A; }") >= 0
      && css0.indexOf(".tile.t-grid { border: 1px solid #241D14; background: #0F0D0A; }") >= 0);

    rerender(r, (s) => { s[E.mw] = S("4200"); });
    eq("over 60 %: elevated, amber", [r.el.dirState.textContent, r.el.dirVal.style.color], ["ELEVATED", WARN_C]);
    rerender(r, (s) => { s[E.mw] = S("5400"); });
    eq("over 85 %: heavy, red", [r.el.dirState.textContent, r.el.dirVal.style.color], ["HEAVY", BAD_C]);
    rerender(r, (s) => { s[E.mw] = S("6600"); });
    eq("past the breaker: overload, marker pinned", [r.el.dirState.textContent, r.el.dirMark.style.left], ["OVERLOAD", "100.00%"]);
    rerender(r, (s) => { s[E.mw] = S("0"); });
    eq("grid down, 0 W: the run stands still", r.el.runDir.style._props["--play"], "paused");
    rerender(r, (s) => { s[E.mw] = S("unavailable"); });
    check("meter unavailable: still shown, no data", !r.el.dirTile.hidden && r.el.dirState.textContent === "NO DATA");
    eq("...dash and marker at 0", [r.el.dirVal.textContent, r.el.dirMark.style.left], ["—W", "0.00%"]);

    const r3 = mk(Object.assign(base(), { [E.mw]: S("1000") }), { max_meter_w: 4000 });
    eq("max_meter_w moves the scale", r3.el.dirTile.querySelectorAll(".ticks span").map((n) => n.textContent), ["0", "2400", "4000"]);
    eq("...and the share", r3.el.dirSub.textContent, "25.0 % of the 4000 W breaker");
    throws("max_meter_w validated", () => r3.c.setConfig({ max_meter_w: 0 }), /max_meter_w must be a positive/);

    // Layout: under Grid on a wide card; stacked last, with no run, on a phone.
    const css = r.c.shadowRoot.querySelector("style").textContent;
    check("wide: Meter in column 1, under Grid", css.indexOf(".battrun > .direct, .battwrap > .direct { grid-column: 1; }") >= 0);
    const narrow = css.slice(css.indexOf("@container pmcard (max-width: 900px)"));
    check("narrow: its run is dropped", narrow.indexOf(".battrun > .direct { display: none; }") >= 0);
    check("narrow: Meter comes after Battery",
      narrow.indexOf(".battwrap > .t-batt { order: 1; }") >= 0 && narrow.indexOf(".battwrap > .direct { order: 2; }") >= 0);
    check("narrow: no fixed grid row", narrow.indexOf("grid-row: auto;") >= 0);
  }

  /* --- battery tile ----------------------------------------------------------- */
  group = "inverter/battery: ";
  {
    const r = mk(Object.assign(base(), { [E.bw]: S("500"), [E.cc]: S("18.5") }));
    eq("charging state", r.el.battState.textContent, "CHG · HEALTHY");
    eq("charging sub", r.el.battSub.textContent, "26.8 V · 500 W in · 18.5 A");
    eq("charging links the charge current", r.el.battSub.getAttribute("data-more"), E.cc);
    eq("battery run forwards", r.el.runBatt.style._props["--dir"], "normal");
    rerender(r, (s) => { s[E.bw] = S("-300"); s[E.dc] = S("11.2"); s[E.soc] = S("15"); });
    eq("discharging state", r.el.battState.textContent, "DIS · CRITICAL");
    eq("discharging sub", r.el.battSub.textContent, "26.8 V · -300 W out · 11.2 A");
    eq("discharging links the discharge current", r.el.battSub.getAttribute("data-more"), E.dc);
    eq("battery run reversed", r.el.runBatt.style._props["--dir"], "reverse");
    eq("critical soc red", r.el.socVal.style.color, BAD_C);
    rerender(r, (s) => { s[E.bw] = S("-2"); });
    eq("-2 W is idle", r.el.battState.textContent, "IDLE · CRITICAL");
    rerender(r, (s) => { s[E.bw] = S("800"); s[E.cc] = S("0"); });
    eq("charging with a zero current: no amps", r.el.battSub.textContent, "26.8 V · 800 W in");
    eq("...and links the voltage", r.el.battSub.getAttribute("data-more"), E.bv);
    rerender(r, (s) => { s[E.cc] = S("unavailable"); });
    eq("charging with the current unavailable", r.el.battSub.textContent, "26.8 V · 800 W in");
    rerender(r, (s) => { s[E.soc] = S("100"); });
    eq("100 %", [r.el.socVal.textContent, r.el.socFill.style.width, r.el.battState.textContent], ["100%", "100%", "CHG · FULL"]);
    rerender(r, (s) => { s[E.soc] = S("0"); });
    eq("0 %", [r.el.socVal.textContent, r.el.socFill.style.width], ["0%", "0%"]);
    rerender(r, (s) => { s[E.soc] = S("unknown"); });
    eq("unknown soc", [r.el.socVal.textContent, r.el.socFill.style.width, r.el.battState.textContent],
      ["—%", "0%", "CHG · NO DATA"]);
    eq("unknown soc colour", r.el.socFill.style._props["--fc"], "#5C616B");

    rerender(r, (s) => { s[E.soc] = S("104"); });
    eq("SOC fill is clamped to 0..100 %, as the battery card's", r.el.socFill.style.width, "100%");
    rerender(r, (s) => { s[E.soc] = S("-2"); });
    eq("a negative SOC glitch draws an empty bar, not an invalid CSS width", r.el.socFill.style.width, "0%");

    rerender(r, (s) => { s[E.lp] = S("150"); });
    eq("load mark clamps high", r.el.loadMark.style.left, "100.00%");
    eq("overload word", r.el.loadState.textContent, "OVERLOAD");
    rerender(r, (s) => { s[E.lp] = S("-5"); });
    eq("load mark clamps low", r.el.loadMark.style.left, "0.00%");
    rerender(r, (s) => { s[E.gv] = S("275"); });
    eq("grid mark clamps high", r.el.gridMark.style.left, "100.00%");
    eq("overvoltage word", r.el.gridState.textContent, "OVERVOLTAGE");
  }

  /* --- fingerprint ------------------------------------------------------------ */
  group = "inverter/fingerprint: ";
  {
    const seven = localIso(7, 0);
    const st = base();
    st[E.ad] = S("on");
    st[E.aplan] = S("charging", { current: 20, until: seven, reason: "a" });
    const r = mk(st);
    const p0 = r.c._fingerprint();

    // An unrelated entity changing does not re-patch.
    r.el.gridState.textContent = "SENTINEL";
    rerender(r, (s) => { s["sensor.kitchen_temperature"] = S("22"); });
    eq("unrelated change: no re-patch", r.el.gridState.textContent, "SENTINEL");
    eq("unrelated change: same print", r.c._fingerprint(), p0);
    // ...but the flow runs are always written.
    rerender(r, (s) => { s[E.gp] = S("0"); });
    eq("grid power is in the print, flow idles", r.el.runGrid.style._props["--play"], "paused");

    const changes = [
      ["adaptive current", (s) => { s[E.aplan] = S("charging", { current: 30, until: seven, reason: "a" }); }],
      ["adaptive until", (s) => { s[E.aplan] = S("charging", { current: 30, until: localIso(6, 30), reason: "a" }); }],
      ["adaptive reason", (s) => { s[E.aplan] = S("charging", { current: 30, until: localIso(6, 30), reason: "b" }); }],
      ["adaptive plan state", (s) => { s[E.aplan] = S("full", { current: 2, reason: "b" }); }],
      ["adaptive boolean", (s) => { s[E.ad] = S("off"); }],
      ["pre-charge plan state", (s) => { s[E.pplan] = S("charging", { current: 30, until: seven }); }],
      ["pre-charge current", (s) => { s[E.pplan] = S("charging", { current: 40, until: seven }); }],
      ["pre-charge until", (s) => { s[E.pplan] = S("charging", { current: 40, until: localIso(8, 0) }); }],
      ["a chip switch", (s) => { s[E.night] = S("on"); }],
    ];
    changes.forEach(([name, fn]) => {
      const before = r.c._fingerprint();
      rerender(r, fn);
      check(name + " changes the print", r.c._fingerprint() !== before);
    });
    rerender(r, (s) => { s[E.ad] = S("on"); s[E.aplan] = S("charging", { current: 20, until: seven, reason: "a" }); });
    eq("sub-label after attr changes", r.el.chipAdSub2.textContent, "20 A → 07:00");
    rerender(r, (s) => { s[E.aplan] = S("charging", { current: 25, until: seven, reason: "a" }); });
    eq("an attribute-only change reaches the sub-label", r.el.chipAdSub2.textContent, "25 A → 07:00");
    rerender(r, (s) => { s[E.aplan] = S("charging", { current: 25, until: seven, reason: "behind" }); });
    eq("a reason-only change reaches the tooltip", head(r.el.chipAd2.title), "Adaptive night charge — on · charging: behind");

    // The pre-charge reason is in the print too.
    rerender(r, (s) => {
      s[E.pre] = S("on", { friendly_name: "P" });
      s[E.pplan] = S("charging", { current: 30, until: seven, reason: "outage at 10:00" });
    });
    rerender(r, (s) => { s[E.pplan] = S("charging", { current: 30, until: seven, reason: "outage moved to 11:00" }); });
    check("a pre-charge reason-only change refreshes the Pre-charge tooltip",
      r.el.chipPc2.title.indexOf("outage moved to 11:00") >= 0, "title still " + JSON.stringify(r.el.chipPc2.title));
  }

  /* --- nothing reporting ------------------------------------------------------ */
  group = "inverter/unknown: ";
  for (const variant of ["empty states", "all unavailable", "garbage numbers"]) {
    let st = {};
    if (variant !== "empty states") {
      st = base();
      Object.keys(st).forEach((k) => {
        st[k] = S(variant === "all unavailable" ? "unavailable" : "NaN", {});
      });
    }
    let r;
    noThrow(variant + ": renders", () => { r = mk(st); });
    if (!r) continue;
    const el = r.el;
    const v = variant + ": ";
    eq(v + "uptime", el.uptime.textContent, "—");
    eq(v + "mode", el.mode.textContent, "Grid connected · " + (variant === "empty states" ? "unknown" : variant === "all unavailable" ? "unavailable" : "NaN"));
    eq(v + "grid value", el.gridVal.textContent, "—V");
    eq(v + "grid word", el.gridState.textContent, "NO DATA");
    eq(v + "grid sub", el.gridSub.textContent, "— Hz · — W in");
    eq(v + "grid mark", el.gridMark.style.left, "0.00%");
    eq(v + "inverter word", el.invState.textContent, "NO DATA");
    eq(v + "load", [el.loadVal.textContent, el.loadState.textContent, el.loadSub.textContent],
      ["—W", "NO DATA", "— % of 2400 W"]);
    eq(v + "battery", [el.socVal.textContent, el.battState.textContent, el.battSub.textContent],
      ["—%", "IDLE · NO DATA", "— V · — W idle"]);
    check(v + "selects disabled", el.maxChg.disabled && el.prio.disabled && el.acMode.disabled);
    eq(v + "energy", el.eval2.textContent, "— kWh");
    check(v + "no chip on", [0, 1, 2].every((i) => !el["chip" + i].classList.contains("on")));
    check(v + "no icon lit", ["Nt", "Ad", "Pc"].every((k) => !el["chip" + k + "2"].classList.contains("on")));
    check(v + "adaptive dimmed", el.chipAd2.classList.contains("dis"));
    eq(v + "subs empty", [el.chipPcSub2.textContent, el.chipAdSub2.textContent], ["", ""]);
    check(v + "no countdown", el.ret.hidden);
    eq(v + "flows idle", [el.runGrid, el.runLoad, el.runBatt].map((n) => n.style._props["--play"]), ["paused", "paused", "paused"]);
  }
  noThrow("hass with no states map", () => { const c = new Card(); c.setConfig({}); c.hass = { callWS: async () => ({}) }; });

  /* --- blocks and re-config --------------------------------------------------- */
  group = "inverter/blocks: ";
  {
    const one = (blocks) => mk(base(), { blocks: blocks });
    let r = one(["header"]);
    check("header only: chips, no tiles, no chart", !!r.el.chip0 && !r.el.gridVal && !r.el.chLine && !r.el.maxChg);
    r = one(["flow"]);
    check("flow only: tiles, no chips", !!r.el.gridVal && !r.el.chip0 && !r.el.maxChg);
    eq("flow only still patches", r.el.socVal.textContent, "80%");
    r = one(["controls"]);
    check("controls only: selects", !!r.el.maxChg && !r.el.gridVal);
    r = one(["history"]);
    check("history only: chart", !!r.el.chLine && !r.el.chip0);
    check("history foot text", r.c.shadowRoot.querySelector(".foot").textContent.indexOf("Drag the chart") >= 0);
    r = one(["header"]);
    check("no history: no drag hint", r.c.shadowRoot.querySelector(".foot").textContent.indexOf("Drag") < 0);

    // setConfig after hass rebuilds.
    await flush();
    takeUnhandled();
    r = mk(base());
    r.c.setConfig({ blocks: ["header"] });
    check("re-config rebuilds", !r.c._el.gridVal && !!r.c._el.chip0);
    check("re-config leaves no stale tile in the shadow root", !r.c.shadowRoot.querySelector(".tile"));
    await flush();
    const u = takeUnhandled();
    check("re-config to a layout without history while a history fetch is in flight does not throw",
      u.length === 0, u.length ? "unhandled rejection: " + (u[0] && u[0].message) : "");
  }

  /* --- the chart path, briefly ---------------------------------------------- */
  group = "inverter/chart: ";
  {
    let r = mk(base());
    await flush();
    eq("first fetch is raw history for grid voltage", r.h.ws[0] && [r.h.ws[0].type, r.h.ws[0].entity_ids], ["history/history_during_period", [E.gv]]);
    eq("empty history says so", r.el.chNote.textContent, "no history recorded");
    check("note shown", r.el.chNote.classList.contains("show"));

    const now = Date.now();
    r = mk(base(), {}, { callWS: () => ({ [E.gv]: [0, 1, 2, 3].map((i) => ({ s: String(228 + i), lu: (now - (20 - i * 5) * 60000) / 1000 })) }) });
    await flush();
    check("points: note hidden", !r.el.chNote.classList.contains("show"));
    check("points: a line is drawn", (r.el.chLine.getAttribute("d") || "").indexOf("M") === 0);
    const stats = r.el.stats.querySelectorAll(".stat").map((s) => s.textContent);
    eq("points: Now/Min/Max/Mean", stats.map((t) => t.replace(/[\d.]+ V$/, "")), ["Now", "Min", "Max", "Mean"]);
    eq("points: Now is the live state", stats[0], "Now230.0 V");
    eq("points: Min", stats[1], "Min228.0 V");
    eq("points: Max", stats[2], "Max231.0 V");
    eq("points: line in the band colour", r.el.chLine.getAttribute("stroke"), OK_C);

    r = mk(base(), {}, { callWS: () => { throw new Error("boom"); } });
    await flush();
    eq("a failing recorder is reported", r.el.chNote.textContent, "history unavailable — boom");

    const c = new Card();
    c.setConfig({});
    eq("_presetFor 10 min", c._presetFor(10 * 60000), "30m");
    eq("_presetFor 2 h", c._presetFor(2 * 3600000), "24h");
    eq("_presetFor beyond the longest", c._presetFor(400 * 3600000), "14d");
    c._setView(Date.now() - 1000, Date.now());
    check("_setView widens to a minute", c._view.end - c._view.start >= 59999);
    check("_setView at now follows", c._view.follow === true);
  }
}

/* ========================================================================== */
/* 2. jkbms-battery-console-card.js                                           */
/* ========================================================================== */

async function batterySuite() {
  const L = loadCard("jkbms-battery-console-card.js");
  const Card = L.Card;
  const OK = "#589569", WARN = "#ae8446", BAD = "#bb635b", MUTED = "#6E737E", TXT = "#E8EAED", TXT2 = "#9AA0AB";

  const E = {
    soc: "sensor.jkbms_gateway_bms_state_of_charge",
    cap: "sensor.jkbms_gateway_bms_capacity_remaining",
    v: "sensor.jkbms_gateway_bms_total_voltage",
    a: "sensor.jkbms_gateway_bms_current",
    w: "sensor.jkbms_gateway_bms_power",
    cmin: "sensor.jkbms_gateway_bms_min_cell_voltage",
    cmax: "sensor.jkbms_gateway_bms_max_cell_voltage",
    d: "sensor.jkbms_gateway_bms_delta_cell_voltage",
    t1: "sensor.jkbms_gateway_bms_temp_1_battery",
    t2: "sensor.jkbms_gateway_bms_temp_2_battery",
    ttf: "sensor.battery_time_to_full",
    rtl: "sensor.battery_runtime_remaining",
    cc: "sensor.powmr_inverter_battery_charge_current",
    dc: "sensor.powmr_inverter_battery_discharge_current",
    iv: "sensor.powmr_inverter_battery_voltage_inverter",
    prio: "select.powmr_inverter_power_priority",
    swc: "switch.powmr_inverter_ac_charging_enabled",
    swd: "switch.powmr_inverter_bms_discharging_switch",
    swb: "switch.powmr_inverter_bms_balancer_switch",
  };
  const cell = (i) => "sensor.jkbms_gateway_bms_cell_" + i;

  function base(cells) {
    const st = {
      [E.soc]: S("55"), [E.cap]: S("140.123"), [E.v]: S("26.8"), [E.a]: S("0"), [E.w]: S("0"),
      [E.cmin]: S("3.349"), [E.cmax]: S("3.351"), [E.d]: S("0.002"), [E.t1]: S("25"), [E.t2]: S("26.5"),
      [E.ttf]: S("unknown"), [E.rtl]: S("unknown"), [E.cc]: S("0"), [E.dc]: S("0"), [E.iv]: S("26.9"),
      [E.prio]: S("SBU"),
      [E.swc]: S("on", { friendly_name: "AC charging" }),
      [E.swd]: S("on", { friendly_name: "Discharging" }),
      [E.swb]: S("on", { friendly_name: "Balancer" }),
    };
    (cells || [3.35, 3.35, 3.35, 3.35, 3.35, 3.35, 3.35, 3.35]).forEach((v, i) => {
      if (v !== undefined) st[cell(i + 1)] = S(v === null ? "unavailable" : String(v));
    });
    return st;
  }

  function mk(states, config) {
    const c = new Card();
    c.setConfig(config || {});
    const h = mkHass(states);
    c.hass = h;
    return { c: c, h: h, el: c._el };
  }
  function rerender(r, mutate) {
    const st = Object.assign({}, r.h.states);
    mutate(st);
    r.h.states = st;
    r.c.hass = Object.assign({}, r.h, { states: st });
  }

  group = "battery/config: ";
  {
    const c = new Card();
    eq("card size before config", c.getCardSize(), 40);
    c.setConfig({});
    eq("card size, all blocks", c.getCardSize(), 39);
    throws("cells empty", () => c.setConfig({ cells: [] }), /cells must be a non-empty list/);
    throws("cells not a list", () => c.setConfig({ cells: "sensor.a" }), /cells must be a non-empty list/);
    throws("cell not an entity", () => c.setConfig({ cells: ["sensor.a", "cell2"] }), /got cell2/);
    throws("cell not a string", () => c.setConfig({ cells: [7] }), /got 7/);
    throws("capacity 0", () => c.setConfig({ pack_capacity_ah: 0 }), /pack_capacity_ah/);
    throws("max current negative", () => c.setConfig({ max_current_a: -1 }), /max_current_a/);
    throws("max power text", () => c.setConfig({ max_power_w: "lots" }), /max_power_w/);
    throws("unknown block", () => c.setConfig({ blocks: ["pack", "solar"] }), /unknown block\(s\) solar/);
    throws("empty blocks", () => c.setConfig({ blocks: [] }), /non-empty/);
    throws("entity typo", () => c.setConfig({ soc: "soc" }), /soc must be an entity id/);
    throws("switch override typo", () => c.setConfig({ sw_balancer: "balancer" }), /sw_balancer/);
    c.setConfig({ pack_capacity_ah: "300" });
    eq("capacity string coerced", c._config.pack_capacity_ah, 300);
  }

  group = "battery/bands: ";
  {
    const c = new Card();
    c.setConfig({});
    [[null, "NO DATA"], [19.9, "CRITICAL"], [20, "MODERATE"], [69.9, "MODERATE"], [70, "NOMINAL"], [94.9, "NOMINAL"],
      [95, "FULL"]].forEach(([v, w]) => eq("_socLabel(" + v + ")", c._socLabel(v), w));
    eq("_socColor null", c._socColor(null), MUTED);
    [[null, "NO DATA"], [2.8999, "UNDERVOLTAGE"], [2.9, "LOW"], [3.0999, "LOW"], [3.1, "NOMINAL"], [3.5, "NOMINAL"],
      [3.5001, "HIGH"], [3.6, "HIGH"], [3.6001, "OVERVOLTAGE"]].forEach(([v, w]) => eq("_cellLabel(" + v + ")", c._cellLabel(v), w));
    [[null, MUTED], [2.89, BAD], [2.9, WARN], [3.1, OK], [3.5, OK], [3.55, WARN], [3.61, BAD]]
      .forEach(([v, w]) => eq("_cellColor(" + v + ")", c._cellColor(v), w));
    [[null, MUTED], [0, OK], [0.02, OK], [0.0201, WARN], [0.05, WARN], [0.0501, BAD]]
      .forEach(([v, w]) => eq("_deltaColor(" + v + ")", c._deltaColor(v), w));
    [[null, MUTED], [-0.1, BAD], [0, WARN], [9.9, WARN], [10, OK], [40, OK], [40.1, WARN], [50, WARN], [50.1, BAD]]
      .forEach(([v, w]) => eq("_tempColor(" + v + ")", c._tempColor(v), w));
    [[null, MUTED], [0, OK], [100, OK], [100.2, WARN], [-160, WARN], [-160.2, BAD], [500, BAD]]
      .forEach(([v, w]) => eq("_currentColor(" + v + ") of 200 A", c._currentColor(v), w));
    eq("_cellPct floor", c._cellPct(2.5), 0);
    eq("_cellPct ceiling", c._cellPct(4), 100);
    eq("_cellPct null", c._cellPct(null), 0);
    eq("_scale delta to mV", c._scale({ mul: 1000 }, 0.0123), 12.3);
    eq("_scale passthrough", c._scale({}, 5), 5);
    eq("_trackCss", c._trackCss([[20, "r"], [100, "g"]]), "linear-gradient(90deg,r 0.00% 20.00%,g 20.00% 100.00%)");
  }

  group = "battery/activity: ";
  {
    const c = new Card();
    c.setConfig({});
    const at = (w, d) => { c._hass = mkHass({ [E.w]: S(w), [E.d]: S(d) }); };
    at("2", "0"); eq("_dir 2 W idle", c._dir(), 0);
    at("2.1", "0"); eq("_dir charging", c._dir(), 1);
    at("-2.1", "0"); eq("_dir discharging", c._dir(), -1);
    at("unavailable", "0"); eq("_dir unknown is idle", c._dir(), 0);
    at("500", "0");
    eq("charge active", c._activity("charge", true), { color: OK, word: "charging now" });
    eq("discharge idle while charging", c._activity("discharge", true), null);
    eq("charge activity ignores the switch", c._activity("charge", false), { color: OK, word: "charging now" });
    at("-500", "0.0101");
    eq("discharge active", c._activity("discharge", true), { color: OK, word: "discharging now" });
    eq("balance off: nothing", c._activity("balance", false), null);
    eq("balance 10.1 mV", c._activity("balance", true), { color: OK, word: "balancing 10.1 mV spread" });
    at("0", "0.010");
    eq("balance exactly 10 mV waits", c._activity("balance", true), null);
    at("0", "0.0201");
    eq("balance past 20 mV turns amber", c._activity("balance", true), { color: WARN, word: "balancing 20.1 mV spread" });
    at("0", "unknown");
    eq("balance spread unknown", c._activity("balance", true), null);
    eq("unknown kind", c._activity("pv", true), null);
    eq("idle word off", c._idleWord("charge", false), "switched off");
    eq("idle word charge", c._idleWord("charge", true), "enabled, not charging");
    eq("idle word discharge", c._idleWord("discharge", true), "enabled, not discharging");
    eq("idle word balance unknown", c._idleWord("balance", true), "enabled, spread unknown");
    at("0", "0.004");
    eq("idle word balance level", c._idleWord("balance", true), "enabled, cells level (4.0 mV)");
    eq("idle word other", c._idleWord("pv", true), "enabled");
  }

  group = "battery/hours: ";
  {
    const c = new Card();
    c.setConfig({});
    const h = (s) => { c._hass = mkHass({ "sensor.h": S(s) }); return c._hours("sensor.h"); };
    eq("unknown is printed", h("unknown"), { text: "unknown", known: false });
    eq("unavailable is printed", h("unavailable"), { text: "unavailable", known: false });
    eq("garbage is a dash", h("soon"), { text: "—", known: false });
    eq("0", h("0"), { text: "0m", known: true });
    eq("under a minute", h("0.01"), { text: "0m", known: true });
    eq("30 min", h("0.5"), { text: "30m", known: true });
    eq("59.94 min rounds to 1h 0m", h("0.999"), { text: "1h 0m", known: true });
    eq("2.5 h", h("2.5"), { text: "2h 30m", known: true });
    eq("200 h", h("200"), { text: "200h 0m", known: true });
    eq("negative reads as 0m", h("-1"), { text: "0m", known: true });
    c._hass = mkHass({});
    eq("missing sensor is 'unknown'", c._hours("sensor.h"), { text: "unknown", known: false });

    eq("_clockAfter null", c._clockAfter(null), "");
    eq("_clockAfter NaN", c._clockAfter(NaN), "");
    eq("_clockAfter Infinity", c._clockAfter(Infinity), "");
    eq("_clockAfter negative", c._clockAfter(-1), "");
    eq("_clockAfter a year and a bit", c._clockAfter(24 * 365 + 1), "");
    check("_clockAfter 0 is a full stamp", /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(c._clockAfter(0)), c._clockAfter(0));
    const then = new Date(Date.now() + 1.5 * 3600000);
    const p = (n) => String(n).padStart(2, "0");
    const want = then.getFullYear() + "-" + p(then.getMonth() + 1) + "-" + p(then.getDate()) + " " + p(then.getHours()) + ":" + p(then.getMinutes());
    eq("_clockAfter 1.5 h", c._clockAfter(1.5), want);
  }

  group = "battery/meters: ";
  {
    const c = new Card();
    c.setConfig({});
    const m = c._meterSpecs();
    eq("amp ticks", m[1].ticks.map((t) => t[0]), ["−200", "−100", "0", "+100", "+200 A"]);
    eq("volt ticks for 8S", m[2].ticks.map((t) => t[0]), ["23.2", "24.8", "28.0", "28.8 V"]);
    c.setConfig({ max_current_a: 150, cells: [cell(1), cell(2), cell(3), cell(4)] });
    const m2 = c._meterSpecs();
    eq("amp ticks follow the ceiling", m2[1].ticks.map((t) => t[0]), ["−150", "−75", "0", "+75", "+150 A"]);
    eq("volt ticks for 4S", m2[2].ticks.map((t) => t[0]), ["11.6", "12.4", "14.0", "14.4 V"]);
  }

  group = "battery/render: ";
  {
    const r = mk(base());
    const el = r.el;
    check("built", r.c._built);
    eq("kicker", r.c.shadowRoot.querySelector(".kicker span").textContent, "LiFePO4 · 8S 280AH");
    eq("capacity meter", [el.mState0.textContent, el.mVal0.textContent, el.mUnit0.textContent], ["MODERATE", "55", "%"]);
    eq("capacity sub", el.mSub0.textContent, "140.123 / 280.000 Ah remaining");
    eq("capacity fill", el.mFill0.style.width, "55.00%");
    eq("current idle", [el.mState1.textContent, el.mVal1.textContent], ["IDLE", "0.00"]);
    eq("current idle sub drops the C-rate", el.mSub1.textContent, "idle · 0.0 W");
    eq("current fill empty at centre", [el.mFill1.style.left, el.mFill1.style.width], ["50.00%", "0.00%"]);
    eq("voltage meter", [el.mState2.textContent, el.mVal2.textContent], ["NOMINAL", "26.800"]);
    eq("voltage sub", el.mSub2.textContent, "3.350 V/cell · 8S · inverter reads 26.90 V");
    eq("bus idle", [el.busState.textContent, el.busIn.textContent, el.busOut.textContent], ["IDLE", "0.0", "0.0"]);
    eq("bus out sub idle", el.busOutSub.textContent, "W out · DC load idle");
    eq("bus sub", el.busSub.textContent, "sbu · AC charge");
    check("pack not lit while idle", !el.packCard.classList.contains("lit"));
    eq("pack sub", el.packSub.textContent, "8 cells in series · all within tolerance");
    eq("cell mean", el.cvMean.textContent, "3.3500 V");
    eq("min/max/delta", [el.cvMin.textContent, el.cvMax.textContent, el.cvDelta.textContent], ["3.349 V", "3.351 V", "2.0 mV"]);
    eq("level pack: 3 mV axis", [el.cvAxTop.textContent, el.cvAxBot.textContent], ["+3 mV", "−3 mV"]);
    eq("level pack: every bar at the 4% floor, one way", [el.cvUp0.style.height, el.cvDown0.style.height].sort(), ["0.00%", "4.00%"]);
    eq("timing unknown", [el.ttf.textContent, el.rtl.textContent, el.ttfAt.textContent, el.rtlAt.textContent],
      ["unknown", "unknown", "", ""]);
    eq("temps", [el.tVal0.textContent, el.tVal1.textContent], ["25.0 °C", "26.5 °C"]);
    eq("temp fill", el.tFill0.style.width, "41.67%");
    eq("temp colour", el.tVal0.style.color, OK);
    check("chips on", [0, 1, 2].every((i) => el["chip" + i].classList.contains("on")));
    check("no activity while idle and level", [0, 1, 2].every((i) => !el["dot" + i].classList.contains("live")));
    eq("charge chip title", el.chip0.title, "AC charging — on · enabled, not charging");
    eq("balancer chip title", el.chip2.title, "Balancer — on · enabled, cells level (2.0 mV)");
    eq("rails idle", [el.railBus.style._props["--play"], el.railPack.style._props["--play"]], ["paused", "paused"]);
  }

  group = "battery/flow: ";
  {
    const r = mk(Object.assign(base(), { [E.a]: S("-50"), [E.w]: S("-1300"), [E.dc]: S("48.5"), [E.rtl]: S("2.5"), [E.ttf]: S("3") }));
    const el = r.el;
    eq("discharging meter", [el.mState1.textContent, el.mState1.style.color], ["DIS", TXT2]);
    eq("discharging sub: magnitude and C-rate", el.mSub1.textContent, "discharging at 0.18 C · 1300.0 W");
    eq("discharging fill left of centre", [el.mFill1.style.left, el.mFill1.style.width], ["37.50%", "12.50%"]);
    eq("bus discharging", [el.busState.textContent, el.busIn.textContent, el.busOut.textContent], ["DISCHARGING", "0.0", "1300.0"]);
    eq("bus out colour", el.busOut.style.color, TXT);
    eq("inverter current shown", el.busOutSub.textContent, "W out · inverter 48.5 A");
    check("pack lit", el.packCard.classList.contains("lit"));
    eq("rails reversed", el.railBus.style._props["--dir"], "reverse");
    eq("runtime green while draining", el.rtl.style.color, OK);
    check("runtime clock shown", /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(el.rtlAt.textContent), el.rtlAt.textContent);
    eq("time to full grey while draining", el.ttf.style.color, MUTED);
    eq("no 'full at' clock while draining", el.ttfAt.textContent, "");
    eq("discharge chip lit", el.dot1.classList.contains("live"), true);
    eq("discharge chip title", el.chip1.title, "Discharging — on · discharging now");

    rerender(r, (s) => { s[E.a] = S("60"); s[E.w] = S("1600"); s[E.cc] = S("57"); });
    eq("charging meter", [el.mState1.textContent, el.mState1.style.color], ["CHG", OK]);
    eq("charging fill right of centre", [el.mFill1.style.left, el.mFill1.style.width], ["50.00%", "15.00%"]);
    eq("bus charging", [el.busState.textContent, el.busIn.textContent, el.busIn.style.color], ["CHARGING", "1600.0", OK]);
    eq("charge rail full speed", el.railPack.style._props["--dur"], "0.30s");
    eq("time to full green", el.ttf.style.color, OK);
    check("full-at clock shown", el.ttfAt.textContent !== "");
    eq("runtime clock hidden while charging", el.rtlAt.textContent, "");
    eq("charge chip lit", el.dot0.classList.contains("live"), true);
    eq("charge dot colour", el.dot0.style._props["--dc"], OK);

    rerender(r, (s) => { s[E.a] = S("300"); });
    eq("over-ceiling current clamps the fill", [el.mFill1.style.left, el.mFill1.style.width], ["50.00%", "50.00%"]);
    eq("over-ceiling current is red", el.mVal1.style.color, BAD);
    rerender(r, (s) => { s[E.a] = S("-999"); s[E.w] = S("-5000"); });
    eq("over-ceiling discharge clamps", [el.mFill1.style.left, el.mFill1.style.width], ["0.00%", "50.00%"]);

    rerender(r, (s) => { s[E.a] = S("unavailable"); s[E.w] = S("unavailable"); });
    eq("current unknown", [el.mState1.textContent, el.mVal1.textContent, el.mSub1.textContent],
      ["NO DATA", "—", "no reading · — W"]);
    eq("bus unknown", [el.busState.textContent, el.busIn.textContent, el.busOut.textContent], ["NO DATA", "—", "—"]);
    eq("rail idles with no reading", el.railBus.style._props["--play"], "paused");

    rerender(r, (s) => { s[E.swc] = S("off", { friendly_name: "AC charging" }); s[E.prio] = S("unavailable"); });
    eq("bus sub with charger off", el.busSub.textContent, "unavailable · AC charge off");
    eq("chip off title", el.chip0.title, "AC charging — off · switched off");
  }

  group = "battery/soc: ";
  {
    const r = mk(base());
    const el = r.el;
    [["100", "100", "100.00%", "FULL"], ["0", "0", "0.00%", "CRITICAL"], ["120", "120", "100.00%", "FULL"],
      ["-5", "-5", "0.00%", "CRITICAL"], ["unknown", "—", "0.00%", "NO DATA"], ["NaN", "—", "0.00%", "NO DATA"]]
      .forEach(([s, val, w, word]) => {
        rerender(r, (st) => { st[E.soc] = S(s); });
        eq("soc " + s, [el.mVal0.textContent, el.mFill0.style.width, el.mState0.textContent], [val, w, word]);
      });
    rerender(r, (st) => { st[E.cap] = S("unavailable"); });
    eq("capacity unknown", el.mSub0.textContent, "— / 280.000 Ah remaining");

    const c = r.c;
    c._hass = mkHass({ [E.cap]: S("28"), [E.v]: S("29.0") });
    eq("cap band from capacity/nameplate (10 %)", c._seriesColor({ band: "cap" }), BAD);
    eq("pack band per cell (3.625 V)", c._seriesColor({ band: "pack" }), BAD);
    c._hass = mkHass({});
    eq("bands with nothing known", [c._seriesColor({ band: "cap" }), c._seriesColor({ band: "pack" }),
      c._seriesColor({ band: "delta" }), c._seriesColor({ band: "temp", cfg: "temp_1" })], [MUTED, MUTED, MUTED, MUTED]);
    eq("no band keeps its colour", c._seriesColor({ color: "#123" }), "#123");
  }

  group = "battery/cells: ";
  {
    // One cell 200 mV high: the median holds, only that one is out.
    let r = mk(Object.assign(base([3.30, 3.30, 3.30, 3.50, 3.30, 3.30, 3.30, 3.30]), { [E.d]: S("0.2") }));
    let el = r.el;
    eq("one outlier: one cell out", el.packSub.textContent, "8 cells in series · 1 cell out of tolerance");
    eq("outlier bar is amber (in band but drifting)", el.pcell3.style.background, WARN);
    eq("neighbours stay green", el.pcell0.style.background, OK);
    eq("mean dragged up", el.cvMean.textContent, "3.3250 V");
    eq("deviation axis 200 mV", el.cvAxTop.textContent, "+200 mV");
    eq("outlier bar up", [el.cvUp3.style.height, el.cvDown3.style.height], ["87.50%", "0.00%"]);
    eq("others below the mean, down", [el.cvUp0.style.height, el.cvDown0.style.height], ["0.00%", "12.50%"]);
    eq("outlier volt label amber", el.cvVolt3.style.color, WARN);
    eq("green label prints in text colour", el.cvVolt0.style.color, TXT);
    eq("delta red", [el.cvDelta.textContent, el.cvDelta.style.color], ["200.0 mV", BAD]);
    eq("balancer amber", [el.dot2.classList.contains("live"), el.dot2.style._props["--dc"]], [true, WARN]);
    eq("cell tooltip", el.pcellWrap3.title, "C4 — 3.500 V");

    // Out of band entirely.
    r = mk(base([3.30, 3.30, 3.30, 3.70, 3.30, 3.30, 2.85, 3.30]));
    el = r.el;
    eq("over and under: two out", el.packSub.textContent, "8 cells in series · 2 cells out of tolerance");
    eq("overvoltage bar red", el.pcell3.style.background, BAD);
    eq("bar height clamps", el.pcell3.style.height, "100.00%");

    // Missing cells are not failures.
    r = mk(base([3.30, 3.30, null, 3.30, 3.30, 3.30, 3.30, 3.30]));
    el = r.el;
    eq("an unavailable cell is not counted", el.packSub.textContent, "8 cells in series · all within tolerance");
    eq("its tooltip", el.pcellWrap2.title, "C3 — — V");
    eq("its bars are empty and muted", [el.cvUp2.style.height, el.cvDown2.style.height, el.cvUp2.style.background],
      ["0.00%", "0.00%", MUTED]);
    eq("its label", el.cvVolt2.textContent, "—");
    eq("its pack bar", [el.pcell2.style.height, el.pcell2.style.background], ["0.00%", MUTED]);

    r = mk(base([null, null, null, null, null, null, null, null]));
    el = r.el;
    eq("no cells at all", el.packSub.textContent, "8 cells in series · no cell data");
    eq("no mean", el.cvMean.textContent, "— V");
    eq("axis falls back to 3 mV", el.cvAxTop.textContent, "+3 mV");

    // Even count median, two drifting the same way.
    r = mk(base([3.30, 3.30, 3.30, 3.30, 3.30, 3.30, 3.33, 3.33]));
    eq("two at +30 mV: two out", r.el.packSub.textContent, "8 cells in series · 2 cells out of tolerance");
    r = mk(base([3.30, 3.30, 3.30, 3.30, 3.30, 3.30, 3.30, 3.321]));
    eq("21 mV is out", r.el.packSub.textContent, "8 cells in series · 1 cell out of tolerance");
    r = mk(base([3.30, 3.30, 3.30, 3.30, 3.30, 3.30, 3.30, 3.319]));
    eq("19 mV is within", r.el.packSub.textContent, "8 cells in series · all within tolerance");
    r = mk(Object.assign(base([3.30, 3.30, 3.30, 3.30, 3.30, 3.30, 3.30, 3.32]), { [E.d]: S("0.02") }));
    eq("the delta reading itself calls 20 mV OK", r.el.cvDelta.style.color, OK);
    eq("a cell exactly 20 mV from the median is within tolerance, as _deltaColor treats 20 mV",
      r.el.packSub.textContent, "8 cells in series · all within tolerance");

    // Float noise: a 3 mV spread must not jump to the 5 mV axis.
    r = mk(base([3.358, 3.358, 3.358, 3.358, 3.364, 3.364, 3.364, 3.364]));
    eq("a 3 mV spread with float noise keeps the 3 mV axis", r.el.cvAxTop.textContent, "+3 mV");
    eq("...and draws full height", r.el.cvUp7.style.height, "100.00%");
    r = mk(base([3.30, 3.30, 3.30, 3.30, 3.30, 3.30, 3.30, 3.308]));
    eq("7 mV spread -> 10 mV axis", r.el.cvAxTop.textContent, "+10 mV");
    r = mk(base([2.5, 3.65, 3.3, 3.3, 3.3, 3.3, 3.3, 3.3]));
    eq("over 500 mV -> 1000 mV axis", r.el.cvAxTop.textContent, "+1000 mV");
    r = mk(base([0.5, 3.65, 3.3, 3.3, 3.3, 3.3, 3.3, 3.3]));
    eq("past the last stop the axis stays at 1000", r.el.cvAxTop.textContent, "+1000 mV");
    eq("...and the bar clamps at 100 %", r.el.cvDown0.style.height, "100.00%");

    // A 4-cell pack: everything sizes from the list.
    const four = [cell(1), cell(2), cell(3), cell(4)];
    r = mk(Object.assign(base([3.3, 3.3, 3.3, 3.3]), { [E.v]: S("13.2") }), { cells: four });
    eq("4S kicker", r.c.shadowRoot.querySelector(".kicker span").textContent, "LiFePO4 · 4S 280AH");
    eq("4S sub", r.el.packSub.textContent, "4 cells in series · all within tolerance");
    eq("4S per-cell volts", r.el.mSub2.textContent, "3.300 V/cell · 4S · inverter reads 26.90 V");
    check("4S has no fifth bar", !r.el.pcell4 && !!r.el.pcell3);
    // A cell list naming entities that do not exist.
    r = mk(base(), { cells: ["sensor.nope_1", "sensor.nope_2"] });
    eq("cells that do not exist", r.el.packSub.textContent, "2 cells in series · no cell data");
  }

  group = "battery/temps: ";
  {
    const r = mk(base());
    const t = (v) => { rerender(r, (s) => { s[E.t1] = S(v); }); return [r.el.tVal0.textContent, r.el.tFill0.style.width, r.el.tVal0.style.color]; };
    eq("freezing", t("-5"), ["-5.0 °C", "0.00%", BAD]);
    eq("0 °C", t("0"), ["0.0 °C", "0.00%", WARN]);
    eq("hot", t("70"), ["70.0 °C", "100.00%", BAD]);
    eq("unknown", t("unavailable"), ["— °C", "0.00%", MUTED]);
  }

  group = "battery/click: ";
  {
    const r = mk(base());
    fire(r.el.chip2.querySelector(".ic"), "click");
    eq("balancer toggle", r.h.calls.pop(), ["switch", "toggle", { entity_id: E.swb }]);
    fire(r.el.dot0, "click");
    eq("inner dot reaches the toggle", r.h.calls.pop(), ["switch", "toggle", { entity_id: E.swc }]);
    fire(r.el.chip1.querySelector(".lbl"), "click");
    eq("label opens more-info", r.c.dispatched.pop().detail.entityId, E.swd);
    fire(r.el.pcell5, "click");
    eq("pack cell opens its sensor", r.c.dispatched.pop().detail.entityId, cell(6));
    fire(r.el.mVal0, "click");
    eq("capacity meter opens SOC", r.c.dispatched.pop().detail.entityId, E.soc);
    fire(r.el.cvDelta, "click");
    eq("delta opens the delta sensor", r.c.dispatched.pop().detail.entityId, E.d);
    fire(r.el.ranges.querySelector('[data-val="7d"]'), "click");
    eq("range", r.c._range, "7d");
    fire(r.el.tabs.querySelector('[data-val="delta"]'), "click");
    eq("tab", [r.c._sel, r.el.chName.textContent], ["delta", "Cell Delta"]);

    const r2 = mk(Object.assign(base(), { "input_boolean.my_charge": S("on") }), { sw_charge: "input_boolean.my_charge" });
    fire(r2.el.chip0.querySelector(".ic"), "click");
    eq("an override toggles through switch.toggle regardless of its domain (by design today)",
      r2.h.calls.pop(), ["switch", "toggle", { entity_id: "input_boolean.my_charge" }]);
  }

  group = "battery/unknown: ";
  for (const variant of ["empty states", "all unavailable"]) {
    let st = {};
    if (variant === "all unavailable") {
      st = base();
      Object.keys(st).forEach((k) => { st[k] = S("unavailable", {}); });
    }
    let r;
    noThrow(variant + ": renders", () => { r = mk(st); });
    if (!r) continue;
    const el = r.el;
    const v = variant + ": ";
    eq(v + "capacity", [el.mState0.textContent, el.mVal0.textContent, el.mFill0.style.width], ["NO DATA", "—", "0.00%"]);
    eq(v + "current", el.mState1.textContent, "NO DATA");
    eq(v + "voltage", [el.mState2.textContent, el.mVal2.textContent, el.mSub2.textContent],
      ["NO DATA", "—", "— V/cell · 8S · inverter reads — V"]);
    eq(v + "pack sub", el.packSub.textContent, "8 cells in series · no cell data");
    eq(v + "delta", el.cvDelta.textContent, "—");
    eq(v + "timing", [el.ttf.textContent, el.rtl.textContent], variant === "empty states" ? ["unknown", "unknown"] : ["unavailable", "unavailable"]);
    eq(v + "temps", el.tVal1.textContent, "— °C");
    check(v + "chips off", [0, 1, 2].every((i) => !el["chip" + i].classList.contains("on")));
    eq(v + "balancer title", el.chip2.title, "Balancer — " + (variant === "empty states" ? "unknown" : "unavailable") + " · switched off");
  }

  group = "battery/blocks: ";
  {
    let r = mk(base(), { blocks: ["switches"] });
    check("switches without header: chips, no clock", !!r.el.chip0 && !r.el.clock);
    r = mk(base(), { blocks: ["header"] });
    check("header without switches: clock, no chips", !!r.el.clock && !r.el.chip0);
    r = mk(base(), { blocks: ["cells", "temps"] });
    check("cells + temps", !!r.el.cvMean && !!r.el.tVal0 && !r.el.busIn);
    r = mk(base(), { blocks: ["timing"] });
    check("a whole side missing: one column", r.c.shadowRoot.querySelector(".cols").classList.contains("one"));
    r = mk(base(), { blocks: ["flow", "timing"] });
    check("both sides: two columns", !r.c.shadowRoot.querySelector(".cols").classList.contains("one"));
    r = mk(base(), { blocks: ["pack"] });
    eq("pack only patches", r.el.mVal0.textContent, "55");

    await flush();
    takeUnhandled();
    r = mk(base());
    r.c.setConfig({ blocks: ["pack"] });
    check("re-config rebuilds", !!r.c._el.mVal0 && !r.c._el.chLine);
    await flush();
    const u = takeUnhandled();
    check("re-config to a layout without history while a history fetch is in flight does not throw",
      u.length === 0, u.length ? "unhandled rejection: " + (u[0] && u[0].message) : "");
  }

  group = "battery/fingerprint: ";
  {
    const r = mk(base());
    r.el.mVal0.textContent = "SENTINEL";
    rerender(r, (s) => { s["sensor.unrelated"] = S("1"); });
    eq("unrelated change: no re-patch", r.el.mVal0.textContent, "SENTINEL");
    rerender(r, (s) => { s[cell(3)] = S("3.36"); });
    eq("a cell change re-patches", r.el.mVal0.textContent, "55");
  }
}

/* ========================================================================== */
/* 3. load-shedding-card.js                                                   */
/* ========================================================================== */

async function loadSheddingSuite() {
  const L = loadCard("load-shedding-card.js");
  const Card = L.Card;
  const SHARED = L.sandbox.window.__loadSheddingShared;
  const reset = () => { SHARED.draft = null; SHARED.error = ""; SHARED.saving = false; SHARED.subs.clear(); };

  const E = {
    cfg: "sensor.load_shedding_config",
    state: "sensor.load_shedding",
    master: "input_boolean.load_shedding_enabled",
    soc: "sensor.jkbms_gateway_bms_state_of_charge",
    rt: "sensor.battery_runtime_remaining",
    grid: "binary_sensor.powmr_inverter_grid_condition_safe",
  };
  const AC = "climate.hall_ac";
  const BOILER = "switch.boiler";
  const LAMP = "light.desk";

  const SERVICES = {
    climate: {
      turn_off: { fields: {} },
      turn_on: { fields: {} },
      set_temperature: { fields: {
        temperature: { required: true, selector: { number: { min: 16, max: 30, step: 0.5, unit_of_measurement: "°C" } } },
        hvac_mode: { selector: { state: { attribute: "hvac_mode" } } },
        advanced_fields: { collapsed: true, fields: {
          target_temp_high: { selector: { number: {} } },
        } },
      } },
      set_hvac_mode: { fields: { hvac_mode: { required: true, selector: { state: {} } } } },
      set_fan_mode: { fields: { fan_mode: { required: true, selector: { state: {} } } } },
      reload: {},
      toggle: {},
    },
    switch: { turn_on: {}, turn_off: {}, toggle: {} },
    light: {
      turn_on: { fields: {
        brightness_pct: { selector: { number: { min: 0, max: 100, unit_of_measurement: "%" } } },
        rgb_color: { selector: { color_rgb: {} } },
        effect: { selector: { state: {} }, filter: { supported_features: [4] } },
        flash: { selector: { select: { options: ["short", { value: "long", label: "Long flash" }] } } },
        transition: { advanced: true, selector: { number: {} } },
        profile: { selector: { text: {} } },
        white: { selector: { constant: { value: true } } },
        kelvin: { selector: { color_temp: {} }, filter: { attribute: { supported_color_modes: ["color_temp"] } } },
        on: { selector: { boolean: {} } },
      } },
      turn_off: {},
      toggle: {},
    },
  };

  function rulesAttr(devices, extra) {
    return Object.assign({ override_step: 10, warn_margin: 1, devices: devices }, extra || {});
  }

  function dev(id, entity, steps, extra) {
    return Object.assign({ id: id, name: id.toUpperCase(), entity: entity, enabled: true, steps: steps }, extra || {});
  }

  function states(o) {
    o = o || {};
    return withIds(Object.assign({
      [E.cfg]: S("ok", rulesAttr(o.devices || [], o.rulesExtra)),
      [E.state]: S("0", { loads: o.loads || {} }),
      [E.master]: S(o.master || "on"),
      [E.soc]: S(o.soc === undefined ? "60" : o.soc),
      [E.rt]: S(o.rt === undefined ? "2.5" : o.rt),
      [E.grid]: S(o.grid || "off"),
      [AC]: S("cool", { friendly_name: "Hall A/C", temperature: 24, hvac_modes: ["off", "cool", "heat", "fan_only"],
        fan_modes: ["auto", "low"] }),
      [BOILER]: S("on", { friendly_name: "Boiler" }),
      [LAMP]: S("on", { friendly_name: "Desk lamp", brightness: 255, supported_features: 4, effect_list: ["rainbow"],
        supported_color_modes: ["rgb"] }),
      "sensor.outdoor": S("12"),
      "binary_sensor.ac_running": S("on"),
      "switch.ac_plug": S("on"),
    }, o.extra || {}));
  }

  function mk(st, config, hassOpts) {
    reset();
    const c = new Card();
    c.setConfig(config || {});
    c.connectedCallback();
    const h = mkHass(st, Object.assign({ services: SERVICES }, hassOpts || {}));
    c.hass = h;
    const root = c.shadowRoot;
    return {
      c: c, h: h, root: root,
      q: (s) => root.querySelector(s),
      qa: (s) => root.querySelectorAll(s),
      text: () => root.textContent.replace(/\s+/g, " "),
    };
  }

  group = "shed/config: ";
  {
    const c = new Card();
    eq("size before config", c.getCardSize(), 20);
    c.setConfig({});
    eq("size, all blocks", c.getCardSize(), 25);
    c.setConfig({ blocks: ["upcoming"] });
    eq("size, upcoming", c.getCardSize(), 4);
    throws("empty blocks", () => c.setConfig({ blocks: [] }), /non-empty list/);
    throws("unknown block", () => c.setConfig({ blocks: ["hero", "graph"] }), /non-empty list/);
    throws("blocks not a list", () => c.setConfig({ blocks: "hero" }), /non-empty list/);
    noThrow("null config", () => c.setConfig(null));
    eq("stub config", Card.getStubConfig(), {});
  }

  group = "shed/stored: ";
  {
    const c = new Card();
    c.setConfig({});
    c._hass = mkHass({});
    eq("no config sensor", c._stored(), { override_step: 10, warn_margin: 1, devices: [] });
    c._hass = mkHass({ [E.cfg]: S("x", { override_step: "15", warn_margin: 0, devices: "nope" }) });
    eq("strings coerced, 0 margin kept, bad devices dropped", c._stored(), { override_step: 15, warn_margin: 0, devices: [] });
    c._hass = mkHass({ [E.cfg]: S("x", { override_step: "abc", warn_margin: null }) });
    eq("non-numeric step falls back; null margin is 0", c._stored(), { override_step: 10, warn_margin: 0, devices: [] });
    c._hass = mkHass({ [E.state]: S("x", { loads: "nope" }) });
    eq("_shed with a non-object", c._shed(), {});
    c._hass = mkHass({});
    eq("_shed with no sensor", c._shed(), {});
    eq("_num unknown", c._num(E.soc), null);
  }

  group = "shed/services: ";
  {
    const c = new Card();
    c.setConfig({});
    c._hass = mkHass({}, { services: SERVICES });
    eq("climate order: off, on, adjust, then a-z; reload/toggle hidden", c._services("climate").map((s) => s.action),
      ["climate.turn_off", "climate.turn_on", "climate.adjust_temperature", "climate.set_fan_mode",
        "climate.set_hvac_mode", "climate.set_temperature"]);
    eq("names from the service id", c._services("climate").map((s) => s.name).slice(0, 4),
      ["Turn off", "Turn on", "Change temperature by", "Set fan mode"]);
    eq("switch", c._services("switch").map((s) => s.action), ["switch.turn_off", "switch.turn_on"]);
    eq("unknown domain", c._services("vacuum"), []);
    c._hass = mkHass({}, { services: { climate: { set_temperature: {} } } });
    eq("climate with one service: adjust goes after it", c._services("climate").map((s) => s.action),
      ["climate.set_temperature", "climate.adjust_temperature"]);
    c._hass = mkHass({}, { services: {} });
    eq("climate with no services: adjust alone", c._services("climate").map((s) => s.action), ["climate.adjust_temperature"]);
    c._hass = { states: {} };
    eq("no services map at all", c._services("switch"), []);
    c._hass = mkHass({}, { services: SERVICES, localize: (k) => (k === "component.switch.services.turn_off.name" ? "Localized turn off" : "") });
    eq("localized name wins", c._services("switch")[0].name, "Localized turn off");
    eq("field name falls back", c._fieldName("light", "turn_on", "brightness_pct"), "brightness pct");
  }

  group = "shed/fields: ";
  {
    const c = new Card();
    c.setConfig({});
    const f = c._fields(SERVICES.climate.set_temperature);
    eq("sections flattened", f.map((x) => x.key), ["temperature", "hvac_mode", "target_temp_high"]);
    eq("collapsed section is advanced", f.map((x) => x.adv), [false, false, true]);
    eq("advanced flag", c._fields(SERVICES.light.turn_on).filter((x) => x.adv).map((x) => x.key), ["transition"]);
    eq("no def", c._fields(undefined), []);
    eq("a null field", c._fields({ fields: { x: null } }), [{ key: "x", f: {}, adv: false }]);

    c._hass = mkHass(states());
    eq("no filter", c._supports(LAMP, {}), true);
    eq("missing entity passes", c._supports("light.nope", { filter: { supported_features: [4] } }), true);
    eq("feature bit present", c._supports(LAMP, { filter: { supported_features: [4] } }), true);
    eq("feature bit absent", c._supports(LAMP, { filter: { supported_features: [16] } }), false);
    eq("any of several bits", c._supports(LAMP, { filter: { supported_features: [16, 4] } }), true);
    eq("combined bits need all", c._supports(LAMP, { filter: { supported_features: [5] } }), false);
    eq("attribute list match", c._supports(LAMP, { filter: { attribute: { supported_color_modes: ["rgb", "hs"] } } }), true);
    eq("attribute list miss", c._supports(LAMP, { filter: { attribute: { supported_color_modes: ["color_temp"] } } }), false);
    eq("scalar attribute", c._supports(AC, { filter: { attribute: { temperature: [24] } } }), true);
    eq("missing attribute", c._supports(AC, { filter: { attribute: { swing_modes: ["on"] } } }), false);
  }

  group = "shed/parseField: ";
  {
    const c = new Card();
    const inp = (type, value, checked) => {
      const e = new Element("input");
      e.setAttribute("data-type", type);
      e.value = value;
      if (checked !== undefined) e.checked = checked;
      return e;
    };
    eq("boolean on", c._parseField(inp("boolean", "", true)), true);
    eq("boolean off", c._parseField(inp("boolean", "", false)), false);
    eq("empty is unset", c._parseField(inp("number", "")), undefined);
    eq("number", c._parseField(inp("number", "21.5")), 21.5);
    eq("bad number is unset", c._parseField(inp("number", "abc")), undefined);
    eq("negative number", c._parseField(inp("number", "-2")), -2);
    eq("rgb", c._parseField(inp("rgb", "255, 120,0")), [255, 120, 0]);
    eq("rgb with two parts", c._parseField(inp("rgb", "1,2")), undefined);
    eq("rgb with junk", c._parseField(inp("rgb", "1,x,3")), undefined);
    eq("json object", c._parseField(inp("json", '{"a":1}')), { a: 1 });
    eq("bad json stays text", c._parseField(inp("json", "{a")), "{a");
    eq("text", c._parseField(inp("text", "hi")), "hi");
  }

  group = "shed/problems: ";
  {
    const c = new Card();
    const p = (steps) => c._problems({ devices: [{ name: "AC", steps: steps }] });
    eq("fine", p([{ soc: 50, action: "x" }, { soc: 30, action: "y" }]), []);
    eq("null soc", p([{ soc: null, action: "x" }]), ["AC: step 1 needs a battery % of 1-100"]);
    eq("empty soc", p([{ soc: "", action: "x" }]), ["AC: step 1 needs a battery % of 1-100"]);
    eq("text soc", p([{ soc: "abc", action: "x" }]), ["AC: step 1 needs a battery % of 1-100"]);
    eq("0", p([{ soc: 0, action: "x" }]), ["AC: step 1 needs a battery % of 1-100"]);
    eq("101", p([{ soc: 101, action: "x" }]), ["AC: step 1 needs a battery % of 1-100"]);
    eq("1 and 100 are fine", p([{ soc: 1, action: "x" }, { soc: 100, action: "y" }]), []);
    eq("duplicate across types", p([{ soc: "50", action: "x" }, { soc: 50, action: "y" }]), ["AC: two steps at 50%"]);
    eq("no action", p([{ soc: 40 }]), ["AC: step 1 needs an action"]);
    eq("both on one step", p([{ soc: 0 }]), ["AC: step 1 needs a battery % of 1-100", "AC: step 1 needs an action"]);
    eq("no steps key", c._problems({ devices: [{ name: "AC" }] }), []);
  }

  group = "shed/marks: ";
  {
    const c = new Card();
    const rules = { devices: [
      dev("ac", AC, [{ soc: 80 }, { soc: 50 }, { soc: "x" }]),
      dev("boiler", BOILER, [{ soc: 60 }], { enabled: false }),
      dev("lamp", LAMP, [{ soc: 70 }]),
    ] };
    eq("enabled, numeric, sorted high first", c._marks(rules, {}).map((m) => [m.name, m.soc, m.done]),
      [["AC", 80, false], ["LAMP", 70, false], ["AC", 50, false]]);
    eq("done at and above the applied step", c._marks(rules, { ac: { step_soc: 50 } }).filter((m) => m.done).map((m) => m.soc), [80, 50]);
  }

  group = "shed/upcoming: ";
  {
    const steps = [{ soc: 80, action: "climate.turn_off" }, { soc: 50, action: "climate.set_temperature", data: { temperature: 28 } },
      { soc: 30, action: "climate.turn_off" }];
    const up = (o) => {
      const r = mk(states(o));
      return r.c._upcoming();
    };
    let rows = up({ soc: "60", devices: [dev("ac", AC, steps)] });
    eq("next is the highest step below the battery", [rows[0].next.at, rows[0].away, rows[0].soon], [50, 10, false]);
    rows = up({ soc: "51", devices: [dev("ac", AC, steps)] });
    eq("1 % away inside the margin: soon", [rows[0].away, rows[0].soon], [1, true]);
    rows = up({ soc: "51", rulesExtra: { warn_margin: 0 }, devices: [dev("ac", AC, steps)] });
    eq("margin 0: never soon", rows[0].soon, false);
    rows = up({ soc: "51", devices: [dev("ac", AC, steps)], extra: { [AC]: S("off") } });
    eq("device off: not soon, not on", [rows[0].on, rows[0].soon], [false, false]);
    rows = up({ soc: "51", devices: [dev("ac", AC, steps, { guard: { running: "binary_sensor.ac_running" } })], extra: { [AC]: S("off") } });
    eq("off but its running sensor says on: on", rows[0].on, true);
    rows = up({ soc: "51", devices: [dev("ac", AC, steps)], extra: { [AC]: S("unavailable") } });
    eq("unavailable counts as off", rows[0].on, false);
    rows = up({ soc: "45", devices: [dev("ac", AC, steps)], loads: { ac: { step_soc: 50 } } });
    eq("applied 50: next is 30", [rows[0].applied, rows[0].next.at], [true, 30]);
    rows = up({ soc: "25", devices: [dev("ac", AC, steps)], loads: { ac: { step_soc: 30 } } });
    eq("deepest applied: nothing next", [rows[0].next, rows[0].away], [null, null]);
    rows = up({ soc: "45", devices: [dev("ac", AC, steps)], loads: { ac: { override_soc: 48, step_soc: 50 } } });
    eq("held at 48, step 10: fires at 38, landing on 50", [rows[0].held, rows[0].next.at, rows[0].next.step.soc, rows[0].away], [true, 38, 50, 7]);
    rows = up({ soc: "45", rulesExtra: { override_step: 5 }, devices: [dev("ac", AC, steps)], loads: { ac: { override_soc: 48 } } });
    eq("override_step 5", rows[0].next.at, 43);
    rows = up({ soc: "unknown", devices: [dev("ac", AC, steps)] });
    eq("battery unknown: highest step, no distance", [rows[0].next.at, rows[0].away, rows[0].soon], [80, null, false]);
    rows = up({ soc: "20", devices: [dev("ac", AC, steps)] });
    eq("below every step, none applied yet: nothing upcoming", [rows[0].next, rows[0].away], [null, null]);
    rows = up({ devices: [dev("ac", AC, steps, { enabled: false }), dev("boiler", BOILER, []), dev("lamp", LAMP, [{ soc: 55, action: "light.turn_off" }])] });
    eq("disabled and stepless devices are left out", rows.map((x) => x.d.id), ["lamp"]);
    rows = up({ soc: "60", devices: [dev("ac", AC, steps), dev("lamp", LAMP, [{ soc: 58, action: "light.turn_off" }]),
      dev("boiler", BOILER, [{ soc: 90, action: "switch.turn_off" }])], loads: { boiler: { step_soc: 90 } } });
    eq("closest first, nothing-left last", rows.map((x) => x.d.id), ["lamp", "ac", "boiler"]);
    rows = up({ soc: "60", devices: [dev("ac", AC, [{ soc: "abc", action: "x" }, { soc: 40, action: "climate.turn_off" }])] });
    eq("non-numeric steps skipped", rows[0].next.at, 40);
  }

  group = "shed/labels: ";
  {
    const r = mk(states());
    const c = r.c;
    eq("no step", c._stepLabel(dev("ac", AC, []), null), "deepest step reached");
    eq("adjust", c._stepLabel(dev("ac", AC, []), { action: "climate.adjust_temperature", data: { by: -2 } }), "Change temperature by (by -2)");
    eq("service with data", c._stepLabel(dev("ac", AC, []), { action: "climate.set_temperature", data: { temperature: 28, hvac_mode: "cool" } }),
      "Set temperature (temperature 28, hvac mode cool)");
    eq("no action", c._stepLabel(dev("ac", AC, []), {}), "");
  }

  group = "shed/status: ";
  {
    const st = (o, d) => mk(states(o)).c._status(d);
    eq("missing entity", st({}, dev("x", "switch.gone", [])), { cls: "bad", text: "entity not found" });
    eq("held", st({ loads: { ac: { override_soc: 48 } } }, dev("ac", AC, [{ soc: 50 }])),
      { cls: "warn", text: "changed back by you · steps down again at 38 %" });
    const since = localIso(14, 5);
    eq("applied", st({ loads: { ac: { step_soc: 50, since: since, soc: 49, plug_cut: true } } }, dev("ac", AC, [{ soc: 50 }])),
      { cls: "bad", text: "at its 50 % step since " + hm(since) + " (battery 49 %) · plug cut · back when the grid returns" });
    eq("applied, bad since", st({ loads: { ac: { step_soc: 50, since: "?", soc: 49 } } }, dev("ac", AC, [{ soc: 50 }])).text,
      "at its 50 % step since  (battery 49 %) · back when the grid returns");
    eq("climate with setpoint", st({}, dev("ac", AC, [{ soc: 50 }])), { cls: "", text: "cool · 24°" });
    eq("climate off hides setpoint", st({ extra: { [AC]: S("off", { temperature: 24 }) } }, dev("ac", AC, [{ soc: 50 }])).text, "off");
    eq("light brightness", st({}, dev("lamp", LAMP, [{ soc: 50 }])).text, "on · 100 %");
    eq("percentage", st({ extra: { "fan.x": S("on", { percentage: 33 }) } }, dev("f", "fan.x", [{ soc: 50 }])).text, "on · 33 %");
    eq("disabled", st({}, dev("b", BOILER, [{ soc: 50 }], { enabled: false })), { cls: "dim", text: "on · disabled" });
    eq("no steps", st({}, dev("b", BOILER, [])), { cls: "dim", text: "on · no steps yet" });
  }

  group = "shed/hero: ";
  {
    let r = mk(states({ master: "off" }), { blocks: ["hero"] });
    eq("off", r.q("h1").textContent, "Off");
    check("off: switch not on", !r.q(".sw").classList.contains("on"));
    eq("off: arm label", r.q(".arm span").textContent, "Rules off");
    r = mk(states({ grid: "on" }), { blocks: ["hero"] });
    eq("grid down: armed", r.q("h1").textContent, "Armed");
    eq("grid tile", r.qa(".tile .v")[1].textContent, "down");
    r = mk(states({ grid: "off", devices: [dev("ac", AC, [{ soc: 80, action: "x" }]), dev("lamp", LAMP, [{ soc: 40, action: "x" }])],
      loads: { ac: { step_soc: 80 } } }), { blocks: ["hero"] });
    eq("grid up: standing by", r.q("h1").textContent, "Standing by");
    eq("tiles", r.qa(".tile .v").map((n) => n.textContent.trim()), ["60%", "up", "2.5 h", "1 / 2"]);
    eq("bar fill", r.q(".bar .fill").style.getPropertyValue("width"), "60%");
    eq("marks", r.qa(".mark").map((m) => [m.style.getPropertyValue("left"), m.classList.contains("done"), m.textContent.trim()]),
      [["80%", true, "AC · 80%"], ["40%", false, "LAMP · 40%"]]);
    check("alternate marks stagger", r.qa(".mark")[1].classList.contains("alt"));
    r = mk(states({ soc: "unknown", rt: "unavailable" }), { blocks: ["hero"] });
    eq("unknowns", r.qa(".tile .v").map((n) => n.textContent.trim()).slice(0, 3), ["—", "up", "—"]);
    check("runtime dimmed", r.qa(".tile .v")[2].classList.contains("dim"));
    eq("unknown battery: empty bar", r.q(".bar .fill").style.getPropertyValue("width"), "0%");
    r = mk(states({ soc: "104" }), { blocks: ["hero"] });
    eq("SOC over 100: bar clamps full", r.q(".bar .fill").style.getPropertyValue("width"), "100%");
    r = mk(states({ soc: "0" }), { blocks: ["hero"] });
    eq("0 %", r.qa(".tile .v")[0].textContent, "0%");
    r = mk(states({ soc: "99.6" }), { blocks: ["hero"] });
    eq("rounded", r.qa(".tile .v")[0].textContent, "100%");
    fire(r.q(".sw"), "click");
    eq("master toggle", r.h.calls.pop(), ["input_boolean", "toggle", { entity_id: E.master }]);
  }

  group = "shed/upcoming-html: ";
  {
    const steps = [{ soc: 50, action: "climate.set_temperature", data: { temperature: 28 } }, { soc: 30, action: "climate.turn_off" }];
    let r = mk(states({ grid: "off", soc: "51", devices: [dev("ac", AC, steps)] }), { blocks: ["upcoming"] });
    eq("grid up note", r.q(".blurb").textContent, "The grid is up, so nothing will step down. Keep on and Put back work during an outage.");
    let row = r.q("tbody tr");
    check("soon row highlighted", row.classList.contains("soon"));
    eq("cells", row.querySelectorAll("td").map((td) => td.textContent.replace(/\s+/g, " ").trim()),
      ["AC", "Set temperature (temperature 28)", "50%", "1%", "about to step down", "Keep on"]);
    check("Keep on disabled while the grid is up", row.querySelector("button").disabled);
    r = mk(states({ grid: "on", soc: "51", devices: [dev("ac", AC, steps)] }), { blocks: ["upcoming"] });
    row = r.q("tbody tr");
    check("Keep on enabled in an outage", !row.querySelector("button").disabled);
    eq("outage note", r.q(".blurb").textContent, "Highlighted rows are within 1% of their next step; the phones get one warning with a Keep it on button.");
    fire(row.querySelector("button"), "click");
    eq("Keep on -> hold script", r.h.calls.pop(), ["script", "load_shedding_hold", { id: "ac" }]);
    fire(row.querySelector(".name"), "click");
    const ev = r.c.dispatched.pop();
    eq("name opens more-info", [ev.type, ev.detail.entityId, ev.bubbles, ev.composed], ["hass-more-info", AC, true, true]);

    r = mk(states({ grid: "on", soc: "51", devices: [dev("ac", AC, steps)], extra: { [AC]: S("off") } }), { blocks: ["upcoming"] });
    row = r.q("tbody tr");
    eq("off device", row.querySelectorAll("td")[4].textContent, "off — left alone");
    check("off device: Keep on disabled", row.querySelector("button").disabled);
    check("off device: no highlight", !row.classList.contains("soon"));

    r = mk(states({ grid: "on", soc: "45", devices: [dev("ac", AC, steps)], loads: { ac: { step_soc: 50 } } }), { blocks: ["upcoming"] });
    row = r.q("tbody tr");
    eq("applied", row.querySelectorAll("td")[4].textContent, "stepped down at 50%");
    eq("applied button", row.querySelector("button").textContent, "Put back");
    check("Put back enabled in an outage", !row.querySelector("button").disabled);

    r = mk(states({ grid: "on", soc: "45", devices: [dev("ac", AC, steps)], loads: { ac: { override_soc: 48 } } }), { blocks: ["upcoming"] });
    row = r.q("tbody tr");
    eq("held", row.querySelectorAll("td")[4].textContent, "kept on by you");
    eq("held button", row.querySelector("button").textContent, "Release");
    fire(row.querySelector("button"), "click");
    eq("Release -> release script", r.h.calls.pop(), ["script", "load_shedding_release", { id: "ac" }]);
    eq("held distance", row.querySelectorAll("td")[3].textContent, "7%");

    r = mk(states({ grid: "on", soc: "28", devices: [dev("ac", AC, steps)], loads: { ac: { override_soc: 40 } } }), { blocks: ["upcoming"] });
    eq("held past its re-arm point reads 'now'", r.q("tbody tr").querySelectorAll("td")[3].textContent, "now");

    r = mk(states({ grid: "on", soc: "25", devices: [dev("ac", AC, steps)], loads: { ac: { step_soc: 30 } } }), { blocks: ["upcoming"] });
    row = r.q("tbody tr");
    eq("nothing left", row.querySelectorAll("td").map((td) => td.textContent.trim()).slice(1, 4), ["nothing left", "—", "—"]);

    r = mk(states({ master: "off" }), { blocks: ["upcoming"] });
    eq("off note", r.q(".blurb").textContent, "The rules are off, so nothing will step down.");
    eq("no devices", r.q(".empty").textContent, "No device has steps yet.");

    r = mk(states({ grid: "on", soc: "51", rulesExtra: { warn_margin: 3 }, devices: [dev("ac", AC, steps)] }), { blocks: ["upcoming"] });
    check("margin in the note", r.q(".blurb").textContent.indexOf("within 3%") >= 0);
    r = mk(states({ devices: [dev("x<y", AC, steps, { name: "<b>A/C</b>" })] }), { blocks: ["upcoming"] });
    eq("names are escaped", r.q("tbody .name").textContent, "<b>A/C</b>");
    check("no injected element", !r.q("tbody .name b"));
  }

  group = "shed/rules-html: ";
  {
    const devs = [dev("lamp", LAMP, [{ soc: 40, action: "light.turn_off" }]),
      dev("ac", AC, [{ soc: 50, action: "climate.set_temperature", data: { temperature: 28 } }, { soc: 80, action: "climate.turn_off" }]),
      dev("boiler", BOILER, [])];
    let r = mk(states({ devices: devs }), { blocks: ["rules"] });
    eq("devices ordered by highest first step", r.qa(".dev .txt.name").map((i) => i.value), ["AC", "LAMP", "BOILER"]);
    eq("numbered", r.qa(".devhead .n").map((n) => n.textContent), ["1", "2", "3"]);
    eq("steps ordered high first within a device", r.qa(".dev")[0].querySelectorAll("input.soc").map((i) => i.value), ["80", "50"]);
    eq("status line", r.qa(".dev")[0].querySelector(".sub .st").textContent, "cool · 24°");
    check("no save bar while clean", !r.q(".savebar"));
    eq("empty device", r.qa(".dev")[2].querySelector(".st").textContent, "on · no steps yet");

    r = mk(states({ devices: [] }), { blocks: ["rules"] });
    eq("no devices", r.q(".empty").textContent, "No devices yet. Add one below.");
  }

  group = "shed/editing: ";
  {
    const devs = [dev("ac", AC, [{ soc: 80, action: "climate.turn_off" }])];
    let r = mk(states({ devices: devs }), { blocks: ["rules", "backup"] });
    const devEl = () => r.qa(".dev")[0];

    fire(devEl().querySelector('[data-act="add-step"]'), "click");
    eq("add step: 10 below the lowest", SHARED.draft.devices[0].steps.map((s) => s.soc), [80, 70]);
    eq("add step: first service", SHARED.draft.devices[0].steps[1].action, "climate.turn_off");
    let bar = r.q(".savebar");
    check("dirty: save bar", !!bar && !bar.classList.contains("err"));
    eq("dirty message", bar.querySelector("span").textContent, "Unsaved changes");
    check("save enabled", !bar.querySelector('[data-act="save"]').disabled);

    // A step's battery %.
    let soc = devEl().querySelectorAll("input.soc")[1];
    soc.value = "";
    fire(soc, "change");
    eq("cleared soc is null", SHARED.draft.devices[0].steps[1].soc, null);
    bar = r.q(".savebar");
    check("problem: error bar", bar.classList.contains("err"));
    eq("problem text", bar.querySelector("span").textContent, "AC: step 2 needs a battery % of 1-100");
    check("problem: save disabled", bar.querySelector('[data-act="save"]').disabled);
    soc = devEl().querySelectorAll("input.soc").find((i) => i.value === "");
    soc.value = "45";
    fire(soc, "change");
    eq("soc set", SHARED.draft.devices[0].steps.map((s) => s.soc), [80, 45]);

    // Action change resets data.
    SHARED.draft.devices[0].steps[1].data = { temperature: 28 };
    const sel = devEl().querySelectorAll("select.sel")[1];
    sel.value = "climate.set_temperature";
    fire(sel, "change");
    eq("action change resets data", [SHARED.draft.devices[0].steps[1].action, SHARED.draft.devices[0].steps[1].data],
      ["climate.set_temperature", {}]);

    // Its fields render; the collapsed one waits behind "more fields".
    const step = () => devEl().querySelectorAll(".step")[1];
    eq("visible fields", step().querySelectorAll("[data-kind=field]").map((n) => n.getAttribute("data-field")), ["temperature", "hvac_mode"]);
    eq("required marked", step().querySelector(".fld .cap").textContent, "temperature *");
    const t = step().querySelector('[data-field="temperature"]');
    eq("number input bounds", [t.getAttribute("min"), t.getAttribute("max"), t.getAttribute("step")], ["16", "30", "0.5"]);
    eq("unit", step().querySelector(".fld .u").textContent, "°C");
    eq("state selector lists hvac_modes", step().querySelector('select[data-field="hvac_mode"]').options.map((o) => o.value),
      ["", "off", "cool", "heat", "fan_only"]);
    fire(step().querySelector('[data-act="adv"]'), "click");
    eq("more fields", step().querySelectorAll("[data-kind=field]").map((n) => n.getAttribute("data-field")),
      ["temperature", "hvac_mode", "target_temp_high"]);
    eq("toggle reads fewer", step().querySelector('[data-act="adv"]').textContent, "fewer fields");
    fire(step().querySelector('[data-act="adv"]'), "click");

    const tf = step().querySelector('[data-field="temperature"]');
    tf.value = "28";
    fire(tf, "change");
    eq("number field stored", SHARED.draft.devices[0].steps[1].data, { temperature: 28 });
    const tf2 = step().querySelector('[data-field="temperature"]');
    eq("value rendered back", tf2.value, "28");
    tf2.value = "";
    fire(tf2, "change");
    eq("cleared field removed", SHARED.draft.devices[0].steps[1].data, {});

    // Name.
    const name = devEl().querySelector("input.name");
    name.value = "   ";
    fire(name, "change");
    eq("blank name falls back to the entity", SHARED.draft.devices[0].name, AC);
    const name2 = devEl().querySelector("input.name");
    name2.value = "  Hall  ";
    fire(name2, "change");
    eq("name trimmed", SHARED.draft.devices[0].name, "Hall");

    // Guard.
    fire(devEl().querySelector('[data-act="guard"]'), "click");
    const plug = devEl().querySelector('[data-field="plug"]');
    check("guard opened", !!plug);
    eq("datalist offers switches", r.q("#ents-switch").querySelectorAll("option").map((o) => o.value), ["switch.ac_plug", BOILER]);
    plug.value = " switch.ac_plug ";
    fire(plug, "change");
    eq("guard set", SHARED.draft.devices[0].guard, { plug: "switch.ac_plug" });
    const plug2 = devEl().querySelector('[data-field="plug"]');
    plug2.value = "";
    fire(plug2, "change");
    check("empty guard removed", SHARED.draft.devices[0].guard === undefined);

    // Enable / remove step / remove device.
    fire(devEl().querySelector('[data-act="enable"]'), "click");
    eq("disable", SHARED.draft.devices[0].enabled, false);
    check("disabled styling", devEl().classList.contains("off"));
    fire(devEl().querySelector('[data-act="enable"]'), "click");
    eq("enable", SHARED.draft.devices[0].enabled, true);
    const rm = devEl().querySelectorAll('[data-act="remove-step"]');
    fire(rm[rm.length - 1], "click");
    eq("remove the lower step (by its own index)", SHARED.draft.devices[0].steps.map((s) => s.soc), [80]);
    fire(devEl().querySelector('[data-act="remove-dev"]'), "click");
    eq("remove device", SHARED.draft.devices, []);

    // Discard.
    fire(r.q('[data-act="discard"]'), "click");
    eq("discard", SHARED.draft, null);
    check("bar gone", !r.q(".savebar"));

    // Settings.
    const ostep = r.q('[data-kind="ostep"]');
    ostep.value = "0";
    fire(ostep, "change");
    eq("override step 0 falls back to 10", SHARED.draft.override_step, 10);
    const ostep2 = r.q('[data-kind="ostep"]');
    ostep2.value = "15";
    fire(ostep2, "change");
    eq("override step 15", SHARED.draft.override_step, 15);
    const margin = r.q('[data-kind="margin"]');
    margin.value = "abc";
    fire(margin, "change");
    eq("non-numeric margin falls back to 1", SHARED.draft.warn_margin, 1);
    const margin2 = r.q('[data-kind="margin"]');
    margin2.value = "0";
    fire(margin2, "change");
    eq("margin 0 kept (warnings off)", SHARED.draft.warn_margin, 0);
    fire(r.q('[data-act="discard"]'), "click");

    // add-step edge cases.
    r = mk(states({ devices: [dev("b", BOILER, [])] }), { blocks: ["rules"] });
    fire(r.q('[data-act="add-step"]'), "click");
    eq("first step lands at 80 with turn_off", SHARED.draft.devices[0].steps, [{ soc: 80, action: "switch.turn_off", data: {} }]);
    r = mk(states({ devices: [dev("x", "vacuum.robot", [])], extra: { "vacuum.robot": S("docked") } }), { blocks: ["rules"] });
    fire(r.q('[data-act="add-step"]'), "click");
    eq("a domain with no services gets an empty action", SHARED.draft.devices[0].steps[0].action, "");
    r = mk(states({ devices: [dev("b", BOILER, [{ soc: 12, action: "switch.turn_off" }])] }), { blocks: ["rules"] });
    fire(r.q('[data-act="add-step"]'), "click");
    eq("floor at 5 %", SHARED.draft.devices[0].steps.map((s) => s.soc), [12, 5]);
    fire(r.q('[data-act="add-step"]'), "click");
    eq("\"+ Add step\" below an existing 5 % step takes the next free % down",
      SHARED.draft.devices[0].steps.map((s) => s.soc), [12, 5, 4]);
    eq("...which Save accepts", r.c._problems(SHARED.draft), []);
  }

  group = "shed/fields-html: ";
  {
    const lampDev = dev("lamp", LAMP, [{ soc: 50, action: "light.turn_on", data: { rgb_color: [1, 2, 3], on: true, transition: 2 } }]);
    const r = mk(states({ devices: [lampDev] }), { blocks: ["rules"] });
    const fields = r.qa("[data-kind=field]");
    const by = (k) => fields.find((f) => f.getAttribute("data-field") === k);
    eq("supported and unsupported", fields.map((f) => f.getAttribute("data-field")),
      ["brightness_pct", "rgb_color", "effect", "flash", "transition", "profile", "white", "on"]);
    check("kelvin filtered out (no color_temp mode)", !by("kelvin"));
    check("advanced field with a value is shown", !!by("transition"));
    eq("rgb rendered", by("rgb_color").value, "1, 2, 3");
    eq("boolean checked", by("on").checked, true);
    eq("effect from effect_list", by("effect").options.map((o) => o.value), ["", "rainbow"]);
    eq("select options, strings and objects", by("flash").options.map((o) => [o.value, o.textContent.trim()]),
      [["", "—"], ["short", "short"], ["long", "Long flash"]]);
    eq("text", by("profile").getAttribute("data-type"), "text");
    eq("unknown selector falls back to JSON", by("white").getAttribute("data-type"), "json");
    eq("number with % unit", by("brightness_pct").parentNode.querySelector(".u").textContent, "%");

    // Toggle the boolean off; unknown action keeps a raw JSON editor.
    by("on").checked = false;
    fire(by("on"), "change");
    eq("boolean false stored", SHARED.draft.devices[0].steps[0].data.on, false);
    fire(r.q('[data-act="discard"]'), "click");

    const r2 = mk(states({ devices: [dev("lamp", LAMP, [{ soc: 50, action: "light.gone_service", data: { a: 1 } }])] }), { blocks: ["rules"] });
    const sel = r2.q("select.sel[data-kind=action]");
    eq("unknown action kept as an option", sel.value, "light.gone_service");
    const raw = r2.q('[data-field="__all"]');
    eq("raw data editor", raw.value, '{"a":1}');
    raw.value = '{"b":2}';
    fire(raw, "change");
    eq("raw data replaced", SHARED.draft.devices[0].steps[0].data, { b: 2 });
    const raw2 = r2.q('[data-field="__all"]');
    raw2.value = "[1,2]";
    fire(raw2, "change");
    eq("a non-object becomes {}", SHARED.draft.devices[0].steps[0].data, {});
    const raw3 = r2.q('[data-field="__all"]');
    raw3.value = "{broken";
    fire(raw3, "change");
    eq("broken JSON becomes {}", SHARED.draft.devices[0].steps[0].data, {});

    const r3 = mk(states({ devices: [dev("ac", AC, [{ soc: 50, action: "climate.set_fan_mode", data: {} }])] }), { blocks: ["rules"] });
    eq("fan_mode from fan_modes", r3.q('select[data-field="fan_mode"]').options.map((o) => o.value), ["", "auto", "low"]);
    const r4 = mk(states({ devices: [dev("ac", AC, [{ soc: 50, action: "climate.adjust_temperature", data: { by: -2 } }])] }), { blocks: ["rules"] });
    const by4 = r4.q('[data-field="by"]');
    eq("adjust field", [by4.getAttribute("min"), by4.getAttribute("max"), by4.value], ["-10", "10", "-2"]);
    eq("adjust selected", r4.q("select.sel[data-kind=action]").value, "climate.adjust_temperature");
  }

  group = "shed/picker: ";
  {
    const many = {};
    for (let i = 0; i < 50; i++) many["switch.s" + String(i).padStart(2, "0")] = S("off");
    const r = mk(states({ devices: [dev("ac", AC, [])], extra: Object.assign({ "switch.ac_plug": S("on", { friendly_name: "A/C plug" }) }) }), { blocks: ["rules"] });
    fire(r.q('[data-act="picker"]'), "click");
    const picks = () => r.qa(".pick").map((p) => p.getAttribute("data-ent"));
    eq("devices only (input_boolean counts), taken ones hidden", picks(),
      [E.master, LAMP, "switch.ac_plug", BOILER]);
    const qi = r.q('[data-kind="query"]');
    qi.value = "a/c";
    fire(qi, "input");
    eq("search by friendly name", picks(), ["switch.ac_plug"]);
    qi.value = "LIGHT.";
    fire(qi, "input");
    eq("search by id, case-insensitive", picks(), [LAMP]);
    qi.value = "zzz";
    fire(qi, "input");
    eq("nothing matches", r.q(".plist").textContent.trim(), "Nothing matches.");
    qi.value = "";
    fire(qi, "input");
    fire(r.qa(".pick").find((p) => p.getAttribute("data-ent") === "switch.ac_plug"), "click");
    eq("picked", SHARED.draft.devices[1], { id: "ac_plug", name: "A/C plug", entity: "switch.ac_plug", enabled: true, steps: [] });
    check("picker closed", !r.q(".picker"));
    // A clashing id gets a suffix.
    SHARED.set({ override_step: 10, warn_margin: 1, devices: [dev("boiler", "switch.other", []), dev("boiler_2", "switch.other2", [])] });
    fire(r.q('[data-act="picker"]'), "click");
    fire(r.qa(".pick").find((p) => p.getAttribute("data-ent") === BOILER), "click");
    eq("id deduplicated", SHARED.draft.devices[2].id, "boiler_3");

    const r2 = mk(withIds(Object.assign(states(), many)), { blocks: ["rules"] });
    fire(r2.q('[data-act="picker"]'), "click");
    eq("at most 40 offered", r2.qa(".pick").length, 40);
  }

  group = "shed/save: ";
  {
    const devs = [dev("ac", AC, [{ soc: 80, action: "climate.turn_off" }])];
    let r = mk(states({ devices: devs }), { blocks: ["rules"] }, { svc: () => Promise.resolve({ response: { ok: true } }) });
    fire(r.q('[data-act="add-step"]'), "click");
    const draft = JSON.parse(JSON.stringify(SHARED.draft));
    fire(r.q('[data-act="save"]'), "click");
    check("saving flag while in flight", SHARED.saving === true);
    eq("save button says so", r.q('[data-act="save"]').textContent.trim(), "Saving…");
    check("save disabled while saving", r.q('[data-act="save"]').disabled);
    fire(r.q('[data-act="save"]'), "click");
    eq("a second click while saving sends nothing", r.h.calls.length, 1);
    await flush();
    eq("save call", r.h.calls[0], ["script", "load_shedding_save_config", { config: draft }]);
    eq("save asks for the script's response", r.h.raw[0].slice(3), [undefined, false, true]);
    eq("draft cleared on ok", [SHARED.draft, SHARED.saving, SHARED.error], [null, false, ""]);

    r = mk(states({ devices: devs }), { blocks: ["rules"] }, { svc: () => Promise.resolve({ response: { ok: false, errors: ["AC: bad", "x"] } }) });
    fire(r.q('[data-act="add-step"]'), "click");
    fire(r.q('[data-act="save"]'), "click");
    await flush();
    eq("refusal shown", SHARED.error, "Not saved: AC: bad; x");
    check("draft kept", !!SHARED.draft);
    eq("bar shows the refusal", r.q(".savebar span").textContent, "Not saved: AC: bad; x");

    r = mk(states({ devices: devs }), { blocks: ["rules"] }, { svc: () => Promise.reject(new Error("boom")) });
    fire(r.q('[data-act="add-step"]'), "click");
    fire(r.q('[data-act="save"]'), "click");
    await flush();
    eq("exception shown", [SHARED.error, SHARED.saving], ["Not saved: boom", false]);

    r = mk(states({ devices: devs }), { blocks: ["rules"] }, { svc: () => Promise.reject("plain") });
    fire(r.q('[data-act="add-step"]'), "click");
    fire(r.q('[data-act="save"]'), "click");
    await flush();
    eq("non-Error rejection", SHARED.error, "Not saved: plain");

    r = mk(states({ devices: devs }), { blocks: ["rules"] }, { svc: () => Promise.resolve(undefined) });
    fire(r.q('[data-act="add-step"]'), "click");
    fire(r.q('[data-act="save"]'), "click");
    await flush();
    eq("no response counts as saved", SHARED.draft, null);

    r = mk(states({ devices: devs }), { blocks: ["rules"] });
    SHARED.set({ override_step: 10, warn_margin: 1, devices: [dev("ac", AC, [{ soc: 0, action: "" }])] });
    await r.c._save();
    eq("local problems block the call", r.h.calls.length, 0);
    eq("...and are shown", SHARED.error, "AC: step 1 needs a battery % of 1-100; AC: step 1 needs an action");
    eq("dirty with problems: Discard + Save", r.q(".savebar").querySelectorAll("button").map((b) => b.textContent.trim()),
      ["Discard", "Save"]);
    SHARED.set(null);
    SHARED.error = "stale";
    SHARED.notify();
    eq("error alone: Dismiss", r.q(".savebar").querySelectorAll("button").map((b) => b.textContent.trim()), ["Dismiss"]);
    await r.c._save();
    eq("save with no draft does nothing", r.h.calls.length, 0);
  }

  group = "shed/backup: ";
  {
    const devs = [dev("ac", AC, [{ soc: 80, action: "climate.turn_off" }])];
    const r = mk(states({ devices: devs, rulesExtra: { warn_margin: 3 } }), { blocks: ["backup", "rules"] });
    eq("settings rendered", [r.q('[data-kind="ostep"]').value, r.q('[data-kind="margin"]').value], ["10", "3"]);
    fire(r.q('[data-act="export"]'), "click");
    const ta = r.q("textarea.code[readonly]");
    eq("export shows the stored rules", JSON.parse(ta.value), rulesAttr(devs, { warn_margin: 3 }));
    fire(r.q('[data-act="export"]'), "click");
    check("export hides again", !r.q("textarea.code[readonly]"));
    fire(r.q('[data-act="copy"]'), "click");
    eq("copy", JSON.parse(L.clipboard.pop()), rulesAttr(devs, { warn_margin: 3 }));
    fire(r.q('[data-act="download"]'), "click");
    const a = L.created.pop();
    eq("download", [a.localName, a.download, a.href, a._clicked], ["a", "load-shedding.json", "blob:test", 1]);
    L.flushTimers();

    // Import.
    const imp = () => r.q('[data-kind="import"]');
    imp().value = "not json";
    fire(imp(), "input");
    fire(r.q('[data-act="import"]'), "click");
    check("bad JSON: error", /^Import: that is not a rules JSON \(/.test(SHARED.error), SHARED.error);
    eq("bad JSON: no draft", SHARED.draft, null);
    imp().value = '{"devices": 3}';
    fire(imp(), "input");
    fire(r.q('[data-act="import"]'), "click");
    eq("no devices list", SHARED.error, "Import: that is not a rules JSON (no devices list).");
    imp().value = "null";
    fire(imp(), "input");
    fire(r.q('[data-act="import"]'), "click");
    eq("null", SHARED.error, "Import: that is not a rules JSON (no devices list).");

    const exported = rulesAttr([dev("lamp", LAMP, [{ soc: 40, action: "light.turn_off" }])], { override_step: 0, warn_margin: 3 });
    imp().value = JSON.stringify(exported);
    fire(imp(), "input");
    fire(r.q('[data-act="import"]'), "click");
    eq("import opens a draft", SHARED.draft.devices.map((d) => d.id), ["lamp"]);
    eq("override_step 0 becomes 10", SHARED.draft.override_step, 10);
    eq("error cleared", SHARED.error, "");
    eq("import box emptied", imp().value, "");
    check("editor shows the imported device", r.qa(".dev .txt.name").map((i) => i.value).join() === "LAMP");
    eq("Import keeps the exported warn_margin", SHARED.draft.warn_margin, 3);
    imp().value = JSON.stringify({ devices: [] });
    fire(imp(), "input");
    fire(r.q('[data-act="import"]'), "click");
    eq("Import without warn_margin falls back to 1", SHARED.draft.warn_margin, 1);
    imp().value = JSON.stringify({ devices: [], warn_margin: "abc" });
    fire(imp(), "input");
    fire(r.q('[data-act="import"]'), "click");
    eq("Import with a non-numeric warn_margin falls back to 1", SHARED.draft.warn_margin, 1);
    imp().value = JSON.stringify({ devices: [], warn_margin: 0 });
    fire(imp(), "input");
    fire(r.q('[data-act="import"]'), "click");
    eq("Import keeps warn_margin 0 (warnings off)", SHARED.draft.warn_margin, 0);
  }

  group = "shed/render-cycle: ";
  {
    const r = mk(states({ devices: [dev("ac", AC, [{ soc: 80, action: "climate.turn_off" }])] }), { blocks: ["rules"] });
    const first = r.root.childNodes[1];
    r.c.hass = Object.assign({}, r.h, { states: Object.assign({}, r.h.states) });
    check("same state: no re-render", r.root.childNodes[1] === first);
    r.c.hass = Object.assign({}, r.h, { states: Object.assign({}, r.h.states, { "sensor.unrelated": S("1") }) });
    check("unrelated entity: no re-render", r.root.childNodes[1] === first);
    r.c.hass = Object.assign({}, r.h, { states: Object.assign({}, r.h.states, { [AC]: S("cool", { temperature: 22 }) }) });
    check("a rule device's setpoint: re-render", r.root.childNodes[1] !== first);

    // Typing hand: no re-render until focus leaves.
    const name = r.q("input.name");
    r.root.activeElement = name;
    const before = r.root.childNodes[1];
    r.c.hass = Object.assign({}, r.h, { states: Object.assign({}, r.h.states, { [E.soc]: S("10") }) });
    check("focused input: held back", r.root.childNodes[1] === before && r.c._pending === true);
    r.root.activeElement = null;
    fire(r.root, "focusout");
    L.flushTimers();
    check("focusout: catches up", r.root.childNodes[1] !== before && r.c._pending === false);

    // A second card shares the draft.
    reset();
    const a = new Card(); a.setConfig({ blocks: ["rules"] }); a.connectedCallback();
    const b = new Card(); b.setConfig({ blocks: ["backup"] }); b.connectedCallback();
    const h = mkHass(states({ devices: [] }), { services: SERVICES });
    a.hass = h; b.hass = h;
    const imp = b.shadowRoot.querySelector('[data-kind="import"]');
    imp.value = JSON.stringify(rulesAttr([dev("lamp", LAMP, [])]));
    fire(imp, "input");
    fire(b.shadowRoot.querySelector('[data-act="import"]'), "click");
    eq("Import in Backup lands in the Rules card", a.shadowRoot.querySelectorAll(".dev .txt.name").map((i) => i.value), ["LAMP"]);
    b.disconnectedCallback();
    check("disconnect unsubscribes", SHARED.subs.size === 1);

    const c = new Card();
    c.setConfig({});
    noThrow("click with no hass", () => fire(c.shadowRoot, "click"));
    noThrow("change with no kind", () => fire(c.shadowRoot, "change"));
  }

  group = "shed/unknown: ";
  {
    let r;
    noThrow("renders with no entities at all", () => {
      reset();
      const c = new Card();
      c.setConfig({});
      c.connectedCallback();
      c.hass = mkHass({}, { services: {} });
      r = c;
    });
    if (r) {
      const t = r.shadowRoot.textContent.replace(/\s+/g, " ");
      check("hero says off", r.shadowRoot.querySelector("h1").textContent === "Off");
      check("no devices messages", t.indexOf("No device has steps yet.") >= 0 && t.indexOf("No devices yet.") >= 0);
    }
    const st = states({ devices: [dev("ac", "climate.gone", [{ soc: 50, action: "climate.turn_off" }])] });
    const r2 = mk(st);
    eq("rule on a vanished entity", r2.q(".dev .sub .st").textContent, "entity not found");
    eq("vanished entity is off in Coming up", r2.q("tbody tr").querySelectorAll("td")[4].textContent, "off — left alone");
  }
}

/* ========================================================================== */
/* Report                                                                     */
/* ========================================================================== */

(async () => {
  await inverterSuite();
  await batterySuite();
  await loadSheddingSuite();

  if (known.length) {
    console.log("KNOWN-BUG checks (intended behaviour, not counted as failures):");
    known.forEach((k) => {
      console.log("  [" + (k.fixed ? "now passes -- move it into the main groups" : "still present") + "] "
        + k.name + (k.where ? "  (" + k.where + ")" : "") + (k.fixed ? "" : "\n      " + k.detail));
    });
  }
  await flush();
  takeUnhandled().forEach((e) => failures.push("unexpected unhandled rejection: " + (e && e.stack || e)));
  if (failures.length) {
    console.log("test_power_cards: " + failures.length + " failure(s), " + pass + " passed");
    failures.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
  console.log("test_power_cards: ok — " + pass + " checks passed, "
    + known.filter((k) => !k.fixed).length + " known bug(s) still present");
})().catch((e) => { console.log("test_power_cards: crashed -- " + (e && e.stack)); process.exit(1); });
