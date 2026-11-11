// Satin ribbon case: five rolls in a row, AMS style.
// One PLA base split into 5 bays, one clear PETG lid hinged at the back.
// Both parts are 278 mm long and print flat, turned 45 deg on the 256 mm P2S plate.
//
// Render: Prints/tools/scad_render.ps1 Prints/RibbonBox/ribbon_box.scad -Part <name>
//   parts: base, lid, axle; plates: plate_pla, lid45; views: assembly, open, exploded, section, hinge_section
// Coordinates: the inner cavity starts at x=0, y=0 (front wall at y<0), z=floor.

include <BOSL2/std.scad>

part = "assembly";

/* [Roll, measured from photos: confirm with a caliper] */
roll_d   = 76;    // outer diameter of a full roll
roll_w   = 50;    // ribbon width
core_od  = 24;    // cardboard core, outside
core_id  = 18;    // cardboard core, inside

/* [Case] */
n_bays   = 5;
side_gap = 1;     // roll side to divider, each side
div_t    = 3;     // divider between bays
W        = 2.4;   // front/back wall
We       = 3.0;   // end walls (hold the outer journal pockets)
F        = 2.0;   // floor
T        = 2.0;   // lid top
r_out    = 10;    // outer vertical corner rounding
r_in     = 7;     // inner corner rounding
fit      = 0.25;  // sliding clearance (lip)
bot_gap  = 4;     // floor to full roll
top_gap  = 3;     // full roll to lid ceiling: keeps the axle in its cradle
fb_gap   = 4;     // roll to front/back wall

BW = roll_w + 2 * side_gap;                       // bay width 52
IX = n_bays * BW + (n_bays - 1) * div_t;          // 272
IY = roll_d + 2 * fb_gap;                         // 84
IZ = roll_d + bot_gap + top_gap;                  // 83
ax_y = IY / 2;
ax_z = F + bot_gap + roll_d / 2;                  // axle centre height (44)
function bay_x0(i) = i * (BW + div_t);            // left inner face of bay i
function div_x0(j) = bay_x0(j) - div_t;           // left face of divider j (1..n-1)

/* [Axle] */
axle_d   = core_id - 1;   // 17, roll spins freely on it
jr       = 4;             // journal radius
slot_w   = 2 * jr + 0.6;  // cradle slot width
body_l   = BW - 1;        // 0.5 mm to each divider face
jl       = 1.7;           // journal length: 0.5 gap + 1.2 into the divider/wall
pocket_d = 1.6;           // journal pocket depth in the end walls
cone     = (axle_d - 2 * jr) / 2;   // 45 deg shoulder, prints standing without support

/* [Lid joint] */
z_s      = ax_z + jr + 6; // base wall top / lid bottom (54)
lip_t    = 1.0;
lip_h    = 5;
top_z    = F + IZ + T;    // outer top of the lid (87)

/* [Pull slots] */
slot_len = roll_w + 1.5;
slot_gap = 3.0;           // vertical; ~2.1 mm across the 45 deg channel
slot_z   = F + 5.5;       // channel centre (mid-wall), just above a full roll's bottom
slot_ch  = 0.6;           // chamfer on the two sharp (45 deg) edges, kind to satin
// The slot climbs 45 deg through the wall (inside low, outside high), so every
// layer of its ceiling sits on the one below: no 52 mm bridge, which Studio
// flags as a "floating cantilever".

/* [Snap] */
snap_bump = 0.8;
bump_w    = 10;
tab_w     = 16;
tab_t     = 1.6;
snap_x    = [IX * 0.2, IX * 0.8];

/* [Hinge] */
hk_r     = 3.5;                    // knuckle radius
hy       = IY + W + 0.3 + hk_r;    // hinge axis y (z = z_s)
pin_d    = 2.0;                    // for a 1.75 mm filament pin
hk_n     = 7;                      // segments: base, lid, base ... base
hk_gap   = 0.4;
hk_x0    = 40;
hk_x1    = IX - 40;
hk_len   = (hk_x1 - hk_x0 - (hk_n - 1) * hk_gap) / hk_n;
function hk_seg_x(k) = hk_x0 + k * (hk_len + hk_gap);

$fn = 64;
eps = 0.01;

// ---------------------------------------------------------------- 2D outlines
module rrect(x0, y0, x1, y1, r) {
  translate([x0 + r, y0 + r]) offset(r = r) square([x1 - x0 - 2 * r, y1 - y0 - 2 * r]);
}
module outer2d() { rrect(-We, -W, IX + We, IY + W, r_out); }
module cav2d(grow = 0) { offset(delta = grow) rrect(0, 0, IX, IY, r_in); }
module slab(z0, z1) { translate([0, 0, z0]) linear_extrude(z1 - z0) children(); }

module both_faces() { children(); translate([0, IY, 0]) mirror([0, 1, 0]) children(); }

// ---------------------------------------------------------------- base (PLA)
module snap_bump(x) {
  hull() {
    translate([x - bump_w / 2, -W - snap_bump, z_s - 8]) cube([bump_w, snap_bump, eps]);
    translate([x - bump_w / 2, -W - eps, z_s - 4]) cube([bump_w, eps, eps]);
  }
}
module base_knuckle(k) {
  x = hk_seg_x(k);
  difference() {
    hull() {
      translate([x, hy, z_s]) rotate([0, 90, 0]) cylinder(r = hk_r, h = hk_len);
      translate([x, IY + W - eps, z_s - 14]) cube([hk_len, eps, 14]);   // 45 deg gusset
    }
    translate([x - 1, hy, z_s]) rotate([0, 90, 0]) cylinder(d = pin_d, h = hk_len + 2, $fn = 24);
  }
}
module cradle_cut(x0, w) {   // U-slot open at the top, through w in x
  hull() {
    translate([x0, ax_y, ax_z]) rotate([0, 90, 0]) cylinder(r = slot_w / 2, h = w);
    translate([x0, ax_y - slot_w / 2, z_s]) cube([w, slot_w, lip_h + 2]);
  }
}
module base() {
  difference() {
    union() {
      difference() {
        slab(0, z_s) outer2d();
        slab(F, z_s + 1) cav2d();
      }
      slab(z_s - eps, z_s + lip_h) difference() { cav2d(lip_t); cav2d(); }
      for (j = [1 : n_bays - 1]) translate([div_x0(j), 0, F - eps]) cube([div_t, IY, z_s - F + eps]);
      for (x = snap_x) snap_bump(x);
      for (k = [0 : 2 : hk_n - 1]) base_knuckle(k);
    }
    // cradles: through each divider, blind pockets in the end walls
    for (j = [1 : n_bays - 1]) cradle_cut(div_x0(j) - 1, div_t + 2);
    cradle_cut(-pocket_d, pocket_d + 1);
    cradle_cut(IX - 1, pocket_d + 1);
    // one pull slot per bay: a 45 deg channel, sharp edges chamfered
    zi = slot_z - W / 2 - slot_gap / 2;   // bottom of the inner opening
    for (i = [0 : n_bays - 1])
      hull() {
        translate([bay_x0(i) + BW / 2 - slot_len / 2, -eps, zi]) cube([slot_len, 2 * eps, slot_gap + slot_ch]);
        translate([bay_x0(i) + BW / 2 - slot_len / 2, -W - eps, zi + W - slot_ch]) cube([slot_len, 2 * eps, slot_gap + slot_ch]);
      }
    // clearance for the lid's knuckles
    for (k = [1 : 2 : hk_n - 1])
      translate([hk_seg_x(k) - hk_gap, hy, z_s]) rotate([0, 90, 0]) cylinder(r = hk_r + 0.4, h = hk_len + 2 * hk_gap);
  }
}

// ---------------------------------------------------------------- lid (clear PETG)
module snap_tab(x) {
  difference() {
    union() {
      translate([x - tab_w / 2, -W - tab_t, z_s - 12]) cube([tab_w, tab_t, 20]);
      translate([x - tab_w / 2, -W - tab_t - 1, z_s - 12]) cube([tab_w, 1 + eps, 1.6]);   // thumb grip
    }
    translate([x - (bump_w + 1) / 2, -W - tab_t - 2, z_s - 8.3]) cube([bump_w + 1, tab_t + 3, 4.8]);
  }
}
module lid_knuckle(k) {
  x = hk_seg_x(k);
  difference() {
    hull() {
      translate([x, hy, z_s]) rotate([0, 90, 0]) cylinder(r = hk_r, h = hk_len);
      translate([x, IY + W - eps, z_s]) cube([hk_len, eps, 14]);          // gusset, prints upside down
    }
    translate([x - 1, hy, z_s]) rotate([0, 90, 0]) cylinder(d = pin_d, h = hk_len + 2, $fn = 24);
  }
}
module lid() {
  difference() {
    union() {
      difference() {
        slab(z_s, top_z) outer2d();
        slab(z_s - 1, F + IZ) cav2d();
        slab(z_s - 1, z_s + lip_h + 0.3) cav2d(lip_t + fit);
      }
      // dividers that close each bay up to the ceiling
      for (j = [1 : n_bays - 1])
        translate([div_x0(j) + 0.3, 0.3, z_s + 0.3]) cube([div_t - 0.6, IY - 0.6, F + IZ - z_s - 0.3 + eps]);
      for (x = snap_x) snap_tab(x);
      for (k = [1 : 2 : hk_n - 1]) lid_knuckle(k);
    }
    // clearance for the base's knuckles
    for (k = [0 : 2 : hk_n - 1])
      translate([hk_seg_x(k) - hk_gap, hy, z_s]) rotate([0, 90, 0]) cylinder(r = hk_r + 0.4, h = hk_len + 2 * hk_gap);
  }
}

// ---------------------------------------------------------------- axle (PLA)
module axle_raw() {   // along Z, centred
  cylinder(d = axle_d, h = body_l - 2 * cone, center = true);
  for (s = [0, 1]) mirror([0, 0, s]) {
    translate([0, 0, body_l / 2 - cone]) cylinder(d1 = axle_d, d2 = 2 * jr, h = cone + eps);
    translate([0, 0, body_l / 2]) cylinder(r = jr, h = jl);
  }
}
module axle_placed(i) { translate([bay_x0(i) + BW / 2, ax_y, ax_z]) rotate([0, 90, 0]) axle_raw(); }

module roll_ghost(i) {
  translate([bay_x0(i) + BW / 2, ax_y, ax_z]) rotate([0, 90, 0]) difference() {
    cylinder(d = roll_d, h = roll_w, center = true);
    cylinder(d = core_id, h = roll_w + 1, center = true);
  }
}

// ---------------------------------------------------------------- views
module lid_on(angle = 0, lift = 0) {
  translate([0, hy, z_s + lift]) rotate([-angle, 0, 0]) translate([0, -hy, -z_s]) lid();   // +angle opens the front upward
}
module assembly(angle = 0, lift = 0, ghost = true) {
  color("white") base();
  for (i = [0 : n_bays - 1]) {
    color("orange") axle_placed(i);
    if (ghost) color(["red", "gold", "royalblue", "green", "purple"][i], 0.7) roll_ghost(i);
  }
  color("lightblue", 0.45) lid_on(angle, lift);
}
// Placed on the 256 mm P2S plate in bed coordinates: slice with --arrange 0,
// because auto-arrange keeps a margin that pushes a 251 mm part off the bed.
// -45 deg, not +45: the P2S keeps x 153..216, y 235..256 clear (wrapping_exclude_area).
module flat45() { translate([128, 128, 0]) rotate([0, 0, -45]) translate([-IX / 2, -IY / 2, 0]) children(); }
plate_axles = [[30, 30], [55, 30], [80, 30], [30, 55], [55, 55]];        // free corner beside the base
module axles45() { for (p = plate_axles) translate([p[0], p[1], body_l / 2 + jl]) axle_raw(); }

if (part == "base") base();
else if (part == "base45") flat45() base();
else if (part == "lid") translate([0, 0, top_z]) rotate([180, 0, 0]) lid();      // top face on the plate
else if (part == "lid45") flat45() translate([0, IY, top_z]) rotate([180, 0, 0]) lid();
else if (part == "axle") translate([0, 0, body_l / 2 + jl]) axle_raw();       // standing
else if (part == "axles45") axles45();
else if (part == "plate_pla") { flat45() base(); axles45(); }   // whole PLA plate as one file
else if (part == "assembly") assembly();
else if (part == "open") assembly(angle = 100);
else if (part == "exploded") assembly(lift = 60);
else if (part == "section") difference() { assembly(); translate([bay_x0(2) + BW / 2, -50, -1]) cube([400, 200, 200]); }
else if (part == "hinge_section") difference() { assembly(ghost = false); translate([-20, -50, -1]) cube([hk_seg_x(1) + hk_len / 2 + 20, 200, 200]); }
