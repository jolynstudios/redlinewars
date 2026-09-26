// STEELSEED — fx/types
// Structural mirrors of the two node contracts short-lived combat FX consume.
//
// The simulation event is already an absolute world-space fact. This node needs render to
// draw it and shroud to decide whether the local player is allowed to see it; nothing else.
// In particular there is no terrain member here: correcting an absolute muzzle against a
// second height reconstruction would make presentation a second authority over simulation.

export interface GpuMesh {
	readonly indexCount: number
}

export interface DrawItem {
	readonly mesh: GpuMesh
	readonly surfaceSet: string
	/** Column-major, 16 floats per instance. */
	readonly instances: Float32Array
	readonly instanceCount: number
	readonly playerColors: Uint8Array | null
	readonly castsShadow: boolean
	/** Whole-item alpha. Below 1 uses the translucent pass. */
	readonly opacity?: number
	/**
	 * This item's own HDR emitter colour, three linear floats, or null for the material set's
	 * built-in warm/cool class.
	 *
	 * The mirror of `render/types.ts`'s field, and the reason the per-weapon tracer colours in
	 * `src/weapon-visual-manifest.json` are drawable at all: the emitter used to be a per-SET
	 * constant, so the whole engine offered two colours and a zone could not move either.
	 */
	readonly emitterColor?: Float32Array | null
	/** Linear colour for unlit translucent geometry (render/types `unlitColor`). */
	readonly unlitColor?: Float32Array | null
}

export interface RenderApi {
	/** Eye position only. A tracer has to be sized in pixels, and pixels need the distance. */
	readonly camera: { readonly position: import('../core').Vec3 }
	addParticle?(x:number,y:number,z:number,radius:number,r:number,g:number,b:number,alpha:number,age:number,seed:number,emission:number): void
	upload(mesh: import('../geo/mesh').Mesh, label: string): GpuMesh
	uploadLods?(meshes: readonly import('../geo/mesh').Mesh[], label: string): GpuMesh
	submit(item: DrawItem): void
	addLight(
		x: number,
		y: number,
		z: number,
		r: number,
		g: number,
		b: number,
		intensity: number,
		radius: number,
	): void
	/** A heat shimmer this frame (render/heat); the renderer keeps four a frame at most. */
	addHeatSource?(x: number, y: number, z: number, radiusM: number, strengthPx: number): void
}

/**
 * The DRAWN ground, which the simulation does not know about.
 *
 * Playable relief is synthesized in the browser: OpenRA believes a Marigold cell is flat while
 * the renderer raises it metres. So a position taken straight from a simulation event lands
 * under the hill it was fired from. `units` already places every actor through this probe;
 * effects must use the same one or they are buried.
 */
export interface TerrainApi {
 presentationHeightOffsetAt?(x:number,z:number):number
	waterHeightAt?(worldX: number, worldZ: number): number | null
	heightAt(worldX: number, worldZ: number): number
	/** Cell surface enum. Optional on shims that only need height. */
	surfaceAt?(worldX: number, worldZ: number): number
}

export interface ShroudApi {
	/** Diagnostic only. Missing visibility fails closed. */
	readonly unmodelled: boolean
	isVisible(cellX: number, cellY: number): boolean
}

/** Only the last drawn actor's presentation family, never hidden simulation state. */
export interface UnitsApi {
	visitVisibleInstances?(slot: string, sink: (matrix: Float32Array, offset: number, actorId: number) => void): void
	/**
	 * Metres to raise this actor's drawn muzzle effects. Presentation only: OpenRA still fires
	 * from where its rules say, and this moves the FLASH and the TRACER onto the barrel that is
	 * actually drawn. Without it a tank's shot leaves from between its own tracks.
	 */
	muzzleLiftOf(actorId: number): number
	/** Authored weapon name for one armament index, or '' when unknown. */
	weaponNameOf?(actorId: number, armament: number): string
	/** Exact drawn actor placement, for client overlays that ride an actor (parachutes). */
	selectionHeightM(typeId: number): number
	/** Selection footprint radius in metres (optional: gates may stub units without it). */
	selectionRadiusM?(typeId: number): number
	/** Lower-case Armor.Type of an actor type ('tree', 'wood', …); '' when unknown. */
	materialOf?(typeId: number): string
	captureActorVisual(actorId: number, transform: Float32Array, offset: number,
		out: { mesh: unknown; surfaceSet: string; playerColor: number }): boolean
	/**
	 * World-space barrel tip. Writes xyz into out[0..2] and barrel forward into out[3..5].
	 * False when the actor is hidden or has no authored muzzle.
	 */
	muzzleWorldOf?(
		actorId: number,
		armament: number,
		simX: number,
		simY: number,
		simZ: number,
		out: Float32Array,
		barrel?: number,
		shot?: number,
	): boolean
	/** The actor is drawn and seen now (a socketless source may use the event's own muzzle). */
	isDrawnSource?(actorId: number): boolean
	deathKindOf(actorId: number): number
	deathAltitudeOf(actorId: number): number | null
	/**
	 * Drain this frame's Heavy/Critical rung crossings to `sink`. Zero-cost when none. fx
	 * answers a crossing with a short burst; see fx/mushroom-cloud `burst`.
	 */
	drainRungTransitions(sink: (actorId: number, rung: number) => void): void
}
