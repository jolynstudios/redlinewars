#!/usr/bin/env node
// Compare immutable composed bundles on the SAME GPU, sequentially. Every
// run must pass cadencegate's existing absolute limits. Three predetermined
// pairs, alternating order, avoid selecting a favourable sample after a fail.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const median = xs => [...xs].sort((a, b) => a - b)[1]
export function compareCadence(runs) {
	assert.equal(runs.length, 3, 'Exactly three predefined pairs required')
	const profiles = [['dynamic', 'True'], ['dynamic', 'False'], ['high', 'True'], ['high', 'False']]
	return profiles.map(([quality, fog], index) => {
		const values = { before: [], after: [] }
		for (const run of runs) for (const side of ['before', 'after']) {
			assert.equal(run[side]?.pass, true, `${side}: absolute cadence gate failed`)
			assert.equal(run[side].arms.length, 4)
			const arm = run[side].arms[index]
			assert.equal(arm.quality, quality); assert.equal(arm.fog, fog)
			assert.equal(arm.map, 'Marigold Town'); assert.equal(arm.scale, 1)
			assert.equal(arm.fallback, 0); assert.ok(arm.loaded > 0)
			assert.equal(arm.loaded, run.before.arms[index].loaded)
			assert.ok(Number.isFinite(arm.p95) && arm.p95 > 0)
			assert.ok(arm.p50 <= 16.7 && arm.worst <= 50)
			values[side].push(arm.p95)
		}
		const before = median(values.before), after = median(values.after)
		assert.ok(after <= before, `${quality} fog ${fog}: median p95 worsened ${before} -> ${after} ms`)
		return { quality, fog, beforeP95: values.before, afterP95: values.after, beforeMedianP95: before, afterMedianP95: after }
	})
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
	const before = option('before'), after = option('after'), out = resolve(option('out') ?? 'stage/cadence-comparison')
	assert.ok(before && after, 'Supply --before=URL and --after=URL for the immutable bundles')
	mkdirSync(out, { recursive: true })
	const runs = []
	const report = { pass: false, before, after, repeats: 3, policy: 'Every absolute gate passes; median p95 may not increase on any profile', runs }
	try {
		for (let iteration = 0; iteration < 3; iteration++) {
			const run = {}; runs.push(run)
			for (const side of iteration % 2 ? ['after', 'before'] : ['before', 'after']) {
				const result = spawnSync(process.execPath, [fileURLToPath(new URL('./cadencegate.mjs', import.meta.url))], {
					env: { ...process.env, STEELSEED_URL: side === 'before' ? before : after },
					encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 600000,
				})
				writeFileSync(resolve(out, `${iteration + 1}-${side}.log`), result.stdout + result.stderr)
				assert.equal(result.status, 0, `${iteration + 1}-${side}: absolute cadence gate failed; see saved log`)
				const line = result.stdout.split('\n').find(value => value.startsWith('{"pass":true'))
				assert.ok(line, 'Missing native game cadence report')
				run[side] = JSON.parse(line)
				console.log(`pair ${iteration + 1} ${side} passed`)
			}
		}
		report.profiles = compareCadence(runs); report.pass = true
		console.log(JSON.stringify(report))
	} catch (error) {
		report.error = error.message; process.exitCode = 1; console.error(error.message)
	} finally { writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n') }
}
