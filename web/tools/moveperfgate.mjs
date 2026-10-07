#!/usr/bin/env node
// STEELSEED — movement performance gate.
//
// Proves the two loads this game must carry at once, in a real match, through the
// same pipeline the player gets:
//   1. The simulation stays responsive while every owned unit drives: the worker
//      host must keep feeding ticks (>= 20/s) and no single main-thread stall may
//      exceed 500 ms (the historical first-move-order pathology was ~12 s).
//   2. The presentation holds 30 fps while they drive: rAF p50 <= 33.4 ms.
//
// The scenario is the heaviest realistic one: the full 'heavy' starting roster,
// fog off, whole map explored, ALL owned units ordered back and forth across the
// map on alternating 1.4 s move orders for 20 s, at low AND high quality.
//
// A 5 ms heartbeat records the longest gap between beats: any main-thread block
// (sim, decode, GC pause) shows up there no matter which subsystem caused it.
// The tick counter is read from the snapshot itself, so the sim's liveness is
// measured, not assumed from the worker's own claims.
import assert from 'node:assert/strict'
import { launchGpuBrowser, loadChromium } from './harness.mjs'
import { startPrivateComposed } from './private-composed-preview.mjs'
import { configFor } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'

const PASS_P50_MS = 33.4
const PASS_MIN_TICKS_PER_S = 20
const PASS_MAX_HEARTBEAT_GAP_MS = 500
const DRIVE_SECONDS = 20
const ORDER_INTERVAL_MS = 1400

let preview
let browser
try {
	preview = await startPrivateComposed(8491)
	;({ browser } = await launchGpuBrowser(await loadChromium('moveperfgate'), 'moveperfgate'))
	const results = []
	for (const quality of ['low', 'high']) {
		const context = await browser.newContext({ viewport: { width: 1000, height: 750 }, deviceScaleFactor: 1 })
		const page = await context.newPage()
		const errors = []
		const roomDirectoryMisses = []
		page.on('response', r => { if (r.status() === 404 && r.url().endsWith('/rooms')) roomDirectoryMisses.push(r.url()) })
		page.on('pageerror', e => errors.push(`pageerror: ${e.message.slice(0, 200)}`))
		// The lobby polls the room directory at the page origin; a bare test server has
		// none, and that environmental miss is not a product regression. Everything
		// else - including every OTHER 404 - stays an error.
		page.on('console', m => {
			if (m.type() !== 'error') return
			if (m.text().startsWith('Failed to load resource') && roomDirectoryMisses.length > 0) { roomDirectoryMisses.pop(); return }
			errors.push(`console: ${m.text().slice(0, 200)}`)
		})
		await page.goto(`${preview.baseUrl}/steelseed/index.html?mode=game&platform=null&quality=${quality}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
		await page.waitForFunction(() => globalThis.steelseed?.ctx?.session?.available, undefined, { timeout: 180000, polling: 200 })
		const catalog = await page.evaluate(async () => await globalThis.steelseed.ctx.session.getCatalog())
		const map = catalog.maps.find(m => m.title === 'Marigold Town') ?? catalog.maps[0]
		const config = configFor(catalog, map, { withBot: false })
		const faction = ['england', 'germany', 'france', 'allies'].find(id => map.factions.some(f => f.id === id))
		config.local.faction = faction
		config.slots.find(s => s.slot === config.local.slot).faction = faction
		Object.assign(config.options, { startingunits: 'heavy', explored: 'True', fog: 'False', crates: 'False' })
		await page.evaluate(async c => await globalThis.steelseed.ctx.session.startSkirmish(c), config)
		await page.waitForFunction(() => globalThis.steelseed?.ctx?.snapshot?.actors?.count > 0 && document.getElementById('session-ui')?.hidden, undefined, { timeout: 180000, polling: 200 })

		const drive = await page.evaluate(async ({ driveSeconds, orderIntervalMs }) => {
			const bridge = globalThis.steelseedBridge
			const app = globalThis.steelseed
			const world = app.ctx.snapshot.world
			const x0 = world.boundsLeft + 6, y0 = world.boundsTop + 6
			const x1 = world.boundsRight - 6, y1 = world.boundsBottom - 6

			// 5 ms heartbeat: the longest inter-beat gap is the biggest main-thread
			// block, whatever caused it. rAF intervals are the HUD's own fps math.
			let lastBeat = performance.now()
			let maxGap = 0
			const heartbeat = setInterval(() => {
				const now = performance.now()
				if (now - lastBeat > maxGap) maxGap = now - lastBeat
				lastBeat = now
			}, 5)

			const rafIntervals = []
			let lastFrame = performance.now()
			const frames = []
			const sample = ts => {
				frames.push(ts)
				if (frames.length > 240) frames.shift()
			}
			const raf = ts => {
				rafIntervals.push(ts - lastFrame)
				lastFrame = ts
				sample(ts)
				requestAnimationFrame(raf)
			}
			requestAnimationFrame(raf)

			const owned = () => {
				const snap = app.ctx.snapshot
				const ids = []
				for (let i = 0; i < snap.actors.count; i++)
					if (snap.actors.owner[i] === 0 && snap.actors.health[i] > 0) ids.push(snap.actors.id[i])
				return ids
			}

			const t0 = performance.now()
			const tick0 = app.ctx.snapshot.tick
			let orders = 0, flip = false
			while (performance.now() - t0 < driveSeconds * 1000) {
				const ids = owned()
				if (ids.length > 0) {
					const target = flip ? { x: x0, y: y0 } : { x: x1, y: y1 }
					flip = !flip
					void bridge.issueContextOrder({
						subjectIds: Uint32Array.from(ids), subjectCount: ids.length,
						targetActorId: 0, targetCellX: target.x, targetCellY: target.y,
						targetFrozen: false, modifiers: 0,
					}).catch(() => {})
					orders++
				}
				await new Promise(r => setTimeout(r, orderIntervalMs))
			}
			// Let the last orders land before reading the counters.
			await new Promise(r => setTimeout(r, 500))
			clearInterval(heartbeat)
			cancelAnimationFrame(0)

			const elapsed = (performance.now() - t0) / 1000
			const ticks = app.ctx.snapshot.tick - tick0
			const sorted = [...rafIntervals].sort((a, b) => a - b)
			const p50 = sorted[Math.floor(sorted.length / 2)] ?? Infinity
			return {
				orders,
				actors: app.ctx.snapshot.actors.count,
				ownedAtEnd: owned().length,
				ticksPerSecond: +(ticks / elapsed).toFixed(1),
				p50Ms: +p50.toFixed(1),
				samples: rafIntervals.length,
				maxHeartbeatGapMs: +maxGap.toFixed(0),
				hostStatus: bridge.hostStatus?.() ?? 'n/a',
			}
		}, { driveSeconds: DRIVE_SECONDS, orderIntervalMs: ORDER_INTERVAL_MS }, { timeout: 120000 })

		assert.deepEqual(errors, [], `${quality}: no page errors during the drive`)
		assert.ok(drive.orders >= Math.floor(DRIVE_SECONDS * 1000 / ORDER_INTERVAL_MS) - 1, `${quality}: expected move orders every ${ORDER_INTERVAL_MS} ms, got ${drive.orders}`)
		assert.ok(drive.ownedAtEnd > 50, `${quality}: expected the heavy roster to stay alive, ${drive.ownedAtEnd} owned at end`)
		assert.ok(drive.ticksPerSecond >= PASS_MIN_TICKS_PER_S, `${quality}: sim must keep ${PASS_MIN_TICKS_PER_S} ticks/s while driving, measured ${drive.ticksPerSecond}`)
		assert.ok(drive.p50Ms <= PASS_P50_MS, `${quality}: rAF p50 ${drive.p50Ms} ms exceeds the ${PASS_P50_MS} ms 30 fps budget`)
		assert.ok(drive.maxHeartbeatGapMs <= PASS_MAX_HEARTBEAT_GAP_MS, `${quality}: main-thread block of ${drive.maxHeartbeatGapMs} ms exceeds ${PASS_MAX_HEARTBEAT_GAP_MS} ms`)
		results.push({ quality, ...drive })
		await context.close()
	}
	console.log('moveperfgate PASS', JSON.stringify(results))
} finally {
	await browser?.close()
	await preview?.close?.()
}
