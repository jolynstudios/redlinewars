// STEELSEED — render/heat
//
// Heat shimmer (vfx.md Epic 7, the Atomic's "restrained heat distortion"; Ultra+). A caller
// submits up to MAX_HEAT world-space sources a frame, the way it submits lights. Before the post
// pass each is projected to framebuffer pixels and handed to the post shader in one small uniform:
// the shader bends the scene sample it already reads, so there is no new pass, pipeline or target.
// The bend runs after TAA, so nothing it moves reaches the history. Sources behind the camera
// or off screen are dropped; the shader fades the bend near the screen edges.

/** Sources a frame; the post shader loops over this many at most. */
export const MAX_HEAT = 4
/** f32 per packed frame: a vec4 per source, then (time, count, 0, 0). */
export const HEAT_FLOATS = MAX_HEAT * 4 + 4

export class HeatSources {
	private readonly world = new Float32Array(MAX_HEAT * 5)
	private count = 0

	/** A shimmer around (x, y, z), `radiusM` metres wide, displacing up to `strengthPx` pixels. */
	add(x: number, y: number, z: number, radiusM: number, strengthPx: number): void {
		if (this.count >= MAX_HEAT || !(radiusM > 0) || !(strengthPx > 0)) return
		const o = this.count++ * 5
		this.world[o] = x; this.world[o + 1] = y; this.world[o + 2] = z; this.world[o + 3] = radiusM; this.world[o + 4] = strengthPx
	}

	get size(): number { return this.count }

	reset(): void { this.count = 0 }

	/**
	 * Project into framebuffer pixels (origin top left, as the fragment's position). The radius
	 * is measured by projecting a point `radiusM` to the side at the source's depth. Returns the
	 * number of sources written into `out` (HEAT_FLOATS long).
	 */
	pack(viewProj: Float32Array, width: number, height: number, time: number, out: Float32Array): number {
		let n = 0
		for (let i = 0; i < this.count; i++) {
			const o = i * 5, x = this.world[o], y = this.world[o + 1], z = this.world[o + 2], r = this.world[o + 3]
			const c = project(viewProj, x, y, z, width, height)
			if (!c) continue
			// The screen-space radius at this depth: the camera's right is the view matrix's first row.
			const s = project(viewProj, x + r, y, z, width, height), u = project(viewProj, x, y + r, z, width, height)
			const radiusPx = Math.max(s ? Math.hypot(s[0] - c[0], s[1] - c[1]) : 0, u ? Math.hypot(u[0] - c[0], u[1] - c[1]) : 0)
			if (radiusPx < 2 || c[0] < -radiusPx || c[1] < -radiusPx || c[0] > width + radiusPx || c[1] > height + radiusPx) continue
			out[n * 4] = c[0]; out[n * 4 + 1] = c[1]; out[n * 4 + 2] = radiusPx; out[n * 4 + 3] = this.world[o + 4]
			n++
		}
		for (let i = n * 4; i < MAX_HEAT * 4; i++) out[i] = 0
		out[MAX_HEAT * 4] = time % 1000
		out[MAX_HEAT * 4 + 1] = n
		out[MAX_HEAT * 4 + 2] = 0
		out[MAX_HEAT * 4 + 3] = 0
		return n
	}
}

function project(m: Float32Array, x: number, y: number, z: number, width: number, height: number): [number, number] | null {
	const w = m[3] * x + m[7] * y + m[11] * z + m[15]
	if (w <= 1e-4) return null
	const nx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w, ny = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w
	return [(nx * 0.5 + 0.5) * width, (0.5 - ny * 0.5) * height]
}
