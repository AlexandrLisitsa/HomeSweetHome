/**
 * card-tip.js -- the tooltip every custom card in this folder shares.
 *
 *     import { cardTip } from "./card-tip.js?v=1.0.0";
 *     ...
 *     this.attachShadow({ mode: "open" });
 *     cardTip(this, this.shadowRoot);
 *
 * Not a Lovelace resource: the cards import it, so the browser fetches it
 * once, relative to /local/. The `?v=` in each import is this file's VERSION;
 * changing this file means bumping VERSION and every card that imports it
 * (MANIFEST.md §6), or the browser keeps the old module.
 *
 * WHAT IT DRAWS
 *
 * An element carries its tooltip as text in `data-tip`, in the house format
 * (docs/dashboard-tooltips.md):
 *
 *     Grid — 231.4 V · NOMINAL
 *     Mains voltage at the inverter input; the bar runs 200–250 V.
 *     E.g. below 185 V for 5 s, Protect moves the house to the battery.
 *     Cannot be on together with Auto.
 *
 * and this draws it as the design's card (MANIFEST.md §8): a header with the
 * name, the live value in mono and a state pill when the value ends in a
 * status word it knows; the description, muted; the example behind an "E.g."
 * chip; and the optional note under a hairline, with a hand icon when it is
 * about tapping and an info icon when it is a rule.
 *
 * WHY THE CARD DRAWS IT AND NOT THE BROWSER
 *
 * A native `title` closes the moment its text changes, and line 1 carries a
 * live state that changes every few seconds. So the box lives in
 * document.body -- outside every shadow root, where no card or section can
 * clip it -- and, whenever the card's DOM changes, re-reads the element under
 * the pointer (or the focused one): it stays open and rewrites itself in
 * place, even over a card that redraws itself whole with innerHTML.
 *
 * Behaviour: opens 250 ms after the pointer settles on an element, at once on
 * keyboard focus; closes 120 ms after the pointer leaves, or on Esc or a
 * press. It sits 8 px below the element with its arrow on the element's
 * centre, flips above when fewer than 12 px would be left below, and slides
 * sideways to stay 8 px inside the viewport. While open its width only grows,
 * so a value ticking from 9.8 to 10.2 does not make it twitch. Fades in with a
 * 4 px rise over 120 ms, without motion under prefers-reduced-motion. Mouse
 * and keyboard only: a touch has no hover.
 */

export const VERSION = "1.0.0";

const ID = "card-tip";
const OPEN_MS = 250;
const CLOSE_MS = 120;
const OFFSET = 8;
const EDGE = 8;
const FLIP = 12;
const ARROW_INSET = 14;

/** Status words that earn a pill, by tone. Anything else stays in the value. */
const TONES = {
  nominal: ["NOMINAL", "NORMAL", "HEALTHY", "FULL", "CHARGING", "CHG", "OK"],
  warning: ["WARNING", "MODERATE", "ELEVATED", "HIGH", "LOW", "HEAVY"],
  fault: ["FAULT", "CRITICAL", "UNDERVOLTAGE", "OVERVOLTAGE", "OVERLOAD", "NO GRID"],
  idle: ["IDLE", "DIS", "DISCHARGING", "OFF", "NO DATA"],
};
const TONE_OF = {};
Object.keys(TONES).forEach((t) => TONES[t].forEach((w) => { TONE_OF[w] = t; }));

/* The design's tokens (MANIFEST.md §8). */
const CSS = `
#${ID} {
  position: fixed; z-index: 9999; pointer-events: none; box-sizing: border-box;
  width: max-content; max-width: min(380px, calc(100vw - ${2 * EDGE}px));
  padding: 10px 12px 11px; display: none; flex-direction: column; gap: 6px;
  background: #1A2028; border: 1px solid #2E3844; border-radius: 8px;
  box-shadow: 0 12px 32px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.04);
  font-family: 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: #E7ECF2; text-align: left; letter-spacing: normal; text-transform: none;
  opacity: 0; transform: translateY(4px); transition: opacity 120ms ease, transform 120ms ease;
}
#${ID}.above { transform: translateY(-4px); }
#${ID}.open { opacity: 1; transform: none; }
@media (prefers-reduced-motion: reduce) { #${ID}, #${ID}.above { transition: none; transform: none; } }
#${ID} .ct-arrow {
  position: absolute; top: -6px; width: 10px; height: 10px; margin-left: -5px;
  background: #1A2028; border-left: 1px solid #2E3844; border-top: 1px solid #2E3844;
  transform: rotate(45deg);
}
#${ID}.above .ct-arrow {
  top: auto; bottom: -6px; border: 0;
  border-right: 1px solid #2E3844; border-bottom: 1px solid #2E3844;
}
#${ID} .ct-head { display: flex; align-items: baseline; flex-wrap: wrap; column-gap: 7px;
  font-size: 13px; line-height: 18px; }
#${ID} .ct-label { font-weight: 600; color: #F1F4F8; }
#${ID} .ct-dash { color: #5A6775; }
#${ID} .ct-value { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-weight: 500;
  font-variant-numeric: tabular-nums; color: #F1F4F8; }
#${ID} .ct-pill { margin-left: auto; padding-left: 10px; display: inline-flex; align-self: center; }
#${ID} .ct-pill b { display: inline-flex; align-items: center; gap: 5px; padding: 1px 7px 1px 6px;
  border-radius: 999px; font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 10.5px;
  font-weight: 600; letter-spacing: .06em; line-height: 16px; white-space: nowrap; }
#${ID} .ct-pill i { width: 6px; height: 6px; border-radius: 50%; }
#${ID} .ct-pill.nominal b { color: #62D6A8; background: rgba(63,182,139,.14); }
#${ID} .ct-pill.nominal i { background: #3FB68B; }
#${ID} .ct-pill.warning b { color: #F2BE62; background: rgba(224,163,58,.15); }
#${ID} .ct-pill.warning i { background: #E0A33A; }
#${ID} .ct-pill.fault b { color: #FF928A; background: rgba(229,83,75,.17); }
#${ID} .ct-pill.fault i { background: #E5534B; }
#${ID} .ct-pill.idle b { color: #A9B5C3; background: rgba(169,181,195,.12); }
#${ID} .ct-pill.idle i { background: #7D8A99; }
#${ID} .ct-desc { font-size: 12.5px; line-height: 18px; color: #A9B5C3; }
#${ID} .ct-eg { display: flex; align-items: baseline; gap: 7px; font-size: 12.5px; line-height: 18px;
  color: #D3DAE3; font-variant-numeric: tabular-nums; }
#${ID} .ct-chip { flex: none; font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 10.5px;
  font-weight: 600; letter-spacing: .04em; color: #86B3E3; padding: 0 5px;
  border: 1px solid #2F4258; border-radius: 4px; line-height: 15px; }
#${ID} .ct-note { display: flex; align-items: flex-start; gap: 7px; margin-top: 2px; padding-top: 7px;
  border-top: 1px solid #29323D; font-size: 12px; line-height: 17px; color: #93A0AF; }
#${ID} .ct-note svg { flex: none; margin-top: 1px; }
#${ID} [hidden] { display: none !important; }
`;

/* Only the faces the box uses; the files are the cards' own (fonts/). */
const FACES = [
  ["IBM Plex Sans", "400 600", "ibm-plex-sans-latin", "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD"],
  ["IBM Plex Sans", "400 600", "ibm-plex-sans-latin-ext", "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+1E00-1E9F, U+20A0-20AB, U+20AD-20C0, U+2113"],
  ["IBM Plex Mono", "500", "ibm-plex-mono-500-latin", "U+0000-00FF, U+2000-206F, U+2212"],
  ["IBM Plex Mono", "600", "ibm-plex-mono-600-latin", "U+0000-00FF, U+2000-206F, U+2212"],
].map((f) => "@font-face{font-family:'" + f[0] + "';font-style:normal;font-weight:" + f[1]
  + ";font-display:swap;src:url('/local/fonts/" + f[2] + ".woff2') format('woff2');unicode-range:" + f[3] + "}")
  .join("\n");

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  tap: ["M9 11V5a2 2 0 0 1 4 0v6", "M13 10.5V9a2 2 0 0 1 4 0v3",
    "M17 11a2 2 0 0 1 4 0v3a7 7 0 0 1-7 7h-1.5a6 6 0 0 1-4.6-2.2L4.6 15.6a1.8 1.8 0 0 1 2.7-2.4L9 15"],
  rule: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18", "M12 11v5", "M12 8h.01"],
};

/**
 * Split a data-tip string into the design's parts. Line 1 is "name — value",
 * and a value ending in " · WORD" (or that is only WORD) with WORD a known
 * status word gets the pill. A line starting "E.g. " is the example; a line
 * after it is the note, "tap" when it says what a press does.
 */
export function parseTip(text) {
  const lines = String(text).split("\n");
  const head = lines[0] || "";
  const cut = head.indexOf(" — ");
  const out = { label: cut < 0 ? head : head.slice(0, cut), value: cut < 0 ? "" : head.slice(cut + 3),
    state: "", tone: "", desc: "", example: "", note: "", noteKind: "rule" };
  const m = out.value.match(/^(?:(.*) · )?([A-Z][A-Z ]*[A-Z])$/);
  if (m && TONE_OF[m[2]]) {
    out.value = m[1] || "";
    out.state = m[2];
    out.tone = TONE_OF[m[2]];
  }
  const rest = lines.slice(1);
  const eg = rest.findIndex((l) => /^E\.g\. /.test(l));
  out.desc = (eg < 0 ? rest : rest.slice(0, eg)).join(" ");
  if (eg >= 0) {
    out.example = rest[eg].slice(5);
    out.note = rest.slice(eg + 1).join(" ");
  }
  if (/^(tap|hold|drag|press|click)\b/i.test(out.note)) out.noteKind = "tap";
  return out;
}

function el(tag, cls, parent) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
}

function icon(kind) {
  const svg = document.createElementNS(SVG_NS, "svg");
  [["width", "14"], ["height", "14"], ["viewBox", "0 0 24 24"], ["fill", "none"], ["stroke", "currentColor"],
    ["stroke-width", "2"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"], ["aria-hidden", "true"]]
    .forEach((a) => svg.setAttribute(a[0], a[1]));
  ICONS[kind].forEach((d) => {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  });
  return svg;
}

/** The one box in document.body, built on first use; every card shares it. */
function box() {
  let b = document.getElementById(ID);
  if (b) return b;
  if (document.head && !document.getElementById(ID + "-style")) {
    const s = document.createElement("style");
    s.id = ID + "-style";
    s.textContent = FACES + "\n" + CSS;
    document.head.appendChild(s);
  }
  b = el("div");
  b.id = ID;
  b.setAttribute("role", "tooltip");
  b._arrow = el("div", "ct-arrow", b);
  const head = el("div", "ct-head", b);
  b._label = el("span", "ct-label", head);
  b._dash = el("span", "ct-dash", head);
  b._dash.textContent = "—";
  b._value = el("span", "ct-value", head);
  b._pill = el("span", "ct-pill", head);
  const pb = el("b", "", b._pill);
  el("i", "", pb);
  b._state = el("span", "", pb);
  b._desc = el("div", "ct-desc", b);
  const eg = el("div", "ct-eg", b);
  el("span", "ct-chip", eg).textContent = "E.g.";
  b._eg = eg;
  b._example = el("span", "", eg);
  b._note = el("div", "ct-note", b);
  b._noteIcon = { tap: icon("tap"), rule: icon("rule") };
  b._note.appendChild(b._noteIcon.tap);
  b._note.appendChild(b._noteIcon.rule);
  b._noteText = el("span", "", b._note);
  document.body.appendChild(b);
  return b;
}

function put(node, text) {
  if (node.textContent !== text) node.textContent = text;
  node.hidden = !text;
}

/** Fill the box from a data-tip string; touches only what changed. */
function fill(b, text) {
  if (b.getAttribute("data-text") === text) return;
  b.setAttribute("data-text", text);
  const t = parseTip(text);
  put(b._label, t.label);
  put(b._value, t.value);
  b._dash.hidden = !t.value && !t.state;
  b._pill.className = "ct-pill " + t.tone;
  b._pill.hidden = !t.state;
  if (b._state.textContent !== t.state) b._state.textContent = t.state;
  put(b._desc, t.desc);
  b._eg.hidden = !t.example;
  if (b._example.textContent !== t.example) b._example.textContent = t.example;
  b._note.hidden = !t.note;
  b._noteIcon.tap.style.display = t.noteKind === "tap" ? "" : "none";
  b._noteIcon.rule.style.display = t.noteKind === "tap" ? "none" : "";
  if (b._noteText.textContent !== t.note) b._noteText.textContent = t.note;
}

/** Below the element, arrow on its centre; above when it does not fit. */
function place(b, target) {
  const vw = window.innerWidth || 1024;
  const vh = window.innerHeight || 768;
  const r = target.getBoundingClientRect ? target.getBoundingClientRect()
    : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  const w = b.offsetWidth || 0;
  const h = b.offsetHeight || 0;
  const cx = r.left + r.width / 2;
  const above = r.bottom + OFFSET + h > vh - FLIP && r.top - OFFSET - h >= EDGE;
  const left = Math.max(EDGE, Math.min(vw - EDGE - w, cx - w / 2));
  const top = above ? r.top - OFFSET - h : r.bottom + OFFSET;
  b.classList.toggle("above", above);
  b.style.left = Math.round(left) + "px";
  b.style.top = Math.round(top) + "px";
  b._arrow.style.left = Math.round(Math.max(ARROW_INSET, Math.min(w - ARROW_INSET, cx - left))) + "px";
}

export function cardTip(host, root) {
  if (typeof document === "undefined" || !document.body || typeof MutationObserver === "undefined") return;
  let x = 0, y = 0, by = "", target = null, open = false, openT = 0, closeT = 0;
  const frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => fn();

  const tipAt = (n) => {
    for (; n && n !== root && n !== host; n = n.parentNode || n.host) {
      if (n.nodeType === 1 && n.getAttribute("data-tip")) return n;
    }
    return null;
  };
  /* The element now under the pointer, or focused: a redraw may have replaced it. */
  const current = () => {
    if (by === "focus") return tipAt(root.activeElement);
    return tipAt(root.elementFromPoint ? root.elementFromPoint(x, y) : null);
  };
  const close = () => {
    clearTimeout(openT);
    clearTimeout(closeT);
    open = false;
    target = null;
    const b = document.getElementById(ID);
    if (b && b._owner === host) {
      b.classList.remove("open");
      b.style.display = "none";
      b.style.minWidth = "";
    }
  };
  const show = () => {
    clearTimeout(closeT);
    const t = current();
    if (!t) { close(); return; }
    const b = box();
    if (!open || b._owner !== host || t !== target) b.style.minWidth = "";
    target = t;
    b._owner = host;
    fill(b, t.getAttribute("data-tip"));
    if (b.style.display !== "flex") b.style.display = "flex";
    place(b, t);
    // While it stays on one element its width only grows: a ticking value
    // must not make the box twitch.
    b.style.minWidth = Math.ceil(b.offsetWidth || 0) + "px";
    if (!open) frame(() => { if (open) b.classList.add("open"); });
    open = true;
  };
  const later = () => { clearTimeout(closeT); closeT = setTimeout(close, CLOSE_MS); };

  host.addEventListener("pointermove", (e) => {
    if (e.pointerType && e.pointerType !== "mouse") return;
    x = e.clientX;
    y = e.clientY;
    by = "pointer";
    const t = current();
    if (open) {
      if (!t) later();
      else if (t !== target) show();
      else clearTimeout(closeT);
      return;
    }
    clearTimeout(openT);
    if (t) openT = setTimeout(show, OPEN_MS);
  });
  host.addEventListener("pointerleave", () => { if (by === "pointer") { clearTimeout(openT); later(); } });
  host.addEventListener("pointerdown", close);
  host.addEventListener("focusin", () => { by = "focus"; if (current()) show(); });
  host.addEventListener("focusout", () => { if (by === "focus") later(); });
  document.addEventListener("keydown", (e) => { if (open && e.key === "Escape") close(); });
  new MutationObserver(() => { if (open) show(); })
    .observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["data-tip"] });
}
