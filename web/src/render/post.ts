// STEELSEED — render/post
// TAA resolve, emissive-key bloom, EV-driven auto exposure, and AgX display transform.
//
// Ordering matters and is not arbitrary:
//   forward -> TAA -> emissive-key bloom -> meter -> tonemap
// Metering runs on the RESOLVED, UNBLOOMED image, not the raw one, so a small bright emitter
// cannot darken the scene by feeding back through exposure. The tonemap runs last so the
// sharpen and the dither both land in the space they are meant for.
//
// Every pass here is size-dependent only through its bind groups. The pipelines
// are built once in the constructor — rule 10.

import { BLOOM_ENABLED, BLOOM_WGSL, EXPOSURE_WGSL, type PostFeatures, postWgsl, specializeTaaWgsl, TAA_WGSL } from './shaders'
import type { RenderQuality } from '../core/config'
import { COLOR_FORMAT } from './targets'
import type { GpuFactory } from './types'
import { HEAT_FLOATS } from './heat'

/** Metering grid edge, matching GRID in EXPOSURE_WGSL. */
const LUM_GRID = 128
/** 128*128 samples at 64 threads per workgroup. */
const LUM_WORKGROUPS = (LUM_GRID * LUM_GRID) / 64

export class PostChain {
	private readonly device: GPUDevice

	readonly taaLayout: GPUBindGroupLayout
	readonly taaPipeline: GPURenderPipeline
	/** One per history parity; index is the frame's DESTINATION history slot. */
	private taaBindGroups: (GPUBindGroup | null)[] = [null, null]

	readonly exposureLayout: GPUBindGroupLayout
	readonly lumPipeline: GPUComputePipeline
	readonly adaptPipeline: GPUComputePipeline
	private exposureBindGroups: (GPUBindGroup | null)[] = [null, null]

	readonly bloomLayout: GPUBindGroupLayout | null
	readonly bloomPipeline: GPURenderPipeline | null
	private bloomBindGroups: (GPUBindGroup | null)[] = [null, null]
	/** Quarter-resolution HDR bloom, public for the read-only debug harness. */
	bloomTexture: GPUTexture | null = null
	bloomView: GPUTextureView | null = null
	bloomWidth = 0
	bloomHeight = 0

	readonly postLayout: GPUBindGroupLayout
	readonly postPipeline: GPURenderPipeline
	private postBindGroups: (GPUBindGroup | null)[] = [null, null]

	readonly exposureBuffer: GPUBuffer
	/** The frame's heat sources in framebuffer pixels (render/heat), read by the tonemap pass. */
	private readonly heatBuffer: GPUBuffer
	private heatActive = false
	private readonly partialBuffer: GPUBuffer
	private readonly sampler: GPUSampler

	constructor(factory: GpuFactory, swapFormat: GPUTextureFormat, features: PostFeatures, quality: RenderQuality) {
		this.device = factory.device

		this.sampler = this.device.createSampler({
			label: 'render.post.sampler',
			magFilter: 'linear',
			minFilter: 'linear',
			addressModeU: 'clamp-to-edge',
			addressModeV: 'clamp-to-edge',
		})

		// COPY_SRC so the adapted exposure can be read back. It multiplies the whole frame
		// in POST_WGSL, so it is the one scalar that can turn a correct scene black on its
		// own — and an unreadable one can only be reasoned about, not measured.
		this.exposureBuffer = this.device.createBuffer({
			label: 'render.exposure',
			size: 16,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
		})
		// Frame 1 has no history to adapt from; seeding a sane multiplier avoids a black
		// or blown first frame, which would otherwise be what capture.mjs photographs.
		this.device.queue.writeBuffer(this.exposureBuffer, 0, Float32Array.of(1, 0.18, 0, 0))

		this.heatBuffer = this.device.createBuffer({
			label: 'render.post.heat',
			size: HEAT_FLOATS * 4,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		})

		this.partialBuffer = this.device.createBuffer({
			label: 'render.exposure.partials',
			size: LUM_WORKGROUPS * 4,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		})

		// --- TAA ---
		this.taaLayout = this.device.createBindGroupLayout({
			label: 'render.taa.layout',
			entries: [
				{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
				{ binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
				{ binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
				{ binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
				{ binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
				{ binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
			],
		})
		const taaModule = this.device.createShaderModule({ label: 'render.taa', code: specializeTaaWgsl(TAA_WGSL, quality) })
		this.taaPipeline = factory.renderPipeline({
			label: 'render.taa.pipeline',
			layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.taaLayout] }),
			vertex: { module: taaModule, entryPoint: 'vsFullscreen' },
			fragment: { module: taaModule, entryPoint: 'fsMain', targets: [{ format: COLOR_FORMAT }] },
			primitive: { topology: 'triangle-list' },
		})

		// --- emissive-key bloom ---
		// Zero intensity is a structural defeat: no layout, pipeline, texture or pass exists.
		if (BLOOM_ENABLED) {
			this.bloomLayout = this.device.createBindGroupLayout({
				label: 'render.bloom.layout',
				entries: [
					{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
					{ binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
					{ binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
				],
			})
			const bloomModule = this.device.createShaderModule({ label: 'render.bloom', code: BLOOM_WGSL })
			this.bloomPipeline = factory.renderPipeline({
				label: 'render.bloom.pipeline',
				layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bloomLayout] }),
				vertex: { module: bloomModule, entryPoint: 'vsFullscreen' },
				fragment: { module: bloomModule, entryPoint: 'fsMain', targets: [{ format: COLOR_FORMAT }] },
				primitive: { topology: 'triangle-list' },
			})
		} else {
			this.bloomLayout = null
			this.bloomPipeline = null
		}

		// --- exposure ---
		this.exposureLayout = this.device.createBindGroupLayout({
			label: 'render.exposure.layout',
			entries: [
				{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
				{ binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
				{ binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
				{ binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
				{ binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
			],
		})
		const expModule = this.device.createShaderModule({ label: 'render.exposure', code: EXPOSURE_WGSL })
		const expPipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.exposureLayout] })
		this.lumPipeline = factory.computePipeline({
			label: 'render.exposure.meter',
			layout: expPipelineLayout,
			compute: { module: expModule, entryPoint: 'lumMain' },
		})
		this.adaptPipeline = factory.computePipeline({
			label: 'render.exposure.adapt',
			layout: expPipelineLayout,
			compute: { module: expModule, entryPoint: 'adaptMain' },
		})

		// --- tonemap ---
		const postEntries: GPUBindGroupLayoutEntry[] = [
			{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
			{ binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
			{ binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
			{ binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
			{ binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
			{ binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
			{ binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
			{ binding: 8, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
		]
		if (BLOOM_ENABLED)
			postEntries.push({ binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } })
		this.postLayout = this.device.createBindGroupLayout({
			label: 'render.post.layout',
			entries: postEntries,
		})
		const postModule = this.device.createShaderModule({ label: 'render.post', code: postWgsl(features, quality) })
		this.postPipeline = factory.renderPipeline({
			label: 'render.post.pipeline',
			layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.postLayout] }),
			vertex: { module: postModule, entryPoint: 'vsFullscreen' },
			fragment: { module: postModule, entryPoint: 'fsMain', targets: [{ format: swapFormat }] },
			primitive: { topology: 'triangle-list' },
		})
	}

	/**
	 * Rebuilds every size-dependent bind group. Called on resize only. Both history
	 * parities are built up front so the ping-pong costs an array index at frame time
	 * rather than a bind group creation.
	 */
	rebind(
		frameUniform: GPUBuffer,
		hdrView: GPUTextureView,
		depthView: GPUTextureView,
		velocityView: GPUTextureView,
		reflectionView: GPUTextureView,
		historyViews: readonly GPUTextureView[],
		width: number,
		height: number,
	): void {
		this.allocateBloom(width, height)
		for (let dest = 0; dest < 2; dest++) {
			const previous = historyViews[1 - dest]
			const current = historyViews[dest]
			this.taaBindGroups[dest] = this.device.createBindGroup({
				label: `render.taa.bindgroup${dest}`,
				layout: this.taaLayout,
				entries: [
					{ binding: 0, resource: { buffer: frameUniform } },
					{ binding: 1, resource: hdrView },
					{ binding: 2, resource: previous },
					{ binding: 3, resource: depthView },
					{ binding: 4, resource: this.sampler },
					{ binding: 5, resource: velocityView },
				],
			})
			this.exposureBindGroups[dest] = this.device.createBindGroup({
				label: `render.exposure.bindgroup${dest}`,
				layout: this.exposureLayout,
				entries: [
					{ binding: 0, resource: { buffer: frameUniform } },
					{ binding: 1, resource: current },
					{ binding: 2, resource: this.sampler },
					{ binding: 3, resource: { buffer: this.partialBuffer } },
					{ binding: 4, resource: { buffer: this.exposureBuffer } },
				],
			})
			if (BLOOM_ENABLED && this.bloomLayout && this.bloomView) {
				this.bloomBindGroups[dest] = this.device.createBindGroup({
					label: `render.bloom.bindgroup${dest}`,
					layout: this.bloomLayout,
					entries: [
						{ binding: 0, resource: { buffer: frameUniform } },
						{ binding: 1, resource: current },
						{ binding: 2, resource: this.sampler },
					],
				})
			}
			const postEntries: GPUBindGroupEntry[] = [
				{ binding: 0, resource: { buffer: frameUniform } },
				{ binding: 1, resource: current },
				{ binding: 2, resource: this.sampler },
				{ binding: 3, resource: { buffer: this.exposureBuffer } },
				{ binding: 5, resource: depthView },
				{ binding: 6, resource: reflectionView },
				{ binding: 7, resource: hdrView },
				{ binding: 8, resource: { buffer: this.heatBuffer } },
			]
			if (BLOOM_ENABLED && this.bloomView)
				postEntries.push({ binding: 4, resource: this.bloomView })
			this.postBindGroups[dest] = this.device.createBindGroup({
				label: `render.post.bindgroup${dest}`,
				layout: this.postLayout,
				entries: postEntries,
			})
		}
	}

	private allocateBloom(width: number, height: number): void {
		if (!BLOOM_ENABLED) return
		const w = Math.max(1, Math.ceil(width / 4))
		const h = Math.max(1, Math.ceil(height / 4))
		if (this.bloomTexture && w === this.bloomWidth && h === this.bloomHeight) return
		this.bloomTexture?.destroy()
		this.bloomWidth = w
		this.bloomHeight = h
		this.bloomTexture = this.device.createTexture({
			label: 'render.bloom',
			size: { width: w, height: h },
			format: COLOR_FORMAT,
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
		})
		this.bloomView = this.bloomTexture.createView()
	}

	encodeTaa(encoder: GPUCommandEncoder, destView: GPUTextureView, destIndex: number): void {
		const group = this.taaBindGroups[destIndex]
		if (!group) return
		const pass = encoder.beginRenderPass({
			label: 'render.pass.taa',
			colorAttachments: [{
				view: destView,
				loadOp: 'clear',
				storeOp: 'store',
				clearValue: { r: 0, g: 0, b: 0, a: BLOOM_ENABLED ? 0 : 1 },
			}],
		})
		pass.setPipeline(this.taaPipeline)
		pass.setBindGroup(0, group)
		pass.draw(3)
		pass.end()
	}

	encodeBloom(encoder: GPUCommandEncoder, destIndex: number): void {
		const group = this.bloomBindGroups[destIndex]
		if (!BLOOM_ENABLED || !group || !this.bloomPipeline || !this.bloomView) return
		const pass = encoder.beginRenderPass({
			label: 'render.pass.bloom',
			colorAttachments: [{
				view: this.bloomView,
				loadOp: 'clear',
				storeOp: 'store',
				clearValue: { r: 0, g: 0, b: 0, a: 0 },
			}],
		})
		pass.setPipeline(this.bloomPipeline)
		pass.setBindGroup(0, group)
		pass.draw(3)
		pass.end()
	}

	encodeExposure(pass: GPUComputePassEncoder, destIndex: number): void {
		const group = this.exposureBindGroups[destIndex]
		if (!group) return
		pass.setPipeline(this.lumPipeline)
		pass.setBindGroup(0, group)
		pass.dispatchWorkgroups(LUM_WORKGROUPS)
		pass.setPipeline(this.adaptPipeline)
		pass.setBindGroup(0, group)
		pass.dispatchWorkgroups(1)
	}

	/**
	 * This frame's heat sources, packed by HeatSources.pack. An empty frame after an empty frame
	 * writes nothing: the buffer already says "no sources".
	 */
	writeHeat(packed: Float32Array, count: number): void {
		if (count === 0 && !this.heatActive) return
		this.device.queue.writeBuffer(this.heatBuffer, 0, packed.buffer, packed.byteOffset, packed.byteLength)
		this.heatActive = count > 0
	}

	encodePost(encoder: GPUCommandEncoder, swapView: GPUTextureView, destIndex: number): void {
		const group = this.postBindGroups[destIndex]
		if (!group) return
		const pass = encoder.beginRenderPass({
			label: 'render.pass.post',
			colorAttachments: [{ view: swapView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
		})
		pass.setPipeline(this.postPipeline)
		pass.setBindGroup(0, group)
		pass.draw(3)
		pass.end()
	}

	dispose(): void {
		this.exposureBuffer.destroy()
		this.heatBuffer.destroy()
		this.partialBuffer.destroy()
		this.bloomTexture?.destroy()
		this.bloomTexture = null
		this.bloomView = null
		this.taaBindGroups = [null, null]
		this.bloomBindGroups = [null, null]
		this.exposureBindGroups = [null, null]
		this.postBindGroups = [null, null]
	}
}
