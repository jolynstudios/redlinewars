// STEELSEED — core barrel.
//
// This is the ONLY module other subsystems may import from, and only for types and
// pure helpers (math, rng, the snapshot decoder). A system INSTANCE is always reached
// at runtime via ctx.get(id) — hard rule 3.

export { App, type BootOptions, type BridgeApi, type OrderIntent, type ContextOrderIntent, type ContextOrderPreview } from './app'
export type {
	CatalogChoice,
	SessionApi,
	SessionStatus,
	SkirmishCatalog,
	SkirmishMapCatalog,
	SkirmishPlayerConfig,
	SkirmishSlotCatalog,
	StartSkirmishConfig,
} from './ctx'
export { buildDevSnapshot, buildDevSnapshotAt, createDevBridge, setDevTypeNames, setDevTypeNamesExact, type DevMapOptions } from './devsnapshot'
export { Clock, SIM_TICK_HZ, SIM_TICK_MS, type TimeState } from './clock'
export { GRAPHICS_CHOICES, QUALITY_NAMES, type GraphicsChoice } from './config'
export {
	detectQualityTier,
	isGraphicsChoice,
	isQualityName,
	MOUNTAINS_STORAGE_KEY,
	QUALITY_STORAGE_KEY,
	type QualityDetection,
	readStoredQuality,
	resolveDistantMountains,
	resolveQuality,
	storeDistantMountains,
	storeQuality,
} from './quality'
export {
	type Backend,
	budgetFor,
	clampQualityToBackend,
	type Config,
	GENERATOR_VERSION,
	makeConfig,
	type QualityBudget,
	type QualityName,
} from './config'
export {
	type CanvasCssSize,
	canvasCssHeight,
	canvasCssWidth,
	type Ctx,
	type CtxHost,
	createCtx,
	type OrderRequest,
	type PlacementApi,
	type PlacementRequest,
	type PlacementResult,
	type SimHealth,
	type SupportPowerStatus,
	type SupportPowersStatus,
	type SupportPowerTimerStatus,
	type SupportLaunchStatus,
} from './ctx'
export { CoreEvent, EventBus, type EventHandler, SIM_EVENT_BY_KIND, SimEvent } from './events'
export { Input, type PointerState } from './input'
export {
	clamp,
	damp,
	DEG2RAD,
	lerp,
	m4,
	type Mat4,
	q4,
	type Quat,
	quat,
	RAD2DEG,
	scratch,
	smoothstep,
	v3,
	type Vec2,
	type Vec3,
	type Vec4,
	vec2,
	vec3,
	vec4,
	mat4,
} from './math'
export { Registry, type System, type SystemClass } from './registry'
export { hashString, Rng, rootRng } from './rng'
export {
	ActorFlag,
	ActorAnimationState,
	ActorStatusKind,
	type ActorStatusView,
	type ActorsView,
	EventKind,
	findActorIndex,
	HeaderFlag,
	type LifecycleEntry,
	LifecycleKind,
	lerpFacing,
	PlayerFlag,
	type PlayerQueueView,
	type PlayerView,
	ProductionItemFlag,
	type ProductionItemView,
	ProductionQueueFlag,
	type ProductionQueueView,
	ProjectileKind,
	type ProjectilesView,
	type ResourcesView,
	SectionId,
	type ShroudRun,
	ShroudState,
	type Snapshot,
	SnapshotDecodeError,
	SnapshotDecoder,
	SNAPSHOT_MAGIC,
	SNAPSHOT_U16_ABSENT,
	SNAPSHOT_VERSION,
	type SnapshotEvent,
	type TerrainStaticView,
	WANGLE_TURN,
	wangleToRadians,
	WDIST_CELL,
	type WorldView,
} from './snapshot'
export { Surface, type SurfaceType } from './surface'
