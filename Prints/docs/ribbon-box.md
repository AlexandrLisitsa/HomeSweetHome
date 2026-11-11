# Ribbon box

An AMS-style case for five satin ribbon rolls in a row, all printed in PETG. One base is split into five bays, and one clear lid is hinged at the back on two metal screws.

Each bay has:
- its own drop-in axle;
- a springy clamp tongue that keeps the cut ribbon end from slipping back inside;
- a pull slot in the front wall.

Model: [`RibbonBox/ribbon_box.scad`](../RibbonBox/ribbon_box.scad) (OpenSCAD + BOSL2). Every size comes from the parameters at the top of the file.

> **Status:** designed and slicing; not printed yet. Waiting for the hinge screws. Before printing the 7-hour base, print the clamp test (`clamp_test`, 31 min).

## Roll it is sized for

These sizes were measured from photos. **Check them with a caliper** and change `roll_*` / `core_*` if they differ.

| | mm |
|---|---|
| Roll outside diameter | 76 |
| Ribbon width | 50 |
| Core outside / inside | 24 / 18 |

## Parts and hardware

| Item | Qty | Notes |
|---|---|---|
| Base (with 5 axles on the same plate) | 1 | PETG |
| Lid | 1 | clear PETG |
| M3×16 pan-head screw, stainless | 2 | hinge pins |
| M3 hex nut | 2 | held in a pocket in the base knuckle |
| M3 flat washer | 2 | under the screw head |
| Clear nail polish | a drop | thread lock that stays removable |

## The case

| | |
|---|---|
| Outside | 279.5 × 89 × 87 mm, plus the hinge and the clips |
| Bays | 5 × 51.5 mm |
| Dividers | 4 mm, running up to the lid (the lid has matching divider walls) |
| Axle | Ø17 mm body (the core is 18 mm) with coned ends and Ø8 mm journals |
| Pull slot | 51.5 mm wide per bay, low in the front wall, running 45° down and out |
| Lid | clear, hinged at the back; two snap clips at the front |

- **Axle pockets:** each journal drops into its own U-shaped pocket, open at the top. Pockets in a divider are blind, 1.5 mm deep from each side, with a solid 1 mm web between neighbouring axles. The end walls have 1.6 mm pockets.
  - Each axle can shift 0.3 mm sideways, and its journal reaches at most 1.4 mm into a pocket, so neighbouring axles never touch.
- **No axle clips needed:** the lid ceiling is 3 mm above a full roll and the pockets are 6 mm deep above each journal, so an axle can't climb out with the lid shut.

### Ribbon clamp

From the roll, the ribbon goes **over the top of a springy tongue** standing just inside the front wall. It then runs **down the 2.2 mm pocket** between the tongue and the wall and **out of the slot** at the bottom.

In the pocket the ribbon snakes around a **nose** on the tongue, then around a **ridge** on the wall. These overlap by 1 mm but never touch: there's a 0.6 mm print gap at each tip and they sit 1 mm apart in height.

- **Pulling the end:** it slides through the S-bend.
- **Anything pulling it back in** (the roll turning back, the lid closing on it): the S-bend and the wrap over the tongue tighten and grip, so the end stays outside.

| Piece | Size |
|---|---|
| Tongue | 44 mm wide, 1.4 mm thick (as stiff in PETG as 1.2 mm PLA), 21 mm tall |
| Finger tab | 1.5 mm, on the tongue's top |

Everything slopes at 45° or steeper, so it prints without supports.

**Threading a roll:**
1. Open the lid.
2. Pull the tongue's tab toward the roll. The pocket opens and the S-bend straightens out.
3. Drape the ribbon over the tongue and feed the end down the pocket until it comes out of the slot. The pocket floor is level with the slot.
4. Let go.

### Hinges

Each end of the back has one short hinge: a base knuckle on the outside and a lid knuckle just inside it, so the lid can't slide sideways.

| Knuckle | Size | Holes |
|---|---|---|
| Base | Ø10 × 7 mm | 3.4 mm through; hex pocket for the M3 nut at its outer end, corner up so it prints without support |
| Lid | Ø10 × 11 mm | 3.4 mm through; Ø7.4 × 2.9 mm recess at its inner end that hides the washer and screw head |

**Screw length:** under the head, the stack is washer 0.5 + lid 8 + gap 0.5 + base 7 = 16 mm. So the M3×16 runs exactly through the nut and ends flush.

### Changing one roll (e.g. the middle one)

1. Press the two front clips out and swing the lid back. It opens past 90°.
2. Lift that bay's axle and roll straight up, and swap the roll.
3. Drop it back in and re-thread the clamp.

The other four rolls are never touched.

## Printing (Bambu P2S, 0.4 nozzle, PETG, Textured PEI plate)

Both parts are about 280 mm long, more than the 256 mm bed, so they print flat **turned −45°**. The −45° keeps the corners clear of the P2S wrapping-detection zone at the back edge (x 153–216, y 235–256).

| Part (`scad_render.ps1 -Part`) | Plate | Settings | Estimate |
|---|---|---|---|
| `plate_base`: base + 5 standing axles | 253.2 mm square | 3 walls, 15 % infill | ~6 h 55 min, ~264 g |
| `lid45`: lid, top face down | 252.1 mm square | 4 walls, 100 % zig-zag infill, slow outer wall (for clarity) | ~4 h, ~166 g |
| `clamp_test`: one bay's front strip with slot and clamp | 55 × 10 × 22 mm | 3 walls, 15 % | ~31 min, ~7 g |

- **No supports needed.** Every overhang is 45° or steeper, including:
  - the slot ceiling;
  - the clip catches (60° catch faces);
  - the lid-clip grips (45°);
  - the knuckle gussets;
  - the nut pocket roof.
- **Opening the files:** open the rendered STLs in Bambu Studio directly. They are already placed in bed coordinates, so don't let Studio re-arrange them.
- **Fit:** PETG prints a little fat and fuses small gaps, so the clearances are set for it:
  - lid rim on the base lip: 0.3 mm;
  - between knuckles: 0.5 mm;
  - clamp tips: 0.6 mm;
  - screw holes: 3.4 mm.

> Don't trust the Bambu Studio **CLI** for checks. Headless, it doesn't apply the system P2S profiles and falls back to defaults, so its warnings and estimates are wrong. Slice in the app.

## Assembly

1. Push one M3 nut into the hex pocket at each end of the base, from the case's end.
2. Put the lid on the base so the knuckles line up.
3. Drop a washer into each lid knuckle's recess.
4. From behind, screw an M3×16 through the lid knuckle and the base knuckle into the nut.
5. Tighten until the head touches the washer, then **back off a quarter turn** so the lid swings freely.
6. Put a drop of clear nail polish where the screw tip meets the nut.
   - Nail glue (cyanoacrylate) also holds, but makes the screw permanent.
7. Load the rolls and thread the clamps.

## Tuning after the first print

| Symptom | Parameter |
|---|---|
| Lid snaps too hard or too soft | `snap_bump` (1.0) |
| Lid rim too tight or loose on the base lip | `fit` (0.30) |
| Clamp grips too weakly | `clamp_cl` (0.6): smaller makes more overlap; or `clamp_t` (1.4): thicker is stiffer |
| Threading too stiff | `clamp_t` thinner, or `clamp_gap` (2.2) larger |
| Ribbon drags in the slot | `slot_gap` (3.0 vertical) |
| Nut too tight or loose in its pocket | `nut_af` (5.8) |
| Axle too loose in the core | `axle_d` (core − 1) |

## Render parts

| Part names | What they are |
|---|---|
| `base`, `lid`, `axle` | single parts |
| `plate_base`, `lid45`, `clamp_test` | print-ready, in bed coordinates |
| `assembly`, `open`, `exploded`, `section`, `hinge_section`, `clamp`, `clamp_iso` | views |
