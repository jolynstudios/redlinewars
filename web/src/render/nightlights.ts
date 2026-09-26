// STEELSEED — render/nightlights
//
// The runtime consumer for the authored light anchors, and the reason `lightanchorgate`
// has always ended with "Runtime lights not covered."
//
// `art/blender/lighting.py` builds a PHYSICAL fixture for every lamp in the roster — a
// headlamp housing with an off-white lens, a field torch with barrel/bezel/lens/clip, a
// swan-neck yard lamp on a tapered mast with a weatherproof housing — and then exports one
// `ss_light` empty per fixture. 111 of 281 roster assets carry 131 of them, in three kinds:
//
//     headlamp   40   tanks and trucks, 2 each, at the lens face
//     yard       59   one per building, under the fixture, pointing straight down
//     flashlight 32   one per infantry figure, at the torch lens
//     window     N    one per apartment window band; warm interior at night only
//
// Every one of those anchors is bound to bone 0 (the chassis/root) — verified across all
// 131 — so an anchor is a rigid offset in the actor's own local space and needs no bone
// palette lookup. `placeActor` writes an orthonormal, unscaled basis (column 0 forward,
// column 1 up, column 2 lateral), so the world position is one matrix-vector multiply.
//
// WHY THIS LIVES IN `render` RATHER THAN IN `units`.
//
// `units` owns placement; it does NOT own the light budget, and it does not know the camera
// when it places an actor (update order is topological, not chronological — the comment at
// the top of render/lights.ts is about exactly this). By the time `lateUpdate` runs, render
// holds every submitted DrawItem with its final placed matrices AND the real camera, which
// is what a distance-ranked budget needs. The alternative — a second node that re-derives
// actor transforms from the snapshot — would make presentation a second placement authority,
// which is the defect shape this project has already paid for twice.
//
// WHAT THIS IS NOT. There is no spotlight in §12.2: `Light` is `posRadius` + `colorIntensity`
// and the fragment shades it isotropically. A cone would need a shader amendment. So each
// fixture is represented by a small isotropic light pushed a short way ALONG the authored
// beam direction — which puts the bright core in front of the lens rather than inside the
// hull, and gives the ground the pool a real lamp would throw. The lens and housing sit
// inside that light's falloff and read as lit, which is what makes the bulb visible without
// any emissive geometry.

import type { Mesh as GeoMesh } from '../geo/mesh'
import { extractWindowGeometry, buildingWindowSeed, windowState, windowWarmth, windowRooms, windowCircuitFactor, type WindowGeometry } from './window-occupancy'
import { materialLayerOf } from '../geo/zone'
import { packKey, quantise, sortKeys, unpackIndex } from './sort'
import type { Camera, DrawItem, GpuMesh, SkyEnvironment } from './types'

// ---------------------------------------------------------------------------
// The authored roster
// ---------------------------------------------------------------------------

interface AnchorLight {
	readonly name: string
	readonly kind: string
	readonly bone: number
	readonly rangeM: number
	readonly innerConeDeg: number
	readonly outerConeDeg: number
	readonly color: readonly number[]
	readonly position: readonly number[]
	readonly direction: readonly number[]
}

interface RosterAsset {
	readonly template?: string
	readonly lights?: readonly AnchorLight[]
}

interface RosterManifest {
	readonly assets: Readonly<Record<string, RosterAsset>>
}

// Same shape as `materials/actor-masks.ts` and `units/blender-assets.ts`: a build artefact,
// not another node. The glob resolves at build time and tolerates an absent local bake, so a
// clone with no forged pack still boots (rule 8) — with no lamps, because it has no fixtures.
const manifests = import.meta.glob<RosterManifest>('../../.forge/blender/manifest.json', { eager: true, import: 'default' })
const ROSTER: Readonly<Record<string, RosterAsset>> = Object.values(manifests)[0]?.assets ?? {}

/** Verbatim mirror of `BUILDINGS` in art/blender/lighting.py — the set that gets a yard lamp. */
const BUILDING_TEMPLATES = new Set([
	'factory', 'yard', 'power', 'refinery', 'silo', 'tech', 'command', 'hospital', 'barracks',
	'radar', 'kennel', 'repair', 'airfield', 'helipad', 'naval', 'pump', 'house', 'church',
])

/** Blender palette layer 24, "cyan optics" — the material every authored status lamp uses. */
const OPTIC_LAYER = 24

// ---------------------------------------------------------------------------
// When it is night
// ---------------------------------------------------------------------------

/**
 * Lamps follow the sky's actual radiance, not the clock, so they also come on under a
 * genuinely dark storm and stay off at a bright overcast noon. Measured from `sky/model.ts`
 * at clear weather, direct luma x intensity + sky luma x ambientScale:
 *
 *     midnight (moon up)  0.434      06:30  0.952      noon    4.131
 *     04:00               0.321      07:00  1.777      rain noon  1.650
 *     05:30 (no moon/sun) 0.068      08:00  2.610      rain midnight 0.177
 *
 * So FULL_BELOW sits just above the moonlit-midnight level: the darkest hour is fully lit,
 * and the fade runs out through dawn, reaching zero shortly after sunrise.
 *
 * These are NOT the legacy `headlampFactor` thresholds in `units/index.ts` (0.30/1.00), and
 * that is deliberate rather than a drift: at 0.30 the lamps would be at 81% at midnight and
 * only reach full at 04:00, which is backwards — brightest an hour before dawn. The legacy
 * curve drives the procedural class hulls, which only draw when an actor has no forged slot.
 */
const NIGHT_FULL_BELOW = 0.45
const NIGHT_OFF_ABOVE = 1.2

function skyLightLevel(env: SkyEnvironment): number {
	const direct = (env.sunColor[0] * 0.2126 + env.sunColor[1] * 0.7152 + env.sunColor[2] * 0.0722) * env.sunIntensity
	const ambient = (env.skyColor[0] * 0.2126 + env.skyColor[1] * 0.7152 + env.skyColor[2] * 0.0722) * env.ambientScale
	return direct + ambient
}

function nightFactor(env: SkyEnvironment): number {
	const level = skyLightLevel(env)
	if (!(level > NIGHT_FULL_BELOW)) return 1
	if (level >= NIGHT_OFF_ABOVE) return 0
	const t = (level - NIGHT_FULL_BELOW) / (NIGHT_OFF_ABOVE - NIGHT_FULL_BELOW)
	// Smoothstep rather than linear: a lamp that snaps out at a fixed radiance pops on the
	// frame the sun clears the horizon, and dawn is the one moment a player is looking at it.
	return 1 - t * t * (3 - 2 * t)
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * A fixture's presentation, in presentation metres.
 *
 * An OpenRA cell is one render metre; an adult is .36 tall and a medium tank is 1.30 long.
 * The authored `rangeM` is a CONE REACH — 6 for a headlamp, 9 for a yard lamp, 3 for a field
 * torch — so treating it as an isotropic falloff radius would wrap a tank in a six-metre ball
 * of light, four and a half times its own length. Every number here is a fraction of the
 * authored reach instead, so a source change still moves the lamp.
 */
interface RoleTuning {
	/** Where the near light sits along the beam, as a fraction of the authored reach. */
	readonly nearFraction: number
	/** Its falloff radius, likewise. */
	readonly nearRadius: number
	readonly nearIntensity: number
	/**
	 * The far light, which is what makes a beam out of two spheres.
	 *
	 * §12.2's `Light` is position + radius + colour + intensity, shaded isotropically; there
	 * is no cone. One sphere in front of a headlamp is a DISC on the ground, and a disc reads
	 * as a lamp pointed at the floor rather than a beam pointed down the road. Two spheres on
	 * the beam axis — one at the lens, one out where the authored cone has spread — union into
	 * an elongated pool that runs away from the vehicle, which is what a beam looks like from
	 * above. Zero intensity disables it.
	 */
	readonly farFraction: number
	readonly farRadius: number
	readonly farIntensity: number
	/** Billboard on the lens itself. Zero alpha disables it. */
	readonly glowRadius: number
	readonly glowAlpha: number
}

/**
 * Calibrated against `shots/nightlights` at quality high, camera height 11, clear midnight.
 *
 * The first pass ran the headlamp at 0.12/0.45 of a 6 m reach — a light .72 m in front of the
 * lens with a 2.7 m falloff. Measured: a blown-out disc roughly two tank lengths across,
 * floating clear of a vehicle whose own nose stayed black. Both halves of that are visible in
 * the capture and both are fixed here: the near light comes back to the lens so the machine is
 * lit by its own lamp, and the reach moves into a second, dimmer sphere down the beam.
 */
const HEADLAMP: RoleTuning = {
	nearFraction: 0.05, nearRadius: 0.26, nearIntensity: 0.55,
	farFraction: 0.30, farRadius: 0.34, farIntensity: 0.30,
	glowRadius: 0.055, glowAlpha: 0.85,
}
const TORCH: RoleTuning = {
	nearFraction: 0.10, nearRadius: 0.26, nearIntensity: 0.11,
	farFraction: 0, farRadius: 0, farIntensity: 0,
	glowRadius: 0.028, glowAlpha: 0.90,
}
const YARD: RoleTuning = {
	nearFraction: 0.05, nearRadius: 0.42, nearIntensity: 2.20,
	farFraction: 0, farRadius: 0, farIntensity: 0,
	glowRadius: 0.085, glowAlpha: 0.90,
}
const TAILLAMP: RoleTuning = {
	nearFraction: 0.08, nearRadius: 0.42, nearIntensity: 0.10,
	farFraction: 0, farRadius: 0, farIntensity: 0,
	glowRadius: 0.042, glowAlpha: 0.75,
}
const BEACON: RoleTuning = {
	nearFraction: 0.10, nearRadius: 0.32, nearIntensity: 0.07,
	farFraction: 0, farRadius: 0, farIntensity: 0,
	glowRadius: 0.040, glowAlpha: 0.85,
}
const COLLAR: RoleTuning = {
	nearFraction: 0.10, nearRadius: 0.40, nearIntensity: 0.05,
	farFraction: 0, farRadius: 0, farIntensity: 0,
	glowRadius: 0.022, glowAlpha: 0.90,
}

/**
 * Rear lamps, and the one thing here that is NOT authored.
 *
 * `lighting.py` builds and anchors the FRONT lenses only; there is no rear fixture and no
 * `taillamp` anchor kind. So this derives one: the rear face of the drawn mesh's own bounding
 * box, at the height and half-spacing of that vehicle's authored front lamps. Every number
 * except the colour therefore still comes from the source, and if the source moves the lamps
 * the tails follow. It remains a derivation, and the honest fix is for `lighting.py` to grow
 * a rear lens pair plus a `taillamp` kind, at which point this block is deleted rather than
 * tuned. Kept dim and small on purpose: a tail light is a marker, not an illuminator, and a
 * red sphere bright enough to light grass would be a lie about what a tail light does.
 */
const TAIL_R = 0.95
const TAIL_G = 0.05
const TAIL_B = 0.02
/** Nominal reach for the derived tail lamp, in the same presentation metres as `rangeM`. */
const TAIL_RANGE_M = 1.6
/** How far in front of the rear face the emitter sits, so it is on the surface, not behind it. */
const TAIL_INSET_M = 0.012

/** Derived beacon/collar reach. Status lamps are markers; they do not light the ground. */
const OPTIC_RANGE_M = 1.4

/**
 * Floor for any emitter's local height, in metres above the actor's own footprint.
 *
 * `placeActor` puts local y = 0 on the fitted ground, and the fragment clamps attenuation at
 * .01 m², so a light that lands ON the ground multiplies its colour by a hundred and burns a
 * small white hole in the terrain. A guard, not a routine correction: measured on `1tnk` the
 * far light lands at y = .10, a centimetre clear of this floor, and a source that lengthens a
 * beam or steepens its downtilt is exactly what would push it through.
 */
const MIN_LOCAL_HEIGHT = 0.09

// ---------------------------------------------------------------------------
// Fixture extraction from authored geometry
// ---------------------------------------------------------------------------

/**
 * Cluster radius for status lamps, in presentation metres.
 *
 * It has to exceed a fixture's FULL extent, not its half-diagonal. The first pass used .07,
 * reasoning from half-diagonals, and the airfield came back with twenty perimeter lamps for
 * the ten that are authored: `recessed perimeter lamp` is .08 long in x, so each box split
 * into a cluster at either end. The gap between two neighbouring fixtures is what actually
 * bounds this from above, and on the airfield's perimeter run that is L*.20, roughly .54.
 *
 * Measured against the authored sources: the longest single fixture is that .08 lamp; the
 * others are `entrance optical strip` (.008,.024,W*.10), `cabinet optical inset`
 * (.013,.08,W*.065), `residential status light` (.008,.065,.065) and, at the dog's .30 scale,
 * `pack blue status lamp` (.0024,.0069,.012). .11 holds every one of them as one cluster and
 * still leaves a 5x margin to the tightest spacing.
 */
const OPTIC_MERGE_RADIUS = 0.11
/** A stray vertex that happens to carry the optic layer is not a lamp. */
const OPTIC_MIN_VERTICES = 4
/**
 * Cap per asset, and a budget decision rather than a geometric one.
 *
 * The airfield authors ten perimeter lamps and the helipad the same. Ten small marker lights
 * for one structure is already more of §7's budget than one building has any claim to, and
 * the eleventh identical lamp in a row down the same apron edge is not a thing a player can
 * see the absence of. Clusters past this are dropped in vertex order, which is stable.
 */
const MAX_OPTIC_FIXTURES = 10
/** Push the emitter this far out along the fixture's own average normal. */
const OPTIC_SURFACE_OFFSET = 0.008

// ---------------------------------------------------------------------------
// Packed emitter table
// ---------------------------------------------------------------------------

/**
 * Local-space emitter record.
 *
 * Two positions rather than one: the light sits along the beam where a real lamp throws its
 * pool, while the billboard stays ON the fixture where the lens actually is. Roles are baked
 * away at boot: the per-frame path is a fixed-stride walk that never asks what kind of lamp
 * it is holding, only whether the intensity and the alpha are above zero.
 *
 *   0..2   light position, local
 *   3..5   glow position, local
 *   6..8   linear RGB
 *   9      light radius (metres)
 *   10     light intensity at full night
 *   11     glow radius (metres)
 *   12     glow alpha at full night
 */
const EMITTER_STRIDE = 15

/**
 * World-space candidate for this frame.
 *
 *   0..2   light position     3..5   colour     6  intensity   7  radius
 *   8..10  glow position     11  glow radius   12  glow alpha
 */
const CANDIDATE_STRIDE = 14

/**
 * Frustum-visible emitters considered for ranking in one frame.
 *
 * Hard-capped by `packKey`, which carries the item index in twelve bits: 4096 is the most a
 * sorted key can identify, so half of that leaves headroom and keeps the table at 106 KB.
 * Overflow is counted in `stats.overflow` rather than silently dropped, because a frame that
 * quietly stops considering half the map's lamps looks exactly like a frame that has none.
 */
const MAX_CANDIDATES = 2048

/**
 * Sticky ranking bonus for a candidate the previous frame admitted: its key ranks as if it
 * were `RANK_STICKY` radii closer, so a lamp already on screen is displaced only by a
 * newcomer meaningfully nearer. The same shape as `applyBudget`'s INCLUSION_HYSTERESIS
 * (renderer.ts), applied one layer down: without it, orbiting or panning at night swaps the
 * candidates straddling rank N in and out every frame and whole façades blink.
 */
const RANK_STICKY = 0.9
/** Open-addressed last-admitted table. It holds at most one entry per admitted candidate
 * (≤ lightBudget + glowBudget, well under MAX_CANDIDATES); 2x that leaves probe headroom. */
const STICKY_TABLE = 4096
/** Probe length before a candidate forgoes its stickiness for a frame. */
const STICKY_PROBE = 4

export interface NightLightStats {
	/** 0 in daylight, 1 at the darkest hour. */
	factor: number
	/** Assets that registered at least one emitter. */
	assets: number
	/** Emitters baked across those assets. */
	emitters: number
	/** Emitters that resolved to a visible world position this frame. */
	candidates: number
	/** Of those, how many became real lights and how many became billboards. */
	lights: number
	windowLights: number
	glows: number
	/** Candidates ranked with the sticky bonus this frame — the lights already on screen. */
	held: number
	/** Candidates past `MAX_CANDIDATES`, dropped before ranking. */
	overflow: number
}

interface EmitterSet {
	readonly id: string
	readonly data: Float32Array
	readonly count: number
}

export class NightLights {
	private readonly sets = new Map<GpuMesh, EmitterSet>()
	private candidates = new Float32Array(MAX_CANDIDATES * CANDIDATE_STRIDE)
	private keys = new Float64Array(MAX_CANDIDATES)
	private keyScratch = new Float64Array(MAX_CANDIDATES)
	private candidateCount = 0
	private frameIndex = 0
	/** Position-hashed record of which candidates were admitted, for the ranking hysteresis.
	 * Keyed by world position rather than list index because the candidate list is rebuilt
	 * every frame in collection order; a static lamp hashes to the same entry every time,
	 * while a driving vehicle legitimately outranks itself afresh as it moves. */
	private readonly stickyHash = new Int32Array(STICKY_TABLE)
	private readonly stickyFrame = new Uint32Array(STICKY_TABLE)

	/** Ranked budgets, set from the §7 quality preset in `configure`. */
	private lightBudget = 0
	private glowBudget = 0
	private windowBudget = 0
	private lampsDisabled = false

	readonly stats: NightLightStats = {
		factor: 0, assets: 0, emitters: 0, candidates: 0, lights: 0, windowLights: 0, glows: 0, held: 0, overflow: 0,
	}

	/** Scratch for fixture extraction. Boot only; never touched per frame. */
	private readonly clusterSum = new Float64Array(MAX_OPTIC_FIXTURES * 6)
	private readonly clusterCount = new Int32Array(MAX_OPTIC_FIXTURES)
	private readonly emitterScratch = new Float32Array(128 * EMITTER_STRIDE)

	/**
	 * @param dynamicLights §7's per-frame light budget for this quality tier.
	 * @param particleLimit the atmosphere pool's ceiling, already clamped by the renderer.
	 */
	configure(dynamicLights: number, particleLimit: number, quality = dynamicLights <= 32 ? 'low' : dynamicLights <= 128 ? 'medium' : 'high'): void {
		this.windowBudget = quality === 'low' ? 0 : quality === 'medium' ? 8 : quality === 'high' ? 24 : quality === 'ultra-max' ? 64 : 48
		// `?nolamps=1` holds the whole layer off. Same shape as `noforge`, `noenvironment` and
		// `nofogvolume`: it exists so a night frame can be photographed with and without the
		// lamps from ONE build, which is stronger evidence than two builds of two trees.
		this.lampsDisabled = new URLSearchParams(globalThis.location?.search ?? '').get('nolamps') === '1'
		if (this.lampsDisabled) {
			this.lightBudget = 0
			this.glowBudget = 0
			return
		}
		// Three quarters, so a heavy engagement always has room for its muzzle flashes and
		// burning wrecks. Lamps are submitted in lateUpdate, AFTER every node's update() has
		// run, so `LightPool` already holds this frame's combat lights before the first lamp
		// arrives — the ranking that follows can only ever displace a lamp with a lamp.
		this.lightBudget = Math.max(4, Math.floor(dynamicLights * 0.75))
		this.glowBudget = Math.max(0, Math.min(1024, Math.floor(particleLimit * 0.25)))
	}

	// -----------------------------------------------------------------------
	// Boot: bake one emitter table per uploaded mesh
	// -----------------------------------------------------------------------

	/**
	 * Called from `render.upload`/`uploadLods` with the label the caller passed and the CPU
	 * mesh it uploaded. Everything needed is read here and copied; no reference is retained
	 * to the caller's mesh, which `units` reuses as scratch across the procedural path.
	 */
	factorFor(env: SkyEnvironment): number { return this.lampsDisabled ? 0 : nightFactor(env) }

	windowsFor(label: string, mesh: GeoMesh): WindowGeometry | undefined {
		const id = assetIdFromLabel(label), template = id === null ? '' : ROSTER[id.replace(/\.d[1-5]$/, '')]?.template ?? ''
		if (!BUILDING_TEMPLATES.has(template)) return undefined
		return extractWindowGeometry(mesh, template === 'house' || template === 'church' ? 1 : 2)
	}

	register(handle: GpuMesh, label: string, mesh: GeoMesh, windows = this.windowsFor(label, mesh)): void {
		const id = assetIdFromLabel(label)
		if (id === null) return
		const isDamage = /\.d[1-5]$/.test(id)
		const asset = ROSTER[id.replace(/\.d[1-5]$/, '')]
		if (asset === undefined) return
		const template = asset.template ?? ''
		const out = this.emitterScratch
		let count = 0

		const anchors = isDamage ? undefined : asset.lights
		if (anchors !== undefined) {
			// The headlamp PAIR is one lamp, optically.
			//
			// `units/index.ts` reached the same conclusion for the procedural hulls and wrote it
			// down: two emitters per vehicle would ask for 400 lights in the 200-unit workload and
			// break high's 256 budget before a single shot is fired. Measured here at .25 m of
			// authored lens spacing against a 2.4 m pool, the two spheres are indistinguishable
			// from one anyway. So the light budget sees the midpoint, and both LENSES still get
			// their own billboard — a vehicle shows two headlights and costs one pair of lights.
			let sumX = 0, sumY = 0, sumZ = 0, dirX = 0, dirY = 0, dirZ = 0
			let sumR = 0, sumG = 0, sumB = 0, sumRange = 0, pairs = 0
			for (let i = 0; i < anchors.length; i++) {
				const a = anchors[i]
				if (a.kind === 'headlamp') {
					sumX += a.position[0]; sumY += a.position[1]; sumZ += a.position[2]
					dirX += a.direction[0]; dirY += a.direction[1]; dirZ += a.direction[2]
					sumR += a.color[0]; sumG += a.color[1]; sumB += a.color[2]
					sumRange += a.rangeM
					pairs++
					count = pushGlow(out, count, a.position[0], a.position[1], a.position[2],
						a.direction[0], a.direction[1], a.direction[2],
						a.color[0], a.color[1], a.color[2], HEADLAMP)
					continue
				}
				// An unknown kind is a source change this file has not caught up with. Skip it
				// rather than guess: a lamp with invented tuning is worse than a missing one.
				const tuning = a.kind === 'flashlight' ? TORCH
					: a.kind === 'yard' ? YARD
										: null
				if (tuning === null) continue
				count = pushFixture(out, count, a.position[0], a.position[1], a.position[2],
					a.direction[0], a.direction[1], a.direction[2],
					a.color[0], a.color[1], a.color[2], a.rangeM, tuning)
			}
			if (pairs > 0) {
				count = pushBeam(out, count, sumX / pairs, sumY / pairs, sumZ / pairs,
					dirX / pairs, dirY / pairs, dirZ / pairs,
					sumR / pairs, sumG / pairs, sumB / pairs, sumRange / pairs, HEADLAMP)
				// Rear lamps, mirrored off the front pair. See TAILLAMP: derived, not authored.
				if (template === 'tank' || template === 'truck') {
					const rearX = mesh.aabbMin[0] + TAIL_INSET_M
					for (let i = 0; i < anchors.length; i++) {
						const a = anchors[i]
						if (a.kind !== 'headlamp') continue
						count = pushGlow(out, count, rearX, a.position[1], a.position[2],
							-1, -0.05, 0, TAIL_R, TAIL_G, TAIL_B, TAILLAMP)
					}
					// Light only: the two lens billboards above already carry the visible red,
					// and a third glow on the centreline is a lamp with no housing under it.
					count = pushBeam(out, count, rearX, sumY / pairs, sumZ / pairs,
						-1, -0.05, 0, TAIL_R, TAIL_G, TAIL_B, TAIL_RANGE_M, TAILLAMP)
				}
			}
		}

		// Authored status lamps, recovered from the geometry that already draws them.
		//
		// `details.py` paints every one of these with the CYAN optic material and nothing else
		// on a building or the dog uses it, so clustering that layer recovers the fixtures
		// exactly — the house's `residential status light`, the airfield's `recessed perimeter
		// lamp` run, the radar's `cabinet optical inset`, and the dog's `pack blue status lamp`
		// on the front of its harness pack. No coordinate is copied out of the source; the
		// mesh is asked where its own lamps are.
		const optic = template === 'dog' ? COLLAR : BUILDING_TEMPLATES.has(template) ? BEACON : null
		if (optic !== null) count = this.pushOpticFixtures(out, count, mesh, optic)

		// Actual glass geometry provides rooms at every tier; no floating window billboards.
		// Local lights are an additional bounded fidelity layer with the identical room seed.
		for (const pane of (windows?.panes ?? []).flatMap(windowRooms)) {
			if (count >= 128) break
			const [x,y,z] = pane.center, [nx,ny,nz] = pane.normal
			const radius = Math.max(.25, Math.min(.65, Math.max(...pane.max.map((v,i)=>v-pane.min[i])) * 1.5))
			const slot = count * EMITTER_STRIDE
			count = write(out,count,x+nx*.025,y+ny*.025,z+nz*.025,0,0,0,1,.72,.43,radius,.45,0,0)
			out[slot+13] = pane.seed; out[slot+14] = pane.flags
		}
		if (count === 0) return
		const data = new Float32Array(count * EMITTER_STRIDE)
		for (let i = 0; i < count * EMITTER_STRIDE; i++) data[i] = out[i]
		this.sets.set(handle, { id, data, count })
		this.stats.assets++
		this.stats.emitters += count
	}

	/** Greedy nearest-cluster merge over one material layer. Boot only; O(vertices x clusters). */
	private pushOpticFixtures(out: Float32Array, count: number, mesh: GeoMesh, tuning: RoleTuning): number {
		const sums = this.clusterSum
		const counts = this.clusterCount
		let clusters = 0
		const positions = mesh.positions
		const normals = mesh.normals
		const zones = mesh.materialZone
		const merge2 = OPTIC_MERGE_RADIUS * OPTIC_MERGE_RADIUS
		for (let v = 0; v < mesh.vertexCount; v++) {
			if (materialLayerOf(zones[v]) !== OPTIC_LAYER) continue
			const o = v * 3
			const x = positions[o], y = positions[o + 1], z = positions[o + 2]
			let best = -1
			let bestDist = merge2
			for (let c = 0; c < clusters; c++) {
				const n = counts[c]
				const s = c * 6
				const dx = sums[s] / n - x, dy = sums[s + 1] / n - y, dz = sums[s + 2] / n - z
				const d = dx * dx + dy * dy + dz * dz
				if (d >= bestDist) continue
				bestDist = d
				best = c
			}
			if (best < 0) {
				if (clusters >= MAX_OPTIC_FIXTURES) continue
				best = clusters++
				const s = best * 6
				sums[s] = 0; sums[s + 1] = 0; sums[s + 2] = 0
				sums[s + 3] = 0; sums[s + 4] = 0; sums[s + 5] = 0
				counts[best] = 0
			}
			const s = best * 6
			sums[s] += x; sums[s + 1] += y; sums[s + 2] += z
			sums[s + 3] += normals[o]; sums[s + 4] += normals[o + 1]; sums[s + 5] += normals[o + 2]
			counts[best]++
		}
		for (let c = 0; c < clusters; c++) {
			const n = counts[c]
			if (n < OPTIC_MIN_VERTICES) continue
			const s = c * 6
			const cx = sums[s] / n, cy = sums[s + 1] / n, cz = sums[s + 2] / n
			let nx = sums[s + 3], ny = sums[s + 4], nz = sums[s + 5]
			const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
			// A closed fixture's normals cancel. There is no outward face to speak of, so the
			// emitter stays on the centroid and the beam direction points up out of the case.
			if (len < 1e-3) { nx = 0; ny = 1; nz = 0 } else { nx /= len; ny /= len; nz /= len }
			// The palette's own cyan optic colour, so a status lamp reads as the fixture it is.
			count = pushFixture(out, count,
				cx + nx * OPTIC_SURFACE_OFFSET, cy + ny * OPTIC_SURFACE_OFFSET, cz + nz * OPTIC_SURFACE_OFFSET,
				nx, ny, nz, 0.32, 0.86, 1, OPTIC_RANGE_M, tuning)
		}
		return count
	}

	// -----------------------------------------------------------------------
	// Per frame
	// -----------------------------------------------------------------------

	/**
	 * Resolve, rank and submit. Called from `render.lateUpdate` before `LightPool.flush`, so
	 * the camera is final and the pool has already taken every combat light this frame.
	 *
	 * `planes` is the renderer's own five-plane frustum, already extracted against this
	 * camera: without it the budget is spent on lamps behind and below an overhead camera,
	 * which are the closest things in the scene and none of them are on screen.
	 */
	update(
		env: SkyEnvironment,
		camera: Camera,
		planes: Float32Array,
		items: readonly (DrawItem | null)[],
		itemCount: number,
		sink: LightSink,
	): void {
		const stats = this.stats
		this.frameIndex++
		stats.candidates = 0
		stats.lights = 0
		stats.windowLights = 0
		stats.glows = 0
		stats.held = 0
		stats.overflow = 0
		const factor = this.factorFor(env)
		stats.factor = factor
		if (factor <= 0 || this.sets.size === 0) return
		if (this.lightBudget === 0 && this.glowBudget === 0) return

		this.candidateCount = 0
		const camX = camera.position[0], camY = camera.position[1], camZ = camera.position[2]
		for (let i = 0; i < itemCount; i++) {
			const item = items[i]
			if (item === null) continue
			const set = this.sets.get(item.mesh)
			if (set === undefined) continue
			this.collect(set, item, planes, factor, env.motionTime ?? 0)
		}
		stats.candidates = this.candidateCount
		this.submit(camX, camY, camZ, sink)
	}

	private collect(set: EmitterSet, item: DrawItem, planes: Float32Array, factor: number, seconds: number): void {
		const m = item.instances
		const emitters = set.data
		const n = set.count
		const instances = item.instanceCount
		const cand = this.candidates
		for (let inst = 0; inst < instances; inst++) {
			const o = inst * 16
			const fx = m[o], fy = m[o + 1], fz = m[o + 2]
			const ux = m[o + 4], uy = m[o + 5], uz = m[o + 6]
			const rx = m[o + 8], ry = m[o + 9], rz = m[o + 10]
			const px = m[o + 12], py = m[o + 13], pz = m[o + 14]
			for (let e = 0; e < n; e++) {
				const b = e * EMITTER_STRIDE
				const lx = emitters[b], ly = emitters[b + 1], lz = emitters[b + 2]
				const wx = px + fx * lx + ux * ly + rx * lz
				const wy = py + fy * lx + uy * ly + ry * lz
				const wz = pz + fz * lx + uz * ly + rz * lz
				const radius = emitters[b + 9]
				const windowSeed = emitters[b+13]
				const building = windowSeed ? buildingWindowSeed(px,pz) : 0
				const damage = item.damages?.[inst] ?? 0
				const occupancy = windowSeed ? windowState(windowSeed,emitters[b+14],building) * windowCircuitFactor(windowSeed,emitters[b+14],building,damage,seconds) : 1
				if (occupancy === 0 || (windowSeed && this.windowBudget === 0)) continue
				const warmth = windowSeed ? windowWarmth(windowSeed,building) : 0
				if (!sphereInFrustum(planes, wx, wy, wz, radius)) continue
				if (this.candidateCount >= MAX_CANDIDATES) { this.stats.overflow++; continue }
				const gx = emitters[b + 3], gy = emitters[b + 4], gz = emitters[b + 5]
				const c = this.candidateCount++ * CANDIDATE_STRIDE
				cand[c] = wx
				cand[c + 1] = wy
				cand[c + 2] = wz
				cand[c + 3] = emitters[b + 6]
				cand[c + 4] = windowSeed ? .68 + warmth * .08 : emitters[b + 7]
				cand[c + 5] = windowSeed ? .38 + warmth * .10 : emitters[b + 8]
				cand[c + 6] = emitters[b + 10] * factor * occupancy
				cand[c + 7] = radius
				cand[c + 8] = px + fx * gx + ux * gy + rx * gz
				cand[c + 9] = py + fy * gx + uy * gy + ry * gz
				cand[c + 10] = pz + fz * gx + uz * gy + rz * gz
				cand[c + 11] = emitters[b + 11]
				cand[c + 12] = emitters[b + 12] * factor
				cand[c + 13] = windowSeed ? 1 : 0
			}
		}
	}

	private submit(camX: number, camY: number, camZ: number, sink: LightSink): void {
		const n = this.candidateCount
		if (n === 0) return
		const cand = this.candidates
		const lightBudget = this.lightBudget
		const glowBudget = this.glowBudget
		const keys = this.keys
		for (let i = 0; i < n; i++) {
			const c = i * CANDIDATE_STRIDE
			const dx = cand[c] - camX, dy = cand[c + 1] - camY, dz = cand[c + 2] - camZ
			const radius = cand[c + 7]
			// Distance in the lamp's OWN radii, not in metres: a yard lamp with a four-metre
			// pool matters more from twenty metres away than an infantry torch does from twelve,
			// and a metric that cannot say so spends the whole budget on whatever happens to be
			// nearest the camera. Quantised to 20 bits at 64 steps per radius, which saturates
			// past sixteen thousand radii — far beyond CLUSTER_FAR.
			const radii = Math.sqrt((dx * dx + dy * dy + dz * dz) / (radius * radius))
			// Hysteresis: a candidate admitted last frame ranks as if closer, so crossing the
			// budget boundary costs more than a rounding error in distance. A bias on the
			// order, not a reservation — a genuinely nearer newcomer still wins.
			const held = this.heldLastFrame(cand[c], cand[c + 1], cand[c + 2])
			if (held) this.stats.held++
			keys[i] = packKey(quantise(radii * (held ? RANK_STICKY : 1), 64, 20), i)
		}
		sortKeys(keys, this.keyScratch, n)
		let lights = 0
		let windows = 0
		let glows = 0
		for (let i = 0; i < n; i++) {
			if (lights >= lightBudget && glows >= glowBudget) break
			const c = unpackIndex(keys[i]) * CANDIDATE_STRIDE
			if (cand[c + 6] > 0 && lights < lightBudget && (cand[c+13] === 0 || windows < this.windowBudget)) {
				sink.addLight(cand[c], cand[c + 1], cand[c + 2], cand[c + 3], cand[c + 4], cand[c + 5], cand[c + 6], cand[c + 7])
				this.hold(cand[c], cand[c + 1], cand[c + 2])
				lights++
				if (cand[c+13]) windows++
			}
			if (cand[c + 11] > 0 && cand[c + 12] > 0 && glows < glowBudget) {
				// age 0, and a seed taken from the candidate slot: the billboard's noise is a
				// pure function of position in the ranked list, so a replayed frame from the
				// same submission is byte-identical (§5.2) and no RNG is consulted (rule 5).
				sink.addParticle(cand[c + 8], cand[c + 9], cand[c + 10], cand[c + 11],
					cand[c + 3], cand[c + 4], cand[c + 5], cand[c + 12], 0, c * 0.013, 1)
				this.hold(cand[c], cand[c + 1], cand[c + 2])
				glows++
			}
		}
		this.stats.lights = lights
		this.stats.windowLights = windows
		this.stats.glows = glows
	}

	/**
	 * Boot-time inventory: which roster assets baked how many emitters, and of what.
	 *
	 * Diagnostic only, and allocating — it is called by `tools/nightlightshot.mjs` once per
	 * capture, never per frame. It exists because "111 assets carry anchors" is a claim about
	 * the manifest, while this is a claim about what actually reached the renderer.
	 */
	summary(): { id: string; emitters: number; lights: number; glows: number }[] {
		const rows: { id: string; emitters: number; lights: number; glows: number }[] = []
		for (const set of this.sets.values()) {
			let lights = 0
			let glows = 0
			for (let e = 0; e < set.count; e++) {
				const o = e * EMITTER_STRIDE
				if (set.data[o + 10] > 0) lights++
				if (set.data[o + 11] > 0 && set.data[o + 12] > 0) glows++
			}
			rows.push({ id: set.id, emitters: set.count, lights, glows })
		}
		rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		return rows
	}

	/** Was a candidate at this world position admitted last frame? Read-only pass; the
	 * table is written only by `hold`, after every key has already been computed. */
	private heldLastFrame(x: number, y: number, z: number): boolean {
		const h = stickyHashOf(x, y, z)
		for (let p = 0; p < STICKY_PROBE; p++) {
			const s = (h + p) & (STICKY_TABLE - 1)
			if (this.stickyFrame[s] === 0) return false
			if (this.stickyHash[s] === h) return this.stickyFrame[s] === this.frameIndex - 1
		}
		return false
	}

	/** Record an admission. Claims an empty or stale slot; an entry held by another
	 * candidate this frame just costs the newcomer its stickiness for a frame. */
	private hold(x: number, y: number, z: number): void {
		const h = stickyHashOf(x, y, z)
		for (let p = 0; p < STICKY_PROBE; p++) {
			const s = (h + p) & (STICKY_TABLE - 1)
			const stamp = this.stickyFrame[s]
			if (stamp === this.frameIndex && this.stickyHash[s] === h) return
			if (stamp !== this.frameIndex) {
				this.stickyHash[s] = h
				this.stickyFrame[s] = this.frameIndex
				return
			}
		}
	}

	dispose(): void {
		this.sets.clear()
		this.stickyHash.fill(0)
		this.stickyFrame.fill(0)
		this.frameIndex = 0
	}
}

/** The two renderer entry points this needs, named so the class does not depend on Renderer. */
export interface LightSink {
	addLight(x: number, y: number, z: number, r: number, g: number, b: number, intensity: number, radius: number): void
	addParticle(x: number, y: number, z: number, radius: number, r: number, g: number, b: number, alpha: number, age: number, seed: number, emission: number): void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SLOT_PREFIX = 'units:slot:'

/**
 * `units` labels every roster mesh `units:slot:<asset id>`, with an optional variant suffix
 * for the authored LOD chains (`:anatomical`, `:authored-tree`). The asset id IS the roster
 * key, which is what makes the join to the manifest exact rather than a name table.
 */
function assetIdFromLabel(label: string): string | null {
	const prefix = label.startsWith(SLOT_PREFIX) ? SLOT_PREFIX : label.startsWith('units:damage:') ? 'units:damage:' : null
	if (prefix === null) return null
	const rest = label.slice(prefix.length)
	const colon = rest.indexOf(':')
	return colon === -1 ? rest : rest.slice(0, colon)
}

/**
 * One fixture: the near light where the lamp actually is, plus its lens billboard.
 *
 * The beam direction is used twice and differently — the light steps a little way ALONG it so
 * its bright core lands in front of the lens instead of inside the housing, while the glow
 * stays on the lens face where the lit surface is.
 */
function pushFixture(
	out: Float32Array, count: number,
	px: number, py: number, pz: number,
	dx: number, dy: number, dz: number,
	r: number, g: number, b: number,
	rangeM: number, tuning: RoleTuning,
): number {
	const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
	const nx = dx / len, ny = dy / len, nz = dz / len
	const step = rangeM * tuning.nearFraction
	return write(out, count,
		px + nx * step, py + ny * step, pz + nz * step,
		px + nx * GLOW_CLEARANCE, py + ny * GLOW_CLEARANCE, pz + nz * GLOW_CLEARANCE,
		r, g, b, rangeM * tuning.nearRadius, tuning.nearIntensity, tuning.glowRadius, tuning.glowAlpha)
}

/** The lens billboard alone, for a fixture whose light is carried by a shared pair emitter. */
function pushGlow(
	out: Float32Array, count: number,
	px: number, py: number, pz: number,
	dx: number, dy: number, dz: number,
	r: number, g: number, b: number,
	tuning: RoleTuning,
): number {
	const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
	const gx = px + (dx / len) * GLOW_CLEARANCE, gy = py + (dy / len) * GLOW_CLEARANCE, gz = pz + (dz / len) * GLOW_CLEARANCE
	// The light position doubles as the frustum-test centre and the ranking origin, so a
	// glow-only record still needs one: its own, with its own small radius.
	return write(out, count, gx, gy, gz, gx, gy, gz, r, g, b, tuning.glowRadius, 0, tuning.glowRadius, tuning.glowAlpha)
}

/** The near/far pair that stands in for the authored cone. See `RoleTuning.farFraction`. */
function pushBeam(
	out: Float32Array, count: number,
	px: number, py: number, pz: number,
	dx: number, dy: number, dz: number,
	r: number, g: number, b: number,
	rangeM: number, tuning: RoleTuning,
): number {
	const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
	const nx = dx / len, ny = dy / len, nz = dz / len
	const near = rangeM * tuning.nearFraction
	count = write(out, count,
		px + nx * near, Math.max(py + ny * near, MIN_LOCAL_HEIGHT), pz + nz * near,
		0, 0, 0, r, g, b, rangeM * tuning.nearRadius, tuning.nearIntensity, 0, 0)
	if (tuning.farIntensity <= 0) return count
	const far = rangeM * tuning.farFraction
	return write(out, count,
		px + nx * far, Math.max(py + ny * far, MIN_LOCAL_HEIGHT), pz + nz * far,
		0, 0, 0, r, g, b, rangeM * tuning.farRadius, tuning.farIntensity, 0, 0)
}

/**
 * Hash of a candidate's world position, quantised to 1/64 m: two frames of a static lamp
 * hash identically, while any real vehicle motion lands in a different entry and simply
 * forfeits the stickiness bonus. Pure integer mixing — no RNG, replay-safe by construction.
 */
function stickyHashOf(x: number, y: number, z: number): number {
	let h = Math.imul(Math.round(x * 64) | 0, 0x9e3779b1)
	h = Math.imul(h ^ (Math.round(y * 64) | 0), 0x85ebca6b)
	h = Math.imul(h ^ (Math.round(z * 64) | 0), 0xc2b2ae35)
	return (h ^ (h >>> 15)) | 0
}

/** Push the lens billboard this far off the lens face so it is not buried in the housing. */
const GLOW_CLEARANCE = 0.012

function write(
	out: Float32Array, count: number,
	lx: number, ly: number, lz: number,
	gx: number, gy: number, gz: number,
	r: number, g: number, b: number,
	radius: number, intensity: number, glowRadius: number, glowAlpha: number,
): number {
	if ((count + 1) * EMITTER_STRIDE > out.length) return count
	const o = count * EMITTER_STRIDE
	out[o] = lx
	out[o + 1] = ly
	out[o + 2] = lz
	out[o + 3] = gx
	out[o + 4] = gy
	out[o + 5] = gz
	out[o + 6] = r
	out[o + 7] = g
	out[o + 8] = b
	out[o + 9] = radius
	out[o + 10] = intensity
	out[o + 11] = glowRadius
	out[o + 12] = glowAlpha
	out[o + 13] = 0; out[o + 14] = 0
	return count + 1
}

/** Five planes: left, right, bottom, top, near. Same convention as `Renderer.sphereVisible`. */
function sphereInFrustum(planes: Float32Array, x: number, y: number, z: number, r: number): boolean {
	for (let i = 0; i < 5; i++) {
		const o = i * 4
		if (planes[o] * x + planes[o + 1] * y + planes[o + 2] * z + planes[o + 3] < -r) return false
	}
	return true
}
