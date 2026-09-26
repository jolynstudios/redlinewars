#!/usr/bin/env node
// STEELSEED — tools/depthgate
//
// The depth prepass and forward pass are separate shader modules, but they must rasterise
// every submitted primitive to the same depth. A one-ULP disagreement is enough for the
// forward pass's greater-equal test to reject a fragment that the prepass wrote. The player
// then sees the sky through a flat polygon even though the depth buffer says geometry exists.
//
// This gate dyes the forward target's CLEAR value with a negative HDR sentinel, then reads
// the RAW pre-TAA HDR target and depth buffer. The sky overwrites real background and forward
// shading overwrites real geometry; a sentinel pixel with depth > 0 is therefore a prepass /
// forward disagreement. Negative RGB cannot coincide with the albedo AOV by accident, which
// makes this stricter than comparing against the ordinary horizon-coloured clear value.
//
// Three camera heights and all eight TAA jitter phases are measured. The historical defect
// varied with zoom and jitter, so one attractive frame is not a sufficient witness.
//
// Usage:
//   node tools/depthgate.mjs
//   node tools/depthgate.mjs --falsify=noinvariant
//   node tools/depthgate.mjs --falsify=skin-divergence
//
// The falsifier removes @invariant from the REAL prepass and both REAL forward modules before
// pipeline creation. It must make this gate red; changing the readback after rendering would
// test the counter rather than the renderer.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { launchGpuBrowser, loadChromium, startPreview, stopChild } from './harness.mjs'

const TOOL = 'depthgate'
const HEIGHTS = [12, 26, 70]
const JITTER_PHASES = 8
const SENTINEL = [-13, -29, -47]
// Pinned after measuring the fixed 1512x982 devmap at all HEIGHTS × JITTER_PHASES above.
// Any change in either direction demands a deliberate re-measurement; do not turn this into
// a <= threshold. A depth-covered pixel that retains a negative clear dye is never legitimate.
const FIXED_CLEAR_ON_DEPTH_PIXELS = 0

const flags = parseFlags(process.argv.slice(2))
const value = (name, fallback) => flags.has(name) ? flags.get(name) : fallback
const falsify = value('falsify', null)
if (falsify != null && falsify !== 'noinvariant' && falsify !== 'skin-divergence' && falsify !== 'lod-divergence')
	throw new Error(`${TOOL}: unknown --falsify=${falsify}`)

const suppliedUrl = value('url', null)
const port = positiveInteger(value('port', 8406), 'port')
const outDir = resolve(value('out', '/tmp/steelseed-depthgate'))

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
		// The original captures that exposed the defect were 1512x982. Use that raster size
		// directly: the app deliberately renders at CSS resolution rather than device DPR.
		viewport: { width: 1512, height: 982 },
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

	await page.addInitScript(({ falsify, sentinel }) => {
		let nextRaf = 1
		globalThis.requestAnimationFrame = () => nextRaf++
		globalThis.cancelAnimationFrame = () => {}

		const state = {
			clearPasses: 0,
			shaderReplacements: 0,
			modules: { prepass: 0, forward: 0, blend: 0, skinForward: 0 },
		}
		globalThis.__depthgate = state

		// Diagnostic dye, installed at the actual render-pass seam. It changes no depth,
		// geometry, pipeline or shader behaviour; it only makes an unwritten pixel impossible
		// to mistake for legitimate scene radiance.
		const encoderProto = globalThis.GPUCommandEncoder?.prototype
		if (encoderProto != null) {
			const realBegin = encoderProto.beginRenderPass
			encoderProto.beginRenderPass = function depthgateBegin(desc) {
				if (desc.label === 'render.pass.forward') {
					const clear = desc.colorAttachments?.[0]?.clearValue
					if (clear != null) {
						clear.r = sentinel[0]
						clear.g = sentinel[1]
						clear.b = sentinel[2]
						state.clearPasses++
					}
				}
				return realBegin.call(this, desc)
			}
		}

		if (falsify == null) return
		const deviceProto = globalThis.GPUDevice?.prototype
		if (deviceProto == null) return
		const realModule = deviceProto.createShaderModule
		deviceProto.createShaderModule = function depthgateShader(desc) {
			let code = String(desc.code)
			let changed = 0
			if (falsify === 'noinvariant' && desc.label === 'render.prepass') {
				const next = code.replace(
					'-> @invariant @builtin(position) vec4<f32>',
					'-> @builtin(position) vec4<f32>',
				)
				if (next !== code) { code = next; changed++; state.modules.prepass++ }
			} else if (
				falsify === 'noinvariant' &&
				(desc.label === 'render.forward' || desc.label === 'render.forward.blend')
			) {
				const next = code.replace(
					'@invariant @builtin(position) clip : vec4<f32>',
					'@builtin(position) clip : vec4<f32>',
				)
				if (next !== code) {
					code = next
					changed++
					if (desc.label === 'render.forward') state.modules.forward++
					else state.modules.blend++
				}
			} else if (falsify === 'skin-divergence' && desc.label === 'render.forward') {
				// Perturb the skinned ENTRY POINT in ONE production module only. Do it after
				// skinPosition so bind-pose instances (palette base zero) remain a valid witness;
				// patching the blend's return missed every rig that happened to rest that frame.
				// Static geometry is unchanged; every resulting clear-on-depth pixel therefore
				// proves the gate exercises a real skinned draw against the real prepass.
				const next = code.replace(
					'let world4 = inst.model * skinPosition(vin.position, vin.joints, vin.weights, base);',
					'let world4 = inst.model * (skinPosition(vin.position, vin.joints, vin.weights, base) + vec4<f32>(0.125, 0.0, 0.0, 0.0));',
				)
				if (next !== code) {
					code = next
					changed++
					state.modules.skinForward++
				}
			}
			state.shaderReplacements += changed
			return realModule.call(this, changed > 0 ? { ...desc, code } : desc)
		}
	}, { falsify, sentinel: SENTINEL })

	const url = new URL(preview.baseUrl)
	url.searchParams.set('devmap', '1')
	url.searchParams.set('deterministic', '1')
	// rAF is stubbed, so without ?manual=1 app.start() never pumps. The boot
	// must still hand over a decoded world: pumpSnapshots holds first-world
	// intake until the actor-type table lands, and the first probe frame would
	// otherwise render an empty sky-only world (depth.json's height=12 phase=0
	// depthPixels=0). manual=1 makes main() await app.ensureFirstSnapshot().
	url.searchParams.set('manual', '1')
	url.searchParams.set('seed', 'depth-prepass-forward-agreement')
	url.searchParams.set('devsize', '96')
	url.searchParams.set('quality', 'high')
	url.searchParams.set('devtod', '720')
	await page.goto(url.href)
	await page.waitForFunction(
		() => globalThis.steelseed !== undefined,
		undefined,
		{ timeout: 120000, polling: 100 },
	)

	const result = await page.evaluate(async ({ heights, phases, sentinel, falsify }) => {
		const app = globalThis.steelseed
		app.stop()
		const device = app.ctx.device
		if (app.ctx.backend !== 'webgpu' || device == null)
			throw new Error(`depthgate requires WebGPU; backend=${app.ctx.backend}`)

		const render = app.ctx.get('render')
		const camera = app.ctx.get('camera')
		if (falsify === 'lod-divergence') render.depthgateForwardLodBias = 1
		// Boot may have encoded one frame before the app was stopped. It is not part of the
		// 3-height × 8-phase workload and must not make the seam-count assertion off by one.
		globalThis.__depthgate.clearPasses = 0
		// Albedo is independent of lighting, emission and aerial perspective. Correctly shaded
		// geometry is non-negative, so the negative clear dye is an unambiguous missing write.
		render.debugView = 1

		const width = render.targets.width
		const height = render.targets.height
		const colorBytesPerRow = Math.ceil(width * 8 / 256) * 256
		const depthBytesPerRow = Math.ceil(width * 4 / 256) * 256
		const colorBuffer = device.createBuffer({
			label: 'depthgate.color',
			size: colorBytesPerRow * height,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
		})
		const depthBuffer = device.createBuffer({
			label: 'depthgate.depth',
			size: depthBytesPerRow * height,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
		})
		const sentinelBits = sentinel.map(floatToHalf)
		const samples = []
		let totalDepth = 0
		let totalClearOnDepth = 0
		let timestamp = 0

		try {
			for (const cameraHeight of heights) {
				// TypeScript-private, not JS-private. Existing visual gates pin these exact fields.
				camera.height = cameraHeight
				camera.heightGoal = cameraHeight
				for (let phase = 0; phase < phases; phase++) {
					// lateUpdate increments before indexing JITTER_TABLE, so phase-1 selects phase.
					render.frameIndex = (phase + phases - 1) % phases
					render.historyValid = false
					app.renderOneFrame(timestamp)
					timestamp += 1000 / 60

					const encoder = device.createCommandEncoder({ label: 'depthgate.readback' })
					encoder.copyTextureToBuffer(
						{ texture: render.targets.color },
						{ buffer: colorBuffer, bytesPerRow: colorBytesPerRow, rowsPerImage: height },
						{ width, height, depthOrArrayLayers: 1 },
					)
					encoder.copyTextureToBuffer(
						{ texture: render.targets.depth, aspect: 'depth-only' },
						{ buffer: depthBuffer, bytesPerRow: depthBytesPerRow, rowsPerImage: height },
						{ width, height, depthOrArrayLayers: 1 },
					)
					device.queue.submit([encoder.finish()])
					await Promise.all([
						colorBuffer.mapAsync(GPUMapMode.READ),
						depthBuffer.mapAsync(GPUMapMode.READ),
					])

					let depthPixels = 0
					let clearOnDepth = 0
					const examples = []
					try {
						const color = new DataView(colorBuffer.getMappedRange())
						const depth = new DataView(depthBuffer.getMappedRange())
						for (let y = 0; y < height; y++) {
							for (let x = 0; x < width; x++) {
								const d = depth.getFloat32(y * depthBytesPerRow + x * 4, true)
								if (!(d > 0)) continue
								depthPixels++
								const o = y * colorBytesPerRow + x * 8
								if (
									color.getUint16(o, true) === sentinelBits[0] &&
									color.getUint16(o + 2, true) === sentinelBits[1] &&
									color.getUint16(o + 4, true) === sentinelBits[2]
								) {
									clearOnDepth++
									if (examples.length < 8) examples.push([x, y, d])
								}
							}
						}
					} finally {
						colorBuffer.unmap()
						depthBuffer.unmap()
					}

					samples.push({ height: cameraHeight, phase, depthPixels, clearOnDepth, examples })
					totalDepth += depthPixels
					totalClearOnDepth += clearOnDepth
				}
			}
		} finally {
			colorBuffer.destroy()
			depthBuffer.destroy()
		}

		return {
			width,
			height,
			samples,
			totalDepth,
			totalClearOnDepth,
			camera: { height: camera.height, heightGoal: camera.heightGoal },
			stats: { ...render.stats },
			lod: {
				main: Array.from(render.lodStats.mainInstances),
				shadow: Array.from(render.lodStats.shadowInstances),
				forwardBias: render.depthgateForwardLodBias,
			},
			patch: globalThis.__depthgate,
		}

		function floatToHalf(value) {
			const f32 = new Float32Array(1)
			const u32 = new Uint32Array(f32.buffer)
			f32[0] = value
			const bits = u32[0]
			const sign = (bits >>> 16) & 0x8000
			let exponent = ((bits >>> 23) & 0xff) - 127 + 15
			let mantissa = bits & 0x7fffff
			if (exponent <= 0) {
				if (exponent < -10) return sign
				mantissa = (mantissa | 0x800000) >>> (1 - exponent)
				return sign | ((mantissa + 0x1000) >>> 13)
			}
			if (exponent >= 31) return sign | 0x7c00
			return sign | (exponent << 10) | ((mantissa + 0x1000) >>> 13)
		}
	}, { heights: HEIGHTS, phases: JITTER_PHASES, sentinel: SENTINEL, falsify })

	await context.close()
	if (diagnostics.length > 0) throw new Error(diagnostics[0])

	console.log(
		`${TOOL}: ${result.width}x${result.height}, ${result.samples.length} samples, ` +
		`depth-covered=${result.totalDepth}, clear-on-depth=${result.totalClearOnDepth}`,
	)
	for (const cameraHeight of HEIGHTS) {
		const group = result.samples.filter(sample => sample.height === cameraHeight)
		const count = group.reduce((sum, sample) => sum + sample.clearOnDepth, 0)
		console.log(`${TOOL}: height=${cameraHeight} clear-on-depth=${count} phases=${group.map(s => s.clearOnDepth).join(',')}`)
	}
	console.log(`${TOOL}: patch=${JSON.stringify(result.patch)}`)

	const problems = []
	if (result.totalClearOnDepth !== FIXED_CLEAR_ON_DEPTH_PIXELS) {
		problems.push(
			`clear-on-depth=${result.totalClearOnDepth}, pinned fixed floor=${FIXED_CLEAR_ON_DEPTH_PIXELS}`,
		)
	}
	if (result.patch.clearPasses !== result.samples.length)
		problems.push(`diagnostic clear reached ${result.patch.clearPasses}/${result.samples.length} forward passes`)
	if (falsify === 'noinvariant') {
		const expected = { prepass: 1, forward: 1, blend: 1 }
		for (const [name, count] of Object.entries(expected)) {
			if (result.patch.modules[name] !== count)
				problems.push(`falsifier patched ${name} ${result.patch.modules[name]} time(s), expected ${count}`)
		}
		if (result.patch.shaderReplacements !== 3)
			problems.push(`falsifier made ${result.patch.shaderReplacements} shader replacements, expected 3`)
	} else if (falsify === 'skin-divergence') {
		if (result.patch.modules.skinForward !== 1)
			problems.push(`skin-divergence patched forward ${result.patch.modules.skinForward} time(s), expected 1`)
		if (result.patch.shaderReplacements !== 1)
			problems.push(`skin-divergence made ${result.patch.shaderReplacements} shader replacements, expected 1`)
	} else if (falsify === 'lod-divergence') {
		if (result.lod.forwardBias !== 1)
			problems.push(`lod-divergence forward bias is ${result.lod.forwardBias}, expected 1`)
		if (result.lod.main[0] + result.lod.main[1] <= 0)
			problems.push(`lod-divergence exercised no L0/L1 instances: ${result.lod.main.join('/')}`)
		if (result.patch.shaderReplacements !== 0)
			problems.push(`lod-divergence unexpectedly changed ${result.patch.shaderReplacements} shader module(s)`)
	} else if (result.patch.shaderReplacements !== 0) {
		problems.push(`ordinary run unexpectedly made ${result.patch.shaderReplacements} shader replacements`)
	}
	if (result.stats.pipelineCreations !== 0)
		problems.push(`${result.stats.pipelineCreations} pipeline creation(s) after prewarm`)
	if (result.stats.dropped !== 0 || result.stats.lightsDropped !== 0)
		problems.push(`dropped geometry=${result.stats.dropped} lights=${result.stats.lightsDropped}`)

	writeFileSync(join(outDir, falsify ? `${falsify}.json` : 'depth.json'), `${JSON.stringify(result, null, 2)}\n`)
	if (problems.length > 0) {
		for (const problem of problems) console.error(`${TOOL}: FAIL — ${problem}`)
		exitCode = 1
	} else {
		console.log(
			`${TOOL}: PASS — prepass and forward agree at ${HEIGHTS.length} heights × ${JITTER_PHASES} jitter phases`,
		)
	}
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
