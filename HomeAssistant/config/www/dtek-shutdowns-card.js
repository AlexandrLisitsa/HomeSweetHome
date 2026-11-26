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
 *   week      DTEK's recurring table, a row of 24 hanging bulbs per day (lit =
 *             power on, cracked = off, the current hour ringed); while a schedule is applied,
 *             today's and tomorrow's rows show it instead;
 *   days      the applied today and tomorrow alone (kept for old configs);
 *   source    where the data comes from.
 */

const CARD = "dtek-shutdowns-card";
import { cardTip } from "./card-tip.js?v=1.0.0";

const VERSION = "2.17.1";

const MAP_CACHE = { url: null, data: null, busy: false, failed: false };

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
  banner: "DTEK's home-page popup, word for word: where it announces Ukrenergo's emergency outages.\n"
    + "E.g. red on 01.11.2026, outages in Dnipro; grey for a notice about elsewhere.",
  yasno: "YASNO's public outage status for this queue, read every five minutes.\n"
    + "E.g. EmergencyShutdowns: Ukrenergo's emergency outages, no schedule applies.",
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
    + "E.g. 19:30–02:30 runs from 19:30 until 02:30 the next morning.\n"
    + "A dash: DTEK publishes no table to forecast from.",
  week_off: "Dark hours in this week's recurring table, possible outages counted as off.\n"
    + "E.g. 16 dark hours every day come to 112h, 67% of the 168-hour week.\n"
    + "A dash: DTEK publishes no table to count.",
  feed: "Whether the DTEK poller still gets fresh, readable answers every 5 minutes.\n"
    + "E.g. Stale: the last poll failed, so the card shows the last good answer.\n"
    + "Drift: DTEK answered, but sent a field or format the poller cannot read.",
  cell: "One hour of DTEK's recurring weekly table; it repeats until DTEK publishes anew.\n"
    + "E.g. a flickering bulb: power for half the hour; its tooltip says which half.",
  day_total: "Dark hours that day in the weekly table, possible outages counted as off.\n"
    + "E.g. 16 grey hours plus two half-hour splits make 17h.",
  sched_cell: "One hour of the stabilisation schedule DTEK has applied to this day.\n"
    + "E.g. 17.10.2026 13:00 flickering: power until 13:30, then off.",
  sched_total: "Dark hours that day in the applied schedule, possible outages counted as off.\n"
    + "E.g. 17.10.2026: 13:30-17:00 off makes 3.5h.\n"
    + "A dash: DTEK has not published that day yet.",
  legend_on: "DTEK says the power stays on for the whole hour.\n"
    + "E.g. Mo 07:00 lit: no outage of any kind is planned 07:00–08:00.",
  legend_maybe: "DTEK may cut the power that hour; the totals and the alerts count it as off.\n"
    + "E.g. most of this queue's week is grey: DTEK hedges rather than commits.",
  legend_out: "A cracked bulb: DTEK commits to the power being off for the whole hour.\n"
    + "E.g. cracked at Mo 19:00: no grid from 19:00 to 20:00, for certain.",
  legend_half: "A flickering bulb: DTEK has the power on for only half of that hour.\n"
    + "E.g. 19:00 flickering: power until 19:30, then off; the tooltip says which half.",
  legend_unsched: "Off while DTEK's schedule and its notices both said the power would be on.\n"
    + "E.g. 10:15–11:00 amber: the inverter lost the grid and nobody had announced it.",
  legend_now: "The bulb with the pulsing ring is the current hour, in today's highlighted row.\n"
    + "E.g. at 14:20 on a Monday the Mo 14:00 bulb is ringed.",
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
  light: "Hours of mains since midnight, measured at the electricity meter: lit means grid.\n"
    + "E.g. 14h 20m by 18:00: the grid was gone for 3h 40m of the day so far.\n"
    + "It counts the battery hours with the grid still there as light, as they are.",
  day_light: "Hours that day the meter was lit, i.e. mains was there; green, under the plan.\n"
    + "E.g. 18h05 under 6h: DTEK planned six dark hours and the day had about six.\n"
    + "Blank: before the meter counted, or a day still to come.",
  lc_name: "Mains history: switch Daily totals or Hourly strips; click any day for modal.\n"
    + "E.g. Mo 23.11: 3h 48m on in one window, 18:48–22:36.\n"
    + "Drag to pan, scroll or pinch to zoom; double-click or pick a range for today.",
  lc_mode: "Switch between daily total bars (0–24h) and 24 hourly strips per day.\n"
    + "E.g. Hourly shows each hour 00–24 as its own strip on the same zoomable day axis.",
  lc_win: "The dates shown on the bar chart; days before 14.11.2026 come from inverter voltage.\n"
    + "E.g. last 14 days, or 02.11–08.11 after dragging back into earlier history.",
  lc_range: "Shows this span of daily light bars ending today and resets any pan or zoom.\n"
    + "E.g. 30d shows the last month of recorded days; All covers every day on record.",
  lc_stat: "Today is live from the meter; Min, Max and Mean cover completed days in the window.\n"
    + "E.g. 7d: Min 3h 48m, Max 22h 0m, Mean 15h 46m across the six finished days.",
  map_view: "Fly the map between Dnipropetrovsk Region (86 hromadas) and Dnipro city.\n"
    + "E.g. Dnipro zooms into 8 city districts and 37 microzones across both banks.\n"
    + "Tap to fly camera; scroll wheel over the map zooms freely.",
  map_lod: "Choose map region detail or let wheel zoom switch layers automatically.\n"
    + "E.g. Auto shows 86 hromadas at 1x, 8 districts at 2.2x, microzones at 4.6x.\n"
    + "Tap Auto, Hromadas, Districts or Microzones.",
  map_zoom: "Zoom in, zoom out, or reset the regional map back to 1x view.\n"
    + "E.g. wheel up over Dnipro zooms smoothly to cursor; drag to pan when zoomed.\n"
    + "Tap +, - or 1x, or double-click the map.",
  map_mode: "Color regions by the selected queue alone or all queues live outage share.\n"
    + "E.g. All live shows a heatmap of dark percentage across mixed areas.\n"
    + "Tap to switch Queue vs All live.",
  map_q: "Outage queue status now from DTEK and YASNO feeds.\n"
    + "E.g. 14.1 starred is this home; red dot means off, amber means soon.\n"
    + "Tap any queue to view its clock, timeline and bulbs.",
  map_home: "Return the dashboard from an inspected queue back to this home.\n"
    + "E.g. clicking back from 8.1 restores queue 14.1 and live meter data.\n"
    + "Tap to reset selection to home.",
  tl_cmp: "Your home queue's applied schedule for today, 00:00–24:00, for reference.\n"
    + "E.g. compare 09:00–13:00 dark here against the inspected queue above.",
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
  // Ukrenergo's emergency outages, from the announcement popup. The card reads
  // this rather than the raw banner_emergency attribute: the binary sensor is
  // the debounced, freshness-checked verdict an alert would use.
  emergency_entity: "binary_sensor.dtek_emergency_shutdowns",
  // Hours of light today, measured at the electricity meter (history_stats in
  // packages/electricity_meter.yaml). Past days come from its long-term
  // statistics. Null, or an entity that does not exist, leaves it all out.
  light_entity: "sensor.grid_light_today",
  // Static hex-mosaic map geometry (generated by tools/build_dtek_map.py).
  map_url: "/local/dtek-map-data.json",
  map_data: null,
  poll_interval: 5, // minutes; matches scan_interval: 300 on the sensor
  debug_state: null, // on | outage | dtek | unscheduled | stale -- render only
  debug_banner: null, // emergency | pending | notice | none -- render only
  // The same two overrides read from entities (an input_select whose options
  // are the values above, plus "live" for the real data), so a Playground can
  // switch them from the page. Null on every real dashboard.
  debug_state_entity: null,
  debug_banner_entity: null,
  // How the week and days blocks draw an hour: "classic", a row of light
  // bulbs per day, or "grid", the older column of bars per day.
  week_style: "classic",
  // Which of the three blocks this instance draws, in the order given.
  //
  // It exists so the provenance block can sit BELOW the claim-against-
  // measurement section, which is a separate dashboard section and cannot be
  // reordered from inside a card. Not a styling knob -- see BLOCKS.
  blocks: ["hero", "timeline", "week", "source"],
};

const BLOCKS = ["hero", "timeline", "days", "week", "source"];
// Presets and geometry for the "Light, measured at the meter" history bar chart.
const LIGHT_RANGES = {
  "7d": { days: 7, label: "last 7 days" },
  "14d": { days: 14, label: "last 14 days" },
  "30d": { days: 30, label: "last 30 days" },
  all: { days: null, label: "all recorded" },
};
const LIGHT_RANGE_ORDER = ["7d", "14d", "30d", "all"];
const LIGHT_MODES = [
  { id: "daily", label: "Daily", tip: "Daily totals (0–24h bars)" },
  { id: "hourly", label: "Hourly", tip: "Hourly strips (24 hours per day)" },
];
const LC_W = 1000;
const LC_H = 148;
const LC_PAD_T = 22;
const LC_PAD_B = 6;
const LC_HR_H = 252;
const LC_HR_PAD_T = 6;
const LC_HR_PAD_B = 6;
const LC_MIN_DAYS = 5;
// Matches night_tariff_start / night_tariff_end in PowerStation/power-station.yaml.
const NIGHT_START = 23;
const NIGHT_END = 7;
// Days before 14.11.2026 were estimated from inverter voltage (docs/electricity-meter.md).
const EST_CUTOFF_DN = Math.round(Date.UTC(2026, 10, 14) / 864e5);
// How often the timeline asks the recorder again while nothing it shows changed.
const HISTORY_TTL = 5 * 60000;

const DEBUG_STATES = ["on", "outage", "dtek", "unscheduled", "stale"];

const WEEK_STYLES = ["classic", "grid"];

/*
 * The bulb: a standard A-shape bulb hanging base-up, drawn once per hour in a
 * 40x64 box. It is drawn upright and turned over as a group, so the ribbed
 * screw base and its dark tip sit on top and the globe hangs below; the hour
 * and the glass highlight are drawn after the turn so they stay upright.
 * Colours come from the state class through CSS (the gradients are in
 * CLASSIC_DEFS); the halo round a lit bulb is a plain radial background, not
 * a blur filter, so 168 of them stay cheap to paint. An hour without power
 * is a broken bulb: dark glass with cracks across it.
 */
const CLASSIC_GLASS = "M13.5 41 C13.5 34 4 29.5 4 18 A16 16 0 0 1 36 18 C36 29.5 26.5 34 26.5 41 Z";
// Two cracks running in from the rim, clear of the hour in the middle.
const CLASSIC_CRACK = "M5.2 12 L9.5 14.2 L8.6 18 L12 20.4 M9.5 14.2 L12.6 11.2 L12.2 8.4 "
  + "M34.6 23 L30.4 24.4 L31 28.2 L27.4 30.6 M30.4 24.4 L28 21.6";
const classicBulb = (hour, now, broken, half) => '<svg viewBox="0 0 40 64" aria-hidden="true">'
  + '<g transform="rotate(180 20 32)">'
  // The current hour: an outline that pulses round the glass, so "where we
  // are" reads from across the room.
  + (now ? '<path class="ring" d="' + CLASSIC_GLASS + '"/>' : "")
  + '<path class="g" d="' + CLASSIC_GLASS + '"/>'
  + '<path class="fil" d="M17.5 41 L17.5 33 L14.5 28 M22.5 41 L22.5 33 L25.5 28 '
  + 'M14.5 28 l1.5 -1.4 l1.5 1.4 l1.5 -1.4 l1.5 1.4 l1.5 -1.4 l1.5 1.4 l1.5 -1.4 l1.5 1.4"/>'
  // Power for only half the hour: a lit bulb with dark glass over it that
  // cuts in and out, like a bulb about to die.
  + (half ? '<path class="g2" d="' + CLASSIC_GLASS + '"/>' : "")
  + (broken ? '<path class="crack" d="' + CLASSIC_CRACK + '"/>' : "")
  + '<rect class="cap" x="13" y="41" width="14" height="2.6" rx="1"/>'
  + '<rect class="cap" x="13.4" y="44" width="13.2" height="2.4" rx="1.2"/>'
  + '<rect class="cap" x="13.4" y="47" width="13.2" height="2.4" rx="1.2"/>'
  + '<rect class="cap" x="13.4" y="50" width="13.2" height="2.4" rx="1.2"/>'
  + '<path class="tip" d="M15 53 L25 53 L22.5 57 L17.5 57 Z"/>'
  + "</g>"
  + '<ellipse class="hl" cx="13" cy="40" rx="3.6" ry="6" transform="rotate(28 13 40)"/>'
  + (hour === null ? "" : '<text class="t" x="20" y="49.5" text-anchor="middle">' + hour + "</text>")
  + "</svg>";
const CLASSIC_DEFS = '<svg class="defs" width="0" height="0" aria-hidden="true"><defs>'
  + '<radialGradient id="cb-on" cx="50%" cy="38%" r="60%"><stop offset="0" stop-color="#fffef2"/>'
  + '<stop offset=".45" stop-color="#fff07a"/><stop offset="1" stop-color="#f4c20d"/></radialGradient>'
  + '<radialGradient id="cb-off" cx="40%" cy="32%" r="70%"><stop offset="0" stop-color="#3a3f49"/>'
  + '<stop offset="1" stop-color="#14161a"/></radialGradient>'
  + '<radialGradient id="cb-maybe" cx="50%" cy="38%" r="65%"><stop offset="0" stop-color="#8a6a2a"/>'
  + '<stop offset="1" stop-color="#2e2416"/></radialGradient>'
  // Half an hour of power: the lit glass at half brightness, under the flicker.
  + '<radialGradient id="cb-half" cx="50%" cy="38%" r="60%"><stop offset="0" stop-color="#c9bd7a"/>'
  + '<stop offset=".45" stop-color="#b3a13a"/><stop offset="1" stop-color="#8a7008"/></radialGradient>'
  // ... and the dark glass the flicker cuts to.
  + '<radialGradient id="cb-dim" cx="50%" cy="38%" r="62%"><stop offset="0" stop-color="#7a6626"/>'
  + '<stop offset=".5" stop-color="#4a3e16"/><stop offset="1" stop-color="#2a230d"/></radialGradient>'
  + '<linearGradient id="cb-metal"><stop offset="0" stop-color="#6d7178"/><stop offset=".35" stop-color="#e9ebee"/>'
  + '<stop offset=".7" stop-color="#9ba0a8"/><stop offset="1" stop-color="#585c63"/></linearGradient>'
  + "</defs></svg>";


// debug_banner: the announcement popup, render only, like debug_state. The
// emergency text is DTEK's own of 01.11.2026; the notice is a country-wide
// one, which the poller shows but never flags -- this is how it looks.
// "pending" is the emergency text read but the entity not on yet: the ten
// minutes of delay_on, or a banner older than twenty minutes. "yasno" is the
// entity on from YASNO's queue status with no fresh popup to quote.
const DEBUG_BANNERS = ["emergency", "pending", "notice", "yasno", "none"];
const SAMPLE_BANNER = {
  emergency: { title: "Шановні клієнти!", scope: "city", text:
    "За рішенням Укренерго запроваджено екстрені відключення по місту Дніпро.\n"
    + "Це непередбачені графіками обмеження, тож прогнозувати тривалість відключень наразі неможливо.\n"
    + "Якщо у вашій оселі є світло – споживайте його свідомо та ощадливо." },
  notice: { title: "Шановні клієнти!", scope: "other", text:
    "Через масовані атаки на енергосистему в багатьох регіонах України діють екстрені відключення.\n"
    + "Слідкуйте за оновленнями на сайті та в чат-ботах." },
};

const DASH = "–"; // en dash, for 07:00-10:00
const MDASH = "—";
// How old a read of DTEK's popup may be before the card stops showing it as
// current. Same limit as binary_sensor.dtek_emergency_shutdowns' availability.
const BANNER_MAX_AGE_MIN = 20;
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
function tipText(name, state, key) {
  let first = state === null || state === undefined || state === ""
    ? name : name + " " + MDASH + " " + state;
  if (first.length > 90) first = first.slice(0, 89) + "…";
  return first + "\n" + HELP[key];
}

function tip(name, state, key) {
  return ' data-tip="' + esc(tipText(name, state, key)) + '"';
}

/** 17 -> "17h", 16.5 -> "16.5h". Half-hour states make the fractions real. */
const fmtHours = (h) =>
  (Math.abs(h - Math.round(h)) < 0.001 ? String(Math.round(h)) : h.toFixed(1)) + "h";

/** 14.33 -> "14h 20m" (the hero), or "14h20" (a week row, `tight`). */
function fmtHM(hours, tight) {
  const mins = Math.max(0, Math.round(hours * 60));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return tight ? h + "h" + pad2(m) : h + "h " + m + "m";
}

/** A local date as "2026-11-14", the key the light statistics are kept under. */
const dayKey = (d) => d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());

/** DST-safe integer UTC day number for a local calendar date. */
const dayNum = (d) => Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);

/** Local midnight Date for an integer dayNum(). */
function dateFromDayNum(n) {
  const u = new Date(n * 864e5);
  return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate());
}

/** Format a fractional hour [0..24] as "HH:MM" (24 -> "24:00"). */
function fmtClockH(h) {
  const mins = Math.max(0, Math.min(1440, Math.round(h * 60)));
  if (mins >= 1440) return "24:00";
  return pad2(Math.floor(mins / 60)) + ":" + pad2(mins % 60);
}

/** Reconstruct [startH, endH] light intervals inside [0, 24] from hourly min/max/mean. */
function reconstructDaySpans(hrs, fracs) {
  const raw = [];
  for (let h = 0; h < 24; h++) {
    const d = fracs[h];
    if (d === null || d < 0.01) continue;
    if (d >= 0.98) {
      raw.push([h, h + 1]);
      continue;
    }
    const prevLit = h > 0 && fracs[h - 1] !== null && fracs[h - 1] >= 0.95;
    const nextLit = h < 23 && fracs[h + 1] !== null && fracs[h + 1] >= 0.95;
    if (h === 0) {
      const a = nextLit ? 1 - d : 0;
      raw.push([a, a + d]);
      continue;
    }
    const row = hrs[h];
    const mn = row && row.min !== null ? row.min : null;
    const mean = row && row.mean !== null ? row.mean : null;
    let a;
    if (mn !== null && mean !== null && d > 0.02) {
      const ratio = (mean - mn) / d;
      // Pre-14.11 backfilled rows use midpoint mean = (min+max)/2; snap to lit neighbor.
      if (Math.abs(ratio - 0.5) < 0.003 && prevLit !== nextLit) {
        a = nextLit ? 1 - d : 0;
      } else {
        a = Math.max(0, Math.min(1 - d, 1 - d / 2 - ratio));
      }
    } else if (nextLit && !prevLit) {
      a = 1 - d;
    } else if (prevLit && !nextLit) {
      a = 0;
    } else {
      a = (1 - d) / 2;
    }
    raw.push([h + a, h + a + d]);
  }
  const merged = [];
  raw.forEach(([s, e]) => {
    if (merged.length && s - merged[merged.length - 1][1] <= 0.05) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    } else {
      merged.push([s, e]);
    }
  });
  return merged;
}

/**
 * Daily hours of light and reconstructed 00–24 periods from hourly statistics.
 *
 * sensor.grid_light_today (history_stats) resets shortly after midnight
 * (00:00:xx), so the 00:00–01:00 bucket carries yesterday's final total as its
 * `max`. Skipping hour 00 for the daily total leaves 01:00–23:00; because the
 * counter is monotonically non-decreasing after midnight's reset, that still
 * preserves any light recorded between 00:00 and 01:00.
 */
function dailyLightFromHours(rows) {
  const days = {};
  const hrsByDay = {};
  const spans = {};
  const hourFracs = {};
  let firstDay = null;
  if (!Array.isArray(rows)) return { days, spans, hourFracs, firstDay };
  const numOrNull = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  rows.forEach((row) => {
    if (!row) return;
    const start = typeof row.start === "number" ? new Date(row.start) : parseDate(row.start);
    const mx = numOrNull(row.max);
    if (!start || mx === null) return;
    const key = dayKey(start);
    const h = start.getHours();
    const mn = numOrNull(row.min);
    const mean = numOrNull(row.mean);
    const dayHrs = hrsByDay[key] || (hrsByDay[key] = {});
    const prev = dayHrs[h];
    if (!prev) {
      dayHrs[h] = { min: mn, max: mx, mean, n: mean !== null ? 1 : 0 };
    } else {
      if (mn !== null) prev.min = prev.min === null ? mn : Math.min(prev.min, mn);
      prev.max = Math.max(prev.max, mx);
      if (mean !== null) {
        prev.mean = prev.mean === null ? mean : (prev.mean * prev.n + mean) / (prev.n + 1);
        prev.n += 1;
      }
    }
    if (h === 0) return;
    if (days[key] === undefined || mx > days[key]) days[key] = mx;
    const dn = dayNum(start);
    if (firstDay === null || dn < firstDay) firstDay = dn;
  });

  Object.keys(days).forEach((key) => {
    const hrs = hrsByDay[key] || {};
    const fracs = new Array(24).fill(null);
    if (hrs[1] && hrs[1].min !== null) {
      fracs[0] = Math.max(0, Math.min(1, hrs[1].min));
    } else if (hrs[0] && hrs[0].max !== null && hrs[0].max <= 1.01) {
      fracs[0] = Math.max(0, Math.min(1, hrs[0].max));
    }
    for (let h = 1; h < 24; h++) {
      if (!hrs[h] || hrs[h].max === null) continue;
      if (hrs[h].min !== null) {
        fracs[h] = Math.max(0, Math.min(1, hrs[h].max - hrs[h].min));
      } else if (h >= 2 && hrs[h - 1] && hrs[h - 1].max !== null) {
        fracs[h] = Math.max(0, Math.min(1, hrs[h].max - hrs[h - 1].max));
      }
    }
    hourFracs[key] = fracs;
    spans[key] = reconstructDaySpans(hrs, fracs);
  });

  return { days, spans, hourFracs, firstDay };
}

/** Hours of light falling in Day (07:00–23:00) vs Night (23:00–07:00). */
function tariffSplit(spans) {
  let day = 0, night = 0;
  const ov = (a, b, c, d) => Math.max(0, Math.min(b, d) - Math.max(a, c));
  (spans || []).forEach(([s, e]) => {
    day += ov(s, e, NIGHT_END, NIGHT_START);
    night += ov(s, e, 0, NIGHT_END) + ov(s, e, NIGHT_START, 24);
  });
  return { day, night };
}

/** Complement dark stretches inside [0, endH], dropping slivers under ~0.6 min. */
function darkSpansOf(lightSpans, endH) {
  const out = [];
  let cur = 0;
  (lightSpans || []).forEach(([s, e]) => {
    const a = Math.max(0, Math.min(endH, s));
    const b = Math.max(0, Math.min(endH, e));
    if (a - cur > 0.01) out.push([cur, a]);
    if (b > cur) cur = b;
  });
  if (endH - cur > 0.01) out.push([cur, endH]);
  return out;
}

/** Full continuous light or dark stretch when a segment crosses midnight. */
function continuousSpan(dn, kind, localSpan, getDaySpans, todayN, nowH) {
  const spansOf = (d) => {
    const ls = getDaySpans(d);
    if (!ls) return null;
    if (kind === "light") return ls;
    return darkSpansOf(ls, d === todayN ? nowH : 24);
  };
  let startDn = dn, startH = localSpan[0];
  let endDn = dn, endH = localSpan[1];
  let cur = dn;
  while (startH <= 0.05 && dn - cur < 14) {
    const prevList = spansOf(cur - 1);
    if (!prevList || !prevList.length) break;
    const prevLast = prevList[prevList.length - 1];
    if (prevLast[1] < 23.95) break;
    startDn = cur - 1;
    startH = prevLast[0];
    cur--;
  }
  cur = dn;
  while (endH >= 23.95 && cur < todayN && cur - dn < 14) {
    const nextList = spansOf(cur + 1);
    if (!nextList || !nextList.length) break;
    const nextFirst = nextList[0];
    if (nextFirst[0] > 0.05) break;
    endDn = cur + 1;
    endH = nextFirst[1];
    cur++;
  }
  return {
    startDn, startH, endDn, endH,
    hours: Math.max(0, (endDn - startDn) * 24 + (endH - startH)),
    crosses: startDn < dn || endDn > dn,
  };
}

/** Share of visible recorded days that had light for >= 30 min in `hour`. */
function hourReliability(hour, items, todayN, nowH) {
  let lit = 0, total = 0;
  (items || []).forEach((item) => {
    if (typeof item.h !== "number") return;
    if (item.isToday) {
      if (hour > Math.floor(nowH) || (hour === Math.floor(nowH) && nowH - hour < 0.5)) return;
    }
    total++;
    let frac = item.hourFracs ? item.hourFracs[hour] : null;
    if (frac === null || frac === undefined) {
      let ov = 0;
      (item.spans || []).forEach(([s, e]) => {
        ov += Math.max(0, Math.min(e, hour + 1) - Math.max(s, hour));
      });
      frac = ov;
    }
    if (frac >= 0.5) lit++;
  });
  return total ? { hour, lit, total, pct: Math.round((lit / total) * 100) } : null;
}

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

function queueSortKey(q) {
  const m = /^(\d+)\.(\d+)$/.exec(String(q || "").replace("GPV", ""));
  return m ? [0, Number(m[1]), Number(m[2]), String(q)] : [1, 0, 0, String(q)];
}

function sortQueueCodes(list) {
  return list.slice().sort((a, b) => {
    const ka = queueSortKey(a), kb = queueSortKey(b);
    for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return ka[3] < kb[3] ? -1 : ka[3] > kb[3] ? 1 : 0;
  });
}

function resolveQueueRef(allQueues, q) {
  if (!allQueues) return null;
  if (allQueues[q]) return q;
  const m = /^(\d+)\.\d+$/.exec(String(q || ""));
  if (m && allQueues[m[1] + ".1"]) return m[1] + ".1";
  return null;
}

function queueNextWindow(today, tomorrow, now) {
  const days = [
    typeof today === "string" && today.length === 24 ? today : null,
    typeof tomorrow === "string" && tomorrow.length === 24 ? tomorrow : null,
  ];
  if (!days[0]) return null;
  const dark = (i) => {
    const row = days[Math.floor(i / 48)];
    return !!row && halfDark(row[Math.floor((i % 48) / 2)], i % 2);
  };
  const slot = now.getHours() * 2 + (now.getMinutes() >= 30 ? 1 : 0);
  let i = slot;
  while (i < 96 && dark(i)) i++;
  while (i < 96 && !dark(i)) i++;
  if (i >= 96) return null;
  let end = i;
  while (end < 95 && dark(end + 1)) end++;
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const at = (s) => new Date(base.getTime() + s * 18e5);
  const row = days[Math.floor(i / 48)];
  const ch = row[Math.floor((i % 48) / 2)];
  return { start: at(i), end: at(end + 1), certain: CERTAIN.indexOf(ch) >= 0 };
}

function queueStatusNow(qCode, allQueues, now) {
  const ref = resolveQueueRef(allQueues, qCode);
  const info = ref ? allQueues[ref] : null;
  if (!info) return "none";
  if (info.y === "EmergencyShutdowns") return "emerg";
  const today = typeof info.t === "string" && info.t.length === 24 ? info.t : null;
  if (!today) return "none";
  const slot = now.getHours() * 2 + (now.getMinutes() >= 30 ? 1 : 0);
  if (halfDark(today[Math.floor(slot / 2)], slot % 2)) return "off";
  const nxt = queueNextWindow(today, info.m, now);
  if (nxt && (nxt.start.getTime() - now.getTime()) <= 3600000) return "soon";
  return "on";
}

function mapStatusColor(st) {
  if (st === "off") return { fill: "#bb635b", hi: "#ff928a" };
  if (st === "emerg") return { fill: "url(#ds-map-emerg)", hi: "#ff928a" };
  if (st === "soon") return { fill: "#ae8446", hi: "#f2be62" };
  if (st === "on") return { fill: "#589569", hi: "#62d6a8" };
  return { fill: "#2a2e36", hi: "#8a909b" };
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
    // Light history chart: live preset, granularity mode, or custom { start, end } day-index viewport.
    this._lcMode = "daily";
    this._lcRange = "7d";
    this._lcView = null;
    this._lcDom = null;
    this._lcData = null;
    this._lcPointers = new Map();
    this._lcGesture = null;
    this._lcDragging = false;
    this._lcMoved = false;
    this._shell = null;
    this._lcHover = null;
    this._lcModalDn = null;
    this._lcModalSeg = null;
    this._lcHoverSeg = null;
    this._lcDeferredRender = false;
    // Interactive regional/city map state: null = home's own queue.
    this._selectedQueue = null;
    this._mapCam = { tx: 0, ty: 0, s: 1 };
    this._mapLodMode = "auto";
    this._mapColorMode = "selected";
    this._mapAnim = null;
    this._mapDrag = null;
    this._mapDragMoved = false;
    this._mapPointers = new Map();
    this._mapPinch = null;
    this._mapMeta = null;
    this._mapHoverCtx = null;
    this._mapHoverKey = null;
    // Off screen or in a hidden tab: nothing moves and nothing is fetched.
    this._offscreen = false;
    this._onVisibility = () => this._pause();
    this._onDocKey = (ev) => {
      if (this._lcModalDn === null || ev.defaultPrevented) return;
      if (ev.key === "Escape") {
        this._closeLcModal();
        if (typeof ev.preventDefault === "function") ev.preventDefault();
      } else if (ev.key === "ArrowLeft") {
        this._stepLcModal(-1);
        if (typeof ev.preventDefault === "function") ev.preventDefault();
      } else if (ev.key === "ArrowRight") {
        this._stepLcModal(1);
        if (typeof ev.preventDefault === "function") ev.preventDefault();
      }
    };
    // Anything carrying data-more opens HA's own dialog for that entity, as the
    // stock history-graph's rows did. lrange/lmode switch the light chart;
    // lc-* controls manage the 24h day modal.
    const act = (ev) => {
      if (ev.type === "click" && this._lcModalDn !== null && this._shell && ev.target === this._shell.modal) {
        this._closeLcModal();
        return true;
      }
      let el = ev.target;
      while (el && el !== this.shadowRoot) {
        if (el.getAttribute) {
          const da = el.getAttribute("data-act");
          if (da === "lmode") {
            const val = el.getAttribute("data-val");
            if (val === "daily" || val === "hourly") {
              if (this._lcMode !== val) {
                this._lcMode = val;
                this._lcHover = null;
                this._patchLightChart(new Date());
              }
              return true;
            }
          }
          if (da === "lrange") {
            const val = el.getAttribute("data-val");
            if (LIGHT_RANGES[val]) {
              this._lcRange = val;
              this._lcView = null;
              this._resetLcModalDom();
              this._patchLightChart(new Date());
              if (this._lcDeferredRender) {
                this._lcDeferredRender = false;
                this._render();
              }
              return true;
            }
          }
          if (da === "lc-prev") {
            if (!el.disabled && !el.hasAttribute("disabled")) this._stepLcModal(-1);
            return true;
          }
          if (da === "lc-next") {
            if (!el.disabled && !el.hasAttribute("disabled")) this._stepLcModal(1);
            return true;
          }
          if (da === "lc-close") {
            this._closeLcModal();
            return true;
          }
          if (da === "lc-seg") {
            if (this._lcModalDn === null) return false;
            const kind = el.getAttribute("data-kind");
            const idx = Number(el.getAttribute("data-idx"));
            if (this._lcModalSeg && this._lcModalSeg.kind === kind && this._lcModalSeg.idx === idx) {
              this._lcModalSeg = null;
            } else {
              this._lcModalSeg = { kind, idx };
            }
            this._lcHoverSeg = this._lcModalSeg;
            this._renderLcModalSeg(this._lcModalSeg);
            return true;
          }
          if (da === "map-q") {
            const val = el.getAttribute("data-val");
            if (val) {
              const home = this._homeQueueCode();
              this._selectedQueue = (this._selectedQueue === val || val === home) ? null : val;
              this._render();
            }
            return true;
          }
          const regQ = el.getAttribute("data-reg-q");
          if (regQ) {
            if (this._mapDragMoved) return true;
            this._hideMapHover();
            const home = this._homeQueueCode();
            const main = this._stateObj(this._config.entity);
            const aq = (main && main.attributes && main.attributes.all_queues) || null;
            const target = resolveQueueRef(aq, regQ) || regQ;
            this._selectedQueue = (this._selectedQueue === target || target === home) ? null : target;
            this._render();
            return true;
          }
          if (da === "map-home") {
            if (this._selectedQueue !== null) {
              this._selectedQueue = null;
              this._render();
            }
            return true;
          }
          if (da === "map-cam") {
            const val = el.getAttribute("data-val");
            if (val === "region") {
              this._mapLodMode = "auto";
              this._flyMapTo(310, 200, 1);
            } else if (val === "dnipro") {
              const dc = (this._mapMeta && this._mapMeta.dniproCam) || { cx: 316.88, cy: 170.34, scale: 6.62 };
              this._mapLodMode = "auto";
              this._flyMapTo(dc.cx, dc.cy, dc.scale);
            }
            return true;
          }
          if (da === "map-lod") {
            const val = el.getAttribute("data-val");
            if (val === "auto" || val === "hromadas" || val === "districts" || val === "quarters") {
              this._mapLodMode = val;
              this._applyMapCamera();
            }
            return true;
          }
          if (da === "map-zoom") {
            const val = el.getAttribute("data-val");
            const c = this._mapCam;
            if (val === "in") {
              this._flyMapTo((310 - c.tx) / c.s, (200 - c.ty) / c.s, Math.min(14, c.s * 1.8));
            } else if (val === "out") {
              this._flyMapTo((310 - c.tx) / c.s, (200 - c.ty) / c.s, Math.max(1, c.s / 1.8));
            } else if (val === "reset") {
              this._mapLodMode = "auto";
              this._flyMapTo(310, 200, 1);
            }
            return true;
          }
          if (da === "map-mode") {
            const val = el.getAttribute("data-val");
            if (val === "selected" || val === "all") {
              if (this._mapColorMode !== val) {
                this._mapColorMode = val;
                this._render();
              }
            }
            return true;
          }
          const more = el.getAttribute("data-more");
          if (more) {
            this.dispatchEvent(new CustomEvent("hass-more-info", {
              detail: { entityId: more }, bubbles: true, composed: true,
            }));
            return true;
          }
        }
        el = el.parentNode;
      }
      return false;
    };
    this.shadowRoot.addEventListener("click", act);
    this.shadowRoot.addEventListener("keydown", (ev) => {
      if (this._lcModalDn !== null && !ev.defaultPrevented) {
        if (ev.key === "Escape") {
          this._closeLcModal();
          if (typeof ev.preventDefault === "function") ev.preventDefault();
          return;
        }
        if (ev.key === "ArrowLeft") {
          this._stepLcModal(-1);
          if (typeof ev.preventDefault === "function") ev.preventDefault();
          return;
        }
        if (ev.key === "ArrowRight") {
          this._stepLcModal(1);
          if (typeof ev.preventDefault === "function") ev.preventDefault();
          return;
        }
      }
      if ((ev.key === "Enter" || ev.key === " ") && act(ev)) ev.preventDefault();
    });
  }

  setConfig(config) {
    const cfg = Object.assign({}, DEFAULTS, config || {});
    if (!cfg.entity) throw new Error(CARD + ": entity is required");
    if (cfg.debug_state && DEBUG_STATES.indexOf(cfg.debug_state) < 0) {
      throw new Error(CARD + ": debug_state must be one of " + DEBUG_STATES.join(", "));
    }
    if (cfg.debug_banner && DEBUG_BANNERS.indexOf(cfg.debug_banner) < 0) {
      throw new Error(CARD + ": debug_banner must be one of " + DEBUG_BANNERS.join(", "));
    }
    // A bare `week_style:` in YAML arrives as null: the default, not an error.
    if (cfg.week_style === null || cfg.week_style === undefined) cfg.week_style = DEFAULTS.week_style;
    if (WEEK_STYLES.indexOf(cfg.week_style) < 0) {
      throw new Error(CARD + ": week_style must be one of " + WEEK_STYLES.join(", "));
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
    if (this._shell) this._shell.slotKey = null;
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
      document.addEventListener("keydown", this._onDocKey);
    }
  }

  disconnectedCallback() {
    if (this._timer) window.clearInterval(this._timer);
    this._timer = null;
    if (this._seen) this._seen.disconnect();
    if (typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", this._onVisibility);
      document.removeEventListener("keydown", this._onDocKey);
    }
    this._lcPointers.clear();
    this._lcDragging = false;
    if (this._mapAnim && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this._mapAnim);
    this._mapAnim = null;
    this._mapPointers.clear();
    this._mapDrag = null;
    this._hideMapHover();
  }

  /** Every animation holds while no one can see the card; coming back catches up. */
  _pause() {
    const paused = this._offscreen || !!document.hidden;
    if (paused) {
      this.setAttribute("paused", "");
      this._hideMapHover();
    } else {
      this.removeAttribute("paused");
    }
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

  _homeQueueCode() {
    const main = this._config ? this._stateObj(this._config.entity) : null;
    const a = (main && main.attributes) || {};
    return a.queue || (Array.isArray(a.queues) && a.queues.length
      ? a.queues.map((q) => q.replace("GPV", "")).join(" / ") : null);
  }

  _ensureMapData() {
    const cfg = this._config || DEFAULTS;
    if (cfg.map_data) return cfg.map_data;
    const url = cfg.map_url;
    if (!url) return null;
    if (MAP_CACHE.url === url && MAP_CACHE.data) return MAP_CACHE.data;
    if (MAP_CACHE.url !== url) {
      MAP_CACHE.url = url;
      MAP_CACHE.data = null;
      MAP_CACHE.failed = false;
    }
    if (MAP_CACHE.busy || MAP_CACHE.failed) return MAP_CACHE.data;
    if (typeof fetch !== "function" || typeof window === "undefined"
        || !window.location || !/^https?:/.test(window.location.protocol || "")) {
      return null;
    }
    MAP_CACHE.busy = true;
    const sep = url.indexOf("?") >= 0 ? "&" : "?";
    fetch(url + sep + "v=" + encodeURIComponent(VERSION))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
      .then((data) => {
        MAP_CACHE.data = data;
        MAP_CACHE.busy = false;
        this._fingerprint = null;
        this._render();
      })
      .catch(() => {
        MAP_CACHE.busy = false;
        MAP_CACHE.failed = true;
      });
    return null;
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
      cfg.outage_entity, cfg.scheduled_entity, cfg.emergency_entity, cfg.light_entity,
      cfg.debug_state_entity, cfg.debug_banner_entity].filter(Boolean);
    const mapLoaded = !!(cfg.map_data || (MAP_CACHE.url === cfg.map_url && MAP_CACHE.data));
    return JSON.stringify([
      main ? main.state : null,
      main ? main.attributes : null,
      watched.map((id) => this._state(id)),
      now.getDay(), now.getHours(), now.getMinutes(),
      cfg.debug_state, cfg.debug_banner, cfg.week_style,
      this._hist && [this._hist.at, this._hist.note],
      this._light && this._light.at,
      this._lcMode,
      this._lcRange,
      this._lcView && [this._lcView.start, this._lcView.end],
      this._selectedQueue,
      this._mapLodMode,
      this._mapColorMode,
      mapLoaded,
    ]);
  }

  // --- hours of light ------------------------------------------------------

  /** The light sensor's state object, or null when it is not configured or not there. */
  _lightObj() {
    return this._config.light_entity ? this._stateObj(this._config.light_entity) : null;
  }

  /** Hours of light so far today, or null when the meter has no answer. */
  _lightToday() {
    const st = this._lightObj();
    const h = st ? parseFloat(st.state) : NaN;
    return isNaN(h) ? null : h;
  }

  /**
   * Whether to ask for the light statistics: once a day, when the current hour
   * rolls over (so Today's completed hours update), and after a failure once
   * HISTORY_TTL has gone by. Never while hidden or asking.
   */
  _wantLight(now) {
    const blocks = this._config.blocks;
    if (blocks.indexOf("week") < 0 && blocks.indexOf("days") < 0) return false;
    if (!this._lightObj()) return false;
    if (this._paused || this._lightBusy || !this._hass || typeof this._hass.callWS !== "function") return false;
    const l = this._light;
    return !l || l.day !== now.toDateString() || l.hour !== now.getHours()
      || (l.failed && now.getTime() - l.at > HISTORY_TTL);
  }

  /**
   * One hourly statistics request for all recorded history (`min`, `max`,
   * `mean`): daily totals skip hour 00 to avoid history_stats's midnight
   * carry-over, while min/max/mean reconstruct 00–24 light intervals.
   */
  async _loadLight(now) {
    this._lightBusy = true;
    const id = this._config.light_entity;
    let days = {};
    let spans = {};
    let hourFracs = {};
    let firstDay = null;
    let failed = false;
    try {
      const reply = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: "2020-01-01T00:00:00Z",
        statistic_ids: [id],
        period: "hour",
        types: ["min", "max", "mean"],
      });
      const parsed = dailyLightFromHours((reply || {})[id]);
      days = parsed.days;
      spans = parsed.spans;
      hourFracs = parsed.hourFracs;
      firstDay = parsed.firstDay;
    } catch (err) {
      failed = true;
    }
    this._light = {
      day: now.toDateString(), hour: now.getHours(), at: Date.now(),
      days, spans, hourFracs, firstDay, failed,
    };
    this._lightBusy = false;
    this._render();
  }

  /** Today's light intervals: completed-hour statistics plus live sensor tail. */
  _todayLightSpans(now) {
    const liveH = this._lightToday();
    if (liveH === null || liveH < 0.01) return [];
    const curH = now.getHours();
    const nowH = Math.max(0, Math.min(24, curH + now.getMinutes() / 60));
    const key = dayKey(now);
    const statSpans = (this._light && this._light.spans && this._light.spans[key]) || [];
    const done = [];
    let doneSum = 0;
    statSpans.forEach(([s, e]) => {
      if (s >= curH) return;
      const a = Math.max(0, s);
      const b = Math.min(curH, e);
      if (b - a > 0.01) {
        done.push([a, b]);
        doneSum += b - a;
      }
    });
    const extra = Math.max(0, liveH - doneSum);
    if (extra > 0.01 && nowH > 0.01) {
      const last = done[done.length - 1];
      const touchesCurH = last && Math.abs(last[1] - curH) <= 0.05;
      const gridDown = this._state(this._config.grid_entity) === "on";
      if (extra <= nowH - curH + 0.01 && touchesCurH && gridDown) {
        done.push([curH, Math.min(nowH, curH + extra)]);
      } else {
        done.push([Math.max(0, nowH - extra), nowH]);
      }
    }
    const merged = [];
    done.forEach(([s, e]) => {
      if (merged.length && s - merged[merged.length - 1][1] <= 0.05) {
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
      } else {
        merged.push([s, e]);
      }
    });
    return merged;
  }

  _todayHourFracs(spans, nowH) {
    const fracs = new Array(24).fill(null);
    for (let h = 0; h < 24; h++) {
      if (h > Math.floor(nowH)) break;
      const avail = Math.min(1, nowH - h);
      if (avail <= 0.01) continue;
      let ov = 0;
      spans.forEach(([s, e]) => {
        ov += Math.max(0, Math.min(e, h + 1) - Math.max(s, h));
      });
      fracs[h] = Math.max(0, Math.min(1, ov / avail));
    }
    return fracs;
  }

  /** Hours of light on a date: live for today, the statistics before it, null after. */
  _lightOn(date, now) {
    if (!this._lightObj()) return null;
    const key = dayKey(date);
    if (key === dayKey(now)) return this._lightToday();
    if (dayNum(date) > dayNum(now)) return null;
    const v = this._light && this._light.days[key];
    return typeof v === "number" ? v : null;
  }

  _lightSpansOn(date, now) {
    if (!this._lightObj()) return null;
    const key = dayKey(date);
    if (key === dayKey(now)) return this._todayLightSpans(now);
    if (dayNum(date) > dayNum(now)) return null;
    const s = this._light && this._light.spans && this._light.spans[key];
    return Array.isArray(s) ? s : null;
  }

  _lightHourFracsOn(date, now) {
    if (!this._lightObj()) return null;
    const key = dayKey(date);
    if (key === dayKey(now)) {
      const nowH = now.getHours() + now.getMinutes() / 60;
      return this._todayHourFracs(this._todayLightSpans(now), nowH);
    }
    if (dayNum(date) > dayNum(now)) return null;
    const f = this._light && this._light.hourFracs && this._light.hourFracs[key];
    return Array.isArray(f) ? f : null;
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
        // A bundle without the inverter configures grid_entity: null, and a
        // null id fails the whole request. Its row stays, empty.
        entity_ids: ids.filter(Boolean),
        minimal_response: true,
        no_attributes: true,
        significant_changes_only: false,
      });
      spans = ids.map((id) => (id ? onSpans((reply || {})[id], midnight.getTime(), now.getTime()) : []));
    } catch (err) {
      note = "History is unavailable" + (err && err.message ? " (" + err.message + ")" : "")
        + ", so only the schedule is drawn.";
    }
    this._hist = { day: now.toDateString(), key, at: Date.now(), spans, note };
    this._histBusy = false;
    this._render();
  }

  _ensureShell() {
    if (this._shell) return this._shell;
    this.shadowRoot.innerHTML = "<style>" + STYLE + "</style>"
      + '<div class="wrap"></div>'
      + '<div class="lc-modal-backdrop" hidden></div>'
      + '<div class="map-hcard" hidden></div>';
    this._shell = {
      wrap: this.shadowRoot.querySelector(".wrap"),
      modal: this.shadowRoot.querySelector(".lc-modal-backdrop"),
      mapTip: this.shadowRoot.querySelector(".map-hcard"),
      slotKey: null,
      slots: {},
    };
    this._wireLcModal();
    return this._shell;
  }

  _render() {
    if (!this._hass || !this._config) return;
    if (this._lcDragging || this._lcModalDn !== null) {
      this._lcDeferredRender = true;
      return;
    }
    const now = new Date();
    if (this._wantHistory(now)) this._loadHistory(now);
    if (this._wantLight(now)) this._loadLight(now);
    const print = this._fingerprintOf(now);
    if (print === this._fingerprint) return;
    this._fingerprint = print;

    const shell = this._ensureShell();
    const wrap = shell.wrap;
    const cfg = this._config;
    const main = this._stateObj(cfg.entity);
    if (!main) {
      wrap.className = "wrap k-warn";
      wrap.style.removeProperty("--accent");
      if (shell.slotKey !== "!main") {
        wrap.innerHTML = '<ha-card><div class="pad"><h2>DTEK Shutdowns</h2>'
          + '<p class="note err">' + esc(cfg.entity) + " does not exist. Is "
          + "packages/dtek_shutdowns.yaml loaded?</p></div></ha-card>";
        shell.slotKey = "!main";
        shell.slots = {};
        this._lcDom = null;
        this._lcData = null;
      }
      return;
    }

    const d = this._derive(now, main.attributes || {});
    wrap.className = "wrap k-" + d.kind;
    wrap.style.setProperty("--accent", d.accent);

    const keys = [];
    cfg.blocks.forEach((b) => {
      keys.push(b);
      if (b === "week") keys.push("light");
    });
    const sk = keys.join(",");
    if (shell.slotKey !== sk) {
      wrap.innerHTML = keys.map((k) => '<div class="ds-slot" data-slot="' + k + '"></div>').join("");
      shell.slotKey = sk;
      shell.slots = {};
      wrap.querySelectorAll(".ds-slot").forEach((el) => {
        shell.slots[el.getAttribute("data-slot")] = el;
      });
      this._lcDom = null;
      this._lcData = null;
    }

    const draw = {
      hero: () => this._hero(d, now),
      timeline: () => this._timelineCard(d, now),
      days: () => this._daysCard(d),
      week: () => this._weekCard(d, now),
      source: () => this._sourceCard(d),
    };
    const unlockH = (el) => { el.style.minHeight = ""; };

    keys.forEach((k) => {
      const slot = shell.slots[k];
      if (!slot) return;
      if (k === "light") {
        if (!this._lightObj()) {
          slot.hidden = true;
          if (slot._mounted) {
            slot.innerHTML = "";
            slot._mounted = false;
            this._lcDom = null;
            this._lcData = null;
          }
        } else {
          slot.hidden = false;
          if (!slot._mounted) {
            slot.innerHTML = this._lightCard(now);
            slot._mounted = true;
            this._wireLightChart();
          } else {
            this._patchLightChart(now);
          }
        }
        return;
      }
      const html = draw[k]();
      if (slot._html === html) return;
      // Hold height briefly across slot replacement so scroll position never jumps.
      const prevH = slot.offsetHeight;
      if (prevH) slot.style.minHeight = prevH + "px";
      const previous = slot.querySelector(".grid, .bulbs");
      const scrollLeft = previous ? previous.scrollLeft : 0;
      slot.innerHTML = html;
      slot._html = html;
      if (k === "hero") this._wireMap(d, now);
      const grid = slot.querySelector(".grid, .bulbs");
      if (grid && scrollLeft) grid.scrollLeft = scrollLeft;
      if (prevH) {
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => unlockH(slot));
        else unlockH(slot);
      }
    });
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
    // An entity's value wins over the static option; "live" (or anything that
    // is not a known value) means the real data.
    const pick = (id, fixed, known) => {
      const v = id ? this._state(id) : null;
      return known.indexOf(v) >= 0 ? v : id ? null : fixed;
    };
    const dbg = pick(cfg.debug_state_entity, cfg.debug_state, DEBUG_STATES);
    const dbgBanner = pick(cfg.debug_banner_entity, cfg.debug_banner, DEBUG_BANNERS);

    const homeCode = this._homeQueueCode();
    const allQueuesRaw = a.all_queues && typeof a.all_queues === "object"
      && !Array.isArray(a.all_queues) ? a.all_queues : null;
    const queueCodes = allQueuesRaw ? sortQueueCodes(Object.keys(allQueuesRaw)) : [];
    const hasMap = queueCodes.length > 0;
    const mapData = hasMap ? this._ensureMapData() : null;
    const homeRef = hasMap ? (resolveQueueRef(allQueuesRaw, homeCode) || homeCode) : homeCode;
    const selRef = hasMap && this._selectedQueue
      ? (resolveQueueRef(allQueuesRaw, this._selectedQueue) || this._selectedQueue) : null;
    const inspecting = !!(hasMap && selRef && allQueuesRaw[selRef] && selRef !== homeRef);
    const activeQueueInfo = inspecting ? allQueuesRaw[selRef] : null;

    let gridDown = inspecting ? false : this._state(cfg.grid_entity) === "on"; // on = no mains
    let unscheduled = inspecting ? false : this._state(cfg.unscheduled_entity) === "on";
    let dtekOutage = inspecting ? false : a.outage_active === true;
    let stale = this._state(cfg.stale_entity) === "on" || a.stale === true;
    let reason = inspecting ? null : a.outage_reason;
    let outageStart = inspecting ? null : a.outage_start;
    let outageEnd = inspecting ? null : a.outage_end;

    // Render-only overrides, so the outage and stale layouts can be compared
    // against the mockups without setting a state in Developer Tools -- which
    // would fire the grid outage alert and push to both phones.
    if (!inspecting && dbg === "on") {
      gridDown = unscheduled = dtekOutage = stale = false;
    } else if (!inspecting && dbg === "outage") {
      gridDown = true; dtekOutage = true; unscheduled = false; stale = false;
      reason = reason || "Scheduled outage";
      outageStart = outageStart || new Date(now.getTime() - 36e5).toISOString();
      outageEnd = outageEnd || new Date(now.getTime() + 108e5).toISOString();
    } else if (!inspecting && dbg === "dtek") {
      gridDown = false; dtekOutage = true; unscheduled = false; stale = false;
      reason = reason || "Аварійні ремонтні роботи";
      outageStart = outageStart || new Date(now.getTime() - 36e5).toISOString();
      outageEnd = outageEnd || new Date(now.getTime() + 108e5).toISOString();
    } else if (!inspecting && dbg === "unscheduled") {
      gridDown = true; unscheduled = true; dtekOutage = false; stale = false;
    } else if (dbg === "stale") {
      stale = true;
    }

    // The announcement popup. Its text is shown whatever it says -- DTEK
    // writes it by hand -- but it turns the page red only through the
    // emergency entity, which has already refused another area's notice, a
    // single odd read and a banner nobody has fetched for 20 minutes.
    let banner = inspecting ? null
      : (a.banner_text ? { title: a.banner_title, text: a.banner_text, scope: a.banner_scope } : null);
    let emergencyOn = inspecting
      ? activeQueueInfo.y === "EmergencyShutdowns"
      : this._state(cfg.emergency_entity) === "on";
    if (!inspecting && dbgBanner === "none") {
      banner = null; emergencyOn = false;
    } else if (!inspecting && dbgBanner === "yasno") {
      banner = null; emergencyOn = true;
    } else if (!inspecting && dbgBanner) {
      banner = SAMPLE_BANNER[dbgBanner === "pending" ? "emergency" : dbgBanner];
      emergencyOn = dbgBanner === "emergency";
    }
    // A banner older than the emergency entity's own 20-minute limit is not
    // shown as today's: DTEK may have replaced it since. On 03.11.2026 the
    // site started refusing the poller's page GET (HTTP 403) at 06:55 and the
    // morning "екстрені" text stayed up under a popup that by then said
    // "стабілізаційні". The entity being on no longer vouches for the banner:
    // YASNO's queue status can turn it on while the popup stays unreadable.
    const checkedAt = a.banner_checked_at ? new Date(a.banner_checked_at) : null;
    const bannerOld = !inspecting && !dbgBanner && (a.banner_text || a.banner_error)
      && (!checkedAt || isNaN(checkedAt) || now - checkedAt > BANNER_MAX_AGE_MIN * 60000);
    // Hidden outright, at the user's request: the live schedule line already
    // says which regime DTEK applies to this address.
    if (bannerOld) banner = null;
    if (banner) {
      banner = Object.assign({}, banner, {
        emergency: emergencyOn,
        help: "banner",
        lines: String(banner.text).split("\n").filter((l) => l.trim()),
        checked: dbgBanner ? "preview" : fmtClock(a.banner_checked_at) || "unknown",
        label: emergencyOn ? "Ukrenergo emergency outages"
          : banner.scope === "other" ? "DTEK announcement · not for this area"
          : "DTEK announcement",
      });
    } else if (emergencyOn) {
      // On from YASNO alone: no DTEK words to quote, so say whose status it is.
      banner = {
        emergency: true, help: "yasno", title: null,
        lines: ["YASNO marks queue " + (inspecting ? selRef : (a.queue || "?"))
          + " as under emergency outages: no schedule applies, no end time."],
        checked: dbgBanner ? "preview" : fmtClock(a.yasno_checked_at) || "unknown",
        label: "Ukrenergo emergency outages · YASNO",
      };
    }

    // The badges that used to carry the queue chip are gone, so the identity
    // of this schedule has to live in the card. It is stated once, in the
    // eyebrow, and the sentences below refer to it by the bracketed code.
    const code = inspecting ? selRef : homeCode;
    const queue = code ? "(" + code + ")" : "this queue";
    const identity = inspecting
      ? (code ? "(" + code + ")" : null)
      : ([a.address, code ? "(" + code + ")" : null].filter(Boolean).join(" ") || null);
    const week = inspecting
      ? (Array.isArray(activeQueueInfo.w) && activeQueueInfo.w.length === 7 ? activeQueueInfo.w : null)
      : (Array.isArray(a.week) && a.week.length === 7 ? a.week : null);
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
    const rawToday = inspecting ? activeQueueInfo.t : a.today;
    const rawTmrw = inspecting ? activeQueueInfo.m : a.tomorrow;
    const inEffect = inspecting
      ? !!(typeof rawToday === "string" && rawToday.length === 24
           || typeof rawTmrw === "string" && rawTmrw.length === 24)
      : a.schedule_in_effect === true;
    const appliedRow = (row) => (inEffect && typeof row === "string" && row.length === 24 ? row : null);
    const appliedToday = appliedRow(rawToday);
    const appliedTmrw = appliedRow(rawTmrw);

    // Home queue's today schedule kept separately for timeline comparison.
    const homeWeek = Array.isArray(a.week) && a.week.length === 7 ? a.week : null;
    const homeAppliedToday = a.schedule_in_effect === true
      && typeof a.today === "string" && a.today.length === 24 ? a.today : null;
    const homeTodayRow = homeAppliedToday ? { row: homeAppliedToday, source: "applied schedule" }
      : homeWeek && a.week_in_effect !== false && homeWeek[todayIdx]
        ? { row: homeWeek[todayIdx], source: "weekly table" }
        : null;

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
          lit: inspecting ? null : this._lightOn(date, now),
        });
      }
    }

    // --- the applied schedule: today and tomorrow, and whether now is dark
    const schedNow = inEffect && (inspecting || dbg !== "on")
      ? scheduleWindow(rawToday, rawTmrw, now) : null;
    const schedEnd = schedNow
      ? fmtClock(schedNow.end.toISOString())
      : null;
    const schedSpan = schedNow
      ? fmtClock(schedNow.start.toISOString()) + DASH + schedEnd : null;
    const schedLeft = schedNow
      ? fmtIn(Math.round((schedNow.end.getTime() - now.getTime()) / 60000)) : null;
    // Today and tomorrow on their own: the "days" block, and the week block's
    // view when DTEK applies a schedule but draws no recurring table.
    const applied = [];
    if (inEffect && (cfg.blocks.indexOf("days") >= 0 || (wantCells && !weekLive))) {
      [rawToday, rawTmrw].forEach((row, di) => {
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
          lit: inspecting ? null : this._lightOn(date, now),
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
    const appliedStart = inspecting ? null : parseDate(a.next_outage_start);
    const inspectedNext = inspecting && !schedNow ? queueNextWindow(appliedToday, appliedTmrw, now) : null;
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
    } else if (inspectedNext) {
      const at = pad2(inspectedNext.start.getHours()) + ":" + pad2(inspectedNext.start.getMinutes());
      const when = this._whenPhrase(now, inspectedNext.start);
      win = {
        label: at + DASH + pad2(inspectedNext.end.getHours()) + ":" + pad2(inspectedNext.end.getMinutes()),
        at, when: when.long, whenShort: when.short, certain: inspectedNext.certain, start: inspectedNext.start,
      };
    } else if (weekLive) {
      const nowAbs = todayIdx * 24 + now.getHours();
      const w = scanWindow(week, nowAbs + 1);
      if (w) {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
                               now.getHours() + (w.start - nowAbs),
                               w.startHalf ? 30 : 0);
        const when = this._whenPhrase(now, start);
        // A run past midnight reads plainly, 19:30-02:30: no "+1" marker.
        win = {
          label: clock(w.start, w.startHalf) + DASH
            + (w.endHalf ? clock(w.end, true) : clock(w.end + 1, false)),
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
      if (unscheduled && emergencyOn) {
        // Unscheduled, but announced: the popup is the announcement.
        lede = "The inverter sees no mains, and Ukrenergo has emergency outages "
          + "on here: they follow no schedule and DTEK gives no end time.";
      } else if (unscheduled) {
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
        + (inspecting ? " (schedule view only, no local meter)." : ". The inverter still sees mains.");
    } else if (emergencyOn) {
      // Mains is up, but it can go at any minute and no table will say when.
      headline = inspecting ? "Emergency outages." : "The power is on.";
      lede = inspecting
        ? "YASNO reports emergency outages for " + queue
          + ": the power can go at any time and no schedule applies."
        : "Ukrenergo has emergency outages on here: the power can go at any "
          + "time, and no schedule applies until they are lifted.";
    } else {
      headline = inspecting ? "Scheduled on." : "The power is on.";
      lede = win
        ? (inspecting ? "No scheduled outage right now for " : "No outage is running for ") + queue
          + ". The next " + (win.certain ? "scheduled" : "possible") + " window starts at "
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
    let reasonText = inspecting ? "Schedule view only" : "Not reported";
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
        + "recurring table for this " + (inspecting ? "queue" : "address")
        + ", so nothing below forecasts anything.";
    } else if (!inEffect) {
      note = "Stabilisation schedules are not in force " + MDASH + " DTEK last "
        + "published one on " + published + " " + MDASH + " so nothing is "
        + "applied on top of the recurring pattern below.";
    } else {
      const t = typeof rawToday === "string" ? offHours(rawToday) : null;
      const m = typeof rawTmrw === "string" ? offHours(rawTmrw) : null;
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
    const kind = gridDown ? "bad" : dtekOutage || schedNow || emergencyOn || soon ? "warn" : "ok";
    const pill = gridDown ? (unscheduled && !emergencyOn ? "Off · not announced" : "Power off")
      : dtekOutage ? "DTEK notice"
      : schedNow ? (schedNow.certain ? "Scheduled outage" : "Possible outage")
      : emergencyOn ? "Emergency outages"
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
      center = { big: "ON", small: emergencyOn ? "emergency outages"
        : todayRow ? "nothing ahead" : "no schedule" };
    }

    return {
      kind, pill, todayRow, center, nowH, emergency, weekStyle: cfg.week_style,
      // Orange when only DTEK says it is off: a claim, not a measurement.
      accent: gridDown ? RED : dtekOutage || schedNow || emergencyOn ? ORANGE : GREEN,
      // The accent in words, for the eyebrow's tooltip.
      nowWord: gridDown ? "power off"
        : dtekOutage ? "DTEK outage notice, mains present"
        : schedNow ? "scheduled outage, mains present"
        : emergencyOn ? "emergency outages announced, mains present" : "power on",
      banner, emergencyOn,
      identity,
      headline, lede, note, code, queue, week, days, win, applied, inEffect,
      weekLive, hiddenReason,
      inspecting, homeCode, homeRef, homeTodayRow,
      allQueues: allQueuesRaw, queueCodes, mapData,
      selectedQueue: hasMap ? (inspecting ? selRef : (homeRef || code)) : null,
      mapLodMode: this._mapLodMode, mapColorMode: this._mapColorMode,
      // Hours of light today at the meter: a number, null when the meter has
      // no answer, undefined when no light sensor is configured or present.
      lightToday: this._lightObj() ? (inspecting ? null : this._lightToday()) : undefined,
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

  _hero(d, now) {
    // One tooltip per tile; the label, value and sub-line inherit it.
    const tile = (k, v, s, key, color) =>
      '<div class="tile"' + tip(k, v === null ? s : v + " " + MIDDOT + " " + s, key)
      + '><span class="k">' + esc(k) + "</span>"
      + '<span class="v' + (v === null ? " dim" : "") + '"'
      + (color ? ' style="color:' + color + '"' : "") + ">"
      + esc(v === null ? MDASH : v) + "</span>"
      + '<span class="s">' + esc(s) + "</span></div>";

    const hasMap = !!(d.allQueues && d.queueCodes && d.queueCodes.length);
    const statusByQ = {};
    if (hasMap) {
      d.queueCodes.forEach((q) => {
        statusByQ[q] = queueStatusNow(q, d.allQueues, now);
      });
    }
    const qStrip = hasMap
      ? '<div class="q-strip">'
        + d.queueCodes.map((q) => {
          const st = statusByQ[q] || "none";
          const isHome = q === d.homeRef || q === d.homeCode;
          const active = q === d.selectedQueue;
          const stWord = st === "off" ? "scheduled off"
            : st === "emerg" ? "emergency outages"
            : st === "soon" ? "off within an hour"
            : st === "on" ? "scheduled on" : "no data";
          return '<button type="button" class="q-pill st-' + st + (active ? " active" : "")
            + (isHome ? " home" : "") + '" data-act="map-q" data-val="' + esc(q)
            + '" aria-pressed="' + (active ? "true" : "false") + '"'
            + tip("Queue " + q, stWord + (isHome ? " · my home" : ""), "map_q") + ">"
            + '<span class="q-dot"></span><span>' + esc(q) + "</span>"
            + (isHome ? '<span class="q-star" aria-hidden="true">★</span>' : "")
            + "</button>";
        }).join("")
        + "</div>"
      : "";

    const backBtn = d.inspecting && d.homeCode
      ? '<button type="button" class="map-back" data-act="map-home"'
        + tip("My queue", "return to " + d.homeCode, "map_home") + ">← My queue ("
        + esc(d.homeCode) + ")</button>"
      : "";

    return '<ha-card class="hero' + (hasMap ? " has-map" : "") + '"><div class="pad">'
      + '<div class="hero-left">'
      // The eyebrow's tooltip covers the pill; the address chip means something
      // else and carries its own.
      + '<div class="eyebrow"' + tip("Right now", d.nowWord, "now") + '>'
      + '<span class="pill"><span class="dot"></span><span class="lbl">' + esc(d.pill)
      + "</span></span>"
      + (d.identity ? '<span class="ident"' + tip("Address and queue", d.identity, "ident")
        + ">" + esc(d.identity) + "</span>" : "")
      + (d.inspecting ? '<span class="ident insp"'
        + tip("Schedule view", "no local inverter or meter", "map_home") + ">Schedule only</span>" : "")
      + backBtn
      + "</div>"
      + this._banner(d.banner)
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
      + (hasMap ? this._mapPanel(d, statusByQ) : "")
      + this._clock(d)
      + qStrip
      + '<div class="tiles' + (d.lightToday === undefined ? "" : " four") + '">'
      // Measured, not planned: the meter is lit whenever mains is there.
      + (d.lightToday === undefined ? ""
        : tile("Light today", d.lightToday === null ? null : fmtHM(d.lightToday),
               d.lightToday === null
                 ? (d.inspecting ? "home meter only" : "the meter has no answer")
                 : "since 00:00, at the meter",
               "light", d.lightToday === null ? null : "var(--ds-ok-hi)"))
      // Both of these are read off the recurring pattern. When DTEK withdraws
      // it they have no answer, and a dash is the honest one -- "0h off" would
      // be a claim about a week nobody has scheduled.
      + tile("Next window", d.win ? d.win.label : d.weekLive ? "none" : null,
             d.emergencyOn ? "schedules don't apply now"
               : d.win ? d.win.when
               : d.weekLive ? "nothing in the table" : "no schedule published", "next")
      + tile("Off this week", d.weekOff,
             d.weekShare ? d.weekShare + " of the week" : "not published", "week_off")
      + tile("Feed", d.feedLabel, "Last poll " + d.lastPoll, "feed", d.feedColor)
      + "</div></div></ha-card>";
  }

  _mapPanel(d, statusByQ) {
    const mode = d.mapColorMode === "all" ? "all" : "selected";
    const lodMode = d.mapLodMode || "auto";
    const camScale = this._mapCam ? this._mapCam.s : 1;
    const activeCam = camScale >= 2.0 ? "dnipro" : "region";

    const camBtn = (val, label, hintVal) => '<button type="button" class="map-btn'
      + (activeCam === val ? " active" : "") + '" data-act="map-cam" data-val="' + val
      + '" aria-pressed="' + (activeCam === val ? "true" : "false") + '"'
      + tip("Map view", activeCam === val ? label + " active" : hintVal, "map_view")
      + ">" + label + "</button>";
    const lodBtn = (val, label) => '<button type="button" class="map-btn'
      + (lodMode === val ? " active" : "") + '" data-act="map-lod" data-val="' + val
      + '" aria-pressed="' + (lodMode === val ? "true" : "false") + '"'
      + tip("Map detail", lodMode === val ? label + " active" : "switch layer to " + label, "map_lod")
      + ">" + label + "</button>";
    const modeBtn = (val, label) => '<button type="button" class="map-btn'
      + (mode === val ? " active" : "") + '" data-act="map-mode" data-val="' + val
      + '" aria-pressed="' + (mode === val ? "true" : "false") + '"'
      + tip("Map mode", mode === val ? label + " active" : "switch to " + label, "map_mode")
      + ">" + label + "</button>";

    const head = '<div class="map-head">'
      + '<div class="map-seg">'
      + camBtn("region", "Region", "fly to Region (1x)")
      + camBtn("dnipro", "Dnipro", "fly to Dnipro city") + "</div>"
      + '<div class="map-seg">'
      + lodBtn("auto", "Auto") + lodBtn("hromadas", "Hromadas")
      + lodBtn("districts", "Districts") + lodBtn("quarters", "Microzones") + "</div>"
      + '<div class="map-seg">'
      + modeBtn("selected", "Queue " + (d.selectedQueue || ""))
      + modeBtn("all", "All live") + "</div>"
      + "</div>";

    const md = d.mapData;
    if (!md || !Array.isArray(md.vb) || !Array.isArray(md.hromadas)) {
      return '<div class="map-slot">' + head
        + '<div class="map-empty">Loading region map…</div></div>';
    }

    const selStatus = statusByQ[d.selectedQueue] || "none";
    const selClr = mapStatusColor(selStatus);
    const renderRegions = (list, defSw, kindKey) => (list || []).map((reg, idx) => {
      const shares = reg.s && typeof reg.s === "object" ? reg.s : {};
      const qs = Object.keys(shares).sort((a, b) => (shares[b] || 0) - (shares[a] || 0));
      const topQ = qs[0] || "";
      const topRef = topQ ? (resolveQueueRef(d.allQueues, topQ) || topQ) : "";
      let selShare = 0;
      let offShare = 0;
      let soonShare = 0;
      let emergShare = 0;
      qs.forEach((q) => {
        const ref = resolveQueueRef(d.allQueues, q) || q;
        const pct = Number(shares[q]) || 0;
        const st = statusByQ[ref] || "none";
        if (ref === d.selectedQueue || q === d.selectedQueue) selShare += pct;
        if (st === "off") offShare += pct;
        else if (st === "emerg") emergShare += pct;
        else if (st === "soon") soonShare += pct;
      });

      let fill = "#151820";
      let fillOp = 0.92;
      let stroke = "#23262e";
      let sw = defSw;
      if (!qs.length) {
        fill = "#13161c";
        fillOp = 0.7;
      } else if (mode === "selected") {
        if (selShare > 0) {
          fill = selClr.fill;
          fillOp = Number((0.34 + 0.64 * Math.min(100, selShare) / 100).toFixed(2));
          if (selShare >= 35) { stroke = selClr.hi; sw = Math.max(defSw, 1.2); }
          else stroke = "#39404d";
        }
      } else {
        const darkShare = offShare + emergShare;
        if (emergShare >= 35) {
          fill = mapStatusColor("emerg").fill;
          fillOp = Number((0.45 + 0.55 * Math.min(100, emergShare) / 100).toFixed(2));
        } else if (darkShare >= 35) {
          fill = mapStatusColor("off").fill;
          fillOp = Number((0.35 + 0.65 * Math.min(100, darkShare) / 100).toFixed(2));
        } else if (darkShare + soonShare >= 25) {
          fill = mapStatusColor("soon").fill;
          fillOp = Number((0.35 + 0.60 * Math.min(100, darkShare + soonShare) / 100).toFixed(2));
        } else {
          fill = mapStatusColor("on").fill;
          fillOp = 0.65;
        }
        if (selShare >= 30) { stroke = "#e8eaed"; sw = 1.3; }
      }

      const cls = topRef ? "map-poly clickable" + (selShare > 0 ? " sel" : "") : "map-poly empty";
      const attrs = ' class="' + cls + '" data-reg-kind="' + kindKey + '" data-reg-idx="' + idx + '"'
        + (topRef ? ' data-reg-q="' + esc(topRef) + '"' : "");

      return '<path d="' + esc(reg.path) + '" fill="' + fill + '" fill-opacity="'
        + fillOp + '" stroke="' + stroke + '" stroke-width="' + sw + '"' + attrs + "/>";
    }).join("");

    const raionPaths = (md.raions || []).map((p) => '<path class="map-raion" d="' + esc(p) + '"/>').join("");
    const obRiverPaths = (md.ob_rivers || []).map((p) => '<path class="map-river" d="' + esc(p) + '"/>').join("");
    const dnRiverPaths = (md.dn_rivers || []).map((p) => '<path class="map-river wide" d="' + esc(p) + '"/>').join("");
    const distOutPaths = (md.districts || []).map((r) => '<path class="map-dout" d="' + esc(r.path) + '"/>').join("");

    const hrPins = (md.cities || []).map((c) => '<g class="map-pin" data-x="' + c.x + '" data-y="' + c.y
      + '" data-tier="' + (c.tier || 1) + '" transform="translate(' + c.x + "," + c.y + ')">'
      + '<circle class="map-dot' + (c.tier === 1 ? " t1" : "") + '" cx="0" cy="0" r="'
      + (c.tier === 1 ? 2.6 : 1.9) + '"/>'
      + '<text class="map-pin-txt' + (c.tier === 1 ? " t1" : "") + '" x="4" y="-3">'
      + esc(c.name) + "</text></g>").join("");

    const distPins = (md.districts || []).map((r) => '<g class="map-pin" data-x="' + r.cx + '" data-y="' + r.cy
      + '" transform="translate(' + r.cx + "," + r.cy + ')">'
      + '<text class="map-dist-lbl" x="0" y="3" text-anchor="middle">' + esc(r.short || r.name) + "</text></g>").join("");

    const qtrPins = (md.quarters || []).map((q) => '<g class="map-pin" data-x="' + q.cx + '" data-y="' + q.cy
      + '" transform="translate(' + q.cx + "," + q.cy + ')">'
      + '<text class="map-q-lbl" x="0" y="2" text-anchor="middle">' + esc(q.name) + "</text></g>").join("");

    const svg = '<svg class="map-svg" viewBox="0 0 ' + md.vb[0] + " " + md.vb[1]
      + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Dnipropetrovsk outage map">'
      + '<defs><pattern id="ds-map-emerg" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
      + '<rect width="5" height="5" fill="#bb635b"/><rect width="2" height="5" fill="#ff928a"/></pattern></defs>'
      + '<g class="map-cam">'
      + '<g class="map-l-hr">' + renderRegions(md.hromadas, 0.65, "hromadas") + "</g>"
      + '<g class="map-l-raion">' + raionPaths + "</g>"
      + '<g class="map-l-obriv">' + obRiverPaths + "</g>"
      + '<g class="map-l-dist">' + renderRegions(md.districts, 0.9, "districts") + "</g>"
      + '<g class="map-l-qtr">' + renderRegions(md.quarters, 0.75, "quarters") + "</g>"
      + '<g class="map-l-dnriv">' + dnRiverPaths + "</g>"
      + '<g class="map-l-dout">' + distOutPaths + "</g>"
      + '<g class="map-l-lbl-hr">' + hrPins + "</g>"
      + '<g class="map-l-lbl-dist">' + distPins + "</g>"
      + '<g class="map-l-lbl-qtr">' + qtrPins + "</g>"
      + "</g></svg>";

    const zoomBtn = (val, label, desc) => '<button type="button" data-act="map-zoom" data-val="' + val + '"'
      + tip("Map zoom", desc, "map_zoom") + ">" + label + "</button>";
    const hud = '<div class="map-hud">'
      + '<span class="map-hud-badge map-lod-badge">86 hromadas</span>'
      + '<span class="map-hud-badge map-zoom-badge">1.0×</span>'
      + '<div class="map-zpad">'
      + zoomBtn("out", "−", "zoom out")
      + zoomBtn("in", "+", "zoom in")
      + zoomBtn("reset", "1×", "reset to 1x")
      + "</div></div>";

    const sw = (cls, text) => '<span><span class="map-sw ' + cls + '"></span>' + esc(text) + "</span>";
    const foot = '<div class="map-foot">'
      + '<span class="map-hint">Wheel to zoom · Drag to pan</span>'
      + '<div class="map-leg">'
      + sw("on", "On") + sw("soon", "Soon") + sw("off", "Off") + sw("emerg", "Emerg")
      + "</div></div>";

    return '<div class="map-slot">' + head + '<div class="map-stage">' + svg + hud + "</div>" + foot + "</div>";
  }

  _clampMapCam(tx, ty, s) {
    const ns = Math.max(1, Math.min(14, s));
    if (ns <= 1.001) return { tx: 0, ty: 0, s: 1 };
    const minTx = 620 * (1 - ns);
    const minTy = 400 * (1 - ns);
    return {
      tx: Math.min(0, Math.max(minTx, tx)),
      ty: Math.min(0, Math.max(minTy, ty)),
      s: ns,
    };
  }

  _currentMapLod() {
    if (this._mapLodMode !== "auto") return this._mapLodMode;
    if (this._mapCam.s >= 4.6) return "quarters";
    if (this._mapCam.s >= 2.2) return "districts";
    return "hromadas";
  }

  _mapSvgPoint(svg, clientX, clientY) {
    if (svg && typeof svg.getScreenCTM === "function" && typeof svg.createSVGPoint === "function") {
      const ctm = svg.getScreenCTM();
      if (ctm && typeof ctm.inverse === "function") {
        const p = svg.createSVGPoint();
        p.x = clientX;
        p.y = clientY;
        return p.matrixTransform(ctm.inverse());
      }
    }
    const r = svg && typeof svg.getBoundingClientRect === "function" ? svg.getBoundingClientRect() : null;
    if (r && r.width > 0 && r.height > 0) {
      return { x: ((clientX - r.left) * 620) / r.width, y: ((clientY - r.top) * 400) / r.height };
    }
    return { x: 310, y: 200 };
  }

  _applyMapCamera() {
    const slot = this._shell && this._shell.slots && this._shell.slots.hero;
    if (!slot) return;
    const camGroup = slot.querySelector(".map-cam");
    if (!camGroup) return;
    const cam = this._mapCam;
    camGroup.setAttribute("transform", "translate(" + cam.tx.toFixed(2) + "," + cam.ty.toFixed(2)
      + ") scale(" + cam.s.toFixed(4) + ")");

    const zoomBadge = slot.querySelector(".map-zoom-badge");
    if (zoomBadge) zoomBadge.textContent = cam.s.toFixed(1) + "×";

    const lod = this._currentMapLod();
    const showDist = lod === "districts" || lod === "quarters";
    const showQtr = lod === "quarters";

    const setSt = (sel, prop, val) => {
      const el = slot.querySelector(sel);
      if (el && el.style) el.style[prop] = val;
    };
    setSt(".map-l-hr", "opacity", lod === "hromadas" ? "1" : "0.28");
    setSt(".map-l-hr", "pointerEvents", lod === "hromadas" ? "auto" : "none");
    setSt(".map-l-dist", "display", showDist && !showQtr ? "block" : "none");
    setSt(".map-l-dist", "pointerEvents", lod === "districts" ? "auto" : "none");
    setSt(".map-l-qtr", "display", showQtr ? "block" : "none");
    setSt(".map-l-qtr", "pointerEvents", showQtr ? "auto" : "none");
    setSt(".map-l-dout", "display", showQtr ? "block" : "none");
    setSt(".map-l-dnriv", "display", showDist ? "block" : "none");
    setSt(".map-l-obriv", "display", showDist ? "none" : "block");
    setSt(".map-l-lbl-hr", "display", lod === "hromadas" ? "block" : "none");
    setSt(".map-l-lbl-dist", "display", lod === "districts" ? "block" : "none");
    setSt(".map-l-lbl-qtr", "display", lod === "quarters" ? "block" : "none");

    const inv = 1 / Math.pow(cam.s, 0.88);
    const activeLblSel = lod === "hromadas" ? ".map-l-lbl-hr .map-pin"
      : lod === "districts" ? ".map-l-lbl-dist .map-pin" : ".map-l-lbl-qtr .map-pin";
    slot.querySelectorAll(activeLblSel).forEach((pin) => {
      const tier = pin.getAttribute("data-tier");
      if (pin.style) pin.style.display = tier === "2" && cam.s < 1.45 ? "none" : "";
      const x = pin.getAttribute("data-x");
      const y = pin.getAttribute("data-y");
      pin.setAttribute("transform", "translate(" + x + "," + y + ") scale(" + inv.toFixed(3) + ")");
    });

    const meta = this._mapMeta || { hr: 86, dist: 8, qtr: 37 };
    const lodBadge = slot.querySelector(".map-lod-badge");
    if (lodBadge) {
      lodBadge.textContent = lod === "quarters" ? meta.qtr + " microzones"
        : lod === "districts" ? meta.dist + " Dnipro districts" : meta.hr + " hromadas";
    }

    slot.querySelectorAll('[data-act="map-cam"]').forEach((b) => {
      const val = b.getAttribute("data-val");
      const on = val === (cam.s >= 2.0 ? "dnipro" : "region");
      if (b.classList) b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    slot.querySelectorAll('[data-act="map-lod"]').forEach((b) => {
      const on = b.getAttribute("data-val") === this._mapLodMode;
      if (b.classList) b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  _flyMapTo(cx, cy, scale) {
    if (this._mapAnim && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this._mapAnim);
    this._mapAnim = null;
    const s1 = Math.max(1, Math.min(14, scale));
    const dest = this._clampMapCam(310 - cx * s1, 200 - cy * s1, s1);
    if (typeof requestAnimationFrame !== "function" || typeof performance === "undefined") {
      this._mapCam = dest;
      this._applyMapCamera();
      return;
    }
    const start = { tx: this._mapCam.tx, ty: this._mapCam.ty, s: this._mapCam.s };
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 300);
      const e = 1 - Math.pow(1 - p, 3);
      this._mapCam = {
        tx: start.tx + (dest.tx - start.tx) * e,
        ty: start.ty + (dest.ty - start.ty) * e,
        s: start.s + (dest.s - start.s) * e,
      };
      this._applyMapCamera();
      if (p < 1) this._mapAnim = requestAnimationFrame(step);
      else this._mapAnim = null;
    };
    this._mapAnim = requestAnimationFrame(step);
  }

  _hideMapHover() {
    const tipEl = this._shell && this._shell.mapTip;
    if (tipEl) {
      tipEl.hidden = true;
      if (typeof tipEl.setAttribute === "function") tipEl.setAttribute("hidden", "");
    }
    this._mapHoverKey = null;
  }

  _queueNextHint(q, st, allQueues, now) {
    if (st === "emerg") return "Emergency";
    const ref = resolveQueueRef(allQueues, q);
    const info = ref ? allQueues[ref] : null;
    const today = info && typeof info.t === "string" && info.t.length === 24 ? info.t : null;
    const tmrw = info && typeof info.m === "string" && info.m.length === 24 ? info.m : null;
    if (!today) return "No data";
    const fmtHr = (dt) => pad2(dt.getHours()) + ":" + pad2(dt.getMinutes());
    if (st === "off") {
      const win = now ? scheduleWindow(today, tmrw, now) : null;
      return win && win.end ? "Off until " + fmtHr(win.end) : "Off now";
    }
    const nxt = now ? queueNextWindow(today, tmrw, now) : null;
    if (st === "soon") {
      return nxt && nxt.start ? "Off at " + fmtHr(nxt.start) : "Off soon";
    }
    return nxt && nxt.start ? "On " + MIDDOT + " next " + fmtHr(nxt.start) : "On all day";
  }

  _mapRegionStats(item) {
    const ctx = this._mapHoverCtx || {};
    const allQueues = ctx.allQueues || null;
    const statusByQ = ctx.statusByQ || {};
    const now = ctx.now || new Date();
    const shares = item && item.s && typeof item.s === "object" ? item.s : {};
    const counts = item && item.c && typeof item.c === "object" ? item.c : {};
    const n = Number(item && item.n) || 0;

    const byRef = {};
    Object.keys(shares).forEach((q) => {
      const ref = resolveQueueRef(allQueues, q) || q;
      const pct = Number(shares[q]) || 0;
      const cnt = n > 0 ? (typeof counts[q] === "number" ? counts[q] : Math.round(pct * n / 100)) : 0;
      if (!byRef[ref]) byRef[ref] = { q: ref, pct: 0, cnt: 0 };
      byRef[ref].pct += pct;
      byRef[ref].cnt += cnt;
    });

    let offN = 0, soonN = 0, onN = 0, emergN = 0;
    let offP = 0, soonP = 0, onP = 0, emergP = 0;
    const rows = Object.values(byRef)
      .sort((a, b) => b.pct - a.pct)
      .map((entry) => {
        const st = statusByQ[entry.q] || "none";
        if (st === "off") { offN += entry.cnt; offP += entry.pct; }
        else if (st === "emerg") { emergN += entry.cnt; emergP += entry.pct; }
        else if (st === "soon") { soonN += entry.cnt; soonP += entry.pct; }
        else { onN += entry.cnt; onP += entry.pct; }
        return {
          q: entry.q,
          pct: Math.round(entry.pct),
          cnt: entry.cnt,
          st,
          next: this._queueNextHint(entry.q, st, allQueues, now),
          home: entry.q === ctx.homeRef || entry.q === ctx.homeCode,
        };
      });
    if (n > 0 && rows.length) {
      const sum = offN + emergN + soonN + onN;
      if (sum !== n) onN = Math.max(0, onN + (n - sum));
    }
    const domRef = item && item.d ? (resolveQueueRef(allQueues, item.d) || item.d) : null;
    const domSt = domRef ? (statusByQ[domRef] || "none") : "none";
    return { n, offN, soonN, onN, emergN, offP, soonP, onP, emergP, rows, domRef, domSt };
  }

  _renderMapHover(item, kind) {
    const ctx = this._mapHoverCtx || {};
    const st = this._mapRegionStats(item);
    const title = item.name || item.short || "Area";
    const sub = item.rayon ? item.rayon
      : item.district ? item.district + " район"
      : kind === "districts" ? "Dnipro district"
      : kind === "quarters" ? "Microzone" : "Hromada";
    const isHome = st.domRef && (st.domRef === ctx.homeRef || st.domRef === ctx.homeCode);
    const badge = st.domRef
      ? '<span class="mh-pill ' + st.domSt + '">Main: ' + esc(st.domRef) + (isHome ? " ★" : "") + "</span>"
      : "";
    const isEst = st.n <= 0;
    const fmt = (cnt, p) => (isEst ? "~" + Math.round(p) + "%" : String(cnt));
    const pctEl = (cnt, p) => (isEst ? ""
      : '<span class="mh-pct">(' + Math.round(st.n > 0 ? (cnt * 100) / st.n : p) + "%)</span>");
    const row = (cls, dot, label, val, pctHtml) => '<div class="mh-row ' + cls + '">'
      + '<span class="mh-k"><span class="mh-dot ' + dot + '"></span>' + esc(label) + "</span>"
      + '<span><span class="mh-v">' + esc(val) + "</span>" + (pctHtml || "") + "</span></div>";

    let rows = '<div class="mh-rows">';
    rows += isEst
      ? '<div class="mh-row total"><span class="mh-k">Coverage estimate</span><span class="mh-v">neighbors</span></div>'
      : '<div class="mh-row total"><span class="mh-k">Houses checked</span><span class="mh-v">' + st.n + "</span></div>";
    if (st.emergN > 0 || (isEst && st.emergP > 0)) {
      rows += row("c-off", "emerg", "Emergency off", fmt(st.emergN, st.emergP), pctEl(st.emergN, st.emergP));
    }
    rows += row("c-off", "off", "Houses off", fmt(st.offN, st.offP), pctEl(st.offN, st.offP));
    rows += row("c-soon", "soon", "Off soon (<1h)", fmt(st.soonN, st.soonP), pctEl(st.soonN, st.soonP));
    rows += row("c-on", "on", "Houses on", fmt(st.onN, st.onP), pctEl(st.onN, st.onP));
    rows += "</div>";

    const w = (cnt, p) => (isEst ? p : st.n > 0 ? (cnt * 100) / st.n : 0).toFixed(1);
    const bar = '<div class="mh-bar">'
      + '<div class="seg-emerg" style="width:' + w(st.emergN, st.emergP) + '%"></div>'
      + '<div class="seg-off" style="width:' + w(st.offN, st.offP) + '%"></div>'
      + '<div class="seg-soon" style="width:' + w(st.soonN, st.soonP) + '%"></div>'
      + '<div class="seg-on" style="width:' + w(st.onN, st.onP) + '%"></div>'
      + "</div>";

    let qlist = "";
    if (st.rows.length) {
      qlist = '<div class="mh-qlist"><div class="mh-qhdr">Queues in this area</div>';
      st.rows.slice(0, 5).forEach((r) => {
        const meta = isEst
          ? r.pct + "% " + MIDDOT + " " + r.next
          : r.cnt + " (" + r.pct + "%) " + MIDDOT + " " + r.next;
        qlist += '<div class="mh-qrow">'
          + '<span class="mh-qname"><span class="mh-dot ' + r.st + '"></span>' + esc(r.q) + (r.home ? " ★" : "") + "</span>"
          + '<div class="mh-qtrack"><div class="mh-qfill ' + r.st + '" style="width:' + Math.min(100, Math.max(0, r.pct)) + '%"></div></div>'
          + '<span class="mh-qmeta">' + esc(meta) + "</span></div>";
      });
      qlist += "</div>";
    }

    const streets = item.streets
      ? '<div class="mh-streets">Sampled: ' + esc(item.streets) + "</div>"
      : "";
    const foot = '<div class="mh-foot"><span>'
      + (st.domRef ? "Click to inspect queue " + esc(st.domRef) : "YASNO coverage area")
      + "</span><span>" + (isEst ? "Neighbor est." : "YASNO sample") + "</span></div>";

    return '<div class="mh-top"><div><div class="mh-title">' + esc(title) + "</div>"
      + '<div class="mh-sub">' + esc(sub) + "</div></div>" + badge + "</div>"
      + rows + bar + qlist + streets + foot;
  }

  _placeMapHover(clientX, clientY) {
    const tipEl = this._shell && this._shell.mapTip;
    if (!tipEl || tipEl.hidden) return;
    const vw = typeof window !== "undefined" && window.innerWidth ? window.innerWidth : 1024;
    const vh = typeof window !== "undefined" && window.innerHeight ? window.innerHeight : 768;
    const w = Math.min(344, vw - 16);
    const h = tipEl.offsetHeight || 190;
    const cx = Number(clientX) || 0;
    const cy = Number(clientY) || 0;
    const left = cx + 16 + w > vw - 8 ? Math.max(8, cx - w - 14) : Math.max(8, cx + 16);
    const top = cy + 14 + h > vh - 8 ? Math.max(8, vh - h - 10) : Math.max(8, cy + 14);
    tipEl.style.left = left + "px";
    tipEl.style.top = top + "px";
  }

  _onMapHover(ev) {
    const tipEl = this._shell && this._shell.mapTip;
    const ctx = this._mapHoverCtx;
    if (!tipEl || !ctx || !ctx.mapData) return;
    let el = ev && ev.target;
    while (el && el !== this.shadowRoot) {
      if (el.getAttribute && el.getAttribute("data-reg-kind")) break;
      el = el.parentNode;
    }
    const kind = el && el.getAttribute ? el.getAttribute("data-reg-kind") : null;
    const idx = el && el.getAttribute ? Number(el.getAttribute("data-reg-idx")) : -1;
    const list = kind && ctx.mapData[kind];
    const item = Array.isArray(list) && idx >= 0 ? list[idx] : null;
    if (!item) {
      this._hideMapHover();
      return;
    }
    const key = kind + ":" + idx;
    if (this._mapHoverKey !== key) {
      tipEl.innerHTML = this._renderMapHover(item, kind);
      this._mapHoverKey = key;
    }
    tipEl.hidden = false;
    if (typeof tipEl.removeAttribute === "function") tipEl.removeAttribute("hidden");
    this._placeMapHover(ev.clientX, ev.clientY);
  }

  _wireMap(d, now) {
    const slot = this._shell && this._shell.slots && this._shell.slots.hero;
    if (!slot) return;
    const stage = slot.querySelector(".map-stage");
    const svg = slot.querySelector(".map-svg");
    if (!stage || !svg) return;
    const md = d && d.mapData;
    const statusByQ = {};
    if (d && Array.isArray(d.queueCodes) && d.allQueues && now) {
      d.queueCodes.forEach((q) => { statusByQ[q] = queueStatusNow(q, d.allQueues, now); });
    }
    this._mapHoverCtx = {
      mapData: md, allQueues: d && d.allQueues, statusByQ,
      homeRef: d && d.homeRef, homeCode: d && d.homeCode, now,
    };
    this._hideMapHover();
    if (md) {
      this._mapMeta = {
        hr: Array.isArray(md.hromadas) ? md.hromadas.length : 0,
        dist: Array.isArray(md.districts) ? md.districts.length : 0,
        qtr: Array.isArray(md.quarters) ? md.quarters.length : 0,
        dniproCam: md.dnipro_cam || { cx: 316.88, cy: 170.34, scale: 6.62 },
      };
    }
    this._applyMapCamera();
    if (stage._dsMapWired || typeof stage.addEventListener !== "function") return;
    stage._dsMapWired = true;

    stage.addEventListener("wheel", (ev) => {
      if (ev.deltaY > 0 && this._mapCam.s <= 1.005) return;
      if (typeof ev.preventDefault === "function") ev.preventDefault();
      this._hideMapHover();
      if (this._mapAnim && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this._mapAnim);
      this._mapAnim = null;
      const pt = this._mapSvgPoint(svg, ev.clientX || 0, ev.clientY || 0);
      const wx = (pt.x - this._mapCam.tx) / this._mapCam.s;
      const wy = (pt.y - this._mapCam.ty) / this._mapCam.s;
      const newS = Math.max(1, Math.min(14, this._mapCam.s * Math.exp(-ev.deltaY * 0.0022)));
      this._mapCam = this._clampMapCam(pt.x - wx * newS, pt.y - wy * newS, newS);
      this._applyMapCamera();
    }, { passive: false });

    stage.addEventListener("pointerdown", (ev) => {
      if (ev.target && ev.target.closest && ev.target.closest(".map-hud")) return;
      this._hideMapHover();
      this._mapPointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (this._mapPointers.size === 2) {
        const pts = Array.from(this._mapPointers.values());
        this._mapPinch = {
          dist: Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1,
          mid: this._mapSvgPoint(svg, (pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2),
          cam: { ...this._mapCam },
        };
        this._mapDrag = null;
        this._mapDragMoved = true;
        return;
      }
      if (this._mapCam.s <= 1.01) return;
      this._mapDrag = {
        start: this._mapSvgPoint(svg, ev.clientX, ev.clientY),
        cam: { ...this._mapCam },
      };
      this._mapDragMoved = false;
      if (stage.classList) stage.classList.add("panning");
      if (typeof stage.setPointerCapture === "function") {
        try { stage.setPointerCapture(ev.pointerId); } catch (_) {}
      }
    });

    stage.addEventListener("pointermove", (ev) => {
      if (this._mapPointers.has(ev.pointerId)) {
        this._mapPointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      }
      if (this._mapPointers.size === 2 && this._mapPinch) {
        const pts = Array.from(this._mapPointers.values());
        const dNow = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1;
        const factor = dNow / this._mapPinch.dist;
        const newS = Math.max(1, Math.min(14, this._mapPinch.cam.s * factor));
        const wx = (this._mapPinch.mid.x - this._mapPinch.cam.tx) / this._mapPinch.cam.s;
        const wy = (this._mapPinch.mid.y - this._mapPinch.cam.ty) / this._mapPinch.cam.s;
        const midNow = this._mapSvgPoint(svg, (pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
        this._mapCam = this._clampMapCam(midNow.x - wx * newS, midNow.y - wy * newS, newS);
        this._applyMapCamera();
        return;
      }
      if (this._mapDrag) {
        const cur = this._mapSvgPoint(svg, ev.clientX, ev.clientY);
        const dx = cur.x - this._mapDrag.start.x;
        const dy = cur.y - this._mapDrag.start.y;
        if (Math.hypot(dx, dy) > 4) this._mapDragMoved = true;
        const next = this._clampMapCam(this._mapDrag.cam.tx + dx, this._mapDrag.cam.ty + dy, this._mapDrag.cam.s);
        this._mapCam.tx = next.tx;
        this._mapCam.ty = next.ty;
        this._applyMapCamera();
        return;
      }
      if (ev.pointerType !== "touch") this._onMapHover(ev);
    });

    stage.addEventListener("pointerleave", () => this._hideMapHover());

    const endPtr = (ev) => {
      this._mapPointers.delete(ev.pointerId);
      if (this._mapPointers.size < 2) this._mapPinch = null;
      if (this._mapDrag && this._mapPointers.size === 0) {
        this._mapDrag = null;
        if (stage.classList) stage.classList.remove("panning");
        setTimeout(() => { this._mapDragMoved = false; }, 30);
      }
    };
    stage.addEventListener("pointerup", endPtr);
    stage.addEventListener("pointercancel", endPtr);

    stage.addEventListener("dblclick", (ev) => {
      if (ev.target && ev.target.closest && ev.target.closest(".map-hud")) return;
      const pt = this._mapSvgPoint(svg, ev.clientX, ev.clientY);
      const wx = (pt.x - this._mapCam.tx) / this._mapCam.s;
      const wy = (pt.y - this._mapCam.ty) / this._mapCam.s;
      if (this._mapCam.s >= 7) this._flyMapTo(310, 200, 1);
      else this._flyMapTo(wx, wy, Math.min(14, this._mapCam.s * 2.4));
    });
  }

  /**
   * DTEK's announcement popup, verbatim, one line per paragraph. Red only when
   * the emergency entity is on; any other announcement is a neutral note.
   */
  _banner(b) {
    if (!b) return "";
    return '<div class="banner' + (b.emergency ? " emerg" : "") + '"'
      + tip(b.label, (b.title ? b.title + " " : "") + "checked " + b.checked, b.help || "banner") + ">"
      + '<span class="k">' + esc(b.label) + "</span>"
      + b.lines.map((l) => "<p>" + esc(l) + "</p>").join("")
      + "</div>";
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
      // Under the emergency an hour the schedule has off still says so: the
      // ring shows both, and so must the words.
      const schedOff = st && CERTAIN.indexOf(letter) >= 0 && (halfDark(letter, 0) || halfDark(letter, 1));
      const t = tip(pad2(h) + ":00" + DASH + pad2(h + 1) + ":00",
                    d.emergencyOn
                      ? (schedOff ? st.label + ", " + d.todayRow.source + "; Ukrenergo emergency outages too"
                        : "possible outage, Ukrenergo emergency outages")
                      : st ? st.label + ", " + d.todayRow.source : "no schedule published", "clock_hour");
      for (const half of [0, 1]) {
        // Under Ukrenergo's emergency outages no hour is safe, whatever the
        // table says: every hour not already marked off reads as possible.
        const base = !st || st.cls === "unknown" ? "none"
          : halfDark(letter, half) ? (CERTAIN.indexOf(letter) >= 0 ? "out" : "maybe") : "on";
        const cls = d.emergencyOn && base !== "out" ? "maybe" : base;
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
    const rowRuns = (rowObj, pastDim) => {
      const out = [];
      if (!rowObj) return out;
      let open = null;
      for (let i = 0; i <= 48; i++) {
        const letter = rowObj.row[Math.floor(i / 2)];
        const cls = i < 48 && halfDark(letter, i % 2)
          ? (CERTAIN.indexOf(letter) >= 0 ? "out" : "maybe") : null;
        if (open && open.cls !== cls) { out.push([open.from, midnight + i * 18e5, open.cls]); open = null; }
        if (cls && !open) open = { from: midnight + i * 18e5, cls };
      }
      if (!pastDim) return out;
      const past = out
        .map(([s, e, cls]) => [s, Math.min(e, nowMs), cls + " past"])
        .filter(([s, e]) => e > s);
      const fut = out
        .map(([s, e, cls]) => [Math.max(s, nowMs), e, cls])
        .filter(([s, e]) => e > s);
      return past.concat(fut);
    };
    const nowLine = '<span class="nowline" style="left:calc(' + pct(nowMs) + '% - 1px)"></span>';
    const item = (cls, text, key) => "<span" + tip(text, null, key) + ">"
      + '<span class="sw ' + cls + '"></span>' + esc(text) + "</span>";

    if (d.inspecting) {
      const selRuns = rowRuns(d.todayRow, true);
      const homeRuns = rowRuns(d.homeTodayRow, false).map(([s, e]) => [s, e, "cmp"]);
      const cmpRows = [
        ["Queue " + (d.code || "?"), d.todayRow ? d.todayRow.source : "no schedule", selRuns, "tl_row"],
        ["My queue" + (d.homeCode ? " (" + d.homeCode + ")" : ""),
          d.homeTodayRow ? d.homeTodayRow.source : "no schedule", homeRuns, "tl_cmp"],
      ];
      const body = cmpRows.map(([name, sub, blocks, hKey]) => {
        const curDark = blocks.some(([s, e]) => s <= nowMs && nowMs < e);
        return '<div class="tlname"' + tip(name, curDark ? "dark now" : "clear now", hKey) + ">"
          + esc(name) + "<small>" + esc(sub) + "</small></div>"
          + '<div class="bar">'
          + blocks.map(([s, e, cls]) => '<span class="blk ' + cls + '" style="left:' + pct(s)
            + "%;width:" + (((e - s) / DAY) * 100).toFixed(3) + '%"'
            + tip(name, hm(s) + DASH + hm(e) + ", " + fmtIn(Math.round((e - s) / 60000)).replace(/^in /, ""),
                  "tl_block") + "></span>").join("")
          + nowLine + "</div>";
      }).join("");
      return '<ha-card class="timeline"><div class="pad">'
        + '<div class="head"><h2>Today</h2></div>'
        + '<p class="blurb">Schedule for ' + esc(d.queue) + " compared against your home queue.</p>"
        + '<div class="tl">' + body
        + '<div class="axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>'
        + "</div>"
        + '<div class="legend">'
        + item("out", "Off (" + (d.code || "queue") + ")", "legend_out")
        + item("maybe", "Possible outage", "legend_maybe")
        + item("cmp", "My queue (" + (d.homeCode || "home") + ")", "tl_cmp")
        + "</div></div></ha-card>";
    }

    const h = this._hist;
    const fresh = !!(h && h.day === now.toDateString() && h.spans);
    const runs = rowRuns(d.todayRow, false);
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

  /** The bars or the bulbs, as week_style says. */
  _hours(d, cols, totalKey, withUnknown) {
    return d.weekStyle === "classic"
      ? this._bulbs(cols, totalKey, withUnknown)
      : this._grid(cols, totalKey, withUnknown);
  }

  /**
   * A row of 24 hanging bulbs per day, the hour on the glass: lit = power on,
   * cracked = outage, a dim amber glass = possible outage, flickering = power
   * for half the hour, a pulsing ring = now. On a phone each row wraps to two of 12. Time runs left to right, so the left half is the first half hour.
   * Same column objects, tooltips and totals as _grid().
   */
  _bulbs(cols, totalKey, withUnknown) {
    let rows = "";
    cols.forEach((day) => {
      let bulbs = "";
      day.cells.forEach((c, h) => {
        bulbs += '<div class="bulb ' + c.cls + '"' + tip(c.name, c.label, c.key) + ">"
          + classicBulb(pad2(h), /(^| )now( |$)/.test(c.cls), /^out( |$)/.test(c.cls),
            /^(out|maybe)-[12]( |$)/.test(c.cls)) + "</div>";
      });
      rows += '<div class="brow ' + day.cls + (day.applied ? " applied" : "") + '">'
        + '<div class="blabel"><span class="dname">' + esc(day.name) + "</span>"
        + '<span class="dsub">' + esc(day.sub) + "</span></div>"
        + '<div class="wire">' + bulbs + "</div>"
        + '<div class="dtots"><div class="dtot' + (day.heavy ? " heavy" : "") + '"'
        + tip(day.name + " total", day.published === false ? "not published" : day.total + " off",
              day.applied || totalKey === "sched_total" ? "sched_total" : totalKey)
        + ">" + esc(day.total) + "</div>"
        + (typeof day.lit === "number"
          ? '<div class="dlit"' + tip(day.name + " light", fmtHM(day.lit) + " measured", "day_light")
            + ">" + fmtHM(day.lit, true) + "</div>" : "")
        + "</div></div>";
    });
    const anyLit = cols.some((day) => typeof day.lit === "number");
    const item = (cls, text, key) => "<span" + tip(text, null, key) + ">"
      + '<span class="bulb mini ' + cls + '">'
      + classicBulb(null, /(^| )now( |$)/.test(cls), /^out( |$)/.test(cls),
        /^(out|maybe)-[12]( |$)/.test(cls)) + "</span>" + esc(text) + "</span>";
    return '<div class="bulbwrap">' + CLASSIC_DEFS
      + '<div class="bulbs">' + rows + "</div>"
      + '<div class="legend">'
      + item("on", "Power on", "legend_on")
      + item("out", "Scheduled outage", "legend_out")
      + item("maybe", "Possible outage", "legend_maybe")
      + item("out-2", "Off for half the hour", "legend_half")
      + (withUnknown ? item("unknown", "Not published", "sched_total") : "")
      + item("on now", "Now", "legend_now")
      + (anyLit ? "<span" + tip("Light, measured", null, "day_light") + '><span class="dlit">'
        + "18h05</span>Light, measured</span>" : "")
      + "</div></div>";
  }

  _daysCard(d) {
    // What DTEK has actually applied, which is what the site shows under
    // "Графік відключень": the week's grid, two columns.
    const inner = d.inEffect && d.applied.length
      ? this._hours(d, d.applied, "sched_total", true)
      : '<p class="note">No stabilisation schedule is in force, so DTEK '
        + "has applied nothing to today or tomorrow.</p>";
    return '<ha-card class="week days"><div class="pad">'
      + '<div class="head"><h2>Today and tomorrow</h2>'
      + '<span class="stamp"' + tip("Schedule published", d.published, "published")
      + ">Published " + esc(d.published) + "</span></div>"
      + inner + "</div></ha-card>";
  }

  _weekCard(d, now) {
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
        + this._hours(d, d.applied, "sched_total", true) : "";
    if (!d.week) {
      inner = '<p class="note">DTEK publishes no recurring table for this '
        + (d.inspecting ? "queue" : "address") + ".</p>" + appliedOnly;
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
      inner = this._hours(d, d.days, "day_total", false);
    }
    return '<ha-card class="week"><div class="pad">'
      + '<div class="head"><h2>Recurring weekly schedule</h2>'
      + '<span class="stamp"' + tip("Schedule published", d.published, "published")
      + ">Published " + esc(d.published) + "</span></div>"
      + (blurb === null ? "" : '<p class="blurb">' + esc(blurb) + "</p>")
      + inner + "</div></ha-card>";
  }

  // --- light history bar chart ---------------------------------------------

  _lcBounds(now) {
    const todayN = dayNum(now);
    const maxEnd = todayN + 1;
    const rawFirst = this._light && typeof this._light.firstDay === "number"
      ? this._light.firstDay : todayN - 6;
    const firstN = Math.min(rawFirst, todayN);
    const totalDays = Math.max(7, maxEnd - firstN);
    const maxDays = Math.max(30, totalDays);
    return { todayN, maxEnd, firstN, totalDays, minDays: LC_MIN_DAYS, maxDays };
  }

  _lcDomain(now) {
    const b = this._lcBounds(now);
    if (this._lcView) return { t0: this._lcView.start, t1: this._lcView.end, bounds: b };
    const rg = LIGHT_RANGES[this._lcRange] || LIGHT_RANGES["7d"];
    const span = rg.days === null ? b.totalDays : rg.days;
    return { t0: b.maxEnd - span, t1: b.maxEnd, bounds: b };
  }

  _lcSetView(start, end, now) {
    const b = this._lcBounds(now);
    const minStart = Math.min(b.firstN, b.maxEnd - b.totalDays);
    const availMax = Math.max(b.minDays, b.maxEnd - minStart);
    const span = Math.max(b.minDays, Math.min(Math.min(b.maxDays, availMax), end - start));
    let t1 = Math.min(b.maxEnd, end);
    let t0 = t1 - span;
    if (t0 < minStart) { t0 = minStart; t1 = Math.min(b.maxEnd, t0 + span); }
    this._lcView = { start: t0, end: t1 };
  }

  _lcCompute(now) {
    const dom = this._lcDomain(now);
    const { t0, t1, bounds } = dom;
    const span = t1 - t0;
    const todayN = bounds.todayN;
    const fmtD = (dn, withYear) => {
      const dt = dateFromDayNum(dn);
      const base = pad2(dt.getDate()) + "." + pad2(dt.getMonth() + 1);
      return withYear ? base + "." + String(dt.getFullYear()).slice(-2) : base;
    };

    const statD0 = Math.round(t0);
    const statD1 = Math.max(statD0, Math.round(t1) - 1);
    const isLiveEnd = t1 >= bounds.maxEnd - 0.05;
    let winLabel;
    if (!this._lcView) {
      winLabel = (LIGHT_RANGES[this._lcRange] || LIGHT_RANGES["7d"]).label;
    } else if (isLiveEnd) {
      winLabel = "last " + Math.round(span) + " days";
    } else {
      const yNow = now.getFullYear();
      const cross = dateFromDayNum(statD0).getFullYear() !== yNow
        || dateFromDayNum(statD1).getFullYear() !== yNow;
      winLabel = fmtD(statD0, cross) + " " + DASH + " " + fmtD(statD1, cross);
    }

    const nowH = Math.max(0, Math.min(24, now.getHours() + now.getMinutes() / 60));
    const barD0 = Math.floor(t0 + 0.001);
    const barD1 = Math.max(barD0, Math.ceil(t1 - 0.001) - 1);
    const bars = [];
    const byDn = {};
    for (let dn = barD0; dn <= barD1; dn++) {
      const date = dateFromDayNum(dn);
      const isToday = dn === todayN;
      const h = isToday ? this._lightToday() : this._lightOn(date, now);
      const spans = this._lightSpansOn(date, now);
      const hourFracs = this._lightHourFracsOn(date, now);
      const item = { dn, date, isToday, h, spans, hourFracs, est: dn < EST_CUTOFF_DN };
      bars.push(item);
      byDn[dn] = item;
    }

    const statItems = [];
    for (let dn = statD0; dn <= statD1; dn++) {
      const date = dateFromDayNum(dn);
      const item = byDn[dn] || {
        dn,
        date,
        isToday: dn === todayN,
        h: dn === todayN ? this._lightToday() : this._lightOn(date, now),
        spans: this._lightSpansOn(date, now),
        hourFracs: this._lightHourFracsOn(date, now),
        est: dn < EST_CUTOFF_DN,
      };
      statItems.push(item);
    }
    const completed = statItems.filter((x) => !x.isToday && typeof x.h === "number");
    const pool = completed.length ? completed
      : statItems.filter((x) => typeof x.h === "number");
    let minItem = null, maxItem = null, sum = 0;
    pool.forEach((x) => {
      if (minItem === null || x.h < minItem.h) minItem = x;
      if (maxItem === null || x.h > maxItem.h) maxItem = x;
      sum += x.h;
    });
    const mean = pool.length ? sum / pool.length : null;
    const todayH = this._lightToday();

    let note = null;
    if (!this._light) note = "Loading light history…";
    else if (this._light.failed && !Object.keys(this._light.days).length) {
      note = "Light history unavailable";
    }

    const getDaySpans = (d) => {
      if (byDn[d]) return byDn[d].spans;
      if (d === todayN) return this._todayLightSpans(now);
      return this._lightSpansOn(dateFromDayNum(d), now);
    };

    const minStart = Math.min(bounds.firstN, bounds.maxEnd - bounds.totalDays);
    return {
      t0, t1, span, todayN, minStart, nowH, winLabel, bars, byDn, statItems,
      todayH, minItem, maxItem, mean, note, fmtD, getDaySpans,
    };
  }

  _lcGridSvg(isHourly) {
    if (isHourly) {
      const yT = (h) => LC_HR_PAD_T + h * 10;
      let out = '<rect class="lc-night" x="0" y="' + yT(0) + '" width="' + LC_W
        + '" height="' + (NIGHT_END * 10) + '"></rect>'
        + '<rect class="lc-night" x="0" y="' + yT(NIGHT_START) + '" width="' + LC_W
        + '" height="' + ((24 - NIGHT_START) * 10) + '"></rect>'
        + '<line class="lc-tariff-line" x1="0" x2="' + LC_W + '" y1="' + yT(NIGHT_END)
        + '" y2="' + yT(NIGHT_END) + '" vector-effect="non-scaling-stroke"></line>'
        + '<line class="lc-tariff-line" x1="0" x2="' + LC_W + '" y1="' + yT(NIGHT_START)
        + '" y2="' + yT(NIGHT_START) + '" vector-effect="non-scaling-stroke"></line>';
      [0, 6, 12, 18, 24].forEach((h) => {
        const y = yT(h);
        const cls = h === 12 ? ' class="mid"' : (h === 0 || h === 24) ? ' class="base"' : "";
        out += '<line' + cls + ' x1="0" x2="' + LC_W + '" y1="' + y + '" y2="' + y
          + '" vector-effect="non-scaling-stroke"></line>';
      });
      return out;
    }
    const plotH = LC_H - LC_PAD_T - LC_PAD_B;
    return [0, 1, 2, 3, 4].map((i) => {
      const y = (LC_PAD_T + i * plotH / 4).toFixed(0);
      const cls = i === 2 ? ' class="mid"' : i === 4 ? ' class="base"' : "";
      return '<line' + cls + ' x1="0" x2="' + LC_W + '" y1="' + y + '" y2="' + y
        + '" vector-effect="non-scaling-stroke"></line>';
    }).join("");
  }

  _lcYaxHtml(isHourly) {
    return isHourly
      ? "<span>00</span><span>06</span><span>12</span><span>18</span><span>24</span>"
      : "<span>24h</span><span>12h</span><span>0h</span>";
  }

  _lcRenderParts(d) {
    const isHourly = this._lcMode === "hourly";
    const plotH = LC_H - LC_PAD_T - LC_PAD_B;
    const yOf = (h) => LC_PAD_T + (1 - Math.max(0, Math.min(24, h)) / 24) * plotH;
    const yBase = LC_PAD_T + plotH;
    const slotW = LC_W / d.span;
    const gap = Math.max(1.5, Math.min(24, slotW * 0.24));
    const barW = Math.max(2, slotW - gap);

    let barsSvg = "";
    let valsHtml = "";
    const showVals = !isHourly && d.span <= 10.5;

    if (!isHourly) {
      if (d.mean !== null) {
        const ym = yOf(d.mean).toFixed(1);
        barsSvg += '<line class="lc-mean" x1="0" x2="' + LC_W + '" y1="' + ym + '" y2="' + ym + '"></line>';
      }
      d.bars.forEach((b) => {
        if (typeof b.h !== "number") return;
        const val = Math.max(0, Math.min(24, b.h));
        const xSlot = (b.dn - d.t0) * slotW;
        const xBar = xSlot + (slotW - barW) / 2;
        const cxPct = ((b.dn + 0.5 - d.t0) / d.span) * 100;
        const todayCls = b.isToday ? " today" : "";
        if (val === 0) {
          const yZero = yBase - 3;
          barsSvg += '<rect class="lc-bar zero' + todayCls + '" x="' + xBar.toFixed(1)
            + '" y="' + yZero.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="3" rx="1"></rect>';
          if (showVals && cxPct >= 1 && cxPct <= 99) {
            valsHtml += '<span class="lc-val' + todayCls + '" style="left:' + cxPct.toFixed(2)
              + "%;top:" + Math.max(2, yZero - 16).toFixed(1) + 'px">' + fmtHM(0, true) + "</span>";
          }
        } else {
          const yTop = yOf(val);
          const hPx = Math.max(2, yBase - yTop);
          barsSvg += '<rect class="lc-bar' + todayCls + '" x="' + xBar.toFixed(1)
            + '" y="' + yTop.toFixed(1) + '" width="' + barW.toFixed(1)
            + '" height="' + hPx.toFixed(1) + '" rx="2"></rect>';
          barsSvg += '<rect class="lc-cap' + todayCls + '" x="' + xBar.toFixed(1)
            + '" y="' + yTop.toFixed(1) + '" width="' + barW.toFixed(1)
            + '" height="2" rx="1"></rect>';
          if (showVals && cxPct >= 1 && cxPct <= 99) {
            valsHtml += '<span class="lc-val' + todayCls + '" style="left:' + cxPct.toFixed(2)
              + "%;top:" + Math.max(2, yTop - 16).toFixed(1) + 'px">' + fmtHM(val, true) + "</span>";
          }
        }
      });
    } else {
      const hStrip = 8;
      d.bars.forEach((b) => {
        if (typeof b.h !== "number") return;
        const xSlot = (b.dn - d.t0) * slotW;
        const xBar = xSlot + (slotW - barW) / 2;
        const xStr = xBar.toFixed(1);
        const wStr = barW.toFixed(1);
        const todayCls = b.isToday ? " today" : "";
        const spans = b.spans || [];

        for (let h = 0; h < 24; h++) {
          const yRow = LC_HR_PAD_T + h * 10;
          const yStrip = yRow + 1;
          if (b.isToday && h >= d.nowH - 0.005) {
            barsSvg += '<rect class="lc-hcell future" x="' + xStr + '" y="' + yStrip
              + '" width="' + wStr + '" height="' + hStrip + '" rx="1.5"></rect>';
            continue;
          }
          const endOfHour = b.isToday ? Math.min(h + 1, d.nowH) : h + 1;
          const elap = Math.max(0, endOfHour - h);
          const elapH = Math.max(1.2, elap * hStrip).toFixed(1);
          if (b.isToday && elap < 0.995) {
            barsSvg += '<rect class="lc-hcell future" x="' + xStr
              + '" y="' + (yStrip + elap * hStrip).toFixed(1)
              + '" width="' + wStr + '" height="' + Math.max(1, (1 - elap) * hStrip).toFixed(1)
              + '" rx="1"></rect>';
          }
          const clipped = [];
          for (let i = 0; i < spans.length; i++) {
            const a = Math.max(h, spans[i][0]);
            const c = Math.min(endOfHour, spans[i][1]);
            if (c - a > 0.005) clipped.push([a, c]);
          }
          if (clipped.length === 1 && clipped[0][0] <= h + 0.005 && clipped[0][1] >= endOfHour - 0.005) {
            barsSvg += '<rect class="lc-hcell lit' + todayCls + '" x="' + xStr
              + '" y="' + yStrip + '" width="' + wStr + '" height="' + elapH + '" rx="1.5"></rect>';
          } else if (!clipped.length) {
            barsSvg += '<rect class="lc-hcell dark" x="' + xStr
              + '" y="' + yStrip + '" width="' + wStr + '" height="' + elapH + '" rx="1.5"></rect>';
          } else {
            barsSvg += '<rect class="lc-hcell dark" x="' + xStr
              + '" y="' + yStrip + '" width="' + wStr + '" height="' + elapH + '" rx="1.5"></rect>';
            clipped.forEach(([a, c]) => {
              barsSvg += '<rect class="lc-hcell lit' + todayCls + '" x="' + xStr
                + '" y="' + (yStrip + (a - h) * hStrip).toFixed(1)
                + '" width="' + wStr + '" height="' + Math.max(1.2, (c - a) * hStrip).toFixed(1)
                + '" rx="1"></rect>';
            });
          }
        }
        if (b.isToday) {
          const yNow = (LC_HR_PAD_T + d.nowH * 10).toFixed(1);
          barsSvg += '<line class="lc-hnow" x1="' + Math.max(0, xBar - 2).toFixed(1)
            + '" x2="' + Math.min(LC_W, xBar + barW + 2).toFixed(1)
            + '" y1="' + yNow + '" y2="' + yNow + '"></line>';
        }
      });
    }

    let xaxHtml = "";
    if (d.span <= 10.5) {
      d.bars.forEach((b) => {
        const cxPct = ((b.dn + 0.5 - d.t0) / d.span) * 100;
        if (cxPct < 1 || cxPct > 99) return;
        const name = b.isToday ? "Today" : DAY_SHORT[(b.date.getDay() + 6) % 7];
        const sub = pad2(b.date.getDate()) + "." + pad2(b.date.getMonth() + 1);
        xaxHtml += '<span class="lc-xlab' + (b.isToday ? " today" : "") + '" style="left:'
          + cxPct.toFixed(2) + '%">' + esc(name) + "<br>" + esc(sub) + "</span>";
      });
    } else {
      const firstTick = Math.ceil(d.t0 - 0.5);
      const lastTick = Math.floor(d.t1 - 0.5);
      const count = Math.max(1, lastTick - firstTick + 1);
      const target = 6;
      const step = Math.max(1, Math.round((count - 1) / (target - 1)));
      const ticks = [];
      for (let dn = firstTick; dn <= lastTick; dn += step) ticks.push(dn);
      if (ticks.length && lastTick - ticks[ticks.length - 1] >= Math.max(1, Math.floor(step / 2))) {
        ticks.push(lastTick);
      }
      ticks.forEach((dn) => {
        const cxPct = ((dn + 0.5 - d.t0) / d.span) * 100;
        if (cxPct < 2 || cxPct > 98) return;
        xaxHtml += '<span class="lc-xlab single' + (dn === d.todayN ? " today" : "")
          + '" style="left:' + cxPct.toFixed(2) + '%">' + esc(d.fmtD(dn, false)) + "</span>";
      });
    }

    const stat = (label, valStr, subStr, tipState) =>
      '<div class="lc-stat"' + tip(label, tipState, "lc_stat") + ">"
      + "<b>" + esc(label) + "</b>"
      + "<span>" + esc(valStr) + (subStr ? " <small>" + esc(subStr) + "</small>" : "") + "</span>"
      + "</div>";
    const statsHtml =
      stat("Today", d.todayH === null ? MDASH : fmtHM(d.todayH), null,
           d.todayH === null ? "not counted" : fmtHM(d.todayH) + " so far")
      + stat("Min", d.minItem ? fmtHM(d.minItem.h) : MDASH,
             d.minItem ? d.fmtD(d.minItem.dn, false) : null,
             d.minItem ? fmtHM(d.minItem.h) + " on " + d.fmtD(d.minItem.dn, false) : "no data")
      + stat("Max", d.maxItem ? fmtHM(d.maxItem.h) : MDASH,
             d.maxItem ? d.fmtD(d.maxItem.dn, false) : null,
             d.maxItem ? fmtHM(d.maxItem.h) + " on " + d.fmtD(d.maxItem.dn, false) : "no data")
      + stat("Mean", d.mean !== null ? fmtHM(d.mean) : MDASH, null,
             d.mean !== null ? fmtHM(d.mean) + " per day" : "no data");

    return { barsSvg, valsHtml, xaxHtml, statsHtml, xaxTwoLine: d.span <= 10.5 };
  }

  _lcFootText() {
    return this._lcMode === "hourly"
      ? "Hover any hour strip for details, click a day for full 24h view · Drag to pan, scroll or pinch to zoom."
      : "Hover a bar for periods, click for full 24h view · Drag to pan, scroll or pinch to zoom.";
  }

  /** Light history chart with Daily bars / Hourly strips switcher and 24h day modal. */
  _lightCard(now) {
    if (!this._lightObj()) return "";
    const d = this._lcCompute(now);
    this._lcDom = { t0: d.t0, t1: d.t1 };
    this._lcData = d;
    const p = this._lcRenderParts(d);
    const isHourly = this._lcMode === "hourly";
    const svgH = isHourly ? LC_HR_H : LC_H;

    const modes = LIGHT_MODES.map((m) =>
      '<button class="lc-mode" data-act="lmode" data-val="' + m.id + '" aria-pressed="'
      + String(this._lcMode === m.id) + '"' + tip("View mode", m.tip, "lc_mode")
      + ">" + m.label + "</button>"
    ).join("");

    const segs = LIGHT_RANGE_ORDER.map((r) => {
      const pressed = !this._lcView && this._lcRange === r;
      const label = r === "all" ? "All" : r;
      return '<button class="lc-seg" data-act="lrange" data-val="' + r + '" aria-pressed="'
        + String(pressed) + '"' + tip("Light range", LIGHT_RANGES[r].label, "lc_range")
        + ">" + label + "</button>";
    }).join("");

    return '<ha-card class="lightchart"><div class="pad">'
      + '<div class="lc-head">'
      + '<div class="lc-title">'
      + '<span class="lc-name" data-more="' + esc(this._config.light_entity)
      + '" role="button" tabindex="0"' + tip("Light, measured at the meter", d.winLabel, "lc_name")
      + '>Light, measured at the meter</span>'
      + '<span class="lc-win"' + tip("Window", d.winLabel, "lc_win") + ">" + esc(d.winLabel) + "</span>"
      + "</div>"
      + '<div class="lc-ctrl">'
      + '<div class="lc-modes">' + modes + "</div>"
      + '<div class="lc-segs">' + segs + "</div>"
      + "</div>"
      + "</div>"
      + '<div class="lc-hrleg"' + (isHourly ? "" : " hidden") + ">"
      + '<span><i class="sw-lit"></i>Power on</span>'
      + '<span><i class="sw-off"></i>No grid</span>'
      + '<span><i class="sw-night"></i>Night tariff 23–07</span>'
      + "</div>"
      + '<div class="lc-chart">'
      + '<div class="lc-yax' + (isHourly ? " hourly" : "") + '">' + this._lcYaxHtml(isHourly) + "</div>"
      + '<div class="lc-plot' + (isHourly ? " hourly" : "") + '">'
      + '<svg class="lc-svg' + (isHourly ? " hourly" : "") + '" viewBox="0 0 ' + LC_W + " " + svgH + '" preserveAspectRatio="none">'
      + '<defs><clipPath id="lcclip"><rect class="lc-cliprect" x="0" y="0" width="' + LC_W + '" height="' + svgH + '"></rect></clipPath></defs>'
      + '<g class="lc-grid">' + this._lcGridSvg(isHourly) + "</g>"
      + '<g class="lc-bars" clip-path="url(#lcclip)">' + p.barsSvg + "</g>"
      + "</svg>"
      + '<div class="lc-vals">' + p.valsHtml + "</div>"
      + '<div class="lc-hv"></div>'
      + '<div class="lc-hvh"></div>'
      + '<div class="lc-hvcell"></div>'
      + '<div class="lc-tip"></div>'
      + '<div class="lc-note' + (isHourly ? " hourly" : "") + (d.note ? " show" : "") + '">' + esc(d.note || "") + "</div>"
      + '<div class="lc-xax' + (p.xaxTwoLine ? " two" : "") + '">' + p.xaxHtml + "</div>"
      + "</div></div>"
      + '<div class="lc-stats">' + p.statsHtml + "</div>"
      + '<div class="lc-foot">' + esc(this._lcFootText()) + "</div>"
      + "</div></ha-card>";
  }

  _patchLightChart(now) {
    const card = this.shadowRoot.querySelector(".lightchart");
    if (!card || !this._lightObj()) return;
    const d = this._lcCompute(now);
    this._lcDom = { t0: d.t0, t1: d.t1 };
    this._lcData = d;
    const p = this._lcRenderParts(d);
    const isHourly = this._lcMode === "hourly";
    const svgH = isHourly ? LC_HR_H : LC_H;

    card.querySelectorAll(".lc-mode").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-val") === this._lcMode));
    });
    card.querySelectorAll(".lc-seg").forEach((b) => {
      const pressed = !this._lcView && b.getAttribute("data-val") === this._lcRange;
      b.setAttribute("aria-pressed", String(pressed));
    });
    const hrLeg = card.querySelector(".lc-hrleg");
    if (hrLeg) hrLeg.hidden = !isHourly;

    const nameEl = card.querySelector(".lc-name");
    if (nameEl) nameEl.setAttribute("data-tip", tipText("Light, measured at the meter", d.winLabel, "lc_name"));
    const winEl = card.querySelector(".lc-win");
    if (winEl) {
      winEl.textContent = d.winLabel;
      winEl.setAttribute("data-tip", tipText("Window", d.winLabel, "lc_win"));
    }
    const yaxEl = card.querySelector(".lc-yax");
    if (yaxEl) {
      yaxEl.classList.toggle("hourly", isHourly);
      yaxEl.innerHTML = this._lcYaxHtml(isHourly);
    }
    const plotEl = card.querySelector(".lc-plot");
    if (plotEl) plotEl.classList.toggle("hourly", isHourly);
    const svgEl = card.querySelector(".lc-svg");
    if (svgEl) {
      svgEl.classList.toggle("hourly", isHourly);
      svgEl.setAttribute("viewBox", "0 0 " + LC_W + " " + svgH);
    }
    const clipRect = card.querySelector(".lc-cliprect");
    if (clipRect) clipRect.setAttribute("height", String(svgH));
    const gridEl = card.querySelector(".lc-grid");
    if (gridEl) gridEl.innerHTML = this._lcGridSvg(isHourly);
    const barsEl = card.querySelector(".lc-bars");
    if (barsEl) barsEl.innerHTML = p.barsSvg;
    const valsEl = card.querySelector(".lc-vals");
    if (valsEl) valsEl.innerHTML = p.valsHtml;
    const noteEl = card.querySelector(".lc-note");
    if (noteEl) {
      noteEl.classList.toggle("hourly", isHourly);
      noteEl.textContent = d.note || "";
      noteEl.classList.toggle("show", !!d.note);
    }
    const xaxEl = card.querySelector(".lc-xax");
    if (xaxEl) {
      xaxEl.innerHTML = p.xaxHtml;
      xaxEl.classList.toggle("two", p.xaxTwoLine);
    }
    const statsEl = card.querySelector(".lc-stats");
    if (statsEl) statsEl.innerHTML = p.statsHtml;
    const footEl = card.querySelector(".lc-foot");
    if (footEl) footEl.textContent = this._lcFootText();

    if (this._fingerprint !== null) this._fingerprint = this._fingerprintOf(now);
    if (this._lcModalDn !== null) {
      this._setLcColHv(d, this._lcModalDn, true);
    } else if (this._lcHover && !this._lcDragging) {
      this._onLcHover(this._lcHover);
    } else {
      this._hideLcHover();
    }
  }

  _wireLightChart() {
    const plot = this.shadowRoot.querySelector(".lc-plot");
    if (!plot) return;
    plot.addEventListener("pointerdown", (e) => this._onLcPointerDown(e));
    plot.addEventListener("pointermove", (e) => this._onLcPointerMove(e));
    ["pointerup", "pointercancel"].forEach((n) =>
      plot.addEventListener(n, (e) => this._onLcPointerUp(e)));
    plot.addEventListener("wheel", (e) => this._onLcWheel(e), { passive: false });
    plot.addEventListener("dblclick", () => this._resetLcView());
    plot.addEventListener("mousemove", (e) => this._onLcHover(e));
    ["mouseleave", "pointerleave", "pointercancel"].forEach((n) =>
      plot.addEventListener(n, () => this._lcLeave()));
  }

  _lcDayAt(clientX, rect, base) {
    return base.t0 + (clientX - rect.left) / Math.max(1, rect.width) * (base.t1 - base.t0);
  }

  _lcApplyView(start, end) {
    const now = new Date();
    this._lcSetView(start, end, now);
    this._patchLightChart(now);
  }

  _lcZoomFrom(base, anchor, factor) {
    const b = this._lcBounds(new Date());
    const span = base.t1 - base.t0;
    const next = Math.max(b.minDays, Math.min(b.maxDays, span / factor));
    const frac = span > 0 ? (anchor - base.t0) / span : 0.5;
    const t0 = anchor - frac * next;
    this._lcApplyView(t0, t0 + next);
  }

  _resetLcView() {
    this._lcView = null;
    this._patchLightChart(new Date());
  }

  _onLcPointerDown(ev) {
    if (!this._lcDom || (ev.button !== undefined && ev.button > 0)) return;
    this._lcPointers.set(ev.pointerId, ev.clientX);
    this._lcMoved = false;
    try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (err) { /* not fatal */ }
    this._lcBeginGesture(ev.currentTarget);
  }

  _lcBeginGesture(node) {
    const xs = Array.from(this._lcPointers.values());
    const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : { left: 0, width: 1 };
    this._lcGesture = {
      base: { t0: this._lcDom.t0, t1: this._lcDom.t1 },
      rect: rect,
      xs: xs.slice(),
      dist: xs.length > 1 ? Math.abs(xs[0] - xs[1]) : 0,
      mid: xs.length > 1 ? (xs[0] + xs[1]) / 2 : xs[0],
    };
    if (xs.length >= 2) {
      this._lcDragging = true;
      this._lcMoved = true;
      node.classList.add("grabbing");
    }
  }

  _onLcPointerMove(ev) {
    if (!this._lcPointers.has(ev.pointerId)) return;
    this._lcPointers.set(ev.pointerId, ev.clientX);
    const g = this._lcGesture;
    if (!g) return;
    const xs = Array.from(this._lcPointers.values());
    if (xs.length >= 2) {
      const dist = Math.abs(xs[0] - xs[1]);
      if (g.dist > 8 && dist > 8) {
        this._hideLcHover();
        this._lcZoomFrom(g.base, this._lcDayAt(g.mid, g.rect, g.base), dist / g.dist);
      }
      return;
    }
    const dx = xs[0] - g.xs[0];
    if (!this._lcDragging && Math.abs(dx) < 3) return;
    this._lcDragging = true;
    this._lcMoved = true;
    ev.currentTarget.classList.add("grabbing");
    this._hideLcHover();
    const span = g.base.t1 - g.base.t0;
    const dd = -(dx / Math.max(1, g.rect.width)) * span;
    this._lcApplyView(g.base.t0 + dd, g.base.t1 + dd);
  }

  _onLcPointerUp(ev) {
    if (!this._lcPointers.delete(ev.pointerId)) return;
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch (err) { /* gone */ }
    if (this._lcPointers.size) {
      this._lcBeginGesture(ev.currentTarget);
      return;
    }
    const wasMoved = this._lcMoved;
    this._lcGesture = null;
    this._lcDragging = false;
    this._lcMoved = false;
    ev.currentTarget.classList.remove("grabbing");
    if (!wasMoved && ev.type === "pointerup" && this._lcData) {
      const plot = this.shadowRoot.querySelector(".lc-plot");
      const rect = plot && plot.getBoundingClientRect ? plot.getBoundingClientRect() : null;
      if (rect && rect.width && ev.clientX !== undefined) {
        const d = this._lcData;
        const dn = Math.floor(d.t0 + ((ev.clientX - rect.left) / rect.width) * d.span);
        if (d.byDn[dn]) this._openLcModal(dn);
      }
    }
    if (this._lcDeferredRender) {
      this._lcDeferredRender = false;
      this._render();
    }
  }

  _onLcWheel(ev) {
    if (!this._lcDom) return;
    if (typeof ev.preventDefault === "function") ev.preventDefault();
    const rect = ev.currentTarget.getBoundingClientRect
      ? ev.currentTarget.getBoundingClientRect() : { left: 0, width: 1 };
    const base = { t0: this._lcDom.t0, t1: this._lcDom.t1 };
    const step = ev.deltaMode === 1 ? 0.05 : ev.deltaMode === 2 ? 0.5 : 0.0022;
    const f = Math.max(0.25, Math.min(4, Math.exp(-ev.deltaY * step)));
    this._lcZoomFrom(base, this._lcDayAt(ev.clientX, rect, base), f);
  }

  _lcItemFor(d, dn) {
    if (d.byDn[dn]) return d.byDn[dn];
    const now = new Date();
    const date = dateFromDayNum(dn);
    const isToday = dn === d.todayN;
    return {
      dn,
      date,
      isToday,
      h: isToday ? this._lightToday() : this._lightOn(date, now),
      spans: this._lightSpansOn(date, now),
      hourFracs: this._lightHourFracsOn(date, now),
      est: dn < EST_CUTOFF_DN,
    };
  }

  _setLcColHv(d, dn, pinned) {
    const plot = this.shadowRoot.querySelector(".lc-plot");
    const hv = plot && plot.querySelector(".lc-hv");
    if (!hv || !d) return false;
    const leftPct = Math.max(0, ((dn - d.t0) / d.span) * 100);
    const rightPct = Math.min(100, ((dn + 1 - d.t0) / d.span) * 100);
    if (rightPct <= leftPct) {
      hv.classList.remove("on");
      hv.classList.remove("pin");
      return false;
    }
    hv.style.left = leftPct.toFixed(3) + "%";
    hv.style.width = (rightPct - leftPct).toFixed(3) + "%";
    hv.classList.add("on");
    hv.classList.toggle("pin", !!pinned);
    return true;
  }

  _buildLcTimelineHtml(d, item, clsPrefix, segExtraFn) {
    const lightList = item.spans || [];
    const endH = item.isToday ? Math.max(0, Math.min(24, d.nowH)) : 24;
    const darkList = darkSpansOf(lightList, endH);
    let inner = "";
    const tickHours = clsPrefix === "lcm" ? [3, 6, 9, 12, 15, 18, 21] : [6, 12, 18];
    tickHours.forEach((h) => {
      inner += '<i class="' + clsPrefix + '-tl-tick" style="left:'
        + ((h / 24) * 100).toFixed(3) + '%"></i>';
    });
    [NIGHT_END, NIGHT_START].forEach((h) => {
      inner += '<i class="' + clsPrefix + '-tl-nt" style="left:'
        + ((h / 24) * 100).toFixed(3) + '%"></i>';
    });
    if (item.isToday && d.nowH < 23.99) {
      const aLeft = ((d.nowH / 24) * 100).toFixed(3);
      const aW = (((24 - d.nowH) / 24) * 100).toFixed(3);
      inner += '<span class="' + clsPrefix + '-tl-ahead" style="left:' + aLeft
        + '%;width:' + aW + '%"></span>';
    }
    const segTag = (seg, kind, idx) => {
      const left = (seg[0] / 24) * 100;
      const width = ((seg[1] - seg[0]) / 24) * 100;
      const extra = segExtraFn ? segExtraFn(seg, kind, idx, width) : { cls: "", body: "" };
      const todayCls = item.isToday && kind === "light" ? " today" : "";
      const actAttr = clsPrefix === "lcm" ? ' data-act="lc-seg"' : "";
      return '<span class="' + clsPrefix + "-seg " + (kind === "light" ? "lit" : "dark")
        + todayCls + (extra.cls || "")
        + '"' + actAttr + ' data-kind="' + kind + '" data-idx="' + idx
        + '" style="left:' + left.toFixed(3) + "%;width:" + Math.max(0.6, width).toFixed(3)
        + '%">' + (extra.body || "") + "</span>";
    };
    darkList.forEach((seg, i) => { inner += segTag(seg, "dark", i); });
    lightList.forEach((seg, i) => { inner += segTag(seg, "light", i); });
    if (item.isToday) {
      inner += '<i class="' + clsPrefix + '-tl-now" style="left:'
        + ((d.nowH / 24) * 100).toFixed(3) + '%"></i>';
    }
    return { lightList, darkList, inner };
  }

  _onLcHover(ev) {
    if (this._lcModalDn !== null || !this._lcData || this._lcDragging) return;
    if (this._lcMode === "hourly") {
      this._onLcHoverHourly(ev);
      return;
    }
    const plot = this.shadowRoot.querySelector(".lc-plot");
    if (!plot) return;
    const hvh = plot.querySelector(".lc-hvh");
    const hvcell = plot.querySelector(".lc-hvcell");
    if (hvh) hvh.classList.remove("on");
    if (hvcell) hvcell.classList.remove("on");
    const rect = plot.getBoundingClientRect ? plot.getBoundingClientRect() : null;
    if (!rect || !rect.width) return;
    const d = this._lcData;
    const dn = Math.floor(d.t0 + ((ev.clientX - rect.left) / rect.width) * d.span);
    const item = d.byDn[dn];
    if (!item || !this._setLcColHv(d, dn, false)) { this._hideLcHover(); return; }
    this._lcHover = { clientX: ev.clientX };

    const tipEl = plot.querySelector(".lc-tip");
    if (!tipEl) return;

    const dt = item.date;
    const dStr = pad2(dt.getDate()) + "." + pad2(dt.getMonth() + 1) + "." + dt.getFullYear();
    const dayLabel = item.isToday ? "Today · " + dStr : DAY_SHORT[(dt.getDay() + 6) % 7] + " " + dStr;
    const plotH = LC_H - LC_PAD_T - LC_PAD_B;
    const yOf = (h) => LC_PAD_T + (1 - Math.max(0, Math.min(24, h)) / 24) * plotH;

    let yTop;
    if (typeof item.h === "number") {
      const val = Math.max(0, Math.min(24, item.h));
      const pct = Math.round((val / 24) * 100);
      const tone = item.isToday ? "ok" : pct >= 50 ? "ok" : pct >= 25 ? "warn" : "bad";
      const pillHtml = '<span class="lct-pill ' + tone + '"><i></i>'
        + (item.isToday ? "LIVE" : pct + "% ON") + "</span>";

      let deltaHtml = "";
      if (!item.isToday && d.mean !== null) {
        const diff = val - d.mean;
        const absDiff = Math.abs(diff);
        const cls = diff >= 0.5 ? "ok" : diff <= -0.5 ? "bad" : "";
        const txt = absDiff < 0.02 ? "on avg"
          : (diff > 0 ? "+" : "−") + fmtHM(absDiff) + " vs avg";
        deltaHtml = '<span class="lct-delta ' + cls + '">' + esc(txt) + "</span>";
      }

      const dark = item.isToday ? Math.max(0, d.nowH - val) : Math.max(0, 24 - val);
      const darkText = item.isToday ? fmtHM(dark) + " off so far" : fmtHM(dark) + " off";
      const { lightList, inner } = this._buildLcTimelineHtml(d, item, "lct");

      const tlHtml = '<div class="lct-tl">'
        + '<div class="lct-tl-head"><span>00:00' + DASH + '24:00</span>'
        + '<span class="lct-tl-leg"><span><i class="sw-lit"></i>Power</span>'
        + '<span><i class="sw-off"></i>Off</span></span></div>'
        + '<div class="lct-tl-bar">' + inner + "</div>"
        + '<div class="lct-tl-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>'
        + "</div>";

      let winsHtml;
      if (!lightList.length) {
        winsHtml = '<div class="lct-wins">No power all day</div>';
      } else {
        const shown = lightList.length <= 4 ? lightList : lightList.slice(0, 3);
        const chips = shown.map(([s, e]) =>
          '<span class="lct-wchip">' + esc(fmtClockH(s) + DASH + fmtClockH(e)
            + " (" + fmtHM(e - s) + ")") + "</span>").join("");
        const more = lightList.length > 4
          ? '<span class="lct-wchip more">+' + (lightList.length - 3) + " more</span>" : "";
        winsHtml = '<div class="lct-wins"><div class="lct-wlist">' + chips + more + "</div></div>";
      }

      const split = tariffSplit(lightList);
      const splitText = "Day 07–23: " + fmtHM(split.day) + " · Night 23–07: " + fmtHM(split.night);
      const estHtml = item.est ? '<div class="lct-est">Estimated from inverter voltage</div>' : "";

      tipEl.innerHTML =
        '<div class="lct-hd"><span class="lct-date">' + esc(dayLabel)
        + '</span><span class="lct-hd-r">' + pillHtml + "</span></div>"
        + '<div class="lct-main"><span class="lct-big">' + esc(fmtHM(val)) + "</span>"
        + deltaHtml + "</div>"
        + '<div class="lct-sub">' + esc(darkText) + "</div>"
        + tlHtml
        + '<div class="lct-rule">'
        + winsHtml
        + '<div class="lct-split">' + esc(splitText) + "</div>"
        + estHtml
        + '<div class="lct-hint">Click bar for full 24h view</div>'
        + "</div>";
      yTop = val <= 0 ? LC_PAD_T + plotH - 3 : yOf(val);
    } else {
      tipEl.innerHTML =
        '<div class="lct-hd"><span class="lct-date">' + esc(dayLabel)
        + '</span><span class="lct-hd-r"><span class="lct-pill idle"><i></i>NO DATA</span></span></div>'
        + '<div class="lct-main"><span class="lct-big">Not recorded</span></div>'
        + '<div class="lct-sub">No statistics for this day</div>';
      yTop = LC_PAD_T + plotH - 36;
    }

    const cxPx = ((dn + 0.5 - d.t0) / d.span) * rect.width;
    const halfW = Math.min(rect.width / 2, (tipEl.offsetWidth || 286) / 2 + 6);
    tipEl.style.left = Math.max(halfW, Math.min(rect.width - halfW, cxPx)).toFixed(1) + "px";
    const flip = yTop < 76;
    tipEl.classList.toggle("below", flip);
    tipEl.style.top = (flip ? Math.min(LC_H - 8, yTop + 10) : Math.max(10, yTop - 10)).toFixed(1) + "px";
    tipEl.classList.add("on");
  }

  _onLcHoverHourly(ev) {
    const d = this._lcData;
    const plot = this.shadowRoot.querySelector(".lc-plot");
    if (!d || !plot || this._lcDragging || this._lcModalDn !== null) return;
    const rect = plot.getBoundingClientRect ? plot.getBoundingClientRect() : null;
    if (!rect || !rect.width) return;

    const dn = Math.floor(d.t0 + ((ev.clientX - rect.left) / rect.width) * d.span);
    const item = d.byDn[dn];
    if (!item || !this._setLcColHv(d, dn, false)) { this._hideLcHover(); return; }

    const hrPlotH = LC_HR_H - LC_HR_PAD_T - LC_HR_PAD_B;
    const rawY = ev.clientY !== undefined ? ev.clientY - (rect.top || 0) : LC_HR_H / 2;
    const yPx = Math.max(LC_HR_PAD_T, Math.min(LC_HR_H - LC_HR_PAD_B - 0.01, rawY));
    const yH = Math.max(0, Math.min(23.999, ((yPx - LC_HR_PAD_T) / hrPlotH) * 24));
    const hour = Math.floor(yH);

    this._lcHover = {
      clientX: ev.clientX,
      clientY: ev.clientY !== undefined ? ev.clientY : (rect.top || 0) + LC_HR_H / 2,
    };

    const hvh = plot.querySelector(".lc-hvh");
    if (hvh) {
      hvh.style.top = (LC_HR_PAD_T + hour * 10) + "px";
      hvh.style.height = "10px";
      hvh.classList.add("on");
    }
    const hvcell = plot.querySelector(".lc-hvcell");
    if (hvcell) {
      const slotW = LC_W / d.span;
      const gap = Math.max(1.5, Math.min(24, slotW * 0.24));
      const barW = Math.max(2, slotW - gap);
      const xSlotPct = ((dn - d.t0) / d.span) * 100;
      const barPct = (barW / LC_W) * 100;
      const padPct = ((slotW - barW) / 2 / LC_W) * 100;
      const leftPct = Math.max(0, xSlotPct + padPct);
      const rightPct = Math.min(100, xSlotPct + padPct + barPct);
      hvcell.style.left = leftPct.toFixed(3) + "%";
      hvcell.style.width = Math.max(0, rightPct - leftPct).toFixed(3) + "%";
      hvcell.style.top = (LC_HR_PAD_T + hour * 10 + 1) + "px";
      hvcell.style.height = "8px";
      hvcell.classList.add("on");
    }

    const tipEl = plot.querySelector(".lc-tip");
    if (!tipEl) return;

    const dt = item.date;
    const dStr = pad2(dt.getDate()) + "." + pad2(dt.getMonth() + 1) + "." + dt.getFullYear();
    const dayLabel = item.isToday ? "Today · " + dStr : DAY_SHORT[(dt.getDay() + 6) % 7] + " " + dStr;
    const hourRange = pad2(hour) + ":00 " + DASH + " " + pad2(hour + 1) + ":00";
    const rel = hourReliability(hour, d.statItems, d.todayN, d.nowH);
    const relHtml = rel
      ? '<div class="lct-wins">At ' + pad2(rel.hour) + ":00: power on " + rel.lit + " / "
        + rel.total + " days (" + rel.pct + "%)</div>"
      : "";

    if (typeof item.h !== "number") {
      tipEl.innerHTML =
        '<div class="lct-hd"><span class="lct-date">' + esc(dayLabel)
        + '</span><span class="lct-hd-r"><span class="lct-pill idle"><i></i>NO DATA</span></span></div>'
        + '<div class="lct-main"><span class="lct-big">' + esc(hourRange) + "</span>"
        + '<span class="lct-delta">Not recorded</span></div>'
        + '<div class="lct-sub">No statistics for this day</div>'
        + (relHtml ? '<div class="lct-rule">' + relHtml + "</div>" : "");
    } else if (item.isToday && hour >= d.nowH - 0.005) {
      tipEl.innerHTML =
        '<div class="lct-hd"><span class="lct-date">' + esc(dayLabel)
        + '</span><span class="lct-hd-r"><span class="lct-pill idle"><i></i>AHEAD</span></span></div>'
        + '<div class="lct-main"><span class="lct-big">' + esc(hourRange) + "</span>"
        + '<span class="lct-delta">Ahead of now</span></div>'
        + '<div class="lct-sub">' + esc("Day so far " + fmtHM(item.h)) + "</div>"
        + (relHtml ? '<div class="lct-rule">' + relHtml + "</div>" : "");
    } else {
      const endOfHour = item.isToday ? Math.min(hour + 1, d.nowH) : hour + 1;
      const avail = Math.max(0, endOfHour - hour);
      const lightList = item.spans || [];
      const clipped = [];
      let litInHour = 0;
      lightList.forEach(([s, e]) => {
        const a = Math.max(hour, s);
        const c = Math.min(endOfHour, e);
        if (c - a > 0.005) {
          clipped.push([a, c]);
          litInHour += c - a;
        }
      });
      const minsOn = Math.round(litInHour * 60);

      let pillHtml, statusText;
      if (litInHour >= avail - 0.02) {
        pillHtml = '<span class="lct-pill ok"><i></i>POWER ON</span>';
        statusText = minsOn + "m on";
      } else if (litInHour <= 0.02) {
        pillHtml = '<span class="lct-pill bad"><i></i>NO GRID</span>';
        statusText = "No grid · 0m on";
      } else {
        pillHtml = '<span class="lct-pill warn"><i></i>PARTIAL</span>';
        statusText = minsOn + "m on · "
          + clipped.map(([a, c]) => fmtClockH(a) + DASH + fmtClockH(c)).join(", ");
      }

      const endH = item.isToday ? Math.max(0, Math.min(24, d.nowH)) : 24;
      const darkList = darkSpansOf(lightList, endH);
      let kind = clipped.length ? "light" : "dark";
      let seg = null;
      if (kind === "light") {
        const pMid = (clipped[0][0] + clipped[0][1]) / 2;
        seg = lightList.find(([s, e]) => pMid >= s - 0.01 && pMid <= e + 0.01) || clipped[0];
      } else {
        const dMid = hour + avail / 2;
        seg = darkList.find(([s, e]) => dMid >= s - 0.01 && dMid <= e + 0.01) || [0, endH];
      }
      const cont = continuousSpan(dn, kind, seg, d.getDaySpans, d.todayN, d.nowH);
      const subText = (kind === "light" ? "Window: " : "Outage: ")
        + fmtClockH(seg[0]) + DASH + fmtClockH(seg[1]) + " (" + fmtHM(seg[1] - seg[0]) + ")"
        + " · Day " + fmtHM(item.h);
      const contHtml = cont.crosses
        ? '<div class="lct-split">Continuous: '
          + esc((cont.startDn !== dn ? d.fmtD(cont.startDn, false) + " " : "")
          + fmtClockH(cont.startH) + " → "
          + (cont.endDn !== dn ? d.fmtD(cont.endDn, false) + " " : "")
          + fmtClockH(cont.endH) + " (" + fmtHM(cont.hours) + ")")
          + "</div>"
        : "";
      const estHtml = item.est ? '<div class="lct-est">Estimated from inverter voltage</div>' : "";

      tipEl.innerHTML =
        '<div class="lct-hd"><span class="lct-date">' + esc(dayLabel)
        + '</span><span class="lct-hd-r">' + pillHtml + "</span></div>"
        + '<div class="lct-main"><span class="lct-big">' + esc(hourRange) + "</span>"
        + '<span class="lct-delta">' + esc(statusText) + "</span></div>"
        + '<div class="lct-sub">' + esc(subText) + "</div>"
        + '<div class="lct-rule">' + contHtml + relHtml + estHtml
        + '<div class="lct-hint">Click day for full 24h view</div>'
        + "</div>";
    }

    const cxPx = ((dn + 0.5 - d.t0) / d.span) * rect.width;
    const halfW = Math.min(rect.width / 2, (tipEl.offsetWidth || 286) / 2 + 6);
    tipEl.style.left = Math.max(halfW, Math.min(rect.width - halfW, cxPx)).toFixed(1) + "px";
    const yRowMid = LC_HR_PAD_T + hour * 10 + 5;
    const flip = yRowMid < LC_HR_H * 0.52;
    tipEl.classList.toggle("below", flip);
    tipEl.style.top = (flip ? Math.min(LC_HR_H - 6, yRowMid + 10) : Math.max(10, yRowMid - 10)).toFixed(1) + "px";
    tipEl.classList.add("on");
  }

  _wireLcModal() {
    const backdrop = this._shell && this._shell.modal;
    if (!backdrop) return;
    const segAt = (node) => {
      let n = node;
      while (n && n !== backdrop) {
        if (n.classList && (n.classList.contains("lcm-seg") || n.classList.contains("lcm-row"))) {
          return { kind: n.getAttribute("data-kind"), idx: Number(n.getAttribute("data-idx")) };
        }
        n = n.parentNode;
      }
      return null;
    };
    const same = (a, b) => (!a && !b) || (!!a && !!b && a.kind === b.kind && a.idx === b.idx);
    backdrop.addEventListener("mousemove", (e) => {
      if (this._lcModalDn === null) return;
      const seg = segAt(e.target);
      const next = seg || this._lcModalSeg;
      if (!same(this._lcHoverSeg, next)) {
        this._lcHoverSeg = next;
        this._renderLcModalSeg(next);
      }
    });
    backdrop.addEventListener("mouseleave", () => {
      if (this._lcModalDn === null) return;
      if (!same(this._lcHoverSeg, this._lcModalSeg)) {
        this._lcHoverSeg = this._lcModalSeg;
        this._renderLcModalSeg(this._lcModalSeg);
      }
    });
  }

  _buildLcModalInspectHtml(d, item, segRef) {
    const lightList = item.spans || [];
    const endH = item.isToday ? Math.max(0, Math.min(24, d.nowH)) : 24;
    const darkList = darkSpansOf(lightList, endH);
    if (!segRef || typeof item.h !== "number") {
      const wc = lightList.length;
      const oc = darkList.length;
      return '<div class="lcm-insp-idle">Hover or click any segment on the timeline or list below</div>'
        + '<div class="lcm-insp-meta">'
        + wc + " power " + (wc === 1 ? "window" : "windows")
        + " · " + oc + " " + (oc === 1 ? "outage" : "outages")
        + " · Use ‹ Prev / Next › or arrow keys</div>";
    }
    const list = segRef.kind === "light" ? lightList : darkList;
    const seg = list[segRef.idx];
    if (!seg) return this._buildLcModalInspectHtml(d, item, null);
    const pill = segRef.kind === "light"
      ? '<span class="lct-pill ok"><i></i>POWER ON</span>'
      : '<span class="lct-pill bad"><i></i>NO GRID</span>';
    const order = (segRef.kind === "light" ? "Window " : "Outage ") + (segRef.idx + 1) + " of " + list.length;
    const spanText = fmtClockH(seg[0]) + " " + DASH + " " + fmtClockH(seg[1]) + " · " + fmtHM(seg[1] - seg[0]);
    const cont = continuousSpan(item.dn, segRef.kind, seg, d.getDaySpans, d.todayN, d.nowH);
    const midH = Math.min(23, Math.floor((seg[0] + seg[1]) / 2));
    const rel = hourReliability(midH, d.statItems, d.todayN, d.nowH);
    const meta = [];
    if (cont.crosses) {
      meta.push("<span>Continuous: "
        + esc((cont.startDn !== item.dn ? d.fmtD(cont.startDn, false) + " " : "")
        + fmtClockH(cont.startH) + " → "
        + (cont.endDn !== item.dn ? d.fmtD(cont.endDn, false) + " " : "")
        + fmtClockH(cont.endH) + " (" + fmtHM(cont.hours) + ")")
        + "</span>");
    }
    if (rel) {
      meta.push("<span>At " + pad2(rel.hour) + ":00: power on " + rel.lit + " / "
        + rel.total + " days (" + rel.pct + "%)</span>");
    }
    return '<div class="lcm-insp-top">' + pill
      + '<span class="lcm-insp-span">' + esc(spanText) + "</span>"
      + '<span class="lcm-insp-ord">' + esc(order) + "</span></div>"
      + '<div class="lcm-insp-meta">' + meta.join("") + "</div>";
  }

  _renderLcModalSeg(segRef) {
    const backdrop = this._shell && this._shell.modal;
    const d = this._lcData;
    if (!backdrop || !d || this._lcModalDn === null) return;
    backdrop.querySelectorAll(".lcm-seg, .lcm-row").forEach((el) => {
      const match = !!segRef
        && el.getAttribute("data-kind") === segRef.kind
        && Number(el.getAttribute("data-idx")) === segRef.idx;
      el.classList.toggle("sel", match);
    });
    const box = backdrop.querySelector(".lcm-inspect");
    if (box) {
      box.innerHTML = this._buildLcModalInspectHtml(d, this._lcItemFor(d, this._lcModalDn), segRef);
    }
  }

  _openLcModal(dn) {
    const shell = this._ensureShell();
    const d = this._lcData;
    const backdrop = shell && shell.modal;
    if (!d || !backdrop) return;

    this._lcHover = null;
    this._hideLcHover();
    this._setLcColHv(d, dn, true);

    this._lcModalDn = dn;
    this._lcModalSeg = null;
    this._lcHoverSeg = null;

    const item = this._lcItemFor(d, dn);
    const dt = item.date;
    const dStr = pad2(dt.getDate()) + "." + pad2(dt.getMonth() + 1) + "." + dt.getFullYear();
    const dayLabel = item.isToday ? "Today · " + dStr : DAY_SHORT[(dt.getDay() + 6) % 7] + " " + dStr;
    const navHtml =
      '<button class="lcm-btn" data-act="lc-prev" aria-label="Previous day"'
      + (dn <= d.minStart ? " disabled" : "") + ">‹ Prev</button>"
      + '<button class="lcm-btn" data-act="lc-next" aria-label="Next day"'
      + (dn >= d.todayN ? " disabled" : "") + ">Next ›</button>"
      + '<button class="lcm-btn lcm-x" data-act="lc-close" aria-label="Close modal">×</button>';

    let bodyHtml;
    let headPill;
    const estHtml = item.est ? '<span class="lcm-est">Estimated from inverter voltage</span>' : "";

    if (typeof item.h === "number") {
      const val = Math.max(0, Math.min(24, item.h));
      const pct = Math.round((val / 24) * 100);
      const tone = item.isToday ? "ok" : pct >= 50 ? "ok" : pct >= 25 ? "warn" : "bad";
      headPill = '<span class="lct-pill ' + tone + '"><i></i>'
        + (item.isToday ? "LIVE" : pct + "% ON") + "</span>";

      const dark = item.isToday ? Math.max(0, d.nowH - val) : Math.max(0, 24 - val);
      let deltaSub = item.isToday ? "live total" : "no window avg";
      let deltaCls = "";
      if (!item.isToday && d.mean !== null) {
        const diff = val - d.mean;
        const absDiff = Math.abs(diff);
        deltaCls = diff >= 0.5 ? " ok" : diff <= -0.5 ? " bad" : "";
        deltaSub = absDiff < 0.02 ? "on window avg"
          : (diff > 0 ? "+" : "−") + fmtHM(absDiff) + " vs avg";
      }

      const { lightList, darkList, inner } = this._buildLcTimelineHtml(d, item, "lcm", (_s, _k, _i, width) => ({
        cls: "",
        body: width >= 10 ? '<span class="lcm-seg-lbl">' + esc(fmtHM((_s[1] - _s[0]), true)) + "</span>" : "",
      }));
      const split = tariffSplit(lightList);

      const kpi = (lbl, big, sub, valCls) =>
        '<div class="lcm-kpi"><span class="lcm-kl">' + esc(lbl) + "</span>"
        + '<strong class="lcm-kv">' + esc(big) + "</strong>"
        + '<small class="lcm-ks' + (valCls || "") + '">' + esc(sub) + "</small></div>";
      const kpisHtml = '<div class="lcm-kpis">'
        + kpi("Power on", fmtHM(val), deltaSub, deltaCls)
        + kpi("No grid", fmtHM(dark), item.isToday ? "off so far" : (100 - pct) + "% of day", "")
        + kpi("Day 07–23", fmtHM(split.day), "day tariff", "")
        + kpi("Night 23–07", fmtHM(split.night), "night tariff", "")
        + "</div>";

      const tlHtml = '<div class="lcm-tl">'
        + '<div class="lcm-tl-head">'
        + '<span class="lcm-tl-title">24-hour timeline · 00:00' + DASH + '24:00</span>'
        + '<span class="lcm-tl-leg">'
        + '<span><i class="sw-lit"></i>Power on</span>'
        + '<span><i class="sw-off"></i>No grid</span>'
        + '<span><i class="sw-night"></i>Night tariff 23–07</span>'
        + "</span></div>"
        + '<div class="lcm-tl-tariff">'
        + '<span style="left:0%;width:29.167%"></span>'
        + '<span style="left:95.833%;width:4.167%"></span>'
        + "</div>"
        + '<div class="lcm-tl-bar">' + inner + "</div>"
        + '<div class="lcm-tl-axis"><span>00:00</span><span>03:00</span><span>06:00</span>'
        + '<span>09:00</span><span>12:00</span><span>15:00</span><span>18:00</span>'
        + '<span>21:00</span><span>24:00</span></div>'
        + "</div>";

      const inspectHtml = '<div class="lcm-inspect">'
        + this._buildLcModalInspectHtml(d, item, null) + "</div>";

      const entries = [];
      lightList.forEach((seg, idx) => entries.push({ kind: "light", idx, seg }));
      darkList.forEach((seg, idx) => entries.push({ kind: "dark", idx, seg }));
      entries.sort((a, b) => a.seg[0] - b.seg[0]);

      const rowsHtml = entries.map((e) => {
        const cont = continuousSpan(dn, e.kind, e.seg, d.getDaySpans, d.todayN, d.nowH);
        return '<div class="lcm-row ' + (e.kind === "light" ? "lit" : "dark")
          + '" data-act="lc-seg" data-kind="' + e.kind + '" data-idx="' + e.idx + '">'
          + '<span class="lcm-row-kind"><i></i>' + (e.kind === "light" ? "Power on" : "No grid") + "</span>"
          + '<span class="lcm-row-span">' + esc(fmtClockH(e.seg[0]) + " " + DASH + " " + fmtClockH(e.seg[1])) + "</span>"
          + '<span class="lcm-row-dur">' + esc(fmtHM(e.seg[1] - e.seg[0])) + "</span>"
          + (cont.crosses ? '<span class="lcm-row-cont">Continuous ' + esc(fmtHM(cont.hours)) + "</span>" : "")
          + "</div>";
      }).join("");

      bodyHtml = kpisHtml + tlHtml + inspectHtml + '<div class="lcm-list">' + rowsHtml + "</div>";
    } else {
      headPill = '<span class="lct-pill idle"><i></i>NO DATA</span>';
      bodyHtml = '<div class="lcm-empty"><strong>Not recorded</strong>'
        + "<span>No hourly statistics were recorded for this day.</span></div>";
    }

    backdrop.innerHTML =
      '<div class="lc-modal" role="dialog" aria-modal="true" aria-label="24-hour mains timeline">'
      + '<div class="lcm-hd">'
      + '<div class="lcm-title-grp"><span class="lcm-date">' + esc(dayLabel) + "</span>"
      + headPill + estHtml + "</div>"
      + '<div class="lcm-nav">' + navHtml + "</div>"
      + "</div>"
      + bodyHtml
      + "</div>";
    backdrop.hidden = false;
  }

  _stepLcModal(delta) {
    const d = this._lcData;
    if (!d || this._lcModalDn === null) return;
    const nextDn = Math.max(d.minStart, Math.min(d.todayN, this._lcModalDn + delta));
    if (nextDn === this._lcModalDn) return;
    this._lcModalDn = nextDn;
    this._lcModalSeg = null;
    this._lcHoverSeg = null;
    if (nextDn < d.t0) {
      this._lcApplyView(nextDn, nextDn + d.span);
    } else if (nextDn + 1 > d.t1) {
      this._lcApplyView(nextDn + 1 - d.span, nextDn + 1);
    }
    this._openLcModal(nextDn);
  }

  _resetLcModalDom() {
    this._lcModalDn = null;
    this._lcModalSeg = null;
    this._lcHoverSeg = null;
    if (this._shell && this._shell.modal) {
      this._shell.modal.hidden = true;
      this._shell.modal.innerHTML = "";
    }
  }

  _closeLcModal() {
    this._resetLcModalDom();
    this._lcHover = null;
    this._hideLcHover();
    if (this._lcDeferredRender) {
      this._lcDeferredRender = false;
      this._render();
    }
  }

  _lcLeave() {
    this._lcHover = null;
    this._hideLcHover();
  }

  _hideLcHover() {
    const plot = this.shadowRoot.querySelector(".lc-plot");
    if (!plot) return;
    plot.querySelectorAll(".lc-tip, .lc-hvh, .lc-hvcell").forEach((el) => {
      el.classList.remove("on");
    });
    const hv = plot.querySelector(".lc-hv");
    if (hv && this._lcModalDn === null) {
      hv.classList.remove("on");
      hv.classList.remove("pin");
    }
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
.ds-slot { display: flex; flex-direction: column; gap: 12px; }
.ds-slot[hidden] { display: none; }
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
.hero.has-map .pad {
  gap: 16px 22px;
  grid-template-columns: minmax(220px, 1fr) minmax(280px, 1.15fr) auto;
  grid-template-areas: "copy map clock" "queues queues queues" "tiles tiles tiles";
}
.hero-left { grid-area: copy; display: flex; flex-direction: column; gap: 9px; min-width: 0; }
.map-slot {
  grid-area: map; display: flex; flex-direction: column; gap: 8px; min-width: 0;
  background: var(--ds-inner); border: 1px solid var(--ds-line2); border-radius: 10px;
  padding: 10px 12px;
}
.map-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; flex-wrap: wrap; }
.map-seg {
  display: inline-flex; padding: 2px; border-radius: 7px;
  background: var(--ds-ground); border: 1px solid var(--ds-line2); gap: 2px;
}
.map-btn {
  appearance: none; border: 0; border-radius: 5px; background: transparent;
  color: var(--ds-muted); font: 600 10.5px/1 var(--ds-mono);
  padding: 5px 7px; cursor: pointer; white-space: nowrap;
}
.map-btn:hover { color: var(--ds-text); }
.map-btn.active { background: var(--ds-line2); color: var(--ds-text); }
.map-btn:focus-visible { outline: 2px solid var(--ds-ok-hi); outline-offset: 1px; }
.map-stage {
  position: relative; width: 100%; aspect-ratio: 620 / 400;
  background: radial-gradient(circle at 55% 42%, #11151d 0%, #090b0e 100%);
  border: 1px solid var(--ds-line); border-radius: 8px;
  overflow: hidden; touch-action: none; user-select: none;
}
.map-stage.panning .map-svg { cursor: grabbing; }
.map-svg { display: block; width: 100%; height: 100%; cursor: grab; }
.map-poly { vector-effect: non-scaling-stroke; transition: fill-opacity .15s ease, stroke .12s ease; }
.map-poly.clickable { cursor: pointer; }
.map-poly.clickable:hover { stroke: var(--ds-text); stroke-width: 1.7; }
.map-poly.clickable:focus-visible { outline: 2px solid var(--ds-ok-hi); }
.map-raion {
  fill: none; stroke: rgba(169, 181, 195, .28); stroke-width: 1.1; stroke-dasharray: 3 3;
  pointer-events: none; vector-effect: non-scaling-stroke;
}
.map-river {
  fill: none; stroke: #243b55; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round;
  pointer-events: none; vector-effect: non-scaling-stroke; opacity: .75;
}
.map-river.wide { stroke: #1c334d; stroke-width: 8; opacity: .55; }
.map-dout {
  fill: none; stroke: rgba(232, 234, 237, .42); stroke-width: 1.25;
  pointer-events: none; vector-effect: non-scaling-stroke;
}
.map-pin { pointer-events: none; }
.map-dot { fill: var(--ds-text2); }
.map-dot.t1 { fill: var(--ds-text); }
.map-pin-txt, .map-dist-lbl, .map-q-lbl {
  fill: var(--ds-text2); font: 500 9.5px var(--ds-sans); pointer-events: none;
  paint-order: stroke; stroke: var(--ds-ground); stroke-width: 3px; stroke-linejoin: round;
}
.map-pin-txt.t1 { fill: var(--ds-text); font-weight: 600; font-size: 10.5px; }
.map-dist-lbl { fill: var(--ds-text); font-size: 9.5px; font-weight: 600; }
.map-q-lbl { fill: var(--ds-text2); font-size: 8.5px; stroke-width: 2.5px; }
.map-hud {
  position: absolute; right: 8px; bottom: 8px;
  display: flex; align-items: center; gap: 5px; pointer-events: auto;
}
.map-hud-badge {
  background: rgba(11, 12, 15, .90); border: 1px solid var(--ds-line2);
  border-radius: 6px; padding: 4px 8px; font: 600 10px/1 var(--ds-mono); color: var(--ds-text2);
}
.map-zpad {
  display: inline-flex; background: rgba(11, 12, 15, .92);
  border: 1px solid var(--ds-line2); border-radius: 6px; overflow: hidden;
}
.map-zpad button {
  appearance: none; background: transparent; border: 0; border-right: 1px solid var(--ds-line2);
  color: var(--ds-text); font: 600 12px/1 var(--ds-mono); padding: 5px 8px; cursor: pointer;
}
.map-zpad button:last-child { border-right: 0; font-size: 10.5px; }
.map-zpad button:hover { background: var(--ds-line2); }
.map-zpad button:focus-visible { outline: 2px solid var(--ds-ok-hi); outline-offset: -1px; }
.map-foot {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
  gap: 6px 10px; font: 500 10.5px var(--ds-mono); color: var(--ds-muted);
}
.map-leg { display: flex; flex-wrap: wrap; gap: 6px 12px; justify-content: flex-end; }
.map-leg > span { display: inline-flex; align-items: center; gap: 5px; }
.map-sw { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
.map-sw.on { background: var(--ds-ok); }
.map-sw.soon { background: var(--ds-warn); }
.map-sw.off { background: var(--ds-bad); }
.map-sw.emerg { background: repeating-linear-gradient(135deg, var(--ds-bad) 0 2px, var(--ds-bad-hi) 2px 4px); }
.map-empty {
  min-height: 150px; display: grid; place-items: center;
  color: var(--ds-muted); font: 500 12px var(--ds-mono);
}
/* Floating 344px Clean Rows map hover card */
.map-hcard {
  position: fixed; z-index: 9999; pointer-events: none; box-sizing: border-box;
  width: 344px; max-width: calc(100vw - 16px);
  padding: 13px 14px; border-radius: 10px;
  background: rgba(12, 14, 19, .97); border: 1px solid var(--ds-line2);
  box-shadow: 0 12px 32px rgba(0, 0, 0, .58); backdrop-filter: blur(8px);
  color: var(--ds-text); font-family: var(--ds-sans);
  display: flex; flex-direction: column; gap: 10px;
}
.map-hcard[hidden] { display: none; }
.mh-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.mh-title { font: 600 15px/1.2 var(--ds-sans); color: var(--ds-text); }
.mh-sub { font: 500 11px/1.3 var(--ds-sans); color: var(--ds-muted); margin-top: 2px; }
.mh-pill {
  flex: 0 0 auto; padding: 3px 8px; border-radius: 999px;
  font: 600 10.5px/1.2 var(--ds-mono);
  border: 1px solid var(--ds-line2); background: var(--ds-inner); color: var(--ds-text2);
}
.mh-pill.off, .mh-pill.emerg { color: var(--ds-bad-hi); border-color: color-mix(in srgb, var(--ds-bad) 50%, var(--ds-line2)); }
.mh-pill.soon { color: var(--ds-warn-hi); border-color: color-mix(in srgb, var(--ds-warn) 50%, var(--ds-line2)); }
.mh-pill.on { color: var(--ds-ok-hi); border-color: color-mix(in srgb, var(--ds-ok) 50%, var(--ds-line2)); }
.mh-rows {
  display: flex; flex-direction: column; gap: 5px;
  padding: 8px 10px; border-radius: 8px;
  background: var(--ds-ground); border: 1px solid var(--ds-line);
}
.mh-row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; font-size: 13px; }
.mh-row.total { padding-bottom: 5px; margin-bottom: 2px; border-bottom: 1px solid var(--ds-line); font-weight: 600; }
.mh-k { display: inline-flex; align-items: center; gap: 7px; color: var(--ds-text2); }
.mh-row.total .mh-k { color: var(--ds-text); }
.mh-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
.mh-dot.off { background: var(--ds-bad-hi); }
.mh-dot.emerg { background: var(--ds-bad-hi); box-shadow: 0 0 6px var(--ds-bad); }
.mh-dot.soon { background: var(--ds-warn-hi); }
.mh-dot.on { background: var(--ds-ok-hi); }
.mh-v { font: 600 13.5px/1 var(--ds-mono); font-variant-numeric: tabular-nums; color: var(--ds-text); }
.mh-row.c-off .mh-v { color: var(--ds-bad-hi); }
.mh-row.c-soon .mh-v { color: var(--ds-warn-hi); }
.mh-row.c-on .mh-v { color: var(--ds-ok-hi); }
.mh-bar { display: flex; height: 7px; border-radius: 999px; overflow: hidden; background: var(--ds-line); gap: 1px; }
.mh-bar .seg-emerg { background: var(--ds-bad-hi); }
.mh-bar .seg-off { background: var(--ds-bad); }
.mh-bar .seg-soon { background: var(--ds-warn); }
.mh-bar .seg-on { background: var(--ds-ok); }
.mh-pct { font: 500 11.5px/1 var(--ds-mono); color: var(--ds-muted); margin-left: 5px; }
.mh-qlist { display: flex; flex-direction: column; gap: 4px; }
.mh-qhdr { font: 600 10px/1 var(--ds-mono); letter-spacing: .06em; text-transform: uppercase; color: var(--ds-muted); margin-bottom: 1px; }
.mh-qrow { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 8px; font-size: 12px; padding: 3px 0; }
.mh-qname { font: 600 12px/1 var(--ds-mono); color: var(--ds-text); display: inline-flex; align-items: center; gap: 5px; min-width: 56px; }
.mh-qtrack { height: 5px; border-radius: 999px; background: var(--ds-line); overflow: hidden; }
.mh-qfill { height: 100%; border-radius: 999px; }
.mh-qfill.off, .mh-qfill.emerg { background: var(--ds-bad); }
.mh-qfill.soon { background: var(--ds-warn); }
.mh-qfill.on { background: var(--ds-ok); }
.mh-qmeta { font: 500 11px/1 var(--ds-mono); color: var(--ds-text2); text-align: right; white-space: nowrap; }
.mh-streets { font: 500 11px/1.35 var(--ds-sans); color: var(--ds-muted); padding-top: 6px; border-top: 1px solid var(--ds-line); }
.mh-foot { font: 500 11px/1.2 var(--ds-mono); color: var(--ds-link); display: flex; justify-content: space-between; gap: 8px; }
.q-strip { grid-area: queues; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.q-pill {
  appearance: none; display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 9px; border-radius: 999px; cursor: pointer;
  background: var(--ds-inner); border: 1px solid var(--ds-line2);
  color: var(--ds-text2); font: 600 11px/1 var(--ds-mono); font-variant-numeric: tabular-nums;
}
.q-pill:hover { border-color: var(--ds-muted); color: var(--ds-text); }
.q-pill.active {
  background: var(--ds-line2); border-color: var(--k); color: var(--ds-text);
}
.q-pill:focus-visible, .map-back:focus-visible { outline: 2px solid var(--ds-ok-hi); outline-offset: 2px; }
.q-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ds-muted); }
.q-pill.st-on .q-dot { background: var(--ds-ok-hi); }
.q-pill.st-soon .q-dot { background: var(--ds-warn-hi); }
.q-pill.st-off .q-dot, .q-pill.st-emerg .q-dot { background: var(--ds-bad-hi); }
.q-star { color: var(--ds-warn-hi); font-size: 10px; line-height: 1; }
.map-back {
  appearance: none; background: transparent; border: 1px solid var(--ds-line2); border-radius: 999px;
  color: var(--ds-link); font: 600 11px/1 var(--ds-mono); padding: 4px 10px; cursor: pointer;
}
.map-back:hover { border-color: var(--ds-link); }
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
/* DTEK's announcement popup. Neutral unless it is Ukrenergo's emergency here. */
.banner {
  display: flex; flex-direction: column; gap: 4px; max-width: 60ch;
  padding: 10px 12px; border-radius: 8px;
  border: 1px solid var(--ds-line2); background: var(--ds-inner);
}
.banner .k {
  font: 600 10.5px/1.2 var(--ds-mono); letter-spacing: .08em; text-transform: uppercase;
  color: var(--ds-muted);
}
.banner p { font-size: 13px; color: var(--ds-text2); text-wrap: pretty; }
.banner.emerg {
  border-color: color-mix(in srgb, var(--ds-bad) 70%, var(--ds-line));
  background: color-mix(in srgb, var(--ds-bad) 14%, var(--ds-inner));
}
.banner.emerg .k { color: var(--ds-bad-hi); }.banner.emerg p:first-of-type { color: var(--ds-text); font-weight: 500; }
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
.tiles.four { grid-template-columns: repeat(4, minmax(0, 1fr)); }
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
.blk.cmp, .sw.cmp { background: var(--ds-link); opacity: .78; }
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

/*
 * The week as bulbs: a row per day, a classic A-shape bulb per hour, the hour
 * on the glass. The halo behind a lit bulb is a radial background, not a blur
 * filter, so 168 of them stay cheap to paint. The one thing that moves is the
 * ring round the current hour, and it holds while the card is off screen.
 */
.bulbwrap { display: flex; flex-direction: column; gap: 12px; }
.bulbwrap .defs { position: absolute; width: 0; height: 0; }
.bulbs { display: flex; flex-direction: column; gap: 8px; padding: 4px 2px 6px; width: 100%; }
.brow {
  display: grid; grid-template-columns: 74px minmax(0, 1fr) 44px; align-items: center; gap: 10px;
  padding: 6px 8px; border-radius: 10px;
}
.brow.today {
  background: color-mix(in srgb, var(--ds-ok) 10%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ds-ok) 35%, transparent);
}
.brow.tmrw { background: rgba(255, 255, 255, .03); box-shadow: inset 0 0 0 1px var(--ds-line2); }
.blabel { display: flex; flex-direction: column; gap: 2px; }
.brow.today .dname, .brow.today .dsub { color: var(--ds-ok-hi); }
.brow .dtot { height: auto; align-items: center; }
/* Under the plan's dark hours, the light the meter measured that day. */
.dtots { display: flex; flex-direction: column; align-items: center; gap: 3px; }
.dlit { font: 600 11px var(--ds-mono); font-variant-numeric: tabular-nums; color: var(--ds-ok-hi); }
/* --- light history bar chart -------------------------------------------- */
.lc-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 14px; }
.lc-title { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px 10px; }
.lc-name { font: 600 15px/1.3 var(--ds-sans); color: var(--ds-text); cursor: pointer; border-radius: 5px; }
.lc-name:hover { text-decoration: underline; text-underline-offset: 4px; }
.lc-win { font: 500 11.5px var(--ds-mono); color: var(--ds-muted); }
.lc-ctrl { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.lc-modes, .lc-segs {
  display: flex; gap: 2px; padding: 3px; border-radius: 9px;
  background: var(--ds-inner); border: 1px solid var(--ds-line);
}
.lc-mode, .lc-seg {
  padding: 5px 11px; border: 0; border-radius: 7px; cursor: pointer; background: transparent;
  color: var(--ds-muted); font: 500 11.5px/1 var(--ds-mono); transition: background .15s, color .15s;
}
.lc-mode:hover, .lc-seg:hover { color: var(--ds-text); }
.lc-mode[aria-pressed="true"], .lc-seg[aria-pressed="true"] {
  background: color-mix(in srgb, var(--ds-ok) 22%, var(--ds-dim));
  color: var(--ds-ok-hi);
}
.lc-mode:focus-visible, .lc-seg:focus-visible, .lc-name:focus-visible {
  outline: 2px solid var(--ds-ok-hi); outline-offset: 2px;
}
.lc-hrleg {
  display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: -2px 0 -2px 34px;
  font: 500 10.5px var(--ds-mono); color: var(--ds-muted);
}
.lc-hrleg[hidden] { display: none; }
.lc-hrleg > span { display: inline-flex; align-items: center; gap: 5px; }
.lc-hrleg i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; }
.lc-hrleg .sw-lit { background: color-mix(in srgb, var(--ds-ok) 82%, transparent); }
.lc-hrleg .sw-off { background: rgba(187, 99, 91, .35); border: 1px solid rgba(255, 146, 138, .3); }
.lc-hrleg .sw-night { background: rgba(134, 179, 227, .2); border: 1px dashed rgba(134, 179, 227, .48); }
.lc-chart { display: flex; gap: 10px; align-items: flex-start; margin-top: 2px; }
.lc-yax {
  display: flex; flex-direction: column; justify-content: space-between;
  height: ${LC_H}px; padding: ${LC_PAD_T}px 0 ${LC_PAD_B}px; box-sizing: border-box;
  font: 500 10.5px var(--ds-mono); font-variant-numeric: tabular-nums;
  color: var(--ds-muted); text-align: right; min-width: 24px;
}
.lc-yax.hourly { height: ${LC_HR_H}px; padding: ${LC_HR_PAD_T}px 0 ${LC_HR_PAD_B}px; }
.lc-yax span { display: block; height: 0; line-height: 0; white-space: nowrap; }
.lc-plot {
  flex: 1; min-width: 0; position: relative;
  touch-action: pan-y; cursor: grab; user-select: none; -webkit-user-select: none;
}
.lc-plot.grabbing { cursor: grabbing; }
svg.lc-svg { width: 100%; height: ${LC_H}px; display: block; }
svg.lc-svg.hourly { height: ${LC_HR_H}px; }
.lc-grid line { stroke: var(--ds-line); stroke-width: 1; }
.lc-grid line.mid, .lc-grid line.base { stroke: var(--ds-line2); }
.lc-night { fill: rgba(134, 179, 227, .055); }
.lc-tariff-line { stroke: rgba(134, 179, 227, .28); stroke-width: 1; stroke-dasharray: 3 4; }
.lc-bar { fill: color-mix(in srgb, var(--ds-ok) 65%, transparent); }
.lc-bar.today { fill: color-mix(in srgb, var(--ds-ok-hi) 68%, transparent); }
.lc-bar.zero { fill: var(--ds-dim); }
.lc-cap { fill: var(--ds-ok); }
.lc-cap.today { fill: var(--ds-ok-hi); }
.lc-mean { stroke: var(--ds-text2); stroke-width: 1; stroke-dasharray: 4 4; opacity: .55; vector-effect: non-scaling-stroke; }
.lc-hcell.lit { fill: color-mix(in srgb, var(--ds-ok) 82%, transparent); }
.lc-hcell.lit.today { fill: var(--ds-ok-hi); }
.lc-hcell.dark { fill: rgba(187, 99, 91, .30); }
.lc-hcell.future { fill: rgba(255, 255, 255, .035); }
.lc-hnow { stroke: #F1F4F8; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.lc-vals { position: absolute; left: 0; right: 0; top: 0; height: ${LC_H}px; pointer-events: none; overflow: hidden; }
.lc-val {
  position: absolute; transform: translateX(-50%); white-space: nowrap;
  font: 600 11px/1 var(--ds-mono); font-variant-numeric: tabular-nums; color: var(--ds-ok-hi);
}
.lc-hv {
  position: absolute; top: ${LC_PAD_T}px; height: ${LC_H - LC_PAD_T - LC_PAD_B}px;
  background: rgba(255, 255, 255, .045); border-radius: 4px;
  pointer-events: none; opacity: 0; transition: opacity .1s; z-index: 1;
}
.lc-plot.hourly .lc-hv { top: ${LC_HR_PAD_T}px; height: ${LC_HR_H - LC_HR_PAD_T - LC_HR_PAD_B}px; }
.lc-hv.on { opacity: 1; }
.lc-hv.pin {
  background: rgba(98, 214, 168, .10);
  box-shadow: inset 0 0 0 1px rgba(98, 214, 168, .28);
}
.lc-hvh {
  position: absolute; left: 0; right: 0;
  background: rgba(255, 255, 255, .04);
  border-top: 1px solid rgba(255, 255, 255, .09);
  border-bottom: 1px solid rgba(255, 255, 255, .09);
  pointer-events: none; opacity: 0; transition: opacity .08s; z-index: 1; box-sizing: border-box;
}
.lc-hvh.on { opacity: 1; }
.lc-hvcell {
  position: absolute; border-radius: 2px; box-shadow: inset 0 0 0 1.5px #F1F4F8;
  pointer-events: none; opacity: 0; transition: opacity .08s; z-index: 2;
}
.lc-hvcell.on { opacity: 1; }
.lc-tip {
  position: absolute; pointer-events: none; opacity: 0; transition: opacity .1s;
  transform: translate(-50%, -100%); z-index: 3; min-width: 268px; max-width: min(320px, calc(100% - 8px));
  background: #1A2028; border: 1px solid #2E3844; border-radius: 8px; padding: 10px 12px;
  font-family: var(--ds-sans); color: #F1F4F8; white-space: normal;
  box-shadow: 0 12px 32px rgba(0, 0, 0, .55), inset 0 1px 0 rgba(255, 255, 255, .04);
}
.lc-tip.below { transform: translate(-50%, 0); }
.lc-tip.on { opacity: 1; }
.lct-hd { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.lct-date { font: 600 12px/1.3 var(--ds-sans); color: #F1F4F8; }
.lct-hd-r { display: inline-flex; align-items: center; gap: 5px; }
.lct-pill {
  display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 999px;
  font: 600 10px/1.3 var(--ds-mono); letter-spacing: .05em; text-transform: uppercase;
}
.lct-pill i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.lct-pill.ok { color: #62D6A8; background: rgba(63, 182, 139, .14); }
.lct-pill.warn { color: #F2BE62; background: rgba(224, 163, 58, .15); }
.lct-pill.bad { color: #FF928A; background: rgba(229, 83, 75, .17); }
.lct-pill.idle { color: #A9B5C3; background: rgba(169, 181, 195, .12); }
.lct-main { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-top: 5px; }
.lct-big { font: 600 14px/1.2 var(--ds-mono); font-variant-numeric: tabular-nums; color: #F1F4F8; }
.lct-delta { font: 500 11px/1.2 var(--ds-mono); font-variant-numeric: tabular-nums; color: #A9B5C3; }
.lct-delta.ok { color: #62D6A8; }
.lct-delta.bad { color: #FF928A; }
.lct-sub { font: 400 11px/1.35 var(--ds-mono); color: #A9B5C3; margin-top: 3px; }
/* Horizontal 00:00–24:00 preview timeline inside hover tooltip */
.lct-tl { margin-top: 8px; }
.lct-tl-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  font: 500 10px/1.2 var(--ds-mono); color: #93A0AF; margin-bottom: 4px;
}
.lct-tl-leg { display: inline-flex; align-items: center; gap: 9px; }
.lct-tl-leg > span { display: inline-flex; align-items: center; gap: 4px; }
.lct-tl-leg i { display: inline-block; width: 7px; height: 7px; border-radius: 2px; }
.lct-tl-leg .sw-lit { background: var(--ds-ok); }
.lct-tl-leg .sw-off { background: rgba(187, 99, 91, .45); border: 1px solid rgba(255, 146, 138, .35); }
.lct-tl-bar {
  position: relative; height: 16px; border-radius: 5px; overflow: hidden;
  background: #12161C; border: 1px solid #29323D;
}
.lct-seg { position: absolute; top: 0; bottom: 0; border-radius: 1.5px; }
.lct-seg.lit { background: color-mix(in srgb, var(--ds-ok) 85%, transparent); }
.lct-seg.lit.today { background: var(--ds-ok-hi); }
.lct-seg.dark {
  background: rgba(187, 99, 91, .30);
  box-shadow: inset 0 0 0 1px rgba(255, 146, 138, .12);
}
.lct-tl-ahead { position: absolute; top: 0; bottom: 0; background: rgba(255, 255, 255, .04); pointer-events: none; }
.lct-tl-tick {
  position: absolute; top: 0; bottom: 0; width: 1px;
  background: rgba(255, 255, 255, .08); pointer-events: none; z-index: 1;
}
.lct-tl-nt {
  position: absolute; top: 0; bottom: 0; width: 1px;
  border-left: 1px dashed rgba(134, 179, 227, .38); pointer-events: none; z-index: 1;
}
.lct-tl-now {
  position: absolute; top: 0; bottom: 0; width: 1.5px;
  background: #F1F4F8; pointer-events: none; z-index: 3;
}
.lct-tl-axis {
  position: relative; display: flex; justify-content: space-between;
  font: 500 9.5px/1.2 var(--ds-mono); color: #8A95A5; margin-top: 3px;
}
.lct-rule {
  border-top: 1px solid #29323D; margin-top: 8px; padding-top: 6px;
  display: flex; flex-direction: column; gap: 4px;
}
.lct-wlist { display: flex; flex-wrap: wrap; gap: 4px; }
.lct-wchip {
  padding: 2px 6px; border-radius: 4px; background: #232B35; border: 1px solid #2E3844;
  font: 500 10.5px/1.3 var(--ds-mono); font-variant-numeric: tabular-nums; color: #D3DAE3;
}
.lct-wchip.more { color: #93A0AF; }
.lct-split { font: 500 10.5px/1.3 var(--ds-mono); font-variant-numeric: tabular-nums; color: #D3DAE3; }
.lct-wins { font: 400 10.5px/1.35 var(--ds-mono); font-variant-numeric: tabular-nums; color: #93A0AF; }
.lct-est, .lct-hint { font: 400 10px/1.3 var(--ds-mono); color: #8A95A5; }
/* Large centered 24-hour modal */
.lc-modal-backdrop {
  position: fixed; inset: 0; z-index: 9998;
  background: rgba(6, 8, 11, .76);
  backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
  padding: 20px; box-sizing: border-box;
}
.lc-modal-backdrop[hidden] { display: none; }
.lc-modal {
  width: min(760px, 100%); max-height: calc(100vh - 40px); overflow-y: auto;
  background: #141920; border: 1px solid #2E3844; border-radius: 14px;
  padding: 18px 20px; box-sizing: border-box;
  font-family: var(--ds-sans); color: #F1F4F8;
  box-shadow: 0 24px 64px rgba(0, 0, 0, .65), inset 0 1px 0 rgba(255, 255, 255, .04);
  display: flex; flex-direction: column; gap: 14px;
}
.lcm-hd { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 14px; }
.lcm-title-grp { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
.lcm-date { font: 600 17px/1.25 var(--ds-sans); color: #F1F4F8; }
.lcm-est { font: 400 11px/1.3 var(--ds-mono); color: #93A0AF; }
.lcm-nav { display: inline-flex; align-items: center; gap: 6px; }
.lcm-btn {
  height: 28px; padding: 0 10px; border-radius: 7px;
  border: 1px solid #2E3844; background: #0E1217; color: #D3DAE3;
  font: 500 12px/1 var(--ds-mono); cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  transition: background .12s, border-color .12s, color .12s;
}
.lcm-btn.lcm-x { width: 28px; padding: 0; font-size: 15px; }
.lcm-btn:hover:not(:disabled) { border-color: #4A5A6D; color: #F1F4F8; background: #232B35; }
.lcm-btn:disabled { opacity: .35; cursor: default; }
.lcm-btn:focus-visible { outline: 2px solid var(--ds-ok-hi); outline-offset: 2px; }
.lcm-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
@media (max-width: 560px) {
  .lcm-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
.lcm-kpi {
  background: #0E1217; border: 1px solid #232B35; border-radius: 9px; padding: 10px 12px;
  display: flex; flex-direction: column; gap: 3px;
}
.lcm-kl {
  font: 600 10px/1.2 var(--ds-mono); letter-spacing: .08em; text-transform: uppercase; color: #8A95A5;
}
.lcm-kv { font: 600 17px/1.2 var(--ds-mono); font-variant-numeric: tabular-nums; color: #F1F4F8; }
.lcm-ks { font: 500 11px/1.25 var(--ds-mono); font-variant-numeric: tabular-nums; color: #93A0AF; }
.lcm-ks.ok { color: #62D6A8; }
.lcm-ks.bad { color: #FF928A; }
.lcm-tl { display: flex; flex-direction: column; }
.lcm-tl-head {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px;
  margin-bottom: 6px;
}
.lcm-tl-title { font: 600 11px/1.2 var(--ds-mono); letter-spacing: .06em; text-transform: uppercase; color: #A9B5C3; }
.lcm-tl-leg { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 12px; font: 500 11px var(--ds-mono); color: #93A0AF; }
.lcm-tl-leg > span { display: inline-flex; align-items: center; gap: 5px; }
.lcm-tl-leg i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; }
.lcm-tl-leg .sw-lit { background: var(--ds-ok); }
.lcm-tl-leg .sw-off { background: rgba(187, 99, 91, .45); border: 1px solid rgba(255, 146, 138, .35); }
.lcm-tl-leg .sw-night { background: rgba(134, 179, 227, .22); border: 1px dashed rgba(134, 179, 227, .55); }
.lcm-tl-tariff { position: relative; height: 4px; margin-bottom: 3px; border-radius: 2px; overflow: hidden; }
.lcm-tl-tariff > span { position: absolute; top: 0; bottom: 0; background: rgba(134, 179, 227, .35); }
.lcm-tl-bar {
  position: relative; height: 44px; border-radius: 8px; overflow: hidden;
  background: #0E1217; border: 1px solid #29323D;
}
.lcm-seg {
  position: absolute; top: 0; bottom: 0; border-radius: 2px; cursor: pointer;
  display: flex; align-items: center; justify-content: center; overflow: hidden;
  transition: filter .1s;
}
.lcm-seg.lit { background: color-mix(in srgb, var(--ds-ok) 80%, transparent); }
.lcm-seg.lit.today { background: var(--ds-ok-hi); color: #0B1410; }
.lcm-seg.dark {
  background: rgba(187, 99, 91, .28);
  box-shadow: inset 0 0 0 1px rgba(255, 146, 138, .14);
}
.lcm-seg:hover { filter: brightness(1.16); }
.lcm-seg.sel { box-shadow: inset 0 0 0 2px #F1F4F8; z-index: 2; }
.lcm-seg-lbl {
  font: 600 11px/1 var(--ds-mono); font-variant-numeric: tabular-nums;
  color: #F1F4F8; pointer-events: none; white-space: nowrap; text-shadow: 0 1px 2px rgba(0, 0, 0, .45);
}
.lcm-seg.lit.today .lcm-seg-lbl { color: #091410; text-shadow: none; }
.lcm-seg.dark .lcm-seg-lbl { color: #FFD3CF; }
.lcm-tl-ahead { position: absolute; top: 0; bottom: 0; background: rgba(255, 255, 255, .04); pointer-events: none; }
.lcm-tl-tick {
  position: absolute; top: 0; bottom: 0; width: 1px;
  background: rgba(255, 255, 255, .08); pointer-events: none; z-index: 1;
}
.lcm-tl-nt {
  position: absolute; top: 0; bottom: 0; width: 1px;
  border-left: 1px dashed rgba(134, 179, 227, .45); pointer-events: none; z-index: 1;
}
.lcm-tl-now {
  position: absolute; top: 0; bottom: 0; width: 2px;
  background: #F1F4F8; pointer-events: none; z-index: 3;
}
.lcm-tl-axis {
  display: flex; justify-content: space-between; margin-top: 4px;
  font: 500 10px/1.2 var(--ds-mono); font-variant-numeric: tabular-nums; color: #8A95A5;
}
/* Fixed height prevents cursor-driven layout shifts on segment hover/click. */
.lcm-inspect {
  height: 78px; box-sizing: border-box; overflow: hidden;
  padding: 10px 12px; border-radius: 8px;
  background: #0E1217; border: 1px solid #29323D;
  display: flex; flex-direction: column; justify-content: center; gap: 4px;
}
.lcm-insp-idle { font: 500 12px/1.3 var(--ds-sans); color: #A9B5C3; }
.lcm-insp-top { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.lcm-insp-span { font: 600 13px/1.2 var(--ds-mono); font-variant-numeric: tabular-nums; color: #F1F4F8; }
.lcm-insp-ord { margin-left: auto; font: 500 11px/1.2 var(--ds-mono); color: #93A0AF; }
.lcm-insp-meta {
  display: flex; flex-wrap: wrap; gap: 2px 14px;
  font: 400 11px/1.35 var(--ds-mono); font-variant-numeric: tabular-nums; color: #93A0AF;
}
.lcm-list { display: flex; flex-direction: column; gap: 4px; }
.lcm-row {
  display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 7px;
  background: #0E1217; border: 1px solid #232B35; cursor: pointer;
  font: 500 12px/1.3 var(--ds-mono); font-variant-numeric: tabular-nums;
  transition: background .1s, border-color .1s;
}
.lcm-row:hover { background: #1A212B; border-color: #364352; }
.lcm-row.sel { background: #1E2733; border-color: #56687E; }
.lcm-row-kind { display: inline-flex; align-items: center; gap: 6px; min-width: 84px; }
.lcm-row-kind i { width: 7px; height: 7px; border-radius: 2px; }
.lcm-row.lit .lcm-row-kind { color: #62D6A8; }
.lcm-row.lit .lcm-row-kind i { background: var(--ds-ok); }
.lcm-row.dark .lcm-row-kind { color: #FF928A; }
.lcm-row.dark .lcm-row-kind i { background: var(--ds-bad); }
.lcm-row-span { color: #F1F4F8; }
.lcm-row-dur { color: #A9B5C3; margin-left: auto; }
.lcm-row-cont {
  padding: 1px 6px; border-radius: 4px; background: #232B35; color: #D3DAE3; font-size: 10.5px;
}
.lcm-empty {
  padding: 28px 16px; border-radius: 9px; background: #0E1217; border: 1px solid #232B35;
  display: flex; flex-direction: column; align-items: center; gap: 4px; text-align: center;
}
.lcm-empty strong { font: 600 15px/1.3 var(--ds-mono); color: #F1F4F8; }
.lcm-empty span { font: 400 12px/1.4 var(--ds-sans); color: #93A0AF; }
.lc-note {
  position: absolute; left: 0; right: 0; top: 0; height: ${LC_H}px;
  display: none; align-items: center; justify-content: center;
  font: 500 12px var(--ds-mono); color: var(--ds-muted); text-align: center; padding: 0 12px;
  pointer-events: none;
}
.lc-note.hourly { height: ${LC_HR_H}px; }
.lc-note.show { display: flex; }
.lc-xax { position: relative; height: 18px; margin-top: 6px; overflow: hidden; }
.lc-xax.two { height: 28px; }
.lc-xlab {
  position: absolute; top: 0; transform: translateX(-50%); text-align: center; white-space: nowrap;
  font: 500 10px/1.3 var(--ds-mono); color: var(--ds-muted);
}
.lc-xlab.today { color: var(--ds-ok-hi); }
.lc-stats {
  display: flex; flex-wrap: wrap; gap: 14px 28px;
  border-top: 1px solid var(--ds-line); padding-top: 12px;
}
.lc-stat { display: flex; flex-direction: column; gap: 3px; }
.lc-stat b {
  font: 600 10px/1.2 var(--ds-mono); letter-spacing: .1em; text-transform: uppercase; color: var(--ds-muted);
}
.lc-stat span { font: 600 15px/1.2 var(--ds-mono); font-variant-numeric: tabular-nums; color: var(--ds-text); }
.lc-stat small { font: 500 11px var(--ds-mono); color: var(--ds-muted); }
.lc-foot { font: 500 11px var(--ds-mono); color: var(--ds-muted); }
.wire { display: grid; grid-template-columns: repeat(24, minmax(0, 1fr)); gap: 2px; justify-items: center; }
.bulb { position: relative; display: flex; justify-content: center; min-width: 0; width: 100%; }
/* The grid's .on/.out/.now paint whatever carries them; on a bulb only the glass shows the state. */
.bulbwrap .bulb { background: none; box-shadow: none; }
.bulb svg { position: relative; display: block; width: 100%; max-width: 46px; height: auto; overflow: visible; }
.bulb .g { fill: url(#cb-off); stroke: #3a3f49; stroke-width: .8; }
.bulb .hl { fill: #fff; opacity: .12; }
.bulb .fil { fill: none; stroke: #5b616b; stroke-width: .7; stroke-linejoin: round; }
.bulb .cap { fill: url(#cb-metal); stroke: #4a4e55; stroke-width: .3; }
.bulb .tip { fill: #2b2d31; }
.bulb .t { font: 600 9px var(--ds-mono); fill: var(--ds-muted); }
.bulb .crack { fill: none; stroke: #cfd5de; stroke-width: .65; stroke-linejoin: miter; opacity: .8; }
/* Lit: yellow glass, a big soft halo round the globe, which hangs below the base. */
.bulb.on::before, .bulb.out-1::before, .bulb.out-2::before, .bulb.maybe-1::before, .bulb.maybe-2::before {
  content: ""; position: absolute; left: 50%; top: 70%; width: 170%; aspect-ratio: 1;
  transform: translate(-50%, -50%); pointer-events: none;
  background: radial-gradient(closest-side, rgba(255, 228, 60, .55), rgba(255, 210, 0, .16) 55%, transparent);
}
.bulb.on .g { fill: url(#cb-on); stroke: #f0c419; }
.bulb.on .hl { opacity: .7; }
.bulb.on .fil { stroke: #c79a00; }
.bulb.on .t { fill: #5a4300; }
/* Off for certain: a broken bulb, dark cracked glass, the filament a dead red. */
.bulb.out .g { stroke: color-mix(in srgb, var(--ds-bad) 55%, #3a3f49); }
.bulb.out .fil { stroke: var(--ds-bad); }
.bulb.out .t { fill: var(--ds-bad-hi); }
/* Possible outage: a dim amber glass. */
.bulb.maybe .g { fill: url(#cb-maybe); stroke: #7a5e28; }
.bulb.maybe .fil { stroke: #a8823a; }
.bulb.maybe .t { fill: var(--ds-warn-hi); }
/*
 * Power for half the hour: a dying bulb. Lit underneath; dark glass (.g2) and
 * the halo cut in and out on an irregular beat, like a horror-film light about
 * to go. steps() makes every change a jump, so the browser repaints only at
 * the cuts, not every frame. Each bulb runs on its own offset (--fd), a past
 * hour holds still, and like every loop here it stops while the card is off
 * screen. Which half of the hour has power is in the tooltip.
 */
.bulb.out-1 .g, .bulb.out-2 .g, .bulb.maybe-1 .g, .bulb.maybe-2 .g { fill: url(#cb-half); stroke: #8f7a1c; }
.bulb.out-1 .fil, .bulb.out-2 .fil, .bulb.maybe-1 .fil, .bulb.maybe-2 .fil { stroke: #7d650e; }
.bulb.out-1 .hl, .bulb.out-2 .hl, .bulb.maybe-1 .hl, .bulb.maybe-2 .hl { opacity: .35; }
.bulb.out-1 .t, .bulb.out-2 .t, .bulb.maybe-1 .t, .bulb.maybe-2 .t { fill: #fff6cf; stroke: #3a2c06; stroke-width: 1.8; paint-order: stroke; }
.bulb .g2 { fill: url(#cb-dim); stroke: #5a4b1c; stroke-width: .8; opacity: 0; animation: bulbdie 3.7s steps(1, end) infinite; animation-delay: var(--fd, 0s); }
.bulb.out-1::before, .bulb.out-2::before, .bulb.maybe-1::before, .bulb.maybe-2::before {
  animation: halodie 3.7s steps(1, end) infinite; animation-delay: var(--fd, 0s);
}
.wire .bulb:nth-child(3n+1) { --fd: -1.3s; }
.wire .bulb:nth-child(3n+2) { --fd: -2.6s; }
.wire .bulb:nth-child(4n) { --fd: -0.7s; }
@keyframes bulbdie {
  0% { opacity: 0; } 9% { opacity: 1; } 11% { opacity: 0; } 14% { opacity: .9; } 16% { opacity: 0; }
  43% { opacity: .55; } 45% { opacity: 0; }
  64% { opacity: 1; } 66% { opacity: .2; } 68% { opacity: 1; } 79% { opacity: 0; } 100% { opacity: 0; }
}
@keyframes halodie {
  0% { opacity: .27; } 9% { opacity: .02; } 11% { opacity: .27; } 14% { opacity: .04; } 16% { opacity: .27; }
  43% { opacity: .12; } 45% { opacity: .27; }
  64% { opacity: .02; } 66% { opacity: .2; } 68% { opacity: .02; } 79% { opacity: .27; } 100% { opacity: .27; }
}
.bulb.past .g2, .bulb.past::before { animation: none; }
.bulb.past .g2 { opacity: .6; }
@media (prefers-reduced-motion: reduce) {
  .bulb .g2, .bulb.out-1::before, .bulb.out-2::before, .bulb.maybe-1::before, .bulb.maybe-2::before { animation: none; }
  .bulb .g2 { opacity: .6; }
}
/* Not published: just the outline of a bulb. */
.bulb.unknown .g { fill: none; stroke: rgba(169, 181, 195, .45); stroke-dasharray: 2 2; }
.bulb.unknown .fil, .bulb.unknown .hl { display: none; }
.bulb.unknown .cap, .bulb.unknown .tip { opacity: .3; }
.bulb.past { opacity: .32; }
.bulb.now .g { stroke: var(--ds-text); stroke-width: 1.4; }
/* Where we are: a white contour round the current bulb, breathing outwards. */
.bulb .ring {
  fill: none; stroke: #fff; stroke-width: 2.2; transform-box: fill-box; transform-origin: 50% 55%;
  animation: bulbring 1.8s ease-in-out infinite;
}
@keyframes bulbring {
  0%, 100% { opacity: .95; transform: scale(1.06); }
  50% { opacity: .2; transform: scale(1.22); }
}
.bulb:hover svg { filter: brightness(1.15); }
/* The legend's bulbs. */
.bulb.mini { display: inline-flex; width: 12px; flex: 0 0 auto; }
.bulb.mini svg { width: 12px; }
.bulb.mini::before { width: 200%; }
.bulb.mini .ring { animation: none; }
@media (prefers-reduced-motion: reduce) { .bulb .ring { animation: none; transform: scale(1.08); } }
/* A phone: the day's name above, its 24 hours in two rows of 12, the hour larger. */
@container (max-width: 640px) {
  .brow { grid-template-columns: minmax(0, 1fr) auto; gap: 6px 8px; padding: 6px; }
  .blabel { flex-direction: row; align-items: baseline; gap: 8px; }
  .brow .wire { grid-column: 1 / -1; grid-template-columns: repeat(12, minmax(0, 1fr)); row-gap: 6px; }
  .brow .dtots { grid-row: 1; grid-column: 2; flex-direction: row; gap: 8px; }
  .bulb .t { font-size: 12px; }
}

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

/* --- tablet / split card: map sits cleanly below copy and clock --- */
@container (max-width: 960px) {
  .hero.has-map .pad {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas: "copy clock" "map map" "queues queues" "tiles tiles";
  }
}

/* --- narrow cards: a phone, or a column of a wide dashboard --- */
@container (max-width: 640px) {
  .hero .pad { grid-template-columns: 1fr; grid-template-areas: "clock" "copy" "tiles"; justify-items: center; }
  .hero.has-map .pad { grid-template-columns: 1fr; grid-template-areas: "clock" "copy" "map" "queues" "tiles"; justify-items: stretch; }
  .map-slot { width: 100%; }
  .q-strip { justify-content: center; }
  .hero-left { align-items: center; text-align: center; }
  .eyebrow { justify-content: center; }
  .tiles, .tiles.four { grid-template-columns: 1fr 1fr; width: 100%; }
  .tl { grid-template-columns: 1fr; gap: 4px; }
  .axis { grid-column: 1; }
  .grid { gap: 2px; }
  .hours { flex-basis: 18px; }
  .day { min-width: 0; padding: 5px 2px; }
  .dsub { font-size: 9px; }
  .lc-val { font-size: 10px; }
  .lc-stats { gap: 10px 20px; }
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
