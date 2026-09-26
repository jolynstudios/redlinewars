// STEELSEED — render/lights
// The dynamic light pool and its budget enforcement.
//
// Hard rule 9: never exceed `config.q.dynamicLights`, degrade gracefully. Callers add
// lights freely during update(); at flush time the pool ranks them by
// intensity x screen coverage and keeps the top `capacity`. Screen coverage is the solid
// angle proxy (radius/distance)^2 — a huge burning wreck two screens away is worth less
// than the muzzle flash under the camera, and that is precisely the ordering wanted.
//
// The camera is not known while lights are being added (the camera node sets it in its
// own update, and update order is topological, not chronological), so lights land in an
// oversized staging pool first and are ranked once, in lateUpdate, against the real
// camera. Ranking against a stale camera would flicker lights in and out at the budget
// boundary as the camera moves.

import { packKey, quantise, sortKeys, unpackIndex } from './sort'

/** Three vec4s: position/radius, colour/intensity, direction/outerCos (48-byte stride). Inner cosine is packed separately as the direction length. */
export const LIGHT_FLOATS = 12
export const LIGHT_BYTES = LIGHT_FLOATS * 4

export class LightPool {
	/** §7 budget. The GPU buffer never holds more than this. */
	readonly capacity: number
	/** Staging capacity. Overflow past this is dropped on arrival, in submission order. */
	readonly stagingCapacity: number

	private readonly staging: Float32Array
	private stagingCount = 0
	private droppedOnArrival = 0

	/** Packed upload data for the surviving lights. */
	readonly data: Float32Array
	count = 0
	buffer: GPUBuffer

	private readonly keys: Float64Array
	private readonly keyScratch: Float64Array

	constructor(device: GPUDevice, capacity: number) {
		this.capacity = Math.max(1, capacity)
		// 4x headroom: a heavy engagement legitimately fires more lights than the budget
		// in one frame, and ranking needs to see them all to pick the right ones.
		this.stagingCapacity = this.capacity * 4
		this.staging = new Float32Array(this.stagingCapacity * LIGHT_FLOATS)
		this.data = new Float32Array(this.capacity * LIGHT_FLOATS)
		this.keys = new Float64Array(this.stagingCapacity)
		this.keyScratch = new Float64Array(this.stagingCapacity)
		this.buffer = device.createBuffer({
			label: 'render.lights',
			size: this.capacity * LIGHT_BYTES,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		})
	}

	get droppedThisFrame(): number {
		return this.droppedOnArrival + Math.max(0, this.stagingCount - this.capacity)
	}

	reset(): void {
		this.stagingCount = 0
		this.droppedOnArrival = 0
		this.count = 0
	}

	add(x: number, y: number, z: number, r: number, g: number, b: number, intensity: number, radius: number, dx=0, dy=0, dz=0, innerCos=1, outerCos=-1): void {
		if (!(intensity > 0) || !(radius > 0)) return
		if (this.stagingCount >= this.stagingCapacity) {
			this.droppedOnArrival++
			return
		}
		const o = this.stagingCount * LIGHT_FLOATS
		const s = this.staging
		s[o] = x
		s[o + 1] = y
		s[o + 2] = z
		s[o + 3] = radius
		s[o + 4] = r
		s[o + 5] = g
		s[o + 6] = b
		s[o + 7] = intensity
		const len = Math.hypot(dx,dy,dz)
		const cone = len > 1e-6 && innerCos > outerCos && outerCos > 0
		const factor = cone ? innerCos / len : 0
		s[o+8]=dx*factor; s[o+9]=dy*factor; s[o+10]=dz*factor; s[o+11]=cone?outerCos:-1
		this.stagingCount++
	}

	/**
	 * Ranks, truncates to budget and uploads. Returns the number of live lights.
	 *
	 * Note the sort is stable and the priority is quantised, so two lights with equal
	 * priority keep submission order — the survivor set is a pure function of what was
	 * submitted, which is what `baseline.mjs` needs (§5.2).
	 */
	flush(device: GPUDevice, camX: number, camY: number, camZ: number): number {
		const n = this.stagingCount
		const s = this.staging
		const out = this.data

		if (n <= this.capacity) {
			for (let i = 0; i < n * LIGHT_FLOATS; i++) out[i] = s[i]
			this.count = n
		} else {
			for (let i = 0; i < n; i++) {
				const o = i * LIGHT_FLOATS
				const dx = s[o] - camX
				const dy = s[o + 1] - camY
				const dz = s[o + 2] - camZ
				const radius = s[o + 3]
				const distSq = dx * dx + dy * dy + dz * dz
				// Solid-angle proxy, clamped so a light containing the camera does not
				// divide by zero and swamp everything else with an infinite priority.
				const coverage = (radius * radius) / (distSq > 1 ? distSq : 1)
				const priority = s[o + 7] * coverage
				this.keys[i] = packKey(quantise(priority, 64, 20), i)
			}
			sortKeys(this.keys, this.keyScratch, n)
			// Ascending, so the budget's worth of highest priority is the tail.
			let w = 0
			for (let i = n - this.capacity; i < n; i++) {
				const src = unpackIndex(this.keys[i]) * LIGHT_FLOATS
				const dst = w * LIGHT_FLOATS
				for (let k = 0; k < LIGHT_FLOATS; k++) out[dst + k] = s[src + k]
				w++
			}
			this.count = this.capacity
		}

		if (this.count > 0)
			device.queue.writeBuffer(this.buffer, 0, out.buffer, out.byteOffset, this.count * LIGHT_BYTES)
		return this.count
	}

	dispose(): void {
		this.buffer.destroy()
	}
}
