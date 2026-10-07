// STEELSEED — sky contracts.
//
// Cross-node access is runtime-only (rule 3), so this file mirrors only the render
// surface sky actually calls. The richer SkyApi is owned here: render currently consumes
// the six-field lighting environment, while its future dome pass will consume the
// horizon, moon, cloud and aerial values from the same model.

import type { Vec3 } from '../core'

/**
 * Whether the presentation sun follows the match clock or is pinned. Mirrored by `ui`, which
 * offers it to the player; nothing in the simulation reads it.
 */
export type DaylightMode = 'auto' | 'day' | 'night' | 'world'

/** Verbatim mirror of ARCHITECTURE.md §12.2. */
export interface SkyEnvironment {
	/** Unit vector towards the sun, or towards the moon at night. Render space, Y up. */
	readonly sunDir: Vec3
	/** Linear RGB of the direct beam. */
	readonly sunColor: Vec3
	/** Irradiance scale of the direct beam. */
	readonly sunIntensity: number
	/** Zenith radiance, shared by the clear, specular ambient and probe input. */
	readonly skyColor: Vec3
	/** Ground albedo used by the probe volume's single-bounce approximation. */
	readonly groundAlbedo: number
	/** Multiplier on ambient and probe irradiance. */
	readonly ambientScale: number
	/** Radiance at the horizon ring. */
	readonly horizonColor: Vec3
	/** Albedo-weighted radiance leaving the ground. */
	readonly groundRadiance: Vec3
	/** Unit vector towards the moon, independent of the active direct-light lobe. */
	readonly moonDir: Vec3
	readonly moonColor: Vec3
	readonly moonIntensity: number
	/** Distant-geometry extinction colour and density per metre. */
	readonly aerialColor: Vec3
	readonly aerialDensity: number
	/** Coverage threshold and opacity of the seeded cloud field. */
	readonly cloudCoverage: number
	readonly cloudOpacity: number
	/** Cloud frequency in inverse metres. */
	readonly cloudScale: number
	/** Absolute wind-driven cloud drift in metres. */
	readonly cloudOffsetX: number
	readonly cloudOffsetZ: number
	/** Stable seed for the procedural cloud field. */
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
	readonly lightning?: number
}

/** Narrow runtime mirror of render's pinned API. */
export interface RenderApi {
	setEnvironment(environment: SkyEnvironment): void
}

/** One retained strike record, shared by visual lighting and delayed weather audio. */
export interface LightningStrike {
	readonly id: number
	readonly time: number
	readonly thunderTime: number
	readonly strength: number
	readonly pan: number
}

/**
 * The complete atmospheric model exposed by the sky node.
 *
 * Arrays are retained and mutated in place. Consumers must read them, never keep a copy
 * made per frame (rule 6).
 */
export interface SkyApi {
	readonly lightningStrike?: LightningStrike | null
	readonly environment: SkyEnvironment
	readonly horizonColor: Vec3
	readonly groundRadiance: Vec3
	readonly moonDir: Vec3
	readonly moonColor: Vec3
	readonly moonIntensity: number
	readonly aerialColor: Vec3
	readonly aerialDensity: number
	readonly cloudCoverage: number
	readonly cloudOpacity: number
	readonly cloudScale: number
	readonly cloudOffsetX: number
	readonly cloudOffsetZ: number
	readonly cloudSeed: number
	readonly windX?: number
	readonly windZ?: number
	readonly windStrength?: number
	readonly rainIntensity?: number
	readonly snowIntensity?: number
	readonly wetness?: number
	readonly motionTime?: number
	readonly lightning?: number
	readonly timeOfDay: number
	readonly weatherKind: number
	readonly weatherIntensity: number
}

export interface WeatherChange {
	kind: number
	intensity: number
}
