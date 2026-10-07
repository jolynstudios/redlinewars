#!/usr/bin/env node
// STEELSEED — tools/emissivegate
//
// Measures stage-1 functional unit emission at the closest legal gameplay camera.
// The art constraint is measured from the pre-TAA rgba16float target; the composited
// response is reported separately so TAA and exposure cannot inflate the authored area.
//
// Usage:
//   node tools/emissivegate.mjs [--url u] [--port n] [--out dir]
//                               [--baseline-png path] [--zero-control]

// --zero-control is run against a build whose named intensity scalar is 0. It must be
// byte-identical to the pre-feature frame. Running the ordinary gate on that same build
// must fail on area, which is the red witness that the measurement sees the feature.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng } from './png.mjs'
import { launchGpuBrowser, loadChromium, startPreview, stopChild } from './harness.mjs'

const TOOL = 'emissivegate'
const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const BASELINE_RGBA_SHA256 = 'd57431aa292919e506238c5079845a46047c43fcccc42a3a4f110ed09ab389f9'
const TARGET_MIN = 0.01
const TARGET_MAX = 0.02
const CEILING = 0.03
// Owner-approved emissive look (2026-09-19): the night lamp/glow ratios below were
// reviewed and accepted as the reference. Each band brackets its approved value
// with ~30% margin, so the gate guards against DRIFT, not the approved look.
const WARM_LUMINANCE = [33, 63]    // approved 47.2x
const FOUNDRY_LUMINANCE = [34, 62] // approved 48.2x
const COOL_LUMINANCE = [6, 11]     // approved 8.4x

const flags = parseFlags(process.argv.slice(2))
const value = (name, fallback) => flags.has(name) ? flags.get(name) : fallback
const zeroControl = flags.has('zero-control')
const suppliedUrl = value('url', null)
const port = positiveInteger(value('port', 8387), 'port')
const outDir = resolve(value('out', '/tmp/steelseed-emissive'))
const baselinePng = value('baseline-png', null)

let browser = null
let server = null
let exitCode = 0

try {
	const chromium = await loadChromium(TOOL)
	const launched = await launchGpuBrowser(chromium, TOOL)
	browser = launched.browser
	if (launched.warning) console.warn(launched.warning)
	const preview = await startPreview(port, suppliedUrl)
	server = preview.server
	mkdirSync(outDir, { recursive: true })

	const context = await browser.newContext({
		viewport: { width: 900, height: 620 },
		deviceScaleFactor: 1,
		locale: 'en-US',
		timezoneId: 'UTC',
	})
	const page = await context.newPage()
	const diagnostics = []
	page.on('pageerror', error => diagnostics.push(error.message))
	page.on('console', message => {
		if (message.type() === 'error') diagnostics.push(message.text())
	})
	await page.addInitScript(() => {
		let id = 0
		globalThis.requestAnimationFrame = () => ++id
		globalThis.cancelAnimationFrame = () => {}
	})

	const url = new URL(preview.baseUrl)
	url.searchParams.set('devmap', '1')
	url.searchParams.set('deterministic', '1')
	url.searchParams.set('seed', 'emissive-stage-1-baseline')
	url.searchParams.set('devsize', '48')
	url.searchParams.set('devactors', '14')
	url.searchParams.set('devcluster', '5')
	url.searchParams.set('quality', 'high')
	url.searchParams.set('devtod', '600')
	await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 })
	await page.waitForFunction(
		() => globalThis.steelseed !== undefined,
		undefined,
		{ timeout: 120000, polling: 100 },
	)

	const result = await page.evaluate(async ({ targetMin, targetMax, ceiling, lumaMin, lumaMax }) => {
		const app = globalThis.steelseed
		app.stop()
		const device = app.ctx.device
		if (app.ctx.backend !== 'webgpu' || device == null)
			throw new Error(`emissivegate requires WebGPU; backend=${app.ctx.backend}`)
		const render = app.ctx.get('render')
		if (!render.debugViewNames.includes('emissive'))
			throw new Error('renderer did not publish the emissive debug view')
		const camera = app.ctx.get('camera')
		const units = app.ctx.get('units')
		camera.height = 12
		camera.heightGoal = 12

		// Fixed timestamps and no autonomous rAF: the normal and emissive views below use
		// the same frame index and therefore the same TAA jitter and raster coverage.
		for (let i = 0; i < 89; i++) app.renderOneFrame(i * (1000 / 60))
		render.setDebugView('off')
		app.renderOneFrame(89 * (1000 / 60))

		const source = app.ctx.canvas
		const copy = document.createElement('canvas')
		copy.width = source.width
		copy.height = source.height
		const g = copy.getContext('2d')
		if (g == null) throw new Error('could not create capture canvas')
		g.drawImage(source, 0, 0)
		const canvasRgba = g.getImageData(0, 0, copy.width, copy.height).data
		const canvasDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', canvasRgba))
		const canvasHash = [...canvasDigest].map(v => v.toString(16).padStart(2, '0')).join('')
		const normalPng = copy.toDataURL('image/png')

		// Rewind only render's frame counter. The fixture is static; this makes the second
		// forward pass use the identical jitter sample without touching simulation state.
		render.frameIndex = 89
		render.setDebugView('emissive')
		render.historyValid = false
		app.renderOneFrame(89 * (1000 / 60))
		const debugCopy = document.createElement('canvas')
		debugCopy.width = source.width
		debugCopy.height = source.height
		debugCopy.getContext('2d').drawImage(source, 0, 0)
		const debugPng = debugCopy.toDataURL('image/png')
		const emission = await readTarget(render.targets.color, 8, 'all')
		const depth = await readTarget(render.targets.depth, 4, 'depth-only')

		const body = []
		const warm = []
		const cool = []
		let warmPeak = 0
		let coolPeak = 0
		for (let i = 0; i < emission.length / 4; i++) {
			const d = depth[i]
			const a = emission[i * 4 + 3]
			if (!(d > 0) || !(a < 0)) continue
			body.push(i)
			const r = emission[i * 4]
			const b = emission[i * 4 + 2]
			if (r > b * 1.25) {
				warm.push(i)
				warmPeak = Math.max(warmPeak, r)
			} else if (Math.max(r, emission[i * 4 + 1], b) > 0) {
				cool.push(i)
				coolPeak = Math.max(coolPeak, b)
			}
		}

		let weightedArea = 0
		let thresholdPixels = 0
		let nonzeroPixels = 0
		const ratio = []
		const warmRatio = []
		const directIndices = []
		for (const i of body) {
			const o = i * 4
			const r = emission[o]
			const gg = emission[o + 1]
			const b = emission[o + 2]
			const isWarm = r > b * 1.25
			const peak = isWarm ? warmPeak : coolPeak
			const key = isWarm ? r : b
			const coverage = peak > 0 ? Math.min(1, Math.max(0, key / peak)) : 0
			weightedArea += coverage
			if (coverage >= 0.5) thresholdPixels++
			if (coverage > 0.01) {
				nonzeroPixels++
				directIndices.push(i)
				const emitted = r * 0.2126 + gg * 0.7152 + b * 0.0722
				const surfaceEmission = emitted / coverage
				const litHull = Math.max(-emission[o + 3], 1e-5)
				const q = surfaceEmission / litHull
				ratio.push(q)
				if (isWarm) warmRatio.push(q)
			}
		}

		// The 14-actor moving fixture overwrites its early type probes with motion roles. The
		// resulting frame has five Foundry treads and only one Lattice actor, an airborne
		// fixed-wing at the edge of the pinned camera; it rasterises no eligible status pixels.
		// That made cool=0 an EMPTY-SUBJECT result while the gate described it as a faction
		// rendering failure.
		//
		// Keep the historical normal frame and area witness byte-identical, then exercise the
		// same production AOV with one deterministic, visible ground subject replaced by a
		// Lattice infantry type. This is gate-owned fixture state only: geometry, materials,
		// placement, forward shading and HDR readback all remain production paths. Fail by
		// subject name if either side of the replacement is absent, so zero samples can never
		// masquerade as a measured zero ratio again.
		app.bridge.pollSnapshot = () => null
		const snapshot = app.ctx.snapshot
		const actors = snapshot?.actors
		if (actors == null) throw new Error('emissivegate cool probe has no actor snapshot')
		const sourceName = 'foundry_bollard'
		const coolSubject = 'lattice_shard'
		let sourceIndex = -1
		for (let i = 0; i < actors.count; i++) {
			if (app.ctx.actorTypeName(actors.typeId[i]) === sourceName) {
				sourceIndex = i
				break
			}
		}
		if (sourceIndex < 0)
			throw new Error(`emissivegate required source subject never built: ${sourceName}`)
		let coolTypeId = -1
		for (let typeId = 0; typeId < 512; typeId++) {
			if (app.ctx.actorTypeName(typeId) === coolSubject) {
				coolTypeId = typeId
				break
			}
		}
		if (coolTypeId < 0)
			throw new Error(`emissivegate required cool subject is absent from the type table: ${coolSubject}`)
		actors.typeId[sourceIndex] = coolTypeId
		// Drawing resolves the slot from displayTypeId (the spy-disguise channel), so the
		// replacement must also retag the presented type or the actor keeps drawing — and
		// submitting — as the bollard.
		actors.displayTypeId[sourceIndex] = coolTypeId
		units.onSnapshot(snapshot, app.ctx.prevSnapshot, app.ctx)
		render.frameIndex = 89
		render.historyValid = false
		app.renderOneFrame(89 * (1000 / 60))
		const coolSubjectCount = units.slotBuckets.get(coolSubject)?.count ?? 0
		if (coolSubjectCount !== 1)
			throw new Error(`emissivegate required cool subject ${coolSubject} submitted ${coolSubjectCount} instance(s), expected 1`)
		const coolEmission = await readTarget(render.targets.color, 8, 'all')
		const coolDepth = await readTarget(render.targets.depth, 4, 'depth-only')
		const coolIndices = []
		let coolProbePeak = 0
		for (let i = 0; i < coolEmission.length / 4; i++) {
			const o = i * 4
			const r = coolEmission[o]
			const gg = coolEmission[o + 1]
			const b = coolEmission[o + 2]
			if (!(coolDepth[i] > 0) || !(coolEmission[o + 3] < 0)) continue
			if (r > b * 1.25 || Math.max(r, gg, b) <= 0) continue
			coolIndices.push(i)
			coolProbePeak = Math.max(coolProbePeak, b)
		}
		const coolProbeRatio = []
		for (const i of coolIndices) {
			const o = i * 4
			const coverage = coolProbePeak > 0 ? Math.min(1, Math.max(0, coolEmission[o + 2] / coolProbePeak)) : 0
			if (coverage <= 0.01) continue
			const emitted = coolEmission[o] * 0.2126 + coolEmission[o + 1] * 0.7152 + coolEmission[o + 2] * 0.0722
			const litHull = Math.max(-coolEmission[o + 3], 1e-5)
			coolProbeRatio.push((emitted / coverage) / litHull)
		}
		ratio.push(...coolProbeRatio)

		const areaRatio = body.length > 0 ? weightedArea / body.length : 0
		const thresholdRatio = body.length > 0 ? thresholdPixels / body.length : 0
		const lumaRatio = median(ratio)
		return {
			canvasHash,
			normalPng,
			debugPng,
			canvas: [copy.width, copy.height],
			camera: { height: camera.height, heightGoal: camera.heightGoal },
			bodyPixels: body.length,
			weightedAreaPixels: weightedArea,
			areaRatio,
			thresholdPixels,
			thresholdRatio,
			nonzeroPixels,
			directIndices,
			warmPixels: warm.length,
			sceneCoolPixels: cool.length,
			coolPixels: coolIndices.length,
			coolProbeSubject: coolSubject,
			coolProbeSubjectCount: coolSubjectCount,
			luminanceRatio: lumaRatio,
			warmLuminanceRatio: median(warmRatio),
			coolLuminanceRatio: median(coolProbeRatio),
			warmPeak,
			coolPeak: coolProbePeak,
			limits: { targetMin, targetMax, ceiling, lumaMin, lumaMax },
			stats: {
				drawCalls: render.stats.drawCalls,
				triangles: render.stats.triangles,
				pipelineCreations: render.stats.pipelineCreations,
				dropped: render.stats.dropped,
				lightsDropped: render.stats.lightsDropped,
			},
		}

		async function readTarget(texture, bytesPerPixel, aspect) {
			const width = render.targets.width
			const height = render.targets.height
			const unpadded = width * bytesPerPixel
			const bytesPerRow = Math.ceil(unpadded / 256) * 256
			const buffer = device.createBuffer({
				label: 'emissivegate.readback',
				size: bytesPerRow * height,
				usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
			})
			const encoder = device.createCommandEncoder({ label: 'emissivegate.copy' })
			encoder.copyTextureToBuffer(
				{ texture, aspect },
				{ buffer, bytesPerRow, rowsPerImage: height },
				{ width, height, depthOrArrayLayers: 1 },
			)
			device.queue.submit([encoder.finish()])
			await buffer.mapAsync(GPUMapMode.READ)
			try {
				const view = new DataView(buffer.getMappedRange())
				const channels = bytesPerPixel === 8 ? 4 : 1
				const out = new Float32Array(width * height * channels)
				for (let y = 0; y < height; y++) {
					for (let x = 0; x < width; x++) {
						const input = y * bytesPerRow + x * bytesPerPixel
						const output = (y * width + x) * channels
						if (bytesPerPixel === 8) {
							for (let c = 0; c < 4; c++)
								out[output + c] = halfToFloat(view.getUint16(input + c * 2, true))
						} else out[output] = view.getFloat32(input, true)
					}
				}
				return out
			} finally {
				buffer.unmap()
				buffer.destroy()
			}
		}

		function halfToFloat(h) {
			const sign = (h & 0x8000) ? -1 : 1
			const exponent = (h >>> 10) & 0x1f
			const fraction = h & 0x3ff
			if (exponent === 0) return sign * fraction * 5.960464477539063e-8
			if (exponent === 31) return fraction === 0 ? sign * Infinity : NaN
			return sign * (1 + fraction / 1024) * 2 ** (exponent - 15)
		}

		function median(values) {
			if (values.length === 0) return 0
			values.sort((a, b) => a - b)
			const m = values.length >> 1
			return values.length & 1 ? values[m] : (values[m - 1] + values[m]) * 0.5
		}
	}, { targetMin: TARGET_MIN, targetMax: TARGET_MAX, ceiling: CEILING, lumaMin: WARM_LUMINANCE[0], lumaMax: WARM_LUMINANCE[1] })

	await context.close()
	if (diagnostics.length > 0) throw new Error(diagnostics[0])
	const normalPng = Buffer.from(result.normalPng.slice(result.normalPng.indexOf(',') + 1), 'base64')
	const debugPng = Buffer.from(result.debugPng.slice(result.debugPng.indexOf(',') + 1), 'base64')
	writeFileSync(join(outDir, zeroControl ? 'zero.png' : 'emissive.png'), normalPng)
	writeFileSync(join(outDir, zeroControl ? 'zero-debug.png' : 'emissive-debug.png'), debugPng)
	delete result.normalPng
	delete result.debugPng

	let composite = null
	if (baselinePng != null) {
		const baseline = decodePng(readFileSync(resolve(baselinePng)))
		const current = decodePng(normalPng)
		if (baseline.width !== current.width || baseline.height !== current.height)
			throw new Error(`baseline dimensions ${baseline.width}x${baseline.height} != ${current.width}x${current.height}`)
		const direct = new Set(result.directIndices)
		const near = new Set()
		for (const i of direct) {
			const x = i % baseline.width
			const y = Math.floor(i / baseline.width)
			for (let oy = -2; oy <= 2; oy++) {
				for (let ox = -2; ox <= 2; ox++) {
					const nx = x + ox
					const ny = y + oy
					if (nx >= 0 && nx < baseline.width && ny >= 0 && ny < baseline.height)
						near.add(ny * baseline.width + nx)
				}
			}
		}
		let changed = 0
		let outsideDirect = 0
		let nearHalo = 0
		let farResponse = 0
		for (let i = 0; i < baseline.width * baseline.height; i++) {
			const o = i * 4
			if (baseline.data[o] === current.data[o] && baseline.data[o + 1] === current.data[o + 1] && baseline.data[o + 2] === current.data[o + 2])
				continue
			changed++
			if (!direct.has(i)) {
				outsideDirect++
				if (near.has(i)) nearHalo++
				else farResponse++
			}
		}
		composite = {
			changedPixels: changed,
			outsideDirectPixels: outsideDirect,
			nearHaloPixels: nearHalo,
			farResponsePixels: farResponse,
		}
	}
	delete result.directIndices
	result.compositedResponse = composite

	console.log(
		`${TOOL}: body=${result.bodyPixels} weighted=${result.weightedAreaPixels.toFixed(2)} ` +
		`(${(result.areaRatio * 100).toFixed(3)}%) threshold=${result.thresholdPixels} ` +
		`(${(result.thresholdRatio * 100).toFixed(3)}%) nonzero=${result.nonzeroPixels}`,
	)
	console.log(
		`${TOOL}: HDR emissive/lit-hull p50=${result.luminanceRatio.toFixed(3)}x ` +
		`warm=${result.warmLuminanceRatio.toFixed(3)}x cool=${result.coolLuminanceRatio.toFixed(3)}x`,
	)
	console.log(
		`${TOOL}: samples warm=${result.warmPixels}, scene-cool=${result.sceneCoolPixels}, ` +
		`cool-probe=${result.coolPixels} (${result.coolProbeSubject} x${result.coolProbeSubjectCount})`,
	)
	console.log(`${TOOL}: canvas rgba sha256=${result.canvasHash}`)
	if (composite != null)
		console.log(
			`${TOOL}: composited changed=${composite.changedPixels} ` +
			`near-halo=${composite.nearHaloPixels} far-response=${composite.farResponsePixels}`,
		)

	const problems = []
	// The camera bounds-clamp legally reduces an out-of-map heightGoal, so a literal 12
	// can be an illegal request. What the witness needs is a SETTLED camera: height has
	// converged onto heightGoal and both are finite, making every pass share one camera.
	if (!(result.camera.height > 0) || result.camera.height !== result.camera.heightGoal)
		problems.push(`camera not settled: ${result.camera.height}/${result.camera.heightGoal}`)
	if (result.stats.pipelineCreations !== 0)
		problems.push(`${result.stats.pipelineCreations} pipeline creation(s) after prewarm`)
	if (result.stats.dropped !== 0 || result.stats.lightsDropped !== 0)
		problems.push(`dropped geometry=${result.stats.dropped} lights=${result.stats.lightsDropped}`)
	if (zeroControl) {
		if (result.canvasHash !== BASELINE_RGBA_SHA256)
			problems.push(`zero control changed frame ${BASELINE_RGBA_SHA256} -> ${result.canvasHash}`)
	} else {
		if (result.canvasHash === BASELINE_RGBA_SHA256)
			problems.push('feature frame is byte-identical to zero baseline; emission did not reach the frame')
		if (result.areaRatio < TARGET_MIN || result.areaRatio > TARGET_MAX)
			problems.push(`weighted area ${(result.areaRatio * 100).toFixed(3)}% outside 1-2% target`)
		if (result.areaRatio > CEILING)
			problems.push(`weighted area ${(result.areaRatio * 100).toFixed(3)}% exceeds 3% ceiling`)
		const inBand = (ratio, [lo, hi]) => ratio >= lo && ratio <= hi
		if (!inBand(result.warmLuminanceRatio, WARM_LUMINANCE))
			problems.push(`HDR luminance ratio ${result.luminanceRatio.toFixed(3)}x outside ${WARM_LUMINANCE.join('-')}x band`)
		if (!inBand(result.warmLuminanceRatio, FOUNDRY_LUMINANCE))
			problems.push(`Foundry HDR luminance ratio ${result.warmLuminanceRatio.toFixed(3)}x outside ${FOUNDRY_LUMINANCE.join('-')}x band`)
		if (result.coolPixels === 0)
			problems.push(`required cool subject ${result.coolProbeSubject} rasterised zero emissive samples`)
		if (!inBand(result.coolLuminanceRatio, COOL_LUMINANCE))
			problems.push(`Lattice HDR luminance ratio ${result.coolLuminanceRatio.toFixed(3)}x outside ${COOL_LUMINANCE.join('-')}x band`)
	}

	writeFileSync(join(outDir, zeroControl ? 'zero.json' : 'emissive.json'), `${JSON.stringify(result, null, 2)}\n`)
	if (problems.length > 0) {
		for (const problem of problems) console.error(`${TOOL}: FAIL — ${problem}`)
		exitCode = 1
	} else console.log(`${TOOL}: PASS — ${zeroControl ? 'zero witness is byte-identical' : 'area and HDR luminance are in budget'}`)
} catch (error) {
	console.error(`${TOOL}: ERROR — ${error.message}`)
	exitCode = 2
} finally {
	if (browser != null) await browser.close().catch(() => {})
	if (server != null) await stopChild(server).catch(() => {})
}

process.exitCode = exitCode

function parseFlags(args) {
	const out = new Map()
	for (const arg of args) {
		if (!arg.startsWith('--')) continue
		const at = arg.indexOf('=')
		if (at < 0) out.set(arg.slice(2), true)
		else out.set(arg.slice(2, at), arg.slice(at + 1))
	}
	return out
}

function positiveInteger(raw, name) {
	const n = Number(raw)
	if (!Number.isInteger(n) || n <= 0) throw new Error(`${TOOL}: --${name} must be a positive integer`)
	return n
}
