// STEELSEED — materials
// The texture forge. Complete PBR surface sets, generated on the GPU from
// (ctx.config.assetSeed, id) at boot, into array textures. Nothing here is sampled,
// regenerated, uploaded or allocated during play.
//
// Implements ARCHITECTURE.md §12.1 exactly. Static id is 'materials'; there are no deps
// — this node is the root of the materials -> render -> terrain chain.
//
// Pack format, which every sampling pipeline must decode identically (use `sampleWgsl`
// rather than writing a second decoder):
//
//   albedo  rgba8unorm  sRGB-encoded bytes, bound through an -srgb view so the hardware
//                       does the transfer decode. Linear values are inside 0.02..0.9.
//   normal  rg8unorm    OCTAHEDRAL-encoded tangent-space normal, +Z out of the surface.
//                       Two channels, not three — bandwidth (§12.1).
//   orm     rgba8unorm  r roughness, g metalness (exactly 0 or 1), b occlusion,
//                       a height centred on 0.5 and scaled by the set's heightScale.
//   mask    r8unorm     Player-colour coverage. Whole authored panels, with crisp
//                       boundaries on the generated structural lattice — a real repaint,
//                       not a hue shift over the silhouette (§9).
//
// Generation is a pure function of the asset seed (§5.2): every value comes from a NAMED
// fork of ctx.rng, the GPU noise is integer-hash based rather than trigonometric, and
// nothing reads a clock. Two runs of the same seed produce the same textures.

import type { Ctx, QualityBudget } from '../core'
import { rootRng } from '../core'
import type { MaterialsApi, SurfaceSet, TerrainAtlasView } from './api'
import { buildTerrainAtlas, type TerrainAtlas } from './atlas'
import { type ForgedSurfaceSet, LAYERS_PER_SET, planForge, TextureForge } from './forge'
import { SET_DEFS } from './sets'
import { buildBlenderPalette } from './blender'
import { loadSourceSurfaces, uploadSourceSurfaces } from './source-surfaces'
import { buildActorMasks } from './actor-masks'
import { buildDamageMasks } from './damage-masks'
import { buildLandmarkMasks } from './landmark-masks'
import { loadGroundSurfaces } from './ground-surfaces'
import { loadFoliageSurfaces, loadMeadowSurfaces } from './foliage-surfaces'
import { loadHumanSurfaces } from './human-surfaces'
import { loadRoleSurfaces } from './role-surfaces'
import { RIFLE_PACK, rolePackFlagState } from '../core/role-pack'
import { loadEnvironmentMaterials, uploadEnvironmentMaterials } from './environment'
import { Surface } from '../core'
import { SAMPLE_WGSL } from './wgsl-sample'

export type { MaterialsApi, SurfaceSet } from './api'
export { SetKind, type SurfaceSetDef } from './sets'

/**
 * The forge's share of the §7 texture VRAM ceiling. It is not the only consumer of that
 * budget — render targets, the shadow atlas, the probe volumes and the decal atlas all
 * come out of the same number — so the forge takes a quarter and degrades to fit rather
 * than spending the whole budget and leaving the renderer to overrun it (rule 9).
 */
const FORGE_VRAM_SHARE = 0.25

/**
 * Base resolution per preset. At 512 over a 4 m tile a texel is 7.8 mm, which puts §9's
 * half-metre detail band at 64 texels across and well inside the mip chain's Nyquist.
 */
function preferredSize(q: QualityBudget): number {
	switch (q.name) {
		case 'ultra-max':
		case 'ultra':
		case 'classic':
		case 'turbo':
		case 'high':
			return 512
		case 'medium':
			return 256
		case 'low':
			return 128
	}
}

/** Anisotropy is cheap here and buys a lot on ground planes seen at a grazing angle. */
function anisotropyFor(q: QualityBudget): number {
	switch (q.name) {
		case 'ultra-max':
		case 'ultra':
		case 'classic':
		case 'turbo':
			return 16
		case 'high':
			return 8
		case 'medium':
			return 4
		case 'low':
			return 1
	}
}

/**
 * §8 surface index -> set id, so the atlas can be assembled in enum order rather than in
 * whatever order `SET_DEFS` happens to list. Derived from the enum itself: a hand-written
 * table would silently drift the moment a surface is added.
 */
const SURFACE_SET_ID: readonly string[] = (() => {
	const out: string[] = []
	for (const [name, index] of Object.entries(Surface)) out[index as number] = name
	return out
})()

const SURFACE_COUNT = SURFACE_SET_ID.length

export class Materials implements MaterialsApi {
	static id = 'materials'
	static deps: readonly string[] = []

	/**
	 * The decode side of the pack format, as WGSL. Additive to the §12.1 pin: reach it
	 * with ctx.get('materials') and prepend it to a shader that samples a set. Shipping
	 * the inverse from the node that wrote the encoding is the only way to guarantee
	 * there is exactly one octahedral decode in the project.
	 */
	readonly sampleWgsl = SAMPLE_WGSL

	private device: GPUDevice | null = null
	private forge: TextureForge | null = null
	private sampler: GPUSampler | null = null
	private layout: GPUBindGroupLayout | null = null
	private sets = new Map<string, ForgedSurfaceSet>()
	private groups = new Map<SurfaceSet, GPUBindGroup>()
	private neutralDetail: GPUTexture | null = null
	private neutralDetailView: GPUTextureView | null = null
	/**
	 * Bytes the FORGE allocated, i.e. the per-surface sets it planned against its own
	 * `FORGE_VRAM_SHARE` slice. Deliberately not the module total: the §12.3b atlas is
	 * assembled outside the forge and charging it to the forge's slice would compare a
	 * number against a budget it was never planned against.
	 */
	private forgeVram = 0
	/** Bytes the atlas holds. Zero until it is built; see the accounting note at `totalVramBytes`. */
	private atlasVram = 0
	readonly environmentStats = { loaded: 0, bytes: 0, error: '' }
	readonly groundSourceStats = { loaded: 0, bakedSize: 0, residentSize: 0 }
	/** §12.3b. Null until built, and null forever if materials degraded (rule 8). */
	private atlas: TerrainAtlas | null = null

	get terrainAtlas(): TerrainAtlasView | null {
		return this.atlas
	}

	async init(ctx: Ctx): Promise<void> {
		const device = ctx.device
		if (!device) {
			// WebGL2 path. §12.1 is a WebGPU interface, so there is nothing honest to
			// build here — and hard rule 8 says a node that cannot run must not take the
			// boot down with it. get() and bindGroupLayout fail loudly if reached.
			console.info('[steelseed] materials: WebGPU unavailable, texture forge inert on the WebGL2 path')
			return
		}
		this.device = device

		this.sampler = device.createSampler({
			label: 'steelseed/materials/sampler',
			addressModeU: 'repeat',
			addressModeV: 'repeat',
			magFilter: 'linear',
			minFilter: 'linear',
			mipmapFilter: 'linear',
			maxAnisotropy: anisotropyFor(ctx.config.q),
		})

		// One layout, shared by every material-sampling pipeline in the project (§12.1).
		const sampled: GPUShaderStageFlags = GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE
		this.neutralDetail = device.createTexture({ label: 'steelseed/materials/neutral-detail', size: [1, 1], format: 'rgba8unorm',
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
		device.queue.writeTexture({ texture: this.neutralDetail }, new Uint8Array([255, 0, 0, 0]), { bytesPerRow: 4 }, [1, 1])
		this.neutralDetailView = this.neutralDetail.createView()
		this.forgeVram += 4
		const arrayTex: GPUTextureBindingLayout = { sampleType: 'float', viewDimension: '2d-array' }
		this.layout = device.createBindGroupLayout({
			label: 'steelseed/materials/bind-group-layout',
			entries: [
				{ binding: 0, visibility: sampled, sampler: { type: 'filtering' } },
				{ binding: 1, visibility: sampled, texture: arrayTex },
				{ binding: 2, visibility: sampled, texture: arrayTex },
				{ binding: 3, visibility: sampled, texture: arrayTex },
				{ binding: 4, visibility: sampled, texture: arrayTex },
				{ binding: 6, visibility: sampled, texture: { sampleType: 'float', viewDimension: '2d' } },
				{
					binding: 5,
					visibility: GPUShaderStage.VERTEX | sampled,
					// Per-set info is32B; terrain's per-surface scale table is224B.
					// Pipeline-specific shader requirements validate each actual binding.
					buffer: { type: 'uniform', minBindingSize: 0 },
				},
			],
		})

		let environment = null
		try { environment = await loadEnvironmentMaterials() }
		catch (error) { this.environmentStats.error = String(error); console.warn('[materials] Blender terrain fallback:', error) }
		const plan = planForge(
			SET_DEFS.length,
			Math.floor(ctx.config.q.textureVram * FORGE_VRAM_SHARE),
			Math.min(preferredSize(ctx.config.q), environment?.manifest.size ?? 512),
		)

		this.forge = new TextureForge(device, plan)
		await this.forge.init()

		// A named fork, so the materials stream is independent of every other generator's
		// call count — adding a mesh generator must not change a texture (§5).
		const rng = rootRng(ctx.config.assetSeed).forkNamed(`materials/v${ctx.config.generatorVersion}`)
		const built = await this.forge.build(environment ? SET_DEFS.filter(s => !(s.id in Surface)) : SET_DEFS, rng)
		if (environment) {
			built.push(...uploadEnvironmentMaterials(device, environment, plan.size, plan.layers, plan.mips))
			this.environmentStats.loaded = environment.manifest.surfaces.length
			this.environmentStats.bytes = environment.bytes.byteLength
		}
		const sourceSurfaces = await loadSourceSurfaces()
		if (sourceSurfaces) {
			// Phase0 opt-in actor library, plus the same verified concrete data in the
			// existing ground atlas. No gameplay cell or terrain geometry is changed.
			const industrial = uploadSourceSurfaces(device, sourceSurfaces, preferredSize(ctx.config.q))
			built.push(industrial)
			built.push(...await buildActorMasks(device, industrial, ctx.config.q.name === 'low' ? 128 : 256))
			built.push(...await buildDamageMasks(device, industrial, ctx.config.q.name === 'low' ? 128 : 256))
            built.push(...await buildLandmarkMasks(device, industrial, ctx.config.q.name === 'low' ? 128 : 256))
			const concrete = built.findIndex(set => set.id === 'concrete')
			if (concrete >= 0) {
				const replacement = uploadSourceSurfaces(device, sourceSurfaces, plan.size, 'concrete',
					Array<number>(plan.layers).fill(3), plan.mips, 4)
				built[concrete].dispose()
				built[concrete] = replacement
			}
		}
		const foliage = await loadFoliageSurfaces(device, ctx.config.q.name === 'low')
		if (foliage) built.push(foliage)
		const meadow = await loadMeadowSurfaces(device, ctx.config.q.name === 'low')
		if (meadow) built.push(meadow)
		// A shipped roster asset now names this set: e1 is drawn from the anatomical source, so
		// ordinary matches load its atlas. `humanunits=0` opts back out and fetches nothing.
		// Only an explicit request treats an absent atlas as fatal; the default path lets units
		// fall back to the procedural figure rather than refusing to boot.
		const studyQuery = new URLSearchParams(globalThis.location?.search ?? '')
		if (studyQuery.get('humanunits') !== '0') {
			const human = await loadHumanSurfaces(device, ctx.config.q.name === 'low')
			if (!human && studyQuery.get('humanunits') === '1')
				throw new Error('Requested human study has no baked material atlas')
			if (human) built.push(human)
			// One unique-UV atlas per anatomical role pack, the rifle's included, discovered from
			// web/.forge/*-surfaces/ at build time. `rifleunits` gates the rifle and `roleunits` every
			// other role: `=0` fetches nothing, `=1` makes a refusal fatal, as it always was for the
			// rifle. On the ordinary path a refused atlas costs its actors their new body and nothing
			// else; units draws them from the roster.
			const rifleFlag = studyQuery.get('rifleunits'), roleFlag = studyQuery.get('roleunits')
			const roles = await loadRoleSurfaces(device, ctx.config.q.name === 'low',
				(dir, slots) => rolePackFlagState(slots, rifleFlag, roleFlag) !== 'off',
				id => built.some(set => set.id === id))
			for (const { slots, reason } of roles.failures) {
				if (rolePackFlagState(slots, rifleFlag, roleFlag) === 'demanded') throw new Error(reason)
				console.warn(`[materials] role atlas unavailable, its actors keep the roster model: ${reason}`)
			}
			if (rifleFlag === '1' && !roles.sets.some(set => set.roleDir === RIFLE_PACK.dir)) throw new Error('Requested rifle atlas is absent')
			built.push(...roles.sets)
		}
		const ground = await loadGroundSurfaces()
		if (ground) {
			for (const replacement of uploadEnvironmentMaterials(device, ground, plan.size, plan.layers, plan.mips)) {
				const index = built.findIndex(set => set.id === replacement.id)
				if (index < 0) { replacement.dispose(); throw new Error(`Missing ground target ${replacement.id}`) }
				built[index].dispose(); built[index] = replacement
			}
			this.groundSourceStats.loaded = ground.manifest.surfaces.length
			this.groundSourceStats.bakedSize = ground.manifest.size
			this.groundSourceStats.residentSize = plan.size
		}
		for (const set of built) {
			this.sets.set(set.id, set)
			this.forgeVram += set.vramBytes
		}
		const blender = buildBlenderPalette(device)
		this.sets.set(blender.id, blender)
		this.forgeVram += blender.vramBytes

		// §12.3b TerrainAtlas: gather the §8 surfaces into one array texture so `terrain`
		// can blend across a boundary in a single draw. Assembled by COPYING finished
		// layers, so an atlas layer is byte-identical to the set it came from (§5.2).
		//
		// Built before the forge is disposed but after every set exists, and the per-surface
		// sets are KEPT: `terrain` will migrate to the atlas, but nothing else has yet, and
		// dropping them here would break any consumer mid-migration (rule 8). Removing them
		// is a separate step once terrain no longer names them.
		const surfaceSets: (SurfaceSet | undefined)[] = []
		for (let s = 0; s < SURFACE_COUNT; s++) surfaceSets.push(this.sets.get(SURFACE_SET_ID[s]))
		this.atlas = buildTerrainAtlas(device, surfaceSets, plan.layers, plan.size, plan.mips, this.sampler, this.layout, this.neutralDetailView)
		// The atlas allocation is REAL and was previously invisible: atlas.ts computed its own
		// vramBytes and nothing read it, so totalVramBytes under-reported the module by the
		// single largest allocation in it — 190.66 MiB of 425.31 MiB at `high`. Measured
		// independently at the WebGPU boundary by tools/vramgate.mjs; see issues/materials-1.md.
		this.atlasVram = this.atlas.vramBytes

		// The staging buffers and the scratch field texture have done their job; holding
		// them for the rest of the match would be VRAM spent on nothing (rule 7).
		this.forge.dispose()
		this.forge = null

		const variants = built.length > 0 ? built[0].layerCount : LAYERS_PER_SET
		console.info(
			`[steelseed] materials: ${built.length} sets, ${plan.size}px x ${variants} variants x ${plan.mips} mips, ` +
				`forge ${(this.forgeVram / 1048576).toFixed(1)} MB of ${(ctx.config.q.textureVram * FORGE_VRAM_SHARE / 1048576).toFixed(0)} MB share, ` +
				`atlas ${(this.atlasVram / 1048576).toFixed(1)} MB, ` +
				`total ${(this.totalVramBytes / 1048576).toFixed(1)} MB of ${(ctx.config.q.textureVram / 1048576).toFixed(0)} MB ceiling`,
		)
	}

	/**
	 * Rule 10: every bind group exists before frame 1. bindGroupFor caches, so the first
	 * frame finds all of them already built and creates nothing.
	 */
	prewarm(): void {
		if (!this.device) return
		for (const set of this.sets.values()) this.bindGroupFor(set)
	}

	onSnapshot(): void {}

	/** Nothing changes per frame. A surface set is final the moment init() returns. */
	update(): void {}

	resize(): void {}

	get(id: string): SurfaceSet {
		const s = this.sets.get(id)
		if (!s)
			throw new Error(
				`materials: no surface set '${id}'. Sets are the 13 §8 surface types plus foundry, lattice and drift, ` +
					`and they are built at boot — nothing is generated during play.`,
			)
		return s
	}

	has(id: string): boolean {
		return this.sets.has(id)
	}

	get bindGroupLayout(): GPUBindGroupLayout {
		if (!this.layout)
			throw new Error('materials: no bind group layout — the texture forge is inert on the WebGL2 path')
		return this.layout
	}

	bindGroupFor(set: SurfaceSet): GPUBindGroup {
		const cached = this.groups.get(set)
		if (cached) return cached
		if (!this.device || !this.layout || !this.sampler)
			throw new Error('materials: bindGroupFor before init(), or on the WebGL2 path where there is no device')

		const f = set as ForgedSurfaceSet
		const group = this.device.createBindGroup({
			label: `steelseed/materials/${set.id}`,
			layout: this.layout,
			entries: [
				{ binding: 0, resource: this.sampler },
				{ binding: 1, resource: f.albedoView },
				{ binding: 2, resource: f.normalView },
				{ binding: 3, resource: f.ormView },
				{ binding: 4, resource: f.maskView },
				{ binding: 5, resource: { buffer: f.info } },
				{ binding: 6, resource: (f as ForgedSurfaceSet & { detailMaskView?: GPUTextureView }).detailMaskView ?? this.neutralDetailView! },
			],
		})
		this.groups.set(set, group)
		return group
	}

	/**
	 * Every texture this module holds resident, forge sets AND the §12.3b atlas.
	 *
	 * It returned the forge's figure alone until 2026-07-30, which omitted the atlas — the
	 * largest single allocation in the module. profile.mjs and the boot log both consumed that
	 * short number, so any VRAM decision made before this was made on a figure 190.66 MiB
	 * light at `high`. tools/vramgate.mjs now cross-checks this against a descriptor census at
	 * the WebGPU boundary, which cannot inherit an arithmetic error made here.
	 *
	 * NOTE: the atlas currently DUPLICATES the 13 terrain surfaces that are also kept as
	 * individual sets (see the comment at the atlas build). Once terrain names only the atlas,
	 * dropping those sets is worth roughly half of this number.
	 */
	get totalVramBytes(): number {
		return this.forgeVram + this.atlasVram
	}

	/** The forge's own allocation, for comparison against its FORGE_VRAM_SHARE slice. */
	get forgeVramBytes(): number {
		return this.forgeVram
	}

	/** The §12.3b atlas allocation, previously computed by atlas.ts and read by nobody. */
	get atlasVramBytes(): number {
		return this.atlasVram
	}

	dispose(): void {
		this.forge?.dispose()
		this.forge = null
		// Rule 7: the atlas owns four array textures of its own, not views into the sets.
		this.atlas?.destroy()
		this.atlas = null
		for (const set of this.sets.values()) set.dispose()
		this.sets.clear()
		this.groups.clear()
		this.neutralDetail?.destroy()
		this.neutralDetail = null
		this.neutralDetailView = null
		this.layout = null
		this.sampler = null
		this.device = null
		this.forgeVram = 0
		this.atlasVram = 0
	}
}
