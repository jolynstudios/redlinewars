import { Attachments, PRESENTATION_BINDINGS } from './attachments'
import { PresentationMotion, AirspaceClearance, MOTION_PROFILES } from './presentation-motion'
// STEELSEED — units
// Draws the simulation's actors. Reads §4.5 and nothing else.
//
// Live positions, facings, ownership and health come from the snapshot every tick. The
// bounded death-visual cache is disposable presentation history, triggered only by actual
// destruction events; it cannot move or resurrect a gameplay actor. See the September 2026
// architecture amendment. No client code predicts damage or integrates live movement.
//
// One hull per silhouette CLASS, not per actor type. The mod has two dozen actor types and
// §9.1's requirement is that the two factions are separable in monochrome at max zoom-out —
// a requirement about factions, not about individual vehicles. Five hulls satisfy it, cost
// five meshes instead of twenty-four, and leave per-type detail to a later pass.

import type { AircraftVisualEvent } from '../core/events'
import { ActorAnimationState, ActorFlag, CoreEvent, HeaderFlag, canvasCssHeight, canvasCssWidth, findActorIndex, lerpFacing, ShroudState, SimEvent, SIM_TICK_HZ, type Ctx, type Snapshot, type SnapshotEvent, wangleToRadians } from '../core'
import { Mesh } from '../geo/mesh'
import { deserializeMesh, lodDigest, readLodBundle, serializeMesh, writeLodBundle, type SerializedMesh } from '../core/lod-cache'
import {
	computeSkinMatrices,
	computeWorldTransforms,
	setBoneAngle,
	setBoneKick,
	BoneKind,
	type Pose,
	type Skeleton,
} from '../geo/rig'
import { EnvironmentScenery } from './environment'
import { LivingScenery } from './living'
import { GrassScatter } from './grass'
import { MechanicalClock } from './mechanical-clock'
import { runningGearProfile, packRunningPhases, type RunningGearProfile } from './running-gear'
import { DeathVisuals } from './death-visuals'
import { loadHumanAssets } from './human-assets'
import { loadRolePacks, type RolePack } from './role-assets'
import { loadRikiAssets, poseRiki, RIKI_MATERIAL, type RikiAssets } from './riki-assets'
import { RIFLE_FAMILY_ACTORS, RIFLE_PACK, assignRoleSlots, rolePackFlagState } from '../core/role-pack'
import { loadTreeAssets } from './tree-assets'
import { loadTrackAssets } from './track-assets'
import { overlayHumanMotionClip, sampleHumanMotion, validateHumanMotionPose, type HumanMotionClip, type HumanTimedClip } from './human-motion'
import { aircraftClearanceAltitude, isFlatAircraftSource } from './aircraft-clearance'
import RA_VISUAL_MANIFEST from '../core/ra-visual-manifest.json'
import { vfxBudgetFor } from '../fx/vfx-budget'
import ROSTER from './archetype/roster.json'
import { BLENDER_HIDDEN_ACTORS, decodeBlenderAsset, loadBlenderAssets } from './blender-assets'
import { DamageStates, RUNG_COUNT, loadDamageStates } from './damage-states'
import { yieldCooperatively } from './cooperative-yield'
import { DeploymentRig, DeploymentStates, settleDeploymentBasis } from './deployment-rig'

import { Family, type RosterSlot } from './archetype/params'

/**
 * Actors the MakeHuman fallback figure is honestly the right body for. Both are Rifle Infantry
 * carrying the same M1 Carbine, so both may fall back to it when the planx-rifle pack is off or
 * refused. Every other infantry type wears its own role pack or its roster model, never this
 * one: in an RTS a unit's silhouette is how a player identifies what it does, so drawing a
 * rocket soldier with a rifle is a gameplay defect, not an art one.
 */
const RIFLE_INFANTRY = RIFLE_FAMILY_ACTORS
const E2_SOVIET_MATERIAL = 'planx-troop-e2.soviet-v1'
const SOVIET_FACTIONS = new Set(['soviet', 'russia', 'ukraine'])
import {
	DEFAULT_HALF_EXTENT,
	type HeightProbe,
	applyFitScale,
	placeActor,
	placeActorAtLevel,
	submergedWaterOffset,
	waterSupportMinY,
} from '../core/place'
import { occupancyMeters, fitScaleForMesh, supportHalfExtents } from './occupancy'
import { warzoneSeed, warzoneCondition, warzoneSurfaceDamage } from './warzone-condition'
import {
	buildUnitFromSlot,
	type UnitBuildMetadata,
	type UnitRig,
	setForFaction,
	buildUnit,
	classForType,
	headlampMountForClass,
	isVehicleType,
	setForClass,
	UnitClass,
	UNIT_CLASS_COUNT,
	UV_METRES,
} from './shapes'
import type { AnimApi, DrawItem, GpuMesh, MaterialsApi, RenderApi, ShroudApi, SkyApi, TerrainApi } from './types'

/** Silhouette used when a phone cannot keep the authored mesh for this actor. */
function hullClassForFamily(family: string | undefined): UnitClass {
	switch (family) {
		case 'structure':
		case 'tracked':
			return UnitClass.foundryMedium
		case 'wheeled':
		case 'vessel':
			return UnitClass.foundryLight
		case 'infantry':
			return UnitClass.latticeLight
		case 'aircraft':
		case 'plane':
		case 'helicopter':
		case 'rotorcraft':
			return UnitClass.latticeMedium
		default:
			return UnitClass.drift
	}
}

/**
 * Hard cap on drawn actors. §7 budgets draw calls, not actors, and this node costs one
 * draw per CLASS regardless of count — but the instance buffer is per frame and unbounded
 * growth there is how a late-game battle turns into an allocation storm (rule 6).
 */
const MAX_ACTORS = 2048
/**
 * Instances one condition rung can draw. A rung is one authored state of ONE actor, so
 * this is "how many power stations can be at Heavy at once", not "how many actors exist".
 * Five full-size buckets per laddered actor would be 154 KiB each of permanently empty
 * typed array; overflow costs the surplus copies their rung, not their existence.
 */
const DAMAGE_BUCKET_CAPACITY = 256
/** OpenRA's DamageState names, as they appear in the ladder manifest, to rung index. */
const DAMAGE_RUNG_OF_STATE: Readonly<Record<string, number>> =
	{ Undamaged: 0, Light: 1, Medium: 2, Heavy: 3, Critical: 4, Dead: 5 }

interface RaVisualEntry {
	readonly displayName: string
	readonly renderable: boolean
	readonly role: string
	readonly visualFamily: string
	readonly semanticRole: string
	readonly cargo?: number
	readonly traits: readonly { readonly Name: string; readonly Instance: string; readonly Fields: Readonly<Record<string, string>> }[]
	readonly slot: RosterSlot | null
	readonly locomotor?: string
	readonly terrainTypes?: readonly string[]
	/** The rules' Armor.Type ('Tree', 'Wood', 'Heavy', …); absent when the actor has none. */
	readonly armor?: { readonly Type?: string } | null
	readonly production?: {
		readonly types: readonly string[]
	}
}

const RA_ACTOR_VISUALS = (RA_VISUAL_MANIFEST as unknown as { actors: Record<string, RaVisualEntry> }).actors
/** A rules WDist ("XcY" cells and remainder, or a plain integer) in world metres. */
function wdistMetres(value: string | undefined): number {
	if (!value) return 0
	const cells = /^(-?\d+)c(-?\d+)$/.exec(value.trim())
	const w = cells ? Number(cells[1]) * 1024 + Number(cells[2]) : Number(value)
	return Number.isFinite(w) ? w / 1024 : 0
}
/**
 * Share of the rules' barrel recoil the whole turret kicks back. These models skin the gun to the
 * turret bone (no barrel bone of its own), so the turret carries a reduced kick as a proxy for the
 * barrel's. A model rigged with a `turret.<i>.barrel.<j>` bone would recoil that bone in full.
 */
const TURRET_KICK_SHARE = 0.6
/** Seconds the kick holds at full travel before the rules' RecoilRecovery returns it. */
const RECOIL_HOLD_S = 0.03

function hasRaTrait(entry: RaVisualEntry | undefined, name: string): boolean {
	return entry?.traits.some(trait => trait.Name === name) ?? false
}

/** OpenRA production category shown by the selected producer, or -1 for non-producers. */
function productionKind(entry: RaVisualEntry | undefined): number {
	const types = entry?.production?.types ?? []
	if (types.some(type => /Building|Defense/i.test(type))) return 0
	if (types.some(type => /Infantry|Soldier/i.test(type))) return 1
	if (types.some(type => /Vehicle/i.test(type))) return 2
	if (types.some(type => /Aircraft|Plane|Helicopter/i.test(type))) return 3
	if (types.some(type => /Ship|Boat|Submarine|Naval/i.test(type))) return 4
	return -1
}

/** Mobile construction actors must never inherit an armed wheeled-combat silhouette. */
function isMobileConstructionVisual(entry: RaVisualEntry | undefined): boolean {
	return entry?.semanticRole === 'mcv' || entry?.visualFamily === 'wheeled' &&
		hasRaTrait(entry, 'BaseBuilding') && hasRaTrait(entry, 'Transforms')
}

function familyName(family: Family): string {
	switch (family) {
		case Family.tracked: return 'tracked'
		case Family.wheeled: return 'wheeled'
		case Family.infantry: return 'infantry'
		case Family.rotorcraft: return 'rotorcraft'
		case Family.fixedwing: return 'fixedwing'
		case Family.vessel: return 'vessel'
		case Family.plant: return 'structure'
		case Family.emplacement: return 'terrain-prop'
	}
}

/** WPos is 1024 per cell and one cell is one metre (§12.4). */
const WPOS_TO_M = 1 / 1024
/** More than any actor moves in one tick: a jump this long is a chronoshift, drawn without a slide. */
const TELEPORT_WPOS = 3 * 1024
/**
 * Peak leg swing from vertical, radians — about 21 degrees.
 *
 * A walking human's thigh swings roughly 20-25 degrees either side, and at RTS zoom the whole
 * signal is that the two legs alternate. Larger looks like running and reads as a glitch on a
 * unit the sim says is walking; smaller stops being visible at all.
 */
const GAIT_SWING = 0.37

/**
 * Headlamps use the renderer's existing isotropic point-light contract.
 *
 * One emitter represents the overlapping pool from the two physical SDF housings. Two
 * emitters per vehicle would request 400 lights in the 200-unit gate and violate high's
 * 256-light budget before muzzle flashes or explosions exist. A true forward cone needs
 * a future §12.2 spotlight amendment; do not fake one with this packed light shape.
 */
const HEADLAMP_R = 1
const HEADLAMP_G = 0.58
const HEADLAMP_B = 0.28
const HEADLAMP_INTENSITY = 0.18
const HEADLAMP_RADIUS = 6.5

/**
 * Lamps respond to the sky's actual direct + ambient radiance, not clock time. This also
 * turns them on under genuinely dark weather and keeps clear noon at exactly zero.
 */
const HEADLAMP_FULL_BELOW = 0.3
const HEADLAMP_OFF_ABOVE = 1.0

interface ClassBucket {
	readonly cls: UnitClass
	readonly headlamps: boolean
	readonly surfaceSet: string
	/**
	 * Instances this bucket's arrays can hold. Every roster and class bucket is sized for
	 * the full actor cap; a condition rung is not, because five extra full-size buckets per
	 * laddered actor would be megabytes of permanently empty typed array.
	 */
	readonly capacity: number
	mesh: GpuMesh | null
	/** Column-major transforms, 16 floats each. Refilled every frame. */
	instances: Float32Array
	colors: Uint8Array
	/** Stable simulation ids; render uses them only to match last frame's submitted pose. */
	motionIds: Uint32Array
	/** Source-instance palette bases; null means this bucket's mesh is static. */
	paletteBases: Uint16Array | null
	/** Packed source-instance left/right surface phases; null means no moving running gear. */
	phases: Float32Array | null
	/** Source-instance damage, 0 pristine to 1 destroyed. */
	damages: Float32Array
	rig: SlotRig | null
	/** Caster rows the shadow pass draws; `localShadowCasters` bounds `count`. */
	readonly shadow: BucketShadow
	count: number
	readonly item: {
		mesh: GpuMesh
		alphaCutout?: boolean
		surfaceSet: string
		instances: Float32Array
		instanceCount: number
		playerColors: Uint8Array | null
		paletteBases: Uint16Array | null
		motionIds: Uint32Array | null
		boneCount: number
		phases: Float32Array | null
		damages: Float32Array | null
		castsShadow: boolean
	}
}

/**
 * Caster mirror of one bucket: rows for ONLY the actors granted a `localShadowCasters`
 * slot this frame. The shadow pass draws `shadow.item`; the main item draws everyone and
 * casts nothing, so the caster budget is enforced where the instances are built and the
 * renderer never needs to know the knob exists.
 */
interface BucketShadow {
	instances: Float32Array
	colors: Uint8Array
	motionIds: Uint32Array
	paletteBases: Uint16Array | null
	phases: Float32Array | null
	damages: Float32Array
	count: number
	item: {
		mesh: GpuMesh | null
		alphaCutout?: boolean
		surfaceSet: string
		instances: Float32Array
		instanceCount: number
		playerColors: Uint8Array | null
		paletteBases: Uint16Array | null
		motionIds: Uint32Array | null
		boneCount: number
		phases: Float32Array | null
		damages: Float32Array | null
		castsShadow: true
	}
}
/** Allocate a bucket's caster mirror. Same mesh, own arrays, budget-selected rows. */
function makeShadowBucket(mesh: GpuMesh, capacity: number, paletteBases: Uint16Array | null, phases: Float32Array | null, alphaCutout: boolean | undefined): BucketShadow {
	return {
		instances: new Float32Array(capacity * 16),
		colors: new Uint8Array(capacity),
		motionIds: new Uint32Array(capacity),
		paletteBases: paletteBases === null ? null : new Uint16Array(capacity),
		phases: phases === null ? null : new Float32Array(capacity),
		damages: new Float32Array(capacity),
		count: 0,
		item: {
			mesh,
			alphaCutout,
			surfaceSet: '',
			instances: new Float32Array(0),
			instanceCount: 0,
			playerColors: null,
			paletteBases: null,
			motionIds: null,
			boneCount: 0,
			phases: null,
			damages: null,
			castsShadow: true,
		},
	}
}

interface SlotRig {
	readonly skeleton: Skeleton
	readonly pose: Pose
	readonly world: Float32Array
	readonly turretBones: Int32Array
	readonly wheelBones: Int32Array
	readonly wheelRadii: Float32Array
	readonly legBones: Int32Array
	readonly legPhase: Float32Array
	strideM: number
	readonly rotorBones: Int32Array
	readonly rotorSpeeds: Float32Array
	readonly oscillatorBones: Int32Array
	readonly oscillatorSpeeds: Float32Array
	readonly oscillatorPhases: Float32Array
	readonly oscillatorAmplitudes: Float32Array
	readonly windBones: Int32Array
	readonly windSpeeds: Float32Array
	readonly windPhases: Float32Array
	readonly windAmplitudes: Float32Array
	readonly doorBones: Int32Array
}

/**
 * Mutable caller-owned record filled by `captureActorVisual`.
 *
 * Wrecks need the exact production mesh that was visible one frame ago. Returning a newly
 * allocated object from an event handler would make a destruction burst allocate in the hot
 * path, so callers retain one record and this method only overwrites its fields.
 */
export interface ActorVisualCapture {
	mesh: GpuMesh | null
	surfaceSet: string
	playerColor: number
	boneCount: number
	paletteBase: number
}

/** Immutable boot-created visual used by the client-only placement ghost. */
export interface PlacementVisual {
	readonly mesh: GpuMesh
	readonly surfaceSet: string
	readonly halfLen: number
	readonly halfWid: number
	readonly water: boolean
}

/**
 * Wrap a decoded rig in the per-slot animation record.
 *
 * Every bucket that can articulate builds one, including each rung of a condition ladder:
 * the rungs share a byte-identical bone array but NOT their animation lists, because a
 * levelled plant does not spin its turbine and a burnt-out hull does not traverse its
 * empty turret ring. One factory, so a new animated channel cannot reach live actors and
 * silently miss their damaged states.
 */
/** Bottom-hinged cargo ramp: π/2 plus a little extra so the lip meets the ground. */
const RAMP_OPEN_RAD = Math.PI * 0.58
const RAMP_SLEW = 1.6
const RAMP_HOLD_S = 2.5

const FLAG_BY_FACTION: Record<string, string> = {
	england: 'england', france: 'france', germany: 'germany',
	soviet: 'soviet', russia: 'russia', ukraine: 'ukraine',
}

/**
 * Buildings and tanks carry one cloth chain per national design. Show the owner's
 * flag and collapse the rest to zero scale so they occupy no pixels.
 */
function applyOwnerFlag(rig: SlotRig, faction: string): boolean {
	const names = rig.skeleton.names
	let hasFlags = false
	let hasWanted = false
	const wanted = FLAG_BY_FACTION[faction] ?? 'neutral'
	for (let i = 0; i < names.length; i++) {
		const name = names[i]
		if (!name.startsWith('flag ')) continue
		hasFlags = true
		if (name.startsWith(`flag ${wanted} `)) hasWanted = true
	}
	if (!hasFlags) return false
	const show = hasWanted ? wanted : 'neutral'
	const s = rig.pose.s
	for (let i = 0; i < names.length; i++) {
		const name = names[i]
		if (!name.startsWith('flag ')) continue
		const design = name.slice(5, name.indexOf(' ', 5))
		const vis = design === show ? 1 : 0
		const o = i * 3
		s[o] = vis
		s[o + 1] = vis
		s[o + 2] = vis
	}
	return true
}

function sovietOwner(ctx: Ctx, owner: number): boolean {
	const player = ctx.snapshot?.players[owner]
	return player !== undefined && SOVIET_FACTIONS.has(ctx.actorTypeName(player.factionId).toLowerCase())
}

function toSlotRig(builtRig: UnitRig | null): SlotRig | null {
	return builtRig === null ? null : {
		skeleton: builtRig.skeleton,
		pose: builtRig.skeleton.createPose(),
		world: builtRig.skeleton.createMatrixBuffer(),
		turretBones: builtRig.turretBones,
		wheelBones: builtRig.wheelBones,
		wheelRadii: builtRig.wheelRadii,
		legBones: builtRig.legBones,
		legPhase: builtRig.legPhase,
		strideM: builtRig.strideM,
		rotorBones: builtRig.rotorBones ?? new Int32Array(0),
		rotorSpeeds: builtRig.rotorSpeeds ?? new Float32Array(0),
		oscillatorBones: builtRig.oscillatorBones ?? new Int32Array(0),
		oscillatorSpeeds: builtRig.oscillatorSpeeds ?? new Float32Array(0),
		oscillatorPhases: builtRig.oscillatorPhases ?? new Float32Array(0),
		oscillatorAmplitudes: builtRig.oscillatorAmplitudes ?? new Float32Array(0),
		windBones: builtRig.windBones ?? new Int32Array(0),
		windSpeeds: builtRig.windSpeeds ?? new Float32Array(0),
		windPhases: builtRig.windPhases ?? new Float32Array(0),
		windAmplitudes: builtRig.windAmplitudes ?? new Float32Array(0),
		doorBones: doorBonesOf(builtRig.skeleton),
	}
}

function doorBonesOf(skeleton: Skeleton): Int32Array {
	const n = skeleton.countOfKind(BoneKind.door)
	const bones = new Int32Array(n)
	for (let i = 0; i < n; i++) bones[i] = skeleton.boneOfKind(BoneKind.door, i)
	return bones
}

/** Fill a bucket's DrawItem and hand it to render. Shared by both bucket sets. */
function submitBucket(render: RenderApi, b: ClassBucket | null): void {
	if (!b || b.count === 0 || !b.mesh) return
	const it = b.item as { -readonly [K in keyof DrawItem]: DrawItem[K] }
	it.surfaceSet = b.surfaceSet
	it.instances = b.instances
	it.instanceCount = b.count
	it.playerColors = b.colors
	it.paletteBases = b.paletteBases
	it.motionIds = b.motionIds
	it.boneCount = b.rig?.skeleton.boneCount ?? 0
	it.phases = b.phases
	it.damages = b.damages
	render.submit(b.item as DrawItem)
	if (b.shadow.count > 0) {
		const st = b.shadow
		const sit = st.item as { -readonly [K in keyof DrawItem]: DrawItem[K] }
		sit.mesh = b.mesh
		sit.alphaCutout = it.alphaCutout
		sit.surfaceSet = b.surfaceSet
		sit.instances = st.instances
		sit.instanceCount = st.count
		sit.playerColors = st.colors
		sit.paletteBases = st.paletteBases
		sit.motionIds = st.motionIds
		sit.boneCount = it.boneCount
		sit.phases = st.phases
		sit.damages = st.damages
		render.submit(st.item as DrawItem)
	}
}

/**
 * Roster semantic roles that move under their own power: the only actors granted a
 * `localShadowCasters` slot. Mirrors the UI's HEAT_ROLES (troops plus harvester);
 * structures, walls, crates, wrecks and system actors never reach the mirror.
 */
const MOBILE_ROLES: ReadonlySet<string> = new Set(['soldier', 'tracked-vehicle', 'wheeled-vehicle', 'mcv',
	'rotorcraft', 'fixed-wing', 'ship', 'submarine', 'transport', 'minelayer', 'harvester'])

export class Units {
	private readonly living = new LivingScenery()
	private readonly grass = new GrassScatter()
	get livingStats() { return this.living.stats }
	static id = 'units'
	static deps = ['render', 'materials', 'terrain', 'sky', 'anim', 'shroud']

	/** Unit instances granted a shadow-caster slot this frame; 0 disables unit casters. */
	private casterBudget = 0
	private render: RenderApi | null = null
	private terrain: TerrainApi | null = null
	private readonly scenery = new EnvironmentScenery()
	private readonly deaths = new DeathVisuals()
	/** §14 condition ladder. Owns rung selection and the cross-fade; see units/damage-states. */
	private readonly damage = new DamageStates()
	/** Settles when optional damage meshes are fully uploaded, before any world may start. */
	private damageLaddersReady: Promise<void> = Promise.resolve()
	readyForMatch(): Promise<void> { return this.damageLaddersReady }
	get damageStats() { return this.damage.stats }
	get deathStats() { return this.deaths.stats }
	private deathContext: Ctx | null = null
	private offDeath: (() => void) | null = null
	private offNewWorld: (() => void) | null = null
	/** Cargo-door open amount 0..1, keyed by actor id. */
	private readonly rampOpen = new Map<number, number>()
	private readonly lastCargo = new Map<number, number>()
	private readonly rampHoldUntil = new Map<number, number>()
	private readonly deathTransform = new Float32Array(16)
	private readonly viewQuad = new Float32Array(8)
	/** Set only for large battles. Small matches and gates draw every actor. */
	private viewCull: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null
	private readonly deathCapture: ActorVisualCapture = { mesh:null,surfaceSet:'',playerColor:0,boneCount:0,paletteBase:0 }
	get sceneryStats() { return this.scenery.stats }
	/** See `EnvironmentScenery.drawnOffsetOf`: the witness that scenery is spent around the viewer. */
	sceneryDrawnOffset(id: string) { return this.scenery.drawnOffsetOf(id) }
	/** See `EnvironmentScenery.countNear`. */
	sceneryCountNear(id: string, x: number, z: number, r: number) { return this.scenery.countNear(id, x, z, r) }
	private materials: MaterialsApi | null = null
	private sky: SkyApi | null = null
	private anim: AnimApi | null = null
	/** Turret kick per actor type from its turreted armament's Recoil and RecoilRecovery. */
	private readonly turretKickByType = new Map<string, { metres: number; recoveryS: number } | null>()
	private turretKickOf(slot: string): { metres: number; recoveryS: number } | null {
		const cached = this.turretKickByType.get(slot)
		if (cached !== undefined) return cached
		let kick: { metres: number; recoveryS: number } | null = null
		for (const trait of RA_ACTOR_VISUALS[slot]?.traits ?? []) {
			if (trait.Name !== 'Armament' || !trait.Fields.Turret) continue
			const recoil = wdistMetres(trait.Fields.Recoil)
			if (recoil <= 0) continue
			const perTick = wdistMetres(trait.Fields.RecoilRecovery)
			kick = { metres: recoil * TURRET_KICK_SHARE, recoveryS: perTick > 0 ? recoil / perTick / 25 : 0.15 }
			break
		}
		this.turretKickByType.set(slot, kick)
		return kick
	}
	private humanMotion: { rig: SlotRig; clip: HumanMotionClip; scale: number
		aim: HumanTimedClip | null; fire: HumanTimedClip | null } | null = null
	/**
	 * Every rig built from the authored human source. This is a SET, not the single rig on
	 * `humanMotion`, because that field holds whichever anatomical slot was built last: with two
	 * such slots the earlier one silently fell through to the legacy sine-hip gait, and its
	 * skinning palette stopped matching the authored clip. The identity test was the reason a
	 * second anatomical infantry type could not be added at all.
	 */
	private readonly humanRigs = new Set<SlotRig>()
	private rikiAssets: RikiAssets | null = null
	private readonly rikiRigs = new Set<SlotRig>()
	private readonly posedRifleMuzzles = new Map<number, Float32Array>()

	private readonly buckets: (ClassBucket | null)[] = new Array(UNIT_CLASS_COUNT * 2).fill(null)
	/**
	 * §14.13 archetype buckets, one per ROSTER SLOT, keyed by actor name.
	 *
	 * Parallel to the class buckets rather than replacing them: an actor the roster does not
	 * describe still has to draw something (rule 8), and a silently undrawn army is far
	 * harder to diagnose than a wrongly-shaped one.
	 */
	private readonly slotBuckets = new Map<string, ClassBucket>()
	/**
	 * How each slot meets the ground: its footprint half-extents, and whether it flies.
	 *
	 * The half-extents are where the terrain gets SAMPLED. A single sample at the actor's
	 * centre cannot see a slope, so every vehicle stood bolt upright on a hillside with its
	 * uphill corner buried and its downhill corner in the air. Four corner samples give a
	 * plane, and a plane is what a machine actually rests on.
	 */
	private readonly runningGear = new Map<string, RunningGearProfile>()
	private readonly ambientBuildingSeeds = new Map<string, number>()
	private readonly slotGround = new Map<string, { halfLen: number, halfWid: number, airborne: boolean, fitScale: number }>()
	/** typeId -> roster slot name, memoised. Resolved through ctx.actorTypeName, never typeId. */
	private readonly typeSlot = new Map<number, string | null>()
	/** Actor id -> its last placed bucket slot, for O(1) captureActorVisual. Validated on read. */
	private readonly placementIndex = new Map<number, { bucket: ClassBucket | null; index: number }>()
	private readonly mechanicalClock = new MechanicalClock()
	/** Authoritative new-actor deployment records; no same-ID/proximity inference. */
	private readonly deploymentStates = new DeploymentStates()
	private readonly deploymentRigs = new Map<SlotRig, DeploymentRig>()
	private readonly deploymentSource = new Float64Array(5)
	private readonly deploymentMatrix = new Float32Array(16)
	private flatAircraftSource = false
	private archetypeCount = 0
	/**
	 * Slots that failed to build, retained by NAME.
	 *
	 * Retained rather than logged-and-forgotten so a harness can assert on it: a boot warning
	 * scrolls away, and the actor then draws as a class hull for the whole session with
	 * nothing to distinguish it from an actor that never had a slot.
	 */
	readonly droppedSlots: string[] = []
	/** Actors eligible for a rig that could not have one, with the measured reason. */
	readonly unriggedSlots: string[] = []
	/**
	 * Actor -> the anatomical role pack it draws (pack id), retained for the same reason as
	 * `droppedSlots`: an actor on its roster model looks exactly like an actor whose pack was
	 * refused, and only this map plus `forgeStats.errors` tells a harness which one it is.
	 */
	readonly roleActors = new Map<string, string>()
	/** typeId -> class, memoised. The table is read once and never changes in a session. */
	private readonly typeClass = new Map<number, UnitClass>()
	/** typeId -> real roster category. IDs are first-seen, so classification is name-based. */
	private readonly typeVehicle = new Map<number, boolean>()
	/** typeId -> mobile actor (semanticRole in MOBILE_ROLES): the only caster candidates. */
	private readonly typeMobile = new Map<number, boolean>()
	/** 0 infantry footsteps · 1 light wheeled · 2 heavy tracked · 3 watercraft. */
	private readonly typeMovementClass = new Map<number, number>()

	/** Audible weight class for the movement mixer. Defaults to light when unknown. */
	movementClass(typeId: number): number {
		return this.typeMovementClass.get(typeId) ?? 1
	}

	/** Gameplay-derived placement roles from the generated OpenRA visual manifest. */
	private readonly typeWatercraft = new Map<number, boolean>()
	private readonly typeWaterStructure = new Map<number, boolean>()
	private readonly typeSubmersible = new Map<number, boolean>()
	/** Explicit v2 renderability; system/proxy actors never acquire a visible fallback. */
	private readonly typeRenderable = new Map<number, boolean>()
	/**
	 * typeId -> this actor's own OpenRA visibility contract is EXPLORED, not fog.
	 *
	 * `^Tree`, `^TreeHusk` and `^Rock` carry `HiddenUnderShroud`, which reveals on explored
	 * ground and has no fog term; units carry `HiddenUnderFog` and buildings `FrozenUnderFog`.
	 * Read from the generated manifest so the client mirrors the actor's own rule instead of
	 * applying one blunt fog test to every class — two clocks that cannot be kept in agreement.
	 */
	private readonly typeShroudOnly = new Map<number, boolean>()
	/** Lower-case Armor.Type per actor type, for what a strike throws (fx: wood off a tree). */
	private readonly typeMaterial = new Map<number, string>()
	private warnedOverflow = false
	/**
	 * Bound once in init against the resolved terrain, not per actor per frame. `placeActor`
	 * takes the probe as an argument so the gate can hand it a synthetic terrain, and a fresh
	 * closure per call would allocate 800 times a frame against rule 6.
	 */
	private shroud: ShroudApi | null = null
	private readonly attachments = new Attachments()
	private readonly presentationMotion = new PresentationMotion()
	private readonly airspace=new AirspaceClearance()
	private readonly flightHeight=(x:number,z:number)=>this.airspace.height(x,z,this.heightProbe(x,z))
	private heightProbe: HeightProbe = () => 0
	/** Retained diagnostic state: no allocation in update(), and attribution stays local. */
	readonly headlampStats = {
		vehicles: 0,
		lights: 0,
		factor: 0,
		skyLightLevel: 0,
	}
	/** Retained, allocation-free diagnostics for animation gates and palette overflow review. */
	readonly skinStats = {
		riggedSlots: 0,
		chassisVertices: 0,
		turretVertices: 0,
		posedActors: 0,
		bindPoseActors: 0,
		paletteOverflows: 0,
		/** Instances written into caster mirrors this frame (`localShadowCasters` budget). */
		casters: 0,
		/** Actors skipped whole-pose because their cell is not visible to the local player. */
		shroudCulled: 0,
	}
	/** Build-time forge proof diagnostics. Fallback remains the normal procedural generator. */
	readonly forgeStats = {
		available: 0,
		loaded: 0,
		fallback: 0,
		bytes: 0,
		vertices: 0,
		triangles: 0,
		hidden: 0,
		errors: [] as string[],
	}
	/** Last-known OpenRA FrozenUnderFog structures submitted in the current frame. */
	readonly frozenStats = { drawn: 0 }

	async init(ctx: Ctx): Promise<void> {
		this.deathContext = ctx
		this.render = ctx.get<RenderApi>('render')
		this.terrain = ctx.get<TerrainApi>('terrain')
		{
			// Captured non-null here so the per-frame path has no null check and no `!`.
			const terrain = this.terrain
			this.heightProbe = (wx, wz) => terrain.heightAt(wx, wz)
		}
		this.shroud = ctx.get<ShroudApi>('shroud')
		// Quality-authored unit caster budget. LOW grants zero: the shadow pass draws no
		// unit instances there, only terrain, buildings and scenery casters remain.
		this.casterBudget = Math.max(0, Math.floor(ctx.config.q.localShadowCasters))
		await this.scenery.init(this.render, ctx)
		await this.living.init(this.render)
		await this.grass.init(this.render, ctx)
		this.materials = ctx.get<MaterialsApi>('materials')
		this.sky = ctx.get<SkyApi>('sky')
		this.anim = ctx.get<AnimApi>('anim')

		// Rule 10: every mesh exists before frame 1. Hulls are a pure function of
		// (class, seed), so they can all be built here without knowing which actor types
		// the map will contain — which is the point of keying on class rather than type.
		const scratch = new Mesh()
		for (let variant = 0; variant < 2; variant++) {
			for (let c = 0; c < UNIT_CLASS_COUNT; c++) {
				const cls = c as UnitClass
				const headlamps = variant === 1
				// Drift is wreckage rather than a vehicle. It has no lamp mount, so a second
				// byte-identical mesh would consume boot time and GPU memory for no caller.
				if (headlamps && !headlampMountForClass(cls)) continue
				const rng = ctx.rng.forkNamed(`units/hull/${c}`)
				buildUnit(scratch, cls, rng, headlamps)
				const set = setForClass(cls)
				const mesh = this.render.upload(
					scratch,
					`units:hull:${c}:${headlamps ? 'lamps' : 'plain'}`,
				)

				// Both variants use the SAME named stream. Their base hull stays byte-identical;
				// the only geometry difference is the deterministic pair of lamp housings.
				const bucketIndex = c + variant * UNIT_CLASS_COUNT
				this.buckets[bucketIndex] = {
					cls,
					headlamps,
					// Fall back to a set that certainly exists rather than name one materials
					// never forged: an unknown surfaceSet is dropped by render, and a silently
					// undrawn army is far harder to diagnose than a wrongly-painted one (rule 8).
					surfaceSet: this.materials.has(set) ? set : 'foundry',
					mesh,
					// Sized to the cap HERE, not grown on demand in update(). A growth path in a
					// per-frame method is the allocation storm rule 6 exists to prevent.
					capacity: MAX_ACTORS,
					instances: new Float32Array(MAX_ACTORS * 16),
					colors: new Uint8Array(MAX_ACTORS),
					motionIds: new Uint32Array(MAX_ACTORS),
					paletteBases: null,
					damages: new Float32Array(MAX_ACTORS),
					phases: null,
					rig: null,
					count: 0,
					shadow: makeShadowBucket(mesh, MAX_ACTORS, null, null, undefined),
					item: {
						mesh,
						surfaceSet: set,
						instances: new Float32Array(0),
						instanceCount: 0,
						playerColors: null,
						paletteBases: null,
						motionIds: null,
						boneCount: 0,
						phases: null,
						damages: null,
						castsShadow: false,
					},
				}
			}
		}
		// --- §14.13 archetype hulls -------------------------------------------
		// One mesh per roster slot, built from that slot's own functional numbers. Rule 10
		// still holds: every mesh exists before frame 1, because the roster is a committed
		// table rather than something the snapshot discovers.
		// A narrow phone dies at this step. The boot bar sits at 45% for the whole of it,
		// and Safari reloads until it reports that a problem kept happening. The authored
		// roster inflates to about 250 MB before a single actor is drawn. Class hulls
		// above are enough to open the lobby and play a match on that screen.
		const phoneUa = /iPhone|iPod|Android.+Mobile/i.test(globalThis.navigator?.userAgent ?? '')
		const shortSide = Math.min(globalThis.screen?.width ?? 9999, globalThis.screen?.height ?? 9999)
		const coarse = typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(pointer: coarse)').matches
		const narrowPhone = phoneUa || (coarse && shortSide <= 520)
		if (narrowPhone) console.warn('[units] narrow phone: authored models skipped')
		if (!narrowPhone) {
		const fixtureSlots = (ROSTER as { slots: RosterSlot[] }).slots
		const raSlots = Object.values(RA_ACTOR_VISUALS)
			.filter(actor => actor.renderable && actor.slot !== null)
			.map(actor => actor.slot!)
		const slots = [...fixtureSlots, ...raSlots]
		let blender: Awaited<ReturnType<typeof loadBlenderAssets>> = null
		try { blender = await loadBlenderAssets() }
		catch (error) {
			this.forgeStats.errors.push(String(error))
			console.warn(`[units] Blender assets unavailable; using procedural geometry: ${String(error)}`)
		}
		if (blender) this.forgeStats.available = Object.values(blender.manifest.assets).filter(a => !a.hidden).length
		// Complete authored tree chains are boot-only. A declared chain must never
		// silently fall back to QEM, which can remove entire wind-owned branches.
		const treeAtlasSource = this.materials.has('foliage-v1') ? this.materials.get('foliage-v1').sourceSha256 : undefined
		// No foliage atlas (WebGL2 path, or the forge ran inert) means no authored
		// trees: loading with an empty source binding is guaranteed to throw and take
		// the whole boot down. QEM/procedural fallback keeps the world populated.
		const noforge = new URLSearchParams(globalThis.location?.search ?? '').get('noforge')
		const trees = noforge === '1' || !treeAtlasSource ? null : await loadTreeAssets(treeAtlasSource)
		if (trees) for (const [name, tree] of Object.entries(trees.assets)) {
			const roster = blender?.manifest.assets[name]
			if (!roster || roster.hidden || roster.template !== 'tree' ||
				roster.sourcePath !== tree.manifest.parentSourcePath || roster.sourceSha256 !== tree.manifest.parentSourceSha256)
				throw new Error(`Authored tree ${name} does not match its canonical roster source`)
		}
		// The anatomical figure is what a rifleman is now made of. `humanunits=0` restores the
		// procedural box and fetches none of these packs; `humanunits=1` additionally makes a
		// missing or invalid pack fatal, which is what the experiment gates assert against.
		// On the ordinary path a missing pack must cost a player their soldier's silhouette,
		// never their whole game, so it degrades to the procedural figure the way Blender
		// assets above already do.
		const humanFlag = new URLSearchParams(globalThis.location?.search ?? '').get('humanunits')
		const humanRequired = humanFlag === '1'
		let human: Awaited<ReturnType<typeof loadHumanAssets>> = null
		if (humanFlag !== '0') {
			try {
				if (!this.materials.has('infantry-v1')) throw new Error('the unique-UV atlas is absent')
				const atlasSource = this.materials.get('infantry-v1').sourceSha256
				if (!atlasSource) throw new Error('the atlas is missing its source binding')
				human = await loadHumanAssets(atlasSource)
				if (!human) throw new Error('there is no authored LOD/motion pack')
			} catch (error) {
				if (humanRequired) throw error
				this.forgeStats.errors.push(`anatomical infantry: ${String(error)}`)
				console.warn(`[units] anatomical infantry unavailable, using the procedural figure: ${String(error)}`)
				human = null
			}
		}
		// One saved body per infantry role (units/role-assets). Every pack shares the MakeHuman
		// bind rig and the one walk/aim/fire set by exact identity, so `human` is each pack's
		// reference and no pack loads without it. The rifle keeps e1/e1r1 under `rifleunits`;
		// every other role answers to `roleunits`. `=0` fetches nothing, `=1` makes any refusal
		// fatal. On the ordinary path a refused pack costs its actors their new body -- they draw
		// their roster model, never the rifleman's figure -- and the reason is logged once, here.
		const studyQuery = new URLSearchParams(globalThis.location?.search ?? '')
		const rifleFlag = studyQuery.get('rifleunits'), roleFlag = studyQuery.get('roleunits')
		const roleBodies = new Map<string, RolePack>()
		if (human) {
			const materials = this.materials
			const roles = await loadRolePacks(human, id => materials.has(id) ? materials.get(id).sourceSha256 : undefined,
				(dir, slots) => rolePackFlagState(slots, rifleFlag, roleFlag) !== 'off')
			for (const { dir, slots, reason } of roles.failures) {
				if (rolePackFlagState(slots, rifleFlag, roleFlag) === 'demanded') throw new Error(reason)
				this.forgeStats.errors.push(`role pack ${dir}: ${reason}`)
				console.warn(`[units] role pack ${dir} unavailable, its actors keep the roster model: ${reason}`)
			}
			if (rifleFlag === '1' && !roles.packs.some(pack => pack.dir === RIFLE_PACK.dir)) throw new Error('Requested rifle profile is absent')
			// Only a rendered human infantry role may wear one; the dog and the ants are infantry
			// to OpenRA too, and a twenty-bone soldier is not their body.
			const assigned = assignRoleSlots(roles.packs, actor => {
				const visual = RA_ACTOR_VISUALS[actor], template = blender?.manifest.assets[actor]?.template
				return visual?.renderable === true && visual.visualFamily === 'infantry' && visual.slot?.family === Family.infantry &&
					(template === undefined || template === 'infantry') && !BLENDER_HIDDEN_ACTORS.has(actor)
			})
			for (const refusal of assigned.refused) {
				if (roleFlag === '1') throw new Error(`Role pack claim refused: ${refusal}`)
				this.forgeStats.errors.push(`role slot ${refusal}`)
				console.warn(`[units] role pack claim refused: ${refusal}`)
			}
			for (const [actor, pack] of assigned.actors) {
				roleBodies.set(actor, pack)
				this.roleActors.set(actor, pack.manifest.id)
			}
		}
		if (roleFlag !== '0' && studyQuery.get('humanunits') !== '0' && studyQuery.get('noforge') !== '1' && this.materials.has(RIKI_MATERIAL)) {
			try {
				this.rikiAssets = await loadRikiAssets(this.materials.get(RIKI_MATERIAL).sourceSha256 ?? '')
				if (this.rikiAssets) this.roleActors.set('e7', RIKI_MATERIAL)
			} catch (error) {
				if (roleFlag === '1') throw error
				this.forgeStats.errors.push(String(error))
				console.warn(`[units] repaired Riki unavailable; keeping her previous authored model: ${String(error)}`)
			}
		}
		const t0 = performance.now()
		const tracks = new URLSearchParams(globalThis.location?.search ?? '').get('noforge') === '1' ? null : await loadTrackAssets()
		if (!tracks && blender?.manifest.assets['1tnk']?.trackLoop)
			throw new Error('Canonical 1tnk requires its declared circulating-track LOD pack')
		if (tracks && blender?.manifest.assets['1tnk']?.sourceSha256 !== tracks.manifest.parentSourceSha256)
			throw new Error('Circulating track source does not match canonical 1tnk roster')
		// Boot LOD cache: the QEM decimation of these slots costs ~12 s of CPU and is a
		// pure function of the base meshes. A bundle whose digest covers every asset's
		// source hash, the roster order, and a quantized digest of each procedurally
		// generated base mesh is reused; anything that changes an input changes the
		// digest and costs one normal rebuild. Authored slots (rigs, packs) take the
		// uploadLods path and never touch the cache. Procedural slots used to
		// contribute nothing but their NAME: the faceted-wall fix shipped while every
		// browser kept LOD chains decimated from the round walls it replaced, which
		// read as the regression returning the moment the camera pulled back.
		const classifySlot = (slot: RosterSlot) => {
			const rolePack = roleBodies.get(slot.name) ?? null
			const rikiSlot = slot.name === 'e7' ? this.rikiAssets : null
			const humanSlot = rikiSlot ? null : rolePack ?? (RIFLE_INFANTRY.includes(slot.name) ? human : null)
			const treeSlot = trees?.assets[slot.name] ?? null
			const trackSlot = slot.name === '1tnk' ? tracks : null
			const authoredSlot = rikiSlot ?? humanSlot ?? treeSlot ?? trackSlot
			const asset = authoredSlot ? authoredSlot.manifest.levels[0] : blender?.manifest.assets[slot.name]
			return { rolePack, rikiSlot, humanSlot, trackSlot, authoredSlot, asset }
		}
		// The base meshes of procedural slots, built once here so their geometry can
		// feed the cache digest and the build loop below can reuse the exact mesh the
		// digest described. The named rng streams make this the same pure function the
		// loop's scratch fallback computes, so a slot that throws here throws there too
		// and takes the loop's visible drop path - prebuilding never invents errors.
		const proceduralSources = new Map<string, { mesh: Mesh; meta: UnitBuildMetadata }>()
		if (blender) {
			for (const slot of slots) {
				if (BLENDER_HIDDEN_ACTORS.has(slot.name)) continue
				const { authoredSlot, asset } = classifySlot(slot)
				if (authoredSlot || (asset && !asset.hidden && this.materials.has('blender'))) continue
				try {
					const meta: UnitBuildMetadata = { rig: null, rigSkipReason: null }
					proceduralSources.set(slot.name, { mesh: buildUnitFromSlot(new Mesh(), slot, ctx.rng.forkNamed(`units/slot/${slot.name}`), meta), meta })
				} catch { /* the build loop reproduces this through its own visible drop path */ }
			}
		}
		const lodCachedSlots = new Map<string, Mesh[]>()
		const lodFresh = new Map<string, SerializedMesh[]>()
		// A cold profile has no IndexedDB bundle. Generating all fallback QEM
		// chains in one turn was measured as a 13-17 s long task. Keep the same
		// deterministic meshes, but yield after each cache miss so the page can
		// paint progress, process input and service bridge messages.
		const yieldAfterFreshLod = yieldCooperatively
		let lodHits = 0
		const lodKey = blender ? lodDigest(blender.manifest.assets, slots.map(slot => slot.name), new Map([...proceduralSources].map(([name, built]) => [name, built.mesh]))) : ''
		const cachedBundle = blender ? await readLodBundle(lodKey) : null
		if (cachedBundle) {
			const cacheable = new Set(slots.map(slot => slot.name))
			for (const [name, serialized] of Object.entries(cachedBundle)) {
				if (!cacheable.has(name) || !Array.isArray(serialized) || serialized.length !== 2) continue
				const lod1 = deserializeMesh(serialized[0]), lod2 = deserializeMesh(serialized[1])
				if (lod1 && lod2) { lodCachedSlots.set(name, [lod1, lod2]); lodHits++ }
			}
		}
	let built = 0
	let dropped = 0
	let fitted = 0
	let minFit = 1
	const buildMetadata: UnitBuildMetadata = { rig: null, rigSkipReason: null }
	for (const slot of slots) {
			if (BLENDER_HIDDEN_ACTORS.has(slot.name)) { this.forgeStats.hidden++; continue }
			let mesh: GpuMesh
			let usedBlender = false
			const { rolePack, rikiSlot, humanSlot, trackSlot, authoredSlot, asset } = classifySlot(slot)
			let source = scratch
			// Collector for this slot's fresh LODs; null when the cache already
			// answered, so a hit never allocates serializers.
			let lodFreshSlot: { set(lod1: SerializedMesh, lod2: SerializedMesh): void } | null = null
			if (!authoredSlot && !lodCachedSlots.has(slot.name)) lodFreshSlot = {
				set(lod1, lod2) { lodFresh.set(slot.name, [lod1, lod2]) },
			}
			// The cache key names a forge slot by its asset hashes only. When that decode fails
			// and the slot falls back to procedural geometry, its chain must neither be read from
			// nor written under the forge key, or the next good boot draws the stand-in's LODs.
			let forgeFallback = false
			try {
				if (authoredSlot) {
					source = authoredSlot.levels[0].mesh
					buildMetadata.rig = authoredSlot.levels[0].rig
					buildMetadata.rigSkipReason = null
					usedBlender = true
				} else if (blender && asset && !asset.hidden && this.materials.has('blender')) {
					try {
						const decoded = decodeBlenderAsset(blender.bytes, asset)
						source = decoded.mesh
						buildMetadata.rig = decoded.rig
						buildMetadata.rigSkipReason = null
						usedBlender = true
					} catch (error) {
						forgeFallback = true
						this.forgeStats.errors.push(`${slot.name}: ${String(error)}`)
						console.warn(`[units] ${slot.name}: invalid Blender asset, using procedural geometry: ${String(error)}`)
					}
				}
				if (!usedBlender) {
					const prebuilt = proceduralSources.get(slot.name)
					if (prebuilt) {
						source = prebuilt.mesh
						buildMetadata.rig = prebuilt.meta.rig
						buildMetadata.rigSkipReason = prebuilt.meta.rigSkipReason
					} else {
						buildUnitFromSlot(scratch, slot, ctx.rng.forkNamed(`units/slot/${slot.name}`), buildMetadata)
					}
					if (RA_ACTOR_VISUALS[slot.name]) this.forgeStats.fallback++
				}
			mesh = authoredSlot ? this.render.uploadLods(authoredSlot.levels.map(level => level.mesh), `units:slot:${slot.name}:${rikiSlot ? 'repaired-meshy' : humanSlot ? 'anatomical' : trackSlot ? 'circulating-tracks' : 'authored-tree'}`)
				: this.render.upload(source, `units:slot:${slot.name}`, forgeFallback ? undefined : lodCachedSlots.get(slot.name),
					lodFreshSlot === null || forgeFallback ? undefined : chain => {
						if (lodFreshSlot) lodFreshSlot.set(serializeMesh(chain[1]), serializeMesh(chain[2]))
					})
				const template = asset?.template
				const deathKind = template === 'dog' || template === 'ant' ? 3 : slot.family === Family.infantry ? 1 :
					(slot.family === Family.tracked || slot.family === Family.wheeled || slot.family === Family.rotorcraft ||
					 slot.family === Family.fixedwing || slot.family === Family.vessel) ? 2 :
					template === 'tree' ? 4 :
					(slot.family === Family.plant || slot.family === Family.emplacement) ? 5 : 4
				this.deaths.register(mesh,deathKind,buildMetadata.rig?.skeleton??null,source,
					slot.family === Family.rotorcraft || slot.family === Family.fixedwing)
				if (usedBlender) {
					this.forgeStats.loaded++
					this.forgeStats.bytes += authoredSlot ? authoredSlot.manifest.levels.reduce((sum, level) => sum + level.bytes, 0) : asset!.bytes!
					this.forgeStats.vertices += authoredSlot ? authoredSlot.levels.reduce((sum, level) => sum + level.mesh.vertexCount, 0) : source.vertexCount
					this.forgeStats.triangles += authoredSlot ? authoredSlot.levels.reduce((sum, level) => sum + level.mesh.triangleCount, 0) : source.triangleCount
				}
			} catch (err) {
				if (authoredSlot) throw err // A declared authored chain cannot silently substitute a different actor.
				// One unbuildable actor must not take the whole army with it, but the drop
				// must stay VISIBLE. It previously warned once at boot and then fell through
				// to a class hull, so the actor drew as something else for the rest of the
				// session with nothing reporting it — a silent substitution, which is the
				// failure rule 8 exists for. Codex caught it on review of 2e89427.
				dropped++
				this.droppedSlots.push(slot.name)
				console.warn(`[units] ${slot.name} failed to build: ${(err as Error).message}`)
				continue
			}
			if (usedBlender && (asset?.template === 'house' || asset?.template === 'church'))
				this.ambientBuildingSeeds.set(slot.name, warzoneSeed(ctx.config.assetSeed + ':' + slot.name))
			const set = setForFaction(slot.faction)
			const authoredSet = asset?.materialSet
			const detailedSet = authoredSet && this.materials.has(`${authoredSet}:${slot.name}`) ? `${authoredSet}:${slot.name}` : authoredSet
			if (usedBlender && authoredSet && !this.materials.has(authoredSet))
				console.warn(`[units] ${slot.name}: authored material ${authoredSet} unavailable; using palette`)
			const resolved = usedBlender ? detailedSet && this.materials.has(detailedSet) ? detailedSet : 'blender' : this.materials.has(set) ? set : 'foundry'
			if (buildMetadata.rigSkipReason !== null) this.unriggedSlots.push(buildMetadata.rigSkipReason)
			const airborne = slot.family === Family.rotorcraft || slot.family === Family.fixedwing
			// Houses no longer skip the fit: their authored meshes can exceed their cell
			// footprint, and neighbouring buildings on the adjacent grid cell then
			// overlap (playtest finding). The 0.88 FIT_INSET already leaves a visible
			// gap between occupied rects. Trees keep the exemption: their canopies are
			// authored to spread and clipping them to a trunk cell would look wrong.
			const skipFit = airborne || asset?.template === 'tree' || trackSlot !== null || asset?.deploymentNativeScale === 1
			const visual = RA_ACTOR_VISUALS[slot.name] ?? RA_ACTOR_VISUALS[slot.name.toLowerCase()]
			const occ = occupancyMeters(slot.footprint, visual?.traits.find(t => t.Name === 'Building')?.Fields.Dimensions)
			// Civilian lots are authored wider than the cells they replaced. upload()
			// refreshes bounds on the mesh it draws, and a LOD-cache miss draws a clone,
			// so the decoded source AABB stays at the origin. A zero span makes
			// fitScaleForMesh return 1 and the house is drawn through its neighbour.
			// Other actors keep the source box: their established scale is that unread
			// result, and measuring them here would shrink the whole army.
			const lotMesh = asset?.template === 'house' || asset?.template === 'church'
			if (lotMesh) {
				source.invalidateBounds()
				source.updateBounds()
			}
			const spanX = Math.max(1e-4, source.aabbMax[0] - source.aabbMin[0], lotMesh ? mesh.aabbMax[0] - mesh.aabbMin[0] : 0)
			const spanZ = Math.max(1e-4, source.aabbMax[2] - source.aabbMin[2], lotMesh ? mesh.aabbMax[2] - mesh.aabbMin[2] : 0)
			const fitScale = skipFit ? 1 : fitScaleForMesh(spanX, spanZ, occ.x, occ.z)
			const measuredContact = runningGearProfile(slot.name, fitScale)
			const contact = measuredContact && trackSlot ? { ...measuredContact, uvRepeatM: trackSlot.manifest.descriptor.loop.length / trackSlot.manifest.descriptor.loop.linkCount * fitScale } : measuredContact
			if (contact) this.runningGear.set(slot.name, contact)
			const builtRig = buildMetadata.rig
			if (fitScale < 1 && builtRig) {
				for (let w = 0; w < builtRig.wheelRadii.length; w++)
					builtRig.wheelRadii[w] *= fitScale
			}
			const rig: SlotRig | null = toSlotRig(builtRig)
			if (asset?.deployment && usedBlender) {
				if (slot.name !== 'fact' || !rig) throw new Error('Deployment contract requires the paired yard rig')
				this.deploymentRigs.set(rig,new DeploymentRig(rig.skeleton,asset.deployment))
			}
			if (rig && fitScale < 1) rig.strideM *= fitScale
			if (rikiSlot) {
				if (!rig) throw new Error('Riki motion requires her native skeleton')
				this.rikiRigs.add(rig)
			}
			if (humanSlot) {
				if (!rig) throw new Error('Human motion requires the authored skeleton')
				validateHumanMotionPose(humanSlot.motion, rig.pose)
				// Source is already compressed game scale (.363m, matching the old e1).
				this.humanMotion = { rig, clip: humanSlot.motion, scale: 1,
					aim: humanSlot.timed.get('infantry-aim-v1') ?? null,
					fire: humanSlot.timed.get('infantry-fire-v1') ?? null }
				this.humanRigs.add(rig)
			}
			const paletteBases = rig === null ? null : new Uint16Array(MAX_ACTORS)
			const phases = slot.family === Family.tracked || slot.family === Family.wheeled
				? new Float32Array(MAX_ACTORS)
				: null
			const damages = new Float32Array(MAX_ACTORS)
			if (builtRig !== null) {
				this.skinStats.riggedSlots++
				this.skinStats.chassisVertices += builtRig.capturedVertices[0]
				for (const turretBone of builtRig.turretBones)
					this.skinStats.turretVertices += builtRig.capturedVertices[turretBone]
			}
			// Source-bound sockets are authoritative. Role and Riki bodies carry their own
			// weapon, so give the attachment resolver their held-aim muzzle instead of the
			// roster placeholder barrel. Riki also keeps a posed path below for native animation.
			const arms = slot.armaments
			const roleMuzzle = arms.length > 0
				? rikiSlot
					? {
						bone: rikiSlot.muzzleBone,
						pos: rikiSlot.manifest.muzzle.pos as [number, number, number],
						anchor: rikiSlot.muzzleAnchor as [number, number, number],
						direction: rikiSlot.manifest.muzzle.direction as [number, number, number],
						source: 'manifest' as const,
					}
					: rolePack?.muzzle ?? null
				: null
			// An authored human body without its role pack (rifleunits=0 fallback) is not
			// the mesh these roster sockets were authored against, and it carries no muzzle
			// of its own — pass no source so the resolver skips the binding (same contract
			// as the procedural fallback) instead of failing the boot on a stale socket.
			this.attachments.bind(mesh,slot.name,humanSlot && roleMuzzle === null ? undefined : asset?.sourceSha256,roleMuzzle,arms.map(a=>a.weapon))
			this.slotBuckets.set(slot.name, {
				cls: UnitClass.drift,
				headlamps: false,
				surfaceSet: resolved,
				mesh,
				capacity: MAX_ACTORS,
				instances: new Float32Array(MAX_ACTORS * 16),
				colors: new Uint8Array(MAX_ACTORS),
				motionIds: new Uint32Array(MAX_ACTORS),
				paletteBases,
				phases,
				damages,
				rig,
				count: 0,
				shadow: makeShadowBucket(mesh, MAX_ACTORS, paletteBases, phases,
					usedBlender && (resolved === authoredSet || resolved === `${authoredSet}:${slot.name}`) && asset?.alphaCutout === true),
				item: {
					mesh,
					alphaCutout: usedBlender && (resolved === authoredSet || resolved === `${authoredSet}:${slot.name}`) && asset?.alphaCutout === true,
					surfaceSet: resolved,
					instances: new Float32Array(0),
					instanceCount: 0,
					playerColors: null,
					paletteBases,
					motionIds: null,
					boneCount: rig?.skeleton.boneCount ?? 0,
					phases,
					damages,
					castsShadow: false,
				},
			})
			// Aircraft are the one family whose height the terrain does not decide. The
			// snapshot has carried their real altitude in `posZ` since the bridge landed and
			// `units` has been discarding it, so all ten rotorcraft have been taxiing along
			// the ground at zero altitude.
			// Upload refreshes bounds on its own LOD copies. Decoded source bounds can still
			// be zero here, which made every vehicle sample a .24m ground square. Keep its
			// established visual fit, but use actual running gear for terrain contact.
			this.slotGround.set(slot.name, {
				...supportHalfExtents(mesh, fitScale, contact),
				airborne,
				fitScale,
			})
			if (fitScale < 1) { fitted++; if (fitScale < minFit) minFit = fitScale }
			built++
			if (lodFreshSlot !== null) await yieldAfterFreshLod()
		}
		if (this.unriggedSlots.length > 0) {
			// Reported as a LIST rather than a count. An actor whose wheels are finer than the
			// mesher grid still draws and still scrolls its running-gear material; what it does
			// not do is turn. That is a real limitation and it is named, because a silent
			// fallback here is indistinguishable from a rig that works.
			console.warn(`[units] ${this.unriggedSlots.length} actor(s) declined a rig:`)
			for (const r of this.unriggedSlots) console.warn(`  ${r}`)
		}
		this.archetypeCount = built
		// The lobby can paint while the additive damage ladders build, but a world waits for
		// this promise. Each QEM upload is synchronous; letting those uploads overlap a live
		// match caused the cold browser session to miss frames and could starve snapshots.
		this.damageLaddersReady = this.buildDamageLadders(blender).catch(error => {
			this.forgeStats.errors.push(`damage states: ${String(error)}`)
			console.warn(`[units] condition ladders unavailable: ${String(error)}`)
		})
		this.cloneE2SovietBuckets()
		console.log(`[units] ${built} archetype hulls from the roster${dropped > 0 ? `, ${dropped} dropped` : ''}${fitted > 0 ? `, ${fitted} fitted to occupancy (min ${minFit.toFixed(2)})` : ''}${lodHits > 0 ? `, ${lodHits} LOD cache hits` : ''} in ${(performance.now() - t0).toFixed(0)} ms`)
		console.info(`[boot] stage=hull-lod-ready ms=${Math.round(performance.now())} hulls=${built} cacheHits=${lodHits}`)
		if (lodFresh.size > 0 && lodKey) writeLodBundle(lodKey, Object.fromEntries(lodFresh))
		}
		this.offDeath = ctx.events.on<SnapshotEvent>(SimEvent.actorDestroyed,this.onActorDestroyed)
		this.offNewWorld = ctx.events.on(CoreEvent.newWorld, () => {
            this.resetTypes()
			this.deploymentStates.clear()
			this.deaths.clear()
			this.clearRamps()
			this.posedRifleMuzzles.clear()
			this.presentationMotion.clear()
		})
		scratch.clear()
	}

	onSnapshot(snap: Snapshot, _prev: Snapshot | null, ctx: Ctx): void {
		this.deploymentStates.ingest(snap.deployments,snap.tick)
		this.deploymentStates.retainActors(snap.actors,snap.frozenActors)
		if (_prev && snap.tick < _prev.tick) {
            this.resetTypes()
			this.deaths.clear()
			this.clearRamps()
			this.posedRifleMuzzles.clear()
			this.presentationMotion.clear()
		}
		if ((snap.flags & HeaderFlag.terrainStaticPresent) !== 0) this.flatAircraftSource = isFlatAircraftSource(snap.terrainStatic)
		for(const event of snap.lifecycle)if(event.kind===1)this.deaths.finishHusk(event.actorId,snap.tick/SIM_TICK_HZ)
		this.scenery.onSnapshot(snap)
		const actors = snap.actors
		if (actors) for (const id of this.posedRifleMuzzles.keys()) if (findActorIndex(actors, id) < 0) this.posedRifleMuzzles.delete(id)
		// Resolve any typeIds seen for the first time. Done on the snapshot boundary rather
		// than in update() so the per-frame path has no Map miss and no string work.
		if (actors) for (let i = 0; i < actors.count; i++) {
			this.resolveType(actors.typeId[i], ctx)
			if (actors.displayTypeId[i] !== actors.typeId[i]) this.resolveType(actors.displayTypeId[i], ctx)
		}
		if (actors) for (let i = 0; i < actors.count; i++) {
			const name = this.typeSlot.get(actors.typeId[i]), rig = name ? this.slotBuckets.get(name)?.rig : null
			// A WRECK OR AN INOPERATIVE BUILDING STOPS TURNING. `ActorFlag.disabled` used to be set
			// whenever ANY conditional trait was off, and in the RA rules most such traits are
			// bonuses inactive in an actor's ordinary state (a rookie helicopter carries 29), so
			// every aircraft read as disabled and its rotors stood still; this read `husk` alone.
			// The emitter now sets the flag from the rules' own `disabled` condition (low power, a
			// spy's outage, a player's power-down), which aircraft never carry, so a powered-down
			// plant or dish holds still again as a destroyed one does.
			if (rig && (rig.rotorBones.length || rig.oscillatorBones.length))
				this.mechanicalClock.observe(actors.id[i], snap.tick, (actors.flags[i] & (ActorFlag.husk | ActorFlag.disabled)) !== 0)
		}
		this.mechanicalClock.prune(snap.tick)
		const frozen = snap.frozenActors
		if (frozen) for (let i = 0; i < frozen.count; i++) this.resolveType(frozen.typeId[i], ctx)
		if (this.shroud) this.living.onSnapshot(snap,this.typeSlot,this.shroud)
	}

	private resetTypes():void {
        this.typeClass.clear();this.typeVehicle.clear();this.typeMovementClass.clear();this.typeWatercraft.clear();this.typeWaterStructure.clear();this.typeSubmersible.clear();this.typeRenderable.clear();this.typeShroudOnly.clear();this.typeSlot.clear();this.typeMaterial.clear()
        this.attachments.begin();this.attachments.end()
    }

	private resolveType(t: number, ctx: Ctx): void {
		if (this.typeClass.has(t)) return
		const name = ctx.actorTypeName(t)
		// An empty name means the actor-type table has not landed yet (the host bridge
		// answers asynchronously): resolving NOW would cache a permanent null slot and
		// the actor would never be placed, picked or rendered. Leave the type
		// unresolved; the next snapshot retries once the table is in.
		if (name === '') return
		const raVisual = RA_ACTOR_VISUALS[name.toLowerCase()]
		this.typeMaterial.set(t, (raVisual?.armor?.Type ?? '').toLowerCase())
		const renderable = (raVisual?.renderable ?? true) && !BLENDER_HIDDEN_ACTORS.has(name.toLowerCase())
		const mobileConstruction = isMobileConstructionVisual(raVisual)
		const watercraft = raVisual?.visualFamily === 'vessel'
		const waterStructure = raVisual?.visualFamily === 'structure' &&
			(raVisual.terrainTypes?.includes('Water') ?? false)
		const submersible = watercraft && hasRaTrait(raVisual, 'Cloak')
		this.typeRenderable.set(t, renderable)
		this.typeShroudOnly.set(t, hasRaTrait(raVisual, 'HiddenUnderShroud') &&
			!hasRaTrait(raVisual, 'HiddenUnderFog') && !hasRaTrait(raVisual, 'FrozenUnderFog'))
		const slotted = renderable && this.slotBuckets.has(name)
		this.typeClass.set(t, mobileConstruction ? UnitClass.latticeMedium :
			slotted ? UnitClass.drift : raVisual ? hullClassForFamily(raVisual.visualFamily) : classForType(name))
		this.typeVehicle.set(t, raVisual
			? raVisual.visualFamily === 'tracked' || raVisual.visualFamily === 'wheeled'
			: isVehicleType(name))
		// Movement-audio class: the mixer voices infantry as discrete footsteps and scales
		// engine weight by hull class, so a Mammoth column cannot sound like a jeep patrol.
		this.typeMovementClass.set(t, !raVisual ? 1
			: raVisual.visualFamily === 'infantry' ? 0
			: watercraft ? 3
			: raVisual.visualFamily === 'tracked' ? 2
			: 1)
		this.typeMobile.set(t, raVisual ? MOBILE_ROLES.has(raVisual.semanticRole) : true)
		this.typeWatercraft.set(t, watercraft)
		this.typeWaterStructure.set(t, waterStructure)
		this.typeSubmersible.set(t, submersible)
		// Every known RA actor resolves only to its own ABI-v2 mesh. The old STEELSEED roster
		// remains available for deterministic renderer fixtures, never as a family substitute.
		this.typeSlot.set(t, slotted ? name : null)
	}

	/**
	 * Enumerate immutable, boot-created visual handles.
	 *
	 * A dependent node may preallocate one submission bucket per handle during its own init.
	 * No GPU ownership transfers: `units` still owns every mesh and render destroys it.
	 */
	visitVisuals(visit: (mesh: GpuMesh, surfaceSet: string) => void): void {
		for (const bucket of this.buckets)
			if (bucket?.mesh != null) visit(bucket.mesh, bucket.surfaceSet)
		for (const bucket of this.slotBuckets.values())
			if (bucket.mesh != null) visit(bucket.mesh, bucket.surfaceSet)
	}

	/** Exact fit used by wheel phases and vehicle-specific ground imprints. */
	runningGearOf(actorName: string): RunningGearProfile | null {
		return this.runningGear.get(actorName) ?? null
	}

	placementVisual(actorName: string): PlacementVisual | null {
		const bucket = this.slotBuckets.get(actorName)
		const ground = this.slotGround.get(actorName)
		if (!bucket?.mesh || !ground) return null
		const visual = RA_ACTOR_VISUALS[actorName.toLowerCase()]
		return {
			mesh: bucket.mesh,
			surfaceSet: bucket.surfaceSet,
			halfLen: ground.halfLen,
			halfWid: ground.halfWid,
			water: visual?.visualFamily === 'structure' && (visual.terrainTypes?.includes('Water') ?? false),
		}
	}

	/** Resolved OpenRA Tooltip/Fluent name exported from the pinned ActorInfo graph. */
	displayName(actorName: string): string {
		return RA_ACTOR_VISUALS[actorName.toLowerCase()]?.displayName ?? actorName.replaceAll('.', ' ').replaceAll('_', ' ')
	}

	/** Gameplay-derived role; used only to explain authoritative economy/production state. */
	semanticRole(actorName: string): string {
		return RA_ACTOR_VISUALS[actorName.toLowerCase()]?.semanticRole ?? 'unknown'
	}

	/** Read-only authoritative trait metadata; UI still sends normal OpenRA orders. */
	cargoCapacity(actorName: string): number {
		return RA_ACTOR_VISUALS[actorName.toLowerCase()]?.cargo ?? 0
	}

	/** Sum of AmmoPool.Ammo on the actor, 0 when it has no limited magazine. */
	ammoCapacity(actorName: string): number {
		const traits = RA_ACTOR_VISUALS[actorName.toLowerCase()]?.traits
		if (!traits) return 0
		let max = 0
		for (let i = 0; i < traits.length; i++) {
			if (traits[i].Name !== 'AmmoPool') continue
			const n = Number(traits[i].Fields.Ammo)
			if (Number.isFinite(n) && n > 0) max += n
		}
		return max
	}

	deployOrder(actorName: string): 'Unload' | 'DeployTransform' | 'GrantConditionOnDeploy' | 'Detonate' | null {
		const visual = RA_ACTOR_VISUALS[actorName.toLowerCase()]
		if ((visual?.cargo ?? 0) > 0 && hasRaTrait(visual, 'Cargo')) return 'Unload'
		if (hasRaTrait(visual, 'Transforms')) return 'DeployTransform'
		// The MAD tank's deploy is its detonation sequence (MadTank's IIssueDeployOrder).
		if (hasRaTrait(visual, 'MadTank')) return 'Detonate'
		return hasRaTrait(visual, 'GrantConditionOnDeploy') ? 'GrantConditionOnDeploy' : null
	}

	/** Player queue category produced by this building, or -1 when it is not a producer. */
	productionKind(actorName: string): number {
		return productionKind(RA_ACTOR_VISUALS[actorName.toLowerCase()])
	}

	hasRaTrait(actorName: string, trait: string): boolean {
		return hasRaTrait(RA_ACTOR_VISUALS[actorName.toLowerCase()], trait)
	}

	/** True for mobile rendered actors that belong in an RTS drag-selected command group. */
	groupSelectable(actorName: string): boolean {
		const entry = RA_ACTOR_VISUALS[actorName.toLowerCase()]
		return entry?.renderable === true && entry.role === 'unit'
	}

	/** The UI must not draw a health bar for a type the unit renderer never places. */
	isRenderableType(typeId: number): boolean {
		return this.typeRenderable.get(typeId) !== false
	}

	/** Some terrain-like live actors persist on explored ground after leaving sight. */
	isShroudOnlyType(typeId: number): boolean {
		return this.typeShroudOnly.get(typeId) === true
	}

	/** OpenRA lists trees and crates as structures with Health/Targetable traits, but
	 * they are scenery, not buildings. Selectable structures and buildable walls are
	 * buildings; the other damaged structures must not grow UI bars. */
	healthBarEligible(actorName: string): boolean {
		const name = actorName.toLowerCase()
		const entry = RA_ACTOR_VISUALS[name]
		if (!entry?.renderable || !hasRaTrait(entry, 'Health')) return false
		if (entry.role === 'unit') return !name.endsWith('.husk')
		return entry.role === 'structure' &&
			(hasRaTrait(entry, 'Selectable') || entry.semanticRole === 'wall')
	}

	/** Ground-plane pick/ring radius derived from the actor's real procedural footprint. */
	selectionRadiusM(typeId: number): number {
		const slot = this.typeSlot.get(typeId)
		const ground = slot ? this.slotGround.get(slot) : null
		return ground ? Math.max(0.55, Math.hypot(ground.halfLen, ground.halfWid)) : 0.9
	}

	/** The type's lower-case Armor.Type ('tree', 'wood', …), '' when unknown or unresolved. */
	materialOf(typeId: number): string {
		return this.typeMaterial.get(typeId) ?? ''
	}

	/** Mesh height used to aim picking at a building's visible centre instead of its feet. */
	selectionHeightM(typeId: number): number {
		const slot = this.typeSlot.get(typeId)
		const mesh = slot ? this.slotBuckets.get(slot)?.mesh : null
		return mesh ? Math.max(0.5, mesh.aabbMax[1] - mesh.aabbMin[1]) : 1.2
	}

	/**
	 * Copy the last submitted visual for a simulation actor.
	 *
	 * Section-7 events are republished before the new snapshot updates nodes. A destruction
	 * handler therefore sees the previous frame's exact placed transform here, including
	 * the four-point terrain fit. Hidden actors are absent by design and cannot create a
	 * remembered wreck that leaks through shroud.
	 */
	captureActorVisual(
		actorId: number,
		outTransform: Float32Array,
		outOffset: number,
		out: ActorVisualCapture,
	): boolean {
		// The placement index answers in O(1); the bucket scans remain as the
		// authority for anything the last placement pass did not place.
		const entry = this.placementIndex.get(actorId)
		if (entry !== undefined && entry.bucket !== null && entry.index < entry.bucket.count &&
			entry.bucket.motionIds[entry.index] === actorId &&
			this.captureBucketVisual(entry.bucket, actorId, outTransform, outOffset, out, entry.index))
			return true
		for (const bucket of this.buckets)
			if (this.captureBucketVisual(bucket, actorId, outTransform, outOffset, out)) return true
		for (const bucket of this.slotBuckets.values())
			if (this.captureBucketVisual(bucket, actorId, outTransform, outOffset, out)) return true
		out.mesh = null
		return false
	}

	/** Allocation-free inner path for captureActorVisual. */
	private captureBucketVisual(
		bucket: ClassBucket | null,
		actorId: number,
		outTransform: Float32Array,
		outOffset: number,
		out: ActorVisualCapture,
		knownIndex = -1,
	): boolean {
		if (bucket?.mesh == null) return false
		let i = knownIndex >= 0 && knownIndex < bucket.count && bucket.motionIds[knownIndex] === actorId
			? knownIndex
			: -1
		if (i < 0)
			for (let k = 0; k < bucket.count; k++)
				if (bucket.motionIds[k] === actorId) { i = k; break }
		if (i < 0) return false
		const sourceOffset = i * 16
		for (let j = 0; j < 16; j++) outTransform[outOffset + j] = bucket.instances[sourceOffset + j]
		out.mesh = bucket.mesh
		out.surfaceSet = bucket.surfaceSet
		out.playerColor = bucket.colors[i]
		out.boneCount = bucket.rig?.skeleton.boneCount ?? 0
		out.paletteBase = bucket.paletteBases?.[i] ?? 0
		return true
	}


	/** Legacy diagnostic API; source-bound attachments replace scalar corrections. */
	muzzleLiftOf(_actorId:number):number {return 0}

	/**
	 * Authored weapon name for the armament that just fired, or '' when this actor is unarmed
	 * or hidden. Used by fx/audio so a Mammoth's 120mm and its tusks cannot share one visual.
	 */
	weaponNameOf(actorId:number, armament:number):string {return this.attachments.weapon(actorId,armament)}

	/**
	 * World-space barrel tip for the armament that fired. Writes xyz into out[0..2] and the
	 * barrel forward into out[3..5]. False when the actor is hidden or has no authored muzzle.
	 */
	muzzleWorldOf(actorId:number,armament:number,_simX:number,_simY:number,_simZ:number,out:Float32Array,barrel=0,shot=1):boolean {
		if(!this.captureActorVisual(actorId,this.deathTransform,0,this.deathCapture))return false
		const posed=this.posedRifleMuzzles.get(actorId)
		if(posed&&this.deathCapture.surfaceSet===RIKI_MATERIAL){
			const m=this.deathTransform
			for(let a=0;a<3;a++){
				out[a]=m[a]*posed[0]+m[4+a]*posed[1]+m[8+a]*posed[2]+m[12+a]
				out[3+a]=m[a]*posed[3]+m[4+a]*posed[4]+m[8+a]*posed[5]
			}
			const length=Math.hypot(out[3],out[4],out[5])
			if(length>0)for(let a=3;a<6;a++)out[a]/=length
			return length>0&&Number.isFinite(out[0]+out[1]+out[2]+length)
		}
		return this.attachmentWorldOf(actorId,armament,barrel,out,shot)
	}
	/**
	 * True when the player can see this actor's body right now: not gone, not a husk, not behind
	 * the shroud. fx asks this when a fire has no authored socket (a pillbox's firing port, a
	 * garrisoned building): a visible source may then fire from the rules' own muzzle in the event.
	 */
	isDrawnSource(actorId:number):boolean {
		const actors=this.deathContext?.snapshot?.actors
		if(!actors)return false
		const i=findActorIndex(actors,actorId)
		if(i<0||(actors.flags[i]&ActorFlag.husk)!==0)return false
		return this.shroud?.isVisible(Math.floor(actors.posX[i]*WPOS_TO_M),Math.floor(actors.posY[i]*WPOS_TO_M))===true
	}
	attachmentWorldOf(actorId:number,armament:number,barrel:number,out:Float32Array,shot=1):boolean {
		const actors=this.deathContext?.snapshot?.actors
		if(actors){const i=findActorIndex(actors,actorId);if(i<0||(actors.flags[i]&ActorFlag.husk)!==0||!this.shroud?.isVisible(Math.floor(actors.posX[i]*WPOS_TO_M),Math.floor(actors.posY[i]*WPOS_TO_M)))return false}
		return this.attachments.resolve(actorId,armament,barrel,out,shot)
	}

	/**
	 * Accumulated mechanical phase in seconds for one actor, or -1 when nothing is tracking it.
	 *
	 * A measurement surface, for the same reason `muzzleLiftOf` is one: "the rotors stand still"
	 * was diagnosed twice from flags and clock internals and neither reading was a witness. This
	 * is the number the rotor angle is derived from, so a gate can assert the phase ADVANCES on a
	 * live machine and HOLDS on a wreck, which is the whole behaviour in one value.
	 */
	mechanicalPhaseOf(actorId:number):number {
		return this.mechanicalClock.has(actorId) ? this.mechanicalClock.seconds(actorId, 1) : -1
	}
	deathKindOf(actorId:number):number {
		// A destroyed actor is gone from the placement the moment its destroy event
		// is pumped, so captureActorVisual alone answers 0 exactly when consumers
		// (audio death screams) need the answer. The death entry started by
		// onActorDestroyed — same event dispatch, units subscribes before audio —
		// classifies it; the live capture remains the fallback for living actors.
		const dead = this.deaths.kindOf(actorId)
		if (dead) return dead
		return this.captureActorVisual(actorId,this.deathTransform,0,this.deathCapture) ? this.deaths.kind(this.deathCapture.mesh) : 0
	}
	/**
	 * Drain this frame's Heavy/Critical rung crossings to `sink`. Zero-cost when none, which
	 * is nearly every frame. fx answers a crossing with a one-shot burst; see
	 * fx/mushroom-cloud `burst`. Presentation only: the ladder itself moves whether or not
	 * anyone is listening.
	 */
	/** Read only the live, visible instances actually selected for this frame. */
	visitVisibleInstances(slot:string,sink:(matrix:Float32Array,offset:number,actorId:number)=>void):void {
		const actors=this.deathContext?.snapshot?.actors;if(!actors||!this.shroud)return
		for(let rung=0;rung<6;rung++){
			const bucket=this.slotBuckets.get(rung?`${slot}.d${rung}`:slot);if(!bucket)continue
			for(let i=0;i<bucket.count;i++){
				const o=i*16,id=bucket.motionIds[i]
				if(findActorIndex(actors,id)<0)continue
				if(this.shroud.isVisible(Math.floor(bucket.instances[o+12]),Math.floor(bucket.instances[o+14])))sink(bucket.instances,o,id)
			}
		}
	}

	drainRungTransitions(sink: (actorId: number, rung: number) => void): void {
		this.damage.drainTransitions(sink)
	}

	/** Airborne death flash meets the exact displayed hull, including visual hill clearance. */
	deathAltitudeOf(actorId:number):number|null {
		if(!this.captureActorVisual(actorId,this.deathTransform,0,this.deathCapture)||!this.deaths.airborne(this.deathCapture.mesh))return null
		return this.deathTransform[13]
	}
	crashOwnsHusk(id:number):boolean {return this.deaths.ownsHusk(id)}
 private readonly crashSignal=(event:AircraftVisualEvent,impact:boolean):void=>{this.deathContext?.events.emit(impact?CoreEvent.aircraftImpact:CoreEvent.aircraftTrail,event)}
 private readonly onActorDestroyed = (event:SnapshotEvent):void => {
		const ctx=this.deathContext,view=ctx?.snapshot?.view,o=event?.offset
		if(!event||!ctx||!view||!this.render||!this.shroud||!Number.isInteger(event.byteLength)||event.byteLength<18||!Number.isInteger(o)||o<0||o+18>view.byteLength)return
		if(ctx.prevSnapshot && ctx.snapshot!.tick<ctx.prevSnapshot.tick)return
		const id=view.getUint32(o,true)
		if(this.deaths.finishHusk(id,ctx.time.tick/SIM_TICK_HZ))return
		if(!this.captureActorVisual(id,this.deathTransform,0,this.deathCapture))return
		// Events precede Clock.frame: alpha still belongs to the previous frame here.
		const a=ctx.prevSnapshot?.actors??ctx.snapshot?.actors,index=a?findActorIndex(a,id):-1
  const altitude=a&&index>=0?a.posZ[index]*WPOS_TO_M:0
  this.deaths.start(id,ctx.time.tick/SIM_TICK_HZ,this.deathTransform,this.deathCapture,this.render,this.shroud,altitude)
	}

	private clearRamps(): void {
		this.rampOpen.clear()
		this.lastCargo.clear()
		this.rampHoldUntil.clear()
	}

	update(dt: number, ctx: Ctx): void {
		const turretKick = vfxBudgetFor(ctx.config.q.name).combatLayers
		const render = this.render
		const terrain = this.terrain
		const sky = this.sky
		const anim = this.anim
		if (!render || !terrain || !sky || !anim) return
		this.scenery.beginOccluders()
		this.living.begin()
		const actors = ctx.snapshot?.actors
		// Reserve transient death poses before ambient rigs can consume the shared pool.
		const crashTime=(ctx.time.tick+ctx.time.alpha)/SIM_TICK_HZ
  if(actors?.crashParentId)for(let i=0;i<actors.count;i++){
   const parent=actors.crashParentId[i];if(!parent)continue
   const prev=ctx.prevSnapshot?.actors,j=prev?findActorIndex(prev,actors.id[i]):-1,t=ctx.time.alpha
   const x=(j>=0?prev!.posX[j]+(actors.posX[i]-prev!.posX[j])*t:actors.posX[i])*WPOS_TO_M
   const z=(j>=0?prev!.posY[j]+(actors.posY[i]-prev!.posY[j])*t:actors.posY[i])*WPOS_TO_M
   const altitude=(j>=0?prev!.posZ[j]+(actors.posZ[i]-prev!.posZ[j])*t:actors.posZ[i])*WPOS_TO_M
   const facing=j>=0?lerpFacing(prev!.facing[j],actors.facing[i],t):actors.facing[i]
   this.deaths.follow(parent,actors.id[i],crashTime,x,z,altitude,wangleToRadians(facing))
  }
  if(this.shroud)this.deaths.update(crashTime,render,terrain,this.shroud,this.crashSignal)
		for (const b of this.buckets) if (b) { b.count = 0; b.shadow.count = 0 }
		for (const b of this.slotBuckets.values()) { b.count = 0; b.shadow.count = 0 }
		const nowS = (ctx.time.tick + ctx.time.alpha) / SIM_TICK_HZ
		this.attachments.begin()
		this.damage.beginFrame(nowS)
		this.frozenStats.drawn = 0
		const lampStats = this.headlampStats
		lampStats.vehicles = 0
		lampStats.lights = 0
		lampStats.skyLightLevel = skyLightLevel(sky)
		lampStats.factor = headlampFactor(lampStats.skyLightLevel)
		const skinStats = this.skinStats
		skinStats.posedActors = 0
		skinStats.bindPoseActors = 0
		skinStats.paletteOverflows = 0
		skinStats.casters = 0
		skinStats.shroudCulled = 0
		if (!actors || actors.count === 0) {
			this.attachments.end()
			if (this.shroud) this.scenery.update(ctx, render, terrain, sky, this.shroud, true)
			if (this.shroud) this.living.update(ctx, render, terrain, this.shroud)
			if (this.shroud) this.grass.update(ctx, render, terrain, this.shroud)
			return
		}
		const previousActors = ctx.prevSnapshot?.actors ?? null
		const alpha = previousActors === null ? 1 : ctx.time.alpha
		const shroud = this.shroud

		const n = Math.min(actors.count, MAX_ACTORS)
		if (actors.count > MAX_ACTORS && !this.warnedOverflow) {
			this.warnedOverflow = true
			console.warn(`[units] ${actors.count} actors exceeds the ${MAX_ACTORS} draw cap; the tail is not drawn`)
		}

		this.updateViewCull(ctx, n)
		this.airspace.reset()
		for(let i=0;i<n;i++){
			const slot=this.typeSlot.get(actors.typeId[i]);if(!slot||RA_ACTOR_VISUALS[slot]?.visualFamily!=='structure')continue
			const b=this.slotBuckets.get(slot),g=this.slotGround.get(slot);if(!b?.mesh||!g)continue
			const x=actors.posX[i]*WPOS_TO_M,z=actors.posY[i]*WPOS_TO_M
			if(this.outsideView(x,z))continue
			if(!this.shroud?.isVisible(Math.floor(x),Math.floor(z)))continue
			this.airspace.add(x,z,g.halfLen,g.halfWid,this.heightProbe(x,z)+(b.mesh.aabbMax[1]-b.mesh.aabbMin[1])*g.fitScale)
		}

		// One pass. Buffers are already at the cap, so there is nothing to size first.
		// §12.4 — sim X east, Y south, Z up becomes render X east, Y up, Z south, so posY
		// (sim southing) lands on render Z.
		for (let i = 0; i < n; i++) {
			if (this.typeRenderable.get(actors.typeId[i]) === false || this.deaths.ownsHusk(actors.id[i])) continue
			if (this.outsideView(actors.posX[i] * WPOS_TO_M, actors.posY[i] * WPOS_TO_M)) continue
			// Actor arrays are compacted after deaths, so the previous actor at index i may
			// be a different machine. Match the stable simulation id. A newly-created actor
			// has no previous sample and is placed at its authoritative current transform.
			let previousIndex = -1
			let xWPos = actors.posX[i]
			let zWPos = actors.posY[i]
			let altitudeWPos = actors.posZ[i]
			let facing = actors.facing[i]
			if (previousActors !== null) {
				previousIndex = findActorIndex(previousActors, actors.id[i])
				// A chronoshift (or its return) moves a unit across the map in one tick. Nothing
				// travels three cells in a tick, so such a jump is drawn as the jump it is, not as a
				// slide across everything in between.
				if (previousIndex >= 0 && Math.abs(actors.posX[i] - previousActors.posX[previousIndex]) +
					Math.abs(actors.posY[i] - previousActors.posY[previousIndex]) > TELEPORT_WPOS) previousIndex = -1
				if (previousIndex >= 0) {
					xWPos = previousActors.posX[previousIndex] +
						(actors.posX[i] - previousActors.posX[previousIndex]) * alpha
					zWPos = previousActors.posY[previousIndex] +
						(actors.posY[i] - previousActors.posY[previousIndex]) * alpha
					altitudeWPos = previousActors.posZ[previousIndex] +
						(actors.posZ[i] - previousActors.posZ[previousIndex]) * alpha
					facing = lerpFacing(previousActors.facing[previousIndex], actors.facing[i], alpha)
				}
			}
			const typeId = actors.typeId[i]
			const cls = this.typeClass.get(typeId) ?? UnitClass.drift
			const vehicle = this.typeVehicle.get(typeId) ?? false
			// The roster's own hull when this actor has one, the class placeholder when it
			// does not. Both paths fill the same bucket shape, so update() below is unchanged.
			const slotName = this.typeSlot.get(typeId)
			const displaySlotName = this.typeSlot.get(actors.displayTypeId[i]) ?? slotName
			const fallingHusk = slotName?.endsWith('.husk') === true && this.slotGround.get(slotName)?.airborne === true
			// The condition ladder redirects this actor to the rung its health puts it on, and
			// returns null for the 279 actors that have no ladder. Damage never changes which
			// ACTOR is drawn, only which authored condition of it.
			const ambientSeed = slotName != null ? this.ambientBuildingSeeds.get(slotName) : undefined
			const ambientCondition = ambientSeed === undefined ? 0 : warzoneCondition(ambientSeed,actors.posX[i],actors.posY[i])
			const appearanceDamage = Math.max(1 - actors.health[i] / 255, warzoneSurfaceDamage(ambientCondition))

			// §4.7 visibility. An actor standing in ground the local player cannot currently see
			// is not drawn — which is the rule that makes scouting mean anything, and which this
			// game has never enforced: the shroud section has crossed the bridge and been decoded
			// since the bridge landed, with no consumer, so every player has been able to see
			// every enemy base.
			//
			// The test is per ACTOR CLASS, not one rule for everything, because OpenRA's is. A
			// tree, husk or rock carries `HiddenUnderShroud`: it belongs to the terrain and stays
			// drawn once its ground has been explored. Applying fog to it here would delete the
			// scenery again a frame after the emitter published it, and would put a second,
			// blunter copy of a rule the emitter already applies correctly on the client — the
			// two-clocks defect this codebase has paid for before.
			//
			// Cell from world position, matching §12.4's mapping. Missing shroud fails closed,
			// and unexplored ground still reveals nothing whatever the actor's own contract says.
			if (shroud !== null) {
				const cx = Math.floor(actors.posX[i] * WPOS_TO_M)
				const cy = Math.floor(actors.posY[i] * WPOS_TO_M)
				const state = shroud.stateAt(cx, cy)
				if (!fallingHusk && this.typeShroudOnly.get(typeId) === true
					? state === ShroudState.unexplored
					: state !== ShroudState.visible) {
					skinStats.shroudCulled++
					continue
				}
			}
			const deploymentProgress = this.deploymentStates.progressOf(actors.id[i],alpha)
			const deploying = slotName === 'fact' && deploymentProgress < 1 && this.deploymentRigs.has(this.slotBuckets.get('fact')?.rig as SlotRig)
			let drawnSlot = deploying ? slotName : displaySlotName != null ? this.damage.opaqueSlot(actors.id[i], displaySlotName, actors.health[i],ambientCondition) ?? displaySlotName : null
			if (displaySlotName === 'e2' && sovietOwner(ctx, actors.owner[i]) && drawnSlot !== null)
				drawnSlot = drawnSlot === 'e2' ? 'e2.soviet' : drawnSlot.replace(/^e2(?=\.)/, 'e2.soviet')
			const b = (drawnSlot != null ? this.slotBuckets.get(drawnSlot) : undefined)
				?? this.buckets[cls + (vehicle ? UNIT_CLASS_COUNT : 0)]
			if (!b || b.count >= b.capacity) continue
			const x = xWPos * WPOS_TO_M
			const z = zWPos * WPOS_TO_M
			const altitudeM = altitudeWPos * WPOS_TO_M
			if (this.living.wall(slotName,actors.id[i],x,terrain.heightAt(x,z),z,actors.owner[i],1-actors.health[i]/255)) continue

			// WAngle is 0..1023 counterclockwise from north. A yaw rotation about render Y.
			const yaw = wangleToRadians(facing)
			const c = Math.cos(yaw)
			const s = Math.sin(yaw)

			// --- ground contact --------------------------------------------------
			// The maths lives in units/place so `tools/groundgate.mjs` can call the same
			// function the renderer calls. A contact check that reimplements the placement is
			// checking its own copy.
			//
			// Written BEFORE the headlamp block, because the lamp hangs off the hull and the
			// hull is now tilted — reading the placed matrix keeps the lamp on the machine
			// instead of on the flat-ground position the machine used to occupy.
			const g = slotName != null ? this.slotGround.get(slotName) : undefined
			const o = b.count * 16
			const m = b.instances
			const watercraft = this.typeWatercraft.get(typeId) ?? false
			const waterStructure = this.typeWaterStructure.get(typeId) ?? false
			const waterLevel = watercraft || waterStructure ? terrain.waterHeightAt(x, z) : null
			const supportMinY = b.mesh?.aabbMin[1] ?? 0
			if (waterLevel !== null) {
				// Vessel meshes declare local y=0 as their waterline. Docks declare their lowest
				// support point, so the deck remains above the animated surface.
				placeActorAtLevel(m, o, x, z, yaw, waterLevel,
					waterSupportMinY(watercraft, supportMinY))
				// OpenRA's Cloak trait is the synchronized underwater state for submarines. Lowering
				// their hull lets the later transparent water pass partially occlude it.
				// Submergence is a visual response to travel; gameplay cloak stays authoritative.
			} else {
				// A paratrooper under canopy is drawn at the altitude OpenRA holds it at
				// (Parachutable.IsInAir, actor flag 1<<2); on the ground it stands like any soldier.
				const aloft = g?.airborne === true || (actors.flags[i] & ActorFlag.parachuting) !== 0
				placeActor(
					m, o, x, z, yaw,
					g?.halfLen ?? DEFAULT_HALF_EXTENT,
					g?.halfWid ?? DEFAULT_HALF_EXTENT,
					aloft,
					aircraftClearanceAltitude(aloft && !fallingHusk,this.flatAircraftSource,x,z,yaw,
						g?.halfLen ?? DEFAULT_HALF_EXTENT,g?.halfWid ?? DEFAULT_HALF_EXTENT,
						altitudeM,this.heightProbe,supportMinY),
					this.heightProbe,
					supportMinY,
				)
			}
			if(fallingHusk){
    const support=Math.max(terrain.heightAt(x,z),terrain.waterHeightAt(x,z)??-Infinity)
    m[o+13]=Math.max(support-supportMinY,altitudeM+(this.flatAircraftSource?support:0))
   }
   if (g?.airborne !== true)
				applyFitScale(m, o, g?.fitScale ?? 1,
					waterLevel !== null ? waterSupportMinY(watercraft, supportMinY) : supportMinY)
			const motionProfile = slotName ? MOTION_PROFILES[slotName] : undefined
			if (motionProfile && b.mesh && (g?.airborne || waterLevel !== null))
				this.presentationMotion.apply(m,o,actors.id[i],motionProfile,nowS,x,z,yaw,altitudeM,
					(actors.flags[i]&ActorFlag.husk)===0 && actors.health[i]>0,
					sky?.environment.windX??0,sky?.environment.windZ??0,sky?.environment.windStrength??0,
					b.mesh.aabbMin,b.mesh.aabbMax,this.flightHeight,(actors.flags[i]&ActorFlag.moving)!==0)
			if (deploying) this.placeDeploymentStart(m,o,actors.id[i],deploymentProgress)

			const actorId = actors.id[i]
			// One pose, one palette reservation, one skin-matrix evaluation. Turret, wheels and
			// legs are authoritative inputs to the SAME skeleton; resetting between them made
			// the last subsystem win and silently erased every earlier articulation.
			let attachmentSkin: Float32Array | null = null
			if (b.paletteBases !== null && b.rig !== null) {
				let paletteBase = 0
				const reserved = render.reserveBones(b.rig.skeleton.boneCount)
				if (reserved !== null) {
					b.rig.pose.resetToBind()
					let articulated = false
					const owner = actors.owner[i]
					const factionName = ctx.snapshot?.players[owner]
						? ctx.actorTypeName(ctx.snapshot.players[owner].factionId)
						: ''
					if (applyOwnerFlag(b.rig, factionName)) articulated = true
					// Every Turreted instance has an absolute authoritative facing in the
					// snapshot; the corresponding bone is hull-local.
					const turretCount = Math.min(b.rig.turretBones.length, actors.turretCount[i])
					const turretOffset = actors.turretOffset[i]
					for (let turret = 0; turret < turretCount; turret++) {
						const turretIndex = turretOffset + turret
						if (turretIndex >= actors.turretFacing.length) break
						let turretFacing = actors.turretFacing[turretIndex]
						if (previousIndex >= 0 && previousActors !== null && turret < previousActors.turretCount[previousIndex]) {
							const previousTurretIndex = previousActors.turretOffset[previousIndex] + turret
							if (previousTurretIndex < previousActors.turretFacing.length)
								turretFacing = lerpFacing(previousActors.turretFacing[previousTurretIndex], turretFacing, alpha)
						}
						setBoneAngle(
							b.rig.pose,
							b.rig.turretBones[turret],
							wrapRadians(wangleToRadians(turretFacing) - yaw),
						)
						articulated = true
						// Ultra: the turret kicks back along its bore when its gun fires, and returns at the
						// rules' recovery rate.
						if (turret === 0 && turretKick && slotName) {
							const kick = this.turretKickOf(slotName)
							const since = kick !== null ? anim?.secondsSinceFire(actorId, alpha) ?? -1 : -1
							if (kick !== null && since >= 0 && since < RECOIL_HOLD_S + kick.recoveryS)
								setBoneKick(b.rig.pose, b.rig.turretBones[turret],
									kick.metres * (since < RECOIL_HOLD_S ? 1 : 1 - (since - RECOIL_HOLD_S) / kick.recoveryS))
						}
					}
				// Wheels. Rotation is travelled distance over the rolling radius, exactly —
				// a wheel turns once per 2*pi*r of ground, so this cannot slip against the
				// hull the way a rate constant would. `anim` supplies the metres and the rig
				// carries each wheel's own radius, so a chassis with mixed wheel sizes stays
				// consistent without units knowing anything about the geometry.
				//
				// BoneKind.wheel pins the axis to lateral in rig.ts, correct only since
				// 8376cae — before that file's convention was fixed every one of these would
				// have rolled about the wrong axis.
				const wheels = b.rig.wheelBones
				if (wheels.length > 0) {
					const fit = this.slotGround.get(slotName ?? '')?.fitScale ?? 1
					for (let w = 0; w < wheels.length; w++) {
						const r = b.rig.wheelRadii[w]
						const lateral = b.rig.skeleton.bindT[wheels[w] * 3 + 2] * fit
						const travelled = anim.sideDistanceOf(actors.id[i], lateral, alpha)
						if (r > 1e-4) setBoneAngle(b.rig.pose, wheels[w], wrapRadians(-travelled / r))
					}
					articulated = true
				}

				// Legacy infantry fallback: distance-driven phase synchronizes stepping rate
				// and stops motion when travel stops. A hip-only sine does NOT guarantee foot
				// planting or natural knees/ankles. The anatomical source study must gain a
				// verified authored locomotion cycle before replacing the playable roster.
				const legs = b.rig.legBones
				if (this.rikiAssets !== null && this.rikiRigs.has(b.rig)) {
					poseRiki(this.rikiAssets, b.rig.pose,
						anim.interpolatedDistanceOf(actorId, alpha) / (g?.fitScale ?? 1),
						Math.abs(anim.interpolatedDistanceOf(actorId, 1) - anim.interpolatedDistanceOf(actorId, 0)) > 1e-6,
						anim.interpolatedAimOf(actorId, alpha), anim.secondsSinceFire(actorId, alpha),
						actors.animState[i] === ActorAnimationState.prone)
					articulated = true
				} else if (this.humanMotion !== null && this.humanRigs.has(b.rig)) {
					sampleHumanMotion(this.humanMotion.clip, b.rig.pose,
						anim.interpolatedDistanceOf(actors.id[i], alpha) / this.humanMotion.scale)
					// The walk keys nothing above the pelvis -- every arm bone in it is exactly
					// 0.00 degrees on all 33 frames -- so these two overlays are the only arm
					// motion this game has. They own the upper body only; the gait underneath is
					// whatever the distance-driven walk just wrote, which is what lets a rifleman
					// fire while he is still moving.
					const aimWeight = anim.interpolatedAimOf(actors.id[i], alpha)
					const aimClip = this.humanMotion.aim
					// Weight AND clock come from the same ramp: at zero the overlay returns
					// before touching a bone, so an idle actor keeps the walk's own torso sway
					// instead of having it flattened to bind by a full-weight blend to frame 0.
					if (aimClip !== null && aimWeight > 0)
						overlayHumanMotionClip(aimClip, b.rig.pose, aimWeight * aimClip.durationS, aimWeight)
					const fireClip = this.humanMotion.fire
					if (fireClip !== null) {
						const since = anim.secondsSinceFire(actors.id[i], alpha)
						// One pulse per shot, at full weight: a recoil that faded in would not be
						// an impulse. Outside the clip's own duration it is simply not playing.
						if (since >= 0 && since < fireClip.durationS)
							overlayHumanMotionClip(fireClip, b.rig.pose, since, 1)
					}
					articulated = true
				} else if (legs.length > 0 && b.rig.strideM > 0) {
						const cycle = (anim.distanceOf(actors.id[i]) / b.rig.strideM) * Math.PI * 2
						for (let g = 0; g < legs.length; g++)
							setBoneAngle(b.rig.pose, legs[g], Math.sin(cycle + b.rig.legPhase[g]) * GAIT_SWING)
						articulated = true
				}
					for (let rotor = 0; rotor < b.rig.rotorBones.length; rotor++) {
						setBoneAngle(b.rig.pose, b.rig.rotorBones[rotor],
							wrapRadians(this.mechanicalClock.seconds(actors.id[i], ctx.time.alpha) * b.rig.rotorSpeeds[rotor]))
						articulated = true
					}
					for (let mechanism = 0; mechanism < b.rig.oscillatorBones.length; mechanism++) {
						const phase = this.mechanicalClock.seconds(actors.id[i], ctx.time.alpha) * b.rig.oscillatorSpeeds[mechanism] + b.rig.oscillatorPhases[mechanism]
						setBoneAngle(b.rig.pose, b.rig.oscillatorBones[mechanism], Math.sin(phase) * b.rig.oscillatorAmplitudes[mechanism])
						articulated = true
					}
					if (b.rig.doorBones.length > 0) {
						const id = actors.id[i]
						const cargo = actors.cargo[i]
						const reserved = actors.cargoReserved ? actors.cargoReserved[i] : 0
						const prevCargo = this.lastCargo.get(id)
						if (prevCargo !== undefined && cargo < prevCargo)
							this.rampHoldUntil.set(id, (ctx.time.tick + ctx.time.alpha) / SIM_TICK_HZ + RAMP_HOLD_S)
						this.lastCargo.set(id, cargo)
						const now = (ctx.time.tick + ctx.time.alpha) / SIM_TICK_HZ
						const wantOpen = reserved > 0 || (this.rampHoldUntil.get(id) ?? 0) > now
						let open = this.rampOpen.get(id) ?? 0
						const step = Math.min(1, Math.max(0, dt) * RAMP_SLEW / RAMP_OPEN_RAD)
						open = wantOpen ? Math.min(1, open + step) : Math.max(0, open - step)
						this.rampOpen.set(id, open)
						const angle = open * RAMP_OPEN_RAD
						for (let d = 0; d < b.rig.doorBones.length; d++)
							setBoneAngle(b.rig.pose, b.rig.doorBones[d], angle)
						articulated = true
					}
					if (b.rig.windBones.length > 0) {
						// Frame-invariant, hoisted out of both loops this block used to
						// re-read it per actor per branch for.
						const seconds = sky.environment.motionTime ?? (ctx.time.tick + ctx.time.alpha) / SIM_TICK_HZ
						const gustWind = sky.environment.windStrength ?? 0
						for (let branch = 0; branch < b.rig.windBones.length; branch++) {
							const phase = seconds * b.rig.windSpeeds[branch] + b.rig.windPhases[branch] + x * .43 + z * .31
							const gust = Math.sin(phase) + Math.sin(phase * 2.17) * .24
							setBoneAngle(b.rig.pose, b.rig.windBones[branch], gust * b.rig.windAmplitudes[branch] * gustWind)
							articulated = true
						}
					}
					const deploymentRig = this.deploymentRigs.get(b.rig)
					if (deploymentRig) {
						deploymentRig.sample(b.rig.pose,deploymentProgress)
						articulated=true
					}
					if (articulated) {
						computeWorldTransforms(b.rig.pose, b.rig.world)
						computeSkinMatrices(b.rig.skeleton, b.rig.world, reserved.matrices)
						if (this.rikiAssets && this.rikiRigs.has(b.rig)) {
							let posed = this.posedRifleMuzzles.get(actorId)
							// Lazy per-actor memo, not a per-frame allocation: written once per
							// actor, then reused from the map on every later frame.
							if (!posed) { posed = new Float32Array(6); this.posedRifleMuzzles.set(actorId, posed) } // rulecheck-allow: one-time memo
							const { pos, direction } = this.rikiAssets.manifest.muzzle
							const k = this.rikiAssets.muzzleBone * 16, s = reserved.matrices
							for (let a = 0; a < 3; a++) {
								posed[a] = s[k + a] * pos[0] + s[k + 4 + a] * pos[1] + s[k + 8 + a] * pos[2] + s[k + 12 + a]
								posed[3 + a] = s[k + a] * direction[0] + s[k + 4 + a] * direction[1] + s[k + 8 + a] * direction[2]
							}
						}
						attachmentSkin=reserved.matrices
						paletteBase = reserved.base
						skinStats.posedActors++
					} else skinStats.bindPoseActors++
				} else skinStats.paletteOverflows++
				b.paletteBases[b.count] = paletteBase
			}

			if(b.mesh)this.attachments.place(actorId,b.mesh,m,o,attachmentSkin)

			// `anim` owns cumulative travel; source metadata owns the measured UV repeat.
			// Apply the same fit as placement before mapping either side into texture space.
			if (b.phases !== null) {
				const contact = this.runningGear.get(slotName ?? '')
				// Rigged tyres rotate with their bones; scrolling them again would double motion.
				const period = contact?.uvRepeatM ?? UV_METRES
				b.phases[b.count] = contact?.kind === 'wheeled' ? 0 : packRunningPhases(
					anim.sideDistanceOf(actors.id[i], contact?.leftZ ?? 0, alpha) / period,
					anim.sideDistanceOf(actors.id[i], contact?.rightZ ?? 0, alpha) / period)
			}
			// Snapshot health is 255 pristine. The shader contract is the inverse: damage01
			// is 0 pristine and 1 destroyed, which keeps full health exactly defeated.
			b.damages[b.count] = appearanceDamage

			if (vehicle) {
				lampStats.vehicles++
				// A slot hull carries NO lamp housing — the archetype generators do not build
				// one yet — so emitting a headlamp on it puts a light in the world with
				// nothing visible producing it. §9.0 is explicit: if you cannot name the bulb,
				// it does not glow, and an unhoused point light is exactly that. Found by
				// Codex on review of 2e89427.
				//
				// The class path still lights, because `attachHeadlampHousings` builds a real
				// pair of housings into that mesh. When the archetype families grow lamp
				// geometry this becomes a per-slot mount lookup rather than a suppression.
				const mount = slotName != null ? null : headlampMountForClass(cls)
				if (mount && lampStats.factor > 0) {
					// Off the PLACED matrix: column 0 is the hull's forward axis and column 1
					// its up axis, both now tilted to the ground. Using flat-ground (c,0,-s)
					// here would leave the lamp hanging in the air beside a tilted machine.
					render.addLight(
						m[o + 12] + m[o] * mount.emitterX + m[o + 4] * mount.height,
						m[o + 13] + m[o + 1] * mount.emitterX + m[o + 5] * mount.height,
						m[o + 14] + m[o + 2] * mount.emitterX + m[o + 6] * mount.height,
						HEADLAMP_R,
						HEADLAMP_G,
						HEADLAMP_B,
						HEADLAMP_INTENSITY * lampStats.factor,
						HEADLAMP_RADIUS,
					)
					lampStats.lights++
				}
			}

			// --- aircraft and rotorcraft lights (night only) ----------------------
			// Source-bound rotorcraft fixtures use the shared night transition and posed hull.
			// Chinook: two down/one forward; other helicopters: one down/one forward.
			// Fixedwing retain their strobe; moving MiGs light their actual exhaust nozzles.
			if (g?.airborne === true && lampStats.factor > 0 && (actors.flags[i] & ActorFlag.husk) === 0 && actors.health[i] > 0) {
				const fx = m[o + 0], fy = m[o + 1], fz = m[o + 2]
				const ux = m[o + 4], uy = m[o + 5], uz = m[o + 6]
				const family = RA_ACTOR_VISUALS[ctx.actorTypeName(typeId).toLowerCase()]?.visualFamily
				const rotorcraft = family === 'rotorcraft'
				if (rotorcraft) {
					const mounts = (drawnSlot ? PRESENTATION_BINDINGS[drawnSlot]?.lights : null) ?? (slotName ? PRESENTATION_BINDINGS[slotName]?.lights : null) ?? []
					for (const lamp of mounts) {
						const [lx,ly,lz] = lamp.position
						const [dx,dy,dz] = lamp.direction
						render.addSpotLight(
							m[o+12]+fx*lx+ux*ly+m[o+8]*lz,
							m[o+13]+fy*lx+uy*ly+m[o+9]*lz,
							m[o+14]+fz*lx+uz*ly+m[o+10]*lz,
							fx*dx+ux*dy+m[o+8]*dz,fy*dx+uy*dy+m[o+9]*dz,fz*dx+uz*dy+m[o+10]*dz,
							1,.96,.86,12*lampStats.factor,9,.94,.82)
						lampStats.lights++
					}

				} else {
					const blinkOn = (nowS % 1.4) < 0.12
					if (blinkOn) {
						render.addLight(
							m[o + 12] + ux * 0.4,
							m[o + 13] + uy * 0.4,
							m[o + 14] + uz * 0.4,
							1.0, 0.22, 0.16,
							2.2 * lampStats.factor,
							HEADLAMP_RADIUS * 0.7,
						)
						lampStats.lights++
					}
					const speed = actors.speed[i]
					const moving = speed !== 0xffff && speed > 8
                    if (moving && slotName === 'mig') for(const nozzle of PRESENTATION_BINDINGS[drawnSlot??slotName]?.exhausts??[]) {
                        const [x,y,z]=nozzle.position
                        render.addLight(m[o+12]+m[o]*x+m[o+4]*y+m[o+8]*z,m[o+13]+m[o+1]*x+m[o+5]*y+m[o+9]*z,m[o+14]+m[o+2]*x+m[o+6]*y+m[o+10]*z,1,.45,.15,.75*lampStats.factor,HEADLAMP_RADIUS*.6)
                        lampStats.lights++
                    }
				}
 			}
			b.motionIds[b.count] = actors.id[i]
			// Capture index: pickers (health bars, marks, muzzles, deaths) resolve this
			// actor from the bucket in O(1) instead of scanning every bucket per actor.
			// Entries are validated against the bucket on read, so a stale entry after
			// compaction or death is simply a miss - identical semantics to the scan.
			let placementEntry = this.placementIndex.get(actors.id[i])
			if (placementEntry === undefined) {
				placementEntry = { bucket: null, index: 0 }
				this.placementIndex.set(actors.id[i], placementEntry)
			}
			placementEntry.bucket = b
			placementEntry.index = b.count
			// Off the PLACED matrix, so the fading half sits on exactly the same terrain fit as
			// the opaque half. Anything else and the two rungs would slide against each other.
			if (slotName != null)
				this.damage.capture(actors.id[i], slotName, actors.health[i], m, o,
					actors.owner[i], b.paletteBases?.[b.count] ?? 0,appearanceDamage)
			// Caster mirror row: the first `localShadowCasters` mobile, living actors in
			// snapshot order keep their shadows; everyone else's instance is main-pass only.
			const st = b.shadow
			if (this.casterBudget > 0 && skinStats.casters < this.casterBudget && this.typeMobile.get(typeId) === true) {
				const so = st.count * 16
				for (let k = 0; k < 16; k++) st.instances[so + k] = m[o + k]
				st.colors[st.count] = b.colors[b.count]
				st.motionIds[st.count] = b.motionIds[b.count]
				if (st.paletteBases !== null && b.paletteBases !== null) st.paletteBases[st.count] = b.paletteBases[b.count]
				if (st.phases !== null && b.phases !== null) st.phases[st.count] = b.phases[b.count]
				st.damages[st.count] = b.damages[b.count]
				st.count++
				skinStats.casters++
			}
			b.count++
		}

		this.attachments.end()
		this.placeFrozenActors(ctx)
		this.excludeSceneryUnderBuildings()
		if (shroud) this.scenery.update(ctx, render, terrain, sky, shroud, true)
		if (shroud) this.living.update(ctx, render, terrain, shroud)
		if (shroud) this.grass.update(ctx, render, terrain, shroud)

		// Both bucket sets go through the same submit. An empty bucket costs one comparison,
		// so 44 archetype buckets on a map that uses six of them is not a per-frame cost
		// worth optimising — and a conditional here would be a second code path to keep in
		// step with the first.
		for (const b of this.buckets) submitBucket(render, b)
		for (const b of this.slotBuckets.values()) submitBucket(render, b)
		// After the opaque buckets: a cross-fade is a translucent item and the renderer sorts
		// it into the late pass regardless, but submitting in this order keeps the read order
		// of the frame the same as its draw order.
		this.damage.submit(render)
	}

	/**
	 * Upload every authored condition ladder and give each rung its own bucket.
	 *
	 * A rung is not an actor: it never enters `slotGround`, `typeSlot` or the placement
	 * catalogue, so the simulation cannot be handed five extra units. It is a second mesh in
	 * `slotBuckets` under a key the snapshot can never name, reachable only through
	 * `damage.opaqueSlot`.
	 *
	 * A rung without a declared detailMask inherits the PARENT's resolved surface set. Optional
	 * source-bound rung masks override only UV1; all PBR arrays stay shared. Legacy rungs are cut from
	 * the parent scene and pinned to one texel of the parent's own 256² bake, so sharing the
	 * material is not an approximation — it is the reason five destruction states cost zero
	 * texture bytes.
	 */
	private async buildDamageLadders(blender: Awaited<ReturnType<typeof loadBlenderAssets>>): Promise<void> {
		if (!this.render || !this.materials || !blender) return
		const render = this.render
		let packs: Awaited<ReturnType<typeof loadDamageStates>>
		try {
			packs = await loadDamageStates(actor => blender.manifest.assets[actor]?.sourceSha256)
		} catch (error) {
			// A ladder is additive: without it an actor draws its intact mesh and looks the way
			// it did last week. A stale or corrupt one is NOT additive — it is a wrong render of
			// a mesh whose parent has moved — so it is refused loudly and the roster carries on.
			this.forgeStats.errors.push(`damage states: ${String(error)}`)
			console.warn(`[units] condition ladders unavailable: ${String(error)}`)
			return
		}
		// Each rung decodes an asset and uploads it, and upload builds the LOD chain
		// synchronously. Without a yield between rungs the whole ladder build runs as
		// ONE continuous main-thread block — observed at ~12 s — which starves every
		// pending bridge rpc (join probes never settle; the join state machine sits
		// on S3 until it ends). "Background" here means cooperative: the loop gives
		// the event loop a breath after every rung, so timers, rAF and rpc settles
		// run while the ladders land.
		const yieldToEventLoop = yieldCooperatively
		let rungs = 0
		for (const [actor, pack] of packs) {
			const parent = this.slotBuckets.get(actor)
			if (!parent?.mesh) { this.forgeStats.errors.push(`damage states: ${actor} has no roster bucket`); continue }
			const deathKind = this.deaths.kind(parent.mesh)
			this.damage.register(actor, 0, actor, parent.mesh, parent.surfaceSet, parent.rig?.skeleton.boneCount ?? 0)
			for (const entry of pack.manifest.states) {
				const rung = DAMAGE_RUNG_OF_STATE[entry.state] ?? -1
				if (rung < 1 || rung >= RUNG_COUNT) continue
				const slotKey = `${actor}.d${rung}`
				try {
					let surfaceSet = parent.surfaceSet
					if (entry.detailMask) {
						surfaceSet = `${entry.materialSet}:damage:${pack.manifest.actor}:${entry.state}`
						if (entry.detailMask.sourceSha256 !== entry.sourceSha256 || !this.materials.has(surfaceSet) || this.materials.get(surfaceSet).sourceSha256 !== entry.sourceSha256)
							throw new Error('Missing or stale source-bound damage material')
					}
					const decoded = decodeBlenderAsset(pack.bytes, entry)
					const mesh = render.upload(decoded.mesh, `units:damage:${slotKey}`)
					const rig = toSlotRig(decoded.rig)
					this.attachments.bind(mesh,slotKey,entry.sourceSha256)
					// Same death family as the parent. Without this the mesh is unknown to
					// `DeathVisuals`, `deathKindOf` answers 0, and a tank killed while drawn on
					// its Critical rung would be persisted as a standing wreck instead of
					// breaking up — a silent regression that only shows on damaged actors.
					this.deaths.register(mesh, deathKind, rig?.skeleton ?? null, decoded.mesh, this.deaths.airborne(parent.mesh))
					const paletteBases = rig === null ? null : new Uint16Array(DAMAGE_BUCKET_CAPACITY)
					const phases = parent.phases === null ? null : new Float32Array(DAMAGE_BUCKET_CAPACITY)
					const damages = new Float32Array(DAMAGE_BUCKET_CAPACITY)
					this.slotBuckets.set(slotKey, {
						cls: parent.cls, headlamps: false, surfaceSet, mesh,
						capacity: DAMAGE_BUCKET_CAPACITY,
						instances: new Float32Array(DAMAGE_BUCKET_CAPACITY * 16),
						colors: new Uint8Array(DAMAGE_BUCKET_CAPACITY),
						motionIds: new Uint32Array(DAMAGE_BUCKET_CAPACITY),
						paletteBases, phases, damages, rig, count: 0,
						shadow: makeShadowBucket(mesh, DAMAGE_BUCKET_CAPACITY, paletteBases, phases, parent.item.alphaCutout),
						item: {
							mesh, alphaCutout: parent.item.alphaCutout, surfaceSet,
							instances: new Float32Array(0), instanceCount: 0, playerColors: null,
							paletteBases, motionIds: null, boneCount: rig?.skeleton.boneCount ?? 0,
							phases, damages, castsShadow: false,
						},
					})
					this.damage.register(actor, rung, slotKey, mesh, surfaceSet, rig?.skeleton.boneCount ?? 0)
					this.forgeStats.triangles += decoded.mesh.triangleCount
					rungs++
				} catch (error) {
					this.forgeStats.errors.push(`${slotKey}: ${String(error)}`)
					console.warn(`[units] ${slotKey}: invalid damage state, the rung below it stands in: ${String(error)}`)
				}
				// One breath per rung: decode + LOD upload above are synchronous CPU.
				await yieldToEventLoop()
			}
		}
		if (rungs > 0) console.log(`[units] ${rungs} condition rungs across ${packs.size} actor(s)`)
		// The ladders land in the background now; the Soviet clones must follow them.
		this.cloneE2SovietBuckets()
	}

	/** Presentation-only white Soviet E2 clones: same meshes/rigs, separate palette arrays and atlas. */
	private cloneE2SovietBuckets(): void {
		if (!this.materials?.has(E2_SOVIET_MATERIAL)) return
		for (const [name, source] of [...this.slotBuckets]) {
			// Only e2 and its damage rungs (e2.d1, e2.d2, …). Any other two-letter slot, such as
			// c1, would otherwise claim `e2.soviet` first and give the Soviet grenadier its mesh.
			if (!/^e2(\.d\d+)?$/.test(name)) continue
			// Late-arriving damage rungs re-run this clone; never clobber live instances.
			const target = `e2.soviet${name === 'e2' ? '' : name.slice(2)}`
			if (this.slotBuckets.has(target)) continue
			const paletteBases = source.paletteBases === null ? null : new Uint16Array(source.capacity)
			const phases = source.phases === null ? null : new Float32Array(source.capacity)
			const damages = new Float32Array(source.capacity)
			this.slotBuckets.set(`e2.soviet${name === 'e2' ? '' : name.slice(2)}`, {
				...source,
				surfaceSet: E2_SOVIET_MATERIAL,
				instances: new Float32Array(source.capacity * 16),
				colors: new Uint8Array(source.capacity),
				motionIds: new Uint32Array(source.capacity),
				paletteBases,
				phases,
				damages,
				count: 0,
				// `...source` copies the mirror by reference; the clone needs its own arrays.
				shadow: makeShadowBucket(source.item.mesh, source.capacity, paletteBases, phases, source.item.alphaCutout),
				item: {
					...source.item,
					surfaceSet: E2_SOVIET_MATERIAL,
					instances: new Float32Array(0),
					instanceCount: 0,
					playerColors: null,
					paletteBases,
					phases,
					damages,
				},
			})
		}
	}

	/**
	 * The authored Dead-rung visual for whatever actor owns `mesh`. Used by `wrecks`.
	 *
	 * Suppressed for the 36 actors OpenRA already gives a `.husk`: the simulation spawns a
	 * real husk ACTOR on their death, and a persistent Dead rung on top of it would leave two
	 * wrecks in one place. Structures have no husk, which is why the ladder is worth most
	 * there — and why a Dead rung authored for `2tnk` would be the mistake this prevents.
	 */
	deadRungOf(mesh: GpuMesh): { mesh: GpuMesh; surfaceSet: string } | null {
		const actor = this.damage.actorOfMesh(mesh)
		if (actor === undefined || RA_ACTOR_VISUALS[`${actor}.husk`] !== undefined) return null
		return this.damage.deadRungOf(mesh)
	}

	/** Large battles skip actors outside the camera footprint. The pad covers one pan frame. */
	private updateViewCull(ctx: Ctx, actorCount: number): void {
		this.viewCull = null
		if (actorCount < 480) return
		const cam = ctx.peek<{ viewGroundQuad?(out: Float32Array, w: number, h: number): boolean } | null>('camera')
		if (!cam?.viewGroundQuad?.(this.viewQuad, canvasCssWidth(ctx) || 1, canvasCssHeight(ctx) || 1)) return
		const q = this.viewQuad
		let minX = q[0], maxX = q[0], minZ = q[1], maxZ = q[1]
		for (let i = 2; i < 8; i += 2) {
			const x = q[i], z = q[i + 1]
			if (x < minX) minX = x
			if (x > maxX) maxX = x
			if (z < minZ) minZ = z
			if (z > maxZ) maxZ = z
		}
		const pad = 64
		this.viewCull = { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad }
	}

	private outsideView(x: number, z: number): boolean {
		const view = this.viewCull
		return view !== null && (x < view.minX || x > view.maxX || z < view.minZ || z > view.maxZ)
	}

	private excludeSceneryUnderBuildings(): void {
		// Only this frame's actually drawn (live or remembered) buildings. Unseen enemy
		// construction/destruction must not alter visible grass or remembered foundations.
		for (const [name,bucket] of this.slotBuckets) {
			// A condition rung is keyed `powr.d3`, which the OpenRA catalogue has never heard of.
			// Resolve it back to its actor so a damaged building keeps occluding the grass under
			// its own footprint instead of sprouting a lawn the moment it takes a hit.
			const visual = RA_ACTOR_VISUALS[name] ?? RA_ACTOR_VISUALS[this.damage.actorOfSlot(name) ?? '']
			if (!bucket.mesh || !hasRaTrait(visual, 'Building')) continue
			const lo=bucket.mesh.aabbMin,hi=bucket.mesh.aabbMax,m=bucket.instances
			const cx=(lo[0]+hi[0])*.5,cz=(lo[2]+hi[2])*.5,hx=(hi[0]-lo[0])*.5,hz=(hi[2]-lo[2])*.5
			for(let i=0;i<bucket.count;i++) {
				const o=i*16,x=m[o+12]+m[o]*cx+m[o+8]*cz,z=m[o+14]+m[o+2]*cx+m[o+10]*cz
				const ex=Math.abs(m[o])*hx+Math.abs(m[o+8])*hz,ez=Math.abs(m[o+2])*hx+Math.abs(m[o+10])*hz
				this.scenery.addOccluder(x-ex,z-ez,x+ex,z+ez)
			}
		}
	}

	private placeDeploymentStart(out: Float32Array,o:number,id:number,progress:number,remembered=false):void {
		const yardRig=this.slotBuckets.get('fact')?.rig
		progress /= (yardRig ? this.deploymentRigs.get(yardRig)?.prefixEnd : undefined) ?? 1
		if(progress>=.12 || !this.deploymentStates.sourceOf(id,this.deploymentSource,remembered))return
		const g=this.slotGround.get('mcv'),source=this.deploymentSource,mesh=this.slotBuckets.get('mcv')?.mesh
		if(!g||!mesh)return
		placeActor(this.deploymentMatrix,0,source[1]*WPOS_TO_M,source[2]*WPOS_TO_M,wangleToRadians(source[4]),g.halfLen,g.halfWid,false,source[3]*WPOS_TO_M,this.heightProbe,mesh.aabbMin[1])
		settleDeploymentBasis(out,o,this.deploymentMatrix,progress)
	}

	private placeFrozenActors(ctx: Ctx): void {
		const frozen = ctx.snapshot?.frozenActors
		const shroud = this.shroud
		const terrain = this.terrain
		if (!frozen || !shroud || !terrain) return
		const liveActors = ctx.snapshot?.actors ?? null
		for (let i = 0; i < frozen.count; i++) {
			if (this.typeRenderable.get(frozen.typeId[i]) === false) continue
			const x = frozen.posX[i] * WPOS_TO_M
			const z = frozen.posY[i] * WPOS_TO_M
			if (this.outsideView(x, z)) continue
			// The producer publishes only OpenRA FrozenUnderFog records. The client still
			// refuses UNEXPLORED ground, so a malformed section cannot reveal a structure the
			// player has never been to.
			//
			// It used to demand exactly EXPLORED, on the reasoning that a cell which has turned
			// VISIBLE is the live actor's job. That is true only when the live actor is in the
			// same snapshot, and the two sets are decided by different predicates on the host —
			// so any frame where they disagree about one cell left the building drawn by neither
			// path. The live set is ordered by id and searchable, so ask it instead of assuming:
			// draw the remembered copy unless the real one is already here.
			if (shroud.stateAt(Math.floor(x), Math.floor(z)) === ShroudState.unexplored) continue
			if (liveActors !== null && findActorIndex(liveActors, frozen.id[i]) >= 0) continue
			const typeId = frozen.typeId[i]
			const cls = this.typeClass.get(typeId) ?? UnitClass.drift
			const slotName = this.typeSlot.get(typeId)
			const fallingHusk = slotName?.endsWith('.husk') === true && this.slotGround.get(slotName)?.airborne === true
			const ambientSeed = slotName != null ? this.ambientBuildingSeeds.get(slotName) : undefined
			const ambientCondition = ambientSeed === undefined ? 0 : warzoneCondition(ambientSeed,frozen.posX[i],frozen.posY[i])
			const deploymentProgress=this.deploymentStates.rememberedProgressOf(frozen.id[i])
			const pairedYard=slotName==='fact' && this.deploymentRigs.has(this.slotBuckets.get('fact')?.rig as SlotRig)
			const rememberedSlot = pairedYard && deploymentProgress<1 ? slotName : slotName != null ? this.damage.rememberedSlot(slotName,frozen.health[i],ambientCondition) ?? slotName : null
			const b = (rememberedSlot != null ? this.slotBuckets.get(rememberedSlot) : undefined) ?? this.buckets[cls]
			if (this.living.wall(slotName,frozen.id[i],x,terrain.heightAt(x,z),z,frozen.owner[i],1-frozen.health[i]/255)) { this.frozenStats.drawn++; continue }
			if (!b || b.count >= b.capacity) continue
			const g = slotName != null ? this.slotGround.get(slotName) : undefined
			const o = b.count * 16
			const waterStructure = this.typeWaterStructure.get(typeId) ?? false
			const waterLevel = waterStructure ? terrain.waterHeightAt(x, z) : null
			const supportMinY = b.mesh?.aabbMin[1] ?? 0
			if (waterLevel !== null)
				placeActorAtLevel(b.instances, o, x, z, 0, waterLevel, supportMinY)
			else placeActor(
				b.instances, o, x, z, pairedYard?wangleToRadians(0):0,
				g?.halfLen ?? DEFAULT_HALF_EXTENT,
				g?.halfWid ?? DEFAULT_HALF_EXTENT,
				false,
				frozen.posZ[i] * WPOS_TO_M,
				this.heightProbe,
				supportMinY,
			)
			applyFitScale(b.instances, o, g?.fitScale ?? 1, supportMinY)
			if (b.paletteBases !== null) b.paletteBases[b.count] = 0
			const deploymentRig=b.rig?this.deploymentRigs.get(b.rig):undefined
			if(deploymentRig && b.rig && b.paletteBases && deploymentProgress < 1){
				this.placeDeploymentStart(b.instances,o,frozen.id[i],deploymentProgress,true)
				const reserved=this.render!.reserveBones(b.rig.skeleton.boneCount)
				if(reserved){b.rig.pose.resetToBind();deploymentRig.sample(b.rig.pose,deploymentProgress);computeWorldTransforms(b.rig.pose,b.rig.world);computeSkinMatrices(b.rig.skeleton,b.rig.world,reserved.matrices);b.paletteBases[b.count]=reserved.base}
			}
			if (b.phases !== null) b.phases[b.count] = 0
			b.damages[b.count] = Math.max(1 - frozen.health[i] / 255,warzoneSurfaceDamage(ambientCondition))
			b.colors[b.count] = frozen.owner[i]
			b.motionIds[b.count] = frozen.id[i]
			b.count++
			this.frozenStats.drawn++
		}
	}

	dispose(): void {
		this.offDeath?.();this.offDeath=null
		this.offNewWorld?.();this.offNewWorld=null
		this.deathContext=null;this.deaths.dispose()
		this.flatAircraftSource=false
		this.scenery.dispose()
		this.living.dispose()
		this.grass.dispose()
		this.deploymentStates.clear()
		this.deploymentRigs.clear()
		this.mechanicalClock.clear()
		this.clearRamps()
		this.presentationMotion.clear()
		this.damage.dispose()
		this.render = null
		this.terrain = null
		this.materials = null
		this.sky = null
		this.anim = null
		this.humanMotion = null
		this.humanRigs.clear()
		this.rikiRigs.clear(); this.rikiAssets = null; this.posedRifleMuzzles.clear()
		this.roleActors.clear()
		for (let i = 0; i < this.buckets.length; i++) this.buckets[i] = null
		this.typeClass.clear()
		this.typeVehicle.clear()
		this.typeMovementClass.clear()
		this.typeWatercraft.clear()
		this.typeWaterStructure.clear()
		this.typeSubmersible.clear()
		this.typeRenderable.clear()
		this.typeShroudOnly.clear()
		this.typeSlot.clear()
		this.slotBuckets.clear()
		this.slotGround.clear()
		this.presentationMotion.clear()
		this.attachments.clear()
		this.runningGear.clear()
		this.ambientBuildingSeeds.clear()
	}
}

function skyLightLevel(sky: SkyApi): number {
	const env = sky.environment
	const direct =
		(env.sunColor[0] * 0.2126 + env.sunColor[1] * 0.7152 + env.sunColor[2] * 0.0722) *
		env.sunIntensity
	const ambient =
		(env.skyColor[0] * 0.2126 + env.skyColor[1] * 0.7152 + env.skyColor[2] * 0.0722) *
		env.ambientScale
	return direct + ambient
}

function headlampFactor(lightLevel: number): number {
	if (lightLevel <= HEADLAMP_FULL_BELOW) return 1
	if (lightLevel >= HEADLAMP_OFF_ABOVE) return 0
	const t = (lightLevel - HEADLAMP_FULL_BELOW) /
		(HEADLAMP_OFF_ABOVE - HEADLAMP_FULL_BELOW)
	const eased = t * t * (3 - 2 * t)
	return 1 - eased
}

/** Signed shortest turn in radians, stable across the 1023 -> 0 boundary. */
function wrapRadians(value: number): number {
	const turn = Math.PI * 2
	return ((value + Math.PI) % turn + turn) % turn - Math.PI
}
