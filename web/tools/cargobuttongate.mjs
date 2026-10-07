#!/usr/bin/env node
// STEELSEED — tools/cargobuttongate
// The UI route of the passenger flow, on the composed OpenRA runtime through real gestures:
// a rifleman selected by click and right-clicked onto the player's own APC boards it
// (EnterTransport resolved by OpenRA); selecting the loaded APC shows the passenger count
// and a deploy button labelled for unloading which sends exactly the Unload order; the
// MCV's button sends DeployTransform and the yard appears. cargogate proves the engine
// accepts these orders; this proves the buttons and clicks send them.
//
// node tools/cargobuttongate.mjs --url=http://127.0.0.1:8321/steelseed/index.html
import assert from 'node:assert/strict'
import { launchGpuBrowser, loadChromium } from './harness.mjs'
import { configFor } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'

const TOOL = 'cargobuttongate'
const base = process.argv.find(a => a.startsWith('--url='))?.slice(6) ?? 'http://127.0.0.1:8123/steelseed/index.html'
const { browser } = await launchGpuBrowser(await loadChromium(TOOL), TOOL)
const page = await browser.newPage({ viewport: { width: 1512, height: 982 } })
const errors = []
page.on('pageerror', e => errors.push(e.message))
try {
	await page.goto(`${base}?mode=game&platform=null&quality=medium`, { waitUntil: 'domcontentloaded', timeout: 60000 })
	await page.waitForFunction(() => globalThis.steelseed?.ctx.session.available, undefined, { timeout: 180000, polling: 100 })
	const catalog = await page.evaluate(() => steelseed.ctx.session.getCatalog())
	const map = catalog.maps.find(m => m.title === 'Doubles') ?? catalog.maps[0]
	const config = configFor(catalog, map, { withBot: false })
	const soviet = ['russia', 'ukraine', 'soviet'].find(id => map.factions.some(f => f.id === id))
	assert.ok(soviet, `Soviet faction on ${map.title}`)
	config.local.faction = soviet
	const localSlot = config.slots.find(s => s.slot === config.local.slot)
	if (localSlot) localSlot.faction = soviet
	config.options.startingunits = 'light'; config.options.explored = 'True'; config.options.fog = 'False'
	await page.evaluate(c => steelseed.ctx.session.startSkirmish(c), config)
	await page.waitForFunction(() => steelseed.ctx.snapshot?.actors?.count > 0 && document.getElementById('session-ui').hidden,
		undefined, { timeout: 180000, polling: 100 })
	await page.waitForTimeout(1500)

	const actors = await page.evaluate(() => {
		const { ctx } = steelseed, a = ctx.snapshot.actors, out = {}
		for (let i = 0; i < a.count; i++) if (a.owner[i] === ctx.snapshot.world.renderPlayer) {
			const type = ctx.actorTypeName(a.typeId[i])
			if (!out[type]) out[type] = { id: a.id[i], x: a.posX[i] / 1024, z: a.posY[i] / 1024 }
		}
		globalThis.sentOrders = []
		const issue = ctx.issueOrder.bind(ctx)
		ctx.issueOrder = o => { sentOrders.push({ order: o.orderString, contextual: o.contextual === true, subjects: Array.from(o.subjectIds ?? []).slice(0, o.subjectCount ?? o.subjectIds?.length ?? 0), actor: o.targetActorId ?? 0 }); issue(o) }
		return out
	})
	assert.ok(actors.apc && actors.e1 && actors.mcv, `light Soviet start has apc, e1, mcv: ${Object.keys(actors).join(',')}`)

	// 1. Click-select the rifleman, right-click the APC: EnterTransport through the UI.
	await focusOn(actors.e1)
	let p = await project(actors.e1.id)
	await page.mouse.click(p.x, p.y)
	await page.waitForFunction(id => steelseed.ctx.get('ui').selection.includes(id), actors.e1.id, { timeout: 5000, polling: 50 })
	await focusOn(actors.apc)
	p = await project(actors.apc.id)
	await page.mouse.click(p.x, p.y, { button: 'right' })
	await page.waitForFunction(id => { const a = steelseed.ctx.snapshot.actors, i = Array.from(a.id).indexOf(id); return i >= 0 && a.cargo[i] === 1 },
		actors.apc.id, { timeout: 30000, polling: 100 })
	const boarding = await page.evaluate(() => sentOrders.slice())
	assert.equal(boarding.length, 1, `one contextual order boards: ${JSON.stringify(boarding)}`)
	assert.equal(boarding[0].contextual, true)
	assert.equal(boarding[0].actor, actors.apc.id, 'the right-click targeted the APC actor')

	// 2. Select the loaded APC: passenger readout and an Unload button that sends Unload.
	p = await project(actors.apc.id)
	await page.mouse.click(p.x, p.y)
	await page.waitForFunction(id => steelseed.ctx.get('ui').selection.includes(id), actors.apc.id, { timeout: 5000, polling: 50 })
	await page.waitForTimeout(200)
	const hud = await page.evaluate(() => ({ detail: document.getElementById('hud-selection-detail').textContent, button: document.getElementById('hud-deploy').textContent, hidden: document.getElementById('hud-deploy').hidden }))
	assert.match(hud.detail, /cargo 1\/\d+/, `HUD shows filled/capacity cargo: ${hud.detail}`)
	assert.equal(hud.hidden, false, 'deploy button visible for a loaded transport')
	assert.equal(hud.button, 'Unload passengers', `button labelled for unloading: ${hud.button}`)
	await page.click('#hud-deploy')
	await page.waitForFunction(id => { const a = steelseed.ctx.snapshot.actors, i = Array.from(a.id).indexOf(id); return i >= 0 && a.cargo[i] === 0 },
		actors.apc.id, { timeout: 30000, polling: 100 })
	const unload = await page.evaluate(() => sentOrders.slice(-1)[0])
	assert.equal(unload.order, 'Unload', `the button sent Unload: ${JSON.stringify(unload)}`)
	assert.deepEqual(unload.subjects, [actors.apc.id])
	await page.waitForTimeout(300)
	const emptyHud = await page.evaluate(() => ({ hidden: document.getElementById('hud-deploy').hidden, detail: document.getElementById('hud-selection-detail').textContent }))
	assert.equal(emptyHud.hidden, true, `empty transport hides the unload button: ${emptyHud.detail}`)

	// 3. The MCV's button still transforms.
	await focusOn(actors.mcv)
	p = await project(actors.mcv.id)
	await page.mouse.click(p.x, p.y)
	await page.waitForFunction(id => steelseed.ctx.get('ui').selection.includes(id), actors.mcv.id, { timeout: 5000, polling: 50 })
	await page.waitForTimeout(200)
	const mcvButton = await page.evaluate(() => ({ text: document.getElementById('hud-deploy').textContent, hidden: document.getElementById('hud-deploy').hidden }))
	assert.equal(mcvButton.hidden, false)
	assert.equal(mcvButton.text, 'Deploy / expand', `MCV button label: ${mcvButton.text}`)
	await page.click('#hud-deploy')
	await page.waitForFunction(() => { const { ctx } = steelseed, a = ctx.snapshot.actors; for (let i = 0; i < a.count; i++) if (a.owner[i] === ctx.snapshot.world.renderPlayer && ctx.actorTypeName(a.typeId[i]) === 'fact') return true; return false },
		undefined, { timeout: 60000, polling: 100 })
	const transform = await page.evaluate(() => sentOrders.slice(-1)[0])
	assert.equal(transform.order, 'DeployTransform', `MCV button sent DeployTransform: ${JSON.stringify(transform)}`)
	assert.deepEqual(errors, [])
	console.log(`${TOOL}: PASS — rifleman right-clicked onto the APC boarded through one contextual order; loaded APC HUD "${hud.detail.split(' · ').slice(-2).join(' · ')}"; ` +
		'Unload button sent Unload and emptied it; MCV button sent DeployTransform and the construction yard appeared')
} finally { await browser.close() }

async function focusOn(actor) {
	await page.evaluate(a => { const c = steelseed.ctx.get('camera'); c.focusWorld(a.x, a.z); c.heightGoal = 14; c.height = 14 }, actor)
	await page.waitForTimeout(500)
}

function project(id) {
	return page.evaluate(id => {
		const ctx = steelseed.ctx, units = ctx.get('units'), m = new Float32Array(16), visual = { mesh: null, surfaceSet: '', playerColor: 0 }
		if (!units.captureActorVisual(id, m, 0, visual)) throw new Error(`actor ${id} not visible`)
		const mesh = visual.mesh, c = [0, 1, 2].map(k => (mesh.aabbMin[k] + mesh.aabbMax[k]) * .5)
		const w = [m[0] * c[0] + m[4] * c[1] + m[8] * c[2] + m[12], m[1] * c[0] + m[5] * c[1] + m[9] * c[2] + m[13], m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14]]
		const vp = ctx.get('render').camera.viewProj
		const cx = vp[0] * w[0] + vp[4] * w[1] + vp[8] * w[2] + vp[12], cy = vp[1] * w[0] + vp[5] * w[1] + vp[9] * w[2] + vp[13], cw = vp[3] * w[0] + vp[7] * w[1] + vp[11] * w[2] + vp[15]
		return { x: (cx / cw * .5 + .5) * ctx.canvas.clientWidth, y: (.5 - cy / cw * .5) * ctx.canvas.clientHeight }
	}, id)
}
