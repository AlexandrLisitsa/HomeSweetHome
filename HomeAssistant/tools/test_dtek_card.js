/**
 * The DTEK card against the applied schedule (today / tomorrow), on a pinned
 * clock. Added after the first real stabilisation outage, 17.10.2026
 * 13:30-17:00, when the hero said "The power is on" with the window running
 * and the card never drew the day DTEK had applied.
 *
 *     node HomeAssistant/tools/test_dtek_card.js
 *
 * Exit status is 0 when everything passes, 1 otherwise.
 */

"use strict";

const { fire, loadCard, mkHass, S } = require("./fake_dom");

const FILE = "dtek-shutdowns-card.js";
const GRID = "binary_sensor.grid_down";
const TODAY = "yyyyyyyyyyyyysnnnyyyyyyy"; // 17.10.2026: 13:30-17:00 off
let failed = 0;
let passed = 0;

function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++;
  else {
    failed++;
    console.log("  FAIL " + label + ": " + JSON.stringify(got) + "  want " + JSON.stringify(want));
  }
}

/** A Date whose "now" is pinned to a local wall-clock time on 17.10.2026. */
function pinnedDate(hh, mm) {
  const fixed = new Date(2026, 9, 17, hh, mm).getTime();
  return class extends Date {
    constructor(...args) { if (args.length) super(...args); else super(fixed); }
    static now() { return fixed; }
  };
}

function render(at, attrs, opts) {
  opts = opts || {};
  const [hh, mm] = at.split(":").map(Number);
  const L = loadCard(FILE, { Date: pinnedDate(hh, mm) });
  const card = new L.Card();
  // The checks below were written against the bars; the bulbs have their own section.
  card.setConfig(Object.assign({ blocks: opts.blocks || ["hero", "days"], week_style: "grid" },
    opts.config || {}));
  const asked = [];
  card.hass = mkHass(Object.assign({
    "sensor.dtek_shutdowns": S("ok", Object.assign({
      queue: "1.1", outage_active: false, schedule_in_effect: true,
      schedule_update: "17.10.2026 10:41", today: TODAY, tomorrow: null,
      week: null, week_in_effect: false, hidden_reason: "plan_off",
      fetched_at: new Date(2026, 9, 17, hh, mm).toISOString(),
    }, attrs || {})),
    [GRID]: S(opts.gridDown ? "on" : "off"),
    "binary_sensor.grid_outage_unscheduled": S("off"),
    "binary_sensor.dtek_data_stale": S("off"),
  }, opts.states || {}), {
    // The timeline's one recorder request; `history` is its answer, or an Error.
    callWS: (msg) => {
      asked.push(msg);
      if (opts.history instanceof Error) return Promise.reject(opts.history);
      return Promise.resolve(opts.history || {});
    },
  });
  const root = card.shadowRoot;
  const text = (sel) => {
    const el = root.querySelector(sel);
    return el ? el.textContent : null;
  };
  const tile = (k) => {
    const t = root.querySelectorAll(".tile").find((x) => x.querySelector(".k").textContent === k);
    return t ? [t.querySelector(".v").textContent, t.querySelector(".s").textContent] : null;
  };
  return { root, text, tile, card, L, asked, get wrap() { return root.querySelector(".wrap"); } };
}

/** Lets the card's history request answer and redraw. */
const settle = () => new Promise((resolve) => setImmediate(resolve));
/** Epoch seconds of a wall-clock time on the pinned day, as minimal_response sends `lu`. */
const lu = (hh, mm) => new Date(2026, 9, 17, hh, mm || 0).getTime() / 1000;

console.log("hero inside a scheduled window, mains present");
let r = render("13:39");
eq("headline", r.text("h1"), "Scheduled outage until 17:00.");
eq("lede", r.text(".lede"), "DTEK's schedule for (1.1) has 13:30–17:00 off. The inverter still sees mains.");
eq("amber, not green", r.wrap.classList.contains("k-warn"), true);
eq("next window tile is the running one", r.tile("Next window"), ["13:30–17:00", "now, ends in 3h 21m"]);

console.log("hero inside the window, mains gone");
r = render("13:45", {}, { gridDown: true });
eq("headline", r.text("h1"), "The power is off.");
eq("lede names the end", r.text(".lede"),
  "The inverter sees no mains, as DTEK's schedule for (1.1) has it: off 13:30–17:00, back by 17:00 (in 3h 15m).");

console.log("the first half of 13:00 is lit");
r = render("13:10", { next_outage_start: new Date(2026, 9, 17, 13, 30).toISOString(),
                      next_outage_end: new Date(2026, 9, 17, 17, 0).toISOString() });
eq("headline", r.text("h1"), "The power is on.");
eq("next window", r.tile("Next window")[0], "13:30–17:00");

console.log("after the window");
r = render("17:00");
eq("headline", r.text("h1"), "The power is on.");

console.log("a window across midnight");
r = render("23:40", { today: "yyyyyyyyyyyyyyyyyyyyyynnn".slice(0, 24), tomorrow: "nnyyyyyyyyyyyyyyyyyyyyyy" });
eq("headline: plain end time, no +1", r.text("h1"), "Scheduled outage until 02:00.");
r = render("23:40", { today: "yyyyyyyyyyyyyyyyyyyyyynn", tomorrow: null }, { gridDown: true });
eq("tomorrow unpublished: no false end time", r.text(".lede"),
  "The inverter sees no mains, as DTEK's schedule for (1.1) has it: off 22:00–00:00, back by midnight unless tomorrow's table extends it.");

// 05.11.2026, queue 1.1: dark 19:30 to midnight, tomorrow lit until 06:00.
r = render("22:56", { today: "nnfyyyyyynnnnyyyyyysnnnn", tomorrow: "yyyyyynnnnnnnfyysnnnfyyy" });
eq("a window ending at midnight: no +1", r.tile("Next window"), ["19:30–00:00", "now, ends in 1h 4m"]);

console.log("possible outage hours");
r = render("10:15", { today: "yyyyyyyyyymmyyyyyyyyyyyy" });
eq("hedged wording", r.text(".lede"), "DTEK's schedule for (1.1) has 10:00–12:00 as a possible outage. The inverter still sees mains.");

console.log("the announcement banner (01.11.2026)");
const EMERG = "binary_sensor.dtek_emergency_shutdowns";
const BANNER = {
  banner_title: "Шановні клієнти!", banner_scope: "city", banner_emergency: true,
  banner_text: "За рішенням Укренерго запроваджено екстрені відключення по місту Дніпро.\n"
    + "Якщо у вашій оселі є світло – споживайте його свідомо та ощадливо.",
  banner_checked_at: new Date(2026, 9, 17, 10, 0).toISOString(),
};
const noSched = { today: null, schedule_in_effect: false };
r = render("10:00", Object.assign({}, noSched, BANNER), { states: { [EMERG]: S("on") } });
eq("red strip with DTEK's text", [r.root.querySelector(".banner").getAttribute("class"),
  r.root.querySelectorAll(".banner p").length], ["banner emerg", 2]);
eq("labelled as Ukrenergo's", r.text(".banner .k"), "Ukrenergo emergency outages");
eq("mains up: amber, not green", [r.wrap.classList.contains("k-warn"), r.text(".pill .lbl")],
  [true, "Emergency outages"]);
eq("lede says it can go any time", /can go at any time/.test(r.text(".lede")), true);
eq("next window: schedules don't apply", r.tile("Next window")[1], "schedules don't apply now");
{
  const ring = r.root.querySelectorAll(".arc").map((a) => a.getAttribute("class"));
  eq("the ring is amber, the past dimmed", [ring.length, ring.every((c) => /^arc maybe( past)?$/.test(c)),
    ring.filter((c) => / past$/.test(c)).length], [48, true, 20]);
  eq("the centre names it", r.root.querySelector(".ctr .small").textContent, "emergency outages");
}
r = render("13:39", Object.assign({}, BANNER), { states: { [EMERG]: S("on") } });
eq("a window DTEK has off stays red inside the amber",
  r.root.querySelectorAll(".arc").map((a) => a.getAttribute("class")).filter((c) => /out/.test(c)).length, 7);
{
  const hour = (i) => r.root.querySelectorAll(".arc")[i].getAttribute("data-tip").split("\n")[0];
  eq("...its tooltip names the schedule and the emergency", [
    /Ukrenergo emergency outages too$/.test(hour(28)), /^14:00–15:00 — /.test(hour(28)),
    hour(20)], [true, true, "10:00–11:00 — possible outage, Ukrenergo emergency outages"]);
}

r = render("10:00", Object.assign({}, noSched, BANNER),
  { gridDown: true, states: { [EMERG]: S("on"), "binary_sensor.grid_outage_unscheduled": S("on") } });
eq("mains gone: announced, so not 'not announced'", r.text(".pill .lbl"), "Power off");
eq("...and the lede says why", /Ukrenergo has emergency outages/.test(r.text(".lede")), true);

// The attribute alone never turns the page red: the entity is the debounced,
// freshness-checked verdict, and while it is off or unavailable the text is a
// plain note.
for (const st of ["off", "unavailable"]) {
  r = render("10:00", Object.assign({}, noSched, BANNER), { states: { [EMERG]: S(st) } });
  eq("entity " + st + ": grey note, page stays green",
    [r.root.querySelector(".banner").getAttribute("class"), r.text(".banner .k"),
      r.wrap.classList.contains("k-ok")], ["banner", "DTEK announcement", true]);
}
r = render("10:00", Object.assign({}, noSched, BANNER, { banner_scope: "other", banner_emergency: false }),
  { states: { [EMERG]: S("off") } });
eq("a notice about elsewhere says so", r.text(".banner .k"), "DTEK announcement · not for this area");
r = render("10:00", noSched, { states: { [EMERG]: S("off") } });
eq("no banner: no strip", r.root.querySelector(".banner"), null);

// 03.11.2026: the page GET 403'd from 06:55 and the morning "екстрені" text
// stayed up under a popup that said "стабілізаційні". Past 20 minutes the card
// hides the banner altogether.
const OLD = Object.assign({}, BANNER, { banner_emergency: true, banner_error: "HTTPError: HTTP Error 403: Forbidden" });
r = render("10:15", Object.assign({}, noSched, OLD), { states: { [EMERG]: S("unavailable") } });
eq("15 min old: still shown", [r.root.querySelector(".banner").getAttribute("class"),
  r.text(".banner .k")], ["banner", "DTEK announcement"]);
r = render("10:25", Object.assign({}, noSched, OLD), { states: { [EMERG]: S("unavailable") } });
eq("25 min old: no banner", r.root.querySelector(".banner"), null);
eq("...and the page stays green", r.wrap.classList.contains("k-ok"), true);
r = render("12:15", Object.assign({}, noSched, OLD, { banner_checked_at: null }), { states: { [EMERG]: S("unavailable") } });
eq("never read: no banner", r.root.querySelector(".banner"), null);

console.log("debug_banner, for the Playground");
r = render("10:00", noSched, { config: { debug_banner: "emergency" } });
eq("emergency sample, entity ignored", [r.text(".banner .k"), r.text(".pill .lbl")],
  ["Ukrenergo emergency outages", "Emergency outages"]);
r = render("10:00", noSched, { config: { debug_banner: "notice" } });
eq("country-wide sample stays grey", r.root.querySelector(".banner").getAttribute("class"), "banner");
r = render("10:00", Object.assign({}, noSched, BANNER), { config: { debug_banner: "none" }, states: { [EMERG]: S("on") } });
eq("none hides a live one", [r.root.querySelector(".banner"), r.text(".pill .lbl")], [null, "Power on"]);
r = render("10:00", noSched, { config: { debug_banner: "pending" } });
eq("pending: the text, grey, while the entity debounces",
  [r.root.querySelector(".banner").getAttribute("class"), r.text(".banner .k")],
  ["banner", "DTEK announcement"]);

console.log("emergency from YASNO, with no fresh popup");
const YAS = { queue: "3.2", yasno_emergency: true, yasno_status_today: "EmergencyShutdowns",
  yasno_checked_at: new Date(2026, 9, 17, 10, 0).toISOString() };
r = render("10:05", Object.assign({}, noSched, YAS), { states: { [EMERG]: S("on") } });
eq("red strip naming YASNO and the queue",
  [r.root.querySelector(".banner").getAttribute("class"), r.text(".banner .k"), r.text(".banner p")],
  ["banner emerg", "Ukrenergo emergency outages · YASNO",
    "YASNO marks queue 3.2 as under emergency outages: no schedule applies, no end time."]);
eq("its tooltip explains YASNO's status",
  r.root.querySelector(".banner").getAttribute("data-tip").split("\n")[1].startsWith("YASNO's public"), true);
// The 03.11.2026 case: the morning's "екстрені" banner stuck in the cache for
// days. YASNO turning the entity on must not bring that text back as current.
r = render("10:05", Object.assign({}, noSched, BANNER, YAS,
  { banner_checked_at: new Date(2026, 9, 15, 7, 0).toISOString() }), { states: { [EMERG]: S("on") } });
eq("a days-old banner is not quoted", r.text(".banner p"),
  "YASNO marks queue 3.2 as under emergency outages: no schedule applies, no end time.");
r = render("10:05", Object.assign({}, noSched, BANNER, YAS), { states: { [EMERG]: S("on") } });
eq("a fresh banner still wins: DTEK's own words", r.text(".banner .k"), "Ukrenergo emergency outages");
r = render("10:05", Object.assign({}, noSched, YAS), { states: { [EMERG]: S("off") } });
eq("entity off (delay_on): no strip", r.root.querySelector(".banner"), null);
r = render("10:00", noSched, { config: { debug_banner: "yasno" } });
eq("debug_banner yasno", [r.text(".banner .k"), r.text(".pill .lbl")],
  ["Ukrenergo emergency outages · YASNO", "Emergency outages"]);

console.log("the Playground's switches: the mock read from entities");
const PB = "input_select.playground_dtek_banner";
const PS = "input_select.playground_dtek_power";
const pg = { debug_banner_entity: PB, debug_state_entity: PS };
r = render("10:00", noSched, { config: pg, states: { [PB]: S("emergency"), [PS]: S("unscheduled") } });
eq("both switches drive the page", [r.text(".banner .k"), r.text(".pill .lbl")],
  ["Ukrenergo emergency outages", "Power off"]);
r = render("10:00", Object.assign({}, noSched, BANNER),
  { config: pg, states: { [PB]: S("live"), [PS]: S("live"), [EMERG]: S("on") } });
eq("live on both: the real data", [r.text(".banner .k"), r.text(".pill .lbl")],
  ["Ukrenergo emergency outages", "Emergency outages"]);
r = render("10:00", noSched, { config: Object.assign({ debug_banner: "notice" }, pg),
  states: { [PB]: S("live"), [PS]: S("live") } });
eq("an entity set to live overrides a static debug_banner", r.root.querySelector(".banner"), null);
r = render("10:00", noSched, { config: pg });
eq("switch entities missing: the real data, no error", r.text(".pill .lbl"), "Power on");

{
  const L = loadCard(FILE, {});
  let err = null;
  try { new L.Card().setConfig({ debug_banner: "loud" }); } catch (e) { err = e.message; }
  eq("unknown debug_banner refused", /debug_banner must be one of/.test(err || ""), true);
}

console.log("the days block");
r = render("13:39");
const cols = r.root.querySelectorAll(".days .day");
eq("two columns", cols.map((c) => c.querySelector(".dname").textContent), ["Today", "Tomorrow"]);
eq("dates under them", cols.map((c) => c.querySelector(".dsub").textContent), ["17.10", "18.10"]);
eq("24 cells each", cols.map((c) => c.querySelectorAll(".c").length), [24, 24]);
eq("today's total", cols[0].querySelector(".dtot").textContent, "3.5h");
eq("tomorrow unpublished", cols[1].querySelector(".dtot").textContent, "—");
const cls = (i) => cols[0].querySelectorAll(".c")[i].getAttribute("class");
eq("13:00 is the split, and now", cls(13), "c out-2 now");
eq("14:00 is out", cls(14), "c out");
eq("12:00 is on, and past", cls(12), "c on past");
eq("tomorrow is hatched", cols[1].querySelectorAll(".c")[0].getAttribute("class"), "c unknown");
r = render("13:39", { schedule_in_effect: false, today: null });
eq("no schedule in force: one sentence", r.text(".days .note"),
  "No stabilisation schedule is in force, so DTEK has applied nothing to today or tomorrow.");
eq("... and a green hero", r.text("h1"), "The power is on.");

console.log("an emergency outage on the clock (29.10.2026: no schedule, notice 13:50-17:54)");
{
  const at = (hh, mm) => new Date(2026, 9, 17, hh, mm).toISOString();
  const notice = (extra) => Object.assign({
    schedule_in_effect: false, today: null, outage_active: true, outage_type: 2,
    outage_reason: "Аварійні ремонтні роботи", outage_start: at(13, 50), outage_end: at(17, 54),
  }, extra);
  const ctr = (x) => x.root.querySelectorAll(".ctr text").map((t) => t.textContent);
  const emerg = (x) => x.root.querySelectorAll(".arc.emerg").map((p) => p.getAttribute("class"));
  let x = render("14:08", notice(), { gridDown: true, blocks: ["hero"] });
  eq("centre counts down to DTEK's end", ctr(x), ["3h 46m", "until back"]);
  eq("the span is on the ring, gone-by part dim", emerg(x), ["arc emerg past", "arc emerg"]);
  eq("... with the notice in its tooltip",
    /Аварійні ремонтні роботи, 13:50–17:54/.test(x.root.querySelector(".arc.emerg").getAttribute("data-tip")), true);
  x = render("14:08", notice(), { blocks: ["hero"] });
  eq("mains still there: until it ends", ctr(x), ["3h 46m", "until it ends"]);
  x = render("18:20", notice(), { gridDown: true, blocks: ["hero"] });
  eq("past DTEK's end: overdue", ctr(x), ["26m", "overdue"]);
  eq("... and the whole span is past", emerg(x), ["arc emerg past"]);
  x = render("14:08", notice({ outage_end: null }), { gridDown: true, blocks: ["hero"] });
  eq("no end time: the old OFF", ctr(x), ["OFF", "no mains"]);
  eq("... and the span runs to the hand", emerg(x), ["arc emerg past"]);
  x = render("14:08", notice({ outage_start: new Date(2026, 9, 16, 22, 0).toISOString() }),
    { gridDown: true, blocks: ["hero"] });
  eq("started yesterday: the ring starts at midnight, 14 h past in two halves", emerg(x),
    ["arc emerg past", "arc emerg past", "arc emerg"]);
  eq("... drawn from the top of the ring",
    /^M 120\.00 16\.00 /.test(x.root.querySelector(".arc.emerg").getAttribute("d")), true);
  x = render("22:45", notice({ outage_start: at(21, 19), outage_end: new Date(2026, 9, 18, 1, 19).toISOString() }),
    { gridDown: true, blocks: ["hero"] });
  eq("ends after midnight: centre counts to 01:19", ctr(x), ["2h 34m", "until back"]);
  eq("... and the span runs on past the top", emerg(x), ["arc emerg past", "arc emerg"]);
  const tail = x.root.querySelectorAll(".arc.emerg")[1].getAttribute("d").match(/A 104 104 0 0 1 ([\d.]+) ([\d.]+)/);
  eq("... ending at 01:19, right of the top", [Number(tail[1]) > 150, Number(tail[2]) < 30], [true, true]);
  x = render("14:08", notice({ outage_active: false }), { gridDown: true, blocks: ["hero"] });
  eq("no notice: no span", emerg(x), []);
}

console.log("debug_state on overrides the schedule");
{
  const L = loadCard(FILE, { Date: pinnedDate(13, 39) });
  const card = new L.Card();
  card.setConfig({ blocks: ["hero"], debug_state: "on" });
  card.hass = mkHass({
    "sensor.dtek_shutdowns": S("ok", { queue: "1.1", schedule_in_effect: true, today: TODAY }),
    [GRID]: S("off"),
  });
  eq("headline", card.shadowRoot.querySelector("h1").textContent, "The power is on.");
}

console.log("the week: what DTEK applied wins today's and tomorrow's columns");
const WEEK = Array(7).fill("yyyyyyyyyyyyyyyyyyyyyyyy");
WEEK[4] = "nnnnnnnnnnnnyyyyyyyyyyyy"; // Friday the 16th: 12 h off
{
  const wk = (attrs) => {
    const x = render("13:39", Object.assign({ week: WEEK, week_in_effect: true, hidden_reason: null }, attrs),
      { blocks: ["week"] });
    return { x, cols: x.root.querySelectorAll(".week .day") };
  };
  // 17.10.2026 is a Saturday: column 5 is today, 6 tomorrow.
  let { x, cols } = wk({ tomorrow: "nnyyyyyyyyyyyyyyyyyyyyyy" });
  eq("seven columns", cols.length, 7);
  eq("today's column is the applied row", cols[5].querySelectorAll(".c")[14].getAttribute("class"), "c out");
  eq("... and says so", /applied schedule/.test(cols[5].querySelectorAll(".c")[14].getAttribute("data-tip")), true);
  eq("tomorrow's too", cols[6].querySelectorAll(".c")[0].getAttribute("class"), "c out");
  eq("both marked applied", [cols[5], cols[6]].map((c) => c.classList.contains("applied")), [true, true]);
  eq("a recurring column is not", cols[4].classList.contains("applied"), false);
  eq("12 h off is heavy", cols[4].querySelector(".dtot").classList.contains("heavy"), true);
  eq("3.5 h is not", cols[5].querySelector(".dtot").classList.contains("heavy"), false);
  eq("the blurb says the two columns are applied", /applied to them/.test(x.text(".blurb")), true);
  ({ x, cols } = wk({ tomorrow: null }));
  eq("tomorrow unpublished: the recurring row", cols[6].classList.contains("applied"), false);
  ({ x, cols } = wk({ schedule_in_effect: false }));
  eq("no schedule in force: today is the recurring row", cols[5].classList.contains("applied"), false);
  x = render("13:39", { week: WEEK, week_in_effect: false, hidden_reason: "plan_off" }, { blocks: ["week"] });
  eq("table withdrawn, schedule applied: just today and tomorrow",
    x.root.querySelectorAll(".week .day").map((c) => c.querySelector(".dname").textContent), ["Today", "Tomorrow"]);
  x = render("13:39", { week: null, schedule_in_effect: false, today: null }, { blocks: ["week"] });
  eq("nothing at all: the note alone", [x.root.querySelectorAll(".day").length, !!x.text(".note")], [0, true]);
}

console.log("the bulbs: a row of 24 per day, the hour on the glass");
{
  // The default look: no week_style at all.
  const bulbs = (attrs, config) => render("13:39", Object.assign({}, attrs),
    { blocks: ["week"], config: Object.assign({ week_style: undefined }, config || {}) });
  let x = bulbs({ week: WEEK, week_in_effect: false, hidden_reason: "plan_off" });
  const rows = x.root.querySelectorAll(".week .brow");
  eq("bulbs by default, no bars", [rows.length > 0, x.root.querySelectorAll(".week .c").length], [true, 0]);
  eq("two rows: today and tomorrow", rows.map((b) => b.querySelector(".dname").textContent), ["Today", "Tomorrow"]);
  eq("24 drawn bulbs each", rows.map((b) => b.querySelectorAll(".bulb svg").length), [24, 24]);
  eq("the hour on every glass", rows[0].querySelectorAll(".t").map((t) => t.textContent).join(" "),
    Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0")).join(" "));
  const bc = (i) => rows[0].querySelectorAll(".bulb")[i].getAttribute("class");
  eq("13:00 is half lit, and now", bc(13), "bulb out-2 now");
  eq("14:00 is dark", bc(14), "bulb out");
  eq("12:00 is lit, and past", bc(12), "bulb on past");
  eq("tomorrow is an empty outline", rows[1].querySelectorAll(".bulb")[0].getAttribute("class"), "bulb unknown");
  eq("today's total", rows[0].querySelector(".dtot").textContent, "3.5h");
  eq("the pulsing ring is on the current bulb only",
    rows[0].querySelectorAll(".bulb").map((b, i) => (b.querySelector(".ring") ? i : -1)).filter((i) => i >= 0), [13]);
  eq("... and tomorrow has none", rows[1].querySelectorAll(".ring").length, 0);
  eq("cracked glass on the outage hours only (14:00-16:59)",
    rows[0].querySelectorAll(".bulb").map((b, i) => (b.querySelector(".crack") ? i : -1)).filter((i) => i >= 0),
    [14, 15, 16]);
  eq("the flickering glass on the half-hour bulb only (13:00)",
    rows[0].querySelectorAll(".bulb").map((b, i) => (b.querySelector(".g2") ? i : -1)).filter((i) => i >= 0), [13]);
  eq("the bulb hangs: drawn upright, turned over, hour outside the turn",
    [rows[0].querySelector(".bulb svg g").getAttribute("transform"),
     String(rows[0].querySelector(".bulb .t").parentNode.tagName).toLowerCase()], ["rotate(180 20 32)", "svg"]);
  eq("the legend's outage bulb is cracked too",
    x.root.querySelectorAll(".legend .bulb.mini").map((b) => !!b.querySelector(".crack")),
    [false, true, false, false, false, false]);
  eq("the legend draws bulbs without hours", [x.root.querySelectorAll(".legend .bulb.mini svg").length,
    x.root.querySelectorAll(".legend .t").length], [6, 0]);
  x = bulbs({ week: WEEK, week_in_effect: true, hidden_reason: null });
  eq("a live table: seven rows", x.root.querySelectorAll(".week .brow").length, 7);
  x = render("13:39", {}, { blocks: ["days"], config: { week_style: undefined } });
  eq("the days block draws bulbs too", x.root.querySelectorAll(".days .brow").length, 2);
  x = bulbs({ week: WEEK, week_in_effect: true, hidden_reason: null }, { week_style: "grid" });
  eq("week_style grid: the bars", [x.root.querySelectorAll(".brow").length, x.root.querySelectorAll(".week .day").length], [0, 7]);

  const L = loadCard(FILE, {});
  let err = null;
  try { new L.Card().setConfig({ week_style: "neon" }); } catch (e) { err = e.message; }
  eq("unknown week_style refused", /week_style must be one of classic, grid/.test(err || ""), true);
}

console.log("the hero: pill, glow and clock");
r = render("13:39");
eq("in the window: amber pill", [r.text(".pill .lbl"), r.wrap.classList.contains("k-warn")], ["Scheduled outage", true]);
eq("48 half-hour arcs", r.root.querySelectorAll(".arc").length, 48);
const arcs = (x) => r.root.querySelectorAll(".arc").map((a) => a.getAttribute("class"));
eq("13:00-13:30 on and past", arcs()[26], "arc on past");
eq("13:30-14:00 off, running now", arcs()[27], "arc out");
eq("14:00 off, still ahead", arcs()[28], "arc out");
eq("the arc names the source", /applied schedule/.test(r.root.querySelectorAll(".arc")[28].getAttribute("data-tip")), true);
eq("the centre counts down to the end", [r.text(".ctr .big"), r.text(".ctr .small")], ["3h 21m", "until it ends"]);
r = render("12:50", { next_outage_start: new Date(2026, 9, 17, 13, 30).toISOString(),
                      next_outage_end: new Date(2026, 9, 17, 17, 0).toISOString() });
eq("40 min before: amber, outage soon", [r.text(".pill .lbl"), r.wrap.classList.contains("k-warn")], ["Outage soon", true]);
eq("... headline still says on", r.text("h1"), "The power is on.");
eq("... the centre counts to it", [r.text(".ctr .big"), r.text(".ctr .small")], ["40m", "to outage"]);
r = render("10:00", { next_outage_start: new Date(2026, 9, 17, 13, 30).toISOString(),
                      next_outage_end: new Date(2026, 9, 17, 17, 0).toISOString() });
eq("3.5 h before: green", [r.text(".pill .lbl"), r.wrap.classList.contains("k-ok")], ["Power on", true]);
r = render("13:45", {}, { gridDown: true });
eq("mains gone: red", [r.text(".pill .lbl"), r.wrap.classList.contains("k-bad")], ["Power off", true]);
r = render("11:00", { schedule_in_effect: false, today: null, week: null, hidden_reason: "plan_off" },
  { states: { [GRID]: S("on"), "binary_sensor.grid_outage_unscheduled": S("on") } });
eq("nobody said so: says it", [r.text(".pill .lbl"), r.text(".ctr .big"), r.text(".ctr .small")],
  ["Off · not announced", "OFF", "not announced"]);
r = render("11:00", { schedule_in_effect: false, today: null, week: null, hidden_reason: "plan_off" });
eq("no schedule: grey ring, ON", [arcs().every((c) => /^arc none/.test(c)), r.text(".ctr .big"), r.text(".ctr .small")],
  [true, "ON", "no schedule"]);

console.log("readable under any HA theme");
{
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "config", "www", FILE), "utf8");
  const style = src.slice(src.indexOf("const STYLE = `"));
  const host = /:host \{([^}]*)\}/.exec(style)[1];
  const hex = (name) => {
    const m = new RegExp("--ds-" + name + ":\\s*#([0-9a-f]{6});").exec(host);
    return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  };
  const lum = (c) => c.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
    .reduce((t, v, i) => t + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const [x, y] = [lum(hex(a)), lum(hex(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const fg of ["text", "text2", "muted", "ok-hi", "warn-hi", "bad-hi", "link"]) {
    for (const bg of ["panel", "inner"]) {
      const v = ratio(fg, bg);
      if (v >= 4.5) passed++;
      else { failed++; console.log("  FAIL --ds-" + fg + " on --ds-" + bg + ": " + v.toFixed(2) + ":1"); }
    }
  }
  eq("no theme text colour in the styles", /--(primary|secondary|disabled)-text-color/.test(style), false);
  eq("the panels are the card's own", /ha-card \{[^}]*background: var\(--ds-panel\)/.test(style), true);
}

console.log("old configs still draw");
r = render("13:39", {}, { blocks: ["days"] });
eq("[days]: the two columns", r.root.querySelectorAll(".days .day").length, 2);
r = render("13:39", { week: WEEK, week_in_effect: true }, { blocks: ["hero", "days", "week"] });
eq("[hero, days, week]: all three", [!!r.root.querySelector(".hero"), r.root.querySelectorAll(".days .day").length,
  r.root.querySelectorAll(".week .day").length - r.root.querySelectorAll(".days .day").length], [true, 2, 7]);

(async () => {
  console.log("the timeline: four rows, the past from the recorder");
  const OUT = "binary_sensor.dtek_outage_now";
  const SCHED = "binary_sensor.dtek_scheduled_dark";
  const UNS = "binary_sensor.grid_outage_unscheduled";
  const history = {
    [GRID]: [{ s: "off", lu: lu(0) }, { s: "on", lu: lu(9) }, { s: "off", lu: lu(10, 30) }],
    [OUT]: [{ s: "off", lu: lu(0) }],
    [SCHED]: [{ s: "off", lu: lu(0) }],
    [UNS]: [{ s: "off", lu: lu(0) }, { s: "on", lu: lu(9) }, { s: "off", lu: lu(10, 30) }],
  };
  let t = render("13:39", {}, { blocks: ["timeline"], history });
  eq("one request, for the four, since midnight", [t.asked.length, t.asked[0] && t.asked[0].entity_ids,
    t.asked[0] && t.asked[0].start_time], [1, [GRID, OUT, SCHED, UNS], new Date(2026, 9, 17).toISOString()]);
  eq("loading: says so", /Loading/.test(t.text(".timeline .note")), true);
  await settle();
  const rows = () => t.root.querySelectorAll(".timeline .bar");
  const blocks = (i) => rows()[i].querySelectorAll(".blk").map((b) => [b.getAttribute("class"),
    b.getAttribute("style"), b.getAttribute("data-tip").split("\n")[0]]);
  eq("four rows", rows().length, 4);
  eq("answered: no note", t.text(".timeline .note"), null);
  eq("grid down 09:00-10:30", blocks(0).map((b) => b[2]), ["Grid down — 09:00–10:30, 1h 30m"]);
  eq("... placed on the day", blocks(0)[0][1], "left:37.500%;width:6.250%");
  eq("DTEK quiet: empty row", blocks(1).length, 0);
  eq("unscheduled in amber", blocks(3).map((b) => b[0]), ["blk warn"]);
  eq("the schedule's rest of today, from the row", blocks(2).map((b) => b[2]),
    ["On the schedule — 13:39–17:00, 3h 21m"]);
  t.card.hass = t.card._hass; // the same states again
  eq("same states, inside 5 min: no second request", t.asked.length, 1);
  {
    const opened = [];
    t.card.addEventListener("hass-more-info", (e) => opened.push(e.detail.entityId));
    t.root.querySelectorAll(".tlname").forEach((el) => fire(el, "click"));
    eq("a row's name opens its sensor's dialog", opened, [GRID, OUT, SCHED, UNS]);
    opened.length = 0;
    fire(rows()[2], "keydown", { key: "Enter" });
    fire(rows()[1].querySelector(".nowline"), "click");
    eq("Enter on a bar, and a click inside one, too", opened, [SCHED, OUT]);
  }

  t = render("13:39", {}, { blocks: ["timeline"], history: new Error("recorder busy") });
  await settle();
  eq("no history: says so, still draws the schedule",
    [/unavailable \(recorder busy\)/.test(t.text(".timeline .note")), rows().length, blocks(2).length], [true, 4, 2]);
  eq("... the schedule's past is drawn dim", blocks(2)[0][0], "blk out past");

  t = render("13:39", {}, { blocks: ["timeline"], history });
  t.card.setAttribute("paused", "");
  t.card._hist = null;
  t.card._fingerprint = null;
  t.card._render();
  eq("hidden: asks nothing", t.asked.length, 1);

  console.log("hours of light, measured at the meter");
  const LIGHT = "sensor.grid_light_today";
  const lit = (v) => ({ [LIGHT]: S(v) });
  let l = render("18:00", {}, { blocks: ["hero"], states: lit("14.3333") });
  eq("hero tile, green", [l.tile("Light today"), /ok-hi/.test(l.root.querySelectorAll(".tile")[0].innerHTML)],
    [["14h 20m", "since 00:00, at the meter"], true]);
  eq("four tiles", l.root.querySelector(".tiles").getAttribute("class"), "tiles four");
  eq("the hero alone asks the recorder nothing", l.asked.length, 0);
  l = render("18:00", {}, { blocks: ["hero"], states: lit("unavailable") });
  eq("meter offline: a dash, and why", l.tile("Light today"), ["—", "the meter has no answer"]);
  l = render("18:00", {}, { blocks: ["hero"] });
  eq("no light sensor (the friend's bundle): no tile", [l.tile("Light today"),
    l.root.querySelector(".tiles").getAttribute("class")], [null, "tiles"]);
  l = render("18:00", {}, { blocks: ["hero"], states: lit("3"), config: { light_entity: null } });
  eq("light_entity: null: no tile", l.tile("Light today"), null);

  // Saturday 17.10.2026: hourly min/max/mean statistics with midnight carry-over
  // in 00:00, cross-midnight outage 15.10->16.10, today live, Sunday ahead.
  const weekAttrs = { week: Array(7).fill("y".repeat(18) + "nnnnnn"), week_in_effect: true,
                      schedule_in_effect: false, today: null };
  const hr = (d, h, min, max, mean) => ({ start: new Date(2026, 9, d, h).getTime(), min, max, mean });
  const pushSpan = (arr, d, h0, h1, base) => {
    for (let h = h0; h <= h1; h++) arr.push(hr(d, h, base + (h - h0), base + (h - h0) + 1, base + (h - h0) + 0.5));
  };
  const statRows = [
    // Th 08.10: pre-14.11 backfilled midpoint mean on hour 12 next to full 13..22 -> snaps to 12:30-23:00.
    hr(8, 12, 0, 0.5, 0.25),
  ];
  pushSpan(statRows, 8, 13, 22, 0.5);
  statRows.push(hr(8, 23, 10.5, 10.5, 10.5));
  // Mo 12.10: 00:00-20:30 (20h30)
  pushSpan(statRows, 12, 0, 19, 0);
  statRows.push(hr(12, 20, 20, 20.5, 20.375), hr(12, 23, 20.5, 20.5, 20.5));
  // Tu 13.10: 00:00 carries Mo's 20.5; the real day has 0h00.
  statRows.push(hr(13, 0, 0, 20.5, 0.2), hr(13, 1, 0, 0, 0), hr(13, 23, 0, 0, 0));
  // We 14.10: all light fell inside 00:00-00:45; 00:00 carries 17.0, 01:00+ holds 0.75.
  statRows.push(hr(14, 0, 0, 17.0, 0.5), hr(14, 1, 0.75, 0.75, 0.75),
                { start: new Date(2026, 9, 14, 23).toISOString(), min: 0.75, max: 0.75, mean: 0.75 });
  // Th 15.10: 00:00-17:01 (17h01), leaving 17:01-24:00 dark into 16.10.
  pushSpan(statRows, 15, 0, 16, 0);
  statRows.push(hr(15, 17, 17, 17.0167, 17.0165), hr(15, 23, 17.0167, 17.0167, 17.0167));
  // Fr 16.10: 00:00 carries Th's 17.0167; the real day was lit 18:48-22:36 (3h48).
  statRows.push(hr(16, 0, 0, 17.0167, 0.2), hr(16, 1, 0, 0, 0),
                hr(16, 18, 0, 0.2, 0.02));
  pushSpan(statRows, 16, 19, 21, 0.2);
  statRows.push(hr(16, 22, 3.2, 3.8, 3.62), hr(16, 23, 3.8, 3.8, 3.8));
  // Sa 17.10 (today at 18:00): 00:00 carries Fr's 3.8; lit 03:40-18:00 (14h20).
  statRows.push(hr(17, 0, 0, 3.8, 0.1), hr(17, 1, 0, 0, 0), hr(17, 3, 0, 0.3333, 0.0555));
  pushSpan(statRows, 17, 4, 17, 0.3333);
  const stats = { [LIGHT]: statRows };

  l = render("18:00", weekAttrs, { blocks: ["week"], states: lit("14.3333"), history: stats,
                                   config: { week_style: "classic" } });
  eq("one hourly min/max/mean statistics request for all recorded history", [l.asked.length, l.asked[0] && l.asked[0].type,
    l.asked[0] && l.asked[0].statistic_ids, l.asked[0] && l.asked[0].period, l.asked[0] && l.asked[0].types,
    l.asked[0] && l.asked[0].start_time],
    [1, "recorder/statistics_during_period", [LIGHT], "hour", ["min", "max", "mean"], "2020-01-01T00:00:00Z"]);
  await settle();
  const litRow = () => l.root.querySelectorAll(".brow").map((row) => {
    const el = row.querySelector(".dlit");
    return el ? el.textContent : null;
  });
  eq("midnight carry-over skipped: Mo..Su totals use hours 01-23, Sa live", litRow(),
    ["20h30", "0h00", "0h45", "17h01", "3h48", "14h20", null]);
  eq("under the plan's dark hours", l.root.querySelectorAll(".brow")[0].querySelector(".dtot").textContent, "6h");
  eq("the row figure's tooltip", l.root.querySelectorAll(".brow")[4].querySelector(".dlit")
    .getAttribute("data-tip").split("\n")[0], "Fr light — 3h 48m measured");
  eq("a legend entry", /Light, measured/.test(l.text(".legend")), true);

  const lcStat = (k) => {
    const s = l.root.querySelectorAll(".lc-stat").find((x) => x.querySelector("b").textContent === k);
    return s ? s.querySelector("span").textContent.replace(/\s+/g, " ").trim() : null;
  };
  eq("single bar chart rendered in Daily mode by default, 7d active",
    [!!l.root.querySelector(".lightchart"), !!l.root.querySelector(".lc-plot"),
      l.root.querySelector(".lc-plot").classList.contains("hourly"),
      l.root.querySelector(".lc-hrleg").hidden,
      l.text(".lc-win"),
      l.root.querySelector('.lc-mode[data-val="daily"]').getAttribute("aria-pressed"),
      l.root.querySelectorAll(".lc-seg").find((b) => b.getAttribute("aria-pressed") === "true").getAttribute("data-val")],
    [true, true, false, true, "last 7 days", "true", "7d"]);
  eq("7d draws 6 recorded bars (1 zero bar on Tu, 1 today)",
    [l.root.querySelectorAll(".lc-bar").length, l.root.querySelectorAll(".lc-bar.zero").length,
      l.root.querySelectorAll(".lc-bar.today").length,
      l.root.querySelectorAll(".lc-val").map((v) => v.textContent)],
    [6, 1, 1, ["20h30", "0h00", "0h45", "17h01", "3h48", "14h20"]]);
  eq("7d stats exclude partial today from Min/Max/Mean",
    [lcStat("Today"), lcStat("Min"), lcStat("Max"), lcStat("Mean")],
    ["14h 20m", "0h 0m 13.10", "20h 30m 12.10", "8h 25m"]);

  // Hover preview + click-to-open large 24h modal with horizontal timeline & segment inspector.
  const dn = (d) => Math.round(Date.UTC(2026, 9, d) / 864e5);
  const plot = l.root.querySelector(".lc-plot");
  plot.getBoundingClientRect = () => ({ left: 0, top: 0, width: 700, height: 148 });
  const tip = plot.querySelector(".lc-tip");
  const hv = plot.querySelector(".lc-hv");
  const modal = l.root.querySelector(".lc-modal-backdrop");
  // 7d spans 11.10..17.10 -> slot 5 (x=550) is Fr 16.10.
  l.card._onLcHover({ clientX: 550 });
  eq("hover opens non-interactive preview with % ON, delta, 24h bar, tariff split & est note",
    [tip.classList.contains("on"), hv.classList.contains("on"),
      /Fr 16\.10\.2026/.test(tip.textContent), /16% ON/.test(tip.textContent),
      !/\bLIT\b|EST\./.test(tip.textContent),
      /−4h 37m vs avg/.test(tip.textContent),
      /Day 07–23: 3h 48m · Night 23–07: 0h 0m/.test(tip.textContent),
      /18:48–22:36/.test(tip.textContent),
      /Estimated from inverter voltage/.test(tip.textContent),
      !!tip.querySelector(".lct-tl-bar"),
      tip.querySelectorAll(".lct-seg.lit").length,
      tip.querySelectorAll(".lct-seg.dark").length],
    [true, true, true, true, true, true, true, true, true, true, 1, 2]);

  // Click on the bar opens the large 24h modal and closes the hover tip.
  fire(plot, "pointerdown", { pointerId: 1, clientX: 550 });
  fire(plot, "pointerup", { pointerId: 1, clientX: 550 });
  eq("click opens large modal with KPIs, timeline & chronological rows, hiding hover tip",
    [modal.hidden, !!modal.querySelector(".lc-modal"), tip.classList.contains("on"),
      hv.classList.contains("pin"), modal.querySelectorAll(".lcm-kpi").length,
      !!modal.querySelector(".lcm-tl-bar"), modal.querySelectorAll(".lcm-seg.lit").length,
      modal.querySelectorAll(".lcm-seg.dark").length, modal.querySelectorAll(".lcm-row").length],
    [false, true, false, true, 4, true, 1, 2, 3]);

  // Auto-refresh while modal is open keeps the modal intact and preserves the chart DOM node.
  const nextStates = Object.assign({}, l.card._hass.states, lit("14.5000"));
  l.card.hass = { states: nextStates, callWS: l.card._hass.callWS };
  l.card._fingerprint = null;
  l.card._render();
  eq("auto-refresh while modal open keeps modal visible & defers render",
    [modal.hidden, l.card._lcModalDn, l.root.querySelector(".lc-plot") === plot],
    [false, dn(16), true]);

  // Clicking dark/light modal segments updates fixed-height inspector with continuity & reliability.
  fire(modal.querySelectorAll(".lcm-seg.dark")[0], "click");
  const insp = () => modal.querySelector(".lcm-inspect").textContent;
  eq("dark segment shows NO GRID, span & cross-midnight continuous outage",
    [/NO GRID/.test(insp()), /00:00 – 18:48/.test(insp()),
      /Continuous: 15\.10 17:01 → 18:48 \(25h 47m\)/.test(insp())],
    [true, true, true]);
  fire(modal.querySelectorAll(".lcm-seg.lit")[0], "click");
  eq("light segment shows POWER ON, exact span & hourly reliability",
    [/POWER ON/.test(insp()), /18:48 – 22:36 · 3h 48m/.test(insp()),
      /At 20:00: power on 2 \/ 5 days \(40%\)/.test(insp())],
    [true, true, true]);

  // Stepping to previous day, closing modal, flushing deferred update, and in-place refresh.
  fire(modal.querySelector('[data-act="lc-prev"]'), "click");
  eq("prev steps modal to Th 15.10",
    [/Th 15\.10\.2026/.test(modal.textContent), /71% ON/.test(modal.textContent), /17h 1m/.test(modal.textContent)],
    [true, true, true]);
  fire(modal.querySelector('[data-act="lc-close"]'), "click");
  eq("close hides modal, flushes deferred state & keeps same chart DOM element",
    [modal.hidden, hv.classList.contains("on"), lcStat("Today"),
      l.root.querySelector(".lc-plot") === plot],
    [true, false, "14h 30m", true]);
  const liveStates = Object.assign({}, l.card._hass.states, lit("14.3333"));
  l.card.hass = { states: liveStates, callWS: l.card._hass.callWS };
  eq("normal auto-refresh patches light chart in place without losing DOM node",
    [lcStat("Today"), l.root.querySelector(".lc-plot") === plot],
    ["14h 20m", true]);

  fire(l.root.querySelector('.lc-seg[data-val="14d"]'), "click");
  eq("14d range widens window, hides per-bar values & adds 08.10 bar",
    [l.text(".lc-win"), l.root.querySelectorAll(".lc-bar").length,
      l.root.querySelectorAll(".lc-val").length,
      l.root.querySelectorAll(".lc-seg").find((b) => b.getAttribute("aria-pressed") === "true").getAttribute("data-val")],
    ["last 14 days", 7, 0, "14d"]);
  fire(l.root.querySelector('.lc-seg[data-val="all"]'), "click");
  eq("all range shows all recorded", [l.text(".lc-win"), l.root.querySelectorAll(".lc-bar").length],
    ["all recorded", 7]);

  // Panning into the past clears active preset and labels the date span; dblclick returns to today.
  l.card._lcApplyView(dn(8), dn(14) + 1);
  eq("panned window labels date range and clears preset pressed state",
    [l.text(".lc-win"),
      l.root.querySelectorAll(".lc-seg").some((b) => b.getAttribute("aria-pressed") === "true"),
      l.root.querySelectorAll(".lc-val").map((v) => v.textContent)],
    ["08.10 – 14.10", false, ["10h30", "20h30", "0h00", "0h45"]]);
  l.card._onLcHover({ clientX: 50 });
  eq("08.10 hover shows snapped 12:30–23:00 light window",
    [/Th 08\.10\.2026/.test(tip.textContent), /12:30–23:00/.test(tip.textContent)],
    [true, true]);
  l.card._lcLeave();
  fire(plot, "dblclick");
  eq("dblclick returns to live preset", [l.text(".lc-win"),
    l.root.querySelectorAll(".lc-seg").find((b) => b.getAttribute("aria-pressed") === "true").getAttribute("data-val")],
    ["all recorded", "all"]);

  // Switch to 7d + Hourly mode: 24 per-hour Y strips on the exact same zoomable/pannable day X-axis.
  fire(l.root.querySelector('.lc-seg[data-val="7d"]'), "click");
  fire(l.root.querySelector('.lc-mode[data-val="hourly"]'), "click");
  const svgEl = l.root.querySelector(".lc-svg");
  eq("Hourly mode switches the same plot DOM node to 24 per-hour strips & shows legend",
    [l.root.querySelector(".lc-plot") === plot, plot.classList.contains("hourly"),
      l.root.querySelector(".lc-hrleg").hidden,
      l.root.querySelector('.lc-mode[data-val="hourly"]').getAttribute("aria-pressed"),
      svgEl.getAttribute("viewBox"),
      l.root.querySelectorAll(".lc-yax span").map((s) => s.textContent),
      l.root.querySelectorAll(".lc-hcell").length > 0,
      l.root.querySelectorAll(".lc-hcell.lit").length > 0,
      l.root.querySelectorAll(".lc-hcell.dark").length > 0,
      l.root.querySelectorAll(".lc-hcell.future").length,
      l.root.querySelectorAll(".lc-hnow").length],
    [true, true, false, "true", "0 0 1000 252", ["00", "06", "12", "18", "24"], true, true, true, 6, 1]);

  plot.getBoundingClientRect = () => ({ left: 0, top: 0, width: 700, height: 252 });
  // Hover Fr 16.10 (x=550) at hour 18 (yPx = 6 + 18.5*10 = 191 -> partial 18:48-19:00).
  l.card._onLcHover({ clientX: 550, clientY: 191 });
  eq("Hourly hover on partial hour 18:00 shows PARTIAL, exact minutes, window & row highlight",
    [tip.classList.contains("on"), plot.querySelector(".lc-hvh").classList.contains("on"),
      plot.querySelector(".lc-hvcell").classList.contains("on"),
      /Fr 16\.10\.2026/.test(tip.textContent), /18:00 – 19:00/.test(tip.textContent),
      /PARTIAL/.test(tip.textContent), /12m on · 18:48–19:00/.test(tip.textContent),
      /Window: 18:48–22:36 \(3h 48m\)/.test(tip.textContent),
      /At 18:00: power on/.test(tip.textContent)],
    [true, true, true, true, true, true, true, true, true]);

  // Hover Fr 16.10 at hour 20 (yPx = 211 -> full 60m lit).
  l.card._onLcHover({ clientX: 550, clientY: 211 });
  eq("Hourly hover on full lit hour 20:00 shows POWER ON, 60m on & hourly reliability",
    [/POWER ON/.test(tip.textContent), /60m on/.test(tip.textContent),
      /At 20:00: power on 2 \/ 5 days \(40%\)/.test(tip.textContent)],
    [true, true, true]);

  // Hover Fr 16.10 at hour 10 (yPx = 111 -> cross-midnight outage).
  l.card._onLcHover({ clientX: 550, clientY: 111 });
  eq("Hourly hover on dark hour 10:00 shows NO GRID, outage & cross-midnight continuous",
    [/NO GRID/.test(tip.textContent), /Outage: 00:00–18:48 \(18h 48m\)/.test(tip.textContent),
      /Continuous: 15\.10 17:01 → 18:48 \(25h 47m\)/.test(tip.textContent)],
    [true, true, true]);
  l.card._lcLeave();

  // Wheel zoom, pan & double-click work identically in Hourly mode on the shared day X-axis.
  fire(plot, "wheel", { deltaY: -120, deltaMode: 0, clientX: 350 });
  eq("wheel zoom in Hourly mode narrows day window while keeping Hourly mode",
    [plot.classList.contains("hourly"),
      l.root.querySelectorAll(".lc-seg").some((b) => b.getAttribute("aria-pressed") === "true"),
      l.card._lcData.span < 7],
    [true, false, true]);
  l.card._lcApplyView(dn(8), dn(14) + 1);
  l.card._onLcHover({ clientX: 50, clientY: 131 });
  eq("panned Hourly view labels 08.10 – 14.10 and shows 08.10 partial hour 12:00",
    [l.text(".lc-win"), /Th 08\.10\.2026/.test(tip.textContent),
      /PARTIAL/.test(tip.textContent), /30m on · 12:30–13:00/.test(tip.textContent)],
    ["08.10 – 14.10", true, true, true]);
  l.card._lcLeave();
  fire(plot, "dblclick");
  eq("dblclick in Hourly returns to live 7d preset while staying Hourly",
    [l.text(".lc-win"), plot.classList.contains("hourly"),
      l.root.querySelector('.lc-seg[data-val="7d"]').getAttribute("aria-pressed")],
    ["last 7 days", true, "true"]);

  fire(plot, "pointerdown", { pointerId: 2, clientX: 550 });
  fire(plot, "pointerup", { pointerId: 2, clientX: 550 });
  eq("clicking Hourly plot opens large 24h modal for that day",
    [modal.hidden, /Fr 16\.10\.2026/.test(modal.textContent)], [false, true]);
  fire(modal.querySelector('[data-act="lc-close"]'), "click");

  fire(l.root.querySelector('.lc-mode[data-val="daily"]'), "click");
  eq("switching back to Daily keeps persistent plot node and draws 6 bars",
    [l.root.querySelector(".lc-plot") === plot, plot.classList.contains("hourly"),
      svgEl.getAttribute("viewBox"), l.root.querySelectorAll(".lc-bar").length],
    [true, false, "0 0 1000 148", 6]);

  l.card._fingerprint = null;
  l.card._render();
  eq("the same day: not asked again", l.asked.length, 1);

  l = render("18:00", weekAttrs, { blocks: ["week"], states: lit("14.3333"), history: new Error("busy"),
                                   config: { week_style: "classic" } });
  await settle();
  eq("statistics fail: today still shows in row and chart with note",
    [litRow()[5], l.root.querySelectorAll(".lc-bar").length, l.text(".lc-note")],
    ["14h20", 1, "Light history unavailable"]);
  l = render("18:00", {}, { blocks: ["week"], states: lit("14.3333"), history: stats });
  await settle();
  eq("DTEK's table withdrawn: the bar chart stays", [l.root.querySelectorAll(".brow").length,
    l.root.querySelectorAll(".lightchart").length, l.root.querySelectorAll(".lc-bar").length],
    [0, 1, 6]);
  l = render("18:00", weekAttrs, { blocks: ["week"], config: { week_style: "classic" } });
  eq("no light sensor: no request, no chart, no figures, no legend entry",
    [l.asked.length, l.root.querySelectorAll(".lightchart").length,
      litRow().filter(Boolean).length, /Light, measured/.test(l.text(".legend"))],
    [0, 0, 0, false]);

  t = render("13:39", {}, { blocks: ["timeline"], history, config: { grid_entity: null } });
  eq("grid_entity: null is left out of the request", t.asked[0] && t.asked[0].entity_ids, [OUT, SCHED, UNS]);
  await settle();
  eq("... and the four rows stay in place", [rows().length, blocks(0).length, blocks(3).map((b) => b[0])],
    [4, 0, ["blk warn"]]);

  console.log(failed ? "test_dtek_card: " + failed + " FAILED, " + passed + " passed"
    : "test_dtek_card: ok — " + passed + " checks passed");
  process.exit(failed ? 1 : 0);
})();
