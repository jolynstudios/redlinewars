// STEELSEED — render/frame
// The per-frame uniform block. The WGSL declaration and the CPU-side float offsets live
// in the same file on purpose: they are two spellings of one layout, and ARCHITECTURE.md
// §3.1 records exactly what it costs when two spellings of one contract drift apart.
//
// Offsets are in FLOATS. Every vec4/mat4 is 16-byte aligned by construction, so the
// std140-style uniform rules are satisfied without a single explicit pad member.

/** Cascade count is fixed at the maximum (§7 high preset) so the struct never changes size. */
export const MAX_CASCADES = 4

export const F_VIEW = 0
export const F_PROJ = 16
export const F_VIEWPROJ = 32
export const F_INV_VIEWPROJ = 48
export const F_PREV_VIEWPROJ = 64
export const F_CASCADE_VP = 80
export const F_CAMERA = 144
export const F_SUN_DIR = 148
export const F_SUN_COLOR = 152
export const F_SKY_COLOR = 156
export const F_SCREEN = 160
export const F_CLUSTER_DIMS = 164
export const F_CLUSTER_EXTRA = 168
export const F_CLUSTER_Z = 172
export const F_CASCADE_SPLITS = 176
export const F_CASCADE_TEXEL = 180
export const F_PARAMS = 184
export const F_POST = 188
export const F_JITTER = 192
export const F_PROBE_ORIGIN = 196
export const F_PROBE_DIMS = 200
export const F_DEBUG = 204
// --- §12.2 sky, pushed whole by setEnvironment ---
export const F_HORIZON_COLOR = 208
export const F_GROUND_RADIANCE = 212
export const F_MOON_DIR = 216
export const F_MOON_COLOR = 220
export const F_AERIAL_COLOR = 224
export const F_CLOUD = 228
export const F_CLOUD_DRIFT = 232
export const F_SKY_SEED = 236
/** Shroud world origin xz, then inverse grid width/height. */
export const F_SHROUD = 240
export const F_WEATHER = 244
export const F_SURFACE_WEATHER = 248
/** Depth of the scenery ring outside the playable rectangle, in render metres. */
export const F_EDGE = 252
export const FRAME_FLOATS = 256
export const FRAME_BYTES = FRAME_FLOATS * 4

/**
 * §5.6 debug views. The forward shader writes the selected quantity to the HDR target
 * instead of the shaded result.
 *
 * Single target, no MRT: visualising an AOV does not require materialising one. Adding
 * five extra render attachments would cost bandwidth on every ordinary frame purely to
 * serve a debug path that is off by default.
 *
 * Kept in sync with DEBUG_VIEW_NAMES below and with the `switch` in FORWARD_WGSL.
 */
export const DebugView = {
	off: 0,
	albedo: 1,
	normal: 2,
	roughness: 3,
	metalness: 4,
	ao: 5,
	/** Lambert term only — the sun's geometric contribution, unshadowed. */
	nDotL: 6,
	/** Cascaded shadow visibility, 0 shadowed to 1 lit. */
	sunVisibility: 7,
	/** Which cascade a fragment sampled, as a flat colour per cascade. */
	cascade: 8,
	/** Froxel light count, normalised against the per-cluster budget. */
	lightCount: 9,
	/** Probe volume irradiance alone — the "is the GI real" view (§5.6). */
	giOnly: 10,
	/** Sun contribution alone, shadowed. Pairs with giOnly to split the lighting. */
	sunOnly: 11,
	/** Material zone / array layer index, to catch clamp-vs-wrap errors (§12.5). */
	layer: 12,
	/** Player-colour mask channel (§9). */
	mask: 13,
	/** Geometric normal, before the normal map. Isolates rig/mesh normal errors. */
	geoNormal: 14,
	/** Functional unit status emission alone, before aerial perspective and tonemapping. */
	emissive: 15,
	/** Quarter-resolution emissive-key bloom alone, after TAA and before display mapping. */
	bloom: 16,
} as const

export type DebugViewName = keyof typeof DebugView

export const DEBUG_VIEW_NAMES: readonly DebugViewName[] = Object.keys(DebugView) as DebugViewName[]

/**
 * The uniform block, mirrored on the CPU by the offsets above.
 *
 * `viewProj` is the JITTERED matrix — TAA's subpixel offset is folded into it so that
 * every pass rasterises to the same sample position. `invViewProj` inverts the
 * UNJITTERED matrix, as does the previous frame's `prevViewProj`: temporal history
 * stays in unjittered screen space. Passes reconstructing a jittered depth pixel
 * with `invViewProj` must first subtract `frame.jitter` from its NDC position.
 * Culling and picking use `RenderApi.camera`, which is never jittered.
 */
export const FRAME_WGSL = /* wgsl */ `
struct Frame {
	view          : mat4x4<f32>,
	proj          : mat4x4<f32>,
	viewProj      : mat4x4<f32>,
	invViewProj   : mat4x4<f32>,
	prevViewProj  : mat4x4<f32>,
	cascadeVP     : array<mat4x4<f32>, 4>,
	// xyz camera world position, w near plane
	cameraPos     : vec4<f32>,
	// xyz unit vector TOWARDS the sun, w unused
	sunDirection  : vec4<f32>,
	// rgb sun colour, a irradiance scale
	sunColor      : vec4<f32>,
	// rgb zenith radiance, a ground albedo for the bounce term
	skyColor      : vec4<f32>,
	// w, h, 1/w, 1/h of the internal render target
	screen        : vec4<f32>,
	// tilesX, tilesY, sliceCount, activeLightCount
	clusterDims   : vec4<u32>,
	// lightsPerCluster, cascadeCount, frameIndex, probeUpdateStart
	clusterExtra  : vec4<u32>,
	// froxel near, froxel far, log scale, log bias
	clusterZ      : vec4<f32>,
	// view-space far distance of each cascade
	cascadeSplits : vec4<f32>,
	// world-space size of one shadow texel in each cascade
	cascadeTexel  : vec4<f32>,
	// elapsed seconds, dt seconds, shadow map resolution, ambient scale
	params        : vec4<f32>,
	// exposure bias EV, sharpen amount, taa feedback, probe diffuse scale
	post          : vec4<f32>,
	// current jitter xy in pixels, previous jitter xy in pixels
	jitter        : vec4<f32>,
	// xyz probe volume origin (corner), w probe spacing in metres
	probeOrigin   : vec4<f32>,
	// probe counts x, y, z, probe updates this frame
	probeDims     : vec4<u32>,
	// x = DebugView mode (0 = off), yzw reserved
	debug         : vec4<u32>,

	// The §12.2 atmosphere. Sky computes every value here; nothing in this renderer
	// derives one of them from another. horizonColor in particular is NOT skyColor times
	// a constant — at twilight the horizon is warm while the zenith stays blue, and that
	// difference is the entire visual signature of dawn.

	// rgb horizon radiance, a aerial extinction per metre
	horizonColor  : vec4<f32>,
	// rgb radiance leaving the ground (already albedo-weighted), a moon intensity
	groundRadiance: vec4<f32>,
	// xyz unit vector TOWARDS the moon, w unused
	moonDirection : vec4<f32>,
	// rgb moon colour, a unused
	moonColor     : vec4<f32>,
	// rgb colour distant geometry tends towards, a unused
	aerialColor   : vec4<f32>,
	// coverage, opacity, spatial scale, unused
	cloud         : vec4<f32>,
	// cloud drift x, cloud drift z, unused, unused — metres
	cloudDrift    : vec4<f32>,
	// x cloud seed, yzw reserved. A u32 so the seed survives past 2^24 unrounded.
	skySeed       : vec4<u32>, // w: room emission night factor, UNORM16; unflashed sky radiance
	// world origin xz, then inverse grid width/height
	shroud        : vec4<f32>,
	// wind direction xz, strength, rain intensity
	weather       : vec4<f32>,
	// retained wetness, accumulated snow coverage, simulation presentation seconds, lightning
	surfaceWeather: vec4<f32>,
	// x depth of the scenery ring outside the playable rectangle in metres; yz world position
	// of cell (0,0) of the per-pixel ground blend's cell-layer map; w 1 once that map is live.
	//
	// The world edge is expressed as FRACTIONS of this rather than as absolute metres,
	// because the ring is 24/32/40/48 cells deep by quality preset and an absolute band
	// encodes exactly one of those. See EDGE_FOG_WGSL in shaders.ts for the fractions and
	// for what the absolute band measured on each preset before this field existed.
	edge          : vec4<f32>,
}
`

/**
 * Halton(2,3), the standard TAA jitter sequence. Precomputed rather than generated per
 * frame: it must be identical run to run for `baseline.mjs` to be a usable gate (§5.2),
 * and a table cannot drift the way a loop with a float accumulator can.
 */
export const JITTER_COUNT = 8
export const JITTER_TABLE = Float32Array.of(
	0.5 - 0.5, 0.5 - 0.33333333,
	0.25 - 0.5, 0.66666667 - 0.33333333,
	0.75 - 0.5, 0.11111111 - 0.33333333,
	0.125 - 0.5, 0.44444444 - 0.33333333,
	0.625 - 0.5, 0.77777778 - 0.33333333,
	0.375 - 0.5, 0.22222222 - 0.33333333,
	0.875 - 0.5, 0.55555556 - 0.33333333,
	0.0625 - 0.5, 0.88888889 - 0.33333333,
)
