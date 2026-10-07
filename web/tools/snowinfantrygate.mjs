#!/usr/bin/env node
// A real skirmish must keep skinned infantry free of the terrain snow overlay.
// The old shader painted light patches over the soldier's teal uniform; source
// assertions alone cannot prove that the skinned mesh reaches the right variant.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { configFor } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'
import { decodePng } from './png.mjs'
import { stopChild } from './harness.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const port = 8496
const supplied = process.env.SNOW_INFANTRY_URL
const base = supplied ?? `http://127.0.0.1:${port}`
const serverPath = resolve(root, 'engine/OpenRA.Browser/tests/server.mjs')
const bundle = resolve(root, 'engine/bin-browser/AppBundle')
let server
if (!supplied) {
	server = spawn(process.execPath, [serverPath, '--root', bundle, '--port', String(port)],
		{ cwd: resolve(root, 'engine'), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
	server.stdout.on('data', () => {})
	server.stderr.on('data', data => process.stderr.write(`[snowinfantrygate/server] ${data}`))
	let ready = false
	for (let i = 0; i < 200 && !ready; i++) {
		try { const response = await fetch(`${base}/steelseed/index.html`); await response.body?.cancel(); ready = response.ok } catch { /* starting */ }
		if (!ready) await new Promise(resolve => setTimeout(resolve, 150))
	}
	if (!ready) { await stopChild(server); throw Error('composed AppBundle did not serve') }
}

let browser
try {
	browser = await chromium.launch({ args: [
		'--enable-unsafe-webgpu', '--ignore-gpu-blocklist',
		...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
	] })
	const captures = []
	for (const weather of ['clear', 'snow']) {
		const page = await browser.newPage({ viewport: { width: 1512, height: 982 }, deviceScaleFactor: 2 })
		const errors = []
		page.on('pageerror', error => errors.push(error.message))
		try {
			await page.goto(`${base}/steelseed/index.html?mode=game&platform=null&quality=high&weather=${weather}&daylight=day`,
				{ waitUntil: 'domcontentloaded', timeout: 120000 })
			await page.waitForFunction(() => globalThis.steelseed?.ctx?.session?.available,
				undefined, { timeout: 180000 })
			const packed = await page.evaluate(async () => {
				const catalog = await steelseed.ctx.session.getCatalog()
				return { catalog, map: catalog.maps.find(map => map.title === 'Doubles') }
			})
			assert.ok(packed.map, 'Doubles map is in the composed catalog')
			const config = configFor(packed.catalog, packed.map, { withBot: false })
			Object.assign(config.options, { startingunits: 'heavy', explored: 'True', fog: 'False', crates: 'False' })
			await page.evaluate(config => steelseed.ctx.session.startSkirmish(config), config)
			await page.waitForFunction(() => globalThis.steelseed?.ctx?.snapshot?.actors?.count > 0 &&
				document.getElementById('session-ui').hidden, undefined, { timeout: 180000 })
			const actor = await page.evaluate(() => {
				const app = steelseed, ctx = app.ctx, actors = ctx.snapshot.actors
				for (let i = 0; i < actors.count; i++) {
					if (actors.owner[i] !== ctx.snapshot.world.renderPlayer || ctx.actorTypeName(actors.typeId[i]) !== 'e1') continue
					const x = actors.posX[i] / 1024, z = actors.posY[i] / 1024, camera = ctx.get('camera')
					camera.focusWorld(x, z)
					camera.height = camera.heightGoal = 2
					camera.yaw = camera.yawGoal = 1.6
					camera.tilt = camera.tiltGoal = .25
					app.governorHold = true
					return { id: actors.id[i], x, z }
				}
				return null
			})
			assert.ok(actor, `e1 infantry exists for ${weather}`)
			await page.evaluate(() => steelseed.ctx.session.setPaused(true))
			await page.evaluate(() => steelseed.ctx.get('render').setDebugView('albedo'))
			await page.waitForTimeout(1200)
			const image = decodePng(await page.screenshot({ clip: { x: 685, y: 370, width: 150, height: 165 } }))
			const state = await page.evaluate(() => ({
				snowCoverage: steelseed.ctx.get('sky').model.snowCoverage,
				weatherKind: steelseed.ctx.get('sky').localWeather.weatherKind,
			}))
			assert.deepEqual(errors, [], `${weather}: no page errors`)
			captures.push({ weather, actor, state, image })
		} finally { await page.close() }
	}
	const [clear, snow] = captures
	assert.equal(clear.image.width, snow.image.width)
	assert.equal(clear.image.height, snow.image.height)
	assert.equal(clear.state.snowCoverage, 0, 'clear weather has no snow')
	assert.ok(snow.state.snowCoverage >= .3, 'snow scene covers the terrain')
	assert.equal(clear.actor.id, snow.actor.id, 'same soldier in both scenes')
	let count = 0, neutral = 0, chromaClear = 0, chromaSnow = 0
	for (let i = 0; i < clear.image.data.length; i += 4) {
		const c = clear.image.data, s = snow.image.data
		// Identify the teal uniform from the clear image, excluding the snow/sky/ground.
		if (c[i + 1] - c[i] <= 10 || c[i + 2] - c[i] <= 10 || c[i + 1] >= 145) continue
		count++
		chromaClear += c[i + 1] - c[i]
		chromaSnow += s[i + 1] - s[i]
		if (s[i + 1] - s[i] < 15) neutral++
	}
	assert.ok(count > 1000, `clear image exposes enough uniform pixels (${count})`)
	const neutralFraction = neutral / count
	assert.ok(neutralFraction < .05,
		`snow must not paint pale patches on infantry (${(neutralFraction * 100).toFixed(1)}% neutral)`)
	assert.ok(chromaSnow / count >= chromaClear / count - 5,
		`snow must preserve uniform colour (${(chromaClear / count).toFixed(1)} → ${(chromaSnow / count).toFixed(1)})`)
	console.log(`snowinfantrygate: PASS — ${count} uniform pixels, ${(neutralFraction * 100).toFixed(2)}% neutral in snow, ` +
		`chroma ${(chromaClear / count).toFixed(1)} → ${(chromaSnow / count).toFixed(1)}`)
} finally {
	await browser?.close()
	if (server) await stopChild(server)
}
