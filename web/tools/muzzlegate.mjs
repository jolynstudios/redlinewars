#!/usr/bin/env node
// STEELSEED — tools/muzzlegate
//
// Does the shot come out of the MACHINE, or out of the air beside it?
//
// `params.ts` called `muzzleM` "the single most load-bearing number in this file", said "the
// barrel is built so its tip lands exactly there", said "`fx` reads the same field for the
// muzzle flash", and signed off "Gated in `rostergate`". `tracked.ts` repeated it: "see the
// parity check in `rostergate`."
//
// THERE IS NO SUCH CHECK, AND NO GENERATOR HAS EVER READ `muzzleM`. Both comments describe a
// design that was never built, confidently enough that anyone auditing the area would have
// skipped it. `muzzleM` is the fifth piece of authored per-actor truth found with no consumer,
// after TargetsAir, the HitShape polygons, Warhead Versus and the shroud.
//
// It stops being cosmetic the moment `fx` lands. THE SIMULATION ALREADY SPAWNS PROJECTILES AT
// THIS POINT, so the flash, the tracer origin and the shot all come from here.
//
// WHAT THIS GATE ASSERTS, AND WHY IT IS NOT WHAT IT FIRST ASSERTED.
//
// The first version of this file demanded the barrel TIP land on the authored point, taking
// `params.ts` at its word. That target is wrong, and the roster disproves it outright:
// FOURTEEN OF TWENTY-FOUR vehicle muzzles are authored BEHIND their own hull nose —
// foundry_bollard's sits 40 cm inside a 2 m hull. A forward-firing gun cannot end there.
// `Armament.LocalOffset` in this mod is the projectile SPAWN POINT near the mount, not the
// visual barrel tip, and a gate built on the other reading would have driven every generator
// to shorten its gun until the tip was buried in the hull.
//
// So the assertion is the one that survives either reading and is the actual visible defect:
// THE AUTHORED MUZZLE MUST LIE ON OR INSIDE THE ACTOR'S GEOMETRY. A point inside the mount is
// a spawn point doing its job; a point in open air is a flash hanging off the side of the
// machine and a shot leaving from nothing. Depth inside is therefore NOT penalised — only
// protrusion into empty space is.
//
// Measured today: 51 of 71 armed actors fire from open air, including ALL TWELVE wheeled
// vehicles and ALL SIXTEEN infantry. Worst is lattice_phase at 61.6 cm.
//
// THE FRAME WAS VERIFIED AGAINST THE ENGINE, NOT ASSUMED. `Armament.CalculateMuzzleOffset`
// says in as many words "Weapon offset in turret coordinates", and composes
// `LocalOffset.Rotate(turret) + turret.Offset`, subtracting Recoil along +X so recoil pulls
// BACK. At rest, in model space, the muzzle is `muzzleM + turret.offsetM`. An earlier pass
// measured 25 actors against the actor-relative reading; acting on it would have been the same
// class of error as the plan-polygon axis, which this project has already paid for once.
//
// THIS GATE IS A RATCHET AND IT SAYS SO. Today's roster cannot meet the real target, and a
// gate that fails on landing helps nobody while a gate quietly thresholded at 62 cm and
// printing PASS would be worse. The default asserts the CURRENT worst per family, so the debt
// cannot grow; every run prints how many actors actually fire from solid machine; `--strict`
// asserts the real target and fails until the generators consume the field.
//
// RATCHET_M may only ever go down.
//
// Usage:
//   node tools/muzzlegate.mjs [--strict] [--falsify=drift]

import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'

const TOOL = 'muzzlegate'
const WEB = resolve(fileURLToPath(new URL('..', import.meta.url)))
const argv = process.argv.slice(2)
const strict = argv.includes('--strict')
const falsify = (argv.find(a => a.startsWith('--falsify=')) ?? '').slice(10) || null
if (falsify !== null && falsify !== 'drift') {
	console.error(`${TOOL}: unknown --falsify=${falsify}`)
	process.exit(2)
}

/**
 * The real goal: the authored muzzle is on or inside the machine.
 *
 * Not exactly zero. Surface nets reconstructs a surface from a grid, and a point authored
 * exactly on the mathematical surface can land a few millimetres outside the meshed one. Two
 * centimetres is well inside a mesher cell and far below anything visible.
 */
const TARGET_M = 0.02

/**
 * Current measured worst PROTRUSION per family, rounded up to the centimetre. DEBT, not design.
 * Lower these as generators start consuming `muzzleM`; never raise one.
 */
const RATCHET_M = {
	// PAID OFF 2026-08-06. These five families now put a weapon mount at the authored point and
	// meet the real target, so their ratchet IS the target — any regression fails immediately.
	0: TARGET_M, // tracked      — was 0.34, 11 of 12 firing from open air
	1: TARGET_M, // wheeled      — was 0.62, 12 of 12
	3: TARGET_M, // rotorcraft   — was 0.19,  4 of 10
	5: TARGET_M, // vessel       — was 0.16,  3 of 11
	7: TARGET_M, // emplacement  — was 0.10,  2 of 10
	2: TARGET_M, // infantry     — was 0.62, 16 of 16, cleared by correcting the 4x stature
	// Family 4 did not exist when this table was written: `Family.fixedwing` was defined and
	// never assigned until a4539c3, so all ten aircraft were judged as rotorcraft. Adding the
	// family made this gate FAIL CORRECTLY — "an unmeasured family is not a passing one" — and
	// it stayed red for several commits because I split the family and did not re-run this.
	// Both aircraft families come out of `buildAircraft`, so it meets the same target.
	4: TARGET_M, // fixedwing
}
const FAMILY_NAME = {
	0: 'tracked', 1: 'wheeled', 2: 'infantry', 3: 'rotorcraft',
	4: 'fixedwing', 5: 'vessel', 6: 'plant', 7: 'emplacement',
}

const tmp = mkdtempSync(join(tmpdir(), 'muzzlegate-'))
const bundlePath = join(tmp, 'archetype.mjs')
await esbuild({
	entryPoints: [resolve(WEB, 'src/units/archetype/index.gate.ts')],
	bundle: true, format: 'esm', platform: 'neutral', outfile: bundlePath, logLevel: 'silent',
})
const A = await import(bundlePath)
const { deriveChassis, Family, evalSdf } = A
const GEN = {
	[Family.tracked]: A.buildTrackedVehicle,
	[Family.wheeled]: A.buildWheeledVehicle,
	[Family.infantry]: A.buildInfantryFigure,
	[Family.rotorcraft]: A.buildAircraft,
	[Family.fixedwing]: A.buildAircraft,
	[Family.vessel]: A.buildVessel,
	[Family.plant]: A.buildPlantStructure,
	[Family.emplacement]: A.buildEmplacement,
}

const doc = JSON.parse(readFileSync(resolve(WEB, 'src/units/archetype/roster.json'), 'utf8'))
const slots = doc.slots ?? doc

// Fixed rng: this measures the DESIGN. A seeded per-instance jitter (§9.2) must not be able to
// move a parity result, or the instrument is reporting noise.
const rng = () => ({ next: () => 0.5 })

const rows = []
for (const s of slots) {
	if (!s.armaments?.length) continue
	const gen = GEN[s.family]
	if (gen === undefined) continue
	const p = deriveChassis(s)
	const tree = gen(p, rng())

	const m = s.armaments[0].muzzleM
	const t = s.turret ? s.turret.offsetM : [0, 0, 0]
	// --falsify=drift pushes the authored point a quarter metre forward with the geometry
	// untouched. A gate that still passes is not reading the muzzle at all.
	const bump = falsify === 'drift' ? 0.25 : 0
	// Signed distance AT the authored point. Negative is inside the machine and is FINE.
	// Positive is the defect: the shot leaves from open air.
	const d = evalSdf(tree, m[0] + t[0] + bump, m[1] + t[1], m[2] + t[2])
	rows.push({ name: s.name, family: s.family, d })
}

if (rows.length === 0) {
	console.error(`${TOOL}: no armed actor produced geometry — nothing was measured, which is not a pass.`)
	process.exit(2)
}

const problems = []
const byFamily = new Map()
for (const r of rows) {
	if (!byFamily.has(r.family)) byFamily.set(r.family, [])
	byFamily.get(r.family).push(r)
}

const floating = rows.filter(r => r.d > TARGET_M).length
console.log(`${TOOL}: ${rows.length} armed actors, ${strict ? `--strict against the ${TARGET_M * 100} cm target` : 'ratchet mode'}${falsify !== null ? ` (--falsify=${falsify})` : ''}`)
for (const [fam, list] of [...byFamily].sort((a, b) => a[0] - b[0])) {
	list.sort((a, b) => a.d - b.d)
	const limit = strict ? TARGET_M : RATCHET_M[fam]
	if (limit === undefined) {
		problems.push(`family ${fam} (${FAMILY_NAME[fam] ?? '?'}) has ${list.length} armed actor(s) and no RATCHET_M entry — an unmeasured family is not a passing one.`)
		continue
	}
	const worst = list[list.length - 1]
	const air = list.filter(r => r.d > TARGET_M)
	const over = list.filter(r => r.d > limit)
	console.log(
		`  family ${fam} ${(FAMILY_NAME[fam] ?? '?').padEnd(12)} n=${String(list.length).padStart(2)}` +
		`  firing from air ${String(air.length).padStart(2)}` +
		`  worst protrusion ${Math.max(worst.d, 0).toFixed(4)}${worst.d > 0 ? ` (${worst.name})` : ''}` +
		`  limit ${limit.toFixed(4)}${over.length > 0 ? `  ${over.length} OVER` : ''}`,
	)
	for (const r of over) {
		problems.push(
			`${r.name}: the authored muzzle is ${(r.d * 100).toFixed(1)} cm OUTSIDE the actor's geometry ` +
			`(limit ${(limit * 100).toFixed(1)} cm). The simulation spawns the projectile there, so the shot ` +
			'and its flash leave from open air beside the machine.',
		)
	}
}
console.log(`  overall  ${rows.length - floating}/${rows.length} fire from solid machine; ${floating} from open air`)

if (problems.length > 0) {
	for (const p of problems) console.error(`  ${p}`)
	if (strict) {
		console.error(`${TOOL}: FAIL (--strict) — the REAL target, expected to fail until the generators consume \`muzzleM\`. Not a regression.`)
	} else {
		console.error(`${TOOL}: FAIL — muzzle parity got WORSE than the recorded debt. Ratchets only tighten.`)
	}
	process.exit(1)
}
if (strict) {
	console.log(`${TOOL}: PASS (--strict) — every shot leaves from solid machine. Collapse RATCHET_M to ${TARGET_M} and delete this mode's excuse.`)
} else {
	console.log(`${TOOL}: PASS against recorded debt — no actor's muzzle has drifted further into the air than it already was.`)
}
