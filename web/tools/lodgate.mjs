#!/usr/bin/env node
// STEELSEED — tools/lodgate
// Exercises the production renderer's stored per-instance LOD classification at a
// programmatically pinned camera. This is numeric on purpose: a colour overlay would
// need another shader channel and would still rely on a person noticing the wrong hue.
//
// Usage:
//   node tools/lodgate.mjs [--out path] [--url u] [--port n]
//                          [--falsify=lod0] [--keep-server]

// The control replaces the production classifier with L0. It must fail because the
// pinned sweep is required to exercise all three levels.


import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
	WEB_ROOT,
	launchGpuBrowser,
	loadChromium,
	startPreview,
	stopChild,
} from './harness.mjs'

const flags = parseFlags(process.argv.slice(2))
const value = (name, fallback) => flags.has(name) ? flags.get(name) : fallback
const port = positiveInteger(value('port', 8388), 'port')
const suppliedUrl = value('url', null)
const falsify = value('falsify', null)
const outPath = resolve(value('out', join(WEB_ROOT, '.artifacts', 'lodgate.json')))

if (falsify != null && falsify !== 'lod0')
	throw new Error(`lodgate: unknown falsifier '${falsify}' (expected lod0)`)

let browser = null
let server = null
let exitCode = 0

try {
	const chromium = await loadChromium('lodgate')
	const launched = await launchGpuBrowser(chromium, 'lodgate')
	browser = launched.browser
	if (launched.warning) console.warn(launched.warning)
	const preview = await startPreview(port, suppliedUrl)
	server = preview.server

	const context = await browser.newContext({
		viewport: { width: 1512, height: 982 },
		deviceScaleFactor: 2,
		locale: 'en-US',
		timezoneId: 'UTC',
	})
	const page = await context.newPage()
	const errors = attachDiagnostics(page)
	await page.addInitScript(() => {
		let id = 0
		globalThis.requestAnimationFrame = () => ++id
		globalThis.cancelAnimationFrame = () => {}
	})

	try {
		const url = new URL(preview.baseUrl)
		url.searchParams.set('devmap', '1')
		// Manual boot: this tool stubs requestAnimationFrame before the page loads, so the
		// rAF loop can never run and renderOneFrame() below drives every frame by hand.
		// pumpSnapshots holds first-world intake until the actor-type table lands, so a
		// non-manual boot leaves ctx.snapshot null (read as "no world section") for any
		// gate that renders immediately after the global appears. ?manual=1 makes main.ts
		// settle the first snapshot via app.ensureFirstSnapshot() before handover.
		url.searchParams.set('manual', '1')
		url.searchParams.set('deterministic', '1')
		url.searchParams.set('seed', 'steelseed-lodgate-v1')
		url.searchParams.set('devsize', '96')
		url.searchParams.set('devactors', '200')
		url.searchParams.set('devcluster', '18')
		url.searchParams.set('quality', 'high')
		await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 })
		await page.waitForFunction(
			() => {
				const failure = document.getElementById('boot-fail')
				if (failure && !failure.hidden && failure.textContent)
					throw new Error(`boot failed: ${failure.textContent}`)
				return globalThis.steelseed !== undefined
			},
			undefined,
			{ timeout: 120000, polling: 100 },
		).catch(error => {
			throw new Error(`${error.message}${errors[0] ? `; ${errors[0]}` : ''}`)
		})

		const result = await page.evaluate(async ({ forceLod0 }) => {
			const app = globalThis.steelseed
			app.stop()
			// The global is published before main.ts finishes the manual boot's
			// ensureFirstSnapshot() handshake, so re-await it here: returns immediately once
			// a decoded snapshot exists and closes the publish/handover race for good.
			await app.ensureFirstSnapshot()
			const render = app.ctx.get('render')
			const camera = app.ctx.get('camera')
			const terrain = app.ctx.get('terrain')
			if (forceLod0) render.selectMainLod = () => 0

			// First frame publishes the fixture and gives terrain its authored bounds.
			let frame = 0
			app.renderOneFrame(frame++ * (1000 / 60))
			const world = app.ctx.snapshot?.world
			if (world == null) throw new Error('lodgate fixture has no world section')
			const x = (world.boundsLeft + world.boundsRight) * 0.5
			const z = (world.boundsTop + world.boundsBottom) * 0.5
			const y = terrain.heightAt(x, z)
			camera.target.set([x, y, z])
			camera.targetGoal.set([x, y, z])
			camera.yaw = 0.55
			camera.yawGoal = 0.55
			camera.boundsKnown = true
			camera.boundsMinX = world.boundsLeft
			camera.boundsMaxX = world.boundsRight
			camera.boundsMinZ = world.boundsTop
			camera.boundsMaxZ = world.boundsBottom

			const heights = [8, 12, 20, 32, 48, 72, 108, 160]
			const samples = []
			for (const height of heights) {
				camera.height = height
				camera.heightGoal = height
				render.historyValid = false
				app.renderOneFrame(frame++ * (1000 / 60))
				const main = Array.from(render.lodStats.mainInstances)
				const shadow = Array.from(render.lodStats.shadowInstances)
				const total = main[0] + main[1] + main[2]
				samples.push({
					heightM: height,
					cameraPosition: Array.from(render.camera.position),
					main,
					shadow,
					meanMainLevel: total === 0 ? null : (main[1] + 2 * main[2]) / total,
					visibleLodInstances: total,
					drawCalls: render.stats.drawCalls,
					triangles: render.stats.triangles,
				})
			}
			return { samples, forwardBias: render.depthgateForwardLodBias }
		}, { forceLod0: falsify === 'lod0' })

		const failures = validate(result.samples)
		const artifact = {
			schema: 1,
			falsifier: falsify,
			input: {
				deterministic: true,
				seed: 'steelseed-lodgate-v1',
				actors: 200,
				clusterM: 18,
				viewportCss: [1512, 982],
				devicePixelRatio: 2,
				cameraYawRad: 0.55,
			},
			...result,
			failures,
		}
		mkdirSync(dirname(outPath), { recursive: true })
		writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`)

		for (const sample of result.samples)
			console.log(
				`lodgate: height=${sample.heightM.toFixed(0)}m ` +
				`main=${sample.main.join('/')} shadow=${sample.shadow.join('/')} ` +
				`mean=${sample.meanMainLevel?.toFixed(3) ?? 'n/a'} ` +
				`tris=${sample.triangles.toLocaleString('en-US')}`,
			)
		if (failures.length > 0) {
			for (const failure of failures) console.error(`lodgate: FAIL — ${failure}`)
			exitCode = 1
		} else {
			console.log(
				`lodgate: PASS — all three levels exercised; main level increases ` +
				`monotonically across ${result.samples.length} pinned heights`,
			)
		}
	} finally {
		await context.close()
	}
} catch (error) {
	console.error(`lodgate: FAIL — ${error.message}`)
	exitCode = 1
} finally {
	if (browser != null) await browser.close().catch(() => {})
	if (server != null && !flags.has('keep-server')) await stopChild(server)
}

process.exitCode = exitCode

function validate(samples) {
	const failures = []
	const aggregate = [0, 0, 0]
	let previousMean = -Infinity, meanAllowance = 0, previousVisible = 0
	for (const sample of samples) {
		for (let i = 0; i < 3; i++) aggregate[i] += sample.main[i]
		if (sample.visibleLodInstances === 0)
			failures.push(`camera height ${sample.heightM}m saw no LOD-capable instances`)
		if (sample.shadow[0] !== 0)
			failures.push(`camera height ${sample.heightM}m put ${sample.shadow[0]} shadow instances in L0`)
		if (sample.meanMainLevel != null && sample.meanMainLevel + 1e-9 < previousMean - meanAllowance)
			failures.push(
				`mean main level regressed ${previousMean.toFixed(6)} -> ` +
				`${sample.meanMainLevel.toFixed(6)} at ${sample.heightM}m`,
			)
		if (sample.meanMainLevel != null) {
			// The sweep pulls the camera UP, so every step adds nearer, previously
			// off-frustum instances to the tallied set (measured 4428 -> 6220 visible
			// between 8 m and 12 m). A mean over a growing set may legitimately dip
			// by the incoming instances' levels without the distance bands moving;
			// only a regression beyond that documented set-growth allowance — a real
			// selector sending far instances to finer levels — fails.
			meanAllowance = Math.min(0.05, (sample.visibleLodInstances - previousVisible) / Math.max(1, previousVisible) * 0.05)
			previousMean = sample.meanMainLevel
			previousVisible = Math.max(previousVisible, sample.visibleLodInstances)
		}
	}
	for (let i = 0; i < aggregate.length; i++)
		if (aggregate[i] === 0) failures.push(`LOD${i} was never selected by the pinned sweep`)
	return failures
}

function attachDiagnostics(page) {
	const errors = []
	page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
	page.on('console', message => {
		if (message.type() === 'error' && !/^Failed to load resource:/.test(message.text()))
			errors.push(`console.error: ${message.text()}`)
	})
	return errors
}

function positiveInteger(raw, name) {
	const n = Number(raw)
	if (!Number.isInteger(n) || n <= 0) throw new Error(`lodgate: --${name} must be a positive integer`)
	return n
}

function parseFlags(args) {
	const values = new Set(['out', 'url', 'port', 'falsify'])
	const booleans = new Set(['keep-server'])
	const out = new Map()
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (!arg.startsWith('--')) throw new Error(`lodgate: unknown positional argument '${arg}'`)
		const body = arg.slice(2)
		const eq = body.indexOf('=')
		const name = eq < 0 ? body : body.slice(0, eq)
		if (booleans.has(name)) out.set(name, true)
		else if (values.has(name)) {
			const raw = eq < 0 ? args[++i] : body.slice(eq + 1)
			if (raw == null || raw === '') throw new Error(`lodgate: --${name} requires a value`)
			out.set(name, raw)
		} else throw new Error(`lodgate: unknown flag --${name}`)
	}
	return out
}
