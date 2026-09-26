// STEELSEED — render/renderer
// The clustered forward+ renderer. ARCHITECTURE.md §12.2 is the contract; this is it.
//
// Frame graph, in submission order:
//   shadow (N cascades, depth only)
//     -> depth prepass (front-to-back)
//     -> compute: froxel light cull + ambient probe refresh
//     -> forward+ opaque (depth equal, no write)
//     -> TAA resolve
//     -> emissive-key bloom
//     -> compute: metering and exposure adaptation
//     -> AgX tonemap to the swapchain
//
// Reverse-Z everywhere. m4.perspectiveReverseZ gives depth 1 at the near plane and 0 at
// infinity; every depth compare is `greater`, every depth clear is 0.0, and the shadow
// orthos are built with near and far swapped to match. An RTS camera spans hundreds of
// metres and standard [0,1] depth z-fights on far terrain long before it looks wrong up
// close, so this is not an optimisation — it is the only convention that works here.
//
// Hard rule 6 shapes almost every data structure below. There is one instance staging
// array, one key array, one scratch array, and they are sized in init(). Nothing in the
// frame path constructs anything; the single unavoidable exception is
// `getCurrentTexture().createView()`, which WebGPU requires per frame by design.

import {
	type Ctx,
	m4,
	type Mat4,
	mat4,
	PlayerFlag,
	type Snapshot,
	v3,
	type Vec3,
	vec3,
} from '../core'
import type { RenderQuality } from '../core/config'
import { packDamageOpacity } from './instance-appearance'
import { ClusterGrid, CLUSTER_FAR } from './clusters'
import { Atmosphere } from './atmosphere'
import {
	F_CAMERA,
	F_CASCADE_SPLITS,
	F_CASCADE_TEXEL,
	F_CASCADE_VP,
	F_CLUSTER_DIMS,
	F_CLUSTER_EXTRA,
	F_CLUSTER_Z,
	F_AERIAL_COLOR,
	F_EDGE,
	F_CLOUD,
	F_CLOUD_DRIFT,
	F_GROUND_RADIANCE,
	F_HORIZON_COLOR,
	F_INV_VIEWPROJ,
	F_JITTER,
	F_MOON_COLOR,
	F_MOON_DIR,
	F_PARAMS,
	F_WEATHER,
	F_SURFACE_WEATHER,
	F_POST,
	F_PREV_VIEWPROJ,
	F_PROBE_DIMS,
	F_PROBE_ORIGIN,
	F_PROJ,
	F_SCREEN,
	F_SHROUD,
	F_SKY_COLOR,
	F_SKY_SEED,
	F_SUN_COLOR,
	F_SUN_DIR,
	F_VIEW,
	F_VIEWPROJ,
	FRAME_BYTES,
	FRAME_FLOATS,
	JITTER_COUNT,
	JITTER_TABLE,
	MAX_CASCADES,
	F_DEBUG,
	DebugView,
	DEBUG_VIEW_NAMES,
	type DebugViewName,
} from './frame'
import { MeshStore, STRIDE_SKINNED, STRIDE_STATIC, TERRAIN_STRIDE, vertexLayout, terrainVertexLayout } from './gpumesh'
import { LightPool } from './lights'
import { NightLights } from './nightlights'
import { PostChain } from './post'
import { HEAT_FLOATS, HeatSources } from './heat'
import { contactFeatures } from './contact'
import { reflectionFeatures } from './reflection'
import { PROBE_SPACING, ProbeVolume } from './probes'
import { CascadeShadows } from './shadows'
import { FORWARD_CUTOUT_WGSL, FORWARD_FOLIAGE_WGSL, PREPASS_CUTOUT_WGSL } from './cutout-shaders'
import {
	BLOOM_ENABLED,
	FORWARD_BLEND_WGSL,
	FORWARD_WGSL,
	FORWARD_TRANSLUCENT_WGSL,
	FORWARD_TERRAIN_WGSL,
	PREPASS_TERRAIN_WGSL,
	PREPASS_WGSL,
	SKY_DOME_WGSL,
	specializeForwardWgsl,
} from './shaders'
import { GpuTimer } from './gpu-timer'
import { MAX_SORTABLE, packKey, quantise, sortKeys, unpackIndex } from './sort'
import { COLOR_FORMAT, DEPTH_FORMAT, REFLECTION_FORMAT, RenderTargets, VELOCITY_FORMAT } from './targets'
import type {
	Camera,
	DrawItem,
	GpuFactory,
	GpuMesh,
	GpuMeshHandle,
	GpuMeshLevel,
	MaterialsApi,
	MutableSkyEnvironment,
	RenderApi,
	SkyEnvironment,
} from './types'

type GeoMesh = import('../geo/mesh').Mesh

/** Last presentation pose for one opaque simulation id. Render owns this temporal cache. */
interface MotionHistory {
	readonly model: Float32Array
	bones: Float32Array
	frame: number
}

const NO_BONES = new Float32Array(0)

function itemOpacity(item: DrawItem): number {
	return Math.max(0, Math.min(1, item.opacity ?? 1))
}

/** Pick an uploaded level without assuming terrain's hand-built handles carry a chain. */
function meshLod(mesh: GpuMeshHandle, level: number): GpuMeshLevel {
	const lods = mesh.lods
	return lods?.[Math.min(level, lods.length - 1)] ?? mesh
}

const LOD_LEVELS = 3
const LOD_CULLED = 0xff
/** Physical-pixel sphere radii. A DPR increase therefore preserves screen-space quality. */
const LOD0_MIN_RADIUS_PX = 96
const LOD1_MIN_RADIUS_PX = 32
/**
 * Sticky band around the two thresholds above: per-instance LOD hysteresis. A level,
 * once selected, is held until the projected radius is comfortably PAST the boundary it
 * would have to cross — detail is gained only at >= GAIN x the boundary, lost only below
 * LOSE x it. The two bands overlap ([LOSE x T, GAIN x T)), so no radius, however it
 * wobbles, can alternate between two levels. Without it an actor hovering at 96px or
 * 32px — slow zoom, camera-height easing, edge-of-screen pan — swaps QEM meshes every
 * frame; and one draw item covers every building of a type, so whole districts shimmer
 * in correlation. Same shape as INCLUSION_HYSTERESIS, applied one level down.
 */
const LOD_BOUNDARY_PX = [LOD0_MIN_RADIUS_PX, LOD1_MIN_RADIUS_PX]
const LOD_GAIN_DETAIL = 1.25
const LOD_LOSE_DETAIL = 0.8
/**
 * Squared forms of the comparisons above, for buildInstances's per-instance loop.
 * `radiusPx >= T` is `K*M >= T2*D` with K = localR^2*projScale^2, M the largest squared
 * basis column and D the squared camera distance — the same predicate with no sqrt, no
 * divide and no method call on the hottest path in the frame (the meadow item alone
 * spans thirty thousand instances). Derived, never hand-written, so the bands cannot
 * drift from their linear definitions.
 */
const LOD0_MIN_PX2 = LOD0_MIN_RADIUS_PX * LOD0_MIN_RADIUS_PX
const LOD1_MIN_PX2 = LOD1_MIN_RADIUS_PX * LOD1_MIN_RADIUS_PX
const LOD_GAIN0_PX2 = (LOD_BOUNDARY_PX[0] * LOD_GAIN_DETAIL) * (LOD_BOUNDARY_PX[0] * LOD_GAIN_DETAIL)
const LOD_GAIN1_PX2 = (LOD_BOUNDARY_PX[1] * LOD_GAIN_DETAIL) * (LOD_BOUNDARY_PX[1] * LOD_GAIN_DETAIL)
const LOD_LOSE0_PX2 = (LOD_BOUNDARY_PX[0] * LOD_LOSE_DETAIL) * (LOD_BOUNDARY_PX[0] * LOD_LOSE_DETAIL)
const LOD_LOSE1_PX2 = (LOD_BOUNDARY_PX[1] * LOD_LOSE_DETAIL) * (LOD_BOUNDARY_PX[1] * LOD_LOSE_DETAIL)

/**
 * Inter-frame model-matrix delta (metres of translation, or basis-column units) above
 * which a caster counts as having MOVED. Static actors rewrite their rows bit-identically
 * every frame — same snapshot inputs, same float ops — so anything above this epsilon is
 * real motion: marching infantry, a driving tank, a deploying yard settling onto its pad.
 */
const MODEL_MOVE_EPSILON = 1e-4

/** Instance record: mat4 model, vec4 tint, vec4 misc. */
const INSTANCE_FLOATS = 24
const INSTANCE_BYTES = INSTANCE_FLOATS * 4

/**
 * The three spare scalars in `misc`, PINNED to their owners before three features race for
 * the same slot. Floats 0..15 are the model matrix, 16..19 the player-colour tint, 20 the
 * material layer count; 21..23 were free.
 *
 * They are not free any more, and they are claimed here rather than by whoever gets to them
 * first, because each is wanted by a different node and a collision between two of them would
 * present as one feature silently corrupting another's geometry:
 *
 *   21  paletteOffset  owned by `render` — base index into the bone palette. 0 means the
 *                      instance is unskinned and takes the identity path.
 *   22  phase          owned by `anim` — a periodic scalar for motion that is NOT
 *                      articulation: track scroll as a UV phase, rotor blur. A scrolling
 *                      track is not a bone and must not consume one.
 *   23  appearance     non-negative damage01 for opaque instances (unchanged); negative
 *                      values encode an 8-bit damage band AND fractional opacity. See
 *                      instance-appearance.ts. Fading must never repair a burnt hull.
 *
 * All three are written zero by `writeInstance` and by nothing else until their owning phase
 * lands. A writer outside `writeInstance` is a bug: instance records are packed per frame and
 * a stray write lands on whatever actor happens to occupy that slot this frame.
 */
/**
 * Fixed palette budget: 32768 x 64 B = 2 MiB per GPU buffer (current + previous).
 * The old 1024-matrix ceiling was exhausted by an ordinary Marigold Town start,
 * leaving every death animation undrawn. This covers 800 twenty-bone people plus
 * the bounded 64 x 256-bone remains pool; overflow still degrades without growing.
 *
 * A ceiling rather than a growth policy, because growing a storage buffer means recreating
 * the bind group mid-frame, and rule 9 asks for graceful degradation instead: past this,
 * `anim` poses fewer actors at full fidelity rather than the renderer reallocating.
 */
const MAX_PALETTE_MATRICES = 32768

const INSTANCE_PALETTE_OFFSET = 21
const INSTANCE_PHASE = 22
const INSTANCE_DAMAGE = 23
/** Sort keys carry a 12-bit item index, so this is the hard ceiling on submissions. */
const MAX_ITEMS = MAX_SORTABLE
/** Materials seen in one session. One bind group each, built on first sight. */
/** Sentinel slots for the forward pass's redundant-bind check. Real slots are >= 0. */
const MATERIAL_SLOT_ATLAS = -1
const MATERIAL_SLOT_NONE = -2

const MAX_MATERIAL_SLOTS = 256
/**
 * Importance bonus for an item the previous frame admitted, in `applyBudget`.
 *
 * Small on purpose. It has to exceed the frame-to-frame wobble in screen coverage — a
 * camera nudge moves an item's importance by well under a percent — without letting a
 * far, stale item hold out against something that genuinely matters more.
 */
const INCLUSION_HYSTERESIS = 1.15
/** Depth quantisation for the front-to-back key: 1/16 m up to 65 km. */
const DEPTH_QUANT_SCALE = 16
const DEPTH_QUANT_BITS = 20
/**
 * Clear-day probe fill is deliberately below the weather-driven ambient envelope.
 * `SkyModel.ambientScale` still carries time-of-day and weather response; this constant
 * only calibrates the diffuse probe baseline against the directional sun.
 */
const PROBE_DIFFUSE_SCALE = 0.5

/** Saturated RTS livery. Enemies must not share a hue with the local player. */
const DISTINCT_COLORS = [
	[0.86, 0.16, 0.14],
	[0.16, 0.38, 0.92],
	[0.12, 0.72, 0.28],
	[0.95, 0.78, 0.12],
	[0.92, 0.22, 0.78],
	[0.10, 0.78, 0.86],
	[0.95, 0.48, 0.08],
	[0.58, 0.28, 0.95],
]

function colorDistance(table: Float32Array, a: number, r: number, g: number, b: number): number {
	const dr = table[a] - r, dg = table[a + 1] - g, db = table[a + 2] - b
	return Math.sqrt(dr * dr * 2 + dg * dg + db * db * 2)
}

function chromaOf(r: number, g: number, b: number): number {
	return Math.max(r, g, b) - Math.min(r, g, b)
}

function separatePlayerColors(
	table: Float32Array,
	count: number,
	players: readonly { flags: number }[],
): void {
	if (count < 2) return
	let local = 0
	for (let i = 0; i < count; i++) {
		if ((players[i].flags & PlayerFlag.isRenderPlayer) !== 0) { local = i; break }
	}
	const taken: number[] = [local]
	if (chromaOf(table[local * 4], table[local * 4 + 1], table[local * 4 + 2]) < 0.18) {
		const pick = DISTINCT_COLORS[0]
		table[local * 4] = pick[0]
		table[local * 4 + 1] = pick[1]
		table[local * 4 + 2] = pick[2]
	}
	for (let i = 0; i < count; i++) {
		if (i === local) continue
		const o = i * 4
		let tooClose = chromaOf(table[o], table[o + 1], table[o + 2]) < 0.18
		if (!tooClose) {
			for (const other of taken) {
				if (colorDistance(table, other * 4, table[o], table[o + 1], table[o + 2]) < 0.42) {
					tooClose = true
					break
				}
			}
		}
		if (!tooClose) { taken.push(i); continue }
		let best = DISTINCT_COLORS[0], bestScore = -1
		for (const cand of DISTINCT_COLORS) {
			let nearest = Infinity
			for (const other of taken) {
				const d = colorDistance(table, other * 4, cand[0], cand[1], cand[2])
				if (d < nearest) nearest = d
			}
			if (nearest > bestScore) { bestScore = nearest; best = cand }
		}
		table[o] = best[0]
		table[o + 1] = best[1]
		table[o + 2] = best[2]
		if (table[o + 3] < 0.5) table[o + 3] = 1
		taken.push(i)
	}
}

class CameraState implements Camera {
	readonly view = mat4()
	readonly proj = mat4()
	readonly viewProj = mat4()
	readonly position = vec3()
	/** The ground focus the camera looks at; view-local scattering centres here. */
	readonly focus = vec3()
	nearPlane = 0.1
}

export class Renderer implements RenderApi {
	static readonly id = 'render'
	static readonly deps = ['materials'] as const

	readonly camera = new CameraState()
	/** Authoritative OpenRA lobby RGBA, indexed by the snapshot player table. */
	private readonly playerColorTable = new Float32Array(256 * 4)
	private playerColorCount = 0
	/**
	 * `dropped` and `lightsDropped` are part of the contract (§12.2), not debug extras.
	 * `render` is the node every other node draws through, and those nodes are built in
	 * parallel by agents who cannot read each other's code. A builder who submits with a
	 * surfaceSet id `materials` does not carry previously got a silently black scene and
	 * zero signal — no console line, no counter, nothing readable. That is §8's "a
	 * `default:` branch that silently does nothing is a gate failure" applied to the
	 * submission seam.
	 */
	readonly stats = { drawCalls: 0, triangles: 0, lights: 0, pipelineCreations: 0, dropped: 0, lightsDropped: 0, instancesDropped: 0, heatSources: 0 }
	/** This frame's heat shimmers and their packed uniform (render/heat). */
	private readonly heat = new HeatSources()
	private readonly heatPacked = new Float32Array(HEAT_FLOATS)
	/** Per-pass GPU times, only with `?gputime=1` on a device with timestamp-query; else null. */
	gpuTimer: GpuTimer | null = null

	/**
	 * surfaceSet ids already reported. Warn ONCE per id, not once per frame: an unknown id
	 * recurs every frame for every instance, and a per-frame warning would bury the signal
	 * in its own noise and tank the frame rate while doing it. Grows only on first sight,
	 * so it is not a per-frame allocation (rule 6).
	 */
	private readonly warnedSets = new Set<string>()

	/**
	 * True when the backend is not WebGPU. The node then boots, accepts every call and
	 * draws nothing, instead of taking the whole application down (rule 8). Public so `ui`
	 * can tell the player why the battlefield is empty rather than leaving them guessing.
	 */
	unsupported = false

	/**
	 * §5.6 debug view. 0 is off and is the only value that costs nothing; every other
	 * value replaces the shaded result in the forward pass with the named quantity.
	 *
	 * Set it as a number (`DebugView.normal`) or by name via `setDebugView('normal')`.
	 * Changing it does NOT create a pipeline — it is a uniform, so rule 10 holds and
	 * `dbgview.mjs` can sweep every mode inside one frame budget.
	 */
	debugView: number = DebugView.off

	/** Select a debug view by name. Returns false for an unknown name rather than throwing. */
	setDebugView(name: DebugViewName | 'off'): boolean {
		const v = DebugView[name as DebugViewName]
		if (v === undefined) return false
		this.debugView = v
		return true
	}

	/** Every selectable view, for tools that enumerate rather than hardcode. */
	get debugViewNames(): readonly string[] {
		return DEBUG_VIEW_NAMES
	}

	/** Generated geometry only; materials report their separate atlas allocation. */
	get geometryVramBytes(): number {
		return this.meshes?.uploadedBytes ?? 0
	}

	// ---------------------------------------------------------------------------
	// Preallocated pass descriptors — rule 6.
	//
	// WebGPU's encode API takes descriptor OBJECTS, so the naive spelling allocates a fresh
	// object (often several, nested) at every call site, every frame: ~25-30 per frame at
	// the high preset once the four cascades are counted. These are built once and mutated
	// in place; only views and the clear colour ever change.
	//
	// rulecheck cannot catch this class: its rule-6 heuristic scans the literal body of
	// update/lateUpdate/onSnapshot and stops at the closing brace, and every one of these
	// lives in a private helper one or two calls deeper. The header of this file used to
	// claim the frame path constructed nothing, which was simply false.
	// ---------------------------------------------------------------------------
	private readonly frameEncoderDesc: GPUCommandEncoderDescriptor = { label: 'render.frame' }
	private readonly exposurePassDesc: GPUComputePassDescriptor = { label: 'render.pass.exposure' }
	private readonly cullPassDesc: GPUComputePassDescriptor = { label: 'render.pass.cull' }
	/** One-element submit array, refilled each frame instead of `submit([...])`. */
	private readonly submitScratch: GPUCommandBuffer[] = new Array(1)
	/** One-element dynamic-offset array for the per-cascade shadow bind group. */
	private readonly dynOffset: number[] = new Array(1)
	/** One per cascade (§7 caps at 4) so the per-cascade debug label survives. */
	private readonly shadowPassDescs: GPURenderPassDescriptor[] = Array.from({ length: MAX_CASCADES }, (_, c) => ({
		label: `render.pass.shadow${c}`,
		colorAttachments: [],
		depthStencilAttachment: {
			view: undefined as unknown as GPUTextureView,
			// Reverse-Z: 0 is the far plane, so that is the clear.
			depthClearValue: 0,
			depthLoadOp: 'clear' as const,
			depthStoreOp: 'store' as const,
		},
	}))
	private readonly prepassVelocityAttachment: GPURenderPassColorAttachment = {
			view: undefined as unknown as GPUTextureView,
			loadOp: 'clear',
			storeOp: 'store',
			// Translucent effects do not write the prepass. A value outside the legal
			// UV displacement range tells TAA to use this frame's pixels there.
			clearValue: { r: 2, g: 2, b: 0, a: 0 },
	}
	private readonly prepassDesc: GPURenderPassDescriptor = {
		label: 'render.pass.prepass',
		colorAttachments: [this.prepassVelocityAttachment, {
			view: undefined as unknown as GPUTextureView,
			loadOp: 'clear', storeOp: 'store', clearValue: { r: .5, g: .5, b: 1, a: 0 },
		}],
		depthStencilAttachment: {
			view: undefined as unknown as GPUTextureView,
			depthClearValue: 0,
			depthLoadOp: 'clear',
			depthStoreOp: 'store',
		},
	}
	private readonly forwardColorAttachment: GPURenderPassColorAttachment = {
		view: undefined as unknown as GPUTextureView,
		loadOp: 'clear',
		storeOp: 'store',
		clearValue: { r: 0, g: 0, b: 0, a: BLOOM_ENABLED ? 0 : 1 },
	}
	private readonly forwardDesc: GPURenderPassDescriptor = {
		label: 'render.pass.forward',
		colorAttachments: [this.forwardColorAttachment],
		depthStencilAttachment: {
			view: undefined as unknown as GPUTextureView,
			// Terrain depth comes from the prepass. Skinned draws write their own depth
			// here, so the attachment cannot be read-only. The sky pipeline still writes none.
			depthLoadOp: 'load',
			depthStoreOp: 'store',
		},
	}

	get colorFormat(): GPUTextureFormat {
		return COLOR_FORMAT
	}

	get depthFormat(): GPUTextureFormat {
		return DEPTH_FORMAT
	}

	// --- device-level ---
	private device!: GPUDevice
	private context!: GPUCanvasContext
	private canvas!: HTMLCanvasElement
	private swapFormat: GPUTextureFormat = 'bgra8unorm'
	private factory!: GpuFactory
	private disposed = false

	// --- subsystems of this node ---
	private meshes!: MeshStore
	private targets!: RenderTargets
	private clusters!: ClusterGrid
	private shadows!: CascadeShadows
	private probes!: ProbeVolume
	private postChain!: PostChain
	private atmosphere!: Atmosphere
	get atmosphereStats() { return this.atmosphere?.stats }
	private lights!: LightPool
	/**
	 * The authored night lamps. Owned here rather than in `units` because the budget and
	 * the final camera both live here; see the header of render/nightlights.ts.
	 */
	private readonly nightLights = new NightLights()
	get nightLightStats() { return this.nightLights.stats }
	/** Boot-time lamp inventory. Diagnostic; allocates, so tools only. */
	nightLightSummary() { return this.nightLights.summary() }

	// --- bind groups and pipelines ---
	private frameLayout!: GPUBindGroupLayout
	private frameBindGroup: GPUBindGroup | null = null
	private drawLayout!: GPUBindGroupLayout
	private drawBindGroup!: GPUBindGroup
	private materialLayout!: GPUBindGroupLayout
	private ownsMaterialLayout = false
	private prepassStatic!: GPURenderPipeline
	private prepassTerrain!: GPURenderPipeline
	private prepassSkinned!: GPURenderPipeline
	private prepassCutoutStatic!: GPURenderPipeline
	private prepassCutoutSkinned!: GPURenderPipeline
	private prepassReactive!: GPURenderPipeline
	private forwardCutoutStatic!: GPURenderPipeline
	private forwardCutoutSkinned!: GPURenderPipeline
	private forwardStatic!: GPURenderPipeline
	private forwardSkinned!: GPURenderPipeline
	/** Placement ghosts: depth-tested after opaque + sky, premultiplied alpha, no depth write. */
	private forwardTranslucentStatic!: GPURenderPipeline
	private forwardTranslucentSkinned!: GPURenderPipeline
	/** §12.3b ground: same layout, two atlas layers height-blended. Null without an atlas. */
	private forwardBlend: GPURenderPipeline | null = null
	/** The atlas group, bound in place of a per-set group for blended items. */
	private atlasBindGroup: GPUBindGroup | null = null
	/** Non-blend terrain (water, never-blended ground): float32 TERRAIN layout, unquantized module. */
	private forwardTerrainOpaque!: GPURenderPipeline
	private skyDome!: GPURenderPipeline
	private shadowSampler!: GPUSampler
	private linearSampler!: GPUSampler
	/** §4.7 visibility. Always valid: init seeds a 1x1 VISIBLE fail-open texture. */
	private shroudTexture!: GPUTexture
	private shroudView!: GPUTextureView
	private shroudPixels = new Uint8Array(1)
	private shroudWidth = 1
	private shroudHeight = 1
	/** Atlas layer per terrain cell for the per-pixel ground blend. 1x1 and off until terrain sets it. */
	private cellLayerTexture!: GPUTexture
	private cellLayerView!: GPUTextureView
	private cellLayerWidth = 1
	private cellLayerHeight = 1
	private cellLayerOriginX = 0
	private cellLayerOriginY = 0
	private cellLayersReady = false
	private shroudOriginX = 0
	private shroudOriginY = 0
	/**
	 * Depth of the scenery ring outside the playable rectangle, in render metres.
	 *
	 * Zero until terrain calls `setApron` with the ring it actually built. Distant mountains
	 * are a separate opt-in switch, so deriving an edge from the quality preset would briefly
	 * imply scenery that does not exist and would be a second spelling of one contract.
	 */
	private apronDepthM = 0
	/** 1 = Classic (yesterday High extras off). Written into frame.debug.y. */
	private configClassicLook = 0
	private renderQuality!: RenderQuality
	/** Live 60 fps shed. Full preset until `setLoadShed`. debug.z skips contact when set. */
	private liveCascades = 1
	private contactSuppressed = false
	private sceneryStep = 1
	/** First uploaded mesh of each vertex stride, drawn once at prewarm so Metal compiles it before play. */
	private readonly warmMesh = new Map<number, GpuMeshHandle>()
	private terrainWarm: { vertexBuffer: GPUBuffer; indexBuffer: GPUBuffer; indexFormat: GPUIndexFormat; indexCount: number } | null = null

	// --- frame uniform ---
	private frameUniform!: GPUBuffer
	private frameFloats = new Float32Array(FRAME_FLOATS)
	private frameU32 = new Uint32Array(this.frameFloats.buffer)
	private readonly jitteredProj = mat4()
	private readonly jitteredViewProj = mat4()
	private readonly invViewProj = mat4()
	private readonly prevViewProj = mat4()

	// --- instances ---
	private instanceBuffer!: GPUBuffer
	private previousInstanceBuffer!: GPUBuffer
	/**
	 * The bone palette: every skinned actor's world matrices, packed end to end for the frame.
	 *
	 * One buffer for the whole frame rather than one per actor, because a bind group change
	 * per actor would undo the flat ~255 draw calls §11.4 measures across a 33x actor range.
	 * An instance names its own first bone through instance float 21, so 800 skinned actors
	 * are still one binding and one draw per bucket.
	 */
	private boneBuffer!: GPUBuffer
	private previousBoneBuffer!: GPUBuffer
	private boneData!: Float32Array
	private previousBoneData!: Float32Array
	/** Matrices written this frame. Reset per frame; `anim` fills it through writeBones. */
	private boneCount = 0
	private completedBoneCount = 0
	private instanceData!: Float32Array
	private previousInstanceData!: Float32Array
	private maxInstances = 0
	private instanceCount = 0
	private mainLodBySource = new Uint8Array(0)
	private shadowLodBySource = new Uint8Array(0)
	/** Bit c set when skinned source instance i casts into cascade c. */
	private shadowCascadeMaskBySource = new Uint8Array(0)
	/** Opaque actor-id -> last frame's submitted transform and skin pose. */
	private readonly motionHistory = new Map<number, MotionHistory>()
	private readonly mainLodCountScratch = new Uint32Array(LOD_LEVELS)
	private readonly shadowLodCountScratch = new Uint32Array(LOD_LEVELS)
	private readonly mainLodWriteScratch = new Uint32Array(LOD_LEVELS)
	private readonly shadowLodWriteScratch = new Uint32Array(LOD_LEVELS)
	/** Per-LOD, per-cascade caster counts while one skinned item is packed. */
	private readonly shadowCascadeCountScratch = new Uint32Array(LOD_LEVELS * 4)
	private readonly shadowCascadeWriteScratch = new Uint32Array(LOD_LEVELS * 4)

	// --- per-frame submission state, all preallocated ---
	private readonly items: (DrawItem | null)[] = new Array(MAX_ITEMS).fill(null)
	private itemCount = 0
	private droppedItems = 0
	/** One console warning per session when the shared instance buffer overflows. */
	private warnedInstanceOverflow = false
	private readonly itemMatSlot = new Int32Array(MAX_ITEMS)
	private readonly itemMainBase = new Int32Array(MAX_ITEMS * LOD_LEVELS)
	private readonly itemMainCount = new Int32Array(MAX_ITEMS * LOD_LEVELS)
	private readonly itemShadowBase = new Int32Array(MAX_ITEMS * LOD_LEVELS)
	private readonly itemShadowCount = new Int32Array(MAX_ITEMS * LOD_LEVELS)
	/** Skinned casters only: one instance range per cascade, not one range drawn four times. */
	private readonly itemShadowCascadeBase = new Int32Array(MAX_ITEMS * LOD_LEVELS * 4)
	private readonly itemShadowCascadeCount = new Int32Array(MAX_ITEMS * LOD_LEVELS * 4)
	/**
	 * World AABB of an item's reach-admitted shadow casters, minX..maxZ. A cascade skips
	 * an item whose casters all clip outside it. Skinned casters are packed per cascade
	 * from view depth, so a soldier is not skinned into every map. Conservative by
	 * construction: the box covers every admitted caster, including any a budget-shrunken
	 * count later dropped.
	 */
	private readonly itemShadowBounds = new Float32Array(MAX_ITEMS * 6)
	/** Clip planes (a,b,c,d) x6 for each of the four possible cascades. */
	private readonly shadowCascadePlanes = new Float32Array(4 * 24)
	private readonly itemDepth = new Float32Array(MAX_ITEMS)
	private readonly itemImportance = new Float32Array(MAX_ITEMS)
	private readonly itemIncluded = new Uint8Array(MAX_ITEMS)
	/**
	 * Frame index at which each DrawItem was last admitted, for `applyBudget`'s hysteresis.
	 * Weak because the key is the submitting node's own reused object: a node that stops
	 * submitting, or is disposed, must not be kept alive by the renderer's memory of it.
	 */
	private readonly lastIncluded = new WeakMap<DrawItem, number>()
	/**
	 * Last selected main-LOD level per source instance, for selectMainLod's hysteresis.
	 * Weak for the same reason as lastIncluded: the key is the submitting node's own
	 * reused object. Indexed like item.instances; a node that compacts its array shifts
	 * the memory with it, which can hold a shifted instance one band off until its radius
	 * leaves the band — but can never make it oscillate. Grown only when the live count
	 * exceeds it, so the frame loop allocates nothing in steady state.
	 */
	private readonly heldMainLod = new WeakMap<DrawItem, Uint8Array>()
	private readonly keys = new Float64Array(MAX_ITEMS)
	private readonly keyScratch = new Float64Array(MAX_ITEMS)
	private readonly orderPrepass = new Int32Array(MAX_ITEMS)
	private readonly orderMain = new Int32Array(MAX_ITEMS)
	private readonly orderTranslucent = new Int32Array(MAX_ITEMS)
	private readonly orderShadow = new Int32Array(MAX_ITEMS)
	private prepassCount = 0
	private mainCount = 0
	private translucentCount = 0
	private shadowCount = 0
	/** Per-frame numeric LOD evidence, restricted to handles that actually carry a chain. */
	readonly lodStats = {
		mainInstances: new Uint32Array(LOD_LEVELS),
		shadowInstances: new Uint32Array(LOD_LEVELS),
	}
	/** Test seam only: depthgate sets one to prove unequal prepass/forward LOD turns red. */
	depthgateForwardLodBias = 0
	/** Test seam only: motiongate defeats object motion while preserving camera reprojection. */
	motiongateZeroObjectVelocity = false

	// --- material bind group cache ---
	private readonly materialSlots = new Map<string, number>()
	private readonly materialBindGroups: (GPUBindGroup | null)[] = new Array(MAX_MATERIAL_SLOTS).fill(null)
	private readonly materialLayerCount = new Int32Array(MAX_MATERIAL_SLOTS)
	private materialSlotCount = 0
	private materials: MaterialsApi | null = null

	// --- lighting environment, PUSHED by `sky` (§12.2) ---
	//
	// Held as one mutable struct rather than as loose fields so `environment` can hand it
	// out without copying. Every consumer reads the same object, which is the point: a
	// second node that derives its own sun from §4.2 is a second clock, and two clocks
	// disagree silently. Terrain used to do exactly that.
	private readonly env: MutableSkyEnvironment = {
		sunDir: vec3(0.35, 0.82, 0.45),
		sunColor: vec3(1, 0.94, 0.85),
		sunIntensity: 4.2,
		skyColor: vec3(0.18, 0.28, 0.44),
		groundAlbedo: 0.22,
		ambientScale: 1,
		horizonColor: vec3(0.26, 0.41, 0.64),
		groundRadiance: vec3(0.04, 0.062, 0.097),
		moonDir: vec3(0, 1, 0),
		moonColor: vec3(0.42, 0.52, 0.72),
		moonIntensity: 0,
		aerialColor: vec3(0.26, 0.41, 0.64),
		aerialDensity: 0.0015,
		cloudCoverage: 0.16,
		cloudOpacity: 0.16,
		cloudScale: 0.0035,
		cloudOffsetX: 0,
		cloudOffsetZ: 0,
		cloudSeed: 0,
		lightning: 0,
	}
	// --- scratch for the cull loop ---
	private readonly planes = new Float32Array(5 * 4)

	private frameIndex = 0
	private historyValid = false
	private budgetDrawCalls = 0
	private budgetTriangles = 0

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	async init(ctx: Ctx): Promise<void> {
		if (ctx.backend === 'webgl2') {
			// LOUD, but not fatal.
			//
			// This node is the WebGPU clustered forward+ path; there is no WebGL2 renderer
			// (WebGPU is required, ARCHITECTURE.md §13). Throwing here would take the entire
			// boot down: registry.init has no try/catch, so App.boot would reject and main()
			// land in bootFailed, with no HUD, no menu and no way to change the quality preset
			// that selected this backend. That breaks rule 8 outright, and it makes core's own claims false —
			// core/config.ts clamps quality to `low` for WebGL2 and §7's budget column is
			// literally headed "low (WebGL2)".
			//
			// So: disable this node, report it unmistakably, and let everything else boot.
			// The sibling node already made this call — materials/index.ts degrades and logs,
			// citing rule 8 by name. Rule 9 says degrade gracefully; it does not say die.
			//
			// It is still not silent: an error in the console, and `unsupported` is readable
			// by `ui` so it can say so on screen rather than showing an empty battlefield.
			this.unsupported = true
			console.error(
				'[render] WebGPU is unavailable and the backend selected WebGL2. The 3D renderer is DISABLED — ' +
					'the world will not draw. This node is the WebGPU clustered forward+ path; the WebGL2 renderer ' +
					'is not implemented (WebGPU is required). Everything else boots normally.',
			)
			return
		}
		const device = ctx.device
		if (!device) throw new Error('render: ctx.backend is "webgpu" but ctx.device is null')

		this.device = device
		this.canvas = ctx.canvas
		if (ctx.config.gpuTiming && device.features.has('timestamp-query')) this.gpuTimer = new GpuTimer(device)
		const context = ctx.canvas.getContext('webgpu') as GPUCanvasContext | null
		if (!context) throw new Error('render: canvas.getContext("webgpu") returned null — the canvas already has another context')
		this.context = context

		const gpu = (navigator as Navigator & { gpu?: GPU }).gpu
		this.swapFormat = gpu ? gpu.getPreferredCanvasFormat() : 'bgra8unorm'
		this.context.configure({ device, format: this.swapFormat, alphaMode: 'opaque' })

		// Every pipeline in this node goes through here, so stats.pipelineCreations is a
		// measurement rather than a claim (rule 10).
		this.factory = {
			device,
			renderPipeline: (desc) => {
				this.stats.pipelineCreations++
				return device.createRenderPipeline(desc)
			},
			computePipeline: (desc) => {
				this.stats.pipelineCreations++
				return device.createComputePipeline(desc)
			},
		}

		const q = ctx.config.q
		this.renderQuality = q.render
		this.configClassicLook = q.classicLook ? 1 : 0
		this.apronDepthM = 0
		this.budgetDrawCalls = q.drawCalls
		this.budgetTriangles = q.triangles
		this.maxInstances = q.drawCalls >= 2500 ? 65536 : q.drawCalls >= 1500 ? 32768 : 16384
		this.instanceData = new Float32Array(this.maxInstances * INSTANCE_FLOATS)
		this.previousInstanceData = new Float32Array(this.maxInstances * INSTANCE_FLOATS)
		this.mainLodBySource = new Uint8Array(this.maxInstances)
		this.shadowLodBySource = new Uint8Array(this.maxInstances)
		this.shadowCascadeMaskBySource = new Uint8Array(this.maxInstances)

		this.meshes = new MeshStore(device)
		this.targets = new RenderTargets(device)
		this.lights = new LightPool(device, q.dynamicLights)

		this.frameUniform = device.createBuffer({
			label: 'render.frame',
			size: FRAME_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		})
		this.instanceBuffer = device.createBuffer({
			label: 'render.instances',
			size: this.maxInstances * INSTANCE_BYTES,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		})
		this.previousInstanceBuffer = device.createBuffer({
			label: 'render.instances.previous',
			size: this.maxInstances * INSTANCE_BYTES,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		})
		// Sized against MAX_PALETTE_MATRICES rather than against the instance cap: a rigged
		// actor contributes bones, an unrigged one contributes none, and most of the roster is
		// unrigged. 16 KiB of matrices covers 1024 bones, which at a typical 20-bone vehicle
		// rig is 51 actors posed at full fidelity in one frame — beyond that `anim`'s pose
		// budget drops distant actors to their chassis bone, which is the LOD of animation.
		this.boneData = new Float32Array(MAX_PALETTE_MATRICES * 16)
		this.previousBoneData = new Float32Array(MAX_PALETTE_MATRICES * 16)
		// Bone 0 is the identity and is never addressed: paletteBase 0 MEANS unskinned, so the
		// slot exists only to make that sentinel unambiguous and keep index 0 from being a
		// real bone that someone later reads by accident.
		this.boneData[0] = 1; this.boneData[5] = 1; this.boneData[10] = 1; this.boneData[15] = 1
		this.previousBoneData[0] = 1; this.previousBoneData[5] = 1
		this.previousBoneData[10] = 1; this.previousBoneData[15] = 1
		this.boneCount = 1
		this.boneBuffer = device.createBuffer({
			label: 'render.bones',
			size: MAX_PALETTE_MATRICES * 64,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		})
		this.previousBoneBuffer = device.createBuffer({
			label: 'render.bones.previous',
			size: MAX_PALETTE_MATRICES * 64,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		})

		this.shadowSampler = device.createSampler({
			label: 'render.shadow.sampler',
			// Reverse-Z: a fragment nearer the light has the LARGER depth, so the test
			// passes when the reference is greater than or equal to what was stored.
			compare: 'greater-equal',
			magFilter: 'linear',
			minFilter: 'linear',
			addressModeU: 'clamp-to-edge',
			addressModeV: 'clamp-to-edge',
		})
		this.linearSampler = device.createSampler({
			label: 'render.linear.sampler',
			magFilter: 'linear',
			minFilter: 'linear',
			addressModeU: 'clamp-to-edge',
			addressModeV: 'clamp-to-edge',
		})
		this.shroudPixels[0] = 255
		this.shroudTexture = this.createShroudTexture(1, 1)
		this.shroudView = this.shroudTexture.createView()
		this.device.queue.writeTexture(
			{ texture: this.shroudTexture },
			this.shroudPixels,
			{ bytesPerRow: 1, rowsPerImage: 1 },
			{ width: 1, height: 1, depthOrArrayLayers: 1 },
		)
		// Bound from frame 1 so every pipeline's layout is satisfied; the ground blend ignores
		// it (frame.edge.w = 0) until terrain publishes the real map.
		this.cellLayerTexture = this.createCellLayerTexture(1, 1)
		this.cellLayerView = this.cellLayerTexture.createView()
		this.cellLayerWidth = 1
		this.cellLayerHeight = 1
		this.cellLayersReady = false

		this.resolveMaterials(ctx)
		this.buildLayouts()

		this.clusters = new ClusterGrid(this.factory, q.dynamicLights)
		this.shadows = new CascadeShadows(this.factory, this.drawLayout, q.shadowCascades, this.materialLayout, q.render)
		this.liveCascades = this.shadows.cascadeCount
		this.probes = new ProbeVolume(this.factory, q.probeUpdatesPerFrame)
		// Post features follow the preset. Screen-space contact is off in every tier
		// until its jittered depth taps are stable; URL flags keep the review path.
		const contact = contactFeatures(q.contactShading)
		const reflections = reflectionFeatures(q.screenReflections)
		this.postChain = new PostChain(this.factory, this.swapFormat, {
			contact: contact.enabled,
			contactDebug: contact.debug,
			reflections: reflections.enabled,
			reflectionsDebug: reflections.debug,
			reflectionsMask: reflections.mask,
		}, q.render)
		console.info(`[quality] ${q.name}: contact shading ${contact.enabled ? 'on' : 'off'}, screen reflections ${reflections.enabled ? 'on' : 'off'}, ${q.shadowCascades} shadow cascades, render scale ${q.internalScale}${q.classicLook ? ', classic look' : ''}`)

		const particleLimit = Math.min(q.particles, 4096)
		// The decorative shroud volume formed a faceted lid at RTS camera angles.
		// Keep depth-soft particles here; atmospheric extinction belongs to the
		// height-integrated forward shader and visibility remains owned by shroud.
		// The Ultra VFX tiers (fx/vfx-budget) draw the irregular, sun-lit puff; every other preset
		// keeps the shipped round one.
		this.atmosphere = new Atmosphere(this.factory, particleLimit, false, q.name === 'ultra' || q.name === 'ultra-max')
		this.nightLights.configure(q.dynamicLights, particleLimit, q.name)
		this.buildScenePipelines()
		this.probes.build(this.frameUniform, this.shadows.arrayView, this.shadowSampler)

		// Seed a mid-afternoon daylight environment so a build with no `sky` node still
		// boots lit rather than black (rule 8). `sky` overwrites this on its first update;
		// until then this is the entire lighting environment, and it is the only place
		// render is permitted to author one.
		this.seedDefaultEnvironment(14 * 60)
		this.allocateSizedResources(this.canvas.width, this.canvas.height)
	}

	/**
	 * The materials node owns the group-1 layout. When it is absent — which `deps` should
	 * prevent, but a tool harness can register a partial graph — this node builds an
	 * equivalent layout and a neutral 1x1 set so the renderer still produces a frame
	 * instead of taking the boot down (rule 8).
	 */
	private resolveMaterials(ctx: Ctx): void {
		const mats = ctx.peek<MaterialsApi>('materials')
		if (mats && mats.bindGroupLayout) {
			this.materials = mats
			this.materialLayout = mats.bindGroupLayout
			this.ownsMaterialLayout = false
			return
		}
		this.materials = null
		this.ownsMaterialLayout = true
		this.materialLayout = this.device.createBindGroupLayout({
			label: 'render.material.fallback.layout',
			entries: [
				{ binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
				{ binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
				{ binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
				{ binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
				{ binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
				{ binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
			],
		})
		this.materialBindGroups[0] = this.buildFallbackMaterialGroup()
		this.materialLayerCount[0] = 1
		this.materialSlotCount = 1
	}

	private buildFallbackMaterialGroup(): GPUBindGroup {
		const make = (label: string, r: number, g: number, b: number, a: number, dimension: GPUTextureViewDimension = '2d-array'): GPUTextureView => {
			const tex = this.device.createTexture({
				label,
				size: { width: 1, height: 1, depthOrArrayLayers: 1 },
				format: 'rgba8unorm',
				usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
			})
			this.device.queue.writeTexture(
				{ texture: tex },
				Uint8Array.of(r, g, b, a),
				{ bytesPerRow: 4 },
				{ width: 1, height: 1, depthOrArrayLayers: 1 },
			)
			this.fallbackTextures.push(tex)
			return tex.createView({ dimension })
		}
		return this.device.createBindGroup({
			label: 'render.material.fallback',
			layout: this.materialLayout,
			entries: [
				{ binding: 0, resource: this.linearSampler },
				{ binding: 1, resource: make('render.fallback.albedo', 140, 140, 145, 255) },
				// Octahedral (0.5, 0.5) decodes to +Z, i.e. flat in tangent space.
				{ binding: 2, resource: make('render.fallback.normal', 128, 128, 0, 255) },
				{ binding: 3, resource: make('render.fallback.orm', 200, 0, 255, 0) },
				{ binding: 4, resource: make('render.fallback.mask', 0, 0, 0, 255) },
				{ binding: 6, resource: make('render.fallback.detail', 255, 0, 0, 0, '2d') },
			],
		})
	}

	private readonly fallbackTextures: GPUTexture[] = []

	private buildLayouts(): void {
		this.frameLayout = this.device.createBindGroupLayout({
			label: 'render.frame.layout',
			entries: [
				{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
				{ binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
				{ binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
				{ binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
				{ binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
				{ binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
				{ binding: 6, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
				{ binding: 7, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
				{ binding: 8, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
				{ binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
				{ binding: 10, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'uint' } },
			],
		})
		// Binding 1 is the bone palette, and it is on the SHARED draw layout deliberately.
		//
		// The prepass, the shadow cascades and the forward pass all skin, and all three have to
		// read the same matrices or a skinned actor's depth, its shadow and its shading
		// disagree about where it is. One layout means one binding to keep in step instead of
		// three, and it means an unskinned pipeline still has the binding present — which costs
		// nothing, because `skinPosition` returns early on paletteBase 0 and every actor without
		// a rig passes 0.
		this.drawLayout = this.device.createBindGroupLayout({
			label: 'render.draw.layout',
			entries: [
				{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
				{ binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
				{ binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
				{ binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
			],
		})
		this.drawBindGroup = this.device.createBindGroup({
			label: 'render.draw.bindgroup',
			layout: this.drawLayout,
			entries: [
				{ binding: 0, resource: { buffer: this.instanceBuffer } },
				{ binding: 1, resource: { buffer: this.boneBuffer } },
				{ binding: 2, resource: { buffer: this.previousInstanceBuffer } },
				{ binding: 3, resource: { buffer: this.previousBoneBuffer } },
			],
		})
	}

	private buildScenePipelines(): void {
		const prepassModule = this.device.createShaderModule({ label: 'render.prepass', code: PREPASS_WGSL })
		const prepassLayout = this.device.createPipelineLayout({
			label: 'render.prepass.layout',
			bindGroupLayouts: [this.frameLayout, this.drawLayout],
		})
		const prepassOf = (stride: number, name: string, module = prepassModule, layout = prepassLayout, buffers: GPUVertexBufferLayout[] = [vertexLayout(stride)]): GPURenderPipeline =>
			this.factory.renderPipeline({
				label: `render.prepass.${name}`,
				layout,
				vertex: {
					module,
					// Normals and surface ids share this pass with velocity. Both variants
					// retain the exact @invariant position/skin expressions used by forward.
					entryPoint: stride === STRIDE_SKINNED ? 'vsSkinned' : 'vsMain',
					buffers,
				},
				fragment: {
					module,
					entryPoint: 'fsVelocity',
					targets: [{ format: VELOCITY_FORMAT }, { format: REFLECTION_FORMAT }],
				},
				primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
				depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'greater' },
			})
		this.prepassStatic = prepassOf(STRIDE_STATIC, 'static')
		this.prepassSkinned = prepassOf(STRIDE_SKINNED, 'skinned')
		this.prepassTerrain = prepassOf(TERRAIN_STRIDE, 'terrain',
			this.device.createShaderModule({ label: 'render.prepass.terrain', code: PREPASS_TERRAIN_WGSL }), prepassLayout, [terrainVertexLayout()])
		const cutoutPrepass = this.device.createShaderModule({ label: 'render.prepass.cutout', code: PREPASS_CUTOUT_WGSL })
		const cutoutPrepassLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.frameLayout, this.drawLayout, this.materialLayout] })
		this.prepassCutoutStatic = prepassOf(STRIDE_STATIC, 'cutout.static', cutoutPrepass, cutoutPrepassLayout)
		this.prepassCutoutSkinned = prepassOf(STRIDE_SKINNED, 'cutout.skinned', cutoutPrepass, cutoutPrepassLayout)
		// Rain and snow (RenderItem.reactive): depth-tested, never written, and only the velocity
		// marker; the reflection target is masked off. See fsReactive.
		this.prepassReactive = this.factory.renderPipeline({
			label: 'render.prepass.reactive',
			layout: prepassLayout,
			vertex: { module: prepassModule, entryPoint: 'vsMain', buffers: [vertexLayout(STRIDE_STATIC)] },
			fragment: {
				module: prepassModule,
				entryPoint: 'fsReactive',
				targets: [
					{ format: VELOCITY_FORMAT, writeMask: GPUColorWrite.RED | GPUColorWrite.GREEN },
					{ format: REFLECTION_FORMAT, writeMask: 0 },
				],
			},
			primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
			depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'greater' },
		})
		const forwardLayout = this.device.createPipelineLayout({
			label: 'render.forward.layout',
			bindGroupLayouts: [this.frameLayout, this.materialLayout, this.drawLayout],
		})
		const qualityCode = (source: string): string => specializeForwardWgsl(source, this.renderQuality)
		const forwardModule = this.device.createShaderModule({ label: 'render.forward', code: qualityCode(FORWARD_WGSL) })
		const forwardOf = (stride: number, name: string, module = forwardModule, buffers?: GPUVertexBufferLayout[], depthWrite = false): GPURenderPipeline =>
			this.factory.renderPipeline({
				label: `render.forward.${name}`,
				layout: forwardLayout,
				vertex: {
					module,
					entryPoint: stride === STRIDE_SKINNED ? 'vsSkinned' : 'vsMain',
					buffers: buffers ?? [vertexLayout(stride)],
				},
				fragment: { module, entryPoint: 'fsMain', targets: [{ format: COLOR_FORMAT }] },
				primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
				depthStencil: {
					format: DEPTH_FORMAT,
					// The prepass owns depth and velocity for static and skinned geometry.
					// `greater-equal` rather than `equal`
					// because the two passes run different shader modules and float
					// invariance across modules is not guaranteed by the spec.
					depthWriteEnabled: depthWrite,
					depthCompare: 'greater-equal',
				},
			})
		this.forwardStatic = forwardOf(STRIDE_STATIC, 'static')
		this.forwardSkinned = forwardOf(STRIDE_SKINNED, 'skinned')
		const cutoutForward = this.device.createShaderModule({ label: 'render.forward.cutout', code: qualityCode(FORWARD_CUTOUT_WGSL) })
		this.forwardCutoutStatic = forwardOf(STRIDE_STATIC, 'cutout.static', cutoutForward)
		this.forwardCutoutSkinned = forwardOf(STRIDE_SKINNED, 'cutout.skinned', cutoutForward)

		const translucentModule = this.device.createShaderModule({
			label: 'render.forward.translucent',
			code: qualityCode(FORWARD_TRANSLUCENT_WGSL),
		})
		const translucentOf = (stride: number, name: string, module = translucentModule, buffers = [vertexLayout(stride)]): GPURenderPipeline =>
			this.factory.renderPipeline({
				label: `render.forward.translucent.${name}`,
				layout: forwardLayout,
				vertex: {
					module,
					entryPoint: stride === STRIDE_SKINNED ? 'vsSkinned' : 'vsMain',
					buffers,
				},
				fragment: {
					module: translucentModule,
					entryPoint: 'fsMain',
					targets: [{
						format: COLOR_FORMAT,
						blend: {
							color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
							alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
						},
						// HDR alpha is the emissive-key AOV. Preserve it while blending RGB.
						writeMask: GPUColorWrite.RED | GPUColorWrite.GREEN | GPUColorWrite.BLUE,
					}],
				},
				primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
				depthStencil: {
					format: DEPTH_FORMAT,
					depthWriteEnabled: false,
					// Reverse-Z: a ghost draws only where it is in front of opaque scene depth.
					depthCompare: 'greater',
				},
			})
		this.forwardTranslucentStatic = translucentOf(STRIDE_STATIC, 'static')
		this.forwardTranslucentSkinned = translucentOf(STRIDE_SKINNED, 'skinned')
		// Built only when materials actually published an atlas. Rule 10 wants every pipeline
		// to exist before frame 1, and rule 8 wants a missing atlas to cost a worse-looking
		// battlefield rather than a failed boot.
		const atlas = this.materials?.terrainAtlas ?? null
		// Non-blend terrain (water, never-blended ground) carries the float32 TERRAIN layout.
		// Routing it down the quantized unit pipelines decoded f32 bytes as snorm8/unorm16:
		// the black chunks and radial spikes that 051a683 reverted. Total dispatch means
		// these pipelines exist before frame 1 even when no atlas shipped (rule 10).
		const terrainForwardModule = this.device.createShaderModule({ label: 'render.forward.terrain', code: qualityCode(FORWARD_TERRAIN_WGSL) })
		this.forwardTerrainOpaque = forwardOf(TERRAIN_STRIDE, 'terrain', terrainForwardModule, [terrainVertexLayout()])
		// Built only when materials actually published an atlas. Rule 10 wants every pipeline
		if (atlas) {
			this.atlasBindGroup = atlas.bindGroup
			const blendModule = this.device.createShaderModule({ label: 'render.forward.blend', code: qualityCode(FORWARD_BLEND_WGSL) })
			this.forwardBlend = this.factory.renderPipeline({
				label: 'render.forward.blend',
				layout: forwardLayout,
				fragment: { module: blendModule, entryPoint: 'fsMain', targets: [{ format: COLOR_FORMAT }] },
				vertex: { module: blendModule, entryPoint: 'vsMain', buffers: [terrainVertexLayout()] },
				depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'greater-equal' },
			})
		}

		// The dome shares the frame layout and binds only binding 0 of it. A WGSL module is
		// allowed to declare a subset of its pipeline layout, so this needs no layout and no
		// bind group of its own — it draws with whatever the forward pass already had set.
		const domeModule = this.device.createShaderModule({ label: 'render.skydome', code: qualityCode(SKY_DOME_WGSL) })
		this.skyDome = this.factory.renderPipeline({
			label: 'render.skydome',
			layout: this.device.createPipelineLayout({
				label: 'render.skydome.layout',
				bindGroupLayouts: [this.frameLayout],
			}),
			vertex: { module: domeModule, entryPoint: 'vsMain' },
			fragment: { module: domeModule, entryPoint: 'fsMain', targets: [{ format: COLOR_FORMAT }] },
			// No culling: a fullscreen triangle's winding is whatever the corner order gives.
			primitive: { topology: 'triangle-list', cullMode: 'none' },
			depthStencil: {
				format: DEPTH_FORMAT,
				// Reverse-Z, vertex z = 0, i.e. the far plane. `greater-equal` therefore passes
				// only where the prepass left depth at its 0 clear — pixels no geometry claimed.
				// Writes stay off so this pipeline is legal inside the forward pass's
				// depthReadOnly attachment, and so TAA keeps treating the sky as background.
				depthWriteEnabled: false,
				depthCompare: 'greater-equal',
			},
		})
	}

	/** Everything whose size depends on the render target. Resize only, never per frame. */
	private allocateSizedResources(width: number, height: number): void {
		const w = Math.max(1, width)
		const h = Math.max(1, height)
		const targetsChanged = this.targets.allocate(w, h)
		const clustersChanged = this.clusters.allocate(w, h)
		if (clustersChanged || !this.clusters.bindGroup) this.clusters.rebuildBindGroup(this.frameUniform, this.lights.buffer)
		if (targetsChanged || clustersChanged || !this.frameBindGroup) this.rebuildFrameBindGroup()
		if (targetsChanged || !this.historyValid) {
			this.postChain.rebind(
				this.frameUniform,
				this.targets.colorView,
				this.targets.depthView,
				this.targets.velocityView,
				this.targets.reflectionView,
				this.targets.historyViews as GPUTextureView[],
				this.targets.width,
				this.targets.height,
			)
			// A resized history holds the wrong image at the wrong scale; blending against
			// it would smear the old frame across the new one for half a second.
			this.historyValid = false
		}
	}

	private rebuildFrameBindGroup(): void {
		this.atmosphere?.rebind(this.frameUniform, this.targets.depthView, this.shroudView)
		this.frameBindGroup = this.device.createBindGroup({
			label: 'render.frame.bindgroup',
			layout: this.frameLayout,
			entries: [
				{ binding: 0, resource: { buffer: this.frameUniform } },
				{ binding: 1, resource: { buffer: this.lights.buffer } },
				{ binding: 2, resource: { buffer: this.clusters.countBuffer } },
				{ binding: 3, resource: { buffer: this.clusters.indexBuffer } },
				{ binding: 4, resource: this.shadows.arrayView },
				{ binding: 5, resource: this.shadowSampler },
				{ binding: 6, resource: { buffer: this.probes.buffer } },
				{ binding: 7, resource: { buffer: this.postChain.exposureBuffer } },
				{ binding: 8, resource: this.linearSampler },
				{ binding: 9, resource: this.shroudView },
				{ binding: 10, resource: this.cellLayerView },
			],
		})
	}

	resize(width: number, height: number, _ctx: Ctx): void {
		if (this.disposed || !this.device) return
		this.allocateSizedResources(width, height)
	}

	/**
	 * Rule 11: everything compilable is compiled before frame 1. Creating the pipeline
	 * object is not enough on Metal: the driver compiles it on the first draw that
	 * actually rasterises. One triangle of every layout goes through shadow, prepass
	 * and forward here, and the loader waits until that GPU work finishes.
	 */
	async prewarm(_ctx: Ctx): Promise<void> {
		if (this.disposed || !this.device) return
		this.allocateSizedResources(this.canvas.width, this.canvas.height)
		this.writeFrameUniform(0)
		this.seedWarmInstance()
		const encoder = this.device.createCommandEncoder({ label: 'render.prewarm' })
		this.encodeShadowPasses(encoder, true)
		this.encodeDepthPrepass(encoder, true)
		this.encodeComputePasses(encoder)
		this.encodeForwardPass(encoder, true)
		// Warm both transparent pipelines too, including the particle-only draw path.
		this.atmosphere.add(0,-100,0,.001,0,0,0,0,0,0,0)
		this.atmosphere.encode(encoder, this.targets.colorView, this.camera.position)
		this.atmosphere.reset()
		this.postChain.encodeTaa(encoder, this.targets.currentHistoryView, this.targets.historyIndex)
		this.postChain.encodeBloom(encoder, this.targets.historyIndex)
		const compute = encoder.beginComputePass({ label: 'render.pass.exposure.prewarm' })
		this.postChain.encodeExposure(compute, this.targets.historyIndex)
		compute.end()
		const started = performance.now()
		this.device.pushErrorScope('validation')
		this.device.queue.submit([encoder.finish()])
		// Metal compiles a pipeline on its first real draw, not when the pipeline object
		// is created. An empty pass does not count, so the first pan that brought a
		// skinned or cutout mesh on screen stalled 70–200 ms. These draws move that
		// onto the loading bar.
		await this.device.queue.onSubmittedWorkDone()
		const error = await this.device.popErrorScope()
		if (error) console.error('[render] prewarm validation:', error.message)
		console.info(`[render] pipeline warmup ${Math.round(performance.now() - started)} ms`)
	}

	private seedWarmInstance(): void {
		const data = this.instanceData
		data.fill(0, 0, INSTANCE_FLOATS)
		data[0] = 1
		data[5] = 1
		data[10] = 1
		data[15] = 1
		this.device.queue.writeBuffer(this.instanceBuffer, 0, data.buffer, data.byteOffset, INSTANCE_BYTES)
		this.device.queue.writeBuffer(this.previousInstanceBuffer, 0, data.buffer, data.byteOffset, INSTANCE_BYTES)
	}

	private warmMaterial(): GPUBindGroup | null {
		for (let i = 0; i < this.materialBindGroups.length; i++) {
			const group = this.materialBindGroups[i]
			if (group) return group
		}
		return this.atlasBindGroup
	}

	private warmGeometry(stride: number): { vertexBuffer: GPUBuffer; indexBuffer: GPUBuffer; indexFormat: GPUIndexFormat; indexCount: number } | null {
		const found = this.warmMesh.get(stride)
		if (found) return found
		if (stride !== TERRAIN_STRIDE || !this.device) return null
		if (this.terrainWarm) return this.terrainWarm
		const vertexBuffer = this.device.createBuffer({
			label: 'render.prewarm.terrain',
			size: TERRAIN_STRIDE * 3,
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
		})
		const indexBuffer = this.device.createBuffer({
			label: 'render.prewarm.terrain.idx',
			size: 8,
			usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
			mappedAtCreation: true,
		})
		new Uint16Array(indexBuffer.getMappedRange()).set([0, 1, 2])
		indexBuffer.unmap()
		this.terrainWarm = { vertexBuffer, indexBuffer, indexFormat: 'uint16', indexCount: 3 }
		return this.terrainWarm
	}

	private drawWarm(pass: GPURenderPassEncoder, pipeline: GPURenderPipeline | null, stride: number, material: GPUBindGroup | null, materialGroup: number): void {
		const mesh = this.warmGeometry(stride)
		if (!pipeline || !mesh || mesh.indexCount < 3) return
		pass.setPipeline(pipeline)
		if (material) pass.setBindGroup(materialGroup, material)
		pass.setVertexBuffer(0, mesh.vertexBuffer)
		pass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat)
		pass.drawIndexed(3, 1, 0, 0, 0)
	}

	// -----------------------------------------------------------------------
	// RenderApi
	// -----------------------------------------------------------------------

	upload(mesh: GeoMesh, label: string, cachedLods?: readonly GeoMesh[], onFreshChain?: (chain: readonly GeoMesh[]) => void): GpuMesh {
		// A disabled renderer must still hand back a usable handle. Nodes call upload()
		// during their own init(), and throwing here would kill the boot from a second
		// direction after init() deliberately chose not to (rule 8). The stub draws
		// nothing: submit() rejects a zero-index mesh, so it is inert rather than invalid.
		if (this.unsupported) return this.stubMesh(mesh)
		if (!this.device) throw new Error('render.upload called before init()')
		const windows = this.nightLights.windowsFor(label, mesh)
		const handle = this.meshes.upload(mesh, label, windows, cachedLods, onFreshChain)
		if (!this.warmMesh.has(handle.stride)) this.warmMesh.set(handle.stride, handle)
		// Read the CPU mesh HERE: `units` reuses one scratch Mesh across the procedural
		// path, so anything wanted from it has to be taken during the call that owns it.
		this.nightLights.register(handle, label, mesh, windows)
		return handle
	}

	uploadLods(levels: readonly GeoMesh[], label: string): GpuMesh {
		if (levels.length !== 3) throw new Error('render.uploadLods requires three authored levels')
		if (this.unsupported) return this.stubMesh(levels[0])
		if (!this.device) throw new Error('render.uploadLods called before init()')
		const windows = this.nightLights.windowsFor(label, levels[0])
		const handle = this.meshes.uploadLods(levels, label, windows)
		if (!this.warmMesh.has(handle.stride)) this.warmMesh.set(handle.stride, handle)
		this.nightLights.register(handle, label, levels[0], windows)
		return handle
	}

	setShroud(cells: Uint8Array, w: number, h: number, originX: number, originY: number): void {
		if (this.unsupported || !this.device) return
		if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0 || cells.length < w * h ||
			!Number.isFinite(originX) || !Number.isFinite(originY))
			throw new Error(`render.setShroud: invalid ${w}x${h} grid backed by ${cells.length} cells`)

		const sizeChanged = w !== this.shroudWidth || h !== this.shroudHeight
		if (sizeChanged) {
			const old = this.shroudTexture
			this.shroudTexture = this.createShroudTexture(w, h)
			this.shroudView = this.shroudTexture.createView()
			this.shroudPixels = new Uint8Array(w * h) // rulecheck-allow rule 6: map resize, not a frame
			this.shroudWidth = w
			this.shroudHeight = h
			// The bind group retains the VIEW, not the field holding it. Rebuild before the
			// old texture is destroyed or a resized map keeps sampling its predecessor forever.
			this.rebuildFrameBindGroup()
			old.destroy()
		}

		// r8unorm is the filtering representation. The protocol values 0,1,2 would all be
		// near black if uploaded verbatim; spread them over the full byte so linear sampling
		// makes a continuous soft boundary instead of thresholding back to three hard bands.
		const pixels = this.shroudPixels
		const n = w * h
		for (let i = 0; i < n; i++) pixels[i] = cells[i] >= 2 ? 255 : cells[i] === 1 ? 128 : 0
		this.device.queue.writeTexture(
			{ texture: this.shroudTexture },
			pixels,
			{ bytesPerRow: w, rowsPerImage: h },
			{ width: w, height: h, depthOrArrayLayers: 1 },
		)
		this.shroudOriginX = originX
		this.shroudOriginY = originY
	}

	setApron(cells: number): void {
		this.apronDepthM = Number.isFinite(cells) ? Math.max(0, cells) : 0
	}

	/**
	 * The atlas layer every terrain cell draws, row-major, with the world position of cell
	 * (0,0). The ground shader mixes the four cells around each pixel from this map, so a
	 * surface boundary is a smooth curve rather than a cell edge. Covers the scenery ring
	 * when there is one, so the ring and the playable grid blend into each other too.
	 */
	setCellLayers(cells: Uint8Array<ArrayBuffer>, w: number, h: number, originX: number, originY: number): void {
		if (this.unsupported || !this.device) return
		if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0 || cells.length < w * h ||
			!Number.isFinite(originX) || !Number.isFinite(originY))
			throw new Error(`render.setCellLayers: invalid ${w}x${h} grid backed by ${cells.length} cells`)
		if (w !== this.cellLayerWidth || h !== this.cellLayerHeight) {
			const old = this.cellLayerTexture
			this.cellLayerTexture = this.createCellLayerTexture(w, h)
			this.cellLayerView = this.cellLayerTexture.createView()
			this.cellLayerWidth = w
			this.cellLayerHeight = h
			// Same rule as the shroud: the bind group holds the view, so rebuild before destroy.
			this.rebuildFrameBindGroup()
			old.destroy()
		}
		this.device.queue.writeTexture(
			{ texture: this.cellLayerTexture },
			cells,
			{ bytesPerRow: w, rowsPerImage: h },
			{ width: w, height: h, depthOrArrayLayers: 1 },
		)
		this.cellLayerOriginX = originX
		this.cellLayerOriginY = originY
		this.cellLayersReady = true
	}

	private createCellLayerTexture(w: number, h: number): GPUTexture {
		return this.device.createTexture({
			label: `render.cellLayers.${w}x${h}`,
			size: { width: w, height: h, depthOrArrayLayers: 1 },
			format: 'r8uint',
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
		})
	}

	private createShroudTexture(w: number, h: number): GPUTexture {
		return this.device.createTexture({
			label: `render.shroud.${w}x${h}`,
			size: { width: w, height: h, depthOrArrayLayers: 1 },
			format: 'r8unorm',
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
		})
	}

	/** Inert GpuMesh for the disabled-renderer path. Never bound, never drawn. */
	private stubMesh(mesh: GeoMesh): GpuMesh {
		return {
			vertexBuffer: null as unknown as GPUBuffer,
			indexBuffer: null as unknown as GPUBuffer,
			indexCount: 0,
			aabbMin: vec3(mesh.aabbMin[0], mesh.aabbMin[1], mesh.aabbMin[2]),
			aabbMax: vec3(mesh.aabbMax[0], mesh.aabbMax[1], mesh.aabbMax[2]),
		}
	}

	submit(item: DrawItem): void {
		// Disabled renderer: accept and discard without warning. The one console.error in
		// init() is the signal; warning per submit would bury it under thousands of lines.
		if (this.unsupported) return
		if (itemOpacity(item) <= 0) return
		if (this.itemCount >= MAX_ITEMS || item.instanceCount <= 0) {
			this.droppedItems++
			if (item.instanceCount > 0 && !this.warnedSets.has(OVERFLOW_KEY)) {
				this.warnedSets.add(OVERFLOW_KEY)
				console.warn(
					`[render] draw-item table full (${MAX_ITEMS}); further items this frame are dropped. ` +
						'Batch instances into fewer DrawItems, or raise the quality preset budget.',
				)
			}
			return
		}
		// A GpuMesh that did not come out of upload() has no index format and no pipeline
		// variant, and binding it produces a WebGPU validation error several frames away
		// from the mistake. Catch it at the seam instead.
		if (!(item.mesh as GpuMeshHandle).indexFormat)
			throw new Error(
				`render.submit: DrawItem.mesh for surfaceSet '${item.surfaceSet}' was not produced by render.upload(). ` +
					'Upload every mesh once at boot and reuse the handle.',
			)
		const slot = this.materialSlotFor(item.surfaceSet)
		if (slot < 0) {
			// No material set and no fallback the pipeline layout accepts. Drawing anyway
			// would be a validation error; drawing untextured would be a lie about what
			// the material system produced. So it is dropped — but never silently.
			this.droppedItems++
			if (!this.warnedSets.has(item.surfaceSet)) {
				this.warnedSets.add(item.surfaceSet)
				console.warn(
					`[render] unknown surfaceSet '${item.surfaceSet}' — geometry dropped and NOTHING will draw for it. ` +
						`materials carries no set by that id and none of the fallbacks (${MATERIAL_FALLBACKS.join(', ')}) ` +
						'are present. Check the id against MaterialsApi.has() at boot.',
				)
			}
			return
		}
		const i = this.itemCount++
		this.items[i] = item
		this.itemMatSlot[i] = slot
	}

	/**
	 * Reserve `count` bone slots and return the base index to put in instance float 21.
	 *
	 * Returns 0 when the palette is full, and 0 MEANS UNSKINNED — so a frame that overflows
	 * draws the overflowing actors in their bind pose rather than dropping them or reading a
	 * neighbour's matrices. That is rule 9's graceful degradation applied to animation: the
	 * army keeps rendering, some of it stops moving, and nothing reads memory it does not own.
	 *
	 * The caller writes into the returned view. `anim` owns what goes in it; `render` owns
	 * only that it reaches the GPU.
	 */
	reserveBones(count: number): { base: number, matrices: Float32Array } | null {
		if (count <= 0 || this.boneCount + count > MAX_PALETTE_MATRICES) return null
		const base = this.boneCount
		this.boneCount += count
		return { base, matrices: this.boneData.subarray(base * 16, (base + count) * 16) }
	}

	/** Called on snapshot events before producers overwrite the previous frame's palette. */
	copyCompletedBones(base: number, count: number, out: Float32Array): boolean {
		if (!Number.isInteger(base) || !Number.isInteger(count) || base < 0 || count < 0 || out.length < count * 16) return false
		if (base === 0) {
			for (let i = 0; i < count * 16; i++) out[i] = i % 16 % 5 === 0 ? 1 : 0
			return true
		}
		if (base + count > this.completedBoneCount) return false
		for (let i = 0; i < count * 16; i++) out[i] = this.boneData[base * 16 + i]
		return true
	}

	addLight(x: number, y: number, z: number, r: number, g: number, b: number, intensity: number, radius: number): void {
		this.lights.add(x, y, z, r, g, b, intensity, radius)
	}

	/**
	 * GPU memory the effects own (vfx.md Epic 8, "VFX resource accounting"): the meshes fx
	 * uploaded (labels `fx:`), the particle storage buffer and the heat uniform. Their draw
	 * instances ride the shared instance buffer and their lights the shared light pool.
	 */
	get vfxBytes(): { meshes: number; particles: number; heat: number; total: number } {
		const meshes = this.meshes?.uploadedFxBytes ?? 0, particles = this.atmosphere?.bufferBytes ?? 0, heat = HEAT_FLOATS * 4
		return { meshes, particles, heat, total: meshes + particles + heat }
	}

	/** A heat shimmer this frame (render/heat); four at most, the rest dropped. */
	addHeatSource(x: number, y: number, z: number, radiusM: number, strengthPx: number): void {
		this.heat.add(x, y, z, radiusM, strengthPx)
	}

	addSpotLight(x:number,y:number,z:number,dx:number,dy:number,dz:number,r:number,g:number,b:number,intensity:number,radius:number,innerCos:number,outerCos:number):void {
		this.lights.add(x,y,z,r,g,b,intensity,radius,dx,dy,dz,innerCos,outerCos)
	}

	setCamera(view: Mat4, proj: Mat4, position: Vec3, focus?: Vec3): void {
		this.camera.view.set(view)
		this.camera.proj.set(proj)
		this.camera.position.set(position)
		if (focus) this.camera.focus.set(focus)
		m4.multiply(this.camera.viewProj, proj, view)
		// perspectiveReverseZ puts the near plane in m[14] and -1 in m[11]. Anything else
		// is not the projection this renderer's depth convention assumes.
		this.camera.nearPlane = proj[11] === -1 && proj[14] > 0 ? proj[14] : 0.1
	}

	// -----------------------------------------------------------------------
	// Node hooks
	// -----------------------------------------------------------------------

	/**
	 * Deliberately does NOT derive the environment from the snapshot any more.
	 *
	 * `sky` owns time of day and weather and pushes the result through `setEnvironment`
	 * (§12.2). Render used to compute it here as well, which would have meant two writers
	 * and two clocks that could disagree — the same shape of defect as an empty
	 * `Prerequisites:` that silently fails to override, or `droppedItems` incremented and
	 * never read. There is now exactly one writer.
	 */
	onSnapshot(snap: Snapshot, _prev: Snapshot | null, _ctx: Ctx): void {
		const players = snap.players
		this.playerColorCount = Math.min(players.length, 256)
		for (let i = 0; i < this.playerColorCount; i++) {
			const p = players[i]
			const o = i * 4
			this.playerColorTable[o] = p.red / 255
			this.playerColorTable[o + 1] = p.green / 255
			this.playerColorTable[o + 2] = p.blue / 255
			this.playerColorTable[o + 3] = p.alpha / 255
		}
		separatePlayerColors(this.playerColorTable, this.playerColorCount, players)
	}

	get environment(): SkyEnvironment {
		return this.env
	}

	/**
	 * High / Dynamic 60 fps shed. Cascades only drop, they are never allocated here.
	 * Contact is suppressed through frame.debug.z. Scenery step skips instances in
	 * batches large enough to be grass or meadow, not individual units.
	 */
	setLoadShed(shed: { cascades: number; contact: boolean; sceneryStep: number }): void {
		const maxC = this.shadows?.cascadeCount ?? 1
		this.liveCascades = Math.max(1, Math.min(maxC, shed.cascades | 0))
		this.contactSuppressed = !shed.contact
		this.sceneryStep = shed.sceneryStep >= 4 ? 4 : shed.sceneryStep >= 2 ? 2 : 1
	}

	setEnvironment(env: SkyEnvironment): void {
		// Copied, not retained: the caller is expected to reuse one preallocated instance.
		const e = this.env
		v3.copy(e.sunDir, env.sunDir)
		v3.normalize(e.sunDir, e.sunDir)
		v3.copy(e.sunColor, env.sunColor)
		v3.copy(e.skyColor, env.skyColor)
		e.sunIntensity = env.sunIntensity
		e.groundAlbedo = env.groundAlbedo
		e.ambientScale = env.ambientScale

		v3.copy(e.horizonColor, env.horizonColor)
		v3.copy(e.groundRadiance, env.groundRadiance)
		v3.copy(e.moonDir, env.moonDir)
		v3.normalize(e.moonDir, e.moonDir)
		v3.copy(e.moonColor, env.moonColor)
		e.moonIntensity = env.moonIntensity
		v3.copy(e.aerialColor, env.aerialColor)
		e.aerialDensity = env.aerialDensity
		e.cloudCoverage = env.cloudCoverage
		e.cloudOpacity = env.cloudOpacity
		e.cloudScale = env.cloudScale
		e.cloudOffsetX = env.cloudOffsetX
		e.cloudOffsetZ = env.cloudOffsetZ
		e.cloudSeed = env.cloudSeed >>> 0
		e.windX = env.windX ?? 0; e.windZ = env.windZ ?? 1; e.windStrength = env.windStrength ?? 0
		e.rainIntensity = env.rainIntensity ?? 0; e.snowIntensity = env.snowIntensity ?? 0; e.wetness = env.wetness ?? 0
		e.snowCoverage = env.snowCoverage ?? env.snowIntensity ?? 0
		e.surfaceWetness = env.surfaceWetness ?? env.wetness ?? 0
		e.motionTime = env.motionTime ?? 0
		e.lightning = env.lightning ?? 0
	}

	addParticle(x:number,y:number,z:number,radius:number,r:number,g:number,b:number,alpha:number,age:number,seed:number,emission:number): void {
		this.atmosphere?.add(x,y,z,radius,r,g,b,alpha,age,seed,emission)
	}

	update(_dt: number, _ctx: Ctx): void {
		// Submissions arrive during update() from every node in the graph, and update
		// order is topological rather than chronological — a node that does not depend on
		// render runs before it. So nothing is cleared here; the frame's lists are cleared
		// after the draw, at the end of lateUpdate.
	}

	lateUpdate(dt: number, ctx: Ctx): void {
		if (this.disposed || !this.device) return
		// A lost device takes every buffer, texture and pipeline with it: stop encoding against
		// it (each call would only add a validation error) and leave the page to the UI's alarm.
		if (ctx.gpuLost !== null) {
			this.endFrame()
			return
		}
		this.stats.pipelineCreations = 0
		this.stats.drawCalls = 0
		this.stats.triangles = 0

		if (this.canvas.width !== this.targets.width || this.canvas.height !== this.targets.height) {
			this.allocateSizedResources(this.canvas.width, this.canvas.height)
		}

		this.frameIndex++
		// Published BEFORE flush(): nodes submit during update(), which has already run, so
		// droppedItems holds this frame's count. endFrame() clears it after the draw.
		this.stats.dropped = this.droppedItems
		// Lamps last, and before the flush: every node's update() has already run, so the
		// pool holds this frame's combat lights and the camera is final. The frustum is
		// extracted here rather than reused from buildInstances because that runs after
		// the flush — a lamp ranked against a stale camera is a lamp that flickers.
		this.extractFrustum(this.camera.viewProj)
		this.nightLights.update(this.env, this.camera, this.planes, this.items, this.itemCount, this)
		this.stats.lightsDropped = this.lights.droppedThisFrame
		this.stats.lights = this.lights.flush(
			this.device,
			this.camera.position[0],
			this.camera.position[1],
			this.camera.position[2],
		)
		this.shadows.fit(
			this.camera.view,
			this.camera.proj,
			this.camera.position[0],
			this.camera.position[1],
			this.camera.position[2],
			this.env.sunDir[0],
			this.env.sunDir[1],
			this.env.sunDir[2],
		)
		this.probes.recentre(this.camera.position[0], this.camera.position[2])
		this.writeFrameUniform(dt)
		this.buildInstances()
		this.applyBudget(ctx)
		this.rememberIncludedMotion()
		this.buildOrders()
		this.encodeFrame()

		this.endFrame()
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.meshes?.dispose()
		this.targets?.release()
		this.clusters?.dispose()
		this.shadows?.dispose()
		this.probes?.dispose()
		this.postChain?.dispose()
		this.lights?.dispose()
		this.nightLights.dispose()
		this.frameUniform?.destroy()
		this.atmosphere?.dispose()
		this.instanceBuffer?.destroy()
		this.previousInstanceBuffer?.destroy()
		this.terrainWarm?.vertexBuffer.destroy()
		this.terrainWarm?.indexBuffer.destroy()
		this.boneBuffer?.destroy()
		this.previousBoneBuffer?.destroy()
		this.shroudTexture?.destroy()
		for (const t of this.fallbackTextures) t.destroy()
		this.fallbackTextures.length = 0
		this.frameBindGroup = null
		for (let i = 0; i < MAX_ITEMS; i++) this.items[i] = null
		this.itemCount = 0
		this.motionHistory.clear()
		try {
			this.context?.unconfigure()
		} catch {
			// Unconfiguring a context whose device is already lost throws on some builds.
			// Disposal must not be the thing that takes the page down.
		}
	}

	// -----------------------------------------------------------------------
	// Environment
	// -----------------------------------------------------------------------

	/**
	 * Sun and sky from snapshot section 0. Time of day is 0..1439 minutes: 06:00 puts the
	 * sun on the eastern horizon, 12:00 overhead, 18:00 west. Below the horizon the same
	 * arc becomes a dim cool moon rather than a black frame.
	 */
	private seedDefaultEnvironment(timeOfDay: number): void {
		const e = this.env
		const t = ((timeOfDay % 1440) + 1440) % 1440 / 1440
		const angle = (t - 0.25) * Math.PI * 2
		const elevation = Math.sin(angle)
		const east = Math.cos(angle)
		// A constant southward tilt keeps noon off the exact zenith, which is what gives
		// every silhouette a readable shadow instead of a puddle under itself (§9).
		v3.set(e.sunDir, east, elevation, 0.28)
		const night = elevation < 0
		if (night) v3.set(e.sunDir, -east, -elevation, -0.28)
		v3.normalize(e.sunDir, e.sunDir)
		// No separate moon body in the fallback: sky owns the real ephemeris. Pointing the
		// moon at the beam makes the dome's coincidence test suppress the sun disc at night,
		// which is what keeps this path from drawing a bright white sun in a dark sky.
		v3.copy(e.moonDir, e.sunDir)

		const height = Math.max(0, Math.abs(elevation))
		if (night) {
			v3.set(e.sunColor, 0.55, 0.68, 0.95)
			e.sunIntensity = 0.28 + height * 0.22
			v3.set(e.skyColor, 0.020, 0.031, 0.062)
			v3.set(e.horizonColor, 0.030, 0.040, 0.070)
			e.groundAlbedo = 0.16
			v3.copy(e.moonColor, e.sunColor)
			e.moonIntensity = e.sunIntensity
		} else {
			// Warm and dim at the horizon, neutral and bright overhead — Rayleigh's effect
			// on the direct beam, approximated with one interpolation.
			const warm = 1 - height
			v3.set(e.sunColor, 1, 0.96 - warm * 0.28, 0.90 - warm * 0.55)
			e.sunIntensity = 0.6 + height * 4.2
			v3.set(e.skyColor, 0.055 + height * 0.13, 0.10 + height * 0.20, 0.19 + height * 0.30)
			// Brighter and warmer than the zenith, and NOT a multiple of it: the horizon
			// carries the low sun's long-path scattering, which the zenith does not.
			v3.set(
				e.horizonColor,
				0.11 + height * 0.23 + warm * 0.18,
				0.16 + height * 0.28 + warm * 0.05,
				0.26 + height * 0.35,
			)
			e.groundAlbedo = 0.22
			e.moonIntensity = 0
		}
		// The sky's own light bouncing back off the ground. Derived here only because this
		// is the fallback; when `sky` is present it publishes the real value.
		v3.set(
			e.groundRadiance,
			e.skyColor[0] * e.groundAlbedo,
			e.skyColor[1] * e.groundAlbedo,
			e.skyColor[2] * e.groundAlbedo,
		)
		v3.copy(e.aerialColor, e.horizonColor)
		e.aerialDensity = 0.0015
		e.ambientScale = 1
		e.cloudCoverage = 0.16
		e.cloudOpacity = 0.16
		e.cloudScale = 0.0035
		e.cloudOffsetX = 0
		e.cloudOffsetZ = 0
	}

	// -----------------------------------------------------------------------
	// Frame uniform
	// -----------------------------------------------------------------------

	private writeFrameUniform(dt: number): void {
		const f = this.frameFloats
		const u = this.frameU32
		const w = this.targets.width
		const h = this.targets.height
		const near = this.camera.nearPlane

		// TAA jitter is folded into the projection so every pass rasterises to the same
		// subpixel position. The public camera stays unjittered, because culling and
		// picking must not wobble by half a pixel every frame.
		const ji = (this.frameIndex % JITTER_COUNT) * 2
		const jx = JITTER_TABLE[ji]
		const jy = JITTER_TABLE[ji + 1]
		this.jitteredProj.set(this.camera.proj)
		this.jitteredProj[8] -= (jx * 2) / w
		this.jitteredProj[9] -= (jy * 2) / h
		m4.multiply(this.jitteredViewProj, this.jitteredProj, this.camera.view)

		// UNJITTERED inverse, and this is the fix for TAA never converging.
		//
		// TAA's only consumer builds its NDC from the exact pixel centre — unjittered screen
		// space — and then reprojects with `prevViewProj`, which is also unjittered. Handing
		// it the JITTERED inverse mixed the two spaces: the reconstructed world position came
		// out displaced by the current frame's jitter, so `prevUv` moved every frame with the
		// Halton sequence and history was sampled from a different place each time. On a
		// completely static camera and scene the accumulation buffer was still 71.5% unstable
		// with up to 52% relative change, and the visible result was tile flicker.
		//
		// Both ends of the reprojection now live in unjittered screen space, which is what
		// the comment in frame.ts always claimed. The depth sample is still the jittered
		// rasterisation's, but treating it as the pixel centre's depth is the conventional
		// approximation and its error is second-order, unlike a whole-jitter offset.
		if (!m4.invert(this.invViewProj, this.camera.viewProj)) m4.identity(this.invViewProj)

		f.set(this.camera.view, F_VIEW)
		f.set(this.jitteredProj, F_PROJ)
		f.set(this.jitteredViewProj, F_VIEWPROJ)
		f.set(this.invViewProj, F_INV_VIEWPROJ)
		f.set(this.prevViewProj, F_PREV_VIEWPROJ)
		f.set(this.shadows.matrices, F_CASCADE_VP)

		f[F_CAMERA] = this.camera.position[0]
		f[F_CAMERA + 1] = this.camera.position[1]
		f[F_CAMERA + 2] = this.camera.position[2]
		f[F_CAMERA + 3] = near

		const e = this.env
		f[F_SUN_DIR] = e.sunDir[0]
		f[F_SUN_DIR + 1] = e.sunDir[1]
		f[F_SUN_DIR + 2] = e.sunDir[2]
		f[F_SUN_DIR + 3] = 0

		const bolt = e.lightning ?? 0
		f[F_SUN_COLOR] = e.sunColor[0] * (1 - bolt) + bolt
		f[F_SUN_COLOR + 1] = e.sunColor[1] * (1 - bolt) + bolt
		f[F_SUN_COLOR + 2] = e.sunColor[2] * (1 - bolt) + bolt
		f[F_SUN_COLOR + 3] = e.sunIntensity * (1 + bolt * 6)

		f[F_SKY_COLOR] = e.skyColor[0] * (1 - bolt * 0.35) + bolt * 0.85
		f[F_SKY_COLOR + 1] = e.skyColor[1] * (1 - bolt * 0.35) + bolt * 0.88
		f[F_SKY_COLOR + 2] = e.skyColor[2] * (1 - bolt * 0.35) + bolt
		f[F_SKY_COLOR + 3] = e.groundAlbedo

		f[F_HORIZON_COLOR] = e.horizonColor[0]
		f[F_HORIZON_COLOR + 1] = e.horizonColor[1]
		f[F_HORIZON_COLOR + 2] = e.horizonColor[2]
		f[F_HORIZON_COLOR + 3] = e.aerialDensity

		f[F_GROUND_RADIANCE] = e.groundRadiance[0]
		f[F_GROUND_RADIANCE + 1] = e.groundRadiance[1]
		f[F_GROUND_RADIANCE + 2] = e.groundRadiance[2]
		f[F_GROUND_RADIANCE + 3] = e.moonIntensity

		f[F_MOON_DIR] = e.moonDir[0]
		f[F_MOON_DIR + 1] = e.moonDir[1]
		f[F_MOON_DIR + 2] = e.moonDir[2]
		f[F_MOON_DIR + 3] = 0

		f[F_MOON_COLOR] = e.moonColor[0]
		f[F_MOON_COLOR + 1] = e.moonColor[1]
		f[F_MOON_COLOR + 2] = e.moonColor[2]
		f[F_MOON_COLOR + 3] = 0

		f[F_AERIAL_COLOR] = e.aerialColor[0]
		f[F_AERIAL_COLOR + 1] = e.aerialColor[1]
		f[F_AERIAL_COLOR + 2] = e.aerialColor[2]
		f[F_AERIAL_COLOR + 3] = 0

		f[F_CLOUD] = e.cloudCoverage
		f[F_CLOUD + 1] = e.cloudOpacity
		f[F_CLOUD + 2] = e.cloudScale
		f[F_CLOUD + 3] = 0

		f[F_CLOUD_DRIFT] = e.cloudOffsetX
		f[F_CLOUD_DRIFT + 1] = e.cloudOffsetZ
		f[F_CLOUD_DRIFT + 2] = 0
		f[F_CLOUD_DRIFT + 3] = 0

		// Through the u32 view: the seed is a full 32-bit hash input and writing it as a
		// float would round every value past 2^24 to a neighbour, silently collapsing
		// distinct asset seeds onto the same cloud field.
		u[F_SKY_SEED] = e.cloudSeed >>> 0
		u[F_SKY_SEED + 1] = 0
		u[F_SKY_SEED + 2] = 0
		u[F_SKY_SEED + 3] = Math.round(this.nightLights.factorFor(e) * 65535)

		f[F_SCREEN] = w
		f[F_SCREEN + 1] = h
		f[F_SCREEN + 2] = 1 / w
		f[F_SCREEN + 3] = 1 / h

		u[F_CLUSTER_DIMS] = this.clusters.tilesX
		u[F_CLUSTER_DIMS + 1] = this.clusters.tilesY
		u[F_CLUSTER_DIMS + 2] = this.clusters.slices
		u[F_CLUSTER_DIMS + 3] = this.lights.count

		u[F_CLUSTER_EXTRA] = this.clusters.lightsPerCluster
		u[F_CLUSTER_EXTRA + 1] = this.liveCascades
		u[F_CLUSTER_EXTRA + 2] = this.frameIndex
		u[F_CLUSTER_EXTRA + 3] = this.probes.advanceCursor()

		f[F_CLUSTER_Z] = near
		f[F_CLUSTER_Z + 1] = CLUSTER_FAR
		f[F_CLUSTER_Z + 2] = this.clusters.logScale(near)
		f[F_CLUSTER_Z + 3] = this.clusters.logBias(near)

		f.set(this.shadows.splits, F_CASCADE_SPLITS)
		f.set(this.shadows.texelWorld, F_CASCADE_TEXEL)

		f[F_PARAMS] = e.motionTime ?? this.frameIndex * (1 / 60)
		f[F_WEATHER] = e.windX ?? 0; f[F_WEATHER + 1] = e.windZ ?? 1
		f[F_WEATHER + 2] = e.windStrength ?? 0; f[F_WEATHER + 3] = e.rainIntensity ?? 0
		f[F_SURFACE_WEATHER] = e.surfaceWetness ?? e.wetness ?? 0
		f[F_SURFACE_WEATHER + 1] = e.snowCoverage ?? e.snowIntensity ?? 0
		f[F_SURFACE_WEATHER + 2] = e.motionTime ?? 0; f[F_SURFACE_WEATHER + 3] = e.lightning ?? 0
		f[F_PARAMS + 1] = dt
		f[F_PARAMS + 2] = this.shadows.mapSize
		f[F_PARAMS + 3] = e.ambientScale

		f[F_POST] = 0
		f[F_POST + 1] = this.renderQuality.sharpenStrength
		// No history on the first frame after a resize: blending against a stale or blank
		// buffer smears for as long as the feedback takes to decay.
		f[F_POST + 2] = this.historyValid ? 0.9 : 0
		f[F_POST + 3] = PROBE_DIFFUSE_SCALE

		f[F_JITTER] = jx
		f[F_JITTER + 1] = jy
		f[F_JITTER + 2] = 0
		f[F_JITTER + 3] = 0

		f[F_PROBE_ORIGIN] = this.probes.origin[0]
		f[F_PROBE_ORIGIN + 1] = this.probes.origin[1]
		f[F_PROBE_ORIGIN + 2] = this.probes.origin[2]
		f[F_PROBE_ORIGIN + 3] = PROBE_SPACING

		u[F_PROBE_DIMS] = this.probes.dimX
		u[F_PROBE_DIMS + 1] = this.probes.dimY
		u[F_PROBE_DIMS + 2] = this.probes.dimZ
		u[F_PROBE_DIMS + 3] = this.probes.updatesPerFrame

		u[F_DEBUG] = this.debugView
		u[F_DEBUG + 1] = this.configClassicLook
		u[F_DEBUG + 2] = this.contactSuppressed ? 1 : 0
		u[F_DEBUG + 3] = 0

		f[F_SHROUD] = this.shroudOriginX
		f[F_SHROUD + 1] = this.shroudOriginY
		f[F_SHROUD + 2] = 1 / this.shroudWidth
		f[F_SHROUD + 3] = 1 / this.shroudHeight

		f[F_EDGE] = this.apronDepthM
		f[F_EDGE + 1] = this.cellLayerOriginX
		f[F_EDGE + 2] = this.cellLayerOriginY
		f[F_EDGE + 3] = this.cellLayersReady ? 1 : 0

		this.device.queue.writeBuffer(this.frameUniform, 0, f.buffer, f.byteOffset, FRAME_BYTES)
		this.prevViewProj.set(this.camera.viewProj)
	}

	// -----------------------------------------------------------------------
	// Culling and instance packing
	// -----------------------------------------------------------------------

	/**
	 * Five planes: left, right, bottom, top, near. Reverse-Z's far plane is at infinity.
	 *
	 * The normalising helper is a private METHOD, not a closure declared inside this
	 * function. `extractFrustum` runs once per frame from `buildInstances`, so a local
	 * arrow function allocated a closure every frame — a textbook rule-6 violation with no
	 * WebGPU API forcing it. `rulecheck` could not see it: its rule-6 heuristic only scans
	 * the literal body of update/lateUpdate/onSnapshot and stops at the closing brace, and
	 * this lives two calls deeper.
	 */
	private extractFrustum(vp: Mat4): void {
		this.setPlane(0, vp[3] + vp[0], vp[7] + vp[4], vp[11] + vp[8], vp[15] + vp[12])
		this.setPlane(1, vp[3] - vp[0], vp[7] - vp[4], vp[11] - vp[8], vp[15] - vp[12])
		this.setPlane(2, vp[3] + vp[1], vp[7] + vp[5], vp[11] + vp[9], vp[15] + vp[13])
		this.setPlane(3, vp[3] - vp[1], vp[7] - vp[5], vp[11] - vp[9], vp[15] - vp[13])
		this.setPlane(4, vp[3] - vp[2], vp[7] - vp[6], vp[11] - vp[10], vp[15] - vp[14])
	}

	private setPlane(i: number, x: number, y: number, z: number, d: number): void {
		const p = this.planes
		const len = Math.hypot(x, y, z) || 1
		p[i * 4] = x / len
		p[i * 4 + 1] = y / len
		p[i * 4 + 2] = z / len
		p[i * 4 + 3] = d / len
	}

	// sphereVisible and selectMainLod lived here as per-instance METHOD calls. Both are
	// inlined into buildInstances now: the call, the property chain and four Math.hypot
	// calls per instance were the dominant CPU cost of the frame on a meadow map, where a
	// single scenery item spans thirty thousand instances. The invariant the two methods
	// carried is unchanged and now lives at the inline site:
	//
	//  - LOD is selected ONCE per instance per frame (squared thresholds, same bands);
	//    prepass and forward must never select independently — @invariant cannot make L0
	//    positions equal L1 positions, and depth-equal would drop the forward fragments.
	//  - The frustum test is five planes against the squared bound radius.

	/** Did any source instance of this item move since the previous frame?
	 *
	 * The shadow-LOD split below needs to tell animated casters from static scenery, and a
	 * DrawItem carries no explicit flag for that: trees arrive with motion ids and wind
	 * rigs exactly like a tank does. What the renderer does hold is last frame's model
	 * matrix per motion id — `motionHistory`, written by rememberIncludedMotion after the
	 * draw — so "animated" is observable directly: any instance whose world transform
	 * changed. Marching infantry and a deploying yard are caught while they move; a tree
	 * never is, however hard its wind blows, because wind is bone-level and never touches
	 * the model row. Known limits, both accepted: a rotorcraft hovering in place and an
	 * idle actor read as scenery, and at close range that costs them nothing — the static
	 * branch of the shadow rule equals the old one whenever mainLod is 0.
	 */
	private movedSinceLastFrame(motionIds: Uint32Array | null, src: Float32Array, n: number): boolean {
		if (motionIds === null) return false
		for (let i = 0; i < n && i < motionIds.length; i++) {
			const state = this.motionHistory.get(motionIds[i])
			if (state === undefined || state.frame !== this.frameIndex - 1) continue
			const o = i * 16
			for (let k = 0; k < 16; k++) {
				const d = src[o + k] - state.model[k]
				if (d > MODEL_MOVE_EPSILON || d < -MODEL_MOVE_EPSILON) return true
			}
		}
		return false
	}

	private itemLodTotal(counts: Int32Array, item: number): number {
		const o = item * LOD_LEVELS
		return counts[o] + counts[o + 1] + counts[o + 2]
	}

	/** Populate last-frame bones at THIS frame's palette bases before either pass reads them. */
	private preparePreviousBones(
		motionIds: Uint32Array | null,
		paletteBases: Uint16Array | null,
		boneCount: number,
		instanceCount: number,
	): void {
		if (motionIds === null || paletteBases === null || boneCount <= 0) return
		const span = boneCount * 16
		for (let i = 0; i < instanceCount; i++) {
			const base = i < paletteBases.length ? paletteBases[i] : 0
			if (base <= 0 || base + boneCount > MAX_PALETTE_MATRICES) continue
			const state = i < motionIds.length ? this.motionHistory.get(motionIds[i]) : undefined
			const fresh = !this.motiongateZeroObjectVelocity && state?.frame === this.frameIndex - 1
			const previous = fresh && state.bones.length === span ? state.bones : null
			const dst = base * 16
			const src = previous ?? this.boneData
			const srcOffset = previous === null ? dst : 0
			for (let k = 0; k < span; k++) this.previousBoneData[dst + k] = src[srcOffset + k]
		}
	}

	/** Commit current presentation poses only after every packed copy read the old state. */
	private rememberMotion(
		motionIds: Uint32Array | null,
		paletteBases: Uint16Array | null,
		boneCount: number,
		src: Float32Array,
		instanceCount: number,
	): void {
		if (motionIds === null) return
		const boneSpan = boneCount * 16
		for (let i = 0; i < instanceCount && i < motionIds.length; i++) {
			const id = motionIds[i]
			let state = this.motionHistory.get(id)
			if (state === undefined) {
				state = { model: new Float32Array(16), bones: NO_BONES, frame: -1 }
				this.motionHistory.set(id, state)
			}
			const modelOffset = i * 16
			for (let k = 0; k < 16; k++) state.model[k] = src[modelOffset + k]

			const base = paletteBases !== null && i < paletteBases.length ? paletteBases[i] : 0
			if (base > 0 && boneSpan > 0 && base + boneCount <= MAX_PALETTE_MATRICES) {
				if (state.bones.length !== boneSpan) state.bones = new Float32Array(boneSpan)
				const boneOffset = base * 16
				for (let k = 0; k < boneSpan; k++) state.bones[k] = this.boneData[boneOffset + k]
			} else state.bones = NO_BONES
			state.frame = this.frameIndex
		}
	}

	/** Cache only poses that survive the frame budget and can therefore reach a pass. */
	private rememberIncludedMotion(): void {
		for (let it = 0; it < this.itemCount; it++) {
			if (this.itemIncluded[it] === 0) continue
			const item = this.items[it]!
			const count = Math.min(item.instanceCount, (item.instances.length / 16) | 0, this.maxInstances)
			this.rememberMotion(
				item.motionIds ?? null,
				item.paletteBases ?? null,
				Math.max(0, item.boneCount ?? 0),
				item.instances,
				count,
			)
		}
		if ((this.frameIndex & 127) === 0) {
			for (const [id, state] of this.motionHistory)
				if (this.frameIndex - state.frame > 2) this.motionHistory.delete(id)
		}
	}

	/**
	 * Packs camera and shadow instances into one contiguous region per item and LOD.
	 * Classification happens once per source instance. Prepass and forward consume the same
	 * main byte; all cascades consume the same shadow byte. The shadow byte is INDEPENDENT of
	 * the camera's for static scenery — one level coarser, graphicsTune §2 — because shadow
	 * depth is sampled rather than depth-equal compared; animated casters keep the camera's
	 * level (floored at LOD1) so a deploying yard or a driving tank casts what it is.
	 */
	/** Six clip planes per cascade, from the ortho fitted this frame. */
	private refreshShadowCascadePlanes(): void {
		const m = this.shadows.matrices
		const planes = this.shadowCascadePlanes
		const n = this.liveCascades
		for (let c = 0; c < n; c++) {
			const mo = c * 16
			const po = c * 24
			planes[po] = m[mo]; planes[po + 1] = m[mo + 4]; planes[po + 2] = m[mo + 8]
			planes[po + 3] = m[mo + 12] + 1
			planes[po + 4] = -m[mo]; planes[po + 5] = -m[mo + 4]; planes[po + 6] = -m[mo + 8]
			planes[po + 7] = 1 - m[mo + 12]
			planes[po + 8] = m[mo + 1]; planes[po + 9] = m[mo + 5]; planes[po + 10] = m[mo + 9]
			planes[po + 11] = m[mo + 13] + 1
			planes[po + 12] = -m[mo + 1]; planes[po + 13] = -m[mo + 5]; planes[po + 14] = -m[mo + 9]
			planes[po + 15] = 1 - m[mo + 13]
			planes[po + 16] = m[mo + 2]; planes[po + 17] = m[mo + 6]; planes[po + 18] = m[mo + 10]
			planes[po + 19] = m[mo + 14]
			planes[po + 20] = -m[mo + 2]; planes[po + 21] = -m[mo + 6]; planes[po + 22] = -m[mo + 10]
			planes[po + 23] = 1 - m[mo + 14]
		}
	}

	/**
	 * Cascades a skinned caster has to land in. Receivers sample the band that contains
	 * their view depth, so the body is drawn there, plus a neighbour within `margin`
	 * metres of the split. Far maps do not skin the whole army.
	 */
	private skinnedCascadeMask(viewZ: number, margin: number): number {
		const splits = this.shadows.splits
		const n = this.liveCascades
		let band = 0
		while (band < n - 1 && viewZ > splits[band]) band++
		let mask = 1 << band
		if (band > 0 && viewZ < splits[band - 1] + margin) mask |= 1 << (band - 1)
		if (band + 1 < n && viewZ > splits[band] - margin) mask |= 1 << (band + 1)
		return mask
	}

	private buildInstances(): void {
		this.lodStats.mainInstances.fill(0)
		this.lodStats.shadowInstances.fill(0)
		this.extractFrustum(this.camera.viewProj)
		const data = this.instanceData
		const previousData = this.previousInstanceData
		const camX = this.camera.position[0]
		const camY = this.camera.position[1]
		const camZ = this.camera.position[2]
		const shadowCx = this.shadows.casterCenter[0]
		const shadowCy = this.shadows.casterCenter[1]
		const shadowCz = this.shadows.casterCenter[2]
		const shadowR = this.shadows.casterRadius
		const mainBySource = this.mainLodBySource
		const shadowBySource = this.shadowLodBySource
		const mainCounts = this.mainLodCountScratch
		const shadowCounts = this.shadowLodCountScratch
		const mainWrites = this.mainLodWriteScratch
		const shadowWrites = this.shadowLodWriteScratch
		// Per-frame LOD projection scale, hoisted: selectMainLod used to recompute
		// |proj[5]| * height * 0.5 per INSTANCE, and the squared thresholds below turn the
		// band comparisons into multiplies. planes are re-read into locals because the
		// classification loop touches them 30k+ times a frame on a meadow map.
		const projScale = Math.abs(this.camera.proj[5]) * this.canvas.height * 0.5
		const scale2 = projScale * projScale
		const view = this.camera.view
		const viewZ0 = view[2], viewZ1 = view[6], viewZ2 = view[10], viewZ3 = view[14]
		const planes = this.planes
		const p0 = planes[0], p1 = planes[1], p2 = planes[2], p3 = planes[3], p4 = planes[4]
		const p5 = planes[5], p6 = planes[6], p7 = planes[7], p8 = planes[8], p9 = planes[9]
		const p10 = planes[10], p11 = planes[11], p12 = planes[12], p13 = planes[13], p14 = planes[14]
		const p15 = planes[15], p16 = planes[16], p17 = planes[17], p18 = planes[18], p19 = planes[19]
		let cursor = 0
		// Instances the shared buffer had no room for. Items pack in submission order, so
		// whatever submits after a buffer-filling item (Ultra's grass can ask for ~77k blades)
		// silently lost instances before this was counted.
		let overflow = 0

		for (let it = 0; it < this.itemCount; it++) {
			const item = this.items[it]!
			const mesh = item.mesh as GpuMeshHandle
			const src = item.instances
			const n = Math.min(item.instanceCount, (src.length / 16) | 0, this.maxInstances)
			const colors = item.playerColors
			// Three floats or null. FX items that carry their own emitter never carry player
			// colours, so the two never contend for the tint slot; see writeInstance.
			const emitter = item.emitterColor ?? null
			const unlit = item.unlitColor ?? null
			const bases = item.paletteBases ?? null
			const motionIds = item.motionIds ?? null
			const boneCount = Math.max(0, item.boneCount ?? 0)
			const phases = item.phases ?? null
			const damages = item.damages ?? null
			const opacity = itemOpacity(item)
			const layerCount = this.materialLayerCount[this.itemMatSlot[it]] || 1
			const localR = mesh.sphere ? mesh.sphere[3] : boundingRadiusOf(mesh)
			const lx = mesh.sphere ? mesh.sphere[0] : 0
			const ly = mesh.sphere ? mesh.sphere[1] : 0
			const lz = mesh.sphere ? mesh.sphere[2] : 0
			const lodCount = mesh.lods?.length ?? 1
			const localR2 = localR * localR
			const lodK2 = localR2 * scale2
			const shadowCasting = item.castsShadow && opacity >= 1 && shadowR > 0
			const skinnedItem = mesh.stride === STRIDE_SKINNED
			const shadowLast = lodCount - 1

			let nearest = Infinity
			let importance = 0
			mainCounts.fill(0)
			shadowCounts.fill(0)
			this.shadowCascadeCountScratch.fill(0)
			this.preparePreviousBones(motionIds, bases, boneCount, n)
			// Sticky LOD memory: allocated on first sight or when the live count outgrows
			// it, then reused every frame. The tail past a shrunken count is invalidated so
			// a node shrinking its array never resumes on a departed actor's held level.
			let heldMain = this.heldMainLod.get(item)
			if (heldMain === undefined || heldMain.length < n) {
				const grown = new Uint8Array(n)
				if (heldMain !== undefined) grown.set(heldMain)
				grown.fill(LOD_CULLED, heldMain?.length ?? 0)
				heldMain = grown
				this.heldMainLod.set(item, heldMain)
			} else if (n < heldMain.length) heldMain.fill(LOD_CULLED, n)

			// Shadow-LOD classification, once per item (graphicsTune §2: a tree may be a
			// card in the cascade and a mesh in the camera). Running gear or a world
			// transform that moved since last frame marks an animated caster — everything
			// the player watches articulate — and only static scenery takes the coarser
			// shadow level below. See movedSinceLastFrame for what this can and cannot see.
			const animated = phases !== null || this.movedSinceLastFrame(motionIds, src, n)

			// Caster bounds start empty; the reach test below is what admits a corner.
			let sbMinX = Infinity, sbMinY = Infinity, sbMinZ = Infinity
			let sbMaxX = -Infinity, sbMaxY = -Infinity, sbMaxZ = -Infinity
			const step = n >= 512 ? this.sceneryStep : 1
			for (let i = 0; i < n; i++) {
				if (step > 1 && (i % step) !== 0) {
					mainBySource[i] = LOD_CULLED
					shadowBySource[i] = LOD_CULLED
					continue
				}
				const o = i * 16
				// consumer below compares r against something it can compare squared.
				const cx = src[o] * lx + src[o + 4] * ly + src[o + 8] * lz + src[o + 12]
				const cy = src[o + 1] * lx + src[o + 5] * ly + src[o + 9] * lz + src[o + 13]
				const cz = src[o + 2] * lx + src[o + 6] * ly + src[o + 10] * lz + src[o + 14]
				const a0 = src[o], a1 = src[o + 1], a2 = src[o + 2]
				const b0 = src[o + 4], b1 = src[o + 5], b2 = src[o + 6]
				const c0 = src[o + 8], c1 = src[o + 9], c2 = src[o + 10]
				const m0 = a0 * a0 + a1 * a1 + a2 * a2
				const m1 = b0 * b0 + b1 * b1 + b2 * b2
				const m2 = c0 * c0 + c1 * c1 + c2 * c2
				const column = m0 > m1 ? (m1 > m2 ? m1 : m2) : (m0 > m2 ? m0 : m2)
				const r2 = localR2 * column
				const dx = cx - camX
				const dy = cy - camY
				const dz = cz - camZ
				const d2 = dx * dx + dy * dy + dz * dz
				const dc2 = d2 > 1e-6 ? d2 : 1e-6

				// Inlined selectMainLod, squared. lhs = radiusPx^2 * dc2, so every threshold
				// test is a multiply on the camera distance instead of a divide by it; the
				// hysteresis branches keep the exact band structure of the linear form.
				let mainLod = 0
				if (lodCount > 1) {
					const lhs = lodK2 * column
					let want: number
					if (lhs >= LOD0_MIN_PX2 * dc2) want = 0
					else if (lodCount <= 2 || lhs >= LOD1_MIN_PX2 * dc2) want = 1
					else want = 2
					const held = heldMain[i]
					if (held < lodCount && held !== want) {
						if (want < held) {
							// Gain detail only comfortably PAST the boundary being crossed.
							if (want === 0) { if (lhs < LOD_GAIN0_PX2 * dc2) want = held }
							else if (lhs < LOD_GAIN1_PX2 * dc2) want = held
						} else {
							// Lose detail only comfortably BELOW the boundary being left.
							if (held === 0) { if (lhs >= LOD_LOSE0_PX2 * dc2) want = held }
							else if (lhs >= LOD_LOSE1_PX2 * dc2) want = held
						}
					}
					mainLod = want
				}
				// Remembered even when frustum-culled: the shadow LOD below derives from
				// this byte, and a culled instance must not freeze at a stale level.
				heldMain[i] = mainLod
				// Five-plane frustum test against r^2: s < -r iff s < 0 and s^2 > r^2, and
				// most instances clear every plane with a positive dot, so the common path
				let visible = true
				let s = p0 * cx + p1 * cy + p2 * cz + p3
				if (s < 0 && s * s > r2) visible = false
				else {
					s = p4 * cx + p5 * cy + p6 * cz + p7
					if (s < 0 && s * s > r2) visible = false
					else {
						s = p8 * cx + p9 * cy + p10 * cz + p11
						if (s < 0 && s * s > r2) visible = false
						else {
							s = p12 * cx + p13 * cy + p14 * cz + p15
							if (s < 0 && s * s > r2) visible = false
							else {
								s = p16 * cx + p17 * cy + p18 * cz + p19
								if (s < 0 && s * s > r2) visible = false
							}
						}
					}
				}
				if (visible) {
					mainBySource[i] = mainLod
					mainCounts[mainLod]++
					if (d2 < nearest) nearest = d2
					importance += r2 / (d2 > 1 ? d2 : 1)
				} else mainBySource[i] = LOD_CULLED

				if (shadowCasting) {
					// The reach test needs r itself, so the one sqrt on this path sits
					// behind the caster branch: the meadow never pays it.
					const r = localR * Math.sqrt(column)
					const sx = cx - shadowCx
					const sy = cy - shadowCy
					const sz = cz - shadowCz
					const reach = shadowR + r
					if (sx * sx + sy * sy + sz * sz <= reach * reach) {
						// Shadow depth is sampled, never depth-equal compared, so a cascade
						// may rasterise a coarser level than the camera pass without
						// breaking any invariant. Animated casters keep the camera's level
						// (floored at 1, as ever): a deploying yard or a driving tank needs
						// a shadow that tracks what the player is watching. Static scenery —
						// trees, buildings, ore — casts one level down: its silhouette never
						// animates beyond wind sway, and the cascade sphere bills every
						// caster at every zoom, so scenery at the camera's own level is the
						// term that pinned the shadow charge to the budget ceiling. At
						// mainLod 0 the two branches agree (LOD1), so nothing the camera is
						// close to changes at all.
						const shadowLod = animated
							? Math.min(shadowLast, Math.max(1, mainLod))
							: Math.min(shadowLast, mainLod + 1)
						shadowBySource[i] = shadowLod
						if (skinnedItem) {
							// One band for the body. A neighbour only near a split, so the
							// army is not skinned into all four maps.
							const viewZ = -(viewZ0 * cx + viewZ1 * cy + viewZ2 * cz + viewZ3)
							const mask = this.skinnedCascadeMask(viewZ, Math.max(20, r * 4))
							this.shadowCascadeMaskBySource[i] = mask
							for (let c = 0; c < this.liveCascades; c++) {
								if ((mask & (1 << c)) !== 0) this.shadowCascadeCountScratch[shadowLod * 4 + c]++
							}
						} else shadowCounts[shadowLod]++
						if (cx - r < sbMinX) sbMinX = cx - r
						if (cy - r < sbMinY) sbMinY = cy - r
						if (cz - r < sbMinZ) sbMinZ = cz - r
						if (cx + r > sbMaxX) sbMaxX = cx + r
						if (cy + r > sbMaxY) sbMaxY = cy + r
						if (cz + r > sbMaxZ) sbMaxZ = cz + r
					} else shadowBySource[i] = LOD_CULLED
				} else shadowBySource[i] = LOD_CULLED
			}
			this.itemDepth[it] = nearest === Infinity ? 0 : Math.sqrt(nearest)
			const sb = it * 6
			this.itemShadowBounds[sb] = sbMinX
			this.itemShadowBounds[sb + 1] = sbMinY
			this.itemShadowBounds[sb + 2] = sbMinZ
			this.itemShadowBounds[sb + 3] = sbMaxX
			this.itemShadowBounds[sb + 4] = sbMaxY
			this.itemShadowBounds[sb + 5] = sbMaxZ
			this.itemImportance[it] = importance

			const itemLod = it * LOD_LEVELS
			for (let level = 0; level < LOD_LEVELS; level++) {
				const slot = itemLod + level
				this.itemMainBase[slot] = cursor
				const mainAllowed = Math.min(mainCounts[level], this.maxInstances - cursor)
				overflow += mainCounts[level] - mainAllowed
				this.itemMainCount[slot] = mainAllowed
				cursor += mainAllowed
			}
			for (let level = 0; level < LOD_LEVELS; level++) {
				const slot = itemLod + level
				if (skinnedItem) {
					let sum = 0
					for (let c = 0; c < 4; c++) {
						const packed = slot * 4 + c
						const allowed = c < this.liveCascades
							? Math.min(this.shadowCascadeCountScratch[level * 4 + c], this.maxInstances - cursor)
							: 0
						if (c < this.liveCascades) overflow += this.shadowCascadeCountScratch[level * 4 + c] - allowed
						this.itemShadowCascadeBase[packed] = cursor
						this.itemShadowCascadeCount[packed] = allowed
						sum += allowed
						cursor += allowed
					}
					this.itemShadowCount[slot] = sum
					this.itemShadowBase[slot] = 0
				} else {
					this.itemShadowBase[slot] = cursor
					const shadowAllowed = Math.min(shadowCounts[level], this.maxInstances - cursor)
					overflow += shadowCounts[level] - shadowAllowed
					this.itemShadowCount[slot] = shadowAllowed
					cursor += shadowAllowed
					const packed = slot * 4
					this.itemShadowCascadeCount[packed] = 0
					this.itemShadowCascadeCount[packed + 1] = 0
					this.itemShadowCascadeCount[packed + 2] = 0
					this.itemShadowCascadeCount[packed + 3] = 0
				}
			}

			mainWrites.fill(0)
			shadowWrites.fill(0)
			this.shadowCascadeWriteScratch.fill(0)
			for (let i = 0; i < n; i++) {
				const mainLod = mainBySource[i]
				if (mainLod !== LOD_CULLED) {
					const slot = itemLod + mainLod
					const written = mainWrites[mainLod]
					if (written < this.itemMainCount[slot]) {
						this.writeInstance(
							data, previousData, this.itemMainBase[slot] + written, src, i * 16,
							colors, emitter, unlit, i, layerCount, bases, phases, damages, opacity, motionIds, boneCount,
						)
						mainWrites[mainLod]++
					}
				}
				const shadowLod = shadowBySource[i]
				if (shadowLod !== LOD_CULLED) {
					if (skinnedItem) {
						const mask = this.shadowCascadeMaskBySource[i]
						for (let c = 0; c < this.liveCascades; c++) {
							if ((mask & (1 << c)) === 0) continue
							const scratch = shadowLod * 4 + c
							const written = this.shadowCascadeWriteScratch[scratch]
							const packed = (itemLod + shadowLod) * 4 + c
							if (written < this.itemShadowCascadeCount[packed]) {
								this.writeInstance(
									data, previousData, this.itemShadowCascadeBase[packed] + written, src, i * 16,
									colors, emitter, unlit, i, layerCount, bases, phases, damages, opacity, motionIds, boneCount,
								)
								this.shadowCascadeWriteScratch[scratch] = written + 1
							}
						}
					} else {
						const slot = itemLod + shadowLod
						const written = shadowWrites[shadowLod]
						if (written < this.itemShadowCount[slot]) {
							this.writeInstance(
								data, previousData, this.itemShadowBase[slot] + written, src, i * 16,
								colors, emitter, unlit, i, layerCount, bases, phases, damages, opacity, motionIds, boneCount,
							)
							shadowWrites[shadowLod]++
						}
					}
				}
			}
			if (mesh.lods !== undefined) {
				for (let level = 0; level < LOD_LEVELS; level++) {
					this.lodStats.mainInstances[level] += this.itemMainCount[itemLod + level]
					this.lodStats.shadowInstances[level] += this.itemShadowCount[itemLod + level]
				}
			}
		}

		this.instanceCount = cursor
		this.stats.instancesDropped = overflow
		if (overflow > 0 && !this.warnedInstanceOverflow) {
			this.warnedInstanceOverflow = true
			console.warn(`[render] instance buffer full (${this.maxInstances}): ${overflow} instances dropped this frame`)
		}
		if (cursor > 0)
			this.device.queue.writeBuffer(this.instanceBuffer, 0, data.buffer, data.byteOffset, cursor * INSTANCE_BYTES)
		if (cursor > 0)
			this.device.queue.writeBuffer(
				this.previousInstanceBuffer, 0,
				previousData.buffer, previousData.byteOffset, cursor * INSTANCE_BYTES,
			)
		// The palette goes up with the instances, in one write, for the same reason: both are
		// per-frame and a second upload point is a second place for them to disagree about
		// which frame they describe.
		if (this.boneCount > 1) {
			this.device.queue.writeBuffer(
				this.boneBuffer, 0, this.boneData.buffer, this.boneData.byteOffset, this.boneCount * 64,
			)
			this.device.queue.writeBuffer(
				this.previousBoneBuffer, 0,
				this.previousBoneData.buffer, this.previousBoneData.byteOffset, this.boneCount * 64,
			)
		}
	}

	private writeInstance(
		data: Float32Array,
		previousData: Float32Array,
		slot: number,
		src: Float32Array,
		srcOffset: number,
		colors: Uint8Array | null,
		emitter: Float32Array | null,
		unlit: Float32Array | null,
		instanceIndex: number,
		layerCount: number,
		paletteBases: Uint16Array | null,
		phases: Float32Array | null,
		damages: Float32Array | null,
		opacity: number,
		motionIds: Uint32Array | null,
		boneCount: number,
	): void {
		const d = slot * INSTANCE_FLOATS
		// Both staging buffers are written in ONE interleaved pass. The old shape wrote
		// data, then copied all 24 floats to previousData, then overwrote the model row for
		// fresh motion — three trips over memory per instance, thirty thousand times a
		// frame for the meadow alone. Computing each value once and storing it twice halves
		// the loads and keeps the buffers byte-identical where nothing is temporal.
		for (let k = 0; k < 16; k++) {
			const v = src[srcOffset + k]
			data[d + k] = v
			previousData[d + k] = v
		}
		let t0: number, t1: number, t2: number, t3: number
		if (colors && instanceIndex < colors.length && colors[instanceIndex] < this.playerColorCount) {
			const c = colors[instanceIndex] * 4
			t0 = this.playerColorTable[c]
			t1 = this.playerColorTable[c + 1]
			t2 = this.playerColorTable[c + 2]
			t3 = this.playerColorTable[c + 3]
		} else if (unlit !== null && unlit.length >= 3) {
			// Ground UI tint: distinct from both player repaint (alpha >= 0) and emitters (-1).
			t0 = unlit[0]; t1 = unlit[1]; t2 = unlit[2]; t3 = -2
		} else if (emitter !== null && emitter.length >= 3) {
			// The tint channel carrying an EMITTER rather than a repaint. Alpha -1 is the marker
			// and it is unreachable any other way: the player table stores byte/255 and the
			// unowned branch below writes 0, so nothing that shipped before can present it.
			// Checked after player colour so an owned actor can never lose its livery to this.
			t0 = emitter[0]
			t1 = emitter[1]
			t2 = emitter[2]
			t3 = -1
		} else {
			t0 = 1
			t1 = 1
			t2 = 1
			// Alpha 0 disables the repaint entirely, so unowned geometry keeps its texture.
			t3 = 0
		}
		data[d + 16] = t0; data[d + 17] = t1; data[d + 18] = t2; data[d + 19] = t3
		previousData[d + 16] = t0; previousData[d + 17] = t1; previousData[d + 18] = t2; previousData[d + 19] = t3
		data[d + 20] = layerCount
		previousData[d + 20] = layerCount
		// The three reserved scalars. Written here and nowhere else — see the pin above.
		//
		// paletteBases is indexed by SOURCE instance, not by packed slot: an actor culled from
		// the camera region but kept as a shadow caster sits at different slots in the two
		// regions, and a channel keyed by slot would give it another actor's bones in one pass
		// and its own in the other — a figure whose shadow walks differently from the figure.
		const paletteBase = paletteBases !== null && instanceIndex < paletteBases.length ? paletteBases[instanceIndex] : 0
		const phase = phases !== null && instanceIndex < phases.length ? phases[instanceIndex] : 0
		const damage = packDamageOpacity(
			damages !== null && instanceIndex < damages.length ? damages[instanceIndex] : 0, opacity)
		data[d + INSTANCE_PALETTE_OFFSET] = paletteBase
		data[d + INSTANCE_PHASE] = phase
		data[d + INSTANCE_DAMAGE] = damage
		previousData[d + INSTANCE_PALETTE_OFFSET] = paletteBase
		previousData[d + INSTANCE_PHASE] = phase
		previousData[d + INSTANCE_DAMAGE] = damage

		// Only geometry inputs — model and palette base — are temporal; the motion history
		// supplies the previous pose for anything that actually moved.
		const id = motionIds !== null && instanceIndex < motionIds.length ? motionIds[instanceIndex] : -1
		const state = id >= 0 ? this.motionHistory.get(id) : undefined
		const fresh = !this.motiongateZeroObjectVelocity && state?.frame === this.frameIndex - 1
		if (fresh) {
			for (let k = 0; k < 16; k++) previousData[d + k] = state.model[k]
			// A rig entering from last frame's bind pose must keep paletteBase zero for the
			// previous sample; pointing it at current bones would erase the first real motion.
			if (paletteBase > 0 && state.bones.length !== boneCount * 16)
				previousData[d + INSTANCE_PALETTE_OFFSET] = 0
		}
	}

	/**
	 * Rule 9: never exceed a budget, degrade gracefully. Items are admitted in descending
	 * screen-coverage order until the draw-call or triangle budget would be crossed, and a
	 * rejected item does not stop the scan — a 200k-triangle terrain patch must not lock
	 * out the forty small items that would still have fitted behind it.
	 *
	 * Two passes, and a hysteresis term. Both exist because this function was the flicker.
	 *
	 * SHADOWS ARE CHARGED SECOND, NOT ALONGSIDE. The shadow caster set is the cascade
	 * sphere, not the camera frustum, and every caster is rasterised once per cascade. So
	 * the shadow term is nearly independent of zoom while the visible term is not: measured
	 * on Jungle Law with the whole map revealed, the shadow charge is 56.3M triangles at
	 * EVERY zoom against a 12M budget, while the geometry the camera can actually see runs
	 * 0.6M zoomed in to 15.9M zoomed all the way out. Charged together, that one term
	 * evicted whole draw items — 0.3 per frame zoomed in, 36 per frame zoomed out, up to 83
	 * in a single frame — and which items it evicted moved with the camera, because the
	 * admission is a greedy knapsack over an importance order that changes continuously.
	 * The result is a house or a tank present in one frame, gone in the next and back in the
	 * one after: measured 55 single-frame dropouts across 17 of 41 frames at maximum
	 * zoom-out, scaling monotonically with zoom, which is exactly the report. None of it was
	 * visible to `stats.dropped`, which counts only submit()-time rejections and read zero
	 * throughout.
	 *
	 * A missing shadow is a smaller lie than a missing object, and unlike a missing object
	 * it does not blink. So pass one spends the budget on what the camera can see, and pass
	 * two spends whatever is left on shadows, in the same order. An item that cannot afford
	 * its shadow keeps its geometry and loses the shadow.
	 *
	 * HYSTERESIS. Even with the geometry alone over budget, a strict greedy dithers at the
	 * boundary: one frame a large item fits and three small ones fall out, the next frame
	 * the reverse. An item drawn in the previous frame is therefore ranked as if slightly
	 * more important, so crossing the boundary costs more than a rounding error in screen
	 * coverage. It is a bias on the order, not a reservation, so a genuinely more important
	 * newcomer still displaces it and nothing can be starved indefinitely.
	 */
	private applyBudget(ctx: Ctx): void {
		const q = ctx.config.q
		this.budgetDrawCalls = q.drawCalls
		this.budgetTriangles = q.triangles
		const cascades = this.liveCascades

		for (let i = 0; i < this.itemCount; i++) {
			this.itemIncluded[i] = 0
			const item = this.items[i]
			// The DrawItem objects are owned and reused by their submitting node, so object
			// identity is stable across frames and is the only item identity there is.
			const held = item === null ? 0 : this.lastIncluded.get(item) ?? 0
			const sticky = held === this.frameIndex - 1 ? INCLUSION_HYSTERESIS : 1
			this.keys[i] = packKey(quantise(this.itemImportance[i] * sticky, 4096, 20), i)
		}
		sortKeys(this.keys, this.keyScratch, this.itemCount)

		let draws = 0
		let tris = 0
		// Pass one — everything the camera can see, charged for the prepass and the forward
		// pass only. The item's shadow is not priced here and cannot evict it.
		for (let k = this.itemCount - 1; k >= 0; k--) {
			const it = unpackIndex(this.keys[k])
			const item = this.items[it]
			if (!item) continue
			const translucent = itemOpacity(item) < 1
			const mesh = item.mesh as GpuMeshHandle
			const itemLod = it * LOD_LEVELS
			const mainPasses = translucent ? 1 : 2
			let main = 0
			let mainDraws = 0
			let mainTris = 0
			for (let level = 0; level < LOD_LEVELS; level++) {
				const mainCount = this.itemMainCount[itemLod + level]
				if (mainCount <= 0) continue
				main += mainCount
				mainDraws++
				mainTris += (meshLod(mesh, level).indexCount / 3) * mainCount * mainPasses
			}
			if (main <= 0) continue
			const itemDraws = mainDraws * mainPasses
			if (draws + itemDraws > this.budgetDrawCalls) continue
			if (tris + mainTris > this.budgetTriangles) continue
			draws += itemDraws
			tris += mainTris
			this.itemIncluded[it] = 1
			this.lastIncluded.set(item, this.frameIndex)
		}
		// Pass two — shadows, out of what is left, in the same order. Zeroing the level's
		// shadow count is what removes it: `buildOrders` keys the shadow pass off exactly
		// this array, and the packed instances it leaves behind are simply never referenced.
		for (let k = this.itemCount - 1; k >= 0; k--) {
			const it = unpackIndex(this.keys[k])
			const item = this.items[it]
			if (!item) continue
			const itemLod = it * LOD_LEVELS
			if (this.itemLodTotal(this.itemShadowCount, it) <= 0) continue
			const mesh = item.mesh as GpuMeshHandle
			const skinned = mesh.stride === STRIDE_SKINNED
			let shadowDraws = 0
			let shadowTris = 0
			for (let level = 0; level < LOD_LEVELS; level++) {
				const meshLevel = meshLod(mesh, level)
				if (skinned) {
					for (let c = 0; c < cascades; c++) {
						const shadowCount = this.itemShadowCascadeCount[(itemLod + level) * 4 + c]
						if (shadowCount <= 0) continue
						shadowDraws++
						shadowTris += (meshLevel.indexCount / 3) * shadowCount
					}
				} else {
					const shadowCount = this.itemShadowCount[itemLod + level]
					if (shadowCount <= 0) continue
					shadowDraws++
					shadowTris += (meshLevel.indexCount / 3) * shadowCount * cascades
				}
			}
			// A shadow cast by an object that was not drawn is the defect this exists to
			// remove, so an item excluded above casts nothing either. Skinned draws are
			// already one per cascade; static draws are still one level times every cascade.
			const drawCharge = skinned ? shadowDraws : shadowDraws * cascades
			const affordable = this.itemIncluded[it] !== 0 &&
				draws + drawCharge <= this.budgetDrawCalls &&
				tris + shadowTris <= this.budgetTriangles
			if (affordable) {
				draws += drawCharge
				tris += shadowTris
				continue
			}
			for (let level = 0; level < LOD_LEVELS; level++) {
				const slot = itemLod + level
				if (mesh.lods !== undefined) this.lodStats.shadowInstances[level] -= this.itemShadowCount[slot]
				this.itemShadowCount[slot] = 0
				const packed = slot * 4
				this.itemShadowCascadeCount[packed] = 0
				this.itemShadowCascadeCount[packed + 1] = 0
				this.itemShadowCascadeCount[packed + 2] = 0
				this.itemShadowCascadeCount[packed + 3] = 0
			}
		}
	}

	/**
	 * Three orders, three reasons. The prepass goes front-to-back so early-Z rejects as
	 * much as possible. The forward pass goes by pipeline then material so the encoder
	 * changes state as rarely as the frame allows. The shadow pass goes by pipeline only —
	 * it binds no material at all.
	 */
	private buildOrders(): void {
		this.prepassCount = 0
		for (let it = 0; it < this.itemCount; it++) {
			if (!this.itemIncluded[it] || this.itemLodTotal(this.itemMainCount, it) <= 0) continue
			if (itemOpacity(this.items[it]!) < 1) continue
			const key = quantise(this.itemDepth[it], DEPTH_QUANT_SCALE, DEPTH_QUANT_BITS)
			this.keys[this.prepassCount++] = packKey(key, it)
		}
		sortKeys(this.keys, this.keyScratch, this.prepassCount)
		for (let i = 0; i < this.prepassCount; i++) this.orderPrepass[i] = unpackIndex(this.keys[i])

		this.mainCount = 0
		for (let it = 0; it < this.itemCount; it++) {
			if (!this.itemIncluded[it] || this.itemLodTotal(this.itemMainCount, it) <= 0) continue
			if (itemOpacity(this.items[it]!) < 1) continue
			const mesh = this.items[it]!.mesh as GpuMeshHandle
			// Pipeline variant in the high bit, material slot below it: one sort produces
			// the grouping both setPipeline and setBindGroup want.
			const key = (mesh.stride === STRIDE_SKINNED ? 1 : 0) * 4096 + this.itemMatSlot[it]
			this.keys[this.mainCount++] = packKey(key, it)
		}
		sortKeys(this.keys, this.keyScratch, this.mainCount)
		for (let i = 0; i < this.mainCount; i++) this.orderMain[i] = unpackIndex(this.keys[i])

		this.translucentCount = 0
		for (let it = 0; it < this.itemCount; it++) {
			if (!this.itemIncluded[it] || this.itemLodTotal(this.itemMainCount, it) <= 0) continue
			if (itemOpacity(this.items[it]!) >= 1) continue
			const key = quantise(this.itemDepth[it], DEPTH_QUANT_SCALE, DEPTH_QUANT_BITS)
			this.keys[this.translucentCount++] = packKey(key, it)
		}
		sortKeys(this.keys, this.keyScratch, this.translucentCount)
		// Alpha composition is back-to-front. Placement currently submits one ghost, but the
		// order remains correct if variants or cooperative previews add another later.
		for (let i = 0; i < this.translucentCount; i++)
			this.orderTranslucent[i] = unpackIndex(this.keys[this.translucentCount - 1 - i])

		this.shadowCount = 0
		for (let it = 0; it < this.itemCount; it++) {
			if (!this.itemIncluded[it] || this.itemLodTotal(this.itemShadowCount, it) <= 0) continue
			if (itemOpacity(this.items[it]!) < 1) continue
			const mesh = this.items[it]!.mesh as GpuMeshHandle
			this.keys[this.shadowCount++] = packKey(mesh.stride === STRIDE_SKINNED ? 1 : 0, it)
		}
		sortKeys(this.keys, this.keyScratch, this.shadowCount)
		for (let i = 0; i < this.shadowCount; i++) this.orderShadow[i] = unpackIndex(this.keys[i])
	}

	// -----------------------------------------------------------------------
	// Encoding
	// -----------------------------------------------------------------------

	private encodeFrame(): void {
		const encoder = this.device.createCommandEncoder(this.frameEncoderDesc)
		this.gpuTimer?.wrap(encoder)
		this.encodeShadowPasses(encoder)
		this.encodeDepthPrepass(encoder)
		this.encodeComputePasses(encoder)
		this.encodeForwardPass(encoder)
		this.stats.drawCalls += this.atmosphere.encode(encoder, this.targets.colorView, this.camera.position)
		this.stats.triangles += this.atmosphere.stats.particles * 2 + this.atmosphere.stats.fogDraws

		const dest = this.targets.historyIndex
		this.postChain.encodeTaa(encoder, this.targets.currentHistoryView, dest)
		this.postChain.encodeBloom(encoder, dest)

		const compute = encoder.beginComputePass(this.exposurePassDesc)
		this.postChain.encodeExposure(compute, dest)
		compute.end()

		const swapView = this.context.getCurrentTexture().createView()
		const heat = this.heat.pack(this.camera.viewProj, this.targets.width, this.targets.height, performance.now() / 1000, this.heatPacked)
		this.postChain.writeHeat(this.heatPacked, heat)
		this.stats.heatSources = heat
		this.postChain.encodePost(encoder, swapView, dest)

		this.gpuTimer?.resolve(encoder)
		// Reused one-element array rather than a fresh `[encoder.finish()]` literal.
		this.submitScratch[0] = encoder.finish()
		this.device.queue.submit(this.submitScratch)
		this.gpuTimer?.afterSubmit()
		this.targets.flipHistory()
		this.historyValid = true
	}

	private encodeShadowPasses(encoder: GPUCommandEncoder, warm = false): void {
		this.refreshShadowCascadePlanes()
		const planes = this.shadowCascadePlanes
		for (let c = 0; c < this.liveCascades; c++) {
			// Preallocated per cascade (§7 caps cascades at 4). Only the depth view changes,
			// and the per-cascade label is kept because it is what identified the pass in the
			// validation error that turned out to be t1-render-6.
			const desc = this.shadowPassDescs[c]
			;(desc.depthStencilAttachment as GPURenderPassDepthStencilAttachment).view = this.shadows.layerViews[c]
			const pass = encoder.beginRenderPass(desc)
			// The cascade matrix is the only thing that varies between these passes, and it
			// varies by dynamic offset, so both bind groups are set once for the whole pass.
			// Reused offset array: `[this.shadows.uniformOffset(c)]` allocated once per cascade
			// per frame.
			this.dynOffset[0] = this.shadows.uniformOffset(c)
			pass.setBindGroup(0, this.shadows.bindGroup, this.dynOffset)
			pass.setBindGroup(1, this.drawBindGroup)
			if (warm && c === 0) {
				const material = this.warmMaterial()
				this.drawWarm(pass, this.shadows.pipelineStatic, STRIDE_STATIC, null, 2)
				this.drawWarm(pass, this.shadows.pipelineSkinned, STRIDE_SKINNED, null, 2)
				this.drawWarm(pass, this.shadows.pipelineTerrain, TERRAIN_STRIDE, null, 2)
				this.drawWarm(pass, this.shadows.pipelineCutoutStatic, STRIDE_STATIC, material, 2)
				this.drawWarm(pass, this.shadows.pipelineCutoutSkinned, STRIDE_SKINNED, material, 2)
			}
			// Planes were refreshed once for the frame. x/y in [-1, 1], the reverse-Z
			// depth slab in [0, 1]. An item whose caster AABB sits fully outside any
			// plane clips entirely, so the cascade skips it.
			const po = c * 24
			const bounds = this.itemShadowBounds
			let boundPipeline: GPURenderPipeline | null = null
			let boundVertex: GPUBuffer | null = null
			// The index buffer is tracked SEPARATELY from the vertex buffer, and that is not
			// redundant. Meshes may share a vertex buffer while owning distinct index
			// buffers — terrain does exactly this, uploading one vertex buffer per chunk and
			// splitting it into a per-surface index set each. Binding the index buffer only
			// when the vertex buffer changed left every submesh after the first drawing its
			// own indexCount against its predecessor's index buffer, which is a
			// validation error at encoder.finish(). That kills the WHOLE command buffer, so the entire
			// frame — shadows, prepass, forward, TAA, post — was silently discarded and the
			// canvas stayed at its clear value. Counters read normally because they are
			// incremented at record time.
			let boundIndex: GPUBuffer | null = null
			for (let i = 0; i < this.shadowCount; i++) {
				const it = this.orderShadow[i]
				const item = this.items[it]!
				// Per-cascade cull: the positive-vertex test against all six planes.
				const sb = it * 6
				const minX = bounds[sb], minY = bounds[sb + 1], minZ = bounds[sb + 2]
				const maxX = bounds[sb + 3], maxY = bounds[sb + 4], maxZ = bounds[sb + 5]
				let culled = false
				for (let p = 0; p < 6; p++) {
					const q = po + p * 4
					const a = planes[q]
					const b2 = planes[q + 1]
					const c2 = planes[q + 2]
					if (a * (a >= 0 ? maxX : minX) + b2 * (b2 >= 0 ? maxY : minY) +
						c2 * (c2 >= 0 ? maxZ : minZ) + planes[q + 3] < 0) {
						culled = true
						break
					}
				}
				if (culled) continue
				if (item.alphaCutout) pass.setBindGroup(2, this.materialBindGroups[this.itemMatSlot[it]])
				const baseMesh = item.mesh as GpuMeshHandle
				const skinned = baseMesh.stride === STRIDE_SKINNED
				const itemLod = it * LOD_LEVELS
				for (let level = 0; level < LOD_LEVELS; level++) {
					const cascadeSlot = (itemLod + level) * 4 + c
					const count = skinned ? this.itemShadowCascadeCount[cascadeSlot] : this.itemShadowCount[itemLod + level]
					if (count <= 0) continue
					const firstInstance = skinned ? this.itemShadowCascadeBase[cascadeSlot] : this.itemShadowBase[itemLod + level]
					const mesh = meshLod(baseMesh, level)
					const pipeline = item.alphaCutout
						? mesh.stride === STRIDE_SKINNED ? this.shadows.pipelineCutoutSkinned : this.shadows.pipelineCutoutStatic
						: mesh.stride === TERRAIN_STRIDE ? this.shadows.pipelineTerrain
						: mesh.stride === STRIDE_SKINNED ? this.shadows.pipelineSkinned : this.shadows.pipelineStatic
					if (pipeline !== boundPipeline) {
						pass.setPipeline(pipeline)
						boundPipeline = pipeline
					}
					if (mesh.vertexBuffer !== boundVertex) {
						pass.setVertexBuffer(0, mesh.vertexBuffer)
						boundVertex = mesh.vertexBuffer
					}
					if (mesh.indexBuffer !== boundIndex) {
						pass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat)
						boundIndex = mesh.indexBuffer
					}
					pass.drawIndexed(mesh.indexCount, count, 0, 0, firstInstance)
					this.stats.drawCalls++
					this.stats.triangles += (mesh.indexCount / 3) * count
				}
			}
			pass.end()
		}
	}

	private encodeDepthPrepass(encoder: GPUCommandEncoder, warm = false): void {
		// Preallocated; only the attachment views can change, and only on resize.
		this.prepassVelocityAttachment.view = this.targets.velocityView
		;(this.prepassDesc.colorAttachments as GPURenderPassColorAttachment[])[1].view = this.targets.reflectionView
		;(this.prepassDesc.depthStencilAttachment as GPURenderPassDepthStencilAttachment).view = this.targets.depthView
		const pass = encoder.beginRenderPass(this.prepassDesc)
		if (this.frameBindGroup) pass.setBindGroup(0, this.frameBindGroup)
		pass.setBindGroup(1, this.drawBindGroup)
		if (warm) {
			const material = this.warmMaterial()
			this.drawWarm(pass, this.prepassStatic, STRIDE_STATIC, null, 2)
			this.drawWarm(pass, this.prepassSkinned, STRIDE_SKINNED, null, 2)
			this.drawWarm(pass, this.prepassTerrain, TERRAIN_STRIDE, null, 2)
			this.drawWarm(pass, this.prepassCutoutStatic, STRIDE_STATIC, material, 2)
			this.drawWarm(pass, this.prepassCutoutSkinned, STRIDE_SKINNED, material, 2)
			this.drawWarm(pass, this.prepassReactive, STRIDE_STATIC, null, 2)
		}
		let boundPipeline: GPURenderPipeline | null = null
		let boundVertex: GPUBuffer | null = null
		// Tracked separately from the vertex buffer — see encodeShadowPasses.
		let boundIndex: GPUBuffer | null = null
		for (let i = 0; i < this.prepassCount; i++) {
			const it = this.orderPrepass[i]
			const cutout = this.items[it]!.alphaCutout === true
			if (cutout) pass.setBindGroup(2, this.materialBindGroups[this.itemMatSlot[it]])
			const baseMesh = this.items[it]!.mesh as GpuMeshHandle
			const itemLod = it * LOD_LEVELS
			for (let level = 0; level < LOD_LEVELS; level++) {
				const count = this.itemMainCount[itemLod + level]
				if (count <= 0) continue
				const mesh = meshLod(baseMesh, level)
				const pipeline = cutout
					? mesh.stride === STRIDE_SKINNED ? this.prepassCutoutSkinned : this.prepassCutoutStatic
					: mesh.stride === TERRAIN_STRIDE ? this.prepassTerrain
					: mesh.stride === STRIDE_SKINNED ? this.prepassSkinned : this.prepassStatic
				if (pipeline !== boundPipeline) {
					pass.setPipeline(pipeline)
					boundPipeline = pipeline
				}
				if (mesh.vertexBuffer !== boundVertex) {
					pass.setVertexBuffer(0, mesh.vertexBuffer)
					boundVertex = mesh.vertexBuffer
				}
				if (mesh.indexBuffer !== boundIndex) {
					pass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat)
					boundIndex = mesh.indexBuffer
				}
				pass.drawIndexed(mesh.indexCount, count, 0, 0, this.itemMainBase[itemLod + level])
				this.stats.drawCalls++
				this.stats.triangles += (mesh.indexCount / 3) * count
			}
		}
		// Rain and snow draw late and translucent, but leave the no-motion-vector marker here,
		// after the opaque depth is complete, so TAA does not average a falling drop away.
		for (let i = 0; i < this.translucentCount; i++) {
			const it = this.orderTranslucent[i]
			const item = this.items[it]!
			const baseMesh = item.mesh as GpuMeshHandle
			if (item.reactive !== true || baseMesh.stride !== STRIDE_STATIC) continue
			const itemLod = it * LOD_LEVELS
			for (let level = 0; level < LOD_LEVELS; level++) {
				const count = this.itemMainCount[itemLod + level]
				if (count <= 0) continue
				const mesh = meshLod(baseMesh, level)
				if (this.prepassReactive !== boundPipeline) {
					pass.setPipeline(this.prepassReactive)
					boundPipeline = this.prepassReactive
				}
				if (mesh.vertexBuffer !== boundVertex) {
					pass.setVertexBuffer(0, mesh.vertexBuffer)
					boundVertex = mesh.vertexBuffer
				}
				if (mesh.indexBuffer !== boundIndex) {
					pass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat)
					boundIndex = mesh.indexBuffer
				}
				pass.drawIndexed(mesh.indexCount, count, 0, 0, this.itemMainBase[itemLod + level])
				this.stats.drawCalls++
			}
		}
		pass.end()
	}

	private encodeComputePasses(encoder: GPUCommandEncoder): void {
		const pass = encoder.beginComputePass(this.cullPassDesc)
		this.clusters.encode(pass)
		// The probe refresh reads the cascade depth written above, so it belongs after the
		// shadow passes and can share the cull pass's encoder.
		this.probes.encode(pass)
		pass.end()
	}

	private encodeForwardPass(encoder: GPUCommandEncoder, warm = false): void {
		// Preallocated descriptor; the view and the clear colour are mutated in place.
		//
		// The dome overwrites every background pixel below, so this clear is a fallback and
		// not the sky. It is still set to the real horizon radiance rather than to black:
		// if the dome pipeline is ever unavailable, an empty world reads as daylight rather
		// than as a failed frame (rule 8). It used to be `skyColor * 1.45`, one of three
		// hand-written horizon approximations; the value now comes from sky like the
		// other two.
		const att = this.forwardColorAttachment
		att.view = this.targets.colorView
		const cv = att.clearValue as { r: number; g: number; b: number; a: number }
		cv.r = this.env.horizonColor[0]
		cv.g = this.env.horizonColor[1]
		cv.b = this.env.horizonColor[2]
		;(this.forwardDesc.depthStencilAttachment as GPURenderPassDepthStencilAttachment).view = this.targets.depthView
		const pass = encoder.beginRenderPass(this.forwardDesc)
		if (this.frameBindGroup) pass.setBindGroup(0, this.frameBindGroup)
		pass.setBindGroup(2, this.drawBindGroup)
		if (warm) {
			const material = this.warmMaterial()
			this.drawWarm(pass, this.forwardStatic, STRIDE_STATIC, material, 1)
			this.drawWarm(pass, this.forwardSkinned, STRIDE_SKINNED, material, 1)
			this.drawWarm(pass, this.forwardTerrainOpaque, TERRAIN_STRIDE, material, 1)
			this.drawWarm(pass, this.forwardBlend, TERRAIN_STRIDE, this.atlasBindGroup, 1)
			this.drawWarm(pass, this.forwardCutoutStatic, STRIDE_STATIC, material, 1)
			this.drawWarm(pass, this.forwardCutoutSkinned, STRIDE_SKINNED, material, 1)
			this.drawWarm(pass, this.forwardTranslucentStatic, STRIDE_STATIC, material, 1)
			this.drawWarm(pass, this.forwardTranslucentSkinned, STRIDE_SKINNED, material, 1)
		}
		let boundPipeline: GPURenderPipeline | null = null
		// NOTHING bound yet, and it must not collide with either a real slot (>= 0) or the
		// atlas sentinel (-1). It was -1, which the first blended item read as "already
		// bound" and skipped — the pass then drew with no group 1 at all, which is a
		// validation error at finish() and therefore a black frame, not a missing texture.
		let boundMaterial = MATERIAL_SLOT_NONE
		let boundVertex: GPUBuffer | null = null
		// Tracked separately from the vertex buffer — see encodeShadowPasses.
		let boundIndex: GPUBuffer | null = null
		for (let i = 0; i < this.mainCount; i++) {
			const it = this.orderMain[i]
			const item = this.items[it]!
			const baseMesh = item.mesh as GpuMeshHandle
			// §12.3b ground takes the blended variant, which reads an atlas layer PAIR from
			// the vertex. Falls back to the ordinary pipeline when materials published no
			// atlas — the ground then draws with the pair's first element as a plain layer,
			// which looks wrong but still draws (rule 8).
			const blend = item.blendZones === true && this.forwardBlend !== null && this.atlasBindGroup !== null
			const pipeline = blend
				? this.forwardBlend!
				: baseMesh.stride === TERRAIN_STRIDE
					// Non-blend terrain: f32 TERRAIN layout. Never the quantized unit
					// pipelines - decoding f32 as snorm8/unorm16 is the old breakage.
					? this.forwardTerrainOpaque
				: item.alphaCutout
					? baseMesh.stride === STRIDE_SKINNED ? this.forwardCutoutSkinned : this.forwardCutoutStatic
				: baseMesh.stride === STRIDE_SKINNED
					? this.forwardSkinned
					: this.forwardStatic
			if (pipeline !== boundPipeline) {
				pass.setPipeline(pipeline)
				boundPipeline = pipeline
			}
			// The atlas gets its own sentinel slot so the redundant-bind check keeps working
			// across a run of ground chunks without colliding with a real material slot.
			const slot = blend ? MATERIAL_SLOT_ATLAS : this.itemMatSlot[it]
			if (slot !== boundMaterial) {
				const group = blend ? this.atlasBindGroup! : this.materialBindGroups[slot]
				if (!group) continue
				pass.setBindGroup(1, group)
				boundMaterial = slot
			}
			const itemLod = it * LOD_LEVELS
			for (let level = 0; level < LOD_LEVELS; level++) {
				const count = this.itemMainCount[itemLod + level]
				if (count <= 0) continue
				// Normal path uses exactly the prepass level. depthgate alone biases this lookup
				// to prove that different geometry leaves clear-on-depth pixels even with @invariant.
				const mesh = meshLod(baseMesh, level + this.depthgateForwardLodBias)
				if (mesh.vertexBuffer !== boundVertex) {
					pass.setVertexBuffer(0, mesh.vertexBuffer)
					boundVertex = mesh.vertexBuffer
				}
				if (mesh.indexBuffer !== boundIndex) {
					pass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat)
					boundIndex = mesh.indexBuffer
				}
				pass.drawIndexed(mesh.indexCount, count, 0, 0, this.itemMainBase[itemLod + level])
				this.stats.drawCalls++
				this.stats.triangles += (mesh.indexCount / 3) * count
			}
		}

		// The sky fills untouched depth before presentation ghosts blend over the complete
		// opaque scene. It cannot be last any more: alpha needs a real background to compose.
		if (this.frameBindGroup) {
			pass.setPipeline(this.skyDome)
			pass.draw(3)
			this.stats.drawCalls++
			this.stats.triangles += 1
		}

		if (this.translucentCount > 0) {
			// The sky layout binds only group 0. Rebind the shared draw stream explicitly before
			// returning to the forward layout so no backend has to preserve incompatible groups.
			pass.setBindGroup(2, this.drawBindGroup)
			boundPipeline = null
			boundMaterial = MATERIAL_SLOT_NONE
			boundVertex = null
			boundIndex = null
			for (let i = 0; i < this.translucentCount; i++) {
				const it = this.orderTranslucent[i]
				const item = this.items[it]!
				const baseMesh = item.mesh as GpuMeshHandle
				const pipeline = baseMesh.stride === STRIDE_SKINNED
					? this.forwardTranslucentSkinned
					: this.forwardTranslucentStatic
				if (pipeline !== boundPipeline) {
					pass.setPipeline(pipeline)
					boundPipeline = pipeline
				}
				const slot = this.itemMatSlot[it]
				if (slot !== boundMaterial) {
					const group = this.materialBindGroups[slot]
					if (!group) continue
					pass.setBindGroup(1, group)
					boundMaterial = slot
				}
				const itemLod = it * LOD_LEVELS
				for (let level = 0; level < LOD_LEVELS; level++) {
					const count = this.itemMainCount[itemLod + level]
					if (count <= 0) continue
					const mesh = meshLod(baseMesh, level)
					if (mesh.vertexBuffer !== boundVertex) {
						pass.setVertexBuffer(0, mesh.vertexBuffer)
						boundVertex = mesh.vertexBuffer
					}
					if (mesh.indexBuffer !== boundIndex) {
						pass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat)
						boundIndex = mesh.indexBuffer
					}
					pass.drawIndexed(mesh.indexCount, count, 0, 0, this.itemMainBase[itemLod + level])
					this.stats.drawCalls++
					this.stats.triangles += (mesh.indexCount / 3) * count
				}
			}
		}
		pass.end()
	}

	/** Clears the frame's submission lists AFTER the draw, not before — see update(). */
	private endFrame(): void {
		this.completedBoneCount = this.boneCount
		for (let i = 0; i < this.itemCount; i++) this.items[i] = null
		this.itemCount = 0
		this.droppedItems = 0
		this.lights.reset()
		this.heat.reset()
		this.atmosphere.reset()
		// Back to 1, not 0. Slot 0 is the permanent identity that makes paletteBase 0 mean
		// "unskinned" unambiguously, and it is written once at boot — resetting to 0 here would
		// let the first reservation of the next frame hand out the sentinel as a real bone.
		this.boneCount = 1
	}

	// -----------------------------------------------------------------------
	// Materials
	// -----------------------------------------------------------------------

	/**
	 * Slot for a surface set id, creating the bind group on first sight. Bind groups are
	 * not pipelines, so this does not violate rule 10, and after the first frame that
	 * draws a given surface the lookup is a Map hit and nothing else.
	 */
	private materialSlotFor(id: string): number {
		const existing = this.materialSlots.get(id)
		if (existing !== undefined) return existing
		if (this.materialSlotCount >= MAX_MATERIAL_SLOTS) return -1

		const mats = this.materials
		if (!mats) {
			// Fallback path: slot 0 is the neutral set built in resolveMaterials.
			this.materialSlots.set(id, 0)
			return 0
		}
		let set = mats.has(id) ? mats.get(id) : null
		if (!set) {
			// §12.1 guarantees a set per §8 surface type. Substituting a real one is
			// honest; inventing a bind group for a layout this node does not own is not.
			for (const alt of MATERIAL_FALLBACKS) {
				if (mats.has(alt)) {
					set = mats.get(alt)
					break
				}
			}
		}
		if (!set) return -1

		const slot = this.materialSlotCount++
		this.materialBindGroups[slot] = mats.bindGroupFor(set)
		this.materialLayerCount[slot] = Math.max(1, set.layerCount)
		this.materialSlots.set(id, slot)
		return slot
	}
}

/** Substitutes when a submitted surface set id is missing, most generic last. */
const MATERIAL_FALLBACKS = ['concrete', 'metal', 'rock', 'soil'] as const

/** Sentinel key for the warn-once table; not a real surfaceSet id, so it cannot collide. */
const OVERFLOW_KEY = '#item-table-overflow'

/** Meshes uploaded by an older handle shape have no cached sphere; derive one. */
function boundingRadiusOf(mesh: GpuMesh): number {
	const dx = mesh.aabbMax[0] - mesh.aabbMin[0]
	const dy = mesh.aabbMax[1] - mesh.aabbMin[1]
	const dz = mesh.aabbMax[2] - mesh.aabbMin[2]
	return Math.hypot(dx, dy, dz) * 0.5
}
