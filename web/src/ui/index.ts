// STEELSEED — ui
// Selection: the first thing a player does, and the last thing this project built.
//
// `RESUME-CLAUDE.md` has listed "the PLAYABLE gap (selection feedback)" as top open work since
// the first build session. Everything else in the game responds to the simulation; nothing has
// ever responded to the PLAYER. A camera you can fly over an army you cannot touch is a
// diorama.
//
// SELECTION IS A CLIENT CONCERN AND LIVES HERE, not in the snapshot. What one player has
// highlighted is not part of
// the simulation, must not affect the sync hash, and must not cost a tick of latency. The
// snapshot tells us what EXISTS; this node decides what the local player is looking at.
//
// Selection and combat share one ground-ring mesh. Neutral, friendly and hostile batches
// keep the existing footprint and depth testing; identification never covers the actor with
// a screen-facing disk or changes its team markings.

import { Mesh } from '../geo/mesh'
import * as sdf from '../geo/sdf'
import {
	ActorFlag,
	ActorStatusKind,
	HeaderFlag,
	PlayerFlag,
	ProductionItemFlag,
	ProductionQueueFlag,
	ShroudState,
	SimEvent,
	canvasCssHeight,
	canvasCssWidth,
	type Ctx,
	type ContextOrderIntent,
	type ContextOrderPreview,
	type ProductionQueueView,
	type PlacementResult,
	type SkirmishCatalog,
	type SkirmishMapCatalog,
	type Snapshot,
	type SnapshotEvent,
	type StartSkirmishConfig,
	findActorIndex,
	isGraphicsChoice,
	GRAPHICS_CHOICES,
	type QualityDetection,
	readStoredQuality,
	storeDistantMountains,
	storeQuality,
	SIM_TICK_MS,
	type SupportPowerStatus,
	type SupportPowersStatus,
	m4,
	type Mat4,
} from '../core'
import type { AudioApi, CameraApi, DrawItem, GpuMesh, RenderApi, ShroudApi, SkyApi, TerrainApi, UnitsApi } from './types'
import { productionAction, productionPortrait } from './production'
import { actionFeedback, ATTACK_GLYPH, type ActionFeedback } from './action-feedback'
import { beginMatchReport, finishMatchReport, flushPendingMatchReports, type MatchReportOutcome } from './match-report'
import { closeCodeToStringId, mpIsLocalHostname } from '../core/mp-protocol'
import { loadNetConfig, type NetConfig } from '../core/net-config'
import { configureAccountOrigin } from '../core/account'
import { rankedQueueCancel, rankedQueueStart, rankedQueueStatus, rankedSettlement, type RankedQueueState, type RankedQueueStatus } from '../core/ranked'
import { CONDITION_COPY, colourName, factionTagline, GRAPHICS_COPY, HIDDEN_OPTIONS, humanizeStartError, relativeLuminance, RULE_COPY, RULE_GROUPS, RULE_LABEL, StartRefused } from './setup-copy'
import { openOverlay, type Overlay, ruleRow, segmented, setControlCues, setSelect, stepper, toggle } from './setup-controls'
import { createSchematic, type Schematic, type SpawnMarker } from './map-schematic'
import { accountAvatarUpload, accountAvatarUrl, accountDeviceLogin, accountFetch, accountGuest, accountJson, accountLogout, accountStatus, type AccountUser } from '../core/account'
import { SFX_BANKS } from './sfx-banks'
import { beginnerBuildOrder, sideOf, type ManifestActors } from './build-order'
import { Tutorial, type TutorialElements } from './tutorial'
import { markTutorialDone, shouldAutoStart, tutorialSteps, type QueueItemState } from './tutorial-steps'
import { canJoinFromRoomList, type MpPhase } from './room-join-policy'
// The authoritative RA trait manifest, read directly like fx/ground-tracks does: sell mode
// only needs to know which actor types carry OpenRA's Sellable trait, and that is exactly
// what the manifest exports.
import RA_VISUAL_MANIFEST from '../core/ra-visual-manifest.json'
/**
 * The deploy button's order and label, from the units node's reading of the authoritative
 * RA traits: a Transforms actor (MCV) transforms, a Cargo actor unloads, a
 * GrantConditionOnDeploy actor (demolition truck) deploys in place, a MadTank detonates. Null when the actor
 * has no deploy order at all. OpenRA resolves and executes whatever is sent.
 */
function deployOrderFor(units: UnitsApi, actorName: string): { order: string; label: string } | null {
	const order = units.deployOrder(actorName)
	if (order === 'DeployTransform') return { order, label: 'Deploy / expand' }
	if (order === 'Unload') return { order, label: 'Unload passengers' }
	if (order === 'GrantConditionOnDeploy') return { order, label: 'Deploy' }
	if (order === 'Detonate') return { order, label: 'Detonate (MAD)' }
	return null
}

/** The manifest's actor table: lower-cased type name to its authoritative trait list. */
interface RaActorVisual {
	readonly traits?: readonly { readonly Name?: string }[]
}
// Structural annotation, not a cast: the JSON module's inferred type is the full manifest
// graph, and this declares (and lets the compiler check) the one slice this node reads.
const RA_ACTOR_TRAITS: Record<string, RaActorVisual> = RA_VISUAL_MANIFEST.actors

/**
 * Whether OpenRA's Sellable trait covers this actor type — every player-buildable
 * structure and wall in the RA rules, nothing else. The check only arms the sell cursor
 * honestly; the simulation still refuses a Sell order its own rules do not allow.
 */
function sellableActor(actorName: string | undefined): boolean {
	if (!actorName) return false
	const traits = RA_ACTOR_TRAITS[actorName.toLowerCase()]?.traits
	if (!traits) return false
	for (const trait of traits) if (trait.Name === 'Sellable') return true
	return false
}

/**
 * Whether OpenRA's RepairableBuilding trait covers this actor type — player structures,
 * not units. The check only arms the repair button honestly; the simulation still
 * refuses a RepairBuilding order its own rules do not allow.
 */
function repairableActor(actorName: string | undefined): boolean {
	if (!actorName) return false
	const traits = RA_ACTOR_TRAITS[actorName.toLowerCase()]?.traits
	if (!traits) return false
	for (const trait of traits) if (trait.Name === 'RepairableBuilding') return true
	return false
}

/** §5.9: the {dir,key} pair a local-node spawner hands the page, runtime-narrowed
 *  before any use — the page never trusts an unvalidated global shape. */
function asLocalNodeKey(value: unknown): { dir: string; key: string } | null {
	if (typeof value !== 'object' || value === null || !('dir' in value) || !('key' in value)) return null
	if (typeof value.dir !== 'string' || typeof value.key !== 'string' || value.dir === '') return null
	return { dir: value.dir, key: value.key }
}

/** Health bars drawn per frame at most; the pool is built once at init and never grows. */
const MAX_HEALTH_BARS = 192
/** Timed-state bars (Iron Curtain, chronoshift return), under the health bar; pooled, never grown. */
const MAX_STATUS_BARS = 48
/** Iron Curtain crimson, not fire orange; the chronoshift return is the Chronosphere's blue. */
const CURTAIN_BAR = 'rgb(214, 36, 64)'
const CHRONO_BAR = 'rgb(96, 172, 255)'
/** A support power is a player-level order: no subjects (SupportPowerManager lives on the player actor). */
const NO_SUBJECTS = new Uint32Array(0)
/** A fired power still ready after this long was refused by the simulation. */
const SUPPORT_CONFIRM_MS = 2000
/** No beacon outlives this, whatever it waits for (an airstrike whose planes never came). */
const BEACON_MAX_TICKS = 1500
/** The Iron Curtain's and the Chronosphere's footprint, `_x_ xxx _x_` around the aimed cell. */
const FOOTPRINT_PLUS: readonly (readonly [number, number])[] = [[0, -1], [-1, 0], [0, 0], [1, 0], [0, 1]]
/**
 * Ranges OpenRA draws while one of these is selected (WithRangeCircle@JAMMER, RenderJammerCircle,
 * RenderShroudCircle): the MRJ jams radar out to 18 cells and deflects missiles within 5; the MGG
 * spreads shroud out to 7 and the gap generator building to 6 (CreatesShroud Range). Colours
 * after the rules' 0000FF80 jammer ring.
 */
const RANGE_OUTLINES: Readonly<Record<string, readonly (readonly [number, string])[]>> = {
	mrj: [[18, 'rgba(70,110,255,0.7)'], [5, 'rgba(150,180,255,0.75)']],
	mgg: [[7, 'rgba(210,214,220,0.7)']],
	gap: [[6, 'rgba(210,214,220,0.7)']],
}
const MAX_RANGE_OUTLINES = 6
/** Segments in one range outline; each vertex sits on the ground it crosses. */
const RANGE_OUTLINE_SEGMENTS = 48
/** A dev-only order trace (`?ordertrace=1`): pointer to cell to order to reply to first response. */
const ORDER_TRACE = typeof location !== 'undefined' && /[?&]ordertrace=1\b/.test(location.search)
/** The support effects the UI starts; resolved lazily, never a static dependency of the UI. */
interface SupportFxApi { supportEffect?(kind: 'satellite' | 'sonar', x: number, z: number, durationS?: number): void }
const MAX_STATUS_MARKS = 64
/** Repair marks drawn per frame at most; pooled with the health bars, never grown. */
const MAX_REPAIR_MARKS = 48
/** UnitStance names by enum order — matches the engine's SetUnitStance extraData byte. */
const STANCE_NAMES = ['HoldFire', 'ReturnFire', 'Defend', 'AttackAnything'] as const
const MAX_VETERANCY_MARKS = 48
/** Fakes a spy of ours has been inside, tagged at most per frame (InfiltrateForDecoration). */
const MAX_FAKE_TAGS = 12

/** RA health-bar colour: green above two thirds, yellow above one third, red below. */
const uiPalette = { brand: '#C93630', active: '#7DB9C8', ink: '#E9E5DB', dim: '#A8B2BA', warning: '#D9AE61', critical: '#FF6B63', healthy: '#87BC91', divider: '#394750' }
function readUiPalette(): void {
    const css = getComputedStyle(document.documentElement)
    for (const key of Object.keys(uiPalette) as (keyof typeof uiPalette)[]) {
        uiPalette[key] = css.getPropertyValue(`--${key}`).trim() || uiPalette[key]
    }
}
/** Convert the hex HUD token once; drawn indicators use the renderer's linear colour. */
function linearRingColor(hex: string, out: Float32Array): void {
	const rgb = Number.parseInt(hex.replace('#', ''), 16)
	for (let channel = 0; channel < 3; channel++) {
		const c = ((rgb >> (16 - channel * 8)) & 255) / 255
		out[channel] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
	}
}

function healthColour(health: number): string {
	return health >= 170 ? uiPalette.healthy : health >= 85 ? uiPalette.warning : uiPalette.critical
}

/** WPos is 1024 per cell and one cell is one metre (§12.4). */
const WPOS_TO_M = 1 / 1024

/**
 * Click tolerance in CSS pixels.
 *
 * Generous on purpose. At the closest legal camera a unit is 60-100 px across, but at the far
 * end it is a handful, and a pixel-exact hit test on a 4 px target is a game that feels broken
 * rather than precise. Nearest-within-radius, so a crowd still resolves to one actor.
 */
const PICK_RADIUS_PX = 28
/** Right-click targeting is more forgiving than selection: a near miss on an enemy must attack, not walk. */
const TARGET_RADIUS_PX = 44

/**
 * No pointer press was recorded for this order or selection, so key state is the only
 * evidence there is. A real press always carries its own modifier bits, including zero.
 */
const MODIFIERS_NO_PRESS = -1

/** Screen heights of ground covered per second while an on-screen pan control is held. */
const PAN_RATE = 0.55
/** One tap of a pan control, so a click does something without needing to be held. */
const PAN_TAP = 0.16
const ZOOM_RATE = 5.5
const ZOOM_TAP = 0.55
const TILT_RATE = 0.6
const TILT_TAP = 0.05
const TURN_RATE = 1.1
const TURN_TAP = 0.09

/**
 * Locomotor bits the host writes into the passability plane, straight out of each
 * Locomotor's own MovementCostForCell: 1 foot, 2 wheeled, 4 tracked, 8 naval, 16 outside the
 * map. This is the simulation's own reachability answer, not a guess made from the surface.
 */
const LOCOMOTOR_BITS = 15
const OFF_MAP_BIT = 16

/** How long an order marker stays on screen, in milliseconds. */
const ORDER_MARKER_MS = 1100
// --- Navigation aids ---------------------------------------------------------
//
// The compass tape is a fixed 120-degree window across a 480 CSS-pixel strip at the
// bottom-centre, backed at 2x so labels stay crisp at any DPR. Every string it can
// draw is built once here; the per-frame path only reads, so a spinning camera
// allocates nothing (rule 6).
const COMPASS_WIDTH = 480
const COMPASS_HEIGHT = 52
const COMPASS_BACKING = 2
const COMPASS_PX_PER_DEGREE = 4
const COMPASS_TICK_STEP = 15
const COMPASS_TICK_COUNT = 360 / COMPASS_TICK_STEP
/** Cardinal labels, one per 45 degrees; index is the tick slot divided by three. */
const COMPASS_CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

/** '000°'..'359°' indexed by whole degree, so the readout never builds a string per frame. */
function compassReadoutTable(): string[] {
	const out: string[] = new Array(360)
	for (let i = 0; i < 360; i++) out[i] = `${i < 100 ? i < 10 ? '00' : '0' : ''}${i}°`
	return out
}
const COMPASS_READOUTS = compassReadoutTable()

/** Overview compass letters and their fixed positions in minimap pixels: x,y per letter. */
const MINIMAP_CARDINAL_LETTERS = ['N', 'E', 'S', 'W']
const MINIMAP_CARDINAL_XY = new Float32Array([112, 10, 214, 66, 112, 122, 10, 66])

/** OpenRA TargetModifiers layout: force attack 1, force queue 2, force move 4. */
function modifierBits(event: MouseEvent): number {
	return (event.ctrlKey ? 1 : 0) | (event.shiftKey ? 2 : 0) | (event.altKey ? 4 : 0)
}
/** Distance before a click becomes a visible RTS drag-selection gesture. */
const DRAG_SELECT_THRESHOLD_PX = 6

/**
 * Reference ring radius in metres. Each instance is scaled to the procedural actor footprint
 * published by `units`, so a refinery gets a building-sized ring and infantry stays compact.
 */
const RING_RADIUS_M = 0.9
const MAX_SELECTION = 256
const NO_ACTOR_TYPE = 0xffff
/** Mobile combat roles the L-flash and the select-all button consider "troops". Harvesters,
 * structures, wrecks and map system actors are deliberately outside this set. */
const TROOP_ROLES = new Set(['soldier', 'tracked-vehicle', 'wheeled-vehicle', 'mcv',
	'rotorcraft', 'fixed-wing', 'ship', 'submarine', 'transport', 'minelayer'])
/** Enemy movement heat accumulates from mobile actors only: troops plus harvesters. */
const HEAT_ROLES = new Set([...TROOP_ROLES, 'harvester'])
/** Static base buildings that get a name label on the tactical map. */
const TACTICAL_BUILDING_ROLES = new Set(['structure', 'powerplant', 'barracks', 'factory',
	'airfield', 'refinery', 'silo', 'superweapon', 'naval-yard', 'repair'])
/** RA's terrain decoration ships as "structures" (trees, ore fields); their display
 * names would bury the actual base under dozens of identical labels. */
const TACTICAL_LABEL_SKIP = new Set(['Tree', 'Ore Mine', 'Gems', 'Crater', 'Rocks'])
/** The tactical map draws at this multiple of the strategic-overview canvas. */
const TACTICAL_SCALE = 5
/** Blink cadence of the L troop highlight: half-period in ms (4 Hz on/off). */
const TROOP_HIGHLIGHT_HALF_PERIOD_MS = 125
/** Instance capacity of the L troop highlight: enough rings for the largest own army. */
const TROOP_HIGHLIGHT_CAPACITY = 512
const EMPTY_SUBJECTS = new Uint32Array(0)
const PICK_TRANSFORM = new Float32Array(16)
const PICK_VISUAL: { mesh: GpuMesh | null; surfaceSet: string; playerColor: number } = {
	mesh: null, surfaceSet: '', playerColor: 0,
}

/** Screen and world anchor of one actor's drawn centre, shared by every projection. */
interface ActorProjection {
	x: number
	y: number
	worldX: number
	worldY: number
	worldZ: number
	groundY: number
	height: number
}

/**
 * Projection scratch. `projectActorCentre` writes here instead of returning a fresh
 * object: the hover path re-runs the pick every frame, and a per-actor object literal
 * would turn aiming the cursor into a garbage factory. Callers use the result within
 * their loop iteration, which the shared record is safe for.
 */
const ACTOR_PROJECTION: ActorProjection = {
	x: 0, y: 0, worldX: 0, worldY: 0, worldZ: 0, groundY: 0, height: 0,
}

/**
 * The projection of the actor `pickActorAt` last scored best. Valid only while that call
 * returned >= 0; the hover marker anchors its brackets from these numbers without a
 * second projection pass.
 */
const PICKED: ActorProjection & { score: number; boxHit: boolean; t: number } = {
	score: 1, x: 0, y: 0, worldX: 0, worldY: 0, worldZ: 0, groundY: 0, height: 0, boxHit: false, t: Infinity,
}
/** The exact pick's winner, kept apart from the nearness winner until the loop ends. */
const BOX_PICKED: ActorProjection = { x: 0, y: 0, worldX: 0, worldY: 0, worldZ: 0, groundY: 0, height: 0 }
/**
 * The pointer's ray in world metres (the eye, a unit direction), for the exact pick: a click
 * lands on the frontmost actor whose drawn box the ray enters, as the eye sees it, and not on
 * whichever centre is nearest on screen, which next to a large building is a small neighbour.
 */
const POINTER_RAY = { ok: false, ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 0 }
const POINTER_RAY_INVERSE = new Float32Array(16)
/** Whether the last projection read the drawn mesh (PICK_TRANSFORM, PICK_VISUAL) or fell back. */
let PROJECTED_DRAWN = false
const QUEUE_NAMES = ['Structures / defenses', 'Infantry', 'Vehicles', 'Aircraft', 'Naval'] as const
const NOTICE_TICKS = 100
/** How long a combat ring stays under an actor after its last combat action. */
const COMBAT_RING_MS = 5000
// Split so the assetless source gate does not mistake the DOM namespace for a network URL.
const SVG_NAMESPACE = ['http:', '', 'www.w3.org', '2000', 'svg'].join('/')
interface HudItemDom {
	actorType: number
	button: HTMLButtonElement
	name: HTMLElement
	meta: HTMLElement
	queued: HTMLElement
	status: HTMLElement
	progress: HTMLElement
	/** Set once the 100%-voice for this item has fired; fresh DOM restarts the edge. */
	wasReady?: boolean
}

/** Most recent transport close, as the mp-socket layer recorded it. */
interface MpCloseInfo {
	code: number
	reason: string
}

/**
 * The network-session surface of the host bridge (openra-steelseed-bridge.js).
 * Every method that round-trips to the engine returns a Promise — the
 * simulation may live in a worker, so one postMessage round trip sits under
 * each call (§7 rule 6): the UI awaits every result and checks it, treating an
 * error string or a rejected promise as a failed step with a visible cause
 * (§5.10). The three trailing getters stay synchronous on purpose: they read
 * the 250 ms status cache for the HUD roster and never gate a transition.
 */
interface MpBridge {
	setWsEndpoint(url: string): Promise<string>
	joinMultiplayer(host: string, port: number, password?: string): Promise<string>
	lobbyClaimPlayerSlot(): Promise<string>
	lobbySetReady(): Promise<void>
	lobbySetNotReady(): Promise<void>
	lobbySetFaction(factionId: string): Promise<string>
	lobbySetTeam(team: number): Promise<string>
	lobbySetColor(color: string): Promise<string>
	lobbySetOption(id: string, value: string): Promise<string>
	lobbySetSpawn(point: number): Promise<string>
	lobbySetSpawnFor(clientIndex: number, point: number): Promise<string>
	lobbyClearSpawns(): Promise<string>
	lobbyAddBots(): Promise<string>
	lobbyCloseEmptySlots(): Promise<string>
	lobbyCloseSlotsDownTo(seats: number): Promise<string>
	setPlayerName(name: string): Promise<string>
	probeConnection(): Promise<string>
	probeLobby(): Promise<string>
	getVisibilityProbe(): Promise<string>
	getServerError(): Promise<string>
	leaveMultiplayer(): Promise<string>
	getMpCloseInfo(): Promise<MpCloseInfo | null>
	// Cached HUD getters.
	getConnectionProbe(): string
	getServerErrorProbe(): string
	getLobbyPlayersProbe(): string
}

interface HudQueueDom {
	queueId: number
	kind: number
	root: HTMLElement
	name: HTMLElement
	count: HTMLElement
	progress: HTMLElement
	status: HTMLElement
	items: HudItemDom[]
}

interface PendingPlacement {
	actorName: string
	actorType: number
	queueId: number
	variant: number
}

export interface UiApi {
	/** Actor ids the local player has selected. Empty when nothing is selected. */
	readonly selection: readonly number[]
}

export class Ui implements UiApi {
	static id = 'ui'
	static deps = ['render', 'terrain', 'camera', 'shroud', 'units']

	private render: RenderApi | null = null
	private terrain: TerrainApi | null = null
	private shroud: ShroudApi | null = null
	private ring: GpuMesh | null = null

	private readonly selected: number[] = []
	private readonly instances = new Float32Array(MAX_SELECTION * 16)
	private readonly friendlyRingInstances = new Float32Array(MAX_SELECTION * 16)
	private readonly hostileRingInstances = new Float32Array(MAX_SELECTION * 16)
	private readonly disguiseRingInstances = new Float32Array(MAX_SELECTION * 16)
	private readonly ringCounts = new Uint16Array(4)
	private readonly friendlyRingColor = new Float32Array(3)
	private readonly hostileRingColor = new Float32Array(3)
	private readonly disguiseRingColor = new Float32Array(3)
	private friendlyRingItem: DrawItem | null = null
	private hostileRingItem: DrawItem | null = null
	private readonly troopHighlightInstances = new Float32Array(TROOP_HIGHLIGHT_CAPACITY * 16)
	private readonly troopHighlightColor = new Float32Array(3)
	private troopHighlightItem: DrawItem | null = null
	private troopHighlightUntil = 0
	private tacticalRoot: HTMLElement | null = null
	private tacticalCanvas: HTMLCanvasElement | null = null
	private tactical2d: CanvasRenderingContext2D | null = null
	private tacticalOpen = false
	/** Enemy movement heat: key `cellZ * 65536 + cellX`, value 0..1, 20 s exponential fade.
	 * Client-side only and fed exclusively from actors the shroud reports visible, so the
	 * overlay can never disclose an unseen enemy. */
	private readonly heatGrid = new Map<number, number>()
	private lastHeatTick = 0
	private disguiseRingItem: DrawItem | null = null
	private item: DrawItem | null = null
	private ctx: Ctx | null = null
	private renderPlayerId = 0
	private localFactionId = ''
	private pendingPlacement: PendingPlacement | null = null
	private lineAnchorCell: { x: number; y: number } | null = null
	private placementResult: PlacementResult | null = null
	private placementQueryKey = ''
	private readonly placementRingInstances = new Float32Array(16)
	private readonly placementRingColors = new Uint8Array(1)
	private placementRingItem: DrawItem | null = null
	private readonly placementModelInstances = new Float32Array(16)
	private readonly placementModelColors = new Uint8Array(1)
	private placementModelItem: DrawItem | null = null
	private placementOverlay: SVGSVGElement | null = null
	private selectionBox: SVGRectElement | null = null
	/**
	 * World health bars. A pooled pair of SVG rects per bar in the same overlay as the
	 * selection box, positioned from the drawn actor transform every frame. Drawn for
	 * selected actors and for anything damaged; live actors in the snapshot are already
	 * visibility-filtered by the host, and frozen structures draw only from frozen data.
	 */
	private readonly healthBars: { back: SVGRectElement; fill: SVGRectElement }[] = []
	private healthBarsShown = 0
	/** The remaining time of an Iron Curtain or a chronoshift, from the actors.status section. */
	private readonly statusBars: { back: SVGRectElement; fill: SVGRectElement }[] = []
	private statusBarsShown = 0
	private readonly statusMarks: SVGTextElement[] = []
	private statusMarksShown = 0
	private readonly repairMarks: { root: SVGGElement; ring: SVGCircleElement }[] = []
	private repairMarksShown = 0
	private readonly veterancyMarks: { back: SVGPathElement; main: SVGPathElement }[] = []
	/** Structures OpenRA shows us as fakes (support-power status `revealed`), and their tags. */
	private readonly revealedFakes = new Set<number>()
	private readonly fakeTags: SVGGElement[] = []
	private fakeTagsShown = 0
	private veterancyMarksShown = 0
	/** Actor ids the local player has asked to repair; compacted, never grown past the typed array. */
	private readonly repairingIds = new Uint32Array(MAX_REPAIR_MARKS)
	private repairingCount = 0
	private selecting = false
	private selectionDragged = false
	private selectionStartX = 0
	private selectionStartY = 0
	private readonly placementPolygons: SVGPolygonElement[] = []
	private placementPolygonsDrawn = 0
	private hudRoot: HTMLElement | null = null
	private hudCash: HTMLElement | null = null
	private hudResources: HTMLElement | null = null
	private hudHarvesters: HTMLElement | null = null
	private hudPowerFill: HTMLElement | null = null
	private hudPower: HTMLElement | null = null
	/** Edge trigger for the outage notice. */
	private powerOutageShown = false
	private hudAlert: HTMLElement | null = null
	private hudProductionTitle: HTMLElement | null = null
	private hudQueues: HTMLElement | null = null
	private hudReady: HTMLElement | null = null
	/** The first-match tutorial while it runs (ui/tutorial); null otherwise. */
	private tutorial: Tutorial | null = null
	/** The faction the tutorial's build order was made for; '' until one resolves. */
	private tutorialFaction = ''
	private hudReadyList: HTMLElement | null = null
	/** Queue:type of every card in the ready tray plus the armed one; unchanged key, untouched DOM. */
	private readyTrayKey = ''
	private hudSelectionName: HTMLElement | null = null
	private hudSelectionDetail: HTMLElement | null = null
	private hudDeploy: HTMLButtonElement | null = null
	private hudPrimary: HTMLButtonElement | null = null
	private hudHealth: HTMLElement | null = null
	private hudRepair: HTMLButtonElement | null = null
	private hudPlacement: HTMLElement | null = null
	private hudPause: HTMLButtonElement | null = null
	private hudMenu: HTMLButtonElement | null = null
	private hudBuy: HTMLButtonElement | null = null
	private hudSell: HTMLButtonElement | null = null
	private hudMinimise: HTMLButtonElement | null = null
	private hudNotice: HTMLElement | null = null
	private simAlarm: HTMLElement | null = null
	/** Whether the alarm currently belongs to this node, so it never clears the host's own line. */
	private simAlarmShown = false
	/** The lost-device alarm is up; it stays until the page reloads. */
	private gpuAlarmShown = false
	private hudWaterStatus: HTMLElement | null = null
	private minimap: HTMLCanvasElement | null = null
	private minimap2d: CanvasRenderingContext2D | null = null
	private minimapImage: ImageData | null = null
	private minimapFrame: ImageData | null = null
	private minimapShadeRev = -1
	/** Snapshot of the overview without the live camera rectangle, so the rect can move every frame. */
	private minimapBase: HTMLCanvasElement | null = null
	private minimapBase2d: CanvasRenderingContext2D | null = null
	private readonly minimapViewQuad = new Float32Array(8)
	private readonly minimapViewPx = new Float32Array(8)
	private compass: HTMLCanvasElement | null = null
	private compass2d: CanvasRenderingContext2D | null = null
	/** The heading the compass strip last drew; NaN forces the next draw (a new canvas). */
	private compassHeading = NaN
	private sessionRoot: HTMLElement | null = null
	private sessionStatus: HTMLElement | null = null
	private sessionModeState: HTMLElement | null = null
	private sessionAccount: HTMLButtonElement | null = null
	private accountRoot: HTMLElement | null = null
	private accountStatusLine: HTMLElement | null = null
	/** A pending desktop sign-in's code message; account refreshes must not overwrite it. */
	private accountDeviceCode: string | null = null
	private accountSignedOut: HTMLElement | null = null
	private accountSignedIn: HTMLElement | null = null
	private accountLoginForm: HTMLFormElement | null = null
	private accountGuestForm: HTMLFormElement | null = null
	private accountRegisterForm: HTMLFormElement | null = null
	private accountUpgradeForm: HTMLFormElement | null = null
	private accountUpgradeRoot: HTMLElement | null = null
	private accountRegisterToggle: HTMLButtonElement | null = null
	private accountDeviceButton: HTMLButtonElement | null = null
	private accountDeviceRow: HTMLElement | null = null
	private accountSeparator: HTMLElement | null = null
	private accountProfileForm: HTMLFormElement | null = null
	private accountClose: HTMLButtonElement | null = null
	private accountLogoutButton: HTMLButtonElement | null = null
	private accountVerifyButton: HTMLButtonElement | null = null
	private accountUser: AccountUser | null = null
	/** The player typed a multiplayer name this session: an account callsign no longer replaces it. */
	private mpNameTouched = false
	/** The callsign the account filled into the multiplayer name, if it did. */
	private mpNameFromAccount: string | null = null
	private sessionStart: HTMLButtonElement | null = null
	private sessionMap: HTMLSelectElement | null = null
	private sessionSpeed: HTMLSelectElement | null = null
	private sessionQuality: HTMLSelectElement | null = null
	private sessionMountains: HTMLSelectElement | null = null
	private sessionQualityNote: HTMLElement | null = null
	private hudQuality: HTMLElement | null = null
	private hudQualityNextTick = 0
	private sessionSlots: HTMLElement | null = null
	private sessionOptions: HTMLElement | null = null
	/** One sentence saying what the current fog/explored pair will actually let the player see. */
	private sessionVision: HTMLElement | null = null
	/** Every rule's native select → its console row and the map's standard value. */
	private readonly sessionRuleRows = new Map<HTMLSelectElement, { row: HTMLElement; standard: string }>()
	/** Built once: #session-speed is a static select, and a stepper per render would stack listeners. */
	private speedRuleRow: HTMLElement | null = null
	private sessionSchematic: Schematic | null = null
	private sessionMapTitle: HTMLElement | null = null
	private sessionMapMeta: HTMLElement | null = null
	private sessionMapCount: HTMLElement | null = null
	private sessionConditions: HTMLElement | null = null
	private sessionPlayersReadout: HTMLElement | null = null
	private sessionAddOpponent: HTMLButtonElement | null = null
	private sessionAddCount: HTMLElement | null = null
	private sessionRulesSummary: HTMLElement | null = null
	private sessionRulesReset: HTMLButtonElement | null = null
	private sessionChips: HTMLElement | null = null
	private sessionNav: HTMLElement | null = null
	private sessionSettings: HTMLElement | null = null
	private settingsOverlay: Overlay | null = null
	private accountOverlay: Overlay | null = null
	/** The mode the desktop menu or ?session= pinned; the other tab stays hidden. */
	private pinnedSession: 'skirmish' | 'mp' | null = null
	/** Focus cues play for keyboard and gamepad travel only, never under the mouse. */
	private keyboardModality = false
	private catalog: SkirmishCatalog | null = null
	private outcomeRoot: HTMLElement | null = null
	private outcomeTitle: HTMLElement | null = null
	private outcomeMode: HTMLElement | null = null
	private outcomeSettlement: HTMLElement | null = null
	private outcomeCopy: HTMLElement | null = null
	private outcomeRestart: HTMLButtonElement | null = null
	/** The result sheet's facts and players render once per game over, not every tick. */
	private outcomeRendered = false
	private menuRestart: HTMLButtonElement | null = null
	/** Disarms Restart match when the confirming second click does not come. */
	private menuRestartTimer = 0
	private noticeUntilTick = -1
	private waitingForStart = false
	private pendingBaseFocus = false
	private sessionError = ''
	private sessionMpHost: HTMLButtonElement | null = null
	private sessionMpStatus: HTMLElement | null = null
	private sessionMpMode: HTMLElement | null = null
	private rankedQueueRoot: HTMLElement | null = null
	private rankedQueueButton: HTMLButtonElement | null = null
	private rankedCancelButton: HTMLButtonElement | null = null
	private rankedStatus: HTMLElement | null = null
	private rankedQueueTimer: number | null = null
	private rankedSettlementTimer: number | null = null
	private rankedSettlementStarted = false
	private mpPlayers: HTMLElement | null = null
	private sessionMpName: HTMLInputElement | null = null
	private sessionMpRoomName: HTMLInputElement | null = null
	private sessionMpSlots: HTMLSelectElement | null = null
	private mpSetup: HTMLElement | null = null
	private mpSlotsEl: HTMLElement | null = null
	/** Room whose lobby #mp-setup renders; drives the live slot-row poll. */
	private mpSetupRoom: MpRoomSummary | null = null
	/** Probe text behind the last slot-table render: rows only rebuild on change, so an open dropdown survives the 1s poll. */
	private mpSetupSignature = ''
	/** Host-chosen room ambience: stored with the room (POST /rooms settings) and applied locally at match start. */
	/** Desktop only: the landing's Multiplayer switch (cached from the bridge; null until asked). */
	private desktopMultiplayer: boolean | null = null
	/** An Off that arrived during a live lobby waits for the lobby to end. */
	private desktopMpOffPending = false
	private mpHostOverlay: Overlay | null = null
	private sessionMainMenu: HTMLButtonElement | null = null
	private mpTod = 'auto'
	private mpWeather = 'off'
	private mpHostOptionsEl: HTMLElement | null = null
	/** Host-chosen map options, applied to the dedicated lobby via LobbyCommands. */
	private readonly mpHostOptions: Record<string, string> = {}
	private sessionMpRoomsBody: HTMLElement | null = null
	/** refreshMpRooms re-entry guard: one fetch in flight, 5 s minimum spacing.
	 *  The lobby rebuild loop would otherwise fetch /rooms every frame. */
	private mpRoomsFetching = false
	private mpRoomsFetchedAt = -Infinity
	/** Directory override set by the desktop shell (boot-once navigation swaps
	 *  directories in place, no page reload); null = fall back to ?mpdir=. */
	private mpDirOverride: string | null = null
	// §5.1 browser switch, null until /steelseed/net-config.json resolves
	// (the shell never fetches it — inside it multiplayer is always on).
	private netConfig: NetConfig | null = null
	/** LAN section fed by the desktop shell's subnet probe; hidden unless fed. */
	private lanRoomsSection: HTMLElement | null = null
	private lanRoomsBody: HTMLElement | null = null
	/** S19 host dialog (T3.3); opened only when the shell bridge offers hostStart. */
	private mpHostDialog: HTMLElement | null = null
	private mpHostVisLan: HTMLInputElement | null = null
	private mpHostVisPublic: HTMLInputElement | null = null
	private mpHostOnlineNote: HTMLElement | null = null
	private mpHostPlayers: HTMLSelectElement | null = null
	private mpHostPassword: HTMLInputElement | null = null
	/** Relay /v2/config verdict for the dialog's "Anyone online" switch:
	 *  null = not probed yet, true = answered, false = unreachable. Cached. */
	private mpRelayConfigOk: boolean | null = null
	private mpRelayCapacityAvailable: boolean | null = null
	/** S18 "enter address" (T3.7): revealed after 8 s of zero LAN rows on the
	 *  multiplayer screen; browser pages (no shell bridge) never see it. */
	private mpLanLookup: HTMLElement | null = null
	private mpLanLookupNote: HTMLElement | null = null
	private mpLanAddressForm: HTMLFormElement | null = null
	private mpLanAddressInput: HTMLInputElement | null = null
	private mpLanLookupTimer: number | null = null
	private sessionTabSkirmish: HTMLButtonElement | null = null
	private sessionTabMp: HTMLButtonElement | null = null
	private sessionSkirmishPanel: HTMLElement | null = null
	private sessionMpPanel: HTMLElement | null = null
	private sessionCopySkirmish: HTMLElement | null = null
	private sessionCopyMp: HTMLElement | null = null
	private mpRoomsTimer: number | null = null
	private mpPlayersTimer: number | null = null
	private mpBusy = false
	/** §5.10 client state machine. `failed` is transient: the cause is shown and
	 *  the session abandoned before the phase lands back on idle. */
	private mpPhase: MpPhase = 'idle'
	/** Join counter from the host engine (JoinMultiplayer/GetConnectionProbe):
	 *  every probe of this join must carry it, older probes are ignored. */
	private mpEpoch = 0
	/** The room this client created or joined (its `slots` drives the lobby). */
	private mpRoom: MpRoomSummary | null = null
	/** Fresh-probe lobby ticker (§7 rule 4: 1 Hz in lobby and match). */
	private mpLobbyTimer: number | null = null
	/** Admin handover bookkeeping (L8): S13 only when admin moved to me after I joined. */
	private mpAdminSeen = false
	private mpJoinedAsGuest = false
	/** Set while the admin's Start match press is waiting for the other humans. */
	private mpStartRequested = false
	/** Merged room list (§7 rule 3): LAN feed wins over the relay per roomId. */
	private mpRoomRows = new Map<string, HTMLTableRowElement>()
	private mpLanFeed = new Map<string, LanRoomRow>()
	private mpRelayRooms = new Map<string, MpRoomSummary>()
	private mpRoomsFetchFailed = false
	private mpRoomsEmptyNote = ''
	/** This client's sim build (§5.8); unknown ('') accepts every advertised
	 *  build until the stamp ships (T2.1). */
	private mpOwnBuild = ''
	private mpOwnBuildLoad: Promise<void> | null = null
	private mpJoinLinkStarted = false
	private mpBannerShown = false
	// Lobby panel controls, built once on first use.
	private mpLobbyNote: HTMLElement | null = null
	private mpReadyButton: HTMLButtonElement | null = null
	private mpStartButton: HTMLButtonElement | null = null
	private mpAddAiButton: HTMLButtonElement | null = null
	private mpBanner: HTMLElement | null = null
	private offProduced: (() => void) | null = null
	private offUnitLost: (() => void) | null = null
	private offFire: (() => void) | null = null
	/** actorId → ms timestamp until which the combat ring stays visible. */
	private readonly combatMarks = new Map<number, number>()
	private readonly combatSeen = new Set<number>()
	private readonly combatHidden = new Set<number>()
	/** Numeric overview witness retained without reading pixels back from either canvas. */
	readonly strategicStats = { visibleActors: 0, rememberedActors: 0, drawnActors: 0, width: 0, height: 0, focusCommands: 0 }
	private readonly queueDom: HudQueueDom[] = []
	/** Production tile typeIds that rendered 'Unknown asset' because the async type
	 *  table had not landed yet; cleared the moment they resolve (per-frame check). */
	private unknownProductionTypes: number[] = []
	private readonly deploySubjects = new Uint32Array(1)
	/** Subject buffer of the one building a sell click targets. */
	private readonly sellSubjects = new Uint32Array(1)
	/** True while the SELL button has armed sell targeting over the world. */
	private sellMode = false
	private readonly commandSubjects = new Uint32Array(MAX_SELECTION)
	private readonly onHudClick = (event: Event): void => this.handleHudClick(event)
	private readonly onReadyClick = (event: Event): void => this.handleReadyClick(event)
	private readonly onHudContext = (event: Event): void => this.handleHudContext(event)
	private readonly onHudAux = (event: Event): void => { if ((event as MouseEvent).button === 1) this.handleHudContext(event) }
	private readonly onPauseClick = (): void => { void this.togglePause() }
	private readonly onMusicClick = (): void => this.toggleMusic()
	private readonly onMusicVolDown = (): void => this.nudgeMusicVolume(-10)
	private readonly onMusicVolUp = (): void => this.nudgeMusicVolume(10)

	/**
	 * Renders the host's option grid into the Multiplayer tab, before "Host a
	 * new game": room ambience (time of day, weather) plus the map's own option
	 * catalogue. Ambience is NOT a lobby option — the engine rejects options its
	 * maps never declared — it is stored with the room (POST /rooms settings) so
	 * joiners inherit it at match start. Map options go to the dedicated lobby
	 * via LobbyCommands `option` (admin-only, live once the room is joined).
	 */
	private renderMpHostOptions(): void {
		const root = this.mpHostOptionsEl
		if (!root) return
		const uid = this.sessionMap?.value ?? ''
		const map = this.catalog?.maps.find(m => m.uid === uid) ?? null
		// Fields go straight into #mp-host-options (itself the grid): a nested grid squeezed
		// every select to ~60 px inside the narrow host column.
		const grid = document.createDocumentFragment()
		// Same choices and titles as the skirmish lobby; the room host picks the
		// ambience everyone starts with, in-game switches stay free afterwards.
		// The rules sit collapsed under "Room rules"; its summary counts what differs from standard.
		const summary = document.getElementById('mp-host-rules-summary')
		const summarise = (): void => {
			const changed = (this.mpTod !== 'auto' ? 1 : 0) + (this.mpWeather !== 'off' ? 1 : 0)
				+ (map?.options ?? []).filter(d => (this.mpHostOptions[d.id] ?? d.defaultValue) !== d.defaultValue).length
			if (!summary) return
			summary.replaceChildren(changed === 0 ? 'Standard' : `${changed} changed`, ...Array.from({ length: Math.min(changed, 5) }, () => document.createElement('i')))
			summary.toggleAttribute('data-changed', changed > 0)
		}
		const tod = fieldSelect('mp-tod', 'Time of day', [['auto', 'Auto'], ['day', 'Day'], ['night', 'Night']], this.mpTod)
		tod.select.title = 'Auto follows the match clock. Day or Night fix the lighting the whole room starts with.'
		tod.select.addEventListener('change', () => { this.mpTod = tod.select.value; summarise() })
		const weather = fieldSelect('mp-weather', 'Weather', [['off', 'Off'], ['on', 'On']], this.mpWeather)
		weather.select.title = 'On lets the map decide battlefield weather. Off forces clear skies.'
		weather.select.addEventListener('change', () => { this.mpWeather = weather.select.value; summarise() })
		grid.append(tod.label, weather.label)
		for (const descriptor of map?.options ?? []) {
			if (HIDDEN_OPTIONS.has(descriptor.id)) continue
			if (!(descriptor.id in this.mpHostOptions)) this.mpHostOptions[descriptor.id] = descriptor.defaultValue
			const field = fieldSelect(
				descriptor.id,
				lobbyLabel(descriptor.name),
				descriptor.values.map(v => [v.id, lobbyValueLabel(descriptor.id, v)] as [string, string]),
				this.mpHostOptions[descriptor.id],
			)
			field.select.addEventListener('change', () => {
				this.mpHostOptions[descriptor.id] = field.select.value
				summarise()
				// Live-update the room lobby when we are already its admin.
				if (this.mpMatch) void this.mpBridge()?.lobbySetOption(descriptor.id, field.select.value)
			})
			grid.append(field.label)
		}
		root.replaceChildren(grid)
		summarise()
	}

	/** A room's map for the list: its title (from the room, else the catalog), else the short uid. */
	private mpRoomMapTitle(room: MpRoomSummary): string {
		if (typeof room.map === 'string') return this.catalog?.maps.find(m => m.uid === room.map)?.title ?? room.map.slice(0, 8)
		const map = room.map as { uid?: string; title?: string } | undefined
		return map?.title ?? this.catalog?.maps.find(m => m.uid === map?.uid)?.title ?? (map?.uid ?? '').slice(0, 8)
	}
	private readonly onMenuClick = (): void => this.openGameMenu()
	private readonly onHudMinimise = (): void => this.toggleHudMinimised()
	private keysModal: HTMLElement | null = null
	private readonly toggleKeysModal = (open: boolean): void => {
		if (!this.keysModal) return
		this.keysModal.hidden = !open
	}
	/**
	 * I hides or restores the interface, unless the user is typing in a lobby control.
	 * H was taken: the camera already flies home on it, and a hotkey that both dumps
	 * the HUD and flies the view across the map is two surprises in one press.
	 */
	private readonly onHudKey = (event: KeyboardEvent): void => {
		const target = event.target
		if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
		// Control groups take the digits under every modifier combination: Ctrl+digit
		// assigns, bare digit recalls. Nothing else uses the digits, so nothing conflicts.
		if (/^Digit[1-6]$/.test(event.code)) {
			if (event.metaKey || event.altKey || event.repeat) return
			event.preventDefault()
			if (event.ctrlKey) this.assignControlGroup(Number(event.code.slice(5)))
			else this.recallControlGroup(Number(event.code.slice(5)))
			return
		}
		// Ctrl+A selects every own troop - the button this replaced was one more red chip
		// on the HUD, and the keyboard already carried every other selection command.
		if (event.ctrlKey && !event.metaKey && !event.altKey && (event.key === 'a' || event.key === 'A')) {
			event.preventDefault()
			if (!event.repeat) this.selectAllTroops()
			return
		}
		if (event.ctrlKey || event.metaKey || event.altKey) return
		// Escape cancels the armed attack-move aim before anything else: the player aimed,
		// changed their mind, and Escape is the generic "no" — the modal may stay closed.
		if (event.key === 'Escape' && (this.attackMoveArmed || this.guardArmed || this.supportPowerArmed !== null)) {
			event.preventDefault()
			this.attackMoveArmed = false
			this.guardArmed = false
			this.supportPowerArmed = null
			this.supportPowerSource = null
			this.showNotice('Doel-modus geannuleerd')
		}
		// Escape closes the keys modal even when the HUD is hidden; the modal is its own
		// layer and must never trap the generic cancel key.
		if (event.key === 'Escape' && this.keysModal && !this.keysModal.hidden) {
			this.toggleKeysModal(false)
			return
		}
		if (!this.hudRoot || this.hudRoot.hidden) return
		if (event.key === 'Escape' && this.gameMenuRoot && !this.gameMenuRoot.hidden) {
			this.closeGameMenu()
			return
		}
		if (event.key === 'Escape' && this.copyrightModal && !this.copyrightModal.hidden) {
			this.copyrightModal.hidden = true
			return
		}
		// Escape closes the tactical map even when the HUD is hidden; the map is its
		// own layer and must never trap the generic cancel key.
		if (event.key === 'Escape' && this.tacticalRoot && !this.tacticalRoot.hidden) {
			this.toggleTacticalMap()
			return
		}
		// P pauses and resumes the simulation — the same path the Pause button takes.
		// The game menu (with Return to main / Exit / Copyright) is the Menu button's job.
		if (event.key === 'p' || event.key === 'P') {
			event.preventDefault()
			this.togglePause()
			return
		}
		// M opens the tactical map: the strategic-overview pipeline at five times the
		// size, centred, with building names, clearer dots and the enemy-movement heat.
		if (event.key === 'm' || event.key === 'M') {
			event.preventDefault()
			this.toggleTacticalMap()
			return
		}
		// N toggles the soundtrack at any time; the HUD chip mirrors the state.
		// (Music used to live on M; M is the tactical map now.)
		if (event.key === 'n' || event.key === 'N') {
			event.preventDefault()
			this.toggleMusic()
			return
		}
		// L flashes a three-second white ring under every own troop: "where is everyone".
		if (event.key === 'l' || event.key === 'L') {
			event.preventDefault()
			this.flashTroopRings()
			return
		}
		// V stop, F attack-move, C scatter, G guard — selection commands, silently ignored
		// without a selection, which is what keeps them off the camera keys' toes.
		if (!event.repeat && this.handleCommandKey(event.key)) return
		if (event.key !== 'i' && event.key !== 'I') return
		event.preventDefault()
		this.toggleHudMinimised()
	}
	/**
	 * Alive, local-owned ids of the current selection, packed into the shared subject
	 * buffer in selection order. Returns how many were packed; zero means nothing in the
	 * selection is still on our side, and the order would be a player-level order — the
	 * exact thing a unit command must never become.
	 */
	private packCommandSubjects(actors: NonNullable<Snapshot['actors']>): number {
		let count = 0
		for (let s = 0; s < this.selected.length && count < MAX_SELECTION; s++) {
			for (let i = 0; i < actors.count; i++) {
				if (actors.id[i] !== this.selected[s] || actors.owner[i] !== this.renderPlayerId) continue
				this.commandSubjects[count++] = actors.id[i]
				break
			}
		}
		return count
	}

	/** Type id of a live actor, or the NO_ACTOR_TYPE sentinel when it has left the world. */
	private actorTypeAt(actors: NonNullable<Snapshot['actors']>, id: number): number {
		for (let i = 0; i < actors.count; i++) if (actors.id[i] === id) return actors.typeId[i]
		return NO_ACTOR_TYPE
	}

	/** Any selected local actor carries the named manifest trait? Keypress-path only. */
	private selectionHasTrait(actors: NonNullable<Snapshot['actors']>, ctx: Ctx, units: UnitsApi, trait: string): boolean {
		for (let s = 0; s < this.selected.length; s++) {
			for (let i = 0; i < actors.count; i++) {
				if (actors.id[i] !== this.selected[s] || actors.owner[i] !== this.renderPlayerId) continue
				if (units.hasRaTrait(ctx.actorTypeName(actors.typeId[i]), trait)) return true
			}
		}
		return false
	}

	/**
	 * Recompute the armed-selection cache. Called whenever the selection changes: snapshot
	 * prune, click or box select, group recall, base focus. The hover path reads it every
	 * frame, so it must never scan per frame.
	 */
	private refreshSelectionArmed(ctx: Ctx): void {
		this.selectionArmed = false
		const actors = ctx.snapshot?.actors
		if (!actors || this.selected.length === 0) return
		const units = ctx.get<UnitsApi>('units')
		this.selectionArmed = this.selectionHasTrait(actors, ctx, units, 'Armament')
	}

	/** Issue one order string to the whole packed selection. Returns false when nobody went. */
	private issueDirectOrder(orderString: string, targetActorId: number,
		cellX: number, cellY: number, extraData = 0): boolean {
		const ctx = this.ctx
		const actors = ctx?.snapshot?.actors
		if (!ctx || !actors) return false
		const count = this.packCommandSubjects(actors)
		if (count === 0) return false
		ctx.issueOrder({
			orderString,
			subjectIds: this.commandSubjects,
			subjectCount: count,
			targetActorId,
			targetCell: cellX >= 0 ? { x: cellX, y: cellY } : undefined,
			queued: false,
			extraData,
		})
		return true
	}
	/**
	 * Strike beacons, as OpenRA posts them for the launcher and its allies (Beacon): a nuke's stands
	 * until its tick (FlightDelay - BeaconRemoveAdvance); an airstrike's or a paradrop's until the
	 * first delivering aircraft (`unit`) is within `rangeM` of the target. `progress` is the clock:
	 * the missile's time, or the lead plane's approach, like the original's clock sprite.
	 */
	private readonly supportBeacons: { x: number; z: number; bornTick: number; endTick: number; unit: string; rangeM: number; startDistM: number; progress: number }[] = []
	private readonly beaconArrows: SVGPathElement[] = []
	private readonly beaconPosters: SVGRectElement[] = []
	private readonly beaconClocks: SVGPathElement[] = []
	/** The armed power's footprint under the cursor (Iron Curtain, Chronoshift). */
	private supportFootprint: SVGPathElement | null = null
	/** Range outlines of a selected jammer or gap generator. */
	private readonly rangeOutlines: SVGPathElement[] = []
	/** Public superweapon timers: OpenRA's SupportPowerTimerWidget, under the strategic overview. */
	private hudTimers: HTMLElement | null = null
	private timersSig = ''
	/** The status object the timers and launches were last read from (a new one lands 4 times a second). */
	private timersStatus: SupportPowersStatus | null = null
	private readonly announcedLaunches = new Set<number>()
	/** The last public timers by `player:key`: a GPS one-shot announces by leaving them. */
	private readonly timerStates = new Map<string, { ready: boolean; allied: boolean; launchText: string | null; key: string; player: number }>()
	private readonly seenTimers = new Set<string>()
	/** Dev-only order trace: the order being followed until its first subject moves. */
	private orderTrace: { issuedTick: number; subject: number; x: number; y: number; record: Record<string, unknown> } | null = null
	/** The stance Shift+G will cycle to next; starts at the mod's own default. */
	private stancePhase = 2
	private supportPowerArmed: string | null = null
	/** Chronoshift's first click: the source cell, sent as Order.ExtraLocation with the destination. */
	private supportPowerSource: { x: number; y: number } | null = null
	/**
	 * A fired power waiting for the simulation's verdict. Nothing says "fired" until the power's
	 * own charge restarts; a power that is still ready after SUPPORT_CONFIRM_MS was refused.
	 */
	private supportPowerPending: { key: string; title: string; x: number; z: number; cellX: number; cellY: number; issuedMs: number } | null = null
	private supportPowersAtMs = -1000
	private supportPowersSig = ''
	private hudSupport: HTMLElement | null = null
	private hudSupportList: HTMLElement | null = null
	/** Mean position of the live selection, floored to a cell, or null with nothing alive. */
	private selectionCentreCell(actors: NonNullable<Snapshot['actors']>): { x: number; y: number } | null {
		let sumX = 0
		let sumZ = 0
		let n = 0
		for (let i = 0; i < actors.count; i++) {
			if (actors.owner[i] !== this.renderPlayerId || !this.selected.includes(actors.id[i])) continue
			sumX += actors.posX[i] * WPOS_TO_M
			sumZ += actors.posY[i] * WPOS_TO_M
			n++
		}
		return n > 0 ? { x: Math.floor(sumX / n), y: Math.floor(sumZ / n) } : null
	}

	/** Actor index under the pointer, or -1 when the pointer is off-canvas or over sky. */
	private pickPointerActorIndex(ctx: Ctx, actors: NonNullable<Snapshot['actors']>, units: UnitsApi): number {
		const render = this.render
		const terrain = this.terrain
		const pointer = ctx.input.pointer
		if (!render || !terrain || !pointer.inside) return -1
		const viewW = Math.max(1, canvasCssWidth(ctx))
		const viewH = Math.max(1, canvasCssHeight(ctx))
		return pickActorAt(render.camera.viewProj, actors, units, terrain,
			clamp(pointer.x, 0, viewW), clamp(pointer.y, 0, viewH), viewW, viewH, undefined, false, render.camera.position)
	}

	private assignControlGroup(n: number): void {
		if (this.selected.length === 0) return
		this.groupMembers.set(n, [...this.selected])
		this.showNotice(`Groep ${n} · ${this.selected.length} units`)
	}

	private recallControlGroup(n: number): void {
		const ctx = this.ctx
		const actors = ctx?.snapshot?.actors
		const group = this.groupMembers.get(n)
		if (!ctx || !actors || !group || group.length === 0) return
		// Second press inside 400 ms flies the camera to the group's centre; the first just
		// selects, so tapping a digit never yanks the view across the map unasked.
		const now = performance.now()
		const focus = this.groupRecallKey === n && now - this.groupRecallMs < 400
		this.groupRecallKey = n
		this.groupRecallMs = now
		this.selected.length = 0
		let sumX = 0
		let sumZ = 0
		let alive = 0
		for (let g = 0; g < group.length && this.selected.length < MAX_SELECTION; g++) {
			for (let i = 0; i < actors.count; i++) {
				if (actors.id[i] !== group[g]) continue
				this.selected.push(group[g])
				sumX += actors.posX[i] * WPOS_TO_M
				sumZ += actors.posY[i] * WPOS_TO_M
				alive++
				break
			}
		}
		if (this.selected.length === 0) {
			this.groupMembers.delete(n)
			return
		}
		this.refreshSelectionArmed(ctx)
		ctx.get<CameraApi>('camera').selectActors(this.selected)
		if (focus && alive > 0) ctx.get<CameraApi>('camera').focusWorld(sumX / alive, sumZ / alive)
		this.showNotice(focus ? `Groep ${n} · camera` : `Groep ${n} · ${this.selected.length} units`)
	}

	/**
	 * V stop, F attack-move aim, C scatter, G guard-area. Every branch is a selection
	 * command and every branch gates on the trait that gives it meaning, so a selection of
	 * civilian buildings answers nothing and the camera keys stay untouched. Returns true
	 * when the key was a command key, consumed whether or not a selection qualified.
	 */
	private handleCommandKey(key: string): boolean {
		const ctx = this.ctx
		if (!ctx) return false
		const lower = key.toLowerCase()
		if (lower === 'f') {
			if (this.selected.length === 0) return false
			this.attackMoveArmed = true
			this.guardArmed = false
			this.showNotice('Attack-move · klik een bestemming · rechtsklik of Esc annuleert')
			return true
		}
		if (this.attackMoveArmed || this.guardArmed) return false
		const actors = ctx.snapshot?.actors
		if (!actors || this.selected.length === 0) return false
		const units = ctx.get<UnitsApi>('units')
		if (lower === 'v') {
			// Stop is meaningful for anything running an activity and harmless elsewhere;
			// OpenRA resolves it per subject (Mobile, Aircraft) and ignores the rest.
			if (this.issueDirectOrder('Stop', 0, -1, -1)) this.showNotice('Stop')
			return true
		}
		if (lower === 'c') {
			if (!this.selectionHasTrait(actors, ctx, units, 'Mobile')) return true
			const centre = this.selectionCentreCell(actors)
			if (centre && this.issueDirectOrder('Scatter', 0, centre.x, centre.y)) this.showNotice('Scatter')
			return true
		}
		if (lower === 'g') {
			if (!this.selectionHasTrait(actors, ctx, units, 'Guard')) return true
			// Shift+G cycles the selection's stance and does nothing else (the way back to
			// AttackAnything after a guard-area settled it into Defend).
			if (ctx.input.shift) {
				if (!this.selectionHasTrait(actors, ctx, units, 'AutoTarget')) return true
				const stance = this.stancePhase = (this.stancePhase + 1) % 4
				this.issueDirectOrder('SetUnitStance', 0, -1, -1, stance)
				this.showNotice(`Stance · ${STANCE_NAMES[stance] ?? stance}`)
				return true
			}
			// G arms the next click, like attack-move: acting at the pointer the moment the key
			// went down let the following click select scenery or a building instead.
			this.guardArmed = true
			this.showNotice('Guard · klik een eenheid om te beschermen of grond om te verdedigen · rechtsklik of Esc annuleert')
			return true
		}
		return false
	}

	/**
	 * Armed guard aim. The next left release guards the Guardable actor under the cursor
	 * (follow and protect, friendly or not), or settles the selection into Defend and walks
	 * it to the clicked ground. The click is consumed: it never reselects.
	 */
	private updateGuardTargeting(ctx: Ctx, actors: NonNullable<Snapshot['actors']>, units: UnitsApi): void {
		const pointer = ctx.input.pointer
		if ((pointer.released & 1) === 0 || !pointer.inside) return
		this.guardArmed = false
		const hit = this.pickPointerActorIndex(ctx, actors, units)
		// The engine's Guard resolve reads GuardableInfo off the TARGET and throws on
		// anything else (found the hard way: a Guard at a neutral prop halted the sim).
		// The vanilla targeter gates on Guardable, not on movement or hostility.
		if (hit >= 0 && units.hasRaTrait(ctx.actorTypeName(actors.typeId[hit]), 'Guardable')) {
			if (this.issueDirectOrder('Guard', actors.id[hit], -1, -1)) this.showNotice('Guard · volgt het doelwit')
			return
		}
		if (!this.selectionHasTrait(actors, ctx, units, 'AutoTarget')) {
			this.showNotice('Guard · niets om te bewaken')
			return
		}
		const camera = ctx.get<CameraApi>('camera')
		const cell = camera.pickGroundCell(pointer.x, pointer.y, ctx)
		if (!cell) return
		// Guard-area: settle into Defend so AutoTarget engages without chasing, then walk there.
		this.issueDirectOrder('SetUnitStance', 0, -1, -1, 2)
		const point = camera.pickGroundPoint(pointer.x, pointer.y, ctx)
		if (this.issueDirectOrder('Move', 0, cell.x, cell.y)) {
			this.markOrder(point ? point.x : cell.x + 0.5, point ? point.z : cell.y + 0.5,
				this.selectionCanReach(cell.x, cell.y, actors, this.packCommandSubjects(actors)))
		}
		this.showNotice('Guard · verdedig dit gebied (Defend)')
	}

	/**
	 * Armed attack-move aim: the next left click sends the AttackMove order to the picked
	 * cell, and the mode consumes itself either way so a stray click can never fire twice.
	 */
	private updateAttackMoveTargeting(ctx: Ctx, actors: NonNullable<Snapshot['actors']>): void {
		const pointer = ctx.input.pointer
		if ((pointer.released & 1) === 0 || !pointer.inside) return
		const camera = ctx.get<CameraApi>('camera')
		const cell = camera.pickGroundCell(pointer.x, pointer.y, ctx)
		this.attackMoveArmed = false
		if (!cell) return
		const count = this.packCommandSubjects(actors)
		if (count === 0) return
		ctx.issueOrder({
			orderString: 'AttackMove',
			subjectIds: this.commandSubjects,
			subjectCount: count,
			targetActorId: 0,
			targetCell: cell,
			queued: false,
		})
		// The marker draws at the exact cursor hit, not the cell centre — the pointer is
		// where the player aimed and the reticle must agree with it pixel for pixel.
		const point = camera.pickGroundPoint(pointer.x, pointer.y, ctx)
		this.markOrder(point ? point.x : cell.x + 0.5, point ? point.z : cell.y + 0.5,
			this.selectionCanReach(cell.x, cell.y, actors, count), true)
		this.showNotice('Attack-move')
	}

	/** Amber dashed line from the selected own production building to its rally point. */
	private updateRallyLine(ctx: Ctx, actors: NonNullable<Snapshot['actors']>,
		terrain: TerrainApi, render: RenderApi): void {
		const line = this.rallyLine

		if (!line) return
		let hide = true
		if (this.selected.length === 1) {
			const rally = this.rallyPoints.get(this.selected[0])
			if (rally) {
				for (let i = 0; i < actors.count; i++) {
					if (actors.id[i] !== this.selected[0] || actors.owner[i] !== this.renderPlayerId) continue
					const vp = render.camera.viewProj
					const viewW = Math.max(1, canvasCssWidth(ctx))
					const viewH = Math.max(1, canvasCssHeight(ctx))
					const ax = actors.posX[i] * WPOS_TO_M
					const az = actors.posY[i] * WPOS_TO_M
					const ay = terrain.heightAt(ax, az) + 0.06
					const by = terrain.heightAt(rally.x, rally.z) + 0.06
					const cwa = vp[3] * ax + vp[7] * ay + vp[11] * az + vp[15]
					const cwb = vp[3] * rally.x + vp[7] * by + vp[11] * rally.z + vp[15]
					if (cwa <= 0 || cwb <= 0) break
					line.setAttribute('x1', ((vp[0] * ax + vp[4] * ay + vp[8] * az + vp[12]) / cwa * 0.5 + 0.5) * viewW + '')
					line.setAttribute('y1', (0.5 - (vp[1] * ax + vp[5] * ay + vp[9] * az + vp[13]) / cwa * 0.5) * viewH + '')
					line.setAttribute('x2', ((vp[0] * rally.x + vp[4] * by + vp[8] * rally.z + vp[12]) / cwb * 0.5 + 0.5) * viewW + '')
					line.setAttribute('y2', (0.5 - (vp[1] * rally.x + vp[5] * by + vp[9] * rally.z + vp[13]) / cwb * 0.5) * viewH + '')
					hide = false
					break
				}
			}
		}
		if (hide && line.style.display !== 'none') line.style.display = 'none'
		else if (!hide) {
			line.style.display = ''
			this.placementOverlay?.setAttribute('viewBox', `0 0 ${Math.max(1, canvasCssWidth(ctx))} ${Math.max(1, canvasCssHeight(ctx))}`)
			if (this.placementOverlay) this.placementOverlay.style.display = ''
		}
	}
	private readonly onDeployClick = (event: MouseEvent): void => this.deploySelection(event)

	/**
	 * OpenRA's strike beacon (Beacon): an arrow bobbing over the target and a poster whose clock
	 * sweeps with the missile's ticks, or with the lead plane's approach to the target area. It
	 * retires on OpenRA's terms: a nuke's BeaconRemoveAdvance ticks before the missile lands, an
	 * airstrike's once its first plane is in the target area (or every plane is gone).
	 */
	private updateSupportBeacons(ctx: Ctx, terrain: TerrainApi, render: RenderApi): void {
		const tick = ctx.snapshot?.tick ?? 0
		const actors = ctx.snapshot?.actors
		for (let b = this.supportBeacons.length - 1; b >= 0; b--) {
			const beacon = this.supportBeacons[b]
			let progress = beacon.endTick > beacon.bornTick ? (tick - beacon.bornTick) / (beacon.endTick - beacon.bornTick) : 1
			if (beacon.unit !== '') {
				const distance = actors ? this.nearestOwnAircraftM(ctx, actors, beacon.unit, beacon.x, beacon.z) : -1
				if (distance >= 0) {
					if (beacon.startDistM < 0) beacon.startDistM = Math.max(distance, beacon.rangeM + 1)
					progress = distance <= beacon.rangeM ? 1
						: Math.max(0, Math.min(0.999, 1 - (distance - beacon.rangeM) / (beacon.startDistM - beacon.rangeM)))
				} else if (beacon.startDistM >= 0) progress = 1
				else progress = Math.min(progress, 0.999)
				if (tick >= beacon.endTick) progress = 1
			}
			if (tick < beacon.bornTick || progress >= 1) this.supportBeacons.splice(b, 1)
			else beacon.progress = Math.max(0, progress)
		}
		const overlay = this.placementOverlay
		if (this.beaconArrows.length < 4) return
		if (this.supportBeacons.length === 0 || !overlay) {
			for (let i = 0; i < 4; i++) {
				this.beaconArrows[i].style.display = 'none'
				this.beaconPosters[i].style.display = 'none'
				this.beaconClocks[i].style.display = 'none'
			}
			return
		}
		const viewW = Math.max(1, canvasCssWidth(ctx))
		const viewH = Math.max(1, canvasCssHeight(ctx))
		const vp = render.camera.viewProj
		const now = performance.now()
		for (let b = 0; b < 4; b++) {
			const arrow = this.beaconArrows[b]
			const poster = this.beaconPosters[b]
			const clock = this.beaconClocks[b]
			const beacon = b < this.supportBeacons.length ? this.supportBeacons[b] : null
			const screen = beacon ? this.projectToScreen(vp, beacon.x, terrain.heightAt(beacon.x, beacon.z) + 0.05, beacon.z, viewW, viewH) : null
			if (!beacon || !screen || screen[0] < -60 || screen[1] < -60 || screen[0] > viewW + 60 || screen[1] > viewH + 60) {
				arrow.style.display = 'none'
				poster.style.display = 'none'
				clock.style.display = 'none'
				continue
			}
			const [sx, sy] = screen
			// The arrow bobs toward the ground; the poster's clock sweeps with the strike's time.
			const age = now / 1000
			const bob = Math.sin(age * 6) * 4
			arrow.setAttribute('d', `M${(sx - 9).toFixed(1)} ${(sy - 26 + bob).toFixed(1)}L${(sx + 9).toFixed(1)} ${(sy - 26 + bob).toFixed(1)}L${sx.toFixed(1)} ${(sy - 12 + bob).toFixed(1)}Z`)
			arrow.setAttribute('opacity', (0.55 + 0.45 * Math.abs(Math.sin(age * 7))).toFixed(2))
			arrow.style.display = ''
			poster.setAttribute('x', (sx + 12).toFixed(1))
			poster.setAttribute('y', (sy - 34).toFixed(1))
			poster.setAttribute('width', '14')
			poster.setAttribute('height', '14')
			poster.setAttribute('opacity', '0.92')
			poster.style.display = ''
			const cx = sx + 19, cy = sy - 27, r = 6.5, sweep = Math.min(0.999, beacon.progress) * Math.PI * 2
			const ex = cx + Math.sin(sweep) * r, ey = cy - Math.cos(sweep) * r
			clock.setAttribute('d', beacon.progress <= 0.001 ? ''
				: `M${cx.toFixed(1)} ${cy.toFixed(1)}L${cx.toFixed(1)} ${(cy - r).toFixed(1)}A${r} ${r} 0 ${sweep > Math.PI ? 1 : 0} 1 ${ex.toFixed(1)} ${ey.toFixed(1)}Z`)
			clock.style.display = ''
		}
		overlay.setAttribute('viewBox', `0 0 ${viewW} ${viewH}`)
		overlay.style.display = ''
	}

	/** Screen position (CSS px) of a world point, or null behind the camera. */
	private projectToScreen(vp: Float32Array | readonly number[], x: number, y: number, z: number, viewW: number, viewH: number): [number, number] | null {
		const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15]
		if (cw <= 0) return null
		return [((vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / cw * 0.5 + 0.5) * viewW,
			(0.5 - (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / cw * 0.5) * viewH]
	}

	/** Horizontal metres from (x, z) to the nearest own aircraft of `type`, or -1 when none flies. */
	private nearestOwnAircraftM(ctx: Ctx, actors: NonNullable<Snapshot['actors']>, type: string, x: number, z: number): number {
		let best = -1
		for (let i = 0; i < actors.count; i++) {
			if (actors.owner[i] !== this.renderPlayerId || (actors.flags[i] & ActorFlag.husk) !== 0) continue
			if (ctx.actorTypeName(actors.typeId[i]).toLowerCase() !== type) continue
			const d = Math.hypot(actors.posX[i] * WPOS_TO_M - x, actors.posY[i] * WPOS_TO_M - z)
			if (best < 0 || d < best) best = d
		}
		return best
	}

	/** Post OpenRA's beacon for a power that has one (DisplayBeacon), timed the way it times it. */
	private postSupportBeacon(ctx: Ctx, power: { readonly beaconTicks?: number; readonly beaconUnit?: string | null; readonly beaconRangeCells?: number }, x: number, z: number): void {
		const tick = ctx.snapshot?.tick ?? 0
		const ticks = power.beaconTicks ?? 0
		const unit = (power.beaconUnit ?? '').toLowerCase()
		if (ticks <= 0 && unit === '') return
		this.supportBeacons.push({ x, z, bornTick: tick, endTick: tick + (ticks > 0 ? ticks : BEACON_MAX_TICKS), unit,
			rangeM: power.beaconRangeCells ?? 0, startDistM: -1, progress: 0 })
		if (this.supportBeacons.length > 4) this.supportBeacons.shift()
	}

	/** fx, for the support moments no snapshot carries; null in a harness without it. */
	private supportFx(ctx: Ctx): SupportFxApi | null {
		try { return ctx.get<SupportFxApi>('fx') } catch { return null }
	}

	/**
	 * The armed power's footprint under the cursor: the Iron Curtain's and the Chronosphere's
	 * `_x_ xxx _x_`, green where OpenRA would take the aim and red where it would refuse it (the
	 * same test the click runs). A Chronoshift keeps its chosen source outlined while the
	 * destination is picked.
	 */
	private updateSupportFootprint(ctx: Ctx, terrain: TerrainApi, render: RenderApi): void {
		const path = this.supportFootprint
		if (!path) return
		const key = this.supportPowerArmed
		const pointer = ctx.input.pointer
		if (key === null || !/GrantExternalCondition|IronCurtain|Chronoshift/i.test(key) || !pointer.inside) {
			if (path.style.display !== 'none') path.style.display = 'none'
			return
		}
		const cell = ctx.get<CameraApi>('camera').pickGroundCell(pointer.x, pointer.y, ctx)
		if (!cell) { path.style.display = 'none'; return }
		const pickingSource = /Chronoshift/i.test(key) && this.supportPowerSource === null
		const ok = this.supportTargetProblem(ctx, key, cell, pickingSource) === null
		const viewW = Math.max(1, canvasCssWidth(ctx)), viewH = Math.max(1, canvasCssHeight(ctx))
		let d = this.footprintPath(terrain, render, cell.x, cell.y, viewW, viewH)
		if (this.supportPowerSource) d += this.footprintPath(terrain, render, this.supportPowerSource.x, this.supportPowerSource.y, viewW, viewH)
		// The eligible units, each marked: ours (and an ally's, for the curtain) under the aimed
		// footprint, or under the chosen source while a Chronoshift picks its destination.
		const around = this.supportPowerSource ?? cell
		d += this.eligibleMarks(ctx, render, terrain, around.x, around.y, /GrantExternalCondition|IronCurtain/i.test(key), viewW, viewH)
		path.setAttribute('d', d)
		path.setAttribute('stroke', ok ? 'rgba(120,230,140,0.9)' : 'rgba(255,96,72,0.9)')
		path.setAttribute('fill', ok ? 'rgba(120,230,140,0.16)' : 'rgba(255,96,72,0.14)')
		path.style.display = ''
		this.placementOverlay?.setAttribute('viewBox', `0 0 ${viewW} ${viewH}`)
		if (this.placementOverlay) this.placementOverlay.style.display = ''
	}

	/** Diamond marks over the living units a footprint around (cellX, cellY) would take. */
	private eligibleMarks(ctx: Ctx, render: RenderApi, terrain: TerrainApi, cellX: number, cellY: number, allies: boolean, viewW: number, viewH: number): string {
		const actors = ctx.snapshot?.actors
		if (!actors) return ''
		const vp = render.camera.viewProj
		let d = ''
		for (let i = 0; i < actors.count; i++) {
			if ((actors.flags[i] & ActorFlag.husk) !== 0 || actors.health[i] === 0) continue
			const own = actors.owner[i] === this.renderPlayerId || (allies && ctx.snapshot?.players?.[actors.owner[i]]?.relation === 1)
			if (!own) continue
			const dx = Math.floor(actors.posX[i] / 1024) - cellX, dy = Math.floor(actors.posY[i] / 1024) - cellY
			if (Math.abs(dx) + Math.abs(dy) > 1) continue
			const x = actors.posX[i] * WPOS_TO_M, z = actors.posY[i] * WPOS_TO_M
			const p = this.projectToScreen(vp, x, terrain.heightAt(x, z) + 0.9, z, viewW, viewH)
			if (!p) continue
			d += `M${p[0].toFixed(1)} ${(p[1] - 6).toFixed(1)}L${(p[0] + 5).toFixed(1)} ${p[1].toFixed(1)}L${p[0].toFixed(1)} ${(p[1] + 6).toFixed(1)}L${(p[0] - 5).toFixed(1)} ${p[1].toFixed(1)}Z`
		}
		return d
	}

	/** The plus-shaped footprint around a cell, each cell a quad on the ground. */
	private footprintPath(terrain: TerrainApi, render: RenderApi, cellX: number, cellY: number, viewW: number, viewH: number): string {
		const vp = render.camera.viewProj
		let d = ''
		for (const [dx, dy] of FOOTPRINT_PLUS) {
			const x0 = cellX + dx, z0 = cellY + dy
			let quad = ''
			for (const [wx, wz] of [[x0, z0], [x0 + 1, z0], [x0 + 1, z0 + 1], [x0, z0 + 1]]) {
				const p = this.projectToScreen(vp, wx, terrain.heightAt(wx, wz) + 0.04, wz, viewW, viewH)
				if (!p) { quad = ''; break }
				quad += `${quad === '' ? 'M' : 'L'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`
			}
			if (quad !== '') d += `${quad}Z`
		}
		return d
	}

	/**
	 * A selected jammer's or gap generator's ranges, as OpenRA draws them while one is selected:
	 * each outline follows the ground it crosses. Own and allied units only, as WithRangeCircle
	 * shows them.
	 */
	private updateRangeOutlines(ctx: Ctx, actors: NonNullable<Snapshot['actors']>, terrain: TerrainApi, render: RenderApi): void {
		let used = 0
		if (this.rangeOutlines.length === 0) return
		const viewW = Math.max(1, canvasCssWidth(ctx)), viewH = Math.max(1, canvasCssHeight(ctx))
		const vp = render.camera.viewProj
		for (const id of this.selected) {
			if (used >= this.rangeOutlines.length) break
			const i = findActorIndex(actors, id)
			if (i < 0 || (actors.flags[i] & ActorFlag.husk) !== 0) continue
			const own = actors.owner[i] === this.renderPlayerId || ctx.snapshot?.players?.[actors.owner[i]]?.relation === 1
			const ranges = own ? RANGE_OUTLINES[ctx.actorTypeName(actors.typeId[i]).toLowerCase()] : undefined
			if (!ranges) continue
			const cx = actors.posX[i] * WPOS_TO_M, cz = actors.posY[i] * WPOS_TO_M
			for (const [cells, colour] of ranges) {
				if (used >= this.rangeOutlines.length) break
				let d = '', pen = false
				for (let k = 0; k <= RANGE_OUTLINE_SEGMENTS; k++) {
					const a = k / RANGE_OUTLINE_SEGMENTS * Math.PI * 2
					const x = cx + Math.cos(a) * cells, z = cz + Math.sin(a) * cells
					const p = this.projectToScreen(vp, x, terrain.heightAt(x, z) + 0.06, z, viewW, viewH)
					if (!p) { pen = false; continue }
					d += `${pen ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`
					pen = true
				}
				const outline = this.rangeOutlines[used++]
				outline.setAttribute('d', d)
				outline.setAttribute('stroke', colour)
				outline.style.display = d === '' ? 'none' : ''
			}
		}
		for (let k = used; k < this.rangeOutlines.length; k++)
			if (this.rangeOutlines[k].style.display !== 'none') this.rangeOutlines[k].style.display = 'none'
		if (used > 0 && this.placementOverlay) {
			this.placementOverlay.setAttribute('viewBox', `0 0 ${viewW} ${viewH}`)
			this.placementOverlay.style.display = ''
		}
	}

	/** Dev-only (`?ordertrace=1`): log the order's first observed simulation response. */
	private followOrderTrace(ctx: Ctx, actors: NonNullable<Snapshot['actors']>): void {
		const trace = this.orderTrace
		const tick = ctx.snapshot?.tick ?? 0
		if (!trace) return
		const i = findActorIndex(actors, trace.subject)
		const moved = i >= 0 && (actors.posX[i] !== trace.x || actors.posY[i] !== trace.y)
		if (!moved && tick - trace.issuedTick < 250) return
		trace.record.firstResponse = moved
			? { tick, afterTicks: tick - trace.issuedTick, subjectCell: [Math.floor(actors.posX[i] / 1024), Math.floor(actors.posY[i] / 1024)] }
			: { tick, afterTicks: tick - trace.issuedTick, subjectCell: null, note: 'no movement within 250 ticks' }
		console.debug('[ordertrace]', JSON.stringify(trace.record))
		this.orderTrace = null
	}

	private readonly onRepairClick = (): void => this.repairSelection()
	private readonly onPrimaryClick = (): void => this.togglePrimaryProducer()
	/**
	 * Toggle the selected own building's PrimaryBuilding flag — the engine order the
	 * original game's sidebar sends. New unit batches then exit from this building.
	 */
	private togglePrimaryProducer(): void {
		const ctx = this.ctx
		const actors = ctx?.snapshot?.actors
		if (!ctx || !actors || this.selected.length !== 1) return
		for (let i = 0; i < actors.count; i++) {
			if (actors.id[i] !== this.selected[0] || actors.owner[i] !== this.renderPlayerId) continue
			if (!ctx.get<UnitsApi>('units').hasRaTrait(ctx.actorTypeName(actors.typeId[i]), 'PrimaryBuilding')) return
			this.commandSubjects[0] = actors.id[i]
			ctx.issueOrder({ orderString: 'PrimaryProducer', subjectIds: this.commandSubjects, subjectCount: 1, targetActorId: 0 })
		}
	}

	private readonly onBuyClick = (): void => this.handleBuyClick()
	private readonly onSellClick = (): void => this.setSellMode(!this.sellMode)
	private readonly onSessionStart = (): void => {
		this.fireLaunchShot()
		this.startConfiguredSkirmish()
	}
	private readonly onMpHost = (): void => void this.mpHost()
	private readonly onOutcomeRestart = (): void => {
		if (this.mpMatch) void this.mpLeaveToSession()
		else this.startConfiguredSkirmish()
	}
	private readonly onSessionMapChange = (): void => {
		this.renderSessionMap()
		this.renderMpHostOptions()
	}
	private readonly onSessionQualityChange = (): void => this.applyQualityChoice()
	private readonly onSessionMountainsChange = (): void => this.applyMountainChoice()
	/** A phone restores <select> values and fires change with no touch. That reload looped the page. */
	private qualityTouched = false
	private mountainsTouched = false
	private readonly onMinimapPointerDown = (event: PointerEvent): void => this.focusFromMinimap(event)
	/**
	 * Modifier bits of the right-press being processed, taken from the pointer event itself.
	 * `NO_PRESS_RECORD` means no press was seen, and only then does key state answer.
	 *
	 * `input.ctrl` is ControlLeft/ControlRight keydown state on `window`, and it can disagree
	 * with the click in both directions. False when it should be true: `window` blur clears
	 * every key (core/input), so alt-tabbing back into the game still holding Ctrl gives
	 * modifier bits 0 and OpenRA answers Move — measured on the composed build, and a force
	 * attack that quietly becomes a drive-in is the worst kind of wrong. True when it should
	 * be false: a keyup lost to a blur, a focus change or a swallowed event leaves the key
	 * latched down, and then an ordinary right click would open fire on a friendly. So the
	 * press wins outright rather than being OR-ed with key state: a modifier the player was
	 * not holding at the moment of the click is not a modifier. forceattackgate proves both
	 * directions, including the latched-key case.
	 */
	private commandModifiers = MODIFIERS_NO_PRESS
	/**
	 * Modifiers of the left click that decides the current selection. Additive select is
	 * settled on release, which is also when OpenRA reads its modifiers, so this is captured
	 * from the pointerup rather than the press. Measured before this existed:
	 * Shift-click-release-Shift in quick succession selected one unit instead of adding to
	 * the group, because the key was already up by the frame that read it.
	 */
	private selectModifiers = MODIFIERS_NO_PRESS
	private commandCanvas: HTMLCanvasElement | null = null
	private readonly onCanvasPointerDown = (event: PointerEvent): void => {
		if (event.button === 2) this.commandModifiers = modifierBits(event)
	}
	private readonly onCanvasPointerUp = (event: PointerEvent): void => {
		if (event.button === 0) this.selectModifiers = modifierBits(event)
		this.music?.unlock()
		this.eva?.unlock()
	}
	private readonly onProduced = (event: SnapshotEvent): void => this.showProductionComplete(event)
	private readonly onUnitLost = (event: SnapshotEvent): void => this.handleUnitLost(event)
	/** Spoken battlefield announcer, owned by the audio node (rule 3); silent until a gesture.
	 *  Writable so harnesses can inject a stub without an audio node in the registry. */
	private evaOverride: AudioApi['eva'] | null = null
	private get eva(): AudioApi['eva'] | null {
		return this.evaOverride ?? this.ctx?.get<AudioApi>('audio')?.eva ?? null
	}
	private set eva(value: AudioApi['eva'] | null) {
		this.evaOverride = value
	}
	/** Boot-to-match soundtrack; mute-anytime via HUD chip or M. Same ownership rule. */
	private musicOverride: AudioApi['music'] | null = null
	private get music(): AudioApi['music'] | null {
		return this.musicOverride ?? this.ctx?.get<AudioApi>('audio')?.music ?? null
	}
	private set music(value: AudioApi['music'] | null) {
		this.musicOverride = value
	}
	/** The console's procedural UI sounds (audio node); absent in harnesses without audio. */
	private get uiSound(): AudioApi['ui'] | null {
		return this.ctx?.get<AudioApi>('audio')?.ui ?? null
	}
	private uiCue(name: UiCue, variant?: number): void {
		this.uiSound?.cue(name, variant)
	}
	private evaLowPower = false
	private evaOutcomeSpoken = false
	/** Lobby retries while the host finishes scanning its map catalog. */
	private catalogRetry = 0
	/** AI opponents the match started with, so "3 of 5 left" can be said under fog. */
	private botsAtStart = 0
	/** True while the current match arrived through the network lobby (mpJoinCommon). */
	private mpMatch = false
	private hudOpponents: HTMLElement | null = null
	private menuMusic: HTMLButtonElement | null = null
	private musicVolDown: HTMLButtonElement | null = null
	private musicVolUp: HTMLButtonElement | null = null
	private sessionComposition: HTMLElement | null = null
	private readonly onSlotChange = (): void => this.renderComposition()
	private hudDaylight: HTMLElement | null = null
	private hudCamera: HTMLElement | null = null
	private readonly edgeHints: (HTMLElement | null)[] = [null, null, null, null]
	private lastEdgeMask = -1
	private lastDaylightMode = ''
	/** Day/Night chosen in the lobby lock the in-game switch for the whole match. */
	private daylightLocked = false
	/** How many of the map's slots the lobby exposes as configurable rows. */
	private sessionPlayerCount = 2
	private gameMenuRoot: HTMLElement | null = null
	private copyrightModal: HTMLElement | null = null
	/** Held on-screen camera controls, applied per frame so they follow the frame clock. */
	private readonly cameraHold = { panRight: 0, panForward: 0, zoom: 0, tilt: 0, turn: 0 }
	private readonly onDaylightClick = (event: Event): void => this.chooseDaylight(event)
	private readonly onCameraPointerDown = (event: PointerEvent): void => this.pressCameraControl(event)
	private readonly onCameraRelease = (): void => this.releaseCameraControls()
	private readonly onWindowBlur = (): void => this.releaseCameraControls()
	private readonly onMinimapContext = (event: Event): void => event.preventDefault()
	/**
	 * The host's passability plane, copied once per map rather than read through the live
	 * snapshot: the decoded snapshot aliases the bridge's double buffer and must not be
	 * retained past the next swap (core/snapshot).
	 */
	private passability = new Uint8Array(0)
	private passabilityW = 0
	private passabilityH = 0
	private passabilityOriginX = 0
	private passabilityOriginY = 0
	/** Flood-fill scratch, allocated with the plane so a click never allocates. */
	private reachSeen = new Int32Array(0)
	private reachQueue = new Int32Array(0)
	private reachStamp = 0
	/** Where the last order was aimed, and whether the selection can actually get there. */
	private readonly orderMarker = { x: 0, z: 0, bornMs: 0, reachable: true, attack: false, active: false }
	private orderMarkerRing: SVGCircleElement | null = null
	private orderMarkerDot: SVGCircleElement | null = null
	private orderMarkerReticle: SVGPathElement | null = null
	/** Control groups: digit 1..6 → remembered selection, pruned on recall. */
	private readonly groupMembers = new Map<number, number[]>()
	private groupRecallKey = 0
	private groupRecallMs = 0
	/** Attack-move aim mode: armed with F, consumed by the next left click or cancelled. */
	private attackMoveArmed = false
	/** G armed: the next left release guards the actor under the cursor or defends the ground there. */
	private guardArmed = false
	/** Cached "any selected local actor carries Armament"; refreshed when the selection changes. */
	private selectionArmed = false
	/** Rally points remembered per own production building, drawn while that building is selected. */
	private readonly rallyPoints = new Map<number, { x: number; z: number }>()
	private rallyLine: SVGLineElement | null = null
	/** Corner brackets pooled in the SVG overlay, drawn over the actor the pointer hovers. */
	private hoverMarkBack: SVGPathElement | null = null
	private hoverMark: SVGPathElement | null = null
	private actionHint: SVGTextElement | null = null
	private orderAction: ActionFeedback | null = null
	private contextPreviewKey = ''
	/** Where the last contextual intent's pointer met its target (world metres), or null. */
	private intentAim: { x: number; z: number } | null = null
	private contextPreview: ContextOrderPreview | null = null
	/** Key the stored verdict was actually computed for; a stale verdict must never block an order. */
	private contextPreviewResolvedKey: string | null = null
	/** Canvas cursor currently applied; compared per frame so the style write only happens on change. */
	private hoverCursor = ''
	/** Per-snapshot own-unit health, for damage attribution (the actorDamaged event payload has no actor id). */
	private lastDamageScanTick = -1
	private prevHealthByActor = new Map<number, number>()
	private currHealthByActor = new Map<number, number>()
	private readonly underAttackAt = new Map<number, number>()

	get selection(): readonly number[] {
		return this.selected
	}

	init(ctx: Ctx): void {
		readUiPalette()
		this.ctx = ctx
		this.render = ctx.get<RenderApi>('render')
		this.terrain = ctx.get<TerrainApi>('terrain')
		this.shroud = ctx.get<ShroudApi>('shroud')
		this.commandCanvas = ctx.canvas
		this.commandCanvas.addEventListener('pointerdown', this.onCanvasPointerDown)
		this.commandCanvas.addEventListener('pointerup', this.onCanvasPointerUp)
		this.bindHud()
		this.offProduced = ctx.events.on(SimEvent.productionComplete, this.onProduced)
		this.offUnitLost = ctx.events.on(SimEvent.actorDestroyed, this.onUnitLost)
		// Weapon fire names its shooter. Damage is identified from visible health deltas
		// in onSnapshot: ActorDamaged carries a world position, NOT actor ids.
		this.offFire = ctx.events.on(SimEvent.weaponFire, this.onWeaponFire)
		this.showSessionSetup()

		// A flat torus, meshed once at boot (rule 10: every mesh exists before frame 1). Thin
		// and wide rather than tubular — this is a mark ON the ground, and a fat ring reads as a
		// doughnut sitting on the terrain instead of as a highlight painted onto it.

		// Desktop shell entry points (boot-once navigation: the shell swaps
		// screens in-page instead of reloading the page). The browser variant
		// never calls these; the LAN section stays hidden unless fed.
		const shell = globalThis as Record<string, unknown>
		shell.__steelseedSelectSession = (tab: 'skirmish' | 'mp') => {
			this.showSessionSetup()
			// The desktop entry point pins the chosen mode, like ?session= does:
			// entering via Skirmish hides the Multiplayer tab and vice versa —
			// the landing button already made that choice.
			this.pinnedSession = tab
			this.sessionTabSkirmish?.toggleAttribute('hidden', tab === 'mp')
			this.sessionTabMp?.toggleAttribute('hidden', tab === 'skirmish')
			this.selectSessionTab(tab)
			this.updateSessionNav()
		}
		shell.__steelseedSetMpDir = (dir: string) => {
			this.mpDirOverride = String(dir ?? '')
			void this.refreshMpRooms()
		}
		shell.__steelseedLanRooms = (rooms: LanRoomRow[]) => this.renderLanRooms(rooms)
		// The landing's Multiplayer switch. Off never tears down a live lobby: it lands when the
		// lobby is back to idle.
		shell.__steelseedSetMultiplayer = (on: boolean) => {
			const next = on !== false
			if (!next && this.mpPhase !== 'idle') {
				this.desktopMpOffPending = true
				return
			}
			this.desktopMpOffPending = false
			if (next === this.desktopMultiplayer) return
			this.desktopMultiplayer = next
			this.applyMpSwitch()
		}
		// The landing's "Host a game": the host card, in view and focused.
		shell.__steelseedFocusHost = () => {
			const col = document.getElementById('session-mp-host-col')
			if (!col || col.hidden) return
			col.scrollIntoView({ block: 'nearest' })
			col.dataset.flash = ''
			setTimeout(() => { delete col.dataset.flash }, 1400)
			const nickname = document.getElementById('session-mp-name') as HTMLInputElement | null
			;(nickname && nickname.value.trim() === '' ? nickname : this.sessionMpHost)?.focus({ preventScroll: true })
		}
		const mesh = new Mesh()
		const tube = 0.05
		sdf.surfaceNets(
			sdf.rotateX(sdf.torus(RING_RADIUS_M, tube), Math.PI * 0.5),
			sdf.setAabb(
				sdf.aabb(),
				-RING_RADIUS_M - tube * 2, -tube * 2, -RING_RADIUS_M - tube * 2,
				RING_RADIUS_M + tube * 2, tube * 2, RING_RADIUS_M + tube * 2,
			),
			72, mesh, { creaseAngle: 60, seal: true },
		)
		if (mesh.vertexCount === 0)
			throw new Error('ui: the selection ring meshed to zero vertices — it would select invisibly')
		this.ring = this.render.upload(mesh, 'ui:selection-ring')
		// The selection mark paints in the readable green: the player asked for green own
		// rings (red stays hostile), translucent so the ground shows through.
		this.item = {
			mesh: this.ring,
			surfaceSet: 'snow',
			instances: this.instances,
			instanceCount: 0,
			playerColors: null,
			castsShadow: false,
			opacity: 0.5,
			unlitColor: this.friendlyRingColor,
		}
		// The UI palette is read once at init. Convert to linear colour for the world pass.
		linearRingColor(uiPalette.healthy, this.friendlyRingColor)
		linearRingColor(uiPalette.critical, this.hostileRingColor)
		linearRingColor('#B57BEC', this.disguiseRingColor)
		linearRingColor('#FFFFFF', this.troopHighlightColor)
		this.troopHighlightItem = {
			...this.item, instances: this.troopHighlightInstances, opacity: 1,
			unlitColor: this.troopHighlightColor,
		}
		this.friendlyRingItem = {
			...this.item, instances: this.friendlyRingInstances, opacity: 0.8,
			unlitColor: this.friendlyRingColor,
		}
		this.hostileRingItem = {
			...this.item, instances: this.hostileRingInstances, opacity: 0.8,
			unlitColor: this.hostileRingColor,
		}
		this.disguiseRingItem = {
			...this.item, instances: this.disguiseRingInstances, opacity: 0.85,
			unlitColor: this.disguiseRingColor,
		}
		this.placementRingItem = {
			mesh: this.ring,
			surfaceSet: 'foundry',
			instances: this.placementRingInstances,
			instanceCount: 1,
			playerColors: this.placementRingColors,
			castsShadow: false,
		}
		const parent = ctx.canvas.parentElement
		if (parent) {
			if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative'
			const overlay = document.createElementNS(SVG_NAMESPACE, 'svg') as SVGSVGElement
			overlay.setAttribute('aria-hidden', 'true')
			overlay.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2;overflow:visible'
			const selectionBox = document.createElementNS(SVG_NAMESPACE, 'rect') as SVGRectElement
			selectionBox.style.display = 'none'
			selectionBox.setAttribute('fill', 'rgba(255,176,73,0.14)')
			selectionBox.setAttribute('stroke', 'rgba(255,205,129,0.98)')
			selectionBox.setAttribute('stroke-width', '1.5')
			selectionBox.setAttribute('vector-effect', 'non-scaling-stroke')
			overlay.append(selectionBox)
			this.selectionBox = selectionBox
			for (let i = 0; i < 512; i++) {
				const polygon = document.createElementNS(SVG_NAMESPACE, 'polygon') as SVGPolygonElement
				polygon.style.display = 'none'
				polygon.setAttribute('stroke-width', '1.5')
				overlay.append(polygon)
				this.placementPolygons.push(polygon)
			}
			const markerRing = document.createElementNS(SVG_NAMESPACE, 'circle') as SVGCircleElement
			markerRing.style.display = 'none'
			markerRing.setAttribute('fill', 'none')
			markerRing.setAttribute('stroke-width', '2')
			markerRing.setAttribute('vector-effect', 'non-scaling-stroke')
			const markerDot = document.createElementNS(SVG_NAMESPACE, 'circle') as SVGCircleElement
			markerDot.style.display = 'none'
			markerDot.setAttribute('stroke', 'none')
			overlay.append(markerRing, markerDot)
			this.orderMarkerRing = markerRing
			this.orderMarkerDot = markerDot
			// Attack orders draw an X reticle instead of the move ring: shape, not colour,
			// carries the distinction, because amber/red already mean reachable/unreachable.
			const markerReticle = document.createElementNS(SVG_NAMESPACE, 'path') as SVGPathElement
			markerReticle.style.display = 'none'
			markerReticle.setAttribute('fill', 'none')
			markerReticle.setAttribute('stroke-width', '2')
			markerReticle.setAttribute('stroke-linecap', 'round')
			markerReticle.setAttribute('vector-effect', 'non-scaling-stroke')
			overlay.append(markerReticle)
			this.orderMarkerReticle = markerReticle
			const rallyLine = document.createElementNS(SVG_NAMESPACE, 'line') as SVGLineElement
			rallyLine.style.display = 'none'
			rallyLine.setAttribute('stroke', 'rgba(255,196,104,0.55)')
			rallyLine.setAttribute('stroke-width', '1.5')
			rallyLine.setAttribute('stroke-dasharray', '6 6')
			rallyLine.setAttribute('vector-effect', 'non-scaling-stroke')
			overlay.append(rallyLine)
			this.rallyLine = rallyLine
			// A new overlay gets new elements: the old ones went with the overlay that held them.
			this.beaconArrows.length = 0
			this.beaconPosters.length = 0
			this.beaconClocks.length = 0
			this.rangeOutlines.length = 0
			for (let i = 0; i < 4; i++) {
				const arrow = document.createElementNS(SVG_NAMESPACE, 'path') as SVGPathElement
				arrow.style.display = 'none'
				arrow.setAttribute('fill', 'rgba(255,86,64,0.85)')
				arrow.setAttribute('stroke', 'rgba(8,10,12,0.8)')
				arrow.setAttribute('stroke-width', '1.5')
				const poster = document.createElementNS(SVG_NAMESPACE, 'rect') as SVGRectElement
				poster.style.display = 'none'
				poster.setAttribute('fill', 'rgba(255,215,94,0.9)')
				poster.setAttribute('stroke', 'rgba(8,10,12,0.8)')
				poster.setAttribute('stroke-width', '1')
				// The clock: the part of the poster whose time has run, shaded like a sweep.
				const clock = document.createElementNS(SVG_NAMESPACE, 'path') as SVGPathElement
				clock.style.display = 'none'
				clock.setAttribute('fill', 'rgba(8,10,12,0.7)')
				overlay.append(arrow, poster, clock)
				this.beaconArrows.push(arrow)
				this.beaconPosters.push(poster)
				this.beaconClocks.push(clock)
			}
			const footprint = document.createElementNS(SVG_NAMESPACE, 'path') as SVGPathElement
			footprint.style.display = 'none'
			footprint.setAttribute('stroke-width', '1.5')
			footprint.setAttribute('stroke-linejoin', 'round')
			footprint.setAttribute('vector-effect', 'non-scaling-stroke')
			overlay.append(footprint)
			this.supportFootprint = footprint
			for (let i = 0; i < MAX_RANGE_OUTLINES; i++) {
				const outline = document.createElementNS(SVG_NAMESPACE, 'path') as SVGPathElement
				outline.style.display = 'none'
				outline.setAttribute('fill', 'none')
				outline.setAttribute('stroke-width', '1.5')
				outline.setAttribute('stroke-dasharray', '7 5')
				outline.setAttribute('vector-effect', 'non-scaling-stroke')
				overlay.append(outline)
				this.rangeOutlines.push(outline)
			}
			parent.append(overlay)
			this.placementOverlay = overlay
			for (let i = 0; i < MAX_HEALTH_BARS; i++) this.healthBars.push(this.createHealthBar(overlay))
			for (let i = 0; i < MAX_STATUS_BARS; i++) this.statusBars.push(this.createHealthBar(overlay, 'statusbar'))
			for (let i = 0; i < MAX_STATUS_MARKS; i++) this.statusMarks.push(this.createStatusMark(overlay))
			for (let i = 0; i < MAX_REPAIR_MARKS; i++) this.repairMarks.push(this.createRepairMark(overlay))
			for (let i = 0; i < MAX_VETERANCY_MARKS; i++) this.veterancyMarks.push(this.createVeterancyMark(overlay))
			this.fakeTags.length = 0
			for (let i = 0; i < MAX_FAKE_TAGS; i++) this.fakeTags.push(this.createFakeTag(overlay))
			// Enemy hover brackets. Last in the DOM, so they paint over the health bars they
			// may sit beside; two strokes over one path — the dark one backs the amber the
			// way every HUD panel reads (dark under amber) — instead of four corner elements.
			const hoverBack = document.createElementNS(SVG_NAMESPACE, 'path') as SVGPathElement
			hoverBack.style.display = 'none'
			hoverBack.setAttribute('fill', 'none')
			hoverBack.setAttribute('stroke', 'rgba(8,10,12,0.78)')
			hoverBack.setAttribute('stroke-width', '4')
			hoverBack.setAttribute('stroke-linecap', 'square')
			hoverBack.setAttribute('vector-effect', 'non-scaling-stroke')
			const hoverMark = document.createElementNS(SVG_NAMESPACE, 'path') as SVGPathElement
			hoverMark.style.display = 'none'
			hoverMark.setAttribute('fill', 'none')
			hoverMark.setAttribute('stroke', uiPalette.active)
			hoverMark.setAttribute('stroke-width', '1.75')
			hoverMark.setAttribute('stroke-linecap', 'square')
			hoverMark.setAttribute('vector-effect', 'non-scaling-stroke')
			overlay.append(hoverBack, hoverMark)
			this.hoverMarkBack = hoverBack
			this.hoverMark = hoverMark
			const hint = document.createElementNS(SVG_NAMESPACE, 'text') as SVGTextElement
			hint.style.display = 'none'
			hint.setAttribute('data-action-hint', '')
			hint.setAttribute('font-family', 'monospace')
			hint.setAttribute('font-size', '12')
			hint.setAttribute('font-weight', '600')
			hint.setAttribute('fill', uiPalette.ink)
			hint.setAttribute('stroke', '#10161B')
			hint.setAttribute('stroke-width', '4')
			hint.setAttribute('paint-order', 'stroke')
			hint.setAttribute('stroke-linejoin', 'round')
			overlay.append(hint)
			this.actionHint = hint
		}
		mesh.clear()
	}

	/** Writes one pooled bar's geometry and colour. Attribute writes only; nothing allocated. */
	private placeHealthBar(index: number, sx: number, sy: number, halfWidthPx: number, health: number): void {
		const width = Math.max(22, Math.min(72, Math.round(halfWidthPx * 2)))
		const x = Math.round(sx - width / 2)
		const y = Math.round(sy)
		const bar = this.healthBars[index]
		bar.back.setAttribute('x', String(x - 1))
		bar.back.setAttribute('y', String(y - 1))
		bar.back.setAttribute('width', String(width + 2))
		bar.back.setAttribute('height', '6')
		bar.fill.setAttribute('x', String(x))
		bar.fill.setAttribute('y', String(y))
		bar.fill.setAttribute('width', String(Math.max(1, Math.round(width * health / 255))))
		bar.fill.setAttribute('height', '4')
		bar.fill.setAttribute('fill', healthColour(health))
		bar.back.style.display = ''
		bar.fill.style.display = ''
	}

	private createHealthBar(overlay: SVGSVGElement, kind = 'healthbar'): { back: SVGRectElement; fill: SVGRectElement } {
		const back = document.createElementNS(SVG_NAMESPACE, 'rect') as SVGRectElement
		back.setAttribute(`data-${kind}`, 'back')
		back.setAttribute('fill', 'rgba(8,10,12,0.62)')
		back.setAttribute('rx', '1')
		back.style.display = 'none'
		const fill = document.createElementNS(SVG_NAMESPACE, 'rect') as SVGRectElement
		fill.setAttribute(`data-${kind}`, 'fill')
		fill.setAttribute('rx', '1')
		fill.style.display = 'none'
		overlay.append(back, fill)
		return { back, fill }
	}

	/** A thin timed-state bar under the health bar: what is left of an Iron Curtain or a chronoshift. */
	private placeStatusBar(index: number, sx: number, sy: number, halfWidthPx: number, fraction: number, colour: string): void {
		const width = Math.max(22, Math.min(72, Math.round(halfWidthPx * 2)))
		const x = Math.round(sx - width / 2)
		const y = Math.round(sy)
		const bar = this.statusBars[index]
		bar.back.setAttribute('x', String(x - 1))
		bar.back.setAttribute('y', String(y - 1))
		bar.back.setAttribute('width', String(width + 2))
		bar.back.setAttribute('height', '5')
		bar.fill.setAttribute('x', String(x))
		bar.fill.setAttribute('y', String(y))
		bar.fill.setAttribute('width', String(Math.max(1, Math.round(width * Math.min(1, fraction)))))
		bar.fill.setAttribute('height', '3')
		bar.fill.setAttribute('fill', colour)
		bar.back.style.display = ''
		bar.fill.style.display = ''
	}

	private createStatusMark(overlay: SVGSVGElement): SVGTextElement {
		const text = document.createElementNS(SVG_NAMESPACE, 'text') as SVGTextElement
		text.setAttribute('text-anchor', 'middle')
		text.setAttribute('fill', 'rgba(255, 220, 160, 0.95)')
		text.setAttribute('stroke', 'rgba(8, 10, 12, 0.75)')
		text.setAttribute('stroke-width', '3')
		text.setAttribute('paint-order', 'stroke')
		text.setAttribute('font-size', '11')
		text.setAttribute('font-family', 'ui-monospace, Menlo, Consolas, monospace')
		text.style.display = 'none'
		overlay.append(text)
		return text
	}

	/** Gold rank chevrons over veterans; dark backing path, same pairing as the hover mark. */
	private createFakeTag(overlay: SVGSVGElement): SVGGElement {
		const tag = document.createElementNS(SVG_NAMESPACE, 'g') as SVGGElement
		tag.setAttribute('class', 'hud-fake-tag')
		tag.style.display = 'none'
		const plate = document.createElementNS(SVG_NAMESPACE, 'rect')
		plate.setAttribute('x', '-19'); plate.setAttribute('y', '-8'); plate.setAttribute('width', '38'); plate.setAttribute('height', '15')
		plate.setAttribute('rx', '2'); plate.setAttribute('fill', 'rgba(8,10,12,0.82)'); plate.setAttribute('stroke', '#ffd75e'); plate.setAttribute('stroke-width', '1')
		const label = document.createElementNS(SVG_NAMESPACE, 'text')
		label.setAttribute('text-anchor', 'middle'); label.setAttribute('y', '3.5'); label.setAttribute('fill', '#ffd75e')
		label.setAttribute('font-size', '10'); label.setAttribute('font-weight', '700'); label.setAttribute('letter-spacing', '1')
		label.textContent = 'FAKE'
		tag.append(plate, label)
		overlay.append(tag)
		return tag
	}

	/**
	 * A fake our spy has been inside reads as one, as OpenRA shows its infiltrators' side the
	 * decoration: a small plate above the structure. Only for fakes in the snapshot (seen now).
	 */
	private updateFakeTags(ctx: Ctx, actors: NonNullable<Snapshot['actors']>, units: UnitsApi, terrain: TerrainApi, render: RenderApi): void {
		let shown = 0
		if (this.revealedFakes.size > 0 && this.placementOverlay) {
			const viewW = canvasCssWidth(ctx) || 1, viewH = canvasCssHeight(ctx) || 1, vp = render.camera.viewProj
			for (const id of this.revealedFakes) {
				if (shown >= this.fakeTags.length) break
				const i = findActorIndex(actors, id)
				if (i < 0) continue
				const screen = projectActorCentre(vp, actors, i, units, terrain, viewW, viewH)
				if (!screen) continue
				const topY = screen.groundY + screen.height + 0.8
				const w = vp[3] * screen.worldX + vp[7] * topY + vp[11] * screen.worldZ + vp[15]
				if (w <= 0) continue
				const sx = ((vp[0] * screen.worldX + vp[4] * topY + vp[8] * screen.worldZ + vp[12]) / w * 0.5 + 0.5) * viewW
				const sy = (0.5 - (vp[1] * screen.worldX + vp[5] * topY + vp[9] * screen.worldZ + vp[13]) / w * 0.5) * viewH
				if (sx < -40 || sy < -40 || sx > viewW + 40 || sy > viewH + 40) continue
				const tag = this.fakeTags[shown++]
				tag.setAttribute('transform', `translate(${sx.toFixed(1)} ${sy.toFixed(1)})`)
				tag.style.display = ''
			}
			if (shown > 0) {
				this.placementOverlay.setAttribute('viewBox', `0 0 ${viewW} ${viewH}`)
				this.placementOverlay.style.display = ''
			}
		}
		for (let i = shown; i < this.fakeTagsShown; i++) this.fakeTags[i].style.display = 'none'
		this.fakeTagsShown = shown
	}

	private createVeterancyMark(overlay: SVGSVGElement): { back: SVGPathElement; main: SVGPathElement } {
		const back = document.createElementNS(SVG_NAMESPACE, 'path') as SVGPathElement
		back.style.display = 'none'
		back.setAttribute('fill', 'none')
		back.setAttribute('stroke', 'rgba(8,10,12,0.78)')
		back.setAttribute('stroke-width', '4')
		back.setAttribute('stroke-linecap', 'round')
		back.setAttribute('stroke-linejoin', 'round')
		const main = document.createElementNS(SVG_NAMESPACE, 'path') as SVGPathElement
		main.style.display = 'none'
		main.setAttribute('fill', 'none')
		main.setAttribute('stroke', '#ffd75e')
		main.setAttribute('stroke-width', '2')
		main.setAttribute('stroke-linecap', 'round')
		main.setAttribute('stroke-linejoin', 'round')
		overlay.append(back, main)
		return { back, main }
	}

	/**
	 * Rank chevrons for every visible veteran, drawn just above its health bar slot.
	 * Levels render 1-3 stacked Vs; the pool caps at MAX_VETERANCY_MARKS groups per frame,
	 * and off-screen or hidden actors are skipped before any attribute is written.
	 */
	private updateVeterancyMarks(
		ctx: Ctx,
		actors: NonNullable<Snapshot['actors']>,
		units: UnitsApi,
		terrain: TerrainApi,
		render: RenderApi,
	): void {
		const overlay = this.placementOverlay
		if (!overlay) return
		const viewW = canvasCssWidth(ctx) || 1
		const viewH = canvasCssHeight(ctx) || 1
		const vp = render.camera.viewProj
		let shown = 0
		for (let i = 0; i < actors.count && shown < MAX_VETERANCY_MARKS; i++) {
			const level = actors.veterancy[i]
			if (level < 1) continue
			const screen = projectActorCentre(vp, actors, i, units, terrain, viewW, viewH)
			if (!screen) continue
			const topY = screen.groundY + screen.height + 1.05
			const w = vp[3] * screen.worldX + vp[7] * topY + vp[11] * screen.worldZ + vp[15]
			if (w <= 0) continue
			const sx = ((vp[0] * screen.worldX + vp[4] * topY + vp[8] * screen.worldZ + vp[12]) / w * 0.5 + 0.5) * viewW
			const sy = (0.5 - (vp[1] * screen.worldX + vp[5] * topY + vp[9] * screen.worldZ + vp[13]) / w * 0.5) * viewH
			if (sx < -40 || sy < -40 || sx > viewW + 40 || sy > viewH + 40) continue
			// Stacked Vs, top row first: three ranks read as a pyramid above the hull.
			const ranks = Math.min(3, level)
			const rows = Math.min(ranks, 3)
			const y0 = sy - (rows - 1) * 3.5
			let d = ''
			for (let r = 0; r < rows; r++) {
				const y = y0 + r * 7
				d += `M${(sx - 5).toFixed(1)} ${(y + 3).toFixed(1)}L${sx.toFixed(1)} ${y.toFixed(1)}L${(sx + 5).toFixed(1)} ${(y + 3).toFixed(1)}`
			}
			const mark = this.veterancyMarks[shown++]
			mark.back.setAttribute('d', d)
			mark.main.setAttribute('d', d)
			mark.back.style.display = ''
			mark.main.style.display = ''
		}
		for (let i = shown; i < this.veterancyMarksShown; i++) {
			this.veterancyMarks[i].back.style.display = 'none'
			this.veterancyMarks[i].main.style.display = 'none'
		}
		this.veterancyMarksShown = shown
		if (shown > 0) {
			overlay.setAttribute('viewBox', `0 0 ${viewW} ${viewH}`)
			overlay.style.display = ''
		}
	}

	private createRepairMark(overlay: SVGSVGElement): { root: SVGGElement; ring: SVGCircleElement } {
		const root = document.createElementNS(SVG_NAMESPACE, 'g') as SVGGElement
		root.setAttribute('class', 'hud-repair-mark')
		root.style.display = 'none'
		const glow = document.createElementNS(SVG_NAMESPACE, 'circle')
		glow.setAttribute('class', 'hud-repair-glow')
		glow.setAttribute('r', '11')
		glow.setAttribute('cx', '0')
		glow.setAttribute('cy', '0')
		const ring = document.createElementNS(SVG_NAMESPACE, 'circle') as SVGCircleElement
		ring.setAttribute('class', 'hud-repair-ring')
		ring.setAttribute('r', '18')
		ring.setAttribute('cx', '0')
		ring.setAttribute('cy', '0')
		const wrench = document.createElementNS(SVG_NAMESPACE, 'path')
		wrench.setAttribute('class', 'hud-repair-wrench')
		wrench.setAttribute('d', 'M-2.4-8.6h4.8c1.7 0 1.7 3.4 0 3.4h-1.1v1.4h1.1c2.6 0 2.6-6.2 0-6.2h-4.8c-2.6 0-2.6 6.2 0 6.2h1.1V-5.2h-1.1c-1.7 0-1.7-3.4 0-3.4zm-.2 5.2h1.7v6.6l2.6 2.6-1.4 1.4-2.6-2.6-2.6 2.6-1.4-1.4 2.6-2.6z')
		const sparks = [
			[-16, -6, -22, -11],
			[16, -4, 23, -9],
			[-13, 10, -19, 16],
			[14, 9, 21, 15],
		]
		root.append(glow, ring, wrench)
		for (let s = 0; s < sparks.length; s++) {
			const spark = sparks[s]
			const line = document.createElementNS(SVG_NAMESPACE, 'line') as SVGLineElement
			line.setAttribute('class', 'hud-repair-spark')
			line.setAttribute('x1', String(spark[0]))
			line.setAttribute('y1', String(spark[1]))
			line.setAttribute('x2', String(spark[2]))
			line.setAttribute('y2', String(spark[3]))
			line.style.animationDelay = `${s * 0.11}s`
			root.append(line)
		}
		overlay.append(root)
		return { root, ring }
	}

	onSnapshot(snap: Snapshot, prev: Snapshot | null, _ctx: Ctx): void {
		// Drop anything that has left the world. A selection holding a dead id would draw a ring
		// on empty ground, and — worse — would keep it alive across the id being recycled.
		const actors = snap.actors
		if (actors && this.selected.length > 0) {
			let write = 0
			for (let i = 0; i < this.selected.length; i++) {
				const id = this.selected[i]
				let alive = false
				for (let a = 0; a < actors.count; a++) {
					if (actors.id[a] !== id) continue
					alive = true
					break
				}
				if (alive) this.selected[write++] = id
			}
			this.selected.length = write
		}
		// ActorDamaged's payload contains impact coordinates, not a victim or attacker id.
		// Health loss across the authoritative visible snapshots identifies the actual victim.
		const previous = prev?.actors
		if (actors && previous) for (let i = 0; i < actors.count; i++) {
			if (actors.health[i] >= 255) continue
			const previousIndex = findActorIndex(previous, actors.id[i])
			if (previousIndex >= 0 && actors.health[i] < previous.health[previousIndex]) this.markCombat(actors.id[i])
		}
		// Forget marks as soon as actors leave the authoritative visible set (death/fog).
		if (actors) for (const id of this.combatMarks.keys()) {
			let visible = false
			for (let i = 0; i < actors.count; i++) if (actors.id[i] === id) { visible = true; break }
			if (!visible) this.combatMarks.delete(id)
		}
		if (actors && this.selected.length === 0) {
			this.attackMoveArmed = false
			this.guardArmed = false
		}
		if (actors && this.rallyPoints.size > 0) {
			for (const id of this.rallyPoints.keys()) {
				let alive = false
				for (let a = 0; a < actors.count; a++) {
					if (actors.id[a] !== id) continue
					alive = true
					break
				}
				if (!alive) this.rallyPoints.delete(id)
			}
		}
		this.pruneRepairing(actors)
		if (actors && this.selected.length > 0) this.refreshSelectionArmed(_ctx)

		this.refreshPassability(snap)
		this.updateOpponents(snap)
		this.renderDaylightChoice()
		this.updateHud(snap, _ctx)
		// The overview raster is the single heaviest thing on the tick frame after the
		// environment scan (measured: ~1 s of CPU per 30 s battle). Blips moving at
		// half the tick rate lag the world by 40 ms - invisible at strategic zoom -
		// while every other tick frame gets the whole raster cost back.
		if ((snap.tick & 1) === 0) this.updateStrategicOverview(snap)
		// The first explicit local-base focus happens only after the authoritative match
		// snapshot has crossed camera and terrain. It therefore cannot lose a race to map
		// bounds and fall back to the map centre while an edge-spawned MCV exists.
		if (this.pendingBaseFocus && actors && snap.world) {
			for (let i = 0; i < actors.count; i++) {
				if (actors.owner[i] !== snap.world.renderPlayer) continue
				const x = actors.posX[i] * WPOS_TO_M
				const z = actors.posY[i] * WPOS_TO_M
				const camera = _ctx.get<CameraApi>('camera')
				camera.focusWorld(x, z)
				camera.selectActor(actors.id[i])
				this.selected.length = 1
				this.selected[0] = actors.id[i]
				this.pendingBaseFocus = false
				this.refreshSelectionArmed(_ctx)
				break
			}
		}
		if (snap.players.length > 0) {
			// The first world snapshot of a match (skirmish, or multiplayer starting → playing).
			const matchStarting = this.waitingForStart || (this.mpMatch && (this.mpPhase === 'lobby' || this.mpPhase === 'starting'))
			if (matchStarting) this.maybeStartTutorial(snap)
			this.waitingForStart = false
			if (this.sessionRoot) this.sessionRoot.hidden = true
			// A live match world: the soundtrack may rotate past the theme from here on.
			this.music?.setInMatch?.(true)
			// §5.10 row "starting → playing": the first world snapshot switches
			// the state machine over and applies the room's ambience once.
			if (this.mpMatch && (this.mpPhase === 'lobby' || this.mpPhase === 'starting')) {
				this.mpPhase = 'playing'
				this.outcomeRendered = false
				this.mpApplyRoomAmbience()
			}
		}
	}

	update(dt: number, ctx: Ctx): void {
		// First, and outside every early return below: the one message that must reach the
		// player when nothing else in this method can run because no snapshot ever arrives.
		this.updateSimAlarm(ctx)
		this.applyCameraHold(dt, ctx)
		this.updateEdgeHints(ctx)
		// The tape tracks the damped camera, not the snapshot cadence, so a turn reads as a
		// continuously sliding strip rather than a stepped one.
		this.updateCompass(ctx)
		this.drawMinimapViewport(ctx)
		// The lobby needs the host's map catalog, which lands asynchronously after boot.
		// Until it does, re-arm the setup screen once per frame; the call is one cached
		// length check and the lobby is only rebuilt when the catalog actually arrives.
		if (!this.catalog || this.catalog.maps.length === 0) {
			if (ctx.session.available) this.showSessionSetup()
		}
		// The lobby renders before the simulation host finishes booting: keep Start honest
		// (disabled with a progress note) instead of silently eating clicks until then.
		if (this.sessionStart && this.catalog && this.catalog.maps.length > 0) {
			const ready = ctx.session.available && !this.waitingForStart
			if (this.sessionStart.disabled !== !ready && !this.daylightLocked) {
				this.sessionStart.disabled = !ready
				if (this.sessionStatus && !ready) this.sessionStatus.textContent = 'Starting the simulation host…'
			}
		}
		const render = this.render
		const terrain = this.terrain
		const item = this.item
		if (!render || !terrain || !item) return
		const actors = ctx.snapshot?.actors
		if (!actors) return
		const units = ctx.get<UnitsApi>('units')

		const placedThisFrame = this.updatePlacementPreview(ctx)

		// --- picking ---------------------------------------------------------
		//
		// Projected-position nearest-hit, not a ray against geometry. A ray test would need
		// per-actor bounds `units` does not publish, and would be strictly worse at the far
		// camera where an actor is a few pixels: screen distance is what the player is actually
		// aiming with.
		//
		// Press starts a possible drag; release decides between the ordinary nearest click
		// and a local-owned mobile group. Deferring the decision is what allows the box to
		// cross units without flickering through a series of single selections.
		const pointer = ctx.input.pointer
		const commandModeWasArmed = this.attackMoveArmed || this.guardArmed || this.supportPowerArmed !== null || this.sellMode
		this.updateSelectionInteraction(ctx, actors, units, placedThisFrame)
		this.trackUnderAttack(ctx, actors, units)

		// Both mouse buttons share the engine targeter. A right click in an armed mode
		// only cancels; it must never fall through and issue another command that frame.
		if ((pointer.pressed & 4) !== 0) {
			const modifiers = this.commandModifiers !== MODIFIERS_NO_PRESS
				? this.commandModifiers : this.pointerModifiers(ctx)
			this.commandModifiers = MODIFIERS_NO_PRESS
			const cancelling = commandModeWasArmed || this.attackMoveArmed || this.guardArmed || this.supportPowerArmed !== null || this.sellMode
			if (cancelling) {
				this.attackMoveArmed = false
				this.guardArmed = false
				this.supportPowerArmed = null
				this.supportPowerSource = null
				this.sellMode = false
				this.showNotice('Targeting cancelled')
			} else if (!placedThisFrame && this.pendingPlacement === null && pointer.inside) {
				this.issuePointerContextOrder(ctx, actors, units, modifiers, false)
			}
		}

		// --- rings -------------------------------------------------------------
		this.ringCounts.fill(0)
		const now = performance.now()
		for (const [id, until] of this.combatMarks) if (until <= now) this.combatMarks.delete(id)
		let count = 0
		for (let s = 0; s < this.selected.length && count < MAX_SELECTION; s++) {
			const id = this.selected[s]
			for (let i = 0; i < actors.count; i++) {
				if (actors.id[i] !== id) continue
				this.appendGroundRing(ctx, actors, i, units, terrain)
				count++
				break
			}
		}
		// Visible combat actors use the very same indicator, including unselected enemies.
		// Selected actors were already added above, so there is never a doubled ring.
		for (let i = 0; i < actors.count && count < MAX_SELECTION; i++) {
			if (this.selected.includes(actors.id[i]) || !this.ownHidden(actors, i)) continue
			this.appendGroundRing(ctx, actors, i, units, terrain)
			count++
		}
		for (let i = 0; i < actors.count && count < MAX_SELECTION; i++) {
			const id = actors.id[i]
			if (!this.combatMarks.has(id) || this.selected.includes(id)) continue
			if (this.combatSide(ctx, actors.owner[i]) === 0) continue
			this.appendGroundRing(ctx, actors, i, units, terrain)
			count++
		}
		// Idle enemies too: every visible enemy unit keeps its red ring, not only the ones firing.
		for (let i = 0; i < actors.count && count < MAX_SELECTION; i++) {
			const id = actors.id[i]
			if (this.combatMarks.has(id) || this.selected.includes(id)) continue
			if (!this.enemyUnitMarked(ctx, actors, i, units)) continue
			this.appendGroundRing(ctx, actors, i, units, terrain)
			count++
		}
		this.updateSelectionHud(ctx)
		this.updateSupportPanel(ctx)
		// Screen-space marks reproject EVERY FRAME: units interpolate smoothly at
		// the render rate between simulation ticks, and the marks (health bars,
		// selection indicators) must track those interpolated positions. Gating on
		// tick-change left the marks 2-3 frames behind during movement — visible
		// as flickering health bars over driving units (playtest finding). The
		// performance saving was ~1 ms/frame, not worth the artifact.
		this.updateHealthBars(ctx, actors, units, terrain, render)
		this.updateStatusMarks(ctx, actors, units, terrain, render)
		this.updateRepairMarks(ctx, actors, units, terrain, render)
		this.updateVeterancyMarks(ctx, actors, units, terrain, render)
		this.updateFakeTags(ctx, actors, units, terrain, render)
		this.updateRallyLine(ctx, actors, terrain, render)
		this.updateOrderMarker(ctx, terrain, render)
		this.updateSupportBeacons(ctx, terrain, render)
		this.updateSupportFootprint(ctx, terrain, render)
		this.updateRangeOutlines(ctx, actors, terrain, render)
		if (this.orderTrace) this.followOrderTrace(ctx, actors)
		this.updateHoverTarget(ctx, actors, units, terrain, render)
		this.updateTroopHighlight(ctx, actors, units, terrain, render)
		if (count === 0) return
		this.submitGroundRings(render, item, 0)
		if (this.friendlyRingItem) this.submitGroundRings(render, this.friendlyRingItem, 1)
		if (this.hostileRingItem) this.submitGroundRings(render, this.hostileRingItem, 2)
		if (this.disguiseRingItem) this.submitGroundRings(render, this.disguiseRingItem, 3)
	}
	/** L: three seconds of blinking white rings under every own living troop. */
	private flashTroopRings(): void {
		if (this.waitingForStart || !this.ctx?.snapshot?.actors) return
		this.troopHighlightUntil = performance.now() + 3000
		this.showNotice('All troops marked for 3 seconds')
	}

	/** Per-frame side of the L flash: fill, blink and submit the highlight rings. */
	private updateTroopHighlight(ctx: Ctx, actors: NonNullable<Snapshot['actors']>, units: UnitsApi,
		terrain: TerrainApi, render: RenderApi): void {
		const item = this.troopHighlightItem
		if (!item) return
		const now = performance.now()
		const mutable = item as { -readonly [K in keyof DrawItem]: DrawItem[K] }
		if (now >= this.troopHighlightUntil) {
			mutable.instanceCount = 0
			return
		}
		let count = 0
		for (let i = 0; i < actors.count && count < TROOP_HIGHLIGHT_CAPACITY; i++) {
			if (actors.owner[i] !== this.renderPlayerId) continue
			if ((actors.flags[i] & ActorFlag.husk) !== 0 || actors.health[i] === 0) continue
			if (!TROOP_ROLES.has(units.semanticRole(ctx.actorTypeName(actors.typeId[i])))) continue
			this.appendTroopHighlightRing(actors, i, units, terrain, count++)
		}
		mutable.instanceCount = count
		// The blink: 4 Hz on/off between full and faint opacity, read as one pulse rather
		// than a flicker, and bright enough to spot against snow and dark ground alike.
		mutable.opacity = (now / TROOP_HIGHLIGHT_HALF_PERIOD_MS) % 2 < 1 ? 1 : 0.3
		if (count > 0) render.submit(item)
	}

	private appendTroopHighlightRing(actors: NonNullable<Snapshot['actors']>, index: number,
		units: UnitsApi, terrain: TerrainApi, slot: number): void {
		const m = this.troopHighlightInstances
		const o = slot * 16
		const x = actors.posX[index] * WPOS_TO_M
		const z = actors.posY[index] * WPOS_TO_M
		const y = terrain.heightAt(x, z) + 0.03
		const scale = units.selectionRadiusM(actors.typeId[index]) / RING_RADIUS_M
		m[o] = scale; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0
		m[o + 4] = 0; m[o + 5] = 1; m[o + 6] = 0; m[o + 7] = 0
		m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = scale; m[o + 11] = 0
		m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1
	}

	/** The HUD button: replace the selection with every own living troop. */
	private selectAllTroops(): void {
		const ctx = this.ctx
		const actors = ctx?.snapshot?.actors
		if (!ctx || !actors) return
		const units = ctx.get<UnitsApi>('units')
		this.selected.length = 0
		for (let i = 0; i < actors.count && this.selected.length < MAX_SELECTION; i++) {
			if (actors.owner[i] !== this.renderPlayerId) continue
			if ((actors.flags[i] & ActorFlag.husk) !== 0 || actors.health[i] === 0) continue
			if (!TROOP_ROLES.has(units.semanticRole(ctx.actorTypeName(actors.typeId[i])))) continue
			this.selected.push(actors.id[i])
		}
		this.refreshSelectionArmed(ctx)
		this.showNotice(this.selected.length > 0
			? `Selected ${this.selected.length} troops`
			: 'No troops to select')
	}

	/** M: the strategic overview at five times the size, centred over the HUD. */
	private toggleTacticalMap(): void {
		if (!this.tacticalRoot || !this.tacticalCanvas) return
		this.tacticalOpen = !this.tacticalOpen
		this.tacticalRoot.hidden = !this.tacticalOpen
		if (this.tacticalOpen && this.minimap) {
			this.tacticalCanvas.width = this.minimap.width * TACTICAL_SCALE
			this.tacticalCanvas.height = this.minimap.height * TACTICAL_SCALE
		}
	}

	/**
	 * World health bars above actors, in screen space.
	 *
	 * Who gets one: every selected actor, and every actor whose health is below full. A
	 * value of 255 means full OR "no Health trait", so an undamaged, unselected actor shows
	 * nothing — which is also RA's default. Live actors come from a snapshot the host has
	 * already filtered by shroud, fog and cloak for the render player, so a bar can never
	 * disclose an unseen enemy; own cloaked units carry ActorFlag.cloaked and stay visible
	 * to their owner. Frozen structures use only the frozen record's remembered health and
	 * only while their cell is explored but not currently in sight (state 1): a live actor
	 * exists for the visible case and must not be drawn twice.
	 */
	private updateHealthBars(
		ctx: Ctx,
		actors: NonNullable<Snapshot['actors']>,
		units: UnitsApi,
		terrain: TerrainApi,
		render: RenderApi,
	): void {
		const overlay = this.placementOverlay
		if (!overlay) return
		const viewW = canvasCssWidth(ctx) || 1
		const viewH = canvasCssHeight(ctx) || 1
		const vp = render.camera.viewProj
		let shown = 0

		const status = ctx.snapshot?.actorStatus
		let statusShown = 0
		for (let i = 0; i < actors.count && shown < MAX_HEALTH_BARS; i++) {
			const health = actors.health[i]
			const selected = this.selected.includes(actors.id[i])
			// The timed state this actor carries, if any: its record in actors.status.
			let statusAt = -1
			if (status) for (let r = 0; r < status.count; r++)
				if (status.view.getUint32(status.byteOffset + r * 12, true) === actors.id[i]) { statusAt = status.byteOffset + r * 12; break }
			if (health >= 255 && !selected && statusAt < 0) continue
			const typeId = actors.typeId[i]
			if (!units.isRenderableType(typeId)) continue
			if (!units.healthBarEligible(ctx.actorTypeName(typeId))) continue
			const cellX = Math.floor(actors.posX[i] * WPOS_TO_M)
			const cellZ = Math.floor(actors.posY[i] * WPOS_TO_M)
			const visibility = this.shroud?.stateAt(cellX, cellZ) ?? ShroudState.unexplored
			if (visibility !== ShroudState.visible &&
				!(visibility === ShroudState.explored && units.isShroudOnlyType(typeId))) continue
			const screen = projectActorCentre(vp, actors, i, units, terrain, viewW, viewH)
			if (!screen) continue
			// Anchor: just above the drawn mesh, so a bar never sits inside a tall building.
			const topY = screen.groundY + screen.height + 0.35
			const w = vp[3] * screen.worldX + vp[7] * topY + vp[11] * screen.worldZ + vp[15]
			if (w <= 0) continue
			const sx = ((vp[0] * screen.worldX + vp[4] * topY + vp[8] * screen.worldZ + vp[12]) / w * 0.5 + 0.5) * viewW
			const sy = (0.5 - (vp[1] * screen.worldX + vp[5] * topY + vp[9] * screen.worldZ + vp[13]) / w * 0.5) * viewH
			if (sx < -80 || sy < -20 || sx > viewW + 80 || sy > viewH + 20) continue
			const radius = units.selectionRadiusM(actors.typeId[i])
			const halfWidth = projectedDistancePx(vp, screen.worldX + radius, topY, screen.worldZ, sx, sy, viewW, viewH)
			this.placeHealthBar(shown++, sx, sy - 10, halfWidth, health)
			if (statusAt >= 0 && statusShown < MAX_STATUS_BARS) {
				const kind = status!.view.getUint8(statusAt + 4)
				const remaining = status!.view.getUint16(statusAt + 6, true), total = status!.view.getUint16(statusAt + 8, true)
				// Remaining 0 is a grant with no timer: the bar stays full.
				const fraction = remaining > 0 && total > 0 ? remaining / total : 1
				this.placeStatusBar(statusShown++, sx, sy - 3, halfWidth, fraction, kind === ActorStatusKind.invulnerable ? CURTAIN_BAR : CHRONO_BAR)
			}
		}
		for (let i = statusShown; i < this.statusBarsShown; i++) {
			this.statusBars[i].back.style.display = 'none'
			this.statusBars[i].fill.style.display = 'none'
		}
		this.statusBarsShown = statusShown

		const frozen = ctx.snapshot?.frozenActors
		if (frozen) {
			for (let i = 0; i < frozen.count && shown < MAX_HEALTH_BARS; i++) {
				const health = frozen.health[i]
				if (health >= 255) continue
				if (!units.isRenderableType(frozen.typeId[i])) continue
				if (!units.healthBarEligible(ctx.actorTypeName(frozen.typeId[i]))) continue
				if (findActorIndex(actors, frozen.id[i]) >= 0) continue
				const x = frozen.posX[i] * WPOS_TO_M
				const z = frozen.posY[i] * WPOS_TO_M
				// Explored but not in sight. In sight, the live actor above already drew.
				if (this.shroud?.stateAt(Math.floor(x), Math.floor(z)) !== 1) continue
				const groundY = terrain.heightAt(x, z)
				const topY = groundY + units.selectionHeightM(frozen.typeId[i]) + 0.35
				const w = vp[3] * x + vp[7] * topY + vp[11] * z + vp[15]
				if (w <= 0) continue
				const sx = ((vp[0] * x + vp[4] * topY + vp[8] * z + vp[12]) / w * 0.5 + 0.5) * viewW
				const sy = (0.5 - (vp[1] * x + vp[5] * topY + vp[9] * z + vp[13]) / w * 0.5) * viewH
				if (sx < -80 || sy < -20 || sx > viewW + 80 || sy > viewH + 20) continue
				const radius = units.selectionRadiusM(frozen.typeId[i])
				const halfWidth = projectedDistancePx(vp, x + radius, topY, z, sx, sy, viewW, viewH)
				this.placeHealthBar(shown++, sx, sy - 10, halfWidth, health)
			}
		}

		for (let i = shown; i < this.healthBarsShown; i++) {
			this.healthBars[i].back.style.display = 'none'
			this.healthBars[i].fill.style.display = 'none'
		}
		this.healthBarsShown = shown
		if (shown > 0) {
			overlay.setAttribute('viewBox', `0 0 ${viewW} ${viewH}`)
			overlay.style.display = ''
		}
	}

	/** Cargo filled/capacity and ammo remaining, on selected own transports and magazines. */
	private updateStatusMarks(
		ctx: Ctx,
		actors: NonNullable<Snapshot['actors']>,
		units: UnitsApi,
		terrain: TerrainApi,
		render: RenderApi,
	): void {
		const overlay = this.placementOverlay
		if (!overlay) return
		const viewW = canvasCssWidth(ctx) || 1
		const viewH = canvasCssHeight(ctx) || 1
		const vp = render.camera.viewProj
		let shown = 0
		for (let i = 0; i < actors.count && shown < MAX_STATUS_MARKS; i++) {
			if (actors.owner[i] !== this.renderPlayerId || !this.selected.includes(actors.id[i])) continue
			const actorName = ctx.actorTypeName(actors.typeId[i])
			const capacity = units.cargoCapacity(actorName)
			const ammoCap = units.ammoCapacity(actorName)
			const ammo = actors.ammo ? actors.ammo[i] : 255
			let label = ''
			if (capacity > 0) label = `${actors.cargo[i]}/${capacity}`
			if (ammoCap > 0 && ammo !== 255)
				label = label ? `${label} · ammo ${ammo}/${ammoCap}` : `ammo ${ammo}/${ammoCap}`
			if (!label) continue
			const screen = projectActorCentre(vp, actors, i, units, terrain, viewW, viewH)
			if (!screen) continue
			const topY = screen.groundY + screen.height + 0.55
			const w = vp[3] * screen.worldX + vp[7] * topY + vp[11] * screen.worldZ + vp[15]
			if (w <= 0) continue
			const sx = ((vp[0] * screen.worldX + vp[4] * topY + vp[8] * screen.worldZ + vp[12]) / w * 0.5 + 0.5) * viewW
			const sy = (0.5 - (vp[1] * screen.worldX + vp[5] * topY + vp[9] * screen.worldZ + vp[13]) / w * 0.5) * viewH
			if (sx < -80 || sy < -20 || sx > viewW + 80 || sy > viewH + 20) continue
			const mark = this.statusMarks[shown++]
			mark.setAttribute('x', sx.toFixed(1))
			mark.setAttribute('y', (sy - 16).toFixed(1))
			mark.textContent = label
			mark.style.display = ''
		}
		for (let i = shown; i < this.statusMarksShown; i++) this.statusMarks[i].style.display = 'none'
		this.statusMarksShown = shown
		if (shown > 0) {
			overlay.setAttribute('viewBox', `0 0 ${viewW} ${viewH}`)
			overlay.style.display = ''
		}
	}

	private pruneRepairing(actors: Snapshot['actors'] | undefined): void {
		if (this.repairingCount === 0) return
		let write = 0
		for (let i = 0; i < this.repairingCount; i++) {
			const id = this.repairingIds[i]
			if (!actors) continue
			let keep = false
			for (let a = 0; a < actors.count; a++) {
				if (actors.id[a] !== id) continue
				keep = actors.health[a] < 255
				break
			}
			if (keep) this.repairingIds[write++] = id
		}
		this.repairingCount = write
	}

	private isRepairing(id: number): boolean {
		for (let i = 0; i < this.repairingCount; i++) if (this.repairingIds[i] === id) return true
		return false
	}

	private setRepairing(id: number, on: boolean): void {
		let index = -1
		for (let i = 0; i < this.repairingCount; i++) if (this.repairingIds[i] === id) { index = i; break }
		if (on) {
			if (index >= 0 || this.repairingCount >= this.repairingIds.length) return
			this.repairingIds[this.repairingCount++] = id
			return
		}
		if (index < 0) return
		this.repairingIds[index] = this.repairingIds[this.repairingCount - 1]
		this.repairingCount--
	}

	private updateRepairMarks(
		ctx: Ctx,
		actors: NonNullable<Snapshot['actors']>,
		units: UnitsApi,
		terrain: TerrainApi,
		render: RenderApi,
	): void {
		const overlay = this.placementOverlay
		if (!overlay) return
		this.pruneRepairing(actors)
		const viewW = canvasCssWidth(ctx) || 1
		const viewH = canvasCssHeight(ctx) || 1
		const vp = render.camera.viewProj
		let shown = 0
		for (let r = 0; r < this.repairingCount && shown < MAX_REPAIR_MARKS; r++) {
			const id = this.repairingIds[r]
			let i = -1
			for (let a = 0; a < actors.count; a++) if (actors.id[a] === id) { i = a; break }
			if (i < 0) continue
			const screen = projectActorCentre(vp, actors, i, units, terrain, viewW, viewH)
			if (!screen) continue
			const topY = screen.groundY + screen.height + 0.2
			const w = vp[3] * screen.worldX + vp[7] * topY + vp[11] * screen.worldZ + vp[15]
			if (w <= 0) continue
			const sx = ((vp[0] * screen.worldX + vp[4] * topY + vp[8] * screen.worldZ + vp[12]) / w * 0.5 + 0.5) * viewW
			const sy = (0.5 - (vp[1] * screen.worldX + vp[5] * topY + vp[9] * screen.worldZ + vp[13]) / w * 0.5) * viewH
			if (sx < -80 || sy < -40 || sx > viewW + 80 || sy > viewH + 40) continue
			const radius = units.selectionRadiusM(actors.typeId[i])
			const halfWidth = projectedDistancePx(vp, screen.worldX + radius, topY, screen.worldZ, sx, sy, viewW, viewH)
			const mark = this.repairMarks[shown++]
			const size = Math.max(14, Math.min(34, Math.round(halfWidth)))
			mark.root.setAttribute('transform', `translate(${Math.round(sx)} ${Math.round(sy - 18)})`)
			mark.ring.setAttribute('r', String(size))
			mark.root.style.display = ''
		}
		for (let i = shown; i < this.repairMarksShown; i++) this.repairMarks[i].root.style.display = 'none'
		this.repairMarksShown = shown
		if (shown > 0) {
			overlay.setAttribute('viewBox', `0 0 ${viewW} ${viewH}`)
			overlay.style.display = ''
		}
	}

	private pointerModifiers(ctx: Ctx): number {
		return (ctx.input.ctrl ? 1 : 0) | (ctx.input.shift ? 2 : 0) | (ctx.input.alt ? 4 : 0)
	}

	/**
	 * Under-fire shouts for the player's own units. The `actorDamaged` sim event
	 * carries a position but no actor id, so the health bytes in the snapshot are the
	 * attribution source: a drop between ticks means THAT actor was hit. Per-actor
	 * 8 s cooldown keeps a focused column from machine-gunning the announcer while
	 * still shouting again if the fire continues; buildings stay silent (they have
	 * their own EVA notices).
	 */
	private trackUnderAttack(ctx: Ctx, actors: NonNullable<Snapshot['actors']>, units: UnitsApi): void {
		const snap = ctx.snapshot
		if (!snap || snap.tick === this.lastDamageScanTick) return
		this.lastDamageScanTick = snap.tick
		if (this.prevHealthByActor.size > 4096) {
			this.prevHealthByActor.clear()
			this.underAttackAt.clear()
		}
		const prev = this.prevHealthByActor
		const curr = this.currHealthByActor
		curr.clear()
		const now = performance.now()
		const local = snap.world?.renderPlayer
		for (let i = 0; i < actors.count; i++) {
			const id = actors.id[i], hp = actors.health[i]
			curr.set(id, hp)
			if (local === undefined || actors.owner[i] !== local || hp === 0) continue
			const was = prev.get(id)
			if (was === undefined || hp >= was) continue
			const last = this.underAttackAt.get(id) ?? -1e9
			if (now - last < 8000) continue
			const name = ctx.actorTypeName(actors.typeId[i])
			if (units.hasRaTrait(name, 'Building')) continue
			this.underAttackAt.set(id, now)
			this.eva?.sayUnit('underAttack', units.movementClass(actors.typeId[i]), this.eva?.personaOf(name))
		}
		this.prevHealthByActor = curr
		this.currHealthByActor = prev
	}

	/** Shared hit test for hover, left-click actions and traditional right-click orders. */
	private pointerContextIntent(ctx: Ctx, actors: NonNullable<Snapshot['actors']>, units: UnitsApi,
		modifiers: number): ContextOrderIntent | null {
		const subjectCount = this.packCommandSubjects(actors)
		const pointer = ctx.input.pointer
		const render = this.render, terrain = this.terrain
		if (!subjectCount || !pointer.inside || !render || !terrain) return null
		const cell = ctx.get<CameraApi>('camera').pickGroundCell(pointer.x, pointer.y, ctx)
		if (!cell) return null
		const vp = render.camera.viewProj
		const viewW = Math.max(1, canvasCssWidth(ctx)), viewH = Math.max(1, canvasCssHeight(ctx))
		const hit = pickActorAt(vp, actors, units, terrain, pointer.x, pointer.y, viewW, viewH,
			ctx.actorTypeName, true, render.camera.position)
		let targetActorId = hit < 0 ? 0 : actors.id[hit]
		let targetFrozen = false
		let bestScore = hit < 0 ? 1 : PICKED.score
		// How far along the pointer's ray it enters the target's box; Infinity without an exact hit.
		let aimT = hit >= 0 && PICKED.boxHit ? PICKED.t : Infinity
		const frozen = ctx.snapshot?.frozenActors
		if (frozen) for (let i = 0; i < frozen.count; i++) {
			const name = ctx.actorTypeName(frozen.typeId[i])
			if (!units.hasRaTrait(name, 'Selectable') &&
				!(units.hasRaTrait(name, 'Targetable') && units.hasRaTrait(name, 'Health'))) continue
			const x = frozen.posX[i] * WPOS_TO_M, z = frozen.posY[i] * WPOS_TO_M
			if (this.shroud?.stateAt(Math.floor(x), Math.floor(z)) !== 1) continue
			const groundY = terrain.heightAt(x, z), height = units.selectionHeightM(frozen.typeId[i])
			const y = groundY + height * .5, radius = units.selectionRadiusM(frozen.typeId[i])
			// A remembered building is a box on its footprint like a live one: the frontmost box
			// the pointer meets wins, and any exact hit beats nearness.
			if (POINTER_RAY.ok) {
				const t = rayEntersFootprint(x, groundY, z, radius * Math.SQRT1_2, height)
				if (t < aimT) {
					aimT = t
					targetActorId = frozen.id[i]
					targetFrozen = true
					continue
				}
			}
			if (aimT < Infinity) continue
			const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15]
			if (cw <= 0) continue
			const sx = ((vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / cw * .5 + .5) * viewW
			const sy = (.5 - (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / cw * .5) * viewH
			const radiusPx = Math.max(TARGET_RADIUS_PX,
				projectedDistancePx(vp, x + radius, y, z, sx, sy, viewW, viewH),
				projectedDistancePx(vp, x, y, z + radius, sx, sy, viewW, viewH),
				projectedDistancePx(vp, x, groundY, z, sx, sy, viewW, viewH),
				projectedDistancePx(vp, x, groundY + height, z, sx, sy, viewW, viewH))
			const score = ((sx - pointer.x) ** 2 + (sy - pointer.y) ** 2) / (radiusPx * radiusPx)
			if (score >= bestScore) continue
			bestScore = score
			targetActorId = frozen.id[i]
			targetFrozen = true
		}
		// The order's cell is where the pointer meets its target, not the ground the ray reaches
		// behind it: under a tall building's roof that ground is on the building's far side, and a
		// unit with no order of its own on the actor (a spy at a construction yard) falls back to a
		// move to this cell, so it walked round to the other side.
		let cellX = cell.x, cellY = cell.y
		this.intentAim = null
		if (aimT < Infinity) {
			const ax = POINTER_RAY.ox + POINTER_RAY.dx * aimT, az = POINTER_RAY.oz + POINTER_RAY.dz * aimT
			const world = ctx.snapshot?.world
			cellX = Math.floor(ax)
			cellY = Math.floor(az)
			if (world && world.boundsRight > world.boundsLeft && world.boundsBottom > world.boundsTop) {
				cellX = clamp(cellX, world.boundsLeft, world.boundsRight - 1)
				cellY = clamp(cellY, world.boundsTop, world.boundsBottom - 1)
			}
			this.intentAim = { x: ax, z: az }
		}
		return { subjectIds: this.commandSubjects, subjectCount, targetActorId, targetFrozen,
			targetCellX: cellX, targetCellY: cellY, modifiers }
	}

	private contextOrderKey(ctx: Ctx, intent: ContextOrderIntent): string {
		return `${ctx.snapshot?.tick}:${this.selected.join(',')}:${intent.targetActorId}:${intent.targetFrozen}:${intent.targetCellX}:${intent.targetCellY}:${intent.modifiers}`
	}

	private previewContext(ctx: Ctx, intent: ContextOrderIntent): ContextOrderPreview | null {
		// Refresh on simulation state, selection, target or modifiers; stationary mouse
		// frames between simulation ticks reuse the pure engine answer. The host bridge
		// answers a postMessage round trip later, so the previous verdict keeps steering
		// the cursor until the fresh one lands — one worker-queue latency, not a frame.
		const key = this.contextOrderKey(ctx, intent)
		if (key !== this.contextPreviewKey) {
			this.contextPreviewKey = key
			this.contextPreviewResolvedKey = null
			Promise.resolve(ctx.queryContextOrder(intent))
				.then(preview => {
					if (this.contextPreviewKey !== key) return
					this.contextPreview = preview
					this.contextPreviewResolvedKey = key
				})
				.catch(() => {
					// Unknown must never block: drop the verdict instead of keeping the old one.
					if (this.contextPreviewKey === key) {
						this.contextPreview = null
						this.contextPreviewResolvedKey = null
					}
				})
		}
		return this.contextPreview
	}

	private issuePointerContextOrder(ctx: Ctx, actors: NonNullable<Snapshot['actors']>, units: UnitsApi,
		modifiers: number, actorActionOnly: boolean): boolean {
		const intent = this.pointerContextIntent(ctx, actors, units, modifiers)
		if (!intent) return false
		const feedback = actionFeedback(this.previewContext(ctx, intent))
		if (actorActionOnly && (!intent.targetActorId || !feedback?.actorAction)) return false
		// A 'blocked' verdict only refuses the order when it was computed for exactly
		// this intent; a stale preview (previous selection epoch, in-flight refresh)
		// must never eat the click — the host targeter stays authoritative.
		if (feedback?.blocked && this.contextPreviewResolvedKey === this.contextOrderKey(ctx, intent)) return false
		const cell = { x: intent.targetCellX, y: intent.targetCellY }
		const reply = ctx.issueOrder({ orderString: 'Contextual', contextual: true,
			subjectIds: intent.subjectIds, subjectCount: intent.subjectCount,
			targetActorId: intent.targetActorId, targetFrozen: intent.targetFrozen,
			targetCell: cell, modifiers })
		const leadType = this.actorTypeAt(actors, intent.subjectIds[0])
		const leadName = ctx.actorTypeName(leadType)
		// Everything the player hears or sees about this order waits for OpenRA's answer: a
		// voice and a move marker for an order the simulation refused is the "they answer but
		// do not move" report. The aim point is taken now, where the click was.
		const pointer = ctx.input.pointer
		// On a target, the aim point is where the pointer met it; on the ground, the ground.
		const point = this.intentAim ?? ctx.get<CameraApi>('camera').pickGroundPoint(pointer.x, pointer.y, ctx)
		const reachable = intent.targetActorId !== 0 || this.selectionCanReach(cell.x, cell.y, actors, intent.subjectCount ?? 0)
		const rallySubject = !intent.targetActorId && intent.subjectCount === 1 && units.hasRaTrait(leadName, 'RallyPoint')
			? intent.subjectIds[0] : 0
		this.orderAction = feedback
		const trace = ORDER_TRACE ? this.startOrderTrace(ctx, actors, intent, cell, point, feedback, modifiers) : null
		void Promise.resolve(reply).then(result => {
			if (trace) trace.reply = typeof result === 'string' ? result : String(result)
			if (typeof result === 'string' && !/^ok\b/.test(result)) {
				this.showNotice(/^ignored/.test(result) ? 'Geen geldig bevel voor deze plek' : 'Bevel geweigerd')
				return
			}
			if (!units.hasRaTrait(leadName, 'Building'))
				this.eva?.sayUnit(feedback?.attack ? 'attack' : 'move', units.movementClass(leadType), this.eva?.personaOf(leadName))
			if (rallySubject) this.rallyPoints.set(rallySubject, { x: cell.x + .5, z: cell.y + .5 })
			this.markOrder(point?.x ?? cell.x + .5, point?.z ?? cell.y + .5, reachable, feedback?.attack)
			if (feedback && feedback.label !== 'Attack') this.showNotice(feedback.label)
		})
		return true
	}

	/**
	 * Dev-only order trace (vfx.md Epic 2, `?ordertrace=1`): pointer CSS position, canvas size and
	 * DPR, the camera, the picked ground point and cell, the target actor, the modifiers, OpenRA's
	 * preview and the issued order. The bridge's reply lands on the record, and the first frame a
	 * subject moves (or 250 ticks without) logs it. Nothing is logged without the flag.
	 */
	private startOrderTrace(ctx: Ctx, actors: NonNullable<Snapshot['actors']>,
		intent: { readonly subjectIds: ArrayLike<number>; readonly subjectCount?: number; readonly targetActorId?: number; readonly targetFrozen?: boolean },
		cell: { x: number; y: number }, point: { x: number; z: number } | null, feedback: ActionFeedback | null, modifiers: number): Record<string, unknown> {
		const pointer = ctx.input.pointer
		const camera = ctx.get<CameraApi>('camera') as unknown as { yaw?: number; pitch?: number; distance?: number }
		const subject = intent.subjectIds[0] ?? 0
		const i = findActorIndex(actors, subject)
		const record: Record<string, unknown> = {
			tick: ctx.snapshot?.tick ?? 0,
			pointer: { x: pointer.x, y: pointer.y },
			canvasCss: { width: canvasCssWidth(ctx), height: canvasCssHeight(ctx) },
			dpr: typeof devicePixelRatio === 'number' ? devicePixelRatio : 1,
			camera: { yaw: camera.yaw, pitch: camera.pitch, distance: camera.distance },
			groundPoint: point ? { x: point.x, z: point.z } : null,
			cell,
			targetActorId: intent.targetActorId ?? 0,
			targetFrozen: intent.targetFrozen ?? false,
			modifiers,
			preview: feedback ? { label: feedback.label, attack: feedback.attack, blocked: feedback.blocked, actorAction: feedback.actorAction } : null,
			subjects: Array.from(intent.subjectIds).slice(0, intent.subjectCount ?? intent.subjectIds.length),
		}
		if (i >= 0) this.orderTrace = { issuedTick: ctx.snapshot?.tick ?? 0, subject, x: actors.posX[i], y: actors.posY[i], record }
		else console.debug('[ordertrace]', JSON.stringify(record))
		return record
	}

	private updateSelectionInteraction(
		ctx: Ctx,
		actors: NonNullable<Snapshot['actors']>,
		units: UnitsApi,
		placedThisFrame: boolean,
	): void {
		const pointer = ctx.input.pointer
		if (placedThisFrame || this.pendingPlacement !== null) {
			this.cancelSelectionDrag()
			return
		}
		// Sell targeting consumes canvas clicks while armed: the same click that aims a sell
		// must never also rip the selection out from under the player.
		if (this.sellMode) {
			this.updateSellTargeting(ctx, actors, units)
			return
		}
		// Attack-move aiming consumes left clicks the same way: the click sends the order,
		// it never reselects.
		if (this.attackMoveArmed) {
			this.updateAttackMoveTargeting(ctx, actors)
			return
		}
		if (this.guardArmed) {
			this.updateGuardTargeting(ctx, actors, units)
			return
		}
		// Support-power aiming consumes left clicks identically: fire at the pick, never
		// reselect.
		if (this.supportPowerArmed !== null) {
			this.updateSupportPowerTargeting(ctx)
			return
		}

		const viewW = Math.max(1, canvasCssWidth(ctx))
		const viewH = Math.max(1, canvasCssHeight(ctx))
		const px = clamp(pointer.x, 0, viewW)
		const py = clamp(pointer.y, 0, viewH)
		if ((pointer.pressed & 1) !== 0 && pointer.inside) {
			this.selecting = true
			this.selectionDragged = false
			this.selectionStartX = px
			this.selectionStartY = py
		}
		if (!this.selecting) {
			this.hideSelectionBox()
			return
		}

		const dragX = px - this.selectionStartX
		const dragY = py - this.selectionStartY
		if (!this.selectionDragged && Math.hypot(dragX, dragY) >= DRAG_SELECT_THRESHOLD_PX)
			this.selectionDragged = true
		if (this.selectionDragged && (pointer.buttons & 1) !== 0)
			this.renderSelectionBox(this.selectionStartX, this.selectionStartY, px, py, viewW, viewH)

		if ((pointer.released & 1) === 0) return
		const dragged = this.selectionDragged
		this.selecting = false
		this.selectionDragged = false
		this.hideSelectionBox()
		const modifiers = this.selectModifiers !== MODIFIERS_NO_PRESS
			? this.selectModifiers : this.pointerModifiers(ctx)
		const additive = (modifiers & 2) !== 0
		this.selectModifiers = MODIFIERS_NO_PRESS
		// A click on an eligible action target preserves the selected command subjects.
		// Drag selection and shift-click selection keep their established behaviour.
		if (!dragged && !additive && pointer.inside &&
			this.issuePointerContextOrder(ctx, actors, units, modifiers, true)) return
		if (!additive) this.selected.length = 0

		const vp = this.render?.camera.viewProj
		if (!vp) return
		if (dragged) {
			const minX = Math.min(this.selectionStartX, px)
			const maxX = Math.max(this.selectionStartX, px)
			const minY = Math.min(this.selectionStartY, py)
			const maxY = Math.max(this.selectionStartY, py)
			for (let i = 0; i < actors.count && this.selected.length < MAX_SELECTION; i++) {
				if (actors.owner[i] !== this.renderPlayerId) continue
				const actorName = ctx.actorTypeName(actors.typeId[i])
				if (!units.groupSelectable(actorName)) continue
				const screen = projectActorCentre(vp, actors, i, units, this.terrain, viewW, viewH)
				if (!screen || screen.x < minX || screen.x > maxX || screen.y < minY || screen.y > maxY) continue
				if (!this.selected.includes(actors.id[i])) this.selected.push(actors.id[i])
			}
		} else {
			const hit = pickActorAt(vp, actors, units, this.terrain, px, py, viewW, viewH, ctx.actorTypeName, false, this.render?.camera.position)
			// Scenery carries no Selectable trait in the authoritative manifest: a click on
			// a tree or rock is answered the same way as a click on bare ground — it clears
			// (above) and adds nothing, with no selection and no HUD notice.
			if (hit >= 0 && units.hasRaTrait(ctx.actorTypeName(actors.typeId[hit]), 'Selectable') &&
				!this.selected.includes(actors.id[hit])) this.selected.push(actors.id[hit])
		}
		ctx.get<CameraApi>('camera').selectActors(this.selected)
		this.refreshSelectionArmed(ctx)
		// Select acknowledgement: the first selected unit speaks its class line. Buildings
		// stay silent — only mobile units answer a click in the classic RTS cadence.
		if (this.selected.length > 0) {
			const leadId = this.selected[0]
			for (let i = 0; i < actors.count; i++) {
				if (actors.id[i] !== leadId) continue
				const name = ctx.actorTypeName(actors.typeId[i])
				// Character identity selects the dedicated voice, independent of player faction.
				if (!units.hasRaTrait(name, 'Building')) this.eva?.sayUnit('select', units.movementClass(actors.typeId[i]), this.eva?.personaOf(name))
				break
			}
		}
	}

	private renderSelectionBox(x0: number, y0: number, x1: number, y1: number, width: number, height: number): void {
		const overlay = this.placementOverlay
		const box = this.selectionBox
		if (!overlay || !box) return
		overlay.setAttribute('viewBox', `0 0 ${width} ${height}`)
		overlay.style.display = ''
		box.style.display = ''
		box.setAttribute('x', String(Math.min(x0, x1)))
		box.setAttribute('y', String(Math.min(y0, y1)))
		box.setAttribute('width', String(Math.abs(x1 - x0)))
		box.setAttribute('height', String(Math.abs(y1 - y0)))
	}

	private hideSelectionBox(): void {
		if (this.selectionBox) this.selectionBox.style.display = 'none'
		if (this.pendingPlacement === null && this.placementOverlay) this.placementOverlay.style.display = 'none'
	}

	private cancelSelectionDrag(): void {
		this.selecting = false
		this.selectionDragged = false
		this.selectModifiers = MODIFIERS_NO_PRESS
		this.hideSelectionBox()
	}

	/** Query only on placement-input changes, then draw the returned authoritative footprint. */
	private updatePlacementPreview(ctx: Ctx): boolean {
		const pending = this.pendingPlacement
		const render = this.render
		const terrain = this.terrain
		if (!pending || !render || !terrain) {
			this.hidePlacementOverlay()
			return false
		}
		if (ctx.input.wasPressed('Escape') || (ctx.input.pointer.pressed & 4) !== 0) {
			this.cancelPlacement()
			// The cancel gesture belongs to placement; it must not also move the selection.
			return true
		}
		const pointer = ctx.input.pointer
		if (!pointer.inside) {
			this.hidePlacementOverlay()
			return false
		}
		const camera = ctx.get<CameraApi>('camera')
		const cell = camera.pickGroundCell(pointer.x, pointer.y, ctx)
		if (!cell) {
			this.hidePlacementOverlay()
			return false
		}
		const units = ctx.get<UnitsApi>('units')
		const modifiers = ctx.input.shift ? 1 : 0
		const request = {
			queueId: pending.queueId,
			actorType: pending.actorName,
			cellX: cell.x,
			cellY: cell.y,
			variant: pending.variant,
			modifiers,
		}
	const key = `${pending.queueId}:${pending.actorName}:${cell.x}:${cell.y}:${pending.variant}:${modifiers}`
	if (key !== this.placementQueryKey) {
		this.placementQueryKey = key
		// Stale-while-fresh: the authoritative footprint from the previous query keeps
		// drawing while the new one crosses the worker boundary.
		Promise.resolve(ctx.placement.query(request))
			.then(result => {
				if (this.placementQueryKey !== key) return
				this.placementResult = result
				this.updatePlacementHud()
			})
			.catch(() => { /* keep the previous footprint */ })
	}

	if ((pointer.pressed & 1) !== 0 && ctx.placement.available) {
		// The click belongs to placement mode, consumed either way. The authoritative
		// verdict (and the mode exit on success) arrives with the worker round trip.
		Promise.resolve(ctx.placement.place(request))
			.then(result => {
				if (this.pendingPlacement !== pending) return
				if (result?.issued) {
					// Placement itself is silent now: "Building" belongs to the production
					// start in the build menu, "Construction complete" to the 100% event.
					if (units.hasRaTrait(pending.actorName, 'LineBuild')) this.lineAnchorCell = cell
					else this.cancelPlacement()
					return
				}
				// Invalid/stale/not-ready clicks deliberately keep placement mode active and
				// show the result of the click-time revalidation.
				this.placementResult = result
				this.updatePlacementHud()
			})
			.catch(() => { /* mode stays active on transport errors */ })
		return true
	}
	if (this.lineAnchorCell !== null && (pointer.released & 1) !== 0) {
		const anchor = this.lineAnchorCell
		this.lineAnchorCell = null
		const line = this.placementLine(anchor, cell)
		// Segments must land in order: line build is one producer queue.
		void (async () => {
			let issued = 1
			for (const c of line) {
				const segment = await ctx.placement.place({ queueId: pending.queueId, actorType: pending.actorName, cellX: c.x, cellY: c.y, variant: pending.variant, modifiers })
				if (segment?.issued) issued++
			}
			this.showNotice(`Muur geplaatst · ${issued} segmenten`)
		})().catch(() => { /* the anchor is already consumed */ })
		if (!ctx.input.shift) this.cancelPlacement()
		return true
	}
		const result = this.placementResult
		if (!result) {
			this.hidePlacementOverlay()
			return false
		}
		const visual = ctx.get<UnitsApi>('units').placementVisual(pending.actorName)
		const centerX = result.topLeft.x + result.dimensions.x * 0.5
		const centerZ = result.topLeft.y + result.dimensions.y * 0.5
		const waterLevel = visual?.water ? terrain.waterHeightAt(centerX, centerZ) : null
		const centerY = waterLevel ?? terrain.heightAt(centerX, centerZ)
		if (visual) {
			identityAt(this.placementModelInstances, centerX, centerY, centerZ)
			this.placementModelColors[0] = this.renderPlayerId
			if (!this.placementModelItem || this.placementModelItem.mesh !== visual.mesh) {
				this.placementModelItem = {
					mesh: visual.mesh,
					surfaceSet: visual.surfaceSet,
					instances: this.placementModelInstances,
					instanceCount: 1,
					playerColors: this.placementModelColors,
					opacity: 0.34,
					castsShadow: false,
				}
			}
			render.submit(this.placementModelItem)
		}

		const ring = this.placementRingItem
		if (ring) {
			const ringX = cell.x + 0.5
			const ringZ = cell.y + 0.5
			const ringY = (visual?.water ? terrain.waterHeightAt(ringX, ringZ) : null) ?? terrain.heightAt(ringX, ringZ)
			identityAt(this.placementRingInstances, ringX, ringY + 0.035, ringZ)
			this.placementRingColors[0] = this.renderPlayerId
			render.submit(ring)
		}
		this.renderPlacementCells(result, ctx, visual?.water ?? false)
		return false
	}

	private renderPlacementCells(result: PlacementResult, ctx: Ctx, water: boolean): void {
		const overlay = this.placementOverlay
		const render = this.render
		const terrain = this.terrain
		if (!overlay || !render || !terrain) return
		const width = canvasCssWidth(ctx)
		const height = canvasCssHeight(ctx)
		overlay.setAttribute('viewBox', `0 0 ${width} ${height}`)
		overlay.style.display = ''
		const vp = render.camera.viewProj
		let drawn = 0
		for (const cell of result.cells) {
			if (drawn >= this.placementPolygons.length) break
			const corners = [[cell.x, cell.y], [cell.x + 1, cell.y], [cell.x + 1, cell.y + 1], [cell.x, cell.y + 1]] as const
			const points: string[] = []
			let visible = true
			for (const corner of corners) {
				const x = corner[0]
				const z = corner[1]
				const y = (water ? terrain.waterHeightAt(x, z) : null) ?? terrain.heightAt(x, z)
				const previewY = y + 0.045
				const cw = vp[3] * x + vp[7] * previewY + vp[11] * z + vp[15]
				if (cw <= 0) { visible = false; break }
				const clipX = (vp[0] * x + vp[4] * previewY + vp[8] * z + vp[12]) / cw
				const clipY = (vp[1] * x + vp[5] * previewY + vp[9] * z + vp[13]) / cw
				points.push(`${((clipX * 0.5 + 0.5) * width).toFixed(1)},${((0.5 - clipY * 0.5) * height).toFixed(1)}`)
			}
			if (!visible) continue
			const polygon = this.placementPolygons[drawn++]
			polygon.style.display = ''
			polygon.setAttribute('points', points.join(' '))
			polygon.setAttribute('fill', cell.valid ? 'rgba(35,220,95,0.34)' : 'rgba(245,55,55,0.38)')
			polygon.setAttribute('stroke', cell.valid ? 'rgba(105,255,155,0.95)' : 'rgba(255,120,110,0.98)')
		}
		for (let i = drawn; i < this.placementPolygons.length; i++) this.placementPolygons[i].style.display = 'none'
		this.placementPolygonsDrawn = drawn
	}

	private hidePlacementOverlay(): void {
		for (let i = 0; i < this.placementPolygonsDrawn; i++) this.placementPolygons[i].style.display = 'none'
		this.placementPolygonsDrawn = 0
		if (this.selectionBox?.style.display === 'none' && this.placementOverlay)
			this.placementOverlay.style.display = 'none'
	}

	private cancelPlacement(): void {
		this.pendingPlacement = null
		this.lineAnchorCell = null
		this.placementResult = null
		this.placementQueryKey = ''
		this.placementModelItem = null
		this.hidePlacementOverlay()
		this.updatePlacementHud()
	}

	/** Cells of a wall run: anchor to target along the dominant axis, both ends included. */
	private placementLine(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number }[] {
		const dx = b.x - a.x
		const dy = b.y - a.y
		const steps = Math.max(Math.abs(dx), Math.abs(dy))
		const cells: { x: number; y: number }[] = []
		for (let s = 1; s <= steps; s++) {
			cells.push({
				x: a.x + Math.round(dx * s / steps),
				y: a.y + Math.round(dy * s / steps),
			})
		}
		return cells
	}

	dispose(): void {
		this.hudQueues?.removeEventListener('click', this.onHudClick)
		this.hudQueues?.removeEventListener('contextmenu', this.onHudContext)
		this.hudQueues?.removeEventListener('auxclick', this.onHudAux)
		this.hudReady?.removeEventListener('click', this.onReadyClick)
		this.hudPause?.removeEventListener('click', this.onPauseClick)
		this.menuMusic?.removeEventListener('click', this.onMusicClick)
		this.musicVolDown?.removeEventListener('click', this.onMusicVolDown)
		this.musicVolUp?.removeEventListener('click', this.onMusicVolUp)
		this.hudDeploy?.removeEventListener('click', this.onDeployClick)
		this.hudRepair?.removeEventListener('click', this.onRepairClick)
		this.hudPrimary?.removeEventListener('click', this.onPrimaryClick)
		this.hudBuy?.removeEventListener('click', this.onBuyClick)
		this.hudSell?.removeEventListener('click', this.onSellClick)
		this.hudMinimise?.removeEventListener('click', this.onHudMinimise)
		window.removeEventListener('keydown', this.onHudKey)
		this.sessionStart?.removeEventListener('click', this.onSessionStart)
		this.sessionMap?.removeEventListener('change', this.onSessionMapChange)
		this.sessionQuality?.removeEventListener('change', this.onSessionQualityChange)
		this.sessionMountains?.removeEventListener('change', this.onSessionMountainsChange)
		this.outcomeRestart?.removeEventListener('click', this.onOutcomeRestart)
		this.minimap?.removeEventListener('pointerdown', this.onMinimapPointerDown)
		this.minimap?.removeEventListener('contextmenu', this.onMinimapContext)
		this.sessionSlots?.removeEventListener('change', this.onSlotChange)
		this.sessionComposition = null
		this.hudOpponents = null
		this.botsAtStart = 0
		this.hudDaylight?.removeEventListener('click', this.onDaylightClick)
		this.hudCamera?.removeEventListener('pointerdown', this.onCameraPointerDown)
		this.hudCamera?.removeEventListener('pointerup', this.onCameraRelease)
		this.hudCamera?.removeEventListener('pointercancel', this.onCameraRelease)
		this.hudCamera?.removeEventListener('pointerleave', this.onCameraRelease)
		globalThis.removeEventListener('blur', this.onWindowBlur)
		this.releaseCameraControls()
		this.hudDaylight = null
		this.hudCamera = null
		this.edgeHints[0] = this.edgeHints[1] = this.edgeHints[2] = this.edgeHints[3] = null
		this.lastEdgeMask = -1
		this.lastDaylightMode = ''
		this.orderMarker.active = false
		this.orderMarkerRing = null
		this.orderMarkerDot = null
		this.orderMarkerReticle = null
		this.rallyPoints.clear()
		this.groupMembers.clear()
		this.attackMoveArmed = false
		this.guardArmed = false
		this.selectionArmed = false
		this.supportPowerArmed = null
		this.supportPowerSource = null
		this.hudSupportList?.removeEventListener('click', this.onHudClick)
		this.hudSupport = null
		this.hudSupportList = null
		if (this.hudTimers) this.hudTimers.hidden = true
		this.hudTimers = null
		this.timersSig = ''
		this.timersStatus = null
		this.timerStates.clear()
		this.announcedLaunches.clear()
		this.supportBeacons.length = 0
		this.orderTrace = null
		this.hoverMarkBack = null
		this.hoverMark = null
		this.hoverCursor = ''
		this.passability = new Uint8Array(0)
		this.passabilityW = 0
		this.passabilityH = 0
		this.commandCanvas?.removeEventListener('pointerdown', this.onCanvasPointerDown)
		this.commandCanvas?.removeEventListener('pointerup', this.onCanvasPointerUp)
		this.commandCanvas = null
		this.offProduced?.()
		this.offUnitLost?.()
		this.offFire?.()
		this.selectModifiers = MODIFIERS_NO_PRESS
		this.placementOverlay?.remove()
		this.selectionBox = null
		this.placementPolygons.length = 0
		this.placementPolygonsDrawn = 0
		this.offProduced = null
		if (this.hudRoot) this.hudRoot.hidden = true
		this.selected.length = 0
		this.queueDom.length = 0
		this.pendingBaseFocus = false
		this.minimap2d = null
		this.minimapBase = null
		this.minimapBase2d = null
		this.compass2d = null
		this.combatMarks.clear()
		this.friendlyRingItem = this.hostileRingItem = this.disguiseRingItem = null
		this.ring = null
		this.item = null
	}

	private bindHud(): void {
		if (typeof document === 'undefined') return
		this.hudRoot = document.getElementById('game-ui')
		this.hudCash = document.getElementById('hud-cash')
		this.hudResources = document.getElementById('hud-resources')
		this.hudHarvesters = document.getElementById('hud-harvesters')
		this.hudOpponents = document.getElementById('hud-opponents')
		this.hudPowerFill = document.getElementById('hud-power-fill')
		this.hudPower = document.getElementById('hud-power')
		this.hudAlert = document.getElementById('hud-alert')
		this.hudProductionTitle = document.getElementById('hud-production-title')
		this.hudQueues = document.getElementById('hud-queues')
		this.hudReady = document.getElementById('hud-ready')
		this.hudReadyList = document.getElementById('hud-ready-list')
		this.hudSelectionName = document.getElementById('hud-selection-name')
		this.hudSelectionDetail = document.getElementById('hud-selection-detail')
		this.hudHealth = document.querySelector('#hud-health > i')
		this.hudDeploy = document.getElementById('hud-deploy') as HTMLButtonElement | null
		this.hudPrimary = document.getElementById('hud-primary') as HTMLButtonElement | null
		this.hudRepair = document.getElementById('hud-repair') as HTMLButtonElement | null
		this.hudPause = document.getElementById('hud-pause') as HTMLButtonElement | null
		this.hudBuy = document.getElementById('hud-buy') as HTMLButtonElement | null
		this.hudSell = document.getElementById('hud-sell') as HTMLButtonElement | null
		this.hudPlacement = document.getElementById('hud-placement')
		this.hudNotice = document.getElementById('hud-notice')
		this.hudMinimise = document.getElementById('hud-minimise') as HTMLButtonElement | null
		this.simAlarm = document.getElementById('sim-alarm')
		this.hudWaterStatus = document.getElementById('hud-water-status')
		this.minimap = document.getElementById('hud-minimap') as HTMLCanvasElement | null
		this.minimap2d = this.minimap?.getContext('2d') ?? null
		this.compass = document.getElementById('hud-compass') as HTMLCanvasElement | null
		this.compass2d = this.compass?.getContext('2d') ?? null
		this.compassHeading = NaN
		this.tacticalRoot = document.getElementById('tactical-map')
		this.tacticalCanvas = document.getElementById('tactical-canvas') as HTMLCanvasElement | null
		this.tactical2d = this.tacticalCanvas?.getContext('2d') ?? null
		this.sessionRoot = document.getElementById('session-ui')
		this.sessionStatus = document.getElementById('session-status')
		this.sessionModeState = document.getElementById('session-mode-state')
		this.sessionAccount = document.getElementById('session-account') as HTMLButtonElement | null
		this.accountRoot = document.getElementById('account-ui')
		this.accountStatusLine = document.getElementById('account-status')
		this.accountSignedOut = document.getElementById('account-signed-out')
		this.accountSignedIn = document.getElementById('account-signed-in')
		this.accountLoginForm = document.getElementById('account-login-form') as HTMLFormElement | null
		this.accountGuestForm = document.getElementById('account-guest-form') as HTMLFormElement | null
		this.accountRegisterForm = document.getElementById('account-register-form') as HTMLFormElement | null
		this.accountUpgradeForm = document.getElementById('account-upgrade-form') as HTMLFormElement | null
		this.accountUpgradeRoot = document.getElementById('account-upgrade')
		this.accountRegisterToggle = document.getElementById('account-register-toggle') as HTMLButtonElement | null
		this.accountDeviceButton = document.getElementById('account-device-login') as HTMLButtonElement | null
		this.accountDeviceRow = document.getElementById('account-device-row')
		this.accountSeparator = document.getElementById('account-separator')
		this.accountProfileForm = document.getElementById('account-profile-form') as HTMLFormElement | null
		this.accountClose = document.getElementById('account-close') as HTMLButtonElement | null
		this.accountLogoutButton = document.getElementById('account-logout') as HTMLButtonElement | null
		this.accountVerifyButton = document.getElementById('account-verify') as HTMLButtonElement | null
		this.bindAccountUi()
		const shellBridge = (globalThis as Record<string, unknown>).redline as { accountOrigin?: unknown } | undefined
		if (typeof shellBridge?.accountOrigin === 'string') configureAccountOrigin(shellBridge.accountOrigin)
		this.sessionStart = document.getElementById('session-start') as HTMLButtonElement | null
		this.sessionMap = document.getElementById('session-map') as HTMLSelectElement | null
		this.sessionSpeed = document.getElementById('session-speed') as HTMLSelectElement | null
		this.sessionQuality = document.getElementById('session-quality') as HTMLSelectElement | null
		this.sessionMountains = document.getElementById('session-mountains') as HTMLSelectElement | null
		this.sessionQualityNote = document.getElementById('session-quality-note')
		this.hudQuality = document.getElementById('hud-quality')
		this.renderQualityChoice()
		this.renderMountainChoice()
		this.sessionSlots = document.getElementById('session-slots')
		this.sessionSlots?.addEventListener('change', this.onSlotChange)
		this.sessionComposition = document.getElementById('session-composition')
		this.sessionMpStatus = document.getElementById('session-mp-status')
		this.sessionMpMode = document.getElementById('session-mp-mode')
		this.rankedQueueRoot = document.getElementById('session-mp-ranked')
		this.rankedQueueButton = document.getElementById('session-ranked-queue') as HTMLButtonElement | null
		this.rankedCancelButton = document.getElementById('session-ranked-cancel') as HTMLButtonElement | null
		this.rankedStatus = document.getElementById('session-ranked-status')
		this.rankedQueueButton?.addEventListener('click', () => void this.startRankedQueue())
		this.rankedCancelButton?.addEventListener('click', () => void this.cancelRankedQueue())
		// T5.1/T5.2: the browser fetches /steelseed/net-config.json (§5.1); the
		// shell never does. Fail closed: until it resolves the browser is `off`,
		// so no relay request can fire on a slow or missing config.
		if (!('redline' in window)) {
			void loadNetConfig().then(cfg => {
				this.netConfig = cfg
				configureAccountOrigin(cfg.accountOrigin)
				this.accountOriginKnown = true
				this.applyMpSwitch()
				this.updateAccountGate()
				void this.joinFromLink()
			})
		}
		this.updateAccountGate()
		this.mpPlayers = document.getElementById('mp-players')
		this.sessionMpName = document.getElementById('session-mp-name') as HTMLInputElement | null
		this.sessionMpName?.addEventListener('input', () => { this.mpNameTouched = true })
		this.sessionMpRoomName = document.getElementById('session-mp-roomname') as HTMLInputElement | null
		this.sessionMpSlots = document.getElementById('session-mp-slots') as HTMLSelectElement | null
		this.mpSetup = document.getElementById('mp-setup')
		this.mpSlotsEl = document.getElementById('mp-slots')
		this.mpHostOptionsEl = document.getElementById('mp-host-options')
		this.sessionMpRoomsBody = document.getElementById('session-mp-rooms-body')
		this.lanRoomsSection = document.getElementById('session-mp-lan')
		this.mpLanLookup = document.getElementById('session-mp-lan-lookup')
		this.mpLanLookupNote = document.getElementById('session-mp-lan-note')
		this.mpLanAddressForm = document.getElementById('session-mp-address-form') as HTMLFormElement | null
		this.mpLanAddressInput = document.getElementById('session-mp-address') as HTMLInputElement | null
		this.mpLanAddressForm?.addEventListener('submit', this.onMpAddressSubmit)
		this.mpHostDialog = document.getElementById('mp-host-dialog')
		this.mpHostVisLan = document.getElementById('mp-host-vis-lan') as HTMLInputElement | null
		this.mpHostVisPublic = document.getElementById('mp-host-vis-public') as HTMLInputElement | null
		this.mpHostOnlineNote = document.getElementById('mp-host-online-note')
		this.mpHostPlayers = document.getElementById('mp-host-players') as HTMLSelectElement | null
		this.mpHostPassword = document.getElementById('mp-host-password') as HTMLInputElement | null
		document.getElementById('mp-host-cancel')?.addEventListener('click', () => this.closeMpHostDialog())
		document.getElementById('mp-host-create')?.addEventListener('click', () => void this.mpHostFromDialog())
		this.lanRoomsBody = document.getElementById('session-mp-lan-body')
		this.sessionTabSkirmish = document.getElementById('session-tab-skirmish') as HTMLButtonElement | null
		this.sessionTabMp = document.getElementById('session-tab-mp') as HTMLButtonElement | null
		this.sessionSkirmishPanel = document.getElementById('session-skirmish-panel')
		this.sessionMpPanel = document.getElementById('session-mp-panel')
		this.sessionCopySkirmish = document.getElementById('session-copy-skirmish')
		this.sessionCopyMp = document.getElementById('session-copy-mp')
		this.sessionMpHost = document.getElementById('session-mp-host') as HTMLButtonElement | null
		this.sessionMpHost?.addEventListener('click', this.onMpHost)
		this.sessionTabSkirmish?.addEventListener('click', () => this.selectSessionTab('skirmish'))
		this.sessionTabMp?.addEventListener('click', () => this.selectSessionTab('mp'))
		this.sessionOptions = document.getElementById('session-options')
		this.bindSetupConsole()
		this.outcomeRoot = document.getElementById('outcome-ui')
		this.outcomeTitle = document.getElementById('outcome-title') as HTMLHeadingElement | null
		this.outcomeMode = document.getElementById('outcome-mode')
		this.outcomeSettlement = document.getElementById('outcome-settlement')
		this.outcomeCopy = document.getElementById('outcome-copy')
		this.hudMenu = document.getElementById('hud-menu') as HTMLButtonElement | null
		this.hudMenu?.addEventListener('click', this.onMenuClick)
		// Return to main reloads the page, which is the clean path back to the lobby: the
		// engine host tears down with the page and the lobby rebuilds from the catalog.
		this.gameMenuRoot = document.getElementById('game-menu')
		this.copyrightModal = document.getElementById('copyright-modal')
		document.getElementById('menu-resume')?.addEventListener('click', () => this.closeGameMenu())
		document.getElementById('menu-main')?.addEventListener('click', () => this.returnToMainMenu())
		document.getElementById('outcome-main')?.addEventListener('click', () => this.returnToMainMenu())
		this.menuRestart = document.getElementById('menu-restart') as HTMLButtonElement | null
		this.menuRestart?.addEventListener('click', () => this.onMenuRestart())
		document.getElementById('menu-exit')?.addEventListener('click', () => {
			window.close()
			const kicker = this.gameMenuRoot?.querySelector('.screen-kicker')
			if (kicker) kicker.textContent = 'Close the browser tab to exit the game.'
		})
		document.getElementById('menu-copyright')?.addEventListener('click', () => {
			if (this.copyrightModal) this.copyrightModal.hidden = false
		})
		document.getElementById('menu-tutorial')?.addEventListener('click', () => {
			this.closeGameMenu()
			this.startTutorial()
		})
		document.getElementById('copyright-close')?.addEventListener('click', () => {
			if (this.copyrightModal) this.copyrightModal.hidden = true
		})
		const copyrightSheet = this.copyrightModal
		copyrightSheet?.addEventListener('pointerdown', event => {
			if (event.target === copyrightSheet) copyrightSheet.hidden = true
		})
		this.outcomeRestart = document.getElementById('outcome-restart') as HTMLButtonElement | null
		this.hudQueues?.addEventListener('click', this.onHudClick)
		this.hudQueues?.addEventListener('contextmenu', this.onHudContext)
		this.hudQueues?.addEventListener('auxclick', this.onHudAux)
		this.hudReady?.addEventListener('click', this.onReadyClick)
		this.hudSupport = document.getElementById('hud-support')
		this.hudSupportList = document.getElementById('hud-support-list')
		this.hudTimers = document.getElementById('hud-timers')
		this.hudSupportList?.addEventListener('click', this.onHudClick)
		// The pause-menu music controls: bound here because the menu markup loads with
		// the HUD, and a lost binding here meant toggling music gave no visible state.
		this.menuMusic = document.getElementById('menu-music') as HTMLButtonElement | null
		this.musicVolDown = document.getElementById('music-vol-down') as HTMLButtonElement | null
		this.musicVolUp = document.getElementById('music-vol-up') as HTMLButtonElement | null
		this.menuMusic?.addEventListener('click', this.onMusicClick)
		this.musicVolDown?.addEventListener('click', this.onMusicVolDown)
		this.musicVolUp?.addEventListener('click', this.onMusicVolUp)
		this.hudPause?.addEventListener('click', this.onPauseClick)
		this.hudDeploy?.addEventListener('click', this.onDeployClick)
		this.hudRepair?.addEventListener('click', this.onRepairClick)
		this.hudPrimary?.addEventListener('click', this.onPrimaryClick)
		this.hudBuy?.addEventListener('click', this.onBuyClick)
		this.hudSell?.addEventListener('click', this.onSellClick)
		this.hudMinimise?.addEventListener('click', this.onHudMinimise)
		// Keys modal: the button opens it, a backdrop click, the × or Escape closes it.
		// The panel itself stops propagation so clicking inside never falls through to
		// the canvas or the backdrop handler.
		this.keysModal = document.getElementById('keys-modal')
		const keysPanel = document.getElementById('keys-panel')
		document.getElementById('hud-keys')?.addEventListener('click', () => this.toggleKeysModal(true))
		document.getElementById('keys-close')?.addEventListener('click', () => this.toggleKeysModal(false))
		this.keysModal?.addEventListener('pointerdown', event => {
			if (event.target === this.keysModal) this.toggleKeysModal(false)
		})
		keysPanel?.addEventListener('pointerdown', event => event.stopPropagation())
		window.addEventListener('keydown', this.onHudKey)
		for (const chip of document.querySelectorAll('.hud-collapse'))
			chip.addEventListener('click', event => {
				event.stopPropagation()
				const panel = chip.parentElement
				if (!panel) return
				const collapsed = panel.classList.toggle('hud-collapsed')
				;(chip as HTMLElement).textContent = collapsed ? '+' : '–'
				chip.setAttribute('aria-expanded', String(!collapsed))
				const name = panel.id === 'hud-camera' ? 'camera pad' : panel.id === 'hud-production' ? 'build pane' : 'panel'
				chip.setAttribute('title', collapsed ? `Restore the ${name}` : `Minimise the ${name}`)
			})
		this.sessionStart?.addEventListener('click', this.onSessionStart)
		this.sessionMap?.addEventListener('change', this.onSessionMapChange)
		this.sessionQuality?.addEventListener('pointerdown', () => { this.qualityTouched = true })
		this.sessionQuality?.addEventListener('keydown', () => { this.qualityTouched = true })
		this.sessionQuality?.addEventListener('change', this.onSessionQualityChange)
		this.sessionMountains?.addEventListener('pointerdown', () => { this.mountainsTouched = true })
		this.sessionMountains?.addEventListener('keydown', () => { this.mountainsTouched = true })
		this.sessionMountains?.addEventListener('change', this.onSessionMountainsChange)
		this.outcomeRestart?.addEventListener('click', this.onOutcomeRestart)
		this.minimap?.addEventListener('pointerdown', this.onMinimapPointerDown)
		this.minimap?.addEventListener('contextmenu', this.onMinimapContext)
		this.hudDaylight = document.getElementById('hud-daylight')
		this.hudDaylight?.addEventListener('click', this.onDaylightClick)
		this.hudCamera = document.getElementById('hud-camera')
		this.hudCamera?.addEventListener('pointerdown', this.onCameraPointerDown)
		this.hudCamera?.addEventListener('pointerup', this.onCameraRelease)
		this.hudCamera?.addEventListener('pointercancel', this.onCameraRelease)
		this.hudCamera?.addEventListener('pointerleave', this.onCameraRelease)
		globalThis.addEventListener('blur', this.onWindowBlur)
		this.edgeHints[0] = document.getElementById('edge-left')
		this.edgeHints[1] = document.getElementById('edge-right')
		this.edgeHints[2] = document.getElementById('edge-top')
		this.edgeHints[3] = document.getElementById('edge-bottom')
		this.lastEdgeMask = -1
		this.lastDaylightMode = ''
		this.renderDaylightChoice()
	}

	/**
	 * How many AI opponents are still playing. Under fog their actors are absent from the
	 * snapshot entirely, so the player has no other way to tell a live opponent from an
	 * empty map; the player table is authoritative and always present.
	 */
	private updateOpponents(snap: Snapshot): void {
		const field = this.hudOpponents
		if (!field) return
		let total = 0, alive = 0
		// Multiplayer: every other human at the table is an opponent the HUD names
		// honestly ("online"). Skirmish: the bot roster, exactly as before.
		for (const player of snap.players) {
			if (this.mpMatch ? (player.flags & PlayerFlag.isRenderPlayer) !== 0 : (player.flags & PlayerFlag.isBot) === 0) continue
			total++
			if ((player.flags & PlayerFlag.alive) !== 0 && (player.flags & PlayerFlag.lost) === 0) alive++
		}
		if (total > this.botsAtStart) this.botsAtStart = total
		const started = Math.max(this.botsAtStart, total)
		const label = field.previousElementSibling as HTMLElement | null
		if (label) label.textContent = this.mpMatch ? 'Online Enemies' : 'AI Enemies'
		field.textContent = started === 0 ? 'none' : `${alive} / ${started}`
		field.classList.toggle('bad', started === 0)
		field.classList.toggle('good', started > 0 && alive === 0)
	}

	private updateHud(snap: Snapshot, ctx: Ctx): void {
		const root = this.hudRoot
		if (!root) return
		let player: Snapshot['players'][number] | null = null
		for (let i = 0; i < snap.players.length; i++) {
			if ((snap.players[i].flags & PlayerFlag.isRenderPlayer) === 0) continue
			player = snap.players[i]
			break
		}
		if (!player && snap.players.length > 0) player = snap.players[0]
		if (!player) {
			root.hidden = true
			return
		}

		root.hidden = false
		this.renderPlayerId = player.id
		// OpenRA spends stored ore before cash. Resources are already valued in credits;
		// showing cash alone made successful refinery deliveries look unspendable.
		if (this.hudCash) this.setText(this.hudCash, formatNumber(player.cash + player.resources))
		if (this.hudResources) this.setText(this.hudResources, formatNumber(player.resources))
		this.updateHarvesterHud(snap, ctx)
		if (this.hudWaterStatus) this.hudWaterStatus.textContent = this.terrain && this.terrain.waterCellCount > 0
			? `${formatNumber(this.terrain.waterCellCount)} water cells · animated ripples active`
			: 'Land map · choose a naval map for animated water'
		if (this.hudPower) {
			// A power outage (a spy in one of our power plants) stops the grid whatever the
			// balance says: show it and count it down in match seconds.
			const status = ctx.supportPowers?.() ?? null
			const outageTicks = status?.powerOutageTicks ?? 0
			const outage = outageTicks > 0
			if (outage && !this.powerOutageShown) this.showNotice('Stroomuitval · een spion saboteerde je stroom')
			this.powerOutageShown = outage
			this.hudPower.textContent = outage
				? `Stroomuitval · ${Math.ceil(outageTicks * (status?.timestepMs || SIM_TICK_MS) / 1000)}s`
				: `${player.powerDrawn} / ${player.powerSupplied}`
			const low = outage || player.powerDrawn > player.powerSupplied
			this.hudPower.classList.toggle('bad', low)
			this.hudPower.classList.toggle('good', !low)
			if (this.hudPowerFill) {
				const supplied = Math.max(1, player.powerSupplied)
				const pct = Math.max(0, Math.min(100, Math.round((player.powerDrawn / supplied) * 100)))
				this.hudPowerFill.style.width = `${pct}%`
				this.hudPowerFill.classList.toggle('low', low)
			}
			// Edge-triggered: the announcer says it once as the grid drops, not every frame.
			if (low && !this.evaLowPower) this.eva?.say('Low power')
			this.evaLowPower = low
		}

		if (this.hudAlert) {
			this.hudAlert.textContent = this.sessionError.length > 0
				? this.sessionError
				: (snap.flags & HeaderFlag.gameOver) !== 0
				? 'Battle concluded'
				: (snap.flags & HeaderFlag.paused) !== 0
					? 'Simulation paused'
					: player.powerDrawn > player.powerSupplied ? 'Low power — production slowed' : ''
		}
		if (this.hudPause) {
			const paused = (snap.flags & HeaderFlag.paused) !== 0
			this.hudPause.textContent = paused ? 'Resume' : 'Pause'
			this.hudPause.setAttribute('aria-pressed', paused ? 'true' : 'false')
			this.hudPause.disabled = (snap.flags & HeaderFlag.gameOver) !== 0
			const over = (snap.flags & HeaderFlag.gameOver) !== 0
			if (this.hudBuy) this.hudBuy.disabled = over
			if (this.hudSell) this.hudSell.disabled = over
			if (this.hudRepair) this.hudRepair.disabled = over
			if (over) this.setSellMode(false)
		}
		if (this.hudNotice && snap.tick >= this.noticeUntilTick) this.hudNotice.hidden = true
		this.updateOutcome(snap, player.flags)

		this.syncProductionDom(snap.production, ctx)
		this.syncReadyTray(snap.production, ctx)
		this.updateTutorial(snap, ctx, player)
		this.updateSelectionHud(ctx)
		this.updateQualityHud(snap)
	}

	/**
	 * The graphics preset switch. Presets are chosen before boot (pipelines are compiled
	 * against them), so a change stores the choice and reloads the page; that only ever
	 * happens in the lobby, where nothing is lost.
	 */
	private renderQualityChoice(): void {
		const select = this.sessionQuality
		if (!select) return
		const detected = (globalThis as { steelseedQuality?: QualityDetection }).steelseedQuality
		const stored = readStoredQuality()
		const labels: Record<string, string> = {
			detect: 'Auto',
			dynamic: 'Dynamic',
			low: 'Low',
			medium: 'Medium',
			high: 'High',
			turbo: 'Turbo 60',
			classic: 'Classic',
			ultra: 'Ultra',
			'ultra-max': 'Ultra+',
		}
		select.replaceChildren(
			...GRAPHICS_CHOICES.map(name => option(name, labels[name] ?? name)),
		)
		// The URL has higher priority than storage, so show what this boot actually uses.
		select.value = detected?.choice ?? stored ?? 'dynamic'
		if (this.sessionQualityNote) {
			const active = detected ? `${detected.choice} → ${detected.tier} (${detected.source})` : 'unknown'
			this.sessionQualityNote.textContent = `Running ${active}.`
		}
	}

	private applyQualityChoice(): void {
		if (!this.qualityTouched) return
		const select = this.sessionQuality
		if (!select) return
		const value = isGraphicsChoice(select.value) ? select.value : 'dynamic'
		const detected = (globalThis as { steelseedQuality?: QualityDetection }).steelseedQuality
		const running = detected?.choice ?? readStoredQuality() ?? 'dynamic'
		if (value === running) return
		const persisted = storeQuality(value)
		// When storage is unavailable, keep the explicit choice in the URL across reloads.
		const url = new URL(location.href)
		if (persisted) url.searchParams.delete('quality')
		else url.searchParams.set('quality', value)
		// A plain location.replace() can be answered from the browser's session
		// cache without hitting the server; the timestamp forces a fresh fetch.
		url.searchParams.set('_ts', Date.now().toString())
		location.replace(url.toString())
	}

	private renderMountainChoice(): void {
		const select = this.sessionMountains
		if (!select) return
		select.replaceChildren(option('off', 'Off (faster)'), option('on', 'On'))
		select.value = this.ctx?.config.distantMountains ? 'on' : 'off'
	}

	private applyMountainChoice(): void {
		if (!this.mountainsTouched) return
		const enabled = this.sessionMountains?.value === 'on'
		if (enabled === (this.ctx?.config.distantMountains === true)) return
		const persisted = storeDistantMountains(enabled)
		const url = new URL(location.href)
		if (persisted) url.searchParams.delete('mountains')
		else url.searchParams.set('mountains', enabled ? 'on' : 'off')
		url.searchParams.set('_ts', Date.now().toString())
		location.replace(url.toString())
	}
	private updateQualityHud(snap: Snapshot): void {
		const label = this.hudQuality
		if (!label || snap.tick < this.hudQualityNextTick) return
		this.hudQualityNextTick = snap.tick + 25
		const app = (globalThis as { steelseed?: { frameStats?: {
			p50Ms: number; renderScale: number; tier: string; choice?: string
			nearField?: boolean; windGrass?: boolean; weatherFx?: boolean
			presetNear?: boolean; presetWind?: boolean
			cascades?: number; presetCascades?: number; contact?: boolean; sceneryStep?: number
		} } }).steelseed
		const stats = app?.frameStats
		if (!stats || !stats.tier) {
			label.textContent = ''
			return
		}
		const scale = stats.renderScale < 0.995 ? ` · ${Math.round(stats.renderScale * 100)}% scale` : ''
		const dynamic = stats.choice === 'dynamic'
		const locked = dynamic || stats.tier === 'high'
		const windLabel = stats.presetWind && stats.windGrass === false ? ' · wind off' : ''
		const grassLabel = stats.presetNear && stats.nearField === false ? ' · grass off' : ''
		const extras = locked
			? `${windLabel}${stats.weatherFx === false ? ' · rain off' : ''}${grassLabel}${stats.tier === 'high' && stats.contact === false ? ' · contact off' : ''}${stats.presetCascades && stats.cascades !== undefined && stats.cascades < stats.presetCascades ? ` · ${stats.cascades} shadows` : ''}${stats.sceneryStep && stats.sceneryStep > 1 ? ` · scenery 1/${stats.sceneryStep}` : ''}`
			: ''
		const mode = dynamic ? ' · dynamic' : ''
		label.textContent = stats.p50Ms > 0
			? `${stats.tier}${mode} · ${stats.p50Ms.toFixed(1)} ms · ${Math.round(1000 / stats.p50Ms)} fps${scale}${extras}`
			: `${stats.tier}${mode}${scale}${extras}`
	}

	private setText(node: HTMLElement, value: string): void {
		if (node.textContent !== value) node.textContent = value
	}

	private updateHarvesterHud(snap: Snapshot, ctx: Ctx): void {
		const hud = this.hudHarvesters
		if (!hud) return
		const actors = snap.actors
		if (!actors) {
			hud.textContent = '0'
			return
		}
		const units = ctx.get<UnitsApi>('units')
		let count = 0
		let moving = 0
		for (let i = 0; i < actors.count; i++) {
			if (actors.owner[i] !== this.renderPlayerId) continue
			const actorName = ctx.actorTypeName(actors.typeId[i])
			if (units.semanticRole(actorName) !== 'harvester') continue
			count++
			if ((actors.flags[i] & ActorFlag.moving) !== 0) moving++
		}
		this.setText(hud, count > 0 ? `${count} · ${moving} moving` : '0 · build refinery')
		hud.classList.toggle('good', count > 0)
		hud.classList.toggle('bad', count === 0)
		hud.title = count > 0
			? 'Ore Trucks automatically collect ore and unload it at an Ore Refinery. Delivered ore is immediately included in spendable credits.'
			: 'Build an Ore Refinery: OpenRA delivers one Ore Truck with it automatically.'
	}

	private desktopAccountAvailable(): boolean {
		const bridge = (globalThis as Record<string, unknown>).redline
		return typeof bridge === 'object' && bridge !== null && typeof (bridge as { accountDeviceLogin?: unknown }).accountDeviceLogin === 'function'
	}

	/** The desktop shell names the account host up front; the browser only once net-config loads. */
	private accountOriginKnown = 'redline' in globalThis

	private accountGateOpen(): boolean {
		// Accounts are public since 2026-09-23. Signing in is what puts a skirmish on the
		// leaderboard, and hiding it until multiplayer went live left the board empty.
		// Multiplayer and Ranked surfaces keep their own switch (effectiveMpMode).
		return true
	}

	private updateAccountGate(): void {
		const open = this.accountGateOpen()
		if (this.sessionAccount) this.sessionAccount.hidden = !open
		if (!open && this.accountRoot) this.accountRoot.hidden = true
		// The browser learns the account host from net-config.json; asking before it resolves
		// went to the game host's own origin, which serves no /api (a 404 on every page load).
		if (open && this.accountUser === null && this.accountOriginKnown) void this.refreshAccount()
		if (this.accountDeviceButton) this.accountDeviceButton.hidden = !this.desktopAccountAvailable()
		if (this.accountDeviceRow) this.accountDeviceRow.hidden = !this.desktopAccountAvailable()
		if (this.accountSeparator) this.accountSeparator.hidden = this.desktopAccountAvailable()
		if (this.accountLoginForm) this.accountLoginForm.hidden = this.desktopAccountAvailable()
		if (this.accountGuestForm) this.accountGuestForm.hidden = this.desktopAccountAvailable()
		if (this.accountRegisterToggle) this.accountRegisterToggle.hidden = this.desktopAccountAvailable()
	}

	private bindAccountUi(): void {
		this.sessionAccount?.addEventListener('click', () => {
			if (!this.accountGateOpen() || !this.accountRoot || !this.accountRoot.hidden) return
			// A dialog: focus moves in, Tab stays inside, Esc and the scrim close it.
			this.accountOverlay = openOverlay(this.accountRoot, { opener: this.sessionAccount, onClose: () => { this.accountOverlay = null } })
			void this.refreshAccount()
		})
		this.accountClose?.addEventListener('click', () => {
			if (this.accountOverlay) this.accountOverlay.close()
			else if (this.accountRoot) this.accountRoot.hidden = true
		})
		this.accountRegisterToggle?.addEventListener('click', () => {
			if (!this.accountRegisterForm || !this.accountLoginForm) return
			this.accountRegisterForm.hidden = false
			this.accountLoginForm.hidden = true
			this.accountRegisterToggle!.hidden = true
		})
		this.accountLoginForm?.addEventListener('submit', event => { event.preventDefault(); void this.accountLogin() })
		this.accountGuestForm?.addEventListener('submit', event => { event.preventDefault(); void this.accountCreateGuest() })
		this.accountRegisterForm?.addEventListener('submit', event => { event.preventDefault(); void this.accountRegister() })
		this.accountUpgradeForm?.addEventListener('submit', event => { event.preventDefault(); void this.accountUpgrade() })
		this.accountDeviceButton?.addEventListener('click', () => void this.accountDeviceLogin())
		this.accountProfileForm?.addEventListener('submit', event => { event.preventDefault(); void this.accountSaveProfile() })
		this.accountVerifyButton?.addEventListener('click', () => void this.accountResendVerification())
		this.accountLogoutButton?.addEventListener('click', () => void this.accountSignOut())
	}

	private accountMessage(message: string): void {
		if (this.accountStatusLine) this.accountStatusLine.textContent = message
	}

	private renderAccountUser(user: AccountUser | null, profile?: { username?: string | null; email?: string | null }): void {
		this.accountUser = user
		const signedIn = Boolean(user)
		if (this.accountSignedOut) this.accountSignedOut.hidden = signedIn
		if (this.accountSignedIn) this.accountSignedIn.hidden = !signedIn
		if (this.accountUpgradeRoot) this.accountUpgradeRoot.hidden = user?.kind !== 'guest' || this.desktopAccountAvailable()
		if (this.accountProfileForm) this.accountProfileForm.hidden = user?.kind !== 'account'
		if (this.accountVerifyButton) this.accountVerifyButton.hidden = user?.kind !== 'account'
		this.renderRankedIdentity(user?.kind === 'account' ? user : null)
		this.prefillMpNickname(user)
		const chipLabel = document.getElementById('session-account-label')
		if (chipLabel) chipLabel.textContent = user ? (user.callsign ?? 'Commander') : 'Sign in'
		if (this.sessionAccount) {
			if (user?.kind) this.sessionAccount.dataset.signed = user.kind
			else delete this.sessionAccount.dataset.signed
		}
		if (!user) return
		// Signed in: deliver any finished match that could not be reported earlier.
		void flushPendingMatchReports()
		const callsign = document.getElementById('account-callsign-label')
		const kind = document.getElementById('account-kind-label')
		const avatar = document.getElementById('account-avatar')
		const profileCallsign = document.getElementById('account-profile-callsign') as HTMLInputElement | null
		const profileUsername = document.getElementById('account-profile-username') as HTMLInputElement | null
		const profileEmail = document.getElementById('account-profile-email') as HTMLInputElement | null
		if (callsign) callsign.textContent = user.callsign ?? 'Commander'
		if (kind) kind.textContent = user.kind === 'account' ? 'Account' : 'Guest'
		if (profileCallsign) profileCallsign.value = user.callsign ?? ''
		if (profileUsername) profileUsername.value = profile?.username ?? ''
		if (profileEmail) profileEmail.value = profile?.email ?? user.email ?? ''
		if (avatar) {
			avatar.replaceChildren()
			const avatarUrl = accountAvatarUrl(user.avatarUrl)
			if (avatarUrl) {
				const image = document.createElement('img')
				image.alt = ''
				image.src = avatarUrl
				avatar.append(image)
			} else avatar.textContent = (user.callsign ?? 'C').slice(0, 1).toUpperCase()
		}
	}

	private renderRankedIdentity(user: AccountUser | null): void {
		const root = document.getElementById('session-ranked-identity')
		const callsign = document.getElementById('session-ranked-callsign')
		const avatar = document.getElementById('session-ranked-avatar')
		const validCallsign = typeof user?.callsign === 'string' && user.callsign.trim() ? user.callsign.trim() : null
		if (root) root.hidden = !validCallsign
		if (callsign) callsign.textContent = validCallsign ?? ''
		if (!avatar) return
		avatar.replaceChildren()
		const url = accountAvatarUrl(user?.avatarUrl)
		if (url) {
			const image = document.createElement('img')
			image.alt = ''
			image.src = url
			avatar.append(image)
		} else avatar.textContent = (validCallsign ?? 'C').slice(0, 1).toUpperCase()
	}

	private async refreshAccount(): Promise<void> {
		if (!this.accountGateOpen()) return
		if (this.accountDeviceCode === null) this.accountMessage('Checking account…')
		const result = await accountStatus()
		this.renderAccountUser(result.authenticated ? result.user ?? null : null, result.profile ?? undefined)
		// A pending desktop sign-in keeps its code on screen.
		if (this.accountDeviceCode !== null) return
		this.accountMessage(!result.online
			? 'Account service is offline. Skirmish still works; retry here when your connection returns.'
			: result.authenticated
				? result.user?.kind === 'guest'
					? this.desktopAccountAvailable() ? 'Guest ready. Account upgrades use the website so passwords never enter the game window.' : 'Online guest ready. Enlist to keep this id and history on every device.'
					: 'Account ready.'
				: this.desktopAccountAvailable() ? 'Sign in securely in your system browser. Passwords never enter the game window.' : 'Create a guest, sign in, or enlist. Skirmish remains available without an account.')
	}

	private async accountCreateGuest(): Promise<void> {
		const callsign = String(new FormData(this.accountGuestForm ?? undefined).get('callsign') ?? '').trim()
		this.accountMessage('Creating online guest…')
		try {
			const result = await accountGuest(callsign || undefined)
			this.renderAccountUser(result.user)
			this.accountMessage('Guest ready. Enlist later to keep this same id and history.')
		} catch (error) {
			this.accountMessage(error instanceof Error ? `${error.message} Skirmish is still available without an online identity.` : 'Guest creation failed. Skirmish is still available.')
		}
	}

	private async accountLogin(): Promise<void> {
		const form = this.accountLoginForm
		if (!form) return
		const data = new FormData(form)
		this.accountMessage('Signing in…')
		try {
			const result = await accountJson<{ user: AccountUser }>('/api/auth/login', { method: 'POST', body: { identifier: String(data.get('identifier') ?? '').trim(), password: String(data.get('password') ?? '') } })
			this.renderAccountUser(result.user)
			this.accountMessage('Signed in. Ranked admission can use this account.')
		} catch (error) { this.accountMessage(error instanceof Error ? error.message : 'Sign-in failed.') }
	}

	private async accountRegister(): Promise<void> {
		const form = this.accountRegisterForm
		if (!form) return
		const data = new FormData(form)
		this.accountMessage('Creating account…')
		try {
			const username = String(data.get('username') ?? '').trim()
			const email = String(data.get('email') ?? '').trim()
			const result = await accountJson<{ user: AccountUser }>('/api/auth/register', { method: 'POST', body: { username, callsign: String(data.get('callsign') ?? '').trim(), email, password: String(data.get('password') ?? '') } })
			this.renderAccountUser(result.user, { username, email })
			this.accountMessage('Account created. Check your email if verification is required.')
		} catch (error) { this.accountMessage(error instanceof Error ? error.message : 'Account creation failed.') }
	}

	private async accountUpgrade(): Promise<void> {
		const form = this.accountUpgradeForm
		if (!form || this.accountUser?.kind !== 'guest') return
		const data = new FormData(form)
		const username = String(data.get('username') ?? '').trim()
		const email = String(data.get('email') ?? '').trim()
		this.accountMessage('Enlisting this guest…')
		try {
			const result = await accountJson<{ user: AccountUser; upgraded?: boolean }>('/api/auth/register', { method: 'POST', body: {
				username, email, callsign: this.accountUser.callsign ?? '', password: String(data.get('password') ?? ''),
			} })
			if (result.upgraded !== true) throw new Error('The server did not preserve this guest profile.')
			this.renderAccountUser(result.user, { username, email })
			form.reset()
			this.accountMessage('Enlisted. Your guest id and history came with you; check your email to verify the address.')
		} catch (error) { this.accountMessage(error instanceof Error ? error.message : 'Guest upgrade failed.') }
	}

	private async accountDeviceLogin(): Promise<void> {
		if (this.accountDeviceButton) this.accountDeviceButton.disabled = true
		this.accountMessage('Opening secure browser sign-in…')
		try {
			const result = await accountDeviceLogin(({ userCode }) => {
				this.accountDeviceCode = `Your sign-in code: ${userCode.slice(0, 4)}-${userCode.slice(4)}. Type it on the page that just opened in your browser. Never enter a code someone else sent you.`
				this.accountMessage(this.accountDeviceCode)
			})
			this.accountDeviceCode = null
			this.renderAccountUser(result.user ?? null)
			this.accountMessage('Signed in. The device credential stays inside the desktop shell.')
		} catch (error) {
			this.accountDeviceCode = null
			this.accountMessage(error instanceof Error ? error.message : 'Device login failed.')
		}
		finally { if (this.accountDeviceButton) this.accountDeviceButton.disabled = false }
	}

	private async accountSaveProfile(): Promise<void> {
		const form = this.accountProfileForm
		if (!form) return
		const data = new FormData(form)
		const callsign = String(data.get('callsign') ?? '').trim()
		const username = String(data.get('username') ?? '').trim()
		const email = String(data.get('email') ?? '').trim()
		this.accountMessage('Saving profile…')
		try {
			let result: { user: AccountUser }
			try { result = await accountJson<{ user: AccountUser }>('/api/me/profile', { method: 'PATCH', body: { callsign, username, email } }) }
			catch (error) {
				if (email || !(error instanceof Error && /404/.test(error.message))) throw error
				result = await accountJson<{ user: AccountUser }>('/api/me', { method: 'PATCH', body: { callsign } })
			}
			this.renderAccountUser(result.user, { username, email })
			const file = data.get('avatar')
			if (file instanceof File && file.size > 0) {
				if (this.desktopAccountAvailable()) {
					const avatarResult = await accountAvatarUpload({ bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type, name: file.name })
					if (avatarResult.user) this.renderAccountUser(avatarResult.user)
				} else {
					const formData = new FormData()
					formData.append('avatar', file, file.name || 'avatar')
					const response = await accountFetch('/api/me/avatar', { method: 'POST', body: formData })
					if (!response.ok) throw new Error(`Avatar upload failed (${response.status}).`)
					const avatarResult = await response.json() as { user?: AccountUser }
					if (avatarResult.user) this.renderAccountUser(avatarResult.user)
				}
			}
			this.accountMessage('Profile saved.')
		} catch (error) { this.accountMessage(error instanceof Error ? error.message : 'Profile could not be saved.') }
	}

	private async accountResendVerification(): Promise<void> {
		this.accountMessage('Requesting verification email…')
		try {
			const result = await accountJson<{ sent?: boolean }>('/api/auth/verify-email/resend', { method: 'POST', body: {} })
			this.accountMessage(result.sent === true ? 'Verification email requested.' : 'Email verification is unavailable right now. Try again later.')
		} catch (error) {
			const message = error instanceof Error ? error.message : ''
			if (error instanceof TypeError || /network|fetch failed/i.test(message)) this.accountMessage('Account service is offline. Check your connection and retry.')
			else if (/\b401\b|unauthori[sz]ed/i.test(message)) this.accountMessage('Your sign-in expired. Sign in again, then retry verification.')
			else if (/\b403\b|forbidden/i.test(message)) this.accountMessage('Verification is not allowed for this account yet.')
			else this.accountMessage(message || 'Verification request failed. Try again.')
		}
	}

	private async accountSignOut(): Promise<void> {
		this.accountMessage('Signing out…')
		try {
			await accountLogout()
			this.renderAccountUser(null)
			this.accountMessage('Signed out. Guest play remains available.')
		} catch (error) { this.accountMessage(error instanceof Error ? error.message : 'Sign-out failed.') }
	}

	private async showSessionSetup(): Promise<void> {
		const ctx = this.ctx
		const root = this.sessionRoot
		if (!ctx || !root) return
		root.hidden = false
		root.dataset.state = 'ready'
		if (this.sessionStart) this.sessionStart.disabled = false
		this.catalog = await ctx.session.getCatalog()
		if (!this.catalog || this.catalog.status === 'error' || this.catalog.maps.length === 0) {
			// The host scans its maps asynchronously; right after boot the catalog can still
			// be empty. Retry instead of erroring the lobby into a dead end.
			this.catalogRetry = (this.catalogRetry ?? 0) + 1
			if (this.catalogRetry <= 120) {
				setTimeout(() => this.showSessionSetup(), 1000)
				return
			}
			root.dataset.state = 'error'
			if (this.sessionStart) this.sessionStart.disabled = true
			if (this.sessionStatus) this.sessionStatus.textContent = this.catalog?.userMessage ?? 'No skirmish maps are available.'
			return
		}

		root.dataset.state = 'ready'
		if (this.sessionStart) this.sessionStart.disabled = false
		// Multiplayer tab (MULTIPLAYER-SERVICE.md §7): enabled once the catalog
		// declares network support, or in dev (?mp=1) to exercise the flow before
		// the flip. Disabled — never hidden — while network is still 'future', so
		// the mode selector stays a stable part of the layout. T5.2 then gates the
		// tab CONTENT per §5.1 (applyMpSwitch): off → S1 call-to-action and zero
		// relay requests; join → room list, host column replaced by S2; full → all.
		const query = new URLSearchParams(location.search)
		const mpDev = query.get('mp') === '1' || query.get('debug') === 'on' || query.has('hostedon')
		const mpReady = this.catalog.sessionTransports?.network?.supported === true || mpDev
		if (this.sessionTabMp) {
			this.sessionTabMp.disabled = !mpReady
			this.sessionTabMp.title = mpReady ? '' : 'Network transport not yet available'
		}
		if (mpReady) {
			this.populateMpSlotChoices()
			this.restoreMpNickname()
			if (this.effectiveMpMode() !== 'off') void this.refreshMpRooms()
		}
		this.applyMpSwitch()
		// Desktop shell pins the session screen: the main-menu choice supersedes the
		// in-game tab pair (?session=skirmish|mp). Browser (no param) keeps both.
		const pinnedSession = new URLSearchParams(location.search).get('session')
		if (pinnedSession === 'skirmish' || pinnedSession === 'mp') {
			this.pinnedSession = pinnedSession
			this.sessionTabSkirmish?.toggleAttribute('hidden', pinnedSession === 'mp')
			this.sessionTabMp?.toggleAttribute('hidden', pinnedSession === 'skirmish')
			this.selectSessionTab(pinnedSession)
		}
		this.updateSessionNav()
		// Re-entry (the desktop's in-page session switch) keeps the map and speed already chosen.
		if (this.sessionMap) {
			const keepMap = this.sessionMap.value
			this.sessionMap.replaceChildren(...this.catalog.maps.map(map => option(map.uid, `${map.title} · ${map.bounds.width}×${map.bounds.height}`)))
			if (keepMap && this.catalog.maps.some(map => map.uid === keepMap)) this.sessionMap.value = keepMap
		}
		if (this.sessionSpeed) {
			const keepSpeed = this.sessionSpeed.value
			this.sessionSpeed.replaceChildren(...this.catalog.gameSpeeds.map(speed => option(speed.id, speed.name ?? speed.id)))
			this.sessionSpeed.value = keepSpeed && this.catalog.gameSpeeds.some(speed => speed.id === keepSpeed) ? keepSpeed : this.catalog.defaultGameSpeed
		}
		this.renderSessionMap()
		this.syncMpMapPicker()
		void this.loadMpOwnBuild().then(() => this.joinFromLink())
	}

	/** One-time wiring of the war-room console around the native session controls. */
	private bindSetupConsole(): void {
		const root = this.sessionRoot
		if (!root) return
		const byId = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null
		this.sessionNav = byId('session-nav')
		this.sessionMapTitle = byId('session-map-title')
		this.sessionMapMeta = byId('session-map-meta')
		this.sessionMapCount = byId('session-map-count')
		this.sessionConditions = byId('session-conditions')
		this.sessionPlayersReadout = byId('session-players-readout')
		this.sessionAddOpponent = byId<HTMLButtonElement>('session-add-opponent')
		this.sessionAddCount = byId('session-add-count')
		this.sessionRulesSummary = byId('session-rules-summary')
		this.sessionRulesReset = byId<HTMLButtonElement>('session-rules-reset')
		this.sessionChips = byId('session-chips')
		this.sessionSettings = byId('session-settings')
		const plot = byId('session-schematic')
		if (plot) {
			this.sessionSchematic = createSchematic({ size: 'card', onSpawn: id => this.claimSpawn(id) })
			plot.append(this.sessionSchematic.root)
		}
		// Controls speak through the audio node's UI sounds once a gesture unlocked audio.
		setControlCues((cue, variant) => this.uiCue(cue, variant))
		// Disclosures: the header button owns aria-expanded; a collapsed body is inert.
		for (const id of ['session-rules', 'mp-host-rules']) {
			const module = byId(id)
			const head = module?.querySelector<HTMLButtonElement>('.disclosure__head')
			const body = module?.querySelector<HTMLElement>('.disclosure__body')
			if (!head || !body) continue
			head.addEventListener('click', () => {
				const open = head.getAttribute('aria-expanded') !== 'true'
				head.setAttribute('aria-expanded', String(open))
				body.inert = !open
				module?.toggleAttribute('data-open', open)
				this.uiCue(open ? 'open' : 'close')
			})
		}
		this.sessionRulesReset?.addEventListener('click', () => this.resetSessionRules())
		this.sessionAddOpponent?.addEventListener('click', () => {
			const map = this.selectedMap()
			if (!map || this.sessionPlayerCount >= map.slots.length) return
			const index = this.sessionPlayerCount
			this.sessionPlayerCount++
			this.renderSessionMap()
			// "Add opponent" means an opponent: a bot where the slot allows one.
			const row = this.sessionSlots?.querySelectorAll<HTMLElement>('[data-slot-id]')[index]
			const kind = row?.querySelector<HTMLSelectElement>('select[data-field="kind"]')
			if (kind && [...kind.options].some(o => o.value === 'bot')) setSelect(kind, 'bot')
			this.uiCue('open')
			row?.querySelector<HTMLSelectElement>('select[data-role="controller"]')?.focus()
		})
		// Anything that changes inside the setup re-reads the native selects into the chrome.
		root.addEventListener('change', () => this.refreshSetupChrome())
		// The mode tabs: one tab stop, arrows move, Enter or Space selects (manual activation).
		this.sessionNav?.addEventListener('keydown', event => {
			const tabs = [this.sessionTabSkirmish, this.sessionTabMp].filter((t): t is HTMLButtonElement => !!t && !t.hidden && !t.disabled)
			const at = tabs.indexOf(document.activeElement as HTMLButtonElement)
			if (at < 0) return
			const next = event.key === 'ArrowRight' ? (at + 1) % tabs.length : event.key === 'ArrowLeft' ? (at - 1 + tabs.length) % tabs.length
				: event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
			if (next < 0) return
			event.preventDefault()
			tabs[next].focus()
			this.uiCue('focus')
		})
		// Settings: graphics, distant mountains, sound and motion live in one sheet.
		const openSettings = (opener: HTMLElement | null): void => {
			if (!this.sessionSettings || !this.sessionSettings.hidden) return
			this.renderSettingsSheet()
			this.settingsOverlay = openOverlay(this.sessionSettings, { opener, initial: this.sessionQuality })
		}
		byId('session-settings-open')?.addEventListener('click', event => openSettings(event.currentTarget as HTMLElement))
		byId('session-gfx-chip')?.addEventListener('click', event => openSettings(event.currentTarget as HTMLElement))
		byId('session-settings-close')?.addEventListener('click', () => this.settingsOverlay?.close())
		if (this.sessionMountains) {
			const mountains = segmented(this.sessionMountains, { label: 'Distant mountains', labels: { off: 'Off', on: 'On' }, order: ['off', 'on'] })
			// A proxy click is the player's own touch: the reload guard needs to know.
			mountains.addEventListener('pointerdown', () => { this.mountainsTouched = true }, true)
			mountains.addEventListener('keydown', () => { this.mountainsTouched = true }, true)
			byId('session-mountains-control')?.append(mountains)
		}
		this.sessionQuality?.addEventListener('change', () => this.renderSettingsSheet())
		// The bar's sound switch drives music and interface sounds together.
		const sound = byId<HTMLButtonElement>('session-sound')
		const syncSound = (): void => { sound?.setAttribute('aria-pressed', String(this.music?.isEnabled() === true)) }
		sound?.addEventListener('click', () => {
			const on = !(this.music?.isEnabled() === true)
			this.music?.setEnabled(on)
			this.uiSound?.setEnabled(on)
			this.music?.unlock()
			this.uiSound?.unlock()
			syncSound()
			this.syncMusicMenu()
			this.renderSettingsSheet()
		})
		syncSound()
		// Browsers keep audio locked until a gesture; the lobby used to wait for a canvas click
		// the full-screen setup never lets through, so it stayed silent.
		const unlockAudio = (): void => {
			this.music?.unlock()
			this.eva?.unlock()
			this.uiSound?.unlock()
			syncSound()
		}
		root.addEventListener('pointerdown', unlockAudio, { once: true })
		root.addEventListener('keydown', unlockAudio, { once: true })
		// Focus cues for keyboard travel only.
		document.addEventListener('keydown', event => { if (event.key === 'Tab' || event.key.startsWith('Arrow')) this.keyboardModality = true }, true)
		document.addEventListener('pointerdown', () => { this.keyboardModality = false }, true)
		root.addEventListener('focusin', () => { if (this.keyboardModality) this.uiCue('focus') })
		// A stored motion choice outranks the system setting (the loader already applied that).
		try {
			const motion = localStorage.getItem('redline-motion')
			if (motion === 'reduced') document.documentElement.dataset.motion = 'reduced'
		} catch { /* storage unavailable: follow the system setting */ }
		// The host card picks the room's map with its own select, mirroring #session-map.
		const mpMap = byId<HTMLSelectElement>('session-mp-map')
		mpMap?.addEventListener('change', () => { if (this.sessionMap && mpMap.value) setSelect(this.sessionMap, mpMap.value) })
		this.sessionMap?.addEventListener('change', () => this.syncMpMapPicker())
		// Desktop: the command bar leads back to the app's landing — the Main menu button and the
		// wordmark (the shell never leaves 127.0.0.1). In the browser the wordmark goes home.
		const shellBack = typeof (globalThis as { backToMain?: unknown }).backToMain === 'function'
		this.sessionMainMenu = byId<HTMLButtonElement>('session-main-menu')
		if (this.sessionMainMenu) {
			this.sessionMainMenu.hidden = !shellBack
			this.sessionMainMenu.addEventListener('click', () => this.returnToShell())
		}
		byId<HTMLAnchorElement>('session-home')?.addEventListener('click', event => {
			if (!shellBack) return
			event.preventDefault()
			this.returnToShell()
		})
		this.updateMainMenuButton()
		this.renderSettingsSheet()
	}

	/** Desktop: back to the app's landing, except mid-lobby, while connecting or loading. */
	private updateMainMenuButton(): void {
		const button = this.sessionMainMenu
		if (button) button.disabled = this.mpPhase !== 'idle' || this.mpBusy || this.sessionRoot?.dataset.state === 'loading'
	}

	private returnToShell(): void {
		const back = (globalThis as { backToMain?: () => void }).backToMain
		if (typeof back !== 'function') return
		this.updateMainMenuButton()
		if (this.sessionMainMenu?.disabled) {
			this.uiCue('error')
			return
		}
		this.settingsOverlay?.close()
		this.stopMpRoomsPolling()
		back()
	}

	/** Copy #session-map's options and value into the host card's map picker. */
	private syncMpMapPicker(): void {
		const proxy = document.getElementById('session-mp-map') as HTMLSelectElement | null
		const source = this.sessionMap
		if (!proxy || !source) return
		if (proxy.options.length !== source.options.length)
			proxy.replaceChildren(...[...source.options].map(o => option(o.value, o.textContent ?? o.value)))
		proxy.value = source.value
	}

	/** Settings sheet state: graphics description, the GFX chip, sound and motion switches. */
	private renderSettingsSheet(): void {
		const quality = this.sessionQuality
		const labelOf = (select: HTMLSelectElement | null): string => select ? (select.options[select.selectedIndex]?.textContent ?? select.value) : ''
		const desc = document.getElementById('session-quality-desc')
		if (desc && quality) desc.textContent = GRAPHICS_COPY[quality.value] ?? ''
		const chip = document.getElementById('session-gfx-value')
		if (chip) chip.textContent = labelOf(quality) || 'Graphics'
		const switchIn = (containerId: string, label: string, on: boolean, labels: [string, string], apply: (on: boolean) => void): void => {
			const container = document.getElementById(containerId)
			if (!container) return
			const group = document.createElement('div')
			group.className = 'seg'
			group.setAttribute('role', 'radiogroup')
			group.setAttribute('aria-label', label)
			for (const [value, text] of [[false, labels[0]], [true, labels[1]]] as const) {
				const button = document.createElement('button')
				button.type = 'button'
				button.className = 'seg__opt'
				button.setAttribute('role', 'radio')
				button.setAttribute('aria-checked', String(value === on))
				button.tabIndex = value === on ? 0 : -1
				button.textContent = text
				button.addEventListener('click', () => {
					apply(value)
					this.uiCue(value ? 'toggleOn' : 'toggleOff')
					this.renderSettingsSheet()
					;(document.getElementById(containerId)?.querySelector<HTMLButtonElement>('[aria-checked="true"]'))?.focus()
				})
				group.append(button)
			}
			container.replaceChildren(group)
		}
		switchIn('session-music-control', 'Music', this.music?.isEnabled() === true, ['Off', 'On'], on => {
			this.music?.setEnabled(on)
			this.music?.unlock()
			this.syncMusicMenu()
			document.getElementById('session-sound')?.setAttribute('aria-pressed', String(on))
		})
		switchIn('session-uisound-control', 'Interface sounds', this.uiSound?.isEnabled() !== false, ['Off', 'On'], on => {
			this.uiSound?.setEnabled(on)
			this.uiSound?.unlock()
		})
		switchIn('session-motion-control', 'Motion', document.documentElement.dataset.motion !== 'reduced', ['Reduced', 'Full'], full => {
			if (full) delete document.documentElement.dataset.motion
			else document.documentElement.dataset.motion = 'reduced'
			try { localStorage.setItem('redline-motion', full ? 'full' : 'reduced') } catch { /* not persisted */ }
		})
	}

	private renderSessionMap(): void {
		const map = this.selectedMap()
		if (!map || !this.sessionSlots || !this.sessionOptions) return
		// A hosted room seats at most the map's own players.
		this.populateMpSlotChoices()
		// Preserve the values the player already chose for slots that survive this
		// re-render, so changing the player count does not silently reset every slot.
		const previous = new Map<string, Record<string, string>>()
		for (const row of this.sessionSlots.querySelectorAll<HTMLElement>('[data-slot-id]')) {
			const values: Record<string, string> = {}
			for (const select of row.querySelectorAll<HTMLSelectElement>('select[data-field]'))
				values[select.dataset.field ?? ''] = select.value
			previous.set(row.dataset.slotId ?? '', values)
		}
		this.sessionSlots.replaceChildren()
		const maxPlayers = Math.max(1, map.slots.length)
		if (this.sessionPlayerCount > maxPlayers) this.sessionPlayerCount = maxPlayers
		if (this.sessionPlayerCount < 1) this.sessionPlayerCount = 1
		const factions = new Map(map.factions.map(f => [f.id, f]))
		// You read in green; everyone else rotates through the presets that stay visible
		// against terrain (relative luminance ≥ .05 drops #391D1D and #200738).
		const localGreen = map.colors.find(c => c.slice(1, 7).toUpperCase() === '34BA93')
		const readable = map.colors.filter(c => c !== localGreen && !(relativeLuminance(c) < .05))
		const rotation = readable.length > 0 ? readable : map.colors
		const lastRow = this.sessionPlayerCount - 1
		for (let i = 0; i < maxPlayers; i++) {
			if (i >= this.sessionPlayerCount) continue
			const slot = map.slots[i]
			const row = document.createElement('fieldset')
			row.className = 'session-slot'
			row.dataset.slotId = slot.id
			if (i === 0) row.dataset.local = ''
			const legend = document.createElement('legend')
			legend.textContent = `Player ${i + 1}${i === 0 ? ' — you' : ''}${slot.required ? ' · required' : ''}`
			// Upstream parity: the first slot is the local player and is always Human —
			// OpenRA's skirmish lobby never offers a controller choice for your own slot,
			// and other slots never offer Human (that would start two local players).
			const kinds = [
				...(i === 0 ? [['human', 'Human (you)']] : []),
				...(slot.allowBots && i > 0 ? [['bot', 'OpenRA bot']] : []),
				...(i > 0 ? [['open', 'Open'], ['closed', 'Closed']] : []),
			] as [string, string][]
			// At least one opponent is filled by default, because a lobby whose every other
			// slot reads "Open" starts a match with nobody to fight: the bots then never
			// appear, and the game looks like its AI is broken when none was ever asked for.
			const defaultKind = i === 0 ? 'human'
				: slot.allowBots && (slot.required || i === 1) ? 'bot'
				: 'open'
			const prior = previous.get(slot.id)
			const kind = fieldSelect('kind', 'Controller', kinds, i === 0 ? 'human' : prior?.kind ?? defaultKind)
			if (i === 0) {
				kind.select.disabled = true
				kind.select.title = 'This slot is you — the local player. Spectators are not part of a local skirmish; they only exist when joining a multiplayer lobby.'
			}
			const bot = fieldSelect('bot', 'Bot', map.bots.map(v => [v.id, v.name ?? v.id]), prior?.bot ?? map.bots[0]?.id ?? '')
			const faction = fieldSelect('faction', 'Faction', map.factions.map(v => [v.id, v.name ?? v.id]), prior?.faction ?? slot.defaults.faction)
			// Locked colours keep the map-authored value even when it is not a preset.
			const selectedColor = slot.locks.color
				? slot.defaults.color
				: (i === 0 ? localGreen ?? rotation[0] : rotation[(i - 1) % rotation.length]) ?? slot.defaults.color
			const colorChoices = map.colors.includes(selectedColor)
				? map.colors
				: [selectedColor, ...map.colors]
			const color = fieldSelect('color', 'Colour', colorChoices.map(v => [v, colourName(v)]), prior?.color ?? selectedColor)
			const team = fieldSelect('team', 'Team', Array.from({ length: 11 }, (_, teamId) => [String(teamId), teamId === 0 ? 'None' : String(teamId)]), prior?.team ?? String(slot.defaults.team))
			const spawn = fieldSelect('spawn', 'Spawn', [['0', 'Random'], ...map.spawnPoints.map(v => [String(v.id), String(v.id)] as [string, string])], prior?.spawn ?? String(slot.defaults.spawn))
			faction.select.disabled = slot.locks.faction
			color.select.disabled = slot.locks.color
			team.select.disabled = slot.locks.team
			spawn.select.disabled = slot.locks.spawn
			// The bot personality (Rush, Turtle, …) only means something for a bot. It stays in
			// the row so its value is kept.
			const showBot = (): void => { bot.label.hidden = kind.select.value !== 'bot' }
			kind.select.addEventListener('change', showBot)
			showBot()

			// The card. The colour select lies over the badge; controller and bot live behind the
			// controller proxy (the start config and the gates read them there).
			const badge = document.createElement('div')
			badge.className = 'slot__badge'
			const number = document.createElement('span')
			number.textContent = String(i + 1).padStart(2, '0')
			number.setAttribute('aria-hidden', 'true')
			color.select.setAttribute('aria-label', `Player ${i + 1} colour`)
			color.select.title = 'Colour'
			badge.append(number, color.select)
			const paint = (): void => {
				row.style.setProperty('--slot-color', color.select.value.slice(0, 7))
				row.style.setProperty('--slot-ink', relativeLuminance(color.select.value) > .3 ? '#090D11' : '#FFF5E8')
			}
			color.select.addEventListener('change', paint)
			paint()
			const who = document.createElement('div')
			who.className = 'slot__who'
			const caption = document.createElement('span')
			caption.className = 'slot__caption'
			caption.textContent = `Player ${i + 1}`
			who.append(caption)
			const store = document.createElement('div')
			store.hidden = true
			store.append(kind.label, bot.label)
			if (i === 0) {
				const you = document.createElement('span')
				you.className = 'slot__you'
				const strong = document.createElement('b')
				strong.textContent = 'You'
				you.append(strong)
				who.append(you)
			} else {
				const controller = document.createElement('select')
				controller.dataset.role = 'controller'
				controller.setAttribute('aria-label', `Player ${i + 1} controller`)
				const choices: [string, string][] = []
				if (slot.allowBots) for (const b of map.bots) choices.push([`bot:${b.id}`, `Bot · ${b.name ?? b.id}`])
				choices.push(['open', 'Open slot'], ['closed', 'Closed'])
				controller.replaceChildren(...choices.map(([v, l]) => option(v, l)))
				const syncController = (): void => {
					controller.value = kind.select.value === 'bot' ? `bot:${bot.select.value}` : kind.select.value
				}
				controller.addEventListener('change', () => {
					const value = controller.value
					if (value.startsWith('bot:')) {
						setSelect(bot.select, value.slice(4))
						setSelect(kind.select, 'bot')
					} else {
						setSelect(kind.select, value)
					}
				})
				kind.select.addEventListener('change', syncController)
				bot.select.addEventListener('change', syncController)
				syncController()
				who.append(controller)
			}
			const tagline = document.createElement('span')
			tagline.className = 'slot__tagline'
			const describeFaction = (): void => { tagline.textContent = factionTagline(factions.get(faction.select.value)?.description) }
			faction.select.addEventListener('change', describeFaction)
			describeFaction()
			faction.label.classList.add('slot__faction')
			faction.label.append(tagline)
			team.label.classList.add('slot__team')
			spawn.label.classList.add('slot__spawn')
			const remove = document.createElement('button')
			remove.type = 'button'
			remove.className = 'slot__remove'
			remove.textContent = '×'
			remove.setAttribute('aria-label', `Remove player ${i + 1}`)
			remove.hidden = i === 0 || i !== lastRow
			remove.addEventListener('click', () => {
				this.sessionPlayerCount = i
				this.renderSessionMap()
				this.uiCue('close')
				this.sessionAddOpponent?.focus()
			})
			row.append(legend, badge, who, faction.label, team.label, spawn.label, remove, store)
			this.sessionSlots.append(row)
		}
		if (this.sessionAddOpponent) this.sessionAddOpponent.disabled = this.sessionPlayerCount >= maxPlayers

		this.renderComposition()
		this.renderSessionRules(map)
		if (this.sessionStatus && this.sessionRoot?.dataset.state === 'ready') this.sessionStatus.textContent = `Ready · ${map.title} by ${map.author}`
		this.refreshSetupChrome()
	}

	/**
	 * Match rules and conditions. The native selects stay in
	 * #session-options — the start config, the vision coupling and the gates read them
	 * there — while the console shows each through the control its values call for.
	 */
	private renderSessionRules(map: SkirmishMapCatalog): void {
		const options = this.sessionOptions
		if (!options) return
		// A player-count or map change rebuilds the rules: keep every choice that is still valid
		// here instead of snapping all of them back to the map defaults.
		const kept = new Map<string, string>()
		for (const select of options.querySelectorAll<HTMLSelectElement>('select[data-field]'))
			kept.set(select.dataset.field ?? '', select.value)
		const keep = (id: string, valid: readonly string[], fallback: string): string => {
			const value = kept.get(id)
			return value !== undefined && valid.includes(value) ? value : fallback
		}
		options.replaceChildren()
		this.sessionRuleRows.clear()
		const store = document.createElement('div')
		store.hidden = true
		// SteelSeed presentation options. Time of day: Auto follows the match clock and
		// leaves the in-game switch free; Day or Night pin the lighting for the whole
		// match and lock that switch. Weather follows the map generator when on.
		const tod = fieldSelect('tod', 'Time of day', [['auto', 'Auto'], ['day', 'Day'], ['night', 'Night'], ['world', 'World — real local time']], keep('tod', ['auto', 'day', 'night', 'world'], 'auto'))
		tod.select.title = 'Auto follows the match clock: one presentation day per 24 minutes. Day or Night pin the lighting. World keeps the sky on your real local time of day (pair it with World weather for real regional weather too).'
		const weather = fieldSelect('weather', 'Weather', [['off', 'Off'], ['on', 'On'], ['live', 'World — live weather']], keep('weather', ['off', 'on', 'live'], 'off'))
		weather.select.title = 'On lets the map decide battlefield weather. Off forces clear skies. World fetches the real weather for your region (keyless public APIs), syncs the battlefield to it and sets the sky to your local time of day. Skirmish only.'
		store.append(tod.label, weather.label)
		const optionSelects = new Map<string, HTMLSelectElement>([['tod', tod.select], ['weather', weather.select]])
		const groups = new Map<string, HTMLElement>()
		const group = (title: string): HTMLElement => {
			let node = groups.get(title)
			if (!node) {
				node = document.createElement('div')
				node.className = 'rules-group'
				node.dataset.group = title
				const heading = document.createElement('h3')
				heading.className = 'rules-group__title'
				heading.textContent = title
				node.append(heading)
				groups.set(title, node)
			}
			return node
		}
		for (const { title } of RULE_GROUPS) group(title)
		const groupOf = (id: string): string => RULE_GROUPS.find(g => g.ids.includes(id))?.title ?? 'Other'
		// Game speed is the catalog-backed #session-speed, shown as a stepper in Tempo.
		if (this.sessionSpeed) {
			this.speedRuleRow ??= ruleRow({ label: 'Game speed', description: RULE_COPY.gamespeed, control: stepper(this.sessionSpeed, { label: 'Game speed' }), id: 'gamespeed' })
			group('Tempo').append(this.speedRuleRow)
			this.sessionRuleRows.set(this.sessionSpeed, { row: this.speedRuleRow, standard: this.catalog?.defaultGameSpeed ?? this.sessionSpeed.value })
		}
		for (const descriptor of map.options) {
			// Game speed has its own catalog-backed control, and weather/tod are owned by
			// the fields above. Do not emit the same lobby command twice.
			if (descriptor.id === 'gamespeed' || descriptor.id === 'weather' || descriptor.id === 'tod') continue
			// No debug menu: an option the menu does not send stays at the map's default.
			if (!descriptor.isVisible || HIDDEN_OPTIONS.has(descriptor.id)) continue
			const field = fieldSelect(
				descriptor.id,
				lobbyLabel(descriptor.name),
				descriptor.values.map(v => [v.id, lobbyValueLabel(descriptor.id, v)]),
				descriptor.isLocked ? descriptor.defaultValue : keep(descriptor.id, descriptor.values.map(v => v.id), descriptor.defaultValue),
			)
			field.select.disabled = descriptor.isLocked
			// An unresolved Fluent key is not a description. Say nothing rather than offer
			// "checkbox-fog-of-war.description" as a tooltip.
			field.select.title = isFluentKey(descriptor.description) ? '' : descriptor.description
			optionSelects.set(descriptor.id, field.select)
			const label = RULE_LABEL[descriptor.id] ?? lobbyLabel(descriptor.name)
			const note = RULE_COPY[descriptor.id] ?? (isFluentKey(descriptor.description) ? '' : descriptor.description)
			const shape = controlKind(descriptor)
			const control = shape === 'toggle' ? toggle(field.select, label)
				: shape === 'stepper' ? stepper(field.select, { label })
				: shape === 'segmented' ? segmented(field.select, { label })
				: field.select
			const row = ruleRow({ label, description: descriptor.isLocked ? `${note} Set by this map.`.trim() : note, control, id: descriptor.id })
			if (control !== field.select) {
				field.label.classList.add('rule__native')
				row.append(field.label)
			}
			this.sessionRuleRows.set(field.select, { row, standard: descriptor.defaultValue })
			group(groupOf(descriptor.id)).append(row)
		}
		options.append(...[...groups.values()].filter(node => node.childElementCount > 1), store)
		this.bindVisionOptions(optionSelects)
		this.renderConditions(tod.select, weather.select)
	}

	/** Time of day and weather: segmented proxies with a caption, over the native selects. */
	private renderConditions(tod: HTMLSelectElement, weather: HTMLSelectElement): void {
		const root = this.sessionConditions
		if (!root) return
		const line = (label: string, select: HTMLSelectElement, id: 'tod' | 'weather', labels: Record<string, string>): HTMLElement => {
			const wrap = document.createElement('div')
			wrap.className = 'condition'
			const name = document.createElement('span')
			name.className = 'condition__label'
			name.textContent = label
			const caption = document.createElement('span')
			caption.className = 'condition__caption'
			const sync = (): void => { caption.textContent = CONDITION_COPY[id][select.value] ?? '' }
			select.addEventListener('change', sync)
			sync()
			wrap.append(name, segmented(select, { label, labels }), caption)
			return wrap
		}
		root.replaceChildren(
			line('Time of day', tod, 'tod', { auto: 'Auto', day: 'Day', night: 'Night', world: 'World' }),
			line('Weather', weather, 'weather', { off: 'Off', on: 'On', live: 'Live' }),
		)
	}

	/**
	 * Everything on the setup screen that summarises the native selects: map title and
	 * facts, spawn markers, the players readout, changed-rule lights, the summary chips and
	 * inline spawn conflicts. Cheap; runs after every render and on every change.
	 */
	private refreshSetupChrome(): void {
		const map = this.selectedMap()
		if (!map || !this.sessionSlots) return
		if (this.sessionMapTitle) this.sessionMapTitle.textContent = map.title
		if (this.sessionMapCount && this.catalog) this.sessionMapCount.textContent = `${this.catalog.maps.length} maps`
		const avail = document.getElementById('session-map-avail')
		if (avail && this.catalog) avail.textContent = ` · ${this.catalog.maps.length} available`
		if (this.sessionMapMeta) {
			const theatre: Record<string, string> = { SNOW: 'Snow', TEMPERAT: 'Temperate', DESERT: 'Desert' }
			const tags = [`${map.slots.length} players`, `${map.bounds.width}×${map.bounds.height}`, theatre[map.tileSet] ?? map.tileSet, `by ${map.author}`]
			this.sessionMapMeta.replaceChildren(...tags.map(text => {
				const tag = document.createElement('span')
				tag.className = 'tag'
				tag.textContent = text
				return tag
			}))
		}
		const rows = [...this.sessionSlots.querySelectorAll<HTMLElement>('[data-slot-id]')]
		const max = Math.max(1, map.slots.length)
		if (this.sessionPlayersReadout) {
			this.sessionPlayersReadout.replaceChildren('Players ', Object.assign(document.createElement('b'), { textContent: String(rows.length) }), ` / ${max}`)
		}
		if (this.sessionAddCount) this.sessionAddCount.textContent = `${rows.length}/${max}`
		// Spawn markers, and inline conflicts: two players on one spawn is refused by the engine.
		const markers: SpawnMarker[] = []
		const holders = new Map<string, number[]>()
		rows.forEach((row, index) => {
			const spawn = valueOf(row, 'spawn')
			const kind = valueOf(row, 'kind')
			if (Number(spawn) > 0 && (kind === 'human' || kind === 'bot')) {
				markers.push({ id: Number(spawn), color: valueOf(row, 'color'), label: index === 0 ? 'YOU' : `P${index + 1}`, you: index === 0 })
				holders.set(spawn, [...holders.get(spawn) ?? [], index])
			}
		})
		this.sessionSchematic?.show(map, markers)
		let conflict = ''
		rows.forEach((row, index) => {
			const select = row.querySelector<HTMLSelectElement>('select[data-field="spawn"]')
			const clash = (holders.get(select?.value ?? '') ?? []).length > 1
			if (select) select.toggleAttribute('aria-invalid', clash)
			if (clash && !conflict) {
				const who = holders.get(select?.value ?? '')!.map(i => `Player ${i + 1}`).join(' and ')
				conflict = `Spawn ${select?.value} is taken by ${who}. Pick another spawn, or Random.`
			}
			void index
		})
		if (this.sessionStatus && this.sessionRoot?.dataset.state === 'ready')
			this.sessionStatus.textContent = conflict || `Ready · ${map.title} by ${map.author}`
		// Changed-from-standard lights and summaries.
		let changed = 0
		for (const [select, { row, standard }] of this.sessionRuleRows) {
			const differs = select.value !== standard
			row.toggleAttribute('data-changed', differs)
			if (differs) changed++
		}
		if (this.sessionRulesSummary) {
			this.sessionRulesSummary.replaceChildren(changed === 0 ? 'Standard rules' : `${changed} changed`, ...Array.from({ length: Math.min(changed, 5) }, () => document.createElement('i')))
			this.sessionRulesSummary.toggleAttribute('data-changed', changed > 0)
		}
		if (this.sessionRulesReset) this.sessionRulesReset.disabled = changed === 0
		this.renderDeployChips(map, rows)
	}

	/** The deploy bar's summary: what you are about to start, changed values lit amber. */
	private renderDeployChips(map: SkirmishMapCatalog, rows: readonly HTMLElement[]): void {
		const root = this.sessionChips
		if (!root) return
		const option = (id: string): HTMLSelectElement | null => this.sessionOptions?.querySelector<HTMLSelectElement>(`select[data-field="${id}"]`) ?? null
		const text = (select: HTMLSelectElement | null): string => select ? (select.options[select.selectedIndex]?.textContent ?? select.value) : ''
		const standard = (select: HTMLSelectElement | null): boolean => !select || this.sessionRuleRows.get(select)?.standard === select.value
		const bots = rows.filter(row => valueOf(row, 'kind') === 'bot').length
		const chips: { text: string; changed?: boolean }[] = [
			{ text: map.title },
			{ text: bots > 0 ? `You + ${bots} AI` : 'You alone', changed: bots === 0 },
		]
		const cash = option('startingcash')
		if (cash) chips.push({ text: text(cash), changed: !standard(cash) })
		const tech = option('techlevel')
		if (tech) chips.push({ text: `Tech ${text(tech)}`, changed: !standard(tech) })
		const fog = option('fog')
		if (fog) chips.push({ text: fog.value === 'False' ? 'Fog off' : 'Fog on', changed: !standard(fog) })
		if (this.sessionSpeed) chips.push({ text: text(this.sessionSpeed), changed: !standard(this.sessionSpeed) })
		const limit = option('timelimit')
		if (limit && limit.value !== '0') chips.push({ text: text(limit), changed: true })
		root.replaceChildren(...chips.map(chip => {
			const node = document.createElement('span')
			node.className = 'chip'
			node.setAttribute('role', 'listitem')
			if (chip.changed) node.dataset.changed = ''
			node.textContent = chip.text
			return node
		}))
	}

	/** Clicking a spawn marker takes it for you; whoever held it gets your old spawn. */
	private claimSpawn(spawnId: number): void {
		const rows = [...this.sessionSlots?.querySelectorAll<HTMLElement>('[data-slot-id]') ?? []]
		const mine = rows[0]?.querySelector<HTMLSelectElement>('select[data-field="spawn"]')
		if (!mine || mine.disabled || mine.value === String(spawnId)) return
		const was = mine.value
		const holder = rows.slice(1)
			.map(row => row.querySelector<HTMLSelectElement>('select[data-field="spawn"]'))
			.find(select => select?.value === String(spawnId))
		if (holder && !holder.disabled) setSelect(holder, was)
		setSelect(mine, String(spawnId))
		this.uiCue('confirm')
	}

	/** Back to the map's standard rules (and the catalog's default speed). */
	private resetSessionRules(): void {
		for (const [select, { standard }] of this.sessionRuleRows) {
			if (select.disabled) continue
			setSelect(select, standard)
		}
		this.uiCue('confirm')
		this.refreshSetupChrome()
	}

	/**
	 * Present OpenRA's two vision switches as the one promise a player reads into them.
	 *
	 * They are separate lobby options and they mean different things. "Fog of War" is the grey
	 * veil over ground you have uncovered but cannot currently see. "Explored Map" is whether
	 * the map starts uncovered at all. Unticking fog alone therefore leaves the black shroud
	 * standing, and an enemy inside it stays invisible — the SIMULATION withholds those actors
	 * (HiddenUnderFog falls back to exploration when fog is off), so no amount of renderer work
	 * can draw them. Nobody reads a switch called "fog of war" that way: they read it as "show
	 * me everything". So turning fog off here also uncovers the map, which is the pair that
	 * really does reveal every enemy unit, building and minimap blip.
	 *
	 * Explored Map stays editable on purpose. Setting it back to Disabled gives the progressive
	 * reading of the same rule, which is a legitimate mode and the one OpenRA means by fog off:
	 * ground you scout stays uncovered for the rest of the match and live enemies inside it stay
	 * visible, while ground you have never entered is still black.
	 */
	private bindVisionOptions(selects: ReadonlyMap<string, HTMLSelectElement>): void {
		const options = this.sessionOptions
		const fog = selects.get('fog')
		const explored = selects.get('explored')
		if (!options) return
		if (!this.sessionVision) {
			const note = document.createElement('p')
			note.className = 'session-note'
			note.id = 'session-vision'
			this.sessionVision = note
		}
		const note = this.sessionVision
		const visionGroup = options.querySelector<HTMLElement>('.rules-group[data-group="Vision"]')
		if (visionGroup) visionGroup.append(note)
		else options.insertAdjacentElement('afterend', note)
		if (!fog || !explored) {
			note.hidden = true
			return
		}
		note.hidden = false
		const describe = (): void => {
			const fogOn = fog.value !== 'False'
			const revealed = explored.value === 'True'
			note.textContent = fogOn
				? revealed
					? 'Fog of war on, map pre-explored: you start knowing the terrain, but enemy units and buildings show only where you can currently see.'
					: 'Fog of war on: enemy units and buildings show only where you can currently see, and unexplored ground is black.'
				: revealed
					? 'Fog of war off: the whole map is uncovered. Every enemy unit and building is visible, on screen and on the minimap.'
					: 'Fog of war off: ground you uncover stays uncovered for the rest of the match, and enemy units and buildings inside it stay visible. Ground you have never entered is still black.'
		}
		// Turning fog off uncovers the map with it, because "no fog of war" is read as "I can
		// see everything" and half a reveal reads as a bug: a fully lit map with no enemy on it.
		fog.addEventListener('change', () => {
			// setSelect, not .value: the explored switch on screen must follow.
			if (fog.value === 'False' && !explored.disabled) setSelect(explored, 'True')
			describe()
		})
		explored.addEventListener('change', describe)
		describe()
	}

	private selectedMap(): SkirmishMapCatalog | null {
		const uid = this.sessionMap?.value
		return this.catalog?.maps.find(map => map.uid === uid) ?? this.catalog?.maps[0] ?? null
	}

	private collectStartConfig(): StartSkirmishConfig {
		const map = this.selectedMap()
		if (!map || !this.catalog || !this.sessionSlots) throw new Error('Choose a skirmish map.')
		const configured = new Map([...this.sessionSlots.querySelectorAll<HTMLElement>('[data-slot-id]')]
			.map(row => [row.dataset.slotId ?? '', row]))
		// Slots the player-count control dropped from the lobby start closed: they exist
		// in the map but nobody occupies them, and the engine still wants every slot
		// declared exactly once.
		const slots = map.slots.map(slot => {
			const row = configured.get(slot.id)
			if (!row) return {
				slot: slot.id,
				kind: 'closed' as const,
				botType: undefined,
				faction: slot.defaults.faction,
				color: slot.defaults.color,
				team: slot.defaults.team,
				spawn: slot.defaults.spawn,
			}
			return {
				slot: slot.id,
				kind: valueOf(row, 'kind') as 'human' | 'bot' | 'open' | 'closed',
				botType: valueOf(row, 'bot'),
				faction: valueOf(row, 'faction'),
				color: valueOf(row, 'color'),
				team: Number(valueOf(row, 'team')),
				spawn: Number(valueOf(row, 'spawn')),
			}
		})
		const humans = slots.filter(slot => slot.kind === 'human')
		if (humans.length !== 1) throw new Error('Choose exactly one human slot.')
		const options: Record<string, string> = {}
		for (const input of this.sessionOptions?.querySelectorAll<HTMLSelectElement>('select[data-field]') ?? []) {
			const key = input.dataset.field ?? ''
			// Players shapes the lobby; weather and time of day are presentation choices the
			// client applies itself — the engine rejects options its maps never declared.
			if (key !== 'players' && key !== 'weather' && key !== 'tod') options[key] = input.value
		}
		const human = humans[0]
		// Deterministic harnesses (tools/playtest.mjs) pin the server seed with a
		// ?seed= URL parameter; a normal player leaves it unset and the host randomizes.
		const seed = Number(new URLSearchParams(location.search).get('seed'))
		return {
			schemaVersion: this.catalog.schemaVersion,
			transport: 'local',
			mapUid: map.uid,
			gameSpeed: this.sessionSpeed?.value ?? this.catalog.defaultGameSpeed,
			randomSeed: Number.isFinite(seed) && seed > 0 ? seed : undefined,
			local: { slot: human.slot, name: 'Commander', faction: human.faction, color: human.color, team: human.team, spawn: human.spawn },
			slots,
			options,
		}
	}

	/**
	 * Network sessions (MULTIPLAYER-SERVICE.md §5): the room host gives us a room
	 * id; everything after that is a plain OpenRA join through the WebSocket
	 * transport, driven by the bridge wrappers. The authoritative lobby stays on
	 * the dedicated server — this UI only walks the join lifecycle and reads
	 * probes. `?mpdir=http://host:port` names a remote room host; empty means the
	 * room host serves this very page (same origin).
	 */
	private mpBridge(): MpBridge | null {
		const g = globalThis as Record<string, unknown>
		const bridge = g.steelseedBridge
		// Narrowed at the boundary: the host's bridge is a plain object with the
		// probe method; the shape is fixed by openra-steelseed-bridge.js.
		if (!bridge || typeof bridge !== 'object' || !('getLobbyPlayersProbe' in bridge)) return null
		return bridge as MpBridge
	}

	private mpStatus(text: string): void {
		if (this.sessionStatus) this.sessionStatus.textContent = text
	}

	/**
	 * §5.10 row "connecting → failed": the visible cause, in the fixed order of
	 * T1.16 — the §5.6 string for the transport close code, then the server's
	 * error probe (wrong password, incompatible version), then the 20 s
	 * timeout line.
	 */
	private async mpJoinFailureCause(): Promise<string> {
		const mp = this.mpBridge()
		// A server-provided refusal names the CAUSE (wrong password, version);
		// a transport close only describes the symptom. The dedicated closes
		// the socket when it refuses a version, so the server error must win.
		const serverError = String(mp?.getServerErrorProbe() ?? 'none').toLowerCase()
		if (serverError.includes('password')) return MP_STRINGS.S5
		if (serverError.includes('incompatible')) return MP_STRINGS.S11
		const close = mp ? await mp.getMpCloseInfo().catch(() => null) : null
		if (close && close.code !== 0) {
			const text = MP_STRINGS[closeCodeToStringId[close.code] ?? '']
			if (text) return text
		}
		return MP_STRINGS.S4
	}

	/**
	 * §5.10 row "connecting → lobby": fresh `probeConnection()` RPCs only (never
	 * the 250 ms cache), every probe pinned to this join's epoch — a probe whose
	 * epoch differs describes an earlier connection and is ignored. A socket
	 * close or a server error exits immediately with its cause; 20 s exits with
	 * the timeout string.
	 */
	private async mpAwaitConnection(): Promise<void> {
		const mp = this.mpBridge()
		if (!mp) throw new MpJoinRefused('no OpenRA host attached')
		const deadline = Date.now() + 20_000
		for (;;) {
			const probe = await mp.probeConnection()
			if (mpProbeEpoch(probe) === this.mpEpoch && /state=Connected/.test(probe)) return
			if (Date.now() > deadline) throw new MpJoinRefused(MP_STRINGS.S4)
			// The fresh RPC is authoritative; the 250 ms cache is the fallback
			// because a refusing server must fail the join within seconds, not
			// at the 20 s deadline (§9.2: S11 within 10 s of the handshake).
			const serverError = (await mp.getServerError().catch(() => '')) || String(mp.getServerErrorProbe?.() ?? '')
			const close = await mp.getMpCloseInfo().catch(() => null)
			if ((serverError !== '' && serverError !== 'none') || close) {
				throw new MpJoinRefused(await this.mpJoinFailureCause())
			}
			await mpDelay(500)
		}
	}

	/**
	 * Bottom-left player list for network sessions: nickname, connection dot
	 * (green/yellow/red from the server's ConnectionQuality), and a struck-
	 * through row for players who left. Reads the local lobby copy, which the
	 * dedicated keeps in sync (SyncConnectionQuality broadcasts + lobby sync).
	 */
	private renderMpPlayers(): void {
		const panel = this.mpPlayers
		const mp = this.mpBridge()
		if (!panel || !mp) return
		try {
			const probe = mp.getLobbyPlayersProbe()
			const started = /started=True/.test(probe)
			const list = /clients=\[(.*)\]/.exec(probe)?.[1] ?? ''
			const entries = list.split(';;').filter(Boolean)
			const signalFor = (quality: string) => {
				const bars = document.createElement('i')
				bars.className = `mp-signal s-${quality.toLowerCase()}`
				bars.title = `${quality} connection`
				for (let i = 0; i < 3; i++) bars.append(document.createElement('i'))
				return bars
			}
			const rowFor = (name: string, quality: string, pingMs: number, gone: boolean) => {
				const row = document.createElement('div')
				row.className = 'mp-player-row'
				const dot = document.createElement('i')
				dot.className = `mp-player-dot ${gone ? 'gone' : quality.toLowerCase()}`
				const label = document.createElement('span')
				label.className = `mp-player-name${gone ? ' mp-player-gone' : ''}`
				label.textContent = name
				if (gone) {
					const state = document.createElement('span')
					state.className = 'mp-player-ping'
					state.textContent = 'left'
					row.append(dot, label, state)
					return row
				}
				row.append(dot, label, signalFor(quality))
				if (pingMs > 0) {
					const ms = document.createElement('span')
					ms.className = 'mp-player-ms'
					ms.textContent = `${pingMs} ms`
					row.append(ms)
				}
				return row
			}
			const rows: HTMLElement[] = []
			// One amber caption; a match caps at 8 players so the stack stays short.
			const title = document.createElement('div')
			title.className = 'mp-player-title'
			title.textContent = `Players · ${entries.length}`
			rows.push(title)
			for (const entry of entries) {
				const name = entry.split('|')[0]
				const quality = /q:(\w+)/.exec(entry)?.[1] ?? 'Poor'
				const pingMs = Number(/ms:(\d+)/.exec(entry)?.[1] ?? 0)
				const gone = /Disconnected/.test(entry)
				rows.push(rowFor(name, quality, pingMs, gone))
			}
			if (started) {
				const live = document.createElement('div')
				live.className = 'mp-player-row'
				const state = document.createElement('span')
				state.className = 'mp-player-ping'
				state.textContent = 'match in progress'
				live.append(state)
				rows.push(live)
			}
			panel.replaceChildren(...rows)
			panel.hidden = entries.length === 0
		} catch {
			panel.hidden = true
		}
	}

	/** Point world SFX at the match's faction: the bank-first layer in the audio
	 *  node falls to 'allied', then to the procedural voices, for every clip the
	 *  faction's bank lacks. The bank table is a boot-time Vite glob (sfx.ts),
	 *  injected here because the Node audio gates cannot bundle import.meta.glob. */
	private setSfxFaction(factionId: string): void {
		const audio = this.ctx?.get<AudioApi>('audio')
		audio?.setSfxBank(SFX_BANKS)
		audio?.setSfxFaction(factionId)
	}

	/**
	 * Match setup parity with skirmish: one live row per lobby client — name,
	 * server-assigned color, faction, team, spawn — synced through the dedicated
	 * lobby (LobbyCommands orders over the tunnel). Colors are never chosen:
	 * the server sanitizes/assigns them. Players edit their own row; the host
	 * (admin) can additionally reassign anyone's spawn. renderMpSlotRows does
	 * the actual drawing, from the 1s lobby poll.
	 */
	private openMpSetup(room: MpRoomSummary): void {
		if (!this.mpBridge() || !this.mpSetup || !this.mpSlotsEl) return
		this.mpSetupRoom = room
		this.mpSetupSignature = ''
		this.ensureMpLobbyControls()
		this.mpSetup.hidden = false
		this.renderMpSlotRows()
	}

	/** Rebuild the slot rows only when the lobby probe changed, so a dropdown
	 *  the player is about to open survives the 1s poll when nothing moved. */
	private renderMpSlotRows(): void {
		const root = this.mpSlotsEl
		const mp = this.mpBridge()
		const room = this.mpSetupRoom
		if (!root || !mp || !room || !this.mpSetup || this.mpSetup.hidden) return
		try {
			const probe = mp.getLobbyPlayersProbe()
			if (probe === this.mpSetupSignature) return
			this.mpSetupSignature = probe

			const map = this.catalog?.maps.find(m => m.uid === (room.map ?? '')) ?? null
			const connection = mp.getConnectionProbe()
			const localIndex = /clientid=(\d+)/.exec(connection)?.[1] ?? ''
			const isAdmin = /admin=True/.test(connection)
			const entries = (/clients=\[(.*)\]/.exec(probe)?.[1] ?? '').split(';;').filter(Boolean)

			const parse = (entry: string) => ({
				name: entry.split('|')[0],
				index: Number(/(?:^|\|)idx:(-?\d+)/.exec(entry)?.[1] ?? -1),
				faction: /(?:^|\|)faction:([^|]+)/.exec(entry)?.[1] ?? '',
				color: /(?:^|\|)color:([0-9a-fA-F]{6,8})/.exec(entry)?.[1] ?? '',
				team: /(?:^|\|)team:(-?\d+)/.exec(entry)?.[1] ?? '0',
				spawn: /(?:^|\|)spawn:(\d+)/.exec(entry)?.[1] ?? '0',
				isBot: /bot:True/.test(entry),
			})
			const players = entries.map(parse)
			// Deal space for every claimable client even if the catalog row is
			// missing or lists fewer points than the lobby holds.
			const spawnCount = Math.max(map?.spawnPoints.length ?? 0, players.length)

			// Catalog shapes differ between builds: entries may be plain ids or {id,name}.
			const choiceRows = (values: readonly unknown[]): [string, string][] => values.map(v => {
				if (typeof v === 'string') return [v, v] as [string, string]
				const o = v as { id?: string; name?: string }
				return [String(o.id ?? ''), String(o.name ?? o.id ?? '')] as [string, string]
			})
			const catalogFactions = choiceRows(map?.factions ?? [])
			// The catalog already offers Random/Any; a second synthetic 'random' read as a duplicate.
			const factionRows: [string, string][] = catalogFactions.some(([id]) => /^random/i.test(id))
				? catalogFactions
				: [['random', lobbyLabel('random')], ...catalogFactions]
			const teamRows: [string, string][] = [['0', 'No team'], ['1', 'Team 1'], ['2', 'Team 2'], ['3', 'Team 3'], ['4', 'Team 4']]
			const spawnRows: [string, string][] = [
				['0', 'Auto'],
				...Array.from({ length: spawnCount }, (_, i) => [String(i + 1), `Spawn ${i + 1}`] as [string, string]),
			]

			const select = (caption: string, rows: readonly (readonly [string, string])[], value: string,
				disabled: boolean, onPick: (value: string) => void): HTMLSelectElement => {
				const el = document.createElement('select')
				el.setAttribute('aria-label', caption)
				el.replaceChildren(...rows.map(([id, label]) => option(id, label)))
				// A value the catalog does not know (custom faction id, out-of-range
				// spawn) still shows; the server stays the authority either way.
				if (value !== '' && !rows.some(([id]) => id === value)) el.append(option(value, value))
				el.value = value
				el.disabled = disabled
				el.addEventListener('change', () => onPick(el.value))
				return el
			}

			const rows: HTMLElement[] = []
			const head = document.createElement('div')
			head.className = 'mp-slot-head'
			const title = document.createElement('div')
			title.className = 'mp-slot-title'
			title.textContent = `Players · ${players.length}`
			head.append(title)
			if (isAdmin && players.length > 1) {
				const reassign = document.createElement('button')
				reassign.type = 'button'
				reassign.className = 'mp-slot-reassign'
				reassign.textContent = 'Reassign spawns'
				reassign.addEventListener('click', () => {
					// clear_spawn frees every OCCUPIED point (it would DISABLE empty
					// ones), then the deal 1..N can never collide. Admin-only: the
					// server silently ignores the orders from anyone else.
					void mp.lobbyClearSpawns()
					players.forEach((player, i) => { void mp.lobbySetSpawnFor(player.index, (i % spawnCount) + 1) })
				})
				head.append(reassign)
			}
			rows.push(head)

			for (const player of players) {
				const mine = String(player.index) === localIndex
				const row = document.createElement('div')
				row.className = 'mp-slot-row'
				const dot = document.createElement('i')
				dot.className = 'mp-slot-color'
				dot.style.background = `#${player.color || 'ffffff'}`
				dot.title = `Color assigned by the server: ${player.color || 'ffffff'}`
				const name = document.createElement('span')
				name.className = 'mp-slot-name'
				name.textContent = player.isBot ? `${player.name} (bot)` : player.name
				row.append(dot, name)
				if (mine) {
					const you = document.createElement('span')
					you.className = 'mp-slot-you'
					you.textContent = 'you'
					row.append(you)
				}
				row.append(
					select(`Faction for ${player.name}`, factionRows, player.faction, !mine, v => { void mp.lobbySetFaction(v) }),
					select(`Team for ${player.name}`, teamRows, player.team, !mine, v => { void mp.lobbySetTeam(Number(v)) }),
					// The admin may set any client's spawn (`spawn <idx> <point>`).
					select(`Spawn for ${player.name}`, spawnRows, player.spawn, !mine && !isAdmin,
						v => { void (mine ? mp.lobbySetSpawn(Number(v)) : mp.lobbySetSpawnFor(player.index, Number(v))) }),
				)
				rows.push(row)
			}
			root.replaceChildren(...rows)
		} catch {
			// No lobby (pre-connect, match running): keep whatever rows exist.
		}
	}

	private async mpJoinCommon(endpoint: string, password = '', playerName = this.mpNickname()): Promise<void> {
		const mp = this.mpBridge()
		if (!mp) throw new Error('no OpenRA host attached')
		let parsed: URL
		try { parsed = new URL(endpoint.replace(/^ws/, 'http')) } catch { throw new Error(`bad room endpoint: ${endpoint}`) }
		const host = parsed.hostname
		// Default ports are legal endpoints: wss://play.example.com/g/<id> (443) and
		// ws://192.168.1.20/g/<id> (80) must join, not bounce. The engine gets the
		// full URI via setWsEndpoint; host/port here are only the dial labels.
		const port = Number(parsed.port) || (endpoint.startsWith('wss:') ? 443 : 80)
		if (!host) throw new Error(`bad room endpoint: ${endpoint}`)
		const roomName = parsed.pathname.split('/').filter(Boolean).pop() ?? parsed.pathname

		this.mpMatch = true
		this.mpSetPhase('connecting')
		this.mpStatus('Finishing battlefield visuals before joining…')
		try {
			if (this.ctx) await this.ctx.session.beginNetworkJoin?.()
			this.mpStatus(mpS3(roomName))
			// §5.10 row "idle → connecting": every call awaited, every returned
			// prefix checked, the epoch kept for all later probes (§7 rule 6).
				const named = await mp.setPlayerName(playerName)
			if (!named.startsWith('name ')) throw new MpJoinRefused(named)
			const endpointed = await mp.setWsEndpoint(endpoint)
			if (!endpointed.startsWith('endpoint ')) throw new MpJoinRefused(endpointed)
			const joining = await mp.joinMultiplayer(host, port, password)
			if (!joining.startsWith('joining ')) throw new MpJoinRefused(joining)
			this.mpEpoch = Number(/epoch=(\d+)/.exec(joining)?.[1] ?? 0)

			// Row "connecting → lobby": fresh epoch-pinned probes, 20 s budget.
			await this.mpAwaitConnection()

			const claim = await mp.lobbyClaimPlayerSlot()
			if (claim === 'map unavailable') throw new MpJoinRefused(MP_STRINGS.S11)
			if (claim.includes('already started')) throw new MpJoinRefused(MP_STRINGS.S7)
			if (!/^claiming |^slot /.test(claim)) throw new MpJoinRefused(claim)

			// Match voices to the faction the slot came with — a fresh probe now
			// that the lobby info has landed; neutral on any parse miss.
			const probe = await mp.probeConnection()
			const faction = /faction=(\S+)/.exec(probe)?.[1] ?? ''
			this.localFactionId = faction
			this.eva?.setFactionFamily(faction)
			this.setSfxFaction(faction)

			// In the lobby: the 1 Hz state machine takes over (L8 — nobody is
			// auto-readied, nobody auto-starts the match).
			this.mpSetPhase('lobby')
		} catch (error) {
			// Row "connecting → failed": show the cause, abandon the session
			// (freeing the slot server-side within 2 s), back to the room list.
			// A MpJoinRefused already carries the visible cause; anything else
			// (worker rpc rejection, dead host) gets the §5.6 → server-error →
			// timeout mapping of T1.16.
			const cause = error instanceof MpJoinRefused ? error.message : await this.mpJoinFailureCause()
			this.mpStatus(cause)
			await this.mpAbandonJoin()
			throw new MpJoinRefused(cause)
		}
	}

	/** Tear a half-open session down and land back on the room browser. */
	private async mpAbandonJoin(): Promise<void> {
		const mp = this.mpBridge()
		try { if (mp) await mp.leaveMultiplayer() } catch { /* the session may already be gone */ }
		this.mpSetPhase('idle')
		if (this.sessionMpPanel && !this.sessionMpPanel.hidden) this.selectSessionTab('mp')
	}

	/**
	 * §5.10 client state machine. `connecting` stops the room-list poller; back
	 * on `idle` the session is reset and the room browser resumes. Everything
	 * past `connecting` is driven by the 1 Hz fresh-probe tick below.
	 */
	private mpSetPhase(phase: MpPhase): void {
		this.mpPhase = phase
		if (phase === 'idle' && this.desktopMpOffPending) {
			this.desktopMpOffPending = false
			this.desktopMultiplayer = false
			queueMicrotask(() => this.applyMpSwitch())
		}
		this.updateMainMenuButton()
		if (this.sessionMpPanel) this.sessionMpPanel.dataset.mpPhase = phase
		// The room browser can remain visible behind the lobby. Its Join buttons
		// must follow the phase immediately, even while room polling is stopped.
		this.renderMpRoomList()
		if (phase === 'connecting') {
			this.stopMpRoomsPolling()
			// S18: the lookup only belongs to the browsing screen; a join or a
			// hosted game hides it until the session returns to idle.
			this.disarmMpLanLookup()
			return
		}
		// §7 rule 4: the fresh-probe tick drives everything past `connecting`
		// (lobby button states, S13 handover, started=True, S15/S16) — entering
		// the lobby starts it, returning to `idle` stops it below.
		if (phase === 'lobby') this.startMpLobbyPolling()
		if (phase !== 'idle') return
		this.stopTutorial()
		this.stopMpLobbyPolling()
		this.stopMpPlayersPolling()
		this.mpMatch = false
		this.mpEpoch = 0
		this.mpAdminSeen = false
		this.mpJoinedAsGuest = false
		this.mpStartRequested = false
		this.mpBannerShown = false
		this.mpRoom = null
		this.stopRankedQueuePolling()
		this.stopRankedSettlementPolling()
		if (this.mpBanner) this.mpBanner.hidden = true
		if (this.mpPlayers) this.mpPlayers.hidden = true
		if (this.mpSetup) this.mpSetup.hidden = true
	}

	private stopRankedQueuePolling(): void {
		if (this.rankedQueueTimer !== null) {
			window.clearTimeout(this.rankedQueueTimer)
			this.rankedQueueTimer = null
		}
	}

	private stopRankedSettlementPolling(): void {
		if (this.rankedSettlementTimer !== null) {
			window.clearTimeout(this.rankedSettlementTimer)
			this.rankedSettlementTimer = null
		}
		this.rankedSettlementStarted = false
	}

	private startRankedSettlementPolling(): void {
		const room = this.mpRoom
		if (!room?.ranked || !room.matchId || this.rankedSettlementStarted || room.settlement === 'settled' || room.settlement === 'void') return
		this.rankedSettlementStarted = true
		room.settlement = 'pending'
		void this.pollRankedSettlement()
	}

	private async pollRankedSettlement(): Promise<void> {
		this.rankedSettlementTimer = null
		const room = this.mpRoom
		if (!room?.ranked || !room.matchId) return
		try {
			const result = await rankedSettlement(room.matchId)
			if (!result || result.state === 'pending') {
				room.settlement = 'pending'
				room.settlementReason = null
				this.updateRankedSettlementUi()
				this.rankedSettlementTimer = window.setTimeout(() => void this.pollRankedSettlement(), 3000)
				return
			}
			room.settlement = result.state
			room.settlementReason = result.reason ?? result.terminationReason ?? null
			room.settlementOutcome = result.outcome ?? null
			room.settlementDelta = result.delta ?? null
			room.settlementRating = result.rating ?? null
			this.updateRankedSettlementUi()
		} catch (error) {
			const message = this.rankedMessage(error, 'Settlement could not be checked.')
			if (/\b401\b|\b403\b|\b404\b/.test(message)) {
				room.settlement = 'error'
				room.settlementReason = message
				this.updateRankedSettlementUi()
				return
			}
			room.settlement = 'pending'
			room.settlementReason = 'Settlement check unavailable — retrying.'
			this.updateRankedSettlementUi()
			this.rankedSettlementTimer = window.setTimeout(() => void this.pollRankedSettlement(), 5000)
		}
	}

	private updateRankedSettlementUi(): void {
		const room = this.mpRoom
		if (!room?.ranked) return
		const reason = room.settlementReason ? ` Reason: ${room.settlementReason}.` : ''
		const delta = typeof room.settlementDelta === 'number' ? `${room.settlementDelta >= 0 ? '+' : ''}${room.settlementDelta}` : null
		const rating = typeof room.settlementRating === 'number' ? ` · rating ${room.settlementRating}` : ''
		const text = room.settlement === 'settled'
			? `Ranked result settled${room.settlementOutcome ? ` · ${room.settlementOutcome}` : ''}${delta ? ` · ${delta}` : ''}${rating}.`
			: room.settlement === 'void' ? `Match void — no rating change.${reason}`
			: room.settlement === 'error' ? `Settlement unavailable — no rating change.${reason}`
			: 'Ranked result pending server settlement.'
		if (this.rankedStatus) this.rankedStatus.textContent = text
		if (this.outcomeSettlement && this.outcomeRoot && !this.outcomeRoot.hidden) this.outcomeSettlement.textContent = room.settlement === 'settled'
			? 'Ranked result settled.'
			: room.settlement === 'void' ? `Match void — no rating change.${reason}`
			: room.settlement === 'error' ? `Settlement unavailable — no rating change.${reason}`
			: 'Result pending server settlement.'
		if (this.mpBanner && !this.mpBanner.hidden && room.settlement !== 'pending') {
			const message = this.mpBanner.firstElementChild as HTMLElement | null
			if (message) message.textContent = `${message.textContent?.replace(/ Ranked result.*$/, '') ?? 'Ranked match ended.'} ${text}`
		}
	}

	private rankedMessage(error: unknown, fallback: string): string {
		const message = error instanceof Error ? error.message : String(error ?? '')
		if (/\b401\b|unauthori[sz]ed/i.test(message)) return 'Sign in to a verified account before joining Ranked.'
		if (/\b403\b|verified account/i.test(message)) return 'Ranked requires a verified account. Verify your email in Account, then retry.'
		if (/\b404\b/.test(message)) return 'Ranked service is not available yet. Try again later.'
		if (/\b503\b|not configured|offline|fetch failed|network/i.test(message)) return 'Ranked service is unavailable. Check your connection and retry.'
		return message || fallback
	}

	private setRankedQueueControls(state: RankedQueueState | 'error'): void {
		const queued = state === 'queued'
		if (this.rankedQueueButton) {
			this.rankedQueueButton.disabled = queued
			this.rankedQueueButton.hidden = queued
		}
		if (this.rankedCancelButton) this.rankedCancelButton.hidden = !queued
	}

	private rankedUiGateOpen(): boolean {
		const query = new URLSearchParams(location.search)
		return query.get('debug') === 'on' || this.effectiveMpMode() !== 'off'
	}

	private async startRankedQueue(): Promise<void> {
		if (!this.rankedUiGateOpen() || this.mpBusy) return
		this.stopRankedQueuePolling()
		this.setRankedQueueControls('queued')
		if (this.rankedStatus) this.rankedStatus.textContent = 'Checking account verification…'
		try {
			const auth = await accountStatus()
			if (!auth.online) throw new Error('Ranked account service is offline. Check your connection and retry.')
			if (!auth.authenticated || auth.user?.kind !== 'account') throw new Error('Ranked requires a signed-in account.')
			if (!auth.user.callsign) throw new Error('Ranked account identity is incomplete. Open Account and set a callsign.')
			if (auth.profile?.emailVerified !== true) throw new Error('Ranked play requires a verified account.')
			this.renderRankedIdentity(auth.user)
			if (this.rankedStatus) this.rankedStatus.textContent = `Looking for an opponent as ${auth.user.callsign}…`
			const queue = await rankedQueueStart()
			await this.handleRankedQueue(queue)
		} catch (error) {
			this.stopRankedQueuePolling()
			this.setRankedQueueControls('error')
			if (this.rankedStatus) this.rankedStatus.textContent = this.rankedMessage(error, 'Ranked queue could not start.')
		}
	}

	private async cancelRankedQueue(): Promise<void> {
		this.stopRankedQueuePolling()
		this.setRankedQueueControls('error')
		if (this.rankedStatus) this.rankedStatus.textContent = 'Leaving Ranked queue…'
		try {
			const queue = await rankedQueueCancel()
			if (this.rankedStatus) this.rankedStatus.textContent = queue.state === 'cancelled' ? 'Ranked search cancelled.' : `Ranked queue: ${queue.state}.`
		} catch (error) {
			if (this.rankedStatus) this.rankedStatus.textContent = this.rankedMessage(error, 'Ranked queue could not be cancelled.')
		}
	}

	private async pollRankedQueue(): Promise<void> {
		this.rankedQueueTimer = null
		try { await this.handleRankedQueue(await rankedQueueStatus()) }
		catch (error) {
			this.stopRankedQueuePolling()
			this.setRankedQueueControls('error')
			if (this.rankedStatus) this.rankedStatus.textContent = this.rankedMessage(error, 'Ranked queue status could not be loaded.')
		}
	}

	private async handleRankedQueue(queue: RankedQueueStatus): Promise<void> {
		if (queue.state === 'queued') {
			this.setRankedQueueControls('queued')
			if (this.rankedStatus) this.rankedStatus.textContent = 'Waiting for an opponent…'
			this.rankedQueueTimer = window.setTimeout(() => void this.pollRankedQueue(), 2000)
			return
		}
		this.stopRankedQueuePolling()
		if (queue.state === 'matched') {
			this.setRankedQueueControls('error')
			if (this.rankedStatus) this.rankedStatus.textContent = 'Opponent found. Joining the ranked room…'
			await this.joinRankedAdmission(queue)
			return
		}
		this.setRankedQueueControls('error')
		if (this.rankedStatus) this.rankedStatus.textContent = queue.state === 'expired'
			? 'Ranked search expired. Start again when ready.'
			: queue.state === 'cancelled' ? 'Ranked search cancelled.' : `Ranked queue: ${queue.state}.`
	}

	private async joinRankedAdmission(admission: RankedQueueStatus): Promise<void> {
		if (!admission.matchId || !admission.wsUrl || !admission.claim) {
			if (this.rankedStatus) this.rankedStatus.textContent = 'Ranked admission is incomplete. No unranked fallback was used.'
			return
		}
		const auth = await accountStatus()
		if (!auth.online) throw new Error('Ranked account service is offline. No unauthenticated join was attempted.')
		if (!auth.authenticated || auth.user?.kind !== 'account' || !auth.user.callsign) throw new Error('Ranked sign-in expired. No unauthenticated join was attempted.')
		if (auth.profile?.emailVerified !== true) throw new Error('Ranked account is not verified. No unauthenticated join was attempted.')
		this.renderRankedIdentity(auth.user)
		const endpoint = this.resolveRoomUrl({ wsUrl: admission.wsUrl })
		if (!endpoint) {
			if (this.rankedStatus) this.rankedStatus.textContent = 'Ranked room endpoint was refused. No unranked fallback was used.'
			return
		}
		const rankedEndpoint = new URL(endpoint)
		rankedEndpoint.searchParams.set('claim', admission.claim)
		const room: MpRoomSummary = {
			roomId: admission.roomId,
			matchId: admission.matchId,
			wsUrl: rankedEndpoint.toString(),
			ranked: true,
			claim: admission.claim,
			slots: 2,
			map: admission.mapUid,
			state: 'lobby',
			settlement: 'pending',
			expiresAt: admission.expiresAt,
			simBuild: admission.simBuild,
			mapUid: admission.mapUid,
			rulesHash: admission.rulesHash,
		}
		this.mpBusy = true
		this.mpRoom = room
		if (this.sessionMpMode) this.sessionMpMode.textContent = 'Ranked multiplayer · verified admission'
		try {
			await this.mpJoinCommon(rankedEndpoint.toString(), '', auth.user.callsign)
			this.openMpSetup(room)
			if (this.rankedStatus) this.rankedStatus.textContent = 'Joined the ranked room. Ready up when you are set.'
		} catch (error) {
			if (this.rankedStatus) this.rankedStatus.textContent = this.rankedMessage(error, 'Ranked room join failed. No unranked fallback was used.')
		} finally { this.mpBusy = false }
	}

	/** 1 Hz fresh-probe poller for lobby, starting and playing (§7 rule 4). */
	private startMpLobbyPolling(): void {
		if (this.mpLobbyTimer !== null) return
		this.startMpPlayersPolling()
		this.mpLobbyTimer = window.setInterval(() => void this.mpSessionTick(), 1000)
	}

	private stopMpLobbyPolling(): void {
		if (this.mpLobbyTimer !== null) {
			clearInterval(this.mpLobbyTimer)
			this.mpLobbyTimer = null
		}
	}

	private stopMpPlayersPolling(): void {
		if (this.mpPlayersTimer !== null) {
			clearInterval(this.mpPlayersTimer)
			this.mpPlayersTimer = null
		}
	}

	/** One tick of the §5.10 table: disconnect and desync first (they end the
	 *  session from any phase), then started=True (lobby → starting), then the
	 *  lobby rule itself. Stale probes (another join's epoch) are ignored. */
	private async mpSessionTick(): Promise<void> {
		const mp = this.mpBridge()
		if (!mp) return
		if (this.mpPhase !== 'lobby' && this.mpPhase !== 'starting' && this.mpPhase !== 'playing') return
		let probe: string
		try { probe = await mp.probeConnection() } catch { return }
		if (mpProbeEpoch(probe) !== this.mpEpoch) return
		if (/state=NotConnected/.test(probe)) {
			this.mpSetPhase('ended')
			await this.mpShowEndBanner('S16')
			return
		}
		if (this.mpPhase === 'playing') {
			if (/outofsync=True/.test(probe)) {
				this.mpSetPhase('ended')
				await this.mpShowEndBanner('S15')
			}
			return
		}
		if (/started=True/.test(probe)) {
			this.mpPhase = 'starting'
			if (this.mpLobbyNote) this.mpLobbyNote.textContent = MP_STRINGS.S12c
			return
		}
		await this.mpLobbyTick(probe)
	}

	/** The lobby rule (L8): nobody is auto-readied. The client here only renders
	 *  state, offers Ready/Start/Add AI/Leave, and — exactly once, when admin
	 *  arrives on me — shrinks the room back to its advertised seat count. */
	private async mpLobbyTick(probe: string): Promise<void> {
		const mp = this.mpBridge()
		if (!mp) return
		const lobby = await mp.probeLobby().catch(() => '')
		const localIndex = /clientid=(\d+)/.exec(probe)?.[1] ?? ''
		const entries = (/clients=\[(.*)\]/.exec(lobby)?.[1] ?? '').split(';;').filter(Boolean)
		const humans = entries.filter(entry => !/bot:True/.test(entry))
		const mine = entries.find(entry => new RegExp(`(?:^|\\|)idx:${localIndex}(?:\\||$)`).test(entry)) ?? ''
		const iAmAdmin = /admin:True/.test(mine)
		const slots = Math.max(2, Number(this.mpRoom?.slots ?? 0) || 2)

		if (iAmAdmin && !this.mpAdminSeen) {
			this.mpAdminSeen = true
			// Surplus slots go the moment I hold admin (mechanism of
			// LobbyCloseEmptySlots, counted down — server validates admin only).
			await mp.lobbyCloseSlotsDownTo(slots).catch(() => {})
			// S13 only on handover: the creator was admin from the first tick.
			if (this.mpJoinedAsGuest) this.mpStatus(MP_STRINGS.S13)
		} else if (!iAmAdmin && !this.mpAdminSeen) {
			this.mpJoinedAsGuest = true
		}

		if (this.mpLobbyNote) {
			const otherUnready = humans.filter(entry => !new RegExp(`(?:^|\\|)idx:${localIndex}(?:\\||$)`).test(entry) && !/\|Ready\|/.test(entry)).length
			this.mpLobbyNote.textContent = this.mpStartRequested && otherUnready > 0
				? mpS12b(otherUnready)
				: mpS12a(humans.length, slots)
		}
		if (this.mpReadyButton) this.mpReadyButton.textContent = /clientstate=Ready/.test(probe) ? 'Not ready' : 'Ready'
		const admin = iAmAdmin
		if (this.mpStartButton) {
			this.mpStartButton.hidden = !admin
			// S12a: Start match is disabled below two humans until one more arrives.
			this.mpStartButton.disabled = humans.length < 2
			this.mpStartButton.title = humans.length < 2 ? 'Waiting for at least one more player' : ''
		}
		if (this.mpAddAiButton) this.mpAddAiButton.hidden = !admin
	}

	/** S15/S16 end-of-match banner. Both buttons leave WITHOUT a reload:
	 *  leaveMultiplayer tears the session down and the room browser returns. */
	private async mpShowEndBanner(kind: 'S15' | 'S16'): Promise<void> {
		this.startRankedSettlementPolling()
		if (this.mpBannerShown) return
		this.mpBannerShown = true
		const text = kind === 'S15'
			? MP_STRINGS.S15
			: mpS16(await this.mpCloseReason())
		this.ensureMpBanner()
		const banner = this.mpBanner
		if (!banner) return
		const message = banner.firstElementChild as HTMLElement
		const action = banner.lastElementChild as HTMLButtonElement
		message.textContent = text
		action.textContent = kind === 'S15' ? 'Leave game' : 'Back to menu'
		banner.hidden = false
	}

	/** §5.6 string for the transport close code, its raw reason, or the plain
	 *  "connection closed" fallback. */
	private async mpCloseReason(): Promise<string> {
		const mp = this.mpBridge()
		const close = mp ? await mp.getMpCloseInfo().catch(() => null) : null
		if (close && close.code !== 0) {
			const text = MP_STRINGS[closeCodeToStringId[close.code] ?? '']
			if (text) return text
		}
		return close?.reason || 'connection closed'
	}

	private ensureMpBanner(): void {
		if (this.mpBanner || !document.body) return
		const banner = document.createElement('div')
		banner.id = 'mp-match-banner'
		banner.setAttribute('role', 'alert')
		// Self-contained styling: the composed page's stylesheet is not this
		// node's; the banner must read as an alarm wherever it lands.
		banner.style.cssText =
			'position:fixed;left:0;right:0;bottom:0;z-index:60;margin:0 auto 28px;max-width:760px;' +
			'padding:14px 18px;background:rgba(38,8,4,.94);border:1px solid #ff795a;border-radius:4px;' +
			'color:#ffd9cf;font:14px/1.5 system-ui,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.7);' +
			'display:flex;gap:14px;align-items:center;justify-content:space-between'
		const message = document.createElement('span')
		message.className = 'mp-banner-text'
		const action = document.createElement('button')
		action.type = 'button'
		action.className = 'screen-action'
		action.style.cssText = 'width:auto;flex:0 0 auto;min-height:36px'
		action.addEventListener('click', () => void this.mpLeaveToSession())
		banner.append(message, action)
		document.body.append(banner)
		this.mpBanner = banner
	}

	/** §5.10 row "Leave" (every phase): leaveMultiplayer, then the session
	 *  screen comes back without a reload. */
	private async mpLeaveToSession(): Promise<void> {
		const mp = this.mpBridge()
		const rankedRoom = this.mpRoom?.ranked && this.mpRoom.matchId && this.mpRoom.settlement === 'pending' ? this.mpRoom : null
		try { if (mp) await mp.leaveMultiplayer() } catch { /* already gone */ }
		this.mpSetPhase('idle')
		if (rankedRoom) {
			this.mpRoom = rankedRoom
			this.rankedSettlementStarted = false
			this.startRankedSettlementPolling()
		}
		if (this.sessionRoot) this.sessionRoot.hidden = false
		this.music?.setInMatch?.(false)
		this.mpStatus('')
		this.selectSessionTab('mp')
	}

	/** The room plays the ambience chosen at creation time (host) or inherited
	 *  from the room settings (joiner). Unlike skirmish this does NOT lock the
	 *  in-game switch: MP ambience is a shared starting point, any player may
	 *  still change it locally. */
	private mpApplyRoomAmbience(): void {
		const settings = this.mpRoom?.settings ?? {}
		const sky = this.ctx?.get<SkyApi>('sky')
		sky?.setDaylightMode(settings.tod === 'day' || settings.tod === 'night' ? settings.tod as 'day' | 'night' : 'auto')
		sky?.setWeatherPreset(settings.weather === 'on' ? 'auto' : 'clear')
		this.renderDaylightChoice()
	}

	/** Lobby panel controls (S12a row): built once, shown with #mp-setup. */
	private ensureMpLobbyControls(): void {
		if (this.mpLobbyNote || !this.mpSetup) return
		const note = document.createElement('p')
		note.className = 'session-note mp-lobby-note'
		note.setAttribute('role', 'status')
		const bar = document.createElement('div')
		bar.className = 'mp-lobby-actions'
		// The console styles the bar by role; the texts stay exactly what the gates click.
		const flatButton = (label: string, role: string) => {
			const button = document.createElement('button')
			button.type = 'button'
			button.className = `screen-action mp-act mp-act--${role}`
			button.textContent = label
			return button
		}
		const ready = flatButton('Ready', 'ready')
		ready.addEventListener('click', () => void this.onMpReadyToggle())
		const start = flatButton('Start match', 'start')
		start.hidden = true
		start.addEventListener('click', () => void this.onMpAdminStart())
		const addAi = flatButton('Add AI', 'add')
		addAi.hidden = true
		addAi.addEventListener('click', () => { void this.mpBridge()?.lobbyAddBots() })
		const leave = flatButton('Leave game', 'leave')
		leave.addEventListener('click', () => void this.mpLeaveToSession())
		bar.append(ready, start, addAi, leave)
		this.mpSetup.append(note, bar)
		this.mpLobbyNote = note
		this.mpReadyButton = ready
		this.mpStartButton = start
		this.mpAddAiButton = addAi
	}

	/** Ready toggle: the server's clientstate is the truth; flip the order. */
	private async onMpReadyToggle(): Promise<void> {
		const mp = this.mpBridge()
		if (!mp) return
		const probe = await mp.probeConnection().catch(() => '')
		if (mpProbeEpoch(probe) !== this.mpEpoch) return
		if (/clientstate=Ready/.test(probe)) await mp.lobbySetNotReady()
		else await mp.lobbySetReady()
	}

	/** Admin Start match (L8): (re)sends `state Ready` — every press, even when
	 *  already Ready. NEVER startgame: the server's CheckAutoStart starts the
	 *  match when all humans and the admin are Ready. */
	private async onMpAdminStart(): Promise<void> {
		const mp = this.mpBridge()
		if (!mp) return
		this.mpStartRequested = true
		await mp.lobbySetReady()
	}

	/** T2.3 host-match rule: a room may only be joined at an endpoint its own
	 *  directory owns. The row's wsUrl is accepted verbatim when its hostname
	 *  equals the directory's — LAN rows (§5.7, whose wsUrl names the private,
	 *  link-local or loopback host the shell's beacon listener found) pass by
	 *  the same rule against their lanDir. A wss: endpoint is always legal;
	 *  ws: only on a plain-HTTP page (the shell serves loopback over http; an
	 *  HTTPS site must never downgrade the game socket to cleartext).
	 *  Returns '' after naming the refusal in the status line. */
	private resolveRoomUrl(room: { wsUrl?: string }, directoryUrl = this.getMpDir()): string {
		const refuse = (): '' => {
			this.mpStatus('That room advertises an endpoint outside its directory.')
			return ''
		}
		let ws: URL
		try { ws = new URL(room.wsUrl ?? '') } catch { return refuse() }
		if (!/^\/g\/[0-9a-f]+$/.test(ws.pathname)) {
			this.mpStatus('That room advertises an invalid endpoint path.')
			return ''
		}
		let dir: URL
		try { dir = new URL(directoryUrl, location.origin) } catch { return refuse() }
		if (ws.protocol !== 'wss:' && !(ws.protocol === 'ws:' && location.protocol === 'http:')) return refuse()
		// Host equality — or, on a local directory only, another local-class
		// host (a beacon row may name the advertising interface while the shell
		// itself reached the node over loopback).
		if (ws.hostname !== dir.hostname &&
			!(mpIsLocalHostname(ws.hostname) && mpIsLocalHostname(dir.hostname))) return refuse()
		// The production switch stays off during the private rollout. The relay
		// recognizes the explicit owner test flag on both HTTP placement and the
		// WebSocket upgrade; never add it for an ordinary visitor.
		if (new URLSearchParams(location.search).get('debug') === 'on') ws.searchParams.set('debug', 'on')
		return ws.toString()
	}

	/** Directory the mp panel talks to: the desktop shell's runtime override
	 *  (boot-once navigation, no reload) wins over the ?mpdir= URL param;
	 *  empty string = same origin (the room host serves this very page). */
	private getMpDir(): string {
		if (this.mpDirOverride !== null) return this.mpDirOverride
		return new URLSearchParams(location.search).get('mpdir') ?? ''
	}

	/** Bottom-left roster: poll once a second while a network session lives. */
	private startMpPlayersPolling(): void {
		if (this.mpPlayersTimer !== null) return
		this.renderMpPlayers()
		this.renderMpSlotRows()
		this.mpPlayersTimer = window.setInterval(() => {
			this.renderMpPlayers()
			this.renderMpSlotRows()
		}, 1000)
	}

	private selectSessionTab(requested: 'skirmish' | 'mp'): void {
		// A join link or a stale call cannot open a multiplayer screen that does not exist.
		const tab = requested === 'mp' && !this.mpEntryVisible() ? 'skirmish' : requested
		const skirmish = tab === 'skirmish'
		if (this.sessionModeState) this.sessionModeState.textContent = skirmish
			? 'Skirmish · rating eligible'
			: 'Multiplayer · room status determines ranked eligibility'
		if (this.sessionMpMode) this.sessionMpMode.textContent = this.mpRoom?.ranked === true
			? 'Ranked multiplayer · admission and settlement handled by the server'
			: 'Unranked multiplayer · results do not change rating'
		if (this.sessionTabSkirmish) this.sessionTabSkirmish.setAttribute('aria-selected', String(skirmish))
		if (this.sessionTabMp) this.sessionTabMp.setAttribute('aria-selected', String(!skirmish))
		if (this.sessionTabSkirmish) this.sessionTabSkirmish.tabIndex = skirmish ? 0 : -1
		if (this.sessionTabMp) this.sessionTabMp.tabIndex = skirmish ? -1 : 0
		if (this.sessionRoot) this.sessionRoot.dataset.view = skirmish ? 'skirmish' : 'mp'
		if (this.sessionSkirmishPanel) this.sessionSkirmishPanel.hidden = !skirmish
		if (this.sessionMpPanel) this.sessionMpPanel.hidden = skirmish
		if (this.sessionCopySkirmish) this.sessionCopySkirmish.hidden = !skirmish
		if (this.sessionCopyMp) this.sessionCopyMp.hidden = skirmish
		this.stopMpRoomsPolling()
		if (skirmish) {
			this.disarmMpLanLookup()
			return
		}
		this.renderMpHostOptions()
		// `off` is a network boundary, not just hidden controls. On the public
		// play origin a relative /v2/rooms URL reaches the relay, so returning
		// here is what guarantees zero directory requests until join/full (or
		// the explicit owner debug override) is active.
		if (this.effectiveMpMode() === 'off') {
			this.disarmMpLanLookup()
			return
		}
		// §7 rule 4: the room list polls only while the browser is the
		// visible screen AND the session is idle; Join/Host stop the timer
		// (mpSetPhase), Leave returns here.
		if (this.mpPhase === 'idle') {
			void this.refreshMpRooms()
			this.mpRoomsTimer = window.setInterval(() => void this.refreshMpRooms(), 5000)
			this.armMpLanLookup()
		}
	}

	/**
	 * Multiplayer is a destination only while it exists: the network switch is on (join or
	 * full), or a dev flag reveals the test surface. Off means no tab at all — not a tab
	 * with a notice behind it.
	 */
	private mpEntryVisible(): boolean {
		const query = new URLSearchParams(location.search)
		return this.effectiveMpMode() !== 'off' || query.get('mp') === '1' || query.get('debug') === 'on' || query.has('hostedon')
	}

	/** The mode nav shows only while there is more than one mode to choose. */
	private updateSessionNav(): void {
		const mpOn = this.mpEntryVisible()
		// A pinned mode (desktop menu, ?session=) already decided which tab exists.
		if (this.pinnedSession === null) this.sessionTabMp?.toggleAttribute('hidden', !mpOn)
		const visible = [this.sessionTabSkirmish, this.sessionTabMp].filter(tab => tab && !tab.hidden).length
		this.sessionNav?.toggleAttribute('hidden', visible < 2)
		if (!mpOn && this.sessionMpPanel && !this.sessionMpPanel.hidden) this.selectSessionTab('skirmish')
	}

	private stopMpRoomsPolling(): void {
		if (this.mpRoomsTimer !== null) {
			clearInterval(this.mpRoomsTimer)
			this.mpRoomsTimer = null
		}
	}

	/** Slot-count dropdown: 2..8, defaulting to 8. The engine caps matches; the
	 *  room browser shows whatever the room was created with. */
	/**
	 * Most players a hosted room on the selected map may seat: the map's own slot count, within
	 * the node's 2…5 (roomhost validateCreate rejects more, and the relay then answers a generic
	 * no-capacity). Before this, the choices ran to 8 on a 2-player map and hosting failed.
	 */
	private mpMapPlayerLimit(): number {
		return Math.min(5, Math.max(2, this.selectedMap()?.slots.length ?? 2))
	}

	/** Player-count choices for a hosted room, rebuilt whenever the selected map changes. */
	private populateMpSlotChoices(): void {
		const limit = this.mpMapPlayerLimit()
		for (const select of [this.sessionMpSlots, this.mpHostPlayers]) {
			if (!select) continue
			const current = Number(select.value)
			select.replaceChildren(...Array.from({ length: limit - 1 }, (_, i) => option(String(i + 2), `${i + 2} players`)))
			select.value = String(Number.isInteger(current) && current >= 2 && current <= limit ? current : limit)
		}
	}

	private mpSlotsFor(select: HTMLSelectElement | null): number {
		return Math.min(this.mpMapPlayerLimit(), Math.max(2, Number(select?.value ?? 2) || 2))
	}

	private mpNickname(): string {
		return this.sessionMpName?.value.trim() || 'Commander'
	}

	private restoreMpNickname(): void {
		if (!this.sessionMpName || this.sessionMpName.value) return
		// The landing and game can be on different origins. A room link carries
		// only the caller's chosen name; the engine's production allowlist also
		// permits Player.Name and no other launch argument.
		const linkedName = new URLSearchParams(location.search).get('Player.Name')?.trim() ?? ''
		if (linkedName && linkedName.length <= 20 && /^[\p{L}\p{N}_ .-]+$/u.test(linkedName)) {
			this.sessionMpName.value = linkedName
			return
		}
		try {
			this.sessionMpName.value = localStorage.getItem('steelthorn-nickname') ?? ''
		} catch { /* private mode: nickname just starts empty */ }
	}

	private loadMpOwnBuild(): Promise<void> {
		this.mpOwnBuildLoad ??= fetch('build.json', { cache: 'no-store', signal: AbortSignal.timeout(4000) })
			.then(res => res.ok ? res.json() : null)
			.then(payload => {
				const build = payload?.simBuild
				if (typeof build === 'string' && /^[0-9a-f]{12}$/.test(build)) this.mpOwnBuild = build
			})
			.catch(() => {})
		return this.mpOwnBuildLoad
	}

	/** A /play room link waits for both the simulation catalog and the runtime
	 * switch. The directory is fetched again after WASM boot, when the link's
	 * earlier row may already have started, filled, or disappeared. */
	private async joinFromLink(): Promise<void> {
		if (this.mpJoinLinkStarted || 'redline' in window) return
		const query = new URLSearchParams(location.search)
		if (!query.has('join') || !this.catalog || !this.sessionMap?.options.length || this.netConfig === null) return
		this.mpJoinLinkStarted = true
		const roomId = query.get('join') ?? ''
		const cleanUrl = new URL(location.href)
		cleanUrl.searchParams.delete('join')
		history.replaceState(history.state, '', cleanUrl)
		this.selectSessionTab('mp')
		if (!/^[0-9a-f]{16}$/.test(roomId)) { this.mpStatus(MP_STRINGS.S6); return }
		if (this.effectiveMpMode() === 'off' || !this.netConfig.relay) return
		await this.loadMpOwnBuild()
		if (!this.mpOwnBuild) { this.mpStatus('Could not check this game version. Please reload.'); return }
		try {
			const res = await fetch(new URL('/v2/rooms', `${this.netConfig.relay}/`), { cache: 'no-store', signal: AbortSignal.timeout(4000) })
			if (!res.ok) throw new Error(`rooms ${res.status}`)
			const room = mpRoomList(await res.json()).find(candidate => candidate.roomId === roomId)
			if (!room) { this.mpStatus(MP_STRINGS.S6); return }
			if (room.state !== 'lobby') { this.mpStatus(MP_STRINGS.S7); return }
			if ((room.players ?? 0) >= (room.slots ?? 0)) { this.mpStatus('That game is full.'); return }
			if (room.build !== this.mpOwnBuild) { this.mpStatus(MP_STRINGS.S11); return }
			if (!room.wsUrl) { this.mpStatus(MP_STRINGS.S6); return }
			await this.joinMpRoom(room)
		} catch {
			this.mpStatus(MP_STRINGS.S22)
			void this.refreshMpRooms()
		}
	}

	/**
	 * A signed-in or guest player's callsign is their multiplayer name, unless they typed one this
	 * session. Signing out hands a name the account filled in back to the player's own saved one.
	 */
	private prefillMpNickname(user: AccountUser | null): void {
		const field = this.sessionMpName
		if (!field) return
		const callsign = typeof user?.callsign === 'string' ? user.callsign.trim().slice(0, 24) : ''
		if (callsign && /^[\p{L}\p{N}_ .-]+$/u.test(callsign)) {
			if (this.mpNameTouched) return
			field.value = callsign
			this.mpNameFromAccount = callsign
			return
		}
		if (!user && this.mpNameFromAccount !== null && field.value === this.mpNameFromAccount) {
			let saved = ''
			try { saved = localStorage.getItem('steelthorn-nickname') ?? '' } catch { /* private mode */ }
			field.value = saved === this.mpNameFromAccount ? '' : saved
		}
		this.mpNameFromAccount = null
	}

	private persistMpNickname(): void {
		if (!this.sessionMpName) return
		try {
			if (this.sessionMpName.value.trim()) localStorage.setItem('steelthorn-nickname', this.sessionMpName.value.trim())
		} catch { /* private mode: nothing to persist */ }
	}


	/** A nickname is required for every network action: an unnamed player cannot
	 *  be told apart in the roster or the lobby. Returns null (after telling the
	 *  player and focusing the field) when it is missing. */
	private requireMpNickname(): string | null {
		const name = this.sessionMpName?.value.trim() ?? ''
		if (name.length > 0) return name
		this.mpStatus('Pick a nickname first — it shows in the player list.')
		this.sessionMpName?.focus()
		return null
	}
	// §5.1 effective state: the shell is always `full`; the browser follows
	// net-config.json. `?debug=on` (and its `hostedon` alias) is the owner's
	// testing escape hatch — it reveals the complete host/join UI while the
	// public switch is still `off`. Client-side only: the relay still enforces
	// its placement, build and origin policy server-side (§5.2), so this cannot
	// weaken the production boundary.
	private effectiveMpMode(): 'off' | 'join' | 'full' {
		// The Electron bridge and the keyed local-node hook are both host-capable
		// surfaces.  The latter is used by the LAN integration gates (and by a
		// manually attached local node), so it must reveal the same host controls;
		// otherwise applyMpSwitch hides the fields before mpHost can use the hook.
		// A normal browser has neither and still follows net-config.json fail-closed.
		// Inside the desktop shell the player's own Multiplayer switch decides.
		if ('redline' in window) return this.desktopMultiplayerOn() ? 'full' : 'off'
		if (asLocalNodeKey((globalThis as Record<string, unknown>)['__redlineLocalNode'])) return 'full'
		const query = new URLSearchParams(location.search)
		const debug = query.get('debug') === 'on' || query.has('hostedon')
		if (debug && this.netConfig?.relay) return 'full'
		return this.netConfig?.browserMultiplayer ?? 'off'
	}

	/** The desktop landing's Multiplayer switch; on when the shell predates it. */
	private desktopMultiplayerOn(): boolean {
		if (this.desktopMultiplayer === null) {
			try {
				const read = redlineBridge()?.getMultiplayerSync
				this.desktopMultiplayer = typeof read === 'function' ? read() !== false : true
			} catch {
				this.desktopMultiplayer = true
			}
		}
		return this.desktopMultiplayer
	}

	// T5.2: gate the MP tab content per §5.1. off → coming-soon notice with zero
	// relay requests; the private debug flag exposes the full test surface;
	// join → room browser, host column replaced by S2; full → as the desktop
	// sees it. Idempotent; re-runs when net-config.json resolves.
	private applyMpSwitch(): void {
		const mode = this.effectiveMpMode()
		const debugOverride = new URLSearchParams(location.search).get('debug') === 'on'
		const off = document.getElementById('session-mp-off')
		const identity = document.getElementById('session-mp-identity')
		const joinCol = document.getElementById('session-mp-join-col')
		const hostCol = document.getElementById('session-mp-host-col')
		const hostNote = document.getElementById('session-mp-host-note')
		if (this.rankedQueueRoot) this.rankedQueueRoot.hidden = !this.rankedUiGateOpen()
		if (off) off.toggleAttribute('hidden', mode !== 'off' || debugOverride)
		if (identity) identity.toggleAttribute('hidden', mode === 'off' && !debugOverride)
		if (joinCol) joinCol.toggleAttribute('hidden', mode === 'off' && !debugOverride)
		if (this.sessionMpRoomsBody?.closest('.session-mp-rooms-wrap')) this.sessionMpRoomsBody.closest('.session-mp-rooms-wrap')?.toggleAttribute('hidden', mode === 'off')
		if (hostCol) hostCol.toggleAttribute('hidden', mode !== 'full')
		if (hostNote) hostNote.toggleAttribute('hidden', mode !== 'join')
		// The briefing promises hosting only where the player can host (the desktop app).
		const copy = document.getElementById('session-copy-mp')
		if (copy) copy.textContent = mode === 'full'
			? 'Join a live network room, or host your own. The room browser refreshes automatically; rooms are matched by the OpenRA dedicated server.'
			: 'Join a live network room or play ranked. The room browser refreshes automatically; hosting runs in the desktop app.'
		if (mode === 'off') {
			this.stopMpRoomsPolling()
			this.disarmMpLanLookup()
		}
		// Browser join reaches the relay by its absolute URL (§5.2) — this is
		// what resolves defect A0; the apex domain needs no /g/* routes.
		const localNode = asLocalNodeKey((globalThis as Record<string, unknown>)['__redlineLocalNode'])
		if (mode !== 'off' && !('redline' in window) && !localNode && this.netConfig?.relay && this.mpDirOverride === null) {
			this.mpDirOverride = this.netConfig.relay
			if (mode === 'full') void this.mpProbeRelayConfig()
			if (this.sessionTabMp && !this.sessionTabMp.disabled) void this.refreshMpRooms()
		}
		this.updateSessionNav()
	}

	/**
	 * Poll the room directory and reconcile the merged room list (§7 rule 3):
	 * one table, LAN rooms first, a room present in both shown once as LAN.
	 * Rows are keyed by roomId and updated IN PLACE — never rebuilt wholesale —
	 * so a click cannot land on a node that is being replaced (T1.18). The game
	 * itself never depends on this: local skirmish stays available either way.
	 */
	private async refreshMpRooms(): Promise<void> {
		const status = this.sessionMpStatus
		if (!this.sessionMpRoomsBody || !status) return
		if (this.mpPhase !== 'idle') return
		if (this.effectiveMpMode() === 'off') return
		const dir = this.getMpDir()
		try {
			// §5.2/§5.3: both directories wrap the rows in { rooms }. The node
			// also reports booting/reserved; the browser lists only joinable
			// states (rows without a state stay listed, as legacy rows were).
			const res = await fetch(`${dir}/v2/rooms`, { signal: AbortSignal.timeout(4000) })
			if (!res.ok) throw new Error(`answered ${res.status}`)
			const rooms = mpRoomList(await res.json())
				.filter(room => !room.state || room.state === 'lobby' || room.state === 'playing')
			this.mpRelayRooms = new Map(rooms.map(room => [room.roomId, room]))
			this.mpRoomsFetchFailed = false
		} catch {
			this.mpRelayRooms = new Map()
			this.mpRoomsFetchFailed = true
			this.mpRoomsEmptyNote = this.mpRoomsFetchMessage(dir)
		}
		this.renderMpRoomList()
	}

	/** Reconcile the room browser: LAN feed first, then relay rooms not already
	 *  covered by the LAN feed; per-key in-place updates, vanished keys removed. */
	private renderMpRoomList(): void {
		const body = this.sessionMpRoomsBody
		const status = this.sessionMpStatus
		if (!body || !status) return

		// §7 rule 3: one list, LAN first, same-roomId relay duplicates dropped.
		const merged: { room: MpRoomSummary; lan: boolean }[] = [...this.mpLanFeed.values()]
			.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
			.map(room => ({ room, lan: true }))
		for (const [roomId, room] of [...this.mpRelayRooms.entries()].sort(([, a], [, b]) => (b.createdAt ?? 0) - (a.createdAt ?? 0))) {
			if (!this.mpLanFeed.has(roomId)) merged.push({ room, lan: false })
		}

		if (merged.length === 0) {
			this.mpRoomRows.clear()
			body.replaceChildren(...[elem('tr', {}, [elem('td', { colspan: '5', class: 'room-empty' }, [
				this.mpRoomsFetchFailed ? this.mpRoomsEmptyNote : 'No network rooms found — host one below.',
			])])])
			status.textContent = this.mpRoomsFetchFailed
				? 'Local skirmish still works — switch to the Skirmish tab.'
				: ''
			return
		}
		status.textContent = `${merged.length} network room${merged.length === 1 ? '' : 's'} found.`
		// The static "Checking for network rooms…" row (and any empty-state row) is not a room:
		// reconciling only touched rows with an id, so it stayed on top of the list.
		for (const stale of body.querySelectorAll('tr:not([data-room-id])')) stale.remove()

		const seen = new Set<string>()
		for (const { room, lan } of merged) {
			const roomId = room.roomId!
			seen.add(roomId)
			let row = this.mpRoomRows.get(roomId)
			if (!row) {
				row = this.buildMpRoomRow(room, lan)
				this.mpRoomRows.set(roomId, row)
			}
			this.updateMpRoomRow(row, room, lan)
			// appendChild moves an existing node into place: the merged order
			// holds without rebuilding a single row.
			body.appendChild(row)
		}
		for (const [roomId, row] of [...this.mpRoomRows]) {
			if (!seen.has(roomId)) {
				row.remove()
				this.mpRoomRows.delete(roomId)
			}
		}
	}

	private mpRoomsFetchMessage(dir: string): string {
		return dir
			? `No answer from ${dir} — the relay may be offline.`
			: 'No room host found on this network.'
	}

	/** Fresh row with the five fixed cells and the Join button; only cell
	 *  CONTENT is refreshed afterwards. */
	private buildMpRoomRow(room: MpRoomSummary, lan: boolean): HTMLTableRowElement {
		const roomId = room.roomId ?? ''
		const row = document.createElement('tr')
		row.dataset.roomId = roomId
		row.dataset.lan = String(lan)
		for (let i = 0; i < 4; i++) row.append(document.createElement('td'))
		const joinCell = document.createElement('td')
		joinCell.className = 'room-join'
		const join = elem('button', { type: 'button' }, ['Join'])
		// The handler reads the row's CURRENT room data at click time: an
		// in-place refresh between render and click can never join a stale
		// snapshot, and the LAN table's lanDir wins over the relay's (§7 rule 3).
		join.addEventListener('click', () => {
			const lanRoom = this.mpLanFeed.get(roomId)
			const current = lanRoom ?? this.mpRelayRooms.get(roomId)
			if (!current) return
			this.fireLaunchShot()
			void this.joinMpRoom(current, lanRoom?.lanDir)
		})
		joinCell.append(join)
		row.append(joinCell)
		return row
	}

	/** Joinability (§7 rule 3): lobby rooms with a free seat and an accepted
	 *  build offer Join; started rooms read "In progress"; full rooms "Full";
	 *  a foreign build greys the row with S11; locked rooms keep Join (the
	 *  password is asked on click). */
	private updateMpRoomRow(row: HTMLTableRowElement, room: MpRoomSummary, lan: boolean): void {
		const cells = row.querySelectorAll('td')
		const name = room.name ?? `Room-${room.roomId?.slice(0, 6) ?? '?'}`
		const span = (className: string, text: string): HTMLSpanElement => {
			const node = document.createElement('span')
			node.className = className
			node.textContent = text
			return node
		}
		const extra = room as { ranked?: boolean; hostName?: string }
		const tags = [lan ? 'LAN' : '', extra.ranked === true ? 'Ranked' : ''].filter(Boolean)
		cells[0]!.replaceChildren(span('room__name', room.locked ? `🔒 ${name}` : name), ...tags.map(tag => span('tag', tag)),
			...(extra.hostName ? [span('room__host', `hosted by ${extra.hostName}`)] : []))
		const mapTitle = this.mpRoomMapTitle(room) || '—'
		const uid = typeof room.map === 'string' ? room.map : room.map?.uid
		const known = this.catalog?.maps.find(m => m.uid === uid)
		cells[1]!.replaceChildren(span('room__map', mapTitle), ...(known ? [span('room__size', `${known.bounds.width}×${known.bounds.height}`)] : []))
		const seats = Math.max(0, Math.min(12, room.slots ?? 0))
		const taken = Math.max(0, room.players ?? 0)
		const pips = document.createElement('span')
		pips.className = 'pips'
		pips.setAttribute('aria-hidden', 'true')
		for (let i = 0; i < seats; i++) pips.append(Object.assign(document.createElement('i'), { className: i < taken ? 'on' : '' }))
		cells[2]!.replaceChildren(pips, span('room__count', `${taken} / ${room.slots ?? '?'}`))
		cells[3]!.textContent = lan ? 'LAN' : (room.geo ?? '')

		const join = row.querySelector<HTMLButtonElement>('.room-join button')!
		// A foreign build greys the row (S11). The sim-build stamp ships with T2.1;
		// until then the page knows no own build and every advertised build is
		// accepted — the check activates the moment mpOwnBuild is filled.
		const foreignBuild = typeof room.build === 'string' && room.build !== '' &&
			this.mpOwnBuild !== '' && room.build !== this.mpOwnBuild
		const started = room.state === 'playing'
		const full = (room.players ?? 0) >= (room.slots ?? Infinity)
		if (!canJoinFromRoomList(this.mpPhase, this.mpBusy)) {
			join.disabled = true
			join.textContent = this.mpPhase === 'lobby' || this.mpPhase === 'starting' ? 'In lobby' : 'Connecting…'
		} else if (started) {
			join.disabled = true
			join.textContent = 'In progress'
		} else if (full) {
			join.disabled = true
			join.textContent = 'Full'
		} else if (foreignBuild) {
			join.disabled = true
			join.textContent = MP_STRINGS.S11
			join.title = MP_STRINGS.S11
		} else {
			join.disabled = false
			join.textContent = 'Join'
		}
		row.classList.toggle('room-unavailable', join.disabled)
	}

	private renderLanRooms(rooms: LanRoomRow[]): void {
		const rows = Array.isArray(rooms) ? rooms.filter(room => room && room.roomId && typeof room.lanDir === 'string') : []
		this.mpLanFeed = new Map(rows.map(room => [room.roomId!, room]))
		// S18 (T3.7): any LAN row answers the lookup; an emptied feed (the
		// listener's 10 s expiry flush) re-arms the 8 s reveal while the
		// browser screen is the visible one.
		if (rows.length > 0) this.disarmMpLanLookup()
		else if (this.mpPhase === 'idle' && this.sessionMpPanel && !this.sessionMpPanel.hidden) this.armMpLanLookup()
		this.renderMpRoomList()
	}

	/** Host entry. The desktop and local harness use their keyed own node; a
	 *  browser in `full` (including the private debug rollout) asks the relay to
	 *  place an unranked room on donated/owner capacity.
	 *  - desktop shell (`redline.hostStart`): dialog S19 first; the shell
	 *    starts the local node on demand (§5.9) when the player confirms;
	 *  - an already-running local node (`__redlineLocalNode`, dev harness and
	 *    the mp gates): straight keyed POST with the panel's fields;
	 *  - a full-mode browser: relay placement (T6.9). */
	private async mpHost(): Promise<void> {
		if (this.mpBusy) return
		if (!this.sessionMap?.value) {
			// The catalog has not finished loading; POSTing now would just
			// bounce off the node with a 400.
			this.mpStatus('Map catalog still loading — try again in a moment.')
			return
		}
		if (redlineBridge()?.hostStart) {
			// The nickname first, so focus never jumps behind the modal.
			if (!this.requireMpNickname()) return
			this.openMpHostDialog()
			return
		}
		const shell = globalThis as Record<string, unknown>
		const localNode = asLocalNodeKey(shell['__redlineLocalNode'])
		if (!localNode) {
			if (this.effectiveMpMode() === 'full' && this.netConfig?.relay) await this.mpCreatePlacedRoom()
			else this.mpStatus(MP_STRINGS.S2)
			return
		}
		const name = this.requireMpNickname()
		if (!name) return
		this.mpBusy = true
		await this.mpCreateLocalRoom(name, localNode, null)
	}

	private async mpCreatePlacedRoom(): Promise<void> {
		const name = this.requireMpNickname()
		if (!name || !this.sessionMap?.value || this.mpBusy) return
		await this.mpProbeRelayConfig()
		if (this.mpRelayCapacityAvailable === false) { this.mpStatus(MP_STRINGS.S23); return }
		const dir = this.netConfig?.relay ?? this.getMpDir()
		if (!dir) { this.mpStatus(MP_STRINGS.S22); return }
		this.mpBusy = true
		try {
			this.persistMpNickname()
			this.mpStatus('Finding hosted match capacity…')
			const endpoint = new URL('/v2/rooms', `${dir}/`)
			if (new URLSearchParams(location.search).get('debug') === 'on') endpoint.searchParams.set('debug', 'on')
			const response = await fetch(endpoint, {
				method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					map: this.sessionMap.value,
					slots: this.mpSlotsFor(this.sessionMpSlots),
					name: this.sessionMpRoomName?.value.trim() || `${name}'s game`,
					settings: { gamespeed: this.mpHostOptions.gamespeed ?? this.sessionSpeed?.value, tod: this.mpTod, weather: this.mpWeather },
				}),
				signal: AbortSignal.timeout(20_000),
			})
			const payload = await response.json().catch(() => ({})) as { error?: string }
			if (!response.ok) {
				if (response.status === 503 || payload.error === 'no-capacity') throw new Error(MP_STRINGS.S23)
				throw new Error(payload.error || `relay answered ${response.status}`)
			}
			const room = mpCreatedRoom(payload)
			if (!room?.wsUrl || !room.hostKey) throw new Error('relay returned an incomplete host claim')
			const join = new URL(room.wsUrl)
			join.searchParams.set('k', room.hostKey)
			if (new URLSearchParams(location.search).get('debug') === 'on') join.searchParams.set('debug', 'on')
			this.mpRoom = room
			if (this.sessionMpMode) this.sessionMpMode.textContent = 'Unranked hosted multiplayer · results do not change rating'
			this.mpStatus('Hosted room reserved — connecting as administrator…')
			await this.mpJoinCommon(join.toString())
			this.openMpSetup(room)
			for (const [id, value] of Object.entries(this.mpHostOptions)) await this.mpBridge()?.lobbySetOption(id, value).catch(() => {})
		} catch (error) {
			if (!(error instanceof MpJoinRefused)) this.mpStatus(mpHostFailure(error))
		} finally { this.mpBusy = false }
	}

	/** S19 "Create game" (T3.1/T3.3): map the dialog fields, have the shell
	 *  start the node on demand, then create the room on it. */
	private async mpHostFromDialog(): Promise<void> {
		const bridge = redlineBridge()
		if (!bridge?.hostStart || !this.mpHostDialog || this.mpHostDialog.hidden || this.mpBusy) return
		const name = this.requireMpNickname()
		if (!name) return
		const visibility = this.mpHostVisPublic?.checked && !this.mpHostVisPublic.disabled ? 'public' as const : 'lan' as const
		const choice: MpHostChoice = {
			slots: this.mpSlotsFor(this.mpHostPlayers),
			password: (this.mpHostPassword?.value ?? '').trim(),
		}
		this.closeMpHostDialog()
		this.mpBusy = true
		try {
			// §5.9: the shell validates the visibility, spawns the node (`--lan`,
			// or `--spine --mode own` for public) and answers {dir,key} once its
			// /v2/health is up; anything else is S21.
			const node = asLocalNodeKey(await bridge.hostStart({ visibility }))
			if (!node) {
				this.mpStatus(MP_STRINGS.S21)
				return
			}
			await this.mpCreateLocalRoom(name, node, choice)
		} catch {
			this.mpStatus(MP_STRINGS.S21)
		} finally {
			this.mpBusy = false
		}
	}

	/** Create the room on the keyed local node (§5.3 + §5.9): POST → T2.4
	 *  reserved polling → join the loopback wsUrl. `choice` carries the S19
	 *  dialog's Players/password; the mp-gate path passes null and keeps the
	 *  panel's own room-name and slot fields. Caller owns the mpBusy flag. */
	private async mpCreateLocalRoom(name: string, localNode: { dir: string; key: string }, choice: MpHostChoice | null): Promise<void> {
		if (!this.sessionMap?.value) return
		try {
			this.persistMpNickname()
			const dir = localNode.dir
			// The host card's Room name wins on every path; "<nickname>'s game" otherwise.
			const roomName = this.sessionMpRoomName?.value.trim() || `${name}'s game`
			this.mpStatus('Requesting a room from the room host…')
			// §5.3 request. The node defaults solo to false: the dedicated waits
			// for EVERY human to be ready before starting, so the second player
			// can still join (the listen socket closes at game start — late
			// joins are impossible). The key header travels on POST/DELETE only.
			const res = await fetch(`${dir}/v2/rooms`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-redline-node-key': localNode.key,
				},
				body: JSON.stringify({
					map: this.sessionMap.value,
					slots: choice ? choice.slots : this.mpSlotsFor(this.sessionMpSlots),
					name: roomName,
					...(choice?.password ? { password: choice.password } : {}),
					settings: { gamespeed: this.mpHostOptions.gamespeed ?? this.sessionSpeed?.value, tod: this.mpTod, weather: this.mpWeather },
				}),
				// A hung directory must not hold the Host button hostage (T1.18).
				signal: AbortSignal.timeout(10_000),
			})
			if (!res.ok) throw new Error(`room host answered ${res.status}`)
			// T2.4: create answers at once with state "booting" (L16: no
			// blocking wait) — the dedicated server is still coming up.
			const created = mpCreatedRoom(await res.json())
			if (!created) throw new Error('room host answered without a room')
			// The host's own ambience choice rides with the room, so the joiner's
			// first snapshot inherits the same starting point.
			created.settings = { ...created.settings, tod: this.mpTod, weather: this.mpWeather }

			// T2.4/S20: poll the node every 500 ms until the room is "reserved"
			// (the dedicated accepts TCP); 30 s without it → S21 and DELETE.
			this.mpStatus(MP_STRINGS.S20)
			const reserved = await this.mpAwaitRoomReserved(dir, created.roomId)
			if (!reserved) {
				this.mpStatus(MP_STRINGS.S21)
				// §5.3 DELETE (key-guarded): kill the room the node failed to reserve.
				await fetch(`${dir}/v2/rooms/${encodeURIComponent(created.roomId)}`, {
					method: 'DELETE',
					headers: {
						'content-type': 'application/json',
						'x-redline-node-key': localNode.key,
					},
					signal: AbortSignal.timeout(5000),
				}).catch(() => {})
				return
			}

			created.wsUrl = reserved.wsUrl
			const endpoint = this.resolveRoomUrl(created, dir)
			if (!endpoint) return
			this.mpStatus(`Room "${roomName}" is live — share this link: ${endpoint}`)
			this.mpRoom = created
			if (this.sessionMpMode) this.sessionMpMode.textContent = created.ranked === true
				? 'Ranked multiplayer · admission and settlement handled by the server'
				: 'Unranked multiplayer · results do not change rating'
			await this.mpJoinCommon(endpoint)
			this.openMpSetup(created)
			// Host = admin: push every chosen map option into the dedicated lobby.
			// Equal values are ignored server-side. Lobby rule L8 from here: no
			// auto-ready, no start loop — the 1 Hz lobby tick drives the panel and
			// the server's CheckAutoStart starts the match.
			for (const [id, value] of Object.entries(this.mpHostOptions)) {
				await this.mpBridge()?.lobbySetOption(id, value).catch(() => {})
			}
		} catch (error) {
			// MpJoinRefused already named its cause in the status line (§5.10);
			// anything else is a hosting failure of our own making.
			if (!(error instanceof MpJoinRefused)) {
				this.mpStatus(mpHostFailure(error))
			}
		} finally {
			this.mpBusy = false
		}
	}

	/** S19 (T3.3): the dialog opens over the session panel; the relay config
	 *  probe runs beside it so "Anyone online" reflects the directory. */
	private openMpHostDialog(): void {
		if (!this.mpHostDialog || this.mpHostOverlay) return
		void this.mpProbeRelayConfig()
		// The host card's Max players carries into the dialog.
		const cardSlots = this.sessionMpSlots?.value
		if (this.mpHostPlayers && cardSlots && [...this.mpHostPlayers.options].some(o => o.value === cardSlots)) this.mpHostPlayers.value = cardSlots
		this.mpHostOverlay = openOverlay(this.mpHostDialog, {
			opener: this.sessionMpHost,
			initial: this.mpHostVisLan,
			onClose: () => { this.mpHostOverlay = null },
		})
	}

	private closeMpHostDialog(): void {
		if (this.mpHostOverlay) this.mpHostOverlay.close()
		else if (this.mpHostDialog) this.mpHostDialog.hidden = true
	}

	/** T3.3: "Anyone online" stays disabled until the relay's /v2/config has
	 *  answered (S22 when it never does). The desktop shell hands the relay
	 *  URL to __steelseedSetMpDir; the browser falls back to ?mpdir=. One
	 *  async fetch per session, cached — the dialog never re-stalls on a
	 *  dead relay, and LAN hosting never depends on it. */
	private async mpProbeRelayConfig(): Promise<void> {
		if (this.mpRelayConfigOk === null) {
			const dir = this.getMpDir()
			let ok = false
			if (dir !== '') {
				try {
					const res = await fetch(`${dir}/v2/config`, { signal: AbortSignal.timeout(4000) })
					ok = res.ok
					if (res.ok) {
						const config = await res.json() as { capacity?: { donatedFree?: unknown; ownerFree?: unknown } }
						this.mpRelayCapacityAvailable = Number(config.capacity?.donatedFree ?? 0) + Number(config.capacity?.ownerFree ?? 0) > 0
					}
				} catch {
					ok = false
				}
			}
			this.mpRelayConfigOk = ok
		}
		this.applyMpRelayConfig()
	}

	private applyMpRelayConfig(): void {
		const ok = this.mpRelayConfigOk === true
		if (this.mpHostVisPublic) this.mpHostVisPublic.disabled = !ok
		if (this.mpHostOnlineNote) {
			this.mpHostOnlineNote.hidden = this.mpRelayConfigOk !== false
			if (!this.mpHostOnlineNote.hidden) this.mpHostOnlineNote.textContent = MP_STRINGS.S22
		}
		// A negative verdict landing after the player ticked "Anyone online"
		// falls back to the LAN choice, which never depends on the relay.
		if (!ok && this.mpHostVisPublic?.checked) {
			this.mpHostVisPublic.checked = false
			if (this.mpHostVisLan) this.mpHostVisLan.checked = true
		}
		const browserPlaced = !redlineBridge()?.hostStart && !asLocalNodeKey((globalThis as Record<string, unknown>)['__redlineLocalNode']) && this.effectiveMpMode() === 'full'
		if (browserPlaced && this.sessionMpHost) {
			this.sessionMpHost.disabled = !ok || this.mpRelayCapacityAvailable === false
			if (this.mpRelayCapacityAvailable === false) this.sessionMpHost.title = MP_STRINGS.S23
			else this.sessionMpHost.removeAttribute('title')
		}
	}

	/** S18 (T3.7): the multiplayer screen announces the LAN sweep; after 8 s
	 *  of zero LAN rows the address form reveals itself. Browser pages have
	 *  no `redline.lanQuery` to fire the unicast query with, so the block
	 *  never shows there at all. */
	private armMpLanLookup(): void {
		if (!redlineBridge()?.lanQuery || !this.mpLanLookup || !this.mpLanLookupNote || !this.mpLanAddressForm) return
		if (this.mpLanFeed.size > 0) return
		this.mpLanLookupNote.textContent = MP_STRINGS.S18
		this.mpLanAddressForm.hidden = true
		this.mpLanLookup.hidden = false
		if (this.mpLanLookupTimer !== null) window.clearTimeout(this.mpLanLookupTimer)
		this.mpLanLookupTimer = window.setTimeout(() => this.revealMpLanAddress(), 8000)
	}

	private revealMpLanAddress(): void {
		this.mpLanLookupTimer = null
		if (!this.mpLanLookup || !this.mpLanLookupNote || !this.mpLanAddressForm) return
		if (this.mpLanFeed.size > 0) return
		this.mpLanLookupNote.textContent = MP_STRINGS.S18b
		this.mpLanAddressForm.hidden = false
		this.mpLanAddressInput?.focus()
	}

	private disarmMpLanLookup(): void {
		if (this.mpLanLookupTimer !== null) {
			window.clearTimeout(this.mpLanLookupTimer)
			this.mpLanLookupTimer = null
		}
		if (this.mpLanLookup) this.mpLanLookup.hidden = true
	}

	private readonly onMpAddressSubmit = (event: Event): void => {
		event.preventDefault()
		const input = this.mpLanAddressInput
		if (!input) return
		const value = input.value.trim()
		// L13/T3.7: private, loopback and link-local IPv4 or a `.local` name —
		// nothing that could dial outside the player's own network.
		if (!isMpLanAddress(value)) {
			input.setAttribute('aria-invalid', 'true')
			return
		}
		input.removeAttribute('aria-invalid')
		// §5.9: the shell asks its LAN listener for a unicast query; rooms
		// come back through __steelseedLanRooms like any other row.
		void redlineBridge()?.lanQuery?.(value)
	}

	/** T2.4: poll the node's GET /v2/rooms every 500 ms until the created room
	 *  reaches `reserved` (its dedicated server accepts TCP) or the 30 s budget
	 *  is spent. A row already showing `ended` fails fast — the node killed the
	 *  room. A lost or slow poll is retried until the deadline. */
	private async mpAwaitRoomReserved(dir: string, roomId: string): Promise<MpRoomSummary | null> {
		const deadline = Date.now() + 30_000
		while (Date.now() < deadline) {
			try {
				const res = await fetch(`${dir}/v2/rooms`, { signal: AbortSignal.timeout(4000) })
				if (res.ok) {
					const room = mpRoomList(await res.json()).find(candidate => candidate.roomId === roomId)
					if (room?.state === 'reserved') return room
					if (room?.state === 'ended') return null
				}
			} catch { /* retried until the deadline */ }
			await mpDelay(500)
		}
		return null
	}


	/** The locked-room password, asked in the console. Resolves null when cancelled. */
	private promptRoomPassword(room: MpRoomSummary): Promise<string | null> {
		const dialog = document.getElementById('mp-password-dialog')
		const form = document.getElementById('mp-password-form') as HTMLFormElement | null
		const input = document.getElementById('mp-password-input') as HTMLInputElement | null
		const cancel = document.getElementById('mp-password-cancel')
		const label = document.getElementById('mp-password-room')
		if (!dialog || !form || !input || !cancel) return Promise.resolve(null)
		if (label) label.textContent = room.name ?? 'This room'
		input.value = ''
		return new Promise(resolve => {
			let settled = false
			let overlay: Overlay | null = null
			const finish = (value: string | null): void => {
				if (settled) return
				settled = true
				form.removeEventListener('submit', onSubmit)
				cancel.removeEventListener('click', onCancel)
				overlay?.close()
				resolve(value)
			}
			const onSubmit = (event: Event): void => { event.preventDefault(); finish(input.value) }
			const onCancel = (): void => finish(null)
			form.addEventListener('submit', onSubmit)
			cancel.addEventListener('click', onCancel)
			overlay = openOverlay(dialog, { initial: input, onClose: () => finish(null) })
		})
	}

	private async joinMpRoom(room: MpRoomSummary, dir?: string): Promise<void> {
		if (!canJoinFromRoomList(this.mpPhase, this.mpBusy)) return
		const name = this.requireMpNickname()
		if (!name) return
		const endpoint = this.resolveRoomUrl(room, dir)
		if (!endpoint) return
		// Locked rooms (L7) ask for the native server password before connecting;
		// cancelling the prompt abandons the join.
		let password = ''
		if (room.locked) {
			const answer = await this.promptRoomPassword(room)
			if (answer === null) return
			password = answer
		}
		this.mpBusy = true
		try {
			this.mpRoom = room
			if (this.sessionMpMode) this.sessionMpMode.textContent = room.ranked === true
				? 'Ranked multiplayer · admission and settlement handled by the server'
				: 'Unranked multiplayer · results do not change rating'
			this.mpStatus(room.ranked === true
				? 'Checking ranked admission…'
				: 'Joining unranked room…')
			await this.mpJoinCommon(endpoint, password)
			this.openMpSetup(room)
			// Lobby rule L8: the joiner sits NotReady until they press Ready; the
			// admin's Start match and the server's CheckAutoStart run the room.
		} catch (error) {
			// MpJoinRefused already named its cause in the status line (§5.10).
			if (!(error instanceof MpJoinRefused)) {
				this.mpStatus(`Network join failed: ${error instanceof Error ? error.message : String(error)}`)
			}
		} finally {
			this.mpBusy = false
			this.renderMpRoomList()
		}
	}

	private startConfiguredSkirmish(): void {
		const ctx = this.ctx
		if (!ctx || !ctx.session.available || this.waitingForStart) return
		this.waitingForStart = true
		this.pendingBaseFocus = true
		// A fresh match starts with a clean heat map: nothing carried over from the
		// previous fight may warm the new tactical overlay.
		this.heatGrid.clear()
		this.lastHeatTick = 0
		this.stopTutorial()
		this.outcomeRendered = false
		this.sessionError = ''
		this.eva?.unlock()
		this.eva?.reset()
		this.evaLowPower = false
		this.evaOutcomeSpoken = false
		if (this.outcomeRoot) this.outcomeRoot.hidden = true
		if (this.sessionRoot) {
			this.sessionRoot.hidden = false
			this.sessionRoot.dataset.state = 'loading'
		}
		this.music?.setInMatch?.(false)
		if (this.sessionStart) this.sessionStart.disabled = true
		if (this.sessionStatus) this.sessionStatus.textContent = 'Validating setup and starting the local OpenRA server…'

		// Yield one task so the explicit loading state paints before synchronous map generation.
		setTimeout(async () => {
			if (!this.ctx || !this.waitingForStart) return
			try {
				this.mpMatch = false
				const config = this.collectStartConfig()
				// The announcer speaks the player's own faction family for the whole match.
				this.localFactionId = config.local.faction
				this.eva?.setFactionFamily(config.local.faction)
				this.setSfxFaction(config.local.faction)
			const result = await this.ctx.session.startSkirmish(config)
				if (result.status === 'error') throw new StartRefused(result.code, result.userMessage)
				// Leaderboard: remember what this match is so the outcome sheet can report it.
				beginMatchReport({
					mode: 'skirmish',
					map: this.selectedMap()?.title ?? config.mapUid,
					faction: config.local.faction,
					opponents: config.slots.filter(slot => slot.kind === 'bot').map(slot => ({ kind: 'bot' as const, bot: slot.botType })),
				})
				// The lobby owns the presentation choices for the match: time of day pins or
				// follows the clock (locking the in-game switch for Day/Night), and weather
				// picks the clear sky or the rotation where rain, storm, snow and mud rotate.
				const tod = this.sessionOptions?.querySelector<HTMLSelectElement>('select[data-field="tod"]')?.value
				this.applySessionDaylight(tod === 'day' || tod === 'night' || tod === 'world' ? tod : 'auto')
				const weather = this.sessionOptions?.querySelector<HTMLSelectElement>('select[data-field="weather"]')?.value
				const skyApi = this.ctx.get<SkyApi>('sky')
				if (weather === 'live') {
					// World mode: sync the battlefield to the real weather outside.
					skyApi?.setWeatherPreset('live')
					this.mpStatus('Fetching live weather for your region…')
					void import('../sky/live')
						.then(({ fetchLiveWeather }) => fetchLiveWeather())
						.then(live => {
							skyApi?.setLiveWeather(live.kind, live.intensity, live.windSpeed)
							this.mpStatus(`Live weather synced — ${live.summary}`)
						})
						.catch(() => {
							skyApi?.setWeatherPreset('clear')
							this.mpStatus('Live weather unavailable — clear skies.')
						})
				} else {
					skyApi?.setWeatherPreset(weather === 'on' ? 'auto' : 'clear')
				}
				this.eva?.say('Welcome Commander')
				if (this.sessionStatus) this.sessionStatus.textContent = 'Synchronising first authoritative snapshot…'
			} catch (error) {
				this.waitingForStart = false
				this.pendingBaseFocus = false
				this.sessionError = error instanceof StartRefused
					? humanizeStartError(error.code, error.userMessage, this.selectedMap())
					: error instanceof Error ? error.message : String(error)
				if (this.sessionRoot) this.sessionRoot.dataset.state = 'error'
				if (this.sessionStatus) {
					this.sessionStatus.textContent = `Could not start skirmish: ${this.sessionError}`
					if (error instanceof StartRefused) this.sessionStatus.dataset.errorCode = error.code
					else delete this.sessionStatus.dataset.errorCode
				}
				if (this.sessionStart) this.sessionStart.disabled = false
			}
		}, 0)
	}

	/**
	 * Put a halted simulation on screen.
	 *
	 * Only on a transition, never every frame: the host's pump writes its own line into the
	 * same element the instant it stops, four seconds before `core`'s watchdog can know
	 * anything, and a per-frame rewrite here would erase the more specific message with a
	 * vaguer one. Clearing is likewise limited to an alarm this node raised.
	 */
	private updateSimAlarm(ctx: Ctx): void {
		const alarm = this.simAlarm
		if (!alarm) return
		// A lost graphics device: the simulation runs on, but every GPU resource the view was
		// built from went with the device, so the page must be reloaded to draw again.
		const lost = ctx.gpuLost
		if (lost !== null && !this.gpuAlarmShown) {
			this.gpuAlarmShown = true
			this.simAlarmShown = true
			alarm.replaceChildren()
			const title = document.createElement('b')
			title.textContent = 'Graphics device lost'
			const body = document.createElement('span')
			body.textContent = `The GPU stopped (${lost.reason}${lost.message ? `: ${lost.message}` : ''}). The simulation keeps running, `
				+ 'but the view cannot be rebuilt in place. Reload to restore the graphics; a skirmish starts again from the lobby.'
			const reload = document.createElement('button')
			reload.type = 'button'
			reload.className = 'hud-action sim-alarm-reload'
			reload.textContent = 'Reload'
			reload.addEventListener('click', () => location.reload())
			alarm.append(title, body, reload)
			alarm.hidden = false
			return
		}
		if (this.gpuAlarmShown) return
		const health = ctx.simHealth
		if (health.stalled) {
			if (this.simAlarmShown) return
			// Already carrying the host's own line, which names the exception. Adopt it.
			if (!alarm.hidden) {
				this.simAlarmShown = true
				return
			}
			this.simAlarmShown = true
			alarm.replaceChildren()
			const title = document.createElement('b')
			title.textContent = 'Simulation halted'
			const body = document.createElement('span')
			// The host's own exception when there is one; it names the trait that threw and is
			// the difference between a bug report and "it froze".
			body.textContent = health.hostStatus.startsWith('error:')
				? `${health.reason}\nReload the page to start a new match.`
				: `${health.reason} Reload the page to start a new match.`
			// A dead sim is a dead page: give the halt notice a one-click exit back
			// to the lobby instead of leaving the player to find the refresh key.
			const reload = document.createElement('button')
			reload.type = 'button'
			reload.className = 'hud-action sim-alarm-reload'
			reload.textContent = 'Back to lobby'
			reload.addEventListener('click', () => location.reload())
			alarm.append(title, body)
			// Host-side evidence captured when the watchdog found the stall: world tick/hash,
			// connection/netframe state and the dedicated server's last error. One DOM-safe
			// line per probe, so a freeze screenshot carries its own diagnosis.
			if (health.diagnostics.length > 0) {
				const diag = document.createElement('span')
				diag.className = 'sim-alarm-diag'
				diag.textContent = health.diagnostics.join('\n')
				alarm.append(diag)
			}
			alarm.append(reload)
			alarm.hidden = false
			return
		}
		if (!this.simAlarmShown) return
		this.simAlarmShown = false
		alarm.hidden = true
		alarm.replaceChildren()
	}

	/** Collapse every HUD panel but the toggle chip, or restore them. */
	private toggleHudMinimised(): void {
		const root = this.hudRoot
		const chip = this.hudMinimise
		if (!root || !chip) return
		const minimised = root.classList.toggle('hud-minimised')
		chip.textContent = minimised ? 'Show' : 'Hide'
		chip.setAttribute('aria-pressed', String(minimised))
		chip.title = minimised ? 'Show the interface (I)' : 'Hide the interface (I)'
	}

	/**
	 * The Pause button toggles the simulation directly; the Menu button opens the game
	 * menu (resume, return to the lobby, exit, copyright). The menu also pauses: a menu
	 * over a live battlefield is a way to lose units.
	 */
	/** HUD chip + M: soundtrack on/off at any time; the choice persists. */
	private toggleMusic(): void {
		this.music?.setEnabled(!this.music?.isEnabled())
		this.syncMusicMenu()
	}

	private nudgeMusicVolume(delta: number): void {
		this.music?.setVolume(this.music?.getVolume() + delta)
		this.syncMusicMenu()
	}

	private syncMusicMenu(): void {
		if (this.menuMusic) {
			const label = document.getElementById('menu-music-label')
			if (label) label.textContent = this.music?.isEnabled() ? 'On' : 'Off'
			const volume = document.getElementById('menu-music-volume')
			if (volume) volume.textContent = `${this.music?.getVolume() ?? 0}%`
			this.menuMusic.setAttribute('aria-pressed', String(this.music?.isEnabled()))
		}
	}

	private async togglePause(): Promise<void> {
		const ctx = this.ctx
		const snap = ctx?.snapshot
		if (!ctx || !snap || (snap.flags & HeaderFlag.gameOver) !== 0) return
		try {
			const result = await ctx.session.setPaused((snap.flags & HeaderFlag.paused) === 0)
			if (!result.startsWith('ok:') && !result.startsWith('ignored:')) throw new Error(result)
			this.sessionError = ''
		} catch (error) {
			this.sessionError = error instanceof Error ? error.message : String(error)
			if (this.hudAlert) this.hudAlert.textContent = this.sessionError
		}
	}

	private openGameMenu(): void {
		const ctx = this.ctx
		if (!ctx) return
		// A missing snapshot (halted sim, cold join) must still open the menu —
		// only an actually-over match blocks it.
		const snap = ctx.snapshot
		if (snap && (snap.flags & HeaderFlag.gameOver) !== 0) return
		void ctx.session.setPaused(true).catch(() => { /* the menu is still worth showing */ })
		// A network match never pauses for one player, and cannot be restarted by one.
		const kicker = document.getElementById('menu-kicker')
		if (kicker) kicker.textContent = this.mpMatch ? 'Network match · the battle keeps running' : 'Match paused'
		if (this.menuRestart) this.menuRestart.hidden = this.mpMatch
		this.disarmMenuRestart()
		this.syncMusicMenu()
		if (this.gameMenuRoot) this.gameMenuRoot.hidden = false
	}

	/**
	 * Menu → Return to main menu, and the result sheet's Main menu. Desktop: the shell shows
	 * its menu and reloads this page hidden (desktop/preload.cjs injects backToMain), so the
	 * boot loader never flashes over it; the browser reloads into the lobby.
	 */
	private returnToMainMenu(): void {
		type ShellBridge = { backToMain?: () => void }
		const shell = window as unknown as ShellBridge
		this.stopTutorial()
		if (shell.backToMain) shell.backToMain()
		else location.reload()
	}

	/** Menu → Restart match (skirmish only): the first click arms it, a second within 4 s restarts. */
	private onMenuRestart(): void {
		const row = this.menuRestart
		if (!row || this.mpMatch) return
		if (row.dataset.armed === undefined) {
			row.dataset.armed = ''
			const hint = document.getElementById('menu-restart-hint')
			if (hint) hint.textContent = 'Click again to restart'
			this.uiCue('select')
			window.clearTimeout(this.menuRestartTimer)
			this.menuRestartTimer = window.setTimeout(() => this.disarmMenuRestart(), 4000)
			return
		}
		this.disarmMenuRestart()
		this.closeGameMenu()
		this.fireLaunchShot()
		this.startConfiguredSkirmish()
	}

	private disarmMenuRestart(): void {
		window.clearTimeout(this.menuRestartTimer)
		const row = this.menuRestart
		if (!row) return
		delete row.dataset.armed
		const hint = document.getElementById('menu-restart-hint')
		if (hint) hint.textContent = 'Same map and rules'
	}

	private closeGameMenu(): void {
		if (this.gameMenuRoot) this.gameMenuRoot.hidden = true
		const ctx = this.ctx
		const snap = ctx?.snapshot
		if (!ctx || !snap || (snap.flags & HeaderFlag.gameOver) !== 0) return
		try { void ctx.session.setPaused(false).catch(() => { /* a host tear-down may already be under way */ }) } catch { /* unreachable: promise path */ }
	}

	private updateOutcome(snap: Snapshot, playerFlags: number): void {
		const root = this.outcomeRoot
		if (!root) return
		if ((snap.flags & HeaderFlag.gameOver) === 0) {
			root.hidden = true
			return
		}
		root.hidden = false
		root.dataset.outcome = (playerFlags & PlayerFlag.won) !== 0
			? 'victory'
			: (playerFlags & PlayerFlag.lost) !== 0 ? 'defeat' : 'concluded'
		if (this.outcomeTitle) this.outcomeTitle.textContent = root.dataset.outcome === 'victory'
			? 'Victory'
			: root.dataset.outcome === 'defeat' ? 'Defeat' : 'Battle concluded'
		const ranked = this.mpMatch && this.mpRoom?.ranked === true
		if (ranked) this.startRankedSettlementPolling()
		const settlement = this.mpRoom?.settlement
		const settlementReason = this.mpRoom?.settlementReason ? ` Reason: ${this.mpRoom.settlementReason}.` : ''
		if (this.outcomeMode) this.outcomeMode.textContent = this.mpMatch
			? ranked ? 'Ranked multiplayer · server adjudication' : 'Unranked multiplayer · no rating change'
			: 'Skirmish · rating eligible'
		if (this.outcomeSettlement) this.outcomeSettlement.textContent = this.mpMatch
			? ranked
				? settlement === 'settled' ? 'Ranked result settled.'
					: settlement === 'void' ? `Match void — no rating change.${settlementReason}`
					: settlement === 'error' ? `Settlement unavailable — no rating change.${settlementReason}`
					: 'Result pending server settlement.'
				: 'This network match is unranked.'
			: 'Settlement complete.'
		const restartLabel = document.getElementById('outcome-restart-label')
		if (restartLabel) restartLabel.textContent = this.mpMatch ? 'Back to multiplayer' : 'Play again'
		if (!this.outcomeRendered) {
			this.outcomeRendered = true
			this.renderOutcomeDetails(snap)
		}
		if (this.outcomeCopy) this.outcomeCopy.textContent = this.mpMatch && ranked
			? 'The simulation has ended. The ranked service is checking the server result before moving any rating.'
			: this.mpMatch
			? 'This network match is complete, but it is not eligible for leaderboard rating.'
			: 'The OpenRA simulation decided this result. Play the same skirmish again, or head back to the main menu.'
		// Spoken once per match: the outcome line never repeats while the sheet stays up.
		if (!this.evaOutcomeSpoken) {
			this.evaOutcomeSpoken = true
			this.eva?.say(root.dataset.outcome === 'victory' ? 'Mission success'
				: root.dataset.outcome === 'defeat' ? 'All controls terminated' : 'Battle concluded')
			// Leaderboard: skirmish only. Network matches are unranked in v1
			// (L21, T1.31) — no report begins for them, so nothing is sent here.
			void finishMatchReport(
				root.dataset.outcome === 'victory' ? 'victory' : root.dataset.outcome === 'defeat' ? 'defeat' : 'draw',
				snap.gameTimeMs,
			).then(report => this.renderMatchReport(report))
		}
	}

	/**
	 * The result sheet's facts and players, from the final snapshot. Exact values only: the RA
	 * player model has no synchronized score, so none is shown, and "standing at the end"
	 * counts the final world rather than events a dropped snapshot could have missed.
	 */
	private renderOutcomeDetails(snap: Snapshot): void {
		const ctx = this.ctx
		if (!ctx) return
		const set = (id: string, text: string): void => {
			const node = document.getElementById(id)
			if (node) node.textContent = text
		}
		const mapTitle = this.mpMatch ? (this.mpRoom ? this.mpRoomMapTitle(this.mpRoom) : '') : this.selectedMap()?.title ?? ''
		set('outcome-map', mapTitle || '—')
		set('outcome-duration', formatDuration(snap.gameTimeMs))
		const me = snap.players.find(player => (player.flags & PlayerFlag.isRenderPlayer) !== 0) ?? null
		set('outcome-faction', me ? this.factionLabel(ctx, me.factionId) : '—')
		const units = ctx.get<UnitsApi>('units')
		let buildings = 0
		let army = 0
		const actors = snap.actors
		if (me && actors) for (let i = 0; i < actors.count; i++) {
			if (actors.owner[i] !== me.id || (actors.flags[i] & ActorFlag.husk) !== 0) continue
			const name = ctx.actorTypeName(actors.typeId[i])
			if (!name || !units.healthBarEligible(name)) continue
			if (units.hasRaTrait(name, 'Building')) buildings++
			else army++
		}
		set('outcome-forces', me ? `${buildings} ${buildings === 1 ? 'building' : 'buildings'} · ${army} ${army === 1 ? 'unit' : 'units'}` : '—')
		// Every player the match decided (Neutral and Creeps never win or lose), you first.
		const decided = snap.players
			.filter(player => (player.flags & (PlayerFlag.won | PlayerFlag.lost | PlayerFlag.isRenderPlayer)) !== 0)
			.sort((a, b) => Number((b.flags & PlayerFlag.isRenderPlayer) !== 0) - Number((a.flags & PlayerFlag.isRenderPlayer) !== 0))
		const rows = decided.map(player => {
			const row = document.createElement('tr')
			const you = (player.flags & PlayerFlag.isRenderPlayer) !== 0
			if (you) row.dataset.you = ''
			const bot = (player.flags & PlayerFlag.isBot) !== 0
			// Teams, not relation: once the match is decided the engine reports relations from a
			// spectator's side, which turned the enemy AI into an "ally".
			const ally = me !== null && me.teamId > 0 && player.teamId === me.teamId
			const who = you ? 'You' : bot ? (ally ? 'AI ally' : 'AI opponent') : ally ? 'Ally' : 'Opponent'
			const name = document.createElement('td')
			const swatch = document.createElement('i')
			swatch.className = 'result__swatch'
			swatch.style.background = `rgb(${player.red}, ${player.green}, ${player.blue})`
			name.append(swatch, who)
			const faction = document.createElement('td')
			faction.textContent = this.factionLabel(ctx, player.factionId)
			const team = document.createElement('td')
			team.textContent = player.teamId > 0 ? `Team ${player.teamId}` : '—'
			const verdict = document.createElement('td')
			const tag = document.createElement('span')
			tag.className = 'result__verdict'
			const won = (player.flags & PlayerFlag.won) !== 0
			const lost = (player.flags & PlayerFlag.lost) !== 0
			tag.dataset.verdict = won ? 'won' : lost ? 'lost' : ''
			tag.textContent = won ? 'Victory' : lost ? 'Defeat' : '—'
			verdict.append(tag)
			row.append(name, faction, team, verdict)
			return row
		})
		document.getElementById('outcome-players')?.replaceChildren(...rows)
	}

	/** A faction's lobby name ("England"), from the catalog, for a snapshot faction id. */
	private factionLabel(ctx: Ctx, factionId: number): string {
		const id = ctx.actorTypeName(factionId)
		if (!id) return '—'
		const factions = this.selectedMap()?.factions ?? this.catalog?.maps[0]?.factions ?? []
		return factions.find(faction => faction.id === id)?.name ?? id.charAt(0).toUpperCase() + id.slice(1)
	}

	/**
	 * Start skirmish and Join fire a rifle shot (owner, 2026-09-25): the player's own faction
	 * bank when it has one, on the interface sound switch and volume. Falls back to the launch
	 * cue when no bank clip resolves.
	 */
	private fireLaunchShot(): void {
		const ui = this.uiSound
		if (!ui || !ui.isEnabled()) return
		const picked = this.sessionSlots?.querySelector<HTMLSelectElement>('[data-slot-id] select[data-field="faction"]')?.value.toLowerCase() ?? ''
		const bank = SFX_BANKS[picked] ?? SFX_BANKS[this.localFactionId.toLowerCase()] ?? SFX_BANKS.england ?? Object.values(SFX_BANKS)[0]
		const url = bank?.fire_rifle
		if (!url) {
			this.uiCue('launch')
			return
		}
		try {
			const shot = new Audio(url)
			shot.volume = Math.max(0, Math.min(1, ui.getVolume()))
			void shot.play().catch(() => { /* autoplay refused: the start itself still happens */ })
		} catch { /* no HTMLAudioElement here */ }
	}

	/**
	 * The outcome sheet's status line says what became of the skirmish report, so a player can
	 * see whether a match counted instead of discovering an empty leaderboard later.
	 */
	private renderMatchReport(report: MatchReportOutcome): void {
		const line = this.outcomeSettlement
		if (!line || this.mpMatch || !this.outcomeRoot || this.outcomeRoot.hidden) return
		switch (report.kind) {
			case 'saved':
				line.textContent = report.rated && report.delta !== null
					? `Result saved to the leaderboard · rating ${report.delta >= 0 ? '+' : ''}${report.delta}${report.ratingAfter !== null ? ` (now ${report.ratingAfter})` : ''}.`
					: 'Result saved to the leaderboard (unrated).'
				break
			case 'duplicate':
				line.textContent = 'This result was already on the leaderboard.'
				break
			case 'signed-out':
				line.textContent = 'Not signed in. Sign in and this result is added to the leaderboard automatically.'
				break
			case 'queued':
				line.textContent = 'Leaderboard unreachable. The result will be sent when the connection returns.'
				break
			case 'rejected':
				line.textContent = `The leaderboard did not accept this result (${report.status}).`
				break
			case 'no-leaderboard':
				line.textContent = 'This server has no leaderboard.'
				break
			case 'skipped':
				break
		}
	}

	private showProductionComplete(event: SnapshotEvent): void {
		const ctx = this.ctx
		const snap = ctx?.snapshot
		if (!ctx || !snap || event.byteLength !== 4 || event.offset + 4 > snap.byteLength) return
		const playerId = snap.view.getUint8(event.offset)
		let renderPlayerId = -1
		for (let i = 0; i < snap.players.length; i++)
			if ((snap.players[i].flags & PlayerFlag.isRenderPlayer) !== 0) {
				renderPlayerId = snap.players[i].id
				break
			}
		if (playerId !== renderPlayerId) return
		const actorType = snap.view.getUint16(event.offset + 2, true)
		const actorName = ctx.actorTypeName(actorType)
		// Structures spoke at the 100% ready-edge (syncProductionDom); this event now
		// only names the fresh actor for mobile units, whose spawn IS their completion.
		const visual = (RA_VISUAL_MANIFEST as unknown as { actors: Record<string, { visualFamily?: string }> }).actors[actorName?.toLowerCase() ?? '']
		if (visual?.visualFamily === 'structure') return
		this.showNotice(`${actorDisplayName(ctx, actorType, this.localFactionId)} ready`)
		this.eva?.say('Unit ready', snap.tick)
	}

	/**
	 * "Unit lost" for own mobile units. The destroyed-event payload carries only the actor
	 * id, so owner and type are read from the previous snapshot, which still lists the
	 * actor that died this tick. Buildings stay silent: losing a clinic is not losing a
	 * rifleman, and a base under pressure already speaks through Low power.
	 */
	private handleUnitLost(event: SnapshotEvent): void {
		const ctx = this.ctx
		const snap = ctx?.snapshot
		const prev = ctx?.prevSnapshot
		if (!ctx || !snap || !prev || event.byteLength < 4) return
		const units = ctx.get<UnitsApi>('units')
		const actors = prev.actors
		if (!actors) return
		// Wire layout: u32 actor id at the PAYLOAD start (decodeEvents sets offset
		// past the kind+length header; +4 is the x position, not the id — that
		// off-by-four read a coordinate as an actor id and silently muted the line).
		const actorId = snap.view.getUint32(event.offset, true)
		for (let i = 0; i < actors.count; i++) {
			if (actors.id[i] !== actorId) continue
			const name = ctx.actorTypeName(actors.typeId[i])
			// Civilians are nobody's units: their deaths read regardless of owner, because
			// the KILL is the news, not a loss. The engine rules make C1-C11/TECN/TECN2
			// the killable civilian actors; cows and deer are web scenery, not actors.
			if (/^(c(?:1[01]?|[2-9])|tecn2?)$/i.test(name)) {
				this.showNotice('Civilian killed', 'warn')
				return
			}
			if (actors.owner[i] !== this.renderPlayerId) return
			if (!units.hasRaTrait(name, 'Building')) this.eva?.say('Unit lost')
			return
		}
	}

	// --- combat identification rings -----------------------------------------

	/** Ring lifetime after a unit's last combat action. */
	private markCombat(actorId: number): void {
		if (actorId) this.combatMarks.set(actorId, performance.now() + COMBAT_RING_MS)
	}

	private readonly onWeaponFire = (event: SnapshotEvent): void => {
		const ctx = this.ctx
		if (!ctx?.snapshot || event.byteLength < 24 || event.offset < 0 || event.offset + 24 > ctx.snapshot.view.byteLength) return
		// Payload starts with the shooter's actor id (u16 kind + u16 length precede it).
		this.markCombat(ctx.snapshot.view.getUint32(event.offset, true))
	}


	/** Host relation is relative to the render player: 0 self, 1 ally, 2 enemy, 3 neutral. */
	private combatSide(ctx: Ctx, owner: number): number {
		if (owner === this.renderPlayerId) return 1
		const players = ctx.snapshot?.players
		if (players) for (const player of players) {
			if (player.id === owner) return player.relation === 1 ? 1 : player.relation === 2 ? 2 : 0
		}
		return 0
	}

	/** Own spies keep authoritative identity in typeId but present their disguise in displayTypeId. */
	/**
	 * Own actors the enemy cannot see as they are: a spy in disguise, or a unit under its Cloak
	 * (the stealth tank once idle). The owner sees them with the small disguise ring, the way
	 * OpenRA marks its own hidden units apart from the ones the enemy sees. A submerged submarine
	 * shows its submergence instead.
	 */
	private ownHidden(actors: NonNullable<Snapshot['actors']>, index: number): boolean {
		if (actors.owner[index] !== this.renderPlayerId) return false
		if (actors.displayTypeId[index] !== actors.typeId[index]) return true
		return (actors.flags[index] & ActorFlag.cloaked) !== 0 && (actors.flags[index] & ActorFlag.submerged) === 0
	}

	/**
	 * Every visible enemy unit wears a red footprint ring, idle or firing (owner, 2026-09-25:
	 * "always a red marker, tanks too": the 60%-smaller combat ring vanished under a tank hull).
	 * Buildings, wrecks and disguised spies stay unmarked. The snapshot's owner is the true
	 * owner even under a disguise, so a ring there would unmask the spy.
	 */
	private enemyUnitMarked(ctx: Ctx, actors: NonNullable<Snapshot['actors']>, index: number, units: UnitsApi): boolean {
		if (this.combatSide(ctx, actors.owner[index]) !== 2) return false
		if ((actors.flags[index] & ActorFlag.husk) !== 0) return false
		if (actors.displayTypeId[index] !== actors.typeId[index]) return false
		const typeId = actors.typeId[index]
		if (!units.isRenderableType(typeId)) return false
		const name = ctx.actorTypeName(typeId)
		return name !== '' && units.healthBarEligible(name) && !units.hasRaTrait(name, 'Building')
	}

	private appendGroundRing(ctx: Ctx, actors: NonNullable<Snapshot['actors']>, index: number,
		units: UnitsApi, terrain: TerrainApi): void {
		const enemy = this.enemyUnitMarked(ctx, actors, index, units)
		const side = this.ownHidden(actors, index) ? 3
			: enemy ? 2
			: this.combatMarks.has(actors.id[index]) ? this.combatSide(ctx, actors.owner[index]) : 0
		const m = side === 1 ? this.friendlyRingInstances : side === 2 ? this.hostileRingInstances
			: side === 3 ? this.disguiseRingInstances : this.instances
		const o = this.ringCounts[side]++ * 16
		const x = actors.posX[index] * WPOS_TO_M
		const z = actors.posY[index] * WPOS_TO_M
		// Existing selection footprint, on the terrain. Depth testing hides its far side
		// behind the hull; no screen-space radius or translucent disk is involved.
		const y = terrain.heightAt(x, z) + 0.03
		// Selection and enemy rings trace the whole footprint; friendly combat and disguise marks stay small.
		const scale = units.selectionRadiusM(actors.typeId[index]) / RING_RADIUS_M * (side === 0 || enemy ? 1 : .4)
		m[o] = scale; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0
		m[o + 4] = 0; m[o + 5] = 1; m[o + 6] = 0; m[o + 7] = 0
		m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = scale; m[o + 11] = 0
		m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1
	}

	private submitGroundRings(render: RenderApi, item: DrawItem, side: number): void {
		const count = this.ringCounts[side]
		const mutable = item as { -readonly [K in keyof DrawItem]: DrawItem[K] }
		mutable.instanceCount = count
		if (count) render.submit(item)
	}

	/**
	 * The compass tape, bottom-centre. Bound to the camera's raw yaw every frame so the
	 * strip slides under a damped turn instead of stepping with snapshots. Yaw 0 faces
	 * north (world -Z, the overview's top edge) and compass heading runs clockwise, so
	 * heading is simply -yaw; the raw accumulating angle is wrapped here, for display
	 * only. Fixed geometry, prebuilt strings, no allocation in the loop (rule 6).
	 */
	private updateCompass(ctx: Ctx): void {
		const g = this.compass2d
		if (!g) return
		let heading = -ctx.get<CameraApi>('camera').yaw * 180 / Math.PI % 360
		if (heading < 0) heading += 360
		// The strip only moves when the camera turns. Redrawing it (paths and shaped text)
		// every frame cost the main thread more than the whole fx node.
		if (Math.abs(heading - this.compassHeading) < 0.05) return
		this.compassHeading = heading
		g.setTransform(COMPASS_BACKING, 0, 0, COMPASS_BACKING, 0, 0)
		g.clearRect(0, 0, COMPASS_WIDTH, COMPASS_HEIGHT)
		const centreX = COMPASS_WIDTH / 2
		// Ticks every 15 degrees, cardinals every 45; both drawn as one path per style.
		g.lineWidth = 1
		g.strokeStyle = uiPalette.dim
		g.beginPath()
		for (let i = 0; i < COMPASS_TICK_COUNT; i++) {
			const delta = (i * COMPASS_TICK_STEP - heading + 540) % 360 - 180
			if (delta < -62 || delta > 62) continue
			const x = centreX + delta * COMPASS_PX_PER_DEGREE
			g.moveTo(x, 8)
			g.lineTo(x, i % 3 === 0 ? 20 : 14)
		}
		g.stroke()
		// Letters at the cardinal headings only, N picked out in the active colour.
		g.textAlign = 'center'
		g.textBaseline = 'top'
		g.font = '10px ui-monospace, Menlo, Consolas, monospace'
		for (let i = 0; i < COMPASS_TICK_COUNT; i += 3) {
			const delta = (i * COMPASS_TICK_STEP - heading + 540) % 360 - 180
			if (delta < -60 || delta > 60) continue
			g.fillStyle = i === 0 ? uiPalette.active : uiPalette.ink
			g.fillText(COMPASS_CARDINALS[i / 3], centreX + delta * COMPASS_PX_PER_DEGREE, 25)
		}
		// The lubber mark and the live readout: the one red line on the strip and the
		// heading it names, both fixed to the centre while the headings slide beneath.
		g.fillStyle = uiPalette.brand
		g.fillRect(centreX - 0.5, 4, 1, 18)
		g.fillStyle = uiPalette.ink
		g.font = 'bold 11px ui-monospace, Menlo, Consolas, monospace'
		g.fillText(COMPASS_READOUTS[Math.round(heading) % 360], centreX, 38)
	}

	private updateStrategicOverview(snap: Snapshot): void {
		const canvas = this.minimap
		const g = this.minimap2d
		const world = snap.world
		const actors = snap.actors
		if (!canvas || !g || !world || !actors) return
		this.updateEnemyHeat(actors)
		const width = Math.max(1, world.boundsRight - world.boundsLeft)
		const height = Math.max(1, world.boundsBottom - world.boundsTop)
		this.strategicStats.width = width
		this.strategicStats.height = height
		this.strategicStats.visibleActors = 0
		this.strategicStats.rememberedActors = 0
		this.strategicStats.drawnActors = 0
		if (!this.minimapImage || this.minimapImage.width !== canvas.width || this.minimapImage.height !== canvas.height) {
			this.minimapImage = g.createImageData(canvas.width, canvas.height)
			this.minimapFrame = g.createImageData(canvas.width, canvas.height)
			this.minimapShadeRev = -1
		}
		const image = this.minimapImage
		const frame = this.minimapFrame
		if (!frame) return
		const shadeRev = this.shroud?.revision ?? -1
		if (this.minimapShadeRev !== shadeRev) {
		const pixels = image.data
		for (let py = 0; py < canvas.height; py++) {
			const cellY = world.boundsTop + Math.floor(py * height / canvas.height)
			for (let px = 0; px < canvas.width; px++) {
				const cellX = world.boundsLeft + Math.floor(px * width / canvas.width)
				const state = this.shroud?.stateAt(cellX, cellY) ?? 0
				const offset = (py * canvas.width + px) * 4
				// Authoritative visibility, deliberately simple presentation: black is
				// unknown, explored terrain remains readable but dim, visible is full.
				const shade = state === 2 ? 88 : state === 1 ? 38 : 0
				pixels[offset] = shade
				pixels[offset + 1] = state === 2 ? 78 : state === 1 ? 34 : 0
				pixels[offset + 2] = state === 2 ? 57 : state === 1 ? 29 : 0
				// The map itself sits at ~0.72 alpha so the live world reads faintly through
				// the panel — but never-seen ground stays opaque: unknown must not leak what
				// the 3D view hides.
				pixels[offset + 3] = state === 0 ? 255 : 184
			}
		}
		this.minimapShadeRev = shadeRev
		}
		// One image upload for the whole overview. A fillRect per actor was a canvas call
		// per unit, and on an 1,100-actor battle that was the frame that missed 60 fps.
		frame.data.set(image.data)
		const paint = (px: number, py: number, r: number, gc: number, b: number, a: number) => {
			const x0 = Math.max(0, Math.floor(px) - 1)
			const y0 = Math.max(0, Math.floor(py) - 1)
			const x1 = Math.min(canvas.width, x0 + 3)
			const y1 = Math.min(canvas.height, y0 + 3)
			const pixels = frame.data
			for (let y = y0; y < y1; y++) {
				let offset = (y * canvas.width + x0) * 4
				for (let x = x0; x < x1; x++) {
					pixels[offset] = r
					pixels[offset + 1] = gc
					pixels[offset + 2] = b
					pixels[offset + 3] = a
					offset += 4
				}
			}
		}
		for (let i = 0; i < actors.count; i++) {
			const x = actors.posX[i] * WPOS_TO_M
			const z = actors.posY[i] * WPOS_TO_M
			if (this.shroud && !this.shroud.isVisible(Math.floor(x), Math.floor(z))) continue
			this.strategicStats.visibleActors++
			const px = (x - world.boundsLeft) * canvas.width / width
			const py = (z - world.boundsTop) * canvas.height / height
			if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue
			const owner = snap.players[actors.owner[i]]
			if (owner) paint(px, py, owner.red, owner.green, owner.blue, owner.alpha)
			else paint(px, py, 0x77, 0x77, 0x77, 255)
			this.strategicStats.drawnActors++
		}
		const frozen = snap.frozenActors
		if (frozen) for (let i = 0; i < frozen.count; i++) {
			const x = frozen.posX[i] * WPOS_TO_M
			const z = frozen.posY[i] * WPOS_TO_M
			if (this.shroud?.stateAt(Math.floor(x), Math.floor(z)) !== 1) continue
			const px = (x - world.boundsLeft) * canvas.width / width
			const py = (z - world.boundsTop) * canvas.height / height
			if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue
			const owner = snap.players[frozen.owner[i]]
			if (owner) paint(px, py, owner.red, owner.green, owner.blue, Math.round(owner.alpha * .55))
			else paint(px, py, 0x55, 0x55, 0x55, 255)
			this.strategicStats.rememberedActors++
			this.strategicStats.drawnActors++
		}
		g.putImageData(frame, 0, 0)
		g.strokeStyle = uiPalette.divider
		g.strokeRect(.5, .5, canvas.width - 1, canvas.height - 1)
		// World-fixed compass letters, drawn last so no blip covers them. The overview is
		// always north-up — world -Z is its top edge (boundsTop), matching yaw 0 — so these
		// label the MAP and never rotate with the camera. N carries the compass tape's
		// amber; the rest stay steel over a one-pixel shadow for readability.
		g.font = 'bold 10px ui-monospace, Menlo, Consolas, monospace'
		g.textAlign = 'center'
		g.textBaseline = 'middle'
		for (let i = 0; i < 4; i++) {
			const letter = MINIMAP_CARDINAL_LETTERS[i]
			const x = MINIMAP_CARDINAL_XY[i * 2]
			const y = MINIMAP_CARDINAL_XY[i * 2 + 1]
			g.fillStyle = 'rgba(0, 0, 0, .8)'
			g.fillText(letter, x + 1, y + 1)
			g.fillStyle = i === 0 ? uiPalette.active : uiPalette.ink
			g.fillText(letter, x, y)
		}
		const base = this.ensureMinimapBase(canvas)
		if (base) base.drawImage(canvas, 0, 0)
		if (this.tacticalOpen) this.renderTacticalMap(snap, world, width, height)
		if (this.ctx) this.drawMinimapViewport(this.ctx)
	}

	/**
	 * Enemy movement heat, fed from the snapshot cadence: mobile actors the shroud
	 * reports visible leave a warm cell that fades over 20 seconds. The accumulator
	 * only ever touches cells that are visible at write time and the overlay only
	 * draws cells visible at draw time, so the heat can never disclose an unseen enemy.
	 */
	private updateEnemyHeat(actors: NonNullable<Snapshot['actors']>): void {
		const ctx = this.ctx
		const units = ctx ? ctx.get<UnitsApi>('units') : null
		const now = performance.now()
		if (this.lastHeatTick > 0) {
			const decay = Math.exp(-(now - this.lastHeatTick) / 20000)
			for (const [key, value] of this.heatGrid) {
				const faded = value * decay
				if (faded < 0.02) this.heatGrid.delete(key)
				else this.heatGrid.set(key, faded)
			}
		}
		this.lastHeatTick = now
		if (!ctx || !units) return
		for (let i = 0; i < actors.count; i++) {
			if (actors.owner[i] === this.renderPlayerId) continue
			if (!HEAT_ROLES.has(units.semanticRole(ctx.actorTypeName(actors.typeId[i])))) continue
			const cellX = Math.floor(actors.posX[i] * WPOS_TO_M)
			const cellZ = Math.floor(actors.posY[i] * WPOS_TO_M)
			if (this.shroud?.stateAt(cellX, cellZ) !== 2) continue
			const key = cellZ * 65536 + cellX
			this.heatGrid.set(key, Math.min(1, (this.heatGrid.get(key) ?? 0) + 0.25))
		}
	}

	/**
	 * The tactical map: the strategic overview at five times the size, centred over
	 * the HUD. The shrouded terrain, remembered blips and the camera viewport come
	 * across as one nearest-neighbour blowup of the small canvas; heat, clearer dots
	 * and building names draw directly at the large resolution. Never reveals: the
	 * dot loop re-checks the shroud per actor and heat only renders on visible cells.
	 */
	private renderTacticalMap(snap: Snapshot, world: NonNullable<Snapshot['world']>,
		width: number, height: number): void {
		const g = this.tactical2d
		const big = this.tacticalCanvas
		const small = this.minimap
		if (!g || !big || !small) return
		g.imageSmoothingEnabled = false
		g.clearRect(0, 0, big.width, big.height)
		g.drawImage(small, 0, 0, big.width, big.height)
		const cellW = big.width / width
		const cellH = big.height / height
		for (const [key, value] of this.heatGrid) {
			const cellX = key % 65536
			const cellZ = (key - cellX) / 65536
			if (this.shroud?.stateAt(cellX, cellZ) !== 2) continue
			g.fillStyle = `rgba(242, 60, 40, ${(value * 0.55).toFixed(3)})`
			g.fillRect((cellX - world.boundsLeft) * cellW, (cellZ - world.boundsTop) * cellH,
				cellW, cellH)
		}
		const ctx = this.ctx
		const units = ctx ? ctx.get<UnitsApi>('units') : null
		const actors = snap.actors
		if (!actors) return
		g.font = '10px ui-monospace, Menlo, Consolas, monospace'
		g.textAlign = 'center'
		g.textBaseline = 'top'
		for (let i = 0; i < actors.count; i++) {
			const x = actors.posX[i] * WPOS_TO_M
			const z = actors.posY[i] * WPOS_TO_M
			if (this.shroud && !this.shroud.isVisible(Math.floor(x), Math.floor(z))) continue
			const bx = (x - world.boundsLeft) * cellW
			const by = (z - world.boundsTop) * cellH
			if (bx < 0 || by < 0 || bx >= big.width || by >= big.height) continue
			const owner = snap.players[actors.owner[i]]
			g.fillStyle = owner ? rgbaCss(owner.red, owner.green, owner.blue, owner.alpha) : '#777777'
			g.fillRect(bx - 3, by - 3, 6, 6)
			g.strokeStyle = 'rgba(8, 8, 13, .9)'
			g.strokeRect(bx - 3.5, by - 3.5, 7, 7)
			const name = ctx ? ctx.actorTypeName(actors.typeId[i]) : ''
			if (!units || !TACTICAL_BUILDING_ROLES.has(units.semanticRole(name))) continue
			const label = units.displayName(name)
			if (TACTICAL_LABEL_SKIP.has(label)) continue
			g.fillStyle = 'rgba(0, 0, 0, .85)'
			g.fillText(label, bx + 1, by + 6)
			g.fillStyle = uiPalette.ink
			g.fillText(label, bx, by + 5)
			if (owner) {
				g.fillStyle = rgbaCss(owner.red, owner.green, owner.blue, Math.round(owner.alpha * .7))
				g.fillRect(bx - 8, by + 17, 16, 1)
			}
		}
	}

	private ensureMinimapBase(src: HTMLCanvasElement): CanvasRenderingContext2D | null {
		if (typeof document === 'undefined') return null
		if (!this.minimapBase) {
			this.minimapBase = document.createElement('canvas')
			this.minimapBase2d = this.minimapBase.getContext('2d')
		}
		const dst = this.minimapBase
		if (dst.width !== src.width || dst.height !== src.height) {
			dst.width = src.width
			dst.height = src.height
		}
		return this.minimapBase2d
	}

	/** Live camera footprint on the overview: RA-yellow view box, redrawn every frame. */
	private drawMinimapViewport(ctx: Ctx): void {
		const canvas = this.minimap
		const g = this.minimap2d
		const base = this.minimapBase
		const world = ctx.snapshot?.world
		if (!canvas || !g || !base || !world) return
		g.drawImage(base, 0, 0)
		let camera: CameraApi | null = null
		try { camera = ctx.get<CameraApi>('camera') } catch { camera = null }
		if (!camera) return
		const screenW = canvasCssWidth(ctx) || ctx.canvas.width || 1
		const screenH = canvasCssHeight(ctx) || ctx.canvas.height || 1
		if (!camera.viewGroundQuad(this.minimapViewQuad, screenW, screenH)) return
		const mapW = Math.max(1, world.boundsRight - world.boundsLeft)
		const mapH = Math.max(1, world.boundsBottom - world.boundsTop)
		const q = this.minimapViewQuad
		const p = this.minimapViewPx
		for (let i = 0; i < 4; i++) {
			const px = (q[i * 2] - world.boundsLeft) * canvas.width / mapW
			const py = (q[i * 2 + 1] - world.boundsTop) * canvas.height / mapH
			if (!Number.isFinite(px) || !Number.isFinite(py)) return
			p[i * 2] = px
			p[i * 2 + 1] = py
		}
		g.save()
		g.beginPath()
		g.rect(1, 1, canvas.width - 2, canvas.height - 2)
		g.clip()
		g.beginPath()
		g.moveTo(p[0], p[1])
		g.lineTo(p[2], p[3])
		g.lineTo(p[4], p[5])
		g.lineTo(p[6], p[7])
		g.closePath()
		g.fillStyle = 'rgba(255, 210, 0, 0.16)'
		g.fill()
		g.lineJoin = 'miter'
		g.strokeStyle = 'rgba(0, 0, 0, 0.85)'
		g.lineWidth = 3
		g.stroke()
		g.strokeStyle = '#ffd400'
		g.lineWidth = 1.5
		g.stroke()
		g.restore()
	}

	private focusFromMinimap(event: PointerEvent): void {
		const ctx = this.ctx
		const canvas = this.minimap
		const snapshot = ctx?.snapshot
		const world = snapshot?.world
		const actors = snapshot?.actors
		if (!ctx || !canvas || !world || !actors) return
		const rect = canvas.getBoundingClientRect()
		if (rect.width <= 0 || rect.height <= 0) return
		event.preventDefault()
		let x = world.boundsLeft + (event.clientX - rect.left) / rect.width * (world.boundsRight - world.boundsLeft)
		let z = world.boundsTop + (event.clientY - rect.top) / rect.height * (world.boundsBottom - world.boundsTop)
		let hit = -1
		let hitDistance = 10 * 10
		for (let i = 0; i < actors.count; i++) {
			const actorX = actors.posX[i] * WPOS_TO_M
			const actorZ = actors.posY[i] * WPOS_TO_M
			const markerX = rect.left + (actorX - world.boundsLeft) * rect.width /
				(world.boundsRight - world.boundsLeft)
			const markerY = rect.top + (actorZ - world.boundsTop) * rect.height /
				(world.boundsBottom - world.boundsTop)
			const dx = markerX - event.clientX
			const dy = markerY - event.clientY
			const distance = dx * dx + dy * dy
			if (distance >= hitDistance) continue
			hitDistance = distance
			hit = i
		}
		// Right button commands the selection instead of moving the camera, the same way it
		// does on the battlefield. The overview is where a player looks when the thing they
		// want to reach is off screen, so it is exactly where sending an order is worth most.
		if (event.button === 2) {
			if (this.commandFromMinimap(ctx, actors, x, z, event)) return
			return
		}
		const camera = ctx.get<CameraApi>('camera')
		if (hit >= 0) {
			x = actors.posX[hit] * WPOS_TO_M
			z = actors.posY[hit] * WPOS_TO_M
			camera.selectActor(actors.id[hit])
			this.selected.length = 1
			this.selected[0] = actors.id[hit]
		}
		camera.focusWorld(x, z)
		this.strategicStats.focusCommands++
	}

	/**
	 * Send the current selection to a point on the overview. The order goes through the same
	 * contextual path a battlefield click uses, so OpenRA still decides what it means and
	 * which units it applies to; the browser only supplies selection, target cell and
	 * modifiers. Returns false when there is nothing to command.
	 */
	private commandFromMinimap(ctx: Ctx, actors: NonNullable<Snapshot['actors']>,
		worldX: number, worldZ: number, event: PointerEvent): boolean {
		const subjectCount = this.packCommandSubjects(actors)
		if (subjectCount === 0) return false
		const cellX = Math.floor(worldX)
		const cellY = Math.floor(worldZ)
		const reachable = this.selectionCanReach(cellX, cellY, actors, subjectCount)
		ctx.issueOrder({
			orderString: 'Contextual',
			contextual: true,
			subjectIds: this.commandSubjects,
			subjectCount,
			targetActorId: 0,
			targetFrozen: false,
			targetCell: { x: cellX, y: cellY },
			modifiers: modifierBits(event),
		})
		this.markOrder(cellX + 0.5, cellY + 0.5, reachable)
		this.showNotice(reachable
			? `Order sent to ${cellX}, ${cellY}`
			: `No route to ${cellX}, ${cellY} for this selection`)
		return true
	}

	// ------------------------------------------------------------------
	// Daylight, on-screen camera controls and the edge-scroll hint
	// ------------------------------------------------------------------

	private chooseDaylight(event: Event): void {
		// A time of day fixed in the lobby is fixed for the whole match.
		if (this.daylightLocked) return
		const button = event.target instanceof Element
			? event.target.closest<HTMLButtonElement>('button[data-daylight]')
			: null
		const mode = button?.dataset.daylight
		if (!this.ctx || (mode !== 'auto' && mode !== 'day' && mode !== 'night')) return
		this.ctx.get<SkyApi>('sky').setDaylightMode(mode)
		this.renderDaylightChoice()
	}

	/** Apply the lobby's time-of-day choice and lock the in-game switch for non-auto. */
	private applySessionDaylight(mode: 'auto' | 'day' | 'night' | 'world'): void {
		const sky = this.ctx?.get<SkyApi>('sky')
		if (!sky) return
		sky.setDaylightMode(mode)
		this.daylightLocked = mode !== 'auto'
		this.renderDaylightChoice()
	}

	/**
	 * Keep the switch showing the mode that is actually in force. It is re-read rather than
	 * written on click alone, because the URL can pin the sun at boot and a control that
	 * disagrees with the sky is worse than no control.
	 */
	private renderDaylightChoice(): void {
		const root = this.hudDaylight
		if (!root || !this.ctx) return
		const active = this.ctx.get<SkyApi>('sky').daylightMode
		if (active === this.lastDaylightMode && !this.daylightLocked) return
		this.lastDaylightMode = active
		for (const button of root.querySelectorAll<HTMLButtonElement>('button[data-daylight]')) {
			button.setAttribute('aria-pressed', button.dataset.daylight === active ? 'true' : 'false')
			button.disabled = this.daylightLocked
		}
		root.title = this.daylightLocked
			? 'Locked: the time of day was fixed in the skirmish lobby for this match.'
			: ''
	}

	/**
	 * A press on a camera control moves the view once immediately and then keeps moving while
	 * it is held. The tap is what makes a single click useful; the hold is what makes the
	 * control usable on a touchscreen, where there is no keyboard and no scroll wheel.
	 */
	private pressCameraControl(event: PointerEvent): void {
		const button = event.target instanceof Element
			? event.target.closest<HTMLButtonElement>('button')
			: null
		const ctx = this.ctx
		if (!button || !ctx || button.classList.contains('hud-collapse')) return
		event.preventDefault()
		const camera = ctx.get<CameraApi>('camera')
		const hold = this.cameraHold
		const pan = button.dataset.pan
		if (pan) {
			const [right, forward] = pan.split(',').map(Number)
			hold.panRight = right
			hold.panForward = forward
			camera.panByView(right * PAN_TAP, forward * PAN_TAP)
		}
		const zoom = button.dataset.zoom
		if (zoom) {
			hold.zoom = Number(zoom)
			camera.zoomByNotches(Number(zoom) * ZOOM_TAP)
		}
		const tilt = button.dataset.tilt
		if (tilt) {
			hold.tilt = Number(tilt)
			camera.tiltBy(Number(tilt) * TILT_TAP)
		}
		const turn = button.dataset.rotate
		if (turn) {
			hold.turn = Number(turn)
			camera.rotateBy(Number(turn) * TURN_TAP)
		}
		if (button.dataset.camera === 'reset') camera.resetOrientation()
		if (this.commandCanvas) this.commandCanvas.setAttribute('data-camera-held', '1')
	}

	private releaseCameraControls(): void {
		const hold = this.cameraHold
		hold.panRight = 0
		hold.panForward = 0
		hold.zoom = 0
		hold.tilt = 0
		hold.turn = 0
		this.commandCanvas?.removeAttribute('data-camera-held')
	}

	private applyCameraHold(dt: number, ctx: Ctx): void {
		const hold = this.cameraHold
		if (hold.panRight === 0 && hold.panForward === 0 && hold.zoom === 0 &&
			hold.tilt === 0 && hold.turn === 0) return
		const camera = ctx.get<CameraApi>('camera')
		if (hold.panRight !== 0 || hold.panForward !== 0)
			camera.panByView(hold.panRight * PAN_RATE * dt, hold.panForward * PAN_RATE * dt)
		if (hold.zoom !== 0) camera.zoomByNotches(hold.zoom * ZOOM_RATE * dt)
		if (hold.tilt !== 0) camera.tiltBy(hold.tilt * TILT_RATE * dt)
		if (hold.turn !== 0) camera.rotateBy(hold.turn * TURN_RATE * dt)
	}

	/**
	 * Light the edge the camera says it is scrolling from. The mask comes from the camera
	 * rather than from a band recomputed here, so the glow can never promise a scroll that
	 * is not happening — the whole point of the cue is that it tells the truth.
	 */
	private updateEdgeHints(ctx: Ctx): void {
		const mask = ctx.get<CameraApi>('camera').edgeScrollMask
		if (mask === this.lastEdgeMask) return
		this.lastEdgeMask = mask
		for (let i = 0; i < 4; i++) this.edgeHints[i]?.classList.toggle('on', (mask & (1 << i)) !== 0)
	}

	// ------------------------------------------------------------------
	// Reachability: can the selection get where the click landed?
	// ------------------------------------------------------------------

	private refreshPassability(snap: Snapshot): void {
		if ((snap.flags & HeaderFlag.terrainStaticPresent) === 0) return
		const view = snap.terrainStatic
		if (!view || view.w <= 0 || view.h <= 0) return
		const cells = view.w * view.h
		if (this.passability.length !== cells) {
			this.passability = new Uint8Array(cells)
			this.reachSeen = new Int32Array(cells)
			this.reachQueue = new Int32Array(cells)
			this.reachStamp = 0
		}
		this.passability.set(view.passability.subarray(0, cells))
		this.passabilityW = view.w
		this.passabilityH = view.h
		const terrain = this.terrain
		this.passabilityOriginX = terrain?.originX ?? 0
		this.passabilityOriginY = terrain?.originY ?? 0
	}

	private passabilityIndex(cellX: number, cellY: number): number {
		const x = Math.floor(cellX) - this.passabilityOriginX
		const y = Math.floor(cellY) - this.passabilityOriginY
		if (x < 0 || y < 0 || x >= this.passabilityW || y >= this.passabilityH) return -1
		return y * this.passabilityW + x
	}

	/**
	 * Whether the current selection can reach this cell, answered from the host's own
	 * locomotor costs rather than from anything the browser invented.
	 *
	 * The locomotor mask is taken from the cells the selected units are standing on: a unit
	 * that is there can move there, so its own cell carries at least its locomotor's bit.
	 * A flood fill over cells sharing that mask then answers reachability rather than mere
	 * passability, which is what the player is really asking — a shore across a river is
	 * drivable ground that this tank will never arrive at.
	 *
	 * Two limits, deliberately: a cell that suits several locomotors widens the mask, and
	 * transports, bridges and lifts are not modelled. It is a cursor cue, not the pathfinder.
	 */
	private selectionCanReach(cellX: number, cellY: number, actors: NonNullable<Snapshot['actors']>,
		subjectCount: number): boolean {
		const target = this.passabilityIndex(cellX, cellY)
		if (this.passabilityW === 0 || subjectCount === 0) return true
		if (target < 0 || (this.passability[target] & OFF_MAP_BIT) !== 0) return false

		let mask = LOCOMOTOR_BITS
		let starts = 0
		const queue = this.reachQueue
		const seen = this.reachSeen
		const stamp = ++this.reachStamp
		for (let s = 0; s < subjectCount; s++) {
			const id = this.commandSubjects[s]
			for (let i = 0; i < actors.count; i++) {
				if (actors.id[i] !== id) continue
				const index = this.passabilityIndex(actors.posX[i] * WPOS_TO_M, actors.posY[i] * WPOS_TO_M)
				if (index >= 0) {
					const bits = this.passability[index] & LOCOMOTOR_BITS
					if (bits !== 0) {
						mask &= bits
						if (seen[index] !== stamp) {
							seen[index] = stamp
							queue[starts++] = index
						}
					}
				}
				break
			}
		}
		// Nothing was found standing anywhere sensible, or the selection has no locomotor in
		// common. Saying "unreachable" on no evidence would be a lie of a different kind.
		if (starts === 0 || mask === 0) return true
		if ((this.passability[target] & mask) === 0) return false

		const w = this.passabilityW
		const h = this.passabilityH
		let head = 0
		let tail = starts
		while (head < tail) {
			const index = queue[head++]
			if (index === target) return true
			const x = index % w
			const y = (index - x) / w
			for (let d = 0; d < 4; d++) {
				const nx = x + (d === 0 ? -1 : d === 1 ? 1 : 0)
				const ny = y + (d === 2 ? -1 : d === 3 ? 1 : 0)
				if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
				const next = ny * w + nx
				if (seen[next] === stamp) continue
				if ((this.passability[next] & mask) === 0) continue
				seen[next] = stamp
				queue[tail++] = next
			}
		}
		return false
	}

	/**
	 * Say who is actually going to be in the match before it starts. A lobby that silently
	 * offers no opponent is the difference between "the AI does nothing" and "no AI was
	 * asked for", and the player cannot tell those apart once the map has loaded.
	 */
	private renderComposition(): void {
		const line = this.sessionComposition
		const root = this.sessionSlots
		if (!line || !root) return
		let humans = 0, bots = 0, open = 0
		for (const row of root.querySelectorAll<HTMLElement>('[data-slot-id]')) {
			const kind = row.querySelector<HTMLSelectElement>('[data-field="kind"]')?.value
			if (kind === 'human') humans++
			else if (kind === 'bot') bots++
			else if (kind === 'open') open++
		}
		const parts = [`${humans} human`, `${bots} AI opponent${bots === 1 ? '' : 's'}`]
		if (open > 0) parts.push(`${open} open`)
		line.textContent = bots === 0
			? `${parts.join(' · ')} — with no AI opponent nothing will attack you. Set a slot to OpenRA bot.`
			: parts.join(' · ')
		line.classList.toggle('warn', bots === 0)
	}

	/** One short HUD line, on the same tick budget the production notice uses. */
	private showNotice(text: string, tone: 'default' | 'warn' = 'default'): void {
		const snap = this.ctx?.snapshot
		if (!this.hudNotice || !snap) return
		this.hudNotice.textContent = text
		this.hudNotice.style.color = tone === 'warn' ? uiPalette.warning : ''
		this.hudNotice.hidden = false
		this.noticeUntilTick = snap.tick + NOTICE_TICKS
	}

	/** Remember where an order was aimed so the next frames can draw the answer there. */
	private markOrder(worldX: number, worldZ: number, reachable: boolean, attack = false): void {
		const marker = this.orderMarker
		marker.x = worldX
		marker.z = worldZ
		marker.bornMs = performance.now()
		marker.reachable = reachable
		marker.attack = attack
		this.orderAction = null
		marker.active = true
	}

	/**
	 * Draw the last order's aim point: amber where the selection can get there, red where it
	 * cannot. Red is the whole reason this exists — an order into rock or across water is
	 * accepted in silence otherwise, and the player is left watching a unit that never moves.
	 * Attack aims draw a red X reticle instead of the ring: shape, not colour, carries the
	 * move-versus-fire distinction.
	 */
	private updateOrderMarker(ctx: Ctx, terrain: TerrainApi, render: RenderApi): void {
		const ring = this.orderMarkerRing
		const dot = this.orderMarkerDot
		const reticle = this.orderMarkerReticle
		if (!ring || !dot || !reticle) return
		const marker = this.orderMarker
		const age = marker.active ? performance.now() - marker.bornMs : ORDER_MARKER_MS
		if (!marker.active || age >= ORDER_MARKER_MS) {
			ring.style.display = 'none'
			dot.style.display = 'none'
			reticle.style.display = 'none'
			marker.active = false
			return
		}
		const vp = render.camera.viewProj
		const x = marker.x
		const z = marker.z
		const y = terrain.heightAt(x, z) + 0.05
		const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15]
		if (cw <= 0) {
			ring.style.display = 'none'
			dot.style.display = 'none'
			reticle.style.display = 'none'
			return
		}
		const viewW = canvasCssWidth(ctx) || 1
		const viewH = canvasCssHeight(ctx) || 1
		const sx = ((vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / cw * 0.5 + 0.5) * viewW
		const sy = (0.5 - (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / cw * 0.5) * viewH
		const t = age / ORDER_MARKER_MS
		if (marker.attack || this.orderAction) {
			reticle.setAttribute('d', this.orderAction?.glyph ?? ATTACK_GLYPH)
			reticle.setAttribute('transform', `translate(${sx.toFixed(1)} ${sy.toFixed(1)})`)
			reticle.setAttribute('stroke', marker.attack ? uiPalette.critical : uiPalette.active)
			reticle.setAttribute('opacity', (1 - t).toFixed(2))
			reticle.style.display = ''
			ring.style.display = 'none'
			dot.style.display = 'none'
			return
		}
		reticle.style.display = 'none'
		const colour = marker.reachable ? '255,196,104' : '255,86,64'
		// The ring contracts onto the point, so the eye is pulled to where the order landed
		// rather than to a decoration that merely appeared somewhere.
		ring.setAttribute('cx', sx.toFixed(1))
		ring.setAttribute('cy', sy.toFixed(1))
		ring.setAttribute('r', (26 - 16 * t).toFixed(1))
		ring.setAttribute('stroke', `rgba(${colour},${(1 - t).toFixed(2)})`)
		ring.style.display = ''
		dot.setAttribute('cx', sx.toFixed(1))
		dot.setAttribute('cy', sy.toFixed(1))
		dot.setAttribute('r', marker.reachable ? '2.5' : '3.5')
		dot.setAttribute('fill', `rgba(${colour},${(1 - t * 0.7).toFixed(2)})`)
		dot.style.display = ''
	}

	/** Clear every piece of hover feedback, even when a different piece was hidden. */
	private hideHoverMark(): void {
		if (this.hoverMark) this.hoverMark.style.display = 'none'
		if (this.hoverMarkBack) this.hoverMarkBack.style.display = 'none'
		if (this.actionHint) this.actionHint.style.display = 'none'
	}

	/** The preview comes from the same OpenRA targeter that will execute the click. */
	private updateHoverTarget(ctx: Ctx, actors: NonNullable<Snapshot['actors']>, units: UnitsApi,
		_terrain: TerrainApi, _render: RenderApi): void {
		const pointer = ctx.input.pointer
		this.hideHoverMark()
		let feedback: ActionFeedback | null = null
		if (pointer.inside && this.pendingPlacement === null && !this.selectionDragged) {
			if (this.sellMode) feedback = actionFeedback({ order: 'Sell', cursor: 'sell' })
			else if (this.attackMoveArmed || this.guardArmed || this.supportPowerArmed !== null)
				feedback = { label: this.attackMoveArmed ? 'Attack-move' : this.guardArmed ? 'Guard' : 'Target support power',
					glyph: ATTACK_GLYPH, attack: !this.guardArmed, actorAction: false, blocked: false }
			else {
				const intent = this.pointerContextIntent(ctx, actors, units, this.pointerModifiers(ctx))
				if (intent) feedback = actionFeedback(this.previewContext(ctx, intent))
			}
		}
		const cursor = feedback ? (feedback.blocked ? 'not-allowed' : 'none') : ''
		if (cursor !== this.hoverCursor) {
			this.hoverCursor = cursor
			if (this.commandCanvas) this.commandCanvas.style.cursor = cursor
		}
		if (this.commandCanvas) this.commandCanvas.dataset.targetAction = feedback?.label ?? ''
		const mark = this.hoverMark, back = this.hoverMarkBack, hint = this.actionHint
		const overlay = this.placementOverlay
		if (!feedback || feedback.blocked || !mark || !back || !overlay) return
		const transform = `translate(${Math.round(pointer.x)} ${Math.round(pointer.y)})`
		for (const path of [back, mark]) {
			path.setAttribute('d', feedback.glyph)
			path.setAttribute('transform', transform)
			path.style.display = ''
		}
		mark.setAttribute('stroke', feedback.attack ? uiPalette.critical : uiPalette.active)
		if (hint && feedback.label !== 'Attack') {
			hint.textContent = feedback.label
			hint.setAttribute('x', String(Math.min(pointer.x + 16, canvasCssWidth(ctx) - 150)))
			hint.setAttribute('y', String(Math.max(16, pointer.y - 14)))
			hint.style.display = ''
		}
		overlay.setAttribute('viewBox', `0 0 ${Math.max(1, canvasCssWidth(ctx))} ${Math.max(1, canvasCssHeight(ctx))}`)
		overlay.style.display = ''
	}

	/** Queue category activated by the one selected local production building. */
	private selectedProducer(ctx: Ctx): { kind: number; name: string } | null {
		const actors = ctx.snapshot?.actors
		if (!actors || this.selected.length !== 1) return null
		for (let i = 0; i < actors.count; i++) {
			if (actors.id[i] !== this.selected[0] || actors.owner[i] !== this.renderPlayerId) continue
			const units = ctx.get<UnitsApi>('units')
			const actorName = ctx.actorTypeName(actors.typeId[i])
			const kind = units.productionKind(actorName)
			return kind >= 0 ? { kind, name: units.displayName(actorName) } : null
		}
		return null
	}

	private syncProductionDom(queues: readonly ProductionQueueView[], ctx: Ctx): void {
		const container = this.hudQueues
		if (!container) return
		let count = 0
		for (let i = 0; i < queues.length; i++) if (queues[i].playerId === this.renderPlayerId) count++
		const producer = this.selectedProducer(ctx)
		if (this.hudProductionTitle) this.hudProductionTitle.textContent = producer
			? `${producer.name} · ${QUEUE_NAMES[producer.kind] ?? 'Production'}`
			: 'All production · select a building to focus'
		if (count === 0) {
			container.textContent = 'Build or deploy a production structure to unlock its queue.'
			this.queueDom.length = 0
			return
		}
		let rebuild = count !== this.queueDom.length
		if (!rebuild) {
			let d = 0
			for (let i = 0; i < queues.length; i++) {
				const q = queues[i]
				if (q.playerId !== this.renderPlayerId) continue
				const dom = this.queueDom[d++]
				if (dom.queueId !== q.queueId || dom.kind !== q.kind || dom.items.length !== q.items.length) {
					rebuild = true
					break
				}
				for (let j = 0; j < q.items.length; j++)
					if (dom.items[j].actorType !== q.items[j].actorType) {
						rebuild = true
						break
					}
			}
		}

		// A tile whose label was baked while the async type table was still short
		// renders 'Unknown asset'; the rebuild below retriggers the table fetch, so
		// rebuild once more as soon as a pending id resolves.
		if (!rebuild && this.unknownProductionTypes.length > 0 && this.unknownProductionTypes.every(id => ctx.actorTypeName(id) !== ''))
			rebuild = true
		if (rebuild) this.rebuildProductionDom(queues, ctx)
		let d = 0
		for (let i = 0; i < queues.length; i++) {
			const queue = queues[i]
			if (queue.playerId !== this.renderPlayerId) continue
			const dom = this.queueDom[d++]
			dom.root.hidden = producer !== null && queue.kind !== producer.kind
			dom.count.textContent = queue.itemsQueued > 0 ? String(queue.itemsQueued) : 'IDLE'
			dom.progress.style.width = `${Math.max(0, Math.min(100, queue.progressPermille / 10))}%`
			const enabled = (queue.flags & ProductionQueueFlag.enabled) !== 0
			const paused = (queue.flags & ProductionQueueFlag.paused) !== 0
			const currentName = queue.currentActorType === NO_ACTOR_TYPE ? ''
				: actorDisplayName(ctx, queue.currentActorType, this.localFactionId)
			const queueReady = (queue.flags & ProductionQueueFlag.ready) !== 0
			dom.status.textContent = currentName
				? `${currentName} · ${queueReady ? 'READY' : paused ? 'ON HOLD' : `${Math.floor(queue.progressPermille / 10)}%`}`
				: 'Choose an item to build'
			dom.root.classList.toggle('disabled', !enabled)
			for (let j = 0; j < queue.items.length; j++) {
				const item = queue.items[j]
				const itemDom = dom.items[j]
				const current = (item.flags & ProductionItemFlag.current) !== 0
				const ready = (item.flags & ProductionItemFlag.ready) !== 0
				const building = (item.flags & ProductionItemFlag.building) !== 0
				itemDom.button.disabled = !enabled || ((item.flags & ProductionItemFlag.buildable) === 0 && !ready && !current)
				itemDom.button.classList.toggle('current', current)
				itemDom.button.classList.toggle('ready', ready)
				itemDom.button.classList.toggle('paused', current && paused)
				itemDom.button.dataset.ready = ready ? '1' : '0'
				itemDom.button.dataset.building = building ? '1' : '0'
				// 100% edge: only a structure reads as "construction complete" here
				// (building = waiting for placement). Mobile units are announced at
				// their spawn by showProductionComplete ("Unit ready"); speaking in
				// both places shipped a unit as two lines a tick apart.
				if (ready && !itemDom.wasReady && building && queue.playerId === this.renderPlayerId)
					this.eva?.say('Construction complete', ctx.snapshot?.tick ?? -1)
				itemDom.wasReady = ready
				itemDom.meta.textContent = `${formatNumber(item.cost)} ¤ · ${(item.buildTicks / 25).toFixed(1)}s`
				itemDom.queued.textContent = item.queued > 0 ? `×${item.queued}` : ''
				itemDom.status.textContent = ready ? building ? 'READY · PLACE' : 'EXIT BLOCKED'
					: current ? paused ? 'ON HOLD · RESUME' : `BUILDING ${Math.floor(queue.progressPermille / 10)}%`
						: item.queued > 0 ? 'QUEUED' : ''
				itemDom.progress.style.width = `${current ? Math.min(100, queue.progressPermille / 10) : 0}%`
				itemDom.button.title = `${itemDom.name.textContent} — ${ready && building
					? 'Ready: click, then place on valid ground. The next structure waits until placement.'
					: current && paused ? 'Click to resume. Right click to cancel.'
						: 'Click: queue one. Shift click: five. Ctrl click: prioritize after current. Right click: hold / cancel. Middle click: cancel.'}`
			}
		}
	}

	private rebuildProductionDom(queues: readonly ProductionQueueView[], ctx: Ctx): void {
		const container = this.hudQueues
		if (!container) return
		container.replaceChildren()
		this.queueDom.length = 0
		this.unknownProductionTypes.length = 0
		for (let i = 0; i < queues.length; i++) {
			const queue = queues[i]
			if (queue.playerId !== this.renderPlayerId) continue
			const root = document.createElement('section')
			root.className = 'hud-queue'
			const head = document.createElement('div')
			head.className = 'hud-queue-head'
			const name = document.createElement('span')
			name.className = 'hud-queue-name'
			name.textContent = QUEUE_NAMES[queue.kind] ?? `Queue ${queue.queueId}`
			const tally = document.createElement('span')
			tally.className = 'hud-queue-count'
			const track = document.createElement('span')
			track.className = 'hud-progress'
			const progress = document.createElement('i')
			track.append(progress)
			const status = document.createElement('span')
			status.className = 'hud-queue-status'
			head.append(name, tally, status, track)
			const itemsRoot = document.createElement('div')
			itemsRoot.className = 'hud-items'
			const itemDoms: HudItemDom[] = []
			for (let j = 0; j < queue.items.length; j++) {
				const item = queue.items[j]
				const button = document.createElement('button')
				button.type = 'button'
				button.className = 'hud-item'
				button.dataset.actorType = String(item.actorType)
				button.dataset.queueId = String(queue.queueId)
				button.dataset.actorName = ctx.actorTypeName(item.actorType)
				const actorName = ctx.actorTypeName(item.actorType)
				const portrait = productionPortrait(actorName, ctx.get<UnitsApi>('units').roleActors?.get(actorName))
				if (portrait) {
					const image = document.createElement('img')
					image.className = 'hud-item-preview'
					image.src = portrait
					image.alt = ''
					image.width = 256
					image.height = 192
					image.decoding = 'async'
					image.draggable = false
					button.append(image)
				}
				const itemName = document.createElement('span')
				const label = actorDisplayName(ctx, item.actorType, this.localFactionId)
				if (label === 'Unknown asset' && !this.unknownProductionTypes.includes(item.actorType))
					this.unknownProductionTypes.push(item.actorType)
				itemName.textContent = label
				const meta = document.createElement('span')
				meta.className = 'hud-item-meta'
				const queued = document.createElement('span')
				queued.className = 'hud-item-queued'
				const itemStatus = document.createElement('span')
				itemStatus.className = 'hud-item-status'
				const itemProgress = document.createElement('i')
				itemProgress.className = 'hud-item-progress'
				button.append(itemName, meta, queued, itemStatus, itemProgress)
				itemsRoot.append(button)
				itemDoms.push({ actorType: item.actorType, button, name: itemName, meta, queued, status: itemStatus, progress: itemProgress })
			}
			root.append(head, itemsRoot)
			container.append(root)
			this.queueDom.push({ queueId: queue.queueId, kind: queue.kind, root, name, count: tally, progress, status, items: itemDoms })
		}
	}

	/**
	 * The BUY switch: the same arm/place mode a READY production item click uses, for the
	 * first structure the queues report ready. Nothing new is sent to the engine — when no
	 * finished structure waits for a site, there is nothing to buy a place for.
	 */
	private handleBuyClick(): void {
		const ctx = this.ctx
		if (!ctx?.snapshot) return
		this.setSellMode(false)
		if (this.pendingPlacement !== null) {
			this.cancelPlacement()
			return
		}
		for (const queue of ctx.snapshot.production) {
			if (queue.playerId !== this.renderPlayerId) continue
			for (const item of queue.items) {
				if ((item.flags & ProductionItemFlag.ready) === 0 || (item.flags & ProductionItemFlag.building) === 0) continue
				const actorName = ctx.actorTypeName(item.actorType)
				if (!actorName) continue
				this.pendingPlacement = { actorName, actorType: item.actorType, queueId: queue.queueId, variant: 0 }
				this.placementResult = null
				this.placementQueryKey = ''
				this.updatePlacementHud()
				return
			}
		}
		this.showNotice('Nothing ready to place · queue production first')
	}

	/** Arm or disarm sell targeting; arming it takes placement mode back. */
	private setSellMode(on: boolean): void {
		if (this.sellMode === on) return
		this.sellMode = on
		if (on) {
			if (this.pendingPlacement !== null) this.cancelPlacement()
			this.cancelSelectionDrag()
		}
		this.hudSell?.setAttribute('aria-pressed', on ? 'true' : 'false')
		this.updatePlacementHud()
	}

	/**
	 * Sell targeting, one click long. RA's Sell button arms the cursor; the next click on
	 * an own building sends OpenRA's standard "Sell" order to that actor, whose Sellable
	 * trait refunds half its value and dismantles it. A click on nothing — or on something
	 * the RA rules do not let be sold — only explains itself and keeps the mode armed; Esc
	 * or a right click puts it away.
	 */
	private updateSellTargeting(
		ctx: Ctx,
		actors: NonNullable<Snapshot['actors']>,
		units: UnitsApi,
	): void {
		const pointer = ctx.input.pointer
		if (ctx.input.wasPressed('Escape') || (pointer.pressed & 4) !== 0) {
			this.setSellMode(false)
			return
		}
		if ((pointer.released & 1) === 0 || !pointer.inside) return
		const render = this.render
		const terrain = this.terrain
		if (!render || !terrain) return
		const viewW = Math.max(1, canvasCssWidth(ctx))
		const viewH = Math.max(1, canvasCssHeight(ctx))
		const hit = pickActorAt(render.camera.viewProj, actors, units, terrain,
			clamp(pointer.x, 0, viewW), clamp(pointer.y, 0, viewH), viewW, viewH, undefined, false, render.camera.position)
		if (hit < 0) {
			this.showNotice('Nothing under the cursor · click one of your buildings')
			return
		}
		const name = ctx.actorTypeName(actors.typeId[hit])
		if (actors.owner[hit] !== this.renderPlayerId || !sellableActor(name)) {
			this.showNotice(`${actorDisplayName(ctx, actors.typeId[hit])} cannot be sold`)
			return
		}
		const id = actors.id[hit]
		this.sellSubjects[0] = id
		ctx.issueOrder({ orderString: 'Sell', subjectIds: this.sellSubjects, targetActorId: id })
		// The order marker lands where the building stands, like every other sent order.
		this.markOrder(actors.posX[hit] * WPOS_TO_M, actors.posY[hit] * WPOS_TO_M, true)
		this.showNotice(`Selling ${actorDisplayName(ctx, actors.typeId[hit])} · half value refunded`)
	}

	/**
	 * Poll the bridge's support-power status at most twice a second, and rebuild the
	 * SUPPORT buttons only when something visible changed (a ready flip or a moved charge
	 * percentage). Steady state costs one throttled bridge call and one signature string.
	 */
	private updateSupportPanel(ctx: Ctx): void {
		const list = this.hudSupportList
		if (!list || !this.hudSupport) return
		const now = performance.now()
		const status = ctx.supportPowers?.() ?? null
		const powers = status?.powers ?? []
		const tickMs = status?.timestepMs && status.timestepMs > 0 ? status.timestepMs : SIM_TICK_MS
		// The verdict on a fired power is checked every frame (the status is a cached read):
		// the power's own charge restarting is the proof OpenRA activated it.
		const pending = this.supportPowerPending
		if (pending) {
			const power = powers.find(p => p.key === pending.key)
			if (power && !power.ready) {
				this.supportPowerPending = null
				this.markOrder(pending.x, pending.z, true, true)
				this.showNotice(`${pending.title} afgevuurd`)
				// OpenRA's beacon, for the powers that post one (DisplayBeacon), on the strike cell.
				this.postSupportBeacon(ctx, power, pending.cellX + 0.5, pending.cellY + 0.5)
				// A sonar pulse is drawn where it was sent, for as long as its detector lives.
				const effectTicks = power.effectTicks ?? 0
				if (effectTicks > 0) this.supportFx(ctx)?.supportEffect?.('sonar', pending.cellX + 0.5, pending.cellY + 0.5, effectTicks * tickMs / 1000)
			} else if (now - pending.issuedMs > SUPPORT_CONFIRM_MS) {
				this.supportPowerPending = null
				this.showNotice(`${pending.title} · geweigerd, de lading blijft staan`)
			}
		}
		if (status !== this.timersStatus) {
			this.timersStatus = status
			this.readLaunchesAndTimers(ctx, status, tickMs)
		}
		if (now - this.supportPowersAtMs < 500) return
		this.supportPowersAtMs = now
		this.hudSupport.hidden = powers.length === 0
		if (powers.length === 0) {
			if (this.supportPowersSig !== '') list.replaceChildren()
			this.supportPowersSig = ''
			return
		}
		const secondsLeft = (p: SupportPowerStatus): number => Math.ceil(p.remainingTicks * tickMs / 1000)
		const sig = powers.map(p => `${p.key}:${p.active ? 1 : 0}${p.ready ? 1 : 0}:${p.totalTicks - p.remainingTicks}:${secondsLeft(p)}`).join('|')
		if (sig === this.supportPowersSig) return
		this.supportPowersSig = sig
		const frag = document.createDocumentFragment()
		for (const p of powers) {
			const button = document.createElement('button')
			button.className = 'hud-action'
			button.type = 'button'
			button.dataset.power = p.key
			button.disabled = !p.ready || !p.active
			const pct = p.totalTicks > 0
				? Math.round((p.totalTicks - p.remainingTicks) * 100 / p.totalTicks) : 100
			// Charge time comes from OpenRA's ticks at the match speed; a power without power
			// (low power, powered down) holds its charge and says so.
			const left = secondsLeft(p)
			const clock = left >= 60 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : `${left}s`
			button.textContent = p.ready ? `${p.title} · READY`
				: !p.active ? `${p.title} · gepauzeerd ${pct}%`
				: `${p.title} · ${pct}% · ${clock}`
			button.title = p.ready ? `${p.title}: klaar` : `${p.title}: nog ${clock}${p.active ? '' : ' (gepauzeerd: te weinig stroom)'}`
			// The charge clock: a conic sweep behind the label, the browser's answer to the
			// original's clock sprite. Rebuilt only when the signature (and so the sweep) moved.
			button.style.background =
				`conic-gradient(from -90deg, rgba(255,215,94,0.34) ${pct}%, rgba(8,10,12,0.72) ${pct}%)`
			frag.appendChild(button)
		}
		list.replaceChildren(frag)
	}

	/**
	 * What OpenRA tells every player about superweapons, read once per status (4 times a second):
	 * - launches, announced from the missile itself: allies of the launcher get the rules'
	 *   launch line and the beacon on its target, everyone else the incoming warning
	 *   (SupportPower.PlayLaunchSounds; RA's Atom Bomb has only the incoming one);
	 * - a GPS satellite, a one-shot OpenRA fires itself the moment it charges (GpsPower.Charged)
	 *   and that then leaves the timers: while its tech centre stands, the timer leaving is the
	 *   launch, rising out of the tech centre for whoever sees it and announced to allies
	 *   ("Satellite launched");
	 * - the public timers (SupportPowerTimerWidget: RA's Atom Bomb and GPS, for everyone).
	 */
	private readLaunchesAndTimers(ctx: Ctx, status: SupportPowersStatus | null, tickMs: number): void {
		this.revealedFakes.clear()
		for (const id of status?.revealed ?? []) this.revealedFakes.add(id)
		for (const launch of status?.launches ?? []) {
			if (this.announcedLaunches.has(launch.id)) continue
			this.announcedLaunches.add(launch.id)
			if (launch.text) this.showNotice(launch.text, launch.allied ? 'default' : 'warn')
			// An ally's missile: OpenRA shows its beacon to the launcher's allies. The viewer's own
			// launch posted its beacon when its charge restarted.
			if (launch.allied && launch.player !== this.renderPlayerId && launch.beaconTicks > 0 && (launch.targetX !== 0 || launch.targetY !== 0))
				this.postSupportBeacon(ctx, { beaconTicks: launch.beaconTicks }, launch.targetX * WPOS_TO_M, launch.targetY * WPOS_TO_M)
		}
		if (this.announcedLaunches.size > 64) {
			const keep = [...this.announcedLaunches].slice(-32)
			this.announcedLaunches.clear()
			for (const id of keep) this.announcedLaunches.add(id)
		}
		const timers = status?.timers ?? []
		this.seenTimers.clear()
		for (const t of timers) {
			const id = `${t.player}:${t.key}`
			this.seenTimers.add(id)
			this.timerStates.set(id, { ready: t.ready, allied: t.allied, launchText: t.launchText ?? null, key: t.key, player: t.player })
		}
		for (const [id, prev] of this.timerStates) {
			if (this.seenTimers.has(id)) continue
			this.timerStates.delete(id)
			if (!/gps/i.test(prev.key)) continue
			// Its tech centre gone, the timer left with it: that was no launch.
			const atek = this.visibleActorOf(ctx, prev.player, 'atek')
			if (atek === null) continue
			if (prev.allied && prev.launchText) this.showNotice(prev.launchText)
			this.supportFx(ctx)?.supportEffect?.('satellite', atek.x, atek.z)
		}
		const list = this.hudTimers
		if (!list) return
		const secondsLeft = (ticks: number): number => Math.ceil(ticks * tickMs / 1000)
		const sig = timers.map(t => `${t.player}:${t.key}:${t.ready ? 1 : 0}${t.active ? 1 : 0}:${secondsLeft(t.remainingTicks)}`).join('|')
		if (sig === this.timersSig) return
		this.timersSig = sig
		list.hidden = timers.length === 0
		const frag = document.createDocumentFragment()
		for (const t of timers) {
			const row = document.createElement('div')
			row.className = t.ready ? 'hud-timer ready' : 'hud-timer'
			const swatch = document.createElement('i')
			swatch.style.background = /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : '#888'
			const name = document.createElement('span')
			name.textContent = `${t.playerName} · ${t.title}`
			const clock = document.createElement('b')
			const left = secondsLeft(t.remainingTicks)
			clock.textContent = t.ready ? 'READY' : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}${t.active ? '' : ' ‖'}`
			row.title = t.ready ? `${t.playerName}: ${t.title} klaar` : `${t.playerName}: ${t.title} over ${clock.textContent}${t.active ? '' : ' (gepauzeerd)'}`
			row.append(swatch, name, clock)
			frag.appendChild(row)
		}
		list.replaceChildren(frag)
	}

	/** World position of a visible, living actor of `type` owned by snapshot player `player`. */
	private visibleActorOf(ctx: Ctx, player: number, type: string): { x: number; z: number } | null {
		const actors = ctx.snapshot?.actors
		if (!actors) return null
		for (let i = 0; i < actors.count; i++) {
			if (actors.owner[i] !== player || (actors.flags[i] & ActorFlag.husk) !== 0) continue
			if (ctx.actorTypeName(actors.typeId[i]).toLowerCase() !== type) continue
			return { x: actors.posX[i] * WPOS_TO_M, z: actors.posY[i] * WPOS_TO_M }
		}
		return null
	}

	/**
	 * Armed support power aim. Like attack-move, only a left release inside the canvas acts.
	 * Chronoshift takes two: the first picks the source cell, the second the destination.
	 */
	private updateSupportPowerTargeting(ctx: Ctx): void {
		const pointer = ctx.input.pointer
		const key = this.supportPowerArmed
		if (!key || (pointer.released & 1) === 0 || !pointer.inside) return
		const camera = ctx.get<CameraApi>('camera')
		const cell = camera.pickGroundCell(pointer.x, pointer.y, ctx)
		if (!cell) return
		const status = ctx.supportPowers?.()?.powers?.find(p => p.key === key) ?? null
		const title = status?.title ?? 'Support power'
		// OpenRA's own targeting refuses these clicks; sent anyway, the engine spends the
		// charge on nothing. The power stays armed so the player can pick again.
		const problem = this.supportTargetProblem(ctx, key, cell, status?.needsSource === true && this.supportPowerSource === null)
		if (problem !== null) {
			this.showNotice(`${title} · ${problem} · kies opnieuw · rechtsklik of Esc annuleert`)
			return
		}
		if (status?.needsSource && this.supportPowerSource === null) {
			this.supportPowerSource = { x: cell.x, y: cell.y }
			this.showNotice(`${title} · bron gekozen · klik de bestemming · rechtsklik of Esc annuleert`)
			return
		}
		const source = this.supportPowerSource
		this.supportPowerArmed = null
		this.supportPowerSource = null
		// SupportPowerManager is a player-actor trait, so the power is the player's own order:
		// zero subjects. uint.MaxValue extra data lets Airstrike and Paratroopers pick their own
		// approach; Chronoshift carries its source cell as ExtraLocation.
		void ctx.issueOrder({
			orderString: key, subjectIds: NO_SUBJECTS, subjectCount: 0, targetCell: cell, queued: false,
			extraData: 0xFFFFFFFF, extraCell: source ?? undefined,
		})
		// The reticle rides the exact cursor hit; the beacon pins the strike CELL, because
		// the delivered payload lands on the cell, not on the pixel. Both wait for the verdict.
		const point = camera.pickGroundPoint(pointer.x, pointer.y, ctx)
		this.supportPowerPending = {
			key, title, x: point ? point.x : cell.x + 0.5, z: point ? point.z : cell.y + 0.5,
			cellX: cell.x, cellY: cell.y, issuedMs: performance.now(),
		}
		this.showNotice(`${title} · wacht op bevestiging`)
	}

	/**
	 * Why OpenRA would refuse this aim, or null. The Iron Curtain needs one of our or an ally's
	 * units under its plus-shaped footprint, and a Chronoshift source one of our own
	 * (GrantExternalConditionPower / ChronoshiftPower `UnitsInRange`, Footprint `_x_ xxx _x_`); a
	 * Chronoshift destination must be explored; a sonar pulse needs open water we have seen.
	 */
	private supportTargetProblem(ctx: Ctx, key: string, cell: { x: number; y: number }, pickingSource: boolean): string | null {
		const actors = ctx.snapshot?.actors
		const underFootprint = (allies: boolean): boolean => {
			if (!actors) return false
			for (let i = 0; i < actors.count; i++) {
				if ((actors.flags[i] & ActorFlag.husk) !== 0 || actors.health[i] === 0) continue
				const dx = Math.floor(actors.posX[i] / 1024) - cell.x, dy = Math.floor(actors.posY[i] / 1024) - cell.y
				if (Math.abs(dx) + Math.abs(dy) > 1) continue
				if (actors.owner[i] === this.renderPlayerId) return true
				if (allies && ctx.snapshot?.players?.[actors.owner[i]]?.relation === 1) return true
			}
			return false
		}
		const explored = (this.shroud?.stateAt(cell.x, cell.y) ?? ShroudState.unexplored) !== ShroudState.unexplored
		if (/GrantExternalCondition|IronCurtain/i.test(key))
			return underFootprint(true) ? null : 'geen eigen eenheid onder het gordijn'
		if (/Chronoshift/i.test(key))
			return pickingSource ? (underFootprint(false) ? null : 'geen eigen eenheid op de bron') : explored ? null : 'bestemming is onverkend'
		if (/Sonar/i.test(key)) {
			const water = this.terrain?.waterHeightAt(cell.x + 0.5, cell.y + 0.5) ?? null
			return water !== null && explored ? null : 'kies open water dat je gezien hebt'
		}
		return null
	}

	private handleHudClick(event: Event): void {
		const power = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-power]') : null
		if (power) {
			const key = power.dataset.power ?? null
			this.supportPowerArmed = key
			this.supportPowerSource = null
			const status = this.ctx?.supportPowers?.()?.powers?.find(p => p.key === key) ?? null
			this.showNotice(status?.needsSource
				? `${status.title} · klik de bron · rechtsklik of Esc annuleert`
				: `${status?.title ?? 'Support power'} · klik een doel · rechtsklik of Esc annuleert`)
			return
		}
		const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-actor-type]') : null
		const ctx = this.ctx
		if (!button || !ctx || button.disabled) return
		const actorType = Number(button.dataset.actorType)
		const actorName = ctx.actorTypeName(actorType)
		if (!actorName) return
		if (button.dataset.ready === '1' && button.dataset.building === '1') {
			this.armPlacement(actorName, actorType, Number(button.dataset.queueId))
			return
		}
		this.issueProductionAction(button, event as MouseEvent, 0)
	}

	/** A finished structure follows the cursor until it is placed; Esc or right click cancels. */
	private armPlacement(actorName: string, actorType: number, queueId: number): void {
		this.setSellMode(false)
		this.pendingPlacement = { actorName, actorType, queueId, variant: 0 }
		this.placementResult = null
		this.placementQueryKey = ''
		this.updatePlacementHud()
	}

	/** A ready-tray card arms that structure's placement; a second click on the armed card cancels. */
	private handleReadyClick(event: Event): void {
		const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-ready-type]') : null
		const ctx = this.ctx
		if (!button || !ctx) return
		const actorType = Number(button.dataset.readyType)
		const queueId = Number(button.dataset.readyQueue)
		const actorName = ctx.actorTypeName(actorType)
		if (!actorName) return
		const armed = this.pendingPlacement
		if (armed && armed.actorType === actorType && armed.queueId === queueId) this.cancelPlacement()
		else this.armPlacement(actorName, actorType, queueId)
		this.uiCue('confirm')
	}

	/**
	 * The first-match tutorial: on the first world snapshot of a match, unless the player
	 * finished or skipped it before, automation is driving (navigator.webdriver) or the URL
	 * says ?tutorial=off. Spectators (no render player) never get it.
	 */
	private maybeStartTutorial(snap: Snapshot): void {
		if (this.tutorial || snap.world?.renderPlayer === 0xffff) return
		let storage: Storage | null = null
		try { storage = globalThis.localStorage ?? null } catch { /* blocked */ }
		if (!shouldAutoStart(location.search, navigator.webdriver === true, storage)) return
		this.startTutorial()
	}

	/** Start (or restart, from Menu → Replay tutorial) with the build order for the known faction. */
	private startTutorial(): void {
		this.stopTutorial()
		const byId = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null
		const elements = {
			root: byId('tutorial'), ring: byId('tutorial-ring'), count: byId('tutorial-count'),
			title: byId('tutorial-title'), body: byId('tutorial-body'), facts: byId('tutorial-facts'),
			status: byId('tutorial-status'), order: byId<HTMLOListElement>('tutorial-order'),
			back: byId<HTMLButtonElement>('tutorial-back'), next: byId<HTMLButtonElement>('tutorial-next'),
			skip: byId<HTMLButtonElement>('tutorial-skip'), close: byId<HTMLButtonElement>('tutorial-close'),
		}
		if (Object.values(elements).some(element => element === null)) return
		this.tutorialFaction = this.localFactionId
		this.tutorial = new Tutorial(elements as TutorialElements, this.tutorialStepsFor(this.tutorialFaction), {
			onEnd: () => {
				let storage: Storage | null = null
				try { storage = globalThis.localStorage ?? null } catch { /* blocked */ }
				markTutorialDone(storage)
				this.tutorial = null
			},
			cue: name => this.uiCue(name),
		})
		this.tutorial.start()
	}

	private stopTutorial(): void {
		this.tutorial?.destroy()
		this.tutorial = null
	}

	private tutorialStepsFor(faction: string): ReturnType<typeof tutorialSteps> {
		const actors = (RA_VISUAL_MANIFEST as unknown as { actors: ManifestActors }).actors
		return tutorialSteps(beginnerBuildOrder(actors, faction), { multiplayer: this.mpMatch })
	}

	/**
	 * Feed the tutorial the match state it teaches from: what the player owns, their
	 * Structures/Defense queue and power. The faction resolves from the player record, or from
	 * which barracks the queue offers when the lobby said "Random".
	 */
	private updateTutorial(snap: Snapshot, ctx: Ctx, player: Snapshot['players'][number]): void {
		const tutorial = this.tutorial
		if (!tutorial) return
		if ((snap.flags & HeaderFlag.gameOver) !== 0) {
			this.stopTutorial()
			return
		}
		const owned = new Map<string, number>()
		const actors = snap.actors
		if (actors) for (let i = 0; i < actors.count; i++) {
			if (actors.owner[i] !== this.renderPlayerId) continue
			const name = ctx.actorTypeName(actors.typeId[i])
			if (name) owned.set(name, (owned.get(name) ?? 0) + 1)
		}
		const queue = new Map<string, QueueItemState>()
		for (const production of snap.production) {
			if (production.playerId !== this.renderPlayerId || production.kind !== 0) continue
			for (const item of production.items) {
				const name = ctx.actorTypeName(item.actorType)
				if (!name) continue
				const current = (item.flags & ProductionItemFlag.current) !== 0
				queue.set(name, {
					buildable: (item.flags & ProductionItemFlag.buildable) !== 0,
					current,
					ready: (item.flags & ProductionItemFlag.ready) !== 0 && (item.flags & ProductionItemFlag.building) !== 0,
					queued: item.queued,
					progress: current ? production.progressPermille / 10 : 0,
				})
			}
		}
		const actorsTable = (RA_VISUAL_MANIFEST as unknown as { actors: ManifestActors }).actors
		let faction = ctx.actorTypeName(player.factionId) || this.localFactionId
		if (!sideOf(actorsTable, faction)) faction = queue.has('barr') ? 'soviet' : queue.has('tent') ? 'allies' : faction
		if (faction !== this.tutorialFaction && sideOf(actorsTable, faction) !== sideOf(actorsTable, this.tutorialFaction)) {
			this.tutorialFaction = faction
			tutorial.setSteps(this.tutorialStepsFor(faction))
		}
		tutorial.update({ owned, queue, powerDrawn: player.powerDrawn, powerSupplied: player.powerSupplied })
	}

	/**
	 * Finished structures waiting for a spot, in a tray above the compass: one card each, click
	 * to place (owner, 2026-09-25: "when something is built I don't see that it is ready"). The
	 * same click-then-place flow as a READY tile in the build pane; the armed card reads PLACING.
	 */
	private syncReadyTray(queues: readonly ProductionQueueView[], ctx: Ctx): void {
		const tray = this.hudReady
		const list = this.hudReadyList
		if (!tray || !list) return
		const armed = this.pendingPlacement
		let key = armed ? `${armed.queueId}:${armed.actorType}|` : '|'
		for (let i = 0; i < queues.length; i++) {
			const queue = queues[i]
			if (queue.playerId !== this.renderPlayerId) continue
			for (let j = 0; j < queue.items.length; j++) {
				const flags = queue.items[j].flags
				if ((flags & ProductionItemFlag.ready) !== 0 && (flags & ProductionItemFlag.building) !== 0)
					key += `${queue.queueId}:${queue.items[j].actorType},`
			}
		}
		if (key === this.readyTrayKey) return
		this.readyTrayKey = key
		const cards: HTMLButtonElement[] = []
		for (const entry of key.slice(key.indexOf('|') + 1).split(',')) {
			if (!entry) continue
			const [queueId, actorType] = entry.split(':').map(Number)
			const actorName = ctx.actorTypeName(actorType)
			if (!actorName) continue
			const placing = armed !== null && armed.queueId === queueId && armed.actorType === actorType
			const card = document.createElement('button')
			card.type = 'button'
			card.className = 'hud-ready__item'
			card.dataset.readyType = String(actorType)
			card.dataset.readyQueue = String(queueId)
			card.dataset.actorName = actorName
			card.setAttribute('aria-pressed', String(placing))
			const name = actorDisplayName(ctx, actorType, this.localFactionId)
			card.title = placing ? `Placing ${name}: click open ground · Esc or right click cancels` : `${name} is ready: click, then click open ground to place it`
			const portrait = productionPortrait(actorName, ctx.get<UnitsApi>('units').roleActors?.get(actorName))
			if (portrait) {
				const image = document.createElement('img')
				image.className = 'hud-ready__art'
				image.src = portrait
				image.alt = ''
				image.width = 256
				image.height = 192
				image.decoding = 'async'
				image.draggable = false
				card.append(image)
			}
			const label = document.createElement('span')
			label.className = 'hud-ready__name'
			label.textContent = name
			const cta = document.createElement('span')
			cta.className = 'hud-ready__cta'
			cta.textContent = placing ? 'Placing · Esc cancels' : 'Ready · click to place'
			card.append(label, cta)
			cards.push(card)
		}
		list.replaceChildren(...cards)
		tray.hidden = cards.length === 0
	}

	private handleHudContext(event: Event): void {
		const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-actor-type]') : null
		const ctx = this.ctx
		if (!button || !ctx) return
		event.preventDefault()
		this.issueProductionAction(button, event as MouseEvent, (event as MouseEvent).button === 1 ? 1 : 2)
	}

	private issueProductionAction(button: HTMLButtonElement, event: MouseEvent, mouseButton: number): void {
		const ctx = this.ctx
		if (!ctx?.snapshot) return
		const actorType = Number(button.dataset.actorType)
		const queue = ctx.snapshot.production.find(q => q.playerId === this.renderPlayerId && q.queueId === Number(button.dataset.queueId))
		const item = queue?.items.find(i => i.actorType === actorType)
		const actorName = ctx.actorTypeName(actorType)
		if (!queue || !item || !actorName) return
		const action = productionAction(queue, item, mouseButton, event.shiftKey, event.ctrlKey)
		if (action) {
			ctx.issueOrder({ ...action, subjectIds: EMPTY_SUBJECTS, targetString: actorName })
			// "Building" belongs to the moment construction starts in the menu, not to
			// placement; "Construction complete" arrives with productionComplete at 100%
			// (showProductionComplete). Same-tick dedup keeps shift-queued rows to one line.
			const visual = (RA_VISUAL_MANIFEST as unknown as { actors: Record<string, { visualFamily?: string }> }).actors[actorName.toLowerCase()]
			if (action.orderString === 'StartProduction' && visual?.visualFamily === 'structure')
				this.eva?.say('Building', ctx.snapshot.tick)
		}
	}

	/**
	 * The bottom-centre mode bar. Placement arming and sell targeting share it because
	 * they are the two mutually exclusive click-targeting modes, and both buttons read
	 * their armed state from here so the panel can never show a stale toggle.
	 */
	private updatePlacementHud(): void {
		if (!this.hudPlacement) return
		const pending = this.pendingPlacement
		const placing = pending !== null
		// The prompt is the shared bar for the two armed click-modes; hidden whenever
		// neither is active so it never promises an interaction the player did not arm.
		this.hudPlacement.hidden = !placing && !this.sellMode
		if (pending !== null) {
			const status = this.placementResult && !this.placementResult.valid
				? ` · ${this.placementResult.status.replaceAll('-', ' ')}`
				: ''
			this.hudPlacement.textContent = `Place ${actorDisplayName(this.ctx, pending.actorType)}${status} · click ground · Esc cancels`
		} else {
			this.hudPlacement.textContent = this.sellMode
				? 'Sell · click one of your buildings · Esc or right-click cancels'
				: ''
		}
		this.hudBuy?.setAttribute('aria-pressed', placing ? 'true' : 'false')
		this.hudSell?.setAttribute('aria-pressed', this.sellMode ? 'true' : 'false')
	}

	/**
	 * The deploy button sends the order OpenRA's own deploy hotkey would: DeployTransform
	 * for a Transforms actor (the MCV), Unload for a Cargo actor, GrantConditionOnDeploy for
	 * a deploy-in-place unit. ActorFlag.deployable is host-computed from IIssueDeployOrder
	 * and says only that SOME deploy order exists; the manifest says which.
	 */
	private deploySelection(event: MouseEvent): void {
		const ctx = this.ctx
		const actors = ctx?.snapshot?.actors
		if (!ctx || !actors || this.selected.length !== 1) return
		for (let i = 0; i < actors.count; i++) {
			if (actors.id[i] !== this.selected[0] || actors.owner[i] !== this.renderPlayerId ||
				(actors.flags[i] & ActorFlag.deployable) === 0) continue
			const deploy = deployOrderFor(ctx.get<UnitsApi>('units'), ctx.actorTypeName(actors.typeId[i]))
			if (!deploy) return
			this.deploySubjects[0] = actors.id[i]
			ctx.issueOrder({
				orderString: deploy.order,
				subjectIds: this.deploySubjects,
				queued: event.shiftKey,
			})
			return
		}
	}

	private updateSelectionHud(ctx: Ctx): void {
		const name = this.hudSelectionName
		const detail = this.hudSelectionDetail
		const bar = this.hudHealth
		if (!name || !detail || !bar) return
		if (this.hudDeploy) this.hudDeploy.hidden = true
		if (this.hudPrimary) this.hudPrimary.hidden = true
		if (this.hudRepair) {
			this.hudRepair.hidden = true
			this.hudRepair.setAttribute('aria-pressed', 'false')
			this.hudRepair.textContent = 'Repair'
		}
		const actors = ctx.snapshot?.actors
		if (!actors || this.selected.length === 0) {
			name.textContent = 'No selection'
			detail.textContent = 'Click a unit or building. Production buildings focus their own build queue.'
			bar.style.width = '0%'
			return
		}
		const id = this.selected[0]
		let actorIndex = -1
		for (let i = 0; i < actors.count; i++) if (actors.id[i] === id) { actorIndex = i; break }
		if (actorIndex < 0) return
		const health = actors.health[actorIndex]
		const typeId = actors.typeId[actorIndex]
		const actorName = ctx.actorTypeName(typeId)
		const units = ctx.get<UnitsApi>('units')
		const role = units.semanticRole(actorName)
		const producerKind = units.productionKind(actorName)
		const passengers = actors.cargo[actorIndex]
		// Capacity is the Cargo trait's MaxWeight: infantry weigh 1, vehicles more, so it is
		// shown as filled/capacity rather than as a pair of prose counts.
		const capacity = units.cargoCapacity(actorName)
		const cargoText = capacity > 0 ? ` · cargo ${passengers}/${capacity}` : passengers > 0 ? ` · cargo ${passengers}` : ''
		const ammoCap = units.ammoCapacity(actorName)
		const ammo = actors.ammo ? actors.ammo[actorIndex] : 255
		const ammoText = ammoCap > 0 && ammo !== 255 ? ` · ammo ${ammo}/${ammoCap}` : ''
		const healthText = `health ${Math.round(health * 100 / 255)}%${cargoText}${ammoText}${this.groupLabelFor(id)}`
		name.textContent = this.selected.length > 1
			? `${this.selected.length} assets selected`
			: actorDisplayName(ctx, typeId)
		detail.textContent = producerKind >= 0 && actors.owner[actorIndex] === this.renderPlayerId
			? `${QUEUE_NAMES[producerKind]} producer · choose an item in the focused build panel · ${healthText}`
			: role === 'refinery' && actors.owner[actorIndex] === this.renderPlayerId
				? `Ore economy · trucks unload here · construction delivers one Ore Truck automatically · ${healthText}`
				: role === 'harvester' && actors.owner[actorIndex] === this.renderPlayerId
					? `Automatic ore collector · ${(actors.flags[actorIndex] & ActorFlag.moving) !== 0 ? 'moving / harvesting' : 'loading, unloading or awaiting ore'} · ${healthText}`
					: `ID ${id} · ${healthText} · owner ${actors.owner[actorIndex]}`
		bar.style.width = `${health * 100 / 255}%`
		bar.style.background = health < 80 ? uiPalette.critical : health < 160 ? uiPalette.warning : uiPalette.healthy
		if (this.hudDeploy && this.selected.length === 1 && actors.owner[actorIndex] === this.renderPlayerId &&
			(actors.flags[actorIndex] & ActorFlag.deployable) !== 0) {
			const deploy = deployOrderFor(units, actorName)
			// An empty transport has nothing to unload: the host still flags it deployable
			// (Cargo.CanIssueDeployOrder is unconditional), so the count decides here.
			this.hudDeploy.hidden = deploy === null || (deploy.order === 'Unload' && passengers === 0)
			if (deploy) this.hudDeploy.textContent = deploy.label
		}
		if (this.hudPrimary && this.selected.length === 1 && actors.owner[actorIndex] === this.renderPlayerId &&
			units.hasRaTrait(actorName, 'PrimaryBuilding')) this.hudPrimary.hidden = false
		if (this.hudRepair && this.selected.length === 1 && actors.owner[actorIndex] === this.renderPlayerId &&
			repairableActor(actorName)) {
			const repairing = this.isRepairing(id)
			// Always visible on an own repairable selection — discoverability beat the old
			// "only when damaged" hiding, which read as a missing feature.
			this.hudRepair.hidden = false
			this.hudRepair.textContent = repairing ? 'Stop repair' : 'Repair'
			this.hudRepair.setAttribute('aria-pressed', repairing ? 'true' : 'false')
		}
	}

	/** ` · group N` when the actor is a lone member of a control group, else ''. */
	private groupLabelFor(id: number): string {
		for (const [n, members] of this.groupMembers) {
			if (members.length === 1 && members[0] === id) return ` · group ${n}`
		}
		return ''
	}

	/**
	 * Toggle OpenRA's RepairBuilding order on the selected structure. Cash is taken by
	 * the simulation as hull is restored (20% of sell value, in steps), the same as the
	 * original wrench. A second click cancels. The world mark is local until the next
	 * snapshot proves the building is gone or fully healed.
	 */
	private repairSelection(): void {
		const ctx = this.ctx
		const actors = ctx?.snapshot?.actors
		if (!ctx || !actors || this.selected.length !== 1) return
		const id = this.selected[0]
		let actorIndex = -1
		for (let i = 0; i < actors.count; i++) if (actors.id[i] === id) { actorIndex = i; break }
		if (actorIndex < 0) return
		if (actors.owner[actorIndex] !== this.renderPlayerId) return
		const actorName = ctx.actorTypeName(actors.typeId[actorIndex])
		if (!repairableActor(actorName)) {
			this.showNotice(`${actorDisplayName(ctx, actors.typeId[actorIndex])} cannot be repaired`)
			return
		}
		const repairing = this.isRepairing(id)
		if (!repairing && actors.health[actorIndex] >= 255) {
			this.showNotice('Hull is already intact')
			return
		}
		ctx.issueOrder({ orderString: 'RepairBuilding', subjectIds: EMPTY_SUBJECTS, targetActorId: id })
		this.setRepairing(id, !repairing)
		this.markOrder(actors.posX[actorIndex] * WPOS_TO_M, actors.posY[actorIndex] * WPOS_TO_M, true)
		this.showNotice(repairing
			? `Repair cancelled on ${actorDisplayName(ctx, actors.typeId[actorIndex])}`
			: `Repairing ${actorDisplayName(ctx, actors.typeId[actorIndex])} · funds deduct as hull is restored`)
		this.updateSelectionHud(ctx)
	}
}

const UNRESOLVED_TYPEIDS_WARNED = new Set<number>()

/** Game time for people: 4:07, or 1:02:37 past the hour. */
function formatDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000))
	const h = Math.floor(total / 3600)
	const m = Math.floor((total % 3600) / 60)
	const sec = String(total % 60).padStart(2, '0')
	return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

function actorDisplayName(ctx: Ctx | null, typeId: number, localFactionId = ''): string {
	if (!ctx) return 'Unknown asset'
	const actorName = ctx.actorTypeName(typeId)
	if (!actorName) {
		// 'Unknown asset' means a STRING-TABLE miss, not a missing display name — every
		// buildable actor is named in the roster. Warn once per id so the offender is
		// findable in a dev console instead of silently rendering a placeholder.
		if (!UNRESOLVED_TYPEIDS_WARNED.has(typeId)) {
			UNRESOLVED_TYPEIDS_WARNED.add(typeId)
			console.warn(`[ui] actorDisplayName: unresolved typeId ${typeId} — string-table miss`)
		}
		return 'Unknown asset'
	}
	if (actorName === 'e2' && !['russia', 'ukraine'].includes(localFactionId)) return 'Jackson'
	const resolved = ctx.get<UnitsApi>('units').displayName(actorName)
	return resolved || fallbackName(actorName)
}

function fallbackName(name: string): string {
	if (!name) return 'Unknown asset'
	return name.replace(/^(?:foundry|lattice|drift)_/, '').replaceAll('_', ' ')
}

/** Project one world point and return its CSS-pixel distance from an already projected centre. */
function projectedDistancePx(
	vp: ArrayLike<number>, x: number, y: number, z: number,
	centreX: number, centreY: number, viewW: number, viewH: number,
): number {
	const w = vp[3] * x + vp[7] * y + vp[11] * z + vp[15]
	if (w <= 0) return 0
	const sx = ((vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / w * 0.5 + 0.5) * viewW
	const sy = (0.5 - (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / w * 0.5) * viewH
	return Math.hypot(sx - centreX, sy - centreY)
}

function projectActorCentre(
	vp: ArrayLike<number>, actors: NonNullable<Snapshot['actors']>, index: number,
	units: UnitsApi, terrain: TerrainApi | null, viewW: number, viewH: number,
): ActorProjection | null {
	return projectActorCentreInto(vp, actors, index, units, terrain, viewW, viewH, ACTOR_PROJECTION)
		? ACTOR_PROJECTION : null
}

/** As `projectActorCentre`, but into a caller-owned record: the per-frame paths pick with
 *  this shape so aiming the cursor never allocates a per-actor result object. */
function projectActorCentreInto(
	vp: ArrayLike<number>, actors: NonNullable<Snapshot['actors']>, index: number,
	units: UnitsApi, terrain: TerrainApi | null, viewW: number, viewH: number,
	out: ActorProjection,
): boolean {
	if (!terrain) return false
	// Pick what is actually drawn. Snapshot ground positions miss airborne aircraft and
	// interpolate a moving actor at a different point; they can also expose hidden actors.
	if (!units.captureActorVisual(actors.id[index], PICK_TRANSFORM, 0, PICK_VISUAL) || !PICK_VISUAL.mesh) {
		// FALLBACK (restored from 9002b17): the mesh capture can miss intermittently
		// (bucket rebuild, capacity squeeze). The snapshot ALWAYS has a position — use
		// it so the health bar / selection ring never flickers. Height comes from the
		// selection metadata (which has its own 1.2 m default) rather than the mesh AABB.
		PROJECTED_DRAWN = false
		const x = actors.posX[index] * WPOS_TO_M
		const z = actors.posY[index] * WPOS_TO_M
		const height = units.selectionHeightM(actors.typeId[index])
		// On the DRAWN ground, as every actor is placed: the simulation's altitude alone put a
		// wall on a hill under the hill, where no click could find it.
		const groundY = terrain.heightAt(x, z) + actors.posZ[index] * WPOS_TO_M
		const worldY = groundY + height * .5
		const w = vp[3] * x + vp[7] * worldY + vp[11] * z + vp[15]
		if (w <= 0) return false
		out.x = ((vp[0] * x + vp[4] * worldY + vp[8] * z + vp[12]) / w * 0.5 + 0.5) * viewW
		out.y = (0.5 - (vp[1] * x + vp[5] * worldY + vp[9] * z + vp[13]) / w * 0.5) * viewH
		out.worldX = x
		out.worldY = worldY
		out.worldZ = z
		out.groundY = groundY
		out.height = height
		return true
	}
	PROJECTED_DRAWN = true
	const m = PICK_TRANSFORM, mesh = PICK_VISUAL.mesh
	const cx = (mesh.aabbMin[0] + mesh.aabbMax[0]) * .5
	const cy = (mesh.aabbMin[1] + mesh.aabbMax[1]) * .5
	const cz = (mesh.aabbMin[2] + mesh.aabbMax[2]) * .5
	const worldX = m[0] * cx + m[4] * cy + m[8] * cz + m[12]
	const worldY = m[1] * cx + m[5] * cy + m[9] * cz + m[13]
	const worldZ = m[2] * cx + m[6] * cy + m[10] * cz + m[14]
	const height = Math.max(.5, mesh.aabbMax[1] - mesh.aabbMin[1])
	const groundY = worldY - height * .5
	const w = vp[3] * worldX + vp[7] * worldY + vp[11] * worldZ + vp[15]
	if (w <= 0) return false
	out.x = ((vp[0] * worldX + vp[4] * worldY + vp[8] * worldZ + vp[12]) / w * 0.5 + 0.5) * viewW
	out.y = (0.5 - (vp[1] * worldX + vp[5] * worldY + vp[9] * worldZ + vp[13]) / w * 0.5) * viewH
	out.worldX = worldX
	out.worldY = worldY
	out.worldZ = worldZ
	out.groundY = groundY
	out.height = height
	return true
}

function pickActorAt(
	vp: ArrayLike<number>, actors: NonNullable<Snapshot['actors']>, units: UnitsApi,
	terrain: TerrainApi | null, pointerX: number, pointerY: number, viewW: number, viewH: number,
	typeName?: (typeId: number) => string, targetMode = false, eye?: ArrayLike<number> | null,
): number {
	let best = -1
	let bestScore = 1
	// With the eye known, an actor whose drawn box the pointer's ray enters wins outright, the
	// frontmost one; nearness to a projected centre only decides a click that meets no box
	// (small infantry keep their generous ring).
	const exact = setPointerRay(vp, eye, pointerX, pointerY, viewW, viewH)
	let boxed = -1
	let boxT = Infinity
	for (let i = 0; i < actors.count; i++) {
		if (typeName) {
			const name = typeName(actors.typeId[i])
			if (!units.hasRaTrait(name, 'Selectable') &&
				!(targetMode && units.hasRaTrait(name, 'Targetable') && units.hasRaTrait(name, 'Health'))) continue
		}
		const screen = projectActorCentre(vp, actors, i, units, terrain, viewW, viewH)
		if (!screen) continue
		const radius = units.selectionRadiusM(actors.typeId[i])
		// Project the real horizontal footprint and mesh height. This accepts clicks on
		// the roof and outer cells of large buildings instead of only a fixed centre spot.
		const pickRadius = Math.max(targetMode ? TARGET_RADIUS_PX : PICK_RADIUS_PX,
			projectedDistancePx(vp, screen.worldX + radius, screen.worldY, screen.worldZ, screen.x, screen.y, viewW, viewH),
			projectedDistancePx(vp, screen.worldX, screen.worldY, screen.worldZ + radius, screen.x, screen.y, viewW, viewH),
			projectedDistancePx(vp, screen.worldX, screen.groundY, screen.worldZ, screen.x, screen.y, viewW, viewH),
			projectedDistancePx(vp, screen.worldX, screen.groundY + screen.height, screen.worldZ, screen.x, screen.y, viewW, viewH))
		const score = ((screen.x - pointerX) ** 2 + (screen.y - pointerY) ** 2) / (pickRadius * pickRadius)
		if (exact && score < 4) {
			const mesh = PICK_VISUAL.mesh
			const t = PROJECTED_DRAWN && mesh
				? rayEntersDrawnBox(PICK_TRANSFORM, mesh.aabbMin, mesh.aabbMax)
				: rayEntersFootprint(screen.worldX, screen.groundY, screen.worldZ,
					units.selectionRadiusM(actors.typeId[i]) * Math.SQRT1_2, screen.height)
			if (t < boxT) {
				boxT = t
				boxed = i
				copyProjection(BOX_PICKED, screen)
			}
		}
		if (score >= bestScore) continue
		bestScore = score
		best = i
		// Leave the winner's projection where the hover path reads it: number writes only.
		PICKED.score = score;
		PICKED.x = screen.x
		PICKED.y = screen.y
		PICKED.worldX = screen.worldX
		PICKED.worldY = screen.worldY
		PICKED.worldZ = screen.worldZ
		PICKED.groundY = screen.groundY
		PICKED.height = screen.height
	}
	if (boxed >= 0) {
		copyProjection(PICKED, BOX_PICKED)
		PICKED.score = 0
		PICKED.boxHit = true
		PICKED.t = boxT
		return boxed
	}
	PICKED.boxHit = false
	PICKED.t = Infinity
	return best
}

function copyProjection(out: ActorProjection, from: ActorProjection): void {
	out.x = from.x
	out.y = from.y
	out.worldX = from.worldX
	out.worldY = from.worldY
	out.worldZ = from.worldZ
	out.groundY = from.groundY
	out.height = from.height
}

/** Aim POINTER_RAY through a CSS pixel; false (and no exact pick) without the eye. */
function setPointerRay(vp: ArrayLike<number>, eye: ArrayLike<number> | null | undefined,
	pointerX: number, pointerY: number, viewW: number, viewH: number): boolean {
	POINTER_RAY.ok = false
	if (!eye || !m4.invert(POINTER_RAY_INVERSE, vp as Mat4)) return false
	const m = POINTER_RAY_INVERSE
	const nx = pointerX / Math.max(1, viewW) * 2 - 1, ny = 1 - pointerY / Math.max(1, viewH) * 2
	// Reverse-Z with an infinite far plane: the near plane is z = 1 (camera/pick says why).
	const w = m[3] * nx + m[7] * ny + m[11] + m[15]
	if (!(Math.abs(w) > 1e-12)) return false
	const dx = (m[0] * nx + m[4] * ny + m[8] + m[12]) / w - eye[0]
	const dy = (m[1] * nx + m[5] * ny + m[9] + m[13]) / w - eye[1]
	const dz = (m[2] * nx + m[6] * ny + m[10] + m[14]) / w - eye[2]
	const length = Math.hypot(dx, dy, dz)
	if (!(length > 1e-9)) return false
	POINTER_RAY.ox = eye[0]
	POINTER_RAY.oy = eye[1]
	POINTER_RAY.oz = eye[2]
	POINTER_RAY.dx = dx / length
	POINTER_RAY.dy = dy / length
	POINTER_RAY.dz = dz / length
	POINTER_RAY.ok = true
	return true
}

/**
 * Where POINTER_RAY enters an actor's drawn box: its mesh bounds under its transform (rotated
 * and scaled, never sheared, so the columns are its axes). Infinity when it misses.
 */
function rayEntersDrawnBox(m: ArrayLike<number>, min: ArrayLike<number>, max: ArrayLike<number>): number {
	const r = POINTER_RAY
	const uu = m[0] * m[0] + m[1] * m[1] + m[2] * m[2]
	const vv = m[4] * m[4] + m[5] * m[5] + m[6] * m[6]
	const ww = m[8] * m[8] + m[9] * m[9] + m[10] * m[10]
	if (!(uu > 1e-12 && vv > 1e-12 && ww > 1e-12)) return Infinity
	const px = r.ox - m[12], py = r.oy - m[13], pz = r.oz - m[14]
	return slabEnter(
		(px * m[0] + py * m[1] + pz * m[2]) / uu, (px * m[4] + py * m[5] + pz * m[6]) / vv, (px * m[8] + py * m[9] + pz * m[10]) / ww,
		(r.dx * m[0] + r.dy * m[1] + r.dz * m[2]) / uu, (r.dx * m[4] + r.dy * m[5] + r.dz * m[6]) / vv, (r.dx * m[8] + r.dy * m[9] + r.dz * m[10]) / ww,
		min[0], min[1], min[2], max[0], max[1], max[2])
}

/** Where POINTER_RAY enters an upright square box on the ground, or Infinity. */
function rayEntersFootprint(x: number, groundY: number, z: number, half: number, height: number): number {
	const r = POINTER_RAY
	return slabEnter(r.ox, r.oy, r.oz, r.dx, r.dy, r.dz, x - half, groundY, z - half, x + half, groundY + height, z + half)
}

/** The slab test: the ray's entry distance into an axis-aligned box, or Infinity. */
function slabEnter(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
	minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): number {
	let near = 0, far = Infinity
	if (Math.abs(dx) < 1e-12) { if (ox < minX || ox > maxX) return Infinity } else {
		const a = (minX - ox) / dx, b = (maxX - ox) / dx
		near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b))
	}
	if (Math.abs(dy) < 1e-12) { if (oy < minY || oy > maxY) return Infinity } else {
		const a = (minY - oy) / dy, b = (maxY - oy) / dy
		near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b))
	}
	if (Math.abs(dz) < 1e-12) { if (oz < minZ || oz > maxZ) return Infinity } else {
		const a = (minZ - oz) / dz, b = (maxZ - oz) / dz
		near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b))
	}
	return near <= far ? near : Infinity
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value))
}

/** Fixed one-decimal formatting for SVG overlay coordinates. Twenty-four sites in the
 *  hover bracket template must format in lockstep — same precision, no exponents — so the
 *  behaviour lives in one named place rather than being inlined per coordinate. */
function px1(value: number): string {
	return value.toFixed(1)
}

function formatNumber(value: number): string {
	return Math.max(0, Math.round(value)).toLocaleString('en-US')
}

function identityAt(matrix: Float32Array, x: number, y: number, z: number): void {
	matrix[0] = 1; matrix[1] = 0; matrix[2] = 0; matrix[3] = 0
	matrix[4] = 0; matrix[5] = 1; matrix[6] = 0; matrix[7] = 0
	matrix[8] = 0; matrix[9] = 0; matrix[10] = 1; matrix[11] = 0
	matrix[12] = x; matrix[13] = y; matrix[14] = z; matrix[15] = 1
}

/** §5.10 in-game strings (MULTIPLAYER-SERVICE.md §5.10) — the ids the session
 *  UI speaks. The close-code map (mp-protocol) names ids in this table. */
const MP_STRINGS: Record<string, string> = {
	S1: 'Play online — get the Redline Wars desktop app.',
	// T3.1: the plain browser cannot host (no node of its own) — S2 is its
	// whole Host path. Hosting is desktop-only in v1 (§7 rule 5).
	S2: 'Hosting runs in the desktop app — your computer runs the match. In the browser you join rooms.',
	// T3.7's S18 row: the sweep announcement, then (after 8 s without a LAN
	// row) the reveal text that introduces the address form.
	S18: 'Looking for games on your network…',
	S18b: "No games found. Enter the host's address:",
	// T3.3: the host dialog's "Anyone online" caption note.
	S22: "Can't reach the online lobby. LAN games still work.",
	S23: 'All servers are busy — join a game, or get the desktop app to host your own.',
	S4: 'Could not reach the game (timed out after 20 s).',
	S5: 'Wrong password.',
	S6: 'That game no longer exists.',
	S7: 'That game has already started.',
	S8: 'Too many connections from your network. Try again in a minute.',
	S9: 'The relay is full right now. Try again shortly.',
	S10: 'The host went offline.',
	S11: 'Different version — update Redline Wars to join.',
	S12c: 'Match starting…',
	S13: 'You are now the host.',
	S15: 'Out of sync — this match cannot continue.',
	S20: 'Starting your game server…',
	S21: 'The game server did not start.',
}

/** A host failure for the status line: S23 speaks for itself, anything else says what failed. */
function mpHostFailure(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error)
	return message === MP_STRINGS.S23 ? message : `Network host failed: ${message}`
}

const mpS3 = (room: string): string => `Connecting to ${room}…`
const mpS12a = (players: number, slots: number): string => `In lobby — ${players}/${slots} players`
const mpS12b = (k: number): string => `Waiting for ${k} player${k === 1 ? '' : 's'} to ready up…`
const mpS16 = (reason: string): string => `Connection lost (${reason}). The match has ended for you.`

/** A join step failed with a cause the UI already showed. `error instanceof
 *  MpJoinRefused` is the callers' signal to not print a second, vaguer line. */
class MpJoinRefused extends Error {}

/** The `epoch=N` stamp every probe of a join carries (T1.15). */
function mpProbeEpoch(probe: string): number {
	return Number(/(?:^|\s)epoch=(\d+)/.exec(probe)?.[1] ?? 0)
}

/** Timer-driven pause for the fresh-probe loops. */
function mpDelay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>()
	setTimeout(resolve, ms)
	return promise
}

/** One live room as the /v2 directories report it (§5.2/§5.3) and as LAN
 *  beacon rows repeat it (§5.7). */
interface MpRoomSummary {
	roomId?: string
	createdAt?: number
	name?: string
	/** Authoritative channel URL (T2.3), built by the directory that owns the
	 *  endpoint: ws://127.0.0.1:<mux>/g/<id> on the node, wss://<relay>/g/<id>. */
	wsUrl?: string
	/** Map uid on legacy rows, {uid,title} on /v2 rows. */
	map?: string | { uid?: string; title?: string }
	/** Host-chosen room settings (ambience) echoed by the directory; applied at match start. */
	settings?: Record<string, string>
	slots?: number
	players?: number
	geo?: string
	/** Room lifecycle state on the node (§5.4); relay rows carry it per §5.2. */
	state?: string
	/** Sim build the room's node runs (§5.8); a non-matching build greys the row (S11). */
	build?: string
	/** Native OpenRA server password (L7): ask before connecting. */
	locked?: boolean
	/** Optional control-plane admission result. Missing means legacy/unranked. */
	ranked?: boolean
	/** One-time participant claim; only ranked admission rows carry it. */
	claim?: string
	/** Creator-only claim returned by relay placement; never appears in listings. */
	hostKey?: string
	matchId?: string
	expiresAt?: number
	simBuild?: string
	mapUid?: string
	rulesHash?: string
	/** Optional settlement state from a future ranked room service. */
	settlement?: 'pending' | 'settled' | 'void' | 'error'
	settlementReason?: string | null
	settlementOutcome?: 'won' | 'lost' | 'draw' | 'void' | null
	settlementDelta?: number | null
	settlementRating?: number | null
}

/** Runtime shape checks at the /v2 directory boundary (§5.2/§5.3): the bodies
 *  are network JSON, so the shape is verified before any field is read. */
type MpRoomRow = MpRoomSummary & { roomId: string }

function isMpRoomRow(value: unknown): value is MpRoomRow {
	return typeof value === 'object' && value !== null && 'roomId' in value && typeof value.roomId === 'string'
}

/** §5.2/§5.3 listing body: { rooms: Row[] } — rows without a roomId are dropped. */
function mpRoomList(value: unknown): MpRoomRow[] {
	if (typeof value !== 'object' || value === null || !('rooms' in value) || !Array.isArray(value.rooms)) return []
	return value.rooms.filter(isMpRoomRow)
}

/** §5.3 create answer: 201 { room: Row }; null when the shape does not match. */
function mpCreatedRoom(value: unknown): MpRoomRow | null {
	if (typeof value !== 'object' || value === null || !('room' in value)) return null
	return isMpRoomRow(value.room) ? value.room : null
}

/** §5.9 page→shell bridge (desktop/preload.cjs). Feature-detected everywhere:
 *  the plain web build has none of it, and every method is optional so a
 *  newer shell can grow surfaces without breaking an older page. */
interface RedlineBridge {
	hostStart?(request: { visibility: 'lan' | 'public' }): Promise<unknown>
	hostStop?(): Promise<unknown>
	hostStatus?(): Promise<unknown>
	/** T3.7: asks the shell's LAN listener for a unicast query to `address`. */
	lanQuery?(address: string): unknown
	/** The desktop landing's Multiplayer switch (absent on shells that predate it). */
	getMultiplayerSync?(): boolean
}

function redlineBridge(): RedlineBridge | null {
	const bridge = (globalThis as Record<string, unknown>)['redline']
	return typeof bridge === 'object' && bridge !== null ? bridge as RedlineBridge : null
}

/** The S19 dialog's create mapping (T3.3) that rides on the §5.3 POST body. */
interface MpHostChoice {
	slots: number
	password: string
}

/** lan-beacon.mjs's `isPrivateAddress`, mirrored web-side (NodeLan keeps the
 *  canonical rule): strict dotted-quad IPv4 — true only for private
 *  (10/8, 172.16/12, 192.168/16), link-local (169.254/16) and loopback
 *  (127/8) addresses. IPv6 is out: the beacon is UDP4, so an IPv6 literal
 *  could never be dialed anyway. */
export function isPrivateAddress(value: string): boolean {
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
	if (!match) return false
	const octets = match.slice(1).map(Number)
	if (octets.some(octet => octet > 255)) return false
	const [a, b] = octets
	return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) || (a === 169 && b === 254)
}

/** T3.7's full enter-address rule: `isPrivateAddress` or a `.local` name. */
export function isMpLanAddress(value: string): boolean {
	return isPrivateAddress(value) || /^[a-z0-9-]+\.local$/i.test(value)
}

/** A LAN-discovered room: the directory summary plus the local endpoint
 *  (http://ip:port) the desktop shell's subnet probe found it at. */
interface LanRoomRow extends MpRoomSummary {
	lanDir: string
}

function elem<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Record<string, string> = {},
	children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag)
	for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value)
	for (const child of children) element.append(child)
	return element
}

 function option(value: string, label: string): HTMLOptionElement {
	const element = document.createElement('option')
	element.value = value
	element.textContent = label
	return element
}

function fieldSelect(
	name: string,
	caption: string,
	choices: readonly (readonly [string, string])[],
	selected: string,
): { label: HTMLLabelElement; select: HTMLSelectElement } {
	const label = document.createElement('label')
	label.className = 'session-field'
	const text = document.createElement('span')
	text.textContent = caption
	const select = document.createElement('select')
	select.dataset.field = name
	select.replaceChildren(...choices.map(choice => option(choice[0], choice[1])))
	select.value = selected
	label.append(text, select)
	return { label, select }
}

/** Words that stay lowercase inside a humanised Fluent key: "fog-of-war" is "Fog of War". */
const LABEL_SMALL_WORDS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'on', 'or', 'per', 'the', 'to'])

/** A Fluent reference that no loaded bundle resolved, e.g. `checkbox-fog-of-war.label`. */
function isFluentKey(text: string): boolean {
	return /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/.test(text)
}

/**
 * A readable name for a lobby option.
 *
 * OpenRA option names are Fluent references and the assetless RA mod ships no bundle for the
 * common UI keys, so the catalog hands the lobby back the key itself: this screen was offering
 * a control literally captioned "checkbox-fog-of-war.label", with "checkbox-explored-map.label"
 * beside it. A player cannot find the fog switch that way, let alone the second switch that
 * governs the same thing. Anything that is not a key — map- and mod-authored labels such as
 * "Redeployable MCVs" — is prose already and passes through untouched.
 */
/** A lobby option value's label. OpenRA formats the time limit through Fluent with an
 *  argument ("{minutes} minutes"), which this build does not resolve, so every value would
 *  read "Options"; its value is the number of minutes, so it is labelled from that. */
/** Cue names of the audio node's UI bus, derived so ui/ never imports audio/ (rule 3). */
type UiCue = Parameters<NonNullable<AudioApi['ui']>['cue']>[0]

/** Which console control a lobby option's values call for — no per-option code. */
function controlKind(d: { id: string; values: readonly { id: string; label?: string; name?: string }[] }): 'toggle' | 'segmented' | 'stepper' | 'select' {
	const ids = d.values.map(v => v.id)
	if (ids.length === 2 && ids.includes('True') && ids.includes('False')) return 'toggle'
	if (ids.length >= 3 && ids.every(id => /^\d+$/.test(id))) return 'stepper'
	if (ids.length <= 4 && d.values.every(v => lobbyValueLabel(d.id, v).length <= 14)) return 'segmented'
	return 'select'
}

function lobbyValueLabel(optionId: string, value: { id: string; label?: string; name?: string }): string {
	if (optionId === 'timelimit' && /^\d+$/.test(value.id))
		return value.id === '0' ? 'No limit' : `${value.id} minutes`
	return lobbyLabel(value.label ?? value.name ?? value.id)
}

function lobbyLabel(text: string): string {
	if (!isFluentKey(text)) return text
	const key = text.replace(/\.(?:label|description)$/, '').replace(/^(?:checkbox|dropdown|options)-/, '')
	const tail = key.slice(key.lastIndexOf('.') + 1)
	return tail.split('-')
		.map((word, index) => index > 0 && LABEL_SMALL_WORDS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ')
}

function valueOf(root: HTMLElement, field: string): string {
	return root.querySelector<HTMLSelectElement>(`select[data-field="${field}"]`)?.value ?? ''
}

function rgbaCss(red: number, green: number, blue: number, alpha: number): string {
	return `rgba(${red}, ${green}, ${blue}, ${(alpha / 255).toFixed(3)})`
}

export default Ui
