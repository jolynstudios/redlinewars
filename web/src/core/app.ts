// STEELSEED — core/app
// Boot and the frame loop. This is the spine: it owns the registry, the clock, the
// snapshot double-buffer and the bridge seam, and it is the only place that decides
// when a system's methods run.

import { Clock, SIM_TICK_MS } from './clock'
import { type Config, type GraphicsChoice, makeConfig, type QualityName } from './config'
import {
	createCtx,
	type Ctx,
	type CtxHost,
	type OrderRequest,
	type PlacementRequest,
	type PlacementResult,
	type SessionApi,
	type SessionStatus,
	type SimHealth,
	type SkirmishCatalog,
	type SupportPowersStatus,
	type StartSkirmishConfig,
} from './ctx'
import { CoreEvent, EventBus, SIM_EVENT_BY_KIND } from './events'
import { assessFramePacing, assessLocked60, createPaceMachine, isUsableFrameSample, notePaceWindow, shouldAssessFrameWindow, type PaceAction, type PaceMachine, type PacePreset } from './frame-governor'
import { Input } from './input'
import { Registry, type SystemClass } from './registry'
import { Rng, rootRng } from './rng'
import { EventKind, HeaderFlag, type Snapshot, SnapshotDecoder } from './snapshot'

/**
 * How long the simulation may be silent before the player is told. The sim publishes at
 * 25 Hz, so a healthy gap is 40 ms; this is two orders of magnitude above that so a map
 * load, a GC pause or a throttled tab never trips it, and still well inside the time it
 * takes a player to wonder whether the game is broken.
 */
const SIM_STALL_MS = 4000

/**
 * The C#-side bridge, surfaced by the WASM host over [JSExport]. `core` never talks to
 * the simulation any other way — see ARCHITECTURE.md §4.
 */
export interface OrderIntent {
	readonly orderString: string
	readonly subjectIds: Uint32Array
	readonly subjectCount?: number
	readonly targetActorId: number
	readonly targetCellX: number
	readonly targetCellY: number
	readonly queued: boolean
	readonly targetString: string
	readonly extraData: number
	/** Order.ExtraLocation; -1 leaves it unset. */
	readonly extraCellX?: number
	readonly extraCellY?: number
}

export interface ContextOrderIntent {
	readonly subjectIds: Uint32Array
	readonly subjectCount?: number
	readonly targetActorId: number
	readonly targetCellX: number
	readonly targetCellY: number
	readonly targetFrozen: boolean
	readonly modifiers: number
}

export interface ContextOrderPreview {
	readonly order: string
	readonly cursor: string
}

export interface BridgeApi {
	/** A persistent pinned-slot alias, or exact null if this sim/presentation state was already polled. */
	pollSnapshot(): Uint8Array | null
	/**
	 * Queue an order. The sim stays authoritative; this never mutates actor state.
	 * An empty `subjectIds` is a player-level order (production, building placement).
	 *
	 * The host bridge runs in the simulation worker: RPC-shaped methods resolve one
	 * postMessage round trip later. Orders are fire-and-forget by contract; the
	 * presentation only surfaces a rejected result as a warning.
	 */
	issueOrder(order: OrderIntent): Promise<string>
	/** Resolve the same contextual targeters as OpenRA's UnitOrderGenerator. */
	issueContextOrder?(order: ContextOrderIntent): Promise<string>
	queryContextOrder?(order: ContextOrderIntent): Promise<ContextOrderPreview | null>
	/**
	 * Charge status of the local player's support powers. Synchronous by design: the
	 * worker pushes it on a status cache, and per-frame HUD reads must not allocate.
	 */
	getSupportPowers?(): SupportPowersStatus | null
	/**
	 * The mod's actor-type table: newline-separated names, index == the `typeId` §4.5
	 * carries per actor. Mirrors `[JSExport] SnapshotTypeTable`.
	 *
	 * Read rather than assumed, because typeIds are assigned in FIRST-SEEN order on the C#
	 * side, not from a fixed enum. They are stable within a session and meaningless across
	 * mods, so a hard-coded table on this side would silently mismatch the moment the mod
	 * adds an actor. Nodes that need to pick a mesh generator per type must go through
	 * `Ctx.actorTypeName`.
	 */
	snapshotTypeTable?(): string | Promise<string>
	/** Cold, versioned setup contract. Realtime state never travels through JSON. */
	getSkirmishCatalog?(): Promise<SkirmishCatalog>
	startSkirmish?(config: StartSkirmishConfig): Promise<SessionStatus>
	/** Synchronous status-cache read in the worker bridge; the dev bridge is local. */
	getSessionStatus?(): SessionStatus | null
	setPaused?(paused: boolean): Promise<string>
	queryBuildingPlacement?(request: PlacementRequest): Promise<PlacementResult>
	placeBuildingValidated?(request: PlacementRequest): Promise<PlacementResult>
	/**
	 * Host-side stall evidence, read only when the watchdog already found a stall.
	 * Synchronous status-cache reads; optional for the same reason as `hostStatus`.
	 */
	getSyncProbe?(): string
	getConnectionProbe?(): string
	getServerErrorProbe?(): string
	/**
	 * The host's own view of whether it is alive: 'running', 'stopped', or 'error:<stack>'.
	 *
	 * Optional because the dev bridge and the partial harnesses have no host to ask. When it
	 * is present it is the ONLY authoritative answer to "why did the world stop", because a
	 * host that died reports nothing else — `pollSnapshot()` simply returns null forever,
	 * which is indistinguishable from a paused game.
	 */
	hostStatus?(): string
}

export interface BootOptions {
	canvas: HTMLCanvasElement
	systems: SystemClass[]
	bridge?: BridgeApi | null
	quality?: QualityName
	graphicsChoice?: GraphicsChoice
	assetSeed?: string
	deterministic?: boolean
	distantMountains?: boolean
	/** `?gputime=1`: request timestamp-query and time every GPU pass (render/gpu-timer). */
	gpuTiming?: boolean
	/** Progress reporting for the loading screen. */
	onProgress?: (stage: string, fraction: number) => void
}

/** Snapshots drained between two frames whose events still replay (about 0.5 s of ticks). */
const EVENT_CATCHUP_SNAPSHOTS = 12

export class App {
	readonly registry = new Registry()
	readonly events = new EventBus()
	readonly input = new Input()
	readonly clock: Clock
	readonly config: Config
	readonly rng: Rng
	readonly ctx: Ctx

	private decoder = new SnapshotDecoder()
	private snapState: { snapshot: Snapshot | null; prev: Snapshot | null } = { snapshot: null, prev: null }
	private host: CtxHost
	private bridge: BridgeApi | null
	private raf = 0
	private running = false
	private disposed = false
	/** True once dispose() ran: a device lost after that was released on purpose. */
	get isDisposed(): boolean { return this.disposed }
	private resizeObserver: ResizeObserver | null = null
	/**
	 * Live internal render scale. Starts at the preset's and is lowered by the governor
	 * when measured frame time exceeds the preset's ceiling — the pinned first step of
	 * graceful degradation (§7) — and raised again, slowly, when there is headroom.
	 */
	private renderScale = 1
	private readonly frameSamples = new Float32Array(120)
	private frameSampleCount = 0
	/** Also close a sample window after two seconds: at 10 fps, 120 frames took 12 seconds. */
	private frameSampleElapsedMs = 0
	private headroomWindows = 0
	/** Consecutive over-ceiling windows; two are required before a drop so one hitch is ignored. */
	private overCeilingWindows = 0
	/** Full sample windows to ignore after a match starts, while first-look shaders and grass settle. */
	private governorWarmupWindows = 0
	/** Lobby and match builds are not game frames; resume only when the new world ticks. */
	private governorHold = true
	/** Distinguishes a pending match build from a non-session bridge with live ticks. */
	private governorMatchBuild = false
	/** Last governor window, for the HUD: measured, not asserted. */
	/**
	 * Event intake across frames (vfx.md Epic 4). `between` counts snapshots whose events were
	 * republished although the frame rendered a later one; `skipped` counts those beyond the
	 * catch-up bound; `droppedBySink` sums the engine sink's own refusals (event kind 13).
	 */
	readonly eventStats = { between: 0, skipped: 0, droppedBySink: 0 }
	/** Snapshots drained between two frames whose events still need republishing. Reused. */
	private readonly eventCarriers: Uint8Array[] = []

	readonly frameStats = {
		p50Ms: 0, p90Ms: 0, renderScale: 1, windows: 0, tier: '',
		choice: '' as string,
		nearField: false, windGrass: false, weatherFx: false,
		cascades: 0, presetCascades: 0, contact: true, sceneryStep: 1,
		presetNear: false, presetWind: false,
	}
	/** Live shed for the 60 fps lock. -1 cascades means "not touched yet, use the preset". */
	private liveCascades = -1
	private liveContact = true
	private sceneryStep = 1
	/** Shipped 60 fps ladder. Null until the first locked window or a new world. */
	private pace: PaceMachine | null = null
	/** Live simulation liveness. Read by `ui`; also published on `CoreEvent.simHealth`. */
	readonly simHealth: SimHealth = { tick: -1, silentMs: 0, stalled: false, reason: '', hostStatus: '', diagnostics: [] }
	/** Wall clock of the last tick change, and the tick it changed to. */
	private lastTickAtMs = 0
	private lastTickSeen = -1
	/** Reason already logged, so a per-frame failure reports once rather than 60 times a second. */
	private reportedReason = ''
	/** Set while a new skirmish is loading, when a long silence is expected rather than wrong. */
	private awaitingNewWorld = false
	private newWorldSnapshotSeen = false
	private unmarkedWorldTicksSinceMs = 0
	private newWorldWaitStartedMs = 0
	private newWorldPreviousTick: number | null = null
	private newWorldProgressSeen = false
	private newWorldLoadingSeen = false
	private firstWorldLogged = false
	/**
	 * The mod's actor-type table, read ONCE from the bridge and cached.
	 *
	 * Lazily, not at boot: the table is built on the C# side as actors are first seen, so
	 * reading it before the first tick returns a table that is empty or short. Reading it
	 * on first use — which is after a snapshot has arrived — is what makes it complete.
	 *
	 * Null means not yet read; an empty array means read and genuinely empty, which is the
	 * dev-fixture and partial-harness case and is not an error.
	 */
	private typeTable: string[] | null = null
	private typeTableRefreshing = false
	private typeTablePromise: Promise<void> | null = null
	private typeTableGeneration = 0
	private typeTableMissFrame = -1
	private readonly typeTableMisses = new Set<number>()
	/** Consecutive fetches that returned an empty table; bounds the live-session retry
	 *  below so a bridge-less dev fixture cannot churn a round trip every frame. */
	private typeTableEmptyFetches = 0

	/**
	 * Mod actor-type name for a §4.5 typeId, or '' when there is no table.
	 *
	 * Out-of-range returns '' rather than throwing: typeIds come from the simulation, and a
	 * renderer that dies because the mod added an actor mid-session would be trading a
	 * cosmetic fallback for a crash.
	 */
	actorTypeName(typeId: number): string {
		const table = this.typeTable
		const outOfRange = table === null || (typeId >= 0 && typeId >= table.length)
		const exhausted = table !== null && table.length === 0 && this.typeTableEmptyFetches >= 25
		// Out of range (or unread): refetch, bounded for the genuinely-empty dev fixture.
		// In-range empty holes are PERMANENT, not stale: the host's lazy string table
		// registers nameless entries (e.g. unnamed husks) after the world-bind
		// prepopulation, and no refetch can name them — refetching on holes would
		// round-trip the worker every call and hitch the frame (seen as HUD flicker).
		if (outOfRange && !exhausted) {
			const frame = this.clock.time.frame
			if (this.typeTableMissFrame !== frame) {
				this.typeTableMissFrame = frame
				this.typeTableMisses.clear()
			}
			if (!this.typeTableMisses.has(typeId)) {
				this.typeTableMisses.add(typeId)
				this.refreshTypeTable()
			}
		}
		return table !== null && typeId >= 0 && typeId < table.length ? table[typeId] : ''
	}

	/**
	 * Refresh the type table asynchronously (the host bridge answers one postMessage
	 * round trip later) while continuing to serve the previous table: renderers ask
	 * per frame and must never block. Null means not yet read; an empty array means
	 * read and genuinely empty (the dev-fixture case), which is not an error.
	 */
	private refreshTypeTable(force = false): void {
		if (this.typeTableRefreshing && !force) return
		const generation = this.typeTableGeneration
		this.typeTableRefreshing = true
		let raw: string | Promise<string>
		try {
			raw = this.bridge?.snapshotTypeTable?.() ?? ''
		} catch {
			if (generation === this.typeTableGeneration) this.typeTableRefreshing = false
			return
		}
		const pending = Promise.resolve(raw)
			.then(raw => {
				if (generation !== this.typeTableGeneration) return
				this.typeTable = raw.length > 0 ? raw.split('\n') : []
				this.typeTableEmptyFetches = raw.length > 0 ? 0 : this.typeTableEmptyFetches + 1
			})
			.catch(() => { /* keep serving the previous table */ })
			.finally(() => { if (generation === this.typeTableGeneration) this.typeTableRefreshing = false })
		this.typeTablePromise = pending
	}
	private constructor(host: CtxHost, bridge: BridgeApi | null, clock: Clock) {
		this.host = host
		this.bridge = bridge
		this.clock = clock
		this.config = host.config
		this.rng = host.rng
		host.actorTypeName = (t) => this.actorTypeName(t)
		// One object, mutated in place: `ui` reads it every frame and rule 6 forbids
		// allocating a fresh health record per frame to hand it.
		host.simHealth = this.simHealth
		this.ctx = createCtx(host, this.snapState)
	}

	static async boot(opts: BootOptions): Promise<App> {
		const { canvas } = opts
		const progress = opts.onProgress ?? (() => {})

		progress('selecting backend', 0)
		const { backend, device, gl } = await selectBackend(canvas, opts.gpuTiming === true)

		const config = makeConfig({
			backend,
			quality: opts.quality,
			graphicsChoice: opts.graphicsChoice,
			assetSeed: opts.assetSeed,
			devicePixelRatio: opts.deterministic ? 1 : presentationPixelRatio(),
			deterministic: opts.deterministic,
			distantMountains: opts.distantMountains,
			gpuTiming: device?.features.has('timestamp-query') ?? false,
		})

		const events = new EventBus()
		const input = new Input()
		const registry = new Registry()
		const clock = new Clock({ deterministic: config.deterministic })

		const bridge = opts.bridge ?? null
		let catalogLogged = false
		const session: SessionApi = {
			available: bridge?.getSkirmishCatalog !== undefined && bridge?.startSkirmish !== undefined,
			getCatalog: async () => {
				const catalog = await bridge?.getSkirmishCatalog?.() ?? null
				if (!catalogLogged && catalog?.maps?.length) {
					catalogLogged = true
					console.info(`[boot] stage=catalog-ready ms=${Math.round(performance.now())} maps=${catalog.maps.length}`)
				}
				return catalog
			},
			startSkirmish: async config => await bridge?.startSkirmish?.(config) ?? {
				schemaVersion: 1,
				status: 'error',
				code: 'unavailable',
				userMessage: 'The browser host has no skirmish control.',
			},
			getStatus: () => bridge?.getSessionStatus?.() ?? {
				schemaVersion: 1,
				status: 'error',
				code: 'unavailable',
				userMessage: 'The browser host has no session status.',
			},
			setPaused: async paused => await bridge?.setPaused?.(paused) ?? 'error: browser host has no pause control',
		}
		const host: CtxHost = {
			device,
			gl,
			backend,
			canvas,
			canvasCss: { width: 0, height: 0 },
			config,
			events,
			input,
			time: clock.time,
			rng: rootRng(config.assetSeed),
			// Replaced by the App instance below, once one exists. A node can only reach
			// this through Ctx, and nodes run after boot, so the placeholder is never seen.
			actorTypeName: () => '',
			registry,
			session,
			// Replaced with the App's own instance below. Nodes only ever see the ctx, and
			// nodes run after boot, so the placeholder is never read.
			simHealth: { tick: -1, silentMs: 0, stalled: false, reason: '', hostStatus: '', diagnostics: [] },
			gpuLost: null,
			placement: {
				available: bridge?.queryBuildingPlacement !== undefined && bridge?.placeBuildingValidated !== undefined,
				query: async request => await bridge?.queryBuildingPlacement?.(request) ?? null,
				place: async request => await bridge?.placeBuildingValidated?.(request) ?? null,
			},
			supportPowers: () => bridge?.getSupportPowers?.() ?? null,
			queryContextOrder: order => bridge?.queryContextOrder?.(order) ?? Promise.resolve(null),
			sendOrder: async () => 'ignored: no host',
		}

		const app = new App(host, bridge, clock)
		// A lost device ends the view, not the match: report it (the UI raises its alarm), never
		// silently. A loss during the app's own teardown is no loss.
		device?.lost.then(info => {
			if (app.isDisposed) return
			host.gpuLost = { reason: String(info.reason ?? 'unknown'), message: String(info.message ?? '') }
			console.error(`[render] GPU device lost (${host.gpuLost.reason}): ${host.gpuLost.message}`)
			// Every system built its GPU state against this device at boot, and the world's meshes
			// and terrain when the world arrived, so the view is rebuilt by booting again. With no
			// match running nothing is lost, so that happens at once; in a match the player decides
			// (the alarm's Reload), because a reload ends the skirmish the worker is running.
			if (app.ctx.snapshot === null && typeof location !== 'undefined') setTimeout(() => location.reload(), 400)
		})
		// Rebind: these were constructed above so the ctx could be built, and the App's
		// own fields must be the same instances the ctx closes over.
		;(app as { events: EventBus }).events = events
		;(app as { input: Input }).input = input
		;(app as { registry: Registry }).registry = registry
		host.sendOrder = (o) => app.sendOrder(o)
		// A new match is a deliberate, unbounded silence — not a stall. Hold the watchdog
		// until the new world publishes.
		const presentationReady = async (): Promise<void> => {
			const units = registry.peek<{ readyForMatch?(): Promise<void> }>('units')
			await units?.readyForMatch?.()
		}
		const startSkirmish = session.startSkirmish
		session.startSkirmish = async (skirmish) => {
			app.governorHold = true
			app.governorMatchBuild = true
			// Damage-state meshes build cooperatively after the lobby becomes usable. A
			// match may not start in the middle of that CPU work: doing so made the first
			// live minute stutter even though the identical settled build held 60+ fps.
			await presentationReady()
			app.awaitNewWorld()
			return startSkirmish(skirmish)
		}
		// Network joins load a fresh world through the same watchdog-hold path: the
		// session UI calls this before driving the bridge's join flow.
		session.beginNetworkJoin = async () => {
			app.governorHold = true
			app.governorMatchBuild = true
			await presentationReady()
			app.awaitNewWorld()
		}

		try {
			input.attach(canvas)
			app.attachResize()

			// The bar now tracks the real load: every system reports its own slice of the
			// 0.1–0.8 span (named on the bar WHILE it loads), prewarm owns 0.8–0.97, and
			// only the first frame hands the match over at 1.
			registry.register(...opts.systems)
			await registry.init(app.ctx, (done, total, id) =>
				progress(`loading ${id.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}`, 0.1 + 0.7 * (done / Math.max(1, total))))
			let warmed = 0
			await registry.prewarm(app.ctx, () => progress('prewarming pipelines', 0.8 + 0.17 * (++warmed / Math.max(1, registry.systemCount))))

			progress('ready', 1)
			return app
		} catch (error) {
			try { app.dispose() }
			catch (cleanupError) {
				// Cleanup failures are secondary; even a reporting failure must not mask
				// the original boot rejection (which need not be an Error object).
				try { console.error('[app] failed boot cleanup', cleanupError) }
				finally { throw error }
			}
			throw error
		}
	}

	private publishFrameStats(): void {
		const stats = this.frameStats
		const extras = this.config.extras
		stats.renderScale = this.renderScale
		stats.tier = this.config.q.name
		stats.choice = this.config.graphicsChoice
		stats.nearField = extras.nearField
		stats.windGrass = extras.windGrass
		stats.weatherFx = extras.weatherFx
		stats.presetNear = this.config.q.nearField
		stats.presetWind = this.config.q.windGrass
		stats.presetCascades = this.config.q.shadowCascades
		stats.cascades = this.liveCascades < 0 ? this.config.q.shadowCascades : this.liveCascades
		stats.contact = this.liveCascades < 0 ? this.config.q.contactShading : this.liveContact
		stats.sceneryStep = this.sceneryStep
	}

	private attachResize(): void {
		this.renderScale = this.config.q.internalScale
		this.publishFrameStats()
		// §0.3 inherited boundary: the WASM host fixes its resolution at boot. The web
		// layer is not bound by that, so the presentation canvas resizes freely.
		this.resizeObserver = new ResizeObserver(() => this.applyRenderScale())
		this.resizeObserver.observe(this.host.canvas)
	}

	private applyRenderScale(): void {
		const canvas = this.host.canvas
		// The one layout read of the canvas size: the observer calls this after layout, and
		// frame code reads the cached copy (ctx.canvasCss).
		this.host.canvasCss.width = canvas.clientWidth
		this.host.canvasCss.height = canvas.clientHeight
		const dpr = this.config.deterministic ? 1 : presentationPixelRatio()
		const w = Math.max(1, Math.round(this.host.canvasCss.width * dpr * this.renderScale))
		const h = Math.max(1, Math.round(this.host.canvasCss.height * dpr * this.renderScale))
		if (canvas.width === w && canvas.height === h) return
		canvas.width = w
		canvas.height = h
		this.registry.resize(w, h, this.ctx)
		this.events.emit(CoreEvent.resize, { width: w, height: h })
	}

	/**
	 * Frame-time governor. Samples wall-clock frame intervals from the rAF loop only —
	 * the tools that step frames by hand measure themselves — and acts on the p50 of the
	 * last 120 frames. This only changes anything when `q.governor` is on. High and
	 * Dynamic lock that decision to a 60 Hz cadence and keep shedding until it holds.
	 * Down fast, up slow.
	 */
	private governFrame(dtSeconds: number): void {
		if (this.config.deterministic || this.governorHold || this.awaitingNewWorld) {
			this.frameSampleCount = 0
			this.frameSampleElapsedMs = 0
			return
		}
		// Background tabs are browser-throttled, not GPU-bound. Do not permanently lower
		// their quality while they are hidden, and do not carry throttled samples forward.
		if (document.visibilityState !== 'visible') {
			this.frameSampleCount = 0
			this.frameSampleElapsedMs = 0
			return
		}
		const frameMs = dtSeconds * 1000
		// Clock.frame returns zero while paused. Treating those rAFs as headroom restored
		// every degraded feature during a pause, then caused a quality spike on resume.
		if (!isUsableFrameSample(frameMs)) {
			this.frameSampleCount = 0
			this.frameSampleElapsedMs = 0
			return
		}
		this.frameSamples[this.frameSampleCount++] = frameMs
		this.frameSampleElapsedMs += frameMs
		if (!shouldAssessFrameWindow(this.frameSampleCount, this.frameSampleElapsedMs, this.frameSamples.length)) return
		const sampleCount = this.frameSampleCount
		this.frameSampleCount = 0
		this.frameSampleElapsedMs = 0
		if (this.governorWarmupWindows > 0) {
			this.governorWarmupWindows--
			return
		}
		const sorted = Float32Array.from(this.frameSamples.subarray(0, sampleCount)).sort()
		const p10 = sorted[Math.floor(sampleCount * 0.1)]
		const p50 = sorted[sampleCount >> 1]
		const p90 = sorted[Math.floor(sampleCount * 0.9)]
		this.frameStats.p50Ms = p50
		this.frameStats.p90Ms = p90
		this.frameStats.windows++
		this.publishFrameStats()
		if (!this.config.q.governor) return
		// rAF never runs faster than the display, so p10 estimates display pacing. Cap that
		// inference at 30 Hz: the old unbounded estimate classified a perfectly regular
		// 10 fps workload as its own display pace and Dynamic never reduced anything.
		// The 60 Hz lock does not use that inference. A flat 33 ms stream is a miss.
		const lock60 = this.config.q.governorLock60
		const pacing = lock60
			? assessLocked60(p10, p50, p90)
			: assessFramePacing(p10, p50, this.config.q.governorCeilingMs)
		const ceiling = pacing.ceilingMs
		const floor = lock60 ? 0.5 : 0.55
		const target = this.config.q.internalScale
		if (lock60) {
			this.applyLock60(p10, p50, p90)
			return
		}
		if (pacing.overBudget) {
			if (++this.overCeilingWindows < (pacing.severe ? 1 : 2)) {
				this.headroomWindows = 0
				return
			}
			this.overCeilingWindows = 0
			this.headroomWindows = 0
			const steps = lock60 && pacing.severe ? 3 : 1
			for (let i = 0; i < steps; i++) {
				if (!this.degradeDynamic(p50, ceiling, floor)) break
			}
		} else {
			this.overCeilingWindows = 0
			if (pacing.displayPaced && this.canRestoreDynamic(target)) {
				if (++this.headroomWindows >= 5) {
					this.headroomWindows = 0
					this.restoreDynamic(p50, target)
				}
			} else this.headroomWindows = 0
		}
	}

	private pacePreset(): PacePreset {
		const q = this.config.q
		return {
			scale: q.internalScale,
			contact: q.contactShading,
			cascades: q.shadowCascades,
			wind: q.windGrass,
			weather: q.weatherFx,
			near: q.nearField,
			scaleOnly: q.governorScaleOnly,
			floor: 0.5,
		}
	}

	/** Apply the pure 60 fps ladder. The machine is the start state; each window moves it one step. */
	private applyLock60(p10: number, p50: number, p90: number): void {
		if (!this.pace) this.pace = createPaceMachine(this.pacePreset())
		const actions = notePaceWindow(this.pace, this.pacePreset(), p10, p50, p90)
		const live = this.pace.live
		const scaleChanged = Math.abs(this.renderScale - live.scale) > 0.001
		this.renderScale = live.scale
		this.liveContact = live.contact
		this.liveCascades = live.cascades
		this.sceneryStep = live.sceneryStep
		const extras = this.config.extras
		extras.windGrass = live.wind
		extras.weatherFx = live.weather
		extras.nearField = live.near
		if (scaleChanged) this.applyRenderScale()
		const shed = actions.some(action => action.kind === 'contact' || action.kind === 'cascades' || action.kind === 'scenery')
		if (shed) this.pushLoadShed(this.paceReason(p50, actions))
		else if (actions.length > 0) {
			console.info(`[quality] ${this.paceReason(p50, actions)}`)
			this.publishFrameStats()
		}
	}

	private paceReason(p50: number, actions: readonly PaceAction[]): string {
		const parts = actions.map(action => {
			switch (action.kind) {
				case 'scale': return `render scale → ${action.scale.toFixed(2)}`
				case 'contact': return action.on ? 'contact shading on' : 'contact shading off'
				case 'cascades': return `shadow cascades → ${action.cascades}`
				case 'scenery': return `scenery density 1/${action.step}`
				case 'wind': return action.on ? 'wind grass on' : 'wind grass off'
				case 'weather': return action.on ? 'rain on' : 'rain off'
				case 'near': return action.on ? 'near-field grass on' : 'near-field grass off'
			}
		})
		return `frame p50 ${p50.toFixed(1)} ms; ${parts.join('; ')}`
	}

	private ensureShedDefaults(): void {
		if (this.liveCascades >= 0) return
		this.liveCascades = this.config.q.shadowCascades
		this.liveContact = this.config.q.contactShading
		this.sceneryStep = 1
	}

	private pushLoadShed(reason: string): void {
		this.ensureShedDefaults()
		this.publishFrameStats()
		const render = this.registry.peek<{
			setLoadShed?(shed: { cascades: number; contact: boolean; sceneryStep: number }): void
		}>('render')
		render?.setLoadShed?.({
			cascades: this.liveCascades,
			contact: this.liveContact,
			sceneryStep: this.sceneryStep,
		})
		console.info(`[quality] ${reason}`)
	}

	private degradeDynamic(p50: number, ceiling: number, floor: number): boolean {
		const extras = this.config.extras
		const note = `frame p50 ${p50.toFixed(1)} ms over the ${ceiling.toFixed(1)} ms ceiling`
		if (this.renderScale > floor + 0.01) {
			this.renderScale = Math.max(floor, this.renderScale * 0.85)
			console.info(`[quality] ${note}; render scale → ${this.renderScale.toFixed(2)}`)
			this.publishFrameStats()
			this.applyRenderScale()
			return true
		}
		// Turbo keeps the picture and only ever scales. High and Dynamic keep going.
		if (this.config.q.governorScaleOnly) return false
		if (this.config.q.governorLock60) {
			this.ensureShedDefaults()
			if (this.liveContact && this.config.q.contactShading) {
				this.liveContact = false
				this.pushLoadShed(`${note}; contact shading off`)
				return true
			}
			if (this.liveCascades > 1) {
				this.liveCascades -= 1
				this.pushLoadShed(`${note}; shadow cascades → ${this.liveCascades}`)
				return true
			}
		}
		if (extras.windGrass) {
			extras.windGrass = false
			console.info(`[quality] ${note}; wind grass off`)
			this.publishFrameStats()
			return true
		}
		if (extras.weatherFx) {
			extras.weatherFx = false
			console.info(`[quality] ${note}; rain off`)
			this.publishFrameStats()
			return true
		}
		if (extras.nearField) {
			extras.nearField = false
			console.info(`[quality] ${note}; near-field grass off`)
			this.publishFrameStats()
			return true
		}
		if (this.config.q.governorLock60 && this.sceneryStep < 4) {
			this.sceneryStep = this.sceneryStep < 2 ? 2 : 4
			this.pushLoadShed(`${note}; scenery density 1/${this.sceneryStep}`)
			return true
		}
		return false
	}

	private canRestoreDynamic(target: number): boolean {
		const extras = this.config.extras
		const want = this.config.q
		if (this.config.q.governorLock60) this.ensureShedDefaults()
		return this.sceneryStep > 1
			|| (!extras.nearField && want.nearField)
			|| (!extras.weatherFx && want.weatherFx)
			|| (!extras.windGrass && want.windGrass)
			|| (want.governorLock60 && this.liveCascades < want.shadowCascades)
			|| (want.governorLock60 && !this.liveContact && want.contactShading)
			|| this.renderScale < target - 0.001
	}

	private restoreDynamic(p50: number, target: number): void {
		const extras = this.config.extras
		const want = this.config.q
		const note = `frame p50 ${p50.toFixed(1)} ms at display pace`
		if (this.sceneryStep > 1) {
			this.sceneryStep = this.sceneryStep > 2 ? 2 : 1
			this.pushLoadShed(`${note}; scenery density 1/${this.sceneryStep}`)
			return
		}
		if (!extras.nearField && want.nearField) {
			extras.nearField = true
			console.info(`[quality] ${note}; near-field grass on`)
		} else if (!extras.weatherFx && want.weatherFx) {
			extras.weatherFx = true
			console.info(`[quality] ${note}; rain on`)
		} else if (!extras.windGrass && want.windGrass) {
			extras.windGrass = true
			console.info(`[quality] ${note}; wind grass on`)
		} else if (want.governorLock60 && this.liveCascades < want.shadowCascades) {
			this.liveCascades += 1
			this.pushLoadShed(`${note}; shadow cascades → ${this.liveCascades}`)
			return
		} else if (want.governorLock60 && !this.liveContact && want.contactShading) {
			this.liveContact = true
			this.pushLoadShed(`${note}; contact shading on`)
			return
		} else if (this.renderScale < target) {
			this.renderScale = Math.min(target, this.renderScale / 0.85)
			console.info(`[quality] ${note}; render scale → ${this.renderScale.toFixed(2)}`)
			this.publishFrameStats()
			this.applyRenderScale()
			return
		}
		this.publishFrameStats()
	}

	private sendOrder(o: OrderRequest): Promise<string> {
		if (!this.bridge) return Promise.resolve('ignored: no bridge')
		const pending = o.contextual && this.bridge.issueContextOrder
			? this.bridge.issueContextOrder({
				subjectIds: o.subjectIds,
				subjectCount: o.subjectCount,
				targetActorId: o.targetActorId ?? 0,
				targetCellX: o.targetCell?.x ?? -1,
				targetCellY: o.targetCell?.y ?? -1,
				targetFrozen: o.targetFrozen ?? false,
				modifiers: o.modifiers ?? 0,
			})
			: this.bridge.issueOrder({
			orderString: o.orderString,
			subjectIds: o.subjectIds,
			subjectCount: o.subjectCount,
			targetActorId: o.targetActorId ?? 0,
			targetCellX: o.targetCell?.x ?? -1,
			targetCellY: o.targetCell?.y ?? -1,
			queued: o.queued ?? false,
			// '' not null: the marshaller wants a string, and the C# side maps empty to null.
			targetString: o.targetString ?? '',
			extraData: o.extraData ?? 0,
			extraCellX: o.extraCell?.x ?? -1,
			extraCellY: o.extraCell?.y ?? -1,
			})
		// The sim stays authoritative and rejects asynchronously now (worker round
		// trip). A rejection is evidence, not a crash: report it and keep rendering.
		return Promise.resolve(pending)
			.then(result => {
				if (!/^(?:ok|ignored)(?::|\b)/i.test(result))
					console.warn(`[steelseed] bridge rejected '${o.orderString}': ${result}`)
				return result
			})
			.catch(error => {
				console.warn('[steelseed] order failed:', error)
				return `error: ${error instanceof Error ? error.message : String(error)}`
			})
	}

	/**
	 * Drain any snapshot the bridge has ready. At most one per frame is decoded: the
	 * sim runs at 25 Hz and we render faster, so a backlog means the tab was throttled
	 * and the newest state is the only one worth drawing.
	 */
	private pumpSnapshots(nowMs: number): void {
		if (!this.bridge) return
		// The type table rides the worker's 4 Hz status push and the proxy serves it
		// SYNCHRONOUSLY — the same contract the pre-worker direct-call bridge had.
		// No gate, no timer, no race: when the first snapshot of a new world arrives,
		// the table is already in the cache from the same push cycle. The async
		// fallback handles bridges without a status push (dev fixture: async Promise).
		if (this.typeTable === null && this.bridge.snapshotTypeTable !== undefined) {
			const raw = this.bridge.snapshotTypeTable()
			if (typeof raw === 'string') {
				this.typeTable = raw.length > 0 ? raw.split('\n') : []
			} else {
				// Async bridge (dev fixture): kick the refresh and hold — the promise
				// settles in a microtask, before the next frame.
				this.refreshTypeTable()
				return
			}
		}
		let buf: Uint8Array | null = null
		let latest: Uint8Array | null = null
		let staticCarrier: Uint8Array | null = null
		const between = this.eventCarriers
		between.length = 0
		// ticks are monotonic, so the double dispatch ages correctly.
		while ((buf = this.bridge.pollSnapshot()) !== null) {
			if (latest !== null) {
				if (staticCarrier === null &&
					(new DataView(latest.buffer, latest.byteOffset, latest.byteLength).getUint32(24, true) & HeaderFlag.terrainStaticPresent) !== 0) {
					staticCarrier = latest
					// A new world starts here: anything drained before it belongs to the old one.
					between.length = 0
				} else {
					between.push(latest)
				}
			}
			latest = buf
		}
		if (!latest) return
		if (staticCarrier !== null && staticCarrier !== latest) {
			const carried = this.decoder.decode(staticCarrier)
			this.clock.onTick(carried.tick, nowMs)
			// Handlers read event payloads through ctx.snapshot, so it must be this snapshot
			// while its events publish (as on the latest path below).
			this.snapState.prev = this.snapState.snapshot
			this.snapState.snapshot = carried
			this.republishEvents(carried)
			this.registry.onSnapshot(carried, this.snapState.prev, this.ctx)
			if (this.awaitingNewWorld && (carried.flags & HeaderFlag.terrainStaticPresent) !== 0)
				this.newWorldSnapshotSeen = true
		}
		if (between.length > 0) this.republishBetween(between)

		const decoded = this.decoder.decode(latest)
		// Keep the previous snapshot alive for interpolation. Snapshots arrive as
		// distinct transferred buffers from the worker host, so prev and snapshot
		// never alias the same memory.
		this.snapState.prev = this.snapState.snapshot
		this.snapState.snapshot = decoded
		this.clock.onTick(decoded.tick, nowMs)

		this.republishEvents(decoded)
		this.registry.onSnapshot(decoded, this.snapState.prev, this.ctx)
		if (!this.firstWorldLogged) {
			this.firstWorldLogged = true
			console.info(`[boot] stage=first-world ms=${Math.round(performance.now())} tick=${decoded.tick}`)
		}
		if (this.awaitingNewWorld && (decoded.flags & HeaderFlag.terrainStaticPresent) !== 0)
			this.newWorldSnapshotSeen = true
	}

	/**
	 * The simulation-intake boundary.
	 *
	 * Everything from `pollSnapshot()` to the last `onSnapshot` consumer runs inside one
	 * try. Without it, a single throw anywhere in that chain propagates out of `tickFrame`
	 * BEFORE `registry.update` — so the renderer never runs, the canvas keeps showing the
	 * last frame, and the page reports one `Uncaught` per frame that nobody with the game
	 * in front of them will ever read.
	 *
	 * This is not swallowing the error. The reason is logged once, recorded on `simHealth`,
	 * and put on screen by `ui`; what it refuses to do is take the presentation down with
	 * the simulation, because a player who can still see and pan the battlefield can at
	 * least be told what happened.
	 */
	private pumpSnapshotsGuarded(nowMs: number): void {
		try {
			this.pumpSnapshots(nowMs)
		} catch (error) {
			this.reportSimFailure(`Snapshot intake failed: ${describeError(error)}`, error)
		}
	}

	/**
	 * Watchdog. Compares the simulation's clock against the render loop's.
	 *
	 * A stall is only a stall when the sim is not deliberately paused: the host publishes
	 * nothing while paused (`PollSnapshotToken` short-circuits on an unchanged tick and
	 * pause state), so a paused game is silent by design and must never raise the alarm.
	 */
	private evaluateSimHealth(nowMs: number): void {
		const health = this.simHealth
		const snap = this.snapState.snapshot
		if (!snap) return
		const advanced = snap.tick !== this.lastTickSeen
		if (advanced) {
			this.lastTickSeen = snap.tick
			this.lastTickAtMs = nowMs
		} else if (this.lastTickAtMs === 0) this.lastTickAtMs = nowMs
		health.tick = snap.tick

		// Starting a new skirmish tears the old world down and generates a map, which is a
		// legitimate silence of arbitrary length while the LAST match's snapshot is still the
		// current one. Stay quiet until the new world publishes its first tick.
		if (this.awaitingNewWorld) {
			if (!this.newWorldSnapshotSeen) {
				// Older bundles may fail to mark the first terrain snapshot. The session
				// can still expose the old match's running status and advancing ticks
				// during a build. Require a tick rewind or a loading->running transition
				// before starting the short grace; a 60s last resort avoids leaving
				// Dynamic disabled forever if a legacy bridge provides neither signal.
				const status = this.ctx.session.getStatus()?.status
				if (status === 'loading') this.newWorldLoadingSeen = true
				if (advanced && this.newWorldPreviousTick !== null && snap.tick < this.newWorldPreviousTick)
					this.newWorldProgressSeen = true
				const fallbackEligible = status === 'running' &&
					(this.newWorldProgressSeen || this.newWorldLoadingSeen || nowMs - this.newWorldWaitStartedMs >= 60000)
				if (advanced && fallbackEligible) {
					if (this.unmarkedWorldTicksSinceMs === 0) this.unmarkedWorldTicksSinceMs = nowMs
					else if (nowMs - this.unmarkedWorldTicksSinceMs >= 3000) {
						console.warn('[steelseed] new world has no terrain-static marker; resuming frame governor after running-tick grace')
						this.newWorldSnapshotSeen = true
					}
				} else if (!fallbackEligible) this.unmarkedWorldTicksSinceMs = 0
				if (!this.newWorldSnapshotSeen) {
					health.silentMs = 0
					return
				}
			}
			this.awaitingNewWorld = false
			this.newWorldSnapshotSeen = false
			this.unmarkedWorldTicksSinceMs = 0
			this.newWorldPreviousTick = null
			this.newWorldProgressSeen = false
			this.newWorldLoadingSeen = false
			this.governorHold = false
			this.governorMatchBuild = false
			this.lastTickSeen = snap.tick
			this.lastTickAtMs = nowMs
		}
		// Development bridges and tools may publish a world without a session
		// transition. The real lobby has no snapshot, so its hold stays in place.
		if (this.governorHold && !this.governorMatchBuild && advanced) this.governorHold = false

		if ((snap.flags & HeaderFlag.paused) !== 0) {
			this.lastTickAtMs = nowMs
			health.silentMs = 0
			this.clearSimFailure()
			return
		}

		const silentMs = nowMs - this.lastTickAtMs
		health.silentMs = silentMs
		// Ticks are arriving again, so whatever stopped them is over — including a decode
		// that threw, because a throw leaves the snapshot unassigned and the tick would
		// still be standing still if it were still throwing.
		if (silentMs < SIM_STALL_MS) {
			this.clearSimFailure()
			return
		}
		// The host is the only party that knows why it died; ask it before guessing.
		let status = ''
		try { status = this.bridge?.hostStatus?.() ?? '' } catch { status = '' }
		if (!status) status = String((globalThis as { steelseedHostFailure?: { reason?: string } })
			.steelseedHostFailure?.reason ?? '')
		health.hostStatus = status
		// Freeze reports used to carry only "tick 27" and force every diagnosis into a
		// guess. These probes are the host's own view at the moment of the stall: a
		// sync probe with `world=null` means the host lost its world; a netframe that
		// stands still with a live connection is lockstep starvation; a server error
		// line names the handshake/reject. Collected once, at discovery, exactly
		// because the stall may clear or kill the host afterwards.
		const probe = (label: string, read?: () => string): string => {
			try {
				const value = read?.() ?? ''
				return value ? `${label} ${value}` : `${label} unavailable`
			} catch (error) {
				return `${label} probe failed: ${String(error).slice(0, 120)}`
			}
		}
		health.diagnostics = [
			probe('sync:', () => this.bridge?.getSyncProbe?.() ?? ''),
			probe('conn:', () => this.bridge?.getConnectionProbe?.() ?? ''),
			probe('server:', () => this.bridge?.getServerErrorProbe?.() ?? ''),
		]
		const detail = status.startsWith('error:') ? status.slice(6) : status
		this.reportSimFailure(
			status.startsWith('error:') || status.startsWith('stopped')
				? `The simulation stopped: ${firstLine(detail)}`
				: `The simulation stopped responding at tick ${snap.tick} — no update for ${Math.round(silentMs / 1000)}s.`,
			status || undefined,
		)
	}

	/** Suspend the stall watchdog until a new world publishes its first tick. */
	awaitNewWorld(): void {
		this.awaitingNewWorld = true
		this.newWorldSnapshotSeen = false
		this.unmarkedWorldTicksSinceMs = 0
		this.newWorldWaitStartedMs = performance.now()
		this.newWorldPreviousTick = this.snapState.snapshot?.tick ?? null
		this.newWorldProgressSeen = false
		this.newWorldLoadingSeen = false
		this.governorHold = true
		this.governorMatchBuild = true
		// A new world resets the actor-type table to not-yet-read and kicks the
		// asynchronous refresh NOW: pumpSnapshots holds the new world's intake until
		// the table lands, so no node or menu can ever resolve a typeId against an
		// empty table and freeze a wrong answer (the units null-slot and the
		// build-menu "Unknown asset" labels were both this race).
		this.typeTable = null
		this.typeTableGeneration++
		this.typeTableEmptyFetches = 0
		this.typeTableMisses.clear()
		this.typeTableMissFrame = -1
		this.refreshTypeTable(true)
		this.events.emit(CoreEvent.newWorld)
		this.renderScale = this.config.q.internalScale
		this.config.extras.nearField = this.config.q.nearField
		this.config.extras.windGrass = this.config.q.windGrass
		this.config.extras.weatherFx = this.config.q.weatherFx
		this.liveCascades = -1
		this.liveContact = this.config.q.contactShading
		this.sceneryStep = 1
		this.pace = createPaceMachine(this.pacePreset())
		this.pushLoadShed('new world')
		this.frameSampleCount = 0
		this.frameSampleElapsedMs = 0
		this.headroomWindows = 0
		this.overCeilingWindows = 0
		this.governorWarmupWindows = 2
		this.publishFrameStats()
		this.applyRenderScale()
		this.clearSimFailure()
	}

	private reportSimFailure(reason: string, detail?: unknown): void {
		const health = this.simHealth
		health.stalled = true
		health.reason = reason
		if (this.reportedReason === reason) return
		this.reportedReason = reason
		// console.error, not warn: this is the loudest channel a headless gate reads, and
		// every gate in this project counts a console error as a failure. A silent
		// simulation death must never pass one of them again.
		console.error('[steelseed] simulation halted —', reason, detail ?? '')
		this.events.emit(CoreEvent.simHealth, health)
	}

	private clearSimFailure(): void {
		const health = this.simHealth
		if (!health.stalled) return
		health.stalled = false
		health.reason = ''
		health.hostStatus = ''
		health.diagnostics = []
		this.reportedReason = ''
		console.info('[steelseed] simulation resumed')
		this.events.emit(CoreEvent.simHealth, health)
	}

	/**
	 * Snapshots that arrived between two frames are never drawn, but their events are real: a
	 * shot fired and landed between frames must still flash and land. Republish them in tick
	 * order, each with ctx.snapshot pointing at its own buffer for the handlers. After a long
	 * stall (tab resume, seek) only the newest EVENT_CATCHUP_SNAPSHOTS replay; older ones are
	 * counted, so a resumed tab never fires a backlog of cosmetic effects.
	 */
	private republishBetween(between: readonly Uint8Array[]): void {
		const from = Math.max(0, between.length - EVENT_CATCHUP_SNAPSHOTS)
		this.eventStats.skipped += from
		const current = this.snapState.snapshot
		for (let i = from; i < between.length; i++) {
			const snap = this.decoder.decode(between[i]!)
			this.snapState.snapshot = snap
			this.republishEvents(snap)
			this.eventStats.between++
		}
		this.snapState.snapshot = current
	}

	/** Republish snapshot section 7 onto the JS bus for fx / audio / ui. */
	private republishEvents(snap: Snapshot): void {
		for (let i = 0; i < snap.events.length; i++) {
			const e = snap.events[i]
			if (e.kind === EventKind.eventsDropped && e.byteLength >= 4)
				this.eventStats.droppedBySink += snap.view.getUint32(e.offset, true)
			const key = SIM_EVENT_BY_KIND[e.kind]
			// An unknown kind is skipped, not thrown: the bridge is allowed to add
			// events without breaking a consumer built against an older table (§4.9).
			if (key) this.events.emit(key, e)
		}
	}

	private tickFrame = (nowMs: number): void => {
		if (!this.running) return
		this.raf = requestAnimationFrame(this.tickFrame)

		this.input.beginFrame()
		this.pumpSnapshotsGuarded(nowMs)
		this.evaluateSimHealth(nowMs)

		const dt = this.clock.frame(nowMs,((this.snapState.snapshot?.flags??0)&HeaderFlag.paused)!==0)
		this.registry.update(dt, this.ctx)
		this.registry.lateUpdate(dt, this.ctx)

		this.input.endFrame()
		this.governFrame(dt)
	}

	start(): void {
		if (this.running || this.disposed) return
		this.running = true
		this.raf = requestAnimationFrame(this.tickFrame)
	}

	stop(): void {
		this.running = false
		if (this.raf) cancelAnimationFrame(this.raf)
		this.raf = 0
	}

	/**
	 * Render exactly one frame at a fixed timestamp. Used by capture.mjs and
	 * baseline.mjs — a rAF-driven capture cannot be bit-identical across runs.
	 */
	renderOneFrame(atMs: number): void {
		this.input.beginFrame()
		this.pumpSnapshots(atMs)
		const dt = this.clock.frame(atMs,((this.snapState.snapshot?.flags??0)&HeaderFlag.paused)!==0)
		this.registry.update(dt, this.ctx)
		this.registry.lateUpdate(dt, this.ctx)
		this.input.endFrame()
	}

	/**
	 * Settle the first world for manual (?manual=1) boots.
	 *
	 * A manual boot never starts the rAF loop, so the tools that drive
	 * renderOneFrame() by hand would otherwise race the actor-type-table hold in
	 * pumpSnapshots: the first pump only kicks the async table refresh and drops
	 * its snapshot intake, leaving ctx.snapshot null for any gate that reads it
	 * immediately after the steelseed global appears. Resolves once a decoded
	 * snapshot is published; returns immediately when there is no bridge to pump
	 * or the world is already live. Bounded: a bridge that never produces a world
	 * fails the tool's own wait, not this loop.
	 */
	async ensureFirstSnapshot(): Promise<void> {
		for (let i = 0; i < 600 && !this.disposed; i++) {
			if (this.snapState.snapshot !== null || !this.bridge) return
			if (this.typeTable === null && this.bridge.snapshotTypeTable !== undefined) {
				this.refreshTypeTable()
				await this.typeTablePromise
				continue
			}
			this.pumpSnapshots(performance.now())
			const { promise, resolve } = Promise.withResolvers<void>()
			setTimeout(resolve, 16)
			await promise
		}
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		const errors: unknown[] = []
		const attempt = (release: () => void) => {
			try { release() } catch (error) { errors.push(error) }
		}
		attempt(() => this.stop())
		attempt(() => this.resizeObserver?.disconnect())
		this.resizeObserver = null
		attempt(() => this.registry.dispose())
		attempt(() => this.input.dispose())
		attempt(() => this.events.clear())
		if (errors.length) throw new AggregateError(errors, 'app: disposal failed')
	}
}

/**
 * Phones ship a 3× framebuffer. Together with the simulation that allocation is what
 * makes the tab die and the browser reload it. A finger screen stays at 1.5×.
 */
function presentationPixelRatio(): number {
	const raw = globalThis.devicePixelRatio || 1
	const coarse = typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(pointer: coarse)').matches
	return coarse ? Math.min(raw, 1.5) : raw
}

/** A throw is not always an Error — the bridge marshals strings and the host throws objects. */
function describeError(error: unknown): string {
	if (error instanceof Error) return error.message
	return String(error)
}

/** Host stacks arrive as one long multi-line string; a HUD line wants only the first. */
function firstLine(text: string): string {
	const end = text.indexOf('\n')
	return (end < 0 ? text : text.slice(0, end)).trim()
}

/**
 * WebGPU first, WebGL2 as the documented fallback (§5). The choice is made once at boot
 * and never changes — a mid-session backend swap would invalidate every pipeline,
 * texture and bind group every node created in init().
 */
async function selectBackend(canvas: HTMLCanvasElement, gpuTiming = false): Promise<{
	backend: 'webgpu' | 'webgl2'
	device: GPUDevice | null
	gl: WebGL2RenderingContext | null
}> {
	const gpu = (navigator as Navigator & { gpu?: GPU }).gpu
	if (gpu) {
		try {
			const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
			if (adapter) {
				// Timing is opt-in: without `?gputime=1` the device is requested exactly as always.
				const timing = gpuTiming && adapter.features.has('timestamp-query')
				const device = await adapter.requestDevice(timing ? { requiredFeatures: ['timestamp-query'] } : undefined)
				if (gpuTiming) {
					const info = adapter.info
					console.info(`[boot] gpu adapter vendor=${info?.vendor ?? '?'} architecture=${info?.architecture ?? '?'}`
						+ ` device=${info?.device || '?'} description=${info?.description || '?'} timestamp-query=${timing}`)
				}
				return { backend: 'webgpu', device, gl: null }
			}
		} catch {
			// Fall through. A WebGPU adapter that exists but fails to produce a device is
			// a real case on some drivers, and it must not take the whole boot down.
		}
	}
	const gl = canvas.getContext('webgl2', {
		alpha: false,
		antialias: false, // TAA does the antialiasing (§5.5); MSAA on top wastes bandwidth
		depth: true,
		stencil: false,
		powerPreference: 'high-performance',
		preserveDrawingBuffer: false,
	}) as WebGL2RenderingContext | null
	if (!gl) throw new Error('Redline Wars requires WebGPU or WebGL2; neither is available in this browser')
	return { backend: 'webgl2', device: null, gl }
}
