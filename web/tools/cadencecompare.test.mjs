import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareCadence, evaluateCadence } from './cadencecomparegate.mjs'
const fixture = () => Array.from({ length: 3 }, () => Object.fromEntries(['before', 'after'].map(side => [side, {
	pass: true, arms: [['dynamic', 'True'], ['dynamic', 'False'], ['high', 'True'], ['high', 'False']].map(([quality, fog]) => ({
		quality, fog, map: 'Marigold Town', p50: 8.3, p95: 16.7, worst: 25, loaded: 278, fallback: 0, scale: 1,
		frames: fog === 'True' ? 456 : 384, fps: fog === 'True' ? 114 : 96, missedRefreshes: fog === 'True' ? 24 : 96, injectedFrameDelayMs: 0,
		restart: { previousTick: 1018, restartTick: 2, randomSeed: 104729 },
		actors: fog === 'True' ? 11 : 217, measuredMs: 4000, discardMs: 200, preheatMs: 40000, warmupMs: 5000, canvas: [3024, 1964], audioReady: true,
		qualityState: { tier: 'high', choice: quality, nearField: false, windGrass: false, weatherFx: true, cascades: 4, contact: false, sceneryStep: 1, renderScale: 1 },
		cameraStart: [70, 23, 0], cameraEnd: [25, 23, -20],
	})),
}])))
test('identical bundles pass even when p95 jumps between one and two display refreshes', () => {
	assert.equal(compareCadence(fixture()).length, 4)
	// Observed for the unchanged reference on 1 October: 9.4 / 15.4 / 15.0 ms.
	const runs = fixture()
	runs[0].before.arms[0].p95 = 9.4; runs[1].before.arms[0].p95 = 15.4; runs[2].before.arms[0].p95 = 15
	runs[0].after.arms[0].p95 = 16; runs[1].after.arms[0].p95 = 15.2; runs[2].after.arms[0].p95 = 15.6
	assert.equal(compareCadence(runs)[0].regressed, false)
})
test('median delivered fps may fall at most two percent on any profile', () => {
	const within = fixture()
	for (const run of within) run.after.arms[1].fps = 96 * 0.981
	assert.equal(compareCadence(within)[1].changePercent, -1.9)
	const regressed = fixture()
	for (const run of regressed) run.after.arms[3].fps = 96 * 0.979
	assert.throws(() => compareCadence(regressed), /high fog False: median delivered frame rate fell 96 -> 93.984 fps \(-2.1 %, limit -2 %\)/)
	// One slow run among three does not move the median; two do.
	const single = fixture(); single[1].after.arms[0].fps = 100
	assert.equal(compareCadence(single)[0].regressed, false)
	const double = fixture(); double[0].after.arms[0].fps = 100; double[2].after.arms[0].fps = 101
	assert.equal(evaluateCadence(double)[0].regressed, true)
	assert.throws(() => compareCadence(double), /dynamic fog True/)
	// Faster candidates always pass.
	const faster = fixture(); for (const run of faster) run.after.arms[2].fps = 130
	assert.equal(compareCadence(faster)[2].changePercent, 14.04)
})
test('an injected frame delay is calibration only, and only on the measured side', () => {
	const injected = fixture(); injected[0].after.arms[0].injectedFrameDelayMs = 0.2
	assert.throws(() => compareCadence(injected), /Injected frame delay is calibration only/)
	const calibrated = fixture()
	for (const run of calibrated) for (const arm of run.after.arms) arm.injectedFrameDelayMs = 0.2
	assert.equal(compareCadence(calibrated, { frameDelayMs: 0.2 }).length, 4)
	assert.throws(() => compareCadence(fixture(), { frameDelayMs: 0.2 }), /Calibration delay missing/)
	const reference = fixture()
	for (const run of reference) for (const side of ['before', 'after']) for (const arm of run[side].arms) arm.injectedFrameDelayMs = 0.2
	assert.throws(() => compareCadence(reference, { frameDelayMs: 0.2 }), /calibration only/)
})
test('skipped display callbacks calibrate delivered fps only on the measured side', () => {
	const runs = fixture()
	for (const run of runs) for (const arm of run.after.arms) {
		arm.injectedDropEvery = 20
		arm.realizedDroppedFrames = 20
		arm.fps *= 0.95
	}
	assert.equal(evaluateCadence(runs, { dropEvery: 20 }).every(row => row.regressed), true)
	assert.throws(() => compareCadence(runs, { dropEvery: 20 }), /median delivered frame rate fell/)
	assert.throws(() => compareCadence(runs), /calibration only/)
	for (const run of runs) for (const arm of run.after.arms) arm.realizedDroppedFrames = 0
	assert.throws(() => evaluateCadence(runs, { dropEvery: 20 }), /did not skip enough/)
})
test('frame counts and rates must be present', () => {
	for (const [field, value] of [['frames', 79], ['frames', 456.5], ['fps', NaN], ['fps', 0]]) {
		const runs = fixture(); runs[2].after.arms[1][field] = value
		assert.throws(() => compareCadence(runs), undefined, `${field}=${value}`)
	}
})
test('shorter sweeps, lower resolution, changed effects and different camera paths cannot qualify', () => {
	for (const [field, value] of [['measuredMs', 2000], ['discardMs', 100], ['preheatMs', 5000], ['preheatMs', 60000], ['warmupMs', 40000], ['warmupMs', 60000], ['audioReady', false], ['actors', 10], ['canvas', [1512, 982]], ['qualityState', {}], ['cameraStart', [60, 23, 0]], ['cameraEnd', [30, 23, -20]], ['cameraEnd', [NaN, 23, -20]]]) {
		const runs = fixture(); runs[0].after.arms[0][field] = value
		assert.throws(() => compareCadence(runs), undefined, field)
	}
	for (const field of ['cascades', 'sceneryStep', 'contact', 'nearField', 'windGrass', 'weatherFx']) {
		const runs = fixture(), state = runs[0].after.arms[0].qualityState
		state[field] = typeof state[field] === 'boolean' ? !state[field] : state[field] + 1
		assert.throws(() => compareCadence(runs), /Actual render settings must match/, field)
	}
})
test('missing samples, absolute failure, lower quality and fallbacks cannot qualify', () => {
	assert.throws(() => compareCadence(fixture().slice(1)), /three/)
	for (const [field, value] of [['p50', 16.71], ['worst', 50.01], ['p95', NaN], ['scale', 0.9], ['fallback', 1], ['loaded', 277], ['quality', 'low']]) {
		const runs = fixture(); runs[1].after.arms[0][field] = value
		assert.throws(() => compareCadence(runs), undefined, field)
	}
	const failed = fixture(); failed[2].before.pass = false
	assert.throws(() => compareCadence(failed), /[Aa]bsolute/)
})

test('matching before/after paths in a later pair must also match the first pair', () => {
	const runs = fixture()
	for (const side of ['before', 'after']) runs[1][side].arms[0].cameraStart[0] += 2
	assert.throws(() => compareCadence(runs), /Camera trajectory must match/)
})

test('an old preheat snapshot or another seed cannot qualify as the fresh match', () => {
	for (const [field, value] of [['previousTick', 100], ['restartTick', 1018], ['randomSeed', 2]]) {
		const runs = fixture(); runs[0].after.arms[0].restart[field] = value
		assert.throws(() => compareCadence(runs), undefined, field)
	}
	const grown = fixture()
	for (const run of grown) for (const side of ['before', 'after']) run[side].arms[1].actors = 222
	assert.throws(() => compareCadence(grown), /Native starting-army workload/)
})
