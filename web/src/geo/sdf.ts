// STEELSEED — geo/sdf
// Signed distance fields and isosurface extraction. This is the primary way STEELSEED
// builds hard-surface shapes: a tree of implicit primitives, booleaned and warped, then
// meshed once at generation time.
//
// Surface nets rather than marching cubes. The game is made of flat panelled surfaces, and
// MC emits a fixed triangle soup from a case table: it can only place vertices ON grid
// edges, so a box corner that does not land exactly on a lattice point is shattered into
// a staircase of slivers and can never be recovered. Surface nets places ONE vertex per
// cell, anywhere inside it, which means the vertex can sit exactly on the feature. The
// dual mesh is also quad-dominant, which is what makes panel lines and bevels read.
//
// Sharp features survive because each cell solves a QEF (quadratic error function) built
// from the real SDF gradient at every edge crossing: the vertex is placed where the local
// tangent planes intersect, not at their average. A rounded-off box corner is a visible
// failure in this game, so the plain "average the crossings" surface nets is not enough.
//
// Determinism (rule 5): nothing here reads a clock or the stdlib RNG, every function is a
// pure function of its arguments, the grid is walked in a fixed order and vertices are
// recorded in a dense Int32Array rather than a map. Identical input therefore gives
// identical vertex ORDER, not merely identical geometry — which is what baseline.mjs gates.
//
// Known limit, stated rather than hidden: one vertex per cell cannot represent two sheets
// of surface passing through the same cell, so a handful of edges can end up shared by four
// triangles where a feature is thinner than a cell or where a cell is cut diagonally. The
// result is still CLOSED and consistently oriented — it renders and shadows correctly — but
// it is not guaranteed edge-manifold. Fixing that properly means manifold dual contouring
// (subdividing the offending cells), which is a separate system; until then, the answer to a
// pinch is a finer grid, and a mesh headed for further CSG should be checked first.
//
// Model space convention, matching the rest of geo: right-handed, +Z up, +X forward,
// +Y left, metres. Cylinders, cones and hex prisms stand along Z; twist is about Z.
//
// This module owns no GPU handles, so rule 7 has no surface here.

import type { Mesh } from './mesh'
import type { Rng } from '../core/rng'
import { clamp, DEG2RAD, m4, mat4, q4, quat, v3, vec3, type Quat, type Vec3 } from '../core/math'

/**
 * Stands in for "no surface anywhere near here". Not Infinity: `smoothUnion` and friends
 * subtract distances, and Infinity - Infinity is NaN, which would poison a whole subtree
 * silently instead of just reporting "far away".
 */
const FAR = 1e30

/**
 * Distances use sqrt(x*x+…) rather than Math.hypot. Math.hypot is specified to avoid
 * overflow, not to be correctly rounded, so its result is implementation-defined — and
 * generation must be reproducible bit for bit. Multiply, add and sqrt are all correctly
 * rounded by IEEE-754, so these two helpers are exact and portable.
 */
function len2(x: number, y: number): number {
	return Math.sqrt(x * x + y * y)
}
function len3(x: number, y: number, z: number): number {
	return Math.sqrt(x * x + y * y + z * z)
}

// ---------------------------------------------------------------------------
// Node type
// ---------------------------------------------------------------------------

/**
 * Op ids. Readable name → integer, used by every constructor below. `evalSdf` switches on
 * bare integer literals rather than these members on purpose; see the comment there.
 */
export const SdfOp = {
	empty: 0,
	sphere: 1,
	box: 2,
	roundBox: 3,
	cylinder: 4,
	cappedCone: 5,
	torus: 6,
	plane: 7,
	hexPrism: 8,
	capsule: 9,
	union: 10,
	subtract: 11,
	intersect: 12,
	smoothUnion: 13,
	smoothSubtract: 14,
	smoothIntersect: 15,
	negate: 16,
	round: 17,
	onion: 18,
	elongate: 19,
	twist: 20,
	bend: 21,
	repeat: 22,
	repeatLimited: 23,
	mirror: 24,
	translate: 25,
	transform: 26,
	scale: 27,
	displace: 28,
} as const
export type SdfOp = (typeof SdfOp)[keyof typeof SdfOp]

/**
 * A node in an SDF tree.
 *
 * Every node has the SAME shape — one hidden class — even though most ops leave most
 * slots null. That is deliberate: `evalSdf` is the hottest function in the geometry
 * pipeline (tens of millions of calls for one mesh), and a discriminated union of
 * twenty differently-shaped objects makes every property access in it megamorphic.
 * A single shape keeps the loads monomorphic and inlinable.
 *
 * Nodes are immutable and freely shareable — the same subtree may appear many times in
 * one tree, and evaluation never writes to a node.
 */
export interface Sdf {
	/** Which op. */
	readonly k: SdfOp
	/** First child (unary ops, left of a binary op). */
	readonly a: Sdf | null
	/** Right of a binary op. */
	readonly b: Sdf | null
	/** Children of an n-ary op. */
	readonly kids: readonly Sdf[] | null
	/** Packed scalar parameters; the layout is documented per constructor. */
	readonly p: Float32Array
	/** `transform` only: [0..15] world→local inverse, [16..31] local→world forward. */
	readonly m: Float32Array | null
}

/** Shared by every parameterless op so `p` is never null and the shape never varies. */
const NO_PARAMS = new Float32Array(0)

function mk(
	k: SdfOp,
	a: Sdf | null,
	b: Sdf | null,
	kids: readonly Sdf[] | null,
	p: Float32Array,
	m: Float32Array | null,
): Sdf {
	return { k, a, b, kids, p, m }
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Nothing. The identity of `union`, and the safe result of a degenerate build. */
export function empty(): Sdf {
	return mk(SdfOp.empty, null, null, null, NO_PARAMS, null)
}

export function sphere(radius: number): Sdf {
	return mk(SdfOp.sphere, null, null, null, Float32Array.of(Math.max(radius, 0)), null)
}

/** Axis-aligned box given as HALF-extents, centred on the origin. */
export function box(hx: number, hy: number, hz: number): Sdf {
	return mk(SdfOp.box, null, null, null, Float32Array.of(Math.max(hx, 0), Math.max(hy, 0), Math.max(hz, 0)), null)
}

/**
 * Box with rounded corners. The half-extents are the OUTER size and the radius eats into
 * them, which is how a panel is actually specified — "this plate is 2 m wide with a 3 cm
 * break on the edge". iq's form inflates the box instead, which forces every call site to
 * subtract by hand and makes the greeble kit's numbers stop meaning anything.
 */
export function roundBox(hx: number, hy: number, hz: number, radius: number): Sdf {
	const ex = Math.max(hx, 0)
	const ey = Math.max(hy, 0)
	const ez = Math.max(hz, 0)
	const r = clamp(radius, 0, Math.min(ex, Math.min(ey, ez)))
	return mk(SdfOp.roundBox, null, null, null, Float32Array.of(ex - r, ey - r, ez - r, r), null)
}

/** Capped cylinder standing along +Z. `halfHeight` is measured from the centre. */
export function cylinder(radius: number, halfHeight: number): Sdf {
	return mk(SdfOp.cylinder, null, null, null, Float32Array.of(Math.max(radius, 0), Math.max(halfHeight, 0)), null)
}

/** Capped cone along Z: `radiusBottom` at z=-halfHeight, `radiusTop` at z=+halfHeight. */
export function cappedCone(radiusBottom: number, radiusTop: number, halfHeight: number): Sdf {
	// A zero half-height collapses the k2 vector and divides by zero in the exact-cone
	// formula; clamp rather than emit NaN into a whole subtree.
	const h = Math.max(halfHeight, 1e-6)
	return mk(
		SdfOp.cappedCone,
		null,
		null,
		null,
		Float32Array.of(Math.max(radiusBottom, 0), Math.max(radiusTop, 0), h),
		null,
	)
}

/** Torus in the XY plane, ring axis +Z. */
export function torus(majorRadius: number, minorRadius: number): Sdf {
	return mk(SdfOp.torus, null, null, null, Float32Array.of(Math.max(majorRadius, 0), Math.max(minorRadius, 0)), null)
}

/**
 * Half-space. Inside is the side the normal points AWAY from, and the plane passes through
 * `offset * normal`. So `plane(0, 0, 1, 4)` is "everything below z = 4", which is the
 * ground-plane trim every structure needs.
 */
export function plane(nx: number, ny: number, nz: number, offset: number): Sdf {
	const l = len3(nx, ny, nz)
	// An unnormalised normal makes the field non-metric, which breaks every downstream
	// operator that assumes a distance (round, onion, smooth booleans). Normalise once here.
	if (l < 1e-12) return empty()
	const inv = 1 / l
	return mk(SdfOp.plane, null, null, null, Float32Array.of(nx * inv, ny * inv, nz * inv, -offset), null)
}

/**
 * Convex polygon in the XZ plane, extruded vertically around `centreY`.
 *
 * One outward half-space per authored edge preserves the plan verbatim: no recentering,
 * rescaling or winding convention leaks into the caller. The finite slab gives the otherwise
 * infinite plane intersection a conservative AABB for meshing. Concave input is intentionally
 * outside this helper's contract — silently taking its convex hull would erase authored truth.
 */
export function convexPlanPrism(
	plan: readonly (readonly [number, number])[],
	halfHeight: number,
	centreY: number,
	envelopeHalfX?: number,
	envelopeHalfZ?: number,
	envelopeRadius = 0,
): Sdf {
	if (plan.length < 3 || halfHeight <= 0) return empty()
	let cx = 0, cz = 0
	let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
	for (const q of plan) {
		cx += q[0]
		cz += q[1]
		minX = Math.min(minX, q[0])
		maxX = Math.max(maxX, q[0])
		minZ = Math.min(minZ, q[1])
		maxZ = Math.max(maxZ, q[1])
	}
	cx /= plan.length
	cz /= plan.length
	const spanX = maxX - minX
	const spanZ = maxZ - minZ
	if (spanX <= 0 || spanZ <= 0) return empty()
	const explicitEnvelope = envelopeHalfX !== undefined && envelopeHalfZ !== undefined
	const pad = Math.max(Math.max(spanX, spanZ) * 0.05, 0.01)
	const envelope = explicitEnvelope
		? roundBox(envelopeHalfX, halfHeight, envelopeHalfZ, envelopeRadius)
		: box(spanX * 0.5 + pad, halfHeight, spanZ * 0.5 + pad)
	const walls: Sdf[] = [translate(
		envelope,
		explicitEnvelope ? 0 : (minX + maxX) * 0.5,
		centreY,
		explicitEnvelope ? 0 : (minZ + maxZ) * 0.5,
	)]
	for (let i = 0; i < plan.length; i++) {
		const a = plan[i]
		const b = plan[(i + 1) % plan.length]
		let nx = b[1] - a[1]
		let nz = -(b[0] - a[0])
		if (nx * (a[0] - cx) + nz * (a[1] - cz) < 0) {
			nx = -nx
			nz = -nz
		}
		const length = Math.hypot(nx, nz)
		if (length < 1e-6) continue
		nx /= length
		nz /= length
		walls.push(plane(nx, 0, nz, a[0] * nx + a[1] * nz))
	}
	return walls.length >= 4 ? intersect(...walls) : empty()
}

/**
 * Hexagonal prism along Z, flats facing ±Y. `apothem` is centre-to-flat, not
 * centre-to-vertex — the Lattice's frames are specified by the width across the flats.
 */
export function hexPrism(apothem: number, halfHeight: number): Sdf {
	return mk(SdfOp.hexPrism, null, null, null, Float32Array.of(Math.max(apothem, 0), Math.max(halfHeight, 0)), null)
}

/**
 * Capsule between two points. Takes scalars rather than two Vec3s so a caller building a
 * hundred struts does not have to allocate two hundred Float32Arrays to describe them.
 */
export function capsule(
	ax: number,
	ay: number,
	az: number,
	bx: number,
	by: number,
	bz: number,
	radius: number,
): Sdf {
	return mk(SdfOp.capsule, null, null, null, Float32Array.of(ax, ay, az, bx, by, bz, Math.max(radius, 0)), null)
}

// ---------------------------------------------------------------------------
// Boolean operators
// ---------------------------------------------------------------------------

/**
 * n-ary rather than a chain of binary nodes: a hull assembled from forty greebles is one
 * node with forty children instead of forty nested nodes, which is both a shallower
 * recursion and a tighter loop.
 */
export function union(...children: Sdf[]): Sdf {
	if (children.length === 0) return empty()
	if (children.length === 1) return children[0]
	return mk(SdfOp.union, null, null, children.slice(), NO_PARAMS, null)
}

export function intersect(...children: Sdf[]): Sdf {
	if (children.length === 0) return empty()
	if (children.length === 1) return children[0]
	return mk(SdfOp.intersect, null, null, children.slice(), NO_PARAMS, null)
}

/** `base` minus `tool`. */
export function subtract(base: Sdf, tool: Sdf): Sdf {
	return mk(SdfOp.subtract, base, tool, null, NO_PARAMS, null)
}

/**
 * Polynomial smooth minimum. `k` is the blend width in metres — the fillet radius, near
 * enough. It is not associative, which is why the smooth ops stay binary while the hard
 * ones are n-ary: `smoothUnion(smoothUnion(a,b),c)` and `smoothUnion(a,smoothUnion(b,c))`
 * genuinely differ, and hiding that behind a varargs fold would make the shape depend on
 * argument order in a way nobody would predict.
 */
export function smoothUnion(a: Sdf, b: Sdf, k: number): Sdf {
	if (!(k > 0)) return union(a, b)
	return mk(SdfOp.smoothUnion, a, b, null, Float32Array.of(k), null)
}

export function smoothSubtract(base: Sdf, tool: Sdf, k: number): Sdf {
	if (!(k > 0)) return subtract(base, tool)
	return mk(SdfOp.smoothSubtract, base, tool, null, Float32Array.of(k), null)
}

export function smoothIntersect(a: Sdf, b: Sdf, k: number): Sdf {
	if (!(k > 0)) return intersect(a, b)
	return mk(SdfOp.smoothIntersect, a, b, null, Float32Array.of(k), null)
}

/** Complement — inside becomes outside. Useful as the tool of a boolean, rarely alone. */
export function negate(child: Sdf): Sdf {
	return mk(SdfOp.negate, child, null, null, NO_PARAMS, null)
}

// ---------------------------------------------------------------------------
// Modifiers
// ---------------------------------------------------------------------------

/** Inflate by `radius`, rounding every convex edge. The cheapest bevel there is. */
export function round(child: Sdf, radius: number): Sdf {
	if (!(radius > 0)) return child
	return mk(SdfOp.round, child, null, null, Float32Array.of(radius), null)
}

/**
 * Shell of thickness `2 * halfThickness` around the surface. This is how armour plate,
 * hull skin and pipe walls are made: the solid becomes a wall, and the interior becomes
 * space the greeble pass can put machinery into.
 */
export function onion(child: Sdf, halfThickness: number): Sdf {
	return mk(SdfOp.onion, child, null, null, Float32Array.of(Math.max(halfThickness, 0)), null)
}

/**
 * Stretch by inserting a box of half-extents `h` into the middle of the shape — the
 * Minkowski sum with that box. Exact for the axis-symmetric primitives above, and a tight
 * bound otherwise. Prefer this over a non-uniform scale, which is not a valid SDF
 * transform at all (it destroys the metric and every operator downstream of it).
 */
export function elongate(child: Sdf, hx: number, hy: number, hz: number): Sdf {
	return mk(
		SdfOp.elongate,
		child,
		null,
		null,
		Float32Array.of(Math.max(hx, 0), Math.max(hy, 0), Math.max(hz, 0)),
		null,
	)
}

/**
 * Twist about Z, `radiansPerMetre` of rotation per metre of height. Z because that is the
 * axis everything in this game turns about.
 *
 * A domain warp is not distance-preserving: the field becomes a lower bound on the true
 * distance, by roughly 1/(1+|k|*r). Mesh it with cells small enough that the underestimate
 * cannot skip the surface — in practice, keep |k| * radius below about 1.
 */
export function twist(child: Sdf, radiansPerMetre: number): Sdf {
	if (radiansPerMetre === 0) return child
	return mk(SdfOp.twist, child, null, null, Float32Array.of(radiansPerMetre), null)
}

/**
 * Bend the +X axis up into +Z, `radiansPerMetre` of arc per metre along X. Same Lipschitz
 * caveat as `twist`.
 */
export function bend(child: Sdf, radiansPerMetre: number): Sdf {
	if (radiansPerMetre === 0) return child
	return mk(SdfOp.bend, child, null, null, Float32Array.of(radiansPerMetre), null)
}

/**
 * Infinite domain repetition with the given period per axis; a period of 0 leaves that
 * axis alone. The child must fit inside one cell of the period — a primitive wider than
 * its period leaks into the neighbouring copy and the field stops being a distance.
 * Almost always you want `repeatLimited` instead; an infinite field has no bounding box,
 * so `sdfAabb` can only report infinity for the repeated axes.
 */
export function repeat(child: Sdf, periodX: number, periodY: number, periodZ: number): Sdf {
	return mk(
		SdfOp.repeat,
		child,
		null,
		null,
		Float32Array.of(Math.max(periodX, 0), Math.max(periodY, 0), Math.max(periodZ, 0)),
		null,
	)
}

/**
 * Repetition clamped to `count` copies each side of the origin, so a rivet strip is a
 * strip and not an infinite plane of rivets. This is the workhorse of the greeble kit.
 */
export function repeatLimited(
	child: Sdf,
	periodX: number,
	periodY: number,
	periodZ: number,
	countX: number,
	countY: number,
	countZ: number,
): Sdf {
	return mk(
		SdfOp.repeatLimited,
		child,
		null,
		null,
		Float32Array.of(
			Math.max(periodX, 0),
			Math.max(periodY, 0),
			Math.max(periodZ, 0),
			Math.max(Math.floor(countX), 0),
			Math.max(Math.floor(countY), 0),
			Math.max(Math.floor(countZ), 0),
		),
		null,
	)
}

/**
 * Domain mirror about the selected planes. Modelling half a hull and mirroring in Y halves
 * the tree, the evaluation cost and the number of places a mistake can hide — and it is
 * exactly what makes a vehicle read as symmetric while its wear layer does not.
 */
export function mirror(child: Sdf, x: boolean, y: boolean, z: boolean): Sdf {
	if (!x && !y && !z) return child
	return mk(SdfOp.mirror, child, null, null, Float32Array.of(x ? 1 : 0, y ? 1 : 0, z ? 1 : 0), null)
}

/** Translation only. A dedicated node because it is by far the most common transform. */
export function translate(child: Sdf, x: number, y: number, z: number): Sdf {
	if (x === 0 && y === 0 && z === 0) return child
	return mk(SdfOp.translate, child, null, null, Float32Array.of(x, y, z), null)
}

/**
 * Full rigid transform with UNIFORM scale. Non-uniform scale is refused by construction:
 * it is not a valid SDF transform, because no single multiplier can correct a field that
 * has been stretched by different amounts along different axes. Use `elongate` for that.
 *
 * The forward matrix is kept alongside the inverse so `sdfAabb` can transform the child's
 * corners without inverting again.
 */
export function transform(child: Sdf, translation: Vec3, rotation: Quat, uniformScale = 1): Sdf {
	const s = Math.max(uniformScale, 1e-6)
	const m = new Float32Array(32)
	const fwd = mat4()
	const inv = mat4()
	SCALE_TMP[0] = s
	SCALE_TMP[1] = s
	SCALE_TMP[2] = s
	m4.compose(fwd, translation, rotation, SCALE_TMP)
	// A composed TRS with a positive scale is always invertible, but a caller passing a
	// denormalised quaternion could still make it singular — fall back to identity rather
	// than storing a matrix of NaN that would blank the whole subtree.
	if (m4.invert(inv, fwd) === null) m4.identity(inv)
	m.set(inv, 0)
	m.set(fwd, 16)
	return mk(SdfOp.transform, child, null, null, Float32Array.of(s), m)
}

export function rotate(child: Sdf, axis: Vec3, radians: number): Sdf {
	q4.fromAxisAngle(ROT_TMP, axis, radians)
	v3.set(POS_TMP, 0, 0, 0)
	return transform(child, POS_TMP, ROT_TMP, 1)
}

/** Yaw. The one rotation that appears in nearly every actor, since facings are about Z. */
export function rotateZ(child: Sdf, radians: number): Sdf {
	v3.set(AXIS_TMP, 0, 0, 1)
	return rotate(child, AXIS_TMP, radians)
}

/**
 * Rotate about X.
 *
 * Added 2026-08-05 because its absence was directly load-bearing in a real defect. Every
 * axial primitive here — `cylinder`, `cappedCone`, `hexPrism` — stands along **Z**, while
 * §12.4 pins the renderer to **Y up**. Standing one of them upright in render space is
 * therefore `rotateX(p, PI / 2)`, and with only `rotateZ` exported the nearest available
 * call was `rotateZ`, which is a NO-OP on a Z-aligned primitive.
 *
 * That is exactly what happened in `units/shapes.ts`: a turret cylinder rendered as a disc
 * standing on edge like a wheel, and a gun barrel pointed sideways across the hull. Both
 * shipped, because a no-op rotation produces a plausible shape rather than an error.
 */
export function rotateX(child: Sdf, radians: number): Sdf {
	v3.set(AXIS_TMP, 1, 0, 0)
	return rotate(child, AXIS_TMP, radians)
}

/** Rotate about Y. Aims a Z-aligned primitive along X — a gun barrel, in render space. */
export function rotateY(child: Sdf, radians: number): Sdf {
	v3.set(AXIS_TMP, 0, 1, 0)
	return rotate(child, AXIS_TMP, radians)
}

/** Uniform scale about the origin. */
export function scale(child: Sdf, factor: number): Sdf {
	const s = Math.max(factor, 1e-6)
	if (s === 1) return child
	return mk(SdfOp.scale, child, null, null, Float32Array.of(s, 1 / s), null)
}

/**
 * Add seeded value noise to the field — rock strata, cast-iron pitting, weathered concrete.
 * The lattice tables are drawn from the caller's `Rng` at BUILD time, so evaluation stays a
 * pure function of the tree and the whole mesh stays a pure function of the asset seed.
 *
 * Displacement destroys the Lipschitz bound in proportion to `amplitude * frequency`; keep
 * that product below about 0.3 or the mesher will step over thin features.
 */
export function displace(child: Sdf, amplitude: number, frequency: number, rng: Rng): Sdf {
	// [0] amplitude, [1] frequency, [4..259] permutation, [260..515] lattice values.
	const p = new Float32Array(516)
	p[0] = amplitude
	p[1] = Math.max(frequency, 0)
	const perm = new Int32Array(256)
	for (let i = 0; i < 256; i++) perm[i] = i
	for (let i = 255; i > 0; i--) {
		const j = rng.int(0, i + 1)
		const t = perm[i]
		perm[i] = perm[j]
		perm[j] = t
	}
	for (let i = 0; i < 256; i++) {
		p[4 + i] = perm[i]
		p[260 + i] = rng.signed(1)
	}
	return mk(SdfOp.displace, child, null, null, p, null)
}

// Build-time scratch for the transform constructors. Never touched during evaluation.
const SCALE_TMP = vec3(1, 1, 1)
const ROT_TMP = quat()
const POS_TMP = vec3()
const AXIS_TMP = vec3()

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Distance from (x, y, z) to the surface: negative inside, positive outside.
 *
 * Allocation-free by construction — the point travels as three f64 scalars, so a domain
 * operator warps it by recursing with different numbers rather than by writing to a
 * scratch vector. That also keeps the whole evaluation in f64 instead of rounding to f32
 * at every level, which matters because a chain of twenty operators is twenty roundings.
 *
 * The switch uses bare integer literals rather than `SdfOp.*` members so V8 can emit a
 * jump table; a property load per case turns it into a linear scan of twenty-nine
 * comparisons, in the one function that runs tens of millions of times per mesh.
 */
export function evalSdf(n: Sdf, x: number, y: number, z: number): number {
	const p = n.p
	switch (n.k) {
		case 0: // empty
			return FAR

		case 1: // sphere
			return len3(x, y, z) - p[0]

		case 2: {
			// box
			const qx = Math.abs(x) - p[0]
			const qy = Math.abs(y) - p[1]
			const qz = Math.abs(z) - p[2]
			const mxy = qx > qy ? qx : qy
			const mq = mxy > qz ? mxy : qz
			return len3(qx > 0 ? qx : 0, qy > 0 ? qy : 0, qz > 0 ? qz : 0) + (mq < 0 ? mq : 0)
		}

		case 3: {
			// roundBox — p[0..2] are already the shrunken extents
			const qx = Math.abs(x) - p[0]
			const qy = Math.abs(y) - p[1]
			const qz = Math.abs(z) - p[2]
			const mxy = qx > qy ? qx : qy
			const mq = mxy > qz ? mxy : qz
			return len3(qx > 0 ? qx : 0, qy > 0 ? qy : 0, qz > 0 ? qz : 0) + (mq < 0 ? mq : 0) - p[3]
		}

		case 4: {
			// cylinder, axis Z
			const dr = len2(x, y) - p[0]
			const dz = Math.abs(z) - p[1]
			const mq = dr > dz ? dr : dz
			return (mq < 0 ? mq : 0) + len2(dr > 0 ? dr : 0, dz > 0 ? dz : 0)
		}

		case 5: {
			// cappedCone, axis Z, exact
			const r1 = p[0]
			const r2 = p[1]
			const h = p[2]
			const qx = len2(x, y)
			const qy = z
			const rq = qy < 0 ? r1 : r2
			const cax = qx - (qx < rq ? qx : rq)
			const cay = Math.abs(qy) - h
			const k2x = r2 - r1
			const k2y = 2 * h
			const t = clamp(((r2 - qx) * k2x + (h - qy) * k2y) / (k2x * k2x + k2y * k2y), 0, 1)
			const cbx = qx - r2 + k2x * t
			const cby = qy - h + k2y * t
			const s = cbx < 0 && cay < 0 ? -1 : 1
			const da = cax * cax + cay * cay
			const db = cbx * cbx + cby * cby
			return s * Math.sqrt(da < db ? da : db)
		}

		case 6: // torus in XY
			return len2(len2(x, y) - p[0], z) - p[1]

		case 7: // plane; p[3] is -offset so the half-space test is one fused add
			return x * p[0] + y * p[1] + z * p[2] + p[3]

		case 8: {
			// hexPrism, axis Z. k is (-sqrt(3)/2, 1/2, 1/sqrt(3)) — the fold that maps the
			// full hexagon onto one 60-degree wedge, so only one edge has to be measured.
			const KX = -0.8660254037844386
			const KY = 0.5
			const KZ = 0.5773502691896257
			const r = p[0]
			let ax = Math.abs(x)
			let ay = Math.abs(y)
			const fold = 2 * Math.min(KX * ax + KY * ay, 0)
			ax -= fold * KX
			ay -= fold * KY
			const ex = ax - clamp(ax, -KZ * r, KZ * r)
			const ey = ay - r
			const dxy = len2(ex, ey) * (ey >= 0 ? 1 : -1)
			const dz = Math.abs(z) - p[1]
			const mq = dxy > dz ? dxy : dz
			return (mq < 0 ? mq : 0) + len2(dxy > 0 ? dxy : 0, dz > 0 ? dz : 0)
		}

		case 9: {
			// capsule
			const ax = p[0]
			const ay = p[1]
			const az = p[2]
			const bax = p[3] - ax
			const bay = p[4] - ay
			const baz = p[5] - az
			const pax = x - ax
			const pay = y - ay
			const paz = z - az
			const bb = bax * bax + bay * bay + baz * baz
			const h = bb > 1e-20 ? clamp((pax * bax + pay * bay + paz * baz) / bb, 0, 1) : 0
			return len3(pax - bax * h, pay - bay * h, paz - baz * h) - p[6]
		}

		case 10: {
			// union
			const kids = n.kids as readonly Sdf[]
			let d = FAR
			for (let i = 0; i < kids.length; i++) {
				const v = evalSdf(kids[i], x, y, z)
				if (v < d) d = v
			}
			return d
		}

		case 11: {
			// subtract
			const da = evalSdf(n.a as Sdf, x, y, z)
			const db = -evalSdf(n.b as Sdf, x, y, z)
			return da > db ? da : db
		}

		case 12: {
			// intersect
			const kids = n.kids as readonly Sdf[]
			let d = -FAR
			for (let i = 0; i < kids.length; i++) {
				const v = evalSdf(kids[i], x, y, z)
				if (v > d) d = v
			}
			return d
		}

		case 13: {
			// smoothUnion
			const k = p[0]
			const da = evalSdf(n.a as Sdf, x, y, z)
			const db = evalSdf(n.b as Sdf, x, y, z)
			const h = clamp(0.5 + (0.5 * (db - da)) / k, 0, 1)
			return db + (da - db) * h - k * h * (1 - h)
		}

		case 14: {
			// smoothSubtract
			const k = p[0]
			const da = evalSdf(n.a as Sdf, x, y, z)
			const db = evalSdf(n.b as Sdf, x, y, z)
			const h = clamp(0.5 - (0.5 * (db + da)) / k, 0, 1)
			return da + (-db - da) * h + k * h * (1 - h)
		}

		case 15: {
			// smoothIntersect
			const k = p[0]
			const da = evalSdf(n.a as Sdf, x, y, z)
			const db = evalSdf(n.b as Sdf, x, y, z)
			const h = clamp(0.5 - (0.5 * (db - da)) / k, 0, 1)
			return db + (da - db) * h + k * h * (1 - h)
		}

		case 16: // negate
			return -evalSdf(n.a as Sdf, x, y, z)

		case 17: // round
			return evalSdf(n.a as Sdf, x, y, z) - p[0]

		case 18: // onion
			return Math.abs(evalSdf(n.a as Sdf, x, y, z)) - p[0]

		case 19: {
			// elongate — sign-preserving offset plus the interior correction, so the field
			// stays correct inside the inserted box as well as outside it
			const hx = p[0]
			const hy = p[1]
			const hz = p[2]
			const wx = Math.abs(x) - hx
			const wy = Math.abs(y) - hy
			const wz = Math.abs(z) - hz
			const mxy = wx > wy ? wx : wy
			const mw = mxy > wz ? mxy : wz
			const qx = x - clamp(x, -hx, hx)
			const qy = y - clamp(y, -hy, hy)
			const qz = z - clamp(z, -hz, hz)
			return evalSdf(n.a as Sdf, qx, qy, qz) + (mw < 0 ? mw : 0)
		}

		case 20: {
			// twist about Z
			const a = p[0] * z
			const c = Math.cos(a)
			const s = Math.sin(a)
			return evalSdf(n.a as Sdf, c * x + s * y, c * y - s * x, z)
		}

		case 21: {
			// bend X into Z
			const a = p[0] * x
			const c = Math.cos(a)
			const s = Math.sin(a)
			return evalSdf(n.a as Sdf, c * x - s * z, y, s * x + c * z)
		}

		case 22: {
			// repeat
			const cx = p[0]
			const cy = p[1]
			const cz = p[2]
			return evalSdf(
				n.a as Sdf,
				cx > 0 ? x - cx * Math.round(x / cx) : x,
				cy > 0 ? y - cy * Math.round(y / cy) : y,
				cz > 0 ? z - cz * Math.round(z / cz) : z,
			)
		}

		case 23: {
			// repeatLimited
			const cx = p[0]
			const cy = p[1]
			const cz = p[2]
			return evalSdf(
				n.a as Sdf,
				cx > 0 ? x - cx * clamp(Math.round(x / cx), -p[3], p[3]) : x,
				cy > 0 ? y - cy * clamp(Math.round(y / cy), -p[4], p[4]) : y,
				cz > 0 ? z - cz * clamp(Math.round(z / cz), -p[5], p[5]) : z,
			)
		}

		case 24: // mirror
			return evalSdf(
				n.a as Sdf,
				p[0] !== 0 ? Math.abs(x) : x,
				p[1] !== 0 ? Math.abs(y) : y,
				p[2] !== 0 ? Math.abs(z) : z,
			)

		case 25: // translate
			return evalSdf(n.a as Sdf, x - p[0], y - p[1], z - p[2])

		case 26: {
			// transform — apply the stored world→local inverse, then rescale the distance
			const m = n.m as Float32Array
			const lx = m[0] * x + m[4] * y + m[8] * z + m[12]
			const ly = m[1] * x + m[5] * y + m[9] * z + m[13]
			const lz = m[2] * x + m[6] * y + m[10] * z + m[14]
			return evalSdf(n.a as Sdf, lx, ly, lz) * p[0]
		}

		case 27: // scale
			return evalSdf(n.a as Sdf, x * p[1], y * p[1], z * p[1]) * p[0]

		case 28: {
			// displace
			const f = p[1]
			return evalSdf(n.a as Sdf, x, y, z) + p[0] * valueNoise(p, x * f, y * f, z * f)
		}

		default:
			throw new Error(`geo/sdf: unknown op ${n.k}`)
	}
}

/** Convenience wrapper for callers that already hold a point. */
export function evalSdfAt(n: Sdf, point: Vec3): number {
	return evalSdf(n, point[0], point[1], point[2])
}

/**
 * Value noise on the tables packed into a `displace` node's parameters. Quintic
 * interpolation (6t^5-15t^4+10t^3) rather than linear because linear leaves visible
 * lattice creases, and those creases would be extracted as real geometry by the mesher.
 */
function valueNoise(t: Float32Array, x: number, y: number, z: number): number {
	const fx0 = Math.floor(x)
	const fy0 = Math.floor(y)
	const fz0 = Math.floor(z)
	const dx = x - fx0
	const dy = y - fy0
	const dz = z - fz0
	const ux = dx * dx * dx * (dx * (dx * 6 - 15) + 10)
	const uy = dy * dy * dy * (dy * (dy * 6 - 15) + 10)
	const uz = dz * dz * dz * (dz * (dz * 6 - 15) + 10)
	const ix = fx0 | 0
	const iy = fy0 | 0
	const iz = fz0 | 0
	const c000 = lattice(t, ix, iy, iz)
	const c100 = lattice(t, ix + 1, iy, iz)
	const c010 = lattice(t, ix, iy + 1, iz)
	const c110 = lattice(t, ix + 1, iy + 1, iz)
	const c001 = lattice(t, ix, iy, iz + 1)
	const c101 = lattice(t, ix + 1, iy, iz + 1)
	const c011 = lattice(t, ix, iy + 1, iz + 1)
	const c111 = lattice(t, ix + 1, iy + 1, iz + 1)
	const x00 = c000 + (c100 - c000) * ux
	const x10 = c010 + (c110 - c010) * ux
	const x01 = c001 + (c101 - c001) * ux
	const x11 = c011 + (c111 - c011) * ux
	const y0 = x00 + (x10 - x00) * uy
	const y1 = x01 + (x11 - x01) * uy
	return y0 + (y1 - y0) * uz
}

function lattice(t: Float32Array, i: number, j: number, k: number): number {
	// The permutation entries are small integers stored exactly in f32, so `| 0` is a
	// truncation, not a rounding — the hash is exact and identical on every run.
	const a = t[4 + (i & 255)] | 0
	const b = t[4 + ((a + j) & 255)] | 0
	const c = t[4 + ((b + k) & 255)] | 0
	return t[260 + c]
}

// ---------------------------------------------------------------------------
// Normals
// ---------------------------------------------------------------------------

const NORMAL_TMP = new Float64Array(3)

/**
 * Surface normal by central differences.
 *
 * The epsilon is adaptive: an absolute step loses all significance far from the origin (a
 * turret at x = 900 m has no bits left for a 1e-7 offset), and too small a step turns the
 * difference into rounding noise instead of a gradient. Pass an explicit `eps` when you
 * know the sampling scale — the mesher does, and ties it to the cell size, which is the
 * scale at which the normal is actually going to be used.
 *
 * Central differences rather than the cheaper 4-tap tetrahedral trick because the tetra
 * pattern is asymmetric, and an asymmetric stencil biases the normal along one diagonal
 * exactly where it matters most: on a sharp edge.
 */
export function sdfNormal(n: Sdf, x: number, y: number, z: number, out: Vec3, eps = 0): Vec3 {
	gradInto(n, x, y, z, eps > 0 ? eps : autoEps(x, y, z), NORMAL_TMP, 0)
	return v3.set(out, NORMAL_TMP[0], NORMAL_TMP[1], NORMAL_TMP[2])
}

function autoEps(x: number, y: number, z: number): number {
	const ax = Math.abs(x)
	const ay = Math.abs(y)
	const az = Math.abs(z)
	const m = ax > ay ? (ax > az ? ax : az) : ay > az ? ay : az
	return 1e-4 * (1 + m)
}

function gradInto(n: Sdf, x: number, y: number, z: number, e: number, out: Float64Array, o: number): void {
	const gx = evalSdf(n, x + e, y, z) - evalSdf(n, x - e, y, z)
	const gy = evalSdf(n, x, y + e, z) - evalSdf(n, x, y - e, z)
	const gz = evalSdf(n, x, y, z + e) - evalSdf(n, x, y, z - e)
	const l = len3(gx, gy, gz)
	// A zero gradient means a flat spot in the field (the centre of a sphere, or a point
	// equidistant from two booleaned solids). A zero normal blanks the lighting there, so
	// pick up instead — visible as a wrong shade, not as a black hole.
	if (l < 1e-20) {
		out[o] = 0
		out[o + 1] = 0
		out[o + 2] = 1
		return
	}
	const inv = 1 / l
	out[o] = gx * inv
	out[o + 1] = gy * inv
	out[o + 2] = gz * inv
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Axis-aligned bounding box. `min > max` on every axis means "empty". */
export interface Aabb {
	readonly min: Vec3
	readonly max: Vec3
}

/** A fresh, empty box. Build time only — this allocates. */
export function aabb(): Aabb {
	return { min: vec3(Infinity, Infinity, Infinity), max: vec3(-Infinity, -Infinity, -Infinity) }
}

export function setAabb(
	out: Aabb,
	minX: number,
	minY: number,
	minZ: number,
	maxX: number,
	maxY: number,
	maxZ: number,
): Aabb {
	v3.set(out.min, minX, minY, minZ)
	v3.set(out.max, maxX, maxY, maxZ)
	return out
}

/** Grow a box outward on every axis. Handy for giving the mesher clearance. */
export function expandAabb(out: Aabb, by: number): Aabb {
	out.min[0] -= by
	out.min[1] -= by
	out.min[2] -= by
	out.max[0] += by
	out.max[1] += by
	out.max[2] += by
	return out
}

/**
 * Conservative bounding box of a tree — never smaller than the true extent, sometimes
 * larger. This is what lets a generator hand a tree straight to `surfaceNets` without
 * hand-writing a bounding box per actor and getting it silently wrong when the greeble
 * pass adds a stack. Unbounded ops (`plane`, `negate`, infinite `repeat`) report infinity
 * on the axes they are unbounded on; the caller must clamp those itself.
 */
export function sdfAabb(n: Sdf, out: Aabb): Aabb {
	const r = boxScratch(0)
	aabbInto(n, 1, r)
	return setAabb(out, r[0], r[1], r[2], r[3], r[4], r[5])
}

/**
 * One scratch box per recursion depth, grown on demand. Bounds are computed once per mesh
 * at build time, never per frame, so growing this lazily costs nothing that matters.
 */
const boxPool: Float32Array[] = []
function boxScratch(d: number): Float32Array {
	let s = boxPool[d]
	if (s === undefined) {
		s = new Float32Array(6)
		boxPool[d] = s
	}
	return s
}

function setBox(o: Float32Array, ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
	o[0] = ax
	o[1] = ay
	o[2] = az
	o[3] = bx
	o[4] = by
	o[5] = bz
}

function emptyBox(o: Float32Array): void {
	setBox(o, Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity)
}

function infiniteBox(o: Float32Array): void {
	setBox(o, -Infinity, -Infinity, -Infinity, Infinity, Infinity, Infinity)
}

function padBox(o: Float32Array, by: number): void {
	o[0] -= by
	o[1] -= by
	o[2] -= by
	o[3] += by
	o[4] += by
	o[5] += by
}

function aabbInto(n: Sdf, d: number, o: Float32Array): void {
	const p = n.p
	switch (n.k) {
		case SdfOp.empty:
			emptyBox(o)
			return

		case SdfOp.sphere:
			setBox(o, -p[0], -p[0], -p[0], p[0], p[0], p[0])
			return

		case SdfOp.box:
			setBox(o, -p[0], -p[1], -p[2], p[0], p[1], p[2])
			return

		case SdfOp.roundBox: {
			const hx = p[0] + p[3]
			const hy = p[1] + p[3]
			const hz = p[2] + p[3]
			setBox(o, -hx, -hy, -hz, hx, hy, hz)
			return
		}

		case SdfOp.cylinder:
			setBox(o, -p[0], -p[0], -p[1], p[0], p[0], p[1])
			return

		case SdfOp.cappedCone: {
			const r = Math.max(p[0], p[1])
			setBox(o, -r, -r, -p[2], r, r, p[2])
			return
		}

		case SdfOp.torus: {
			const r = p[0] + p[1]
			setBox(o, -r, -r, -p[1], r, r, p[1])
			return
		}

		case SdfOp.plane:
			infiniteBox(o)
			return

		case SdfOp.hexPrism: {
			// Circumradius from the apothem: R = 2a/sqrt(3). The vertices stick out further
			// than the flats, and a box drawn to the flats would clip them.
			const rx = p[0] * 1.1547005383792517
			setBox(o, -rx, -p[0], -p[1], rx, p[0], p[1])
			return
		}

		case SdfOp.capsule: {
			const r = p[6]
			setBox(
				o,
				Math.min(p[0], p[3]) - r,
				Math.min(p[1], p[4]) - r,
				Math.min(p[2], p[5]) - r,
				Math.max(p[0], p[3]) + r,
				Math.max(p[1], p[4]) + r,
				Math.max(p[2], p[5]) + r,
			)
			return
		}

		case SdfOp.union: {
			const kids = n.kids as readonly Sdf[]
			if (kids.length === 0) {
				emptyBox(o)
				return
			}
			aabbInto(kids[0], d + 1, o)
			const s = boxScratch(d)
			for (let i = 1; i < kids.length; i++) {
				aabbInto(kids[i], d + 1, s)
				for (let c = 0; c < 3; c++) if (s[c] < o[c]) o[c] = s[c]
				for (let c = 3; c < 6; c++) if (s[c] > o[c]) o[c] = s[c]
			}
			return
		}

		case SdfOp.intersect: {
			const kids = n.kids as readonly Sdf[]
			if (kids.length === 0) {
				emptyBox(o)
				return
			}
			aabbInto(kids[0], d + 1, o)
			const s = boxScratch(d)
			for (let i = 1; i < kids.length; i++) {
				aabbInto(kids[i], d + 1, s)
				for (let c = 0; c < 3; c++) if (s[c] > o[c]) o[c] = s[c]
				for (let c = 3; c < 6; c++) if (s[c] < o[c]) o[c] = s[c]
			}
			return
		}

		// Removing material can only shrink the result, so the base's box still bounds it.
		case SdfOp.subtract:
			aabbInto(n.a as Sdf, d + 1, o)
			return

		case SdfOp.smoothUnion: {
			aabbInto(n.a as Sdf, d + 1, o)
			const s = boxScratch(d)
			aabbInto(n.b as Sdf, d + 1, s)
			for (let c = 0; c < 3; c++) if (s[c] < o[c]) o[c] = s[c]
			for (let c = 3; c < 6; c++) if (s[c] > o[c]) o[c] = s[c]
			// The polynomial blend bulges by at most k/4; k/2 leaves margin for the bulge
			// being measured in field units rather than distance.
			padBox(o, p[0] * 0.5)
			return
		}

		case SdfOp.smoothSubtract:
			aabbInto(n.a as Sdf, d + 1, o)
			padBox(o, p[0] * 0.5)
			return

		case SdfOp.smoothIntersect: {
			aabbInto(n.a as Sdf, d + 1, o)
			const s = boxScratch(d)
			aabbInto(n.b as Sdf, d + 1, s)
			for (let c = 0; c < 3; c++) if (s[c] > o[c]) o[c] = s[c]
			for (let c = 3; c < 6; c++) if (s[c] < o[c]) o[c] = s[c]
			padBox(o, p[0] * 0.5)
			return
		}

		case SdfOp.negate:
			infiniteBox(o)
			return

		case SdfOp.round:
			aabbInto(n.a as Sdf, d + 1, o)
			padBox(o, p[0])
			return

		case SdfOp.onion:
			aabbInto(n.a as Sdf, d + 1, o)
			padBox(o, p[0])
			return

		case SdfOp.elongate:
			aabbInto(n.a as Sdf, d + 1, o)
			o[0] -= p[0]
			o[1] -= p[1]
			o[2] -= p[2]
			o[3] += p[0]
			o[4] += p[1]
			o[5] += p[2]
			return

		case SdfOp.twist: {
			// The warp is a rotation in XY, which preserves the XY radius, so the twisted
			// shape cannot escape the cylinder that contains the child.
			aabbInto(n.a as Sdf, d + 1, o)
			const r = radialExtent(o, 0, 1)
			o[0] = -r
			o[1] = -r
			o[3] = r
			o[4] = r
			return
		}

		case SdfOp.bend: {
			// Same argument, rotation in XZ.
			aabbInto(n.a as Sdf, d + 1, o)
			const r = radialExtent(o, 0, 2)
			o[0] = -r
			o[2] = -r
			o[3] = r
			o[5] = r
			return
		}

		case SdfOp.repeat: {
			aabbInto(n.a as Sdf, d + 1, o)
			for (let c = 0; c < 3; c++) {
				if (p[c] > 0) {
					o[c] = -Infinity
					o[c + 3] = Infinity
				}
			}
			return
		}

		case SdfOp.repeatLimited: {
			aabbInto(n.a as Sdf, d + 1, o)
			for (let c = 0; c < 3; c++) {
				if (p[c] > 0) {
					const reach = p[c] * p[c + 3]
					o[c] -= reach
					o[c + 3] += reach
				}
			}
			return
		}

		case SdfOp.mirror: {
			aabbInto(n.a as Sdf, d + 1, o)
			for (let c = 0; c < 3; c++) {
				if (p[c] !== 0) {
					// Only the child's positive half survives the fold, and it is copied to
					// the negative side.
					const e = Math.max(o[c + 3], 0)
					o[c] = -e
					o[c + 3] = e
				}
			}
			return
		}

		case SdfOp.translate:
			aabbInto(n.a as Sdf, d + 1, o)
			o[0] += p[0]
			o[1] += p[1]
			o[2] += p[2]
			o[3] += p[0]
			o[4] += p[1]
			o[5] += p[2]
			return

		case SdfOp.transform: {
			aabbInto(n.a as Sdf, d + 1, o)
			// A rigid map of nothing is nothing, and the interval arithmetic below assumes
			// min <= max on every axis. Catches both the empty sentinel and the inverted box
			// an `intersect` of disjoint children produces, either of which the corner form
			// used to map into a plausible-looking box that bounds no surface at all.
			if (!(o[0] <= o[3] && o[1] <= o[4] && o[2] <= o[5])) {
				emptyBox(o)
				return
			}
			const m = n.m as Float32Array
			const ax = o[0]
			const ay = o[1]
			const az = o[2]
			const bx = o[3]
			const by = o[4]
			const bz = o[5]
			// Bound each output axis by interval arithmetic on the three input intervals,
			// rather than by mapping the eight corners. Not the two extremes, because under
			// rotation the min corner does not map to the min corner; and not the corners
			// either, because a corner of an unbounded child carries +-Infinity into products
			// like 0 * Infinity and sums like Infinity + -Infinity, and the resulting NaN
			// loses against every min/max comparison — which left the box at the empty
			// sentinel and reported a rotated plane as bounding NOTHING.
			//
			// For a finite box the two agree bit for bit: an affine map is monotone in each
			// coordinate and IEEE multiply and add are monotone too, so the per-term extremes
			// sum to exactly the extremal corner's value, in the same association order.
			// For an unbounded one this form is also the correct answer rather than a NaN — a
			// zero coefficient contributes exactly [0, 0] to an infinite extent, since the
			// image of the reals under multiplication by zero is {0}. That is what keeps the
			// bounded axes of a partially unbounded child (a rotated infinite `repeat`), and
			// what turns a rotated `plane` into the infinite box it actually is.
			for (let c = 0; c < 3; c++) {
				const c0 = m[16 + c]
				const c1 = m[20 + c]
				const c2 = m[24 + c]
				const t = m[28 + c]
				const l0 = c0 === 0 ? 0 : c0 > 0 ? c0 * ax : c0 * bx
				const h0 = c0 === 0 ? 0 : c0 > 0 ? c0 * bx : c0 * ax
				const l1 = c1 === 0 ? 0 : c1 > 0 ? c1 * ay : c1 * by
				const h1 = c1 === 0 ? 0 : c1 > 0 ? c1 * by : c1 * ay
				const l2 = c2 === 0 ? 0 : c2 > 0 ? c2 * az : c2 * bz
				const h2 = c2 === 0 ? 0 : c2 > 0 ? c2 * bz : c2 * az
				o[c] = l0 + l1 + l2 + t
				o[c + 3] = h0 + h1 + h2 + t
			}
			// Unreachable for any box a constructor here can build — every term's low bound is
			// finite or -Infinity and every high bound finite or +Infinity, so neither sum can
			// be Infinity - Infinity. It is here so that a caller who hands `transform` a
			// non-finite translation still gets a box that is too big rather than one that
			// silently bounds nothing; too big fails loudly in `surfaceNets`.
			if (!(o[0] <= o[3] && o[1] <= o[4] && o[2] <= o[5])) infiniteBox(o)
			return
		}

		case SdfOp.scale:
			aabbInto(n.a as Sdf, d + 1, o)
			for (let c = 0; c < 6; c++) o[c] *= p[0]
			return

		case SdfOp.displace:
			aabbInto(n.a as Sdf, d + 1, o)
			padBox(o, Math.abs(p[0]))
			return

		default:
			throw new Error(`geo/sdf: unknown op ${n.k}`)
	}
}

/** Largest distance from the axis `(u, v)` to any corner of the box. */
function radialExtent(o: Float32Array, u: number, v: number): number {
	const eu = Math.max(Math.abs(o[u]), Math.abs(o[u + 3]))
	const ev = Math.max(Math.abs(o[v]), Math.abs(o[v + 3]))
	return len2(eu, ev)
}

// ---------------------------------------------------------------------------
// Surface nets
// ---------------------------------------------------------------------------

export interface SurfaceNetsOptions {
	/** Level set to extract. Non-zero offsets the surface outward (positive) — a cheap shell. */
	iso?: number
	/**
	 * Degrees. Faces meeting at more than this angle get split vertices, so the edge shades
	 * as a hard edge instead of a smeared crease. 0 facets everything, 180 smooths everything.
	 */
	creaseAngle?: number
	/**
	 * Eigenvalue cut for the QEF pseudo-inverse, relative to the largest eigenvalue. This is
	 * the sharp-versus-stable knob: lower keeps more of the solved (sharper) position, higher
	 * falls back toward the cell's mass point. 0.1 is the standard compromise.
	 */
	qefTolerance?: number
	/** How far outside its own cell a solved vertex may sit, in cells. Guards against spikes. */
	qefClampCells?: number
	/** Central-difference step for gradients, in cells. */
	gradientEpsilonCells?: number
	/** Empty cells added around the bounds so the shape never grazes the grid edge. */
	padCells?: number
	/** Force the outer corner shell outside the volume, guaranteeing a closed mesh. */
	seal?: boolean
	/** Refuses to run past this many grid corners, instead of quietly trying to allocate 4 GB. */
	maxSamples?: number
}

/**
 * Raw extraction output. Separate from `Mesh` so the extraction has no opinion about the
 * container: `surfaceNets` is the thin adapter, and it is the only thing that has to change
 * if the mesh container's field set does.
 */
export interface SurfaceNetsResult {
	readonly positions: Float32Array
	readonly normals: Float32Array
	readonly indices: Uint32Array
	readonly vertexCount: number
	readonly indexCount: number
	/** Edge length of the cubic cell actually used, after padding the bounds to whole cells. */
	readonly cellSize: number
	readonly cellsX: number
	readonly cellsY: number
	readonly cellsZ: number
}

/**
 * The twelve cell edges as pairs of corner indices. Corner index bit 0 is +X, bit 1 is +Y,
 * bit 2 is +Z, matching the sampling offsets below.
 */
const SN_EDGE = Int32Array.of(0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7)

// Per-cell working set, allocated once. `surfaceNets` is synchronous and never re-enters
// itself, and each worker gets its own module instance, so module-level scratch is safe.
const snCorner = new Float64Array(8)
const snCrossP = new Float64Array(36)
const snCrossN = new Float64Array(36)
const qefA = new Float64Array(9)
const qefV = new Float64Array(9)
const qefB = new Float64Array(3)
const qefY = new Float64Array(3)

/**
 * Extract the zero level set into a mesh.
 *
 * `resolution` is the number of cells along the LONGEST axis of `bounds`; the other axes
 * get whatever count makes the cells cubic. Non-cubic cells would skew the QEF — a corner
 * would be pulled toward the long axis — and skewed corners are the exact failure this
 * whole file exists to avoid.
 */
export function surfaceNets(
	sdf: Sdf,
	bounds: Aabb,
	resolution: number,
	out: Mesh,
	opts?: SurfaceNetsOptions,
): Mesh {
	const r = surfaceNetsRaw(sdf, bounds, resolution, opts)
	// Takes the destination rather than returning a fresh Mesh, following the same out-param
	// convention as core/math: a generator building a whole roster reuses one scratch mesh
	// instead of allocating one per shape. It APPENDS, so several trees can be extracted into
	// one mesh; call out.clear() first if you want a replacement.
	const base = out.vertexCount
	const tris = (r.indexCount / 3) | 0
	out.reserve(base + r.vertexCount, out.triangleCount + tris)
	const pos = r.positions
	const nrm = r.normals
	for (let v = 0; v < r.vertexCount; v++) {
		const o = v * 3
		// UVs stay at zero: projection is per material zone and needs the rig to know which
		// zone a vertex belongs to, so it is the UV pass's job (§6.2), not the mesher's.
		out.addVertex(pos[o], pos[o + 1], pos[o + 2], nrm[o], nrm[o + 1], nrm[o + 2])
	}
	const idx = r.indices
	for (let t = 0; t < tris; t++) {
		const o = t * 3
		out.addTriangle(base + idx[o], base + idx[o + 1], base + idx[o + 2])
	}
	return out
}

export function surfaceNetsRaw(
	sdf: Sdf,
	bounds: Aabb,
	resolution: number,
	opts?: SurfaceNetsOptions,
): SurfaceNetsResult {
	const iso = opts?.iso ?? 0
	const creaseAngle = opts?.creaseAngle ?? 40
	const qefTol = opts?.qefTolerance ?? 0.1
	const qefClampCells = opts?.qefClampCells ?? 0.5
	const gradEpsCells = opts?.gradientEpsilonCells ?? 0.02
	const pad = Math.max(0, Math.floor(opts?.padCells ?? 1))
	const seal = opts?.seal ?? true
	const maxSamples = opts?.maxSamples ?? 16_777_216

	const minX = bounds.min[0]
	const minY = bounds.min[1]
	const minZ = bounds.min[2]
	const spanX = bounds.max[0] - minX
	const spanY = bounds.max[1] - minY
	const spanZ = bounds.max[2] - minZ
	const longest = Math.max(spanX, Math.max(spanY, spanZ))
	if (!(longest > 0) || !Number.isFinite(longest)) {
		throw new Error('geo/sdf: surfaceNets needs finite, non-degenerate bounds — clamp an unbounded tree first')
	}

	const res = Math.max(2, Math.floor(resolution))
	const cell = longest / res
	const coreX = Math.max(1, Math.ceil(spanX / cell))
	const coreY = Math.max(1, Math.ceil(spanY / cell))
	const coreZ = Math.max(1, Math.ceil(spanZ / cell))
	const nx = coreX + 2 * pad
	const ny = coreY + 2 * pad
	const nz = coreZ + 2 * pad
	// Centre the padded grid on the requested bounds so the slack sits evenly on both sides.
	const ox = minX - (coreX * cell - spanX) * 0.5 - pad * cell
	const oy = minY - (coreY * cell - spanY) * 0.5 - pad * cell
	const oz = minZ - (coreZ * cell - spanZ) * 0.5 - pad * cell

	const gx = nx + 1
	const gy = ny + 1
	const gz = nz + 1
	const gxy = gx * gy
	const corners = gxy * gz
	if (corners > maxSamples) {
		throw new Error(
			`geo/sdf: surfaceNets grid ${gx}x${gy}x${gz} = ${corners} samples exceeds maxSamples ${maxSamples}`,
		)
	}

	// --- sample ---------------------------------------------------------
	// f32 storage: the field is only ever used for sign tests and one linear interpolation
	// per edge, and at 256^3 the f64 version would cost 136 MB in a worker.
	const field = new Float32Array(corners)
	let s = 0
	for (let k = 0; k < gz; k++) {
		const wz = oz + k * cell
		for (let j = 0; j < gy; j++) {
			const wy = oy + j * cell
			for (let i = 0; i < gx; i++) {
				field[s++] = evalSdf(sdf, ox + i * cell, wy, wz) - iso
			}
		}
	}

	if (seal) {
		// Forcing the outermost corner shell outside makes the result watertight, and the
		// proof is short: a sign-changing edge must have at least one negative endpoint,
		// that endpoint is therefore interior on every axis, so all four cells around the
		// edge are in range and the dual quad is always emitted. Without this a shape that
		// touches the box leaves a hole, and a hole breaks shadows, CSG and mass properties.
		const v = cell
		for (let j = 0; j < gy; j++) {
			for (let i = 0; i < gx; i++) {
				const a = i + j * gx
				const b = a + (gz - 1) * gxy
				if (field[a] < v) field[a] = v
				if (field[b] < v) field[b] = v
			}
		}
		for (let k = 1; k < gz - 1; k++) {
			for (let i = 0; i < gx; i++) {
				const a = i + k * gxy
				const b = a + (gy - 1) * gx
				if (field[a] < v) field[a] = v
				if (field[b] < v) field[b] = v
			}
		}
		for (let k = 1; k < gz - 1; k++) {
			for (let j = 1; j < gy - 1; j++) {
				const a = j * gx + k * gxy
				const b = a + gx - 1
				if (field[a] < v) field[a] = v
				if (field[b] < v) field[b] = v
			}
		}
	}

	// --- one vertex per surface cell ------------------------------------
	const nxy = nx * ny
	const cellVert = new Int32Array(nxy * nz).fill(-1)
	const gradEps = Math.max(cell * gradEpsCells, 1e-9)
	const qefSlack = qefClampCells * cell

	let vcap = 4096
	let vpos = new Float32Array(vcap * 3)
	let vnrm = new Float32Array(vcap * 3)
	let vcount = 0

	for (let k = 0; k < nz; k++) {
		for (let j = 0; j < ny; j++) {
			for (let i = 0; i < nx; i++) {
				const base = i + j * gx + k * gxy
				snCorner[0] = field[base]
				snCorner[1] = field[base + 1]
				snCorner[2] = field[base + gx]
				snCorner[3] = field[base + gx + 1]
				snCorner[4] = field[base + gxy]
				snCorner[5] = field[base + gxy + 1]
				snCorner[6] = field[base + gxy + gx]
				snCorner[7] = field[base + gxy + gx + 1]

				let mask = 0
				for (let c = 0; c < 8; c++) if (snCorner[c] < 0) mask |= 1 << c
				if (mask === 0 || mask === 255) continue

				const cx0 = ox + i * cell
				const cy0 = oy + j * cell
				const cz0 = oz + k * cell

				let nc = 0
				let mx = 0
				let my = 0
				let mz = 0
				for (let e = 0; e < 12; e++) {
					const ea = SN_EDGE[e * 2]
					const eb = SN_EDGE[e * 2 + 1]
					const va = snCorner[ea]
					const vb = snCorner[eb]
					if ((va < 0) === (vb < 0)) continue
					// Signs differ, so va !== vb and the denominator cannot be zero.
					const t = va / (va - vb)
					const eax = ea & 1
					const eay = (ea >> 1) & 1
					const eaz = (ea >> 2) & 1
					const px = cx0 + (eax + ((eb & 1) - eax) * t) * cell
					const py = cy0 + (eay + (((eb >> 1) & 1) - eay) * t) * cell
					const pz = cz0 + (eaz + (((eb >> 2) & 1) - eaz) * t) * cell
					const o3 = nc * 3
					snCrossP[o3] = px
					snCrossP[o3 + 1] = py
					snCrossP[o3 + 2] = pz
					// The Hermite data is the REAL gradient of the field, not a difference of
					// the already-sampled corners. Corner differences are averaged over a whole
					// cell and cannot see which side of a panel edge they are on; this can, and
					// that is the entire reason a box corner comes out as a corner.
					gradInto(sdf, px, py, pz, gradEps, snCrossN, o3)
					mx += px
					my += py
					mz += pz
					nc++
				}
				if (nc === 0) continue

				const inv = 1 / nc
				mx *= inv
				my *= inv
				mz *= inv

				// Normal equations of min over x of sum (n_i . (x - p_i))^2, expressed
				// relative to the mass point so the system stays well conditioned at world
				// coordinates far from the origin.
				qefA.fill(0)
				qefB.fill(0)
				for (let c = 0; c < nc; c++) {
					const o3 = c * 3
					const anx = snCrossN[o3]
					const any = snCrossN[o3 + 1]
					const anz = snCrossN[o3 + 2]
					const dx = snCrossP[o3] - mx
					const dy = snCrossP[o3 + 1] - my
					const dz = snCrossP[o3 + 2] - mz
					const dd = anx * dx + any * dy + anz * dz
					qefA[0] += anx * anx
					qefA[1] += anx * any
					qefA[2] += anx * anz
					qefA[4] += any * any
					qefA[5] += any * anz
					qefA[8] += anz * anz
					qefB[0] += anx * dd
					qefB[1] += any * dd
					qefB[2] += anz * dd
				}
				qefA[3] = qefA[1]
				qefA[6] = qefA[2]
				qefA[7] = qefA[5]
				solveQef(qefTol)

				let vx = mx + qefY[0]
				let vy = my + qefY[1]
				let vz = mz + qefY[2]
				if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz)) {
					vx = mx
					vy = my
					vz = mz
				}
				// Clamping keeps the dual mesh from folding through itself. The slack is the
				// trade: zero rounds a corner that legitimately sits just past the cell wall,
				// too much lets a near-degenerate system throw a spike across the model.
				vx = clamp(vx, cx0 - qefSlack, cx0 + cell + qefSlack)
				vy = clamp(vy, cy0 - qefSlack, cy0 + cell + qefSlack)
				vz = clamp(vz, cz0 - qefSlack, cz0 + cell + qefSlack)

				if (vcount === vcap) {
					vcap *= 2
					const np = new Float32Array(vcap * 3)
					np.set(vpos)
					vpos = np
					const nn = new Float32Array(vcap * 3)
					nn.set(vnrm)
					vnrm = nn
				}
				const vo = vcount * 3
				vpos[vo] = vx
				vpos[vo + 1] = vy
				vpos[vo + 2] = vz
				gradInto(sdf, vx, vy, vz, gradEps, NORMAL_TMP, 0)
				vnrm[vo] = NORMAL_TMP[0]
				vnrm[vo + 1] = NORMAL_TMP[1]
				vnrm[vo + 2] = NORMAL_TMP[2]
				cellVert[i + j * nx + k * nxy] = vcount
				vcount++
			}
		}
	}

	if (vcount === 0) {
		return {
			positions: new Float32Array(0),
			normals: new Float32Array(0),
			indices: new Uint32Array(0),
			vertexCount: 0,
			indexCount: 0,
			cellSize: cell,
			cellsX: nx,
			cellsY: ny,
			cellsZ: nz,
		}
	}

	// --- quads dual to sign-changing grid edges -------------------------
	let icap = 8192
	let indices = new Uint32Array(icap)
	let icount = 0

	for (let k = 0; k < gz; k++) {
		for (let j = 0; j < gy; j++) {
			for (let i = 0; i < gx; i++) {
				const c0 = field[i + j * gx + k * gxy]
				const inside0 = c0 < 0

				// +X edge. The four cells around it are (i, j-1..j, k-1..k); listing them
				// counter-clockwise about +X makes the quad's normal point along +X, which is
				// the direction the surface faces when the low corner is the inside one.
				if (i < gx - 1 && j > 0 && j < gy - 1 && k > 0 && k < gz - 1) {
					if (inside0 !== (field[i + 1 + j * gx + k * gxy] < 0)) {
						icount = emitQuad(
							indices,
							icount,
							vpos,
							cellVert[i + (j - 1) * nx + (k - 1) * nxy],
							cellVert[i + j * nx + (k - 1) * nxy],
							cellVert[i + j * nx + k * nxy],
							cellVert[i + (j - 1) * nx + k * nxy],
							inside0,
						)
						if (icount > icap - 6) {
							icap *= 2
							const ni = new Uint32Array(icap)
							ni.set(indices)
							indices = ni
						}
					}
				}

				// +Y edge, cells (i-1..i, j, k-1..k); counter-clockwise about +Y is Z then X.
				if (j < gy - 1 && i > 0 && i < gx - 1 && k > 0 && k < gz - 1) {
					if (inside0 !== (field[i + (j + 1) * gx + k * gxy] < 0)) {
						icount = emitQuad(
							indices,
							icount,
							vpos,
							cellVert[i - 1 + j * nx + (k - 1) * nxy],
							cellVert[i - 1 + j * nx + k * nxy],
							cellVert[i + j * nx + k * nxy],
							cellVert[i + j * nx + (k - 1) * nxy],
							inside0,
						)
						if (icount > icap - 6) {
							icap *= 2
							const ni = new Uint32Array(icap)
							ni.set(indices)
							indices = ni
						}
					}
				}

				// +Z edge, cells (i-1..i, j-1..j, k); counter-clockwise about +Z is X then Y.
				if (k < gz - 1 && i > 0 && i < gx - 1 && j > 0 && j < gy - 1) {
					if (inside0 !== (field[i + j * gx + (k + 1) * gxy] < 0)) {
						icount = emitQuad(
							indices,
							icount,
							vpos,
							cellVert[i - 1 + (j - 1) * nx + k * nxy],
							cellVert[i + (j - 1) * nx + k * nxy],
							cellVert[i + j * nx + k * nxy],
							cellVert[i - 1 + j * nx + k * nxy],
							inside0,
						)
						if (icount > icap - 6) {
							icap *= 2
							const ni = new Uint32Array(icap)
							ni.set(indices)
							indices = ni
						}
					}
				}
			}
		}
	}

	if (icount === 0) {
		return {
			positions: new Float32Array(0),
			normals: new Float32Array(0),
			indices: new Uint32Array(0),
			vertexCount: 0,
			indexCount: 0,
			cellSize: cell,
			cellsX: nx,
			cellsY: ny,
			cellsZ: nz,
		}
	}

	return splitCreases(vpos, vnrm, vcount, indices, icount, creaseAngle, cell, nx, ny, nz)
}

/**
 * Two triangles for one dual quad, wound so the normal points from inside to outside.
 *
 * The split runs along the SHORTER diagonal. A quad straddling a bevel is strongly
 * non-planar, and splitting it the wrong way puts a visible dent along the highlight —
 * the shorter diagonal is the one that stays closest to the real surface.
 */
function emitQuad(
	indices: Uint32Array,
	icount: number,
	vpos: Float32Array,
	q0: number,
	q1: number,
	q2: number,
	q3: number,
	inside0: boolean,
): number {
	// Sealing guarantees all four cells carry a vertex; the guard is here because a caller
	// may switch sealing off, and a -1 index would silently corrupt the whole buffer.
	if (q0 < 0 || q1 < 0 || q2 < 0 || q3 < 0) return icount
	const a = q0
	const b = inside0 ? q1 : q3
	const c = q2
	const d = inside0 ? q3 : q1
	const ac = distSq(vpos, a, c)
	const bd = distSq(vpos, b, d)
	let o = icount
	if (ac <= bd) {
		indices[o] = a
		indices[o + 1] = b
		indices[o + 2] = c
		indices[o + 3] = a
		indices[o + 4] = c
		indices[o + 5] = d
	} else {
		indices[o] = b
		indices[o + 1] = c
		indices[o + 2] = d
		indices[o + 3] = b
		indices[o + 4] = d
		indices[o + 5] = a
	}
	o += 6
	return o
}

function distSq(vpos: Float32Array, a: number, b: number): number {
	const dx = vpos[a * 3] - vpos[b * 3]
	const dy = vpos[a * 3 + 1] - vpos[b * 3 + 1]
	const dz = vpos[a * 3 + 2] - vpos[b * 3 + 2]
	return dx * dx + dy * dy + dz * dz
}

// ---------------------------------------------------------------------------
// QEF
// ---------------------------------------------------------------------------

/**
 * Solve the 3x3 symmetric system in `qefA`/`qefB` into `qefY`, by eigen-decomposition with
 * the small eigenvalues truncated.
 *
 * A plain inverse is not usable: on a flat panel the matrix has rank 1 and on a bevel rank
 * 2, so it is singular almost everywhere on this kind of model. Truncating below a fraction
 * of the largest eigenvalue gives the pseudo-inverse, which solves exactly in the directions
 * that are actually constrained (across the panel, along the edge, into the corner) and
 * leaves the rest at the mass point. That is what makes a corner land on the corner and a
 * flat face stay flat, from the same code.
 *
 * Jacobi rather than a closed-form eigensolver because the cubic's discriminant loses
 * catastrophic precision on the near-degenerate matrices that make up most of a flat model,
 * and near-degenerate is the common case here, not the exception.
 */
function solveQef(tol: number): void {
	const a = qefA
	const v = qefV
	v.fill(0)
	v[0] = 1
	v[4] = 1
	v[8] = 1

	for (let sweep = 0; sweep < 12; sweep++) {
		const off = Math.abs(a[1]) + Math.abs(a[2]) + Math.abs(a[5])
		if (off < 1e-16) break
		for (let pair = 0; pair < 3; pair++) {
			const p = pair === 2 ? 1 : 0
			const q = pair === 0 ? 1 : 2
			const apq = a[p * 3 + q]
			if (Math.abs(apq) < 1e-20) continue
			const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq)
			const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
			const c = 1 / Math.sqrt(t * t + 1)
			const sn = t * c
			const r = 3 - p - q
			const arp = a[r * 3 + p]
			const arq = a[r * 3 + q]
			a[p * 3 + p] -= t * apq
			a[q * 3 + q] += t * apq
			a[p * 3 + q] = 0
			a[q * 3 + p] = 0
			a[r * 3 + p] = c * arp - sn * arq
			a[p * 3 + r] = a[r * 3 + p]
			a[r * 3 + q] = sn * arp + c * arq
			a[q * 3 + r] = a[r * 3 + q]
			for (let row = 0; row < 3; row++) {
				const vp = v[row * 3 + p]
				const vq = v[row * 3 + q]
				v[row * 3 + p] = c * vp - sn * vq
				v[row * 3 + q] = sn * vp + c * vq
			}
		}
	}

	const l0 = a[0]
	const l1 = a[4]
	const l2 = a[8]
	const cut = tol * Math.max(Math.abs(l0), Math.max(Math.abs(l1), Math.abs(l2)))
	qefY[0] = 0
	qefY[1] = 0
	qefY[2] = 0
	for (let e = 0; e < 3; e++) {
		const lam = a[e * 3 + e]
		// A^T A is positive semi-definite, so a non-positive eigenvalue is numerical noise
		// on a null direction — treat it as null rather than dividing by it.
		if (lam <= cut || lam <= 0) continue
		const ex = v[e]
		const ey = v[3 + e]
		const ez = v[6 + e]
		const d = (ex * qefB[0] + ey * qefB[1] + ez * qefB[2]) / lam
		qefY[0] += ex * d
		qefY[1] += ey * d
		qefY[2] += ez * d
	}
}

// ---------------------------------------------------------------------------
// Crease splitting
// ---------------------------------------------------------------------------

/** Most vertices sit on one smooth patch; a box corner needs three. Eight is slack. */
const MAX_GROUPS = 8

/**
 * Split vertices along creases, and compact away any vertex no triangle referenced.
 *
 * The QEF puts the geometry of a box corner exactly on the corner, but a single shared
 * normal there would still shade it as a soft blob — the crispness would be thrown away in
 * the last step. So every vertex's incident faces are grouped by angle, and each group gets
 * its own copy of the vertex with its own normal. A vertex that turns out to be smooth keeps
 * the analytic field gradient instead, which is more accurate than any average of the
 * triangles around it.
 *
 * Output order is (original vertex index, then group index), and adjacency is built by
 * counting sort in face order, so the result is deterministic down to the vertex ORDER —
 * not merely the same geometry in a different arrangement.
 */
function splitCreases(
	vpos: Float32Array,
	vnrm: Float32Array,
	vcount: number,
	indices: Uint32Array,
	icount: number,
	creaseAngle: number,
	cell: number,
	nx: number,
	ny: number,
	nz: number,
): SurfaceNetsResult {
	const faceCount = (icount / 3) | 0

	// Unnormalised face normals: the magnitude is twice the triangle area, which is exactly
	// the weight a normal average should use. A tiny sliver must not out-vote a whole panel.
	const fn = new Float32Array(faceCount * 3)
	for (let f = 0; f < faceCount; f++) {
		const a = indices[f * 3] * 3
		const b = indices[f * 3 + 1] * 3
		const c = indices[f * 3 + 2] * 3
		const e1x = vpos[b] - vpos[a]
		const e1y = vpos[b + 1] - vpos[a + 1]
		const e1z = vpos[b + 2] - vpos[a + 2]
		const e2x = vpos[c] - vpos[a]
		const e2y = vpos[c + 1] - vpos[a + 1]
		const e2z = vpos[c + 2] - vpos[a + 2]
		fn[f * 3] = e1y * e2z - e1z * e2y
		fn[f * 3 + 1] = e1z * e2x - e1x * e2z
		fn[f * 3 + 2] = e1x * e2y - e1y * e2x
	}

	const start = new Int32Array(vcount + 1)
	for (let c = 0; c < icount; c++) start[indices[c] + 1]++
	let maxDeg = 0
	for (let vtx = 0; vtx < vcount; vtx++) {
		if (start[vtx + 1] > maxDeg) maxDeg = start[vtx + 1]
		start[vtx + 1] += start[vtx]
	}
	const cursor = new Int32Array(vcount)
	const adjFace = new Int32Array(icount)
	const adjCorner = new Uint8Array(icount)
	for (let f = 0; f < faceCount; f++) {
		for (let c = 0; c < 3; c++) {
			const vtx = indices[f * 3 + c]
			const slot = start[vtx] + cursor[vtx]++
			adjFace[slot] = f
			adjCorner[slot] = c
		}
	}

	const cosCrease = Math.cos(clamp(creaseAngle, 0, 180) * DEG2RAD)
	const gAcc = new Float64Array(MAX_GROUPS * 3)
	const gOut = new Int32Array(MAX_GROUPS)
	const faceGroup = new Int32Array(Math.max(1, maxDeg))

	let ocap = vcount + (vcount >> 1) + 8
	let opos = new Float32Array(ocap * 3)
	let onrm = new Float32Array(ocap * 3)
	let ocount = 0

	for (let vtx = 0; vtx < vcount; vtx++) {
		const s0 = start[vtx]
		const s1 = start[vtx + 1]
		if (s0 === s1) continue // unreferenced: drop it rather than ship a dangling vertex

		let ng = 0
		for (let a = s0; a < s1; a++) {
			const f = adjFace[a]
			const fx = fn[f * 3]
			const fy = fn[f * 3 + 1]
			const fz = fn[f * 3 + 2]
			const fl = len3(fx, fy, fz)
			// A zero-area face has no direction to compare. Defer it rather than letting it
			// open a group of its own — a stray empty group would split a vertex that is
			// actually smooth and cost it its analytic normal.
			if (fl <= 1e-20) {
				faceGroup[a - s0] = -1
				continue
			}
			const ux = fx / fl
			const uy = fy / fl
			const uz = fz / fl
			let g = -1
			for (let q = 0; q < ng; q++) {
				const ax = gAcc[q * 3]
				const ay = gAcc[q * 3 + 1]
				const az = gAcc[q * 3 + 2]
				const al = len3(ax, ay, az)
				if (al < 1e-20) continue
				if ((ax * ux + ay * uy + az * uz) / al >= cosCrease) {
					g = q
					break
				}
			}
			if (g < 0) {
				if (ng < MAX_GROUPS) {
					g = ng++
					gAcc[g * 3] = 0
					gAcc[g * 3 + 1] = 0
					gAcc[g * 3 + 2] = 0
				} else {
					// A fan with more than eight distinct facets is a degenerate cell, not a
					// shape anyone modelled. Fold it in rather than growing unboundedly.
					g = MAX_GROUPS - 1
				}
			}
			gAcc[g * 3] += fx
			gAcc[g * 3 + 1] += fy
			gAcc[g * 3 + 2] += fz
			faceGroup[a - s0] = g
		}
		if (ng === 0) {
			// Every incident face was degenerate. One group, carrying the field gradient.
			ng = 1
			gAcc[0] = 0
			gAcc[1] = 0
			gAcc[2] = 0
		}
		for (let a = s0; a < s1; a++) if (faceGroup[a - s0] < 0) faceGroup[a - s0] = 0

		if (ocount + ng > ocap) {
			while (ocount + ng > ocap) ocap *= 2
			const np = new Float32Array(ocap * 3)
			np.set(opos)
			opos = np
			const nn = new Float32Array(ocap * 3)
			nn.set(onrm)
			onrm = nn
		}

		const px = vpos[vtx * 3]
		const py = vpos[vtx * 3 + 1]
		const pz = vpos[vtx * 3 + 2]
		for (let q = 0; q < ng; q++) {
			const oi = ocount++
			gOut[q] = oi
			opos[oi * 3] = px
			opos[oi * 3 + 1] = py
			opos[oi * 3 + 2] = pz
			if (ng === 1) {
				// Smooth here — the field gradient is the exact normal, and beats an average
				// of the handful of triangles that happen to touch this vertex.
				onrm[oi * 3] = vnrm[vtx * 3]
				onrm[oi * 3 + 1] = vnrm[vtx * 3 + 1]
				onrm[oi * 3 + 2] = vnrm[vtx * 3 + 2]
			} else {
				const ax = gAcc[q * 3]
				const ay = gAcc[q * 3 + 1]
				const az = gAcc[q * 3 + 2]
				const al = len3(ax, ay, az)
				if (al > 1e-20) {
					onrm[oi * 3] = ax / al
					onrm[oi * 3 + 1] = ay / al
					onrm[oi * 3 + 2] = az / al
				} else {
					onrm[oi * 3] = vnrm[vtx * 3]
					onrm[oi * 3 + 1] = vnrm[vtx * 3 + 1]
					onrm[oi * 3 + 2] = vnrm[vtx * 3 + 2]
				}
			}
		}

		for (let a = s0; a < s1; a++) indices[adjFace[a] * 3 + adjCorner[a]] = gOut[faceGroup[a - s0]]
	}

	return {
		positions: opos.slice(0, ocount * 3),
		normals: onrm.slice(0, ocount * 3),
		indices: indices.slice(0, icount),
		vertexCount: ocount,
		indexCount: icount,
		cellSize: cell,
		cellsX: nx,
		cellsY: ny,
		cellsZ: nz,
	}
}
