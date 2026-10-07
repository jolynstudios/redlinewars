// STEELSEED — sky.
//
// Owns the atmospheric model and nothing about command encoding. The simulation provides
// time of day, weather and wind through snapshot §4.2; sky computes one coherent lighting
// environment and pushes it to render atomically. Render owns the background pipeline,
// specular ambient and probe integration (§12.2).

import { type Ctx, CoreEvent, type Snapshot, SIM_TICK_HZ } from '../core'
import { SkyModel } from './model'
import type { DaylightMode, LightningStrike, RenderApi, SkyApi, WeatherChange } from './types'

/** Sun straight overhead, and the darkest point of the cycle. */
const NOON_MINUTES = 720
const MIDNIGHT_MINUTES = 0

/** One strike per 24-second slot; jitter keeps neighbouring strikes 14–34 seconds apart. */
const STRIKE_INTERVAL_S = 24
function strikeHash(slot: number, seed: number): number {
	let h = Math.imul(slot ^ seed ^ 0x9e3779b9, 0x85ebca6b)
	h = Math.imul(h ^ (h >>> 16), 0xc2b2ae35)
	return (h ^ (h >>> 16)) >>> 0
}

export type { DaylightMode, SkyApi } from './types'

export class Sky implements SkyApi {
	static id = 'sky'
	static deps = ['render'] as const

	private readonly model = new SkyModel()
	private readonly weatherEvent: WeatherChange = { kind: 0, intensity: 0 }
	private render: RenderApi | null = null
	private hasWorld = false
	private lastWeatherKind = -1
	private lastWeatherIntensity = -1
	private warnedWeatherKind = false
	private preset = 'auto'
	private fixedTime: number | null = null
	private daylight: DaylightMode = 'auto'
	private storming = false
	private readonly strike = { id: -1, time: 0, thunderTime: 0, strength: 0, pan: 0 }
	private muddy = false
	private readonly localWeather = { timeOfDay: 660, weatherKind: 0, weatherIntensity: 0, windDirection: 320, windSpeed: 380 }

	get environment() { return this.model.environment }
	get horizonColor() { return this.model.horizonColor }
	get groundRadiance() { return this.model.groundRadiance }
	get moonDir() { return this.model.moonDir }
	get moonColor() { return this.model.moonColor }
	get moonIntensity() { return this.model.moonIntensity }
	get aerialColor() { return this.model.aerialColor }
	get aerialDensity() { return this.model.aerialDensity }
	get cloudCoverage() { return this.model.cloudCoverage }
	get cloudOpacity() { return this.model.cloudOpacity }
	get cloudScale() { return this.model.cloudScale }
	get cloudOffsetX() { return this.model.cloudOffsetX }
	get cloudOffsetZ() { return this.model.cloudOffsetZ }
	get cloudSeed() { return this.model.cloudSeed }
	get timeOfDay() { return this.model.timeOfDay }
	get weatherKind() { return this.model.weatherKind }
	get weatherIntensity() { return this.model.weatherIntensity }
	get lightning() { return this.model.lightning }
	get rainIntensity() { return this.model.rainIntensity }
	get snowIntensity() { return this.model.snowIntensity }
	get motionTime() { return this.model.motionTime }
	get lightningStrike(): LightningStrike | null { return this.strike.id >= 0 ? this.strike : null }
	get daylightMode(): DaylightMode { return this.daylight }

	/**
	 * Pin the sun, or hand it back to the match clock. RA carries no time of day, so the
	 * cycle here is presentation and pinning it changes nothing a unit can act on. It exists
	 * because a player who cannot see the battlefield has no way to ask for daylight, and
	 * telling them to edit the URL is not an answer.
	 */
	setDaylightMode(mode: DaylightMode): void {
		this.daylight = mode
		this.fixedTime = mode === 'day' ? NOON_MINUTES : mode === 'night' ? MIDNIGHT_MINUTES : null
	}

	/**
	 * Runtime twin of the `?weather=` boot parameter, for the skirmish lobby's Weather
	 * switch. 'clear' pins the fair-weather sky; 'auto' runs the presentation cycle where
	 * rain, storm, snow and mud each get a real turn. Presentation only — RA has no
	 * weather simulation, so this never issues orders.
	 */
	setWeatherPreset(preset: string): void {
		this.preset = preset
	}

	/**
	 * Values for the 'live' weather preset (skirmish World mode): real regional
	 * weather fetched outside the sim and mapped onto the presentation kinds.
	 * Presentation only — no orders, no gameplay effect.
	 */
	private live: { kind: number; intensity: number; windSpeed: number } | null = null
	setLiveWeather(kind: number, intensity: number, windSpeed: number): void {
		this.live = { kind, intensity, windSpeed }
	}

	init(ctx: Ctx): void {
		this.render = ctx.get<RenderApi>('render')
		this.preset = new URLSearchParams(location.search).get('weather') ?? 'auto'
		const daylight = new URLSearchParams(location.search).get('daylight')
		this.fixedTime = daylight === 'night' ? MIDNIGHT_MINUTES : daylight === 'dawn' ? 360
			: daylight === 'dusk' ? 1080 : daylight === 'day' ? NOON_MINUTES : null
		this.daylight = daylight === 'night' ? 'night' : daylight === 'day' ? 'day' : 'auto'
		this.model.setCloudSeed(ctx.rng.forkNamed('sky-clouds').nextU32())
	}

	onSnapshot(snapshot: Snapshot, _previous: Snapshot | null, ctx: Ctx): void {
		const world = snapshot.world
		if (!world) return
		const authored = world.environment
		// RA has no weather simulation. This view-only cycle never issues gameplay orders.
		// Authored snapshot weather, when present, remains the source of truth.
		const seconds = (ctx.time.tick + ctx.time.alpha) / SIM_TICK_HZ
		const local = this.localWeather
		// Auto: one presentation day per 24 minutes of simulation, as always. World:
		// the sky follows the player's own wall clock and the live weather follows the
		// player's real region, so a morning skirmish plays under morning light. Both
		// are presentation-only, and Day/Night still pin via fixedTime.
		const wall = new Date().getHours() * 60 + new Date().getMinutes() + new Date().getSeconds() / 60
		local.timeOfDay = this.fixedTime ?? (this.daylight === 'world' && !ctx.config.deterministic
			? wall
			: (660 + seconds) % 1440)
		this.storming = false
		this.muddy = false
		if (this.preset === 'live' && this.live) {
			local.weatherKind = this.live.kind
			local.weatherIntensity = this.live.intensity
			local.windSpeed = this.live.windSpeed
		} else if (this.preset === 'rain') {
			local.weatherKind = 2
			local.weatherIntensity = 720
			local.windSpeed = 520
		} else if (this.preset === 'snow') {
			local.weatherKind = 3
			local.weatherIntensity = 720
			local.windSpeed = 420
		} else if (this.preset === 'storm' || this.preset === 'lightning') {
			local.weatherKind = 2
			local.weatherIntensity = 1000
			local.windSpeed = 900
			this.storming = true
		} else if (this.preset === 'mud') {
			local.weatherKind = 1
			local.weatherIntensity = 800
			local.windSpeed = 280
			this.muddy = true
		} else if (this.preset === 'clear') {
			local.weatherKind = 0
			local.weatherIntensity = 0
			local.windSpeed = 320
		} else {
			// Auto: a 12-minute loop so rain, storm, snow and mud each get a real turn.
			const slot = Math.floor((((seconds % 720) + 720) % 720) / 90)
			if (slot === 1) {
				local.weatherKind = 2
				local.weatherIntensity = 640
				local.windSpeed = 560
			} else if (slot === 2) {
				local.weatherKind = 2
				local.weatherIntensity = 1000
				local.windSpeed = 880
				this.storming = true
			} else if (slot === 3) {
				local.weatherKind = 3
				local.weatherIntensity = 720
				local.windSpeed = 400
			} else if (slot === 4) {
				local.weatherKind = 1
				local.weatherIntensity = 780
				local.windSpeed = 300
				this.muddy = true
			} else {
				local.weatherKind = 0
				local.weatherIntensity = 0
				local.windSpeed = 320
			}
		}
		// Authored rain/snow wins over local presets, including their storm/mud modifiers.
		if (authored) {
			this.storming = authored.weatherKind === 2 && authored.weatherIntensity >= 900
			this.muddy = false
		}
		const environment = authored ?? local
		if (
			(environment.weatherKind < 0 || environment.weatherKind > 4) &&
			!this.warnedWeatherKind
		) {
			this.warnedWeatherKind = true
			console.warn(
				`[sky] unknown weather kind ${environment.weatherKind}; using clear atmosphere`,
			)
		}
		this.model.evaluate(
			environment.timeOfDay,
			environment.weatherKind,
			environment.weatherIntensity,
			environment.windDirection,
			environment.windSpeed,
		)
		if (this.muddy) {
			this.model.rainIntensity = 0
			this.model.snowIntensity = 0
			this.model.wetness = 0.95
		}
		if (this.storming && !authored) {
			this.model.rainIntensity = Math.max(this.model.rainIntensity, 0.92)
			this.model.wetness = Math.max(this.model.wetness, 0.9)
			this.model.windStrength = Math.max(this.model.windStrength, 0.85)
		}
		this.evaluateLightning(seconds)
		this.model.assertFinite()
		this.hasWorld = true

		if (
			this.model.weatherKind !== this.lastWeatherKind ||
			this.model.weatherIntensity !== this.lastWeatherIntensity
		) {
			this.lastWeatherKind = this.model.weatherKind
			this.lastWeatherIntensity = this.model.weatherIntensity
			this.weatherEvent.kind = this.model.weatherKind
			this.weatherEvent.intensity = this.model.weatherIntensity
			ctx.events.emit(CoreEvent.weatherChange, this.weatherEvent)
		}
	}

	/** Absolute simulation time makes seeking, low frame rates and audio share one event. */
	private evaluateLightning(seconds: number): void {
		this.model.lightning = 0
		this.strike.id = -1
		if (!this.storming || seconds < 0) return
		let slot = Math.floor(seconds / STRIKE_INTERVAL_S)
		let hash = strikeHash(slot, this.model.cloudSeed)
		let at = slot * STRIKE_INTERVAL_S + 4 + hash / 4294967296 * 10
		if (at > seconds) {
			slot--
			if (slot < 0) return
			hash = strikeHash(slot, this.model.cloudSeed)
			at = slot * STRIKE_INTERVAL_S + 4 + hash / 4294967296 * 10
		}
		const detail = strikeHash(slot, this.model.cloudSeed ^ 0x51eed)
		this.strike.id = slot
		this.strike.time = at
		this.strike.thunderTime = at + 0.8 + (detail & 0xffff) / 65535 * 2.2
		this.strike.strength = 0.65 + (detail >>> 16) / 65535 * 0.35
		this.strike.pan = ((hash & 0xffff) / 65535 - 0.5) * 1.1
		const age = seconds - at
		// A 220 ms pulse is visible at ordinary frame rates without strobing the battle.
		this.model.lightning = this.strike.strength * Math.max(0, 1 - age / 0.22) ** 2
	}

	update(_dt: number, ctx: Ctx): void {
		if (!this.hasWorld || !this.render) return
		const seconds = (ctx.time.tick + ctx.time.alpha) / SIM_TICK_HZ
		this.evaluateLightning(seconds)
		this.model.advance(seconds)
		this.render.setEnvironment(this.model)
	}

	/**
	 * Sky creates no GPU object; render owns and prewarms the background pipeline. Keeping
	 * the hook explicit documents that no lazy work is waiting for the first dawn frame.
	 */
	prewarm(_ctx: Ctx): void {
		if (this.hasWorld) this.model.assertFinite()
	}

	dispose(): void {
		this.render = null
		this.hasWorld = false
		this.strike.id = -1
	}
}
