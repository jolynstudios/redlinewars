// STEELSEED — ui/types
// Structural mirrors of the §12 interfaces this node consumes, narrowed to what it calls.
//
// Same reasoning as `units/types.ts`: `render` and `terrain` are reached through ctx.get()
// (rule 3), TypeScript still needs a shape for what those calls return, and these are it.
// Narrowed rather than copied, because a member declared here that nothing calls can drift
// from the real contract without anything failing — a mirror is only safe while it is small.
//
// `ui` calls four things in total. That is the whole surface, and it should stay that way:
// selection is a client concern and the moment this file needs a fifth member is the moment
// to ask whether the work belongs in the node that owns the data instead.

import type { Mat4 } from '../core'

/** §12.2. Only the combined matrix — picking projects a point and needs nothing else. */
export interface Camera {
	readonly viewProj: Mat4
	/** The eye in world metres (render/types Camera.position): the exact pick casts from here. */
	readonly position?: ArrayLike<number>
}

/** Camera node surface used by structure placement. */
export interface CameraApi {
	pickGroundCell(screenX: number, screenY: number, ctx: import('../core').Ctx): { x: number; y: number } | null
	/** Exact ray-terrain hit under the cursor: world x/y/z plus the containing cell. */
	pickGroundPoint(screenX: number, screenY: number, ctx: import('../core').Ctx): { x: number; y: number; z: number; cellX: number; cellY: number } | null
	/**
	 * Four ground-plane corners of the current view, world XZ, clockwise from top-left.
	 * Writes 8 floats into `out`. False if the projection cannot be inverted.
	 */
	viewGroundQuad(out: Float32Array, screenW: number, screenH: number): boolean
	/** Snap the strategic camera focus to a world-space ground point. */
	focusWorld(worldX: number, worldZ: number): void
	/** Select one known simulation actor from an explicit UI interaction. */
	selectActor(actorId: number): void
	/** Replace the camera/order selection with a UI-resolved actor group. */
	selectActors(actorIds: readonly number[]): void
	/** Camera pivot target, world space: the marks-refresh signature reads it per frame. */
	readonly focus: Readonly<Float32Array>
	/** Raw camera yaw in radians, unbounded; 0 faces north. Navigation aids normalise for display. */
	readonly yaw: number
	/** Screen edges currently driving an edge scroll: 1 left, 2 right, 4 top, 8 bottom. */
	readonly edgeScrollMask: number
	/** Width of the edge-scroll band in CSS pixels, so the highlight cannot disagree with it. */
	edgeBandPx(width: number, height: number): number
	/** Pan in view space; one unit is one screen height of ground. */
	panByView(right: number, forward: number): void
	/** Zoom in notches; positive moves closer. */
	zoomByNotches(notches: number): void
	rotateBy(radians: number): void
	tiltBy(radians: number): void
	resetOrientation(): void
}

/** Presentation time-of-day surface. Nothing here reaches the simulation. */
export interface SkyApi {
	readonly daylightMode: import('../sky/types').DaylightMode
	setDaylightMode(mode: import('../sky/types').DaylightMode): void
	/** Runtime weather-presentation choice: 'auto' cycle or 'clear' skies. */
	setWeatherPreset(preset: string): void
	/** Live regional weather (skirmish 'World' mode): kind 0 clear / 2 rain / 3 snow. */
	setLiveWeather(kind: number, intensity: number, windSpeed: number): void
	readonly timeOfDay: number
}

/** §12.6 visibility surface used by the strategic overview. */
export interface ShroudApi {
	readonly unmodelled: boolean
	isVisible(cellX: number, cellY: number): boolean
	stateAt(cellX: number, cellY: number): number
	readonly revision?: number
}

/**
 * A mesh handle, opaque on purpose.
 *
 * `ui` takes one from `render.upload` and hands it straight back inside a DrawItem without
 * ever reading a member, so mirroring the buffer fields here would declare a coupling this
 * node does not have. `indexCount` is the single member kept: a structurally empty interface
 * accepts literally any object, and this must not silently accept something that is not a
 * mesh.
 */
export interface GpuMesh {
	readonly indexCount: number
	readonly aabbMin: ArrayLike<number>
	readonly aabbMax: ArrayLike<number>
}

/**
 * §12.2 draw submission, narrowed to the fields a selection ring sets.
 *
 * The skinning trio — `paletteBases`, `phases`, `damages` — is deliberately absent. A ring
 * is unskinned, has no surface animation and cannot take battle damage; declaring the fields
 * so they could be left null would be three more mirrors to keep honest for nothing. They
 * are optional on the real interface, so omitting them here stays assignable.
 */
export interface DrawItem {
	readonly mesh: GpuMesh
	readonly surfaceSet: string
	/** Column-major, 16 floats per instance. */
	readonly instances: Float32Array
	readonly instanceCount: number
	/** One byte per instance: the §4.10 player id owning it, or null for unowned. */
	readonly playerColors: Uint8Array | null
	/** Whole-item alpha for the late, depth-tested placement-ghost pass. */
	readonly opacity?: number
	/** Linear colour for ground UI geometry; still depth-tested, fogged and translucent. */
	readonly unlitColor?: Float32Array | null
	readonly castsShadow: boolean
}

export interface RenderApi {
	/** Upload a geo Mesh once, at boot. Returns a handle for DrawItem. */
	upload(mesh: import('../geo/mesh').Mesh, label: string): GpuMesh
	submit(item: DrawItem): void
	readonly camera: Camera
}

/** §12.3. A ring is a mark on the ground, so it needs the ground's height and nothing more. */
export interface TerrainApi {
	heightAt(worldX: number, worldY: number): number
	waterHeightAt(worldX: number, worldY: number): number | null
	readonly waterCellCount: number
	/** Map cell of the plane's first column/row, so a cell index can be resolved from a world point. */
	readonly originX: number
	readonly originY: number
	readonly cellsWide: number
	readonly cellsHigh: number
}

export interface UnitsApi {
	readonly roleActors?: ReadonlyMap<string, string>
	/** Match the unit renderer's visibility contract for actor types. */
	isRenderableType(typeId: number): boolean
	isShroudOnlyType(typeId: number): boolean
	/** Bars belong to combat units and buildings, never neutral scenery. */
	healthBarEligible(actorName: string): boolean
	/** Exact visible actor placement, including interpolation, aircraft altitude and waterline. */
	captureActorVisual(actorId: number, transform: Float32Array, offset: number,
		out: { mesh: GpuMesh | null; surfaceSet: string; playerColor: number }): boolean
	displayName(actorName: string): string
	semanticRole(actorName: string): string
	productionKind(actorName: string): number
	groupSelectable(actorName: string): boolean
	/** Whether the mod's manifest lists the named trait on this actor type. */
	hasRaTrait(actorName: string, trait: string): boolean
	selectionRadiusM(typeId: number): number
	/** Movement-audio weight class: 0 infantry · 1 light wheeled · 2 heavy tracked · 3 watercraft. */
	movementClass(typeId: number): number
	selectionHeightM(typeId: number): number
	/** MaxWeight of the actor's Cargo trait (infantry weigh 1, vehicles more), 0 without Cargo. */
	cargoCapacity(actorName: string): number
	/** Sum of AmmoPool magazines, 0 when the actor has no limited ammo. */
	ammoCapacity(actorName: string): number
	/** The OpenRA order the actor's deploy button must send, or null when the actor has no deploy order. */
	deployOrder(actorName: string): 'Unload' | 'DeployTransform' | 'GrantConditionOnDeploy' | 'Detonate' | null
	placementVisual(actorName: string): {
		readonly mesh: GpuMesh
		readonly surfaceSet: string
		readonly halfLen: number
		readonly halfWid: number
		readonly water: boolean
	} | null
}

/** Audio node surface the UI drives: announcer, soundtrack, faction bank wiring. */
export interface AudioApi {
	readonly eva: import('../audio/types').EvaApi
	readonly music: import('../audio/types').MusicApi
	/** Interface cues: own bus, own on/off and volume. Optional so harness stubs may omit it. */
	readonly ui?: import('../audio/types').UiSoundApi
	/** Point bank-first SFX at a match faction ('germany', …); falls to 'allied'. */
	setSfxFaction(factionId: string): void
	/** Inject the Vite-globbed faction -> slug -> clip-URL table (`./sfx-banks`). */
	setSfxBank(bank: Record<string, Record<string, string>> | null): void
}
