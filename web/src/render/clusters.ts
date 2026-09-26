// STEELSEED — render/clusters
// The froxel grid: screen tiles x exponential depth slices, culled on the GPU.
//
// Every muzzle flash and burning wreck in STEELSEED is a real light (§5.3 of the brief),
// so the shading pass cannot afford to iterate the whole light set per pixel. A froxel
// grid reduces that to the handful of lights that actually reach the pixel's cell.
//
// Each froxel owns a FIXED slot range in the index buffer rather than allocating out of a
// shared pool with an atomic counter. That costs memory and buys two things: no atomics
// (so no cross-workgroup contention when a hundred lights land in one tile), and a light
// order inside a froxel that is the buffer order — deterministic, run after run (§5).

import type { GpuFactory } from './types'
import { CLUSTER_CULL_WGSL } from './shaders'

/** Depth slices. 24 is the usual sweet spot: enough to keep froxels near-cubic, cheap to cull. */
export const CLUSTER_SLICES = 24
/** Starting tile edge in pixels. Grown, never shrunk, to hold the cluster count in budget. */
const BASE_TILE = 32
/** Hard ceiling on froxel count, so a 4K target cannot allocate a 50 MB index buffer. */
const MAX_CLUSTERS = 1 << 16
/** Froxels stop at this distance; beyond it only the sun and ambient contribute. */
export const CLUSTER_FAR = 400

export class ClusterGrid {
	private readonly device: GPUDevice
	readonly lightsPerCluster: number

	tileSize = BASE_TILE
	tilesX = 1
	tilesY = 1
	readonly slices = CLUSTER_SLICES
	clusterCount = 1

	countBuffer!: GPUBuffer
	indexBuffer!: GPUBuffer

	readonly bindGroupLayout: GPUBindGroupLayout
	readonly pipeline: GPUComputePipeline
	bindGroup: GPUBindGroup | null = null

	constructor(factory: GpuFactory, dynamicLights: number) {
		this.device = factory.device
		// A froxel never needs the whole budget: at 32 px tiles, more than 64 lights
		// overlapping one cell is a scene problem, not a renderer problem.
		this.lightsPerCluster = Math.max(8, Math.min(64, dynamicLights))

		this.bindGroupLayout = this.device.createBindGroupLayout({
			label: 'render.cull.layout',
			entries: [
				{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
				{ binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
				{ binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
				{ binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
			],
		})

		const module = this.device.createShaderModule({ label: 'render.cull', code: CLUSTER_CULL_WGSL })
		this.pipeline = factory.computePipeline({
			label: 'render.cull.pipeline',
			layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
			compute: { module, entryPoint: 'cullMain' },
		})
	}

	/**
	 * Sizes the grid for a render target. Returns true when the froxel count changed and
	 * the bind group must be rebuilt. The tile edge doubles until the count fits the cap,
	 * which degrades culling precision at very high resolution rather than the memory
	 * ceiling — rule 9 says degrade, never exceed.
	 */
	allocate(width: number, height: number): boolean {
		let tile = BASE_TILE
		let tx = Math.max(1, Math.ceil(width / tile))
		let ty = Math.max(1, Math.ceil(height / tile))
		while (tx * ty * this.slices > MAX_CLUSTERS) {
			tile *= 2
			tx = Math.max(1, Math.ceil(width / tile))
			ty = Math.max(1, Math.ceil(height / tile))
		}
		const count = tx * ty * this.slices
		if (this.countBuffer && count === this.clusterCount && tx === this.tilesX && ty === this.tilesY) return false

		this.release()
		this.tileSize = tile
		this.tilesX = tx
		this.tilesY = ty
		this.clusterCount = count

		this.countBuffer = this.device.createBuffer({
			label: 'render.cluster.counts',
			size: count * 4,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		})
		this.indexBuffer = this.device.createBuffer({
			label: 'render.cluster.indices',
			size: count * this.lightsPerCluster * 4,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		})
		return true
	}

	rebuildBindGroup(frameUniform: GPUBuffer, lightBuffer: GPUBuffer): void {
		this.bindGroup = this.device.createBindGroup({
			label: 'render.cull.bindgroup',
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: frameUniform } },
				{ binding: 1, resource: { buffer: lightBuffer } },
				{ binding: 2, resource: { buffer: this.countBuffer } },
				{ binding: 3, resource: { buffer: this.indexBuffer } },
			],
		})
	}

	encode(pass: GPUComputePassEncoder): void {
		if (!this.bindGroup) return
		pass.setPipeline(this.pipeline)
		pass.setBindGroup(0, this.bindGroup)
		pass.dispatchWorkgroups(Math.ceil(this.clusterCount / 64))
	}

	/** logScale/logBias map a view-space distance onto a slice index in one madd. */
	logScale(near: number): number {
		return this.slices / Math.log(CLUSTER_FAR / near)
	}

	logBias(near: number): number {
		return -Math.log(near) * this.logScale(near)
	}

	release(): void {
		this.countBuffer?.destroy()
		this.indexBuffer?.destroy()
		this.countBuffer = undefined as unknown as GPUBuffer
		this.indexBuffer = undefined as unknown as GPUBuffer
		this.bindGroup = null
	}

	dispose(): void {
		this.release()
	}
}
