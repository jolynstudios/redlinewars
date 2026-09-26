// STEELSEED — audio/synth
// Every sound in this game is computed from a seed. There are no audio files (§14.9, 13b).
//
// PURE ON PURPOSE. Nothing here touches WebAudio, the DOM, or a clock. A synth voice is a
// function from numbers to a Float32Array, which is what makes `tools/audiogate.mjs` able to
// measure the actual waveform in Node with no browser and no GPU. §14.8 promised exactly this
// ("audio is gateable without a GPU… OfflineAudioContext renders faster than real time") and
// this file is the half that does not even need that much.
//
// WHAT MAY DRIVE A SOUND, AND WHAT MAY NOT.
//
// The §4.9 `weapon:fire` payload carries two numbers that look interchangeable and are not:
//
//   caliber     = `Armament.cs:156` — the DamageWarhead's Damage. A REAL QUANTITY. 71 armed
//                 actors span 65..820 with 47 distinct values.
//   weaponClass = `Armament.cs:151,400` — `StableId(info.Weapon)`, an FNV-1a hash OF THE
//                 WEAPON'S NAME.
//
// A hash of a name is a name. §14.13's rule — a generator may never key on an actor NAME —
// applies with full force here, because a `WEAPON_CLASS_TABLE` mapping hash 0x8F3A to "heavy
// cannon" is a per-name table with the evidence filed off, and it would be written within a
// month of this file landing if the distinction were not stated where the reader is.
//
// So the rule for this node, and it is not negotiable:
//
//   DAMAGE DESIGNS THE SOUND. WEAPON CLASS ONLY VARIES IT.
//
// Damage picks the fundamental, the brightness, the decay and the weight. Weapon class picks
// which noise realisation and how many cents of detune — the audible equivalent of §9.2's
// seeded per-instance jitter, which may distinguish two instances but may never distinguish
// two designs. Two weapons of equal damage must sound like the same weapon, exactly as
// `issues/archetypes-1.md` requires two actors of equal functional data to generate the same
// hull. If that ever feels too coarse, the fix is a richer §4.9 payload (reload and burst are
// already authored in the mod and would both be good second axes), NOT a table here.

/** One rendered voice and the measurements a gate needs to check it without re-deriving them. */
export interface Voice {
	samples: Float32Array
	sampleRate: number
	/** Seconds from the first sample to the absolute peak. A report is impulsive; a hum is not. */
	attackS: number
	peak: number
}

/**
 * Damage anchors, in DAMAGE — the same units as the field they normalise.
 *
 * DELIBERATELY NOT FITTED to today's roster (which runs 65..820). Fitting them would make
 * every existing weapon's voice move whenever the mod adds a new one, which is the non-local
 * coupling `BREAKPOINTS` in `archetype/params.ts` was given the same treatment to avoid.
 * Round numbers with headroom at both ends; a weapon outside the range clamps and is quiet
 * about it rather than folding back.
 */
/*
 * MEASURED AGAINST THE EVENT, NOT REMEMBERED. The header above this constant used to read
 * "71 armed actors span 65..820 with 47 distinct values". That is not the quantity the game
 * sends. `SteelseedEventObserver.cs:86` writes the SUM of positive DamageWarhead damages,
 * clamped to u16, and in this mod that runs 100 (Pistol) to 65535 (DogJaw, clamped from
 * 100000), with a working band of 900..30000. Against a ceiling of 1000, `heaviness()`
 * returned 1.0 and `reportBand()` returned 7 for FORTY-SEVEN OF THE FIFTY authored weapons:
 * the bank claimed eight report voices and the game played one. `weapon-audio.mjs --report`
 * prints the distribution this pair is set against, and `audiogate` asserts that no more than
 * a third of the roster shares a band, so the clamp cannot silently close again.
 *
 * Still deliberately NOT fitted: 100 and 32000 are round numbers with headroom at both ends,
 * chosen so a mod that adds a heavier weapon moves nothing that already exists.
 */
const DAMAGE_FLOOR = 100
const DAMAGE_CEIL = 32000

/**
 * Damage -> 0..1 heaviness, logarithmically.
 *
 * Linear would be wrong twice over: loudness is logarithmic in the ear and pitch is
 * logarithmic in the octave, so a linear map spends most of its resolution on the difference
 * between a 700 and an 820 damage gun — which nobody can hear — and almost none on the
 * difference between 65 and 175, which is the difference between a rifle and a cannon.
 */
export function heaviness(damage: number): number {
	const d = Math.min(Math.max(damage, DAMAGE_FLOOR), DAMAGE_CEIL)
	const t = (Math.log(d) - Math.log(DAMAGE_FLOOR)) / (Math.log(DAMAGE_CEIL) - Math.log(DAMAGE_FLOOR))
	return Math.min(Math.max(t, 0), 1)
}

/**
 * Chamberlin state-variable filter, one sample.
 *
 * Two poles, and both outputs are used: `low` shapes the blast, `high` is the supersonic
 * crack. A pair of one-poles would need two passes and could not give the resonant lift at
 * cutoff that makes a muzzle blast sound like a pressure event rather than like filtered
 * static. Stable while cutoff stays below about fs/6, which every caller here respects.
 */
export interface Svf {
	low: number
	band: number
	high: number
}

export function svfStep(s: Svf, x: number, f: number, q: number): void {
	s.low += f * s.band
	s.high = x - s.low - q * s.band
	s.band += f * s.high
}

/**
 * Cutoff in Hz -> the SVF's `f` coefficient, clamped short of the instability knee.
 *
 * The Chamberlin form goes unstable when `f + q >= 2`. The synth runs resonance as high as
 * 0.95 (q as low as 0.05), so it needs the conservative clamp; an ANALYSIS filter at fixed
 * Q=2 is stable to about 0.27*fs and must be allowed up there, because clamping analysis at
 * the synth's limit silently pins every measurement to the clamp frequency. That is not
 * hypothetical: the first run of `audiogate` reported every voice in this game — including a
 * 60 Hz boom — as having a ~7.8 kHz spectral centroid, because 0.16*fs at 48 kHz is 7.68 kHz
 * and the estimator could not look above its own ceiling.
 */
export function svfCoeff(cutoffHz: number, sampleRate: number, maxFrac = 0.16): number {
	const c = Math.min(cutoffHz, sampleRate * maxFrac)
	return 2 * Math.sin(Math.PI * Math.max(c, 10) / sampleRate)
}

/**
 * xorshift32. Deterministic, seedable, and — the point — INDEPENDENT of the simulation's Rng.
 *
 * Audio is presentation. Drawing from the sim's stream would make the sound of a shot able to
 * change the outcome of the battle, which is the one thing §4.11 will not tolerate.
 */
export function seededNoise(seed: number): () => number {
	let s = seed | 0
	if (s === 0) s = 0x9e3779b9
	return () => {
		s ^= s << 13
		s |= 0
		s ^= s >>> 17
		s ^= s << 5
		s |= 0
		// [-1, 1). Bipolar, because a unipolar noise source is a DC offset with a wobble on
		// top, and every voice built from it would thump on start.
		return (s / 0x80000000)
	}
}

/**
 * The one primitive every percussive sound in this game is built from.
 *
 * A gunshot, a shell hitting sand and a building coming apart are the same physical event at
 * different scales: a fast pressure release, a pitched body that rings and falls, a bright
 * transient at the front, and a tail that is really the environment answering. Writing them
 * as three separate synths would triple the code and guarantee they drift out of family.
 */
export interface BlastParams {
	/** Body fundamental in Hz. The "boom". */
	f0: number
	/** Blast noise cutoff in Hz. The "size" of the escaping gas. */
	cutoffHz: number
	/** Resonance at cutoff, 0..1. Higher rings more. */
	resonance: number
	/** Exponential time constants, seconds. */
	tauBlast: number
	tauBody: number
	tauTail: number
	/** Relative levels, pre-normalisation. */
	blastLevel: number
	bodyLevel: number
	crackLevel: number
	tailLevel: number
	/** Downward pitch sweep depth on the body, as a fraction of f0 at t=0. */
	sweep: number
	/**
	 * Breech/bolt/slide level, 0..2. A MECHANISM term, and the only one that does not scale
	 * with the charge.
	 *
	 * A parameter rather than the constant it used to be, because the families that are not
	 * guns have no mechanism at all and were audibly wearing one: a set of jaws, a healing
	 * beam and a tesla discharge every carried a 7-30 ms metallic clack because `renderBlast`
	 * added it unconditionally. Set it to 0 for anything that is not a machine, and above 1
	 * for a machine whose mechanism is the loudest part of the event — a bomb release has no
	 * propellant and IS its own shackle.
	 */
	mechLevel: number
	/** Total render length in seconds. */
	durationS: number
	/** Peak the result is normalised to. Keeps the mix predictable across the bank. */
	targetPeak: number
}

export function renderBlast(p: BlastParams, sampleRate: number, seed: number): Voice {
	const n = Math.max(1, Math.round(p.durationS * sampleRate))
	const out = new Float32Array(n)
	const rnd = seededNoise(seed)
	const dt = 1 / sampleRate

	const blast: Svf = { low: 0, band: 0, high: 0 }
	const tail: Svf = { low: 0, band: 0, high: 0 }
	const fBlast = svfCoeff(p.cutoffHz, sampleRate)
	const qBlast = 1 - Math.min(Math.max(p.resonance, 0), 0.95)
	// The tail is the room, not the weapon: always darker than the blast that excited it,
	// and it does not track cutoff all the way up or a small-arms tail turns into hiss.
	const fTail = svfCoeff(Math.min(p.cutoffHz * 0.45, 900), sampleRate)

	let phase = 0
	let peak = 0
	let peakIndex = 0

	for (let i = 0; i < n; i++) {
		const t = i * dt
		const eBlast = Math.exp(-t / p.tauBlast)
		const eBody = Math.exp(-t / p.tauBody)
		const eTail = Math.exp(-t / p.tauTail)

		const white = rnd()
		svfStep(blast, white, fBlast, qBlast)
		svfStep(tail, white, fTail, 1.4)

		// Body: a damped sine whose pitch falls onto f0. Real muzzle blast does this because
		// the gas column shortens as it vents; without it the low end reads as a test tone.
		const f = p.f0 * (1 + p.sweep * Math.exp(-t / 0.014))
		phase += 2 * Math.PI * f * dt
		const body = Math.sin(phase) * eBody

		// The supersonic crack is a genuinely separate event from the blast — it is the
		// projectile, not the propellant — so it gets its own much faster envelope.
		const crack = blast.high * Math.exp(-t / (p.tauBlast * 0.22))

		// Mechanism. A breech closing is a small hard object at a fixed size, so unlike every
		// other term here it does NOT scale with the weapon: a 20 mm and a 120 mm gun have a
		// similarly-sized bolt, and scaling it made large guns sound like dropped scaffolding.
		const mech = p.mechLevel > 0 && t > 0.007 && t < 0.030
			? blast.band * 0.25 * p.mechLevel * Math.exp(-(t - 0.007) / 0.006)
			: 0

		const s =
			blast.low * p.blastLevel * eBlast +
			body * p.bodyLevel +
			crack * p.crackLevel +
			tail.low * p.tailLevel * eTail +
			mech

		out[i] = s
		const a = Math.abs(s)
		if (a > peak) {
			peak = a
			peakIndex = i
		}
	}

	// Normalise, then soft-clip. Normalising alone would let a voice sit at exactly 1.0 and
	// then clip hard the moment two of them overlap in the mix.
	const g = peak > 1e-9 ? p.targetPeak / peak : 0
	let outPeak = 0
	for (let i = 0; i < n; i++) {
		const x = out[i] * g
		// tanh-ish without the call cost: soft above ~0.7, linear below.
		const y = x < -1 ? -1 : x > 1 ? 1 : x - (x * x * x) / 3
		out[i] = y
		const a = Math.abs(y)
		if (a > outPeak) outPeak = a
	}

	// A voice that ends mid-decay clicks on every playback, which is the single most common
	// audible defect in procedural audio and is inaudible in isolation on laptop speakers.
	// Three milliseconds is below the ear's fusion threshold and kills it outright.
	const fade = Math.min(Math.round(0.003 * sampleRate), (n / 2) | 0)
	for (let i = 0; i < fade; i++) {
		const k = i / fade
		out[n - 1 - i] *= k
		// The leading edge is an impulse and must NOT be faded — that is the attack.
	}

	return { samples: out, sampleRate, attackS: peakIndex / sampleRate, peak: outPeak }
}

// ---------------------------------------------------------------------------
// The three voice families. All three are `renderBlast` with different physics.
// ---------------------------------------------------------------------------

/*
 * `reportParams` STOOD HERE and is gone. It was the single damage->blast curve every weapon in
 * the game was voiced through, and it is replaced by `familyRecipe` below rather than kept
 * beside it: a second way to build a report that nothing calls is a second thing to keep in
 * step, and the next person to want "the simple one" would find it and use it.
 *
 * Its argument is not lost — it is the `cannon` recipe, which is what that curve was actually
 * describing all along. What it could never describe is a motor, a discharge or a jet.
 */

/**
 * What a hit sounds like, from the SURFACE it hit and how hard.
 *
 * §8 is explicit that every consumer must handle all 13 surfaces and that a `default:` branch
 * doing nothing is a gate failure. `surfaceTable` makes a missing one a TYPE error, which is
 * the only version of that rule that cannot rot.
 *
 * The four numbers per surface are physical: how stiff it is (pitch), how much it absorbs
 * (decay), how bright the contact is, and how much loose material it throws.
 */
export interface SurfaceVoicing {
	/** Body pitch multiplier — stiff materials ring high. */
	pitch: number
	/** Decay multiplier — stone rings, sand does not. */
	ring: number
	/** Contact brightness multiplier. */
	bright: number
	/** Loose-material tail multiplier — gravel and sand throw a lot, metal throws none. */
	spray: number
}

export const SURFACE_VOICING: readonly SurfaceVoicing[] = [
	/* 0  soil     */ { pitch: 0.62, ring: 0.42, bright: 0.55, spray: 1.30 },
	/* 1  rock     */ { pitch: 1.85, ring: 1.55, bright: 1.70, spray: 0.70 },
	/* 2  sand     */ { pitch: 0.48, ring: 0.26, bright: 0.40, spray: 1.85 },
	/* 3  gravel   */ { pitch: 1.15, ring: 0.60, bright: 1.35, spray: 2.10 },
	/* 4  grass    */ { pitch: 0.70, ring: 0.38, bright: 0.62, spray: 1.05 },
	/* 5  road     */ { pitch: 1.45, ring: 1.05, bright: 1.35, spray: 0.55 },
	/* 6  metal    */ { pitch: 2.40, ring: 2.30, bright: 2.10, spray: 0.20 },
	/* 7  concrete */ { pitch: 1.60, ring: 1.20, bright: 1.55, spray: 0.85 },
	/* 8  water    */ { pitch: 0.35, ring: 0.30, bright: 0.30, spray: 2.40 },
	// Shallow is NOT "slightly less water", and the first version of this row made that
	// mistake — it sat between water and sand on every axis and measured as the same sound as
	// dry sand. A round striking a thin sheet over a hard bed SLAPS: the contact is the
	// brightest transient of any soft surface here, because the water cannot get out of the
	// way and the bed underneath does not absorb it. Deep water gulps; dry sand kills the
	// transient outright. Shallow does the opposite of both.
	/* 9  shallow  */ { pitch: 0.58, ring: 0.30, bright: 0.95, spray: 2.15 },
	/* 10 snow     */ { pitch: 0.40, ring: 0.20, bright: 0.28, spray: 1.55 },
	// Ash is not fine sand. It is soft carbon dust with almost no mass behind it: it absorbs
	// the strike rather than resisting it, so it rings less and stays darker than sand while
	// throwing MORE loose material, not less. Voicing it as "sand, slightly quieter" made the
	// two measure as the same sound, which is the §8 failure this row exists to avoid.
	/* 11 ash      */ { pitch: 0.44, ring: 0.15, bright: 0.28, spray: 1.98 },
	/* 12 resource */ { pitch: 0.95, ring: 0.52, bright: 1.00, spray: 1.45 },
]

export function impactParams(damage: number, surface: number): BlastParams {
	const w = heaviness(damage)
	// An out-of-range surface index is a bridge bug, not a reason to go silent — soil is the
	// most ordinary answer and it stays audible while the real fault is found (rule 8).
	const v = SURFACE_VOICING[surface] ?? SURFACE_VOICING[0]
	const tauBlast = (0.008 + 0.022 * w) * (0.5 + 0.8 * v.ring)
	const tauBody = (0.020 + 0.110 * w) * v.ring
	// Shortened at the SOURCE rather than by capping the render window, and the difference is
	// not cosmetic. Capping duration to save memory truncated water — the longest tail in the
	// game — before it had decayed, which `audiogate` caught twice over: as a step
	// discontinuity at the buffer end (a click on every splash) and as sand and ash collapsing
	// to the same sound, because clipping two different decays to the same length makes them
	// measure the same. A voice must always contain its own decay; if the bank is too large,
	// the thing to shorten is the SOUND.
	const tauTail = (0.07 + 0.18 * w) * (0.45 + 0.62 * v.spray)
	return {
		f0: 150 * Math.pow(0.42, w) * v.pitch,
		cutoffHz: 1900 * Math.pow(0.45, w) * v.bright,
		resonance: 0.22 + 0.42 * Math.min(v.ring, 1.6),
		tauBlast,
		tauBody,
		tauTail,
		blastLevel: 0.85,
		bodyLevel: (0.25 + 0.45 * w) * Math.min(v.ring, 1.5),
		// An impact has no propellant, so what reads as "crack" here is the contact itself.
		crackLevel: 0.45 * v.bright,
		tailLevel: 0.10 + 0.22 * v.spray,
		sweep: 0.35,
		mechLevel: 1,
		// Shorter than the report's 3.2x tail, and this one IS a budget decision rather than a
		// physical one, so it is stated as such: impacts are the largest family in the bank
		// (2 bands x 13 surfaces) and at 3.4x they alone cost 52 s of the 78 s the first
		// version rendered. Measured 193 ms and 14.3 MiB to build; this line and IMPACT_BANDS
		// together bring it to a figure `audiogate` prints on every run. The audible cost is
		// the far end of the debris scatter, which the spray term still carries.
		// 3.0 tau reaches ~5% of peak; the 3 ms end fade covers the rest without audibly
		// shortening anything. The ceiling is set where it does NOT bite for any surface in
		// the table — it is a runaway guard, not a budget lever.
		//
		// Against the LONGEST envelope, not the tail. Keying on the tail alone is correct for
		// a report and for a destruction, where the tail always outlasts everything, and quite
		// wrong here: struck metal has ring 2.30, which makes its BODY outlast its tail twice
		// over, so a metal impact ended while still ringing at 5% and clicked. A surface that
		// rings is exactly the surface most likely to be hit in this game.
		durationS: Math.min(0.05 + Math.max(tauTail, tauBody, tauBlast) * 3.0, 1.6),
		targetPeak: 0.78,
	}
}

/**
 * An actor coming apart, from the §4.9 `violence` byte.
 *
 * Deliberately the LONGEST and LOWEST voice in the game. A destruction that is merely a loud
 * impact reads as another hit landing; what makes it read as a kill is that it keeps going
 * after everything else has stopped.
 */
export function destructionParams(violence: number): BlastParams {
	const v = Math.min(Math.max(violence, 0), 255) / 255
	const tauTail = 0.45 + 1.05 * v
	return {
		f0: 78 * Math.pow(0.55, v),
		cutoffHz: 1250 * Math.pow(0.40, v),
		resonance: 0.45 + 0.30 * v,
		tauBlast: 0.045 + 0.115 * v,
		tauBody: 0.180 + 0.520 * v,
		tauTail,
		blastLevel: 1,
		bodyLevel: 0.70 + 0.55 * v,
		crackLevel: 0.22,
		tailLevel: 0.38 + 0.34 * v,
		sweep: 0.85,
		mechLevel: 1,
		durationS: Math.min(0.15 + tauTail * 2.6, 3.0),
		targetPeak: 0.96,
	}
}

// ---------------------------------------------------------------------------
// Movement. The only SUSTAINED family, and the only one that has to loop.
// ---------------------------------------------------------------------------

/**
 * A machine under power, on a given surface.
 *
 * §8 names three consumers of the surface enum — "fx (dust, debris, sparks), audio
 * (footsteps, impacts, engine surface noise) and terrain (material blending)". The third of
 * those is this function, and it is the second half of audio's obligation to that enum: a
 * tracked hull on gravel and the same hull on soil are not the same machine sound, and until
 * now every moving thing in the game was silent on all thirteen.
 *
 * SPEED IS NOT A PARAMETER HERE. It reaches the engine as playback RATE at run time, which is
 * both cheaper and more correct: a real engine's pitch, its firing rate and its running-gear
 * contact rate all rise together because they are the same rotation, so resampling one loop
 * moves all three in lockstep and no amount of separate parameterisation would keep them
 * honest with each other.
 */
export interface LoopParams {
	/** Cylinder firing rate in Hz at unity playback. The chug. */
	pulseHz: number
	/** Body pitch each firing pulse excites. */
	pulseF0: number
	pulseLevel: number
	/** Broadband chassis rumble cutoff. */
	rumbleHz: number
	rumbleLevel: number
	/** Running-gear contacts per second — tread on ground, wheel over stone. */
	grainHz: number
	grainBrightHz: number
	grainLevel: number
	/** Seconds of ring-down on each running-gear contact. Stiff surfaces ring; soft ones do not. */
	grainRingS: number
	durationS: number
	targetPeak: number
	/**
	 * Seconds of the tail crossfaded back over the head. A PARAMETER rather than a constant so
	 * `audiogate --falsify=click` can set it to zero and act on the real input, instead of
	 * disabling the check that would catch it.
	 */
	crossfadeS: number
}

/**
 * Seconds of the loop's tail crossfaded back over its head.
 *
 * A loop is not a short sound: it is a sound that must MEET ITSELF. Noise and filter state at
 * sample n-1 have no relationship to sample 0, so an unfaded loop steps discontinuously once
 * per period and produces a buzz at the loop frequency — 1 Hz for a 1 s loop, which is
 * exactly the range the ear hears as a fault rather than as texture. The crossfade is what
 * makes the two ends the same signal.
 */
const LOOP_CROSSFADE_S = 0.16

export function renderLoop(p: LoopParams, sampleRate: number, seed: number): Voice {
	const n = Math.max(1, Math.round(p.durationS * sampleRate))
	const fade = Math.min(Math.max(Math.round(p.crossfadeS * sampleRate), 0), (n / 3) | 0)
	// Rendered LONGER than the loop by the crossfade length: the extra tail is what gets
	// folded back over the head. Rendering exactly n and fading in place would fade the loop
	// into silence at the seam instead of into itself.
	const total = n + fade
	const raw = new Float32Array(total)
	const rnd = seededNoise(seed)
	const dt = 1 / sampleRate

	const rumble: Svf = { low: 0, band: 0, high: 0 }
	const grain: Svf = { low: 0, band: 0, high: 0 }
	const fRumble = svfCoeff(p.rumbleHz, sampleRate)
	const fGrain = svfCoeff(p.grainBrightHz, sampleRate)

	let pulsePhase = 0
	let bodyPhase = 0
	let bodyEnv = 0
	const pulsePeriod = sampleRate / Math.max(p.pulseHz, 1)
	const grainProb = Math.min(p.grainHz / sampleRate, 0.5)
	let grainEnv = 0
	// Contact ring-down. Surface-derived, and it is the loop's fourth independent axis: a
	// stiff surface's contacts ring after the strike and a soft one's die on it. Without it
	// the loop read only ring/bright/spray, and materials that differ mainly in STIFFNESS —
	// dry sand against ash, both fine particulate with near-identical spray — measured as the
	// same machine even though their impacts separate cleanly.
	const grainDecay = Math.exp(-1 / (sampleRate * (0.0015 + 0.010 * p.grainRingS)))

	for (let i = 0; i < total; i++) {
		// Cylinder firing: an impulse every period, exciting a damped body. Periodic on
		// purpose — an engine is the most regular thing on the battlefield, and irregularity
		// here reads as a misfire rather than as character.
		pulsePhase += 1
		if (pulsePhase >= pulsePeriod) {
			pulsePhase -= pulsePeriod
			bodyEnv = 1
			bodyPhase = 0
		}
		bodyPhase += 2 * Math.PI * p.pulseF0 * dt
		bodyEnv *= 0.9982
		const pulse = Math.sin(bodyPhase) * bodyEnv * bodyEnv

		const white = rnd()
		svfStep(rumble, white, fRumble, 1.1)

		// Running gear: a Poisson click train through a bright resonator. Rate and brightness
		// both come from the SURFACE, which is what makes tread-on-gravel and tread-on-snow
		// different machines rather than the same machine at two volumes.
		if (rnd() * 0.5 + 0.5 < grainProb) grainEnv = 1
		grainEnv *= grainDecay
		svfStep(grain, white * grainEnv, fGrain, 0.55)

		raw[i] =
			pulse * p.pulseLevel +
			rumble.low * p.rumbleLevel +
			grain.band * p.grainLevel
	}

	// DC block, before the crossfade so the seam is computed on the final signal.
	//
	// Needed because of the pulse term, and the reason is worth stating: each firing pulse is
	// a damped sine restarted at phase 0, so its envelope weights the FIRST (positive) half
	// cycle more heavily than the second, and every loop came out with 1-2% standing offset.
	// On a one-shot that is inaudible; on a voice that plays continuously under every moving
	// machine on the field it is a constant push on the speaker cone that sums across actors.
	// A one-pole blocker at ~4 Hz removes it and touches nothing audible.
	const R = 0.9995
	let dcX = 0
	let dcY = 0
	for (let i = 0; i < total; i++) {
		const x = raw[i]
		dcY = x - dcX + R * dcY
		dcX = x
		raw[i] = dcY
	}

	// Fold the tail back over the head with an equal-power crossfade. Equal-power rather than
	// linear because two uncorrelated noise signals sum in POWER, and a linear fade would dip
	// audibly at the midpoint of every seam.
	const out = new Float32Array(n)
	out.set(raw.subarray(0, n))
	for (let i = 0; i < fade; i++) {
		const t = (i + 0.5) / fade
		const a = Math.cos(t * Math.PI * 0.5)
		const b = Math.sin(t * Math.PI * 0.5)
		out[i] = out[i] * b + raw[n + i] * a
	}

	let peak = 0
	for (let i = 0; i < n; i++) {
		const a = Math.abs(out[i])
		if (a > peak) peak = a
	}
	const g = peak > 1e-9 ? p.targetPeak / peak : 0
	let outPeak = 0
	for (let i = 0; i < n; i++) {
		const x = out[i] * g
		const y = x < -1 ? -1 : x > 1 ? 1 : x - (x * x * x) / 3
		out[i] = y
		const a = Math.abs(y)
		if (a > outPeak) outPeak = a
	}

	// No end fade, unlike every one-shot in this file — an end fade is precisely what a loop
	// must not have. `attackS` is meaningless for a sustained voice and is reported as 0.
	return { samples: out, sampleRate, attackS: 0, peak: outPeak }
}

export function movementParams(surface: number): LoopParams {
	const v = SURFACE_VOICING[surface] ?? SURFACE_VOICING[0]
	return {
		// The engine is the MACHINE and does not change with the ground under it. Only the
		// running-gear terms below are surface-derived; making the chug vary by surface would
		// be the same category error as tuning a gun's report by what it is standing on.
		pulseHz: 22,
		pulseF0: 96,
		// THE RUNNING GEAR IS THE LOUDER HALF, and the first balance here had it backwards.
		// With the engine at 0.55 and the ground at 0.30 the two surface-derived terms were
		// the quietest thing in the loop, and `audiogate` reported 21 pairs of surfaces as
		// indistinguishable while driving — correctly, because they were. A tracked hull at
		// speed is mostly track: steel on ground, not combustion. Weighting it that way is
		// also what makes the §8 enum audible at all rather than a subtle tint on one sound.
		pulseLevel: 0.38,
		rumbleHz: 210,
		rumbleLevel: 0.34 + 0.20 * Math.min(v.ring, 1.6),
		// More loose material means more discrete contacts per second, and a stiffer surface
		// means each one is brighter. Both read straight off the same table the impacts use,
		// so a surface cannot sound like gravel when struck and like snow when driven over.
		grainHz: 40 + 120 * v.spray,
		// BOTH brightness and stiffness, because a contact's timbre depends on both and using
		// only one threw away half of what the table knows. With brightness alone, rock (low
		// spray, high ring) and dry sand (high spray, low ring) traded their differences off
		// against each other and measured 0.036 apart — two of the most dissimilar materials
		// in the game reading as the same machine. Pitch is the axis that separates them.
		grainBrightHz: 520 * v.bright + 420 * v.pitch + 150,
		grainLevel: 0.85 * v.spray,
		grainRingS: v.ring,
		durationS: 1.0,
		targetPeak: 0.85,
		crossfadeS: LOOP_CROSSFADE_S,
	}
}

/**
 * Infantry movement: the same loop machinery, but the pulse IS the gait. Two to three
 * discrete footfalls per second — a noise scuff over a low boot thump — with the grain
 * terms demoted to a whisper of ground under the boot. The continuous engine-chug loop
 * that vehicles use read as a dragging body when carried by a soldier, which is exactly
 * the failure the class axis exists to prevent.
 */
export function footstepParams(surface: number): LoopParams {
	const v = SURFACE_VOICING[surface] ?? SURFACE_VOICING[0]
	return {
		pulseHz: 2.3,
		pulseF0: 66 + 26 * v.bright,
		pulseLevel: 0.92,
		rumbleHz: 150,
		rumbleLevel: 0.10,
		grainHz: 30 + 90 * v.spray,
		grainBrightHz: 900 * v.bright + 300,
		grainLevel: 0.16 * v.spray,
		grainRingS: v.ring * 0.5,
		durationS: 1.0,
		targetPeak: 0.62,
		crossfadeS: LOOP_CROSSFADE_S,
	}
}

// ---------------------------------------------------------------------------
// Notification. The one sound in the game that is NOT in the world.
// ---------------------------------------------------------------------------

/**
 * A struck bell, for "the thing you ordered is ready".
 *
 * Not built on `renderBlast`, and that is the point: every other voice here is a pressure
 * event with a noise blast at the front, which is what makes gunfire and destruction feel like
 * physics. A notification must cut THROUGH that, and a fifth kind of bang cannot — in a
 * firefight it would land as one more impact and be missed, which for feedback about your own
 * economy is the whole failure.
 *
 * A bell is inharmonic partials with independent decays, so it is written as such. §9.0 wants
 * grounded art direction and no science fiction: this is a small struck brass bell on a
 * factory wall, not a synthesised alert.
 */
const BELL_PARTIALS = [1.0, 2.76, 5.40, 8.93, 13.34]
const BELL_DECAYS = [1.00, 0.62, 0.42, 0.28, 0.20]

export function renderBell(f0: number, durationS: number, sampleRate: number, seed: number): Voice {
	const n = Math.max(1, Math.round(durationS * sampleRate))
	const out = new Float32Array(n)
	const rnd = seededNoise(seed)
	const dt = 1 / sampleRate
	const tau = durationS * 0.26

	// The strike itself: a very short noise transient. Without it a bell is a chord fading in
	// from nothing, and the ear reads the hammer, not the tone.
	const strikeTau = 0.004
	for (let i = 0; i < n; i++) {
		const t = i * dt
		let s = rnd() * Math.exp(-t / strikeTau) * 0.55
		for (let k = 0; k < BELL_PARTIALS.length; k++) {
			// Partials that are not harmonic multiples are what separates a bell from an organ.
			s += Math.sin(2 * Math.PI * f0 * BELL_PARTIALS[k] * t) *
				Math.exp(-t / (tau * BELL_DECAYS[k])) / (k + 1.6)
		}
		out[i] = s
	}

	let peak = 0
	for (let i = 0; i < n; i++) {
		const a = Math.abs(out[i])
		if (a > peak) peak = a
	}
	const g = peak > 1e-9 ? 0.80 / peak : 0
	let outPeak = 0
	let peakIndex = 0
	for (let i = 0; i < n; i++) {
		const x = out[i] * g
		const y = x < -1 ? -1 : x > 1 ? 1 : x - (x * x * x) / 3
		out[i] = y
		const a = Math.abs(y)
		if (a > outPeak) { outPeak = a; peakIndex = i }
	}
	const fade = Math.min(Math.round(0.004 * sampleRate), (n / 2) | 0)
	for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade

	return { samples: out, sampleRate, attackS: peakIndex / sampleRate, peak: outPeak }
}

/**
 * Production complete. One voice; there is nothing functional to derive a second one from.
 *
 * RAISED FROM 520 Hz WHEN THE FAMILIES LANDED, and by measurement rather than by taste. The
 * bell's whole job is to be identified while a firefight is happening, and `audiogate` asserts
 * that by requiring it to sit clear of every voice a weapon can make. Against a report bank of
 * eight voices spanning 70..268 Hz that was easy. Against twelve families it is not: the heal
 * tone measured 543 Hz and the old bell 563 Hz — a 3.7% difference, which is to say the same
 * sound. 880 clears the whole bank with margin and is a better factory bell anyway; a small
 * struck bell on a wall is not a 520 Hz object.
 */
export const NOTIFY_F0 = 1100
export const NOTIFY_DURATION_S = 1.1

// ---------------------------------------------------------------------------
// WEAPON FAMILIES. The axis this file argued against, arrived at by the route it named.
//
// The header above says "damage designs the sound, weapon class only varies it", and adds:
// "if that ever feels too coarse, the fix is a richer §4.9 payload (reload and burst are
// already authored in the mod and would both be good second axes), NOT a table here." That is
// exactly what happened, and the reason it had to is measurable rather than aesthetic.
//
// THE OLD RULE DID NOT DEGRADE. IT FAILED OUTRIGHT.
//
//   1. `heaviness()` clamped damage to 50..1000; the fire event sends 100..65535. Forty-seven
//      of the fifty authored weapons landed in band 7, so a bank of eight voices played one.
//   2. Even uncapped, damage does not order these weapons. `SilencedPPK` — a silenced pistol —
//      deals 15000. A `120mm` tank cannon deals 6000. `Colt45` deals 10000. RA's damage number
//      is a BALANCE quantity, and a synth keyed on it alone makes the pistol the biggest gun
//      on the field no matter how carefully the curve is drawn.
//   3. No damage produces a tesla coil. An electrical discharge has no propellant, no breech
//      and no combustion body; a rocket has a MOTOR THAT KEEPS BURNING after the launch. Both
//      are shapes `renderBlast` cannot make at any parameter setting, because a blast is by
//      construction a single pressure release with a decay.
//
// WHAT THE FAMILY IS DERIVED FROM, AND WHY IT IS NOT §14.13's FORBIDDEN NAME TABLE.
//
// `weapon-audio.json` is generated by `tools/weapon-audio.mjs` from the mod yaml, and the
// fields it reads are the ones the SIMULATION acts on: the death type the warhead applies
// (`ElectricityDeath`, `FireDeath`), the projectile class (`Missile`, `TeslaZap`,
// `GravityBomb`), the launch angle, the rate of fire implied by `ReloadDelay`/`Burst`, the
// number of simultaneous damage warheads — and the mod's own `Report:` declaration, which is
// the game telling us in its own rules which sound it wants. The weapon's NAME is used for one
// thing only: as the join key, resolved from the fire event's string-table id through
// `ctx.actorTypeName`, exactly as `fx/index.ts` already resolves it before asking
// `lookupRaWeaponVisual`. That is the difference between reading the mod and inventing a table.
//
// The derivation is cross-checked against the 50 hand-authored families in
// `weapon-visual-manifest.json` and agrees on 49 of them; `weapon-audio.mjs --check` fails if
// that number moves in either direction.
//
// SCALE DID NOT GO AWAY, IT STOPPED BEING THE ONLY AXIS. Damage still picks the band inside a
// family and still moves the fundamental, the brightness and the decay; `audio/index.ts` then
// applies a CONTINUOUS playback-rate correction from the exact damage to the band's centre, so
// the size axis is smooth with three buffers per family rather than quantised with eight.
// ---------------------------------------------------------------------------

/**
 * Bank order. Must match `families` in `weapon-audio.json`; `audiogate` asserts it does,
 * because a silent reordering here would voice every rocket as a rifle.
 */
export const FAMILY = {
	cannon: 0,
	artillery: 1,
	mg: 2,
	rifle: 3,
	rocket: 4,
	torpedo: 5,
	electric: 6,
	flame: 7,
	bomb: 8,
	melee: 9,
	heal: 10,
	utility: 11,
} as const
export const FAMILY_NAMES = [
	'cannon', 'artillery', 'mg', 'rifle', 'rocket', 'torpedo',
	'electric', 'flame', 'bomb', 'melee', 'heal', 'utility',
] as const
export const FAMILY_COUNT = FAMILY_NAMES.length

/**
 * Does this family STRIKE or does it SWELL?
 *
 * Declared rather than measured, so `audiogate` can compare the declaration against the
 * waveform and fail either way round. The one-shot onset assertion in that gate could only
 * ever catch a strike that had gone soft; with this it also catches a flamethrower that has
 * acquired a muzzle blast, which is the more likely regression now that eleven of the twelve
 * families are built on the blast primitive.
 */
export const FAMILY_IMPULSIVE: readonly boolean[] = [
	/* cannon    */ true,
	/* artillery */ true,
	/* mg        */ true,
	/* rifle     */ true,
	/* rocket    */ true,
	/* torpedo   */ true,
	/* electric  */ true,
	/* flame     */ false,
	/* bomb      */ true,
	/* melee     */ true,
	// A struck tone. The glissando in `familyRecipe` is in PITCH — the body glides upward onto
	// f0 — and the amplitude envelope is as immediate as any of the guns. Declared `false`
	// first, on the reasoning that a friendly sound ought to be gentle, and the gate measured
	// 100% of peak inside 3 ms and said so. The declaration was wrong, not the sound.
	/* heal      */ true,
	/* utility   */ true,
]

/**
 * Does a second round of this weapon land ON TOP of the first, by design?
 *
 * A machine gun's identity IS its cadence, so its voice has to be out of the way before the
 * next round arrives or the burst reads as a drone. A flamethrower's identity is the opposite:
 * `Flamer` declares `Burst: 15, BurstDelays: 1` — a round every 40 ms — and fifteen separated
 * puffs would be a rattle, not a jet. `audiogate` asserts the fit for the families that must
 * fit and prints the overlap for the ones that must not, rather than relaxing one threshold
 * until both pass.
 */
/**
 * Which PHYSICAL EXCITATION each family is, as an index.
 *
 * Two families share an excitation when the thing making the noise is the same and only its
 * size or its angle differs. That is a real distinction and it decides how far apart the gate
 * may reasonably ask two voices to be:
 *
 *   charge   cannon, artillery — a propellant charge in a tube, fired flat or lobbed
 *   smallarm mg, rifle          — a cartridge in a barrel, fired fast or once
 *   motor    rocket, torpedo    — a burning grain, in air or in water
 *   discharge electric          — a plasma channel. Nothing else in the game is one.
 *   jet      flame              — sustained combustion of a fuel stream
 *   release  bomb               — a mechanism letting go; no combustion at all
 *   organic  melee              — jaws
 *   tone     heal, utility      — not weapons
 *
 * A heavy tank gun and a medium howitzer measure 0.106 apart on the gate's five-feature
 * signature, and that is CORRECT: they are the same event at neighbouring scales, and the mod
 * itself separates them by `LaunchAngle` rather than by mechanism. Requiring them to be as far
 * apart as a rocket is from a tesla coil would mean tuning the world until the instrument was
 * satisfied, which is the failure `audiogate`'s own header warns about. So the gate asserts a
 * high floor ACROSS excitations and the ordinary band floor WITHIN one — and that split has to
 * be declared here, where the physics is, rather than as a list of excused pairs in the gate.
 */
export const FAMILY_EXCITATION: readonly number[] = [
	/* cannon    */ 0,
	/* artillery */ 0,
	/* mg        */ 1,
	/* rifle     */ 1,
	/* rocket    */ 2,
	/* torpedo   */ 2,
	/* electric  */ 3,
	/* flame     */ 4,
	/* bomb      */ 5,
	/* melee     */ 6,
	/* heal      */ 7,
	/* utility   */ 7,
]

/**
 * Does DAMAGE move this family's voice at all?
 *
 * False for the two families whose fire event always carries zero: `Heal` and `Repair` publish
 * the SUM OF POSITIVE damages, which for a healing warhead is 0, and `DemoTruckTargeting` has
 * no warhead that does damage. Their three bands are therefore identical by construction, and
 * only band 0 is ever played.
 *
 * Declared rather than inferred so `audiogate` can assert BOTH directions: the ten scaling
 * families must be monotone and separated band to band, and these two must be bit-identical.
 * A `w` term added to `heal` without thinking would fail the second half — which is the more
 * likely mistake, because every other recipe in the file has one.
 */
export const FAMILY_SCALES: readonly boolean[] = [
	/* cannon    */ true,
	/* artillery */ true,
	/* mg        */ true,
	/* rifle     */ true,
	/* rocket    */ true,
	/* torpedo   */ true,
	/* electric  */ true,
	/* flame     */ true,
	/* bomb      */ true,
	/* melee     */ true,
	/* heal      */ false,
	/* utility   */ false,
]

export const FAMILY_OVERLAPS: readonly boolean[] = [
	/* cannon    */ false,
	/* artillery */ false,
	/* mg        */ false,
	/* rifle     */ false,
	/* rocket    */ true,
	/* torpedo   */ true,
	/* electric  */ true,
	/* flame     */ true,
	/* bomb      */ true,
	/* melee     */ false,
	/* heal      */ true,
	/* utility   */ false,
]

// ---------------------------------------------------------------------------
// Motor. A rocket is not a blast, and this is the function that says so.
//
// A gun's whole event is over in the first ten milliseconds; everything after that is the
// room. A rocket's whole event is what happens AFTER the first ten milliseconds — the igniter
// lights, the grain starts burning, and a turbulent supersonic exhaust roars for as long as
// there is propellant. Rendering that as a blast with a longer tail gets the length right and
// the physics exactly backwards: the tail of a blast is DECAYING ROOM, which is quiet and
// dark, and a motor is a SUSTAINED SOURCE, which is loud and bright and moving away from you.
// ---------------------------------------------------------------------------

export interface MotorParams {
	/** Igniter transient level and time constant. The bang before the burn. */
	ignitionLevel: number
	ignitionTauS: number
	/** Exhaust band, start and end. It falls as the motor departs. */
	motorStartHz: number
	motorEndHz: number
	motorResonance: number
	motorLevel: number
	/** Seconds of burn. The exhaust envelope's time constant, not a hard cutoff. */
	burnS: number
	/** Low body of the exhaust column. */
	rumbleF0: number
	rumbleLevel: number
	/** Turbulence: how fast the exhaust flutters and how deep. */
	flutterHz: number
	flutterDepth: number
	/** Seconds the motor takes to reach full thrust. Short, but never zero — it is not a bang. */
	spoolS: number
	durationS: number
	targetPeak: number
}

export function renderMotor(p: MotorParams, sampleRate: number, seed: number): Voice {
	const n = Math.max(1, Math.round(p.durationS * sampleRate))
	const out = new Float32Array(n)
	const rnd = seededNoise(seed)
	const dt = 1 / sampleRate

	const exhaust: Svf = { low: 0, band: 0, high: 0 }
	const igniter: Svf = { low: 0, band: 0, high: 0 }
	const fIgnite = svfCoeff(4200, sampleRate)
	const qExhaust = 1 - Math.min(Math.max(p.motorResonance, 0), 0.95)
	// Log interpolation between the two band centres: a motor moving away drops its brightness
	// by a RATIO per second, not by a number of hertz per second.
	const bandRatio = Math.log(Math.max(p.motorEndHz, 20) / Math.max(p.motorStartHz, 20))

	// Turbulence as a smoothed random walk rather than a sine. A pure LFO on the exhaust reads
	// as a wobble — a synthesiser effect — where real combustion instability is broadband and
	// irregular. One-pole smoothing at `flutterHz` turns white noise into exactly that.
	const flutterK = 1 - Math.exp(-2 * Math.PI * p.flutterHz / sampleRate)
	let flutter = 0

	let rumblePhase = 0
	let peak = 0
	let peakIndex = 0

	for (let i = 0; i < n; i++) {
		const t = i * dt
		// Spool-up times DECAY. The product is what makes a motor read as thrust arriving and
		// then leaving, rather than as a noise burst with a fade.
		const spool = p.spoolS > 0 ? 1 - Math.exp(-t / p.spoolS) : 1
		const burn = Math.exp(-t / p.burnS)
		const env = spool * burn

		const white = rnd()
		flutter += (white - flutter) * flutterK
		const turb = 1 + p.flutterDepth * flutter

		const fc = Math.max(p.motorStartHz, 20) * Math.exp(bandRatio * Math.min(t / p.durationS, 1))
		svfStep(exhaust, white, svfCoeff(fc, sampleRate), qExhaust)

		// The igniter. Its own much faster envelope, and it is band-limited HIGH — an igniter
		// is a squib, not a charge, so it must not put a low body under the motor or the whole
		// voice collapses back into a blast.
		svfStep(igniter, white, fIgnite, 0.6)
		const ignite = igniter.high * p.ignitionLevel * Math.exp(-t / p.ignitionTauS)

		// The exhaust column's own low resonance, gliding down with the band.
		rumblePhase += 2 * Math.PI * p.rumbleF0 * (0.75 + 0.35 * burn) * dt
		const rumble = Math.sin(rumblePhase) * p.rumbleLevel * env

		const s = exhaust.band * p.motorLevel * env * turb + ignite + rumble
		out[i] = s
		const a = Math.abs(s)
		if (a > peak) { peak = a; peakIndex = i }
	}

	return normalise(out, sampleRate, p.targetPeak, peakIndex)
}

// ---------------------------------------------------------------------------
// Discharge. Electricity, which has no combustion in it anywhere.
//
// TIMED TO THE BOLT THAT IS ALREADY ON SCREEN. `fx/tesla-arc.ts` draws a strike as
// `ARC_LIFETIME_S = 0.22` seconds in `FLICKER_STEPS = 4` discrete steps. A crackle that ran
// for a different length, or that was continuous where the bolt flickers, would make the bolt
// and its sound two events that happened near each other. These constants are the same two
// numbers, and `audiogate` asserts the rendered envelope has four peaks inside 0.22 s — a
// check that fails the moment either side is retimed without the other.
// ---------------------------------------------------------------------------

/** Mirrors `fx/tesla-arc.ts`. Duplicated deliberately: rule 3 forbids importing that node. */
export const TESLA_ARC_LIFETIME_S = 0.22
export const TESLA_FLICKER_STEPS = 4

export interface DischargeParams {
	/** How many discrete re-strikes, and how far apart. Mirrors the bolt's flicker. */
	strikes: number
	strikeIntervalS: number
	/** Per-strike decay. Shorter than the interval, or the flicker fuses into a buzz. */
	strikeTauS: number
	/** Micro-crackle: ionisation events per second and their resonator centre. */
	crackleHz: number
	crackleHz2: number
	crackleQ: number
	crackleLevel: number
	/** The arc's own hum. Odd harmonics only — an arc is a switching waveform, not a sine. */
	buzzHz: number
	buzzLevel: number
	/** Ionisation tail after the last strike. Air that has been made a conductor. */
	tailS: number
	durationS: number
	targetPeak: number
}

export function renderDischarge(p: DischargeParams, sampleRate: number, seed: number): Voice {
	const n = Math.max(1, Math.round(p.durationS * sampleRate))
	const out = new Float32Array(n)
	const rnd = seededNoise(seed)
	const dt = 1 / sampleRate

	const crackle: Svf = { low: 0, band: 0, high: 0 }
	const f1 = svfCoeff(p.crackleHz, sampleRate, 0.16)
	const f2 = svfCoeff(p.crackleHz2, sampleRate, 0.16)
	const q = 1 - Math.min(Math.max(p.crackleQ, 0), 0.95)

	let buzzPhase = 0
	let peak = 0
	let peakIndex = 0
	const strikeSpan = p.strikes * p.strikeIntervalS

	for (let i = 0; i < n; i++) {
		const t = i * dt

		// The flicker envelope. Each strike restarts, so the envelope has `strikes` peaks and
		// is genuinely discontinuous between them — which is what the eye sees on screen.
		let env = 0
		if (t < strikeSpan) {
			const phase = t % p.strikeIntervalS
			// Later strikes are weaker: the capacitor is emptying.
			const k = Math.floor(t / p.strikeIntervalS)
			env = Math.exp(-phase / p.strikeTauS) * Math.pow(0.72, k)
		} else {
			env = Math.exp(-(t - strikeSpan) / p.tailS) * Math.pow(0.72, p.strikes)
		}

		// Two resonators at once, alternating per sample on the noise sign, which is the
		// cheapest way to get the broad double-formant an arc has without a second filter pass.
		const white = rnd()
		svfStep(crackle, white, white >= 0 ? f1 : f2, q)

		// Odd harmonics. An arc is a plasma switching on and off, so its spectrum is closer to
		// a square than to anything smooth, and the odd series is what makes it read as
		// ELECTRICAL rather than as a filtered hiss.
		buzzPhase += 2 * Math.PI * p.buzzHz * dt
		const buzz = (Math.sin(buzzPhase) + Math.sin(3 * buzzPhase) / 3 + Math.sin(5 * buzzPhase) / 5)
			* p.buzzLevel

		// NO BODY TERM AND NO MECHANISM. Both were tried; both make it a gun. A tesla coil has
		// nothing that moves and nothing that burns.
		const s = (crackle.band * p.crackleLevel + buzz) * env
		out[i] = s
		const a = Math.abs(s)
		if (a > peak) { peak = a; peakIndex = i }
	}

	return normalise(out, sampleRate, p.targetPeak, peakIndex)
}

// ---------------------------------------------------------------------------
// Flame. The one family with no transient at all.
//
// Every other voice in this file starts with a strike. A flamethrower does not: fuel reaches
// the igniter, the jet establishes, and it ROARS. The attack is tens of milliseconds and the
// gate asserts it — `FAMILY_IMPULSIVE[flame] === false` is a claim about the waveform, not a
// note in a comment.
// ---------------------------------------------------------------------------

export interface FlameParams {
	/** Seconds to full jet. Long enough to be measurably NOT a bang. */
	attackS: number
	/** Seconds of established jet before it falls away. */
	burnS: number
	/** Roar band. Broad and low-mid: burning gas is turbulence, not hiss. */
	roarHz: number
	roarResonance: number
	roarLevel: number
	/** Hiss band. The unburnt fuel leaving the nozzle. */
	hissHz: number
	hissLevel: number
	/** Combustion instability — the flap. Slow and deep. */
	flutterHz: number
	flutterDepth: number
	durationS: number
	targetPeak: number
}

export function renderFlame(p: FlameParams, sampleRate: number, seed: number): Voice {
	const n = Math.max(1, Math.round(p.durationS * sampleRate))
	const out = new Float32Array(n)
	const rnd = seededNoise(seed)
	const dt = 1 / sampleRate

	const roar: Svf = { low: 0, band: 0, high: 0 }
	const hiss: Svf = { low: 0, band: 0, high: 0 }
	const fRoar = svfCoeff(p.roarHz, sampleRate)
	const fHiss = svfCoeff(p.hissHz, sampleRate)
	const qRoar = 1 - Math.min(Math.max(p.roarResonance, 0), 0.95)

	const flutterK = 1 - Math.exp(-2 * Math.PI * p.flutterHz / sampleRate)
	let flutter = 0
	let peak = 0
	let peakIndex = 0

	for (let i = 0; i < n; i++) {
		const t = i * dt
		// A raised cosine rather than an exponential attack. An exponential still has all its
		// curvature at t=0 and reads as a soft bang; a cosine starts at zero SLOPE as well as
		// zero level, which is the difference between a jet establishing and a puff.
		const rise = t < p.attackS ? 0.5 - 0.5 * Math.cos(Math.PI * t / p.attackS) : 1
		const fall = Math.exp(-Math.max(0, t - p.attackS) / p.burnS)
		const env = rise * fall

		const white = rnd()
		flutter += (white - flutter) * flutterK
		const turb = 1 + p.flutterDepth * flutter

		svfStep(roar, white, fRoar, qRoar)
		svfStep(hiss, white, fHiss, 0.7)

		// `hiss.band`, not `hiss.high`. The high output of a state-variable filter is the whole
		// residual above cutoff, not a band — it carried more energy than the roar did, and the
		// measured centroid came out at 2.7 kHz and RISING with size, which is a flamethrower
		// that gets brighter as it gets bigger. A jet of burning fuel does the opposite.
		const s = (roar.band * p.roarLevel * turb + hiss.band * p.hissLevel) * env
		out[i] = s
		const a = Math.abs(s)
		if (a > peak) { peak = a; peakIndex = i }
	}

	return normalise(out, sampleRate, p.targetPeak, peakIndex)
}

/**
 * Shared normalise / soft-clip / end-fade, extracted from `renderBlast` when the second and
 * third one-shot renderers arrived.
 *
 * The end fade is the part worth not duplicating: three milliseconds of taper is what keeps a
 * voice that ends mid-decay from clicking on every playback, it is inaudible in isolation on
 * laptop speakers, and it is exactly the kind of detail a fourth renderer written in a hurry
 * would omit.
 */
function normalise(out: Float32Array, sampleRate: number, targetPeak: number, peakIndex: number): Voice {
	const n = out.length
	let peak = 0
	for (let i = 0; i < n; i++) { const a = Math.abs(out[i]); if (a > peak) peak = a }
	const g = peak > 1e-9 ? targetPeak / peak : 0
	let outPeak = 0
	for (let i = 0; i < n; i++) {
		const x = out[i] * g
		const y = x < -1 ? -1 : x > 1 ? 1 : x - (x * x * x) / 3
		out[i] = y
		const a = Math.abs(y)
		if (a > outPeak) outPeak = a
	}
	const fade = Math.min(Math.round(0.003 * sampleRate), (n / 2) | 0)
	for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade
	return { samples: out, sampleRate, attackS: peakIndex / sampleRate, peak: outPeak }
}

// ---------------------------------------------------------------------------
// The twelve recipes.
//
// Every coefficient below is a statement about the physical world that a reader can dispute,
// and the families are written so that DISPUTING ONE DOES NOT MOVE THE OTHERS — which is the
// property the single `reportParams` curve could not have.
// ---------------------------------------------------------------------------

export type VoiceRecipe =
	| { kind: 'blast'; blast: BlastParams }
	| { kind: 'motor'; motor: MotorParams }
	| { kind: 'discharge'; discharge: DischargeParams }
	| { kind: 'flame'; flame: FlameParams }

export function familyRecipe(family: number, damage: number): VoiceRecipe {
	const w = heaviness(damage)
	switch (family) {
		// A charge in a tube, fired flat. Sharp transient, low body, a tail that is the
		// landscape answering. The crack is the projectile and does NOT grow with the charge,
		// which is why its level falls as `w` rises.
		case FAMILY.cannon: {
			const tauTail = 0.20 + 0.42 * w
			return { kind: 'blast', blast: {
				f0: 170 * Math.pow(0.42, w),
				cutoffHz: 2200 * Math.pow(0.40, w),
				resonance: 0.34 + 0.30 * w,
				tauBlast: 0.014 + 0.030 * w,
				tauBody: 0.055 + 0.180 * w,
				tauTail,
				blastLevel: 1,
				bodyLevel: 0.55 + 0.55 * w,
				crackLevel: 0.75 * (1 - 0.50 * w),
				tailLevel: 0.20 + 0.22 * w,
				sweep: 0.62 + 0.20 * w,
				mechLevel: 1,
				durationS: Math.min(0.09 + tauTail * 3.2, 1.6),
				targetPeak: 0.92,
			} }
		}
		// The same charge lobbed. A howitzer is heard from behind and below its own shell: more
		// body, far more tail, and almost no crack, because the round leaves at a high angle
		// and its supersonic cone never passes the listener.
		case FAMILY.artillery: {
			const tauTail = 0.40 + 0.75 * w
			return { kind: 'blast', blast: {
				f0: 118 * Math.pow(0.44, w),
				cutoffHz: 1500 * Math.pow(0.38, w),
				resonance: 0.42 + 0.30 * w,
				tauBlast: 0.028 + 0.055 * w,
				// 0.085 + 0.24w, not 0.110 + 0.30w. `8Inch` declares `Burst: 2` with the default
				// `BurstDelays: 5` — two rounds 0.200 s apart — and at the longer body its voice
				// was still at 0.201 s to half peak when the second round landed, so the pair
				// read as one smeared boom. This is the cadence rule biting a coefficient, which
				// is the correct direction: the world is not tuned to satisfy the gate, the gate
				// reports a fact about the mod and the coefficient moves.
				tauBody: 0.085 + 0.240 * w,
				tauTail,
				blastLevel: 1,
				bodyLevel: 0.80 + 0.60 * w,
				crackLevel: 0.26 * (1 - 0.50 * w),
				tailLevel: 0.36 + 0.28 * w,
				sweep: 0.90,
				mechLevel: 1.35,
				durationS: Math.min(0.12 + tauTail * 3.0, 2.2),
				targetPeak: 0.94,
			} }
		}
		// A machine gun's identity is its RATE, so the single round has to get out of the way.
		// Nearly no tail, a dominant crack, and a bolt loud enough to be part of the rhythm.
		// The simulation already emits one fire event per round at the real `BurstDelays`
		// cadence (`Armament.cs` raises it inside the per-burst delayed action), so the
		// repetition is the mod's, not ours — all this has to do is be short enough to show it.
		case FAMILY.mg: {
			const tauTail = 0.026 + 0.030 * w
			return { kind: 'blast', blast: {
				f0: 320 * Math.pow(0.55, w),
				cutoffHz: 4200 * Math.pow(0.55, w),
				resonance: 0.22 + 0.14 * w,
				tauBlast: 0.0055 + 0.0060 * w,
				tauBody: 0.012 + 0.020 * w,
				tauTail,
				blastLevel: 0.90,
				bodyLevel: 0.30 + 0.25 * w,
				crackLevel: 0.95,
				tailLevel: 0.10,
				sweep: 0.35,
				mechLevel: 0.55,
				durationS: 0.03 + tauTail * 3.0,
				targetPeak: 0.86,
			} }
		}
		// One shot in the open. Brighter and drier than a cannon, longer than a machine gun
		// round because there is time for the ground to answer, and the slide or bolt is a
		// bigger fraction of the whole event than in any other family.
		case FAMILY.rifle: {
			const tauTail = 0.075 + 0.100 * w
			return { kind: 'blast', blast: {
				f0: 260 * Math.pow(0.50, w),
				cutoffHz: 3400 * Math.pow(0.50, w),
				resonance: 0.26 + 0.18 * w,
				tauBlast: 0.009 + 0.010 * w,
				tauBody: 0.022 + 0.045 * w,
				tauTail,
				blastLevel: 0.95,
				bodyLevel: 0.28 + 0.30 * w,
				crackLevel: 0.80,
				tailLevel: 0.16,
				sweep: 0.45,
				mechLevel: 0.80,
				durationS: 0.04 + tauTail * 3.2,
				targetPeak: 0.88,
			} }
		}
		// Ignition, then a motor that keeps burning. The band falls as it departs; a bigger
		// rocket burns longer and lower. `SCUD` at 4500 and `SubMissileAA` at 450 are the two
		// ends of this and must not be the same sound at two volumes.
		case FAMILY.rocket:
			return { kind: 'motor', motor: {
				ignitionLevel: 0.85 - 0.25 * w,
				ignitionTauS: 0.020 + 0.022 * w,
				motorStartHz: 1500 * Math.pow(0.55, w),
				motorEndHz: 420 * Math.pow(0.60, w),
				motorResonance: 0.38 + 0.18 * w,
				motorLevel: 1,
				burnS: 0.38 + 0.55 * w,
				rumbleF0: 92 * Math.pow(0.62, w),
				rumbleLevel: 0.22 + 0.34 * w,
				flutterHz: 26 + 16 * (1 - w),
				flutterDepth: 0.55,
				spoolS: 0.012 + 0.016 * w,
				// 3.4 burn constants, not 3.0, and no cap below what that reaches. A motor's
				// envelope is a spool-up TIMES a decay, so it is still above 3% of peak at
				// 3.0 tau — the torpedo's heaviest band ended at level 0.020 and clicked on
				// every launch. Capping duration to save memory is what truncated the water
				// impact tail once already; the note on `impactParams` says the thing to
				// shorten is the SOUND, and the burn constant is where that is done.
				durationS: 0.20 + (0.38 + 0.55 * w) * 3.4,
				targetPeak: 0.90,
			} }
		// A motor under water. The launch is a compressed-air thump the water swallows, the
		// band is far darker than any air-breathing rocket because water is a low-pass, and the
		// flutter is slower because the medium is a thousand times denser.
		case FAMILY.torpedo:
			return { kind: 'motor', motor: {
				ignitionLevel: 0.45,
				ignitionTauS: 0.055,
				motorStartHz: 640 * Math.pow(0.62, w),
				motorEndHz: 190 * Math.pow(0.65, w),
				motorResonance: 0.55,
				motorLevel: 1,
				burnS: 0.55 + 0.40 * w,
				rumbleF0: 62 * Math.pow(0.70, w),
				rumbleLevel: 0.46 + 0.28 * w,
				flutterHz: 11,
				flutterDepth: 0.72,
				spoolS: 0.045,
				durationS: 0.25 + (0.55 + 0.40 * w) * 3.4,
				targetPeak: 0.88,
			} }
		// Four strikes in 0.22 s, matching the bolt on screen exactly, then an ionisation tail.
		// No body, no mechanism, no blast — see `renderDischarge`.
		case FAMILY.electric:
			return { kind: 'discharge', discharge: {
				strikes: TESLA_FLICKER_STEPS,
				strikeIntervalS: TESLA_ARC_LIFETIME_S / TESLA_FLICKER_STEPS,
				strikeTauS: 0.016 + 0.010 * w,
				crackleHz: 2600 - 700 * w,
				crackleHz2: 5200 - 1400 * w,
				crackleQ: 0.80,
				// FOUR, not one, and the reason is a measurement. An SVF's bandpass output on
				// unit noise sits around 0.1-0.3 peak while the odd-harmonic buzz below reaches
				// 1.15, so at `crackleLevel: 1` the buzz was three to four times the louder term
				// and the whole voice measured at a 799 Hz centroid — DARKER than the machine
				// gun. A tesla coil is the brightest thing on the battlefield; whichever term
				// carries that has to be the one in front.
				crackleLevel: 4.5,
				// Not 50 or 60: a coil is not mains, it is a spark gap running at whatever its
				// break rate is. Low enough to be felt as a growl under the crackle.
				buzzHz: 118 - 34 * w,
				buzzLevel: 0.16 + 0.10 * w,
				tailS: 0.075 + 0.045 * w,
				durationS: TESLA_ARC_LIFETIME_S + 0.28 + 0.14 * w,
				targetPeak: 0.90,
			} }
		// Fuel, ignition, roar. The only family that swells.
		case FAMILY.flame:
			return { kind: 'flame', flame: {
				attackS: 0.030 + 0.020 * w,
				burnS: 0.16 + 0.26 * w,
				roarHz: 420 - 150 * w,
				roarResonance: 0.30,
				roarLevel: 1,
				hissHz: 2400 - 900 * w,
				hissLevel: 0.34 - 0.12 * w,
				flutterHz: 17 + 9 * (1 - w),
				flutterDepth: 0.85,
				durationS: 0.030 + 0.020 * w + (0.16 + 0.26 * w) * 3.4,
				targetPeak: 0.84,
			} }
		// A bomb release has no propellant. What you hear is the shackle letting go and the
		// airflow finding a new shape — a mechanism event with a long soft tail and no crack.
		case FAMILY.bomb: {
			// PITCHED WHERE A SHACKLE AND A CANOPY ARE, not where a warhead is. Voiced first at
			// f0 130 and a 900 Hz blast band, which put it at a 93 Hz centroid — two hertz from
			// the heavy rocket motor, and the two measured 0.2002 apart against a 0.20 floor.
			// That was the right measurement finding a real mistake: the low end of a bomb is
			// the EXPLOSION, which this event is not. A release is metal letting go and fabric
			// catching air, and both of those live two octaves up.
			// AND SHORT. Voiced at a 0.55 s tail it measured 0.15 from the lightest rocket
			// motor — a shackle release lasting as long as a missile burn. What actually
			// happens is over in half a second: the hook lets go, the canopy snaps out, and
			// the bomb is gone. Nothing sustains, because nothing is burning.
			const tauTail = 0.14 + 0.10 * w
			return { kind: 'blast', blast: {
				f0: 230 * Math.pow(0.78, w),
				cutoffHz: 1700 * Math.pow(0.72, w),
				resonance: 0.16,
				tauBlast: 0.055,
				tauBody: 0.050 + 0.060 * w,
				tauTail,
				blastLevel: 0.42,
				bodyLevel: 0.18,
				crackLevel: 0.10,
				tailLevel: 0.46,
				sweep: 0.18,
				mechLevel: 1.9,
				durationS: 0.09 + tauTail * 3.4,
				targetPeak: 0.62,
			} }
		}
		// Jaws and mandibles. Organic: a contact and a body, no propellant, no mechanism, and
		// over almost immediately.
		case FAMILY.melee: {
			const tauTail = 0.045 + 0.045 * w
			return { kind: 'blast', blast: {
				f0: 240 * Math.pow(0.55, w),
				cutoffHz: 1800 * Math.pow(0.60, w),
				resonance: 0.30 + 0.20 * w,
				tauBlast: 0.006 + 0.006 * w,
				tauBody: 0.030 + 0.050 * w,
				tauTail,
				blastLevel: 0.35,
				bodyLevel: 0.55 + 0.30 * w,
				crackLevel: 0.85,
				tailLevel: 0.12,
				sweep: 0.25,
				mechLevel: 0,
				durationS: 0.03 + tauTail * 3.2,
				targetPeak: 0.78,
			} }
		}
		// Not a weapon. A RISING tone — `sweep` is negative, so the body glides UP onto f0 —
		// because every hostile event in this game falls and the ear reads the direction before
		// it reads the pitch. No noise, no mechanism, nothing that could be mistaken for a shot.
		case FAMILY.heal:
			return { kind: 'blast', blast: {
				f0: 660,
				cutoffHz: 2400,
				resonance: 0.10,
				tauBlast: 0.004,
				// 0.115, not 0.170. At the longer constant the body was still at 3% of peak
				// when the 0.42 s buffer ended, which is a step discontinuity — a click on
				// every heal, and the one defect in procedural audio that is inaudible on
				// laptop speakers in isolation and obvious in a mix.
				tauBody: 0.115,
				tauTail: 0.060,
				blastLevel: 0.05,
				bodyLevel: 1,
				crackLevel: 0,
				tailLevel: 0.06,
				sweep: -0.34,
				mechLevel: 0,
				durationS: 0.42,
				targetPeak: 0.52,
			} }
		// A targeting designator. Deliberately the quietest thing in the bank: it is feedback
		// that a thing was aimed at, not that anything happened to it.
		default:
			return { kind: 'blast', blast: {
				f0: 430,
				cutoffHz: 1700,
				resonance: 0.12,
				tauBlast: 0.005,
				tauBody: 0.045,
				tauTail: 0.030,
				blastLevel: 0.10,
				bodyLevel: 0.85,
				crackLevel: 0.06,
				tailLevel: 0.05,
				sweep: 0.10,
				mechLevel: 0.35,
				durationS: 0.18,
				targetPeak: 0.42,
			} }
	}
}

/** Render whichever primitive a family's recipe names. */
export function renderRecipe(recipe: VoiceRecipe, sampleRate: number, seed: number): Voice {
	switch (recipe.kind) {
		case 'motor': return renderMotor(recipe.motor, sampleRate, seed)
		case 'discharge': return renderDischarge(recipe.discharge, sampleRate, seed)
		case 'flame': return renderFlame(recipe.flame, sampleRate, seed)
		default: return renderBlast(recipe.blast, sampleRate, seed)
	}
}

// ---------------------------------------------------------------------------
// The bank
// ---------------------------------------------------------------------------

/**
 * How many damage bands the report bank quantises to, WITHIN A FAMILY.
 *
 * Three, down from eight, and the bank still gained resolution rather than losing it. Eight
 * bands on one curve were eight voices for the whole game; three bands across twelve families
 * are thirty-six, and the axis that separates them is the one the ear actually uses first.
 *
 * Three is also the point where buffers stop buying anything. `audio/index.ts` applies a
 * CONTINUOUS playback-rate correction from the exact damage to its band's centre damage, so
 * scale inside a band is smooth rather than stepped; a fourth band would cost twelve more
 * renders to shrink a correction that is already inside ±3 semitones. Buying resolution with
 * parameterisation instead of memory is the same trade `movementParams` makes when it sends
 * speed to playback rate rather than rendering a loop per speed.
 */
export const REPORT_BANDS = 3

/**
 * Impacts get TWO damage bands where reports get eight, and the asymmetry is deliberate.
 *
 * For a hit, the SURFACE is the dominant perceptual axis — a rifle round and a shell both
 * sound like "metal" or "sand" first and like their own weight second, which is the opposite
 * of a muzzle report where the charge is the whole event. Four bands across 13 surfaces was
 * 52 of the bank's 63 voices and 52 s of its 78 s for a distinction the ear puts second.
 */
export const IMPACT_BANDS = 2
export const DESTRUCTION_BANDS = 3

/** Band index for a damage value. The inverse of `heaviness` at bank resolution. */
export function reportBand(damage: number): number {
	return Math.min(REPORT_BANDS - 1, Math.floor(heaviness(damage) * REPORT_BANDS))
}

export function impactBand(damage: number): number {
	return Math.min(IMPACT_BANDS - 1, Math.floor(heaviness(damage) * IMPACT_BANDS))
}

export function destructionBand(violence: number): number {
	return Math.min(DESTRUCTION_BANDS - 1, Math.floor((Math.min(Math.max(violence, 0), 255) / 255) * DESTRUCTION_BANDS))
}

/** Representative damage at the CENTRE of a band, so a band is not voiced at its own edge. */
export function bandDamage(band: number, bands: number): number {
	const t = (band + 0.5) / bands
	return Math.exp(Math.log(DAMAGE_FLOOR) + t * (Math.log(DAMAGE_CEIL) - Math.log(DAMAGE_FLOOR)))
}

export function bandViolence(band: number, bands: number): number {
	return Math.round(((band + 0.5) / bands) * 255)
}

/**
 * Every voice the game can make, rendered once.
 *
 * Bank layout is fixed at boot and never grows: `reports[family][band]`,
 * `impacts[band][surface]`, `destructions[band]`. Sizes are 12x3, 2x13 and 3 — 66 voices, all
 * rendered before frame 1 (rule 10, the same discipline the meshes follow).
 */
export interface VoiceBank {
	/** `reports[family][band]`. Twelve families by three damage bands — see `familyRecipe`. */
	reports: Voice[][]
	impacts: Voice[][]
	destructions: Voice[]
	/** One seamless engine loop per §8 surface. Indexed by surface, not by band. */
	movement: Voice[]
	/** Infantry gait: discrete footfalls per surface, for the movement-class axis. */
	footsteps: Voice[]
	/** Production-complete bell. Not placed in the world — see `renderBell`. */
	notify: Voice
	sampleRate: number
	totalSamples: number
}

/**
 * Seed derivation. Each voice gets its own stream so adding a band later cannot shift the
 * noise of every voice that follows it — the same reason `Rng.forkNamed` exists.
 */
function voiceSeed(base: number, family: number, a: number, b: number): number {
	let h = (base ^ 0x9e3779b9) >>> 0
	h = Math.imul(h ^ family, 0x85ebca6b) >>> 0
	h = Math.imul(h ^ a, 0xc2b2ae35) >>> 0
	h = Math.imul(h ^ b, 0x27d4eb2f) >>> 0
	return (h ^ (h >>> 15)) | 0
}

export function buildVoiceBank(sampleRate: number, seed: number): VoiceBank {
	const reports: Voice[][] = []
	let totalSamples = 0
	for (let f = 0; f < FAMILY_COUNT; f++) {
		const row: Voice[] = []
		for (let b = 0; b < REPORT_BANDS; b++) {
			// The family gets its own seed axis so adding a thirteenth cannot shift the noise
			// realisation of the twelve that already ship — the same reason bands got theirs.
			const v = renderRecipe(
				familyRecipe(f, bandDamage(b, REPORT_BANDS)),
				sampleRate,
				voiceSeed(seed, 1, f * REPORT_BANDS + b, 0),
			)
			row.push(v)
			totalSamples += v.samples.length
		}
		reports.push(row)
	}

	const impacts: Voice[][] = []
	for (let b = 0; b < IMPACT_BANDS; b++) {
		const row: Voice[] = []
		for (let s = 0; s < SURFACE_VOICING.length; s++) {
			const v = renderBlast(impactParams(bandDamage(b, IMPACT_BANDS), s), sampleRate, voiceSeed(seed, 2, b, s))
			row.push(v)
			totalSamples += v.samples.length
		}
		impacts.push(row)
	}

	const destructions: Voice[] = []
	for (let b = 0; b < DESTRUCTION_BANDS; b++) {
		const v = renderBlast(
			destructionParams(bandViolence(b, DESTRUCTION_BANDS)),
			sampleRate,
			voiceSeed(seed, 3, b, 0),
		)
		destructions.push(v)
		totalSamples += v.samples.length
	}

	const movement: Voice[] = []
	for (let s = 0; s < SURFACE_VOICING.length; s++) {
		const v = renderLoop(movementParams(s), sampleRate, voiceSeed(seed, 4, s, 0))
		movement.push(v)
		totalSamples += v.samples.length
	}

	// Infantry gait loops, one per surface, same seed discipline as the machine loops.
	const footsteps: Voice[] = []
	for (let s = 0; s < SURFACE_VOICING.length; s++) {
		const v = renderLoop(footstepParams(s), sampleRate, voiceSeed(seed, 6, s, 0))
		footsteps.push(v)
		totalSamples += v.samples.length
	}

	const notify = renderBell(NOTIFY_F0, NOTIFY_DURATION_S, sampleRate, voiceSeed(seed, 5, 0, 0))
	totalSamples += notify.samples.length

	return { reports, impacts, destructions, movement, footsteps, notify, sampleRate, totalSamples }
}

// ---------------------------------------------------------------------------
// Measurements. Here rather than in the gate, because a gate that computes its own
// definition of "brightness" is measuring the gate.
// ---------------------------------------------------------------------------

/** RMS over the whole voice. */
export function rms(v: Float32Array): number {
	let s = 0
	for (let i = 0; i < v.length; i++) s += v[i] * v[i]
	return Math.sqrt(s / Math.max(v.length, 1))
}

/** Mean sample value. A voice with DC offset thumps on every start and stacks in the mix. */
export function dcOffset(v: Float32Array): number {
	let s = 0
	for (let i = 0; i < v.length; i++) s += v[i]
	return s / Math.max(v.length, 1)
}

/**
 * Spectral centroid in Hz — "brightness", the one number that most closely tracks what a
 * listener calls the SIZE of a sound.
 *
 * A constant-Q bandpass bank built from the same SVF the voices are, which is a real filter
 * bank rather than a difference of lowpasses. The first version of this function took the
 * first difference of a one-pole lowpass and called it a band; a first difference is a
 * differentiator, so every band reported mostly high-frequency energy and all 63 voices came
 * back within 13% of each other. It is worth stating plainly: THE MEASUREMENT WAS WRONG
 * BEFORE ANY SOUND WAS, and it would have been extremely easy to "fix" the synth until the
 * broken instrument was satisfied.
 *
 * Band energy is divided by centre frequency because constant-Q bands widen as they climb —
 * without that weighting the estimator reports every broadband sound as bright, which is the
 * same bias in a subtler form.
 */
export function spectralCentroid(v: Float32Array, sampleRate: number): number {
	const BANDS = 24
	const F_LO = 40
	const F_HI = Math.min(12000, sampleRate * 0.25)
	const ratio = Math.pow(F_HI / F_LO, 1 / (BANDS - 1))
	// Q = 2. High enough that neighbouring bands do not smear into one another, low enough
	// that the bank stays stable to 0.27*fs.
	const q = 0.5
	const s: Svf = { low: 0, band: 0, high: 0 }
	let num = 0
	let den = 0
	for (let b = 0; b < BANDS; b++) {
		const fc = F_LO * Math.pow(ratio, b)
		const f = svfCoeff(fc, sampleRate, 0.26)
		s.low = 0
		s.band = 0
		s.high = 0
		let e = 0
		for (let i = 0; i < v.length; i++) {
			svfStep(s, v[i], f, q)
			e += s.band * s.band
		}
		const density = e / fc
		num += fc * density
		den += density
	}
	return den > 1e-12 ? num / den : 0
}

// A CONTACT-DENSITY measurement was tried here and REMOVED, which is worth recording because
// the next person will have the same idea. Centroid, level and crest factor are jointly blind
// to how fast a texture's grains arrive, so an estimator counting crossings of the amplitude
// envelope's own mean looked like the missing axis. It does not work: at a 200 Hz envelope
// follower it tracks the carrier rather than the grains, and it reported the metal loop at 181
// contacts per second when that loop's Poisson rate is 64. A measurement whose name is a
// physical quantity and whose value is something else is precisely how this project acquired
// seven instruments that reported green on what they could not see, so it is gone rather than
// documented-as-approximate. Recovering the axis honestly needs a real spectral flux or
// autocorrelation estimator, and that is a bigger piece of work than it is worth today.

/** Seconds until the trailing energy falls below `frac` of the peak envelope. */
export function decayS(v: Float32Array, sampleRate: number, frac: number): number {
	let peak = 0
	for (let i = 0; i < v.length; i++) {
		const a = Math.abs(v[i])
		if (a > peak) peak = a
	}
	const threshold = peak * frac
	for (let i = v.length - 1; i >= 0; i--) {
		if (Math.abs(v[i]) > threshold) return (i + 1) / sampleRate
	}
	return 0
}

/** Six seconds of diffuse rain, with a quarter-second equal-power loop crossfade. */
export function renderRain(sampleRate: number, seed: number): Voice {
	const n = Math.round(sampleRate * 6)
	const fade = Math.round(sampleRate * 0.25)
	const raw = new Float32Array(n + fade)
	const noise = seededNoise(seed)
	const lowK = 1 - Math.exp(-2 * Math.PI * 180 / sampleRate)
	const highK = 1 - Math.exp(-2 * Math.PI * 4800 / sampleRate)
	let low = 0, high = 0, drop = 0
	const dropDecay = Math.exp(-1 / (sampleRate * 0.004))
	for (let i = 0; i < raw.length; i++) {
		const white = noise()
		low += (white - low) * lowK
		high += (white - high) * highK
		if (noise() > 1 - 240 / sampleRate) drop = 0.2 + Math.abs(white) * 0.4
		drop *= dropDecay
		raw[i] = (high - low) * (0.65 + drop)
	}
	const samples = raw.slice(0, n)
	for (let i = 0; i < fade; i++) {
		const angle = i / fade * Math.PI * 0.5
		samples[i] = raw[n + i] * Math.cos(angle) + raw[i] * Math.sin(angle)
	}
	return weatherVoice(samples, sampleRate, 0.55)
}

/** Rolling pressure waves: filtered seeded noise, staggered arrivals, no tonal oscillator. */
export function renderThunder(sampleRate: number, seed: number): Voice {
	const samples = new Float32Array(Math.round(sampleRate * 6))
	const noise = seededNoise(seed)
	const lowK = 1 - Math.exp(-2 * Math.PI * 150 / sampleRate)
	const highK = 1 - Math.exp(-2 * Math.PI * 1300 / sampleRate)
	let low = 0, high = 0, dc = 0
	const dcK = 1 - Math.exp(-2 * Math.PI * 15 / sampleRate)
	const rolls = [0, 0.4 + Math.abs(noise()) * 0.3, 1.2 + Math.abs(noise()) * 0.4, 2.2 + Math.abs(noise()) * 0.5]
	for (let i = 0; i < samples.length; i++) {
		const t = i / sampleRate
		const white = noise()
		low += (white - low) * lowK
		high += (white - high) * highK
		let envelope = 0
		for (let j = 0; j < rolls.length; j++) {
			const age = t - rolls[j]
			if (age >= 0) envelope += (1 - Math.exp(-age / 0.035)) * Math.exp(-age / (0.7 + j * 0.18)) / (1 + j * 0.6)
		}
		const pressure = (low * 3 + high * 0.25 * Math.exp(-t / 0.2)) * envelope
		dc += (pressure - dc) * dcK
		samples[i] = (pressure - dc) * Math.min(1, t / 0.015, (samples.length - 1 - i) / (sampleRate * 0.35))
	}
	return weatherVoice(samples, sampleRate, 0.72)
}

function weatherVoice(samples: Float32Array, sampleRate: number, targetPeak: number): Voice {
	let peak = 0, peakIndex = 0
	for (let i = 0; i < samples.length; i++) {
		if (Math.abs(samples[i]) > peak) { peak = Math.abs(samples[i]); peakIndex = i }
	}
	const gain = peak > 0 ? targetPeak / peak : 0
	for (let i = 0; i < samples.length; i++) samples[i] *= gain
	return { samples, sampleRate, peak: targetPeak, attackS: peakIndex / sampleRate }
}
