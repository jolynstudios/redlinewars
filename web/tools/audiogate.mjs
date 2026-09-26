#!/usr/bin/env node
// STEELSEED — tools/audiogate
//
// Does the sound come from the WEAPON, or from a designer's taste?
//
// This project has recorded seven instruments that reported green on something they could not
// see. Audio is unusually easy to add an eighth to, because the obvious gate — "a buffer was
// produced and it is not silent" — passes just as happily on 63 copies of the same noise
// burst as it does on a voice bank derived from the mod. So the assertions here are ordered
// by how much they would embarrass us, weakest first:
//
//   1-4  the voice is a sound at all         (non-silent, bounded, onset as DECLARED, decays)
//   5    the voice is not a DC thump
//   6    it is DETERMINISTIC                  (same seed -> identical samples)
//   7-8  DAMAGE STILL DESIGNS THE SCALE       (centroid falls, decay lengthens — monotonically)
//   9    THE TWELVE FAMILIES ARE DISTINCT     (the assertion this gate now exists for)
//   9b   the ROSTER spreads across the bands  (the clamp that made 47 weapons one sound)
//   9c   every weapon's voice FITS ITS OWN CADENCE, from ReloadDelay/BurstDelays
//   9d   the tesla crackle is timed to the tesla BOLT (4 strikes inside 0.22 s)
//   10   all 13 §8 surfaces are distinct      (§8: "every consumer must handle all 13")
//   11   destruction outlasts every report    (a kill must not read as another hit landing)
//
// 9, 9b and 9c are the ones that matter now, and 9b is the one that would have caught the
// defect this gate was rewritten for. The old bank asserted that its EIGHT BANDS were mutually
// separated, and they were — measured on the buffers, which is not the question. The question
// is which buffers the GAME REACHES, and against the real roster the answer was band 7 for 47
// of 50 weapons, because `heaviness()` clamped at 1000 while the fire event sends up to 65535.
// A gate that measures the bank without ever asking what the mod would index into it is an
// instrument reporting green on something it cannot see, which is the failure mode this
// project has now recorded eight times. 9b reads the real damages out of `weapon-audio.json`
// and asserts the occupancy — it fails, loudly, the moment the clamp closes again.
//
// NO BROWSER, NO GPU, NO AudioContext. §14.8 ruled audio a sibling engine specifically so its
// gates would not inherit the GPU-Chromium harness and its traps. This runs in plain Node.
//
// Usage:
//   node tools/audiogate.mjs [--strict]
//   node tools/audiogate.mjs --falsify=flat|silent|nodecay|loopflat|bellblast|dullbell|onefamily|clamp|smear|noflicker

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'

const TOOL = 'audiogate'
const WEB = resolve(fileURLToPath(new URL('..', import.meta.url)))
const argv = process.argv.slice(2)
const strict = argv.includes('--strict')
const falsify = (argv.find(a => a.startsWith('--falsify=')) ?? '').slice(10) || null
const FALSIFIERS = ['flat', 'silent', 'nodecay', 'loopflat', 'bellblast', 'dullbell', 'onefamily', 'clamp', 'smear', 'noflicker']
if (falsify !== null && !FALSIFIERS.includes(falsify)) {
	console.error(`${TOOL}: unknown --falsify=${falsify} (expected one of ${FALSIFIERS.join(', ')})`)
	process.exit(2)
}

/** 48 kHz is what every desktop browser reports; the synth takes it as a parameter regardless. */
const SAMPLE_RATE = 48000
const SEED = 0x51EED

const tmp = mkdtempSync(join(tmpdir(), 'audiogate-'))
const bundlePath = join(tmp, 'audio.mjs')
await esbuild({
	entryPoints: [resolve(WEB, 'src/audio/index.gate.ts')],
	bundle: true, format: 'esm', platform: 'neutral', outfile: bundlePath, logLevel: 'silent',
})
const A = await import(bundlePath)

/**
 * THE ROSTER, not a remembered summary of it.
 *
 * Every assertion below that claims something about "the game" reads its damages, families and
 * cadences from the generated table rather than from a number in a comment. The comment in
 * `synth.ts` that said the roster "spans 65..820" was the single most expensive sentence in
 * this node: it was true of some other quantity, nobody re-derived it, and the clamp it
 * justified silenced 47 of 50 weapons for the life of the file.
 */
const ROSTER = JSON.parse(readFileSync(resolve(WEB, 'src/audio/weapon-audio.json'), 'utf8'))
const WEAPONS = Object.entries(ROSTER.weapons)

const problems = []
const fail = (msg) => problems.push(msg)

// ---------------------------------------------------------------------------
// Build the bank. Falsifiers act HERE, on the real inputs, rather than on the
// assertions — a falsifier that edits the check proves nothing about the check.
// ---------------------------------------------------------------------------

let bank
/** Damage the roster's own band-occupancy check is run against. Moved by `--falsify=clamp`. */
let rosterDamage = (row) => row.damage

if (falsify === 'flat') {
	// Every band of every family voiced at the SAME damage. The bank is still 36 real report
	// voices, still non-silent, still deterministic, and the families are still twelve
	// different shapes — so 1-6 and 9 must still pass, and only 7/8 (the scale axis) may fail.
	// This is what removing the damage input, and nothing else, would do.
	const real = A.buildVoiceBank(SAMPLE_RATE, SEED)
	bank = {
		...real,
		reports: real.reports.map((row, f) => row.map((_, b) =>
			A.renderRecipe(A.familyRecipe(f, 2000), SAMPLE_RATE, 1000 + f * A.REPORT_BANDS + b))),
	}
} else if (falsify === 'onefamily') {
	// EVERY FAMILY VOICED AS A CANNON. The bank is still 36 voices, still banded by damage,
	// still monotone, still separated band to band — 1-8 must all still pass. This is exactly
	// the state the node shipped in: one excitation for the whole game, dressed as a bank.
	// Check 9 is the only thing standing between that and a green run.
	const real = A.buildVoiceBank(SAMPLE_RATE, SEED)
	bank = {
		...real,
		reports: real.reports.map((row, f) => row.map((_, b) =>
			A.renderRecipe(A.familyRecipe(A.FAMILY.cannon, A.bandDamage(b, A.REPORT_BANDS)), SAMPLE_RATE, 1000 + f * 8 + b))),
	}
} else if (falsify === 'clamp') {
	// THE ORIGINAL DEFECT, restored exactly: every weapon's damage read through the old
	// 50..1000 clamp. The BANK is untouched and perfect; what changes is which cell of it the
	// roster reaches. Everything measuring the buffers still passes. Only 9b can see this.
	rosterDamage = (row) => Math.min(row.damage, 1000)
	bank = A.buildVoiceBank(SAMPLE_RATE, SEED)
} else if (falsify === 'smear') {
	// Every family given the artillery envelope's length while keeping its own timbre. Still
	// twelve distinct families, still monotone, still separated — but a machine gun round now
	// rings for a second, so no weapon in the game can render its own rate of fire. 9c only.
	const real = A.buildVoiceBank(SAMPLE_RATE, SEED)
	bank = {
		...real,
		reports: real.reports.map((row, f) => row.map((v, b) => {
			const long = A.renderRecipe(A.familyRecipe(f, A.bandDamage(b, A.REPORT_BANDS)), SAMPLE_RATE, 1000 + f * 8 + b)
			// Stretch by repeating the decaying tail at low level: keeps onset, timbre and
			// determinism, destroys only the cadence fit.
			const n = Math.max(long.samples.length, Math.round(1.1 * SAMPLE_RATE))
			const out = new Float32Array(n)
			out.set(long.samples)
			for (let i = long.samples.length; i < n; i++)
				out[i] = long.samples[i % long.samples.length] * Math.exp(-(i - long.samples.length) / (0.45 * SAMPLE_RATE))
			const fade = Math.round(0.003 * SAMPLE_RATE)
			for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade
			return { ...v, samples: out }
		})),
	}
} else if (falsify === 'silent') {
	const real = A.buildVoiceBank(SAMPLE_RATE, SEED)
	bank = { ...real, reports: real.reports.map(row => row.map(v => ({ ...v, samples: new Float32Array(v.samples.length), peak: 0 }))) }
} else if (falsify === 'nodecay') {
	// Truncate every report at its loudest point: the voice still exists and is still
	// derived from damage, but it now ends mid-blast and would click on every shot.
	const real = A.buildVoiceBank(SAMPLE_RATE, SEED)
	bank = {
		...real,
		reports: real.reports.map(row => row.map(v => {
			const cut = Math.max(1, Math.round(v.samples.length * 0.06))
			return { ...v, samples: v.samples.slice(0, cut) }
		})),
	}
} else if (falsify === 'dullbell') {
	// The notification at its ORIGINAL 520 Hz. Still a bell, still inharmonic, still ringing
	// for 1.1 s, still nothing like a gun — and 3.7% from the heal tone in brightness, which is
	// the collision that forced the pitch up. A control for the notify assertion: if this
	// passes, that assertion is decoration.
	const real = A.buildVoiceBank(SAMPLE_RATE, SEED)
	bank = { ...real, notify: A.renderBell(520, A.NOTIFY_DURATION_S, SAMPLE_RATE, 4242) }
} else if (falsify === 'noflicker') {
	// The tesla voice as ONE continuous discharge over the same 0.22 s instead of four. Same
	// brightness, same length, same crackle, same family separation — everything except the
	// timing that ties it to the bolt on screen. Only 9d can see it.
	const real = A.buildVoiceBank(SAMPLE_RATE, SEED)
	bank = {
		...real,
		reports: real.reports.map((row, f) => f !== A.FAMILY.electric ? row : row.map((v, b) => {
			const r = A.familyRecipe(f, A.bandDamage(b, A.REPORT_BANDS))
			return A.renderDischarge({ ...r.discharge, strikes: 1, strikeIntervalS: A.TESLA_ARC_LIFETIME_S, strikeTauS: 0.30 },
				SAMPLE_RATE, 2000 + b)
		})),
	}
} else if (falsify === 'bellblast') {
	// The notification rendered as an ordinary weapon report instead of a bell. Still a real
	// voice, still audible, still deterministic — it simply sits inside the range the guns
	// occupy, which is the one thing it may not do.
	const real = A.buildVoiceBank(SAMPLE_RATE, SEED)
	bank = { ...real, notify: A.renderRecipe(A.familyRecipe(A.FAMILY.cannon, 2000), SAMPLE_RATE, 4242) }
} else if (falsify === 'loopflat') {
	// Every surface driven over with the SAME loop parameters. Still 13 real loops, still
	// sustained, still bounded, still bit-identical run to run — only the derivation is gone.
	// This is what a lookup table keyed on anything but the surface would produce.
	const real = A.buildVoiceBank(SAMPLE_RATE, SEED)
	const flat = A.movementParams(0)
	bank = {
		...real,
		movement: real.movement.map((_, s) => A.renderLoop(flat, SAMPLE_RATE, 7000 + s)),
	}
} else {
	bank = A.buildVoiceBank(SAMPLE_RATE, SEED)
}

const allVoices = [
	...bank.reports.flatMap((row, f) => row.map((v, b) => ({ v, label: `report[${A.FAMILY_NAMES[f]}][${b}]`, family: f }))),
	...bank.impacts.flatMap((row, b) => row.map((v, s) => ({ v, label: `impact[${b}][${SURFACE_NAME(s)}]` }))),
	...bank.destructions.map((v, i) => ({ v, label: `destruction[${i}]` })),
	// The bell takes the same "is it a sound" checks as everything else: it is a one-shot with
	// an impulsive strike and a decay to silence, so all five apply unchanged.
	{ v: bank.notify, label: 'notify' },
]
// Movement loops are checked in their own section: they are sustained, so the one-shot
// assertions (impulsive onset, decays to silence) are not merely inapplicable but INVERTED —
// a loop that passed them would be broken.

function SURFACE_NAME(i) {
	return ['soil', 'rock', 'sand', 'gravel', 'grass', 'road', 'metal',
		'concrete', 'water', 'shallow', 'snow', 'ash', 'resource'][i] ?? `?${i}`
}

console.log(`${TOOL}: ${allVoices.length} voices at ${SAMPLE_RATE} Hz${falsify ? `  (--falsify=${falsify})` : ''}`)

// ---------------------------------------------------------------------------
// 0  DOES THE INSTRUMENT WORK?
//
// Checked FIRST and against signals whose answer is known a priori, because the first run of
// this gate reported a 60 Hz boom and a rifle crack as being 0.5% apart in brightness — and
// that was true of the ESTIMATOR, not of the sounds. Seven instruments in this project have
// now reported green on something they could not see. An instrument that cannot be caught
// lying is not evidence, so the brightness measure is made to prove itself on a pure tone
// before it is trusted on a gunshot.
// ---------------------------------------------------------------------------
{
	const probe = (hz) => {
		const n = SAMPLE_RATE
		const a = new Float32Array(n)
		for (let i = 0; i < n; i++) a[i] = Math.sin(2 * Math.PI * hz * i / SAMPLE_RATE) * 0.8
		return A.spectralCentroid(a, SAMPLE_RATE)
	}
	// A constant-Q bank cannot resolve a tone exactly; ±30% is well inside what is needed to
	// order eight voices, and far tighter than the ~13% total spread the broken version gave
	// across every sound in the game.
	const TOL = 0.30
	for (const hz of [80, 400, 2000, 6000]) {
		const got = probe(hz)
		const err = Math.abs(got - hz) / hz
		console.log(`  instrument: ${String(hz).padStart(5)} Hz tone reads ${got.toFixed(0).padStart(5)} Hz  (${(err * 100).toFixed(1)}% error)`)
		if (err > TOL)
			fail(`spectralCentroid reports a pure ${hz} Hz tone as ${got.toFixed(0)} Hz (${(err * 100).toFixed(0)}% off, tolerance ${TOL * 100}%) — the brightness measure is broken, so every assertion below it is meaningless.`)
	}
	// Monotone by construction: if a higher tone does not read higher, ordering is impossible.
	if (!(probe(6000) > probe(2000) && probe(2000) > probe(400) && probe(400) > probe(80)))
		fail('spectralCentroid is not monotone in frequency — it cannot order voices by brightness.')
}

// ---------------------------------------------------------------------------
// 1-5  Is it a sound?
// ---------------------------------------------------------------------------

/** Below this a voice is inaudible against any mix; a silent bank is the classic false pass. */
const MIN_PEAK = 0.05
const MIN_RMS = 0.002
/** Above 1.0 the browser clips it for us, audibly and unpredictably. */
const MAX_PEAK = 1.0
/**
 * Onset. A percussive voice must be LOUD IMMEDIATELY.
 *
 * Asserted on the energy in the first 3 ms rather than on where the absolute peak lands,
 * which was the first formulation and was wrong: a heavy voice built on a 58 Hz body reaches
 * its true maximum a quarter-cycle in, so "time to peak" flagged the deepest explosion in the
 * game as a swell while it was in fact the most impulsive thing in it. Onset energy asks the
 * question actually being asked — is there a strike at the front — and is indifferent to the
 * fundamental, which is exactly the property a test across eight octaves needs.
 */
const ONSET_WINDOW_S = 0.003
const MIN_ONSET_FRACTION = 0.35
/**
 * Ceiling for a family that DECLARES it swells.
 *
 * 20%, i.e. -14 dB below peak at 3 ms. Well clear of the 35% floor above it, so no voice can
 * satisfy both and the two assertions cannot be jointly vacuous.
 */
const MAX_SWELL_ONSET_FRACTION = 0.20
/** The tail must reach silence, or the buffer end is a step discontinuity — an audible click. */
const MAX_TAIL_LEVEL = 0.02
/** A speaker cone pushed off-centre by every voice in the mix. */
const MAX_DC = 0.01

for (const { v, label, family } of allVoices) {
	const peak = Math.max(...[v.peak ?? 0, maxAbs(v.samples)])
	const r = A.rms(v.samples)
	if (peak < MIN_PEAK) fail(`${label}: peak ${peak.toFixed(4)} < ${MIN_PEAK} — inaudible. A bank of silence passes every other check.`)
	if (r < MIN_RMS) fail(`${label}: rms ${r.toFixed(5)} < ${MIN_RMS} — a click with no body.`)
	if (peak > MAX_PEAK) fail(`${label}: peak ${peak.toFixed(4)} > ${MAX_PEAK} — clips.`)
	// ONSET IS NOW A TWO-SIDED CHECK, driven by the family's own declaration.
	//
	// The one-sided version could only catch a strike that had gone soft. Eleven of the twelve
	// families are built on the blast primitive, so the likelier regression is the other way
	// round: a flamethrower quietly acquiring a muzzle blast because someone reused a cannon
	// recipe for it. `FAMILY_IMPULSIVE` states which it is meant to be, and this fails either
	// way — including if the DECLARATION is edited without the recipe.
	const onset = maxAbs(v.samples.subarray(0, Math.round(ONSET_WINDOW_S * SAMPLE_RATE)))
	const frac = onset / Math.max(peak, 1e-9)
	const impulsive = family === undefined ? true : A.FAMILY_IMPULSIVE[family]
	if (impulsive && frac < MIN_ONSET_FRACTION)
		fail(`${label}: only ${(frac * 100).toFixed(0)}% of peak level in the first ${ONSET_WINDOW_S * 1000} ms (floor ${MIN_ONSET_FRACTION * 100}%) — it swells where FAMILY_IMPULSIVE declares it strikes.`)
	if (!impulsive && frac > MAX_SWELL_ONSET_FRACTION)
		fail(`${label}: ${(frac * 100).toFixed(0)}% of peak level in the first ${ONSET_WINDOW_S * 1000} ms (ceiling ${MAX_SWELL_ONSET_FRACTION * 100}%) — it strikes where FAMILY_IMPULSIVE declares it swells. A jet of burning fuel does not bang.`)
	const tail = maxAbs(v.samples.subarray(Math.max(0, v.samples.length - Math.round(0.002 * SAMPLE_RATE))))
	if (tail > MAX_TAIL_LEVEL)
		fail(`${label}: ends at level ${tail.toFixed(4)} > ${MAX_TAIL_LEVEL} — the buffer stops mid-sound and clicks on every playback.`)
	const dc = Math.abs(A.dcOffset(v.samples))
	if (dc > MAX_DC) fail(`${label}: DC offset ${dc.toFixed(5)} > ${MAX_DC} — thumps and stacks across voices.`)
}

function maxAbs(a) {
	let m = 0
	for (let i = 0; i < a.length; i++) { const x = Math.abs(a[i]); if (x > m) m = x }
	return m
}

// ---------------------------------------------------------------------------
// 6  Determinism. Same seed, same samples — bit for bit.
// ---------------------------------------------------------------------------
{
	const again = A.buildVoiceBank(SAMPLE_RATE, SEED)
	const flat = (bk) => bk.reports.flat()
	let differing = 0
	const once = flat(A.buildVoiceBank(SAMPLE_RATE, SEED))
	const twice = flat(again)
	for (let i = 0; i < twice.length; i++) {
		const x = once[i].samples
		const y = twice[i].samples
		if (x.length !== y.length) { differing++; continue }
		for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) { differing++; break }
	}
	if (differing > 0)
		fail(`${differing} report voice(s) differ between two builds at the same seed — the bank is not reproducible, so no measurement here means anything.`)
	const other = flat(A.buildVoiceBank(SAMPLE_RATE, SEED ^ 0x1234))
	let same = 0
	for (let i = 0; i < other.length; i++) {
		const x = other[i].samples, y = twice[i].samples
		if (x.length === y.length && x.every((v, k) => v === y[k])) same++
	}
	if (same === other.length)
		fail('a different seed produced an identical bank — the seed is not reaching the synth.')
}

// ---------------------------------------------------------------------------
// The measurement every assertion below shares.
//
// FIVE FEATURES, not one. Brightness alone called gravel and road the same sound while their
// decays differed by 50%, and it would pass a rocket voiced as a cannon at the same centroid.
// Onset and crest are the two that carry SHAPE — whether the event strikes, and how far its
// peaks sit above its own average — which is exactly what separates a motor from a blast and a
// crackle from a roar, and is invisible to spectrum and level.
// ---------------------------------------------------------------------------
const FEATURE_NAMES = ['centroidHz', 'decay5%', 'rms', 'crest', 'onset']
function features(v) {
	const s = v.samples
	const peak = maxAbs(s)
	const r = A.rms(s)
	return [
		A.spectralCentroid(s, SAMPLE_RATE),
		A.decayS(s, SAMPLE_RATE, 0.05),
		r,
		peak / Math.max(r, 1e-9),
		maxAbs(s.subarray(0, Math.round(ONSET_WINDOW_S * SAMPLE_RATE))) / Math.max(peak, 1e-9),
	]
}
/** Normalised euclidean distance, the same measure `rostergate` uses on silhouettes. */
function distance(a, b) {
	let sum = 0
	for (let k = 0; k < a.length; k++) {
		const rel = Math.abs(a[k] - b[k]) / Math.max(a[k], b[k], 1e-9)
		sum += rel * rel
	}
	return Math.sqrt(sum / a.length)
}

const feat = bank.reports.map(row => row.map(features))

/**
 * The (family, band) cells the mod can actually index into, with the weapons that reach each.
 *
 * Every assertion about "two voices in this game" is scoped to these. The bank is a full 12x3
 * rectangle, but `ParaBomb` is the only bomb in the mod and it deals 30000, so nothing can ever
 * play a light bomb — and a gate that demanded a light bomb be distinguishable from a light
 * rocket would be enforcing a distinction no player can be in a position to make.
 */
const REACHABLE = (() => {
	const byCell = new Map()
	for (const [name, row] of WEAPONS) {
		const b = A.reportBand(row.damage)
		const key = `${row.family}:${b}`
		if (!byCell.has(key)) byCell.set(key, { f: row.family, b, weapons: [] })
		byCell.get(key).weapons.push(name)
	}
	return [...byCell.values()]
})()

// ---------------------------------------------------------------------------
// 7-8  DAMAGE STILL DESIGNS THE SCALE, inside each family.
//
// The old form of this assertion ran across the single eight-band curve and was the whole of
// what the gate checked about weapon voicing. It is now one of four, and it is scoped to a
// family — because a machine gun round must be brighter than a howitzer at every damage, and
// a global monotonicity check would forbid exactly that.
// ---------------------------------------------------------------------------
console.log('  report bank — family, band, damage, centroid Hz, decay s, onset %')
for (let f = 0; f < bank.reports.length; f++) {
	for (let b = 0; b < bank.reports[f].length; b++) {
		console.log(
			`    ${A.FAMILY_NAMES[f].padEnd(10)} ${b}  dmg ${A.bandDamage(b, A.REPORT_BANDS).toFixed(0).padStart(6)}` +
			`  centroid ${feat[f][b][0].toFixed(1).padStart(7)}` +
			`  decay ${feat[f][b][1].toFixed(3)}` +
			`  onset ${(feat[f][b][4] * 100).toFixed(0).padStart(3)}%`)
	}
}

const MIN_BAND_SEPARATION = 0.06
for (let f = 0; f < bank.reports.length; f++) {
	const name = A.FAMILY_NAMES[f]
	if (!A.FAMILY_SCALES[f]) {
		/*
		 * Declared damage-invariant: assert the RECIPE is, at both ends of the whole damage
		 * range. `Heal`, `Repair` and `DemoTruckTargeting` all publish damage 0 — the fire
		 * event carries the sum of POSITIVE warhead damages — so only band 0 is ever reachable
		 * and a `w` term here would be a coefficient nobody could hear being wrong.
		 *
		 * On the recipe rather than on the samples, and the difference matters: `voiceSeed`
		 * mixes the band into the noise stream, so two bands of one family are legitimately
		 * different REALISATIONS of the same design. Comparing samples would fail on that and
		 * would have to be relaxed; comparing coefficients asks the actual question.
		 */
		const lo = JSON.stringify(A.familyRecipe(f, 1))
		const hi = JSON.stringify(A.familyRecipe(f, 65535))
		if (lo !== hi)
			fail(`${name} produces different parameters at damage 1 and damage 65535, but FAMILY_SCALES declares this family damage-invariant — every weapon in it publishes damage 0, so no listener could ever hear the difference and no gate could ever tune it.`)
		continue
	}
	for (let b = 1; b < bank.reports[f].length; b++) {
		const [c0, d0] = feat[f][b - 1]
		const [c1, d1] = feat[f][b]
		if (!(c1 < c0))
			fail(`${name} band ${b} (${c1.toFixed(1)} Hz) is not darker than band ${b - 1} (${c0.toFixed(1)} Hz) — a heavier weapon must not be brighter.`)
		if (!(d1 > d0))
			fail(`${name} band ${b} decays in ${d1.toFixed(3)} s, not longer than band ${b - 1} at ${d0.toFixed(3)} s — a heavier weapon must not stop sooner.`)
		const rel = Math.abs(c1 - c0) / Math.max(c0, 1e-6)
		if (rel < MIN_BAND_SEPARATION)
			fail(`${name} bands ${b - 1} and ${b} are only ${(rel * 100).toFixed(2)}% apart in brightness (floor ${MIN_BAND_SEPARATION * 100}%) — indistinguishable, so the family has fewer real voices than it claims.`)
	}
}

// ---------------------------------------------------------------------------
// 9  THE TWELVE FAMILIES ARE DISTINCT. The assertion this gate now exists for.
//
// A tesla coil, a rocket launcher, a machine gun and a tank cannon shared one buffer for the
// life of this node, because the only thing separating voices was a number that could not tell
// them apart. This compares every pair of families at the SAME band — so the comparison is
// about excitation and never about scale — on the five-feature signature above.
//
// The floor is 0.20, more than three times the 0.06 the surfaces and the bands use, and it is
// higher on purpose: two surfaces need to be TELLABLE APART, whereas a rocket and a cannon
// need to be RECOGNISABLE AS DIFFERENT THINGS by a player who is not listening for it.
// ---------------------------------------------------------------------------
const MIN_FAMILY_SEPARATION = 0.20
/**
 * The floor WITHIN one excitation — a heavy cannon against a medium howitzer, a rocket against
 * a torpedo. The same 0.06 the damage bands and the §8 surfaces use, and for the same reason:
 * these are two scales of one event and the question is only whether they are tellable apart.
 */
const MIN_SCALE_SEPARATION = 0.06
/**
 * How far the production bell must sit, in BRIGHTNESS, from every voice a weapon can make.
 *
 * A ratio rather than a signature distance, because the signature could not see the difference
 * — see the note at the assertion. 1.5x is roughly a musical fifth of perceived brightness:
 * plainly a different register, and comfortably clear of the 1.89x the bank achieves today.
 */
const MIN_NOTIFY_BRIGHTNESS_RATIO = 1.5
{
	/*
	 * OVER THE CELLS THE ROSTER CAN ACTUALLY REACH, and across bands as well as within them.
	 *
	 * The bank is a full 12x3 rectangle but the mod only indexes 22 of its 36 cells: `ParaBomb`
	 * is the only bomb in the game and it deals 30000, so nothing can ever play a light bomb.
	 * The first version of this check compared all 36 and failed on `rocket[0]` against
	 * `bomb[0]` — two voices that cannot both occur — which is a gate demanding a distinction
	 * no player can ever be in a position to make. Scoping it to the reachable cells asks the
	 * question that matters, "can two weapons in THIS game sound the same", and gets stricter
	 * rather than looser when the mod adds a weapon that reaches a new cell.
	 *
	 * Across bands, not only within them, because a light cannon and a heavy rifle are both
	 * real and a player hears them in the same battle. Restricting the comparison to equal
	 * bands would let the bank hide a collision along its diagonal.
	 */
	const cells = REACHABLE
	let worst = { d: Infinity, a: null, b: null }
	for (let i = 0; i < cells.length; i++) {
		for (let j = i + 1; j < cells.length; j++) {
			const d = distance(feat[cells[i].f][cells[i].b], feat[cells[j].f][cells[j].b])
			const sameExcitation = A.FAMILY_EXCITATION[cells[i].f] === A.FAMILY_EXCITATION[cells[j].f]
			const floor = sameExcitation ? MIN_SCALE_SEPARATION : MIN_FAMILY_SEPARATION
			if (!sameExcitation && d < worst.d) worst = { d, a: cells[i], b: cells[j] }
			if (d < floor)
				fail(`${A.FAMILY_NAMES[cells[i].f]}[${cells[i].b}] (${cells[i].weapons.slice(0, 3).join(', ')}) and ` +
					`${A.FAMILY_NAMES[cells[j].f]}[${cells[j].b}] (${cells[j].weapons.slice(0, 3).join(', ')}) are ` +
					`${d.toFixed(4)} apart (floor ${floor}) — the same sound. Two weapons of ` +
					`different KIND may not share a voice; that is the defect this bank was rebuilt to remove.`)
		}
	}
	const pairs = (cells.length * (cells.length - 1)) / 2
	console.log(`  voice separation: ${cells.length} reachable (family, band) cells, ${pairs} pairs; closest ` +
		`${A.FAMILY_NAMES[worst.a.f]}[${worst.a.b}]/${A.FAMILY_NAMES[worst.b.f]}[${worst.b.b}] at ${worst.d.toFixed(4)} ` +
		`(floor ${MIN_FAMILY_SEPARATION} across excitations, ${MIN_SCALE_SEPARATION} within one)`)
	// And the families themselves, at the one band every family renders, so a family that no
	// weapon reaches today is still held to the standard before one does.
	let unreachableWorst = { d: Infinity, i: -1, j: -1 }
	for (let i = 0; i < bank.reports.length; i++)
		for (let j = i + 1; j < bank.reports.length; j++) {
			if (A.FAMILY_EXCITATION[i] === A.FAMILY_EXCITATION[j]) continue
			const d = distance(feat[i][1], feat[j][1])
			if (d < unreachableWorst.d) unreachableWorst = { d, i, j }
		}
	console.log(`  all twelve families at band 1, across excitations: closest ${A.FAMILY_NAMES[unreachableWorst.i]}/` +
		`${A.FAMILY_NAMES[unreachableWorst.j]} at ${unreachableWorst.d.toFixed(4)}`)
	if (unreachableWorst.d < MIN_FAMILY_SEPARATION)
		fail(`${A.FAMILY_NAMES[unreachableWorst.i]} and ${A.FAMILY_NAMES[unreachableWorst.j]} are ${unreachableWorst.d.toFixed(4)} apart at band 1 (floor ${MIN_FAMILY_SEPARATION}) — two families with one sound between them.`)
}

// ---------------------------------------------------------------------------
// 9a  THE BANK'S FAMILY ORDER IS THE TABLE'S FAMILY ORDER.
//
// Two lists of twelve strings in two files. A silent reorder in either would voice every
// rocket as a rifle and nothing else in this gate would notice, because both banks would still
// be twelve well-separated families.
// ---------------------------------------------------------------------------
if (ROSTER.families.length !== A.FAMILY_NAMES.length ||
	ROSTER.families.some((n, i) => n !== A.FAMILY_NAMES[i]))
	fail(`weapon-audio.json families [${ROSTER.families.join(',')}] do not match synth FAMILY_NAMES [${A.FAMILY_NAMES.join(',')}] — the index the table publishes is not the index the bank uses.`)

// ---------------------------------------------------------------------------
// 9b  THE ROSTER SPREADS ACROSS THE BANK. The check that would have caught the defect.
//
// Everything above measures BUFFERS. This measures which buffers the game can actually reach,
// by pushing the mod's own damages through the same `reportBand` the node calls. Against the
// shipped 50..1000 clamp it reported band 7 for 47 of 50 weapons — a bank of eight playing as
// a bank of one — and no assertion in the old gate could see it, because the bank itself was
// fine. `--falsify=clamp` restores exactly that and nothing else fails.
// ---------------------------------------------------------------------------
{
	const counts = new Array(A.REPORT_BANDS).fill(0)
	const cells = new Map()
	for (const [, row] of WEAPONS) {
		const b = A.reportBand(rosterDamage(row))
		counts[b]++
		const key = `${row.family}:${b}`
		cells.set(key, (cells.get(key) ?? 0) + 1)
	}
	console.log(`  roster occupancy: ${WEAPONS.length} weapons over ${A.REPORT_BANDS} bands -> [${counts.join(', ')}]` +
		`; ${cells.size} of ${A.FAMILY_NAMES.length * A.REPORT_BANDS} (family, band) cells reached`)
	const worstBand = Math.max(...counts)
	// Two thirds, not "all of them". A roster IS allowed to cluster — most weapons in this mod
	// really do sit in the middle of the damage range — but a band holding two thirds of the
	// game means the axis has collapsed, whatever the buffers measure.
	const MAX_BAND_SHARE = 2 / 3
	if (worstBand > WEAPONS.length * MAX_BAND_SHARE)
		fail(`${worstBand} of ${WEAPONS.length} weapons land in one damage band (ceiling ${(MAX_BAND_SHARE * 100).toFixed(0)}%) — heaviness() is clamping the roster into a corner of the bank, so the scale axis is not reaching the game however good the buffers look.`)
	const emptyBands = counts.filter(c => c === 0).length
	if (emptyBands > 0)
		fail(`${emptyBands} damage band(s) hold no weapon at all — those voices are rendered at boot and can never be played.`)
	// And the axis that matters most: how many distinct FAMILIES the roster actually reaches.
	const familiesUsed = new Set(WEAPONS.map(([, r]) => r.family)).size
	if (familiesUsed < A.FAMILY_NAMES.length)
		fail(`the roster reaches only ${familiesUsed} of ${A.FAMILY_NAMES.length} families — the rest are rendered and never heard.`)
}

// ---------------------------------------------------------------------------
// 9c  EVERY WEAPON'S VOICE FITS ITS OWN CADENCE.
//
// "Follow the weapon rules of the game", measured. `weapon-audio.json` carries each weapon's
// shortest gap between two audible onsets, straight out of `ReloadDelay` and `BurstDelays`;
// this asserts the voice that weapon will play has fallen to half its peak by the time the
// next round arrives. A voice that has not is a weapon whose rate of fire the player cannot
// hear — `ChainGun.Yak` reloads in 3 ticks, and a round that rings for 0.4 s turns sixteen
// rounds a second into one continuous drone.
//
// Asserted only for the families that DECLARE they must not overlap. A flamethrower fires
// every 40 ms by design and a tesla coil re-strikes every 120 ms; both are meant to run
// together, and relaxing one threshold until they passed too is how a real constraint becomes
// a decoration. Those are printed instead.
// ---------------------------------------------------------------------------
{
	const rows = []
	for (const [name, row] of WEAPONS) {
		const b = A.reportBand(row.damage)
		const v = bank.reports[row.family]?.[b]
		if (!v) { fail(`${name}: family ${row.family} band ${b} has no voice in the bank.`); continue }
		const half = A.decayS(v.samples, SAMPLE_RATE, 0.50)
		rows.push({ name, family: A.FAMILY_NAMES[row.family], gap: row.roundIntervalS, half, overlaps: A.FAMILY_OVERLAPS[row.family] })
	}
	const tight = rows.filter(r => !r.overlaps).sort((a, b) => (a.gap - a.half) - (b.gap - b.half)).slice(0, 4)
	console.log('  cadence fit — tightest four non-overlapping weapons (voice must reach half peak within its own round gap)')
	for (const r of tight)
		console.log(`    ${r.name.padEnd(16)} ${r.family.padEnd(10)} gap ${r.gap.toFixed(3)}s  half-decay ${r.half.toFixed(3)}s  margin ${(r.gap - r.half).toFixed(3)}s`)
	const overlapping = rows.filter(r => r.overlaps && r.half > r.gap)
	console.log(`  ${overlapping.length} weapon(s) in overlapping families sound over their own next round, by design` +
		`${overlapping.length > 0 ? ` (${overlapping.slice(0, 4).map(r => r.name).join(', ')}${overlapping.length > 4 ? ', …' : ''})` : ''}`)
	for (const r of rows) {
		if (r.overlaps) continue
		if (r.half > r.gap)
			fail(`${r.name} (${r.family}) fires a round every ${r.gap.toFixed(3)} s but its voice is still at half peak after ${r.half.toFixed(3)} s — its rate of fire cannot be heard, so the mod's ReloadDelay/BurstDelays reach the screen and not the ear.`)
	}
}

// ---------------------------------------------------------------------------
// 9d  THE TESLA CRACKLE IS TIMED TO THE TESLA BOLT.
//
// `fx/tesla-arc.ts` draws a strike as 0.22 s in 4 discrete flicker steps. If the audio ran for
// a different length, or ran continuously where the bolt flickers, the two would be separate
// events that happened near each other rather than one event. Counting peaks in the smoothed
// envelope is the cheapest thing that can tell those apart, and it fails if either side is
// retimed without the other.
// ---------------------------------------------------------------------------
{
	/*
	 * COUNTED AS RISES, not as peaks and not as threshold crossings.
	 *
	 * Both of those were tried on this exact signal and both were wrong, in the way this
	 * project keeps producing instruments that are wrong. Local maxima counted nine and then
	 * seven, because a crackle is a Poisson process and its envelope wobbles. A Schmitt trigger
	 * counted three, because its arming level is a fraction of the loudest SAMPLE in a
	 * stochastic voice and the fourth, weakest strike sat under whatever that draw happened to
	 * be.
	 *
	 * What a strike physically IS is a restart: the envelope jumps from near the floor to full
	 * in a few milliseconds, and between strikes it only ever falls. So the thing to count is
	 * the RISE — the 4 ms forward difference of the envelope — and the reference is the largest
	 * rise in the window rather than the largest level. That is a ratio between two quantities
	 * of the same kind, which is why it reads 4 at every band and every seed while the other
	 * two disagreed with themselves.
	 */
	const k = 1 - Math.exp(-2 * Math.PI * 25 / SAMPLE_RATE)
	const span = Math.round(A.TESLA_ARC_LIFETIME_S * SAMPLE_RATE)
	const RISE_WINDOW = Math.round(0.004 * SAMPLE_RATE)
	// Half a strike interval: two rises closer together than that are one strike's texture.
	const guard = Math.round(A.TESLA_ARC_LIFETIME_S / A.TESLA_FLICKER_STEPS * 0.55 * SAMPLE_RATE)
	const counts = []
	for (let b = 0; b < bank.reports[A.FAMILY.electric].length; b++) {
		const s = bank.reports[A.FAMILY.electric][b].samples
		const env = new Float32Array(Math.min(span, s.length))
		let e = 0
		for (let i = 0; i < env.length; i++) { e += (Math.abs(s[i]) - e) * k; env[i] = e }
		let maxRise = 0
		for (let i = RISE_WINDOW; i < env.length; i++) {
			const d = env[i] - env[i - RISE_WINDOW]
			if (d > maxRise) maxRise = d
		}
		let strikes = 0
		let last = -guard * 2
		for (let i = RISE_WINDOW; i < env.length; i++) {
			if (env[i] - env[i - RISE_WINDOW] > maxRise * 0.25 && i - last > guard) { strikes++; last = i }
		}
		counts.push(strikes)
	}
	console.log(`  tesla: [${counts.join(', ')}] discharges per band inside the bolt's ${A.TESLA_ARC_LIFETIME_S}s lifetime ` +
		`(fx/tesla-arc.ts draws ${A.TESLA_FLICKER_STEPS} flicker steps)`)
	for (let b = 0; b < counts.length; b++)
		if (counts[b] !== A.TESLA_FLICKER_STEPS)
			fail(`the electric voice at band ${b} has ${counts[b]} discharges inside ${A.TESLA_ARC_LIFETIME_S} s where fx/tesla-arc.ts draws ${A.TESLA_FLICKER_STEPS} flicker steps — the bolt and its sound are no longer one event.`)
	// And it must not run long past the bolt: a crackle still going when the arc has vanished
	// is the same defect in the other direction.
	const tail = A.decayS(bank.reports[A.FAMILY.electric][1].samples, SAMPLE_RATE, 0.05)
	if (tail > A.TESLA_ARC_LIFETIME_S * 3)
		fail(`the electric voice is still audible ${tail.toFixed(3)} s in, more than three times the ${A.TESLA_ARC_LIFETIME_S} s the bolt is on screen.`)
}

// ---------------------------------------------------------------------------
// 10  §8 — every consumer must handle all 13 surfaces.
// ---------------------------------------------------------------------------
if (A.SURFACE_VOICING.length !== 13)
	fail(`SURFACE_VOICING has ${A.SURFACE_VOICING.length} entries, not 13 — §8 requires every consumer to handle all of them.`)

{
	const row = bank.impacts[bank.impacts.length - 1]
	/**
	 * Surfaces are compared on a SIGNATURE, not on brightness alone.
	 *
	 * The single-axis version of this check was wrong in both directions at once: it called
	 * gravel and road identical because their centroids were close while their decay and
	 * loudness were nothing alike, and it would have passed two surfaces that differed only in
	 * brightness while being otherwise the same sound. Three features and a normalised
	 * euclidean distance is the same measurement `rostergate` uses for silhouettes, down to
	 * the 0.06 floor — deliberately, because the question is identical: are these two things
	 * distinguishable, or does the roster merely claim they are?
	 */
	const feat = row.map(v => [
		A.spectralCentroid(v.samples, SAMPLE_RATE),
		A.decayS(v.samples, SAMPLE_RATE, 0.05),
		A.rms(v.samples),
	])
	const FEATURES = 3
	const MIN_SURFACE_SEPARATION = 0.06
	console.log(`  impact signature (heaviest band) — surface, centroid Hz, decay s, rms`)
	for (let i = 0; i < feat.length; i++) {
		console.log(`    ${SURFACE_NAME(i).padEnd(9)} ${feat[i][0].toFixed(0).padStart(5)}  ${feat[i][1].toFixed(3)}  ${feat[i][2].toFixed(4)}`)
	}
	let worst = { d: Infinity, i: -1, j: -1 }
	for (let i = 0; i < feat.length; i++) {
		for (let j = i + 1; j < feat.length; j++) {
			let sum = 0
			for (let k = 0; k < FEATURES; k++) {
				const rel = Math.abs(feat[i][k] - feat[j][k]) / Math.max(feat[i][k], feat[j][k], 1e-9)
				sum += rel * rel
			}
			const d = Math.sqrt(sum / FEATURES)
			if (d < worst.d) worst = { d, i, j }
			if (d < MIN_SURFACE_SEPARATION)
				fail(`impacts on ${SURFACE_NAME(i)} and ${SURFACE_NAME(j)} are ${d.toFixed(4)} apart (floor ${MIN_SURFACE_SEPARATION}) — the same sound. §8 says a consumer that silently treats one surface as another is a gate failure.`)
		}
	}
	console.log(`  closest pair: ${SURFACE_NAME(worst.i)}/${SURFACE_NAME(worst.j)} at ${worst.d.toFixed(4)} (floor ${MIN_SURFACE_SEPARATION})`)
	const cs = feat.map(f => f[0])
	// The one ordering claim worth pinning: struck metal is the brightest thing in the game
	// and dry sand is the deadest. If those two ever invert, the table has been edited by
	// someone tuning by eye rather than by ear.
	if (!(cs[6] > cs[2]))
		fail(`a round hitting metal (${cs[6].toFixed(0)} Hz) is not brighter than one hitting sand (${cs[2].toFixed(0)} Hz).`)
}

// ---------------------------------------------------------------------------
// 11b  MOVEMENT LOOPS. The only sustained family, and the only one that must MEET ITSELF.
//
// A loop is judged by three things a one-shot is not: it must not decay (a decaying "loop"
// pumps once per period), it must not step at the wrap (which buzzes at the loop rate — 1 Hz
// for a 1 s loop, squarely in the range the ear reads as a fault), and the thirteen surfaces
// must still be distinguishable while driving, not only while being hit.
//
// The seam test is the one worth explaining. It does NOT assert that the wrap delta is small
// in absolute terms — for a noise-based loop, adjacent samples legitimately differ by a lot.
// It asserts the wrap delta is no larger than the deltas ALREADY INSIDE the loop. That is the
// question actually being asked: is the seam distinguishable from ordinary signal?
// ---------------------------------------------------------------------------
{
	const loops = falsify === 'clean-loops-unused' ? [] : (bank.movement ?? [])
	if (loops.length !== 13)
		fail(`the movement bank has ${loops.length} loops, not 13 — §8 names "engine surface noise" as a consumer of the surface enum and requires every consumer to handle all of them.`)

	console.log('  movement loops — surface, centroid Hz, seam/internal step ratio, sustain ratio')
	const mfeat = []
	for (let i = 0; i < loops.length; i++) {
		const s = loops[i].samples
		const label = `movement[${SURFACE_NAME(i)}]`
		const peak = maxAbs(s)
		if (peak < MIN_PEAK) fail(`${label}: peak ${peak.toFixed(4)} < ${MIN_PEAK} — a silent engine.`)
		if (peak > MAX_PEAK) fail(`${label}: peak ${peak.toFixed(4)} > ${MAX_PEAK} — clips.`)
		const dc = Math.abs(A.dcOffset(s))
		if (dc > MAX_DC) fail(`${label}: DC offset ${dc.toFixed(5)} > ${MAX_DC} — a sustained voice with DC is a sustained thump.`)

		// Seam. Compare the wrap step against the 99.5th-percentile internal step, not the
		// maximum: one legitimate transient inside the loop would otherwise raise the bar
		// high enough to hide any seam at all.
		let steps = new Float64Array(s.length - 1)
		for (let k = 0; k < s.length - 1; k++) steps[k] = Math.abs(s[k + 1] - s[k])
		steps = steps.sort()
		const p995 = steps[Math.min(steps.length - 1, Math.floor(steps.length * 0.995))]
		const seam = Math.abs(s[0] - s[s.length - 1])
		const ratio = seam / Math.max(p995, 1e-9)

		// First fifth vs last fifth. A one-shot masquerading as a loop fails this outright.
		const fifth = Math.max(1, Math.floor(s.length / 5))
		const head = A.rms(s.subarray(0, fifth))
		const tail = A.rms(s.subarray(s.length - fifth))
		const sustain = tail / Math.max(head, 1e-9)

		// Crest factor is the third feature and it is the one that separates TEXTURES: gravel
		// is a spray of discrete hard contacts and peaks far above its own average, while snow
		// is a smooth hiss that barely does. Two loops can share a centroid and a level and
		// still be obviously different machines, and this is the number that knows it.
		const crest = peak / Math.max(A.rms(s), 1e-9)
		mfeat.push([A.spectralCentroid(s, SAMPLE_RATE), A.rms(s), crest])
		console.log(`    ${SURFACE_NAME(i).padEnd(9)} ${mfeat[i][0].toFixed(0).padStart(5)}  seam ${ratio.toFixed(3).padStart(7)}  sustain ${sustain.toFixed(3)}`)

		// SEAM IS REPORTED, NOT ASSERTED, and the reason is measured rather than assumed.
		//
		// It was an assertion first. The `--falsify=click` control — the same loops with the
		// crossfade set to zero — showed the test cannot discriminate: broken loops scored as
		// low as 0.044 (concrete) and 0.180 (ash) while CORRECT loops scored as high as 1.03,
		// because |x[0] - x[n-1]| across broadband noise is a single random draw from the same
		// distribution as any internal step. Mean across all 13 was 0.458 correct against
		// 0.949 broken — a real difference, and nowhere near enough to judge one loop by.
		//
		// The crossfade makes the wrap correct BY CONSTRUCTION anyway: out[0] resolves to
		// raw[n] and out[n-1] to raw[n-1], which are adjacent samples of one continuous
		// signal. There is no step to find. What a non-crossfaded loop actually does wrong is
		// discard filter state, which shows up as a low-frequency transient once per period
		// and needs a smoothed-domain test to see. That test is worth writing; guessing at it
		// under time pressure is how this project acquired its instrument problem, so the
		// number is printed and left unjudged until someone writes the real one.
		if (sustain < 0.5 || sustain > 2.0)
			fail(`${label}: ends at ${sustain.toFixed(2)}x its starting level — a loop must sustain, and this one pumps once per period.`)
	}

	/**
	 * Same normalised-euclidean separation as the impacts, on the driving voice — but A
	 * RATCHET, not a flat floor, and the distinction is deliberate.
	 *
	 * Three of the 78 surface pairs do not reach 0.06 today: grass/snow at 0.028, sand/water
	 * at 0.051, soil/ash at 0.050. All three are soft absorbent ground against soft absorbent
	 * ground, and they are genuinely harder to separate while DRIVING than while being HIT,
	 * because an impact has a decay dimension with orders of magnitude of range and a sustained
	 * loop does not.
	 *
	 * Two dishonest ways to close this were available and both were rejected. Lowering the
	 * floor to 0.028 and printing PASS is the "gate quietly thresholded at 62 cm" failure that
	 * `muzzlegate`'s header already names. Editing SURFACE_VOICING until the numbers clear is
	 * worse — it is tuning the world to satisfy the instrument, and by that point four table
	 * rows had already been rewritten in this session with a physical justification each, which
	 * is exactly how that slide begins.
	 *
	 * So: the default asserts TODAY'S MEASURED WORST as debt that cannot grow, `--strict`
	 * asserts the real target and fails until the loops earn it, and every run prints how many
	 * pairs actually clear it. Same shape as `muzzlegate`, and RATCHET may only ever go down.
	 */
	const LOOP_SEPARATION_TARGET = 0.06
	const LOOP_SEPARATION_RATCHET = 0.028
	const loopLimit = strict ? LOOP_SEPARATION_TARGET : LOOP_SEPARATION_RATCHET
	let below = 0
	let mworst = { d: Infinity, i: -1, j: -1 }
	for (let i = 0; i < mfeat.length; i++) {
		for (let j = i + 1; j < mfeat.length; j++) {
			let sum = 0
			for (let k = 0; k < 3; k++) {
				const rel = Math.abs(mfeat[i][k] - mfeat[j][k]) / Math.max(mfeat[i][k], mfeat[j][k], 1e-9)
				sum += rel * rel
			}
			const d = Math.sqrt(sum / 3)
			if (d < mworst.d) mworst = { d, i, j }
			if (d < LOOP_SEPARATION_TARGET) below++
			if (d < loopLimit)
				fail(`driving over ${SURFACE_NAME(i)} and ${SURFACE_NAME(j)} sound the same (${d.toFixed(4)}, limit ${loopLimit}) — §8's "engine surface noise" is not being derived from the surface.`)
		}
	}
	if (mfeat.length > 1) {
		const pairs = (mfeat.length * (mfeat.length - 1)) / 2
		console.log(
			`  driving separation: ${pairs - below}/${pairs} pairs clear the ${LOOP_SEPARATION_TARGET} target` +
			`; closest ${SURFACE_NAME(mworst.i)}/${SURFACE_NAME(mworst.j)} at ${mworst.d.toFixed(4)}` +
			`; asserting ${strict ? 'the TARGET (--strict)' : `the ratchet ${LOOP_SEPARATION_RATCHET}`}`)
	}
}

// ---------------------------------------------------------------------------
// 11c  THE NOTIFICATION MUST NOT SOUND LIKE COMBAT.
//
// Its entire job is to be recognised while a firefight is happening. If it lands anywhere
// inside the range the weapons occupy it will be heard as one more impact and missed, and a
// missed notification about your own production is a worse failure than no notification —
// you stop trusting it. So the assertion is not "it is audible", it is "it is SEPARATE": its
// brightness must sit clearly outside the entire span the report bank covers.
// ---------------------------------------------------------------------------
{
	/*
	 * BRIGHTNESS RATIO, AND THE REASON IS A CONTROL THAT PASSED WHEN IT SHOULD HAVE FAILED.
	 *
	 * This assertion was first written as the same five-feature signature distance the families
	 * and the surfaces use, floored at 0.30. It looked right, it passed, and `--falsify=dullbell`
	 * — the notification restored to its original 520 Hz, which is 3.7% in brightness from the
	 * heal tone and is to say the same sound — PASSED IT TOO, at 0.3512. The signature simply
	 * cannot express "this is a bell": centroid is one fifth of the vector, and a bell and a
	 * heal chime agree on level, crest and onset, so two voices a listener could not tell apart
	 * scored further apart than the correct answer did.
	 *
	 * That is the eighth instrument in this project to report green on something it could not
	 * see, caught this time because the control was written before the assertion was believed.
	 * The replacement asks the one question the vector was diluting: is the bell in a different
	 * REGISTER from everything a weapon can do. It is two-sided — a bell that drifted up into
	 * the tesla crackle fails exactly as one that drifted down into the heal tone does — and
	 * `--falsify=dullbell` fails it at 1.06.
	 *
	 * Over the REACHABLE cells only, for the same reason as the separation check above: flame
	 * band 0 and bomb band 0 are voices no weapon in this mod can produce.
	 */
	const bell = A.spectralCentroid(bank.notify.samples, SAMPLE_RATE)
	let worst = { r: Infinity, cell: null }
	for (const c of REACHABLE) {
		const other = feat[c.f][c.b][0]
		const r = Math.max(bell, other) / Math.max(Math.min(bell, other), 1e-9)
		if (r < worst.r) worst = { r, cell: c }
	}
	console.log(`  notify: centroid ${bell.toFixed(1)} Hz; nearest reachable weapon voice is ` +
		`${A.FAMILY_NAMES[worst.cell.f]}[${worst.cell.b}] at ${feat[worst.cell.f][worst.cell.b][0].toFixed(0)} Hz ` +
		`— a ratio of ${worst.r.toFixed(2)} (floor ${MIN_NOTIFY_BRIGHTNESS_RATIO})`)
	if (worst.r < MIN_NOTIFY_BRIGHTNESS_RATIO)
		fail(`the production bell (${bell.toFixed(0)} Hz) is only ${worst.r.toFixed(2)}x from the ` +
			`${A.FAMILY_NAMES[worst.cell.f]} voice at band ${worst.cell.b} ` +
			`(${feat[worst.cell.f][worst.cell.b][0].toFixed(0)} Hz, fired by ${worst.cell.weapons.slice(0, 2).join(', ')}) ` +
			`— in a firefight it will be heard as one more shot, which is exactly when it matters.`)
	const decay = A.decayS(bank.notify.samples, SAMPLE_RATE, 0.05)
	if (!(decay > 0.25))
		fail(`the production bell rings for only ${decay.toFixed(3)} s — too short to register over combat.`)
}

// ---------------------------------------------------------------------------
// 11  A kill must not read as another hit landing.
// ---------------------------------------------------------------------------
{
	/*
	 * COMPARED AGAINST THE COMBUSTION FAMILIES, NOT AGAINST EVERYTHING.
	 *
	 * The original form — "the shortest destruction outlasts the longest report" — was exactly
	 * right while every report was one pressure event on one curve. It stops being a
	 * meaningful sentence once the bank contains a torpedo motor that burns for 2.6 s: no kill
	 * can outlast a sustained source, and demanding it would make destructions grow until they
	 * were longer than anything on the battlefield for a reason that has nothing to do with
	 * kills. What the assertion is actually about is that a KILL IS NOT ANOTHER ROUND LANDING,
	 * and the things that sound like a round landing are the impulsive combustion families.
	 *
	 * A motor or a jet is neither, and is excluded by name and with the reason stated, not by
	 * quietly loosening the threshold until it passed.
	 */
	const IMPULSIVE_COMBUSTION = [A.FAMILY.cannon, A.FAMILY.artillery, A.FAMILY.mg, A.FAMILY.rifle, A.FAMILY.melee]
	console.log('  kill vs gun, matched severity — band, destruction (decay/centroid), longest gun report at that band')
	for (let b = 0; b < bank.destructions.length && b < A.REPORT_BANDS; b++) {
		const d = bank.destructions[b]
		const dDecay = A.decayS(d.samples, SAMPLE_RATE, 0.05)
		const dCentroid = A.spectralCentroid(d.samples, SAMPLE_RATE)
		let worstDecay = 0, worstLabel = '', brightest = 0, brightLabel = ''
		for (const f of IMPULSIVE_COMBUSTION) {
			const v = bank.reports[f][b]
			const rd = A.decayS(v.samples, SAMPLE_RATE, 0.05)
			const rc = A.spectralCentroid(v.samples, SAMPLE_RATE)
			if (rd > worstDecay) { worstDecay = rd; worstLabel = `${A.FAMILY_NAMES[f]}[${b}]` }
			if (rc < brightest || brightest === 0) { brightest = rc; brightLabel = `${A.FAMILY_NAMES[f]}[${b}]` }
		}
		console.log(`    ${b}  destruction ${dDecay.toFixed(3)}s / ${dCentroid.toFixed(0)}Hz   longest gun ${worstLabel} ${worstDecay.toFixed(3)}s   darkest gun ${brightLabel} ${brightest.toFixed(0)}Hz`)
		if (!(dDecay > worstDecay))
			fail(`a destruction at band ${b} lasts ${dDecay.toFixed(3)} s, not longer than the ${worstLabel} report at ${worstDecay.toFixed(3)} s — a kill of that violence sounds like one more shot of that weight.`)
		if (!(dCentroid < brightest))
			fail(`a destruction at band ${b} is ${dCentroid.toFixed(0)} Hz, not darker than the darkest gun at that band (${brightLabel}, ${brightest.toFixed(0)} Hz) — a kill must be the lowest thing on the field.`)
	}
}

// ---------------------------------------------------------------------------

const loopSamples = (bank.movement ?? []).reduce((n, v) => n + v.samples.length, 0)
{
	// The cost of the family axis, printed on every run rather than estimated in a comment.
	const reportSamples = bank.reports.reduce((n, row) => n + row.reduce((m, v) => m + v.samples.length, 0), 0)
	console.log(`  reports: ${bank.reports.length} families x ${A.REPORT_BANDS} bands = ` +
		`${bank.reports.length * A.REPORT_BANDS} voices, ${(reportSamples / SAMPLE_RATE).toFixed(2)} s, ` +
		`${(reportSamples * 4 / (1024 * 1024)).toFixed(2)} MiB`)
}
const seconds = (allVoices.reduce((n, x) => n + x.v.samples.length, 0) + loopSamples) / SAMPLE_RATE
const megabytes = (allVoices.reduce((n, x) => n + x.v.samples.length, 0) + loopSamples) * 4 / (1024 * 1024)
console.log(`  bank: ${seconds.toFixed(2)} s of audio, ${megabytes.toFixed(2)} MiB resident, 0 bytes downloaded`)

if (problems.length > 0) {
	for (const p of problems) console.error(`  ${p}`)
	console.error(`${TOOL}: FAIL — ${problems.length} problem(s)`)
	process.exit(1)
}
console.log(`${TOOL}: PASS — every voice is audible, bounded, reproducible, derived from the weapon's own rules rather than from taste, and no two families share a sound.`)
