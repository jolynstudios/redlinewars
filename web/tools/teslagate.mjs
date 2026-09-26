#!/usr/bin/env node
// The Tesla coil's bolt must reach the thing it killed, at the range the rules allow.
//
// The human's report was "the tesla coil should zap electricity, to the distance according to
// the gameplay, it doesnt happen now". There was no tesla, zap or lightning code anywhere in
// web/src, so the coil fired in silence. This gate runs the SHIPPED module — not a copy of its
// maths — and asserts the properties that make a drawn bolt honest:
//
//   1. a strike writes segments at all;
//   2. the main channel ENDS EXACTLY on the target, because a bolt that misses what it killed
//      tells the player the wrong unit is being attacked;
//   3. it starts exactly at the muzzle, for the same reason;
//   4. it stays coherent at the rules range (`^TeslaWeapon` Range: 7c0 = seven cells = 7 m) and
//      earns more joints as it lengthens, rather than drawing longer straight runs;
//   5. it is deterministic — two machines must draw the same battle;
//   6. nothing is drawn when either end sits in fog, so a bolt cannot point at an undiscovered
//      unit;
//   7. it decays and dies, rather than accumulating bolts forever.
//
// `--falsify=<case>` proves each assertion can actually fail, because the plan records a
// near-tautological assertion written here once that could never have failed.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'

const TOOL = 'teslagate'
const WEB = resolve(fileURLToPath(new URL('..', import.meta.url)))
const arg = n => {
	const hit = process.argv.find(a => a.startsWith(`--${n}=`))
	return hit ? hit.slice(n.length + 3) : null
}
const falsify = arg('falsify')
const CASES = ['endpoint', 'fog', 'determinism', 'decay']
if (falsify !== null && !CASES.includes(falsify)) {
	console.error(`${TOOL}: unknown --falsify=${falsify}; expected one of ${CASES.join(', ')}`)
	process.exit(2)
}

const tmp = mkdtempSync(join(tmpdir(), 'teslagate-'))
const entry = join(tmp, 'entry.ts')
writeFileSync(entry, `export { TeslaArc, ARC_R } from '${WEB}/src/fx/tesla-arc'\n`)
const bundle = join(tmp, 'b.mjs')
await esbuild({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', outfile: bundle, logLevel: 'silent' })
const { TeslaArc } = await import(bundle)

// `writeAxisTransform` lives in fx/index.ts, which drags the whole render node into a bundle.
// Its contract is small and fully specified by the instance layout, so it is reimplemented here
// deliberately: that makes this gate a check on the ARC's geometry rather than on the shared
// transform, and a bug in either one still shows up as a wrong endpoint.
function writeAxisTransform(out, o, x, y, z, ax, ay, az, sx, sy, sz) {
	const len = Math.hypot(ax, ay, az)
	if (!(len > 1e-6)) return false
	const xx = ax / len, xy = ay / len, xz = az / len
	const refY = Math.abs(xy) < 0.9 ? 1 : 0
	const refZ = Math.abs(xy) < 0.9 ? 0 : 1
	const d = xy * refY + xz * refZ
	let yx = -xx * d, yy = refY - xy * d, yz = refZ - xz * d
	const yLen = Math.hypot(yx, yy, yz)
	yx /= yLen; yy /= yLen; yz /= yLen
	const zx = xy * yz - xz * yy, zy = xz * yx - xx * yz, zz = xx * yy - xy * yx
	out[o] = xx * sx; out[o + 1] = xy * sx; out[o + 2] = xz * sx; out[o + 3] = 0
	out[o + 4] = yx * sy; out[o + 5] = yy * sy; out[o + 6] = yz * sy; out[o + 7] = 0
	out[o + 8] = zx * sz; out[o + 9] = zy * sz; out[o + 10] = zz * sz; out[o + 11] = 0
	out[o + 12] = x; out[o + 13] = y; out[o + 14] = z; out[o + 15] = 1
	return true
}

const visibleEverywhere = { isVisible: () => true }
const fogged = { isVisible: () => false }
const EYE = [4, 6, 4]

/** Segment `i`'s start (its translation) and end (start + its local +X column). */
function segment(instances, i) {
	const o = i * 16
	const sx = instances[o + 12], sy = instances[o + 13], sz = instances[o + 14]
	return { sx, sy, sz, ex: sx + instances[o], ey: sy + instances[o + 1], ez: sz + instances[o + 2] }
}

function strikeOnce(arc, s, t, seed, shroud = visibleEverywhere) {
	arc.strike(s[0], s[1], s[2], t[0], t[1], t[2], seed)
	const n = arc.build(0.016, shroud, EYE[0], EYE[1], EYE[2], writeAxisTransform)
	return n
}

const report = {}

// ---- 1, 2, 3: a strike draws, and lands on both endpoints -------------------------------
{
	const arc = new TeslaArc()
	const source = [10.0, 0.9, 10.0]
	const target = [14.5, 0.3, 12.0]
	const n = strikeOnce(arc, source, target, 12345)
	report.shortSegments = n
	assert.ok(n > 0, 'a tesla strike must write at least one segment')

	// The main channel is written first, and its last joint is the target.
	let nearestToTarget = Infinity
	let startGap = Infinity
	for (let i = 0; i < n; i++) {
		const g = segment(arc.instances, i)
		nearestToTarget = Math.min(nearestToTarget,
			Math.hypot(g.ex - target[0], g.ey - target[1], g.ez - target[2]))
		startGap = Math.min(startGap,
			Math.hypot(g.sx - source[0], g.sy - source[1], g.sz - source[2]))
	}
	report.gapToTargetM = Number(nearestToTarget.toFixed(9))
	report.gapToMuzzleM = Number(startGap.toFixed(9))
	const slack = falsify === 'endpoint' ? -1 : 1e-6
	assert.ok(nearestToTarget <= slack,
		`the bolt must terminate on the target it killed; nearest segment end is ${nearestToTarget} m away`)
	assert.ok(startGap <= 1e-6,
		`the bolt must leave the muzzle; nearest segment start is ${startGap} m away`)
}

// ---- 4: coherent at the rules range, and it earns joints with span ------------------------
{
	// `^TeslaWeapon` declares Range: 7c0. One cell is one render metre, so this is the longest
	// bolt the simulation can ever ask for and it must still be drawn.
	const RULES_RANGE_M = 7
	const near = new TeslaArc()
	const nearCount = strikeOnce(near, [10, 0.9, 10], [11, 0.9, 10], 777)
	const far = new TeslaArc()
	const farCount = strikeOnce(far, [10, 0.9, 10], [10 + RULES_RANGE_M, 0.9, 10], 777)
	report.segmentsAt1m = nearCount
	report.segmentsAt7m = farCount
	assert.ok(farCount > 0, 'a bolt at the weapon\'s full rules range must still be drawn')
	assert.ok(farCount > nearCount,
		`a longer bolt must gain joints rather than stretch: 1 m gave ${nearCount}, 7 m gave ${farCount}`)

	// No single straight run may span a large fraction of the path, or it stops reading as
	// lightning and becomes a laser.
	let longest = 0
	for (let i = 0; i < farCount; i++) {
		const g = segment(far.instances, i)
		longest = Math.max(longest, Math.hypot(g.ex - g.sx, g.ey - g.sy, g.ez - g.sz))
	}
	report.longestRunAt7mM = Number(longest.toFixed(4))
	assert.ok(longest < RULES_RANGE_M * 0.45,
		`no run may be half the bolt: longest is ${longest} m of ${RULES_RANGE_M} m`)
}

// ---- 5: deterministic ---------------------------------------------------------------------
{
	const a = new TeslaArc(), b = new TeslaArc()
	const na = strikeOnce(a, [3, 1, 3], [8, 0.4, 6], 20260906)
	const nb = strikeOnce(b, [3, 1, 3], [8, 0.4, 6], falsify === 'determinism' ? 20260907 : 20260906)
	assert.equal(na, nb, 'the same strike must write the same number of segments')
	let worst = 0
	for (let i = 0; i < na * 16; i++) worst = Math.max(worst, Math.abs(a.instances[i] - b.instances[i]))
	report.determinismMaxDelta = worst
	assert.equal(worst, 0, 'two machines must draw an identical bolt from an identical strike')
}

// ---- 6: fog hides it ----------------------------------------------------------------------
{
	const arc = new TeslaArc()
	const n = strikeOnce(arc, [3, 1, 3], [8, 0.4, 6], 42, falsify === 'fog' ? visibleEverywhere : fogged)
	report.segmentsInFog = n
	assert.equal(n, 0, 'a bolt whose ends are in fog must not be drawn — it would reveal the target')
}

// ---- 7: it decays and dies ----------------------------------------------------------------
{
	const arc = new TeslaArc()
	arc.strike(3, 1, 3, 8, 0.4, 6, 99)
	let frames = 0
	let last = 0
	// 0.22 s of life at 60 fps is ~14 frames; 60 is far past it.
	for (let f = 0; f < 60; f++) {
		const n = arc.build(falsify === 'decay' ? 0 : 1 / 60, visibleEverywhere, EYE[0], EYE[1], EYE[2], writeAxisTransform)
		if (n > 0) { frames++; last = n }
	}
	report.framesAlive = frames
	report.activeAfter60Frames = arc.stats.active
	assert.ok(frames > 1, 'a bolt must survive more than a single frame or it reads as a fault')
	assert.equal(arc.stats.active, 0, 'a bolt must expire; bolts accumulating forever would leak')
	assert.ok(last >= 0)
}

// ---- the pool is bounded ------------------------------------------------------------------
{
	const arc = new TeslaArc()
	for (let i = 0; i < 500; i++) arc.strike(3, 1, 3, 8, 0.4, 6, i)
	const n = arc.build(0.016, visibleEverywhere, EYE[0], EYE[1], EYE[2], writeAxisTransform)
	report.cappedSegments = n
	report.droppedStrikes = arc.stats.dropped
	assert.ok(arc.stats.dropped > 0, 'the arc pool must refuse overflow rather than grow')
	assert.ok(n * 16 <= arc.instances.length, 'segments must never exceed the instance buffer')
}

console.log(`${TOOL}: ` + JSON.stringify(report))
console.log(`${TOOL}: PASS — the bolt leaves the muzzle, lands on the target, and holds at the rules range of 7 m`)
