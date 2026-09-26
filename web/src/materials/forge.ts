// STEELSEED — materials/forge
// The GPU texture forge. Everything here runs once, at boot, before frame 1.
//
// Shape of a build, per (set, layer, mip):
//   1. `forgeField`  compute — evaluate the surface's STRUCTURE into an rgba32float
//                    scratch image: height in metres, wear seed, cavity, material id.
//   2. `forgePack`   compute — read that field's neighbourhood, differentiate it for a
//                    normal, take its Laplacian for curvature, march it for occlusion,
//                    shade from all three, and pack the four outputs into staging
//                    buffers with 256-byte row pitches.
//   3. four copyBufferToTexture into the set's array textures at (mipLevel, layer).
//
// Why buffers and not storage textures: rg8unorm and r8unorm are not storage-capable in
// core WebGPU, so writing the normal and mask images directly would require the optional
// texture-formats tier-1 feature and would make the boot fail on hardware that is
// otherwise perfectly capable. One copy per target per mip is the cheaper trade.
//
// Why the mip chain is generated rather than box-filtered: both passes re-run at every
// mip resolution with the octaves above that resolution's Nyquist faded out. Averaging a
// normal map down averages DIRECTIONS, which flattens a surface in a way no real
// filtering ever does; re-deriving the normal from a band-limited height field is right.
//
// Rules kept here: nothing is created after init (10), every device object made here is
// destroyed in dispose (7), every value comes from ctx.rng (5), and the resolution and
// variant count degrade to fit the §7 texture VRAM budget rather than overrunning it (9).

import { clamp, type Rng } from '../core'
import type { SurfaceSet } from './api'
import { ANI_DIRS, type SurfaceSetDef } from './sets'
import { HEIGHT_ENCODE_SPAN, LATTICE_WGSL, NOISE_WGSL, PARAMS_WGSL } from './wgsl-common'
import { FIELD_BINDINGS_WGSL, FIELD_ENTRY_WGSL, FIELD_KINDS_WGSL } from './wgsl-field'
import { PACK_BINDINGS_WGSL, PACK_ENTRY_WGSL, SHADE_KINDS_WGSL } from './wgsl-pack'

/** Both entry points are @workgroup_size(8,8,1); the pack pass depends on the 8 width. */
const WORKGROUP = 8

/**
 * The chain stops at 8x8, not 1x1. The pack pass assembles the sub-word rg8/r8 targets
 * across a full workgroup, so every mip must be at least one workgroup wide — and below
 * 8x8 a tiling detail texture is a flat average covering a surface that is one pixel on
 * screen, so there is nothing to lose.
 */
const MIN_MIP = 8

/** Bytes the Params struct in wgsl-common.ts actually occupies. */
const PARAM_BYTES = 128

/** Bytes of the SsSetInfo uniform every sampling pipeline reads at binding 5. */
const SET_INFO_BYTES = 32

/** Variants per set. Consumers index a layer per cell to break the tiling repeat. */
export const LAYERS_PER_SET = 4

/**
 * Write one tint, scaled. §7 floors albedo at 0.02 — below that a surface reads as a hole
 * rather than as dark material, which this project has already been caught by once.
 */
function writeTint(
	f: Float32Array,
	o: number,
	t: readonly [number, number, number, number],
	scale: number,
	roughAdd: number,
): void {
	f[o] = Math.max(0.02, t[0] * scale)
	f[o + 1] = Math.max(0.02, t[1] * scale)
	f[o + 2] = Math.max(0.02, t[2] * scale)
	f[o + 3] = Math.min(1, Math.max(0, t[3] + roughAdd))
}

/** Format -> bytes per texel, so vramBytes traces back to a real texture descriptor. */
const FORMAT_BYTES: Record<string, number> = {
	rgba8unorm: 4,
	rg8unorm: 2,
	r8unorm: 1,
	rgba32float: 16,
}

const align256 = (n: number): number => (n + 255) & ~255

export function mipCountFor(size: number): number {
	let n = 1
	let s = size
	while (s > MIN_MIP) {
		s >>= 1
		n++
	}
	return n
}

/** Exact bytes of one array texture, from its own dimensions and format (§7). */
export function textureBytes(size: number, layers: number, mips: number, format: string): number {
	const bpt = FORMAT_BYTES[format]
	let total = 0
	for (let m = 0; m < mips; m++) {
		const d = size >> m
		total += d * d * layers * bpt
	}
	return total
}

function setBytes(size: number, layers: number, mips: number): number {
	return (
		textureBytes(size, layers, mips, 'rgba8unorm') +
		textureBytes(size, layers, mips, 'rg8unorm') +
		textureBytes(size, layers, mips, 'rgba8unorm') +
		textureBytes(size, layers, mips, 'r8unorm')
	)
}

export interface ForgePlan {
	readonly size: number
	readonly layers: number
	readonly mips: number
	readonly bytes: number
}

/**
 * Fit the forge inside its share of the §7 texture VRAM budget. Resolution is given up
 * first and variant count second: losing a variant is a repeat visible across the whole
 * map, while losing resolution is only ever seen with the camera pushed all the way in.
 */
export function planForge(setCount: number, budgetBytes: number, preferredSize: number): ForgePlan {
	let size = preferredSize
	let layers = LAYERS_PER_SET
	let mips = mipCountFor(size)
	let bytes = setCount * setBytes(size, layers, mips)
	while (bytes > budgetBytes && size > MIN_MIP * 2) {
		size >>= 1
		mips = mipCountFor(size)
		bytes = setCount * setBytes(size, layers, mips)
	}
	while (bytes > budgetBytes && layers > 1) {
		layers--
		bytes = setCount * setBytes(size, layers, mips)
	}
	return { size, layers, mips, bytes }
}

/**
 * A built set. Carries the pinned §12.1 surface plus the views and the per-set uniform
 * the shared bind group needs — those are implementation, so they are not on the pin.
 */
export class ForgedSurfaceSet implements SurfaceSet {
	readonly id: string
	readonly albedo: GPUTexture
	readonly normal: GPUTexture
	readonly orm: GPUTexture
	readonly mask: GPUTexture
	readonly layerCount: number
	readonly vramBytes: number

	readonly albedoView: GPUTextureView
	readonly normalView: GPUTextureView
	readonly ormView: GPUTextureView
	readonly maskView: GPUTextureView
	readonly info: GPUBuffer
	readonly size: number
	readonly mipCount: number
	readonly tileMeters: number
	/** Metres spanned by the packed height channel — decode as (a-0.5)*heightRange. */
	readonly heightRange: number

	constructor(init: {
		id: string
		albedo: GPUTexture
		normal: GPUTexture
		orm: GPUTexture
		mask: GPUTexture
		layerCount: number
		vramBytes: number
		info: GPUBuffer
		size: number
		mipCount: number
		tileMeters: number
		heightRange: number
	}) {
		this.id = init.id
		this.albedo = init.albedo
		this.normal = init.normal
		this.orm = init.orm
		this.mask = init.mask
		this.layerCount = init.layerCount
		this.vramBytes = init.vramBytes
		this.info = init.info
		this.size = init.size
		this.mipCount = init.mipCount
		this.tileMeters = init.tileMeters
		this.heightRange = init.heightRange
		// The albedo view is -srgb over an rgba8unorm texture: the format on the pin does
		// not change, but the hardware does the transfer-function decode, which is what
		// keeps a 0.02 albedo from quantising to five raw levels.
		this.albedoView = init.albedo.createView({ dimension: '2d-array', format: 'rgba8unorm-srgb' })
		this.normalView = init.normal.createView({ dimension: '2d-array' })
		this.ormView = init.orm.createView({ dimension: '2d-array' })
		this.maskView = init.mask.createView({ dimension: '2d-array' })
	}

	dispose(): void {
		this.albedo.destroy()
		this.normal.destroy()
		this.orm.destroy()
		this.mask.destroy()
		this.info.destroy()
	}
}

export class TextureForge {
	private readonly device: GPUDevice
	private readonly plan: ForgePlan

	private fieldLayout: GPUBindGroupLayout | null = null
	private packLayout: GPUBindGroupLayout | null = null
	private fieldPipeline: GPUComputePipeline | null = null
	private packPipeline: GPUComputePipeline | null = null
	private fieldGroup: GPUBindGroup | null = null
	private packGroup: GPUBindGroup | null = null

	private fieldTex: GPUTexture | null = null
	private fieldView: GPUTextureView | null = null
	private bufAlbedo: GPUBuffer | null = null
	private bufNormal: GPUBuffer | null = null
	private bufOrm: GPUBuffer | null = null
	private bufMask: GPUBuffer | null = null
	private params: GPUBuffer | null = null
	private paramStride = 256

	constructor(device: GPUDevice, plan: ForgePlan) {
		this.device = device
		this.plan = plan
		this.paramStride = Math.max(256, device.limits.minUniformBufferOffsetAlignment)
	}

	/**
	 * Compile with the compilation log surfaced. A WGSL error at boot must name its line
	 * — the alternative is a blank world and a generic pipeline-creation failure, which
	 * is the least debuggable failure this node can produce.
	 */
	private async compile(label: string, code: string): Promise<GPUShaderModule> {
		const mod = this.device.createShaderModule({ label, code })
		const info = await mod.getCompilationInfo()
		const errors = info.messages.filter((m) => m.type === 'error')
		if (errors.length > 0) {
			const first = errors[0]
			throw new Error(
				`materials: ${label} failed to compile at line ${first.lineNum}:${first.linePos} — ${first.message}`,
			)
		}
		return mod
	}

	/** Build every pipeline, layout, buffer and scratch texture. Rule 10: all of it, now. */
	async init(): Promise<void> {
		const device = this.device
		const { size } = this.plan

		this.fieldLayout = device.createBindGroupLayout({
			label: 'steelseed/materials/field-layout',
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: PARAM_BYTES },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.COMPUTE,
					storageTexture: { access: 'write-only', format: 'rgba32float', viewDimension: '2d' },
				},
			],
		})

		this.packLayout = device.createBindGroupLayout({
			label: 'steelseed/materials/pack-layout',
			entries: [
				{
					binding: 0,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: PARAM_BYTES },
				},
				{
					binding: 1,
					visibility: GPUShaderStage.COMPUTE,
					// rgba32float is not filterable, and nothing here filters it — every read
					// is an exact texel fetch of the field the previous dispatch wrote.
					texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
				},
				{ binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
				{ binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
				{ binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
				{ binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
			],
		})

		const fieldModule = await this.compile(
			'steelseed/materials/forge-field',
			PARAMS_WGSL + FIELD_BINDINGS_WGSL + NOISE_WGSL + LATTICE_WGSL + FIELD_KINDS_WGSL + FIELD_ENTRY_WGSL,
		)
		const packModule = await this.compile(
			'steelseed/materials/forge-pack',
			PARAMS_WGSL + PACK_BINDINGS_WGSL + NOISE_WGSL + SHADE_KINDS_WGSL + PACK_ENTRY_WGSL,
		)

		this.fieldPipeline = device.createComputePipeline({
			label: 'steelseed/materials/forge-field',
			layout: device.createPipelineLayout({ bindGroupLayouts: [this.fieldLayout] }),
			compute: { module: fieldModule, entryPoint: 'forgeField' },
		})
		this.packPipeline = device.createComputePipeline({
			label: 'steelseed/materials/forge-pack',
			layout: device.createPipelineLayout({ bindGroupLayouts: [this.packLayout] }),
			compute: { module: packModule, entryPoint: 'forgePack' },
		})

		this.fieldTex = device.createTexture({
			label: 'steelseed/materials/field-scratch',
			size: { width: size, height: size, depthOrArrayLayers: 1 },
			format: 'rgba32float',
			usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
		})

		// Staging rows are padded to 256 bytes because copyBufferToTexture requires it,
		// and the pack shader is told the padded stride so it writes into the same layout.
		const mk = (label: string, bytes: number): GPUBuffer =>
			device.createBuffer({
				label,
				size: bytes,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
			})
		this.bufAlbedo = mk('steelseed/materials/stage-albedo', align256(size * 4) * size)
		this.bufNormal = mk('steelseed/materials/stage-normal', align256(size * 2) * size)
		this.bufOrm = mk('steelseed/materials/stage-orm', align256(size * 4) * size)
		this.bufMask = mk('steelseed/materials/stage-mask', align256(size * 1) * size)

		// The two bind groups wait for build(), which is where the parameter buffer they
		// index into gets sized and filled.
		this.fieldView = this.fieldTex.createView({ dimension: '2d' })
	}

	/**
	 * Generate every set. One command submission per set keeps any single submission
	 * short enough not to look like a hung device on a slow adapter, and gives the boot
	 * a natural yield point between sets.
	 */
	async build(defs: readonly SurfaceSetDef[], rng: Rng): Promise<ForgedSurfaceSet[]> {
		const device = this.device
		const { size, layers, mips } = this.plan
		const blocks = defs.length * layers * mips

		this.params = device.createBuffer({
			label: 'steelseed/materials/forge-params',
			size: blocks * this.paramStride,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		})
		device.queue.writeBuffer(this.params, 0, this.buildParams(defs, rng))

		this.fieldGroup = device.createBindGroup({
			label: 'steelseed/materials/field-group',
			layout: this.fieldLayout!,
			entries: [
				{ binding: 0, resource: { buffer: this.params, size: PARAM_BYTES } },
				{ binding: 1, resource: this.fieldView! },
			],
		})
		this.packGroup = device.createBindGroup({
			label: 'steelseed/materials/pack-group',
			layout: this.packLayout!,
			entries: [
				{ binding: 0, resource: { buffer: this.params, size: PARAM_BYTES } },
				{ binding: 1, resource: this.fieldView! },
				{ binding: 2, resource: { buffer: this.bufAlbedo! } },
				{ binding: 3, resource: { buffer: this.bufNormal! } },
				{ binding: 4, resource: { buffer: this.bufOrm! } },
				{ binding: 5, resource: { buffer: this.bufMask! } },
			],
		})

		const out: ForgedSurfaceSet[] = []
		let block = 0
		for (const def of defs) {
			const set = this.createSet(def, size, layers, mips)
			const enc = device.createCommandEncoder({ label: `steelseed/materials/forge/${def.id}` })
			for (let l = 0; l < layers; l++) {
				for (let m = 0; m < mips; m++) {
					const res = size >> m
					const groups = res / WORKGROUP
					const offset = block * this.paramStride
					block++

					const pass = enc.beginComputePass({ label: `${def.id}/l${l}/m${m}` })
					pass.setPipeline(this.fieldPipeline!)
					pass.setBindGroup(0, this.fieldGroup, [offset])
					pass.dispatchWorkgroups(groups, groups, 1)
					// Same pass, second dispatch: the field write and the field read are
					// separate usage scopes, so the implementation orders them for us.
					pass.setPipeline(this.packPipeline!)
					pass.setBindGroup(0, this.packGroup, [offset])
					pass.dispatchWorkgroups(groups, groups, 1)
					pass.end()

					this.copyOut(enc, this.bufAlbedo!, set.albedo, res, 4, m, l)
					this.copyOut(enc, this.bufNormal!, set.normal, res, 2, m, l)
					this.copyOut(enc, this.bufOrm!, set.orm, res, 4, m, l)
					this.copyOut(enc, this.bufMask!, set.mask, res, 1, m, l)
				}
			}
			device.queue.submit([enc.finish()])
			await device.queue.onSubmittedWorkDone()
			out.push(set)
		}
		return out
	}

	private copyOut(
		enc: GPUCommandEncoder,
		buffer: GPUBuffer,
		texture: GPUTexture,
		res: number,
		bytesPerTexel: number,
		mip: number,
		layer: number,
	): void {
		enc.copyBufferToTexture(
			{ buffer, offset: 0, bytesPerRow: align256(res * bytesPerTexel), rowsPerImage: res },
			{ texture, mipLevel: mip, origin: { x: 0, y: 0, z: layer } },
			{ width: res, height: res, depthOrArrayLayers: 1 },
		)
	}

	private createSet(def: SurfaceSetDef, size: number, layers: number, mips: number): ForgedSurfaceSet {
		const device = this.device
		// COPY_SRC so finished layers can be assembled into the §12.3b TerrainAtlas without
		// re-running generation. Copying the generated result guarantees an atlas layer is
		// byte-identical to the standalone set it came from — restructuring the forge to
		// generate straight into an atlas could silently change texture CONTENT, and §5.2
		// requires a given seed to produce identical bytes.
		const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC
		const dims = { width: size, height: size, depthOrArrayLayers: layers }

		const albedo = device.createTexture({
			label: `steelseed/materials/${def.id}/albedo`,
			size: dims,
			format: 'rgba8unorm',
			viewFormats: ['rgba8unorm-srgb'],
			mipLevelCount: mips,
			usage,
		})
		const normal = device.createTexture({
			label: `steelseed/materials/${def.id}/normal`,
			size: dims,
			format: 'rg8unorm',
			mipLevelCount: mips,
			usage,
		})
		const orm = device.createTexture({
			label: `steelseed/materials/${def.id}/orm`,
			size: dims,
			format: 'rgba8unorm',
			mipLevelCount: mips,
			usage,
		})
		const mask = device.createTexture({
			label: `steelseed/materials/${def.id}/mask`,
			size: dims,
			format: 'r8unorm',
			mipLevelCount: mips,
			usage,
		})

		const info = device.createBuffer({
			label: `steelseed/materials/${def.id}/info`,
			size: SET_INFO_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		})
		const infoData = new ArrayBuffer(SET_INFO_BYTES)
		const iu = new Uint32Array(infoData)
		const ifl = new Float32Array(infoData)
		iu[0] = layers
		iu[1] = mips
		ifl[4] = def.tileMeters
		// heightRange, not heightScale: the packed height channel spans wider than the
		// amplitude the generator composes at, so this is the number that decodes to
		// metres. Sourced from the same constant the pack shader encodes with.
		ifl[5] = def.heightScale * HEIGHT_ENCODE_SPAN
		ifl[6] = def.tileMeters / size
		device.queue.writeBuffer(info, 0, infoData)

		// Measured from the descriptors above, level by level — not a per-set constant.
		const vramBytes =
			textureBytes(size, layers, mips, albedo.format) +
			textureBytes(size, layers, mips, normal.format) +
			textureBytes(size, layers, mips, orm.format) +
			textureBytes(size, layers, mips, mask.format)

		return new ForgedSurfaceSet({
			id: def.id,
			albedo,
			normal,
			orm,
			mask,
			layerCount: layers,
			vramBytes,
			info,
			size,
			mipCount: mips,
			tileMeters: def.tileMeters,
			heightRange: def.heightScale * HEIGHT_ENCODE_SPAN,
		})
	}

	/**
	 * The whole parameter table, written once. Every value is drawn from a NAMED fork of
	 * the asset RNG, so adding a set or reordering the table cannot perturb the output of
	 * any other set — which is the property §5.2 and baseline.mjs actually depend on.
	 */
	private buildParams(defs: readonly SurfaceSetDef[], rng: Rng): ArrayBuffer {
		const { size, layers, mips } = this.plan
		const data = new ArrayBuffer(defs.length * layers * mips * this.paramStride)
		const u = new Uint32Array(data)
		const f = new Float32Array(data)
		const words = this.paramStride >> 2
		let block = 0

		for (const def of defs) {
			const setRng = rng.forkNamed(def.id)
			for (let l = 0; l < layers; l++) {
				const layerRng = setRng.forkNamed(`layer-${l}`)
				const seed = layerRng.nextU32()
				const seedB = layerRng.nextU32()
				const dir = ANI_DIRS[layerRng.int(0, ANI_DIRS.length)]
				const wearBias = clamp(def.wearBias + layerRng.signed(0.12), 0, 1)
				const jitter = Math.max(0, def.colorJitter * layerRng.range(0.7, 1.3))

				for (let m = 0; m < mips; m++) {
					const res = size >> m
					const o = block * words
					u[o + 0] = res
					u[o + 1] = def.kind
					u[o + 2] = l
					u[o + 3] = m
					u[o + 4] = seed
					u[o + 5] = seedB
					u[o + 6] = align256(res * 4) >> 2
					u[o + 7] = align256(res * 2) >> 2
					u[o + 8] = align256(res * 1) >> 2
					u[o + 9] = def.octaves
					f[o + 12] = def.tileMeters
					f[o + 13] = def.heightScale
					// Nyquist is expressed in lattice repeats per tile, which is what the
					// octave fade in fbm() compares against.
					f[o + 14] = res
					f[o + 15] = dir[0]
					f[o + 16] = dir[1]
					f[o + 17] = wearBias
					f[o + 18] = jitter
					// Per-layer material override, §12.1's layer index now doubling as
					// `geo/zone`'s material zone on unit sets. Scaling all three tints keeps
					// one colour model rather than introducing a second.
					const mod = def.layerMods?.[l]
					const ts = mod?.tintScale ?? 1
					const ra = mod?.roughAdd ?? 0
					writeTint(f, o + 20, def.tintA, ts, ra)
					writeTint(f, o + 24, def.tintB, ts, ra)
					writeTint(f, o + 28, def.tintC, ts, ra)
					block++
				}
			}
		}
		return data
	}

	/** Rule 7. Everything the forge itself owns; the sets own their own textures. */
	dispose(): void {
		this.fieldTex?.destroy()
		this.bufAlbedo?.destroy()
		this.bufNormal?.destroy()
		this.bufOrm?.destroy()
		this.bufMask?.destroy()
		this.params?.destroy()
		this.fieldTex = null
		this.fieldView = null
		this.bufAlbedo = null
		this.bufNormal = null
		this.bufOrm = null
		this.bufMask = null
		this.params = null
		this.fieldGroup = null
		this.packGroup = null
		this.fieldPipeline = null
		this.packPipeline = null
		this.fieldLayout = null
		this.packLayout = null
	}
}
