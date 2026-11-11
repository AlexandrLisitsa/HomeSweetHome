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
    eq("running: fan spins (221 °C)", t.r("fan").classList.contains("fan-run"), true);
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
    eq("pv: eight segments", t.root.querySelectorAll(".seg").length, 8);
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
  }

  console.log((failed ? "FAILED" : "ok") + "  " + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
