#!/usr/bin/env node
// Public-source edition: validate the real shared AppBundle and neutral skirmish interface.
// No production service is contacted. --falsify=zero checks the missing-engine failure boundary.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { launchGpuBrowser, loadChromium } from './harness.mjs'
import { spawnProcessGroup, stopProcessGroup } from './process-group.mjs'

const root = resolve(import.meta.dirname, '../..')
const args = new Map(process.argv.slice(2).map(arg => {
	const [key, ...rest] = arg.replace(/^--/, '').split('=')
	return [key, rest.join('=') || '1']
}))
const port = Number(args.get('port') ?? 8415)
assert.ok(Number.isSafeInteger(port) && port > 0 && port < 65536, 'valid local port')
const url = new URL(args.get('url') ?? `http://127.0.0.1:${port}/steelseed/index.html`)
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'the public gate only tests a local checkout')
url.searchParams.set('quality', 'low')
const falsify = args.get('falsify') ?? 'none'
assert.ok(['none', 'zero'].includes(falsify), 'known falsification mode')
const server = args.has('url') ? null : spawnProcessGroup(process.execPath, [
	join(root, 'engine/OpenRA.Browser/tests/server.mjs'),
	'--root', join(root, 'engine/bin-browser/AppBundle'), '--port', String(port),
], { cwd: root, stdio: 'ignore' })
let browser
try {
	const deadline = Date.now() + 15000
	for (;;) {
		try { const response = await fetch(url); await response.body?.cancel(); if (response.ok) break } catch {}
		assert.ok(Date.now() < deadline, 'the local AppBundle server starts')
		await new Promise(resolve => setTimeout(resolve, 100))
	}
	const launched = await launchGpuBrowser(await loadChromium('composedgate'), 'composedgate')
	browser = launched.browser
	if (launched.warning) console.warn(launched.warning)
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
	const errors = [], external = []
	page.on('pageerror', error => errors.push(error.message))
	page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
	await page.route('**/*', route => {
		const request = new URL(route.request().url())
		if (['http:', 'https:', 'ws:', 'wss:'].includes(request.protocol) && request.origin !== url.origin) {
			external.push(request.href)
			return route.abort()
		}
		return route.continue()
	})
	if (falsify === 'zero') await page.route('**/steelseed/index.html*', async route => {
		const response = await route.fetch()
		await route.fulfill({ response, body: (await response.text()).replace('<script type="module" src="../main.js"></script>', '') })
	})
	await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 })
	await page.waitForFunction(() => globalThis.steelseed && document.getElementById('boot').hidden, undefined, { timeout: 120000 })
	assert.ok(await page.evaluate(() => globalThis.steelseed.ctx.session.available), 'real engine session is available')
	assert.ok(await page.locator('.rwp-card select option').count() > 0, 'the engine provides maps')
	await page.locator('.rwp-start').click()
	await page.waitForFunction(() => globalThis.steelseed.ctx.snapshot?.actors?.count > 0 && document.querySelector('.rwp-card').hidden, undefined, { timeout: 120000 })
	const start = await page.evaluate(() => globalThis.steelseed.ctx.snapshot.tick)
	await page.waitForFunction(tick => globalThis.steelseed.ctx.snapshot.tick >= tick + 10, start, { timeout: 15000 })
	await page.keyboard.press('a')
	assert.match(await page.locator('.rwp-strip').innerText(), /Units\s+[1-9]/, 'selection uses local actors')
	// Observe the real call/response; the wrapper forwards unchanged to the actual engine.
	await page.evaluate(() => {
		const ctx = globalThis.steelseed.ctx, issue = ctx.issueOrder
		globalThis.publicOrderProof = null
		ctx.issueOrder = async order => {
			const reply = await issue(order)
			globalThis.publicOrderProof = { contextual: order.contextual, count: order.subjectIds.length, reply }
			return reply
		}
	})
	await page.locator('#viewport').click({ button: 'right', position: { x: 700, y: 440 } })
	await page.waitForFunction(() => globalThis.publicOrderProof !== null, undefined, { timeout: 10000 })
	const order = await page.evaluate(() => globalThis.publicOrderProof)
	assert.ok(order.contextual && order.count > 0, 'contextual order comes from the minimal UI')
	assert.match(order.reply, /^ok(?::|\b)/i, 'the simulation accepts the order')
	await page.locator('#legal summary').click()
	for (const href of await page.locator('#legal a[href^="./licenses/"]').evaluateAll(links => links.map(link => link.href))) {
		const response = await page.request.get(href)
		assert.ok(response.ok(), `packaged legal document ${href}`)
	}
	await page.locator('#legal summary').click()
	assert.deepEqual(external, [], 'no external service contacted')
	assert.deepEqual(errors, [], 'no runtime/console errors')
	const out = join(root, 'web/shots')
	mkdirSync(out, { recursive: true })
	await page.screenshot({ path: join(out, 'public-source-skirmish.png') })
	const proof = await page.evaluate(() => ({ tick: globalThis.steelseed.ctx.snapshot.tick, actors: globalThis.steelseed.ctx.snapshot.actors.count, players: globalThis.steelseed.ctx.snapshot.players.length }))
	writeFileSync(join(out, 'public-source-skirmish.json'), JSON.stringify({ ...proof, order, external, errors }, null, 2) + '\n')
	console.log(`composedgate: PASS — real engine, maps, skirmish, ticking, selection, accepted order, legal documents; ${JSON.stringify(proof)}`)
} finally {
	await browser?.close()
	if (server) await stopProcessGroup(server)
}
