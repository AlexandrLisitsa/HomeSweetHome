// Satin ribbon case: five rolls in a row, AMS style.
// One PETG base split into 5 bays, one clear PETG lid hinged at the back. All PETG.
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
side_gap = 0.75;  // roll side to divider, each side
div_t    = 4;     // divider between bays: two 1.5 mm axle pockets + a 1 mm web
W        = 2.4;   // front/back wall
We       = 3.0;   // end walls (hold the outer journal pockets)
F        = 2.0;   // floor
T        = 2.0;   // lid top
r_out    = 10;    // outer vertical corner rounding
r_in     = 7;     // inner corner rounding
fit      = 0.30;  // sliding clearance (lip); PETG prints a little fat
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
body_l   = BW - 0.6;      // 0.3 mm to each divider face: little side play
jl       = 1.4;           // journal: 0.3 gap + 1.1 into its pocket; even shoved over it reaches
                          // only 1.4 of the 1.5 mm pocket, and a 1 mm web separates neighbours
pocket_d = 1.6;           // journal pocket depth in the end walls
pocket_div = 1.5;         // journal pocket depth from each side of a divider (web = div_t - 2 * 1.5 = 1.0)
cone     = (axle_d - 2 * jr) / 2;   // 45 deg shoulder, prints standing without support

/* [Lid joint] */
z_s      = ax_z + jr + 6; // base wall top / lid bottom (54)
lip_t    = 1.0;
lip_h    = 5;
top_z    = F + IZ + T;    // outer top of the lid (87)

/* [Pull slots] */
slot_len = roll_w + 1.5;
slot_gap = 3.0;           // vertical; ~2.1 mm across the 45 deg channel
slot_in_z = 4.4;          // bottom of the inner opening = floor of the clamp pocket
slot_ch  = 0.6;           // chamfer on the outer top edge (the one sharp 45 deg edge)
// The slot runs 45 deg down through the wall (inside high, outside low), so the
// ribbon keeps going down and out of the clamp pocket, and every layer of the
// slot's ceiling sits on the one below: no 52 mm bridge, which Studio flags as a
// "floating cantilever".

/* [Ribbon clamp: a springy tongue inside each bay, in front of the slot] */
// From the roll the ribbon goes up over the tongue's top, down the 2 mm pocket
// between the tongue and the front wall, and out of the slot at its bottom.
// In the pocket it snakes inside a nose on the tongue and outside a ridge on the
// wall. Pulling the end slides it out; anything pulling it back in (the roll
// turning back) tightens the S-bend and the wrap over the tongue, so it grips.
// Ridge and nose never touch (0.5 mm print gaps): they overlap by 1 mm sideways
// and sit 1 mm apart in height, so it prints without supports. To thread a new
// roll, open the lid, pull the tongue's top tab toward the roll and drop the
// ribbon down the pocket into the slot.
clamp_w   = 44;                   // narrower than the ribbon: clear of the rounded end corners
clamp_gap = 2.2;                  // pocket, wall face to tongue (overlap = gap - 2 * cl = 1.0)
clamp_t   = 1.4;                  // tongue thickness: PETG at 1.4 is as stiff as PLA at 1.2 (E * t^3)
clamp_h   = 21;                   // tongue top; a full roll is >= 11 mm away up there
clamp_cl  = 0.6;                  // print gap at the nose and the ridge tips (PETG fuses tighter gaps)
ridge_z   = 11;                   // ridge on the wall: z 11..14
nose_z    = 15;                   // nose on the tongue: z 15..18
clamp_lip = 1.5;                  // finger tab on the tongue's top, toward the roll

/* [Snap] */
snap_bump = 1.0;          // PETG tabs are softer: a bigger catch keeps the lid shut
bump_w    = 10;
tab_w     = 16;
tab_t     = 1.6;
snap_x    = [IX * 0.2, IX * 0.8];

/* [Hinge] */
hk_r     = 5;                      // knuckle radius: Ø10 leaves ~1.7 mm of PETG around the M3 nut
hy       = IY + W + 0.3 + hk_r;    // hinge axis y (z = z_s)
// Hinge pin = an M3x16 stainless pan-head screw + M3 washer + M3 nut from the kit.
// The screw goes in from the inner end (middle of the case's back): free through the
// lid knuckle, which turns on it, and through the base knuckle into an M3 nut held in a
// hex pocket at the base knuckle's outer end (pushed in from the case's end).
// The head and washer sit hidden in a recess at the lid knuckle's inner end.
// Stack under the head: washer 0.5 + lid 8 + gap 0.5 + base 7 = 16 = the screw, so it fills the nut.
pin_free = 3.4;                    // M3 clearance in both knuckles; PETG holes print small
nut_af   = 5.8;                    // M3 nut is 5.5 across flats; pocket a little loose
nut_h    = 2.6;                    // M3 nut is 2.4 thick; sits 0.2 below the end face
hk_gap   = 0.5;                    // between knuckles: PETG must not fuse them
hk_base  = 7;                      // base knuckle: 4.4 clearance + 2.6 nut pocket
hk_lid   = 11;                     // lid knuckle: 2.9 head recess + 8 bearing
head_d   = 7.4;                    // recess for the M3 washer (7.0) and pan head (6.0)
head_h   = 2.9;                    // washer 0.5 + head 2.4: the head sits flush, hidden
hk_x0    = 14;                     // outer base knuckle starts here, clear of the rounded corner
// Two short hinges, one per end. The base knuckles sit outside, the lid knuckles
// inside, so the lid is trapped between them and can't slide sideways.
base_hk_x = [hk_x0, IX - hk_x0 - hk_base];
lid_hk_x  = [hk_x0 + hk_base + hk_gap, IX - hk_x0 - hk_base - hk_gap - hk_lid];

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

// ---------------------------------------------------------------- base (PETG)
// Catch for the lid's clip: a long lead-in ramp on top, and a 60 deg catch face
// underneath instead of a flat ledge (a flat 1 mm ledge in mid-air is what Studio
// flags as a "floating cantilever"; 60 deg prints clean and still holds the clip).
module snap_bump(x) {
  hull() {
    translate([x - bump_w / 2, -W - eps, z_s - 8]) cube([bump_w, eps, eps]);
    translate([x - bump_w / 2, -W - snap_bump, z_s - 8 + snap_bump / tan(60)]) cube([bump_w, snap_bump, eps]);
    translate([x - bump_w / 2, -W - eps, z_s - 4]) cube([bump_w, eps, eps]);
  }
}
module base_knuckle(x) {
  difference() {
    hull() {
      translate([x, hy, z_s]) rotate([0, 90, 0]) cylinder(r = hk_r, h = hk_base);
      translate([x, IY + W - eps, z_s - 14]) cube([hk_base, eps, 14]);   // 45 deg gusset
    }
    // screw clearance all the way through
    translate([x - 1, hy, z_s]) rotate([0, 90, 0]) cylinder(d = pin_free, h = hk_base + 2, $fn = 24);
    // hex nut pocket at the outer end (toward the case's end), a corner up: its roof is
    // 60 deg, so it prints without support
    outer = x < IX / 2 ? x - 1 : x + hk_base - nut_h;
    translate([outer, hy, z_s]) rotate([0, 90, 0]) cylinder(d = nut_af / cos(30), h = nut_h + 1, $fn = 6);
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
      for (i = [0 : n_bays - 1]) clamp(i);
      for (x = base_hk_x) base_knuckle(x);
    }
    // cradles: through each divider, blind pockets in the end walls
    // dividers: a blind pocket from each side, a solid web between neighbouring axles
    for (j = [1 : n_bays - 1]) {
      cradle_cut(div_x0(j) - 1, pocket_div + 1);
      cradle_cut(div_x0(j) + div_t - pocket_div, pocket_div + 1);
    }
    cradle_cut(-pocket_d, pocket_d + 1);
    cradle_cut(IX - 1, pocket_d + 1);
    // one pull slot per bay: a 45 deg channel down and out, outer top edge chamfered
    for (i = [0 : n_bays - 1])
      hull() {
        translate([bay_x0(i) + BW / 2 - slot_len / 2, -eps, slot_in_z]) cube([slot_len, 2 * eps, slot_gap]);
        translate([bay_x0(i) + BW / 2 - slot_len / 2, -W - eps, slot_in_z - W]) cube([slot_len, 2 * eps, slot_gap + slot_ch]);
      }
    // clearance for the lid's knuckles
    for (x = lid_hk_x)
      translate([x - hk_gap, hy, z_s]) rotate([0, 90, 0]) cylinder(r = hk_r + hk_gap, h = hk_lid + 2 * hk_gap);
  }
}

// ---------------------------------------------------------------- lid (clear PETG)
module snap_tab(x) {
  difference() {
    union() {
      translate([x - tab_w / 2, -W - tab_t, z_s - 12]) cube([tab_w, tab_t, 20]);
      // thumb grip, chamfered 45 deg on its upper side: the lid prints upside down,
      // so a square grip would be a flat 1 mm ledge in mid-air
      hull() {
        translate([x - tab_w / 2, -W - tab_t - eps, z_s - 12]) cube([tab_w, 2 * eps, 2.6]);
        translate([x - tab_w / 2, -W - tab_t - 1, z_s - 12]) cube([tab_w, eps, 1.6]);
      }
    }
    translate([x - (bump_w + 1) / 2, -W - tab_t - 2, z_s - 8.3]) cube([bump_w + 1, tab_t + 3, 4.8]);
  }
}
module lid_knuckle(x) {
  difference() {
    hull() {
      translate([x, hy, z_s]) rotate([0, 90, 0]) cylinder(r = hk_r, h = hk_lid);
      translate([x, IY + W - eps, z_s]) cube([hk_lid, eps, 14]);          // gusset, prints upside down
    }
    translate([x - 1, hy, z_s]) rotate([0, 90, 0]) cylinder(d = pin_free, h = hk_lid + 2, $fn = 24);
    // recess for the screw head + washer at the inner end (toward the middle of the case)
    inner = x < IX / 2 ? x + hk_lid - head_h : x - 1;
    translate([inner, hy, z_s]) rotate([0, 90, 0]) cylinder(d = head_d, h = head_h + 1, $fn = 32);
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
      for (x = lid_hk_x) lid_knuckle(x);
    }
    // clearance for the base's knuckles
    for (x = base_hk_x)
      translate([x - hk_gap, hy, z_s]) rotate([0, 90, 0]) cylinder(r = hk_r + hk_gap, h = hk_base + 2 * hk_gap);
  }
}

// ---------------------------------------------------------------- axle (PETG)
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
// ---------------------------------------------------------------- ribbon clamp (part of the base)
module clamp(i) {
  cx = bay_x0(i) + BW / 2;
  x0 = cx - clamp_w / 2;
  yi = clamp_gap;                    // tongue face toward the wall
  yo = yi + clamp_t;                 // tongue face toward the roll
  tooth = clamp_gap - clamp_cl;      // how far ridge and nose reach (1.5)
  // pocket floor raised to the slot's inner opening, so the ribbon runs straight in
  translate([cx - slot_len / 2, -1, F - eps]) cube([slot_len, yi + 1 + eps, slot_in_z - F + eps]);
  // tongue, rooted in the bay floor
  translate([x0, yi, F - eps]) cube([clamp_w, clamp_t, clamp_h - F + eps]);
  // nose on the tongue, toward the wall, 45 deg both sides
  hull() {
    translate([x0, yi - eps, nose_z]) cube([clamp_w, 2 * eps, 3]);
    translate([x0, yi - tooth, nose_z + 1.5]) cube([clamp_w, eps, eps]);
  }
  // ridge on the wall's inner face, toward the tongue (rooted 1 mm into the wall)
  hull() {
    translate([x0, -1, ridge_z]) cube([clamp_w, 1 + eps, 3]);
    translate([x0, tooth - eps, ridge_z + 1.5]) cube([clamp_w, eps, eps]);
  }
  // finger tab on the top, toward the roll, with a 53 deg underside
  hull() {
    translate([x0, yo - eps, clamp_h - 3.5]) cube([clamp_w, 2 * eps, 3.5]);
    translate([x0, yo + clamp_lip, clamp_h - 1.5]) cube([clamp_w, eps, 1.5]);
  }
}

// The ribbon's path from the roll through clamp and slot (pictures only).
module ribbon_path(i) {
  yi = clamp_gap;
  pts = [[23.9, 10.6],                                   // leaves the full roll, tangent to the tongue top
         [yi + clamp_t + 0.3, clamp_h + 0.4], [1.0, clamp_h + 0.6],   // over the tongue
         [clamp_cl / 2, nose_z + 1.5],                   // inside the nose
         [yi - clamp_cl / 2, ridge_z + 1.5],             // outside the ridge
         [1.0, slot_in_z + 4], [0, slot_in_z + slot_gap / 2],          // into the slot
         [-W, slot_in_z - W + slot_gap / 2], [-W - 2, slot_in_z - W],  // out of it
         [-W - 12, 0.2]];                                // the end on the table
  for (k = [0 : len(pts) - 2])
    hull() for (p = [pts[k], pts[k + 1]])
      translate([bay_x0(i) + BW / 2 - roll_w / 2, p[0], p[1]]) rotate([0, 90, 0]) cylinder(d = 0.25, h = roll_w, $fn = 8);
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
else if (part == "plate_base") { flat45() base(); axles45(); }  // base + 5 axles, one PETG plate
else if (part == "assembly") assembly();
else if (part == "open") assembly(angle = 100);
else if (part == "exploded") assembly(lift = 60);
else if (part == "section") difference() { assembly(); translate([bay_x0(2) + BW / 2, -50, -1]) cube([400, 200, 200]); }
else if (part == "clamp") {   // close-up section through the middle bay, ribbon in red
  cx = bay_x0(2) + BW / 2;
  intersection() { color("white") base(); translate([cx - 10, -12, -1]) cube([20, 30, 30]); }
  intersection() { color("red") ribbon_path(2); translate([cx - 10, -12, -1]) cube([20, 30, 30]); }
}
else if (part == "clamp_test")   // smallest test of slot + clamp: one bay's front strip, centred on the bed
  translate([128 - (bay_x0(2) + BW / 2), 128 - 3, 0]) intersection() {
    base();
    translate([bay_x0(2) - div_t / 2, -W - 1, -1]) cube([BW + div_t, W + 1 + 8, clamp_h + 1.5]);
  }
else if (part == "clamp_iso") {   // the front of the case with all five clamps and ribbons
  intersection() { color("white") base(); translate([-20, -15, -1]) cube([IX + 40, 40, 40]); }
  for (i = [0 : n_bays - 1]) color("red") ribbon_path(i);
}
else if (part == "hinge_section") difference() { assembly(ghost = false); translate([-20, -50, -1]) cube([lid_hk_x[0] + hk_lid / 2 + 20, 200, 200]); }
