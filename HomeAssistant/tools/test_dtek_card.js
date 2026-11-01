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
  card.setConfig(Object.assign({ blocks: opts.blocks || ["hero", "days"] }, opts.config || {}));
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
eq("headline carries +1", r.text("h1"), "Scheduled outage until 02:00+1.");
r = render("23:40", { today: "yyyyyyyyyyyyyyyyyyyyyynn", tomorrow: null }, { gridDown: true });
eq("tomorrow unpublished: no false end time", r.text(".lede"),
  "The inverter sees no mains, as DTEK's schedule for (1.1) has it: off 22:00–00:00+1, back by midnight unless tomorrow's table extends it.");

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

  console.log(failed ? "test_dtek_card: " + failed + " FAILED, " + passed + " passed"
    : "test_dtek_card: ok — " + passed + " checks passed");
  process.exit(failed ? 1 : 0);
})();
