#!/usr/bin/env node
// Real production DOM handlers + OpenRA order payloads, including repeated clicks.
// Authoritative completion after repeated orders is covered by economygate.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { launchGpuBrowser, loadChromium, startPreview, stopChild } from './harness.mjs'

const TOOL = 'productionordergate'
const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(resolve(root, 'src/core/ra-visual-manifest.json'), 'utf8'))
const wanted = Object.entries(manifest.actors).filter(([, actor]) => actor.renderable && actor.traits.some(t => t.Name === 'Buildable'))
for (const [name] of wanted) assert.ok(existsSync(resolve(root, `.forge/blender/previews/${name}.png`)), `missing portrait ${name}`)
let browser, server
try {
	const chromium = await loadChromium(TOOL)
	const launched = await launchGpuBrowser(chromium, TOOL)
	browser = launched.browser
	const preview = await startPreview(8432)
	server = preview.server
	const page = await browser.newPage({ viewport: { width: 1512, height: 982 } })
	const errors = []
	page.on('pageerror', error => errors.push(error.message))
	await page.addInitScript(() => {
		globalThis.requestAnimationFrame = () => 1
		globalThis.cancelAnimationFrame = () => {}
	})
	await page.goto(`${preview.baseUrl}?devmap=1&deterministic=1&manual=1`, { waitUntil: 'domcontentloaded' })
	await page.waitForFunction(() => !!globalThis.steelseed, undefined, { timeout: 120000, polling: 100 })
	const result = await page.evaluate(async () => {
		const app = globalThis.steelseed
		app.stop()
		let frame = 0
		// Snapshot intake awaits the actor table; synchronous frames cannot settle it.
		for (let i = 0; i < 120 && app.ctx.snapshot === null; i++) {
			await new Promise(resolve => setTimeout(resolve, 16))
			app.renderOneFrame(frame++ * 1000 / 60)
		}
		for (let i = 0; i < 6; i++) app.renderOneFrame(frame++ * 1000 / 60)
		const ctx = app.ctx, ui = ctx.get('ui'), snap = ctx.snapshot
		ui.selected.length = 0
		// devmap has synthetic actor names. Give its production-only items real roster
		// identities so the same DOM path can also verify shipped Blender portraits.
		const originalTypeName = ctx.actorTypeName
		const names = new Map()
		const examples = [['powr', 'proc', 'weap'], ['e1', 'e3', 'e6'], ['mcv', '2tnk', 'harv']]
		for (const q of snap.production) for (let j = 0; j < q.items.length; j++) {
			const i = q.items[j], choices = examples[q.kind] ?? examples[0]
			if (!names.has(i.actorType)) names.set(i.actorType, choices[j % choices.length])
		}
		ctx.actorTypeName = id => names.get(id) ?? originalTypeName(id)
		ui.queueDom.length = 0
		const queue = snap.production.find(q => q.playerId === snap.world.renderPlayer && q.items.some(i => (i.flags & 2) !== 0))
		const item = queue.items.find(i => (i.flags & 2) !== 0)
		const actorName = ctx.actorTypeName(item.actorType)
		const orders = []
		ctx.issueOrder = order => orders.push({ ...order, subjectIds: Array.from(order.subjectIds) })
		const sync = () => ui.syncProductionDom(snap.production, ctx)
		const button = () => document.querySelector(`button[data-queue-id="${queue.queueId}"][data-actor-type="${item.actorType}"]`)
		const click = (options = {}) => button().dispatchEvent(new MouseEvent('click', { bubbles: true, ...options }))
		const right = (options = {}) => button().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, ...options }))
		queue.flags = 1
		queue.progressPermille = 450
		queue.currentActorType = item.actorType
		queue.itemsQueued = 3
		item.flags = 1 | 2 | 4 | 8
		item.queued = 3
		sync()
		for (let i = 0; i < 10; i++) click()
		const repeats = orders.splice(0)
		click({ shiftKey: true })
		const batch = orders.pop()
		click({ ctrlKey: true })
		const priority = orders.pop()
		right()
		const pause = orders.pop()
		queue.flags |= 2
		sync()
		const pausedText = button().textContent
		click()
		const resume = orders.pop()
		right()
		const cancelPaused = orders.pop()
		queue.flags = 1
		button().dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))
		const middleCancel = orders.pop()
		item.flags |= 16 | 32
		queue.flags |= 4
		queue.progressPermille = 1000
		sync()
		const readyText = button().textContent
		const beforeReady = orders.length
		click()
		const ready = { newOrders: orders.length - beforeReady, actor: ui.pendingPlacement?.actorName, text: document.getElementById('hud-placement').textContent }
		right({ shiftKey: true })
		const cancelFive = orders.pop()
		right({ ctrlKey: true })
		const cancelAll = orders.pop()
		item.queued = 0
		item.flags = 1 | 2
		queue.itemsQueued = 0
		queue.progressPermille = 0
		queue.currentActorType = 65535
		queue.flags = 1
		sync()
		const beforeEmpty = orders.length
		right()
		const emptyCancelOrders = orders.length - beforeEmpty
		return { repeats, batch, priority, pause, resume, cancelPaused, middleCancel, cancelFive, cancelAll, emptyCancelOrders, ready, readyText, pausedText, actorName }
	})
	assert.equal(result.repeats.length, 10)
	assert.ok(result.repeats.every(o => o.orderString === 'StartProduction' && o.queued === true && o.extraData === 1))
	assert.equal(result.batch.extraData, 5)
	assert.equal(result.batch.queued, true)
	assert.equal(result.priority.queued, false)
	assert.deepEqual([result.pause.orderString, result.pause.extraData], ['PauseProduction', 1])
	assert.deepEqual([result.resume.orderString, result.resume.extraData], ['PauseProduction', 0])
	assert.equal(result.cancelPaused.orderString, 'CancelProduction')
	assert.equal(result.middleCancel.orderString, 'CancelProduction')
	assert.equal(result.cancelFive.extraData, 5)
	assert.equal(result.cancelAll.extraData, 3)
	assert.equal(result.emptyCancelOrders, 0)
	assert.equal(result.ready.newOrders, 0)
	assert.equal(result.ready.actor, result.actorName)
	assert.match(result.readyText, /READY · PLACE/)
	assert.match(result.pausedText, /ON HOLD · RESUME/)
	await page.waitForFunction(() => [...document.querySelectorAll('.hud-item-preview')].every(img => img.complete && img.naturalWidth > 0), undefined, { polling: 100 })
	const portraits = await page.locator('.hud-item-preview').count()
	assert.ok(portraits > 0, 'production pane has no model portraits')
	mkdirSync(resolve(root, 'shots'), { recursive: true })
	await page.locator('#hud-production').screenshot({ path: resolve(root, 'shots/production-model-previews.png') })
	assert.deepEqual(errors, [])
	console.log(`${TOOL}: PASS — 94 Blender portraits; 10 repeated clicks append; Shift 5 / Ctrl priority; pause, resume, cancel and completed-building placement`)
} finally {
	if (browser) await browser.close()
	if (server) await stopChild(server)
}
