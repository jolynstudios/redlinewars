// STEELSEED — core/ctx
// The context object handed to every node. This is the whole surface a subsystem is
// allowed to see, and keeping it small is what makes the nodes independently buildable.

import type { Config } from './config'
import type { ContextOrderIntent, ContextOrderPreview } from './app'
import type { EventBus } from './events'
import type { Registry, System } from './registry'
import type { Rng } from './rng'
import type { Snapshot } from './snapshot'
import type { TimeState } from './clock'
import type { Input } from './input'

/**
 * Liveness of the simulation, as measured by the render loop.
 *
 * The two loops are independent (ARCHITECTURE.md §4): the WASM host ticks on its own rAF
 * chain and publishes snapshots; `core` renders on another one. A host that throws leaves
 * the camera fully interactive over a frozen world — a failure that looks exactly like a
 * crash to the player and exactly like nothing at all to the frame loop, because
 * `pollSnapshot()` returning null forever is what a paused game looks like too.
 *
 * This is the instrument that tells those apart, and it is readable rather than a boolean
 * on purpose: a stall whose `hostStatus` starts with `error:` is a DEAD simulation and
 * carries the host's own exception; a stall without one is a STUCK simulation.
 */
export interface SimHealth {
	/** Last decoded simulation tick. -1 before the first snapshot. */
	tick: number
	/** Wall-clock ms since the tick last advanced. 0 while healthy or before the first snapshot. */
	silentMs: number
	/** True once the simulation has been silent past the stall threshold while not paused. */
	stalled: boolean
	/** Player-readable cause. Empty while healthy. */
	reason: string
	/** Raw `HostStatus()` text captured when the stall was found: 'running', 'error:<stack>', ''. */
	hostStatus: string
	/**
	 * Host-side probe lines captured at the same moment, shown in the halt banner so a
	 * freeze report carries its own evidence: sync probe (world tick/hash, `world=null`
	 * when the host lost its world), connection probe (netframe, out-of-sync, client
	 * state), and the dedicated server's last error line. Empty while healthy.
	 */
	diagnostics: string[]
}

export interface Ctx {
	/** WebGPU device, or null on the WebGL2 path. */
	readonly device: GPUDevice | null
	/** WebGL2 context, or null on the WebGPU path. */
	readonly gl: WebGL2RenderingContext | null
	readonly backend: 'webgpu' | 'webgl2'
	readonly canvas: HTMLCanvasElement
	/**
	 * The canvas CSS size, kept by the app's ResizeObserver. Frame code reads it through
	 * canvasCssWidth/canvasCssHeight, never canvas.clientWidth: a layout read after the
	 * frame's DOM writes forces a synchronous layout (measured: main-thread frame p95
	 * 18.1 → 6.9 ms in a four-player battle). Hand-built gate contexts may omit it.
	 */
	readonly canvasCss?: CanvasCssSize
	readonly config: Config
	readonly events: EventBus
	readonly input: Input
	readonly time: TimeState
	/** Root RNG. Prefer `ctx.rng.forkNamed('my-generator')` over sharing this one. */
	readonly rng: Rng
	/** Latest decoded snapshot, or null before the first tick. */
	readonly snapshot: Snapshot | null
	/** Previous snapshot, for interpolation. Null on the first tick. */
	readonly prevSnapshot: Snapshot | null
	/** Host-owned match lifecycle controls. Gameplay inside a match still travels as orders. */
	readonly session: SessionApi
	/** Authoritative OpenRA building-placement query/validation seam. */
	readonly placement: PlacementApi
	/** Whether the simulation is still advancing, and why not when it is not. */
	readonly simHealth: SimHealth
	/**
	 * The WebGPU device was lost (driver reset, GPU removed, out of memory): its reason and
	 * message, or null. Every node built its pipelines, textures and bind groups on that device in
	 * init(), so the view cannot continue; the simulation does.
	 */
	readonly gpuLost: GpuLoss | null

	get<T = System>(id: string): T
	peek<T = System>(id: string): T | null
	has(id: string): boolean

	/** Queue an order for the simulation. JS never mutates actor state directly (§4.11). */
	/** Resolves to the bridge's reply: `ok: …`, `ignored: …` or `error: …`. */
	issueOrder(order: OrderRequest): Promise<string>
	/** Read-only OpenRA targeter preview, shared with contextual dispatch. */
	queryContextOrder(order: ContextOrderIntent): Promise<ContextOrderPreview | null>
	/** Charge status of the local player's support powers, or null when unavailable. */
	readonly supportPowers?: () => SupportPowersStatus | null

	/**
	 * Mod actor-type name for a §4.5 `typeId`, or '' when the bridge published no table.
	 *
	 * Read rather than assumed: typeIds are assigned in FIRST-SEEN order on the C# side,
	 * not from a fixed enum, so they are stable within a session and meaningless across
	 * mods. A hard-coded table here would silently mismatch the moment the mod adds an
	 * actor, and would do it by drawing the wrong unit rather than by failing.
	 *
	 * The empty string is a real answer, not an error — a graph running against the dev
	 * fixture or a partial harness has no mod behind it. Callers pick a fallback rather
	 * than fail, so a missing table costs a generic silhouette and not a boot (rule 8).
	 */
	actorTypeName(typeId: number): string
}

export interface CatalogChoice {
	id: string
	name?: string
	label?: string
}

export interface SkirmishSlotCatalog {
	id: string
	required: boolean
	allowBots: boolean
	locks: { faction: boolean; color: boolean; team: boolean; spawn: boolean }
	defaults: { faction: string; color: string; team: number; spawn: number }
}

export interface SkirmishMapCatalog {
	uid: string
	title: string
	author: string
	tileSet: string
	bounds: { x: number; y: number; width: number; height: number }
	spawnPoints: { id: number; x: number; y: number }[]
	slots: SkirmishSlotCatalog[]
	factions: (CatalogChoice & { side?: string; description?: string })[]
	bots: CatalogChoice[]
	colors: string[]
	options: {
		id: string
		name: string
		description: string
		values: CatalogChoice[]
		defaultValue: string
		isLocked: boolean
		isVisible: boolean
		displayOrder: number
	}[]
}

export interface SkirmishCatalog {
	schemaVersion: number
	engine: { mod: string; upstreamCommit: string }
	sessionTransports: {
		local: { supported: boolean }
		network: { supported: boolean; status: string }
	}
	defaultGameSpeed: string
	gameSpeeds: (CatalogChoice & { timestep: number; orderLatency: number })[]
	maps: SkirmishMapCatalog[]
	status?: string
	code?: string
	userMessage?: string
}

export interface SkirmishPlayerConfig {
	slot: string
	kind: 'human' | 'bot' | 'open' | 'closed'
	botType?: string
	faction: string
	color: string
	team: number
	spawn: number
}

export interface StartSkirmishConfig {
	schemaVersion: number
	transport: 'local'
	mapUid: string
	gameSpeed: string
	/** Optional deterministic server seed used by parity/CI fixtures. */
	randomSeed?: number
	local: Omit<SkirmishPlayerConfig, 'kind' | 'botType'> & { name: string }
	slots: SkirmishPlayerConfig[]
	options: Record<string, string>
}

export interface SessionStatus {
	schemaVersion: number
	status: 'loading' | 'running' | 'error' | 'idle'
	code: string
	userMessage: string
}

/**
 * Narrow browser-host seam for creating a simulation world.
 *
 * This is deliberately separate from `issueOrder`: there is no World to receive an order
 * before a skirmish starts. Once a World exists, all gameplay mutations go through real
 * OpenRA orders and this surface is no longer involved.
 */
export interface SessionApi {
	readonly available: boolean
	getCatalog(): Promise<SkirmishCatalog | null>
	startSkirmish(config: StartSkirmishConfig): Promise<SessionStatus>
	/** Synchronous: served from the bridge's status cache in worker mode. */
	getStatus(): SessionStatus | null
	setPaused(paused: boolean): Promise<string>
	/**
	 * Suspend the stall watchdog for the (unbounded) map load that follows a
	 * network join. The network session itself is driven through the bridge
	 * wrappers by the session UI; only the watchdog hold needs the app.
	 */
	beginNetworkJoin?(): Promise<void>
}

export interface PlacementRequest {
	queueId: number
	actorType: string
	cellX: number
	cellY: number
	variant?: number
	/** Placement ABI modifiers: bit 0 is Shift (suppresses LineBuild). */
	modifiers?: number
}

export interface PlacementCellResult {
	x: number
	y: number
	valid: boolean
	lineBuild: boolean
	flags: number
}

export interface PlacementResult {
	statusCode: number
	status: string
	valid: boolean
	issued: boolean
	tick: number
	orderType: 'none' | 'PlaceBuilding' | 'LineBuild' | 'PlacePlug'
	producerId: number
	queueId: number
	variant: number
	topLeft: { x: number; y: number }
	dimensions: { x: number; y: number }
	modifiers: number
	cells: readonly PlacementCellResult[]
}

export interface PlacementApi {
	readonly available: boolean
	query(request: PlacementRequest): Promise<PlacementResult | null>
	place(request: PlacementRequest): Promise<PlacementResult | null>
}

export interface OrderRequest {
	orderString: string
	/**
	 * Selected actors. **Empty means a PLAYER-level order**, not an empty one — production
	 * and building placement are issued on the player actor rather than on a selection, so
	 * the bridge treats an empty list as "issue on RenderPlayer.PlayerActor". Leaving these
	 * inexpressible is what made the economy unreachable across this seam.
	 */
	subjectIds: Uint32Array
	/** Prefix of subjectIds to send. Omitted means the complete typed array. */
	subjectCount?: number
	targetActorId?: number
	/** Target actor id refers to the render player's OpenRA FrozenActorLayer. */
	targetFrozen?: boolean
	targetCell?: { x: number; y: number }
	queued?: boolean
	/** Ask OpenRA's own IOrderTargeters to choose move/attack/enter/repair/etc. */
	contextual?: boolean
	/** OpenRA TargetModifiers bits: force attack=1, queue=2, force move=4. */
	modifiers?: number
	/**
	 * `Order.TargetString` — the item name for `StartProduction`, the building name for
	 * `PlaceBuilding`. Meaningless for movement orders.
	 */
	targetString?: string
	/**
	 * `Order.ExtraData`, an OpenRA uint: the count for `StartProduction`, the stance for
	 * `SetUnitStance`. `0xFFFFFFFF` is uint.MaxValue, which Airstrike and Paratroopers read as
	 * "no direction".
	 */
	extraData?: number
	/** `Order.ExtraLocation`, the Chronoshift source cell. */
	extraCell?: { x: number; y: number }
}

/** One support power's charge state, read from the engine's SupportPowerManager. */
export interface SupportPowerStatus {
	/** The OpenRA order string that fires this power (the manager's dictionary key). */
	readonly key: string
	/** Localised power name, or the raw key when the mod defines no fluent name. */
	readonly title: string
	readonly active: boolean
	readonly ready: boolean
	readonly remainingTicks: number
	readonly totalTicks: number
	/** Chronoshift: the first click picks the source cell (Order.ExtraLocation). */
	readonly needsSource?: boolean
	/** Schema 2. A nuke's beacon: ticks from launch until it is removed (0: no tick beacon). */
	readonly beaconTicks?: number
	/**
	 * Schema 2. An airstrike's or a paradrop's beacon stands until the first delivering aircraft
	 * of this type is within `beaconRangeCells` of the target (OpenRA's OnEnterRange).
	 */
	readonly beaconUnit?: string | null
	readonly beaconRangeCells?: number
	/** Schema 2. Ticks a spawned support actor lives (the sonar pulse's detector), else 0. */
	readonly effectTicks?: number
}

/**
 * Schema 2. A public superweapon timer, as OpenRA's SupportPowerTimerWidget shows it: any
 * player's power whose DisplayTimerRelationships include the viewer (RA: the Atom Bomb and the
 * GPS satellite, for everyone).
 */
export interface SupportPowerTimerStatus {
	readonly key: string
	readonly title: string
	/** The snapshot's player index of the owner. */
	readonly player: number
	readonly playerName: string
	/** The owner's colour, `#rrggbb`. */
	readonly color: string
	/** The owner is the viewer or an ally. */
	readonly allied: boolean
	readonly ready: boolean
	readonly active: boolean
	readonly remainingTicks: number
	readonly totalTicks: number
	/** The rules' launch notification for allies, and the incoming one for everyone else. */
	readonly launchText?: string | null
	readonly incomingText?: string | null
}

/**
 * Schema 2. A nuclear launch the host saw, announced from the missile itself (a restarted timer
 * proves nothing: a spy's reset restarts it too). The target is only told to the launcher's allies.
 */
export interface SupportLaunchStatus {
	readonly id: number
	/** The launching power's key. */
	readonly key: string
	/** The snapshot's player index of the launcher. */
	readonly player: number
	/** The launcher is the viewer or an ally. */
	readonly allied: boolean
	readonly tick: number
	/** The rules' launch line for allies, the incoming one for everyone else; null when none. */
	readonly text?: string | null
	/** The target in WPos, for allies only (0 otherwise). */
	readonly targetX: number
	readonly targetY: number
	/** Allies: the beacon's ticks (NukePower FlightDelay - BeaconRemoveAdvance). */
	readonly beaconTicks: number
}

export interface SupportPowersStatus {
	readonly schemaVersion: number
	/** Milliseconds per simulation tick at the match's game speed. */
	readonly timestepMs?: number
	/** The local player's power outage (a spy in a power plant): ticks left and its length. */
	readonly powerOutageTicks?: number
	readonly powerOutageTotalTicks?: number
	readonly powers: readonly SupportPowerStatus[]
	/** Schema 2: every player's public superweapon timers. */
	readonly timers?: readonly SupportPowerTimerStatus[]
	/** Schema 2: nuclear launches of the last ~250 ticks. */
	readonly launches?: readonly SupportLaunchStatus[]
	/** Structures OpenRA shows the viewer as infiltrated fakes (InfiltrateForDecoration; actor ids). */
	readonly revealed?: readonly number[]
}

/** A lost WebGPU device: GPUDeviceLostInfo's reason and message. */
export interface GpuLoss {
	readonly reason: string
	readonly message: string
}

export interface CanvasCssSize {
	readonly width: number
	readonly height: number
}

/** The canvas CSS width for frame code: the observed size, else (before the first report, or
 *  in a DOM-free gate) the element's own. */
export function canvasCssWidth(ctx: { readonly canvas?: { readonly clientWidth: number } | null; readonly canvasCss?: CanvasCssSize }): number {
	return ctx.canvasCss?.width || ctx.canvas?.clientWidth || 0
}

/** The canvas CSS height for frame code; see canvasCssWidth. */
export function canvasCssHeight(ctx: { readonly canvas?: { readonly clientHeight: number } | null; readonly canvasCss?: CanvasCssSize }): number {
	return ctx.canvasCss?.height || ctx.canvas?.clientHeight || 0
}

export interface CtxHost {
	device: GPUDevice | null
	gl: WebGL2RenderingContext | null
	backend: 'webgpu' | 'webgl2'
	canvas: HTMLCanvasElement
	/** Updated by the app's ResizeObserver; zero until it first reports. */
	canvasCss: { width: number; height: number }
	actorTypeName(typeId: number): string
	config: Config
	events: EventBus
	input: Input
	time: TimeState
	rng: Rng
	registry: Registry
	session: SessionApi
	placement: PlacementApi
	simHealth: SimHealth
	gpuLost?: GpuLoss | null
	sendOrder(order: OrderRequest): Promise<string>
	queryContextOrder?(order: ContextOrderIntent): Promise<ContextOrderPreview | null>
	supportPowers?: () => SupportPowersStatus | null
}

/**
 * Builds the Ctx. Snapshot fields are getters over mutable host state so a node can
 * hold the ctx reference for its whole lifetime and always read current values —
 * rebuilding a ctx object per tick would violate rule 6.
 */
export function createCtx(host: CtxHost, state: { snapshot: Snapshot | null; prev: Snapshot | null }): Ctx {
	return {
		get device() {
			return host.device
		},
		get gl() {
			return host.gl
		},
		get backend() {
			return host.backend
		},
		get canvas() {
			return host.canvas
		},
		get canvasCss() {
			return host.canvasCss
		},
		get config() {
			return host.config
		},
		get events() {
			return host.events
		},
		get input() {
			return host.input
		},
		get time() {
			return host.time
		},
		get rng() {
			return host.rng
		},
		get snapshot() {
			return state.snapshot
		},
		get prevSnapshot() {
			return state.prev
		},
		get session() {
			return host.session
		},
		get placement() {
			return host.placement
		},
		get simHealth() {
			return host.simHealth
		},
		get gpuLost() {
			return host.gpuLost ?? null
		},
		get: (id) => host.registry.get(id),
		peek: (id) => host.registry.peek(id),
		has: (id) => host.registry.has(id),
		issueOrder: (o) => host.sendOrder(o),
		queryContextOrder: (o) => host.queryContextOrder?.(o) ?? null,
		supportPowers: () => host.supportPowers?.() ?? null,
		actorTypeName: (t) => host.actorTypeName(t),
	} as Ctx
}
