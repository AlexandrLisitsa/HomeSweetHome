/**
 * Floor plan card.
 *
 * The isometric render of the flat, with each lamp's own light added onto it
 * as the lamp switches on, and the rooms' devices pinned where they stand. The
 * images come out of FloorPlan/ (see its README): one lights-off base, and per
 * lamp an overlay that is black except where that lamp adds light. Overlays are
 * *added* onto the base (`plus-lighter`), so any combination of lamps looks the
 * way the real ones do together.
 *
 * WHY NOT picture-elements
 * ------------------------
 * The stock card was the first version and fell short three ways: in a panel
 * view it is as wide as the screen and therefore taller than a Full HD one;
 * its style cannot follow an attribute, so a dimmable strip could only be on
 * or off in the picture; and it has no place for a brightness control.
 *
 * HOW BRIGHTNESS IS SHOWN
 * -----------------------
 *   - the light itself: the overlay's opacity follows brightness, so the room
 *     glows dimmer or brighter. Added light is linear in power, which is what
 *     opacity under plus-lighter is. The overlay was rendered at the lamp's
 *     normal power, so 100% = what the photo showed; a floor keeps 1% visible.
 *   - a ring gauge round the icon that fills with the level, and a glow in the
 *     lamp's colour that grows with it;
 *   - the number, under the icon, and a slider beside it while the lamp is on.
 *     Dragging previews the glow live and sends one call on release.
 *
 * DEVICES
 * -------
 * Anything else in a room: an A/C shows its mode and target and tints with the
 * mode, a plug shows the power it draws, a TV on/off, a sensor its reading.
 * An A/C with a `flow` (streamlines in pixels of the image, from make_dashboard.py)
 * shows its air leaving the unit while it runs, in the colour of its mode.
 * Tapping toggles what can be toggled (lights, switches, the TV) and opens the
 * dialog for the rest; holding always opens the dialog.
 *
 * TWO LAYOUTS, ONE CONFIG
 * -----------------------
 * Wide (a desktop, a tablet): the whole flat, sized to fit the screen's height,
 * everything on the plan. Narrow (under NARROW px of card width, i.e. a phone):
 * the whole flat at phone width is a thumbnail, so a row of room chips picks
 * what to show -- a room zooms the picture to that room's `focus` and lists only
 * its controls, as full-width rows under the picture; "All" shows the flat with
 * every row, grouped by room. The choice is remembered per device.
 *
 *   type: custom:floorplan-card
 *   image: /local/floorplan/base.png?v=1
 *   rooms:
 *     - { id: kitchen, name: Kitchen, focus: { x0: 53.5, y0: 10.2, x1: 100, y1: 63.5 } }
 *   lights:            # things with an overlay: light.*, switch.* (a relay), or a
 *                      # media_player.* whose screen glows; `color` sets the glow
 *     - { entity: light.kitchen, overlay: /local/floorplan/kitchen.png?v=1,
 *         x: 76.2, y: 21.6, room: kitchen, name: Ceiling, icon: mdi:ceiling-light }
 *   devices:           # everything else; `value` is an entity shown as the reading
 *     - { entity: climate.kitchen_ac, x: 80, y: 30, room: kitchen,
 *         flow: ["M 740 330 L 712 368 L 690 401", ...] }
 *     - { entity: switch.ac_plug, value: sensor.ac_plug_power, x: 82, y: 40, room: kitchen }
 *   badges:
 *     - { entities: [sensor.kitchen_temperature, sensor.kitchen_humidity],
 *         x: 70.8, y: 29.6, room: kitchen }
 *
 * x and y are % of the image (a flow alone is in its pixels); everything but
 * entity, x and y is optional.
 */

const CARD = "floorplan-card";
const VERSION = "1.5.0";

// Glow colour for a lamp that reports none: the warm white it was rendered in.
const WARM = [255, 180, 107];
// Lowest overlay opacity for a lamp that is on. Linear would make 1% invisible,
// and "on but you cannot see it" reads as broken.
const FLOOR = 0.12;
const HOLD_MS = 500;
// Card width below which the phone layout takes over.
const NARROW = 600;
const ROOM_KEY = CARD + ":room";
const TOGGLES = ["light", "switch", "input_boolean", "fan", "media_player"];

const HVAC = {
  cool: ["Cool", [79, 195, 247]],
  heat: ["Heat", [255, 138, 101]],
  dry: ["Dry", [255, 213, 79]],
  fan_only: ["Fan", [176, 190, 197]],
  auto: ["Auto", [129, 199, 132]],
  heat_cool: ["Auto", [129, 199, 132]],
};
const ON_GREEN = [102, 187, 106];
const MEDIA = [186, 104, 200];
const NEUTRAL = [144, 164, 174];
const SVG = "http://www.w3.org/2000/svg";
// One puff's trip along a stream; keep in step with `.flow path` in STYLE.
const BLOW_S = 2.6;

const DEFAULT_ICON = {
  light: "mdi:lightbulb", switch: "mdi:power-socket-eu", climate: "mdi:air-conditioner",
  media_player: "mdi:television", sensor: "mdi:router-wireless", fan: "mdi:fan",
};

class FloorplanCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._fingerprint = null;
    this._dragging = null;
    this._narrow = false;
    this._ar = null;
    try {
      this._room = window.localStorage.getItem(ROOM_KEY) || "all";
    } catch (e) {
      this._room = "all";
    }
  }

  setConfig(config) {
    if (!config || !config.image) throw new Error(CARD + ": image is required");
    const lights = config.lights || [];
    const devices = config.devices || [];
    const badges = config.badges || [];
    const rooms = (config.rooms || []).slice();
    for (const l of lights) {
      if (!l.entity || !l.overlay || l.x == null || l.y == null) {
        throw new Error(CARD + ": every light needs entity, overlay, x and y");
      }
    }
    for (const d of devices) {
      if (!d.entity || d.x == null || d.y == null) {
        throw new Error(CARD + ": every device needs entity, x and y");
      }
    }
    for (const b of badges) {
      if (!Array.isArray(b.entities) || !b.entities.length || b.x == null || b.y == null) {
        throw new Error(CARD + ": every badge needs entities (a list), x and y");
      }
    }
    // The single-room config of 1.1 (a top-level focus) still works: it is one room.
    if (!rooms.length && config.focus) rooms.push({ id: "main", name: "Rooms", focus: config.focus });
    for (const r of rooms) {
      const f = r.focus;
      if (!r.id || !f || !(f.x1 > f.x0 && f.y1 > f.y0)) {
        throw new Error(CARD + ": every room needs an id and a focus with x0 < x1, y0 < y1");
      }
    }
    this._config = { image: config.image, rooms, lights, devices, badges };
    if (this._room !== "all" && !rooms.some((r) => r.id === this._room)) this._room = "all";
    this._built = false;
    this._fingerprint = null;
    if (this._hass) this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._config) this._render();
  }

  connectedCallback() {
    if (!this._resize && window.ResizeObserver) {
      this._resize = new ResizeObserver((entries) => {
        const width = entries[0].contentRect.width;
        const narrow = width > 0 && width < NARROW;
        if (narrow !== this._narrow) {
          this._narrow = narrow;
          this._layout();
        }
      });
    }
    if (this._resize) this._resize.observe(this);
  }

  disconnectedCallback() {
    if (this._resize) this._resize.disconnect();
  }

  getCardSize() {
    return 12;
  }

  static getStubConfig() {
    return { image: "/local/floorplan/base.png", lights: [], devices: [], badges: [] };
  }

  // --- state reading -------------------------------------------------------

  _stateObj(id) {
    return (this._hass && this._hass.states && this._hass.states[id]) || null;
  }

  /** 0..1 for a lamp that is on, 0 for one that is not. Relays are 1 when on. */
  _level(st) {
    if (!this._isOn(st)) return 0;
    const b = st.attributes.brightness;
    return typeof b === "number" ? Math.max(0, Math.min(1, b / 255)) : 1;
  }

  _dimmable(st) {
    const modes = (st && st.attributes.supported_color_modes) || [];
    return modes.some((m) => m !== "onoff");
  }

  /** A lamp or relay is on when "on"; a TV lit as a lamp, whenever it is not off. */
  _isOn(st) {
    if (!st) return false;
    if ((st.entity_id || "").startsWith("media_player.")) {
      return ["off", "standby", "unavailable", "unknown"].indexOf(st.state) < 0;
    }
    return st.state === "on";
  }

  _rgb(st) {
    const c = st && st.attributes.rgb_color;
    return Array.isArray(c) && c.length === 3 ? c : WARM;
  }

  _domain(id) {
    return id.split(".")[0];
  }

  _name(cfgItem, entityId) {
    const st = this._stateObj(entityId);
    return cfgItem.name || (st && st.attributes.friendly_name) || entityId;
  }

  _number(st, digits) {
    if (!st || st.state === "" || isNaN(Number(st.state))) return "—";
    const unit = st.attributes.unit_of_measurement || "";
    const d = digits != null ? digits : unit === "%" || unit === "W" || /bit|B\/s/.test(unit) ? 0 : 1;
    return Number(st.state).toFixed(d) + (unit === "%" ? "%" : unit ? " " + unit : "");
  }

  /** What a device shows: short reading, whether it counts as active, its colour. */
  _deviceLook(cfgItem) {
    const st = this._stateObj(cfgItem.entity);
    const domain = this._domain(cfgItem.entity);
    const value = cfgItem.value ? this._stateObj(cfgItem.value) : null;
    if (!st || st.state === "unavailable") return { text: "Unavailable", active: false, rgb: NEUTRAL };
    if (domain === "climate") {
      if (st.state === "off") return { text: "Off", active: false, rgb: NEUTRAL };
      const [label, rgb] = HVAC[st.state] || [st.state, NEUTRAL];
      const t = st.attributes.temperature;
      return { text: label + (t != null ? " " + Math.round(t) + "°" : ""), active: true, rgb };
    }
    if (domain === "media_player") {
      const on = st.state !== "off" && st.state !== "standby";
      return { text: on ? "On" : "Off", active: on, rgb: MEDIA };
    }
    if (TOGGLES.indexOf(domain) >= 0) {
      const on = st.state === "on";
      return { text: value ? this._number(value) : on ? "On" : "Off", active: on, rgb: ON_GREEN };
    }
    return { text: this._number(value || st), active: true, rgb: NEUTRAL };
  }

  /**
   * Everything that can change what is drawn, in one string. `set hass` fires
   * on every state change in the house; without this an unrelated sensor
   * would restyle the plan.
   */
  _fingerprintOf() {
    const cfg = this._config;
    const s = (id) => {
      const st = id && this._stateObj(id);
      return st ? st.state : null;
    };
    return JSON.stringify([
      cfg.lights.map((l) => {
        const st = this._stateObj(l.entity);
        return st ? [st.state, st.attributes.brightness, st.attributes.rgb_color] : null;
      }),
      cfg.devices.map((d) => {
        const st = this._stateObj(d.entity);
        return [s(d.entity), st && st.attributes.temperature, st && st.attributes.hvac_action, s(d.value)];
      }),
      cfg.badges.map((b) => b.entities.map(s)),
    ]);
  }

  // --- interaction ---------------------------------------------------------

  _moreInfo(entityId) {
    this.dispatchEvent(new CustomEvent("hass-more-info", {
      detail: { entityId: entityId }, bubbles: true, composed: true,
    }));
  }

  _call(domain, service, data) {
    if (this._hass) this._hass.callService(domain, service, data);
  }

  /** Toggle what can be; open the dialog for the rest (an A/C, a TV, a sensor). */
  _tap(entityId) {
    if (TOGGLES.indexOf(this._domain(entityId)) >= 0) {
      this._call("homeassistant", "toggle", { entity_id: entityId });
    } else {
      this._moreInfo(entityId);
    }
  }

  /** Tap acts, hold opens the dialog. One pointer path for mouse and touch. */
  _bindPress(el, entityId) {
    let timer = null;
    let held = false;
    const cancel = () => { if (timer) window.clearTimeout(timer); timer = null; };
    el.addEventListener("pointerdown", (ev) => {
      if (ev.button !== undefined && ev.button !== 0) return;
      held = false;
      cancel();
      timer = window.setTimeout(() => { held = true; timer = null; this._moreInfo(entityId); }, HOLD_MS);
    });
    el.addEventListener("pointerup", () => {
      const wasTap = timer !== null && !held;
      cancel();
      if (wasTap) this._tap(entityId);
    });
    el.addEventListener("pointerleave", cancel);
    el.addEventListener("pointercancel", cancel);
    el.addEventListener("contextmenu", (ev) => ev.preventDefault());
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        this._tap(entityId);
      }
    });
  }

  _bindSlider(input, index, entityId) {
    input.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    input.addEventListener("input", () => {
      this._dragging = index;
      this._paintLight(index, Number(input.value) / 100, true);
    });
    input.addEventListener("change", () => {
      const pct = Number(input.value);
      this._dragging = null;
      if (pct <= 0) this._call("light", "turn_off", { entity_id: entityId });
      else this._call("light", "turn_on", { entity_id: entityId, brightness_pct: pct });
    });
  }

  _slider(index, entityId, cls) {
    const s = document.createElement("input");
    s.type = "range";
    s.min = "0";
    s.max = "100";
    s.step = "1";
    s.className = cls;
    this._bindSlider(s, index, entityId);
    return s;
  }

  _selectRoom(id) {
    this._room = id;
    try {
      window.localStorage.setItem(ROOM_KEY, id);
    } catch (e) { /* private window: the choice just is not remembered */ }
    this._layout();
  }

  // --- drawing -------------------------------------------------------------

  _el(tag, cls, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }

  /** An icon button, on the plan (`small` false) or in a row. */
  _button(entityId, small) {
    const btn = this._el("div", small ? "lamp small" : "lamp");
    btn.tabIndex = 0;
    btn.setAttribute("role", "button");
    const icon = this._el("ha-icon", null, btn);
    this._bindPress(btn, entityId);
    return { btn, icon };
  }

  /** A phone row: icon, name, value, and a switch when the thing can be toggled. */
  _row(item, withSwitch) {
    const row = this._el("div", "row");
    row.dataset.room = item.room || "";
    const head = this._el("div", "head", row);
    const b = this._button(item.entity, true);
    head.appendChild(b.btn);
    const name = this._el("div", "name", head);
    name.addEventListener("click", () => this._moreInfo(item.entity));
    const value = this._el("div", "value", head);
    let sw = null;
    if (withSwitch) {
      sw = this._el("button", "switch", head);
      sw.setAttribute("role", "switch");
      sw.addEventListener("click", () => this._call("homeassistant", "toggle", { entity_id: item.entity }));
    }
    return { row, rowLamp: b.btn, rowIcon: b.icon, name, value, sw };
  }

  _build() {
    const cfg = this._config;
    const root = this.shadowRoot;
    root.innerHTML = "";
    this._el("style", null, root).textContent = STYLE;

    const card = this._el("ha-card", null, root);
    // The stage is the window onto the picture; the plane is the picture with
    // everything pinned to it. Zooming moves and scales the plane, so the icons
    // and badges, placed in % of the plane, stay on the pixels they belong to.
    const stage = this._el("div", "stage", card);
    const plane = this._el("div", "plane", stage);
    const base = this._el("img", "base", plane);
    base.src = cfg.image;
    base.alt = "";
    base.addEventListener("load", () => {
      if (base.naturalWidth && base.naturalHeight) {
        this._ar = base.naturalWidth / base.naturalHeight;
        this._air.setAttribute("viewBox", `0 0 ${base.naturalWidth} ${base.naturalHeight}`);
        this._layout();
      }
    });

    const chips = this._el("div", "chips", card);
    this._chips = [{ id: "all", name: "All" }].concat(cfg.rooms).map((r) => {
      const c = this._el("button", "chip", chips);
      c.textContent = r.name || r.id;
      c.addEventListener("click", () => this._selectRoom(r.id));
      return { id: r.id, el: c };
    });
    const controls = this._el("div", "controls", card);
    // Rows are grouped under a header per room; unassigned things go last.
    const groups = {};
    const group = (roomId) => {
      const key = roomId || "";
      if (!groups[key]) {
        const g = this._el("div", "group", controls);
        g.dataset.room = key;
        const room = cfg.rooms.find((r) => r.id === roomId);
        this._el("div", "group-title", g).textContent = room ? room.name || room.id : "";
        groups[key] = g;
      }
      return groups[key];
    };
    for (const r of cfg.rooms) group(r.id);

    this._lights = cfg.lights.map((l, i) => {
      const overlay = this._el("img", "overlay", plane);
      overlay.src = l.overlay;
      overlay.alt = "";
      const spot = this._el("div", "spot", plane);
      spot.style.left = l.x + "%";
      spot.style.top = l.y + "%";
      spot.dataset.room = l.room || "";
      const b = this._button(l.entity, false);
      spot.appendChild(b.btn);
      const pct = this._el("div", "pct", spot);
      const slider = this._slider(i, l.entity, "slider");
      spot.appendChild(slider);
      const r = this._row(l, true);
      const rowSlider = this._slider(i, l.entity, "row-slider");
      r.row.appendChild(rowSlider);
      group(l.room).appendChild(r.row);
      return Object.assign({ cfg: l, overlay, spot, btn: b.btn, icon: b.icon, pct, slider, rowSlider }, r);
    });

    // Air sits over the picture and under every icon, which are added after it.
    // Its viewBox is the picture's own size once that is known, so a stream scales
    // evenly with the picture and its dash is a share of its own length.
    const air = document.createElementNS(SVG, "svg");
    air.setAttribute("class", "air");
    plane.appendChild(air);
    this._air = air;

    this._devices = cfg.devices.map((d) => {
      let flow = null;
      if (Array.isArray(d.flow) && d.flow.length) {
        flow = document.createElementNS(SVG, "g");
        flow.setAttribute("class", "flow");
        flow.dataset.room = d.room || "";
        d.flow.forEach((path, i) => {
          // Two puffs per stream, half a cycle apart, each stream a little out of step.
          for (const half of [0, 0.5]) {
            const p = document.createElementNS(SVG, "path");
            p.setAttribute("d", path);
            p.setAttribute("pathLength", "100");
            p.style.animationDelay = -((i * 0.37 + half) % 1) * BLOW_S + "s";
            flow.appendChild(p);
          }
        });
        air.appendChild(flow);
      }
      const spot = this._el("div", "spot", plane);
      spot.style.left = d.x + "%";
      spot.style.top = d.y + "%";
      spot.dataset.room = d.room || "";
      const b = this._button(d.entity, false);
      b.btn.classList.add("device");
      spot.appendChild(b.btn);
      const label = this._el("div", "pct", spot);
      const r = this._row(d, TOGGLES.indexOf(this._domain(d.entity)) >= 0);
      r.rowLamp.classList.add("device");
      group(d.room).appendChild(r.row);
      return Object.assign({ cfg: d, spot, btn: b.btn, icon: b.icon, label, flow }, r);
    });

    this._badges = cfg.badges.map((b) => {
      const el = this._el("div", "badge", plane);
      el.style.left = b.x + "%";
      el.style.top = b.y + "%";
      el.dataset.room = b.room || "";
      el.addEventListener("click", () => this._moreInfo(b.entities[0]));
      const row = this._el("div", "row info");
      row.dataset.room = b.room || "";
      const rowIcon = this._el("ha-icon", "info-icon", row);
      rowIcon.setAttribute("icon", "mdi:thermometer");
      const rowName = this._el("div", "name", row);
      const rowValue = this._el("div", "value", row);
      row.addEventListener("click", () => this._moreInfo(b.entities[0]));
      group(b.room).appendChild(row);
      return { cfg: b, el, rowName, rowValue };
    });

    this._card = card;
    this._stage = stage;
    this._plane = plane;
    this._groups = groups;
    this._built = true;
    this._layout();
  }

  /** Wide: the whole flat, fitted to the screen. Narrow: the chosen room, zoomed. */
  _layout() {
    if (!this._built) return;
    const ar = this._ar || 1.4928;
    const room = this._config.rooms.find((r) => r.id === this._room);
    const zoomed = this._narrow && !!room;
    this._card.classList.toggle("narrow", this._narrow);
    this._card.classList.toggle("zoomed", zoomed);
    this._card.classList.toggle("has-rooms", this._config.rooms.length > 0);
    for (const c of this._chips) c.el.classList.toggle("active", c.id === (room ? room.id : "all"));

    const s = this._stage.style;
    const p = this._plane.style;
    if (zoomed) {
      const f = room.focus;
      const fw = (f.x1 - f.x0) / 100;
      const fh = (f.y1 - f.y0) / 100;
      s.setProperty("--ar", String((ar * fw) / fh));
      p.width = 100 / fw + "%";
      p.height = 100 / fh + "%";
      p.left = (-f.x0 / fw) + "%";
      p.top = (-f.y0 / fh) + "%";
    } else {
      s.setProperty("--ar", String(ar));
      p.width = "100%";
      p.height = "100%";
      p.left = "0";
      p.top = "0";
    }
    // On a phone with a room chosen, only that room's rows (and its group title
    // hidden, the chip already says it); with "All", every group with its title.
    const only = zoomed ? room.id : null;
    for (const [key, g] of Object.entries(this._groups)) {
      g.hidden = only !== null && key !== only;
      g.classList.toggle("titled", only === null && !!key);
    }
    // A zoom box is a rectangle and rooms are not, so neighbours show at its edges:
    // their icons would be controls for a room that is not the one chosen.
    for (const el of this._plane.querySelectorAll(".spot, .badge, .flow")) {
      el.classList.toggle("elsewhere", only !== null && el.dataset.room !== only);
    }
  }

  /** Overlay, rings, glow, numbers and sliders for one lamp at `level` (0..1). */
  _paintLight(index, level, preview) {
    const L = this._lights[index];
    const st = this._stateObj(L.cfg.entity);
    const on = preview ? level > 0 : this._isOn(st);
    const dimmable = this._dimmable(st);
    // A configured colour wins: the TV's glow is blue whatever the TV reports.
    const [r, g, b] = Array.isArray(L.cfg.color) ? L.cfg.color : this._rgb(st);
    L.overlay.style.opacity = on ? String(FLOOR + (1 - FLOOR) * level) : "0";
    // On the spot and the row, not the buttons: the sliders take the colour too.
    for (const el of [L.spot, L.row]) {
      el.style.setProperty("--level", String(on ? level : 0));
      el.style.setProperty("--glow", `rgb(${r}, ${g}, ${b})`);
    }
    L.btn.classList.toggle("on", on);
    L.rowLamp.classList.toggle("on", on);
    const pct = Math.round(level * 100);
    L.pct.textContent = on && dimmable ? pct + "%" : "";
    L.value.textContent = !st || st.state === "unavailable" ? "Unavailable"
      : on ? (dimmable ? pct + "%" : "On") : "Off";
    L.sw.classList.toggle("on", on);
    L.sw.setAttribute("aria-checked", on ? "true" : "false");
    if (!preview) {
      L.slider.value = String(pct);
      L.rowSlider.value = String(pct);
    }
  }

  _render() {
    if (!this._hass || !this._config) return;
    if (!this._built) this._build();
    const fp = this._fingerprintOf();
    if (fp === this._fingerprint) return;
    this._fingerprint = fp;

    this._lights.forEach((L, i) => {
      const st = this._stateObj(L.cfg.entity);
      const name = this._name(L.cfg, L.cfg.entity);
      const icon = L.cfg.icon || (st && st.attributes.icon) || "mdi:lightbulb";
      L.icon.setAttribute("icon", icon);
      L.rowIcon.setAttribute("icon", icon);
      L.name.textContent = name;
      L.sw.setAttribute("aria-label", name);
      for (const el of [L.btn, L.rowLamp]) {
        el.title = name;
        el.setAttribute("aria-label", name);
      }
      const unavailable = !st || st.state === "unavailable";
      L.btn.classList.toggle("unavailable", unavailable);
      L.row.classList.toggle("unavailable", unavailable);
      const dimmable = this._dimmable(st) && this._domain(L.cfg.entity) === "light";
      L.spot.classList.toggle("dimmable", dimmable && !!st && st.state === "on");
      L.row.classList.toggle("dimmable", dimmable);
      if (this._dragging !== i) this._paintLight(i, this._level(st), false);
    });

    this._devices.forEach((D) => {
      const st = this._stateObj(D.cfg.entity);
      const name = this._name(D.cfg, D.cfg.entity);
      const icon = D.cfg.icon || (st && st.attributes.icon) || DEFAULT_ICON[this._domain(D.cfg.entity)] || "mdi:help-circle";
      const look = this._deviceLook(D.cfg);
      const rgb = `rgb(${look.rgb[0]}, ${look.rgb[1]}, ${look.rgb[2]})`;
      D.icon.setAttribute("icon", icon);
      D.rowIcon.setAttribute("icon", icon);
      D.name.textContent = name;
      for (const el of [D.btn, D.rowLamp]) {
        el.title = name + ": " + look.text;
        el.setAttribute("aria-label", name);
        el.classList.toggle("on", look.active);
        el.classList.toggle("unavailable", !st || st.state === "unavailable");
      }
      for (const el of [D.spot, D.row]) {
        el.style.setProperty("--level", look.active ? "1" : "0");
        el.style.setProperty("--glow", rgb);
      }
      if (D.flow) {
        // Blowing whenever it is on, unless it says it is not: a unit resting at its
        // target still moves air. Only some integrations report hvac_action.
        const action = st && st.attributes.hvac_action;
        const blowing = look.active && this._domain(D.cfg.entity) === "climate" && action !== "off";
        D.flow.classList.toggle("on", blowing);
        D.flow.style.setProperty("--glow", rgb);
      }
      D.label.textContent = look.text === "Off" ? "" : look.text;
      D.value.textContent = look.text;
      if (D.sw) {
        // look.active, not state === "on": a TV that is playing is on too.
        D.sw.classList.toggle("on", look.active);
        D.sw.setAttribute("aria-checked", look.active ? "true" : "false");
        D.sw.setAttribute("aria-label", name);
      }
    });

    this._badges.forEach((B) => {
      const text = B.cfg.entities.map((id) => this._number(this._stateObj(id))).join(" · ");
      B.el.textContent = text;
      B.rowValue.textContent = text;
      B.rowName.textContent = B.cfg.name || "Climate";
    });
  }
}

const STYLE = `
:host { display: block; }
ha-card { overflow: hidden; background: #1c1c1c; }
.stage {
  --ar: 1.4928;
  position: relative;
  overflow: hidden;
  /* Whichever is smaller: the card's width, or the width at which the whole
     picture fits the height left under the toolbar. */
  width: min(100%, calc((100vh - var(--header-height, 56px) - 16px) * var(--ar)));
  aspect-ratio: var(--ar);
  margin: 0 auto;
  user-select: none;
  -webkit-user-select: none;
}
.narrow .stage { width: 100%; }
.plane { position: absolute; left: 0; top: 0; width: 100%; height: 100%; }
.base, .overlay {
  position: absolute; inset: 0; width: 100%; height: 100%;
  display: block; pointer-events: none;
}
.overlay {
  mix-blend-mode: plus-lighter;
  opacity: 0;
  transition: opacity 0.6s ease;
}
@supports not (mix-blend-mode: plus-lighter) {
  .overlay { mix-blend-mode: screen; }
}
.air {
  position: absolute; inset: 0; width: 100%; height: 100%;
  overflow: visible; pointer-events: none;
}
/* A stream is a short dash travelling its path, fading in off the outlet and out
   into the room. pathLength is 100 on every path, so the dash is a share of it. */
.flow { opacity: 0; transition: opacity 0.8s ease; }
.flow.on { opacity: 1; }
.flow.elsewhere { display: none; }
.flow path {
  fill: none;
  stroke: var(--glow);
  stroke-width: 3;
  stroke-linecap: round;
  stroke-dasharray: 22 178;
  stroke-dashoffset: 22;
  filter: drop-shadow(0 0 3px var(--glow));
  opacity: 0;
  animation: blow 2.6s linear infinite;
  animation-play-state: paused;
}
.flow.on path { animation-play-state: running; }
@keyframes blow {
  0%   { stroke-dashoffset: 22;  opacity: 0; }
  15%  { opacity: 0.9; }
  70%  { opacity: 0.6; }
  100% { stroke-dashoffset: -100; opacity: 0; }
}
/* Without motion: the streams stand still, faint, so the mode still shows. */
@media (prefers-reduced-motion: reduce) {
  .flow path { animation: none; stroke-dasharray: none; opacity: 0.45; }
}
.narrow:not(.zoomed) .flow path { stroke-width: 4; }
.spot, .row {
  --level: 0;
  --glow: rgb(255, 180, 107);
}
.spot {
  position: absolute;
  transform: translate(-50%, -50%);
  display: flex; flex-direction: column; align-items: center;
}
.lamp {
  position: relative;
  width: 40px; height: 40px; border-radius: 50%;
  display: grid; place-items: center; flex: none;
  cursor: pointer; touch-action: manipulation;
  color: rgba(255, 255, 255, 0.75);
  background:
    radial-gradient(circle, rgba(20, 20, 20, 0.82) 62%, transparent 63%),
    conic-gradient(var(--glow) calc(var(--level) * 360deg), rgba(255, 255, 255, 0.18) 0);
  transition: box-shadow 0.6s ease, color 0.3s ease;
}
.lamp.on {
  color: var(--glow);
  box-shadow: 0 0 calc(4px + var(--level) * 22px) calc(var(--level) * 6px) var(--glow);
}
/* A device is not a light source: its colour says its state, it does not glow. */
.lamp.device { width: 34px; height: 34px; }
.lamp.device.on { box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.35); }
.lamp.device ha-icon { --mdc-icon-size: 19px; }
.lamp.unavailable, .row.unavailable { opacity: 0.4; }
.lamp:focus-visible, .switch:focus-visible, .chip:focus-visible {
  outline: 2px solid var(--primary-color, #03a9f4); outline-offset: 2px;
}
.lamp ha-icon { --mdc-icon-size: 22px; pointer-events: none; }
.pct {
  margin-top: 3px; min-height: 14px; white-space: nowrap;
  font: 600 11px/14px var(--paper-font-body1_-_font-family, sans-serif);
  color: #fff; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
}
.slider { display: none; }
.spot.dimmable .slider {
  display: block;
  position: absolute; left: calc(100% + 6px); top: 12px;
  width: 110px; margin: 0;
  accent-color: var(--glow, #ffb46b);
  cursor: pointer;
}
/* On a phone the controls live in the rows; the plan keeps icons and numbers. */
.narrow .spot.dimmable .slider { display: none; }
.narrow:not(.zoomed) .lamp:not(.small) { width: 24px; height: 24px; }
.narrow:not(.zoomed) .lamp:not(.small) ha-icon { --mdc-icon-size: 14px; }
.narrow:not(.zoomed) .pct, .narrow:not(.zoomed) .badge { display: none; }
.spot.elsewhere, .badge.elsewhere { display: none; }
.badge {
  position: absolute;
  transform: translate(-50%, -50%);
  padding: 3px 10px; border-radius: 12px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff; white-space: nowrap; cursor: pointer;
  font: 600 13px/18px var(--paper-font-body1_-_font-family, sans-serif);
}

/* --- the phone chips and rows ------------------------------------------ */
.chips, .controls { display: none; }
.narrow.has-rooms .chips {
  display: flex; gap: 8px; overflow-x: auto; padding: 10px 12px 2px;
  scrollbar-width: none;
}
.chips::-webkit-scrollbar { display: none; }
.chip {
  flex: none; border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 16px;
  padding: 6px 14px; background: transparent; cursor: pointer;
  color: var(--primary-text-color, #e1e1e1);
  font: 500 14px/18px var(--paper-font-body1_-_font-family, sans-serif);
}
.chip.active { background: var(--primary-color, #03a9f4); border-color: transparent; color: #fff; }
.narrow .controls { display: block; padding: 4px 12px 8px; }
.group[hidden] { display: none; }
.group-title { display: none; }
.group.titled .group-title {
  display: block; padding: 14px 0 2px;
  color: var(--secondary-text-color, #9e9e9e);
  font: 600 12px/16px var(--paper-font-body1_-_font-family, sans-serif);
  text-transform: uppercase; letter-spacing: 0.06em;
}
.row {
  padding: 8px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  color: var(--primary-text-color, #e1e1e1);
  font: 400 15px/20px var(--paper-font-body1_-_font-family, sans-serif);
}
.group-title + .row, .group > .row:first-child { border-top: 0; }
.head { display: flex; align-items: center; gap: 12px; min-height: 44px; }
.lamp.small { width: 36px; height: 36px; }
.lamp.small ha-icon { --mdc-icon-size: 20px; }
.name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.value { color: var(--secondary-text-color, #9e9e9e); font-variant-numeric: tabular-nums; white-space: nowrap; }
.switch {
  position: relative; flex: none;
  width: 48px; height: 28px; border-radius: 14px; border: 0; padding: 0;
  background: rgba(255, 255, 255, 0.22); cursor: pointer;
  transition: background 0.2s ease;
}
.switch::after {
  content: ""; position: absolute; left: 3px; top: 3px;
  width: 22px; height: 22px; border-radius: 50%; background: #fff;
  transition: transform 0.2s ease;
}
.switch.on { background: var(--glow); }
.switch.on::after { transform: translateX(20px); }
.row-slider { display: none; }
.row.dimmable .row-slider {
  display: block; width: 100%; margin: 10px 0 2px; height: 28px;
  accent-color: var(--glow, #ffb46b); cursor: pointer;
}
.row.info { display: flex; align-items: center; gap: 12px; min-height: 44px; cursor: pointer; }
.info-icon { --mdc-icon-size: 20px; width: 36px; display: grid; place-items: center; color: var(--secondary-text-color, #9e9e9e); }
.row.info .value { color: var(--primary-text-color, #e1e1e1); font-weight: 600; }
`;

if (!customElements.get(CARD)) customElements.define(CARD, FloorplanCard);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === CARD)) {
  window.customCards.push({
    type: CARD,
    name: "Floor plan",
    description: "Isometric render of the flat; each lamp lights its room as it "
      + "switches on, dimmable ones in proportion, devices where they stand, and "
      + "room-by-room zoom on a phone.",
    preview: false,
  });
}
console.info(`%c ${CARD} %c ${VERSION} `, "background:#ffb46b;color:#000", "");
