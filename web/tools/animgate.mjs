#!/usr/bin/env node
// STEELSEED — tools/animgate
//
// `anim` owns the one thing `units` is forbidden to keep: how far each actor has travelled.
// Every articulation still to be built — wheel spin, track scroll, infantry gait — is that
// integral divided by some per-actor geometry, so if this number is wrong every one of them is
// wrong in the same way, and wrong SMOOTHLY, which is the hardest kind to notice.
//
// It is checked against ground truth rather than against itself: the moving fixture drives a
// tracked column at a known constant speed, so the distance this node reports must equal the
// signed axial travel the simulation gave the actor — the displacement projected onto the body
// facing, reverse motion subtracting (anim's documented contract, the one wheel spin needs) —
// summed tick by tick. The truth below mirrors that projection on purpose: the projection
// FORMULA is the contract under test, while per-tick booking, id matching, tick dedup and the
// teleport guard stay independently exercised, and both falsifiers must still fail.
// The predecessor of that mirror read raw chord length (hypot) instead; wangle quantisation
// makes the axial projection a hair shorter than the chord on every turning actor, and the
// accumulated shortfall (~5e-4 m per minute-long run) failed the 1e-4 tolerance — a stale
// ground-truth formula, not drift in the sim.
//
// Usage:
//   node --experimental-strip-types tools/animgate.mjs [--ticks n] [--falsify=noprev|teleport]

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'

const TOOL = 'animgate'
const WEB = resolve(fileURLToPath(new URL('..', import.meta.url)))
const arg = n => {
	const hit = process.argv.find(a => a.startsWith(`--${n}=`))
	return hit ? hit.slice(n.length + 3) : null
}
const ticks = Number(arg('ticks') ?? 60)
const falsify = arg('falsify')
if (falsify !== null && falsify !== 'noprev' && falsify !== 'teleport') {
	console.error(`${TOOL}: unknown --falsify=${falsify}`)
	process.exit(2)
}

const tmp = mkdtempSync(join(tmpdir(), 'animgate-'))
const entry = join(tmp, 'entry.ts')
writeFileSync(entry, `
export { Anim } from '${WEB}/src/anim/index'
export { buildDevSnapshotAt, SnapshotDecoder, wangleToRadians } from '${WEB}/src/core/index'
`)
const bundle = join(tmp, 'b.mjs')
await esbuild({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', outfile: bundle, logLevel: 'silent' })
const { Anim, buildDevSnapshotAt, SnapshotDecoder, wangleToRadians } = await import(bundle)

const WPOS_TO_M = 1 / 1024
const anim = new Anim()
// One decoder per side: the decoder aliases its own buffer, so decoding `curr` through the
// same instance would overwrite the `prev` a consumer is still reading. That aliasing is the
// documented shape of the real path and reproducing it here is the point.
const decA = new SnapshotDecoder()
const decB = new SnapshotDecoder()

const problems = []
let prev = null
/** Ground truth, integrated straight off the decoded positions and facings. */
const truth = new Map()
let maxErr = 0
let movedActors = 0

for (let t = 0; t < ticks; t++) {
	const buf = new Uint8Array(buildDevSnapshotAt(t, { width: 96, height: 96, seed: 'devmap' }))
	const snap = (t % 2 === 0 ? decA : decB).decode(buf)
	if (falsify === 'teleport' && prev !== null && snap.actors) {
		// Shove every actor a kilometre sideways for one tick. A teleport is not travel, and
		// the guard must refuse to integrate it.
		for (let i = 0; i < snap.actors.count; i++) snap.actors.posX[i] += 1024 * 1000
	}
	anim.onSnapshot(snap, falsify === 'noprev' ? null : prev, null)

	if (prev !== null && snap.actors && prev.actors) {
		const a = snap.actors, b = prev.actors
		for (let i = 0; i < a.count; i++) {
			const id = a.id[i]
			let j = -1
			for (let k = 0; k < b.count; k++) if (b.id[k] === id) { j = k; break }
			if (j < 0) { truth.set(id, 0); continue }
			const dx = (a.posX[i] - b.posX[j]) * WPOS_TO_M
			const dz = (a.posY[i] - b.posY[j]) * WPOS_TO_M
			const step = Math.hypot(dx, dz)
			// The signed axial projection at the step's average facing: `anim` credits reverse
			// travel as negative and splits a mid-step turn evenly between the two facings, so
			// truth must read the same quantity or every turning actor "drifts" by the
			// wangle-quantisation shortfall between chord and projection.
			const yaw = wangleToRadians(a.facing[i])
			const prevYaw = wangleToRadians(b.facing[j])
			const turn = Math.atan2(Math.sin(yaw - prevYaw), Math.cos(yaw - prevYaw))
			const midYaw = prevYaw + turn * 0.5
			const signed = dx * Math.cos(midYaw) - dz * Math.sin(midYaw)
			// Ground truth applies the same teleport guard as `anim` — EXCEPT under
			// --falsify=teleport, where it deliberately does not. That asymmetry is what makes
			// the control a real control: with the guard mirrored on both sides, injecting a
			// teleport made both reject it identically and the falsifier passed, testing
			// nothing. Comparing guarded against UNGUARDED truth proves the guard fires.
			const guarded = falsify === 'teleport' ? signed : (step > 8 ? 0 : signed)
			truth.set(id, (truth.get(id) ?? 0) + guarded)
		}
	}
	prev = snap
}

for (const [id, want] of truth) {
	const got = anim.distanceOf(id)
	const err = Math.abs(got - want)
	if (err > maxErr) maxErr = err
	if (want > 0.5) movedActors++
	if (err > 1e-4)
		problems.push(`actor ${id}: anim reports ${got.toFixed(6)} m, ground truth ${want.toFixed(6)} m`)
}

if (movedActors === 0)
	problems.push('no actor travelled more than 0.5 m — the fixture is not moving, so this gate measured nothing')

const total = [...truth.values()].reduce((a, b) => a + b, 0)
console.log(
	`${TOOL}: ${ticks} ticks, ${truth.size} actors tracked (${anim.trackedCount} in anim), ` +
	`${movedActors} moved; total travel ${total.toFixed(3)} m; max error ${maxErr.toExponential(2)} m`,
)

if (problems.length > 0) {
	for (const p of problems.slice(0, 12)) console.error(`  ${p}`)
	if (problems.length > 12) console.error(`  … ${problems.length - 12} more`)
	console.error(`${TOOL}: FAIL — the travel integral does not match the simulation.`)
	process.exit(1)
}
console.log(`${TOOL}: PASS — every actor's travel integral matches the simulation exactly.`)
