// STEELSEED — materials/wgsl-common
// The WGSL toolkit both forge passes share: the uniform block, integer hashing, and a
// set of noise primitives that are PERIODIC by construction.
//
// Periodicity is not a nicety here. Every surface set is a tiling detail texture laid
// over terrain and hulls, so a generator whose lattice does not wrap produces a visible
// seam on every tile boundary in the world. Each primitive therefore takes an explicit
// integer cell period and wraps its lattice coordinates through it, and every domain
// warp is built from the same periodic fields — f(p + w(p)) still has period P when both
// f and w do, which is what lets the warped surfaces stay seamless.
//
// Band limiting is the second reason these take a period. The mip chain is GENERATED,
// not box-filtered: each mip re-runs the same functions at its own resolution and fades
// out any octave whose lattice is finer than that resolution can carry. Box-filtering a
// normal map averages directions and flattens wrongly; re-deriving the normal from a
// band-limited height field is correct, and costs one extra dispatch per mip.
//
// Hard rule 5: there is no randomness here at all. Every value is a pure function of the
// integer lattice coordinate and the seed words in the uniform block, so two runs of the
// same asset seed produce byte-identical textures.

/**
 * Metres spanned by the full 0..1 range of the packed height channel, as a multiple of a
 * set's `heightScale`. It is wider than 1 because `heightScale` is the amplitude the
 * generator composes at, not the extreme it reaches: the measured extremes across all
 * sixteen sets run to -1.17 and +1.03 of it, so anything narrower than this clips the
 * deepest crack and the tallest stone into flat plateaus. Consumers never need this
 * number — SsSetInfo.heightRange is already the product.
 */
export const HEIGHT_ENCODE_SPAN = 2.5

/**
 * Uniform block, 128 bytes, uploaded once for every (set, layer, mip) and selected with
 * a dynamic offset. Field order matches `buildParams` in forge.ts exactly — WGSL's
 * std140-ish rules give vec4 a 16-byte alignment, so the scalars are grouped ahead of
 * the tints to keep the struct free of implicit padding.
 */
export const PARAMS_WGSL = /* wgsl */ `
struct Params {
	res: u32,
	kind: u32,
	layer: u32,
	mip: u32,
	seed: u32,
	seedB: u32,
	pitchA: u32,
	pitchN: u32,
	pitchM: u32,
	octaves: u32,
	pad0: u32,
	pad1: u32,
	tileMeters: f32,
	heightScale: f32,
	nyquist: f32,
	aniA: f32,
	aniB: f32,
	wearBias: f32,
	colorJitter: f32,
	pad2: f32,
	tintA: vec4<f32>,
	tintB: vec4<f32>,
	tintC: vec4<f32>,
}

@group(0) @binding(0) var<uniform> P: Params;

const TAU: f32 = 6.28318530717958647;
const HEIGHT_ENCODE_SPAN: f32 = ${HEIGHT_ENCODE_SPAN.toFixed(4)};

/**
 * Radius, in tile fractions, at which curvature and the near field of the occlusion
 * march are sampled. Wear has a physical size — paint comes off the outer centimetre or
 * two of a lip, not off one texel — so both are measured in metres and converted to a
 * texel radius per mip. A texel-radius stencil would make the wear pattern finer at
 * every mip level and the material would visibly change as the camera pulled back.
 */
const WEAR_TILE_FRACTION: f32 = 0.006;
`

export const NOISE_WGSL = /* wgsl */ `
// ---------------------------------------------------------------------------
// Integer hashing. A multiply-xor-shift finaliser, not a sin(dot(...)) fract —
// trigonometric hashes differ between drivers in the low bits, which would break the
// byte-identical-per-seed property the reproducibility gate measures.
// ---------------------------------------------------------------------------

fn hashU(v: u32) -> u32 {
	var x = v;
	x = x ^ (x >> 16u);
	x = x * 0x7feb352du;
	x = x ^ (x >> 15u);
	x = x * 0x846ca68bu;
	x = x ^ (x >> 16u);
	return x;
}

fn u2f(h: u32) -> f32 {
	return f32(h >> 8u) * (1.0 / 16777216.0);
}

/** Lattice coordinate wrapped into [0,period). WGSL's % keeps the sign, hence the fold. */
fn wrapCell(c: vec2<i32>, per: vec2<i32>) -> vec2<i32> {
	return ((c % per) + per) % per;
}

fn hashCell(c: vec2<i32>, per: vec2<i32>, seed: u32) -> u32 {
	let w = wrapCell(c, per);
	return hashU((u32(w.x) * 0x27d4eb2du) ^ (u32(w.y) * 0x85ebca6bu) ^ seed);
}

/**
 * Amplitude for a feature whose lattice has 'cells' repeats across the tile. Fades to
 * zero as the feature approaches two texels wide, which is what makes a coarse mip
 * genuinely smoother rather than merely aliased at a lower resolution.
 */
fn bandK(cells: f32) -> f32 {
	return 1.0 - smoothstep(P.nyquist * 0.25, P.nyquist * 0.5, cells);
}

// WGSL requires smoothstep's low edge below its high edge. Call sites read better
// with the descending form, so the inversion lives here once: identical to
// 1.0 - smoothstep(hi, lo, x) with the arguments in call-site order.
fn smoothstepRev(lo: f32, hi: f32, x: f32) -> f32 {
	return 1.0 - smoothstep(hi, lo, x);
}
/** Feather a hard boundary by one texel so plate seams do not shimmer down the chain. */
fn edgeAA(d: f32, r: f32) -> f32 {
	let t = 1.5 / f32(P.res);
	return smoothstep(r - t, r + t, d);
}

fn grad2(c: vec2<i32>, per: vec2<i32>, seed: u32) -> vec2<f32> {
	let a = u2f(hashCell(c, per, seed)) * TAU;
	return vec2<f32>(cos(a), sin(a));
}

/** Periodic gradient noise, roughly [-1,1]. */
fn perlin(p: vec2<f32>, cells: i32, seed: u32) -> f32 {
	let per = vec2<i32>(cells, cells);
	let i0 = vec2<i32>(floor(p));
	let f = p - floor(p);
	let w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
	let n00 = dot(grad2(i0, per, seed), f);
	let n10 = dot(grad2(i0 + vec2<i32>(1, 0), per, seed), f - vec2<f32>(1.0, 0.0));
	let n01 = dot(grad2(i0 + vec2<i32>(0, 1), per, seed), f - vec2<f32>(0.0, 1.0));
	let n11 = dot(grad2(i0 + vec2<i32>(1, 1), per, seed), f - vec2<f32>(1.0, 1.0));
	return mix(mix(n00, n10, w.x), mix(n01, n11, w.x), w.y) * 1.4142136;
}

/** Periodic value noise, [0,1]. Cheaper than perlin and blockier, which suits grit. */
fn valueN(p: vec2<f32>, cells: i32, seed: u32) -> f32 {
	let per = vec2<i32>(cells, cells);
	let i0 = vec2<i32>(floor(p));
	let f = p - floor(p);
	let w = f * f * (3.0 - 2.0 * f);
	let v00 = u2f(hashCell(i0, per, seed));
	let v10 = u2f(hashCell(i0 + vec2<i32>(1, 0), per, seed));
	let v01 = u2f(hashCell(i0 + vec2<i32>(0, 1), per, seed));
	let v11 = u2f(hashCell(i0 + vec2<i32>(1, 1), per, seed));
	return mix(mix(v00, v10, w.x), mix(v01, v11, w.x), w.y);
}

/**
 * Band-limited fbm, roughly [-1,1]. The normaliser accumulates the FULL octave
 * amplitude while the sum accumulates the faded one, so dropping an octave reduces
 * contrast instead of being renormalised straight back up — that difference is the
 * whole reason the generated mip chain looks like distance rather than like mush.
 */
fn fbm(p: vec2<f32>, cells: i32, octaves: i32, gain: f32, seed: u32) -> f32 {
	var amp = 1.0;
	var sum = 0.0;
	var norm = 0.0;
	var q = p;
	var per = cells;
	for (var i = 0; i < octaves; i++) {
		let k = bandK(f32(per));
		if (k > 0.0) {
			sum = sum + perlin(q, per, seed + u32(i) * 0x9e37u) * amp * k;
		}
		norm = norm + amp;
		amp = amp * gain;
		q = q * 2.0;
		per = per * 2;
	}
	return sum / max(norm, 1e-5);
}

/** Ridged fbm, [0,1]. Sharp crests, rounded valleys — strata and sastrugi. */
fn ridged(p: vec2<f32>, cells: i32, octaves: i32, gain: f32, seed: u32) -> f32 {
	var amp = 1.0;
	var sum = 0.0;
	var norm = 0.0;
	var q = p;
	var per = cells;
	for (var i = 0; i < octaves; i++) {
		let k = bandK(f32(per));
		if (k > 0.0) {
			let n = 1.0 - abs(perlin(q, per, seed + u32(i) * 0x85e1u));
			sum = sum + n * n * amp * k;
		}
		norm = norm + amp;
		amp = amp * gain;
		q = q * 2.0;
		per = per * 2;
	}
	return sum / max(norm, 1e-5);
}

/** Periodic Worley. Returns (F1, F2, cellHash01). F1 <= ~1.4 for jittered points. */
fn worley(p: vec2<f32>, cells: i32, seed: u32) -> vec3<f32> {
	let per = vec2<i32>(cells, cells);
	let ip = vec2<i32>(floor(p));
	let fp = p - floor(p);
	var f1 = 8.0;
	var f2 = 8.0;
	var id = 0.0;
	for (var dy = -1; dy <= 1; dy++) {
		for (var dx = -1; dx <= 1; dx++) {
			let h = hashCell(ip + vec2<i32>(dx, dy), per, seed);
			let o = vec2<f32>(f32(dx) + u2f(h), f32(dy) + u2f(hashU(h))) - fp;
			let d = length(o);
			if (d < f1) {
				f2 = f1;
				f1 = d;
				id = u2f(hashU(h ^ 0x9e3779b9u));
			} else if (d < f2) {
				f2 = d;
			}
		}
	}
	return vec3<f32>(f1, f2, id);
}

/**
 * Periodic Worley returning the OFFSET to the nearest cell point in xy, its distance in
 * z and the cell hash in w. The offset is what lets a feature be built in the cell's own
 * frame — a tilted crystal facet, a stone's own axis — instead of in the tile's frame.
 * Anything keyed to the tile's fractional coordinate instead breaks along a regular grid
 * that has nothing to do with the cells, which shows up as hard lines across the surface.
 */
fn worleyCell(p: vec2<f32>, cells: i32, seed: u32) -> vec4<f32> {
	let per = vec2<i32>(cells, cells);
	let ip = vec2<i32>(floor(p));
	let fp = p - floor(p);
	var best = vec2<f32>(0.0, 0.0);
	var f1 = 8.0;
	var id = 0.0;
	for (var dy = -1; dy <= 1; dy++) {
		for (var dx = -1; dx <= 1; dx++) {
			let h = hashCell(ip + vec2<i32>(dx, dy), per, seed);
			let o = vec2<f32>(f32(dx) + u2f(h), f32(dy) + u2f(hashU(h))) - fp;
			let d = length(o);
			if (d < f1) {
				f1 = d;
				best = o;
				id = u2f(hashU(h ^ 0x9e3779b9u));
			}
		}
	}
	return vec4<f32>(best, f1, id);
}

/**
 * Domain warp in cell units. Both warp channels are periodic on the same lattice as the
 * field they displace, so the warped result still tiles exactly.
 */
fn warp2(p: vec2<f32>, cells: i32, amount: f32, seed: u32) -> vec2<f32> {
	let wx = fbm(p, cells, 3, 0.5, seed ^ 0x1b873593u);
	let wy = fbm(p, cells, 3, 0.5, seed ^ 0x68bc21ebu);
	return p + vec2<f32>(wx, wy) * amount;
}

/**
 * Phase of a straight feature running along an integer lattice direction. Integer
 * coefficients are mandatory: a free rotation of the domain destroys tiling, so
 * anisotropy (brushing, ripples, strata, wheel tracks) varies per layer by picking a
 * different integer direction rather than by rotating the uv.
 */
fn aniPhase(uv: vec2<f32>, reps: f32) -> f32 {
	return (P.aniA * uv.x + P.aniB * uv.y) * reps;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** Exact sRGB OETF. Albedo is written encoded and read back through an -srgb view. */
fn srgbEnc(c: vec3<f32>) -> vec3<f32> {
	let lo = c * 12.92;
	let hi = 1.055 * pow(max(c, vec3<f32>(1e-6)), vec3<f32>(1.0 / 2.4)) - 0.055;
	return select(hi, lo, c <= vec3<f32>(0.0031308));
}

/** Octahedral encode to [0,1]^2. Two channels, not three (ARCHITECTURE.md §12.1). */
fn octEncode(n: vec3<f32>) -> vec2<f32> {
	let l = abs(n.x) + abs(n.y) + abs(n.z);
	var p = n.xy / max(l, 1e-8);
	if (n.z < 0.0) {
		let s = vec2<f32>(select(-1.0, 1.0, p.x >= 0.0), select(-1.0, 1.0, p.y >= 0.0));
		p = (vec2<f32>(1.0, 1.0) - abs(vec2<f32>(p.y, p.x))) * s;
	}
	return p * 0.5 + vec2<f32>(0.5);
}
`

export const LATTICE_WGSL = /* wgsl */ `
// ---------------------------------------------------------------------------
// Structural plate lattice. Both passes derive identity from uv rather than reading it
// out of the field texture, because the shading pass needs the whole-panel identity to place
// player colour on WHOLE panels — a mask blurred through an interpolated channel would
// give a hue wash at the boundary, which §9 explicitly rules out.
// ---------------------------------------------------------------------------

struct Plate {
	hash: f32,
	/** Distance to the nearest plate boundary, tile units. */
	seam: f32,
	/** Distance to the nearest rivet centre, tile units. */
	rivet: f32,
	/** Coordinate running along the nearest seam, tile units — welds bead along it. */
	along: f32,
	/** 1 when the nearest seam is vertical. */
	vert: f32,
	/** Plate-local coordinates, [0,1). */
	lx: f32,
	ly: f32,
	/** Row index hash — drives the overlap direction of the plate lip. */
	rowHash: f32,
}

/**
 * Staggered plate courses. Rows are a fixed subdivision of the tile; the column count
 * and the horizontal offset of each row are hashed but always land on that row's own
 * column lattice, so every boundary still coincides at uv 0 and 1 and the plating tiles.
 * Real plate work staggers its joints; a regular grid reads instantly as a texture.
 */
fn plateLattice(uv: vec2<f32>, rows: i32, rivetDensity: f32, seed: u32) -> Plate {
	let fy = uv.y * f32(rows);
	let row = i32(floor(fy));
	let ly = fy - floor(fy);
	let rowSeed = hashCell(vec2<i32>(row, 0), vec2<i32>(rows, 1), seed);

	let cols = 3 + i32(u2f(rowSeed) * 4.0);
	let shift = floor(u2f(hashU(rowSeed)) * f32(cols)) / f32(cols);
	let fx = fract(uv.x + shift) * f32(cols);
	let col = i32(floor(fx));
	let lx = fx - floor(fx);

	let pw = 1.0 / f32(cols);
	let ph = 1.0 / f32(rows);
	let dx = min(lx, 1.0 - lx) * pw;
	let dy = min(ly, 1.0 - ly) * ph;
	let isVert = dx < dy;

	// Rivets sit inside the border in regular runs down each edge of the plate.
	let ri = 0.075;
	let nrx = max(3, i32(round(pw * rivetDensity)));
	let sx = (floor(lx * f32(nrx)) + 0.5) / f32(nrx);
	let nry = max(3, i32(round(ph * rivetDensity)));
	let sy = (floor(ly * f32(nry)) + 0.5) / f32(nry);
	var rd = length(vec2<f32>((lx - sx) * pw, (ly - ri) * ph));
	rd = min(rd, length(vec2<f32>((lx - sx) * pw, (ly - (1.0 - ri)) * ph)));
	rd = min(rd, length(vec2<f32>((lx - ri) * pw, (ly - sy) * ph)));
	rd = min(rd, length(vec2<f32>((lx - (1.0 - ri)) * pw, (ly - sy) * ph)));

	var o: Plate;
	o.hash = u2f(hashCell(vec2<i32>(col, row), vec2<i32>(cols, rows), seed ^ 0x51ed270bu));
	o.seam = min(dx, dy);
	o.rivet = rd;
	o.along = select(uv.x, uv.y, isVert);
	o.vert = select(0.0, 1.0, isVert);
	o.lx = lx;
	o.ly = ly;
	o.rowHash = u2f(hashU(rowSeed ^ 0x2545f491u));
	return o;
}

`
