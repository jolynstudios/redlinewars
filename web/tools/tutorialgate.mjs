#!/usr/bin/env node
// First-match tutorial in a real browser on the composed AppBundle (`npm run build:game` first):
// Welcome → Deploy (through the real Deploy button) → Power Plant with the ring on its build tile →
// READY in the ready tray → placed → the card moves on to the Ore Refinery → Skip sets the flag.
// Screenshots for review land in web/shots/tutorial-*.png. `?tutorial=on`, because automation
// (navigator.webdriver) never sees the tutorial on its own.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { launchGpuBrowser, loadChromium } from './harness.mjs'
import { spawnProcessGroup, stopProcessGroup } from './process-group.mjs'

const TOOL = 'tutorialgate'
const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ENGINE_ROOT = join(WEB_ROOT, '..', 'engine')
const SHOTS = join(WEB_ROOT, 'shots')
const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.slice(7) ?? 8419)
const baseUrl = `http://127.0.0.1:${port}/steelseed/index.html`
mkdirSync(SHOTS, { recursive: true })

const server = spawnProcessGroup(process.execPath, [
	join(ENGINE_ROOT, 'OpenRA.Browser', 'tests', 'server.mjs'), '--root', join(ENGINE_ROOT, 'bin-browser', 'AppBundle'), '--port', String(port),
], { cwd: ENGINE_ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
let browser = null
let exitCode = 0

const title = page => page.evaluate(() => document.getElementById('tutorial')?.hidden === false ? document.getElementById('tutorial-title')?.textContent ?? '' : '')
const waitTitle = (page, text, timeout = 90000) => page.waitForFunction(expected =>
	document.getElementById('tutorial')?.hidden === false && document.getElementById('tutorial-title')?.textContent === expected,
	text, { timeout, polling: 200 })
/** The ring must frame the element: its box contains the target's box. */
const ringFrames = (page, selector) => page.evaluate(sel => {
	const ring = document.getElementById('tutorial-ring')
	const target = document.querySelector(sel)
	if (!ring || ring.hidden || !target) return false
	const r = ring.getBoundingClientRect()
	const t = target.getBoundingClientRect()
	return r.left <= t.left + 1 && r.top <= t.top + 1 && r.right >= t.right - 1 && r.bottom >= t.bottom - 1
}, selector)
/** The card never covers its own target. */
const cardClear = (page, selector) => page.evaluate(sel => {
	const card = document.getElementById('tutorial')?.getBoundingClientRect()
	const target = document.querySelector(sel)?.getBoundingClientRect()
	if (!card || !target) return false
	return card.right <= target.left || card.left >= target.right || card.bottom <= target.top || card.top >= target.bottom
}, selector)

try {
	for (let i = 0; ; i++) {
		if ((await fetch(baseUrl).then(r => r.ok).catch(() => false))) break
		if (i > 150) throw new Error(`${TOOL}: server never answered`)
		await new Promise(r => setTimeout(r, 200))
	}
	const launched = await launchGpuBrowser(await loadChromium(TOOL), TOOL)
	browser = launched.browser
	const page = await browser.newPage({ viewport: { width: 1512, height: 982 } })
	const errors = []
	page.on('pageerror', error => errors.push(error.message))
	await page.goto(`${baseUrl}?mode=game&platform=null&quality=low&tutorial=on&Debug.ServerRandomSeed=104729`)
	// The loader's alpha notice, while it is on screen.
	await page.waitForSelector('.boot-alpha a[href$="/issues"]', { timeout: 60000 })
	await page.screenshot({ path: join(SHOTS, 'tutorial-loader-alpha.png') })
	await page.waitForFunction(() => document.querySelectorAll('#session-map option').length > 0 && document.getElementById('boot')?.hidden,
		undefined, { timeout: 300000, polling: 250 })
	await page.click('#session-start')

	await waitTitle(page, 'Welcome, Commander', 180000)
	assert.equal(await page.evaluate(() => document.getElementById('tutorial-ring').hidden), true, 'welcome has no target')
	await page.screenshot({ path: join(SHOTS, 'tutorial-1-welcome.png') })

	await page.click('#tutorial-next')
	await waitTitle(page, 'Deploy your MCV')
	await page.waitForFunction(() => !document.getElementById('hud-deploy')?.hidden, undefined, { timeout: 60000 })
	await page.waitForTimeout(400)
	assert.ok(await ringFrames(page, '#hud-deploy'), 'the ring frames Deploy / expand')
	assert.ok(await cardClear(page, '#hud-deploy'), 'the card leaves Deploy / expand clear')
	await page.screenshot({ path: join(SHOTS, 'tutorial-2-deploy.png') })

	await page.click('#hud-deploy')
	await waitTitle(page, 'Credits and power')
	console.log(`${TOOL}: deploy completed the step by itself`)
	await page.click('#tutorial-next')
	await waitTitle(page, 'Build from here')
	await page.click('#tutorial-next')
	await waitTitle(page, 'Power Plant')
	const tile = '#hud-queues .hud-item[data-actor-name="powr"]'
	await page.waitForTimeout(400)
	assert.ok(await ringFrames(page, tile), 'the ring frames the Power Plant tile')
	assert.ok(await cardClear(page, tile), 'the card leaves the Power Plant tile clear')
	assert.match(await page.evaluate(() => document.getElementById('tutorial-count').textContent), /Build order · 1 of 6/)
	assert.match(await page.evaluate(() => document.getElementById('tutorial-facts').textContent), /\$300 · \+100 power/i)
	await page.screenshot({ path: join(SHOTS, 'tutorial-3-power-plant.png') })
	await page.setViewportSize({ width: 1024, height: 700 })
	await page.waitForTimeout(600)
	assert.ok(await cardClear(page, tile), 'at 1024×700 the card still leaves the tile clear')
	await page.screenshot({ path: join(SHOTS, 'tutorial-3-power-plant-1024.png') })
	await page.setViewportSize({ width: 1512, height: 982 })

	await page.click(tile)
	await page.waitForSelector('#hud-ready-list [data-actor-name="powr"]', { timeout: 90000 })
	await page.waitForTimeout(400)
	assert.ok(await ringFrames(page, '#hud-ready-list [data-actor-name="powr"]'), 'READY: the ring moves to the ready-tray card')
	assert.equal(await page.evaluate(() => document.getElementById('tutorial-status').dataset.state), 'ready')
	await page.screenshot({ path: join(SHOTS, 'tutorial-4-ready-tray.png') })

	// Place it where the UI would: the first valid cell around the Construction Yard.
	const placed = await page.evaluate(async () => {
		const ctx = globalThis.steelseed.ctx
		const snap = ctx.snapshot
		const me = snap.world.renderPlayer
		let yard = -1
		for (let i = 0; i < snap.actors.count; i++)
			if (snap.actors.owner[i] === me && ctx.actorTypeName(snap.actors.typeId[i]) === 'fact') yard = i
		const queue = snap.production.find(q => q.playerId === me && q.items.some(item => ctx.actorTypeName(item.actorType) === 'powr'))
		const cx = Math.floor(snap.actors.posX[yard] / 1024)
		const cy = Math.floor(snap.actors.posY[yard] / 1024)
		for (let radius = 3; radius <= 10; radius++)
			for (let dy = -radius; dy <= radius; dy++)
				for (let dx = -radius; dx <= radius; dx++) {
					if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue
					const request = { queueId: queue.queueId, actorType: 'powr', cellX: cx + dx, cellY: cy + dy }
					if ((await ctx.placement.query(request))?.valid) return (await ctx.placement.place(request))?.issued === true
				}
		return false
	})
	assert.ok(placed, 'the Power Plant was placed')
	await waitTitle(page, 'Ore Refinery')
	assert.equal(await page.evaluate(() => document.querySelector('#tutorial-order li[data-state="done"]')?.textContent), 'Power Plant')
	await page.screenshot({ path: join(SHOTS, 'tutorial-5-refinery.png') })

	await page.click('#tutorial-skip')
	assert.equal(await title(page), '', 'Skip closes it')
	assert.equal(await page.evaluate(() => localStorage.getItem('redline-tutorial')), 'done', 'Skip is remembered')
	assert.deepEqual(errors, [], 'no page errors')
	console.log(`${TOOL}: PASS — welcome, deploy step completed by the real deploy, ring + card on the Power Plant tile (1512×982 and 1024×700), READY in the tray, placed → Ore Refinery, Skip remembered`)
} catch (error) {
	exitCode = 1
	console.error(`${TOOL}: FAIL — ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
	await browser?.close().catch(() => {})
	await stopProcessGroup(server).catch(() => {})
}
process.exit(exitCode)
