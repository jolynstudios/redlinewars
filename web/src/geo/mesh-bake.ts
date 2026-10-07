// STEELSEED — geo/mesh-bake
// Versioned, deterministic binary boundary for one offline-forged procedural mesh.
// The repository keeps the generator; ignored build output may carry this representation.

import { Mesh } from './mesh'

const MAGIC = 0x464d5353 // 'SSMF' little-endian
const VERSION = 1
const HEADER_BYTES = 32
const FLAG_SKINNED = 1 << 0

export interface MeshBakeInfo {
	readonly version: number
	readonly bytes: number
	readonly checksum: number
	readonly vertices: number
	readonly triangles: number
	readonly skinned: boolean
}

export function encodeMeshBake(mesh: Mesh): Uint8Array {
	const vertices = mesh.vertexCount
	const triangles = mesh.triangleCount
	const skinned = mesh.skinned
	const zoneBytes = align4(vertices)
	const payloadBytes =
		vertices * (3 + 3 + 4 + 2 + 2) * 4 +
		zoneBytes +
		(skinned ? vertices * 4 + vertices * 4 * 4 : 0) +
		triangles * 3 * 4
	const out = new Uint8Array(HEADER_BYTES + payloadBytes)
	const view = new DataView(out.buffer)
	view.setUint32(0, MAGIC, true)
	view.setUint16(4, VERSION, true)
	view.setUint16(6, skinned ? FLAG_SKINNED : 0, true)
	view.setUint32(8, vertices, true)
	view.setUint32(12, triangles, true)
	view.setUint32(16, payloadBytes, true)
	view.setUint32(28, HEADER_BYTES, true)
	let offset = HEADER_BYTES
	offset = copyF32(out, offset, mesh.positions, vertices * 3)
	offset = copyF32(out, offset, mesh.normals, vertices * 3)
	offset = copyF32(out, offset, mesh.tangents, vertices * 4)
	offset = copyF32(out, offset, mesh.uv0, vertices * 2)
	offset = copyF32(out, offset, mesh.uv1, vertices * 2)
	out.set(mesh.materialZone.subarray(0, vertices), offset)
	offset += zoneBytes
	if (skinned) {
		out.set(mesh.skinIndices!.subarray(0, vertices * 4), offset)
		offset += vertices * 4
		offset = copyF32(out, offset, mesh.skinWeights!, vertices * 4)
	}
	out.set(new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, triangles * 3 * 4), offset)
	if (offset + triangles * 3 * 4 !== out.byteLength)
		throw new Error('mesh bake size accounting diverged')
	view.setUint32(20, fnv1a(out, HEADER_BYTES), true)
	return out
}

export function decodeMeshBake(bytes: Uint8Array): { mesh: Mesh; info: MeshBakeInfo } {
	if (bytes.byteLength < HEADER_BYTES) throw new Error('mesh bake is shorter than its header')
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	if (view.getUint32(0, true) !== MAGIC) throw new Error('mesh bake magic mismatch')
	const version = view.getUint16(4, true)
	if (version !== VERSION) throw new Error(`mesh bake version ${version} is unsupported`)
	const flags = view.getUint16(6, true)
	if ((flags & ~FLAG_SKINNED) !== 0) throw new Error(`mesh bake has unknown flags ${flags}`)
	const vertices = view.getUint32(8, true)
	const triangles = view.getUint32(12, true)
	const payloadBytes = view.getUint32(16, true)
	const checksum = view.getUint32(20, true)
	if (view.getUint32(28, true) !== HEADER_BYTES) throw new Error('mesh bake header size mismatch')
	if (HEADER_BYTES + payloadBytes !== bytes.byteLength) throw new Error('mesh bake payload size mismatch')
	if (fnv1a(bytes, HEADER_BYTES) !== checksum) throw new Error('mesh bake checksum mismatch')
	const skinned = (flags & FLAG_SKINNED) !== 0
	const mesh = new Mesh()
	let offset = HEADER_BYTES
	;[mesh.positions, offset] = readF32(bytes, offset, vertices * 3)
	;[mesh.normals, offset] = readF32(bytes, offset, vertices * 3)
	;[mesh.tangents, offset] = readF32(bytes, offset, vertices * 4)
	;[mesh.uv0, offset] = readF32(bytes, offset, vertices * 2)
	;[mesh.uv1, offset] = readF32(bytes, offset, vertices * 2)
	mesh.materialZone = bytes.subarray(offset, offset + vertices)
	offset += align4(vertices)
	if (skinned) {
		mesh.skinIndices = bytes.subarray(offset, offset + vertices * 4)
		offset += vertices * 4
		;[mesh.skinWeights, offset] = readF32(bytes, offset, vertices * 4)
	}
	mesh.indices = new Uint32Array(bytes.buffer, bytes.byteOffset + offset, triangles * 3)
	offset += triangles * 3 * 4
	if (offset !== bytes.byteLength) throw new Error('mesh bake decoder did not claim the whole payload')
	mesh.vertexCount = vertices
	mesh.triangleCount = triangles
	mesh.invalidateBounds()
	return {
		mesh,
		info: { version, bytes: bytes.byteLength, checksum, vertices, triangles, skinned },
	}
}

function copyF32(out: Uint8Array, offset: number, source: Float32Array, count: number): number {
	out.set(new Uint8Array(source.buffer, source.byteOffset, count * 4), offset)
	return offset + count * 4
}

function readF32(bytes: Uint8Array, offset: number, count: number): [Float32Array, number] {
	return [new Float32Array(bytes.buffer, bytes.byteOffset + offset, count), offset + count * 4]
}

function fnv1a(bytes: Uint8Array, from: number): number {
	let hash = 2166136261
	for (let i = from; i < bytes.length; i++) {
		hash ^= bytes[i]
		hash = Math.imul(hash, 16777619)
	}
	return hash >>> 0
}

function align4(value: number): number {
	return (value + 3) & ~3
}
