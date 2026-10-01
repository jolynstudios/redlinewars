import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareCadence } from './cadencecomparegate.mjs'
const fixture = () => Array.from({ length: 3 }, () => Object.fromEntries(['before', 'after'].map(side => [side, {
	pass: true, arms: [['dynamic', 'True'], ['dynamic', 'False'], ['high', 'True'], ['high', 'False']].map(([quality, fog]) => ({
		quality, fog, map: 'Marigold Town', p50: 8.3, p95: 16.7, worst: 25, loaded: 278, fallback: 0, scale: 1,
	})),
}])))
test('all four profiles must preserve median p95 without a regression allowance', () => {
	assert.equal(compareCadence(fixture()).length, 4)
	const regressed = fixture()
	regressed[0].after.arms[3].p95 = 16.71; regressed[2].after.arms[3].p95 = 16.71
	assert.throws(() => compareCadence(regressed), /median p95 worsened/)
})
test('missing samples, absolute failure, lower quality and fallbacks cannot qualify', () => {
	assert.throws(() => compareCadence(fixture().slice(1)), /three/)
	for (const [field, value] of [['p50', 16.71], ['worst', 50.01], ['p95', NaN], ['scale', 0.9], ['fallback', 1], ['loaded', 277], ['quality', 'low']]) {
		const runs = fixture(); runs[1].after.arms[0][field] = value
		assert.throws(() => compareCadence(runs), undefined, field)
	}
	const failed = fixture(); failed[2].before.pass = false
	assert.throws(() => compareCadence(failed), /absolute/)
})
