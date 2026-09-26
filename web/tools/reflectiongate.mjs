#!/usr/bin/env node
// Actual post ray hits, material eligibility and shroud rejection on a controlled
// red wall + Blender-glass floor, through the production renderer and prepass.
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { launchGpuBrowser, loadChromium, stopChild } from './harness.mjs'
import { spawnProcessGroup } from './process-group.mjs'
import { decodePng } from './png.mjs'

const root = resolve(import.meta.dirname, '..')
const fixture = await build({ stdin: { contents: `import { Mesh, ZONE_BYTE_OFFSET } from './src/geo/mesh'; globalThis.ReflectionMesh = Mesh; globalThis.ZONE_BYTE_OFFSET = ZONE_BYTE_OFFSET`, resolveDir: root }, bundle: true, write: false, format: 'iife' })
const frozen = mkdtempSync(resolve(tmpdir(), 'steelseed-reflection-'))
cpSync(resolve(root, 'dist'), frozen, { recursive: true })
const server = spawnProcessGroup(process.execPath, [resolve(root, '../engine/OpenRA.Browser/tests/server.mjs'), '--root', frozen, '--port', '8436'], { stdio: 'ignore' })
const baseUrl = 'http://127.0.0.1:8436/'
let browser
try {
	let ready = false
	for (let i = 0; i < 200; i++) {
		try { if ((await fetch(baseUrl)).ok) { ready = true; break } } catch {}
		await new Promise(resolveWait => setTimeout(resolveWait, 50))
	}
	assert.ok(ready)
	;({ browser } = await launchGpuBrowser(await loadChromium('reflectiongate'), 'reflectiongate'))
	const off = await capture('0'), on = await capture('1'), debug = await capture('debug'), mask = await capture('mask'), hidden = await capture('debug', true)
	const water = await capture('debug', false, 'water'), metal = await capture('mask', false, 'metal'), legacy = await capture('mask', false, 'legacy')
	const a = decodePng(off.png), b = decodePng(on.png), d = decodePng(debug.png), h = decodePng(hidden.png)
	const waterImage = decodePng(water.png)
	let changed = 0, redHits = 0, hiddenHits = 0, waterHits = 0
	for (let i = 0; i < a.data.length; i += 4) {
		if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 6) changed++
		if (d.data[i] > d.data[i + 1] + 8 && d.data[i] > d.data[i + 2] + 8) redHits++
		if (h.data[i] > h.data[i + 1] + 8 && h.data[i] > h.data[i + 2] + 8) hiddenHits++
		if (waterImage.data[i] > waterImage.data[i + 1] + 8 && waterImage.data[i] > waterImage.data[i + 2] + 8) waterHits++
	}
	const summary = { changed, redHits, hiddenHits, waterHits, eligible: on.eligible, metalEligible: metal.eligible, legacyEligible: legacy.eligible, visibleMatte: on.visibleMatte,
		frameMs: { off: off.medianMs, on: on.medianMs, delta: on.medianMs - off.medianMs },
		metadataBytes: a.width * a.height * 4, drawCalls: on.drawCalls }
	mkdirSync(resolve(root, 'shots/reflection'), { recursive: true })
	for (const [name, capture] of Object.entries({ off, on, debug, mask, hidden, water })) writeFileSync(resolve(root, `shots/reflection/${name}.png`), capture.png)
	writeFileSync(resolve(root, 'shots/reflection/report.json'), JSON.stringify(summary, null, 2) + '\n')
	assert.ok(on.eligible > 1000, `reflective floor must write metadata (${on.eligible})`)
	assert.ok(on.visibleMatte > 100, `matte red wall must stay non-reflective (${on.visibleMatte})`)
	assert.ok(changed > 100, `real ray hits must visibly change the glass (${changed})`)
	assert.ok(redHits > 100, `reflected image must retain the red wall colour (${redHits})`)
	assert.ok(hiddenHits < redHits * .01, `hidden wall must not leak into reflections (${hiddenHits}/${redHits})`)
	assert.ok(waterHits > 100, `water must reflect actual visible scene colour (${waterHits})`)
	assert.ok(metal.eligible > 1000, 'Blender steel must be eligible')
	assert.equal(legacy.eligible, 0, 'legacy layer ids must not be misclassified as Blender glass/steel')
	assert.equal(on.drawCalls, off.drawCalls)
	console.log(`reflectiongate: PASS — ${JSON.stringify(summary)}`)
} finally {
	await browser?.close()
	await stopChild(server)
	rmSync(frozen, { recursive: true, force: true })
}

async function capture(mode, hideWall = false, surface = 'glass') {
	const page = await browser.newPage({ viewport: { width: 1000, height: 750 }, deviceScaleFactor: 1 })
	const errors = []
	page.on('pageerror', error => errors.push(error.message))
	page.on('console', message => { if (message.type() === 'error' && !message.text().includes('favicon')) errors.push(message.text()) })
	await page.addInitScript(() => { globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {} })
	await page.goto(`${baseUrl}?devmap=1&manual=1&deterministic=1&devsize=48&devactors=1&devtod=600&contact=0&reflections=${mode}`)
	await page.waitForFunction(() => !!globalThis.steelseed, undefined, { timeout: 120000, polling: 100 })
	await page.addScriptTag({ content: fixture.outputFiles[0].text })
	const result = await page.evaluate(async ({ hiddenWall, surfaceKind }) => {
		const app = globalThis.steelseed, ctx = app.ctx, render = ctx.get('render'), camera = ctx.get('camera'), device = ctx.device
		app.stop()
		const quad = (vertices, normal, zone) => {
			const mesh = new globalThis.ReflectionMesh()
			for (let i = 0; i < vertices.length; i++) {
				const v = vertices[i]
				const index = mesh.addVertex(...v, ...normal, i === 1 || i === 2 ? 1 : 0, i >= 2 ? 1 : 0, zone)
				mesh.setTangent(index, 1, 0, 0, 1)
			}
			mesh.addTriangle(0, 1, 2); mesh.addTriangle(0, 2, 3)
			return render.upload(mesh, `reflectiongate:${zone}`)
		}
		const transform = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 32, 5, 32, 1)
		const makeItem = mesh => ({ mesh, surfaceSet: 'blender', instances: transform, instanceCount: 1, playerColors: null, castsShadow: true })
		const floor = makeItem(quad([[-4, 0, -4], [-4, 0, 4], [4, 0, 4], [4, 0, -4]], [0, 1, 0], surfaceKind === 'metal' || surfaceKind === 'legacy' ? 2 : 4))
		if (surfaceKind === 'legacy') floor.surfaceSet = 'foundry'
		if (surfaceKind === 'water') {
			floor.surfaceSet = 'water'
			// Terrain's face-kind byte is zone.w — but this fixture uploads a GEO-layout
			// mesh, whose zone word lives at ZONE_BYTE_OFFSET (28), NOT at the terrain
			// layout's 56. Writing 56 landed in the next vertex's UVs and the water
			// branch never fired. Keep the quad's material layer in zone.x.
			for (const lod of floor.mesh.lods) for (let i = 0; i < lod.vertexCount; i++)
				device.queue.writeBuffer(lod.vertexBuffer, i * lod.stride + globalThis.ZONE_BYTE_OFFSET, Uint8Array.of(4, 0, 0, 2))
		}
		const wall = makeItem(quad([[-1.5, 0, -2], [1.5, 0, -2], [1.5, 3, -2], [-1.5, 3, -2]], [0, 0, 1], 17))
		for (const id of ['terrain', 'units', 'structures', 'ui', 'fx']) { const node = ctx.peek(id); if (node) node.update = () => {} }
		ctx.get('units').update = () => { render.submit(floor); render.submit(wall) }
		ctx.get('shroud').onSnapshot = () => {}
		camera.update = () => { camera.target.set([32, 5, 32]); camera.targetGoal.set([32, 5, 32]); camera.height = 6; camera.yaw = 0; camera.rebuildView(); camera.pushToRenderer(ctx) }
		camera.lateUpdate = () => {}
		const sight = new Uint8Array(64 * 64).fill(2)
		if (hiddenWall) for (let z = 0; z < 31; z++) sight.fill(0, z * 64, (z + 1) * 64)
		render.setShroud(sight, 64, 64, 0, 0)
		device.pushErrorScope('validation')
		for (let i = 0; i < 60; i++) app.renderOneFrame(i * 1000 / 60)
		await device.queue.onSubmittedWorkDone()
		const timings = []
		for (let i = 60; i < 88; i++) {
			const start = performance.now()
			app.renderOneFrame(i * 1000 / 60)
			await device.queue.onSubmittedWorkDone()
			if (i >= 68) timings.push(performance.now() - start)
		}
		app.renderOneFrame(88 * 1000 / 60)
		const canvas = document.createElement('canvas'); canvas.width = ctx.canvas.width; canvas.height = ctx.canvas.height
		canvas.getContext('2d').drawImage(ctx.canvas, 0, 0)
		const png = canvas.toDataURL('image/png')
		const stride = Math.ceil(canvas.width * 4 / 256) * 256
		const readback = device.createBuffer({ size: stride * canvas.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
		const encoder = device.createCommandEncoder()
		encoder.copyTextureToBuffer({ texture: render.targets.reflection }, { buffer: readback, bytesPerRow: stride }, [canvas.width, canvas.height])
		device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ)
		const pixels = new Uint8Array(readback.getMappedRange())
		let eligible = 0, visibleMatte = 0
		for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
			const alpha = pixels[y * stride + x * 4 + 3]
			if (alpha > 70) eligible++
			else if (alpha >= 63) visibleMatte++
		}
		readback.unmap(); readback.destroy()
		const validation = await device.popErrorScope()
		if (validation) throw new Error(validation.message)
		timings.sort((a, b) => a - b)
		return { png, eligible, visibleMatte, medianMs: timings[Math.floor(timings.length / 2)], drawCalls: render.stats.drawCalls }
	}, { hiddenWall: hideWall, surfaceKind: surface })
	assert.deepEqual(errors, [], `${mode}: no GPU or page errors`)
	await page.close()
	return { ...result, png: Buffer.from(result.png.split(',')[1], 'base64') }
}
