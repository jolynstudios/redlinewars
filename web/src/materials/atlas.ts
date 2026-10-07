// STEELSEED — materials/atlas
//
// The §12.3b TerrainAtlas: every §8 surface's textures gathered into ONE array texture so
// a single draw can sample two of them and blend between them.
//
// Why this exists. `terrain` used to submit one DrawItem per (chunk, surface), and §12.2
// gives a DrawItem exactly one surfaceSet — so a triangle belonged wholly to one surface
// and the shader had nothing to blend toward. Boundaries therefore landed exactly on cell
// edges: stair-stepped, and flickering under TAA jitter (measured 151/255 albedo swing at
// a fixed pixel). Two materials cannot be blended until they live in one array texture.
//
// Built by COPYING finished layers rather than by generating into an atlas directly. That
// is deliberate: the copy guarantees an atlas layer is byte-identical to the standalone
// set it came from, whereas restructuring the forge's (def, layer, mip) block walk could
// silently change texture content, and §5.2 requires a given seed to produce identical
// bytes. It costs a transient VRAM overlap at boot and nothing at all thereafter.

import type { SurfaceSet } from './api'

/** Physical layer for a (surface, variant) pair. §12.3b's flat index. */
export function atlasLayer(surface: number, variant: number, variantsPerSurface: number): number {
	return surface * variantsPerSurface + variant
}

export interface TerrainAtlas {
	readonly albedo: GPUTexture
	/** Sample through this — the texture holds sRGB-ENCODED bytes (§12.5). */
	readonly albedoView: GPUTextureView
	readonly normal: GPUTexture
	readonly normalView: GPUTextureView
	readonly orm: GPUTexture
	readonly ormView: GPUTextureView
	readonly mask: GPUTexture
	readonly maskView: GPUTextureView
	/** §8 surface count covered. Layer for (s, v) is `s * variantsPerSurface + v`. */
	readonly surfaceCount: number
	readonly variantsPerSurface: number
	readonly layerCount: number
	readonly size: number
	readonly mipCount: number
	readonly vramBytes: number
	/**
	 * Bind group, built against the §12.1 per-set layout so it drops into any pipeline that
	 * already binds a surface set. Handing out a ready group rather than the textures is
	 * what stops a consumer assembling one against the wrong layout.
	 */
	readonly bindGroup: GPUBindGroup
	destroy(): void
}

/**
 * Assemble the atlas from already-forged per-surface sets.
 *
 * `sets[i]` supplies the textures for §8 surface `i`; a hole in the array is filled by
 * repeating the previous present surface rather than left blank, because an unwritten
 * array layer samples as transparent black and would read as a hole in the battlefield
 * rather than as the missing-material error it is.
 */
export function buildTerrainAtlas(
	device: GPUDevice,
	sets: readonly (SurfaceSet | undefined)[],
	variantsPerSurface: number,
	size: number,
	mipCount: number,
	sampler: GPUSampler,
	/**
	 * The §12.1 per-set layout. The atlas group is built against THIS rather than against a
	 * layout of its own, so a consumer can bind it wherever a surface set would go — which
	 * is what lets render's blended-ground pipeline reuse its existing pipeline layout
	 * instead of needing a second one.
	 */
	setLayout: GPUBindGroupLayout,
	neutralDetail: GPUTextureView,
): TerrainAtlas {
	const surfaceCount = sets.length
	const layerCount = surfaceCount * variantsPerSurface
	const dims = { width: size, height: size, depthOrArrayLayers: layerCount }
	const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC

	const make = (label: string, format: GPUTextureFormat, viewFormats?: GPUTextureFormat[]): GPUTexture =>
		device.createTexture({
			label: `steelseed/materials/terrain-atlas/${label}`,
			size: dims,
			format,
			mipLevelCount: mipCount,
			usage,
			...(viewFormats ? { viewFormats } : {}),
		})

	// Formats mirror §12.1 exactly. albedo carries sRGB-encoded bytes and is sampled
	// through an -srgb view so the hardware decodes (§12.5); the raw texture is never
	// sampled directly.
	const albedo = make('albedo', 'rgba8unorm', ['rgba8unorm-srgb'])
	const normal = make('normal', 'rg8unorm')
	const orm = make('orm', 'rgba8unorm')
	const mask = make('mask', 'r8unorm')

	const enc = device.createCommandEncoder({ label: 'steelseed/materials/terrain-atlas/assemble' })

	let lastPresent = -1
	for (let s = 0; s < surfaceCount; s++) {
		if (sets[s]) lastPresent = s
		const src = sets[s] ?? (lastPresent >= 0 ? sets[lastPresent] : undefined)
		if (!src) continue

		for (let v = 0; v < variantsPerSurface; v++) {
			// Clamp into the source's own variant count: a set forged with fewer variants
			// than the atlas wants repeats its last rather than sampling an absent layer.
			// Clamp, never wrap (§12.5).
			const srcLayer = Math.min(v, src.layerCount - 1)
			const dstLayer = atlasLayer(s, v, variantsPerSurface)

			for (let m = 0; m < mipCount; m++) {
				const res = Math.max(1, size >> m)
				copyLayer(enc, src.albedo, albedo, srcLayer, dstLayer, m, res)
				copyLayer(enc, src.normal, normal, srcLayer, dstLayer, m, res)
				copyLayer(enc, src.orm, orm, srcLayer, dstLayer, m, res)
				copyLayer(enc, src.mask, mask, srcLayer, dstLayer, m, res)
			}
		}
	}

	device.queue.submit([enc.finish()])

	// 4 + 2 + 4 + 1 bytes per texel across the four targets, times the mip tail.
	const bytesPerTexel = 4 + 2 + 4 + 1
	let texels = 0
	for (let m = 0; m < mipCount; m++) {
		const res = Math.max(1, size >> m)
		texels += res * res
	}
	const vramBytes = texels * bytesPerTexel * layerCount

	const albedoView = albedo.createView({ dimension: '2d-array', format: 'rgba8unorm-srgb' })
	const normalView = normal.createView({ dimension: '2d-array' })
	const ormView = orm.createView({ dimension: '2d-array' })
	const maskView = mask.createView({ dimension: '2d-array' })

	// Terrain-only binding5 contract: one vec4 header (variant count), then13 vec4s
	// carrying UV scale. Input terrain UVs repeat every4m; each source keeps its own size.
	// Ordinary actor sets retain their independent32B info; only the blend shader reads this.
	const info = device.createBuffer({
		label: 'steelseed/materials/terrain-atlas/info',
		size: 224,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	})
	const dimensions = new Float32Array(56)
	dimensions[0] = variantsPerSurface
	for (let s = 0; s < surfaceCount; s++) dimensions[(s + 1) * 4] = 4 / (sets[s]?.tileMeters ?? 4)
	device.queue.writeBuffer(info, 0, dimensions)

	const bindGroup = device.createBindGroup({
		label: 'steelseed/materials/terrain-atlas',
		layout: setLayout,
		entries: [
			{ binding: 0, resource: sampler },
			{ binding: 1, resource: albedoView },
			{ binding: 2, resource: normalView },
			{ binding: 3, resource: ormView },
			{ binding: 4, resource: maskView },
			{ binding: 5, resource: { buffer: info } },
			{ binding: 6, resource: neutralDetail },
		],
	})

	return {
		albedo,
		albedoView,
		normal,
		normalView,
		orm,
		ormView,
		mask,
		maskView,
		bindGroup,
		surfaceCount,
		variantsPerSurface,
		layerCount,
		size,
		mipCount,
		vramBytes,
		destroy(): void {
			info.destroy()
			albedo.destroy()
			normal.destroy()
			orm.destroy()
			mask.destroy()
		},
	}
}

function copyLayer(
	enc: GPUCommandEncoder,
	src: GPUTexture,
	dst: GPUTexture,
	srcLayer: number,
	dstLayer: number,
	mip: number,
	res: number,
): void {
	// Guard rather than trust: a source forged at a different size or mip depth would
	// otherwise raise a validation error at finish(), which invalidates the WHOLE command
	// buffer — every other copy in this encoder included. That failure mode cost a day
	// once already (t1-render-6).
	if (mip >= src.mipLevelCount || srcLayer >= src.depthOrArrayLayers) return

	enc.copyTextureToTexture(
		{ texture: src, mipLevel: mip, origin: { x: 0, y: 0, z: srcLayer } },
		{ texture: dst, mipLevel: mip, origin: { x: 0, y: 0, z: dstLayer } },
		{ width: res, height: res, depthOrArrayLayers: 1 },
	)
}
