/**
 * DTEK Shutdowns card.
 *
 * Draws the whole Shutdowns page: the power now beside a 24-hour clock of
 * today, today's timeline of DTEK's claims against the inverter, DTEK's weekly
 * table and where the data came from. Registered as a Lovelace resource, so it
 * is handed `hass` directly -- no token, no iframe, no CORS.
 *
 * WHY THIS IS NOT MARKDOWN CARDS
 * ------------------------------
 * The first iteration drew these tables with block characters inside a code
 * fence, because HA sanitises markdown through filterXSS
 * (frontend/src/resources/markdown-worker.ts) and its allowlist carries no
 * `style` attribute, no <style> tag and no `title` on div/span. There is no
 * inline CSS to be had in a markdown card, and no core card draws a heatmap.
 * A custom element has its own shadow root and none of those limits.
 *
 * WHERE THE DATA COMES FROM
 * -------------------------
 * Almost all of it is attributes of ONE entity, sensor.dtek_shutdowns, written
 * by /config/dtek/dtek_poll.py. In particular `week` -- seven 24-character
 * strings, Monday first -- exists only there; it is deliberately not
 * re-exposed on sensor.dtek_schedule_state_now.
 *
 * THE LOOK (2.0)
 * -------------
 * The house's console palette, like the Power station cards: graphite panels,
 * muted sage / amber / red, IBM Plex Sans and Mono served from /local/fonts/.
 * The colours are the card's own (--ds-* on :host), not the HA theme's, so the
 * page reads the same under the light theme; the tests check every text pair
 * against 4.5:1. Blocks, in the order a config lists them:
 *
 *   hero      what the power is doing, in words, beside a 24-hour clock of
 *             today's schedule with a hand at now and the countdown inside;
 *   timeline  today 00-24 on four rows: grid down (measured), DTEK's live
 *             notice, the schedule, and outages nobody announced. The past
 *             comes from the recorder (history/history_during_period),
 *             fetched only while the card is on screen;
 *   week      DTEK's recurring table, a column per day; while a schedule is
 *             applied, today's and tomorrow's columns show it instead;
 *   days      the applied today and tomorrow alone (kept for old configs);
 *   source    where the data comes from.
 */

const CARD = "dtek-shutdowns-card";
import { cardTip } from "./card-tip.js?v=1.0.0";

const VERSION = "2.1.2";

/*
 * The grid shows the NORMAL condition, not the exception: a cell is green when
 * the power is confirmed on and dim when it is not. That is the inverse of the
 * design, which painted 16 orange hours a day and left the six good ones grey.
 * With this queue's data the old scheme lit up almost the whole week, which
 * reads as alarm and carries no information.
 *
 * These are HA's own semantic colours, so the card follows a theme that
 * redefines them instead of arguing with it. The fallbacks are the default
 * dark theme's values.
 */
const GREEN = "var(--ds-ok)";
const RED = "var(--ds-bad)";
const ORANGE = "var(--ds-warn)";

/*
 * IBM Plex, served from /local/fonts/ like the Power station cards. Chrome
 * ignores an @font-face declared inside a shadow tree (see the long note in
 * jkbms-battery-console-card.js), so the faces go on document.head, once.
 */
const FONT_STYLE_ID = "dtek-shutdowns-card-fonts";
// Each file covers one script: without its unicode-range the later face would
// claim every character and the other script would fall back.
const LATIN = "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, "
  + "U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";
const CYRILLIC = "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116";
const FONTS = [
  ["IBM Plex Mono", 400, "ibm-plex-mono-400-latin.woff2", LATIN],
  ["IBM Plex Mono", 500, "ibm-plex-mono-500-latin.woff2", LATIN],
  ["IBM Plex Mono", 600, "ibm-plex-mono-600-latin.woff2", LATIN],
  ["IBM Plex Mono", 400, "ibm-plex-mono-400-cyrillic.woff2", CYRILLIC],
  ["IBM Plex Sans", "400 600", "ibm-plex-sans-latin.woff2", LATIN],
  ["IBM Plex Sans", "400 600", "ibm-plex-sans-cyrillic.woff2", CYRILLIC],
].map(([family, weight, file, range]) => "@font-face{font-family:'" + family + "';font-style:normal;"
  + "font-weight:" + weight + ";font-display:swap;src:url('/local/fonts/" + file + "') format('woff2');"
  + "unicode-range:" + range + "}")
  .join("\n");

function installFonts() {
  if (typeof document === "undefined" || !document.head) return;
  if (document.getElementById(FONT_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = FONT_STYLE_ID;
  style.textContent = FONTS;
  document.head.appendChild(style);
}

/*
 * Mirrors STATE_LETTER and OFF_HALVES in config/dtek/dtek_poll.py.
 *
 * `off` is hours of darkness in that cell, so `maybe` counts as fully dark --
 * the same call OFF_HALVES makes, and the one binary_sensor.dtek_scheduled_dark
 * and the outage alert already act on.
 *
 * tools/check_dtek_templates.py asserts every letter below is still here, so
 * this table cannot silently drift from the poller's.
 */
const STATE = {
  y: { cls: "on", off: 0, label: "power on" },
  n: { cls: "out", off: 1, label: "scheduled outage" },
  m: { cls: "maybe", off: 1, label: "possible outage" },
  f: { cls: "out-1", off: 0.5, label: "outage, first half hour" },
  s: { cls: "out-2", off: 0.5, label: "outage, second half hour" },
  F: { cls: "maybe-1", off: 0.5, label: "possible outage, first half hour" },
  S: { cls: "maybe-2", off: 0.5, label: "possible outage, second half hour" },
  "?": { cls: "unknown", off: 0, label: "unknown" },
};
/*
 * The half-hour classes come straight off OFF_HALVES in dtek_poll.py, which is
 * the only reason they can be drawn as split cells at all:
 *
 *   first / mfirst   -> (True, False)  top half dark, bottom half LIT
 *   second / msecond -> (False, True)  top half LIT, bottom half dark
 *
 * So the green half of a split cell is not decoration -- it is the half of the
 * hour DTEK says the power is on for.
 */

// Letters whose darkness DTEK states outright, rather than hedging with
// "possible outage" ("mozhlyve vidkliuchennia").
const CERTAIN = "nfs";
// A window opening on a second-half state really opens at HH:30, and one
// closing on a first-half state really closes at HH:30.
const SECOND_HALF_ONLY = "sS";
const FIRST_HALF_ONLY = "fF";

// outage_type as dtek_poll.py's status_for() reads it. Only reached when DTEK
// reports an outage and sends no reason text with it, which it often does.
const OUTAGE_TYPE = { 1: "Planned outage", 2: "Emergency outage" };

// Why DTEK is not drawing the recurring table, keyed by the token dtek_poll.py
// puts in `hidden_reason`. Split by whether the table comes back on its own:
// plan_off and the two empty cases lift when Ukrenergo resumes scheduling, but
// cek, voluntarily and no_queue are properties of this building and will not.
const WITHHELD = {
  plan_off: "DTEK is not publishing a recurring table right now. Awaiting "
    + "updated schedules.",
  table_off: "DTEK is not publishing a recurring table right now. Awaiting "
    + "updated schedules.",
  empty_preset: "DTEK is not publishing a recurring table right now. Awaiting "
    + "updated schedules.",
  no_queue: "DTEK lists no outage queue for this address, so there is no "
    + "recurring table to draw.",
  unknown_queue: "DTEK reports a queue it publishes no table for.",
  cek: "This building is fed by PrAT PEEM TsEK rather than by DTEK, which is why "
    + "DTEK publishes no schedule for it.",
  voluntarily: "The building is being switched by its own "
    + "housing association (OSBB/ZhEK), not to a DTEK schedule.",
  emergency_no_schedule: "Emergency outages are running without a scheduled "
    + "table. Restoration times follow the grid, not a plan.",
};

// The reasons that lift by themselves once Ukrenergo resumes scheduling. The
// rest are properties of this building, and for those "DTEK has withdrawn the
// table" and "last published on ..." are both false -- there never was one.
const WILL_RETURN = ["plan_off", "table_off", "empty_preset",
                     "emergency_no_schedule"];

/*
 * Lines 2-4 of every tooltip on the card (docs/dashboard-tooltips.md). Line 1
 * is the live name and state, built by tip() at render time. Repeated items
 * share one entry: all 168 grid cells are `cell`, all seven totals `day_total`.
 * Keep in step with docs/dtek-outage-schedule.md.
 */
const HELP = {
  now: "The pill and the glow: red without mains, amber for a DTEK claim or a window soon.\n"
    + "E.g. green: mains present and nothing scheduled within the hour.",
  clock_hour: "One hour of today on the clock: the applied schedule, else the weekly table.\n"
    + "E.g. red 14:00–15:00: DTEK has the power off then; dim hours are already past.",
  clock_emergency: "The outage in DTEK's live notice, from its start to the time it gives for power back.\n"
    + "E.g. hatched red 13:50–17:54: emergency repairs, drawn over whatever the schedule says.",
  clock_center: "The countdown to the next change, or the state when nothing is ahead.\n"
    + "E.g. 3h 46m until back: DTEK's notice has the power back in under four hours.",
  tl_row: "One of four claims about today, 00:00–24:00, against the same hours as the clock.\n"
    + "E.g. Grid down is the inverter's measurement; the other three are what DTEK says.\n"
    + "Tap the name or the bar: opens the sensor's dialog, with its history.",
  tl_block: "A stretch of today when this row says the power is off.\n"
    + "E.g. 14:00–18:00, 4h 0m on the schedule row: DTEK's window for this afternoon.",
  ident: "The street and house as DTEK spells them, and the outage queue DTEK puts us in.\n"
    + "E.g. comes from secrets.yaml on the box, so the address is never typed into git.",
  headline: "Mains as the inverter measures it; DTEK's notice counts only while mains is up.\n"
    + "E.g. mains present but DTEK lists an outage: “DTEK reports an outage.”, in orange.",
  reason: "DTEK's own words for why the power is off; “Not reported” outside an outage.\n"
    + "E.g. on 29.09.2026 DTEK gave emergency repairs, in Ukrainian as DTEK writes it.",
  started: "When DTEK says this outage began, in DTEK's own notation.\n"
    + "E.g. the 29.09.2026 emergency started at 11:05.",
  expected: "DTEK's estimate of when the power returns, and the countdown to it.\n"
    + "E.g. 29.09.2026: by 15:25; once that time passes it reads “overdue”.",
  scope: "How many houses on our street DTEK lists an outage for.\n"
    + "E.g. 29.09.2026: only this building of 288, so a fault here, not on the line.",
  updated: "DTEK's own “information updated” stamp, normally only minutes old.\n"
    + "E.g. 14:01 29.09.2026, during the emergency that had started at 11:05.",
  next: "The next dark stretch: DTEK's applied schedule if any, else the weekly table.\n"
    + "E.g. 19:30–02:30+1 runs from 19:30 until 02:30 the next day.\n"
    + "A dash: DTEK publishes no table to forecast from.",
  week_off: "Dark hours in this week's recurring table, possible outages counted as off.\n"
    + "E.g. 16 dark hours every day come to 112h, 67% of the 168-hour week.\n"
    + "A dash: DTEK publishes no table to count.",
  feed: "Whether the DTEK poller still gets fresh, readable answers every 5 minutes.\n"
    + "E.g. Stale: the last poll failed, so the card shows the last good answer.\n"
    + "Drift: DTEK answered, but sent a field or format the poller cannot read.",
  cell: "One hour of DTEK's recurring weekly table; it repeats until DTEK publishes anew.\n"
    + "E.g. grey on top, green below: a possible outage until :30, then power.",
  day_total: "Dark hours that day in the weekly table, possible outages counted as off.\n"
    + "E.g. 16 grey hours plus two half-hour splits make 17h.",
  sched_cell: "One hour of the stabilisation schedule DTEK has applied to this day.\n"
    + "E.g. 17.10.2026 13:00: green on top, red below -- power until 13:30, then off.",
  sched_total: "Dark hours that day in the applied schedule, possible outages counted as off.\n"
    + "E.g. 17.10.2026: 13:30-17:00 off makes 3.5h.\n"
    + "A dash: DTEK has not published that day yet.",
  legend_on: "DTEK says the power stays on for the whole hour.\n"
    + "E.g. Mo 07:00 green: no outage of any kind is planned 07:00–08:00.",
  legend_maybe: "DTEK may cut the power that hour; the totals and the alerts count it as off.\n"
    + "E.g. most of this queue's week is grey: DTEK hedges rather than commits.",
  legend_out: "DTEK commits to the power being off for the whole hour.\n"
    + "E.g. red at Mo 19:00: no grid from 19:00 to 20:00, for certain.",
  legend_half: "A split cell: the green half is the half hour DTEK says the power is on.\n"
    + "E.g. green on top, grey below: power until :30, then a possible outage.",
  legend_unsched: "Off while DTEK's schedule and its notices both said the power would be on.\n"
    + "E.g. 10:15–11:00 amber: the inverter lost the grid and nobody had announced it.",
  legend_now: "The outlined cell is the current hour, in today's highlighted column.\n"
    + "E.g. at 14:20 on a Monday the Mo 14:00 cell is outlined.",
  last_poll: "When the poller last got a good answer from DTEK; it asks every 5 minutes.\n"
    + "E.g. 14:05 still shown at 14:30 means five polls in a row have failed.",
  drift: "Something in DTEK's answer the poller could not read, shown as DTEK wrote it.\n"
    + "E.g. “unreadable end_date”: DTEK changed its date format, as on 29.09.2026.",
  published: "When DTEK last published a stabilisation schedule, not when it last answered.\n"
    + "E.g. 24.07.2026 08:30 has stood since DTEK suspended the schedules that day.",
  table: "Whether DTEK itself draws the weekly table; the grid on this page follows it.\n"
    + "E.g. hidden (plan_off): DTEK stopped drawing it, so a note replaces the grid.",
  interval: "How often Home Assistant runs the DTEK poller.\n"
    + "E.g. 5 min, the same cadence DTEK's own page uses to re-check itself.",
};

const DAY_SHORT = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const DAY_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
                  "Saturday", "Sunday"];

const DEFAULTS = {
  entity: "sensor.dtek_shutdowns",
  // on = UNSAFE. That is the ESPHome firmware's polarity, see the POLARITY
  // WARNING in packages/dtek_shutdowns.yaml. This is the measurement; the DTEK
  // attributes are the claim, and the hero is driven by the measurement.
  grid_entity: "binary_sensor.grid_down",
  unscheduled_entity: "binary_sensor.grid_outage_unscheduled",
  stale_entity: "binary_sensor.dtek_data_stale",
  // The timeline's other two rows: DTEK's live notice, and the schedule.
  outage_entity: "binary_sensor.dtek_outage_now",
  scheduled_entity: "binary_sensor.dtek_scheduled_dark",
  poll_interval: 5, // minutes; matches scan_interval: 300 on the sensor
  debug_state: null, // on | outage | dtek | unscheduled | stale -- render only
  // Which of the three blocks this instance draws, in the order given.
  //
  // It exists so the provenance block can sit BELOW the claim-against-
  // measurement section, which is a separate dashboard section and cannot be
  // reordered from inside a card. Not a styling knob -- see BLOCKS.
  blocks: ["hero", "timeline", "week", "source"],
};

const BLOCKS = ["hero", "timeline", "days", "week", "source"];
// How often the timeline asks the recorder again while nothing it shows changed.
const HISTORY_TTL = 5 * 60000;

const DEBUG_STATES = ["on", "outage", "dtek", "unscheduled", "stale"];

const DASH = "–"; // en dash, for 07:00-10:00
const MDASH = "—";
const MIDDOT = "·";

// --- small helpers ---------------------------------------------------------

// outage_reason and friendly_name are free text off a third-party website, and
// everything below is assembled into an HTML string. Escape without exception.
const ESCAPES = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
const esc = (v) => String(v === null || v === undefined ? "" : v)
  .replace(/[&<>"']/g, (c) => ESCAPES[c]);

const pad2 = (n) => String(n).padStart(2, "0");

/**
 * A ` data-tip="..."` attribute: "<name> — <state>" (or just the name), then
 * HELP[key]. Line 1 is clipped at 90 characters, because a reason or a drift
 * warning is free text off DTEK's site and a tooltip box is not a page.
 */
function tip(name, state, key) {
  let first = state === null || state === undefined || state === ""
    ? name : name + " " + MDASH + " " + state;
  if (first.length > 90) first = first.slice(0, 89) + "…";
  return ' data-tip="' + esc(first + "\n" + HELP[key]) + '"';
}

/** 17 -> "17h", 16.5 -> "16.5h". Half-hour states make the fractions real. */
const fmtHours = (h) =>
  (Math.abs(h - Math.round(h)) < 0.001 ? String(Math.round(h)) : h.toFixed(1)) + "h";

/** Cell index to a wall clock reading, half meaning the :30 boundary. */
const clock = (h, half) => pad2(((h % 24) + 24) % 24) + (half ? ":30" : ":00");

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function fmtClock(value) {
  const d = parseDate(value);
  return d ? pad2(d.getHours()) + ":" + pad2(d.getMinutes()) : null;
}

/** "11:05 29.09.2026" -- DTEK's own notation, so the card reads like the site. */
function fmtStamp(value) {
  const d = parseDate(value);
  return d ? fmtClock(value) + " " + pad2(d.getDate()) + "."
    + pad2(d.getMonth() + 1) + "." + d.getFullYear() : null;
}

/** "in 2h 58m", "in 14m". The mockup's countdown, from whole minutes. */
function fmtIn(minutes) {
  if (minutes <= 0) return "now";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return "in " + (h ? h + "h " + m + "m" : m + "m");
}

const isOff = (letter) => {
  const st = STATE[letter];
  return !!st && st.off > 0;
};

/**
 * The stretches an entity was "on", from a history_during_period answer, as
 * [start, end] in ms, clipped to [from, to]. minimal_response rows are {s, lu}
 * (lu in seconds); full rows are {state, last_changed}. Each state lasts until
 * the next row, the last one until `to`.
 */
function onSpans(rows, from, to) {
  if (!Array.isArray(rows)) return [];
  const pts = rows.map((r) => ({
    on: (r.s !== undefined ? r.s : r.state) === "on",
    t: r.lu !== undefined ? r.lu * 1000 : Date.parse(r.last_changed || r.last_updated),
  })).filter((p) => !isNaN(p.t)).sort((a, b) => a.t - b.t);
  const out = [];
  pts.forEach((p, i) => {
    if (!p.on) return;
    const a = Math.max(from, p.t);
    const b = Math.min(to, i + 1 < pts.length ? pts[i + 1].t : to);
    if (b > a) out.push([a, b]);
  });
  return out;
}

/** Hours of darkness in one 24-character day string. */
function offHours(row) {
  let off = 0;
  for (let h = 0; h < 24; h++) off += (STATE[row[h]] || STATE["?"]).off;
  return off;
}

// --- the applied schedule (today / tomorrow) -------------------------------

/** Is half `half` (0 = :00-:29, 1 = :30-:59) of this letter's hour dark? */
function halfDark(letter, half) {
  const st = STATE[letter];
  if (!st || st.off === 0) return false;
  if (st.off === 1) return true;
  return FIRST_HALF_ONLY.indexOf(letter) >= 0 ? half === 0 : half === 1;
}

/**
 * The dark stretch of the applied schedule that `now` falls in, or null.
 *
 * today and tomorrow become one run of 96 half hours, the same slots
 * dtek_poll.py's half_hour_slots() builds. An unpublished tomorrow is not
 * dark, so a window running into it ends at midnight with `open` set.
 */
function scheduleWindow(today, tomorrow, now) {
  if (typeof today !== "string" || today.length !== 24) return null;
  const days = [today, typeof tomorrow === "string" && tomorrow.length === 24 ? tomorrow : null];
  const dark = (i) => {
    const row = days[Math.floor(i / 48)];
    return !!row && halfDark(row[Math.floor((i % 48) / 2)], i % 2);
  };
  const slot = now.getHours() * 2 + (now.getMinutes() >= 30 ? 1 : 0);
  if (!dark(slot)) return null;
  let start = slot;
  while (start > 0 && dark(start - 1)) start--;
  let end = slot;
  while (end < 95 && dark(end + 1)) end++;
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const at = (i) => new Date(base.getTime() + i * 18e5);
  return {
    start: at(start), end: at(end + 1),
    open: end === 47 && !days[1],
    certain: CERTAIN.indexOf(today[Math.floor(slot / 2)]) >= 0,
  };
}

// --- the recurring week ----------------------------------------------------

/**
 * The next window of darkness at or after `fromAbs`, scanning the 168-cell
 * table and wrapping, because a recurring table repeats forever.
 *
 * Returns absolute cell indices (day * 24 + hour) plus the two half-hour
 * corrections, or null when the table has no dark cell at all.
 */
function scanWindow(week, fromAbs) {
  const cell = (abs) => {
    const i = ((abs % 168) + 168) % 168;
    return (week[Math.floor(i / 24)] || "")[i % 24] || "?";
  };

  let start = null;
  for (let i = 0; i < 168; i++) {
    if (isOff(cell(fromAbs + i))) {
      start = fromAbs + i;
      break;
    }
  }
  if (start === null) return null;

  // < 167 so a table that is dark end to end terminates instead of wrapping
  // onto its own start cell forever.
  let end = start;
  while (end - start < 167 && isOff(cell(end + 1))) end++;

  return {
    start,
    end,
    startHalf: SECOND_HALF_ONLY.indexOf(cell(start)) >= 0,
    endHalf: FIRST_HALF_ONLY.indexOf(cell(end)) >= 0,
    certain: CERTAIN.indexOf(cell(start)) >= 0,
  };
}

// --- the card --------------------------------------------------------------

class DtekShutdownsCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    cardTip(this, this.shadowRoot);
    installFonts();
    this._fingerprint = null;
    this._timer = null;
    // Today's history for the timeline: { day, key, at, spans, note } once fetched.
    this._hist = null;
    this._histBusy = false;
    // Off screen or in a hidden tab: nothing moves and nothing is fetched.
    this._offscreen = false;
    this._onVisibility = () => this._pause();
    // Anything carrying data-more opens HA's own dialog for that entity, as the
    // stock history-graph's rows did. One listener on the root: innerHTML is
    // replaced on every redraw, so per-element listeners would be lost.
    const open = (ev) => {
      let el = ev.target;
      while (el && el !== this.shadowRoot && !(el.getAttribute && el.getAttribute("data-more"))) {
        el = el.parentNode;
      }
      if (!el || el === this.shadowRoot) return false;
      this.dispatchEvent(new CustomEvent("hass-more-info", {
        detail: { entityId: el.getAttribute("data-more") }, bubbles: true, composed: true,
      }));
      return true;
    };
    this.shadowRoot.addEventListener("click", open);
    this.shadowRoot.addEventListener("keydown", (ev) => {
      if ((ev.key === "Enter" || ev.key === " ") && open(ev)) ev.preventDefault();
    });
  }

  setConfig(config) {
    const cfg = Object.assign({}, DEFAULTS, config || {});
    if (!cfg.entity) throw new Error(CARD + ": entity is required");
    if (cfg.debug_state && DEBUG_STATES.indexOf(cfg.debug_state) < 0) {
      throw new Error(CARD + ": debug_state must be one of " + DEBUG_STATES.join(", "));
    }
    if (!Array.isArray(cfg.blocks) || !cfg.blocks.length) {
      throw new Error(CARD + ": blocks must be a non-empty list of "
        + BLOCKS.join(", "));
    }
    const unknown = cfg.blocks.filter((b) => BLOCKS.indexOf(b) < 0);
    if (unknown.length) {
      throw new Error(CARD + ": unknown block(s) " + unknown.join(", ")
        + " -- expected " + BLOCKS.join(", "));
    }
    this._config = cfg;
    this._fingerprint = null;
    if (this._hass) this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._config) this._render();
  }

  connectedCallback() {
    // The "now" ring and the countdown move on their own. Nothing else does,
    // so 30s is enough to keep the minute in the fingerprint honest.
    if (!this._timer) this._timer = window.setInterval(() => this._render(), 30000);
    if (!this._seen && window.IntersectionObserver) {
      this._seen = new window.IntersectionObserver((entries) => {
        this._offscreen = !entries[entries.length - 1].isIntersecting;
        this._pause();
      });
    }
    if (this._seen) this._seen.observe(this);
    if (typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", this._onVisibility);
    }
  }

  disconnectedCallback() {
    if (this._timer) window.clearInterval(this._timer);
    this._timer = null;
    if (this._seen) this._seen.disconnect();
    if (typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", this._onVisibility);
    }
  }

  /** Every animation holds while no one can see the card; coming back catches up. */
  _pause() {
    const paused = this._offscreen || !!document.hidden;
    if (paused) this.setAttribute("paused", "");
    else this.removeAttribute("paused");
    if (!paused) this._render();
  }

  get _paused() {
    return this.hasAttribute("paused");
  }

  getCardSize() {
    const per = { hero: 6, timeline: 4, days: 15, week: 15, source: 4 };
    return this._config
      ? this._config.blocks.reduce((t, b) => t + (per[b] || 0), 0)
      : 22;
  }

  static getStubConfig() {
    return { entity: DEFAULTS.entity };
  }

  // --- state reading -------------------------------------------------------

  _stateObj(id) {
    return (this._hass && this._hass.states && this._hass.states[id]) || null;
  }

  _state(id) {
    const st = this._stateObj(id);
    return st ? st.state : "unknown";
  }

  /**
   * Everything that can change what is drawn, in one string.
   *
   * set hass() fires on every state change across the whole machine (816
   * entities here). Without this guard an unrelated temperature sensor would
   * rebuild 168 grid cells.
   */
  _fingerprintOf(now) {
    const cfg = this._config;
    const main = this._stateObj(cfg.entity);
    const watched = [cfg.grid_entity, cfg.unscheduled_entity, cfg.stale_entity,
      cfg.outage_entity, cfg.scheduled_entity];
    return JSON.stringify([
      main ? main.state : null,
      main ? main.attributes : null,
      watched.map((id) => this._state(id)),
      now.getDay(), now.getHours(), now.getMinutes(),
      cfg.debug_state,
      this._hist && [this._hist.at, this._hist.note],
    ]);
  }

  // --- the timeline's history ----------------------------------------------

  /** The four entities the timeline draws, in row order. */
  _timelineEntities() {
    const c = this._config;
    return [c.grid_entity, c.outage_entity, c.scheduled_entity, c.unscheduled_entity];
  }

  /**
   * Whether to ask the recorder again: never while hidden or already asking;
   * otherwise on a new day, when one of the four states changed since the last
   * answer, or every HISTORY_TTL.
   */
  _wantHistory(now) {
    if (this._config.blocks.indexOf("timeline") < 0) return false;
    if (this._paused || this._histBusy || !this._hass || typeof this._hass.callWS !== "function") return false;
    const h = this._hist;
    const key = this._timelineEntities().map((id) => this._state(id)).join("|");
    return !h || h.day !== now.toDateString() || h.key !== key || now.getTime() - h.at > HISTORY_TTL;
  }

  /** One recorder request for the four entities since midnight; redraws when it answers. */
  async _loadHistory(now) {
    this._histBusy = true;
    const ids = this._timelineEntities();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const key = ids.map((id) => this._state(id)).join("|");
    let spans = null;
    let note = null;
    try {
      const reply = await this._hass.callWS({
        type: "history/history_during_period",
        start_time: midnight.toISOString(),
        end_time: now.toISOString(),
        entity_ids: ids,
        minimal_response: true,
        no_attributes: true,
        significant_changes_only: false,
      });
      spans = ids.map((id) => onSpans((reply || {})[id], midnight.getTime(), now.getTime()));
    } catch (err) {
      note = "History is unavailable" + (err && err.message ? " (" + err.message + ")" : "")
        + ", so only the schedule is drawn.";
    }
    this._hist = { day: now.toDateString(), key, at: Date.now(), spans, note };
    this._histBusy = false;
    this._render();
  }

  _render() {
    if (!this._hass || !this._config) return;
    const now = new Date();
    if (this._wantHistory(now)) this._loadHistory(now);
    const print = this._fingerprintOf(now);
    if (print === this._fingerprint) return;
    this._fingerprint = print;

    // innerHTML is replaced wholesale, which would otherwise scroll a
    // horizontally panned grid back to Monday once a minute.
    const previous = this.shadowRoot.querySelector(".grid");
    const scrollLeft = previous ? previous.scrollLeft : 0;

    this.shadowRoot.innerHTML = "<style>" + STYLE + "</style>" + this._body(now);

    const grid = this.shadowRoot.querySelector(".grid");
    if (grid && scrollLeft) grid.scrollLeft = scrollLeft;
  }

  // --- deriving ------------------------------------------------------------

  _whenPhrase(now, then) {
    const mins = Math.round((then.getTime() - now.getTime()) / 60000);
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayDelta = Math.round(
      (new Date(then.getFullYear(), then.getMonth(), then.getDate()) - midnight) / 864e5);
    const day = dayDelta === 0 ? "today"
      : dayDelta === 1 ? "tomorrow"
      : DAY_LONG[(then.getDay() + 6) % 7];
    return { short: day, long: mins > 36 * 60 ? day : day + ", " + fmtIn(mins) };
  }

  _derive(now, a) {
    const cfg = this._config;
    const dbg = cfg.debug_state;

    let gridDown = this._state(cfg.grid_entity) === "on"; // on = no mains
    let unscheduled = this._state(cfg.unscheduled_entity) === "on";
    let dtekOutage = a.outage_active === true;
    let stale = this._state(cfg.stale_entity) === "on" || a.stale === true;
    let reason = a.outage_reason;
    let outageStart = a.outage_start;
    let outageEnd = a.outage_end;

    // Render-only overrides, so the outage and stale layouts can be compared
    // against the mockups without setting a state in Developer Tools -- which
    // would fire the grid outage alert and push to both phones.
    if (dbg === "on") {
      gridDown = unscheduled = dtekOutage = stale = false;
    } else if (dbg === "outage") {
      gridDown = true; dtekOutage = true; unscheduled = false; stale = false;
      reason = reason || "Scheduled outage";
      outageStart = outageStart || new Date(now.getTime() - 36e5).toISOString();
      outageEnd = outageEnd || new Date(now.getTime() + 108e5).toISOString();
    } else if (dbg === "dtek") {
      gridDown = false; dtekOutage = true; unscheduled = false; stale = false;
      reason = reason || "Аварійні ремонтні роботи";
      outageStart = outageStart || new Date(now.getTime() - 36e5).toISOString();
      outageEnd = outageEnd || new Date(now.getTime() + 108e5).toISOString();
    } else if (dbg === "unscheduled") {
      gridDown = true; unscheduled = true; dtekOutage = false; stale = false;
    } else if (dbg === "stale") {
      stale = true;
    }

    // The badges that used to carry the queue chip are gone, so the identity
    // of this schedule has to live in the card. It is stated once, in the
    // eyebrow, and the sentences below refer to it by the bracketed code.
    const code = a.queue
      || (Array.isArray(a.queues) && a.queues.length
            ? a.queues.map((q) => q.replace("GPV", "")).join(" / ")
            : null);
    const queue = code ? "(" + code + ")" : "this queue";
    const identity = [a.address, code ? "(" + code + ")" : null]
      .filter(Boolean).join(" ") || null;
    const week = Array.isArray(a.week) && a.week.length === 7 ? a.week : null;
    // DTEK's own site draws the recurring table only when the getHomeNum answer
    // says to, and right now it says not to -- so neither do we. `week` is still
    // the last pattern published and stays in the attribute; it just does not
    // apply, which makes every number derived from it unsayable too.
    //
    // !== false, not === true: a poller that predates this flag must keep
    // drawing the grid rather than blank it on an absent field.
    const weekLive = week && a.week_in_effect !== false;
    const hiddenReason = a.hidden_reason || null;
    // The hero needs the hour totals; only the grid needs 168 cell objects.
    // A [source]-only instance needs neither, and building them anyway would
    // be 168 allocations a minute for a card showing three rows of text.
    const wantCells = cfg.blocks.indexOf("week") >= 0;
    const todayIdx = (now.getDay() + 6) % 7; // 0 = Monday, as `week` is
    const nowH = now.getHours() + now.getMinutes() / 60;
    // A cell of today that has gone by is drawn dim, in the week and the days alike.
    const past = (isToday, h) => (isToday && h + 1 <= nowH ? " past" : "");

    // What DTEK has applied to today and tomorrow, when a schedule is in force:
    // it beats the recurring pattern in those two columns of the week.
    const inEffect = a.schedule_in_effect === true;
    const appliedRow = (row) => (inEffect && typeof row === "string" && row.length === 24 ? row : null);
    const appliedToday = appliedRow(a.today);
    const appliedTmrw = appliedRow(a.tomorrow);

    // --- the grid and its totals
    const days = [];
    let weekOff = 0;
    if (weekLive) {
      const monday = new Date(now.getFullYear(), now.getMonth(),
                              now.getDate() - todayIdx);
      for (let di = 0; di < 7; di++) {
        const date = new Date(monday.getFullYear(), monday.getMonth(),
                              monday.getDate() + di);
        const own = di === todayIdx ? appliedToday : di === todayIdx + 1 ? appliedTmrw : null;
        const row = own || week[di] || "";
        const cells = [];
        let off = 0;
        for (let h = 0; h < 24; h++) {
          const st = STATE[row[h]] || STATE["?"];
          off += st.off;
          if (!wantCells) continue;
          cells.push({
            cls: st.cls + (di === todayIdx && h === now.getHours() ? " now" : "")
              + past(di === todayIdx, h),
            name: DAY_SHORT[di] + " " + pad2(h) + ":00",
            label: own ? st.label + ", applied schedule" : st.label,
            key: own ? "sched_cell" : "cell",
          });
        }
        // The tile counts the recurring week; a column shows what applies to it.
        weekOff += (week[di] ? offHours(week[di]) : 0);
        days.push({
          name: DAY_SHORT[di],
          cls: di === todayIdx ? "today" : di === todayIdx + 1 ? "tmrw" : "",
          sub: di === todayIdx ? "today" : di === todayIdx + 1 ? "tmrw"
            : pad2(date.getDate()) + "." + pad2(date.getMonth() + 1),
          cells,
          total: fmtHours(off),
          heavy: off >= 10,
          applied: !!own,
        });
      }
    }

    // --- the applied schedule: today and tomorrow, and whether now is dark
    const schedNow = inEffect && dbg !== "on"
      ? scheduleWindow(a.today, a.tomorrow, now) : null;
    const schedEnd = schedNow
      ? fmtClock(schedNow.end.toISOString()) + (schedNow.end.getDate() !== now.getDate() ? "+1" : "")
      : null;
    const schedSpan = schedNow
      ? fmtClock(schedNow.start.toISOString()) + DASH + schedEnd : null;
    const schedLeft = schedNow
      ? fmtIn(Math.round((schedNow.end.getTime() - now.getTime()) / 60000)) : null;
    // Today and tomorrow on their own: the "days" block, and the week block's
    // view when DTEK applies a schedule but draws no recurring table.
    const applied = [];
    if (inEffect && (cfg.blocks.indexOf("days") >= 0 || (wantCells && !weekLive))) {
      [a.today, a.tomorrow].forEach((row, di) => {
        const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + di);
        const name = di === 0 ? "Today" : "Tomorrow";
        const ok = typeof row === "string" && row.length === 24;
        const cells = [];
        for (let h = 0; h < 24; h++) {
          const st = ok ? STATE[row[h]] || STATE["?"] : STATE["?"];
          cells.push({
            cls: st.cls + (di === 0 && h === now.getHours() ? " now" : "") + past(di === 0, h),
            name: name + " " + pad2(h) + ":00",
            label: ok ? st.label : "not published yet",
            key: "sched_cell",
          });
        }
        const off = ok ? offHours(row) : 0;
        applied.push({
          name, cls: di === 0 ? "today" : "tmrw",
          sub: pad2(date.getDate()) + "." + pad2(date.getMonth() + 1),
          cells, total: ok ? fmtHours(off) : MDASH, published: ok, heavy: off >= 10,
        });
      });
    }

    // --- the next window
    //
    // sensor.dtek_next_outage_start/_end derive from `fact`, which DTEK has
    // served empty since 24.07.2026, so they read unknown and the window has
    // to come out of the recurring table. They are preferred whenever they do
    // carry a timestamp: an applied schedule beats a recurring pattern.
    let win = null;
    const appliedStart = parseDate(a.next_outage_start);
    if (schedNow) {
      win = {
        label: schedSpan, at: fmtClock(schedNow.start.toISOString()),
        when: "now, ends " + schedLeft, whenShort: "now", certain: schedNow.certain,
        start: schedNow.start,
      };
    } else if (appliedStart) {
      const appliedEnd = parseDate(a.next_outage_end);
      const at = pad2(appliedStart.getHours()) + ":" + pad2(appliedStart.getMinutes());
      const when = this._whenPhrase(now, appliedStart);
      win = {
        label: at + DASH + (appliedEnd
          ? pad2(appliedEnd.getHours()) + ":" + pad2(appliedEnd.getMinutes()) : "?"),
        at, when: when.long, whenShort: when.short, certain: true, start: appliedStart,
      };
    } else if (weekLive) {
      const nowAbs = todayIdx * 24 + now.getHours();
      const w = scanWindow(week, nowAbs + 1);
      if (w) {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
                               now.getHours() + (w.start - nowAbs),
                               w.startHalf ? 30 : 0);
        const when = this._whenPhrase(now, start);
        // A run of dark cells does not stop at midnight, and "19:30-02:30"
        // reads as a window that ended seventeen hours ago without the +1.
        const lastCell = w.endHalf ? w.end : w.end + 1;
        const crosses = Math.floor(lastCell / 24) - Math.floor(w.start / 24);
        win = {
          label: clock(w.start, w.startHalf) + DASH
            + (w.endHalf ? clock(w.end, true) : clock(w.end + 1, false))
            + (crosses > 0 ? "+" + crosses : ""),
          at: clock(w.start, w.startHalf),
          when: when.long, whenShort: when.short, certain: w.certain, start,
        };
      }
    }

    // --- the sentences
    let headline;
    let lede;
    if (gridDown) {
      headline = "The power is off.";
      if (unscheduled) {
        lede = "The inverter sees no mains and nobody said it would be: DTEK "
          + "reports no outage for " + queue + " and the schedule does not have "
          + "this hour dark.";
      } else if (dtekOutage) {
        const bits = [];
        if (outageStart) bits.push("started at " + fmtClock(outageStart));
        if (outageEnd) bits.push("should end at " + fmtClock(outageEnd));
        lede = "DTEK reports an outage for " + queue
          + (reason ? " (" + reason + ")" : "")
          + (bits.length ? ", " + bits.join(" and ") : "") + ".";
      } else if (schedNow) {
        lede = "The inverter sees no mains, as DTEK's schedule for " + queue
          + " has it: off " + schedSpan + ", back "
          + (schedNow.open ? "by midnight unless tomorrow's table extends it"
                           : "by " + schedEnd + " (" + schedLeft + ")") + ".";
      } else {
        lede = "The inverter sees no mains. DTEK reports no outage of its own, "
          + "but the schedule has this hour dark, so it does not count as "
          + "unscheduled.";
      }
    } else if (dtekOutage) {
      // DTEK has an outage recorded against this address and the inverter
      // still sees mains. Either DTEK is ahead of the switching or the notice
      // covers a line this flat is not on -- both worth a warning, neither an
      // alarm, and certainly not a green "the power is on".
      headline = "DTEK reports an outage.";
      const bits = [];
      if (outageStart) bits.push("since " + fmtClock(outageStart));
      if (outageEnd) bits.push("expected back by " + fmtClock(outageEnd));
      lede = "DTEK says the power is off for " + queue
        + (bits.length ? " " + bits.join(", ") : "")
        + ". The inverter still sees mains.";
    } else if (schedNow) {
      // DTEK's applied schedule has this half hour dark, and the inverter
      // still sees mains: the switching has not reached this line yet, or
      // this slot was skipped. A claim, like a DTEK notice -- orange.
      headline = "Scheduled outage until " + schedEnd + ".";
      lede = "DTEK's schedule for " + queue + " has " + schedSpan + " "
        + (schedNow.certain ? "off" : "as a possible outage")
        + ". The inverter still sees mains.";
    } else {
      headline = "The power is on.";
      lede = win
        ? "No outage is running for " + queue + ". The next "
          + (win.certain ? "scheduled" : "possible") + " window starts at "
          + win.at + " " + win.whenShort + "."
        : weekLive
          ? "No outage is running for " + queue + ", and the recurring table "
            + "has nothing dark in it."
          : "No outage is running for " + queue + ". DTEK is publishing no "
            + "table to say when the next one might be.";
    }

    // DTEK's own words for why the power is off. outage_reason is only ever
    // populated during an outage, so this reads "Not reported" the rest of the
    // time rather than vanishing: a row that disappears looks like a rendering
    // fault on the one screen anybody actually opens during a blackout.
    let reasonText = "Not reported";
    let reasonKnown = false;
    // The rest of DTEK's notice, row for row as its own site prints it. Only
    // while an outage is recorded: outside one these are all empty anyway.
    //
    // A time the poller could not parse still arrives verbatim in *_raw, and
    // is shown as DTEK wrote it: on 29.09.2026 a format change turned both of
    // these into nothing for three hours.
    const notice = [];
    if (dtekOutage) {
      const startText = fmtStamp(outageStart) || a.outage_start_raw;
      // [label, value, HELP key]
      if (startText) notice.push(["Started", startText, "started"]);
      const end = parseDate(outageEnd);
      if (end) {
        const mins = Math.round((end.getTime() - now.getTime()) / 60000);
        notice.push(["Expected back", "by " + fmtStamp(outageEnd) + " " + MIDDOT
          + " " + (mins >= 0 ? fmtIn(mins) : "overdue " + fmtIn(-mins).slice(3)),
          "expected"]);
      } else if (a.outage_end_raw) {
        notice.push(["Expected back", "by " + a.outage_end_raw, "expected"]);
      }
      // The answer lists every house on the street, so this separates a fault
      // in this building from one on the line.
      const n = a.street_outages;
      if (typeof n === "number" && n > 0 && typeof a.street_houses === "number") {
        notice.push(["Scope", n === 1 ? "Only this building on the street"
          : n + " of " + a.street_houses + " houses on the street", "scope"]);
      }
      if (a.updated_at) notice.push(["Information updated", a.updated_at, "updated"]);
    }
    if (reason) {
      reasonText = reason + ", " + queue;
      reasonKnown = true;
    } else if (dtekOutage) {
      reasonText = (OUTAGE_TYPE[a.outage_type] || "Outage") + ", " + queue;
      reasonKnown = true;
    }

    // Anything in DTEK's answer the poller could not read -- see
    // drift_warnings() in dtek_poll.py. Never fatal, never silent.
    const warnings = Array.isArray(a.warnings) ? a.warnings : [];
    const published = a.schedule_update || "an unknown date";
    let note;
    if (!inEffect && !weekLive && WILL_RETURN.indexOf(hiddenReason) >= 0) {
      note = "Stabilisation schedules are not in force, and DTEK has withdrawn "
        + "the recurring table as well " + MDASH + " the last one it published "
        + "was on " + published + " " + MDASH + " so nothing below forecasts "
        + "anything.";
    } else if (!inEffect && !weekLive) {
      note = "Stabilisation schedules are not in force, and DTEK publishes no "
        + "recurring table for this address, so nothing below forecasts "
        + "anything.";
    } else if (!inEffect) {
      note = "Stabilisation schedules are not in force " + MDASH + " DTEK last "
        + "published one on " + published + " " + MDASH + " so nothing is "
        + "applied on top of the recurring pattern below.";
    } else {
      const t = typeof a.today === "string" ? offHours(a.today) : null;
      const m = typeof a.tomorrow === "string" ? offHours(a.tomorrow) : null;
      note = "A stabilisation schedule is in effect: "
        + (t === null ? "today is not published" : fmtHours(t) + " off today")
        + (m === null ? ", tomorrow not published yet"
                      : " and " + fmtHours(m) + " tomorrow") + ".";
    }

    // --- the pill, the glow and the clock
    //
    // Minutes to the next window, when one is ahead and not running yet.
    const toNext = win && win.start && !schedNow
      ? Math.round((win.start.getTime() - now.getTime()) / 60000) : null;
    // Amber an hour ahead of a window, so the page warns before the alert does.
    const soon = !gridDown && !dtekOutage && !schedNow && toNext !== null && toNext <= 60;
    const kind = gridDown ? "bad" : dtekOutage || schedNow || soon ? "warn" : "ok";
    const pill = gridDown ? (unscheduled ? "Off · not announced" : "Power off")
      : dtekOutage ? "DTEK notice"
      : schedNow ? (schedNow.certain ? "Scheduled outage" : "Possible outage")
      : soon ? (win.certain ? "Outage soon" : "Possible outage soon")
      : "Power on";
    // The clock's ring is today: what DTEK applied, else the recurring row.
    const todayRow = appliedToday ? { row: appliedToday, source: "applied schedule" }
      : weekLive && week[todayIdx] ? { row: week[todayIdx], source: "weekly table" }
      : null;
    const left = (ms) => fmtIn(Math.round(ms / 60000)).replace(/^in /, "");
    // DTEK's live notice on the ring: an emergency outage has no schedule
    // behind it, and on 29.10.2026 the clock sat grey and said "OFF" while the
    // notice already had the power back by 17:54. Hours of today; the start is
    // clamped to midnight, but the end is not: on 29.10.2026 a 21:19-01:19
    // notice stopped at the top of the ring while the centre said 2h 33m. Past
    // 24 the span wraps on round to tomorrow's hours, at most a full turn from
    // its start. With no end time it runs to the hand.
    const noticeStart = dtekOutage ? parseDate(outageStart) : null;
    const noticeEnd = dtekOutage ? parseDate(outageEnd) : null;
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const toH = (t) => (t - midnight) / 36e5;
    const startH = noticeStart ? Math.min(24, Math.max(0, toH(noticeStart.getTime()))) : 0;
    const emergency = noticeStart ? {
      start: startH,
      end: noticeEnd ? Math.min(startH + 24, Math.max(0, toH(noticeEnd.getTime()))) : nowH,
      label: (reason || OUTAGE_TYPE[a.outage_type] || "Outage") + ", "
        + fmtClock(outageStart) + DASH + (noticeEnd ? fmtClock(outageEnd) : "?"),
    } : null;
    if (emergency && emergency.end <= emergency.start) emergency.end = emergency.start;
    let center;
    if (noticeEnd) {
      // The notice beats the schedule: it is about this outage, not a pattern.
      const ms = noticeEnd.getTime() - now.getTime();
      center = ms >= 60000
        ? { big: left(ms), small: gridDown ? "until back" : "until it ends" }
        : ms > -60000
          ? { big: gridDown ? "OFF" : "NOW", small: "due back now" }
          : { big: left(-ms), small: "overdue" };
    } else if (gridDown) {
      center = schedNow && !schedNow.open
        ? { big: left(schedNow.end.getTime() - now.getTime()), small: "until back" }
        : { big: "OFF", small: unscheduled ? "not announced" : "no mains" };
    } else if (schedNow) {
      center = { big: left(schedNow.end.getTime() - now.getTime()), small: "until it ends" };
    } else if (toNext !== null && toNext <= 36 * 60) {
      center = { big: left(toNext * 60000), small: win.certain ? "to outage" : "to maybe off" };
    } else {
      center = { big: "ON", small: todayRow ? "nothing ahead" : "no schedule" };
    }

    return {
      kind, pill, todayRow, center, nowH, emergency,
      // Orange when only DTEK says it is off: a claim, not a measurement.
      accent: gridDown ? RED : dtekOutage || schedNow ? ORANGE : GREEN,
      // The accent in words, for the eyebrow's tooltip.
      nowWord: gridDown ? "power off"
        : dtekOutage ? "DTEK outage notice, mains present"
        : schedNow ? "scheduled outage, mains present" : "power on",
      identity,
      headline, lede, note, queue, week, days, win, applied, inEffect,
      weekLive, hiddenReason,
      // Null rather than "0h": both are computed from a pattern DTEK has
      // withdrawn, and a zero reads as a measured week with no outages in it.
      weekOff: weekLive ? fmtHours(weekOff) : null,
      weekShare: weekLive ? Math.round((weekOff / 168) * 100) + "%" : null,
      stale,
      warnings,
      feedLabel: stale ? "Stale" : warnings.length ? "Drift" : "Healthy",
      // The bright variants: this colour is text, and must read at 4.5:1.
      feedColor: stale || warnings.length ? "var(--ds-warn-hi)" : "var(--ds-ok-hi)",
      feedSentence: stale
        ? "The poller has not returned fresh data"
          + (a.error ? " (" + a.error + ")" : "")
          + ", so the times below may be out of date."
        : warnings.length
          ? "The feed answered, but DTEK sent something the poller could not "
            + "fully read, so some values below are shown as DTEK wrote them."
          : "The feed answered on the last poll, so the times below are current.",
      lastPoll: fmtClock(a.fetched_at) || "never",
      published: a.schedule_update || "unknown",
      updatedAt: a.updated_at || null,
      reasonText,
      reasonKnown,
      notice,
    };
  }

  // --- drawing -------------------------------------------------------------

  _body(now) {
    const cfg = this._config;
    const main = this._stateObj(cfg.entity);
    if (!main) {
      return '<div class="wrap k-warn"><ha-card><div class="pad"><h2>DTEK Shutdowns</h2>'
        + '<p class="note err">' + esc(cfg.entity) + " does not exist. Is "
        + "packages/dtek_shutdowns.yaml loaded?</p></div></ha-card></div>";
    }
    const d = this._derive(now, main.attributes || {});
    const draw = { hero: () => this._hero(d), timeline: () => this._timelineCard(d, now),
                   days: () => this._daysCard(d), week: () => this._weekCard(d),
                   source: () => this._sourceCard(d) };
    return '<div class="wrap k-' + d.kind + '" style="--accent:' + d.accent + '">'
      + this._config.blocks.map((b) => draw[b]()).join("")
      + "</div>";
  }

  _hero(d) {
    // One tooltip per tile; the label, value and sub-line inherit it.
    const tile = (k, v, s, key, color) =>
      '<div class="tile"' + tip(k, v === null ? s : v + " " + MIDDOT + " " + s, key)
      + '><span class="k">' + esc(k) + "</span>"
      + '<span class="v' + (v === null ? " dim" : "") + '"'
      + (color ? ' style="color:' + color + '"' : "") + ">"
      + esc(v === null ? MDASH : v) + "</span>"
      + '<span class="s">' + esc(s) + "</span></div>";

    return '<ha-card class="hero"><div class="pad">'
      + '<div class="hero-left">'
      // The eyebrow's tooltip covers the pill; the address chip means something
      // else and carries its own.
      + '<div class="eyebrow"' + tip("Right now", d.nowWord, "now") + '>'
      + '<span class="pill"><span class="dot"></span><span class="lbl">' + esc(d.pill)
      + "</span></span>"
      + (d.identity ? '<span class="ident"' + tip("Address and queue", d.identity, "ident")
        + ">" + esc(d.identity) + "</span>" : "")
      + "</div>"
      + "<h1" + tip("Headline", d.headline.replace(/\.$/, ""), "headline") + ">"
      + esc(d.headline) + "</h1>"
      + '<p class="lede">' + esc(d.lede) + "</p>"
      + '<p class="note">' + esc(d.note) + "</p>"
      + '<div class="reason"' + tip("Reason", d.reasonText, "reason") + '>'
      + '<span class="k">Reason</span>'
      + '<span class="v' + (d.reasonKnown ? "" : " dim") + '">'
      + esc(d.reasonText) + "</span></div>"
      + d.notice.map(([k, v, key]) => '<div class="reason sub"' + tip(k, v, key) + '>'
        + '<span class="k">' + esc(k) + '</span><span class="v">' + esc(v)
        + "</span></div>").join("")
      + "</div>"
      + this._clock(d)
      + '<div class="tiles">'
      // Both of these are read off the recurring pattern. When DTEK withdraws
      // it they have no answer, and a dash is the honest one -- "0h off" would
      // be a claim about a week nobody has scheduled.
      + tile("Next window", d.win ? d.win.label : d.weekLive ? "none" : null,
             d.win ? d.win.when
               : d.weekLive ? "nothing in the table" : "no schedule published", "next")
      + tile("Off this week", d.weekOff,
             d.weekShare ? d.weekShare + " of the week" : "not published", "week_off")
      + tile("Feed", d.feedLabel, "Last poll " + d.lastPoll, "feed", d.feedColor)
      + "</div></div></ha-card>";
  }

  /**
   * Today as a 24-hour ring, midnight at the top: each hour an arc in two
   * halves (DTEK's half-hour letters split it), the past dimmed, a hand at now
   * and the countdown in the middle. Drawn in the SVG's own 240-unit box.
   */
  _clock(d) {
    const C = 120;
    const R1 = 104;
    const R0 = 84;
    const GAP = 0.014; // radians between hours, none between the halves of one
    const at = (r, a) => (C + r * Math.cos(a)).toFixed(2) + " " + (C + r * Math.sin(a)).toFixed(2);
    const angle = (h) => (h / 24) * 2 * Math.PI - Math.PI / 2;
    const arc = (h0, h1, g0, g1) => {
      const a0 = angle(h0) + g0;
      const a1 = angle(h1) - g1;
      return "M " + at(R1, a0) + " A " + R1 + " " + R1 + " 0 0 1 " + at(R1, a1)
        + " L " + at(R0, a1) + " A " + R0 + " " + R0 + " 0 0 0 " + at(R0, a0) + " Z";
    };
    const row = d.todayRow ? d.todayRow.row : null;
    let segs = "";
    for (let h = 0; h < 24; h++) {
      const letter = row ? row[h] : null;
      const st = letter ? STATE[letter] || STATE["?"] : null;
      const t = tip(pad2(h) + ":00" + DASH + pad2(h + 1) + ":00",
                    st ? st.label + ", " + d.todayRow.source : "no schedule published", "clock_hour");
      for (const half of [0, 1]) {
        const cls = !st || st.cls === "unknown" ? "none"
          : halfDark(letter, half) ? (CERTAIN.indexOf(letter) >= 0 ? "out" : "maybe") : "on";
        const past = h + (half + 1) / 2 <= d.nowH ? " past" : "";
        segs += '<path class="arc ' + cls + past + '" d="'
          + arc(h + half / 2, h + (half + 1) / 2, half ? 0 : GAP, half ? GAP : 0) + '"' + t + "></path>";
      }
    }
    // DTEK's notice over the hours, to the minute: the gone-by part dims like
    // the hours under it. Halves of twelve hours at most, so a whole day of
    // outage never asks SVG for an arc that ends where it starts.
    const e = d.emergency;
    if (e && e.end > e.start) {
      const t = tip("DTEK notice", e.label, "clock_emergency");
      const span = (h0, h1, cls) => {
        if (h1 - h0 < 0.01) return "";
        if (h1 - h0 > 12) return span(h0, h0 + 12, cls) + span(h0 + 12, h1, cls);
        const a0 = angle(h0);
        const a1 = angle(h1);
        return '<path class="arc emerg' + cls + '" d="M ' + at(R1, a0) + " A " + R1 + " " + R1
          + " 0 0 1 " + at(R1, a1) + " L " + at(R0, a1) + " A " + R0 + " " + R0
          + " 0 0 0 " + at(R0, a0) + ' Z"' + t + "></path>";
      };
      const cut = Math.min(Math.max(d.nowH, e.start), e.end);
      segs += span(e.start, cut, " past") + span(cut, e.end, "");
    }
    let ticks = "";
    for (const h of [0, 6, 12, 18]) {
      ticks += '<text class="tick" x="' + at(R1 + 11, angle(h)).split(" ")[0] + '" y="'
        + (Number(at(R1 + 11, angle(h)).split(" ")[1]) + 3.5).toFixed(2)
        + '" text-anchor="middle">' + pad2(h) + "</text>";
    }
    const c = d.center;
    return '<div class="clock"><svg viewBox="-8 -8 256 256" role="img" aria-label="Today, 00:00 to 24:00">'
      + '<defs><pattern id="ds-hatch" width="6" height="6" patternUnits="userSpaceOnUse"'
      + ' patternTransform="rotate(45)"><rect class="hatch-bg" width="6" height="6"></rect>'
      + '<rect class="hatch-fg" width="3" height="6"></rect></pattern></defs>'
      + '<circle class="face" cx="120" cy="120" r="' + (R0 - 6) + '"></circle>'
      + segs + ticks
      // A short pointer across the ring, not a line from the middle: a full hand
      // would cross the countdown twice a day.
      + '<g class="hand" transform="rotate(' + ((d.nowH / 24) * 360).toFixed(1) + ' 120 120)">'
      + '<line x1="120" y1="' + (C - R0 + 10) + '" x2="120" y2="' + (C - R1 - 5) + '"></line>'
      + '<circle class="nub" cx="120" cy="' + (C - R1 - 5) + '" r="3"></circle></g>'
      + '<g class="ctr"' + tip("Countdown", c.big + " " + c.small, "clock_center") + ">"
      + '<text class="big' + (c.big.length > 5 ? " long" : "") + '" x="120" y="122" text-anchor="middle">'
      + esc(c.big) + "</text>"
      + '<text class="small" x="120" y="142" text-anchor="middle">' + esc(c.small) + "</text></g>"
      + "</svg></div>";
  }

  /**
   * Today, 00:00-24:00, on four rows against the clock's hours: what the
   * inverter measured, DTEK's live notice, the schedule, and what nobody
   * announced. The past is the recorder's; the schedule row also shows the
   * rest of the day from today's row.
   */
  _timelineCard(d, now) {
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const DAY = 864e5;
    const nowMs = now.getTime();
    const pct = (ms) => (((ms - midnight) / DAY) * 100).toFixed(3);
    const hm = (ms) => (ms - midnight >= DAY ? "24:00"
      : pad2(new Date(ms).getHours()) + ":" + pad2(new Date(ms).getMinutes()));
    const h = this._hist;
    const fresh = !!(h && h.day === now.toDateString() && h.spans);

    // The schedule's dark runs over today, half hour by half hour, by class.
    const runs = [];
    if (d.todayRow) {
      let open = null;
      for (let i = 0; i <= 48; i++) {
        const letter = d.todayRow.row[Math.floor(i / 2)];
        const cls = i < 48 && halfDark(letter, i % 2)
          ? (CERTAIN.indexOf(letter) >= 0 ? "out" : "maybe") : null;
        if (open && open.cls !== cls) { runs.push([open.from, midnight + i * 18e5, open.cls]); open = null; }
        if (cls && !open) open = { from: midnight + i * 18e5, cls };
      }
    }
    const clip = (list, a, b, extra) => list
      .map(([s, e, cls]) => [Math.max(s, a), Math.min(e, b), (cls || "out") + (extra || "")])
      .filter(([s, e]) => e > s);
    const span = (i) => (fresh ? h.spans[i].map(([s, e]) => [s, e, null]) : []);

    const schedPast = fresh ? span(2) : clip(runs, midnight, nowMs, " past");
    const rows = [
      ["Grid down", "measured by the inverter", clip(span(0), midnight, nowMs), this._config.grid_entity],
      ["DTEK says outage", "its live notice", clip(span(1), midnight, nowMs), this._config.outage_entity],
      ["On the schedule", d.todayRow ? d.todayRow.source : "no schedule",
        clip(schedPast, midnight, nowMs).concat(clip(runs, nowMs, midnight + DAY)), this._config.scheduled_entity],
      ["Unscheduled", "down, and nobody said so",
        clip(span(3), midnight, nowMs).map(([s, e]) => [s, e, "warn"]), this._config.unscheduled_entity],
    ];
    const nowLine = '<span class="nowline" style="left:calc(' + pct(nowMs) + '% - 1px)"></span>';
    let body = "";
    rows.forEach(([name, sub, blocks, entity]) => {
      const on = this._state(entity) === "on";
      // The name and the bar both open the sensor's own dialog; a block inside
      // the bar keeps its own tooltip and opens the same dialog.
      const more = ' data-more="' + esc(entity) + '" role="button" tabindex="0"'
        + tip(name, on ? "off now" : "clear now", "tl_row");
      body += '<div class="tlname"' + more + ">"
        + esc(name) + "<small>" + esc(sub) + "</small></div>"
        + '<div class="bar"' + more + ">"
        + blocks.map(([s, e, cls]) => '<span class="blk ' + cls + '" style="left:' + pct(s)
          + "%;width:" + (((e - s) / DAY) * 100).toFixed(3) + '%"'
          + tip(name, hm(s) + DASH + hm(e) + ", " + fmtIn(Math.round((e - s) / 60000)).replace(/^in /, ""),
                "tl_block") + "></span>").join("")
        + nowLine + "</div>";
    });
    const item = (cls, text, key) => "<span" + tip(text, null, key) + ">"
      + '<span class="sw ' + cls + '"></span>' + esc(text) + "</span>";
    return '<ha-card class="timeline"><div class="pad">'
      + '<div class="head"><h2>Today</h2></div>'
      + '<p class="blurb">DTEK\'s claim against the inverter\'s measurement.</p>'
      + (fresh ? "" : '<p class="note">' + esc(h && h.note ? h.note : "Loading today's history from the recorder.")
        + "</p>")
      + '<div class="tl">' + body
      + '<div class="axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>'
      + "</div>"
      + '<div class="legend">'
      + item("out", "Off", "legend_out")
      + item("maybe", "Possible outage", "legend_maybe")
      + item("warn", "Off, not announced", "legend_unsched")
      + "</div></div></ha-card>";
  }

  /** Hours down the side, a column per day, the legend under it. */
  _grid(cols, totalKey, withUnknown) {
    let hours = '<div class="hours">';
    for (let h = 0; h < 24; h++) hours += '<div class="hr">' + pad2(h) + "</div>";
    hours += "</div>";
    let out = "";
    cols.forEach((day) => {
      let cells = '<div class="cells">';
      day.cells.forEach((c) => {
        cells += '<div class="c ' + c.cls + '"' + tip(c.name, c.label, c.key) + "></div>";
      });
      cells += "</div>";
      out += '<div class="day ' + day.cls + (day.applied ? " applied" : "") + '">'
        + '<div class="dhead"><span class="dname">' + esc(day.name) + "</span>"
        + '<span class="dsub">' + esc(day.sub) + "</span></div>"
        + cells
        + '<div class="dtot' + (day.heavy ? " heavy" : "") + '"'
        + tip(day.name + " total", day.published === false ? "not published" : day.total + " off",
              day.applied || totalKey === "sched_total" ? "sched_total" : totalKey)
        + ">" + esc(day.total) + "</div></div>";
    });
    // The swatch inherits its item's tooltip.
    const item = (cls, text, key) => "<span" + tip(text, null, key) + ">"
      + '<span class="sw ' + cls + '"></span>' + esc(text) + "</span>";
    return '<div class="grid">' + hours + out + "</div>"
      + '<div class="legend">'
      + item("on", "Power on", "legend_on")
      + item("out", "Scheduled outage", "legend_out")
      + item("maybe", "Possible outage", "legend_maybe")
      + item("out-2", "Off for half the hour", "legend_half")
      + (withUnknown ? item("unknown", "Not published", "sched_total") : "")
      + item("nowsw", "Now", "legend_now")
      + "</div>";
  }

  _daysCard(d) {
    // What DTEK has actually applied, which is what the site shows under
    // "Графік відключень": the week's grid, two columns.
    const inner = d.inEffect && d.applied.length
      ? this._grid(d.applied, "sched_total", true)
      : '<p class="note">No stabilisation schedule is in force, so DTEK '
        + "has applied nothing to today or tomorrow.</p>";
    return '<ha-card class="week days"><div class="pad">'
      + '<div class="head"><h2>Today and tomorrow</h2>'
      + '<span class="stamp"' + tip("Schedule published", d.published, "published")
      + ">Published " + esc(d.published) + "</span></div>"
      + inner + "</div></ha-card>";
  }

  _weekCard(d) {
    // The card, its heading and the Published stamp stay in every branch.
    // DTEK does the same -- discon-schedule.js:708 empties #tableRenderElem and
    // leaves the section standing -- and on the one screen anybody opens during
    // a blackout, a card that vanished is indistinguishable from a broken one.
    let inner;
    let blurb = null;
    // With the table withdrawn, what DTEK applied to today and tomorrow is all
    // there is to draw.
    const appliedOnly = d.inEffect && d.applied.length
      ? '<p class="blurb">DTEK has applied a schedule to today and tomorrow:</p>'
        + this._grid(d.applied, "sched_total", true) : "";
    if (!d.week) {
      inner = '<p class="note">DTEK publishes no recurring table for this '
        + "address.</p>" + appliedOnly;
    } else if (!d.weekLive) {
      inner = '<p class="note">' + esc(WITHHELD[d.hiddenReason] || WITHHELD.plan_off)
        + (WILL_RETURN.indexOf(d.hiddenReason) >= 0
           ? " Last published " + esc(d.published) + "." : "") + "</p>" + appliedOnly;
    } else {
      blurb = "The pattern DTEK last published for " + d.queue + ". Today and tomorrow "
        + "are highlighted" + (d.days.some((x) => x.applied)
          ? " and show the schedule DTEK applied to them" : "")
        + "; every other column repeats weekly until a new schedule arrives. Possible "
        + "outages count as off in the totals, the same call the alerts make.";
      inner = this._grid(d.days, "day_total", false);
    }
    return '<ha-card class="week"><div class="pad">'
      + '<div class="head"><h2>Recurring weekly schedule</h2>'
      + '<span class="stamp"' + tip("Schedule published", d.published, "published")
      + ">Published " + esc(d.published) + "</span></div>"
      + (blurb === null ? "" : '<p class="blurb">' + esc(blurb) + "</p>")
      + inner + "</div></ha-card>";
  }

  _sourceCard(d) {
    // `tipState` is line 1's state where the shown value would not read as one.
    const kv = (k, v, key, tipState) => "<div" + tip(k, tipState || v, key) + ">"
      + '<span class="k">' + esc(k) + "</span>"
      + '<span class="v">' + esc(v) + "</span></div>";
    return '<ha-card><div class="pad">'
      + "<h2>Where this comes from</h2>"
      + '<p class="blurb">' + esc(d.feedSentence) + "</p>"
      + '<div class="kv">'
      + kv("Last poll", d.lastPoll, "last_poll")
      // DTEK's own freshness stamp, minutes old. Distinct from the one below,
      // which stamps the last schedule DTEK published and has read 24.07.2026
      // since the day they suspended them -- reading only that one makes a
      // live feed look six weeks dead.
      + kv("Information updated", d.updatedAt || "not reported", "updated")
      + d.warnings.map((w) => '<div class="warn"' + tip("Format drift", w, "drift") + ">"
        + '<span class="k">Format drift</span>'
        + '<span class="v">' + esc(w) + "</span></div>").join("")
      + kv("Schedule published", d.published, "published")
      + kv("Schedule table", d.weekLive ? "shown"
             : "hidden" + (d.hiddenReason ? " " + MDASH + " " + d.hiddenReason : ""),
           "table", d.weekLive ? "shown"
             : "hidden" + (d.hiddenReason ? " (" + d.hiddenReason + ")" : ""))
      + kv("Poll interval", this._config.poll_interval + " min", "interval")
      + "</div>"
      + '<div class="foot"><code>/config/dtek/dtek_poll.py</code> reads the AJAX '
      + 'endpoint behind <a href="https://www.dtek-dnem.com.ua/ua/shutdowns" '
      + 'target="_blank" rel="noopener">dtek-dnem.com.ua/ua/shutdowns</a>.</div>'
      + "</div></ha-card>";
  }

}

// --- styles ----------------------------------------------------------------
//
// The console palette is the card's own (--ds-* on :host), not the HA theme's:
// the panels are graphite whatever the theme, so their text must not take the
// theme's text colours, which are dark in the light theme. test_dtek_card.js
// checks every text/background pair below for 4.5:1.
const STYLE = `
:host {
  display: block; container-type: inline-size;
  --ds-ground: #080909;
  --ds-panel: #0b0c0f;
  --ds-inner: #0e1014;
  --ds-line: #1c1e24;
  --ds-line2: #23262e;
  --ds-text: #e8eaed;
  --ds-text2: #a9b5c3;
  --ds-muted: #8a909b;
  --ds-dim: #2a2e36;
  --ds-ok: #589569;
  --ds-ok-hi: #62d6a8;
  --ds-warn: #ae8446;
  --ds-warn-hi: #f2be62;
  --ds-bad: #bb635b;
  --ds-bad-hi: #ff928a;
  --ds-hatch: #5a4520;
  --ds-link: #86b3e3;
  --ds-sans: "IBM Plex Sans", system-ui, "Segoe UI", sans-serif;
  --ds-mono: "IBM Plex Mono", ui-monospace, Consolas, monospace;
}
/* Off screen or in a hidden tab: every loop holds where it is. */
:host([paused]) *, :host([paused]) *::before { animation-play-state: paused !important; }
.wrap {
  --k: var(--ds-ok); --k-hi: var(--ds-ok-hi);
  display: flex; flex-direction: column; gap: 12px;
  font-family: var(--ds-sans); font-size: 14px; line-height: 1.45; color: var(--ds-text);
  -webkit-font-smoothing: antialiased;
}
.wrap.k-warn { --k: var(--ds-warn); --k-hi: var(--ds-warn-hi); }
.wrap.k-bad { --k: var(--ds-bad); --k-hi: var(--ds-bad-hi); }
/* Outer-tree rules win over ha-card's own :host styles, border included. */
ha-card {
  display: block; background: var(--ds-panel); color: var(--ds-text);
  border: 1px solid var(--ds-line); border-radius: 12px; box-shadow: none;
}
.pad { padding: 18px 20px; display: flex; flex-direction: column; gap: 12px; }
h1 { margin: 0; font: 600 clamp(22px, 4cqi, 30px)/1.15 var(--ds-sans); text-wrap: balance; }
h2 { margin: 0; font: 600 15px/1.3 var(--ds-sans); }
p { margin: 0; }
code { font-family: var(--ds-mono); }
a { color: var(--ds-link); text-decoration: none; }
a:hover { text-decoration: underline; }

/* --- the hero: words, the clock, the tiles --- */
.hero { position: relative; overflow: hidden; border-color: color-mix(in srgb, var(--k) 55%, var(--ds-line)); }
/* A slow glow in the state's colour; faster when the power is off. */
.hero::before {
  content: ""; position: absolute; inset: -40% -10% auto auto; width: 70%; height: 180%;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--k) 30%, transparent), transparent);
  animation: breathe 5s ease-in-out infinite; pointer-events: none;
}
.k-bad .hero::before { animation-duration: 2.6s; }
@keyframes breathe { 0%, 100% { opacity: .35; transform: scale(.96); } 50% { opacity: .9; transform: scale(1.04); } }
.hero .pad {
  position: relative; display: grid; gap: 18px 28px; padding: 22px 24px;
  grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "copy clock" "tiles tiles";
}
.hero-left { grid-area: copy; display: flex; flex-direction: column; gap: 9px; min-width: 0; }
.eyebrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pill {
  display: inline-flex; align-items: center; gap: 7px; padding: 5px 10px; border-radius: 999px;
  font: 600 10.5px/1 var(--ds-mono); letter-spacing: .06em; text-transform: uppercase;
  color: var(--k-hi); background: color-mix(in srgb, var(--k) 18%, transparent);
}
.dot {
  width: 6px; height: 6px; border-radius: 50%; background: var(--k); box-shadow: 0 0 8px var(--k);
  animation: dtekpulse 2.4s ease-in-out infinite;
}
@keyframes dtekpulse { 0%, 100% { opacity: 1 } 50% { opacity: .35 } }
/* The address and queue this schedule is for. */
.ident {
  font: 500 11.5px/1 var(--ds-mono); color: var(--ds-muted);
  border: 1px solid var(--ds-line2); border-radius: 999px; padding: 4px 10px;
}
.lede { font-size: 15px; color: var(--ds-text); max-width: 56ch; text-wrap: pretty; }
.note { font-size: 13px; color: var(--ds-muted); max-width: 60ch; text-wrap: pretty; }
.note.err { color: var(--ds-warn-hi); }
.reason {
  display: flex; align-items: baseline; gap: 8px; margin-top: 4px;
  padding-top: 10px; border-top: 1px solid var(--ds-line); max-width: 60ch;
}
.reason .k, .tile .k {
  font: 600 10.5px/1.2 var(--ds-mono); letter-spacing: .08em; text-transform: uppercase;
  color: var(--ds-muted); white-space: nowrap;
}
.reason .v { font-size: 13px; color: var(--ds-text2); text-wrap: pretty; }
.reason .v.dim, .tile .v.dim { color: var(--ds-muted); }
.reason.sub { margin-top: 0; padding-top: 0; border-top: 0; }
.reason.sub .v { font-family: var(--ds-mono); }

.clock { grid-area: clock; width: clamp(180px, 26cqi, 232px); align-self: center; }
.clock svg { display: block; width: 100%; height: auto; overflow: visible; }
.face { fill: var(--ds-inner); stroke: var(--ds-line2); }
.arc { fill: var(--ds-dim); }
.arc.on { fill: var(--ds-ok); }
.arc.out { fill: var(--ds-bad); }
.arc.maybe { fill: var(--ds-warn); }
.arc.emerg { fill: url(#ds-hatch); }
.hatch-bg { fill: var(--ds-bad); }
.hatch-fg { fill: var(--ds-bad-hi); }
.arc.past { opacity: .35; }
.arc:hover { filter: brightness(1.3); }
.tick { fill: var(--ds-muted); font: 600 10px var(--ds-mono); }
.hand line { stroke: var(--ds-text); stroke-width: 2.5; stroke-linecap: round; }
.nub { fill: var(--ds-text); }
.ctr .big { fill: var(--ds-text); font: 600 26px var(--ds-mono); }
.ctr .big.long { font-size: 21px; }
.ctr .small { fill: var(--ds-text2); font: 500 11px var(--ds-sans); }

.tiles { grid-area: tiles; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.tile {
  background: var(--ds-inner); border: 1px solid var(--ds-line2); border-radius: 8px;
  padding: 11px 13px; display: flex; flex-direction: column; gap: 5px; min-width: 0;
}
.tile .v { font: 600 18px/1.2 var(--ds-mono); font-variant-numeric: tabular-nums; color: var(--ds-text); }
.tile .s { font-size: 12px; color: var(--ds-muted); }

/* --- headings shared by the lower blocks --- */
.head { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: baseline; }
.head h2 { flex: 1 1 auto; }
.stamp { font: 500 11.5px var(--ds-mono); color: var(--ds-muted); }
.blurb { font-size: 13px; color: var(--ds-text2); max-width: 70ch; text-wrap: pretty; }

/* --- the timeline: four rows on the clock's hours --- */
.tl { display: grid; grid-template-columns: 160px minmax(0, 1fr); gap: 8px 12px; align-items: center; }
.tlname { font: 500 12.5px/1.25 var(--ds-sans); color: var(--ds-text2); }
.tlname small { display: block; font-size: 11px; color: var(--ds-muted); }
/* A row opens its sensor's dialog, as the stock history graph did. */
[data-more] { cursor: pointer; border-radius: 5px; }
.tlname:hover { color: var(--ds-text); }
.bar:hover { border-color: var(--ds-muted); }
[data-more]:focus-visible { outline: 2px solid var(--ds-ok-hi); outline-offset: 2px; }
.bar {
  position: relative; height: 22px; border-radius: 5px; overflow: hidden;
  background: var(--ds-inner); border: 1px solid var(--ds-line2);
}
.blk { position: absolute; top: 3px; bottom: 3px; border-radius: 3px; min-width: 2px; }
.blk.out { background: var(--ds-bad); }
.blk.warn { background: var(--ds-warn); }
.blk.maybe { background: repeating-linear-gradient(135deg, var(--ds-warn) 0 3px, var(--ds-hatch) 3px 6px); }
.blk.past { opacity: .45; }
.nowline { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--ds-text); box-shadow: 0 0 6px var(--ds-text); }
.axis {
  grid-column: 2; display: flex; justify-content: space-between;
  font: 500 10.5px var(--ds-mono); color: var(--ds-muted);
}

/*
 * The week. overflow-x stays: below ~370px the grid needs more room than the
 * card has, and without it the body scrolls sideways instead of the grid
 * panning inside its own card.
 */
.grid { display: flex; gap: 5px; align-items: stretch; overflow-x: auto; padding-bottom: 4px; width: 100%; }
.hours { flex: 0 0 24px; display: flex; flex-direction: column; gap: 3px; padding-top: 40px; }
.hr {
  height: 12px; display: flex; align-items: center; justify-content: flex-end;
  font: 500 9.5px var(--ds-mono); color: var(--ds-muted); font-variant-numeric: tabular-nums;
}
.day { flex: 1 1 0; min-width: 30px; display: flex; flex-direction: column; border-radius: 8px; padding: 6px 4px; }
.days .grid { max-width: 360px; }
.day.today {
  background: color-mix(in srgb, var(--ds-ok) 12%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ds-ok) 35%, transparent);
}
.day.tmrw { background: rgba(255, 255, 255, .035); box-shadow: inset 0 0 0 1px var(--ds-line2); }
.dhead { height: 34px; display: flex; flex-direction: column; align-items: center; justify-content: flex-start; gap: 2px; }
.dname { font: 600 12.5px/1.1 var(--ds-sans); color: var(--ds-text); }
.dsub { font: 500 10px/1.1 var(--ds-mono); color: var(--ds-muted); white-space: nowrap; }
.day.today .dname, .day.today .dsub { color: var(--ds-ok-hi); }
.day.tmrw .dsub { color: var(--ds-text2); }
.cells { display: flex; flex-direction: column; gap: 3px; }
.dtot {
  height: 22px; display: flex; align-items: flex-end; justify-content: center;
  font: 600 11px var(--ds-mono); color: var(--ds-text2); font-variant-numeric: tabular-nums;
}
.dtot.heavy { color: var(--ds-warn-hi); }

.c { height: 12px; border-radius: 3px; background: var(--ds-dim); }
/* Green = the power is confirmed on; red, DTEK commits to it being off. */
.on { background: color-mix(in srgb, var(--ds-ok) 72%, transparent); }
.out { background: var(--ds-bad); }
/* Possible outage: amber hatching, so it never passes for an empty cell. */
.maybe { background: repeating-linear-gradient(135deg, var(--ds-warn) 0 3px, var(--ds-hatch) 3px 6px); }
/* Half hours, as DTEK draws them: the dark half is the half without power. */
.out-1 { background: linear-gradient(var(--ds-bad) 0 50%, color-mix(in srgb, var(--ds-ok) 72%, transparent) 50%); }
.out-2 { background: linear-gradient(color-mix(in srgb, var(--ds-ok) 72%, transparent) 0 50%, var(--ds-bad) 50%); }
.maybe-1 { background: linear-gradient(var(--ds-warn) 0 50%, color-mix(in srgb, var(--ds-ok) 72%, transparent) 50%); }
.maybe-2 { background: linear-gradient(color-mix(in srgb, var(--ds-ok) 72%, transparent) 0 50%, var(--ds-warn) 50%); }
/* A gap in what DTEK published: grey hatching, unlike any state. */
.unknown { background: repeating-linear-gradient(45deg, rgba(169, 181, 195, .28) 0 2px, transparent 2px 4px); }
.c.past { opacity: .35; }
.now { box-shadow: 0 0 0 1.5px var(--ds-text), 0 0 8px rgba(255, 255, 255, .35); }

.legend {
  display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center;
  border-top: 1px solid var(--ds-line); padding-top: 10px;
  font-size: 12px; color: var(--ds-text2);
}
.legend > span { display: flex; align-items: center; gap: 7px; }
/* After the cell rules, so the swatch's size wins over .c. */
.sw { width: 12px; height: 12px; border-radius: 3px; flex: 0 0 auto; }
.sw.warn { background: var(--ds-warn); }
.sw.nowsw { box-shadow: 0 0 0 1.5px var(--ds-text); }

/* --- where it comes from --- */
.kv { display: flex; flex-direction: column; gap: 7px; font-size: 13px; }
.kv > div { display: flex; justify-content: space-between; gap: 12px; }
.kv .k { color: var(--ds-text2); }
.kv .v { font: 500 12.5px var(--ds-mono); font-variant-numeric: tabular-nums; color: var(--ds-text); text-align: right; }
.kv .warn .k, .kv .warn .v { color: var(--ds-warn-hi); }
.foot {
  border-top: 1px solid var(--ds-line); padding-top: 10px;
  font-size: 12px; color: var(--ds-muted); line-height: 1.6;
}

/* --- narrow cards: a phone, or a column of a wide dashboard --- */
@container (max-width: 640px) {
  .hero .pad { grid-template-columns: 1fr; grid-template-areas: "clock" "copy" "tiles"; justify-items: center; }
  .hero-left { align-items: center; text-align: center; }
  .eyebrow { justify-content: center; }
  .tiles { grid-template-columns: 1fr 1fr; width: 100%; }
  .tl { grid-template-columns: 1fr; gap: 4px; }
  .axis { grid-column: 1; }
  .grid { gap: 2px; }
  .hours { flex-basis: 18px; }
  .day { min-width: 0; padding: 5px 2px; }
  .dsub { font-size: 9px; }
}
@media (prefers-reduced-motion: reduce) {
  .dot, .hero::before { animation: none; }
  .hero::before { opacity: .6; }
}
`;

if (!customElements.get(CARD)) customElements.define(CARD, DtekShutdownsCard);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === CARD)) {
  window.customCards.push({
    type: CARD,
    name: "DTEK Shutdowns",
    description: "The power now beside a 24-hour clock of today's schedule, today's "
      + "timeline of DTEK against the inverter, the weekly table and where it comes from.",
    preview: false,
    documentationURL: "https://www.dtek-dnem.com.ua/ua/shutdowns",
  });
}

console.info("%c " + CARD + " %c " + VERSION + " ",
             "background:#cf3c33;color:#fff;border-radius:3px 0 0 3px",
             "background:#1c1c1c;color:#e1e1e1;border-radius:0 3px 3px 0");
