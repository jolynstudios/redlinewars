// STEELSEED — geo/spline
// Splines, profile lofting, and the extrude/bevel/shell family. Every part whose shape is
// "a cross-section dragged along a line" is built here: roads, bridges, barrels, exhaust
// stacks, antennae, handrails, cable runs.
//
// Hard rule 4: the only imports are core/math and the Mesh type. Hard rule 5: nothing here
// is random — a loft is a deterministic function of its profile and its path, so this file
// never touches ctx.rng at all. Callers randomise the *parameters*; the construction stays
// a pure function of them. Hard rule 6: every buffer is sized exactly before the loops
// start, and the per-station/per-vertex loops write scalars into those buffers and
// allocate nothing.
//
// World up is +Z. The sim puts cells in the XY plane and height in Z (ARCHITECTURE.md §4.5,
// WPos), so every default axis here follows that and no node has to hold two conventions.

// Value import, not `import type`: buildMesh() constructs a real Mesh. An object literal
// shaped like one would typecheck under a structural cast but has none of the class's
// methods or capacity bookkeeping, so it would fail the moment anything called
// computeNormals(), simplify() or toGPUBuffers() on the result.
import { Mesh } from './mesh'
import { DEG2RAD, clamp, v3, vec3, type Vec2, type Vec3 } from '../core/math'

/**
 * A 2D profile: interleaved xy pairs. Closed profiles do **not** repeat the first point —
 * closure is a flag on the operation, because a repeated point would be a zero-length edge
 * that every normal and miter calculation then has to special-case.
 */
export type Profile2D = Float32Array

/** Per-station input: one value, one value per station, or a function of the station. */
export type StationValue = number | ArrayLike<number> | ((i: number, t: number) => number)

const EPS = 1e-9
const TWO_PI = Math.PI * 2
const DEFAULT_SMOOTH_ANGLE = 40 * DEG2RAD

export function profilePointCount(p: Profile2D): number {
	return p.length >> 1
}

// ---------------------------------------------------------------------------
// Polygon queries
// ---------------------------------------------------------------------------

/** Shoelace. Positive for counter-clockwise, which is the winding everything here wants. */
export function polygonArea(p: Profile2D): number {
	const n = p.length >> 1
	if (n < 3) return 0
	let a = 0
	let px = p[(n - 1) * 2]
	let py = p[(n - 1) * 2 + 1]
	for (let i = 0; i < n; i++) {
		const x = p[i * 2]
		const y = p[i * 2 + 1]
		a += px * y - x * py
		px = x
		py = y
	}
	return a * 0.5
}

/** +1 counter-clockwise, -1 clockwise, 0 degenerate (collinear or fewer than 3 points). */
export function polygonWinding(p: Profile2D): number {
	const a = polygonArea(p)
	return a > 1e-12 ? 1 : a < -1e-12 ? -1 : 0
}

export function polygonPerimeter(p: Profile2D, closed = true): number {
	const n = p.length >> 1
	if (n < 2) return 0
	let sum = 0
	const edges = closed ? n : n - 1
	for (let e = 0; e < edges; e++) {
		const b = (e + 1) % n
		sum += Math.hypot(p[b * 2] - p[e * 2], p[b * 2 + 1] - p[e * 2 + 1])
	}
	return sum
}

/** Area-weighted centroid, falling back to the vertex mean when the area vanishes. */
export function polygonCentroid(out: Vec2, p: Profile2D): Vec2 {
	const n = p.length >> 1
	if (n === 0) {
		out[0] = 0
		out[1] = 0
		return out
	}
	let cx = 0
	let cy = 0
	let a2 = 0
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n
		const x0 = p[i * 2]
		const y0 = p[i * 2 + 1]
		const x1 = p[j * 2]
		const y1 = p[j * 2 + 1]
		const cross = x0 * y1 - x1 * y0
		a2 += cross
		cx += (x0 + x1) * cross
		cy += (y0 + y1) * cross
	}
	if (Math.abs(a2) < 1e-12) {
		let sx = 0
		let sy = 0
		for (let i = 0; i < n; i++) {
			sx += p[i * 2]
			sy += p[i * 2 + 1]
		}
		out[0] = sx / n
		out[1] = sy / n
		return out
	}
	out[0] = cx / (3 * a2)
	out[1] = cy / (3 * a2)
	return out
}

/** Writes [minX, minY, maxX, maxY]. Used for the scale-relative epsilons below. */
export function profileBounds(out: Float32Array, p: Profile2D): Float32Array {
	const n = p.length >> 1
	if (n === 0) {
		out[0] = out[1] = out[2] = out[3] = 0
		return out
	}
	let minX = Infinity
	let minY = Infinity
	let maxX = -Infinity
	let maxY = -Infinity
	for (let i = 0; i < n; i++) {
		const x = p[i * 2]
		const y = p[i * 2 + 1]
		if (x < minX) minX = x
		if (x > maxX) maxX = x
		if (y < minY) minY = y
		if (y > maxY) maxY = y
	}
	out[0] = minX
	out[1] = minY
	out[2] = maxX
	out[3] = maxY
	return out
}

/** Largest bbox extent — the length scale a tolerance should be measured against. */
function profileScale(p: Profile2D): number {
	const n = p.length >> 1
	if (n === 0) return 1
	let minX = Infinity
	let minY = Infinity
	let maxX = -Infinity
	let maxY = -Infinity
	for (let i = 0; i < n; i++) {
		const x = p[i * 2]
		const y = p[i * 2 + 1]
		if (x < minX) minX = x
		if (x > maxX) maxX = x
		if (y < minY) minY = y
		if (y > maxY) maxY = y
	}
	const s = Math.max(maxX - minX, maxY - minY)
	return s > EPS ? s : 1
}

/** Collinear runs are tolerated — they are convex, just not strictly. */
export function isConvex(p: Profile2D): boolean {
	const n = p.length >> 1
	if (n < 3) return false
	const tol = 1e-12 * profileScale(p) * profileScale(p)
	let sign = 0
	for (let i = 0; i < n; i++) {
		const a = i
		const b = (i + 1) % n
		const c = (i + 2) % n
		const cross =
			(p[b * 2] - p[a * 2]) * (p[c * 2 + 1] - p[a * 2 + 1]) -
			(p[b * 2 + 1] - p[a * 2 + 1]) * (p[c * 2] - p[a * 2])
		if (Math.abs(cross) <= tol) continue
		const s = cross > 0 ? 1 : -1
		if (sign === 0) sign = s
		else if (s !== sign) return false
	}
	return sign !== 0
}

export function reverseProfile(p: Profile2D, out?: Profile2D): Profile2D {
	const n = p.length >> 1
	const dst = out ?? new Float32Array(n * 2)
	for (let i = 0; i < n; i++) {
		const j = n - 1 - i
		dst[i * 2] = p[j * 2]
		dst[i * 2 + 1] = p[j * 2 + 1]
	}
	return dst
}

/**
 * Returns a profile with the requested winding. Returns the **input array itself** when it
 * already matches — callers that intend to mutate the result must copy. Everything in this
 * file normalises to CCW first so that (dy,-dx) is reliably the outward edge normal.
 */
export function ensureWinding(p: Profile2D, ccw = true): Profile2D {
	const w = polygonWinding(p)
	if (w === 0) return p
	return (w > 0) === ccw ? p : reverseProfile(p)
}

/** Crossing-number test. Points exactly on an edge are unspecified, as usual. */
export function pointInPolygon(p: Profile2D, x: number, y: number): boolean {
	const n = p.length >> 1
	let inside = false
	for (let i = 0, j = n - 1; i < n; j = i++) {
		const xi = p[i * 2]
		const yi = p[i * 2 + 1]
		const xj = p[j * 2]
		const yj = p[j * 2 + 1]
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
	}
	return inside
}

// ---------------------------------------------------------------------------
// Edge basis and corner miters — shared by the offset, the shell and the loft
// ---------------------------------------------------------------------------

interface Edges {
	count: number
	/** Unit edge direction. */
	dx: Float64Array
	dy: Float64Array
	/** Outward normal for a CCW profile: rot(-90°) of the direction. */
	nx: Float64Array
	ny: Float64Array
	len: Float64Array
	/** Cumulative chord length, count+1 entries. */
	cum: Float64Array
}

/**
 * Zero-length edges inherit the previous valid direction rather than producing a zero
 * normal: a duplicated control point in a hand-written profile is common, and a NaN normal
 * from it would propagate silently into the whole lofted part.
 */
function profileEdges(p: Profile2D, closed: boolean): Edges {
	const n = p.length >> 1
	const count = closed ? n : n - 1
	if (count < 1) throw new Error('geo/spline: a profile needs at least 2 points')
	const dx = new Float64Array(count)
	const dy = new Float64Array(count)
	const nx = new Float64Array(count)
	const ny = new Float64Array(count)
	const len = new Float64Array(count)
	const cum = new Float64Array(count + 1)
	let anyValid = false
	for (let e = 0; e < count; e++) {
		const b = (e + 1) % n
		const ex = p[b * 2] - p[e * 2]
		const ey = p[b * 2 + 1] - p[e * 2 + 1]
		const l = Math.hypot(ex, ey)
		len[e] = l
		cum[e + 1] = cum[e] + l
		if (l > EPS) {
			const inv = 1 / l
			dx[e] = ex * inv
			dy[e] = ey * inv
			anyValid = true
		}
	}
	if (!anyValid) throw new Error('geo/spline: profile has no non-degenerate edge')
	// Two passes so a degenerate run at the start of an open profile still finds a donor.
	for (let pass = 0; pass < 2; pass++) {
		for (let e = 0; e < count; e++) {
			if (len[e] > EPS) continue
			const src = (e - 1 + count) % count
			dx[e] = dx[src]
			dy[e] = dy[src]
		}
	}
	for (let e = 0; e < count; e++) {
		nx[e] = dy[e]
		ny[e] = -dx[e]
	}
	return { count, dx, dy, nx, ny, len, cum }
}

/**
 * Per-vertex miter vector: the direction a vertex moves under a unit offset. m = (n0+n1) /
 * (1 + n0·n1) is the exact miter, so offsetting by `d` keeps every edge parallel to its
 * original at distance `d` — a uniform scale does not, which is why draft angles and shells
 * are built on this and not on scaling.
 */
function profileMiters(p: Profile2D, e: Edges, closed: boolean, miterLimit: number): { mx: Float64Array; my: Float64Array } {
	const n = p.length >> 1
	const mx = new Float64Array(n)
	const my = new Float64Array(n)
	for (let k = 0; k < n; k++) {
		const hasPrev = closed || k > 0
		const hasNext = closed || k < e.count
		const ep = hasPrev ? (k - 1 + e.count) % e.count : -1
		const en = hasNext ? k % e.count : -1
		let vx: number
		let vy: number
		if (ep < 0) {
			vx = e.nx[en]
			vy = e.ny[en]
		} else if (en < 0) {
			vx = e.nx[ep]
			vy = e.ny[ep]
		} else {
			const d = e.nx[ep] * e.nx[en] + e.ny[ep] * e.ny[en]
			const den = 1 + d
			if (den < 1e-6) {
				// A 180° reversal (a spike) has no finite miter; keep the outgoing normal
				// so the offset stays bounded and visibly wrong rather than infinite.
				vx = e.nx[en]
				vy = e.ny[en]
			} else {
				vx = (e.nx[ep] + e.nx[en]) / den
				vy = (e.ny[ep] + e.ny[en]) / den
			}
		}
		const l = Math.hypot(vx, vy)
		if (l > miterLimit) {
			const s = miterLimit / l
			vx *= s
			vy *= s
		}
		mx[k] = vx
		my[k] = vy
	}
	return { mx, my }
}

export interface OffsetOptions {
	closed?: boolean
	/** Cap on the miter extension, in multiples of the offset distance. */
	miterLimit?: number
	out?: Profile2D
}

/**
 * Parallel offset with miter joins. Positive `delta` moves a CCW profile outward. Vertex
 * count is preserved, which is what lets a lofted draft angle interpolate between the base
 * and the offset profile with one shared topology.
 *
 * This is a miter offset, not a boolean offset: it does not remove the self-intersections a
 * large inward offset creates on a concave profile. `shell()` checks for that case.
 */
export function offsetProfile(p: Profile2D, delta: number, opts: OffsetOptions = {}): Profile2D {
	const closed = opts.closed ?? true
	const n = p.length >> 1
	const e = profileEdges(p, closed)
	const m = profileMiters(p, e, closed, opts.miterLimit ?? 8)
	const out = opts.out ?? new Float32Array(n * 2)
	for (let k = 0; k < n; k++) {
		out[k * 2] = p[k * 2] + m.mx[k] * delta
		out[k * 2 + 1] = p[k * 2 + 1] + m.my[k] * delta
	}
	return out
}

// ---------------------------------------------------------------------------
// Triangulation — ear clipping over a doubly linked list
// ---------------------------------------------------------------------------

/** Strictly interior: a point on the boundary does not block an ear. See `triangulate`. */
function strictlyInTriangle(
	ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
	px: number, py: number, tol: number,
): boolean {
	const d0 = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
	const d1 = (cx - bx) * (py - by) - (cy - by) * (px - bx)
	const d2 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx)
	return d0 > tol && d1 > tol && d2 > tol
}

/**
 * Ear clipping. Returns triangles as indices into the input profile's points, always wound
 * counter-clockwise regardless of the input winding.
 *
 * Robustness, which is the whole reason this is not fifteen lines:
 *  - a clockwise input is walked in reverse rather than copied;
 *  - the "is this point inside the ear" test is **strictly** interior, so the coincident
 *    vertices `bridgeLoops` introduces do not veto every ear and deadlock the hole;
 *  - a full pass with no ear found relaxes to accept collinear (zero-area) ears, and a
 *    second failed pass force-clips. Termination is therefore guaranteed even on garbage
 *    input, which matters because this runs inside asset generation at boot;
 *  - zero-area triangles are dropped from the output instead of being handed to the GPU.
 */
export function triangulate(p: Profile2D, out?: Uint32Array): Uint32Array {
	const n = p.length >> 1
	if (n < 3) return out ? out.subarray(0, 0) : new Uint32Array(0)
	const scale = profileScale(p)
	const areaTol = 1e-10 * scale * scale
	// Positive, so a point *on* the ear's boundary does not block it. That is precisely the
	// coincident vertex a bridged hole introduces, and a negative tolerance deadlocks it.
	const inTol = 1e-12 * scale * scale

	// ord maps list position -> profile index, so a CW profile costs a lookup, not a copy.
	const ccw = polygonArea(p) >= 0
	const ord = new Uint32Array(n)
	for (let i = 0; i < n; i++) ord[i] = ccw ? i : n - 1 - i

	const prev = new Int32Array(n)
	const next = new Int32Array(n)
	for (let i = 0; i < n; i++) {
		prev[i] = (i - 1 + n) % n
		next[i] = (i + 1) % n
	}

	const tris = new Uint32Array((n - 2) * 3)
	let tcount = 0
	let remaining = n
	let cur = 0
	let stalled = 0
	let relax = 0

	const px = (i: number) => p[ord[i] * 2]
	const py = (i: number) => p[ord[i] * 2 + 1]

	while (remaining > 3) {
		const a = prev[cur]
		const c = next[cur]
		const ax = px(a), ay = py(a)
		const bx = px(cur), by = py(cur)
		const cx = px(c), cy = py(c)
		const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)

		let ear = relax >= 2
		if (!ear && (relax >= 1 ? cross >= -areaTol : cross > areaTol)) {
			ear = true
			// Only a reflex vertex can block an ear; testing the rest is wasted work and
			// makes touching-but-outside geometry fail for no reason.
			for (let q = next[c]; q !== a; q = next[q]) {
				const qx = px(q), qy = py(q)
				const qa = prev[q], qc = next[q]
				const rc =
					(qx - px(qa)) * (py(qc) - py(qa)) - (qy - py(qa)) * (px(qc) - px(qa))
				if (rc > 0) continue
				if (strictlyInTriangle(ax, ay, bx, by, cx, cy, qx, qy, inTol)) {
					ear = false
					break
				}
			}
		}

		if (ear) {
			if (Math.abs(cross) > areaTol) {
				tris[tcount * 3] = ord[a]
				tris[tcount * 3 + 1] = ord[cur]
				tris[tcount * 3 + 2] = ord[c]
				tcount++
			}
			next[a] = c
			prev[c] = a
			remaining--
			cur = c
			stalled = 0
			relax = 0
		} else {
			cur = next[cur]
			if (++stalled > remaining) {
				stalled = 0
				relax++
			}
		}
	}

	const a = prev[cur]
	const c = next[cur]
	const cross =
		(px(cur) - px(a)) * (py(c) - py(a)) - (py(cur) - py(a)) * (px(c) - px(a))
	if (Math.abs(cross) > areaTol) {
		tris[tcount * 3] = ord[a]
		tris[tcount * 3 + 1] = ord[cur]
		tris[tcount * 3 + 2] = ord[c]
		tcount++
	}

	const len = tcount * 3
	if (out) {
		out.set(tris.subarray(0, len))
		return out.subarray(0, len)
	}
	return tris.slice(0, len)
}

/** Proper crossing only: sharing an endpoint is not an intersection. */
function segmentsCross(
	ax: number, ay: number, bx: number, by: number,
	cx: number, cy: number, dx: number, dy: number,
): boolean {
	const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
	const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax)
	const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx)
	const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx)
	return d1 * d2 < 0 && d3 * d4 < 0
}

/**
 * Splices a hole into its outer loop with a two-sided bridge, producing a single simple
 * polygon that `triangulate` and the lofter can both consume unchanged. That is the whole
 * point: a wall section with a cavity stays one profile, so it extrudes in one call.
 *
 * `outer` is normalised to CCW and `inner` to CW — a hole must run against its container or
 * the bridged loop encloses the cavity instead of excluding it.
 */
export function bridgeLoops(outer: Profile2D, inner: Profile2D): Profile2D {
	const o = ensureWinding(outer, true)
	const h = ensureWinding(inner, false)
	const on = o.length >> 1
	const hn = h.length >> 1
	if (on < 3 || hn < 3) throw new Error('geo/spline: bridgeLoops needs two loops of 3+ points')

	// The rightmost hole vertex is guaranteed to see the outer loop along +x, which is what
	// makes a visibility search terminate instead of hunting.
	let m = 0
	for (let i = 1; i < hn; i++) {
		const x = h[i * 2]
		const bx = h[m * 2]
		if (x > bx || (x === bx && h[i * 2 + 1] > h[m * 2 + 1])) m = i
	}
	const mx = h[m * 2]
	const my = h[m * 2 + 1]

	let best = -1
	let bestD = Infinity
	for (let k = 0; k < on; k++) {
		const kx = o[k * 2]
		const ky = o[k * 2 + 1]
		const d = (kx - mx) * (kx - mx) + (ky - my) * (ky - my)
		if (d >= bestD) continue
		let blocked = false
		for (let e = 0; e < on && !blocked; e++) {
			const b = (e + 1) % on
			if (e === k || b === k) continue
			if (segmentsCross(mx, my, kx, ky, o[e * 2], o[e * 2 + 1], o[b * 2], o[b * 2 + 1])) blocked = true
		}
		for (let e = 0; e < hn && !blocked; e++) {
			const b = (e + 1) % hn
			if (e === m || b === m) continue
			if (segmentsCross(mx, my, kx, ky, h[e * 2], h[e * 2 + 1], h[b * 2], h[b * 2 + 1])) blocked = true
		}
		if (blocked) continue
		best = k
		bestD = d
	}
	// No visible vertex means the loops touch or overlap; the nearest one still produces a
	// closed profile, and a caller that fed overlapping loops has a worse problem than this.
	if (best < 0) {
		best = 0
		let d0 = Infinity
		for (let k = 0; k < on; k++) {
			const d = (o[k * 2] - mx) * (o[k * 2] - mx) + (o[k * 2 + 1] - my) * (o[k * 2 + 1] - my)
			if (d < d0) {
				d0 = d
				best = k
			}
		}
	}

	const out = new Float32Array((on + hn + 2) * 2)
	let w = 0
	for (let i = 0; i <= best; i++) {
		out[w++] = o[i * 2]
		out[w++] = o[i * 2 + 1]
	}
	for (let i = 0; i < hn; i++) {
		const j = (m + i) % hn
		out[w++] = h[j * 2]
		out[w++] = h[j * 2 + 1]
	}
	out[w++] = mx
	out[w++] = my
	for (let i = best; i < on; i++) {
		out[w++] = o[i * 2]
		out[w++] = o[i * 2 + 1]
	}
	return out
}

// ---------------------------------------------------------------------------
// Corner treatment — bevel (arc) and chamfer (single cut)
// ---------------------------------------------------------------------------

export interface BevelOptions {
	closed?: boolean
	/**
	 * Fraction of an adjacent edge a corner may consume. Below 0.5 two adjacent corners can
	 * never eat into each other, which is what keeps a heavily bevelled box from inverting.
	 */
	maxEdgeFraction?: number
}

function bevelInternal(
	p: Profile2D,
	amount: number | ArrayLike<number>,
	segments: number,
	mode: 'radius' | 'distance',
	opts: BevelOptions,
): Profile2D {
	const closed = opts.closed ?? true
	const frac = clamp(opts.maxEdgeFraction ?? 0.45, 0.01, 0.5)
	const segs = Math.max(1, Math.round(segments))
	const n = p.length >> 1
	if (n < 3) return p.slice()
	const e = profileEdges(p, closed)

	// Pass 1 — per-corner geometry, so pass 2 can fill an exactly sized array.
	const turn = new Float64Array(n)
	const cut = new Float64Array(n)
	const rad = new Float64Array(n)
	const active = new Uint8Array(n)
	let outPoints = 0
	for (let k = 0; k < n; k++) {
		const first = !closed && k === 0
		const last = !closed && k === n - 1
		if (first || last) {
			outPoints++
			continue
		}
		const ep = (k - 1 + e.count) % e.count
		const en = k % e.count
		const cross = e.dx[ep] * e.dy[en] - e.dy[ep] * e.dx[en]
		const dot = e.dx[ep] * e.dx[en] + e.dy[ep] * e.dy[en]
		// Clamped away from a full reversal: tan(phi/2) diverges there and the cut-back
		// would be infinite before the edge-fraction clamp ever saw it.
		const phi = clamp(Math.atan2(cross, dot), -Math.PI + 1e-4, Math.PI - 1e-4)
		const half = Math.abs(phi) * 0.5
		const want = typeof amount === 'number' ? amount : amount[k] ?? 0
		if (half < 1e-4 || want <= 0) {
			outPoints++
			continue
		}
		const tanHalf = Math.tan(half)
		let t = mode === 'radius' ? want * tanHalf : want
		const limit = Math.min(e.len[ep], e.len[en]) * frac
		if (t > limit) t = limit
		if (t <= EPS) {
			outPoints++
			continue
		}
		turn[k] = phi
		cut[k] = t
		rad[k] = t / tanHalf
		active[k] = 1
		outPoints += segs + 1
	}

	const out = new Float32Array(outPoints * 2)
	let w = 0
	for (let k = 0; k < n; k++) {
		const vx = p[k * 2]
		const vy = p[k * 2 + 1]
		if (!active[k]) {
			out[w++] = vx
			out[w++] = vy
			continue
		}
		const ep = (k - 1 + e.count) % e.count
		const t = cut[k]
		const r = rad[k]
		const phi = turn[k]
		const sign = phi >= 0 ? 1 : -1
		const p1x = vx - e.dx[ep] * t
		const p1y = vy - e.dy[ep] * t
		// Centre sits on the interior side of the turn, r away from the incoming edge.
		const cxx = p1x + -e.dy[ep] * sign * r
		const cyy = p1y + e.dx[ep] * sign * r
		const a0 = Math.atan2(p1y - cyy, p1x - cxx)
		for (let s = 0; s <= segs; s++) {
			const a = a0 + phi * (s / segs)
			out[w++] = cxx + Math.cos(a) * r
			out[w++] = cyy + Math.sin(a) * r
		}
	}
	return out
}

/**
 * Rounds every corner with a tangent arc of the given radius, `segments` chords per corner.
 * `segments === 1` degenerates to a straight cut, which is exactly a chamfer — the two are
 * one implementation because a chamfer is a one-segment fillet and keeping them apart just
 * duplicates the clamping rules.
 *
 * The radius is reduced per corner when it would consume more than `maxEdgeFraction` of
 * either adjacent edge, so a uniform radius on a profile with mixed edge lengths degrades
 * instead of self-intersecting.
 */
export function bevelProfile(
	p: Profile2D,
	radius: number | ArrayLike<number>,
	segments = 4,
	opts: BevelOptions = {},
): Profile2D {
	return bevelInternal(p, radius, segments, 'radius', opts)
}

/** Cuts each corner back by `distance` along both adjacent edges and joins the cuts. */
export function chamferProfile(
	p: Profile2D,
	distance: number | ArrayLike<number>,
	opts: BevelOptions = {},
): Profile2D {
	return bevelInternal(p, distance, 1, 'distance', opts)
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export interface Shell {
	/** CCW. */
	outer: Profile2D
	/** CW — hole winding, ready for `bridgeLoops` or a two-loop cap. */
	inner: Profile2D
}

/** Below this projected shrink rate an edge is not moving inward and never collapses. */
const SHRINK_EPS = 1e-9

/**
 * Index of the first edge the offset destroyed, or -1 when every edge survived.
 *
 * **Signed area cannot detect an over-thick inward offset, and this is why.** A miter offset
 * moves every edge parallel to itself, so an edge's length shrinks linearly with the distance
 * and passes straight through zero — it does not stop there. Offset a convex profile past its
 * inradius and the loop folds *through* itself and comes back out mirrored: same positive
 * winding, smaller area, perfectly watertight when extruded. `area <= 0 || area >= outerArea`
 * fires only at the exact collapse point and again once the mirrored loop outgrows the
 * original, so it reads as a valid thin wall everywhere in between.
 *
 * What actually characterises a surviving offset is per-edge: `newEdge · oldEdge > 0`. Past
 * the collapse the edge runs backwards and the dot goes negative. No tolerance to tune, no
 * assumption of convexity, and it is exact at the fold rather than at the fold's area.
 */
function firstReversedEdge(src: Profile2D, dst: Profile2D): number {
	const n = src.length >> 1
	for (let e = 0; e < n; e++) {
		const b = (e + 1) % n
		const ox = src[b * 2] - src[e * 2]
		const oy = src[b * 2 + 1] - src[e * 2 + 1]
		// A duplicated control point is a legitimate way to write a profile (see
		// `profileEdges`); a zero-length edge has no direction to preserve.
		if (ox * ox + oy * oy <= EPS * EPS) continue
		const nx = dst[b * 2] - dst[e * 2]
		const ny = dst[b * 2 + 1] - dst[e * 2 + 1]
		if (ox * nx + oy * ny <= 0) return e
	}
	return -1
}

/** Orientation of c about the directed line a→b: >0 left, <0 right, 0 collinear. */
function orient2d(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
	return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
}

/** Bounding-box containment; only meaningful once c is known to be collinear with a→b. */
function withinSegment(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
	return (
		cx >= Math.min(ax, bx) && cx <= Math.max(ax, bx) && cy >= Math.min(ay, by) && cy <= Math.max(ay, by)
	)
}

/**
 * Do two segments share **any** point? Touching and collinear overlap both count, which is
 * the whole difference from `segmentsCross` and the reason this exists separately.
 *
 * `bridgeLoops` wants the proper-crossing version: a bridge that lands exactly on a vertex is
 * fine there. A pinch detector wants this one, because an axis-aligned waist shuts *along* a
 * shared line — the two sides of the neck end up collinear and overlapping, every orientation
 * determinant is exactly zero, and a proper-crossing test reports a clean polygon.
 */
function segmentsIntersect(
	ax: number, ay: number, bx: number, by: number,
	cx: number, cy: number, dx: number, dy: number,
): boolean {
	const d1 = orient2d(ax, ay, bx, by, cx, cy)
	const d2 = orient2d(ax, ay, bx, by, dx, dy)
	const d3 = orient2d(cx, cy, dx, dy, ax, ay)
	const d4 = orient2d(cx, cy, dx, dy, bx, by)
	if (d1 * d2 < 0 && d3 * d4 < 0) return true
	if (d1 === 0 && withinSegment(ax, ay, bx, by, cx, cy)) return true
	if (d2 === 0 && withinSegment(ax, ay, bx, by, dx, dy)) return true
	if (d3 === 0 && withinSegment(cx, cy, dx, dy, ax, ay)) return true
	if (d4 === 0 && withinSegment(cx, cy, dx, dy, bx, by)) return true
	return false
}

/**
 * True when two non-adjacent edges of a closed loop meet — i.e. the loop is not simple.
 *
 * O(n²), and that is fine: this runs once per generated part at boot, never per frame, and a
 * profile is tens of points. Degenerate edges are skipped rather than tested, because a
 * point-versus-segment incidence is the one case where the inclusive predicate above would
 * report a duplicated control point as a self-intersection.
 */
function loopSelfIntersects(p: Profile2D): boolean {
	const n = p.length >> 1
	if (n < 4) return false
	for (let i = 0; i < n; i++) {
		const i1 = (i + 1) % n
		const ax = p[i * 2]
		const ay = p[i * 2 + 1]
		const bx = p[i1 * 2]
		const by = p[i1 * 2 + 1]
		if ((bx - ax) * (bx - ax) + (by - ay) * (by - ay) <= EPS * EPS) continue
		for (let j = i + 2; j < n; j++) {
			const j1 = (j + 1) % n
			// Edges that share an endpoint are adjacent, not crossing; skip the wrap pair too.
			if (j1 === i) continue
			const cx = p[j * 2]
			const cy = p[j * 2 + 1]
			const dx = p[j1 * 2]
			const dy = p[j1 * 2 + 1]
			if ((dx - cx) * (dx - cx) + (dy - cy) * (dy - cy) <= EPS * EPS) continue
			if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return true
		}
	}
	return false
}

/**
 * The largest inward offset a closed profile survives before one of its edges collapses and
 * reverses — the first *edge event* of its straight skeleton, measured against the miter
 * operator this file actually uses, miter limit included, so the number is the one `shell`
 * obeys rather than a textbook inradius.
 *
 * Exact, not a search: `offsetProfile` is `p + m·delta` with a miter `m` that depends only on
 * the profile, so the per-edge shrink read off a single unit offset is the shrink rate at
 * every distance. Returns `Infinity` for a profile no inward offset ever collapses.
 *
 * **This is an upper bound, not the whole limit.** It says nothing about split events: a
 * profile with a thin waist pinches shut long before any of its edges runs out of length. A
 * dumbbell with a 0.4-wide neck reports 1.0 here — none of its edges collapses until then —
 * while `shell` correctly refuses it from 0.2, where the neck's two walls meet. Treat the
 * result as "no thicker than this" and let `shell` be the arbiter; it checks both.
 *
 * Call this to *choose* a wall thickness. `shell` calls it only to name the limit it just
 * refused to cross — clamping silently is exactly the failure this file is trying not to have.
 */
export function maxInwardOffset(p: Profile2D, opts: OffsetOptions = {}): number {
	const q = ensureWinding(p, true)
	const n = q.length >> 1
	if (n < 3) return 0
	const unit = offsetProfile(q, -1, { closed: true, miterLimit: opts.miterLimit ?? 8 })
	let best = Infinity
	for (let e = 0; e < n; e++) {
		const b = (e + 1) % n
		const ox = q[b * 2] - q[e * 2]
		const oy = q[b * 2 + 1] - q[e * 2 + 1]
		const l2 = ox * ox + oy * oy
		if (l2 <= EPS * EPS) continue
		const l = Math.sqrt(l2)
		// d = m[b] - m[e], recovered from the unit offset. The edge shortens by d·edgeDir per
		// unit of inward offset, so it reaches zero length at len / that rate. Project onto the
		// *unit* edge direction: dividing by l2 instead would make the answer scale with the
		// edge's own length, which is right only for an edge of length 1.
		const dx = ox - (unit[b * 2] - unit[e * 2])
		const dy = oy - (unit[b * 2 + 1] - unit[e * 2 + 1])
		const rate = (dx * ox + dy * oy) / l
		if (rate <= SHRINK_EPS) continue
		const t = l / rate
		if (t < best) best = t
	}
	return best
}

/**
 * Offsets a closed profile inward by `thickness` to make a wall section.
 *
 * Throws when the offset collapses. A miter offset cannot delete the self-intersection a
 * too-large inward offset produces, and a silently inverted inner loop becomes a building
 * whose walls are inside out — loud failure at generation time is the cheap outcome here.
 * Use `maxInwardOffset` to pick a thickness this profile can actually carry.
 *
 * Two ways an offset dies, and both are checked because both are silent:
 *  - an **edge event** — an edge shrinks to nothing and reverses, folding the loop through
 *    itself. `firstReversedEdge` explains why area cannot see this;
 *  - a **split event** — a thin waist pinches shut and the loop crosses itself somewhere far
 *    from either edge's own endpoints. No edge reverses, the area stays positive and smaller,
 *    and the figure-of-eight that comes out triangulates into a solid with an inverted lobe.
 */
export function shell(p: Profile2D, thickness: number, opts: OffsetOptions = {}): Shell {
	if (!(thickness > 0)) throw new Error('geo/spline: shell thickness must be positive')
	const outerSrc = ensureWinding(p, true)
	const outer = outerSrc === p ? p.slice() : outerSrc
	const miterLimit = opts.miterLimit ?? 8
	const raw = offsetProfile(outer, -thickness, { closed: true, miterLimit })
	const aOuter = polygonArea(outer)
	const aInner = polygonArea(raw)
	const bad = firstReversedEdge(outer, raw)
	if (bad >= 0) {
		const max = maxInwardOffset(outer, { miterLimit })
		throw new Error(
			`geo/spline: shell thickness ${thickness} collapses this profile — edge ${bad} reverses; ` +
				`the maximum inward offset here is ${max.toFixed(4)} ` +
				`(outer area ${aOuter.toFixed(4)}, inner ${aInner.toFixed(4)})`,
		)
	}
	if (aInner <= 0 || aInner >= aOuter) {
		throw new Error(
			`geo/spline: shell thickness ${thickness} collapses this profile (outer area ${aOuter.toFixed(4)}, inner ${aInner.toFixed(4)})`,
		)
	}
	if (loopSelfIntersects(raw)) {
		throw new Error(
			`geo/spline: shell thickness ${thickness} pinches this profile — the inner loop self-intersects ` +
				`(outer area ${aOuter.toFixed(4)}, inner ${aInner.toFixed(4)})`,
		)
	}
	return { outer, inner: reverseProfile(raw) }
}

/** `shell` as one bridged profile — extrude it directly to get a wall section with a void. */
export function shellLoop(p: Profile2D, thickness: number, opts: OffsetOptions = {}): Profile2D {
	const s = shell(p, thickness, opts)
	return bridgeLoops(s.outer, s.inner)
}

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

/**
 * A curve in the raw parameter `t` ∈ [0,1]. Parameter space is **not** arc length — wrap it
 * in an `ArcPath` before lofting anything, or the cross-sections bunch on the curves.
 */
export interface Curve {
	readonly segments: number
	readonly closed: boolean
	/** Evaluates the curve. Arithmetic only — nothing in this file parses or runs a string. */
	eval(out: Vec3, t: number): Vec3
	/** dP/dt, unnormalised. */
	derivative(out: Vec3, t: number): Vec3
	/** d²P/dt². Only the Frenet frame needs it. */
	secondDerivative(out: Vec3, t: number): Vec3
}

export interface CatmullRomOptions {
	closed?: boolean
	/**
	 * Knot exponent. 0.5 (centripetal) is the default and stays that way: uniform (0) puts
	 * cusps and self-intersections into tight control polygons, which on a lofted road means
	 * the tarmac folds through itself at a hairpin.
	 */
	alpha?: number
	/** 0 is standard Catmull-Rom; 1 flattens to straight chords. */
	tension?: number
}

const crCtl = new Float64Array(12)
const crTan = new Float64Array(6)

export class CatmullRomCurve implements Curve {
	readonly points: Float32Array
	readonly count: number
	readonly closed: boolean
	readonly segments: number
	private readonly alpha: number
	private readonly tension: number

	constructor(points: Float32Array | readonly number[], opts: CatmullRomOptions = {}) {
		const src = points instanceof Float32Array ? points : Float32Array.from(points)
		if (src.length < 6 || src.length % 3 !== 0)
			throw new Error('geo/spline: CatmullRomCurve needs at least 2 xyz points')
		// Copied, because a curve that silently changed shape when the caller reused their
		// scratch array would break the "same seed, same geometry" property.
		this.points = src.slice()
		this.count = this.points.length / 3
		this.closed = opts.closed ?? false
		this.segments = this.closed ? this.count : this.count - 1
		this.alpha = opts.alpha ?? 0.5
		this.tension = opts.tension ?? 0
	}

	/** Fills crCtl with p0..p3 for segment `i`, reflecting phantom ends on an open curve. */
	private controls(i: number): void {
		const n = this.count
		const p = this.points
		const i1 = this.closed ? i % n : i
		const i2 = this.closed ? (i + 1) % n : i + 1
		for (let k = 0; k < 3; k++) {
			crCtl[3 + k] = p[i1 * 3 + k]
			crCtl[6 + k] = p[i2 * 3 + k]
		}
		if (this.closed) {
			const i0 = (i - 1 + n) % n
			const i3 = (i + 2) % n
			for (let k = 0; k < 3; k++) {
				crCtl[k] = p[i0 * 3 + k]
				crCtl[9 + k] = p[i3 * 3 + k]
			}
			return
		}
		for (let k = 0; k < 3; k++) {
			crCtl[k] = i > 0 ? p[(i - 1) * 3 + k] : 2 * crCtl[3 + k] - crCtl[6 + k]
			crCtl[9 + k] = i + 2 < n ? p[(i + 2) * 3 + k] : 2 * crCtl[6 + k] - crCtl[3 + k]
		}
	}

	/** Non-uniform Hermite tangents (Yuksel et al.), written into crTan. */
	private tangents(): void {
		const a = this.alpha
		let d0 = 0
		let d1 = 0
		let d2 = 0
		for (let k = 0; k < 3; k++) {
			d0 += (crCtl[3 + k] - crCtl[k]) ** 2
			d1 += (crCtl[6 + k] - crCtl[3 + k]) ** 2
			d2 += (crCtl[9 + k] - crCtl[6 + k]) ** 2
		}
		// Floored: coincident control points are a legitimate way to pin a spline end, and
		// they must not divide by zero.
		d0 = Math.max(Math.sqrt(d0) ** a, 1e-6)
		d1 = Math.max(Math.sqrt(d1) ** a, 1e-6)
		d2 = Math.max(Math.sqrt(d2) ** a, 1e-6)
		const k = 1 - this.tension
		for (let c = 0; c < 3; c++) {
			const p0 = crCtl[c]
			const p1 = crCtl[3 + c]
			const p2 = crCtl[6 + c]
			const p3 = crCtl[9 + c]
			crTan[c] = (((p1 - p0) / d0 - (p2 - p0) / (d0 + d1) + (p2 - p1) / d1) * d1) * k
			crTan[3 + c] = (((p2 - p1) / d1 - (p3 - p1) / (d1 + d2) + (p3 - p2) / d2) * d1) * k
		}
	}

	eval(out: Vec3, t: number): Vec3 {
		const u = clamp(t, 0, 1) * this.segments
		const i = Math.min(Math.floor(u), this.segments - 1)
		const s = u - i
		this.controls(i)
		this.tangents()
		const s2 = s * s
		const s3 = s2 * s
		const h00 = 2 * s3 - 3 * s2 + 1
		const h10 = s3 - 2 * s2 + s
		const h01 = -2 * s3 + 3 * s2
		const h11 = s3 - s2
		for (let c = 0; c < 3; c++)
			out[c] = h00 * crCtl[3 + c] + h10 * crTan[c] + h01 * crCtl[6 + c] + h11 * crTan[3 + c]
		return out
	}

	derivative(out: Vec3, t: number): Vec3 {
		const u = clamp(t, 0, 1) * this.segments
		const i = Math.min(Math.floor(u), this.segments - 1)
		const s = u - i
		this.controls(i)
		this.tangents()
		const s2 = s * s
		const h00 = 6 * s2 - 6 * s
		const h10 = 3 * s2 - 4 * s + 1
		const h01 = -6 * s2 + 6 * s
		const h11 = 3 * s2 - 2 * s
		const k = this.segments
		for (let c = 0; c < 3; c++)
			out[c] = (h00 * crCtl[3 + c] + h10 * crTan[c] + h01 * crCtl[6 + c] + h11 * crTan[3 + c]) * k
		return out
	}

	secondDerivative(out: Vec3, t: number): Vec3 {
		const u = clamp(t, 0, 1) * this.segments
		const i = Math.min(Math.floor(u), this.segments - 1)
		const s = u - i
		this.controls(i)
		this.tangents()
		const h00 = 12 * s - 6
		const h10 = 6 * s - 4
		const h01 = -12 * s + 6
		const h11 = 6 * s - 2
		const k = this.segments * this.segments
		for (let c = 0; c < 3; c++)
			out[c] = (h00 * crCtl[3 + c] + h10 * crTan[c] + h01 * crCtl[6 + c] + h11 * crTan[3 + c]) * k
		return out
	}
}

/**
 * Piecewise cubic Bezier. Open form takes 3k+1 points; closed form takes 3k and wraps the
 * last segment to point 0.
 */
export class BezierCurve implements Curve {
	readonly points: Float32Array
	readonly closed: boolean
	readonly segments: number

	constructor(points: Float32Array | readonly number[], opts: { closed?: boolean } = {}) {
		const src = points instanceof Float32Array ? points : Float32Array.from(points)
		const n = src.length / 3
		this.closed = opts.closed ?? false
		if (src.length % 3 !== 0) throw new Error('geo/spline: BezierCurve points must be xyz triples')
		if (this.closed) {
			if (n < 3 || n % 3 !== 0) throw new Error('geo/spline: a closed BezierCurve needs 3k control points')
			this.segments = n / 3
		} else {
			if (n < 4 || (n - 1) % 3 !== 0) throw new Error('geo/spline: an open BezierCurve needs 3k+1 control points')
			this.segments = (n - 1) / 3
		}
		this.points = src.slice()
	}

	private ctrl(i: number, slot: number, c: number): number {
		const n = this.points.length / 3
		const idx = (i * 3 + slot) % n
		return this.points[idx * 3 + c]
	}

	eval(out: Vec3, t: number): Vec3 {
		const u = clamp(t, 0, 1) * this.segments
		const i = Math.min(Math.floor(u), this.segments - 1)
		const s = u - i
		const m = 1 - s
		const b0 = m * m * m
		const b1 = 3 * m * m * s
		const b2 = 3 * m * s * s
		const b3 = s * s * s
		for (let c = 0; c < 3; c++)
			out[c] = b0 * this.ctrl(i, 0, c) + b1 * this.ctrl(i, 1, c) + b2 * this.ctrl(i, 2, c) + b3 * this.ctrl(i, 3, c)
		return out
	}

	derivative(out: Vec3, t: number): Vec3 {
		const u = clamp(t, 0, 1) * this.segments
		const i = Math.min(Math.floor(u), this.segments - 1)
		const s = u - i
		const m = 1 - s
		const k = 3 * this.segments
		for (let c = 0; c < 3; c++) {
			const p0 = this.ctrl(i, 0, c)
			const p1 = this.ctrl(i, 1, c)
			const p2 = this.ctrl(i, 2, c)
			const p3 = this.ctrl(i, 3, c)
			out[c] = (m * m * (p1 - p0) + 2 * m * s * (p2 - p1) + s * s * (p3 - p2)) * k
		}
		return out
	}

	secondDerivative(out: Vec3, t: number): Vec3 {
		const u = clamp(t, 0, 1) * this.segments
		const i = Math.min(Math.floor(u), this.segments - 1)
		const s = u - i
		const m = 1 - s
		const k = 6 * this.segments * this.segments
		for (let c = 0; c < 3; c++) {
			const p0 = this.ctrl(i, 0, c)
			const p1 = this.ctrl(i, 1, c)
			const p2 = this.ctrl(i, 2, c)
			const p3 = this.ctrl(i, 3, c)
			out[c] = (m * (p2 - 2 * p1 + p0) + s * (p3 - 2 * p2 + p1)) * k
		}
		return out
	}
}

// ---------------------------------------------------------------------------
// Arc-length reparameterisation
// ---------------------------------------------------------------------------

const apA = vec3()
const apB = vec3()

/**
 * Wraps a curve with a chord-length table so it can be walked in world units.
 *
 * Uniform steps in `t` are **not** uniform steps along the curve: a Catmull-Rom segment
 * through tightly spaced controls covers far less ground per unit t than a long one, so a
 * road lofted in parameter space bunches its cross-sections on every bend and stretches
 * them on the straights. The bunching shows up as banded shading and as tread decals that
 * change size along the road.
 *
 * The table is chords, not an exact integral. Error is O(h²) and 24 samples per segment
 * puts it far below a millimetre at road scale — cheaper and steadier than a quadrature
 * whose sample positions would shift with the control polygon.
 */
export class ArcPath {
	readonly curve: Curve
	readonly length: number
	private readonly ts: Float64Array
	private readonly ss: Float64Array

	constructor(curve: Curve, samplesPerSegment = 24) {
		this.curve = curve
		const n = Math.max(2, Math.round(samplesPerSegment)) * curve.segments + 1
		this.ts = new Float64Array(n)
		this.ss = new Float64Array(n)
		let acc = 0
		curve.eval(apA, 0)
		for (let i = 1; i < n; i++) {
			const t = i / (n - 1)
			curve.eval(apB, t)
			acc += Math.hypot(apB[0] - apA[0], apB[1] - apA[1], apB[2] - apA[2])
			apA[0] = apB[0]
			apA[1] = apB[1]
			apA[2] = apB[2]
			this.ts[i] = t
			this.ss[i] = acc
		}
		this.length = acc
	}

	get closed(): boolean {
		return this.curve.closed
	}

	/** Curve parameter at arc distance `s`, by binary search plus linear interpolation. */
	tAt(s: number): number {
		const target = clamp(s, 0, this.length)
		let lo = 0
		let hi = this.ss.length - 1
		while (hi - lo > 1) {
			const mid = (lo + hi) >> 1
			if (this.ss[mid] <= target) lo = mid
			else hi = mid
		}
		const s0 = this.ss[lo]
		const s1 = this.ss[hi]
		const d = s1 - s0
		const f = d > EPS ? (target - s0) / d : 0
		return this.ts[lo] + (this.ts[hi] - this.ts[lo]) * f
	}

	pointAt(out: Vec3, s: number): Vec3 {
		return this.curve.eval(out, this.tAt(s))
	}

	/** Unit tangent at arc distance `s`. */
	tangentAt(out: Vec3, s: number): Vec3 {
		const t = this.tAt(s)
		this.curve.derivative(out, t)
		const l = Math.hypot(out[0], out[1], out[2])
		if (l > EPS) {
			out[0] /= l
			out[1] /= l
			out[2] /= l
			return out
		}
		// A stationary point (coincident controls) has no derivative; fall back to a secant.
		// The step widens because a *whole* segment can be degenerate — duplicated end
		// controls are a normal way to pin a spline, and a secant inside that segment is
		// exactly zero however small the step.
		for (let h = 1e-4; h <= 0.5; h *= 8) {
			this.curve.eval(apA, clamp(t - h, 0, 1))
			this.curve.eval(apB, clamp(t + h, 0, 1))
			v3.sub(out, apB, apA)
			if (v3.lenSq(out) > 1e-18) return v3.normalize(out, out)
		}
		return v3.set(out, 0, 0, 0)
	}
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/**
 * A station set: one orthonormal frame per cross-section. The lofter requires that
 * `tangent` points in the direction of increasing station index and that (normal, binormal,
 * tangent) is a consistent basis — handedness may be either, and is measured, not assumed.
 */
export interface Frames {
	readonly count: number
	/** 3 per station. */
	readonly positions: Float32Array
	readonly tangents: Float32Array
	readonly normals: Float32Array
	readonly binormals: Float32Array
	/** Arc length at each station; drives the lofted V coordinate. */
	readonly distances: Float64Array
}

export interface FrameOptions {
	/**
	 * 'transport' (default) is a rotation-minimising frame. 'frenet' twists the geometry:
	 * its normal points along the curvature vector, so it swings 180° through every
	 * inflection point and is undefined on a straight run. A Frenet-lofted road corkscrews
	 * at the exact places a road is flattest. Use it only when the curvature direction is
	 * the point (a banked track, a pipe that must stay in its bend plane).
	 */
	kind?: 'transport' | 'frenet'
	/** Seeds the first normal. Defaults to world up (+Z). */
	upHint?: Vec3
	/** Extra roll, in radians, distributed linearly along the path. */
	twist?: number
}

function allocFrames(count: number): Frames {
	return {
		count,
		positions: new Float32Array(count * 3),
		tangents: new Float32Array(count * 3),
		normals: new Float32Array(count * 3),
		binormals: new Float32Array(count * 3),
		distances: new Float64Array(count),
	}
}

/** A unit vector perpendicular to `axis`, chosen deterministically. Safe when out === axis. */
function perpendicular(out: Vec3, axis: Vec3): Vec3 {
	// Read the axis into locals first: callers pass the same array as both arguments.
	const x = axis[0]
	const y = axis[1]
	const z = axis[2]
	const ax = Math.abs(x)
	const ay = Math.abs(y)
	const az = Math.abs(z)
	// Cross with whichever world axis is least parallel — the cross of two near-parallel
	// vectors is dominated by rounding, and that becomes a randomly rolled profile.
	let wx = 0
	let wy = 0
	let wz = 0
	if (az <= ax && az <= ay) wz = 1
	else if (ay <= ax) wy = 1
	else wx = 1
	out[0] = wy * z - wz * y
	out[1] = wz * x - wx * z
	out[2] = wx * y - wy * x
	const l = Math.hypot(out[0], out[1], out[2])
	if (l < EPS) return v3.set(out, 1, 0, 0)
	out[0] /= l
	out[1] /= l
	out[2] /= l
	return out
}

const fT = vec3()
const fN = vec3()
const fUp = vec3()

/**
 * Samples `count` frames at equal arc-length spacing.
 *
 * Parallel transport is computed with the double-reflection method (Wang et al. 2008): two
 * reflections per station, fourth-order accurate, and free of the drift an incremental
 * axis-angle rotation accumulates over a long road.
 *
 * On a closed path the transported frame does not generally return to its starting normal —
 * that residual is the loop's holonomy, and left alone it puts a visible twist step at the
 * seam. It is measured and unwound linearly along the path, so the seam matches exactly.
 */
export function sampleFrames(path: ArcPath, count: number, opts: FrameOptions = {}): Frames {
	if (count < 2) throw new Error('geo/spline: a frame set needs at least 2 stations')
	const f = allocFrames(count)
	const L = path.length
	const closed = path.closed
	for (let i = 0; i < count; i++) {
		const s = (i / (count - 1)) * L
		f.distances[i] = s
		path.pointAt(fT, s)
		f.positions[i * 3] = fT[0]
		f.positions[i * 3 + 1] = fT[1]
		f.positions[i * 3 + 2] = fT[2]
		path.tangentAt(fT, s)
		f.tangents[i * 3] = fT[0]
		f.tangents[i * 3 + 1] = fT[1]
		f.tangents[i * 3 + 2] = fT[2]
	}
	repairTangents(f)

	if (opts.upHint) v3.copy(fUp, opts.upHint)
	else v3.set(fUp, 0, 0, 1)

	// Seed normal: the up hint with the tangent component removed, or any perpendicular
	// when the path runs straight up a mast and the hint is parallel to it.
	v3.set(fT, f.tangents[0], f.tangents[1], f.tangents[2])
	const d0 = v3.dot(fUp, fT)
	v3.set(fN, fUp[0] - fT[0] * d0, fUp[1] - fT[1] * d0, fUp[2] - fT[2] * d0)
	if (v3.lenSq(fN) < 1e-10) perpendicular(fN, fT)
	else v3.normalize(fN, fN)
	f.normals[0] = fN[0]
	f.normals[1] = fN[1]
	f.normals[2] = fN[2]

	if ((opts.kind ?? 'transport') === 'frenet') frenetNormals(f, path)
	else transportNormals(f)

	// Roll: user twist plus the unwound closed-loop residual.
	let residual = 0
	if (closed) {
		const n0x = f.normals[0]
		const n0y = f.normals[1]
		const n0z = f.normals[2]
		const li = (count - 1) * 3
		const cosA = clamp(f.normals[li] * n0x + f.normals[li + 1] * n0y + f.normals[li + 2] * n0z, -1, 1)
		const cx = f.normals[li + 1] * n0z - f.normals[li + 2] * n0y
		const cy = f.normals[li + 2] * n0x - f.normals[li] * n0z
		const cz = f.normals[li] * n0y - f.normals[li + 1] * n0x
		const sinA = cx * f.tangents[li] + cy * f.tangents[li + 1] + cz * f.tangents[li + 2]
		residual = Math.atan2(sinA, cosA)
	}
	const twist = opts.twist ?? 0
	const invL = L > EPS ? 1 / L : 0
	for (let i = 0; i < count; i++) {
		const k = f.distances[i] * invL
		const a = twist * k + residual * k
		const i3 = i * 3
		const tx = f.tangents[i3]
		const ty = f.tangents[i3 + 1]
		const tz = f.tangents[i3 + 2]
		let nx = f.normals[i3]
		let ny = f.normals[i3 + 1]
		let nz = f.normals[i3 + 2]
		if (a !== 0) {
			// Rodrigues about the tangent; n ⊥ t so the parallel term drops out.
			const c = Math.cos(a)
			const s = Math.sin(a)
			const kx = ty * nz - tz * ny
			const ky = tz * nx - tx * nz
			const kz = tx * ny - ty * nx
			nx = nx * c + kx * s
			ny = ny * c + ky * s
			nz = nz * c + kz * s
			const l = Math.hypot(nx, ny, nz) || 1
			nx /= l
			ny /= l
			nz /= l
			f.normals[i3] = nx
			f.normals[i3 + 1] = ny
			f.normals[i3 + 2] = nz
		}
		f.binormals[i3] = ty * nz - tz * ny
		f.binormals[i3 + 1] = tz * nx - tx * nz
		f.binormals[i3 + 2] = tx * ny - ty * nx
	}
	return f
}

/**
 * Every frame must have a usable tangent, because the loft's normals and its winding both
 * hang off it. A whole degenerate segment (duplicated control points, a legitimate way to
 * pin a spline end) leaves one, so the nearest valid neighbour is copied in.
 */
function repairTangents(f: Frames): void {
	const t = f.tangents
	let valid = -1
	for (let i = 0; i < f.count; i++) {
		const i3 = i * 3
		if (t[i3] * t[i3] + t[i3 + 1] * t[i3 + 1] + t[i3 + 2] * t[i3 + 2] > 0.25) {
			valid = i
			continue
		}
		if (valid >= 0) {
			t[i3] = t[valid * 3]
			t[i3 + 1] = t[valid * 3 + 1]
			t[i3 + 2] = t[valid * 3 + 2]
		}
	}
	if (valid < 0) {
		// No station had a tangent at all: the whole path is a point. Pick one so the caller
		// gets a degenerate-but-finite mesh instead of NaN geometry.
		for (let i = 0; i < f.count; i++) t[i * 3 + 2] = 1
		return
	}
	// Backwards pass for the leading stations, which had no valid predecessor.
	for (let i = f.count - 2; i >= 0; i--) {
		const i3 = i * 3
		if (t[i3] * t[i3] + t[i3 + 1] * t[i3 + 1] + t[i3 + 2] * t[i3 + 2] > 0.25) continue
		t[i3] = t[i3 + 3]
		t[i3 + 1] = t[i3 + 4]
		t[i3 + 2] = t[i3 + 5]
	}
}

function transportNormals(f: Frames): void {
	const pos = f.positions
	const tan = f.tangents
	const nrm = f.normals
	for (let i = 1; i < f.count; i++) {
		const a = (i - 1) * 3
		const b = i * 3
		const v1x = pos[b] - pos[a]
		const v1y = pos[b + 1] - pos[a + 1]
		const v1z = pos[b + 2] - pos[a + 2]
		let rx = nrm[a]
		let ry = nrm[a + 1]
		let rz = nrm[a + 2]
		let tx = tan[a]
		let ty = tan[a + 1]
		let tz = tan[a + 2]
		const c1 = v1x * v1x + v1y * v1y + v1z * v1z
		if (c1 > EPS) {
			const f1 = 2 / c1
			const d1 = f1 * (v1x * rx + v1y * ry + v1z * rz)
			rx -= d1 * v1x
			ry -= d1 * v1y
			rz -= d1 * v1z
			const d2 = f1 * (v1x * tx + v1y * ty + v1z * tz)
			tx -= d2 * v1x
			ty -= d2 * v1y
			tz -= d2 * v1z
		}
		const v2x = tan[b] - tx
		const v2y = tan[b + 1] - ty
		const v2z = tan[b + 2] - tz
		const c2 = v2x * v2x + v2y * v2y + v2z * v2z
		if (c2 > EPS) {
			const f2 = 2 / c2
			const d3 = f2 * (v2x * rx + v2y * ry + v2z * rz)
			rx -= d3 * v2x
			ry -= d3 * v2y
			rz -= d3 * v2z
		}
		// Re-orthogonalise: the reflections are exact in theory, but f32 station data drifts
		// over a few hundred stations and the drift lands in the lofted silhouette.
		const dt = rx * tan[b] + ry * tan[b + 1] + rz * tan[b + 2]
		rx -= tan[b] * dt
		ry -= tan[b + 1] * dt
		rz -= tan[b + 2] * dt
		const l = Math.hypot(rx, ry, rz)
		if (l > EPS) {
			nrm[b] = rx / l
			nrm[b + 1] = ry / l
			nrm[b + 2] = rz / l
		} else {
			nrm[b] = nrm[a]
			nrm[b + 1] = nrm[a + 1]
			nrm[b + 2] = nrm[a + 2]
		}
	}
}

const frD2 = vec3()

function frenetNormals(f: Frames, path: ArcPath): void {
	const nrm = f.normals
	for (let i = 0; i < f.count; i++) {
		const i3 = i * 3
		const t = path.tAt(f.distances[i])
		path.curve.secondDerivative(frD2, t)
		const tx = f.tangents[i3]
		const ty = f.tangents[i3 + 1]
		const tz = f.tangents[i3 + 2]
		const d = frD2[0] * tx + frD2[1] * ty + frD2[2] * tz
		let nx = frD2[0] - tx * d
		let ny = frD2[1] - ty * d
		let nz = frD2[2] - tz * d
		const l = Math.hypot(nx, ny, nz)
		if (l < 1e-7) {
			// Zero curvature — the Frenet normal is undefined. Carry the previous frame's
			// normal rather than emitting a NaN basis on every straight section.
			const src = i > 0 ? i3 - 3 : 0
			nx = nrm[src]
			ny = nrm[src + 1]
			nz = nrm[src + 2]
			const dd = nx * tx + ny * ty + nz * tz
			nx -= tx * dd
			ny -= ty * dd
			nz -= tz * dd
			const l2 = Math.hypot(nx, ny, nz)
			if (l2 < 1e-7) {
				v3.set(fN, tx, ty, tz)
				perpendicular(fN, fN)
				nx = fN[0]
				ny = fN[1]
				nz = fN[2]
			} else {
				nx /= l2
				ny /= l2
				nz /= l2
			}
		} else {
			nx /= l
			ny /= l
			nz /= l
		}
		nrm[i3] = nx
		nrm[i3 + 1] = ny
		nrm[i3 + 2] = nz
	}
}

// ---------------------------------------------------------------------------
// Ring template — the profile resolved once into per-vertex shading data
// ---------------------------------------------------------------------------

interface RingTemplate {
	/** Template entries. More than the profile has points wherever a corner is hard. */
	count: number
	x: Float64Array
	y: Float64Array
	/** 2D outward normal of the entry. */
	nx: Float64Array
	ny: Float64Array
	u: Float64Array
	/** Profile point this entry came from — indexes mx/my and the cap vertices. */
	src: Uint32Array
	zone: Uint8Array
	edgeA: Uint32Array
	edgeB: Uint32Array
	edgeCount: number
	/** Per profile point: miter direction, shared by both entries of a hard corner. */
	mx: Float64Array
	my: Float64Array
	pointCount: number
	perimeter: number
}

/**
 * Splits the profile at hard corners so each side of a corner carries its own normal, and
 * always at the seam of a closed profile so U runs 0→perimeter instead of wrapping.
 *
 * Splitting here rather than smoothing later is what gives a Foundry beam a crisp edge and
 * a Lattice fairing a smooth one from the same code path: the profile decides.
 */
function buildRing(
	p: Profile2D,
	closed: boolean,
	smoothAngle: number,
	uScale: number,
	zone: number,
	edgeZones: ArrayLike<number> | undefined,
	miterLimit: number,
): RingTemplate {
	const n = p.length >> 1
	const e = profileEdges(p, closed)
	const m = profileMiters(p, e, closed, miterLimit)
	const cosSmooth = Math.cos(clamp(smoothAngle, 0, Math.PI))
	const max = 2 * n + 2
	const x = new Float64Array(max)
	const y = new Float64Array(max)
	const nx = new Float64Array(max)
	const ny = new Float64Array(max)
	const u = new Float64Array(max)
	const src = new Uint32Array(max)
	const zn = new Uint8Array(max)
	const startOf = new Uint32Array(e.count)
	const endOf = new Uint32Array(e.count)
	let cnt = 0

	const push = (k: number, enx: number, eny: number, uu: number, z: number): number => {
		x[cnt] = p[k * 2]
		y[cnt] = p[k * 2 + 1]
		nx[cnt] = enx
		ny[cnt] = eny
		u[cnt] = uu * uScale
		src[cnt] = k
		zn[cnt] = z
		return cnt++
	}
	const zoneOf = (edge: number): number => (edgeZones ? edgeZones[edge] | 0 : zone)

	for (let k = 0; k < n; k++) {
		const hasPrev = closed || k > 0
		const hasNext = closed || k < e.count
		if (!hasPrev) {
			startOf[0] = push(k, e.nx[0], e.ny[0], e.cum[0], zoneOf(0))
			continue
		}
		if (!hasNext) {
			const ep = e.count - 1
			endOf[ep] = push(k, e.nx[ep], e.ny[ep], e.cum[k], zoneOf(ep))
			continue
		}
		const ep = (k - 1 + e.count) % e.count
		const en = k % e.count
		const zp = zoneOf(ep)
		const zc = zoneOf(en)
		const dot = e.nx[ep] * e.nx[en] + e.ny[ep] * e.ny[en]
		// The seam always splits: its two entries share a position but differ in U. A
		// material-zone change always splits too — a zone boundary is a texture boundary.
		const seam = closed && k === 0
		const smooth = zp === zc && dot >= cosSmooth
		let ax = e.nx[en]
		let ay = e.ny[en]
		if (smooth) {
			ax = e.nx[ep] + e.nx[en]
			ay = e.ny[ep] + e.ny[en]
			const l = Math.hypot(ax, ay)
			if (l > EPS) {
				ax /= l
				ay /= l
			} else {
				ax = e.nx[en]
				ay = e.ny[en]
			}
		}
		if (smooth && !seam) {
			const id = push(k, ax, ay, e.cum[k], zc)
			endOf[ep] = id
			startOf[en] = id
		} else if (smooth) {
			// A smooth seam splits for U but keeps one averaged normal on both sides. Giving
			// each side its own face normal would put a visible shading crease down the one
			// column of a cylinder where the texture happens to wrap.
			endOf[ep] = push(k, ax, ay, e.cum[e.count], zp)
			startOf[en] = push(k, ax, ay, e.cum[k], zc)
		} else {
			endOf[ep] = push(k, e.nx[ep], e.ny[ep], seam ? e.cum[e.count] : e.cum[k], zp)
			startOf[en] = push(k, e.nx[en], e.ny[en], e.cum[k], zc)
		}
	}

	const edgeA = new Uint32Array(e.count)
	const edgeB = new Uint32Array(e.count)
	for (let i = 0; i < e.count; i++) {
		edgeA[i] = startOf[i]
		edgeB[i] = endOf[i]
	}
	return {
		count: cnt,
		x: x.subarray(0, cnt),
		y: y.subarray(0, cnt),
		nx: nx.subarray(0, cnt),
		ny: ny.subarray(0, cnt),
		u: u.subarray(0, cnt),
		src: src.subarray(0, cnt),
		zone: zn.subarray(0, cnt),
		edgeA,
		edgeB,
		edgeCount: e.count,
		mx: m.mx,
		my: m.my,
		pointCount: n,
		perimeter: e.cum[e.count],
	}
}

// ---------------------------------------------------------------------------
// The loft core — every mesh in this file is emitted through here
// ---------------------------------------------------------------------------

interface CoreParams {
	profile: Profile2D
	closedProfile: boolean
	caps: boolean
	capZone: number
	capUvScale: number
	flipFaces: boolean
	scaleX: Float64Array
	scaleY: Float64Array
	roll: Float64Array
	offset: Float64Array
	v: Float64Array
}

/**
 * Sweeps a ring template through a frame set.
 *
 * Two passes over the vertices. The first writes positions; the second derives normals from
 * the geometry that pass actually produced — the cross of the ring tangent with the
 * along-path finite difference. Doing it that way rather than rotating the 2D normal into
 * the frame is what makes taper shade correctly: a draft angle or a per-station scale tilts
 * the surface, and a cone lofted with rotated 2D normals shades exactly like a cylinder.
 *
 * Neither pass allocates: both walk preallocated typed arrays with scalar locals.
 */
function loftCore(tpl: RingTemplate, f: Frames, prm: CoreParams): Mesh {
	const stations = f.count
	const ring = tpl.count
	const faceSign = prm.flipFaces ? -1 : 1

	// Handedness is measured, not assumed: revolve frames are left-handed relative to a
	// swept path's, and the winding and the normal sign both follow from this one number.
	const n0x = f.normals[0]
	const n0y = f.normals[1]
	const n0z = f.normals[2]
	const b0x = f.binormals[0]
	const b0y = f.binormals[1]
	const b0z = f.binormals[2]
	const cx = n0y * b0z - n0z * b0y
	const cy = n0z * b0x - n0x * b0z
	const cz = n0x * b0y - n0y * b0x
	const baseHand = cx * f.tangents[0] + cy * f.tangents[1] + cz * f.tangents[2] >= 0 ? 1 : -1
	const hand = baseHand * faceSign

	let capTris: Uint32Array | null = null
	if (prm.caps && prm.closedProfile) capTris = triangulate(prm.profile)
	const capTriCount = capTris ? capTris.length / 3 : 0
	const capVerts = capTris ? tpl.pointCount * 2 : 0

	const vertexCount = stations * ring + capVerts
	const positions = new Float32Array(vertexCount * 3)
	const normals = new Float32Array(vertexCount * 3)
	const uvs = new Float32Array(vertexCount * 2)
	const zones = new Uint8Array(vertexCount)
	const maxTris = (stations - 1) * tpl.edgeCount * 2 + capTriCount * 2
	const indices = new Uint32Array(maxTris * 3)

	// --- pass 1: positions, UVs, zones
	for (let i = 0; i < stations; i++) {
		const i3 = i * 3
		const ox = f.positions[i3]
		const oy = f.positions[i3 + 1]
		const oz = f.positions[i3 + 2]
		const r = prm.roll[i]
		const cr = Math.cos(r)
		const sr = Math.sin(r)
		const axx = f.normals[i3] * cr + f.binormals[i3] * sr
		const axy = f.normals[i3 + 1] * cr + f.binormals[i3 + 1] * sr
		const axz = f.normals[i3 + 2] * cr + f.binormals[i3 + 2] * sr
		const ayx = -f.normals[i3] * sr + f.binormals[i3] * cr
		const ayy = -f.normals[i3 + 1] * sr + f.binormals[i3 + 1] * cr
		const ayz = -f.normals[i3 + 2] * sr + f.binormals[i3 + 2] * cr
		const sx = prm.scaleX[i]
		const sy = prm.scaleY[i]
		const d = prm.offset[i]
		const vv = prm.v[i]
		for (let k = 0; k < ring; k++) {
			const s = tpl.src[k]
			// Offset first, scale second: a draft is a distance in profile units, and
			// scaling it would make the taper depend on the station's own scale.
			const px = (tpl.x[k] + tpl.mx[s] * d) * sx
			const py = (tpl.y[k] + tpl.my[s] * d) * sy
			const vi = i * ring + k
			positions[vi * 3] = ox + axx * px + ayx * py
			positions[vi * 3 + 1] = oy + axy * px + ayy * py
			positions[vi * 3 + 2] = oz + axz * px + ayz * py
			uvs[vi * 2] = tpl.u[k]
			uvs[vi * 2 + 1] = vv
			zones[vi] = tpl.zone[k]
		}
	}

	// --- pass 2: normals from the emitted geometry
	for (let i = 0; i < stations; i++) {
		const i3 = i * 3
		const r = prm.roll[i]
		const cr = Math.cos(r)
		const sr = Math.sin(r)
		const axx = f.normals[i3] * cr + f.binormals[i3] * sr
		const axy = f.normals[i3 + 1] * cr + f.binormals[i3 + 1] * sr
		const axz = f.normals[i3 + 2] * cr + f.binormals[i3 + 2] * sr
		const ayx = -f.normals[i3] * sr + f.binormals[i3] * cr
		const ayy = -f.normals[i3 + 1] * sr + f.binormals[i3 + 1] * cr
		const ayz = -f.normals[i3 + 2] * sr + f.binormals[i3 + 2] * cr
		const sx = prm.scaleX[i]
		const sy = prm.scaleY[i]
		const prevRow = (i > 0 ? i - 1 : i) * ring
		const nextRow = (i < stations - 1 ? i + 1 : i) * ring
		for (let k = 0; k < ring; k++) {
			const vi = i * ring + k
			// Ring tangent: the 2D normal turned 90°, i.e. the profile edge direction, with
			// each component scaled as the station scales it.
			const rtx2 = -tpl.ny[k] * sx
			const rty2 = tpl.nx[k] * sy
			const rx = axx * rtx2 + ayx * rty2
			const ry = axy * rtx2 + ayy * rty2
			const rz = axz * rtx2 + ayz * rty2
			const px = positions[(nextRow + k) * 3] - positions[(prevRow + k) * 3]
			const py = positions[(nextRow + k) * 3 + 1] - positions[(prevRow + k) * 3 + 1]
			const pz = positions[(nextRow + k) * 3 + 2] - positions[(prevRow + k) * 3 + 2]
			let nx = (ry * pz - rz * py) * hand
			let ny = (rz * px - rx * pz) * hand
			let nz = (rx * py - ry * px) * hand
			let l = Math.hypot(nx, ny, nz)
			if (l < 1e-12) {
				// The vertex did not move between stations — a lathe point on the axis, or a
				// zero-length station step. Fall back to the analytic normal, inverse-scaled
				// because a non-uniform scale transforms normals by the inverse transpose.
				const inx = sx !== 0 ? tpl.nx[k] / sx : tpl.nx[k]
				const iny = sy !== 0 ? tpl.ny[k] / sy : tpl.ny[k]
				nx = (axx * inx + ayx * iny) * faceSign
				ny = (axy * inx + ayy * iny) * faceSign
				nz = (axz * inx + ayz * iny) * faceSign
				l = Math.hypot(nx, ny, nz)
				if (l < 1e-12) {
					nx = 0
					ny = 0
					nz = 1
					l = 1
				}
			}
			normals[vi * 3] = nx / l
			normals[vi * 3 + 1] = ny / l
			normals[vi * 3 + 2] = nz / l
		}
	}

	// --- sides
	let ic = 0
	const emit = (a: number, b: number, c: number): void => {
		// Zero-area triangles are dropped, not shipped: a lathe collapses a whole quad row
		// at a pole, and those degenerates cost setup on every draw for no pixels.
		const ax = positions[a * 3]
		const ay = positions[a * 3 + 1]
		const az = positions[a * 3 + 2]
		const ux = positions[b * 3] - ax
		const uy = positions[b * 3 + 1] - ay
		const uz = positions[b * 3 + 2] - az
		const wx = positions[c * 3] - ax
		const wy = positions[c * 3 + 1] - ay
		const wz = positions[c * 3 + 2] - az
		const nx = uy * wz - uz * wy
		const ny = uz * wx - ux * wz
		const nz = ux * wy - uy * wx
		if (nx * nx + ny * ny + nz * nz < 1e-24) return
		indices[ic++] = a
		indices[ic++] = b
		indices[ic++] = c
	}

	for (let i = 0; i < stations - 1; i++) {
		const base0 = i * ring
		const base1 = (i + 1) * ring
		for (let e = 0; e < tpl.edgeCount; e++) {
			const a = tpl.edgeA[e]
			const b = tpl.edgeB[e]
			const v00 = base0 + a
			const v01 = base0 + b
			const v10 = base1 + a
			const v11 = base1 + b
			if (hand > 0) {
				emit(v00, v01, v11)
				emit(v00, v11, v10)
			} else {
				emit(v00, v11, v01)
				emit(v00, v10, v11)
			}
		}
	}

	// --- caps
	if (capTris) {
		const np = tpl.pointCount
		const capBase = stations * ring
		for (let side = 0; side < 2; side++) {
			const st = side === 0 ? 0 : stations - 1
			const i3 = st * 3
			const r = prm.roll[st]
			const cr = Math.cos(r)
			const sr = Math.sin(r)
			const axx = f.normals[i3] * cr + f.binormals[i3] * sr
			const axy = f.normals[i3 + 1] * cr + f.binormals[i3 + 1] * sr
			const axz = f.normals[i3 + 2] * cr + f.binormals[i3 + 2] * sr
			const ayx = -f.normals[i3] * sr + f.binormals[i3] * cr
			const ayy = -f.normals[i3 + 1] * sr + f.binormals[i3 + 1] * cr
			const ayz = -f.normals[i3 + 2] * sr + f.binormals[i3 + 2] * cr
			const sx = prm.scaleX[st]
			const sy = prm.scaleY[st]
			const d = prm.offset[st]
			// A cap is planar and faces along the path: back at the start, forward at the end.
			const sgn = (side === 0 ? -1 : 1) * faceSign
			const off = capBase + side * np
			for (let k = 0; k < np; k++) {
				const px = (prm.profile[k * 2] + tpl.mx[k] * d) * sx
				const py = (prm.profile[k * 2 + 1] + tpl.my[k] * d) * sy
				const vi = off + k
				positions[vi * 3] = f.positions[i3] + axx * px + ayx * py
				positions[vi * 3 + 1] = f.positions[i3 + 1] + axy * px + ayy * py
				positions[vi * 3 + 2] = f.positions[i3 + 2] + axz * px + ayz * py
				normals[vi * 3] = f.tangents[i3] * sgn
				normals[vi * 3 + 1] = f.tangents[i3 + 1] * sgn
				normals[vi * 3 + 2] = f.tangents[i3 + 2] * sgn
				// Planar projection in profile space — the only projection a cap can have
				// that stays consistent with the profile's own scale.
				uvs[vi * 2] = px * prm.capUvScale
				uvs[vi * 2 + 1] = py * prm.capUvScale
				zones[vi] = prm.capZone
			}
			// triangulate() winds CCW in profile space, which faces normal x binormal.
			const forward = side === 1 ? hand > 0 : hand < 0
			for (let t = 0; t < capTriCount; t++) {
				const a = off + capTris[t * 3]
				const b = off + capTris[t * 3 + 1]
				const c = off + capTris[t * 3 + 2]
				if (forward) emit(a, b, c)
				else emit(c, b, a)
			}
		}
	}

	return buildMesh(positions, normals, uvs, zones, indices.slice(0, ic))
}

/**
 * The one place this file names a field of `Mesh` (geo/mesh is another node's file — rule 1,
 * so its container is assumed, not imported as a value). If the container changes shape,
 * this function is the only edit.
 */
function buildMesh(
	positions: Float32Array,
	normals: Float32Array,
	uvs: Float32Array,
	materialZone: Uint8Array,
	indices: Uint32Array,
): Mesh {
	const vertexCount = (positions.length / 3) | 0
	const triangleCount = (indices.length / 3) | 0

	// Built through the public API rather than by assigning the buffers directly: Mesh
	// tracks capacity, vertex/triangle counts and bounds internally, and a mesh whose
	// arrays were swapped in behind its back reports vertexCount 0 to every consumer.
	const mesh = new Mesh(vertexCount, triangleCount)
	for (let i = 0; i < vertexCount; i++) {
		const p = i * 3
		const t = i * 2
		mesh.addVertex(
			positions[p], positions[p + 1], positions[p + 2],
			normals[p], normals[p + 1], normals[p + 2],
			uvs[t], uvs[t + 1],
			materialZone[i],
		)
	}
	for (let i = 0; i < triangleCount; i++) {
		const t = i * 3
		mesh.addTriangle(indices[t], indices[t + 1], indices[t + 2])
	}
	return mesh
}

// ---------------------------------------------------------------------------
// Public sweeps
// ---------------------------------------------------------------------------

export interface LoftOptions {
	/** Station count. Defaults to 8 per curve segment, or derived from `spacing`. */
	stations?: number
	/** Target arc-length spacing between stations, in world units. */
	spacing?: number
	closedProfile?: boolean
	closedPath?: boolean
	/** Defaults to true for a closed profile on an open path. */
	caps?: boolean
	/** Corners sharper than this get split normals. Default 40°. */
	smoothAngle?: number
	scale?: StationValue
	scaleX?: StationValue
	scaleY?: StationValue
	/** Radians of roll about the path tangent, per station. */
	roll?: StationValue
	/** Miter offset applied to the profile, per station — a taper that keeps edges parallel. */
	offset?: StationValue
	/** `twist`, `upHint` and `frames` configure frame *sampling*, so they are read by
	 * `loftProfile` and ignored by `loftFrames`, whose frames already exist. */
	twist?: number
	upHint?: Vec3
	frames?: 'transport' | 'frenet'
	/** U per world unit around the profile. Pass 1/perimeter for a normalised U. */
	uScale?: number
	/** V per world unit along the path. */
	vScale?: number
	capUvScale?: number
	materialZone?: number
	/** One zone per profile edge; a zone change forces a hard split. */
	edgeZones?: ArrayLike<number>
	capZone?: number
	miterLimit?: number
	/** Reverses winding and normals — for the inside of a tunnel or a pipe. */
	flipFaces?: boolean
}

function resolveStations(dst: Float64Array, value: StationValue | undefined, count: number, fallback: number): void {
	if (value === undefined) {
		dst.fill(fallback)
		return
	}
	if (typeof value === 'number') {
		dst.fill(value)
		return
	}
	if (typeof value === 'function') {
		for (let i = 0; i < count; i++) dst[i] = value(i, count > 1 ? i / (count - 1) : 0)
		return
	}
	if (value.length !== count)
		throw new Error(`geo/spline: per-station array has ${value.length} entries, expected ${count}`)
	for (let i = 0; i < count; i++) dst[i] = value[i]
}

/** Sweeps a profile through an explicit frame set. `loftProfile` is this plus sampling. */
export function loftFrames(profile: Profile2D, frames: Frames, opts: LoftOptions = {}): Mesh {
	const closedProfile = opts.closedProfile ?? true
	const count = frames.count
	if (count < 2) throw new Error('geo/spline: a loft needs at least 2 stations')
	const src = closedProfile ? ensureWinding(profile, true) : profile
	const tpl = buildRing(
		src,
		closedProfile,
		opts.smoothAngle ?? DEFAULT_SMOOTH_ANGLE,
		opts.uScale ?? 1,
		opts.materialZone ?? 0,
		opts.edgeZones,
		opts.miterLimit ?? 8,
	)
	const scaleX = new Float64Array(count)
	const scaleY = new Float64Array(count)
	const roll = new Float64Array(count)
	const offset = new Float64Array(count)
	const v = new Float64Array(count)
	resolveStations(scaleX, opts.scaleX ?? opts.scale, count, 1)
	resolveStations(scaleY, opts.scaleY ?? opts.scale, count, 1)
	resolveStations(roll, opts.roll, count, 0)
	resolveStations(offset, opts.offset, count, 0)
	const vScale = opts.vScale ?? 1
	for (let i = 0; i < count; i++) v[i] = frames.distances[i] * vScale
	const closedPath = opts.closedPath ?? false
	return loftCore(tpl, frames, {
		profile: src,
		closedProfile,
		// A closed path has no ends to cap, and an open profile has no loop to fill.
		caps: (opts.caps ?? true) && closedProfile && !closedPath,
		capZone: opts.capZone ?? opts.materialZone ?? 0,
		capUvScale: opts.capUvScale ?? 1,
		flipFaces: opts.flipFaces ?? false,
		scaleX,
		scaleY,
		roll,
		offset,
		v,
	})
}

/**
 * Sweeps a 2D profile along a path. Profile +x maps to the frame normal, +y to the binormal.
 *
 * Stations are placed by arc length, never by curve parameter — see `ArcPath`.
 */
export function loftProfile(profile: Profile2D, path: ArcPath, opts: LoftOptions = {}): Mesh {
	let stations = opts.stations ?? 0
	if (!stations && opts.spacing) stations = Math.max(2, Math.round(path.length / opts.spacing) + 1)
	if (!stations) stations = Math.max(2, path.curve.segments * 8 + 1)
	const frames = sampleFrames(path, stations, {
		kind: opts.frames ?? 'transport',
		upHint: opts.upHint,
		twist: opts.twist,
	})
	return loftFrames(profile, frames, { ...opts, stations, closedPath: opts.closedPath ?? path.closed })
}

export interface ExtrudeOptions {
	/** Radians. Positive widens the section as it rises; applied as a miter offset. */
	draft?: number
	/** Sweep direction. Defaults to world up (+Z). */
	axis?: Vec3
	origin?: Vec3
	/** Subdivisions along the height. More than 1 only matters with twist or scale. */
	steps?: number
	caps?: boolean
	closedProfile?: boolean
	smoothAngle?: number
	/** Uniform scale at the top, on top of the draft. */
	scaleTop?: number
	/** Total roll across the height, radians. */
	twist?: number
	uScale?: number
	vScale?: number
	capUvScale?: number
	materialZone?: number
	edgeZones?: ArrayLike<number>
	capZone?: number
	miterLimit?: number
	flipFaces?: boolean
}

const exAxis = vec3()
const exN = vec3()

/**
 * Extrudes a profile along a straight axis.
 *
 * The draft is a **miter offset**, not a scale: scaling a profile that is not centred on the
 * origin slides it sideways as it tapers, and every wall panel and plinth in the kit is
 * authored off-centre. Offsetting keeps every face's angle to the axis equal to the draft.
 */
export function extrude(profile: Profile2D, height: number, opts: ExtrudeOptions = {}): Mesh {
	const steps = Math.max(1, Math.round(opts.steps ?? 1))
	const count = steps + 1
	if (opts.axis) v3.normalize(exAxis, opts.axis)
	else v3.set(exAxis, 0, 0, 1)
	// A negative height extrudes the other way, which is a flipped axis and a positive
	// height — not a backwards tangent. The core derives normals from how the geometry
	// actually advances, so a tangent that disagreed with it would invert every side face.
	if (height < 0) {
		exAxis[0] = -exAxis[0]
		exAxis[1] = -exAxis[1]
		exAxis[2] = -exAxis[2]
		height = -height
	}
	perpendicular(exN, exAxis)
	const f = allocFrames(count)
	const bx = exAxis[1] * exN[2] - exAxis[2] * exN[1]
	const by = exAxis[2] * exN[0] - exAxis[0] * exN[2]
	const bz = exAxis[0] * exN[1] - exAxis[1] * exN[0]
	const ox = opts.origin ? opts.origin[0] : 0
	const oy = opts.origin ? opts.origin[1] : 0
	const oz = opts.origin ? opts.origin[2] : 0
	for (let i = 0; i < count; i++) {
		const h = (height * i) / steps
		const i3 = i * 3
		f.positions[i3] = ox + exAxis[0] * h
		f.positions[i3 + 1] = oy + exAxis[1] * h
		f.positions[i3 + 2] = oz + exAxis[2] * h
		f.tangents[i3] = exAxis[0]
		f.tangents[i3 + 1] = exAxis[1]
		f.tangents[i3 + 2] = exAxis[2]
		f.normals[i3] = exN[0]
		f.normals[i3 + 1] = exN[1]
		f.normals[i3 + 2] = exN[2]
		f.binormals[i3] = bx
		f.binormals[i3 + 1] = by
		f.binormals[i3 + 2] = bz
		f.distances[i] = h
	}
	const tan = Math.tan(opts.draft ?? 0)
	const scaleTop = opts.scaleTop ?? 1
	const twist = opts.twist ?? 0
	return loftFrames(profile, f, {
		closedProfile: opts.closedProfile ?? true,
		caps: opts.caps ?? true,
		smoothAngle: opts.smoothAngle,
		offset: (i) => tan * ((height * i) / steps),
		scale: (_i, t) => 1 + (scaleTop - 1) * t,
		roll: (_i, t) => twist * t,
		uScale: opts.uScale,
		vScale: opts.vScale,
		capUvScale: opts.capUvScale,
		materialZone: opts.materialZone,
		edgeZones: opts.edgeZones,
		capZone: opts.capZone,
		miterLimit: opts.miterLimit,
		flipFaces: opts.flipFaces,
	})
}

export interface RevolveOptions {
	/** A point on the axis. Default origin. */
	origin?: Vec3
	/** Where θ = 0 points. Defaults to a deterministic perpendicular of the axis. */
	refDir?: Vec3
	startAngle?: number
	/** Only meaningful for a partial revolve; a full turn has no ends. */
	caps?: boolean
	closedProfile?: boolean
	smoothAngle?: number
	uScale?: number
	vScale?: number
	capUvScale?: number
	materialZone?: number
	edgeZones?: ArrayLike<number>
	capZone?: number
	miterLimit?: number
	flipFaces?: boolean
}

const rvAxis = vec3()
const rvRef = vec3()
const rvSide = vec3()

/**
 * Lathes a profile around an axis. Profile +x is the radius, +y runs along the axis.
 *
 * This is the loft core with circular frames — the profile plane of a lathe already contains
 * the axis and the radius, which is exactly a cross-section perpendicular to the circular
 * sweep. Those frames come out left-handed relative to a swept path's, which the core
 * measures and compensates for rather than hard-coding a winding here.
 */
export function revolve(
	profile: Profile2D,
	axis: Vec3,
	angle: number,
	segments: number,
	opts: RevolveOptions = {},
): Mesh {
	const segs = Math.max(2, Math.round(segments))
	const count = segs + 1
	v3.normalize(rvAxis, axis)
	if (opts.refDir) {
		// Orthogonalised against the axis: a hint that is not perpendicular would otherwise
		// shear the whole lathe.
		const d = v3.dot(opts.refDir, rvAxis)
		v3.set(rvRef, opts.refDir[0] - rvAxis[0] * d, opts.refDir[1] - rvAxis[1] * d, opts.refDir[2] - rvAxis[2] * d)
		if (v3.lenSq(rvRef) < 1e-12) perpendicular(rvRef, rvAxis)
		else v3.normalize(rvRef, rvRef)
	} else perpendicular(rvRef, rvAxis)
	v3.cross(rvSide, rvAxis, rvRef)

	const ox = opts.origin ? opts.origin[0] : 0
	const oy = opts.origin ? opts.origin[1] : 0
	const oz = opts.origin ? opts.origin[2] : 0
	const start = opts.startAngle ?? 0

	// V is arc length at the profile's mean radius, so a lathed drum keeps the same texel
	// density as the lofted parts bolted to it.
	const np = profile.length >> 1
	let rMean = 0
	for (let k = 0; k < np; k++) rMean += Math.abs(profile[k * 2])
	rMean = np > 0 ? rMean / np : 1

	// The tangent must point the way the stations advance, or the core's finite-difference
	// normals come out inverted for a negative sweep.
	const sweepSign = angle >= 0 ? 1 : -1
	const f = allocFrames(count)
	for (let i = 0; i < count; i++) {
		const th = start + (angle * i) / segs
		const c = Math.cos(th)
		const s = Math.sin(th)
		const i3 = i * 3
		f.positions[i3] = ox
		f.positions[i3 + 1] = oy
		f.positions[i3 + 2] = oz
		f.normals[i3] = rvRef[0] * c + rvSide[0] * s
		f.normals[i3 + 1] = rvRef[1] * c + rvSide[1] * s
		f.normals[i3 + 2] = rvRef[2] * c + rvSide[2] * s
		f.binormals[i3] = rvAxis[0]
		f.binormals[i3 + 1] = rvAxis[1]
		f.binormals[i3 + 2] = rvAxis[2]
		f.tangents[i3] = (-rvRef[0] * s + rvSide[0] * c) * sweepSign
		f.tangents[i3 + 1] = (-rvRef[1] * s + rvSide[1] * c) * sweepSign
		f.tangents[i3 + 2] = (-rvRef[2] * s + rvSide[2] * c) * sweepSign
		f.distances[i] = Math.abs((angle * i) / segs) * rMean
	}

	const full = Math.abs(Math.abs(angle) - TWO_PI) < 1e-6
	return loftFrames(profile, f, {
		closedProfile: opts.closedProfile ?? true,
		closedPath: full,
		caps: (opts.caps ?? true) && !full,
		smoothAngle: opts.smoothAngle,
		uScale: opts.uScale,
		vScale: opts.vScale,
		capUvScale: opts.capUvScale,
		materialZone: opts.materialZone,
		edgeZones: opts.edgeZones,
		capZone: opts.capZone,
		miterLimit: opts.miterLimit,
		flipFaces: opts.flipFaces,
	})
}
