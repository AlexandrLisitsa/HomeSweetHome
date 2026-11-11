/**
 * Router console card.
 *
 * The TP-Link Archer C80 on one screen: what it moves right now, what it
 * moved over the day and the month, and the address the provider gives it.
 * HA reaches the router through UPnP alone (the `upnp` integration), so
 * those are all there is to draw: two rates and one address. The console
 * adds nothing to the house -- no entity, no helper -- it only reads them.
 * See docs/router-dashboard.md.
 *
 * WHERE IT IS
 * -----------
 * The Network dashboard (/dashboard-network) holds it in a sections view,
 * and a tap on the router on the Home floor plan opens the same card in a
 * modal (floorplan-card.js `panel`). It has its own height, so the modal
 * fits it.
 *
 * WHAT IS MEASURED
 * ----------------
 * The rates are UPnP byte counters the integration turns into KiB/s every
 * 30 s; the card shows Mbit/s, the unit a tariff is sold in. Today's peak and
 * average come from the recorder's raw history (kept 2 days), the 7 d and
 * 30 d charts from its hourly statistics (kept for good). The address is
 * what the router reports as its WAN IP; one in 100.64.0.0/10 is
 * carrier-grade NAT, so nothing from outside reaches the house through a
 * forwarded port.
 *
 * IT COSTS NOTHING WHILE NO ONE LOOKS
 * -----------------------------------
 * History is fetched when the card is put on a page and again every 5
 * minutes while it stays there and the tab is visible. Taken off the page
 * (the modal closed, the dashboard left) it stops its timer.
 *
 * Bump VERSION on every edit and re-register:
 *
 *     python HomeAssistant/tools/ha_dashboard.py --card router-console-card.js
 */

const CARD = "router-console-card";
const VERSION = "1.0.1";
import { cardTip } from "./card-tip.js?v=1.0.0";

const DEFAULTS = {
  download: "sensor.archer_c80_ac1900_mu_mimo_wi_fi_router_download_speed",
  upload: "sensor.archer_c80_ac1900_mu_mimo_wi_fi_router_upload_speed",
  external_ip: "sensor.archer_c80_ac1900_mu_mimo_wi_fi_router_external_ip",
  name: "Router",
  model: "Archer C80",
  range: "24h",
};

const RANGES = {
  "24h": { label: "24 h", ms: 24 * 3600e3 },
  "7d": { label: "7 d", ms: 7 * 24 * 3600e3 },
  "30d": { label: "30 d", ms: 30 * 24 * 3600e3 },
};
const RANGE_ORDER = ["24h", "7d", "30d"];

const REFRESH_MS = 5 * 60e3;
// The rates update every 30 s; ten minutes without one means the router stopped answering.
const STALE_MS = 10 * 60e3;
const MAX_POINTS = 360;

/* The house console palette (climate-console-card.js), literal. */
const BG = "#0f1214";
const PANEL = "#1a1e21";
const WELL = "#15191c";
const EDGE = "#262b30";
const HAIR = "#23282c";
const BTN_BG = "#1d2225";
const BTN_EDGE = "#33393f";
const TXT = "#e8eaed";
const MUTED = "#9aa0a6";
const DIM = "#7d838a";
const OK = "#5bd48a";
const WARN = "#e3b341";
const DOWN = "#5aa9ff";
const UP = "#4fd1b0";

/** Every description the card shows, lines 2-4 of a tooltip (house format). */
const HELP = {
  status: "Whether the router is answering: its rates arrive every 30 s over UPnP.\n"
    + "E.g. No data: it is off, rebooting, or HA lost its UPnP link; Stale: 10 min of silence.",
  download: "What the house pulls from the internet right now, every device together.\n"
    + "E.g. 50 Mbit/s for a 4K stream; the bar is against the highest rate in the last 24 h.\n"
    + "Tap: opens its dialog.",
  upload: "What the house sends to the internet right now: calls, backups, cameras.\n"
    + "E.g. 2–5 Mbit/s during a video call; the bar is against the highest rate in 24 h.\n"
    + "Tap: opens its dialog.",
  ip_cgnat: "The router's WAN address: in 100.64.0.0/10, the provider's carrier-grade NAT.\n"
    + "E.g. the public address is shared with other homes, so no port forward reaches in.\n"
    + "Tap: opens its dialog.",
  ip_private: "The router's WAN address is private: another router sits between it and the provider.\n"
    + "E.g. 192.168.1.x from the provider's box: a port forward needs that box too.\n"
    + "Tap: opens its dialog.",
  ip_public: "The router's WAN address: public, so a port forward on the router reaches the house.\n"
    + "E.g. it changes when the provider renews the lease; the time shows when it last did.\n"
    + "Tap: opens its dialog.",
  ip_none: "The router's WAN address, as UPnP reports it.\n"
    + "E.g. empty while the router is down or has no internet connection.\n"
    + "Tap: opens its dialog.",
  chart_raw: "Download and upload over the window, from the recorder's own readings.\n"
    + "E.g. a tall blue spike at night is a backup or an update pulling a few GB.",
  chart_stats: "Hourly averages from the recorder's statistics; the dashed lines are each hour's peak.\n"
    + "E.g. an evening hump every day is streaming; a flat week is the house away.",
  range: "Sets the chart's window: 24 h of readings, or 7 / 30 days of hourly averages.\n"
    + "E.g. 30 d to see whether the evenings got busier; the tiles above stay on today.",
};

/** A rate in Mbit/s from a state in any of the units HA uses for data rates. */
const TO_MBPS = {
  "bit/s": 1e-6, "kbit/s": 1e-3, "Mbit/s": 1, "Gbit/s": 1e3,
  "B/s": 8e-6, "kB/s": 8e-3, "MB/s": 8, "GB/s": 8e3,
  "KiB/s": 8 * 1024 / 1e6, "MiB/s": 8 * 1048576 / 1e6, "GiB/s": 8 * 1073741824 / 1e6,
};

function toMbps(value, unit) {
  const v = Number(value);
  if (value === null || value === undefined || value === "" || !isFinite(v)) return null;
  const k = TO_MBPS[unit || "KiB/s"];
  return k === undefined ? null : Math.max(0, v * k);
}

/** 0.65, 12.3, 245: as many decimals as the size deserves. */
function fmt(mbps) {
  if (mbps === null || mbps === undefined || !isFinite(mbps)) return "—";
  if (mbps < 1) return mbps.toFixed(2);
  if (mbps < 100) return mbps.toFixed(1);
  return String(Math.round(mbps));
}

/** What kind of WAN address this is: cgnat, private, public, or none. */
function ipKind(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || "").trim());
  if (!m) return "none";
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 100 && b >= 64 && b <= 127) return "cgnat";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  return "public";
}

const IP_WORD = { cgnat: "CGNAT", private: "Private", public: "Public", none: "None" };

/** A timestamp from a history row or a statistics row: seconds, milliseconds or ISO. */
function msOf(t) {
  if (typeof t === "number") return t < 1e12 ? t * 1000 : t;
  const v = Date.parse(t);
  return isFinite(v) ? v : null;
}

function pad(n) { return (n < 10 ? "0" : "") + n; }
function hm(ms) { const d = new Date(ms); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function day(ms) { const d = new Date(ms); return d.getDate() + " " + MONTHS[d.getMonth()]; }
/** "18:22" today, "9 Nov" before that. */
function when(ms, now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return ms >= d.getTime() ? hm(ms) : day(ms);
}

/** Keep at most `cap` points: the highest of each bucket, so a spike survives. */
function decimate(pts, cap) {
  if (pts.length <= cap) return pts;
  const step = pts.length / cap;
  const out = [];
  for (let i = 0; i < cap; i++) {
    const a = Math.floor(i * step);
    const b = Math.min(pts.length, Math.floor((i + 1) * step));
    let best = pts[a];
    for (let j = a + 1; j < b; j++) if (pts[j][1] > best[1]) best = pts[j];
    out.push(best);
  }
  return out;
}

/**
 * Peak and time-weighted average of a step series from `from` to `to`: each
 * reading holds until the next. Readings before `from` count from `from`.
 */
function summary(pts, from, to) {
  let peak = null;
  let area = 0;
  let span = 0;
  for (let i = 0; i < pts.length; i++) {
    const t0 = Math.max(pts[i][0], from);
    const t1 = Math.min(i + 1 < pts.length ? pts[i + 1][0] : to, to);
    if (t1 <= t0) continue;
    const v = pts[i][1];
    if (peak === null || v > peak) peak = v;
    area += v * (t1 - t0);
    span += t1 - t0;
  }
  return { peak: peak, avg: span > 0 ? area / span : null };
}

/* The shared Plex faces, verbatim from climate-console-card.js: same id, so whichever card
   loads first installs them for both. */
const FONTS = [
  ["IBM Plex Mono", 400, "cyrillic", "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116"],
  ["IBM Plex Mono", 500, "cyrillic", "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116"],
  ["IBM Plex Mono", 600, "cyrillic", "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116"],
  ["IBM Plex Mono", 400, "latin-ext", "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF"],
  ["IBM Plex Mono", 500, "latin-ext", "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF"],
  ["IBM Plex Mono", 600, "latin-ext", "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF"],
  ["IBM Plex Mono", 400, "latin", "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD"],
  ["IBM Plex Mono", 500, "latin", "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD"],
  ["IBM Plex Mono", 600, "latin", "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD"],
  ["IBM Plex Sans", "400 600", "cyrillic", "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116"],
  ["IBM Plex Sans", "400 600", "latin-ext", "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF"],
  ["IBM Plex Sans", "400 600", "latin", "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD"],
].map(function (f) {
  const sans = f[0] === "IBM Plex Sans";
  const file = sans
    ? "ibm-plex-sans-" + f[2] + ".woff2"
    : "ibm-plex-mono-" + f[1] + "-" + f[2] + ".woff2";
  return "@font-face{font-family:'" + f[0] + "';font-style:normal;font-weight:" + f[1]
    + ";font-display:swap;src:url('/local/fonts/" + file + "') format('woff2');"
    + "unicode-range:" + f[3] + "}";
}).join("\n");

/*
 * THE FACES GO ON THE DOCUMENT, NOT IN THIS CARD'S SHADOW ROOT.
 *
 * Chrome does not apply an @font-face rule declared inside a shadow tree: the
 * rule parses, CSSOM keeps it, and the font is never fetched. Nothing warns --
 * the text simply renders in the fallback. jkbms-battery-console-card.js has
 * the long version of this note; it found the bug in its own sibling.
 *
 * The id is shared with nothing: it names the FACES, not the card, so two
 * cards wanting the same Plex subset install it once between them.
 */
const FONT_STYLE_ID = "ha-console-ibm-plex-fonts";

function installFonts() {
  if (typeof document === "undefined" || !document.head) return;
  if (document.getElementById(FONT_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = FONT_STYLE_ID;
  style.textContent = FONTS;
  document.head.appendChild(style);
}

const STYLE = `
:host { display: block; container-type: inline-size; container-name: rcard; }
ha-card {
  display: block; overflow: hidden; background: ${BG}; color: ${TXT};
  font-family: 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif;
  border: 1px solid ${EDGE}; border-radius: 14px; box-shadow: none;
}
.root { display: flex; flex-direction: column; gap: 14px; padding: 18px 20px 20px; }
.hd { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding-right: 44px; }
.eyebrow { font: 500 11px 'IBM Plex Mono', ui-monospace, monospace; letter-spacing: .12em; color: ${DIM};
  text-transform: uppercase; }
h1 { margin: 2px 0 0; font: 600 26px/1.15 'IBM Plex Sans', system-ui, sans-serif; letter-spacing: -.01em; }
.pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px;
  font: 600 11px 'IBM Plex Mono', ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase;
  border: 1px solid ${BTN_EDGE}; background: ${WELL}; color: ${MUTED}; white-space: nowrap; }
.pill i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.pill.ok { color: ${OK}; border-color: rgba(91,212,138,.4); background: rgba(91,212,138,.08); }
.pill.warn { color: ${WARN}; border-color: rgba(227,179,65,.4); background: rgba(227,179,65,.08); }
.tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.tile { background: ${PANEL}; border: 1px solid ${EDGE}; border-radius: 12px; padding: 14px 16px;
  display: flex; flex-direction: column; gap: 6px; cursor: pointer; min-width: 0; }
.tile:hover { border-color: ${BTN_EDGE}; }
.tile:focus-visible { outline: 2px solid ${DOWN}; outline-offset: 2px; }
.lbl { font: 500 11px 'IBM Plex Mono', ui-monospace, monospace; letter-spacing: .1em; color: ${DIM};
  text-transform: uppercase; display: flex; align-items: center; gap: 6px; }
.lbl i { width: 8px; height: 8px; border-radius: 2px; }
.t-down .lbl i { background: ${DOWN}; }
.t-up .lbl i { background: ${UP}; }
.val { font: 600 30px/1.1 'IBM Plex Mono', ui-monospace, monospace; letter-spacing: -.02em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.val small { font-size: 13px; font-weight: 500; color: ${MUTED}; margin-left: 6px; letter-spacing: 0; }
.t-ip .val { font-size: 22px; line-height: 1.4; }
.bar { height: 6px; border-radius: 3px; background: ${WELL}; border: 1px solid ${HAIR}; overflow: hidden; }
.bar b { display: block; height: 100%; width: 0; border-radius: 3px; transition: width .6s ease; }
.t-down .bar b { background: ${DOWN}; }
.t-up .bar b { background: ${UP}; }
.sub { font: 400 12px 'IBM Plex Mono', ui-monospace, monospace; color: ${MUTED};
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tag { align-self: flex-start; padding: 2px 8px; border-radius: 6px; font: 600 11px 'IBM Plex Mono', monospace;
  letter-spacing: .06em; border: 1px solid ${BTN_EDGE}; color: ${MUTED}; }
.tag.cgnat, .tag.private { color: ${WARN}; border-color: rgba(227,179,65,.4); }
.tag.public { color: ${OK}; border-color: rgba(91,212,138,.4); }
.chart { background: ${PANEL}; border: 1px solid ${EDGE}; border-radius: 12px; padding: 14px 16px 12px;
  display: flex; flex-direction: column; gap: 10px; }
.ch-hd { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
h2 { margin: 0; font: 600 14px 'IBM Plex Sans', system-ui, sans-serif; }
.seg { display: inline-flex; border: 1px solid ${BTN_EDGE}; border-radius: 8px; overflow: hidden; }
.seg button { font: 500 12px 'IBM Plex Mono', ui-monospace, monospace; color: ${MUTED}; background: ${BTN_BG};
  border: 0; padding: 6px 12px; cursor: pointer; }
.seg button + button { border-left: 1px solid ${BTN_EDGE}; }
.seg button.on { color: ${TXT}; background: #2a3138; }
.seg button:focus-visible { outline: 2px solid ${DOWN}; outline-offset: -2px; }
.plot { position: relative; height: 200px; background: ${WELL}; border: 1px solid ${HAIR}; border-radius: 8px; }
.plot svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.plot .grid { stroke: ${HAIR}; stroke-width: 1; vector-effect: non-scaling-stroke; }
.plot .l-down { fill: none; stroke: ${DOWN}; stroke-width: 1.6; vector-effect: non-scaling-stroke; }
.plot .l-up { fill: none; stroke: ${UP}; stroke-width: 1.6; vector-effect: non-scaling-stroke; }
.plot .a-down { fill: rgba(90,169,255,.14); stroke: none; }
.plot .p-down, .plot .p-up { fill: none; stroke-width: 1; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke;
  opacity: .7; }
.plot .p-down { stroke: ${DOWN}; }
.plot .p-up { stroke: ${UP}; }
.ymax { position: absolute; top: 6px; left: 8px; font: 500 11px 'IBM Plex Mono', monospace; color: ${DIM}; }
.note { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font: 400 12px 'IBM Plex Mono', monospace; color: ${DIM}; text-align: center; padding: 0 16px; }
.note[hidden] { display: none; }
.axis { display: flex; justify-content: space-between; font: 400 11px 'IBM Plex Mono', monospace; color: ${DIM}; }
.legend { display: flex; gap: 16px; flex-wrap: wrap; font: 400 12px 'IBM Plex Sans', sans-serif; color: ${MUTED}; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend i { width: 14px; height: 3px; border-radius: 2px; }
.legend .k-down i { background: ${DOWN}; }
.legend .k-up i { background: ${UP}; }
.legend .k-peak i { background: repeating-linear-gradient(90deg, ${MUTED} 0 3px, transparent 3px 6px); }
.legend .k-peak[hidden] { display: none; }
@container rcard (max-width: 560px) {
  .root { padding: 14px 14px 16px; gap: 12px; }
  .tiles { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .t-ip { grid-column: 1 / -1; }
  .val { font-size: 24px; }
  .t-ip .val { font-size: 19px; }
  .plot { height: 170px; }
}
@container rcard (max-width: 340px) {
  .tiles { grid-template-columns: minmax(0, 1fr); }
}
@media (prefers-reduced-motion: reduce) { .bar b { transition: none; } }
`;

const TEMPLATE = `
<ha-card>
  <div class="root">
    <header class="hd">
      <div><div class="eyebrow"></div><h1></h1></div>
      <span class="pill"><i></i><span class="pill-t"></span></span>
    </header>
    <section class="tiles">
      <div class="tile t-down" role="button" tabindex="0">
        <div class="lbl"><i></i>Download</div>
        <div class="val"><span class="v"></span><small>Mbit/s</small></div>
        <div class="bar"><b></b></div>
        <div class="sub"></div>
      </div>
      <div class="tile t-up" role="button" tabindex="0">
        <div class="lbl"><i></i>Upload</div>
        <div class="val"><span class="v"></span><small>Mbit/s</small></div>
        <div class="bar"><b></b></div>
        <div class="sub"></div>
      </div>
      <div class="tile t-ip" role="button" tabindex="0">
        <div class="lbl">External IP</div>
        <div class="val"><span class="v"></span></div>
        <span class="tag"></span>
        <div class="sub"></div>
      </div>
    </section>
    <section class="chart">
      <div class="ch-hd">
        <h2>Throughput</h2>
        <div class="seg">
          <button type="button" data-act="range" data-val="24h">24 h</button>
          <button type="button" data-act="range" data-val="7d">7 d</button>
          <button type="button" data-act="range" data-val="30d">30 d</button>
        </div>
      </div>
      <div class="plot">
        <svg viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true">
          <line class="grid" x1="0" y1="50" x2="1000" y2="50"></line>
          <line class="grid" x1="0" y1="100" x2="1000" y2="100"></line>
          <line class="grid" x1="0" y1="150" x2="1000" y2="150"></line>
          <path class="a-down" d=""></path>
          <path class="p-down" d=""></path>
          <path class="p-up" d=""></path>
          <path class="l-up" d=""></path>
          <path class="l-down" d=""></path>
        </svg>
        <span class="ymax"></span>
        <div class="note" hidden></div>
      </div>
      <div class="axis"><span class="x0"></span><span class="x1"></span><span class="x2"></span></div>
      <div class="legend">
        <span class="k-down"><i></i>Download</span>
        <span class="k-up"><i></i>Upload</span>
        <span class="k-peak" hidden><i></i>Hourly peak</span>
      </div>
    </section>
  </div>
</ha-card>`;

class RouterConsoleCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    cardTip(this, this.shadowRoot);
    this._range = "24h";
    this._raw = null;      // { down: [[ms, mbps]], up: [...], from, to, note }
    this._stats = {};      // range -> { down, up, downMax, upMax, from, to, note }
    this._busy = new Set();
    this._timer = null;
    this._built = false;
    this._onVisible = () => { if (!document.hidden) this._refresh(false); };
    this.shadowRoot.addEventListener("click", (ev) => this._onClick(ev));
    this.shadowRoot.addEventListener("keydown", (ev) => {
      if ((ev.key === "Enter" || ev.key === " ") && this._onClick(ev)) ev.preventDefault();
    });
  }

  setConfig(config) {
    const cfg = Object.assign({}, DEFAULTS, config || {});
    ["download", "upload", "external_ip"].forEach((k) => {
      if (typeof cfg[k] !== "string" || cfg[k].indexOf(".") < 1) {
        throw new Error(CARD + ": " + k + " must be an entity id, got " + cfg[k]);
      }
    });
    if (RANGE_ORDER.indexOf(cfg.range) < 0) {
      throw new Error(CARD + ": range must be one of " + RANGE_ORDER.join(", ") + ", got " + cfg.range);
    }
    this._config = cfg;
    this._range = cfg.range;
    this._raw = null;
    this._stats = {};
    this._built = false;
    if (this._hass) this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this._config) return;
    this._render();
    if (first && this.isConnected) this._refresh(false);
  }

  connectedCallback() {
    installFonts();
    if (!this._timer) this._timer = window.setInterval(() => this._refresh(false), REFRESH_MS);
    if (typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", this._onVisible);
    }
    if (this._hass && this._config) this._refresh(false);
  }

  disconnectedCallback() {
    if (this._timer) window.clearInterval(this._timer);
    this._timer = null;
    if (typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", this._onVisible);
    }
  }

  getCardSize() { return 9; }

  getGridOptions() { return { columns: "full", rows: "auto", min_columns: 6 }; }

  static getStubConfig() { return {}; }

  // --- reading -------------------------------------------------------------

  _st(id) { return (this._hass && this._hass.states && this._hass.states[id]) || null; }

  /** A rate entity now: { mbps, unit, at, ok }. */
  _rate(id) {
    const st = this._st(id);
    if (!st) return { mbps: null, at: null, ok: false };
    const unit = st.attributes && st.attributes.unit_of_measurement;
    const mbps = toMbps(st.state, unit);
    const at = msOf(st.last_updated || st.last_changed);
    return { mbps: mbps, unit: unit, at: at, ok: mbps !== null };
  }

  _status(now) {
    const d = this._rate(this._config.download);
    const u = this._rate(this._config.upload);
    if (!d.ok && !u.ok) return { word: "No data", tone: "warn" };
    const at = Math.max(d.at || 0, u.at || 0);
    if (at && now - at > STALE_MS) return { word: "Stale", tone: "warn", at: at };
    return { word: "Online", tone: "ok", at: at };
  }

  // --- history -------------------------------------------------------------

  /** Fetch what the visible card needs: today's readings always, the range's statistics when it has them. */
  _refresh(force) {
    if (!this._hass || !this._config || typeof this._hass.callWS !== "function") return;
    if (typeof document !== "undefined" && document.hidden) return;
    const now = Date.now();
    if (force || !this._raw || now - this._raw.at > REFRESH_MS - 5000) this._fetchRaw(now);
    if (this._range !== "24h") {
      const s = this._stats[this._range];
      if (force || !s || now - s.at > REFRESH_MS - 5000) this._fetchStats(this._range, now);
    }
  }

  async _fetchRaw(now) {
    if (this._busy.has("raw")) return;
    this._busy.add("raw");
    const c = this._config;
    const from = now - RANGES["24h"].ms;
    const rec = { at: now, from: from, to: now, down: [], up: [], note: null };
    try {
      const reply = await this._hass.callWS({
        type: "history/history_during_period",
        start_time: new Date(from).toISOString(),
        end_time: new Date(now).toISOString(),
        entity_ids: [c.download, c.upload],
        minimal_response: true,
        no_attributes: true,
        significant_changes_only: false,
      });
      rec.down = this._parseHistory(reply, c.download);
      rec.up = this._parseHistory(reply, c.upload);
      if (!rec.down.length && !rec.up.length) rec.note = "no history recorded";
    } catch (err) {
      rec.note = "history unavailable" + (err && (err.message || err.code) ? " — " + (err.message || err.code) : "");
    }
    this._busy.delete("raw");
    this._raw = rec;
    if (this._built) this._paint();
  }

  async _fetchStats(range, now) {
    const key = "stats:" + range;
    if (this._busy.has(key)) return;
    this._busy.add(key);
    const c = this._config;
    const from = now - RANGES[range].ms;
    const rec = { at: now, from: from, to: now, down: [], up: [], downMax: [], upMax: [], note: null };
    try {
      const reply = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: new Date(from).toISOString(),
        end_time: new Date(now).toISOString(),
        statistic_ids: [c.download, c.upload],
        period: "hour",
        types: ["mean", "max"],
      });
      [["down", c.download], ["up", c.upload]].forEach(([k, id]) => {
        const unit = this._unitOf(id);
        ((reply && reply[id]) || []).forEach((r) => {
          const t = msOf(r.start);
          if (t === null) return;
          const mean = toMbps(r.mean, unit);
          const max = toMbps(r.max, unit);
          if (mean !== null) rec[k].push([t, mean]);
          if (max !== null) rec[k + "Max"].push([t, max]);
        });
      });
      if (!rec.down.length && !rec.up.length) rec.note = "no long-term statistics";
    } catch (err) {
      rec.note = "statistics unavailable" + (err && (err.message || err.code) ? " — " + (err.message || err.code) : "");
    }
    this._busy.delete(key);
    this._stats[range] = rec;
    if (this._built) this._paint();
  }

  _unitOf(id) {
    const st = this._st(id);
    return (st && st.attributes && st.attributes.unit_of_measurement) || "KiB/s";
  }

  /** [[ms, mbps]] from a history reply, in either the compressed or the full row shape. */
  _parseHistory(reply, id) {
    const unit = this._unitOf(id);
    const out = [];
    ((reply && reply[id]) || []).forEach((r) => {
      const t = msOf(r.lu !== undefined ? r.lu : r.last_updated !== undefined ? r.last_updated
        : r.lc !== undefined ? r.lc : r.last_changed);
      const v = toMbps(r.s !== undefined ? r.s : r.state, unit);
      if (t !== null && v !== null) out.push([t, v]);
    });
    return out.sort((a, b) => a[0] - b[0]);
  }

  // --- drawing -------------------------------------------------------------

  _q(sel) { return this.shadowRoot.querySelector(sel); }

  _build() {
    this.shadowRoot.innerHTML = "<style>" + STYLE + "</style>" + TEMPLATE;
    const c = this._config;
    this._q(".eyebrow").textContent = c.model + " · UPnP";
    this._q("h1").textContent = c.name;
    this._q(".t-down").setAttribute("data-more", c.download);
    this._q(".t-up").setAttribute("data-more", c.upload);
    this._q(".t-ip").setAttribute("data-more", c.external_ip);
    this._built = true;
  }

  _render() {
    if (!this._built) this._build();
    this._paint();
  }

  _paint() {
    const c = this._config;
    const now = Date.now();
    const status = this._status(now);
    const pill = this._q(".pill");
    pill.className = "pill " + status.tone;
    this._q(".pill-t").textContent = status.word;
    pill.setAttribute("data-tip", c.name + " — " + status.word.toUpperCase()
      + (status.at ? " · last reading " + hm(status.at) : "") + "\n" + HELP.status);

    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const raw = this._raw;
    [["down", c.download, ".t-down", "Download"], ["up", c.upload, ".t-up", "Upload"]].forEach(([k, id, sel, name]) => {
      const r = this._rate(id);
      const tile = this._q(sel);
      const series = raw ? raw[k] : [];
      const today = summary(series.concat(r.ok ? [[now, r.mbps]] : []), midnight.getTime(), now);
      const day = summary(series, now - RANGES["24h"].ms, now);
      const scale = Math.max(day.peak || 0, r.mbps || 0);
      tile.querySelector(".v").textContent = fmt(r.mbps);
      // Empty until the 24 h peak is known: against the live rate alone it would read 100%.
      const known = raw && !raw.note && series.length;
      tile.querySelector(".bar b").style.width = (known && r.ok && scale > 0
        ? Math.min(100, (r.mbps / scale) * 100) : 0) + "%";
      tile.querySelector(".sub").textContent = raw && !raw.note
        ? "peak " + fmt(today.peak) + " · avg " + fmt(today.avg) + " today"
        : raw && raw.note ? raw.note : "loading today…";
      tile.setAttribute("data-tip", name + " — " + (r.ok ? fmt(r.mbps) + " Mbit/s" : "no data")
        + (today.peak !== null ? " · peak today " + fmt(today.peak) : "") + "\n" + HELP[k === "down" ? "download" : "upload"]);
      tile.setAttribute("aria-label", name + " " + fmt(r.mbps) + " Mbit/s");
    });

    const ipSt = this._st(c.external_ip);
    const ip = ipSt && ["unknown", "unavailable", ""].indexOf(ipSt.state) < 0 ? ipSt.state : "";
    const kind = ipKind(ip);
    const ipTile = this._q(".t-ip");
    ipTile.querySelector(".v").textContent = ip || "—";
    const tag = ipTile.querySelector(".tag");
    tag.className = "tag " + kind;
    tag.textContent = kind === "cgnat" ? "CGNAT · no inbound ports" : kind === "private" ? "Behind another router"
      : kind === "public" ? "Public address" : "No address";
    const since = ipSt ? msOf(ipSt.last_changed) : null;
    ipTile.querySelector(".sub").textContent = since ? "since " + when(since, now) : "";
    ipTile.setAttribute("data-tip", "External IP — " + (ip || "none") + " · " + IP_WORD[kind]
      + (since ? " since " + when(since, now) : "") + "\n" + HELP["ip_" + kind]);
    ipTile.setAttribute("aria-label", "External IP " + (ip || "none"));

    this.shadowRoot.querySelectorAll(".seg button").forEach((b) => {
      const on = b.getAttribute("data-val") === this._range;
      b.className = on ? "on" : "";
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.setAttribute("data-tip", "Range " + RANGES[b.getAttribute("data-val")].label + " — "
        + (on ? "shown" : "tap to show") + "\n" + HELP.range);
    });
    this._paintChart(now);
  }

  _paintChart(now) {
    const stats = this._range !== "24h";
    const rec = stats ? this._stats[this._range] : this._raw;
    const from = now - RANGES[this._range].ms;
    const plot = this._q(".plot");
    const note = this._q(".note");
    const paths = {
      ld: this._q(".l-down"), lu: this._q(".l-up"), ad: this._q(".a-down"),
      pd: this._q(".p-down"), pu: this._q(".p-up"),
    };
    Object.values(paths).forEach((p) => p.setAttribute("d", ""));
    this._q(".k-peak").hidden = !stats;
    const label = (t) => (this._range === "24h" ? hm(t) : day(t));
    this._q(".x0").textContent = label(from);
    this._q(".x1").textContent = label(from + (now - from) / 2);
    this._q(".x2").textContent = "now";

    let down = [];
    let up = [];
    let pd = [];
    let pu = [];
    if (rec && !rec.note) {
      down = rec.down.slice();
      up = rec.up.slice();
      if (stats) { pd = rec.downMax; pu = rec.upMax; } else {
        // Each reading holds until the next; the live one closes the line at now.
        const d = this._rate(this._config.download);
        const u = this._rate(this._config.upload);
        if (d.ok) down.push([now, d.mbps]);
        if (u.ok) up.push([now, u.mbps]);
      }
    }
    down = decimate(down.filter((p) => p[0] >= from - 3600e3), MAX_POINTS);
    up = decimate(up.filter((p) => p[0] >= from - 3600e3), MAX_POINTS);
    pd = decimate(pd.filter((p) => p[0] >= from), MAX_POINTS);
    pu = decimate(pu.filter((p) => p[0] >= from), MAX_POINTS);
    const all = down.concat(up, pd, pu).map((p) => p[1]);
    const top = Math.max(1, ...all) * 1.1;
    const x = (t) => Math.max(0, Math.min(1000, ((t - from) / (now - from)) * 1000));
    const y = (v) => 200 - (v / top) * 196;
    const line = (pts, step) => {
      if (!pts.length) return "";
      let d = "M" + x(pts[0][0]).toFixed(1) + " " + y(pts[0][1]).toFixed(1);
      for (let i = 1; i < pts.length; i++) {
        if (step) d += " H" + x(pts[i][0]).toFixed(1);
        d += " L" + x(pts[i][0]).toFixed(1) + " " + y(pts[i][1]).toFixed(1);
      }
      return d;
    };
    paths.ld.setAttribute("d", line(down, !stats));
    paths.lu.setAttribute("d", line(up, !stats));
    if (down.length) {
      paths.ad.setAttribute("d", line(down, !stats) + " L" + x(down[down.length - 1][0]).toFixed(1)
        + " 200 L" + x(down[0][0]).toFixed(1) + " 200 Z");
    }
    paths.pd.setAttribute("d", line(pd, false));
    paths.pu.setAttribute("d", line(pu, false));
    this._q(".ymax").textContent = all.length ? fmt(top) + " Mbit/s" : "";

    const empty = !rec ? "loading…" : rec.note ? rec.note : !down.length && !up.length ? "no readings in this window" : "";
    note.textContent = empty;
    note.hidden = !empty;

    const peakD = down.length ? Math.max(...down.map((p) => p[1])) : null;
    const peakU = up.length ? Math.max(...up.map((p) => p[1])) : null;
    const maxD = pd.length ? Math.max(...pd.map((p) => p[1])) : peakD;
    const maxU = pu.length ? Math.max(...pu.map((p) => p[1])) : peakU;
    plot.setAttribute("data-tip", "Throughput — " + RANGES[this._range].label
      + (empty ? " · " + empty : " · peak " + fmt(maxD) + " down, " + fmt(maxU) + " up Mbit/s")
      + "\n" + (stats ? HELP.chart_stats : HELP.chart_raw));
  }

  // --- interaction ---------------------------------------------------------

  _moreInfo(entityId) {
    if (!entityId) return;
    this.dispatchEvent(new CustomEvent("hass-more-info", {
      detail: { entityId: entityId }, bubbles: true, composed: true,
    }));
  }

  /** True when the event hit something of the card's. */
  _onClick(ev) {
    const path = ev.composedPath ? ev.composedPath() : [ev.target];
    for (const node of path) {
      if (!node || node === this.shadowRoot || !node.getAttribute) continue;
      const act = node.getAttribute("data-act");
      if (act === "range") {
        const val = node.getAttribute("data-val");
        if (RANGES[val] && val !== this._range) {
          this._range = val;
          this._paint();
          this._refresh(false);
        }
        return true;
      }
      const more = node.getAttribute("data-more");
      if (more) { this._moreInfo(more); return true; }
    }
    return false;
  }
}

if (!customElements.get(CARD)) customElements.define(CARD, RouterConsoleCard);

window.customCards = window.customCards || [];
if (!window.customCards.some((x) => x.type === CARD)) {
  window.customCards.push({
    type: CARD,
    name: "Router console",
    description: "The router's live rates, their history and its WAN address.",
    preview: false,
  });
}

installFonts();

console.info("%c " + CARD + " %c " + VERSION + " ",
  "background:#1a1e21;color:#5aa9ff;font-weight:600",
  "background:#0f1214;color:#9aa0a6");
