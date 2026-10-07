// STEELSEED — fx/impact-scorch (vfx.md Epic 5, Ultra and Ultra+ only)
//
// The mark an explosive strike leaves on open ground: a dark, soft-edged scorch that fades over
// tens of seconds, so a firefight leaves its ground marked instead of wiping clean when the dust
// settles. Pure presentation. It has no navigation or damage meaning, it is bounded, and it is
// culled by the shroud like every other mark. Water and metal hits leave none.
//
// Drawn the way fx/ground-tracks draws tread marks: one flat unit quad with a soft coverage rim
// (geo/mark-coverage), fitted to the drawn terrain by core/place (a rigid tilted plane, at most
// 20 degrees), in the translucent pass. Opacity is per draw item, not per instance, so age is
// expressed as fade bands. The material is the near-black `ash` set.
import { Mesh } from '../geo/mesh'
import { markGroundMarkCoverage } from '../geo/mark-coverage'
import { placeActor } from '../core/place'
import type { DrawItem, GpuMesh, RenderApi, ShroudApi, TerrainApi } from './types'

/** Storage for the largest tier; the live cap comes from fx/vfx-budget `scorchCapacity`. */
const MAX_CAP = 512
/** Cosmetic aftermath life (vfx.md lists 10-40 s for wreck and impact aftermath). */
const LIFE_S = 24
const BANDS = 5
/** Peak opacity of a fresh scorch; each older band is fainter. */
const PEAK_OPACITY = 0.5
/** A nuclear strike's burnt ground is darker: it has to read for tens of seconds after the cloud. */
const STRONG_OPACITY = 0.85

function hash(value: number): number {
	let x = value | 0
	x ^= x << 13
	x ^= x >>> 17
	x ^= x << 5
	return ((x >>> 0) % 1000) / 1000
}

function buildScorch(): Mesh {
	const mesh = new Mesh(4, 2)
	const a = mesh.addVertex(-.5, 0, -.5, 0, 1, 0, -.5, -.5)
	const b = mesh.addVertex(-.5, 0, .5, 0, 1, 0, -.5, .5)
	const c = mesh.addVertex(.5, 0, .5, 0, 1, 0, .5, .5)
	const d = mesh.addVertex(.5, 0, -.5, 0, 1, 0, .5, -.5)
	mesh.addQuad(a, b, c, d)
	mesh.computeTangents()
	// The soft rim is what keeps a scorch from reading as a black tile.
	markGroundMarkCoverage(mesh)
	return mesh
}

export class ImpactScorch {
	private mesh: GpuMesh | null = null
	private readonly items: DrawItem[] = []
	private readonly instances: Float32Array[] = []
	private readonly counts = new Int32Array(BANDS * 2)
	private cap = 0
	private readonly born = new Float64Array(MAX_CAP)
	private readonly x = new Float32Array(MAX_CAP)
	private readonly z = new Float32Array(MAX_CAP)
	private readonly yaw = new Float32Array(MAX_CAP)
	private readonly size = new Float32Array(MAX_CAP)
	private readonly life = new Float32Array(MAX_CAP)
	private readonly active = new Uint8Array(MAX_CAP)
	private readonly strong = new Uint8Array(MAX_CAP)
	private cursor = 0
	private terrain: TerrainApi | null = null
	private readonly heightAt = (x: number, z: number): number => this.terrain!.heightAt(x, z)
	readonly stats = { active: 0, stamped: 0, submitted: 0 }

	init(render: RenderApi): void {
		this.mesh = render.upload(buildScorch(), 'fx:impact-scorch')
		this.items.length = this.instances.length = 0
		// Bands 0..BANDS-1 are ordinary marks, BANDS..2*BANDS-1 the stronger nuclear ones.
		for (let b = 0; b < BANDS * 2; b++) {
			const instances = new Float32Array(MAX_CAP * 16)
			this.instances.push(instances)
			this.items.push({ mesh: this.mesh, surfaceSet: 'ash', instances, instanceCount: 0, playerColors: null,
				castsShadow: false, opacity: (b < BANDS ? PEAK_OPACITY : STRONG_OPACITY) * (1 - (b % BANDS) / BANDS) })
		}
	}

	/** The tier's live cap (fx/vfx-budget). Zero stops stamping and drawing. */
	configure(cap: number): void {
		this.cap = Math.max(0, Math.min(MAX_CAP, cap | 0))
		if (this.cap === 0) this.clear()
		else if (this.cursor >= this.cap) this.cursor = 0
	}

	clear(): void {
		this.active.fill(0)
		this.counts.fill(0)
		this.cursor = 0
		this.stats.active = this.stats.submitted = 0
	}

	/**
	 * One scorch of `sizeM` metres at a strike, fading over `lifeS` (a nuclear strike keeps its
	 * burnt ground longer). The oldest is overwritten when the ring is full.
	 */
	stamp(x: number, z: number, sizeM: number, seed: number, time: number, shroud: ShroudApi, lifeS = LIFE_S, strong = false): void {
		if (this.cap === 0 || !shroud.isVisible(Math.floor(x), Math.floor(z))) return
		const i = this.cursor
		this.cursor = (this.cursor + 1) % this.cap
		this.born[i] = time; this.x[i] = x; this.z[i] = z
		this.yaw[i] = hash(seed) * Math.PI * 2
		this.size[i] = sizeM * (0.85 + hash(seed + 17) * 0.3)
		this.life[i] = lifeS > 0 ? lifeS : LIFE_S
		this.strong[i] = strong ? 1 : 0
		this.active[i] = 1
		this.stats.stamped++
	}

	/**
	 * The live marks within `reach` of (cx, cz), as (x, z, radius, strength) quads, for the
	 * scenery scan: grass burns away under a scorch and grows back as the mark fades, so the mark
	 * is not hidden under a knee-high meadow. Strength is 1 when fresh, 0 at the end of its life.
	 */
	gather(time: number, cx: number, cz: number, reach: number, out: Float32Array): number {
		const max = out.length >> 2
		let n = 0
		for (let i = 0; i < this.cap && n < max; i++) {
			if (!this.active[i]) continue
			const age = time - this.born[i]
			if (age < 0 || age >= this.life[i]) continue
			const r = this.size[i] * 0.5, dx = this.x[i] - cx, dz = this.z[i] - cz
			if (dx * dx + dz * dz > (reach + r) * (reach + r)) continue
			const o = n++ * 4
			out[o] = this.x[i]; out[o + 1] = this.z[i]; out[o + 2] = r; out[o + 3] = 1 - age / this.life[i]
		}
		return n
	}

	tick(time: number, render: RenderApi, terrain: TerrainApi | null, shroud: ShroudApi): void {
		this.counts.fill(0)
		this.stats.active = this.stats.submitted = 0
		if (this.mesh === null || terrain === null || this.cap === 0) return
		this.terrain = terrain
		for (let i = 0; i < this.cap; i++) {
			if (!this.active[i]) continue
			const age = time - this.born[i]
			// A rewound clock (replay seek, new match) is not a mark from the future.
			if (age < 0 || age >= this.life[i]) { this.active[i] = 0; continue }
			if (!shroud.isVisible(Math.floor(this.x[i]), Math.floor(this.z[i]))) continue
			const band = Math.min(BANDS - 1, Math.floor(age / this.life[i] * BANDS)) + (this.strong[i] ? BANDS : 0)
			const slot = this.counts[band]++
			const out = this.instances[band], o = slot * 16, half = this.size[i] * 0.5
			placeActor(out, o, this.x[i], this.z[i], this.yaw[i], half, half, false, 0, this.heightAt)
			out[o + 13] += 0.002
			for (let k = 0; k < 3; k++) { out[o + k] *= this.size[i]; out[o + 8 + k] *= this.size[i] }
			this.stats.active++
		}
		for (let b = 0; b < BANDS * 2; b++) {
			const item = this.items[b] as { instanceCount: number }
			item.instanceCount = this.counts[b]
			if (this.counts[b]) { render.submit(this.items[b]); this.stats.submitted += this.counts[b] }
		}
	}
}
