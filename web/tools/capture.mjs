#!/usr/bin/env node
// STEELSEED — tools/capture
// One named shot via GPU-backed headless Chromium.
//
// Hard rule 8: `node web/tools/capture.mjs` must produce a frame after your change, or
// nobody else can work. This is the cheapest possible "is the boot still alive" gate
// and every node runs it.
//
// GPU-backed matters. Headless Chromium defaults to SwiftShader, which does not
// implement WebGPU compute the way a real adapter does, so a SwiftShader capture would
// silently validate a renderer that cannot run on hardware.
//
// Usage:
//   node tools/capture.mjs [shot] [--out dir] [--url u] [--width w] [--height h]
//                          [--dpr n] [--quality low|medium|high] [--seed s]
//                          [--frames n] [--deterministic] [--keep-server]

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnProcessGroup, stopProcessGroup } from './process-group.mjs'

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const VALUE_FLAGS = new Set([
	'out', 'url', 'width', 'height', 'dpr', 'quality', 'seed', 'frames', 'port',
	'devtod', 'devweather', 'devweatherintensity', 'devwinddir', 'devwindspeed',
])
const argv = process.argv.slice(2)
const flags = new Map()
const positional = []
for (let i = 0; i < argv.length; i++) {
	const a = argv[i]
	if (a.startsWith('--')) {
		const body = a.slice(2)
		// Both `--k v` and `--k=v`. Without the `=` form, `--url=http://host` parsed as a
		// boolean flag named "url=http://host", the real `url` stayed unset, and the tool
		// failed against the default port with a misleading "did you build?" message.
		const eq = body.indexOf('=')
		if (eq !== -1) flags.set(body.slice(0, eq), body.slice(eq + 1))
		else if (VALUE_FLAGS.has(body)) flags.set(body, argv[++i])
		else flags.set(body, true)
	} else positional.push(a)
}
const flag = (n, d) => (flags.has(n) ? flags.get(n) : d)

const shot = positional[0] ?? 'default'
const outDir = resolve(flag('out', join(WEB_ROOT, 'shots')))
const width = Number(flag('width', 1512))
const height = Number(flag('height', 982))
const dpr = Number(flag('dpr', 2))
const quality = flag('quality', 'high')
const seed = flag('seed', 'steelseed-default')
const frames = Number(flag('frames', 30))
const deterministic = flags.has('deterministic')
const port = Number(flag('port', 8377))

/**
 * Playwright is a devDependency and must never be assumed present in a fresh clone —
 * failing with a clear instruction beats a bare MODULE_NOT_FOUND on someone's first run.
 */
let chromium
try {
	;({ chromium } = await import('playwright'))
} catch {
	console.error(
		'capture: playwright is not installed.\n' +
			'  cd web && npm install && npx playwright install chromium',
	)
	process.exit(2)
}

// `--no-devmap` captures the empty-world path deliberately (e.g. checking the boot screen).
const devmap = !flags.has('no-devmap')

const url = flag('url', null) ?? `http://127.0.0.1:${port}/`
let server = null

async function waitForServer(u, timeoutMs, child) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		// Both fields, not just exitCode. A process killed by a signal reports exitCode
		// null and signalCode set, so an exitCode-only check misses it and falls back to
		// burning the full 20s timeout — the exact wait this early-exit check removes.
		// process-group.mjs:58 already tests both; this is the caller catching up.
		if (child.exitCode != null || child.signalCode != null)
			throw new Error(
				`capture: vite preview exited early (${child.signalCode ?? `code ${child.exitCode}`}). ` +
				`Port ${port} may be in use — --strictPort makes vite exit rather than pick another.`,
			)
		try {
			const r = await fetch(u, {
				method: 'GET',
				cache: 'no-store',
				signal: AbortSignal.timeout(1000),
			})
			await r.body?.cancel()
			if (r.ok) return
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, 150))
	}
	throw new Error(`capture: server did not come up at ${u} within ${timeoutMs}ms — did you run 'npm run build'?`)
}

const launchOptions = {
	headless: true,
	args: [
		// Force a real GPU. Without these headless Chromium falls back to SwiftShader
		// and WebGPU either vanishes or behaves unlike any shipping device.
		'--use-angle=metal',
		'--enable-unsafe-webgpu',
		'--enable-features=Vulkan,UseSkiaRenderer',
		'--ignore-gpu-blocklist',
		'--enable-gpu-rasterization',
		'--disable-gpu-sandbox',
	],
}

/**
 * Prefer Playwright's pinned Chromium; fall back to the system Chrome install.
 *
 * `npx playwright install` downloads a browser keyed to the exact playwright version, and
 * a machine that has Chrome but not that revision would otherwise fail the boot gate for a
 * reason that has nothing to do with STEELSEED. The fallback is reported, not silent —
 * the two builds are not pixel-identical, so a baseline captured under one must not be
 * compared against the other without knowing.
 */
let browser = null
const errors = []
let exitCode = 0

try {
	if (!flags.has('url')) {
		// `--host 127.0.0.1` is load-bearing. Without it vite binds whatever
		// `localhost` resolves to, which may be a different socket from this URL.
		server = spawnProcessGroup(process.execPath, [
			join(WEB_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview',
			'--host', '127.0.0.1',
			'--port', String(port),
			'--strictPort',
		], {
			cwd: WEB_ROOT,
			stdio: 'ignore',
		})
		// Vite preview serves the built bundle; a dev server would capture unminified,
		// differently-chunked output and could not be compared against a release baseline.
		await waitForServer(url, 20000, server)
	}

	try {
		browser = await chromium.launch(launchOptions)
	} catch (err) {
		if (!/Executable doesn't exist|please run|install/i.test(String(err.message))) throw err
		browser = await chromium.launch({ ...launchOptions, channel: 'chrome' })
		console.warn("capture: playwright's pinned Chromium is missing — using the installed Chrome (channel: 'chrome').")
		console.warn('  Pixel output may differ from a baseline captured on pinned Chromium. `npx playwright install chromium` to pin.')
	}

	const context = await browser.newContext({
		viewport: { width, height },
		deviceScaleFactor: deterministic ? 1 : dpr,
		// A fixed locale/timezone removes two more sources of run-to-run variance.
		locale: 'en-US',
		timezoneId: 'UTC',
	})
	const page = await context.newPage()

	// Any page error is a capture failure. A frame that renders while the console is
	// full of exceptions is exactly the state rule 8 exists to catch.
	page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
	page.on('console', (m) => {
		if (m.type() !== 'error') return
		// A failed subresource logs a generic "Failed to load resource: ... 404" with no
		// URL attached. Dropping it here loses nothing: the response listener below sees
		// every HTTP >= 400 WITH its URL and reports those instead. Keeping both would
		// double-count and would make the browser's own favicon probe unfilterable.
		if (/^Failed to load resource:/.test(m.text())) return
		errors.push(`console.error: ${m.text()}`)
	})
	// Every real HTTP failure fails the gate, identified by URL. The single exception is
	// /favicon.ico: Chrome requests it automatically for any page, STEELSEED ships no
	// binary assets of any kind (rule 13) so there is nothing to serve, and it is the
	// browser's request rather than the bundle's. Nothing else is exempt.
	page.on('response', (res) => {
		if (res.status() < 400) return
		const path = new URL(res.url()).pathname
		if (path === '/favicon.ico') return
		errors.push(`http ${res.status()}: ${res.url()}`)
	})

	const params = new URLSearchParams({ quality, seed, shot })
	if (deterministic) params.set('deterministic', '1')
	// On by default: without a world there is nothing to draw, and a gate that photographs
	// an empty sky cannot tell a working renderer from a broken one. `?devmap=1` serves a
	// generated snapshot in the real §4 binary layout, so terrain, materials and render all
	// run their production paths. main.ts prefers a live `steelseedBridge` when one exists,
	// so this is inert under the real WASM host rather than overriding it.
	if (devmap) params.set('devmap', '1')
	// §4.2 overrides, forwarded verbatim so a shot can pin the atmosphere. These drive the
	// real snapshot path — `sky` reads §4.2 and nothing else — so `--devtod=330` proves a
	// dawn frame rather than proving that a test hook can be called.
	for (const key of ['devtod', 'devweather', 'devweatherintensity', 'devwinddir', 'devwindspeed']) {
		const v = flag(key, null)
		if (v !== null) params.set(key, String(v))
	}

	await page.goto(`${url}?${params}`, { waitUntil: 'load', timeout: 60000 })

	// Wait for the app to publish itself, which happens only after boot + prewarm.
	await page
		.waitForFunction(() => globalThis.steelseed !== undefined, { timeout: 120000 })
		.catch(() => {
			throw new Error('capture: app never booted (globalThis.steelseed undefined after 120s)')
		})

	// Then wait for the boot overlay to actually go away. main.ts publishes the app first
	// and hides the overlay on a 450ms timer, so waiting only on the app photographs the
	// "STEELSEED / READY" splash composited over the scene — which would be baked into
	// every baseline and silently compared against forever.
	await page
		.waitForFunction(() => document.getElementById('boot')?.hidden === true, { timeout: 15000 })
		.catch(() => {
			errors.push('boot overlay never hid — the shot has the splash composited over the scene')
		})

	// A dropped actor is a SILENT defect and this is the only place that can see it.
	//
	// `units` catches a failed build per slot so one bad actor cannot take the whole army
	// down, records the name in `droppedSlots`, and warns once to the console. In a browser
	// that warning is seen by nobody: `Family.vessel` was missing from ARCHETYPE_GENERATOR for
	// the entire life of the archetype path, so eleven naval actors threw at boot, drew a
	// five-class placeholder hull all session, and every gate in the project stayed green.
	//
	// Reading JS state is safe in its own evaluate — the single-evaluate rule below is about
	// the WebGPU canvas being unreadable across a task boundary, not about state.
	const droppedSlots = await page.evaluate(() => {
		const units = globalThis.steelseed?.registry?.peek?.('units')
		return units === null || units === undefined ? null : units.droppedSlots.slice()
	})
	if (droppedSlots === null) {
		errors.push('capture: could not reach the units node to check droppedSlots — the assertion below is not running')
	} else if (droppedSlots.length > 0) {
		errors.push(
			`capture: ${droppedSlots.length} actor(s) failed to build and drew a placeholder: ` +
			`${droppedSlots.join(', ')}. An actor silently drawn as something else is the defect ` +
			'this assertion exists for.',
		)
	}

	// Drive frames explicitly rather than sleeping. A wall-clock wait captures whatever
	// frame happens to be up and cannot be reproduced.
	// Frames and pixel readback happen in ONE evaluate, deliberately.
	//
	// A WebGPU canvas is presented when the task that drew it ends, and its drawing buffer
	// is not preserved across that boundary — drawImage()ing it from a LATER task reads an
	// empty surface and reports a black frame for a perfectly good render. Measured: split
	// across two evaluates the same scene reads maxChannel 0; merged into one it reads 203.
	// Splitting these would make the pixel gate below fire on every healthy run.
	const pixels = await page.evaluate(
		({ n, det }) => {
			const app = globalThis.steelseed
			for (let i = 0; i < n; i++) app.renderOneFrame(det ? i * (1000 / 60) : performance.now())

			const cv = app?.ctx?.canvas
			if (!cv) return { err: 'no canvas' }
			const s = document.createElement('canvas')
			s.width = 64
			s.height = 64
			const g = s.getContext('2d')
			g.drawImage(cv, 0, 0, cv.width, cv.height, 0, 0, 64, 64)
			const d = g.getImageData(0, 0, 64, 64).data
			let max = 0
			let nonBlack = 0
			const distinct = new Set()
			for (let i = 0; i < d.length; i += 4) {
				const m = Math.max(d[i], d[i + 1], d[i + 2])
				if (m > max) max = m
				if (m > 0) nonBlack++
				distinct.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`)
			}
			return { max, nonBlack, total: d.length / 4, distinct: distinct.size }
		},
		{ n: frames, det: deterministic },
	)

	// The pixel check above exists because the renderer once reported 1168 draw calls and
	// 190240 triangles while presenting a uniformly black canvas. `stats.drawCalls` is
	// incremented when a draw is RECORDED, so it cannot distinguish "drawn" from
	// "submitted" from "presented" — one validation error at encoder.finish() discards the
	// entire command buffer and every counter still reads normal. A GPU validation error is
	// also neither a pageerror nor a console.error, so the checks above saw a clean run.
	//
	// Reading the canvas is the only check that spans the whole path. Deliberately weak: it
	// asserts SOMETHING was presented, not that it was correct — imagediff.mjs owns
	// correctness. A gate that only a human eye can fail is not a gate.
	mkdirSync(outDir, { recursive: true })
	const outPath = join(outDir, `${shot}.png`)
	const buf = await page.screenshot({ path: outPath, type: 'png' })

	if (pixels.err) {
		errors.push(`pixels: ${pixels.err}`)
	} else if (pixels.max === 0) {
		errors.push(
			`pixels: canvas is entirely black (max channel 0 over ${pixels.total} samples). ` +
				`Draw counters are recorded at encode time and prove nothing about presentation — ` +
				`check for a GPU validation error at encoder.finish(), which discards the whole frame.`,
		)
	} else if (devmap && pixels.distinct <= 1) {
		// Only meaningful with a world loaded. With --no-devmap a flat sky is the correct
		// and expected output, so this would be a false failure.
		errors.push(`pixels: canvas is a single flat colour (${pixels.distinct} distinct bucket) — nothing was drawn over the clear.`)
	}

	if (errors.length > 0) {
		console.error(`capture: FAIL — ${shot} reported ${errors.length} error(s):`)
		for (const e of errors.slice(0, 10)) console.error(`  ${e}`)
		exitCode = 1
	} else {
		console.log(
			`capture: ${shot} -> ${outPath}  (${width}x${height} @${deterministic ? 1 : dpr}x, ${buf.length} bytes, ` +
				`${frames} frames, maxChannel ${pixels.max}, ${pixels.nonBlack}/${pixels.total} non-black, ${pixels.distinct} colour buckets)`,
		)
	}
} catch (err) {
	console.error(`capture: FAIL — ${err.message}`)
	exitCode = 1
} finally {
	if (browser != null)
		await browser.close()
	if (server != null && !flags.has('keep-server'))
		await stopProcessGroup(server)
}

process.exit(exitCode)
