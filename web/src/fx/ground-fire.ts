// STEELSEED — fx/ground-fire
//
// Finite fires on wrecks, grass and trees. The human contract is: parts that land on
// grass or trees can catch, and the fire ALWAYS goes out. No weather persistence, no
// map-wide chain, at most one hop to a neighbour, then stop.

import { Surface, type Ctx } from '../core'
import type { ShroudApi, TerrainApi } from './types'
import type { SoftParticles } from './particles'

const MAX = 24
const WRECK = 0, GRASS = 1, TREE = 2
const LIFE = Float32Array.of(8.0, 6.0, 16.0)
const INTERVAL_S = 0.22
const HOP_AT = 0.4
const HOP_RADIUS_M = 2.2

function hash(value: number): number {
	let x = value | 0
	x ^= x << 13
	x ^= x >>> 17
	x ^= x << 5
	return ((x >>> 0) % 1000) / 1000
}

export class GroundFire {
	private readonly active = new Uint8Array(MAX)
	private readonly kind = new Uint8Array(MAX)
	private readonly hopped = new Uint8Array(MAX)
	private readonly x = new Float32Array(MAX)
	private readonly y = new Float32Array(MAX)
	private readonly z = new Float32Array(MAX)
	private readonly born = new Float32Array(MAX)
	private readonly life = new Float32Array(MAX)
	readonly stats = { active: 0, ignited: 0, extinguished: 0, hops: 0, refused: 0 }

	clear(): void { this.active.fill(0) }

	/**
	 * Light a wreck fire at `x,y,z` and, if the blast overlaps grass or a tree, those too.
	 * Returns false only when the wreck slot itself could not be taken.
	 */
	igniteBlast(
		x: number, y: number, z: number, time: number, radiusM: number,
		ctx: Ctx, terrain: TerrainApi | null, shroud: ShroudApi,
	): boolean {
		if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(time)) return false
		if (!shroud.isVisible(Math.floor(x), Math.floor(z))) return false
		const wreck = this.spawn(WRECK, x, y, z, time, 0)
		if (wreck < 0) { this.stats.refused++; return false }
		if (terrain && radiusM > 0) this.igniteGround(x, y, z, time, radiusM, terrain, shroud)
		this.igniteTrees(x, y, z, time, radiusM, ctx, shroud)
		return true
	}

	/**
	 * A flame's contact fire (vfx.md E4, "contact fire and cooling smoke"): a short fire where a
	 * flame packet lands, which cools to smoke and goes out on the grass fire's own clock. It may
	 * hop once to neighbouring grass, like every fire here, and never further.
	 */
	igniteContact(x: number, y: number, z: number, time: number, shroud: ShroudApi): boolean {
		if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(time)) return false
		if (!shroud.isVisible(Math.floor(x), Math.floor(z))) return false
		return this.spawn(GRASS, x, y, z, time, 0) >= 0
	}

	tick(dt: number, time: number, particles: SoftParticles, shroud: ShroudApi, terrain: TerrainApi | null, ctx: Ctx): void {
		this.stats.active = 0
		if (dt <= 0) return
		for (let i = 0; i < MAX; i++) {
			if (!this.active[i]) continue
			const age = time - this.born[i]
			// `born` is float32 and a blast ignites before this tick in the same frame, so a fresh
			// fire's age can round a few 1e-7 below zero; only a real rewind is seconds.
			if (age < -1e-3 || age >= this.life[i]) {
				this.active[i] = 0
				this.stats.extinguished++
				continue
			}
			if (!shroud.isVisible(Math.floor(this.x[i]), Math.floor(this.z[i]))) continue
			this.stats.active++
			const remain = 1 - age / this.life[i]
			const phase = hash((i + 1) * 997) * INTERVAL_S
			if (Math.floor((time - dt + phase) / INTERVAL_S) !== Math.floor((time + phase) / INTERVAL_S)) {
				const scale = (0.45 + 0.55 * remain) * (this.kind[i] === TREE ? 1.15 : this.kind[i] === WRECK ? 0.9 : 0.55)
				particles.spawn('stemfire', this.x[i], this.y[i] + 0.04, this.z[i], time, (i * 31 + 11) | 0, scale, shroud)
				particles.spawn('ruinsmoke', this.x[i], this.y[i] + 0.10, this.z[i], time, (i * 31 + 7) | 0, scale * 1.1, shroud)
			}
			if (!this.hopped[i] && age >= this.life[i] * HOP_AT && this.kind[i] !== WRECK) {
				this.hopped[i] = 1
				this.tryHop(i, time, ctx, terrain, shroud)
			}
		}
	}

	private spawn(kind: number, x: number, y: number, z: number, time: number, hopped: number): number {
		for (let i = 0; i < MAX; i++) {
			if (this.active[i] && Math.hypot(this.x[i] - x, this.z[i] - z) < 0.55) return i
		}
		let slot = -1
		for (let i = 0; i < MAX; i++) if (!this.active[i]) { slot = i; break }
		if (slot < 0) return -1
		this.active[slot] = 1
		this.kind[slot] = kind
		this.hopped[slot] = hopped
		this.x[slot] = x
		this.y[slot] = y
		this.z[slot] = z
		this.born[slot] = time
		this.life[slot] = LIFE[kind] * (0.85 + 0.3 * hash((kind + 1) * 2654435761 + (x * 1000 | 0)))
		this.stats.ignited++
		return slot
	}

	private igniteGround(x: number, y: number, z: number, time: number, radiusM: number, terrain: TerrainApi, shroud: ShroudApi): void {
		const r = Math.min(3, Math.max(1, Math.ceil(radiusM)))
		let lit = 0
		for (let dz = -r; dz <= r && lit < 3; dz++) for (let dx = -r; dx <= r && lit < 3; dx++) {
			if (dx === 0 && dz === 0) continue
			const gx = x + dx, gz = z + dz
			if (dx * dx + dz * dz > radiusM * radiusM) continue
			if (!shroud.isVisible(Math.floor(gx), Math.floor(gz))) continue
			if (terrain.surfaceAt?.(gx, gz) !== Surface.grass) continue
			const gy = (terrain.heightAt(gx, gz) ?? y)
			if (this.spawn(GRASS, gx, gy, gz, time, 0) >= 0) lit++
		}
	}

	private igniteTrees(x: number, y: number, z: number, time: number, radiusM: number, ctx: Ctx, shroud: ShroudApi): void {
		const actors = ctx.snapshot?.actors ?? ctx.prevSnapshot?.actors
		if (!actors || radiusM <= 0) return
		const reach = Math.max(1.4, radiusM)
		let lit = 0
		for (let i = 0; i < actors.count && lit < 2; i++) {
			const ax = actors.posX[i] / 1024
			const az = actors.posY[i] / 1024
			if (!Number.isFinite(ax) || Math.hypot(ax - x, az - z) > reach) continue
			const name = ctx.actorTypeName(actors.typeId[i])
			if (!isTreeName(name)) continue
			if (!shroud.isVisible(Math.floor(ax), Math.floor(az))) continue
			if (this.spawn(TREE, ax, y + 0.45, az, time, 0) >= 0) lit++
		}
	}

	private tryHop(i: number, time: number, ctx: Ctx, terrain: TerrainApi | null, shroud: ShroudApi): void {
		this.stats.hops++
		if (this.kind[i] === GRASS && terrain) {
			this.igniteGround(this.x[i], this.y[i], this.z[i], time, HOP_RADIUS_M, terrain, shroud)
			return
		}
		if (this.kind[i] === TREE) this.igniteTrees(this.x[i], this.y[i], this.z[i], time, HOP_RADIUS_M, ctx, shroud)
	}
}

function isTreeName(name: string): boolean {
	const id = name.toLowerCase()
	if (id.includes('husk')) return false
	return /^(t\d+|tc\d+)/.test(id)
}
