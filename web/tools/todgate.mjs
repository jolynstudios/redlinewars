#!/usr/bin/env node
// STEELSEED — tools/todgate
// The `sky` node's §0.2 gate, made executable — and the permanent defence of the
// exposure clamp landed at e334346.
//
// Gates both halves of the §7.1 display-range predicate at DPR 2 / high:
//
//   1. displayed p99 channel range >= 3:1 across the cycle;
//   2. depth-masked displayed geometry mean-luminance range >= 4:1.
//
// p99 rather than max is load-bearing: max is ONE PIXEL, and an unrelated content
// change moved the night peak 2.2x. Geometry is selected from the renderer's reverse-Z
// depth texture, then eroded by two pixels so sky/geometry boundary filtering cannot
// contaminate the mean.
//
// `?deterministic=1` is deliberately absent. Core pins renderer DPR to 1 in that mode,
// regardless of the browser context. Instead the tool holds rAF before boot and drives
// fixed frame timestamps itself, preserving the specified DPR-2 workload.
//
// Usage:
//   node tools/todgate.mjs [--tods=720,330,1080,60] [--min-ratio=3]
//       [--min-geometry-ratio=4] [--frames=360] [--port=n] [--url=u] [--keep]

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DEFAULT_HEIGHT,
	DEFAULT_WIDTH,
	launchGpuBrowser,
	loadChromium,
	startPreview,
	stopChild,
} from './harness.mjs'

const TOOL = 'todgate'
const SEED = 'steelseed-default'
const DEV_SIZE = 96
const MASK_EROSION_RADIUS = 2

const flags = new Map()
for (const arg of process.argv.slice(2)) {
	const match = /^--([^=]+)(?:=(.*))?$/.exec(arg)
	if (match) flags.set(match[1], match[2] ?? 'true')
}

const tods = String(flags.get('tods') ?? '720,330,1080,60').split(',').map(Number)
const minP99Ratio = Number(flags.get('min-ratio') ?? 3)
const minGeometryRatio = Number(flags.get('min-geometry-ratio') ?? 4)
const frames = Number(flags.get('frames') ?? 360)
const port = Number(flags.get('port') ?? 8701)
const suppliedUrl = flags.get('url') ?? null
const width = Number(flags.get('width') ?? DEFAULT_WIDTH)
const height = Number(flags.get('height') ?? DEFAULT_HEIGHT)
const dpr = Number(flags.get('dpr') ?? 2)
const keep = flags.has('keep')

if (tods.length < 2 || tods.some(value => !Number.isFinite(value))) {
	console.error(`${TOOL}: --tods needs at least two numeric minutes-of-day`)
	process.exit(2)
}
if (
	![minP99Ratio, minGeometryRatio, frames, port, width, height, dpr].every(Number.isFinite) ||
	minP99Ratio <= 0 ||
	minGeometryRatio <= 0 ||
	!Number.isInteger(frames) ||
	frames <= 0 ||
	!Number.isInteger(width) ||
	width <= 0 ||
	!Number.isInteger(height) ||
	height <= 0 ||
	dpr <= 0
) {
	console.error(`${TOOL}: ratios, dimensions, DPR, port and frame count must be positive numbers`)
	process.exit(2)
}
if (dpr !== 2) {
	console.error(`${TOOL}: --dpr must be 2; §7.1 defines this gate at DPR 2 / high`)
	process.exit(2)
}

const outDir = keep ? mkdtempSync(join(tmpdir(), 'steelseed-todgate-')) : null

let browser = null
let server = null
let results = []

try {
	const preview = await startPreview(port, suppliedUrl)
	server = preview.server
	const chromium = await loadChromium(TOOL)
	const launched = await launchGpuBrowser(chromium, TOOL)
	browser = launched.browser
	if (launched.warning) console.warn(launched.warning)
	console.log(
		`${TOOL}: ${launched.label}, ${width}x${height} CSS, DPR ${dpr}, high, ` +
		`${frames} fixed frames`,
	)

	for (const tod of tods) {
		const result = await captureTime(browser, preview.baseUrl, tod)
		results.push(result)
		if (outDir && result.dataUrl) {
			const encoded = result.dataUrl.slice(result.dataUrl.indexOf(',') + 1)
			writeFileSync(join(outDir, `tod-${tod}.png`), Buffer.from(encoded, 'base64'))
		}
		console.log(
			`${TOOL}: devtod=${String(tod).padStart(4)}  ` +
			`p99 channel ${String(result.p99Channel).padStart(3)}  ` +
			`geometry mean ${result.geometryMeanLuma.toFixed(3)}  ` +
			`exposure ${result.exposure.toFixed(4)} / avgLum ${result.averageLuminance.toFixed(5)}  ` +
			`geometry pixels ${result.geometryPixels}  ` +
			`canvas ${result.canvas.width}x${result.canvas.height}`,
		)
	}
} catch (error) {
	console.error(`${TOOL}: FAIL — ${error.message}`)
	process.exitCode = 1
} finally {
	if (browser) await browser.close()
	await stopChild(server)
	if (outDir) console.log(`${TOOL}: captures kept in ${outDir}`)
}

if (process.exitCode) process.exit(process.exitCode)

const depthHashes = new Set(results.map(result => result.depthHash))
const maskHashes = new Set(results.map(result => result.geometryMaskHash))
if (depthHashes.size !== 1 || maskHashes.size !== 1) {
	console.error(
		`${TOOL}: FAIL — depth/mask control moved across time of day ` +
		`(depth variants=${depthHashes.size}, mask variants=${maskHashes.size}).`,
	)
	console.error(`${TOOL}: The harness or fixture changed geometry; lighting ratios are invalid.`)
	process.exit(1)
}
console.log(
	`${TOOL}: control depth ${shortHash(results[0].depthHash)} / ` +
	`geometry mask ${shortHash(results[0].geometryMaskHash)} exact across ${results.length} captures`,
)

const p99Range = rangeOf(results, result => result.p99Channel)
const geometryRange = rangeOf(results, result => result.geometryMeanLuma)

console.log(
	`${TOOL}: p99 range ${p99Range.ratio.toFixed(3)}:1 ` +
	`(devtod=${p99Range.brightest.tod} ${p99Range.brightest.value} / ` +
	`devtod=${p99Range.darkest.tod} ${p99Range.darkest.value}), ` +
	`gate >= ${minP99Ratio}:1`,
)
console.log(
	`${TOOL}: geometry-mean range ${geometryRange.ratio.toFixed(3)}:1 ` +
	`(devtod=${geometryRange.brightest.tod} ${geometryRange.brightest.value.toFixed(3)} / ` +
	`devtod=${geometryRange.darkest.tod} ${geometryRange.darkest.value.toFixed(3)}), ` +
	`gate >= ${minGeometryRatio}:1`,
)

let failed = false
if (p99Range.ratio < minP99Ratio) {
	failed = true
	console.error(
		`${TOOL}: FAIL — displayed p99 channel range is only ${p99Range.ratio.toFixed(3)}:1.`,
	)
}
if (geometryRange.ratio < minGeometryRatio) {
	failed = true
	console.error(
		`${TOOL}: FAIL — depth-masked displayed geometry range is only ` +
		`${geometryRange.ratio.toFixed(3)}:1.`,
	)
}
if (failed) {
	console.error(`${TOOL}: If exposure policy changed, inspect render/shaders.ts first.`)
	process.exit(1)
}
console.log(`${TOOL}: PASS`)

async function captureTime(activeBrowser, baseUrl, tod) {
	const context = await activeBrowser.newContext({
		viewport: { width, height },
		deviceScaleFactor: dpr,
		locale: 'en-US',
		timezoneId: 'UTC',
	})
	const page = await context.newPage()
	const errors = []
	page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
	page.on('console', message => {
		if (message.type() === 'error' && !/^Failed to load resource:/.test(message.text()))
			errors.push(`console.error: ${message.text()}`)
	})
	page.on('response', response => {
		if (response.status() < 400) return
		if (new URL(response.url()).pathname === '/favicon.ico') return
		errors.push(`http ${response.status()}: ${response.url()}`)
	})

	// Hold the application's loop without enabling core deterministic mode, because that
	// mode pins the renderer to DPR 1. All measured frames are driven below.
	await page.addInitScript(() => {
		let nextId = 1
		const pending = new Set()
		globalThis.requestAnimationFrame = () => {
			const id = nextId++
			pending.add(id)
			return id
		}
		globalThis.cancelAnimationFrame = id => pending.delete(id)
		// The wall clock must also be pinned: the depth/mask control hashes one boot
		// per time of day, and a wall-clock boot lands on different tick alphas,
		// which jitter actor interpolation by a subpixel and flip depth-mask edge
		// pixels between boots. A stepped fake clock keeps every frame index on the
		// same tick/alpha in every boot while leaving DPR free.
		let nowMs = 0
		globalThis.performance = Object.create(globalThis.performance)
		globalThis.performance.now = () => (nowMs += 1000 / 60)
	})

	try {
		const url = new URL(baseUrl)
		url.searchParams.set('devmap', '1')
		// The tool holds rAF before boot, so app.start() would never pump a frame.
		// Without ?manual=1 the boot never settles the world either: pumpSnapshots
		// holds first-world intake until the actor-type table lands (an async
		// refresh), and this capture pumps all 360 frames inside one synchronous
		// task, so every pump is dropped, ctx.snapshot stays null, and the depth
		// target contains only sky ("depth mask contains no geometry pixels").
		// manual=1 makes main() await app.ensureFirstSnapshot() instead; it pins
		// nothing else — ?deterministic=1 stays absent so DPR 2 is preserved.
		url.searchParams.set('manual', '1')
		url.searchParams.set('seed', SEED)
		url.searchParams.set('devsize', String(DEV_SIZE))
		url.searchParams.set('devtod', String(tod))
		url.searchParams.set('devweather', '0')
		url.searchParams.set('devweatherintensity', '0')
		url.searchParams.set('quality', 'high')
		await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60_000 })
		await page.waitForFunction(
			() => {
				const failure = document.getElementById('boot-fail')
				if (failure && !failure.hidden && failure.textContent)
					throw new Error(`boot failed: ${failure.textContent}`)
				return globalThis.steelseed !== undefined
			},
			undefined,
			{ timeout: 120_000, polling: 100 },
		)

		const result = await page.evaluate(async ({
			frameCount,
			expectedDpr,
			erosionRadius,
			retainImage,
		}) => {
			const app = globalThis.steelseed
			app.stop()
			const device = app.ctx.device
			if (app.ctx.backend !== 'webgpu' || device == null)
				throw new Error(`gate requires WebGPU; backend=${app.ctx.backend}`)
			if (app.config.q.name !== 'high')
				throw new Error(`gate requires high quality; got ${app.config.q.name}`)
			if (app.config.devicePixelRatio !== expectedDpr)
				throw new Error(
					`gate requires renderer DPR ${expectedDpr}; got ${app.config.devicePixelRatio}`,
				)

			const render = app.ctx.get('render')
			// The exposure-range fixture predates production headlamps. Suppress punctual
			// submissions so this remains a sky/exposure gate rather than a vehicle-count gate.
			render.addLight = () => {}
			const uncaptured = []
			device.addEventListener('uncapturederror', event => {
				uncaptured.push(event.error?.message ?? String(event.error))
			})

			for (let frame = 0; frame < frameCount; frame++)
				app.renderOneFrame(frame * (1000 / 60))

			// Load-bearing ordering: copy the non-preserved WebGPU canvas in the same task
			// that presented it. Awaiting before drawImage returns a healthy frame as black.
			const source = app.ctx.canvas
			const copy = document.createElement('canvas')
			copy.width = source.width
			copy.height = source.height
			const graphics = copy.getContext('2d')
			if (!graphics) throw new Error('could not create display readback canvas')
			graphics.drawImage(source, 0, 0)
			const rgba = graphics.getImageData(0, 0, copy.width, copy.height).data
			const dataUrl = retainImage ? copy.toDataURL('image/png') : null

			const targets = render.targets
			if (targets.width !== copy.width || targets.height !== copy.height)
				throw new Error(
					`canvas/target mismatch: canvas ${copy.width}x${copy.height}, ` +
					`target ${targets.width}x${targets.height}`,
				)
			const bytesPerRow = Math.ceil(targets.width * 4 / 256) * 256
			const depthCopy = device.createBuffer({
				label: 'todgate.depth-readback',
				size: bytesPerRow * targets.height,
				usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
			})
			const exposureCopy = device.createBuffer({
				label: 'todgate.exposure-readback',
				size: 16,
				usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
			})
			const encoder = device.createCommandEncoder({ label: 'todgate.depth-copy' })
			encoder.copyTextureToBuffer(
				{ texture: targets.depth, aspect: 'depth-only' },
				{ buffer: depthCopy, bytesPerRow, rowsPerImage: targets.height },
				{ width: targets.width, height: targets.height, depthOrArrayLayers: 1 },
			)
			encoder.copyBufferToBuffer(render.postChain.exposureBuffer, 0, exposureCopy, 0, 16)
			device.queue.submit([encoder.finish()])
			await Promise.all([
				depthCopy.mapAsync(GPUMapMode.READ),
				exposureCopy.mapAsync(GPUMapMode.READ),
			])

			try {
				const mapped = new DataView(depthCopy.getMappedRange())
				const exposureValues = new Float32Array(exposureCopy.getMappedRange())
				const depth = new Float32Array(targets.width * targets.height)
				const rawGeometry = new Uint8Array(depth.length)
				for (let y = 0; y < targets.height; y++) {
					for (let x = 0; x < targets.width; x++) {
						const index = y * targets.width + x
						const value = mapped.getFloat32(y * bytesPerRow + x * 4, true)
						depth[index] = value
						rawGeometry[index] = value > 1e-8 ? 1 : 0
					}
				}
				const geometry = erodeMask(
					rawGeometry,
					targets.width,
					targets.height,
					erosionRadius,
				)

				const channelHistogram = new Uint32Array(256)
				let maxChannel = 0
				for (let index = 0; index < rgba.length; index += 4) {
					channelHistogram[rgba[index]]++
					channelHistogram[rgba[index + 1]]++
					channelHistogram[rgba[index + 2]]++
					maxChannel = Math.max(
						maxChannel,
						rgba[index],
						rgba[index + 1],
						rgba[index + 2],
					)
				}

				let geometryPixels = 0
				let geometryMeanLuma = 0
				for (let index = 0; index < geometry.length; index++) {
					if (!geometry[index]) continue
					const offset = index * 4
					const luma =
						0.2126 * rgba[offset] +
						0.7152 * rgba[offset + 1] +
						0.0722 * rgba[offset + 2]
					geometryPixels++
					geometryMeanLuma += (luma - geometryMeanLuma) / geometryPixels
				}

				if (geometryPixels === 0)
					throw new Error('depth mask contains no geometry pixels')
				await device.queue.onSubmittedWorkDone()
				if (uncaptured.length)
					throw new Error(`uncaptured GPU error: ${uncaptured[0]}`)
				if (render.stats.pipelineCreations !== 0)
					throw new Error(`pipeline creations after prewarm: ${render.stats.pipelineCreations}`)
				if (render.stats.dropped !== 0 || render.stats.lightsDropped !== 0)
					throw new Error(
						`dropped submissions: geometry=${render.stats.dropped}, ` +
						`lights=${render.stats.lightsDropped}`,
					)

				return {
					p99Channel: histogramPercentile(
						channelHistogram,
						(rgba.length / 4) * 3,
						0.99,
					),
					maxChannel,
					geometryMeanLuma,
					exposure: exposureValues[0],
					averageLuminance: exposureValues[1],
					geometryPixels,
					rawGeometryPixels: countMask(rawGeometry),
					depthHash: await sha256(depth),
					geometryMaskHash: await sha256(geometry),
					dataUrl,
					backend: app.ctx.backend,
					quality: app.config.q.name,
					dpr: app.config.devicePixelRatio,
					canvas: { width: copy.width, height: copy.height },
					stats: { ...render.stats },
				}
			} finally {
				depthCopy.unmap()
				depthCopy.destroy()
				exposureCopy.unmap()
				exposureCopy.destroy()
			}

			function erodeMask(input, maskWidth, maskHeight, radius) {
				if (radius === 0) return input.slice()
				// Separable box sums implement the same square binary erosion as the
				// diagnostic's nested loops without 25 probes per DPR-2 pixel.
				const horizontal = new Uint8Array(input.length)
				const diameter = radius * 2 + 1
				for (let y = 0; y < maskHeight; y++) {
					let sum = 0
					for (let x = 0; x < maskWidth; x++) {
						sum += input[y * maskWidth + x]
						if (x > diameter - 1) sum -= input[y * maskWidth + x - diameter]
						if (x >= diameter - 1)
							horizontal[y * maskWidth + x - radius] = sum === diameter ? 1 : 0
					}
				}
				const output = new Uint8Array(input.length)
				for (let x = radius; x < maskWidth - radius; x++) {
					let sum = 0
					for (let y = 0; y < maskHeight; y++) {
						sum += horizontal[y * maskWidth + x]
						if (y > diameter - 1) sum -= horizontal[(y - diameter) * maskWidth + x]
						if (y >= diameter - 1)
							output[(y - radius) * maskWidth + x] = sum === diameter ? 1 : 0
					}
				}
				return output
			}

			function countMask(mask) {
				let count = 0
				for (let index = 0; index < mask.length; index++) count += mask[index]
				return count
			}

			function histogramPercentile(histogram, count, quantile) {
				const threshold = Math.ceil(count * quantile)
				let seen = 0
				for (let value = 0; value < histogram.length; value++) {
					seen += histogram[value]
					if (seen >= threshold) return value
				}
				return histogram.length - 1
			}

			async function sha256(values) {
				const bytes = values.buffer.slice(
					values.byteOffset,
					values.byteOffset + values.byteLength,
				)
				const hash = await crypto.subtle.digest('SHA-256', bytes)
				return Array.from(new Uint8Array(hash))
					.map(value => value.toString(16).padStart(2, '0'))
					.join('')
			}
		}, {
			frameCount: frames,
			expectedDpr: dpr,
			erosionRadius: MASK_EROSION_RADIUS,
			retainImage: keep,
		})

		if (errors.length) throw new Error(`devtod=${tod}: ${errors[0]}`)
		return { tod, ...result }
	} finally {
		await context.close()
	}
}

function rangeOf(items, select) {
	const values = items.map(item => ({ tod: item.tod, value: select(item) }))
	const brightest = values.reduce((a, b) => (b.value > a.value ? b : a))
	const darkest = values.reduce((a, b) => (b.value < a.value ? b : a))
	if (darkest.value <= 0)
		throw new Error(
			`devtod=${darkest.tod} produced zero for a range denominator; capture is broken`,
		)
	return { brightest, darkest, ratio: brightest.value / darkest.value }
}

function shortHash(hash) {
	return `${hash.slice(0, 12)}…`
}
