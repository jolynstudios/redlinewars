// STEELSEED — units/types
// Structural mirrors of the §12 interfaces this node consumes, narrowed to what it calls.
//
// `render`, `materials` and `terrain` are reached through ctx.get() (rule 3); TypeScript
// still needs a shape for what those calls return, and these declarations are it. Narrowed
// rather than copied whole: a member declared here that nothing calls can drift from the
// contract without anything failing.

import type { Mat4, Vec3 } from '../core'

import type { Mesh } from '../geo/mesh'
export interface Camera {
	readonly view: Mat4
	readonly proj: Mat4
	readonly viewProj: Mat4
	readonly position: Vec3
	/** The ground focus the camera looks at - the centre of view-local scattering. */
	readonly focus: Vec3
	readonly nearPlane: number
}

export interface GpuMesh {
	readonly vertexBuffer: GPUBuffer
	readonly indexBuffer: GPUBuffer
	readonly indexCount: number
	readonly aabbMin: Vec3
	readonly aabbMax: Vec3
	readonly sphere?: Float32Array
}

export interface DrawItem {
	readonly mesh: GpuMesh
	readonly surfaceSet: string
	/** Column-major, 16 floats per instance. */
	readonly instances: Float32Array
	readonly instanceCount: number
	/** One byte per instance: authoritative §4.10 player-table index, or null for unowned. */
	readonly playerColors: Uint8Array | null
	/** Source-instance bone-palette bases. Null means every instance is unskinned. */
	readonly paletteBases?: Uint16Array | null
	/** Stable actor ids used only as opaque temporal-cache keys by render. */
	readonly motionIds?: Uint32Array | null
	/** Bone count shared by this archetype bucket. */
	readonly boneCount?: number
	/** Source-instance surface-animation phase, in texture repeats. */
	readonly phases?: Float32Array | null
	/** Source-instance battle damage, 0 pristine to 1 destroyed. */
	readonly damages?: Float32Array | null
	readonly castsShadow: boolean
	readonly opacity?: number
	/** Rain and snow: marks its pixels for TAA in the depth prepass (render/types.ts). */
	readonly reactive?: boolean
	readonly alphaCutout?: boolean
	/** Linear colour drawn unlit (still fogged and translucent); see render DrawItem. */
	readonly unlitColor?: Float32Array | null
}

/** §4.11 animation state reached through the node graph, never a static subsystem import. */
export interface AnimApi {
	distanceOf(actorId: number): number
	interpolatedDistanceOf(actorId: number, alpha: number): number
	sideDistanceOf(actorId: number, lateralM: number, alpha: number): number
	/** 0 carried at the ready, 1 fully shouldered. Drives the aim clip's time AND its weight. */
	interpolatedAimOf(actorId: number, alpha: number): number
	/** Seconds since this actor's last observed shot, negative when it has never fired. */
	secondsSinceFire(actorId: number, alpha: number): number
	readonly trackedCount: number
}

export interface RenderApi {
	/** Upload a geo Mesh once, at boot. Returns a handle for DrawItem. */
	upload(mesh: Mesh, label: string, cachedLods?: readonly Mesh[], onFreshChain?: (chain: readonly Mesh[]) => void): GpuMesh
	uploadLods(levels: readonly import('../geo/mesh').Mesh[], label: string): GpuMesh
	submit(item: DrawItem): void
	/** Reserve consecutive matrices in this frame's shared bone palette. */
	reserveBones(count: number): { base: number; matrices: Float32Array } | null
	copyCompletedBones(base: number, count: number, out: Float32Array): boolean
	/** Existing point-light contract. There is no direction or cone in §12.2. */
	addLight(x: number, y: number, z: number, r: number, g: number, b: number, intensity: number, radius: number): void
	/** Direction points out from the lens; cosine half-angles, inner > outer. Shared light budget. */
	addSpotLight(x:number,y:number,z:number,dx:number,dy:number,dz:number,r:number,g:number,b:number,intensity:number,radius:number,innerCos:number,outerCos:number):void
	readonly camera: Camera
}

/** The sky values `units` uses to decide whether real lamps are needed. */
export interface SkyApi {
	readonly environment: {
		readonly sunColor: Vec3
		readonly sunIntensity: number
		readonly skyColor: Vec3
		readonly ambientScale: number
		readonly windStrength?: number
		readonly motionTime?: number
		readonly rainIntensity?: number
		readonly snowIntensity?: number
		/** Settled snow cover, 0..1. */
		readonly snowCoverage?: number
		readonly windX?: number
		readonly windZ?: number
	}
}

/** §12.3, for standing units on the ground the simulation actually uses. */
export interface TerrainReliefPack {
	w: number
	h: number
	originX: number
	originY: number
	presentationRelief: boolean
	height: Uint8Array
	ramp: Uint8Array
	metres: Float32Array
	cornerY: Float32Array
	waterLevel: Float32Array
	bridges: readonly { id: number; x: number; z: number; state: 'intact' | 'partial' | 'dead' }[]
}

export interface TerrainApi {
	heightAt(worldX: number, worldY: number): number
	surfaceAt(worldX: number, worldY: number): number
	waterHeightAt(worldX: number, worldY: number): number | null
	readonly cellsWide: number
	readonly cellsHigh: number
	/** Height field the scenery worker samples. Absent on test doubles that only stub heightAt. */
	reliefPack?(): TerrainReliefPack | null
}

/** §12.1 narrowed material view; source hash binds optional unique-UV actor assets. */
export interface MaterialsApi {
	has(id: string): boolean
	get(id: string): { readonly sourceSha256?: string }
}

/**
 * `shroud`'s narrowed mirror. §4.7 visibility, as much of it as `units` needs.
 *
 * `unmodelled` is a contract diagnostic. Production deliberately fails closed.
 */
export interface ShroudApi {
	isVisible(cellX: number, cellY: number): boolean
	stateAt(cellX: number, cellY: number): number
	readonly unmodelled: boolean
	/** Live visibility grid for the scenery worker. */
	grid?(): { cells: Uint8Array; width: number; height: number; originX: number; originY: number; seen: boolean }
}
