/**
 * DTEK Shutdowns card.
 *
 * Draws the whole Shutdowns page: a hero status banner, the 7x24 heatmap of
 * DTEK's recurring weekly table, where the data came from, and the raw
 * entities. Registered as a Lovelace resource, so it is handed `hass` directly
 * -- no token, no iframe, no CORS.
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
 * Colours follow the HA theme. Only the four semantic ones are literal.
 */

const CARD = "dtek-shutdowns-card";
const VERSION = "1.1.1";

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
const GREEN = "var(--success-color, #43a047)";
const RED = "var(--error-color, #db4437)";
const ORANGE = "var(--warning-color, #ffa600)";

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

const DAY_SHORT = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const DAY_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
                  "Saturday", "Sunday"];

const DEFAULTS = {
  entity: "sensor.dtek_shutdowns",
  // on = UNSAFE. That is the ESPHome firmware's polarity, see the POLARITY
  // WARNING in packages/dtek_shutdowns.yaml. This is the measurement; the DTEK
  // attributes are the claim, and the hero is driven by the measurement.
  grid_entity: "binary_sensor.powmr_inverter_grid_condition_safe",
  unscheduled_entity: "binary_sensor.grid_outage_unscheduled",
  stale_entity: "binary_sensor.dtek_data_stale",
  poll_interval: 5, // minutes; matches scan_interval: 300 on the sensor
  debug_state: null, // on | outage | unscheduled | stale -- render only
  // Which of the three blocks this instance draws, in the order given.
  //
  // It exists so the provenance block can sit BELOW the claim-against-
  // measurement section, which is a separate dashboard section and cannot be
  // reordered from inside a card. Two instances: [hero, week] above it,
  // [source] below. Not a styling knob -- see BLOCKS.
  blocks: ["hero", "week", "source"],
};

const BLOCKS = ["hero", "week", "source"];

const DEBUG_STATES = ["on", "outage", "unscheduled", "stale"];

const DASH = "–"; // en dash, for 07:00-10:00
const MDASH = "—";

// --- small helpers ---------------------------------------------------------

// outage_reason and friendly_name are free text off a third-party website, and
// everything below is assembled into an HTML string. Escape without exception.
const ESCAPES = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
const esc = (v) => String(v === null || v === undefined ? "" : v)
  .replace(/[&<>"']/g, (c) => ESCAPES[c]);

const pad2 = (n) => String(n).padStart(2, "0");

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

/** Hours of darkness in one 24-character day string. */
function offHours(row) {
  let off = 0;
  for (let h = 0; h < 24; h++) off += (STATE[row[h]] || STATE["?"]).off;
  return off;
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
    this._fingerprint = null;
    this._timer = null;
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
  }

  disconnectedCallback() {
    if (this._timer) window.clearInterval(this._timer);
    this._timer = null;
  }

  getCardSize() {
    const per = { hero: 5, week: 15, source: 4 };
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
    const watched = [cfg.grid_entity, cfg.unscheduled_entity, cfg.stale_entity];
    return JSON.stringify([
      main ? main.state : null,
      main ? main.attributes : null,
      watched.map((id) => this._state(id)),
      now.getDay(), now.getHours(), now.getMinutes(),
      cfg.debug_state,
    ]);
  }

  _render() {
    if (!this._hass || !this._config) return;
    const now = new Date();
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

    let gridDown = this._state(cfg.grid_entity) === "on"; // on = UNSAFE
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

    // --- the grid and its totals
    const days = [];
    let weekOff = 0;
    if (weekLive) {
      const monday = new Date(now.getFullYear(), now.getMonth(),
                              now.getDate() - todayIdx);
      for (let di = 0; di < 7; di++) {
        const date = new Date(monday.getFullYear(), monday.getMonth(),
                              monday.getDate() + di);
        const row = week[di] || "";
        const cells = [];
        let off = 0;
        for (let h = 0; h < 24; h++) {
          const st = STATE[row[h]] || STATE["?"];
          off += st.off;
          if (!wantCells) continue;
          cells.push({
            cls: st.cls + (di === todayIdx && h === now.getHours() ? " now" : ""),
            title: DAY_SHORT[di] + " " + pad2(h) + ":00 " + MDASH + " " + st.label,
          });
        }
        weekOff += off;
        days.push({
          name: DAY_SHORT[di],
          cls: di === todayIdx ? "today" : di === todayIdx + 1 ? "tmrw" : "",
          sub: di === todayIdx ? "today" : di === todayIdx + 1 ? "tmrw"
            : pad2(date.getDate()) + "." + pad2(date.getMonth() + 1),
          cells,
          total: fmtHours(off),
        });
      }
    }

    // --- the next window
    //
    // sensor.dtek_next_outage_start/_end derive from `fact`, which DTEK has
    // served empty since 24.07.2026, so they read unknown and the window has
    // to come out of the recurring table. They are preferred whenever they do
    // carry a timestamp: an applied schedule beats a recurring pattern.
    let win = null;
    const appliedStart = parseDate(a.next_outage_start);
    if (appliedStart) {
      const appliedEnd = parseDate(a.next_outage_end);
      const at = pad2(appliedStart.getHours()) + ":" + pad2(appliedStart.getMinutes());
      const when = this._whenPhrase(now, appliedStart);
      win = {
        label: at + DASH + (appliedEnd
          ? pad2(appliedEnd.getHours()) + ":" + pad2(appliedEnd.getMinutes()) : "?"),
        at, when: when.long, whenShort: when.short, certain: true,
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
          when: when.long, whenShort: when.short, certain: w.certain,
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
      } else {
        lede = "The inverter sees no mains. DTEK reports no outage of its own, "
          + "but the schedule has this hour dark, so it does not count as "
          + "unscheduled.";
      }
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
    if (reason) {
      reasonText = reason + ", " + queue;
      reasonKnown = true;
    } else if (dtekOutage) {
      reasonText = (OUTAGE_TYPE[a.outage_type] || "Outage") + ", " + queue;
      reasonKnown = true;
    }

    const published = a.schedule_update || "an unknown date";
    const inEffect = a.schedule_in_effect === true;
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

    return {
      accent: gridDown ? RED : GREEN,
      identity,
      headline, lede, note, queue, week, days, win,
      weekLive, hiddenReason,
      // Null rather than "0h": both are computed from a pattern DTEK has
      // withdrawn, and a zero reads as a measured week with no outages in it.
      weekOff: weekLive ? fmtHours(weekOff) : null,
      weekShare: weekLive ? Math.round((weekOff / 168) * 100) + "%" : null,
      stale,
      feedLabel: stale ? "Stale" : "Healthy",
      feedColor: stale ? ORANGE : GREEN,
      feedSentence: stale
        ? "The poller has not returned fresh data"
          + (a.error ? " (" + a.error + ")" : "")
          + ", so the times below may be out of date."
        : "The feed answered on the last poll, so the times below are current.",
      lastPoll: fmtClock(a.fetched_at) || "never",
      published: a.schedule_update || "unknown",
      updatedAt: a.updated_at || null,
      reasonText,
      reasonKnown,
    };
  }

  // --- drawing -------------------------------------------------------------

  _body(now) {
    const cfg = this._config;
    const main = this._stateObj(cfg.entity);
    if (!main) {
      return '<ha-card><div class="pad"><h2>DTEK Shutdowns</h2>'
        + '<p class="note err">' + esc(cfg.entity) + " does not exist. Is "
        + "packages/dtek_shutdowns.yaml loaded?</p></div></ha-card>";
    }
    const d = this._derive(now, main.attributes || {});
    const draw = { hero: () => this._hero(d), week: () => this._weekCard(d),
                   source: () => this._sourceCard(d) };
    return '<div class="wrap" style="--accent:' + d.accent + '">'
      + this._config.blocks.map((b) => draw[b]()).join("")
      + "</div>";
  }

  _hero(d) {
    const tile = (k, v, s, color) =>
      '<div class="tile"><span class="k">' + esc(k) + "</span>"
      + '<span class="v' + (v === null ? " dim" : "") + '"'
      + (color ? ' style="color:' + color + '"' : "") + ">"
      + esc(v === null ? MDASH : v) + "</span>"
      + '<span class="s">' + esc(s) + "</span></div>";

    return '<ha-card class="hero"><div class="pad">'
      + '<div class="hero-left">'
      + '<div class="eyebrow"><span class="dot"></span><span class="lbl">Right now</span>'
      + (d.identity ? '<span class="ident">' + esc(d.identity) + "</span>" : "")
      + "</div>"
      + "<h1>" + esc(d.headline) + "</h1>"
      + '<p class="lede">' + esc(d.lede) + "</p>"
      + '<p class="note">' + esc(d.note) + "</p>"
      + '<div class="reason"><span class="k">Reason</span>'
      + '<span class="v' + (d.reasonKnown ? "" : " dim") + '">'
      + esc(d.reasonText) + "</span></div>"
      + "</div>"
      + '<div class="tiles">'
      // Both of these are read off the recurring pattern. When DTEK withdraws
      // it they have no answer, and a dash is the honest one -- "0h off" would
      // be a claim about a week nobody has scheduled.
      + tile("Next window", d.win ? d.win.label : d.weekLive ? "none" : null,
             d.win ? d.win.when
               : d.weekLive ? "nothing in the table" : "no schedule published")
      + tile("Off this week", d.weekOff,
             d.weekShare ? d.weekShare + " of the week" : "not published")
      + tile("Feed", d.feedLabel, "Last poll " + d.lastPoll, d.feedColor)
      + "</div></div></ha-card>";
  }

  _weekCard(d) {
    // The card, its heading and the Published stamp stay in all three branches.
    // DTEK does the same -- discon-schedule.js:708 empties #tableRenderElem and
    // leaves the section standing -- and on the one screen anybody opens during
    // a blackout, a card that vanished is indistinguishable from a broken one.
    let inner;
    let blurb;
    if (!d.week) {
      blurb = null;
      inner = '<p class="note">DTEK publishes no recurring table for this '
        + "address.</p>";
    } else if (!d.weekLive) {
      blurb = null;
      inner = '<p class="note">' + esc(WITHHELD[d.hiddenReason] || WITHHELD.plan_off)
        + (WILL_RETURN.indexOf(d.hiddenReason) >= 0
           ? " Last published " + esc(d.published) + "." : "") + "</p>";
    } else {
      blurb = true;
      let hours = '<div class="hours">';
      for (let h = 0; h < 24; h++) hours += '<div class="hr">' + pad2(h) + "</div>";
      hours += "</div>";

      let cols = "";
      d.days.forEach((day) => {
        let cells = '<div class="cells">';
        day.cells.forEach((c) => {
          cells += '<div class="c ' + c.cls + '" title="' + esc(c.title) + '"></div>';
        });
        cells += "</div>";
        cols += '<div class="day ' + day.cls + '">'
          + '<div class="dhead"><span class="dname">' + esc(day.name) + "</span>"
          + '<span class="dsub">' + esc(day.sub) + "</span></div>"
          + cells
          + '<div class="dtot" title="' + esc(day.total)
          + ' off, possible outages included">' + esc(day.total)
          + "</div></div>";
      });

      inner = '<div class="grid">' + hours + cols + "</div>"
        + '<div class="legend">'
        + '<span><span class="sw on"></span>Power on</span>'
        + '<span><span class="sw maybe"></span>Possible outage</span>'
        + '<span><span class="sw out"></span>Scheduled outage</span>'
        + '<span><span class="sw maybe-2"></span>On for half the hour</span>'
        + '<span><span class="sw nowsw"></span>Now</span>'
        + "</div>";
    }

    return '<ha-card class="week"><div class="pad">'
      + '<div class="head"><h2>Recurring weekly schedule</h2>'
      + '<span class="stamp">Published ' + esc(d.published) + "</span></div>"
      + (blurb === null ? ""
         : '<p class="blurb">The pattern DTEK last published for '
           + esc(d.queue) + ". Today and tomorrow are highlighted; every other "
           + "column repeats weekly until a new schedule arrives. Possible "
           + "outages count as off in the totals, the same call the alerts "
           + "make.</p>")
      + inner + "</div></ha-card>";
  }

  _sourceCard(d) {
    const kv = (k, v) => '<div><span class="k">' + esc(k) + "</span>"
      + '<span class="v">' + esc(v) + "</span></div>";
    return '<ha-card><div class="pad">'
      + "<h2>Where this comes from</h2>"
      + '<p class="blurb">' + esc(d.feedSentence) + "</p>"
      + '<div class="kv">'
      + kv("Last poll", d.lastPoll)
      // DTEK's own freshness stamp, minutes old. Distinct from the one below,
      // which stamps the last schedule DTEK published and has read 24.07.2026
      // since the day they suspended them -- reading only that one makes a
      // live feed look six weeks dead.
      + kv("Information updated", d.updatedAt || "not reported")
      + kv("Schedule published", d.published)
      + kv("Schedule table", d.weekLive ? "shown"
             : "hidden" + (d.hiddenReason ? " " + MDASH + " " + d.hiddenReason : ""))
      + kv("Poll interval", this._config.poll_interval + " min")
      + "</div>"
      + '<div class="foot"><code>/config/dtek/dtek_poll.py</code> reads the AJAX '
      + 'endpoint behind <a href="https://www.dtek-dnem.com.ua/ua/shutdowns" '
      + 'target="_blank" rel="noopener">dtek-dnem.com.ua/ua/shutdowns</a>.</div>'
      + "</div></ha-card>";
  }

}

// --- styles ----------------------------------------------------------------
//
// Greys map onto theme variables so the card follows a theme change instead of
// staying a black rectangle on a light one. The four semantic colours stay
// literal: they mean something, and a theme must not repaint an outage green.
const STYLE = `
:host { display: block; }
.wrap {
  --mono: var(--code-font-family, ui-monospace, "Roboto Mono", SFMono-Regular, Consolas, monospace);
  /* Not a colour for anything -- it is what a cell looks like with no green
     in it. Mid-grey at low alpha so it reads the same on a light theme. */
  --dim-cell: rgba(127, 127, 127, .16);
  display: flex; flex-direction: column; gap: 16px;
  font-family: var(--paper-font-body1_-_font-family, Roboto, system-ui, sans-serif);
  font-size: 14px; line-height: 1.45; color: var(--primary-text-color);
  -webkit-font-smoothing: antialiased;
}
.pad { padding: 20px 22px; display: flex; flex-direction: column; gap: 14px; }
h1 { margin: 0; font-size: 34px; font-weight: 300; line-height: 1.15; }
h2 { margin: 0; font-size: 17px; font-weight: 500; }
p { margin: 0; }
code { font-family: var(--mono); }
a { color: #03a9f4; text-decoration: none; }
a:hover { text-decoration: underline; }

/* Outer-tree rules win over ha-card's own :host styles, border included. */
.hero { border-left: 4px solid var(--accent); }
.hero .pad {
  padding: 24px 28px; flex-direction: row; flex-wrap: wrap; gap: 32px;
  align-items: center;
}
.hero-left {
  flex: 1 1 380px; min-width: 240px; display: flex; flex-direction: column;
  gap: 10px;
}
.eyebrow { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.eyebrow .lbl {
  font-size: 12px; letter-spacing: .12em; text-transform: uppercase;
  color: var(--secondary-text-color);
}
/* The address and queue this schedule is for -- what the removed badge said. */
.ident {
  font-family: var(--mono); font-size: 12px; color: var(--secondary-text-color);
  border: 1px solid var(--divider-color); border-radius: 14px; padding: 3px 10px;
}
.dot {
  width: 10px; height: 10px; border-radius: 50%; flex: 0 0 auto;
  background: var(--accent); animation: dtekpulse 2.4s ease-in-out infinite;
}
@keyframes dtekpulse { 0%, 100% { opacity: 1 } 50% { opacity: .35 } }
@media (prefers-reduced-motion: reduce) { .dot { animation: none } }
.lede { font-size: 16px; opacity: .82; max-width: 46ch; text-wrap: pretty; }
.note {
  margin-top: 4px; font-size: 13px; color: var(--secondary-text-color);
  max-width: 52ch; text-wrap: pretty;
}
.note.err { color: var(--warning-color, #ffa600); }
.reason {
  display: flex; align-items: baseline; gap: 8px; margin-top: 6px;
  padding-top: 12px; border-top: 1px solid var(--divider-color); max-width: 52ch;
}
.reason .k {
  font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
  color: var(--secondary-text-color); white-space: nowrap;
}
.reason .v { font-size: 13px; text-wrap: pretty; }
.reason .v.dim { color: var(--disabled-text-color); }
.tile .v.dim { color: var(--disabled-text-color); }
.tiles { flex: 1 1 420px; display: flex; flex-wrap: wrap; gap: 12px; }
.tile {
  flex: 1 1 130px; background: var(--secondary-background-color, rgba(127,127,127,.12));
  border-radius: 10px; padding: 14px 16px; display: flex;
  flex-direction: column; gap: 4px;
}
.tile .k {
  font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
  color: var(--secondary-text-color);
}
.tile .v { font-size: 22px; font-weight: 400; font-family: var(--mono); }
.tile .s { font-size: 12px; color: var(--secondary-text-color); }

.head { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; }
.head h2 { flex: 1 1 auto; }
.stamp { font-size: 12px; color: var(--secondary-text-color); }
.blurb {
  font-size: 13px; color: var(--secondary-text-color); max-width: 70ch;
  text-wrap: pretty;
}

/*
 * overflow-x is kept even though the design dropped it. At any width where the
 * grid fits it is invisible, and at phone widths it is the only thing keeping
 * 168 cells from widening the whole page: below ~370px the grid needs more
 * room than the card has, and without this the body scrolls sideways instead
 * of the grid panning inside its own card.
 */
.grid {
  display: flex; gap: 6px; align-items: stretch; overflow-x: auto;
  padding-bottom: 4px; width: 100%;
}
.hours {
  flex: 0 0 42px; display: flex; flex-direction: column; gap: 3px;
  padding-top: 42px;
}
.hr {
  height: 15px; display: flex; align-items: center; justify-content: flex-end;
  font-family: var(--mono); font-size: 10px; color: var(--disabled-text-color);
}
.day {
  flex: 1 1 0; min-width: 34px; display: flex; flex-direction: column;
  border-radius: 8px; padding: 0 4px;
}
.day.today { background: rgba(3, 169, 244, .09); }
.day.tmrw { background: rgba(127, 127, 127, .07); }
.dhead {
  height: 38px; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 1px;
}
.dname {
  font-size: 12px; font-weight: 500; letter-spacing: .04em;
  color: var(--secondary-text-color);
}
.day.today .dname { color: #03a9f4; }
.day.tmrw .dname { color: var(--primary-text-color); }
.dsub {
  font-size: 10px; letter-spacing: .04em; color: var(--disabled-text-color);
}
.cells { display: flex; flex-direction: column; gap: 3px; }
.dtot {
  height: 26px; display: flex; align-items: center; justify-content: center;
  font-family: var(--mono); font-size: 11px; color: var(--secondary-text-color);
}

.c { height: 15px; border-radius: 3px; }
/* Green = the power is confirmed on. Everything else is the lack of it. */
.on { background: var(--success-color, #43a047); }
/* Possible outage. Deliberately not a warning colour: DTEK hedges most of the
   week, and painting all of it orange said nothing except "look at me". */
.maybe { background: var(--dim-cell); }
/* The one state DTEK actually commits to. Rare enough to be worth alarm --
   there is not a single one in this queue's current table. */
.out { background: var(--error-color, #db4437); }
.out-1 {
  background: linear-gradient(to bottom, var(--error-color, #db4437) 50%,
    var(--success-color, #43a047) 50%);
}
.out-2 {
  background: linear-gradient(to bottom, var(--success-color, #43a047) 50%,
    var(--error-color, #db4437) 50%);
}
.maybe-1 {
  background: linear-gradient(to bottom, var(--dim-cell) 50%,
    var(--success-color, #43a047) 50%);
}
.maybe-2 {
  background: linear-gradient(to bottom, var(--success-color, #43a047) 50%,
    var(--dim-cell) 50%);
}
/* Neither on nor off: a gap in what DTEK published. Hatched rather than tinted
   so it cannot be mistaken for a possible outage. */
.unknown {
  background: repeating-linear-gradient(45deg,
    rgba(127, 127, 127, .28) 0 2px, transparent 2px 4px);
}
/* outline, not box-shadow: .maybe already owns the inset shadow. */
.now { outline: 1.5px solid #03a9f4; outline-offset: -1.5px; }

.legend {
  display: flex; flex-wrap: wrap; gap: 18px; align-items: center;
  border-top: 1px solid var(--divider-color); padding-top: 14px;
  font-size: 12px; color: var(--secondary-text-color);
}
.legend > span { display: flex; align-items: center; gap: 7px; }
/* After the cell rules, so the swatch height wins over .c. */
.sw { width: 14px; height: 14px; border-radius: 3px; flex: 0 0 auto; }
.sw.nowsw {
  background: rgba(3, 169, 244, .16); box-shadow: inset 0 0 0 1px rgba(3, 169, 244, .5);
}

.kv { display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
.kv > div { display: flex; justify-content: space-between; gap: 12px; }
.kv .k { color: var(--secondary-text-color); }
.kv .v { font-family: var(--mono); }
.foot {
  border-top: 1px solid var(--divider-color); padding-top: 12px;
  font-size: 12px; color: var(--secondary-text-color); line-height: 1.6;
}

`;

if (!customElements.get(CARD)) customElements.define(CARD, DtekShutdownsCard);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === CARD)) {
  window.customCards.push({
    type: CARD,
    name: "DTEK Shutdowns",
    description: "Hero status, the recurring weekly outage heatmap, provenance "
      + "and the raw DTEK entities.",
    preview: false,
    documentationURL: "https://www.dtek-dnem.com.ua/ua/shutdowns",
  });
}

console.info("%c " + CARD + " %c " + VERSION + " ",
             "background:#cf3c33;color:#fff;border-radius:3px 0 0 3px",
             "background:#1c1c1c;color:#e1e1e1;border-radius:0 3px 3px 0");
