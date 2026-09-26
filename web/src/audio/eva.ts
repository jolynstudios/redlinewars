/**
 * The battlefield announcer: spoken lines from pre-rendered voice banks (Cartesia TTS,
 * AAC). The clipped 90s RTS announcer voice is the identity target — but the
 * original recordings of that era are off-limits, so every line is an original short
 * phrase. Pure presentation: silence before the first user gesture, when a recorded
 * line cannot play, or when the match has not begun. Nothing here touches the simulation.
 */

import type { EvaApi } from './types'
// Persona banks carry their own `underAttack` rows; a persona whose bank still
// lacks a kind falls through to the generic pool for that kind alone.
type PersonaAcks = Partial<Record<'select' | 'move' | 'attack' | 'underAttack', readonly string[]>>
import SPY_ACK_RAW from './spy-lines.json'
import JACKSON_ACK_RAW from './jackson-lines.json'

/** Movement classes mirror UnitsApi.movementClass: 0 infantry, 1 light, 2 heavy, 3 ship. */
const UNIT_SELECT = [
	['Reporting for duty', 'At your service', 'Awaiting orders', 'Yes sir'],
	['Reporting for duty', 'At your service', 'Ready and waiting'],
	['Heavy armor reporting', 'Ready to move out', 'All systems nominal'],
	['Aye captain', 'Crew aboard and ready'],
]
const UNIT_MOVE = [
	['On my way', 'Movin out', 'Roger that', 'Affirmative'],
	['On my way', 'Roger that', 'Moving out now'],
	['Moving out', 'Affirmative', 'Treads rolling'],
	['Aye captain', 'Coming about'],
]
const UNIT_ATTACK = [
	['Attacking', 'Engaging the enemy', 'Opening fire'],
	['Target confirmed', 'Attacking'],
	['Target locked', 'Firing main guns'],
	['Target in range', 'Engaging'],
]

/**
 * Under-fire shouts. Triggered by the unit-damage tracker in the UI node, never by
 * an order — a unit screams because it is HURT, not because it was told something.
 * Same five lines across the classes; the tables stay separate so the class axis
 * and the rotation bookkeeping keep working unchanged.
 */
const UNIT_UNDER_ATTACK = [
	['Get down!', "I'm under heavy fire!", 'Man down!', 'Medic! I need help!', "I'm not going to make it!"],
	["I'm under heavy fire!", 'Get down!', 'Man down!'],
	['Taking heavy fire', "I'm under heavy fire!", 'Man down!'],
	['We are hit', "I'm under heavy fire!", 'Man down!'],
]

/**
 * Riki's own persona (internal codename still 'tanya'): a cocky special-forces swagger instead of the generic acks.
 * Original lines (nothing EA); rendered into the 'tanya' voice bank.
 */
const TANYA_ACK: Record<'select' | 'move' | 'attack' | 'underAttack', readonly string[]> = {
	select: ['Locked and loaded', 'Give me a target', 'You called?', 'Ready to dance'],
	move: ['You got it', 'On my way', 'Making moves', 'Moving'],
	attack: ['Consider it done', 'Say goodnight', 'Nothing personal', 'Lights out', 'Too easy', "Got 'em"],
	underAttack: ["They've found me", 'Getting hot out here', 'Taking fire'],
}

/** Identity follows the real actor type, including the British spy variant and the
 * grenadier, the one soldier both families field (soviet owners render the e2.soviet
 * clone). The grenadier's persona resolves per match family inside sayUnit: allied
 * owners hear Jackson, soviet owners keep the generic pool, the same split the HUD
 * display name already draws for 'e2'. */
const SPY_ACK = SPY_ACK_RAW as PersonaAcks
const JACKSON_ACK = JACKSON_ACK_RAW as PersonaAcks

export function unitVoicePersona(actorName: string): 'tanya' | 'spy' | 'jackson' | undefined {
	if (actorName === 'e7') return 'tanya'
	if (actorName === 'spy' || actorName === 'spy.england') return 'spy'
	if (actorName === 'e2') return 'jackson'
	return undefined
}

/**
 * Pre-rendered voice banks (AAC): one per faction (england/france/germany/russia/
 * ukraine — each speaking the faction's own language) plus the legacy allied/soviet
 * Cartesia renders and the older macOS `say` british render kept as fallback. Runtime
 * speech synthesis is deliberately forbidden: a missing or rejected recording must
 * never turn into the operating system's robotic voice.
 */
// The glob runs under Vite only. Node harnesses bundle this module with esbuild,
// where `import.meta.glob` is undefined — the catch degrades to silent banks instead
// of killing module init.
let voiceManifests: Record<string, { bank: string; lines: Record<string, string> }> = {}
let voiceFiles: Record<string, string> = {}
try {
	voiceManifests = import.meta.glob<{ bank: string; lines: Record<string, string> }>(
		'../../.forge/voices/*/manifest.json', { eager: true, import: 'default' })
	voiceFiles = import.meta.glob<string>('../../.forge/voices/*/*.{m4a,mp3}', { eager: true, query: '?url', import: 'default' })
} catch { /* Node harness: Vite glob unavailable */ }

function slugify(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

const VOICE_BANKS: Record<string, Record<string, string>> = {}
for (const [mkey, manifest] of Object.entries(voiceManifests)) {
	const base = mkey.slice(0, mkey.lastIndexOf('/'))
	const table: Record<string, string> = {}
	for (const [slug, file] of Object.entries(manifest.lines)) {
		const url = voiceFiles[`${base}/${file}`]
		if (url) table[slug] = url
	}
	if (Object.keys(table).length > 0) VOICE_BANKS[manifest.bank] = table
}
export class Eva implements EvaApi {
	private unlocked = false
	private lastTickSpoken = -1
	private bank: Record<string, string> | null = VOICE_BANKS.british ?? null

	/** Select the pre-rendered bank (per-side voices land here as banks ship). */
	setVoiceBank(name: string): void {
		this.bank = VOICE_BANKS[name] ?? null
	}

	/**
	 * Arm speaking. Must be called from a user-gesture call stack (the Start button or a
	 * canvas pointer) because browsers keep media playback suspended until one happens.
	 */
	unlock(): void {
		this.unlocked = true
	}

	private family: 'allied' | 'soviet' = 'allied'

	/**
	 * Announcer and unit acks follow the player's own faction: every faction id has
	 * its own pre-rendered bank (england/france/germany/russia/ukraine — same line
	 * concepts, each spoken in the faction's language). Unknown factions (e.g.
	 * Random) fall back to the allied bank, then the older british render. The
	 * a missing line stays silent. Called when a match is claimed or started; every start
	 * re-decides it, so returning to the lobby needs no reset.
	 */
	setFactionFamily(factionId: string): void {
		const id = factionId.toLowerCase()
		this.family = /russia|ukraine|soviet/i.test(factionId) ? 'soviet' : 'allied'
		// 'soviet' is the ALLIANCE id, not a country. Its own bank renders as
		// English, and the owner wants the Soviet side to speak Russian — route
		// the alliance to the russia bank, the render documented as actually
		// Russian (LISTEN.md). Ukraine keeps its own Ukrainian render.
		this.bank = VOICE_BANKS[id === 'soviet' ? 'russia' : id] ?? VOICE_BANKS.allied ?? VOICE_BANKS.british ?? null
	}

	/** One line per tick per kind: production bursts must not machine-gun the announcer. */
	say(text: string, tick = -1, bankOverride?: string, droppable = false): void {
		if (!this.unlocked) return
		if (tick >= 0) {
			if (tick === this.lastTickSpoken) return
			this.lastTickSpoken = tick
		}
		// setFactionFamily already selected the faction's own bank (russia speaks the
		// Russian render, ukraine the Ukrainian one, …). A character persona override
		// outranks it; a bank miss remains silent.
		const bank = bankOverride ? VOICE_BANKS[bankOverride] ?? null : this.bank
		const url = bank?.[slugify(text)]
		if (url) {
			// Shout clips have a strict budget: never more than
			// two shout clips at once, and a shout never stacks behind a lost fight —
			// the voices must stop when the soldiers stop.
			if (droppable && this.shoutClips.size >= 2) return
			const audio = new Audio(url)
			audio.volume = 0.55
			if (droppable) {
				this.shoutClips.add(audio)
				audio.addEventListener('ended', () => { this.shoutClips.delete(audio) }, { once: true })
			}
			void audio.play().catch(() => { this.shoutClips.delete(audio) })
			return
		}
	}

	private readonly shoutClips = new Set<HTMLAudioElement>()

	/**
	 * Unit acknowledgement voices, rotating through a short table so a click never
	 * repeats the same line twice in a row. Phrases are original generic military
	 * English in the RA1 cadence — the event COVERAGE mirrors the mod's voice classes
	 * (select, move, attack, underAttack) per movement class, but no EA recording or
	 * script is reproduced.
	 *
	 * `persona` selects a character's own lines and bank: Riki's confident commando
	 * delivery, the spy's quiet controlled acknowledgements, or Jackson's allied
	 * grenadier bark (a soviet-owner grenadier keeps the generic pool). Others stay generic.
	 */
	sayUnit(kind: 'select' | 'move' | 'attack' | 'underAttack', cls: number, persona?: string): void {
		const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
		if (now - this.lastAckMs < 450) return
		// Shouts get their own, much stricter budget: under fire the damage
		// tracker fires per hit unit, and without this the announcer never stops.
		if (kind === 'underAttack' && now - this.lastShoutMs < 2500) return
		let line: string
		let bank: string | undefined
		const personaLines = persona === 'tanya' ? TANYA_ACK
			: persona === 'spy' ? SPY_ACK
			// Jackson speaks for the allied family only; a soviet-owner grenadier falls
			// through to the generic pools below, so his voice stays as it always was.
			: persona === 'jackson' && this.family === 'allied' ? JACKSON_ACK
			: undefined
		const personaRow = personaLines?.[kind]
		if (personaLines && personaRow) {
			const rotation = persona + '_' + kind
			line = personaRow[(this.rotations.get(rotation) ?? 0) % personaRow.length]
			this.rotations.set(rotation, (this.rotations.get(rotation) ?? 0) + 1)
			bank = persona
		} else {
			const table = kind === 'select' ? UNIT_SELECT
				: kind === 'move' ? UNIT_MOVE
				: kind === 'attack' ? UNIT_ATTACK
				: UNIT_UNDER_ATTACK
			const row = table[Math.min(Math.max(cls, 0), table.length - 1)]
			if (!row || row.length === 0) return
			const i = (this.rotations.get(kind) ?? 0) % row.length
			this.rotations.set(kind, i + 1)
			line = row[i]
		}
		if (!line) return
		if (kind === 'underAttack') this.lastShoutMs = now
		this.say(line, -1, bank, true)
	}

	/** Identity for an actor type name, for callers that resolve voices per unit. */
	personaOf(actorName: string): 'tanya' | 'spy' | 'jackson' | undefined {
		return unitVoicePersona(actorName)
	}

	private lastAckMs = -1e9
	private lastShoutMs = -1e9
	private readonly rotations = new Map<string, number>()

	/** A match ended or a new one is starting: the per-match edge triggers reset. */
	reset(): void {
		this.lastTickSpoken = -1
	}

	stop(): void {
		for (const audio of this.shoutClips) audio.pause()
		this.shoutClips.clear()
	}
}
