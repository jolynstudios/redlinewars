// STEELSEED — a real match for gates and VFX scenarios (vfx.md Epic 9).
//
// The composed game in Chromium: the WASM simulation in its worker, the real renderer and HUD,
// every order through the bridge. An isolated particle demo cannot pass a scenario, so there
// is none here.
//
// The lobby's developer option ("cheats", hidden in the setup screen) is the one shortcut:
// DevAll gives all tech, fast build, fast charge, unlimited power and build anywhere. Scenarios
// then build, produce and fight in seconds. It changes no rule of how a weapon fires, flies or
// hits.
//
// Freeze frames. `freezeOn` stops the render loop inside the handler of the first matching
// event, so the frame that drew the event's effects stays on screen, and pauses the session so
// time does not run on. Effects age on simulation time ((tick + alpha) / 25), so `advance(ms)`
// steps both forward together. A video frame would be a race; this is the frame itself.
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchGpuBrowser, loadChromium } from './harness.mjs'
import { startPrivateComposed } from './private-composed-preview.mjs'
import { configFor } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'

export async function openLiveMatch({
	tool, port = 8499, viewport = { width: 1600, height: 900 }, deviceScaleFactor = 1, quality = 'ultra', mapTitle = 'Altercation',
	faction = 'england', startingUnits = 'heavy', options = {}, extraArgs = [], shots = join(tmpdir(), tool), params = '',
} = {}) {
	mkdirSync(shots, { recursive: true })
	const preview = await startPrivateComposed(port)
	const { browser } = await launchGpuBrowser(await loadChromium(tool), tool, extraArgs)
	const close = async () => { await browser?.close(); await preview?.close?.() }
	try {
		const context = await browser.newContext({ viewport, deviceScaleFactor })
		const page = await context.newPage()
		const errors = []
		page.on('pageerror', e => errors.push(`pageerror: ${e.message.slice(0, 200)}`))
		page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`console: ${m.text().slice(0, 200)}`) })
		await page.route('**/api/me', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"user":null}',
			headers: { 'access-control-allow-origin': new URL(preview.baseUrl).origin, 'access-control-allow-credentials': 'true' } }))
		await page.goto(`${preview.baseUrl}&quality=${quality}${params}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
		await page.waitForFunction(() => globalThis.steelseed?.ctx?.session?.available, undefined, { timeout: 180000, polling: 200 })

		const catalog = await page.evaluate(async () => await globalThis.steelseed.ctx.session.getCatalog())
		const map = catalog.maps.find(m => m.title === mapTitle) ?? catalog.maps.find(m => m.spawnPoints.length >= 2)
		const config = configFor(catalog, map, { withBot: true })
		if (!map.options.some(o => o.id === 'cheats')) throw new Error(`${map.title} has no developer option`)
		const human = map.slots[0]
		if (!human.locks.faction && map.factions.some(f => f.id === faction)) {
			config.local = { ...config.local, faction }
			const slot = config.slots.find(s => s.kind === 'human')
			if (slot) slot.faction = faction
		}
		Object.assign(config.options, {
			cheats: 'True', fog: 'False', explored: 'True', crates: 'False', startingunits: startingUnits,
			gamespeed: map.options.find(o => o.id === 'gamespeed')?.defaultValue ?? config.options.gamespeed, ...options,
		})
		const started = await page.evaluate(async c => await globalThis.steelseed.ctx.session.startSkirmish(c), config)
		if (started?.status === 'error') throw new Error(`start failed: ${started.code}: ${started.userMessage}`)
		await page.waitForFunction(() => globalThis.steelseed?.ctx?.snapshot?.actors?.count > 0 && document.getElementById('session-ui')?.hidden,
			undefined, { timeout: 180000, polling: 200 })
		await page.evaluate(installPageHelpers)

		const live = makeLive(page, shots)
		return { page, browser, errors, map, shots, close, ...live }
	} catch (error) {
		await close()
		throw error
	}
}

/** Runs in the page: orders as the HUD sends them, and the lookups scenarios need. */
function installPageHelpers() {
	const app = globalThis.steelseed, ctx = app.ctx
	const issue = ctx.issueOrder.bind(ctx)
	globalThis.__orders = []
	ctx.issueOrder = order => {
		const entry = { orderString: order.orderString, targetActorId: order.targetActorId ?? 0, targetCell: order.targetCell ?? null, extraCell: order.extraCell ?? null, reply: null }
		globalThis.__orders.push(entry)
		return issue(order).then(reply => (entry.reply = reply, reply))
	}
	const actorsWhere = test => {
		const snap = ctx.snapshot, out = []
		for (let i = 0; i < snap.actors.count; i++) {
			const type = ctx.actorTypeName(snap.actors.typeId[i])
			if (snap.actors.health[i] > 0 && test(snap, i, type))
				out.push({ id: snap.actors.id[i], type, owner: snap.actors.owner[i], x: snap.actors.posX[i] / 1024, y: snap.actors.posY[i] / 1024, health: snap.actors.health[i] })
		}
		return out
	}
	globalThis.__live = {
		issue,
		playerOrder: (orderString, extra = {}) => issue({ orderString, subjectIds: new Uint32Array(0), subjectCount: 0, ...extra }),
		unitOrder: (ids, orderString, extra = {}) => issue({ orderString, subjectIds: Uint32Array.from(ids), subjectCount: ids.length, ...extra }),
		own: type => actorsWhere((snap, i, t) => snap.actors.owner[i] === snap.world.renderPlayer && (type === undefined || t === type)),
		// relation: 0 self, 1 ally, 2 enemy, 3 neutral (the snapshot's player table).
		enemy: () => actorsWhere((snap, i) => snap.actors.owner[i] !== snap.world.renderPlayer && snap.players.some(p => p.id === snap.actors.owner[i] && p.relation === 2)),
		actor: id => actorsWhere((snap, i) => snap.actors.id[i] === id)[0] ?? null,
		buildable: name => {
			const snap = ctx.snapshot
			for (const q of snap.production) if (q.playerId === snap.world.renderPlayer)
				for (const item of q.items) if (ctx.actorTypeName(item.actorType) === name && (item.flags & 2) !== 0) return q.queueId
			return -1
		},
		readyQueue: name => {
			const snap = ctx.snapshot
			for (const q of snap.production) if (q.playerId === snap.world.renderPlayer)
				for (const item of q.items) if (ctx.actorTypeName(item.actorType) === name && (item.flags & 16) !== 0) return q.queueId
			return -1
		},
		surface: (x, y) => ctx.get('terrain').surfaceAt?.(x + 0.5, y + 0.5) ?? -1,
		water: (x, y) => ctx.get('terrain').waterHeightAt?.(x + 0.5, y + 0.5) ?? null,
		cellPx: (cx, cy, h = 0) => {
			const render = ctx.get('render'), terrain = ctx.get('terrain'), vp = render.camera.viewProj
			const x = cx + 0.5, z = cy + 0.5, y = terrain.heightAt(x, z) + h
			const w = vp[3] * x + vp[7] * y + vp[11] * z + vp[15]
			const rect = ctx.canvas.getBoundingClientRect()
			return { x: rect.left + ((vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / w * 0.5 + 0.5) * rect.width,
				y: rect.top + (0.5 - (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / w * 0.5) * rect.height, onScreen: w > 0 }
		},
		focus: (x, y) => ctx.get('camera').focusWorld(x, y),
		zoom: notches => ctx.get('camera').zoomByNotches(notches),
		rotate: radians => ctx.get('camera').rotateBy(radians),
		tilt: radians => ctx.get('camera').tiltBy(radians),
		daylight: mode => ctx.get('camera').setDaylightMode?.(mode),
		weather: preset => ctx.get('camera').setWeatherPreset?.(preset),
		paused: paused => ctx.session.setPaused(paused),
		tick: () => ctx.snapshot.tick,
		fx: () => ({ ...ctx.get('fx').stats }),
		powers: () => ctx.supportPowers?.()?.powers ?? [],
	}
}

function makeLive(page, shots) {
	const gate = (fn, arg) => page.evaluate(fn, arg)
	const waitFor = (fn, arg, what, timeout = 60000) =>
		page.waitForFunction(fn, arg, { timeout, polling: 100 }).then(h => h.jsonValue()).catch(() => { throw new Error(`timed out waiting for ${what}`) })
	const live = {
		gate, waitFor,
		shot: name => page.screenshot({ path: join(shots, `${name}.png`) }),
		async devAll() {
			const reply = await gate(() => globalThis.__live.playerOrder('DevAll'))
			if (!/^ok/.test(reply)) throw new Error(`DevAll refused: ${reply}`)
		},
		async yard() {
			const [existing] = await gate(() => globalThis.__live.own('fact'))
			if (existing) return existing
			const [mcv] = await gate(() => globalThis.__live.own('mcv'))
			if (!mcv) throw new Error('no MCV and no construction yard')
			await gate(id => globalThis.__live.unitOrder([id], 'DeployTransform'), mcv.id)
			await waitFor(() => globalThis.__live.own('fact').length > 0, undefined, 'the construction yard')
			return (await gate(() => globalThis.__live.own('fact')))[0]
		},
		/** A structure through StartProduction and the UI's validated placement, spiralling out. */
		async build(name, { near, minRing = 4 } = {}) {
			const yard = near ?? await live.yard()
			await waitFor(n => globalThis.__live.buildable(n) >= 0, name, `${name} buildable`)
			const reply = await gate(n => globalThis.__live.playerOrder('StartProduction', { targetString: n, extraData: 1, queued: true }), name)
			if (!/^ok/.test(reply)) throw new Error(`StartProduction ${name}: ${reply}`)
			// An object, not the id: queue 0 is falsy and would read as "not yet".
			const { q: queueId } = await waitFor(n => { const q = globalThis.__live.readyQueue(n); return q >= 0 ? { q } : false }, name, `${name} ready to place`)
			for (let r = minRing; r < 40; r += 2)
				for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
					const result = await gate(({ q, n, x, y }) => globalThis.steelseed.ctx.placement.place({ queueId: q, actorType: n, cellX: x, cellY: y }),
						{ q: queueId, n: name, x: Math.floor(yard.x) + dx, y: Math.floor(yard.y) + dy })
					if (result?.issued) {
						await waitFor(n => globalThis.__live.own(n).length > 0, name, `${name} standing`)
						return (await gate(n => globalThis.__live.own(n), name)).at(-1)
					}
				}
			throw new Error(`${name} found no placement`)
		},
		/** Units from a factory, as the HUD asks for them. Resolves to the new actors. */
		async produce(name, count = 1) {
			const before = new Set((await gate(n => globalThis.__live.own(n), name)).map(a => a.id))
			await waitFor(n => globalThis.__live.buildable(n) >= 0, name, `${name} buildable`)
			const reply = await gate(({ n, c }) => globalThis.__live.playerOrder('StartProduction', { targetString: n, extraData: c, queued: true }), { n: name, c: count })
			if (!/^ok/.test(reply)) throw new Error(`StartProduction ${name}: ${reply}`)
			await waitFor(({ n, c, b }) => globalThis.__live.own(n).filter(a => !b.includes(a.id)).length >= c, { n: name, c: count, b: [...before] }, `${count} ${name}`, 120000)
			return (await gate(n => globalThis.__live.own(n), name)).filter(a => !before.has(a.id))
		},
		async moveTo(ids, x, y) {
			await gate(({ ids, x, y }) => globalThis.__live.unitOrder(ids, 'Move', { targetCell: { x, y } }), { ids, x, y })
		},
		/** Force-fire at a ground cell: OpenRA's own targeters pick the attack for the modifier. */
		async forceFire(ids, x, y) {
			return gate(({ ids, x, y }) => globalThis.__live.issue({ orderString: 'Contextual', contextual: true, subjectIds: Uint32Array.from(ids), subjectCount: ids.length, targetActorId: 0, targetCell: { x, y }, modifiers: 1 }), { ids, x, y })
		},
		async attack(ids, targetId) {
			return gate(({ ids, t }) => globalThis.__live.issue({ orderString: 'Contextual', contextual: true, subjectIds: Uint32Array.from(ids), subjectCount: ids.length, targetActorId: t, modifiers: 1 }), { ids, t: targetId })
		},
		async view(x, y, { zoom = 0, rotate = 0, tilt = 0, settleMs = 900 } = {}) {
			await gate(({ x, y, zoom, rotate, tilt }) => { const l = globalThis.__live; l.focus(x, y); if (zoom) l.zoom(zoom); if (rotate) l.rotate(rotate); if (tilt) l.tilt(tilt) }, { x, y, zoom, rotate, tilt })
			await page.waitForTimeout(settleMs)
		},
		/**
		 * Pause the session on the first matching simulation event and resolve with its tick.
		 * A fire matches by its shooter's actor id, a destruction by the dead actor's; an impact by
		 * its weapon name (each optional).
		 */
		async freezeOn(kind, { actorId = null, weapon = null } = {}, timeoutMs = 30000) {
			await gate(({ kind, actorId, weapon }) => {
				const app = globalThis.steelseed
				globalThis.__frozen = null
				const off = app.events.on(kind, e => {
					if (globalThis.__frozen) return
					const view = app.ctx.snapshot?.view
					if (!view) return
					// A fire and a destruction both open with their actor's id.
					if ((kind === 'sim:weapon:fire' || kind === 'sim:actor:destroyed') && actorId !== null && view.getUint32(e.offset, true) !== actorId) return
					if (kind === 'sim:projectile:impact' && weapon !== null &&
						app.ctx.actorTypeName(view.getUint16(e.offset + 22, true)).toLowerCase() !== weapon.toLowerCase()) return
					// Synchronous: this frame still updates and renders the event's effects, and no
					// frame follows. The session pause is asynchronous, so it only stops time from
					// running on while the capture is taken.
					globalThis.__frozen = { tick: app.ctx.snapshot.tick }
					app.stop()
					app.ctx.session.setPaused(true)
					off()
				})
			}, { kind, actorId, weapon })
			return waitFor(() => globalThis.__frozen?.tick ?? false, undefined, `a ${kind} event`, timeoutMs)
		},
		/**
		 * Run the game for `ticks` simulation ticks (25 per effect-second), then freeze it again.
		 * Ticks, not milliseconds: an unpause is asynchronous, so wall time does not say how far
		 * the effects aged.
		 */
		async advanceTicks(ticks) {
			const from = await gate(() => { const l = globalThis.__live; l.paused(false); globalThis.steelseed.start(); return l.tick() })
			await waitFor(t => globalThis.__live.tick() >= t, from + ticks, `${ticks} ticks`, 30000)
			await gate(() => { globalThis.steelseed.stop(); globalThis.__live.paused(true) })
			await page.waitForTimeout(80)
		},
		/** Hide the interface (the in-game Hide button) so a capture shows the whole view. */
		async hideHud() { await page.click('#hud-minimise'); await page.waitForTimeout(150) },
		async resume() { await gate(() => { globalThis.__live.paused(false); globalThis.steelseed.start() }) },
	}
	return live
}
