// STEELSEED — render/gpumesh
// Mesh upload. A geo Mesh becomes one interleaved vertex buffer and one index buffer.
//
// Interleaved rather than one buffer per attribute because every draw here reads the
// whole vertex — split streams cost a cache line per attribute instead of one per vertex.
// The interleaving itself belongs to geo/mesh (`toGPUBuffers`), so the stride, the
// attribute offsets and the shader locations have exactly one definition project-wide.
import { vec3 } from '../core'
import { ZONE_BYTE_OFFSET } from '../geo/mesh'
import { hasFoamCoverage, markFoamCoverage, packFoamCoverage } from '../geo/foam-coverage'
import { hasGroundMarkCoverage, markGroundMarkCoverage, packGroundMarkCoverage } from '../geo/mark-coverage'
import { packWindowGeometry, type WindowGeometry } from './window-occupancy'
import { trackTags } from '../core/track-metadata'
import type { GpuMeshHandle, GpuMeshLevel } from './types'

type GeoMesh = import('../geo/mesh').Mesh

/** Static stride from geo/mesh. Anything else is the skinned layout. */
export const STRIDE_STATIC = 28
export const STRIDE_SKINNED = 36

/** Full detail plus 50% and 25% QEM levels, each simplified from the original. */
const LOD_LEVELS = 3
const LOD_FALLOFF = 0.5

/**
 * Vertex layouts, one per stride. Both expose the same six attributes: skin indices and
 * weights live in the extra 8 bytes of the skinned stride and are simply not read, because
 * DrawItem carries no bone stream yet (see the note in renderer.ts). Declaring them and
 * ignoring them would compile a second shader permutation for nothing.
 */
export function vertexLayout(stride: number): GPUVertexBufferLayout {
	return {
		arrayStride: stride,
		stepMode: 'vertex',
		attributes: [
			{ format: 'float16x4', offset: 0, shaderLocation: 0 },
			// Quantized channels: f16 positions, snorm8 octahedral normals/tangents, unorm16
			// UVs. The WGSL side decodes with octDecode; see geo/mesh toGPUBuffers.
			{ format: 'snorm8x2', offset: 8, shaderLocation: 1 },
			{ format: 'snorm8x4', offset: 12, shaderLocation: 2 },
			{ format: 'unorm16x2', offset: 16, shaderLocation: 3 },
			{ format: 'unorm16x2', offset: 20, shaderLocation: 4 },
			{ format: 'uint8x4', offset: 24, shaderLocation: 5 },
			...(stride >= STRIDE_SKINNED
				? [
					// The skin channels ride the widened stride.
					{ format: 'uint8x4', offset: 28, shaderLocation: 6 } as GPUVertexAttribute,
					{ format: 'unorm8x4', offset: 32, shaderLocation: 7 } as GPUVertexAttribute,
				]
				: []),
		],
	}
}

/**
 * Depth-only with authored deformation tags and skin channels. The small zone fetch lets
 * shadow casters use the exact circulating-link path while retaining the compact layout.
 */
export function positionSkinLayout(stride: number): GPUVertexBufferLayout {
	return {
		arrayStride: stride,
		stepMode: 'vertex',
		attributes: [
			{ format: 'float16x4', offset: 0, shaderLocation: 0 },
			{ format: 'uint8x4', offset: 24, shaderLocation: 5 },
			{ format: 'uint8x4', offset: 28, shaderLocation: 6 },
			{ format: 'unorm8x4', offset: 32, shaderLocation: 7 },
		],
	}
}

/** Depth-only layout: position and the four source deformation-tag bytes. */
export function positionLayout(stride: number): GPUVertexBufferLayout {
	return {
		arrayStride: stride,
		attributes: [{ format: 'float16x4', offset: 0, shaderLocation: 0 }, { format: 'uint8x4', offset: 24, shaderLocation: 5 }],
	}
}


/**
 * Terrain's own hand-packed layout (terrain/chunks writes it): float32 normals/tangents/
 * UVs and the zone word at byte 56. Unit and scenery meshes went quantized; terrain UVs
 * tile in world metres and its blend weights can leave [0,1], so it keeps float32. The
 * renderer pairs these layouts with the *_TERRAIN_WGSL module variants.
 */
export const TERRAIN_STRIDE = 60

export function terrainVertexLayout(): GPUVertexBufferLayout {
	return {
		arrayStride: TERRAIN_STRIDE,
		stepMode: 'vertex',
		attributes: [
			{ format: 'float32x3', offset: 0, shaderLocation: 0 },
			{ format: 'float32x3', offset: 12, shaderLocation: 1 },
			{ format: 'float32x4', offset: 24, shaderLocation: 2 },
			{ format: 'float32x2', offset: 40, shaderLocation: 3 },
			{ format: 'float32x2', offset: 48, shaderLocation: 4 },
			{ format: 'uint8x4', offset: 56, shaderLocation: 5 },
		],
	}
}

/** Terrain depth-only layout: position and the zone word at the terrain offsets. */
export function terrainPositionLayout(): GPUVertexBufferLayout {
	return {
		arrayStride: TERRAIN_STRIDE,
		stepMode: 'vertex',
		attributes: [{ format: 'float32x3', offset: 0, shaderLocation: 0 }, { format: 'uint8x4', offset: 56, shaderLocation: 5 }],
	}
}
export class MeshStore {
	private readonly device: GPUDevice
	private readonly meshes = new Set<GpuMeshLevel>()
	private bytes = 0
	/** Of `bytes`, the meshes the effects uploaded (labels `fx:`): vfx.md Epic 8's VFX accounting. */
	private fxBytes = 0

	constructor(device: GPUDevice) {
		this.device = device
	}

	get uploadedCount(): number {
		return this.meshes.size
	}

	get uploadedBytes(): number {
		return this.bytes
	}

	get uploadedFxBytes(): number {
		return this.fxBytes
	}

	upload(mesh: GeoMesh, label: string, windows?: WindowGeometry, cachedLods?: readonly GeoMesh[], onFreshChain?: (chain: readonly GeoMesh[]) => void): GpuMeshHandle {
		if (trackTags(mesh)) throw new Error('Circulating tracks require their authored LOD chain')
		// The boot LOD cache hands in the decimated LOD1/LOD2 from a previous run of
		// the same inputs (core/lod-cache); chain[0] is always the freshly provided
		// base mesh exactly as generateLodChain would clone it. A miss regenerates and
		// hands the fresh chain to the collector so the caller can persist it.
		const cached = cachedLods && cachedLods.length === LOD_LEVELS - 1 &&
			cachedLods.every((level, i) => level && level.triangleCount < (i === 0 ? mesh.triangleCount : cachedLods[i - 1].triangleCount))
		const chain = cached ? [mesh, ...cachedLods!] : mesh.generateLodChain(LOD_LEVELS, LOD_FALLOFF)
		if (!cached && onFreshChain) onFreshChain(chain)
		if (hasFoamCoverage(mesh)) for (const level of chain) if (!hasFoamCoverage(level)) markFoamCoverage(level)
		if (hasGroundMarkCoverage(mesh)) for (const level of chain) if (!hasGroundMarkCoverage(level)) markGroundMarkCoverage(level)
		return this.uploadChain(chain, label, windows)
	}

	/** Authored geometry only: validate the whole chain before any GPU allocation.
	 * Rig identity, material bindings and source hashes belong to the asset decoder.
	 * CPU channel arrays remain caller-owned; only derived bounds may be refreshed.
	 */
	uploadLods(levels: readonly GeoMesh[], label: string, windows?: WindowGeometry): GpuMeshHandle {
		const fail = (reason: string): never => { throw new Error(`render.uploadLods('${label}'): ${reason}`) }
		if (levels.length !== LOD_LEVELS) fail('expected exactly three authored levels')
		let previousTriangles = Infinity
		const limit = Math.min(this.device.limits.maxBufferSize, 0x7ffffffc)
		for (let level = 0; level < levels.length; level++) {
			const mesh = levels[level]
			if (!mesh) fail(`missing LOD${level}`)
			const n = mesh.vertexCount, t = mesh.triangleCount
			if (!Number.isSafeInteger(n) || n < 3 || !Number.isSafeInteger(t) || t < 1 || t >= previousTriangles)
				fail(`LOD${level}: invalid counts or triangles not strictly decreasing`)
			previousTriangles = t
			if ((mesh.skinIndices === null) !== (mesh.skinWeights === null) || mesh.skinned !== levels[0].skinned)
				fail(`LOD${level}: inconsistent skin channels`)
			if (n * (mesh.skinned ? STRIDE_SKINNED : STRIDE_STATIC) > limit ||
				Math.ceil(t * 3 * (n <= 0x10000 ? 2 : 4) / 4) * 4 > limit)
				fail(`LOD${level}: GPU buffer budget exceeded`)
			for (const [array, width] of [[mesh.positions, 3], [mesh.normals, 3], [mesh.tangents, 4],
				[mesh.uv0, 2], [mesh.uv1, 2]] as const) {
				if (!(array instanceof Float32Array) || array.length < n * width) fail(`LOD${level}: short/invalid vertex channel`)
				for (let i = 0; i < n * width; i++) if (!Number.isFinite(array[i])) fail(`LOD${level}: non-finite vertex channel`)
			}
			if (!(mesh.materialZone instanceof Uint8Array) || mesh.materialZone.length < n ||
				!(mesh.indices instanceof Uint32Array) || mesh.indices.length < t * 3)
				fail(`LOD${level}: short/invalid zone or index channel`)
			if (mesh.skinned) {
				const joints = mesh.skinIndices!, weights = mesh.skinWeights!
				if (!(joints instanceof Uint8Array) || !(weights instanceof Float32Array) || joints.length < n * 4 || weights.length < n * 4)
					fail(`LOD${level}: short/invalid skin channel`)
				for (let i = 0; i < n * 4; i++)
					if (!Number.isFinite(weights[i]) || weights[i] < 0 || weights[i] > 1) fail(`LOD${level}: invalid skin weight`)
			}
			const problem = mesh.validate()
			if (problem) fail(`LOD${level}: ${problem}`)
			// Public position arrays can be edited without invalidating cached bounds.
			mesh.invalidateBounds()
			mesh.updateBounds()
			if (![...mesh.aabbMin, ...mesh.aabbMax, ...mesh.boundingSphere].every(Number.isFinite))
				fail(`LOD${level}: non-finite bounds`)
		}
		return this.uploadChain(levels, label, windows)
	}

	private uploadChain(chain: readonly GeoMesh[], label: string, windows?: WindowGeometry): GpuMeshHandle {
		const lods: GpuMeshLevel[] = []
		try {
			for (let level = 0; level < chain.length; level++)
				lods.push(this.uploadLevel(chain[level], `${label}.lod${level}`, windows))
			const base = lods[0]
			// QEM is bounded but not constrained to the source AABB: a legal optimum can sit just
			// outside L0. Cull against an enclosure of the WHOLE chain or a lower level may vanish
			// at the frustum edge while its full-detail parent would still be visible.
			const aabbMin = vec3(base.aabbMin[0], base.aabbMin[1], base.aabbMin[2])
			const aabbMax = vec3(base.aabbMax[0], base.aabbMax[1], base.aabbMax[2])
			for (let level = 1; level < lods.length; level++) {
				const lod = lods[level]
				for (let axis = 0; axis < 3; axis++) {
					aabbMin[axis] = Math.min(aabbMin[axis], lod.aabbMin[axis])
					aabbMax[axis] = Math.max(aabbMax[axis], lod.aabbMax[axis])
				}
			}
			const sphere = Float32Array.of(
				(aabbMin[0] + aabbMax[0]) * 0.5,
				(aabbMin[1] + aabbMax[1]) * 0.5,
				(aabbMin[2] + aabbMax[2]) * 0.5,
				0,
			)
			for (const lod of lods) {
				const dx = lod.sphere[0] - sphere[0]
				const dy = lod.sphere[1] - sphere[1]
				const dz = lod.sphere[2] - sphere[2]
				sphere[3] = Math.max(sphere[3], Math.hypot(dx, dy, dz) + lod.sphere[3])
			}
			return { ...base, label, aabbMin, aabbMax, sphere, lods }
		} catch (error) {
			// Only this transaction's completed levels: older uploads remain usable.
			for (const lod of lods) {
				lod.indexBuffer.destroy()
				lod.vertexBuffer.destroy()
				this.meshes.delete(lod)
				this.bytes -= lod.vertexBytes + lod.indexBytes
				if (lod.label.startsWith('fx:')) this.fxBytes -= lod.vertexBytes + lod.indexBytes
			}
			throw error
		}
	}

	private uploadLevel(mesh: GeoMesh, label: string, windows?: WindowGeometry): GpuMeshLevel {
		const packed = mesh.toGPUBuffers()
		if (windows) packWindowGeometry(mesh, packed, windows)
		const track = trackTags(mesh)
		if (track) {
			const bytes = new Uint8Array(packed.vertexData)
			for (let v=0;v<mesh.vertexCount;v++) if (track[v*3+2]) {
				if (bytes[v*packed.stride+ZONE_BYTE_OFFSET+3] & 128) throw new Error('Track/window metadata collision')
				bytes.set(track.subarray(v*3,v*3+3),v*packed.stride+ZONE_BYTE_OFFSET+1)
			}
		}
		packFoamCoverage(mesh, packed)
		packGroundMarkCoverage(mesh, packed)
		if (packed.vertexCount === 0 || packed.indexCount === 0)
			throw new Error(
				`render.upload('${label}'): mesh has ${packed.vertexCount} vertices and ${packed.indexCount} indices. ` +
					'A Mesh built by assigning buffers rather than through the API reports zero counts (ARCHITECTURE.md §3.1).',
			)

		// COPY_DST rather than mappedAtCreation: writeBuffer goes through the queue's own
		// staging ring, so N meshes uploaded at boot share one staging allocation instead
		// of each pinning a mapped range until unmap.
		let vertexBuffer: GPUBuffer | undefined
		let indexBuffer: GPUBuffer | undefined
		try {
			vertexBuffer = this.device.createBuffer({
				label: `${label}.vertices`,
				size: align4(packed.vertexData.byteLength),
				usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
			})
			indexBuffer = this.device.createBuffer({
				label: `${label}.indices`,
				size: align4(packed.indexData.byteLength),
				usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
			})
			this.device.queue.writeBuffer(vertexBuffer, 0, packed.vertexData, 0, packed.vertexData.byteLength)
			// A simplified u16 triangle list may have an odd number of triangles (6*n bytes).
			// Align the transfer as well as the allocation; padding is never part of indexCount.
			if (packed.indexData.byteLength % 4) {
				const padded = new Uint8Array(align4(packed.indexData.byteLength))
				padded.set(new Uint8Array(packed.indexData))
				this.device.queue.writeBuffer(indexBuffer, 0, padded.buffer)
			} else this.device.queue.writeBuffer(indexBuffer, 0, packed.indexData)

			const aabbMin = vec3(packed.aabbMin[0], packed.aabbMin[1], packed.aabbMin[2])
			const aabbMax = vec3(packed.aabbMax[0], packed.aabbMax[1], packed.aabbMax[2])
			// Local-space bounding sphere, precomputed so the per-instance cull is a transform
			// and a dot product rather than eight corner transforms.
			const sphere = Float32Array.of(
				packed.boundingSphere[0],
				packed.boundingSphere[1],
				packed.boundingSphere[2],
				packed.boundingSphere[3],
			)

			const handle: GpuMeshLevel = {
				vertexBuffer,
				indexBuffer,
				indexCount: packed.indexCount,
				aabbMin,
				aabbMax,
				label,
				indexFormat: packed.indexFormat,
				stride: packed.stride,
				skinned: packed.skinned,
				vertexCount: packed.vertexCount,
				sphere,
				vertexBytes: packed.vertexData.byteLength,
				indexBytes: align4(packed.indexData.byteLength),
			}
			this.meshes.add(handle)
			this.bytes += handle.vertexBytes + handle.indexBytes
			if (label.startsWith('fx:')) this.fxBytes += handle.vertexBytes + handle.indexBytes
			return handle
		} catch (error) {
			// A level is tracked only after both allocations and writes succeed.
			indexBuffer?.destroy()
			vertexBuffer?.destroy()
			throw error
		}
	}

	/** Hard rule 7: everything created here is destroyed here. */
	dispose(): void {
		for (const m of this.meshes) {
			m.vertexBuffer.destroy()
			m.indexBuffer.destroy()
		}
		this.meshes.clear()
		this.bytes = 0
	}
}

/** WebGPU buffer sizes must be 4-byte multiples; a u16 index list can end odd. */
function align4(n: number): number {
	return (n + 3) & ~3
}
