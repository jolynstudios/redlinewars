#!/usr/bin/env node
// Production browser cadence gate. This deliberately measures a real hosted
// skirmish after cold boot and LOD construction have settled; startup and
// steady-state are separate performance contracts.
import assert from 'node:assert/strict'
import { launchGpuBrowser, loadChromium } from './harness.mjs'

const quality = process.argv[2] ?? 'high'
const seconds = Number(process.env.LIVEPERF_SECONDS ?? 30)
const warmupSeconds = Number(process.env.LIVEPERF_WARMUP_SECONDS ?? 10)
const baseUrl = process.env.LIVEPERF_URL ?? 'https://play.redlinewars.online/steelseed/index.html'
const minimumFps = Number(process.env.LIVEPERF_MIN_FPS ?? 58)
// Headless rAF occasionally coalesces a frame even when the renderer's own
// cadence window is on budget. Compare both: the outer stream may drop one
// frame in twenty, while the engine p90 must still fit a 60 Hz display.
const maximumP95Ms = Number(process.env.LIVEPERF_MAX_P95_MS ?? 35)
const maximumEngineP90Ms = Number(process.env.LIVEPERF_MAX_ENGINE_P90_MS ?? 18)
const maximumLongTaskMs = Number(process.env.LIVEPERF_MAX_LONG_TASK_MS ?? 250)

let browser
try {
	;({ browser } = await launchGpuBrowser(await loadChromium('liveperfgate'), 'liveperfgate'))
	const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
	const page = await context.newPage()
	const errors = []
	const qualityLog = []
	const measuredNetwork = []
	let measuring = false
	page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
	page.on('console', message => {
		if (message.text().startsWith('[quality]')) qualityLog.push(message.text())
		if (message.type() === 'error' && !message.text().includes('favicon'))
			errors.push(`console: ${message.text()}`)
	})
	page.on('response', response => {
		if (!measuring) return
		measuredNetwork.push({
			status: response.status(),
			type: response.request().resourceType(),
			url: response.url(),
			bytes: Number(response.headers()['content-length'] ?? 0),
		})
	})

	const url = new URL(baseUrl)
	url.searchParams.set('mode', 'game')
	url.searchParams.set('platform', 'null')
	url.searchParams.set('quality', quality)
	url.searchParams.set('liveperf', Date.now().toString())
	const navigationStartedAt = Date.now()
	await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60_000 })
	await page.waitForFunction(() => (document.getElementById('session-map')?.options?.length ?? 0) > 0,
		undefined, { timeout: 240_000, polling: 250 })
	const lobbyReadyMs = Date.now() - navigationStartedAt
	await page.evaluate(() => {
		const map = document.getElementById('session-map')
		map.selectedIndex = 0
		map.dispatchEvent(new Event('change', { bubbles: true }))
		document.getElementById('session-start').click()
	})
	await page.waitForFunction(() => globalThis.steelseed?.ctx?.snapshot?.tick > 120,
		undefined, { timeout: 120_000, polling: 100 })
	const firstMatchReadyMs = Date.now() - navigationStartedAt
	// Give shader/LOD cold work and the frame governor time to settle before the
	// measured interval. Cold startup is covered by the separate tick probe.
	await page.waitForTimeout(warmupSeconds * 1000)

	measuring = true
	const measured = await page.evaluate(async ({ seconds }) => {
		const app = globalThis.steelseed
		const intervals = []
		const longTasks = []
		const observer = new PerformanceObserver(list => {
			for (const entry of list.getEntries()) longTasks.push(entry.duration)
		})
		observer.observe({ entryTypes: ['longtask'] })
		let active = true
		let last = performance.now()
		const sample = timestamp => {
			if (!active) return
			intervals.push(timestamp - last)
			last = timestamp
			requestAnimationFrame(sample)
		}
		requestAnimationFrame(sample)
		const tick0 = app.ctx.snapshot.tick
		const started = performance.now()
		await new Promise(resolve => setTimeout(resolve, seconds * 1000))
		active = false
		observer.disconnect()
		const elapsedSeconds = (performance.now() - started) / 1000
		const tick1 = app.ctx.snapshot.tick
		const sorted = intervals.slice(1).sort((a, b) => a - b)
		const percentile = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? Infinity
		return {
			quality: app.config.q.name,
			graphicsChoice: app.config.graphicsChoice,
			actors: app.ctx.snapshot.actors.count,
			tick0,
			tick1,
			ticksPerSecond: (tick1 - tick0) / elapsedSeconds,
			frames: sorted.length,
			fps: sorted.length / elapsedSeconds,
			p50Ms: percentile(0.50),
			p95Ms: percentile(0.95),
			p99Ms: percentile(0.99),
			worstMs: percentile(1),
			longestTaskMs: Math.max(0, ...longTasks),
			frameStats: { ...app.frameStats },
			damageStats: { ...app.ctx.get('units').damageStats },
			canvas: [app.ctx.canvas.width, app.ctx.canvas.height],
			halted: document.body.textContent.includes('SIMULATION HALTED'),
		}
	}, { seconds })
	measuring = false

	for (const key of ['ticksPerSecond', 'fps', 'p50Ms', 'p95Ms', 'p99Ms', 'worstMs', 'longestTaskMs'])
		measured[key] = +measured[key].toFixed(2)
	console.log(JSON.stringify({
		url: url.href,
		startup: { lobbyReadyMs, firstMatchReadyMs },
		warmupSeconds,
		seconds,
		measured,
		measuredNetwork: {
			responses: measuredNetwork.length,
			bytesWithContentLength: measuredNetwork.reduce((sum, response) => sum + response.bytes, 0),
			items: measuredNetwork,
		},
		qualityLog,
		errors,
	}, null, 2))
	assert.equal(measured.quality, quality, `requested ${quality}, running ${measured.quality}`)
	assert.equal(measured.halted, false, 'simulation watchdog halted')
	assert.deepEqual(errors, [], 'production page must have no runtime errors')
	assert.ok(measured.ticksPerSecond >= 20, `simulation measured ${measured.ticksPerSecond} ticks/s`)
	assert.ok(measured.fps >= minimumFps, `steady cadence measured ${measured.fps} fps; need ${minimumFps}`)
	assert.ok(measured.p95Ms <= maximumP95Ms, `rAF p95 measured ${measured.p95Ms} ms; need <= ${maximumP95Ms}`)
	assert.ok(measured.frameStats.p90Ms <= maximumEngineP90Ms,
		`engine frame p90 measured ${measured.frameStats.p90Ms} ms; need <= ${maximumEngineP90Ms}`)
	assert.ok(measured.longestTaskMs <= maximumLongTaskMs,
		`steady-state main-thread task measured ${measured.longestTaskMs} ms; need <= ${maximumLongTaskMs}`)
	console.log(`liveperfgate PASS — ${quality} ${measured.fps} fps, p95 ${measured.p95Ms} ms, ${measured.ticksPerSecond} ticks/s`)
	await context.close()
} finally {
	await browser?.close().catch(() => {})
}
