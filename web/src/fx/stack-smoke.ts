// STEELSEED — fx/stack-smoke
//
// Chimneys, flues and exhaust stacks smoke while their building is running.
//
// The anchors have existed for a while and reached nothing. Four authoring scripts write
// `ss_smoke_emitters` into their scene — the refinery flue, the war factory stacks, the
// barracks chimney, and regen_production — and until now no exporter carried the key out of
// the .blend and no runtime read it. That is the fourth body of authored data this project
// shipped with no consumer, after 111 light anchors, 231 material sets and 50 weapon muzzle
// scales. `generate.py:export_smoke_emitters` now carries it into the manifest; this file is
// the consumer, so the chain ends in a frame instead of in a file.
//
// WHY ITS OWN PRESET. `spawn` emits `preset.count` particles per call into a 2048-slot pool
// shared with every explosion, and the `smoke` preset is a 12-particle puff living 3.8 s. One
// flue on that preset would hold ~114 particles, and a refinery would visibly starve shell
// bursts during a firefight. `stack` is one particle per emission, long-lived and slow, so a
// steady column costs about nine slots.
//
// WHY IT IS STATELESS. Rule: no per-frame allocation. A Map of accumulators keyed by actor id
// would allocate on every new building and have to be swept when actors die. Instead each
// emitter's cadence is a pure function of the wall clock and a hash of the actor id: the
// interval boundary is crossed at most once per frame, and two adjacent buildings never puff
// in lockstep because their phases differ. Nothing is remembered between frames.

import { ActorFlag, wangleToRadians, type Ctx } from '../core'
import type { ShroudApi, TerrainApi } from './types'
import type { SoftParticles } from './particles'

/** WPos is 1024 per cell and one cell is one render metre (§12.4). */
const WPOS_TO_M = 1 / 1024

/** Seconds between emissions from one stack. Slow enough to be a thread, not a stutter. */
const INTERVAL_S = 0.52

/** Metres above the anchor to release, so the puff clears its own cap rather than sitting in it. */
const RELEASE_M = 0.06

interface SmokeEmitter {
	readonly name: string
	readonly anchorM: readonly number[]
	readonly axis: readonly number[]
	readonly radiusM: number
}

interface RosterAsset {
	readonly smokeEmitters?: readonly SmokeEmitter[]
}

interface RosterManifest {
	readonly assets: Readonly<Record<string, RosterAsset>>
}

// Same shape as `render/nightlights.ts` and `units/blender-assets.ts`: a build artefact, not
// another node. Tolerates an absent local bake so a clone with no forged pack still boots —
// with no smoke, because it has no stacks.
const manifests = import.meta.glob<RosterManifest>('../../.forge/blender/manifest.json', { eager: true, import: 'default' })
const ROSTER: Readonly<Record<string, RosterAsset>> = Object.values(manifests)[0]?.assets ?? {}

function hash(value: number): number {
	let n = Math.imul(value ^ (value >>> 16), 0x45d9f3b)
	n = Math.imul(n ^ (n >>> 16), 0x45d9f3b)
	return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}

export interface StackSmokeStats {
	/** Actor types resolved as carrying at least one authored stack. */
	types: number
	/** Emitters that belonged to a drawn actor this frame. */
	live: number
	/** Emitters held back because their actor's snapshot flag says the machine is off. */
	held: number
	/** Puffs actually released this frame. */
	spawned: number
}

export class StackSmoke {
	/** null means "resolved, and this type has no stacks" — so a miss is cached too. */
	private readonly byType = new Map<number, readonly SmokeEmitter[] | null>()
	readonly stats: StackSmokeStats = { types: 0, live: 0, held: 0, spawned: 0 }

	private emittersFor(typeId: number, ctx: Ctx): readonly SmokeEmitter[] | null {
		const cached = this.byType.get(typeId)
		if (cached !== undefined) return cached
		const name = ctx.actorTypeName(typeId)
		// An unnamed type is not resolved yet; leave it uncached so it can answer later.
		if (name === '') return null
		const authored = ROSTER[name]?.smokeEmitters
		const emitters = authored !== undefined && authored.length > 0 ? authored : null
		this.byType.set(typeId, emitters)
		if (emitters !== null) this.stats.types++
		return emitters
	}

	/**
	 * Release one puff per stack per interval for every running building in view.
	 *
	 * `time` is the effect clock the particle pool already runs on, not the sim tick, so smoke
	 * keeps rising while the match is paused mid-frame rather than freezing in a column.
	 */
	tick(dt: number, time: number, ctx: Ctx, particles: SoftParticles, shroud: ShroudApi, terrain: TerrainApi | null): void {
		this.stats.live = 0
		this.stats.held = 0
		this.stats.spawned = 0
		const actors = ctx.snapshot?.actors
		if (!actors || dt <= 0) return
		const previous = time - dt
		for (let i = 0; i < actors.count; i++) {
			const emitters = this.emittersFor(actors.typeId[i], ctx)
			if (emitters === null) continue
			const flags = actors.flags[i]
			// A husk has no fires lit and a disabled machine is off at the main breaker. The
			// refinery's own anchor note asks for exactly this: hold emission when the actor
			// snapshot flag is disabled, so a powered-down plant stops smoking instead of
			// claiming to work.
			const off = (flags & (ActorFlag.disabled | ActorFlag.husk)) !== 0
			const x = actors.posX[i] * WPOS_TO_M
			const z = actors.posY[i] * WPOS_TO_M
			const base = actors.posZ[i] * WPOS_TO_M + (terrain?.heightAt(x, z) ?? 0)
			const yaw = wangleToRadians(actors.facing[i])
			const cos = Math.cos(yaw)
			const sin = Math.sin(yaw)
			const id = actors.id[i]
			for (let e = 0; e < emitters.length; e++) {
				if (off) { this.stats.held++; continue }
				this.stats.live++
				// Phase per actor AND per emitter, so a factory's two stacks alternate rather
				// than puffing as one doubled cloud.
				const phase = hash(id * 2654435761 + e * 97) * INTERVAL_S
				if (Math.floor((previous + phase) / INTERVAL_S) === Math.floor((time + phase) / INTERVAL_S)) continue
				const emitter = emitters[e]
				const ax = emitter.anchorM[0]
				const ay = emitter.anchorM[1]
				const az = emitter.anchorM[2]
				// Model space is the exported mesh's own frame. place.ts rotates it about Y by
				// wangleToRadians(facing); at a building's yaw of pi/2 that sends model +X to
				// render -Z and model +Z to render +X, which is the mapping the refinery dock
				// script derives in full.
				const wx = x + ax * cos + az * sin
				const wz = z - ax * sin + az * cos
				const wy = base + ay + emitter.axis[1] * RELEASE_M
				// A wide flue makes a wide column; a car exhaust does not.
				const scale = emitter.radiusM > 0 ? Math.min(2.4, 0.5 + emitter.radiusM * 6) : 1
				particles.spawn('stack', wx, wy, wz, time, (id * 31 + e) | 0, scale, shroud)
				this.stats.spawned++
			}
		}
	}
}
