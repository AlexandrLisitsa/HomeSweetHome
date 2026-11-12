/**
 * The P2S printer console card: every status, the camera that exists only
 * while printing, the virtual printer drawn from live data, the Playground's
 * Preview-state bar, the AMS slots, the issue line, the tooltips and the taps.
 *
 *     node HomeAssistant/tools/test_printer_card.js
 *
 * Exit status is 0 when everything passes, 1 otherwise.
 */

"use strict";

const { Element, fire, loadCard, mkHass, S, flush } = require("./fake_dom");

const FILE = "p2s-printer-console-card.js";
const SEL = "input_select.p2s_playground_status";
let failed = 0;
let passed = 0;

function eq(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else {
    failed++;
    console.log("  FAIL " + label + ": " + JSON.stringify(got) + "  want " + JSON.stringify(want));
  }
}

/** The printer as it stood on 07.11.2026: idle, Generic PLA in slot 1. */
function states(over) {
  const empty = { slot: 0, active: false, color: "#00000000", empty: true, name: "Empty", type: "" };
  return Object.assign({
    "sensor.p2s_print_status": S("idle"),
    "sensor.p2s_current_stage": S("idle"),
    "sensor.p2s_print_progress": S("0"),
    "sensor.p2s_remaining_time": S("0.0"),
    "sensor.p2s_end_time": S("unknown"),
    "sensor.p2s_task_name": S("unknown"),
    "sensor.p2s_current_layer": S("0"),
    "sensor.p2s_total_layer_count": S("0"),
    "sensor.p2s_print_weight": S("11.7"),
    "sensor.p2s_speed_profile": S("standard"),
    "image.p2s_cover_image": S("2026-11-07T13:20:04", { entity_picture: "/api/image_proxy/image.p2s_cover_image?token=x" }),
    "camera.p2s_camera": S("streaming", { entity_picture: "/api/camera_proxy/camera.p2s_camera?token=y" }),
    "light.p2s_chamber_light": S("on"),
    "binary_sensor.p2s_door": S("off"),
    "sensor.p2s_nozzle_temperature": S("19"),
    "sensor.p2s_nozzle_target_temperature": S("0"),
    "sensor.p2s_bed_temperature": S("17"),
    "sensor.p2s_bed_target_temperature": S("0"),
    "sensor.p2s_chamber_temperature": S("22"),
    "sensor.p2s_ams_1_tray_1": S("Generic PLA", { slot: 1, active: false, color: "#898989FF", empty: false,
      name: "Generic PLA", type: "PLA" }),
    "sensor.p2s_ams_1_tray_2": S("Empty", Object.assign({}, empty, { slot: 2 })),
    "sensor.p2s_ams_1_tray_3": S("Empty", Object.assign({}, empty, { slot: 3 })),
    "sensor.p2s_ams_1_tray_4": S("Empty", Object.assign({}, empty, { slot: 4 })),
    "sensor.p2s_external_spool": S("?", { active: false, color: "#00000000", empty: true, name: "?", type: "?" }),
    "sensor.p2s_ams_1_humidity": S("48"),
    "sensor.p2s_ams_1_temperature": S("24.2"),
    "binary_sensor.p2s_ams_1_drying": S("off"),
    "sensor.p2s_ams_1_remaining_drying_time": S("0.0"),
    "binary_sensor.p2s_hms_errors": S("off", { Count: 0 }),
    "binary_sensor.p2s_print_error": S("off"),
    "input_number.p2s_filament_a1": S("984"),
    "input_number.p2s_filament_a2": S("0"),
    "input_number.p2s_filament_a3": S("0"),
    "input_number.p2s_filament_a4": S("0"),
    "input_number.p2s_filament_ext": S("0"),
    "input_number.p2s_spool_size": S("1000"),
  }, over || {});
}

function mount(config, st) {
  const L = loadCard(FILE);
  const made = [];
  const timers = { set: 0, cleared: 0, fns: [] };
  L.sandbox.window.setInterval = (fn) => { timers.set++; timers.fns.push(fn); return timers.set; };
  L.sandbox.window.clearInterval = () => { timers.cleared++; };
  L.sandbox.window.loadCardHelpers = () => Promise.resolve({
    createCardElement: (cfg) => { const e = new Element("hui-picture-entity-card"); e.cfg = cfg; made.push(e); return e; },
  });
  const card = new L.Card();
  card.setConfig(config || {});
  card.hass = mkHass(st || states());
  const root = card.shadowRoot;
  const r = (name) => root.querySelector('[data-r="' + name + '"]');
  const set = (over) => { card.hass = mkHass(Object.assign(card._hass.states, over)); };
  const live = () => r("livecard").children.filter((e) => e.localName === "hui-picture-entity-card");
  return { card, root, r, made, set, timers, live };
}

const RUNNING = () => states({
  "sensor.p2s_print_status": S("running"),
  "sensor.p2s_current_stage": S("printing"),
  "sensor.p2s_print_progress": S("46"),
  "sensor.p2s_remaining_time": S("1.05"),
  "sensor.p2s_end_time": S(new Date(Date.now() + 63 * 60000).toISOString()),
  "sensor.p2s_task_name": S("Cable clips x8"),
  "sensor.p2s_current_layer": S("66"),
  "sensor.p2s_total_layer_count": S("142"),
  "sensor.p2s_nozzle_temperature": S("221"),
  "sensor.p2s_nozzle_target_temperature": S("220"),
  "sensor.p2s_bed_temperature": S("40"),
  "sensor.p2s_bed_target_temperature": S("65"),
  "sensor.p2s_ams_1_tray_1": S("Generic PLA", { slot: 1, active: true, color: "#898989FF", empty: false,
    name: "Generic PLA", type: "PLA" }),
});

async function main() {
  // --- idle: no camera ------------------------------------------------------
  {
    const t = mount();
    eq("idle: label", t.r("plabel").textContent, "Idle");
    eq("idle: title", t.r("title").textContent, "No active print");
    eq("idle: subtitle", t.r("sub").textContent, "Ready for the next job");
    eq("idle: badge", t.r("badgev").textContent, "Off");
    eq("idle: still hidden", t.r("camimg").hidden, true);
    eq("idle: no still src", t.r("camimg").getAttribute("src"), null);
    eq("idle: no timer", t.timers.set, 0);
    eq("idle: plate image shown", t.r("plateimg").hidden, false);
    eq("idle: message", t.r("cammsg").textContent, "Camera turns on while printing");
    eq("idle: preview bar hidden", t.r("pv").hidden, true);
    eq("idle: time left", t.r("leftv").textContent, "—");
    eq("idle: head parked", t.r("head").getAttribute("transform"), "translate(-118 0)");
    eq("idle: bed down", t.r("bed").getAttribute("transform"), "translate(0 40.00)");
    eq("idle: no spaghetti", t.r("spag").getAttribute("opacity"), "0");
    eq("idle: nozzle tag", t.r("tv-noz").textContent, "19°C");
    eq("idle: nozzle stat", t.r("ts-noz").textContent, "OFF");
    eq("idle: display", t.r("disp").textContent, "READY");
    eq("idle: health hidden", t.r("health").hidden, true);
  }

  // --- running → finish: still camera every 10 s, then gone -----------------
  {
    const st = RUNNING();
    const t = mount({}, st);
    eq("running: label", t.r("plabel").textContent, "Printing");
    eq("running: pct", t.r("pctn").textContent + t.r("pctu").textContent, "46%");
    eq("running: layers", t.r("layerv").textContent, "66 / 142");
    eq("running: to go", t.r("togo").textContent, "76 layers to go");
    eq("running: left", t.r("leftv").textContent, "1 h 03 min");
    // The job ends 63 min from now: after about 22:57 that is past midnight, and the card says so.
    const end = new Date(st["sensor.p2s_end_time"].state);
    const two = (n) => String(n).padStart(2, "0");
    const next = end.toDateString() !== new Date().toDateString();
    eq("running: subtitle", t.r("sub").textContent, "Layer 66 of 142 · finishing at "
      + two(end.getHours()) + ":" + two(end.getMinutes()) + (next ? " tomorrow" : ""));
    eq("running: badge", t.r("badgev").textContent, "Live");
    eq("running: still shown", t.r("camimg").hidden, false);
    eq("running: still src", /^\/api\/camera_proxy\/camera\.p2s_camera\?token=y&t=\d+$/.test(t.r("camimg").getAttribute("src")), true);
    eq("running: one timer", t.timers.set, 1);
    eq("running: plate hidden", t.r("plateimg").hidden, true);
    eq("running: no picture card in auto", t.made.length, 0);
    eq("running: head scans", t.r("headrun").classList.contains("th-run"), true);
    eq("running: head centred", t.r("head").getAttribute("transform"), "translate(0 0)");
    eq("running: no fan reading, no spin", [t.r("fan").classList.contains("fan-run"), t.r("fan").classList.contains("fan-var")], [false, false]);
    eq("running: bed stepped down", t.r("bed").getAttribute("transform"), "translate(0 " + (64 * 0.46).toFixed(2) + ")");
    eq("running: part height", t.r("part").querySelector(".pp").getAttribute("height"), (64 * 0.46).toFixed(2));
    eq("running: part in tray colour", t.r("part").getAttribute("fill"), "#898989");
    eq("running: display", t.r("disp").textContent, "46%");
    eq("running: nozzle tag", t.r("tv-noz").textContent, "221° / 220°");
    eq("running: nozzle at temp", t.r("ts-noz").textContent, "AT TEMP");
    eq("running: bed heating", t.r("ts-bed").textContent, "HEATING");
    eq("running: AMS tag", t.r("tv-ams").textContent, "PLA · 984g");
    eq("running: AMS feeding", t.r("ts-ams").textContent, "FEEDING");
    eq("running: slot A1 spins", t.r("aspk0").classList.contains("spool-run"), true);
    eq("running: slot A1 led", t.r("aled0").getAttribute("fill"), "#5AA9FF");
    eq("running: slot row active", t.r("sl0").classList.contains("active"), true);
    eq("running: slot note", t.r("note0").textContent, "Feeding · 984 g left");
    t.set({ "sensor.p2s_current_layer": S("67") });
    eq("running: no second timer", t.timers.set, 1);
    const before = t.r("camimg").getAttribute("src");
    t.timers.fns[0]();
    eq("running: tick refreshes the still", t.r("camimg").getAttribute("src") !== null, true);
    void before;
    t.set({ "sensor.p2s_print_status": S("finish"), "sensor.p2s_print_progress": S("100") });
    eq("finish: timer cleared", t.timers.cleared >= 1, true);
    eq("finish: still gone", t.r("camimg").hidden, true);
    eq("finish: no still src", t.r("camimg").getAttribute("src"), null);
    eq("finish: badge", t.r("badgev").textContent, "Off");
    eq("finish: left", t.r("leftv").textContent, "Done");
    eq("finish: finished at", t.r("donel").textContent, "Finished at");
    eq("finish: display", t.r("disp").textContent, "DONE");
    t.set({ "sensor.p2s_print_status": S("prepare") });
    eq("prepare again: a new timer", t.timers.set, 2);
  }

  // --- camera_view live: picture-entity, mounted and removed ----------------
  {
    const t = mount({ camera_view: "live" }, states({ "sensor.p2s_print_status": S("pause") }));
    await flush();
    eq("live: one camera card", t.made.length, 1);
    eq("live: camera config", t.made[0].cfg, { type: "picture-entity", entity: "camera.p2s_camera",
      camera_view: "live", show_name: false, show_state: false });
    eq("live: mounted", t.live().length, 1);
    eq("live: no still timer", t.timers.set, 0);
    t.set({ "sensor.p2s_print_status": S("idle") });
    eq("live: removed at idle", t.live().length, 0);
  }

  // --- status leaving printing before the helpers answer --------------------
  {
    const t = mount({ camera_view: "live" }, states({ "sensor.p2s_print_status": S("running") }));
    t.set({ "sensor.p2s_print_status": S("idle") });
    await flush();
    eq("late helpers: nothing mounted", t.live().length, 0);
  }

  // --- light and door drive the drawing -------------------------------------
  {
    const t = mount({}, states({ "light.p2s_chamber_light": S("off"), "binary_sensor.p2s_door": S("on") }));
    eq("dark: no beam", t.r("w-beam").getAttribute("opacity"), "0");
    eq("dark: back wall", t.r("w-back").getAttribute("fill"), "#17191D");
    eq("door open: drawn open", t.r("dooropen").getAttribute("opacity"), "1");
    eq("door open: chip", t.r("doorv").textContent, "Door open");
    eq("light off: button", t.r("lightv").textContent, "Light off");
    t.set({ "light.p2s_chamber_light": S("on"), "binary_sensor.p2s_door": S("off") });
    eq("lit: beam", t.r("w-beam").getAttribute("opacity"), "0.07");
    eq("door shut: drawn shut", t.r("doorshut").getAttribute("opacity"), "1");
  }

  // --- the Playground -------------------------------------------------------
  {
    const t = mount({ debug_status_entity: SEL }, states({ [SEL]: S("live") }));
    eq("pv: shown", t.r("pv").hidden, false);
    eq("pv: eight segments", t.r("segs").querySelectorAll(".seg").length, 8);
    eq("pv: live pressed", t.root.querySelector('[data-act="dbg:live"]').getAttribute("aria-pressed"), "true");
    fire(t.root.querySelector('[data-act="dbg:running"]'), "click");
    eq("pv: segment selects", t.card._hass.calls.pop(), ["input_select", "select_option", { entity_id: SEL, option: "running" }]);
    t.set({ [SEL]: S("running") });
    eq("pv running: mock chip", t.r("mock").hidden, false);
    eq("pv running: mock pct", t.r("pctn").textContent, "46");
    eq("pv running: camera", t.r("camimg").hidden, false);
    eq("pv running: A1 feeds", t.r("note0").textContent, "Feeding · 640 g left");
    t.set({ [SEL]: S("failed") });
    eq("pv failed: camera gone", t.r("camimg").hidden, true);
    eq("pv failed: spaghetti", t.r("spag").getAttribute("opacity"), "1");
    eq("pv failed: issue line", t.r("hhead").textContent, "Fault · 2");
    eq("pv failed: subtitle", t.r("sub").textContent, "Stopped at layer 31 · The nozzle is clogged. Clean it and retry.");
    t.set({ [SEL]: S("pause") });
    eq("pv pause: warning", t.r("health").classList.contains("warn"), true);
    eq("pv pause: parked", t.r("head").getAttribute("transform"), "translate(-118 0)");
    t.set({ [SEL]: S("prepare") });
    eq("pv prepare: ghost part", t.r("ghost2").getAttribute("opacity"), "0.55");
    eq("pv prepare: bed up", t.r("bed").getAttribute("transform"), "translate(0 0.00)");
    t.set({ [SEL]: S("offline") });
    eq("pv offline: dashes", t.r("pctn").textContent, "—");
    eq("pv offline: no signal", t.r("cammsg").textContent, "No signal");
    eq("pv offline: grey printer", t.r("vpbox").classList.contains("offline"), true);
    // door preview cycles sensor → open → closed → sensor
    fire(t.r("pvdoor"), "click");
    eq("door preview: open", t.r("dooropen").getAttribute("opacity"), "1");
    fire(t.r("pvdoor"), "click");
    eq("door preview: closed", t.r("doorshut").getAttribute("opacity"), "1");
    fire(t.r("pvdoor"), "click");
    eq("door preview: back to sensor", t.r("pvdoor").textContent, "Door: sensor");
    t.set({ [SEL]: S("live") });
    eq("pv live again", t.r("mock").hidden, true);
  }

  // --- AMS ------------------------------------------------------------------
  {
    const t = mount();
    eq("ams: A1 material", t.r("mat0").textContent, "PLA");
    eq("ams: A1 note", t.r("note0").textContent, "984 g left");
    eq("ams: A1 colour", t.r("sl0").style.getPropertyValue("--fc"), "#898989");
    eq("ams: A2 empty", t.r("sl1").classList.contains("empty"), true);
    eq("ams: A2 note", t.r("note1").textContent, "Slot free");
    eq("ams: external empty", t.r("note4").textContent, "Spool holder free");
    eq("ams: svg A1 colour", t.r("afil0").getAttribute("fill"), "#898989");
    eq("ams: svg A2 dashed", t.r("afil1").getAttribute("stroke-dasharray"), "3 4");
    eq("ams: humidity", t.r("humv").textContent, "48 %");
    eq("ams: drying off", t.r("dryv").textContent, "Off");
  }

  // --- filament left -------------------------------------------------------
  {
    const t = mount();
    eq("grams: A1 from the counter", t.r("g0").textContent, "984 g");
    eq("grams: bar of a 1 kg spool", t.r("gb0").style.getPropertyValue("--p"), "98.4%");
    eq("grams: AMS tag", t.r("tv-ams").textContent, "PLA · 984g");
    eq("grams: not low", t.r("sl0").classList.contains("low"), false);
    eq("grams: tooltip", t.r("sl0").getAttribute("data-tip").split("\n")[0], "AMS slot A1 — PLA · 984 g left");
    t.set({ "input_number.p2s_filament_a1": S("60") });
    eq("60 g: low", t.r("sl0").classList.contains("low"), true);
    t.set({ "input_number.p2s_filament_a1": S("0") });
    eq("0 g: out", t.r("sl0").classList.contains("out"), true);
    eq("0 g: not also low", t.r("sl0").classList.contains("low"), false);
    t.set({ "input_number.p2s_filament_a1": S("unavailable") });
    eq("no counter: says so", t.r("note0").textContent, "count unknown");
    eq("no counter: empty bar", t.r("gb0").style.getPropertyValue("--p"), "0%");
  }
  {
    // An RFID Bambu spool: the printer's remain % of its tray_weight wins.
    const t = mount({}, states({
      "sensor.p2s_ams_1_tray_2": S("Bambu PLA Basic", { slot: 2, active: false, color: "#FF6A13FF", empty: false,
        name: "Bambu PLA Basic", type: "PLA", remain: 37, tray_weight: "1000" }),
    }));
    eq("rfid: 37 % of 1000 g", t.r("g1").textContent, "370 g");
    eq("rfid: tap opens the tray, not a counter", t.r("sl1").getAttribute("data-more"), "sensor.p2s_ams_1_tray_2");
    eq("rfid: tooltip says so", /\(RFID\)/.test(t.r("sl1").getAttribute("data-tip")), true);
  }
  {
    // Short for the job: 46 % done of a 250 g job in A1 leaves 135 g to go.
    const st = RUNNING();
    st["sensor.p2s_print_weight"] = S("250", { "AMS 1 Tray 1": 250, unit_of_measurement: "g" });
    st["input_number.p2s_filament_a1"] = S("80");
    const t = mount({}, st);
    eq("short: issue line", t.r("hlist").textContent, "A1 has 80 g left; this job needs about 135 g more");
    eq("short: attention, not fault", t.r("health").classList.contains("warn"), true);
    eq("short: slot marked", t.r("sl0").classList.contains("short"), true);
    t.set({ "input_number.p2s_filament_a1": S("500") });
    eq("enough: no issue", t.r("health").hidden, true);
    eq("enough: slot unmarked", t.r("sl0").classList.contains("short"), false);
  }
  {
    // The Playground's filament-runout pause draws A1 empty and short.
    const t = mount({ debug_status_entity: SEL }, states({ [SEL]: S("pause") }));
    eq("pv pause: A1 out", t.r("sl0").classList.contains("out"), true);
    eq("pv pause: short line", /A1 has 0 g left/.test(t.r("hlist").textContent), true);
  }
  {
    const L = loadCard(FILE);
    const card = new L.Card();
    let err = null;
    try { card.setConfig({ remains: ["input_number.x"] }); } catch (e) { err = e.message; }
    eq("config: remains needs five", /remains must list five/.test(err || ""), true);
  }

  // --- HMS + print error, live ----------------------------------------------
  {
    const t = mount({}, states({
      "binary_sensor.p2s_hms_errors": S("on", { Count: 1, "1-Error": "Heatbed temperature is abnormal.", "1-Severity": "serious" }),
      "binary_sensor.p2s_print_error": S("on", { code: "0500-4002", error: "Print failed." }),
    }));
    eq("hms: shown", t.r("health").hidden, false);
    eq("hms: one line", t.r("hlist").textContent, "Print failed. (0500-4002)  ·  Heatbed temperature is abnormal.");
  }

  // --- tooltips: every element that has one, house format -------------------
  {
    for (const s of ["live", "idle", "prepare", "running", "pause", "finish", "failed", "offline"]) {
      const t = mount({ debug_status_entity: SEL }, states({ [SEL]: S(s) }));
      const hiddenUp = (el) => { for (let n = el; n && n.getAttribute; n = n.parentNode) if (n.hidden) return true; return false; };
      t.root.querySelectorAll("[data-more], [data-act], [data-tip]").forEach((el) => {
        if (hiddenUp(el)) return;
        const lines = (el.getAttribute("data-tip") || "").split("\n");
        const who = s + " " + (el.getAttribute("data-r") || el.getAttribute("data-act") || el.localName);
        if (lines.length < 3 || lines.length > 4) { eq(who + ": 3-4 lines", lines, "3-4 lines"); return; }
        if (!/ — /.test(lines[0])) eq(who + ": line 1 has a dash", lines[0], "<Name> — <state>");
        if (!/^E\.g\. /.test(lines[2])) eq(who + ": line 3 starts E.g.", lines[2], "E.g. …");
        lines.forEach((l) => { if (l.length > 90) eq(who + ": line under 90", l, "≤90 chars"); });
        if (el.hasAttribute("data-more") && !el.getAttribute("data-more")) eq(who + ": data-more names an entity", "", "entity");
        passed++;
      });
      eq(s + ": no native title", t.root.querySelectorAll("[title]").length, 0);
    }
  }

  // --- taps -----------------------------------------------------------------
  {
    const t = mount();
    fire(t.r("lightv"), "click");
    eq("light: toggles", t.card._hass.calls, [["light", "toggle", { entity_id: "light.p2s_chamber_light" }]]);
    fire(t.r("leftv"), "click");
    let ev = t.card.dispatched.filter((e) => e.type === "hass-more-info").pop();
    eq("tile: more-info", ev && ev.detail.entityId, "sensor.p2s_remaining_time");
    fire(t.r("tv-noz"), "click");
    ev = t.card.dispatched.filter((e) => e.type === "hass-more-info").pop();
    eq("nozzle tag: more-info", ev && ev.detail.entityId, "sensor.p2s_nozzle_temperature");
    fire(t.r("mat0"), "click");
    ev = t.card.dispatched.filter((e) => e.type === "hass-more-info").pop();
    eq("slot: tap opens its counter", ev && ev.detail.entityId, "input_number.p2s_filament_a1");
    fire(t.r("pvdoor"), "click");
    eq("door preview without Playground: nothing drawn", t.r("dooropen").getAttribute("opacity"), "0");
  }

  // --- photo mode -------------------------------------------------------------
  // ha-bambulab's bundle as the card reads it: the renders under hashed names.
  const BUNDLE = 'x={P2S:"/bambu_lab/images/P2S-91b06b81ed6c08bb.webp"};y="/bambu_lab/images/ams2-745f39126059db9e.webp";'
    + 'z="/bambu_lab/images/ams2pro-mech-b2bd80433f105f9b.png";w="/bambu_lab/images/ams2pro-brand-873c4b8d625cab23.png"';
  /** Mount with a fetch that serves `bundle` (or fails when it is null); counts the fetches. */
  async function mountP(config, st, bundle) {
    const L = loadCard(FILE);
    const fetches = [];
    L.sandbox.fetch = (url) => {
      fetches.push(url);
      return bundle === null ? Promise.reject(new Error("offline"))
        : Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(bundle) });
    };
    const card = new L.Card();
    card.setConfig(config);
    card.hass = mkHass(st || states());
    await flush();
    await flush();
    const root = card.shadowRoot;
    const r = (name) => root.querySelector('[data-r="' + name + '"]');
    const set = (over) => { card.hass = mkHass(Object.assign({}, card._hass.states, over)); };
    return { card, r, set, fetches };
  }
  // The wound filament's radius, as the card computes it (AM.r 66, AM.R 212, axle 232, housing edge 160).
  const spoolTop = (f) => 232 - Math.sqrt(66 * 66 + f * (212 * 212 - 66 * 66));
  {
    let t = await mountP({ art: "drawn" }, null, BUNDLE);
    eq("art drawn: no fetch", t.fetches.length, 0);
    eq("art drawn: drawn bed", !!t.r("bed") && !t.r("x-bed"), true);
    t = await mountP({}, null, BUNDLE);
    eq("photo by default", !!t.r("x-bed") && !t.r("bed"), true);
  }
  {
    const t = await mountP({ art: "photo" }, null, BUNDLE);
    eq("photo: the bundle is read", t.fetches, ["/bambu_lab/ha-bambulab-cards.js"]);
    eq("photo: the scene is in", !!t.r("x-bed") && !t.r("bed"), true);
    const imgs = t.card.shadowRoot.querySelectorAll("image").map((e) => e.getAttribute("href"));
    eq("photo: P2S render", imgs.indexOf("/bambu_lab/images/P2S-91b06b81ed6c08bb.webp") >= 0, true);
    eq("photo: AMS render", imgs.indexOf("/bambu_lab/images/ams2-745f39126059db9e.webp") >= 0, true);
    eq("photo: feeder layer", imgs.indexOf("/bambu_lab/images/ams2pro-mech-b2bd80433f105f9b.png") >= 0, true);
    // idle: bed where the render has it, head parked, no part, the screen says Ready
    eq("photo idle: bed at rest", t.r("x-bed").getAttribute("transform"), "translate(0 0.0)");
    eq("photo idle: head parked", t.r("x-head").getAttribute("transform"), "translate(-190 0)");
    eq("photo idle: head still", t.r("x-headrun").classList.contains("xh-run"), false);
    eq("photo idle: nothing revealed", t.r("x-reveal").getAttribute("height"), "0.0");
    eq("photo idle: screen", [t.r("x-st").textContent, t.r("x-big").textContent, t.r("x-sub").textContent],
      ["READY", "Ready", "N 19° B 17° C 22°"]);
    eq("photo idle: screen lit", t.r("x-scr").getAttribute("opacity"), "1");
    // slot 1: 984 of 1000 g, wound almost to the top; slots 2-4 empty
    eq("photo: slot 1 filament top", t.r("x-band0").getAttribute("y"), spoolTop(0.984).toFixed(1));
    eq("photo: slot 1 colour", t.r("x-band0").getAttribute("fill"), "#898989");
    eq("photo: empty slot hidden", t.r("x-spool1").getAttribute("opacity"), "0");
    // the AMS section's contents, now in the picture
    eq("photo: card marked photo", t.card.shadowRoot.querySelector("ha-card").classList.contains("photo"), true);
    eq("photo: A1 plate", [t.r("xbi0").textContent, t.r("xbm0").textContent, t.r("xbg0").textContent], ["A1", "PLA", "984 g"]);
    eq("photo: A1 plate colour", t.r("xbd0").getAttribute("fill"), "#898989");
    eq("photo: A1 plate bar", t.r("xbb0").getAttribute("width"), (92 * 0.984).toFixed(1));
    eq("photo: A2 plate", [t.r("xbi1").textContent, t.r("xbm1").textContent, t.r("xbg1").textContent], ["A2", "Empty", "Slot free"]);
    eq("photo: external plate", [t.r("xbi4").textContent, t.r("xbm4").textContent, t.r("xbg4").textContent], ["EXT", "Empty", "Holder free"]);
    eq("photo: external holder empty", [t.r("x-exspool").getAttribute("opacity"), t.r("x-exfree").getAttribute("opacity")], ["0", "1"]);
    eq("photo: A1 plate tooltip", t.r("xb0").getAttribute("data-tip"), t.r("sl0").getAttribute("data-tip"));
    fire(t.r("xbm0"), "click");
    let pev = t.card.dispatched.filter((e) => e.type === "hass-more-info").pop();
    eq("photo: A1 plate opens its counter", pev && pev.detail.entityId, "input_number.p2s_filament_a1");
    eq("photo: climate", [t.r("xav-hum").textContent, t.r("xav-tmp").textContent, t.r("xav-dry").textContent], ["48 %", "24.2 °C", "Off"]);
    eq("photo: climate tooltips", ["hum", "tmp", "dry"].map((k) => !!t.r("xa-" + k).getAttribute("data-tip")), [true, true, true]);
    fire(t.r("xav-hum"), "click");
    pev = t.card.dispatched.filter((e) => e.type === "hass-more-info").pop();
    eq("photo: humidity opens its sensor", pev && pev.detail.entityId, "sensor.p2s_ams_1_humidity");
    eq("photo: lid not drying", t.r("x-dry").getAttribute("opacity"), "0");
    t.set({ "binary_sensor.p2s_ams_1_drying": S("on"), "sensor.p2s_ams_1_remaining_drying_time": S("2.5") });
    eq("photo: drying", [t.r("xav-dry").textContent, t.r("x-dry").getAttribute("opacity")], ["2h 30m", "1"]);
    eq("photo: drying tooltip in full", /2 h 30 min left/.test(t.r("xa-dry").getAttribute("data-tip")), true);
    // a low slot, and a loaded external spool
    t.set({ "input_number.p2s_filament_a1": S("60"), "input_number.p2s_filament_ext": S("500"),
      "sensor.p2s_external_spool": S("PETG", { active: false, color: "#FF0000FF", empty: false, name: "PETG HF", type: "PETG" }) });
    eq("photo: low slot amber", t.r("xbg0").getAttribute("fill"), "#FFB547");
    eq("photo: external loaded", [t.r("xbm4").textContent, t.r("xbg4").textContent, t.r("x-exspool").getAttribute("opacity")], ["PETG", "500 g", "1"]);
    const exR = Math.sqrt(33 * 33 + 0.5 * (106 * 106 - 33 * 33));
    eq("photo: external spool by grams", t.r("x-exband").getAttribute("height"), (2 * exR).toFixed(1));
    t.set({ "input_number.p2s_filament_a1": S("984"), "input_number.p2s_filament_ext": S("0"),
      "binary_sensor.p2s_ams_1_drying": S("off"),
      "sensor.p2s_external_spool": S("?", { active: false, color: "#00000000", empty: true, name: "?", type: "?" }) });
    t.set({ "input_number.p2s_filament_a1": S("250") });
    eq("photo: 250 g left, lower", t.r("x-band0").getAttribute("y"), spoolTop(0.25).toFixed(1));
    eq("photo: band ends at the housing", Number(t.r("x-band0").getAttribute("y")) + Number(t.r("x-band0").getAttribute("height")), 160);
    t.set({ "input_number.p2s_filament_a1": S("0") });
    eq("photo: a loaded spool at 0 g still shows a sliver", t.r("x-band0").getAttribute("y"), spoolTop(0.06).toFixed(1));
    eq("photo: ... and visibly", Number(t.r("x-band0").getAttribute("height")) > 5, true);
    eq("photo: ... with a red 0 g plate", [t.r("xbg0").textContent, t.r("xbg0").getAttribute("fill")], ["0 g", "#FF7A6E"]);
    eq("photo: an empty slot shows no spool", t.r("x-band1").getAttribute("height"), "0.0");
    // printing layer 66 of 142, no plate image here: a block of 142 x 0.2 mm, 66/142 of it shown,
    // and the bed brought up so its top meets the nozzle (y 325; the bed's top is at 594)
    t.set(RUNNING());
    const h = 142 * 0.2 * 2.09;
    const shown = h * 66 / 142;
    eq("photo running: bed follows the layers", t.r("x-bed").getAttribute("transform"), "translate(0 " + (325 + shown - 594).toFixed(1) + ")");
    eq("photo running: bed tag rides along", t.r("x-bedtag").getAttribute("transform"), t.r("x-bed").getAttribute("transform"));
    eq("photo running: part revealed to the layer", t.r("x-reveal").getAttribute("height"), shown.toFixed(1));
    eq("photo running: block height", t.r("x-pblk1").getAttribute("height"), h.toFixed(1));
    eq("photo running: head sweeps", [t.r("x-head").getAttribute("transform"), t.r("x-headrun").classList.contains("xh-run")],
      ["translate(0 0)", true]);
    eq("photo running: slot 1 rolls", t.r("x-roll0").classList.contains("xs-run"), true);
    eq("photo running: AMS tube feeds", t.r("x-tube-ams").classList.contains("feed-run"), true);
    eq("photo running: external tube idle", t.r("x-tube-ext").classList.contains("feed-run"), false);
    eq("photo running: A1 plate feeding", [t.r("xbr0").getAttribute("stroke"), t.r("xbi0").getAttribute("fill")], ["#5AA9FF", "#5AA9FF"]);
    eq("photo running: screen", [t.r("x-st").textContent, t.r("x-job").textContent, t.r("x-big").textContent, t.r("x-sub").textContent],
      ["PRINTING", "Cable clips x8", "46%", "1h 03m · L66/142"]);
    eq("photo running: progress bar", t.r("x-barf").getAttribute("width"), (192 * 0.46).toFixed(1));
    // a later layer: the bed steps down
    t.set({ "sensor.p2s_current_layer": S("100") });
    eq("photo running: layer 100 is lower", t.r("x-bed").getAttribute("transform"),
      "translate(0 " + (325 + h * 100 / 142 - 594).toFixed(1) + ")");
    t.set({ "sensor.p2s_print_status": S("finish"), "sensor.p2s_current_layer": S("142") });
    eq("photo finish: all of it shown", t.r("x-reveal").getAttribute("height"), h.toFixed(1));
    eq("photo finish: head parked, still", [t.r("x-head").getAttribute("transform"), t.r("x-headrun").classList.contains("xh-run")],
      ["translate(-190 0)", false]);
    eq("photo finish: screen", [t.r("x-st").textContent, t.r("x-big").textContent], ["DONE", "Done"]);
    t.set({ "sensor.p2s_print_status": S("offline") });
    eq("photo offline: screen dark", t.r("x-scr").getAttribute("opacity"), "0");
    eq("photo offline: box greyed", t.r("vpbox").classList.contains("offline"), true);
    // back to drawn: the line drawing returns
    t.card.setConfig({ art: "drawn" });
    eq("photo → drawn: drawing back", !!t.r("bed") && !t.r("x-bed"), true);
  }
  {
    const t = await mountP({ art: "photo", debug_status_entity: SEL }, states({ [SEL]: S("prepare") }), BUNDLE);
    eq("photo prepare: bed at the nozzle", t.r("x-bed").getAttribute("transform"), "translate(0 " + (325 - 594).toFixed(1) + ")");
    eq("photo prepare: head centred", t.r("x-head").getAttribute("transform"), "translate(0 0)");
    eq("photo prepare: screen", [t.r("x-st").textContent, t.r("x-big").textContent, t.r("x-sub").textContent],
      ["PREPARING", "Heating", "N 152°/220° B 48°/65°"]);
    t.set({ [SEL]: S("failed") });
    eq("photo failed: screen", [t.r("x-st").textContent, t.r("x-big").textContent, t.r("x-sub").textContent],
      ["ERROR", "Error", "0300-8006"]);
    eq("photo failed: spaghetti", t.r("x-spag").getAttribute("opacity"), "1");
  }
  {
    // No bundle (ha-bambulab gone) or no P2S render in it: the line drawing stays.
    let t = await mountP({ art: "photo" }, null, null);
    eq("photo fallback, no bundle: drawing", !!t.r("bed") && !t.r("x-bed"), true);
    eq("photo fallback, no bundle: still patched", t.r("disp").textContent, "READY");
    t = await mountP({ art: "photo" }, null, "nothing here");
    eq("photo fallback, no render: drawing", !!t.r("bed") && !t.r("x-bed"), true);
  }

  // --- ideas (Playground layers) ----------------------------------------------
  const FSEL = "input_select.p2s_playground_fans";
  const ALL = ["fans", "fan_tag", "airflow", "thermal", "machine", "health"];
  /** RUNNING plus every sensor the ideas read, as the box had them on 13.11.2026. */
  const RICH = (over) => Object.assign(RUNNING(), {
    "sensor.p2s_cooling_fan_speed": S("100"),
    "sensor.p2s_heatbreak_fan_speed": S("100"),
    "sensor.p2s_aux_fan_speed": S("30"), // the right air-duct fan
    "sensor.p2s_secondary_aux_fan_speed": S("0"), // the optional left fan: never ran here
    "sensor.p2s_chamber_fan_speed": S("30"), // the P2S repeats the duct fan here
    "sensor.p2s_airduct_mode": S("cooling"),
    "sensor.p2s_nozzle_size": S("0.4"),
    "sensor.p2s_nozzle_type": S("hardened_steel"),
    "sensor.p2s_print_bed_type": S("textured_plate"),
    "binary_sensor.p2s_extruder_filament": S("on"),
    "sensor.p2s_print_length": S("6.85"),
    "sensor.p2s_start_time": S("2026-11-13T10:00:00+00:00"),
    "sensor.p2s_skipped_objects": S("0"),
    "sensor.p2s_printable_objects": S("8"),
    "sensor.p2s_ams_status": S("idle"),
    "sensor.p2s_ams_1_humidity_index": S("5"),
    "binary_sensor.p2s_timelapse": S("off"),
    "sensor.p2s_wi_fi_signal": S("-55"),
    "binary_sensor.p2s_firmware": S("off"),
    "sensor.p2s_sd_card_status": S("missing"),
    "sensor.p2s_total_usage": S("32.82"),
  }, over || {});
  const shown = (el) => el.getAttribute("display") === "inline";
  const spins = (el) => el.classList.contains("fan-var");
  {
    // Production, no ideas key: all six are on, with no Playground rows.
    const d = mount({ art: "drawn" }, RICH());
    eq("default: every idea on", ALL.map((k) => d.card._ideas()[k]), [true, true, true, true, true, true]);
    eq("default: wall fans and fan tag", [shown(d.r("f-aux")), shown(d.r("fantag"))], [true, true]);
    eq("default: toolhead fan at its %", [spins(d.r("fan")), d.r("fan").classList.contains("fan-run")], [true, false]);
    eq("default: Wi-Fi chip", d.r("hc-wifi").hidden, false);
    eq("default: no Playground rows", [d.r("pv").hidden, d.r("pv2").hidden], [true, true]);
  }
  {
    // ideas: [] opts out: nothing new shows, the toolhead fan keeps its 60 °C rule.
    const t = mount({ art: "drawn", ideas: [] }, RICH());
    eq("ideas off: no wall fans", ["f-aux", "f-aux2", "f-heatbreak"].map((k) => shown(t.r(k))), [false, false, false]);
    eq("ideas off: no speed-scaled spin anywhere", t.root.querySelectorAll(".fan-var").length, 0);
    eq("ideas off: no air flowing", t.root.querySelectorAll(".flow-run").length, 0);
    eq("ideas off: toolhead fan by temperature", t.r("fan").classList.contains("fan-run"), true);
    eq("ideas off: no fan tag", shown(t.r("fantag")), false);
    eq("ideas off: no fans cell", t.r("hs-fan").hidden, true);
    eq("ideas off: no health chips", ["hc-rec", "hc-fw", "hc-sd", "hc-wifi"].map((k) => t.r(k).hidden), [true, true, true, true]);
    eq("ideas off: no second preview row", t.r("pv2").hidden, true);
    eq("ideas off: no machine lines", [shown(t.r("tx-noz")), shown(t.r("tx-bed"))], [false, false]);
    eq("ideas off: filament line as before", t.r("filv").textContent, "11.7 g");
    eq("ideas off: humidity as before", t.r("humv").textContent, "48 %");
    // and a fan change alone does not redraw production
    const fp = t.card._fp;
    t.set({ "sensor.p2s_chamber_fan_speed": S("90") });
    eq("ideas off: fan change ignored", t.card._fp, fp);
  }
  {
    const t = mount({ art: "drawn", ideas: ALL }, RICH());
    // fans: each at its own speed; a stopped one shows but does not move
    eq("fans: duct and hotend fans shown", ["f-aux", "f-heatbreak"].map((k) => shown(t.r(k))), [true, true]);
    eq("fans: the left fan at 0 % is not drawn", shown(t.r("f-aux2")), false);
    eq("fans: no separate chamber fan, no air out of the roof", [t.r("f-chamber"), t.r("o-out1")], [null, null]);
    eq("fans: toolhead fan at its %", [spins(t.r("fan")), t.r("fan").classList.contains("fan-run"), t.r("fan").style.getPropertyValue("--spin")],
      [true, false, "0.30s"]);
    eq("fans: duct fan at 30 %", [spins(t.r("f-aux-b")), t.r("f-aux-b").style.getPropertyValue("--spin")], [true, "1.35s"]);
    eq("fans: left fan at 0 % stands still", spins(t.r("f-aux2-b")), false);
    eq("fans: duct fan sits high in the right wall", t.r("f-aux").getAttribute("transform"), "translate(502 232)");
    eq("fans: part-cooling jet", [shown(t.r("jet")), t.r("jet").getAttribute("opacity")], [true, "0.80"]);
    eq("fans: duct air on the print while cooling", [shown(t.r("g-r1")), t.r("g-r1").classList.contains("flow-run")], [true, true]);
    eq("fans: no left air at 0 %", shown(t.r("g-l1")), false);
    // airflow: cooling sends the air out of the back
    eq("airflow: outside air in while cooling", [shown(t.r("o-in1")), t.r("o-in1").classList.contains("flow-run")], [true, true]);
    eq("airflow: no recirculation while cooling", [shown(t.r("o-duct")), shown(t.r("o-loop"))], [false, false]);
    // fan tag and its strip cell
    eq("fan tag: shown", shown(t.r("fantag")), true);
    eq("fan tag: values", ["part", "heatbreak", "aux", "aux2", "chamber"].map((k) => t.r("ftv-" + k).textContent),
      ["100%", "100%", "30%", "0%", "30%"]);
    eq("fan tag: bars", [t.r("ftb-part").getAttribute("width"), t.r("ftb-aux").getAttribute("width")], ["40.0", "12.0"]);
    eq("fan tag: chamber row hidden while it repeats the duct", [shown(t.r("ft-chamber")), t.r("ft-box").getAttribute("height")], [false, "90"]);
    eq("fan tag: no AUX L row while the left fan reads 0", shown(t.r("ft-aux2")), false);
    eq("fan tag: three rows, no gaps", ["part", "heatbreak", "aux"].map((k) => t.r("ft-" + k).getAttribute("transform")),
      ["translate(0 0)", "translate(0 0)", "translate(0 0)"]);
    eq("fan tag: duct", t.r("ftv-duct").textContent, "COOLING");
    fire(t.r("ftv-aux"), "click");
    let ev = t.card.dispatched.filter((e) => e.type === "hass-more-info").pop();
    eq("fan tag: row opens its sensor", ev && ev.detail.entityId, "sensor.p2s_aux_fan_speed");
    eq("fan cell: part · duct", [t.r("hs-fan").hidden, t.r("hsv-fan").textContent], [false, "100·30"]);
    // thermal: nozzle at target, bed on its way (40 of 65)
    eq("thermal: nozzle bar full", [shown(t.r("tb-noz")), t.r("tb-noz").getAttribute("width")], [true, "126.0"]);
    eq("thermal: bed bar part way", t.r("tb-bed").getAttribute("width"), (126 * 40 / 65).toFixed(1));
    eq("thermal: no haze at 22 °C", shown(t.r("haze")), false);
    t.set({ "sensor.p2s_chamber_temperature": S("38") });
    eq("thermal: haze at 38 °C", [shown(t.r("haze")), t.r("haze").getAttribute("opacity")], [true, (12 / 60).toFixed(3)]);
    // machine
    eq("machine: nozzle line", t.r("tx-noz").textContent, "0.4 MM · HARDENED STEEL");
    eq("machine: plate line", t.r("tx-bed").textContent, "TEXTURED PEI PLATE");
    eq("machine: filament length", t.r("filv").textContent, "11.7 g · 6.8 m");
    eq("machine: start time", /76 layers to go · started \d\d:\d\d$/.test(t.r("togo").textContent), true);
    eq("machine: humidity index", t.r("humv").textContent, "48% L5");
    eq("machine: extruder dot", [shown(t.r("exdot")), t.r("exdot").getAttribute("fill")], [true, "#4FD1B0"]);
    t.set({ "sensor.p2s_skipped_objects": S("2"), "sensor.p2s_ams_status": S("changing_filament") });
    eq("machine: skipped objects", /2 of 8 skipped/.test(t.r("togo").textContent), true);
    eq("machine: AMS busy", t.r("ts-ams").textContent, "CHANGING FI");
    // health
    eq("health: Wi-Fi chip", [t.r("hc-wifi").hidden, t.r("hc-wifiv").textContent, t.r("wb3").getAttribute("opacity")], [false, "-55 dBm", "1"]);
    eq("health: nothing else to say", ["hc-rec", "hc-fw", "hc-sd"].map((k) => t.r(k).hidden), [true, true, true]);
    t.set({ "binary_sensor.p2s_timelapse": S("on"), "binary_sensor.p2s_firmware": S("on"),
      "sensor.p2s_sd_card_status": S("abnormal"), "sensor.p2s_wi_fi_signal": S("-80") });
    eq("health: chips when they matter", ["hc-rec", "hc-fw", "hc-sd"].map((k) => t.r(k).hidden), [false, false, false]);
    eq("health: weak Wi-Fi, one bar", [t.r("wb0").getAttribute("opacity"), t.r("wb1").getAttribute("opacity"), t.r("hc-wifi").classList.contains("warn")],
      ["1", "0.25", true]);
    eq("health: hours in the printer tooltip", /33 h printed/.test(t.r("vpbox").getAttribute("data-tip")), true);
    // heating duct: the air goes round instead of out
    t.set({ "sensor.p2s_airduct_mode": S("heating"), "sensor.p2s_aux_fan_speed": S("40") });
    eq("airflow: down the duct and round while heating", ["o-duct", "o-loop"].map((k) => [shown(t.r(k)), t.r(k).classList.contains("flow-run")]),
      [[true, true], [true, true]]);
    eq("airflow: no outside air while heating", shown(t.r("o-in1")), false);
    eq("fans: duct closed, no air on the print", shown(t.r("g-r1")), false);
    eq("fans: duct fan still spins", spins(t.r("f-aux-b")), true);
    t.set({ "sensor.p2s_chamber_fan_speed": S("10") });
    eq("fan tag: chamber row when it differs, moved up into AUX L's place",
      [shown(t.r("ft-chamber")), t.r("ft-chamber").getAttribute("transform"), t.r("ft-box").getAttribute("height")],
      [true, "translate(0 -20)", "110"]);
    eq("fan tag: heating", [t.r("ftv-duct").textContent, t.r("ftv-duct").getAttribute("fill")], ["HEATING", "#FFB066"]);
    // offline: everything stops and hides
    t.set({ "sensor.p2s_print_status": S("offline") });
    eq("offline: no moving parts", t.root.querySelectorAll(".fan-var").length + t.root.querySelectorAll(".flow-run").length, 0);
    eq("offline: wall fans hidden", shown(t.r("f-aux")), false);
    eq("offline: no health chips", ["hc-rec", "hc-fw", "hc-sd", "hc-wifi"].map((k) => t.r(k).hidden), [true, true, true, true]);
    // idle with fans at 0: nothing animates
    t.set(RICH({ "sensor.p2s_print_status": S("idle"), "sensor.p2s_cooling_fan_speed": S("0"),
      "sensor.p2s_heatbreak_fan_speed": S("0"), "sensor.p2s_aux_fan_speed": S("0"), "sensor.p2s_chamber_fan_speed": S("0") }));
    eq("idle, fans off: no animation", t.root.querySelectorAll(".fan-var").length + t.root.querySelectorAll(".flow-run").length, 0);
  }
  {
    // The Playground: fan scenarios and idea toggles on the Preview bar.
    const t = mount({ art: "drawn", ideas: ALL, debug_status_entity: SEL, debug_fans_entity: FSEL },
      RICH({ [SEL]: S("live"), [FSEL]: S("cool-down") }));
    eq("pv2: shown", t.r("pv2").hidden, false);
    eq("pv2: fan scenarios", t.r("fsegs").querySelectorAll(".seg").map((b) => b.textContent),
      ["live", "off", "PLA print", "PETG print", "chamber heating", "cool-down"]);
    eq("pv2: current scenario", t.r("fsegs").querySelectorAll(".seg")[5].getAttribute("aria-pressed"), "true");
    eq("pv2: idea toggles", t.r("isegs").querySelectorAll(".seg").map((b) => b.textContent),
      ["Fans", "Fan tag", "Airflow", "Thermal", "Machine", "Health"]);
    eq("scenario: mock chip", t.r("mock").hidden, false);
    eq("scenario: cool-down fans", ["part", "aux"].map((k) => t.r("ftv-" + k).textContent), ["0%", "100%"]);
    eq("scenario: no left fan anywhere", [shown(t.r("f-aux2")), shown(t.r("ft-aux2"))], [false, false]);
    eq("scenario: aux spins fast", t.r("f-aux-b").style.getPropertyValue("--spin"), "0.30s");
    // The fallback: should a left fan ever report, it comes back by itself.
    t.set({ [FSEL]: S("live"), "sensor.p2s_secondary_aux_fan_speed": S("60") });
    eq("left fan reporting: drawn, spinning, blowing on the print",
      [shown(t.r("f-aux2")), spins(t.r("f-aux2-b")), shown(t.r("g-l1")), t.r("g-l1").classList.contains("flow-run")], [true, true, true, true]);
    eq("left fan reporting: its tag row and cell", [shown(t.r("ft-aux2")), t.r("ftv-aux2").textContent, t.r("hsv-fan").textContent],
      [true, "60%", "100·30·60"]);
    t.set({ "sensor.p2s_secondary_aux_fan_speed": S("0") });
    fire(t.r("fsegs").querySelectorAll(".seg")[2], "click");
    eq("scenario: tap selects", t.card._hass.calls.pop(), ["input_select", "select_option", { entity_id: FSEL, option: "PLA print" }]);
    // a forced status brings its own fans when the scenario is live
    t.set({ [FSEL]: S("live"), [SEL]: S("prepare") });
    eq("forced prepare: only the hotend fan", ["part", "heatbreak", "aux"].map((k) => t.r("ftv-" + k).textContent), ["0%", "100%", "0%"]);
    // toggling Fans off draws the printer as production does
    fire(t.r("isegs").querySelectorAll(".seg")[0], "click");
    eq("toggle: Fans off", [shown(t.r("f-aux")), t.root.querySelectorAll(".fan-var").length], [false, 0]);
    eq("toggle: button shows it", t.r("isegs").querySelectorAll(".seg")[0].getAttribute("aria-pressed"), "false");
    eq("toggle: other ideas stay", shown(t.r("fantag")), true);
    fire(t.r("isegs").querySelectorAll(".seg")[0], "click");
    eq("toggle: Fans back", shown(t.r("f-aux")), true);
  }
  {
    // Photo mode carries the same layers.
    const t = await mountP({ ideas: ALL }, RICH(), BUNDLE);
    eq("photo ideas: in the scene", ["xf-aux", "xf-aux2", "xf-heatbreak", "fantag"].map((k) => shown(t.r(k))),
      [true, false, true, true]);
    eq("photo ideas: toolhead fan at its %", [spins(t.r("x-fan")), t.r("x-fan").classList.contains("fan-run")], [true, false]);
    eq("photo ideas: jet", shown(t.r("x-jet")), true);
    eq("photo ideas: outside air in", t.r("xo-in1").classList.contains("flow-run"), true);
    eq("photo ideas: duct air on the print", t.r("xg-r1").classList.contains("flow-run"), true);
    eq("photo ideas: duct fan right and high", t.r("xf-aux").getAttribute("transform"), "translate(600 282)");
    eq("photo ideas: fan % label", t.r("xf-aux-v").textContent, "30%");
  }

  // --- config ---------------------------------------------------------------
  {
    const L = loadCard(FILE);
    const card = new L.Card();
    let err = null;
    try { card.setConfig({ debug_status: "printing" }); } catch (e) { err = e.message; }
    eq("config: bad debug_status", /debug_status must be one of/.test(err || ""), true);
    err = null;
    try { card.setConfig({ camera_view: "hls" }); } catch (e) { err = e.message; }
    eq("config: bad camera_view", /camera_view/.test(err || ""), true);
    err = null;
    try { card.setConfig({ art: "3d" }); } catch (e) { err = e.message; }
    eq("config: bad art", /art must be drawn or photo/.test(err || ""), true);
    err = null;
    try { card.setConfig({ layer_height: 0 }); } catch (e) { err = e.message; }
    eq("config: bad layer_height", /layer_height/.test(err || ""), true);
    err = null;
    try { card.setConfig({ ideas: ["fans", "smoke"] }); } catch (e) { err = e.message; }
    eq("config: bad idea", /ideas must be a list of/.test(err || ""), true);
  }

  console.log((failed ? "FAILED" : "ok") + "  " + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
