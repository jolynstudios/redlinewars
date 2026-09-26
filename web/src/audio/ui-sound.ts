// STEELSEED — audio/ui-sound
// The interface cues: a small fixed set, computed from numbers like every other sound in this
// game (§14.9: no audio files), on a bus of their own.
//
// Two halves, split the way `synth.ts` and `index.ts` are:
//   renderUiCue()  PURE: (cue, sample rate, variant) -> Float32Array. No Web Audio, no clock,
//                  no storage, so `tools/ui-sound.test.mjs` measures the real waveforms in Node.
//   UiSound        the bus: one GainNode to the destination, the buffers rendered once at the
//                  first gesture, per-cue throttling, variant rotation, on/off and volume.
//
// THE BUS IS NOT THE WORLD MIX. The node's `master` carries gunfire at a fixed trim, and the
// music and the announcer are media elements beside it. A player who turns interface clicks
// down has not asked for quieter tanks, so this gain feeds the destination directly.
//
// The character is a hardware console: detents, relay latches, a small servo, a key switch.
// Every layer rises from silence with no corner and every buffer ends on a taper, so nothing
// clicks except the clicks that were designed as clicks. The more often a cue plays, the
// quieter it is: `focus` (every keyboard focus move) is the quietest, `launch` (START) the
// only loud one.

import { seededNoise, svfCoeff, svfStep, type Svf } from './synth'
import type { UiCue, UiSoundApi } from './types'

/** Every cue, in render order. */
export const UI_CUES: readonly UiCue[] = [
	'focus', 'select', 'toggleOn', 'toggleOff', 'step', 'open', 'close', 'confirm', 'error', 'launch',
]

/** Buffers per cue: focus rotates 4 pitches, step climbs 8; every other cue is one sound. */
export const UI_CUE_VARIANTS: Readonly<Record<UiCue, number>> = {
	focus: 4, select: 1, toggleOn: 1, toggleOff: 1, step: 8,
	open: 1, close: 1, confirm: 1, error: 1, launch: 1,
}

// ---------------------------------------------------------------------------
// Rendering. A cue is a short list of layers, each brought to its own `gain`, summed, scaled
// to the cue's exact peak, and tapered at the end.
// ---------------------------------------------------------------------------

interface Envelope {
	/** Onset within the cue, seconds. */
	at: number
	/** Seconds from onset. The layer is silent outside [at, at + length). */
	length: number
	/** Smoothstep rise from silence, seconds. */
	attack: number
	/** Exponential decay time constant after the attack, seconds. Infinity holds. */
	decay: number
	/** Smoothstep fall that lands on zero at the layer's last sample, seconds. */
	release: number
	/**
	 * This layer's level in the mix, before the whole cue is scaled to its target: a click's
	 * rendered peak, or a tone's largest possible peak (the sum of its partial amplitudes).
	 */
	gain: number
}

interface ToneLayer extends Envelope {
	kind: 'tone'
	/** Start and end pitch, Hz. The glide is exponential, so it is even in pitch. */
	f0: number
	f1: number
	/** Seconds the glide takes; the pitch holds at f1 after it. */
	glide: number
	/** Harmonic amplitudes, index 0 = the fundamental. Harmonics above 0.45·fs are left out. */
	partials: readonly number[]
}

interface NoiseLayer extends Envelope {
	kind: 'noise'
	/** Band-pass centre, Hz, and SVF damping (lower is narrower). */
	centre: number
	damping: number
	/** xorshift seed: the same click every time. */
	seed: number
}

type Layer = ToneLayer | NoiseLayer

interface CueRecipe {
	/** Buffer length, seconds. */
	duration: number
	/** Absolute peak of the rendered buffer, before the bus volume. */
	peak: number
	layers: readonly Layer[]
}

/** Taper on the last few milliseconds of every buffer, so a cue can never end on a step. */
const END_FADE_S = 0.003

const SINE = [1] as const

// The two builders write every field, always, in one order, so every layer of a kind shares one
// hidden class. Spread defaults would give each combination of overrides its own, and the hot
// loops below would be thrown out of optimised code each time a new one arrived.

function tone(p: Partial<Omit<ToneLayer, 'kind'>> & { f0: number; length: number }): ToneLayer {
	return {
		kind: 'tone',
		at: p.at ?? 0,
		length: p.length,
		attack: p.attack ?? 0.001,
		decay: p.decay ?? Infinity,
		release: p.release ?? 0.003,
		gain: p.gain ?? 1,
		f0: p.f0,
		f1: p.f1 ?? p.f0,
		glide: p.glide ?? p.length,
		partials: p.partials ?? SINE,
	}
}

/** A contact snap: band-passed noise a few milliseconds long. */
function click(p: Partial<Omit<NoiseLayer, 'kind'>> & { centre: number; seed: number }): NoiseLayer {
	return {
		kind: 'noise',
		at: p.at ?? 0,
		length: p.length ?? 0.008,
		attack: p.attack ?? 0.0003,
		decay: p.decay ?? 0.0011,
		release: p.release ?? 0.002,
		gain: p.gain ?? 1,
		centre: p.centre,
		damping: p.damping ?? 1,
		seed: p.seed,
	}
}

/** focus: four pitches the rotation walks so no two ticks in a row match. */
const FOCUS_HZ = [2400, 2540, 2270, 2690] as const
/** step: eight pitches, evenly spaced in pitch from STEP_LOW_HZ to STEP_HIGH_HZ. */
const STEP_LOW_HZ = 900
const STEP_HIGH_HZ = 1500
/** A band-limited triangle: odd harmonics at 1/k², alternating sign, to the 7th. */
const TRIANGLE = [1, 0, -1 / 9, 0, 1 / 25, 0, -1 / 49] as const
/** A small geared motor: a soft fundamental with a little whine above it. */
const SERVO = [1, 0.32, 0.14, 0.06] as const
/**
 * A buzzer with the edge filed off. The energy sits in the harmonics from 300 to 900 Hz, which
 * laptop speakers reproduce, and still reads as a 150 Hz buzz, because the ear hears the
 * harmonic series' fundamental whether or not the speaker plays it. Nothing above 1.35 kHz.
 * The signs are the pattern with the lowest crest factor (1.41, against 2.43 all-positive):
 * the same spectrum, 4.7 dB more body under the same peak, so it can sit at a lower one.
 */
const BUZZ = [0.7, -0.55, 0.5, 0.36, 0.3, -0.2, -0.16, -0.1, 0.07] as const
/** E5 and B5: confirm rises a fifth. */
const E5 = 659.26
const B5 = 987.77
/** The launch's rising tone, and the ratio of its detuned copy: 7 cents. */
const RISE = [1, 0.28, 0.1, 0.05] as const
const CHORUS = Math.pow(2, 7 / 1200)

/** A segmented or toggle detent: the snap, its bounce, and a short ping bent toward `hz`. */
function detent(hz: number, on: boolean): CueRecipe {
	return {
		duration: 0.05,
		peak: on ? 0.1 : 0.09,
		layers: [
			click({ centre: on ? 3000 : 2400, decay: 0.0009, length: 0.006, gain: 0.6, seed: on ? 0x70661e : 0x70660f }),
			click({ at: 0.009, centre: on ? 3600 : 2800, decay: 0.0006, length: 0.004, gain: 0.22, seed: on ? 0xb0c1e : 0xb0c0f }),
			// On bends up into its pitch and off bends down into it: direction under the pitch step.
			tone({ f0: hz * (on ? 0.96 : 1.04), f1: hz, glide: 0.008, partials: [1, 0.1], attack: 0.0008, decay: 0.008, release: 0.004, length: 0.05 }),
		],
	}
}

function uiCueRecipe(name: UiCue, variant: number): CueRecipe {
	switch (name) {
		case 'focus':
			// The quietest cue, about 12 dB under confirm: it plays on every keyboard focus move.
			return {
				duration: 0.036,
				peak: 0.035,
				layers: [tone({ f0: FOCUS_HZ[variant], attack: 0.0012, decay: 0.0065, release: 0.004, length: 0.036 })],
			}
		case 'select':
			return {
				duration: 0.045,
				peak: 0.12,
				layers: [
					click({ centre: 3400, damping: 0.9, gain: 0.55, seed: 0x5e1ec7 }),
					tone({ f0: 1600, partials: [1, 0.14], attack: 0.0008, decay: 0.009, release: 0.004, length: 0.045 }),
				],
			}
		case 'toggleOn':
			return detent(1800, true)
		case 'toggleOff':
			return detent(1200, false)
		case 'step': {
			const hz = STEP_LOW_HZ * Math.pow(STEP_HIGH_HZ / STEP_LOW_HZ, variant / (UI_CUE_VARIANTS.step - 1))
			return {
				duration: 0.03,
				peak: 0.065,
				layers: [tone({ f0: hz, partials: TRIANGLE, attack: 0.0006, decay: 0.0055, release: 0.003, length: 0.03 })],
			}
		}
		case 'open':
			// The latch lets go, then the servo spins up.
			return {
				duration: 0.14,
				peak: 0.09,
				layers: [
					click({ centre: 2200, damping: 1.1, attack: 0.0004, decay: 0.0012, gain: 0.3, seed: 0x09e4 }),
					tone({ at: 0.004, f0: 280, f1: 520, glide: 0.12, partials: SERVO, attack: 0.014, release: 0.05, length: 0.136 }),
				],
			}
		case 'close':
			// The servo winds down, then the panel seats.
			return {
				duration: 0.11,
				peak: 0.085,
				layers: [
					tone({ f0: 520, f1: 300, glide: 0.095, partials: SERVO, attack: 0.008, release: 0.04, length: 0.1 }),
					click({ at: 0.094, centre: 1900, damping: 1.1, attack: 0.0004, decay: 0.0012, gain: 0.28, seed: 0xc105e }),
				],
			}
		case 'confirm':
			return {
				duration: 0.2,
				peak: 0.14,
				layers: [
					click({ centre: 3000, decay: 0.0008, length: 0.006, gain: 0.22, seed: 0xc0f1 }),
					tone({ f0: E5, partials: [1, 0.22, 0.07], attack: 0.002, decay: 0.05, release: 0.025, length: 0.095, gain: 0.8 }),
					tone({ at: 0.07, f0: B5, partials: [1, 0.2, 0.05], attack: 0.002, decay: 0.06, release: 0.035, length: 0.13 }),
				],
			}
		case 'error':
			// Two muted buzzes. Low and dull on purpose: an error should be noticed, not flinched at.
			return {
				duration: 0.2,
				peak: 0.11,
				layers: [
					tone({ f0: 150, partials: BUZZ, attack: 0.004, decay: 0.2, release: 0.02, length: 0.075 }),
					tone({ at: 0.115, f0: 150, partials: BUZZ, attack: 0.004, decay: 0.2, release: 0.02, length: 0.075, gain: 0.9 }),
				],
			}
		case 'launch':
			// The launch key: two latch clicks as the key turns, a relay closing under them (the sub
			// thump, 72 -> 44 Hz), and the system coming up (330 -> 660 Hz). The one loud cue.
			return {
				duration: 0.75,
				peak: 0.28,
				layers: [
					click({ centre: 2600, damping: 0.8, decay: 0.0014, release: 0.003, length: 0.012, gain: 0.75, seed: 0x1a7c4 }),
					tone({ f0: 900, partials: [1, 0.3], attack: 0.0005, decay: 0.006, release: 0.005, length: 0.035, gain: 0.3 }),
					click({ at: 0.05, centre: 3300, damping: 0.8, length: 0.01, gain: 0.6, seed: 0x2b7c4 }),
					tone({ at: 0.05, f0: 1150, partials: [1, 0.25], attack: 0.0005, decay: 0.005, release: 0.005, length: 0.03, gain: 0.22 }),
					tone({ at: 0.05, f0: 72, f1: 44, glide: 0.22, partials: [1, 0.4, 0.12], attack: 0.004, decay: 0.16, release: 0.12, length: 0.45 }),
					// The rise, and a copy 7 cents sharp at half its level: a slow beat that gives it width.
					tone({ at: 0.09, f0: 330, f1: 660, glide: 0.6, partials: RISE, attack: 0.22, release: 0.16, length: 0.66, gain: 0.44 }),
					tone({ at: 0.09, f0: 330 * CHORUS, f1: 660 * CHORUS, glide: 0.6, partials: RISE, attack: 0.22, release: 0.16, length: 0.66, gain: 0.22 }),
				],
			}
	}
}

/**
 * Samples per oscillator block. The phasor's rotation is recomputed, and its length restored,
 * once per block, so a glide moves in steps of at most ~6 cents (the 110 ms close sweep): far
 * under what an ear resolves at these speeds, and the phase itself never steps.
 */
const OSC_BLOCK = 16

// Both layer writers below first run inside the first gesture, while V8 is still interpreting
// them. The tone loop, which carries almost every sample, therefore makes no calls and no
// trigonometry per sample, and nothing in either loop changes type or shape midway: that is
// what holds the whole set to a few milliseconds cold (about 1 ms once compiled). Both apply
// the same envelope, inlined: a smoothstep rise from zero, an exponential decay, and a
// smoothstep fall that lands on zero at the layer's last sample. Smoothstep has zero slope at
// both ends, so an edge has no corner to click on.

/**
 * Add one tone layer into `out[i0, i0 + len)`. The oscillator is a phasor turned by a fixed
 * rotation, the harmonics come from it by the Chebyshev recurrence, and the layer is scaled
 * against the sum of its partial amplitudes (the bound on its peak), so it mixes straight in.
 */
function addTone(out: Float32Array, i0: number, len: number, l: ToneLayer, sampleRate: number): void {
	const f0 = l.f0
	// Fixed per layer from the highest pitch it reaches, so no harmonic appears mid-glide.
	let count = l.partials.length
	while (count > 0 && count * Math.max(f0, l.f1) > 0.45 * sampleRate) count--
	if (count === 0) return
	const p = new Float64Array(count)
	let bound = 0
	for (let h = 0; h < count; h++) {
		p[h] = l.partials[h]
		bound += Math.abs(p[h])
	}
	const g = l.gain / bound
	const attackN = Math.max(1, Math.round(l.attack * sampleRate))
	const releaseN = Math.max(1, Math.min(len, Math.round(l.release * sampleRate)))
	const decayStep = Number.isFinite(l.decay) ? Math.exp(-1 / (l.decay * sampleRate)) : 1
	const glideN = Math.max(1, Math.round(l.glide * sampleRate))
	const fStep = Math.pow(l.f1 / f0, 1 / glideN)
	const w0 = 2 * Math.PI * f0 / sampleRate
	// (c, s) = (cos φ, sin φ), turned each sample by (rc, rs).
	let c = 1
	let s = 0
	let rc = 1
	let rs = 0
	let decay = 1
	for (let j = 0; j < len; j++) {
		if (j % OSC_BLOCK === 0) {
			// The pitch at the middle of this block, so the steps straddle the true glide.
			const turn = w0 * Math.pow(fStep, Math.min(j + OSC_BLOCK / 2, glideN))
			rc = Math.cos(turn)
			rs = Math.sin(turn)
			// Restore unit length, which rounding in the rotations wears down.
			const k = 1 / Math.sqrt(c * c + s * s)
			c *= k
			s *= k
		}
		let env: number
		if (j < attackN) {
			const x = j / attackN
			env = x * x * (3 - 2 * x)
		} else env = decay *= decayStep
		const left = len - 1 - j
		if (left < releaseN) {
			const x = left / releaseN
			env *= x * x * (3 - 2 * x)
		}
		// sin((h+2)φ) = 2cos φ · sin((h+1)φ) − sin(hφ)
		let prev = 0
		let cur = s
		let sum = p[0] * s
		const twoC = 2 * c
		for (let h = 1; h < count; h++) {
			const next = twoC * cur - prev
			prev = cur
			cur = next
			sum += p[h] * cur
		}
		out[i0 + j] += g * env * sum
		const nc = c * rc - s * rs
		s = s * rc + c * rs
		c = nc
	}
}

/**
 * Add one click into `out[i0, i0 + len)`. Noise has no bound to scale against, so a click is
 * rendered aside and normalised to its own peak. Two band-pass stages in series: one alone
 * leaves a 6 dB/octave skirt above the centre, which on white noise reads as hiss, not a contact.
 */
function addClick(out: Float32Array, i0: number, len: number, l: NoiseLayer, sampleRate: number): void {
	const attackN = Math.max(1, Math.round(l.attack * sampleRate))
	const releaseN = Math.max(1, Math.min(len, Math.round(l.release * sampleRate)))
	const decayStep = Number.isFinite(l.decay) ? Math.exp(-1 / (l.decay * sampleRate)) : 1
	const rnd = seededNoise(l.seed)
	const fc = svfCoeff(l.centre, sampleRate)
	const a: Svf = { low: 0, band: 0, high: 0 }
	const b: Svf = { low: 0, band: 0, high: 0 }
	const buf = new Float32Array(len)
	let decay = 1
	let peak = 0
	for (let j = 0; j < len; j++) {
		svfStep(a, rnd(), fc, l.damping)
		svfStep(b, a.band, fc, l.damping)
		let env: number
		if (j < attackN) {
			const x = j / attackN
			env = x * x * (3 - 2 * x)
		} else env = decay *= decayStep
		const left = len - 1 - j
		if (left < releaseN) {
			const x = left / releaseN
			env *= x * x * (3 - 2 * x)
		}
		const y = b.band * env
		buf[j] = y
		const m = Math.abs(y)
		if (m > peak) peak = m
	}
	if (peak <= 1e-12) return
	const g = l.gain / peak
	for (let j = 0; j < len; j++) out[i0 + j] += buf[j] * g
}

/**
 * Every recipe, built at module load, so every layer object exists before a sample is rendered.
 * Objects made mid-render would still be settling their field types under code V8 had just
 * optimised, and each change throws that code away: measured, that doubled the cold cost.
 */
const RECIPES: Readonly<Record<UiCue, readonly CueRecipe[]>> = (() => {
	const table = {} as Record<UiCue, CueRecipe[]>
	for (const name of UI_CUES) {
		const row: CueRecipe[] = []
		for (let v = 0; v < UI_CUE_VARIANTS[name]; v++) row.push(uiCueRecipe(name, v))
		table[name] = row
	}
	return table
})()

/**
 * One cue as mono samples at `sampleRate`. Pure and deterministic: the same arguments give the
 * same bytes. `variant` selects focus's pitch (0..3) or step's (0..7) and is clamped into range;
 * the other cues have one variant.
 */
export function renderUiCue(name: UiCue, sampleRate: number, variant = 0): Float32Array {
	const row = RECIPES[name]
	const recipe = row[Math.max(0, Math.min(row.length - 1, Math.floor(variant) || 0))]
	const n = Math.max(0, Math.round(recipe.duration * sampleRate))
	const out = new Float32Array(n)
	if (n === 0) return out

	for (const l of recipe.layers) {
		const i0 = Math.min(n, Math.round(l.at * sampleRate))
		const len = Math.min(n - i0, Math.round(l.length * sampleRate))
		if (len <= 0) continue
		if (l.kind === 'tone') addTone(out, i0, len, l, sampleRate)
		else addClick(out, i0, len, l, sampleRate)
	}

	// Scale to the cue's exact peak, and taper the end onto zero.
	let peak = 0
	for (let i = 0; i < n; i++) {
		const m = Math.abs(out[i])
		if (m > peak) peak = m
	}
	const g = peak > 1e-12 ? recipe.peak / peak : 0
	const fadeN = Math.max(1, Math.min(n, Math.round(END_FADE_S * sampleRate)))
	for (let i = 0; i < n - fadeN; i++) out[i] *= g
	for (let i = Math.max(0, n - fadeN); i < n; i++) {
		const x = (n - 1 - i) / fadeN
		out[i] *= g * x * x * (3 - 2 * x)
	}
	return out
}

// ---------------------------------------------------------------------------
// The bus.
// ---------------------------------------------------------------------------

const ENABLED_KEY = 'redline-ui-sound'
const VOLUME_KEY = 'redline-ui-sound-vol'
const DEFAULT_VOLUME = 0.8
/** Repeats of one cue closer than this are dropped: key repeat, and change events echoing. */
const THROTTLE_MS = 65
/**
 * A cue asked for while the first gesture's resume() is still opening the device waits for it,
 * latest wins, and plays only if it is still this fresh. Nothing is ever scheduled against a
 * suspended context, because every source queued there would sound at once on resume.
 */
const PENDING_MAX_MS = 250
/** Mute and volume glide with this time constant while something is sounding, so they never click. */
const GAIN_SMOOTH_S = 0.012
/** `step` without an index wanders around the middle pitches instead of climbing a scale. */
const STEP_ROTATION = [3, 4, 2, 5] as const

/** Storage can be absent (Node), refuse access (sandboxed frames), or throw on write (quota). */
function readPref(key: string): string | null {
	try {
		return globalThis.localStorage?.getItem(key) ?? null
	} catch {
		return null
	}
}

function writePref(key: string, value: string): void {
	try {
		globalThis.localStorage?.setItem(key, value)
	} catch {
		// Unpersisted, but the choice still holds for this session.
	}
}

const wallClock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

export class UiSound implements UiSoundApi {
	private readonly getContext: () => AudioContext | null
	private readonly now: () => number
	/** The context the gain and buffers below were built for; null until the first unlock. */
	private actx: AudioContext | null = null
	private gain: GainNode | null = null
	private readonly buffers = new Map<UiCue, AudioBuffer[]>()
	/** Sources still sounding, so dispose can stop them and a gain change knows whether to glide. */
	private readonly active = new Set<AudioBufferSourceNode>()
	private readonly lastAt = new Map<UiCue, number>()
	/** A context the build failed for. Rendering is deterministic, so it is not retried per cue. */
	private failedFor: AudioContext | null = null
	private pending: { buffer: AudioBuffer; at: number } | null = null
	private focusNext = 0
	private stepNext = 0
	private enabled: boolean
	private volume: number

	/**
	 * `getContext` hands over the audio node's context: shared, never created or closed here.
	 * `now` is a millisecond clock, injectable so the throttle can be tested.
	 */
	constructor(getContext: () => AudioContext | null, now: () => number = wallClock) {
		this.getContext = getContext
		this.now = now
		this.enabled = readPref(ENABLED_KEY) !== 'off'
		const stored = readPref(VOLUME_KEY)
		const v = stored === null || stored.trim() === '' ? Number.NaN : Number(stored)
		this.volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_VOLUME
	}

	unlock(): void {
		if (!this.enabled) return
		try {
			this.arm()
		} catch {
			// Fail open: an interface without clicks is still an interface.
		}
	}

	cue(name: UiCue, variant?: number): void {
		if (!this.enabled) return
		try {
			const actx = this.arm()
			if (!actx) return
			const t = this.now()
			const last = this.lastAt.get(name)
			if (last !== undefined && t - last < THROTTLE_MS) return
			const buffer = this.pick(name, variant)
			if (!buffer) return
			this.lastAt.set(name, t)
			if (actx.state === 'running') this.play(actx, buffer)
			else this.pending = { buffer, at: t }
		} catch {
			// A cue must never break the control that asked for it.
		}
	}

	isEnabled(): boolean {
		return this.enabled
	}

	setEnabled(on: boolean): void {
		this.enabled = on
		writePref(ENABLED_KEY, on ? 'on' : 'off')
		if (!on) this.pending = null
		this.applyGain()
	}

	getVolume(): number {
		return this.volume
	}

	setVolume(volume: number): void {
		if (!Number.isFinite(volume)) return
		// Rounded so a value survives a reload unchanged.
		this.volume = Math.round(Math.min(1, Math.max(0, volume)) * 1000) / 1000
		writePref(VOLUME_KEY, String(this.volume))
		this.applyGain()
	}

	/** Stop and drop everything this bus created. The context is the audio node's to close. */
	dispose(): void {
		this.release()
		this.lastAt.clear()
		this.failedFor = null
		this.focusNext = 0
		this.stepNext = 0
	}

	/**
	 * The shared context with this bus built for it, or null without Web Audio. Builds on first
	 * use and again if the node replaced its context; asks a suspended context to resume.
	 */
	private arm(): AudioContext | null {
		const actx = this.getContext()
		if (!actx || actx.state === 'closed' || actx === this.failedFor) {
			if (this.actx !== null && this.actx === actx) this.release()
			return null
		}
		if (actx !== this.actx) {
			try {
				this.prepare(actx)
			} catch {
				this.release()
				this.failedFor = actx
				return null
			}
		}
		if (actx.state !== 'running') this.resume(actx)
		return actx
	}

	/** The gain and every buffer, rendered once: a few milliseconds inside the first gesture. */
	private prepare(actx: AudioContext): void {
		this.release()
		const gain = actx.createGain()
		gain.gain.value = this.enabled ? this.volume : 0
		gain.connect(actx.destination)
		this.actx = actx
		this.gain = gain
		for (const name of UI_CUES) {
			const row: AudioBuffer[] = []
			for (let v = 0; v < UI_CUE_VARIANTS[name]; v++) {
				const samples = renderUiCue(name, actx.sampleRate, v)
				const buffer = actx.createBuffer(1, samples.length, actx.sampleRate)
				// getChannelData().set rather than copyToChannel, for the reason `index.ts` gives.
				buffer.getChannelData(0).set(samples)
				row.push(buffer)
			}
			this.buffers.set(name, row)
		}
	}

	/** Asked on every gesture while suspended: a resume() made before activation may never land. */
	private resume(actx: AudioContext): void {
		void Promise.resolve(actx.resume())
			.then(() => {
				const p = this.pending
				this.pending = null
				if (p && this.enabled && this.actx === actx && actx.state === 'running' && this.now() - p.at <= PENDING_MAX_MS)
					this.play(actx, p.buffer)
			})
			.catch(() => { /* still suspended; the next gesture asks again */ })
	}

	private pick(name: UiCue, variant: number | undefined): AudioBuffer | undefined {
		const row = this.buffers.get(name)
		if (!row || row.length === 0) return undefined
		const given = variant !== undefined && Number.isFinite(variant)
		let v = 0
		if (name === 'focus') {
			v = given ? ((Math.round(variant) % row.length) + row.length) % row.length : this.focusNext
			this.focusNext = (v + 1) % row.length
		} else if (name === 'step') {
			v = given
				? Math.max(0, Math.min(row.length - 1, Math.round(variant)))
				: STEP_ROTATION[this.stepNext++ % STEP_ROTATION.length]
		}
		return row[v]
	}

	private play(actx: AudioContext, buffer: AudioBuffer): void {
		const gain = this.gain
		if (!gain) return
		const src = actx.createBufferSource()
		src.buffer = buffer
		src.connect(gain)
		src.onended = () => {
			src.disconnect()
			this.active.delete(src)
		}
		this.active.add(src)
		src.start()
	}

	private applyGain(): void {
		const gain = this.gain
		const actx = this.actx
		if (!gain || !actx) return
		try {
			const target = this.enabled ? this.volume : 0
			const now = actx.currentTime
			gain.gain.cancelScheduledValues(now)
			// Nothing sounding: jump, so a toggle's own confirmation cue plays at full level.
			// Something sounding: glide, so muting mid-cue does not click.
			if (this.active.size === 0) gain.gain.setValueAtTime(target, now)
			else gain.gain.setTargetAtTime(target, now, GAIN_SMOOTH_S)
		} catch {
			// A closed context; the next unlock rebuilds against the live one.
		}
	}

	private release(): void {
		for (const src of this.active) {
			try {
				src.onended = null
				src.stop()
				src.disconnect()
			} catch {
				// Already ended, or its context is gone.
			}
		}
		this.active.clear()
		try {
			this.gain?.disconnect()
		} catch {
			// Its context is gone.
		}
		this.gain = null
		this.actx = null
		this.buffers.clear()
		this.pending = null
	}
}
