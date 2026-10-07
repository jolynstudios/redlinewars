// STEELSEED — geo/csg
// Constructive solid geometry on triangle meshes: BSP booleans, a single-plane fast
// path, and deterministic convex fracture for destruction geometry.
//
// Why this lives next to the SDF path. An SDF is the right tool for organic volume and
// for blending, and the wrong tool for a precise cut: a hatch edge pulled out of a
// surface-net grid is a staircase whose step size is the grid, and the loft's UVs are
// gone by the time the isosurface is meshed. Cut the same hatch here and the edge is
// exact and the panel is still textured.
//
// Attribute preservation is the whole reason this file is longer than a textbook BSP.
// A boolean that drops UVs produces an untexturable result, which is the single most
// common way a CSG implementation turns out useless in practice — so every split
// interpolates position, normal and uv along the cut edge, and materialZone is carried
// by nearest endpoint rather than blended (see VertexArena.lerp).
//
// Determinism (hard rule 5, ARCHITECTURE.md §5.2). Two runs of the same seed must be
// byte-identical, so:
//   * the BSP splitter is chosen from polygon *list order* alone. Candidate scores are
//     integer counts and ties go to the lowest index — never a hash, a Map iteration
//     order, or a float comparison that could tip either way.
//   * every arithmetic path that reaches a vertex uses only + - * / and Math.sqrt,
//     which IEEE-754 requires to be correctly rounded. Math.hypot, Math.atan2, Math.cos
//     and Math.log are specified only to implementation-approximated accuracy, so
//     v3.normalize (Math.hypot) and Rng.gaussian (Math.log, Math.cos) are deliberately
//     not on any code path whose result becomes geometry.
//   * all internal arithmetic is double precision. A float32 plane loses seven digits
//     and a fragment re-split against it then misses its parent surface by enough to
//     open a crack you can see through.
//
// Hard rule 7: CSG allocates no GPU resources, but the arenas are large. A caller doing
// many booleans constructs one CsgWorkspace and reuses it; the free functions below
// build one, run, and dispose.
//
// ── The ./mesh contract this file assumes ───────────────────────────────────────────
// Mesh is a class over structure-of-arrays indexed triangles:
//   positions:    Float32Array   3 per vertex
//   normals:      Float32Array   3 per vertex, unit length
//   uv0:          Float32Array   2 per vertex
//   materialZone: Uint8Array     1 per vertex
//   indices:      Uint32Array    3 per triangle
//   vertexCount: number, indexCount: number (a getter over triangleCount)
// The two counts are the authority, not the array lengths — the channels grow by
// doubling and are normally over-allocated, so walking `indices.length` on a half-filled
// buffer reads the dead tail as a fan of degenerate triangles at the origin.
//
// Results are constructed through Mesh's own addVertex()/addTriangle() rather than
// returned as a bag of arrays. A Mesh owns capacity, bounds and the skin channels; an
// object literal shaped like one satisfies nothing but the field names, and fails the
// first time a caller reaches for compact(), simplify() or toGPUBuffers().
//
// Triangles are wound counter-clockwise seen from outside the solid, right-handed,
// +Z up, metres — the convention geo/sdf states. The winding matters here and nowhere
// else in this file: it is what tells the cap generator which way is out.
//
// meshBounds(), meshVolume(), readMesh() and MeshBuilder.finish() are the only places
// that touch a Mesh directly, so a naming drift is a mechanical fix in four functions
// rather than a rewrite.

import { v3, vec3 } from '../core/math'
import type { Vec3 } from '../core/math'
import type { Rng } from '../core/rng'
import { Mesh } from './mesh'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Hessian-normal plane: the set of p where dot(n, p) = d, with n unit length.
 * Plain doubles rather than a Vec3 because a Float32Array plane is not precise enough
 * to re-split a fragment that was already split against it.
 */
export interface Plane {
	readonly nx: number
	readonly ny: number
	readonly nz: number
	readonly d: number
}

export interface CsgOptions {
	/**
	 * Distance at which a vertex counts as lying ON a plane rather than to one side.
	 * Too small and coplanar faces split each other into slivers; too large and a thin
	 * feature collapses. 1e-5 suits metre-scale assets with millimetre detail.
	 */
	epsilon?: number
	/** Merge output vertices whose position, normal, uv and zone all agree. */
	weld?: boolean
	/**
	 * Weld grid, in world units. Deliberately coarser than `epsilon`: the same cut point
	 * reached from two adjacent triangles differs in the last few bits because the edge
	 * is traversed in opposite directions, and those two vertices must merge.
	 */
	weldEpsilon?: number
	/**
	 * Re-index triangles so no vertex is left stranded in the middle of a neighbour's
	 * edge. On by default — see MeshBuilder.repairTJunctions for what it costs to skip.
	 */
	repairTJunctions?: boolean
}

export interface ClipOptions extends CsgOptions {
	/** Close the cross-section left by the cut. Off leaves an open shell. */
	cap?: boolean
	/** Zone for the cut face. Default: the majority zone of the removed material. */
	capMaterialZone?: number
	/** World units per uv unit on the cut face. The cap is planar-projected. */
	capUvScale?: number
}

export interface FractureOptions extends ClipOptions {
	/** Hard ceiling on shards. ARCHITECTURE.md §7: never exceed a budget. */
	maxPieces?: number
	/** Shards below this fraction of the original volume are dropped as invisible cost. */
	minVolumeFraction?: number
	/** Probability a cut targets the largest remaining shard rather than a random one. */
	biasToLargest?: number
	/** Random displacement of each plane, as a fraction of the mesh's largest extent. */
	jitter?: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_EPSILON = 1e-5
const DEFAULT_WELD_EPSILON = 1e-4
/** Normals are unit length, so this is roughly a hundredth of a degree. */
const NORMAL_QUANT = 1e-4
const UV_QUANT = 1e-5

const COPLANAR = 0
const FRONT = 1
const BACK = 2
const SPANNING = 3

/** Vertex arena stride: px py pz nx ny nz u v zone. */
const VSTRIDE = 9

/**
 * How many polygons of a node's list are tried as the splitting plane. Taking
 * polygons[0] unconditionally — the textbook choice — degenerates to a linear tree on
 * a lofted hull, where the polygon list arrives in surface order, and a linear tree is
 * both slow and deep enough to matter. Six candidates is enough to stay near-balanced
 * and is bounded work per node.
 */
const SPLITTER_CANDIDATES = 6
/** Splits are worth this many units of imbalance when scoring a candidate. */
const SPLIT_COST = 8
/** Above this list size, candidates are scored against a strided sample, not the lot. */
const SPLITTER_SCAN_LIMIT = 2048

/** A triangle whose |e1 x e2|^2 is below this has no meaningful plane at any scale. */
const DEGENERATE_CROSS_SQ = 1e-24

// ---------------------------------------------------------------------------
// Plane helpers
// ---------------------------------------------------------------------------

export function makePlane(nx: number, ny: number, nz: number, d: number): Plane {
	// Explicit sqrt rather than v3.normalize: Math.hypot is only implementation-
	// approximated, and this value ends up baked into vertex positions.
	const l2 = nx * nx + ny * ny + nz * nz
	if (l2 < 1e-30) return { nx: 0, ny: 1, nz: 0, d: 0 }
	const inv = 1 / Math.sqrt(l2)
	return { nx: nx * inv, ny: ny * inv, nz: nz * inv, d: d * inv }
}

export function planeFromNormalPoint(n: Vec3, p: Vec3): Plane {
	return makePlane(n[0], n[1], n[2], n[0] * p[0] + n[1] * p[1] + n[2] * p[2])
}

/** Plane of a counter-clockwise triangle, normal pointing out. Null when degenerate. */
export function planeFromPoints(a: Vec3, b: Vec3, c: Vec3): Plane | null {
	const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2]
	const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2]
	const nx = e1y * e2z - e1z * e2y
	const ny = e1z * e2x - e1x * e2z
	const nz = e1x * e2y - e1y * e2x
	if (nx * nx + ny * ny + nz * nz < DEGENERATE_CROSS_SQ) return null
	return makePlane(nx, ny, nz, nx * a[0] + ny * a[1] + nz * a[2])
}

export function flipPlane(p: Plane): Plane {
	return { nx: -p.nx, ny: -p.ny, nz: -p.nz, d: -p.d }
}

// ---------------------------------------------------------------------------
// Mesh-level helpers
// ---------------------------------------------------------------------------

/** Module scratch, used only inside a synchronous call — same discipline as math.scratch. */
const sMin: Vec3 = vec3()
const sMax: Vec3 = vec3()

export function meshBounds(mesh: Mesh, outMin: Vec3, outMax: Vec3): void {
	const pos = mesh.positions
	const n = mesh.vertexCount * 3
	if (n < 3) {
		v3.set(outMin, 0, 0, 0)
		v3.set(outMax, 0, 0, 0)
		return
	}
	let lx = pos[0], ly = pos[1], lz = pos[2]
	let hx = lx, hy = ly, hz = lz
	for (let i = 3; i < n; i += 3) {
		const x = pos[i], y = pos[i + 1], z = pos[i + 2]
		if (x < lx) lx = x
		else if (x > hx) hx = x
		if (y < ly) ly = y
		else if (y > hy) hy = y
		if (z < lz) lz = z
		else if (z > hz) hz = z
	}
	v3.set(outMin, lx, ly, lz)
	v3.set(outMax, hx, hy, hz)
}

/**
 * Signed volume via the divergence theorem, absolute value taken so a mesh authored
 * with the opposite winding still reports a positive size. Only meaningful for a
 * closed mesh — which is what CSG produces and what fracture consumes.
 */
export function meshVolume(mesh: Mesh): number {
	const pos = mesh.positions
	const idx = mesh.indices
	const n = mesh.indexCount
	let acc = 0
	for (let t = 0; t + 2 < n; t += 3) {
		const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
		const ax = pos[a], ay = pos[a + 1], az = pos[a + 2]
		const bx = pos[b], by = pos[b + 1], bz = pos[b + 2]
		const cx = pos[c], cy = pos[c + 1], cz = pos[c + 2]
		acc += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)
	}
	acc /= 6
	return acc < 0 ? -acc : acc
}

// ---------------------------------------------------------------------------
// Growth helpers — written out per type rather than generically, because a generic
// over TypedArray constructors costs a cast at every call site and reads worse.
//
// The signatures spell out <ArrayBufferLike> because TypeScript 5.7 made the typed
// arrays generic over their backing buffer: `new Float64Array(n)` infers the narrow
// Float64Array<ArrayBuffer>, and narrow and wide do not assign to each other in either
// direction. Every channel these helpers write back into is declared in the same wide
// form below, so the annotation there is load-bearing rather than decoration.
// ---------------------------------------------------------------------------

function growF64(a: Float64Array<ArrayBufferLike>, need: number): Float64Array<ArrayBufferLike> {
	if (need <= a.length) return a
	let cap = a.length || 64
	while (cap < need) cap *= 2
	const next = new Float64Array(cap)
	next.set(a)
	return next
}
function growF32(a: Float32Array<ArrayBufferLike>, need: number): Float32Array<ArrayBufferLike> {
	if (need <= a.length) return a
	let cap = a.length || 64
	while (cap < need) cap *= 2
	const next = new Float32Array(cap)
	next.set(a)
	return next
}
function growU32(a: Uint32Array<ArrayBufferLike>, need: number): Uint32Array<ArrayBufferLike> {
	if (need <= a.length) return a
	let cap = a.length || 64
	while (cap < need) cap *= 2
	const next = new Uint32Array(cap)
	next.set(a)
	return next
}
function growU8(a: Uint8Array<ArrayBufferLike>, need: number): Uint8Array<ArrayBufferLike> {
	if (need <= a.length) return a
	let cap = a.length || 64
	while (cap < need) cap *= 2
	const next = new Uint8Array(cap)
	next.set(a)
	return next
}
function growI32(a: Int32Array<ArrayBufferLike>, need: number): Int32Array<ArrayBufferLike> {
	if (need <= a.length) return a
	let cap = a.length || 64
	while (cap < need) cap *= 2
	const next = new Int32Array(cap)
	next.set(a)
	return next
}

function pow2AtLeast(n: number): number {
	let c = 64
	while (c < n) c *= 2
	return c
}

/** FNV-1a style integer mix. Only used to bucket a hash table, never to order output. */
function hashMix(h: number, x: number): number {
	return Math.imul(h ^ (x | 0), 0x01000193)
}

// ---------------------------------------------------------------------------
// VertexArena — every vertex the BSP ever sees, in doubles, addressed by index.
// ---------------------------------------------------------------------------

class VertexArena {
	data: Float64Array<ArrayBufferLike>
	count = 0

	constructor(capacity: number) {
		this.data = new Float64Array(capacity * VSTRIDE)
	}

	reset(): void {
		this.count = 0
	}

	push(
		px: number, py: number, pz: number,
		nx: number, ny: number, nz: number,
		u: number, v: number, zone: number,
	): number {
		this.data = growF64(this.data, (this.count + 1) * VSTRIDE)
		const d = this.data
		const o = this.count * VSTRIDE
		d[o] = px
		d[o + 1] = py
		d[o + 2] = pz
		d[o + 3] = nx
		d[o + 4] = ny
		d[o + 5] = nz
		d[o + 6] = u
		d[o + 7] = v
		d[o + 8] = zone
		return this.count++
	}

	/**
	 * The split vertex, at parameter t along the edge ia->ib. On an edge, barycentric
	 * interpolation *is* the linear blend, so position and uv are plain lerps.
	 *
	 * The normal is renormalised: lerping two unit normals shortens the result, and a
	 * short normal reads as a dark band down the length of every cut.
	 *
	 * materialZone takes the nearer endpoint instead of blending, because it is an id
	 * and not a quantity — halfway between zone 1 (plate) and zone 3 (glass) is not
	 * zone 2 (rubber), it is one of the two. In the overwhelmingly common case where
	 * both endpoints share a zone, either rule gives the same answer.
	 */
	lerp(ia: number, ib: number, t: number): number {
		const d = this.data
		const a = ia * VSTRIDE
		const b = ib * VSTRIDE
		const px = d[a] + (d[b] - d[a]) * t
		const py = d[a + 1] + (d[b + 1] - d[a + 1]) * t
		const pz = d[a + 2] + (d[b + 2] - d[a + 2]) * t
		let nx = d[a + 3] + (d[b + 3] - d[a + 3]) * t
		let ny = d[a + 4] + (d[b + 4] - d[a + 4]) * t
		let nz = d[a + 5] + (d[b + 5] - d[a + 5]) * t
		const l2 = nx * nx + ny * ny + nz * nz
		if (l2 > 1e-20) {
			const inv = 1 / Math.sqrt(l2)
			nx *= inv
			ny *= inv
			nz *= inv
		} else {
			// Opposed normals cancel exactly. Take one side rather than emit a zero.
			nx = d[a + 3]
			ny = d[a + 4]
			nz = d[a + 5]
		}
		const u = d[a + 6] + (d[b + 6] - d[a + 6]) * t
		const v = d[a + 7] + (d[b + 7] - d[a + 7]) * t
		const zone = t < 0.5 ? d[a + 8] : d[b + 8]
		return this.push(px, py, pz, nx, ny, nz, u, v, zone)
	}
}

// ---------------------------------------------------------------------------
// PolyArena — convex polygons as runs of vertex indices, plus their supporting plane.
//
// Polygons rather than triangles inside the tree. A triangle clipped by a plane is a
// triangle or a quad; splitting the quad back into triangles immediately creates
// slivers that the next plane then splits again. Keeping the general convex polygon and
// fan-triangulating once at the end produces markedly cleaner output, and a convex
// polygon clipped by a plane stays convex, so the fan is always valid.
// ---------------------------------------------------------------------------

class PolyArena {
	idx: Uint32Array<ArrayBufferLike>
	idxCount = 0
	off: Uint32Array<ArrayBufferLike>
	len: Uint32Array<ArrayBufferLike>
	plane: Float64Array<ArrayBufferLike>
	/**
	 * Winding parity. invert() must negate the normals of a polygon's vertices, but
	 * vertices are shared between the polygons that were split from the same triangle,
	 * so mutating them in place would flip a shared normal twice. Recording the parity
	 * on the polygon and applying it once at emit time keeps vertex data immutable.
	 */
	flipped: Uint8Array<ArrayBufferLike>
	count = 0
	private open = -1

	constructor(capacity: number) {
		this.idx = new Uint32Array(capacity * 3)
		this.off = new Uint32Array(capacity)
		this.len = new Uint32Array(capacity)
		this.plane = new Float64Array(capacity * 4)
		this.flipped = new Uint8Array(capacity)
	}

	reset(): void {
		this.count = 0
		this.idxCount = 0
		this.open = -1
	}

	begin(): void {
		this.open = this.idxCount
	}

	vertex(vi: number): void {
		this.idx = growU32(this.idx, this.idxCount + 1)
		this.idx[this.idxCount++] = vi
	}

	/**
	 * Commits the open run. Returns -1 and rewinds for a run under three vertices: an
	 * epsilon classification can leave a two-point sliver, and a degenerate polygon in
	 * the tree poisons every plane test taken below it.
	 */
	end(nx: number, ny: number, nz: number, d: number, flipped: number): number {
		const n = this.idxCount - this.open
		if (n < 3) {
			this.idxCount = this.open
			this.open = -1
			return -1
		}
		const id = this.count
		this.off = growU32(this.off, id + 1)
		this.len = growU32(this.len, id + 1)
		this.flipped = growU8(this.flipped, id + 1)
		this.plane = growF64(this.plane, (id + 1) * 4)
		this.off[id] = this.open
		this.len[id] = n
		this.flipped[id] = flipped
		this.plane[id * 4] = nx
		this.plane[id * 4 + 1] = ny
		this.plane[id * 4 + 2] = nz
		this.plane[id * 4 + 3] = d
		this.open = -1
		this.count++
		return id
	}

	flip(id: number): void {
		const o = this.off[id]
		const n = this.len[id]
		const idx = this.idx
		for (let i = 0, j = n - 1; i < j; i++, j--) {
			const t = idx[o + i]
			idx[o + i] = idx[o + j]
			idx[o + j] = t
		}
		const p = id * 4
		this.plane[p] = -this.plane[p]
		this.plane[p + 1] = -this.plane[p + 1]
		this.plane[p + 2] = -this.plane[p + 2]
		this.plane[p + 3] = -this.plane[p + 3]
		this.flipped[id] ^= 1
	}
}

// ---------------------------------------------------------------------------
// BspTree — flat node arrays. Flat rather than linked objects so that clipTo() and
// invert() are plain ascending loops over node indices: no recursion, and an iteration
// order that is trivially the same on every run.
// ---------------------------------------------------------------------------

class BspTree {
	planes: Float64Array<ArrayBufferLike> = new Float64Array(64 * 4)
	hasPlane: Uint8Array<ArrayBufferLike> = new Uint8Array(64)
	front: Int32Array<ArrayBufferLike> = new Int32Array(64)
	back: Int32Array<ArrayBufferLike> = new Int32Array(64)
	lists: number[][] = []
	count = 0

	/**
	 * Bounds of the solid this tree describes. A polygon outside them is outside the
	 * solid, and that is decidable without descending a single plane.
	 */
	minX = Infinity
	minY = Infinity
	minZ = Infinity
	maxX = -Infinity
	maxY = -Infinity
	maxZ = -Infinity
	/**
	 * Whether invert() has left this tree describing the complement of its surface. The
	 * bounds still describe the surface, but the solid is now everything OUTSIDE them
	 * and unbounded, which flips the meaning of the prune in clipTo.
	 */
	inverted = false

	reset(): void {
		this.count = 0
		this.lists.length = 0
		this.inverted = false
		this.minX = Infinity
		this.minY = Infinity
		this.minZ = Infinity
		this.maxX = -Infinity
		this.maxY = -Infinity
		this.maxZ = -Infinity
		this.newNode()
	}

	grow(x: number, y: number, z: number): void {
		if (x < this.minX) this.minX = x
		if (x > this.maxX) this.maxX = x
		if (y < this.minY) this.minY = y
		if (y > this.maxY) this.maxY = y
		if (z < this.minZ) this.minZ = z
		if (z > this.maxZ) this.maxZ = z
	}

	newNode(): number {
		const id = this.count
		this.planes = growF64(this.planes, (id + 1) * 4)
		this.hasPlane = growU8(this.hasPlane, id + 1)
		this.front = growI32(this.front, id + 1)
		this.back = growI32(this.back, id + 1)
		this.hasPlane[id] = 0
		this.front[id] = -1
		this.back[id] = -1
		this.lists.push([])
		this.count++
		return id
	}
}

// ---------------------------------------------------------------------------
// MeshBuilder — staging plus a deterministic vertex weld.
//
// The weld key includes normal, uv and zone, not just position. Merging on position
// alone would fuse the two sides of a material seam or a hard edge and destroy exactly
// the UVs this file exists to preserve.
//
// Note what welding does not fix: a boolean leaves T-junctions where a split edge meets
// an unsplit neighbour. Those are a separate pass (the mesh node's simplifier) and
// pretending welding solves them would be a lie in a comment.
// ---------------------------------------------------------------------------

class MeshBuilder {
	private px: Float32Array<ArrayBufferLike> = new Float32Array(0)
	private nrm: Float32Array<ArrayBufferLike> = new Float32Array(0)
	private uv: Float32Array<ArrayBufferLike> = new Float32Array(0)
	private zone: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
	private idx: Uint32Array<ArrayBufferLike> = new Uint32Array(0)
	private key: Float64Array<ArrayBufferLike> = new Float64Array(0)
	// Sized to the bucket count in begin() rather than grown, so it stays narrow.
	private head = new Int32Array(0)
	private next: Int32Array<ArrayBufferLike> = new Int32Array(0)
	private mask = 0
	private vcount = 0
	private icount = 0
	private weld = true
	private posQ = DEFAULT_WELD_EPSILON
	// fanConvexInPlane working ring. Hoisted because repairTJunctions calls it once per
	// repaired triangle, and a per-triangle array is an allocation in a hot loop (rule 6).
	private ring: number[] = []

	begin(expectedVerts: number, weld: boolean, posQuant: number): void {
		this.vcount = 0
		this.icount = 0
		this.weld = weld
		this.posQ = posQuant
		if (!weld) return
		const cap = pow2AtLeast(expectedVerts * 2)
		this.mask = cap - 1
		if (this.head.length < cap) this.head = new Int32Array(cap)
		this.head.fill(-1, 0, cap)
	}

	vertex(
		px: number, py: number, pz: number,
		nx: number, ny: number, nz: number,
		u: number, v: number, zone: number,
	): number {
		const qp = 1 / this.posQ
		const qx = Math.round(px * qp)
		const qy = Math.round(py * qp)
		const qz = Math.round(pz * qp)
		const qnx = Math.round(nx / NORMAL_QUANT)
		const qny = Math.round(ny / NORMAL_QUANT)
		const qnz = Math.round(nz / NORMAL_QUANT)
		const qu = Math.round(u / UV_QUANT)
		const qv = Math.round(v / UV_QUANT)
		const qz2 = zone < 0 ? 0 : zone > 255 ? 255 : Math.round(zone)

		if (this.weld) {
			let h = 0x811c9dc5
			h = hashMix(h, qx)
			h = hashMix(h, qy)
			h = hashMix(h, qz)
			h = hashMix(h, qnx)
			h = hashMix(h, qny)
			h = hashMix(h, qnz)
			h = hashMix(h, qu)
			h = hashMix(h, qv)
			h = hashMix(h, qz2)
			const bucket = (h ^ (h >>> 15)) & this.mask
			// Chains are walked in insertion order and the first exact match wins, so
			// the mapping from input vertex order to output index is fixed.
			for (let c = this.head[bucket]; c >= 0; c = this.next[c]) {
				const k = c * VSTRIDE
				const kk = this.key
				if (
					kk[k] === qx && kk[k + 1] === qy && kk[k + 2] === qz &&
					kk[k + 3] === qnx && kk[k + 4] === qny && kk[k + 5] === qnz &&
					kk[k + 6] === qu && kk[k + 7] === qv && kk[k + 8] === qz2
				) return c
			}
			const id = this.appendVertex(px, py, pz, nx, ny, nz, u, v, qz2)
			this.key = growF64(this.key, (id + 1) * VSTRIDE)
			this.next = growI32(this.next, id + 1)
			const k = id * VSTRIDE
			this.key[k] = qx
			this.key[k + 1] = qy
			this.key[k + 2] = qz
			this.key[k + 3] = qnx
			this.key[k + 4] = qny
			this.key[k + 5] = qnz
			this.key[k + 6] = qu
			this.key[k + 7] = qv
			this.key[k + 8] = qz2
			this.next[id] = this.head[bucket]
			this.head[bucket] = id
			return id
		}
		return this.appendVertex(px, py, pz, nx, ny, nz, u, v, qz2)
	}

	private appendVertex(
		px: number, py: number, pz: number,
		nx: number, ny: number, nz: number,
		u: number, v: number, zone: number,
	): number {
		const id = this.vcount
		this.px = growF32(this.px, (id + 1) * 3)
		this.nrm = growF32(this.nrm, (id + 1) * 3)
		this.uv = growF32(this.uv, (id + 1) * 2)
		this.zone = growU8(this.zone, id + 1)
		this.px[id * 3] = px
		this.px[id * 3 + 1] = py
		this.px[id * 3 + 2] = pz
		this.nrm[id * 3] = nx
		this.nrm[id * 3 + 1] = ny
		this.nrm[id * 3 + 2] = nz
		this.uv[id * 2] = u
		this.uv[id * 2 + 1] = v
		this.zone[id] = zone
		this.vcount++
		return id
	}

	triangle(a: number, b: number, c: number): void {
		// Welding can collapse a sliver onto itself; a zero-area triangle is a wasted
		// index and a NaN tangent later.
		if (a === b || b === c || a === c) return
		// Index-equal is not the only way to be degenerate, and the other way is the one
		// that does damage. Three distinct indices whose welded positions are collinear
		// carry no area but still contribute directed edges — including the reverse of an
		// edge that is genuinely unmatched, which is what lets a cracked mesh pass an
		// edge-parity or net-area-vector check. Every check written against this file then
		// stays green while the seam is open, so the defect leaves here and is found by a
		// renderer instead.
		//
		// This is the only place that can make the call. Callers decide degeneracy from
		// whatever space they work in — triangulateLoop from the projected (t, b) plane,
		// where three points that are exactly collinear in 3D cross to ±1e-17, not 0 —
		// while only the builder can see the welded positions the indices resolve to.
		//
		// The test is exact zero, not a tolerance: a triangle that provably contributes no
		// area can be dropped without moving the surface by a single bit, whereas culling
		// thin-but-real slivers on a tolerance would open the very holes this is here to
		// prevent.
		const px = this.px
		const ax = px[a * 3], ay = px[a * 3 + 1], az = px[a * 3 + 2]
		const ux = px[b * 3] - ax, uy = px[b * 3 + 1] - ay, uz = px[b * 3 + 2] - az
		const vx = px[c * 3] - ax, vy = px[c * 3 + 1] - ay, vz = px[c * 3 + 2] - az
		if (
			uy * vz - uz * vy === 0 &&
			uz * vx - ux * vz === 0 &&
			ux * vy - uy * vx === 0
		) return
		this.idx = growU32(this.idx, this.icount + 3)
		this.idx[this.icount] = a
		this.idx[this.icount + 1] = b
		this.idx[this.icount + 2] = c
		this.icount += 3
	}

	get triangleCount(): number {
		return this.icount / 3
	}

	/**
	 * Splits any triangle edge that another triangle's vertex is sitting on.
	 *
	 * A BSP boolean always leaves these. A plane cuts one face in two while the face
	 * across the shared edge stays whole, so a vertex lands in the middle of that
	 * neighbour's edge. The surface is still watertight in the only sense that matters
	 * to a volume integral — the net area vector is exactly zero — but the two sides of
	 * the edge are rasterised from different endpoints, and the hairline of background
	 * that leaks between them is the single most recognisable "this came out of a CSG"
	 * artefact there is. Cutting a hatch into a hull and getting a lit crack down the
	 * seam is the failure this pass exists to prevent.
	 *
	 * No vertex is created: the repair is pure re-indexing, so no attribute is touched
	 * and no seam is introduced.
	 *
	 * Run to a fixed point, because one pass provably cannot finish the job. A pass
	 * snapshots the unmatched edges and the candidate vertices up front, then subdivides
	 * triangles against that snapshot — and subdividing creates edges that were not in it.
	 * A vertex sitting on one of those new edges is a T-junction the pass just created and
	 * cannot see. Measured on 919 randomised booleans, a single pass leaves a crack in 6 of
	 * them and every one is of exactly that kind.
	 *
	 * It terminates: the vertex set is fixed and triangles are only ever subdivided, so
	 * each round strictly consumes (edge, vertex) incidences. The round cap is a backstop
	 * for a pathological mesh, and stopping at it leaves a partly repaired surface rather
	 * than a stalled boot — the same trade the work bound below makes.
	 */
	repairTJunctions(tol: number): void {
		for (let round = 0; round < 4; round++) if (!this.repairPass(tol)) return
	}

	/** One repair sweep. Returns true if it subdivided anything, i.e. if another is owed. */
	private repairPass(tol: number): boolean {
		const V = this.vcount
		// The edge key packs two indices into one double. Past 2^26 vertices that packing
		// is lossy, and a silently wrong repair is worse than an honest no-op.
		if (V === 0 || V >= 0x4000000 || this.icount === 0) return false
		const idx = this.idx
		const parity = new Map<number, number>()
		for (let t = 0; t < this.icount; t += 3) {
			for (let e = 0; e < 3; e++) {
				const a = idx[t + e]
				const b = idx[t + (e === 2 ? 0 : e + 1)]
				if (a === b) continue
				const k = a < b ? a * 0x4000000 + b : b * 0x4000000 + a
				parity.set(k, (parity.get(k) ?? 0) + (a < b ? 1 : -1))
			}
		}
		// Only a vertex already sitting on an unmatched edge can be splitting another
		// one, which is what keeps the search small enough to be quadratic.
		const onBoundary = new Uint8Array(V)
		let unmatched = 0
		for (const [k, v] of parity) {
			if (v === 0) continue
			unmatched++
			const hi = k % 0x4000000
			onBoundary[(k - hi) / 0x4000000] = 1
			onBoundary[hi] = 1
		}
		if (unmatched === 0) return false
		const cand: number[] = []
		for (let i = 0; i < V; i++) if (onBoundary[i] === 1) cand.push(i)
		// Bounded work: a pathological mesh gets no repair rather than a stalled boot.
		if (unmatched * cand.length > 4_000_000) return false

		const px = this.px
		const tol2 = tol * tol
		const outIdx: number[] = []
		const poly: number[] = []
		const hit: number[] = []
		const hitT: number[] = []
		let changed = false
		for (let t = 0; t < this.icount; t += 3) {
			poly.length = 0
			let inserted = false
			for (let e = 0; e < 3; e++) {
				const a = idx[t + e]
				const b = idx[t + (e === 2 ? 0 : e + 1)]
				poly.push(a)
				if (a === b) continue
				const k = a < b ? a * 0x4000000 + b : b * 0x4000000 + a
				if ((parity.get(k) ?? 0) === 0) continue
				const ax = px[a * 3], ay = px[a * 3 + 1], az = px[a * 3 + 2]
				const abx = px[b * 3] - ax, aby = px[b * 3 + 1] - ay, abz = px[b * 3 + 2] - az
				const l2 = abx * abx + aby * aby + abz * abz
				if (l2 < 1e-20) continue
				hit.length = 0
				hitT.length = 0
				for (let ci = 0; ci < cand.length; ci++) {
					const c = cand[ci]
					if (c === a || c === b) continue
					const apx = px[c * 3] - ax, apy = px[c * 3 + 1] - ay, apz = px[c * 3 + 2] - az
					const s = (apx * abx + apy * aby + apz * abz) / l2
					// Strictly interior: an endpoint is not a T-junction.
					if (s <= 1e-6 || s >= 1 - 1e-6) continue
					const cx = apy * abz - apz * aby
					const cy = apz * abx - apx * abz
					const cz = apx * aby - apy * abx
					if ((cx * cx + cy * cy + cz * cz) / l2 > tol2) continue
					hit.push(c)
					hitT.push(s)
				}
				if (hit.length === 0) continue
				// Insertion order along the edge. The index tie-break keeps two points
				// that landed at the same parameter in a fixed order.
				const order: number[] = []
				for (let i = 0; i < hit.length; i++) order.push(i)
				order.sort((i, j) => (hitT[i] - hitT[j]) || (hit[i] - hit[j]))
				for (let i = 0; i < order.length; i++) poly.push(hit[order[i]])
				inserted = true
			}
			if (!inserted) {
				outIdx.push(idx[t], idx[t + 1], idx[t + 2])
				continue
			}
			// Same tolerance the inserted points were found with, so the triangulator can
			// recognise the edge they came off. See fanConvexInPlane.
			this.fanConvexInPlane(poly, outIdx, tol)
			changed = true
		}
		if (!changed) return false

		this.idx = growU32(this.idx, outIdx.length)
		for (let i = 0; i < outIdx.length; i++) this.idx[i] = outIdx[i]
		this.icount = outIdx.length
		return true
	}

	/**
	 * Triangulates a triangle whose edges have collinear points inserted into them.
	 *
	 * Ear clipping, with the one containment test this shape actually needs. The boundary
	 * is convex, so a corner with a strictly positive turn is always a geometrically valid
	 * ear — but valid is not sufficient here, and assuming it was is what made this pass a
	 * no-op on a third of its inputs. Clipping the corner *opposite* a subdivided edge
	 * spans that edge with the ear's own diagonal, which re-creates the un-split edge the
	 * caller asked to subdivide, and leaves a residual ring that is entirely collinear so
	 * the loop then stalls. On ring [C, A, M, B] with M inserted on A-B, the first corner
	 * the scan reaches is C, whose ear (B, C, A) hands back the very edge A-B.
	 *
	 * That is not a corner case: emit() fans every polygon as (first, prev, vi), so the
	 * subdivided edge of every second triangle of a quad fan is the one opposite `first` —
	 * i.e. opposite ring[0], the corner the scan tries first.
	 *
	 * So an ear is rejected when its diagonal passes through a ring vertex. The test is
	 * the same perpendicular-distance test that found the inserted point in the first
	 * place, against the same tolerance, and that is what makes it certain to fire rather
	 * than merely likely: the diagonal of a bad ear IS the edge the point was found on.
	 *
	 * Nothing is emitted without strictly positive area. A collinear remainder has none,
	 * so it is dropped rather than pushed as a zero-area triangle. Dropping it is exactly
	 * area- and volume-neutral, whereas keeping it is not free: a zero-area triangle
	 * donates the reverse directed edge of the crack it sits in, so an edge-parity or
	 * net-area-vector check reports a cracked mesh as watertight and the defect goes
	 * looking for a renderer instead of a gate.
	 */
	private fanConvexInPlane(poly: number[], outIdx: number[], tol: number): void {
		const px = this.px
		const n0 = poly.length
		if (n0 < 3) return
		// Reference normal from the widest-apart corners, so a sliver does not decide it.
		let nx = 0, ny = 0, nz = 0
		for (let i = 1; i + 1 < n0; i++) {
			const a = poly[0] * 3, b = poly[i] * 3, c = poly[i + 1] * 3
			const e1x = px[b] - px[a], e1y = px[b + 1] - px[a + 1], e1z = px[b + 2] - px[a + 2]
			const e2x = px[c] - px[a], e2y = px[c + 1] - px[a + 1], e2z = px[c + 2] - px[a + 2]
			nx += e1y * e2z - e1z * e2y
			ny += e1z * e2x - e1x * e2z
			nz += e1x * e2y - e1y * e2x
		}
		// A ring with no area triangulates to nothing at all — there is no orientation to
		// clip against and every triangle it could yield is degenerate.
		if (nx * nx + ny * ny + nz * nz <= 0) return

		const ring = this.ring
		ring.length = 0
		for (let i = 0; i < n0; i++) ring.push(poly[i])
		let n = n0
		const tol2 = tol * tol
		// Each pass removes one corner, so n is the loop bound; a pass that finds no
		// admissible ear leaves the remainder to the fan below rather than spinning.
		while (n > 3) {
			let cut = -1
			for (let i = 0; i < n; i++) {
				const pv = ring[(i + n - 1) % n]
				const nv = ring[(i + 1) % n]
				const a = pv * 3
				const b = ring[i] * 3
				const c = nv * 3
				const e1x = px[b] - px[a], e1y = px[b + 1] - px[a + 1], e1z = px[b + 2] - px[a + 2]
				const e2x = px[c] - px[a], e2y = px[c + 1] - px[a + 1], e2z = px[c + 2] - px[a + 2]
				const gx = e1y * e2z - e1z * e2y
				const gy = e1z * e2x - e1x * e2z
				const gz = e1x * e2y - e1y * e2x
				// Collinear (every inserted point) or reflex: not an ear.
				if (gx * nx + gy * ny + gz * nz <= 0) continue
				// Convex, but does the diagonal it leaves behind swallow an inserted point?
				if (this.diagonalHitsRing(n, i, pv, nv, tol2)) continue
				cut = i
				break
			}
			if (cut < 0) break
			outIdx.push(ring[(cut + n - 1) % n], ring[cut], ring[(cut + 1) % n])
			// Manual shift rather than splice(): splice allocates an array for the element
			// it removes, once per clipped corner (rule 6).
			for (let i = cut; i + 1 < n; i++) ring[i] = ring[i + 1]
			n--
			ring.length = n
		}

		// The remainder is still convex, so a fan from ring[0] tiles it exactly. Normally
		// that is the single triangle the ear loop ran down to; when the loop stalled
		// because no admissible ear was left, the fan still covers the area rather than
		// dropping a hole into the surface. Spokes with no area are skipped either way,
		// which is what keeps the zero-area triangle out of the result.
		for (let i = 1; i + 1 < n; i++) {
			const a = ring[0] * 3, b = ring[i] * 3, c = ring[i + 1] * 3
			const e1x = px[b] - px[a], e1y = px[b + 1] - px[a + 1], e1z = px[b + 2] - px[a + 2]
			const e2x = px[c] - px[a], e2y = px[c + 1] - px[a + 1], e2z = px[c + 2] - px[a + 2]
			const gx = e1y * e2z - e1z * e2y
			const gy = e1z * e2x - e1x * e2z
			const gz = e1x * e2y - e1y * e2x
			if (gx * nx + gy * ny + gz * nz > 0) outIdx.push(ring[0], ring[i], ring[i + 1])
		}
	}

	/**
	 * True when the diagonal `a`->`b` that clipping ring[skip] would leave behind passes
	 * through some other vertex of the ring.
	 *
	 * Same perpendicular-distance-and-parameter test repairTJunctions uses to find an
	 * inserted point on an edge, so the two agree by construction: a point that was put
	 * into this ring because it sat on edge a-b is found again here, and the ear that
	 * would have spanned that edge is refused.
	 */
	private diagonalHitsRing(n: number, skip: number, a: number, b: number, tol2: number): boolean {
		const px = this.px
		const ring = this.ring
		const ax = px[a * 3], ay = px[a * 3 + 1], az = px[a * 3 + 2]
		const abx = px[b * 3] - ax, aby = px[b * 3 + 1] - ay, abz = px[b * 3 + 2] - az
		const l2 = abx * abx + aby * aby + abz * abz
		if (l2 < 1e-20) return false
		for (let j = 0; j < n; j++) {
			if (j === skip) continue
			const v = ring[j]
			if (v === a || v === b) continue
			const qx = px[v * 3] - ax, qy = px[v * 3 + 1] - ay, qz = px[v * 3 + 2] - az
			const s = (qx * abx + qy * aby + qz * abz) / l2
			// Strictly interior: sharing an endpoint is not the same as being swallowed.
			if (s <= 1e-6 || s >= 1 - 1e-6) continue
			const cx = qy * abz - qz * aby
			const cy = qz * abx - qx * abz
			const cz = qx * aby - qy * abx
			if ((cx * cx + cy * cy + cz * cz) / l2 <= tol2) return true
		}
		return false
	}

	/**
	 * Hands the staged data over as a real Mesh, reserved to the exact fill so the result
	 * carries no dead tail — a boolean is a generation-time step, and handing the caller a
	 * half-empty 2 MB buffer to upload is a real cost.
	 *
	 * Built through addVertex/addTriangle rather than by assembling the channels directly:
	 * those two are the only things that keep a Mesh's counts, capacity, bounds flag and
	 * tangent w in agreement, and a Mesh assembled behind its own back is a bug that
	 * surfaces one subsystem away from here.
	 *
	 * Copying rather than aliasing the staging buffers is also what makes the builder
	 * reusable: fracture() runs two clips through this same workspace and keeps both
	 * results, and a view into these buffers would have the second clip overwrite the
	 * first.
	 *
	 * Tangents are left at the identity, for the same reason normals are never invented
	 * here (see readMesh): the frame belongs to the mesh node's computeTangents(), and
	 * synthesising one would hide a caller that forgot to run it.
	 */
	finish(): Mesh {
		const n = this.vcount
		const mesh = new Mesh(n, (this.icount / 3) | 0)
		const px = this.px
		const nrm = this.nrm
		const uv = this.uv
		const zone = this.zone
		for (let i = 0; i < n; i++) {
			const o3 = i * 3
			const o2 = i * 2
			mesh.addVertex(
				px[o3], px[o3 + 1], px[o3 + 2],
				nrm[o3], nrm[o3 + 1], nrm[o3 + 2],
				uv[o2], uv[o2 + 1], zone[i],
			)
		}
		const idx = this.idx
		for (let t = 0; t + 2 < this.icount; t += 3) mesh.addTriangle(idx[t], idx[t + 1], idx[t + 2])
		return mesh
	}
}

// ---------------------------------------------------------------------------
// PointWeld — position-only merge, used to chain cut segments into loops.
//
// The same cut point reached from two triangles sharing an edge is computed from that
// edge in opposite directions, so the two doubles differ in the last bits. Chaining by
// exact identity would leave every loop open and every cap missing.
// ---------------------------------------------------------------------------

class PointWeld {
	pos: Float64Array<ArrayBufferLike> = new Float64Array(0)
	count = 0
	private head = new Int32Array(0)
	private next: Int32Array<ArrayBufferLike> = new Int32Array(0)
	private key: Float64Array<ArrayBufferLike> = new Float64Array(0)
	private mask = 0
	private q = DEFAULT_WELD_EPSILON

	begin(expected: number, quant: number): void {
		this.count = 0
		this.q = quant
		const cap = pow2AtLeast(expected * 2)
		this.mask = cap - 1
		if (this.head.length < cap) this.head = new Int32Array(cap)
		this.head.fill(-1, 0, cap)
	}

	add(x: number, y: number, z: number): number {
		const inv = 1 / this.q
		const qx = Math.round(x * inv)
		const qy = Math.round(y * inv)
		const qz = Math.round(z * inv)
		let h = 0x811c9dc5
		h = hashMix(h, qx)
		h = hashMix(h, qy)
		h = hashMix(h, qz)
		const bucket = (h ^ (h >>> 15)) & this.mask
		for (let c = this.head[bucket]; c >= 0; c = this.next[c]) {
			const k = c * 3
			if (this.key[k] === qx && this.key[k + 1] === qy && this.key[k + 2] === qz) return c
		}
		const id = this.count
		this.pos = growF64(this.pos, (id + 1) * 3)
		this.key = growF64(this.key, (id + 1) * 3)
		this.next = growI32(this.next, id + 1)
		this.pos[id * 3] = x
		this.pos[id * 3 + 1] = y
		this.pos[id * 3 + 2] = z
		this.key[id * 3] = qx
		this.key[id * 3 + 1] = qy
		this.key[id * 3 + 2] = qz
		this.next[id] = this.head[bucket]
		this.head[bucket] = id
		this.count++
		return id
	}
}

// ---------------------------------------------------------------------------
// Mesh read/write — the ONLY two functions that name a field of Mesh.
// ---------------------------------------------------------------------------

interface MeshView {
	positions: Float32Array
	normals: Float32Array
	uvs: Float32Array
	zones: Uint8Array
	indices: Uint32Array
	vertexCount: number
	indexCount: number
}

const EMPTY_F32 = new Float32Array(0)
const EMPTY_U8 = new Uint8Array(0)

/**
 * Reads a Mesh into the shape this file works with, substituting defaults for an
 * under-filled attribute channel. CSG preserves attributes; it deliberately does not
 * synthesise missing ones — normal generation belongs to the mesh node (rule 1), and
 * inventing normals here would hide a caller that forgot to run it.
 *
 * One of the four functions that touch a Mesh. See the contract in the header.
 */
function readMesh(mesh: Mesh): MeshView {
	const vertexCount = mesh.vertexCount
	const normals = mesh.normals
	const uvs = mesh.uv0
	const zones = mesh.materialZone
	return {
		positions: mesh.positions,
		normals: normals.length >= vertexCount * 3 ? normals : EMPTY_F32,
		uvs: uvs.length >= vertexCount * 2 ? uvs : EMPTY_F32,
		zones: zones.length >= vertexCount ? zones : EMPTY_U8,
		indices: mesh.indices,
		vertexCount,
		indexCount: mesh.indexCount,
	}
}

function viewNormalX(m: MeshView, i: number): number {
	return m.normals.length === 0 ? 0 : m.normals[i * 3]
}
function viewNormalY(m: MeshView, i: number): number {
	return m.normals.length === 0 ? 1 : m.normals[i * 3 + 1]
}
function viewNormalZ(m: MeshView, i: number): number {
	return m.normals.length === 0 ? 0 : m.normals[i * 3 + 2]
}
function viewU(m: MeshView, i: number): number {
	return m.uvs.length === 0 ? 0 : m.uvs[i * 2]
}
function viewV(m: MeshView, i: number): number {
	return m.uvs.length === 0 ? 0 : m.uvs[i * 2 + 1]
}
function viewZone(m: MeshView, i: number): number {
	return m.zones.length === 0 ? 0 : m.zones[i]
}

// ---------------------------------------------------------------------------
// Orthonormal basis — Duff et al., "Building an Orthonormal Basis, Revisited".
// Branchless, and made of nothing but arithmetic and a sign, so it is bit-reproducible
// where an atan2-based tangent frame is not. (t, b, n) is right handed: t x b = n.
// ---------------------------------------------------------------------------

const basisT = new Float64Array(3)
const basisB = new Float64Array(3)

function orthonormalBasis(nx: number, ny: number, nz: number): void {
	const sign = nz >= 0 ? 1 : -1
	const a = -1 / (sign + nz)
	const b = nx * ny * a
	basisT[0] = 1 + sign * nx * nx * a
	basisT[1] = sign * b
	basisT[2] = -sign * nx
	basisB[0] = b
	basisB[1] = sign + ny * ny * a
	basisB[2] = -ny
}

// ---------------------------------------------------------------------------
// CsgWorkspace
// ---------------------------------------------------------------------------

/**
 * Holds every arena the algorithms need. Constructing one per boolean is correct but
 * wasteful; a generator cutting forty hatches into a hull builds one workspace, runs
 * forty subtracts, and disposes once.
 */
export class CsgWorkspace {
	private verts = new VertexArena(1024)
	private polys = new PolyArena(1024)
	private treeA = new BspTree()
	private treeB = new BspTree()
	private out = new MeshBuilder()
	private cutPoints = new PointWeld()

	private epsilon = DEFAULT_EPSILON
	private weldEpsilon = DEFAULT_WELD_EPSILON
	private doWeld = true
	private doRepair = true

	// Split scratch, grown to the largest polygon degree seen. The runs are twice the
	// classification arrays because a split adds a vertex to both sides of the cut.
	private types = new Int8Array(64)
	private dists = new Float64Array(64)
	private runF = new Uint32Array(130)
	private runB = new Uint32Array(130)

	// convexClip scratch. A plane crosses at most two edges of a triangle, so a run
	// never exceeds five entries.
	private clipF = new Float64Array(6 * VSTRIDE)
	private clipB = new Float64Array(6 * VSTRIDE)
	private clipFOn = new Uint8Array(6)
	private clipBOn = new Uint8Array(6)
	private vertDist = new Float64Array(0)
	private zoneHist = new Float64Array(256)

	// Cap loop scratch.
	private nearScratch: number[] = []
	private segFrom: number[] = []
	private segTo: number[] = []
	private segHead = new Int32Array(0)
	private segNext = new Int32Array(0)
	private segUsed = new Uint8Array(0)
	private loop: number[] = []
	private loop2 = new Float64Array(0)
	private earPrev = new Int32Array(0)
	private earNext = new Int32Array(0)

	private disposed = false

	private applyOptions(opts: CsgOptions | undefined): void {
		this.epsilon = opts?.epsilon ?? DEFAULT_EPSILON
		this.weldEpsilon = opts?.weldEpsilon ?? DEFAULT_WELD_EPSILON
		this.doWeld = opts?.weld ?? true
		// Repair needs a shared vertex to find, so it is meaningless without the weld.
		this.doRepair = (opts?.repairTJunctions ?? true) && this.doWeld
	}

	private assertLive(): void {
		if (this.disposed) throw new Error('csg: workspace used after dispose()')
	}

	/** Rule 7. Drops the arenas so tens of megabytes are collectable now, not later. */
	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.verts = new VertexArena(0)
		this.polys = new PolyArena(0)
		this.treeA = new BspTree()
		this.treeB = new BspTree()
		this.out = new MeshBuilder()
		this.cutPoints = new PointWeld()
		this.vertDist = new Float64Array(0)
		this.segFrom = []
		this.segTo = []
		this.loop = []
	}

	// -----------------------------------------------------------------------
	// Booleans
	// -----------------------------------------------------------------------

	union(a: Mesh, b: Mesh, opts?: CsgOptions): Mesh {
		this.assertLive()
		this.applyOptions(opts)
		const { la, lb } = this.loadPair(a, b)
		const A = this.treeA
		const B = this.treeB
		this.build(A, 0, la)
		this.build(B, 0, lb)
		this.clipTo(A, B)
		this.clipTo(B, A)
		this.invert(B)
		this.clipTo(B, A)
		this.invert(B)
		const result: number[] = []
		this.allPolygons(A, result)
		this.allPolygons(B, result)
		return this.emit(result)
	}

	/**
	 * a minus b. The surviving faces of `b` are inverted into the cavity wall, and they
	 * keep b's uvs and materialZone — which is the lever a generator wants: give the
	 * cutter a "torn interior" zone and the inside of every hole is textured for free.
	 */
	subtract(a: Mesh, b: Mesh, opts?: CsgOptions): Mesh {
		this.assertLive()
		this.applyOptions(opts)
		const { la, lb } = this.loadPair(a, b)
		const A = this.treeA
		const B = this.treeB
		this.build(A, 0, la)
		this.build(B, 0, lb)
		this.invert(A)
		this.clipTo(A, B)
		this.clipTo(B, A)
		this.invert(B)
		this.clipTo(B, A)
		this.invert(B)
		const result: number[] = []
		this.allPolygons(A, result)
		this.allPolygons(B, result)
		this.flipAll(result)
		return this.emit(result)
	}

	intersect(a: Mesh, b: Mesh, opts?: CsgOptions): Mesh {
		this.assertLive()
		this.applyOptions(opts)
		const { la, lb } = this.loadPair(a, b)
		const A = this.treeA
		const B = this.treeB
		this.build(A, 0, la)
		this.build(B, 0, lb)
		this.invert(A)
		this.clipTo(B, A)
		this.invert(B)
		this.clipTo(A, B)
		this.clipTo(B, A)
		const result: number[] = []
		this.allPolygons(A, result)
		this.allPolygons(B, result)
		this.flipAll(result)
		return this.emit(result)
	}

	private loadPair(a: Mesh, b: Mesh): { la: number[]; lb: number[] } {
		this.verts.reset()
		this.polys.reset()
		this.treeA.reset()
		this.treeB.reset()
		const la: number[] = []
		const lb: number[] = []
		this.addMesh(a, la, this.treeA)
		this.addMesh(b, lb, this.treeB)
		return { la, lb }
	}

	private addMesh(mesh: Mesh, out: number[], tree: BspTree): void {
		const m = readMesh(mesh)
		const base = this.verts.count
		const pos = m.positions
		for (let i = 0; i < m.vertexCount; i++) {
			this.verts.push(
				pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2],
				viewNormalX(m, i), viewNormalY(m, i), viewNormalZ(m, i),
				viewU(m, i), viewV(m, i), viewZone(m, i),
			)
			tree.grow(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])
		}
		const idx = m.indices
		for (let t = 0; t + 2 < m.indexCount; t += 3) {
			const i0 = idx[t], i1 = idx[t + 1], i2 = idx[t + 2]
			const a = i0 * 3, b = i1 * 3, c = i2 * 3
			const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2]
			const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2]
			let nx = e1y * e2z - e1z * e2y
			let ny = e1z * e2x - e1x * e2z
			let nz = e1x * e2y - e1y * e2x
			const l2 = nx * nx + ny * ny + nz * nz
			// A zero-area triangle has no plane. Admitting one hands the tree a garbage
			// splitter and every polygon below it classifies at random.
			if (l2 < DEGENERATE_CROSS_SQ) continue
			const inv = 1 / Math.sqrt(l2)
			nx *= inv
			ny *= inv
			nz *= inv
			const d = nx * pos[a] + ny * pos[a + 1] + nz * pos[a + 2]
			this.polys.begin()
			this.polys.vertex(base + i0)
			this.polys.vertex(base + i1)
			this.polys.vertex(base + i2)
			const id = this.polys.end(nx, ny, nz, d, 0)
			if (id >= 0) out.push(id)
		}
	}

	// -----------------------------------------------------------------------
	// BSP core
	// -----------------------------------------------------------------------

	/**
	 * Splits polygon `pid` against a plane, appending polygon ids to the four buckets.
	 * Fragments inherit the parent's plane rather than recomputing one: a sliver's own
	 * Newell normal is numerically meaningless, and a fragment that drifts off its
	 * parent surface is exactly how a boolean grows a crack.
	 */
	private splitPolygon(
		pid: number,
		pnx: number, pny: number, pnz: number, pd: number,
		coplanarFront: number[], coplanarBack: number[],
		front: number[], back: number[],
	): void {
		const polys = this.polys
		const off = polys.off[pid]
		const len = polys.len[pid]
		if (this.types.length < len) {
			this.types = new Int8Array(len)
			this.dists = new Float64Array(len)
			this.runF = new Uint32Array(len * 2 + 2)
			this.runB = new Uint32Array(len * 2 + 2)
		}
		const types = this.types
		const dists = this.dists
		const idx = polys.idx
		const vd = this.verts.data
		const eps = this.epsilon

		let polyType = 0
		for (let i = 0; i < len; i++) {
			const v = idx[off + i] * VSTRIDE
			const t = pnx * vd[v] + pny * vd[v + 1] + pnz * vd[v + 2] - pd
			const ty = t < -eps ? BACK : t > eps ? FRONT : COPLANAR
			types[i] = ty
			dists[i] = t
			polyType |= ty
		}

		if (polyType === COPLANAR) {
			const p = pid * 4
			const facing = pnx * polys.plane[p] + pny * polys.plane[p + 1] + pnz * polys.plane[p + 2]
			if (facing > 0) coplanarFront.push(pid)
			else coplanarBack.push(pid)
			return
		}
		if (polyType === FRONT) {
			front.push(pid)
			return
		}
		if (polyType === BACK) {
			back.push(pid)
			return
		}

		// Spanning. Read the parent plane before touching the arenas — end() can grow
		// polys.plane out from under a stale local.
		const pp = pid * 4
		const p0 = polys.plane[pp]
		const p1 = polys.plane[pp + 1]
		const p2 = polys.plane[pp + 2]
		const p3 = polys.plane[pp + 3]
		const parentFlip = polys.flipped[pid]

		const runF = this.runF
		const runB = this.runB
		let fN = 0
		let bN = 0
		for (let i = 0; i < len; i++) {
			const j = i + 1 === len ? 0 : i + 1
			const ti = types[i]
			const tj = types[j]
			const vi = idx[off + i]
			if (ti !== BACK) runF[fN++] = vi
			if (ti !== FRONT) runB[bN++] = vi
			if ((ti | tj) === SPANNING) {
				const vj = idx[off + j]
				const t = dists[i] / (dists[i] - dists[j])
				// verts.lerp may reallocate verts.data; nothing below reads `vd`.
				const vm = this.verts.lerp(vi, vj, t)
				runF[fN++] = vm
				runB[bN++] = vm
			}
		}

		if (fN >= 3) {
			polys.begin()
			for (let i = 0; i < fN; i++) polys.vertex(runF[i])
			const id = polys.end(p0, p1, p2, p3, parentFlip)
			if (id >= 0) front.push(id)
		}
		if (bN >= 3) {
			polys.begin()
			for (let i = 0; i < bN; i++) polys.vertex(runB[i])
			const id = polys.end(p0, p1, p2, p3, parentFlip)
			if (id >= 0) back.push(id)
		}
	}

	/**
	 * Picks the splitting plane. Scores are integer counts and the comparison is strict,
	 * so the first candidate wins every tie and the choice depends on list order alone.
	 */
	private chooseSplitter(items: number[]): number {
		const polys = this.polys
		const vd = this.verts.data
		const eps = this.epsilon
		const n = items.length
		const k = n < SPLITTER_CANDIDATES ? n : SPLITTER_CANDIDATES
		const stride = n > SPLITTER_SCAN_LIMIT ? Math.ceil(n / SPLITTER_SCAN_LIMIT) : 1
		let best = items[0]
		let bestScore = Infinity
		for (let c = 0; c < k; c++) {
			const cand = items[c] * 4
			const cx = polys.plane[cand]
			const cy = polys.plane[cand + 1]
			const cz = polys.plane[cand + 2]
			const cd = polys.plane[cand + 3]
			let nf = 0
			let nb = 0
			let ns = 0
			for (let s = 0; s < n; s += stride) {
				const pid = items[s]
				const off = polys.off[pid]
				const len = polys.len[pid]
				let ty = 0
				for (let i = 0; i < len; i++) {
					const v = polys.idx[off + i] * VSTRIDE
					const t = cx * vd[v] + cy * vd[v + 1] + cz * vd[v + 2] - cd
					ty |= t < -eps ? BACK : t > eps ? FRONT : COPLANAR
					if (ty === SPANNING) break
				}
				if (ty === SPANNING) ns++
				else if (ty === FRONT) nf++
				else if (ty === BACK) nb++
			}
			const score = ns * SPLIT_COST + (nf > nb ? nf - nb : nb - nf)
			if (score < bestScore) {
				bestScore = score
				best = items[c]
			}
		}
		return best
	}

	/**
	 * Iterative build. Recursion depth on a BSP is data dependent and a lofted hull can
	 * produce a very deep one; an explicit stack removes the only way this file could
	 * blow the JS stack on a large mesh.
	 */
	private build(tree: BspTree, root: number, list: number[]): void {
		if (list.length === 0) return
		const nodeStack: number[] = [root]
		const listStack: number[][] = [list]
		while (nodeStack.length > 0) {
			const n = nodeStack.pop()!
			const items = listStack.pop()!
			if (items.length === 0) continue
			if (tree.hasPlane[n] === 0) {
				const sp = this.chooseSplitter(items) * 4
				tree.planes[n * 4] = this.polys.plane[sp]
				tree.planes[n * 4 + 1] = this.polys.plane[sp + 1]
				tree.planes[n * 4 + 2] = this.polys.plane[sp + 2]
				tree.planes[n * 4 + 3] = this.polys.plane[sp + 3]
				tree.hasPlane[n] = 1
			}
			const px = tree.planes[n * 4]
			const py = tree.planes[n * 4 + 1]
			const pz = tree.planes[n * 4 + 2]
			const pd = tree.planes[n * 4 + 3]
			const own = tree.lists[n]
			const front: number[] = []
			const back: number[] = []
			for (let i = 0; i < items.length; i++) {
				this.splitPolygon(items[i], px, py, pz, pd, own, own, front, back)
			}
			if (front.length > 0) {
				if (tree.front[n] < 0) {
					// newNode() grows tree.front, so the child id must be taken first.
					const child = tree.newNode()
					tree.front[n] = child
				}
				nodeStack.push(tree.front[n])
				listStack.push(front)
			}
			if (back.length > 0) {
				if (tree.back[n] < 0) {
					const child = tree.newNode()
					tree.back[n] = child
				}
				nodeStack.push(tree.back[n])
				listStack.push(back)
			}
		}
	}

	/** Removes the parts of `items` that fall inside the solid described by `tree`. */
	private clipList(tree: BspTree, items: number[], out: number[]): void {
		const nodeStack: number[] = [0]
		const listStack: number[][] = [items]
		while (nodeStack.length > 0) {
			const n = nodeStack.pop()!
			const list = listStack.pop()!
			if (list.length === 0) continue
			if (tree.hasPlane[n] === 0) {
				for (let i = 0; i < list.length; i++) out.push(list[i])
				continue
			}
			const px = tree.planes[n * 4]
			const py = tree.planes[n * 4 + 1]
			const pz = tree.planes[n * 4 + 2]
			const pd = tree.planes[n * 4 + 3]
			const front: number[] = []
			const back: number[] = []
			for (let i = 0; i < list.length; i++) {
				this.splitPolygon(list[i], px, py, pz, pd, front, back, front, back)
			}
			if (tree.front[n] >= 0) {
				nodeStack.push(tree.front[n])
				listStack.push(front)
			} else {
				for (let i = 0; i < front.length; i++) out.push(front[i])
			}
			if (tree.back[n] >= 0) {
				nodeStack.push(tree.back[n])
				listStack.push(back)
			}
			// No back child means everything behind this leaf plane is solid: discarded.
		}
	}

	private clipTo(target: BspTree, clipper: BspTree): void {
		const eps = this.epsilon
		const lox = clipper.minX - eps, loy = clipper.minY - eps, loz = clipper.minZ - eps
		const hix = clipper.maxX + eps, hiy = clipper.maxY + eps, hiz = clipper.maxZ + eps
		const near = this.nearScratch
		// clipList removes whatever is INSIDE the clipper's solid. A polygon that misses
		// the surface bounds is outside the surface, which for an ordinary clipper means
		// outside the solid — keep it — and for an inverted one means inside the
		// complement — drop it. Getting this backwards silently deletes the far half of
		// every subtract, so the flag is not optional bookkeeping.
		const keepFar = !clipper.inverted
		for (let n = 0; n < target.count; n++) {
			const list = target.lists[n]
			if (list.length === 0) continue
			const out: number[] = []
			near.length = 0
			for (let i = 0; i < list.length; i++) {
				// Beyond correctness this is what keeps the triangle count sane: it stops
				// the clipper's planes from slicing geometry they can never affect, which
				// is how a naive BSP boolean turns a 2 500-triangle hull into a 500 000-
				// triangle one after a dozen cuts.
				if (this.polyOutsideBox(list[i], lox, loy, loz, hix, hiy, hiz)) {
					if (keepFar) out.push(list[i])
				} else near.push(list[i])
			}
			if (near.length > 0) this.clipList(clipper, near, out)
			target.lists[n] = out
		}
	}

	private polyOutsideBox(
		pid: number,
		lox: number, loy: number, loz: number,
		hix: number, hiy: number, hiz: number,
	): boolean {
		const polys = this.polys
		const off = polys.off[pid]
		const len = polys.len[pid]
		const vd = this.verts.data
		let x0 = Infinity, y0 = Infinity, z0 = Infinity
		let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
		for (let i = 0; i < len; i++) {
			const v = polys.idx[off + i] * VSTRIDE
			const x = vd[v], y = vd[v + 1], z = vd[v + 2]
			if (x < x0) x0 = x
			if (x > x1) x1 = x
			if (y < y0) y0 = y
			if (y > y1) y1 = y
			if (z < z0) z0 = z
			if (z > z1) z1 = z
		}
		return x1 < lox || x0 > hix || y1 < loy || y0 > hiy || z1 < loz || z0 > hiz
	}

	private invert(tree: BspTree): void {
		tree.inverted = !tree.inverted
		for (let n = 0; n < tree.count; n++) {
			const p = n * 4
			tree.planes[p] = -tree.planes[p]
			tree.planes[p + 1] = -tree.planes[p + 1]
			tree.planes[p + 2] = -tree.planes[p + 2]
			tree.planes[p + 3] = -tree.planes[p + 3]
			const f = tree.front[n]
			tree.front[n] = tree.back[n]
			tree.back[n] = f
			const list = tree.lists[n]
			for (let i = 0; i < list.length; i++) this.polys.flip(list[i])
		}
	}

	/**
	 * Undoes the leading invert() of subtract and intersect, which both compute their
	 * result in a flipped space.
	 *
	 * Applied to the merged list rather than by re-inserting B's polygons into A's tree
	 * the way the textbook formulation does. That insertion splits every polygon of B
	 * against every plane of A it straddles, and none of those splits change the surface
	 * — they only exist to leave the node a valid BSP, which is worthless here because
	 * the tree is discarded on the next line. Skipping it is a straight cut in triangle
	 * count for identical geometry.
	 */
	private flipAll(ids: number[]): void {
		for (let i = 0; i < ids.length; i++) this.polys.flip(ids[i])
	}

	/** Node creation order, which is fixed by the build, so the output order is fixed. */
	private allPolygons(tree: BspTree, out: number[]): void {
		for (let n = 0; n < tree.count; n++) {
			const list = tree.lists[n]
			for (let i = 0; i < list.length; i++) out.push(list[i])
		}
	}

	private emit(ids: number[]): Mesh {
		const polys = this.polys
		let corners = 0
		for (let i = 0; i < ids.length; i++) corners += polys.len[ids[i]]
		const out = this.out
		out.begin(corners + 1, this.doWeld, this.weldEpsilon)
		const vd = this.verts.data
		for (let i = 0; i < ids.length; i++) {
			const id = ids[i]
			const off = polys.off[id]
			const len = polys.len[id]
			const sign = polys.flipped[id] === 1 ? -1 : 1
			// Convex by construction, so a fan from the first corner is always valid.
			let first = -1
			let prev = -1
			for (let c = 0; c < len; c++) {
				const v = polys.idx[off + c] * VSTRIDE
				const vi = out.vertex(
					vd[v], vd[v + 1], vd[v + 2],
					vd[v + 3] * sign, vd[v + 4] * sign, vd[v + 5] * sign,
					vd[v + 6], vd[v + 7], vd[v + 8],
				)
				if (c === 0) first = vi
				else if (c >= 2) out.triangle(first, prev, vi)
				prev = vi
			}
		}
		if (this.doRepair) out.repairTJunctions(this.weldEpsilon)
		return out.finish()
	}

	// -----------------------------------------------------------------------
	// convexClip — the single-plane fast path
	// -----------------------------------------------------------------------

	/**
	 * Keeps the half-space behind `plane` (dot(n, p) <= d) and caps the cross-section.
	 * Flip the plane to keep the other half. Returns null when nothing survives.
	 *
	 * No tree is built: every triangle is classified once against one plane, which is
	 * the whole point — a BSP for a single cut costs an order of magnitude more and
	 * buys nothing. The cap is reconstructed by chaining the cut edges into loops, not
	 * by sorting points around a centroid, because an angular sort needs atan2 and
	 * cannot handle a cross-section made of more than one loop.
	 */
	clip(mesh: Mesh, plane: Plane, opts?: ClipOptions): Mesh | null {
		this.assertLive()
		this.applyOptions(opts)
		const doCap = opts?.cap ?? true
		const capScale = opts?.capUvScale ?? 1
		const capZoneOverride = opts?.capMaterialZone

		const m = readMesh(mesh)
		if (m.vertexCount === 0 || m.indexCount < 3) return null

		const eps = this.epsilon
		const pnx = plane.nx, pny = plane.ny, pnz = plane.nz, pd = plane.d
		const pos = m.positions

		if (this.vertDist.length < m.vertexCount) this.vertDist = new Float64Array(m.vertexCount)
		const dist = this.vertDist
		let anyFront = false
		let anyBack = false
		for (let i = 0; i < m.vertexCount; i++) {
			const t = pnx * pos[i * 3] + pny * pos[i * 3 + 1] + pnz * pos[i * 3 + 2] - pd
			dist[i] = t
			if (t > eps) anyFront = true
			else if (t < -eps) anyBack = true
		}
		if (!anyFront) {
			// The plane misses the mesh, or the mesh lies in it. Still rebuilt, so the
			// caller always receives a mesh it owns and may mutate.
			return this.rebuild(m)
		}
		if (!anyBack) return null

		const idx = m.indices
		const triCount = (m.indexCount / 3) | 0
		const out = this.out
		out.begin(triCount * 4 + 8, this.doWeld, this.weldEpsilon)
		if (doCap) this.cutPoints.begin(triCount * 2 + 8, this.weldEpsilon)
		this.segFrom.length = 0
		this.segTo.length = 0
		this.zoneHist.fill(0)

		const rf = this.clipF
		const rb = this.clipB
		const rfOn = this.clipFOn
		const rbOn = this.clipBOn

		for (let t = 0; t + 2 < m.indexCount; t += 3) {
			const c0 = idx[t], c1 = idx[t + 1], c2 = idx[t + 2]
			const d0 = dist[c0], d1 = dist[c1], d2 = dist[c2]
			const t0 = d0 < -eps ? BACK : d0 > eps ? FRONT : COPLANAR
			const t1 = d1 < -eps ? BACK : d1 > eps ? FRONT : COPLANAR
			const t2 = d2 < -eps ? BACK : d2 > eps ? FRONT : COPLANAR
			const polyType = t0 | t1 | t2

			let fN = 0
			let bN = 0
			for (let e = 0; e < 3; e++) {
				const ci = e === 0 ? c0 : e === 1 ? c1 : c2
				const cj = e === 0 ? c1 : e === 1 ? c2 : c0
				const ti = e === 0 ? t0 : e === 1 ? t1 : t2
				const tj = e === 0 ? t1 : e === 1 ? t2 : t0
				const di = e === 0 ? d0 : e === 1 ? d1 : d2
				const dj = e === 0 ? d1 : e === 1 ? d2 : d0
				if (ti !== BACK) {
					copyVertex(rf, fN, m, ci)
					rfOn[fN] = ti === COPLANAR ? 1 : 0
					fN++
				}
				if (ti !== FRONT) {
					copyVertex(rb, bN, m, ci)
					rbOn[bN] = ti === COPLANAR ? 1 : 0
					bN++
				}
				if ((ti | tj) === SPANNING) {
					const s = di / (di - dj)
					lerpVertex(rf, fN, m, ci, cj, s)
					// Copied from the front run rather than recomputed, so the cap point
					// and the wall point are bit-identical and weld without a seam.
					const src = fN * VSTRIDE
					const dst = bN * VSTRIDE
					for (let k = 0; k < VSTRIDE; k++) rb[dst + k] = rf[src + k]
					rfOn[fN] = 1
					rbOn[bN] = 1
					fN++
					bN++
				}
			}

			if (bN >= 3) {
				let first = -1
				let prev = -1
				for (let c = 0; c < bN; c++) {
					const o = c * VSTRIDE
					const vi = out.vertex(rb[o], rb[o + 1], rb[o + 2], rb[o + 3], rb[o + 4], rb[o + 5], rb[o + 6], rb[o + 7], rb[o + 8])
					if (c === 0) first = vi
					else if (c >= 2) out.triangle(first, prev, vi)
					prev = vi
				}
			}

			// The cap boundary is the coplanar edge of the DISCARDED polygon, in that
			// polygon's winding order. Derived once and it covers both the spanning case
			// and the case of a triangle sitting on the plane with its apex in front.
			if (doCap && polyType !== COPLANAR && fN >= 3) {
				for (let i = 0; i < fN; i++) {
					const j = i + 1 === fN ? 0 : i + 1
					if (rfOn[i] === 0 || rfOn[j] === 0) continue
					const oi = i * VSTRIDE
					const oj = j * VSTRIDE
					const a = this.cutPoints.add(rf[oi], rf[oi + 1], rf[oi + 2])
					const b = this.cutPoints.add(rf[oj], rf[oj + 1], rf[oj + 2])
					if (a === b) continue
					this.segFrom.push(a)
					this.segTo.push(b)
					this.zoneHist[clampZone(rf[oi + 8])]++
					this.zoneHist[clampZone(rf[oj + 8])]++
					break
				}
			}
		}

		if (doCap && this.segFrom.length > 0) {
			let capZone = capZoneOverride
			if (capZone === undefined) {
				// Majority zone of the removed material, lowest id on a tie. Cutting a
				// hatch into a plate should leave plate on the reveal, not zone 0.
				let best = 0
				let bestN = -1
				for (let z = 0; z < 256; z++) {
					if (this.zoneHist[z] > bestN) {
						bestN = this.zoneHist[z]
						best = z
					}
				}
				capZone = best
			}
			this.buildCaps(pnx, pny, pnz, capScale, capZone)
		}

		if (out.triangleCount === 0) return null
		// A single-plane cut splits both sides of every shared edge at the same welded
		// point, so this normally finds nothing. It matters when the input already had
		// T-junctions — a shard being re-cut during fracture, for instance.
		if (this.doRepair) out.repairTJunctions(this.weldEpsilon)
		return out.finish()
	}

	/** Re-emits a mesh through the builder so callers always own their result. */
	private rebuild(m: MeshView): Mesh {
		const out = this.out
		out.begin(m.vertexCount + 1, this.doWeld, this.weldEpsilon)
		const idx = m.indices
		const pos = m.positions
		for (let t = 0; t + 2 < m.indexCount; t += 3) {
			const a = out.vertex(
				pos[idx[t] * 3], pos[idx[t] * 3 + 1], pos[idx[t] * 3 + 2],
				viewNormalX(m, idx[t]), viewNormalY(m, idx[t]), viewNormalZ(m, idx[t]),
				viewU(m, idx[t]), viewV(m, idx[t]), viewZone(m, idx[t]),
			)
			const b = out.vertex(
				pos[idx[t + 1] * 3], pos[idx[t + 1] * 3 + 1], pos[idx[t + 1] * 3 + 2],
				viewNormalX(m, idx[t + 1]), viewNormalY(m, idx[t + 1]), viewNormalZ(m, idx[t + 1]),
				viewU(m, idx[t + 1]), viewV(m, idx[t + 1]), viewZone(m, idx[t + 1]),
			)
			const c = out.vertex(
				pos[idx[t + 2] * 3], pos[idx[t + 2] * 3 + 1], pos[idx[t + 2] * 3 + 2],
				viewNormalX(m, idx[t + 2]), viewNormalY(m, idx[t + 2]), viewNormalZ(m, idx[t + 2]),
				viewU(m, idx[t + 2]), viewV(m, idx[t + 2]), viewZone(m, idx[t + 2]),
			)
			out.triangle(a, b, c)
		}
		return out.finish()
	}

	/** Chains the recorded cut segments into closed loops and triangulates each one. */
	private buildCaps(nx: number, ny: number, nz: number, uvScale: number, zone: number): void {
		const segCount = this.segFrom.length
		const ptCount = this.cutPoints.count
		if (this.segHead.length < ptCount) this.segHead = new Int32Array(ptCount)
		if (this.segNext.length < segCount) this.segNext = new Int32Array(segCount)
		if (this.segUsed.length < segCount) this.segUsed = new Uint8Array(segCount)
		this.segHead.fill(-1, 0, ptCount)
		this.segUsed.fill(0, 0, segCount)
		// Built in reverse so each bucket chain reads in ascending segment order, which
		// makes loop assembly a function of triangle order and nothing else.
		for (let s = segCount - 1; s >= 0; s--) {
			this.segNext[s] = this.segHead[this.segFrom[s]]
			this.segHead[this.segFrom[s]] = s
		}

		orthonormalBasis(nx, ny, nz)
		const tx = basisT[0], ty = basisT[1], tz = basisT[2]
		const bx = basisB[0], by = basisB[1], bz = basisB[2]
		const pts = this.cutPoints.pos

		for (let s = 0; s < segCount; s++) {
			if (this.segUsed[s] === 1) continue
			const start = this.segFrom[s]
			this.segUsed[s] = 1
			this.loop.length = 0
			this.loop.push(start)
			let cur = s
			let closed = false
			for (let guard = 0; guard <= segCount; guard++) {
				const to = this.segTo[cur]
				if (to === start) {
					closed = true
					break
				}
				this.loop.push(to)
				let nxt = this.segHead[to]
				while (nxt >= 0 && this.segUsed[nxt] === 1) nxt = this.segNext[nxt]
				if (nxt < 0) break
				this.segUsed[nxt] = 1
				cur = nxt
			}
			// An open chain means the input was not closed along this cut. Capping it
			// would invent a face across a hole that was already there.
			if (!closed || this.loop.length < 3) continue
			this.triangulateLoop(pts, tx, ty, tz, bx, by, bz, nx, ny, nz, uvScale, zone)
		}
	}

	private triangulateLoop(
		pts: Float64Array,
		tx: number, ty: number, tz: number,
		bx: number, by: number, bz: number,
		nx: number, ny: number, nz: number,
		uvScale: number, zone: number,
	): void {
		const loop = this.loop
		const m = loop.length
		if (this.loop2.length < m * 2) this.loop2 = new Float64Array(m * 2)
		const p2 = this.loop2
		for (let i = 0; i < m; i++) {
			const o = loop[i] * 3
			const x = pts[o], y = pts[o + 1], z = pts[o + 2]
			p2[i * 2] = x * tx + y * ty + z * tz
			p2[i * 2 + 1] = x * bx + y * by + z * bz
		}
		const out = this.out

		// (t, b, n) is right handed, so a loop that is counter-clockwise in (t, b) has
		// its Newell normal along +n — which is the outward direction for the half-space
		// clip() keeps. Reverse anything wound the other way rather than trusting the
		// segment convention to have got it right on every degenerate triangle.
		let area2 = 0
		for (let i = 0; i < m; i++) {
			const j = i + 1 === m ? 0 : i + 1
			area2 += p2[i * 2] * p2[j * 2 + 1] - p2[j * 2] * p2[i * 2 + 1]
		}
		if (area2 === 0) return
		if (area2 < 0) {
			for (let i = 0, j = m - 1; i < j; i++, j--) {
				const t0 = loop[i]
				loop[i] = loop[j]
				loop[j] = t0
				const ax = p2[i * 2], ay = p2[i * 2 + 1]
				p2[i * 2] = p2[j * 2]
				p2[i * 2 + 1] = p2[j * 2 + 1]
				p2[j * 2] = ax
				p2[j * 2 + 1] = ay
			}
		}

		if (this.earPrev.length < m) {
			this.earPrev = new Int32Array(m)
			this.earNext = new Int32Array(m)
		}
		const prev = this.earPrev
		const next = this.earNext
		for (let i = 0; i < m; i++) {
			prev[i] = i === 0 ? m - 1 : i - 1
			next[i] = i + 1 === m ? 0 : i + 1
		}

		// Emit the loop's vertices once; ears then reference them by output index.
		const vids: number[] = []
		for (let i = 0; i < m; i++) {
			const o = loop[i] * 3
			vids.push(out.vertex(
				pts[o], pts[o + 1], pts[o + 2],
				nx, ny, nz,
				p2[i * 2] * uvScale, p2[i * 2 + 1] * uvScale,
				zone,
			))
		}

		// Ear clipping in the cut plane. One loop, no nested holes: a cross-section with
		// an island inside it needs bridge edges, and none of the callers — a convex
		// shard, a hatch, a window — produce one. A loop that will not reduce falls back
		// to a fan, which looks wrong where a dropped cap looks like a rendering bug.
		let remaining = m
		let cur = 0
		let fails = 0
		while (remaining > 3) {
			const p = prev[cur]
			const n2 = next[cur]
			if (this.isEar(p2, next, p, cur, n2, remaining)) {
				out.triangle(vids[p], vids[cur], vids[n2])
				next[p] = n2
				prev[n2] = p
				remaining--
				cur = n2
				fails = 0
			} else {
				cur = n2
				fails++
				if (fails > remaining) break
			}
		}
		// Neither of the two remaining paths area-tests what it pushes, and neither needs
		// to: MeshBuilder.triangle drops an exactly-degenerate triangle centrally, which
		// is the only place that can see the welded positions these indices resolve to.
		// isEar cannot do it from here — it judges the corner in the projected (t, b)
		// plane, and three points that are exactly collinear in 3D project to a cross
		// product of ±1e-17 rather than 0. See the note on triangle().
		if (remaining === 3) {
			out.triangle(vids[prev[cur]], vids[cur], vids[next[cur]])
			return
		}
		// No ear found in a full pass — self-intersecting or duplicated loop. Fan it.
		// A fan over a concave loop looks wrong; a missing cap looks like a hole in the
		// hull, which reads as a renderer bug and costs far more to diagnose.
		const first = cur
		let b = next[first]
		let c = next[b]
		while (c !== first) {
			out.triangle(vids[first], vids[b], vids[c])
			b = c
			c = next[c]
		}
	}

	private isEar(
		p2: Float64Array, next: Int32Array,
		a: number, b: number, c: number, remaining: number,
	): boolean {
		const ax = p2[a * 2], ay = p2[a * 2 + 1]
		const bx = p2[b * 2], by = p2[b * 2 + 1]
		const cx = p2[c * 2], cy = p2[c * 2 + 1]
		const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
		// Reflex or collinear corners are not ears. Rejecting collinear ones keeps
		// zero-area triangles out of the cap.
		if (cross <= 0) return false
		let k = next[c]
		for (let i = 0; i < remaining && k !== a; i++) {
			const kx = p2[k * 2], ky = p2[k * 2 + 1]
			const c0 = (bx - ax) * (ky - ay) - (by - ay) * (kx - ax)
			const c1 = (cx - bx) * (ky - by) - (cy - by) * (kx - bx)
			const c2 = (ax - cx) * (ky - cy) - (ay - cy) * (kx - cx)
			if (c0 >= 0 && c1 >= 0 && c2 >= 0) return false
			k = next[k]
		}
		return true
	}

	// -----------------------------------------------------------------------
	// Fracture
	// -----------------------------------------------------------------------

	/**
	 * Shatters a mesh with a fixed plane set into closed convex pieces.
	 *
	 * One plane cuts one piece, chosen with `rng`. Applying every plane to every piece
	 * would be a full BSP arrangement and would produce 2^n cells for n planes; cutting
	 * one piece per plane yields exactly n+1 shards, which is a number a destruction
	 * budget can be written against (ARCHITECTURE.md §7).
	 *
	 * The pieces are convex if the input is. Feed a wreck's hull, not its greebled
	 * outer shell — the name is the contract.
	 */
	fracture(mesh: Mesh, planes: readonly Plane[], rng: Rng, opts?: FractureOptions): Mesh[] {
		this.assertLive()
		const maxPieces = opts?.maxPieces ?? 32
		const minFrac = opts?.minVolumeFraction ?? 1e-3
		const bias = opts?.biasToLargest ?? 0.7
		const jitter = opts?.jitter ?? 0

		const total = meshVolume(mesh)
		const minVol = total * minFrac
		const pieces: Mesh[] = [mesh]
		const volumes: number[] = [total]
		if (planes.length === 0 || maxPieces < 2) return pieces

		meshBounds(mesh, sMin, sMax)
		let extent = sMax[0] - sMin[0]
		if (sMax[1] - sMin[1] > extent) extent = sMax[1] - sMin[1]
		if (sMax[2] - sMin[2] > extent) extent = sMax[2] - sMin[2]

		for (let i = 0; i < planes.length && pieces.length < maxPieces; i++) {
			let plane = planes[i]
			if (jitter > 0) {
				// Only draws when jitter is on, so switching it off does not shift the
				// stream every later call reads from.
				const j = jitter * extent
				plane = makePlane(
					plane.nx + rng.signed(jitter),
					plane.ny + rng.signed(jitter),
					plane.nz + rng.signed(jitter),
					plane.d + rng.signed(j),
				)
			}

			let target = 0
			if (rng.next() < bias) {
				let bestVol = -1
				for (let k = 0; k < volumes.length; k++) {
					// Strict >, so the lowest index wins a tie.
					if (volumes[k] > bestVol) {
						bestVol = volumes[k]
						target = k
					}
				}
			} else {
				target = rng.int(0, pieces.length)
			}

			const piece = pieces[target]
			const back = this.clip(piece, plane, opts)
			if (back === null) continue
			const front = this.clip(piece, flipPlane(plane), opts)
			if (front === null) continue
			const vb = meshVolume(back)
			const vf = meshVolume(front)
			// A cut that only shaves a sliver costs a draw call and shows nothing.
			if (vb < minVol || vf < minVol) continue
			pieces[target] = back
			volumes[target] = vb
			pieces.push(front)
			volumes.push(vf)
		}
		return pieces
	}
}

function clampZone(z: number): number {
	const r = Math.round(z)
	return r < 0 ? 0 : r > 255 ? 255 : r
}

function copyVertex(run: Float64Array, slot: number, m: MeshView, vi: number): void {
	const o = slot * VSTRIDE
	run[o] = m.positions[vi * 3]
	run[o + 1] = m.positions[vi * 3 + 1]
	run[o + 2] = m.positions[vi * 3 + 2]
	run[o + 3] = viewNormalX(m, vi)
	run[o + 4] = viewNormalY(m, vi)
	run[o + 5] = viewNormalZ(m, vi)
	run[o + 6] = viewU(m, vi)
	run[o + 7] = viewV(m, vi)
	run[o + 8] = viewZone(m, vi)
}

/** Same interpolation rule as VertexArena.lerp — see the comment there for the why. */
function lerpVertex(run: Float64Array, slot: number, m: MeshView, ia: number, ib: number, t: number): void {
	const o = slot * VSTRIDE
	const pa = ia * 3
	const pb = ib * 3
	run[o] = m.positions[pa] + (m.positions[pb] - m.positions[pa]) * t
	run[o + 1] = m.positions[pa + 1] + (m.positions[pb + 1] - m.positions[pa + 1]) * t
	run[o + 2] = m.positions[pa + 2] + (m.positions[pb + 2] - m.positions[pa + 2]) * t
	let nx = viewNormalX(m, ia) + (viewNormalX(m, ib) - viewNormalX(m, ia)) * t
	let ny = viewNormalY(m, ia) + (viewNormalY(m, ib) - viewNormalY(m, ia)) * t
	let nz = viewNormalZ(m, ia) + (viewNormalZ(m, ib) - viewNormalZ(m, ia)) * t
	const l2 = nx * nx + ny * ny + nz * nz
	if (l2 > 1e-20) {
		const inv = 1 / Math.sqrt(l2)
		nx *= inv
		ny *= inv
		nz *= inv
	} else {
		nx = viewNormalX(m, ia)
		ny = viewNormalY(m, ia)
		nz = viewNormalZ(m, ia)
	}
	run[o + 3] = nx
	run[o + 4] = ny
	run[o + 5] = nz
	run[o + 6] = viewU(m, ia) + (viewU(m, ib) - viewU(m, ia)) * t
	run[o + 7] = viewV(m, ia) + (viewV(m, ib) - viewV(m, ia)) * t
	run[o + 8] = t < 0.5 ? viewZone(m, ia) : viewZone(m, ib)
}

// ---------------------------------------------------------------------------
// Free functions. Each builds a workspace, runs, and disposes it — correct for a
// one-off. Batch work should construct a CsgWorkspace and keep it.
// ---------------------------------------------------------------------------

export function union(a: Mesh, b: Mesh, opts?: CsgOptions): Mesh {
	const w = new CsgWorkspace()
	try {
		return w.union(a, b, opts)
	} finally {
		w.dispose()
	}
}

export function subtract(a: Mesh, b: Mesh, opts?: CsgOptions): Mesh {
	const w = new CsgWorkspace()
	try {
		return w.subtract(a, b, opts)
	} finally {
		w.dispose()
	}
}

export function intersect(a: Mesh, b: Mesh, opts?: CsgOptions): Mesh {
	const w = new CsgWorkspace()
	try {
		return w.intersect(a, b, opts)
	} finally {
		w.dispose()
	}
}

/** Keeps dot(n, p) <= d and caps the cut. Null when the whole mesh is on the far side. */
export function convexClip(mesh: Mesh, plane: Plane, opts?: ClipOptions): Mesh | null {
	const w = new CsgWorkspace()
	try {
		return w.clip(mesh, plane, opts)
	} finally {
		w.dispose()
	}
}

export function fractureIntoConvexPieces(
	mesh: Mesh,
	planes: readonly Plane[],
	rng: Rng,
	opts?: FractureOptions,
): Mesh[] {
	const w = new CsgWorkspace()
	try {
		const set = planes.length > 0
			? planes
			: fracturePlanes(mesh, (opts?.maxPieces ?? 32) - 1, rng)
		return w.fracture(mesh, set, rng, opts)
	} finally {
		w.dispose()
	}
}

/**
 * A deterministic plane set through a mesh, for callers with no authored cut pattern.
 *
 * Directions come from rejection sampling in the unit ball rather than from spherical
 * angles: sin/cos are only implementation-approximated, and a shard whose plane differs
 * in the last bit between two runs fails the reproducibility gate. Rejection uses
 * nothing but multiply, compare and one sqrt.
 *
 * Cut points are pulled toward the centre of the bounds, because a plane sampled
 * uniformly in the box frequently misses the body altogether and wastes a cut.
 */
export function fracturePlanes(mesh: Mesh, count: number, rng: Rng): Plane[] {
	const out: Plane[] = []
	if (count <= 0) return out
	meshBounds(mesh, sMin, sMax)
	const cx = (sMin[0] + sMax[0]) * 0.5
	const cy = (sMin[1] + sMax[1]) * 0.5
	const cz = (sMin[2] + sMax[2]) * 0.5
	const ex = sMax[0] - sMin[0]
	const ey = sMax[1] - sMin[1]
	const ez = sMax[2] - sMin[2]
	for (let i = 0; i < count; i++) {
		let nx = 0
		let ny = 1
		let nz = 0
		for (let tries = 0; tries < 16; tries++) {
			const x = rng.signed(1)
			const y = rng.signed(1)
			const z = rng.signed(1)
			const r2 = x * x + y * y + z * z
			if (r2 > 1e-4 && r2 <= 1) {
				const inv = 1 / Math.sqrt(r2)
				nx = x * inv
				ny = y * inv
				nz = z * inv
				break
			}
		}
		const px = cx + rng.signed(0.35) * ex
		const py = cy + rng.signed(0.35) * ey
		const pz = cz + rng.signed(0.35) * ez
		out.push(makePlane(nx, ny, nz, nx * px + ny * py + nz * pz))
	}
	return out
}
