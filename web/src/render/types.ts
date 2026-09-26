// STEELSEED — render/types
// The pinned tier-1 interface, verbatim from ARCHITECTURE.md §12.2, plus the small
// internal shapes the renderer's own modules share.
//
// Nothing here may drift from §12.2. That section exists because §3.1's lesson — six
// modules built in parallel against an API nobody had written down — cost a repair pass.

import type { Mat4, Vec3 } from '../core'

export interface Camera {
	readonly view: Mat4
	readonly proj: Mat4          // reverse-Z, infinite far (see core/math m4.perspectiveReverseZ)
	readonly viewProj: Mat4
	readonly position: Vec3
	/** The ground focus the camera looks at; view-local scattering centres here. */
	readonly focus: Vec3
	readonly nearPlane: number
}

/**
 * The lighting environment, pushed by `sky` (§12.2). Render encodes it; it never derives it.
 *
 * ONE struct rather than several setters, deliberately. `skyColor` feeds three consumers —
 * the forward clear, `skyRadiance()` for specular ambient, and the probe volume's bounce
 * term — and the scene is currently lit by sun + probe ALONE (measured: sun ~38% of terrain
 * brightness, ambient ~12%, both zero renders exactly black). Splitting these into separate
 * calls would let dawn light the ground while the sky stayed at noon; one atomic push cannot.
 *
 * Copied on receipt, never retained, so the caller may reuse its instance every frame (rule 6).
 */
export interface SkyEnvironment {
	/** Unit vector TOWARDS the sun (or moon at night), render space, Y up. */
	readonly sunDir: Vec3
	/** Linear RGB of the direct beam. */
	readonly sunColor: Vec3
	/** Irradiance scale of the direct beam. */
	readonly sunIntensity: number
	/** Zenith radiance. Drives the forward clear, specular ambient and probe input. */
	readonly skyColor: Vec3
	/** Ground albedo the probe volume bounces the sun off. */
	readonly groundAlbedo: number
	/** Multiplier on all ambient/probe irradiance — overcast raises it, clear leaves it 1. */
	readonly ambientScale: number

	// -- the dome and aerial terms ------------------------------------------
	//
	// Everything below was previously INVENTED by render, from `skyColor` alone. The
	// horizon was literally `zenith * 1.45`, spelled out three times: once in the forward
	// clear, once in `skyRadiance()` and once in the probe's own copy of it. Three
	// hand-written approximations of a quantity `sky` already computes properly is the
	// same defect shape as two clocks — they cannot be kept in agreement by care, only by
	// deletion. Sky models it; render encodes it; there is now one source.

	/**
	 * Radiance at the horizon ring. NOT derivable from `skyColor`: at twilight the horizon
	 * runs warm while the zenith stays blue, which is the whole visual signature of dawn.
	 */
	readonly horizonColor: Vec3
	/** Radiance leaving the ground, i.e. the sky's lower hemisphere. Already albedo-weighted. */
	readonly groundRadiance: Vec3

	/**
	 * Unit vector TOWARDS the moon. Distinct from `sunDir`, which sky retargets onto the
	 * moon after civil twilight so the direct beam is always one lobe: this is the disc's
	 * position, and it is still meaningful while the sun is up.
	 */
	readonly moonDir: Vec3
	readonly moonColor: Vec3
	/** Disc and beam scale. Falls to 0 in daylight, so a daytime moon simply is not drawn. */
	readonly moonIntensity: number

	/** Colour distant geometry tends towards. Sky sets it to the horizon — same medium. */
	readonly aerialColor: Vec3
	/** Extinction per metre. `1 - exp(-density * distance)` is the blend towards `aerialColor`. */
	readonly aerialDensity: number

	/** 0 clear .. 1 solid. Threshold on the cloud field, not an opacity. */
	readonly cloudCoverage: number
	/** How much of the sky behind them the clouds actually hide. */
	readonly cloudOpacity: number
	/** Spatial frequency of the cloud field, in inverse metres. */
	readonly cloudScale: number
	/** Wind-driven drift, in metres. Accumulated by sky from absolute elapsed time. */
	readonly cloudOffsetX: number
	readonly cloudOffsetZ: number
	/** Hashed into the cloud field so cloud shape is a pure function of the asset seed (§5.2). */
	readonly cloudSeed: number
	readonly windX?: number
	readonly windZ?: number
	readonly windStrength?: number
	readonly rainIntensity?: number
	readonly snowIntensity?: number
	readonly snowCoverage?: number
	readonly surfaceWetness?: number
	readonly wetness?: number
	readonly motionTime?: number
	/** 0..1 lightning flash. Presentation only. */
	readonly lightning?: number
}

export interface DrawItem {
	readonly mesh: GpuMesh
	readonly surfaceSet: string      // key into MaterialsApi.get
	/** Instance transforms, column-major, 16 floats each. */
	readonly instances: Float32Array
	readonly instanceCount: number
	/** Per-instance player colour index, or null for unowned geometry. */
	readonly playerColors: Uint8Array | null
	/**
	 * Whole-item presentation opacity. Values below one use the dedicated late translucent
	 * pass and never write depth or shadows. Omitted is exactly opaque.
	 */
	readonly opacity?: number
	/**
	 * Translucent geometry that moves every frame without motion vectors (rain, snow). It
	 * also marks its pixels in the depth prepass so TAA uses the current frame there instead
	 * of averaging it into the still ground beneath. Static translucents leave it unset.
	 */
	readonly reactive?: boolean
	/** Linear colour for ground UI geometry; still depth-tested, fogged and translucent. */
	readonly unlitColor?: Float32Array | null
	/** Material albedo alpha cuts identical holes in colour, depth/reflection and shadows. */
	readonly alphaCutout?: boolean
	/**
	 * Bone-palette base per SOURCE instance. Renderer compaction copies the matching value
	 * into instance float 21; null or omitted means every instance is unskinned.
	 */
	readonly paletteBases?: Uint16Array | null
	/**
	 * Stable simulation ids per SOURCE instance. Present only for actor geometry that wants
	 * temporal motion; render treats the values as opaque cache keys. A missing id means the
	 * instance is static for TAA and its previous transform is its current transform.
	 */
	readonly motionIds?: Uint32Array | null
	/** Bone count shared by every rigged source instance in this item. */
	readonly boneCount?: number

	/**
	 * Per-SOURCE-instance packed left/right 12-bit texture fractions, or null for static geometry.
	 *
	 * Reaches the shader as §12.2's instance float 22 and scrolls the material of vertices in
	 * the running-gear zone — a track is a loop of tread over fixed wheels, so it has no rigid
	 * rotation to skin and a bone would drag the track run through the hull.
	 *
	 * Indexed like `paletteBases`, by source instance rather than packed slot, and for the same
	 * reason: the camera and shadow regions compact independently.
	 */
	readonly phases?: Float32Array | null

	/**
	 * Per-SOURCE-instance battle damage, 0 pristine to 1 destroyed, or null for geometry that
	 * cannot be damaged. Reaches the shader as §12.2's instance float 23.
	 */
	readonly damages?: Float32Array | null
	readonly castsShadow: boolean

	/**
	 * Draw through the §12.3b blended-ground variant instead of the ordinary one.
	 *
	 * The vertices must then carry an ATLAS layer pair in `materialZone.xy` and the
	 * secondary's weight in `.z`, and `surfaceSet` is ignored — the atlas bind group is used
	 * instead, because it holds every §8 surface at once. Only `terrain` sets this.
	 *
	 * A separate pipeline rather than a uniform flag: branching on the interpolated weight
	 * would put textureSample in non-uniform control flow, which WGSL forbids, and sampling
	 * both layers unconditionally would charge every unit in the game for a feature only the
	 * ground uses.
	 *
	 * Silently ignored when `materials` has no atlas — the item draws through the ordinary
	 * variant, which reads the layer pair as a plain layer index. Wrong-looking, not fatal.
	 */
	readonly blendZones?: boolean

	/**
	 * HDR emitter colour for this item's emissive-flagged vertices — three floats, linear, in the
	 * same units as `render/shaders.ts`'s built-in warm (6.45, 2.04, 0.30) and cool emitters.
	 * Omitted or null keeps the material set's own emitter class, which is what every item did
	 * before this field existed.
	 *
	 * WHY IT EXISTS. The emitter colour was a per-SET constant: `materials/wgsl-pack.ts` writes
	 * 0.25 for the Foundry and 0.75 for the Lattice into the albedo alpha and the fragment picks
	 * warm or cool from it. Two colours, both chosen by which texture set an item names — so a
	 * `geo/zone` layer could not move it (the zone selects a LAYER inside the set, not the class),
	 * and the two of them cannot be mixed into a third hue either, because the warm emitter is so
	 * red-dominant that solving for a pale machine-gun tracer overshoots red by 1.88x. Fifty
	 * authored per-weapon tracer colours in `src/weapon-visual-manifest.json` were therefore
	 * unreachable by construction, not merely unread.
	 *
	 * WHY IT IS SAFE. The value travels in the instance TINT, whose alpha is set to -1 to mark it.
	 * `playerColorTable` alphas are bytes divided by 255 and unowned instances write 0, so no
	 * existing instance can present a negative alpha and no existing draw changes. Per ITEM rather
	 * than per instance because the authored colour is constant within a weapon family; an item
	 * that also carries `playerColors` keeps the player repaint and ignores this.
	 */
	readonly emitterColor?: Float32Array | null
}

import type { Mesh as GeoMeshType } from '../geo/mesh'

export interface GpuMesh {
	readonly vertexBuffer: GPUBuffer
	readonly indexBuffer: GPUBuffer
	readonly indexCount: number
	readonly aabbMin: Vec3
	readonly aabbMax: Vec3
}

export interface RenderApi {
	/** Soft world-space particle, submitted for this frame; all values are copied. */
	addParticle(x:number,y:number,z:number,radius:number,r:number,g:number,b:number,alpha:number,age:number,seed:number,emission:number): void
	/** Upload a geo Mesh once, at boot. Returns a handle for DrawItem. */
	upload(mesh: GeoMeshType, label: string, cachedLods?: readonly GeoMeshType[], onFreshChain?: (chain: readonly GeoMeshType[]) => void): GpuMesh
	/** Upload three source-authored levels unchanged; no runtime mesh simplification. */
	uploadLods(levels: readonly import('../geo/mesh').Mesh[], label: string): GpuMesh
	/**
	 * Upload the local player's complete §4.7 visibility grid.
	 *
	 * Copied immediately. Values are ShroudState 0..2; render owns the GPU texture and
	 * callers retain ownership of the CPU array. The world origin is in render metres.
	 */
	setShroud(cells: Uint8Array, w: number, h: number, originX: number, originY: number): void
	/**
	 * Depth of the scenery ring outside the playable rectangle, in render metres (one cell
	 * is one metre). `terrain` owns this number — it is the ring it actually built, not the
	 * one the quality preset names, so `?apron=` and the gates that drop the ring are
	 * carried too.
	 *
	 * The world edge is drawn as fractions of it: both the boundary curtain and the
	 * unexplored veil must finish INSIDE the geometry or the world ends in a line against
	 * flat sky. Render seeds it from the preset at init, so a build with no `terrain` node
	 * still has a sane edge.
	 */
	setApron(cells: number): void
	/** Submit for this frame. Cleared every frame; callers re-submit in update(). */
	submit(item: DrawItem): void
	/** Reserve consecutive matrices in this frame's shared bone palette. */
	reserveBones(count: number): { base: number; matrices: Float32Array } | null
	/** Snapshot-event-only copy, before the next frame overwrites prior palette data. */
	copyCompletedBones(base: number, count: number, out: Float32Array): boolean
	/** Add a dynamic light this frame. Respects the §7 budget; excess is dropped by priority. */
	addLight(x: number, y: number, z: number, r: number, g: number, b: number, intensity: number, radius: number): void
	/** Direction points out from the lens; cosine half-angles, inner > outer. Shared light budget. */
	addSpotLight(x:number,y:number,z:number,dx:number,dy:number,dz:number,r:number,g:number,b:number,intensity:number,radius:number,innerCos:number,outerCos:number):void
	/** A heat shimmer this frame, bending the scene behind it (render/heat; four a frame at most). */
	addHeatSource?(x: number, y: number, z: number, radiusM: number, strengthPx: number): void
	readonly camera: Camera
	setCamera(view: Mat4, proj: Mat4, position: Vec3, focus?: Vec3): void

	/**
	 * Push the lighting environment. `sky` owns the model; render only encodes (§12.2).
	 *
	 * Copied immediately — the caller may reuse one preallocated instance every frame, and
	 * render retains no reference to it (rule 6).
	 *
	 * Call from `sky.update()` or `sky.onSnapshot()`. `render.lateUpdate()` writes the
	 * frame uniform, and node update order is topological, so an environment pushed during
	 * update is always seen by the same frame's encode. Render seeds a sane daylight
	 * environment at init, so a build with no `sky` node still boots lit (rule 8).
	 *
	 * There is deliberately no separate setter for sun, sky and ambient: they feed the
	 * forward clear, the specular ambient and the probe volume, and splitting them would
	 * let dawn light the ground while the sky stayed at noon.
	 */
	setEnvironment(env: SkyEnvironment): void

	/**
	 * The environment currently in force. Read it; never retain it (rule 6) — it is
	 * render's live struct and its contents change under you every frame.
	 *
	 * This exists so a node that draws through its OWN pipeline can light with the same
	 * sun as everything else. `terrain` did not have it, so it derived a sun from §4.2
	 * itself, with a different solar arc AND a different intensity curve from sky's. The
	 * ground was lit by one sun while the units standing on it, their shadows, the probe
	 * volume and the sky were lit by another. Nothing errors, nothing counts wrong, and it
	 * is invisible in a screenshot unless you know to look for it.
	 *
	 * Always populated: render seeds a daylight environment at init, so this is safe to
	 * read before `sky` has pushed anything, and safe in a graph with no `sky` node at all.
	 */
	readonly environment: SkyEnvironment
	/** Colour target format, so other nodes create compatible pipelines at boot (rule 10). */
	readonly colorFormat: GPUTextureFormat
	readonly depthFormat: GPUTextureFormat
	/** Per-frame counters for profile.mjs. Measured, never asserted. */
	readonly stats: { drawCalls: number; triangles: number; lights: number; pipelineCreations: number }
}

// ---------------------------------------------------------------------------
// Internal shapes. Not part of §12.2; shared between this node's own modules only.
// ---------------------------------------------------------------------------

/**
 * The environment as render stores it: same fields, writable, vectors still readonly
 * bindings so they are mutated in place rather than reassigned. One allocation for the
 * process lifetime (rule 6).
 */
export type MutableSkyEnvironment = {
	-readonly [K in keyof SkyEnvironment]: SkyEnvironment[K]
}

/**
 * What `upload()` actually returns. Structurally a GpuMesh plus everything the draw
 * loop needs to pick a pipeline variant without a side lookup — a WeakMap probe per
 * draw call would be a per-frame cost for information the handle already knows.
 */
export interface GpuMeshLevel extends GpuMesh {
	readonly label: string
	readonly indexFormat: GPUIndexFormat
	/** 60 (static) or 68 (skinned) — selects the pipeline variant. */
	readonly stride: number
	readonly skinned: boolean
	readonly vertexCount: number
	/** xyz local-space centre, w local-space radius. Preallocated for the cull loop. */
	readonly sphere: Float32Array
	readonly vertexBytes: number
	readonly indexBytes: number
}

export interface GpuMeshHandle extends GpuMeshLevel {
	/** Level 0 is this handle's full-detail geometry; later entries decrease in detail. */
	readonly lods?: readonly GpuMeshLevel[]
}

/**
 * The `materials` node's surface between us and it, structurally identical to §12.1.
 * Declared rather than imported: hard rule 3 forbids importing another subsystem's
 * module, and the instance is reached at runtime with ctx.get('materials').
 */
export interface SurfaceSet {
	readonly id: string
	readonly albedo: GPUTexture
	readonly normal: GPUTexture
	readonly orm: GPUTexture
	readonly mask: GPUTexture
	readonly layerCount: number
	readonly vramBytes: number
}

export interface MaterialsApi {
	get(id: string): SurfaceSet
	has(id: string): boolean
	readonly bindGroupLayout: GPUBindGroupLayout
	bindGroupFor(set: SurfaceSet): GPUBindGroup
	readonly totalVramBytes: number
	/**
	 * §12.3b. Every §8 surface in one array texture, with a bind group built against the
	 * layout above — so from here it is an ordinary material group that happens to hold
	 * all 13 surfaces. Null where materials degraded (rule 8).
	 */
	readonly terrainAtlas: { readonly bindGroup: GPUBindGroup; readonly layerCount: number } | null
}

/**
 * Every pipeline in this node is created through here so `stats.pipelineCreations` is a
 * measured counter and not an assertion. Rule 10 targets zero creations during play;
 * a number that is computed by the same code path that creates the object cannot lie.
 */
export interface GpuFactory {
	readonly device: GPUDevice
	renderPipeline(desc: GPURenderPipelineDescriptor): GPURenderPipeline
	computePipeline(desc: GPUComputePipelineDescriptor): GPUComputePipeline
}
