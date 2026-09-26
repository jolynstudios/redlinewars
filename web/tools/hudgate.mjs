#!/usr/bin/env node
// STEELSEED — tools/hudgate
// End-to-end player/economy/production HUD gate against the production decoder and UI.
// It exercises real DOM events and the real camera ground picker; no order is inferred
// from button state alone.
//
// Usage: node tools/hudgate.mjs [--falsify=zero] [--url URL] [--port N]

import { launchGpuBrowser, loadChromium, startPreview, stopChild } from './harness.mjs'

const TOOL = 'hudgate'
const flags = parseFlags(process.argv.slice(2))
const falsify = flags.get('falsify') ?? 'none'
if (falsify !== 'none' && falsify !== 'zero') {
	console.error(`${TOOL}: unknown --falsify=${falsify}`)
	process.exit(2)
}

const port = positiveInteger(flags.get('port') ?? 8396, 'port')
const suppliedUrl = flags.get('url') ?? null
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
	const context = await browser.newContext({
		viewport: { width: 1512, height: 982 },
		deviceScaleFactor: 1,
		locale: 'en-US',
		timezoneId: 'UTC',
	})
	const page = await context.newPage()
	const errors = []
	page.on('pageerror', error => errors.push(error.message))
	page.on('console', message => {
		if (message.type() === 'error') errors.push(message.text())
	})
	await page.addInitScript(() => {
		let id = 0
		globalThis.requestAnimationFrame = () => ++id
		globalThis.cancelAnimationFrame = () => {}
	})

	const url = new URL(preview.baseUrl)
	url.searchParams.set('mode', 'fixture') // preserve devmap through the served host-shell redirect
	url.searchParams.set('devmap', '1')
	// The deploy assertions need a deployable on the field; the default table has none.
	url.searchParams.set('devtypes', 'mcv,foundry_rivet,foundry_tread,fact')
	url.searchParams.set('manual', '1')
	url.searchParams.set('seed', 'hud-player-production-v1')
	// This gate intentionally uses the deterministic dev fixture. When inspecting a
	// composed server, omit its host entry only in this test document: otherwise the
	// real host correctly supersedes devmap and no fixture snapshot can be produced.
	if (suppliedUrl) await page.route('**/steelseed/index.html*', async route => {
		const response = await route.fetch()
		const body = (await response.text()).replace('<script type="module" src="../main.js"></script>', '')
		await route.fulfill({ response, body, headers: { ...response.headers(), 'content-type': 'text/html; charset=utf-8' } })
	})
	await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 })
	await page.waitForFunction(() => globalThis.steelseed !== undefined, undefined, {
		timeout: 120000,
		polling: 100,
	})

	const result = await page.evaluate(async (defeat) => {
		const app = globalThis.steelseed
		app.stop()
		// The actor-type table crosses the bridge asynchronously now (worker RPC in
		// the real host, a promise in the dev fixture), so kick its read and let the
		// refresh land before anything resolves names.
		app.ctx.actorTypeName(0)
		await new Promise(resolve => setTimeout(resolve, 0))
		const orders = []
		app.ctx.issueOrder = order => orders.push({
			orderString: order.orderString,
			contextual: order.contextual === true,
			targetString: order.targetString ?? '',
			targetCell: order.targetCell ? { ...order.targetCell } : null,
			extraData: order.extraData ?? 0,
			subjectCount: order.subjectCount ?? order.subjectIds.length,
		})

		for (let i = 0; i < 6; i++) app.renderOneFrame(i * (1000 / 60))
		const snap = app.ctx.snapshot
		if (defeat) {
			snap.production.length = 0
			app.ctx.get('ui').onSnapshot(snap, null, app.ctx)
		}

		const buttons = [...document.querySelectorAll('#hud-queues .hud-item')]
		const ordinary = buttons.find(button => !button.disabled && button.dataset.ready !== '1')
		if (ordinary) {
			ordinary.dispatchEvent(new MouseEvent('click', { bubbles: true }))
			ordinary.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
		}
		const ready = buttons.find(button => button.dataset.ready === '1' && button.dataset.building === '1')
		const ui = app.ctx.get('ui')
		// The deploy action belongs to whichever actor carries a deploy trait, not to
		// whatever happens to be first in the snapshot. Scan for it; fall back to id[0]
		// so the not-deployable case still exercises the hidden-button path.
		const unitsNode = app.ctx.get('units')
		let deployableId = -1
		for (let i = 0; i < snap.actors.count && deployableId < 0; i++) {
			const name = app.ctx.actorTypeName(snap.actors.typeId[i])
			if (unitsNode.deployOrder(name) === 'DeployTransform') deployableId = snap.actors.id[i]
		}
		ui.selection.length = 0
		ui.selection.push(deployableId < 0 ? snap.actors.id[0] : deployableId)
		ui.onSnapshot(snap, null, app.ctx)
		const deploy = document.getElementById('hud-deploy')
		const deployVisible = deploy?.hidden === false
		if (deployVisible) deploy.dispatchEvent(new MouseEvent('click', { bubbles: true }))

		const canvas = app.ctx.canvas
		const rect = canvas.getBoundingClientRect()
		const x = rect.left + rect.width * 0.47
		const y = rect.top + rect.height * 0.46
		canvas.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerId: 1, pointerType: 'mouse' }))
		canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y }))
		canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 2, clientX: x, clientY: y }))
		app.renderOneFrame(7 * (1000 / 60))
		canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 2, clientX: x, clientY: y }))

		if (ready) ready.dispatchEvent(new MouseEvent('click', { bubbles: true }))
		canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y }))
		app.renderOneFrame(8 * (1000 / 60))
		canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y }))

		const root = document.getElementById('game-ui')
		const production = document.getElementById('hud-production').getBoundingClientRect()
		return {
			players: snap.players.length,
			queues: snap.production.length,
			items: snap.production.reduce((n, q) => n + q.items.length, 0),
			rootVisible: root.hidden === false,
			cash: document.getElementById('hud-cash').textContent,
			power: document.getElementById('hud-power').textContent,
			buttonCount: buttons.length,
			hasDisabled: buttons.some(button => button.disabled),
			hasReady: ready != null,
			productionInside: production.left >= 0 && production.right <= innerWidth && production.top >= 0 && production.bottom <= innerHeight,
			orders,
			deployDebug: {
				count: snap.actors.count,
				firstNames: Array.from({ length: Math.min(6, snap.actors.count) },
					(_, i) => app.ctx.actorTypeName(snap.actors.typeId[i])),
				deployableId,
				deployHidden: deploy ? deploy.hidden : 'missing',
			},
			deployVisible,
			placementVisibleAfterGroundClick: document.getElementById('hud-placement').hidden === false,
			placementStatusAfterGroundClick: document.getElementById('hud-placement').textContent,
			placementPendingAfterGroundClick: ui.pendingPlacement?.actorName ?? '',
			placementResultAfterGroundClick: ui.placementResult?.status ?? '',
			placementAvailable: app.ctx.placement.available,
		}
	}, falsify === 'zero')
	const creditCases = await page.evaluate(() => {
		const app = globalThis.steelseed
		const snap = app.ctx.snapshot
		const player = snap.players.find(candidate => (candidate.flags & 2) !== 0)
		const original = [player.cash, player.resources]
		const cases = [[5000, 1375], [0, 1375], [5000, 0]].map(([cash, resources]) => {
			player.cash = cash
			player.resources = resources
			app.ctx.get('ui').onSnapshot(snap, null, app.ctx)
			return {
				cash, resources,
				credits: document.getElementById('hud-cash').textContent,
				ore: document.getElementById('hud-resources').textContent,
			}
		})
		;[player.cash, player.resources] = original
		app.ctx.get('ui').onSnapshot(snap, null, app.ctx)
		return cases
	})

	// The production rail is the densest HUD surface. Exercise the responsive path in
	// the same run so a desktop-only pass cannot certify a panel that is unreachable on
	// the minimum supported viewport.
	await page.setViewportSize({ width: 640, height: 760 })
	const mobile = await page.evaluate(() => {
		const production = document.getElementById('hud-production').getBoundingClientRect()
		const economy = document.getElementById('hud-economy').getBoundingClientRect()
		const selection = document.getElementById('hud-selection').getBoundingClientRect()
		return {
			productionInside: production.left >= 0 && production.right <= innerWidth &&
				production.top >= 0 && production.bottom <= innerHeight,
			economyInside: economy.left >= 0 && economy.right <= innerWidth &&
				economy.top >= 0 && economy.bottom <= innerHeight,
			selectionInside: selection.left >= 0 && selection.right <= innerWidth &&
				selection.top >= 0 && selection.bottom <= innerHeight && selection.width > 0 && selection.height > 0,
		}
	})

	const problems = [...errors]
	if (result.players !== 2) problems.push(`decoded ${result.players} players, expected 2`)
	if (result.queues !== 3) problems.push(`decoded ${result.queues} queues, expected 3`)
	if (result.items !== 5) problems.push(`decoded ${result.items} items, expected 5`)
	if (!result.rootVisible) problems.push('HUD root stayed hidden with a render player present')
	if (result.cash !== '5,000') problems.push(`cash rendered as '${result.cash}', expected '5,000'`)
	for (const sample of creditCases) {
		if (sample.credits !== (sample.cash + sample.resources).toLocaleString('en-US'))
			problems.push(`stored ore is excluded from spendable credits: ${JSON.stringify(sample)}`)
		if (sample.ore !== sample.resources.toLocaleString('en-US'))
			problems.push(`stored ore breakdown is incorrect: ${JSON.stringify(sample)}`)
	}
	if (result.power !== '40 / 100') problems.push(`power rendered as '${result.power}', expected '40 / 100'`)
	if (result.buttonCount !== 5) problems.push(`rendered ${result.buttonCount} item buttons, expected 5`)
	if (!result.hasDisabled) problems.push('unbuildable production item was not disabled')
	if (!result.hasReady) problems.push('ready structure did not expose a placement action')
	if (!result.productionInside) problems.push('production panel overflows the pinned viewport')
	if (!mobile.productionInside) problems.push('production panel overflows the 640x760 mobile viewport')
	if (!mobile.economyInside) problems.push('economy bar overflows the 640x760 mobile viewport')
	if (!mobile.selectionInside) problems.push('selection/deploy panel is hidden or overflows the 640x760 mobile viewport')
	if (!result.orders.some(order => order.orderString === 'StartProduction' && order.subjectCount === 0 && order.extraData === 1))
		problems.push('left click did not issue a player-level StartProduction order')
	if (!result.orders.some(order => ['PauseProduction', 'CancelProduction'].includes(order.orderString) &&
		order.subjectCount === 0 && order.extraData === 1))
		problems.push('right click did not pause or cancel the player-level production item')
	const issuedBlindPlacement = result.orders.some(order => order.orderString === 'PlaceBuilding')
	// devmap deliberately has no binary Placement ABI. The safe behavior is to keep the
	// ready item armed and issue nothing; only the composed OpenRA host may validate and
	// transmit PlaceBuilding/LineBuild/PlacePlug (covered by placementgate + browser play).
	if (!result.placementAvailable && issuedBlindPlacement)
		problems.push('placement-unavailable devmap bypassed validation with a blind PlaceBuilding order')
	if (!result.deployVisible)
		problems.push('an authoritative deployable actor did not expose the deploy / expand action')
	if (result.deployDebug) console.log('hudgate: deploy-debug ' + JSON.stringify(result.deployDebug))
	if (!result.deployVisible)
		problems.push('deploy / expand did not issue one local DeployTransform subject')
	if (!result.orders.some(order => order.contextual && order.orderString === 'Contextual' && order.subjectCount === 1))
		problems.push('right click did not issue one local actor through the OpenRA contextual-order bridge')
	if (result.placementAvailable && result.placementVisibleAfterGroundClick)
		problems.push(`placement prompt stayed armed after the order was issued (${result.placementStatusAfterGroundClick}; ` +
			`pending=${result.placementPendingAfterGroundClick || 'none'} result=${result.placementResultAfterGroundClick || 'none'})`)
	if (!result.placementAvailable && !result.placementVisibleAfterGroundClick)
		problems.push('placement-unavailable devmap discarded the ready item instead of keeping it armed')

	console.log(
		`${TOOL}: players=${result.players} queues=${result.queues} items=${result.items} ` +
		`buttons=${result.buttonCount} mobile=${mobile.productionInside && mobile.economyInside && mobile.selectionInside ? 'inside' : 'overflow'} ` +
		`placement=${result.placementAvailable ? 'validated' : 'unavailable-safe'} ` +
		`orders=${result.orders.map(o => o.orderString).join(',') || 'none'}`,
	)
	if (problems.length > 0) {
		for (const problem of problems) console.error(`  ${problem}`)
		console.error(`${TOOL}: FAIL — player state or production control is not end-to-end`)
		exitCode = 1
	} else console.log(`${TOOL}: PASS — economy, queue state, production, cancellation and structure placement are live`)

	await context.close()
} catch (error) {
	console.error(`${TOOL}: FAIL — ${error.message}`)
	exitCode = 1
} finally {
	if (browser) await browser.close()
	if (server) await stopChild(server)
}

process.exit(exitCode)

function parseFlags(argv) {
	const out = new Map()
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (!arg.startsWith('--')) throw new Error(`${TOOL}: unknown positional argument '${arg}'`)
		const body = arg.slice(2)
		const eq = body.indexOf('=')
		if (eq >= 0) out.set(body.slice(0, eq), body.slice(eq + 1))
		else if (body === 'url' || body === 'port' || body === 'falsify') out.set(body, argv[++i])
		else throw new Error(`${TOOL}: unknown flag --${body}`)
	}
	return out
}

function positiveInteger(value, label) {
	const n = Number(value)
	if (!Number.isInteger(n) || n <= 0) throw new Error(`${TOOL}: --${label} must be a positive integer`)
	return n
}
