// Broken municipal supplies: attached ballistic jets, terrain contact and shallow water films.
// Fixed pools and shared geometry; quality changes sampling, never supply pressure or timing.
import manifest from '../utility-manifest.json'
import { Mesh } from '../geo/mesh'
import type { DrawItem, RenderApi, ShroudApi, TerrainApi, UnitsApi } from './types'

interface Emitter {
	readonly positionM: readonly number[]
	readonly direction: readonly number[]
	readonly bone: number
	readonly breakRadiusM: number
	readonly jetSpeedMps: number
	readonly pressureScale: number
	readonly wetting: { readonly maximumRadiusM: number; readonly maximumReachM: number }
}
const CAP = 16, STEPS = 32, WEDGES = 20, GRAVITY = 9.81
const hash = (n: number): number => { n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); return (n ^ (n >>> 16)) >>> 0 }

/** First descending intersection with the same height field used to place buildings. */
export function waterImpact(out: Float64Array, x: number, y: number, z: number, vx: number, vy: number, vz: number,
	maxReach: number, terrain: TerrainApi): boolean {
	let previous = 0
	for (let step = 1; step <= 100; step++) {
		const t = step * .02, px = x + vx * t, pz = z + vz * t, py = y + vy * t - GRAVITY * t * t / 2
		if (Math.hypot(px - x, pz - z) > maxReach) return false
		if (py <= terrain.heightAt(px, pz)) {
			let lo = previous, hi = t
			for (let j = 0; j < 12; j++) {
				const mid = (lo + hi) / 2, mx = x + vx * mid, mz = z + vz * mid
				if (y + vy * mid - GRAVITY * mid * mid / 2 > terrain.heightAt(mx, mz)) lo = mid; else hi = mid
			}
			out[0] = x + vx * hi; out[2] = z + vz * hi; out[1] = terrain.heightAt(out[0], out[2]); out[3] = hi
			return Number.isFinite(out[1])
		}
		previous = t
	}
	return false
}

function segmentMesh(sides = 6): Mesh {
	const mesh = new Mesh(sides * 4, sides * 2)
	for (let s = 0; s < sides; s++) {
		const a = s * Math.PI * 2 / sides, b = (s + 1) * Math.PI * 2 / sides
		const p = mesh.addVertex(Math.cos(a), 0, Math.sin(a), Math.cos(a), 0, Math.sin(a), .5, .5)
		const q = mesh.addVertex(Math.cos(a), 1, Math.sin(a), Math.cos(a), 0, Math.sin(a), .5, .5005)
		const r = mesh.addVertex(Math.cos(b), 1, Math.sin(b), Math.cos(b), 0, Math.sin(b), .5005, .5005)
		const t = mesh.addVertex(Math.cos(b), 0, Math.sin(b), Math.cos(b), 0, Math.sin(b), .5005, .5)
		mesh.addQuad(p, q, r, t)

	}
	mesh.computeTangents(); return mesh
}

export class UtilityWater {
	private readonly entries = Object.entries(manifest.states)
	private readonly jets = new Float32Array(CAP * STEPS * 16)
	private readonly films = new Float32Array(CAP * WEDGES * 16)
	private jetItem: DrawItem | null = null
	private filmItem: DrawItem | null = null
	private render: RenderApi | null = null
	private terrain: TerrainApi | null = null
	private shroud: ShroudApi | null = null
	private emitter: Emitter | null = null
	private readonly hits = new Float64Array(4)
	private readonly records = new Float64Array(CAP * 12)
	private count = 0
	private samples = 12
	private splashSamples = 2
	readonly stats = { supplies: 0, segments: 0, films: 0, droplets: 0, dropped: 0 }

	init(render: RenderApi): void {
		if (manifest.schema !== 1) throw new Error('utility-water: unsupported schema')
		for (const [, state] of this.entries) for (const e of state.emitters) {
			if (e.bone !== 0 || e.kind !== 'pressurized-water' || e.positionM.length !== 3 || e.direction.length !== 3 ||
				![...e.positionM, ...e.direction, e.breakRadiusM, e.jetSpeedMps, e.pressureScale, e.wetting.maximumRadiusM, e.wetting.maximumReachM].every(Number.isFinite) ||
				Math.abs(Math.hypot(...e.direction) - 1) > .002 || e.breakRadiusM <= 0 || e.breakRadiusM > .05 ||
				e.jetSpeedMps <= 0 || e.jetSpeedMps > 5 || e.pressureScale <= 0 || e.pressureScale > 1 ||
				e.wetting.maximumRadiusM <= 0 || e.wetting.maximumRadiusM > 1 || e.wetting.maximumReachM <= 0 || e.wetting.maximumReachM > 3)
				throw new Error('utility-water: invalid attached emitter')
		}
		const triangle = new Mesh(3, 1)
		triangle.addVertex(0, 0, 0, 0, 1, 0, 0, 0)
		triangle.addVertex(1, 0, 0, 0, 1, 0, 1, 0)
		triangle.addVertex(0, 0, 1, 0, 1, 0, 0, 1)
		triangle.addTriangle(0, 2, 1); triangle.computeTangents()
		// Authored open tube rings keep every circumferential face at far LOD. No internal cap seams.
		const jetMesh = render.uploadLods ? render.uploadLods([segmentMesh(6), segmentMesh(4), segmentMesh(3)], 'fx:utility-water-jet') : render.upload(segmentMesh(), 'fx:utility-water-jet')
		this.jetItem = { mesh: jetMesh, surfaceSet: 'water', instances: this.jets,
			instanceCount: 0, playerColors: null, castsShadow: false, opacity: .62 }
		this.filmItem = { mesh: render.upload(triangle, 'fx:utility-water-film'), surfaceSet: 'water', instances: this.films,
			instanceCount: 0, playerColors: null, castsShadow: false, opacity: .32 }
	}

	clear(): void {
		this.count = 0
		this.stats.supplies = this.stats.segments = this.stats.films = this.stats.droplets = this.stats.dropped = 0
	}

	private readonly collect = (m: Float32Array, o: number, id: number): void => {
		const e = this.emitter!, p = e.positionM, d = e.direction
		const x = m[o + 12] + m[o] * p[0] + m[o + 4] * p[1] + m[o + 8] * p[2]
		const y = m[o + 13] + m[o + 1] * p[0] + m[o + 5] * p[1] + m[o + 9] * p[2]
		const z = m[o + 14] + m[o + 2] * p[0] + m[o + 6] * p[1] + m[o + 10] * p[2]
		if (!this.shroud!.isVisible(Math.floor(x), Math.floor(z))) return
		const eye = this.render!.camera.position, distance = (x - eye[0]) ** 2 + (y - eye[1]) ** 2 + (z - eye[2]) ** 2
		if (distance > 160 * 160) return
		let index = this.count
		if (index >= CAP) {
			index = 0
			for (let i = 1; i < CAP; i++) if (this.records[i * 12 + 11] > this.records[index * 12 + 11]) index = i
			this.stats.dropped++
			if (distance >= this.records[index * 12 + 11]) return
		} else this.count++
		const r = this.records, b = index * 12, seed = hash(Math.round(x * 64) ^ Math.imul(Math.round(z * 64), 73856093))
		const speed = e.jetSpeedMps * Math.sqrt(e.pressureScale) * (.88 + (seed % 1000) / 1000 * .12)
		let vx = m[o] * d[0] + m[o + 4] * d[1] + m[o + 8] * d[2]
		let vy = m[o + 1] * d[0] + m[o + 5] * d[1] + m[o + 9] * d[2]
		let vz = m[o + 2] * d[0] + m[o + 6] * d[1] + m[o + 10] * d[2]
		const length = Math.hypot(vx, vy, vz); if (length < 1e-8) { this.count--; return }
		vx *= speed / length; vy *= speed / length; vz *= speed / length
		r[b] = x; r[b + 1] = y; r[b + 2] = z; r[b + 3] = vx; r[b + 4] = vy; r[b + 5] = vz
		r[b + 6] = e.breakRadiusM; r[b + 7] = e.wetting.maximumReachM; r[b + 8] = e.wetting.maximumRadiusM
		r[b + 9] = seed; r[b + 10] = id; r[b + 11] = distance
	}

	tick(time: number, quality: string, units: UnitsApi, render: RenderApi, terrain: TerrainApi | null, shroud: ShroudApi): void {
		this.clear()
		if (!terrain || !this.jetItem || !this.filmItem || !units.visitVisibleInstances) return
		this.render = render; this.terrain = terrain; this.shroud = shroud
		this.samples = quality === 'low' ? 8 : quality === 'medium' ? 12 : quality === 'high' ? 20 : 32
		this.splashSamples = quality === 'low' ? 0 : quality === 'medium' ? 2 : quality === 'high' ? 5 : 8
		for (const [slot, state] of this.entries) for (const emitter of state.emitters) {
			this.emitter = emitter; units.visitVisibleInstances(slot, this.collect)
		}
		for (let i = 0; i < this.count; i++) this.drawSupply(i, time)
		;(this.jetItem as { instanceCount: number }).instanceCount = this.stats.segments
		;(this.filmItem as { instanceCount: number }).instanceCount = this.stats.films
		if (this.stats.segments) render.submit(this.jetItem)
		if (this.stats.films) render.submit(this.filmItem)
	}

	private drawSupply(index: number, time: number): void {
		const b = index * 12, r = this.records, x = r[b], y = r[b + 1], z = r[b + 2], vx = r[b + 3], vy = r[b + 4], vz = r[b + 5]
		if (!waterImpact(this.hits, x, y, z, vx, vy, vz, r[b + 7], this.terrain!)) return
		const hit = this.hits, total = hit[3]
		this.stats.supplies++
		let px = x, py = y, pz = z
		for (let s = 1; s <= this.samples; s++) {
			const t = s / this.samples * total, nx = x + vx * t, ny = y + vy * t - GRAVITY * t * t / 2, nz = z + vz * t
			if (this.shroud!.isVisible(Math.floor(nx), Math.floor(nz))) {
				const o = this.stats.segments++ * 16, m = this.jets, dx = nx - px, dy = ny - py, dz = nz - pz
				const len = Math.hypot(dx, dy, dz), horizontal = Math.hypot(dx, dz)
				const ax = horizontal > 1e-8 ? dz / horizontal : 1, az = horizontal > 1e-8 ? -dx / horizontal : 0
				const radius = r[b + 6] * (.76 + .025 * Math.sin(time * 13 - t * 18 + r[b + 9]))
				m[o] = ax * radius; m[o + 1] = 0; m[o + 2] = az * radius; m[o + 3] = 0
				const overlap = 1 + Math.min(.15, radius * .2 / len)
				m[o + 4] = dx * overlap; m[o + 5] = dy * overlap; m[o + 6] = dz * overlap; m[o + 7] = 0
				m[o + 8] = -dy * az / len * radius; m[o + 9] = (dx * az - dz * ax) / len * radius; m[o + 10] = dy * ax / len * radius; m[o + 11] = 0
				m[o + 12] = px; m[o + 13] = py; m[o + 14] = pz; m[o + 15] = 1
			}
			px = nx; py = ny; pz = nz
		}
		if (!this.shroud!.isVisible(Math.floor(hit[0]), Math.floor(hit[2]))) return
		const radius = r[b + 8] * .8
		for (let s = 0; s < WEDGES; s++) {
			const a = s / WEDGES * Math.PI * 2, a1 = (s + 1) / WEDGES * Math.PI * 2
			const ra = radius * (.84 + .12 * Math.sin(a * 3 + r[b + 9])), rb = radius * (.84 + .12 * Math.sin(a1 * 3 + r[b + 9]))
			const ax = hit[0] + Math.cos(a) * ra, az = hit[2] + Math.sin(a) * ra
			const bx = hit[0] + Math.cos(a1) * rb, bz = hit[2] + Math.sin(a1) * rb
			if (!this.shroud!.isVisible(Math.floor(ax), Math.floor(az)) || !this.shroud!.isVisible(Math.floor(bx), Math.floor(bz))) continue
			const ay = this.terrain!.heightAt(ax, az), by = this.terrain!.heightAt(bx, bz)
			// A film follows gentle ground only. Steep banks shed the jet, not a hovering disk.
			if (Math.max(Math.abs(ay - hit[1]), Math.abs(by - hit[1])) > radius * .3) continue
			const o = this.stats.films++ * 16, m = this.films
			m[o] = ax - hit[0]; m[o + 1] = ay - hit[1]; m[o + 2] = az - hit[2]; m[o + 3] = 0
			m[o + 4] = 0; m[o + 5] = 1; m[o + 6] = 0; m[o + 7] = 0
			m[o + 8] = bx - hit[0]; m[o + 9] = by - hit[1]; m[o + 10] = bz - hit[2]; m[o + 11] = 0
			m[o + 12] = hit[0]; m[o + 13] = hit[1] + .0015; m[o + 14] = hit[2]; m[o + 15] = 1
		}
		for (let s = 0; s < this.splashSamples; s++) {
			const phase = ((time * 2.3 + s / this.splashSamples + (r[b + 9] % 97) / 97) % 1 + 1) % 1
			const a = s * 2.4 + r[b + 9], dx = Math.cos(a) * phase * .14, dz = Math.sin(a) * phase * .14
			this.render!.addParticle?.(hit[0] + dx, hit[1] + .012 + Math.sin(phase * Math.PI) * .07, hit[2] + dz,
				.008, .34, .40, .43, .35 * (1 - phase), phase, s, 0)
			this.stats.droplets++
		}
	}
}
