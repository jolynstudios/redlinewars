import { CoreEvent, type AircraftVisualEvent } from '../core/events'
import { WeaponEvents } from '../core/weapon-events'
import { EngineVoices, ENGINE_LIMITS } from './engines'
import { Eva } from './eva'
import { sharedMusic } from './music'
import { UiSound } from './ui-sound'
import type { EvaApi, MusicApi, UiSoundApi } from './types'
// STEELSEED — audio
// The game has been silent since the first build session. This is the node that ends that.
//
// §14.8 ruled audio a SIBLING engine rather than a room inside the renderer, on the grounds
// that the two have incompatible internal constraints: an AudioWorklet gets a 128-sample
// quantum — about 2.6 ms at 48 kHz — and missing one is an audible click no temporal filter
// can hide, whereas §7.1's entire degradation ladder is built on the renderer's permission to
// drop a frame. Three things follow, and this file is written to keep all three true:
//
//   1. Audio is gateable WITHOUT A GPU. Everything that decides how a sound is shaped lives in
//      `synth.ts` as pure functions over Float32Array, so `tools/audiogate.mjs` measures the
//      real waveforms in plain Node. This file holds only scheduling and placement.
//   2. Audio never imports the renderer. The listener pose comes from `camera.listenerEye` /
//      `listenerFocus`, published there for exactly this purpose. Reaching into
//      `render.camera` would have been shorter and would have undone the split.
//   3. A consumer who wants no sound ships no sound — hence a node that fails entirely open.
//
// EVERY SOUND IS COMPUTED FROM A SEED. §14.9 restored 13b in full for STEELSEED: `git
// ls-files` returns no binary of any kind, and that includes audio. The bank is ~36 s of
// material rendered from 6.6 MiB of coefficients at first gesture, downloaded as zero bytes.
//
// WHAT DRIVES A SOUND IS SETTLED IN `synth.ts` AND NOT RE-ARGUED HERE, but it has CHANGED, and
// the reason is measured: damage alone put 47 of the 50 authored weapons in one report band and
// cannot order a silenced pistol (15000 damage) below a 120mm tank gun (6000). The voice is now
// chosen by the weapon's FAMILY — derived from the mod's own rules by `tools/weapon-audio.mjs`
// — and scaled continuously by its damage. See the family section of `synth.ts` for the full
// argument, including why this is reading the mod rather than §14.13's forbidden name table.
//
// The u16 at offset 20 of a fire event is NOT the FNV `StableId` the old comment here described.
// `SnapshotEmitter.cs:796` writes `TypeId(record.Weapon)` — an index into the shared string
// table — and `ctx.actorTypeName()` turns it back into the weapon's authored name.
// `fx/index.ts:716` already resolves it that way before asking `TeslaArc.isTeslaWeapon`; this
// node now joins on it too, CASE-INSENSITIVELY, because `Ruleset.Weapons` lowercases its keys
// and a live match has already been seen publishing "dragon" against a table holding "Dragon".

import { ActorFlag, EventKind, HeaderFlag, SimEvent, SNAPSHOT_U16_ABSENT, type Ctx, type Snapshot, type SnapshotEvent, type SystemClass } from '../core'
import {
	bandDamage,
	buildVoiceBank,
	destructionBand,
	FAMILY,
	FAMILY_COUNT,
	heaviness,
	impactBand,
	REPORT_BANDS,
	reportBand,
	renderRain,
	renderThunder,
	SURFACE_VOICING,
	type VoiceBank,
} from './synth'
import type { ListenerApi, ShroudApi, WeatherApi } from './types'
import WEAPON_AUDIO from './weapon-audio.json'

/** WPos is 1024 per cell and one cell is one metre (§12.4). */
const WPOS_TO_M = 1 / 1024

/**
 * Distance at which a sound plays at full level, in metres.
 *
 * The camera legally sits between 12 m and 140 m from its focus, so this is chosen against
 * the CLOSE end of that range: at 25 m a shot under the camera is at full level, and by the
 * far end of the zoom the same shot is at 0.18, which is the perceptual difference between
 * "next to me" and "over there" that a strategy player is actually reading.
 */
const REFERENCE_DISTANCE_M = 25

/** Beyond this a sound is not scheduled at all. Cheaper than mixing something inaudible. */
const MAX_AUDIBLE_M = 400

/**
 * Speed of sound, m/s. Not decoration.
 *
 * A gun 140 m away — an ordinary distance at this camera — is heard 0.41 s after its flash.
 * That gap is the single strongest cue that the battle has depth, it costs one addition
 * because `AudioBufferSourceNode.start(when)` already takes an absolute time, and leaving it
 * out is what makes procedural battle audio sound like a soundboard.
 */
const SPEED_OF_SOUND = 343

/** Nothing is ever hard-panned: a fully-left gunshot on headphones reads as a defect. */
const MAX_PAN = 0.85

/** Per-class trims, so a kill is not the same weight as a rifle shot. */
const GAIN_REPORT = 0.50
/** Riki's recorded report matches her voice at close range after the 0.7 master. */
const GAIN_RIKI_REPORT = 1.15
const GAIN_IMPACT = 0.45
const GAIN_DESTRUCTION = 0.85
/** Death-voice troop class per actor type (rules names, lowercased by the type
 *  table). Personas (e2/e7/spy) resolve separately and never land here. */
const DEATH_VOICE_CLASS: Readonly<Record<string, string>> = {
	e1: 'rifle', e1r1: 'rifle', thf: 'rifle', gnrl: 'rifle',
	einstein: 'rifle', delphi: 'rifle', chan: 'rifle', zombie: 'rifle',
	e3: 'heavy', e3r1: 'heavy', e4: 'heavy', shok: 'heavy',
	e6: 'support', medi: 'support', mech: 'support',
}
/** Notification. Loud, because missing it defeats the purpose. */
const GAIN_NOTIFY = 0.55

/** WDist per tick below which an actor is standing still. ~0.1 m/s at 25 Hz. */
const MIN_MOVING_SPEED = 4
/** WDist per tick at which the engine reaches full pitch. 150/tick is ~3.7 m/s. */
const MOVEMENT_SPEED_FULL = 150
const MOVEMENT_RATE_MIN = 0.72
const MOVEMENT_RATE_MAX = 1.34
/** Playback-rate multipliers per movement class: light runs faster, heavy looms. */
const CLASS_RATE = [1, 1.24, 0.8, 0.95]
const MOVEMENT_SMOOTH_S = 0.12
const GAIN_MOVEMENT = 0.16

/** Default master level. Loud enough to hear over a laptop fan, quiet enough not to clip. */
const DEFAULT_MASTER = 0.7

// ---------------------------------------------------------------------------
// The weapon join.
//
// One Map, built once at module scope, keyed on the LOWERCASED mod weapon name. Every lookup
// after that is by string-table id through a preallocated cache, so the hot path never
// lowercases, never allocates and never touches the Map again for a weapon it has already
// heard fire.
// ---------------------------------------------------------------------------

interface WeaponAudio {
	family: number
	damage: number
	roundIntervalS: number
}

const WEAPON_BY_LOWER_NAME = new Map<string, WeaponAudio>()
for (const [name, row] of Object.entries(WEAPON_AUDIO.weapons as Record<string, WeaponAudio>)) {
	// Last writer would win silently on a casing collision; there are none today and a gate
	// asserts it, but taking the FIRST keeps the behaviour stable if one ever appears.
	if (!WEAPON_BY_LOWER_NAME.has(name.toLowerCase())) WEAPON_BY_LOWER_NAME.set(name.toLowerCase(), row)
}

/**
 * How many string-table ids the per-type caches cover.
 *
 * The table holds actor types and weapon names in one namespace and grows as the simulation
 * first sees each one; RA reaches roughly 250 entries in a full match. 1024 is four times that
 * at 6 KiB of typed array, and an id beyond it simply misses the cache and pays the Map lookup
 * — a slow path, never a wrong one.
 */
const TYPE_CACHE = 1024

/** Sentinel for "this id has not been resolved yet". */
const TYPE_UNRESOLVED = -2
/** Sentinel for "resolved, and the mod has no audio row for it". */
const TYPE_UNKNOWN = -1

/**
 * The family a weapon with no row in the table is voiced as.
 *
 * `cannon`, not silence and not a distinguished "unknown" voice. A weapon the mod added after
 * this table was generated is a REAL weapon that really fired, and the two failure modes on
 * offer are "it sounds like a gun" and "the player learns that some shots make no sound".
 * Rule 8: degrade to the ordinary answer and let the gate find the missing row.
 */
const FALLBACK_FAMILY = FAMILY.cannon
// ---------------------------------------------------------------------------
// Bank-first SFX vocabulary.
//
// Every slug below names a clip the faction banks may carry — rendered by
// `tools/render-sfx-cartesia.mjs`, which owns this list on the render side;
// keep the two in step. A missing clip is not an error: the procedural voice
// above plays instead, so nothing in the game can go silent for it.
// ---------------------------------------------------------------------------

/** Factions without a bank of their own fall to this one (the eva.ts rule). */
const SFX_ALLIED_BANK = 'allied'

/** Weapon-family index -> report slug, in FAMILY_NAMES order. */
const SFX_FAMILY_SLUGS = [
	'fire_cannon', 'fire_artillery', 'fire_mg', 'fire_rifle', 'fire_rocket',
	'fire_torpedo', 'tesla_zap', 'fire_flame', 'fire_bomb', 'fire_melee',
	'fire_heal', 'fire_utility',
]

/** Lowercased weapon name -> report slug, for weapons that must not wear their family's voice. */
const SFX_WEAPON_SLUGS: Record<string, string> = {
	dogjaw: 'dog_bark',
	silencedppk: 'spy_pistol',
	// e7/Riki retains the compatible Colt45 rule id; her authored model carries a carbine.
	colt45: 'riki_rifle',
}

/** §8 surface index -> impact slug. Thirteen surfaces, three groups. */
const SFX_IMPACT_SLUGS = [
	'impact_soft', 'impact_hard', 'impact_soft', 'impact_hard', 'impact_soft',
	'impact_hard', 'impact_hard', 'impact_hard', 'impact_water', 'impact_water',
	'impact_soft', 'impact_soft', 'impact_hard',
]

/** Violence band -> destruction slug, quietest first. */
const SFX_DESTRUCTION_SLUGS = ['explosion_small', 'explosion_close', 'explosion_large']

/** Production-complete bell (handleProduced). */
const SFX_SLUG_NOTIFY = 'production_ready'

/** One-shot voices outside the weapon/impact/destruction families. */
const SFX_SLUG_DOG_GROWL = 'dog_growl'
const SFX_SLUG_DOG_DEATH = 'dog_death'
const SFX_SLUG_BUILD_PLACED = 'build_placed'
/** §8 surface index -> vehicle engine slug. Thirteen surfaces, three groups. */
const SFX_ENGINE_SLUGS = [
	'engine_dirt', 'engine_hard', 'engine_dirt', 'engine_hard', 'engine_dirt',
	'engine_hard', 'engine_hard', 'engine_hard', 'engine_water', 'engine_water',
	'engine_dirt', 'engine_dirt', 'engine_hard',
]

/** §8 surface index -> infantry gait slug. Thirteen surfaces, four groups. */
const SFX_STEP_SLUGS = [
	'footstep_soft', 'footstep_hard', 'footstep_soft', 'footstep_hard',
	'footstep_grass', 'footstep_hard', 'footstep_hard', 'footstep_hard',
	'footstep_water', 'footstep_water', 'footstep_soft', 'footstep_soft',
	'footstep_hard',
]


/**
 * Playback-rate ratio per unit of heaviness, for the continuous scale correction.
 *
 * The families put their fundamental between `0.42^w` (cannon) and `0.55^w` (machine gun);
 * 0.46 is the geometric middle of that spread and is applied as `0.46^(w - bandCentre)`. Over
 * a third of the heaviness range that is 0.88..1.14, which is inside the ±3 semitones where a
 * resample still sounds like the same gun rather than like the same gun on a slow tape.
 *
 * ONE CONSTANT RATHER THAN A PER-FAMILY CURVE, deliberately. A per-family exponent would be a
 * second copy of a number `familyRecipe` already owns, and the two would drift; the residual
 * error here is at most a semitone, and per-shot detune is wider than that anyway.
 */
const SCALE_RATE_PER_HEAVINESS = 0.46

/**
 * Deterministic per-shot variation, from the shot's own identity.
 *
 * Not a counter, and not the platform generator rule 5 forbids. A counter is deterministic only while every machine
 * observes every event in the same order, and this node legitimately DROPS reports when its
 * pool is full — so one client dropping a shot would shift the detune of every shot after it
 * relative to its neighbour. Actor id, sim tick and armament index are all authoritative and
 * all travel in the event, so the same battle varies the same way everywhere.
 *
 * The mixing constants are the standard 32-bit avalanche pair; the point is only that
 * neighbouring ticks produce unrelated outputs, which a plain multiply does not.
 */
function shotHash(actorId: number, tick: number, armament: number): number {
	let h = (actorId ^ 0x9e3779b9) >>> 0
	h = Math.imul(h ^ tick, 0x85ebca6b) >>> 0
	h = Math.imul(h ^ (armament + 0x165667b1), 0xc2b2ae35) >>> 0
	h ^= h >>> 15
	return h >>> 0
}

export interface AudioApi {
	/** True once the context is running — i.e. after the first user gesture. */
	readonly running: boolean
	/** Sources consuming capacity, including persistent loops at zero gain. */
	readonly voicesActive: number
	/** Sounds dropped because the pool was full. Non-zero means the pool is too small. */
	readonly voicesDropped: number
	/**
	 * Shots fired by a weapon with no row in `weapon-audio.json`.
	 *
	 * Non-zero means the mod has a weapon the generated table does not, so that weapon is being
	 * voiced as a generic cannon. Exposed rather than logged because a table that has quietly
	 * gone stale is exactly the failure `fx`'s casing bug was — every row silently discarded,
	 * nothing visibly broken — and a counter is the cheapest thing that cannot be missed.
	 */
	readonly weaponsUnresolved: number
	setMasterVolume(v: number): void
	/**
	 * Point bank-first SFX at a faction (the game's faction id, e.g. 'germany').
	 * A faction with no bank falls to 'allied', then to the procedural voices.
	 */
	setSfxFaction(factionId: string): void
	/** Inject the faction -> slug -> clip-URL table (Vite-globbed in `sfx-banks.ts`). The Node gates inject nothing. */
	setSfxBank(bank: Record<string, Record<string, string>> | null): void
	/** The battlefield announcer. Instance lives here so no node imports this module (rule 3). */
	readonly eva: EvaApi
	/** Match soundtrack player, same ownership rule as `eva`. */
	readonly music: MusicApi
	/** Interface cues on their own bus (`ui-sound.ts`), same ownership rule as `eva`. */
	readonly ui: UiSoundApi
}

/**
 * One persistent output chain. Allocated at init and reused forever.
 *
 * The `AudioBufferSourceNode` itself CANNOT be pooled — the Web Audio spec makes it one-shot,
 * and a stopped source can never be restarted. So one small object per sound is the
 * platform's floor, not a concession; everything downstream of it is permanent.
 */
interface VoiceSlot {
	engine?: AudioBufferSourceNode
	engineId?: number
	gain: GainNode
	pan: StereoPannerNode
	lp: BiquadFilterNode
	/** Context time at which this slot's current sound has finished. */
	freeAt: number
}

export class Audio implements AudioApi {
	static id = 'audio'
	/** Combat placement is consumed after the model and its sockets have been posed. */
	static deps: readonly string[] = ['units', 'camera']

	private actx: AudioContext | null = null
	private master: GainNode | null = null
	private bank: VoiceBank | null = null
	/** Injected faction SFX bank (see `sfx.ts`): faction -> slug -> clip URL. */
	private sfxBank: Record<string, Record<string, string>> | null = null
	/** Faction id the bank is keyed by; 'allied' until a match sets one. */
	private sfxFaction = SFX_ALLIED_BANK
	/** Decoded clips for the resolved faction bank; empty until adoption lands. */
	private readonly sfx = new Map<string, AudioBuffer>()
	/** Procedural movement/gait loop voices as AudioBuffers, converted once at wake. */
	private movementBuffers: AudioBuffer[] = []
	private stepBuffers: AudioBuffer[] = []
	/** The bank key the running loops were built for; '' = procedural only, null = never built. */
	private loopsBankKey: string | null = null
	private slots: VoiceSlot[] = []

	/** One permanently-running loop per §8 surface. Never started or stopped during play. */
	private readonly loops: { gain: GainNode; pan: StereoPannerNode; src: AudioBufferSourceNode | null }[] = []
	private readonly stepLoops: { gain: GainNode; pan: StereoPannerNode; src: AudioBufferSourceNode | null }[] = []
	private readonly surfaceGain = new Float32Array(SURFACE_VOICING.length)
	private readonly surfacePan = new Float32Array(SURFACE_VOICING.length)
	private readonly surfaceSpeed = new Float32Array(SURFACE_VOICING.length)
	private readonly surfaceClass = new Float32Array(SURFACE_VOICING.length)
	private readonly stepGain = new Float32Array(SURFACE_VOICING.length)
	private readonly stepPan = new Float32Array(SURFACE_VOICING.length)
	private readonly stepSpeed = new Float32Array(SURFACE_VOICING.length)

	private notify: AudioBuffer | null = null
	/** `reports[family][band]`, mirroring `VoiceBank.reports`. */
	private reports: AudioBuffer[][] = []
	private readonly muzzlePosition=new Float32Array(6)
	private readonly engines=new EngineVoices()
	get engineStats(){return this.engines.stats}
	private readonly engineVisible=(x:number,z:number)=>this.shroudApi?.isVisible(Math.floor(x),Math.floor(z))??false
	private impacts: AudioBuffer[][] = []
	private destructions: AudioBuffer[] = []

	private listener: ListenerApi | null = null
	private shroudApi: ShroudApi | null = null
	private ctxRef: Ctx | null = null
	private masterVolume = DEFAULT_MASTER
	private movementLimit = SURFACE_VOICING.length
	/** Infantry gait chains — separate bank, separate cap, same reserve discipline. */
	// Infantry gait loops are OFF: gain-modulated march loops read as a heartbeat under
	// firefights. The clips and this machinery stay, so a future ambience tier can re-arm
	// the chain without touching the mixer.
	private stepLimit = 0
	private rain: { gain: GainNode; src: AudioBufferSourceNode } | null = null
	private thunderBuffer: AudioBuffer | null = null
	private thunderSlot: VoiceSlot | null = null
	private thunderSource: AudioBufferSourceNode | null = null
	private weather: WeatherApi | null = null
	private lastWeatherTime = Number.NaN
	private lastStrike = -1
	private pendingThunderTime = Number.NaN
	private pendingStrength = 0
	private pendingPan = 0
	private rainTarget = -1
	private dropped = 0

	// Per-snapshot presentation scans (one pass per tick, never per frame). They give
	// the node two things the event bus cannot: WHICH actor was damaged or destroyed
	// (the event payloads carry positions, not ids) and WHEN a structure first exists.
	private scanTick = -1
	private readonly dogActorIds = new Set<number>()
	/** Wall-clock starts of the death voices currently in their ~2 s window —
	 *  the simultaneity cap and the mix-balance duck read this, not a queue. */
	private deathVoices: number[] = []
	private readonly structureActorIds = new Set<number>()
	private readonly growlAt = new Map<number, number>()
	private readonly scanTypeNames = new Map<number, string>()
	// Attacking-state under-fire shout: an OWN unit that fires within 5 s of its
	// last wound yells the under-attack line too. The actorDamaged payload names
	// no actor, so this scan's health bytes are the attribution source; the
	// per-actor ack keeps one fight to one shout per 8 s across both triggers.
	private readonly lastHealthByActor = new Map<number, number>()
	private readonly lastDamagedAt = new Map<number, number>()
	private readonly ownActorTypes = new Map<number, number>()
	private readonly underAttackAckAt = new Map<number, number>()
	// The announcer and the soundtrack are owned HERE so the UI reaches them through
	// ctx.get('audio') instead of importing this subsystem (rule 3).
	readonly eva = new Eva()
	/** The page's one player: the boot loader may already be playing the menu song on it. */
	readonly music = sharedMusic()
	/** Shares this node's context (read lazily, so it sees the one `init()` makes) but not its
	 *  master: the world trim is not the interface level. Inert until the UI unlocks it. */
	readonly ui = new UiSound(() => this.actx)
	/** Preallocated listener basis. Recomputed per sound, never allocated (rule 6). */
	private readonly eye = new Float32Array(3)
	private readonly fwd = new Float32Array(3)
	private readonly right = new Float32Array(3)

	/** Bound once so adding/removing them is symmetric and allocation-free. */
	private readonly onGesture = (): void => this.wake()
	private readonly pendingWeapons=new WeaponEvents()
 private readonly consumeWeapon=(e:SnapshotEvent,v:DataView):void=>{if(e.kind===1)this.handleFire(e,v);else this.handleImpact(e,v)}
 private readonly onFire = (value: unknown): void => {const e=value as SnapshotEvent;if(!this.pendingWeapons.enqueue(e,this.ctxRef?.snapshot?.view))this.handleFire(e)}
	private readonly onImpact = (value: unknown): void => {const e=value as SnapshotEvent;if(!this.pendingWeapons.enqueue(e,this.ctxRef?.snapshot?.view))this.handleImpact(e)}
	private readonly onDestroyed = (e: unknown): void => this.handleDestroyed(e as SnapshotEvent)
	private readonly onProduced = (e: unknown): void => this.handleProduced(e as SnapshotEvent)

	private offNewWorld:(()=>void)|null=null
	private offFire: (() => void) | null = null
	private offImpact: (() => void) | null = null
	private offDamaged: (() => void) | null = null
	private offCrashImpact:(()=>void)|null=null
	private offDestroyed: (() => void) | null = null
	private offProduced: (() => void) | null = null

	/**
	 * Per-string-table-id caches, so the hot path resolves a weapon without a string operation.
	 *
	 * Filled lazily on the first shot from each weapon type. `familyByType` doubles as the
	 * resolution state: `TYPE_UNRESOLVED` until first seen, then a family index or
	 * `TYPE_UNKNOWN`. Allocated in the field initialiser, never in a handler (rule 6).
	 */
	private readonly familyByType = new Int16Array(TYPE_CACHE).fill(TYPE_UNRESOLVED)

	/** Reports whose weapon had no row in `weapon-audio.json`. Non-zero means the table is stale. */
	private unresolvedWeapons = 0

	get running(): boolean {
		return this.actx !== null && this.actx.state === 'running'
	}

	get voicesActive(): number {
		const now = this.actx?.currentTime ?? 0
		let active = this.loops.length + (this.rain ? 1 : 0)
		for (const slot of this.slots) if (slot.freeAt > now) active++
		if (this.thunderSlot && this.thunderSlot.freeAt > now) active++
		return active
	}

	get voicesDropped(): number {
		return this.dropped
	}

	get weaponsUnresolved(): number {
		return this.unresolvedWeapons
	}

	init(ctx: Ctx): void {
		this.ctxRef = ctx
		this.listener = ctx.peek<ListenerApi>('camera')
		this.shroudApi = ctx.peek<ShroudApi>('shroud')

		// FAIL OPEN, ALWAYS. A browser without Web Audio, a harness that blocks it, a policy
		// that throws on construction — none of those may cost a boot (rule 8). A silent game
		// is a degraded game; a game that does not start is a broken one.
		try {
			const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext
			if (!Ctor) return
			// Constructed here, SUSPENDED, purely to learn the hardware sample rate — the bank
			// must be rendered at the rate it will be played at, or every voice is resampled
			// and therefore detuned by the ratio between 44.1 and 48 kHz.
			this.actx = new Ctor()
			this.master = this.actx.createGain()
			this.master.gain.value = this.masterVolume
			this.master.connect(this.actx.destination)

			// Every source counts: reserve movement, rain and thunder before combat voices.
			const budget = Math.max(0, Math.floor(ctx.config.q.audioVoices))
			const weatherCount = budget >= 2 ? 2 : 0
			this.movementLimit = Math.min(SURFACE_VOICING.length, Math.max(0, budget - weatherCount - 1))
			const count = budget - this.movementLimit - weatherCount
			for (let i = 0; i < count + (weatherCount ? 1 : 0); i++) {
				const gain = this.actx.createGain()
				const pan = this.actx.createStereoPanner()
				const lp = this.actx.createBiquadFilter()
				lp.type = 'lowpass'
				lp.frequency.value = 20000
				gain.connect(pan)
				pan.connect(lp)
				lp.connect(this.master)
				const slot = { gain, pan, lp, freeAt: 0 }
				if (i === count) this.thunderSlot = slot
				else this.slots.push(slot)
			}
		} catch {
			this.actx = null
			this.master = null
			this.slots.length = 0
			return
		}

		this.offNewWorld=ctx.events.on(CoreEvent.newWorld,()=>{this.pendingWeapons.clear();this.engines.reset(this.slots);this.familyByType.fill(TYPE_UNRESOLVED);this.scanTick=-1;this.dogActorIds.clear();this.structureActorIds.clear();this.growlAt.clear();this.scanTypeNames.clear();this.lastHealthByActor.clear();this.lastDamagedAt.clear();this.ownActorTypes.clear();this.underAttackAckAt.clear()})
		this.offFire = ctx.events.on(SimEvent.weaponFire, this.onFire)
		this.offImpact = ctx.events.on(SimEvent.projectileImpact, this.onImpact)
		this.offDamaged = ctx.events.on(SimEvent.actorDamaged, this.onImpact)
		this.offCrashImpact=ctx.events.on<AircraftVisualEvent>(CoreEvent.aircraftImpact,e=>{
   // Linked husks already emit their real UnitExplode weapon report on ground contact.
   if(e.linked)return
   const surface=e.water?8:0,row=this.impacts[2];if(row)this.play(this.sfx.get(SFX_IMPACT_SLUGS[surface])??row[surface],e.x,e.y,e.z,GAIN_DESTRUCTION,e.id)
  })
  this.offDestroyed = ctx.events.on(SimEvent.actorDestroyed, this.onDestroyed)
		this.offProduced = ctx.events.on(SimEvent.productionComplete, this.onProduced)

		// Autoplay policy: a context created without a gesture starts suspended and stays that
		// way. Both events are listened for because a player who drives the camera from the
		// keyboard may never click, and would otherwise get a silent game with no explanation.
		const target: EventTarget = ctx.canvas
		target.addEventListener('pointerdown', this.onGesture)
		globalThis.addEventListener?.('keydown', this.onGesture)
	}

	/**
	 * First gesture: resume, and render the bank.
	 *
	 * The bank is built HERE rather than in `init()` on purpose. It measures 107 ms at 48 kHz
	 * — real work, and 107 ms on the boot path is 107 ms of black screen, while 107 ms inside
	 * a click handler is one dropped frame at the exact moment the browser and the player both
	 * expect the page to be busy. Nothing can be shooting before the first gesture anyway,
	 * because the context cannot make sound until it happens.
	 */
	private wake(): void {
		const actx = this.actx
		if (!actx) return
		if (this.bank === null) {
			const seed = this.ctxRef?.rng.forkNamed('audio-bank').int(0, 0x7fffffff) ?? 0x51eed
			this.bank = buildVoiceBank(actx.sampleRate, seed)
			for (const row of this.bank.reports) {
				const out: AudioBuffer[] = []
				for (const v of row) out.push(this.toBuffer(actx, v.samples))
				this.reports.push(out)
			}
			for (const row of this.bank.impacts) {
				const out: AudioBuffer[] = []
				for (const v of row) out.push(this.toBuffer(actx, v.samples))
				this.impacts.push(out)
			}
			for (const v of this.bank.destructions) this.destructions.push(this.toBuffer(actx, v.samples))
			this.notify = this.toBuffer(actx, this.bank.notify.samples)
			// Movement and gait voices become AudioBuffers up front and stay: the
			// loops themselves are built by `adoptSfx`, which can run after these
			// raw arrays are released — and again after a faction change, when
			// they are long gone.
			this.movementBuffers = this.bank.movement.map(v => this.toBuffer(actx, v.samples))
			this.stepBuffers = this.bank.footsteps.map(v => this.toBuffer(actx, v.samples))
			if (this.thunderSlot) {
				const gain = actx.createGain()
				gain.gain.value = 0
				if (this.master) gain.connect(this.master)
				const src = actx.createBufferSource()
				src.buffer = this.toBuffer(actx, renderRain(actx.sampleRate, seed ^ 0x7261696e).samples)
				src.loop = true
				src.connect(gain)
				src.start()
				this.rain = { gain, src }
				this.thunderBuffer = this.toBuffer(actx, renderThunder(actx.sampleRate, seed ^ 0x7468756e).samples)
			}
			// The AudioBuffers own copies now. Releasing the source arrays halves peak
			// residency, which for a 6.6 MiB bank is worth one line.
			this.bank = { ...this.bank, reports: [], impacts: [], destructions: [], movement: [], footsteps: [] }
			// Bank-first SFX: adopt the faction's clips and build the loops with
			// them. Without an injected bank this builds procedural loops right
			// here, and the node behaves exactly as it did before banks existed.
			this.adoptSfx()
			if((ENGINE_LIMITS[this.ctxRef?.config.q.name??'low']??0)>0)this.engines.init(actx)
		} else if (this.resolveSfxBankKey() !== this.loopsBankKey) {
			// The faction changed after boot — an MP join claiming a different
			// side. Match boundaries are the one place no column is moving yet,
			// which is what makes the one-time loop rebuild inaudible.
			this.adoptSfx()
		}
		if (actx.state === 'suspended') void Promise.resolve(actx.resume()).catch(() => {})
	}

	/**
	 * Decode the resolved faction bank and build the permanent loops with it.
	 *
	 * Fails into the procedural bank at EVERY step: a fetch that misses, a clip
	 * that does not decode, a node disposed mid-decode — the game may lose the
	 * recorded voice of a weapon but never its voice at all. Adoption happens
	 * only at boot or at a match boundary, when every loop gain is still at
	 * zero, which is what makes the one-time loop rebuild inaudible.
	 */
	private adoptSfx(): void {
		const actx = this.actx
		if (!actx) return
		const bank = this.sfxBank
		const key = this.resolveSfxBankKey()
		const urls = bank !== null && key !== '' ? bank[key] : undefined
		for (const l of this.loops) l.src?.stop()
		this.loops.length = 0
		for (const l of this.stepLoops) l.src?.stop()
		this.stepLoops.length = 0
		this.sfx.clear()
		if (urls === undefined) {
			this.buildLoops(actx)
			return
		}
		void Promise.all(Object.entries(urls).map(async ([slug, url]) => {
			try {
				const res = await fetch(url)
				if (!res.ok) return
				this.sfx.set(slug, await actx.decodeAudioData(await res.arrayBuffer()))
			} catch { /* a broken clip falls back to the procedural voice */ }
		})).then(() => {
			if (this.actx === actx) {
				// Real recordings for the air/naval engine beds: rotor/prop/turboprop/jet/boat
				// swap their synthesized bed for the faction clip when it exists.
				const kinds: Record<string, number> = { engine_rotor: 0, engine_prop: 1, engine_turboprop: 2, engine_jet: 3, engine_boat: 4, engine_harv: 5 }
				for (const [slug, kind] of Object.entries(kinds)) {
					const clip = this.sfx.get(slug)
					if (clip) this.engines.setKindClip(kind, clip)
				}
				this.buildLoops(actx)
			}
		})
	}

	/**
	 * Build the permanent movement and gait loops, bank-first: the faction's
	 * clip for each surface group wins, the procedural loop voice covers every
	 * gap. Called once per adoption; `adoptSfx` empties the loop arrays first.
	 */
	private buildLoops(actx: AudioContext): void {
		for (let s = 0; s < this.movementBuffers.length && this.loops.length < this.movementLimit; s++) {
			const gain = actx.createGain()
			gain.gain.value = 0
			const pan = actx.createStereoPanner()
			gain.connect(pan)
			if (this.master) pan.connect(this.master)
			const src = actx.createBufferSource()
			src.buffer = this.sfx.get(SFX_ENGINE_SLUGS[s] ?? '') ?? this.movementBuffers[s]
			src.loop = true
			src.connect(gain)
			src.start()
			this.loops.push({ gain, pan, src })
		}
		// Infantry gait chains. Separate arrays: a soldier's footsteps and a
		// tank's engine-chug must never share a loop, or the class axis collapses.
		for (let s = 0; s < this.stepBuffers.length && this.stepLoops.length < this.stepLimit; s++) {
			const gain = actx.createGain()
			gain.gain.value = 0
			const pan = actx.createStereoPanner()
			gain.connect(pan)
			if (this.master) pan.connect(this.master)
			const src = actx.createBufferSource()
			src.buffer = this.sfx.get(SFX_STEP_SLUGS[s] ?? '') ?? this.stepBuffers[s]
			src.loop = true
			src.connect(gain)
			src.start()
			this.stepLoops.push({ gain, pan, src })
		}
		this.loopsBankKey = this.resolveSfxBankKey()
	}

	/** The injected bank's key for the current faction; '' when there is none to play. */
	private resolveSfxBankKey(): string {
		const bank = this.sfxBank
		if (bank === null) return ''
		if (bank[this.sfxFaction] !== undefined) return this.sfxFaction
		// 'soviet' has no render of its own: its countries use the Russian bank,
		// which carries the real Russian death clips, not the English allied one.
		if (this.sfxFaction === 'soviet' && bank.russia !== undefined) return 'russia'
		return bank[SFX_ALLIED_BANK] !== undefined ? SFX_ALLIED_BANK : ''
	}

	setSfxFaction(factionId: string): void {
		this.sfxFaction = factionId.toLowerCase() || SFX_ALLIED_BANK
		this.readoptSfxIfChanged()
	}

	setSfxBank(bank: Record<string, Record<string, string>> | null): void {
		this.sfxBank = bank
		this.readoptSfxIfChanged()
	}

	/** Re-run bank adoption when the resolved bank key changed after boot. */
	private readoptSfxIfChanged(): void {
		if (this.bank !== null && this.resolveSfxBankKey() !== this.loopsBankKey) this.adoptSfx()
	}

	private toBuffer(actx: AudioContext, samples: Float32Array): AudioBuffer {
		const buf = actx.createBuffer(1, samples.length, actx.sampleRate)
		// `getChannelData` then set, rather than `copyToChannel`: the latter's lib.dom
		// signature demands a Float32Array explicitly backed by ArrayBuffer, and the synth
		// returns the widened ArrayBufferLike form. Same copy, no cast, no lie about the type.
		buf.getChannelData(0).set(samples)
		return buf
	}

	// -----------------------------------------------------------------------
	// §4.9 event handlers
	//
	// Payloads are decoded straight out of the snapshot buffer at `e.offset`. Byte layouts are
	// read from `SnapshotEmitter.WriteEvents`, not from the §4.9 table, because the table is
	// prose and the emitter is what actually ran — and the two disagree in one respect that
	// matters: the emitter writes `u16 armament` BEFORE the three `i32` coordinates, so the
	// positions are 2-byte aligned and every read here must be an explicit little-endian
	// DataView access rather than anything that assumes a 4-byte struct.
	// -----------------------------------------------------------------------

	/**
	 * A weapon fired.
	 *
	 * THE DEFECT THIS REPLACED. The whole of the old body was
	 * `this.play(this.reports[reportBand(caliber)], ..., weaponClass)`: eight voices chosen by
	 * damage, with the weapon reaching the mix only as a detune. A tesla coil, a rocket
	 * launcher, a machine gun and a tank cannon whose damage landed in the same band played
	 * the same buffer — and because `heaviness()` clamped at 1000 while the event sends up to
	 * 65535, that band was band 7 for 47 of the 50 authored weapons. The game had one gun.
	 *
	 * Three numbers now leave this function that did not before, and each does one job:
	 * the FAMILY picks the buffer, the DAMAGE picks the band and the continuous rate inside
	 * it, and a hash of (actor, tick, armament) breaks the repetition.
	 */
	private handleFire(e: SnapshotEvent,copiedView?:DataView): void {
		const snap = this.ctxRef?.snapshot
		if (!snap || this.reports.length === 0 || e.byteLength < 24) return
		const v = copiedView ?? snap.view
		const o = e.offset
		const actorId = v.getUint32(o, true)
		const armament = v.getUint16(o + 4, true)
		let x = v.getInt32(o + 6, true) * WPOS_TO_M
		let z = v.getInt32(o + 10, true) * WPOS_TO_M
		let y = v.getInt32(o + 14, true) * WPOS_TO_M
		const weaponTypeId = v.getUint16(o + 20, true)
		const damage = v.getUint16(o + 22, true)

		const units = this.ctxRef?.get?.('units') as { weaponNameOf?(id:number,arm:number):string;attachmentWorldOf?(id:number,arm:number,barrel:number,out:Float32Array,shot:number):boolean;movementClass?(typeId:number):number;hasRaTrait?(name:string,trait:string):boolean } | undefined
		if(units?.attachmentWorldOf?.(actorId,armament,e.byteLength>=26?v.getUint16(o+24,true):0,this.muzzlePosition,e.byteLength>=30?v.getUint32(o+26,true):1)){x=this.muzzlePosition[0];y=this.muzzlePosition[1];z=this.muzzlePosition[2]}
		const armName = units?.weaponNameOf?.(actorId, armament) ?? ''
		const armRow = armName.length > 0 ? WEAPON_BY_LOWER_NAME.get(armName.toLowerCase()) : undefined
		const family = armRow !== undefined ? armRow.family : this.familyFor(weaponTypeId)
		const band = reportBand(damage)
		const row = this.reports[family] ?? this.reports[FALLBACK_FAMILY]

		// CONTINUOUS SCALE ON THREE BUFFERS. The band is voiced at its centre damage; this is
		// the ratio between the fundamental this weapon should have and the one the buffer was
		// rendered with. Resampling by it moves f0, brightness and length together, which is
		// exactly how a physically larger charge differs from a smaller one — and is why the
		// band count could fall from eight to three without the size axis going stepped.
		// Bounded because a resample far from unity stops sounding like the same weapon and
		// starts sounding like a tape at the wrong speed.
		const w = heaviness(damage)
		const centre = heaviness(bandDamage(band, REPORT_BANDS))
		const identity=armName.toLowerCase() || this.ctxRef?.actorTypeName(weaponTypeId).toLowerCase() || ''
		const variation=WEAPON_TIMBRE[identity]??1
		const scale = Math.min(Math.max(Math.pow(SCALE_RATE_PER_HEAVINESS, w - centre), 0.80), 1.25)*variation

		// PER-SHOT VARIATION, PURE. Hashed from the shot's own identity rather than advanced
		// from a counter: an LCG stepped once per call is deterministic only if every machine
		// sees every event in the same order, and a client that drops one report because its
		// pool was full would desynchronise the sound of the rest of the battle from its
		// neighbour's. Actor, tick and armament index are all authoritative, so two machines
		// watching the same replay hear the same shots vary the same way.
		// Bank-first: the faction's recorded voice for this weapon wins over the
		// procedural band voice. Weapon-name overrides first — the dog must bark
		// and the spy's PPK must stay suppressed, not wear the family voice —
		// then the family slug. The scale axis keeps working either way: it only
		// reaches the playback rate.
		const override = armName.length > 0 ? SFX_WEAPON_SLUGS[armName.toLowerCase()] : undefined
		const slug = override ?? SFX_FAMILY_SLUGS[family] ?? ''
		const recorded = slug !== '' ? this.sfx.get(slug) : undefined
		const buffer = recorded ?? row[band]
		const gain = recorded && override === 'riki_rifle' ? GAIN_RIKI_REPORT : GAIN_REPORT
		this.play(buffer, x, y, z, gain, shotHash(actorId, snap.tick, armament) ^ (e.byteLength>=30?v.getUint32(o+26,true):0), scale)
		// Attacking while under fire: an own unit shooting back within 5 s of its
		// last wound shouts the under-attack line too, under the same per-actor
		// 8 s ack as the damage-side trigger — one fight costs one shout per 8 s
		// either way. Buildings stay out (they have their own EVA notices).
		const t = this.actx?.currentTime
		const damagedAt = t === undefined ? undefined : this.lastDamagedAt.get(actorId)
		if (t !== undefined && damagedAt !== undefined && t - damagedAt <= 5 && t - (this.underAttackAckAt.get(actorId) ?? -1e9) >= 8) {
			const shooterType = this.ownActorTypes.get(actorId)
			const shooterName = shooterType !== undefined ? this.ctxRef?.actorTypeName(shooterType) ?? '' : ''
			// The shooter must still be alive: a unit whose volley is its last does not
			// call for help — the engine's voiceKind death voice covers that moment, and
			// shouts must never outlive the soldiers they belong to.
			const actors = this.ctxRef?.snapshot?.actors
			let shooterAlive = true
			if (actors) for (let i = 0; i < actors.count; i++) if (actors.id[i] === actorId) { shooterAlive = actors.health[i] > 0; break }
			if (shooterType !== undefined && shooterName !== '' && shooterAlive && !units?.hasRaTrait?.(shooterName, 'Building')) {
				this.underAttackAckAt.set(actorId, t)
				this.eva.sayUnit('underAttack', units?.movementClass?.(shooterType) ?? 1, this.eva.personaOf(shooterName))
			}
		}
	}

	/**
	 * String-table id -> family, cached per id.
	 *
	 * The string work — one `actorTypeName` call, one `toLowerCase`, one Map read — happens
	 * once per weapon TYPE for the life of the session. Every subsequent shot from that weapon
	 * is an array read.
	 */
	private familyFor(weaponTypeId: number): number {
		if (weaponTypeId >= TYPE_CACHE) return this.resolveFamily(weaponTypeId)
		const cached = this.familyByType[weaponTypeId]
		if (cached !== TYPE_UNRESOLVED) return cached === TYPE_UNKNOWN ? FALLBACK_FAMILY : cached
		const family = this.resolveFamily(weaponTypeId)
		this.familyByType[weaponTypeId] = family === FALLBACK_FAMILY && !this.lastResolved ? TYPE_UNKNOWN : family
		return family
	}

	/** True when the last `resolveFamily` found a row. Set beside the return, read once. */
	private lastResolved = false

	private resolveFamily(weaponTypeId: number): number {
		// Guarded even though `Ctx` declares the method, because rule 8's fail-open applies with
		// full force on this path: a harness that supplies a partial ctx — and `audionodegate`'s
		// did — would otherwise take a TypeError out of an event handler and silence the game
		// from the first shot on. The type says it is there; the running program is what has to
		// be survived.
		const lookup = this.ctxRef?.actorTypeName
		const name = typeof lookup === 'function' ? lookup.call(this.ctxRef, weaponTypeId) : ''
		// Case-insensitive by construction. `Ruleset.Weapons` lowercases its keys, and a live
		// match has already been observed publishing "dragon" against a catalogue holding
		// "Dragon" — which silently discarded every row it matched against.
		const row = name.length > 0 ? WEAPON_BY_LOWER_NAME.get(name.toLowerCase()) : undefined
		this.lastResolved = row !== undefined
		if (row === undefined) {
			this.unresolvedWeapons++
			return FALLBACK_FAMILY
		}
		return row.family >= 0 && row.family < FAMILY_COUNT ? row.family : FALLBACK_FAMILY
	}

	private handleImpact(e: SnapshotEvent,copiedView?:DataView): void {
		const snap = this.ctxRef?.snapshot
		if (!snap || this.impacts.length === 0 || e.byteLength < 22) return
		const v = copiedView ?? snap.view
		const o = e.offset
		const x = v.getInt32(o, true) * WPOS_TO_M
		const z = v.getInt32(o + 4, true) * WPOS_TO_M
		const y = v.getInt32(o + 8, true) * WPOS_TO_M
		if(e.kind===EventKind.actorDamaged&&v.getUint8(o+19)===255)return
		const surface = v.getUint8(o + 18)
		const damage = v.getUint16(o + 20, true)
		// Only a heal or a repair lands with no damage (the observer drops every other harmless
		// weapon). The healer's own report has already sounded, and a mend is not a hit.
		if (e.kind === EventKind.projectileImpact && damage === 0) return
		const row = this.impacts[impactBand(damage)]
		// An out-of-range surface is a bridge fault, not a reason to go silent — `synth` maps
		// it to soil and the sound still plays while the real fault is found (rule 8).
		const weapon=e.byteLength>=34?this.ctxRef?.actorTypeName(v.getUint16(o+22,true)).toLowerCase()??'':''
		const rate=WEAPON_TIMBRE[weapon]??1
		this.play(this.sfx.get(SFX_IMPACT_SLUGS[surface] ?? '') ?? row[surface] ?? row[0], x, y, z, GAIN_IMPACT, surface * 2654435761,rate)
	}

	private handleDestroyed(e: SnapshotEvent): void {
		const snap = this.ctxRef?.snapshot
		if (!snap || e.byteLength < 18) return
		const v = snap.view
		const o = e.offset
		const actorId = v.getUint32(o, true)
		const x = v.getInt32(o + 4, true) * WPOS_TO_M
		const z = v.getInt32(o + 8, true) * WPOS_TO_M
		const y = v.getInt32(o + 12, true) * WPOS_TO_M
		// The scan tracks which ids were dogs while alive; the event payload cannot
		// name the type. A dog dies with a yelp, not an explosion.
		if (this.dogActorIds.delete(actorId)) {
			this.play(this.sfx.get(SFX_SLUG_DOG_DEATH), x, y, z, GAIN_NOTIFY, actorId * 2654435761)
			return
		}
		if (this.destructions.length === 0) return
		if(this.ctxRef?.get<{crashOwnsHusk?:(id:number)=>boolean}>('units')?.crashOwnsHusk?.(actorId))return
		const violence = v.getUint8(o + 17)
		const band = destructionBand(violence)
		this.play(this.sfx.get(SFX_DESTRUCTION_SLUGS[band]) ?? this.destructions[band], x, y, z, GAIN_DESTRUCTION, violence * 40503)
		// DEATH VOICE — an engine reflex, not a presentation guess. The rules' own
		// DeathSounds matching ran in INotifyKilled and arrived as voiceKind: 0 none,
		// 1 normal, 2 burned (FireDeath), 3 zapped (ElectricityDeath). WHICH soldier
		// speaks comes from the actor's type in the previous snapshot (it is already
		// gone from this one): the personas keep their unique voices (jackson for the
		// allied e2, riki for the soviet clone, tanya, spy), everyone else speaks
		// their country's bank in their own language, by troop class.
		const voiceKind = e.byteLength >= 19 ? v.getUint8(o + 18) : 0
		if (voiceKind > 0) {
			const prev = this.ctxRef?.prevSnapshot?.actors
			let name = ''
			if (prev) for (let i = 0; i < prev.count; i++) if (prev.id[i] === actorId) { name = this.ctxRef!.actorTypeName(prev.typeId[i]).toLowerCase(); break }
			const persona = name === 'e7' ? 'tanya' : name === 'spy' || name === 'spy.england' ? 'spy'
				: name === 'e2' ? (/russia|ukraine|soviet/.test(this.sfxFaction) ? 'riki' : 'jackson') : ''
			const cls = persona !== '' ? persona : DEATH_VOICE_CLASS[name] ?? ''
			if (cls !== '') {
				// Voice budget: screams overlap — WebAudio plays one-shots
				// concurrently and they are never queued — but a mass death caps the
				// simultaneous count (extra deaths stay silent rather than pile up)
				// and ducks the gain so the mix stays balanced against reports.
				const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
				this.deathVoices = this.deathVoices.filter(t => now - t < 2200)
				if (this.deathVoices.length < 6) {
					this.deathVoices.push(now)
					const cat = voiceKind === 2 ? 'b' : voiceKind === 3 ? 'z' : (actorId & 1) === 0 ? 'n1' : 'n2'
					const scream = this.sfx.get(`death_${cls}_${cat}`) ?? this.sfx.get(`death_scream_${(actorId % 4) + 1}`)
					this.play(scream, x, y, z, GAIN_DESTRUCTION * 0.7 / Math.sqrt(1 + this.deathVoices.length * 0.5), actorId * 7919)
				}
			}
		}
	}

	// -----------------------------------------------------------------------

	/**
	 * Production complete — the only sound in the game that is NOT placed in the world.
	 *
	 * Three things follow from it being feedback about YOUR economy rather than an event on the
	 * battlefield, and all three are deliberate:
	 *
	 * 1. It is played centred and at full level, ignoring distance entirely. A notification you
	 *    can miss because your camera was elsewhere is not a notification. The §4.9 payload has
	 *    no position anyway — `u8 player, u8 queue, u16 actorType` — which confirms the design
	 *    rather than merely permitting it.
	 * 2. It is filtered to the LOCAL player against `world.renderPlayer`. Without that check you
	 *    hear a bell every time an opponent finishes anything, which is both maddening and a
	 *    straight intelligence leak about enemy production tempo.
	 * 3. It uses a bell rather than the blast primitive every other voice is built on, so it
	 *    cuts through a firefight instead of landing as one more impact.
	 */
	private handleProduced(e: SnapshotEvent): void {
		const snap = this.ctxRef?.snapshot
		const actx = this.actx
		if (!snap || !actx || !this.notify || e.byteLength < 4 || actx.state !== 'running') return
		const player = snap.view.getUint8(e.offset)
		const local = snap.world?.renderPlayer
		if (local !== undefined && local !== player) return

		const now = actx.currentTime
		let slot: VoiceSlot | null = null
		for (let i = 0; i < this.slots.length; i++) {
			if (this.slots[i].freeAt <= now) { slot = this.slots[i]; break }
		}
		if (slot === null) { this.dropped++; return }
		slot.gain.gain.value = GAIN_NOTIFY
		slot.pan.pan.value = 0
		slot.lp.frequency.value = 20000
		const buffer = this.sfx.get(SFX_SLUG_NOTIFY) ?? this.notify
		const src = actx.createBufferSource()
		src.buffer = buffer
		src.playbackRate.value = 1
		src.connect(slot.gain)
		src.start(now)
		slot.freeAt = now + buffer.duration
	}

	/**
	 * Refresh the listener basis into preallocated storage.
	 *
	 * Called from BOTH `play()` and `update()`. It was inlined in `play()` alone at first,
	 * which left the movement mix panning against whatever basis the last gunshot happened to
	 * leave behind — or against all zeros in a battle where nothing had fired yet. A shared
	 * scratch buffer written by one caller and read by two is exactly the kind of coupling
	 * that produces a bug nobody can reproduce, because it only misbehaves in the order the
	 * events did not arrive in.
	 *
	 * The fallback triple is where a sound sits when there is no camera in the graph, which
	 * keeps a headless harness audible rather than silently correct.
	 */
	private syncListener(fallbackX: number, fallbackY: number, fallbackZ: number): void {
		const l = this.listener
		if (!l) {
			this.eye[0] = fallbackX; this.eye[1] = fallbackY; this.eye[2] = fallbackZ
			this.right[0] = 1; this.right[1] = 0; this.right[2] = 0
			return
		}
		const e = l.listenerEye
		const f = l.listenerFocus
		this.eye[0] = e[0]; this.eye[1] = e[1]; this.eye[2] = e[2]
		let fx = f[0] - e[0], fy = f[1] - e[1], fz = f[2] - e[2]
		const fl = Math.hypot(fx, fy, fz) || 1
		fx /= fl; fy /= fl; fz /= fl
		this.fwd[0] = fx; this.fwd[1] = fy; this.fwd[2] = fz
		// right = forward x worldUp, with worldUp = +Y (§12.4). Written out rather than called
		// through a vector helper because rule 6 forbids constructing one in a hot path.
		let rx = fz, rz = -fx
		const rl = Math.hypot(rx, 0, rz) || 1
		rx /= rl; rz /= rl
		this.right[0] = rx; this.right[1] = 0; this.right[2] = rz
	}

	/**
	 * Place and schedule one sound.
	 *
	 * `variationSeed` is the identity token — a weapon-name hash, a surface index — and reaches
	 * ONLY the playback rate, never the choice of voice. That is the whole of what §14.13
	 * permits identity to do: distinguish two instances, never two designs.
	 */
	private play(buffer: AudioBuffer | undefined, x: number, y: number, z: number, classGain: number, variationSeed: number, scale = 1): void {
		const actx = this.actx
		if (!actx || !buffer || actx.state !== 'running') return

		this.syncListener(x, y, z)

		const dx = x - this.eye[0]
		const dy = y - this.eye[1]
		const dz = z - this.eye[2]
		const dist = Math.hypot(dx, dy, dz)
		if (dist > MAX_AUDIBLE_M) return

		// §4.7. A shot fired inside the fog is not heard, for the same reason it is not drawn.
		// Missing visibility fails closed: a producer contract fault must never become an
		// audible intelligence leak.
		const sh = this.shroudApi
		if (sh && !sh.isVisible(Math.floor(x), Math.floor(z))) return

		// --- slot -------------------------------------------------------------
		const now = actx.currentTime
		let slot: VoiceSlot | null = null
		for (let i = 0; i < this.slots.length; i++) {
			const s = this.slots[i]
			if (s.freeAt > now) continue
			if (slot === null) slot = s
		}
		if(slot===null){const motor=this.slots.find(s=>s.engine);if(motor){this.engines.stop(motor);this.engines.stats.preemptions++;slot=motor}}
		if (slot === null) {
			// DROPPED, not stolen. Stealing a slot mid-sound means cutting a source that is
			// still ringing, and the only click-free way to do that is a fade that also mutes
			// the arriving sound. At 48-128 voices the pool only saturates in a battle already
			// producing more sound than the ear can separate, where one missing report is
			// inaudible and one click is not. `voicesDropped` makes the pressure visible.
			this.dropped++
			return
		}

		// --- placement --------------------------------------------------------
		const atten = REFERENCE_DISTANCE_M / Math.max(dist, REFERENCE_DISTANCE_M)
		slot.gain.gain.value = classGain * atten * atten
		const inv = dist > 1e-4 ? 1 / dist : 0
		const lateral = (dx * this.right[0] + dy * this.right[1] + dz * this.right[2]) * inv
		slot.pan.pan.value = Math.max(-MAX_PAN, Math.min(MAX_PAN, lateral)) * MAX_PAN
		// Air absorption. Distant fire is DULL, not merely quiet, and a mix that only drops
		// level reads as a volume slider rather than as distance.
		slot.lp.frequency.value = Math.max(600, 18000 * Math.exp(-dist / 220))

		// --- source -----------------------------------------------------------
		const src = actx.createBufferSource()
		src.buffer = buffer
		// Two rate terms, doing two different jobs.
		//
		// `scale` is DESIGN: the continuous size correction from this weapon's exact damage to
		// the centre damage its band was rendered at. It is what lets three buffers per family
		// carry a smooth size axis instead of a stepped one, and it is the same for every shot
		// from a given weapon.
		//
		// The detune is VARIATION, and it is what stops a burst reading as one buffer played
		// three times. Widened from ±1.2% to ±3% now that the family carries the identity: at
		// the old width a five-round `M60mg` burst was audibly the same click five times, which
		// is the half of the human's complaint that is about SAMENESS rather than about timbre.
		// Three per cent is about half a semitone — plainly not the same round twice, and
		// nowhere near enough to read as a different weapon.
		const perShot = ((variationSeed >>> 8) / 0xffffff - 0.5) * 0.060
		src.playbackRate.value = Math.max(0.8, Math.min(1.25, scale * (1 + perShot)))
		src.connect(slot.gain)

		const delay = dist / SPEED_OF_SOUND
		const when = now + delay
		src.start(when)
		slot.freeAt = when + buffer.duration / src.playbackRate.value
	}

	setMasterVolume(v: number): void {
		this.masterVolume = Math.max(0, Math.min(1, v))
		if (this.master) this.master.gain.value = this.masterVolume
	}

	/**
	 * Ground movement retains the shared surface beds and footstep chains. Flying and
	 * floating types use only the admitted, per-source EngineVoices above. Permanent
	 * surface nodes stay silent when unused; pause clears their gains immediately.
	 */
	update(dt: number, ctx: Ctx): void {
        this.pendingWeapons.drain(this.consumeWeapon)
		const actx = this.actx
		if (!actx || this.loops.length === 0 || actx.state !== 'running') return
		const actors = ctx.snapshot?.actors
		const paused=((ctx.snapshot?.flags??0)&HeaderFlag.paused)!==0
		this.syncListener(0, 0, 0)
		this.engines.update(ctx,actx,this.slots,this.eye,this.right,this.engineVisible)
		if (ctx.snapshot && actors && !paused && ctx.snapshot.tick !== this.scanTick)
			this.scanSnapshot(ctx, ctx.snapshot, actors)
		const acc = this.surfaceGain
		const pan = this.surfacePan
		const spd = this.surfaceSpeed
		const cls = this.surfaceClass
		acc.fill(0)
		pan.fill(0)
		spd.fill(0)
		cls.fill(0)
		const fAcc = this.stepGain
		const fPan = this.stepPan
		const fSpd = this.stepSpeed
		fAcc.fill(0)
		fPan.fill(0)
		const units = ctx.get('units') as { movementClass(typeId: number): number } | undefined
		if (actors && !paused) {
			const sh = this.shroudApi
			const ex = this.eye[0]
			const ey = this.eye[1]
			const ez = this.eye[2]
			for (let i = 0; i < actors.count; i++) {
				// Flying/floating types belong exclusively to the admitted motor beds.
				if(this.engines.hasProfile(ctx,actors.typeId[i]))continue
				if(actors.health[i]===0||(actors.flags[i]&ActorFlag.husk)!==0)continue
				if((actors.flags[i]&(ActorFlag.cloaked|ActorFlag.submerged))!==0&&actors.owner[i]!==ctx.snapshot?.world?.renderPlayer)continue
				const rawSpeed = actors.speed[i]
				const speed = rawSpeed === SNAPSHOT_U16_ABSENT ? 0 : rawSpeed
				if (speed < MIN_MOVING_SPEED) continue
				const x = actors.posX[i] * WPOS_TO_M
				const z = actors.posY[i] * WPOS_TO_M
				if (sh && !sh.isVisible(Math.floor(x), Math.floor(z))) continue
				const y = actors.posZ[i] * WPOS_TO_M
				const dx = x - ex, dy = y - ey, dz = z - ez
				const dist = Math.hypot(dx, dy, dz)
				if (dist > MAX_AUDIBLE_M) continue
				const s = actors.surface[i] < this.loops.length ? actors.surface[i] : 0
				const atten = REFERENCE_DISTANCE_M / Math.max(dist, REFERENCE_DISTANCE_M)
				const w = atten * atten
				const inv = dist > 1e-4 ? 1 / dist : 0
				const sidePan = (dx * this.right[0] + dy * this.right[1] + dz * this.right[2]) * inv * w
				// The movement-class axis: infantry walks (footstep chains), everything
				// motorised contributes to the surface's engine loop, weighted by class so
				// a Mammoth column pitches the loop down and a jeep patrol up.
				const mc = units ? units.movementClass(actors.typeId[i]) : 1
				if (mc === 0) {
					fAcc[s] += w
					fSpd[s] += speed * w
					fPan[s] += sidePan
					continue
				}
				acc[s] += w
				spd[s] += speed * w
				cls[s] += (CLASS_RATE[mc] ?? 1) * w
				pan[s] += sidePan
			}
		}

		// One exponential smoother per surface. A gain stepped straight to its new value at
		// frame rate zippers, and a column driving behind a ridge would cut rather than fade.
		const k = paused ? 1 : 1 - Math.exp(-Math.max(dt, 0) / MOVEMENT_SMOOTH_S)
		for (let s = 0; s < this.loops.length; s++) {
			const w = acc[s]
			// Sub-linear in the number of machines: ten tanks are louder than one but not ten
			// times louder, which is both true and the only way a large battle stays mixable.
			const target = w > 0 ? Math.min(GAIN_MOVEMENT * Math.sqrt(w), GAIN_MOVEMENT * 2.2) : 0
			const g = this.loops[s].gain
			g.gain.value += (target - g.gain.value) * k
			if (w <= 0) continue
			this.loops[s].pan.pan.value += (Math.max(-MAX_PAN, Math.min(MAX_PAN, pan[s] / w)) * MAX_PAN - this.loops[s].pan.pan.value) * k
			// Speed reaches the engine as playback RATE, which moves firing rate, chassis
			// rumble and running-gear contact rate together because they are one rotation.
			// The class mix biases the rate on top: heavy hulls drag it down, light ones up.
			const mean = spd[s] / w
			const classRate = Math.min(1.3, Math.max(0.7, cls[s] / w))
			const rate = (MOVEMENT_RATE_MIN + (MOVEMENT_RATE_MAX - MOVEMENT_RATE_MIN) * Math.min(mean / MOVEMENT_SPEED_FULL, 1)) * classRate
			const src = this.loops[s].src
			if (src) src.playbackRate.value += (rate - src.playbackRate.value) * k
		}
		for (let s = 0; s < this.stepLoops.length; s++) {
			const w = fAcc[s]
			const target = w > 0 ? Math.min(GAIN_MOVEMENT * 1.4 * Math.sqrt(w), GAIN_MOVEMENT * 1.8) : 0
			const g = this.stepLoops[s].gain
			g.gain.value += (target - g.gain.value) * k
			if (w <= 0) continue
			this.stepLoops[s].pan.pan.value += (Math.max(-MAX_PAN, Math.min(MAX_PAN, fPan[s] / w)) * MAX_PAN - this.stepLoops[s].pan.pan.value) * k
			const mean = fSpd[s] / w
			const rate = MOVEMENT_RATE_MIN + (MOVEMENT_RATE_MAX - MOVEMENT_RATE_MIN) * Math.min(mean / MOVEMENT_SPEED_FULL, 1)
			const src = this.stepLoops[s].src
			if (src) src.playbackRate.value += (rate - src.playbackRate.value) * k
		}
	}

	/**
	 * One pass per simulation tick over the actor list. Three attributions the event
	 * bus cannot give: WHICH actor was destroyed (the payload names no type — needed
	 * for the dog's yelp), WHEN a local structure first exists (the sim emits no
	 * structure-built event), and proximity for the dog's enemy growl.
	 */
	private scanSnapshot(ctx: Ctx, snap: Snapshot, actors: NonNullable<Snapshot['actors']>): void {
		this.scanTick = snap.tick
		const units = ctx.get<{ movementClass(typeId: number): number; hasRaTrait?(name: string, trait: string): boolean } | undefined>('units')
		const local = snap.world?.renderPlayer
		const sh = this.shroudApi
		const now = this.actx?.currentTime ?? 0
		for (let i = 0; i < actors.count; i++) {
			if (actors.health[i] === 0 || (actors.flags[i] & ActorFlag.husk) !== 0) continue
			let name = this.scanTypeNames.get(actors.typeId[i])
			if (name === undefined) {
				name = ctx.actorTypeName(actors.typeId[i])
				this.scanTypeNames.set(actors.typeId[i], name)
			}
			const x = actors.posX[i] * WPOS_TO_M
			const z = actors.posY[i] * WPOS_TO_M
			if (name === 'dog') {
				this.dogActorIds.add(actors.id[i])
				const last = this.growlAt.get(actors.id[i]) ?? -1e9
				if (now - last >= 6 && (sh === null || sh.isVisible(Math.floor(x), Math.floor(z)))) {
					for (let j = 0; j < actors.count; j++) {
						if (j === i || actors.owner[j] === actors.owner[i] || actors.health[j] === 0) continue
						if (Math.hypot(actors.posX[j] * WPOS_TO_M - x, actors.posY[j] * WPOS_TO_M - z) > 12) continue
						// A banked growl wins; until the clip is rendered the bark
						// resampled low reads as a growl rather than silence.
						const growl = this.sfx.get(SFX_SLUG_DOG_GROWL)
						this.play(growl ?? this.sfx.get('dog_bark'), x, actors.posZ[i] * WPOS_TO_M, z, 0.4, actors.id[i] * 2654435761, growl ? 1 : 0.62)
						this.growlAt.set(actors.id[i], now)
						break
					}
				}
			}
			if (local !== undefined && actors.owner[i] === local && units?.hasRaTrait?.(name, 'Building')) {
				// A local-owned building never seen before is a fresh placement (built
				// OR an MCV deploying). The first snapshots carry the pre-placed base,
				// so the opening seconds never announce themselves.
				if (snap.tick > 25 && !this.structureActorIds.has(actors.id[i]))
					this.play(this.sfx.get(SFX_SLUG_BUILD_PLACED) ?? this.impacts[2]?.[1], x, actors.posZ[i] * WPOS_TO_M, z, GAIN_NOTIFY, actors.id[i] * 40503)
				this.structureActorIds.add(actors.id[i])
			}
			if (local !== undefined && actors.owner[i] === local) {
				// Under-fire attribution for the attacking-state shout: a health
				// drop between ticks marks THIS actor as the one that was hit.
				const id = actors.id[i]
				const was = this.lastHealthByActor.get(id)
				if (was !== undefined && actors.health[i] < was) this.lastDamagedAt.set(id, now)
				this.lastHealthByActor.set(id, actors.health[i])
				this.ownActorTypes.set(id, actors.typeId[i])
			}
		}
		if (this.ownActorTypes.size > 4096) {
			this.ownActorTypes.clear()
			this.lastHealthByActor.clear()
			this.lastDamagedAt.clear()
			this.underAttackAckAt.clear()
		}
		if (this.dogActorIds.size > 256) this.dogActorIds.clear()
		if (this.structureActorIds.size > 4096) this.structureActorIds.clear()
	}

	/** Read after sky.update, regardless of optional node registration order. */
	lateUpdate(_dt: number, ctx: Ctx): void {
		this.weather ??= ctx.peek<WeatherApi>('sky')
		const weather = this.weather
		const actx = this.actx
		if (!weather || !actx) return
		const time = weather.motionTime
		const strike = weather.lightningStrike
		const paused = ((ctx.snapshot?.flags ?? 0) & HeaderFlag.paused) !== 0
		const running = actx.state === 'running' && this.bank !== null
		const target = running && !paused && weather.snowIntensity === 0
			? Math.max(0, Math.min(1, weather.rainIntensity)) * 0.28 : 0
		if (this.rain && target !== this.rainTarget) {
			// Audio-rate smoothing avoids gain steps even when rendering stalls.
			this.rain.gain.gain.setTargetAtTime(target, actx.currentTime, 0.3)
			this.rainTarget = target
		}
		// A seek discards pending/playing thunder. Small interpolation corrections are normal.
		const discontinuity = !Number.isFinite(this.lastWeatherTime)
			|| time < this.lastWeatherTime - 0.08 || time > this.lastWeatherTime + 4
		if (!running || discontinuity) {
			this.pendingThunderTime = Number.NaN
			this.lastStrike = strike?.id ?? -1
			this.thunderSource?.stop()
			this.thunderSource = null
			if (this.thunderSlot) this.thunderSlot.freeAt = 0
			this.lastWeatherTime = time
			return
		}
		if (!strike) {
			this.pendingThunderTime = Number.NaN
			this.lastStrike = -1
		} else if (!paused && strike.id > this.lastStrike) {
			this.lastStrike = strike.id
			// Enabling a storm or resuming audio must not replay an old slot's strike.
			if (strike.time > this.lastWeatherTime && time <= strike.thunderTime + 0.25) {
				this.pendingThunderTime = strike.thunderTime
				this.pendingStrength = strike.strength
				this.pendingPan = strike.pan
			}
		}
		if (!paused && time >= this.pendingThunderTime) {
			if (time <= this.pendingThunderTime + 0.25) this.playThunder()
			this.pendingThunderTime = Number.NaN
		}
		this.lastWeatherTime = time
	}

	private playThunder(): void {
		const actx = this.actx, slot = this.thunderSlot, buffer = this.thunderBuffer
		if (!actx || !slot || !buffer) return
		if (slot.freeAt > actx.currentTime) { this.dropped++; return }
		slot.gain.gain.value = 0.58 * this.pendingStrength
		slot.pan.pan.value = this.pendingPan
		slot.lp.frequency.value = 3600
		const src = actx.createBufferSource()
		src.buffer = buffer
		src.connect(slot.gain)
		src.start(actx.currentTime)
		slot.freeAt = actx.currentTime + buffer.duration
		this.thunderSource = src
		src.onended = () => { src.disconnect(); if (this.thunderSource === src) this.thunderSource = null }
	}

	onSnapshot(_snap: Snapshot, _prev: Snapshot | null, _ctx: Ctx): void {
		// Nothing. Sounds are scheduled from the event bus as they are republished, which is
		// inside this same dispatch — `core/events.ts` reuses the payload object between
		// dispatches, so a handler that queued the event for later would be reading whatever
		// arrived after it.
	}

	dispose(): void {
        this.pendingWeapons.clear()
		this.offNewWorld?.()
		this.offFire?.()
		this.offImpact?.()
		this.offDamaged?.()
		this.offCrashImpact?.()
		this.offDestroyed?.()
		this.offProduced?.()
		this.offFire = this.offImpact = this.offDamaged = this.offDestroyed = this.offProduced = null
		this.ctxRef?.canvas.removeEventListener('pointerdown', this.onGesture)
		globalThis.removeEventListener?.('keydown', this.onGesture)
		this.rain?.src.stop()
		this.thunderSource?.stop()
		this.rain = null
		this.thunderSource = null
		this.thunderSlot = null
		this.thunderBuffer = null
		this.weather = null
		this.lastWeatherTime = this.pendingThunderTime = Number.NaN
		this.lastStrike = -1
		this.rainTarget = -1
		this.engines.clear(this.slots)
		// Before the close: the UI bus stops its own sources on a context that still exists.
		this.ui.dispose()
		void this.actx?.close()
		this.actx = null
		this.master = null
		this.slots.length = 0
		for (const l of this.loops) l.src?.stop()
		this.loops.length = 0
		this.reports.length = 0
		this.impacts.length = 0
		this.destructions.length = 0
		this.notify = null
		this.bank = null
		this.listener = null
		this.shroudApi = null
		this.ctxRef = null
		this.sfx.clear()
		this.movementBuffers.length = 0
		this.stepBuffers.length = 0
		this.loopsBankKey = null
		this.sfxBank = null
		this.dogActorIds.clear()
		this.structureActorIds.clear()
		this.growlAt.clear()
		this.scanTypeNames.clear()
		this.lastHealthByActor.clear()
		this.lastDamagedAt.clear()
		this.ownActorTypes.clear()
		this.underAttackAckAt.clear()
		this.scanTick = -1
	}
}

const _typecheck: SystemClass = Audio
void _typecheck

export default Audio

// Authored playback colour within each existing procedural/recorded weapon family.
const WEAPON_TIMBRE:Readonly<Record<string,number>>={'8inch':.67,'155mm':.83,'2inch':1.18,'chaingun':.9,'chaingun.yak':1.17,'m60mg':1.08,'vulcan':1.3,'scud':.74,'submissile':.80,'torptube':.72,'depthcharge':.77}
