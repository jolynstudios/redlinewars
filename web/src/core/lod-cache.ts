// STEELSEED — core/lod-cache
//
// Boot-time LOD cache. The QEM decimator that builds each roster slot's LOD1/LOD2
// costs ~12 s of main-thread CPU at boot (CDP profile: flipCheck 5.9 s +
// violatesLink 2.1 s + decimator internals dominate the hull build), and its
// output is a pure function of the base mesh. This module persists that output
// per slot in IndexedDB (native structured clone of typed arrays) keyed by a
// digest over every input the generation reads: the forge manifest's per-asset
// source and baked-bytes hashes, the roster slot list, a quantized geometry
// digest for slots whose base mesh is generated procedurally rather than
// decoded from an asset, and a format version for code changes.
//
// Risk containment: only the decimated LOD levels are cached - never the base
// mesh, rigs, authored pack LODs (uploadLods path) or any runtime state. A
// cache hit reconstructs plain Mesh objects that go through the same
// uploadLods validation as a fresh build, and a per-slot sanity mismatch falls
// back to generating that slot from scratch. An empty or corrupt store costs a
// normal first boot.

import type { Mesh } from '../geo/mesh'
import { Mesh as MeshClass } from '../geo/mesh'

/**
 * Bump when anything that changes decimator output changes: the Decimator
 * itself, generateLodChain ratios, channel semantics, or this serialization.
 *
 * 2: generateLodChain repairs shading normals the decimator turned away from
 * their faces (Mesh.repairShadingNormals). Format-1 chains carry the dark,
 * oval-reading thin panels, so every browser must rebuild them once.
 */
const FORMAT_VERSION = 2
const DB_NAME = 'steelseed-lod-cache'
const STORE = 'bundles'
const KEY = 'roster'

export interface LodBundle {
	digest: string
	/** slot name -> serialized LOD1+LOD2 (index 0 = LOD1, 1 = LOD2) */
	slots: Record<string, SerializedMesh[]>
}

export interface SerializedMesh {
	vertexCount: number
	triangleCount: number
	positions: Float32Array
	normals: Float32Array
	tangents: Float32Array
	uv0: Float32Array
	uv1: Float32Array
	materialZone: Uint8Array
	indices: Uint32Array
	skinIndices: Uint8Array | null
	skinWeights: Float32Array | null
}

export function serializeMesh(mesh: Mesh): SerializedMesh {
	const n = mesh.vertexCount
	return {
		vertexCount: n,
		triangleCount: mesh.triangleCount,
		positions: mesh.positions.slice(0, n * 3),
		normals: mesh.normals.slice(0, n * 3),
		tangents: mesh.tangents.slice(0, n * 4),
		uv0: mesh.uv0.slice(0, n * 2),
		uv1: mesh.uv1.slice(0, n * 2),
		materialZone: mesh.materialZone.slice(0, n),
		indices: mesh.indices.slice(0, mesh.triangleCount * 3),
		skinIndices: mesh.skinIndices ? mesh.skinIndices.slice(0, n * 4) : null,
		skinWeights: mesh.skinWeights ? mesh.skinWeights.slice(0, n * 4) : null,
	}
}

export function deserializeMesh(data: SerializedMesh): Mesh | null {
	// Sanity gate: a stale or corrupt entry must never reach the renderer.
	const n = data.vertexCount, t = data.triangleCount
	if (!Number.isSafeInteger(n) || n < 3 || !Number.isSafeInteger(t) || t < 1) return null
	const lengths: [ArrayLike<number> | undefined, number][] = [
		[data.positions, n * 3], [data.normals, n * 3], [data.tangents, n * 4],
		[data.uv0, n * 2], [data.uv1, n * 2], [data.materialZone, n], [data.indices, t * 3],
	]
	for (const [array, want] of lengths)
		if (!(array instanceof Float32Array || array instanceof Uint8Array || array instanceof Uint32Array) || array.length < want)
			return null
	const mesh = new MeshClass(n, t)
	mesh.positions.set(data.positions.subarray(0, n * 3))
	mesh.normals.set(data.normals.subarray(0, n * 3))
	mesh.tangents.set(data.tangents.subarray(0, n * 4))
	mesh.uv0.set(data.uv0.subarray(0, n * 2))
	mesh.uv1.set(data.uv1.subarray(0, n * 2))
	mesh.materialZone.set(data.materialZone.subarray(0, n))
	mesh.indices.set(data.indices.subarray(0, t * 3))
	if (data.skinIndices instanceof Uint8Array && data.skinWeights instanceof Float32Array &&
		data.skinIndices.length >= n * 4 && data.skinWeights.length >= n * 4) {
		mesh.reserve(n, t)
		mesh.skinIndices = data.skinIndices.slice(0, n * 4)
		mesh.skinWeights = data.skinWeights.slice(0, n * 4)
	}
	mesh.vertexCount = n
	mesh.triangleCount = t
	mesh.updateBounds()
	return mesh
}

/**
 * Quantized geometry digest of a base mesh - the cache input for slots with no
 * forge asset, whose geometry is produced by code instead of an authored file.
 * Feeding only the slot name let a generator change ship while every browser
 * kept serving LOD chains decimated from the geometry it replaced (the square
 * wall plates reading as circles at distance is exactly this hole). Values are
 * quantized - positions to the millimetre, normals to 2^-9, UVs and weights to
 * 2^-10 - so last-ulp float wobble cannot invalidate a chain, while any real
 * generator edit lands far outside the quantum and rolls the digest.
 */
export function meshDigest(mesh: Mesh): string {
	let hash = 0x811c9dc5
	const byte = (v: number) => { hash ^= v & 0xff; hash = Math.imul(hash, 0x01000193) >>> 0 }
	const word = (v: number) => { byte(v); byte(v >>> 8); byte(v >>> 16); byte(v >>> 24) }
	const quantized = (values: Float32Array, count: number, scale: number) => {
		for (let i = 0; i < count; i++) word(Math.round(values[i] * scale))
	}
	word(mesh.vertexCount)
	word(mesh.triangleCount)
	quantized(mesh.positions, mesh.vertexCount * 3, 1024)
	quantized(mesh.normals, mesh.vertexCount * 3, 512)
	quantized(mesh.uv0, mesh.vertexCount * 2, 1024)
	quantized(mesh.uv1, mesh.vertexCount * 2, 1024)
	for (let i = 0; i < mesh.vertexCount; i++) word(mesh.materialZone[i])
	for (let i = 0; i < mesh.triangleCount * 3; i++) word(mesh.indices[i])
	if (mesh.skinIndices && mesh.skinWeights) {
		word(1)
		for (let i = 0; i < mesh.vertexCount * 4; i++) word(mesh.skinIndices[i])
		quantized(mesh.skinWeights, mesh.vertexCount * 4, 1024)
	} else {
		word(0)
	}
	return hash.toString(16)
}

/**
 * Digest over every decimator input: asset identity per slot, procedural base geometry, roster order, format.
 * A forge asset is identified by its source hash AND the hash of its baked bytes: a re-bake of an unchanged
 * .blend (exporter or generator change) is new geometry to decimate, and the byte count alone would only
 * notice it by luck.
 */
export function lodDigest(
	manifestAssets: Record<string, { sourceSha256?: string; sha256?: string; bytes?: number } | undefined>,
	slotNames: readonly string[],
	proceduralMeshes?: ReadonlyMap<string, Mesh>,
): string {
	let hash = 0x811c9dc5
	const feed = (text: string) => {
		for (let i = 0; i < text.length; i++) {
			hash ^= text.charCodeAt(i)
			hash = Math.imul(hash, 0x01000193) >>> 0
		}
	}
	feed(`v${FORMAT_VERSION}`)
	for (const name of [...slotNames].sort()) {
		const asset = manifestAssets[name]
		const procedural = proceduralMeshes?.get(name)
		feed(`${name}:${asset?.sourceSha256 ?? ''}:${asset?.sha256 ?? ''}:${asset?.bytes ?? 0}:${procedural ? meshDigest(procedural) : ''}`)
	}
	return hash.toString(16)
}

// Executor form: the project lib target (ES2022) predates Promise.withResolvers.
function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1)
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
		}
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error)
	})
}

export async function readLodBundle(digest: string): Promise<Record<string, SerializedMesh[]> | null> {
	try {
		const db = await openDb()
		try {
			const value = await new Promise<LodBundle | undefined>((resolve, reject) => {
				const tx = db.transaction(STORE, 'readonly')
				const request = tx.objectStore(STORE).get(KEY)
				request.onsuccess = () => resolve(request.result)
				request.onerror = () => reject(request.error)
			})
			if (!value || value.digest !== digest) return null
			return value.slots
		} finally {
			db.close()
		}
	} catch {
		return null // private mode, quota, corruption: a normal first boot
	}
}

export function writeLodBundle(digest: string, slots: Record<string, SerializedMesh[]>): void {
	// Fire and forget: writing must never block or fail boot.
	openDb().then(db => new Promise<void>((resolve, reject) => {
		const tx = db.transaction(STORE, 'readwrite')
		tx.objectStore(STORE).put({ digest, slots } satisfies LodBundle, KEY)
		tx.oncomplete = () => resolve()
		tx.onerror = () => reject(tx.error)
	}).then(() => db.close()).catch(() => db.close())).catch(() => {})
}
