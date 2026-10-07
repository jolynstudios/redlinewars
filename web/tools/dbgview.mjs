#!/usr/bin/env node
// STEELSEED — tools/dbgview
// Captures every renderer-provided debug view plus direct HDR, TAA-history, velocity and depth
// readbacks. Missing views are reported as BLOCKED, never invented.
//
// Usage:
//   node tools/dbgview.mjs [--frames n] [--seed s] [--out dir]
//                          [--url u] [--port n] [--keep-server]

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
	DEFAULT_FRAMES,
	WEB_ROOT,
	launchGpuBrowser,
	loadChromium,
	startPreview,
	stopChild,
} from './harness.mjs'
import { decodePng, encodePng } from './png.mjs'

const flags = parseFlags(process.argv.slice(2))
const value = (name, fallback) => flags.has(name) ? flags.get(name) : fallback
const port = positiveInteger(value('port', 8382), 'port')
const frames = positiveInteger(value('frames', DEFAULT_FRAMES), 'frames')
const width = positiveInteger(value('width', 1512), 'width')
const height = positiveInteger(value('height', 982), 'height')
const devsize = positiveInteger(value('devsize', 96), 'devsize')
const seed = String(value('seed', 'steelseed-dbgview-v1'))
const outDir = resolve(value('out', join(WEB_ROOT, '.artifacts', 'dbgview')))
const suppliedUrl = value('url', null)

let browser = null
let server = null
let exitCode = 0

try {
	const chromium = await loadChromium('dbgview')
	const launched = await launchGpuBrowser(chromium, 'dbgview')
	browser = launched.browser
	if (launched.warning)
		console.warn(launched.warning)
	const preview = await startPreview(port, suppliedUrl)
	server = preview.server
	mkdirSync(outDir, { recursive: true })

	const captures = []
	const baseline = await captureMode('off', true)
	captures.push(baseline)
	const names = baseline.names
	if (names.length === 0 || names[0] !== 'off')
		throw new Error(`renderer returned an invalid debug-view table: ${names.join(', ')}`)

	for (const name of names.slice(1))
		captures.push(await captureMode(name, false))

	for (const capture of captures) {
		writeCanonicalPng(join(outDir, `${capture.name}.png`), capture.dataUrl)
		console.log(
			`dbgview: ${capture.name} max=${capture.pixels.maxChannel} ` +
				`buckets=${capture.pixels.distinctBuckets} draws=${capture.stats.drawCalls} ` +
				`pipelines=${capture.stats.pipelineCreations}`,
		)
	}
	for (const [name, dataUrl] of Object.entries(baseline.direct.dataUrls)) {
		writeCanonicalPng(join(outDir, `${name}.png`), dataUrl)
		const range = baseline.direct.ranges[name]
		console.log(
			`dbgview: ${name} direct readback min=${range.min.toFixed(6)} ` +
				`max=${range.max.toFixed(6)} finite=${range.finite}`,
		)
	}

	const directNames = Object.keys(baseline.direct.dataUrls)
	const missing = [
		[
			'overdraw',
			'needs a dedicated additive-blend pipeline; a forward-shader branch sees only the top fragment',
		],
		['velocity', 'requires a persistent motion-vector attachment'],
	].filter(([name]) => !names.includes(name) && !directNames.includes(name))
	const manifest = {
		schema: 1,
		capturedAt: new Date().toISOString(),
		browser: {
			label: launched.label,
			version: await browser.version(),
		},
		input: {
			source: 'devmap',
			deterministic: true,
			devicePixelRatio: 1,
			seed,
			frames,
			width,
			height,
			devsize,
		},
		rendererModes: names,
		directReadbacks: ['hdr', 'history', 'velocity', 'depth'],
		coverage: {
			giSplit: ['giOnly', 'sunOnly'],
			clusterHeatmap: 'lightCount',
			shadowCascades: 'cascade',
			aovs: ['albedo', 'normal', 'depth', 'roughness', 'velocity'],
			lod: {
				kind: 'numeric per-level renderer counts',
				gate: 'tools/lodgate.mjs',
				mainInstances: baseline.stats.lodMain,
				shadowInstances: baseline.stats.lodShadow,
			},
		},
		limits: {
			missing: Object.fromEntries(missing),
			velocity:
				'Persistent rg16float prepass AOV; tools/motiongate.mjs verifies it against submitted actor transforms.',
			attachments:
				'Named modes other than velocity are shader outputs into HDR, not persistent AOV attachments.',
		},
	}
	writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

	if (missing.length > 0) {
		for (const [name, reason] of missing)
			console.error(`dbgview: BLOCKED — ${name}: ${reason}`)
		console.error(
			`dbgview: PARTIAL — captured ${names.length} enumerated modes + ${directNames.length} direct ` +
				`readbacks; ${missing.length} §5.6 view(s) unavailable`,
		)
		exitCode = 1
	} else
		console.log(
			`dbgview: PASS — ${names.length} enumerated modes + ${directNames.length} direct readbacks captured`,
		)

	async function captureMode(name, includeDirect) {
		const context = await browser.newContext({
			viewport: { width, height },
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
			url.searchParams.set('deterministic', '1')
			url.searchParams.set('seed', seed)
			url.searchParams.set('devsize', String(devsize))
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
			)

			const result = await page.evaluate(
				async ({ debugName, frameCount, readDirect }) => {
					const app = globalThis.steelseed
					app.stop()
					const device = app.ctx.device
					if (app.ctx.backend !== 'webgpu' || device == null)
						throw new Error(`dbgview requires WebGPU; backend=${app.ctx.backend}`)
					const render = app.ctx.get('render')
					const names = [...render.debugViewNames]
					if (!names.includes(debugName) || !render.setDebugView(debugName))
						throw new Error(`renderer rejected debug view '${debugName}'`)

					const uncaptured = []
					device.addEventListener('uncapturederror', event => {
						uncaptured.push(event.error?.message ?? String(event.error))
					})
					device.pushErrorScope('validation')
					let scopePromise
					let dataUrl
					let pixels
					try {
						for (let i = 0; i < frameCount; i++)
							app.renderOneFrame(i * (1000 / 60))

						// No await between the final render and canvas read. The WebGPU
						// drawing buffer is non-preserved across the task boundary.
						const source = app.ctx.canvas
						const copy = document.createElement('canvas')
						copy.width = source.width
						copy.height = source.height
						const g = copy.getContext('2d')
						if (g == null)
							throw new Error('could not create debug capture canvas')
						g.drawImage(source, 0, 0)
						const rgba = g.getImageData(0, 0, copy.width, copy.height).data
						pixels = summarizePixels(rgba)
						dataUrl = copy.toDataURL('image/png')
						scopePromise = device.popErrorScope()
					} catch (error) {
						const validation = await device.popErrorScope().catch(() => null)
						throw new Error(
							`${error.message}${validation ? `; GPU validation: ${validation.message}` : ''}`,
						)
					}

					await device.queue.onSubmittedWorkDone()
					const validation = await scopePromise
					if (validation != null)
						throw new Error(`GPU validation: ${validation.message}`)
					if (uncaptured.length > 0)
						throw new Error(`uncaptured GPU error: ${uncaptured[0]}`)
					if (render.stats.pipelineCreations !== 0)
						throw new Error(
							`${debugName}: ${render.stats.pipelineCreations} pipeline creation(s) after prewarm`,
						)
					if (render.stats.dropped !== 0 || render.stats.lightsDropped !== 0)
						throw new Error(
							`${debugName}: dropped geometry=${render.stats.dropped}, ` +
								`lights=${render.stats.lightsDropped}`,
						)

					const direct = readDirect
						? await readIntermediateTextures(device, render)
						: { dataUrls: {}, ranges: {} }
					return {
						name: debugName,
						names,
						dataUrl,
						pixels,
						direct,
						stats: {
							drawCalls: render.stats.drawCalls,
							triangles: render.stats.triangles,
							lights: render.stats.lights,
							pipelineCreations: render.stats.pipelineCreations,
							dropped: render.stats.dropped,
							lightsDropped: render.stats.lightsDropped,
							lodMain: Array.from(render.lodStats.mainInstances),
							lodShadow: Array.from(render.lodStats.shadowInstances),
						},
					}

					function summarizePixels(rgba) {
						let maxChannel = 0
						let nonBlack = 0
						const buckets = new Set()
						for (let i = 0; i < rgba.length; i += 4) {
							const max = Math.max(rgba[i], rgba[i + 1], rgba[i + 2])
							if (max > maxChannel) maxChannel = max
							if (max > 0) nonBlack++
							buckets.add(
								`${rgba[i] >> 4},${rgba[i + 1] >> 4},${rgba[i + 2] >> 4}`,
							)
						}
						return {
							maxChannel,
							nonBlack,
							total: rgba.length / 4,
							distinctBuckets: buckets.size,
						}
					}

					async function readIntermediateTextures(gpu, renderer) {
						const targets = renderer.targets
						if (targets == null)
							throw new Error('renderer did not expose its readback targets')
						const latestHistory = targets.history[1 - targets.historyIndex]
						if (latestHistory == null)
							throw new Error('renderer has no completed TAA history texture')

						gpu.pushErrorScope('validation')
						const hdr = makeReadback(gpu, targets.color, targets.width, targets.height, 8)
						const history = makeReadback(
							gpu,
							latestHistory,
							targets.width,
							targets.height,
							8,
						)
						const depth = makeReadback(gpu, targets.depth, targets.width, targets.height, 4)
						const velocity = makeReadback(gpu, targets.velocity, targets.width, targets.height, 4)
						const encoder = gpu.createCommandEncoder({ label: 'dbgview.readback' })
						encodeCopy(encoder, targets.color, hdr, 'all')
						encodeCopy(encoder, latestHistory, history, 'all')
						encodeCopy(encoder, targets.depth, depth, 'depth-only')
						encodeCopy(encoder, targets.velocity, velocity, 'all')
						gpu.queue.submit([encoder.finish()])
						await gpu.queue.onSubmittedWorkDone()
						const readbackValidation = await gpu.popErrorScope()
						if (readbackValidation != null)
							throw new Error(`readback validation: ${readbackValidation.message}`)

						await Promise.all([
							hdr.buffer.mapAsync(GPUMapMode.READ),
							history.buffer.mapAsync(GPUMapMode.READ),
							depth.buffer.mapAsync(GPUMapMode.READ),
							velocity.buffer.mapAsync(GPUMapMode.READ),
						])
						try {
							const hdrImage = visualizeHalfFloat(hdr)
							const historyImage = visualizeHalfFloat(history)
							const depthImage = visualizeDepth(depth)
							const velocityImage = visualizeVelocity(velocity)
							return {
								dataUrls: {
									hdr: toDataUrl(hdrImage, targets.width, targets.height),
									history: toDataUrl(historyImage, targets.width, targets.height),
									depth: toDataUrl(depthImage, targets.width, targets.height),
									velocity: toDataUrl(velocityImage, targets.width, targets.height),
								},
								ranges: {
									hdr: hdrImage.range,
									history: historyImage.range,
									depth: depthImage.range,
									velocity: velocityImage.range,
								},
							}
						} finally {
							for (const item of [hdr, history, velocity, depth]) {
								item.buffer.unmap()
								item.buffer.destroy()
							}
						}

						function makeReadback(gpuDevice, texture, w, h, bytesPerPixel) {
							const unpadded = w * bytesPerPixel
							const bytesPerRow = Math.ceil(unpadded / 256) * 256
							return {
								texture,
								width: w,
								height: h,
								bytesPerPixel,
								bytesPerRow,
								buffer: gpuDevice.createBuffer({
									label: 'dbgview.readback-buffer',
									size: bytesPerRow * h,
									usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
								}),
							}
						}

						function encodeCopy(commandEncoder, texture, item, aspect) {
							commandEncoder.copyTextureToBuffer(
								{ texture, aspect },
								{
									buffer: item.buffer,
									bytesPerRow: item.bytesPerRow,
									rowsPerImage: item.height,
								},
								{
									width: item.width,
									height: item.height,
									depthOrArrayLayers: 1,
								},
							)
						}

						function visualizeHalfFloat(item) {
							const source = new DataView(item.buffer.getMappedRange())
							const rgba = new Uint8ClampedArray(item.width * item.height * 4)
							let min = Infinity
							let max = -Infinity
							let finite = 0
							for (let y = 0; y < item.height; y++) {
								for (let x = 0; x < item.width; x++) {
									const input = y * item.bytesPerRow + x * 8
									const output = (y * item.width + x) * 4
									for (let c = 0; c < 3; c++) {
										const value = halfToFloat(source.getUint16(input + c * 2, true))
										if (Number.isFinite(value)) {
											min = Math.min(min, value)
											max = Math.max(max, value)
											finite++
										}
										const mapped = Math.pow(Math.max(0, value) / (1 + Math.max(0, value)), 1 / 2.2)
										rgba[output + c] = Math.round(mapped * 255)
									}
									rgba[output + 3] = 255
								}
							}
							return { rgba, range: finiteRange(min, max, finite) }
						}

						function visualizeDepth(item) {
							const source = new DataView(item.buffer.getMappedRange())
							const rgba = new Uint8ClampedArray(item.width * item.height * 4)
							let min = Infinity
							let max = -Infinity
							let finite = 0
							for (let y = 0; y < item.height; y++) {
								for (let x = 0; x < item.width; x++) {
									const input = y * item.bytesPerRow + x * 4
									const output = (y * item.width + x) * 4
									const value = source.getFloat32(input, true)
									if (Number.isFinite(value)) {
										min = Math.min(min, value)
										max = Math.max(max, value)
										finite++
									}
									const mapped = Math.round(Math.sqrt(Math.max(0, Math.min(1, value))) * 255)
									rgba[output] = mapped
									rgba[output + 1] = mapped
									rgba[output + 2] = mapped
									rgba[output + 3] = 255
								}
							}
							return { rgba, range: finiteRange(min, max, finite) }
						}

						function visualizeVelocity(item) {
							const source = new DataView(item.buffer.getMappedRange())
							const rgba = new Uint8ClampedArray(item.width * item.height * 4)
							let min = Infinity
							let max = -Infinity
							let finite = 0
							for (let y = 0; y < item.height; y++) {
								for (let x = 0; x < item.width; x++) {
									const input = y * item.bytesPerRow + x * 4
									const output = (y * item.width + x) * 4
									const vx = halfToFloat(source.getUint16(input, true))
									const vy = halfToFloat(source.getUint16(input + 2, true))
									const magnitude = Math.hypot(vx, vy)
									if (Number.isFinite(magnitude)) {
										min = Math.min(min, magnitude)
										max = Math.max(max, magnitude)
										finite++
									}
									// Signed screen motion around neutral grey; 16x makes subpixel vectors legible.
									rgba[output] = Math.round(128 + vx * 255 * 16)
									rgba[output + 1] = Math.round(128 + vy * 255 * 16)
									rgba[output + 2] = 128
									rgba[output + 3] = 255
								}
							}
							return { rgba, range: finiteRange(min, max, finite) }
						}

						function toDataUrl(image, w, h) {
							const canvas = document.createElement('canvas')
							canvas.width = w
							canvas.height = h
							const g = canvas.getContext('2d')
							if (g == null)
								throw new Error('could not create direct-readback canvas')
							g.putImageData(new ImageData(image.rgba, w, h), 0, 0)
							return canvas.toDataURL('image/png')
						}

						function finiteRange(min, max, finite) {
							return {
								min: finite > 0 ? min : 0,
								max: finite > 0 ? max : 0,
								finite,
							}
						}

						function halfToFloat(bits) {
							const sign = bits & 0x8000 ? -1 : 1
							const exponent = (bits >> 10) & 0x1f
							const fraction = bits & 0x03ff
							if (exponent === 0)
								return sign * Math.pow(2, -14) * (fraction / 1024)
							if (exponent === 31)
								return fraction === 0 ? sign * Infinity : NaN
							return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024)
						}
					}
				},
				{ debugName: name, frameCount: frames, readDirect: includeDirect },
			)
			if (errors.length > 0)
				throw new Error(errors[0])
			return result
		} finally {
			await context.close()
		}
	}
} catch (error) {
	console.error(`dbgview: FAIL — ${error.message}`)
	exitCode = 1
} finally {
	if (browser != null)
		await browser.close()
	if (server != null && !flags.has('keep-server'))
		await stopChild(server)
}

process.exit(exitCode)

function writeCanonicalPng(path, dataUrl) {
	const encoded = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
	const image = decodePng(encoded)
	writeFileSync(path, encodePng(image.width, image.height, image.data))
}

function attachDiagnostics(page) {
	const errors = []
	page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
	page.on('console', message => {
		if (message.type() === 'error' && !/^Failed to load resource:/.test(message.text()))
			errors.push(`console.error: ${message.text()}`)
	})
	page.on('response', response => {
		if (response.status() < 400)
			return
		if (new URL(response.url()).pathname === '/favicon.ico')
			return
		errors.push(`HTTP ${response.status()}: ${response.url()}`)
	})
	return errors
}

function parseFlags(args) {
	const valueFlags = new Set([
		'frames',
		'seed',
		'width',
		'height',
		'devsize',
		'out',
		'url',
		'port',
	])
	const parsed = new Map()
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (!arg.startsWith('--'))
			throw new Error(`dbgview: unknown positional argument '${arg}'`)
		const body = arg.slice(2)
		const eq = body.indexOf('=')
		const name = eq < 0 ? body : body.slice(0, eq)
		if (valueFlags.has(name)) {
			const flagValue = eq < 0 ? args[++i] : body.slice(eq + 1)
			if (flagValue == null || flagValue === '')
				throw new Error(`dbgview: --${name} requires a value`)
			parsed.set(name, flagValue)
		} else if (name === 'keep-server')
			parsed.set(name, true)
		else
			throw new Error(`dbgview: unknown flag --${name}`)
	}
	return parsed
}

function positiveInteger(input, name) {
	const parsed = Number(input)
	if (!Number.isSafeInteger(parsed) || parsed <= 0)
		throw new Error(`dbgview: --${name} must be a positive integer`)
	return parsed
}
