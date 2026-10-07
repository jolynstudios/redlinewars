// STEELSEED — fx/weapon-fx
//
// The shapes, colours and particle vocabulary that make one weapon look like itself.
//
// WHAT WAS WRONG. `src/weapon-visual-manifest.json` carries 50 profiles across 11 families and
// every profile names a `muzzle.style`, a `tracer.style`, a `tracer.colorLinearRGB`, a
// `tracer.widthM`, a `tracer.lifetimeSeconds`, a `smoke` and an `impact`. Exactly ONE of those
// eight fields had a consumer: `muzzle.scaleM`. Every weapon in the game therefore drew the SAME
// muzzle flash shape and the SAME tracer primitive, separated only by size, and the size itself
// spanned a rifle to an eight-inch gun as one object scaled 18x. The human's report was exactly
// that: "a tank cannot have the same fire output as a rifle man, or grenadier".
//
// WHY THE COLOUR NEEDED A CHANNEL AND NOT A MESH. The obvious fix — one mesh per family, the way
// `fx/tesla-arc.ts` gives the bolt its own mesh with a cool `optic` zone — does not actually move
// the colour, and measuring that is what produced this file. The forward fragment picks the
// emitter with `surfaceEmitterColor(albedoSample.a)`, and that alpha is the material SET's
// emissive class, written once per set by `materials/wgsl-pack.ts` (`shadeFoundry` 0.25 warm,
// `shadeLattice` 0.75 cool). The material ZONE selects a texture LAYER inside the set, and the
// layer does not change the class. So the whole engine offered exactly two emitter colours, both
// keyed on a per-item constant, and the tesla bolt — which asks for cool by taking `Zone.optic`
// while its DrawItem names `surfaceSet: 'foundry'` — has been drawing WARM ORANGE the whole time.
//
// Two emitters cannot reach the authored spread either. Solving
// a*(6.45,2.04,0.30) + b*(1.328,1.384,1.526) for the machine gun's authored (1, 0.80, 0.40)
// overshoots red by 1.88x: the warm emitter is too red-dominant for a pale tracer to be mixed
// out of it, so no combination of the two sets produces a yellow. Colour therefore needs one new
// channel, and it needs to vary PER DRAW ITEM rather than per instance, because the manifest's
// colour is constant within a family — all eight cannons share (1, 0.52, 0.14). That is
// `DrawItem.emitterColor`: three floats, written into the instance tint with a negative alpha,
// which no existing instance can produce (`playerColorTable` alpha is a byte over 255) and which
// the fragment reads as "this item carries its own emitter".
//
// So: per-family MESHES carry the shape, and one per-item colour channel carries the hue. Meshes
// are the cheap half — they are uploaded once at boot and cost nothing per frame — and the colour
// channel is four floats already present in the instance record.
//
// NO PLATFORM RANDOM. Nothing here varies at runtime; every shape is authored and every colour is
// derived from the manifest by a pure function, so two machines draw the same shot.

import { Mesh } from '../geo/mesh'
import * as sdf from '../geo/sdf'
import { Zone, ZoneFlag, withZoneFlag } from '../geo/zone'
import manifest from '../weapon-visual-manifest.json'
import type { WeaponVisualStyle } from './weapon-visuals'

/**
 * Drawing families. The manifest's eleven collapse to nine here: `melee`, `heal` and `utility`
 * author no tracer, no flash and no impact, so they share one inert row rather than three
 * identical ones, and `unknown` degrades onto it too.
 */
export const FxFamily = {
	bullet: 0,
	mg: 1,
	cannon: 2,
	artillery: 3,
	rocket: 4,
	torpedo: 5,
	electric: 6,
	flame: 7,
	inert: 8,
} as const
export const FAMILY_COUNT = 9

/** `muzzle.style` as a dense index. Order matches the manifest's vocabulary. */
export const MuzzleStyle = {
	none: 0,
	compact: 1,
	star: 2,
	cone: 3,
	heavy: 4,
	exhaust: 5,
	arc: 6,
	flame: 7,
} as const
export const MUZZLE_STYLE_COUNT = 8

/** `tracer.style` as a dense index. */
export const TracerStyle = {
	none: 0,
	line: 1,
	streak: 2,
	exhaust: 3,
	wake: 4,
	arc: 5,
	flame: 6,
} as const
export const TRACER_STYLE_COUNT = 7

/** `smoke` as a dense index. */
const SmokeKind = { none: 0, faint: 1, puff: 2, plume: 3, trail: 4, soot: 5 } as const
export const SMOKE_KIND_COUNT = 6

/** `impact` as a dense index. */
export const ImpactKind = {
	none: 0,
	chip: 1,
	spark: 2,
	shell: 3,
	'heavy-shell': 4,
	blast: 5,
	water: 6,
	electrical: 7,
	burn: 8,
	flak: 9,
} as const
export const IMPACT_KIND_COUNT = 10

// --- packed weapon code ------------------------------------------------------------------
//
// Five small vocabularies in one integer, so the per-frame path holds a Uint32 per live effect
// and never touches a string, a Map or the frozen profile object again. Twenty bits used.

const MUZZLE_SHIFT = 0
const TRACER_SHIFT = 4
const FAMILY_SHIFT = 8
const SMOKE_SHIFT = 12
const IMPACT_SHIFT = 16
const NIBBLE = 15

export function muzzleStyleOf(code: number): number { return (code >>> MUZZLE_SHIFT) & NIBBLE }
export function tracerStyleOf(code: number): number { return (code >>> TRACER_SHIFT) & NIBBLE }
export function familyOf(code: number): number { return (code >>> FAMILY_SHIFT) & NIBBLE }
export function smokeOf(code: number): number { return (code >>> SMOKE_SHIFT) & NIBBLE }
export function impactOf(code: number): number { return (code >>> IMPACT_SHIFT) & NIBBLE }

function familyIndexOf(family: string): number {
	switch (family) {
		case 'bullet': return FxFamily.bullet
		case 'mg': return FxFamily.mg
		case 'cannon': return FxFamily.cannon
		case 'artillery': return FxFamily.artillery
		case 'rocket': return FxFamily.rocket
		case 'torpedo': return FxFamily.torpedo
		case 'electric': return FxFamily.electric
		case 'flame': return FxFamily.flame
		// melee, heal, utility and unknown all draw nothing. §8's "a silently-doing-nothing
		// default is a gate failure" is satisfied by naming them rather than by falling through.
		default: return FxFamily.inert
	}
}

/**
 * Fold one authored profile into the packed code the draw path carries.
 *
 * Every vocabulary is looked up by name against an explicit table. A style the manifest grows
 * later resolves to `none` and draws nothing rather than silently taking slot 0 of whatever the
 * table happens to hold, which is how a renamed value would otherwise turn every rocket into a
 * rifle without any gate noticing.
 */
export function packWeaponCode(style: WeaponVisualStyle): number {
	const muzzle = (MuzzleStyle as Record<string, number>)[style.muzzle.style] ?? MuzzleStyle.none
	const tracer = (TracerStyle as Record<string, number>)[style.tracer.style] ?? TracerStyle.none
	const smoke = (SmokeKind as Record<string, number>)[style.smoke] ?? SmokeKind.none
	const impact = (ImpactKind as Record<string, number>)[style.impact] ?? ImpactKind.none
	return (muzzle << MUZZLE_SHIFT) | (tracer << TRACER_SHIFT) |
		(familyIndexOf(style.family) << FAMILY_SHIFT) |
		(smoke << SMOKE_SHIFT) | (impact << IMPACT_SHIFT)
}

/**
 * The one muzzle and tracer style each family actually draws, DERIVED FROM THE MANIFEST.
 *
 * A family is not a style — `bullet` holds three `compact` pistols and one silenced weapon that
 * authors `none`, and `artillery` holds two `heavy` guns beside a grenade, a depth charge and a
 * para-bomb that author nothing. But no family in the catalogue carries two DIFFERENT drawing
 * styles, and that is what makes one DrawItem per family enough: the mesh is shared by style and
 * the emitter colour is constant per family, so the pair is a fixed table rather than a per-shot
 * decision. A weapon whose own style is `none` still resolves to its family's item and is simply
 * never written into it.
 *
 * If the manifest ever does give one family two live styles this throws at boot, rather than
 * silently drawing half a family with the other half's mesh.
 */
export const FAMILY_MUZZLE_STYLE = new Uint8Array(FAMILY_COUNT)
export const FAMILY_TRACER_STYLE = new Uint8Array(FAMILY_COUNT)

/**
 * What an UNRESOLVED weapon draws.
 *
 * The host's shared string table can be absent — the dev fixture has no mod behind it, and a live
 * table can arrive a frame late. That is not an error and it must not be a blank screen, so a
 * nameless weapon keeps exactly what shipped before this file existed: the mid-weapon cone flash
 * and dart tracer, sized from damage, on the engine's own warm emitter with no item colour.
 */
export const FALLBACK_CODE =
	(MuzzleStyle.cone << MUZZLE_SHIFT) | (TracerStyle.streak << TRACER_SHIFT) |
	(FxFamily.inert << FAMILY_SHIFT) | (SmokeKind.puff << SMOKE_SHIFT) | (ImpactKind.shell << IMPACT_SHIFT)

// --- emitter colours ---------------------------------------------------------------------

/**
 * Peak channel each family's emitter is normalised to, in the same HDR units the shader's
 * built-in warm emitter uses.
 *
 * PEAK, not luminance, and that is a calibration rather than a preference. The shipped warm
 * emitter is (6.45, 2.04, 0.30) and `SURFACE_EMISSIVE_INTENSITY` is 0.85, so its red channel
 * lands at 5.48 — far above the tonemapper's shoulder, which is why every flash in the game
 * read as a white blob with an orange rim. Hue only survives the tonemapper if the brightest
 * channel stays near it, so the ceiling is set on that channel directly; normalising by
 * luminance instead let the flame family, whose authored colour is almost pure red, reach 7.9
 * and lose its colour on the way to the frame.
 *
 * These are the only taste numbers in this file, and they were MEASURED rather than chosen. The
 * display transform is AgX, which deliberately walks bright colour toward white, so an emitter
 * above the shoulder arrives as a white blob with a coloured rim however saturated it was. Three
 * settings were put through `weaponfamilygate`'s four-weapon frame and the on-screen chromaticity
 * distance between a rifleman's flash and a V2's launch was read off the emissive cores: peaks of
 * 3.2-5.4 gave 0.080, 1.45-2.45 gave 0.103 and cost the rifle two thirds of its pixels, and this
 * band gives 0.089 while keeping the rifle at 65 px against the V2's 3,027. The ORDER a player expects is kept throughout — a shell is brighter
 * than a rifle round, artillery brighter than a shell — and the hottest value here is 3.8 against
 * the 6.45 the engine's own warm emitter uses.
 */
const FAMILY_PEAK = new Float32Array(FAMILY_COUNT)
FAMILY_PEAK[FxFamily.bullet] = 2.30
FAMILY_PEAK[FxFamily.mg] = 2.45
FAMILY_PEAK[FxFamily.cannon] = 3.30
FAMILY_PEAK[FxFamily.artillery] = 3.70
FAMILY_PEAK[FxFamily.rocket] = 3.50
FAMILY_PEAK[FxFamily.torpedo] = 1.30
FAMILY_PEAK[FxFamily.electric] = 3.00
FAMILY_PEAK[FxFamily.flame] = 3.80
FAMILY_PEAK[FxFamily.inert] = 0

/**
 * Per-family HDR emitter colour, three floats each, DERIVED FROM THE MANIFEST.
 *
 * The hue is the authored `tracer.colorLinearRGB` exactly — it is scaled to the family radiance
 * above and never re-authored here, so the drawn colour cannot drift from the catalogue. Reading
 * the profiles rather than copying eight triples is the whole point: if someone retunes a cannon
 * in the manifest, the flash, the tracer and the bloom key all move with it, and if a family's
 * profiles ever disagree about colour this module throws at boot instead of picking one silently.
 */
export const EMITTER_RGB = new Float32Array(FAMILY_COUNT * 3)
{
	const seen = new Int8Array(FAMILY_COUNT)
	FAMILY_MUZZLE_STYLE[FxFamily.inert] = MuzzleStyle.cone
	FAMILY_TRACER_STYLE[FxFamily.inert] = TracerStyle.streak
	for (const profile of manifest.profiles) {
		const style = profile.style as WeaponVisualStyle
		const family = familyIndexOf(style.family)
		if (family === FxFamily.inert) continue
		const code = packWeaponCode(style)
		const muzzle = muzzleStyleOf(code)
		const tracer = tracerStyleOf(code)
		if (muzzle !== MuzzleStyle.none) {
			if (FAMILY_MUZZLE_STYLE[family] !== MuzzleStyle.none && FAMILY_MUZZLE_STYLE[family] !== muzzle)
				throw new Error(`fx/weapon-fx: family ${style.family} authors two muzzle styles`)
			FAMILY_MUZZLE_STYLE[family] = muzzle
		}
		if (tracer !== TracerStyle.none) {
			if (FAMILY_TRACER_STYLE[family] !== TracerStyle.none && FAMILY_TRACER_STYLE[family] !== tracer)
				throw new Error(`fx/weapon-fx: family ${style.family} authors two tracer styles`)
			FAMILY_TRACER_STYLE[family] = tracer
		}
		const c = style.tracer.colorLinearRGB
		if (c.length !== 3) throw new Error('fx/weapon-fx: a profile colour is not a triple')
		const o = family * 3
		if (seen[family] === 0) {
			seen[family] = 1
			EMITTER_RGB[o] = c[0]; EMITTER_RGB[o + 1] = c[1]; EMITTER_RGB[o + 2] = c[2]
		} else if (
			Math.abs(EMITTER_RGB[o] - c[0]) > 1e-6 ||
			Math.abs(EMITTER_RGB[o + 1] - c[1]) > 1e-6 ||
			Math.abs(EMITTER_RGB[o + 2] - c[2]) > 1e-6
		) throw new Error(`fx/weapon-fx: family ${style.family} authors more than one tracer colour`)
	}
	for (let family = 0; family < FAMILY_COUNT; family++) {
		const o = family * 3
		const peak = Math.max(EMITTER_RGB[o], Math.max(EMITTER_RGB[o + 1], EMITTER_RGB[o + 2]))
		// A family the manifest never mentions, or one authored black, stays black and is never
		// submitted. Dividing by its zero peak would publish NaN into an instance buffer.
		const gain = peak > 1e-6 ? FAMILY_PEAK[family] / peak : 0
		EMITTER_RGB[o] *= gain; EMITTER_RGB[o + 1] *= gain; EMITTER_RGB[o + 2] *= gain
	}
}

// --- per-style presentation constants -----------------------------------------------------

/**
 * How long a flash of each style stays lit.
 *
 * This was one 90 ms constant for everything. Duration is half of what separates a weapon at a
 * glance: a rifle's flash is gone before the eye resolves it, a rocket's efflux is still burning
 * when the missile is a body-length away, and a flamethrower's tongue is continuous. The values
 * are frames at 60 Hz — 3, 3.3, 5.4, 8.4, 15.6, 4.8, 12 — so none of them is a single frame that
 * a dropped frame could erase entirely.
 */
export const MUZZLE_LIFETIME_S = new Float32Array(MUZZLE_STYLE_COUNT)
MUZZLE_LIFETIME_S[MuzzleStyle.none] = 0
MUZZLE_LIFETIME_S[MuzzleStyle.compact] = 0.050
MUZZLE_LIFETIME_S[MuzzleStyle.star] = 0.055
MUZZLE_LIFETIME_S[MuzzleStyle.cone] = 0.090
MUZZLE_LIFETIME_S[MuzzleStyle.heavy] = 0.140
MUZZLE_LIFETIME_S[MuzzleStyle.exhaust] = 0.260
MUZZLE_LIFETIME_S[MuzzleStyle.arc] = 0.080
MUZZLE_LIFETIME_S[MuzzleStyle.flame] = 0.200

/** The longest of the above. The retain/evict scan needs one bound, not a per-record branch. */
export const MUZZLE_MAX_LIFETIME_S = 0.260

/**
 * Fraction of the muzzle-to-impact path the drawn streak covers, per tracer style.
 *
 * A bullet is a short dash walking the path; a shell is a longer dart; a rocket's `exhaust` is
 * the residue the flight left behind and therefore spans the WHOLE path, thinning towards the
 * target; a torpedo's wake likewise persists. Drawing every one of them as the same 22% dash is
 * what made a tank round and a rifle round indistinguishable once the flash had gone.
 */
export const TRACER_STREAK_FRACTION = new Float32Array(TRACER_STYLE_COUNT)
TRACER_STREAK_FRACTION[TracerStyle.none] = 0
TRACER_STREAK_FRACTION[TracerStyle.line] = 0.18
TRACER_STREAK_FRACTION[TracerStyle.streak] = 0.34
TRACER_STREAK_FRACTION[TracerStyle.exhaust] = 1.00
TRACER_STREAK_FRACTION[TracerStyle.wake] = 0.80
TRACER_STREAK_FRACTION[TracerStyle.arc] = 0
TRACER_STREAK_FRACTION[TracerStyle.flame] = 0.40

/** Metres the streak is capped at, per style, so a long shot does not become a beam. */
export const TRACER_STREAK_MAX_M = new Float32Array(TRACER_STYLE_COUNT)
TRACER_STREAK_MAX_M[TracerStyle.none] = 0
TRACER_STREAK_MAX_M[TracerStyle.line] = 3.5
TRACER_STREAK_MAX_M[TracerStyle.streak] = 6.0
TRACER_STREAK_MAX_M[TracerStyle.exhaust] = 40
TRACER_STREAK_MAX_M[TracerStyle.wake] = 40
TRACER_STREAK_MAX_M[TracerStyle.arc] = 0
TRACER_STREAK_MAX_M[TracerStyle.flame] = 4.0

// --- particle vocabulary ------------------------------------------------------------------
//
// The manifest's `smoke` and `impact` words become real emissions here. Before this, every fire
// spawned the 12-particle `smoke` preset — 3.8 s of life apiece — and every impact spawned
// `dust` plus, above a damage threshold, `fire`. A rifleman therefore held 45.6 particle-seconds
// of barrel smoke per round out of a 2048-slot pool shared with every explosion on the map, and
// a rifle, a tank and a rocket all left the identical grey ball behind.
//
// Naming the emission per weapon is cheaper than the constant was, not more expensive: the same
// rifle round now holds 1.9 particle-seconds. See the budget note in `fx/index.ts`.

/** Muzzle emission preset per `smoke` word, or the empty string for "leaves nothing". */
export const SMOKE_PRESET: readonly string[] = [
	'',            // none    — a beam, a bite, a medic's kit
	'gunsmoke',    // faint   — small arms: one wisp, gone in half a second
	'barrelsmoke', // puff    — a tank gun clearing its bore
	'launchsmoke', // plume   — artillery: the largest muzzle cloud on the field
	'launchsmoke', // trail   — a rocket's launch cloud; the FLIGHT trail is fx/projectiles
	'soot',        // soot    — a flamethrower's unburnt fuel
]
export const SMOKE_SCALE = Float32Array.of(0, 0.10, 0.24, 0.52, 0.34, 0.28)
/** The `trail` word, named so `fx/index.ts` can ask "does this weapon leave a flight trail?". */
export const SMOKE_TRAIL = SmokeKind.trail

/**
 * Impact emission, up to three presets per `impact` word.
 *
 * Three slots is the measured ceiling of the vocabulary rather than a round number: a shell
 * strike wants earth, flame and fragments and nothing here wants a fourth. An empty string ends
 * the list for that word.
 */
export const IMPACT_PRESETS: readonly (readonly string[])[] = [
	[],                                   // none        — melee, heal, utility
	['chip'],                             // chip        — a bullet taking a flake off
	['spark'],                            // spark       — an autocannon round off armour
	['dust', 'blastcore'],                // shell
	['dust', 'blastcore', 'frag'],        // heavy-shell
	['fireball', 'blastcore', 'barrelsmoke'], // blast
	['splash'],                           // water
	['zapspark'],                         // electrical
	['blastcore', 'soot'],                // burn
	['flakpuff', 'spark'],                // flak
]
export const IMPACT_SCALE = Float32Array.of(0, 0.5, 0.7, 1.0, 1.35, 1.15, 1.0, 0.8, 0.9, 0.85)

/**
 * How big one weapon's strike is, relative to a 105mm shell (1.0), from what the catalogue
 * AUTHORS rather than from damage.
 *
 * Impacts used to be sized `0.3 + min(2, sqrt(damage) * 0.07)`. Red Alert's damage runs to
 * thousands, so every tank round saturated at the ceiling. A 25mm hit drew the same
 * two-metre glowing haze as a 105mm one, and a pistol round sat at more than half of it.
 * Damage is a balance number; the catalogue already says how big each weapon is:
 *   - gunfire and shells: the authored muzzle envelope (`muzzle.scaleM`, 0.07 for a pistol
 *     to 1.25 for an 8-inch gun);
 *   - missiles: the launcher's exhaust says nothing about the warhead, so the authored trail
 *     width (0.022 for a RedEye to 0.18 for a V2);
 *   - weapons with no muzzle at all (a thrown grenade, a bomb, a depth charge, a torpedo): by
 *     what their impact word describes.
 */
export function impactSizeOf(style: WeaponVisualStyle): number {
	switch (style.family) {
		case 'rocket': return Math.min(1.6, 0.6 + style.tracer.widthM * 5)
		case 'torpedo': return 1.2
		case 'electric': return 0.6
		case 'flame': return Math.min(1.2, 0.6 + style.muzzle.scaleM)
	}
	if (style.muzzle.scaleM > 0) return Math.min(1.8, Math.max(0.12, style.muzzle.scaleM / 0.7))
	switch (style.impact) {
		case 'heavy-shell': return 1.6
		case 'blast': return 0.8
		case 'water': return 1.2
		case 'burn': return 0.7
		default: return 0.5
	}
}

/**
 * What a strike into water throws, whatever the weapon says.
 *
 * The impact payload's surface byte is the only authority on what was hit, and a shell landing
 * in a lake throws water rather than earth. Naming the override here keeps the one place a
 * surface outranks the catalogue explicit instead of buried in a conditional.
 */
export const WATER_IMPACT: readonly string[] = ['splash']

/**
 * The ceiling this vocabulary is allowed to ask of the shared 2048-slot particle pool.
 *
 * `heavy-shell` is the worst impact — dust 8 + blastcore 3 + frag 6 — and `plume`/`trail`/`soot`
 * the worst muzzle emissions at 3. They are constants rather than prose because
 * `weaponfamilygate` asserts the tables against them, so a preset grown later either stays
 * inside the stated budget or turns a gate red instead of quietly eating the pool.
 */
export const MAX_IMPACT_PARTICLES = 17
export const MAX_MUZZLE_PARTICLES = 3

// The vocabularies and their tables must stay the same length. A word added to the manifest
// without a preset beside it would otherwise resolve to `undefined` and spawn nothing, silently.
if (SMOKE_PRESET.length !== SMOKE_KIND_COUNT || SMOKE_SCALE.length !== SMOKE_KIND_COUNT)
	throw new Error('fx/weapon-fx: the smoke vocabulary and its preset table disagree')
if (IMPACT_PRESETS.length !== IMPACT_KIND_COUNT || IMPACT_SCALE.length !== IMPACT_KIND_COUNT)
	throw new Error('fx/weapon-fx: the impact vocabulary and its preset table disagree')

// --- meshes -------------------------------------------------------------------------------
//
// All muzzle shapes are authored along local +X, which is the barrel direction the fire event's
// facing supplies, with the origin AT the muzzle. All tracer shapes run 0..1 along local +X so
// the instance's scaleX is the drawn streak length in metres.
//
// Every axial primitive in geo/sdf stands along Z, so `rotateY(shape, PI/2)` is what aims one
// down the barrel. `rotateZ` on the same primitive is the no-op that geo/sdf documents.

const AIM = Math.PI / 2
const EMISSIVE_HULL = withZoneFlag(Zone.hull, ZoneFlag.emissive)

/**
 * Nominal forward reach of each muzzle shape, in mesh units.
 *
 * `muzzle.scaleM` multiplies it, so this is what turns an authored 0.6 into drawn metres. The
 * `cone` value is pinned at the shipped flash's 0.76 so a tank's flash is exactly the size it
 * was before this change and only its SHAPE moved; every other style is free.
 */
export const MUZZLE_NOMINAL_LENGTH = Float32Array.of(0, 0.57, 0.66, 0.78, 1.08, 1.27, 0.38, 1.28)

/**\n * The WIDEST cross-section radius each tracer mesh was built with, so a wanted world radius\n * becomes a plain instance ratio. Not the drawn size: see buildTracerMesh.\n */
export const TRACER_NOMINAL_R = Float32Array.of(0, 0.150, 0.201, 0.305, 0.238, 0, 0.321)

/**
 * Mesh one authored tree, sized by its own thinnest feature rather than by a magic resolution.
 *
 * `surfaceNets` takes a cell count over the LONGEST axis and makes the cell isotropic, so a
 * resolution that suits a compact flash silently deletes a thin tracer: the grid straddles the
 * capsule, every sample reads positive, and the mesher returns nothing at all. Passing the
 * smallest radius in the tree makes the cell no larger than that radius, which guarantees a grid
 * point inside it — the worst-case distance from a cell corner to the axis is 0.707 cells — and
 * costs nothing on a long thin shape, because the two short axes get their own small cell counts.
 *
 * The bounds come from the tree rather than from hand-written numbers, so a shape edited later
 * cannot silently lose a tongue to a stale AABB, which is a defect this project has shipped.
 */
function meshed(shape: sdf.Sdf, minFeatureM: number, label: string): Mesh {
	const mesh = new Mesh()
	const bounds = sdf.expandAabb(sdf.sdfAabb(shape, sdf.aabb()), minFeatureM * 1.5)
	const longest = Math.max(
		bounds.max[0] - bounds.min[0],
		Math.max(bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]),
	)
	const resolution = Math.min(240, Math.max(12, Math.ceil(longest / minFeatureM)))
	sdf.surfaceNets(shape, bounds, resolution, mesh, { creaseAngle: 34, seal: true })
	if (mesh.vertexCount === 0) throw new Error(`fx/weapon-fx: ${label} meshed to zero vertices`)
	for (let vertex = 0; vertex < mesh.vertexCount; vertex++) mesh.setZone(vertex, EMISSIVE_HULL)
	return mesh
}

/**
 * Build the flash for one muzzle style, or null when the style draws nothing.
 *
 * Each is asymmetric about the barrel on purpose, as the shipped single flash was: a symmetric
 * star cannot reveal a reversed yaw and a cardinal fixture cannot distinguish the two signs.
 *
 * Feature radii are deliberately generous. These are transient objects a few dozen pixels across
 * and each one is drawn once per shot, so a 6,000-triangle flash buys nothing the eye can see and
 * costs a real draw; every shape below stays under about 1,500 triangles.
 */
export function buildMuzzleMesh(style: number): Mesh | null {
	switch (style) {
		case MuzzleStyle.compact:
			// A rifle. One tight point and a short spike — the whole thing is 5 cm at the
			// authored 0.12, which is a seventh of the soldier's 0.363 m stature rather than
			// the flash that used to be drawn longer than the man holding it.
			return meshed(sdf.union(
				sdf.sphere(0.115),
				sdf.capsule(0.02, 0, 0, 0.40, 0, 0, 0.045),
				sdf.capsule(0.04, 0, 0, 0.19, 0.10, 0.05, 0.035),
			), 0.042, 'compact muzzle flash')

		case MuzzleStyle.star:
			// A machine gun. Five short tongues fanning off one core: the eye reads the radial
			// spread as a rapid, repeating weapon even when a single frame is all it gets.
			return meshed(sdf.union(
				sdf.sphere(0.105),
				sdf.capsule(0.01, 0, 0, 0.50, 0, 0, 0.042),
				sdf.capsule(0.01, 0, 0, 0.34, 0.26, 0.06, 0.036),
				sdf.capsule(0.01, 0, 0, 0.31, -0.22, 0.15, 0.034),
				sdf.capsule(0.01, 0, 0, 0.29, 0.09, -0.27, 0.033),
				sdf.capsule(0.01, 0, 0, 0.26, -0.13, -0.21, 0.032),
			), 0.045, 'star muzzle flash')

		case MuzzleStyle.cone:
			// A tank gun. A broad forward cone plus the shock ring the propellant gas throws off
			// the muzzle brake — the ring is the single most recognisable thing about a tank
			// firing, and it is what a scaled rifle flash can never produce.
			return meshed(sdf.union(
				sdf.sphere(0.155),
				sdf.translate(sdf.rotateY(sdf.cappedCone(0.075, 0.28, 0.30), AIM), 0.32, 0, 0),
				sdf.translate(sdf.rotateY(sdf.torus(0.30, 0.055), AIM), 0.50, 0, 0),
				// One off-axis tongue, so a yaw or sign error is measurable from any view.
				sdf.capsule(0.06, 0.01, 0, 0.44, 0.21, 0.12, 0.055),
			), 0.062, 'cone muzzle flash')

		case MuzzleStyle.heavy:
			// Artillery and the eight-inch gun. The same cone grown, TWO rings, and a lateral
			// blast skirt at the muzzle where the gas actually vents. Nominal 1.05 against the
			// cone's 0.76, and it carries the 155 mm's authored 1.0 straight into metres.
			return meshed(sdf.union(
				sdf.sphere(0.20),
				sdf.translate(sdf.rotateY(sdf.cappedCone(0.10, 0.36, 0.42), AIM), 0.42, 0, 0),
				sdf.translate(sdf.rotateY(sdf.torus(0.34, 0.070), AIM), 0.46, 0, 0),
				sdf.translate(sdf.rotateY(sdf.torus(0.47, 0.062), AIM), 0.80, 0, 0),
				// The skirt: flattened across the barrel, so it reads as gas venting sideways
				// rather than as a second ball on the axis.
				sdf.elongate(sdf.sphere(0.11), 0, 0.24, 0.09),
				sdf.capsule(0.08, 0.02, 0, 0.62, 0.30, 0.17, 0.070),
			), 0.085, 'heavy muzzle flash')

		case MuzzleStyle.exhaust:
			// A rocket. The launch signature is efflux out of the BACK of the tube, so the shape
			// lives almost entirely behind the fire point — a flash at negative X is instantly
			// not a gun, at any zoom, in any single frame.
			return meshed(sdf.union(
				sdf.sphere(0.085),
				sdf.translate(sdf.rotateY(sdf.cappedCone(0.245, 0.055, 0.46), AIM), -0.44, 0, 0),
				sdf.translate(sdf.sphere(0.20), -0.86, 0.03, 0),
				sdf.capsule(0, 0, 0, 0.14, 0.02, 0, 0.06),
				sdf.capsule(-0.30, 0, 0, -0.62, 0.20, 0.13, 0.06),
			), 0.075, 'exhaust muzzle flash')

		case MuzzleStyle.arc:
			// The coil's discharge at the emitter, not the bolt — `fx/tesla-arc.ts` owns the bolt
			// and this file never builds one. A crown of short radial spikes around the axis,
			// which with the cool emitter colour reads as electrical rather than as burning gas.
			return meshed(sdf.union(
				sdf.sphere(0.10),
				sdf.capsule(0, 0, 0, 0.20, 0, 0, 0.038),
				sdf.capsule(0.02, 0, 0, 0.16, 0.30, 0.04, 0.030),
				sdf.capsule(0.02, 0, 0, 0.14, -0.24, 0.18, 0.029),
				sdf.capsule(0.02, 0, 0, 0.13, 0.06, -0.29, 0.028),
				sdf.capsule(0.02, 0, 0, 0.12, -0.20, -0.19, 0.028),
				sdf.capsule(0.02, 0, 0, 0.26, 0.13, 0.22, 0.028),
			), 0.040, 'arc muzzle flash')

		case MuzzleStyle.flame:
			// A flamethrower. A projected tongue: long, tapering OUTWARD, and lifted at the tip
			// the way burning fuel rises. Nothing else in the vocabulary is longer than it is
			// wide by this margin, which is the whole silhouette.
			return meshed(sdf.union(
				sdf.sphere(0.075),
				sdf.translate(sdf.rotateY(sdf.cappedCone(0.075, 0.185, 0.50), AIM), 0.50, 0.03, 0),
				sdf.translate(sdf.sphere(0.175), 1.00, 0.10, 0),
				sdf.capsule(0.35, 0.05, 0, 0.86, 0.24, 0.09, 0.065),
				sdf.capsule(0.30, -0.02, 0, 0.74, -0.14, -0.11, 0.060),
			), 0.070, 'flame muzzle tongue')

		default:
			return null
	}
}

/**
 * Build the drawn body for one tracer style, or null when the style draws nothing here.
 *
 * `arc` returns null deliberately. A tesla weapon resolves both endpoints through the same
 * pairing a tracer uses, and `fx/tesla-arc.ts` already draws the bolt between them — the warm
 * dash that used to be drawn on top of it was a second, wrongly-coloured line under every zap.
 *
 * EVERY SHAPE IS BUILT AN ORDER OF MAGNITUDE FATTER THAN IT IS DRAWN, and that is the point.
 * A tracer is two or three pixels wide, so meshing it at its real 18 mm radius forces a grid
 * fine enough to spend 1,400 triangles on a cylinder — and a grid one step coarser than that
 * straddles the capsule and meshes NOTHING at all, silently. The instance transform sets scaleY
 * and scaleZ independently, so building at `TRACER_NOMINAL_R` and squashing by
 * `wantedRadius / TRACER_NOMINAL_R` draws exactly the same silhouette from a tenth of the
 * triangles, and the taper, bulges and flattening that separate the styles all survive it.
 */
export function buildTracerMesh(style: number): Mesh | null {
	switch (style) {
		case TracerStyle.line:
			// A rifle or machine-gun round: an even thread. Drawn identically to the single
			// shipped primitive, so small arms are the control in any comparison against the
			// previous build.
			return meshed(sdf.capsule(0, 0, 0, 1, 0, 0, 0.15), 0.15, 'line tracer')

		case TracerStyle.streak:
			// A shell: a dart, bright and blunt at the head and drawn out behind it. The taper
			// is the direction cue — a symmetric rod cannot say which way the round was going.
			return meshed(sdf.union(
				sdf.translate(sdf.rotateY(sdf.cappedCone(0.060, 0.170, 0.5), AIM), 0.5, 0, 0),
				sdf.translate(sdf.sphere(0.20), 0.93, 0, 0),
			), 0.060, 'streak tracer')

		case TracerStyle.exhaust:
			// What a rocket leaves behind, drawn along the whole path: widest at the launcher,
			// thinning towards the target, lumpy rather than smooth so it reads as a column of
			// burnt propellant instead of a rod. `fx/projectiles.ts` draws the missile itself;
			// this is the residue that is still there after it has passed.
			return meshed(sdf.union(
				sdf.translate(sdf.rotateY(sdf.cappedCone(0.26, 0.055, 0.5), AIM), 0.5, 0, 0),
				sdf.translate(sdf.sphere(0.27), 0.27, 0.03, 0),
				sdf.translate(sdf.sphere(0.19), 0.52, -0.05, 0.04),
				sdf.translate(sdf.sphere(0.12), 0.76, 0.06, -0.03),
			), 0.075, 'exhaust tracer')

		case TracerStyle.wake:
			// A torpedo: a flat band on the surface rather than a line in the air. Elongating
			// across the run and flattening vertically is what makes it read as water disturbed
			// by something under it.
			return meshed(sdf.elongate(
				sdf.capsule(0, 0, 0, 1, 0, 0, 0.06), 0, 0.02, 0.16,
			), 0.09, 'wake tracer')

		case TracerStyle.flame:
			// A gout of burning fuel: short, fat, and widest a third of the way out, because
			// that is where the stream has spread but not yet burnt through.
			return meshed(sdf.union(
				sdf.translate(sdf.rotateY(sdf.cappedCone(0.12, 0.30, 0.18), AIM), 0.18, 0, 0),
				sdf.translate(sdf.rotateY(sdf.cappedCone(0.30, 0.13, 0.32), AIM), 0.68, 0.02, 0),
				sdf.translate(sdf.sphere(0.27), 0.40, 0.03, 0.02),
				sdf.translate(sdf.sphere(0.145), 0.94, 0.05, 0),
			), 0.13, 'flame tracer')

		default:
			return null
	}
}
