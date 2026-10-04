/**
 * A small DOM for testing the custom Lovelace cards in config/www/ under Node,
 * shared by test_power_cards.js and test_card_tooltips.js.
 *
 * An HTML parser good enough for the cards' own templates, classList, style,
 * dataset, querySelector (tag, .class, #id, [attr], [attr="v"], descendant,
 * comma) and event bubbling through a shadow root; loadCard() runs a card file
 * as-is in a vm sandbox built on it, and mkHass() is a fake `hass` that
 * records service calls. Nothing here talks to Home Assistant.
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
  set id(v) { this.setAttribute("id", v); }
  get className() { return this.getAttribute("class") || ""; }
  set className(v) { this.setAttribute("class", v); }
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

/**
 * A card's source as a plain script. The cards are ES modules that import the
 * shared tooltip (config/www/card-tip.js); vm runs scripts, so the import is
 * replaced by that module's own source, `export`s dropped, in a scope of its
 * own so its names cannot clash with the card's.
 */
function cardSource(file) {
  const src = fs.readFileSync(path.join(WWW, file), "utf8");
  return src.replace(/^import \{ cardTip \} from "\.\/card-tip\.js\?v=[^"]+";$/m, () =>
    "const { cardTip } = (function () {\n"
    + fs.readFileSync(path.join(WWW, "card-tip.js"), "utf8").replace(/^export /gm, "")
    + "\nreturn { cardTip: cardTip };\n})();");
}

/** Run a card file in a sandbox; `extra` adds or overrides sandbox globals. */
function loadCard(file, extra) {
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
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    },
    document: {
      head: null,
      getElementById: () => null,
      createElement: (t) => { const e = new Element(t); created.push(e); return e; },
      createElementNS: (_ns, t) => { const e = new Element(t); created.push(e); return e; },
    },
    navigator: { clipboard: { writeText: (t) => { clipboard.push(t); return Promise.resolve(); } } },
    Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; } },
    URL: { createObjectURL: () => "blob:test", revokeObjectURL: () => {} },
    console: { info: () => {} },
    Math: Math, Date: Date, Number: Number, JSON: JSON,
  };
  Object.assign(sandbox, extra || {});
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(cardSource(file), sandbox, { filename: file });
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

module.exports = {
  WWW, Node0, TextNode, Element, ShadowRoot0, HostElement, CustomEvent0, Event0,
  parseHTML, serialize, fire, cardSource, loadCard, mkHass, S, withIds, flush, hm, localIso,
};
