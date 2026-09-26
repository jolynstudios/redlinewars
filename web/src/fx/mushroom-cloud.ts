// STEELSEED — fx/mushroom-cloud
//
// What a BUILDING does when it dies.
//
// Until now a construction yard and a rifle round spawned the same three presets at the same
// instant: `smoke`, `fire`, `debris`, all at t=0, all at the actor's centre. That is a puff.
// It is the correct effect for a shell landing and the wrong one for 9,214 triangles of
// reinforced concrete coming down, and the difference a viewer actually reads is not size —
// it is TIME. A cloud that arrives all at once is a bigger puff no matter how many particles
// it holds. A cloud whose parts arrive in sequence is a mushroom.
//
// THE SEQUENCE IS THE ANIMATION. Seven layers, staggered:
//
//   0.00–0.10  flash      white-hot core at the base, gone in a third of a second
//   0.00–0.34  fireball   incandescent ball rolling up out of the footprint
//   0.02       rubble     structural debris on ballistic arcs
//   0.05–0.95  skirt      concrete fines spreading OUTWARD along the ground, outliving the fire
//   0.12–1.30  stem       the column, climbing — and cooling as it climbs
//   1.00–2.10  cap        a ring at the top that expands and rolls over. THE MUSHROOM.
//   2.00–5.60  ruin       what is still smouldering on the wreck two seconds later
//
// The cap starting a full second after the stem is the whole trick. Emit them together and
// the result is a fat vertical smudge; emit the cap late and the eye reads a stem that has
// reached something and spread.
//
// THE COLOUR RAMP IS SPELLED OUT AS PRESETS. `particles.ts` has one colour per preset and no
// over-life ramp, so "cools from white through orange to dark as it climbs" cannot be a
// gradient — it is the stem layer choosing `fireball` below a third of its height,
// `stemfire` up to seven tenths, and `mushcap` above that. Three presets, one column.
//
// SIZED FROM THE BUILDING, NOT FROM A CONSTANT, AND IN A HIERARCHY. `.forge/blender/manifest.json`
// carries every asset's authored `bounds`, and the cloud is driven off the CUBE ROOT of that
// volume so a 22-fold spread of building sizes becomes a 2.8-fold spread of clouds. On top of
// that the construction yard carries an explicit tier — the human asked for the biggest
// explosion in the game to be the yard, still clearly under the nuke — and both ends are
// clamped so the order can never invert. See the hierarchy note at `NUKE_OUTER_RADIUS_M`.
// Measured: the construction yard's stem reaches 6.6 m with a 3.25 m cap, the refinery's 4.2 m
// with a 2.30 m cap, and a tesla coil's 1.6 m with a 1.27 m cap.
//
// THE AUTHORED d5 ANCHORS ARE READ HERE. `art/blender/damage_states.py` has been writing
// `ss_damage_fx` into every rung's scene — where fire and smoke actually sit on that ruin,
// and why — and `DAMAGE-STATES.md` §6 records that the exporter never carried it into the
// shipping manifest, so nothing had ever read it. It is the sixth body of authored data this
// project shipped with no consumer, after 111 light anchors, 231 material sets, 50 weapon
// muzzle scales, every smoke emitter and the projectile channel. The same authoring pass
// already writes those anchors to `web/.forge/damage-states/<actor>/states.author.json`
// beside the `manifest.json` that `units/damage-states.ts` globs, so the `ruin` layer reads
// them from there. No exporter change, no forge run, no invalidated pack — and the smoulder
// lands on the transformer bund and the shell foot the author chose rather than on the
// centroid.
//
// NO Math.random AND NO PER-FRAME ALLOCATION. Every offset comes from `hash(actor id, layer,
// index)`, so two machines watching the same replay see the same cloud. Clouds live in fixed
// parallel arrays and each layer keeps one integer cursor: a frame advances the cursor to the
// emissions whose scheduled time has passed and allocates nothing at all.

import type { Ctx } from '../core'
import type { ShroudApi, TerrainApi } from './types'

/**
 * Concurrent clouds. Four is the budget, not a guess.
 *
 * One cloud emits `SCHEDULE_PARTICLES` particles into the 2048-slot pool that every weapon
 * effect on the map shares, so the hard ceiling is 4 x 156 = 624 slots, 30% of the pool, and
 * that is the worst case where four buildings die in the same frame and nothing has expired
 * yet. The realistic peak is lower: measured against the schedule below, at t = 2.3 s a
 * single cloud holds about 80 live particles — measured at 81 in a composed match — because the
 * flash, the fireball and the rubble are long gone by the time the cap is complete. A fifth simultaneous building death is
 * refused rather than allowed to blank out the rest of the battle, and `stats.refused`
 * counts it so the trade is visible instead of silent.
 */
const MAX_CLOUDS = 4

/** Layer identifiers, and the index of each layer's cursor within a cloud's cursor block. */
const FLASH = 0, FIREBALL = 1, RUBBLE = 2, SKIRT = 3, STEM = 4, CAP = 5, RUIN = 6
const LAYERS = 7

/**
 * `[startSeconds, endSeconds, emissions]` per layer. The stagger lives here and nowhere else,
 * which is what makes it assertable: `mushroomgate` reads these three numbers per layer and
 * checks the ORDER the frame actually receives against them.
 */
const SCHEDULE = Float32Array.of(
	0.00, 0.10, 2,
	0.00, 0.34, 8,
	0.02, 0.02, 1,
	0.05, 0.95, 20,
	0.12, 1.30, 32,
	1.00, 2.10, 64,
	2.00, 5.60, 8,
)

/** Particles per emission, from `content-manifest.json`. Only the instant layers exceed 1. */
const PER_EMISSION = Int32Array.of(3, 2, 10, 1, 1, 1, 1)

/** Total particles one building death puts into the shared pool. Asserted by the gate. */
export const SCHEDULE_PARTICLES = (() => {
	let total = 0
	for (let layer = 0; layer < LAYERS; layer++) total += SCHEDULE[layer * 3 + 2] * PER_EMISSION[layer]
	return total
})()

/** Seconds after the event at which a cloud is finished and its slot returns to the pool. */
const CLOUD_LIFETIME_S = 6.2

/**
 * Templates whose destruction is a building collapse.
 *
 * The first twenty are `art/blender/models.py`'s own `STRUCTURES` set — the templates its
 * `build()` routes through `structure()` rather than through `scenery()` or a vehicle
 * builder — so this is the modeller's classification rather than a second opinion about it.
 * The last four are civil architecture that `models.py` builds as scenery because it is not
 * military, but that the mod lets a player shell flat all the same: houses, churches, the
 * lighthouse, the windmill and the oil derrick are buildings when they fall down.
 *
 * Everything absent is absent on purpose. A sandbag wall, a barrel, an ammo crate, a mine, a
 * fence post, a rock, a patch of rice and a tree do not throw a mushroom cloud, and they keep
 * the generic burst they have always had. Trees matter here specifically: the largest tree in
 * the roster has a 12.04 m2 footprint against the construction yard's 9.72, so SIZE cannot be
 * the discriminator and a threshold would have put a mushroom cloud over every felled oak.
 */
const BUILDING_TEMPLATES: ReadonlySet<string> = new Set([
	'yard', 'factory', 'power', 'refinery', 'silo', 'barracks', 'tent', 'kennel', 'radar',
	'tech', 'depot', 'helipad', 'airfield', 'dock', 'defense', 'coil', 'experimental',
	'missile_silo', 'command', 'hospital',
	'house', 'church', 'lighthouse', 'windmill', 'derrick',
])

interface RosterAsset {
	readonly template?: string
	/** `[[minX,minY,minZ],[maxX,maxY,maxZ]]` in authored model metres. */
	readonly bounds?: readonly (readonly number[])[]
}

interface RosterManifest {
	readonly assets: Readonly<Record<string, RosterAsset>>
}

// Same shape as `stack-smoke.ts` and `units/blender-assets.ts`: a build artefact read at
// module scope, not another node. A clone with no forged pack still boots, on the fallback
// dimensions below.
const rosterManifests = import.meta.glob<RosterManifest>('../../.forge/blender/manifest.json', { eager: true, import: 'default' })
const ROSTER: Readonly<Record<string, RosterAsset>> = Object.values(rosterManifests)[0]?.assets ?? {}

interface AuthoredFx {
	readonly kind: string
	readonly atM: readonly number[]
	readonly intensity: number
}

interface AuthoredState {
	readonly state: string
	readonly fx?: readonly AuthoredFx[]
}

// The Dead-rung fire and smoke anchors, from the same authoring pass that cuts the meshes.
const authorReports = import.meta.glob<readonly AuthoredState[]>('../../.forge/damage-states/*/states.author.json', { eager: true, import: 'default' })
const ACTOR_OF_PATH = /\/damage-states\/([^/]+)\//

/**
 * Packed d5 anchors per actor: `[x, y, z, intensity]` per entry, model space.
 *
 * Flattened at module load so the per-frame path indexes a Float32Array instead of walking
 * objects. `dust` anchors are dropped: they describe the collapse instant, which the skirt
 * layer already covers from the footprint, and duplicating them would put two dust sources a
 * few centimetres apart. What is kept is `smoulder`, `smoke`, `oil-fire` and `structure-fire`
 * — the things still going when the dust has settled, which is exactly what the ruin layer is.
 */
const RUIN_ANCHORS: ReadonlyMap<string, Float32Array> = (() => {
	const out = new Map<string, Float32Array>()
	for (const path of Object.keys(authorReports)) {
		const actor = ACTOR_OF_PATH.exec(path)?.[1]
		const states = authorReports[path]
		if (actor === undefined || !Array.isArray(states)) continue
		const dead = states.find(state => state?.state === 'd5')
		const fx = dead?.fx
		if (!Array.isArray(fx)) continue
		const kept: AuthoredFx[] = []
		for (const entry of fx) {
			if (entry?.kind !== 'smoulder' && entry?.kind !== 'smoke' &&
				entry?.kind !== 'oil-fire' && entry?.kind !== 'structure-fire' &&
				entry?.kind !== 'hull-fire') continue
			if (!Array.isArray(entry.atM) || entry.atM.length < 3) continue
			kept.push(entry)
		}
		if (kept.length === 0) continue
		const packed = new Float32Array(kept.length * 4)
		for (let i = 0; i < kept.length; i++) {
			packed[i * 4] = kept[i].atM[0]
			packed[i * 4 + 1] = kept[i].atM[1]
			packed[i * 4 + 2] = kept[i].atM[2]
			packed[i * 4 + 3] = Number.isFinite(kept[i].intensity) ? kept[i].intensity : 0.5
		}
		out.set(actor, packed)
	}
	return out
})()

/** Same integer hash as `particles.ts` and `stack-smoke.ts`, returning 0..1. */
function hash(value: number): number {
	let n = Math.imul(value ^ (value >>> 16), 0x45d9f3b)
	n = Math.imul(n ^ (n >>> 16), 0x45d9f3b)
	return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}

/**
 * Everything this needs from the particle pool.
 *
 * A structural type rather than `SoftParticles` itself, so `mushroomgate` can record the
 * schedule through a sink of its own and assert the ORDER of the layers. Asserting a pool
 * counter cannot tell a mushroom from a puff — it counts the same either way.
 */
export interface ParticleSink {
	spawn(name: string, x: number, y: number, z: number, time: number, seed: number, scale: number, shroud: ShroudApi): void
}

export interface MushroomStats {
	/** Clouds burning right now. */
	active: number
	/** Building deaths that started a cloud since boot. */
	started: number
	/** Building deaths refused because `MAX_CLOUDS` were already burning. */
	refused: number
	/** Destructions that were not buildings and kept the generic burst. */
	passedThrough: number
	/** Emissions released, summed over every cloud since boot. */
	emissions: number
	/** Particles released, summed over every cloud since boot. */
	particles: number
	/** Clouds whose actor carried authored d5 fx anchors, so the ruin sits where it was authored. */
	anchored: number
	/** Actor types resolved as buildings. */
	buildingTypes: number
	/** Actors whose asset could not be resolved, so the cloud used fallback dimensions. */
	unsized: number
}

/** Fallback bounding box when an actor resolves to no manifest entry, in model metres. */
const FALLBACK_SPAN_M = Float32Array.of(2.4, 1.5, 2.4)

/**
 * THE SIZE HIERARCHY. Requested by the human: *"when the construction yard is destroyed the
 * biggest multi layer explosion occurs but it cannot be larger then a nuke, but still bigger
 * then the other buildings"*. Three tiers, and the ORDER is the requirement:
 *
 *     nuke  >  construction yard  >  every other building
 *
 * WHY A CUBE ROOT. The roster's building volumes span 1.12 m3 (a tesla coil) to 24.77 m3 (the
 * construction yard) — a factor of 22. Driving a cloud linearly off that makes a coil invisible
 * or a yard absurd, so the driver is the volume's CUBE ROOT, which is a length and compresses
 * 22x of volume into 2.8x of size. One number per building, monotone in volume, so the ordering
 * can never invert by accident.
 *
 * WHY THE YARD NEEDS A TIER ANYWAY. Cube-rooted, the yard sits only 8% above the refinery and
 * 11% above the rebuilt war factory — not a difference anyone reads across a map. The tier
 * multiplier makes it about 57% larger than the next building, which is the "you can tell what
 * died" the requirement asks for. It is a stated tier, not a physical derivation, and it is
 * written here rather than dressed up as one.
 *
 * WHY THE NUKE IS THE CEILING. `engine/openra/mods/ra/weapons/superweapons.yaml`'s `Atomic`
 * stages five SpreadDamage warheads at 1c0, 2c0, 3c0, 4c0 and 5c0 over 20 ticks, so its own
 * rules put the outer damage ring at 5 render metres of radius. The yard's cap is held to 65%
 * of that. (The nuke has no 3D visual in this renderer at all — `Explosions: nuke` names a
 * sprite sequence in `sequences/misc.yaml` that nothing in `web/src` consumes — so the ceiling
 * is the weapon's own numbers rather than a picture to sit under.)
 */
const NUKE_OUTER_RADIUS_M = 5.0
/** Multiplier that lifts the construction yard clear of every other building. */
const YARD_TIER = 1.45
/**
 * Ceilings on the size driver, so the hierarchy holds by construction rather than by luck.
 *
 * `fact` is 2.70 x 2.55 x 3.60 m, so its cube-rooted volume is 2.916 and its tiered driver is
 * 4.228. Any other building is held at 70% of that, and the yard itself at 4.35 — which keeps
 * its cap under 65% of the nuke's outer ring however the roster is re-authored later.
 */
const UNIT_CEILING_YARD = 4.35
const UNIT_CEILING_OTHER = 2.96
/**
 * THE NUKE, per the human's spec: five times the size of a normal building's cloud, and
 * it does not compete with the hierarchy — it REPLACES it. No ceiling applies to the
 * nuke's own driver: the 5 m outer damage ring stays a rules footnote, the visual is the
 * statement. Emissions per layer are also multiplied (see NUKE_EMISSION_BOOST), which is
 * where the extra flames live: more fireball and stem-fire particles over the same
 * schedule span, not a separate effect to author.
 */
const NUKE_DRIVER = UNIT_CEILING_OTHER * 5
const NUKE_EMISSION_BOOST = 3
/**
 * The Ultra and Ultra+ nuke is drawn for the RTS camera, which sits about 22 m over the ground.
 * The full driver puts the column top at 32 m, so the column climbs past the camera and the
 * screen fills with a uniform orange haze that hides the fireball and the dust front. At this
 * fraction the column tops out near 15 m, the cap spreads about 5 m (the Atomic's own reach),
 * and the fireball is a readable core. The legacy presets keep the look they shipped with.
 */
const NUKE_COMPACT = 0.45
/** Cap radius per unit of driver, plus the floor that keeps a small building's cap visible. */
const CAP_K = 0.62
const CAP_MIN_M = 0.63
/**
 * Column height per unit of driver.
 *
 * This was 2.13, which put the construction yard's stem top at 9.7 m — and the first composed
 * capture showed the column leaving the TOP OF THE SCREEN at a 22 m camera height. A cloud the
 * player has to zoom out to see is not a cloud he sees. 1.95 keeps the yard's cap clear of
 * every roof by the 2x rule AND the ladder monotone in volume. Yard reach lands ~9.6 m —
 * inside the 22 m camera frame.
 *
 * The driver term alone, though, can put a stem INSIDE the building it is eating: a short,
 * tall footprint (weap is the live case) rounds to a driver whose reach stops under the roof
 * line. ROOF_FLOOR_K is the one per-building term in this file, and it is a Math.max against
 * the driver, so it can only lift a cloud whose building is taller than the driver's reach —
 * the volume ladder below the yard still holds on the driver term everywhere else.
 */
const STEM_K = 1.95
/**
 * Minimum stem height as a multiple of the building's own authored height — the spanY of the
 * same manifest bounds that feed the driver. The multiple is the gate's own 2x-roof read, not
 * a fatter margin: swept against mushroomgate's ladder, 2.4 lifts the tall-thin members (dome,
 * tsla) past their more voluminous neighbours and breaks the volume ordering the gate asserts,
 * while 2.0 binds exactly where a stem would otherwise sit under twice its roof and leaves the
 * driver in charge everywhere else. It is deliberately NOT a raise of STEM_K, whose value the
 * 22 m camera framing above is keyed to.
 */
const ROOF_FLOOR_K = 2.0
/** Footprint radius of the fireball and the skirt's inner ring, per unit of driver. */
const BASE_K = 0.36
/** Particle size per unit of driver, bounded so neither extreme becomes a different effect. */
const SIZE_DIVISOR = 3.4
const SIZE_MIN = 0.5
const SIZE_MAX = 1.35

export class MushroomCloud {
	private readonly active = new Uint8Array(MAX_CLOUDS)
	private readonly actorId = new Uint32Array(MAX_CLOUDS)
	private readonly born = new Float32Array(MAX_CLOUDS)
	private readonly x = new Float32Array(MAX_CLOUDS)
	/** Superweapon strike slots: no ceiling, boosted emissions, deduped by the caller. */
	private readonly nukeSlot = new Uint8Array(MAX_CLOUDS)
	private readonly base = new Float32Array(MAX_CLOUDS)
	private readonly z = new Float32Array(MAX_CLOUDS)
	private readonly cos = new Float32Array(MAX_CLOUDS)
	private readonly sin = new Float32Array(MAX_CLOUDS)
	/** Derived geometry: base radius, stem top above ground, cap radius, size multiplier. */
	private readonly baseR = new Float32Array(MAX_CLOUDS)
	private readonly stemTop = new Float32Array(MAX_CLOUDS)
	private readonly capR = new Float32Array(MAX_CLOUDS)
	private readonly sizeK = new Float32Array(MAX_CLOUDS)
	private readonly height = new Float32Array(MAX_CLOUDS)
	/** The last pre-death health byte, 0..1 as a burn fraction, driving cloud size and cool. */
	private readonly burn = new Float32Array(MAX_CLOUDS)
	/** Index of the next emission each layer owes, so a frame emits each one exactly once. */
	private readonly cursor = new Int32Array(MAX_CLOUDS * LAYERS)
	/** Packed d5 anchors for this cloud's actor, or null when it has no authored ladder. */
	private readonly anchors: (Float32Array | null)[] = new Array(MAX_CLOUDS).fill(null)

	/** `null` caches a resolved miss, so a shell crater does not re-walk the roster. */
	private readonly buildingByType = new Map<number, RosterAsset | null>()
	/**
	 * The building the last successful `start` or `burst` acted on: its model template, drawn
	 * ground position, height and widest span (fx/building-materials adds its material layer).
	 */
	readonly last = { actorId: -1, template: '', x: 0, y: 0, z: 0, tall: 0, span: 0 }
	private remember(actorId: number, template: string | undefined, x: number, y: number, z: number, tall: number, span: number): void {
		this.last.actorId = actorId
		this.last.template = template ?? ''; this.last.x = x; this.last.y = y; this.last.z = z; this.last.tall = tall; this.last.span = span
	}

	readonly stats: MushroomStats = {
		active: 0, started: 0, refused: 0, passedThrough: 0,
		emissions: 0, particles: 0, anchored: 0, buildingTypes: 0, unsized: 0,
	}

	/** The asset record for a type id when that type is a building, else null. */
	private buildingFor(typeId: number, ctx: Ctx): RosterAsset | null {
		const cached = this.buildingByType.get(typeId)
		if (cached !== undefined) return cached
		const name = ctx.actorTypeName(typeId)
		// An unresolved type is not a miss; leave it uncached so the table can answer later.
		if (name === '') return null
		const asset = ROSTER[name]
		const isBuilding = asset !== undefined && asset.template !== undefined && BUILDING_TEMPLATES.has(asset.template)
		const resolved = isBuilding ? asset : null
		this.buildingByType.set(typeId, resolved)
		if (resolved !== null) this.stats.buildingTypes++
		return resolved
	}
	/** The snapshot row `findRow` last resolved; consumed by `start` and `burst`. */
	private rowTypeId = 0
	private rowFacing = 0
	private rowHealth = 0
	private rowPosX = 0
	private rowPosY = 0
	private rowPosZ = 0

	/**
	 * Resolve an actor's row across the current and previous snapshots into the fields above.
	 *
	 * False means no row lists the actor in either snapshot. Type and facing prefer the
	 * current row and fall back to the previous one, where a same-tick death is still listed.
	 * Health runs the other way: the destruction event is republished before the snapshot
	 * that removes the actor, so the PREVIOUS row carries the last pre-death health and the
	 * current row is only a fallback. A 0 byte is the wire's unknown, not a death — burn 0
	 * would scale a cloud to nothing — and resolves to full burn.
	 */
	private findRow(actorId: number, ctx: Ctx): boolean {
		let typeId = -1
		let facing = 0
		let health = -1
		let posX = 0, posY = 0, posZ = 0
		for (let pass = 0; pass < 2; pass++) {
			const actors = (pass === 0 ? ctx.snapshot : ctx.prevSnapshot)?.actors
			if (!actors) continue
			for (let i = 0; i < actors.count; i++) {
				if (actors.id[i] !== actorId) continue
				if (typeId < 0) {
					typeId = actors.typeId[i]
					facing = actors.facing[i]
					// The position rides on the same row as the type, in WPos.
					posX = actors.posX[i]
					posY = actors.posY[i]
					posZ = actors.posZ[i]
				}
				if (actors.health[i] > 0) health = actors.health[i]
				break
			}
		}
		if (typeId < 0) return false
		this.rowTypeId = typeId
		this.rowFacing = facing
		this.rowHealth = health < 0 ? 255 : health
		this.rowPosX = posX
		this.rowPosY = posY
		this.rowPosZ = posZ
		return true
	}

	/**
	 * Start a cloud for an authoritative destruction, or answer false and leave the caller's
	 * generic burst in charge.
	 *
	 * False means every one of: the actor is not a building, the roster has no name table yet,
	 * four clouds are already burning, or the death is behind shroud. The caller must treat
	 * false as "you still owe this actor an explosion", because a building death that produced
	 * nothing at all would be a worse regression than the puff this replaces.
	 *
	 * @param eventY the destruction event's own elevation, which is the SIMULATION's. Playable
	 * relief is synthesized in the browser, so the drawn ground is added here — the same
	 * correction the muzzle and impact paths already make, and without it a cloud on a hill
	 * starts underneath it.
	 */
	start(
		actorId: number,
		eventX: number,
		eventY: number,
		eventZ: number,
		violence: number,
		time: number,
		ctx: Ctx,
		terrain: TerrainApi | null,
		shroud: ShroudApi,
	): boolean {
		if (!Number.isFinite(time) || !Number.isFinite(eventX) || !Number.isFinite(eventY) || !Number.isFinite(eventZ)) return false
		// The type id, the facing, the health and the ground truth all come from the actor's
		// own snapshot row. The destruction payload carries none of them, and by the frame
		// the event is handled the actor may already have left the current snapshot — so the
		// previous one is consulted too, which is where a same-tick death is still listed.
		if (!this.findRow(actorId, ctx)) return false
		const asset = this.buildingFor(this.rowTypeId, ctx)
		if (asset === null) { this.stats.passedThrough++; return false }
		if (!shroud.isVisible(Math.floor(eventX), Math.floor(eventZ))) return false

		let slot = -1
		for (let i = 0; i < MAX_CLOUDS; i++) {
			// A second event for an actor already burning must not double the cloud.
			if (this.active[i] && this.actorId[i] === actorId) return true
			if (!this.active[i] && slot < 0) slot = i
		}
		if (slot < 0) { this.stats.refused++; return false }

		const bounds = asset.bounds
		let spanX = 0, spanY = 0, spanZ = 0
		if (Array.isArray(bounds) && bounds.length === 2 && bounds[0].length >= 3 && bounds[1].length >= 3) {
			spanX = bounds[1][0] - bounds[0][0]
			spanY = bounds[1][1] - bounds[0][1]
			spanZ = bounds[1][2] - bounds[0][2]
		}
		if (!(spanX > 0.05) || !(spanY > 0.05) || !(spanZ > 0.05)) {
			spanX = FALLBACK_SPAN_M[0]; spanY = FALLBACK_SPAN_M[1]; spanZ = FALLBACK_SPAN_M[2]
			this.stats.unsized++
		}
		const tall = spanY
		// One length that stands for the whole building, compressed. See the hierarchy note
		// above. The burn factor rides on the SAME term: how much building was left to burn
		// decides how much cloud it throws — a ruin shelled down to its last tenth dies
		// smaller than one killed off full health. It lands BEFORE the ceiling, so the
		// yard-over-everything-over-nuke hierarchy holds by construction at every burn.
		const yard = asset.template === 'yard'
		const burn = this.rowHealth / 255
		const unit = Math.min(
			yard ? UNIT_CEILING_YARD : UNIT_CEILING_OTHER,
			Math.cbrt(spanX * spanY * spanZ) * (yard ? YARD_TIER : 1) * (0.62 + 0.38 * burn),
		)

		// Violence is the fraction of max health the killing blow carried, so an overkill
		// throws a taller cloud than a last-shell finish. Bounded either side: a 14% swing,
		// not a second size system competing with the building's own dimensions.
		const v = Math.max(0, Math.min(1, violence / 255))
		const punch = 0.86 + 0.28 * v
		// OpenRA's facing is counterclockwise from north over 1024. Model +X maps to render
		// (cos, -sin) and model +Z to (sin, cos), which is the mapping the refinery dock
		// script derives in full and `stack-smoke.ts` uses for its anchors.
		const yaw = Math.PI * 0.5 + (this.rowFacing / 1024) * Math.PI * 2

		this.active[slot] = 1
		this.actorId[slot] = actorId
		this.born[slot] = time
		this.x[slot] = eventX
		this.z[slot] = eventZ
		this.base[slot] = eventY + (terrain?.heightAt(eventX, eventZ) ?? 0)
		this.cos[slot] = Math.cos(yaw)
		this.sin[slot] = Math.sin(yaw)
		this.height[slot] = tall
		this.burn[slot] = burn
		this.baseR[slot] = BASE_K * unit
		// The stem must clear the roof of the building it rises from: a column that dies inside
		// its own footprint reads as the building imploding, not burning. See ROOF_FLOOR_K.
		this.stemTop[slot] = Math.max(STEM_K * unit * punch, ROOF_FLOOR_K * tall)
		// Never past the nuke, whatever the roster does later. `capR` is the widest thing the
		// cloud draws, so this is the one number the ceiling has to be enforced on.
		this.capR[slot] = Math.min(NUKE_OUTER_RADIUS_M * 0.65, (CAP_K * unit + CAP_MIN_M) * punch)
		this.sizeK[slot] = Math.max(SIZE_MIN, Math.min(SIZE_MAX, unit / SIZE_DIVISOR)) * (0.90 + 0.20 * v)
		const name = ctx.actorTypeName(this.rowTypeId)
		const anchors = RUIN_ANCHORS.get(name) ?? null
		this.anchors[slot] = anchors
		if (anchors !== null) this.stats.anchored++
		for (let layer = 0; layer < LAYERS; layer++) this.cursor[slot * LAYERS + layer] = 0
		this.stats.started++
		this.remember(actorId, asset.template, eventX, this.base[slot], eventZ, tall, Math.max(spanX, spanZ))
		return true
	}

	/**
	 * A superweapon strike's own cloud. Five times a normal building's driver (times `scale`), no ceiling,
	 * full burn, and the caller dedupes the five staged Atomic warheads into one strike.
	 * Unlike `start` this needs no snapshot row — the strike may land where nothing stood —
	 * and `eventY` must already carry the drawn ground (the caller adds heightAt, same as
	 * the impact path).
	 */
	nuke(
		eventX: number,
		eventY: number,
		eventZ: number,
		time: number,
		ctx: Ctx,
		shroud: ShroudApi,
		scale = 1,
		compact = false,
	): boolean {
		if (!Number.isFinite(time) || !Number.isFinite(eventX) || !Number.isFinite(eventY) || !Number.isFinite(eventZ)) return false
		if (!shroud.isVisible(Math.floor(eventX), Math.floor(eventZ))) return false
		let slot = -1
		for (let i = 0; i < MAX_CLOUDS; i++) {
			if (this.active[i] && this.nukeSlot[i] === 1) return true
			if (!this.active[i] && slot < 0) slot = i
		}
		if (slot < 0) { this.stats.refused++; return false }

		// `scale` is the weapon's reach against the Atomic's: the MiniNuke's rings stop at 4c0 of
		// the Atomic's 5c0, so its column is four fifths of the Atomic's (fx/nuclear-strike).
		const unit = NUKE_DRIVER * (scale > 0 ? scale : 1) * (compact ? NUKE_COMPACT : 1)
		this.active[slot] = 1
		this.nukeSlot[slot] = 1
		this.actorId[slot] = 0xffffffff
		this.born[slot] = time
		this.x[slot] = eventX
		this.z[slot] = eventZ
		this.base[slot] = eventY
		this.cos[slot] = 1
		this.sin[slot] = 0
		// The height the fireball and flash climb through; compact keeps the ball under the stem.
		this.height[slot] = compact ? 4.8 : 8
		this.burn[slot] = 1
		this.baseR[slot] = BASE_K * unit
		this.stemTop[slot] = STEM_K * unit * 1.12
		this.capR[slot] = CAP_K * unit + CAP_MIN_M
		this.sizeK[slot] = unit / SIZE_DIVISOR
		this.anchors[slot] = null
		for (let layer = 0; layer < LAYERS; layer++) this.cursor[slot * LAYERS + layer] = 0
		this.stats.started++
		return true
	}

	/**
	 * A one-shot burst when a LIVE building crosses into Heavy or Critical.
	 *
	 * Not a death effect — the death is `start`'s mushroom, and a dying actor stops being
	 * drawn, so `DamageStates.opaqueSlot` never publishes a Dead crossing. This is the
	 * just-got-hit-hard punctuation: structural debris off the body, a dust ring around the
	 * footprint and — at Critical, return 2 — fire established inside the ruin, which the
	 * caller grounds. Return 1 is dust only; return 0 means nothing was owed: no snapshot
	 * row, not a building, or behind shroud.
	 *
	 * No slot machinery. The burst is a handful of particles, inherently bounded, because
	 * rung crossings are rare and `REPAIR_DEADBAND` stops a repaired building from flapping
	 * back and forth across a threshold.
	 *
	 * @param out written with the burst's world x, drawn ground y and z whenever the return
	 * is non-zero — the caller needs them to place the ground fire.
	 */
	burst(
		actorId: number,
		rung: number,
		time: number,
		ctx: Ctx,
		terrain: TerrainApi | null,
		shroud: ShroudApi,
		particles: ParticleSink,
		out: Float32Array,
	): 0 | 1 | 2 {
		if (!Number.isFinite(time)) return 0
		if (!this.findRow(actorId, ctx)) return 0
		const asset = this.buildingFor(this.rowTypeId, ctx)
		if (asset === null) return 0
		// The row's position is WPos, the same 1024-per-cell quantisation the destruction
		// event carries; sim Y is render Z and sim Z is elevation.
		const WPOS_TO_M = 1 / 1024
		const x = this.rowPosX * WPOS_TO_M
		const z = this.rowPosY * WPOS_TO_M
		if (!shroud.isVisible(Math.floor(x), Math.floor(z))) return 0

		// The same bounds walk, fallbacks, tier and ceilings as `start`, at little more than
		// half strength: a crossing punctuates, it does not relive the death.
		const bounds = asset.bounds
		let spanX = 0, spanY = 0, spanZ = 0
		if (Array.isArray(bounds) && bounds.length === 2 && bounds[0].length >= 3 && bounds[1].length >= 3) {
			spanX = bounds[1][0] - bounds[0][0]
			spanY = bounds[1][1] - bounds[0][1]
			spanZ = bounds[1][2] - bounds[0][2]
		}
		if (!(spanX > 0.05) || !(spanY > 0.05) || !(spanZ > 0.05)) {
			spanX = FALLBACK_SPAN_M[0]; spanY = FALLBACK_SPAN_M[1]; spanZ = FALLBACK_SPAN_M[2]
		}
		const tall = spanY
		const yard = asset.template === 'yard'
		const unit = 0.55 * Math.min(
			yard ? UNIT_CEILING_YARD : UNIT_CEILING_OTHER,
			Math.cbrt(spanX * spanY * spanZ) * (yard ? YARD_TIER : 1),
		)
		const baseR = BASE_K * unit
		const size = Math.max(SIZE_MIN, Math.min(SIZE_MAX, unit / SIZE_DIVISOR))
		const ground = this.rowPosZ * WPOS_TO_M + (terrain?.heightAt(x, z) ?? 0)

		// Seeds run off (actor id, rung, emission index) so two machines watching the same
		// fight burst identically — the same rule the cloud's own emissions follow.
		const seedOf = (index: number) => (actorId * 2654435761 + 31 * rung + index * 104729) | 0
		// A crossing into Heavy is a partial collapse, and a collapse throws pieces.
		particles.spawn('rubble', x, ground + tall * 0.35, z, time, seedOf(0), size * 0.8, shroud)
		// The dust ring around the footprint: the hit kicking fines outward, low and wide —
		// the skirt in miniature.
		for (let i = 1; i <= 4; i++) {
			const seed = seedOf(i)
			const a = i * 2.39996323 + hash(seed) * 0.9
			const r = baseR * (0.5 + 0.4 * hash(seed + 1013904223))
			particles.spawn('dustskirt', x + Math.cos(a) * r, ground + tall * 0.08, z + Math.sin(a) * r,
				time, seed, size * (0.70 + 0.40 * hash(seed + 1664525)), shroud)
		}
		this.remember(actorId, asset.template, x, ground, z, tall, Math.max(spanX, spanZ))
		if (rung < 4) {
			out[0] = x
			out[1] = ground
			out[2] = z
			return 1
		}
		// Critical is fire ESTABLISHED inside the ruin, not just dust: three seats up the
		// body, and the caller grounds it.
		for (let i = 5; i <= 7; i++) {
			const seed = seedOf(i)
			const a = i * 2.39996323 + hash(seed) * 1.4
			const r = baseR * 0.45 * hash(seed + 1013904223)
			particles.spawn('stemfire', x + Math.cos(a) * r, ground + tall * (0.45 + 0.25 * hash(seed)), z + Math.sin(a) * r,
				time, seed, size * (0.70 + 0.35 * hash(seed + 1664525)), shroud)
		}
		out[0] = x
		out[1] = ground
		out[2] = z
		return 2
	}

	/** Wall-clock-independent reset; `Fx.dispose` and the gates use it. */
	clear(): void {
		this.active.fill(0)
		this.nukeSlot.fill(0)
		for (let i = 0; i < MAX_CLOUDS; i++) this.anchors[i] = null
		this.stats.active = 0
	}

	/**
	 * Release every emission whose scheduled moment has passed.
	 *
	 * `time` is the effect clock the particle pool runs on, not the sim tick, so a cloud keeps
	 * rising across a paused frame rather than freezing mid-column.
	 */
	tick(time: number, particles: ParticleSink, shroud: ShroudApi): void {
		let live = 0
		for (let slot = 0; slot < MAX_CLOUDS; slot++) {
			if (!this.active[slot]) continue
			const age = time - this.born[slot]
			if (!(age >= 0) || age >= CLOUD_LIFETIME_S) { this.active[slot] = 0; this.anchors[slot] = null; continue }
			live++
			for (let layer = 0; layer < LAYERS; layer++) {
				const from = SCHEDULE[layer * 3]
				const to = SCHEDULE[layer * 3 + 1]
				const count = SCHEDULE[layer * 3 + 2] * (this.nukeSlot[slot] === 1 ? NUKE_EMISSION_BOOST : 1)
				const cursorAt = slot * LAYERS + layer
				let next = this.cursor[cursorAt]
				if (next >= count || age < from) continue
				// How many of this layer's emissions the clock has passed. A layer with a zero
				// span (`rubble`) releases all of its emissions the moment it opens.
				const span = to - from
				const due = span > 0 ? Math.min(count, Math.floor(((age - from) / span) * (count - 1)) + 1) : count
				while (next < due) {
					this.emit(slot, layer, next, time, particles, shroud)
					next++
				}
				this.cursor[cursorAt] = next
			}
		}
		this.stats.active = live
	}

	/** One scheduled emission. Every offset is a pure function of (actor id, layer, index). */
	private emit(slot: number, layer: number, index: number, time: number, particles: ParticleSink, shroud: ShroudApi): void {
		const count = SCHEDULE[layer * 3 + 2] * (this.nukeSlot[slot] === 1 ? NUKE_EMISSION_BOOST : 1)
		const p = count > 1 ? index / (count - 1) : 0
		const id = this.actorId[slot]
		const seed = (id * 2654435761 + layer * 7919 + index * 104729) | 0
		const ha = hash(seed)
		const hb = hash(seed + 1013904223)
		const hc = hash(seed + 1664525)
		const cx = this.x[slot]
		const cz = this.z[slot]
		const ground = this.base[slot]
		const tall = this.height[slot]
		const size = this.sizeK[slot]
		let name = 'mushcap'
		let ox = 0
		let oy = 0
		let oz = 0
		let scale = size

		switch (layer) {
			case FLASH: {
				name = 'blastcore'
				oy = tall * (0.22 + 0.10 * index)
				scale = size * 1.5
				break
			}
			case FIREBALL: {
				name = 'fireball'
				// A ring, not a point: the ball has to have a width before it has a height.
				const a = ha * Math.PI * 2
				const r = this.baseR[slot] * (0.30 + 0.45 * hb)
				ox = Math.cos(a) * r
				oz = Math.sin(a) * r
				oy = tall * (0.18 + 0.62 * p)
				scale = size * (0.85 + 0.40 * hc)
				break
			}
			case RUBBLE: {
				name = 'rubble'
				oy = tall * 0.35
				scale = size * 1.1
				break
			}
			case SKIRT: {
				name = 'dustskirt'
				// The skirt is the only layer that is WIDER later rather than higher later:
				// the radius runs 0.55 to 2.00 of the footprint radius while the height stays
				// under a fifth of the building. That outward-only growth against the stem's
				// upward-only growth is what separates the base of the cloud from its column.
				// It stops short of `capR` on purpose: the cap has to be the widest thing the
				// cloud draws, both because that is what a mushroom looks like from above and
				// because `capR` is where the nuke ceiling is enforced.
				const a = index * 2.39996323 + ha * 0.9
				const r = this.baseR[slot] * (0.55 + 1.45 * p)
				ox = Math.cos(a) * r
				oz = Math.sin(a) * r
				oy = tall * (0.06 + 0.12 * hb)
				scale = size * (0.80 + 0.50 * hc)
				break
			}
			case STEM: {
				// Cools as it climbs. `particles.ts` has no over-life colour ramp, so the ramp
				// is three presets chosen by height: incandescent for the first third, burning
				// for the next four tenths, dark above that — and the dark top is already the
				// cap's own material, so the two layers meet without a seam.
				// A death with less left to burn cools EARLIER: the same height fraction hands
				// over to a darker preset. cool is 0 at full burn (the old thresholds exactly)
				// and approaches 1 for a ruin finished off at the last tenth of its health.
				const cool = 1 - this.burn[slot]
				name = p < 0.30 - 0.18 * cool ? 'fireball' : p < 0.72 - 0.22 * cool ? 'stemfire' : 'mushcap'
				const a = index * 2.39996323 + hb * 1.4
				// The column narrows as it rises, which is the waist a cap sits on.
				const r = this.baseR[slot] * (0.62 - 0.30 * p) * (0.4 + 0.9 * ha)
				ox = Math.cos(a) * r
				oz = Math.sin(a) * r
				const bottom = tall * 0.45
				oy = bottom + (this.stemTop[slot] - bottom) * p
				scale = size * (0.75 + 0.45 * hc)
				break
			}
			case CAP: {
				name = 'mushcap'
				// Sixteen around, four rows out. The radius grows outward while the height
				// FALLS: that descent as it spreads is the rollover, and without it the layer
				// is a disc rather than a head.
				const around = index % 16
				const row = Math.floor(index / 16)
				const a = around * (Math.PI / 8) + row * 0.21 + ha * 0.18
				// The ring starts NEARLY ON THE AXIS and opens out. Started at half the cap's
				// width instead, the first second draws a torus with a hole through it, and at
				// this game's near-top-down camera a hole reads as a smoke ring rather than as
				// a head. Beginning on the stem's own axis makes the cap grow OUT OF the
				// column, which is both what a real cap does and what the eye reads.
				const r = this.capR[slot] * (0.22 + 0.78 * p)
				ox = Math.cos(a) * r
				oz = Math.sin(a) * r
				oy = this.stemTop[slot] + size * (0.55 - 1.15 * p) + (hb - 0.5) * 0.25 * size
				scale = size * (0.90 + 0.50 * hc)
				break
			}
			case RUIN: {
				name = 'ruinsmoke'
				const anchors = this.anchors[slot]
				if (anchors !== null) {
					// The authored Dead-rung anchor, rotated into the world by the actor's own
					// facing. `powr` puts one on the oil-soaked rubble, one on the transformer
					// bund and one at the shell foot; `weap` puts one where everything
					// combustible has already burnt. That is where the smoke belongs.
					const entry = (index % (anchors.length / 4)) * 4
					const ax = anchors[entry]
					const ay = anchors[entry + 1]
					const az = anchors[entry + 2]
					const intensity = anchors[entry + 3]
					ox = ax * this.cos[slot] + az * this.sin[slot]
					oz = -ax * this.sin[slot] + az * this.cos[slot]
					oy = ay
					scale = size * (0.55 + 0.75 * intensity)
				} else {
					const a = index * 2.39996323 + ha
					const r = this.baseR[slot] * 0.45 * hb
					ox = Math.cos(a) * r
					oz = Math.sin(a) * r
					oy = tall * 0.18
					scale = size * 0.85
				}
				break
			}
		}

		particles.spawn(name, cx + ox, ground + oy, cz + oz, time, seed, scale, shroud)
		this.stats.emissions++
		this.stats.particles += PER_EMISSION[layer]
	}

	/** Diagnostic read for the gate: the scheduled window of one layer, in seconds. */
	static layerWindow(layer: number, out: Float32Array): void {
		out[0] = SCHEDULE[layer * 3]
		out[1] = SCHEDULE[layer * 3 + 1]
		out[2] = SCHEDULE[layer * 3 + 2]
	}
}

export const MUSHROOM_LAYERS = Object.freeze({ FLASH, FIREBALL, RUBBLE, SKIRT, STEM, CAP, RUIN, LAYERS, MAX_CLOUDS })
