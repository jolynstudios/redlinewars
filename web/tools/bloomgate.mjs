#!/usr/bin/env node
// STEELSEED — tools/bloomgate
//
// Stage-2 bloom gate. It proves three different claims with three different signals:
//   1. the source is the functional emitter key, never pale scene luminance;
//   2. that key reaches a non-empty quarter-resolution HDR halo;
//   3. the structural zero build reproduces the pre-bloom frame byte-for-byte and owns
//      no bloom texture at all.
//
// Usage:
//   node tools/bloomgate.mjs [--port=n] [--out=dir] [--zero-control]
//   node tools/bloomgate.mjs [--port=n] [--out=dir] --falsify=luminance
//
// The falsifier drives the REAL forward/TAA/bloom path with a deliberately wrong HDR
// luminance key. It must fail source purity; mutating the measured array here would test
// arithmetic, not the renderer.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchGpuBrowser, loadChromium, startPreview, stopChild } from './harness.mjs'

const TOOL = 'bloomgate'
const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ZERO_RGBA_SHA256 = '300b65be5f0a542a76178729c6a4da27127150d9581ec2ed6669df451800e554'
const KEY_EPSILON = 1e-5
const EMISSION_EPSILON = 1e-5
const BLOOM_EPSILON = 1e-5
// Closest-zoom units are at least ~60 px across. One quarter is the art-direction ceiling:
// beyond it a point source becomes a glow around the machine rather than a compact halo.
const MAX_HALO_EXTENSION_PX = 15

const flags = parseFlags(process.argv.slice(2))
const value = (name, fallback) => flags.has(name) ? flags.get(name) : fallback
const zeroControl = flags.has('zero-control')
const falsify = value('falsify', null)
if (falsify != null && falsify !== 'luminance')
	throw new Error(`${TOOL}: unknown --falsify=${falsify}`)
if (zeroControl && falsify != null)
	throw new Error(`${TOOL}: --zero-control and --falsify are mutually exclusive`)

const suppliedUrl = value('url', null)
const port = positiveInteger(value('port', 8398), 'port')
const outDir = resolve(value('out', '/tmp/steelseed-bloom'))

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
	// The rAF stub below holds app.start() before boot, and this tool then pumps all 90
	// frames inside one synchronous task. pumpSnapshots holds first-world intake until the
	// async actor-type table lands, so within a single synchronous block every pump is
	// dropped: ctx.snapshot stayed null, nothing drew, and the gate read an empty source
	// key plus a 0/16000 depth-covered terrain probe. manual=1 makes main() await
	// app.ensureFirstSnapshot() before the steelseed global appears, so the world is
	// already live when the frame loop takes over; ?deterministic=1 stays (DPR 1).
	url.searchParams.set('manual', '1')
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

	const result = await page.evaluate(async ({ zeroControl, falsify, keyEpsilon, emissionEpsilon, bloomEpsilon }) => {
		const app = globalThis.steelseed
		app.stop()
		const device = app.ctx.device
		if (app.ctx.backend !== 'webgpu' || device == null)
			throw new Error(`bloomgate requires WebGPU; backend=${app.ctx.backend}`)
		const render = app.ctx.get('render')
		const camera = app.ctx.get('camera')
		camera.height = 12
		camera.heightGoal = 12

		// Debug value 17 is intentionally not in the public view table. It keeps ordinary
		// colour but substitutes luma(color) for the functional emitter key.
		render.debugView = falsify === 'luminance' ? 17 : 0
		for (let i = 0; i < 89; i++) app.renderOneFrame(i * (1000 / 60))
		app.renderOneFrame(89 * (1000 / 60))

		const featureCapture = await captureCanvas(app.ctx.canvas)
		let source = await readRgba16(render.targets.color, render.targets.width, render.targets.height, 'bloomgate.source')
		let depth = await readDepth(render.targets.depth, render.targets.width, render.targets.height)
		const bloomTexture = render.postChain.bloomTexture
		const hasBloomTarget = bloomTexture != null
		let bloom = null
		let bloomCapture = null
		let direct = null
		if (!zeroControl && hasBloomTarget) {
			// Three stateful clocks would otherwise desynchronise these passes and the
			// sub-pixel status band they must agree on:
			//   - the dev fixture advances one tick per pump and each renderOneFrame pumps,
			//     so the tracked column and the orbiting aircraft would move a tick per pass;
			//   - the deterministic Clock advances its interpolation phase every frame()
			//     call (clock.ts: alpha is a function of an internal frame counter), so even
			//     a re-render at the same timestamp lands ~0.42 tick later;
			//   - TAA history blends 90 ticks of moving emitters into the key, leaving a
			//     one-pixel ghost on each side of the band's path.
			// Any one of them turns band pixels into both extra and missed keys (measured:
			// 188/165 unfrozen, 32/32 frozen, 128/132 frozen but unpinned alpha). So: freeze
			// the bridge, pin the clock's interpolation counter, and re-render with history
			// disabled — then the key, the bloom readback and the AOV all describe the exact
			// same world state, which is what "the identical jitter sample" always meant.
			// The zero control keeps its accumulated-history witness and pinned hash untouched.
			const bridge = app.bridge
			const realPoll = bridge.pollSnapshot
			bridge.pollSnapshot = () => null
			render.frameIndex = 89
			app.clock.time.frame = 89
			render.historyValid = false
			app.renderOneFrame(89 * (1000 / 60))
			source = await readRgba16(render.targets.color, render.targets.width, render.targets.height, 'bloomgate.source')
			depth = await readDepth(render.targets.depth, render.targets.width, render.targets.height)
			bloom = await readRgba16(
				bloomTexture,
				render.postChain.bloomWidth,
				render.postChain.bloomHeight,
				'bloomgate.bloom',
			)
			// Bloom-only display. Forward treats 16 as ordinary shading so the key still exists;
			// post replaces the scene with the already-blurred target.
			render.frameIndex = 89
			app.clock.time.frame = 89
			render.debugView = 16
			render.historyValid = false
			app.renderOneFrame(89 * (1000 / 60))
			bloomCapture = await captureCanvas(app.ctx.canvas)
			// The stage-1 emission AOV uses the identical jitter sample. Its non-zero support is
			// the independent truth set against which the ordinary frame's alpha key is judged.
			render.frameIndex = 89
			app.clock.time.frame = 89
			render.debugView = 15
			render.historyValid = false
			app.renderOneFrame(89 * (1000 / 60))
			bridge.pollSnapshot = realPoll
			direct = await readRgba16(render.targets.color, render.targets.width, render.targets.height, 'bloomgate.direct')
		}
		let keyedPixels = 0
		let directPixels = 0
		let extraKeyPixels = 0
		let missedKeyPixels = 0
		let signMismatchPixels = 0
		let missedEmissionPeak = 0
		let missedKeyPeak = 0
		let keyedEmissionFloor = Infinity
		let eligibleBodyPixels = 0
		let bodyMask = null
		const missedExamples = []
		if (direct != null) {
			bodyMask = new Uint8Array(source.length / 4)
			for (let i = 0; i < source.length / 4; i++) {
				const o = i * 4
				const key = source[o + 3]
				const keyed = Math.abs(key) > keyEpsilon
				const emitted = direct[o] * 0.2126 + direct[o + 1] * 0.7152 + direct[o + 2] * 0.0722
				// Debug 15 deliberately marks eligible unit-body pixels with negative alpha.
				// Depth alone is insufficient: some non-AOV RGB survives at depth-covered
				// pixels, while this alpha is the AOV's explicit body mask.
				const isBody = depth[i] > 0 && direct[o + 3] < 0
				const isDirect = isBody && emitted > emissionEpsilon
				if (isBody) {
					bodyMask[i] = 1
					eligibleBodyPixels++
				}
				if (keyed) keyedPixels++
				if (isDirect) directPixels++
				if (keyed && !isDirect) extraKeyPixels++
				if (!keyed && isDirect) {
					missedKeyPixels++
					missedEmissionPeak = Math.max(missedEmissionPeak, emitted)
					missedKeyPeak = Math.max(missedKeyPeak, Math.abs(key))
					if (missedExamples.length < 12) missedExamples.push({
						x: i % render.targets.width,
						y: Math.floor(i / render.targets.width),
						emitted,
						key,
						direct: [direct[o], direct[o + 1], direct[o + 2]],
						source: [source[o], source[o + 1], source[o + 2]],
					})
				}
				if (keyed && isDirect) {
					keyedEmissionFloor = Math.min(keyedEmissionFloor, emitted)
					const warm = direct[o] > direct[o + 2] * 1.25
					if ((warm && key < 0) || (!warm && key > 0)) signMismatchPixels++
				}
			}
		}

		let bloomPixels = 0
		let bloomPeak = 0
		let bloomEnergy = 0
		let maxHaloExtensionPx = 0
		let distanceToBody = null
		if (bodyMask != null)
			distanceToBody = chebyshevDistance(bodyMask, render.targets.width, render.targets.height)
		if (bloom != null) {
			for (let i = 0; i < bloom.length / 4; i++) {
				const o = i * 4
				const lum = bloom[o] * 0.2126 + bloom[o + 1] * 0.7152 + bloom[o + 2] * 0.0722
				if (lum > bloomEpsilon) {
					bloomPixels++
					if (distanceToBody != null) {
						const bw = render.postChain.bloomWidth
						const bh = render.postChain.bloomHeight
						const bx = i % bw
						const by = Math.floor(i / bw)
						// Measure the farthest full-resolution pixel covered by this texel so
						// downsampling cannot make the halo look smaller than the player sees.
						const x0 = Math.floor(bx * render.targets.width / bw)
						const x1 = Math.min(render.targets.width - 1, Math.ceil((bx + 1) * render.targets.width / bw) - 1)
						const y0 = Math.floor(by * render.targets.height / bh)
						const y1 = Math.min(render.targets.height - 1, Math.ceil((by + 1) * render.targets.height / bh) - 1)
						for (let y = y0; y <= y1; y++) {
							for (let x = x0; x <= x1; x++) {
								maxHaloExtensionPx = Math.max(maxHaloExtensionPx, distanceToBody[y * render.targets.width + x])
							}
						}
					}
				}
				bloomPeak = Math.max(bloomPeak, lum)
				bloomEnergy += Math.max(0, lum)
			}
		}

		// Fixed-workload terrain witness. This rectangle is the exposed ground in the
		// lower-left of the height-12, 900x620 gate frame: it is depth-covered, contains
		// no unit body, and sits more than a full halo diameter from the nearest emitter.
		// The bloom source is global HDR alpha, so sampling only the unit AOV would miss
		// an accidental key written by another pipeline (terrain was the concrete risk).
		const terrainProbe = {
			rect: [40, 480, 200, 580],
			pixels: 0,
			depthCovered: 0,
			keyed: 0,
			keyPeak: 0,
			bloomPixels: 0,
			bloomPeak: 0,
		}
		for (let y = terrainProbe.rect[1]; y < terrainProbe.rect[3]; y++) {
			for (let x = terrainProbe.rect[0]; x < terrainProbe.rect[2]; x++) {
				const i = y * render.targets.width + x
				const key = Math.abs(source[i * 4 + 3])
				terrainProbe.pixels++
				if (depth[i] > 0) terrainProbe.depthCovered++
				if (key > keyEpsilon) terrainProbe.keyed++
				terrainProbe.keyPeak = Math.max(terrainProbe.keyPeak, key)
			}
		}
		if (bloom != null) {
			const bw = render.postChain.bloomWidth
			const bh = render.postChain.bloomHeight
			const bx0 = Math.floor(terrainProbe.rect[0] * bw / render.targets.width)
			const bx1 = Math.ceil(terrainProbe.rect[2] * bw / render.targets.width)
			const by0 = Math.floor(terrainProbe.rect[1] * bh / render.targets.height)
			const by1 = Math.ceil(terrainProbe.rect[3] * bh / render.targets.height)
			for (let by = by0; by < by1; by++) {
				for (let bx = bx0; bx < bx1; bx++) {
					const o = (by * bw + bx) * 4
					const lum = bloom[o] * 0.2126 + bloom[o + 1] * 0.7152 + bloom[o + 2] * 0.0722
					if (lum > bloomEpsilon) terrainProbe.bloomPixels++
					terrainProbe.bloomPeak = Math.max(terrainProbe.bloomPeak, lum)
				}
			}
		}

		return {
			canvasHash: featureCapture.hash,
			featurePng: featureCapture.png,
			bloomPng: bloomCapture?.png ?? null,
			camera: { height: camera.height, heightGoal: camera.heightGoal },
			hasBloomTarget,
			bloomSize: hasBloomTarget ? [render.postChain.bloomWidth, render.postChain.bloomHeight] : null,
			bloomVramBytes: hasBloomTarget ? render.postChain.bloomWidth * render.postChain.bloomHeight * 8 : 0,
			keyedPixels,
			directPixels,
			extraKeyPixels,
			missedKeyPixels,
			signMismatchPixels,
			missedEmissionPeak,
			missedKeyPeak,
			keyedEmissionFloor: Number.isFinite(keyedEmissionFloor) ? keyedEmissionFloor : 0,
			eligibleBodyPixels,
			missedExamples,
			bloomPixels,
			bloomPeak,
			bloomEnergy,
			maxHaloExtensionPx,
			terrainProbe,
			stats: {
				drawCalls: render.stats.drawCalls,
				triangles: render.stats.triangles,
				pipelineCreations: render.stats.pipelineCreations,
				dropped: render.stats.dropped,
				lightsDropped: render.stats.lightsDropped,
			},
		}

		async function captureCanvas(sourceCanvas) {
			const copy = document.createElement('canvas')
			copy.width = sourceCanvas.width
			copy.height = sourceCanvas.height
			copy.getContext('2d').drawImage(sourceCanvas, 0, 0)
			const rgba = copy.getContext('2d').getImageData(0, 0, copy.width, copy.height).data
			const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', rgba))
			return {
				hash: [...digest].map(v => v.toString(16).padStart(2, '0')).join(''),
				png: copy.toDataURL('image/png'),
			}
		}

		async function readRgba16(texture, width, height, label) {
			const bytesPerRow = Math.ceil(width * 8 / 256) * 256
			const buffer = device.createBuffer({
				label,
				size: bytesPerRow * height,
				usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
			})
			const encoder = device.createCommandEncoder({ label: `${label}.copy` })
			encoder.copyTextureToBuffer(
				{ texture },
				{ buffer, bytesPerRow, rowsPerImage: height },
				{ width, height, depthOrArrayLayers: 1 },
			)
			device.queue.submit([encoder.finish()])
			await buffer.mapAsync(GPUMapMode.READ)
			try {
				const view = new DataView(buffer.getMappedRange())
				const out = new Float32Array(width * height * 4)
				for (let y = 0; y < height; y++) {
					for (let x = 0; x < width; x++) {
						const input = y * bytesPerRow + x * 8
						const output = (y * width + x) * 4
						for (let c = 0; c < 4; c++) out[output + c] = halfToFloat(view.getUint16(input + c * 2, true))
					}
				}
				return out
			} finally {
				buffer.unmap()
				buffer.destroy()
			}
		}

		async function readDepth(texture, width, height) {
			const bytesPerRow = Math.ceil(width * 4 / 256) * 256
			const buffer = device.createBuffer({
				label: 'bloomgate.depth',
				size: bytesPerRow * height,
				usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
			})
			const encoder = device.createCommandEncoder({ label: 'bloomgate.depth.copy' })
			encoder.copyTextureToBuffer(
				{ texture, aspect: 'depth-only' },
				{ buffer, bytesPerRow, rowsPerImage: height },
				{ width, height, depthOrArrayLayers: 1 },
			)
			device.queue.submit([encoder.finish()])
			await buffer.mapAsync(GPUMapMode.READ)
			try {
				const view = new DataView(buffer.getMappedRange())
				const out = new Float32Array(width * height)
				for (let y = 0; y < height; y++) {
					for (let x = 0; x < width; x++)
						out[y * width + x] = view.getFloat32(y * bytesPerRow + x * 4, true)
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

		function chebyshevDistance(mask, width, height) {
			const distance = new Int16Array(mask.length)
			distance.fill(-1)
			const queue = new Int32Array(mask.length)
			let head = 0
			let tail = 0
			for (let i = 0; i < mask.length; i++) {
				if (mask[i] === 0) continue
				distance[i] = 0
				queue[tail++] = i
			}
			while (head < tail) {
				const i = queue[head++]
				const x = i % width
				const y = Math.floor(i / width)
				const next = distance[i] + 1
				for (let dy = -1; dy <= 1; dy++) {
					for (let dx = -1; dx <= 1; dx++) {
						if (dx === 0 && dy === 0) continue
						const nx = x + dx
						const ny = y + dy
						if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
						const ni = ny * width + nx
						if (distance[ni] >= 0) continue
						distance[ni] = next
						queue[tail++] = ni
					}
				}
			}
			return distance
		}
	}, {
		zeroControl,
		falsify,
		keyEpsilon: KEY_EPSILON,
		emissionEpsilon: EMISSION_EPSILON,
		bloomEpsilon: BLOOM_EPSILON,
	})

	await context.close()
	if (diagnostics.length > 0) throw new Error(diagnostics[0])
	const featurePng = Buffer.from(result.featurePng.slice(result.featurePng.indexOf(',') + 1), 'base64')
	writeFileSync(join(outDir, zeroControl ? 'zero.png' : falsify ? 'falsify.png' : 'bloom.png'), featurePng)
	if (result.bloomPng != null) {
		const bloomPng = Buffer.from(result.bloomPng.slice(result.bloomPng.indexOf(',') + 1), 'base64')
		writeFileSync(join(outDir, falsify ? 'falsify-debug.png' : 'bloom-debug.png'), bloomPng)
	}
	delete result.featurePng
	delete result.bloomPng

	console.log(`${TOOL}: canvas rgba sha256=${result.canvasHash}`)
	console.log(
		`${TOOL}: source keyed=${result.keyedPixels} direct=${result.directPixels} ` +
		`extra=${result.extraKeyPixels} missed=${result.missedKeyPixels} sign-mismatch=${result.signMismatchPixels}`,
	)
	console.log(
		`${TOOL}: bloom target=${result.hasBloomTarget ? result.bloomSize.join('x') : 'none'} ` +
		`pixels=${result.bloomPixels} peak=${result.bloomPeak.toFixed(6)} energy=${result.bloomEnergy.toFixed(3)} ` +
		`extension=${result.maxHaloExtensionPx}px vram=${(result.bloomVramBytes / (1024 * 1024)).toFixed(3)} MiB`,
	)
	console.log(
		`${TOOL}: terrain probe=${result.terrainProbe.rect.join(',')} depth=${result.terrainProbe.depthCovered}/${result.terrainProbe.pixels} ` +
		`keyed=${result.terrainProbe.keyed} key-peak=${result.terrainProbe.keyPeak.toFixed(6)} ` +
		`bloom=${result.terrainProbe.bloomPixels} bloom-peak=${result.terrainProbe.bloomPeak.toFixed(6)}`,
	)

	const problems = []
	if (result.camera.height !== 12 || result.camera.heightGoal !== 12)
		problems.push(`camera was ${result.camera.height}/${result.camera.heightGoal}, expected exact 12/12`)
	if (result.stats.pipelineCreations !== 0)
		problems.push(`${result.stats.pipelineCreations} pipeline creation(s) after prewarm`)
	if (result.stats.dropped !== 0 || result.stats.lightsDropped !== 0)
		problems.push(`dropped geometry=${result.stats.dropped} lights=${result.stats.lightsDropped}`)
	if (zeroControl) {
		if (result.canvasHash !== ZERO_RGBA_SHA256)
			problems.push(`zero control changed frame ${ZERO_RGBA_SHA256} -> ${result.canvasHash}`)
		if (result.hasBloomTarget)
			problems.push('zero control still allocated a bloom target')
	} else {
		if (!result.hasBloomTarget) problems.push('bloom target is absent')
		if (result.canvasHash === ZERO_RGBA_SHA256) problems.push('feature frame is byte-identical to zero baseline')
		if (result.keyedPixels === 0 || result.directPixels === 0) problems.push('emissive source key is empty')
		if (result.extraKeyPixels !== 0) problems.push(`${result.extraKeyPixels} key pixel(s) have no direct emission source`)
		if (result.missedKeyPixels !== 0) problems.push(`${result.missedKeyPixels} direct emission pixel(s) have no key`)
		if (result.signMismatchPixels !== 0) problems.push(`${result.signMismatchPixels} warm/cool key sign mismatch(es)`)
		if (result.terrainProbe.depthCovered !== result.terrainProbe.pixels)
			problems.push(`terrain probe is not fully depth-covered (${result.terrainProbe.depthCovered}/${result.terrainProbe.pixels})`)
		if (result.terrainProbe.keyed !== 0 || result.terrainProbe.keyPeak > KEY_EPSILON)
			problems.push(`terrain probe leaked ${result.terrainProbe.keyed} key pixel(s), peak ${result.terrainProbe.keyPeak}`)
		if (result.terrainProbe.bloomPixels !== 0 || result.terrainProbe.bloomPeak > BLOOM_EPSILON)
			problems.push(`terrain probe received ${result.terrainProbe.bloomPixels} bloom pixel(s), peak ${result.terrainProbe.bloomPeak}`)
		if (result.bloomPixels === 0 || !(result.bloomPeak > 0)) problems.push('bloom target is empty')
		if (result.maxHaloExtensionPx > MAX_HALO_EXTENSION_PX)
			problems.push(`halo extends ${result.maxHaloExtensionPx}px beyond the nearest unit body; ceiling ${MAX_HALO_EXTENSION_PX}px`)
	}

	writeFileSync(join(outDir, zeroControl ? 'zero.json' : falsify ? 'falsify.json' : 'bloom.json'), `${JSON.stringify(result, null, 2)}\n`)
	if (problems.length > 0) {
		for (const problem of problems) console.error(`${TOOL}: FAIL — ${problem}`)
		exitCode = 1
	} else console.log(`${TOOL}: PASS — ${zeroControl ? 'zero defeat is exact and structural' : 'source is emissive-only and halo is non-empty'}`)
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
