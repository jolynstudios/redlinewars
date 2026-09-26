// Ultra: a helicopter low over the ground blows up what lies there (vfx.md Epic 6, HELI and TRAN:
// "surface-aware cosmetic downwash"). Cosmetic only: it reads the drawn placement, never moves a
// grain of the simulation, and stands down under fog, for a husk and for a cloaked actor.
//
// Below DOWNWASH_M of clearance the rotor throws a ring of the surface outward from under the hull:
// dust off earth, sand off sand, powder off snow, spray and mist off water. The closer to the
// ground, the denser the ring; the decorative density (fx/vfx-budget, the Ultra governor) scales it.
import { ActorFlag, findActorIndex, type Ctx } from '../core'
import { Surface } from '../core/surface'
import type { ShroudApi, TerrainApi, UnitsApi } from './types'
import type { SoftParticles } from './particles'

/** The rotorcraft of the roster, by their drawn slot. */
const ROTORCRAFT = ['heli', 'hind', 'mh60', 'tran'] as const
/** Clearance under which the rotor reaches the ground, in metres. */
export const DOWNWASH_M = 3
/** Seconds between two rings under one helicopter. */
const RING_S = 0.12
/** Helicopters that may blow a ring in one frame. */
const MAX_PER_FRAME = 8

export interface RotorDownwashStats { rotorcraft: number; washing: number; spawned: number }

export class RotorDownwash {
	readonly stats: RotorDownwashStats = { rotorcraft: 0, washing: 0, spawned: 0 }
	private readonly lastRing = new Map<number, number>()
	private ctx: Ctx | null = null
	private shroud: ShroudApi | null = null
	private terrain: TerrainApi | null = null
	private particles: SoftParticles | null = null
	private time = 0
	private density = 1

	private readonly visit = (m: Float32Array, o: number, id: number): void => {
		const a = this.ctx?.snapshot?.actors
		if (!a || !this.terrain) return
		const i = findActorIndex(a, id)
		if (i < 0 || a.health[i] === 0 || (a.flags[i] & (ActorFlag.husk | ActorFlag.cloaked)) !== 0) return
		this.stats.rotorcraft++
		const x = m[o + 12], y = m[o + 13], z = m[o + 14]
		if (!this.shroud!.isVisible(Math.floor(x), Math.floor(z))) return
		const water = this.terrain.waterHeightAt?.(x, z) ?? null
		const ground = water ?? this.terrain.heightAt(x, z)
		const clearance = y - ground
		if (clearance < 0.15 || clearance > DOWNWASH_M) return
		this.stats.washing++
		if (this.stats.washing > MAX_PER_FRAME) return
		const last = this.lastRing.get(id) ?? -Infinity
		if (this.time - last < RING_S && this.time >= last) return
		this.lastRing.set(id, this.time)
		const strength = 1 - clearance / DOWNWASH_M
		const surface = water !== null ? Surface.water : this.terrain.surfaceAt?.(x, z) ?? Surface.soil
		const preset = surface === Surface.water || surface === Surface.shallow ? 'watermist'
			: surface === Surface.snow ? 'hazesnow' : surface === Surface.sand ? 'hazesand'
			: surface === Surface.rock || surface === Surface.concrete || surface === Surface.road ? 'hazerock' : 'dustskirt'
		const n = Math.max(2, Math.round(6 * strength * this.density))
		const seed = (id * 2654435761 + Math.floor(this.time * 25)) | 0
		for (let k = 0; k < n; k++) {
			const angle = (k + ((seed >>> (k % 24)) & 7) / 8) / n * Math.PI * 2
			const c = Math.cos(angle), s = Math.sin(angle), r = 0.7 + 0.3 * strength
			this.particles!.spawn(preset, x + c * r, ground + 0.05, z + s * r, this.time, seed + k * 97, 0.6 + 0.5 * strength, this.shroud!, 1, c, 0.08, s, 0.35)
			this.stats.spawned++
		}
		if (surface === Surface.water && strength > 0.5) {
			this.particles!.spawn('foam', x, ground + 0.02, z, this.time, seed + 7, 0.8, this.shroud!)
			this.stats.spawned++
		}
	}

	tick(time: number, density: number, ctx: Ctx, particles: SoftParticles, shroud: ShroudApi, terrain: TerrainApi | null): void {
		this.stats.rotorcraft = this.stats.washing = this.stats.spawned = 0
		if (time < this.time) this.lastRing.clear()
		this.time = time
		this.density = density
		this.ctx = ctx
		this.shroud = shroud
		this.terrain = terrain
		this.particles = particles
		const units = ctx.get<UnitsApi>('units')
		for (const slot of ROTORCRAFT) units.visitVisibleInstances?.(slot, this.visit)
		if (this.lastRing.size > 64) this.lastRing.clear()
	}

	clear(): void { this.lastRing.clear() }
}
