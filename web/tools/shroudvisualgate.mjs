#!/usr/bin/env node
// STEELSEED — tools/shroudvisualgate
// Presented-pixel and HDR evidence for §4.7's visual half.
//
// The synthetic marker is deliberately an off-centre L in a non-square grid. A centred
// disc or band can look correct after an x/z transpose, sign flip, or wrong origin; this
// fixture cannot. The gate also resizes the GPU texture before the measured draw so the
// bind-group recreation path is exercised rather than merely claimed.
//
// Usage:
//   node tools/shroudvisualgate.mjs [--out dir] [--url u] [--port n]
//                                   [--falsify=visible] [--keep-server]

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
	WEB_ROOT,
	launchGpuBrowser,
	loadChromium,
	startPreview,
	stopChild,
} from './harness.mjs'
import { decodePng, encodePng } from './png.mjs'

const flags = parseFlags(process.argv.slice(2))
const value = (name, fallback) => flags.has(name) ? flags.get(name) : fallback
const port = positiveInteger(value('port', 8389), 'port')
const suppliedUrl = value('url', null)
const falsify = value('falsify', null)
const outDir = resolve(value('out', join(WEB_ROOT, '.artifacts', 'shroudvisualgate')))
if (falsify != null && falsify !== 'visible')
	throw new Error(`shroudvisualgate: unknown falsifier '${falsify}' (expected visible)`)

let browser = null
let server = null
let exitCode = 0

try {
	const chromium = await loadChromium('shroudvisualgate')
	const launched = await launchGpuBrowser(chromium, 'shroudvisualgate')
	browser = launched.browser
	if (launched.warning) console.warn(launched.warning)
	const preview = await startPreview(port, suppliedUrl)
	server = preview.server
	mkdirSync(outDir, { recursive: true })

	const context = await browser.newContext({
		viewport: { width: 960, height: 540 },
		deviceScaleFactor: 1,
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
		// rAF is stubbed below, so app.start() never pumps; without manual=1 the
		// boot never settles the world and the fixture reads a null snapshot.
		url.searchParams.set('manual', '1')
		url.searchParams.set('deterministic', '1')
		url.searchParams.set('seed', 'steelseed-shroud-visual-v1')
		url.searchParams.set('devsize', '96')
		url.searchParams.set('quality', 'high')
		await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 })
		await page.waitForFunction(
			() => globalThis.steelseed !== undefined,
			undefined,
			{ timeout: 120000, polling: 100 },
		).catch(error => {
			throw new Error(`${error.message}${errors[0] ? `; ${errors[0]}` : ''}`)
		})

		const result = await page.evaluate(async ({ forceVisible }) => {
			const UNEXPLORED = 0
			const EXPLORED = 1
			const VISIBLE = 2
			const app = globalThis.steelseed
			app.stop()
			const render = app.ctx.get('render')
			const camera = app.ctx.get('camera')
			const terrain = app.ctx.get('terrain')
			const device = app.ctx.device
			if (app.ctx.backend !== 'webgpu' || device == null)
				throw new Error(`shroudvisualgate requires WebGPU; backend=${app.ctx.backend}`)

			let frame = 0
			app.renderOneFrame(frame++ * (1000 / 60))
			const world = app.ctx.snapshot?.world
			if (world == null) throw new Error('visual fixture has no world section')
			// No later snapshot may overwrite the synthetic marker between its upload and draw.
			app.bridge.pollSnapshot = () => null
			const targetX = (world.boundsLeft + world.boundsRight) * 0.5
			const targetZ = (world.boundsTop + world.boundsBottom) * 0.5
			const targetY = terrain.heightAt(targetX, targetZ)
			camera.target.set([targetX, targetY, targetZ])
			camera.targetGoal.set([targetX, targetY, targetZ])
			camera.height = 28
			camera.heightGoal = 28
			camera.yaw = 0.55
			camera.yawGoal = 0.55
			camera.boundsKnown = true
			camera.boundsMinX = world.boundsLeft
			camera.boundsMaxX = world.boundsRight
			camera.boundsMinZ = world.boundsTop
			camera.boundsMaxZ = world.boundsBottom
			document.getElementById('boot')?.setAttribute('hidden', '')

			// Force the approximately-never map-resize path before the measured grid. A stale
			// bind group keeps sampling 7x13 after this call and the L probes then fail by state.
			const first = new Uint8Array(7 * 13)
			first.fill(VISIBLE)
			render.setShroud(first, 7, 13, targetX - 3, targetZ - 6)
			const firstSize = [render.shroudWidth, render.shroudHeight]
			app.renderOneFrame(frame++ * (1000 / 60))

			const w = 31
			const h = 19
			const originX = Math.floor(targetX) - 15
			const originY = Math.floor(targetZ) - 9
			const marker = new Uint8Array(w * h)
			marker.fill(VISIBLE)
			const paint = (x0, y0, x1, y1, state) => {
				for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++)
					marker[y * w + x] = state
			}
			// Thick explored surround, then a narrower unexplored L within it. It is offset
			// towards the upper-left and its arms have unequal lengths.
			paint(3, 2, 10, 16, EXPLORED)
			paint(3, 11, 26, 17, EXPLORED)
			paint(5, 4, 7, 14, UNEXPLORED)
			paint(5, 13, 21, 15, UNEXPLORED)
			const full = new Uint8Array(w * h)
			full.fill(VISIBLE)

			// Probe integration is a rolling update and would make two otherwise identical
			// forward draws differ. Freeze only that refresh; both draws still read the same
			// production probe buffer and run the complete production pipeline.
			render.probes.updatesPerFrame = 0
			const uncaptured = []
			device.addEventListener('uncapturederror', event => {
				uncaptured.push(event.error?.message ?? String(event.error))
			})

			// Compare visibility at one presentation instant. Deterministic Clock.frame
			// advances alpha on EVERY call, even at an identical timestamp. Freeze the
			// clock after staging so weather/vegetation cannot move between HDR reads.
			app.clock.frame = () => 0
			app.ctx.time.dt = 0
			const measuredTime = frame * (1000 / 60)
			const draw = async cells => {
				render.setShroud(cells, w, h, originX, originY)
				render.frameIndex = 0
				render.historyValid = false
				device.pushErrorScope('validation')
				let dataUrl
				try {
					app.renderOneFrame(measuredTime)
					const source = app.ctx.canvas
					const copy = document.createElement('canvas')
					copy.width = source.width
					copy.height = source.height
					const g = copy.getContext('2d')
					if (g == null) throw new Error('could not create shroud capture canvas')
					g.drawImage(source, 0, 0)
					dataUrl = copy.toDataURL('image/png')
				} catch (error) {
					const validation = await device.popErrorScope().catch(() => null)
					throw new Error(`${error.message}${validation ? `; GPU validation: ${validation.message}` : ''}`)
				}

				const targets = render.targets
				const bytesPerPixel = 8
				const bytesPerRow = Math.ceil(targets.width * bytesPerPixel / 256) * 256
				const colorBuffer = device.createBuffer({
					label: 'shroudvisualgate.hdr',
					size: bytesPerRow * targets.height,
					usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
				})
				const depthBytesPerRow = Math.ceil(targets.width * 4 / 256) * 256
				const depthBuffer = device.createBuffer({
					label: 'shroudvisualgate.depth',
					size: depthBytesPerRow * targets.height,
					usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
				})
				const encoder = device.createCommandEncoder({ label: 'shroudvisualgate.readback' })
				encoder.copyTextureToBuffer(
					{ texture: targets.color },
					{ buffer: colorBuffer, bytesPerRow, rowsPerImage: targets.height },
					{ width: targets.width, height: targets.height, depthOrArrayLayers: 1 },
				)
				encoder.copyTextureToBuffer(
					{ texture: targets.depth, aspect: 'depth-only' },
					{ buffer: depthBuffer, bytesPerRow: depthBytesPerRow, rowsPerImage: targets.height },
					{ width: targets.width, height: targets.height, depthOrArrayLayers: 1 },
				)
				device.queue.submit([encoder.finish()])
				await device.queue.onSubmittedWorkDone()
				const validation = await device.popErrorScope()
				if (validation != null) throw new Error(`GPU validation: ${validation.message}`)
				await Promise.all([
					colorBuffer.mapAsync(GPUMapMode.READ),
					depthBuffer.mapAsync(GPUMapMode.READ),
				])
				const padded = new Uint16Array(colorBuffer.getMappedRange())
				const rowWords = bytesPerRow / 2
				const pixels = new Uint16Array(targets.width * targets.height * 4)
				for (let y = 0; y < targets.height; y++)
					pixels.set(padded.subarray(y * rowWords, y * rowWords + targets.width * 4), y * targets.width * 4)
				const paddedDepth = new Float32Array(depthBuffer.getMappedRange())
				const depthRowFloats = depthBytesPerRow / 4
				const depth = new Float32Array(targets.width * targets.height)
				for (let y = 0; y < targets.height; y++)
					depth.set(
						paddedDepth.subarray(y * depthRowFloats, y * depthRowFloats + targets.width),
						y * targets.width,
					)
				colorBuffer.unmap()
				depthBuffer.unmap()
				colorBuffer.destroy()
				depthBuffer.destroy()
				return { dataUrl, pixels, depth, width: targets.width, height: targets.height }
			}

			const patterned = await draw(forceVisible ? full : marker)
			const measuredSize = [render.shroudWidth, render.shroudHeight]
			const defeated = await draw(full)
			if (uncaptured.length > 0) throw new Error(`uncaptured GPU error: ${uncaptured[0]}`)

			const probes = []
			const matrix = render.camera.viewProj
			for (let cy = 1; cy < h - 1; cy++) for (let cx = 1; cx < w - 1; cx++) {
				const state = marker[cy * w + cx]
				const margin = state === VISIBLE ? 2 : 1
				if (cx < margin || cy < margin || cx >= w - margin || cy >= h - margin) continue
				let interior = true
				for (let oy = -margin; oy <= margin; oy++) for (let ox = -margin; ox <= margin; ox++)
					if (marker[(cy + oy) * w + cx + ox] !== state) interior = false
				if (!interior) continue
				const x = originX + cx + 0.5
				const z = originY + cy + 0.5
				const y = terrain.heightAt(x, z)
				const clipX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]
				const clipY = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]
				const clipZ = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]
				const clipW = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15]
				if (clipW <= 0) continue
				const px = Math.round((clipX / clipW * 0.5 + 0.5) * patterned.width)
				const py = Math.round((0.5 - clipY / clipW * 0.5) * patterned.height)
				if (px < 0 || py < 0 || px >= patterned.width || py >= patterned.height) continue
				const expectedDepth = clipZ / clipW
				const presentedDepth = patterned.depth[py * patterned.width + px]
				// Reconstruct the surface actually owning this pixel. A fixed tolerance in
				// reversed depth admitted a foreground ridge several cells away and then
				// incorrectly labelled its fog colour with the visible cell behind it.
				const inverse = render.invViewProj
				const nx = (px + 0.5) / patterned.width * 2 - 1
				const ny = 1 - (py + 0.5) / patterned.height * 2
				const hw = inverse[3] * nx + inverse[7] * ny + inverse[11] * presentedDepth + inverse[15]
				const hitX = (inverse[0] * nx + inverse[4] * ny + inverse[8] * presentedDepth + inverse[12]) / hw
				const hitZ = (inverse[2] * nx + inverse[6] * ny + inverse[10] * presentedDepth + inverse[14]) / hw
				if (!Number.isFinite(hitX) || !Number.isFinite(hitZ)
					|| Math.floor(hitX - originX) !== cx || Math.floor(hitZ - originY) !== cy) continue
				const o = (py * patterned.width + px) * 4
				probes.push({
					state,
					cell: [cx, cy],
					pixel: [px, py],
					depthError: Math.abs(expectedDepth - presentedDepth),
					pattern: [patterned.pixels[o], patterned.pixels[o + 1], patterned.pixels[o + 2]],
					full: [defeated.pixels[o], defeated.pixels[o + 1], defeated.pixels[o + 2]],
				})
			}

			let changedPixels = 0
			let maxWordDelta = 0
			for (let p = 0; p < patterned.width * patterned.height; p++) {
				const o = p * 4
				let changed = false
				for (let c = 0; c < 3; c++) {
					const delta = Math.abs(patterned.pixels[o + c] - defeated.pixels[o + c])
					maxWordDelta = Math.max(maxWordDelta, delta)
					if (delta !== 0) changed = true
				}
				if (changed) changedPixels++
			}
			return {
				falsifier: forceVisible ? 'visible' : null,
				grid: { width: w, height: h, originX, originY },
				firstSize,
				measuredSize,
				changedPixels,
				maxWordDelta,
				probes,
				patternPng: patterned.dataUrl,
				fullPng: defeated.dataUrl,
			}
		}, { forceVisible: falsify === 'visible' })

		const metrics = summarize(result)
		const failures = validate(result, metrics)
		writePng(join(outDir, 'pattern.png'), result.patternPng)
		writePng(join(outDir, 'full-visible.png'), result.fullPng)
		writeDiff(join(outDir, 'difference.png'), result.patternPng, result.fullPng)
		const artifact = { schema: 1, ...result, patternPng: undefined, fullPng: undefined, metrics, failures }
		writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(artifact, null, 2)}\n`)

		console.log(
			`shroudvisualgate: grid ${result.firstSize.join('x')} -> ${result.measuredSize.join('x')}; ` +
			`${result.changedPixels.toLocaleString('en-US')} HDR pixels changed`,
		)
		for (const state of ['visible', 'explored', 'unexplored']) {
			const metric = metrics[state]
			console.log(
				`  ${state}: probes=${metric.count}, exact=${metric.exact}, ` +
				`value=${format(metric.patternLuma)}, luma=${format(metric.lumaRatio)}, ` +
				`chroma=${format(metric.chromaRatio)}`,
			)
		}
		if (failures.length > 0) {
			for (const failure of failures) console.error(`shroudvisualgate: FAIL — ${failure}`)
			exitCode = 1
		} else console.log('shroudvisualgate: PASS — L marker lands, resize rebinds, visible is exact, hidden ground remains drawn.')
	} finally {
		await context.close()
	}
} catch (error) {
	console.error(`shroudvisualgate: FAIL — ${error.message}`)
	exitCode = 1
} finally {
	if (browser != null) await browser.close().catch(() => {})
	if (server != null && !flags.has('keep-server')) await stopChild(server)
}

process.exitCode = exitCode

function summarize(result) {
	const names = ['unexplored', 'explored', 'visible']
	const groups = names.map(() => ({ count: 0, exact: 0, patternLuma: [], luma: [], chroma: [] }))
	for (const probe of result.probes) {
		const group = groups[probe.state]
		const pattern = probe.pattern.map(halfToFloat)
		const full = probe.full.map(halfToFloat)
		const fullLuma = luma(full)
		if (!Number.isFinite(fullLuma) || fullLuma < 0.02) continue
		group.count++
		if (probe.pattern.every((value, i) => value === probe.full[i])) group.exact++
		const patternLuma = luma(pattern)
		group.patternLuma.push(patternLuma)
		group.luma.push(patternLuma / fullLuma)
		const fullChroma = chroma(full)
		if (fullChroma > 0.01) group.chroma.push(chroma(pattern) / fullChroma)
	}
	return Object.fromEntries(names.map((name, i) => [name, {
		count: groups[i].count,
		exact: groups[i].exact,
		patternLuma: median(groups[i].patternLuma),
		lumaRatio: median(groups[i].luma),
		chromaRatio: median(groups[i].chroma),
	}]))
}

function validate(result, metrics) {
	const failures = []
	if (result.firstSize[0] !== 7 || result.firstSize[1] !== 13)
		failures.push(`first texture size is ${result.firstSize.join('x')}, expected 7x13`)
	if (result.measuredSize[0] !== 31 || result.measuredSize[1] !== 19)
		failures.push(`resized texture is ${result.measuredSize.join('x')}, expected 31x19`)
	for (const state of ['visible', 'explored', 'unexplored'])
		if (metrics[state].count < 4) failures.push(`${state} has only ${metrics[state].count} usable probes`)
	if (metrics.visible.exact !== metrics.visible.count)
		failures.push(`${metrics.visible.count - metrics.visible.exact}/${metrics.visible.count} visible probes changed`)
	if (!(metrics.explored.lumaRatio > 0.12 && metrics.explored.lumaRatio < 0.65))
		failures.push(`explored luma ratio ${format(metrics.explored.lumaRatio)} is not dim-but-readable`)
	if (!(metrics.explored.chromaRatio < 0.55))
		failures.push(`explored chroma ratio ${format(metrics.explored.chromaRatio)} is not desaturated`)
	if (!(metrics.unexplored.lumaRatio > 0 && metrics.unexplored.lumaRatio < metrics.explored.lumaRatio))
		failures.push(`unexplored luma ratio ${format(metrics.unexplored.lumaRatio)} is not darker than explored`)
	if (!(metrics.unexplored.patternLuma >= 0.019))
		failures.push(`unexplored HDR value ${format(metrics.unexplored.patternLuma)} fell below the 0.02 floor`)
	if (result.changedPixels < 500)
		failures.push(`only ${result.changedPixels} HDR pixels changed; the marker does not read`)
	return failures
}

function halfToFloat(bits) {
	const sign = (bits & 0x8000) === 0 ? 1 : -1
	const exponent = (bits >>> 10) & 0x1f
	const fraction = bits & 0x03ff
	if (exponent === 0) return sign * fraction * 2 ** -24
	if (exponent === 31) return fraction === 0 ? sign * Infinity : NaN
	return sign * (1 + fraction / 1024) * 2 ** (exponent - 15)
}

function luma(rgb) {
	return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
}

function chroma(rgb) {
	const hi = Math.max(rgb[0], rgb[1], rgb[2])
	const lo = Math.min(rgb[0], rgb[1], rgb[2])
	return hi <= 1e-9 ? 0 : (hi - lo) / hi
}

function median(values) {
	if (values.length === 0) return null
	const sorted = [...values].sort((a, b) => a - b)
	const mid = sorted.length >>> 1
	return sorted.length & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) * 0.5
}

function format(value) {
	return value == null || !Number.isFinite(value) ? 'n/a' : value.toFixed(4)
}

function writePng(path, dataUrl) {
	const decoded = decodePng(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
	writeFileSync(path, encodePng(decoded.width, decoded.height, decoded.data))
}

function writeDiff(path, aUrl, bUrl) {
	const a = decodePng(Buffer.from(aUrl.slice(aUrl.indexOf(',') + 1), 'base64'))
	const b = decodePng(Buffer.from(bUrl.slice(bUrl.indexOf(',') + 1), 'base64'))
	const data = Buffer.alloc(a.data.length)
	for (let i = 0; i < data.length; i += 4) {
		data[i] = Math.min(255, Math.abs(a.data[i] - b.data[i]) * 4)
		data[i + 1] = Math.min(255, Math.abs(a.data[i + 1] - b.data[i + 1]) * 4)
		data[i + 2] = Math.min(255, Math.abs(a.data[i + 2] - b.data[i + 2]) * 4)
		data[i + 3] = 255
	}
	writeFileSync(path, encodePng(a.width, a.height, data))
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
	if (!Number.isInteger(n) || n <= 0)
		throw new Error(`shroudvisualgate: --${name} must be a positive integer`)
	return n
}

function parseFlags(args) {
	const values = new Set(['out', 'url', 'port', 'falsify'])
	const booleans = new Set(['keep-server'])
	const out = new Map()
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (!arg.startsWith('--'))
			throw new Error(`shroudvisualgate: unknown positional argument '${arg}'`)
		const body = arg.slice(2)
		const eq = body.indexOf('=')
		const name = eq < 0 ? body : body.slice(0, eq)
		if (booleans.has(name)) out.set(name, true)
		else if (values.has(name)) {
			const raw = eq < 0 ? args[++i] : body.slice(eq + 1)
			if (raw == null || raw === '') throw new Error(`shroudvisualgate: --${name} requires a value`)
			out.set(name, raw)
		} else throw new Error(`shroudvisualgate: unknown flag --${name}`)
	}
	return out
}
