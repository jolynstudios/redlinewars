#!/usr/bin/env node
// Compare immutable composed bundles on the SAME physical GPU, sequentially. Every
// run must pass cadencegate's existing absolute limits. Three predetermined
// pairs, alternating order, avoid selecting a favourable sample after a fail.
//
// The decision is delivered frame rate over the same fixed window, not p95. On
// the 120 Hz qualification display every rAF interval is one or two refreshes
// (8.3 or 16.7 ms) and p95 lands on that boundary: the unchanged reference alone
// moved 9.4 -> 15.4 ms, and "median p95 may not increase" rejected identical
// bundles most of the time (stage/live-release, 1 October 2026). Delivered fps
// counts every missed refresh and moves about 1-2 % between identical runs.
// A profile fails when the candidate's median fps is more than FPS_MARGIN below
// the reference's. The margin only counts after calibration on the same machine:
// the reference against itself must pass (--calibration=aa), and the reference
// with an injected per-frame cost must fail (--calibration=positive).
// Timing runs on the physical Mac only; virtual CI GPUs shed resolution.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeDigest } from './appbundle-digest.mjs'

export const FPS_MARGIN = 0.02
const median = xs => [...xs].sort((a, b) => a - b)[1]
const profiles = [['dynamic', 'True'], ['dynamic', 'False'], ['high', 'True'], ['high', 'False']]
function validateWorkload(result, reference, frameDelayMs = 0, dropEvery = 0) {
	assert.equal(result?.pass, true, 'Absolute cadence gate failed')
	assert.equal(result.arms.length, 4)
	for (const [index, [quality, fog]] of profiles.entries()) {
		const arm = result.arms[index], same = reference.arms[index]
		assert.equal(arm.quality, quality); assert.equal(arm.fog, fog)
		assert.equal(arm.map, 'Marigold Town'); assert.equal(arm.scale, 1)
		assert.equal(arm.fallback, 0); assert.ok(arm.loaded > 0)
		assert.equal(arm.loaded, same.loaded)
		assert.equal(arm.measuredMs, 4000); assert.equal(arm.discardMs, 200)
		assert.equal(arm.preheatMs, 40000, 'Same fixed renderer preheat required')
		assert.equal(arm.warmupMs, 5000, 'Same fresh-match warm-up required')
		assert.equal(arm.restart?.randomSeed, 104729, 'Same native starting seed required')
		assert.ok(arm.restart.previousTick >= 900 && arm.restart.restartTick < 100 && arm.restart.restartTick < arm.restart.previousTick, 'Preheat world must be replaced by a fresh native world')
		assert.equal(arm.audioReady, true, 'First-gesture audio work is not steady-state gameplay')
		assert.equal(arm.actors, same.actors, 'Actor workload must match')
		assert.equal(arm.actors, fog === 'True' ? 11 : 217, 'Native starting-army workload required')
		assert.deepEqual(arm.canvas, [3024, 1964], 'Full-resolution DPR-2 workload required')
		assert.deepEqual(arm.qualityState, same.qualityState, 'Actual render settings must match')
		assert.ok(arm.qualityState && Object.keys(arm.qualityState).length === 9, 'Missing actual render settings')
		for (const field of ['cameraStart', 'cameraEnd']) {
			assert.equal(arm[field]?.length, 3, 'Missing camera trajectory')
			for (let axis = 0; axis < 3; axis++) {
				assert.ok(Number.isFinite(arm[field][axis]))
				assert.ok(Math.abs(arm[field][axis] - same[field][axis]) <= 0.5, 'Camera trajectory must match within 0.5 metres')
			}
		}
		assert.ok(Number.isFinite(arm.p95) && arm.p95 > 0)
		assert.ok(arm.p50 <= 16.7 && arm.worst <= 50)
		assert.ok(Number.isInteger(arm.frames) && arm.frames >= 80, 'Missing delivered frame count')
		assert.ok(Number.isFinite(arm.fps) && arm.fps > 0, 'Missing delivered frame rate')
		assert.equal(arm.injectedFrameDelayMs, frameDelayMs, frameDelayMs ? 'Calibration delay missing' : 'Injected frame delay is calibration only')
		assert.equal(arm.injectedDropEvery ?? 0, dropEvery, dropEvery ? 'Calibration frame drops missing' : 'Injected frame drops are calibration only')
		if (dropEvery) assert.ok(arm.realizedDroppedFrames >= 8, 'Calibration did not skip enough display frames')
	}
}

export function evaluateCadence(runs, { frameDelayMs = 0, dropEvery = 0 } = {}) {
	assert.equal(runs.length, 3, 'Exactly three predefined pairs required')
	for (const run of runs) for (const side of ['before', 'after']) validateWorkload(run[side], runs[0].before, side === 'after' ? frameDelayMs : 0, side === 'after' ? dropEvery : 0)
	return profiles.map(([quality, fog], index) => {
		const pick = (side, field) => runs.map(run => run[side].arms[index][field])
		const before = median(pick('before', 'fps')), after = median(pick('after', 'fps'))
		const change = after / before - 1
		return {
			quality, fog, beforeFps: pick('before', 'fps'), afterFps: pick('after', 'fps'), beforeMedianFps: before, afterMedianFps: after,
			changePercent: +(100 * change).toFixed(2), regressed: change < -FPS_MARGIN,
			beforeFrames: pick('before', 'frames'), afterFrames: pick('after', 'frames'),
			beforeMissedRefreshes: pick('before', 'missedRefreshes'), afterMissedRefreshes: pick('after', 'missedRefreshes'),
			beforeP95: pick('before', 'p95'), afterP95: pick('after', 'p95'),
		}
	})
}

export function compareCadence(runs, options) {
	const rows = evaluateCadence(runs, options)
	const failed = rows.filter(row => row.regressed)
	assert.equal(failed.length, 0, failed.map(row => `${row.quality} fog ${row.fog}: median delivered frame rate fell ${row.beforeMedianFps} -> ${row.afterMedianFps} fps (${row.changePercent} %, limit -${100 * FPS_MARGIN} %)`).join('; '))
	return rows
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
	const before = option('before'), after = option('after'), out = resolve(option('out') ?? 'stage/cadence-comparison')
	const headed = process.argv.includes('--headed')
	const calibration = option('calibration') ?? null
	const frameDelayMs = Number(option('calibration-frame-delay-ms') ?? 0)
	const dropEvery = Number(option('calibration-drop-every') ?? 0)
	assert.ok(before && after, 'Supply --before=URL and --after=URL for the immutable bundles')
	assert.ok(option('before-root') && option('after-root'), 'Supply --before-root and --after-root: the served AppBundle directories')
	assert.ok([null, 'aa', 'positive'].includes(calibration), 'Calibration is aa or positive')
	assert.ok(!(frameDelayMs && dropEvery), 'Use only one calibration stimulus')
	assert.equal(frameDelayMs > 0 || dropEvery > 0, calibration === 'positive', 'Only the positive calibration injects a stimulus, and it must')
	mkdirSync(out, { recursive: true })
	const bundles = { before: runtimeDigest(resolve(option('before-root'))), after: runtimeDigest(resolve(option('after-root'))) }
	if (calibration) assert.deepEqual(bundles.after, bundles.before, 'Calibration compares the reference with itself')
	const runs = []
	const report = {
		pass: false, before, after, headed, repeats: 3, bundles,
		policy: `Every absolute gate passes; median delivered fps may not fall more than ${100 * FPS_MARGIN} % on any profile`,
		calibration: calibration && { kind: calibration, frameDelayMs, dropEvery, expectation: calibration === 'aa' ? 'comparison passes' : 'comparison fails on delivered fps' },
		runs,
	}
	try {
		for (let iteration = 0; iteration < 3; iteration++) {
			const run = {}; runs.push(run)
			for (const side of iteration % 2 ? ['after', 'before'] : ['before', 'after']) {
				const delay = side === 'after' && frameDelayMs > 0 ? [`--calibration-frame-delay-ms=${frameDelayMs}`] : []
				const drop = side === 'after' && dropEvery > 0 ? [`--calibration-drop-every=${dropEvery}`] : []
				const result = spawnSync(process.execPath, [fileURLToPath(new URL('./cadencegate.mjs', import.meta.url)), ...(headed ? ['--headed'] : []), ...delay, ...drop, `--details=${resolve(out, `${iteration + 1}-${side}-samples.json`)}`, `--diagnostics=${resolve(out, `${iteration + 1}-${side}-diagnostics.json`)}`], {
					env: { ...process.env, STEELSEED_URL: side === 'before' ? before : after },
					encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 600000,
				})
				writeFileSync(resolve(out, `${iteration + 1}-${side}.log`), result.stdout + result.stderr)
				assert.equal(result.status, 0, `${iteration + 1}-${side}: absolute cadence gate failed; see saved log`)
				const line = result.stdout.split('\n').find(value => value.startsWith('{"pass":true'))
				assert.ok(line, 'Missing native game cadence report')
				run[side] = JSON.parse(line)
				validateWorkload(run[side], runs[0].before, delay.length ? frameDelayMs : 0, drop.length ? dropEvery : 0)
				console.log(`pair ${iteration + 1} ${side} passed`)
			}
		}
		report.profiles = evaluateCadence(runs, { frameDelayMs, dropEvery })
		report.comparisonPass = !report.profiles.some(row => row.regressed)
		report.pass = calibration === 'positive' ? !report.comparisonPass : report.comparisonPass
		if (!report.comparisonPass) report.error = report.profiles.filter(row => row.regressed).map(row => `${row.quality} fog ${row.fog}: median delivered frame rate fell ${row.beforeMedianFps} -> ${row.afterMedianFps} fps (${row.changePercent} %)`).join('; ')
		if (!report.pass) { process.exitCode = 1; console.error(report.error ?? 'Positive calibration was not detected') }
		console.log(JSON.stringify({ pass: report.pass, comparisonPass: report.comparisonPass, calibration: report.calibration, profiles: report.profiles }))
	} catch (error) {
		report.error = error.message; process.exitCode = 1; console.error(error.message)
	} finally { writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n') }
}
