#!/usr/bin/env node
// Does an object that is on screen STAY on screen from one frame to the next?
//
// The human, three times: "on zoom levels the scenery flickers, some are shown some are not
// even when they are there... the rendering of the assets coming into view also goes wrong,
// they are flickering... it happens on large maps like jungle law."
//
// `Renderer.applyBudget` admits draw items in descending screen-coverage order until the
// triangle budget would be crossed, and it USED to charge each item for its geometry and its
// shadow together. The shadow caster set is the cascade sphere rather than the camera frustum,
// so on Jungle Law with the map revealed the shadow charge measured 56.3M triangles at EVERY
// zoom against a 12M budget, while the geometry the camera can see ran 0.6M to 15.9M. That one
// term evicted whole draw items — a house, a tank, a line of tank traps — and because the
// admission is a greedy knapsack over an order that moves with the camera, WHICH items it
// evicted changed frame to frame. Measured on the pre-fix bundle: 28 single-frame dropouts
// across 14 of 42 frames at maximum zoom-out, 4 at moderate zoom, scaling with zoom exactly as
// reported.
//
// None of that was visible to `render.stats.dropped`, which counts submit()-time rejections
// only and read ZERO throughout. So this gate does not sample a counter. It tracks the IDENTITY
// of every draw item across consecutive frames, because a per-frame aggregate cannot prove that
// a transient happened.
//
// Two assertions, both of which fail against the pre-fix bundle:
//
//   1. NO SINGLE-FRAME DROPOUT. An item drawn in frame f-1 and in frame f+1, and still wanted
//      in frame f, must be drawn in frame f. That is the flicker, stated exactly.
//   2. GEOMETRY OUTRANKS SHADOW. If the frame had to withhold any object at all, then it must
//      not still have been paying for a shadow. A missing shadow is a smaller lie than a
//      missing object, and unlike a missing object it does not blink.
//
// Usage: node tools/drawstabilitygate.mjs [--port=8489] [--map='Jungle Law'] [--quality=low]
//        [--url=http://127.0.0.1:PORT]   (never 8321: that is the human's live game)
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { stopChild } from './harness.mjs'

const TOOL = 'drawstabilitygate'
const arg = (name, fallback) => {
	const found = process.argv.find(a => a.startsWith(`--${name}=`))
	return found ? found.slice(name.length + 3) : fallback
}
const PORT = Number(arg('port', 8489))
const MAP = arg('map', 'Jungle Law')
// Calibrated 2026-09: the 90% precondition is unreachable at the high tier on any real
// map — a maximal battle (six players, heavy starts, full reveal, deployed yards) offers
// only ~2.3-3.1M of the 12M high budget (peak 25.8%), and no OpenRA scene approaches
// 10.8M on-screen triangles. At the LOW tier (2.5M) the same maximal battle offers ~92-124%
// of budget, so the admission decision genuinely bites and the stability asserts observe
// real pressure. The 0.9 precondition assert is unchanged.
const QUALITY = arg('quality', 'low')
const SUPPLIED = arg('url', null)
const GAME_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const APP_BUNDLE = resolve(GAME_ROOT, 'engine', 'bin-browser', 'AppBundle')
const SERVER = resolve(GAME_ROOT, 'engine', 'OpenRA.Browser', 'tests', 'server.mjs')
// The composed bundle, not the dev map: the defect is a property of a real match on a real
// OpenRA map with several hundred authored actors, and no dev fixture has those.
if (PORT === 8321) throw new Error(`${TOOL}: refusing port 8321 — that is the live game`)

const wait = ms => new Promise(r => setTimeout(r, ms))
let server = null
const base = SUPPLIED ?? `http://127.0.0.1:${PORT}`
if (SUPPLIED == null) {
	server = spawn(process.execPath, [SERVER, '--root', APP_BUNDLE, '--port', String(PORT)],
		{ cwd: resolve(GAME_ROOT, 'engine'), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
	server.stdout.on('data', () => {})
	server.stderr.on('data', d => process.stderr.write(`[${TOOL}/server] ${d}`))
	let up = false
	for (let i = 0; i < 200 && !up; i++) {
		try { const r = await fetch(`${base}/index.html`); await r.body?.cancel(); up = r.ok } catch { /* starting */ }
		if (!up) await wait(150)
	}
	if (!up) {
		await stopChild(server)
		throw new Error(`${TOOL}: ${APP_BUNDLE} did not serve at ${base} — publish the host first`)
	}
}

const browser = await chromium.launch({
	headless: true,
	args: ['--use-angle=metal', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--disable-gpu-sandbox'],
})
try {
	const page = await (await browser.newContext({ viewport: { width: 1512, height: 982 } })).newPage()
	page.on('pageerror', e => console.error('PAGEERROR', e.message))
	await page.goto(`${base}/steelseed/index.html?mode=game&platform=null&quality=${QUALITY}`,
		{ waitUntil: 'load', timeout: 120000 })
	await page.waitForFunction(() => globalThis.steelseed !== undefined && globalThis.steelseedBridge !== undefined,
		undefined, { timeout: 240000, polling: 200 })

	// The whole map revealed is the PRECONDITION, not the finding: with fog on and one idle
	// MCV the client sees 81 of 20,672 cells and nothing is ever over budget, so the gate
	// would pass against either policy. `explored`/`fog` are ordinary lobby options.
	const started = await page.evaluate(async mapTitle => {
		const app = globalThis.steelseed
		const cat = await app.ctx.session.getCatalog()
		if (!cat) return { error: 'the host published no skirmish catalogue' }
		const map = cat.maps.find(m => m.title === mapTitle)
		if (!map) return { error: `map '${mapTitle}' is not in the catalogue` }
		// Every bot-capable slot takes a bot (Jungle Law exposes six playable slots). The
		// budget precondition below needs the visible set to OFFER on the order of the
		// whole triangle budget; a two-player start leaves the offered geometry under 90%
		// of it even with the map revealed, and the gate fails its own precondition
		// instead of the product. A full six-player field is the population the flicker
		// was reported on ("large maps like jungle law" in multiplayer).
		const slots = map.slots.map((s, i) => ({
			slot: s.id, kind: i === 0 ? 'human' : (s.allowBots ? 'bot' : 'open'),
			botType: i > 0 && s.allowBots ? (map.bots[0]?.id ?? undefined) : undefined,
			faction: s.defaults.faction, color: map.colors[i % map.colors.length], team: 0, spawn: 0,
		}))
		const status = app.ctx.session.startSkirmish({
			schemaVersion: 1, transport: 'local', mapUid: map.uid, gameSpeed: cat.defaultGameSpeed,
			randomSeed: 104729,
			local: { slot: slots[0].slot, name: 'Gate', faction: slots[0].faction, color: slots[0].color, team: 0, spawn: 0 },
			slots, options: { explored: 'True', fog: 'False', startingunits: 'heavy' },
		})
		return { title: map.title, bounds: map.bounds, status }
	}, MAP)
	assert.ok(!started.error, `${TOOL}: ${started.error}`)
	assert.notEqual(started.status.status, 'error', `${TOOL}: ${started.status.userMessage}`)
	await page.waitForFunction(() => (globalThis.steelseed.ctx.snapshot?.actors?.count ?? 0) > 0,
		undefined, { timeout: 240000, polling: 250 })
	// Give the five AIs time to deploy their MCVs into construction yards; deployed
	// yards and first buildings are a large share of the offered triangle load.
	await wait(20000)

	// The per-item census. Read inside endFrame, which is the last moment the frame's own
	// budget decision still exists: it clears `items` and `itemCount` immediately after.
	await page.evaluate(() => {
		const render = globalThis.steelseed.ctx.get('render')
		const LOD_LEVELS = 3
		const meshIds = new WeakMap()
		let nextMeshId = 1
		const log = []
		globalThis.__drawStability = { log, on: false }
		const original = render.endFrame
		render.endFrame = function () {
			if (globalThis.__drawStability.on) {
				const items = []
				for (let it = 0; it < this.itemCount; it++) {
					const item = this.items[it]
					if (!item) continue
					let id = meshIds.get(item.mesh)
					if (id === undefined) { id = nextMeshId++; meshIds.set(item.mesh, id) }
					let main = 0
					let shadow = 0
					for (let l = 0; l < LOD_LEVELS; l++) {
						main += this.itemMainCount[it * LOD_LEVELS + l]
						shadow += this.itemShadowCount[it * LOD_LEVELS + l]
					}
					// `surfaceSet` alone is shared by many meshes, so the mesh handle carries
					// the identity and the surface set only makes the report readable.
					items.push({ key: `${item.surfaceSet}#${id}`, main, shadow, included: this.itemIncluded[it] })
				}
				log.push({
					triangles: this.stats.triangles, budget: this.budgetTriangles,
					drawCalls: this.stats.drawCalls, drawBudget: this.budgetDrawCalls,
					submitDropped: this.stats.dropped, camY: this.camera.position[1], items,
				})
			}
			return original.call(this)
		}
	})

	const rows = []
	let notch = 0
	for (const target of [3, 0, -3, -6, -10]) {
		await page.evaluate(n => globalThis.steelseed.ctx.get('camera').zoomByNotches(n), target - notch)
		notch = target
		await wait(1800)
		await page.evaluate(() => { globalThis.__drawStability.log.length = 0; globalThis.__drawStability.on = true })
		// Pan while sampling. The report is about what happens AS THE CAMERA MOVES; a still
		// camera hides an order-dependent decision completely.
		for (let i = 0; i < 18; i++) {
			await page.evaluate(() => globalThis.steelseed.ctx.get('camera').panByView(0.010, 0.007))
			await wait(85)
		}
		const frames = await page.evaluate(() => { globalThis.__drawStability.on = false; return globalThis.__drawStability.log })
		assert.ok(frames.length >= 12, `${TOOL}: only ${frames.length} frames at zoom ${target}`)

		const drawn = frames.map(f => new Set(f.items.filter(i => i.main > 0 && i.included).map(i => i.key)))
		const wanted = frames.map(f => new Set(f.items.filter(i => i.main > 0).map(i => i.key)))
		let dropouts = 0
		const dropoutFrames = new Set()
		const worst = new Map()
		for (let f = 1; f < frames.length - 1; f++)
			for (const key of wanted[f])
				if (!drawn[f].has(key) && drawn[f - 1].has(key) && drawn[f + 1].has(key)) {
					dropouts++
					dropoutFrames.add(f)
					worst.set(key, (worst.get(key) ?? 0) + 1)
				}

		// Assertion 2's evidence: a frame that withheld an object while still paying for a
		// shadow spent the budget in the wrong order.
		let inverted = 0
		let invertedShadows = 0
		for (const f of frames) {
			const withheld = f.items.filter(i => i.main > 0 && !i.included).length
			if (withheld === 0) continue
			const stillShadowed = f.items.filter(i => i.included && i.shadow > 0).length
			if (stillShadowed > 0) { inverted++; invertedShadows = Math.max(invertedShadows, stillShadowed) }
		}
		const excluded = frames.map(f => f.items.filter(i => i.main > 0 && !i.included).length)
		rows.push({
			target, camY: frames[0].camY, frames: frames.length, dropouts, dropoutFrames: dropoutFrames.size,
			excludedMean: excluded.reduce((a, b) => a + b, 0) / frames.length, excludedMax: Math.max(...excluded),
			triangles: Math.max(...frames.map(f => f.triangles)), budget: frames[0].budget,
			drawCalls: Math.max(...frames.map(f => f.drawCalls)), drawBudget: frames[0].drawBudget,
			submitDropped: Math.max(...frames.map(f => f.submitDropped)),
			items: Math.max(...frames.map(f => f.items.length)),
			shadowless: Math.max(...frames.map(f => f.items.filter(i => i.included && i.shadow === 0).length)),
			inverted, invertedShadows,
			offenders: [...worst].sort((a, b) => b[1] - a[1]).slice(0, 5),
		})
	}

	for (const r of rows)
		console.log(`${TOOL}: zoom ${String(r.target).padStart(3)} camY ${r.camY.toFixed(0).padStart(4)} m, ` +
			`${r.frames} frames, ${r.items} items — ${r.triangles.toLocaleString()}/${r.budget.toLocaleString()} triangles, ` +
			`${r.drawCalls}/${r.drawBudget} draw calls, submit() dropped ${r.submitDropped}, ` +
			`withheld objects ${r.excludedMean.toFixed(1)}/frame (worst ${r.excludedMax}), ` +
			`objects without a shadow ${r.shadowless}, single-frame dropouts ${r.dropouts} on ${r.dropoutFrames} frames` +
			(r.offenders.length ? ` [${r.offenders.map(([k, v]) => `${k}x${v}`).join(' ')}]` : ''))

	// PRECONDITION. Over budget is what makes the admission decision bite; a frame with room
	// to spare admits everything under either policy and this gate would prove nothing.
	const peak = Math.max(...rows.map(r => r.triangles / r.budget))
	assert.ok(peak >= 0.9,
		`${TOOL}: the scene never reached 90% of the triangle budget (peak ${(peak * 100).toFixed(1)}%), ` +
		'so nothing was ever withheld and this gate proves nothing. Check the map has its actors.')

	const totalDropouts = rows.reduce((a, r) => a + r.dropouts, 0)
	const totalInverted = rows.reduce((a, r) => a + r.inverted, 0)
	// 1. THE FLICKER, STATED EXACTLY. Not a count, not a mean — an object that was there,
	//    then was not, then was there again, while the frame still wanted to draw it.
	assert.equal(totalDropouts, 0,
		`${TOOL}: ${totalDropouts} object(s) vanished for exactly one frame and came back — ` +
		`${rows.map(r => `zoom ${r.target}: ${r.dropouts}`).join(', ')}. That is the flicker.`)
	// 2. Spend order. A frame is only allowed to withhold an object once it has stopped paying
	//    for shadows; the reverse means a shadow evicted the thing casting it.
	assert.equal(totalInverted, 0,
		`${TOOL}: ${totalInverted} frame(s) withheld an object while still drawing shadows ` +
		`(up to ${Math.max(...rows.map(r => r.invertedShadows))} shadowed objects in one such frame). ` +
		'Charge geometry before shadows: a missing shadow does not blink, a missing object does.')
	console.log(`${TOOL}: PASS — ${rows.reduce((a, r) => a + r.frames, 0)} frames over five zoom levels on ` +
		`'${started.title}' (${started.bounds.width}x${started.bounds.height}), peak ${(peak * 100).toFixed(1)}% of the ` +
		'triangle budget, and not one object left the screen for a frame and came back')
} finally {
	await browser.close()
	if (server) await stopChild(server)
}
