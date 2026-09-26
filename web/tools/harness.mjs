// STEELSEED — tools/harness
// Shared browser harness for the visual gates. Node built-ins plus Playwright only;
// Playwright is a development tool and never enters the shipping bundle.

import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { decodePng, encodePng } from './png.mjs'
import { spawnProcessGroup, stopProcessGroup } from './process-group.mjs'

export const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
export const DEFAULT_WIDTH = 1512
export const DEFAULT_HEIGHT = 982
export const DEFAULT_FRAMES = 45

/**
 * The fixed review set. A descriptor changes composition through
 * deterministic camera input; subsystem-specific staging can later key off `id`
 * without changing the harness or the baseline naming.
 */
export const NAMED_SHOTS = Object.freeze([
	{ id: 'base-dawn', keys: [], wheel: -180 },
	{ id: 'tank-column-night-headlights', keys: ['KeyW'], wheel: -120 },
	{ id: 'artillery-barrage', keys: ['KeyD'], wheel: 0 },
	{ id: 'harvester-resource-field', keys: ['KeyS'], wheel: -90 },
	{ id: 'shroud-boundary-near', keys: ['KeyA'], wheel: -420 },
	{ id: 'shroud-boundary-mid', keys: ['KeyA'], wheel: 0 },
	{ id: 'shroud-boundary-far', keys: ['KeyA'], wheel: 620 },
	{ id: 'foundry-showcase', keys: ['KeyW', 'KeyA'], wheel: -360 },
	{ id: 'lattice-showcase', keys: ['KeyW', 'KeyD'], wheel: -360 },
	{ id: 'structure-construction', keys: ['KeyS', 'KeyD'], wheel: -260 },
	{ id: 'aircraft-strafing', keys: ['KeyD'], wheel: 220 },
	{ id: 'water-shoreline', keys: ['KeyS', 'KeyA'], wheel: -80 },
	{ id: 'rain-battle', keys: ['KeyS'], wheel: 180 },
	{ id: 'full-hud', keys: [], wheel: 0 },
	{ id: 'engagement-200-max-zoom', keys: ['KeyD'], wheel: 900 },
])

export async function loadChromium(tool) {
	try {
		const { chromium } = await import('playwright')
		return chromium
	} catch {
		throw new Error(
			`${tool}: playwright is not installed; run ` +
			'`cd web && npm install && npx playwright install chromium`',
		)
	}
}

export async function launchGpuBrowser(chromium, tool, extraArgs = []) {
	const options = {
		headless: true,
		args: [
			'--use-angle=metal',
			'--enable-unsafe-webgpu',
			'--enable-features=Vulkan,UseSkiaRenderer',
			'--ignore-gpu-blocklist',
			'--enable-gpu-rasterization',
			'--disable-gpu-sandbox',
			...extraArgs,
		],
	}

	try {
		return {
			browser: await chromium.launch(options),
			label: 'playwright chromium',
		}
	} catch (error) {
		if (!/Executable doesn't exist|please run|install/i.test(String(error.message)))
			throw error

		return {
			browser: await chromium.launch({ ...options, channel: 'chrome' }),
			label: 'installed chrome (playwright chromium absent)',
			warning:
				`${tool}: playwright's pinned Chromium is missing; using installed Chrome. ` +
				'Baselines are only comparable when the browser label matches.',
		}
	}
}

export async function startPreview(port, suppliedUrl = null) {
	if (suppliedUrl != null)
		return { baseUrl: suppliedUrl, server: null }

	const baseUrl = `http://127.0.0.1:${port}/`
	// The repo-root npm workspaces glob can break npx resolution through no fault of this
	// project (duplicate workspace names in sibling checkouts); the direct binary is immune.
	const viteBin = fileURLToPath(new URL('../node_modules/.bin/vite', import.meta.url))
	const server = spawnProcessGroup(process.execPath, [
		viteBin, 'preview',
		'--host', '127.0.0.1',
		'--port', String(port),
		'--strictPort',
	], {
		cwd: WEB_ROOT,
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	try {
		await waitForServer(baseUrl, 20000, server)
	} catch (error) {
		// The caller cannot enter its finally block until startPreview returns, so this
		// function still owns cleanup when startup itself fails.
		await stopProcessGroup(server)
		throw error
	}
	return { baseUrl, server }
}

export async function stopChild(child) {
	await stopProcessGroup(child)
}

/**
 * Render and read one deterministic shot.
 *
 * The draw and drawImage happen before the first await in the evaluate. WebGPU presents
 * and discards its non-preserved canvas at a task boundary, so moving readback to a
 * second evaluate turns a healthy frame black.
 */
export async function captureShot(browser, options) {
	const {
		baseUrl,
		shot,
		seed,
		width = DEFAULT_WIDTH,
		height = DEFAULT_HEIGHT,
		frames = DEFAULT_FRAMES,
		quality = 'high',
		devsize = 96,
		includeComposite = false,
	} = options

	const context = await browser.newContext({
		viewport: { width, height },
		deviceScaleFactor: 1,
		locale: 'en-US',
		timezoneId: 'UTC',
	})
	const page = await context.newPage()
	const pageErrors = attachDiagnostics(page)

	// main starts an rAF loop immediately after publishing the app. Hold it so the only
	// frames in a deterministic capture are the fixed timestamps below.
	await page.addInitScript(() => {
		let nextId = 1
		const pending = new Set()
		globalThis.requestAnimationFrame = () => {
			const id = nextId++
			pending.add(id)
			return id
		}
		globalThis.cancelAnimationFrame = id => pending.delete(id)
	})

	try {
		const url = new URL(baseUrl)
		url.searchParams.set('devmap', '1')
		url.searchParams.set('deterministic', '1')
		url.searchParams.set('seed', seed)
		url.searchParams.set('devsize', String(devsize))
		url.searchParams.set('quality', quality)
		url.searchParams.set('shot', shot.id)

		await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 })
		await page.waitForFunction(
			() => {
				const failure = document.getElementById('boot-fail')
				if (failure && !failure.hidden && failure.textContent)
					throw new Error(`boot failed: ${failure.textContent}`)
				return globalThis.steelseed !== undefined
			},
			undefined,
			// requestAnimationFrame is intentionally held above. Playwright defaults
			// waitForFunction to rAF polling, which would therefore wait forever even
			// after the app had published itself.
			{ timeout: 120000, polling: 100 },
		).catch(error => {
			const detail = pageErrors[0]
			throw new Error(`${error.message}${detail ? `; ${detail}` : ''}`)
		})

		const raw = await page.evaluate(
			async ({ descriptor, frameCount }) => {
				const app = globalThis.steelseed
				app.stop()
				const device = app.ctx.device
				if (app.ctx.backend !== 'webgpu' || device == null)
					throw new Error(`visual harness requires WebGPU; backend=${app.ctx.backend}`)

				const render = app.ctx.get('render')
				const uncaptured = []
				device.addEventListener('uncapturederror', event => {
					uncaptured.push(event.error?.message ?? String(event.error))
				})

				device.pushErrorScope('validation')
				let scopePromise
				let dataUrl
				let pixels
				try {
					for (const code of descriptor.keys)
						window.dispatchEvent(new KeyboardEvent('keydown', { code }))
					if (descriptor.wheel !== 0)
						app.ctx.canvas.dispatchEvent(new WheelEvent('wheel', {
							deltaY: descriptor.wheel,
							deltaMode: 0,
							bubbles: true,
							cancelable: true,
						}))

					for (let i = 0; i < frameCount; i++)
						app.renderOneFrame(i * (1000 / 60))

					for (const code of descriptor.keys)
						window.dispatchEvent(new KeyboardEvent('keyup', { code }))

					// Synchronous readback before any await. A later task sees an empty
					// non-preserved WebGPU drawing buffer.
					const source = app.ctx.canvas
					const copy = document.createElement('canvas')
					copy.width = source.width
					copy.height = source.height
					const g = copy.getContext('2d')
					if (g == null)
						throw new Error('could not create 2D capture context')
					g.drawImage(source, 0, 0)
					const rgba = g.getImageData(0, 0, copy.width, copy.height).data
					let maxChannel = 0
					let nonBlack = 0
					const buckets = new Set()
					for (let i = 0; i < rgba.length; i += 4) {
						const m = Math.max(rgba[i], rgba[i + 1], rgba[i + 2])
						if (m > maxChannel) maxChannel = m
						if (m > 0) nonBlack++
						buckets.add(`${rgba[i] >> 4},${rgba[i + 1] >> 4},${rgba[i + 2] >> 4}`)
					}
					pixels = {
						maxChannel,
						nonBlack,
						total: rgba.length / 4,
						distinctBuckets: buckets.size,
					}
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

				return {
					dataUrl,
					pixels,
					userAgent: navigator.userAgent,
					backend: app.ctx.backend,
					quality: app.config.q.name,
					dpr: app.config.devicePixelRatio,
					canvas: { width: app.ctx.canvas.width, height: app.ctx.canvas.height },
					stats: {
						drawCalls: render.stats.drawCalls,
						triangles: render.stats.triangles,
						lights: render.stats.lights,
						pipelineCreations: render.stats.pipelineCreations,
						dropped: render.stats.dropped ?? 0,
						lightsDropped: render.stats.lightsDropped ?? 0,
					},
				}
			},
			{ descriptor: shot, frameCount: frames },
		)

		if (pageErrors.length > 0)
			throw new Error(pageErrors[0])
		if (raw.pixels.maxChannel === 0 || raw.pixels.distinctBuckets <= 1)
			throw new Error(
				`shot '${shot.id}' did not present scene pixels: max=${raw.pixels.maxChannel}, ` +
				`buckets=${raw.pixels.distinctBuckets}`,
			)
		if (raw.stats.dropped !== 0 || raw.stats.lightsDropped !== 0)
			throw new Error(
				`shot '${shot.id}' dropped submissions: geometry=${raw.stats.dropped}, ` +
				`lights=${raw.stats.lightsDropped}`,
			)

		const encoded = Buffer.from(raw.dataUrl.slice(raw.dataUrl.indexOf(',') + 1), 'base64')
		const image = decodePng(encoded)
		let compositePng = null
		if (includeComposite) {
			// The immediate canvas read above already proved pixels landed. This later
			// compositor screenshot is for human review and includes DOM/CSS HUD; it is
			// deliberately not used by the bit-identity gate.
			await page.waitForFunction(
				() => document.getElementById('boot')?.hidden === true,
				undefined,
				{ timeout: 15000, polling: 50 },
			)
			compositePng = await page.screenshot({ type: 'png' })
		}
		return {
			...raw,
			image,
			canonicalPng: encodePng(image.width, image.height, image.data),
			compositePng,
		}
	} finally {
		await context.close()
	}
}

export function writeShot(path, capture) {
	mkdirSync(resolve(path, '..'), { recursive: true })
	writeFileSync(path, capture.canonicalPng)
}

export function selectShots(value) {
	if (value == null || value === 'all')
		return NAMED_SHOTS

	const requested = value.split(',').map(s => s.trim()).filter(Boolean)
	const byId = new Map(NAMED_SHOTS.map(shot => [shot.id, shot]))
	return requested.map(id => {
		const shot = byId.get(id)
		if (shot == null)
			throw new Error(
				`unknown shot '${id}'; known: ${NAMED_SHOTS.map(s => s.id).join(', ')}`,
			)
		return shot
	})
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
			// Preview is still starting.
		}
		await new Promise(resolveWait => setTimeout(resolveWait, 100))
	}
	throw new Error(
		`vite preview did not start at ${url} within ${timeoutMs}ms — run ` +
			'`npm --prefix web run build`',
	)
}
