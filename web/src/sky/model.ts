// STEELSEED — sky atmospheric model.
//
// The simulation owns the clock and weather. This model turns §4.2's values into one
// coherent lighting environment: the direction and colour of the direct beam, the
// zenith/horizon radiance, ground bounce, clouds and aerial extinction all move together.
//
// This is deliberately CPU-only. `render` owns every shader and pipeline so its rule-10
// pipeline counter sees every creation. Sky describes; render encodes.

import { clamp, DEG2RAD, lerp, smoothstep, type Vec3, vec3 } from '../core'
import type { SkyApi, SkyEnvironment } from './types'
import { SurfaceWeather } from './surface-weather'

const TAU = Math.PI * 2
const LATITUDE = 45 * DEG2RAD
const SIN_LATITUDE = Math.sin(LATITUDE)
const COS_LATITUDE = Math.cos(LATITUDE)
const CIVIL_TWILIGHT_Y = Math.sin(-6 * DEG2RAD)
const NAUTICAL_TWILIGHT_Y = Math.sin(-12 * DEG2RAD)
const FULL_DAY_Y = Math.sin(12 * DEG2RAD)

const WEATHER_CLEAR = 0
const WEATHER_OVERCAST = 1
const WEATHER_RAIN = 2
const WEATHER_SNOW = 3
const WEATHER_DUST = 4
const WEATHER_COUNT = 5

/** One value per §4.2 weather kind. */
const SUN_SCALE = Float32Array.of(1, 0.28, 0.14, 0.42, 0.55)
const AMBIENT_SCALE = Float32Array.of(1, 1.45, 1.2, 1.6, 1.12)
const SKY_SCALE = Float32Array.of(1, 0.86, 0.62, 1.08, 0.8)
// Mineral dust has to replace most of the clear blue spectrum, not merely dim it.
// A low dust value left maximum-severity captures blue-grey even though the direct beam
// was correctly ochre; the same suspended medium colours the whole path.
const SKY_DESATURATION = Float32Array.of(0, 0.78, 0.62, 0.68, 0.82)
const GROUND_ALBEDO = Float32Array.of(0.22, 0.18, 0.15, 0.7, 0.3)
const CLOUD_COVERAGE = Float32Array.of(0.16, 0.94, 1, 0.9, 0.62)
const CLOUD_OPACITY = Float32Array.of(0.16, 0.9, 1, 0.86, 0.48)
const AERIAL_DENSITY = Float32Array.of(0.0015, 0.008, 0.018, 0.011, 0.035)

/**
 * RGB multipliers, not display tints. They describe real suspended media: water droplets
 * flatten the spectrum, falling snow brightens it, and mineral dust removes blue first.
 */
const WEATHER_R = Float32Array.of(1, 0.98, 0.82, 1.02, 1.28)
const WEATHER_G = Float32Array.of(1, 1, 0.92, 1.04, 0.94)
const WEATHER_B = Float32Array.of(1, 1.04, 1.06, 1.1, 0.62)

// Night sky and moonlight are lifted well above a physical night. Measured on the composed
// build, a physically scaled night rendered at mean luma 0.020 against day's 0.352, with a
// standard deviation of 0.020: the battlefield was not dim, it was gone, and the player's
// report was "it is dark i cant see anything". These values keep the blue cast and the low
// key while putting shapes back on the screen; nightreadabilitygate holds the measurement.
const NIGHT_ZENITH = Float32Array.of(0.030, 0.052, 0.118)
const DAY_ZENITH = Float32Array.of(0.15, 0.27, 0.5)
const NIGHT_HORIZON = Float32Array.of(0.052, 0.076, 0.140)
const DAY_HORIZON = Float32Array.of(0.34, 0.44, 0.61)

function luminance(r: number, g: number, b: number): number {
	return r * 0.2126 + g * 0.7152 + b * 0.0722
}

function finite3(value: Vec3): boolean {
	return Number.isFinite(value[0]) && Number.isFinite(value[1]) && Number.isFinite(value[2])
}

/**
 * Allocation-free, continuously varying atmospheric state.
 *
 * The daily solar arc is an equinox at 45° latitude. The sim does not yet carry season or
 * latitude, so a fixed physically plausible arc is more honest than inventing either.
 */
export class SkyModel implements SkyEnvironment, SkyApi {
	private readonly surfaceState = new SurfaceWeather()
	get snowCoverage(): number { return this.surfaceState.snowCoverage }
	get surfaceWetness(): number { return this.surfaceState.surfaceWetness }
	readonly sunDir = vec3(0, 1, 0)
	readonly sunColor = vec3(1, 0.95, 0.82)
	sunIntensity = 0
	readonly skyColor = vec3()
	groundAlbedo = 0.22
	ambientScale = 1

	readonly horizonColor = vec3()
	readonly groundRadiance = vec3()
	readonly moonDir = vec3(0, 1, 0)
	readonly moonColor = vec3(0.42, 0.52, 0.72)
	moonIntensity = 0
	readonly aerialColor = vec3()
	aerialDensity = AERIAL_DENSITY[WEATHER_CLEAR]
	cloudCoverage = CLOUD_COVERAGE[WEATHER_CLEAR]
	cloudOpacity = CLOUD_OPACITY[WEATHER_CLEAR]
	cloudScale = 0.0035
	cloudOffsetX = 0
	cloudOffsetZ = 0
	cloudSeed = 0
	timeOfDay = 720
	weatherKind = WEATHER_CLEAR
	weatherIntensity = 0

	windX = 0
	windZ = 0
	private windSpeed = 0
	windStrength = 0
	rainIntensity = 0
	snowIntensity = 0
	wetness = 0
	lightning = 0
	motionTime = 0

	get environment(): SkyEnvironment {
		return this
	}

	setCloudSeed(seed: number): void {
		this.cloudSeed = seed >>> 0
	}

	/**
	 * Rebuild from authoritative §4.2 values. Called on snapshot boundaries, never from a
	 * free-running presentation clock.
	 */
	evaluate(
		timeOfDay: number,
		weatherKind: number,
		weatherIntensity: number,
		windDirection: number,
		windSpeed: number,
	): void {
		const minutes = ((timeOfDay % 1440) + 1440) % 1440
		const kind = weatherKind >= 0 && weatherKind < WEATHER_COUNT
			? weatherKind
			: WEATHER_CLEAR
		const severity = clamp(weatherIntensity / 1000, 0, 1)
		this.timeOfDay = minutes
		this.weatherKind = kind
		this.weatherIntensity = Math.round(severity * 1000)

		// Solar equinox arc: east at 06:00, south and 45° high at noon, west at 18:00.
		const hourAngle = (minutes / 1440 - 0.5) * TAU
		const east = -Math.sin(hourAngle)
		const south = Math.cos(hourAngle) * SIN_LATITUDE
		const up = Math.cos(hourAngle) * COS_LATITUDE

		this.moonDir[0] = -east
		this.moonDir[1] = -up
		this.moonDir[2] = -south
		const moonUp = Math.max(0, this.moonDir[1])
		this.moonIntensity = (0.34 + 0.62 * moonUp) *
			(1 - smoothstep(NAUTICAL_TWILIGHT_Y, CIVIL_TWILIGHT_Y, up))

		const useMoon = up < CIVIL_TWILIGHT_Y
		if (useMoon) {
			this.sunDir[0] = this.moonDir[0]
			this.sunDir[1] = this.moonDir[1]
			this.sunDir[2] = this.moonDir[2]
			this.sunColor[0] = this.moonColor[0]
			this.sunColor[1] = this.moonColor[1]
			this.sunColor[2] = this.moonColor[2]
			this.sunIntensity = this.moonIntensity
		} else {
			this.sunDir[0] = east
			this.sunDir[1] = up
			this.sunDir[2] = south
			const high = smoothstep(0, Math.sin(50 * DEG2RAD), up)
			const low = 1 - high
			this.sunColor[0] = 1
			this.sunColor[1] = 0.96 - 0.31 * low
			this.sunColor[2] = 0.9 - 0.58 * low
			const direct = smoothstep(CIVIL_TWILIGHT_Y, FULL_DAY_Y, up)
			this.sunIntensity = (0.08 + 4.7 * Math.sqrt(Math.max(0, up))) * direct
		}

		const day = smoothstep(NAUTICAL_TWILIGHT_Y, FULL_DAY_Y, up)
		const twilight =
			smoothstep(NAUTICAL_TWILIGHT_Y, 0.04, up) *
			(1 - smoothstep(0.04, 0.36, up))
		for (let i = 0; i < 3; i++) {
			this.skyColor[i] = lerp(NIGHT_ZENITH[i], DAY_ZENITH[i], day)
			this.horizonColor[i] = lerp(NIGHT_HORIZON[i], DAY_HORIZON[i], day)
		}
		// Long-path scattering warms the horizon, while the zenith stays predominantly blue.
		this.horizonColor[0] += twilight * 0.26
		this.horizonColor[1] += twilight * 0.075
		this.horizonColor[2] += twilight * 0.012
		this.skyColor[0] += twilight * 0.018
		this.skyColor[2] += twilight * 0.012

		const skyLum = luminance(this.skyColor[0], this.skyColor[1], this.skyColor[2])
		const horizonLum = luminance(
			this.horizonColor[0],
			this.horizonColor[1],
			this.horizonColor[2],
		)
		const desaturate = SKY_DESATURATION[kind] * severity
		const skyScale = lerp(1, SKY_SCALE[kind], severity)
		this.applyWeatherColor(this.skyColor, skyLum, kind, desaturate, skyScale)
		this.applyWeatherColor(this.horizonColor, horizonLum, kind, desaturate, skyScale)

		this.sunIntensity *= lerp(1, SUN_SCALE[kind], severity)
		this.ambientScale = (0.66 + day * 0.34) *
			lerp(1, AMBIENT_SCALE[kind], severity)
		const clearGround = lerp(0.12, GROUND_ALBEDO[WEATHER_CLEAR], day)
		this.groundAlbedo = lerp(clearGround, GROUND_ALBEDO[kind], severity)

		// Direct light passes through the same suspended medium as the horizon.
		this.sunColor[0] *= lerp(1, WEATHER_R[kind], severity)
		this.sunColor[1] *= lerp(1, WEATHER_G[kind], severity)
		this.sunColor[2] *= lerp(1, WEATHER_B[kind], severity)

		this.cloudCoverage = lerp(
			CLOUD_COVERAGE[WEATHER_CLEAR],
			CLOUD_COVERAGE[kind],
			severity,
		)
		this.cloudOpacity = lerp(
			CLOUD_OPACITY[WEATHER_CLEAR],
			CLOUD_OPACITY[kind],
			severity,
		)
		this.aerialDensity = lerp(
			AERIAL_DENSITY[WEATHER_CLEAR],
			AERIAL_DENSITY[kind],
			severity,
		)
		// Night haze: at night the aerial mist reads as a wall over an already dark
		// scene, so the same weather density is thinned out as daylight fades.
		this.aerialDensity *= lerp(0.35, 1, day)
		this.aerialColor[0] = this.horizonColor[0]
		this.aerialColor[1] = this.horizonColor[1]
		this.aerialColor[2] = this.horizonColor[2]
		this.groundRadiance[0] = this.skyColor[0] * this.groundAlbedo
		this.groundRadiance[1] = this.skyColor[1] * this.groundAlbedo
		this.groundRadiance[2] = this.skyColor[2] * this.groundAlbedo

		// WAngle is 0..1023 around the sim ground plane. Render uses X east, Z south.
		const windAngle = (windDirection / 1024) * TAU
		this.windX = -Math.sin(windAngle)
		this.windZ = -Math.cos(windAngle)
		this.windStrength = clamp(windSpeed / 1000, 0, 1)
		this.windSpeed = this.windStrength * .8
		this.rainIntensity = kind === WEATHER_RAIN ? severity : 0
		this.snowIntensity = kind === WEATHER_SNOW ? severity : 0
		this.wetness = this.rainIntensity * .82
	}

	/** Absolute presentation time keeps cloud drift deterministic under the fixed-step tools. */
	advance(elapsedSeconds: number): void {
		this.surfaceState.advance(elapsedSeconds, this.snowIntensity, this.wetness)
		this.motionTime = elapsedSeconds
		const distance = elapsedSeconds * this.windSpeed
		this.cloudOffsetX = this.windX * distance
		this.cloudOffsetZ = this.windZ * distance
	}

	assertFinite(): void {
		if (
			!finite3(this.sunDir) ||
			!finite3(this.sunColor) ||
			!finite3(this.skyColor) ||
			!finite3(this.horizonColor) ||
			!finite3(this.groundRadiance) ||
			!finite3(this.moonDir) ||
			!finite3(this.moonColor) ||
			!finite3(this.aerialColor) ||
			!Number.isFinite(this.sunIntensity) ||
			!Number.isFinite(this.moonIntensity) ||
			!Number.isFinite(this.groundAlbedo) ||
			!Number.isFinite(this.ambientScale) ||
			!Number.isFinite(this.aerialDensity) ||
			!Number.isFinite(this.snowCoverage) ||
			!Number.isFinite(this.surfaceWetness) ||
			!Number.isFinite(this.lightning)
		)
			throw new Error('sky: atmospheric model produced a non-finite value')
	}

	private applyWeatherColor(
		color: Vec3,
		lum: number,
		kind: number,
		desaturate: number,
		scale: number,
	): void {
		const tr = lum * WEATHER_R[kind]
		const tg = lum * WEATHER_G[kind]
		const tb = lum * WEATHER_B[kind]
		color[0] = lerp(color[0], tr, desaturate) * scale
		color[1] = lerp(color[1], tg, desaturate) * scale
		color[2] = lerp(color[2], tb, desaturate) * scale
	}
}
