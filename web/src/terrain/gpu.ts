// STEELSEED — terrain/gpu
//
// DEAD DRAW PATH — DO NOT DEBUG THE LIVE BATTLEFIELD HERE.
//
// Terrain.update() submits every ground and water part to render.submit(), so the live
// pipelines are render.prepass + render.forward / render.forward.blend. No production caller
// invokes Terrain.encode(), which is the ONLY method that binds the pipelines in this file.
// These objects are still constructed at boot because encode() remains a public compatibility
// surface, but editing them cannot change a frame. Kept, rather than deleted, because deleting
// the alternate public path is a contract/cleanup decision wider than the depth-gate task.
//
// Every GPU object terrain owns: two pipelines, two bind group layouts, the frame
// uniform, the material bind groups, and the per-chunk buffers.
//
// Rule 10 is the shape of this file. Both pipelines and both layouts are built in
// init(), before a map exists and before frame 1, with `render`'s real colour and depth
// formats bound — that is exactly why §12.2 exposes those formats. The material bind
// groups are built in init() too: `materials` is a declared dependency, so its sets are
// finished by the time terrain's init() runs, and a bind group created at map load would
// be a bind group created during play.
//
// Rule 7: everything created here is destroyed in dispose(). GPUBuffer is the only class
// with a destroy(); pipelines, layouts and bind groups are released by dropping the last
// reference, which dispose() does explicitly rather than leaving to the GC.

import { TERRAIN_WGSL, WATER_WGSL } from './shaders'
import { VERTEX_STRIDE } from './chunks'
import type { SurfaceSet } from './types'

/** 48 floats: mat4 + eight vec4. Matches the Frame struct in shaders.ts field for field. */
export const FRAME_FLOATS = 48
export const FRAME_BYTES = FRAME_FLOATS * 4

/**
 * Mirrors `geo/mesh`'s ATTRIBUTES_STATIC and VertexLocation (§3.1). A shader location
 * may never be reused for a different meaning, so these numbers are as fixed as the
 * stride they index into.
 */
const VERTEX_LAYOUT: GPUVertexBufferLayout = {
	arrayStride: VERTEX_STRIDE,
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

function align4(n: number): number {
	return (n + 3) & ~3
}

export class TerrainGpu {
	readonly device: GPUDevice
	readonly frameLayout: GPUBindGroupLayout
	readonly materialLayout: GPUBindGroupLayout
	readonly terrainPipeline: GPURenderPipeline
	readonly waterPipeline: GPURenderPipeline

	private readonly frameBuffer: GPUBuffer
	private readonly frameBindGroup: GPUBindGroup
	private readonly sampler: GPUSampler
	private readonly materialGroups = new Map<string, GPUBindGroup>()
	private readonly ownedBuffers: GPUBuffer[] = []
	/** 1x1 stand-ins for render's SSR targets until rebindSsr supplies the real ones. */
	private readonly ssrFallbackMetadata: GPUTexture
	private readonly ssrFallbackScene: GPUTexture
	private readonly ssrFallbackDepth: GPUTexture
	private ssrViews: { metadata: GPUTextureView; scene: GPUTextureView; depth: GPUTextureView }

	constructor(
		device: GPUDevice,
		colorFormat: GPUTextureFormat,
		depthFormat: GPUTextureFormat,
		maxAnisotropy: number,
	) {
		this.device = device

		this.frameLayout = device.createBindGroupLayout({
			label: 'terrain:frame',
			entries: [
				{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
			],
		})

		// Built from the four GPUTextures §12.1 pins on SurfaceSet. The player-colour mask
		// is deliberately absent: terrain has no owner, so binding a mask it can never read
		// would cost a descriptor slot per surface for nothing.
		this.materialLayout = device.createBindGroupLayout({
			label: 'terrain:surface-set',
			entries: [
				{ binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
				{ binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
				{ binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
				{ binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
				{ binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
				{ binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
				{ binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
			],
			// The SSR trio, at the slot numbers WATER_WGSL declares (render's own: contact
			// 5, reflection 6/7). Declared on the shared surface-set layout so one layout
			// serves both pipelines; the ground shader simply never reads them. The
			// entries are always resolvable: bindGroupFor supplies terrain's fallbacks
			// until rebindSsr hands over render's real views.
		})

		this.frameBuffer = device.createBuffer({
			label: 'terrain:frame-uniform',
			size: FRAME_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		})
		this.frameBindGroup = device.createBindGroup({
			label: 'terrain:frame',
			layout: this.frameLayout,
			entries: [{ binding: 0, resource: { buffer: this.frameBuffer } }],
		})
		// 1x1 fallbacks for the SSR trio (see the layout note). Depth 0 is the infinite
		// far plane under reverse-Z and metadata alpha 0 decodes to ineligible, so every
		// march misses and the water keeps its analytic skyRadiance mirror — the exact
		// pre-SSR look.
		this.ssrFallbackDepth = device.createTexture({ label: 'terrain:ssr-fallback-depth', size: [1, 1], format: 'depth24plus', usage: GPUTextureUsage.TEXTURE_BINDING })
		this.ssrFallbackMetadata = device.createTexture({ label: 'terrain:ssr-fallback-metadata', size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING })
		this.ssrFallbackScene = device.createTexture({ label: 'terrain:ssr-fallback-scene', size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING })
		this.ssrViews = {
			metadata: this.ssrFallbackMetadata.createView(),
			scene: this.ssrFallbackScene.createView(),
			depth: this.ssrFallbackDepth.createView(),
		}

		this.sampler = device.createSampler({
			label: 'terrain:surface',
			addressModeU: 'repeat',
			addressModeV: 'repeat',
			magFilter: 'linear',
			minFilter: 'linear',
			mipmapFilter: 'linear',
			maxAnisotropy,
		})

		const pipelineLayout = device.createPipelineLayout({
			label: 'terrain',
			bindGroupLayouts: [this.frameLayout, this.materialLayout],
		})
		const terrainModule = device.createShaderModule({ label: 'terrain:ground', code: TERRAIN_WGSL })
		const waterModule = device.createShaderModule({ label: 'terrain:water', code: WATER_WGSL })

		this.terrainPipeline = device.createRenderPipeline({
			label: 'terrain:ground',
			layout: pipelineLayout,
			vertex: { module: terrainModule, entryPoint: 'vsMain', buffers: [VERTEX_LAYOUT] },
			fragment: { module: terrainModule, entryPoint: 'fsMain', targets: [{ format: colorFormat }] },
			primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
			// Reverse-Z throughout (§12.2): compare GREATER against a depth cleared to 0.
			depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'greater' },
		})

		this.waterPipeline = device.createRenderPipeline({
			label: 'terrain:water',
			layout: pipelineLayout,
			vertex: { module: waterModule, entryPoint: 'vsMain', buffers: [VERTEX_LAYOUT] },
			fragment: {
				module: waterModule,
				entryPoint: 'fsMain',
				targets: [
					{
						format: colorFormat,
						// Premultiplied: the fragment already scaled its radiance by coverage, so
						// the source factor is one and only the destination is attenuated.
						blend: {
							color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
							alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
						},
					},
				],
			},
			primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
			// Water tests against the bed but must not write depth, or two water quads seen
			// through each other would occlude instead of layering.
			depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'greater' },
		})
	}

	/** One bind group per SurfaceSet, cached by set id so 13 surfaces cost 13 groups. */
	bindGroupFor(set: SurfaceSet): GPUBindGroup {
		const cached = this.materialGroups.get(set.id)
		if (cached) return cached
		const group = this.device.createBindGroup({
			label: `terrain:set:${set.id}`,
			layout: this.materialLayout,
			entries: [
				{ binding: 0, resource: this.sampler },
				{ binding: 1, resource: set.albedo.createView({ dimension: '2d-array' }) },
				{ binding: 2, resource: set.normal.createView({ dimension: '2d-array' }) },
				{ binding: 3, resource: set.orm.createView({ dimension: '2d-array' }) },
				{ binding: 5, resource: this.ssrViews.depth },
				{ binding: 6, resource: this.ssrViews.metadata },
				{ binding: 7, resource: this.ssrViews.scene },
			],
		})
		this.materialGroups.set(set.id, group)
		return group
	}
	/**
	 * Points the water pass at real SSR views (render's reflection metadata, scene colour
	 * and a scene depth that is NOT the depth attachment the pass itself tests against —
	 * a texture cannot be bound and attached in the same pass). Bind groups are cached
	 * per surface set, so this clears the cache: call it when the sources change and
	 * before the next chunk rebuild captures fresh groups — the same window render's own
	 * postChain.rebind serves on resize. Until called, the fallbacks keep the water's
	 * analytic look and the pass stays valid.
	 */
	rebindSsr(metadata: GPUTextureView, scene: GPUTextureView, depth: GPUTextureView): void {
		this.ssrViews = { metadata, scene, depth }
		this.materialGroups.clear()
	}

	/**
	 * The buffer type is spelled out rather than left as a bare `Float32Array`.
	 * TypeScript 5.7 made the typed arrays generic over their buffer, so a bare
	 * `Float32Array` is `Float32Array<ArrayBufferLike>` and will not satisfy WebGPU's
	 * `GPUAllowSharedBufferSource` — the exact toolchain trap ARCHITECTURE.md §3.1 records,
	 * and the reason this is an annotation rather than a cast.
	 */
	writeFrame(data: Float32Array<ArrayBuffer>): void {
		this.device.queue.writeBuffer(this.frameBuffer, 0, data)
	}

	bindFrame(pass: GPURenderPassEncoder): void {
		pass.setBindGroup(0, this.frameBindGroup)
	}

	createVertexBuffer(data: ArrayBuffer, label: string): GPUBuffer {
		const buffer = this.device.createBuffer({
			label,
			size: data.byteLength,
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
			mappedAtCreation: true,
		})
		new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data))
		buffer.unmap()
		this.ownedBuffers.push(buffer)
		return buffer
	}

	/**
	 * Index buffer, narrowed to uint16 whenever the chunk's vertices fit — the same rule
	 * `geo/mesh.toGPUBuffers()` applies, so a consumer that assumes the geo convention
	 * (§12.2's GpuMesh carries no index format) is right. Chunk sizes are chosen so the
	 * uint32 branch is unreachable in practice; it exists so a future 64-cell chunk cannot
	 * silently truncate indices.
	 */
	createIndexBuffer(
		indices: Uint32Array,
		vertexCount: number,
		label: string,
	): { buffer: GPUBuffer; format: GPUIndexFormat; byteLength: number } {
		const narrow = vertexCount <= 0x10000
		const bytes = align4(indices.length * (narrow ? 2 : 4))
		const buffer = this.device.createBuffer({
			label,
			size: bytes,
			usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
			mappedAtCreation: true,
		})
		const range = buffer.getMappedRange()
		if (narrow) new Uint16Array(range, 0, indices.length).set(indices)
		else new Uint32Array(range, 0, indices.length).set(indices)
		buffer.unmap()
		this.ownedBuffers.push(buffer)
		return { buffer, format: narrow ? 'uint16' : 'uint32', byteLength: bytes }
	}

	/** Drops every per-map buffer without touching the pipelines, for a map change. */
	releaseChunkBuffers(): void {
		for (const b of this.ownedBuffers) b.destroy()
		this.ownedBuffers.length = 0
	}

	dispose(): void {
		this.releaseChunkBuffers()
		this.frameBuffer.destroy()
		this.materialGroups.clear()
		this.ssrFallbackDepth.destroy()
		this.ssrFallbackMetadata.destroy()
		this.ssrFallbackScene.destroy()
	}
}
