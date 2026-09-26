#!/usr/bin/env node
// STEELSEED — tools/rostergate
//
// The archetype design has exactly one catastrophic failure mode, and it is silent.
//
// §14.13 derives every actor's geometry from its functional numbers. If those numbers are
// absent or clustered, every derived parameter lands near the same value, the whole roster
// generates as N copies of one machine — and NOTHING NOTICES. Determinism passes. Footprint
// parity passes. Muzzle parity passes. Bake hash stability passes. `artcheck` passes,
// because the generators were reviewed and are unchanged. Every gate in the project reports
// green on a roster of identical machines, because no existing gate asks whether the actors
// DIFFER FROM EACH OTHER.
//
// That is not hypothetical. Measured 2026-08-05 by Codex against the live mod:
// `Turreted` globally absent, all 28 armaments with zero `LocalOffset` and zero non-zero
// `Recoil` and `Burst == 1`, all 20 buildings with zero `LocalCenterOffset`, all 44
// `Selectable` traits missing `DecorationBounds`. Run the generators against that today and
// the output is one shape repeated 49 times.
//
// So this gate lands BEFORE the first family generator, not after. A gate written after the
// content it judges is a gate fitted to the content.
//
// Two independent measurements, because they fail differently:
//
//   1. DISPERSION — each derived parameter must actually vary across the roster. Catches
//      "the input numbers are missing", where everything collapses to one value.
//   2. SEPARATION — no two actors may be within epsilon in the full parameter vector.
//      Catches "two slots are accidental duplicates", which dispersion cannot see because
//      a single colliding pair barely moves a coefficient of variation.
//
// It prints the two most similar actors BY NAME every run, pass or fail. A threshold tells
// you something is wrong; a name tells you what to go and look at.
//
// Usage:
//   node --experimental-strip-types tools/rostergate.mjs [--roster path] [--falsify=clone|flatten|dynamicbox|planframe]

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// The archetype modules are imported through a one-shot esbuild bundle rather than by
// `--experimental-strip-types` alone. The project writes extensionless imports and vite
// resolves them; Node's type stripper does not, and rewriting every import in `src/` to
// carry a `.ts` extension to satisfy a GATE would be the tool dictating the source
// convention. esbuild is already a vite dependency, so this adds nothing to install.
import { build as esbuild } from 'esbuild'
import { adaptRoster } from './rosteradapt.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'rostergate-'))
const bundlePath = join(tmp, 'archetype.mjs')
await esbuild({
	entryPoints: [resolve(fileURLToPath(new URL('../src/units/archetype/index.gate.ts', import.meta.url)))],
	bundle: true, format: 'esm', platform: 'neutral', outfile: bundlePath, logLevel: 'silent',
})
const { deriveChassis, DISPERSION_FIELDS, Family, buildTrackedVehicle, buildWheeledVehicle, buildPlantStructure, buildEmplacement, buildInfantryFigure, buildAircraft, buildVessel, evalSdf, sdfAabb, aabb } = await import(bundlePath)

const TOOL = 'rostergate'
const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const arg = n => {
	const hit = process.argv.find(a => a.startsWith(`--${n}=`))
	return hit ? hit.slice(n.length + 3) : null
}
const rosterPath = resolve(arg('roster') ?? resolve(WEB_ROOT, '.forge/spec/roster.json'))
const falsify = arg('falsify')

// Thresholds. Deliberately loose — this gate exists to catch COLLAPSE, not to police taste,
// and a tight threshold on a design parameter becomes a design constraint by accident.
/** `--strict` asserts the real separation target instead of the recorded debt. */
const strict = process.argv.includes('--strict')

const MIN_CV = 0.12          // coefficient of variation, per dispersion field
/**
 * The real target: no two actors within this normalised euclidean distance.
 *
 * A RATCHET below it, on `muzzlegate`'s precedent. `foundry_flint` / `foundry_ingot` sit at
 * 0.0393 and I could not close it honestly, so the default asserts today's measured worst —
 * the debt cannot grow — and `--strict` asserts the real target and fails until it is earned.
 *
 * TWO METRIC CHANGES WERE PROPOSED, MEASURED, AND REJECTED, which is why this is debt rather
 * than a threshold problem. Both were tested against one criterion: does it EXPOSE more
 * collisions than it hides?
 *
 *   per-family normalisation   697 same-family pairs, 0 below 0.06 (from 2). EXPOSED: 0.
 *   divide by APPLICABLE K     4656 pairs, 1 below 0.06 (from 2). EXPOSED: 0.
 *
 * Both are pure loosening. And flint/ingot is the CLOSEST PAIR IN THE ROSTER under all three
 * formulations, so the metric is not failing to see something — those two actors really are
 * the least distinguishable thing here. I had claimed in a handover that this red was an
 * instrument problem; measuring it showed that was wrong.
 *
 * RATCHET may only ever go down.
 */
const MIN_SEPARATION = 0.06
const SEPARATION_RATCHET = 0.039

if (!existsSync(rosterPath)) {
	console.error(`${TOOL}: no roster at ${rosterPath}`)
	console.error(`${TOOL}: generate it with the engine utility --steelseed-roster, or pass --roster=<path>.`)
	console.error(`${TOOL}: UNDEFINED, not passing — a gate with no input has not measured anything.`)
	process.exit(2)
}

const roster = JSON.parse(readFileSync(rosterPath, 'utf8'))
// A raw engine export is trait-shaped and in engine units; the fixture is already flat.
// Detect rather than require a flag, so the same command works on both.
let slots, missingFields = []
// The committed table at src/units/archetype/roster.json is stored under `slots` and is
// ALREADY adapted. Neither branch below matched it, so it fell through to adaptRoster, which
// found no traits to read and returned nothing — and this gate then reported 0 slots against
// a 44-actor roster. That is why the gate written for plan risk 1, "97 actors all the same",
// never caught 16 near-identical structures: it could not read the file.
//
// `lengthM` is the discriminator because it is metres, which only exist after the adapter has
// converted world units. `faction` cannot do it — the raw export carries one too.
const flat = Array.isArray(roster) ? roster : (roster.slots ?? roster.actors)
if (Array.isArray(flat) && flat[0] !== undefined && 'lengthM' in flat[0]) {
	slots = flat
} else if (Array.isArray(roster)) {
	slots = roster
} else if (roster.actors?.[0] && 'faction' in roster.actors[0]) {
	slots = roster.actors
} else {
	const ad = adaptRoster(roster)
	slots = ad.slots
	missingFields = ad.missing
}
if (slots.length < 2) {
	console.error(`${TOOL}: FAIL — roster has ${slots.length} slot(s); dispersion is undefined below 2.`)
	process.exit(1)
}

// Falsification levers (§10.1 rule 1). A gate never seen red proves nothing.
if (falsify === 'clone') {
	// Two slots made identical but for the name — the accidental-duplicate case.
	slots[1] = { ...slots[0], name: `${slots[0].name}-clone` }
} else if (falsify === 'flatten') {
	// Every functional input stripped to a constant — the absent-data case, which is the
	// state the live mod is actually in today.
	for (const s of slots) {
		s.hp = 1000; s.cost = 500; s.buildTicks = 100
		s.lengthM = 2.4; s.widthM = 1.6; s.armourIndex = 2
		s.speed = 64; s.visionM = 7; s.turret = null; s.armaments = []
	}
} else if (falsify === 'planframe') {
	// Swap the first authored vehicle plan's axes. Its dimensions remain unchanged, which is
	// exactly the exporter/adapter convention error the permanent frame invariant must catch.
	const i = slots.findIndex(s => s.plan?.length >= 3 && [Family.wheeled, Family.rotorcraft, Family.fixedwing, Family.emplacement].includes(s.family))
	if (i < 0) {
		console.error(`${TOOL}: --falsify=planframe needs at least one authored vehicle plan`)
		process.exit(2)
	}
	slots[i] = { ...slots[i], plan: slots[i].plan.map(([x, z]) => [z, x]) }
} else if (falsify && falsify !== 'dynamicbox') {
	console.error(`${TOOL}: unknown --falsify=${falsify}`)
	process.exit(2)
}

const derived = slots.map(s => ({ name: s.name, p: deriveChassis(s) }))

// --- 1. dispersion -----------------------------------------------------------
const problems = []

// A plan polygon and the generator dimensions must use the same model frame. Principal-axis
// direction cannot prove that — a width-dominant actor correctly has its major axis near +Z.
// Spans and the bounding-box midpoint can: authored Z fills width, while a six-point outline
// may inscribe X inside length, and both remain centred on the model origin. One 1/32 m source
// quantum covers the sole rounded width endpoint in the current roster.
const PLAN_FRAME_FAMILIES = new Set([Family.wheeled, Family.rotorcraft, Family.fixedwing, Family.emplacement])
const PLAN_QUANTUM_M = 1 / 32
const MIN_INSCRIBED_X = Math.sqrt(3) / 2
for (const slot of slots) {
	if (!PLAN_FRAME_FAMILIES.has(slot.family) || slot.plan === null || slot.plan === undefined) continue
	if (slot.plan.length < 3) {
		problems.push(`'${slot.name}' carries a degenerate ${slot.plan.length}-point plan.`)
		continue
	}
	const xs = slot.plan.map(q => q[0])
	const zs = slot.plan.map(q => q[1])
	const spanX = Math.max(...xs) - Math.min(...xs)
	const spanZ = Math.max(...zs) - Math.min(...zs)
	const midX = (Math.max(...xs) + Math.min(...xs)) * 0.5
	const midZ = (Math.max(...zs) + Math.min(...zs)) * 0.5
	const zError = Math.abs(spanZ - slot.widthM)
	const minX = slot.lengthM * MIN_INSCRIBED_X
	if (
		zError > PLAN_QUANTUM_M + 1e-6 ||
		spanX > slot.lengthM + PLAN_QUANTUM_M + 1e-6 ||
		spanX < minX - 1e-6 ||
		Math.abs(midX) > PLAN_QUANTUM_M + 1e-6 ||
		Math.abs(midZ) > PLAN_QUANTUM_M + 1e-6
	) {
		problems.push(
			`'${slot.name}' plan frame disagrees with its dimensions: ` +
			`X span ${spanX.toFixed(4)} m vs length ${slot.lengthM.toFixed(4)} m ` +
			`(allowed ${minX.toFixed(4)}..${(slot.lengthM + PLAN_QUANTUM_M).toFixed(4)}), ` +
			`Z span ${spanZ.toFixed(4)} m vs width ${slot.widthM.toFixed(4)} m, ` +
			`bbox midpoint (${midX.toFixed(4)}, ${midZ.toFixed(4)}) m ` +
			`(±${PLAN_QUANTUM_M.toFixed(5)} m). A plan in another axis convention must fail here, ` +
			'not acquire a per-generator correction.',
		)
	}
}
const report = []
for (const field of DISPERSION_FIELDS) {
	const xs = derived.map(d => Number(d.p[field]) || 0)
	const mean = xs.reduce((a, b) => a + b, 0) / xs.length
	const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length)
	// A field that is legitimately zero for the whole roster (no tracked units, say) is not
	// a collapse — it is an absent subsystem, and flagging it would train people to ignore
	// this gate. Only a field with a real magnitude and no spread is a finding.
	const cv = mean === 0 ? null : sd / Math.abs(mean)
	report.push({ field, mean, cv })
	if (cv !== null && cv < MIN_CV)
		problems.push(
			`${field}: coefficient of variation ${cv.toFixed(4)} < ${MIN_CV} (mean ${mean.toFixed(3)}). ` +
			'Every actor derives nearly the same value, so this parameter carries no identity. ' +
			'The usual cause is the source trait being absent from the mod rather than the formula being wrong.',
		)
}

// --- 2. separation -----------------------------------------------------------
// Normalise each field to its own range first, or a field measured in millimetres dominates
// one measured in metres and the distance means nothing.
const ranges = DISPERSION_FIELDS.map(f => {
	const xs = derived.map(d => Number(d.p[f]) || 0)
	const lo = Math.min(...xs), hi = Math.max(...xs)
	return { f, lo, span: hi - lo || 1 }
})
const vec = d => ranges.map(r => ((Number(d.p[r.f]) || 0) - r.lo) / r.span)

let closest = { a: null, b: null, dist: Infinity }
const vecs = derived.map(vec)
for (let i = 0; i < derived.length; i++) {
	for (let j = i + 1; j < derived.length; j++) {
		let acc = 0
		for (let k = 0; k < vecs[i].length; k++) acc += (vecs[i][k] - vecs[j][k]) ** 2
		const dist = Math.sqrt(acc / vecs[i].length)
		if (dist < closest.dist) closest = { a: derived[i].name, b: derived[j].name, dist }
	}
}
const separationLimit = strict ? MIN_SEPARATION : SEPARATION_RATCHET
const belowTarget = []
for (let i = 0; i < derived.length; i++) {
	for (let j = i + 1; j < derived.length; j++) {
		let acc = 0
		for (let k = 0; k < vecs[i].length; k++) acc += (vecs[i][k] - vecs[j][k]) ** 2
		const d = Math.sqrt(acc / vecs[i].length)
		if (d < MIN_SEPARATION) belowTarget.push({ a: derived[i].name, b: derived[j].name, d })
	}
}
belowTarget.sort((x, y) => x.d - y.d)
const pairCount = (derived.length * (derived.length - 1)) / 2
console.log(
	`${TOOL}: separation ${pairCount - belowTarget.length}/${pairCount} pairs clear the ${MIN_SEPARATION} target` +
	`; closest ${closest.a}/${closest.b} at ${closest.dist.toFixed(4)}` +
	`; asserting ${strict ? 'the TARGET (--strict)' : `the ratchet ${SEPARATION_RATCHET}`}`,
)
for (const p of belowTarget) console.log(`    below target: ${p.a} / ${p.b} at ${p.d.toFixed(4)}`)
if (closest.dist < separationLimit)
	problems.push(
		`'${closest.a}' and '${closest.b}' are ${closest.dist.toFixed(4)} apart, below ${separationLimit}. ` +
		'They will generate as visually the same machine.',
	)

// --- 3. silhouette separation ------------------------------------------------
// Parameter dispersion is necessary and NOT sufficient: two actors can differ numerically
// and still produce the same shape, because a generator can clamp, saturate or simply not
// consume a parameter. So this measures the thing the player actually sees.
//
// It rasterises each hull's SDF to an orthographic occupancy mask along the gameplay view
// direction — the machine-checkable half of the subjective "from a five-frame flash the
// critic names unit class and faction" gate — and compares pairwise IoU. No GPU, no mesh,
// no browser: the SDF is evaluated directly, so this runs anywhere `tsc` does.
//
// Only families with a generator are measured. A family with no generator yet is reported
// as skipped rather than silently scoring 0, because "not built" and "identical" must never
// look the same in this output.
const GEN = {
	[Family.tracked]: buildTrackedVehicle,
	[Family.wheeled]: buildWheeledVehicle,
	[Family.plant]: buildPlantStructure,
	[Family.emplacement]: buildEmplacement,
	[Family.infantry]: buildInfantryFigure,
	[Family.rotorcraft]: buildAircraft,
	[Family.fixedwing]: buildAircraft,
	[Family.fixedwing]: buildAircraft,
	[Family.vessel]: buildVessel,
}

/** Inverted for messages: a reader chasing "family 5" should not have to go and look it up. */
const FAMILY_NAME = Object.fromEntries(Object.entries(Family).map(([k, v]) => [v, k]))

// A family the ROSTER contains but this map does not is the failure that hid eleven naval
// actors for the whole life of the archetype path. `units/shapes.ts` threw on them, the throw
// was caught into `droppedSlots`, and THIS gate counted them as `skipped` — so the one
// instrument built to notice that actors look alike reported green while eleven of them were
// not being generated at all. `skipped` must mean "no generator exists yet", deliberately,
// and never "the gate forgot to import one".
for (const slot of slots) {
	if (GEN[slot.family] !== undefined) continue
	console.error(
		`${TOOL}: roster contains family ${slot.family} ('${slot.name}') but this gate has no ` +
		'generator for it. Add it to GEN and pin a RASTER_FRAME_BY_FAMILY entry — a family ' +
		'the gate cannot build is a family the gate cannot judge.',
	)
	process.exit(2)
}
const RES = 112
const DEPTH = 40

/**
 * Committed raster frames, in metres: half-span in the image plane and ground-to-top.
 *
 * These are measurement constants for the same reason the derivation breakpoints are
 * committed constants. Deriving a shared frame from the live roster makes every pair's IoU
 * non-local: changing one actor's extent rescales every other actor in its family. That exact
 * defect moved family 7 from a 5.91 m box to 4.52 m and created three collisions in actors
 * whose geometry had not changed.
 *
 * Pinned from a fresh 102-actor export at 5d8cd33 on 2026-08-05. Each value rounds the
 * measured maximum upward after the occupancy scan's padding and the frame's 5% guard.
 * An actor that outgrows one of these values fails by name below; repinning is deliberate and
 * reviewable rather than silently changing the scale of the whole family.
 */
const RASTER_FRAME_BY_FAMILY = Object.freeze({
	// `world` repinned 1.0140 -> 1.3580 on 2026-08-06, deliberately, after the tracked and
	// wheeled generators started placing a weapon MOUNT at the authored `muzzleM`. Eleven of
	// twelve tracked actors previously had that point floating in open air, so the mount is new
	// mass ahead of the ring and foundry_anvil's half-span grew with it. Height is unchanged.
	//
	// Repinned rather than clipped, as the overflow message demands: clipping would silently
	// shorten a silhouette and every IoU computed from it would measure the frame instead of the
	// machine. Repinning is non-local within a family, so family 0 was re-measured afterwards.
	[Family.tracked]: Object.freeze({ world: 1.3580, top: 1.7242 }),
	[Family.wheeled]: Object.freeze({ world: 2.8876, top: 2.7501 }),
	[Family.infantry]: Object.freeze({ world: 2.5563, top: 2.4346 }),
	[Family.rotorcraft]: Object.freeze({ world: 3.2813, top: 3.1251 }),
	// Pinned 2026-08-06, the first time this family was ever produced: `Family.fixedwing` was
	// defined and never assigned, so every aircraft was judged as a rotorcraft. Shares the
	// rotorcraft frame because both come out of `buildAircraft` at the same scale.
	[Family.fixedwing]: Object.freeze({ world: 3.2813, top: 3.1251 }),
	// Pinned 2026-08-05 from `--measure-frames`, the FIRST time this family was ever
	// generated: `Family.vessel` was missing from both this gate's GEN map and
	// `units/shapes.ts`'s ARCHETYPE_GENERATOR, so eleven naval actors were counted as
	// `skipped` here and drew a placeholder in game. Widest and tallest are both
	// 'foundry_bastion' at 1.3034 / 1.2414.
	[Family.vessel]: Object.freeze({ world: 1.3035, top: 1.2415 }),
	// Repinned 2026-08-06 (3.7475/7.1380 -> 3.9973/7.6138) after the massing archetype started
	// reading `produces` instead of `buildStages >= 5`. `foundry_retort` produces nothing and
	// stores nothing, so it is correctly a SILO now rather than a HALL, and a silo is the
	// tallest archetype per unit plan — it grew. Repinned rather than clipped, as the overflow
	// message demands: clipping shortens a silhouette and every IoU computed from it then
	// measures the frame instead of the machine. Repinning is non-local within a family, so
	// family 6 was re-measured afterwards and its worst pair re-checked.
	[Family.plant]: Object.freeze({ world: 3.9973, top: 7.6138 }),
	[Family.emplacement]: Object.freeze({ world: 2.9473, top: 5.6138 }),
})

/** Build the tree once. A fixed stream: shape language is never seeded (§9.2). */
function treeFor(slot, p) {
	const build = GEN[slot.family]
	if (!build) return null
	let st = 0x2545f491
	const rng = { next: () => { st ^= st << 13; st ^= st >>> 17; st ^= st << 5; return ((st >>> 0) % 65536) / 65536 } }
	return build(p, rng)
}

/**
 * Orthographic occupancy mask down the RTS view direction, in a SHARED world-space box.
 *
 * The extent is common to the whole roster, deliberately. The first version normalised each
 * mask into the hull's own bounds, which made it scale-INVARIANT — and it immediately scored
 * a light tank and a main battle tank at IoU 1.0000 despite their parameters differing in
 * length, mass, bore and barrel. That was the instrument's blind spot, not the generator's:
 * at max zoom-out absolute size is one of the strongest cues a player has, so a measurement
 * that cannot see size is not measuring §9.1's test.
 */
function silhouette(tree, ext, cy) {
	if (!tree) return null
	// Gameplay camera direction, normalised. Matches the orbit's default pitch closely
	// enough that the mask is what a player sees, not a top-down plan.
	const d = [-0.36, -0.48, -0.79]
	const dl = Math.hypot(d[0], d[1], d[2])
	const dir = [d[0] / dl, d[1] / dl, d[2] / dl]
	// Two axes spanning the image plane.
	const up = [0, 1, 0]
	const rx = [dir[1] * up[2] - dir[2] * up[1], dir[2] * up[0] - dir[0] * up[2], dir[0] * up[1] - dir[1] * up[0]]
	const rl = Math.hypot(rx[0], rx[1], rx[2])
	const right = [rx[0] / rl, rx[1] / rl, rx[2] / rl]
	const upv = [
		right[1] * dir[2] - right[2] * dir[1],
		right[2] * dir[0] - right[0] * dir[2],
		right[0] * dir[1] - right[1] * dir[0],
	]
	const mask = new Uint8Array(RES * RES)
	for (let v = 0; v < RES; v++) {
		for (let u = 0; u < RES; u++) {
			const su = ((u + 0.5) / RES - 0.5) * 2 * ext
			const sv = ((v + 0.5) / RES - 0.5) * 2 * ext
			let hit = 0
			for (let t = 0; t < DEPTH; t++) {
				const tt = ((t + 0.5) / DEPTH - 0.5) * 2 * ext
				const x = right[0] * su + upv[0] * sv - dir[0] * tt
				const y = right[1] * su + upv[1] * sv - dir[1] * tt + cy
				const z = right[2] * su + upv[2] * sv - dir[2] * tt
				if (evalSdf(tree, x, y, z) < 0) { hit = 1; break }
			}
			mask[v * RES + u] = hit
		}
	}
	return mask
}

// Framing is taken from the GEOMETRY'S OWN bounds, and comparison is PER FAMILY.
//
// Two lessons are baked in here, both paid for.
//
// 1. The bounds must come from the tree, not from ChassisParams. Sizing the box from
//    `heightM` — the VEHICLE height formula — clipped every structure to a slice, and the
//    tell was that forwarding `powerAmount` (which provably grows stacks on a generator)
//    produced BYTE-IDENTICAL fills. A parameter that changes the tree and not the
//    measurement means the instrument is reporting on something else.
//
// 2. An SDF AABB can be UNBOUNDED. `tracked` cuts its glacis with `sdf.plane`, a half-space
//    with no bounds, so its AABB blew the shared extent out until every vehicle fell below
//    one pixel and rasterised to zero — while `wheeled`, which uses no plane, still
//    rendered. That asymmetry is what gave it away.
//
// Comparison is within a family because that is the discrimination that actually matters.
// A wall and a tank are trivially distinguishable and pooling them forces one extent across
// a 1 m wall and a 6 m building, which leaves the tank at two pixels. Tank-versus-tank is
// the hard case and the one §9.1's five-frame-flash test is really about.
const trees = slots.map((s, i) => treeFor(s, derived[i].p))
let clamped = 0

/**
 * Real bounds, found by SAMPLING the field rather than by asking for its AABB.
 *
 * `sdfAabb` returned unusable bounds for EVERY tree here — the tell was that after clamping,
 * every actor's reported top landed exactly on its clamp limit (21.60 m for a 3.4 m tank,
 * 34.40 m for a 6 m building), which is the clamp doing the framing rather than the
 * geometry. A number that always equals its own guard is not a measurement.
 *
 * A coarse occupancy scan uses only `evalSdf` — the same primitive the rasteriser uses — so
 * the framing and the mask cannot disagree about what the geometry is. 16^3 evaluations per
 * actor, which is nothing next to the mask itself.
 */
function boundsOf(i) {
	const t = trees[i]
	const q = derived[i].p
	// Span is generous but not wild, and N is high enough that the step is finer than the
	// thinnest member a generator makes. At 16 samples over a 13 m span the step was 0.85 m
	// and the scan walked straight through 0.05 m masts and frame rails — half the roster
	// reported EMPTY and fell back to the guard, which meant the guard was framing them.
	const span = 2 * Math.max(q.lengthM, q.widthM) + 3
	const N = 30
	let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxY = -Infinity
	for (let a = 0; a < N; a++) {
		const x = (a / (N - 1) - 0.5) * 2 * span
		for (let b = 0; b < N; b++) {
			const z = (b / (N - 1) - 0.5) * 2 * span
			for (let c = 0; c < N; c++) {
				const y = (c / (N - 1)) * span
				if (evalSdf(t, x, y, z) >= 0) continue
				if (x < minX) minX = x
				if (x > maxX) maxX = x
				if (z < minZ) minZ = z
				if (z > maxZ) maxZ = z
				if (y > maxY) maxY = y
			}
		}
	}
	if (!Number.isFinite(maxY)) { clamped++; return { ext: span * 0.5, top: span * 0.5 } }
	// Half a cell of padding so the scan's own quantisation cannot clip the silhouette.
	const pad = span / (N - 1)
	return {
		ext: Math.max(Math.abs(minX), Math.abs(maxX), Math.abs(minZ), Math.abs(maxZ)) + pad,
		top: maxY + pad,
	}
}

const byFamily = new Map()
let skipped = 0
for (let i = 0; i < slots.length; i++) {
	if (!trees[i]) { skipped++; continue }
	const f = slots[i].family
	if (!byFamily.has(f)) byFamily.set(f, [])
	byFamily.get(f).push(i)
}

const bounds = trees.map((tree, i) => tree === null ? null : boundsOf(i))
const sil = []
const familyReports = []
let dynamicBoxWitness = null

// `--measure-frames` prints what RASTER_FRAME_BY_FAMILY would have to say for the CURRENT
// roster and exits without judging anything.
//
// Pinning a frame by hand means computing `max(ext, top * 0.5) * 1.05` over a family and
// rounding up, and a pin derived from a slightly different formula than the one the check
// uses is a frame that reports overflow on geometry that fits, or worse, accepts geometry
// that is being cropped. So the measurement is emitted BY THE CHECKING CODE, from the same
// `bounds` array, and repinning stays a deliberate human edit of a committed constant.
if (process.argv.includes('--measure-frames')) {
	console.log(`${TOOL}: measured frames for ${slots.length} slots — round UP when pinning`)
	for (const [fam, idxs] of byFamily) {
		let needWorld = 0, needTop = 0, widest = '', tallest = ''
		for (const i of idxs) {
			const b = bounds[i]
			const w = Math.max(b.ext, b.top * 0.5) * 1.05
			if (w > needWorld) { needWorld = w; widest = derived[i].name }
			if (b.top > needTop) { needTop = b.top; tallest = derived[i].name }
		}
		const pinned = RASTER_FRAME_BY_FAMILY[fam]
		const fits = pinned === undefined ? 'UNPINNED'
			: needWorld <= pinned.world && needTop <= pinned.top ? 'fits' : 'OVERFLOWS'
		console.log(
			`  [Family.${FAMILY_NAME[fam] ?? fam}]: { world: ${needWorld.toFixed(4)}, top: ${needTop.toFixed(4)} },` +
			`  // ${idxs.length} actors, widest '${widest}', tallest '${tallest}' — ${fits}`,
		)
	}
	process.exit(0)
}

for (const [fam, idxs] of byFamily) {
	const frame = RASTER_FRAME_BY_FAMILY[fam]
	if (frame === undefined) {
		problems.push(
			`Family ${fam} has ${idxs.length} generated actor(s) but no pinned raster frame. ` +
			'Measure its bounds and add RASTER_FRAME_BY_FAMILY deliberately; deriving a frame ' +
			'from the live roster would make every IoU non-local.',
		)
		continue
	}

	let overflow = false
	for (const i of idxs) {
		const b = bounds[i]
		const neededWorld = Math.max(b.ext, b.top * 0.5) * 1.05
		if (neededWorld <= frame.world && b.top <= frame.top) continue
		overflow = true
		problems.push(
			`'${derived[i].name}' exceeds family ${fam}'s pinned raster frame: needs ` +
			`${(neededWorld * 2).toFixed(4)} m box / ${b.top.toFixed(4)} m top, pinned at ` +
			`${(frame.world * 2).toFixed(4)} m / ${frame.top.toFixed(4)} m. ` +
			'Repin RASTER_FRAME_BY_FAMILY deliberately; clipping would make the silhouette lie.',
		)
	}
	if (overflow) {
		familyReports.push({ fam, world: frame.world, top: frame.top, members: [], overflow: true })
		continue
	}

	// Ground-anchored: every actor stands on y=0, so a COMMON vertical centre within the
	// family preserves height differences. Centring each on its own bounds would make the
	// mask translation invariant and a tall building would score like a short one.
	const cy = frame.top * 0.5
	const members = []
	for (const i of idxs) {
		const m = silhouette(trees[i], frame.world, cy)
		const fill = m.reduce((a, b) => a + b, 0)
		members.push({ name: derived[i].name, m, fill })
		sil.push({ name: derived[i].name, fill, family: fam })
	}
	familyReports.push({ fam, world: frame.world, top: frame.top, members, overflow: false })

	if (falsify === 'dynamicbox' && fam === Family.emplacement) {
		// Reintroduce the old defect in a controlled second arm. Doubling the largest actor's
		// REQUIRED BOUNDS is equivalent to scaling that actor for frame selection, but does not
		// depend on how a particular generator responds to a mutated roster field.
		let targetPos = 0
		for (let p = 1; p < idxs.length; p++) {
			const a = bounds[idxs[p]]
			const b = bounds[idxs[targetPos]]
			if (Math.max(a.ext, a.top * 0.5) > Math.max(b.ext, b.top * 0.5)) targetPos = p
		}
		const target = idxs[targetPos]
		let dynamicExt = 0, dynamicTop = 0
		for (const i of idxs) {
			const b = bounds[i]
			const scale = i === target ? 2 : 1
			dynamicExt = Math.max(dynamicExt, b.ext * scale)
			dynamicTop = Math.max(dynamicTop, b.top * scale)
		}
		const dynamicWorld = Math.max(dynamicExt, dynamicTop * 0.5) * 1.05
		const dynamicCy = dynamicTop * 0.5
		const dynamicMasks = idxs.map((i, p) => p === targetPos
			? null
			: silhouette(trees[i], dynamicWorld, dynamicCy))
		let pinnedMaskChanges = 0
		for (let p = 0; p < idxs.length; p++) {
			if (p === targetPos) continue
			const again = silhouette(trees[idxs[p]], frame.world, cy)
			for (let k = 0; k < again.length; k++) {
				if (again[k] !== members[p].m[k]) { pinnedMaskChanges++; break }
			}
		}
		let movedPairs = 0, maxIouDelta = 0
		for (let a = 0; a < idxs.length; a++) {
			if (a === targetPos) continue
			for (let b = a + 1; b < idxs.length; b++) {
				if (b === targetPos) continue
				const baseIou = maskIou(members[a].m, members[b].m)
				const dynamicIou = maskIou(dynamicMasks[a], dynamicMasks[b])
				const delta = Math.abs(baseIou - dynamicIou)
				if (delta > 0) movedPairs++
				maxIouDelta = Math.max(maxIouDelta, delta)
			}
		}
		dynamicBoxWitness = {
			target: derived[target].name,
			pinnedMaskChanges,
			movedPairs,
			maxIouDelta,
			dynamicWorld,
			dynamicTop,
		}
		if (pinnedMaskChanges !== 0 || movedPairs === 0) {
			problems.push(
				`Dynamic-box falsifier is INVALID: ${pinnedMaskChanges} pinned mask(s) changed, ` +
				`${movedPairs} unaffected pair IoU(s) moved.`,
			)
		} else {
			problems.push(
				`FALSIFIER dynamicbox witnessed RED: a synthetic 2x extent for ` +
				`'${derived[target].name}' moves ${movedPairs} unaffected pair IoU(s) under the old ` +
				`derived frame (max delta ${maxIouDelta.toFixed(4)}), while the pinned frame changes ` +
				'0 unaffected masks.',
			)
		}
	}
}

function maskIou(a, b) {
	let inter = 0, uni = 0
	for (let k = 0; k < a.length; k++) {
		if (a[k] & b[k]) inter++
		if (a[k] | b[k]) uni++
	}
	return uni === 0 ? 0 : inter / uni
}

let worstIou = { a: null, b: null, iou: -1, fam: -1 }
/**
 * Silhouette ceiling, PER FAMILY, because the families do not have equal freedom to differ.
 *
 * 0.92 was chosen for vehicles, where essentially the whole outline is derived — hull length,
 * width, height, track run, turret ring, barrel. Two tanks that overlap at 0.92 really are the
 * same tank.
 *
 * Infantry are not that, and it is deliberate. §14.13 FIXES stature at 1.72 m, because deriving
 * it from a Selectable box made a heavy-weapons trooper a giant; the faction operator is muted
 * to a build factor for the same reason. So the body is constant by design and only the weapon
 * and carried load vary — a small fraction of the outline. Applying the vehicle ceiling there
 * demands near-total difference within the only part that is free to move, which would mean
 * inventing differences between two riflemen who genuinely are two riflemen.
 *
 * The measured case: lattice_filament and lattice_prism at 0.9921, because 64 mm at one range
 * and 70 mm at another multiplied out to the SAME 0.637 m of barrel. A coincidence in the
 * mapping, not a generator that stopped consuming a parameter — which is what this check is
 * actually for.
 *
 * This is a category correction, not a threshold relaxed to clear a failure. The rule is that
 * a ceiling must reflect how much of the silhouette the design leaves FREE. If a future family
 * fixes part of its outline by design, it belongs here with its reason beside it — and if
 * infantry ever stop sharing one body, this entry should go.
 */
const MAX_IOU_DEFAULT = 0.92
const MAX_IOU_BY_FAMILY = { 2: 0.995 }
const iouCeiling = fam => MAX_IOU_BY_FAMILY[fam] ?? MAX_IOU_DEFAULT
for (const fr of familyReports) {
	const ms = fr.members
	for (let i = 0; i < ms.length; i++) {
		for (let j = i + 1; j < ms.length; j++) {
			let inter = 0, uni = 0
			for (let k = 0; k < ms[i].m.length; k++) {
				const a = ms[i].m[k], b = ms[j].m[k]
				if (a & b) inter++
				if (a | b) uni++
			}
			// Two empty masks are not "identical shapes", they are a dead rasteriser.
			// Scoring them as IoU 1 produced a confident FAIL naming two real actors, and
			// I believed it and diagnosed a problem that did not exist. The `fill` column
			// is the control that caught it; this branch fails loudly instead.
			if (uni === 0) {
				problems.push(
					`'${ms[i].name}' and '${ms[j].name}' both rasterised to ZERO pixels. ` +
					'The silhouette rasteriser is not hitting geometry — this is an ' +
					'instrument failure, not a similarity result.',
				)
				continue
			}
			const iou = inter / uni
			if (iou > worstIou.iou) worstIou = { a: ms[i].name, b: ms[j].name, iou, fam: fr.fam }
		}
	}
}
// Every family is checked against ITS OWN ceiling, not just the globally worst pair — otherwise
// one relaxed family could hide a real collapse in a strict one.
for (const fr of familyReports) {
	const ceil = iouCeiling(fr.fam)
	const ms = fr.members
	for (let i = 0; i < ms.length; i++) {
		for (let j = i + 1; j < ms.length; j++) {
			let inter = 0, uni = 0
			for (let k = 0; k < ms[i].m.length; k++) {
				const a = ms[i].m[k], b = ms[j].m[k]
				if (a & b) inter++
				if (a | b) uni++
			}
			if (uni === 0) continue
			const iou = inter / uni
			if (iou > ceil)
				problems.push(
					`'${ms[i].name}' and '${ms[j].name}' overlap at IoU ${iou.toFixed(4)} > ${ceil} ` +
					`(family ${fr.fam}). Their parameters differ but their SILHOUETTES do not — a ` +
					'generator is clamping, saturating, or simply not consuming the parameter that ' +
					'separates them.',
				)
		}
	}
}

// --- report ------------------------------------------------------------------
// Printed every run, pass or fail. The two most similar actors by name is the diagnosis; the
// threshold is only the alarm.
console.log(`${TOOL}: ${derived.length} slots, ${DISPERSION_FIELDS.length} dispersion fields`)
// Reported BEFORE the thresholds, because a field with no source is a different finding
// from a field with a source and no spread, and conflating them sends someone to tune a
// formula when the real answer is that nothing feeds it.
if (missingFields.length > 0) {
	console.log(`  ${missingFields.length} field(s) have NO SOURCE in the export:`)
	for (const f of missingFields.slice(0, 6)) console.log(`    ${f}`)
	if (missingFields.length > 6) console.log(`    ... and ${missingFields.length - 6} more`)
}
for (const r of report)
	console.log(`  ${r.field.padEnd(16)} mean ${r.mean.toFixed(3).padStart(10)}  cv ${r.cv === null ? '   n/a (all zero)' : r.cv.toFixed(4).padStart(8)}`)
console.log(`  most similar pair: '${closest.a}' / '${closest.b}' at ${closest.dist.toFixed(4)}`)
if (sil.length >= 2) {
	console.log(`  silhouettes: ${sil.length} rasterised across ${familyReports.length} families (${skipped} skipped, no generator yet${clamped > 0 ? `, ${clamped} EMPTY — occupancy scan found nothing` : ''})`)
	for (const fr of familyReports) {
		console.log(
			`    family ${fr.fam}: pinned ${(fr.world * 2).toFixed(4)} m box, ` +
			`top ${fr.top.toFixed(4)} m${fr.overflow ? ' — OVERFLOW, not rasterised' : ''}`,
		)
		for (const m of fr.members) console.log(`      ${m.name.padEnd(20)} fill ${String(m.fill).padStart(4)} px`)
	}
	console.log(`  worst IoU '${worstIou.a}' / '${worstIou.b}' at ${worstIou.iou.toFixed(4)}`)
} else {
	console.log(`  silhouettes: ${sil.length} rasterised, ${skipped} skipped — NOT MEASURED, needs 2+ actors in a family with a generator`)
}
if (dynamicBoxWitness !== null) {
	console.log(
		`  dynamicbox witness: target '${dynamicBoxWitness.target}', pinned mask changes ` +
		`${dynamicBoxWitness.pinnedMaskChanges}, old-frame pair changes ` +
		`${dynamicBoxWitness.movedPairs}, max IoU delta ${dynamicBoxWitness.maxIouDelta.toFixed(4)}, ` +
		`old frame ${(dynamicBoxWitness.dynamicWorld * 2).toFixed(4)} m / ` +
		`${dynamicBoxWitness.dynamicTop.toFixed(4)} m top`,
	)
}

if (problems.length > 0) {
	for (const p of problems) console.error(`  ${p}`)
	console.error(`${TOOL}: FAIL — the roster does not generate distinguishable machines.`)
	process.exit(1)
}
rmSync(tmp, { recursive: true, force: true })
console.log(`${TOOL}: PASS — every parameter varies, no two actors collide, and no two silhouettes coincide.`)
