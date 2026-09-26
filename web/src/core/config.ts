// STEELSEED — core/config
// Quality presets and budgets. Mirrors ARCHITECTURE.md §7; that table is the contract
// and this file must not drift from it.
//
// Hard rule 9: never exceed a budget, degrade gracefully. Budgets are measured by
// profile.mjs, never asserted in prose.

export type QualityName = 'low' | 'medium' | 'high' | 'turbo' | 'classic' | 'ultra' | 'ultra-max'
export const QUALITY_NAMES: readonly QualityName[] = ['low', 'medium', 'high', 'turbo', 'classic', 'ultra', 'ultra-max']
/** Lobby Graphics switch. Detect/Dynamic pick a named tier at boot. High and Dynamic then shed to hold 60 fps; the other named rows stay locked. */
export type GraphicsChoice = 'detect' | 'dynamic' | QualityName
export const GRAPHICS_CHOICES: readonly GraphicsChoice[] = ['detect', 'dynamic', ...QUALITY_NAMES]
export type Backend = 'webgpu' | 'webgl2'

/** Live extras the 60 fps governor may flip without a reload. */
export interface PresentationExtras {
	nearField: boolean
	windGrass: boolean
	weatherFx: boolean
}

/** Presentation quality knobs. Pipeline variants are selected once at boot. */
export interface RenderQuality {
	readonly shadowMapSize: number
	readonly shadowPcfTaps: 4 | 9
	readonly shadowMetresPerCascade: number
	readonly shadowCasterExtent: number
	readonly cloudOctaves: 2 | 4
	readonly contactTaps: 4 | 8
	readonly probeTrilinear: boolean
	readonly taaNeighbourhood: 'plus' | 'full'
	readonly taaStaticFeedback: number
	readonly sharpenStrength: number
}

export interface QualityBudget {
	readonly name: QualityName
	readonly render: RenderQuality
	/** Max draw calls per frame. */
	readonly drawCalls: number
	/** Max triangles per frame. */
	readonly triangles: number
	/** Max simultaneous dynamic lights (clustered forward+). */
	readonly dynamicLights: number
	/** Sun/moon cascaded shadow map cascade count. */
	readonly shadowCascades: number
	/** Local lights granted a slot in the shared shadow atlas. */
	readonly localShadowCasters: number
	/** DDGI probe updates per frame. */
	readonly probeUpdatesPerFrame: number
	/** Live particles. */
	readonly particles: number
	/** Persistent decals (craters, scorch, treads). */
	readonly decals: number
	/** Texture VRAM ceiling, bytes. */
	readonly textureVram: number
	/** Internal render scale before upsample. */
	readonly internalScale: number
	/** Simultaneous audio voices. */
	readonly audioVoices: number
	/** Screen-space contact shading in post. A bounded depth-only approximation, not GI. */
	readonly contactShading: boolean
	/** Screen-space reflections on water and metal. The most expensive post feature. */
	readonly screenReflections: boolean
	/** Width of the out-of-bounds scenery ring, in cells. Zero removes it. */
	/**
	 * Depth of the scenery mountain ring around the playable bounds, in cells. Measured
	 * on the 60fps battle gate: the ring's geometry and especially its SHADOW passes
	 * cost the steady-60 budget at war scale on M3-class Metal (p95 33.3 ms with the
	 * ring, 10.3 ms without). This is the width used only when the separate distant-
	 * mountains switch is enabled; the switch defaults off on every tier. `?apron=`
	 * remains an explicit developer override per boot.
	 */
	readonly apronCells: number
	/** Frame-time p50 above which the governor lowers the internal render scale. */
	readonly governorCeilingMs: number
	/** Live scale + extra stripping. Only Dynamic sets this. */
	readonly governor: boolean
	/** Near-camera living grass, shrubs, rocks, logs, fence runs. */
	readonly nearField: boolean
	/** Skinned wind tufts. Costs a bone palette per instance per frame. */
	readonly windGrass: boolean
	/** Rain/snow particle placement from the environment pack. */
	readonly weatherFx: boolean
	/**
	 * Governor policy. Dynamic strips extras and scales; Turbo 60 only ever
	 * nudges the internal render scale (nothing is ever removed). Named presets
	 * without a governor ignore this.
	 */
	readonly governorScaleOnly: boolean
	/**
	 * High and Dynamic. The ceiling stays at a 60 Hz cadence: a flat 30 fps stream is
	 * over budget, and the governor may shed scale, contact, cascades and scenery density
	 * until the frame holds.
	 */
	readonly governorLock60: boolean
	/**
	 * Pin the presentation to the 2026-09-06 `fixes` Ultra look: no cloud shadows, no leaf
	 * transmission, no post-AgX grade, no near-field living scatter. Locked; never detected.
	 */
	readonly classicLook: boolean
}

const RENDER_LOW: RenderQuality = {
	shadowMapSize: 512, shadowPcfTaps: 4, shadowMetresPerCascade: 40,
	shadowCasterExtent: 80, cloudOctaves: 2, contactTaps: 4,
	probeTrilinear: false, taaNeighbourhood: 'full', taaStaticFeedback: 0.99, sharpenStrength: 0.10,
}
const RENDER_MEDIUM: RenderQuality = {
	shadowMapSize: 768, shadowPcfTaps: 4, shadowMetresPerCascade: 50,
	shadowCasterExtent: 100, cloudOctaves: 2, contactTaps: 4,
	probeTrilinear: false, taaNeighbourhood: 'full', taaStaticFeedback: 0.99, sharpenStrength: 0.10,
}
const RENDER_HIGH: RenderQuality = {
	shadowMapSize: 1024, shadowPcfTaps: 4, shadowMetresPerCascade: 60,
	shadowCasterExtent: 160, cloudOctaves: 4, contactTaps: 8,
	probeTrilinear: true, taaNeighbourhood: 'full', taaStaticFeedback: 0.99, sharpenStrength: 0.10,
}
const RENDER_ULTRA: RenderQuality = {
	shadowMapSize: 2048, shadowPcfTaps: 9, shadowMetresPerCascade: 80,
	shadowCasterExtent: 220, cloudOctaves: 4, contactTaps: 8,
	probeTrilinear: true, taaNeighbourhood: 'full', taaStaticFeedback: 0.99, sharpenStrength: 0,
}

// Screen-space contact samples jittered depth. In a fixed-camera A/B/A it more than
// doubled temporal variance around vehicle and building edges, even after the
// unjittered reconstruction fix. Keep the full shadow maps, PCF and baked AO in
// every tier; ?contact=1 remains available for comparing a future stable version.
const BUDGETS: Record<QualityName, QualityBudget> = {
	low: {
		name: 'low',
		render: RENDER_LOW,
		drawCalls: 800,
		triangles: 2_500_000,
		dynamicLights: 32,
		shadowCascades: 2,
		localShadowCasters: 0,
		probeUpdatesPerFrame: 16,
		particles: 20_000,
		decals: 512,
		textureVram: 256 * 1024 * 1024,
		internalScale: 0.7,
		audioVoices: 48,
		contactShading: false,
		screenReflections: false,
		apronCells: 0,
		governorCeilingMs: 28,
		governor: false,
		governorScaleOnly: false,
		governorLock60: false,
		nearField: false,
		windGrass: false,
		weatherFx: false,
		classicLook: false,
	},
	medium: {
		name: 'medium',
		render: RENDER_MEDIUM,
		drawCalls: 1_500,
		triangles: 6_000_000,
		dynamicLights: 128,
		shadowCascades: 3,
		localShadowCasters: 8,
		probeUpdatesPerFrame: 64,
		particles: 80_000,
		decals: 2_048,
		textureVram: 640 * 1024 * 1024,
		internalScale: 0.85,
		audioVoices: 96,
		contactShading: false,
		screenReflections: false,
		apronCells: 0,
		governorCeilingMs: 24,
		governor: false,
		governorScaleOnly: false,
		governorLock60: false,
		nearField: false,
		windGrass: false,
		weatherFx: true,
		classicLook: false,
	},
	high: {
		name: 'high',
		render: RENDER_HIGH,
		drawCalls: 2_500,
		triangles: 12_000_000,
		dynamicLights: 256,
		shadowCascades: 4,
		localShadowCasters: 16,
		probeUpdatesPerFrame: 128,
		particles: 200_000,
		decals: 4_096,
		textureVram: 1024 * 1024 * 1024,
		internalScale: 1.0,
		audioVoices: 128,
		contactShading: false,
		screenReflections: false,
		apronCells: 0,
		governorCeilingMs: 18,
		governor: true,
		governorScaleOnly: false,
		governorLock60: true,
		nearField: false,
		windGrass: false,
		weatherFx: true,
		classicLook: false,
	},
	// Opt-in 60 fps target: the Classic look with submit and shading budgets cut so a
	// 16.6 ms frame fits. Never detected, never strips anything in play; the governor
	// may only lower the internal render scale (floor 0.55) when p50 says the frame
	// is too heavy, and restores it at display pace.
	turbo: {
		name: 'turbo',
		render: RENDER_MEDIUM,
		drawCalls: 2_200,
		triangles: 10_000_000,
		dynamicLights: 192,
		shadowCascades: 3,
		localShadowCasters: 12,
		probeUpdatesPerFrame: 64,
		particles: 160_000,
		decals: 3_072,
		textureVram: 1024 * 1024 * 1024,
		internalScale: 0.9,
		audioVoices: 96,
		contactShading: false,
		screenReflections: true,
		apronCells: 0,
		governorCeilingMs: 16.5,
		governor: true,
		governorScaleOnly: true,
		governorLock60: false,
		nearField: false,
		windGrass: false,
		weatherFx: true,
		classicLook: true,
	},
	// Yesterday's Ultra (`fixes`, 2026-09-06): Ultra budgets + SSR, later extras off, locked.
	classic: {
		name: 'classic',
		render: RENDER_ULTRA,
		drawCalls: 3_200,
		triangles: 16_000_000,
		dynamicLights: 256,
		shadowCascades: 4,
		localShadowCasters: 24,
		probeUpdatesPerFrame: 192,
		particles: 300_000,
		decals: 6_144,
		textureVram: 1536 * 1024 * 1024,
		internalScale: 1.0,
		audioVoices: 128,
		contactShading: false,
		screenReflections: true,
		apronCells: 48,
		governorCeilingMs: 22,
		governor: false,
		governorScaleOnly: false,
		governorLock60: false,
		nearField: false,
		windGrass: false,
		weatherFx: true,
		classicLook: true,
	},
	// Opt-in: yesterday-morning look. SSR on, near-field extras off, locked scale.
	ultra: {
		name: 'ultra',
		render: RENDER_ULTRA,
		drawCalls: 3_200,
		triangles: 16_000_000,
		dynamicLights: 256,
		shadowCascades: 4,
		localShadowCasters: 24,
		probeUpdatesPerFrame: 192,
		particles: 300_000,
		decals: 6_144,
		textureVram: 1536 * 1024 * 1024,
		internalScale: 1.0,
		audioVoices: 128,
		contactShading: false,
		screenReflections: true,
		apronCells: 48,
		governorCeilingMs: 22,
		governor: false,
		governorScaleOnly: false,
		governorLock60: false,
		nearField: false,
		windGrass: false,
		// Falling rain and snow are part of the picture Ultra promises; only Low sheds them.
		weatherFx: true,
		classicLook: false,
	},
	// Opt-in: all extras on, no live degradation. Frame time is what the GPU delivers.
	'ultra-max': {
		name: 'ultra-max',
		render: RENDER_ULTRA,
		drawCalls: 3_200,
		triangles: 16_000_000,
		dynamicLights: 256,
		shadowCascades: 4,
		localShadowCasters: 24,
		probeUpdatesPerFrame: 192,
		particles: 300_000,
		decals: 6_144,
		textureVram: 1536 * 1024 * 1024,
		internalScale: 1.0,
		audioVoices: 128,
		contactShading: false,
		screenReflections: true,
		apronCells: 48,
		governorCeilingMs: 22,
		governor: false,
		governorScaleOnly: false,
		governorLock60: false,
		nearField: true,
		windGrass: true,
		weatherFx: true,
		classicLook: false,
	},
}

export interface Config {
	/** Active budget. */
	q: QualityBudget
	/** What the lobby/URL asked for. Detect and Dynamic resolve to a named `q`. */
	readonly graphicsChoice: GraphicsChoice
	/** Live extra switches. Dynamic mutates this in place; named presets never do. */
	readonly extras: PresentationExtras
	readonly backend: Backend
	/**
	 * Asset generation seed. Every mesh, texture and material is a pure function of
	 * this — same seed, byte-identical output.
	 */
	readonly assetSeed: string
	/** Bump when any generator's output changes, or warm boots serve stale geometry. */
	readonly generatorVersion: number
	readonly devicePixelRatio: number
	/** Deterministic mode: fixed dt, no adaptive quality, no wall-clock reads. */
	readonly deterministic: boolean
	/** Presentation-only out-of-bounds mountain ring. Defaults off on every preset. */
	readonly distantMountains: boolean
	/** `?gputime=1` on a device with timestamp-query: render times each GPU pass (render/gpu-timer). */
	readonly gpuTiming: boolean
	/** Debug view name for dbgview.mjs, or null in normal play. */
	debugView: string | null
}

/** The generation cache key is (generatorVersion, assetSeed). Bump on generator change. */
export const GENERATOR_VERSION = 1

export function budgetFor(name: QualityName): QualityBudget {
	return BUDGETS[name]
}

/**
 * WebGL2 cannot carry the high preset's light count or probe volume, so it is clamped
 * to `low` regardless of request. §5 requires the *same art direction* on the fallback,
 * not the same budget.
 */
export function clampQualityToBackend(q: QualityName, backend: Backend): QualityName {
	return backend === 'webgl2' ? 'low' : q
}

function withDynamicExtras(base: QualityBudget): QualityBudget {
	return {
		...base,
		governor: true,
		governorScaleOnly: false,
		governorLock60: true,
		governorCeilingMs: 18,
		// Grass meshes are chosen at boot from the detected tier. Dynamic may shed
		// and restore resident extras, but cannot promote an unloaded grass variant.
		classicLook: false,
	}
}

export function makeConfig(opts: {
	backend: Backend
	quality?: QualityName
	graphicsChoice?: GraphicsChoice
	assetSeed?: string
	devicePixelRatio?: number
	deterministic?: boolean
	distantMountains?: boolean
	gpuTiming?: boolean
}): Config {
	const quality = clampQualityToBackend(opts.quality ?? 'high', opts.backend)
	const choice = opts.graphicsChoice ?? quality
	const base = budgetFor(quality)
	const q = choice === 'dynamic' ? withDynamicExtras(base) : base
	return {
		q,
		graphicsChoice: choice,
		extras: { nearField: q.nearField, windGrass: q.windGrass, weatherFx: q.weatherFx },
		backend: opts.backend,
		assetSeed: opts.assetSeed ?? 'steelseed-default',
		generatorVersion: GENERATOR_VERSION,
		devicePixelRatio: opts.devicePixelRatio ?? 1,
		deterministic: opts.deterministic ?? false,
		distantMountains: opts.distantMountains ?? false,
		gpuTiming: opts.gpuTiming ?? false,
		debugView: null,
	}
}
