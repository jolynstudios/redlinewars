// STEELSEED — units/shapes
// Procedural unit hulls, built as SDF trees and meshed with surface nets.
//
// §9.1 sets the bar and it is a SILHOUETTE bar: the two factions must be distinguishable
// in monochrome, at maximum zoom-out, from outline alone. That rules out doing this with
// paint, and it rules out one chassis with two colour schemes. Every decision below is
// about the outline:
//
//   Foundry — solid cast mass. Low, wide, hunched, planted. One continuous hull with the
//             tracks faired into it, so the outline is a single heavy block with no gaps.
//   Lattice — open bolted framework. Tall, narrow, skeletal. A thin spine over exposed
//             wheels with a mast above it, so the outline is mostly holes.
//
// Neither faction is science fiction and neither glows. The Foundry is a steel mill that
// learned to build tanks; the Lattice is an engineering corps building its army out of
// bridge trusses and shipping frames.
//
// Everything here is a pure function of (class, seed). No clock, no Math.random: two runs
// of one seed produce byte-identical hulls (§5.2).

import type { Rng } from '../core'
import { Mesh } from '../geo/mesh'
import {
	BoneKind,
	CHASSIS_BONE,
	Skeleton,
	bindSkin,
	createSkin,
	packSkinWeights,
	turretBone,
	wheelBone,
	limbBone,
	BoneFlags,
} from '../geo/rig'
import * as sdf from '../geo/sdf'
import { applyZones, type ZoneRegion } from '../geo/zone'
import { type ChassisParams, deriveChassis, Faction, Family, type RosterSlot } from './archetype/params'
import { buildTrackedVehicle, type TrackedTurretRegion } from './archetype/tracked'
import { buildWheeledVehicle, type WheelRegion } from './archetype/wheeled'
import { buildInfantryFigure, type LegRegion } from './archetype/infantry'
import { buildAircraft } from './archetype/aircraft'
import { buildVessel } from './archetype/vessel'
import { buildPlantStructure, buildEmplacement } from './archetype/plant'

/**
 * Family to generator. The ONLY dispatch in the archetype path, and it is by family rather
 * than by actor name — §14.13 forbids a per-name table, because one goes stale silently the
 * first time an actor is renamed.
 *
 * This map is EXHAUSTIVE over Family, and the type below enforces that rather than trusting
 * it. `Family.vessel` was missing here for the whole life of the archetype path: `vessel.ts`
 * was written, exported from `index.gate.ts`, and never imported by this file. All eleven
 * naval actors threw at `buildUnitFromSlot`, were caught into `Units.droppedSlots`, and drew
 * a five-class placeholder hull for every session. `rostergate` could not see it either,
 * because its own generator map omitted family 5 and counted them as `skipped`.
 *
 * A `Partial<Record<number, ...>>` is what let that happen — it makes every family optional
 * and a missing one a runtime surprise. `Record<Family, ...>` makes the next omission a
 * COMPILE error, which is the only version of this that cannot recur.
 */
const ARCHETYPE_GENERATOR: Record<Family, (p: ChassisParams, rng: Rng, zones?: ZoneRegion[]) => sdf.Sdf> = {
	[Family.tracked]: buildTrackedVehicle,
	[Family.wheeled]: buildWheeledVehicle,
	[Family.infantry]: buildInfantryFigure,
	[Family.rotorcraft]: buildAircraft,
	[Family.fixedwing]: buildAircraft,
	[Family.vessel]: buildVessel,
	[Family.plant]: buildPlantStructure,
	[Family.emplacement]: buildEmplacement,
}

/** Unit silhouette classes. The mod has many actor types; they map onto these. */
export const UnitClass = {
	foundryLight: 0,
	foundryMedium: 1,
	latticeLight: 2,
	latticeMedium: 3,
	/** Neutral salvage and wrecks — mismatched, broken, no faction reading. */
	drift: 4,
} as const

export type UnitClass = (typeof UnitClass)[keyof typeof UnitClass]

export const UNIT_CLASS_COUNT = 5

export interface HeadlampMount {
	/** Local +X is the machine's forward direction. */
	readonly housingX: number
	readonly emitterX: number
	readonly height: number
	readonly halfSpacing: number
}

interface UnitShapeSpec {
	readonly kind: 'foundry' | 'lattice' | 'drift'
	readonly medium: boolean
	readonly length: number
	readonly width: number
	readonly deck: number
	readonly bounds: readonly [number, number, number, number, number, number]
	readonly headlamps: HeadlampMount | null
}

/**
 * Physical dimensions shared by the SDF and every functional attachment.
 *
 * A headlamp offset table beside the hull generator would be a second source of truth:
 * changing a nose length would leave the light floating in front of, or buried inside,
 * the machine. Keeping the mount in the archetype makes the housing and punctual source
 * move together. §14.11 will move this descriptor into the build-time asset forge; until
 * then the runtime SDF consumes the same shape.
 */
const UNIT_SPECS: readonly UnitShapeSpec[] = [
	{
		kind: 'foundry',
		medium: false,
		length: 1.45,
		width: 1.15,
		deck: 0.75,
		bounds: [-1.6, -0.1, -1.3, 1.6, 1.5, 1.3],
		headlamps: { housingX: 1.39, emitterX: 1.65, height: 0.62, halfSpacing: 0.63 },
	},
	{
		kind: 'foundry',
		medium: true,
		length: 2,
		width: 1.5,
		deck: 0.95,
		bounds: [-2.2, -0.1, -1.7, 2.2, 2, 1.7],
		headlamps: { housingX: 1.92, emitterX: 2.22, height: 0.76, halfSpacing: 0.83 },
	},
	{
		kind: 'lattice',
		medium: false,
		length: 1.2,
		width: 0.85,
		deck: 0.75,
		bounds: [-1.3, -0.1, -1, 1.3, 2.6, 1],
		headlamps: { housingX: 1.12, emitterX: 1.42, height: 0.96, halfSpacing: 0.47 },
	},
	{
		kind: 'lattice',
		medium: true,
		length: 1.55,
		width: 1.05,
		deck: 0.95,
		bounds: [-1.7, -0.1, -1.2, 1.7, 3.4, 1.2],
		headlamps: { housingX: 1.47, emitterX: 1.79, height: 1.18, halfSpacing: 0.58 },
	},
	{
		kind: 'drift',
		medium: false,
		length: 1,
		width: 0.8,
		deck: 0.5,
		bounds: [-1.4, -0.1, -1.2, 1.4, 1.6, 1.2],
		headlamps: null,
	},
]

/**
 * The current roster's ground vehicles, keyed by actor NAME rather than typeId.
 *
 * Snapshot typeIds are assigned first-seen by the C# bridge and are meaningless across
 * matches. Keeping this predicate name-based avoids the stale-table bug recorded in
 * §14.13, and excludes infantry, aircraft and neutral wrecks from the lamp budget.
 */
const VEHICLE_TYPES = new Set([
	'foundry_tread',
	'foundry_rammer',
	'foundry_anvil',
	'foundry_kiln',
	'foundry_rack',
	'foundry_dragline',
	'lattice_skimmer',
	'lattice_kite',
	'lattice_stilt',
	'lattice_aperture',
	'lattice_cantilever',
	'lattice_phase',
])

export function isVehicleType(name: string): boolean {
	return VEHICLE_TYPES.has(name)
}

export function headlampMountForClass(c: UnitClass): HeadlampMount | null {
	return UNIT_SPECS[c]?.headlamps ?? null
}

/**
 * Mod actor-type name -> silhouette class.
 *
 * Prefix-matched on faction rather than table-driven per actor, because the mod's roster
 * changes and an unknown `foundry_something` should still read as Foundry. An unknown
 * name at all falls to drift, which is the honest answer for "we do not know what this
 * is" — it draws as neutral salvage rather than as a confident wrong faction.
 */
export function classForType(name: string): UnitClass {
	const heavy = /_(warden|anvil|rammer|dragline|cantilever|stilt|helix)$/.test(name)
	if (name.startsWith('foundry')) return heavy ? UnitClass.foundryMedium : UnitClass.foundryLight
	if (name.startsWith('lattice')) return heavy ? UnitClass.latticeMedium : UnitClass.latticeLight
	return UnitClass.drift
}

/** Which §12.1 surface set a class paints itself with. */
export function setForClass(c: UnitClass): string {
	if (c === UnitClass.foundryLight || c === UnitClass.foundryMedium) return 'foundry'
	if (c === UnitClass.latticeLight || c === UnitClass.latticeMedium) return 'lattice'
	return 'drift'
}

/**
 * Mesh resolution. Units are small on screen in an RTS — a medium hull is ~4 m and the
 * camera sits 40 m up — so the budget goes into having many of them, not into any one.
 */
const RESOLUTION = 24

/** Half-extents of the box every hull is built inside, in metres. */
function boundsFor(c: UnitClass): sdf.Aabb {
	const b = sdf.aabb()
	const s = UNIT_SPECS[c] ?? UNIT_SPECS[UnitClass.drift]
	return sdf.setAabb(b, s.bounds[0], s.bounds[1], s.bounds[2], s.bounds[3], s.bounds[4], s.bounds[5])
}

/**
 * The Foundry hull: one cast mass.
 *
 * Built as a smooth union so the tracks, sponsons and glacis read as a single casting
 * rather than as parts bolted together — that continuity IS the faction's silhouette, and
 * a hard union would leave the seams that belong to the Lattice.
 */
function foundryHull(rng: Rng, spec: UnitShapeSpec): sdf.Sdf {
	const medium = spec.medium
	const len = spec.length
	const wid = spec.width
	const deck = spec.deck

	// Low, wide, hunched. The hull sits ON the tracks with almost no clearance, which is
	// what makes the outline solid to the ground instead of showing daylight underneath.
	const lower = sdf.roundBox(len, deck * 0.5, wid, 0.18)
	const hull = sdf.translate(lower, 0, deck * 0.5 + 0.18, 0)

	// Sloped glacis, cut rather than modelled: a plane through the nose.
	const glacis = sdf.plane(-0.55, 0.83, 0, -(len * 0.72))
	const sloped = sdf.subtract(hull, sdf.negate(glacis))

	// Track runs, faired into the hull so the union closes the gap under the sponsons.
	const trackH = deck * 0.42
	const track = sdf.roundBox(len * 1.02, trackH, 0.26, 0.12)
	const trackL = sdf.translate(track, 0, trackH + 0.1, -(wid - 0.1))
	const trackR = sdf.translate(track, 0, trackH + 0.1, wid - 0.1)

	// Cast turret: a squat cylinder, offset back, with a stubby barrel.
	//
	// Both of these were WRONG until 2026-08-05, and both wrongly in the same way. Every
	// axial primitive in `geo` stands along Z; this file builds in render space, which §12.4
	// pins to Y up with X forward. So a turret must be tipped up out of Z into Y, and a
	// barrel must be aimed out of Z into X. Neither rotation was applied — the code called
	// `rotateZ`, which is a NO-OP on a Z-aligned primitive — so the turret rendered as a
	// disc standing on edge like a wheel, and the barrel pointed sideways across the hull.
	const turretR = medium ? 0.72 : 0.55
	const turretDisc = sdf.rotateX(sdf.cylinder(turretR, 0.26), Math.PI * 0.5)
	const turret = sdf.translate(turretDisc, -0.15, deck + 0.42, 0)
	const barrel = sdf.rotateY(sdf.cylinder(medium ? 0.11 : 0.085, len * 0.95), Math.PI * 0.5)
	const gun = sdf.translate(barrel, len * 0.75, deck + 0.44, 0)

	// A slight seeded asymmetry so a column of identical units does not read as a texture.
	const lean = (rng.next() - 0.5) * 0.06

	return sdf.smoothUnion(
		sdf.smoothUnion(sdf.union(sloped, trackL, trackR), sdf.translate(turret, 0, lean, 0), 0.22),
		gun,
		0.1,
	)
}

/**
 * The Lattice hull: an open bolted frame.
 *
 * Hard unions throughout, and deliberately thin members with air between them. The
 * silhouette is supposed to be mostly holes — that is the whole contrast against the
 * Foundry, and smoothing the joints would fill exactly the gaps that carry it.
 */
function latticeHull(rng: Rng, spec: UnitShapeSpec): sdf.Sdf {
	const medium = spec.medium
	const len = spec.length
	const wid = spec.width
	const clear = spec.deck // tall ground clearance, §9.1

	// A thin spine, not a hull. Everything else hangs off it.
	const spine = sdf.translate(sdf.roundBox(len, 0.16, 0.22, 0.06), 0, clear + 0.3, 0)

	// Two longitudinal rails with visible air between them and the spine.
	const rail = sdf.roundBox(len * 0.98, 0.1, 0.09, 0.04)
	const railL = sdf.translate(rail, 0, clear + 0.1, -wid * 0.72)
	const railR = sdf.translate(rail, 0, clear + 0.1, wid * 0.72)

	// Cross-braces: a repeated diagonal member, which is what makes it read as a truss
	// rather than as a thin box.
	// Long in Z, which is lateral in render space (§12.4) — a brace spans the vehicle's
	// WIDTH. This used to be a Y-long box rotated by rotateZ, which swaps X and Y and
	// therefore produced a member running fore-and-aft: a second spine, not a cross-brace.
	// Written directly in the axis it belongs on, so there is no rotation to get wrong.
	const brace = sdf.roundBox(0.075, 0.075, wid * 0.8, 0.03)
	const braces = sdf.repeatLimited(
		sdf.translate(brace, 0, clear + 0.2, 0),
		len * 0.62,
		0,
		0,
		1,
		0,
		0,
	)

	// Wheels, exposed. 6x6 — no track fairing, so daylight shows under the whole vehicle.
	// No rotation, and this is the one place that is deliberate. A cylinder stands along Z,
	// Z is lateral in render space, and a lateral axis is exactly what a road wheel wants.
	// The old code wrapped this in a `rotateZ` too — a no-op, like the others — which is why
	// the wheels were the only part of the vehicle that came out right. Removing the no-op
	// changes nothing visually and stops the file implying a rotation it never performed.
	const wheel = sdf.cylinder(clear * 0.62, 0.13)
	const wheels = sdf.repeatLimited(
		sdf.translate(wheel, 0, clear * 0.62, wid * 0.8),
		len * 0.78,
		0,
		0,
		1,
		0,
		0,
	)
	const wheelsL = sdf.mirror(wheels, false, false, true)

	// A tall mast — the Lattice's most recognisable feature at zoom-out, and the reason
	// its bounding silhouette is tall and narrow where the Foundry's is low and wide.
	const mastH = medium ? 1.5 : 1.1
	const mast = sdf.translate(sdf.roundBox(0.07, mastH, 0.07, 0.03), -len * 0.5, clear + 0.45 + mastH, 0)
	const beacon = sdf.translate(sdf.sphere(0.11), -len * 0.5, clear + 0.5 + mastH * 2, 0)

	// Boxy equipment pannier, offset to one side — asymmetry reads as improvised kit.
	const side = rng.next() < 0.5 ? -1 : 1
	const pannier = sdf.translate(sdf.roundBox(0.4, 0.26, 0.16, 0.05), len * 0.25, clear + 0.42, side * wid * 0.6)

	return sdf.union(spine, railL, railR, braces, wheels, wheelsL, mast, beacon, pannier)
}

/** Neutral salvage: a broken, mismatched mass with no faction reading. */
function driftHull(rng: Rng): sdf.Sdf {
	const body = sdf.translate(sdf.roundBox(1.0, 0.5, 0.8, 0.14), 0, 0.6, 0)
	// Cut two bites out of it so it reads as wreckage rather than as a crate.
	const biteA = sdf.translate(sdf.sphere(0.55), 0.7 + rng.next() * 0.2, 1.0, 0.4)
	const biteB = sdf.translate(sdf.sphere(0.42), -0.6, 0.75, -0.55 - rng.next() * 0.2)
	const broken = sdf.subtract(sdf.subtract(body, biteA), biteB)
	const strut = sdf.rotateZ(sdf.roundBox(0.06, 0.9, 0.06, 0.02), 0.5)
	return sdf.union(broken, sdf.translate(strut, -0.3, 1.1, 0.2))
}

/**
 * Two physical lamp housings welded into the generated hull.
 *
 * They deliberately use the hull's ordinary SurfaceSet. SurfaceSet has no
 * emissive channel to smuggle a glow through; illumination comes only from the real
 * punctual source submitted by `units`. The point path has no cone, so the housing is
 * also the only directional visual cue until §12.2 grows a spotlight contract.
 */
function attachHeadlampHousings(tree: sdf.Sdf, spec: UnitShapeSpec): sdf.Sdf {
	const mount = spec.headlamps
	if (!mount) return tree

	const pod = sdf.roundBox(0.15, 0.12, 0.14, 0.04)
	// The bar reaches well back into the chassis and spans both pods. A disconnected union
	// still meshes, but produces a bright floating pebble beside the unit at RTS distance
	// instead of a lamp bolted to a machine — the ordinary night capture gates this overlap.
	const bar = sdf.roundBox(0.32, 0.095, mount.halfSpacing + 0.12, 0.035)
	const stemX = mount.housingX - 0.22
	const stemY = mount.height - 0.04
	const housings = sdf.union(
		sdf.translate(bar, stemX, stemY, 0),
		sdf.translate(pod, mount.housingX, mount.height, -mount.halfSpacing),
		sdf.translate(pod, mount.housingX, mount.height, mount.halfSpacing),
	)
	return spec.kind === 'foundry'
		? sdf.smoothUnion(tree, housings, 0.055)
		: sdf.union(tree, housings)
}

/**
 * Build one class's hull into `out`, which is CLEARED first.
 *
 * `creaseAngle` is deliberately low: these are welded plate and bolted steel, not organic
 * forms, and a smoothed crease reads as plastic at any zoom.
 */
export function buildUnit(out: Mesh, c: UnitClass, rng: Rng, withHeadlamps = false): Mesh {
	out.clear()
	const spec = UNIT_SPECS[c] ?? UNIT_SPECS[UnitClass.drift]
	let tree: sdf.Sdf
	switch (spec.kind) {
		case 'foundry':
			tree = foundryHull(rng, spec)
			break
		case 'lattice':
			tree = latticeHull(rng, spec)
			break
		default:
			tree = driftHull(rng)
	}
	if (withHeadlamps) tree = attachHeadlampHousings(tree, spec)
	sdf.surfaceNets(tree, boundsFor(c), RESOLUTION, out, { creaseAngle: 32, seal: true })
	projectBoxUv(out)
	markStatusStripCoordinates(out, spec.kind !== 'drift')
	// AFTER the projection, never before: the tangent frame is derived from uv0, and
	// surface nets leaves uv0 at zero. Tangents built from degenerate UVs are an arbitrary
	// perpendicular — stable, but unrelated to the texture — and the normal map then
	// perturbs the shading normal along a meaningless axis.
	out.computeTangents()
	return out
}

/** Metres of hull per texture repeat. Plate and rivet detail reads at roughly this scale. */
/** World-space span of one material repeat on generated unit meshes. */
export const UV_METRES = 1.5

/**
 * Box-project uv0 from position, per vertex, using the dominant normal axis.
 *
 * Surface nets emits positions and normals and nothing else — §6.2 makes UVs a separate
 * pass because a proper one is per material zone and needs the rig. This is the stand-in,
 * and it is not merely cosmetic: with uv0 left at zero every fragment samples the SAME
 * texel, so a hull renders as one flat colour with no plate, rivet or wear detail at all,
 * and `computeTangents` has no gradient to build a frame from.
 *
 * Box rather than triplanar because the blend happens in the shader for terrain only;
 * here one projection per vertex is enough and costs nothing at runtime.
 */
function projectBoxUv(mesh: Mesh): void {
	const n = mesh.vertexCount
	const pos = mesh.positions
	const nrm = mesh.normals
	const uv = mesh.uv0
	const k = 1 / UV_METRES
	for (let i = 0; i < n; i++) {
		const o = i * 3
		const x = pos[o]
		const y = pos[o + 1]
		const z = pos[o + 2]
		const ax = Math.abs(nrm[o])
		const ay = Math.abs(nrm[o + 1])
		const az = Math.abs(nrm[o + 2])
		const u = i * 2
		if (ax >= ay && ax >= az) {
			// Facing X: project onto ZY.
			uv[u] = z * k
			uv[u + 1] = y * k
		} else if (ay >= az) {
			// Facing Y (deck or belly): project onto XZ.
			uv[u] = x * k
			uv[u + 1] = z * k
		} else {
			// Facing Z: project onto XY.
			uv[u] = x * k
			uv[u + 1] = y * k
		}
	}
}

/**
 * Unit-only coordinates for the analytic status strip.
 *
 * uv0 repeats with the material tile and therefore cannot carry a one-per-machine mark:
 * filtering a thin baked alpha band through its mip chain measured as a broad low-level
 * tint over the hull. uv1 is unused by ordinary actor meshes, so x stores 0.5 plus HALF a
 * local placement weight for the two long side faces (zero remains the structure sentinel;
 * the 0.5 base is what the shader's eligibility step reads as "this mesh was stamped") and
 * y is local height normalised over this mesh. The fragment shader can then place exactly
 * one band without a texture repeat or an instance-layout change.
 *
 * The weight is halved and offset into [0.5, 1] because uv1 uploads as unorm16, which
 * clamps at 1.0 (geo/mesh quantizeUnorm): the previous [1, 2] encoding survived on the
 * CPU but reached the GPU as exactly 1.0, so the shader's placement step saw zero
 * everywhere and every status strip went dark — bloomgate's "emissive source key is
 * empty" with a fully-stamped mesh.
 *
 * Structures deliberately keep the zeroes emitted by surfaceNets. Foundry and Lattice use
 * the same material sets for units and buildings, so this mesh-owned bit is the boundary
 * that prevents a status strip becoming repeated decorative panel-line glow on a building.
 */
function markStatusStripCoordinates(mesh: Mesh, enabled: boolean): void {
	if (!enabled || mesh.vertexCount === 0) return

	let minY = Number.POSITIVE_INFINITY
	let maxY = Number.NEGATIVE_INFINITY
	let minX = Number.POSITIVE_INFINITY
	let maxX = Number.NEGATIVE_INFINITY
	for (let i = 0; i < mesh.vertexCount; i++) {
		const position = i * 3
		const x = mesh.positions[position]
		const y = mesh.positions[position + 1]
		if (x < minX) minX = x
		if (x > maxX) maxX = x
		if (y < minY) minY = y
		if (y > maxY) maxY = y
	}

	const invLength = 1 / Math.max(maxX - minX, 1e-6)
	const invHeight = 1 / Math.max(maxY - minY, 1e-6)
	for (let i = 0; i < mesh.vertexCount; i++) {
		const position = i * 3
		const uv = i * 2
		const x01 = (mesh.positions[position] - minX) * invLength
		const longSpan = 1 - smoothstep01(0.40, 0.49, Math.abs(x01 - 0.5))
		const sideFace = smoothstep01(0.45, 0.78, Math.abs(mesh.normals[position + 2]))
		mesh.uv1[uv] = 0.5 + 0.5 * (longSpan * sideFace)
		mesh.uv1[uv + 1] = (mesh.positions[position + 1] - minY) * invHeight
	}
}

function smoothstep01(lo: number, hi: number, value: number): number {
	const t = Math.max(0, Math.min(1, (value - lo) / (hi - lo)))
	return t * t * (3 - 2 * t)
}

// ---------------------------------------------------------------------------
// §14.13 archetype path
// ---------------------------------------------------------------------------
// The five hull classes above are a placeholder that predates the roster having usable
// functional data. This path replaces them: one mesh per ACTOR TYPE, derived from that
// type's own numbers, with no per-name authoring anywhere in the chain.
//
// Kept in the same file as the classes rather than replacing them outright, because the
// class path is still the fallback for an actor the roster does not describe — and an
// unknown actor must draw SOMETHING rather than vanish (rule 8). A silently undrawn army is
// far harder to diagnose than a wrongly-shaped one.

/** Reused across the boot loop — `sdf.aabb()` allocates and this runs once per slot. */
const slotBounds = sdf.aabb()
/** Likewise: generators push their material regions here, and it is cleared per slot. */
const zoneScratch: ZoneRegion[] = []
/** Wheel regions from the wheeled generator, for the running-gear rig. Cleared per slot. */
const wheelScratch: WheelRegion[] = []
const legScratch: LegRegion[] = []
const rigSkip: { reason: string | null } = { reason: null }
/** Tracked generators retain the welded turret subtree here for boot-time skin binding. */
const trackedTurretScratch: TrackedTurretRegion[] = []
/** Reused while turning that subtree into a conservative bone capture capsule. */
const rigBounds = sdf.aabb()
const identityBounds = sdf.aabb()
/** Quantised weights are copied into Mesh's float authoring channel, then packed identically at upload. */
let packedWeightScratch = new Uint8Array(0)

export interface UnitRig {
	readonly skeleton: Skeleton
	readonly rotorBones?: Int32Array
	readonly rotorSpeeds?: Float32Array
	readonly oscillatorBones?: Int32Array
	readonly oscillatorSpeeds?: Float32Array
	readonly oscillatorPhases?: Float32Array
	readonly oscillatorAmplitudes?: Float32Array
	readonly windBones?: Int32Array
	readonly windSpeeds?: Float32Array
	readonly windPhases?: Float32Array
	readonly windAmplitudes?: Float32Array
	/** Turret bones in authoritative snapshot order, empty when this rig has no turrets. */
	readonly turretBones: Int32Array
	/** Wheel bone indices, empty when this rig has no wheels. Parallel to wheelRadii. */
	readonly wheelBones: Int32Array
	/** Rolling radius per wheel, metres. Distance over this is the rotation, exactly. */
	readonly wheelRadii: Float32Array
	/** Limb bone indices for a walking figure, empty otherwise. */
	readonly legBones: Int32Array
	/** Phase offset per limb, radians. The left leg leads by half a cycle. */
	readonly legPhase: Float32Array
	/** Metres of ground per full gait cycle. */
	readonly strideM: number
	/** Primary-capture count per bone. A zero here is a rig that cannot visibly move. */
	readonly capturedVertices: Uint32Array
	/** Strongest influence per bone. A nonzero count with a tiny maximum cannot move a part. */
	readonly maxWeights: Float32Array
}

/** Optional build result for the runtime. Geometry-only gates may omit it. */
export interface UnitBuildMetadata {
	rig: UnitRig | null
	/**
	 * Why this actor has no rig, when it was eligible for one and declined. Null when the rig
	 * built, and null when the family has no rig to build — those two are different states and
	 * only the first is worth reporting.
	 */
	rigSkipReason: string | null
}

/**
 * Bind one already-welded infantry figure to chassis + two limb bones.
 *
 * This family needs the walk more than any other and §14.13 is the reason: stature is FIXED at
 * 1.72 m by design — deriving it from a selection box once made a heavy-weapons trooper a
 * giant — so the body cannot carry identity and the motion has to. A figure that slides across
 * the ground reads as a chess piece however good its outline is.
 *
 * The capture segment runs hip to sole at a little over the leg's own radius, so each bone
 * claims one leg and its boot and nothing of the torso. BoneKind.limb pins the swing to the
 * lateral axis, which is fore-and-aft for a walking figure and is correct only since 8376cae.
 */
function bindInfantryGait(
	mesh: Mesh,
	p: ChassisParams,
	regions: readonly LegRegion[],
	actorName: string,
	skipped: { reason: string | null },
): UnitRig | null {
	const descs: unknown[] = [{
		name: CHASSIS_BONE,
		kind: BoneKind.chassis,
		pos: [0, 0, 0],
		tail: [0, p.heightM * 0.5, 0],
	}]
	for (let i = 0; i < regions.length; i++) {
		const r = regions[i]
		descs.push({
			name: limbBone(r.mirrored ? 'l' : 'r', 'thigh'),
			parent: 0,
			kind: BoneKind.limb,
			pos: [r.hip[0], r.hip[1], r.hip[2]],
			// Down to the sole. A limb bone that stops at the knee leaves the boot behind.
			tail: [0, -r.reach, 0],
			radius: 0.085,
			flags: r.mirrored ? BoneFlags.mirrored : BoneFlags.none,
		})
	}
	const skeleton = new Skeleton(descs as never)
	const skin = createSkin(mesh.vertexCount)
	bindSkin(skeleton, skin, mesh.positions, { first: 0, count: -1, maxInfluences: 1 })

	const capturedVertices = new Uint32Array(skeleton.boneCount)
	const maxWeights = new Float32Array(skeleton.boneCount)
	for (let v = 0; v < mesh.vertexCount; v++) {
		const b = skin.joints[v * 4]
		capturedVertices[b]++
		const w = skin.weights[v * 4]
		if (w > maxWeights[b]) maxWeights[b] = w
	}
	for (let b = 0; b < skeleton.boneCount; b++) {
		if (capturedVertices[b] === 0 || maxWeights[b] < 0.25) {
			skipped.reason =
				`'${actorName}' gait bone '${skeleton.names[b]}' cannot move geometry: ` +
				`${capturedVertices[b]} vertices captured, max weight ${maxWeights[b].toFixed(3)}`
			return null
		}
	}

	mesh.enableSkin(0)
	const packedLength = mesh.vertexCount * 4
	if (packedWeightScratch.length < packedLength) packedWeightScratch = new Uint8Array(packedLength)
	packSkinWeights(skin, mesh.skinIndices!, packedWeightScratch)
	for (let i = 0; i < packedLength; i++) mesh.skinWeights![i] = packedWeightScratch[i] / 255

	const legBones = new Int32Array(regions.length)
	const legPhase = new Float32Array(regions.length)
	for (let i = 0; i < regions.length; i++) {
		legBones[i] = i + 1
		legPhase[i] = regions[i].mirrored ? Math.PI : 0
	}
	return {
		skeleton,
		turretBones: EMPTY_BONES,
		wheelBones: EMPTY_BONES,
		wheelRadii: EMPTY_RADII,
		legBones,
		legPhase,
		// A stride is roughly 1.6 leg-lengths per full cycle, which is where a walking human
		// actually is. Derived from the figure's own reach so it cannot drift from the model.
		strideM: Math.max(0.2, regions[0].reach * 1.6),
		capturedVertices,
		maxWeights,
	}
}

const EMPTY_BONES = new Int32Array(0)
const EMPTY_RADII = new Float32Array(0)

/**
 * Bind one already-welded wheeled hull to chassis + one bone per wheel.
 *
 * Wheels are rigged on THIS family and not on tracked, and that is a statement about §9.1
 * rather than about effort. The Lattice is a thin spine over EXPOSED wheels, so a turning
 * wheel is a large part of what the family reads as. A tracked vehicle's road wheels are
 * detail INSIDE the run — tracked.ts argues that at length when it sizes the band to enclose
 * them — so rigging them would spend bones on something the band already hides, and the track
 * SURFACE is what moves there, which 674afb2 does with a UV phase and no bones at all.
 *
 * The capture segment runs along the AXLE with the wheel's own radius, so each bone claims its
 * own wheel and nothing else. The rotation axis follows BoneKind.wheel, which rig.ts pins to
 * the lateral axis — correct only since 8376cae, when that file still believed Z was up and
 * would have rolled every wheel about the wrong axis.
 */
function bindWheeledRunningGear(
	mesh: Mesh,
	p: ChassisParams,
	regions: readonly WheelRegion[],
	actorName: string,
	skipped: { reason: string | null },
): UnitRig | null {
	const descs = [{
		name: CHASSIS_BONE,
		kind: BoneKind.chassis,
		pos: [0, 0, 0] as [number, number, number],
		tail: [p.lengthM * 0.5, 0, 0] as [number, number, number],
	}]
	for (let i = 0; i < regions.length; i++) {
		const r = regions[i]
		descs.push({
			// The grammar is wheel.<side>.<index>, and the side comes from which bank the
			// region sits on rather than from its order in the array.
			name: wheelBone(r.pivot[2] >= 0 ? 'r' : 'l', i >> 1),
			parent: 0,
			kind: BoneKind.wheel,
			pos: [r.pivot[0], r.pivot[1], r.pivot[2]] as [number, number, number],
			// Along the axle, so the capture capsule is the wheel's own disc rather than a
			// sausage reaching down the chassis into its neighbours.
			tail: [0, 0, r.pivot[2] >= 0 ? r.axleHalfWidth : -r.axleHalfWidth] as [number, number, number],
			radius: r.radius * 1.06,
		} as never)
	}
	const skeleton = new Skeleton(descs as never)
	const skin = createSkin(mesh.vertexCount)
	bindSkin(skeleton, skin, mesh.positions, { first: 0, count: -1, maxInfluences: 1 })

	const capturedVertices = new Uint32Array(skeleton.boneCount)
	const maxWeights = new Float32Array(skeleton.boneCount)
	for (let v = 0; v < mesh.vertexCount; v++) {
		const b = skin.joints[v * 4]
		capturedVertices[b]++
		const w = skin.weights[v * 4]
		if (w > maxWeights[b]) maxWeights[b] = w
	}
	for (let b = 0; b < skeleton.boneCount; b++) {
		// Both halves of "this bone cannot move anything". A zero capture is the obvious one; a
		// healthy capture at a negligible weight is the one that looks like a working rig at
		// rest, which is why this counts weight as well as membership.
		//
		// It DECLINES rather than throwing, and the difference matters. lattice_node's tyres
		// are finer than one mesher cell — the same sub-cell case the zone pass hit — so its
		// wheels contribute no finished-surface vertices and cannot be rigged. Refusing to draw
		// the actor over that would trade a wheel that does not turn for a wheel that is not
		// there, which is strictly worse. The actor draws unrigged, its running gear still
		// scrolls through the material zone, and the reason is REPORTED so it cannot pass as a
		// working rig.
		if (capturedVertices[b] === 0 || maxWeights[b] < 0.25) {
			skipped.reason =
				`'${actorName}' wheel bone '${skeleton.names[b]}' cannot move geometry: ` +
				`${capturedVertices[b]} vertices captured, max weight ${maxWeights[b].toFixed(3)} ` +
				'— finer than the mesher grid at this actor\'s resolution'
			return null
		}
	}

	mesh.enableSkin(0)
	const packedLength = mesh.vertexCount * 4
	if (packedWeightScratch.length < packedLength) packedWeightScratch = new Uint8Array(packedLength)
	packSkinWeights(skin, mesh.skinIndices!, packedWeightScratch)
	for (let i = 0; i < packedLength; i++) mesh.skinWeights![i] = packedWeightScratch[i] / 255

	const wheelBones = new Int32Array(regions.length)
	const wheelRadii = new Float32Array(regions.length)
	for (let i = 0; i < regions.length; i++) {
		wheelBones[i] = i + 1
		wheelRadii[i] = regions[i].radius
	}
	return {
		skeleton,
		turretBones: EMPTY_BONES,
		wheelBones,
		wheelRadii,
		legBones: EMPTY_BONES,
		legPhase: EMPTY_RADII,
		strideM: 0,
		capturedVertices,
		maxWeights,
	}
}

/**
 * Bind one already-welded tracked mesh to chassis + turret bones.
 *
 * The turret subtree is used only to size the capture segment's envelope. It is not meshed
 * separately, so the smooth union between ring and hull survives unchanged.
 */
function bindTrackedTurret(
	mesh: Mesh,
	p: ChassisParams,
	region: TrackedTurretRegion,
	actorName: string,
): UnitRig {
	const bounds = sdf.sdfAabb(region.tree, rigBounds)
	const pivot = region.pivot
	const tailX = Math.max(0.05, bounds.max[0] - pivot[0])
	const behind = Math.max(0, pivot[0] - bounds.min[0])
	const vertical = Math.max(Math.abs(bounds.min[1] - pivot[1]), Math.abs(bounds.max[1] - pivot[1]))
	const lateral = Math.max(Math.abs(bounds.min[2] - pivot[2]), Math.abs(bounds.max[2] - pivot[2]))
	// A capsule from ring to muzzle. The radius includes the bustle behind the pivot and the
	// complete drum cross-section, plus enough slack for the smooth-union fillet.
	const radius = Math.hypot(behind, vertical, lateral) + 0.04

	const skeleton = new Skeleton([
		{
			name: CHASSIS_BONE,
			kind: BoneKind.chassis,
			pos: [0, 0, 0],
			tail: [p.lengthM * 0.5, 0, 0],
		},
		{
			name: turretBone(0),
			parent: 0,
			kind: BoneKind.turret,
			pos: pivot,
			tail: [tailX, 0, 0],
			radius,
		},
	])
	const skin = createSkin(mesh.vertexCount)
	// Hard-surface machinery takes one influence. The subtree-sized capsule tells bindSkin
	// where the welded turret lives without introducing a deforming falloff at the ring.
	bindSkin(skeleton, skin, mesh.positions, { first: 0, count: -1, maxInfluences: 1 })

	const capturedVertices = new Uint32Array(skeleton.boneCount)
	const maxWeights = new Float32Array(skeleton.boneCount)
	for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
		const o = vertex * 4
		for (let influence = 0; influence < 4; influence++) {
			const bone = skin.joints[o + influence]
			const weight = skin.weights[o + influence]
			if (weight <= 0) continue
			if (influence === 0) capturedVertices[bone]++
			if (weight > maxWeights[bone]) maxWeights[bone] = weight
		}
	}
	for (let bone = 0; bone < capturedVertices.length; bone++) {
		if (capturedVertices[bone] === 0) {
			throw new Error(
				`units: '${actorName}' rig bone '${skeleton.names[bone]}' captured zero vertices; ` +
				'the region is smaller than the mesher grid or its capture envelope is wrong.',
			)
		}
		if (maxWeights[bone] < 0.25) {
			throw new Error(
				`units: '${actorName}' rig bone '${skeleton.names[bone]}' has maximum weight ` +
				`${maxWeights[bone].toFixed(4)} below 0.25; it captures vertices but cannot visibly move them.`,
			)
		}
	}

	mesh.enableSkin(0)
	const packedLength = mesh.vertexCount * 4
	if (packedWeightScratch.length < packedLength) packedWeightScratch = new Uint8Array(packedLength)
	packSkinWeights(skin, mesh.skinIndices!, packedWeightScratch)
	for (let i = 0; i < packedLength; i++) mesh.skinWeights![i] = packedWeightScratch[i] / 255

	return {
		skeleton,
		turretBones: new Int32Array([1]),
		wheelBones: EMPTY_BONES,
		wheelRadii: EMPTY_RADII,
		legBones: EMPTY_BONES,
		legPhase: EMPTY_RADII,
		strideM: 0,
		capturedVertices,
		maxWeights,
	}
}

/**
 * Bind every independently moving hard-surface part into one skeleton.
 *
 * This is deliberately one pass. Building a turret rig and then a wheel rig used to make the
 * latter replace the former, while applying them as separate poses made the final reset win.
 * The snapshot is authoritative for all turret facings and cumulative travel is authoritative
 * for all wheel angles, so both inputs must address one pose and one skin palette.
 */
function bindMachineRig(
	mesh: Mesh,
	p: ChassisParams,
	turrets: readonly TrackedTurretRegion[],
	wheels: readonly WheelRegion[],
	actorName: string,
): UnitRig {
	const descs: unknown[] = [{
		name: CHASSIS_BONE,
		kind: BoneKind.chassis,
		pos: [0, 0, 0],
		tail: [p.lengthM * 0.5, 0, 0],
	}]
	for (let i = 0; i < turrets.length; i++) {
		const region = turrets[i]
		const bounds = sdf.sdfAabb(region.tree, rigBounds)
		const pivot = region.pivot
		const tailX = Math.max(0.05, bounds.max[0] - pivot[0])
		const behind = Math.max(0, pivot[0] - bounds.min[0])
		const vertical = Math.max(Math.abs(bounds.min[1] - pivot[1]), Math.abs(bounds.max[1] - pivot[1]))
		const lateral = Math.max(Math.abs(bounds.min[2] - pivot[2]), Math.abs(bounds.max[2] - pivot[2]))
		descs.push({
			name: turretBone(i),
			parent: 0,
			kind: BoneKind.turret,
			pos: pivot,
			tail: [tailX, 0, 0],
			radius: Math.hypot(behind, vertical, lateral) + 0.04,
			bias: 0.025,
		})
	}
	const wheelStart = descs.length
	for (let i = 0; i < wheels.length; i++) {
		const region = wheels[i]
		descs.push({
			name: wheelBone(region.pivot[2] >= 0 ? 'r' : 'l', i >> 1),
			parent: 0,
			kind: BoneKind.wheel,
			pos: region.pivot,
			tail: [0, 0, region.pivot[2] >= 0 ? region.axleHalfWidth : -region.axleHalfWidth],
			radius: region.radius * 1.08,
			bias: 0.015,
		})
	}

	const skeleton = new Skeleton(descs as never)
	const skin = createSkin(mesh.vertexCount)
	// The generators already retained the exact source subtree for each moving part. Classify
	// against those instead of asking overlapping capture capsules to guess: on a small jeep a
	// turret envelope can cover the complete chassis and otherwise steal every vertex from it.
	const tolerance = Math.max(p.lengthM, p.widthM, p.heightM) / 16
	for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
		const offset = vertex * 3
		const x = mesh.positions[offset]
		const y = mesh.positions[offset + 1]
		const z = mesh.positions[offset + 2]
		let bestBone = 0
		let bestDistance = tolerance
		// Exposed running gear wins overlaps. A long turret bustle can intersect a small
		// chassis wheel in source space; choosing only the numerically closest subtree then
		// gives the wheel zero owned vertices even though its outer surface is visible.
		for (let wheel = 0; wheel < wheels.length; wheel++) {
			const distance = Math.abs(sdf.evalSdf(wheels[wheel].tree, x, y, z))
			if (distance >= bestDistance) continue
			bestDistance = distance
			bestBone = wheelStart + wheel
		}
		if (bestBone === 0) for (let turret = 0; turret < turrets.length; turret++) {
			const distance = Math.abs(sdf.evalSdf(turrets[turret].tree, x, y, z))
			if (distance >= bestDistance) continue
			bestDistance = distance
			bestBone = turret + 1
		}
		const skinOffset = vertex * 4
		skin.joints[skinOffset] = bestBone
		skin.joints[skinOffset + 1] = skin.joints[skinOffset + 2] = skin.joints[skinOffset + 3] = 0
		skin.weights[skinOffset] = 1
		 skin.weights[skinOffset + 1] = skin.weights[skinOffset + 2] = skin.weights[skinOffset + 3] = 0
	}
	// A deeply overlapped tyre can contribute only a sub-cell sliver to the welded surface.
	// Preserve an independently rotating visible patch by coupling the nearest finished
	// vertices to that wheel. This is based on the wheel's exact source SDF, not an actor table.
	for (let wheel = 0; wheel < wheels.length; wheel++) {
		const bone = wheelStart + wheel
		let found = false
		for (let vertex = 0; vertex < mesh.vertexCount; vertex++)
			if (skin.joints[vertex * 4] === bone) { found = true; break }
		if (found) continue
		const nearestVertices = new Int32Array(8)
		nearestVertices.fill(-1)
		const nearestDistances = new Float32Array(8)
		nearestDistances.fill(Infinity)
		for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
			const offset = vertex * 3
			const distance = Math.abs(sdf.evalSdf(
				wheels[wheel].tree,
				mesh.positions[offset], mesh.positions[offset + 1], mesh.positions[offset + 2],
			))
			if (distance >= nearestDistances[7]) continue
			let insert = 7
			while (insert > 0 && distance < nearestDistances[insert - 1]) {
				nearestDistances[insert] = nearestDistances[insert - 1]
				nearestVertices[insert] = nearestVertices[insert - 1]
				insert--
			}
			nearestDistances[insert] = distance
			nearestVertices[insert] = vertex
		}
		for (const vertex of nearestVertices) {
			if (vertex < 0) continue
			const offset = vertex * 4
			skin.joints[offset] = bone
			skin.weights[offset] = 1
		}
	}
	const capturedVertices = new Uint32Array(skeleton.boneCount)
	const maxWeights = new Float32Array(skeleton.boneCount)
	for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
		const bone = skin.joints[vertex * 4]
		capturedVertices[bone]++
		maxWeights[bone] = Math.max(maxWeights[bone], skin.weights[vertex * 4])
	}
	for (let bone = 0; bone < skeleton.boneCount; bone++) {
		if (capturedVertices[bone] === 0 || maxWeights[bone] < 0.25)
			throw new Error(
				`units: '${actorName}' composite rig bone '${skeleton.names[bone]}' cannot move geometry: ` +
				`${capturedVertices[bone]} vertices captured, max weight ${maxWeights[bone].toFixed(3)}`,
			)
	}

	mesh.enableSkin(0)
	const packedLength = mesh.vertexCount * 4
	if (packedWeightScratch.length < packedLength) packedWeightScratch = new Uint8Array(packedLength)
	packSkinWeights(skin, mesh.skinIndices!, packedWeightScratch)
	for (let i = 0; i < packedLength; i++) mesh.skinWeights![i] = packedWeightScratch[i] / 255

	const turretBones = new Int32Array(turrets.length)
	for (let i = 0; i < turretBones.length; i++) turretBones[i] = i + 1
	const wheelBones = new Int32Array(wheels.length)
	const wheelRadii = new Float32Array(wheels.length)
	for (let i = 0; i < wheels.length; i++) {
		wheelBones[i] = wheelStart + i
		wheelRadii[i] = wheels[i].radius
	}
	return {
		skeleton,
		turretBones,
		wheelBones,
		wheelRadii,
		legBones: EMPTY_BONES,
		legPhase: EMPTY_RADII,
		strideM: 0,
		capturedVertices,
		maxWeights,
	}
}

/**
 * Mesher bounds, measured from the TREE rather than guessed from the slot's numbers.
 *
 * This was a formula — `max(lengthM, widthM) * 0.85 + 0.6` half-extent over a floor at
 * y = -0.15 — and it was wrong in both directions at once, silently, for a third of the
 * roster. Measured against `sdfAabb` at 0dba9e4:
 *
 *   29 of 97 actors were being CROPPED. Every one of the eleven vessels sat below the
 *   -0.15 floor (foundry_bastion reached -0.427), so their hulls were sheared off flat
 *   underneath. lattice_array, lattice_reservoir, foundry_hearth, foundry_store,
 *   foundry_boiler and lattice_prong all extended past the horizontal box and lost the
 *   top of a mast or stack — the exact features §14.13 says carry identity.
 *
 *   The other direction was worse, because it deletes an actor instead of trimming one.
 *   `res` is chosen from the actor's own span, so it means "cells across the object" — but
 *   the grid was laid over this padded box, which for a small aircraft is nearly eight
 *   times the actor's length. lattice_spectra is 0.80 m long inside a 6.19 m box at res 20:
 *   a 0.31 m cell against a 0.18 m fuselage. Its whole body was thinner than one cell, it
 *   meshed to ZERO vertices, `render.upload` threw, and it drew a placeholder. All five
 *   Lattice rotorcraft were under one cell; all ten rotorcraft were under two.
 *
 * A measured box fixes both, and it is FREE: the sample count is res³ whatever the box
 * contains, so tightening it costs nothing and buys a median 1.72x finer cell. `sdfAabb`
 * is conservative — it widens by k/2 for the smooth-union bulge (sdf.ts, SdfOp.smoothUnion)
 * — so it cannot under-report. The pad below is a margin for the surface to sit off the box
 * wall; surface nets adds its own one-cell shell on top of it.
 */
function boundsForTree(tree: sdf.Sdf): sdf.Aabb {
	const b = sdf.sdfAabb(tree, slotBounds)
	const pad = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) * 0.04
	return sdf.setAabb(
		b,
		b.min[0] - pad, b.min[1] - pad, b.min[2] - pad,
		b.max[0] + pad, b.max[1] + pad, b.max[2] + pad,
	)
}

/**
 * A tiny deterministic serial rack. Gameplay traits own the main mass; the actor id only
 * selects these sub-silhouette studs, which is exactly the permitted uniqueness seed.
 */
function addActorIdentityDetail(tree: sdf.Sdf, actorName: string): sdf.Sdf {
	let hash = 0x811c9dc5
	for (let i = 0; i < actorName.length; i++) {
		hash ^= actorName.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193) >>> 0
	}
	const bounds = sdf.sdfAabb(tree, identityBounds)
	const spanX = Math.max(0.1, bounds.max[0] - bounds.min[0])
	const spanY = Math.max(0.1, bounds.max[1] - bounds.min[1])
	const spanZ = Math.max(0.1, bounds.max[2] - bounds.min[2])
	const size = Math.max(0.025, Math.min(0.12, Math.max(spanX, spanY, spanZ) / 22))
	const centreX = bounds.min[0] + spanX * (0.22 + ((hash >>> 28) & 3) * 0.08)
	const centreY = bounds.max[1] + size * 0.15
	const width = Math.min(spanZ * 0.62, size * 10)
	let rack = sdf.translate(
		sdf.roundBox(size * 1.2, size * 0.32, Math.max(size, width * 0.5), size * 0.18),
		centreX, centreY, 0,
	)
	// Sixteen bits plus a four-state longitudinal offset make collisions after meshing
	// vanishingly unlikely while keeping the whole rack below ordinary weapon/sensor scale.
	for (let bit = 0; bit < 16; bit++) {
		if (((hash >>> bit) & 1) === 0) continue
		const column = bit & 7
		const row = bit >>> 3
		const z = -width * 0.42 + width * 0.84 * column / 7
		const x = centreX + (row === 0 ? -size * 0.48 : size * 0.48)
		rack = sdf.union(rack, sdf.translate(
			sdf.roundBox(size * 0.32, size * (0.55 + ((hash >>> (bit + 16 & 31)) & 1) * 0.35), size * 0.32, size * 0.12),
			x, centreY + size * 0.65, z,
		))
	}
	// Continuous full-hash pin height changes the rack's own AABB, so even actors whose
	// sub-cell studs quantise onto the same surface-net cells cannot produce the same mesh.
	const serial = hash / 0xffffffff
	const pinHalfHeight = size * (1.1 + serial)
	rack = sdf.union(rack, sdf.translate(
		sdf.roundBox(size * 0.24, pinHalfHeight, size * 0.24, size * 0.10),
		centreX - size * 0.92, centreY + pinHalfHeight, -width * 0.46,
	))
	return sdf.union(tree, rack)
}

/**
 * Build one actor's hull from its roster slot.
 *
 * Resolution scales with the object so a 6 m building is not sampled at the same grid as a
 * 0.7 m soldier — a fixed resolution either wastes triangles on infantry or loses a
 * building's door aperture. Clamped at both ends so the boot cost stays bounded.
 */
export function buildUnitFromSlot(
	out: Mesh,
	slot: RosterSlot,
	rng: Rng,
	metadata?: UnitBuildMetadata,
): Mesh {
	out.clear()
	if (metadata) { metadata.rig = null; metadata.rigSkipReason = null }
	const p = deriveChassis(slot)
	const build = ARCHETYPE_GENERATOR[slot.family]
	if (build === undefined) {
		// No generator for this family yet. Fail LOUDLY rather than substituting a generic
		// hull: §14.13 is explicit that a fallback here hides the omission, and a family
		// silently drawn as something else is a defect that survives review.
		throw new Error(`units: no generator for family ${slot.family} (actor '${slot.name}')`)
	}
	// Reused across the boot loop rather than allocated per slot; generators push into it.
	zoneScratch.length = 0
	trackedTurretScratch.length = 0
	wheelScratch.length = 0
	legScratch.length = 0
	let tree = slot.family === Family.tracked
		? buildTrackedVehicle(p, rng, zoneScratch, trackedTurretScratch)
		: slot.family === Family.wheeled
			? buildWheeledVehicle(p, rng, zoneScratch, wheelScratch, trackedTurretScratch)
			: slot.family === Family.infantry
				? buildInfantryFigure(p, rng, zoneScratch, legScratch)
				: slot.family === Family.vessel
					? buildVessel(p, rng, zoneScratch, trackedTurretScratch, slot.turrets)
					: build(p, rng, zoneScratch)
	tree = addActorIdentityDetail(tree, slot.name)
	const span = Math.max(p.lengthM, p.widthM, p.heightM + p.clearanceM)
	const res = Math.max(20, Math.min(40, Math.round(14 + span * 3.2)))
	sdf.surfaceNets(tree, boundsForTree(tree), res, out, { creaseAngle: 32, seal: true })

	// Every actor in the roster has been painted with one of two appearances, because
	// `surfaceNets` calls `addVertex` with six arguments so the zone defaults to 0 and no
	// generator has ever called `setZone` — while `shaders.ts` has been selecting on that
	// zone the whole time. The layers exist, the shader path works, and nothing fed it.
	applyZones(out, zoneScratch)

	// An actor that meshes to nothing must not reach `render.upload` as a placeholder.
	//
	// This threw one layer later, in the uploader, was caught by the per-slot guard in
	// `units`, and became a console warning that a browser shows to nobody — which is how
	// lattice_spectra drew a five-class placeholder hull all session with every gate green.
	// Failing here names the actor and the resolution it failed at, which is the pair a
	// reader needs.
	if (out.vertexCount === 0) {
		throw new Error(
			`units: '${slot.name}' meshed to ZERO vertices at res ${res} — its geometry is ` +
			'finer than one cell of the mesher grid. Either the generator is building nothing ' +
			'or the actor is too small for its resolution; both are defects, not a fallback.',
		)
	}
	if (trackedTurretScratch.length > 0 || wheelScratch.length > 0) {
		const rig = bindMachineRig(out, p, trackedTurretScratch, wheelScratch, slot.name)
		if (metadata) metadata.rig = rig
	} else if (legScratch.length > 0) {
		rigSkip.reason = null
		const rig = bindInfantryGait(out, p, legScratch, slot.name, rigSkip)
		if (metadata) {
			metadata.rig = rig
			metadata.rigSkipReason = rigSkip.reason
		}
	}

	// NO GREEBLE HERE, and it was tried and MEASURED rather than skipped.
	//
	// `geo/greeble` was wired in on this path — panel lines, rivets, hatches, vents and weld
	// seams, budgeted by `greebleBudget`, which is derived from the actor's cost and still has
	// no consumer. It works, both faction presets are already hash-affirmed against §9.1, and
	// it is exactly the "tuning numbers become art direction" idea §14.13 asks for.
	//
	// It is not here because at GAMEPLAY ZOOM it is invisible, and §7.1 prices features rather
	// than admiring them. A/B through `tools/unitlook`, 48 clustered actors:
	//
	//              with greeble   without
	//   mask px       4157          4097
	//   saturation    0.2213        0.2219
	//   value         0.346         0.346
	//   p95 value     0.5137        0.5137
	//
	// Saturation, value and p95 identical to four decimals. The cost was +0.40 ms p50 and
	// triangles 818,703 -> 1,720,143 at the 200-unit reference workload — 9.5% of the frame
	// budget's headroom, and boot 500 -> 827 ms, to change 1.3% of unit pixels and nothing
	// measurable about how they look. Greeble features are ~2 cm on a 2.4 m hull, which is
	// sub-pixel at the camera this game is played at.
	//
	// WHAT WOULD MAKE IT WORTH IT: LOD. `mesh.ts:1195 generateLodChain()` is a finished
	// seam-aware QEM decimator with zero callers, and greeble belongs on LOD0 only, paid for
	// when the camera is close enough to resolve it. Wire the two together and this comes
	// back; adding it unconditionally is paying every frame for detail nobody can see.
	projectBoxUv(out)
	const unitFamily = slot.family !== Family.plant && slot.family !== Family.emplacement
	const maintainedFaction = slot.faction === Faction.foundry || slot.faction === Faction.lattice
	markStatusStripCoordinates(out, unitFamily && maintainedFaction)
	// AFTER the projection, for the same reason as the class path: tangents are derived from
	// uv0 and surface nets leaves it at zero.
	out.computeTangents()
	return out
}

/** Which surface set an actor's faction paints with. */
export function setForFaction(faction: number): string {
	return faction === 0 ? 'foundry' : faction === 1 ? 'lattice' : 'drift'
}
