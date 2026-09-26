#!/usr/bin/env node
// STEELSEED — tools/profile
// Gameplay presentation profiler. Measures; it does not tune and it does not turn the
// §7 budgets into assertions.
//
// Fixed workload:
//   1512×982 CSS pixels, DPR 2, high preset
//   ?devmap=1&seed=demo&devsize=96
//   30 warm-up frames + 240 measured frames, camera moving throughout
//
// Usage:
//   node tools/profile.mjs [--url u] [--port n] [--json] [--keep-server]

import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { spawnProcessGroup, stopProcessGroup } from './process-group.mjs'

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const WIDTH = 1512
const HEIGHT = 982
const DPR = 2
const WARMUP_FRAMES = 30
const MEASURED_FRAMES = 240
const BOOT_TIMEOUT_MS = 120000
const RUN_STARTED_AT = new Date().toISOString()

const VALUE_FLAGS = new Set(['url', 'port', 'actors', 'cluster', 'size', 'quality', 'tod', 'roster'])
const flags = new Map()
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i]
	if (!arg.startsWith('--'))
		throw new Error(`profile: unknown positional argument '${arg}'`)

	const body = arg.slice(2)
	const eq = body.indexOf('=')
	const name = eq === -1 ? body : body.slice(0, eq)
	if (VALUE_FLAGS.has(name)) {
		const value = eq === -1 ? argv[++i] : body.slice(eq + 1)
		if (value == null || value === '')
			throw new Error(`profile: --${name} requires a value`)
		flags.set(name, value)
	} else if (name === 'json' || name === 'keep-server')
		flags.set(name, true)
	else
		throw new Error(`profile: unknown flag --${name}`)
}

const flag = (name, fallback) => flags.has(name) ? flags.get(name) : fallback
const port = positiveInteger(flag('port', 8379), 'port')
const suppliedUrl = flag('url', null)
const roster = flag('roster', 'procedural')
if (!['procedural', 'blender'].includes(roster)) throw new Error('profile: --roster must be procedural or blender')

// The workload is a PARAMETER, not a constant. §7.1's budget is defined on a 200-unit
// engagement and §11.3 records that workload as UNMEASURED — every figure this tool has
// ever published came from the 24-actor devmap default, which is a presentation scene
// with no engagement in it. Pinning the query made the tool unable to measure the thing
// the budget is written against. Defaults are unchanged, so historical runs still repro.
const WORKLOAD_QUERY = { devmap: '1', seed: 'demo', devsize: String(flag('size', 96)), quality: String(flag('quality', 'high')) }
if (flags.has('actors')) WORKLOAD_QUERY.devactors = String(positiveInteger(flag('actors'), 'actors'))
if (flags.has('cluster')) WORKLOAD_QUERY.devcluster = String(positiveInteger(flag('cluster'), 'cluster'))
// Headlamps are gated on sky light level, not clock time, so dynamic lights simply do not
// exist at the 09:00 default — which is why every historical capture reports lights: 0.
// Measuring the light path at all requires driving time of day from here.
if (flags.has('tod')) WORKLOAD_QUERY.devtod = String(flag('tod'))
const WORKLOAD_LABEL = '?' + new URLSearchParams(WORKLOAD_QUERY).toString()
const baseUrl = suppliedUrl ?? `http://127.0.0.1:${port}/`
const asJson = flags.has('json')

let chromium
try {
	;({ chromium } = await import('playwright'))
} catch {
	console.error(
		'profile: playwright is not installed.\n' +
			'  cd web && npm install && npx playwright install chromium',
	)
	process.exit(2)
}

let server = null
let browser = null
let exitCode = 0

try {
	// REFUSE an occupied port rather than measuring whatever is already there.
	//
	// `vite preview --strictPort` exits when the port is taken, but `waitForServer` polls the
	// URL and the OLDER server answers — so this tool silently measures an unknown build.
	// That is the trap RESUME-CLAUDE records, and it bit three times in one session because
	// it is SELF-PERPETUATING: profile leaks its own server on a failure path, the next run
	// finds the port occupied, talks to the stale server, and fails the same way.
	//
	// The failure mode is the dangerous shape — a plausible number from the wrong build, or
	// here a boot timeout that sends the diagnosis after the app while the app is fine.
	if (suppliedUrl == null) {
		const occupied = await fetch(baseUrl, { method: 'HEAD' })
			.then(() => true)
			.catch(() => false)
		if (occupied) {
			console.error(`profile: FAIL — something is already serving ${baseUrl}.`)
			console.error('profile: refusing to run, because vite preview --strictPort would exit and this')
			console.error('profile: tool would then measure whatever that other server is serving.')
			console.error(`profile: find it with  lsof -nP -iTCP:${port} -sTCP:LISTEN  and kill it, or pass --port.`)
			process.exit(2)
		}
	}

	if (suppliedUrl == null) {
		// Direct binary: the repo-root npm workspaces glob can break npx through no fault
		// of this project (duplicate workspace names in sibling checkouts).
		server = spawnProcessGroup(process.execPath, [
			join(WEB_ROOT, 'node_modules/.bin/vite'), 'preview',
			'--host', '127.0.0.1',
			'--port', String(port),
			'--strictPort',
		], {
			cwd: WEB_ROOT,
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		await waitForServer(baseUrl, 20000, server)
	}

	const launched = await launchBrowser()
	browser = launched.browser

	const context = await browser.newContext({
		viewport: { width: WIDTH, height: HEIGHT },
		deviceScaleFactor: DPR,
		locale: 'en-US',
		timezoneId: 'UTC',
	})
	const page = await context.newPage()
	const pageErrors = []

	page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`))
	page.on('console', (message) => {
		if (message.type() === 'error' && !/^Failed to load resource:/.test(message.text()))
			pageErrors.push(`console.error: ${message.text()}`)
	})
	page.on('response', (response) => {
		if (response.status() < 400)
			return

		const failedUrl = new URL(response.url())
		// Chrome requests this without an HTML declaration. STEELSEED deliberately ships
		// no binary icon (rule 13); every other failed response remains fatal.
		if (failedUrl.pathname === '/favicon.ico')
			return

		pageErrors.push(`HTTP ${response.status()}: ${response.url()}`)
	})

	// App.main() starts an rAF loop immediately after publishing globalThis.steelseed.
	// Hold those callbacks until the profiler takes ownership, otherwise an unmeasured
	// frame can present before the "cold boot to first frame" measurement begins.
	await page.addInitScript(() => {
		const nativeRaf = globalThis.requestAnimationFrame.bind(globalThis)
		const nativeCancel = globalThis.cancelAnimationFrame.bind(globalThis)
		let nextId = 1
		const pending = new Set()

		globalThis.requestAnimationFrame = () => {
			const id = nextId++
			pending.add(id)
			return id
		}
		globalThis.cancelAnimationFrame = (id) => {
			pending.delete(id)
		}
		globalThis.__steelseedProfileRestoreRaf = () => {
			globalThis.requestAnimationFrame = nativeRaf
			globalThis.cancelAnimationFrame = nativeCancel
			pending.clear()
		}
	})

	const url = new URL(baseUrl)
	for (const [key, value] of Object.entries(WORKLOAD_QUERY))
		url.searchParams.set(key, value)

	await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 })

	// Wait for boot from the NODE side, not from inside the page.
	//
	// This used to be a `while (globalThis.steelseed === undefined)` loop inside the same
	// evaluate as the render, yielding on `setTimeout(0)`. It stopped working — the loop ran
	// its full 120 s and never saw the app, while a harness using this exact URL, this exact
	// rAF stub and the same viewport booted cleanly every time. See issues/tools-visual-1.md
	// for what was ruled out: it is not the archetype wiring (stashed and reproduced), not an
	// orphaned server (killed and reproduced), and not the renderer (capture and todgate both
	// pass).
	//
	// A tight `setTimeout(0)` poll inside the page competes with the boot chain's own
	// continuations for the same task queue. `waitForFunction` polls from outside the page
	// instead, so the page's event loop is left alone to finish booting.
	//
	// This does NOT weaken the one-evaluate rule the block below depends on. That rule exists
	// because a WebGPU canvas is not preserved across a task boundary, so RENDER and READ
	// must share an evaluate. Waiting for boot touches no canvas.
	if (process.env.PROFILE_DEBUG) {
		page.on('console', m => console.error('  [page]', m.type(), m.text().slice(0, 220)))
		page.on('pageerror', e => console.error('  [pageerror]', e.message.slice(0, 300)))
		page.on('requestfailed', r => console.error('  [reqfail]', r.url().slice(-70), r.failure()?.errorText))
	}
	const bootFailure = await page
		.waitForFunction(
			() => {
				const el = document.getElementById('boot-fail')
				if (el && !el.hidden && el.textContent) return { failed: el.textContent }
				return globalThis.steelseed === undefined ? false : { failed: null }
			},
			// Options are the THIRD argument. Passing them second makes them the page
			// function's ARG and silently applies the defaults — including `polling: 'raf'`,
			// which never fires here because the init script above stubs rAF out so frames
			// can be driven manually. The predicate then never runs at all, and the failure
			// reads as "the app did not boot" while the app boots perfectly.
			undefined,
			{ timeout: BOOT_TIMEOUT_MS, polling: 100 },
		)
		.then(h => h.jsonValue())
		.catch(async err => {
			// Report the REAL error. An unconditional catch here turned every failure —
			// serialization, a destroyed execution context, anything — into "did not boot",
			// which sent the diagnosis after the app while the app was booting fine.
			const seen = await page.evaluate(() => ({
				steelseed: typeof globalThis.steelseed,
				keys: Object.keys(globalThis).filter(k => /steel|ora/i.test(k)),
				readyState: document.readyState,
			})).catch(e => ({ probeFailed: e.message }))
			throw new Error(`profile: boot wait failed — ${err.message.slice(0, 200)} | page: ${JSON.stringify(seen)}`)
		})
	if (bootFailure.failed) throw new Error(`profile: boot failed: ${bootFailure.failed}`)

	// Rendering, GPU validation, timing and BOTH pixel reads intentionally happen in
	// this one evaluate. A WebGPU canvas is presented at task boundaries and is not
	// preserved; reading it in a later evaluate turns a real frame into maxChannel=0.
	const raw = await page.evaluate(
		async ({ warmupFrames, measuredFrames, roster }) => {
			const app = globalThis.steelseed
			if (app === undefined) throw new Error('profile: app vanished between the boot wait and the render')
			const appReadyMs = performance.now()
			app.stop()
			globalThis.__steelseedProfileRestoreRaf?.()

			const device = app.ctx.device
			if (app.ctx.backend !== 'webgpu' || device == null)
				throw new Error(`profile requires WebGPU; selected backend=${app.ctx.backend}`)

			const render = app.ctx.get('render')
			const materials = app.ctx.get('materials')
			const units = app.ctx.get('units')
			const blenderNames = ['2tnk', '3tnk', '4tnk', 'harv', 'jeep', 'e1', 'e2', 'dog', 'arty', 'apc', 'mcv', 'powr', 'proc', 'afld', 't01', 't03', 'rock1']
			if (roster === 'blender') {
				if (units.forgeStats.loaded !== 275 || units.forgeStats.fallback !== 0) throw new Error('Blender profile requires the complete loaded asset pack')
				// This is a rendering workload, not an OpenRA simulation benchmark. Retain
				// the fixture's actor count, positions and motion but resolve its type IDs
				// to a stated mix of the actual shipping Blender geometry and rigs.
				app.ctx.actorTypeName = id => blenderNames[id % blenderNames.length]
				units.typeClass.clear()
				if (app.ctx.snapshot) units.onSnapshot(app.ctx.snapshot, null, app.ctx)
			}
			const uncaptured = []
			device.addEventListener('uncapturederror', (event) => {
				uncaptured.push(event.error?.message ?? String(event.error))
			})

			const pixelCanvas = document.createElement('canvas')
			pixelCanvas.width = 64
			pixelCanvas.height = 64
			const pixelContext = pixelCanvas.getContext('2d')
			if (pixelContext == null)
				throw new Error('could not create the 2D pixel-verification context')

			const readPixels = () => {
				const canvas = app.ctx.canvas
				pixelContext.clearRect(0, 0, 64, 64)
				pixelContext.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, 64, 64)
				const data = pixelContext.getImageData(0, 0, 64, 64).data
				let maxChannel = 0
				let nonBlack = 0
				const distinct = new Set()
				for (let i = 0; i < data.length; i += 4) {
					const max = Math.max(data[i], data[i + 1], data[i + 2])
					if (max > maxChannel) maxChannel = max
					if (max > 0) nonBlack++
					distinct.add(`${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`)
				}
				return {
					maxChannel,
					nonBlack,
					total: data.length / 4,
					distinctBuckets: distinct.size,
				}
			}

			let playFrame = 0
			const runFrame = async (phase, phaseFrame, capturePixels = false) => {
				device.pushErrorScope('validation')
				const frameStart = performance.now()
				let cpuEnd
				let scopePromise
				let pixels = null
				let presentedAtMs = null
				try {
					app.renderOneFrame(frameStart)
					cpuEnd = performance.now()
					// No await between render and read. An await yields the task, which
					// presents then discards the non-preserved WebGPU canvas before
					// drawImage() can observe it — even inside the same page.evaluate.
					if (capturePixels) {
						pixels = readPixels()
						presentedAtMs = performance.now()
					}
					scopePromise = device.popErrorScope()
				} catch (error) {
					const validation = await device.popErrorScope().catch(() => null)
					const suffix = validation ? `; GPU validation: ${validation.message}` : ''
					throw new Error(`${phase} frame ${phaseFrame} threw: ${error.message}${suffix}`)
				}

				// Serial queue completion makes this an end-to-end frame-time measurement,
				// not just JS command-recording throughput. CPU submission is retained as
				// a separate number so the two are never conflated.
				await device.queue.onSubmittedWorkDone()
				const validation = await scopePromise
				const frameEnd = performance.now()
				if (validation != null)
					throw new Error(
						`GPU validation error at ${phase} frame ${phaseFrame}: ${validation.message}`,
					)

				const stats = render.stats
				const record = {
					phase,
					phaseFrame,
					playFrame,
					frameMs: frameEnd - frameStart,
					cpuMs: cpuEnd - frameStart,
					drawCalls: stats.drawCalls,
					triangles: stats.triangles,
					lights: stats.lights,
					pipelineCreations: stats.pipelineCreations,
					lodMain: Array.from(render.lodStats.mainInstances),
					lodShadow: Array.from(render.lodStats.shadowInstances),
					pixels,
					presentedAtMs,
				}
				playFrame++
				return record
			}

			// First explicit post-prewarm frame. rAF has been blocked since navigation, so
			// this is the first frame that can reach the presentation surface.
			const firstFrame = await runFrame('first', 0, true)
			const firstPixels = firstFrame.pixels
			const coldBootToFirstPresentedMs = firstFrame.presentedAtMs
			if (firstPixels.maxChannel === 0 || firstPixels.distinctBuckets <= 1)
				throw new Error(
					`first frame did not present scene pixels: max=${firstPixels.maxChannel}, ` +
					`buckets=${firstPixels.distinctBuckets}`,
				)

			const warmup = []
			let activeKey = ''
			const setDirection = (code) => {
				if (activeKey)
					window.dispatchEvent(new KeyboardEvent('keyup', { code: activeKey }))
				activeKey = code
				window.dispatchEvent(new KeyboardEvent('keydown', { code }))
			}

			// Camera motion is part of the workload. A static-camera median is banned:
			// culling, cascade fitting and terrain visibility must change during the run.
			const directions = ['KeyD', 'KeyS', 'KeyA', 'KeyW']
			setDirection(directions[0])
			for (let i = 0; i < warmupFrames; i++) {
				if (i > 0 && i % 10 === 0)
					setDirection(directions[(i / 10) % directions.length])
				warmup.push(await runFrame('warmup', i))
			}

			const measured = []
			let cameraX = render.camera.position[0]
			let cameraZ = render.camera.position[2]
			let cameraPathMetres = 0
			for (let i = 0; i < measuredFrames; i++) {
				if (i % 30 === 0)
					setDirection(directions[(i / 30) % directions.length])
				measured.push(await runFrame('measured', i))
				const nextX = render.camera.position[0]
				const nextZ = render.camera.position[2]
				cameraPathMetres += Math.hypot(nextX - cameraX, nextZ - cameraZ)
				cameraX = nextX
				cameraZ = nextZ
			}
			window.dispatchEvent(new KeyboardEvent('keyup', { code: activeKey }))

			// Pixel readback is synchronous and expensive, so it gets its own validated
			// frame after the fixed measurement window. Including it in frame 239 would
			// manufacture a fake "worst render frame" out of profiler overhead.
			const pixelFrame = await runFrame('pixel', 0, true)
			const finalPixels = pixelFrame.pixels
			if (finalPixels.maxChannel === 0 || finalPixels.distinctBuckets <= 1)
				throw new Error(
					`final frame did not present scene pixels: max=${finalPixels.maxChannel}, ` +
					`buckets=${finalPixels.distinctBuckets}`,
				)
			if (uncaptured.length > 0)
				throw new Error(`uncaptured GPU error: ${uncaptured[0]}`)

			return {
				roster, assetNames: roster === 'blender' ? blenderNames : null,
				forge: { ...units.forgeStats }, scenery: { ...units.sceneryStats },
				skin: { ...units.skinStats },
				actorCount: app.ctx.snapshot?.actors?.count ?? 0,
				userAgent: navigator.userAgent,
				backend: app.ctx.backend,
				quality: app.config.q.name,
				devicePixelRatio: app.config.devicePixelRatio,
				canvas: {
					cssWidth: app.ctx.canvas.clientWidth,
					cssHeight: app.ctx.canvas.clientHeight,
					width: app.ctx.canvas.width,
					height: app.ctx.canvas.height,
				},
				appReadyMs,
				coldBootToFirstPresentedMs,
				cameraPathMetres,
				firstPixels,
				finalPixels,
				materialsVramBytes: materials.totalVramBytes,
				geometryVramBytes: render.geometryVramBytes,
				firstFrame,
				warmup,
				measured,
				pixelFrame,
			}
		},
		{
			warmupFrames: WARMUP_FRAMES,
			measuredFrames: MEASURED_FRAMES,
			roster,
		},
	)

	if (pageErrors.length > 0)
		throw new Error(pageErrors[0])

	const report = buildReport(raw, launched.label)
	if (asJson)
		console.log(JSON.stringify(report, null, 2))
	else
		printReport(report)

	try {
		const page = (await context.pages())[0] ?? await context.newPage()
		await page.screenshot({ path: process.env.WORLD_SHOT ?? '/tmp/world-prof.webp' })
		console.log('profile: world screenshot saved')
	} catch (e) {
		console.error('profile: screenshot failed:', String(e).slice(0, 120))
	}

	await context.close()
} catch (error) {
	console.error(`profile: FAIL — ${error.message}`)
	exitCode = 1
} finally {
	if (browser != null)
		await browser.close()
	if (server != null && !flags.has('keep-server'))
		await stopProcessGroup(server)
}

process.exit(exitCode)

function buildReport(raw, browserLabel) {
	const frameMs = raw.measured.map((frame) => frame.frameMs)
	const cpuMs = raw.measured.map((frame) => frame.cpuMs)
	const pipelineFrames = [raw.firstFrame, ...raw.warmup, ...raw.measured, raw.pixelFrame]
		.filter((frame) => frame.pipelineCreations !== 0)
	const slowestFrame = raw.measured.reduce(
		(slowest, frame) => frame.frameMs > slowest.frameMs ? frame : slowest,
		raw.measured[0],
	)

	return {
		measuredAt: RUN_STARTED_AT,
		workload: {
			roster: raw.roster, assetNames: raw.assetNames, actorCount: raw.actorCount,
			query: WORKLOAD_LABEL,
			measuredFrames: MEASURED_FRAMES,
			warmupFrames: WARMUP_FRAMES,
			camera: 'moving (D/S/A/W, direction changes every 30 measured frames)',
			browser: browserLabel,
			userAgent: raw.userAgent,
			backend: raw.backend,
			quality: raw.quality,
			devicePixelRatio: raw.devicePixelRatio,
			canvas: raw.canvas,
		},
		forge: raw.forge, scenery: raw.scenery, skin: raw.skin,
		coldBootToFirstPresentedMs: raw.coldBootToFirstPresentedMs,
		cameraPathMetres: raw.cameraPathMetres,
		firstPixels: raw.firstPixels,
		finalPixels: raw.finalPixels,
		frameTimeMs: distribution(frameMs),
		slowestFrame: {
			frame: slowestFrame.phaseFrame,
			frameMs: slowestFrame.frameMs,
		},
		frameRateFps: {
			p50: 1000 / percentile(frameMs, 0.5),
			p95FrameEquivalent: 1000 / percentile(frameMs, 0.95),
			p99FrameEquivalent: 1000 / percentile(frameMs, 0.99),
		},
		cpuSubmitMs: distribution(cpuMs),
		pipelineCreations: {
			total: pipelineFrames.reduce((sum, frame) => sum + frame.pipelineCreations, 0),
			frames: pipelineFrames.map((frame) => ({
				phase: frame.phase,
				frame: frame.phaseFrame,
				count: frame.pipelineCreations,
			})),
		},
		drawCalls: counterSummary(raw.measured, 'drawCalls'),
		triangles: counterSummary(raw.measured, 'triangles'),
		lights: counterSummary(raw.measured, 'lights'),
		materialsVramBytes: raw.materialsVramBytes,
		materialsVramMiB: raw.materialsVramBytes / (1024 * 1024),
		geometryVramBytes: raw.geometryVramBytes,
		geometryVramMiB: raw.geometryVramBytes / (1024 * 1024),
		lod: {
			mainP50: lodPercentiles(raw.measured, 'lodMain'),
			shadowP50: lodPercentiles(raw.measured, 'lodShadow'),
		},
		perFrameCounters: compactCounterRuns(raw.measured),
	}
}

function printReport(report) {
	const w = report.workload
	console.log(`profile: measured at ${report.measuredAt}`)
	console.log(`profile: ${w.roster} rendering fixture, ${w.actorCount} actors; excludes OpenRA simulation CPU cost`)
	console.log(
		`profile: ${w.quality}/${w.backend}, ${w.canvas.cssWidth}x${w.canvas.cssHeight} CSS ` +
		`@${w.devicePixelRatio}x -> ${w.canvas.width}x${w.canvas.height}, ${w.browser}`,
	)
	console.log(
		`profile: workload ${w.query}, ${w.measuredFrames} measured + ${w.warmupFrames} warm-up frames, ` +
		`camera path ${fmt(report.cameraPathMetres)} m`,
	)
	console.log(
		`profile: cold boot -> prewarmed app ${fmt(report.appReadyMs)} ms; ` +
		`first pixel-proven frame ${fmt(report.coldBootToFirstPresentedMs)} ms ` +
		`(maxChannel ${report.firstPixels.maxChannel}, ${report.firstPixels.nonBlack}/${report.firstPixels.total} non-black, ` +
		`${report.firstPixels.distinctBuckets} colour buckets)`,
	)
	console.log(
		`profile: frame time GPU-complete p50 ${fmt(report.frameTimeMs.p50)} ms ` +
		`(${fmt(report.frameRateFps.p50)} fps), p95 ${fmt(report.frameTimeMs.p95)} ms, ` +
		`p99 ${fmt(report.frameTimeMs.p99)} ms, worst ${fmt(report.frameTimeMs.max)} ms ` +
		`(frame ${report.slowestFrame.frame})`,
	)
	console.log(
		`profile: CPU submit p50 ${fmt(report.cpuSubmitMs.p50)} ms, ` +
		`p95 ${fmt(report.cpuSubmitMs.p95)} ms, p99 ${fmt(report.cpuSubmitMs.p99)} ms, ` +
		`worst ${fmt(report.cpuSubmitMs.max)} ms`,
	)
	if (report.pipelineCreations.frames.length === 0)
		console.log('profile: pipeline creations during play 0')
	else {
		const frames = report.pipelineCreations.frames
			.map((frame) => `${frame.phase}[${frame.frame}]=${frame.count}`)
			.join(', ')
		console.log(`profile: pipeline creations during play ${report.pipelineCreations.total}; frames: ${frames}`)
	}
	console.log(
		`profile: draw calls min/p50/p95/max ${counterLine(report.drawCalls)}; ` +
		`triangles ${counterLine(report.triangles)}; lights ${counterLine(report.lights)}`,
	)
	console.log(
		`profile: materials VRAM ${formatBytes(report.materialsVramBytes)} ` +
		`(${fmt(report.materialsVramMiB)} MiB)`,
	)
	console.log(
		`profile: geometry VRAM ${formatBytes(report.geometryVramBytes)} ` +
		`(${fmt(report.geometryVramMiB)} MiB); LOD p50 main=${report.lod.mainP50.join('/')} ` +
		`shadow=${report.lod.shadowP50.join('/')}`,
	)
	console.log(
		`profile: final pixels maxChannel ${report.finalPixels.maxChannel}, ` +
		`${report.finalPixels.nonBlack}/${report.finalPixels.total} non-black, ` +
		`${report.finalPixels.distinctBuckets} colour buckets`,
	)
	console.log('profile: per-frame counters (measured frame ranges):')
	for (const run of report.perFrameCounters)
		console.log(
			`  ${run.first === run.last ? run.first : `${run.first}-${run.last}`}: ` +
			`draws=${run.drawCalls} triangles=${run.triangles} lights=${run.lights} pipelines=${run.pipelineCreations}`,
		)
}

function distribution(values) {
	return {
		min: Math.min(...values),
		p50: percentile(values, 0.5),
		p95: percentile(values, 0.95),
		p99: percentile(values, 0.99),
		max: Math.max(...values),
	}
}

/** Nearest-rank percentile, reported against the fixed frame count. */
function percentile(values, p) {
	const sorted = [...values].sort((a, b) => a - b)
	const index = Math.max(0, Math.ceil(p * sorted.length) - 1)
	return sorted[index]
}

function counterSummary(frames, key) {
	const values = frames.map((frame) => frame[key])
	return {
		min: Math.min(...values),
		p50: percentile(values, 0.5),
		p95: percentile(values, 0.95),
		max: Math.max(...values),
	}
}

function lodPercentiles(frames, key) {
	const levels = frames[0]?.[key]?.length ?? 0
	const out = []
	for (let level = 0; level < levels; level++)
		out.push(percentile(frames.map(frame => frame[key][level]), 0.5))
	return out
}

function compactCounterRuns(frames) {
	const runs = []
	for (const frame of frames) {
		const previous = runs.at(-1)
		if (
			previous != null &&
			previous.drawCalls === frame.drawCalls &&
			previous.triangles === frame.triangles &&
			previous.lights === frame.lights &&
			previous.pipelineCreations === frame.pipelineCreations
		) {
			previous.last = frame.phaseFrame
			continue
		}

		runs.push({
			first: frame.phaseFrame,
			last: frame.phaseFrame,
			drawCalls: frame.drawCalls,
			triangles: frame.triangles,
			lights: frame.lights,
			pipelineCreations: frame.pipelineCreations,
		})
	}
	return runs
}

function counterLine(summary) {
	return `${summary.min}/${summary.p50}/${summary.p95}/${summary.max}`
}

function fmt(value) {
	return Number(value).toFixed(2)
}

function formatBytes(bytes) {
	if (bytes >= 1024 * 1024)
		return `${fmt(bytes / (1024 * 1024))} MiB`
	if (bytes >= 1024)
		return `${fmt(bytes / 1024)} KiB`
	return `${bytes} B`
}

function positiveInteger(value, name) {
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed <= 0)
		throw new Error(`profile: --${name} must be a positive integer (received '${value}')`)
	return parsed
}

async function launchBrowser() {
	const launchOptions = {
		headless: true,
		args: [
			'--use-angle=metal',
			'--enable-unsafe-webgpu',
			'--enable-features=Vulkan,UseSkiaRenderer',
			'--ignore-gpu-blocklist',
			'--enable-gpu-rasterization',
			'--disable-gpu-sandbox',
		],
	}

	try {
		return {
			browser: await chromium.launch(launchOptions),
			label: 'playwright chromium',
		}
	} catch (error) {
		if (!/Executable doesn't exist|please run|install/i.test(String(error.message)))
			throw error

		return {
			browser: await chromium.launch({ ...launchOptions, channel: 'chrome' }),
			label: 'installed chrome (playwright chromium absent)',
		}
	}
}

async function waitForServer(url, timeoutMs, child) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (child.exitCode != null)
			throw new Error(`vite preview exited early with code ${child.exitCode}`)
		try {
			const response = await fetch(url, {
				method: 'GET',
				cache: 'no-store',
				signal: AbortSignal.timeout(1000),
			})
			await response.body?.cancel()
			if (response.ok)
				return
		} catch {
			// Preview server is still starting.
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 100))
	}
	throw new Error(`vite preview did not start at ${url} within ${timeoutMs}ms — run 'npm --prefix web run build'`)
}
