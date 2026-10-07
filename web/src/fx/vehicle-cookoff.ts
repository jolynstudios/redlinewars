// STEELSEED — fx/vehicle-cookoff
//
// What a VEHICLE does when it dies.
//
// Until now a tank death and a sandbag death were the same three presets at the same
// instant: `smoke`, `fire`, `debris`, all at t=0, all at the actor's centre. For a building
// that was already wrong and `fx/mushroom-cloud` replaced it; for a tank it is wrong in a
// different way, because a vehicle does not fall down — it COOKS OFF. Ammunition inside the
// hull burns, and every round that reaches its cook-off threshold goes off on its own
// schedule seconds after the killing shot. The signature of an armoured death is that
// DELAY: flash and fireball out of the hull at once, then secondary pops, then a column,
// then a smouldering wreck. Arrived-all-at-once is the effect for a soft-skinned truck and
// even there it is the cheap version of the truth.
//
// THE SEQUENCE. Six layers, staggered:
//
//   0.00–0.06  flash      the penetrating hit, white-hot at the hull centre
//   0.00–0.40  fireball   the burning fuel ring rolling out of the hull
//   0.02       spall      ballistic debris off the hull top
//   0.35–1.15  pops       secondary ammunition cook-offs, delayed and OFFSET from the centre
//   0.10–2.20  column     the burn column, cooling as it climbs like the mushroom's stem
//   2.20–5.00  wreck      what is still smouldering on the hull two seconds later
//
// The pops starting a third of a second after the flash is the whole trick, the same one the
// mushroom plays with its cap: emit them together and the result is a bigger puff; emit them
// late and the eye reads a vehicle with something INSIDE it still going off.
//
// SIZED FROM THE HULL. The same `.forge/blender/manifest.json` bounds the mushroom reads,
// cube-rooted the same way. A vehicle is not a building: there is no yard tier and no nuke
// ceiling to enforce, only a clamp, because the biggest hull in the roster must stay a
// vehicle-sized event. The killing blow's violence byte still buys the same ±14% swing it
// buys the mushroom — an overkill throws a taller column than a last-shell finish.
//
// NO Math.random AND NO PER-FRAME ALLOCATION. Same rules as the mushroom, same integer
// `hash(actor id, layer, index)`, same fixed parallel arrays with one integer cursor per
// layer, so two machines watching the same replay cook off identically.

import type { Ctx } from '../core'
import type { ShroudApi, TerrainApi } from './types'
import type { ParticleSink } from './mushroom-cloud'

/**
 * Concurrent cook-offs. Eight is the budget, not a guess: a tank battle's opening salvo can
 * kill half a dozen vehicles inside a second, and at 50 particles each the worst case is 400
 * of the shared pool's 2048 slots — a fifth of the battlefield, never more.
 */
const MAX_VEHICLES = 8

/** Layer identifiers, and the index of each layer's cursor within a cook-off's cursor block. */
const FLASH = 0, FIREBALL = 1, SPALL = 2, POPS = 3, COLUMN = 4, WRECK = 5
const LAYERS = 6

/**
 * `[startSeconds, endSeconds, emissions]` per layer. The stagger lives here and nowhere
 * else, which is what makes it assertable: `cookoffgate` reads these three numbers per layer
 * and checks the ORDER the frame actually receives against them.
 */
const SCHEDULE = Float32Array.of(
	0.00, 0.06, 1,
	0.00, 0.40, 5,
	0.02, 0.02, 2,
	0.35, 1.15, 3,
	0.10, 2.20, 8,
	2.20, 5.00, 3,
)

/** Particles per emission, from `content-manifest.json`. Only the instant layers exceed 1. */
const PER_EMISSION = Int32Array.of(3, 2, 10, 2, 1, 1)

/** Total particles one vehicle death puts into the shared pool. Asserted by the gate. */
export const SCHEDULE_PARTICLES = (() => {
	let total = 0
	for (let layer = 0; layer < LAYERS; layer++) total += SCHEDULE[layer * 3 + 2] * PER_EMISSION[layer]
	return total
})()

/** Seconds after the event at which a cook-off is finished and its slot returns to the pool. */
const CLOUD_LIFETIME_S = 5.2

interface RosterAsset {
	readonly template?: string
	/** `[[minX,minY,minZ],[maxX,maxY,maxZ]]` in authored model metres. */
	readonly bounds?: readonly (readonly number[])[]
}

interface RosterManifest {
	readonly assets: Readonly<Record<string, RosterAsset>>
}

// Same shape as `mushroom-cloud.ts`: a build artefact read at module scope, not another
// node. A clone with no forged pack still boots, on the fallback dimensions below.
const rosterManifests = import.meta.glob<RosterManifest>('../../.forge/blender/manifest.json', { eager: true, import: 'default' })
const ROSTER: Readonly<Record<string, RosterAsset>> = Object.values(rosterManifests)[0]?.assets ?? {}

/** Fallback bounding box when a vehicle resolves to no manifest entry, in model metres. */
const FALLBACK_SPAN_M = Float32Array.of(2.4, 1.5, 2.4)

/** Hull footprint radius and burn-column height, per unit of driver. */
const HULL_K = 0.42
const TOP_K = 1.15
/** Particle size per unit of driver, bounded so neither extreme becomes a different effect. */
const SIZE_DIVISOR = 2.0
const SIZE_MIN = 0.45
const SIZE_MAX = 1.1
/** The vehicle clamp. Bigger than every hull in the roster, far below the mushroom's scale. */
const UNIT_MIN = 0.55
const UNIT_MAX = 2.2

/** Same integer hash as `particles.ts` and `mushroom-cloud.ts`, returning 0..1. */
function hash(value: number): number {
	value = (value ^ 61) ^ (value >>> 16)
	value = (value + (value << 3)) | 0
	value = value ^ (value >>> 4)
	value = Math.imul(value, 0x27d4eb2d)
	value = value ^ (value >>> 15)
	return (value >>> 0) / 4294967296
}

export interface VehicleCookoffStats {
	active: number
	started: number
	refused: number
	passedThrough: number
	emissions: number
	particles: number
}

export class VehicleCookoff {
	private readonly active = new Uint8Array(MAX_VEHICLES)
	private readonly actorId = new Uint32Array(MAX_VEHICLES)
	private readonly born = new Float32Array(MAX_VEHICLES)
	private readonly x = new Float32Array(MAX_VEHICLES)
	private readonly base = new Float32Array(MAX_VEHICLES)
	private readonly z = new Float32Array(MAX_VEHICLES)
	/** Derived geometry: hull footprint radius, column top, hull height, size multiplier. */
	private readonly hullR = new Float32Array(MAX_VEHICLES)
	private readonly top = new Float32Array(MAX_VEHICLES)
	private readonly hull = new Float32Array(MAX_VEHICLES)
	private readonly sizeK = new Float32Array(MAX_VEHICLES)
	/** Index of the next emission each layer owes, so a frame emits each one exactly once. */
	private readonly cursor = new Int32Array(MAX_VEHICLES * LAYERS)

	/** `null` caches a resolved miss, so an unsized type does not re-walk the roster. */
	private readonly assetByType = new Map<number, RosterAsset | null>()

	readonly stats: VehicleCookoffStats = {
		active: 0, started: 0, refused: 0, passedThrough: 0, emissions: 0, particles: 0,
	}

	/** The roster record for a type id when it resolves to an asset at all, else null. */
	private assetFor(typeId: number, ctx: Ctx): RosterAsset | null {
		const cached = this.assetByType.get(typeId)
		if (cached !== undefined) return cached
		const name = ctx.actorTypeName(typeId)
		// An unresolved type is not a miss; leave it uncached so the table can answer later.
		if (name === '') return null
		const asset = ROSTER[name] ?? null
		this.assetByType.set(typeId, asset)
		return asset
	}

	/**
	 * Start a cook-off for an authoritative destruction, or answer false and leave the
	 * caller's generic burst in charge.
	 *
	 * False means every one of: finite arguments failed, the roster has no name table yet or
	 * no entry for the type, eight cook-offs are already burning, or the death is behind
	 * shroud. The caller must treat false as "you still owe this actor an explosion", because
	 * a tank death that produced nothing at all would be a worse regression than the puff
	 * this replaces.
	 *
	 * @param eventY the destruction event's own elevation, which is the SIMULATION's. The
	 * same correction the mushroom makes applies here: the drawn ground is probed and added,
	 * or a cook-off on a hill starts underneath it.
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
		// The type id comes from the actor's own snapshot row, current snapshot first and the
		// previous one second — by the frame the event is handled the actor may already have
		// left the current snapshot, and a same-tick death is still listed there.
		let typeId = -1
		for (let pass = 0; pass < 2 && typeId < 0; pass++) {
			const actors = (pass === 0 ? ctx.snapshot : ctx.prevSnapshot)?.actors
			if (!actors) continue
			for (let i = 0; i < actors.count; i++) {
				if (actors.id[i] !== actorId) continue
				typeId = actors.typeId[i]
				break
			}
		}
		if (typeId < 0) return false
		const asset = this.assetFor(typeId, ctx)
		if (asset === null) { this.stats.passedThrough++; return false }
		if (!shroud.isVisible(Math.floor(eventX), Math.floor(eventZ))) return false

		let slot = -1
		for (let i = 0; i < MAX_VEHICLES; i++) {
			// A second event for an actor already cooking off must not double the fire.
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
		}
		// One length that stands for the whole hull, compressed, clamped to vehicle scale.
		const unit = Math.max(UNIT_MIN, Math.min(UNIT_MAX, Math.cbrt(spanX * spanY * spanZ)))
		const hull = spanY

		// Violence is the fraction of max health the killing blow carried, so an overkill
		// throws a taller column than a last-shell finish. Bounded either side, exactly the
		// swing the mushroom grants — not a second size system.
		const v = Math.max(0, Math.min(1, violence / 255))
		const punch = 0.86 + 0.28 * v

		this.active[slot] = 1
		this.actorId[slot] = actorId
		this.born[slot] = time
		this.x[slot] = eventX
		this.z[slot] = eventZ
		this.base[slot] = eventY + (terrain?.heightAt(eventX, eventZ) ?? 0)
		this.hull[slot] = hull
		this.hullR[slot] = HULL_K * unit
		this.top[slot] = TOP_K * unit * punch
		this.sizeK[slot] = Math.max(SIZE_MIN, Math.min(SIZE_MAX, unit / SIZE_DIVISOR)) * (0.90 + 0.20 * v)
		for (let layer = 0; layer < LAYERS; layer++) this.cursor[slot * LAYERS + layer] = 0
		this.stats.started++
		return true
	}

	/** Wall-clock-independent reset; `Fx.dispose` and the gate use it. */
	clear(): void {
		this.active.fill(0)
		this.stats.active = 0
	}

	/**
	 * Release every emission whose scheduled moment has passed. Same contract as
	 * `MushroomCloud.tick`: `time` is the effect clock the particle pool runs on, so a
	 * cook-off keeps cooking across a paused frame rather than freezing mid-column.
	 */
	tick(time: number, particles: ParticleSink, shroud: ShroudApi): void {
		let live = 0
		for (let slot = 0; slot < MAX_VEHICLES; slot++) {
			if (!this.active[slot]) continue
			const age = time - this.born[slot]
			if (!(age >= 0) || age >= CLOUD_LIFETIME_S) { this.active[slot] = 0; continue }
			live++
			for (let layer = 0; layer < LAYERS; layer++) {
				const from = SCHEDULE[layer * 3]
				const to = SCHEDULE[layer * 3 + 1]
				const count = SCHEDULE[layer * 3 + 2]
				const cursorAt = slot * LAYERS + layer
				let next = this.cursor[cursorAt]
				if (next >= count || age < from) continue
				// How many of this layer's emissions the clock has passed. A layer with a zero
				// span (`spall`) releases all of its emissions the moment it opens.
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
		const count = SCHEDULE[layer * 3 + 2]
		const p = count > 1 ? index / (count - 1) : 0
		const id = this.actorId[slot]
		const seed = (id * 2654435761 + layer * 7919 + index * 104729) | 0
		const ha = hash(seed)
		const hb = hash(seed + 1013904223)
		const hc = hash(seed + 1664525)
		const cx = this.x[slot]
		const cz = this.z[slot]
		const ground = this.base[slot]
		const hull = this.hull[slot]
		const size = this.sizeK[slot]
		let name = 'fireball'
		let ox = 0
		let oy = 0
		let oz = 0
		let scale = size

		switch (layer) {
			case FLASH: {
				name = 'blastcore'
				oy = hull * 0.4
				scale = size * 1.5
				break
			}
			case FIREBALL: {
				// A ring, not a point: burning fuel spreads across the hull before it climbs.
				name = 'fireball'
				const a = ha * Math.PI * 2
				const r = this.hullR[slot] * (0.30 + 0.45 * hb)
				ox = Math.cos(a) * r
				oz = Math.sin(a) * r
				oy = hull * (0.18 + 0.62 * p)
				scale = size * (0.85 + 0.40 * hc)
				break
			}
			case SPALL: {
				// Ballistic debris off the hull top. The preset carries its own arc; this only
				// has to start the fragments where armour is, not where the centre is.
				name = 'rubble'
				const a = ha * Math.PI * 2
				const r = this.hullR[slot] * 0.5 * hb
				ox = Math.cos(a) * r
				oz = Math.sin(a) * r
				oy = hull * (0.8 + 0.2 * hc)
				scale = size * 1.1
				break
			}
			case POPS: {
				// Secondary ammunition. OFF the centre line, on the hull itself: a cook-off
				// pop from the exact centre reads as the same explosion again.
				name = 'fireball'
				const a = ha * Math.PI * 2
				const r = this.hullR[slot] * (0.4 + 0.6 * hb)
				ox = Math.cos(a) * r
				oz = Math.sin(a) * r
				oy = hull * 0.5
				scale = size * (0.70 + 0.35 * hc)
				break
			}
			case COLUMN: {
				// Cools as it climbs, by height fraction, exactly like the mushroom's stem:
				// `particles.ts` has no over-life colour ramp, so the ramp is presets chosen
				// by height — incandescent low, burning through the middle, dark smoke above.
				name = p < 0.35 ? 'fireball' : p < 0.75 ? 'stemfire' : 'barrelsmoke'
				const a = index * 2.39996323 + hb * 1.4
				// The column narrows as it rises, which is the waist a plume needs.
				const r = this.hullR[slot] * (0.62 - 0.30 * p) * (0.4 + 0.9 * ha)
				ox = Math.cos(a) * r
				oz = Math.sin(a) * r
				const bottom = hull * 0.45
				oy = bottom + (this.top[slot] - bottom) * p
				scale = size * (0.75 + 0.45 * hc)
				break
			}
			case WRECK: {
				name = 'ruinsmoke'
				const a = index * 2.39996323 + ha
				const r = this.hullR[slot] * 0.45 * hb
				ox = Math.cos(a) * r
				oz = Math.sin(a) * r
				oy = hull * (0.18 + 0.30 * hc)
				scale = size * 0.85
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

export const VEHICLE_COOKOFF_LAYERS = Object.freeze({ FLASH, FIREBALL, SPALL, POPS, COLUMN, WRECK, LAYERS, MAX_VEHICLES })
