#!/usr/bin/env node
// Inspect the renderer's own shed state across lobby -> match -> second match.
// Forces a shed as a test fixture; it never modifies game code or the AppBundle.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { configFor } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'

const base = process.env.STEELSEED_URL ?? 'http://127.0.0.1:5181/steelseed/index.html?mode=game&platform=null'
const output = process.env.SHED_PROBE_OUTPUT ?? '../stage/shed-state-probe.json'
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-angle=metal'] })
const rows = []
try {
	const page = await browser.newPage({ viewport: { width: 1512, height: 982 }, deviceScaleFactor: 2 })
	await page.goto(`${base}${base.includes('?') ? '&' : '?'}quality=dynamic`, { waitUntil: 'domcontentloaded', timeout: 120000 })
	await page.waitForFunction(() => globalThis.steelseed?.ctx?.session?.available, undefined, { timeout: 180000, polling: 250 })
	const packed = await page.evaluate(async () => {
		const catalog = await globalThis.steelseed.ctx.session.getCatalog()
	return {
		catalog,
		maps: [catalog.maps.find(map => map.title === 'Marigold Town'), catalog.maps.find(map => map.title === 'Agenda')],
	}
	})
	assert.ok(packed.maps.every(Boolean), 'missing one of the two distinct probe maps')
	const configs = packed.maps.map(map => configFor(packed.catalog, map, { withBot: true }))
	const state = async label => {
		const row = await page.evaluate(() => {
			const app = globalThis.steelseed
			const renderer = app.ctx.get('render')
			return {
				preset: { cascades: app.config.q.shadowCascades, contact: app.config.q.contactShading },
				hud: { ...app.frameStats },
				renderer: { cascades: renderer.liveCascades, contactSuppressed: renderer.contactSuppressed, sceneryStep: renderer.sceneryStep },
				governorHold: app.governorHold,
				awaitingNewWorld: app.awaitingNewWorld,
				newWorldSnapshotSeen: app.newWorldSnapshotSeen,
				sessionStatus: app.ctx.session.getStatus()?.status,
				tick: app.ctx.snapshot?.tick ?? null,
				terrain: app.ctx.get('terrain').terrainSource ? {
					w: app.ctx.get('terrain').terrainSource.w,
					h: app.ctx.get('terrain').terrainSource.h,
				} : null,
			}
		})
		rows.push({ label, ...row })
		return row
	}
	const forceShed = async () => page.evaluate(() => {
		globalThis.steelseed.ctx.get('render').setLoadShed({ cascades: 1, contact: false, sceneryStep: 4 })
	})
	await state('lobby-initial')
	await page.waitForTimeout(3000)
	const lobbySettled = await state('lobby-after-3s')
	assert.equal(lobbySettled.hud.windows, 0, 'lobby frames entered the governor')
	assert.equal(lobbySettled.governorHold, true)
	await forceShed()
	const lobbyShed = await state('lobby-forced-shed')
	assert.deepEqual(lobbyShed.renderer, { cascades: 1, contactSuppressed: true, sceneryStep: 4 })
	for (let match = 1; match <= 2; match++) {
		const started = await page.evaluate(async value => globalThis.steelseed.ctx.session.startSkirmish(value), configs[match - 1])
		rows.push({ label: `match-${match}-start-result`, result: started })
		if (started?.status === 'error') break
		const afterStart = await state(`match-${match}-after-start`)
		assert.deepEqual(afterStart.renderer, { cascades: 4, contactSuppressed: false, sceneryStep: 1 }, `match ${match} did not reset renderer shed`)
		assert.equal(afterStart.governorHold, true, `match ${match} governor resumed during build`)
		if (match === 2) {
			const oldWorldAdvance = await page.evaluate(() => {
				const app = globalThis.steelseed
				const saved = app.snapState.snapshot
				const lastTickSeen = app.lastTickSeen
				app.snapState.snapshot = { ...saved, tick: saved.tick + 1, flags: saved.flags & ~1 }
				app.evaluateSimHealth(performance.now())
				const observed = { hold: app.governorHold, awaiting: app.awaitingNewWorld }
				app.snapState.snapshot = saved
				app.lastTickSeen = lastTickSeen
				return observed
			})
			rows.push({ label: 'match-2-old-world-tick-advance', ...oldWorldAdvance })
			assert.deepEqual(oldWorldAdvance, { hold: true, awaiting: true }, 'old-world tick released the new-world governor hold')
		}
		await page.waitForFunction(({ oldTick }) => {
			const app = globalThis.steelseed
			const tick = app?.ctx?.snapshot?.tick ?? null
			return app?.governorHold === false && (app?.ctx?.snapshot?.actors?.count ?? 0) > 0 &&
				(oldTick === null || (tick !== null && tick < oldTick))
		}, { oldTick: match === 1 ? null : afterStart.tick }, { timeout: 180000, polling: 250 })
		const active = await state(`match-${match}-active`)
		assert.deepEqual(active.terrain, { w: packed.maps[match - 1].bounds.width, h: packed.maps[match - 1].bounds.height }, `match ${match} kept the previous map terrain`)
		assert.deepEqual(active.renderer, { cascades: 4, contactSuppressed: false, sceneryStep: 1 }, `match ${match} active renderer shed differs from preset`)
		if (match === 1) {
			await forceShed()
			await state('match-1-forced-shed')
		}
	}
	await page.waitForFunction(() => (globalThis.steelseed?.frameStats?.windows ?? 0) >= 1, undefined, { timeout: 30000, polling: 250 })
	const resumed = await state('match-2-governor-resumed')
	assert.equal(resumed.governorHold, false)
	assert.ok(resumed.hud.windows >= 1, 'governor did not assess an in-match frame window')
	const overload = await page.evaluate(() => {
		const app = globalThis.steelseed
		app.stop()
		// Reset only the governor fixture to preset; the real world and renderer stay
		// loaded. Drive a deterministic 50 ms cadence to prove it can still shed.
		app.pace = null
		app.renderScale = app.config.q.internalScale
		app.governorWarmupWindows = 0
		app.frameSampleCount = 0
		app.frameSampleElapsedMs = 0
		const before = app.renderScale
		for (let i = 0; i < 240; i++) app.governFrame(0.05)
		return { before, after: app.renderScale, windows: app.frameStats.windows, hold: app.governorHold }
	})
	rows.push({ label: 'match-2-synthetic-overload', ...overload })
	assert.ok(overload.after < overload.before, `in-match governor did not shed under 50 ms frames: ${JSON.stringify(overload)}`)
} finally {
	await browser.close()
	mkdirSync(output.slice(0, output.lastIndexOf('/')) || '.', { recursive: true })
	writeFileSync(output, JSON.stringify({ base, timestamp: new Date().toISOString(), rows }, null, 2))
	console.log(`wrote ${output}`)
}
