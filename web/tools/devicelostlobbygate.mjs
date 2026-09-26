// STEELSEED — a lost graphics device in the lobby (vfx.md Epic 8: "rebuild on device loss").
//
// No match is running, so nothing is lost by booting again: the game reloads itself at once and
// comes back with a working device. (In a match the player decides: devicelostgate.)
//
// Usage (from web/, after `vite build` and compose): node tools/devicelostlobbygate.mjs
import assert from 'node:assert/strict'
import { launchGpuBrowser, loadChromium } from './harness.mjs'
import { startPrivateComposed } from './private-composed-preview.mjs'

const preview = await startPrivateComposed(8471)
const { browser } = await launchGpuBrowser(await loadChromium('devicelostlobbygate'), 'devicelostlobbygate')
try {
	const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
	await page.route('**/api/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"user":null}',
		headers: { 'access-control-allow-origin': new URL(preview.baseUrl).origin, 'access-control-allow-credentials': 'true' } }))
	await page.goto(`${preview.baseUrl}&quality=ultra`, { waitUntil: 'domcontentloaded', timeout: 60000 })
	await page.waitForFunction(() => globalThis.steelseed?.ctx?.session?.available, undefined, { timeout: 180000, polling: 200 })
	assert.equal(await page.evaluate(() => globalThis.steelseed.ctx.snapshot), null, 'the lobby has no match running')
	await page.evaluate(() => { globalThis.__beforeReload = true })
	const reloaded = page.waitForEvent('framenavigated', { timeout: 15000 })
	await page.evaluate(() => globalThis.steelseed.ctx.get('render').device.destroy())
	await reloaded
	await page.waitForFunction(() => globalThis.steelseed?.ctx?.session?.available, undefined, { timeout: 180000, polling: 200 })
	const after = await page.evaluate(() => ({ marker: globalThis.__beforeReload ?? null, lost: globalThis.steelseed.ctx.gpuLost }))
	assert.equal(after.marker, null, 'the page must have reloaded')
	assert.equal(after.lost, null, 'the new boot must have a working device')
	console.log('devicelostlobbygate: PASS — a device lost in the lobby rebooted the game at once, which came back with a working device')
} finally {
	await browser?.close(); await preview?.close?.()
}
