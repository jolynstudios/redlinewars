#!/usr/bin/env node
// STEELSEED — support powers and Guard, through the real UI in a real match (vfx.md Epic 3, S03).
//
// The composed game in Chromium: the WASM simulation in its worker, the renderer and the HUD. The
// lobby's developer option ("cheats", hidden in the setup screen) builds the three superweapons
// in seconds, instead of a ten-minute tech climb. DevAll gives all tech, fast build, fast charge,
// unlimited power and build anywhere. Everything under test is then done the way a player
// does it: clicks on the SUPPORT buttons, clicks on map cells, the G key.
//   - The panel lists every power with READY, and a click arms it.
//   - Iron Curtain on an own tank: the charge restarts, which is OpenRA's proof of activation,
//     and the HUD says "afgevuurd".
//   - Chronoshift: a source click on the tank and a destination click. The tank lands on the
//     destination.
//   - Guard: G, then a click on a second own tank issues Guard on it; OpenRA answers "ok".
//   - Nuke, last because it wrecks the base: the charge restarts, the Atomic detonates and fx
//     starts its staged cloud from the impact event's weapon identity.
//   - The public timers list the silo's Atom Bomb, as OpenRA's timer widget does for everyone.
//   - Aiming the Iron Curtain draws its footprint: green over the tank, red over bare ground.
//   - The nuke's beacon stands over its target through the flight, the host reports the launch
//     from the missile itself, and the beacon is gone by the detonation (BeaconRemoveAdvance).
//   - `?ordertrace=1`: a right-click order logs its trace, with OpenRA's reply and first response.
// Screenshots of each step go to the OS temp directory for review.
//
// Usage (from web/, after `vite build`): node tools/supportpoweruigate.mjs
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchGpuBrowser, loadChromium } from './harness.mjs'
import { startPrivateComposed } from './private-composed-preview.mjs'
import { configFor } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'

const SHOTS = join(tmpdir(), 'supportpoweruigate')
mkdirSync(SHOTS, { recursive: true })
const VIEWPORT = { width: 1600, height: 900 }
let preview, browser
try {
	preview = await startPrivateComposed(8497)
	;({ browser } = await launchGpuBrowser(await loadChromium('supportpoweruigate'), 'supportpoweruigate'))
	const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 })
	const page = await context.newPage()
	const errors = []
	page.on('pageerror', e => errors.push(`pageerror: ${e.message.slice(0, 200)}`))
	const traces = []
	page.on('console', m => {
		if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`console: ${m.text().slice(0, 200)}`)
		if (m.type() === 'debug' && m.text().startsWith('[ordertrace]')) traces.push(m.text())
	})
	await page.route('**/api/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"user":null}',
		headers: { 'access-control-allow-origin': new URL(preview.baseUrl).origin, 'access-control-allow-credentials': 'true' } }))
	await page.goto(`${preview.baseUrl}&quality=ultra&ordertrace=1`, { waitUntil: 'domcontentloaded', timeout: 60000 })
	await page.waitForFunction(() => globalThis.steelseed?.ctx?.session?.available, undefined, { timeout: 180000, polling: 200 })

	const catalog = await page.evaluate(async () => await globalThis.steelseed.ctx.session.getCatalog())
	const map = catalog.maps.find(m => m.title === 'Altercation') ?? catalog.maps.find(m => m.spawnPoints.length >= 2)
	const config = configFor(catalog, map, { withBot: true })
	const cheats = map.options.find(o => o.id === 'cheats')
	assert.ok(cheats, `${map.title} has no developer option`)
	Object.assign(config.options, { cheats: 'True', fog: 'False', explored: 'True', crates: 'False', startingunits: 'heavy',
		gamespeed: [...(map.options.find(o => o.id === 'gamespeed')?.values ?? []).map(v => v.id)].filter(Boolean).pop() })
	const started = await page.evaluate(async c => await globalThis.steelseed.ctx.session.startSkirmish(c), config)
	assert.notEqual(started?.status, 'error', `start failed: ${started?.code}: ${started?.userMessage}`)
	await page.waitForFunction(() => globalThis.steelseed?.ctx?.snapshot?.actors?.count > 0 && document.getElementById('session-ui')?.hidden,
		undefined, { timeout: 180000, polling: 200 })

	// Page helpers: orders exactly as the HUD sends them, every order the UI issues logged with
	// OpenRA's reply, own actors by type, and the CSS pixel of a cell centre.
	await page.evaluate(() => {
		const app = globalThis.steelseed, ctx = app.ctx
		const issue = ctx.issueOrder.bind(ctx)
		globalThis.__orders = []
		ctx.issueOrder = order => {
			const entry = { orderString: order.orderString, targetActorId: order.targetActorId ?? 0, targetCell: order.targetCell ?? null, extraCell: order.extraCell ?? null, reply: null }
			globalThis.__orders.push(entry)
			return issue(order).then(reply => (entry.reply = reply, reply))
		}
		globalThis.__gate = {
			order: (orderString, extra = {}) => issue({ orderString, subjectIds: new Uint32Array(0), subjectCount: 0, ...extra }),
			own: type => {
				const snap = ctx.snapshot, out = []
				for (let i = 0; i < snap.actors.count; i++)
					if (snap.actors.owner[i] === snap.world.renderPlayer && snap.actors.health[i] > 0 && ctx.actorTypeName(snap.actors.typeId[i]) === type)
						out.push({ id: snap.actors.id[i], x: snap.actors.posX[i] / 1024, y: snap.actors.posY[i] / 1024 })
				return out
			},
			cellPx: (cx, cy) => {
				const render = ctx.get('render'), terrain = ctx.get('terrain'), vp = render.camera.viewProj
				const x = cx + 0.5, z = cy + 0.5, y = terrain.heightAt(x, z)
				const w = vp[3] * x + vp[7] * y + vp[11] * z + vp[15]
				const rect = ctx.canvas.getBoundingClientRect()
				return { x: rect.left + ((vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / w * 0.5 + 0.5) * rect.width,
					y: rect.top + (0.5 - (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / w * 0.5) * rect.height }
			},
			focus: (x, y) => ctx.get('camera').focusWorld(x, y),
			power: key => ctx.supportPowers?.()?.powers?.find(p => p.key === key) ?? null,
			powers: () => ctx.supportPowers?.()?.powers ?? [],
		}
	})
	const gate = (fn, arg) => page.evaluate(fn, arg)
	const waitFor = (fn, arg, what, timeout = 60000) => page.waitForFunction(fn, arg, { timeout, polling: 100 }).catch(() => { throw new Error(`timed out waiting for ${what}`) })

	// Developer mode, then the MCV into a construction yard.
	assert.match(await gate(() => globalThis.__gate.order('DevAll')), /^ok/, 'DevAll refused')
	const [mcv] = await gate(() => globalThis.__gate.own('mcv'))
	assert.ok(mcv, 'no MCV at start')
	await gate(id => globalThis.steelseed.ctx.issueOrder({ orderString: 'DeployTransform', subjectIds: Uint32Array.of(id), subjectCount: 1 }), mcv.id)
	await waitFor(() => globalThis.__gate.own('fact').length > 0, undefined, 'the construction yard')

	// The three superweapons: StartProduction on the player actor, as the HUD sends it, then the
	// UI's own validated placement, spiralling out from the yard until a footprint fits.
	const [fact] = await gate(() => globalThis.__gate.own('fact'))
	for (const [index, name] of ['iron', 'pdox', 'mslo'].entries()) {
		// The yard's queues open only once its make animation completes (!build-incomplete).
		await waitFor(n => {
			const ctx = globalThis.steelseed.ctx, snap = ctx.snapshot
			return snap.production.some(q => q.playerId === snap.world.renderPlayer && q.items.some(i => ctx.actorTypeName(i.actorType) === n && (i.flags & 2) !== 0))
		}, name, `${name} buildable`)
		assert.match(await gate(n => globalThis.__gate.order('StartProduction', { targetString: n, extraData: 1, queued: true }), name), /^ok/, `StartProduction ${name} refused`)
		const queueId = await waitFor(n => {
			const ctx = globalThis.steelseed.ctx, snap = ctx.snapshot
			for (const q of snap.production) if (q.playerId === snap.world.renderPlayer)
				for (const item of q.items) if (ctx.actorTypeName(item.actorType) === n && (item.flags & 16) !== 0) return q.queueId // ProductionItemFlag.ready
			return false
		}, name, `${name} ready to place`).then(h => h.jsonValue())
		let placed = null
		for (let r = 4 + index * 4; r < 30 && !placed; r += 2)
			for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r]]) {
				const result = await gate(({ q, n, x, y }) => globalThis.steelseed.ctx.placement.place({ queueId: q, actorType: n, cellX: x, cellY: y }),
					{ q: queueId, n: name, x: Math.floor(fact.x) + dx, y: Math.floor(fact.y) + dy })
				if (result?.issued) { placed = result; break }
			}
		assert.ok(placed, `${name} found no placement`)
		await waitFor(n => globalThis.__gate.own(n).length > 0, name, `${name} standing`)
	}

	// The panel: three powers, READY (fast charge), each a button a player can press.
	await waitFor(() => {
		const buttons = [...document.querySelectorAll('#hud-support-list button[data-power]')]
		return !document.getElementById('hud-support').hidden && buttons.length >= 3 && buttons.filter(b => /READY/.test(b.textContent)).length >= 3
	}, undefined, 'three READY support buttons', 90000)
	const powers = await gate(() => globalThis.__gate.powers().map(p => ({ key: p.key, title: p.title, needsSource: p.needsSource })))
	// The public timers: the silo's Atom Bomb is listed for everyone (DisplayTimerRelationships), READY.
	const timerRows = await waitFor(() => {
		const panel = document.getElementById('hud-timers')
		const rows = [...(panel?.querySelectorAll('.hud-timer') ?? [])].map(r => r.textContent)
		return panel && !panel.hidden && rows.some(t => /READY/.test(t)) ? rows : false
	}, undefined, 'the public superweapon timers', 30000).then(h => h.jsonValue())
	assert.ok(timerRows.length >= 1, `timers ${JSON.stringify(timerRows)}`)
	await page.screenshot({ path: join(SHOTS, '1-panel-ready.png') })
	const keyOf = pattern => powers.find(p => pattern.test(p.key) || pattern.test(p.title))?.key
	const ironKey = keyOf(/GrantExternalCondition|iron/i), chronoKey = powers.find(p => p.needsSource)?.key, nukeKey = keyOf(/Nuke/i)
	assert.ok(ironKey && chronoKey && nukeKey, `powers not recognised: ${JSON.stringify(powers)}`)

	const clickCell = async (x, y) => {
		const px = await gate(({ x, y }) => globalThis.__gate.cellPx(x, y), { x, y })
		await page.mouse.move(px.x, px.y); await page.waitForTimeout(80)
		await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(120)
	}
	const pressPower = async key => {
		await page.click(`#hud-support-list button[data-power="${key}"]`)
		await page.waitForTimeout(150)
	}
	const tanks = await gate(() => [...globalThis.__gate.own('2tnk'), ...globalThis.__gate.own('1tnk'), ...globalThis.__gate.own('3tnk'), ...globalThis.__gate.own('jeep')])
	assert.ok(tanks.length >= 2, 'need two own vehicles for Iron Curtain, Chronoshift and Guard')
	const hero = tanks[0], friend = tanks[1]
	await gate(({ x, y }) => globalThis.__gate.focus(x, y), hero); await page.waitForTimeout(1200)

	// Iron Curtain on the hero tank. Armed, it draws its footprint under the cursor: green over the
	// tank (one of ours under the curtain), red over bare ground six cells off; then the click.
	await pressPower(ironKey)
	const footprintAt = async (x, y) => {
		const px = await gate(({ x, y }) => globalThis.__gate.cellPx(x, y), { x, y })
		await page.mouse.move(px.x, px.y); await page.waitForTimeout(250)
		return await gate(() => {
			const path = [...document.querySelectorAll('svg path')].find(p => /rgba\((120,230,140|255,96,72),0\.9\)/.test(p.getAttribute('stroke') ?? '') && p.style.display !== 'none' && (p.getAttribute('d') ?? '').length > 0)
			return path ? { stroke: path.getAttribute('stroke'), quads: (path.getAttribute('d').match(/Z/g) ?? []).length } : null
		})
	}
	const overTank = await footprintAt(Math.floor(hero.x), Math.floor(hero.y))
	// Five cells, and a mark over each unit the curtain would take: at least the tank.
	assert.ok(overTank && /120,230,140/.test(overTank.stroke) && overTank.quads >= 6, `footprint over the tank ${JSON.stringify(overTank)}`)
	const overGround = await footprintAt(Math.floor(hero.x), Math.floor(hero.y) + 6)
	assert.ok(overGround && /255,96,72/.test(overGround.stroke) && overGround.quads === 5, `footprint over bare ground ${JSON.stringify(overGround)}`)
	await clickCell(Math.floor(hero.x), Math.floor(hero.y))
	await waitFor(k => !globalThis.__gate.power(k)?.ready, ironKey, 'the Iron Curtain charge to restart', 10000)
	await waitFor(() => /afgevuurd/.test(document.getElementById('hud-notice')?.textContent ?? ''), undefined, 'the "afgevuurd" notice', 5000)
	// The curtain is visible on the tank for as long as OpenRA holds it (actors.status kind 1):
	// a record with its remaining time, the crimson glow, and the timer bar under the health bar.
	const curtain = await waitFor(id => {
		const ctx = globalThis.steelseed.ctx, st = ctx.snapshot?.actorStatus
		if (!st) return false
		for (let r = 0; r < st.count; r++) {
			const o = st.byteOffset + r * 12
			if (st.view.getUint32(o, true) === id && st.view.getUint8(o + 4) === 1)
				return { remaining: st.view.getUint16(o + 6, true), total: st.view.getUint16(o + 8, true), glowing: ctx.get('fx').stats.curtained,
					bars: [...document.querySelectorAll('[data-statusbar="fill"]')].filter(e => e.style.display !== 'none').length }
		}
		return false
	}, hero.id, 'the curtained tank in actors.status', 10000).then(h => h.jsonValue())
	assert.ok(curtain.remaining > 0 && curtain.remaining <= curtain.total, `curtain timer ${JSON.stringify(curtain)}`)
	assert.ok(curtain.glowing >= 1, 'a curtained tank must glow')
	assert.ok(curtain.bars >= 1, 'a curtained tank must show its timer bar')
	await page.screenshot({ path: join(SHOTS, '2-iron-curtain.png') })

	// Chronoshift: source on the hero, destination six cells east.
	const [before] = (await gate(id => globalThis.__gate.own('2tnk').concat(globalThis.__gate.own('1tnk'), globalThis.__gate.own('3tnk'), globalThis.__gate.own('jeep')).filter(a => a.id === id), hero.id))
	const target = { x: Math.floor(before.x) + 6, y: Math.floor(before.y) }
	await pressPower(chronoKey)
	await clickCell(Math.floor(before.x), Math.floor(before.y))
	await clickCell(target.x, target.y)
	await waitFor(({ id, x, y }) => {
		const snap = globalThis.steelseed.ctx.snapshot
		for (let i = 0; i < snap.actors.count; i++) if (snap.actors.id[i] === id)
			return Math.abs(snap.actors.posX[i] / 1024 - (x + 0.5)) < 1.5 && Math.abs(snap.actors.posY[i] / 1024 - (y + 0.5)) < 1.5
		return false
	}, { id: hero.id, ...target }, 'the chronoshifted tank at its destination', 15000)
	// Chronoshifted, the tank carries its return timer (actors.status kind 2, allies only).
	const returning = await waitFor(id => {
		const st = globalThis.steelseed.ctx.snapshot?.actorStatus
		if (!st) return false
		for (let r = 0; r < st.count; r++) {
			const o = st.byteOffset + r * 12
			if (st.view.getUint32(o, true) === id && st.view.getUint8(o + 4) === 2) return { remaining: st.view.getUint16(o + 6, true), total: st.view.getUint16(o + 8, true) }
		}
		return false
	}, hero.id, 'the chronoshift return timer', 10000).then(h => h.jsonValue())
	assert.ok(returning.remaining > 0 && returning.remaining <= returning.total, `return timer ${JSON.stringify(returning)}`)
	const chronoOrder = await gate(() => globalThis.__orders.find(o => o.extraCell !== null))
	assert.ok(chronoOrder?.extraCell, 'Chronoshift went out without its source cell')
	await page.screenshot({ path: join(SHOTS, '3-chronoshift.png') })

	// The dev order trace: a right-click move of the friend logs pointer, cell, preview, the order,
	// OpenRA's reply and the first frame the tank moves.
	{
		const friendAt = (await gate(id => [...globalThis.__gate.own('2tnk'), ...globalThis.__gate.own('1tnk'), ...globalThis.__gate.own('3tnk'), ...globalThis.__gate.own('jeep')].find(a => a.id === id), friend.id))
		await gate(({ x, y }) => globalThis.__gate.focus(x, y), friendAt); await page.waitForTimeout(1000)
		await clickCell(Math.floor(friendAt.x), Math.floor(friendAt.y))
		const dest = await gate(({ x, y }) => globalThis.__gate.cellPx(x, y), { x: Math.floor(friendAt.x) + 3, y: Math.floor(friendAt.y) + 2 })
		await page.mouse.move(dest.x, dest.y); await page.waitForTimeout(250)
		await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' })
		const deadline = Date.now() + 15000
		while (traces.length === 0 && Date.now() < deadline) await page.waitForTimeout(200)
		assert.ok(traces.length > 0, 'no [ordertrace] record for the right-click order')
		const record = JSON.parse(traces[0].slice('[ordertrace] '.length))
		for (const field of ['pointer', 'canvasCss', 'dpr', 'cell', 'preview', 'subjects', 'reply', 'firstResponse'])
			assert.ok(field in record, `ordertrace record lacks ${field}: ${traces[0].slice(0, 300)}`)
		assert.match(record.reply, /^ok/, `the traced order was refused: ${record.reply}`)
		assert.ok(record.firstResponse?.afterTicks >= 0 && record.firstResponse.subjectCell, `no first response: ${JSON.stringify(record.firstResponse)}`)
	}

	// Guard: select the friend, G, click the hero. The UI sends Guard on the hero.
	const heroNow = (await gate(id => [...globalThis.__gate.own('2tnk'), ...globalThis.__gate.own('1tnk'), ...globalThis.__gate.own('3tnk'), ...globalThis.__gate.own('jeep')].find(a => a.id === id), hero.id))
	await gate(({ x, y }) => globalThis.__gate.focus(x, y), heroNow); await page.waitForTimeout(1200)
	const friendNow = (await gate(id => [...globalThis.__gate.own('2tnk'), ...globalThis.__gate.own('1tnk'), ...globalThis.__gate.own('3tnk'), ...globalThis.__gate.own('jeep')].find(a => a.id === id), friend.id))
	await clickCell(Math.floor(friendNow.x), Math.floor(friendNow.y))
	await page.keyboard.press('g'); await page.waitForTimeout(150)
	await clickCell(Math.floor(heroNow.x), Math.floor(heroNow.y))
	await waitFor(id => globalThis.__orders.some(o => o.orderString === 'Guard' && o.targetActorId === id && /^ok/.test(o.reply ?? '')), hero.id, 'an accepted Guard order on the hero', 5000)
	await page.screenshot({ path: join(SHOTS, '4-guard.png') })

	// Nuke at open ground ten cells north of the yard; the Atomic arrives and fx starts its cloud.
	const strike = { x: Math.floor(fact.x), y: Math.floor(fact.y) - 10 }
	await gate(({ x, y }) => globalThis.__gate.focus(x + 0.5, y + 0.5), strike); await page.waitForTimeout(1200)
	await pressPower(nukeKey)
	await clickCell(strike.x, strike.y)
	await waitFor(k => !globalThis.__gate.power(k)?.ready, nukeKey, 'the nuke charge to restart', 10000)
	// OpenRA's beacon over the target, while the missile flies, and the host's launch record.
	const beaconUp = () => [...document.querySelectorAll('svg path')].some(p => p.getAttribute('fill') === 'rgba(255,86,64,0.85)' && p.style.display !== 'none')
	await waitFor(beaconUp, undefined, 'the nuke beacon over its target', 5000)
	const launch = await waitFor(() => (globalThis.steelseed.ctx.supportPowers?.()?.launches ?? []).find(l => l.allied) ?? false, undefined, 'the launch reported from the missile', 10000).then(h => h.jsonValue())
	assert.ok(launch.beaconTicks > 0 && (launch.targetX !== 0 || launch.targetY !== 0), `launch ${JSON.stringify(launch)}`)
	await page.screenshot({ path: join(SHOTS, '5-nuke-beacon.png') })
	// fx starts the staged cloud from the Atomic's own impact event (weapon identity, M1).
	await waitFor(() => globalThis.steelseed.ctx.get('fx').lastNukeAt > -1e8, undefined, 'the Atomic detonation in fx', 60000)
	assert.equal(await gate(beaconUp), false, 'the beacon must be gone by the detonation (BeaconRemoveAdvance)')
	await page.waitForTimeout(1500)
	await page.screenshot({ path: join(SHOTS, '5-nuke.png') })

	const orders = await gate(() => globalThis.__orders.map(o => `${o.orderString}→${(o.reply ?? '').slice(0, 30)}`))
	assert.deepEqual(errors, [], 'page errors during the gate')
	console.log(`supportpoweruigate: orders ${JSON.stringify(orders)}`)
	console.log(`supportpoweruigate: PASS — panel READY for ${powers.length} powers; Iron Curtain, Chronoshift (source+destination) and the Atomic all confirmed by OpenRA; Guard accepted. Screenshots in ${SHOTS}`)
} finally {
	await browser?.close()
	await preview?.close?.()
}
