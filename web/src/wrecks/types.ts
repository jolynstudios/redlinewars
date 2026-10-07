// STEELSEED — wrecks/types
// Narrowed structural contracts consumed by persistent battlefield wrecks.

// `units` owns and uploads meshes. `wrecks` borrows immutable handles and copies only the
// last submitted transform; render remains the sole owner of every GPU resource (rule 7).

export type { GpuMesh } from '../render/types'
import type { GpuMesh } from '../render/types'

export interface ActorVisualCapture {
	mesh: GpuMesh | null
	surfaceSet: string
	playerColor: number
	boneCount: number
	paletteBase: number
}

export interface UnitsApi {
	deathKindOf(actorId: number): number
	deathAltitudeOf?(actorId:number):number|null
	/**
	 * The authored Dead-rung visual for whatever actor owns `mesh`, or null when that actor
	 * has no condition ladder. `units` owns the mesh; this only borrows the handle.
	 */
	deadRungOf(mesh: GpuMesh): { mesh: GpuMesh; surfaceSet: string } | null
	visitVisuals(visit: (mesh: GpuMesh, surfaceSet: string) => void): void
	captureActorVisual(
		actorId: number,
		outTransform: Float32Array,
		outOffset: number,
		out: ActorVisualCapture,
	): boolean
}

export interface DrawItem {
	readonly mesh: GpuMesh
	readonly surfaceSet: string
	readonly instances: Float32Array
	readonly instanceCount: number
	readonly playerColors: Uint8Array | null
	readonly paletteBases?: Uint16Array | null
	readonly motionIds?: Uint32Array | null
	readonly boneCount?: number
	readonly phases?: Float32Array | null
	readonly damages?: Float32Array | null
	readonly castsShadow: boolean
}

export interface RenderApi {
	submit(item: DrawItem): void
}

export interface ShroudApi {
	readonly unmodelled: boolean
	isVisible(cellX: number, cellY: number): boolean
}
