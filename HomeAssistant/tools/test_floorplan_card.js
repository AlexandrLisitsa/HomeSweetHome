/**
 * Behaviour tests for the Home dashboard's floor plan card:
 *
 *     config/www/floorplan-card.js
 *
 *     node HomeAssistant/tools/test_floorplan_card.js
 *
 * The card is driven with the config the dashboard really uses
 * (dashboards/lovelace.dashboard_home.json, written by FloorPlan's
 * make_dashboard.py) on the small DOM in fake_dom.js, through its real
 * setConfig / `set hass` / pointer paths. What is checked is what the eye
 * would see: which room is tinted and in what colour, which power streams run
 * and which way, what the inverter and the pack say, the status chip, the dim
 * of an outage and load shedding's rings. The look itself (CSS, the routes on
 * the picture) is checked by eye in FloorPlan/tools/card_harness.html.
 *
 * Exit status is 0 when every case passes, 1 otherwise.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { fire, loadCard, mkHass, S, serialize, localIso } = require("./fake_dom");

let pass = 0;
const failures = [];
let group = "";

function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(group + name + (detail ? " -- " + detail : ""));
}

function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  check(name, g === w, "got " + g + ", wanted " + w);
}

/* --- the card and a quiet house -------------------------------------------- */

const DASH = path.join(__dirname, "..", "dashboards", "lovelace.dashboard_home.json");
const CFG = JSON.parse(fs.readFileSync(DASH, "utf8")).data.config.views[0].cards
  .find((c) => c.type === "custom:floorplan-card");
const P = CFG.power;
const W = { unit_of_measurement: "W" };

/**
 * Every lamp, plug and TV off, rooms at 23 °C, grid up and feeding 380 W, no
 * DTEK window, nothing shed. `over` replaces any of it.
 */
function house(over) {
  const st = {};
  for (const l of CFG.lights) {
    st[l.entity] = l.entity.startsWith("media_player.") ? S("off", {})
      : S("off", { supported_color_modes: /relay/.test(l.entity) ? ["onoff"] : ["brightness"] });
  }
  for (const d of CFG.devices) {
    const dom = d.entity.split(".")[0];
    st[d.entity] = dom === "climate" ? S("off", { temperature: 22 }) : dom === "switch" ? S("off", {})
      : S("80", { unit_of_measurement: d.entity.includes("charge") ? "%" : "W" });
    if (d.value) st[d.value] = S("0", W);
  }
  for (const b of CFG.badges) {
    st[b.entities[0]] = S("23", { unit_of_measurement: "°C" });
    if (b.entities[1]) st[b.entities[1]] = S("48", { unit_of_measurement: "%" });
  }
  Object.assign(st, {
    [P.hub_entity]: S("376", W),
    [P.battery_entity]: S("64", { unit_of_measurement: "%" }),
    [P.grid]: S("380", W),
    [P.battery_power]: S("0", W),
    [P.down]: S("off", {}),
    [P.returning]: S("off", {}),
    [P.runtime]: S("unknown", {}),
    [P.priority]: S("Utility First", {}),
    [P.dtek_start]: S("unknown", {}),
    [P.dtek_end]: S("unknown", {}),
    [P.shedding]: S("0", { loads: {} }),
  });
  Object.assign(st, over || {});
  Object.keys(st).forEach((k) => { st[k].entity_id = k; });
  return st;
}

function render(over) {
  const L = loadCard("floorplan-card.js");
  const card = new L.Card();
  card.setConfig(JSON.parse(JSON.stringify(CFG)));
  const hass = mkHass(house(over));
  card.hass = hass;
  L.flushTimers();
  const root = card.shadowRoot;
  return { L, card, hass, root, $: (s) => root.querySelector(s), $$: (s) => root.querySelectorAll(s) };
}

/** Everything drawn under `n`, styles too: serialize() alone leaves styles out. */
function snapshot(n) {
  if (n.nodeType === 3) return n.data;
  const own = n.nodeType === 1 ? serialize(Object.assign(Object.create(Object.getPrototypeOf(n)), n, { childNodes: [] }))
    + JSON.stringify(Object.entries(n.style || {}).filter(([, v]) => typeof v !== "function"))
    + JSON.stringify(n.style ? n.style._props : null) : "";
  return own + n.childNodes.map(snapshot).join("");
}

const on = (el) => el.classList.contains("on");
// The streams in build order: grid, battery, then one per load in config order.
const streams = (r) => r.$$(".stream");
const loadStream = (r, entity) => streams(r)[2 + P.loads.findIndex((l) => l.entity === entity)];
const spotOf = (r, entity) => {
  const i = CFG.devices.findIndex((d) => d.entity === entity);
  if (i >= 0) return r.card._devices[i].spot;
  return r.card._lights[CFG.lights.findIndex((l) => l.entity === entity)].spot;
};
const labelOf = (r, entity) => r.card._devices.find((D) => D.cfg.entity === entity).label.textContent;

/* --- the rooms' tint ------------------------------------------------------- */

group = "tint: ";
{
  const tinted = CFG.rooms.filter((r) => r.tint);
  check("the rooms with a thermometer have a tint", tinted.length === CFG.badges.length);
  const kitchen = tinted.findIndex((r) => r.id === "kitchen");
  const at = (t) => {
    const r = render({ [tinted[kitchen].temperature]: S(String(t), { unit_of_measurement: "°C" }) });
    const el = r.$$(".tint")[kitchen];
    const badge = r.card._badges.find((B) => B.cfg.room === "kitchen").el;
    return {
      on: on(el),
      alpha: on(el) ? Number(el.style.getPropertyValue("--alpha")) : 0,
      rgb: on(el) ? el.style.getPropertyValue("--tint").match(/\d+/g).map(Number) : null,
      band: / · (cool|warm|hot)\n/.exec(badge.dataset.tip)?.[1] || null,
    };
  };
  for (const t of [20, 23, 26]) check(t + " °C: comfortable, no tint", !at(t).on);
  const warm = [26.5, 28, 30, 32, 34].map(at);
  check("warm: deeper with every degree", warm.every((w, i) => i === 0 || w.alpha > warm[i - 1].alpha),
    JSON.stringify(warm.map((w) => w.alpha)));
  check("warm: barely there just past 26 °C", warm[0].alpha < 0.07, String(warm[0].alpha));
  check("warm: the hue drifts warmer", warm[4].rgb[1] < warm[0].rgb[1], JSON.stringify([warm[0].rgb, warm[4].rgb]));
  const hot = at(45);
  eq("45 °C looks like 34 °C: the wash stops deepening", [hot.alpha, hot.rgb], [warm[4].alpha, warm[4].rgb]);
  check("even at its fullest, a soft wash and no red", hot.alpha <= 0.2 && hot.rgb[1] >= 120 && hot.rgb[2] >= 90,
    JSON.stringify(hot));
  const cool = [19.5, 17, 14].map(at);
  check("cool: deeper with every degree", cool[0].alpha < cool[1].alpha && cool[1].alpha < cool[2].alpha);
  check("cool: blue", cool.every((c) => c.rgb[2] > c.rgb[0]));
  eq("the badge names the climate card's band", [at(18).band, at(23).band, at(28).band, at(33).band],
    ["cool", null, "warm", "hot"]);
  const r = render({ [tinted[kitchen].temperature]: S("unavailable", {}) });
  check("no reading: no tint", !on(r.$$(".tint")[kitchen]));
}

/* --- what feeds the inverter ---------------------------------------------- */

group = "source: ";
{
  let r = render();
  check("grid: grid stream runs", on(streams(r)[0]));
  check("grid: battery stream still", !on(streams(r)[1]));
  eq("grid: the inverter says so", labelOf(r, P.hub_entity), "Grid 376 W");
  check("grid: no dim", !r.$(".stage").classList.contains("outage"));
  check("grid: no chip", r.$(".status").hidden);

  r = render({ [P.grid]: S("0", W), [P.battery_power]: S("-420", W), [P.hub_entity]: S("412", W) });
  check("battery: grid stream still", !on(streams(r)[0]));
  check("battery: battery stream runs", on(streams(r)[1]));
  eq("battery: towards the inverter", streams(r)[1].querySelectorAll("path")[1].style.animationDirection, "normal");
  eq("battery: the inverter says so", labelOf(r, P.hub_entity), "Battery 412 W");
  eq("battery: the pack says it feeds", labelOf(r, P.battery_entity), "64% · −420 W");

  r = render({ [P.grid]: S("1580", W), [P.battery_power]: S("1200", W) });
  check("charging: grid stream runs", on(streams(r)[0]));
  eq("charging: battery stream backwards",
    streams(r)[1].querySelectorAll("path")[1].style.animationDirection, "reverse");
  eq("charging: the pack says so", labelOf(r, P.battery_entity), "64% · +1.2 kW");
  check("charging: a stronger grid stream is wider",
    Number(streams(r)[0].style.getPropertyValue("--width")) > Number(streams(render()).at(0).style.getPropertyValue("--width")));

  r = render({ [P.battery_power]: S("12", W) });
  check("a trickle under 20 W is no stream", !on(streams(r)[1]));
}

/* --- the loads ------------------------------------------------------------- */

group = "loads: ";
{
  const plug = P.loads.find((l) => l.value);
  const relay = P.loads.find((l) => /relay/.test(l.entity));
  const tv = P.loads.find((l) => l.entity.startsWith("media_player."));
  check("every lamp, plug and TV is a load, nothing else",
    P.loads.every((l) => /^(light|switch|media_player)\./.test(l.entity))
    && CFG.lights.every((l) => P.loads.some((x) => x.entity === l.entity)));

  let r = render();
  eq("all off: no load stream", streams(r).slice(2).filter(on).length, 0);

  r = render({ [relay.entity]: S("on", { supported_color_modes: ["onoff"] }) });
  eq("one lamp on: one stream", streams(r).slice(2).filter(on).length, 1);
  check("one lamp on: its own", on(loadStream(r, relay.entity)));

  r = render({ [tv.entity]: S("playing", {}) });
  check("the TV playing has a stream", on(loadStream(r, tv.entity)));

  r = render({ [plug.entity]: S("on", {}), [plug.value]: S("3", W) });
  check("a plug on at 3 W (standby) has none", !on(loadStream(r, plug.entity)));
  r = render({ [plug.entity]: S("on", {}), [plug.value]: S("612", W) });
  check("a plug drawing 612 W has one", on(loadStream(r, plug.entity)));
  check("a metered stream is wider than an unmetered one",
    Number(loadStream(r, plug.entity).style.getPropertyValue("--width"))
    > Number(loadStream(render({ [relay.entity]: S("on", {}) }), relay.entity).style.getPropertyValue("--width")));
}

/* --- DTEK's window --------------------------------------------------------- */

group = "dtek: ";
{
  const hour = new Date().getHours();
  if (hour < 22) {
    const r = render({ [P.dtek_start]: S(localIso(hour + 1, 0)), [P.dtek_end]: S(localIso(hour + 2, 0)) });
    check("a window later today shows", !r.$(".status").hidden);
    check("in amber", r.$(".status").classList.contains("dtek"));
    check("with its hours", /^Outage \d\d:00–\d\d:00$/.test(r.$(".status").textContent), r.$(".status").textContent);
  }
  const tomorrow = (h) => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(h, 0, 0, 0); return d.toISOString(); };
  let r = render({ [P.dtek_start]: S(tomorrow(10)), [P.dtek_end]: S(tomorrow(14)) });
  check("a window tomorrow does not", r.$(".status").hidden);
  if (hour >= 2) {
    r = render({ [P.dtek_start]: S(localIso(0, 0)), [P.dtek_end]: S(localIso(1, 0)) });
    check("a window that has ended does not", r.$(".status").hidden);
  }
  r = render({ [P.dtek_start]: S("unknown"), [P.dtek_end]: S("unknown") });
  check("no window (schedules suspended): no chip", r.$(".status").hidden);
}

/* --- an outage ------------------------------------------------------------- */

group = "outage: ";
{
  const plug = CFG.devices.find((d) => d.entity.startsWith("switch."));
  const led = CFG.lights.find((l) => !/relay/.test(l.entity) && l.entity.startsWith("light."));
  const down = {
    [P.down]: S("on", {}), [P.grid]: S("0", W), [P.battery_power]: S("-450", W),
    [P.hub_entity]: S("412", W), [P.runtime]: S("3.4", { unit_of_measurement: "h" }),
    // DTEK is ignored while the inverter says the grid is down.
    [P.dtek_start]: S(localIso(0, 0)), [P.dtek_end]: S(localIso(23, 59)),
  };
  let r = render(down);
  check("the flat dims", r.$(".stage").classList.contains("outage"));
  check("red chip", r.$(".status").classList.contains("down"));
  eq("the chip says it", r.$(".status").textContent, "Grid down · on battery · 3.4 h left");
  check("no grid stream", !on(streams(r)[0]));
  check("the battery stream runs", on(streams(r)[1]));
  eq("the inverter gives the hours", labelOf(r, P.hub_entity), "Battery 412 W · 3.4 h");

  r = render(Object.assign({}, down, { [P.runtime]: S("unknown", {}) }));
  eq("no runtime: no hours", r.$(".status").textContent, "Grid down · on battery");

  r = render(Object.assign({}, down, { [P.returning]: S("on", {}) }));
  check("mains back: amber", r.$(".status").classList.contains("returning"));
  eq("mains back: says so", r.$(".status").textContent, "Grid returning · on battery");

  r = render(Object.assign({}, down, {
    [led.entity]: S("on", { supported_color_modes: ["brightness"], brightness: 76 }),
    [P.shedding]: S("2", { loads: {
      led: { entity: led.entity, step_soc: 80, override_soc: null, plug_cut: false },
      ac: { entity: "climate.x", plug: plug.entity, plug_cut: true, step_soc: 60, override_soc: null },
      kept: { entity: "light.kept", step_soc: 80, override_soc: 75 },
    } }),
  }));
  check("stepped down: amber ring", spotOf(r, led.entity).classList.contains("shed"));
  check("stepped down: its tooltip says when",
    /^LED strip — On 30 % · stepped down at 80 %\n/.test(r.card._lights.find((L) => L.cfg.entity === led.entity).btn.dataset.tip),
    r.card._lights.find((L) => L.cfg.entity === led.entity).btn.dataset.tip.split("\n")[0]);
  check("cut: red ring", spotOf(r, plug.entity).classList.contains("cut"));
  check("cut: on its row too", r.card._devices.find((D) => D.cfg.entity === plug.entity).row.classList.contains("cut"));
  eq("cut: says so", labelOf(r, plug.entity), "0 W · cut");
  check("kept on by you: no mark", r.$$(".shed, .cut").length === 4,
    "marked " + r.$$(".shed, .cut").length);

  r = render();
  eq("grid back: nothing marked", r.$$(".shed, .cut").length, 0);
}

/* --- patching ------------------------------------------------------------- */

group = "patch: ";
{
  const r = render({ [P.grid]: S("380", W) });
  const before = snapshot(r.root);
  r.card.hass = mkHass(house({ [P.grid]: S("383", W) }));
  eq("3 W more changes nothing drawn", snapshot(r.root), before);
  r.card.hass = mkHass(house({ [P.grid]: S("900", W) }));
  check("520 W more does", snapshot(r.root) !== before);
}

/* --- taps ------------------------------------------------------------------ */

group = "press: ";
{
  // A fresh card per press: fake_dom's clearTimeout does nothing, so a tap's
  // cancelled hold timer would still fire on the next flush.
  const press = (hold) => {
    const r = render();
    const lamp = r.card._lights[0];
    const seen = [];
    r.card.addEventListener("hass-more-info", (e) => seen.push(e.detail.entityId));
    fire(lamp.btn, "pointerdown", { button: 0 });
    if (hold) r.L.flushTimers();
    fire(lamp.btn, "pointerup");
    return [r.hass.calls.map((c) => c[1] + " " + c[2].entity_id), seen, lamp.cfg.entity];
  };
  let [calls, seen, id] = press(false);
  eq("a tap toggles the lamp", [calls, seen], [["toggle " + id], []]);
  [calls, seen, id] = press(true);
  eq("a hold opens its dialog and does not toggle", [calls, seen], [[], [id]]);

  const r = render({ [P.down]: S("on", {}), [P.runtime]: S("3.4", {}) });
  const opened = [];
  r.card.addEventListener("hass-more-info", (e) => opened.push(e.detail.entityId));
  fire(r.$(".status"), "click");
  eq("the outage chip opens the runtime", opened, [P.runtime]);
}

/* --- report ---------------------------------------------------------------- */

if (failures.length) {
  console.log(failures.map((f) => "FAIL " + f).join("\n"));
  console.log("test_floorplan_card: " + failures.length + " failed, " + pass + " passed");
  process.exit(1);
}
console.log("test_floorplan_card: ok — " + pass + " checks");
