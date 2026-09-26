// STEELSEED — units/damage-states
//
// Which authored mesh an actor draws for its current condition, and how it gets there
// without popping. Authoring is `art/blender/damage_states.py`; the design contract is
// `art/blender/DAMAGE-STATES.md`.
//
// STRUCTURE IS DISCRETE, COLOUR IS CONTINUOUS. The five rungs are separate meshes cut
// from the same parent, so they cannot be blended as geometry — vertex counts differ by
// design. The soot term in shaders.ts already ramps continuously off the same health
// byte, so the seam this module has to hide is silhouette only.

import type { BlenderAsset } from './blender-mesh'
import type { DrawItem, GpuMesh, RenderApi } from './types'

/** `<actor>.d1`..`.d5`, plus the intact parent at index 0. */
export const RUNG_COUNT = 6
/** Seconds a cross-fade lasts. Long enough to read as motion, short enough not to lie. */
export const TRANSITION_SECONDS = 0.25
/**
 * Health the actor must regain PAST a boundary before the ladder steps back down, as a
 * 0..255 byte (15/255 = 5.9%). A building sitting exactly on a threshold while a repair
 * truck works would otherwise swap meshes every tick.
 */
const REPAIR_DEADBAND = 15
/** Simultaneous cross-fades. Beyond this the ghost closest to done is recycled for the
 * newcomer and `stolen` counts it — a small pop at the faintest fade, never a whole-building
 * rung jump, which is exactly the flicker the cross-fade exists to hide. */
const DISSOLVE_POOL = 48
/** Capacity of the Heavy/Critical crossing ring `drainTransitions` hands to fx. */
const PENDING_RING = 32
/** Open-addressed condition table. Power of two, above units' MAX_ACTORS of 2048. */
const TABLE = 4096
const TABLE_MASK = TABLE - 1
/** Probe length before a slot is stolen from the least recently seen entry. */
const PROBE = 8

/**
 * The rung an actor at this health byte belongs on.
 *
 * 0 = Undamaged, 1..4 = Light/Medium/Heavy/Critical. These are OpenRA's own
 * `Health.cs` thresholds (100/75/50/25/0% of MaxHP) converted to the 0..255 byte the
 * snapshot carries, kept as integer arithmetic ON THE BYTE rather than on a reconstructed
 * float so the comparison is exact for the value it is actually given.
 *
 * THE COMPARISON IS AGAINST THE BYTE'S CENTRE, NOT ITS EDGE, AND THAT IS MEASURED.
 * `SnapshotEmitter` sends `floor(255 * HP / MaxHP)`, so byte 191 does not mean 191/255 —
 * it means "HP/MaxHP somewhere in [0.74902, 0.75294)", an interval whose centre is ABOVE
 * the 75% boundary even though its lower edge is below it. Testing the edge (`h * 4 <
 * 255 * 3`) therefore draws Medium for a 1000 HP actor sitting on exactly 750 HP, which
 * the simulation calls Light. Testing the centre gets it right.
 *
 * `damagestategate` sweeps every one of the 35 distinct MaxHP values in the catalogue and
 * every health byte each can produce — 8,960 (MaxHP, byte) pairs — and checks the rung
 * drawn against the full set of `DamageState`s the simulation could actually be in for
 * that byte. Measured: the edge rule is outside that set for 1 pair; this centre rule is
 * outside it for 0. Every rung this draws is a rung the fight is really in.
 *
 * DEAD IS NOT REACHABLE FROM A HEALTH BYTE, and asking for it is a bug this had. That
 * same floor makes byte 0 mean "at most 1/255 of MaxHP left" — for the 60000 HP heavy
 * tank that is any HP from 1 to 235, all of them alive. Reading byte 0 as Dead put the
 * levelled ruin on screen while the building was still standing, still shooting and still
 * taking fire. A live actor is never `DamageState.Dead` in OpenRA either: Dead means
 * HP <= 0, which means the actor is being removed. So the live ladder tops out at
 * Critical and the Dead rung is bound by `wrecks` off the destruction EVENT, which is the
 * only signal that actually carries the fact of death.
 */
export function conditionState(health: number): number {
	if (health >= 255) return 0
	if (!(health > 0)) return 4
	// (health + 0.5) / 255 against 25 / 50 / 75 percent, cleared of fractions.
	if (health * 4 + 2 < 255) return 4
	if (health * 2 + 1 < 255) return 3
	if (health * 4 + 2 < 765) return 2
	return 1
}

/**
 * The rung to move to, given where the actor already is.
 *
 * Two rules on top of the raw threshold. Damage ADVANCES freely — a building does not
 * un-break because a shell grazed it back over a boundary. Healing steps back down only
 * once health has climbed a deadband past the boundary, which is what stops a repaired
 * structure flickering between burning and not burning while a truck works on it.
 */
export function nextRung(current: number, health: number): number {
	const target = conditionState(health)
	if (target >= current) return target
	// Would this actor still be on a lower rung if it were `REPAIR_DEADBAND` sicker? If so
	// it has genuinely recovered past the boundary rather than sitting on top of it.
	return conditionState(Math.max(0, health - REPAIR_DEADBAND)) < current ? target : current
}

/** One rung of one actor's ladder, as it exists after boot. */
interface Rung {
	/** Key into `units`' own `slotBuckets`, pre-interned so per-frame lookup allocates nothing. */
	readonly slotKey: string
	readonly mesh: GpuMesh
	readonly surfaceSet: string
	readonly boneCount: number
}

interface Ladder {
	readonly actor: string
	/** Index 0 is the intact parent; 1..5 are `.d1`..`.d5`. A missing rung falls back down. */
	readonly rungs: (Rung | null)[]
}

/** One in-flight cross-fade. The pool is fixed; `submit` is the only thing that reads it. */
interface Ghost {
	readonly transform: Float32Array
	readonly colors: Uint8Array
	readonly palette: Uint16Array
	readonly damages: Float32Array
	readonly item: { -readonly [K in keyof DrawItem]: DrawItem[K] }
	/** Position in the fade, 0..1 — how close this ghost is to being done. Set by `capture`. */
	t: number
	active: boolean
}

export interface DamageStateStats {
	/** Actors that own a ladder at all. The honest denominator for "how much of this ships". */
	laddered: number
	/** Rungs uploaded across every ladder. */
	rungs: number
	/** Rung changes observed since boot, including hard swaps. */
	transitions: number
	/** Cross-fades drawn this frame. */
	dissolves: number
	/** Transitions that found every pool slot busy and recycled the closest-to-done ghost. */
	stolen: number
	/** Live actors drawn on a rung ABOVE intact this frame. */
	damagedDrawn: number
	/** Condition table entries evicted under pressure; a nonzero value means TABLE is too small. */
	evictions: number
}

/**
 * Per-actor condition, and the cross-fade that hides a rung change.
 *
 * WHY NOT A SYMMETRIC CROSS-DISSOLVE. The obvious reading of "fade one out while the
 * other fades in" submits BOTH meshes translucent. That is wrong here and the arithmetic
 * says why: the translucent pass blends `src + dst*(1-srcA)`, so geometry present in both
 * rungs — which is most of the mesh, because every rung is cut from the same parent —
 * lands at 0.5*C + 0.5*(0.5*C + 0.5*bg) = 0.75*C + 0.25*background at the midpoint. The
 * building goes 25% see-through exactly when the player is looking at it. Worse, nothing
 * would be writing depth for a quarter second, so the structure also loses its shadow.
 *
 * So the fade is TWO-PHASE and exactly one mesh is opaque at any instant:
 *
 *   t < 0.5   opaque = outgoing rung, ghost = incoming at alpha t/0.5   (new debris fades IN)
 *   t >= 0.5  opaque = incoming rung, ghost = outgoing at alpha 1-(t-0.5)/0.5 (lost parts fade OUT)
 *
 * The handover at t = 0.5 is continuous: both descriptions draw the same image there, so
 * the swap of which half is opaque is invisible. Shared geometry is exactly correct at
 * every t because the ghost is depth-tested with `greater` under reverse-Z — coincident
 * triangles are REJECTED rather than double-blended, so the GPU removes the ghosting term
 * for free. Something opaque always writes depth, so the shadow never blinks.
 */
export class DamageStates {
	private readonly ladders = new Map<string, Ladder>()
	/** Reverse index for consumers that hold a mesh handle and not an actor name (`wrecks`). */
	private readonly meshActor = new Map<GpuMesh, string>()
	/** Bucket key -> owning actor, for name-keyed catalogue lookups. */
	private readonly slotActor = new Map<string, string>()
	private readonly ghosts: Ghost[] = []

	// --- condition table ------------------------------------------------------
	// Open-addressed on the actor id. Preallocated at boot: a Map keyed by a live actor id
	// would allocate on every first sighting, and this is read inside units' hot loop.
	private readonly key = new Int32Array(TABLE).fill(-1)
	private readonly rung = new Uint8Array(TABLE)
	private readonly from = new Uint8Array(TABLE)
	private readonly since = new Float32Array(TABLE)
	private readonly seen = new Uint32Array(TABLE)

	// --- Heavy/Critical crossings, drained by fx once per frame ------------------------------
	// Fixed ring, overwritten oldest-first. Rung transitions are rare and `REPAIR_DEADBAND`
	// stops flapping, so the capacity is headroom, never a queue to starve.
	private readonly pendingIds = new Uint32Array(PENDING_RING)
	private readonly pendingRungs = new Uint8Array(PENDING_RING)
	private pendingHead = 0
	private pendingTail = 0

	private seconds = 0
	private frame = 0

	readonly stats: DamageStateStats = {
		laddered: 0, rungs: 0, transitions: 0, dissolves: 0, stolen: 0,
		damagedDrawn: 0, evictions: 0,
	}

	constructor() {
		for (let i = 0; i < DISSOLVE_POOL; i++) {
			const transform = new Float32Array(16)
			const colors = new Uint8Array(1)
			const palette = new Uint16Array(1)
			const damages = new Float32Array(1)
			this.ghosts.push({
				transform, colors, palette, damages, t: 0, active: false,
				item: {
					mesh: null as unknown as GpuMesh, surfaceSet: 'blender', instances: transform,
					instanceCount: 1, playerColors: colors, paletteBases: palette, motionIds: null,
					boneCount: 0, phases: null, damages,
					// A fading half must not write the shadow map: the opaque half already casts
					// this actor's shadow and a second caster would double-darken it.
					castsShadow: false, opacity: 1,
				},
			})
		}
	}

	/** Boot only. `units` uploads the mesh and owns the bucket; this records the binding. */
	register(actor: string, rung: number, slotKey: string, mesh: GpuMesh, surfaceSet: string, boneCount: number): void {
		if (rung < 0 || rung >= RUNG_COUNT) throw new Error(`damage rung ${rung} is outside the ladder`)
		let ladder = this.ladders.get(actor)
		if (!ladder) {
			ladder = { actor, rungs: new Array<Rung | null>(RUNG_COUNT).fill(null) }
			this.ladders.set(actor, ladder)
		}
		if (ladder.rungs[rung] !== null) throw new Error(`${actor}.d${rung} registered twice`)
		ladder.rungs[rung] = { slotKey, mesh, surfaceSet, boneCount }
		this.meshActor.set(mesh, actor)
		this.slotActor.set(slotKey, actor)
		if (rung > 0) this.stats.rungs++
		this.stats.laddered = this.ladders.size
	}

	/** The actor a mesh handle belongs to, or undefined when it is not a ladder rung. */
	actorOfMesh(mesh: GpuMesh): string | undefined {
		return this.meshActor.get(mesh)
	}

	/**
	 * The actor a bucket key belongs to, for the handful of per-frame passes that iterate
	 * `slotBuckets` by NAME and look the name up in the OpenRA catalogue. `powr.d3` is not
	 * an actor there, and without this a damaged power station would quietly stop occluding
	 * the grass under its own footprint.
	 */
	actorOfSlot(slotKey: string): string | undefined {
		return this.slotActor.get(slotKey)
	}

	/** True once at least one rung above intact exists for this actor. */
	has(actor: string): boolean {
		const ladder = this.ladders.get(actor)
		if (!ladder) return false
		for (let r = 1; r < RUNG_COUNT; r++) if (ladder.rungs[r] !== null) return true
		return false
	}

	/** A frozen snapshot selects known geometry without creating combat transitions. */
	rememberedSlot(actor: string, health: number, minimumCondition = 0): string | null {
		const ladder = this.ladders.get(actor)
		if (!ladder) return null
		return this.resolve(ladder, Math.max(conditionState(health), Math.max(0,Math.min(2,minimumCondition|0))))?.rung.slotKey ?? null
	}

	/**
	 * The slot key for a persistent wreck of this actor, or null when it has no Dead rung.
	 *
	 * `wrecks` used to persist the INTACT mesh, which is why a destroyed building went on
	 * standing and could simply no longer be shot. A Dead rung is the authored answer.
	 */
	wreckSlot(actor: string): string | null {
		return this.ladders.get(actor)?.rungs[5]?.slotKey ?? null
	}

	/**
	 * The Dead rung belonging to whichever actor owns `mesh`, or null.
	 *
	 * `wrecks` holds the mesh that was on screen one frame before the actor died — which is
	 * whatever rung its health had reached, never the Dead one, because the destruction
	 * event is republished before the snapshot that would have zeroed its health. This is
	 * how it gets from that mesh to the authored remains.
	 */
	deadRungOf(mesh: GpuMesh): { mesh: GpuMesh; surfaceSet: string } | null {
		const actor = this.meshActor.get(mesh)
		if (actor === undefined) return null
		const dead = this.ladders.get(actor)?.rungs[5]
		return dead && dead.mesh !== mesh ? { mesh: dead.mesh, surfaceSet: dead.surfaceSet } : null
	}

	/** Per-frame preamble. `seconds` is presentation time, monotonic across the match. */
	beginFrame(seconds: number): void {
		this.seconds = seconds
		this.frame++
		this.stats.dissolves = 0
		this.stats.damagedDrawn = 0
		for (let i = 0; i < DISSOLVE_POOL; i++) this.ghosts[i].active = false
	}

	/**
	 * The slot key `units` should draw OPAQUE for this actor, or null to keep its own.
	 *
	 * Also advances this actor's condition and opens a cross-fade when the rung changed, so
	 * it must be called exactly once per drawn actor per frame.
	 */
	opaqueSlot(actorId: number, actor: string, health: number, minimumCondition = 0): string | null {
		const minimum = Math.max(0, Math.min(2, minimumCondition | 0))
		const ladder = this.ladders.get(actor)
		if (ladder === undefined) return null
		const at = this.slotFor(actorId)
		let current = this.rung[at]
		if (this.key[at] !== actorId) {
			// First sighting. Snap to the health it already has rather than fading up from
			// intact — a building revealed by scouting at 30% has not just been hit.
			this.key[at] = actorId
			current = Math.max(minimum, conditionState(health))
			this.rung[at] = current
			this.from[at] = current
			this.since[at] = -TRANSITION_SECONDS
		} else {
			const next = Math.max(minimum, nextRung(current, health))
			if (next !== current) {
				this.from[at] = current
				this.rung[at] = next
				this.since[at] = this.seconds
				this.stats.transitions++
				// A damage-direction crossing INTO Heavy or Critical is the just-took-a-serious-
				// hit moment fx answers with a burst. Repairs step back down through this same
				// branch — a building un-Criticaling is not news — and the first-sighting snap
				// above must never record: a ruin scouted at 30% was not just hit.
				if (next > current && next >= 3) {
					this.pendingIds[this.pendingTail] = actorId
					this.pendingRungs[this.pendingTail] = next
					this.pendingTail = (this.pendingTail + 1) & (PENDING_RING - 1)
					// Full ring: drop the OLDEST crossing rather than grow.
					if (this.pendingHead === this.pendingTail)
						this.pendingHead = (this.pendingHead + 1) & (PENDING_RING - 1)
				}
				current = next
			}
		}
		this.seen[at] = this.frame
		const t = (this.seconds - this.since[at]) / TRANSITION_SECONDS
		// Phase 1 keeps the outgoing rung opaque so the geometry the incoming rung ADDS can
		// fade in over it; phase 2 hands opacity to the incoming rung so what it REMOVED can
		// fade out. See the class comment for why this beats fading both.
		const opaque = t < 0.5 ? this.resolve(ladder, this.from[at]) : this.resolve(ladder, current)
		if (opaque !== null && opaque.rungIndex > 0) this.stats.damagedDrawn++
		return opaque === null ? null : opaque.rung.slotKey
	}

	/**
	 * Hand every recorded Heavy/Critical crossing to `sink` and empty the ring.
	 *
	 * Zero-cost when nothing crossed, which is the overwhelming majority of frames. The sink
	 * is caller-owned and nothing is allocated here, so a full battlefield drains at the
	 * price of the crossings themselves.
	 */
	drainTransitions(sink: (actorId: number, rung: number) => void): void {
		if (this.pendingHead === this.pendingTail) return
		while (this.pendingHead !== this.pendingTail) {
			sink(this.pendingIds[this.pendingHead], this.pendingRungs[this.pendingHead])
			this.pendingHead = (this.pendingHead + 1) & (PENDING_RING - 1)
		}
		this.pendingHead = 0
		this.pendingTail = 0
	}

	/**
	 * Record the fading half of an in-flight transition, using the transform `units` just
	 * placed. Cheap and silent for the overwhelming majority of actors, which are not
	 * transitioning.
	 */
	capture(
		actorId: number, actor: string, health: number,
		transform: Float32Array, offset: number,
		playerColor: number, paletteBase: number, appearanceDamage = 1 - health / 255,
	): void {
		const ladder = this.ladders.get(actor)
		if (ladder === undefined) return
		const at = this.slotFor(actorId)
		if (this.key[at] !== actorId) return
		const t = (this.seconds - this.since[at]) / TRANSITION_SECONDS
		if (!(t >= 0) || t >= 1) return
		const ghostRung = t < 0.5 ? this.resolve(ladder, this.rung[at]) : this.resolve(ladder, this.from[at])
		const opaqueRung = t < 0.5 ? this.resolve(ladder, this.from[at]) : this.resolve(ladder, this.rung[at])
		// Both halves resolving to the SAME mesh means one of the two rungs is unauthored and
		// fell back onto the other. There is nothing to cross-fade and drawing the ghost would
		// only pay for a second translucent pass over identical geometry.
		if (ghostRung === null || opaqueRung === null || ghostRung.rung.mesh === opaqueRung.rung.mesh) return
		const alpha = t < 0.5 ? t * 2 : 2 - t * 2
		if (!(alpha > 0.004)) return
		const ghost = this.free()
		for (let j = 0; j < 16; j++) ghost.transform[j] = transform[offset + j]
		ghost.colors[0] = playerColor
		// The rungs are asserted at authoring time to share a byte-identical bone array, so the
		// palette the opaque half already reserved poses the ghost correctly too. That is the
		// whole reason a cross-fade costs one skinning pass rather than two.
		ghost.palette[0] = paletteBase
		ghost.damages[0] = Math.max(1 - health / 255, appearanceDamage)
		ghost.item.mesh = ghostRung.rung.mesh
		ghost.item.surfaceSet = ghostRung.rung.surfaceSet
		ghost.item.boneCount = ghostRung.rung.boneCount
		ghost.item.opacity = alpha
		ghost.t = t
		ghost.active = true
		this.stats.dissolves++
	}

	/** Hand every live cross-fade to render. Called once, after units' own buckets. */
	submit(render: RenderApi): void {
		for (let i = 0; i < DISSOLVE_POOL; i++) {
			const ghost = this.ghosts[i]
			if (ghost.active) render.submit(ghost.item as DrawItem)
		}
	}

	/** Test/gate surface: the rung this actor is currently drawn on, or -1 if untracked. */
	rungOf(actorId: number): number {
		const at = this.slotFor(actorId)
		return this.key[at] === actorId ? this.rung[at] : -1
	}

	dispose(): void {
		this.ladders.clear()
		this.meshActor.clear()
		this.slotActor.clear()
		this.key.fill(-1)
		this.rung.fill(0)
		this.from.fill(0)
		this.since.fill(0)
		this.seen.fill(0)
		for (let i = 0; i < DISSOLVE_POOL; i++) {
			this.ghosts[i].active = false
			this.ghosts[i].item.mesh = null as unknown as GpuMesh
		}
		for (const k of Object.keys(this.stats) as (keyof DamageStateStats)[]) this.stats[k] = 0
	}

	/**
	 * The nearest AUTHORED rung at or below `wanted`.
	 *
	 * Most of the roster has no ladder, and a partly authored one is normal too — d5 alone
	 * is a legitimate ladder. Falling DOWN the ladder rather than up means a missing rung
	 * shows the actor as less hurt than it is, never as more hurt, so the fallback can
	 * never invent damage the simulation has not dealt.
	 */
	private resolve(ladder: Ladder, wanted: number): { rung: Rung; rungIndex: number } | null {
		for (let r = Math.min(wanted, RUNG_COUNT - 1); r >= 0; r--) {
			const rung = ladder.rungs[r]
			if (rung !== null) return { rung, rungIndex: r }
		}
		return null
	}

	/** Slot for this actor id: its own, a free one, or the least recently seen in the probe run. */
	private slotFor(actorId: number): number {
		let h = (Math.imul(actorId, 2654435761) >>> 16) & TABLE_MASK
		let stale = h
		let staleFrame = 0xffffffff
		for (let step = 0; step < PROBE; step++) {
			const k = this.key[h]
			if (k === actorId || k === -1) return h
			if (this.seen[h] < staleFrame) { staleFrame = this.seen[h]; stale = h }
			h = (h + 1) & TABLE_MASK
		}
		// A full probe run of live actors. Steal the coldest rather than losing the newcomer:
		// with TABLE at twice units' actor cap this is unreachable in practice, and `evictions`
		// says so out loud if it ever stops being unreachable.
		if (this.key[stale] !== -1) this.stats.evictions++
		this.key[stale] = -1
		return stale
	}

	/**
	 * A slot for one more cross-fade: the first inactive ghost or, when a mass-damage event
	 * has every fade in flight, the ACTIVE ghost closest to done. Recycling the fade with the
	 * least left to draw costs one small pop at the faintest alpha; returning null used to cost
	 * a whole-building rung swap, which is the pop the 0.25s cross-fade exists to hide. Ties
	 * resolve to the lowest index, so the choice is deterministic and replay-safe.
	 */
	private free(): Ghost {
		let victim = -1
		let victimT = -1
		for (let i = 0; i < DISSOLVE_POOL; i++) {
			const ghost = this.ghosts[i]
			if (!ghost.active) return ghost
			if (ghost.t > victimT) { victimT = ghost.t; victim = i }
		}
		this.stats.stolen++
		return this.ghosts[victim]
	}
}

// ---------------------------------------------------------------------------
// Pack loading. Mirrors `blender-assets.ts` deliberately: same glob-or-absent rule, same
// gzip-or-plain handling, same byte-count and SHA-256 verification. A second, subtly
// different asset path is how two loaders drift until one of them is silently wrong.
// ---------------------------------------------------------------------------

/** One rung's manifest entry. Identical in shape to a roster asset, plus its threshold. */
export interface DamageStateAsset extends BlenderAsset {
	readonly detailMask?: { readonly sourceSha256: string; readonly sha256: string; readonly size: number }
	readonly state: string
	readonly healthBelow: number
	readonly sha256: string
}

export interface DamageStateManifest {
	readonly schema: number
	readonly actor: string
	readonly parentSourcePath: string
	readonly parentSourceSha256: string
	readonly file: string
	readonly bytes: number
	readonly sha256: string
	readonly compression?: 'gzip'
	readonly storedBytes?: number
	readonly states: readonly DamageStateAsset[]
}

export interface DamageStatePack {
	readonly manifest: DamageStateManifest
	readonly bytes: Uint8Array
}

// Only `<actor>/manifest.json`. The exporter's default output also drops a copy at the
// top level of the directory, and globbing that in would load one actor's ladder twice
// under whatever actor happened to run last.
const damageManifests = import.meta.glob<DamageStateManifest>('../../.forge/damage-states/*/manifest.json', { eager: true, import: 'default' })
const damagePacks = import.meta.glob<string>('../../.forge/damage-states/*/states.ssmesh.gz', { eager: true, query: '?url', import: 'default' })

const ACTOR_OF_PATH = /\/damage-states\/([^/]+)\//

/**
 * Every authored condition ladder present in this build, keyed by actor.
 *
 * An absent pack is normal and silent — the ladder is additive and the roster mesh is the
 * fallback. A pack that is PRESENT and does not verify is fatal for that actor only: a
 * ladder whose bytes do not hash is a wrong render, not a missing one.
 */
export async function loadDamageStates(rosterSource: (actor: string) => string | undefined): Promise<Map<string, DamageStatePack>> {
	const out = new Map<string, DamageStatePack>()
	if (new URLSearchParams(globalThis.location?.search ?? '').get('noforge') === '1') return out
	const urls = new Map<string, string>()
	for (const [path, url] of Object.entries(damagePacks)) {
		const actor = ACTOR_OF_PATH.exec(path)?.[1]
		if (actor) urls.set(actor, url)
	}
	for (const [path, manifest] of Object.entries(damageManifests)) {
		const actor = ACTOR_OF_PATH.exec(path)?.[1]
		if (!actor || !manifest) continue
		const url = urls.get(actor)
		if (!url) continue
		if (manifest.schema !== 1 || manifest.actor !== actor)
			throw new Error(`Damage pack ${actor} has an unsupported or mislabelled manifest`)
		// The rungs are cut from the parent scene, so a parent that has moved since leaves
		// every rung a wrong render of a mesh that no longer exists. The authoring refuses to
		// export a stale variant; this refuses to LOAD one, because only the runtime can see
		// that the roster it is drawing beside has moved on.
		const roster = rosterSource(actor)
		if (roster !== undefined && roster !== manifest.parentSourceSha256) {
			// Refuse THIS ladder and keep the others. A stale pack used to throw here and
			// take down every authored building on the map, including ones whose parents
			// had not moved.
			console.warn(`[damage-states] skip ${actor}: parent source moved; re-author after forge`)
			continue
		}
		const response = await fetch(url)
		if (!response.ok) throw new Error(`Damage pack ${actor} download failed: HTTP ${response.status}`)
		const downloaded = await response.arrayBuffer()
		// Some hosts (Vite preview among them) serve .gz with Content-Encoding, so fetch has
		// already decompressed it; plain static hosts hand back the gzip file itself. Same
		// two-case rule as the roster loader, and for the same reason.
		const signature = new Uint8Array(downloaded, 0, Math.min(2, downloaded.byteLength))
		let buffer = downloaded
		if (signature[0] === 0x1f && signature[1] === 0x8b) {
			if (manifest.storedBytes !== undefined && downloaded.byteLength !== manifest.storedBytes)
				throw new Error(`Damage pack ${actor} compressed byte count mismatch`)
			const stream = new Blob([downloaded]).stream().pipeThrough(new DecompressionStream('gzip'))
			buffer = await new Response(stream).arrayBuffer()
		}
		if (buffer.byteLength !== manifest.bytes) throw new Error(`Damage pack ${actor} byte count mismatch`)
		const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(b => b.toString(16).padStart(2, '0')).join('')
		if (hash !== manifest.sha256) throw new Error(`Damage pack ${actor} SHA-256 mismatch`)
		out.set(actor, { manifest, bytes: new Uint8Array(buffer) })
	}
	// Decoys share the real building's ladder. Authoring them twice would double the
	// bytes and break the bluff the moment they took a different hole.
	const decoys: Readonly<Record<string, string>> = {
		facf: 'fact', weaf: 'weap', tenf: 'tent', atef: 'atek',
		syrf: 'syrd', spef: 'spen', pdof: 'pdox', fpwr: 'powr',
		fapw: 'apwr', fixf: 'fix', mslf: 'mslo', domf: 'dome',
	}
	for (const fake in decoys) {
		const real = decoys[fake]
		const pack = out.get(real)
		if (pack && !out.has(fake)) out.set(fake, pack)
	}
	return out
}
