#!/usr/bin/env node
// A finished skirmish must reach the leaderboard, or say why it did not, and a report that
// could not be delivered must survive until a signed-in retry. Browser and desktop paths.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const bundled = await build({
	stdin: { contents: `export * from './src/ui/match-report'`, resolveDir: root },
	bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
})
const source = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`

const store = new Map()
globalThis.localStorage = {
	getItem: key => store.has(key) ? store.get(key) : null,
	setItem: (key, value) => { store.set(key, String(value)) },
	removeItem: key => { store.delete(key) },
}
const pending = () => JSON.parse(store.get('redline-pending-match-reports') ?? '[]')
const posted = []
let reply = () => ({ status: 201, body: { match: { rated: true, delta: 6, ratingAfter: 1006 } } })
globalThis.fetch = async (url, init) => {
	posted.push({ url: String(url), body: JSON.parse(init.body) })
	const { status, body, fail } = reply()
	if (fail) throw new TypeError('network down')
	return { status, ok: status >= 200 && status < 300, json: async () => body ?? {} }
}
const start = { mode: 'skirmish', map: 'Doubles', faction: 'allies', opponents: [{ kind: 'bot', bot: 'normal' }] }
const { beginMatchReport, finishMatchReport, flushPendingMatchReports } = await import(source)

// Saved, rated: the sheet can show the rating change. Nothing is kept.
beginMatchReport(start)
assert.deepEqual(await finishMatchReport('victory', 120_000), { kind: 'saved', rated: true, delta: 6, ratingAfter: 1006 })
assert.equal(posted.at(-1).url, '/api/matches')
assert.equal(posted.at(-1).body.durationSec, 120)
assert.equal(pending().length, 0)
// A second call for the same match never posts again.
assert.deepEqual(await finishMatchReport('victory', 120_000), { kind: 'skipped' })

// Nobody signed in: kept, and delivered once a player signs in.
reply = () => ({ status: 401, body: { error: 'Sign in first.' } })
await new Promise(resolve => setTimeout(resolve, 2))
beginMatchReport(start)
assert.deepEqual(await finishMatchReport('defeat', 95_000), { kind: 'signed-out' })
assert.equal(pending().length, 1)
reply = () => ({ status: 201, body: { match: { rated: true, delta: -4, ratingAfter: 1002 } } })
assert.equal(await flushPendingMatchReports(), 1)
assert.equal(pending().length, 0)

// Offline: kept; a still-offline retry keeps it; a duplicate on retry settles it.
reply = () => ({ fail: true })
await new Promise(resolve => setTimeout(resolve, 2))
beginMatchReport(start)
assert.deepEqual(await finishMatchReport('draw', 400_000), { kind: 'queued' })
assert.equal(await flushPendingMatchReports(), 0)
assert.equal(pending().length, 1)
reply = () => ({ status: 409, body: { error: 'You already reported this match.' } })
assert.equal(await flushPendingMatchReports(), 0)
assert.equal(pending().length, 0)

// A server without a leaderboard (plain local build) drops the report, and so does a 400.
reply = () => ({ status: 404 })
await new Promise(resolve => setTimeout(resolve, 2))
beginMatchReport(start)
assert.deepEqual(await finishMatchReport('victory', 100_000), { kind: 'no-leaderboard' })
assert.equal(pending().length, 0)

// Capped and expiring: at most ten are kept, and a week-old entry is never replayed.
reply = () => ({ status: 503 })
for (let i = 0; i < 12; i++) {
	await new Promise(resolve => setTimeout(resolve, 2))
	beginMatchReport(start)
	await finishMatchReport('victory', 100_000)
}
assert.equal(pending().length, 10)
const aged = pending().map((entry, i) => i === 0 ? { ...entry, queuedAt: Date.now() - 8 * 24 * 3600 * 1000 } : entry)
store.set('redline-pending-match-reports', JSON.stringify(aged))
const before = posted.length
reply = () => ({ status: 201, body: { match: { rated: false } } })
assert.equal(await flushPendingMatchReports(), 9)
assert.equal(posted.length - before, 9, 'the expired entry is dropped without being sent')
assert.equal(pending().length, 0)

// Desktop: the device-token broker reports failures as messages only.
const desktopCalls = []
let desktop = () => { throw new Error("Error invoking remote method 'account-request': Error: Not signed in.") }
globalThis.redline = { accountRequest: async request => { desktopCalls.push(request); return desktop() } }
await new Promise(resolve => setTimeout(resolve, 2))
beginMatchReport(start)
assert.deepEqual(await finishMatchReport('victory', 100_000), { kind: 'signed-out' })
assert.equal(desktopCalls.at(-1).path, '/api/matches')
assert.equal(desktopCalls.at(-1).method, 'POST')
desktop = () => ({ match: { rated: true, delta: 6, ratingAfter: 1012 } })
assert.equal(await flushPendingMatchReports(), 1)
desktop = () => { throw new Error('You already reported this match.') }
await new Promise(resolve => setTimeout(resolve, 2))
beginMatchReport(start)
assert.deepEqual(await finishMatchReport('victory', 100_000), { kind: 'duplicate' })

console.log('matchreportgate: PASS — saved/rated, signed-out retry, offline retry, 404 drop, cap 10, 7-day expiry, desktop broker path')
