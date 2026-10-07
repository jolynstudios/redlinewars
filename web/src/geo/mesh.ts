// STEELSEED — geo/mesh
// The mesh representation every other geo module produces and every render node consumes,
// plus the LOD chain.
//
// Hard rule 4: no npm — only core/math is imported. Hard rule 5: nothing here reads a
// clock or an RNG, so a Mesh built from a seeded generator is byte-identical every run;
// every tie-break in the simplifier is broken on an index, never on iteration order.
// Hard rule 6: every buffer is preallocated and grown by doubling; nothing allocates per
// triangle. Hard rule 7: dispose() drops the buffers.
//
// Storage is flat structure-of-arrays rather than an array of vertex objects because a
// mesh is generated in a worker and handed to the GPU as transferable ArrayBuffers (§6).
// An object graph would have to be serialised on the way out, and 200k vertex objects
// would be a GC event on the worker's first collection.

import { type Mat4, type Vec3, clamp, lerp, v3, vec3, vec4 } from '../core/math'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Weld distance, world units (metres). 0.1 mm — tight enough never to fuse a rivet. */
export const DEFAULT_WELD_EPS = 1e-4
/** cos(0.81°). compact() is a dedupe, not a smoother: creases must survive it. */
export const DEFAULT_NORMAL_COS = 0.9999
export const DEFAULT_UV_EPS = 1e-4
/**
 * repairShadingNormals: a corner whose vertex normal is more than ~72.5° off its own face
 * (cos below this) shades as if lit edge-on or from behind. Coarse but legitimate smooth
 * shading stays inside it: a round section cut down to three facets still has its radial
 * normals within 60° (cos 0.5) of every face.
 */
export const SHADING_REPAIR_COS = 0.3
/** A repaired corner takes the area-weighted normal of the faces within 45° of its own. */
export const SHADING_SMOOTH_COS = Math.SQRT1_2

/**
 * Interleaved vertex stride, bytes, every channel quantized: positions as float16x4
 * (local-space metres; f16's 11-bit significand steps by ~0.5 mm at tank scale —
 * pixel-parity gates pin the visual result), normals and tangents as octahedral
 * snorm8 pairs (meshopt-standard), tangent handedness riding in the tangent word,
 * UVs as unorm16 (atlas-space [0,1]). Strides stay 4-aligned so every attribute
 * offset is a legal WebGPU `offset` without padding maths at the call site.
 *
 * The CPU-side channels stay float32: ground contact, QEM and the rig read exact
 * values; only the GPU upload stream quantizes.
 */
export const VERTEX_STRIDE = 28
export const VERTEX_STRIDE_SKINNED = 36
/** Byte offsets inside one vertex, 4-aligned per WebGPU format rules (8x4 and 16x2
 * formats land on their required multiples; the f16 pad half at byte 6-7 is dead).
 * The zone word also carries track/window/foam metadata. */
export const NORMAL_OFFSET = 8
export const TANGENT_OFFSET = 12
export const UV0_OFFSET = 16
export const UV1_OFFSET = 20
export const ZONE_BYTE_OFFSET = 24
export const SKIN_INDEX_OFFSET = 28
export const SKIN_WEIGHT_OFFSET = 32

/**
 * Shader locations, fixed for the life of the project. A location may never be reused for
 * a different meaning: every pipeline in `render` is compiled once before frame 1 (§7), so
 * a renumbering here is a silent mismatch in already-compiled shader modules.
 *
 * Keyed by the Mesh channel that feeds it, so there is one vocabulary end to end. The
 * `name` strings below are the singular per-vertex form a WGSL declaration would use.
 */
export const VertexLocation = {
	positions: 0,
	normals: 1,
	tangents: 2,
	uv0: 3,
	uv1: 4,
	materialZone: 5,
	skinIndices: 6,
	skinWeights: 7,
} as const

export type VertexFormat = 'float32x2' | 'float32x3' | 'float32x4' | 'uint8x4' | 'unorm8x4' | 'snorm8x2' | 'snorm8x4' | 'unorm16x2' | 'float16x4'

export interface VertexAttribute {
	readonly name: string
	readonly format: VertexFormat
	readonly offset: number
	readonly shaderLocation: number
}

const ATTRIBUTES_STATIC: readonly VertexAttribute[] = [
	{ name: 'position', format: 'float16x4', offset: 0, shaderLocation: VertexLocation.positions },
	// Normals and tangents are octahedral snorm8 pairs; the tangent word carries handedness
	// in byte 2. UVs are unorm16 in [0,1] atlas space.
	{ name: 'normal', format: 'snorm8x2', offset: NORMAL_OFFSET, shaderLocation: VertexLocation.normals },
	{ name: 'tangent', format: 'snorm8x4', offset: TANGENT_OFFSET, shaderLocation: VertexLocation.tangents },
	{ name: 'uv0', format: 'unorm16x2', offset: UV0_OFFSET, shaderLocation: VertexLocation.uv0 },
	{ name: 'uv1', format: 'unorm16x2', offset: UV1_OFFSET, shaderLocation: VertexLocation.uv1 },
	// .x is the material zone; .yzw are reserved so a wear/damage mask can be added
	// without moving any existing offset and invalidating every compiled pipeline.
	{ name: 'materialZone', format: 'uint8x4', offset: ZONE_BYTE_OFFSET, shaderLocation: VertexLocation.materialZone },
]

const ATTRIBUTES_SKINNED: readonly VertexAttribute[] = [
	...ATTRIBUTES_STATIC,
	{ name: 'skinIndex', format: 'uint8x4', offset: SKIN_INDEX_OFFSET, shaderLocation: VertexLocation.skinIndices },
	{ name: 'skinWeight', format: 'unorm8x4', offset: SKIN_WEIGHT_OFFSET, shaderLocation: VertexLocation.skinWeights },
]

export interface GpuMeshBuffers {
	readonly vertexData: ArrayBuffer
	readonly indexData: ArrayBuffer
	readonly indexFormat: 'uint16' | 'uint32'
	readonly stride: number
	readonly vertexCount: number
	readonly indexCount: number
	readonly attributes: readonly VertexAttribute[]
	readonly skinned: boolean
	readonly aabbMin: Float32Array
	readonly aabbMax: Float32Array
	/** xyz centre, w radius. */
	readonly boundingSphere: Float32Array
	/** Pass as postMessage's transfer list so the worker hands ownership over, not a copy. */
	readonly transfer: ArrayBuffer[]
}

const EMPTY_F32 = new Float32Array(0)
const EMPTY_U32 = new Uint32Array(0)
const EMPTY_U8 = new Uint8Array(0)

// ---------------------------------------------------------------------------
// Mesh
// ---------------------------------------------------------------------------

export class Mesh {
	positions: Float32Array
	normals: Float32Array
	/** xyz tangent, w handedness (+1/-1). */
	tangents: Float32Array
	uv0: Float32Array
	uv1: Float32Array
	/** Packed per-vertex material layer and source flags; geo/zone owns the byte layout. */
	materialZone: Uint8Array
	/** 4 bone indices per vertex, or null on a static mesh. */
	skinIndices: Uint8Array | null = null
	/** 4 weights per vertex, normalised to sum 1, or null on a static mesh. */
	skinWeights: Float32Array | null = null
	indices: Uint32Array

	vertexCount = 0
	triangleCount = 0

	readonly aabbMin = vec3()
	readonly aabbMax = vec3()
	/** xyz centre, w radius. */
	readonly boundingSphere = vec4()

	private vertexCapacity = 0
	private triangleCapacity = 0
	private boundsDirty = true

	constructor(vertexCapacity = 0, triangleCapacity = 0) {
		this.positions = EMPTY_F32
		this.normals = EMPTY_F32
		this.tangents = EMPTY_F32
		this.uv0 = EMPTY_F32
		this.uv1 = EMPTY_F32
		this.materialZone = EMPTY_U8
		this.indices = EMPTY_U32
		if (vertexCapacity > 0 || triangleCapacity > 0) this.reserve(vertexCapacity, triangleCapacity)
	}

	get indexCount(): number {
		return this.triangleCount * 3
	}

	get skinned(): boolean {
		return this.skinIndices !== null && this.skinWeights !== null
	}

	// -----------------------------------------------------------------------
	// Capacity
	// -----------------------------------------------------------------------

	/**
	 * Grow to hold at least this many vertices and triangles. Growth is by doubling, so a
	 * generator that reserves nothing still amortises to O(n) rather than reallocating on
	 * every greeble it stamps.
	 */
	reserve(vertices: number, triangles: number): this {
		if (vertices > this.vertexCapacity) {
			const cap = Math.max(vertices, this.vertexCapacity * 2, 64)
			const used = this.vertexCount
			this.positions = growF32(this.positions, used * 3, cap * 3)
			this.normals = growF32(this.normals, used * 3, cap * 3)
			this.tangents = growF32(this.tangents, used * 4, cap * 4)
			this.uv0 = growF32(this.uv0, used * 2, cap * 2)
			this.uv1 = growF32(this.uv1, used * 2, cap * 2)
			this.materialZone = growU8(this.materialZone, used, cap)
			if (this.skinIndices) this.skinIndices = growU8(this.skinIndices, used * 4, cap * 4)
			if (this.skinWeights) this.skinWeights = growF32(this.skinWeights, used * 4, cap * 4)
			this.vertexCapacity = cap
		}
		if (triangles > this.triangleCapacity) {
			const cap = Math.max(triangles, this.triangleCapacity * 2, 64)
			this.indices = growU32(this.indices, this.triangleCount * 3, cap * 3)
			this.triangleCapacity = cap
		}
		return this
	}

	/** Resets counts without releasing capacity, so a scratch mesh can be reused. */
	clear(): this {
		this.vertexCount = 0
		this.triangleCount = 0
		this.boundsDirty = true
		return this
	}

	/** Rule 7. A Mesh owns no GPU handle — this drops the buffers for the collector. */
	dispose(): void {
		this.positions = EMPTY_F32
		this.normals = EMPTY_F32
		this.tangents = EMPTY_F32
		this.uv0 = EMPTY_F32
		this.uv1 = EMPTY_F32
		this.materialZone = EMPTY_U8
		this.indices = EMPTY_U32
		this.skinIndices = null
		this.skinWeights = null
		this.vertexCount = 0
		this.triangleCount = 0
		this.vertexCapacity = 0
		this.triangleCapacity = 0
		this.boundsDirty = true
	}

	clone(): Mesh {
		const m = new Mesh(this.vertexCount, this.triangleCount)
		const n = this.vertexCount
		m.positions.set(this.positions.subarray(0, n * 3))
		m.normals.set(this.normals.subarray(0, n * 3))
		m.tangents.set(this.tangents.subarray(0, n * 4))
		m.uv0.set(this.uv0.subarray(0, n * 2))
		m.uv1.set(this.uv1.subarray(0, n * 2))
		m.materialZone.set(this.materialZone.subarray(0, n))
		if (this.skinIndices && this.skinWeights) {
			m.enableSkin()
			m.skinIndices!.set(this.skinIndices.subarray(0, n * 4))
			m.skinWeights!.set(this.skinWeights.subarray(0, n * 4))
		}
		m.indices.set(this.indices.subarray(0, this.triangleCount * 3))
		m.vertexCount = n
		m.triangleCount = this.triangleCount
		m.aabbMin.set(this.aabbMin)
		m.aabbMax.set(this.aabbMax)
		m.boundingSphere.set(this.boundingSphere)
		m.boundsDirty = this.boundsDirty
		return m
	}

	/**
	 * Allocates the skin channels. Existing vertices are bound rigidly to `defaultBone`
	 * with weight 1 — a static sub-part merged into a rigged mesh rides one bone, it does
	 * not float unweighted at the origin.
	 */
	enableSkin(defaultBone = 0): this {
		if (this.skinIndices && this.skinWeights) return this
		const cap = this.vertexCapacity
		this.skinIndices = new Uint8Array(cap * 4)
		this.skinWeights = new Float32Array(cap * 4)
		for (let i = 0; i < this.vertexCount; i++) {
			this.skinIndices[i * 4] = defaultBone
			this.skinWeights[i * 4] = 1
		}
		return this
	}

	// -----------------------------------------------------------------------
	// Building
	// -----------------------------------------------------------------------

	/**
	 * Appends a vertex and returns its index. tangent/uv1/skin are explicitly zeroed
	 * rather than left to the allocator, so a mesh reused after clear() cannot inherit a
	 * previous generation's data — that failure mode is invisible until a shadow is wrong.
	 */
	addVertex(x: number, y: number, z: number, nx = 0, ny = 0, nz = 0, u = 0, v = 0, zone = 0): number {
		const i = this.vertexCount
		if (i >= this.vertexCapacity) this.reserve(i + 1, this.triangleCount)
		const p3 = i * 3
		this.positions[p3] = x
		this.positions[p3 + 1] = y
		this.positions[p3 + 2] = z
		this.normals[p3] = nx
		this.normals[p3 + 1] = ny
		this.normals[p3 + 2] = nz
		const p4 = i * 4
		this.tangents[p4] = 0
		this.tangents[p4 + 1] = 0
		this.tangents[p4 + 2] = 0
		this.tangents[p4 + 3] = 1
		const p2 = i * 2
		this.uv0[p2] = u
		this.uv0[p2 + 1] = v
		this.uv1[p2] = 0
		this.uv1[p2 + 1] = 0
		this.materialZone[i] = zone
		if (this.skinIndices && this.skinWeights) {
			this.skinIndices[p4] = 0
			this.skinIndices[p4 + 1] = 0
			this.skinIndices[p4 + 2] = 0
			this.skinIndices[p4 + 3] = 0
			this.skinWeights[p4] = 1
			this.skinWeights[p4 + 1] = 0
			this.skinWeights[p4 + 2] = 0
			this.skinWeights[p4 + 3] = 0
		}
		this.vertexCount = i + 1
		this.boundsDirty = true
		return i
	}

	setPosition(i: number, x: number, y: number, z: number): void {
		const o = i * 3
		this.positions[o] = x
		this.positions[o + 1] = y
		this.positions[o + 2] = z
		this.boundsDirty = true
	}

	setNormal(i: number, x: number, y: number, z: number): void {
		const o = i * 3
		this.normals[o] = x
		this.normals[o + 1] = y
		this.normals[o + 2] = z
	}

	setTangent(i: number, x: number, y: number, z: number, w: number): void {
		const o = i * 4
		this.tangents[o] = x
		this.tangents[o + 1] = y
		this.tangents[o + 2] = z
		this.tangents[o + 3] = w
	}

	setUv0(i: number, u: number, v: number): void {
		this.uv0[i * 2] = u
		this.uv0[i * 2 + 1] = v
	}

	setUv1(i: number, u: number, v: number): void {
		this.uv1[i * 2] = u
		this.uv1[i * 2 + 1] = v
	}

	setZone(i: number, zone: number): void {
		this.materialZone[i] = zone
	}

	/** Weights are renormalised here so the GPU path can assume they sum to 1. */
	setSkin(i: number, b0: number, b1: number, b2: number, b3: number, w0: number, w1: number, w2: number, w3: number): void {
		if (!this.skinIndices || !this.skinWeights) this.enableSkin()
		const o = i * 4
		const si = this.skinIndices!
		const sw = this.skinWeights!
		si[o] = b0
		si[o + 1] = b1
		si[o + 2] = b2
		si[o + 3] = b3
		const s = w0 + w1 + w2 + w3
		if (s > 1e-8) {
			const inv = 1 / s
			sw[o] = w0 * inv
			sw[o + 1] = w1 * inv
			sw[o + 2] = w2 * inv
			sw[o + 3] = w3 * inv
		} else {
			// An unweighted vertex collapses to the origin under skinning; bind to b0.
			sw[o] = 1
			sw[o + 1] = 0
			sw[o + 2] = 0
			sw[o + 3] = 0
		}
	}

	getPosition(i: number, out: Vec3): Vec3 {
		const o = i * 3
		return v3.set(out, this.positions[o], this.positions[o + 1], this.positions[o + 2])
	}

	getNormal(i: number, out: Vec3): Vec3 {
		const o = i * 3
		return v3.set(out, this.normals[o], this.normals[o + 1], this.normals[o + 2])
	}

	addTriangle(a: number, b: number, c: number): number {
		const t = this.triangleCount
		if (t >= this.triangleCapacity) this.reserve(this.vertexCount, t + 1)
		const o = t * 3
		this.indices[o] = a
		this.indices[o + 1] = b
		this.indices[o + 2] = c
		this.triangleCount = t + 1
		return t
	}

	/** Counter-clockwise quad a-b-c-d as two triangles. Surface nets emit quads. */
	addQuad(a: number, b: number, c: number, d: number): void {
		this.addTriangle(a, b, c)
		this.addTriangle(a, c, d)
	}

	/** Reverses winding. Used after a mirroring transform; see transform(). */
	flipWinding(): this {
		const idx = this.indices
		for (let t = 0; t < this.triangleCount; t++) {
			const o = t * 3
			const b = idx[o + 1]
			idx[o + 1] = idx[o + 2]
			idx[o + 2] = b
		}
		return this
	}

	// -----------------------------------------------------------------------
	// Welding
	// -----------------------------------------------------------------------

	/**
	 * Welds vertices identical in position, normal, both UV sets, zone and skin, and drops
	 * triangles that degenerate as a result.
	 *
	 * This is load-bearing rather than cosmetic: surface nets emit the same cell vertex up
	 * to four times and CSG re-emits every clipped corner, so an unwelded body mesh carries
	 * 3-4x the vertices it needs and — worse — has no shared edges, which makes the
	 * simplifier see a soup of disconnected triangles and produce a useless LOD.
	 *
	 * Candidates are found on a grid of side `posEps`, so two points within `posEps` are at
	 * most one cell apart per axis and the 27-cell probe is exhaustive. The representative
	 * chosen is always the lowest surviving index, which makes the result a pure function of
	 * the input order rather than of hash-chain order.
	 */
	compact(posEps = DEFAULT_WELD_EPS, normalCos = DEFAULT_NORMAL_COS, uvEps = DEFAULT_UV_EPS): this {
		const n = this.vertexCount
		if (n === 0) {
			this.triangleCount = 0
			return this
		}
		const remap = new Int32Array(n)
		/** New index -> the old index that survives it. Always >= the new index. */
		const repOf = new Int32Array(n)
		const tableSize = nextPow2(n * 2)
		const mask = tableSize - 1
		const head = new Int32Array(tableSize).fill(-1)
		const next = new Int32Array(n).fill(-1)

		const pos = this.positions
		const nrm = this.normals
		const a0 = this.uv0
		const a1 = this.uv1
		const zn = this.materialZone
		const si = this.skinIndices
		const sw = this.skinWeights
		const inv = 1 / posEps
		const epsSq = posEps * posEps
		const uvEpsSq = uvEps * uvEps
		let kept = 0

		for (let v = 0; v < n; v++) {
			const p = v * 3
			const x = pos[p]
			const y = pos[p + 1]
			const z = pos[p + 2]
			const ix = Math.round(x * inv)
			const iy = Math.round(y * inv)
			const iz = Math.round(z * inv)
			let best = -1
			for (let dz = -1; dz <= 1; dz++) {
				for (let dy = -1; dy <= 1; dy++) {
					for (let dx = -1; dx <= 1; dx++) {
						const cell = gridHash(ix + dx, iy + dy, iz + dz) & mask
						for (let c = head[cell]; c >= 0; c = next[c]) {
							if (best >= 0 && c > best) continue
							const q = c * 3
							const ex = pos[q] - x
							const ey = pos[q + 1] - y
							const ez = pos[q + 2] - z
							if (ex * ex + ey * ey + ez * ez > epsSq) continue
							if (zn[c] !== zn[v]) continue
							if (!normalsMatch(nrm, c, v, normalCos)) continue
							if (!uvMatch(a0, c, v, uvEpsSq)) continue
							if (!uvMatch(a1, c, v, uvEpsSq)) continue
							if (si && sw && !skinMatch(si, sw, c, v)) continue
							if (best < 0 || c < best) best = c
						}
					}
				}
			}
			if (best >= 0) {
				remap[v] = remap[best]
				continue
			}
			repOf[kept] = v
			remap[v] = kept++
			const cell = gridHash(ix, iy, iz) & mask
			next[v] = head[cell]
			head[cell] = v
		}

		// repOf[d] >= d for every d, because a representative is the first vertex of its
		// class — so this forward in-place copy never overwrites a source it still needs.
		for (let d = 0; d < kept; d++) copyVertex(this, repOf[d], d)
		this.vertexCount = kept

		const idx = this.indices
		let w = 0
		for (let t = 0; t < this.triangleCount; t++) {
			const o = t * 3
			const a = remap[idx[o]]
			const b = remap[idx[o + 1]]
			const c = remap[idx[o + 2]]
			// Exactly-duplicated triangles are kept: a banner or a decal card is legitimately
			// two coincident faces, and silently deleting one leaves it invisible from behind.
			if (a === b || b === c || a === c) continue
			const q = w * 3
			idx[q] = a
			idx[q + 1] = b
			idx[q + 2] = c
			w++
		}
		this.triangleCount = w
		this.boundsDirty = true
		return this
	}

	// -----------------------------------------------------------------------
	// Normals and tangents
	// -----------------------------------------------------------------------

	/**
	 * Area-weighted vertex normals.
	 *
	 * The unnormalised edge cross product is 2·area·n̂, so simply summing it weights each
	 * face by its area. That is what makes a greebled plate read correctly: a panel's two
	 * large triangles dominate the dozen tiny bevel and rivet triangles crowding its rim,
	 * where angle weighting would let the rim's high vertex density dome the flat face.
	 *
	 * With `creaseAngleRad === 0` (the default) the index topology decides hard versus soft
	 * — vertices the generator already split stay split. With a positive crease angle the
	 * mesh re-derives that itself: faces are clustered per welded position by edge
	 * connectivity and angle, and vertices spanning two clusters are duplicated. Crease mode
	 * clusters in welded-position space, so a UV seam does NOT become a shading seam.
	 *
	 * Crease mode changes vertexCount — call computeTangents() after, not before.
	 */
	computeNormals(creaseAngleRad = 0, weldEps = DEFAULT_WELD_EPS): this {
		const n = this.vertexCount
		const m = this.triangleCount
		if (n === 0 || m === 0) return this
		if (creaseAngleRad <= 0) {
			this.normals.fill(0, 0, n * 3)
			this.accumulateFaceNormals()
			normalizeRange(this.normals, n)
			return this
		}
		this.computeNormalsWithCreases(creaseAngleRad, weldEps)
		return this
	}

	private accumulateFaceNormals(): void {
		const pos = this.positions
		const nrm = this.normals
		const idx = this.indices
		for (let t = 0; t < this.triangleCount; t++) {
			const o = t * 3
			const ia = idx[o] * 3
			const ib = idx[o + 1] * 3
			const ic = idx[o + 2] * 3
			const ax = pos[ia]
			const ay = pos[ia + 1]
			const az = pos[ia + 2]
			const e1x = pos[ib] - ax
			const e1y = pos[ib + 1] - ay
			const e1z = pos[ib + 2] - az
			const e2x = pos[ic] - ax
			const e2y = pos[ic + 1] - ay
			const e2z = pos[ic + 2] - az
			const fx = e1y * e2z - e1z * e2y
			const fy = e1z * e2x - e1x * e2z
			const fz = e1x * e2y - e1y * e2x
			nrm[ia] += fx
			nrm[ia + 1] += fy
			nrm[ia + 2] += fz
			nrm[ib] += fx
			nrm[ib + 1] += fy
			nrm[ib + 2] += fz
			nrm[ic] += fx
			nrm[ic + 1] += fy
			nrm[ic + 2] += fz
		}
	}

	private computeNormalsWithCreases(creaseAngleRad: number, weldEps: number): void {
		const m = this.triangleCount
		const corners = m * 3
		const idx = this.indices
		const pos = this.positions
		const cosLimit = Math.cos(clamp(creaseAngleRad, 0, Math.PI))

		// Unnormalised (area-weighted) face normals, plus normalised copies for the angle
		// test — a sliver's direction is still meaningful even though its area is not.
		const faceN = new Float64Array(m * 3)
		const faceU = new Float64Array(m * 3)
		for (let t = 0; t < m; t++) {
			const o = t * 3
			const ia = idx[o] * 3
			const ib = idx[o + 1] * 3
			const ic = idx[o + 2] * 3
			const ax = pos[ia]
			const ay = pos[ia + 1]
			const az = pos[ia + 2]
			const e1x = pos[ib] - ax
			const e1y = pos[ib + 1] - ay
			const e1z = pos[ib + 2] - az
			const e2x = pos[ic] - ax
			const e2y = pos[ic + 1] - ay
			const e2z = pos[ic + 2] - az
			const fx = e1y * e2z - e1z * e2y
			const fy = e1z * e2x - e1x * e2z
			const fz = e1x * e2y - e1y * e2x
			faceN[o] = fx
			faceN[o + 1] = fy
			faceN[o + 2] = fz
			const l = Math.sqrt(fx * fx + fy * fy + fz * fz)
			if (l > 1e-20) {
				faceU[o] = fx / l
				faceU[o + 1] = fy / l
				faceU[o + 2] = fz / l
			}
		}

		const groups = buildPositionGroups(pos, this.vertexCount, weldEps)
		const group = groups.group
		const g = groups.count

		// Group -> corner CSR.
		const start = new Int32Array(g + 1)
		for (let c = 0; c < corners; c++) start[group[idx[c]] + 1]++
		let maxValence = 0
		for (let i = 0; i < g; i++) {
			if (start[i + 1] > maxValence) maxValence = start[i + 1]
			start[i + 1] += start[i]
		}
		const cursor = new Int32Array(g)
		const list = new Int32Array(corners)
		for (let c = 0; c < corners; c++) {
			const gi = group[idx[c]]
			list[start[gi] + cursor[gi]++] = c
		}

		const parent = new Int32Array(maxValence)
		const localCluster = new Int32Array(maxValence)
		const cornerCluster = new Int32Array(corners)
		// Bounded by the corner count: every corner can at worst be its own cluster.
		const clusterN = new Float64Array(corners * 3)
		let clusterCount = 0

		for (let gi = 0; gi < g; gi++) {
			const s = start[gi]
			const e = start[gi + 1]
			const k = e - s
			if (k === 0) continue
			for (let i = 0; i < k; i++) parent[i] = i
			for (let i = 0; i < k; i++) {
				const ci = list[s + i]
				const ti = (ci / 3) | 0
				const oi = ti * 3
				for (let j = i + 1; j < k; j++) {
					const cj = list[s + j]
					const tj = (cj / 3) | 0
					if (ti === tj) continue
					// Edge-connected at this position: the two faces must share a second
					// welded position, not merely touch this one. Comparing group ids rather
					// than vertex ids is what lets shading run smoothly across a UV seam.
					if (!shareGroupEdge(idx, group, oi, tj * 3, gi)) continue
					const oj = tj * 3
					const d = faceU[oi] * faceU[oj] + faceU[oi + 1] * faceU[oj + 1] + faceU[oi + 2] * faceU[oj + 2]
					if (d < cosLimit) continue
					unite(parent, i, j)
				}
			}
			// Cluster ids are handed out in ascending local order, so the numbering — and
			// therefore every duplicated vertex's index — is a pure function of the input.
			for (let i = 0; i < k; i++) localCluster[i] = -1
			for (let i = 0; i < k; i++) {
				const r = findRoot(parent, i)
				if (localCluster[r] < 0) localCluster[r] = clusterCount++
				const id = localCluster[r]
				const c = list[s + i]
				cornerCluster[c] = id
				const o = ((c / 3) | 0) * 3
				const co = id * 3
				clusterN[co] += faceN[o]
				clusterN[co + 1] += faceN[o + 1]
				clusterN[co + 2] += faceN[o + 2]
			}
		}

		// Split any vertex whose corners fall in more than one cluster. `seen` is a small
		// per-group association list; valences are single digits, so a linear scan beats a
		// Map and allocates nothing.
		const seenVert = new Int32Array(maxValence)
		const seenCluster = new Int32Array(maxValence)
		const seenOut = new Int32Array(maxValence)
		const vertUsed = new Uint8Array(this.vertexCount)
		for (let gi = 0; gi < g; gi++) {
			const s = start[gi]
			const e = start[gi + 1]
			let seen = 0
			for (let i = s; i < e; i++) {
				const c = list[i]
				const v = idx[c]
				const cl = cornerCluster[c]
				let found = -1
				for (let j = 0; j < seen; j++) {
					if (seenVert[j] === v && seenCluster[j] === cl) {
						found = seenOut[j]
						break
					}
				}
				if (found < 0) {
					if (vertUsed[v] === 0) {
						vertUsed[v] = 1
						found = v
					} else {
						found = this.duplicateVertex(v)
					}
					seenVert[seen] = v
					seenCluster[seen] = cl
					seenOut[seen] = found
					seen++
				}
				idx[c] = found
			}
		}

		// Written last: duplication may have reallocated `this.normals`.
		const nrm = this.normals
		for (let c = 0; c < corners; c++) {
			const co = cornerCluster[c] * 3
			let nx = clusterN[co]
			let ny = clusterN[co + 1]
			let nz = clusterN[co + 2]
			const l = Math.sqrt(nx * nx + ny * ny + nz * nz)
			if (l > 1e-20) {
				nx /= l
				ny /= l
				nz /= l
			}
			const o = idx[c] * 3
			nrm[o] = nx
			nrm[o + 1] = ny
			nrm[o + 2] = nz
		}
	}

	/** Appends a copy of vertex `v` and returns the new index. */
	private duplicateVertex(v: number): number {
		const i = this.vertexCount
		if (i >= this.vertexCapacity) this.reserve(i + 1, this.triangleCount)
		this.vertexCount = i + 1
		copyVertex(this, v, i)
		this.boundsDirty = true
		return i
	}

	/**
	 * Per-vertex tangent frame from uv0 (Lengyel). Accumulated in f64 because a long thin
	 * panel's uv determinant is tiny and f32 accumulation over a few hundred incident
	 * triangles drifts enough to twist the frame visibly under an anisotropic highlight.
	 *
	 * Degenerate UVs produce an arbitrary but stable perpendicular rather than a NaN — a
	 * NaN tangent poisons the whole normal-mapped pixel and is invisible in a mesh dump.
	 */
	computeTangents(): this {
		const n = this.vertexCount
		const m = this.triangleCount
		if (n === 0 || m === 0) return this
		const pos = this.positions
		const uv = this.uv0
		const idx = this.indices
		const tanA = new Float64Array(n * 3)
		const bitA = new Float64Array(n * 3)

		for (let t = 0; t < m; t++) {
			const o = t * 3
			const a = idx[o]
			const b = idx[o + 1]
			const c = idx[o + 2]
			const pa = a * 3
			const pb = b * 3
			const pc = c * 3
			const x1 = pos[pb] - pos[pa]
			const y1 = pos[pb + 1] - pos[pa + 1]
			const z1 = pos[pb + 2] - pos[pa + 2]
			const x2 = pos[pc] - pos[pa]
			const y2 = pos[pc + 1] - pos[pa + 1]
			const z2 = pos[pc + 2] - pos[pa + 2]
			const ua = a * 2
			const ub = b * 2
			const uc = c * 2
			const s1 = uv[ub] - uv[ua]
			const t1 = uv[ub + 1] - uv[ua + 1]
			const s2 = uv[uc] - uv[ua]
			const t2 = uv[uc + 1] - uv[ua + 1]
			const det = s1 * t2 - s2 * t1
			if (!(Math.abs(det) > 1e-20)) continue
			const r = 1 / det
			const tx = (t2 * x1 - t1 * x2) * r
			const ty = (t2 * y1 - t1 * y2) * r
			const tz = (t2 * z1 - t1 * z2) * r
			const bx = (s1 * x2 - s2 * x1) * r
			const by = (s1 * y2 - s2 * y1) * r
			const bz = (s1 * z2 - s2 * z1) * r
			for (let k = 0; k < 3; k++) {
				const vi = idx[o + k] * 3
				tanA[vi] += tx
				tanA[vi + 1] += ty
				tanA[vi + 2] += tz
				bitA[vi] += bx
				bitA[vi + 1] += by
				bitA[vi + 2] += bz
			}
		}

		const nrm = this.normals
		const tan = this.tangents
		for (let i = 0; i < n; i++) {
			const o3 = i * 3
			const o4 = i * 4
			const nx = nrm[o3]
			const ny = nrm[o3 + 1]
			const nz = nrm[o3 + 2]
			let tx = tanA[o3]
			let ty = tanA[o3 + 1]
			let tz = tanA[o3 + 2]
			// Gram-Schmidt against the normal.
			const d = nx * tx + ny * ty + nz * tz
			tx -= nx * d
			ty -= ny * d
			tz -= nz * d
			let l = Math.sqrt(tx * tx + ty * ty + tz * tz)
			if (!(l > 1e-12)) {
				// Perpendicular to the least-aligned axis: stable, and never near-parallel.
				const ax = Math.abs(nx)
				const ay = Math.abs(ny)
				const az = Math.abs(nz)
				let rx = 0
				let ry = 0
				let rz = 0
				if (ax <= ay && ax <= az) rx = 1
				else if (ay <= az) ry = 1
				else rz = 1
				tx = ny * rz - nz * ry
				ty = nz * rx - nx * rz
				tz = nx * ry - ny * rx
				l = Math.sqrt(tx * tx + ty * ty + tz * tz)
				if (!(l > 1e-12)) {
					tx = 1
					ty = 0
					tz = 0
					l = 1
				}
			}
			tan[o4] = tx / l
			tan[o4 + 1] = ty / l
			tan[o4 + 2] = tz / l
			// w is the handedness the shader needs to rebuild the bitangent as
			// w * cross(n, t) — mirrored UV shells have the opposite sign.
			const cx = ny * tz - nz * ty
			const cy = nz * tx - nx * tz
			const cz = nx * ty - ny * tx
			tan[o4 + 3] = cx * bitA[o3] + cy * bitA[o3 + 1] + cz * bitA[o3 + 2] < 0 ? -1 : 1
		}
		return this
	}

	// -----------------------------------------------------------------------
	// Bounds
	// -----------------------------------------------------------------------

	invalidateBounds(): void {
		this.boundsDirty = true
	}

	/**
	 * AABB plus a Ritter bounding sphere. Ritter rather than AABB-centre because the sphere
	 * is what the culler and the LOD selector test against, and an AABB-centred sphere on a
	 * long chassis is up to 40% too big — that is a unit that keeps its LOD0 a screenful
	 * past where it should have dropped.
	 */
	updateBounds(): this {
		if (!this.boundsDirty) return this
		const n = this.vertexCount
		const pos = this.positions
		if (n === 0) {
			this.aabbMin.fill(0)
			this.aabbMax.fill(0)
			this.boundingSphere.fill(0)
			this.boundsDirty = false
			return this
		}
		let minX = Infinity
		let minY = Infinity
		let minZ = Infinity
		let maxX = -Infinity
		let maxY = -Infinity
		let maxZ = -Infinity
		let iMinX = 0
		let iMinY = 0
		let iMinZ = 0
		let iMaxX = 0
		let iMaxY = 0
		let iMaxZ = 0
		for (let i = 0; i < n; i++) {
			const o = i * 3
			const x = pos[o]
			const y = pos[o + 1]
			const z = pos[o + 2]
			if (x < minX) {
				minX = x
				iMinX = i
			}
			if (y < minY) {
				minY = y
				iMinY = i
			}
			if (z < minZ) {
				minZ = z
				iMinZ = i
			}
			if (x > maxX) {
				maxX = x
				iMaxX = i
			}
			if (y > maxY) {
				maxY = y
				iMaxY = i
			}
			if (z > maxZ) {
				maxZ = z
				iMaxZ = i
			}
		}
		v3.set(this.aabbMin, minX, minY, minZ)
		v3.set(this.aabbMax, maxX, maxY, maxZ)

		// Seed from the most-separated pair among the six axis extremes, not from the widest
		// axis. On a boxy Foundry chassis the widest axis yields a face diagonal, and the
		// growth pass then overshoots by ~25%; the true diagonal starts within a few percent
		// of optimal and usually needs no growth at all.
		ritterSeed[0] = iMinX
		ritterSeed[1] = iMaxX
		ritterSeed[2] = iMinY
		ritterSeed[3] = iMaxY
		ritterSeed[4] = iMinZ
		ritterSeed[5] = iMaxZ
		let a = iMinX
		let b = iMaxX
		let bestSep = -1
		for (let i = 0; i < 6; i++) {
			const oi = ritterSeed[i] * 3
			for (let j = i + 1; j < 6; j++) {
				const oj = ritterSeed[j] * 3
				const dx = pos[oj] - pos[oi]
				const dy = pos[oj + 1] - pos[oi + 1]
				const dz = pos[oj + 2] - pos[oi + 2]
				const s = dx * dx + dy * dy + dz * dz
				if (s > bestSep) {
					bestSep = s
					a = ritterSeed[i]
					b = ritterSeed[j]
				}
			}
		}
		const pa = a * 3
		const pb = b * 3
		let cx = (pos[pa] + pos[pb]) * 0.5
		let cy = (pos[pa + 1] + pos[pb + 1]) * 0.5
		let cz = (pos[pa + 2] + pos[pb + 2]) * 0.5
		let r = Math.hypot(pos[pb] - cx, pos[pb + 1] - cy, pos[pb + 2] - cz)
		for (let i = 0; i < n; i++) {
			const o = i * 3
			const dx = pos[o] - cx
			const dy = pos[o + 1] - cy
			const dz = pos[o + 2] - cz
			const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
			if (d <= r) continue
			// Grow just enough to swallow the outlier, shifting the centre half the excess.
			const nr = (r + d) * 0.5
			const k = (nr - r) / d
			cx += dx * k
			cy += dy * k
			cz += dz * k
			r = nr
		}
		this.boundingSphere[0] = cx
		this.boundingSphere[1] = cy
		this.boundingSphere[2] = cz
		// A hair of slack: the incremental growth above can leave the last point exactly on
		// the shell, and an exactly-on-shell point fails a strict culler test.
		this.boundingSphere[3] = r * (1 + 1e-6)
		this.boundsDirty = false
		return this
	}

	// -----------------------------------------------------------------------
	// Transform and merge
	// -----------------------------------------------------------------------

	/**
	 * Transforms positions by `m`, normals by its cofactor matrix (the inverse-transpose up
	 * to a positive scale, which normalisation removes) and tangents as directions.
	 *
	 * A mirroring matrix flips winding and handedness; both are corrected here, because the
	 * alternative is a mirrored turret that is backface-culled into invisibility and a
	 * normal map that lights from the wrong side.
	 */
	transform(m: Mat4): this {
		this.transformRange(m, 0, this.vertexCount)
		if (mat3Det(m) < 0) this.flipWinding()
		this.boundsDirty = true
		return this
	}

	private transformRange(m: Mat4, from: number, to: number): void {
		const m00 = m[0]
		const m10 = m[1]
		const m20 = m[2]
		const m01 = m[4]
		const m11 = m[5]
		const m21 = m[6]
		const m02 = m[8]
		const m12 = m[9]
		const m22 = m[10]
		const c00 = m11 * m22 - m12 * m21
		const c01 = m12 * m20 - m10 * m22
		const c02 = m10 * m21 - m11 * m20
		const c10 = m02 * m21 - m01 * m22
		const c11 = m00 * m22 - m02 * m20
		const c12 = m01 * m20 - m00 * m21
		const c20 = m01 * m12 - m02 * m11
		const c21 = m02 * m10 - m00 * m12
		const c22 = m00 * m11 - m01 * m10
		const det = m00 * c00 + m01 * c01 + m02 * c02
		const sign = det < 0 ? -1 : 1
		const pos = this.positions
		const nrm = this.normals
		const tan = this.tangents
		for (let i = from; i < to; i++) {
			const o3 = i * 3
			const x = pos[o3]
			const y = pos[o3 + 1]
			const z = pos[o3 + 2]
			const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1
			pos[o3] = (m00 * x + m01 * y + m02 * z + m[12]) / w
			pos[o3 + 1] = (m10 * x + m11 * y + m12 * z + m[13]) / w
			pos[o3 + 2] = (m20 * x + m21 * y + m22 * z + m[14]) / w

			const nx = nrm[o3]
			const ny = nrm[o3 + 1]
			const nz = nrm[o3 + 2]
			// cof(M)·n, not cof(M)^T·n. cof(M) = det·M^-T is the inverse-transpose up to a
			// scalar; its transpose is adj(M) = det·M^-1, which is a different matrix entirely
			// unless the linear part is symmetric. Getting this backwards leaves pure scales and
			// axis mirrors correct — which is exactly why it survives a scale-only test — and
			// rotates every other normal the wrong way, most visibly by the negated rotation
			// angle on a plain rotation.
			let tx = (c00 * nx + c01 * ny + c02 * nz) * sign
			let ty = (c10 * nx + c11 * ny + c12 * nz) * sign
			let tz = (c20 * nx + c21 * ny + c22 * nz) * sign
			let l = Math.sqrt(tx * tx + ty * ty + tz * tz)
			if (l > 1e-20) {
				nrm[o3] = tx / l
				nrm[o3 + 1] = ty / l
				nrm[o3 + 2] = tz / l
			}

			const o4 = i * 4
			const ax = tan[o4]
			const ay = tan[o4 + 1]
			const az = tan[o4 + 2]
			tx = m00 * ax + m01 * ay + m02 * az
			ty = m10 * ax + m11 * ay + m12 * az
			tz = m20 * ax + m21 * ay + m22 * az
			l = Math.sqrt(tx * tx + ty * ty + tz * tz)
			if (l > 1e-20) {
				tan[o4] = tx / l
				tan[o4 + 1] = ty / l
				tan[o4 + 2] = tz / l
			}
			tan[o4 + 3] *= sign
		}
	}

	/**
	 * Appends `other`, optionally transformed on the way in. `other` is not modified.
	 *
	 * The result is not welded — call compact() once after the last merge rather than after
	 * each, since welding is the expensive part and a kit-bashed structure merges dozens of
	 * parts.
	 */
	merge(other: Mesh, xform: Mat4 | null = null, bindBone = 0): this {
		// Self-merge would read `other`'s arrays while reallocating this one's.
		const src = other === this ? this.clone() : other
		const vn = src.vertexCount
		const tn = src.triangleCount
		if (vn === 0 || tn === 0) return this
		const base = this.vertexCount
		this.reserve(base + vn, this.triangleCount + tn)
		if (src.skinIndices && src.skinWeights && !this.skinIndices) this.enableSkin(bindBone)

		this.positions.set(src.positions.subarray(0, vn * 3), base * 3)
		this.normals.set(src.normals.subarray(0, vn * 3), base * 3)
		this.tangents.set(src.tangents.subarray(0, vn * 4), base * 4)
		this.uv0.set(src.uv0.subarray(0, vn * 2), base * 2)
		this.uv1.set(src.uv1.subarray(0, vn * 2), base * 2)
		this.materialZone.set(src.materialZone.subarray(0, vn), base)
		if (this.skinIndices && this.skinWeights) {
			if (src.skinIndices && src.skinWeights) {
				this.skinIndices.set(src.skinIndices.subarray(0, vn * 4), base * 4)
				this.skinWeights.set(src.skinWeights.subarray(0, vn * 4), base * 4)
			} else {
				// A static part merged into a rigged mesh rides one bone rigidly.
				for (let i = 0; i < vn; i++) {
					const o = (base + i) * 4
					this.skinIndices[o] = bindBone
					this.skinIndices[o + 1] = 0
					this.skinIndices[o + 2] = 0
					this.skinIndices[o + 3] = 0
					this.skinWeights[o] = 1
					this.skinWeights[o + 1] = 0
					this.skinWeights[o + 2] = 0
					this.skinWeights[o + 3] = 0
				}
			}
		}
		this.vertexCount = base + vn

		const dst = this.indices
		const si = src.indices
		let o = this.triangleCount * 3
		for (let i = 0; i < tn * 3; i++) dst[o + i] = si[i] + base
		this.triangleCount += tn

		if (xform) {
			this.transformRange(xform, base, base + vn)
			if (mat3Det(xform) < 0) {
				// Flip only the appended range; the rest of the mesh keeps its winding.
				for (let t = this.triangleCount - tn; t < this.triangleCount; t++) {
					const q = t * 3
					const b = dst[q + 1]
					dst[q + 1] = dst[q + 2]
					dst[q + 2] = b
				}
			}
		}
		this.boundsDirty = true
		return this
	}

	// -----------------------------------------------------------------------
	// LOD
	// -----------------------------------------------------------------------

	/**
	 * Quadric-error-metric edge-collapse decimation. Returns a new Mesh; `this` is untouched.
	 *
	 * `targetRatio` is the fraction of the triangle count to keep. `maxError` caps the
	 * accepted quadric error (area-weighted squared distance) and defaults to no cap.
	 *
	 * The metric matters far more than the speed here — this runs once at boot in a worker
	 * (§6), and the render gate is that an LOD switch is invisible at both zoom extremes.
	 * Three properties buy that:
	 *
	 *  - Collapses happen in welded-position space, so both sides of a UV seam decimate in
	 *    lockstep and a seam can never crack open.
	 *  - Material-zone boundaries and attribute seams are classified once and are only ever
	 *    collapsed *along* themselves, never across. Collapsing across a seam drags a UV
	 *    island onto its neighbour, which reads as texture swimming during the transition —
	 *    the single most common way an otherwise fine LOD chain looks broken.
	 *  - Every candidate is rejected if it would fold a triangle over or create a
	 *    non-manifold fin, so a silhouette never inverts as it simplifies.
	 */
	simplify(targetRatio: number, maxError = Infinity, weldEps = DEFAULT_WELD_EPS): Mesh {
		const out = this.clone()
		if (targetRatio >= 1 || out.triangleCount === 0) return out
		const target = Math.max(2, Math.round(out.triangleCount * Math.max(targetRatio, 0)))
		if (out.triangleCount <= target) return out
		new Decimator(out, weldEps).run(target, maxError)
		out.updateBounds()
		return out
	}

	/**
	 * `levels` meshes of decreasing detail, level 0 being a full-detail clone.
	 *
	 * Each level is simplified from the *original*, not from the level above: cascading
	 * compounds the quadric error, and by level 3 the accumulated drift is exactly the
	 * silhouette wobble the transition gate is looking for. Clones throughout, so the chain
	 * is self-contained and disposing it never reaches back into the source mesh.
	 *
	 * `maxError` is deliberately left uncapped here, and that is not an oversight. A level of an
	 * LOD chain owes a triangle *budget* (§7), and `run()` implements a cap by breaking out of
	 * the collapse loop — so any finite value silently returns a level that overshoots its
	 * budget, which is the failure this chain exists to avoid. The cap is also unusable from
	 * here on its own terms: `qErr` is area-weighted, so it carries units of length^4 and no
	 * caller can name a value that means the same thing on a rivet and on a hull. Deviation is
	 * bounded where it is actually generated instead — see OPTIMUM_RANGE — which is scale-free
	 * and costs no triangles. `maxError` stays on `simplify` for callers who genuinely want
	 * error-limited rather than count-limited decimation.
	 *
	 * Every level the decimator changed then goes through repairShadingNormals(). `simplify`
	 * keeps shading continuous by *reusing* surviving wedges, and on thin plates that is
	 * exactly what breaks: a 3 mm rim collapse leaves the front face nothing but back-face and
	 * rim wedges to fold into, so the silhouette stays square while the shading normals point
	 * backwards and the panel reads as a dark-cornered oval. Level 0 is never touched.
	 */
	generateLodChain(levels: number, falloff = 0.5, weldEps = DEFAULT_WELD_EPS): Mesh[] {
		const chain: Mesh[] = []
		const n = Math.max(1, Math.floor(levels))
		chain.push(this.clone())
		let ratio = 1
		for (let i = 1; i < n; i++) {
			ratio *= falloff
			const level = this.simplify(ratio, Infinity, weldEps)
			// A level the decimator could not reduce is still a copy of level 0; keep it one.
			if (level.triangleCount < this.triangleCount) level.repairShadingNormals(SHADING_REPAIR_COS, SHADING_SMOOTH_COS, weldEps)
			chain.push(level)
		}
		return chain
	}

	/**
	 * Gives every triangle corner whose shading normal faces away from its own face — cos below
	 * `minCos` — a vertex of its own, and returns how many vertices that added.
	 *
	 * The new vertex is an exact copy of the one the corner used (position, both UV sets,
	 * zone, skin), so geometry, texturing and animation are unchanged; only its normal is
	 * rebuilt, as the area-weighted average of the faces at that welded position lying within
	 * `smoothCos` of the corner's own face. That average is provably within acos(smoothCos) of
	 * the face, so a repaired corner can never itself fail the test. Corners that share a
	 * vertex and land on the same normal share one new vertex, so a whole panel face costs one
	 * split per corner position, not one per triangle. The tangent is re-orthogonalised against
	 * the new normal and keeps its bitangent's physical direction, so normal-map relief is not
	 * inverted where a normal flips.
	 *
	 * Deterministic: position groups, corner lists and the split order are all functions of
	 * the index order alone. Corners on zero-area triangles are left alone — they have no face
	 * to agree with and cover no pixels.
	 */
	repairShadingNormals(minCos = SHADING_REPAIR_COS, smoothCos = SHADING_SMOOTH_COS, weldEps = DEFAULT_WELD_EPS): number {
		const m = this.triangleCount
		const n = this.vertexCount
		if (m === 0 || n === 0) return 0
		const corners = m * 3
		const pos = this.positions
		const nrm = this.normals
		let idx = this.indices
		// Unnormalised (area-weighted) face normals for the averages, unit ones for the tests.
		const faceN = new Float64Array(corners)
		const faceU = new Float64Array(corners)
		const bad = new Uint8Array(corners)
		let badCount = 0
		for (let t = 0; t < m; t++) {
			const o = t * 3
			const ia = idx[o] * 3
			const ib = idx[o + 1] * 3
			const ic = idx[o + 2] * 3
			const ax = pos[ia]
			const ay = pos[ia + 1]
			const az = pos[ia + 2]
			const e1x = pos[ib] - ax
			const e1y = pos[ib + 1] - ay
			const e1z = pos[ib + 2] - az
			const e2x = pos[ic] - ax
			const e2y = pos[ic + 1] - ay
			const e2z = pos[ic + 2] - az
			const fx = e1y * e2z - e1z * e2y
			const fy = e1z * e2x - e1x * e2z
			const fz = e1x * e2y - e1y * e2x
			const l = Math.sqrt(fx * fx + fy * fy + fz * fz)
			if (!(l > 1e-20)) continue
			faceN[o] = fx
			faceN[o + 1] = fy
			faceN[o + 2] = fz
			const ux = fx / l
			const uy = fy / l
			const uz = fz / l
			faceU[o] = ux
			faceU[o + 1] = uy
			faceU[o + 2] = uz
			for (let k = 0; k < 3; k++) {
				const v = idx[o + k] * 3
				const nx = nrm[v]
				const ny = nrm[v + 1]
				const nz = nrm[v + 2]
				const nl = Math.sqrt(nx * nx + ny * ny + nz * nz)
				// A zero normal is no normal at all (the GPU encoder substitutes +Z): repair it too.
				if (!(nl > 1e-20) || nx * ux + ny * uy + nz * uz < minCos * nl) {
					bad[o + k] = 1
					badCount++
				}
			}
		}
		if (badCount === 0) return 0

		// Welded-position groups and a group -> corner CSR in ascending corner order, the same
		// construction crease mode uses, so a UV seam does not split a smooth group.
		const groups = buildPositionGroups(pos, n, weldEps)
		const group = groups.group
		const g = groups.count
		const start = new Int32Array(g + 1)
		for (let c = 0; c < corners; c++) start[group[idx[c]] + 1]++
		let maxValence = 0
		for (let i = 0; i < g; i++) {
			if (start[i + 1] > maxValence) maxValence = start[i + 1]
			start[i + 1] += start[i]
		}
		const cursor = new Int32Array(g)
		const list = new Int32Array(corners)
		for (let c = 0; c < corners; c++) {
			const gi = group[idx[c]]
			list[start[gi] + cursor[gi]++] = c
		}

		// Per-group association list (source vertex, normal) -> new vertex. Valences are small,
		// so a linear scan beats a Map, as in crease mode.
		const seenVert = new Int32Array(maxValence)
		const seenOut = new Int32Array(maxValence)
		const seenN = new Float64Array(maxValence * 3)
		let added = 0
		for (let gi = 0; gi < g; gi++) {
			const s = start[gi]
			const e = start[gi + 1]
			let seen = 0
			for (let i = s; i < e; i++) {
				const c = list[i]
				if (bad[c] === 0) continue
				const ot = ((c / 3) | 0) * 3
				const ux = faceU[ot]
				const uy = faceU[ot + 1]
				const uz = faceU[ot + 2]
				let sx = 0
				let sy = 0
				let sz = 0
				let previous = -1
				for (let j = s; j < e; j++) {
					const oj = ((list[j] / 3) | 0) * 3
					// Corners of one triangle are adjacent in the ascending list: count it once.
					if (oj === previous) continue
					previous = oj
					if (faceU[oj] * ux + faceU[oj + 1] * uy + faceU[oj + 2] * uz < smoothCos) continue
					sx += faceN[oj]
					sy += faceN[oj + 1]
					sz += faceN[oj + 2]
				}
				// Never zero: the corner's own positive-area face is always in its group.
				const l = Math.sqrt(sx * sx + sy * sy + sz * sz)
				const nx = sx / l
				const ny = sy / l
				const nz = sz / l
				const v = idx[c]
				let out = -1
				for (let q = 0; q < seen; q++) {
					const qo = q * 3
					if (seenVert[q] === v && seenN[qo] === nx && seenN[qo + 1] === ny && seenN[qo + 2] === nz) {
						out = seenOut[q]
						break
					}
				}
				if (out < 0) {
					out = this.duplicateVertex(v)
					this.reframeVertex(out, v, nx, ny, nz)
					// Duplication may have reallocated the index buffer on a capacity-less mesh.
					idx = this.indices
					seenVert[seen] = v
					seenOut[seen] = out
					seenN[seen * 3] = nx
					seenN[seen * 3 + 1] = ny
					seenN[seen * 3 + 2] = nz
					seen++
					added++
				}
				idx[c] = out
			}
		}
		return added
	}

	/**
	 * Writes normal (nx,ny,nz) to vertex `dst` and rebuilds its tangent from vertex `src`'s
	 * frame: Gram-Schmidt against the new normal, and handedness chosen so the bitangent keeps
	 * its physical direction. A flipped normal therefore flips handedness instead of mirroring
	 * the normal map's v axis, which would turn relief into a saddle.
	 */
	private reframeVertex(dst: number, src: number, nx: number, ny: number, nz: number): void {
		const nrm = this.normals
		const tan = this.tangents
		const s3 = src * 3
		const s4 = src * 4
		const d3 = dst * 3
		const d4 = dst * 4
		const ox = nrm[s3]
		const oy = nrm[s3 + 1]
		const oz = nrm[s3 + 2]
		const t0x = tan[s4]
		const t0y = tan[s4 + 1]
		const t0z = tan[s4 + 2]
		const w0 = tan[s4 + 3] < 0 ? -1 : 1
		// Old bitangent, exactly as the shader rebuilds it: w * cross(n, t).
		const bx = w0 * (oy * t0z - oz * t0y)
		const by = w0 * (oz * t0x - ox * t0z)
		const bz = w0 * (ox * t0y - oy * t0x)
		nrm[d3] = nx
		nrm[d3 + 1] = ny
		nrm[d3 + 2] = nz
		const d = nx * t0x + ny * t0y + nz * t0z
		let tx = t0x - nx * d
		let ty = t0y - ny * d
		let tz = t0z - nz * d
		let l = Math.sqrt(tx * tx + ty * ty + tz * tz)
		if (!(l > 1e-12)) {
			// Tangent parallel to the new normal: perpendicular to the least-aligned axis, the
			// same stable fallback computeTangents uses.
			const ax = Math.abs(nx)
			const ay = Math.abs(ny)
			const az = Math.abs(nz)
			const rx = ax <= ay && ax <= az ? 1 : 0
			const ry = rx === 0 && ay <= az ? 1 : 0
			const rz = rx === 0 && ry === 0 ? 1 : 0
			tx = ny * rz - nz * ry
			ty = nz * rx - nx * rz
			tz = nx * ry - ny * rx
			l = Math.sqrt(tx * tx + ty * ty + tz * tz)
		}
		tx /= l
		ty /= l
		tz /= l
		tan[d4] = tx
		tan[d4 + 1] = ty
		tan[d4 + 2] = tz
		const hand = (ny * tz - nz * ty) * bx + (nz * tx - nx * tz) * by + (nx * ty - ny * tx) * bz
		tan[d4 + 3] = hand < 0 ? -1 : hand > 0 ? 1 : w0
	}

	// -----------------------------------------------------------------------
	// GPU
	// -----------------------------------------------------------------------

	/**
	 * Interleaved vertex data plus indices, ready for a vertex buffer. Interleaved rather
	 * than one buffer per attribute because every draw here reads the whole vertex — split
	 * streams would cost one cache line per attribute instead of one per vertex.
	 *
	 * `transfer` lists the ArrayBuffers to hand to postMessage, so a generated mesh crosses
	 * out of its worker without a copy.
	 */
	toGPUBuffers(): GpuMeshBuffers {
		this.updateBounds()
		const n = this.vertexCount
		const skinned = this.skinned
		const stride = skinned ? VERTEX_STRIDE_SKINNED : VERTEX_STRIDE
		const vertexData = new ArrayBuffer(n * stride)
		const u8 = new Uint8Array(vertexData)
		const i8 = new Int8Array(vertexData)
		const u16 = new Uint16Array(vertexData)
		const pos = this.positions
		const nrm = this.normals
		const tan = this.tangents
		const a0 = this.uv0
		const a1 = this.uv1
		const zn = this.materialZone
		const si = this.skinIndices
		const sw = this.skinWeights

		for (let i = 0; i < n; i++) {
			const bo = i * stride
			const p3 = i * 3
			const p4 = i * 4
			const p2 = i * 2
			// Position: float16x4 at offset 0, written in a strided pass after this loop.
			// Normals/tangents: octahedral snorm8 pairs; the tangent word carries handedness
			// in its third byte. UVs: unorm16 in [0,1] atlas space.
			octEncodeInto(nrm, p3, i8, bo + NORMAL_OFFSET)
			octEncodeInto(tan, p4, i8, bo + TANGENT_OFFSET)
			i8[bo + TANGENT_OFFSET + 2] = tan[p4 + 3] < 0 ? -127 : 127
			i8[bo + TANGENT_OFFSET + 3] = 0
			u16[(bo + UV0_OFFSET) >> 1] = quantizeUnorm(a0[p2])
			u16[((bo + UV0_OFFSET) >> 1) + 1] = quantizeUnorm(a0[p2 + 1])
			u16[(bo + UV1_OFFSET) >> 1] = quantizeUnorm(a1[p2])
			u16[((bo + UV1_OFFSET) >> 1) + 1] = quantizeUnorm(a1[p2 + 1])
			u8[bo + ZONE_BYTE_OFFSET] = zn[i]
			u8[bo + ZONE_BYTE_OFFSET + 1] = 0
			u8[bo + ZONE_BYTE_OFFSET + 2] = 0
			u8[bo + ZONE_BYTE_OFFSET + 3] = 0
			if (skinned && si && sw) {
				u8[bo + SKIN_INDEX_OFFSET] = si[p4]
				u8[bo + SKIN_INDEX_OFFSET + 1] = si[p4 + 1]
				u8[bo + SKIN_INDEX_OFFSET + 2] = si[p4 + 2]
				u8[bo + SKIN_INDEX_OFFSET + 3] = si[p4 + 3]
				// unorm8 weights, with the rounding residue folded into the largest channel
				// that can actually take it, so the four bytes sum to exactly 255 and the
				// shader can skip renormalising. Channels are visited by weight, largest
				// first, and one whose clamped add would bind — past 255 for a positive
				// residue, under 0 for a negative one — is skipped rather than silently
				// absorbing the residue through its clamp.
				let w0 = Math.round(clamp(sw[p4], 0, 1) * 255)
				let w1 = Math.round(clamp(sw[p4 + 1], 0, 1) * 255)
				let w2 = Math.round(clamp(sw[p4 + 2], 0, 1) * 255)
				let w3 = Math.round(clamp(sw[p4 + 3], 0, 1) * 255)
				const residue = 255 - (w0 + w1 + w2 + w3)
				if (residue !== 0) {
					const c0 = w0 + residue
					const c1 = w1 + residue
					const c2 = w2 + residue
					const c3 = w3 + residue
					if (w0 >= w1 && w0 >= w2 && w0 >= w3 && c0 >= 0 && c0 <= 255) w0 = c0
					else if (w1 >= w2 && w1 >= w3 && c1 >= 0 && c1 <= 255) w1 = c1
					else if (w2 >= w3 && c2 >= 0 && c2 <= 255) w2 = c2
					else if (c3 >= 0 && c3 <= 255) w3 = c3
					else if (c0 >= 0 && c0 <= 255) w0 = c0
					else if (c1 >= 0 && c1 <= 255) w1 = c1
					else if (c2 >= 0 && c2 <= 255) w2 = c2
					else w3 = clamp(w3 + residue, 0, 255)
				}
				u8[bo + SKIN_WEIGHT_OFFSET] = w0
				u8[bo + SKIN_WEIGHT_OFFSET + 1] = w1
				u8[bo + SKIN_WEIGHT_OFFSET + 2] = w2
				u8[bo + SKIN_WEIGHT_OFFSET + 3] = w3
			}
		}
	// Positions: one strided float16 pass per component. toHalf is round-to-nearest-even,
	// the same tie-breaking hardware vertex fetch would apply to a native f16 asset.
	// The fourth half stays 0; the shader consumes .xyz from the vec4 input.
	const h16 = new Uint16Array(vertexData)
	for (let i = 0; i < n; i++) {
		const p3 = i * 3
		const h = (i * stride) >> 1
		h16[h] = toHalf(pos[p3])
		h16[h + 1] = toHalf(pos[p3 + 1])
		h16[h + 2] = toHalf(pos[p3 + 2])
		h16[h + 3] = 0
	}

		// u16 whenever it fits: halves index bandwidth, and it is the only format a plain
		// WebGL2 context takes without OES_element_index_uint.
		const useU16 = n <= 0x10000
		const count = this.triangleCount * 3
		const idxData = new ArrayBuffer(count * (useU16 ? 2 : 4))
		const dst = useU16 ? new Uint16Array(idxData) : new Uint32Array(idxData)
		dst.set(this.indices.subarray(0, count))

		return {
			vertexData,
			indexData: idxData,
			indexFormat: useU16 ? 'uint16' : 'uint32',
			stride,
			vertexCount: n,
			indexCount: count,
			attributes: skinned ? ATTRIBUTES_SKINNED : ATTRIBUTES_STATIC,
			skinned,
			aabbMin: this.aabbMin.slice(),
			aabbMax: this.aabbMax.slice(),
			boundingSphere: this.boundingSphere.slice(),
			transfer: [vertexData, idxData],
		}
	}

	/**
	 * Returns null when the mesh is well-formed, or the first problem found. Cheap enough
	 * for baseline.mjs to run on every generated mesh: a NaN position survives all the way
	 * to a blank frame with no error anywhere, which is the worst kind of bug to chase.
	 */
	validate(): string | null {
		const n = this.vertexCount
		for (let i = 0; i < n * 3; i++) if (!Number.isFinite(this.positions[i])) return `position[${i}] is not finite`
		for (let i = 0; i < n * 3; i++) if (!Number.isFinite(this.normals[i])) return `normal[${i}] is not finite`
		for (let i = 0; i < n * 4; i++) if (!Number.isFinite(this.tangents[i])) return `tangent[${i}] is not finite`
		for (let i = 0; i < n * 2; i++) if (!Number.isFinite(this.uv0[i])) return `uv0[${i}] is not finite`
		const c = this.triangleCount * 3
		for (let i = 0; i < c; i++) {
			const v = this.indices[i]
			if (v >= n) return `index[${i}] = ${v} exceeds vertexCount ${n}`
		}
		for (let t = 0; t < this.triangleCount; t++) {
			const o = t * 3
			if (this.indices[o] === this.indices[o + 1] || this.indices[o + 1] === this.indices[o + 2] || this.indices[o] === this.indices[o + 2])
				return `triangle ${t} is degenerate`
		}
		if (this.skinIndices && this.skinWeights) {
			for (let i = 0; i < n; i++) {
				const o = i * 4
				const s = this.skinWeights[o] + this.skinWeights[o + 1] + this.skinWeights[o + 2] + this.skinWeights[o + 3]
				if (Math.abs(s - 1) > 1e-3) return `vertex ${i} skin weights sum to ${s}`
			}
		}
		return null
	}
}

// ---- vertex quantization helpers (toGPUBuffers) ----

const TANGENT_SCRATCH = new Int8Array(2)

/** Quantize [0,1] to unorm16 (65535 steps); values outside the range clamp. */
function quantizeUnorm(v: number): number {
	return Math.max(0, Math.min(65535, Math.round(v * 65535)))
}

/**
 * IEEE float32 -> float16 bits, round-to-nearest-even, denormals flushed to zero.
 * Mesh-local positions are metre-scale, far inside f16's normal range; this is the
 * standard bit-twiddling conversion (same tie-breaking a native f16 asset would get).
 */
const HALF_F32 = new Float32Array(1)
const HALF_U32 = new Uint32Array(HALF_F32.buffer)
function toHalf(value: number): number {
	HALF_F32[0] = value
	const x = HALF_U32[0]
	const sign = (x >>> 16) & 0x8000
	let exp = (x >>> 23) & 0xff
	let man = x & 0x7fffff
	if (exp === 0xff) return sign | 0x7c00 | (man !== 0 ? 0x200 : 0) // inf/nan
	let e = exp - 127 + 15
	if (e >= 0x1f) return sign | 0x7c00 // overflow -> inf (never reached at mesh scale)
	if (e <= 0) {
		// Subnormal half: shift the mantissa in; rounds to zero at these magnitudes.
		if (e < -10) return sign
		man |= 0x800000
		const shift = 14 - e
		const half = man >> shift
	const round = (man >> (shift - 1)) & 1
		const sticky = (man & ((1 << (shift - 1)) - 1)) !== 0
		let out = half + (round === 1 && (sticky || (half & 1) === 1) ? 1 : 0)
		return sign | out
	}
	const half = (e << 10) | (man >> 13)
	const round = (man >> 12) & 1
	const sticky = (man & 0xfff) !== 0
	return sign | half + (round === 1 && (sticky || (half & 1) === 1) ? 1 : 0)
}

/**
 * Octahedral encoding of a unit vector into two snorm8 bytes (meshopt-standard): project the
 * normal onto the octahedron, fold the lower hemisphere into the diamond, quantize to [-127,
 * 127]. Decoded in the vertex stage with the mirrored `octDecode`. The reconstruction error
 * is under half a degree for any unit input, which is invisible after per-fragment
 * normalization and normal mapping.
 */
function octEncodeInto(src: Float32Array, at: number, out: Int8Array, outAt: number): void {
	let x = src[at], y = src[at + 1], z = src[at + 2]
	const l = Math.hypot(x, y, z)
	if (l > 1e-20) { x /= l; y /= l; z /= l } else { x = 0; y = 0; z = 1 }
	const s = Math.abs(x) + Math.abs(y) + Math.abs(z)
	let u = x / s, v = y / s
	if (z < 0) {
		// Lower hemisphere: reflect into the diamond border (copysign semantics, so an
		// exactly-zero component folds towards +). Both terms read the PRE-fold pair.
		const fu = (1 - Math.abs(v)) * (u < 0 ? -1 : 1)
		const fv = (1 - Math.abs(u)) * (v < 0 ? -1 : 1)
		u = fu
		v = fv
	}
	// Quantize. Folded lower-hemisphere pairs legitimately sit OUTSIDE the |u|+|v| = 1
	// diamond (the decoder folds them back), so they must not be rescaled. The one
	// unrepresentable point is the exact corner (±127, ±127): the decode fold collapses
	// it to the zero vector, so nudge the second component in by one step.
	let q = Math.max(-127, Math.min(127, Math.round(u * 127)))
	let r = Math.max(-127, Math.min(127, Math.round(v * 127)))
	if (Math.abs(q) === 127 && Math.abs(r) === 127) r -= Math.sign(r)
	out[outAt] = q
	out[outAt + 1] = r
}

// ---------------------------------------------------------------------------
// Buffer helpers
// ---------------------------------------------------------------------------

function growF32(a: Float32Array, used: number, len: number): Float32Array {
	const b = new Float32Array(len)
	if (used > 0) b.set(a.subarray(0, used))
	return b
}

function growU32(a: Uint32Array, used: number, len: number): Uint32Array {
	const b = new Uint32Array(len)
	if (used > 0) b.set(a.subarray(0, used))
	return b
}

function growU8(a: Uint8Array, used: number, len: number): Uint8Array {
	const b = new Uint8Array(len)
	if (used > 0) b.set(a.subarray(0, used))
	return b
}

function copyVertex(m: Mesh, from: number, to: number): void {
	if (from === to) return
	const f3 = from * 3
	const t3 = to * 3
	m.positions[t3] = m.positions[f3]
	m.positions[t3 + 1] = m.positions[f3 + 1]
	m.positions[t3 + 2] = m.positions[f3 + 2]
	m.normals[t3] = m.normals[f3]
	m.normals[t3 + 1] = m.normals[f3 + 1]
	m.normals[t3 + 2] = m.normals[f3 + 2]
	const f4 = from * 4
	const t4 = to * 4
	m.tangents[t4] = m.tangents[f4]
	m.tangents[t4 + 1] = m.tangents[f4 + 1]
	m.tangents[t4 + 2] = m.tangents[f4 + 2]
	m.tangents[t4 + 3] = m.tangents[f4 + 3]
	const f2 = from * 2
	const t2 = to * 2
	m.uv0[t2] = m.uv0[f2]
	m.uv0[t2 + 1] = m.uv0[f2 + 1]
	m.uv1[t2] = m.uv1[f2]
	m.uv1[t2 + 1] = m.uv1[f2 + 1]
	m.materialZone[to] = m.materialZone[from]
	if (m.skinIndices && m.skinWeights) {
		m.skinIndices[t4] = m.skinIndices[f4]
		m.skinIndices[t4 + 1] = m.skinIndices[f4 + 1]
		m.skinIndices[t4 + 2] = m.skinIndices[f4 + 2]
		m.skinIndices[t4 + 3] = m.skinIndices[f4 + 3]
		m.skinWeights[t4] = m.skinWeights[f4]
		m.skinWeights[t4 + 1] = m.skinWeights[f4 + 1]
		m.skinWeights[t4 + 2] = m.skinWeights[f4 + 2]
		m.skinWeights[t4 + 3] = m.skinWeights[f4 + 3]
	}
}

function normalizeRange(a: Float32Array, count: number): void {
	for (let i = 0; i < count; i++) {
		const o = i * 3
		const x = a[o]
		const y = a[o + 1]
		const z = a[o + 2]
		const l = Math.sqrt(x * x + y * y + z * z)
		if (l > 1e-20) {
			a[o] = x / l
			a[o + 1] = y / l
			a[o + 2] = z / l
		} else {
			// An isolated or fully-degenerate vertex: up, so nothing downstream sees a zero
			// normal and produces a black pixel.
			a[o] = 0
			a[o + 1] = 0
			a[o + 2] = 1
		}
	}
}

function nextPow2(n: number): number {
	let p = 1
	while (p < n) p *= 2
	return p
}

/** Teschner's spatial hash constants. Math.imul keeps the products exactly 32-bit. */
function gridHash(x: number, y: number, z: number): number {
	return (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0
}

function mat3Det(m: Mat4): number {
	return (
		m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5])
	)
}

function normalsMatch(n: Float32Array, a: number, b: number, cosLimit: number): boolean {
	const oa = a * 3
	const ob = b * 3
	const la = n[oa] * n[oa] + n[oa + 1] * n[oa + 1] + n[oa + 2] * n[oa + 2]
	const lb = n[ob] * n[ob] + n[ob + 1] * n[ob + 1] + n[ob + 2] * n[ob + 2]
	const za = la < 1e-16
	const zb = lb < 1e-16
	// One side carrying a normal and the other not is treated as a mismatch: welding them
	// would silently adopt whichever came first and lose a crease the generator meant.
	if (za !== zb) return false
	if (za) return true
	const d = n[oa] * n[ob] + n[oa + 1] * n[ob + 1] + n[oa + 2] * n[ob + 2]
	return d >= cosLimit * Math.sqrt(la * lb)
}

function uvMatch(uv: Float32Array, a: number, b: number, epsSq: number): boolean {
	const oa = a * 2
	const ob = b * 2
	const du = uv[oa] - uv[ob]
	const dv = uv[oa + 1] - uv[ob + 1]
	return du * du + dv * dv <= epsSq
}

function skinMatch(si: Uint8Array, sw: Float32Array, a: number, b: number): boolean {
	const oa = a * 4
	const ob = b * 4
	for (let k = 0; k < 4; k++) {
		if (si[oa + k] !== si[ob + k]) return false
		if (Math.abs(sw[oa + k] - sw[ob + k]) > 1e-3) return false
	}
	return true
}

function findRoot(parent: Int32Array, i: number): number {
	let r = i
	while (parent[r] !== r) {
		parent[r] = parent[parent[r]]
		r = parent[r]
	}
	return r
}

function unite(parent: Int32Array, a: number, b: number): void {
	const ra = findRoot(parent, a)
	const rb = findRoot(parent, b)
	if (ra === rb) return
	// Always attach the larger root to the smaller, so the forest — and therefore the
	// cluster numbering derived from it — is independent of the union order.
	if (ra < rb) parent[rb] = ra
	else parent[ra] = rb
}

/** True when triangles at corner-bases `ta`/`tb` share a welded edge through group `g`. */
function shareGroupEdge(idx: Uint32Array, group: Int32Array, ta: number, tb: number, g: number): boolean {
	for (let i = 0; i < 3; i++) {
		const ga = group[idx[ta + i]]
		if (ga === g) continue
		for (let j = 0; j < 3; j++) {
			const gb = group[idx[tb + j]]
			if (gb === g) continue
			if (ga === gb) return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Position groups
// ---------------------------------------------------------------------------

export interface PositionGroups {
	/** Group id per vertex. Vertices sharing a position share a group ("wedges"). */
	readonly group: Int32Array
	readonly count: number
}

/**
 * Welds vertices by position alone, ignoring attributes. The result is the topological
 * surface: a cube corner's three normal-split vertices are three wedges of one group.
 *
 * Everything that has to reason about the *surface* rather than the vertex buffer — crease
 * clustering, and the whole simplifier — works in this space. That is what stops a UV seam
 * from being treated as an open boundary and cracked apart.
 */
export function buildPositionGroups(position: Float32Array, vertexCount: number, eps: number): PositionGroups {
	const group = new Int32Array(vertexCount).fill(-1)
	if (vertexCount === 0) return { group, count: 0 }
	const tableSize = nextPow2(vertexCount * 2)
	const mask = tableSize - 1
	const head = new Int32Array(tableSize).fill(-1)
	const next = new Int32Array(vertexCount).fill(-1)
	const inv = 1 / eps
	const epsSq = eps * eps
	let count = 0

	for (let v = 0; v < vertexCount; v++) {
		const p = v * 3
		const x = position[p]
		const y = position[p + 1]
		const z = position[p + 2]
		const ix = Math.round(x * inv)
		const iy = Math.round(y * inv)
		const iz = Math.round(z * inv)
		let best = -1
		for (let dz = -1; dz <= 1; dz++) {
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const cell = gridHash(ix + dx, iy + dy, iz + dz) & mask
					for (let c = head[cell]; c >= 0; c = next[c]) {
						const q = c * 3
						const ex = position[q] - x
						const ey = position[q + 1] - y
						const ez = position[q + 2] - z
						if (ex * ex + ey * ey + ez * ez > epsSq) continue
						const gid = group[c]
						if (best < 0 || gid < best) best = gid
					}
				}
			}
		}
		if (best >= 0) {
			group[v] = best
			continue
		}
		group[v] = count++
		const cell = gridHash(ix, iy, iz) & mask
		next[v] = head[cell]
		head[cell] = v
	}
	return { group, count }
}

// ---------------------------------------------------------------------------
// Decimator
// ---------------------------------------------------------------------------

const KIND_INTERIOR = 0
const KIND_SEAM = 1
const KIND_LOCKED = 2

/**
 * Weight on a seam's perpendicular constraint plane, relative to the face quadrics. Scaled
 * by edge length squared so it has the same units as the area-weighted face terms, and
 * large enough that a seam vertex effectively cannot leave its curve.
 */
const SEAM_WEIGHT = 256
/**
 * How far off its own edge a solved collapse target may sit, in edge lengths. The optimum is
 * clamped back to this radius, never discarded, so the solve keeps its along-edge component.
 *
 * This was 4, measured against the edge *midpoint*, and in that form it never rejected a single
 * placement in a nine-shape sweep — including the run that grew 38%-of-radius needles on a unit
 * sphere. It has to be this tight because the thing it is guarding against is not noise: on a
 * closed hull the quadric's true minimiser is the apex of the neighbourhood's tangent cone, which
 * is outside the surface and has a legitimately low error, so nothing error-based will catch it.
 *
 * 1/16 was chosen by measurement, not taste. Across UV spheres (16x8 to 64x32), icospheres
 * (level 2-4), blobs and a capped cylinder at ratios 0.5 down to 0.02, it cuts worst-case outward
 * hull growth from 37.2% to 2.5% while every feature metric is unchanged: a subdivided cube keeps
 * 8/8 corners with 0.0000 surface deviation, material-zone boundaries stay put, open-plate
 * deviation is unchanged, and every case still reaches its triangle target. It clamps ~45% of
 * placements and the clamped optimum still beats all three edge points on 99.9% of them, so the
 * solve is bounded, not bypassed.
 */
const OPTIMUM_RANGE = 1 / 16
/** Minimum cos between a triangle's normal before and after; below it, the face folded. */
const FLIP_MIN = 1e-3

class Decimator {
	private mesh: Mesh
	private group: Int32Array
	private groupCount: number
	/** Group positions, f64 — the quadric solve loses a digit per f32 round-trip. */
	private gx: Float64Array
	/** 10 coefficients of the symmetric 4x4 quadric per group. */
	private quad: Float64Array
	private kind: Uint8Array
	private dead: Uint8Array
	private version: Int32Array
	private gHead: Int32Array
	private gTail: Int32Array
	private cornerNext: Int32Array
	private triDead: Uint8Array
	private liveTris: number
	private stamp: Int32Array
	private stampGen = 0
	/** materialZone is a u8, so 256 slots covers every possible zone exactly. */
	private zoneStamp = new Int32Array(256)
	private zoneGen = 0

	private hCost = new Float64Array(256)
	private hU = new Int32Array(256)
	private hV = new Int32Array(256)
	private hVU = new Int32Array(256)
	private hVV = new Int32Array(256)
	private hSize = 0

	// probeEdge results
	private edgeTris = 0
	private edgeSeam = false
	// candidate results
	private tryCost = 0
	private tryX = 0
	private tryY = 0
	private tryZ = 0
	private tryT = -1
	private evalOk = false
	private evalSrc = -1
	private evalDst = -1
	private evalCost = 0
	private evalX = 0
	private evalY = 0
	private evalZ = 0
	private evalT = -1

	private srcWedge = new Int32Array(16)
	private mapWedge = new Int32Array(16)
	private dstWedge = new Int32Array(16)
	private nbr = new Int32Array(64)

	constructor(mesh: Mesh, weldEps: number) {
		this.mesh = mesh
		const groups = buildPositionGroups(mesh.positions, mesh.vertexCount, weldEps)
		this.group = groups.group
		this.groupCount = groups.count
		const g = this.groupCount
		const m = mesh.triangleCount
		this.gx = new Float64Array(g * 3)
		this.quad = new Float64Array(g * 10)
		this.kind = new Uint8Array(g)
		this.dead = new Uint8Array(g)
		this.version = new Int32Array(g)
		this.gHead = new Int32Array(g).fill(-1)
		this.gTail = new Int32Array(g).fill(-1)
		this.cornerNext = new Int32Array(m * 3).fill(-1)
		this.triDead = new Uint8Array(m)
		this.stamp = new Int32Array(g)
		this.liveTris = m

		const pos = mesh.positions
		for (let v = 0; v < mesh.vertexCount; v++) {
			const o = this.group[v] * 3
			const p = v * 3
			this.gx[o] = pos[p]
			this.gx[o + 1] = pos[p + 1]
			this.gx[o + 2] = pos[p + 2]
		}
		// Corner lists are built back-to-front so each group's list ends up in ascending
		// corner order — one less source of order dependence in the collapse loop.
		const idx = mesh.indices
		for (let c = m * 3 - 1; c >= 0; c--) {
			const gi = this.group[idx[c]]
			this.cornerNext[c] = this.gHead[gi]
			this.gHead[gi] = c
			if (this.gTail[gi] < 0) this.gTail[gi] = c
		}
	}

	run(targetTris: number, maxError: number): void {
		this.buildQuadricsAndClassify()
		while (this.liveTris > targetTris && this.hSize > 0) {
			const cost = this.hCost[0]
			const u = this.hU[0]
			const v = this.hV[0]
			const vu = this.hVU[0]
			const vv = this.hVV[0]
			this.heapPop()
			if (this.dead[u] || this.dead[v]) continue
			if (this.version[u] !== vu || this.version[v] !== vv) continue
			if (cost > maxError) break
			if (!this.evaluate(u, v)) continue
			// The neighbourhood may have shifted since this entry was pushed. Re-heap rather
			// than collapsing on a stale cost — an out-of-order collapse is exactly how a
			// silhouette loses a corner it should have kept until the last level.
			if (this.evalCost > cost * (1 + 1e-9) + 1e-18) {
				this.heapPush(this.evalCost, u, v, this.version[u], this.version[v])
				continue
			}
			if (this.evalCost > maxError) break
			this.collapse(this.evalSrc, this.evalDst, this.evalX, this.evalY, this.evalZ, this.evalT)
			this.pushIncident(this.evalDst)
		}
		this.rebuild()
	}

	// -----------------------------------------------------------------------
	// Setup
	// -----------------------------------------------------------------------

	private buildQuadricsAndClassify(): void {
		const mesh = this.mesh
		const m = mesh.triangleCount
		const idx = mesh.indices
		const gxp = this.gx
		const grp = this.group

		// A triangle with two corners in one position group has no area and no plane. The
		// quadric pass below already refuses to give it one, and collapse() kills exactly this
		// shape when it appears mid-run, so the classifier must refuse it too: such a triangle
		// contributes its one surviving group-edge *twice* and pushes that edge to three-or-more
		// faces on its own. A UV sphere's pole fan is built precisely like that, and counting it
		// pinned both poles and their entire first ring as non-manifold — the caps then survived
		// every LOD level and the decimation stalled well above its target.
		for (let t = 0; t < m; t++) {
			const o = t * 3
			const g0 = grp[idx[o]]
			const g1 = grp[idx[o + 1]]
			const g2 = grp[idx[o + 2]]
			if (g0 !== g1 && g1 !== g2 && g0 !== g2) continue
			this.triDead[t] = 1
			this.liveTris--
		}

		// Face quadrics, weighted by area (Garland & Heckbert).
		for (let t = 0; t < m; t++) {
			if (this.triDead[t]) continue
			const o = t * 3
			const a = grp[idx[o]] * 3
			const b = grp[idx[o + 1]] * 3
			const c = grp[idx[o + 2]] * 3
			const e1x = gxp[b] - gxp[a]
			const e1y = gxp[b + 1] - gxp[a + 1]
			const e1z = gxp[b + 2] - gxp[a + 2]
			const e2x = gxp[c] - gxp[a]
			const e2y = gxp[c + 1] - gxp[a + 1]
			const e2z = gxp[c + 2] - gxp[a + 2]
			let nx = e1y * e2z - e1z * e2y
			let ny = e1z * e2x - e1x * e2z
			let nz = e1x * e2y - e1y * e2x
			const l = Math.sqrt(nx * nx + ny * ny + nz * nz)
			if (!(l > 1e-24)) continue
			const area = l * 0.5
			nx /= l
			ny /= l
			nz /= l
			const d = -(nx * gxp[a] + ny * gxp[a + 1] + nz * gxp[a + 2])
			this.addPlane(grp[idx[o]], nx, ny, nz, d, area)
			this.addPlane(grp[idx[o + 1]], nx, ny, nz, d, area)
			this.addPlane(grp[idx[o + 2]], nx, ny, nz, d, area)
		}

		// Group-edge table: incident triangle count, and the wedges each triangle used at
		// each endpoint. A wedge mismatch is precisely a UV seam, a shading crease or a
		// material-zone boundary — zone lives on the vertex, so a zone change forces a
		// different vertex and therefore a different wedge.
		const cap = nextPow2(Math.max(16, m * 6))
		const mask = cap - 1
		const keyA = new Int32Array(cap).fill(-1)
		const keyB = new Int32Array(cap)
		const cnt = new Int32Array(cap)
		const tri0 = new Int32Array(cap)
		const tri1 = new Int32Array(cap)

		for (let t = 0; t < m; t++) {
			if (this.triDead[t]) continue
			const o = t * 3
			for (let k = 0; k < 3; k++) {
				const ga = grp[idx[o + k]]
				const gb = grp[idx[o + ((k + 1) % 3)]]
				if (ga === gb) continue
				const lo = ga < gb ? ga : gb
				const hi = ga < gb ? gb : ga
				let s = edgeHash(lo, hi) & mask
				for (;;) {
					if (keyA[s] < 0) {
						keyA[s] = lo
						keyB[s] = hi
						cnt[s] = 1
						tri0[s] = t
						break
					}
					if (keyA[s] === lo && keyB[s] === hi) {
						if (cnt[s] === 1) tri1[s] = t
						cnt[s]++
						break
					}
					s = (s + 1) & mask
				}
			}
		}

		// Pass 1: seams. Pass 2: locked. Locked must win, hence the split.
		for (let s = 0; s < cap; s++) {
			if (keyA[s] < 0) continue
			const a = keyA[s]
			const b = keyB[s]
			const n = cnt[s]
			let seam = n !== 2
			if (n === 2) {
				const t0 = tri0[s] * 3
				const t1 = tri1[s] * 3
				if (wedgeAt(idx, grp, t0, a) !== wedgeAt(idx, grp, t1, a)) seam = true
				else if (wedgeAt(idx, grp, t0, b) !== wedgeAt(idx, grp, t1, b)) seam = true
			}
			if (!seam) continue
			this.kind[a] = KIND_SEAM
			this.kind[b] = KIND_SEAM
			this.addSeamConstraint(a, b, tri0[s])
			if (n === 2) this.addSeamConstraint(a, b, tri1[s])
		}
		for (let s = 0; s < cap; s++) {
			if (keyA[s] < 0) continue
			if (cnt[s] <= 2) continue
			// Three or more faces on one edge: any collapse here produces geometry no
			// renderer or shadow pass can interpret. Pin it.
			this.kind[keyA[s]] = KIND_LOCKED
			this.kind[keyB[s]] = KIND_LOCKED
		}

		for (let s = 0; s < cap; s++) {
			if (keyA[s] < 0) continue
			if (this.evaluate(keyA[s], keyB[s]))
				this.heapPush(this.evalCost, keyA[s], keyB[s], this.version[keyA[s]], this.version[keyB[s]])
		}
	}

	private addPlane(g: number, a: number, b: number, c: number, d: number, w: number): void {
		const o = g * 10
		const q = this.quad
		q[o] += w * a * a
		q[o + 1] += w * a * b
		q[o + 2] += w * a * c
		q[o + 3] += w * a * d
		q[o + 4] += w * b * b
		q[o + 5] += w * b * c
		q[o + 6] += w * b * d
		q[o + 7] += w * c * c
		q[o + 8] += w * c * d
		q[o + 9] += w * d * d
	}

	/**
	 * The plane through edge (a,b) perpendicular to triangle `t`. Adding it to both
	 * endpoints costs any movement off the seam curve quadratically, which is what keeps a
	 * panel-line boundary or a UV island edge exactly where the texture forge put it.
	 */
	private addSeamConstraint(a: number, b: number, t: number): void {
		const gxp = this.gx
		const oa = a * 3
		const ob = b * 3
		const ex = gxp[ob] - gxp[oa]
		const ey = gxp[ob + 1] - gxp[oa + 1]
		const ez = gxp[ob + 2] - gxp[oa + 2]
		const lenSq = ex * ex + ey * ey + ez * ez
		if (!(lenSq > 1e-24)) return
		const idx = this.mesh.indices
		const grp = this.group
		const o = t * 3
		const ta = grp[idx[o]] * 3
		const tb = grp[idx[o + 1]] * 3
		const tc = grp[idx[o + 2]] * 3
		const f1x = gxp[tb] - gxp[ta]
		const f1y = gxp[tb + 1] - gxp[ta + 1]
		const f1z = gxp[tb + 2] - gxp[ta + 2]
		const f2x = gxp[tc] - gxp[ta]
		const f2y = gxp[tc + 1] - gxp[ta + 1]
		const f2z = gxp[tc + 2] - gxp[ta + 2]
		const fnx = f1y * f2z - f1z * f2y
		const fny = f1z * f2x - f1x * f2z
		const fnz = f1x * f2y - f1y * f2x
		let nx = ey * fnz - ez * fny
		let ny = ez * fnx - ex * fnz
		let nz = ex * fny - ey * fnx
		const l = Math.sqrt(nx * nx + ny * ny + nz * nz)
		if (!(l > 1e-24)) return
		nx /= l
		ny /= l
		nz /= l
		const d = -(nx * gxp[oa] + ny * gxp[oa + 1] + nz * gxp[oa + 2])
		const w = SEAM_WEIGHT * lenSq
		this.addPlane(a, nx, ny, nz, d, w)
		this.addPlane(b, nx, ny, nz, d, w)
	}

	// -----------------------------------------------------------------------
	// Cost
	// -----------------------------------------------------------------------

	private qErr(a: number, b: number, x: number, y: number, z: number): number {
		const q = this.quad
		const o = a * 10
		const p = b * 10
		const q0 = q[o] + q[p]
		const q1 = q[o + 1] + q[p + 1]
		const q2 = q[o + 2] + q[p + 2]
		const q3 = q[o + 3] + q[p + 3]
		const q4 = q[o + 4] + q[p + 4]
		const q5 = q[o + 5] + q[p + 5]
		const q6 = q[o + 6] + q[p + 6]
		const q7 = q[o + 7] + q[p + 7]
		const q8 = q[o + 8] + q[p + 8]
		const q9 = q[o + 9] + q[p + 9]
		const e =
			q0 * x * x +
			2 * q1 * x * y +
			2 * q2 * x * z +
			2 * q3 * x +
			q4 * y * y +
			2 * q5 * y * z +
			2 * q6 * y +
			q7 * z * z +
			2 * q8 * z +
			q9
		// The quadric is positive semi-definite in exact arithmetic; cancellation can push
		// it a hair below zero and a negative cost would sort ahead of everything.
		return e > 0 ? e : 0
	}

	/** Solves for the minimiser of Qa+Qb. Returns false when the system is ill-conditioned. */
	private qSolve(a: number, b: number, out: Float64Array): boolean {
		const q = this.quad
		const o = a * 10
		const p = b * 10
		const a00 = q[o] + q[p]
		const a01 = q[o + 1] + q[p + 1]
		const a02 = q[o + 2] + q[p + 2]
		const a11 = q[o + 4] + q[p + 4]
		const a12 = q[o + 5] + q[p + 5]
		const a22 = q[o + 7] + q[p + 7]
		const b0 = -(q[o + 3] + q[p + 3])
		const b1 = -(q[o + 6] + q[p + 6])
		const b2 = -(q[o + 8] + q[p + 8])
		const c00 = a11 * a22 - a12 * a12
		const c01 = a02 * a12 - a01 * a22
		const c02 = a01 * a12 - a02 * a11
		const det = a00 * c00 + a01 * c01 + a02 * c02
		let scale = Math.abs(a00)
		if (Math.abs(a11) > scale) scale = Math.abs(a11)
		if (Math.abs(a22) > scale) scale = Math.abs(a22)
		if (Math.abs(a01) > scale) scale = Math.abs(a01)
		if (Math.abs(a02) > scale) scale = Math.abs(a02)
		if (Math.abs(a12) > scale) scale = Math.abs(a12)
		// Relative rank test: on a flat region the system is genuinely singular and the optimum
		// is a whole plane, so any solve there is numerical noise pretending to be a point.
		//
		// det/scale^3 is (s1/s0)(s2/s0) for singular values s0>=s1>=s2, so the threshold is a
		// conditioning bound. It was 1e-12, which is f64 round-off: it only ever caught systems
		// that were singular to the last bit, and let every merely ill-conditioned near-planar
		// neighbourhood through to "solve" a point that is really an arbitrary choice along a
		// near-null direction. 1e-8 rejects a neighbourhood whose two lesser singular values have
		// each fallen to ~1e-4 of the largest, which is flat for any purpose here, and still sits
		// four orders above f64 noise.
		if (!(Math.abs(det) > 1e-8 * scale * scale * scale)) return false
		const c11 = a00 * a22 - a02 * a02
		const c12 = a01 * a02 - a00 * a12
		const c22 = a00 * a11 - a01 * a01
		const inv = 1 / det
		out[0] = (c00 * b0 + c01 * b1 + c02 * b2) * inv
		out[1] = (c01 * b0 + c11 * b1 + c12 * b2) * inv
		out[2] = (c02 * b0 + c12 * b1 + c22 * b2) * inv
		return Number.isFinite(out[0]) && Number.isFinite(out[1]) && Number.isFinite(out[2])
	}

	/**
	 * The cheapest of the three points a collapse can always fall back to: both endpoints and
	 * the midpoint. All three lie *on* the edge, so a target chosen here is a convex
	 * combination of two vertices that already exist — which is what makes the fallback safe
	 * to reach for. It can shrink a silhouette by at most half an edge, and can never push one
	 * outward.
	 */
	private bestEdgePoint(
		src: number,
		dst: number,
		sx: number,
		sy: number,
		sz: number,
		dx: number,
		dy: number,
		dz: number,
		out: Float64Array,
	): void {
		const mx = (sx + dx) * 0.5
		const my = (sy + dy) * 0.5
		const mz = (sz + dz) * 0.5
		const em = this.qErr(src, dst, mx, my, mz)
		const es = this.qErr(src, dst, sx, sy, sz)
		const ed = this.qErr(src, dst, dx, dy, dz)
		if (em <= es && em <= ed) {
			out[0] = mx
			out[1] = my
			out[2] = mz
			return
		}
		if (es < ed) {
			out[0] = sx
			out[1] = sy
			out[2] = sz
			return
		}
		out[0] = dx
		out[1] = dy
		out[2] = dz
	}

	/**
	 * Counts triangles on edge (p,q) and whether the wedges differ across them. Recomputed
	 * live rather than cached, because both facts change as neighbours collapse.
	 */
	private probeEdge(p: number, q: number): void {
		this.edgeTris = 0
		this.edgeSeam = false
		const idx = this.mesh.indices
		const grp = this.group
		let wp = -1
		let wq = -1
		for (let c = this.gHead[p]; c >= 0; c = this.cornerNext[c]) {
			const t = (c / 3) | 0
			if (this.triDead[t]) continue
			const base = t * 3
			let cq = -1
			for (let k = 0; k < 3; k++) {
				const cc = base + k
				if (cc === c) continue
				if (grp[idx[cc]] === q) {
					cq = cc
					break
				}
			}
			if (cq < 0) continue
			this.edgeTris++
			const vp = idx[c]
			const vq = idx[cq]
			if (this.edgeTris === 1) {
				wp = vp
				wq = vq
			} else if (vp !== wp || vq !== wq) this.edgeSeam = true
		}
		if (this.edgeTris !== 2) this.edgeSeam = true
	}

	/**
	 * Picks the cheaper legal direction for edge (a,b). Both are tried because the legality
	 * rules are asymmetric: an interior vertex may fall onto a seam, never the reverse.
	 */
	private evaluate(a: number, b: number): boolean {
		this.evalOk = false
		this.probeEdge(a, b)
		if (this.edgeTris === 0) return false
		const seamEdge = this.edgeSeam
		const tris = this.edgeTris
		let best = Infinity
		if (this.tryDirection(a, b, seamEdge, tris)) {
			best = this.tryCost
			this.commit(a, b)
		}
		if (this.tryDirection(b, a, seamEdge, tris) && this.tryCost < best) this.commit(b, a)
		return this.evalOk
	}

	private commit(src: number, dst: number): void {
		this.evalOk = true
		this.evalSrc = src
		this.evalDst = dst
		this.evalCost = this.tryCost
		this.evalX = this.tryX
		this.evalY = this.tryY
		this.evalZ = this.tryZ
		this.evalT = this.tryT
	}

	private tryDirection(src: number, dst: number, seamEdge: boolean, tris: number): boolean {
		const ks = this.kind[src]
		const kd = this.kind[dst]
		// A locked vertex is never removed. A seam vertex is only ever removed along its own
		// seam, into another seam vertex — the rule that stops an LOD from dragging a
		// material-zone boundary or a UV island edge sideways and making the texture swim.
		if (ks === KIND_LOCKED) return false
		if (ks === KIND_SEAM) {
			if (kd === KIND_INTERIOR) return false
			if (kd === KIND_SEAM && !seamEdge) return false
		}

		const os = src * 3
		const od = dst * 3
		let x = this.gx[od]
		let y = this.gx[od + 1]
		let z = this.gx[od + 2]
		let t = -1
		if (ks === KIND_INTERIOR && kd === KIND_INTERIOR) {
			const sx = this.gx[os]
			const sy = this.gx[os + 1]
			const sz = this.gx[os + 2]
			const ex = x - sx
			const ey = y - sy
			const ez = z - sz
			const lenSq = ex * ex + ey * ey + ez * ez

			// Four candidates, lowest quadric error wins: the two endpoints, the midpoint, and
			// the solved optimum *clamped into a capsule around the edge*.
			//
			// The clamp is the whole point. On any closed hull the quadric's true minimiser is
			// the apex where the neighbourhood's tangent planes meet, which lies OUTSIDE the
			// surface — 1/cos(cap half-angle) out on a sphere — and scores a genuinely low error
			// there, so no error-based test can reject it. Measuring it against the edge
			// *midpoint* and allowing four edge lengths never rejected anything at all: the apex
			// sits under one edge length out even when it is a 38%-of-radius needle.
			//
			// Distance is taken to the segment, not the midpoint, so sliding along the edge stays
			// free — that is how a feature vertex survives, and it is what feeds `t` below. Only
			// leaving the edge is bounded. Clamping rather than discarding keeps the solve's
			// along-edge information in the cheap case where its perpendicular part is the only
			// unreasonable component.
			this.bestEdgePoint(src, dst, sx, sy, sz, x, y, z, edgePoint)
			x = edgePoint[0]
			y = edgePoint[1]
			z = edgePoint[2]
			if (lenSq > 1e-24 && this.qSolve(src, dst, qSolveOut)) {
				const pt = clamp(((qSolveOut[0] - sx) * ex + (qSolveOut[1] - sy) * ey + (qSolveOut[2] - sz) * ez) / lenSq, 0, 1)
				const ax = sx + ex * pt
				const ay = sy + ey * pt
				const az = sz + ez * pt
				let dx = qSolveOut[0] - ax
				let dy = qSolveOut[1] - ay
				let dz = qSolveOut[2] - az
				const offSq = dx * dx + dy * dy + dz * dz
				const capSq = OPTIMUM_RANGE * OPTIMUM_RANGE * lenSq
				if (offSq > capSq) {
					const k = Math.sqrt(capSq / offSq)
					dx *= k
					dy *= k
					dz *= k
				}
				const ox = ax + dx
				const oy = ay + dy
				const oz = az + dz
				if (this.qErr(src, dst, ox, oy, oz) < this.qErr(src, dst, x, y, z)) {
					x = ox
					y = oy
					z = oz
				}
			}
			t = lenSq > 1e-24 ? clamp(((x - sx) * ex + (y - sy) * ey + (z - sz) * ez) / lenSq, 0, 1) : 1
		}

		if (!this.zonesCovered(src, dst)) return false
		if (this.violatesLink(src, dst, tris)) return false
		if (this.wouldFlip(src, dst, x, y, z)) return false
		this.tryCost = this.qErr(src, dst, x, y, z)
		this.tryX = x
		this.tryY = y
		this.tryZ = z
		this.tryT = t
		return true
	}

	/**
	 * Every material zone present at `src` must also be present at `dst`.
	 *
	 * A removed wedge folds into a surviving wedge of the destination, and if no surviving
	 * wedge carries its zone it is forced into a foreign one — which repaints that triangle
	 * a level down the chain. The seam classification alone does not catch this: a vertex
	 * where three zones meet is a legal seam-to-seam collapse by topology and still has
	 * nowhere to put its third zone.
	 */
	private zonesCovered(src: number, dst: number): boolean {
		const idx = this.mesh.indices
		const zn = this.mesh.materialZone
		// Stamped rather than cleared: this runs on both directions of every candidate edge,
		// so an O(valence) pass with an O(1) reset is worth the 256-entry table.
		if (this.zoneGen > 0x3fffffff) {
			this.zoneStamp.fill(0)
			this.zoneGen = 0
		}
		const gen = ++this.zoneGen
		for (let d = this.gHead[dst]; d >= 0; d = this.cornerNext[d]) {
			if (this.triDead[(d / 3) | 0]) continue
			this.zoneStamp[zn[idx[d]]] = gen
		}
		for (let c = this.gHead[src]; c >= 0; c = this.cornerNext[c]) {
			if (this.triDead[(c / 3) | 0]) continue
			if (this.zoneStamp[zn[idx[c]]] !== gen) return false
		}
		return true
	}

	/**
	 * The link condition. Two vertices may only be merged if their one-rings meet exactly on
	 * the faces of the edge itself; any extra shared neighbour becomes a folded-over fin
	 * that no amount of error metric will make look right.
	 */
	private violatesLink(p: number, q: number, tris: number): boolean {
		const markA = ++this.stampGen
		const markB = ++this.stampGen
		this.stampNeighbours(p, markA)
		let shared = 0
		const idx = this.mesh.indices
		const grp = this.group
		for (let c = this.gHead[q]; c >= 0; c = this.cornerNext[c]) {
			const t = (c / 3) | 0
			if (this.triDead[t]) continue
			const base = t * 3
			for (let k = 0; k < 3; k++) {
				const g = grp[idx[base + k]]
				if (g === q || g === p) continue
				if (this.stamp[g] === markA) {
					this.stamp[g] = markB
					shared++
				}
			}
		}
		return shared > tris
	}

	private stampNeighbours(p: number, mark: number): void {
		const idx = this.mesh.indices
		const grp = this.group
		for (let c = this.gHead[p]; c >= 0; c = this.cornerNext[c]) {
			const t = (c / 3) | 0
			if (this.triDead[t]) continue
			const base = t * 3
			for (let k = 0; k < 3; k++) {
				const g = grp[idx[base + k]]
				if (g !== p) this.stamp[g] = mark
			}
		}
	}

	private wouldFlip(src: number, dst: number, nx: number, ny: number, nz: number): boolean {
		return this.flipCheck(src, src, dst, nx, ny, nz) || this.flipCheck(dst, src, dst, nx, ny, nz)
	}

	private flipCheck(g: number, src: number, dst: number, nx: number, ny: number, nz: number): boolean {
		const idx = this.mesh.indices
		const grp = this.group
		const gxp = this.gx
		for (let c = this.gHead[g]; c >= 0; c = this.cornerNext[c]) {
			const t = (c / 3) | 0
			if (this.triDead[t]) continue
			const base = t * 3
			const o0 = grp[idx[base]]
			const o1 = grp[idx[base + 1]]
			const o2 = grp[idx[base + 2]]
			const r0 = o0 === src ? dst : o0
			const r1 = o1 === src ? dst : o1
			const r2 = o2 === src ? dst : o2
			if (r0 === r1 || r1 === r2 || r0 === r2) continue // dies in the collapse
			const ax = gxp[o0 * 3]
			const ay = gxp[o0 * 3 + 1]
			const az = gxp[o0 * 3 + 2]
			const bx = gxp[o1 * 3]
			const by = gxp[o1 * 3 + 1]
			const bz = gxp[o1 * 3 + 2]
			const cx = gxp[o2 * 3]
			const cy = gxp[o2 * 3 + 1]
			const cz = gxp[o2 * 3 + 2]
			const oldx = (by - ay) * (cz - az) - (bz - az) * (cy - ay)
			const oldy = (bz - az) * (cx - ax) - (bx - ax) * (cz - az)
			const oldz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
			const nax = r0 === dst ? nx : gxp[r0 * 3]
			const nay = r0 === dst ? ny : gxp[r0 * 3 + 1]
			const naz = r0 === dst ? nz : gxp[r0 * 3 + 2]
			const nbx = r1 === dst ? nx : gxp[r1 * 3]
			const nby = r1 === dst ? ny : gxp[r1 * 3 + 1]
			const nbz = r1 === dst ? nz : gxp[r1 * 3 + 2]
			const ncx = r2 === dst ? nx : gxp[r2 * 3]
			const ncy = r2 === dst ? ny : gxp[r2 * 3 + 1]
			const ncz = r2 === dst ? nz : gxp[r2 * 3 + 2]
			const newx = (nby - nay) * (ncz - naz) - (nbz - naz) * (ncy - nay)
			const newy = (nbz - naz) * (ncx - nax) - (nbx - nax) * (ncz - naz)
			const newz = (nbx - nax) * (ncy - nay) - (nby - nay) * (ncx - nax)
			const lo = Math.sqrt(oldx * oldx + oldy * oldy + oldz * oldz)
			const ln = Math.sqrt(newx * newx + newy * newy + newz * newz)
			if (!(lo > 1e-24)) continue // was already degenerate; nothing to preserve
			if (!(ln > 1e-24)) return true
			if ((oldx * newx + oldy * newy + oldz * newz) / (lo * ln) < FLIP_MIN) return true
		}
		return false
	}

	// -----------------------------------------------------------------------
	// Collapse
	// -----------------------------------------------------------------------

	private collapse(src: number, dst: number, nx: number, ny: number, nz: number, t: number): void {
		const mesh = this.mesh
		const idx = mesh.indices

		const dstCount = this.collectWedges(dst, this.dstWedge)
		const srcCount = this.collectWedges(src, this.srcWedge)
		if (this.mapWedge.length < srcCount) this.mapWedge = new Int32Array(nextPow2(srcCount))
		for (let i = 0; i < srcCount; i++) this.mapWedge[i] = this.bestWedge(this.srcWedge[i], this.dstWedge, dstCount)

		// Attributes are blended only in the one unambiguous case: a single wedge either
		// side, both interior. Everywhere else the surviving wedge keeps its own attributes
		// exactly — blending across a seam is what produces the swimming this whole
		// classification exists to prevent.
		if (t >= 0 && srcCount === 1 && dstCount === 1) blendVertex(mesh, this.srcWedge[0], this.dstWedge[0], t)

		const o = dst * 3
		this.gx[o] = nx
		this.gx[o + 1] = ny
		this.gx[o + 2] = nz
		for (let i = 0; i < dstCount; i++) mesh.setPosition(this.dstWedge[i], nx, ny, nz)

		const qs = src * 10
		const qd = dst * 10
		for (let i = 0; i < 10; i++) this.quad[qd + i] += this.quad[qs + i]

		const grp = this.group
		for (let c = this.gHead[src]; c >= 0; c = this.cornerNext[c]) {
			const tri = (c / 3) | 0
			if (this.triDead[tri]) continue
			const v = idx[c]
			for (let i = 0; i < srcCount; i++) {
				if (this.srcWedge[i] === v) {
					idx[c] = this.mapWedge[i]
					break
				}
			}
			const base = tri * 3
			const g0 = grp[idx[base]]
			const g1 = grp[idx[base + 1]]
			const g2 = grp[idx[base + 2]]
			if (g0 === g1 || g1 === g2 || g0 === g2) {
				this.triDead[tri] = 1
				this.liveTris--
			}
		}

		// Splice src's corner list onto dst's; dead corners are pruned lazily on the next
		// walk, which keeps the collapse itself O(valence).
		const head = this.gHead[src]
		if (head >= 0) {
			if (this.gTail[dst] < 0) this.gHead[dst] = head
			else this.cornerNext[this.gTail[dst]] = head
			this.gTail[dst] = this.gTail[src]
		}
		this.gHead[src] = -1
		this.gTail[src] = -1
		this.dead[src] = 1
		this.version[src]++
		this.version[dst]++
		this.pruneList(dst)
	}

	/** Distinct vertices (wedges) referenced by a group's live corners. */
	private collectWedges(g: number, out: Int32Array): number {
		const idx = this.mesh.indices
		let n = 0
		for (let c = this.gHead[g]; c >= 0; c = this.cornerNext[c]) {
			const t = (c / 3) | 0
			if (this.triDead[t]) continue
			const v = idx[c]
			let seen = false
			for (let i = 0; i < n; i++) {
				if (out[i] === v) {
					seen = true
					break
				}
			}
			if (seen) continue
			if (n >= out.length) {
				const bigger = new Int32Array(out.length * 2)
				bigger.set(out)
				if (out === this.srcWedge) this.srcWedge = bigger
				else this.dstWedge = bigger
				out = bigger
			}
			out[n++] = v
		}
		return n
	}

	/**
	 * The surviving wedge a removed wedge folds into. The zone term dominates absolutely:
	 * a vertex must never change material zone, or the LOD repaints a panel.
	 */
	private bestWedge(v: number, candidates: Int32Array, count: number): number {
		if (count === 0) return v
		const mesh = this.mesh
		let best = candidates[0]
		let bestD = Infinity
		const uo = v * 2
		const no = v * 3
		for (let i = 0; i < count; i++) {
			const c = candidates[i]
			const co = c * 2
			const du = mesh.uv0[co] - mesh.uv0[uo]
			const dv = mesh.uv0[co + 1] - mesh.uv0[uo + 1]
			const cn = c * 3
			const dot =
				mesh.normals[cn] * mesh.normals[no] +
				mesh.normals[cn + 1] * mesh.normals[no + 1] +
				mesh.normals[cn + 2] * mesh.normals[no + 2]
			let d = du * du + dv * dv + (1 - dot) * 0.1
			if (mesh.materialZone[c] !== mesh.materialZone[v]) d += 1e6
			if (d < bestD) {
				bestD = d
				best = c
			}
		}
		return best
	}

	private pruneList(g: number): void {
		let prev = -1
		let c = this.gHead[g]
		while (c >= 0) {
			const nx = this.cornerNext[c]
			if (this.triDead[(c / 3) | 0]) {
				if (prev < 0) this.gHead[g] = nx
				else this.cornerNext[prev] = nx
				if (this.gTail[g] === c) this.gTail[g] = prev
			} else prev = c
			c = nx
		}
		if (this.gHead[g] < 0) this.gTail[g] = -1
	}

	/** Re-costs every edge on `g`, whose version bump invalidated all their heap entries. */
	private pushIncident(g: number): void {
		const idx = this.mesh.indices
		const grp = this.group
		const mark = ++this.stampGen
		let n = 0
		for (let c = this.gHead[g]; c >= 0; c = this.cornerNext[c]) {
			const t = (c / 3) | 0
			if (this.triDead[t]) continue
			const base = t * 3
			for (let k = 0; k < 3; k++) {
				const k2 = grp[idx[base + k]]
				if (k2 === g || this.dead[k2]) continue
				if (this.stamp[k2] === mark) continue
				this.stamp[k2] = mark
				if (n >= this.nbr.length) {
					const bigger = new Int32Array(this.nbr.length * 2)
					bigger.set(this.nbr)
					this.nbr = bigger
				}
				this.nbr[n++] = k2
			}
		}
		for (let i = 0; i < n; i++) {
			const k = this.nbr[i]
			if (this.evaluate(g, k)) this.heapPush(this.evalCost, g, k, this.version[g], this.version[k])
		}
	}

	// -----------------------------------------------------------------------
	// Output
	// -----------------------------------------------------------------------

	private rebuild(): void {
		const mesh = this.mesh
		const idx = mesh.indices
		let w = 0
		for (let t = 0; t < mesh.triangleCount; t++) {
			if (this.triDead[t]) continue
			const o = t * 3
			const q = w * 3
			idx[q] = idx[o]
			idx[q + 1] = idx[o + 1]
			idx[q + 2] = idx[o + 2]
			w++
		}
		mesh.triangleCount = w

		const count = w * 3
		const used = new Int32Array(mesh.vertexCount).fill(-1)
		for (let i = 0; i < count; i++) used[idx[i]] = 0
		// Renumbered in ascending old-index order, not first-reference order: that keeps
		// newIndex <= oldIndex for every surviving vertex, which is what makes the in-place
		// compaction below safe. It is also stable, so baseline.mjs sees identical bytes.
		let n = 0
		for (let v = 0; v < mesh.vertexCount; v++) if (used[v] === 0) used[v] = n++
		for (let i = 0; i < count; i++) idx[i] = used[idx[i]]
		for (let v = 0; v < mesh.vertexCount; v++) {
			const d = used[v]
			if (d >= 0 && d !== v) copyVertex(mesh, v, d)
		}
		mesh.vertexCount = n
		mesh.invalidateBounds()
	}

	// -----------------------------------------------------------------------
	// Heap — min by (cost, u, v). The index tie-break is what makes two runs identical.
	// -----------------------------------------------------------------------

	private heapPush(cost: number, u: number, v: number, vu: number, vv: number): void {
		if (this.hSize >= this.hCost.length) this.growHeap()
		let i = this.hSize++
		this.hCost[i] = cost
		this.hU[i] = u
		this.hV[i] = v
		this.hVU[i] = vu
		this.hVV[i] = vv
		while (i > 0) {
			const p = (i - 1) >> 1
			if (!this.less(i, p)) break
			this.swap(i, p)
			i = p
		}
	}

	private heapPop(): void {
		const last = --this.hSize
		if (last <= 0) return
		this.swap(0, last)
		let i = 0
		for (;;) {
			const l = i * 2 + 1
			const r = l + 1
			let s = i
			if (l < this.hSize && this.less(l, s)) s = l
			if (r < this.hSize && this.less(r, s)) s = r
			if (s === i) break
			this.swap(i, s)
			i = s
		}
	}

	private less(i: number, j: number): boolean {
		const a = this.hCost[i]
		const b = this.hCost[j]
		if (a !== b) return a < b
		if (this.hU[i] !== this.hU[j]) return this.hU[i] < this.hU[j]
		return this.hV[i] < this.hV[j]
	}

	private swap(i: number, j: number): void {
		let t = this.hCost[i]
		this.hCost[i] = this.hCost[j]
		this.hCost[j] = t
		t = this.hU[i]
		this.hU[i] = this.hU[j]
		this.hU[j] = t
		t = this.hV[i]
		this.hV[i] = this.hV[j]
		this.hV[j] = t
		t = this.hVU[i]
		this.hVU[i] = this.hVU[j]
		this.hVU[j] = t
		t = this.hVV[i]
		this.hVV[i] = this.hVV[j]
		this.hVV[j] = t
	}

	private growHeap(): void {
		const cap = this.hCost.length * 2
		const c = new Float64Array(cap)
		c.set(this.hCost)
		this.hCost = c
		const u = new Int32Array(cap)
		u.set(this.hU)
		this.hU = u
		const v = new Int32Array(cap)
		v.set(this.hV)
		this.hV = v
		const a = new Int32Array(cap)
		a.set(this.hVU)
		this.hVU = a
		const b = new Int32Array(cap)
		b.set(this.hVV)
		this.hVV = b
	}
}

/** Solve output. Module-level so the inner loop never allocates (rule 6). */
const qSolveOut = new Float64Array(3)

/** Fallback collapse point. Module-level for the same reason. */
const edgePoint = new Float64Array(3)

/** The six axis-extreme vertex indices the Ritter seed pair is chosen from. */
const ritterSeed = new Int32Array(6)

function edgeHash(a: number, b: number): number {
	return (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca6b)) >>> 0
}

/** The vertex triangle `t` (corner base) uses at group `g`, or -1. */
function wedgeAt(idx: Uint32Array, group: Int32Array, t: number, g: number): number {
	if (group[idx[t]] === g) return idx[t]
	if (group[idx[t + 1]] === g) return idx[t + 1]
	if (group[idx[t + 2]] === g) return idx[t + 2]
	return -1
}

/** Moves `dst`'s attributes to the point `t` of the way from `src` to `dst`. */
function blendVertex(mesh: Mesh, src: number, dst: number, t: number): void {
	const s2 = src * 2
	const d2 = dst * 2
	mesh.uv0[d2] = lerp(mesh.uv0[s2], mesh.uv0[d2], t)
	mesh.uv0[d2 + 1] = lerp(mesh.uv0[s2 + 1], mesh.uv0[d2 + 1], t)
	mesh.uv1[d2] = lerp(mesh.uv1[s2], mesh.uv1[d2], t)
	mesh.uv1[d2 + 1] = lerp(mesh.uv1[s2 + 1], mesh.uv1[d2 + 1], t)
	const s3 = src * 3
	const d3 = dst * 3
	const nx = lerp(mesh.normals[s3], mesh.normals[d3], t)
	const ny = lerp(mesh.normals[s3 + 1], mesh.normals[d3 + 1], t)
	const nz = lerp(mesh.normals[s3 + 2], mesh.normals[d3 + 2], t)
	const l = Math.sqrt(nx * nx + ny * ny + nz * nz)
	if (l > 1e-12) {
		// Normals are interpolated, never recomputed from the decimated geometry: recomputing
		// changes the shading between LOD levels and the switch becomes visible as a flicker.
		mesh.normals[d3] = nx / l
		mesh.normals[d3 + 1] = ny / l
		mesh.normals[d3 + 2] = nz / l
	}
	const s4 = src * 4
	const d4 = dst * 4
	const tx = lerp(mesh.tangents[s4], mesh.tangents[d4], t)
	const ty = lerp(mesh.tangents[s4 + 1], mesh.tangents[d4 + 1], t)
	const tz = lerp(mesh.tangents[s4 + 2], mesh.tangents[d4 + 2], t)
	const tl = Math.sqrt(tx * tx + ty * ty + tz * tz)
	if (tl > 1e-12) {
		mesh.tangents[d4] = tx / tl
		mesh.tangents[d4 + 1] = ty / tl
		mesh.tangents[d4 + 2] = tz / tl
	}
	// zone and skin are indices, not quantities: blending them is meaningless, so the
	// survivor keeps its own. A vertex changing bone mid-chain would pop under animation.
}
