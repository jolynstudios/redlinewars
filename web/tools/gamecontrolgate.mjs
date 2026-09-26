#!/usr/bin/env node
// Real browser gestures through UI, authoritative OpenRA orders and the drawn Blender transform.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { launchGpuBrowser, loadChromium } from './harness.mjs'
import { configFor } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'
import { decodePng } from './png.mjs'

const TOOL = 'gamecontrolgate'
const vehicleName = process.argv.find(a => a.startsWith('--vehicle='))?.slice(10)
const label = process.argv.find(a => a.startsWith('--label='))?.slice(8) ?? ''
assert.ok(!label || /^[a-z0-9-]+$/.test(label), 'Simple artifact label required')
const meadowReview = process.argv.includes('--meadow')
const meadowDebug = process.argv.includes('--meadow-debug')
assert.ok(!meadowDebug || meadowReview, '--meadow-debug requires --meadow')
const meadowSource = meadowReview ? JSON.parse(readFileSync(resolve(import.meta.dirname, '../.forge/environment/props.json'))) : null
assert.ok(!vehicleName || vehicleName === '1tnk', 'Supported explicit vehicle fixture: 1tnk')
const tankSource = vehicleName ? JSON.parse(readFileSync(resolve(import.meta.dirname, '../.forge/blender/manifest.json'))).assets[vehicleName] : null
const out = resolve(import.meta.dirname, vehicleName ? '../.artifacts/visual-quality/tank-gameplay' : '../shots', label)
mkdirSync(out, { recursive: true })
const base = process.argv.find(a => a.startsWith('--url='))?.slice(6) ?? 'http://127.0.0.1:8123/steelseed/index.html'
const { browser } = await launchGpuBrowser(await loadChromium(TOOL), TOOL)
const page = await browser.newPage({ viewport: { width: 1512, height: 982 } })
const errors = []
page.on('pageerror', e => errors.push(e.message))
try {
	await page.goto(`${base}?mode=game&platform=null${vehicleName ? '&daylight=day&weather=clear&quality=medium' : ''}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
	await page.waitForFunction(() => globalThis.steelseed?.ctx.session.available, undefined, { timeout: 120000, polling: 100 })
	const catalog = await page.evaluate(() => steelseed.ctx.session.getCatalog())
	const map = catalog.maps.find(m => m.title === 'Marigold Town') ?? catalog.maps[0]
	const config = configFor(catalog, map, { withBot: false })
	config.options.startingunits = vehicleName ? 'heavy' : 'light'; config.options.explored = 'True'; config.options.fog = 'False'
	config.local.faction = 'england'; config.slots.find(s => s.slot === config.local.slot).faction = 'england'
	await page.evaluate(c => steelseed.ctx.session.startSkirmish(c), config)
	await page.waitForFunction(() => steelseed.ctx.snapshot?.actors?.count > 0 && document.getElementById('session-ui').hidden,
		undefined, { timeout: 120000, polling: 100 })
	const actors = await page.evaluate(() => {
		const { ctx } = steelseed, a = ctx.snapshot.actors
		const local = []
		for (let i = 0; i < a.count; i++) if (a.owner[i] === ctx.snapshot.world.renderPlayer)
			local.push({ id: a.id[i], type: ctx.actorTypeName(a.typeId[i]), x: a.posX[i] / 1024, z: a.posY[i] / 1024 })
		globalThis.controlOrders = []
		const issue = ctx.issueOrder.bind(ctx)
		ctx.issueOrder = o => {
			controlOrders.push({ order: o.orderString, contextual: o.contextual === true,
				subjects: Array.from(o.subjectIds ?? []).slice(0, o.subjectCount), cell: o.targetCell, actor: o.targetActorId })
			issue(o)
		}
		globalThis.controlMotion = []
		const units = ctx.get('units'), update = units.update.bind(units)
		let prior = new Map(), lastTick = -1
		units.update = (dt, c) => {
			update(dt, c)
			if (lastTick === c.snapshot.tick) return
			lastTick = c.snapshot.tick
			const a = c.snapshot.actors, next = new Map(), transform = new Float32Array(16), visual = { mesh: null, surfaceSet: '', playerColor: 0 }
			for (let i = 0; i < a.count; i++) {
				const record = { x: a.posX[i], z: a.posY[i], facing: a.facing[i] }, previous = prior.get(a.id[i])
				next.set(a.id[i], record)
				if (!previous || previous.facing !== record.facing || !units.captureActorVisual(a.id[i], transform, 0, visual)) continue
				const dx = record.x - previous.x, dz = record.z - previous.z, length = Math.hypot(dx, dz)
				if (length < 4) continue
				const forwardLength = Math.hypot(transform[0], transform[2])
				controlMotion.push({ id: a.id[i], type: c.actorTypeName(a.typeId[i]), facing: record.facing, dx, dz,
					dot: (dx * transform[0] + dz * transform[2]) / (length * forwardLength) })
			}
			prior = next
		}
		return local
	})
	const jeep = actors.find(a => vehicleName ? a.type === vehicleName : a.type === 'jeep' || a.type === '1tnk')
	const infantry = actors.find(a => a.type === 'e1')
	assert.ok(jeep && infantry, `light start must include vehicle and infantry: ${JSON.stringify(actors)}`)
	let tankBinding = null
	if (vehicleName) {
		tankBinding = await page.evaluate(name => {
			const b = steelseed.ctx.get('units').slotBuckets.get(name)
			return { triangles: b.mesh.lods.map(l => l.indexCount / 3), bounds: [Array.from(b.mesh.aabbMin), Array.from(b.mesh.aabbMax)],
				surface: b.item.surfaceSet, wheels: Array.from(b.rig.wheelRadii) }
		}, vehicleName)
		assert.equal(tankBinding.triangles[0], tankSource.triangles, 'Actual production tank must use the current saved-source mesh')
		assert.equal(tankBinding.surface, 'industrial-v1:1tnk')
		for (let side = 0; side < 2; side++) for (let axis = 0; axis < 3; axis++)
			assert.ok(Math.abs(tankBinding.bounds[side][axis] - tankSource.bounds[side][axis]) < 1e-5)
		assert.ok(tankBinding.wheels.every(r => Math.abs(r - .0896) < 1e-6))
	}
	let meadowBinding = null
	if (meadowReview) {
		meadowBinding = await page.evaluate(() => {
			const s = steelseed.ctx.get('units').scenery, p = s.pools.get('grass')
			return { cards: s.cardGrass, surface: p.item.surfaceSet, cutout: p.item.alphaCutout,
				vertices: p.item.mesh.lods.map(l => l.vertexCount), triangles: p.item.mesh.lods.map(l => l.indexCount / 3),
				count: p.count, budget: s.grassLimit }
		})
		assert.equal(meadowBinding.cards, true); assert.equal(meadowBinding.surface, 'meadow-v1'); assert.equal(meadowBinding.cutout, true)
		assert.deepEqual(meadowBinding.vertices, ['grass', 'grass-lod1', 'grass-lod2'].map(n => meadowSource.assets[n].vertices))
		assert.deepEqual(meadowBinding.triangles, [36, 24, 12]); assert.ok(meadowBinding.count > 0 && meadowBinding.count <= meadowBinding.budget)
	}
	const witnesses = []
	for (const [actor, delta] of [[jeep, [5, -5]], [infantry, [-5, 5]]]) {
		await page.evaluate(a => {
			const camera = steelseed.ctx.get('camera')
			camera.focusWorld(a.x, a.z)
		}, actor)
		await page.waitForTimeout(150)
		let point = await projectActor(actor.id)
		await page.mouse.click(point.x, point.y)
		await page.waitForFunction(id => steelseed.ctx.get('ui').selection.includes(id), actor.id, { timeout: 5000, polling: 50 })
		const cell = { x: Math.floor(actor.x) + delta[0], y: Math.floor(actor.z) + delta[1] }
		point = await projectCell(cell)
		const beforeOrders = await page.evaluate(() => controlOrders.length)
		await page.mouse.click(point.x, point.y, { button: 'right' })
		await page.waitForFunction(n => controlOrders.length > n, beforeOrders, { timeout: 5000, polling: 50 })
		const orders = await page.evaluate(n => controlOrders.slice(n), beforeOrders)
		assert.equal(orders.length, 1, `right click must issue one contextual command: ${JSON.stringify(orders)}`)
		assert.equal(orders[0].contextual, true)
		assert.deepEqual(orders[0].subjects, [actor.id])
		assert.deepEqual(orders[0].cell, cell)
		assert.equal(orders[0].actor, 0, 'empty ground must not be replaced with a distant actor target')
		await page.waitForFunction(a => {
			const actors = steelseed.ctx.snapshot.actors, i = Array.from(actors.id).indexOf(a.id)
			return i >= 0 && Math.hypot(actors.posX[i] / 1024 - a.x, actors.posY[i] / 1024 - a.z) > 2
		}, actor, { timeout: 20000, polling: 100 })
		const samples = await page.evaluate(id => controlMotion.filter(s => s.id === id), actor.id)
		assert.ok(samples.length >= 5, `moving ${actor.type} needs observed steady-facing samples`)
		const worst = Math.min(...samples.map(s => s.dot))
		assert.ok(worst > .98, `${actor.type} nose must follow actual OpenRA motion: ${JSON.stringify(samples.filter(s => s.dot < .98).slice(0, 5))}`)
		witnesses.push({ type: actor.type, id: actor.id, samples: samples.length, worstForwardDot: worst, target: cell })
		if (vehicleName && actor.type === vehicleName) await page.screenshot({ path: resolve(out, 'tank-moving.png') })
	}
	// Q/E gestures remain pure camera orbit, and clicking selected actors did not create orders.
	await page.mouse.move(756, 491)
	const orbitBefore = await page.evaluate(() => {
		const c = steelseed.ctx.get('camera'); return { target: Array.from(c.target), yaw: c.yaw, orders: controlOrders.length }
	})
	await page.keyboard.down('KeyE'); await page.waitForTimeout(1100); await page.keyboard.up('KeyE')
	await page.waitForTimeout(350)
	const orbitAfter = await page.evaluate(() => {
		const c = steelseed.ctx.get('camera'); return { target: Array.from(c.target), yaw: c.yaw, orders: controlOrders.length }
	})
	assert.ok(orbitAfter.yaw - orbitBefore.yaw > 1.4, 'E must rotate the camera')
	assert.ok(Math.hypot(orbitAfter.target[0] - orbitBefore.target[0], orbitAfter.target[2] - orbitBefore.target[2]) < .001,
		'orbit must keep its world focus fixed')
	assert.equal(orbitAfter.orders, orbitBefore.orders)
	assert.deepEqual(errors, [])
	await page.screenshot({ path: resolve(out, 'game-controls.png') })
	let meadowSceneReview = null
	if (meadowReview) {
		// Freeze this actual match snapshot for a presentation-only comparison. No world
		// edits, fake actors, lighting overrides or additional OpenRA orders are introduced.
		meadowSceneReview = await page.evaluate(async debug => {
			const app = steelseed; app.stop(); app.bridge = null
			const ctx = app.ctx, render = ctx.get('render'), units = ctx.get('units'), terrain = ctx.get('terrain')
			const grass = units.scenery.pools.get('grass'), submit = render.submit.bind(render), captures = []
			ctx.device.pushErrorScope('validation')
			let enabled = true; const originalDebug = render.debugView
			render.submit = item => { if (enabled || item !== grass.item) submit(item) }
			try {
				for (const view of debug ? [0, 1, 2, 3, 7, 10, 14] : [0]) for (const visible of [true, false]) {
					render.debugView = view
					enabled = visible; render.historyValid = false; render.frameIndex = 0
					for (let i = 0; i < Math.ceil(render.probes.total / render.probes.updatesPerFrame) + 66; i++) {
						terrain.update(0, ctx); units.update(0, ctx); render.lateUpdate(0, ctx)
					}
					const canvas = document.createElement('canvas'); canvas.width = ctx.canvas.width; canvas.height = ctx.canvas.height
					canvas.getContext('2d').drawImage(ctx.canvas, 0, 0)
					captures.push({ visible, view, png: canvas.toDataURL(), dropped: render.stats.dropped, triangles: render.stats.triangles })
				}
			} finally { render.submit = submit; render.debugView = originalDebug }
			await ctx.device.queue.onSubmittedWorkDone()
			const validation = await ctx.device.popErrorScope()
			if (validation) throw Error(validation.message)
			const sky = ctx.get('sky'), env = sky.environment
			return { frozenMatchTick: ctx.snapshot.tick, captures, environment: { timeOfDay: sky.timeOfDay,
				weatherKind: sky.weatherKind, wetness: env.wetness, sunDir: Array.from(env.sunDir), sunIntensity: env.sunIntensity,
				windStrength: env.windStrength, motionTime: env.motionTime },
				camera: { eye: Array.from(render.camera.position), view: Array.from(ctx.get('camera').view) },
				limitation: 'Frozen real-match presentation; grass-only submission defeat, not a live gameplay or performance comparison.' }
		}, meadowDebug)
		for (const capture of meadowSceneReview.captures) {
			assert.equal(capture.dropped, 0)
			const png = Buffer.from(capture.png.split(',')[1], 'base64'), decoded = decodePng(png)
			let lit = 0
			for (let p = 0; p < decoded.data.length; p += 4) if (decoded.data[p] + decoded.data[p + 1] + decoded.data[p + 2] > 30) lit++
			if (capture.view === 0) assert.ok(lit > decoded.width * decoded.height * .2, 'Reject blank/invalid canvas capture')
			writeFileSync(resolve(out, `meadow-${capture.visible ? 'present' : 'absent'}-${capture.view ? `debug-${capture.view}` : 'settled'}.png`), png)
			delete capture.png
		}
		assert.deepEqual(errors, [])
	}
	writeFileSync(resolve(out, 'game-controls.json'), JSON.stringify({ witnesses, tankBinding, sourceSha256: tankSource?.sourceSha256,
		meadowBinding, meadowSceneReview, meadowSourceSha256: meadowSource?.assets.grass.sourceSha256, orbitBefore, orbitAfter }, null, 2))
	console.log(`${TOOL}: PASS — left-click selects, right-click sends one OpenRA contextual order; ${witnesses.map(w => `${w.type} ${w.samples} moving frames (forward dot ${w.worstForwardDot.toFixed(6)})`).join('; ')}; E orbits without pan`)
} finally { await browser.close() }

async function projectActor(id) {
	return page.evaluate(id => {
		const ctx = steelseed.ctx, units = ctx.get('units'), m = new Float32Array(16), visual = { mesh: null, surfaceSet: '', playerColor: 0 }
		if (!units.captureActorVisual(id, m, 0, visual)) throw new Error(`actor ${id} not visible`)
		const mesh = visual.mesh, c = [0, 1, 2].map(k => (mesh.aabbMin[k] + mesh.aabbMax[k]) * .5)
		const world = [m[0] * c[0] + m[4] * c[1] + m[8] * c[2] + m[12],
			m[1] * c[0] + m[5] * c[1] + m[9] * c[2] + m[13], m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14]]
		const vp = ctx.get('render').camera.viewProj, [x, y, z] = world
		const w = vp[3] * x + vp[7] * y + vp[11] * z + vp[15], r = ctx.canvas.getBoundingClientRect()
		return { x: r.left + ((vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / w * .5 + .5) * r.width,
			y: r.top + (.5 - (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / w * .5) * r.height }
	}, id)
}
async function projectCell(cell) {
	return page.evaluate(cell => {
		const ctx = steelseed.ctx, x = cell.x + .5, z = cell.y + .5, y = ctx.get('terrain').heightAt(x, z)
		const vp = ctx.get('render').camera.viewProj, w = vp[3] * x + vp[7] * y + vp[11] * z + vp[15], r = ctx.canvas.getBoundingClientRect()
		return { x: r.left + ((vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / w * .5 + .5) * r.width,
			y: r.top + (.5 - (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / w * .5) * r.height }
	}, cell)
}
