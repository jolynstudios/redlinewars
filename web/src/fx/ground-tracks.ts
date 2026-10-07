// Vehicle contact imprints: authored fitted geometry, differential travel and soft-ground response.
// One bounded instance pool; no particle emission or per-frame allocation.
import { Mesh } from '../geo/mesh'
import { markGroundMarkCoverage } from '../geo/mark-coverage'
import { ActorFlag, HeaderFlag, Surface, findActorIndex, lerpFacing, wangleToRadians, type Ctx } from '../core'
import { placeActor } from '../core/place'
import type { DrawItem, GpuMesh, RenderApi, ShroudApi, TerrainApi } from './types'

interface Contact {
	readonly kind: 'tracked' | 'wheeled'
	readonly leftZ: number
	readonly rightZ: number
	readonly width: number
	readonly pitch: number
	/** Explicitly authored relative visual contact load; not engine mass. */
	readonly visualLoad: number
}
interface UnitsApi { runningGearOf(name: string): Contact | null }
interface AnimApi { sideDistanceOf(id: number, lateralM: number, alpha: number): number }
interface WeatherApi { readonly environment: { readonly snowCoverage?: number; readonly surfaceWetness?: number; readonly wetness?: number } }
const LIFE_S = 10
const MAX_STEP_M = 3.2, STAMPS_PER_SIDE = 3, BANDS = 6, DEFAULT_CAP = 2048
/** Per-frame stamp budget shared by every moving unit, plus the camera cull radius. */
const MAX_STAMPS_PER_FRAME = 24, TRACK_CULL_M = 60
const TABLE = 4096, TABLE_MASK = TABLE - 1
const TRACKED = 0, WHEELED = 1
const MATERIALS = ['soil', 'sand', 'snow'] as const
const GROUPS = 6 // two contact shapes x three ground materials
// All thirteen surfaces are intentional: hard surfaces, open water and resources take no rut.
const SOFTNESS = [0.65, 0, 0.85, 0.3, 0.55, 0, 0, 0, 0, 0.5, 1, 0.65, 0] as const

function hash(value: number): number {
	let x = value | 0
	x ^= x << 13
	x ^= x >>> 17
	x ^= x << 5
	return ((x >>> 0) % 1000) / 1000
}

/** Normalised shallow imprint; dimensions/depth are fitted per vehicle and soil at birth. */
function buildMark(tracked: boolean): Mesh {
	const mesh = new Mesh(40, 20)
	const quad = (x0: number, x1: number, z0: number, z1: number, y: number): void => {
		const a = mesh.addVertex(x0, y, z0, 0, 1, 0, x0, z0)
		const b = mesh.addVertex(x0, y, z1, 0, 1, 0, x0, z1)
		const c = mesh.addVertex(x1, y, z1, 0, 1, 0, x1, z1)
		const d = mesh.addVertex(x1, y, z0, 0, 1, 0, x1, z0)
		mesh.addQuad(a, b, c, d)
	}
	quad(-.5, .5, -.5, .5, 0)
	if (tracked) {
		// Low ridges of displaced ground between compressed tread impressions.
		for (let i = 0; i < 5; i++) quad(-.48 + i * .2, -.44 + i * .2, -.48, .48, .5)
	} else {
		quad(-.5, .5, -.5, -.4, .4)
		quad(-.5, .5, .4, .5, .4)
	}
	mesh.computeTangents()
	// Fade the stamp rim in the translucent pass, or each stamp is a hard square plate.
	markGroundMarkCoverage(mesh)
	return mesh
}
export class GroundTracks {
	private readonly meshes: (GpuMesh | null)[] = [null, null]
	private readonly items: DrawItem[][] = Array.from({ length: GROUPS }, () => [])
	private readonly bandInstances: Float32Array[][] = Array.from({ length: GROUPS }, () => [])
	private readonly counts = Array.from({ length: GROUPS }, () => new Int32Array(BANDS))
	private cap = DEFAULT_CAP
	private readonly born = new Float64Array(DEFAULT_CAP)
	private readonly x = new Float32Array(DEFAULT_CAP)
	private readonly z = new Float32Array(DEFAULT_CAP)
	private readonly yaw = new Float32Array(DEFAULT_CAP)
	private readonly kind = new Uint8Array(DEFAULT_CAP)
	private readonly group = new Uint8Array(DEFAULT_CAP)
	private readonly width = new Float32Array(DEFAULT_CAP)
	private readonly length = new Float32Array(DEFAULT_CAP)
	private readonly depth = new Float32Array(DEFAULT_CAP)
	private readonly life = new Float32Array(DEFAULT_CAP)
	private readonly active = new Uint8Array(DEFAULT_CAP)
	private cursor = 0
	private lastTime = Number.NaN
	private terrain: TerrainApi | null = null
	private readonly heightAt = (x: number, z: number): number => this.terrain!.heightAt(x, z)
	private readonly seenId = new Int32Array(TABLE).fill(-1)
	private readonly seenType = new Uint16Array(TABLE)
	private readonly seenDist = new Float64Array(TABLE * 2)
	private readonly seenX = new Float32Array(TABLE * 2)
	private readonly seenZ = new Float32Array(TABLE * 2)
	private readonly profileByType = new Map<number, Contact | null>()
	readonly stats = { active: 0, stamped: 0, dropped: 0, submitted: 0, instanceBytes: 0 }

	init(render: RenderApi, cap: number): void {
		this.cap = Math.max(0, Math.min(DEFAULT_CAP, cap | 0))
		this.meshes[TRACKED] = render.upload(buildMark(true), 'fx:ground-track')
		this.meshes[WHEELED] = render.upload(buildMark(false), 'fx:ground-tyremark')
		this.stats.instanceBytes = 0
		for (let g = 0; g < GROUPS; g++) {
			this.items[g].length = this.bandInstances[g].length = 0
			const kind = Math.floor(g / MATERIALS.length)
			for (let b = 0; b < BANDS; b++) {
				const instances = new Float32Array(this.cap * 16)
				this.stats.instanceBytes += instances.byteLength
				this.bandInstances[g].push(instances)
				this.items[g].push({ mesh: this.meshes[kind]!, surfaceSet: MATERIALS[g % 3],
					instances, instanceCount: 0, playerColors: null, castsShadow: false,
					opacity: .62 * (1 - (b + .35) / BANDS) })
			}
		}
	}

	clear(): void {
		this.active.fill(0); this.seenId.fill(-1); this.profileByType.clear()
		for (const count of this.counts) count.fill(0)
		this.cursor = 0; this.lastTime = Number.NaN
		this.stats.active = this.stats.submitted = 0
	}

	tick(time: number, ctx: Ctx, render: RenderApi, terrain: TerrainApi | null, shroud: ShroudApi): void {
		this.stats.active = this.stats.submitted = 0
		// Reset every group, even when no marks survive this frame.
		for (const count of this.counts) count.fill(0)
		if (!this.meshes[0] || !terrain || this.cap === 0) return
		this.terrain = terrain
		if (time < this.lastTime - .08) this.clear()
		for (let i = 0; i < this.cap; i++) if (this.active[i] && time - this.born[i] >= this.life[i]) this.active[i] = 0
		const actors = ctx.snapshot?.actors, anim = ctx.peek<AnimApi>('anim')
		if (actors && anim && (!Number.isFinite(this.lastTime) || time > this.lastTime) && ((ctx.snapshot?.flags ?? 0) & HeaderFlag.paused) === 0)
			this.stampMoving(time, ctx, actors, anim, terrain, shroud, render.camera.position[0], render.camera.position[2])
		this.lastTime = Number.isFinite(this.lastTime) ? Math.max(time, this.lastTime) : time
		for (let i = 0; i < this.cap; i++) {
			if (!this.active[i]) continue
			const age = Math.max(0, time - this.born[i])
			if (age >= this.life[i]) { this.active[i] = 0; continue }
			if (!shroud.isVisible(Math.floor(this.x[i]), Math.floor(this.z[i]))) continue
			const band = Math.min(BANDS - 1, Math.floor(age / this.life[i] * BANDS)), group = this.group[i]
			const slot = this.counts[group][band]++
			this.writeInstance(this.bandInstances[group][band], slot, i)
			this.stats.active++
		}
		for (let g = 0; g < GROUPS; g++) for (let b = 0; b < BANDS; b++) {
			const count = this.counts[g][b], item = this.items[g][b] as { instanceCount: number }
			item.instanceCount = count
			if (count) { render.submit(this.items[g][b]); this.stats.submitted += count }
		}
	}

	private stampMoving(time: number, ctx: Ctx, actors: NonNullable<NonNullable<Ctx['snapshot']>['actors']>, anim: AnimApi, terrain: TerrainApi, shroud: ShroudApi, camX: number, camZ: number): void {
		const units = ctx.peek<UnitsApi>('units')
		if (!units) return
		const weather = ctx.peek<WeatherApi>('sky')?.environment
		const wet = Math.max(0, Math.min(1, weather?.surfaceWetness ?? weather?.wetness ?? 0))
		const snow = Math.max(0, Math.min(1, weather?.snowCoverage ?? 0))
		const before = ctx.prevSnapshot?.actors
		const alpha = before ? Math.max(0, Math.min(1, ctx.time.alpha)) : 1
		// Stamp budget and camera cull: a fighting 1v1 measured this loop at 26 ms of a
		// 34 ms frame — every moving unit stamped up to STAMPS_PER_SIDE marks per side per
		// tick, and the cap (448 at LOW) evicted as fast as it filled. Marks beyond the
		// cull radius are unreadable at gameplay zoom anyway; the budget rate-limits the
		// rest. Seen-state still advances every tick, so no deferred burst on resume.
		let stamps = 0
		const cull2 = TRACK_CULL_M * TRACK_CULL_M
		for (let i = 0; i < actors.count; i++) {
			const flags = actors.flags[i]
			if ((flags & (ActorFlag.husk | ActorFlag.cloaked | ActorFlag.submerged | ActorFlag.parachuting)) !== 0) continue
			const ax = actors.posX[i] / 1024 - camX, az = actors.posY[i] / 1024 - camZ
			if (ax * ax + az * az > cull2) continue
			const type = actors.typeId[i]
			let contact = this.profileByType.get(type)
			if (contact === undefined) { contact = units.runningGearOf(ctx.actorTypeName(type).toLowerCase()); this.profileByType.set(type, contact) }
			if (!contact) continue
			const id = actors.id[i], j = before ? findActorIndex(before, id) : -1
			const x = (j >= 0 ? before!.posX[j] + (actors.posX[i] - before!.posX[j]) * alpha : actors.posX[i]) / 1024
			const z = (j >= 0 ? before!.posY[j] + (actors.posY[i] - before!.posY[j]) * alpha : actors.posY[i]) / 1024
			const facing = j >= 0 ? lerpFacing(before!.facing[j], actors.facing[i], alpha) : actors.facing[i]
			const yaw = wangleToRadians(facing), sin = Math.sin(yaw), cos = Math.cos(yaw)
			const slot = this.touchSeen(id), fresh = this.seenType[slot] !== type
			this.seenType[slot] = type
			const pitch = Math.max(.04, contact.pitch)
			for (let side = 0; side < 2; side++) {
				const lat = side === 0 ? contact.leftZ : contact.rightZ, at = slot * 2 + side
				const px = x + sin * lat, pz = z + cos * lat
				const dist = anim.sideDistanceOf(id, lat, alpha)
				const ground = terrain.surfaceAt?.(px, pz) ?? actors.surface[i]
				const baseSoft = SOFTNESS[ground] ?? 0
				// The ground shader coats upward-facing hard land with accumulated snow too.
				// Sampling the underlying rock/road/concrete cell alone would leave a clear
				// gap in a tire trail across ground that visibly has a snow cover.
				const snowLand = ground !== Surface.water && ground !== Surface.shallow && ground !== Surface.resource
				const covered = ground === Surface.snow || (snow >= .5 && snowLand)
				const soft = covered ? 1 : Math.min(1, baseSoft * (1 + wet * .5))
				const travel = dist - this.seenDist[at], moved = Math.hypot(px - this.seenX[at], pz - this.seenZ[at])
				const reset = fresh || !Number.isFinite(this.seenDist[at]) || !soft || !shroud.isVisible(Math.floor(px), Math.floor(pz)) || moved > MAX_STEP_M || Math.abs(travel) > MAX_STEP_M
				if (reset) { this.seenDist[at] = dist; this.seenX[at] = px; this.seenZ[at] = pz; continue }
				if (Math.abs(travel) < pitch) continue
				const steps = Math.min(STAMPS_PER_SIDE, MAX_STAMPS_PER_FRAME - stamps, Math.floor(Math.abs(travel) / pitch))
				const kind = contact.kind === 'tracked' ? TRACKED : WHEELED
				const material = covered ? 2 : ground === Surface.sand ? 1 : 0
				const width = contact.width * (1 + soft * contact.visualLoad * .12)
				const depth = .001 + soft * contact.visualLoad * .007
				const life = Math.min(LIFE_S, 5 + soft * 3 + contact.visualLoad * 2)
				for (let s = 1; s <= steps; s++) {
					const t = s / steps
					this.push(this.seenX[at] + (px - this.seenX[at]) * t, this.seenZ[at] + (pz - this.seenZ[at]) * t,
						yaw, kind, kind * 3 + material, width, pitch * .94, depth, life, time)
				}
				stamps += steps
				this.seenDist[at] = dist; this.seenX[at] = px; this.seenZ[at] = pz
			}
		}
	}

	private push(x: number, z: number, yaw: number, kind: number, group: number, width: number, length: number, depth: number, life: number, time: number): void {
		const i = this.cursor
		if (this.active[i]) this.stats.dropped++
		this.cursor = (i + 1) % this.cap
		this.active[i] = 1; this.born[i] = time; this.x[i] = x; this.z[i] = z; this.yaw[i] = yaw
		this.kind[i] = kind; this.group[i] = group; this.width[i] = width; this.length[i] = length; this.depth[i] = depth; this.life[i] = life
		this.stats.stamped++
	}

	private writeInstance(out: Float32Array, slot: number, i: number): void {
		const o = slot * 16, length = this.length[i], width = this.width[i]
		placeActor(out, o, this.x[i], this.z[i], this.yaw[i], Math.max(.01, length * .5), Math.max(.01, width * .5), false, 0, this.heightAt)
		out[o + 13] += .0015
		for (let k = 0; k < 3; k++) { out[o + k] *= length; out[o + 4 + k] *= this.depth[i]; out[o + 8 + k] *= width }
	}

	private touchSeen(id: number): number {
		const slot = Math.imul(id, 2654435761) >>> 0 & TABLE_MASK
		for (let n = 0; n < 8; n++) {
			const s = (slot + n) & TABLE_MASK
			if (this.seenId[s] === id) return s
			if (this.seenId[s] < 0) { this.resetSeen(s, id); return s }
		}
		this.resetSeen(slot, id)
		return slot
	}
	private resetSeen(slot: number, id: number): void {
		this.seenId[slot] = id; this.seenType[slot] = 0xffff
		this.seenDist[slot * 2] = this.seenDist[slot * 2 + 1] = Number.NaN
	}
}
