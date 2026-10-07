// STEELSEED — render/probes
// The ambient irradiance volume: a world-space grid of SH-L1 probes.
//
// BE PRECISE ABOUT WHAT THIS IS. Each probe integrates the analytic sky over 32 fixed
// directions plus the sun's single bounce off the ground, gated by the shadow cascade so
// a probe under a roof loses its bounce term. That is a real, computed, spatially varying
// ambient term and it is what the forward pass uses for indirect diffuse.
//
// It is NOT global illumination. There is no ray tracing, no surface-to-surface
// transport, and no occlusion beyond the sun's own depth buffer. The DDGI slot in the
// frame graph exists — resource, update pass, sampling path, budget — and it is filled
// with something honest rather than something that looks like GI in a screenshot.
//
// `probeUpdatesPerFrame` probes are refreshed each frame in round-robin order, so the
// cost is the §7 budget flat and independent of volume size.

import { PROBE_WGSL } from './shaders'
import type { GpuFactory } from './types'

/** Metres between probes. One cell is one metre (§12.4), so this is 6 cells. */
export const PROBE_SPACING = 6
/** 3 x vec4 of SH-L1 coefficients per probe. */
const FLOATS_PER_PROBE = 12
/**
 * Volume floor, metres. Terrain sits around y=0 and structures reach ~10 m, so anchoring
 * the vertical extent to the world rather than to the camera keeps the probes that matter
 * from sliding out from under a base every time the camera tilts.
 */
const VOLUME_FLOOR = -4

export class ProbeVolume {
	private readonly device: GPUDevice
	readonly dimX: number
	readonly dimY: number
	readonly dimZ: number
	readonly total: number
	readonly updatesPerFrame: number

	readonly buffer: GPUBuffer
	readonly bindGroupLayout: GPUBindGroupLayout
	readonly pipeline: GPUComputePipeline
	private bindGroup: GPUBindGroup | null = null

	/** Rolling refresh cursor. Uploaded into Frame.clusterExtra.w. */
	cursor = 0
	/** Snapped volume corner, uploaded into Frame.probeOrigin. */
	readonly origin = Float32Array.of(0, VOLUME_FLOOR, 0)

	constructor(factory: GpuFactory, probeUpdatesPerFrame: number) {
		this.device = factory.device
		this.updatesPerFrame = Math.max(1, probeUpdatesPerFrame)
		// Volume size tracks the update budget so the whole grid refreshes in roughly the
		// same wall time at every quality level — about 12 frames, half a second at 25 Hz.
		const horizontal = probeUpdatesPerFrame >= 128 ? 16 : probeUpdatesPerFrame >= 64 ? 12 : 8
		this.dimX = horizontal
		this.dimZ = horizontal
		this.dimY = probeUpdatesPerFrame >= 128 ? 6 : probeUpdatesPerFrame >= 64 ? 5 : 4
		this.total = this.dimX * this.dimY * this.dimZ

		this.buffer = this.device.createBuffer({
			label: 'render.probes',
			size: this.total * FLOATS_PER_PROBE * 4,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		})

		this.bindGroupLayout = this.device.createBindGroupLayout({
			label: 'render.probe.layout',
			entries: [
				{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
				{ binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
				{ binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
				{ binding: 3, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'comparison' } },
			],
		})

		const module = this.device.createShaderModule({ label: 'render.probe', code: PROBE_WGSL })
		this.pipeline = factory.computePipeline({
			label: 'render.probe.pipeline',
			layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
			compute: { module, entryPoint: 'probeMain' },
		})
	}

	build(frameUniform: GPUBuffer, shadowArrayView: GPUTextureView, shadowSampler: GPUSampler): void {
		this.bindGroup = this.device.createBindGroup({
			label: 'render.probe.bindgroup',
			layout: this.bindGroupLayout,
			entries: [
				{ binding: 0, resource: { buffer: frameUniform } },
				{ binding: 1, resource: { buffer: this.buffer } },
				{ binding: 2, resource: shadowArrayView },
				{ binding: 3, resource: shadowSampler },
			],
		})
	}

	/**
	 * Recentres the volume on the camera, snapped to the probe spacing so the grid does
	 * not slide between probes — an unsnapped origin makes every probe's world position
	 * change every frame, which reads as a slow crawl in the ambient term.
	 */
	recentre(camX: number, camZ: number): void {
		const halfX = ((this.dimX - 1) * PROBE_SPACING) / 2
		const halfZ = ((this.dimZ - 1) * PROBE_SPACING) / 2
		this.origin[0] = Math.round((camX - halfX) / PROBE_SPACING) * PROBE_SPACING
		this.origin[2] = Math.round((camZ - halfZ) / PROBE_SPACING) * PROBE_SPACING
	}

	/** Advances the round-robin cursor. Returns the index the next dispatch starts at. */
	advanceCursor(): number {
		const start = this.cursor
		this.cursor = (this.cursor + this.updatesPerFrame) % this.total
		return start
	}

	encode(pass: GPUComputePassEncoder): void {
		if (!this.bindGroup) return
		pass.setPipeline(this.pipeline)
		pass.setBindGroup(0, this.bindGroup)
		pass.dispatchWorkgroups(Math.ceil(this.updatesPerFrame / 64))
	}

	dispose(): void {
		this.buffer.destroy()
		this.bindGroup = null
	}
}
