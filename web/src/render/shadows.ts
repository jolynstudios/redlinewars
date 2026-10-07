// STEELSEED — render/shadows
// Cascaded shadow maps for the sun, with stable texel snapping.
//
// The whole file exists for one property: a panning camera must not make cascade edges
// crawl. Two things produce that crawl and both are handled here.
//
//  1. A cascade fitted to the frustum's AABB changes size as the camera ROTATES, because
//     an AABB of a rotating box breathes. The fit here is to the sub-frustum's bounding
//     SPHERE, whose radius depends only on the split distances and the field of view —
//     rotation-invariant by construction, so the ortho extent is a per-cascade constant.
//  2. A cascade whose origin slides by a fraction of a texel re-rasterises every caster
//     against a different sample grid every frame, which shimmers along every edge. The
//     centre is therefore snapped to whole texels IN LIGHT SPACE, and the light basis is
//     a pure rotation about the world origin so that "light space" itself does not move.
//
// Reverse-Z holds here too: the ortho matrices are built with near and far swapped so
// the near plane maps to 1 and the far plane to 0, the compare is `greater`, and the
// clear is 0.0 — the same convention as the main camera, because two depth conventions
// in one renderer is a black screen waiting to happen.

import { m4, type Mat4, v3, vec3, mat4 } from '../core'
import type { RenderQuality } from '../core/config'
import { SHADOW_WGSL } from './shaders'
import { SHADOW_CUTOUT_WGSL } from './cutout-shaders'
import type { GpuFactory } from './types'
import { positionLayout, positionSkinLayout, vertexLayout, terrainPositionLayout, STRIDE_STATIC, STRIDE_SKINNED, TERRAIN_STRIDE } from './gpumesh'
import { DEPTH_FORMAT } from './targets'

/** Dynamic uniform offsets must be 256-byte aligned; one mat4 per cascade slot. */
const CASCADE_STRIDE = 256
/** Practical-split blend. 0 is uniform, 1 is fully logarithmic. */
const SPLIT_LAMBDA = 0.75
export class CascadeShadows {
	private readonly device: GPUDevice
	readonly cascadeCount: number
	readonly mapSize: number
	readonly shadowDistance: number
	private readonly casterExtent: number

	texture!: GPUTexture
	/** One single-layer view per cascade, used as the pass's depth attachment. */
	layerViews: GPUTextureView[] = []
	/** The 2d-array view the shading pass samples. */
	arrayView!: GPUTextureView

	/** View-space far distance of each cascade. Uploaded into Frame.cascadeSplits. */
	readonly splits = new Float32Array(4)
	/** World-space size of one texel in each cascade, for the normal-offset bias. */
	readonly texelWorld = new Float32Array(4)
	/** cascadeCount x 16 floats, column-major, ready for the frame uniform. */
	readonly matrices = new Float32Array(4 * 16)

	/**
	 * A sphere that conservatively contains everything able to cast into any cascade:
	 * the widest cascade's sphere, pushed halfway toward the sun and grown by the same
	 * amount. The exact caster volume is a capsule; approximating it with one sphere
	 * costs a few extra shadow draws and saves a per-instance capsule test.
	 */
	readonly casterCenter = vec3()
	casterRadius = 0

	readonly cascadeUniform: GPUBuffer
	readonly bindGroupLayout: GPUBindGroupLayout
	readonly bindGroup: GPUBindGroup
	readonly pipelineStatic: GPURenderPipeline
	readonly pipelineSkinned: GPURenderPipeline
	readonly pipelineCutoutStatic: GPURenderPipeline
	readonly pipelineTerrain: GPURenderPipeline
	readonly pipelineCutoutSkinned: GPURenderPipeline

	/** Staging for the dynamic-offset uniform: cascadeCount slots of 256 bytes. */
	private readonly cascadeStaging: Float32Array

	// Preallocated working state. Hard rule 6 — nothing here allocates after init.
	private readonly lightView = mat4()
	private readonly ortho = mat4()
	private readonly composed = mat4()
	private readonly sunDir = vec3()
	private readonly upAxis = vec3()
	private readonly eye = vec3()
	private readonly forward = vec3()
	private readonly center = vec3()
	private readonly centerLs = vec3()
	private readonly splitNear = new Float32Array(5)
	private readonly radii = new Float32Array(4)
	private cachedNear = -1
	private cachedTanX = -1
	private cachedTanY = -1

	constructor(factory: GpuFactory, drawLayout: GPUBindGroupLayout, cascadeCount: number, materialLayout: GPUBindGroupLayout, quality: RenderQuality) {
		this.device = factory.device
		this.cascadeCount = Math.max(1, Math.min(4, cascadeCount))
		this.mapSize = quality.shadowMapSize
		this.shadowDistance = quality.shadowMetresPerCascade * this.cascadeCount
		this.casterExtent = quality.shadowCasterExtent
		this.cascadeStaging = new Float32Array((CASCADE_STRIDE / 4) * this.cascadeCount)

		this.allocateTexture()

		this.cascadeUniform = this.device.createBuffer({
			label: 'render.shadow.cascades',
			size: CASCADE_STRIDE * this.cascadeCount,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		})

		this.bindGroupLayout = this.device.createBindGroupLayout({
			label: 'render.shadow.layout',
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.VERTEX,
					buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 64 },
				},
			],
		})
		this.bindGroup = this.device.createBindGroup({
			label: 'render.shadow.bindgroup',
			layout: this.bindGroupLayout,
			entries: [{ binding: 0, resource: { buffer: this.cascadeUniform, size: 64 } }],
		})

		const module = this.device.createShaderModule({ label: 'render.shadow', code: SHADOW_WGSL })
		const layout = this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout, drawLayout] })
		// Two variants, both created before frame 1: the static and skinned vertex strides
		// differ, and rule 10 forbids discovering that during play.
		this.pipelineStatic = this.makePipeline(factory, module, layout, STRIDE_STATIC, 'static')
		this.pipelineSkinned = this.makePipeline(factory, module, layout, STRIDE_SKINNED, 'skinned')
		this.pipelineTerrain = this.makePipeline(factory, module, layout, TERRAIN_STRIDE, 'terrain')
		const cutout = this.device.createShaderModule({ label: 'render.shadow.cutout', code: SHADOW_CUTOUT_WGSL })
		const cutoutLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout, drawLayout, materialLayout] })
		this.pipelineCutoutStatic = this.makePipeline(factory, cutout, cutoutLayout, STRIDE_STATIC, 'cutout.static', true)
		this.pipelineCutoutSkinned = this.makePipeline(factory, cutout, cutoutLayout, STRIDE_SKINNED, 'cutout.skinned', true)
	}

	private makePipeline(
		factory: GpuFactory,
		module: GPUShaderModule,
		layout: GPUPipelineLayout,
		stride: number,
		name: string,
		cutout = false,
	): GPURenderPipeline {
		return factory.renderPipeline({
			label: `render.shadow.${name}`,
			layout,
			vertex: {
				module,
				entryPoint: stride === STRIDE_SKINNED ? 'vsSkinned' : 'vsMain',
				// shadow stands still while the figure moves.
				buffers: [cutout ? vertexLayout(stride) : stride === STRIDE_SKINNED ? positionSkinLayout(stride) : stride === TERRAIN_STRIDE ? terrainPositionLayout() : positionLayout(stride)],
			},
			...(cutout ? { fragment: { module, entryPoint: 'fsCutout', targets: [] } } : {}),
			primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
			depthStencil: {
				format: DEPTH_FORMAT,
				depthWriteEnabled: true,
				// Reverse-Z, exactly as the main camera. No depth bias: the receiver is
				// pushed along its normal in the shading pass instead, which scales with
				// the cascade's texel size rather than needing a constant per cascade.
				depthCompare: 'greater',
			},
		})
	}

	private allocateTexture(): void {
		this.texture = this.device.createTexture({
			label: 'render.shadow.map',
			size: { width: this.mapSize, height: this.mapSize, depthOrArrayLayers: this.cascadeCount },
			format: DEPTH_FORMAT,
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
		})
		this.arrayView = this.texture.createView({ label: 'render.shadow.array', dimension: '2d-array' })
		this.layerViews = []
		for (let i = 0; i < this.cascadeCount; i++) {
			this.layerViews.push(
				this.texture.createView({
					label: `render.shadow.layer${i}`,
					dimension: '2d',
					baseArrayLayer: i,
					arrayLayerCount: 1,
				}),
			)
		}
	}

	/** Byte offset of a cascade's slot in the dynamic-offset uniform. */
	uniformOffset(cascade: number): number {
		return cascade * CASCADE_STRIDE
	}

	/**
	 * Recompute the cascade matrices for this camera and sun direction, and upload them.
	 *
	 * `sunX/Y/Z` is the unit vector pointing TOWARDS the sun. `view` and `proj` are the
	 * camera's UNJITTERED matrices: fitting to the jittered projection would move every
	 * cascade by a subpixel each frame and undo the snapping this whole file is about.
	 */
	fit(view: Mat4, proj: Mat4, camX: number, camY: number, camZ: number, sunX: number, sunY: number, sunZ: number): void {
		const near = proj[11] === -1 && proj[14] > 0 ? proj[14] : 0.1
		const tanX = 1 / Math.max(proj[0], 1e-6)
		const tanY = 1 / Math.max(proj[5], 1e-6)
		if (near !== this.cachedNear || tanX !== this.cachedTanX || tanY !== this.cachedTanY) {
			this.recomputeSplits(near, tanX, tanY)
			this.cachedNear = near
			this.cachedTanX = tanX
			this.cachedTanY = tanY
		}

		// View matrix row 2 is the camera's backward axis, so forward is its negation.
		v3.set(this.forward, -view[2], -view[6], -view[10])
		v3.normalize(this.forward, this.forward)

		v3.set(this.sunDir, sunX, sunY, sunZ)
		v3.normalize(this.sunDir, this.sunDir)
		// A degenerate up would collapse the light basis into a NaN matrix that silently
		// blanks every shadow, so pick the axis furthest from the sun direction.
		if (Math.abs(this.sunDir[1]) > 0.99) v3.set(this.upAxis, 0, 0, 1)
		else v3.set(this.upAxis, 0, 1, 0)

		// The light basis is a PURE ROTATION about the world origin. Snapping only helps
		// if the space being snapped in is itself fixed; a lookAt from a moving eye is not.
		v3.set(this.eye, 0, 0, 0)
		v3.set(this.center, -this.sunDir[0], -this.sunDir[1], -this.sunDir[2])
		m4.lookAt(this.lightView, this.eye, this.center, this.upAxis)

		for (let i = 0; i < this.cascadeCount; i++) {
			const nearD = this.splitNear[i]
			const farD = this.splitNear[i + 1]
			const radius = this.radii[i]

			// Sub-frustum centre: on the view axis, at the depth that equalises the
			// distance to the near and far corner rings.
			const k2 = tanX * tanX + tanY * tanY
			let zc = ((farD + nearD) * (k2 + 1)) / 2
			if (zc > farD) zc = farD
			v3.set(
				this.center,
				camX + this.forward[0] * zc,
				camY + this.forward[1] * zc,
				camZ + this.forward[2] * zc,
			)

			v3.transformMat4(this.centerLs, this.center, this.lightView)

			const texel = (2 * radius) / this.mapSize
			this.texelWorld[i] = texel
			const cx = Math.round(this.centerLs[0] / texel) * texel
			const cy = Math.round(this.centerLs[1] / texel) * texel
			const cz = Math.round(this.centerLs[2] / texel) * texel

			// Light space looks down -Z, so a positive distance along the view axis is a
			// negative z. The caster extent pulls the near plane back so a tower outside the
			// cascade still writes the shadow it casts into it.
			const farDist = -cz + radius
			const nearDist = -cz - radius - this.casterExtent
			// near and far swapped: this is what makes the cascade reverse-Z.
			m4.orthographic(this.ortho, cx - radius, cx + radius, cy - radius, cy + radius, farDist, nearDist)
			m4.multiply(this.composed, this.ortho, this.lightView)

			this.matrices.set(this.composed, i * 16)
			this.cascadeStaging.set(this.composed, i * (CASCADE_STRIDE / 4))
		}

		// `this.center` still holds the widest cascade's centre after the loop.
		const half = this.casterExtent * 0.5
		v3.set(
			this.casterCenter,
			this.center[0] + this.sunDir[0] * half,
			this.center[1] + this.sunDir[1] * half,
			this.center[2] + this.sunDir[2] * half,
		)
		this.casterRadius = this.radii[this.cascadeCount - 1] + half

		// Unused cascade slots hold the last live cascade so a shader that clamps to a
		// higher index still samples something valid rather than an uninitialised matrix.
		for (let i = this.cascadeCount; i < 4; i++) {
			this.matrices.copyWithin(i * 16, (this.cascadeCount - 1) * 16, this.cascadeCount * 16)
			this.splits[i] = this.splits[this.cascadeCount - 1]
			this.texelWorld[i] = this.texelWorld[this.cascadeCount - 1]
		}

		this.device.queue.writeBuffer(
			this.cascadeUniform,
			0,
			this.cascadeStaging.buffer,
			this.cascadeStaging.byteOffset,
			CASCADE_STRIDE * this.cascadeCount,
		)
	}

	/**
	 * Split distances and the resulting sphere radii. Both depend only on the near plane
	 * and the field of view, so they are cached: a radius that jitters frame to frame
	 * would defeat the texel snapping no matter how carefully the centre is rounded.
	 */
	private recomputeSplits(near: number, tanX: number, tanY: number): void {
		const far = this.shadowDistance
		this.splitNear[0] = near
		for (let i = 1; i <= this.cascadeCount; i++) {
			const s = i / this.cascadeCount
			const logSplit = near * (far / near) ** s
			const uniSplit = near + (far - near) * s
			this.splitNear[i] = SPLIT_LAMBDA * logSplit + (1 - SPLIT_LAMBDA) * uniSplit
		}
		const k2 = tanX * tanX + tanY * tanY
		for (let i = 0; i < this.cascadeCount; i++) {
			const n = this.splitNear[i]
			const f = this.splitNear[i + 1]
			let zc = ((f + n) * (k2 + 1)) / 2
			if (zc > f) zc = f
			this.radii[i] = Math.sqrt(f * f * k2 + (f - zc) * (f - zc))
			this.splits[i] = f
		}
	}

	dispose(): void {
		this.texture.destroy()
		this.cascadeUniform.destroy()
		this.layerViews = []
	}
}
