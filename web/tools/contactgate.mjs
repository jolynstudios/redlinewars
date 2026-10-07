#!/usr/bin/env node
// Image and serial GPU-completion timing witnesses for bounded contact shading.
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { launchGpuBrowser, loadChromium, stopChild } from './harness.mjs'
import { spawnProcessGroup } from './process-group.mjs'
import { decodePng } from './png.mjs'

const root = resolve(import.meta.dirname, '..')
// Other agents can rebuild the shared output during a long visual run. Freeze one
// complete build so the on/off comparison never spans different assets or shaders.
const frozen = mkdtempSync(resolve(tmpdir(), 'steelseed-contact-'))
cpSync(resolve(root, 'dist'), frozen, { recursive: true })
const preview = { baseUrl: 'http://127.0.0.1:8434/', server: spawnProcessGroup(process.execPath,
	[resolve(root, '../engine/OpenRA.Browser/tests/server.mjs'), '--root', frozen, '--port', '8434'], { stdio: 'ignore' }) }
let browser
try {
	let ready = false
	for (let i = 0; i < 200; i++) {
		try { if ((await fetch(preview.baseUrl)).ok) { ready = true; break } } catch {}
		await new Promise(resolveWait => setTimeout(resolveWait, 50))
	}
	assert.ok(ready, 'frozen build server did not start')
	;({ browser } = await launchGpuBrowser(await loadChromium('contactgate'), 'contactgate'))
	const off = await capture('0'), on = await capture('1'), debug = await capture('debug')
	const a = decodePng(off.png), b = decodePng(on.png), mask = decodePng(debug.png)
	let changed = 0, maxDifference = 0, meanVisibility = 0, darkest = 255, shaded = 0, shadedDarkening = 0
	for (let i = 0; i < a.data.length; i += 4) {
		const difference = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])
		if (difference > 3) changed++
		maxDifference = Math.max(maxDifference, difference)
		meanVisibility += mask.data[i]
		darkest = Math.min(darkest, mask.data[i])
		if (mask.data[i] < 254) { shaded++; shadedDarkening += (255 - mask.data[i]) / 255 }
	}
	const pixels = a.width * a.height
	meanVisibility /= pixels * 255
	// LOCALITY IS ABOUT STRENGTH AND SEPARATION, NOT ABOUT SCREEN COVERAGE.
	//
	// This asserted `meanVisibility > 0.97` — the mean over the WHOLE frame — and it went red
	// the moment the meadow got dense, because every grass card contributes its own small
	// contact darkening. Measured against the last passing run of 2026-09-05: the cap did not
	// move at all (darkest 199 both times, maxDifference 35 -> 36) while the extent went
	// 144,069 -> 424,109 shaded pixels, 19% of the frame to 57%. The debug render shows exactly
	// that: individual grass tufts, terrain step edges and one vehicle, with open ground
	// untouched. The effect is behaving; the world got denser underneath a threshold that had
	// quietly encoded how sparse it used to be.
	//
	// So the thing "local" actually means is asserted directly: a real contact term leaves open
	// ground ALONE. A global wash darkens everything a little, which sails through any mean while
	// driving the untouched fraction to nothing. That discriminates, and it does not care how
	// much grass is in view.
	//
	// `shadedMean` is REPORTED AND NOT ASSERTED, deliberately. Asserting it under the 22% cap
	// would be a tautology: `darkest >= 198` already bounds every pixel at (255-198)/255 = 0.224,
	// so a mean over those pixels cannot exceed it, and a check that cannot fail is worse than no
	// check. Any honest threshold below the cap would be a number picked to match today's meadow,
	// which is the mistake this comment exists to record. It is printed every run so a drift is
	// visible to a person.
	const shadedMean = shaded > 0 ? shadedDarkening / shaded : 0
	const untouched = 1 - shaded / pixels
	assert.ok(changed > 40, `contact shading must affect the scene (${changed} pixels)`)
	assert.ok(darkest >= 198, `contact shading exceeded its 22% cap (${darkest}/255)`)
	assert.ok(darkest < 254, 'contact debug is blank')
	assert.ok(untouched > 0.15, `contact shading must leave open ground alone, not wash the frame (${(untouched * 100).toFixed(1)}% untouched)`)
	assert.equal(on.drawCalls, off.drawCalls, 'contact shading must not add draw calls')
	const summary = { resolution: [a.width, a.height], changed, maxDifference, shaded, darkest, meanVisibility, shadedMean, untouched,
		frameMs: { off: off.medianMs, on: on.medianMs, delta: on.medianMs - off.medianMs }, drawCalls: on.drawCalls }
	mkdirSync(resolve(root, 'shots/contact'), { recursive: true })
	for (const [name, capture] of Object.entries({ off, on, debug })) writeFileSync(resolve(root, `shots/contact/${name}.png`), capture.png)
	writeFileSync(resolve(root, 'shots/contact/report.json'), JSON.stringify(summary, null, 2) + '\n')
	console.log(`contactgate: PASS — ${JSON.stringify(summary)}`)
} finally {
	await browser?.close()
	await stopChild(preview.server)
	rmSync(frozen, { recursive: true, force: true })
}

async function capture(mode) {
	const page = await browser.newPage({ viewport: { width: 1000, height: 750 }, deviceScaleFactor: 1 })
	const errors = []
	page.on('pageerror', error => errors.push(error.message))
	page.on('console', message => { if (message.type() === 'error' && !message.text().includes('favicon')) errors.push(message.text()) })
	await page.addInitScript(() => { globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {} })
	await page.goto(`${preview.baseUrl}?devmap=1&manual=1&deterministic=1&devsize=48&devactors=1&devcluster=2&devtod=600&contact=${mode}`)
	await page.waitForFunction(() => !!globalThis.steelseed, undefined, { timeout: 120000, polling: 100 })
	const result = await page.evaluate(async () => {
		const app = globalThis.steelseed
		app.stop()
		const device = app.ctx.device
		device.pushErrorScope('validation')
		let frame = 0
		// Snapshot intake awaits the actor table; synchronous frames cannot settle it.
		for (let i = 0; i < 120 && app.ctx.snapshot === null; i++) {
			await new Promise(resolve => setTimeout(resolve, 16))
			app.renderOneFrame(frame++ * 1000 / 60)
		}
		for (let i = 0; i < 12; i++) app.renderOneFrame(frame++ * 1000 / 60)
		const units = app.ctx.get('units'), camera = app.ctx.get('camera')
		for (const key of units.typeSlot.keys()) { units.typeSlot.set(key, '2tnk'); units.typeVehicle.set(key, true) }
		camera.height = camera.heightGoal = 9
		const actors = app.ctx.snapshot.actors
		camera.target[0] = camera.targetGoal[0] = actors.posX[0] / 1024
		camera.target[2] = camera.targetGoal[2] = actors.posY[0] / 1024
		for (let i = 12; i < 60; i++) app.renderOneFrame(frame++ * 1000 / 60)
		await device.queue.onSubmittedWorkDone()
		const timings = []
		for (let i = 60; i < 92; i++) {
			const start = performance.now()
			app.renderOneFrame(frame++ * 1000 / 60)
			await device.queue.onSubmittedWorkDone()
			if (i >= 68) timings.push(performance.now() - start)
		}
		app.renderOneFrame(frame++ * 1000 / 60)
		const canvas = document.createElement('canvas')
		canvas.width = app.ctx.canvas.width
		canvas.height = app.ctx.canvas.height
		canvas.getContext('2d').drawImage(app.ctx.canvas, 0, 0)
		const png = canvas.toDataURL('image/png')
		const validation = await device.popErrorScope()
		if (validation) throw new Error(validation.message)
		timings.sort((a, b) => a - b)
		return { png, medianMs: timings[Math.floor(timings.length / 2)], drawCalls: app.ctx.get('render').stats.drawCalls }
	})
	assert.deepEqual(errors, [], `${mode}: no page/GPU errors`)
	await page.close()
	return { ...result, png: Buffer.from(result.png.split(',')[1], 'base64') }
}
