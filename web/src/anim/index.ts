// STEELSEED — anim
// The node that owns animation STATE, because nothing else is allowed to.
//
// Every remaining articulation in the plan needs the same thing and it is not a pose: a wheel
// angle is the integral of speed, a track's scroll phase is the same integral, and an infantry
// gait phase is that integral divided by a stride. None of those can be computed from one
// snapshot, and none of them can live in `units` — that node's contract (§4.11, and the first
// paragraph of its own file) is that it remembers nothing about the battlefield, because a
// second copy of an actor's transform is a second copy that can disagree with the simulation.
//
// That rule is right and this node does not break it. What is kept here is not a position and
// not a prediction: it is HOW FAR AN ACTOR HAS TRAVELLED, which the simulation does not track,
// cannot disagree about, and which no consumer could reconstruct from a single tick. If this
// node's state were lost the actors would still be in the right places; only their wheels would
// jump. That is the test for whether something belongs here rather than in `units`.
//
// DISTANCE, not angle, and not phase. A wheel angle needs a wheel radius, a track phase needs a
// tread pitch, and a gait phase needs a stride — all of them per-actor geometry that lives in
// the archetype layer. Publishing distance keeps this node ignorant of what is consuming it,
// so adding a walking figure later costs nothing here.
//
// The integral comes from POSITION, not from the snapshot's `speed` field, and that is
// deliberate: SnapshotEmitter.cs still writes speed as a hardcoded zero and its comment refuses
// to emit "a plausible-but-wrong value". |Δposition| between two consecutive snapshots is not a
// guess — it is exactly the distance the simulation moved the actor.

import type { Ctx, Snapshot, SnapshotEvent } from '../core'
import { ActorFlag, SIM_TICK_HZ, SimEvent, findActorIndex, wangleToRadians } from '../core'

/** WPos is 1024 per cell and one cell is one metre (§12.4). */
const WPOS_TO_M = 1 / 1024

/**
 * A teleport is not travel. Chronoshift, redeploy and spawn all move an actor discontinuously,
 * and integrating that would spin a wheel by the width of the map in one tick. Anything past
 * this in a single 40 ms tick is not something a machine drove.
 */
const MAX_TICK_TRAVEL_M = 8

/**
 * How long an actor holds the aim after its last shot, in simulation ticks.
 *
 * A rifleman does not drop to a carry between shots; he stays shouldered. This is the
 * dwell that turns a stream of discrete weaponFire events into one continuous engagement,
 * and it is deliberately longer than the authored fire clip so consecutive shots do not
 * flicker the upper body back to the ready.
 */
const AIM_HOLD_TICKS = 45

/** Seconds the authored aim transition takes; see `human_motion.py` AIM_SECONDS. */
const AIM_SECONDS = .55

export interface AnimApi {
	/**
	 * Cumulative ground distance in metres, or 0 for an actor first seen this tick.
	 *
	 * Signed and unbounded within a session. Reverse travel subtracts distance, so wheels and
	 * tracks rotate backwards instead of visually driving forward while reversing.
	 */
	distanceOf(actorId: number): number
	/** Interpolate the unwrapped distance with the same alpha used for actor placement. */
	interpolatedDistanceOf(actorId: number, alpha: number): number
	/** Signed contact travel at a lateral offset in fitted render metres. */
	sideDistanceOf(actorId: number, lateralM: number, alpha: number): number
	/** Actors currently tracked. Diagnostic; a gate asserts this follows the roster. */
	readonly trackedCount: number
	/**
	 * 0 while carried at the ready, 1 while fully shouldered, ramping over AIM_SECONDS.
	 *
	 * This is state for the same reason distance is: a transition has a direction and a
	 * history, and a single snapshot cannot say whether an actor is raising its weapon or
	 * lowering it. What it is NOT is a pose -- the caller owns the clip and the skeleton.
	 */
	aimOf(actorId: number): number
	/** Interpolate the aim weight with the same alpha used for actor placement. */
	interpolatedAimOf(actorId: number, alpha: number): number
	/**
	 * Seconds since this actor's last observed shot, or a negative number if it has none.
	 *
	 * Feeds the recoil clip's clock. Counted in simulation ticks and interpolated by the
	 * same alpha as placement, so it stops dead when the match is paused and never needs the
	 * caller to own a second clock that could disagree with this one.
	 */
	secondsSinceFire(actorId: number, alpha: number): number
	/** Actors whose last shot is still inside the aim hold. Diagnostic. */
	readonly firingCount: number
}

export class Anim implements AnimApi {
	static id = 'anim'
	static deps: string[] = []

	/**
	 * actorId -> metres travelled.
	 *
	 * A Map rather than a dense array because actor ids are sim-assigned and sparse, and this
	 * is touched once per actor per TICK (25 Hz) rather than per frame — so rule 6's
	 * allocate-nothing-per-frame is not in tension with it. Entries for actors that have left
	 * the world are dropped on the same pass that updates the survivors.
	 */
	private distance = new Map<number, number>()
	private scratch = new Map<number, number>()
	private turn = new Map<number, number>()
	private turnScratch = new Map<number, number>()
	private observedTick = -1

	/** actorId -> simulation tick of the most recently observed weaponFire naming it. */
	private firedAt = new Map<number, number>()
	/** actorId -> aim weight at the end of the last tick, and at the end of the one before. */
	private aim = new Map<number, number>()
	private aimScratch = new Map<number, number>()
	private latestTick = 0
	private offFire: (() => void) | null = null
	private ctx: Ctx | null = null

	init(ctx: Ctx): void {
		this.ctx = ctx
		this.offFire = ctx.events.on<SnapshotEvent>(SimEvent.weaponFire, this.onWeaponFire)
	}

	/**
	 * The fire record opens with the firing actor's id, the same field `fx` reads to lift a
	 * muzzle flash onto its authored barrel. Recorded, never acted on here: this node holds
	 * the clock, and the caller decides what to draw with it.
	 */
	private readonly onWeaponFire = (event: SnapshotEvent): void => {
		// Read the CURRENT snapshot, the way fx does, rather than a view cached on the last
		// onSnapshot. Events are dispatched around the decode, and an offset resolved against
		// the previous tick's buffer would credit the shot to whatever id happened to sit
		// there -- a recoil on the wrong soldier is worse than no recoil.
		const snap = this.ctx?.snapshot
		if (!snap?.view || !event || event.byteLength < 4) return
		this.firedAt.set(snap.view.getUint32(event.offset, true), snap.tick)
	}

	get trackedCount(): number {
		return this.distance.size
	}

	get firingCount(): number {
		let count = 0
		for (const weight of this.aim.values()) if (weight > 0) count++
		return count
	}

	aimOf(actorId: number): number {
		return this.aim.get(actorId) ?? 0
	}

	interpolatedAimOf(actorId: number, alpha: number): number {
		const current = this.aim.get(actorId)
		if (current === undefined) return 0
		const previous = this.aimScratch.get(actorId) ?? current
		const blend = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1
		return previous + (current - previous) * blend
	}

	secondsSinceFire(actorId: number, alpha: number): number {
		const at = this.firedAt.get(actorId)
		if (at === undefined) return -1
		const blend = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1
		const ticks = this.latestTick + blend - at
		// A rewound clock (replay seek, new match) is not a shot that has not happened yet.
		return ticks < 0 ? -1 : ticks / SIM_TICK_HZ
	}

	distanceOf(actorId: number): number {
		return this.distance.get(actorId) ?? 0
	}

	interpolatedDistanceOf(actorId: number, alpha: number): number {
		const current = this.distance.get(actorId)
		if (current === undefined) return 0
		// After the snapshot swap, scratch still contains the preceding tick's map.
		// First sightings have no predecessor; never interpolate from an invented zero.
		const previous = this.scratch.get(actorId) ?? current
		const blend = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1
		return previous + (current - previous) * blend
	}

	sideDistanceOf(actorId: number, lateralM: number, alpha: number): number {
		const current = this.turn.get(actorId) ?? 0
		const previous = this.turnScratch.get(actorId) ?? current
		const blend = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1
		return this.interpolatedDistanceOf(actorId, alpha) + lateralM * (previous + (current - previous) * blend)
	}

	onSnapshot(snap: Snapshot, prev: Snapshot | null, _ctx: Ctx): void {
		const actors = snap.actors
		const tick = Number.isFinite(snap.tick) ? snap.tick : 0
		if (tick === this.observedTick) return
		const rewind = tick < this.observedTick
		this.observedTick = tick
		if (rewind || !actors) {
			this.distance.clear(); this.scratch.clear(); this.turn.clear(); this.turnScratch.clear()
			this.aim.clear(); this.aimScratch.clear(); this.firedAt.clear()
		}
		if (!actors) return
		const before = rewind ? null : prev?.actors ?? null
		this.latestTick = tick
		const aimNext = this.aimScratch
		aimNext.clear()
		const step = 1 / SIM_TICK_HZ / AIM_SECONDS

		// Rebuilt into a scratch map and swapped, so an actor that died this tick is dropped
		// without a second pass and without allocating a set of survivors.
		const next = this.scratch
		next.clear()
		const turnNext = this.turnScratch
		turnNext.clear()

		for (let i = 0; i < actors.count; i++) {
			const id = actors.id[i]
			const carried = this.distance.get(id) ?? 0
			const carriedTurn = this.turn.get(id) ?? 0
			turnNext.set(id, carriedTurn)
			if (before === null) {
				next.set(id, carried)
				continue
			}
			// Matched by ID. The array is ordered by ascending id but compacts on death, so
			// index i is not the same actor across ticks, and differencing two positions that
			// belong to different machines would integrate the distance between them.
			const j = findActorIndex(before, id)
			if (j < 0) {
				// First seen this tick. Starts at zero rather than inheriting a stale entry
				// from a recycled id.
				next.set(id, 0)
				turnNext.set(id, 0)
				continue
			}
			const dx = (actors.posX[i] - before.posX[j]) * WPOS_TO_M
			const dz = (actors.posY[i] - before.posY[j]) * WPOS_TO_M
			const travel = Math.hypot(dx, dz)
			// Mesh-local +X is the only forward convention. Project the actual displacement
			// onto the authoritative OpenRA body facing; the central conversion is shared with
			// the renderer, so reverse motion gets the opposite sign without a second facing map.
			const yaw = wangleToRadians(actors.facing[i])
			const previousYaw = wangleToRadians(before.facing[j])
			const delta = Math.atan2(Math.sin(yaw - previousYaw), Math.cos(yaw - previousYaw))
			const midYaw = previousYaw + delta * 0.5
			const signedStep = dx * Math.cos(midYaw) - dz * Math.sin(midYaw)
			const discontinuous = travel > MAX_TICK_TRAVEL_M
			next.set(id, carried + (discontinuous ? 0 : signedStep))
			turnNext.set(id, carriedTurn + (discontinuous ? 0 : delta))
		}

		// A host that publishes no flags section is not a host where everything is firing:
		// fall back to the observed shots alone rather than reading past the array.
		const flags = actors.flags
		for (let i = 0; i < actors.count; i++) {
			const id = actors.id[i]
			const held = this.firedAt.get(id)
			const flag = flags ? flags[i] : 0
			// `firing` is the sim's own flag; a recent shot covers the gap between bursts. The
			// husk flag is what "dead" means -- a corpse never holds an aim, and `disabled` is
			// not a truth source for "switched off" (a rookie's veterancy traits set it).
			const engaged = (flag & ActorFlag.husk) === 0 &&
				(((flag & ActorFlag.firing) !== 0) ||
					(held !== undefined && tick - held >= 0 && tick - held < AIM_HOLD_TICKS))
			const previous = this.aim.get(id) ?? 0
			const target = previous + (engaged ? step : -step)
			aimNext.set(id, target < 0 ? 0 : target > 1 ? 1 : target)
		}
		for (const id of this.firedAt.keys()) if (!aimNext.has(id)) this.firedAt.delete(id)

		this.scratch = this.distance
		this.distance = next
		this.turnScratch = this.turn
		this.turn = turnNext
		this.aimScratch = this.aim
		this.aim = aimNext
	}

	dispose(): void {
		this.offFire?.()
		this.offFire = null
		this.ctx = null
		this.distance.clear()
		this.scratch.clear()
		this.turn.clear()
		this.turnScratch.clear()
		this.observedTick = -1
		this.aim.clear()
		this.aimScratch.clear()
		this.firedAt.clear()
	}
}

export default Anim
