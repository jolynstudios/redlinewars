// STEELSEED — camera/pick
//
// Screen -> world. Turns a pointer position into a ground cell and, where one is under
// the cursor, an actor id. Everything the player does to the world goes through here:
// selection, move orders, attack orders, build placement.
//
// Two properties this file exists to guarantee:
//
//   1. **It is allocation-free.** Picking runs on every pointer move, and a Vec3 per
//      sample is exactly the rule-6 violation the harness cannot see (rulecheck's
//      heuristic stops at the closing brace of update()). Every temporary here is a
//      preallocated field.
//   2. **It agrees with the simulation.** The sim owns hit shapes; this must not invent
//      its own. Actor picking tests the snapshot's own positions and the type table's
//      radius, and the ground hit resolves to a CELL, because a cell is the unit the sim
//      actually takes in an order (§4.11) — handing it a sub-cell world position would
//      imply a precision the lockstep does not have.

import { clamp, type Mat4, m4, mat4, type Vec3, v3, vec3 } from '../core'

/** Result of a ground pick. Reused — copy the fields you need, do not retain the object. */
export interface GroundHit {
	/** True when the ray met the ground at all. A ray aimed at the sky does not. */
	hit: boolean
	/** Map cell, floor of the world position. What orders take. */
	cellX: number
	cellY: number
	/** World-space hit point, metres. For placement previews and debug draw. */
	x: number
	y: number
	z: number
}

/**
 * Height query, supplied by `terrain`. Absolute world metres in (§12.5), render Y out.
 * Passed in rather than imported so picking works with no terrain node at all — it then
 * degrades to a flat plane at y=0 instead of failing (rule 8).
 */
export type HeightFn = (worldX: number, worldZ: number) => number

/** Maximum march distance in metres. Past this the ray is treated as missing the world. */
const MAX_DISTANCE = 4096
/** Coarse step ceiling, metres. Far above flat ground the march still runs at this pace. */
const COARSE_STEP = 1.5
/** Smallest march step, metres. A quarter-metre cannot hide a crest: terrain features are
 *  all at least one cell across, so any piercing the ray makes is sampled below. */
const MIN_STEP = 0.25
/** Vertical metres the surface may rise per metre travelled along the ray. Cliffs top out
 *  near two metres per cell and one cell is one metre of ground, so three leaves margin. */
const SURFACE_RISE_PER_METRE = 3
/** Bisection iterations. 12 gets sub-millimetre on a 1.5 m bracket — far past cell precision. */
const REFINE_ITERATIONS = 12

export class Picker {
	private readonly invViewProj = mat4()
	private readonly rayOrigin = vec3(0, 0, 0)
	private readonly rayDir = vec3(0, 0, 0)
	private readonly nearPoint = vec3(0, 0, 0)
	private readonly farPoint = vec3(0, 0, 0)

	readonly ground: GroundHit = { hit: false, cellX: 0, cellY: 0, x: 0, y: 0, z: 0 }

	/**
	 * Build a world-space ray through a pixel.
	 *
	 * NDC y is flipped because screen y grows downward while clip y grows upward — the
	 * single most common sign error in picking, and it produces a pick that is correct at
	 * the screen centre and increasingly wrong toward the edges, which reads as "picking
	 * is slightly off" rather than as a flipped axis.
	 *
	 * Uses the UNJITTERED view-projection. TAA folds a subpixel offset into the matrix the
	 * renderer rasterises with, and picking through that would make the same click land on
	 * different cells on consecutive frames.
	 */
	setRay(
		view: Mat4,
		proj: Mat4,
		eye: Vec3,
		screenX: number,
		screenY: number,
		width: number,
		height: number,
	): boolean {
		m4.multiply(this.invViewProj, proj, view)
		if (!m4.invert(this.invViewProj, this.invViewProj)) return false

		const ndcX = (screenX / Math.max(1, width)) * 2 - 1
		const ndcY = 1 - (screenY / Math.max(1, height)) * 2

		// ONE unprojection, at the near plane, and the eye as the origin.
		//
		// The obvious formulation — unproject near and far, subtract — does not work here.
		// The projection is reverse-Z with an INFINITE far plane (§12.2, `perspectiveReverseZ`),
		// so the near plane is z=1 and z=0 is literally the point at infinity: unprojecting
		// it yields w ~ 0 and the ray is undefined. Measured: every pick returned false at
		// the far unprojection, which is the guard doing its job rather than a bug.
		//
		// For a perspective camera the eye IS the ray origin, and any point on the ray gives
		// the direction, so the near-plane point alone is sufficient and exact.
		if (!unproject(this.nearPoint, this.invViewProj, ndcX, ndcY, 1)) return false

		v3.copy(this.rayOrigin, eye)
		v3.sub(this.rayDir, this.nearPoint, eye)
		const len = Math.hypot(this.rayDir[0], this.rayDir[1], this.rayDir[2])
		if (!(len > 1e-6)) return false
		v3.scale(this.rayDir, this.rayDir, 1 / len)
		return true
	}

	/**
	 * March the ray against the heightfield.
	 *
	 * A ray/plane intersection would be wrong on anything but flat ground: clicking the
	 * near face of a hill would place the order on the terrain *behind* it. So this
	 * marches until the ray passes below the surface, then bisects the bracket.
	 *
	 * Marching forward rather than a DDA is deliberate — a DDA over cells is faster but
	 * has to special-case the cliff walls terrain emits, and picking runs once per pointer
	 * event, not per pixel. The step is not FIXED, though: it is bounded by how far the
	 * ray stays clear of the surface, because a fixed step let a tilted camera's grazing
	 * ray hop clean over a crest — both samples in the air, the bracket landing on the far
	 * side — and the order drew and fired behind what the player was pointing at.
	 */
	pickGround(heightAt: HeightFn | null): GroundHit {
		const g = this.ground
		g.hit = false

		const ox = this.rayOrigin[0]
		const oy = this.rayOrigin[1]
		const oz = this.rayOrigin[2]
		const dx = this.rayDir[0]
		const dy = this.rayDir[1]
		const dz = this.rayDir[2]

		// Looking up, or exactly along the horizon: nothing to hit.
		if (dy >= -1e-6) return g

		let prevT = 0
		let t = COARSE_STEP

		if (oy - sampleHeight(heightAt, ox, oz) < 0) {
			// The eye often sits inside a foreground ridge: focus is a valley, the
			// orbit offset puts the camera in the hill behind the player, and a 1° Q/E
			// tap is enough to slide it back into air. Aborting here made every ground
			// click miss — selection still worked, because it is screen-space — until
			// the orbit moved. Skip the buried stretch and pick the first visible
			// surface, which is the ground the player is actually pointing at.
			let emerged = false
			for (; t <= MAX_DISTANCE; t += COARSE_STEP) {
				const above = (oy + dy * t) - sampleHeight(heightAt, ox + dx * t, oz + dz * t)
				if (above > 0) {
					prevT = t
					t += COARSE_STEP
					emerged = true
					break
				}
				prevT = t
			}
			if (!emerged) return g
		}

		for (; t <= MAX_DISTANCE;) {
			const px = ox + dx * t
			const py = oy + dy * t
			const pz = oz + dz * t
			const above = py - sampleHeight(heightAt, px, pz)

			if (above <= 0) {
				// Bracketed between prevT (above) and t (below). The step bound above
				// guarantees the bracket holds the FIRST crossing, so the bisection is
				// exact rather than one guess among several.
				let lo = prevT
				let hi = t
				for (let i = 0; i < REFINE_ITERATIONS; i++) {
					const mid = (lo + hi) * 0.5
					const mx = ox + dx * mid
					const my = oy + dy * mid
					const mz = oz + dz * mid
					if (my - sampleHeight(heightAt, mx, mz) > 0) lo = mid
					else hi = mid
				}

				const ft = (lo + hi) * 0.5
				g.x = ox + dx * ft
				g.y = oy + dy * ft
				g.z = oz + dz * ft
				// Cell, not sub-cell. Orders take cells (§4.11); handing the sim a
				// fractional position implies precision the lockstep does not have.
				g.cellX = Math.floor(g.x)
				g.cellY = Math.floor(g.z)
				g.hit = true
				return g
			}

			prevT = t
			// The next step may not let the surface rise past the ray: over Δt the gap
			// closes by at most (SURFACE_RISE_PER_METRE − dy)·Δt metres, so stepping by
			// above ÷ that rate can never straddle a piercing. High above the ground the
			// bound exceeds COARSE_STEP and the old pace holds; close to slopes it shrinks
			// to MIN_STEP, which no terrain feature (all ≥ one cell) can hide a crest in.
			t += clamp(above / (SURFACE_RISE_PER_METRE - dy), MIN_STEP, COARSE_STEP)
		}

		return g
	}

	/**
	 * Nearest actor whose bounding sphere the ray enters, or -1.
	 *
	 * Sphere, not the sim's exact hit shape: the snapshot carries positions and a type id
	 * (§4.5), not hit geometry, and inventing a shape here would diverge from the sim in
	 * exactly the way §4 exists to prevent. The camera gate compares against the sim's own
	 * hit shapes at five zoom levels, so any divergence shows up as a gate failure rather
	 * than as a subtly wrong click.
	 *
	 * `radiusFor` maps a type id to a metres radius; supply the type table's value.
	 */
	pickActor(
		count: number,
		posX: Float32Array | Int32Array,
		posY: Float32Array | Int32Array,
		posZ: Float32Array | Int32Array,
		ids: Uint32Array,
		typeIds: Uint16Array,
		radiusFor: (typeId: number) => number,
		scale: number,
	): number {
		const ox = this.rayOrigin[0]
		const oy = this.rayOrigin[1]
		const oz = this.rayOrigin[2]
		const dx = this.rayDir[0]
		const dy = this.rayDir[1]
		const dz = this.rayDir[2]

		let bestId = -1
		let bestT = Infinity

		for (let i = 0; i < count; i++) {
			// §12.4: sim X -> render X, sim Z (height) -> render Y, sim Y -> render Z.
			const cx = posX[i] * scale
			const cy = posZ[i] * scale
			const cz = posY[i] * scale
			const r = radiusFor(typeIds[i])
			if (!(r > 0)) continue

			const mx = cx - ox
			const my = cy - oy
			const mz = cz - oz
			// Projection of the centre onto the ray. Negative means it is behind the eye.
			const tca = mx * dx + my * dy + mz * dz
			if (tca < 0) continue

			const d2 = mx * mx + my * my + mz * mz - tca * tca
			const r2 = r * r
			if (d2 > r2) continue

			const thc = Math.sqrt(r2 - d2)
			const t = tca - thc
			if (t < 0 || t >= bestT) continue

			bestT = t
			bestId = ids[i]
		}

		return bestId
	}

	/** World-space ray origin and direction, for callers that need their own test. */
	get origin(): Vec3 {
		return this.rayOrigin
	}

	get direction(): Vec3 {
		return this.rayDir
	}
}

function sampleHeight(heightAt: HeightFn | null, x: number, z: number): number {
	if (!heightAt) return 0
	const h = heightAt(x, z)
	return Number.isFinite(h) ? h : 0
}

/**
 * Unproject an NDC point. Returns false on a degenerate w rather than emitting NaN, which
 * would otherwise propagate silently into an order.
 */
function unproject(out: Vec3, invViewProj: Mat4, x: number, y: number, z: number): boolean {
	const m = invViewProj
	const w = m[3] * x + m[7] * y + m[11] * z + m[15]
	if (Math.abs(w) < 1e-9) return false
	const inv = 1 / w
	out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) * inv
	out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) * inv
	out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) * inv
	return true
}

/** Clamp a cell to the map, so an order off the edge does not reach the sim. */
export function clampCell(v: number, lo: number, hi: number): number {
	return Math.floor(clamp(v, lo, hi))
}
