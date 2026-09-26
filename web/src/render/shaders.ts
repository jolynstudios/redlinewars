// STEELSEED — render/shaders
// Every WGSL module the renderer compiles, as source strings.
//
// They live in .ts rather than .wgsl files because hard rule 4 forbids build plugins
// pulling anything extra into the bundle, and a '?raw' import is an asset pipeline we do
// not need. Concatenation is explicit so the shared prelude appears exactly once per
// module and a binding number is written in exactly one place.
//
// Conventions that bind every module here:
//   * Reverse-Z. Depth 1 is the near plane, 0 is infinitely far. Compare is 'greater',
//     the depth clear is 0.0, and the shadow ortho matrices are built with near/far
//     swapped so cascades share the convention. Mixing conventions is the single most
//     productive way to produce a black screen with no error anywhere.
//   * Y is up, X east, Z south, one cell is one metre (§12.4). No module re-swaps axes.
//   * Group 0 is the frame, group 1 the material set, group 2 the instance stream.

import { FRAME_WGSL } from './frame'
import { INSTANCE_APPEARANCE_WGSL } from './instance-appearance'
import { TERRAIN_MACRO_WGSL } from './terrain-macro'
import { WINDOW_OCCUPANCY_WGSL } from './window-occupancy'
import { TRACK_DEFORM_WGSL, TRACK_PREVIOUS_WGSL } from './track-deform'
import { CONTACT_DEBUG, CONTACT_ENABLED, contactWgsl } from './contact'
import { REFLECTION_DEBUG, REFLECTION_ENABLED, REFLECTION_MASK, REFLECTION_METADATA_WGSL, REFLECTION_WGSL } from './reflection'
import { MATERIAL_ZONE_LAYER_MASK, Zone, ZoneFlag } from '../geo/zone'
import { OCT_DECODE_WGSL } from '../core/oct-decode'
import blenderPalette from '../core/blender-palette.json'
import type { RenderQuality } from '../core/config'

// Stage-2 bloom has one defeat scalar shared with post.ts. Zero is a structural defeat:
// the legacy forward/TAA/post shader bodies are generated and no bloom pass is built or
// encoded. This is stronger than multiplying the result by zero after doing the work.
export const BLOOM_INTENSITY = 0.35
export const BLOOM_ENABLED = BLOOM_INTENSITY > 0
export const BLOOM_RADIUS_PX = 8

/** Coarse water normals shared by lighting and screen-space reflection rays. */
const WATER_MOTION_WGSL = /* wgsl */ `
fn waterWaveSlope(p: vec2<f32>) -> vec2<f32> {
	let seconds = frame.surfaceWeather.z;
	let wind = normalize(frame.weather.xy + vec2<f32>(0.0001, 0.0002));
	let crosswind = vec2<f32>(-wind.y, wind.x);
	let a = dot(p, wind);
	let b = dot(p, crosswind);
	let waveA = a * 6.5 + sin(b * 1.7) * 0.7 - seconds * (1.6 + frame.weather.z * 1.4);
	let waveB = a * 11.0 + b * 2.2 - seconds * 2.6;
	let waveC = -a * 3.7 + b * 5.2 + seconds * 1.2;
	return (wind * (cos(waveA) * .11 + cos(waveB) * .06) +
		crosswind * (cos(waveC) * .09 + cos(a * 2.8 - b * 3.3 - seconds) * .035)) * (.35 + frame.weather.z);
}
`

/** Shared scalar helpers. WGSL has no saturate and no luminance. */
const PRELUDE = /* wgsl */ `
const PI: f32 = 3.14159265359;
const INV_PI: f32 = 0.31830988618;

// Stage-1 functional status emission. One named scalar so the zero-intensity witness
// removes the term without changing its placement or area.
const STATUS_EMISSIVE_INTENSITY: f32 = 0.50;

fn sat(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }
fn sat3(x: vec3<f32>) -> vec3<f32> { return clamp(x, vec3<f32>(0.0), vec3<f32>(1.0)); }
fn luma(c: vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)); }

fn statusEligibility(materialClass: f32, unitUv: vec2<f32>) -> f32 {
	return step(0.5, unitUv.x) * step(0.125, materialClass);
}

fn statusEmission(materialClass: f32, unitUv: vec2<f32>, geoN: vec3<f32>, eligible: f32) -> vec3<f32> {
	// A single horizontal band, expressed in mesh-normalised height rather than repeating
	// material UVs. fwidth keeps the sub-pixel edge stable without baking a filtered mask.
	let distance = abs(unitUv.y - 0.58);
	let aa = max(fwidth(unitUv.y), 1e-5);
	let band = 1.0 - smoothstep(0.008, 0.008 + aa, distance);
	// Status strips belong on hull sides, not deck plates or undersides.
	let side = 1.0 - smoothstep(0.20, 0.45, abs(geoN.y));
	// Equal radiance would not be equal contrast: measured Foundry hulls at this placement
	// are roughly three times brighter than Lattice hulls. Preserve each chromaticity but
	// scale it against its own lit surface so both land inside the same 3-6x budget.
	let warm = vec3<f32>(6.45, 2.04, 0.30);
	// The old cool source measured 2.477x against its lit Lattice hull while Foundry was
	// 5.150x. Scale chromaticity intact by the measured 2.02x correction, landing both
	// faction signals near the centre of the shared 3-6x contrast budget.
	let cool = vec3<f32>(1.328, 1.384, 1.526);
	let emitter = select(warm, cool, materialClass >= 0.50);
	// Binary after interpolation: a fractional selector over one large triangle is the
	// same failure as a filtered texture mask — a broad low-level glowing panel.
	// unitUv.x encodes 0.5 + 0.5 * placement weight (uv1 uploads as unorm16, which clamps
	// at 1.0 — the old [1, 2] stamp reached the GPU flattened to exactly 1.0 and this step
	// read zero on every hull). Weight >= 0.5 is x >= 0.75; the eligibility step at 0.5
	// still separates stamped hulls from the zero sentinel structures keep.
	let placement = step(0.75, unitUv.x);
	return emitter * (STATUS_EMISSIVE_INTENSITY * eligible * placement * band * side);
}

struct Light {
	// xyz world position, w radius in metres
	posRadius      : vec4<f32>,
	// rgb colour, a intensity
	colorIntensity : vec4<f32>,
	// direction * innerCos; w outerCos, -1 for point lights. CPU stride: 48 bytes.
	directionCone : vec4<f32>,
}

struct Instance {
	model : mat4x4<f32>,
	// rgb player colour, a 1 when the instance is owned (0 disables the repaint)
	tint  : vec4<f32>,
	// x material layers, y bone palette, z phase, w packed damage/presentation opacity
	misc  : vec4<f32>,
}
`

// Forward-fragment only. Keeping this OUT of PRELUDE is structural: PRELUDE is shared by the
// prepass and shadow modules, and the emissive source must not change even their source text.
// The packed bit never participates in skinPosition, either clip expression or any shadow
// module. The prepass/forward position invariant is therefore not involved, rather than merely
// kept in sync by care.
const SURFACE_EMISSION_WGSL = /* wgsl */ `
// Recalibrated 2026-09-06. This was 3.00 against an emitter colour of (6.45, 2.04, 0.30), so
// nearly 20x overbright in red -- which never showed, because the fragment ANDed the authored
// emissive flag with a sampled material class and fx never passed it. The moment that veto was
// removed the whole effect layer emitted for the first time and every muzzle flash bloomed into
// a white teardrop the length of the tank firing it. Bright enough to read as ignition, not
// bright enough to blow out, is the calibration a player actually sees.
const SURFACE_EMISSIVE_INTENSITY: f32 = 0.85;

fn surfaceEmitterColor(materialClass: f32) -> vec3<f32> {
	let warm = vec3<f32>(6.45, 2.04, 0.30);
	// Same emitter class as statusEmission. Surface and analytic sources must not disagree
	// about what the material packer's 0.75 class means.
	let cool = vec3<f32>(1.328, 1.384, 1.526);
	return select(warm, cool, materialClass >= 0.50);
}

// The per-DRAW-ITEM emitter, §12.2's instance tint carrying a colour instead of a repaint.
//
// The two emitters above are chosen by the material SET's own class byte, so before this the
// engine offered exactly two emissive colours project-wide and a per-weapon tracer colour was
// unreachable rather than merely unread. A negative tint alpha marks an item whose rgb IS the
// emitter; playerColorTable stores alpha as a byte over 255 and unowned instances write 0, so
// no instance that existed before this can take the branch and no shipped draw changes.
fn instanceEmitterColor(materialClass: f32, tint: vec4<f32>) -> vec3<f32> {
	return select(surfaceEmitterColor(materialClass), tint.rgb, tint.a < 0.0);
}

// True when the emitter reads cool, for the bloom key's sign. An item-supplied emitter votes on
// its own chroma rather than on the set it happens to be drawn with, so a blue electrical effect
// blooms blue even though it shares the warm Foundry texture set with every other effect.
fn emitterIsCool(materialClass: f32, tint: vec4<f32>) -> bool {
	return select(materialClass >= 0.50, tint.b > tint.r, tint.a < 0.0);
}
`

// The cloud noise field, shared by the sky dome (where the clouds are DRAWN) and the
// forward pass (where their SHADOWS fall on the ground). One field, two consumers: a
// shadow that does not line up with the cloud above it is worse than no shadow.
export const CLOUD_FIELD_WGSL = `fn hash2(p: vec2<i32>, seed: u32) -> f32 {
	var h = u32(p.x) * 374761393u + u32(p.y) * 668265263u + seed * 2246822519u;
	h = (h ^ (h >> 13u)) * 1274126177u;
	h = h ^ (h >> 16u);
	return f32(h & 0xffffffu) * (1.0 / 16777215.0);
}
fn valueNoise(p: vec2<f32>, seed: u32) -> f32 {
	let cell = vec2<i32>(floor(p));
	let t = fract(p);
	let f = t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
	let a = hash2(cell, seed);
	let b = hash2(cell + vec2<i32>(1, 0), seed);
	let c = hash2(cell + vec2<i32>(0, 1), seed);
	let d = hash2(cell + vec2<i32>(1, 1), seed);
	return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
fn cloudField(p: vec2<f32>, seed: u32) -> f32 {
	var sum = 0.0;
	var amp = 0.5;
	var q = p;
	for (var i = 0u; i < 2u; i = i + 1u) {
		sum = sum + valueNoise(q, seed + i * 9781u) * amp;
		q = q * 2.13;
		amp = amp * 0.5;
	}
	return sum;
}
`
const EDGE_FOG_WGSL = /* wgsl */ `
// --- the world edge, and the fog that hides it -----------------------------------
//
// Forward-fragment only, for the same structural reason SURFACE_EMISSION_WGSL is: PRELUDE is
// shared by the prepass and the shadow modules and neither may see a line of this. Nothing
// here reads 'frame', so it composes ahead of FRAME_BINDINGS and the caller supplies the
// three quantities that come from the uniform.
//
// THE BANDS. Both are metres OUTSIDE the playable rectangle (one cell is one render metre)
// and both are now FRACTIONS of the scenery ring's own depth, which arrives per frame in
// frame.edge.x from terrain's setApron. They used to be absolute -- haze 12..44 m, veil
// 26..46 m -- against a ring that terrain/apron.ts builds 24/32/40/48 cells deep by quality
// preset. Measured as the fraction of the veil's ramp completed at the ring's OUTER edge,
// which is where the geometry stops and the sky begins:
//
//     low     24 cells      0%     the world ended in a line, at full opacity
//     medium  32 cells     22%
//     high    40 cells     78%
//     ultra   48 cells    100%     the only preset the absolute band was ever right for
//
// An absolute band encodes exactly one ring depth, the same way an absolute metre threshold
// encodes the crest height it was written against -- which is the argument aprongate's own
// header makes about the ring. Fractions finish inside the geometry on all four presets, and
// they keep the deeper presets' extra mountain clear for proportionally longer instead of
// clamping every preset down to what 'low' can draw.
const EDGE_HAZE_NEAR: f32 = 0.25;
const EDGE_HAZE_FAR: f32 = 0.80;
/** Opacity of the curtain at ground level, at full distance outside the map. */
const EDGE_HAZE_STRENGTH: f32 = 0.95;
/** Metres of altitude over which the curtain falls away, sparing summits. */
const EDGE_HAZE_SCALE_M: f32 = 30.0;
/** What the medium's colour is multiplied by at full boundary strength. Black fog, dimmed
 * far enough to swallow a lit crest but not to a hole: it keeps the sky's own hue, so the
 * ring approaches the colour behind it instead of cutting a silhouette out of it. */
const EDGE_HAZE_FLOOR: f32 = 0.62;
/** Where the ring's ground starts becoming unexplored, and where it is fully unknown. */
const EDGE_VEIL_NEAR: f32 = 0.50;
const EDGE_VEIL_FAR: f32 = 0.92;
/** Where the border cell's own visibility state stops being carried outward and the ring
 * settles to remembered ground. Was an absolute 2..16 cells, which is two thirds of the
 * 'low' ring and a third of 'ultra''s. */
const EDGE_CARRY_NEAR: f32 = 0.05;
const EDGE_CARRY_FAR: f32 = 0.34;
/** Floor under the ring depth. '?apron=0' and the gates that measure the playable mesh alone
 * report a ring of zero; smoothstep is undefined when its two edges meet, and a shader that
 * returns NaN for a configuration a gate uses is a shader that will be debugged twice. */
const EDGE_RING_MIN_M: f32 = 4.0;
/** Metres of altitude the boundary veil stays fully dense to -- the eaves of the fog layer. */
const EDGE_VEIL_BASE_M: f32 = 12.0;
/** Metres of altitude over which it thins above that. A summit standing out of fog is
 * mountain country; the straight line of LOW ground against sky is the thing being hidden,
 * and that is what the base height covers outright. */
const EDGE_VEIL_SCALE_M: f32 = 34.0;
/** Metres the fog field swells and sinks that ceiling, so the layer has a billowing surface
 * instead of a level. This is the term that stops the ring reading as stacked slabs. */
const EDGE_VEIL_SWELL_M: f32 = 26.0;
/** Fraction of the ring's depth that a thick patch of fog brings the veil INWARD.
 *
 * One-directional on purpose. The whole point of the band is that it finishes inside the
 * geometry; a symmetric warp would push it outward on the thin frames and put the hard edge
 * back for as long as that patch drifted past. */
const EDGE_VEIL_WARP: f32 = 0.10;
/** What the mist is multiplied by where the fog is thinnest and where it is thickest.
 *
 * This was one number, 0.42, so unexplored ground was a single flat colour -- and a flat
 * colour has no depth cue at all, which is exactly what "stacked on stacked" describes. The
 * pair straddles it slightly high: the veil's job at the boundary is to end at the horizon
 * radiance the sky is already drawing, and 0.42 of a desaturated aerial colour sits well
 * under that. */
const EDGE_VEIL_THIN: f32 = 0.31;
const EDGE_VEIL_THICK: f32 = 0.67;
/** Metres per second the fog drifts with no wind at all, and how much the weather adds.
 *
 * The calm term is not decoration. Wind strength is windSpeed/1000 and a clear map runs at
 * 0.12, so a purely wind-proportional drift would be very nearly still -- and a still fog is
 * the paint this replaced. */
const EDGE_FOG_DRIFT_M: f32 = 1.10;
const EDGE_FOG_GUST_M: f32 = 3.00;

/**
 * Value-noise hash, 2 to 1. Sin-free.
 *
 * 'fract(sin(dot(p, k)) * 43758.5453)' is the usual spelling and the water block above uses
 * it, but there the argument is a world cell index that stays small. This one is fed a
 * lattice coordinate that DRIFTS WITH ELAPSED TIME, so its argument grows without bound for
 * as long as the game is open, and sin's precision against a large argument is exactly where
 * that hash stops being a hash. This costs about the same and does not care.
 */
fn edgeHash(p: vec2<f32>) -> f32 {
	var q = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
	q = q + vec3<f32>(dot(q, q.yzx + vec3<f32>(33.33)));
	return fract((q.x + q.y) * q.z);
}

/** One octave of value noise on the unit lattice, smoothstep-interpolated. */
fn edgeNoise(p: vec2<f32>) -> f32 {
	let i = floor(p);
	let f = p - i;
	let u = f * f * (vec2<f32>(3.0) - 2.0 * f);
	let a = edgeHash(i);
	let b = edgeHash(i + vec2<f32>(1.0, 0.0));
	let c = edgeHash(i + vec2<f32>(0.0, 1.0));
	let d = edgeHash(i + vec2<f32>(1.0, 1.0));
	return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/**
 * Suspended density in world space, 0..1, mean near 0.5.
 *
 * Three octaves, each CARRIED AT ITS OWN SPEED. One drift rate for all three is a single
 * sliding texture and the eye finds it in about a second; three rates never repeat their
 * relative phase, which is the whole difference between fog and a moving photograph of fog.
 * Wavelengths are 36 m, 15 m and 6.6 m, which spans a 128-cell map from a handful of banks
 * down to the grain inside one.
 *
 * 'flow' is metres per second times seconds -- the caller multiplies, so the drift is a
 * pure function of absolute presentation time and identical on every machine.
 */
fn edgeFog(p: vec2<f32>, flow: vec2<f32>) -> f32 {
	let a = edgeNoise((p - flow * 0.55) * 0.028);
	let b = edgeNoise((p - flow * 1.00) * 0.067 + vec2<f32>(19.7, 4.3));
	let c = edgeNoise((p - flow * 1.55) * 0.151 + vec2<f32>(41.3, 27.9));
	return sat(a * 0.54 + b * 0.31 + c * 0.15);
}
`

/**
 * Skinning, as its own block because it needs the bones binding and PRELUDE is included by
 * ten modules that do not have one. Included ONLY by the three passes that skin, each after
 * its own bones declaration — the group index differs per pass, the function does not.
 */
const SKIN_WGSL = /* wgsl */ `
// ONE definition, and that is the whole safety argument.
//
// The prepass writes depth and the forward pass tests it with greater-equal and no depth
// write, so the two must compute bit-identical clip positions. WGSL does not guarantee that
// for the same expression in two modules — the compiler contracts differently depending on
// surrounding code — and this project has already shipped see-through holes in the ground
// from exactly that (77f31a1). @invariant fixes it for the position expression, but a skinned
// vertex adds a matrix blend BEFORE the position expression, and @invariant says nothing
// about how that blend is contracted.
//
// So the blend lives here, in the shared prelude, and both entry points call it TEXTUALLY
// IDENTICALLY. Same source characters, same function, one place to change. Do not inline it
// into either pass "for clarity", do not reorder the weight terms in one and not the other,
// and do not add a fast path in the forward pass that the prepass does not have. Any of those
// silently reintroduces the hole.
//
// depthgate.mjs --falsify=skin-divergence exists to prove this is still true. And no
// backticks in this block: it is a TypeScript template literal and one would end it.
//
// paletteBase is the instance's first bone AS A REAL STORAGE INDEX — bones[paletteBase] is
// joint 0, bones[paletteBase + 1] is joint 1, and so on. It is exactly what reserveBones
// returned, with no bias applied at either end.
//
// It was written as bones[paletteBase - 1u + joint] first, on the assumption that the base was
// 1-based so that 0 could mean unskinned. It is not: reserveBones hands back the actual index
// and starts at 1 because slot 0 is the sentinel identity. With the subtraction, a rig with
// base 1 read bones[0] for its first joint — the sentinel — and every joint after it was
// shifted by one, so a two-bone turret rig would have used the identity as its chassis and its
// chassis as its turret, and the turret matrix would never have been read at all. Codex found
// it by reading the two sides against each other before wiring the first consumer.
//
// 0 still means unskinned and still takes the identity path, and it cannot collide with a real
// reservation because reserveBones never returns 0. That is what makes the sentinel slot worth
// its 64 bytes: it removes the need for a bias, and a bias is what went wrong.
//
// Cost on unrigged
// geometry is one comparison.
fn skinPosition(
	pos: vec3<f32>,
	joints: vec4<u32>,
	weights: vec4<f32>,
	paletteBase: u32,
) -> vec4<f32> {
	let p = vec4<f32>(pos, 1.0);
	if (paletteBase == 0u) {
		return p;
	}
	var acc = bones[paletteBase + joints.x] * (p * weights.x);
	acc = acc + bones[paletteBase + joints.y] * (p * weights.y);
	acc = acc + bones[paletteBase + joints.z] * (p * weights.z);
	acc = acc + bones[paletteBase + joints.w] * (p * weights.w);
	return vec4<f32>(acc.xyz, 1.0);
}

// The same blend for a direction. Normals take the rotation but not the translation, and
// they are renormalised by the caller after the instance's own transform.
fn skinDirection(
	dir: vec3<f32>,
	joints: vec4<u32>,
	weights: vec4<f32>,
	paletteBase: u32,
) -> vec3<f32> {
	if (paletteBase == 0u) {
		return dir;
	}
	var acc = (bones[paletteBase + joints.x] * vec4<f32>(dir, 0.0)).xyz * weights.x;
	acc = acc + (bones[paletteBase + joints.y] * vec4<f32>(dir, 0.0)).xyz * weights.y;
	acc = acc + (bones[paletteBase + joints.z] * vec4<f32>(dir, 0.0)).xyz * weights.z;
	acc = acc + (bones[paletteBase + joints.w] * vec4<f32>(dir, 0.0)).xyz * weights.w;
	return acc;
}
`

/**
 * Group 0 as every *graphics* pass sees it. The cull and probe passes need the cluster
 * buffers writable and therefore declare their own group 0 — a bind group layout cannot
 * be read-only in one pipeline and read-write in another.
 */
const FRAME_BINDINGS = /* wgsl */ `
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> lights: array<Light>;
@group(0) @binding(2) var<storage, read> clusterCounts: array<u32>;
@group(0) @binding(3) var<storage, read> clusterLights: array<u32>;
@group(0) @binding(4) var shadowMap: texture_depth_2d_array;
@group(0) @binding(5) var shadowSampler: sampler_comparison;
@group(0) @binding(6) var<storage, read> probes: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read> exposureBuf: array<f32>;
@group(0) @binding(8) var linearSampler: sampler;
@group(0) @binding(9) var shroudMap: texture_2d<f32>;
`

/**
 * Group 1 is the 'materials' node's layout, reached at runtime — this node never imports
 * it (rule 3). ARCHITECTURE.md §12.1 pins the four textures and the sampler, in the order
 * SurfaceSet lists them, and that is what is declared here.
 *
 * The materials layout also carries a per-set uniform beyond binding 4. It is NOT
 * declared: a WGSL module may bind a subset of its layout, and §12.1 does not pin that
 * uniform's struct, so reading it would couple this shader to another node's internals —
 * precisely the failure §3.1 records. The layer count comes from the pinned
 * 'SurfaceSet.layerCount' instead, carried per instance.
 */
const MATERIAL_BINDINGS = /* wgsl */ `
@group(1) @binding(0) var matSampler: sampler;
@group(1) @binding(1) var matAlbedo: texture_2d_array<f32>;
@group(1) @binding(2) var matNormal: texture_2d_array<f32>;
@group(1) @binding(3) var matOrm: texture_2d_array<f32>;
@group(1) @binding(4) var matMask: texture_2d_array<f32>;
@group(1) @binding(6) var matDetail: texture_2d<f32>;
`

/**
 * THE sky gradient. One definition, included by the dome, the specular ambient and the
 * probe integration. Depends on nothing but the frame uniform.
 *
 * It was THREE definitions until sky started publishing a real horizon: the forward clear
 * wrote one, skyRadiance() wrote a second, and the probe pass carried its own copy of the
 * same expression. Each was zenith * 1.45 — an invented constant standing in for a
 * quantity sky computes properly. Drift between them meant the sky you SAW and the sky
 * surfaces REFLECTED disagreed, and nothing in a screenshot makes that visible.
 *
 * The sqrt compresses the gradient towards the horizon, which is where atmospheric path
 * length genuinely changes fastest. Below the horizon it runs to groundRadiance, which is
 * already albedo-weighted by sky — do not multiply by albedo again here.
 *
 * Verified non-inverting: luminance(horizon) >= luminance(zenith) across all 36,000 states
 * of (1440 minutes x 5 weather kinds x 5 intensities), narrowest margin +0.0039 at midnight
 * in heavy rain. An inverted pair would draw a dark band under a bright zenith.
 */
const SKY_GRADIENT = /* wgsl */ `
fn skyGradient(dir: vec3<f32>) -> vec3<f32> {
	let up = clamp(dir.y, -1.0, 1.0);
	if (up >= 0.0) { return mix(frame.horizonColor.rgb, frame.skyColor.rgb, sqrt(up)); }
	return mix(frame.horizonColor.rgb, frame.groundRadiance.rgb, sqrt(-up));
}
`

/** Shared froxel/shadow/probe lookups. Depends on FRAME_BINDINGS. */
const SCENE_LOOKUPS = /* wgsl */ `
/**
 * Cluster index for a fragment. The slice distribution is exponential so froxels stay
 * roughly cubic in view space at every distance — a uniform slicing wastes almost the
 * whole grid on the far half of an RTS camera's range.
 */
fn clusterIndexFor(fragXY: vec2<f32>, viewZ: f32) -> u32 {
	let tilesX = max(frame.clusterDims.x, 1u);
	let tilesY = max(frame.clusterDims.y, 1u);
	let slices = max(frame.clusterDims.z, 1u);
	let tx = min(u32(max(fragXY.x, 0.0) * frame.screen.z * f32(tilesX)), tilesX - 1u);
	let ty = min(u32(max(fragXY.y, 0.0) * frame.screen.w * f32(tilesY)), tilesY - 1u);
	let z = max(viewZ, frame.clusterZ.x);
	let raw = log(z) * frame.clusterZ.z + frame.clusterZ.w;
	let sl = min(u32(max(raw, 0.0)), slices - 1u);
	return (sl * tilesY + ty) * tilesX + tx;
}

fn cascadeFor(viewZ: f32) -> u32 {
	var c: u32 = 0u;
	if (viewZ > frame.cascadeSplits.x) { c = 1u; }
	if (viewZ > frame.cascadeSplits.y) { c = 2u; }
	if (viewZ > frame.cascadeSplits.z) { c = 3u; }
	return min(c, max(frame.clusterExtra.y, 1u) - 1u);
}

fn cascadeTexelFor(c: u32) -> f32 {
	if (c == 0u) { return frame.cascadeTexel.x; }
	if (c == 1u) { return frame.cascadeTexel.y; }
	if (c == 2u) { return frame.cascadeTexel.z; }
	return frame.cascadeTexel.w;
}

/**
 * Sun visibility, 0 fully shadowed to 1 fully lit. The receiver is pushed along its
 * normal by ~1.75 shadow texels instead of biasing the depth: a constant depth bias has
 * to be tuned per cascade and still peter-pans, whereas a normal offset scales itself
 * with the cascade's texel footprint, which is exactly the quantity that causes acne.
 */
fn sunVisibility(worldPos: vec3<f32>, n: vec3<f32>, viewZ: f32) -> f32 {
	let c = cascadeFor(viewZ);
	let offsetPos = worldPos + n * (cascadeTexelFor(c) * 1.75);
	let lc = frame.cascadeVP[c] * vec4<f32>(offsetPos, 1.0);
	let ndc = lc.xyz / lc.w;
	// Outside the cascade, or behind the light's near plane: unshadowed rather than
	// black. A hard 0 here is what produces the classic black band past the last cascade.
	if (ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0 || ndc.z <= 0.0 || ndc.z >= 1.0) {
		return 1.0;
	}
	let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
	// One comparison. A wider kernel on every lit retina pixel missed 120 Hz.
	return textureSampleCompareLevel(shadowMap, shadowSampler, uv, c, ndc.z);
}

/**
 * Trilinearly interpolated irradiance from the ambient probe volume.
 *
 * The volume holds SH-L1 of SKY radiance plus the sun's single bounce off the ground,
 * gated by the cascade depth so a probe under a roof loses its bounce. It is NOT
 * ray-traced global illumination: there is no surface-to-surface transport and no
 * occlusion beyond the sun's own depth buffer. Do not describe it as GI.
 */
fn probeIrradiance(worldPos: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
	let dims = frame.probeDims.xyz;
	let spacing = max(frame.probeOrigin.w, 1e-3);
	let maxIdx = vec3<f32>(f32(dims.x) - 1.001, f32(dims.y) - 1.001, f32(dims.z) - 1.001);
	let local = clamp((worldPos - frame.probeOrigin.xyz) / spacing, vec3<f32>(0.0), max(maxIdx, vec3<f32>(0.0)));
	let base = vec3<u32>(local);
	let f = local - vec3<f32>(base);
	// Nearest vertical slice, bilinear in XZ. Eight probes on every lit land pixel
	// missed 120 Hz at retina; the camera is above the ground layer.
	let by = min(base.y + select(0u, 1u, f.y >= 0.5), max(dims.y, 1u) - 1u);
	var sh0 = vec3<f32>(0.0);
	var sh1 = vec3<f32>(0.0);
	var sh2 = vec3<f32>(0.0);
	var sh3 = vec3<f32>(0.0);
	for (var i = 0u; i < 4u; i = i + 1u) {
		let ox = i & 1u;
		let oz = i >> 1u;
		let w = mix(1.0 - f.x, f.x, f32(ox)) * mix(1.0 - f.z, f.z, f32(oz));
		if (w <= 0.0) { continue; }
		let p = min(vec3<u32>(base.x + ox, by, base.z + oz), max(dims, vec3<u32>(1u)) - vec3<u32>(1u));
		let idx = ((p.z * dims.y + p.y) * dims.x + p.x) * 3u;
		let a = probes[idx];
		let b = probes[idx + 1u];
		let c = probes[idx + 2u];
		sh0 = sh0 + a.xyz * w;
		sh1 = sh1 + vec3<f32>(a.w, b.x, b.y) * w;
		sh2 = sh2 + vec3<f32>(b.z, b.w, c.x) * w;
		sh3 = sh3 + vec3<f32>(c.y, c.z, c.w) * w;
	}
	// Ramamoorthi/Hanrahan cosine convolution of an L1 radiance expansion.
	let e = sh0 * 0.886227 + (sh1 * n.y + sh2 * n.z + sh3 * n.x) * 1.023328;
	return max(e, vec3<f32>(0.0));
}

/**
 * Ambient specular probe of the sky. Deliberately the SAME function the dome draws, so a
 * polished surface reflects the sky that is actually above it.
 */
fn skyRadiance(dir: vec3<f32>) -> vec3<f32> {
	return skyGradient(dir);
}
`

/** Cook-Torrance GGX with height-correlated Smith visibility. */
const PBR = /* wgsl */ `
fn distributionGGX(NoH: f32, a: f32) -> f32 {
	let a2 = a * a;
	let d = NoH * NoH * (a2 - 1.0) + 1.0;
	return a2 / max(PI * d * d, 1e-7);
}

/** Height-correlated Smith, already folded with the 1/(4 NoV NoL) denominator. */
fn visibilitySmith(NoV: f32, NoL: f32, a: f32) -> f32 {
	let a2 = a * a;
	let gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
	let gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
	return 0.5 / max(gv + gl, 1e-5);
}

fn fresnelSchlick(f0: vec3<f32>, VoH: f32) -> vec3<f32> {
	let f = pow(1.0 - VoH, 5.0);
	return f0 + (vec3<f32>(1.0) - f0) * f;
}

/** Lazarov's analytic fit to the split-sum environment BRDF. */
fn envBRDF(f0: vec3<f32>, rough: f32, NoV: f32) -> vec3<f32> {
	let c0 = vec4<f32>(-1.0, -0.0275, -0.572, 0.022);
	let c1 = vec4<f32>(1.0, 0.0425, 1.04, -0.04);
	let r = vec4<f32>(rough) * c0 + c1;
	let a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
	let ab = vec2<f32>(-1.04, 1.04) * a004 + r.zw;
	return f0 * ab.x + vec3<f32>(ab.y);
}

/**
 * One energy-conserving punctual light. The diffuse lobe is scaled by (1 - F) so a
 * grazing highlight actually removes the energy it adds instead of inventing it.
 */
fn shadePunctual(
	baseColor: vec3<f32>, metallic: f32, rough: f32,
	n: vec3<f32>, v: vec3<f32>, l: vec3<f32>, radiance: vec3<f32>,
) -> vec3<f32> {
	let NoL = sat(dot(n, l));
	if (NoL <= 0.0) { return vec3<f32>(0.0); }
	let NoV = max(dot(n, v), 1e-4);
	let h = normalize(v + l);
	let NoH = sat(dot(n, h));
	let VoH = sat(dot(v, h));
	let a = max(rough * rough, 2e-3);
	let f0 = mix(vec3<f32>(0.04), baseColor, metallic);
	let f = fresnelSchlick(f0, VoH);
	let spec = f * (distributionGGX(NoH, a) * visibilitySmith(NoV, NoL, a));
	let diffuse = baseColor * (1.0 - metallic) * INV_PI * (vec3<f32>(1.0) - f);
	return (diffuse + spec) * radiance * NoL;
}

/** rg8 octahedral -> unit normal. Two channels because bandwidth, per §12.1. */
fn octDecode(e: vec2<f32>) -> vec3<f32> {
	let f = e * 2.0 - 1.0;
	var n = vec3<f32>(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
	let t = max(-n.z, 0.0);
	n = vec3<f32>(
		n.x + select(t, -t, n.x >= 0.0),
		n.y + select(t, -t, n.y >= 0.0),
		n.z,
	);
	return normalize(n);
}

/** Cofactor matrix — the correct normal transform for any invertible linear part. */
fn cofactor3(m: mat3x3<f32>) -> mat3x3<f32> {
	return mat3x3<f32>(cross(m[1], m[2]), cross(m[2], m[0]), cross(m[0], m[1]));
}
`

// ---------------------------------------------------------------------------
// Depth prepass — shared velocity and compact reflection metadata, group 0 frame,
// group 1 instances. Reflection normals never alter the invariant clip expression.
// ---------------------------------------------------------------------------

export const PREPASS_WGSL =
	FRAME_WGSL +
	PRELUDE +
	/* wgsl */ `
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<storage, read> instances: array<Instance>;
@group(1) @binding(1) var<storage, read> bones: array<mat4x4<f32>>;
@group(1) @binding(2) var<storage, read> previousInstances: array<Instance>;
@group(1) @binding(3) var<storage, read> previousBones: array<mat4x4<f32>>;
@group(0) @binding(8) var reflectionSampler: sampler;
@group(0) @binding(9) var reflectionShroud: texture_2d<f32>;
` +
	SKIN_WGSL + TRACK_DEFORM_WGSL + TRACK_PREVIOUS_WGSL + OCT_DECODE_WGSL +
	REFLECTION_METADATA_WGSL +
	WATER_MOTION_WGSL +
	/* wgsl */ `

struct PrepassOut {
	@invariant @builtin(position) clip: vec4<f32>,
	@location(0) previousClip: vec4<f32>,
	@location(1) currentUnjitteredClip: vec4<f32>,
	@location(2) normal: vec3<f32>,
	@location(3) worldPos: vec3<f32>,
	@location(4) @interpolate(flat, first) surface: vec3<f32>,
}

fn unjitterClip(clip: vec4<f32>) -> vec4<f32> {
	return vec4<f32>(
		clip.x - frame.jitter.x * 2.0 * frame.screen.z * clip.w,
		clip.y - frame.jitter.y * 2.0 * frame.screen.w * clip.w,
		clip.zw,
	);
}

fn skinPositionPrevious(
	position: vec3<f32>,
	joints: vec4<u32>,
	weights: vec4<f32>,
	paletteBase: u32,
) -> vec4<f32> {
	if (paletteBase == 0u) { return vec4<f32>(position, 1.0); }
	let p = vec4<f32>(position, 1.0);
	var acc = previousBones[paletteBase + joints.x] * (p * weights.x);
	acc = acc + previousBones[paletteBase + joints.y] * (p * weights.y);
	acc = acc + previousBones[paletteBase + joints.z] * (p * weights.z);
	acc = acc + previousBones[paletteBase + joints.w] * (p * weights.w);
	return acc;
}

// @invariant is LOAD-BEARING and is the fix for the see-through holes in the ground.
//
// No backticks below: this is inside a TypeScript template literal, per the note on VsOut.
//
// This depth is written here and then tested by the forward pass with greater-equal and no
// depth write. WGSL does NOT guarantee that two shader modules computing the same expression
// produce bit-identical results: the compiler is free to contract viewProj * world into FMAs
// differently in each, and it does, because the surrounding code is wildly different — this
// entry point computes a position and nothing else, while the forward one also builds a
// cofactor matrix, normalises a normal and a tangent, and fills eleven varyings.
//
// When the forward pass's depth landed even one ULP BELOW what this pass wrote, greater-equal
// failed and the fragment was discarded, leaving the cleared target showing through as sky.
// That produced flat sky-coloured polygons scattered over the terrain, hexagonal wherever the
// six triangles around one shared vertex all lost together. They FLICKERED because TAA jitters
// the projection every frame, so a different set of fragments lost each frame.
//
// Measured before the fix at a fixed camera, in the lighting-free albedo AOV: 10 interior
// sky-coloured pixel clusters at noon and 7 at dusk, each matching that time of day's sky
// colour exactly — which is what proved they were the sky seen through a gap rather than
// mis-shaded ground.
//
// @invariant exists precisely for multi-pass depth-equal rendering and must be declared on BOTH
// sides to mean anything. The shadow pass deliberately does NOT get it: its depth is sampled,
// never compared against another pipeline's, so it has nothing to agree with.
@vertex
fn vsMain(@location(0) position: vec4<f32>, @location(1) normalOct: vec2<f32>, @location(5) zone: vec4<u32>, @builtin(instance_index) iid: u32) -> PrepassOut {
	let world = instances[iid].model * vec4<f32>(authoredTrackPosition(position.xyz,zone,instances[iid].misc.z), 1.0);
	let previousWorld = previousInstances[iid].model * vec4<f32>(previousTrackPosition(position.xyz,zone,instances[iid],previousInstances[iid]), 1.0);
	var out: PrepassOut;
	out.clip = frame.viewProj * world;
	out.previousClip = frame.prevViewProj * previousWorld;
	out.currentUnjitteredClip = unjitterClip(out.clip);
	out.normal = reflectionNormal(instances[iid].model, authoredTrack(position.xyz,octDecodeVertex(normalOct),vec4<f32>(1,0,0,1),zone,trackSidePhase(instances[iid].misc.z,position.z)).n);
	out.worldPos = world.xyz;
	out.surface = reflectionSurface(zone, instances[iid].misc.x);
	return out;
}

// The skinned twin. A SECOND ENTRY POINT rather than a second module, and rather than adding
// the attributes to vsMain above.
//
// Terrain has no skin data, so its static path fetches no joints or weights. Normals and
// surface ids supply reflection metadata in both paths. A shared module keeps the @invariant
// contract between the PREPASS and
// the FORWARD pass, and keeping both variants of each in one module means the pair can only
// drift in one place instead of four.
@vertex
fn vsSkinned(
	@location(0) position: vec4<f32>,
	@location(1) normalOct: vec2<f32>,
	@location(5) zone: vec4<u32>,
	@location(6) joints: vec4<u32>,
	@location(7) weights: vec4<f32>,
	@builtin(instance_index) iid: u32,
) -> PrepassOut {
	let inst = instances[iid];
	let previousInst = previousInstances[iid];
	let world = inst.model * skinPosition(authoredTrackPosition(position.xyz,zone,inst.misc.z), joints, weights, u32(inst.misc.y));
	let previousLocal = skinPositionPrevious(previousTrackPosition(position.xyz,zone,inst,previousInst), joints, weights, u32(previousInst.misc.y));
	let previousWorld = previousInst.model * previousLocal;
	var out: PrepassOut;
	out.clip = frame.viewProj * world;
	out.previousClip = frame.prevViewProj * previousWorld;
	out.currentUnjitteredClip = unjitterClip(out.clip);
	out.normal = reflectionNormal(inst.model, skinDirection(authoredTrack(position.xyz,octDecodeVertex(normalOct),vec4<f32>(1,0,0,1),zone,trackSidePhase(inst.misc.z,position.z)).n, joints, weights, u32(inst.misc.y)));
	out.worldPos = world.xyz;
	out.surface = reflectionSurface(zone, inst.misc.x);
	return out;
}

// Velocity is a FRAGMENT output of the depth prepass, never a second geometry pass. Current
// UV comes from the exact raster sample while previous UV comes from the cached transform and
// rig pose, so camera, hull and articulation motion all share one authoritative vector.
struct PrepassFragment {
	@location(0) velocity: vec2<f32>,
	@location(1) reflection: vec4<f32>,
}

@fragment
fn fsVelocity(vin: PrepassOut) -> PrepassFragment {
	var out: PrepassFragment;
	out.velocity = vec2<f32>(0.0);
	if (vin.previousClip.w > 0.0) {
		let currentNdc = vin.currentUnjitteredClip.xy / vin.currentUnjitteredClip.w;
		let currentUv = vec2<f32>(currentNdc.x * 0.5 + 0.5, 0.5 - currentNdc.y * 0.5);
		let previousNdc = vin.previousClip.xy / vin.previousClip.w;
		let previousUv = vec2<f32>(previousNdc.x * 0.5 + 0.5, 0.5 - previousNdc.y * 0.5);
		out.velocity = currentUv - previousUv;
	}
	let shroudUv = (vin.worldPos.xz - frame.shroud.xy) * frame.shroud.zw;
	let inside = all(shroudUv >= vec2<f32>(0.0)) && all(shroudUv <= vec2<f32>(1.0));
	let sight = select(1.0, textureSampleLevel(reflectionShroud, reflectionSampler, shroudUv, 0.0).r, inside);
	var normal = normalize(vin.normal);
	if (vin.surface.z > 0.5) {
		let slope = waterWaveSlope(vin.worldPos.xz);
		normal = normalize(vec3<f32>(-slope.x, 1.0, -slope.y));
	}
	// A visible matte pixel has alpha .25; fogged geometry is exactly zero.
	let code = select(0.0, 0.25 + 0.75 * vin.surface.y, sight >= 0.999);
	out.reflection = vec4<f32>(reflectionOctEncode(normal), vin.surface.x, code);
	return out;
}

// Rain and snow are translucent: they draw late and never write the prepass, so a falling
// drop over still ground would carry the ground's zero velocity and TAA's still-pixel history
// would average it away. Drawn after the opaque prepass with depth test only, this leaves
// the (2,2) "no motion vector" marker under the drop, and TAA takes this frame's pixel there.
// The reflection target is masked off in the pipeline; its value here is never written.
@fragment
fn fsReactive(vin: PrepassOut) -> PrepassFragment {
	var out: PrepassFragment;
	out.velocity = vec2<f32>(2.0, 2.0);
	out.reflection = vec4<f32>(0.0);
	return out;
}
`

/**
 * Terrain's prepass twin. Terrain keeps float32 channels (UVs tile in world metres), so
 * the blended-ground variant undoes the unit-mesh quantized declarations and decodes. The
 * renderer pairs this module with gpumesh's terrainVertexLayout().
 */
export const PREPASS_TERRAIN_WGSL = PREPASS_WGSL
	.replaceAll('@location(1) normalOct: vec2<f32>', '@location(1) normal: vec3<f32>')
	.replaceAll('octDecodeVertex(normalOct)', 'normal')

// ---------------------------------------------------------------------------
// Shadow pass — position only, one cascade per dynamic-offset uniform.
// ---------------------------------------------------------------------------

export const SHADOW_WGSL =
	PRELUDE +
	/* wgsl */ `
struct Cascade { viewProj: mat4x4<f32> }

@group(0) @binding(0) var<uniform> cascade: Cascade;
@group(1) @binding(0) var<storage, read> instances: array<Instance>;
@group(1) @binding(1) var<storage, read> bones: array<mat4x4<f32>>;
` +
	SKIN_WGSL + TRACK_DEFORM_WGSL +
	/* wgsl */ `

@vertex
fn vsMain(@location(0) position: vec4<f32>, @location(5) zone: vec4<u32>, @builtin(instance_index) iid: u32) -> @builtin(position) vec4<f32> {
	let world = instances[iid].model * vec4<f32>(authoredTrackPosition(position.xyz,zone,instances[iid].misc.z), 1.0);
	return cascade.viewProj * world;
}

// The skinned twin. A shadow caster has to deform with the thing casting it, or a walking
// figure's shadow stands still while the figure moves — which reads worse than no shadow.
//
// No @invariant here and that is deliberate: this pass's depth is SAMPLED, never compared
// against another pipeline's, so it has nothing to agree with. The note on the prepass covers
// why that distinction matters.
@vertex
fn vsSkinned(
	@location(0) position: vec4<f32>, @location(5) zone: vec4<u32>,
	@location(6) joints: vec4<u32>,
	@location(7) weights: vec4<f32>,
	@builtin(instance_index) iid: u32,
) -> @builtin(position) vec4<f32> {
	let inst = instances[iid];
	let world = inst.model * skinPosition(authoredTrackPosition(position.xyz,zone,inst.misc.z), joints, weights, u32(inst.misc.y));
	return cascade.viewProj * world;
}
`

// ---------------------------------------------------------------------------
// Forward+ opaque pass.
// ---------------------------------------------------------------------------

/**
 * The §12.3b two-surface blend, as a pair of swappable snippets.
 *
 * Two PIPELINE VARIANTS rather than one data-driven shader, because the alternative is
 * worse in both directions: branching on an interpolated weight puts textureSample in
 * non-uniform control flow, which WGSL forbids outright, and sampling both layers
 * unconditionally would charge every unit and structure in the game a second full material
 * fetch to serve a feature only the ground uses.
 */
/** Packed 12-bit left/right fractions keep the existing 24-float instance record. */
const RUNNING_PHASE_WGSL = /* wgsl */ `
fn runningPhase(packed:f32, localZ:f32)->f32 {
 let bits=u32(max(0.0,packed));
 return f32(select(bits & 4095u, (bits >> 12u) & 4095u, localZ >= 0.0)) / 4096.0;
}
`

/** Alpha-only passes use the same side phase and rigid-running-surface gate. */
export const CUTOUT_UV_WGSL = RUNNING_PHASE_WGSL + /* wgsl */ `
fn cutoutUv(uv:vec2<f32>, layer:u32, iid:u32, localZ:f32, rigid:bool)->vec2<f32> {
 return vec2<f32>(uv.x + select(0.0, runningPhase(instances[iid].misc.z,localZ), layer == ${Zone.running}u && rigid), uv.y);
}
`

function zoneVertex(blend: boolean, skinned: boolean): string {
	if (!blend)
		return /* wgsl */ `
	// The zone index selects the array layer: the texture forge keys its zone table off
	// materialZone, which is what makes player colour a repaint and not a hue shift (§9).
	let layers = max(u32(inst.misc.x), 1u);
	// geo/zone owns the packed byte: low bits select the material layer and bit 7 is an
	// orthogonal emissive SOURCE mask. A source flag must never become a texture layer.
	out.layer = min(vin.zone.x & ${MATERIAL_ZONE_LAYER_MASK}u, layers - 1u);
	out.layerB = out.layer;
	out.layerC = out.layer;
	out.blend = vec2<f32>(0.0);
	out.emissiveSource = select(0.0, 1.0, (vin.zone.x & ${ZoneFlag.emissive}u) != 0u);
	out.roomInfo = select(vec4<u32>(0u),vec4<u32>(vin.zone.y | (vin.zone.z << 8u),vin.zone.w,windowBuildingSeed(inst.model[3].xyz),select(0u,2u,abs(nrm.x)>abs(nrm.z))),(vin.zone.w & 128u) != 0u);
	out.roomLocal = vin.position.xyz;
	if(vin.zone.w==4u){out.roomInfo=vec4<u32>(0u,4u,0u,0u);}
	out.kind = select(select(0u,5u,vin.zone.w==5u),6u,vin.zone.w==6u); // Explicit foam (5) and ground-mark (6) presentation tags; room/track metadata remains actor kind zero.

	// Static track surfaces scroll independently on each side. Road-wheel/tyre vertices
	// already articulated by non-chassis bones must not receive a second UV movement.
	if (out.layer == ${Zone.running}u && ${skinned ? 'all(vin.joints == vec4<u32>(0u))' : 'true'}) {
		out.uv0 = vec2<f32>(out.uv0.x + runningPhase(inst.misc.z,vin.position.z), out.uv0.y);
	}
`
	return /* wgsl */ `
	// §12.3b. zone.x and zone.y are ATLAS layers, already surface * variants + variant, so
	// there is no per-set clamp to apply — the atlas holds every surface at once.
	//
	// Both reach the fragment FLAT, because WGSL cannot interpolate integers. That is
	// correct rather than a compromise only because terrain emits ONE pair per cell across
	// both its triangles; a per-vertex pair would silently blend the wrong two materials at
	// exactly the boundaries this exists to fix. The WEIGHT is a float and does interpolate,
	// and it is what actually produces the transition.
	out.layer = vin.zone.x;
	out.layerB = vin.zone.y;
	out.layerC = vin.zone.z;
	// The blended-ground vertex contract uses all three bytes as atlas layers. Terrain does
	// not carry geo/zone source flags, so it is explicitly ineligible for surface emission.
	out.emissiveSource = 0.0;
	out.roomInfo = vec4<u32>(0u);
	out.roomLocal = vec3<f32>(0.0);
	// From uv1, not from a zone byte. The weights must INTERPOLATE and an integer varying
	// cannot; uv1 was carrying the slope, which no live shader read and which is recoverable
	// from the normal as 1 - n.y anyway.
	out.blend = vin.uv1;
`
}

function zoneFetch(blend: boolean): string {
	if (!blend)
		return /* wgsl */ `
	let albedoSample = textureSample(matAlbedo, matSampler, vin.uv0, vin.layer);
	let orm = textureSample(matOrm, matSampler, vin.uv0, vin.layer);
	let mask = textureSample(matMask, matSampler, vin.uv0, vin.layer).r;
	let normalTS = octDecode(textureSample(matNormal, matSampler, vin.uv0, vin.layer).rg);
`
	return /* wgsl */ `
	// PER-PIXEL ground blend. cellLayers names the atlas layer every cell draws, and a top-face
	// pixel mixes the four cells around it by where it sits between their centres. Two
	// triangles on either side of a cell edge read the same four cells at the same world
	// position, so no edge can seam. The per-cell palette this replaced held three layers
	// with per-vertex weights: wherever rock, snow, a road and a snow variant met, one of them
	// was cut off exactly at a cell edge, and every mountain-to-land boundary read as square
	// plates. Cliff walls, and any face drawn before terrain publishes the map, keep the
	// per-vertex palette (A, B, C) and its weights.
	let variants = max(u32(atlasInfo.header.x), 1u);
	let cellMapOn = frame.edge.w > 0.5 && vin.kind == 0u;
	let cellMax = vec2<i32>(textureDimensions(cellLayers)) - vec2<i32>(1);
	let cellBase = vin.worldPos.xz - frame.edge.yz - vec2<f32>(0.5);
	// Bend boundaries with the world-space warp so a straight run of cells does not read as
	// a ruler line. Its reach comes from the BILINEAR warp strength of the unwarped four
	// cells: bilinear in per-cell values is continuous across the line where the four-cell
	// set changes, so the reach cannot step. 2s-1 puts the zero ON the edge of a road or
	// concrete cell (s = 0.5 there), so those keep straight edges and only lose their stairs.
	let cellP0 = floor(cellBase);
	let cellF0 = cellBase - cellP0;
	let cellI0 = vec2<i32>(cellP0);
	let reach00 = terrainBlendWarpStrength(textureLoad(cellLayers, clamp(cellI0, vec2<i32>(0), cellMax), 0).r / variants);
	let reach10 = terrainBlendWarpStrength(textureLoad(cellLayers, clamp(cellI0 + vec2<i32>(1, 0), vec2<i32>(0), cellMax), 0).r / variants);
	let reach01 = terrainBlendWarpStrength(textureLoad(cellLayers, clamp(cellI0 + vec2<i32>(0, 1), vec2<i32>(0), cellMax), 0).r / variants);
	let reach11 = terrainBlendWarpStrength(textureLoad(cellLayers, clamp(cellI0 + vec2<i32>(1, 1), vec2<i32>(0), cellMax), 0).r / variants);
	let warpReach = 0.45 * clamp(2.0 * mix(mix(reach00, reach10, cellF0.x), mix(reach01, reach11, cellF0.x), cellF0.y) - 1.0, 0.0, 1.0);
	let cellQ = cellBase + terrainBlendWarp(vin.worldPos.xz) * warpReach;
	let cellPq = floor(cellQ);
	let cellF = cellQ - cellPq;
	let cellIq = vec2<i32>(cellPq);
	let l0 = select(vin.layer, textureLoad(cellLayers, clamp(cellIq, vec2<i32>(0), cellMax), 0).r, cellMapOn);
	let l1 = select(vin.layerB, textureLoad(cellLayers, clamp(cellIq + vec2<i32>(1, 0), vec2<i32>(0), cellMax), 0).r, cellMapOn);
	let l2 = select(vin.layerC, textureLoad(cellLayers, clamp(cellIq + vec2<i32>(0, 1), vec2<i32>(0), cellMax), 0).r, cellMapOn);
	let l3 = select(vin.layer, textureLoad(cellLayers, clamp(cellIq + vec2<i32>(1, 1), vec2<i32>(0), cellMax), 0).r, cellMapOn);
	// Without the map the per-vertex palette applies: A takes what B and C leave.
	let vertexB = clamp(vin.blend.x, 0.0, 1.0);
	let vertexC = clamp(vin.blend.y, 0.0, 1.0);
	var w0 = select(max(1.0 - vertexB - vertexC, 0.0), (1.0 - cellF.x) * (1.0 - cellF.y), cellMapOn);
	var w1 = select(vertexB, cellF.x * (1.0 - cellF.y), cellMapOn);
	var w2 = select(vertexC, (1.0 - cellF.x) * cellF.y, cellMapOn);
	var w3 = select(0.0, cellF.x * cellF.y, cellMapOn);
	// Merge repeated layers first, so a material never competes with itself in the height
	// interlock below: three snow cells and one rock cell are one snow weight against rock.
	if (l1 == l0) { w0 += w1; w1 = 0.0; }
	if (l2 == l0) { w0 += w2; w2 = 0.0; } else if (l2 == l1) { w1 += w2; w2 = 0.0; }
	if (l3 == l0) { w0 += w3; w3 = 0.0; } else if (l3 == l1) { w1 += w3; w3 = 0.0; } else if (l3 == l2) { w2 += w3; w3 = 0.0; }

	// Explicit gradients, taken here in uniform control flow, so each layer below can be
	// sampled only when it carries weight. Inside a single surface most pixels merge to one
	// or two layers, which is what pays for reading four cells instead of three slots.
	// terrainDetailUv is a pure rotation, so it rotates the gradients the same way.
	let gradX = dpdx(vin.uv0);
	let gradY = dpdy(vin.uv0);
	let detailOn = frame.debug.y == 0u;
	let scaleL0 = atlasScale(l0);
	let scaleL1 = atlasScale(l1);
	let scaleL2 = atlasScale(l2);
	let scaleL3 = atlasScale(l3);
	// Debug views want the raw, un-rotated detail UVs; the bypass lives at the call
	// site so terrain-macro.ts stays a pure module the GPU gate compiles standalone.
	let uvL0 = select(vin.uv0 * scaleL0, terrainDetailUv(vin.uv0 * scaleL0), detailOn);
	let uvL1 = select(vin.uv0 * scaleL1, terrainDetailUv(vin.uv0 * scaleL1), detailOn);
	let uvL2 = select(vin.uv0 * scaleL2, terrainDetailUv(vin.uv0 * scaleL2), detailOn);
	let uvL3 = select(vin.uv0 * scaleL3, terrainDetailUv(vin.uv0 * scaleL3), detailOn);
	let gxL0 = select(gradX * scaleL0, terrainDetailUv(gradX * scaleL0), detailOn);
	let gyL0 = select(gradY * scaleL0, terrainDetailUv(gradY * scaleL0), detailOn);
	let gxL1 = select(gradX * scaleL1, terrainDetailUv(gradX * scaleL1), detailOn);
	let gyL1 = select(gradY * scaleL1, terrainDetailUv(gradY * scaleL1), detailOn);
	let gxL2 = select(gradX * scaleL2, terrainDetailUv(gradX * scaleL2), detailOn);
	let gyL2 = select(gradY * scaleL2, terrainDetailUv(gradY * scaleL2), detailOn);
	let gxL3 = select(gradX * scaleL3, terrainDetailUv(gradX * scaleL3), detailOn);
	let gyL3 = select(gradY * scaleL3, terrainDetailUv(gradY * scaleL3), detailOn);
	var albedo0 = vec4<f32>(0.0);
	var normal0 = vec2<f32>(0.5);
	var orm0 = vec4<f32>(0.0);
	var albedo1 = vec4<f32>(0.0);
	var normal1 = vec2<f32>(0.5);
	var orm1 = vec4<f32>(0.0);
	var albedo2 = vec4<f32>(0.0);
	var normal2 = vec2<f32>(0.5);
	var orm2 = vec4<f32>(0.0);
	var albedo3 = vec4<f32>(0.0);
	var normal3 = vec2<f32>(0.5);
	var orm3 = vec4<f32>(0.0);
	if (w0 > 0.0) {
		albedo0 = textureSampleGrad(matAlbedo, matSampler, uvL0, l0, gxL0, gyL0);
		normal0 = textureSampleGrad(matNormal, matSampler, uvL0, l0, gxL0, gyL0).rg;
		orm0 = textureSampleGrad(matOrm, matSampler, uvL0, l0, gxL0, gyL0);
	}
	if (w1 > 0.0) {
		albedo1 = textureSampleGrad(matAlbedo, matSampler, uvL1, l1, gxL1, gyL1);
		normal1 = textureSampleGrad(matNormal, matSampler, uvL1, l1, gxL1, gyL1).rg;
		orm1 = textureSampleGrad(matOrm, matSampler, uvL1, l1, gxL1, gyL1);
	}
	if (w2 > 0.0) {
		albedo2 = textureSampleGrad(matAlbedo, matSampler, uvL2, l2, gxL2, gyL2);
		normal2 = textureSampleGrad(matNormal, matSampler, uvL2, l2, gxL2, gyL2).rg;
		orm2 = textureSampleGrad(matOrm, matSampler, uvL2, l2, gxL2, gyL2);
	}
	if (w3 > 0.0) {
		albedo3 = textureSampleGrad(matAlbedo, matSampler, uvL3, l3, gxL3, gyL3);
		normal3 = textureSampleGrad(matNormal, matSampler, uvL3, l3, gxL3, gyL3).rg;
		orm3 = textureSampleGrad(matOrm, matSampler, uvL3, l3, gxL3, gyL3);
	}

	// HEIGHT blend, not a linear mix. ORM.a is each material's height, so whichever stands
	// proud at a texel wins there and they interlock in fingers, the way gravel actually
	// comes up through turf. A linear crossfade averages them into a band of mud that looks
	// like neither material. The gain gives the comparison something to bite on: ORM.a
	// arrives dimensionless (materials/wgsl-pack.ts) and the forged layers fill its range.
	let h0 = clamp((orm0.a - 0.5) * 6.0 + 0.5, 0.0, 1.0);
	let h1 = clamp((orm1.a - 0.5) * 6.0 + 0.5, 0.0, 1.0);
	let h2 = clamp((orm2.a - 0.5) * 6.0 + 0.5, 0.0, 1.0);
	let h3 = clamp((orm3.a - 0.5) * 6.0 + 0.5, 0.0, 1.0);
	let ra0 = w0 * (h0 + 0.16);
	let ra1 = w1 * (h1 + 0.16);
	let ra2 = w2 * (h2 + 0.16);
	let ra3 = w3 * (h3 + 0.16);
	let peak = max(max(ra0, ra1), max(ra2, ra3)) - 0.16;
	let k0 = max(ra0 - peak, 0.0) * select(0.0, 1.0, w0 > 0.0);
	let k1 = max(ra1 - peak, 0.0) * select(0.0, 1.0, w1 > 0.0);
	let k2 = max(ra2 - peak, 0.0) * select(0.0, 1.0, w2 > 0.0);
	let k3 = max(ra3 - peak, 0.0) * select(0.0, 1.0, w3 > 0.0);
	let invK = 1.0 / max(k0 + k1 + k2 + k3, 1e-5);
	let b0 = k0 * invK;
	let b1 = k1 * invK;
	let b2 = k2 * invK;
	let b3 = k3 * invK;
	let blendedAlbedo = albedo0 * b0 + albedo1 * b1 + albedo2 * b2 + albedo3 * b3;
	let macroStrength = terrainMacroStrength(l0 / variants) * b0 + terrainMacroStrength(l1 / variants) * b1 +
		terrainMacroStrength(l2 / variants) * b2 + terrainMacroStrength(l3 / variants) * b3;
	var macroRgb = blendedAlbedo.rgb;
	if (frame.debug.y == 0u) { macroRgb = terrainMacroAlbedo(blendedAlbedo.rgb, vin.worldPos.xz, macroStrength); }
	let albedoSample = vec4<f32>(macroRgb, blendedAlbedo.a);
	let orm = orm0 * b0 + orm1 * b1 + orm2 * b2 + orm3 * b3;
	// Terrain carries no player colour (tint.a is 0), so the paint mask is never read here.
	let mask = 0.0;

	// DECODE each normal, THEN blend the vectors. Octahedral encoding is piecewise linear
	// with a FOLD, so the average of two encodings is not the encoding of the average; a
	// pair straddling the fold decodes to a direction unrelated to either input, and on the
	// build that blended encodings nDotL collapsed to black at material boundaries.
	let normalTS = normalize(octDecode(normal0) * b0 + octDecode(normal1) * b1 + octDecode(normal2) * b2 + octDecode(normal3) * b3);
`
}

// zone.w=5 is authored only by geo/foam-coverage. No alpha/emission/material meaning
// changes for ordinary surfaces; this helper is compiled only into the late ghost path.
/** Set on the forward `kind` varying by vsSkinned. Weather snow skips skinned actors. */
const SKINNED_KIND_BIT = 256

const FOAM_COVERAGE_WGSL = /* wgsl */ `
fn foamNoise(p:vec2<f32>)->f32 {
 let cell=floor(p);let f=fract(p);let u=f*f*(3.0-2.0*f);
 let a=fract(sin(dot(cell,vec2<f32>(127.1,311.7)))*43758.5453);
 let b=fract(sin(dot(cell+vec2<f32>(1.0,0.0),vec2<f32>(127.1,311.7)))*43758.5453);
 let c=fract(sin(dot(cell+vec2<f32>(0.0,1.0),vec2<f32>(127.1,311.7)))*43758.5453);
 let d=fract(sin(dot(cell+vec2<f32>(1.0),vec2<f32>(127.1,311.7)))*43758.5453);
 return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);
}
fn foamCoverage(uv:vec2<f32>,world:vec2<f32>)->f32 {
 let edge=smoothstep(0.0,0.27,min(uv.y,1.0-uv.y));
 let ends=smoothstep(0.0,0.12,uv.x)*(1.0-smoothstep(0.88,1.0,uv.x));
 let breakup=smoothstep(0.16,0.72,foamNoise(world*63.0));
 return edge*ends*breakup*(0.62+0.38*foamNoise(world*19.0));
}
fn markCoverage(uv:vec2<f32>,world:vec2<f32>)->f32 {
 // A ground mark's uv is its local unit square: x along travel, y across, both -0.5..0.5.
 // Short end fades let consecutive stamps chain into one rut. Wider, noise-broken side
 // fades stop each stamp reading as a square plate, which is what snow made obvious.
 let wobble=(foamNoise(world*2.3)-0.5)*0.12;
 let ends=smoothstep(0.0,0.07,0.5-abs(uv.x)+wobble*0.5);
 let sides=smoothstep(0.0,0.16,0.5-abs(uv.y)+wobble);
 return ends*sides;
}
`

function buildForward(blend: boolean, translucent = false, unquantized = false): string {
	const useBloom = BLOOM_ENABLED && !translucent
	const bloomDecl = useBloom ? 'var bloomKey = 0.0;' : ''
	const bloomWrite = useBloom
		? 'bloomKey = select(luma(emission), -luma(emission), emitterIsCool(albedoSample.a, vin.tint));'
		: ''
	const bloomFog = useBloom
		? `bloomKey = bloomKey * exp(-frame.horizonColor.a * fogDist);
	if (frame.debug.x == 17u) { bloomKey = luma(color); }`
		: ''
	const shroudBloom = useBloom ? 'bloomKey = bloomKey * shroudValue;' : ''
	const debugCondition = useBloom ? 'dbg != 0u && dbg != 16u && dbg != 17u' : 'dbg != 0u'
	const debugAlpha = useBloom ? '0.0' : translucent ? 'vin.opacity' : '1.0'
	const forwardReturn = translucent
		? 'var coverage=1.0; if(vin.kind==5u){coverage=foamCoverage(vin.uv0,vin.worldPos.xz);} if(vin.kind==6u){coverage=markCoverage(vin.uv0,vin.worldPos.xz);} let opacity = sat(vin.opacity) * coverage; return vec4<f32>(color * opacity, opacity);'
		: useBloom ? 'return vec4<f32>(color, bloomKey);' : 'return vec4<f32>(color, 1.0);'
	const base = (
		FRAME_WGSL +
        (translucent ? FOAM_COVERAGE_WGSL : '') +
		PRELUDE + INSTANCE_APPEARANCE_WGSL + SURFACE_EMISSION_WGSL + OCT_DECODE_WGSL +
		// The world-edge haze and veil: declared ahead of FRAME_BINDINGS per its own header,
		// consumed by FORWARD_BODY's fsMain. d4bca90 shipped the block and the call sites but
		// never this include, so every forward module failed to compile and the whole world
		// pass drew black.
		EDGE_FOG_WGSL +
		CLOUD_FIELD_WGSL + WINDOW_OCCUPANCY_WGSL +
		FRAME_BINDINGS + `
fn cloudShadowAt(worldXZ: vec2<f32>, altitude: f32) -> f32 {
	// debug.y = 1 is Classic: the 2026-09-06 High look had no ground cloud shadows.
	if (frame.debug.y != 0u) { return 1.0; }
	let cov = frame.cloud.x;
	if (cov <= 0.001) { return 1.0; }
	let p = (worldXZ + frame.sunDirection.xz * (altitude * 24.0) + frame.cloudDrift.xy) * frame.cloud.z;
	let field = cloudField(p, frame.skySeed.x);
	let amount = sat((field - (1.0 - cov)) / max(cov * 0.6, 1e-3));
	return 1.0 - amount * frame.cloud.y * 0.75;
}
` +
		MATERIAL_BINDINGS + RUNNING_PHASE_WGSL + TRACK_DEFORM_WGSL +
		(blend ? TERRAIN_MACRO_WGSL + `
struct AtlasScaleInfo { header: vec4<f32>, scales: array<vec4<f32>,13> }
@group(1) @binding(5) var<uniform> atlasInfo: AtlasScaleInfo;
// Atlas layer per terrain cell, origin in frame.edge.yz, live when frame.edge.w is 1.
@group(0) @binding(10) var cellLayers: texture_2d<u32>;
fn atlasScale(layer: u32) -> f32 {
 let surface = min(layer / max(u32(atlasInfo.header.x),1u),12u);
 return atlasInfo.scales[surface].x;
}
` : '') +
		SKY_GRADIENT +
		SCENE_LOOKUPS +
		PBR +
		FORWARD_BODY
			// Static and skinned entry points share phase decoding; only the latter excludes
			// vertices already moved by an articulated wheel bone.
			.replace('//__ZONE_VERTEX__', zoneVertex(blend, false))
			.replace('//__ZONE_VERTEX__', zoneVertex(blend, true))
			.replace('//__ZONE_FETCH__', zoneFetch(blend))
			.replace('//__BLOOM_DECL__', bloomDecl)
			.replace('//__BLOOM_WRITE__', bloomWrite)
			.replace('//__BLOOM_FOG__', bloomFog)
			.replace('//__SHROUD_BLOOM__', shroudBloom)
			.replace('//__DEBUG_CONDITION__', debugCondition)
			.replace('//__DEBUG_ALPHA__', debugAlpha)
			.replace('//__FORWARD_RETURN__', forwardReturn)
	)
	const unquantize = (code: string): string => code
		// Terrain keeps float32 channels (its UVs tile in world metres), so the blended
		// ground variant undoes the unit-mesh quantized declarations and decodes.
		.replaceAll('@location(1) normalOct: vec2<f32>', '@location(1) normal   : vec3<f32>')
		.replaceAll('let nrm = octDecodeVertex(vin.normalOct);', 'let nrm = vin.normal;')
		.replaceAll('let tan4 = vec4<f32>(octDecodeVertex(vin.tangent.xy), vin.tangent.w);', 'let tan4 = vin.tangent;')
	return blend || unquantized ? unquantize(base) : base
}

const FORWARD_BODY = /* wgsl */ `
@group(2) @binding(0) var<storage, read> instances: array<Instance>;
@group(2) @binding(1) var<storage, read> bones: array<mat4x4<f32>>;
` +
	SKIN_WGSL +
	WATER_MOTION_WGSL +
	/* wgsl */ `

struct VsIn {
	@location(0) position : vec4<f32>,
	@location(1) normalOct: vec2<f32>,
	@location(2) tangent  : vec4<f32>,
	@location(3) uv0      : vec2<f32>,
	@location(4) uv1      : vec2<f32>,
	@location(5) zone     : vec4<u32>,
}

struct VsOut {
	// The other half of the depth-prepass agreement. See the long note on PREPASS_WGSL's vsMain:
	// this pass tests greater-equal against the depth that one wrote, so both must be declared
	// @invariant or the compiler may compute the same expression differently in each and drop
	// fragments that should have passed. One declaration here covers FORWARD_WGSL and
	// FORWARD_BLEND_WGSL, since buildForward() generates both from this one struct.
	@invariant @builtin(position) clip : vec4<f32>,
	@location(0) worldPos   : vec3<f32>,
	@location(1) normal     : vec3<f32>,
	@location(2) tangent    : vec4<f32>,
	@location(3) uv0        : vec2<f32>,
	@location(4) uv1        : vec2<f32>,
	@location(5) @interpolate(flat, first) layer : u32,
	@location(6) tint       : vec4<f32>,
	// §12.3b. Flat, because integer varyings cannot be anything else — but flat ALONE is not
	// enough. Bare @interpolate(flat) means @interpolate(flat, either) in WGSL, which permits
	// the implementation to take the value from ANY vertex of the primitive. That is
	// spec-sanctioned nondeterminism, and §12.3b's cell-constant invariant is what normally
	// hides it: when all three vertices of a triangle carry the same pair, the choice cannot
	// be observed. It stops being unobservable at the 3- and 4-way junctions §12.3b admits as
	// a known limitation — exactly where a varying selection would surface. first pins it.
	//
	// No backticks in this comment: the WGSL below is a TypeScript template literal, so a
	// backtick terminates it. Writing prose here in markdown habits breaks the host language.
	@location(7) @interpolate(flat, first) layerB : u32,
	@location(8) @interpolate(flat, first) layerC : u32,
	// The parts that DO interpolate, and the only reason blending works. x is the weight of
	// layerB (a surface transition), y of layerC (a variant transition); layer's own weight
	// is whatever remains.
	@location(9) blend      : vec2<f32>,
	// Terrain face kind. Flat because a primitive is wholly top, cliff or water; cliffs use
	// it to fade normal-map detail at a collapsed tip without affecting ordinary ground.
	@location(10) @interpolate(flat, first) kind : u32,
	// Battle damage, 0..1. A VARYING because the instances buffer is bound to the vertex stage
	// only — reading inst.misc.w in the fragment compiled to nothing, the pipeline failed to
	// build, and encoder.finish() discarded the whole frame as a black canvas. Flat because
	// damage is per-actor and interpolating it across a triangle would band the hull.
	@location(11) @interpolate(flat, first) damage : f32,
	// Source eligibility is flat because it is packed with the flat material-zone id. This is
	// exact for the uniformly flagged FX mesh; geo/zone documents the partial-mesh boundary.
	@location(12) @interpolate(flat, first) emissiveSource : f32,
	// Negative misc.w retains both damage and whole-item alpha in disjoint numeric bands.
	@location(13) @interpolate(flat, first) opacity : f32,
	@location(14) @interpolate(flat, first) roomInfo : vec4<u32>,
	@location(15) roomLocal : vec3<f32>,
}

@vertex
fn vsMain(vin: VsIn, @builtin(instance_index) iid: u32) -> VsOut {
	let inst = instances[iid];
	let nrm = octDecodeVertex(vin.normalOct);
	let tan4 = vec4<f32>(octDecodeVertex(vin.tangent.xy), vin.tangent.w);
	let tracked = authoredTrack(vin.position.xyz,nrm,tan4,vin.zone,trackSidePhase(inst.misc.z,vin.position.z));
	let world4 = inst.model * vec4<f32>(tracked.p, 1.0);
	let linear = mat3x3<f32>(inst.model[0].xyz, inst.model[1].xyz, inst.model[2].xyz);
	let nm = cofactor3(linear);

	var out: VsOut;
	out.clip = frame.viewProj * world4;
	out.worldPos = world4.xyz;
	out.normal = normalize(nm * tracked.n);
	out.tangent = vec4<f32>(normalize(linear * tracked.t.xyz), tracked.t.w);
	out.uv0 = vin.uv0;
	out.uv1 = vin.uv1;
	out.kind = vin.zone.w;
//__ZONE_VERTEX__
	out.damage = instanceDamage(inst.misc.w);
	out.opacity = instanceOpacity(inst.misc.w);
	out.tint = inst.tint;
	return out;
}

// The skinned twin of vsMain. Everything below the first two lines is IDENTICAL to it — the
// only difference is that position and normal are deformed first.
//
// The @invariant on VsOut.clip covers both entry points, and PREPASS_WGSL's vsSkinned builds
// its clip position from the same skinPosition() in the same shared block, so the depth this
// pass tests is the depth that pass wrote. That agreement is the reason skinPosition exists
// as one function instead of two inlined expressions.
struct VsInSkinned {
	@location(0) position : vec4<f32>,
	@location(1) normalOct: vec2<f32>,
	@location(2) tangent  : vec4<f32>,
	@location(3) uv0      : vec2<f32>,
	@location(4) uv1      : vec2<f32>,
	@location(5) zone     : vec4<u32>,
	@location(6) joints   : vec4<u32>,
	@location(7) weights  : vec4<f32>,
}

@vertex
fn vsSkinned(vin: VsInSkinned, @builtin(instance_index) iid: u32) -> VsOut {
	let inst = instances[iid];
	let base = u32(inst.misc.y);
	let nrm = octDecodeVertex(vin.normalOct);
	let tan4 = vec4<f32>(octDecodeVertex(vin.tangent.xy), vin.tangent.w);
	let tracked = authoredTrack(vin.position.xyz,nrm,tan4,vin.zone,trackSidePhase(inst.misc.z,vin.position.z));
	let world4 = inst.model * skinPosition(tracked.p, vin.joints, vin.weights, base);
	let skinN = skinDirection(tracked.n, vin.joints, vin.weights, base);
	let skinT = skinDirection(tracked.t.xyz, vin.joints, vin.weights, base);
	let linear = mat3x3<f32>(inst.model[0].xyz, inst.model[1].xyz, inst.model[2].xyz);
	let nm = cofactor3(linear);

	var out: VsOut;
	out.clip = frame.viewProj * world4;
	out.worldPos = world4.xyz;
	out.normal = normalize(nm * skinN);
	out.tangent = vec4<f32>(normalize(linear * skinT), tan4.w);
	out.uv0 = vin.uv0;
	out.uv1 = vin.uv1;
	out.kind = vin.zone.w;
//__ZONE_VERTEX__
	// Tag skinned actors with a high bit on kind: every inter-stage location is already in
	// use, and no fragment test compares an actor's kind against 0.
	out.kind = out.kind | ${SKINNED_KIND_BIT}u;
	out.damage = instanceDamage(inst.misc.w);
	out.opacity = instanceOpacity(inst.misc.w);
	out.tint = inst.tint;
	return out;
}

@fragment
fn fsMain(vin: VsOut) -> @location(0) vec4<f32> {
//__ZONE_FETCH__

	// Player colour repaints the masked panels while keeping the surface's own shading
	// detail — a straight hue rotate would flatten every rivet on the panel.
	//
	// The mask itself is CORRECT and was wrongly suspected. Measured off the baked r8
	// texture: foundry 39.0% of texels above 0.78 against a nominal 38%, lattice 25.0%
	// against 26%, metal 19.7% against 20%, drift 0%. Bimodal, exactly as authored. The
	// units read as painted plastic for a different reason, one pass further down.
	//
	// The paint term used to be tint * luma(albedo), and the mix drove masked texels ALL THE
	// WAY to it. So a painted panel kept the surface's brightness and threw away all the rest —
	// no oxide, no dust, no tint jitter, no chroma of its own. Flat colour modulated by a
	// greyscale ramp is a decal, not paint on metal, and 39% of a hull covered in it is what
	// made the roster look like a toy.
	//
	// Two changes, both about keeping the MATERIAL under the paint:
	//   - a fraction of the surface's own colour survives the repaint, so a painted plate
	//     still carries its wear and its per-plate jitter;
	//   - the mix ceiling stops short of 1, so even the most strongly masked texel is paint
	//     OVER something rather than paint INSTEAD of it.
	//
	// §9.1 is unchanged and still satisfied: this is a real repaint of specific panels, not a
	// hue shift over the whole unit. It is a repaint that admits what it is painted on.
	let paintPure = vin.tint.rgb * (0.22 + 0.78 * luma(albedoSample.rgb));
	let paint = mix(paintPure, albedoSample.rgb, 0.08);
	var baseColor = mix(albedoSample.rgb, paint, sat(mask * vin.tint.a) * 0.96);
	// Original per-actor UV1 bake. Neutral 1px texture leaves all old actors/terrain
	// unchanged; alpha is wear, not opacity. Never feeds visibility or lighting sources.
	let detailHalfTexel = vec2<f32>(0.5) / vec2<f32>(textureDimensions(matDetail));
	let detail = textureSample(matDetail, matSampler, clamp(vin.uv1, detailHalfTexel, vec2<f32>(1.0) - detailHalfTexel));
	baseColor = mix(baseColor, max(baseColor * vec3<f32>(0.66, 0.60, 0.48), vec3<f32>(0.02)), detail.b * 0.55);
 // The authored far belt substitutes a repeating steel cleat response for subpixel geometry.
 let trackAA=max(fwidth(vin.uv0.x),.015);
 if(vin.roomInfo.y==4u){
  let cleat=1.0-smoothstep(.19-trackAA,.19+trackAA,abs(fract(vin.uv0.x+.5)-.5));
  baseColor=mix(baseColor*.65,vec3<f32>(.19,.20,.18),cleat);
 }

	baseColor = mix(baseColor, min(baseColor * 1.30 + vec3<f32>(0.025), vec3<f32>(0.90)), detail.a * 0.30);

	// Battle damage. §12.2 instance float 23, 0 pristine and 1 about to die.
	//
	// The health byte has been decoded into every snapshot since the bridge landed and read by
	// nobody, so a machine at 5% HP has always looked exactly like one straight out of the
	// factory. This is the cheapest possible correction to that: no geometry, no second draw,
	// one lerp in the fragment stage.
	//
	// Soot rather than red. §9.0 prohibits science fiction and prohibits a damage tint that
	// reads as a health bar painted onto the hull — what a burning machine actually does is go
	// DARK and go MATTE, because paint chars and the gloss goes first. So this drives value and
	// roughness, not hue, which also keeps it legible in §9.1's monochrome silhouette test.
	//
	// It deliberately does NOT touch the player-colour mask: a damaged tank must still read as
	// yours. The blend runs after the repaint and darkens the result, so the colour survives at
	// lower value instead of being replaced.
	let damage = vin.damage;
	if (damage > 0.0) {
		// §7 floors albedo at 0.02 — below that a surface reads as a hole rather than as
		// charred metal, which this project has already been caught by once.
		let charred = max(baseColor * 0.34, vec3<f32>(0.02));
		baseColor = mix(baseColor, charred, damage * 0.80);
	}

	// Damage takes the gloss off before it takes the colour. Charred paint is matte, and a
	// wreck that stays shiny reads as a clean model with a dark texture rather than as a
	// burnt one — value alone is not enough, which is why this drives roughness too.
	// Surface state is shared across quality tiers; particle density never controls
	// whether the ground is snowy. Baked AO approximates shelter on authored assets.
	// A dedicated precipitation occlusion map can refine this approximation later.
	let exposure = smoothstep(0.12, 0.65, detail.r);
	let facingUp = smoothstep(0.25, 0.78, normalize(vin.normal).y);
	let snowGrain = edgeNoise(vin.worldPos.xz * 5.3);
	let snowCover = sat((frame.surfaceWeather.y - snowGrain * 0.24) / 0.55);
	// Skinned actors never hold snow. A walking soldier's sky-facing trouser tops took the
	// weather cover, and on snowy ground that read as holes through his legs.
	let snow = snowCover * facingUp * exposure * select(1.0, 0.0, vin.kind == 2u) *
		select(1.0, 0.0, (vin.kind & ${SKINNED_KIND_BIT}u) != 0u);
	// Rain fills pores; snow is a rough dielectric cover even over metallic paint.
	let wet = frame.surfaceWeather.x * smoothstep(0.05, 0.9, vin.normal.y) * exposure * (1.0 - snow);
	baseColor = baseColor * (1.0 - wet * .22);
	baseColor = mix(baseColor, vec3<f32>(0.72, 0.77, 0.82) * (0.94 + snowGrain * 0.06), snow);
	let rough = clamp(mix(mix(mix(orm.r, 0.94, vin.damage * 0.7), .22, wet * .68), 0.88 + snowGrain * 0.06, snow), 0.03, 1.0);
	let metallic = sat(orm.g) * (1.0 - snow);
	// AO ATTENUATES, it does not clamp. This read
	// clamp(detail.r * (1.0 - detail.g * 0.35), 0.30, 1.0), and the floor was doing far more
	// than guarding against black: measured across all 231 baked masks, 40.3% of every AO texel
	// in the game sits below 0.30 and was flattened to it — 80% on 2tnk and 4tnk. Four fifths of
	// a tank's baked occlusion was discarded, which is why hulls read as flat colour with a
	// shadow rather than as machines with recesses. The floor was written when two actors had
	// masks and their range happened to sit above it; the roster-wide bake made it the dominant
	// term.
	//
	// Mixing towards white instead keeps the whole distribution and still bounds how dark a
	// recess can get: strength 0.70 means a fully occluded texel lands at 0.30, exactly the old
	// floor, while every value above it now varies instead of collapsing. Cavity stays a modest
	// extra bite, and stays honest about being near-dead on flat hard-surface geometry, where
	// Cycles' Pointiness sits at about 0.5 and the channel bakes to a constant.
	const AO_STRENGTH: f32 = 0.70;
	let occlusion = detail.r * (1.0 - detail.g * 0.35);
	let ao = orm.b * mix(1.0, occlusion, AO_STRENGTH);

	let geoN = normalize(vin.normal);
	let t = normalize(vin.tangent.xyz - geoN * dot(geoN, vin.tangent.xyz));
	let b = cross(geoN, t) * vin.tangent.w;
	let tbn = mat3x3<f32>(t, b, geoN);
	// A cliff tapering to zero is sub-pixel at its collapsed end. Its geometric normal
	// already rotates toward up there, but an unattenuated tangent-space normal map can
	// rotate the SHADING normal back below the sun: measured depth and shadow visibility
	// stayed continuous while nDotL alternated between lit ground and exact zero. Terrain
	// carries the per-end taper in uv1.x; suppress detail only at cliff tips so a full wall
	// retains its rock relief and ordinary terrain keeps its material blend weights.
	let cliffNormalFade = select(0.0, sat(vin.uv1.x), vin.kind == 1u);
	let surfaceNormalTS = normalize(mix(normalTS, vec3<f32>(0.0, 0.0, 1.0), max(cliffNormalFade, snow * 0.65)));
	var n = normalize(tbn * surfaceNormalTS);
	if (vin.kind == 2u) {
		let seconds = frame.surfaceWeather.z;
		let drift = frame.weather.xy * seconds * (.018 + frame.weather.z * .030);
		let fineA = octDecode(textureSampleLevel(matNormal, matSampler, vin.uv0 + drift, vin.layer, 0.0).rg);
		let fineB = octDecode(textureSampleLevel(matNormal, matSampler, vin.uv0 * 1.73 - drift * .71, vin.layer, 0.0).rg);
		let p = vin.worldPos.xz;
		var slope = waterWaveSlope(p);
		// Expanding rings are seeded per world-space raindrop cell, not per screen pixel.
		let cell = floor(p * 2.4);
		let seed = fract(sin(dot(cell, vec2<f32>(127.1, 311.7))) * 43758.5453);
		let q = fract(p * 2.4) - vec2<f32>(.5);
		let age = fract(seconds * .83 + seed);
		let radius = length(q);
		let ring = sin((radius - age * .65) * 55.0) * exp(-abs(radius - age * .65) * 28.0) * (1.0 - age);
		slope += q / max(radius, .03) * ring * frame.weather.w * .08;
		slope += (fineA.xy + fineB.xy) * .55;
		n = normalize(vec3<f32>(-slope.x, 1.0, -slope.y));
	}

	let v = normalize(frame.cameraPos.xyz - vin.worldPos);
	let viewZ = -(frame.view * vec4<f32>(vin.worldPos, 1.0)).z;

	var color = vec3<f32>(0.0);
//__BLOOM_DECL__

	// --- sun, cascaded shadow ---
	let sunL = frame.sunDirection.xyz;
	// Cloud shadows ride the same visibility channel: the cloud field sampled at the
	// fragment's world position (leaning with the sun by altitude) dims the SUN only -
	// sky and punctual lights keep their share, the way real overcast patches work.
	let vis = sunVisibility(vin.worldPos, geoN, viewZ) * cloudShadowAt(vin.worldPos.xz, max(vin.worldPos.y, 0.0));

	// --- clustered punctual lights ---
	let ci = clusterIndexFor(vin.clip.xy, viewZ);
	let perCluster = max(frame.clusterExtra.x, 1u);
	let count = min(clusterCounts[ci], perCluster);
	var localLighting = vec3<f32>(0.0);
	for (var i = 0u; i < count; i = i + 1u) {
		let li = clusterLights[ci * perCluster + i];
		if (li >= frame.clusterDims.w) { continue; }
		let lightData = lights[li];
		let d = lightData.posRadius.xyz - vin.worldPos;
		let dist2 = dot(d, d);
		let r = lightData.posRadius.w;
		if (dist2 >= r * r) { continue; }
		let dist = sqrt(max(dist2, 1e-8));
		// Inverse square with a smooth window so a light dies exactly at its radius —
		// a hard cutoff leaves a visible disc edge on the ground under every muzzle flash.
		let ratio = dist2 / (r * r);
		let window = sat(1.0 - ratio * ratio);
		let atten = window * window / max(dist2, 0.01);
		var cone = 1.0;
		if (lightData.directionCone.w > 0.0) {
			let inner = length(lightData.directionCone.xyz);
			let cosAngle = dot(-d / dist, lightData.directionCone.xyz / max(inner, 1e-6));
			cone = smoothstep(lightData.directionCone.w, inner, cosAngle);
		}
		let radiance = lightData.colorIntensity.rgb * lightData.colorIntensity.a * atten * cone;
		localLighting += shadePunctual(baseColor, metallic, rough, n, v, d / dist, radiance);
	}

	// Water replaces this whole term. Running the probes on a sea-sized draw missed 120 Hz.
	if (vin.kind != 2u) {
	if (vis > 0.0) {
		let sunRadiance = frame.sunColor.rgb * frame.sunColor.a * vis;
		color = color + shadePunctual(baseColor, metallic, rough, n, v, sunL, sunRadiance);
	}
	color += localLighting;
	// --- ambient: probe irradiance for diffuse, analytic sky for specular ---
	let irradiance = probeIrradiance(vin.worldPos, n) * frame.params.w * frame.post.w;
	color = color + baseColor * (1.0 - metallic) * irradiance * INV_PI * ao;
	if (textureNumLayers(matAlbedo) == ${blenderPalette.length}u &&
		(vin.layer == 6u || vin.layer == 25u || vin.layer == 26u)) {
		// Thin authored leaves transmit and wrap light; vertical blades should not
		// shade like solid black walls. This remains incident light, then passes through
		// the ordinary fog/shroud path below.
		let wrap = max((dot(n, sunL) + .65) / 1.65, 0.0);
		let extraSun = max(wrap - max(dot(n, sunL), 0.0), 0.0) * .55;
		let backlight = pow(max(dot(-v, sunL), 0.0), 4.0) * .22;
		let upperSky = irradiance;
		color += baseColor * INV_PI * (frame.sunColor.rgb * frame.sunColor.a * vis * (extraSun + backlight) + upperSky * .45) * ao;
	}

	let NoV = max(dot(n, v), 1e-4);
	let refl = reflect(-v, n);
	let f0 = mix(vec3<f32>(0.04), baseColor, metallic);
	// Specular occlusion from AO, so a cavity does not pick up a full sky reflection.
	let specOcc = sat(pow(NoV + ao, exp2(-16.0 * rough - 1.0)) - 1.0 + ao);
	color = color + skyRadiance(refl) * envBRDF(f0, rough, NoV) * specOcc * frame.params.w;
	}

	if (vin.kind == 2u) {
		// The live terrain draw carries water depth in uv1.y. Beer-Lambert absorption
		// reveals the shallow mineral bed and tends toward blue-green with depth.
		let depth = max(vin.uv1.y, .015);
		let shoreDistance = max(vin.uv1.x, 0.0);
		let opticalDepth = depth / max(dot(n, v), .25);
		let absorption = exp(-vec3<f32>(1.35, .45, .25) * opticalDepth);
		let refractedUv = vin.uv0 * 2.1 + n.xz * depth * .065;
		let bedDetail = textureSampleLevel(matAlbedo, matSampler, refractedUv, vin.layer, 0.0).rgb;
		let mineral = mix(vec3<f32>(.30, .25, .15), vec3<f32>(.10, .16, .13), smoothstep(0.0, 3.5, shoreDistance));
		let bed = mineral * (.70 + sat(luma(bedDetail) * 9.0) * .65) * absorption;
		let deep = vec3<f32>(.012, .065, .075) * (vec3<f32>(1.0) - absorption);
		let fresnel = .02 + .98 * pow(1.0 - sat(dot(n, v)), 5.0);
		// Snowing turns the sky into a bright white overcast, and a near-total mirror of
		// that reads as a snow sheet or a road. Water stays WATER: as the snow cover builds,
		// the sky mirror is pulled down toward the deep blue-green so the surface keeps its
		// own colour instead of the sky's.
		let stayWater = sat(frame.surfaceWeather.y * 1.25);
		let reflection = skyRadiance(reflect(-v, n)) * mix(1.0, 0.42, stayWater);
		let seconds = frame.surfaceWeather.z;
		let p = vin.worldPos.xz;
		let focusing = .88 + .22 * sin(dot(p, vec2<f32>(7.1, 3.8)) - seconds * 2.1 + n.x * 12.0) * sin(dot(p, vec2<f32>(-4.3, 8.2)) + seconds * 1.6);
		let bedLight = frame.groundRadiance.rgb * .50 + frame.sunColor.rgb * frame.sunColor.a * vis * max(dot(n, sunL), 0.0) * INV_PI;
		let sunGlint = shadePunctual(vec3<f32>(0.0), 0.0, clamp(rough + .08, .12, .35), n, v, sunL, frame.sunColor.rgb * frame.sunColor.a * vis);
		let wash = .5 + .5 * sin(seconds * 1.65 + sin(p.x * 1.4 + p.y * 1.1));
		let front = .08 + wash * .28;
		let froth = sin(p.x * 17.3 + p.y * 8.7 - seconds * 1.2) * sin(p.x * 5.7 - p.y * 13.1 + seconds * 1.4);
		let foam = exp(-abs(shoreDistance - front) * 19.0) * (.32 + .68 * wash) * (.3 + .7 * smoothstep(-.35, .6, froth));
		color = (bed * focusing * bedLight + deep * (.45 + frame.params.w * .50)) * (1.0 - fresnel) + reflection * fresnel + sunGlint + localLighting;
		color = mix(color, vec3<f32>(.67, .74, .70) * (.35 + frame.params.w * .5), foam * .58);
	}

	// Occupied glass is emitted radiance at every tier. Real room lights use the same
	// geometry seed and are an extra fidelity layer, without billboard window substitutes.
	let roomEmission = windowEmission(vin.roomInfo,vin.roomLocal,vin.damage,frame.surfaceWeather.z) * (f32(frame.skySeed.w) / 65535.0) * 1.8;

	if (STATUS_EMISSIVE_INTENSITY > 0.0 || SURFACE_EMISSIVE_INTENSITY > 0.0) {
		let statusBody = statusEligibility(albedoSample.a, vin.uv1);
		// The zone flag alone decides, deliberately. geo/zone bit 7 is set per vertex by an
		// author saying "this geometry IS a light source", and fx is its only user. Gating it a
		// second time on the sampled material class meant a pure emitter whose UVs happened to
		// land on a low-class texel silently did not emit: measured, a tracer rendered at +1 luma
		// against the grass it crossed, so firing was invisible. The class still chooses WHICH
		// emitter colour below; it no longer gets a veto over whether an emitter emits.
		let surfaceBody = vin.emissiveSource;
		let emission = statusEmission(albedoSample.a, vin.uv1, geoN, statusBody) +
			instanceEmitterColor(albedoSample.a, vin.tint) * (SURFACE_EMISSIVE_INTENSITY * surfaceBody) + roomEmission;
//__BLOOM_WRITE__
		// This AOV returns before emission and fog so its alpha can carry the exact reflected
		// hull luminance under the strip without keeping another value live through the normal
		// forward path. The constant outer branch makes a zero-intensity build dead-code the
		// whole feature, which is required by the byte-identical pre-change witness.
		if (frame.debug.x == 15u) {
			return vec4<f32>(emission, -max(max(statusBody, surfaceBody),select(0.0,1.0,any(roomEmission > vec3<f32>(0.0)))) * max(luma(color), 1e-5));
		}

		// Functional light is radiance emitted by the machine, independent of incident light.
		// Add it before aerial perspective so the same intervening air attenuates every source.
		color = color + emission;
	} else {
		if (frame.debug.x == 15u) { return vec4<f32>(roomEmission, 0.0); }
		color += roomEmission;
	}

	// Ground UI colour stays readable in shade without becoming a light or bloom source.
	// The existing depth-tested translucent pass and the fog/shroud below still apply.
	if (vin.tint.a < -1.5) { color = vin.tint.rgb; }

	// --- aerial perspective -------------------------------------------------
	// Beer-Lambert extinction towards the colour of the intervening air, which sky sets
	// to the horizon radiance because it is the same medium seen along the same path.
	//
	// This is the cheapest thing in the renderer that makes distance readable. Without
	// it a ridge 400 m out is exactly as saturated and contrasty as the unit under the
	// cursor, and on a map with no reference objects the eye has no depth cue at all.
	// Integrate an exponentially thinning low atmosphere along the view ray. Using
	// ground range times density at the endpoint made elevated views uniformly opaque:
	// it counted the clear air above the weather layer as dense ground-level mist.
	let delta = frame.cameraPos.xyz - vin.worldPos;
	let layerHeight = 12.0;
	let groundHeight = max(vin.worldPos.y, 0.0);
	let eyeHeight = max(frame.cameraPos.y, 0.0);
	let heightDelta = (eyeHeight - groundHeight) / layerHeight;
	let groundDensity = exp(-groundHeight / layerHeight);
	let eyeDensity = exp(-eyeHeight / layerHeight);
	var meanDensity = exp(-(groundHeight + eyeHeight) / (2.0 * layerHeight));
	if (abs(heightDelta) > 0.001) {
		meanDensity = (groundDensity - eyeDensity) / heightDelta;
	}
	let fogDist = length(delta) * meanDensity;
	// Metres outside the playable rectangle, zero everywhere inside it. Computed here
	// rather than in the shroud block below because BOTH the boundary haze and the
	// boundary veil are the same distance function, and the world edge must be one
	// mechanism: the shroud block reads it again a few lines down.
	let shroudUv = (vin.worldPos.xz - frame.shroud.xy) * frame.shroud.zw;
	let outsideCells = length(max(vec2<f32>(0.0), max(-shroudUv, shroudUv - vec2<f32>(1.0))) / frame.shroud.zw);
	// Compressed exponential atmosphere: optical depth falls with altitude the way
	// real air does, so fog fills basins and thins on ridges instead of lying on
	// the ground plane.
	let altitude = max(vin.worldPos.y, 0.0);
	// Past the playable bounds that same air thickens and darkens, so the world stops
	// being visible before it stops existing — the human's "cover the final edges with
	// black fog". It falls off with altitude much faster than the atmosphere does, and
	// which pixels that spares is the whole design: what draws the eye to a boundary is
	// the LOW ground at the ring's outer edge, whose far side is a straight line of sky
	// three quarters of the way up the frame. A crest is not that — a crest is a
	// mountain against the sky, which is what mountain country looks like, and where a
	// crest does stand the low ground behind it is occluded anyway. So the curtain is
	// hung at the height of the ground that needs hiding, and the summits keep their form.
	let optical = frame.horizonColor.a * fogDist;
	color = mix(color, frame.aerialColor.rgb, 1.0 - exp(-optical));
	// The curtain is deliberately NOT integrated along the view ray the way the atmosphere
	// above it is. Distance and altitude fight when it is: the low outer ground that has to
	// disappear sits nearer the camera than the mountain flank that has to stay, so any
	// density that hides the first erases the second. Boundary opacity is a function of how
	// far outside the map the ground is and how low it lies, and of nothing else.
	let beyond = smoothstep(EDGE_HAZE_NEAR, EDGE_HAZE_FAR, outsideCells);
	let curtain = beyond * EDGE_HAZE_STRENGTH * exp(-altitude / EDGE_HAZE_SCALE_M);
	color = mix(color, frame.aerialColor.rgb * EDGE_HAZE_FLOOR, curtain);
//__BLOOM_FOG__

	// §4.7 shroud is colour only. NEVER discard here: the prepass has already written this
	// fragment's depth, and discarding from forward would reopen the see-through holes that
	// the prepass/forward invariant exists to prevent.
	//
	// The map is sampled continuously. Protocol states 0,1,2 upload as 0,128,255, so linear
	// filtering is the soft boundary rather than a value to threshold back into hard bands.
	//
	// Beyond the playable bounds the scenery ring carries the border cell's state for a few
	// cells, sinks into the same mist as remembered ground, and then past EDGE_VEIL_NEAR
	// keeps sinking to fully unknown: the world does not end at the map, it fades. That last
	// stretch is the same unexplored-ground veil the game already draws over what a player
	// cannot see, which is why it reads as distance rather than as a wall — a second, redder
	// boundary layer would go here, as one more term against outsideCells.
	let sampledShroud = textureSampleLevel(shroudMap, linearSampler, clamp(shroudUv, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).r;
	let shroudValue = mix(sampledShroud, 0.5, smoothstep(2.0, 16.0, outsideCells))
		* (1.0 - smoothstep(EDGE_VEIL_NEAR, EDGE_VEIL_FAR, outsideCells));
	if (shroudValue < 1.0) {
		// Fog of war as fog: unexplored ground is a lit mist the colour distant air already
		// takes on (the aerial colour), so it reads as "too far to see" rather than as a
		// black hole in the world. This opaque privacy veil carries no decorative
		// volume; atmospheric extinction is integrated separately along the view ray.
		let mist = mix(frame.aerialColor.rgb, vec3<f32>(luma(frame.aerialColor.rgb)), 0.45) * 0.92;
		// Unknown terrain is a dark privacy field, not luminous weather. The previous
		// value made unseen ground brighter than visible ground during dusk/storms,
		// turning the map boundary into a flat lit tile.
		let unknown = mist * 0.055;
		// Explored terrain remains readable. Desaturation marks stale information;
		// authoritative actor visibility and frozen structures still obey current sight.
		let remembered = mix(vec3<f32>(luma(color)), color, 0.45) * 0.55;
		let memoryAmount = sat(shroudValue * 2.0);
		let sightAmount = sat(shroudValue * 2.0 - 1.0);
		color = mix(mix(unknown, remembered, memoryAmount), color, sightAmount);
	}
//__SHROUD_BLOOM__

	// --- §5.6 debug views ---------------------------------------------------
	// Written to the HDR target in place of the shaded result. Values are pre-tonemap, so
	// a 0..1 quantity is displayed roughly as-is by AgX; the point is discrimination, not
	// colorimetric accuracy. debug.x == 0 is the normal path and costs one comparison.
	let dbg = frame.debug.x;
	if (//__DEBUG_CONDITION__) {
		var d = vec3<f32>(0.0);
		switch dbg {
			case 1u: { d = baseColor; }
			// Normals remapped from [-1,1] to [0,1]: a raw normal writes negatives, which
			// the tonemap clamps to black and makes half the surface unreadable.
			case 2u: { d = n * 0.5 + vec3<f32>(0.5); }
			case 3u: { d = vec3<f32>(rough); }
			case 4u: { d = vec3<f32>(metallic); }
			case 5u: { d = vec3<f32>(ao); }
			case 6u: { d = vec3<f32>(sat(dot(n, frame.sunDirection.xyz))); }
			case 7u: { d = vec3<f32>(sunVisibility(vin.worldPos, geoN, viewZ)); }
			case 8u: {
				// Flat colour per cascade so the split boundaries are unmistakable.
				let c = cascadeFor(viewZ);
				if (c == 0u) { d = vec3<f32>(1.0, 0.2, 0.2); }
				else if (c == 1u) { d = vec3<f32>(0.2, 1.0, 0.2); }
				else if (c == 2u) { d = vec3<f32>(0.2, 0.4, 1.0); }
				else { d = vec3<f32>(1.0, 1.0, 0.2); }
			}
			case 9u: {
				let dci = clusterIndexFor(vin.clip.xy, viewZ);
				let budget = max(frame.clusterExtra.x, 1u);
				d = vec3<f32>(f32(min(clusterCounts[dci], budget)) / f32(budget));
			}
			case 10u: {
				d = probeIrradiance(vin.worldPos, n) * frame.params.w * frame.post.w * INV_PI;
			}
			case 11u: {
				let dvis = sunVisibility(vin.worldPos, geoN, viewZ);
				d = shadePunctual(baseColor, metallic, rough, n, v,
					frame.sunDirection.xyz, frame.sunColor.rgb * frame.sunColor.a * dvis);
			}
			// Layer index normalised against 8 rather than layerCount: the point is to see
			// DISTINCT bands per zone, which a divide by the real count would flatten when
			// clamping has already collapsed them (§12.5).
			case 12u: { d = vec3<f32>(f32(vin.layer) / 8.0); }
			case 13u: { d = vec3<f32>(mask); }
			case 14u: { d = geoN * 0.5 + vec3<f32>(0.5); }
			default: { d = vec3<f32>(1.0, 0.0, 1.0); }
		}
		return vec4<f32>(d, //__DEBUG_ALPHA__);
	}

//__FORWARD_RETURN__
}
`

/** Ordinary geometry: one surface set, one array layer per vertex. */
export const FORWARD_WGSL = buildForward(false)

/** Late premultiplied-alpha presentation ghost; it never participates in depth or bloom. */
export const FORWARD_TRANSLUCENT_WGSL = buildForward(false, true)

/**
 * Ground: two §12.3b atlas layers, height-blended. Binds the SAME group-1 layout, because
 * the atlas bind group is built against materials' own layout — from render's side this is
 * an ordinary material slot that happens to hold every surface at once.
 */
export const FORWARD_BLEND_WGSL = buildForward(true)

/**
 * Non-blend terrain (water, ground whose chunk never blends) keeps the float32 TERRAIN
 * layout but must not be routed down the quantized unit pipelines: decoding float32
 * bytes as snorm8/unorm16 is what produced the black chunks and radial spikes that the
 * 051a683 revert removed. Same body as the unit modules, quantized declarations undone.
 */
export const FORWARD_TERRAIN_WGSL = buildForward(false, false, true)

// ---------------------------------------------------------------------------
// Froxel light culling.
// ---------------------------------------------------------------------------

export const CLUSTER_CULL_WGSL =
	FRAME_WGSL +
	PRELUDE +
	/* wgsl */ `
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> lights: array<Light>;
@group(0) @binding(2) var<storage, read_write> clusterCounts: array<u32>;
@group(0) @binding(3) var<storage, read_write> clusterLights: array<u32>;

/**
 * One thread per froxel. Each froxel owns a fixed slot range in clusterLights, so no
 * atomics and no compaction pass are needed — and the light order inside a froxel is
 * the light order in the buffer, which keeps the cull deterministic run to run (§5).
 */
@compute @workgroup_size(64)
fn cullMain(@builtin(global_invocation_id) gid: vec3<u32>) {
	let tilesX = max(frame.clusterDims.x, 1u);
	let tilesY = max(frame.clusterDims.y, 1u);
	let slices = max(frame.clusterDims.z, 1u);
	let total = tilesX * tilesY * slices;
	let ci = gid.x;
	if (ci >= total) { return; }

	let tx = ci % tilesX;
	let ty = (ci / tilesX) % tilesY;
	let tz = ci / (tilesX * tilesY);

	// Tangent of the half-FOV, straight out of the projection. Works for the jittered
	// matrix too: jitter only touches the skew terms, never the scale.
	let tanX = 1.0 / max(frame.proj[0].x, 1e-6);
	let tanY = 1.0 / max(frame.proj[1].y, 1e-6);

	let u0 = f32(tx) / f32(tilesX) * 2.0 - 1.0;
	let u1 = f32(tx + 1u) / f32(tilesX) * 2.0 - 1.0;
	let v0 = 1.0 - f32(ty) / f32(tilesY) * 2.0;
	let v1 = 1.0 - f32(ty + 1u) / f32(tilesY) * 2.0;

	let zNear = frame.clusterZ.x;
	let zFar = frame.clusterZ.y;
	let ratio = zFar / zNear;
	let z0 = zNear * pow(ratio, f32(tz) / f32(slices));
	let z1 = zNear * pow(ratio, f32(tz + 1u) / f32(slices));

	let xs = vec2<f32>(min(u0, u1), max(u0, u1)) * tanX;
	let ys = vec2<f32>(min(v0, v1), max(v0, v1)) * tanY;

	// The froxel's view-space AABB. Both z planes are evaluated because the corners of a
	// perspective froxel spread with depth; using only the far plane over-inflates it.
	let x00 = xs * z0;
	let x11 = xs * z1;
	let y00 = ys * z0;
	let y11 = ys * z1;
	let aabbMin = vec3<f32>(min(x00.x, x11.x), min(y00.x, y11.x), -z1);
	let aabbMax = vec3<f32>(max(x00.y, x11.y), max(y00.y, y11.y), -z0);

	let perCluster = max(frame.clusterExtra.x, 1u);
	let lightCount = frame.clusterDims.w;
	var n = 0u;
	for (var i = 0u; i < lightCount; i = i + 1u) {
		if (n >= perCluster) { break; }
		let l = lights[i];
		let center = (frame.view * vec4<f32>(l.posRadius.xyz, 1.0)).xyz;
		let d = max(aabbMin - center, center - aabbMax);
		let outside = max(d, vec3<f32>(0.0));
		if (dot(outside, outside) <= l.posRadius.w * l.posRadius.w) {
			clusterLights[ci * perCluster + n] = i;
			n = n + 1u;
		}
	}
	clusterCounts[ci] = n;
}
`

// ---------------------------------------------------------------------------
// Ambient probe volume.
// ---------------------------------------------------------------------------

export const PROBE_WGSL =
	FRAME_WGSL +
	PRELUDE +
	/* wgsl */ `
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read_write> probes: array<vec4<f32>>;
@group(0) @binding(2) var shadowMap: texture_depth_2d_array;
@group(0) @binding(3) var shadowSampler: sampler_comparison;
` +
	SKY_GRADIENT +
	/* wgsl */ `

const PROBE_DIRECTIONS: u32 = 32u;

/** Sun visibility at an arbitrary world point, from the cascade the point falls in. */
fn probeSunVisibility(worldPos: vec3<f32>) -> f32 {
	let viewZ = -(frame.view * vec4<f32>(worldPos, 1.0)).z;
	var c: u32 = 0u;
	if (viewZ > frame.cascadeSplits.x) { c = 1u; }
	if (viewZ > frame.cascadeSplits.y) { c = 2u; }
	if (viewZ > frame.cascadeSplits.z) { c = 3u; }
	c = min(c, max(frame.clusterExtra.y, 1u) - 1u);
	let lc = frame.cascadeVP[c] * vec4<f32>(worldPos, 1.0);
	let ndc = lc.xyz / lc.w;
	if (ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0 || ndc.z <= 0.0 || ndc.z >= 1.0) {
		return 1.0;
	}
	let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
	return textureSampleCompareLevel(shadowMap, shadowSampler, uv, c, ndc.z);
}

/**
 * Refreshes a slice of the volume each frame — probeDims.w probes, never more, so the
 * cost is a flat §7 budget rather than a function of volume size. A probe integrates the
 * analytic sky over 32 fixed directions plus the sun's single bounce off the ground,
 * gated by the cascade depth. There is no ray tracing here and no surface-to-surface
 * transport: this is an ambient cache, not global illumination.
 */
@compute @workgroup_size(64)
fn probeMain(@builtin(global_invocation_id) gid: vec3<u32>) {
	let dims = frame.probeDims.xyz;
	let total = max(dims.x * dims.y * dims.z, 1u);
	if (gid.x >= frame.probeDims.w) { return; }
	let probeIndex = (frame.clusterExtra.w + gid.x) % total;

	let px = probeIndex % dims.x;
	let py = (probeIndex / dims.x) % dims.y;
	let pz = probeIndex / (dims.x * dims.y);
	let worldPos = frame.probeOrigin.xyz + vec3<f32>(f32(px), f32(py), f32(pz)) * frame.probeOrigin.w;

	let vis = probeSunVisibility(worldPos);
	let sunUp = max(frame.sunDirection.y, 0.0);
	// One bounce: sunlight landing on the ground, tinted by the ground albedo, divided
	// by PI to turn irradiance back into the radiance leaving a Lambertian surface. The
	// second term is skylight bouncing off that same ground, which sky already publishes
	// albedo-weighted as groundRadiance rather than leaving it to be re-derived here.
	let bounce = frame.sunColor.rgb * frame.sunColor.a * sunUp * vis * frame.skyColor.a * INV_PI
		+ frame.groundRadiance.rgb * 0.35;

	var c0 = vec3<f32>(0.0);
	var c1 = vec3<f32>(0.0);
	var c2 = vec3<f32>(0.0);
	var c3 = vec3<f32>(0.0);
	let w = 4.0 * PI / f32(PROBE_DIRECTIONS);
	for (var i = 0u; i < PROBE_DIRECTIONS; i = i + 1u) {
		// Fibonacci sphere: an even, deterministic direction set with no RNG anywhere,
		// which is what keeps two runs of the same seed byte-identical (§5.2).
		let y = 1.0 - (2.0 * f32(i) + 1.0) / f32(PROBE_DIRECTIONS);
		let r = sqrt(max(0.0, 1.0 - y * y));
		let phi = f32(i) * 2.39996323;
		let dir = vec3<f32>(r * cos(phi), y, r * sin(phi));
		var radiance = skyGradient(dir);
		if (dir.y < 0.0) { radiance = bounce; }
		c0 = c0 + radiance * (0.282095 * w);
		c1 = c1 + radiance * (0.488603 * dir.y * w);
		c2 = c2 + radiance * (0.488603 * dir.z * w);
		c3 = c3 + radiance * (0.488603 * dir.x * w);
	}

	let o = probeIndex * 3u;
	probes[o] = vec4<f32>(c0, c1.x);
	probes[o + 1u] = vec4<f32>(c1.y, c1.z, c2.x, c2.y);
	probes[o + 2u] = vec4<f32>(c2.z, c3.x, c3.y, c3.z);
}
`

// ---------------------------------------------------------------------------
// Fullscreen triangle, shared by TAA and post.
// ---------------------------------------------------------------------------

const FULLSCREEN_VS = /* wgsl */ `
@vertex
fn vsFullscreen(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
	// One oversized triangle, not two triangles: no diagonal seam and one fewer vertex
	// invocation per pixel row along the shared edge.
	var corners = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
	return vec4<f32>(corners[vi], 0.0, 1.0);
}
`

// ---------------------------------------------------------------------------
// Sky dome — the background, drawn as the last draw of the forward pass.
// ---------------------------------------------------------------------------

/**
 * A fullscreen triangle, not a dome mesh.
 *
 * The ray comes from invViewProj, so there is no dome radius to pick, no tessellation to
 * seam along, and nothing that can clip through the far plane at maximum zoom-out. A real
 * dome would need all three tuned and would still be wrong at some camera height.
 *
 * Drawn LAST in the forward pass rather than first: at depthCompare greater-equal against
 * a reverse-Z buffer the prepass already filled, only pixels no geometry claimed survive,
 * so this shades the background exactly once and never under the terrain. Drawing it first
 * would shade every pixel and then overwrite most of them. It joins the forward pass's
 * existing depthReadOnly regime and writes no depth — if it did, TAA's reprojection would
 * start treating background pixels as geometry and the sky would smear when the camera
 * turned.
 */
const SKY_ALPHA = BLOOM_ENABLED
	? 'select(0.0, luma(color), frame.debug.x == 17u)'
	: '1.0'

export const SKY_DOME_WGSL =
	FRAME_WGSL +
	PRELUDE +
	/* wgsl */ `
@group(0) @binding(0) var<uniform> frame: Frame;
` +
	SKY_GRADIENT +
	/* wgsl */ `
@vertex
fn vsMain(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
	// Reverse-Z: 0 is the infinite far plane, which is exactly where the sky is.
	var corners = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
	return vec4<f32>(corners[vi], 0.0, 1.0);
}

/**
 * Integer-hash value noise. NOT a fract(sin(dot(...))) hash: those diverge between
 * drivers at large inputs, and §5.2 requires one seed to give one sky everywhere.
 */
${CLOUD_FIELD_WGSL}

/**
 * Angular falloff of a celestial disc. Compares ANGLES rather than cosines: at the half
 * degree a real sun subtends, cos runs 0.99996..1.0 and float32 has no useful resolution
 * left in that band.
 */
fn disc(dir: vec3<f32>, towards: vec3<f32>, radius: f32, softness: f32) -> f32 {
	let angle = acos(clamp(dot(dir, towards), -1.0, 1.0));
	return 1.0 - smoothstep(radius * (1.0 - softness), radius * (1.0 + softness), angle);
}

// The sun and the moon subtend almost exactly the same half degree from Earth. That
// coincidence is why total eclipses exist, and it means one radius serves both.
const DISC_RADIUS: f32 = 0.00465;
// Clouds sit on a flat slab. A layer this far up is over the horizon well before the map
// edge, so the slab never reveals itself as a plane.
const CLOUD_ALTITUDE: f32 = 900.0;

@fragment
fn fsMain(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
	// Unproject at z = 1, the NEAR plane, and subtract the eye. Under reverse-Z with an
	// infinite far plane z = 0 is literally the point at infinity, so unprojecting there
	// divides by a w on its way to zero. Same reasoning as camera/pick.ts.
	let uv = pos.xy * frame.screen.zw;
	let ndc = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
	let nearH = frame.invViewProj * vec4<f32>(ndc, 1.0, 1.0);
	let dir = normalize(nearH.xyz / nearH.w - frame.cameraPos.xyz);

	// Above the horizon this is the same function the probe integrates and polished
	// surfaces reflect. BELOW it the two legitimately part company, and conflating them
	// was a real error: groundRadiance is what the ground RADIATES, the bounce term the
	// probe needs, and it is nearly black. What a camera looking past the map edge
	// actually sees down there is ground at effectively infinite distance, which aerial
	// perspective has already taken all the way to the aerial colour.
	//
	// This is not a corner case in STEELSEED — it is the ENTIRE visible background. The
	// RTS camera pitches 34 to 62 degrees down with a 24 degree half-FOV, so even the top
	// row of pixels sits at least 10 degrees BELOW the horizon and every background ray
	// takes this branch.
	// select(), not a ternary — WGSL has no conditional operator at all. Below the
	// horizon the map has ended: the void is BLACK, fading from a barely-lifted line at
	// the horizon so the silhouette edge of the last terrain row keeps its contrast.
	var color = select(
		mix(vec3<f32>(0.018), vec3<f32>(0.0), smoothstep(0.0, 0.12, -dir.y)),
		skyGradient(dir),
		dir.y >= 0.0,
	);

	// --- discs ---
	// The moon is drawn from its own direction, and the sun is suppressed when the two
	// coincide. Sky retargets sunDirection onto the moon after civil twilight so the
	// direct beam stays one lobe, which means that at night BOTH discs would otherwise
	// land on the same pixels and render at double brightness.
	let sunIsMoon = dot(frame.sunDirection.xyz, frame.moonDirection.xyz) > 0.999;
	if (!sunIsMoon) {
		let d = disc(dir, frame.sunDirection.xyz, DISC_RADIUS, 0.35);
		// Plus a wide, weak halo: forward-scattered light around the sun, which is what
		// makes a bright sky read as having a sun in it rather than being evenly lit.
		let halo = pow(sat(dot(dir, frame.sunDirection.xyz)), 480.0) * 0.35;
		color = color + frame.sunColor.rgb * frame.sunColor.a * (d * 8.0 + halo);
	}
	let moonI = frame.groundRadiance.a;
	if (moonI > 0.0) {
		// No halo on the moon: it is reflected light and does not bloom the sky the way
		// the sun does. Softer edge only because it is dim enough to alias otherwise.
		let m = disc(dir, frame.moonDirection.xyz, DISC_RADIUS, 0.5);
		color = color + frame.moonColor.rgb * moonI * m * 6.0;
	}

	// --- clouds ---
	if (dir.y > 0.02) {
		let hit = frame.cameraPos.xyz + dir * (CLOUD_ALTITUDE / dir.y);
		let p = (hit.xz + frame.cloudDrift.xy) * frame.cloud.z;
		let field = cloudField(p, frame.skySeed.x);
		// Coverage THRESHOLDS the field rather than scaling it, so raising it grows cloud
		// edges outward the way an overcast actually builds. Scaling would only darken the
		// same shapes and the sky would never close over.
		let cov = frame.cloud.x;
		var amount = sat((field - (1.0 - cov)) / max(cov * 0.6, 1e-3));
		// Fade out towards the horizon, where the slab is edge-on and the noise would
		// otherwise stretch into radial streaks.
		amount = amount * smoothstep(0.02, 0.22, dir.y);

		// Two tones is enough to read as volume at this scale: a sunlit top over a base
		// lit only by the sky. The pow term is forward scattering through thin edges —
		// the bright rim on the sunward side of a cloud.
		let toSun = sat(dot(dir, frame.sunDirection.xyz) * 0.5 + 0.5);
		let lit = frame.sunColor.rgb * frame.sunColor.a * (0.16 + 0.42 * pow(toSun, 3.0));
		let body = frame.horizonColor.rgb * 0.85 + frame.skyColor.rgb * 0.35;
		color = mix(color, body + lit, amount * frame.cloud.y);
	}

	return vec4<f32>(color, ${SKY_ALPHA});
}
`

// ---------------------------------------------------------------------------
// TAA resolve.
// ---------------------------------------------------------------------------

const TAA_CURRENT = BLOOM_ENABLED
	? `let currentSample = textureLoad(currentTex, px, 0);
	let current = currentSample.rgb;
	let currentKey = currentSample.a;`
	: 'let current = textureLoad(currentTex, px, 0).rgb;'
const TAA_CURRENT_RETURN = BLOOM_ENABLED
	? 'return vec4<f32>(current, currentKey);'
	: 'return vec4<f32>(current, 1.0);'
const TAA_KEY_RANGE_DECL = BLOOM_ENABLED ? `
	var minKey = 1e20;
	var maxKey = -1e20;` : ''
const TAA_KEY_RANGE_ACCUM = BLOOM_ENABLED ? `
			let sampleKey = textureLoad(currentTex, q, 0).a;
			minKey = min(minKey, sampleKey);
			maxKey = max(maxKey, sampleKey);` : ''
const TAA_HISTORY = BLOOM_ENABLED
	? `let historySample = textureSampleLevel(historyTex, linearSampler, prevUv, 0.0);
	let history = historySample.rgb;
	let historyKey = clamp(historySample.a, minKey, maxKey);`
	: 'let history = textureSampleLevel(historyTex, linearSampler, prevUv, 0.0).rgb;'
const TAA_RETURN = BLOOM_ENABLED
	? 'return vec4<f32>(mix(current, clamped, feedback), mix(currentKey, historyKey, feedback));'
	: 'return vec4<f32>(mix(current, clamped, feedback), 1.0);'

export const TAA_WGSL = (
	FRAME_WGSL +
	PRELUDE +
	FULLSCREEN_VS +
	/* wgsl */ `
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var currentTex: texture_2d<f32>;
@group(0) @binding(2) var historyTex: texture_2d<f32>;
@group(0) @binding(3) var depthTex: texture_depth_2d;
@group(0) @binding(4) var linearSampler: sampler;
@group(0) @binding(5) var velocityTex: texture_2d<f32>;

/** YCoCg for the neighbourhood clamp: clipping in a luma/chroma basis ghosts far less. */
fn rgbToYCoCg(c: vec3<f32>) -> vec3<f32> {
	return vec3<f32>(
		0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
		0.5 * c.r - 0.5 * c.b,
		-0.25 * c.r + 0.5 * c.g - 0.25 * c.b,
	);
}

fn yCoCgToRgb(c: vec3<f32>) -> vec3<f32> {
	let t = c.x - c.z;
	return vec3<f32>(t + c.y, c.x + c.z, t - c.y);
}

@fragment
fn fsMain(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
	let px = vec2<i32>(pos.xy);
	let dims = vec2<i32>(textureDimensions(currentTex, 0));
//__TAA_CURRENT__
	let depth = textureLoad(depthTex, px, 0);

	// Reverse-Z: 0 is the infinite far plane, i.e. nothing was drawn here. Reconstructing
	// a world position from it divides by a zero w, so the history is simply not used.
	if (depth <= 0.0) { //__TAA_CURRENT_RETURN__ }

	let uv = pos.xy * frame.screen.zw;
	// The prepass writes current UV minus previous UV for the exact submitted LOD, model
	// transform and skin pose. Camera motion is part of the same vector for static geometry,
	// so this replaces the old camera-only world-position reconstruction rather than layering
	// a second estimate on top of it.
	let velocity = textureLoad(velocityTex, px, 0).xy;
	// The clear value (2,2) marks pixels without a valid motion vector, such as
	// translucent effects. Skinned actors must write their previous-pose velocity
	// in the prepass; treating their moving limbs as static ghosts their history.
	if (any(abs(velocity) >= vec2<f32>(1.0))) { //__TAA_CURRENT_RETURN__ }
	let prevUv = uv - velocity;
	if (prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0) {
		//__TAA_CURRENT_RETURN__
	}

	var minC = vec3<f32>(1e20);
	var maxC = vec3<f32>(-1e20);
//__TAA_KEY_RANGE_DECL__
	// Plus, not a 3x3. The four corners were nine full-res loads and the 120 Hz tail.
	for (var y = -1; y <= 1; y = y + 1) {
		for (var x = -1; x <= 1; x = x + 1) {
			if (x != 0 && y != 0) { continue; }
			let q = clamp(px + vec2<i32>(x, y), vec2<i32>(0), dims - vec2<i32>(1));
			let s = rgbToYCoCg(textureLoad(currentTex, q, 0).rgb);
			minC = min(minC, s);
			maxC = max(maxC, s);
//__TAA_KEY_RANGE_ACCUM__
		}
	}

	// Bilinear, not a point load: reprojection lands between texels almost always, and a
	// nearest fetch there is what makes a panning camera crawl.
//__TAA_HISTORY__
	let clamped = yCoCgToRgb(clamp(rgbToYCoCg(history), minC, maxC));
	let feedback = frame.post.z;
//__TAA_RETURN__
}
`
)
	.replace('//__TAA_CURRENT__', TAA_CURRENT)
	.replaceAll('//__TAA_CURRENT_RETURN__', TAA_CURRENT_RETURN)
	.replace('//__TAA_KEY_RANGE_DECL__', TAA_KEY_RANGE_DECL)
	.replace('//__TAA_KEY_RANGE_ACCUM__', TAA_KEY_RANGE_ACCUM)
	.replace('//__TAA_HISTORY__', TAA_HISTORY)
	.replace('//__TAA_RETURN__', TAA_RETURN)

// ---------------------------------------------------------------------------
// Emissive-key bloom. The input is signed emitted luminance in TAA alpha, never
// scene brightness. Positive is Foundry warm, negative is Lattice cool.
// ---------------------------------------------------------------------------

export const BLOOM_WGSL = BLOOM_ENABLED
	? FRAME_WGSL + PRELUDE + FULLSCREEN_VS + /* wgsl */ `
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var sceneTex: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;

const BLOOM_RADIUS: f32 = ${BLOOM_RADIUS_PX.toFixed(1)};
const BLOOM_GAIN: f32 = ${BLOOM_INTENSITY.toFixed(4)};

fn emissionFromKey(key: f32) -> vec3<f32> {
	let warm = vec3<f32>(6.45, 2.04, 0.30);
	let cool = vec3<f32>(0.658, 0.686, 0.756);
	let tint = select(cool / luma(cool), warm / luma(warm), key >= 0.0);
	return tint * abs(key);
}

fn sampleEmission(uv: vec2<f32>) -> vec3<f32> {
	return emissionFromKey(textureSampleLevel(sceneTex, linearSampler, uv, 0.0).a);
}

@fragment
fn fsMain(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
	// Ordinary debug views must remain pure AOVs. 16 is bloom itself; 17 is the
	// deliberately-wrong luminance-key witness and must execute this real pass.
	if (frame.debug.x != 0u && frame.debug.x != 16u && frame.debug.x != 17u) {
		return vec4<f32>(0.0);
	}

	let dims = vec2<f32>(textureDimensions(sceneTex, 0));
	let bloomDims = ceil(dims / 4.0);
	let uv = pos.xy / bloomDims;
	let texel = 1.0 / dims;
	// Eight full-resolution pixels at the 620 px reference height, scaled with the
	// frame but capped before it can become a glow cloud around the whole machine.
	let radius = min(12.0, BLOOM_RADIUS * dims.y / 620.0);
	let r0 = radius * 0.35;
	let r1 = radius * 0.60;
	let r2 = radius;
	var sum = sampleEmission(uv) * 0.18;
	sum = sum + sampleEmission(uv + vec2<f32>( r0, 0.0) * texel) * 0.10;
	sum = sum + sampleEmission(uv + vec2<f32>(-r0, 0.0) * texel) * 0.10;
	sum = sum + sampleEmission(uv + vec2<f32>(0.0,  r0) * texel) * 0.10;
	sum = sum + sampleEmission(uv + vec2<f32>(0.0, -r0) * texel) * 0.10;
	sum = sum + sampleEmission(uv + vec2<f32>( r1,  r1) * texel) * 0.065;
	sum = sum + sampleEmission(uv + vec2<f32>(-r1,  r1) * texel) * 0.065;
	sum = sum + sampleEmission(uv + vec2<f32>( r1, -r1) * texel) * 0.065;
	sum = sum + sampleEmission(uv + vec2<f32>(-r1, -r1) * texel) * 0.065;
	sum = sum + sampleEmission(uv + vec2<f32>( r2, 0.0) * texel) * 0.035;
	sum = sum + sampleEmission(uv + vec2<f32>(-r2, 0.0) * texel) * 0.035;
	sum = sum + sampleEmission(uv + vec2<f32>(0.0,  r2) * texel) * 0.035;
	sum = sum + sampleEmission(uv + vec2<f32>(0.0, -r2) * texel) * 0.035;
	return vec4<f32>(sum * (BLOOM_GAIN / 0.98), 1.0);
}
`
	: ''

// ---------------------------------------------------------------------------
// Auto exposure — two-stage parallel reduction with temporal adaptation.
// ---------------------------------------------------------------------------

export const EXPOSURE_WGSL =
	FRAME_WGSL +
	PRELUDE +
	/* wgsl */ `
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var sceneTex: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var<storage, read_write> partials: array<f32>;
@group(0) @binding(4) var<storage, read_write> exposure: array<f32>;

const GRID: u32 = 128u;
// Preserve ordinary eye adaptation through daylight, then compress low-light gain into
// a bounded shoulder. The 0.60 ceiling is the DPR-2/high measurement boundary that
// restores the day/night display range without pinning exposure to one value.
const EXPOSURE_KNEE: f32 = 0.45;
const EXPOSURE_MAX: f32 = 0.60;
const EXPOSURE_NIGHT_MAX: f32 = 0.18;
const EXPOSURE_NIGHT_AMBIENT: f32 = 0.38;
const EXPOSURE_DAY_AMBIENT: f32 = 1.00;

var<workgroup> reduceA: array<f32, 64>;
var<workgroup> reduceB: array<f32, 256>;

fn clampExposure(wanted: f32, ambientScale: f32) -> f32 {
	var ordinary = wanted;
	if (wanted > EXPOSURE_KNEE) {
		let span = EXPOSURE_MAX - EXPOSURE_KNEE;
		let excess = wanted - EXPOSURE_KNEE;
		// Rational soft knee: value and slope are continuous at the knee, and the result
		// approaches EXPOSURE_MAX asymptotically as a scene gets darker.
		ordinary = EXPOSURE_KNEE + span * excess / (span + excess);
	}

	// The authored sky environment already supplies the lighting scale used by terrain,
	// units and probes. Use that stable signal for the low-light ceiling so transient FX
	// cannot change exposure for the whole frame. Daylight retains the original 0.60 cap.
	let daylight = smoothstep(EXPOSURE_NIGHT_AMBIENT, EXPOSURE_DAY_AMBIENT, ambientScale);
	let lowLightCeiling = mix(EXPOSURE_NIGHT_MAX, EXPOSURE_MAX, daylight);
	return min(ordinary, lowLightCeiling);
}

/**
 * Stage 1: a fixed 128x128 sample grid, regardless of resolution, so the metering cost
 * does not scale with the render target. Log-average rather than linear average — a
 * single muzzle flash would otherwise stop the whole frame down.
 */
@compute @workgroup_size(64)
fn lumMain(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) lid: u32, @builtin(workgroup_id) wid: vec3<u32>) {
	let idx = gid.x;
	let gx = idx % GRID;
	let gy = idx / GRID;
	let uv = (vec2<f32>(f32(gx), f32(gy)) + 0.5) / f32(GRID);
	let c = textureSampleLevel(sceneTex, linearSampler, uv, 0.0).rgb;
	reduceA[lid] = log2(max(luma(c), 1e-5));
	workgroupBarrier();
	// The barrier sits outside the conditional so every invocation reaches it — a barrier
	// under divergent control flow is undefined behaviour, and it hangs rather than warns.
	for (var s = 32u; s > 0u; s = s >> 1u) {
		if (lid < s) { reduceA[lid] = reduceA[lid] + reduceA[lid + s]; }
		workgroupBarrier();
	}
	if (lid == 0u) { partials[wid.x] = reduceA[0]; }
}

/** Stage 2: one workgroup folds the 256 partials and advances the adaptation. */
@compute @workgroup_size(256)
fn adaptMain(@builtin(local_invocation_index) lid: u32) {
	reduceB[lid] = partials[lid];
	workgroupBarrier();
	for (var s = 128u; s > 0u; s = s >> 1u) {
		if (lid < s) { reduceB[lid] = reduceB[lid] + reduceB[lid + s]; }
		workgroupBarrier();
	}
	if (lid != 0u) { return; }

	let avgLogLum = reduceB[0] / f32(GRID * GRID);
	let avgLum = max(exp2(avgLogLum), 1e-5);
	// Saturation-based speed with the standard 12.5 reflected-light calibration.
	let ev100 = log2(avgLum * 100.0 / 12.5);
	// 'target' is a WGSL reserved keyword; this is the same quantity under a legal name.
	let rawWanted = 1.0 / max(1.2 * exp2(ev100 - frame.post.x), 1e-6);
	let wanted = clampExposure(rawWanted, frame.params.w);

	var prev = exposure[0];
	if (!(prev > 0.0)) { prev = wanted; }
	// The eye stops down faster than it opens up; matching that keeps a step into
	// shadow from blooming for half a second.
	let rate = select(0.9, 2.2, wanted < prev);
	let alpha = 1.0 - exp(-max(frame.params.y, 0.0) * rate);
	// The seed is deliberately generous for the old unconstrained curve. Clamp the
	// adapted state too, so frame 1 cannot spend seconds above the measured ceiling.
	exposure[0] = min(prev + (wanted - prev) * alpha, EXPOSURE_MAX);
	exposure[1] = avgLum;
}
`

// ---------------------------------------------------------------------------
// Post — exposure, sharpen, AgX tonemap, dither, to the swapchain.
// ---------------------------------------------------------------------------

const POST_BLOOM_BINDING = BLOOM_ENABLED ? '@group(0) @binding(4) var bloomTex: texture_2d<f32>;' : ''
const POST_BLOOM_SAMPLE = BLOOM_ENABLED
	? `let uv = pos.xy / vec2<f32>(textureDimensions(sceneTex, 0));
	let bloom = textureSampleLevel(bloomTex, linearSampler, uv, 0.0).rgb;`
	: ''
const POST_BLOOM_COMBINE = BLOOM_ENABLED
	? `if (frame.debug.x == 16u) { return vec4<f32>(agx(bloom * ev), 1.0); }
	let postColor = reflectedColor * contact + bloom * ev;`
	: 'let postColor = reflectedColor * contact;'

export interface PostFeatures {
	readonly contact: boolean
	readonly contactDebug: boolean
	readonly reflections: boolean
	readonly reflectionsDebug: boolean
	readonly reflectionsMask: boolean
}

/** The post shader for one feature set. Quality presets choose; URL flags override. */
export function postWgsl(f: PostFeatures, quality?: RenderQuality): string {
	return (
	FRAME_WGSL +
	PRELUDE +
	FULLSCREEN_VS +
	/* wgsl */ `
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var sceneTex: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var<storage, read> exposure: array<f32>;
//__POST_BLOOM_BINDING__
//__REFLECTION_WGSL__
//__CONTACT_WGSL__

// Heat shimmer (render/heat): up to four sources in framebuffer pixels (centre, radius,
// strength in pixels), then (time, count). All zero means none, which is the usual frame.
struct Heat {
	sources: array<vec4<f32>, 4>,
	params: vec4<f32>,
}
@group(0) @binding(8) var<uniform> heat: Heat;

/** The shimmer's displacement at framebuffer pixel p, in pixels: slow waves rising through
 *  each source's disc, strongest at its centre, gone at its rim and at the screen edge. The
 *  waves are laid out in units of the source's radius, so a far blast shimmers as a near one. */
fn heatOffset(p: vec2<f32>, dims: vec2<f32>) -> vec2<f32> {
	let n = min(u32(heat.params.y), 4u);
	if (n == 0u) { return vec2<f32>(0.0); }
	let t = heat.params.x;
	var off = vec2<f32>(0.0);
	for (var i = 0u; i < n; i++) {
		let s = heat.sources[i];
		let q = (p - s.xy) / max(s.z, 1.0);
		let r = length(q);
		if (r >= 1.0) { continue; }
		let fall = (1.0 - r) * (1.0 - r);
		let wave = vec2<f32>(
			sin(q.y * 23.0 + t * 6.1 + sin(q.x * 9.0 + t * 1.7) * 1.4),
			cos(q.x * 19.0 - t * 4.3 + sin(q.y * 11.0 - t * 2.3) * 1.2),
		);
		off += wave * (s.w * fall);
	}
	let edge = min(min(p.x, p.y), min(dims.x - p.x, dims.y - p.y));
	return off * smoothstep(0.0, 32.0, edge);
}

// AgX. A filmic display transform with a far gentler hue shift under saturated,
// over-range light than a Reinhard or ACES fit — which matters here because muzzle
// flashes and burning wrecks are real lights and routinely blow past 1.0.
const AGX_MIN_EV: f32 = -12.47393;
const AGX_MAX_EV: f32 = 4.026069;

fn agxContrast(x: vec3<f32>) -> vec3<f32> {
	let x2 = x * x;
	let x4 = x2 * x2;
	return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

fn agx(color: vec3<f32>) -> vec3<f32> {
	// FIXED 2026-08-05 — BOTH matrices below were TRANSPOSED, and together they tinted
	// every pixel in the game blue.
	//
	// mat3x3(a, b, c) takes COLUMN vectors in WGSL, exactly as mat3() does in the GLSL these
	// were copied from. The transcription used each source line as a column, but the source
	// lines are the matrix's ROWS. Two transposes, one in each matrix.
	//
	// The invariant that catches it: each of these matrices has row sums of exactly 1, so
	// each maps (1,1,1) to (1,1,1) and neutral survives. Transposed, the inset's row sums
	// become (1.1058, 0.9332, 0.9610) — it pushes grey towards red before the curve, and the
	// outset then pulls the result towards blue. Measured end to end:
	//
	//     transposed pair:  agx(grey) spread 0.19 linear, blue-biased
	//     correct pair:     agx(grey) spread 2.8e-16 THROUGH the nonlinear curve
	//
	// Grey in, grey out is a colorimetric invariant of any display transform. The measured
	// symptom was a §5.6 debug view writing pure vec3(nDotL) — greyscale by construction,
	// and returned before aerial perspective is applied — reading back as rgb(98,99,132),
	// b-r = +34/255, with TAA fully converged over 120 frames.
	//
	// This is the flat blue-violet wash §14.5 recorded. Its first two diagnoses were both
	// wrong in the same way, and so was my own first attempt at this one: the frame was read
	// as evidence about LIGHTING, when nothing in the lighting chain was involved. §14.5 had
	// already retracted "the sky/ambient term dominates the sun" after measuring 7.56:1 the
	// other way. The mechanism was two transposed matrices, three passes downstream of every
	// quantity anyone had measured.
	//
	// If either matrix is ever replaced, check the row sums are 1 before believing it.
	let inset = mat3x3<f32>(
		vec3<f32>(0.8566271533, 0.1373189729, 0.1118982130),
		vec3<f32>(0.0951212405, 0.7612419906, 0.0767994186),
		vec3<f32>(0.0482516061, 0.1014390365, 0.8113023684),
	);
	// Transposed for the same reason, and fixed the same way. Row sums are 1 here too.
	let outset = mat3x3<f32>(
		vec3<f32>(1.1271005818, -0.1413297635, -0.1413297635),
		vec3<f32>(-0.1106066431, 1.1578237022, -0.1106066431),
		vec3<f32>(-0.0164939387, -0.0164939387, 1.2519364066),
	);
	var v = inset * max(color, vec3<f32>(0.0));
	v = clamp(log2(max(v, vec3<f32>(1e-10))), vec3<f32>(AGX_MIN_EV), vec3<f32>(AGX_MAX_EV));
	v = (v - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV);
	v = agxContrast(v);
	v = outset * v;
	// AgX lands in a display-referred, roughly 2.2-encoded space, and the swapchain is a
	// plain unorm target with no sRGB view, so this is written out as-is.
	return sat3(v);
}

/** 4x4 ordered dither. 16 float steps of noise kills banding on an 8-bit target. */
fn bayer(p: vec2<u32>) -> f32 {
	let x = p.x & 3u;
	let y = p.y & 3u;
	var m = array<f32, 16>(
		0.0, 8.0, 2.0, 10.0,
		12.0, 4.0, 14.0, 6.0,
		3.0, 11.0, 1.0, 9.0,
		15.0, 7.0, 13.0, 5.0,
	);
	return (m[y * 4u + x] + 0.5) / 16.0 - 0.5;
}

@fragment
fn fsMain(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
	let px = vec2<i32>(pos.xy);
	let dims = vec2<i32>(textureDimensions(sceneTex, 0));
	let ev = exposure[0];
//__POST_BLOOM_SAMPLE__

	// A heat source bends the scene read: filtered at the displaced point, the sharpen's
	// neighbours around its nearest pixel. Everywhere else the read is the plain load.
	let heatOff = heatOffset(pos.xy, vec2<f32>(dims));
	let hp = clamp(px + vec2<i32>(round(heatOff)), vec2<i32>(0), dims - vec2<i32>(1));
	var c = textureLoad(sceneTex, px, 0).rgb * ev;
	if (any(heatOff != vec2<f32>(0.0))) {
		c = textureSampleLevel(sceneTex, linearSampler, (pos.xy + heatOff) / vec2<f32>(dims), 0.0).rgb * ev;
	}
	// Mild unsharp mask, applied to the exposed scene-linear colour. Done before the
	// tonemap so the sharpen cannot push a highlight past the shoulder and clip it.
	let l = textureLoad(sceneTex, clamp(hp + vec2<i32>(-1, 0), vec2<i32>(0), dims - vec2<i32>(1)), 0).rgb * ev;
	let r = textureLoad(sceneTex, clamp(hp + vec2<i32>(1, 0), vec2<i32>(0), dims - vec2<i32>(1)), 0).rgb * ev;
	let u = textureLoad(sceneTex, clamp(hp + vec2<i32>(0, -1), vec2<i32>(0), dims - vec2<i32>(1)), 0).rgb * ev;
	let d = textureLoad(sceneTex, clamp(hp + vec2<i32>(0, 1), vec2<i32>(0), dims - vec2<i32>(1)), 0).rgb * ev;
	let amount = frame.post.y;
	let sharpened = max(c * (1.0 + 4.0 * amount) - (l + r + u + d) * amount, vec3<f32>(0.0));
//__CONTACT_SAMPLE__
//__REFLECTION_SAMPLE__
//__POST_BLOOM_COMBINE__

	let mapped = agx(postColor);
	let dither = bayer(vec2<u32>(max(px, vec2<i32>(0)))) / 255.0;
	// Classic skips the post-AgX grade that landed after the 2026-09-06 High look.
	if (frame.debug.y != 0u) {
		return vec4<f32>(sat3(mapped + vec3<f32>(dither)), 1.0);
	}
	// Colour grade after AgX, display-referred. The goal's frame look: contrast,
	// warmth, slight saturation - each deliberately mild, because the scene itself
	// now carries the read. Contrast pivots on AgX's own middle grey rather than
	// 0.5, warmth is a quarter-stop channel tilt (amber up, blue down), and
	// saturation restores what AgX's desaturating highlight stretch takes away.
	let contrast = 1.12;
	var graded = (mapped - vec3<f32>(0.18)) * contrast + vec3<f32>(0.18);
	graded = graded * vec3<f32>(1.02, 1.0, 0.985);
	let grey = 0.25 * graded.r + 0.5 * graded.g + 0.25 * graded.b;
	graded = mix(vec3<f32>(grey), graded, 1.08);
	return vec4<f32>(sat3(graded + vec3<f32>(dither)), 1.0);
}
`
)
	.replace('//__POST_BLOOM_BINDING__', POST_BLOOM_BINDING)
	.replace('//__POST_BLOOM_SAMPLE__', POST_BLOOM_SAMPLE)
	.replace('//__POST_BLOOM_COMBINE__', POST_BLOOM_COMBINE)
	.replace('//__CONTACT_WGSL__', contactWgsl(quality?.contactTaps ?? 4))
	.replace('//__REFLECTION_WGSL__', REFLECTION_WGSL)
	.replace('//__REFLECTION_SAMPLE__', f.reflectionsMask
		? 'let mask = textureLoad(reflectionMetadata, px, 0); return vec4<f32>(vec3<f32>(max((mask.a - 0.25) / 0.75, 0.0)), 1.0); let reflectedColor = sharpened;'
		: f.reflections ? f.reflectionsDebug
			? 'let reflected = screenReflection(px, dims); return vec4<f32>(agx(reflected.rgb * reflected.a * ev), 1.0); let reflectedColor = sharpened;'
			: 'var reflectedColor = sharpened; if (frame.debug.x == 0u && frame.debug.z == 0u) { let reflected = screenReflection(px, dims); reflectedColor = mix(sharpened, reflected.rgb * ev, reflected.a); }'
			: 'let reflectedColor = sharpened;')
	.replace('//__CONTACT_SAMPLE__', f.contact
		? f.contactDebug ? 'let contact = contactVisibility(px, dims); return vec4<f32>(vec3<f32>(contact), 1.0);'
			: 'var contact = 1.0; if (frame.debug.x == 0u && frame.debug.z == 0u) { contact = contactVisibility(px, dims); }'
		: 'let contact = 1.0;')
}

/** Every feature on, for tools that inspect the shader without a preset. */
export const POST_WGSL = postWgsl({
	contact: CONTACT_ENABLED,
	contactDebug: CONTACT_DEBUG,
	reflections: REFLECTION_ENABLED,
	reflectionsDebug: REFLECTION_DEBUG,
	reflectionsMask: REFLECTION_MASK,
})

/** Compile one presentation-quality variant per boot, never during a frame. */
export function specializeForwardWgsl(source: string, quality: RenderQuality): string {
	const sample = quality.shadowPcfTaps === 9
		? `var visibility = 0.0;
	for (var oy = -1; oy <= 1; oy = oy + 1) {
		for (var ox = -1; ox <= 1; ox = ox + 1) {
			let tapUv = uv + vec2<f32>(f32(ox), f32(oy)) / max(frame.params.z, 1.0);
			visibility += textureSampleCompareLevel(shadowMap, shadowSampler, tapUv, c, ndc.z);
		}
	}
	return visibility / 9.0;`
		: `var visibility = 0.0;
	for (var oy = 0; oy < 2; oy = oy + 1) {
		for (var ox = 0; ox < 2; ox = ox + 1) {
			let tapUv = uv + (vec2<f32>(f32(ox), f32(oy)) * 1.5 - vec2<f32>(0.75)) / max(frame.params.z, 1.0);
			visibility += textureSampleCompareLevel(shadowMap, shadowSampler, tapUv, c, ndc.z);
		}
	}
	return visibility * 0.25;`
	let code = source.replace(
		'return textureSampleCompareLevel(shadowMap, shadowSampler, uv, c, ndc.z);',
		sample,
	)
	if (quality.cloudOctaves === 4)
		code = code.replace('for (var i = 0u; i < 2u; i = i + 1u) {\n\t\tsum = sum + valueNoise',
			'for (var i = 0u; i < 4u; i = i + 1u) {\n\t\tsum = sum + valueNoise')
	if (quality.probeTrilinear) {
		code = code
			.replace('let by = min(base.y + select(0u, 1u, f.y >= 0.5), max(dims.y, 1u) - 1u);', '')
			.replace('for (var i = 0u; i < 4u; i = i + 1u) {\n\t\tlet ox = i & 1u;\n\t\tlet oz = i >> 1u;',
				'for (var i = 0u; i < 8u; i = i + 1u) {\n\t\tlet ox = i & 1u;\n\t\tlet oy = (i >> 1u) & 1u;\n\t\tlet oz = (i >> 2u) & 1u;')
			.replace('mix(1.0 - f.x, f.x, f32(ox)) * mix(1.0 - f.z, f.z, f32(oz))',
				'mix(1.0 - f.x, f.x, f32(ox)) * mix(1.0 - f.y, f.y, f32(oy)) * mix(1.0 - f.z, f.z, f32(oz))')
			.replace('vec3<u32>(base.x + ox, by, base.z + oz)', 'base + vec3<u32>(ox, oy, oz)')
			.replace('let upperSky = irradiance;',
				'let upperSky = probeIrradiance(vin.worldPos, vec3<f32>(0.0, 1.0, 0.0)) * frame.params.w * frame.post.w;')
	}
	return code
}

export function specializeTaaWgsl(source: string, quality: RenderQuality): string {
	let code = quality.taaNeighbourhood === 'full'
		? source.replace('if (x != 0 && y != 0) { continue; }', '')
		: source
	if (quality.taaStaticFeedback > 0.9) {
		// Previous-pose velocity from the skinned prepass keeps moving limbs out of
		// this branch. A nearly-zero threshold avoids classifying slow motion as still.
		// Ground just behind a walking soldier has zero velocity of its own but still
		// holds soldier-coloured history, so the test takes the fastest motion in a 5x5
		// footprint (3x3 taps at stride 2). The (2,2) no-velocity marker counts as moving.
		code = code.replace('let feedback = frame.post.z;', `let velocityPx = velocity * vec2<f32>(dims);
	var stillMotion2 = dot(velocityPx, velocityPx);
	for (var stillY = -1; stillY <= 1; stillY = stillY + 1) {
		for (var stillX = -1; stillX <= 1; stillX = stillX + 1) {
			if (stillX == 0 && stillY == 0) { continue; }
			let stillQ = clamp(px + vec2<i32>(stillX, stillY) * 2, vec2<i32>(0), dims - vec2<i32>(1));
			let stillV = textureLoad(velocityTex, stillQ, 0).xy * vec2<f32>(dims);
			stillMotion2 = max(stillMotion2, dot(stillV, stillV));
		}
	}
	let still = stillMotion2 < 0.0025;
	let feedback = select(frame.post.z, ${quality.taaStaticFeedback.toFixed(2)}, still && frame.post.z > 0.0);`)
	}
	return code
}
