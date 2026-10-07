#!/usr/bin/env node
// Real skirmish cadence on the composed AppBundle. requestAnimationFrame interval,
// Blender roster loaded, camera moving. Dynamic and High, Fog of War on and off.
// ?devmap=1 does not satisfy this gate.
// A fixed frame count changes the route's duration on 60/120 Hz displays. Measure
// the same four-second sweep instead, and initialise first-gesture game audio
// before warm-up, as the normal lobby/Start clicks do. No shipping code is changed.
// Each arm reports delivered fps over that window; cadencecomparegate decides
// on it (p95 is reported for information).
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { configFor } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'

const base = process.env.STEELSEED_URL ?? 'http://127.0.0.1:8080/steelseed/index.html?mode=game&platform=null'
const shot = process.argv.find(arg => arg.startsWith('--shot='))?.slice('--shot='.length) ?? ''
const details = process.argv.find(arg => arg.startsWith('--details='))?.slice('--details='.length) ?? ''
const diagnosticPath = process.argv.find(arg => arg.startsWith('--diagnostics='))?.slice('--diagnostics='.length) ?? ''
// Calibration only (positive control of cadencecomparegate): a known extra
// main-thread cost at the start of every animation frame. Release runs keep 0.
const frameDelayMs = Number(process.argv.find(arg => arg.startsWith('--calibration-frame-delay-ms='))?.slice('--calibration-frame-delay-ms='.length) ?? 0)
const dropEvery = Number(process.argv.find(arg => arg.startsWith('--calibration-drop-every='))?.slice('--calibration-drop-every='.length) ?? 0)
assert.ok(Number.isFinite(frameDelayMs) && frameDelayMs >= 0 && frameDelayMs <= 5, 'Calibration frame delay must be 0-5 ms')
assert.ok(Number.isInteger(dropEvery) && (dropEvery === 0 || dropEvery >= 2 && dropEvery <= 60), 'Calibration drop interval must be 2-60 frames')
assert.ok(!(frameDelayMs && dropEvery), 'Use only one calibration stimulus')
const diagnostics = []
let activeProfile = null
function diagnostic(type, value) {
	diagnostics.push({ elapsedMs: Math.round(performance.now()), profile: activeProfile, type, value })
}
const measuredMs = 4000
const discardMs = 200
// The existing 60 Hz governor restores after ten cooldown windows plus
// five headroom windows. Each window can last two seconds. Five seconds
// measures that recovery instead of the steady full-resolution workload.
// Warm the real renderer in a first match, then start the same fresh match.
// Measuring the old warm-up match after forty seconds is not comparable:
// OpenRA's bot controllers use LocalRandom and have built different armies.
// Neither the AI nor the renderer is modified. Failed samples are not retried.
const preheatMs = 40000
const warmupMs = 5000

function pct(xs, p) {
	const s = [...xs].sort((a, b) => a - b)
	return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]
}

// Runs in the page before any game script. The first rAF callback of each
// animation frame spins a counted loop; every 60 frames the count is rescaled
// so the realised mean stays at the target despite JIT warm-up and the 0.1 ms
// timer coarsening. The game's own frame callback is unchanged.
function injectFrameDelay(targetMs) {
	const spin = iterations => { let x = 0; for (let i = 0; i < iterations; i++) x = (x * 1103515245 + i) | 0; return x }
	const state = { targetMs, iterations: 1000, frames: 0, spentMs: 0, windowFrames: 0, windowMs: 0, sink: 0 }
	globalThis.__cadenceCalibrationDelay = state
	const native = window.requestAnimationFrame.bind(window)
	let lastFrame = -1
	window.requestAnimationFrame = callback => native(timestamp => {
		if (timestamp !== lastFrame) {
			lastFrame = timestamp
			const start = performance.now()
			state.sink ^= spin(state.iterations)
			const spent = performance.now() - start
			state.frames++; state.spentMs += spent
			state.windowFrames++; state.windowMs += spent
			if (state.windowFrames === 60) {
				const mean = state.windowMs / 60
				state.iterations = Math.max(1, Math.round(state.iterations * (mean > 0 ? Math.min(4, Math.max(0.25, targetMs / mean)) : 4)))
				state.windowFrames = 0; state.windowMs = 0
			}
		}
		callback(timestamp)
	})
}

// A delivered-frame-rate control: defer every Nth animation callback by one
// display refresh during the measured window only. This skips a presentation
// opportunity for both the real game loop and the cadence observer. Unlike a
// small CPU spin, it is guaranteed to exercise the metric being judged.
function injectFrameDrop(every) {
	const native = window.requestAnimationFrame.bind(window)
	const state = { every, active: false, frames: 0, skipped: 0 }
	globalThis.__cadenceCalibrationDrop = state
	let lastTimestamp = -1, skip = false
	window.requestAnimationFrame = callback => native(timestamp => {
		if (state.active) {
			if (timestamp !== lastTimestamp) {
				lastTimestamp = timestamp
				state.frames++
				skip = state.frames % every === 0
				if (skip) state.skipped++
			}
			if (skip) return native(callback)
		}
		callback(timestamp)
	})
}

const headless = !process.argv.includes('--headed')
const browser = await chromium.launch({ headless, args: ['--enable-unsafe-webgpu', '--use-angle=metal'] })
try {
	async function boot(quality) {
		const context = await browser.newContext({ viewport: { width: 1512, height: 982 }, deviceScaleFactor: 2 })
		if (frameDelayMs > 0) await context.addInitScript(injectFrameDelay, frameDelayMs)
		if (dropEvery > 0) await context.addInitScript(injectFrameDrop, dropEvery)
		const page = await context.newPage()
		const errors = []
		page.on('pageerror', error => { errors.push(error.message.slice(0, 240)); diagnostic('pageerror', error.message) })
		page.on('console', message => diagnostic(`console.${message.type()}`, message.text()))
		page.on('crash', () => diagnostic('crash', page.url()))
		page.on('framenavigated', frame => { if (frame === page.mainFrame()) diagnostic('navigation', frame.url()) })
		await page.goto(`${base}${base.includes('?') ? '&' : '?'}quality=${quality}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
		await page.waitForFunction(() => globalThis.steelseed?.ctx?.session?.available, undefined, { timeout: 180000, polling: 250 })
		await page.locator('#boot').waitFor({ state: 'hidden', timeout: 180000 })
		return { context, page, errors }
	}

	async function start(page, { title, fog }) {
		const packed = await page.evaluate(async title => {
			const catalog = await globalThis.steelseed.ctx.session.getCatalog()
			const map = catalog.maps.find(m => m.title === title)
			return { catalog, map }
		}, title)
		assert.ok(packed.map, `missing map ${title}`)
		const config = configFor(packed.catalog, packed.map, { withBot: true })
		const playable = packed.map.slots.filter(s => s.allowBots || s.required)
		let spawn = 1
		config.slots = packed.map.slots.map(descriptor => {
			const index = playable.findIndex(s => s.id === descriptor.id)
			const inPlay = index >= 0 && index < 2
			return {
				slot: descriptor.id,
				kind: index === 0 ? 'human' : inPlay ? 'bot' : 'closed',
				botType: index === 0 || !inPlay ? '' : (packed.map.bots.find(b => b.id === 'normal')?.id ?? packed.map.bots[0]?.id ?? ''),
				faction: descriptor.locks.faction ? descriptor.defaults.faction : packed.map.factions[index % packed.map.factions.length].id,
				color: descriptor.locks.color ? descriptor.defaults.color : packed.map.colors[index % packed.map.colors.length],
				team: inPlay ? index + 1 : 0,
				spawn: descriptor.locks.spawn ? descriptor.defaults.spawn : inPlay ? spawn++ : 0,
			}
		})
		const human = config.slots[0]
		config.local = { slot: human.slot, name: 'Player', faction: human.faction, color: human.color, team: human.team, spawn: human.spawn }
		Object.assign(config.options, { startingunits: 'heavy', explored: fog === 'False' ? 'True' : 'False', fog, crates: 'False' })
		async function launch(previousTick = null) {
			diagnostic('start-match', { previousTick })
			const started = await page.evaluate(async c => await globalThis.steelseed.ctx.session.startSkirmish(c), config)
			if (started?.status === 'error') throw new Error(`${title}: ${started.code} ${started.userMessage}`)
			await page.waitForFunction(previousTick => {
				const s = globalThis.steelseed?.ctx?.snapshot
				return (s?.actors?.count ?? 0) > 0 && (previousTick === null || (s.tick < previousTick && s.tick < 100))
			}, previousTick, { timeout: 180000, polling: 100 })
		}
		await launch()
		// This is an owned benchmark window. Centre its pointer first.
		await page.mouse.move(756, 491)
		await page.evaluate(() => {
			// Use the existing minimap focus command. These are the fixed heavy-army
			// centroid for native seed 104729 / spawn 1, not a changed game camera.
			steelseed.ctx.get('camera').focusWorld(63.86363636363637, 15.863636363636363)
		})
		await page.keyboard.press('Shift')
		await page.waitForFunction(() => globalThis.steelseed.ctx.get('audio').bank != null, undefined, { timeout: 20000, polling: 100 })
		await page.evaluate(() => {
			// A canvas-only guard still admitted releases, keyboard input and HUD
			// controls outside the canvas. Audio has had its real gesture; now block
			// external input throughout this owned fixture. Synthetic sweep input
			// below remains enabled. Record counts only, never typed characters.
			globalThis.__cadenceIgnoredInput = {}
			for (const type of ['pointermove', 'pointerdown', 'pointerup', 'pointerenter', 'pointerleave', 'wheel', 'keydown', 'keyup'])
				window.addEventListener(type, event => {
					if (!event.isTrusted) return
					globalThis.__cadenceIgnoredInput[type] = (globalThis.__cadenceIgnoredInput[type] ?? 0) + 1
					event.stopImmediatePropagation()
					if (event.cancelable) event.preventDefault()
				}, { capture: true, passive: false })
		})
		await page.waitForTimeout(preheatMs)
		const previousTick = await page.evaluate(() => steelseed.ctx.snapshot.tick)
		await launch(previousTick)
		const restartTick = await page.evaluate(() => steelseed.ctx.snapshot.tick)
		// The snapshot can precede the first new-world camera/terrain frame.
		// Let those notifications finish before setting the fixed view, then
		// leave the full five-second warm-up for ground-height damping.
		await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
		await page.evaluate(() => steelseed.ctx.get('camera').focusWorld(63.86363636363637, 15.863636363636363))
		await page.waitForTimeout(warmupMs)
		return { map: packed.map.title, restart: { previousTick, restartTick, randomSeed: config.randomSeed } }
	}

	async function sample(page) {
		await page.evaluate(({ measuredMs, discardMs }) => {
			globalThis.__samples = []
			globalThis.__cadenceDone = false
			const app = steelseed, camera = app.ctx.get('render').camera
			globalThis.__cadenceStart = {
				tick: app.ctx.snapshot.tick, syncHash: app.ctx.snapshot.syncHash,
				camera: Array.from(camera.position), quality: { ...app.frameStats },
				canvas: [app.ctx.canvas.width, app.ctx.canvas.height],
				focused: document.hasFocus(), visibility: document.visibilityState,
				audioReady: app.ctx.get('audio').bank != null,
				pointer: { ...app.ctx.input.pointer }, edgeScroll: app.ctx.get('camera').edgeScrollMask,
			}
			const delay = globalThis.__cadenceCalibrationDelay
			globalThis.__cadenceDelayStart = delay ? { frames: delay.frames, spentMs: delay.spentMs } : null
			const drop = globalThis.__cadenceCalibrationDrop
			if (drop) { drop.frames = 0; drop.skipped = 0; drop.active = true }
			let first = null, last = null
			const loop = now => {
				if (first === null) first = now
				const elapsed = now - first
				if (last !== null && last - first >= discardMs) globalThis.__samples.push(now - last)
				last = now
				if (elapsed < discardMs + measuredMs) requestAnimationFrame(loop)
				else {
					if (drop) drop.active = false
					// End movement in this callback, not after an asynchronous polling round trip.
					window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD', bubbles: true }))
					globalThis.__cadenceEnd = {
						tick: app.ctx.snapshot.tick, syncHash: app.ctx.snapshot.syncHash,
						camera: Array.from(camera.position), quality: { ...app.frameStats }, elapsed,
						focused: document.hasFocus(), visibility: document.visibilityState,
					}
					globalThis.__cadenceDelayEnd = delay ? { frames: delay.frames, spentMs: delay.spentMs } : null
					globalThis.__cadenceDroppedFrames = drop?.skipped ?? 0
					globalThis.__cadenceDone = true
				}
			}
			requestAnimationFrame(loop)
			window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', bubbles: true }))
		}, { measuredMs, discardMs })
		await page.waitForFunction(() => globalThis.__cadenceDone === true, undefined, { timeout: 20000, polling: 100 })
		return page.evaluate(() => {
			const units = steelseed.ctx.get('units')
			const samples = globalThis.__samples
			const delayStart = globalThis.__cadenceDelayStart, delayEnd = globalThis.__cadenceDelayEnd
			return {
				samples,
				realizedFrameDelayMs: delayStart && delayEnd && delayEnd.frames > delayStart.frames
					? (delayEnd.spentMs - delayStart.spentMs) / (delayEnd.frames - delayStart.frames) : 0,
				start: globalThis.__cadenceStart, end: globalThis.__cadenceEnd,
				backend: steelseed.ctx.backend,
				scale: steelseed.frameStats.renderScale,
				actors: steelseed.ctx.snapshot.actors.count,
				loaded: units.forgeStats.loaded,
				fallback: units.forgeStats.fallback,
				ignoredExternalInput: { ...globalThis.__cadenceIgnoredInput },
				realizedDroppedFrames: globalThis.__cadenceDroppedFrames ?? 0,
			}
		})
	}

	const arms = []
	const raw = []
	let pictured = false
	for (const [quality, fog] of [['dynamic', 'True'], ['dynamic', 'False'], ['high', 'True'], ['high', 'False']]) {
		activeProfile = { quality, fog }
		const { context, page, errors } = await boot(quality)
		const { map, restart } = await start(page, { title: 'Marigold Town', fog })
		if (shot && !pictured) {
			await page.screenshot({ path: shot })
			pictured = true
		}
		const row = await sample(page)
		raw.push({ quality, fog, map, restart, ...row })
		if (details) writeFileSync(details, JSON.stringify({ schema: 2, headless, measuredMs, discardMs, preheatMs, warmupMs, profiles: raw }, null, 2))
		const p50 = pct(row.samples, 0.5)
		const worst = Math.max(...row.samples)
		assert.equal(errors.length, 0, errors.join('\n'))
		assert.equal(row.backend, 'webgpu', 'Cadence qualification requires the real WebGPU renderer')
		assert.ok(row.loaded > 0, 'Blender roster did not load')
		assert.equal(row.fallback, 0)
		assert.ok(row.actors > 0)
		assert.equal(row.start.audioReady, true, 'First-gesture audio must be initialised before measuring gameplay')
		for (const point of [row.start, row.end]) {
			assert.equal(point.focused, true, 'Benchmark window must remain focused')
			assert.equal(point.visibility, 'visible', 'Benchmark window must remain visible')
		}
		assert.equal(row.start.edgeScroll, 0, 'External pointer must not move the camera')
		assert.equal(row.start.quality.renderScale, 1, 'Full resolution required before the measured trajectory')
		assert.equal(row.end.quality.renderScale, 1, 'Full resolution required after the measured trajectory')
		for (const [axis, expected] of [70.656715, 22.948454, -0.044204].entries())
			assert.ok(Math.abs(row.start.camera[axis] - expected) < 0.01, 'Native benchmark must start from its fixed base view')
		const settings = quality => Object.fromEntries(['tier', 'choice', 'nearField', 'windGrass', 'weatherFx', 'cascades', 'contact', 'sceneryStep', 'renderScale'].map(key => [key, quality[key]]))
		assert.deepEqual(settings(row.start.quality), settings(row.end.quality), 'Render settings changed during the measured trajectory')
		assert.ok(row.samples.length >= 80, 'Insufficient samples in the fixed-duration window')
		assert.ok(row.end.elapsed >= discardMs + measuredMs && row.end.elapsed < discardMs + measuredMs + 50, 'Measurement overran its fixed trajectory')
		// Subtracting large browser timestamps can leave picosecond-scale binary
		// rounding above an exact boundary (16.700000000004 vs 16.7). This is
		// below the clock's resolution; no measurable budget increase is allowed.
		assert.ok(p50 <= 16.7 || p50 - 16.7 <= 1e-9, `${quality} fog ${fog} p50 ${p50}`)
		assert.ok(worst <= 50, `${quality} fog ${fog} worst ${worst}`)
		// Delivered frames over the same fixed window. Each missed display
		// refresh shows up here, while p95 sits on the one/two-refresh boundary.
		const fps = 1000 * row.samples.length / row.samples.reduce((sum, value) => sum + value, 0)
		if (frameDelayMs > 0) assert.ok(Math.abs(row.realizedFrameDelayMs - frameDelayMs) <= 0.2 * frameDelayMs, `Calibration delay realised ${row.realizedFrameDelayMs} ms, not ${frameDelayMs} ms`)
		if (dropEvery > 0) assert.ok(row.realizedDroppedFrames >= 8, `Calibration skipped only ${row.realizedDroppedFrames} frames`)
		arms.push({
			quality, fog, map, restart,
			p50: +p50.toFixed(2), worst: +worst.toFixed(2), p95: +pct(row.samples, 0.95).toFixed(2), p99: +pct(row.samples, 0.99).toFixed(2),
			frames: row.samples.length, fps: +fps.toFixed(3), missedRefreshes: row.samples.filter(value => value > 1.5 * p50).length,
			injectedFrameDelayMs: frameDelayMs, realizedFrameDelayMs: +row.realizedFrameDelayMs.toFixed(4),
			injectedDropEvery: dropEvery, realizedDroppedFrames: row.realizedDroppedFrames,
			actors: row.actors, loaded: row.loaded, fallback: row.fallback, scale: row.scale,
			measuredMs, discardMs, preheatMs, warmupMs, canvas: row.start.canvas,
			audioReady: row.start.audioReady,
			qualityState: settings(row.end.quality),
			cameraStart: row.start.camera, cameraEnd: row.end.camera,
		})
		console.log(quality, 'fog', fog, 'p50', p50.toFixed(2), 'worst', worst.toFixed(1), 'fps', fps.toFixed(2), 'actors', row.actors, 'blender', row.loaded)
		await context.close()
	}
	console.log(JSON.stringify({ pass: true, headless, arms }))
} catch (error) {
	diagnostic('failure', error.stack)
	throw error
} finally {
	if (diagnosticPath) writeFileSync(diagnosticPath, JSON.stringify({ schema: 1, headless, base, diagnostics }, null, 2))
	await browser.close()
}
