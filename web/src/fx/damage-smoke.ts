// STEELSEED — fx/damage-smoke
//
// Hurt things smoke. Every actor, not only the ones with an authored condition ladder.
//
// TWO CHAINS MEET HERE, AND ONE OF THEM WAS DEAD.
// `art/blender/damage_states.py` has written a per-state list of fire and smoke anchors
// into every damage variant it authored since the first ladder shipped — the radar dome's
// Dead rung asks for a `smoulder` at (0, 0.16, -0.20) and a `dust` at (0, 0.11, -0.10) —
// and none of it ever left `states.author.json`, a file no runtime and no gate reads. The
// exported `manifest.json` had no `fx` key at all, so the answer to "is the anchor already
// consumed" was no, and could not have been yes. That is the sixth body of authored data
// this project has shipped with no consumer, after 111 light anchors, 231 material sets,
// 50 muzzle scales and the four smoke emitters `stack-smoke.ts` rescued this morning. The
// exporter now carries `fx` through; this file is the consumer.
//
// AND A FALLBACK, BECAUSE COVERAGE IS THE POINT. Four of 281 actors had a ladder when this
// was written and eighteen when it shipped, so an anchor-only implementation would smoke
// eighteen actors and leave the human looking at 263 undamaged-looking ones. Any actor
// without an authored anchor gets a MEASURED one off its own drawn bounds: 82% of its
// height, biased aft. Nothing is authored for it and it still smokes.
//
// THE BUDGET IS THE DESIGN, NOT AN AFTERTHOUGHT. `particles.ts` has 2048 slots shared with
// every explosion, tracer and impact in the game, and a forty-unit army trading fire is
// exactly when a player most needs to see the shells land. So damage smoke is capped by a
// GLOBAL SPAWN RATE rather than per-actor: `SPAWN_RATE` puffs a second across the whole
// battlefield, spent on whoever is hurt. At the `stack` preset's 4.6 s life that is a
// steady state of about 120 live particles, 5.9% of the pool, and it cannot grow — thirty
// burning tanks each puff a third as often as three do, so the army wisps instead of eight
// of them pouring while the rest show nothing. `budgetDropped` counts what that costs.

import { ActorFlag, wangleToRadians, type Ctx } from '../core'
import type { ShroudApi, TerrainApi } from './types'
import type { SoftParticles } from './particles'

/** WPos is 1024 per cell and one cell is one render metre (§12.4). */
const WPOS_TO_M = 1 / 1024

/**
 * Damage at which an actor starts to smoke, as `1 - health/255`.
 *
 * OpenRA's own `Health.cs` calls anything below full health `Light`, and a tank that has
 * taken one rifle round trailing smoke would be as wrong as one at 5% that does not. This
 * is set below the Medium boundary (0.25) so the cue arrives while the player can still do
 * something about it, which is the whole reason to draw it.
 */
const SMOKE_AT = 0.15

/**
 * Troops smoke only once they are nearly dead: under a quarter of their health,
 * OpenRA's Critical band. A rifle squad at the vehicle threshold would be a fog
 * bank, and a soldier usually dies before a 1.35 s vehicle cadence ever emits.
 */
const TROOP_SMOKE_AT = 0.75

/** Global puffs per second across every damaged actor on the map. */
const SPAWN_RATE = 34

/** Seconds between puffs from one actor at `SMOKE_AT`, and at the point of death. */
const SLOW_INTERVAL_S = 1.35
const FAST_INTERVAL_S = 0.40

/** A nearly-dead soldier lives for a shot or two, so the first puff cannot wait. */
const TROOP_SLOW_INTERVAL_S = 0.48
const TROOP_FAST_INTERVAL_S = 0.22

/** Damage above which the column goes dark and a fire anchor is allowed to show flame. */
const HEAVY_AT = 0.5
const BURNING_AT = 0.7

/** Anchor kinds that are a FIRE rather than a smoke column. */
const FIRE_KINDS = new Set(['structure-fire', 'oil-fire', 'hull-fire', 'fuel-fire', 'smoulder'])

/** At most this many authored anchors are drawn per actor; the rest are documentation. */
const MAX_ANCHORS = 2

interface FxAnchor {
	readonly kind: string
	readonly atM: readonly number[]
	readonly intensity: number
}

interface DamageStateEntry {
	readonly state: string
	readonly healthBelow: number
	readonly fx?: readonly FxAnchor[]
}

interface DamageManifest {
	readonly actor: string
	readonly states: readonly DamageStateEntry[]
}

interface RosterAsset {
	readonly bounds?: readonly (readonly number[])[]
	readonly template?: string
}

interface RosterManifest {
	readonly assets: Readonly<Record<string, RosterAsset>>
}

// Build artefacts, not other nodes — the same rule `stack-smoke.ts` and
// `units/blender-assets.ts` follow. A clone with no forged pack boots with no smoke.
const rosterManifests = import.meta.glob<RosterManifest>('../../.forge/blender/manifest.json', { eager: true, import: 'default' })
const damageManifests = import.meta.glob<DamageManifest>('../../.forge/damage-states/*/manifest.json', { eager: true, import: 'default' })
const ROSTER: Readonly<Record<string, RosterAsset>> = Object.values(rosterManifests)[0]?.assets ?? {}

/** `<actor> -> [{ healthBelow, anchors }]`, ascending by threshold. */
interface AuthoredRung {
	readonly healthBelow: number
	readonly anchors: readonly FxAnchor[]
}

const AUTHORED = new Map<string, readonly AuthoredRung[]>()
for (const manifest of Object.values(damageManifests)) {
	if (!manifest?.actor || !Array.isArray(manifest.states)) continue
	const rungs: AuthoredRung[] = []
	for (const entry of manifest.states) {
		if (!entry.fx || entry.fx.length === 0) continue
		rungs.push({ healthBelow: entry.healthBelow, anchors: entry.fx.slice(0, MAX_ANCHORS) })
	}
	// ASCENDING, and getting this backwards is a silent wrong answer rather than an error.
	// `healthBelow` is the fraction the state applies BELOW, so the rung an actor is on is
	// the one with the SMALLEST `healthBelow` still above its health fraction — Heavy at
	// 0.40, not Light. Sorted descending and taken first, every damaged actor in the game
	// would have drawn its Light anchor, because 1.0 is above every fraction there is.
	rungs.sort((a, b) => a.healthBelow - b.healthBelow)
	if (rungs.length > 0) AUTHORED.set(manifest.actor, rungs)
}

/** One resolved actor type: where its smoke comes from and how big the column is. */
interface Source {
	readonly rungs: readonly AuthoredRung[] | null
	/** Measured stand-in used when no rung of this actor authored an anchor. */
	readonly fallbackX: number
	readonly fallbackY: number
	readonly fallbackZ: number
	/** Column width, from the actor's own drawn footprint. A jeep is not a battleship. */
	readonly scale: number
	/** Infantry smoke only in the nearly-dead band, from the top of the body. */
	readonly troop: boolean
}

function hash(value: number): number {
	let n = Math.imul(value ^ (value >>> 16), 0x45d9f3b)
	n = Math.imul(n ^ (n >>> 16), 0x45d9f3b)
	return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}

export interface DamageSmokeStats {
	/** Actor types resolved so far. */
	types: number
	/** Types whose smoke comes from an AUTHORED anchor rather than the measured stand-in. */
	authoredTypes: number
	/** Actors hurt enough to smoke this frame. */
	smoking: number
	/** Puffs released this frame. */
	spawned: number
	/** Puffs a hurt actor was due and the global rate refused. */
	budgetDropped: number
	/** Flame puffs released this frame from a fire-kind anchor on a burning actor. */
	flames: number
}

export class DamageSmoke {
	private readonly byType = new Map<number, Source | null>()
	/** Unspent puffs carried across frames so a 144 Hz frame is not rounded to zero. */
	private budget = 0
	/** Rotates the scan origin so the same low actor indices do not win the budget forever. */
	private cursor = 0

	readonly stats: DamageSmokeStats = {
		types: 0, authoredTypes: 0, smoking: 0, spawned: 0, budgetDropped: 0, flames: 0,
	}

	private sourceFor(typeId: number, ctx: Ctx): Source | null {
		const cached = this.byType.get(typeId)
		if (cached !== undefined) return cached
		const name = ctx.actorTypeName(typeId)
		// An unresolved type answers later rather than being cached as "no smoke".
		if (name === '') return null
		const asset = ROSTER[name] ?? ROSTER[name.toLowerCase()]
		const bounds = asset?.bounds
		if (!bounds || bounds.length !== 2) {
			this.byType.set(typeId, null)
			return null
		}
		const [lo, hi] = bounds
		const rungs = AUTHORED.get(name) ?? AUTHORED.get(name.toLowerCase()) ?? null
		const span = Math.max(hi[0] - lo[0], hi[2] - lo[2])
		const troop = asset.template === 'infantry'
		const source: Source = {
			rungs,
			// Aft of centre and just below the top: over an engine deck on a vehicle, on the
			// roof of a building, off the back of a hull. A soldier's column starts on the
			// crown, or the puff is born inside a body only a third of a metre tall and never
			// reads as smoke. One rule, measured per actor, and it is only ever the stand-in
			// for an actor nobody has authored an anchor for.
			fallbackX: troop ? (lo[0] + hi[0]) * 0.5 : (lo[0] + hi[0]) * 0.5 - (hi[0] - lo[0]) * 0.18,
			fallbackY: troop ? hi[1] : lo[1] + (hi[1] - lo[1]) * 0.82,
			fallbackZ: (lo[2] + hi[2]) * 0.5,
			// The hull formula collapses a rifleman to a speck. A nearly-dead soldier needs a
			// column the eye can pick out of a squad, not a second muzzle wisp.
			scale: troop ? 1.15 : Math.min(2.3, 0.55 + span * 0.65),
			troop,
		}
		this.byType.set(typeId, source)
		this.stats.types++
		if (rungs !== null) this.stats.authoredTypes++
		return source
	}

	/** The authored anchors for this health, or null to use the measured stand-in. */
	private anchorsFor(source: Source, health: number): readonly FxAnchor[] | null {
		if (source.rungs === null) return null
		// The byte's CENTRE, not its edge — `SnapshotEmitter` sends `floor(255 * HP / MaxHP)`,
		// so byte 191 means a fraction somewhere in [0.74902, 0.75294) whose centre is above
		// the 75% boundary. `damage-states.ts` documents the same correction on the mesh side
		// and measures it as the difference between 1 wrong rung and 0 across 8,960 pairs.
		const fraction = (health + 0.5) / 255
		// Ascending, so the first match is the SMALLEST threshold still above this health:
		// that is the rung the simulation is in. An actor whose rung authored no anchor falls
		// to a less-damaged one, exactly as the mesh ladder falls DOWN — smoke may lag the
		// damage, it may never anticipate it. Dead's threshold is 0.0 and is therefore never
		// selected from a health byte, which is right: a live actor is never `DamageState.Dead`
		// and the wreck's own smoke belongs to the death path.
		for (let i = 0; i < source.rungs.length; i++) {
			if (fraction < source.rungs[i].healthBelow) return source.rungs[i].anchors
		}
		return null
	}

	/**
	 * Release smoke for every hurt actor in view, inside one global rate.
	 *
	 * `time` is the effect clock the particle pool runs on rather than the sim tick, so a
	 * column keeps rising through a paused frame instead of freezing in the air.
	 */
	tick(dt: number, time: number, ctx: Ctx, particles: SoftParticles, shroud: ShroudApi, terrain: TerrainApi | null): void {
		this.stats.smoking = 0
		this.stats.spawned = 0
		this.stats.budgetDropped = 0
		this.stats.flames = 0
		const actors = ctx.snapshot?.actors
		if (!actors || dt <= 0) return
		// Carry at most one second of unspent budget: a long stall must not buy a burst.
		this.budget = Math.min(SPAWN_RATE, this.budget + dt * SPAWN_RATE)
		const previous = time - dt
		const count = actors.count
		if (count === 0) return
		this.cursor = (this.cursor + 1) % count
		for (let step = 0; step < count; step++) {
			const i = (this.cursor + step) % count
			const health = actors.health[i]
			const hurt = 1 - health / 255
			if (hurt < SMOKE_AT) continue
			const flags = actors.flags[i]
			// A husk is already dead and its remains belong to the death path, which owns the
			// collapse, the ruin smoke and the burning wreck. Two systems smoking one corpse
			// would double the column and double the cost of it.
			if ((flags & ActorFlag.husk) !== 0) continue
			const source = this.sourceFor(actors.typeId[i], ctx)
			if (source === null) continue
			const smokeAt = source.troop ? TROOP_SMOKE_AT : SMOKE_AT
			if (hurt < smokeAt) continue
			this.stats.smoking++
			// Cadence scales with how hurt it is: a lightly damaged tank wisps at one puff a
			// second and a critical one pours at two and a half. A troop only enters here
			// already nearly dead, and the clock is short enough to emit before the next shot.
			const t = Math.min(1, (hurt - smokeAt) / (1 - smokeAt))
			const slow = source.troop ? TROOP_SLOW_INTERVAL_S : SLOW_INTERVAL_S
			const fast = source.troop ? TROOP_FAST_INTERVAL_S : FAST_INTERVAL_S
			const interval = slow + (fast - slow) * t
			const id = actors.id[i]
			const phase = hash(id * 2654435761) * interval
			if (Math.floor((previous + phase) / interval) === Math.floor((time + phase) / interval)) continue
			if (this.budget < 1) { this.stats.budgetDropped++; continue }
			const x = actors.posX[i] * WPOS_TO_M
			const z = actors.posY[i] * WPOS_TO_M
			const base = actors.posZ[i] * WPOS_TO_M + (terrain?.heightAt(x, z) ?? 0)
			const yaw = wangleToRadians(actors.facing[i])
			const cos = Math.cos(yaw)
			const sin = Math.sin(yaw)
			const anchors = this.anchorsFor(source, health)
			// One anchor per emission, alternating, so two authored fires cost what one does.
			let ax = source.fallbackX
			let ay = source.fallbackY
			let az = source.fallbackZ
			let intensity = 1
			let fire = false
			if (anchors !== null && anchors.length > 0) {
				const pick = anchors[Math.floor(time / interval) % anchors.length]
				ax = pick.atM[0]
				ay = pick.atM[1]
				az = pick.atM[2]
				intensity = pick.intensity
				fire = FIRE_KINDS.has(pick.kind)
			}
			// Authored fire kinds cover eighteen laddered actors. Everything else — every tank
			// without a hull-fire anchor — used to smoke and never burn. Heavy damage is fire
			// whether anyone authored the kind or not; that is the damage-state cue.
			if (!fire && hurt >= HEAVY_AT) fire = true
			// Model space is the exported mesh's own frame; `place.ts` rotates it about Y by
			// `wangleToRadians(facing)`, which sends model +X to render -Z at a yaw of pi/2.
			// Same mapping `stack-smoke.ts` derives, and it must stay the same one: a smoke
			// anchor that ignores facing sits beside a moving tank rather than on it.
			const wx = x + ax * cos + az * sin
			const wz = z - ax * sin + az * cos
			const wy = base + ay + 0.04
			const scale = source.scale * (0.7 + 0.5 * t) * (0.6 + 0.4 * intensity)
			// `ruinsmoke` is the darker, longer-lived, one-particle column and `stack` the pale
			// wisp. Both are single-particle presets, which is the whole reason they can be
			// used here: `smoke` emits TWELVE and one burning tank would hold 114 slots.
			particles.spawn(hurt >= HEAVY_AT ? 'ruinsmoke' : 'stack', wx, wy, wz, time, (id * 31 + 7) | 0, scale, shroud)
			this.budget--
			this.stats.spawned++
			// Flame under the column once the hull is BURNING (70% damage): `BURNING_AT`
			// is the documented threshold at which a fire anchor is allowed to show flame,
			// heavy damage alone only darkens the column. Every other puff so the emissive
			// term is readable without eating the shared particle budget.
			if (fire && hurt >= BURNING_AT && this.budget >= 1 && (Math.floor(time / interval) % 2) === 0) {
				const flame = scale * 0.95
				particles.spawn('stemfire', wx, wy - 0.03, wz, time, (id * 31 + 11) | 0, flame, shroud)
				this.budget--
				this.stats.flames++
			}
		}
	}
}
