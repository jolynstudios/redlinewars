// STEELSEED — materials/wgsl-field
// Forge pass 1: the STRUCTURE of a surface, evaluated once per texel into an
// rgba32float scratch texture as (height in metres, wear seed, cavity, material id).
//
// Splitting structure from appearance is what lets wear be real. The shading pass reads
// this field's neighbourhood, differentiates it for a normal, takes its Laplacian for
// curvature and marches it for ambient occlusion — so paint comes off where the geometry
// is genuinely proud and grime collects where the geometry is genuinely enclosed. A
// grime texture multiplied over the top would be independent of the relief underneath it
// and reads as dirt printed on plastic; this reads as a surface that has been somewhere.
//
// `matId` carries a sub-material index in its integer part and a per-region hash in its
// fraction, so one float distinguishes plate face from seam from weld bead from rivet
// head while still varying every plate.

export const FIELD_BINDINGS_WGSL = /* wgsl */ `
@group(0) @binding(1) var fieldOut: texture_storage_2d<rgba32float, write>;
`

export const FIELD_KINDS_WGSL = /* wgsl */ `
// --- 0 soil -----------------------------------------------------------------
// Clods with pebbles turned up through them. matId: 0 earth, 1 pebble.
fn fieldSoil(uv: vec2<f32>) -> vec4<f32> {
	let s = P.seed;
	let clod = worley(warp2(uv * 6.0, 6, 0.35, s + 5u), 6, s + 101u);
	let base = fbm(uv * 4.0, 4, i32(P.octaves), 0.5, s + 7u);
	let dome = smoothstepRev(0.05, 0.62, clod.x);
	let grain = fbm(uv * 48.0, 48, 3, 0.55, s + 31u) * bandK(48.0);
	let peb = worley(uv * 34.0, 34, s + 53u);
	let pebble = smoothstepRev(0.03, 0.22, peb.x) * step(0.70, peb.z) * bandK(34.0);
	let h = (base * 0.42 + dome * 0.44 + pebble * 0.34 + grain * 0.12) * P.heightScale;
	let moisture = saturate(0.5 + 0.5 * fbm(uv * 3.0, 3, 4, 0.5, s + 17u) + P.wearBias * 0.2);
	let crev = 1.0 - smoothstep(0.0, 0.22, clod.y - clod.x);
	let cav = saturate(crev * 0.85 + saturate(-grain) * 0.20);
	let sub = select(0.0, 1.0, pebble > 0.35);
	return vec4<f32>(h, moisture, cav, sub + clod.z * 0.999);
}

// --- 1 rock -----------------------------------------------------------------
// Ridged mass cut by bedding planes and a joint network. matId: 0 body, 1 hard band.
fn fieldRock(uv: vec2<f32>) -> vec4<f32> {
	let s = P.seed;
	let mass = ridged(warp2(uv * 5.0, 5, 0.40, s + 3u), 5, i32(P.octaves), 0.52, s + 11u);
	let bandPhase = aniPhase(uv, 9.0) + fbm(uv * 4.0, 4, 4, 0.5, s + 23u) * 0.40;
	let bands = sin(bandPhase * TAU) * 0.5 + 0.5;
	let frac = worley(warp2(uv * 7.0, 7, 0.25, s + 41u), 7, s + 43u);
	let joint = 1.0 - smoothstep(0.0, 0.10, frac.y - frac.x);
	let grit = fbm(uv * 44.0, 44, 3, 0.5, s + 61u) * bandK(44.0);
	let h = (mass * 0.72 + bands * 0.16 - joint * 0.34 + grit * 0.08) * P.heightScale;
	let stain = saturate(0.45 + 0.55 * fbm(uv * 3.0, 3, 5, 0.55, s + 71u) + P.wearBias * 0.25);
	let cav = saturate(joint * 0.90 + (1.0 - bands) * 0.15);
	let sub = select(0.0, 1.0, bands > 0.62);
	return vec4<f32>(h, stain, cav, sub + frac.z * 0.999);
}

// --- 2 sand -----------------------------------------------------------------
// Dunes carrying wind ripples that thin out on the lee side. matId: 0 loose, 1 packed.
fn fieldSand(uv: vec2<f32>) -> vec4<f32> {
	let s = P.seed;
	let dune = fbm(uv * 2.0, 2, i32(P.octaves), 0.55, s + 3u);
	let ripplePhase = aniPhase(uv, 26.0) + fbm(uv * 3.0, 3, 4, 0.5, s + 13u) * 0.9;
	let ripple = sin(ripplePhase * TAU) * bandK(26.0);
	let drift = saturate(0.55 + 0.45 * dune);
	let grain = fbm(uv * 96.0, 96, 3, 0.5, s + 29u) * bandK(96.0);
	let h = (dune * 0.52 + ripple * 0.26 * drift + grain * 0.07) * P.heightScale;
	let packed = saturate(0.5 - dune * 0.6 + P.wearBias * 0.3);
	let cav = saturate(-ripple * 0.35 + 0.10);
	let sub = select(0.0, 1.0, packed > 0.62);
	return vec4<f32>(h, packed, cav, sub + (dune * 0.5 + 0.5) * 0.999);
}

// --- 3 gravel ---------------------------------------------------------------
// Loose stones bedded in dust. matId: 0 stone, 1 dust fill.
fn fieldGravel(uv: vec2<f32>) -> vec4<f32> {
	let s = P.seed;
	let st = worley(warp2(uv * 16.0, 16, 0.12, s + 3u), 16, s + 19u);
	let stone = smoothstepRev(0.02, 0.50, st.x) * bandK(16.0);
	let small = worley(uv * 40.0, 40, s + 23u);
	let chips = smoothstepRev(0.02, 0.22, small.x) * step(0.55, small.z) * bandK(40.0);
	let dust = fbm(uv * 8.0, 8, 5, 0.5, s + 31u) * 0.5 + 0.5;
	let grit = fbm(uv * 70.0, 70, 3, 0.5, s + 37u) * bandK(70.0);
	let h = (stone * 0.72 + chips * 0.22 + dust * 0.16 + grit * 0.06) * P.heightScale;
	let dry = saturate(dust * 0.8 + 0.2 + P.wearBias * 0.2);
	let cav = saturate((1.0 - smoothstep(0.0, 0.18, st.y - st.x)) * 0.95);
	let sub = select(1.0, 0.0, stone > 0.30);
	return vec4<f32>(h, dry, cav, sub + st.z * 0.999);
}

// --- 4 grass ----------------------------------------------------------------
// Tufts with soil showing through the thin patches. matId: 0 blade, 1 bare soil.
fn fieldGrass(uv: vec2<f32>) -> vec4<f32> {
	let s = P.seed;
	let tuft = worley(warp2(uv * 7.0, 7, 0.30, s + 3u), 7, s + 11u);
	let density = saturate(0.55 + 0.65 * fbm(uv * 3.0, 3, 4, 0.5, s + 17u));
	let clump = smoothstepRev(0.05, 0.55, tuft.x) * density;
	// Blades lie along a lattice direction, so the layer variants comb differently.
	let bladePhase = aniPhase(uv, 110.0) + fbm(uv * 14.0, 14, 3, 0.5, s + 23u) * 1.4;
	let blades = (sin(bladePhase * TAU) * 0.5 + 0.5) * bandK(110.0);
	let fine = fbm(uv * 60.0, 60, 3, 0.55, s + 29u) * bandK(60.0);
	let h = (clump * 0.62 + blades * 0.26 * clump + fine * 0.12) * P.heightScale;
	let dryness = saturate(0.45 + 0.55 * fbm(uv * 2.0, 2, 5, 0.5, s + 41u) + P.wearBias * 0.25);
	let cav = saturate((1.0 - clump) * 0.75 + (1.0 - smoothstep(0.0, 0.20, tuft.y - tuft.x)) * 0.3);
	let sub = select(0.0, 1.0, clump < 0.18);
	return vec4<f32>(h, dryness, cav, sub + tuft.z * 0.999);
}

// --- 5 road -----------------------------------------------------------------
// Asphalt: aggregate in bitumen, polished wheel bands, crack network, patch repairs.
// matId: 0 bitumen, 1 exposed aggregate, 2 crack, 3 repair patch.
fn fieldRoad(uv: vec2<f32>) -> vec4<f32> {
	let s = P.seed;
	let agg = worley(uv * 40.0, 40, s + 7u);
	let stones = smoothstepRev(0.04, 0.26, agg.x) * bandK(40.0);
	let patchCell = worley(warp2(uv * 3.0, 3, 0.45, s + 13u), 3, s + 17u);
	let repair = step(0.68, patchCell.z);
	// Wheel polish runs with the road, so it follows the layer's lattice direction.
	let wheel = saturate(cos(aniPhase(uv, 2.0) * TAU) * 1.6 - 0.35);
	let crackCell = worley(warp2(uv * 6.0, 6, 0.55, s + 23u), 6, s + 29u);
	let crack = (1.0 - smoothstep(0.0, 0.045, crackCell.y - crackCell.x)) * (1.0 - wheel * 0.6);
	let roll = fbm(uv * 5.0, 5, 4, 0.5, s + 31u);
	let grit = fbm(uv * 80.0, 80, 3, 0.5, s + 37u) * bandK(80.0);
	let h = (roll * 0.30 + stones * 0.34 * (1.0 - wheel * 0.7) - crack * 0.55 + repair * 0.12 + grit * 0.08) * P.heightScale;
	let wear = saturate(wheel * 0.8 + 0.2 + P.wearBias * 0.25);
	let cav = saturate(crack * 0.95 + (1.0 - smoothstep(0.0, 0.10, agg.y - agg.x)) * 0.25);
	var sub = 0.0;
	if (crack > 0.45) { sub = 2.0; } else if (repair > 0.5) { sub = 3.0; } else if (stones > 0.45) { sub = 1.0; }
	return vec4<f32>(h, wear, cav, sub + agg.z * 0.999);
}

// --- 6 metal ----------------------------------------------------------------
// Industrial plate on a base: staggered plating, rivet runs, brushed grain, rust
// nucleating out of the seams. matId: 0 plate face, 1 seam, 2 rivet, 3 hazard band.
fn fieldMetal(uv: vec2<f32>) -> vec4<f32> {
	let s = P.seed;
	let pl = plateLattice(uv, 4, 22.0, s + 3u);
	let groove = 1.0 - smoothstep(0.0, 0.005, pl.seam);
	let riv = smoothstepRev(0.0018, 0.0055, pl.rivet) * bandK(60.0);
	let lip = (pl.hash - 0.5) * 0.35;
	// Brushing is a directional high-frequency grain, not isotropic noise.
	let brush = fbm(vec2<f32>(aniPhase(uv, 6.0), -P.aniB * uv.x + P.aniA * uv.y) * 26.0, 26, 3, 0.5, s + 11u) * bandK(26.0);
	let dent = fbm(warp2(uv * 9.0, 9, 0.3, s + 19u), 9, 4, 0.5, s + 23u);
	// Hazard chevrons: a repeated diagonal band, painted not formed, so it barely lifts.
	// Kept narrow — it is player-coloured marking, and a third of the surface in team
	// paint would read as a hue shift over the whole material rather than a marking (§9).
	let chev = step(0.88, fract(aniPhase(uv, 5.0) + uv.x * 3.0));
	let h = (lip * 0.35 - groove * 0.60 + riv * 0.75 + brush * 0.10 + dent * 0.18 + chev * 0.04) * P.heightScale;
	let rustSeed = saturate(0.5 + 0.6 * fbm(warp2(uv * 4.0, 4, 0.5, s + 29u), 4, 5, 0.6, s + 31u) + P.wearBias);
	let cav = saturate(groove * 0.9 + smoothstepRev(0.006, 0.012, pl.rivet) * 0.3);
	var sub = 0.0;
	if (riv > 0.5) { sub = 2.0; } else if (groove > 0.5) { sub = 1.0; } else if (chev > 0.5) { sub = 3.0; }
	return vec4<f32>(h, rustSeed, cav, sub + pl.hash * 0.999);
}

// --- 7 concrete -------------------------------------------------------------
// Poured against board forms, then chipped back to the aggregate at the edges.
// matId: 0 skin, 1 exposed aggregate, 2 form seam, 3 crack.
fn fieldConcrete(uv: vec2<f32>) -> vec4<f32> {
	let s = P.seed;
	let agg = worley(warp2(uv * 22.0, 22, 0.15, s + 5u), 22, s + 7u);
	let skin = fbm(uv * 6.0, 6, i32(P.octaves), 0.5, s + 11u);
	// Form boards leave a regular course of shallow lines with a tie-hole every few.
	let boardPhase = aniPhase(uv, 6.0);
	let board = 1.0 - smoothstep(0.0, 0.10, abs(fract(boardPhase) - 0.5) - 0.44);
	let spall = smoothstepRev(0.06, 0.30, agg.x) * step(0.62, agg.z) * bandK(22.0);
	let crackCell = worley(warp2(uv * 5.0, 5, 0.6, s + 13u), 5, s + 17u);
	let crack = 1.0 - smoothstep(0.0, 0.030, crackCell.y - crackCell.x);
	let grit = fbm(uv * 64.0, 64, 3, 0.5, s + 19u) * bandK(64.0);
	let h = (skin * 0.24 - board * 0.22 - spall * 0.55 - crack * 0.40 + grit * 0.10) * P.heightScale;
	let age = saturate(0.45 + 0.55 * fbm(uv * 2.0, 2, 5, 0.55, s + 23u) + P.wearBias * 0.3);
	let cav = saturate(crack * 0.9 + spall * 0.6 + board * 0.4);
	var sub = 0.0;
	if (crack > 0.5) { sub = 3.0; } else if (board > 0.5) { sub = 2.0; } else if (spall > 0.35) { sub = 1.0; }
	return vec4<f32>(h, age, cav, sub + agg.z * 0.999);
}

// --- 8 water ----------------------------------------------------------------
// Two crossed wave trains plus chop. Deep water is almost pure normal and reflectance,
// so height carries everything and the appearance pass adds nearly no colour detail.
fn fieldWater(uv: vec2<f32>) -> vec4<f32> {
	let s = P.seed;
	let a = sin((aniPhase(uv, 3.0) + fbm(uv * 3.0, 3, 3, 0.5, s + 5u) * 0.5) * TAU);
	let b = sin(((P.aniB * uv.x - P.aniA * uv.y) * 5.0 + fbm(uv * 4.0, 4, 3, 0.5, s + 9u) * 0.6) * TAU);
	let chop = fbm(warp2(uv * 12.0, 12, 0.30, s + 13u), 12, 5, 0.55, s + 17u);
	let fine = fbm(uv * 56.0, 56, 3, 0.5, s + 19u) * bandK(56.0);
	let h = (a * 0.34 + b * 0.26 + chop * 0.30 + fine * 0.10) * P.heightScale;
	let foam = saturate(0.5 + 0.5 * fbm(uv * 8.0, 8, 4, 0.5, s + 23u) + P.wearBias * 0.2);
	return vec4<f32>(h, foam, 0.0, 0.0);
}

// --- 9 shallow --------------------------------------------------------------
// A visible bed under a thin ripple. matId: 0 bed, 1 silt, 2 exposed stone.
fn fieldShallow(uv: vec2<f32>) -> vec4<f32> {
	let s = P.seed;
	let bed = worley(warp2(uv * 14.0, 14, 0.18, s + 3u), 14, s + 11u);
	let stone = smoothstepRev(0.05, 0.46, bed.x) * bandK(14.0);
	let silt = fbm(uv * 6.0, 6, 5, 0.5, s + 17u) * 0.5 + 0.5;
	let ripple = sin((aniPhase(uv, 18.0) + fbm(uv * 5.0, 5, 3, 0.5, s + 19u) * 0.8) * TAU) * bandK(18.0);
	let fine = fbm(uv * 64.0, 64, 3, 0.5, s + 23u) * bandK(64.0);
	let h = (stone * 0.52 + silt * 0.20 + ripple * 0.26 + fine * 0.08) * P.heightScale;
	let depth = saturate(0.45 + 0.55 * fbm(uv * 2.0, 2, 4, 0.5, s + 29u) - stone * 0.4);
	let cav = saturate((1.0 - smoothstep(0.0, 0.16, bed.y - bed.x)) * 0.8);
	var sub = 0.0;
	if (stone > 0.45) { sub = 2.0; } else if (silt > 0.62) { sub = 1.0; }
	return vec4<f32>(h, depth, cav, sub + bed.z * 0.999);
}

// --- 10 snow ----------------------------------------------------------------
// Wind-carved sastrugi with a crust that breaks to grit. matId: 0 crust, 1 broken.
fn fieldSnow(uv: vec2<f32>) -> vec4<f32> {
	let s = P.seed;
	let drift = fbm(uv * 3.0, 3, i32(P.octaves), 0.55, s + 5u);
	let sastrugi = ridged(vec2<f32>(aniPhase(uv, 7.0), -P.aniB * uv.x + P.aniA * uv.y) * 7.0, 7, 5, 0.5, s + 11u);
	let crustCell = worley(warp2(uv * 9.0, 9, 0.35, s + 17u), 9, s + 19u);
	let broken = step(0.74, crustCell.z) * smoothstepRev(0.10, 0.45, crustCell.x);
	let sparkle = fbm(uv * 110.0, 110, 2, 0.5, s + 23u) * bandK(110.0);
	let h = (drift * 0.50 + sastrugi * 0.40 - broken * 0.28 + sparkle * 0.06) * P.heightScale;
	let fresh = saturate(0.55 + 0.45 * fbm(uv * 2.0, 2, 4, 0.5, s + 29u) - P.wearBias * 0.4);
	let cav = saturate(broken * 0.8 + (1.0 - smoothstep(0.0, 0.20, crustCell.y - crustCell.x)) * 0.35);
	let sub = select(0.0, 1.0, broken > 0.35);
	return vec4<f32>(h, fresh, cav, sub + crustCell.z * 0.999);
}

// --- 11 ash -----------------------------------------------------------------
// Fine fall with a shrinkage-crack network and embers still down in the cracks.
// matId: 0 powder, 1 crack floor, 2 crust flake.
fn fieldAsh(uv: vec2<f32>) -> vec4<f32> {
	let s = P.seed;
	let drift = fbm(warp2(uv * 4.0, 4, 0.35, s + 3u), 4, i32(P.octaves), 0.55, s + 7u);
	let crackCell = worley(warp2(uv * 8.0, 8, 0.30, s + 11u), 8, s + 13u);
	let crack = 1.0 - smoothstep(0.0, 0.055, crackCell.y - crackCell.x);
	let flake = smoothstepRev(0.14, 0.42, crackCell.x);
	let powder = fbm(uv * 72.0, 72, 3, 0.5, s + 17u) * bandK(72.0);
	let h = (drift * 0.46 + flake * 0.30 - crack * 0.62 + powder * 0.10) * P.heightScale;
	// The ember field is deliberately low frequency: heat survives in pockets, not per grain.
	let heat = saturate(fbm(uv * 2.0, 2, 4, 0.5, s + 19u) * 0.8 + 0.35 + P.wearBias * 0.3);
	let cav = saturate(crack * 0.95);
	var sub = 0.0;
	if (crack > 0.5) { sub = 1.0; } else if (flake > 0.55) { sub = 2.0; }
	return vec4<f32>(h, heat, cav, sub + crackCell.z * 0.999);
}

// --- 12 resource ------------------------------------------------------------
// Crystal grown out of a dull matrix: flat facets, sharp arrises, metallic vein.
// matId: 0 matrix, 1 facet, 2 vein.
fn fieldResource(uv: vec2<f32>) -> vec4<f32> {
	let s = P.seed;
	let wp = warp2(uv * 9.0, 9, 0.20, s + 3u);
	let cell = worley(wp, 9, s + 11u);
	// A facet is a PLANE across the cell, not a dome — that is what gives a crystal its
	// hard arris under lighting, and the curvature it produces drives the edge wear.
	// The plane is tilted in the CELL's frame: keying it to the tile's fractional
	// coordinate instead put a hard step on every ninth column and row, which the seam
	// probe caught as a 3x discontinuity across the tile boundary.
	let wc = worleyCell(wp, 9, s + 11u);
	let ch = u32(wc.w * 65535.0);
	let tilt = vec2<f32>(u2f(hashU(ch)) - 0.5, u2f(hashU(ch ^ 0x9e37u)) - 0.5);
	let facetH = (1.0 - cell.x * 1.6) + dot(tilt, wc.xy) * 0.8;
	let grown = step(0.42, cell.z);
	let matrix = fbm(uv * 7.0, 7, i32(P.octaves), 0.5, s + 17u);
	let vein = 1.0 - smoothstep(0.0, 0.035, abs(fbm(warp2(uv * 5.0, 5, 0.5, s + 19u), 5, 4, 0.5, s + 23u)));
	let grit = fbm(uv * 60.0, 60, 3, 0.5, s + 29u) * bandK(60.0);
	let h = (matrix * 0.24 + grown * saturate(facetH) * 0.80 + vein * 0.12 + grit * 0.06) * P.heightScale;
	let charge = saturate(0.4 + 0.6 * cell.z + P.wearBias * 0.2);
	let cav = saturate((1.0 - smoothstep(0.0, 0.12, cell.y - cell.x)) * 0.85);
	var sub = 0.0;
	if (grown > 0.5 && facetH > 0.10) { sub = 1.0; } else if (vein > 0.45) { sub = 2.0; }
	return vec4<f32>(h, charge, cav, sub + cell.z * 0.999);
}

// --- 13 foundry -------------------------------------------------------------
// Mass-produced steel: staggered plate courses, butt-welded along the courses and
// bolted at the uprights, ochre paint over the lot, soot in every enclosed corner (§9).
// matId: 0 plate face, 1 seam, 2 weld bead, 3 rivet head, 4 stencil band.
fn fieldFoundry(uv: vec2<f32>) -> vec4<f32> {
	let s = P.seed;
	let pl = plateLattice(uv, 5, 26.0, s + 3u);
	// Plates OVERLAP, so each sits proud of its neighbour by a lip instead of butting
	// flush. Reading the joins is the whole point of the faction's surface language.
	let lip = (pl.hash - 0.5) * 0.30 + (pl.rowHash - 0.5) * 0.30;
	let groove = 1.0 - smoothstep(0.0, 0.006, pl.seam);
	// Courses are welded, uprights are bolted: one continuous bead per horizontal seam.
	let welded = 1.0 - pl.vert;
	let q = pl.seam / 0.010;
	let bead = welded * exp(-q * q) * (0.72 + 0.28 * sin(pl.along * 90.0 * TAU) * bandK(90.0));
	let riv = smoothstepRev(0.0020, 0.0060, pl.rivet) * bandK(70.0);
	let roll = fbm(uv * 6.0, 6, 4, 0.5, s + 29u) * 0.9;
	let scale = fbm(uv * 64.0, 64, 3, 0.5, s + 37u) * bandK(64.0);
	// A painted stencil band, raised only by its own paint film.
	let stencil = step(0.86, fract(aniPhase(uv, 4.0) + pl.rowHash));
	let h = (lip * 0.50 - groove * 0.55 + bead * 0.50 + riv * 0.70 + roll * 0.12 + scale * 0.06 + stencil * 0.03) * P.heightScale;
	// Soot settles out of the air, so its field is broad and its deposition is decided
	// in the shading pass by how enclosed the geometry actually is.
	let soot = saturate(0.5 + 0.6 * fbm(warp2(uv * 3.0, 3, 0.5, s + 41u), 3, 5, 0.6, s + 43u) + P.wearBias);
	let cav = saturate(groove * 0.90 + smoothstepRev(0.006, 0.013, pl.rivet) * 0.35 + bead * 0.15);
	var sub = 0.0;
	if (riv > 0.5) { sub = 3.0; } else if (bead > 0.45) { sub = 2.0; } else if (groove > 0.5) { sub = 1.0; } else if (stencil > 0.5) { sub = 4.0; }
	return vec4<f32>(h, soot, cav, sub + pl.hash * 0.999);
}

// --- 14 lattice -------------------------------------------------------------
// Field-bolted bridge work: angle-iron and diagonal girder flanges meet on gusset
// plates, every join carries washers and bolt heads, and the infill is either
// corrugated galvanised sheet or canvas laced through eyelets (§9.1).
// matId: 0 corrugated zinc, 1 girder, 2 gusset, 3 fastener, 4 canvas, 5 lacing.
fn fieldLattice(uv: vec2<f32>) -> vec4<f32> {
	let s = P.seed;
	// Higher fastener density than Foundry is deliberate: the Lattice is shipped flat
	// and assembled in the field, so its joins must outnumber the welded faction's.
	let pl = plateLattice(uv, 4, 38.0, s + 5u);
	let isCanvas = step(0.78, pl.hash);
	let isSheet = 1.0 - isCanvas;

	// Plate boundaries carry angle iron. A diagonal member crosses every bay, with its
	// handedness fixed by the row hash, so the surface echoes the open truss silhouette
	// instead of becoming another solid plate skin.
	let edgeIron = 1.0 - smoothstep(0.008, 0.022, pl.seam);
	let diagonalX = select(pl.lx, 1.0 - pl.lx, pl.rowHash > 0.5);
	let diagonal = (1.0 - smoothstep(0.030, 0.065, abs(pl.ly - diagonalX))) * bandK(18.0);
	let girder = max(edgeIron, diagonal);

	// Four neighbouring corner triangles meet as one diamond-shaped gusset at a node.
	// Their fasteners come from the denser plate-lattice run below.
	let corner = min(
		min(pl.lx + pl.ly, (1.0 - pl.lx) + pl.ly),
		min(pl.lx + (1.0 - pl.ly), (1.0 - pl.lx) + (1.0 - pl.ly)),
	);
	let gusset = (1.0 - smoothstep(0.16, 0.29, corner)) * bandK(14.0);
	let washer = smoothstepRev(0.0034, 0.0095, pl.rivet) * bandK(76.0);
	let bolt = smoothstepRev(0.0017, 0.0058, pl.rivet) * bandK(76.0);

	// Galvanised infill has a real 80 mm-ish corrugation pitch. Screws land on the
	// crowns in regular transverse runs, dimpling the sheet around each head.
	let corrPhase = fract(aniPhase(uv, 24.0));
	let corr = cos(corrPhase * TAU) * isSheet * bandK(24.0);
	let corrDist = min(corrPhase, 1.0 - corrPhase);
	let crossPhase = fract((-P.aniB * uv.x + P.aniA * uv.y) * 7.0);
	let crossDist = min(crossPhase, 1.0 - crossPhase);
	let screwDist = length(vec2<f32>(corrDist, crossDist));
	let sheetDimple = (1.0 - smoothstep(0.035, 0.115, screwDist)) * isSheet * bandK(24.0);
	let sheetScrew = (1.0 - smoothstep(0.014, 0.045, screwDist)) * isSheet * bandK(48.0);

	// Canvas is hemmed inside the frame, then laced through metal eyelets. The cord
	// wanders between eyelets rather than forming a printed line, and the crossed weave
	// stays below the half-metre identity band.
	let hem = (1.0 - smoothstep(0.012, 0.034, pl.seam)) * isCanvas;
	let laceOffset = 0.027 + 0.008 * sin(pl.along * 34.0 * TAU);
	let lace = (1.0 - smoothstep(0.0025, 0.0065, abs(pl.seam - laceOffset))) *
		isCanvas * bandK(68.0);
	let eyelet = washer * isCanvas;
	let weave =
		sin(aniPhase(uv, 68.0) * TAU) *
		sin((-P.aniB * uv.x + P.aniA * uv.y) * 68.0 * TAU) *
		isCanvas * bandK(68.0);

	// Zinc spangle is crystalline grain, not glitter: shallow cell boundaries, with
	// white bloom/chalking driven by the broad weather field in the shading pass.
	let sp = worley(uv * 46.0, 46, s + 17u);
	let spangle = (1.0 - smoothstep(0.025, 0.105, sp.y - sp.x)) * isSheet * bandK(46.0);
	let broadWeather = fbm(warp2(uv * 4.0, 4, 0.45, s + 23u), 4, 5, 0.58, s + 29u);
	let edgeWeather = saturate(girder * 0.28 + gusset * 0.22 + washer * 0.45 + sheetDimple * 0.18);
	let weather = saturate(0.32 + broadWeather * 0.46 + P.wearBias * 0.75 + edgeWeather);

	let h = (
		corr * 0.20 +
		girder * 0.58 +
		gusset * 0.32 +
		washer * 0.22 +
		bolt * 0.68 -
		sheetDimple * 0.18 +
		sheetScrew * 0.42 +
		hem * 0.12 +
		lace * 0.24 +
		weave * 0.055 +
		spangle * 0.028
	) * P.heightScale;
	let cav = saturate(
		(1.0 - edgeIron) * diagonal * 0.16 +
		washer * 0.32 +
		sheetDimple * 0.55 +
		hem * 0.22 +
		lace * 0.18 +
		(0.5 - corr * 0.5) * isSheet * 0.16
	);
	var sub = 0.0;
	if (isCanvas > 0.5) { sub = 4.0; }
	if (girder > 0.5) { sub = 1.0; }
	if (gusset > 0.5) { sub = 2.0; }
	if (lace > 0.5) { sub = 5.0; }
	if (bolt > 0.5 || eyelet > 0.5 || sheetScrew > 0.5) { sub = 3.0; }
	return vec4<f32>(h, weather, cav, sub + pl.hash * 0.999);
}

// --- 15 drift ---------------------------------------------------------------
// Salvage: large regions of mismatched material fastened together and abandoned.
// matId: 0 rusted plate, 1 bleached panel, 2 bare corroded metal, 3 board, 4 fastener.
fn fieldDrift(uv: vec2<f32>) -> vec4<f32> {
	let s = P.seed;
	let reg = worley(warp2(uv * 3.0, 3, 0.55, s + 7u), 3, s + 11u);
	let regId = floor(reg.z * 4.0);
	let boundary = 1.0 - smoothstep(0.0, 0.035, reg.y - reg.x);
	let pl = plateLattice(uv, 4, 18.0, s + 13u);
	let bolt = smoothstepRev(0.0018, 0.0055, pl.rivet) * step(0.45, reg.z) * bandK(60.0);
	// Boards run across their own region; corrugation runs across the plate regions.
	let boardPhase = aniPhase(uv, 12.0);
	let board = (sin(boardPhase * TAU) * 0.5 + 0.5) * step(2.5, regId) * bandK(12.0);
	let corr = sin((aniPhase(uv, 9.0) + reg.z) * TAU) * step(regId, 0.5) * bandK(9.0);
	let pit = worley(uv * 30.0, 30, s + 23u);
	let pits = smoothstepRev(0.02, 0.20, pit.x) * step(0.55, pit.z) * bandK(30.0);
	let rough = fbm(uv * 10.0, 10, 5, 0.5, s + 29u);
	let h = (rough * 0.22 + board * 0.24 + corr * 0.26 + bolt * 0.60 - pits * 0.34 - boundary * 0.40) * P.heightScale;
	let decay = saturate(0.55 + 0.55 * fbm(uv * 4.0, 4, 5, 0.55, s + 31u) + P.wearBias);
	let cav = saturate(boundary * 0.9 + pits * 0.6);
	var sub = regId;
	if (bolt > 0.5) { sub = 4.0; }
	return vec4<f32>(h, decay, cav, sub + reg.z * 0.999);
}

fn ssField(uv: vec2<f32>) -> vec4<f32> {
	switch (P.kind) {
		case 0u:  { return fieldSoil(uv); }
		case 1u:  { return fieldRock(uv); }
		case 2u:  { return fieldSand(uv); }
		case 3u:  { return fieldGravel(uv); }
		case 4u:  { return fieldGrass(uv); }
		case 5u:  { return fieldRoad(uv); }
		case 6u:  { return fieldMetal(uv); }
		case 7u:  { return fieldConcrete(uv); }
		case 8u:  { return fieldWater(uv); }
		case 9u:  { return fieldShallow(uv); }
		case 10u: { return fieldSnow(uv); }
		case 11u: { return fieldAsh(uv); }
		case 12u: { return fieldResource(uv); }
		case 13u: { return fieldFoundry(uv); }
		case 14u: { return fieldLattice(uv); }
		case 15u: { return fieldDrift(uv); }
		// Unreachable: the set table is closed and validated on the CPU side. A visible
		// flat surface beats a silent zero if it ever is reached.
		default:  { return vec4<f32>(0.0, 0.5, 0.0, 0.0); }
	}
}
`

export const FIELD_ENTRY_WGSL = /* wgsl */ `
@compute @workgroup_size(8, 8, 1)
fn forgeField(@builtin(global_invocation_id) gid: vec3<u32>) {
	// Every mip resolution is a power of two and at least 8, so the dispatch covers the
	// image exactly and no bounds test is needed in the inner loop.
	let uv = (vec2<f32>(f32(gid.x), f32(gid.y)) + vec2<f32>(0.5)) / f32(P.res);
	textureStore(fieldOut, vec2<i32>(i32(gid.x), i32(gid.y)), ssField(uv));
}
`
