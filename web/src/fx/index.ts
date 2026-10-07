import { WeaponEvents } from '../core/weapon-events'
// STEELSEED — fx
// Authoritative muzzle flashes, instant-hit tracers and impact bursts.
//
// The simulation publishes a complete fire fact: absolute muzzle WPos, current facing and
// presentation caliber. Copy that fact immediately. Do not rebuild it from archetype data —
// the engine value already contains turret traverse, recoil and terrain elevation, while the
// authored muzzle in ChassisParams is only the weapon's rest-space geometry contract.
//
// All effects are ordinary emissive geometry through the ordinary draw path. There is no
// effect pipeline, no blending and no shadow draw. The impact payload's three i16 values are
// the reverse shot direction (impact toward source), NOT a struck-surface normal. They orient
// a three-dimensional burst; a slope-conforming decal waits for real surface-normal truth.

import { Mesh } from '../geo/mesh'
import * as sdf from '../geo/sdf'
import { Zone, ZoneFlag, withZoneFlag } from '../geo/zone'
import type { AircraftVisualEvent } from '../core/events'
import { ActorFlag, ActorStatusKind, CoreEvent, EventKind, SimEvent, Surface, findActorIndex, wangleToRadians, type Ctx, type Snapshot, type SnapshotEvent } from '../core'
import type { DrawItem, GpuMesh, RenderApi, ShroudApi, TerrainApi, UnitsApi } from './types'
import { SoftParticles } from './particles'
import { lookupRaWeaponVisual, UNKNOWN_WEAPON_VISUAL, type WeaponVisualStyle } from './weapon-visuals'
import { DamageSmoke } from './damage-smoke'
import { AircraftContrails } from './aircraft-contrails'
import { StackSmoke } from './stack-smoke'
import { MushroomCloud } from './mushroom-cloud'
import { ParachuteCanopies } from './parachutes'
import { RotorDownwash } from './rotor-downwash'
import { spawnBuildingMaterial } from './building-materials'
import { CurtainDomes } from './curtain-domes'
import { CrateMarkers } from './crates'
import { VehicleCookoff } from './vehicle-cookoff'
import { GroundFire } from './ground-fire'
import { GroundTracks } from './ground-tracks'
import { UtilityWater } from './utility-water'
import { NavalWakes } from './naval-wakes'
import { TeslaArc, buildArcMesh } from './tesla-arc'
import { Projectiles } from './projectiles'
import { vfxBudgetFor, type VfxBudgetConfig } from './vfx-budget'
import { ImpactScorch } from './impact-scorch'
import { ATOMIC, NuclearStrike, nuclearProfileFor, type NuclearProfile } from './nuclear-strike'
import { VfxGovernor } from './vfx-governor'
import { surfaceTable } from '../core/surface'
import {
	EMITTER_RGB,
	FALLBACK_CODE,
	FAMILY_COUNT,
	FAMILY_MUZZLE_STYLE,
	FAMILY_TRACER_STYLE,
	FxFamily,
	IMPACT_PRESETS,
	IMPACT_SCALE,
	ImpactKind,
	impactSizeOf,
	MUZZLE_LIFETIME_S,
	MUZZLE_MAX_LIFETIME_S,
	MUZZLE_STYLE_COUNT,
	MuzzleStyle,
	SMOKE_PRESET,
	SMOKE_SCALE,
	SMOKE_TRAIL,
	TRACER_NOMINAL_R,
	TRACER_STREAK_FRACTION,
	TRACER_STREAK_MAX_M,
	TRACER_STYLE_COUNT,
	TracerStyle,
	WATER_IMPACT,
	buildMuzzleMesh,
	buildTracerMesh,
	familyOf,
	impactOf,
	muzzleStyleOf,
	packWeaponCode,
	smokeOf,
	tracerStyleOf,
} from './weapon-fx'

/** WPos is 1024 per cell and one cell is one render metre (§12.4). */
const WPOS_TO_M = 1 / 1024
/** Vehicles that die as electrical hardware (vfx.md: MRJ, MGG "electrical sparks ... on destruction"). */
const ELECTRICAL_VEHICLES: ReadonlySet<string> = new Set(['mrj', 'mgg'])
/** Seconds a chronoshift's two ends shimmer on Ultra+. */
const CHRONO_SHIMMER_S = 0.6
/** Fixed storage: a pathological burst degrades by dropping effects, never by allocating. */
const MAX_FLASHES = 256
const MAX_TRACERS = 256
const MAX_IMPACTS = 256
/**
 * A nuclear record for the same weapon at the same place within this many seconds of simulation
 * time (effectTime is tick / 25) is that detonation replayed. A detonation anywhere else, even in
 * the same second, is its own: Demo Trucks caught in an Atomic each fire their MiniNuke.
 */
const NUKE_REARM_S = 1
/** Metres: a replayed record lands where its detonation did; two vehicles never stand this close. */
const NUKE_SAME_M = 0.5
/** Detonations remembered for that check; fixed storage. */
const RECENT_NUKES = 8
/** Curtained units that may glow at once; one 3x3 curtain covers nine. */
const CURTAIN_LIGHTS = 16
/** MADTankThump and MADTankDetonate (weapons/other.yaml), keyed by name: true for the detonation. */
const MAD_PULSES: ReadonlyMap<string, boolean> = new Map([['madtankthump', false], ['madtankdetonate', true]])
/** [radius m, puffs, scale] per ring: the warhead's Spread 7c0, and halfway in. */
// 20 small puffs on a 44 m circle read as scattered dots in a live capture; this density and
// size read as a ring. A thump is about 40 particle births, and a charge runs a handful.
const MAD_RINGS: readonly (readonly [number, number, number])[] = [[7, 28, 2], [3.5, 12, 1.5]]
const CURTAIN_INTENSITY = 1.6
const CURTAIN_RADIUS_M = 1.8
/** More than any actor moves in one tick (units/index draws such a jump without a slide). */
const TELEPORT_WPOS = 3 * 1024
const MAX_EXPLOSIONS = 128
/** Retain an unmatched fire across adjacent simulation ticks without keeping its flash alive. */
const PAIR_WINDOW_S = 0.16
/**
 * How long a tracer stays on screen.
 *
 * This was 0.075 s: four frames at 60 Hz. Combined with a 1.6 cm world radius, which is under
 * one pixel at gameplay zoom, `tracergate` could prove a tracer existed while a player watching
 * the same shot saw nothing at all. Firing has to be legible, so a tracer now lasts long enough
 * for the eye to catch it and is sized in PIXELS rather than centimetres.
 */
const TRACER_LIFETIME_S = 0.26
/**
 * Floor and gain that turn the authored `tracer.lifetimeSeconds` into a drawn life.
 *
 * The manifest authors 0.03 s for a silenced pistol and 0.38 s for a V2, which is the right
 * ORDER and, at the bottom, under two frames — and a two-frame tracer is exactly the invisibility
 * the note above was written about. Floor plus gain keeps every authored value at five frames or
 * more at 60 Hz while preserving the ordering the catalogue states: 0.125 s for the pistol,
 * 0.21 s for a 90 mm, 0.46 s for the V2.
 */
const TRACER_LIFETIME_FLOOR_S = 0.08
const TRACER_LIFETIME_GAIN = 1.0
/**
 * On-screen width a tracer aims for, in CSS pixels, independent of how far the camera sits.
 *
 * Was 5, which read as a laser. A tracer is a bullet with a burning base, not a beam: the eye
 * sees a thin moving point, and the continuous streak everyone pictures is an artefact of a long
 * camera exposure. Real belts also carry roughly one tracer in five, so a battlefield does not
 * draw a line per round. Narrow is the honest width.
 */
const TRACER_PIXEL_WIDTH = 2.1
/**
 * The authored width the pixel calibration above belongs to: the rifleman's M1Carbine, 0.016 m.
 *
 * Width used to be `0.72 + sqrt(clamp(damage,1,512)) * 0.018` — DAMAGE standing in for a bore the
 * catalogue already states, and a proxy so flat that a 36-damage carbine and a 400-damage warhead
 * came out 1.30x apart while the authored widths are 11x apart. Sizing the screen floor by
 * sqrt(widthM / this) keeps the rifle at exactly the 2.1 px that was calibrated and lets every
 * heavier weapon grow from there: the drawn spread becomes 3.35x, and it is the authored one.
 */
const TRACER_REFERENCE_WIDTH_M = 0.016
/**
 * Fraction of the flight path the drawn streak covers, and the metres it is capped at.
 *
 * The whole muzzle-to-impact line drawn at once IS the laser. What a round actually shows is a
 * short dash travelling that path, so the streak is a segment whose position advances with the
 * tracer's age: over its life it walks from muzzle to target the way the projectile did.
 */
// The streak fraction and its cap are now per tracer style, in `fx/weapon-fx`. A rocket's
// residue spans the whole path; a rifle round is a short dash on it. One constant for both was
// the reason a tank round and a rifle round were the same object once the flash had gone.
/**
 * Metres per pixel, per metre of camera distance: 2*tan(fov/2)/viewportHeight for the roughly
 * 45 degree vertical field this game uses at a 900 px viewport. Sizing from the projection
 * would be exact; this is within a pixel across the whole zoom range and costs no matrix work.
 */
const TRACER_METRES_PER_PIXEL = 0.00092
/** A tracer never shrinks below a hair on screen, and never becomes a wall when zoomed far out. */
const TRACER_MIN_R = 0.02
/**
 * A shell in flight is drawn as a dash of this many ticks of its own travel: long enough to
 * read as a fast round rather than a dot, short enough never to read as a beam. 105mm moves
 * 0.67 m per tick, so about 1.1 m. It is also capped by the path already flown, so a round
 * leaving the barrel starts at the muzzle instead of sticking out of the turret.
 */
const SHELL_STREAK_TICKS = 1.6
const SHELL_STREAK_MAX_M = 2.4
/** Flash size over its life (0..1): 70% at birth, full at a quarter, a third at the end. */
/** A deterministic 0..1 from an integer seed (xorshift); fx never calls Math.random. */
function hash01(value: number): number {
	let x = value | 0
	x ^= x << 13
	x ^= x >>> 17
	x ^= x << 5
	return ((x >>> 0) % 10007) / 10007
}

function flashEnvelope(f: number): number {
	return f < 0.25 ? 0.7 + 1.2 * f : 1 - 0.67 * Math.pow((f - 0.25) / 0.75, 0.8)
}
/** Muzzle envelope (metres) from which a gun also lifts ground dust: 90mm and up. */
const HEAVY_GUN_SCALE_M = 0.55
/** Pooled Tesla lights a frame (coil + contact per bolt), Ultra and Ultra+ (vfx.md Epic 7). */
const TESLA_LIGHTS_PER_FRAME = 8
/** Ultra: what hangs over a strike, by the struck surface ('' for none). */
const STRIKE_HAZE = surfaceTable({ soil: 'hazesoil', rock: 'hazerock', sand: 'hazesand', gravel: 'hazerock', grass: 'hazesoil', road: 'hazerock',
	metal: '', concrete: 'hazerock', water: '', shallow: '', snow: 'hazesnow', ash: 'hazeash', resource: 'hazesand' })
/** Ultra: what a shell throws, by the struck surface ('' for none: sand sprays as haze). */
const STRIKE_DEBRIS = surfaceTable({ soil: 'clods', rock: 'chips', sand: '', gravel: 'chips', grass: 'clods', road: 'chips',
	metal: 'armorsparks', concrete: 'chips', water: '', shallow: '', snow: 'snowclods', ash: 'clods', resource: 'orechips' })
const TRACER_MAX_R = 0.42
const IMPACT_LIFETIME_S = 0.11
/** A destruction reads across several frames, but is still an event rather than world state. */
const EXPLOSION_LIFETIME_S = 0.42
const FIRE_PAYLOAD_BYTES = 24
const IMPACT_PAYLOAD_BYTES = 22
const DESTROYED_PAYLOAD_BYTES = 18
/** Quantised incidence is effectively exact; this rejects an unrelated off-axis volley. */
const PAIR_DOT_MIN = 0.995
/**
 * A real Bullet or Missile is in the air for many ticks, and the only impact OpenRA reports
 * for it is `actorDamaged`. That event deliberately carries no projectile identity — the
 * emitter writes weapon class 0 because no generic damage notification has one — and its
 * magnitude is damage dealt, not the warhead discriminator the fire event sends. So a flight
 * can be matched to its muzzle only by time and geometry, over a window long enough to cover
 * the flight, with the direction test loosened for an arcing shot at a target that has moved.
 * Without this the only weapons that ever drew a tracer were the instant-hit ones.
 */
const PROJECTILE_PAIR_WINDOW_S = 1.6
const PROJECTILE_PAIR_DOT_MIN = 0.9
/** Beyond this a coincidence is likelier than a flight. Longer than any RA weapon's range. */
const PROJECTILE_PAIR_MAX_M = 26
/**
 * Puffs laid along one flight. Bounded so a volley cannot turn into a particle storm.
 *
 * WHICH flights leave one is no longer a damage threshold. It was `damage >= 40`, a proxy for
 * "this was probably a rocket"; the catalogue says so directly — the rocket family authors
 * `smoke: trail` and a cannon authors `puff` — and `fx/projectiles.ts` lays the real in-flight
 * trail from the mod's own `TrailImage`/`TrailInterval`. This is the fallback for a host that
 * publishes no projectile section, so it follows the manifest rather than inventing a second
 * threshold beside the rules table.
 */
const TRAIL_PUFFS = 3

/**
 * Bounded light for one flash: how it grows with the weapon's AUTHORED muzzle scale.
 *
 * Both terms were driven by damage, which put every weapon in the game inside a 2x band. The
 * authored scale spans 0.07 to 1.25, so a pistol now throws a 2.4 m pool and an eight-inch gun a
 * 6.5 m one. The colour is the family's own emitter normalised to unit peak, so the light on the
 * ground agrees with the flash above it instead of being warm under a blue coil discharge.
 */
const LIGHT_BASE_INTENSITY = 0.16
const LIGHT_SCALE_INTENSITY = 0.55
const LIGHT_BASE_RADIUS = 2.2
const LIGHT_SCALE_RADIUS = 3.4
/** The fallback emitter for an unresolved weapon: warm propellant ignition, as before. */
const LIGHT_R = 1.0
const LIGHT_G = 0.32
const LIGHT_B = 0.055
/**
 * Metres the muzzle emission is displaced along the barrel, per style.
 *
 * Zero for every gun. A rocket's launch signature comes out of the BACK of the tube, so its
 * smoke belongs behind the firing point rather than in front of it, and that is a cue the eye
 * reads before it has resolved anything else about the shot.
 */
const SMOKE_AXIS_OFFSET = new Float32Array(MUZZLE_STYLE_COUNT)
SMOKE_AXIS_OFFSET[MuzzleStyle.exhaust] = -0.55

interface SparkResponse {
	/** `false` selects Foundry warm emission; `true` selects Lattice cool emission. */
	readonly cool: boolean
	/** Physical response amplitude. Stiff surfaces throw a larger, brighter core. */
	readonly scale: number
}

// Every §8 surface is explicit. The same surface byte drives audio and this visual response,
// so a wet/frozen hit cannot sound soft while being rendered as a hard orange metal strike.
// Fluid, snow and crystalline resource reflections use the cool emitter; dry and hard contact
// stays warm. An out-of-range bridge value degrades to soil rather than disappearing.
const SPARK_RESPONSE_BY_NAME: Record<keyof typeof Surface, SparkResponse> = {
	soil: { cool: false, scale: 0.82 },
	rock: { cool: false, scale: 1.16 },
	sand: { cool: false, scale: 0.70 },
	gravel: { cool: false, scale: 1.04 },
	grass: { cool: false, scale: 0.74 },
	road: { cool: false, scale: 1.02 },
	metal: { cool: false, scale: 1.28 },
	concrete: { cool: false, scale: 1.10 },
	water: { cool: true, scale: 0.78 },
	shallow: { cool: true, scale: 0.92 },
	snow: { cool: true, scale: 0.66 },
	ash: { cool: false, scale: 0.64 },
	resource: { cool: true, scale: 1.02 },
}
const SPARK_RESPONSE: SparkResponse[] = []
for (const name of Object.keys(Surface) as (keyof typeof Surface)[])
	SPARK_RESPONSE[Surface[name]] = SPARK_RESPONSE_BY_NAME[name]

/**
 * Write a right-handed transform whose local +X follows `axis`.
 *
 * No position path depends on this outside ordinary instance transforms. Tracers use the
 * authoritative source-to-impact vector as scaleX; bursts use the transmitted reverse
 * incidence as orientation only.
 */
export function writeAxisTransform(
	out: Float32Array,
	o: number,
	x: number,
	y: number,
	z: number,
	axisX: number,
	axisY: number,
	axisZ: number,
	scaleX: number,
	scaleY: number,
	scaleZ: number,
): boolean {
	const len = Math.hypot(axisX, axisY, axisZ)
	if (!(len > 1e-6)) return false
	const xx = axisX / len
	const xy = axisY / len
	const xz = axisZ / len
	// Project a stable reference onto the plane perpendicular to +X. Near vertical, use +Z.
	const refX = 0
	const refY = Math.abs(xy) < 0.9 ? 1 : 0
	const refZ = Math.abs(xy) < 0.9 ? 0 : 1
	const d = xx * refX + xy * refY + xz * refZ
	let yx = refX - xx * d
	let yy = refY - xy * d
	let yz = refZ - xz * d
	const yLen = Math.hypot(yx, yy, yz)
	yx /= yLen; yy /= yLen; yz /= yLen
	const zx = xy * yz - xz * yy
	const zy = xz * yx - xx * yz
	const zz = xx * yy - xy * yx
	out[o] = xx * scaleX; out[o + 1] = xy * scaleX; out[o + 2] = xz * scaleX; out[o + 3] = 0
	out[o + 4] = yx * scaleY; out[o + 5] = yy * scaleY; out[o + 6] = yz * scaleY; out[o + 7] = 0
	out[o + 8] = zx * scaleZ; out[o + 9] = zy * scaleZ; out[o + 10] = zz * scaleZ; out[o + 11] = 0
	out[o + 12] = x; out[o + 13] = y; out[o + 14] = z; out[o + 15] = 1
	return true
}

export interface FxStats {
	readonly active: number
	readonly visible: number
	readonly pendingFires: number
	readonly activeTracers: number
	readonly visibleTracers: number
	readonly activeImpacts: number
	readonly visibleImpacts: number
	readonly activeExplosions: number
	readonly visibleExplosions: number
	readonly drawSubmissions: number
	readonly lights: number
	readonly acceptedEvents: number
	readonly acceptedImpactEvents: number
	readonly acceptedDestroyedEvents: number
	readonly pairedImpacts: number
	/** Of those, the ones that were real Bullet/Missile flights rather than instant hits. */
	readonly pairedFlights: number
	/** Stale unpaired fire records displaced so a live muzzle flash never has to be dropped. */
	readonly evictedFires: number
	/**
	 * Distinct weapon FAMILIES that submitted a flash, and a tracer, this frame.
	 *
	 * The point of the whole per-family split: an observer that only knows a flash was drawn
	 * cannot tell one shape scaled from seven different ones, and this is the cheap counter that
	 * says how many were actually on screen at once.
	 */
	readonly muzzleFamiliesDrawn: number
	readonly tracerFamiliesDrawn: number
	/** Particles released by the authored per-weapon smoke and impact vocabulary. */
	readonly muzzleSmokeSpawns: number
	readonly impactVocabularySpawns: number
	/**
	 * Tracers started over the process lifetime. `activeTracers` counts only the ones alive in
	 * the current frame, and a tracer is shorter-lived than any practical polling interval, so
	 * an observer that samples the live count can watch a whole firefight and see zero.
	 */
	readonly startedTracers: number
	readonly trailPuffs: number
	readonly unpairedImpacts: number
	readonly droppedEvents: number
	readonly malformedEvents: number
	/** Cannon and artillery rounds drawn this frame as a streak on their authoritative flight. */
	readonly shellStreaks: number
	/**
	 * Impacts whose shot had already been drawn in flight, so no muzzle-to-impact line was
	 * replayed after the burst (process lifetime). A shot that never reached a snapshot keeps it.
	 */
	readonly flownImpacts: number
	/** Fires from a visible source with no authored socket, drawn at the rules' muzzle (lifetime). */
	readonly portFires: number
	/** Heals and repairs OpenRA landed (vfx.md Epic 6); drawn only on Ultra and Ultra+. */
	readonly mendImpacts: number
	/** Transient lights refused over the tier's per-frame VFX light capacity (lifetime). */
	readonly lightsCapped: number
	/** Curtained units glowing this frame (actors.status kind 1). */
	readonly curtained: number
	/** Teleports seen (a chronoshift or its return), flashed at both ends on Ultra (lifetime). */
	readonly teleports: number
	/** Spent cases thrown by small arms on Ultra (lifetime). */
	readonly casings: number
	/** Strikes that threw splinters off a tree or a wooden wall (lifetime). */
	readonly woodStrikes: number
	/** Strikes in the shallows (RA River) that threw wet mud instead of a water column (lifetime). */
	readonly mudStrikes: number
	/** GPS satellite launches drawn from a tech centre (lifetime). */
	readonly satelliteLaunches: number
	/** Sonar pulses drawn over water (lifetime). */
	readonly sonarPulses: number
	/** Building collapses and crossings that drew their material layer on Ultra (lifetime). */
	readonly materialLayers: number
	/** Yard deployments that raised stabilizer dust on Ultra (lifetime). */
	readonly deployDust: number
	/** Flame packets that lit a contact fire where they landed, on Ultra (lifetime). */
	readonly contactFires: number
}

type MutableFxStats = { -readonly [K in keyof FxStats]: FxStats[K] }

export interface FxApi {
	/** Current-frame counts plus process-lifetime event diagnostics. */
	readonly stats: FxStats
	/**
	 * Copy live tracer `index`'s world endpoints into `out` as sx,sy,sz,tx,ty,tz.
	 *
	 * Diagnostic. An observer that only knows a tracer EXISTS cannot tell a drawn line from a
	 * muzzle light washing over nearby geometry, and a whole-frame difference cannot either
	 * because temporal antialiasing moves more pixels than the line does. Knowing where the
	 * line is lets a gate compare pixels ON it against pixels beside it in the SAME frame.
	 */
	copyTracer(index: number, out: Float32Array): boolean
	/**
	 * A support power's visible moment that no snapshot carries (vfx.md Epic 7): `satellite` is a
	 * GPS launch rising out of the tech centre at (x, z); `sonar` is a pulse spreading over the
	 * water at (x, z) for `durationS`. Each is drawn only where the viewer sees, like every effect.
	 */
	supportEffect(kind: 'satellite' | 'sonar', x: number, z: number, durationS?: number): void
}

/** A GPS launch climbs for this long: out of the tech centre and past the camera. */
const SATELLITE_S = 3
/** Rings in one sonar pulse, and the seconds between pulses while the detector lives. */
const SONAR_RINGS = 5
const SONAR_PULSE_S = 2.5
/** How far from a strike a tree or a wooden wall still throws splinters, in WPos (0.8 m). */
const WOOD_REACH_WPOS = 820

export class Fx implements FxApi {
	private readonly particles = new SoftParticles()
	private readonly scorch = new ImpactScorch()
	/** The staged nuclear stages beyond the mushroom (Ultra and Ultra+). */
	private readonly nuclear = new NuclearStrike()
	/** Ultra's budget governor: thins decorative density under load, nothing else. */
	private readonly governor = new VfxGovernor()
	/** Decorative density this frame: the tier's, thinned by the governor on Ultra. */
	private get decorative(): number { return this.budget.decorativeDensity * this.governor.scale }
	/** VFX lights left this frame (fx/vfx-budget `lightCapacity`); a nuclear flash is exempt. */
	private lightsLeft = 0
	private readonly lightGate = {
		addLight: (x: number, y: number, z: number, r: number, g: number, b: number, intensity: number, radius: number): void => {
			if (this.render === null) return
			if (this.lightsLeft <= 0) { this.stats.lightsCapped++; return }
			this.lightsLeft--
			this.render.addLight(x, y, z, r, g, b, intensity, radius)
			this.stats.lights++
		},
	}
	/** The quality's VFX tier (fx/vfx-budget). Followed every frame: the player can switch it live. */
	private budget: VfxBudgetConfig = vfxBudgetFor('')
	private setBudget(quality: string): void {
		this.budget = vfxBudgetFor(quality)
		this.particles.configure(this.budget.particleCapacity, this.budget.coverageBudget)
		this.scorch.configure(this.budget.scorchCapacity)
		if (!this.budget.combatLayers) this.nuclear.clear()
	}
	private readonly stackSmoke = new StackSmoke()
	/** Hurt actors trail smoke; see fx/damage-smoke for the shared-pool budget. */
	private readonly damageSmoke = new DamageSmoke()
	/** Dual engine wakes on airborne fixed-wing. */
	private readonly aircraftContrails = new AircraftContrails()
	/** Building deaths only. Vehicles, infantry and props keep the burst below. */
	readonly mushroom = new MushroomCloud()
	private readonly parachutes = new ParachuteCanopies()
	/** Ultra: the dust, sand, powder or spray a helicopter blows up when it flies low. */
	private readonly downwash = new RotorDownwash()
	private readonly curtainDomes = new CurtainDomes()
	private readonly crates = new CrateMarkers()
	/** Vehicle deaths only (deathKind 2): staged flash, fireball, delayed pops, column. */
	readonly cookoff = new VehicleCookoff()
	private readonly burstPos = new Float32Array(3)
	/**
	 * A Heavy/Critical crossing is a live building taking a serious hit: a short burst of
	 * debris and dust — fire once the ruin is Critical — plus ground fire at Critical.
	 */
	private readonly onRungTransition = (actorId: number, rung: number): void => {
		if (!this.ctx || !this.shroud) return
		const severity = this.mushroom.burst(actorId, rung, this.effectTime, this.ctx, this.terrain,
			this.shroud, this.particles, this.burstPos)
		if (severity > 0 && this.budget.combatLayers) this.materialLayer(actorId, severity >= 2 ? 0.7 : 0.45)
		if (severity >= 2) {
			this.groundFire.igniteBlast(
				this.burstPos[0], this.burstPos[1], this.burstPos[2], this.effectTime, 0.9, this.ctx, this.terrain, this.shroud)
		}
	}
	/** The type of an actor at its death: the current snapshot, else the previous one it left. */
	private typeAtDeath(id: number): string {
		const ctx = this.ctx
		if (!ctx) return ''
		for (const snap of [ctx.snapshot, ctx.prevSnapshot]) {
			const a = snap?.actors
			if (!a) continue
			const i = findActorIndex(a, id)
			if (i >= 0) return ctx.actorTypeName(a.typeId[i])
		}
		return ''
	}
	/** Chronoshifts whose two ends still shimmer (Ultra+). */
	private readonly chronoShimmers: { fx: number; fy: number; fz: number; tx: number; ty: number; tz: number; start: number }[] = []
	/** Deployments already dusted, by the new actor's id; bounded, cleared on a new match. */
	private readonly dustedDeployments = new Set<number>()
	/**
	 * Ultra: an MCV unpacking into a yard sets its stabilizers down in a ring of dust off the
	 * ground it stands on (the deployments section, ARCHITECTURE §4.10b). Once per deployment and
	 * only at its start: a yard first seen half unpacked was not just set down.
	 */
	private stabilizerDust(ctx: Ctx, shroud: ShroudApi): void {
		const records = ctx.snapshot?.deployments
		if (!records || records.count === 0) return
		const v = records.view
		for (let i = 0; i < records.count; i++) {
			const o = records.byteOffset + i * 32, id = v.getUint32(o, true)
			if (this.dustedDeployments.has(id)) continue
			this.dustedDeployments.add(id)
			if (this.dustedDeployments.size > 64) this.dustedDeployments.clear()
			const frame = v.getUint16(o + 22, true), frames = v.getUint16(o + 24, true)
			if (frames > 1 && frame / (frames - 1) > 0.25) continue
			const x = v.getInt32(o + 8, true) * WPOS_TO_M, z = v.getInt32(o + 12, true) * WPOS_TO_M
			if (!shroud.isVisible(Math.floor(x), Math.floor(z))) continue
			const ground = this.terrain?.heightAt(x, z) ?? 0
			const surface = this.terrain?.surfaceAt?.(x, z) ?? Surface.soil
			const preset = surface === Surface.sand ? 'hazesand' : surface === Surface.snow ? 'hazesnow' : surface === Surface.rock || surface === Surface.concrete || surface === Surface.road ? 'hazerock' : 'dustskirt'
			for (let k = 0; k < 8; k++) {
				const a = k / 8 * Math.PI * 2 + 0.3, r = 1.6
				this.particles.spawn(preset, x + Math.cos(a) * r, ground + 0.05, z + Math.sin(a) * r, this.effectTime, id * 31 + k, 1.1, shroud, this.decorative, Math.cos(a), 0.1, Math.sin(a), 0.4)
			}
			this.stats.deployDust++
		}
	}

	/** What the building the cloud just acted on is made of, on top of the cloud (Ultra). */
	private materialLayer(actorId: number, strength: number): void {
		const b = this.mushroom.last
		// Only the building this call is about: a second event for a cloud already burning
		// starts nothing and leaves `last` describing another building.
		if (!this.shroud || b.actorId !== actorId || b.template === '') return
		// Consumed: a replayed event for the same building finds nothing to layer again.
		b.actorId = -1
		if (spawnBuildingMaterial(b.template, b.x, b.y, b.z, b.tall, b.span, this.effectTime, actorId * 2654435761 + Math.floor(this.effectTime * 25),
			strength, this.decorative, this.particles, this.shroud) > 0) this.stats.materialLayers++
	}
	private readonly groundFire = new GroundFire()
	private readonly groundTracks = new GroundTracks()
	private readonly navalWakes = new NavalWakes()
	private readonly utilityWater = new UtilityWater()
	private readonly teslaArc = new TeslaArc()
	/**
	 * §4 section 5, in `fx/projectiles.ts`: rockets that are actually in the air.
	 *
	 * Owned separately because it consumes a SECTION rather than an event, and it draws only
	 * TRAVELLING bodies. The Tesla bolt is `teslaArc` above and is not touched here: an
	 * instantaneous weapon has no flight to follow.
	 */
	private readonly projectiles = new Projectiles()
	private arcMesh: GpuMesh | null = null
	private arcItem: DrawItem | null = null
	/** Ultra: the bolt's white-hot core and its translucent violet fringe (fx/tesla-arc). */
	private arcCoreItem: DrawItem | null = null
	private arcFringeItem: DrawItem | null = null
	get particleStats() { return this.particles.stats }
	/** Authored stacks resolved, held and released — so a gate can prove smoke reaches a frame. */
	get stackSmokeStats() { return this.stackSmoke.stats }
	get damageSmokeStats() { return this.damageSmoke.stats }
	get aircraftContrailStats() { return this.aircraftContrails.stats }
	get groundFireStats() { return this.groundFire.stats }
	get utilityWaterStats() { return this.utilityWater.stats }
	get groundTrackStats() { return this.groundTracks.stats }
	get navalWakeStats() { return this.navalWakes.stats }
	/** Tesla bolts struck, alive and drawn — so a gate can prove the coil is visibly firing. */
	get teslaArcStats() { return this.teslaArc.stats }
	/** Published, drawn and dropped projectiles — so a gate can prove a rocket reaches a frame. */
	get projectileStats() { return this.projectiles.stats }
	get scorchStats() { return this.scorch.stats }
	/** Live scorch marks near a point, for the scenery scan's burnt grass (fx/impact-scorch `gather`). */
	burnMarks(cx: number, cz: number, reach: number, out: Float32Array): number { return this.scorch.gather(this.effectTime, cx, cz, reach, out) }
	get nuclearStats() { return this.nuclear.stats }
	get curtainStats() { return this.curtainDomes.stats }
	get parachuteStats() { return this.parachutes.stats }
	get downwashStats() { return this.downwash.stats }
	get governorStats() { return { scale: this.governor.scale, ...this.governor.stats } }
	get vfxTier() { return this.budget.tier }
	private effectTime = 0
	/** Effect clock of the last nuclear detonation drawn (gates read it). */
	private lastNukeAt = -1e9
	/** The last RECENT_NUKES detonations drawn: when, where and which weapon, to drop a replay. */
	private readonly recentNukeAt = new Float64Array(RECENT_NUKES).fill(-1e9)
	private readonly recentNukeX = new Float32Array(RECENT_NUKES)
	private readonly recentNukeZ = new Float32Array(RECENT_NUKES)
	private readonly recentNukeProfile: (NuclearProfile | null)[] = new Array(RECENT_NUKES).fill(null)
	private recentNukeCursor = 0
	static id = 'fx'
	static deps = ['render', 'shroud', 'units']

	private render: RenderApi | null = null
	/**
	 * The drawn ground. Event positions carry the SIMULATION's elevation, which on a map whose
	 * relief is synthesized in the browser is not the ground a player sees: a shot fired on a
	 * 2.6 m rise reported y=0.088 and drew its tracer two and a half metres underground, where
	 * the terrain depth-tested it away. Every effect is lifted onto the drawn surface here, the
	 * same probe `units` places actors with, so a muzzle flash, a tracer and an impact all land
	 * on the hill they happened on rather than inside it.
	 */
	private terrain: TerrainApi | null = null
	private shroud: ShroudApi | null = null
	/**
	 * Muzzle flashes and tracers, one mesh per authored STYLE and one DrawItem per FAMILY.
	 *
	 * The split is not arbitrary. Shape belongs to the style — `compact`, `star`, `cone`,
	 * `heavy`, `exhaust`, `arc`, `flame` — and two families can share one (a rifle and a machine
	 * gun both draw a `line` tracer). Colour belongs to the family, because that is the grain
	 * the manifest authors it at: all eight cannons share (1, 0.52, 0.14). So the mesh table is
	 * indexed by style and the item table by family, and an item points at its family's mesh.
	 *
	 * `item` and `tracerItem` remain the INERT family's entries: what an unresolved weapon draws,
	 * which is exactly what every weapon drew before this change.
	 */
	private readonly muzzleMeshes: (GpuMesh | null)[] = []
	private readonly muzzleItems: (DrawItem | null)[] = []
	// 9 families x 256 records x 16 floats, twice: 1.18 MB of preallocated transform storage.
	// Deliberately more room than is reachable — the sum of live flashes is still bounded by
	// MAX_FLASHES — because a saturated battlefield must degrade by dropping, never by
	// allocating inside a frame.
	private readonly muzzleInstances: Float32Array[] = []
	private readonly muzzleVisible = new Int32Array(FAMILY_COUNT)
	private readonly tracerMeshes: (GpuMesh | null)[] = []
	private readonly tracerItems: (DrawItem | null)[] = []
	private readonly tracerInstancesByFamily: Float32Array[] = []
	private readonly tracerVisible = new Int32Array(FAMILY_COUNT)
	private item: DrawItem | null = null
	private tracerItem: DrawItem | null = null
	private sparkMesh: GpuMesh | null = null
	private warmSparkItem: DrawItem | null = null
	private coolSparkItem: DrawItem | null = null
	private explosionMesh: GpuMesh | null = null
	private explosionItem: DrawItem | null = null
	private offFire: (() => void) | null = null
	private offImpact: (() => void) | null = null
	private offDamaged: (() => void) | null = null
	private offCrashTrail:(()=>void)|null=null
	private offCrashImpact:(()=>void)|null=null
	private offDestroyed: (() => void) | null = null
	private offNewWorld: (() => void) | null = null
	private ctx: Ctx | null = null

	private count = 0
	private readonly x = new Float32Array(MAX_FLASHES)
	private readonly y = new Float32Array(MAX_FLASHES)
	private readonly z = new Float32Array(MAX_FLASHES)
	private readonly facing = new Uint16Array(MAX_FLASHES)
	private readonly fx = new Float32Array(MAX_FLASHES)
	private readonly fy = new Float32Array(MAX_FLASHES)
	private readonly fz = new Float32Array(MAX_FLASHES)
	private readonly muzzleScratch = new Float32Array(6)
	private readonly weaponClass = new Uint16Array(MAX_FLASHES)
	/**
	 * Authored muzzle scale per weapon TYPE ID, resolved once and kept.
	 *
	 * `weapon-visual-manifest.json` carries 50 profiles with a `muzzle.scaleM` spanning 0.07 for
	 * a pistol to 1.25 for an eight-inch gun, and until now NOTHING IN `web/src` IMPORTED IT.
	 * The flash was sized from damage instead — `0.54 + sqrt(clamp(damage,1,512)) * 0.031` —
	 * which lands every weapon in the game between about 0.45 m and 0.58 m. So a rifleman's
	 * muzzle flash was drawn LONGER THAN THE RIFLEMAN, whose stature is 0.363 m, and
	 * `humanaimgate` duly found the soldier buried under a 200x160 px orange blot at the default
	 * camera height with a 5.5 px silhouette. The authored spread is 18x; what shipped was 1.3x.
	 *
	 * Zero means "not yet resolved" rather than "no flash": a profile that really wants no muzzle
	 * flash is stored as a negative sentinel, so a legitimate zero cannot be mistaken for a miss
	 * and re-looked-up every frame.
	 */
	private readonly muzzleScaleByType = new Map<number, number>()
	/**
	 * The authored profile per weapon TYPE ID, resolved once and kept.
	 *
	 * Resolution happens on the EVENT, not in the frame loop. A flash lives at most 260 ms, so a
	 * string table that arrives late costs one shot its identity and nothing after it, and the
	 * per-frame path never touches a Map, a string or the frozen profile object — it reads the
	 * packed code and the two floats that were copied into fixed arrays at accept time.
	 */
	private readonly styleByType = new Map<number, WeaponVisualStyle>()
	private readonly caliber = new Uint16Array(MAX_FLASHES)
	/** Per-record presentation code and authored muzzle size, copied at accept time. */
	private readonly code = new Uint32Array(MAX_FLASHES)
	private readonly muzzleScale = new Float32Array(MAX_FLASHES)
	private readonly shotActor=new Uint32Array(MAX_FLASHES)
	private readonly shotArm=new Uint16Array(MAX_FLASHES)
	private readonly shotToken=new Uint32Array(MAX_FLASHES)

	/**
	 * The authored muzzle scale for one weapon type id, or `fallback` when the catalogue has no
	 * profile for it. Resolved through the shared string table the emitter writes weapon names
	 * into (`SnapshotEmitter.cs` — `writer.U16(TypeId(record.Weapon))`), cached per type id so
	 * the per-frame path does no string work and allocates nothing.
	 */
	private muzzleScaleFor(typeId: number, fallback: number): number {
		const cached = this.muzzleScaleByType.get(typeId)
		if (cached !== undefined) return cached < 0 ? 0 : cached
		const name = this.ctx?.actorTypeName(typeId) ?? ''
		// An empty table is a real answer on the dev fixture, not an error; fall back and do not
		// cache, because the table can arrive later in the same session.
		if (name === '') return fallback
		const authored = lookupRaWeaponVisual(name).muzzle.scaleM
		this.muzzleScaleByType.set(typeId, authored > 0 ? authored : -1)
		return authored > 0 ? authored : 0
	}

	/**
	 * The authored profile for one weapon type id, or null when the shared string table cannot
	 * name it yet.
	 *
	 * One Map holding the frozen, shared profile object — not a copy — so the whole vocabulary
	 * (style, colour, width, life, smoke, impact) costs one lookup and zero allocation. An empty
	 * table is a real answer on the dev fixture rather than an error, and is deliberately NOT
	 * cached: the host's table can arrive later in the same session.
	 */
	private styleFor(typeId: number): WeaponVisualStyle | null {
		const cached = this.styleByType.get(typeId)
		if (cached !== undefined) return cached
		const name = this.ctx?.actorTypeName(typeId) ?? ''
		if (name === '') return null
		const style = lookupRaWeaponVisual(name)
		this.styleByType.set(typeId, style)
		return style
	}

	private styleNamed(name: string): WeaponVisualStyle | null {
		if (name === '') return null
		const style = lookupRaWeaponVisual(name)
		return style === UNKNOWN_WEAPON_VISUAL ? null : style
	}

	/**
	 * Armament index first: a 4tnk's 120mm and MammothTusk share one actor and must not share
	 * one picture. The fire event's u16 is the weapon's string-table id once the host writes
	 * TypeId(weapon); older FNV hashes fall through to the armament name and then to unknown.
	 */
	private styleForFire(actorId: number, armament: number, typeId: number): WeaponVisualStyle | null {
		const units = this.ctx?.get<UnitsApi>('units')
		const armName = units?.weaponNameOf?.(actorId, armament) ?? ''
		return this.styleNamed(armName) ?? this.styleFor(typeId)
	}

	private readonly age = new Float32Array(MAX_FLASHES)
	private readonly paired = new Uint8Array(MAX_FLASHES)
	private readonly instances = new Float32Array(MAX_FLASHES * 16)

	private tracerCount = 0
	private readonly tracerSourceX = new Float32Array(MAX_TRACERS)
	private readonly tracerSourceY = new Float32Array(MAX_TRACERS)
	private readonly tracerSourceZ = new Float32Array(MAX_TRACERS)
	private readonly tracerTargetX = new Float32Array(MAX_TRACERS)
	private readonly tracerTargetY = new Float32Array(MAX_TRACERS)
	private readonly tracerTargetZ = new Float32Array(MAX_TRACERS)
	private readonly tracerCaliber = new Uint16Array(MAX_TRACERS)
	private readonly tracerAge = new Float32Array(MAX_TRACERS)
	/** The firing weapon's code, authored width in metres and authored life, per tracer. */
	private readonly tracerCode = new Uint32Array(MAX_TRACERS)
	private readonly tracerWidth = new Float32Array(MAX_TRACERS)
	private readonly tracerLife = new Float32Array(MAX_TRACERS)

	private impactCount = 0
	private readonly impactX = new Float32Array(MAX_IMPACTS)
	private readonly impactY = new Float32Array(MAX_IMPACTS)
	private readonly impactZ = new Float32Array(MAX_IMPACTS)
	private readonly incidenceX = new Float32Array(MAX_IMPACTS)
	private readonly incidenceY = new Float32Array(MAX_IMPACTS)
	private readonly incidenceZ = new Float32Array(MAX_IMPACTS)
	private readonly impactSurface = new Uint8Array(MAX_IMPACTS)
	private readonly impactDamage = new Uint16Array(MAX_IMPACTS)
	private readonly impactAge = new Float32Array(MAX_IMPACTS)
	private readonly warmSparkInstances = new Float32Array(MAX_IMPACTS * 16)
	private readonly coolSparkInstances = new Float32Array(MAX_IMPACTS * 16)

	private explosionCount = 0
	private readonly explosionActor = new Uint32Array(MAX_EXPLOSIONS)
	private readonly explosionX = new Float32Array(MAX_EXPLOSIONS)
	private readonly explosionY = new Float32Array(MAX_EXPLOSIONS)
	private readonly explosionZ = new Float32Array(MAX_EXPLOSIONS)
	private readonly explosionViolence = new Uint8Array(MAX_EXPLOSIONS)
	private readonly explosionAge = new Float32Array(MAX_EXPLOSIONS)
	private readonly explosionInstances = new Float32Array(MAX_EXPLOSIONS * 16)

	copyTracer(index: number, out: Float32Array): boolean {
		if (!Number.isInteger(index) || index < 0 || index >= this.tracerCount || out.length < 6) return false
		out[0] = this.tracerSourceX[index]; out[1] = this.tracerSourceY[index]; out[2] = this.tracerSourceZ[index]
		out[3] = this.tracerTargetX[index]; out[4] = this.tracerTargetY[index]; out[5] = this.tracerTargetZ[index]
		return true
	}

	readonly stats: MutableFxStats = {
		active: 0,
		visible: 0,
		pendingFires: 0,
		activeTracers: 0,
		visibleTracers: 0,
		activeImpacts: 0,
		visibleImpacts: 0,
		activeExplosions: 0,
		visibleExplosions: 0,
		drawSubmissions: 0,
		lights: 0,
		acceptedEvents: 0,
		acceptedImpactEvents: 0,
		acceptedDestroyedEvents: 0,
		pairedImpacts: 0,
		pairedFlights: 0,
		evictedFires: 0,
		muzzleFamiliesDrawn: 0,
		tracerFamiliesDrawn: 0,
		muzzleSmokeSpawns: 0,
		impactVocabularySpawns: 0,
		startedTracers: 0,
		trailPuffs: 0,
		unpairedImpacts: 0,
		droppedEvents: 0,
		malformedEvents: 0,
		shellStreaks: 0,
		flownImpacts: 0,
		portFires: 0,
		mendImpacts: 0,
		lightsCapped: 0,
		curtained: 0,
		teleports: 0,
		casings: 0,
		woodStrikes: 0,
		mudStrikes: 0,
		satelliteLaunches: 0,
		sonarPulses: 0,
		materialLayers: 0,
		deployDust: 0,
		contactFires: 0,
	}

	init(ctx: Ctx): void {
		this.ctx = ctx
		this.setBudget(ctx.config.q.name)
		this.render = ctx.get<RenderApi>('render')
		this.terrain = ctx.get<TerrainApi>('terrain')
		this.shroud = ctx.get<ShroudApi>('shroud')

		// One mesh per authored muzzle and tracer STYLE, one DrawItem per FAMILY, built here
		// because uploads happen once and never again.
		//
		// The item table is what carries colour. `DrawItem.emitterColor` is three HDR floats that
		// the renderer puts in the instance tint with a negative alpha, and the forward fragment
		// reads that as "this item supplies its own emitter" instead of the material set's
		// two-entry warm/cool class. Without it every effect in the game is one of two colours by
		// construction, and the fifty authored `tracer.colorLinearRGB` values are unreachable —
		// which is exactly what the tesla bolt found when it asked for cool through a zone and
		// kept drawing warm.
		//
		// The INERT family gets no emitter colour on purpose: an unresolved weapon must keep the
		// engine's own warm propellant emitter, so nothing about a nameless shot changes.
		const emissiveHull = withZoneFlag(Zone.hull, ZoneFlag.emissive)
		for (let style = 0; style < MUZZLE_STYLE_COUNT; style++) {
			const shape = buildMuzzleMesh(style)
			if (shape === null) { this.muzzleMeshes.push(null); continue }
			this.muzzleMeshes.push(this.render.upload(shape, `fx:muzzle-flash:${style}`))
			shape.clear()
		}
		for (let style = 0; style < TRACER_STYLE_COUNT; style++) {
			const shape = buildTracerMesh(style)
			if (shape === null) { this.tracerMeshes.push(null); continue }
			this.tracerMeshes.push(this.render.upload(shape, `fx:instant-hit-tracer:${style}`))
			shape.clear()
		}
		if (this.muzzleMeshes[MuzzleStyle.cone] === null || this.tracerMeshes[TracerStyle.streak] === null)
			throw new Error('fx: the fallback muzzle or tracer meshed to nothing — unnamed weapons would fire invisibly')
		for (let family = 0; family < FAMILY_COUNT; family++) {
			// Fixed storage per family. The sum of live flashes is still bounded by MAX_FLASHES,
			// so this is deliberately more room than is reachable; a pathological burst degrades
			// by dropping instances, never by allocating inside a frame.
			const muzzleInstances = new Float32Array(MAX_FLASHES * 16)
			const tracerInstances = new Float32Array(MAX_TRACERS * 16)
			this.muzzleInstances.push(muzzleInstances)
			this.tracerInstancesByFamily.push(tracerInstances)
			const emitter = family === FxFamily.inert
				? null
				: EMITTER_RGB.subarray(family * 3, family * 3 + 3)
			const muzzleMesh = this.muzzleMeshes[FAMILY_MUZZLE_STYLE[family]] ?? null
			this.muzzleItems.push(muzzleMesh === null ? null : {
				mesh: muzzleMesh,
				surfaceSet: 'foundry',
				instances: muzzleInstances,
				instanceCount: 0,
				playerColors: null,
				castsShadow: false,
				emitterColor: emitter,
			})
			const tracerMesh = this.tracerMeshes[FAMILY_TRACER_STYLE[family]] ?? null
			this.tracerItems.push(tracerMesh === null ? null : {
				mesh: tracerMesh,
				surfaceSet: 'foundry',
				instances: tracerInstances,
				instanceCount: 0,
				playerColors: null,
				castsShadow: false,
				emitterColor: emitter,
			})
		}
		// `item` and `tracerItem` are the fallback family's entries, kept as named fields because
		// they are the ones a gate suppresses to isolate light from mesh.
		this.item = this.muzzleItems[FxFamily.inert]
		this.tracerItem = this.tracerItems[FxFamily.inert]

		// The tesla bolt gets its own mesh because colour lives in the ZONE, not the instance:
		// the tracer is an emissive hull and reads as burning propellant, which is the wrong
		// thing for electricity. Same capsule, cool zone.
		const arc = buildArcMesh()
		this.arcMesh = this.render.upload(arc, 'fx:tesla-arc')
		this.arcItem = {
			mesh: this.arcMesh,
			surfaceSet: 'foundry',
			instances: this.teslaArc.instances,
			instanceCount: 0,
			playerColors: null,
			castsShadow: false,
			// The bolt was drawing WARM ORANGE, and the reason is worth writing down because it
			// defeats the obvious fix. `tesla-arc.ts` builds its mesh with `Zone.optic` on the
			// assumption that a cool zone yields a cool emitter. It does not:
			// `surfaceEmitterColor` keys on the material SET's class byte (foundry warm,
			// lattice cool), and a geo zone selects a texture LAYER inside a set, not the
			// emitter. So an electric discharge lit like burning propellant, which is the one
			// thing it must not look like. Colour comes from the authored manifest family.
			emitterColor: EMITTER_RGB.subarray(FxFamily.electric * 3, FxFamily.electric * 3 + 3),
		}
		// Ultra layers on the same capsule: a thin core hotter and whiter than the channel, and a
		// wide faint violet fringe in the translucent pass, which is what makes the channel glow
		// instead of reading as a lit rod. HDR values sit under the tonemapper shoulder the way
		// weapon-fx FAMILY_PEAK does, so the colour survives to the frame.
		this.arcCoreItem = { mesh: this.arcMesh, surfaceSet: 'foundry', instances: this.teslaArc.coreInstances, instanceCount: 0,
			playerColors: null, castsShadow: false, emitterColor: Float32Array.of(2.9, 3.1, 3.4) }
		this.arcFringeItem = { mesh: this.arcMesh, surfaceSet: 'foundry', instances: this.teslaArc.fringeInstances, instanceCount: 0,
			playerColors: null, castsShadow: false, opacity: 0.3, emitterColor: Float32Array.of(0.95, 0.5, 1.7) }
		arc.clear()

		// A three-dimensional incidence burst, not a decal. Local +X points back toward the
		// source; asymmetric side tongues make a sign or axis swap measurable from any view.
		const sparkShape = sdf.union(
			sdf.sphere(0.055),
			sdf.capsule(0, 0, 0, 0.48, 0, 0, 0.032),
			sdf.capsule(0, 0, 0, 0.31, 0.15, 0.08, 0.025),
			sdf.capsule(0, 0, 0, 0.25, -0.09, -0.16, 0.022),
		)
		const spark = new Mesh()
		sdf.surfaceNets(
			sparkShape,
			sdf.setAabb(sdf.aabb(), -0.08, -0.14, -0.21, 0.54, 0.21, 0.15),
			22,
			spark,
			{ creaseAngle: 34, seal: true },
		)
		if (spark.vertexCount === 0)
			throw new Error('fx: the impact burst meshed to zero vertices')
		for (let vertex = 0; vertex < spark.vertexCount; vertex++) spark.setZone(vertex, emissiveHull)
		this.sparkMesh = this.render.upload(spark, 'fx:impact-burst')
		this.warmSparkItem = {
			mesh: this.sparkMesh,
			surfaceSet: 'foundry',
			instances: this.warmSparkInstances,
			instanceCount: 0,
			playerColors: null,
			castsShadow: false,
		}
		this.coolSparkItem = {
			mesh: this.sparkMesh,
			surfaceSet: 'lattice',
			instances: this.coolSparkInstances,
			instanceCount: 0,
			playerColors: null,
			castsShadow: false,
		}
		spark.clear()

		// A volumetric destruction core. It deliberately has no ground-facing plane: §4.9
		// does not carry a struck-surface normal, and actor destruction is centred on the
		// authoritative actor WPos. The unequal lobes make yaw and scale inspectable.
		const explosionShape = sdf.union(
			sdf.sphere(0.38),
			sdf.translate(sdf.sphere(0.25), 0.31, 0.18, -0.12),
			sdf.translate(sdf.sphere(0.21), -0.22, 0.34, 0.19),
			sdf.capsule(-0.12, 0.04, 0, 0.58, 0.46, 0.17, 0.085),
			sdf.capsule(0.03, 0.02, -0.11, -0.39, 0.58, -0.28, 0.065),
		)
		const explosion = new Mesh()
		sdf.surfaceNets(
			explosionShape,
			sdf.setAabb(sdf.aabb(), -0.55, -0.12, -0.46, 0.72, 0.78, 0.43),
			26,
			explosion,
			{ creaseAngle: 34, seal: true },
		)
		if (explosion.vertexCount === 0)
			throw new Error('fx: the actor-destruction core meshed to zero vertices')
		for (let vertex = 0; vertex < explosion.vertexCount; vertex++)
			explosion.setZone(vertex, emissiveHull)
		this.explosionMesh = this.render.upload(explosion, 'fx:actor-destruction')
		this.explosionItem = {
			mesh: this.explosionMesh,
			surfaceSet: 'foundry',
			instances: this.explosionInstances,
			instanceCount: 0,
			playerColors: null,
			castsShadow: false,
		}
		explosion.clear()

		this.projectiles.init(this.render)
		this.scorch.init(this.render)
		const wakeReservation = this.navalWakes.init(this.render, ctx.config.q.decals)
		this.groundTracks.init(this.render, ctx.config.q.decals - wakeReservation)
		this.utilityWater.init(this.render)

		// SnapshotEvent is a reused dispatch object and the backing snapshot buffer changes on
		// the next poll. The handler therefore copies every retained primitive before returning.
		this.offFire = ctx.events.on<SnapshotEvent>(SimEvent.weaponFire, this.onWeaponFire)
		this.offImpact = ctx.events.on<SnapshotEvent>(SimEvent.projectileImpact, this.onProjectileImpact)
		this.offDamaged = ctx.events.on<SnapshotEvent>(SimEvent.actorDamaged, this.onProjectileImpact)
		this.offCrashTrail=ctx.events.on<AircraftVisualEvent>(CoreEvent.aircraftTrail,this.crashTrail)
  this.offCrashImpact=ctx.events.on<AircraftVisualEvent>(CoreEvent.aircraftImpact,this.crashImpact)
  this.offDestroyed = ctx.events.on<SnapshotEvent>(SimEvent.actorDestroyed, this.onActorDestroyed)
		this.offNewWorld = ctx.events.on(CoreEvent.newWorld, this.resetMatch)
	}

	onSnapshot(snap: Snapshot, prev: Snapshot | null, _ctx: Ctx): void {
		if (prev && snap.tick < prev.tick) this.resetMatch()
	}

	/** Drop match-local FX so a rematch does not open on the previous battlefield. */
	private readonly resetMatch = (): void => {
        this.styleByType.clear();this.muzzleScaleByType.clear()
        this.pendingWeapons.clear()
        this.projectiles.clear()
		this.scorch.clear()
		this.mushroom.clear()
		this.nuclear.clear()
		this.lastNukeAt = -1e9
		this.recentNukeAt.fill(-1e9)
		this.recentNukeProfile.fill(null)
		this.recentNukeCursor = 0
		this.supportEffects.length = 0
		this.dustedDeployments.clear()
		this.chronoShimmers.length = 0
		this.downwash.clear()
		this.parachutes.clear()
		this.crates.clear()
		this.cookoff.clear()
		this.groundFire.clear()
		this.groundTracks.clear()
		this.navalWakes.clear()
		this.utilityWater.clear()
		this.particles.dispose()
		this.teslaArc.clear()
		this.count = 0
		this.tracerCount = 0
		this.impactCount = 0
		this.explosionCount = 0
	}

 private readonly pendingWeapons=new WeaponEvents()
 private readonly consumeWeapon=(event:SnapshotEvent,view:DataView):void=>{if(event.kind===1)this.processWeaponFire(event,view);else this.processProjectileImpact(event,view)}
 private readonly onWeaponFire=(event:SnapshotEvent):void=>{if(!this.pendingWeapons.enqueue(event,this.ctx?.snapshot?.view))this.processWeaponFire(event)}
 private readonly onProjectileImpact=(event:SnapshotEvent):void=>{if(!this.pendingWeapons.enqueue(event,this.ctx?.snapshot?.view))this.processProjectileImpact(event)}
 private readonly processWeaponFire = (event: SnapshotEvent, copiedView?:DataView): void => {
		const snap = this.ctx?.snapshot
		const view = copiedView ?? snap?.view
		const off = event?.offset
		if (
			event == null ||
			view === undefined ||
			!Number.isInteger(off) ||
			!Number.isInteger(event.byteLength) ||
			event.byteLength < FIRE_PAYLOAD_BYTES ||
			off < 0 ||
			off + FIRE_PAYLOAD_BYTES > view.byteLength
		) {
			this.stats.malformedEvents++
			return
		}
		if (this.count >= MAX_FLASHES) {
			// Records are now retained ten times longer so flights can be paired, which makes a
			// full table likelier. Evict the oldest unpaired record rather than dropping the
			// shot that just happened: a missing muzzle flash is visible, a lost pairing is not.
			let oldest = -1
			let oldestAge = MUZZLE_MAX_LIFETIME_S
			for (let k = 0; k < this.count; k++)
				if (this.paired[k] === 0 && this.age[k] > oldestAge) { oldest = k; oldestAge = this.age[k] }
			if (oldest < 0) {
				this.stats.droppedEvents++
				return
			}
			this.count--
			if (oldest !== this.count) {
				this.x[oldest] = this.x[this.count]
				this.y[oldest] = this.y[this.count]
				this.z[oldest] = this.z[this.count]
				this.facing[oldest] = this.facing[this.count]
				this.fx[oldest] = this.fx[this.count]
				this.fy[oldest] = this.fy[this.count]
				this.fz[oldest] = this.fz[this.count]
				this.weaponClass[oldest] = this.weaponClass[this.count]
				this.caliber[oldest] = this.caliber[this.count]
				this.code[oldest] = this.code[this.count]
				this.muzzleScale[oldest] = this.muzzleScale[this.count]
				this.shotActor[oldest]=this.shotActor[this.count];this.shotArm[oldest]=this.shotArm[this.count];this.shotToken[oldest]=this.shotToken[this.count]
				this.age[oldest] = this.age[this.count]
				this.paired[oldest] = this.paired[this.count]
			}
			this.stats.evictedFires++
		}

		const i = this.count++
		// Layout is intentionally read field-by-field. The first i32 begins at byte 6, so a
		// typed-array struct would be unaligned and wrong on the very first coordinate.
		this.x[i] = view.getInt32(off + 6, true) * WPOS_TO_M
		this.z[i] = view.getInt32(off + 10, true) * WPOS_TO_M
		// The fire record opens with the firing actor's id, which is what lets the drawn muzzle
		// sit on its authored barrel. The rules height is a sprite-era value and puts a tank's
		// shot between its tracks; units.muzzleWorldOf replaces that with the 3-D tube tip.
		const firingActor = view.getUint32(off, true)
		const armament = view.getUint16(off + 4, true)
		this.shotActor[i]=firingActor;this.shotArm[i]=armament;this.shotToken[i]=event.byteLength>=30?view.getUint32(off+26,true):0
		this.y[i] = view.getInt32(off + 14, true) * WPOS_TO_M
		this.facing[i] = view.getUint16(off + 18, true) & 1023
		const yaw = wangleToRadians(this.facing[i])
		this.fx[i] = Math.cos(yaw)
		this.fy[i] = 0
		this.fz[i] = -Math.sin(yaw)
		const units = this.ctx?.get<UnitsApi>('units')
		const placed = units?.muzzleWorldOf?.(
			firingActor, armament, this.x[i], this.y[i], this.z[i], this.muzzleScratch,
			event.byteLength>=26?view.getUint16(off+24,true):0,event.byteLength>=30?view.getUint32(off+26,true):1)
		// A missing/hidden source must not manufacture a flash at a generic actor centre. A source
		// the player can see, but whose model authors no socket for this armament (a pillbox's
		// firing port, a garrisoned building), fires from the rules' own muzzle in the event: the
		// port offset OpenRA applied, a verified position, lifted onto the drawn ground. Before
		// this a pillbox fired and hit with nothing on screen at all.
		if (units?.muzzleWorldOf && !placed) {
			if (!(units.isDrawnSource?.(firingActor) ?? false)) { this.count--; return }
			this.y[i] += this.terrain?.presentationHeightOffsetAt?.(this.x[i], this.z[i]) ?? 0
			this.stats.portFires++
		}
		if (placed) {
			this.projectiles.recordLaunch(firingActor,armament,event.byteLength>=26?view.getUint16(off+24,true):0,
				event.byteLength>=30?view.getUint32(off+26,true):0,this.x[i],this.y[i],this.z[i],
				this.muzzleScratch[0],this.muzzleScratch[1],this.muzzleScratch[2],this.effectTime)
			this.x[i] = this.muzzleScratch[0]
			this.y[i] = this.muzzleScratch[1]
			this.z[i] = this.muzzleScratch[2]
			const fl = Math.hypot(this.muzzleScratch[3], this.muzzleScratch[4], this.muzzleScratch[5])
			if (fl > 1e-6) {
				this.fx[i] = this.muzzleScratch[3] / fl
				this.fy[i] = this.muzzleScratch[4] / fl
				this.fz[i] = this.muzzleScratch[5] / fl
			}
		}
		this.weaponClass[i] = view.getUint16(off + 20, true)
		this.caliber[i] = view.getUint16(off + 22, true)
		this.age[i] = 0
		this.paired[i] = 0
		this.stats.acceptedEvents++

		// Identity is resolved HERE, once, and the frame loop reads the two numbers it produced.
		// The style also decides the muzzle emission: `smoke` in the catalogue is a real word per
		// weapon — `none`, `faint`, `puff`, `plume`, `trail`, `soot` — and until now every shot in
		// the game spawned the same 12-particle, 3.8-second `smoke` preset regardless. A rifleman
		// therefore held 45.6 particle-seconds of barrel smoke PER ROUND out of a 2048-slot pool
		// shared with every explosion on the map; he now holds 0.55.
		const style = this.styleForFire(firingActor, armament, this.weaponClass[i])
		const caliberRoot = Math.sqrt(Math.min(Math.max(this.caliber[i], 1), 512))
		this.code[i] = style === null ? FALLBACK_CODE : packWeaponCode(style)
		this.muzzleScale[i] = style === null ? 0.54 + caliberRoot * 0.031 : style.muzzle.scaleM
		const smoke = smokeOf(this.code[i])
		const fireFamily = familyOf(this.code[i])
		// Ultra: a gun clears its bore as directed gas instead of the shipped wisp.
		const gun = this.budget.combatLayers && this.muzzleScale[i] > 0 &&
			(fireFamily === FxFamily.cannon || fireFamily === FxFamily.artillery)
		const preset = gun ? '' : SMOKE_PRESET[smoke]
		if (gun && this.shroud) this.spawnGunGas(i, (snap?.tick ?? 0) * 997 + off)
		// Ultra: a small arm throws its spent case out of the side of the gun.
		if (this.budget.combatLayers && this.shroud && this.muzzleScale[i] > 0 &&
			(fireFamily === FxFamily.bullet || fireFamily === FxFamily.mg)) this.spawnCasing(i, (snap?.tick ?? 0) * 997 + off)
		if (this.shroud && preset !== '') {
			// A rocket's signature leaves the BACK of the tube. Displacing the emission along the
			// authoritative facing is what makes a launch read as a launch rather than as a gun.
			const axis = SMOKE_AXIS_OFFSET[muzzleStyleOf(this.code[i])] * this.muzzleScale[i]
			this.particles.spawn(preset,
				this.x[i] + this.fx[i] * axis, this.y[i] + this.fy[i] * axis, this.z[i] + this.fz[i] * axis,
				this.effectTime, (snap?.tick ?? 0) * 997 + off, SMOKE_SCALE[smoke] * Math.max(.2,Math.min(2,this.muzzleScale[i]/.34)), this.shroud)
			this.stats.muzzleSmokeSpawns++
		}
	}

	/** True when this nuclear record repeats a detonation already drawn; otherwise remembers it. */
	private replayedNuke(profile: NuclearProfile, x: number, z: number): boolean {
		for (let i = 0; i < RECENT_NUKES; i++)
			if (this.recentNukeProfile[i] === profile && Math.abs(this.effectTime - this.recentNukeAt[i]) < NUKE_REARM_S
				&& Math.hypot(x - this.recentNukeX[i], z - this.recentNukeZ[i]) < NUKE_SAME_M) return true
		const slot = this.recentNukeCursor
		this.recentNukeCursor = (slot + 1) % RECENT_NUKES
		this.recentNukeAt[slot] = this.effectTime
		this.recentNukeX[slot] = x
		this.recentNukeZ[slot] = z
		this.recentNukeProfile[slot] = profile
		return false
	}

	private readonly processProjectileImpact = (event: SnapshotEvent,copiedView?:DataView): void => {
		const snap = this.ctx?.snapshot
		const view = copiedView ?? snap?.view
		const off = event?.offset
		if (
			event == null ||
			view === undefined ||
			!Number.isInteger(off) ||
			!Number.isInteger(event.byteLength) ||
			event.byteLength < IMPACT_PAYLOAD_BYTES ||
			off < 0 ||
			off + IMPACT_PAYLOAD_BYTES > view.byteLength
		) {
			this.stats.malformedEvents++
			return
		}

		const x = view.getInt32(off, true) * WPOS_TO_M
		const z = view.getInt32(off + 4, true) * WPOS_TO_M
		const y = view.getInt32(off + 8, true) * WPOS_TO_M + (this.terrain?.presentationHeightOffsetAt?.(x,z) ?? this.terrain?.heightAt(x, z) ?? 0)
		let nx = view.getInt16(off + 12, true) / 32767
		let nz = view.getInt16(off + 14, true) / 32767
		let ny = view.getInt16(off + 16, true) / 32767
		const nLen = Math.hypot(nx, ny, nz)
		if (!(nLen > 1e-6)) {
			this.stats.malformedEvents++
			return
		}
		nx /= nLen; ny /= nLen; nz /= nLen
		if(event.kind===EventKind.actorDamaged&&view.getUint8(off+19)===255)return
		const surface = view.getUint8(off + 18)
		const weaponClass = view.getUint8(off + 19)
		const damage = view.getUint16(off + 20, true)
		// The impact names its weapon: the cloud belongs to the nuclear weapons alone, never to
		// whatever carries as much damage (120mm, TurretGun and Grenade each carry 6000).
		// WeaponInfo.Impact reports a detonation once (its staged warheads follow as delayed
		// impacts), so only a replayed record is dropped: the same weapon at the same place. Each
		// weapon has its own profile (fx/nuclear-strike): the MiniNuke's column is four fifths of
		// the Atomic's on every preset, and Ultra and Ultra+ add the staged flash, dust front and
		// aftermath.
		const nuclear = event.kind === EventKind.projectileImpact && event.byteLength >= 24
			? nuclearProfileFor(this.ctx?.actorTypeName(view.getUint16(off + 22, true)) ?? '') : null
		if (nuclear !== null && !this.replayedNuke(nuclear, x, z)) {
			this.lastNukeAt = this.effectTime
			this.mushroom.nuke(x, y, z, this.effectTime, this.ctx!, this.shroud!, nuclear.rings / ATOMIC.rings, this.budget.combatLayers)
			if (this.budget.combatLayers) this.nuclear.strike(x, y, z, this.effectTime, (snap?.tick ?? 0) * 997 + off, nuclear,
				surface === Surface.water || surface === Surface.shallow, this.decorative, this.shroud!, this.budget.tier === 'ultra-plus')
		}
		this.stats.acceptedImpactEvents++
		const seed = (snap?.tick ?? 0) * 997 + off
		// Only for a strike no weapon can be named for. Red Alert damage runs to thousands, so the
		// old `min(2, sqrt(damage) * .07)` put every hit at the ceiling; a named weapon is sized
		// by what the catalogue authors instead (weapon-fx `impactSizeOf`).
		const impactScale = .3 + Math.min(1, Math.sqrt(damage) * .012)
		const exact=event.kind===EventKind.projectileImpact&&event.byteLength>=34
		const explicitStyle=exact?this.styleFor(view.getUint16(off+22,true)):null
		// A medic's heal or a mechanic's repair lands on a friend: no burst, spark, flash or mark.
		const mend = explicitStyle !== null && explicitStyle.family === 'heal'

		if (!mend && this.impactCount < MAX_IMPACTS) {
			const i = this.impactCount++
			this.impactX[i] = x; this.impactY[i] = y; this.impactZ[i] = z
			this.incidenceX[i] = nx; this.incidenceY[i] = ny; this.incidenceZ[i] = nz
			this.impactSurface[i] = surface < SPARK_RESPONSE.length ? surface : Surface.soil
			this.impactDamage[i] = damage
			this.impactAge[i] = 0
		} else if (!mend) this.stats.droppedEvents++

		// Pair exact authored weapon identity first, then use the transmitted incidence axis to
		// disambiguate simultaneous same-weapon volleys. A tie resolves to the newest fire. A
		// missing match creates only the burst; it never invents a source at the world origin.
		// An instant hit reports its own weapon and warhead, so it is matched on identity and a
		// tight axis. A flight reports neither, so it is matched on time, distance and a looser
		// axis, and only within the window a projectile could still be airborne.
		const flight = event.kind === EventKind.actorDamaged || (event.kind===EventKind.projectileImpact&&event.byteLength>=34)
		const window = flight ? PROJECTILE_PAIR_WINDOW_S : PAIR_WINDOW_S
		let best = -1
		/** The paired weapon's impact word, or -1 while nothing is paired. */
		let impactWord = explicitStyle?impactOf(packWeaponCode(explicitStyle)):-1
		let impactStyle: WeaponVisualStyle | null = explicitStyle
		let bestDot = flight ? PROJECTILE_PAIR_DOT_MIN : PAIR_DOT_MIN
		let bestAge = Infinity
		let bestLen = 0
		for (let i = 0; i < this.count; i++) {
			if (this.paired[i] !== 0 || this.age[i] > window) continue
			if(exact){
				if(this.shotActor[i]===view.getUint32(off+24,true)&&this.shotArm[i]===view.getUint16(off+28,true)&&this.shotToken[i]===view.getUint32(off+30,true)&&this.shotToken[i]>0){best=i;bestLen=Math.hypot(this.x[i]-x,this.y[i]-y,this.z[i]-z);break}
				continue
			}
			if (!flight && this.caliber[i] !== damage) continue
			const dx = this.x[i] - x
			const dy = this.y[i] - y
			const dz = this.z[i] - z
			const len = Math.hypot(dx, dy, dz)
			if (!(len > 1e-4)) continue
			if (flight && len > PROJECTILE_PAIR_MAX_M) continue
			const dot = (dx * nx + dy * ny + dz * nz) / len
			if (dot > bestDot + 1e-7 || (Math.abs(dot - bestDot) <= 1e-7 && this.age[i] < bestAge)) {
				best = i
				bestDot = dot
				bestAge = this.age[i]
				bestLen = len
			}
		}

		// Ultra: the MAD tank's thumps and its detonation are a seismic pulse, not a shell burst.
		if (exact && this.budget.combatLayers && this.shroud && this.terrain) {
			const pulse = MAD_PULSES.get((this.ctx?.actorTypeName(view.getUint16(off + 22, true)) ?? '').toLowerCase())
			if (pulse !== undefined) { this.madPulse(x, y, z, seed, pulse); return }
		}

		if (mend) {
			if (best >= 0) this.paired[best] = 1
			this.stats.mendImpacts++
			if (this.budget.combatLayers && this.shroud) this.spawnMend(view.getUint16(off + 22, true), x, y, z, seed)
			return
		}

		// A shell that was drawn in flight already crossed the screen on its real path; replaying
		// a straight line from the muzzle after it landed would draw it a second time, late.
		const flown = best >= 0 && this.projectiles.wasFlown(this.shotActor[best], this.shotArm[best], this.shotToken[best])
		if (flown) {
			const fireStyle = this.styleFor(this.weaponClass[best])
			impactStyle = fireStyle ?? impactStyle
			impactWord = fireStyle === null ? impactOf(FALLBACK_CODE) : impactOf(packWeaponCode(fireStyle))
			this.paired[best] = 1
			this.stats.pairedImpacts++
			this.stats.flownImpacts++
			if (event.kind === EventKind.actorDamaged || (event.kind === EventKind.projectileImpact && event.byteLength >= 34)) this.stats.pairedFlights++
		} else if (best >= 0 && this.tracerCount < MAX_TRACERS) {
			const i = this.tracerCount++
			this.tracerSourceX[i] = this.x[best]
			this.tracerSourceY[i] = this.y[best]
			this.tracerSourceZ[i] = this.z[best]
			this.tracerTargetX[i] = x
			this.tracerTargetY[i] = y
			this.tracerTargetZ[i] = z
			this.tracerCaliber[i] = damage
			this.tracerAge[i] = 0
			// The impact event names no weapon — its `weaponClass` is a truncated byte for an
			// instant hit and a flat zero for a flight, because no generic OpenRA damage
			// notification carries projectile identity. The PAIRING does: the fire record it just
			// matched holds the u16 the emitter wrote. So a paired impact gets the catalogue's
			// vocabulary and an unpaired one keeps the surface-derived response, which is the
			// honest boundary rather than a guess from damage.
			const fireStyle = this.styleFor(this.weaponClass[best])
			this.tracerCode[i] = fireStyle === null ? FALLBACK_CODE : packWeaponCode(fireStyle)
			impactStyle = fireStyle ?? impactStyle
			this.tracerWidth[i] = fireStyle === null ? 0 : fireStyle.tracer.widthM
			// An unnamed weapon keeps the exact 260 ms constant that shipped, so the degraded
			// path is the previous build rather than a shorter new guess.
			this.tracerLife[i] = fireStyle === null
				? TRACER_LIFETIME_S - TRACER_LIFETIME_FLOOR_S
				: fireStyle.tracer.lifetimeSeconds
			impactWord = impactOf(this.tracerCode[i])
			this.paired[best] = 1
			this.stats.startedTracers++
			this.stats.pairedImpacts++
			// A tesla hits instantly, so the pairing that just resolved a tracer has ALSO
			// resolved both ends of a bolt. The weapon id shares the actor type table, which is
			// how muzzleScaleFor already resolves weapon names.
			if (this.ctx !== null && TeslaArc.isTeslaWeapon(this.ctx.actorTypeName(this.weaponClass[best]))) {
				// Thickness from the weapon's authored width (TTankZap = 1: PortaTesla thinner, the coil
				// thicker); Ultra+ lets a strike fork more.
				const width = fireStyle !== null && fireStyle.tracer.widthM > 0 ? fireStyle.tracer.widthM / 0.09 : 1
				this.teslaArc.strike(this.x[best], this.y[best], this.z[best], x, y, z,
					(snap?.tick ?? 0) * 997 + off, width, this.budget.tier === 'ultra-plus' ? 5 : 3)
				if (this.budget.combatLayers && this.shroud) {
					// The discharge crawls over what it hit and the coil flares where it left.
					this.particles.spawn('teslacrawl', x, y, z, this.effectTime, (snap?.tick ?? 0) * 997 + off + 3, width, this.shroud, this.decorative)
					this.particles.spawn('teslacorona', this.x[best], this.y[best], this.z[best], this.effectTime, (snap?.tick ?? 0) * 997 + off + 5, width, this.shroud)
				}
			}
			if (flight) this.stats.pairedFlights++
			// Continuous flight trails are emitted only from authoritative projectile samples.

		} else {
			if (best >= 0) {
				this.stats.droppedEvents++
				// The table was full, so no tracer exists — but the weapon IS known, so the strike
				// still gets its authored voice rather than degrading to a nameless burst.
				const fireStyle = this.styleFor(this.weaponClass[best])
				impactStyle = fireStyle ?? impactStyle
				impactWord = fireStyle === null ? impactOf(FALLBACK_CODE) : impactOf(packWeaponCode(fireStyle))
			}
			this.stats.unpairedImpacts++
		}

		// WHAT THE STRIKE SOUNDS LIKE TO THE EYE.
		//
		// This used to be one line for the whole game: `dust` unless the surface was water, plus
		// `fire` above 20 damage. Surface and damage — never the weapon — so a bullet chip, a
		// shell burst, an electrical hit and a demolition blast were the same two presets at
		// different sizes, while the catalogue named ten distinct impact words and nothing read
		// them. A paired impact now emits its weapon's own vocabulary; an unpaired one keeps the
		// surface response exactly as before, because with no weapon there is nothing to consult.
		if (this.shroud) {
			const water = surface === Surface.water || surface === Surface.shallow
			if (impactWord < 0) {
				this.particles.spawn(water ? 'splash' : 'dust', x, y, z, this.effectTime, seed, impactScale, this.shroud)
				if (damage > 20) this.particles.spawn('fire', x, y, z, this.effectTime, seed + 1, impactScale, this.shroud)
				if (this.budget.combatLayers)
					this.spawnStrikeMaterial(surface, damage > 20 ? ImpactKind.shell : ImpactKind.chip, x, y, z, seed, impactScale)
			} else {
				// Water still overrides the authored word: a shell that lands in a lake throws
				// water, whatever the weapon says, and the surface byte is the only authority on
				// that. Everything else is the weapon's.
				const presets = water && this.budget.combatLayers ? [] : water ? WATER_IMPACT : IMPACT_PRESETS[impactWord]
				const size = impactStyle !== null ? impactSizeOf(impactStyle) : impactScale
				const scale = size * (water ? 1 : IMPACT_SCALE[impactWord])
				for (let k = 0; k < presets.length; k++) {
					this.particles.spawn(presets[k], x, y, z, this.effectTime, seed + k * 31, scale, this.shroud)
					this.stats.impactVocabularySpawns++
				}
				if (this.budget.combatLayers) this.spawnStrikeMaterial(surface, impactWord, x, y, z, seed, size)
			}
		}
	}

	/**
	 * Ultra: a gun's bore gas driven forward along the barrel, its hot core, and for 90mm and up
	 * the dust the blast lifts off the ground under the muzzle. Sized by the authored muzzle
	 * envelope relative to a 105mm gun, seeded by the event so a replay draws the same cloud.
	 */
	private spawnGunGas(i: number, seed: number): void {
		const shroud = this.shroud!
		const size = this.muzzleScale[i] / 0.7
		const density = this.decorative
		this.particles.spawn('muzzlegas', this.x[i], this.y[i], this.z[i], this.effectTime, seed, size, shroud,
			density, this.fx[i], this.fy[i], this.fz[i], 0.45)
		this.particles.spawn('muzzleglow', this.x[i], this.y[i], this.z[i], this.effectTime, seed + 7, size, shroud,
			1, this.fx[i], this.fy[i], this.fz[i], 0.3)
		this.stats.muzzleSmokeSpawns += 2
		if (this.muzzleScale[i] < HEAVY_GUN_SCALE_M || this.terrain === null) return
		const ground = this.terrain.heightAt(this.x[i], this.z[i])
		// Only a gun near the ground lifts it: not a cruiser's deck gun over water or a turret on a cliff.
		if (this.y[i] - ground > 2.5 || this.terrain.waterHeightAt?.(this.x[i], this.z[i]) != null) return
		this.particles.spawn('muzzledust', this.x[i] + this.fx[i] * 0.4, ground + 0.05, this.z[i] + this.fz[i] * 0.4,
			this.effectTime, seed + 13, size, shroud, density)
		this.stats.muzzleSmokeSpawns++
	}

	/**
	 * The Iron Curtain's visible state (vfx.md §14: "Iron Curtain should not look like fire
	 * damage"): a steady crimson glow on every curtained unit, for as long as OpenRA holds the
	 * `invulnerability` condition (actors.status kind 1). Every preset: this is the power's
	 * missing state, not a new layer. Pooled: at most CURTAIN_LIGHTS a frame, never the cap.
	 */
	private curtainGlow(ctx: Ctx, render: RenderApi, shroud: ShroudApi, terrain: TerrainApi): void {
		this.stats.curtained = 0
		const status = ctx.snapshot?.actorStatus, actors = ctx.snapshot?.actors
		if (!status || !actors) return
		for (let r = 0; r < status.count && this.stats.curtained < CURTAIN_LIGHTS; r++) {
			const o = status.byteOffset + r * 12
			if (status.view.getUint8(o + 4) !== ActorStatusKind.invulnerable) continue
			const i = findActorIndex(actors, status.view.getUint32(o, true))
			if (i < 0) continue
			const x = actors.posX[i] * WPOS_TO_M, z = actors.posY[i] * WPOS_TO_M
			if (!shroud.isVisible(Math.floor(x), Math.floor(z))) continue
			// A slow breath, never a flicker: this is a state, not a hit.
			const breath = 0.85 + 0.15 * Math.sin(this.effectTime * Math.PI * 1.6 + r * 1.7)
			render.addLight(x, terrain.heightAt(x, z) + 0.6, z, 1, 0.1, 0.16, CURTAIN_INTENSITY * breath, CURTAIN_RADIUS_M)
			this.stats.curtained++
		}
	}

	/**
	 * Ultra: one MAD pulse. Every thump reaches the whole of its warhead's Spread (7c0) at once,
	 * so the dust rises on that ring and halfway in, low and wide; the detonation is the same
	 * pulse three times as dense, a blast at the tank, and cratered ground out to the ring
	 * (its LeaveSmudge Crater, Size 7).
	 */
	private madPulse(x: number, y: number, z: number, seed: number, detonation: boolean): void {
		const shroud = this.shroud!, t = this.effectTime, density = this.decorative * (detonation ? 3 : 1)
		for (const [radius, count, scale] of MAD_RINGS) {
			const n = Math.max(1, Math.round(count * density))
			for (let k = 0; k < n; k++) {
				const a = (k + 0.7 * hash01(seed + k * 31 + radius)) * Math.PI * 2 / n
				const r = radius * (0.9 + 0.15 * hash01(seed + k * 17 + 7))
				const c = Math.cos(a), sn = Math.sin(a)
				this.particles.spawn('dustfront', x + c * r, y + 0.05, z + sn * r, t, seed + k * 13 + radius, scale, shroud, 1, c, 0.1, sn, 0.6)
			}
			this.stats.impactVocabularySpawns += n
		}
		if (!detonation) return
		this.particles.spawn('fireball', x, y + 0.3, z, t, seed + 3, 1.4, shroud)
		this.particles.spawn('blastcore', x, y + 0.3, z, t, seed + 5, 1.2, shroud)
		this.scorch.stamp(x, z, 3, seed + 11, t, shroud, 32, true)
		for (let k = 0; k < 8; k++) {
			const a = (k + 0.5 * hash01(seed + k)) * Math.PI / 4
			this.scorch.stamp(x + Math.cos(a) * 4.2, z + Math.sin(a) * 4.2, 2.6, seed + 17 + k, t, shroud, 32, true)
		}
	}

	/** Snapshot tick of the last teleport scan: once per tick, not once per frame. */
	private teleportTick = -1
	/**
	 * Ultra: a chronoshift (or its return) flashes where the unit left and where it arrived. A
	 * teleport is a jump no actor can make in one tick (units/index draws it as a jump, never a
	 * slide, on every preset); each end flashes only where the player can see.
	 */
	private chronoFlashes(ctx: Ctx, shroud: ShroudApi, terrain: TerrainApi): void {
		const snap = ctx.snapshot, prev = ctx.prevSnapshot
		if (!snap || !prev || snap.tick === this.teleportTick) return
		this.teleportTick = snap.tick
		const a = snap.actors, p = prev.actors
		if (!a || !p) return
		for (let i = 0; i < a.count; i++) {
			const j = findActorIndex(p, a.id[i])
			if (j < 0 || Math.abs(a.posX[i] - p.posX[j]) + Math.abs(a.posY[i] - p.posY[j]) <= TELEPORT_WPOS) continue
			this.stats.teleports++
			const seed = (a.id[i] * 2654435761 + snap.tick * 31) | 0
			const fx = p.posX[j] * WPOS_TO_M, fz = p.posY[j] * WPOS_TO_M, tx = a.posX[i] * WPOS_TO_M, tz = a.posY[i] * WPOS_TO_M
			this.particles.spawn('chronoflash', fx, terrain.heightAt(fx, fz) + 0.3, fz, this.effectTime, seed, 1, shroud)
			this.particles.spawn('chronoflash', tx, terrain.heightAt(tx, tz) + 0.3, tz, this.effectTime, seed + 7, 1, shroud)
			if (this.budget.tier === 'ultra-plus') {
				this.chronoShimmers.push({ fx, fy: terrain.heightAt(fx, fz), fz, tx, ty: terrain.heightAt(tx, tz), tz, start: this.effectTime })
				if (this.chronoShimmers.length > 4) this.chronoShimmers.shift()
			}
		}
	}

	/**
	 * Ultra+: the space a chronoshifted unit leaves bends and closes (departure distortion) while
	 * the arrival bends open and settles (reformation), each for a fraction of a second, through the
	 * post pass's heat shimmer. Then, the gap generator's field shimmer: a faint bend at the emitter
	 * of each visible own or allied MGG (entitled viewers only; the shroud it throws stays
	 * OpenRA's). Called after the nuclear strikes, which keep the shimmer slots first, and after
	 * this frame's jumps are found.
	 */
	private shimmers(ctx: Ctx, render: RenderApi, shroud: ShroudApi): void {
		if (!render.addHeatSource) return
		for (let k = this.chronoShimmers.length - 1; k >= 0; k--) {
			const c = this.chronoShimmers[k], age = this.effectTime - c.start
			if (age < 0 || age > CHRONO_SHIMMER_S) { this.chronoShimmers.splice(k, 1); continue }
			const out = 1 - age / CHRONO_SHIMMER_S, back = Math.min(1, age / (CHRONO_SHIMMER_S * 0.4)) * out
			if (shroud.isVisible(Math.floor(c.fx), Math.floor(c.fz))) render.addHeatSource(c.fx, c.fy + 0.6, c.fz, 1.3, 2.6 * out * out)
			if (shroud.isVisible(Math.floor(c.tx), Math.floor(c.tz))) render.addHeatSource(c.tx, c.ty + 0.6, c.tz, 1.3, 2.6 * back)
		}
		const a = ctx.snapshot?.actors, me = ctx.snapshot?.world?.renderPlayer
		if (!a || me === undefined) return
		for (let i = 0; i < a.count; i++) {
			if (ctx.actorTypeName(a.typeId[i]) !== 'mgg' || a.health[i] === 0 || (a.flags[i] & ActorFlag.husk) !== 0) continue
			const owner = a.owner[i], allied = owner === me || ctx.snapshot?.players?.some(p => p.id === owner && p.relation === 1)
			const x = a.posX[i] * WPOS_TO_M, z = a.posY[i] * WPOS_TO_M
			if (!allied || !shroud.isVisible(Math.floor(x), Math.floor(z))) continue
			render.addHeatSource(x, (this.terrain?.heightAt(x, z) ?? 0) + 1.3, z, 0.9, 0.9)
		}
	}

	/**
	 * Ultra: the feedback of a support action (vfx.md Epic 6, "restrained repair sparks or
	 * feedback, no magic healing lasers"). A repair throws a small fountain of weld sparks off the
	 * hull; a heal leaves a few faint motes rising off the soldier. Nothing travels from the
	 * healer, and it is drawn where OpenRA landed the heal, so a heal the sim refused draws nothing.
	 */
	private spawnMend(weapon: number, x: number, y: number, z: number, seed: number): void {
		const repair = (this.ctx?.actorTypeName(weapon) ?? '').toLowerCase() === 'repair'
		// Heights are a vehicle's hull top and an infantryman's shoulders (the medic's kit socket
		// sits at 0.17 m, a medium tank's muzzle at 0.53 m); lower, the 3D grass swallows the motes.
		if (repair) this.particles.spawn('weldspark', x, y + 0.3, z, this.effectTime, seed + 41, 1, this.shroud!, 1, 0, 1, 0, 1.4)
		else this.particles.spawn('mendglow', x, y + 0.22, z, this.effectTime, seed + 43, 1, this.shroud!, 1, 0, 1, 0, 1.2)
		this.stats.impactVocabularySpawns++
	}

	/** Whether a tree or a wooden wall (its rules Armor.Type) stands where a strike landed. */
	private woodAt(x: number, z: number): boolean {
		const actors = this.ctx?.snapshot?.actors
		const units = this.ctx?.get<UnitsApi>('units')
		if (!actors || !units?.materialOf) return false
		const wx = x * 1024, wz = z * 1024
		for (let i = 0; i < actors.count; i++) {
			if (Math.abs(actors.posX[i] - wx) > WOOD_REACH_WPOS || Math.abs(actors.posY[i] - wz) > WOOD_REACH_WPOS) continue
			const material = units.materialOf(actors.typeId[i])
			if (material === 'tree' || material === 'wood') return true
		}
		return false
	}

	/**
	 * Ultra: a small arm's spent case, thrown out of the side of the gun and up, from a little
	 * behind the muzzle where the ejection port sits. A barrel pointing straight up (an AA mount)
	 * has no side to throw from and throws nothing.
	 */
	private spawnCasing(i: number, seed: number): void {
		const fx = this.fx[i], fz = this.fz[i], len = Math.hypot(fx, fz)
		if (len < 1e-3) return
		const sideX = -fz / len, sideZ = fx / len
		const back = 0.12 * Math.min(2, this.muzzleScale[i] / 0.34)
		this.particles.spawn('casing', this.x[i] - fx / len * back, this.y[i], this.z[i] - fz / len * back,
			this.effectTime, seed + 19, 1, this.shroud!, 1, sideX * 0.8, 0.6, sideZ * 0.8, 0.5)
		this.stats.casings++
	}

	private readonly supportEffects: { kind: 'satellite' | 'sonar'; x: number; z: number; start: number; end: number; next: number; seed: number; step: number }[] = []

	supportEffect(kind: 'satellite' | 'sonar', x: number, z: number, durationS = 10): void {
		if (!Number.isFinite(x) || !Number.isFinite(z)) return
		const start = this.effectTime
		const seed = (Math.floor(x * 64) * 73856093 ^ Math.floor(z * 64) * 19349663 ^ Math.floor(start * 25)) | 0
		this.supportEffects.push({ kind, x, z, start, end: start + (kind === 'satellite' ? SATELLITE_S : Math.max(0.5, durationS)), next: start, seed, step: 0 })
		if (this.supportEffects.length > 8) this.supportEffects.shift()
		if (kind === 'satellite') this.stats.satelliteLaunches++
		else this.stats.sonarPulses++
	}

	/**
	 * The staged support moments. A GPS satellite climbs out of the tech centre on its exhaust,
	 * accelerating, and leaves a white column standing; a sonar pulse sends rings out over the
	 * water every SONAR_PULSE_S for as long as OpenRA keeps its detector alive. Both are seeded
	 * by where and when they started, so a replay draws the same.
	 */
	private tickSupportEffects(shroud: ShroudApi, terrain: TerrainApi | null): void {
		const t = this.effectTime
		for (let k = this.supportEffects.length - 1; k >= 0; k--) {
			const e = this.supportEffects[k]
			if (t >= e.end || t < e.start - 1) { this.supportEffects.splice(k, 1); continue }
			if (t < e.next) continue
			const ground = terrain?.heightAt(e.x, e.z) ?? 0
			if (e.kind === 'satellite') {
				e.next = t + 0.04
				const age = t - e.start, h = 0.8 + 4.5 * age * age
				this.particles.spawn('satplume', e.x, ground + h, e.z, t, e.seed + e.step * 7, 1, shroud, 1, 0, -1, 0, 0.25)
				if (age < 2.2) this.particles.spawn('satsmoke', e.x, ground + h - 0.3, e.z, t, e.seed + e.step * 11 + 3, 1, shroud)
				this.lightGate.addLight(e.x, ground + h, e.z, 1, 0.55, 0.2, 1.2, 4)
			} else {
				const pulse = Math.floor(e.step / SONAR_RINGS), ring = e.step % SONAR_RINGS
				e.next = ring === SONAR_RINGS - 1 ? e.start + (pulse + 1) * SONAR_PULSE_S : t + 0.16
				const water = terrain?.waterHeightAt?.(e.x, e.z) ?? ground
				const radius = 1 + ring * 1.6, n = 14 + ring * 4
				for (let j = 0; j < n; j++) {
					const a = (j + 0.5 * hash01(e.seed + e.step * 31 + j)) * Math.PI * 2 / n
					const c = Math.cos(a), sn = Math.sin(a)
					this.particles.spawn('sonarping', e.x + c * radius, water + 0.05, e.z + sn * radius, t, e.seed + e.step * 97 + j, 1, shroud, 1, c, 0, sn, 0.2)
				}
			}
			e.step++
		}
	}

	/**
	 * Ultra: what the struck surface throws and leaves hanging. An explosive strike (shell,
	 * heavy shell, blast, burn) lifts surface-coloured haze that outlives the burst and throws the
	 * surface's own debris: clods from earth, chips from rock and concrete, sparks off metal.
	 * Water gets a column and mist instead of a crater. A bullet only puffs the ground it hits.
	 */
	private spawnStrikeMaterial(surface: number, word: number, x: number, y: number, z: number, seed: number, size: number): void {
		const shroud = this.shroud!
		const density = this.decorative
		const t = this.effectTime
		const explosive = word === ImpactKind.shell || word === ImpactKind['heavy-shell'] || word === ImpactKind.blast || word === ImpactKind.burn
		if (surface === Surface.shallow) {
			// RA's River: a shallow bed, so a strike throws wet mud and a brown spray, not the
			// clear column of open water; a bullet only kicks up a little of it.
			if (explosive) {
				this.particles.spawn('mudsplash', x, y, z, t, seed + 101, size, shroud, density, 0, 1, 0, 0.55)
				this.particles.spawn('mudclods', x, y + 0.05, z, t, seed + 117, size, shroud, density)
				this.particles.spawn('watermist', x, y + 0.05, z, t, seed + 103, size * 0.6, shroud, 0.5 * density)
				this.stats.impactVocabularySpawns += 3
			} else {
				this.particles.spawn('mudsplash', x, y, z, t, seed + 115, size * 0.45, shroud, 0.5 * density)
				this.stats.impactVocabularySpawns++
			}
			this.stats.mudStrikes++
			return
		}
		if (surface === Surface.water) {
			if (!explosive && word !== ImpactKind.water) return
			this.particles.spawn('splashcolumn', x, y, z, t, seed + 101, size, shroud, density, 0, 1, 0, 0.35)
			this.particles.spawn('watermist', x, y + 0.1, z, t, seed + 103, size, shroud, density)
			this.stats.impactVocabularySpawns += 2
			return
		}
		const haze = STRIKE_HAZE[surface] ?? '', debris = STRIKE_DEBRIS[surface] ?? ''
		// A tree or a wooden wall on the struck spot throws splinters as well as its ground's own debris.
		const wood = this.woodAt(x, z)
		if (wood) this.stats.woodStrikes++
		// A flame packet lights a short contact fire where it lands (it cools to smoke and goes out).
		if (word === ImpactKind.burn && surface !== Surface.metal && this.groundFire.igniteContact(x, y, z, t, shroud)) this.stats.contactFires++
		if (explosive) {
			if (surface !== Surface.metal) this.scorch.stamp(x, z, size * 1.3, seed + 113, t, shroud)
			if (haze !== '') { this.particles.spawn(haze, x, y + 0.05, z, t, seed + 105, size, shroud, density); this.stats.impactVocabularySpawns++ }
			if (debris !== '') { this.particles.spawn(debris, x, y + 0.05, z, t, seed + 107, size, shroud, density); this.stats.impactVocabularySpawns++ }
			if (wood) { this.particles.spawn('woodchips', x, y + 0.4, z, t, seed + 119, size, shroud, density); this.stats.impactVocabularySpawns++ }
		} else if (wood) {
			this.particles.spawn('woodchips', x, y + 0.4, z, t, seed + 121, size * 0.5, shroud, 0.5 * density); this.stats.impactVocabularySpawns++
		} else if (surface === Surface.metal) {
			this.particles.spawn('armorsparks', x, y, z, t, seed + 109, size, shroud, density); this.stats.impactVocabularySpawns++
		} else if (haze !== '') {
			this.particles.spawn(haze, x, y + 0.03, z, t, seed + 111, size * 0.5, shroud, 0.4 * density); this.stats.impactVocabularySpawns++
		}
	}

	private readonly crashTrail=(e:AircraftVisualEvent):void=>{
  if(this.shroud)this.particles.spawn('smoke',e.x,e.y,e.z,e.time,e.id+Math.floor(e.time*25),.35,this.shroud)
 }
 private readonly crashImpact=(e:AircraftVisualEvent):void=>{
  const shroud=this.shroud;if(!shroud||!shroud.isVisible(Math.floor(e.x),Math.floor(e.z)))return
  this.particles.spawn(e.water?'splash':'dust',e.x,e.y+.05,e.z,e.time,e.id,1.6,shroud)
  // The crash explodes where it strikes: the same burst a destroyed vehicle gets, not dust alone.
  this.particles.spawn('smoke',e.x,e.y+.2,e.z,e.time,e.id+1,1.3,shroud)
  if(!e.water){
   this.particles.spawn('fire',e.x,e.y+.2,e.z,e.time,e.id+2,1.3,shroud)
   this.particles.spawn('debris',e.x,e.y+.2,e.z,e.time,e.id+3,1.3,shroud)
  }
  if(!e.water&&this.terrain&&this.ctx)this.groundFire.igniteBlast(e.x,e.y,e.z,e.time,1.2,this.ctx,this.terrain,shroud)
 }
 private readonly onActorDestroyed = (event: SnapshotEvent): void => {
		const snap = this.ctx?.snapshot
		const view = snap?.view
		const off = event?.offset
		if (
			event == null ||
			view === undefined ||
			!Number.isInteger(off) ||
			!Number.isInteger(event.byteLength) ||
			event.byteLength < DESTROYED_PAYLOAD_BYTES ||
			off < 0 ||
			off + DESTROYED_PAYLOAD_BYTES > view.byteLength
		) {
			this.stats.malformedEvents++
			return
		}
		// Organic bodies use the retained unit mesh fall/fade, never a vehicle fireball.
		const units = this.ctx?.get<UnitsApi>('units')
		if(this.ctx?.get<{crashOwnsHusk?:(id:number)=>boolean}>('units')?.crashOwnsHusk?.(view.getUint32(off,true)))return
		const kind = units?.deathKindOf(view.getUint32(off,true)) ?? 0
		if (kind !== 2 && kind !== 4 && kind !== 5) { this.stats.acceptedDestroyedEvents++; return }
		if (this.explosionCount >= MAX_EXPLOSIONS) {
			this.stats.droppedEvents++
			return
		}

		const i = this.explosionCount++
		this.explosionActor[i] = view.getUint32(off, true)
		this.explosionX[i] = view.getInt32(off + 4, true) * WPOS_TO_M
		this.explosionZ[i] = view.getInt32(off + 8, true) * WPOS_TO_M
		const airAltitude=units?.deathAltitudeOf(this.explosionActor[i])
		this.explosionY[i] = airAltitude ?? view.getInt32(off + 12, true) * WPOS_TO_M
		this.explosionViolence[i] = view.getUint8(off + 17)
		this.explosionAge[i] = 0
		this.stats.acceptedDestroyedEvents++
		if (this.shroud) {
			// A building collapses into a staged mushroom cloud (fx/mushroom-cloud) and an
			// armoured death cooks off in stages (fx/vehicle-cookoff); everything else keeps
			// the one-shot burst. False from either means "not mine, or refused", and the
			// burst below still owes this actor an explosion either way.
			const structural = this.ctx !== null &&
				this.mushroom.start(this.explosionActor[i], this.explosionX[i], this.explosionY[i], this.explosionZ[i],
					this.explosionViolence[i], this.effectTime, this.ctx, this.terrain, this.shroud)
			if (structural && this.budget.combatLayers) this.materialLayer(this.explosionActor[i], 1)
			// The jammer and the gap generator die as electrical hardware: sparks and a crawl (Ultra).
			if (!structural && this.budget.combatLayers && this.ctx && ELECTRICAL_VEHICLES.has(this.typeAtDeath(this.explosionActor[i]))) {
				const x = this.explosionX[i], z = this.explosionZ[i]
				if (spawnBuildingMaterial('power', x, this.terrain?.heightAt(x, z) ?? this.explosionY[i], z, 1.2, 1.8, this.effectTime,
					this.explosionActor[i] * 2654435761, 0.8, this.decorative, this.particles, this.shroud) > 0) this.stats.materialLayers++
			}
			const cooked = !structural && kind === 2 && this.ctx !== null &&
				this.cookoff.start(this.explosionActor[i], this.explosionX[i], this.explosionY[i], this.explosionZ[i],
					this.explosionViolence[i], this.effectTime, this.ctx, this.terrain, this.shroud)
			const scale = .6 + this.explosionViolence[i]/255
			if (!structural && !cooked) {
				this.particles.spawn('smoke',this.explosionX[i],this.explosionY[i]+.2,this.explosionZ[i],this.effectTime,this.explosionActor[i],scale,this.shroud)
				this.particles.spawn('fire',this.explosionX[i],this.explosionY[i]+.2,this.explosionZ[i],this.effectTime,this.explosionActor[i],scale,this.shroud)
				this.particles.spawn('debris',this.explosionX[i],this.explosionY[i]+.2,this.explosionZ[i],this.effectTime,this.explosionActor[i],scale,this.shroud)
			}
			if (airAltitude == null && this.ctx) this.groundFire.igniteBlast(
				this.explosionX[i], this.explosionY[i], this.explosionZ[i], this.effectTime,
				structural ? 2.6 : 1.2, this.ctx, this.terrain, this.shroud)
		}
	}

	update(dt: number, _ctx: Ctx): void {
		this.effectTime = (_ctx.time.tick + _ctx.time.alpha) / 25
		if (vfxBudgetFor(_ctx.config.q.name) !== this.budget) this.setBudget(_ctx.config.q.name)
		this.governor.update(dt * 1000, this.budget.governed)
		this.lightsLeft = this.budget.lightCapacity
		this.pendingWeapons.drain(this.consumeWeapon)
		if (this.render && this.shroud) this.particles.update(this.effectTime,this.render,this.shroud)
		// Stacks emit BEFORE the pool is submitted, so a puff released this frame is drawn this
		// frame rather than one frame late.
		if (this.shroud) this.stackSmoke.tick(dt, this.effectTime, _ctx, this.particles, this.shroud, this.terrain)
		if (this.shroud) this.damageSmoke.tick(dt, this.effectTime, _ctx, this.particles, this.shroud, this.terrain)
		if (this.shroud) this.aircraftContrails.tick(dt, this.effectTime, _ctx, this.particles, this.shroud, this.terrain)
		if (this.budget.combatLayers && this.shroud) this.downwash.tick(this.effectTime, this.decorative, _ctx, this.particles, this.shroud, this.terrain)
		if (this.budget.combatLayers && this.shroud) this.stabilizerDust(_ctx, this.shroud)
		if (this.shroud && this.ctx) this.ctx.get<UnitsApi>('units')?.drainRungTransitions(this.onRungTransition)
		if (this.render && this.shroud)
			this.projectiles.update(dt, this.effectTime, _ctx.time.alpha, _ctx, this.render, this.shroud,
				this.terrain, this.ctx?.get<UnitsApi>('units') ?? null, this.particles, this.budget.combatLayers, this.lightGate)
		if (this.shroud) this.mushroom.tick(this.effectTime, this.particles, this.shroud)
		if (this.render && this.shroud) this.nuclear.tick(this.effectTime, this.particles, this.render, this.scorch, this.shroud)
		if (this.render && this.shroud && this.terrain) this.curtainGlow(_ctx, this.render, this.shroud, this.terrain)
		if (this.render && this.shroud && this.terrain) this.curtainDomes.update(_ctx, this.ctx?.get<UnitsApi>('units') ?? null, this.render, this.terrain, this.shroud, this.effectTime)
		if (this.budget.combatLayers && this.shroud && this.terrain) this.chronoFlashes(_ctx, this.shroud, this.terrain)
		// After the strikes (they keep the shimmer slots first) and the jumps this frame found.
		if (this.budget.tier === 'ultra-plus' && this.render && this.shroud) this.shimmers(_ctx, this.render, this.shroud)
		if (this.shroud && this.supportEffects.length > 0) this.tickSupportEffects(this.shroud, this.terrain)
		if (this.render && this.shroud) this.scorch.tick(this.effectTime, this.render, this.terrain, this.shroud)
		const snapActors = _ctx.snapshot?.actors
		if (snapActors && this.render && this.ctx) {
			this.parachutes.update(this.ctx, snapActors, this.ctx.get<UnitsApi>('units'), this.render, this.projectiles.chutes)
			this.crates.update(this.ctx, snapActors, this.ctx.get<UnitsApi>('units'), this.render)
		}
		if (this.shroud && this.ctx) this.groundFire.tick(dt, this.effectTime, this.particles, this.shroud, this.terrain, this.ctx)
		if (this.render && this.shroud && this.ctx)
			this.groundTracks.tick(this.effectTime, this.ctx, this.render, this.terrain, this.shroud)
		if (this.render && this.shroud) this.utilityWater.tick(this.effectTime, _ctx.config.q.name, _ctx.get<UnitsApi>('units'), this.render, this.terrain, this.shroud)
		if (this.render && this.shroud) this.navalWakes.tick(this.effectTime, _ctx, _ctx.get<UnitsApi>('units'), this.render, this.terrain, this.shroud)
		const render = this.render
		const shroud = this.shroud
		const item = this.item
		const tracerItem = this.tracerItem
		const warmSparkItem = this.warmSparkItem
		const coolSparkItem = this.coolSparkItem
		const explosionItem = this.explosionItem
		if (!render || !shroud || !item || !tracerItem || !warmSparkItem || !coolSparkItem || !explosionItem) return

		this.stats.active = 0
		this.stats.visible = 0
		this.stats.pendingFires = 0
		this.stats.activeTracers = 0
		this.stats.visibleTracers = 0
		this.stats.activeImpacts = 0
		this.stats.visibleImpacts = 0
		this.stats.activeExplosions = 0
		this.stats.visibleExplosions = 0
		this.stats.drawSubmissions = 0
		this.stats.lights = 0
		this.stats.muzzleFamiliesDrawn = 0
		this.stats.tracerFamiliesDrawn = 0
		this.muzzleVisible.fill(0)
		this.tracerVisible.fill(0)
		let alive = 0
		let visible = 0
		for (let read = 0; read < this.count; read++) {
			const age = this.age[read]
			const style = muzzleStyleOf(this.code[read])
			const flashAlive = age < MUZZLE_LIFETIME_S[style]
			// An unpaired fire is kept as evidence for the impact that has not arrived yet, not
			// as something drawn: a projectile's impact can be more than a second behind it.
			const retain = this.paired[read] === 0 ? age < PROJECTILE_PAIR_WINDOW_S : flashAlive
			if (!retain) continue

			// Compact every live flash, including a hidden one. Visibility is presentation state,
			// not lifetime: a flash must not wait behind the fog and appear after it should be dead.
			if (alive !== read) {
				this.x[alive] = this.x[read]
				this.y[alive] = this.y[read]
				this.z[alive] = this.z[read]
				this.facing[alive] = this.facing[read]
				this.fx[alive] = this.fx[read]
				this.fy[alive] = this.fy[read]
				this.fz[alive] = this.fz[read]
				this.weaponClass[alive] = this.weaponClass[read]
				this.caliber[alive] = this.caliber[read]
				this.code[alive] = this.code[read]
				this.muzzleScale[alive] = this.muzzleScale[read]
				this.shotActor[alive]=this.shotActor[read];this.shotArm[alive]=this.shotArm[read];this.shotToken[alive]=this.shotToken[read]
				this.age[alive] = age
				this.paired[alive] = this.paired[read]
			}

			const x = this.x[alive]
			const y = this.y[alive]
			const z = this.z[alive]
			const isVisible = shroud.isVisible(Math.floor(x), Math.floor(z))
			if (flashAlive) this.stats.active++
			if (flashAlive && isVisible) {
				// The authored scale and the authored SHAPE. `muzzle.scaleM` was already read;
				// `muzzle.style` was not, by anything, ever — so a rifle and a tank drew one
				// object 5x apart in size and identical in every other respect. The style now
				// selects a different mesh, a different life and a different light, and the
				// damage-derived expression survives only as the fallback for a weapon the
				// catalogue does not name.
				// Ultra: a flash blooms and collapses instead of holding one solid size for its whole
				// life, which is what made a cannon's flash read as a lit object rather than a blast.
				const lifeFraction = Math.min(1, age / MUZZLE_LIFETIME_S[style])
				const scale = this.muzzleScale[alive] * (this.budget.combatLayers ? flashEnvelope(lifeFraction) : 1)
				const fade = 1 - age / MUZZLE_LIFETIME_S[style]
				// Some weapons authored `scaleM: 0` because they have no muzzle at all — a dog's
				// bite, a medic's kit, a demolition charge. They used to draw a warm flash and a
				// warm light like everything else. Skip both: a zero-scale instance is a degenerate
				// transform, and an orange point light on a healing beam is worse than nothing.
				const family = familyOf(this.code[alive])
				const buffer = style === MuzzleStyle.none ? null : this.muzzleInstances[family] ?? null
				if (scale <= 0 || buffer === null) { this.age[alive] = age + Math.max(dt, 0); alive++; continue }
				let fwx = this.fx[alive], fwy = this.fy[alive], fwz = this.fz[alive]
				let flen = Math.hypot(fwx, fwy, fwz)
				if (!(flen > 1e-6)) {
					const yaw = wangleToRadians(this.facing[alive])
					fwx = Math.cos(yaw); fwy = 0; fwz = -Math.sin(yaw); flen = 1
				}
				fwx /= flen; fwy /= flen; fwz /= flen
				let rx = -fwz, ry = 0, rz = fwx
				let rlen = Math.hypot(rx, ry, rz)
				if (rlen < 1e-6) { rx = 1; ry = 0; rz = 0; rlen = 1 }
				rx /= rlen; ry /= rlen; rz /= rlen
				const ux = fwy * rz - fwz * ry
				const uy = fwz * rx - fwx * rz
				const uz = fwx * ry - fwy * rx
				const slot = this.muzzleVisible[family]
				const o = slot * 16
				const m = buffer
				m[o] = fwx * scale; m[o + 1] = fwy * scale; m[o + 2] = fwz * scale; m[o + 3] = 0
				m[o + 4] = ux * scale; m[o + 5] = uy * scale; m[o + 6] = uz * scale; m[o + 7] = 0
				m[o + 8] = rx * scale; m[o + 9] = ry * scale; m[o + 10] = rz * scale; m[o + 11] = 0
				m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1
				this.muzzleVisible[family] = slot + 1
				visible++

				// A transient light is the far-camera signal. Both terms follow the AUTHORED
				// muzzle scale, which spans 0.07 to 1.25, rather than the damage that used to
				// drive them and put every weapon in the game inside a 2x band. The colour is the
				// family's own emitter at unit peak, so the pool on the ground agrees with the
				// flash above it — a coil discharge no longer lights the mud orange.
				const e = family * 3
				const peak = family === FxFamily.inert
					? 0
					: Math.max(EMITTER_RGB[e], Math.max(EMITTER_RGB[e + 1], EMITTER_RGB[e + 2]))
				this.lightGate.addLight(
					x, y, z,
					peak > 0 ? EMITTER_RGB[e] / peak : LIGHT_R,
					peak > 0 ? EMITTER_RGB[e + 1] / peak : LIGHT_G,
					peak > 0 ? EMITTER_RGB[e + 2] / peak : LIGHT_B,
					(LIGHT_BASE_INTENSITY + scale * LIGHT_SCALE_INTENSITY) * fade * fade,
					LIGHT_BASE_RADIUS + scale * LIGHT_SCALE_RADIUS,
				)
			}

			this.age[alive] = age + Math.max(dt, 0)
			alive++
		}

		this.count = alive
		this.stats.pendingFires = alive
		this.stats.visible = visible
		for (let family = 0; family < FAMILY_COUNT; family++) {
			const count = this.muzzleVisible[family]
			const familyItem = this.muzzleItems[family] ?? null
			if (count <= 0 || familyItem === null) continue
			const mutable = familyItem as { -readonly [K in keyof DrawItem]: DrawItem[K] }
			mutable.instanceCount = count
			render.submit(familyItem)
			this.stats.drawSubmissions++
			this.stats.muzzleFamiliesDrawn++
		}

		let tracerAlive = 0
		let tracerVisible = 0
		for (let read = 0; read < this.tracerCount; read++) {
			const age = this.tracerAge[read]
			// Life is the weapon's own, floored so the shortest authored value still spans five
			// frames at 60 Hz. It was one 260 ms constant for a silenced pistol and a V2 alike.
			const life = TRACER_LIFETIME_FLOOR_S + this.tracerLife[read] * TRACER_LIFETIME_GAIN
			if (age >= life) continue
			if (tracerAlive !== read) {
				this.tracerSourceX[tracerAlive] = this.tracerSourceX[read]
				this.tracerSourceY[tracerAlive] = this.tracerSourceY[read]
				this.tracerSourceZ[tracerAlive] = this.tracerSourceZ[read]
				this.tracerTargetX[tracerAlive] = this.tracerTargetX[read]
				this.tracerTargetY[tracerAlive] = this.tracerTargetY[read]
				this.tracerTargetZ[tracerAlive] = this.tracerTargetZ[read]
				this.tracerCaliber[tracerAlive] = this.tracerCaliber[read]
				this.tracerCode[tracerAlive] = this.tracerCode[read]
				this.tracerWidth[tracerAlive] = this.tracerWidth[read]
				this.tracerLife[tracerAlive] = this.tracerLife[read]
				this.tracerAge[tracerAlive] = age
			}
			const sx = this.tracerSourceX[tracerAlive]
			const sy = this.tracerSourceY[tracerAlive]
			const sz = this.tracerSourceZ[tracerAlive]
			const tx = this.tracerTargetX[tracerAlive]
			const ty = this.tracerTargetY[tracerAlive]
			const tz = this.tracerTargetZ[tracerAlive]
			const sourceVisible = shroud.isVisible(Math.floor(sx), Math.floor(sz))
			const targetVisible = shroud.isVisible(Math.floor(tx), Math.floor(tz))
			const tracerStyle = tracerStyleOf(this.tracerCode[tracerAlive])
			const tracerFamily = familyOf(this.tracerCode[tracerAlive])
			const nominalR = TRACER_NOMINAL_R[tracerStyle]
			const tracerBuffer = nominalR > 0 ? this.tracerInstancesByFamily[tracerFamily] ?? null : null
			// `arc` and `none` write nothing here. An instantaneous electrical weapon resolves
			// both ends through this same pairing and fx/tesla-arc draws the bolt between them;
			// the warm dash that used to be laid on top of it was a second, wrongly-coloured line
			// under every zap.
			if (sourceVisible && targetVisible && tracerBuffer !== null && tracerFamily !== FxFamily.rocket && tracerFamily !== FxFamily.torpedo) {
				const fade = Math.max(0.12, 1 - age / life)
				// Size the line by how far the camera is from it, so a shell reads the same
				// whether the player is watching a duel up close or a battle from altitude.
				// A fixed world radius is the reason firing was invisible at gameplay zoom.
				// Walk a short streak along the path instead of drawing the whole path at once.
				const pathX = tx - sx, pathY = ty - sy, pathZ = tz - sz
				const pathLen = Math.hypot(pathX, pathY, pathZ)
				const streak = Math.min(
					pathLen * TRACER_STREAK_FRACTION[tracerStyle], TRACER_STREAK_MAX_M[tracerStyle])
				const span = pathLen > 1e-4 ? streak / pathLen : 1
				// The head starts a full streak ahead of the muzzle, so the very first frame already
				// draws a dash. Advancing from zero gave the streak zero length on frame one and
				// the transform rejected it as degenerate: the shot's first and brightest moment
				// drew nothing at all.
				const head = Math.min(1, span + (1 - span) * (age / life))
				const tail = Math.max(0, head - span)
				const hx = sx + pathX * head, hy = sy + pathY * head, hz = sz + pathZ * head
				const bx = sx + pathX * tail, by = sy + pathY * tail, bz = sz + pathZ * tail
				const eye = render.camera.position
				const distance = Math.hypot(
					(bx + hx) * 0.5 - eye[0], (by + hy) * 0.5 - eye[1], (bz + hz) * 0.5 - eye[2])
				// WIDTH IS THE CATALOGUE'S, not damage's. It used to be
				// `TRACER_PIXEL_WIDTH * ... * (0.72 + sqrt(caliber) * 0.018)` — a bore inferred
				// from a balance number, so a 36-damage carbine and a 400-damage warhead came out
				// 1.30x apart while their authored widths are 11x apart. The on-screen floor that
				// keeps a tracer legible at gameplay zoom is kept and scaled by the authored width
				// instead, referenced to the rifleman's 0.016 m so his shot holds exactly the
				// 2.1 px that was calibrated and everything heavier grows from there.
				const authoredWidth = this.tracerWidth[tracerAlive]
				const widthGain = authoredWidth > 0 ? Math.sqrt(authoredWidth / TRACER_REFERENCE_WIDTH_M) : 1
				const wanted = Math.max(
					authoredWidth * 0.5,
					TRACER_PIXEL_WIDTH * TRACER_METRES_PER_PIXEL * distance * 0.5 * widthGain)
				const radius = Math.min(TRACER_MAX_R, Math.max(TRACER_MIN_R, wanted))
				const thickness = radius / nominalR * fade
				const slot = this.tracerVisible[tracerFamily]
				if (writeAxisTransform(
					tracerBuffer,
					slot * 16,
					bx, by, bz,
					hx - bx, hy - by, hz - bz,
					Math.hypot(hx - bx, hy - by, hz - bz), thickness, thickness,
				)) {
					this.tracerVisible[tracerFamily] = slot + 1
					tracerVisible++
				}
			}
			this.tracerAge[tracerAlive] = age + Math.max(dt, 0)
			tracerAlive++
		}
		// Shells in flight on their authoritative position (fx/projectiles publishes them), in the
		// same family draw items and the same pixel-floored width as the tracers above.
		const shells = this.projectiles.shells
		let shellStreaks = 0
		for (let k = 0; k < shells.count; k++) {
			const style = shells.style[k]
			if (style === null) continue
			const code = packWeaponCode(style)
			const shellStyle = tracerStyleOf(code), family = familyOf(code)
			const nominalR = TRACER_NOMINAL_R[shellStyle]
			const buffer = nominalR > 0 ? this.tracerInstancesByFamily[family] ?? null : null
			const slot = this.tracerVisible[family]
			if (buffer === null || slot >= MAX_TRACERS) continue
			const len = Math.min(SHELL_STREAK_MAX_M, shells.speed[k] * SHELL_STREAK_TICKS, shells.travelled[k])
			if (!(len > 0.02)) continue
			const hx = shells.x[k], hy = shells.y[k], hz = shells.z[k]
			const bx = hx - shells.dx[k] * len, by = hy - shells.dy[k] * len, bz = hz - shells.dz[k] * len
			const eye = render.camera.position
			const distance = Math.hypot((bx + hx) * 0.5 - eye[0], (by + hy) * 0.5 - eye[1], (bz + hz) * 0.5 - eye[2])
			const authoredWidth = style.tracer.widthM
			const widthGain = authoredWidth > 0 ? Math.sqrt(authoredWidth / TRACER_REFERENCE_WIDTH_M) : 1
			const wanted = Math.max(authoredWidth * 0.5, TRACER_PIXEL_WIDTH * TRACER_METRES_PER_PIXEL * distance * 0.5 * widthGain)
			const thickness = Math.min(TRACER_MAX_R, Math.max(TRACER_MIN_R, wanted)) / nominalR
			if (writeAxisTransform(buffer, slot * 16, bx, by, bz, hx - bx, hy - by, hz - bz, len, thickness, thickness)) {
				this.tracerVisible[family] = slot + 1
				shellStreaks++
			}
		}
		this.stats.shellStreaks = shellStreaks
		this.tracerCount = tracerAlive
		this.stats.activeTracers = tracerAlive
		this.stats.visibleTracers = tracerVisible
		for (let family = 0; family < FAMILY_COUNT; family++) {
			const count = this.tracerVisible[family]
			const familyItem = this.tracerItems[family] ?? null
			if (count <= 0 || familyItem === null) continue
			const mutable = familyItem as { -readonly [K in keyof DrawItem]: DrawItem[K] }
			mutable.instanceCount = count
			render.submit(familyItem)
			this.stats.drawSubmissions++
			this.stats.tracerFamiliesDrawn++
		}

		// Tesla bolts. Built after the tracers because they share the pairing that produced them,
		// and submitted separately because a bolt is a cool emissive and a tracer is a hot one.
		const arcItem = this.arcItem
		if (arcItem !== null) {
			const eye = render.camera.position
			let arcLights = 0
			const arcSegments = this.teslaArc.build(dt, shroud, eye[0], eye[1], eye[2], writeAxisTransform, this.budget.combatLayers,
				(lx, ly, lz, intensity, radius) => {
					// Pooled: a battle of coils lights the ground, it does not flood it.
					if (arcLights >= TESLA_LIGHTS_PER_FRAME) return
					arcLights++
					this.lightGate.addLight(lx, ly, lz, 0.55, 0.72, 1.0, intensity, radius)
				})
			if (arcSegments > 0) {
				const mutable = arcItem as { -readonly [K in keyof DrawItem]: DrawItem[K] }
				mutable.instanceCount = arcSegments
				render.submit(arcItem)
				this.stats.drawSubmissions++
			}
			for (const [item, count] of [[this.arcCoreItem, this.teslaArc.stats.coreSegments], [this.arcFringeItem, this.teslaArc.stats.fringeSegments]] as const) {
				if (item === null || count <= 0) continue
				;(item as { instanceCount: number }).instanceCount = count
				render.submit(item)
				this.stats.drawSubmissions++
			}
		}

		let impactAlive = 0
		let impactVisible = 0
		let warmVisible = 0
		let coolVisible = 0
		for (let read = 0; read < this.impactCount; read++) {
			const age = this.impactAge[read]
			if (age >= IMPACT_LIFETIME_S) continue
			if (impactAlive !== read) {
				this.impactX[impactAlive] = this.impactX[read]
				this.impactY[impactAlive] = this.impactY[read]
				this.impactZ[impactAlive] = this.impactZ[read]
				this.incidenceX[impactAlive] = this.incidenceX[read]
				this.incidenceY[impactAlive] = this.incidenceY[read]
				this.incidenceZ[impactAlive] = this.incidenceZ[read]
				this.impactSurface[impactAlive] = this.impactSurface[read]
				this.impactDamage[impactAlive] = this.impactDamage[read]
				this.impactAge[impactAlive] = age
			}
			const x = this.impactX[impactAlive]
			const y = this.impactY[impactAlive]
			const z = this.impactZ[impactAlive]
			const isVisible = shroud.isVisible(Math.floor(x), Math.floor(z))
			if (isVisible) {
				const response = SPARK_RESPONSE[this.impactSurface[impactAlive]] ?? SPARK_RESPONSE[Surface.soil]
				const root = Math.sqrt(Math.min(Math.max(this.impactDamage[impactAlive], 1), 512))
				const fade = Math.max(0.10, 1 - age / IMPACT_LIFETIME_S)
				const scale = response.scale * (0.56 + root * 0.022) * fade
				const out = response.cool ? this.coolSparkInstances : this.warmSparkInstances
				const index = response.cool ? coolVisible : warmVisible
				if (writeAxisTransform(
					out,
					index * 16,
					x, y, z,
					this.incidenceX[impactAlive], this.incidenceY[impactAlive], this.incidenceZ[impactAlive],
					scale, scale, scale,
				)) {
					if (response.cool) coolVisible++
					else warmVisible++
					impactVisible++
				}
			}
			this.impactAge[impactAlive] = age + Math.max(dt, 0)
			impactAlive++
		}
		this.impactCount = impactAlive
		this.stats.activeImpacts = impactAlive
		this.stats.visibleImpacts = impactVisible
		if (warmVisible > 0) {
			const mutable = warmSparkItem as { -readonly [K in keyof DrawItem]: DrawItem[K] }
			mutable.instanceCount = warmVisible
			render.submit(warmSparkItem)
			this.stats.drawSubmissions++
		}
		if (coolVisible > 0) {
			const mutable = coolSparkItem as { -readonly [K in keyof DrawItem]: DrawItem[K] }
			mutable.instanceCount = coolVisible
			render.submit(coolSparkItem)
			this.stats.drawSubmissions++
		}

		let explosionAlive = 0
		let explosionVisible = 0
		for (let read = 0; read < this.explosionCount; read++) {
			const age = this.explosionAge[read]
			if (age >= EXPLOSION_LIFETIME_S) continue
			if (explosionAlive !== read) {
				this.explosionActor[explosionAlive] = this.explosionActor[read]
				this.explosionX[explosionAlive] = this.explosionX[read]
				this.explosionY[explosionAlive] = this.explosionY[read]
				this.explosionZ[explosionAlive] = this.explosionZ[read]
				this.explosionViolence[explosionAlive] = this.explosionViolence[read]
				this.explosionAge[explosionAlive] = age
			}
			const x = this.explosionX[explosionAlive]
			const y = this.explosionY[explosionAlive]
			const z = this.explosionZ[explosionAlive]
			const isVisible = shroud.isVisible(Math.floor(x), Math.floor(z))
			if (isVisible) {
				const violence = this.explosionViolence[explosionAlive] / 255
				const life = Math.min(1, age / EXPLOSION_LIFETIME_S)
				const envelope = Math.sin(Math.PI * Math.min(1, life * 1.18))
				const scale = (0.82 + 0.72 * violence) * (0.38 + 1.15 * envelope)
				// ActorID supplies a deterministic orientation without consuming shared RNG.
				const yaw = (this.explosionActor[explosionAlive] * 0.61803398875 % 1) * Math.PI * 2
				const c = Math.cos(yaw)
				const s = Math.sin(yaw)
				const o = explosionVisible * 16
				const m = this.explosionInstances
				m[o] = c * scale; m[o + 1] = 0; m[o + 2] = -s * scale; m[o + 3] = 0
				m[o + 4] = 0; m[o + 5] = scale; m[o + 6] = 0; m[o + 7] = 0
				m[o + 8] = s * scale; m[o + 9] = 0; m[o + 10] = c * scale; m[o + 11] = 0
				m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1
				explosionVisible++

				const fade = 1 - life
				this.lightGate.addLight(
					x, y + 0.22 * scale, z,
					1.0, 0.20 + 0.12 * violence, 0.025,
					(0.7 + 1.1 * violence) * fade * fade,
					3.8 + 3.2 * violence,
				)
			}
			this.explosionAge[explosionAlive] = age + Math.max(dt, 0)
			explosionAlive++
		}
		this.explosionCount = explosionAlive
		this.stats.activeExplosions = explosionAlive
		this.stats.visibleExplosions = explosionVisible
		if (explosionVisible > 0) {
			const mutable = explosionItem as { -readonly [K in keyof DrawItem]: DrawItem[K] }
			mutable.instanceCount = explosionVisible
			render.submit(explosionItem)
			this.stats.drawSubmissions++
		}
	}

	dispose(): void {
		this.navalWakes.dispose()
		this.mushroom.clear()
		this.cookoff.clear()
		this.groundFire.clear()
		this.groundTracks.clear()
		this.utilityWater.clear()
		this.particles.dispose()
		this.projectiles.dispose()
		this.offFire?.()
		this.offFire = null
		this.offImpact?.()
		this.offDamaged?.()
		this.offImpact = null
		this.offCrashTrail?.();this.offCrashImpact?.()
		this.offDestroyed?.()
		this.offDestroyed = null
		this.offNewWorld?.()
		this.offNewWorld = null
		this.ctx = null
		this.render = null
		this.terrain = null
		this.shroud = null
		this.item = null
		this.tracerItem = null
		this.muzzleMeshes.length = 0
		this.muzzleItems.length = 0
		this.muzzleInstances.length = 0
		this.tracerMeshes.length = 0
		this.tracerItems.length = 0
		this.tracerInstancesByFamily.length = 0
		this.styleByType.clear()
		this.muzzleScaleByType.clear()
		this.arcMesh = null
		this.arcItem = null
		this.arcCoreItem = null
		this.arcFringeItem = null
		this.sparkMesh = null
		this.warmSparkItem = null
		this.explosionMesh = null
		this.parachutes.dispose()
		this.curtainDomes.dispose()
		this.crates.dispose()
		this.explosionItem = null
		this.count = 0
		this.tracerCount = 0
		this.impactCount = 0
		this.explosionCount = 0
		this.stats.active = 0
		this.stats.visible = 0
		this.stats.pendingFires = 0
		this.stats.activeTracers = 0
		this.stats.visibleTracers = 0
		this.stats.activeImpacts = 0
		this.stats.visibleImpacts = 0
		this.stats.activeExplosions = 0
		this.stats.visibleExplosions = 0
		this.stats.drawSubmissions = 0
		this.stats.lights = 0
		this.stats.muzzleFamiliesDrawn = 0
		this.stats.tracerFamiliesDrawn = 0
	}
}

export default Fx
