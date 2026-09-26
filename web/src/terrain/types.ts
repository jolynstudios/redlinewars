// STEELSEED — terrain/types
// Structural mirrors of the tier-1 interfaces ARCHITECTURE.md §12.1 and §12.2 pin.
//
// Hard rule 3 forbids importing another subsystem's module, so `render` and `materials`
// are reached only through ctx.get(). TypeScript still needs a shape for what those
// calls return, and these declarations ARE that shape — transcribed from §12, narrowed
// to the members terrain actually calls.
//
// Narrowed rather than copied whole on purpose: a member declared here that nothing
// calls is a member that can drift from the contract without anything failing, and §12
// exists precisely because a silently drifted interface cost a repair pass once.

import type { Mat4, Vec3 } from '../core'

// ---------------------------------------------------------------------------
// §12.2 — render
// ---------------------------------------------------------------------------

export interface Camera {
	readonly view: Mat4
	/** Reverse-Z, infinite far. Depth compare is `greater`, depth clear is 0. */
	readonly proj: Mat4
	readonly viewProj: Mat4
	readonly position: Vec3
	readonly nearPlane: number
}

export interface GpuMesh {
	readonly vertexBuffer: GPUBuffer
	readonly indexBuffer: GPUBuffer
	readonly indexCount: number
	readonly aabbMin: Vec3
	readonly aabbMax: Vec3
}

export interface DrawItem {
	readonly mesh: GpuMesh
	/** Key into MaterialsApi.get. */
	readonly surfaceSet: string
	/** Instance transforms, column-major, 16 floats each. */
	readonly instances: Float32Array
	readonly instanceCount: number
	readonly playerColors: Uint8Array | null
	readonly castsShadow: boolean
    readonly damages?: Float32Array
	/**
	 * §12.3b. Draw through render's blended-ground variant: `materialZone.xy` are atlas
	 * layers and `.z` is the weight between them, and `surfaceSet` is ignored for colour.
	 * Ignored by a renderer with no atlas, which then draws the pair's first element as a
	 * plain layer — wrong-looking, never fatal.
	 */
	readonly blendZones?: boolean
}

/**
 * The part of §12.2's environment terrain consumes. A NARROW mirror on purpose: rule 3
 * forbids importing render's module, and declaring only what is read keeps the coupling
 * to exactly the fields that would break this node if they changed.
 *
 * Terrain does not compute any of these. It used to compute all of them, from §4.2, with
 * a solar arc that disagreed with sky's — see writeFrameUniform in index.ts.
 */
export interface SkyEnvironment {
	/** Unit vector TOWARDS the sun, or towards the moon at night. */
	readonly sunDir: Vec3
	readonly sunColor: Vec3
	readonly sunIntensity: number
	/** Zenith radiance. Dim at night by construction — do not scale it by a day factor. */
	readonly skyColor: Vec3
	/** Multiplier on ambient. Overcast raises it; clear leaves it near 1. */
	readonly ambientScale: number
	/** Horizon radiance. Warm at twilight while the zenith stays blue. */
	readonly horizonColor: Vec3
	readonly aerialColor: Vec3
	/** Extinction per metre for aerial perspective. */
	readonly aerialDensity: number
}

export interface RenderApi {
    upload(mesh: import('../geo/mesh').Mesh, label: string): GpuMesh
	submit(item: DrawItem): void
	/**
	 * Tell render how deep the scenery ring is, in cells (one cell is one render metre).
	 *
	 * The world edge — the boundary curtain and the unexplored veil — is drawn as fractions
	 * of this, so both finish inside the geometry on every quality preset instead of against
	 * whichever preset an absolute band was written for. Terrain owns the number because
	 * terrain is what builds the ring, `?apron=` included.
	 */
	setApron(cells: number): void
	/** Atlas layer per cell, row-major, with the world position of cell (0,0): the per-pixel ground blend. */
	setCellLayers?(cells: Uint8Array<ArrayBuffer>, w: number, h: number, originX: number, originY: number): void
	readonly camera: Camera
	readonly colorFormat: GPUTextureFormat
	readonly depthFormat: GPUTextureFormat
	/** Live view of the pushed atmosphere. Read per frame; never retained (rule 6). */
	readonly environment: SkyEnvironment
}

// ---------------------------------------------------------------------------
// §12.1 — materials
// ---------------------------------------------------------------------------

export interface SurfaceSet {
	readonly id: string
	/** rgba8unorm array texture, layer per variant. */
	readonly albedo: GPUTexture
	/** rg8unorm octahedral-encoded normals. */
	readonly normal: GPUTexture
	/** r=roughness g=metalness b=ao a=height, packed into one rgba8unorm. */
	readonly orm: GPUTexture
	/** r8unorm player-colour mask. */
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
	/** §12.3b. Null on a backend where materials degraded — peek, never assume (rule 8). */
	readonly terrainAtlas: TerrainAtlasView | null
}

/**
 * The §12.3b atlas: every §8 surface in one array texture, so a single draw can sample two
 * and blend. Physical layer for (surface, variant) is `surface * variantsPerSurface +
 * variant` — terrain bakes that index into the vertex payload.
 */
export interface TerrainAtlasView {
	readonly surfaceCount: number
	readonly variantsPerSurface: number
	readonly layerCount: number
	readonly vramBytes: number
	readonly bindGroup: GPUBindGroup
}

// ---------------------------------------------------------------------------
// §12.3 — the interface this node implements
// ---------------------------------------------------------------------------

export interface TerrainApi {
	/** World-space height at a cell, for anim foot IK and vehicle suspension. */
	heightAt(worldX: number, worldY: number): number
	/** Surface type (§8) at a world position, for fx and audio. */
	surfaceAt(worldX: number, worldY: number): number
	/** Rendered level of the connected water body, or null on dry terrain. */
	waterHeightAt(worldX: number, worldY: number): number | null
	readonly cellsWide: number
	readonly cellsHigh: number
	readonly waterCellCount: number
}

/**
 * What terrain puts in a DrawItem: a §12.2 GpuMesh plus every field `render.upload()`
 * returns alongside one.
 *
 * Terrain builds its chunk buffers itself rather than through `upload()`, because
 * `upload()` takes a `geo/mesh` Mesh and rule 3 forbids importing that module — and
 * because a heightfield already exists as interleaved floats, so round-tripping it
 * through a Mesh would double the peak allocation at map load for nothing. The vertex
 * layout is byte-identical to the canonical static one (§3.1: stride 60, locations 0-5),
 * so the buffers are interchangeable with uploaded ones.
 *
 * The extra fields are a deliberate superset. §12.2's GpuMesh carries no index format,
 * no stride and no bounding sphere, so a renderer that needs them must get them from the
 * handle it minted — and a terrain chunk that arrives without them would read as
 * `undefined` in whichever of those the draw loop touches. Additive, so a renderer that
 * ignores them loses nothing.
 */
export interface TerrainGpuMesh extends GpuMesh {
	readonly label: string
	readonly indexFormat: GPUIndexFormat
	/** 60 — the canonical static vertex stride (§3.1). Terrain geometry is never skinned. */
	readonly stride: number
	readonly skinned: boolean
	readonly vertexCount: number
	/** xyz centre, w radius. Preallocated so a cull loop never builds one per frame. */
	readonly sphere: Float32Array
	readonly vertexBytes: number
	readonly indexBytes: number
}
