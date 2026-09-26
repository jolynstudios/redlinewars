// STEELSEED — terrain
// The battlefield, built from the simulation's cell grid and nothing else.
//
// ARCHITECTURE.md §12.3 pins the interface; §4.3 pins the data and the bar: "the render
// must match this grid exactly", "terrain never invents its own passability", and the
// gate is an overlay proof against that section. Every number this node draws — extent,
// height, surface, where a cliff is, where water is — is derived in terrain/grid.ts from
// the six u8 planes, and heightAt() reads the same function the mesh was built from, so
// the ground a unit stands on and the ground it is drawn on cannot drift apart.
//
// Cross-node access is runtime-only (rule 3): `render` and `materials` come from
// ctx.get(), never from an import. terrain/types.ts carries their shapes, transcribed
// from §12.

import {
	clamp,
	type Ctx,
	HeaderFlag,
	type Snapshot,
	Surface,
	type TerrainStaticView,
	wangleToRadians,
} from '../core'
import {
	BUCKET_COUNT,
	ChunkBuilder,
	type ChunkGeometry,
	chunkSizeFor,
	SURFACE_COUNT,
	VERTEX_STRIDE,
	WATER_BUCKET,
} from './chunks'
import { APRON_CHUNK, ApronGrid, apronWidthFor } from './apron'
import { FRAME_FLOATS, TerrainGpu } from './gpu'
import { TerrainGrid } from './grid'
import { BridgeKnowledge } from './bridge-contract'
import { BridgeScenery } from './bridge-scenery'
import type { DrawItem, MaterialsApi, RenderApi, SurfaceSet, TerrainApi, TerrainGpuMesh } from './types'

export type { TerrainApi } from './types'

/**
 * Surface-set ids, in §8 enum order. §12.1 requires materials to publish one set per
 * surface type under exactly these names, so the index into this array IS the surface
 * index the sim wrote into the cell.
 */
const SURFACE_SET_IDS: readonly string[] = [
	'soil', 'rock', 'sand', 'gravel', 'grass', 'road', 'metal',
	'concrete', 'water', 'shallow', 'snow', 'ash', 'resource',
]

/**
 * Nearest sibling per surface, used only if materials is missing a set.
 *
 * §8 says all 13 must be handled and that a silent default is a gate failure — so the
 * failure mode here is a *named* substitution plus one warning, never a chunk that
 * quietly stops drawing. Ordered by what actually looks least wrong: rock borrows
 * gravel, road borrows concrete, resource borrows gravel.
 */
const SURFACE_SIBLING: readonly string[] = [
	'sand', 'gravel', 'soil', 'rock', 'soil', 'concrete', 'concrete',
	'rock', 'shallow', 'water', 'sand', 'soil', 'gravel',
]

/**
 * Terrain's slice of the §7 budgets. The battlefield is the backdrop, not the subject:
 * units, structures, fx and shadows all draw from the same allowance, and a terrain that
 * spends it all is a terrain with nothing standing on it.
 */
const DRAW_SHARE = 0.35
const TRIANGLE_SHARE = 0.45

// The solar arc and the weather lighting table that used to live here are DELETED, not
// commented out. They were terrain's private answer to a question `sky` already answers,
// and keeping them as a fallback would have preserved exactly the ambiguity that made the
// disagreement invisible. Terrain reads render.environment; there is no second copy left
// to drift. §4.2's weather still reaches this node, but only as water chop — geometry,
// not light.

/** Absorption per metre of water, rgb. Red dies first; that is what makes depth read. */
const WATER_ABSORPTION_R = 0.46
const WATER_ABSORPTION_G = 0.17
const WATER_ABSORPTION_B = 0.09

interface ChunkPart {
	readonly water: boolean
	readonly indexBuffer: GPUBuffer
	readonly indexCount: number
	readonly indexFormat: GPUIndexFormat
	readonly bindGroup: GPUBindGroup | null
	readonly item: DrawItem
}

interface Chunk {
	readonly aabbMin: Float32Array
	readonly aabbMax: Float32Array
	readonly centreX: number
	readonly centreY: number
	readonly centreZ: number
	readonly vertexBuffer: GPUBuffer
	readonly parts: ChunkPart[]
	readonly triangleCount: number
}

export class Terrain implements TerrainApi {
	static id = 'terrain'
	static deps = ['render', 'materials']

	private readonly grid = new TerrainGrid()
    private readonly bridgeKnowledge = new BridgeKnowledge()
    private readonly bridgeScenery = new BridgeScenery()
    private terrainSource: TerrainStaticView | null = null
	/** Out-of-bounds scenery ring, rebuilt around `grid` at every map load. Presentation only. */
	private readonly apron = new ApronGrid()
	private apronWidth = 0
	private readonly builder = new ChunkBuilder()
	private readonly chunks: Chunk[] = []

	private render: RenderApi | null = null
	private materials: MaterialsApi | null = null
	private gpu: TerrainGpu | null = null

	private readonly frameData = new Float32Array(FRAME_FLOATS)
	/** Chunk vertices are already world-space, so every DrawItem shares one identity. */
	private readonly identity = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)
	/** Five frustum planes, xyzw each: left, right, bottom, top, near. */
	private readonly planes = new Float32Array(20)
	private readonly layerCounts = new Uint8Array(SURFACE_COUNT).fill(1)
	/** Resolved once at init, so a missing set warns once rather than once per chunk. */
	private readonly sets = new Array<SurfaceSet | null>(SURFACE_COUNT).fill(null)

	private visible = new Int32Array(0)
	private visibleDist = new Float32Array(0)
	private visibleCount = 0
	private budgetedCount = 0

	private chunkSize = 16
	private drawBudget = 64
	/** From `config.q.shadowCascades`. Part of §12.5's `2 + cascades` draw-call billing. */
	private shadowCascades = 2
	private triangleBudget = 1_000_000
	private variantSalt = 0
	/**
	 * Latched once `render` has drawn terrain itself through encode(). Both paths are
	 * real — §12.2's submit() is the pinned channel, encode() runs terrain's own triplanar
	 * and water pipelines — but doing both would draw the battlefield twice.
	 */
	private selfDrawn = false

	// -----------------------------------------------------------------------
	// §12.3 — TerrainApi
	// -----------------------------------------------------------------------

	/**
	 * Ground height in metres at a world position. `worldX` is render X and `worldY` is
	 * render Z — the two ground-plane axes; §12.4 puts height on render Y, which is what
	 * this returns. Allocation-free: anim calls it per foot per frame.
	 */
	heightAt(worldX: number, worldY: number): number {
		return this.grid.heightAt(worldX, worldY)
	}

	/** Offset applied only to browser-reconstructed relief; authored elevations are already absolute. */
	presentationHeightOffsetAt(x:number,z:number):number {return this.grid.hasPresentationRelief ? this.grid.heightAt(x,z) : 0}

	/** Surface type (§8) at a world position, same axis convention as heightAt. */
	surfaceAt(worldX: number, worldY: number): number {
		return this.grid.surfaceAt(worldX, worldY)
	}

	/** Flat surface of the connected water body at this world position; null on land. */
	waterHeightAt(worldX: number, worldY: number): number | null {
		return this.grid.waterHeightAt(worldX, worldY)
	}

	get cellsWide(): number {
		return this.grid.w
	}

	get cellsHigh(): number {
		return this.grid.h
	}

	reliefPack(): {
		w: number; h: number; originX: number; originY: number; presentationRelief: boolean
		height: Uint8Array; ramp: Uint8Array; metres: Float32Array; cornerY: Float32Array
		waterLevel: Float32Array; bridges: readonly { id: number; x: number; z: number; state: 'intact' | 'partial' | 'dead' }[]
	} | null {
		if (!this.grid.ready) return null
		return {
			w: this.grid.w, h: this.grid.h, originX: this.grid.originX, originY: this.grid.originY,
			presentationRelief: this.grid.hasPresentationRelief,
			height: this.grid.height, ramp: this.grid.ramp, metres: this.grid.heightMetres(),
			cornerY: this.grid.cornerYView(), waterLevel: this.grid.waterLevel, bridges: this.grid.bridges,
		}
	}

	/** Authoritative water coverage used by the HUD to explain map presentation. */
	get waterCellCount(): number {
		return this.grid.waterCellCount
	}

	/**
	 * World cell (and, at one cell per metre, world metre) of grid index (0,0) — the §4.2
	 * playable bounds. Public because `cellsWide`/`cellsHigh` are an EXTENT, not a
	 * position: a consumer that centres on `cellsWide * 0.5` centres on the wrong place
	 * unless it adds this. The camera does exactly that.
	 */
	get originX(): number {
		return this.grid.originX
	}

	get originY(): number {
		return this.grid.originY
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	async init(ctx: Ctx): Promise<void> {
		this.render = ctx.get<RenderApi>('render')
		this.materials = ctx.get<MaterialsApi>('materials')

		const q = ctx.config.q
		this.chunkSize = chunkSizeFor(q.name)
		// The lobby switch defaults the scenery ring off on every preset. `?apron=` stays an
		// explicit developer override, including `?apron=0` for geometry/performance gates.
		const apronParam = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('apron')
		const requestedApron = apronParam === null ? 0 : Number(apronParam)
		const apronOverride = Number.isFinite(requestedApron)
			? Math.min(128, Math.max(0, Math.floor(requestedApron)))
			: 0
		this.apronWidth = apronParam === '0'
			? 0
			: apronParam
				? apronOverride
				: ctx.config.distantMountains
					? (q.apronCells > 0 ? q.apronCells : apronWidthFor(q.name))
					: 0
		// The world edge is drawn as fractions of the ring's depth, and this is the only
		// place that knows what the ring will actually be.
		this.render.setApron(this.apronWidth)
		this.drawBudget = Math.max(16, Math.floor(q.drawCalls * DRAW_SHARE))
		this.triangleBudget = Math.floor(q.triangles * TRIANGLE_SHARE)
		// Read once here rather than per frame; §12.5's `2 + cascades` billing needs it.
		this.shadowCascades = q.shadowCascades
		// Forked by name so adding a call to another generator cannot shift terrain's
		// variant layout, which would break the byte-identical-per-seed property (§5.2).
		this.variantSalt = ctx.rng.forkNamed('terrain:variants').nextU32()

		const device = ctx.device
		if (device) this.gpu = new TerrainGpu(device, this.render.colorFormat, this.render.depthFormat, q.name === 'low' ? 1 : 8)

		// Rule 10: every pipeline AND every material bind group exists before frame 1.
		// materials is a declared dep, so its sets are finished by the time this runs, and
		// a bind group built at map load would be a bind group built during play.
		for (let s = 0; s < SURFACE_COUNT; s++) {
			const set = this.resolveSet(s)
			this.sets[s] = set
			if (!set) continue
			this.layerCounts[s] = clamp(set.layerCount, 1, 255)
			this.gpu?.bindGroupFor(set)
		}
		this.builder.configure(this.layerCounts, this.variantSalt, this.materials?.terrainAtlas?.variantsPerSurface ?? 1)
		this.writeStaticFrameFields()
        await this.bridgeScenery.init(ctx,this.render)
	}

	/**
	 * Rebuilds only at map load. terrain.static carries header flag 1<<0 (§4.1) and the
	 * decoder keeps the previous decode alive on every other tick — testing the view for
	 * presence instead of the flag would rebuild the entire battlefield 25 times a second.
	 */
	onSnapshot(snap: Snapshot, _prev: Snapshot | null, ctx: Ctx): void {
		const bridgeChanged=this.bridgeKnowledge.observe(snap,ctx)
        if ((snap.flags & HeaderFlag.terrainStaticPresent) === 0 && !bridgeChanged) return
		if ((snap.flags & HeaderFlag.terrainStaticPresent) !== 0 && snap.terrainStatic) {
            const v=snap.terrainStatic
            // Snapshot buffers are recycled. Discovery can rebuild between terrain
            // emissions, so keep the authoritative planes locally.
            this.terrainSource={w:v.w,h:v.h,type:v.type.slice(),height:v.height.slice(),ramp:v.ramp.slice(),passability:v.passability.slice(),resource:v.resource.slice(),surface:v.surface.slice()}
        }
        const view = this.terrainSource
        if (!view || view.w <= 0 || view.h <= 0) return
		// The grid origin lives in the WORLD section, not in terrain.static — §4.3's planes
		// start at (boundsLeft, boundsTop) and §12.5 makes offsetting terrain's job, since
		// the bridge deliberately does not pre-shift.
		this.rebuild(view, snap.world?.boundsLeft ?? 0, snap.world?.boundsTop ?? 0, ctx)
	}

	update(_dt: number, ctx: Ctx): void {
		const render = this.render
		if (!render) return
		this.writeFrameUniform(render, ctx)
        this.bridgeScenery.submit(this.bridgeKnowledge.known.values(),render)
		if (this.chunks.length === 0) return
		this.cullChunks(render)
		if (this.selfDrawn) return
		this.submitVisible(render)
	}

	dispose(): void {
		this.releaseChunks()
		this.gpu?.dispose()
		this.gpu = null
		this.grid.dispose()
		this.render = null
		this.materials = null
		this.visible = new Int32Array(0)
		this.visibleDist = new Float32Array(0)
		this.visibleCount = 0
		this.budgetedCount = 0
	}

	// -----------------------------------------------------------------------
	// Terrain-owned draw path — DEAD (no production caller)
	// -----------------------------------------------------------------------

	/**
	 * DEAD DRAW PATH. Draws the visible battlefield with terrain's own pipelines into a pass
	 * `render` supplies, ground first and water after, but no production caller invokes it.
	 * The live path is update() -> submitVisible() -> render.submit(). Do not diagnose a live
	 * terrain frame by editing gpu.ts or shaders.ts; those modules are only bound here.
	 *
	 * This exists because §12.2 exposes `colorFormat`, `depthFormat` and
	 * `MaterialsApi.bindGroupLayout` specifically "so other nodes create compatible
	 * pipelines at boot" — a renderer that drew everything itself would have no reason to
	 * publish either. §12 does not yet pin how a node hands its draws back, so this is
	 * terrain publishing its own entry point rather than terrain guessing render's. It is
	 * retained as a compatibility surface until a dedicated cleanup removes the alternate
	 * path; calling it latches DrawItem submission off so nothing draws twice.
	 *
	 * The pass must have `render.colorFormat` as target 0 and `render.depthFormat` as its
	 * depth attachment, cleared to 0 for reverse-Z.
	 */
	encode(pass: GPURenderPassEncoder): void {
		const gpu = this.gpu
		if (!gpu || this.budgetedCount === 0) return
		this.selfDrawn = true
		gpu.bindFrame(pass)

		pass.setPipeline(gpu.terrainPipeline)
		for (let k = 0; k < this.budgetedCount; k++) {
			const chunk = this.chunks[this.visible[k]]
			let bound = false
			for (let p = 0; p < chunk.parts.length; p++) {
				const part = chunk.parts[p]
				if (part.water || !part.bindGroup) continue
				if (!bound) {
					pass.setVertexBuffer(0, chunk.vertexBuffer)
					bound = true
				}
				pass.setBindGroup(1, part.bindGroup)
				pass.setIndexBuffer(part.indexBuffer, part.indexFormat)
				pass.drawIndexed(part.indexCount, 1, 0, 0, 0)
			}
		}

		// Water last and back to front: it does not write depth, so the layering has to
		// come from submission order.
		pass.setPipeline(gpu.waterPipeline)
		for (let k = this.budgetedCount - 1; k >= 0; k--) {
			const chunk = this.chunks[this.visible[k]]
			for (let p = 0; p < chunk.parts.length; p++) {
				const part = chunk.parts[p]
				if (!part.water || !part.bindGroup) continue
				pass.setVertexBuffer(0, chunk.vertexBuffer)
				pass.setBindGroup(1, part.bindGroup)
				pass.setIndexBuffer(part.indexBuffer, part.indexFormat)
				pass.drawIndexed(part.indexCount, 1, 0, 0, 0)
			}
		}
	}

	// -----------------------------------------------------------------------
	// Build
	// -----------------------------------------------------------------------

	private rebuild(view: TerrainStaticView, originX: number, originY: number, ctx: Ctx): void {
		this.releaseChunks()
		this.grid.bridges=[...this.bridgeKnowledge.known.values()]
        this.grid.build(view, originX, originY)
		this.builder.configure(this.layerCounts, this.variantSalt, this.materials?.terrainAtlas?.variantsPerSurface ?? 1)

		const size = this.chunkSize
		const cw = Math.ceil(this.grid.w / size)
		const ch = Math.ceil(this.grid.h / size)

		for (let cz = 0; cz < ch; cz++) {
			for (let cx = 0; cx < cw; cx++) {
				const x0 = cx * size
				const z0 = cz * size
				const x1 = Math.min(x0 + size, this.grid.w)
				const z1 = Math.min(z0 + size, this.grid.h)
				const geo = this.builder.build(this.grid, cx, cz, x0, z0, x1, z1)
				if (geo) this.uploadChunk(geo)
			}
		}

		const playableChunks = this.chunks.length
		let playableTriangles = 0
		for (const c of this.chunks) playableTriangles += c.triangleCount

		// The scenery ring. Built from the extended grid so its seam cells average the same
		// four heights the playable border does; chunks are coarse because nothing out
		// there needs fine culling, and they are all one draw bucket each.
		if (this.apronWidth > 0) {
			this.apron.buildAround(this.grid, this.apronWidth)
			const a = this.apronWidth
			const aw = this.apron.w
			const ah = this.apron.h
			const bands: readonly (readonly [number, number, number, number])[] = [
				[0, 0, aw, a],
				[0, a + this.grid.h, aw, ah],
				[0, a, a, a + this.grid.h],
				[a + this.grid.w, a, aw, a + this.grid.h],
			]
			for (const [bx0, bz0, bx1, bz1] of bands) {
				for (let z0 = bz0; z0 < bz1; z0 += APRON_CHUNK) {
					for (let x0 = bx0; x0 < bx1; x0 += APRON_CHUNK) {
						const geo = this.builder.build(this.apron, 1000 + x0, 1000 + z0, x0, z0, Math.min(x0 + APRON_CHUNK, bx1), Math.min(z0 + APRON_CHUNK, bz1))
						if (geo) this.uploadChunk(geo)
					}
				}
			}
		}

		// The per-pixel ground blend reads the four cells around every pixel from this map.
		// It covers the scenery ring when there is one, because the ring's cells continue the
		// grid and a seam at the playable border would be the same square edge again.
		const layerGrid = this.apronWidth > 0 ? this.apron : this.grid
		this.render?.setCellLayers?.(this.builder.cellLayerMap(layerGrid), layerGrid.w, layerGrid.h, layerGrid.originX, layerGrid.originY)

		this.visible = new Int32Array(this.chunks.length)
		this.visibleDist = new Float32Array(this.chunks.length)
		this.visibleCount = 0
		this.budgetedCount = 0

		let triangles = 0
		for (const c of this.chunks) triangles += c.triangleCount
		const relief = this.grid.reliefInfo
		console.info(
			`[terrain] ${this.grid.w}x${this.grid.h} cells, ${playableChunks} chunks of ${size}, ` +
				`${playableTriangles} triangles, ${ctx.config.q.name} preset; ` +
				`relief ${this.grid.minHeightM.toFixed(2)}..${this.grid.maxHeightM.toFixed(2)} m` +
				(relief ? ` (reconstructed: ${relief.terraces} levels, ${relief.cliffBands} cliff bands, ${relief.walls} rock walls, ${relief.hills} hills, tallest rock ${relief.maxRockM.toFixed(1)} m)` : ' (authored)') +
				`; apron ${this.apronWidth} cells, ${this.chunks.length - playableChunks} chunks, ${triangles - playableTriangles} triangles`,
		)
	}

	/**
	 * One vertex buffer per chunk, one index buffer per §8 surface present in it.
	 *
	 * The split is what lets a DrawItem name a single `surfaceSet` and still be exactly
	 * the cells the sim tagged with that surface — a chunk drawn once under an averaged
	 * material would put grass on the road and fail the overlay proof.
	 */
	private uploadChunk(geo: ChunkGeometry): void {
		const gpu = this.gpu
		// No device means the WebGL2 path. §12.2's GpuMesh is a pair of GPUBuffers, so the
		// submit channel is WebGPU-only by contract; the grid is still built, so heightAt,
		// surfaceAt, cellsWide and cellsHigh answer correctly for anim, fx and audio.
		if (!gpu) return

		const label = `terrain:chunk:${geo.chunkX},${geo.chunkZ}`
		const vertexBuffer = gpu.createVertexBuffer(geo.vertexData, label)
		const parts: ChunkPart[] = []
		// AABB-centred bounding sphere. Ritter would be tighter on a long chassis, but a
		// chunk is a flat square slab whose AABB centre is already its natural centre.
		const cx = (geo.aabbMin[0] + geo.aabbMax[0]) * 0.5
		const cy = (geo.aabbMin[1] + geo.aabbMax[1]) * 0.5
		const cz = (geo.aabbMin[2] + geo.aabbMax[2]) * 0.5
		const radius = Math.hypot(geo.aabbMax[0] - cx, geo.aabbMax[1] - cy, geo.aabbMax[2] - cz)

		for (let b = 0; b < BUCKET_COUNT; b++) {
			const indices = geo.indices[b]
			if (!indices || indices.length === 0) continue
			const water = b === WATER_BUCKET
			// Water still binds one set: its pipeline samples a single surface and reads
			// depth, not a blend. Ground names no set at all — the §12.3b atlas holds every
			// surface, and the per-vertex layer pair picks which two.
			const surface = water ? Surface.water : Surface.rock
			const set = water ? this.sets[surface] : null
			const { buffer, format, byteLength } = gpu.createIndexBuffer(indices, geo.vertexCount, `${label}:idx:${b}`)
			const mesh: TerrainGpuMesh = {
				vertexBuffer,
				indexBuffer: buffer,
				indexCount: indices.length,
				// The chunk's bounds, which conservatively contain every part of it.
				aabbMin: geo.aabbMin,
				aabbMax: geo.aabbMax,
				label: `${label}:${b}`,
				indexFormat: format,
				stride: VERTEX_STRIDE,
				skinned: false,
				vertexCount: geo.vertexCount,
				sphere: Float32Array.of(cx, cy, cz, radius),
				vertexBytes: geo.vertexData.byteLength,
				indexBytes: byteLength,
			}
			parts.push({
				water,
				indexBuffer: buffer,
				indexCount: indices.length,
				indexFormat: format,
				bindGroup: set ? gpu.bindGroupFor(set) : null,
				item: {
					mesh,
					// Ignored for ground: blendZones sends it down the atlas path. Named anyway
					// because the DEPTH prepass and the shadow passes still run this item, and a
					// DrawItem with an unresolvable set would be dropped before it got there.
					surfaceSet: set ? set.id : SURFACE_SET_IDS[surface],
					blendZones: !water,
					instances: this.identity,
					instanceCount: 1,
					playerColors: null,
					// Water casts no shadow: an opaque shadow from a transparent surface is
					// the single most obvious way procedural water looks wrong.
					castsShadow: !water,
				},
			})
		}
		if (parts.length === 0) return

		this.chunks.push({
			aabbMin: geo.aabbMin,
			aabbMax: geo.aabbMax,
			centreX: cx,
			centreY: cy,
			centreZ: cz,
			vertexBuffer,
			parts,
			triangleCount: geo.triangleCount,
		})
	}

	private releaseChunks(): void {
		this.chunks.length = 0
		this.gpu?.releaseChunkBuffers()
	}

	/**
	 * The SurfaceSet for a §8 surface, or its named sibling if materials is missing it.
	 * Returns null only when materials has neither, which is a materials bug. Called once
	 * per surface at init and cached, so a warning here fires 13 times at most, not once
	 * per chunk and never per frame.
	 */
	private resolveSet(surface: number): SurfaceSet | null {
		const materials = this.materials
		if (!materials) return null
		const id = SURFACE_SET_IDS[surface]
		if (materials.has(id)) return materials.get(id)
		const sibling = SURFACE_SIBLING[surface]
		if (materials.has(sibling)) {
			console.warn(`[terrain] materials has no surface set '${id}'; drawing those cells as '${sibling}'`)
			return materials.get(sibling)
		}
		console.warn(`[terrain] materials has neither '${id}' nor '${sibling}' — those cells will not draw`)
		return null
	}

	// -----------------------------------------------------------------------
	// Per frame
	// -----------------------------------------------------------------------

	/** Fields that never change once the quality preset is chosen. */
	private writeStaticFrameFields(): void {
		const f = this.frameData
		f[28] = WATER_ABSORPTION_R
		f[29] = WATER_ABSORPTION_G
		f[30] = WATER_ABSORPTION_B
		f[31] = 0.55
	}

	/**
	 * Camera, atmosphere and wind.
	 *
	 * The atmosphere is READ from render, never derived. This function used to compute its
	 * own solar arc from §4.2 — a different elevation curve, a different azimuth sweep and
	 * a different intensity ramp from the one `sky` publishes — which meant the ground was
	 * lit by one sun while the units standing on it, their shadows, the probe volume and
	 * the sky itself were lit by another. Nothing errored, no counter disagreed, and a
	 * screenshot looked plausible; only a dawn frame made it obvious, and only if you knew
	 * to compare the terrain's shading direction against the shadows falling across it.
	 *
	 * Terrain draws through its own pipeline, so it needs its own copy of these values.
	 * Needing a copy is not a licence to author a second version of them.
	 */
	private writeFrameUniform(render: RenderApi, ctx: Ctx): void {
		const gpu = this.gpu
		if (!gpu) return
		const f = this.frameData
		f.set(render.camera.viewProj, 0)
		const p = render.camera.position
		f[16] = p[0]
		f[17] = p[1]
		f[18] = p[2]
		f[19] = ctx.time.elapsed

		const env = render.environment
		f[20] = env.sunDir[0]
		f[21] = env.sunDir[1]
		f[22] = env.sunDir[2]
		f[23] = env.sunIntensity

		f[24] = env.sunColor[0]
		f[25] = env.sunColor[1]
		f[26] = env.sunColor[2]
		f[27] = env.ambientScale

		const environment = ctx.snapshot?.world?.environment ?? null
		const severity = environment ? clamp(environment.weatherIntensity / 1000, 0, 1) : 0
		f[32] = 0
		f[33] = 0
		f[34] = 0
		// Chop on the water surface. The only §4.2 weather term terrain still reads for
		// itself, because it drives geometry rather than light.
		f[35] = severity * 0.6
		if (environment) {
			// WAngle 0..1023 around the ground plane; §12.4 maps the sim's southing to +Z.
			const a = wangleToRadians(environment.windDirection)
			f[32] = Math.sin(a)
			f[33] = Math.cos(a)
			f[34] = clamp(environment.windSpeed / 1000, 0, 1)
		}

		f[36] = env.skyColor[0]
		f[37] = env.skyColor[1]
		f[38] = env.skyColor[2]
		f[39] = 0

		f[40] = env.horizonColor[0]
		f[41] = env.horizonColor[1]
		f[42] = env.horizonColor[2]
		f[43] = env.aerialDensity

		f[44] = env.aerialColor[0]
		f[45] = env.aerialColor[1]
		f[46] = env.aerialColor[2]
		f[47] = 0
		gpu.writeFrame(f)
	}

	/**
	 * Frustum cull, then order front to back and cut the tail that will not fit the §7
	 * budget. Front to back because that is both the right thing to drop (the far chunks)
	 * and the right order to draw (early-Z rejects the rest).
	 */
	private cullChunks(render: RenderApi): void {
		this.extractPlanes(render.camera.viewProj)
		const cam = render.camera.position
		const camX = cam[0]
		const camY = cam[1]
		const camZ = cam[2]
		const chunks = this.chunks
		const vis = this.visible
		const dist = this.visibleDist
		let n = 0
		for (let i = 0; i < chunks.length; i++) {
			const c = chunks[i]
			if (!this.aabbVisible(c.aabbMin, c.aabbMax)) continue
			const dx = c.centreX - camX
			const dy = c.centreY - camY
			const dz = c.centreZ - camZ
			vis[n] = i
			dist[n] = dx * dx + dy * dy + dz * dz
			n++
		}
		// Insertion sort: the visible set barely changes between frames, so it is already
		// nearly ordered and this is linear in practice. It also allocates nothing, which a
		// comparator sort on a boxed array would not manage.
		for (let i = 1; i < n; i++) {
			const d = dist[i]
			const v = vis[i]
			let j = i - 1
			while (j >= 0 && dist[j] > d) {
				dist[j + 1] = dist[j]
				vis[j + 1] = vis[j]
				j--
			}
			dist[j + 1] = d
			vis[j + 1] = v
		}
		this.visibleCount = n

		let draws = 0
		let triangles = 0
		let fits = 0
		// §12.5 draw-call accounting: `render` bills ONE DrawItem as `2 + shadowCascades`
		// calls when it casts a shadow — a depth prepass, a forward pass, and one per
		// cascade. Terrain sets castsShadow on every non-water part, so on the high preset
		// (4 cascades) each part costs SIX, not one. Billing them at one meant this node
		// believed it was inside a 35% share while actually consuming ~210% of the whole
		// frame's draw budget, and the real limiter was render's own clamp rather than this
		// one — which is the same as having no budget here at all.
		const perPart = 2 + this.shadowCascades
		for (let k = 0; k < n; k++) {
			const c = chunks[vis[k]]
			const cost = c.parts.length * perPart
			if (draws + cost > this.drawBudget) break
			if (triangles + c.triangleCount > this.triangleBudget) break
			draws += cost
			triangles += c.triangleCount
			fits = k + 1
		}
		this.budgetedCount = fits
	}

	private submitVisible(render: RenderApi): void {
		for (let k = 0; k < this.budgetedCount; k++) {
			const parts = this.chunks[this.visible[k]].parts
			for (let p = 0; p < parts.length; p++) render.submit(parts[p].item)
		}
	}

	/**
	 * Gribb-Hartmann planes from a column-major viewProj.
	 *
	 * Only five: the projection is reverse-Z with an infinite far plane (§12.2), so the
	 * far row is degenerate — `row3 + row2` is identically the near constant times w and
	 * culls nothing. Testing it anyway is how a reverse-Z port ends up culling the whole
	 * world on the first frame.
	 */
	private extractPlanes(m: Float32Array): void {
		const pl = this.planes
		for (let i = 0; i < 5; i++) {
			// row3 ± row_k, with row_k read as m[k], m[4+k], m[8+k], m[12+k].
			const k = i < 4 ? i >> 1 : 2
			const add = i === 0 || i === 2
			const s = add ? 1 : -1
			const o = i * 4
			pl[o] = m[3] + s * m[k]
			pl[o + 1] = m[7] + s * m[4 + k]
			pl[o + 2] = m[11] + s * m[8 + k]
			pl[o + 3] = m[15] + s * m[12 + k]
			const len = Math.hypot(pl[o], pl[o + 1], pl[o + 2])
			if (len < 1e-12) continue
			const inv = 1 / len
			pl[o] *= inv
			pl[o + 1] *= inv
			pl[o + 2] *= inv
			pl[o + 3] *= inv
		}
	}

	/** Positive-vertex test: the box is out only if its nearest corner is behind a plane. */
	private aabbVisible(min: Float32Array, max: Float32Array): boolean {
		const pl = this.planes
		for (let i = 0; i < 5; i++) {
			const o = i * 4
			const nx = pl[o]
			const ny = pl[o + 1]
			const nz = pl[o + 2]
			const px = nx >= 0 ? max[0] : min[0]
			const py = ny >= 0 ? max[1] : min[1]
			const pz = nz >= 0 ? max[2] : min[2]
			if (nx * px + ny * py + nz * pz + pl[o + 3] < 0) return false
		}
		return true
	}
}
