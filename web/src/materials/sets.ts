// STEELSEED — materials/sets
// The surface-set table: what the forge is asked to make, and the physical constants
// that make each one a material rather than a colour.
//
// Two things here are contract, not taste:
//
// `tileMeters` is the world distance one tile of the set spans, and it is what makes
// ARCHITECTURE.md §9's "detail resolves at 0.5 m" checkable rather than a slogan. A 4 m
// tile at 512 texels puts a texel at 7.8 mm and a half-metre feature at 64 texels across,
// so the fbm octaves that carry the half-metre band (8 and 16 repeats per tile) are well
// inside the mip chain's Nyquist and survive to the coarse levels.
//
// `heightScale` is a real distance in metres — the peak-to-peak relief of the surface.
// The forge differentiates the height field in metres per metre to get the normal, so
// this number is not a look knob: getting it wrong makes the lighting wrong. 30 mm of
// plate relief and 550 mm of rock face have to be told apart by something, and this is it.
//
// Albedo values are LINEAR reflectance and stay inside 0.02..0.9 (§7). Metal tints are
// the metal's F0 — steel near 0.56, oxidised aluminium near 0.46 — because the forge
// writes metalness as a hard 0 or 1 and a metal's albedo channel carries its reflectance.

import { Surface } from '../core'

/** Must match the `switch (P.kind)` in wgsl-field.ts and wgsl-pack.ts exactly. */
export const SetKind = {
	soil: 0,
	rock: 1,
	sand: 2,
	gravel: 3,
	grass: 4,
	road: 5,
	metal: 6,
	concrete: 7,
	water: 8,
	shallow: 9,
	snow: 10,
	ash: 11,
	resource: 12,
	foundry: 13,
	lattice: 14,
	drift: 15,
} as const

export interface SurfaceSetDef {
	readonly id: string
	readonly kind: number
	/** World metres one tile spans. uv = worldXZ / tileMeters. */
	readonly tileMeters: number
	/** Peak-to-peak relief in metres. Drives the normal, the curvature and orm.a. */
	readonly heightScale: number
	/** fbm octaves for the set's dominant field. Fine detail is added separately. */
	readonly octaves: number
	/** Baseline age of the surface, 0 fresh, 1 derelict. Jittered per layer. */
	readonly wearBias: number
	/** Per-region albedo scatter. Keeps a tiling set from reading as one flat swatch. */
	readonly colorJitter: number
	/** Primary tint: rgb linear albedo, w the roughness that belongs with it. */
	readonly tintA: readonly [number, number, number, number]
	readonly tintB: readonly [number, number, number, number]
	readonly tintC: readonly [number, number, number, number]
	/**
	 * Per-layer material overrides, indexed by layer. A missing entry means no change.
	 *
	 * Layers began as pure VARIANTS — same material, different noise seed, there to break the
	 * tiling repeat across a large surface. For the terrain that is still all they are. For a
	 * UNIT set they now also carry `geo/zone`'s material zones, because §12.1 hands the shader
	 * one layer index per vertex and a unit is small enough that a visible tile repeat matters
	 * far less than a track that is made of rubber rather than of painted steel.
	 *
	 * `tintScale` multiplies all three tints' rgb, so a region darkens without inventing a
	 * second colour model. `roughAdd` is added to each tint's w, clamped.
	 */
	readonly layerMods?: readonly ({ tintScale?: number, roughAdd?: number } | undefined)[]
}

type SurfaceName = keyof typeof Surface
type Body = Omit<SurfaceSetDef, 'id'>

/**
 * One entry per §8 surface type. Typed as a full Record so a surface added to the enum
 * fails to compile here instead of silently producing a missing set at runtime — §8 is
 * explicit that a quietly absent case is a gate failure.
 */
const TERRAIN: Record<SurfaceName, Body> = {
	soil: {
		kind: SetKind.soil,
		tileMeters: 4,
		heightScale: 0.1,
		octaves: 7,
		wearBias: 0.0,
		colorJitter: 0.14,
		tintA: [0.153218, 0.114403, 0.07763, 0.93],
		tintB: [0.0873, 0.06693, 0.04947, 0.72],
		tintC: [0.135, 0.108, 0.076, 0.95],
	},
	rock: {
		kind: SetKind.rock,
		tileMeters: 4,
		heightScale: 0.55,
		octaves: 8,
		wearBias: 0.1,
		colorJitter: 0.1,
		tintA: [0.183124, 0.179636, 0.174404, 0.86],
		tintB: [0.182153, 0.107149, 0.064289, 0.78],
		tintC: [0.185, 0.18, 0.17, 0.62],
	},
	sand: {
		kind: SetKind.sand,
		tileMeters: 4,
		heightScale: 0.09,
		octaves: 6,
		wearBias: 0.0,
		colorJitter: 0.09,
		tintA: [0.3, 0.245, 0.165, 0.94],
		tintB: [0.13, 0.102, 0.068, 0.66],
		tintC: [0.07, 0.06, 0.052, 0.88],
	},
	gravel: {
		kind: SetKind.gravel,
		tileMeters: 4,
		heightScale: 0.14,
		octaves: 6,
		wearBias: 0.05,
		colorJitter: 0.18,
		tintA: [0.204229, 0.19969, 0.190614, 0.82],
		tintB: [0.122068, 0.119849, 0.11541, 0.74],
		tintC: [0.205, 0.188, 0.155, 0.96],
	},
	grass: {
		kind: SetKind.grass,
		tileMeters: 4,
		heightScale: 0.1,
		octaves: 6,
		wearBias: 0.0,
		colorJitter: 0.16,
		tintA: [0.118181, 0.195453, 0.070454, 0.78],
		tintB: [0.201847, 0.170308, 0.07317, 0.85],
		tintC: [0.062, 0.047, 0.033, 0.92],
	},
	road: {
		kind: SetKind.road,
		tileMeters: 4,
		heightScale: 0.045,
		octaves: 6,
		wearBias: 0.3,
		colorJitter: 0.07,
		tintA: [0.034, 0.034, 0.036, 0.88],
		tintB: [0.105, 0.102, 0.098, 0.8],
		tintC: [0.048, 0.048, 0.05, 0.42],
	},
	metal: {
		kind: SetKind.metal,
		tileMeters: 2,
		heightScale: 0.035,
		octaves: 5,
		wearBias: 0.25,
		colorJitter: 0.08,
		tintA: [0.135, 0.145, 0.14, 0.55],
		tintB: [0.56, 0.57, 0.58, 0.3],
		tintC: [0.115, 0.052, 0.026, 0.92],
	},
	concrete: {
		kind: SetKind.concrete,
		tileMeters: 4,
		heightScale: 0.05,
		octaves: 6,
		wearBias: 0.2,
		colorJitter: 0.06,
		tintA: [0.235, 0.23, 0.22, 0.87],
		tintB: [0.15, 0.146, 0.14, 0.8],
		tintC: [0.105, 0.103, 0.1, 0.93],
	},
	water: {
		kind: SetKind.water,
		tileMeters: 8,
		heightScale: 0.16,
		octaves: 5,
		wearBias: 0.0,
		colorJitter: 0.0,
		tintA: [0.021, 0.031, 0.035, 0.045],
		tintB: [0.32, 0.36, 0.37, 0.35],
		tintC: [0.05, 0.08, 0.09, 0.1],
	},
	shallow: {
		kind: SetKind.shallow,
		tileMeters: 8,
		heightScale: 0.13,
		octaves: 6,
		wearBias: 0.0,
		colorJitter: 0.11,
		tintA: [0.095, 0.085, 0.068, 0.55],
		tintB: [0.045, 0.082, 0.078, 0.1],
		tintC: [0.15, 0.135, 0.105, 0.72],
	},
	snow: {
		kind: SetKind.snow,
		tileMeters: 4,
		heightScale: 0.2,
		octaves: 7,
		wearBias: 0.15,
		colorJitter: 0.04,
		tintA: [0.82, 0.835, 0.86, 0.48],
		tintB: [0.48, 0.545, 0.68, 0.42],
		tintC: [0.3, 0.295, 0.29, 0.72],
	},
	ash: {
		kind: SetKind.ash,
		tileMeters: 4,
		heightScale: 0.08,
		octaves: 6,
		wearBias: 0.4,
		colorJitter: 0.1,
		tintA: [0.048, 0.046, 0.044, 0.95],
		tintB: [0.165, 0.16, 0.152, 0.97],
		tintC: [0.38, 0.12, 0.032, 0.7],
	},
	resource: {
		kind: SetKind.resource,
		tileMeters: 3,
		heightScale: 0.3,
		octaves: 6,
		wearBias: 0.0,
		colorJitter: 0.13,
		tintA: [0.4, 0.27, 0.058, 0.16],
		tintB: [0.085, 0.082, 0.078, 0.88],
		tintC: [0.66, 0.52, 0.24, 0.28],
	},
}

/**
 * The two factions and the neutral filler. §9 drives every number in these three: the
 * Foundry is warm ochre over steel with soot in the corners, the Lattice is weathered
 * galvanised grey and olive drab over bolted frames, and Drift is deliberately mismatched.
 *
 * §9.0 is a hard prohibition on science fiction. There is no cyan, no accent glow and no
 * pristine surface here. An earlier revision gave the Lattice a cyan third tint and
 * `wearBias: 0`, which read as printed composite with glowing traces — precisely the
 * aesthetic §9.0 forbids. art-direction-ok (naming the prohibition, not adopting it).
 * Both are corrected below: every faction weathers, and colour comes from real materials
 * (galvanised zinc, olive paint, sun-faded canvas, rust).
 */
const AUTHORED: readonly SurfaceSetDef[] = [
	{
		id: 'foundry',
		kind: SetKind.foundry,
		tileMeters: 2,
		heightScale: 0.05,
		octaves: 5,
		wearBias: 0.35,
		colorJitter: 0.07,
		// Raised 2026-08-05 on a MEASUREMENT, not a preference. tools/unitlook measured
		// unit-vs-ground Weber contrast at +0.0939 with mean unit rgb(71,75,81) against
		// ground rgb(73,72,74) — units and terrain sharing one value range, separated almost
		// entirely by chroma. §9.1 requires "distinguishable by silhouette alone, IN
		// MONOCHROME, at max zoom-out", and monochrome is exactly the channel that was not
		// working.
		//
		// The old base was a dark ochre at 0.33 and the soot term was 0.03 — near the §7
		// albedo floor, which reads as a hole rather than as a surface. §9.0 v2 asks for warm
		// graphite and gun-metal, and both are MID value.
		//
		// DESATURATED 2026-08-05, at constant luminance. The value above was the right
		// LUMINANCE and the wrong COLOUR: at [0.54, 0.40, 0.23] its red-to-blue ratio is
		// 2.35, which is a saturated ochre — sand camouflage, and read as exactly that in a
		// gameplay-zoom capture. The note above asks for warm graphite and gun-metal, and
		// ochre is neither; the chroma came along as a side effect of chasing value.
		//
		// Luminance is what §9.1's monochrome test actually measures, so it is held and only
		// the chroma is spent: 0.2126r + 0.7152g + 0.0722b is 0.41749 before and 0.41719
		// after, a change of 0.0003, while the red-to-blue ratio drops 2.35 -> 1.21. The
		// measured unit-vs-ground separation that drove the earlier raise is therefore
		// untouched, and the faction now reads as warm metal rather than as desert paint.
		//
		// This also restores the §9.1 v2 axis. Lattice carries identity in COOL greys; a
		// Foundry in saturated tan was contrasting with it by HUE, which is the one thing
		// that axis says must not carry the difference, because hue is exactly what
		// disappears in the monochrome test.
		tintA: [0.450, 0.412, 0.372, 0.62],
		tintB: [0.72, 0.725, 0.73, 0.34],
		tintC: [0.16, 0.148, 0.138, 0.94],
		// LAYER 1 IS THE RUNNING GEAR, per geo/zone. Track pads and tyres are rubber and
		// unpainted steel: much darker than the hull, and matte where the hull is service
		// paint. Scaling the set's own tints rather than authoring a second palette keeps the
		// faction reading as one machine — a tank whose tracks are a different colour FAMILY
		// looks assembled from two kits.
		layerMods: [undefined, { tintScale: 0.42, roughAdd: 0.22 }],
	},
	{
		id: 'lattice',
		kind: SetKind.lattice,
		tileMeters: 2,
		// Bolted plate and girder webs read deeper than the Foundry's cast housings.
		heightScale: 0.045,
		octaves: 5,
		// §9.0 v2 wear BAND, not a floor. Lowered from 0.28 because the ceiling now
		// prohibits the zinc bloom and joint rust this value was tuned to feed; what it
		// drives today is settled dust and decal fade. It is deliberately NOT zero — the
		// band's floor still stands, and a machine with no history reads as a render.
		wearBias: 0.13,
		colorJitter: 0.06,
		// Anodised pale alloy, olive accent panel, and composite infill. §9.1 v2 carries
		// Lattice identity in COOL greys against the Foundry's warm graphite, and in cool
		// indicator light — never in a hue shift over the whole unit, which is why the
		// separation still holds in monochrome.
		// Raised with the Foundry and for the same measured reason. The Lattice started
		// lighter, so it moves less — the goal is both factions clearing the terrain's value
		// range, not equalising them with each other.
		tintA: [0.71, 0.73, 0.75, 0.44],
		tintB: [0.42, 0.45, 0.37, 0.70],
		tintC: [0.63, 0.65, 0.67, 0.82],
		// Layer 1 is the running gear. The Lattice rides on tall rubber tyres and its pale
		// alloy is the brightest thing on the map, so the contrast here is larger than the
		// Foundry's — a light frame on black tyres is most of what the family reads as.
		layerMods: [undefined, { tintScale: 0.30, roughAdd: 0.26 }],
	},
	{
		id: 'drift',
		kind: SetKind.drift,
		tileMeters: 2.5,
		heightScale: 0.06,
		octaves: 6,
		wearBias: 0.6,
		colorJitter: 0.2,
		tintA: [0.4, 0.38, 0.33, 0.86],
		tintB: [0.47, 0.45, 0.43, 0.52],
		tintC: [0.125, 0.058, 0.026, 0.93],
	},
]

function terrainDefs(): SurfaceSetDef[] {
	const out: SurfaceSetDef[] = []
	// Emitted in §8 enum order rather than object order, so the table's identity does not
	// depend on how the literal above happens to be written.
	const byIndex: string[] = []
	for (const name of Object.keys(TERRAIN)) byIndex[Surface[name as SurfaceName]] = name
	for (const name of byIndex) out.push({ id: name, ...TERRAIN[name as SurfaceName] })
	return out
}

/** Every set the forge builds: 13 surface types (§8) plus the three authored sets. */
export const SET_DEFS: readonly SurfaceSetDef[] = [...terrainDefs(), ...AUTHORED]

/**
 * Integer lattice directions for per-layer anisotropy. A free rotation of the domain
 * would destroy the tiling, so brushing, ripples, strata and wheel bands vary between
 * layers by running along a different lattice direction instead.
 */
export const ANI_DIRS: readonly (readonly [number, number])[] = [
	[1, 0],
	[0, 1],
	[1, 1],
	[2, 1],
	[1, 2],
	[3, 1],
	[1, 3],
	[3, 2],
]
