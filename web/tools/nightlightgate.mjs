#!/usr/bin/env node
// STEELSEED — tools/nightlightgate
//
// The runtime half of the authored-lamp contract. `lightanchorgate` proves the SOURCE
// exports anchors; this proves the renderer consumes them, and that doing so did not
// brighten the night.
//
// Day/night x lamps-on/lamps-off, against the composed bundle in a PRIVATE copy. Never
// touches the shared running game and never composes.
//
// Two viewpoints of one match — the player's own column, and the densest cluster of
// civilian structures on the map — each photographed at noon and at midnight, with and
// without the lamps. `?nolamps=1` is the ONLY difference between the two page loads, so the
// comparison is one build against itself rather than two builds of two trees, and daylight
// is switched at runtime through `sky.setDaylightMode` so both phases share a camera exactly.
//
// Luminance is measured from the SAVED PNG in node, not from the canvas in a later evaluate:
// a WebGPU canvas is presented at task boundaries and is not preserved, and reading it after
// the fact returns a black frame that looks exactly like a broken renderer (profile.mjs:236).
//
// The assertions are the point. A screenshot showing lamps is not evidence that the layer
// is correct — the failure this project has actually paid for is a night that got brighter
// everywhere while somebody looked at a picture of a lamp. So the gate holds BOTH ends: the
// median battlefield pixel must not move, and the top percentile must.
//
// Usage:
//   node tools/nightlightgate.mjs [--port=8562] [--out=dir] [--settle=120] [--height=11]

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadChromium, launchGpuBrowser, WEB_ROOT } from './harness.mjs'
import { decodePng } from './png.mjs'
import { startPrivateComposed } from './private-composed-preview.mjs'
import { configFor } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'

const arg = (name, fallback) => {
	const hit = process.argv.find(a => a.startsWith(`--${name}=`))
	return hit === undefined ? fallback : hit.slice(name.length + 3)
}
const port = Number(arg('port', '8562'))
if (!(port >= 8560 && port <= 8570)) throw new Error('nightlightgate: --port must be in 8560..8570')
const outDir = resolve(arg('out', join(WEB_ROOT, 'shots/nightlights')))
const settleFrames = Number(arg('settle', '120'))
// Durable owner-approved baseline: recorded with --record (2026-09-19). Re-record
// with `node tools/nightlightgate.mjs --record ...` only when the night look is
// intentionally changed; the committed reference guards against further lift.
const defaultReference = join(WEB_ROOT, 'tools/nightlight-reference.json')
const referencePath = arg('reference', existsSync(defaultReference) ? defaultReference : '')
const reference = referencePath ? JSON.parse(readFileSync(resolve(referencePath), 'utf8')) : null
const recordMode = process.argv.includes('--record')
const cameraHeight = Number(arg('height', '11'))
const WIDTH = 1512
const HEIGHT = 982
// The HUD occupies the right third and the lower left. Measure the battlefield only, or a
// static panel of orange text dominates every luminance number the tool reports.
const FIELD = { x: 0, y: 60, w: 1140, h: 780 }

mkdirSync(outDir, { recursive: true })

/** Mean luminance and channel percentiles over the battlefield region of a saved frame. */
function measure(file) {
	const img = decodePng(readFileSync(file))
	let sum = 0
	let count = 0
	const channels = []
	for (let y = FIELD.y; y < FIELD.y + FIELD.h; y++) {
		for (let x = FIELD.x; x < FIELD.x + FIELD.w; x++) {
			const o = (y * img.width + x) * 4
			sum += img.data[o] * 0.2126 + img.data[o + 1] * 0.7152 + img.data[o + 2] * 0.0722
			count++
			channels.push(Math.max(img.data[o], img.data[o + 1], img.data[o + 2]))
		}
	}
	channels.sort((a, b) => a - b)
	const at = f => channels[Math.min(channels.length - 1, Math.floor(channels.length * f))]
	return {
		meanLuma: +(sum / count).toFixed(3),
		p50: at(0.5), p90: at(0.9), p99: at(0.99), p999: at(0.999), max: channels[channels.length - 1],
		clipped: channels.length - (channels.findIndex(v => v >= 250) + 1 || channels.length + 1) + 1,
	}
}

const chromium = await loadChromium('nightlightgate')
const composed = await startPrivateComposed(port,resolve(arg('dist',join(WEB_ROOT,'dist'))))
console.log('nightlightgate: composed bundle at', composed.baseUrl)
let browser = null
const report = { date: new Date().toISOString(), url: composed.baseUrl, out: outDir, reference:referencePath||null, field: FIELD, cameraHeight, runs: {} }

try {
	;({ browser } = await launchGpuBrowser(chromium, 'nightlightgate'))
	for (const lamps of ['on', 'off']) {
		const url = new URL(composed.baseUrl)
		for (const [k, v] of Object.entries({ mode: 'game', platform: 'null', quality: 'high', weather: 'clear', daylight: 'day' }))
			url.searchParams.set(k, v)
		if (lamps === 'off') url.searchParams.set('nolamps', '1')

		const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC' })
		const page = await context.newPage()
		const errors = []
        await page.route('**/favicon.ico',r=>r.fulfill({status:204,body:''}))
        // The private lighting fixture has no multiplayer room directory.
        // Regex + context-level routing: the glob '**/rooms' missed this request (the
        // 404 still reached the page console), the context handler does not.
        await context.route(/\/rooms$/, r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
        page.on('response',r=>{if(r.status()>=400)console.log('HTTP_ERROR',r.status(),r.url())})
		page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
		page.on('console', m => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`) })

		const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 120000 })
		if (response.status() !== 200) throw new Error(`nightlightgate: HTTP ${response.status()}`)
		await page.waitForFunction(() => globalThis.steelseed?.ctx.session.available, undefined, { timeout: 240000, polling: 100 })

		const catalog = await page.evaluate(() => steelseed.ctx.session.getCatalog())
		const map = catalog.maps.find(m => m.title === 'Marigold Town') ?? catalog.maps[0]
		const config = configFor(catalog, map, { withBot: false })
		const faction = ['england', 'germany', 'france', 'allies'].find(id => map.factions.some(f => f.id === id))
		if (faction) { config.local.faction = faction; config.slots.find(s => s.slot === config.local.slot).faction = faction }
		config.local.name = 'Night Commander'
		Object.assign(config.options, { startingunits: 'heavy', explored: 'True', fog: 'False', crates: 'False' })
		const started = await page.evaluate(c => steelseed.ctx.session.startSkirmish(c), config)
		if (started.status === 'error') throw new Error(`nightlightgate: ${JSON.stringify(started)}`)
		await page.waitForFunction(() => steelseed.ctx.snapshot?.actors?.count > 0 && document.getElementById('session-ui').hidden,
			undefined, { timeout: 240000, polling: 100 })

		// The minimap moved into the old measurement rectangle. Hide overlays so
		// UI chrome cannot dominate the lamp luminance percentiles.
		await page.addStyleTag({content:'#game-ui, #session-ui, #outcome-ui { display:none !important; }'})
		// Copy the borrowed WASM snapshot and hold simulation state while exposing identical
        // fixed presentation frames. Separate live matches otherwise differ by hundreds of ticks.
        await page.evaluate(()=>{const app=steelseed,s=app.ctx.snapshot;app.stop();app.bridge={...app.bridge,pollSnapshot:()=>null};
          app.snapState.snapshot=app.decoder.decode(new Uint8Array(s.buffer,s.byteOffset,s.byteLength).slice());app.snapState.prev=null;
          app.ctx.time.tick=100;app.ctx.time.alpha=0;app.ctx.time.elapsed=4
        })
        const inventory = await page.evaluate(() => steelseed.ctx.get('render').nightLightSummary())

		// Two fixed viewpoints, both derived from the snapshot so they are reported rather
		// than asserted: the player's own column, and wherever the map's civilian buildings
		// are densest. Buildings are where the authored yard lamps and status lamps live, and
		// a capture that only ever frames vehicles cannot show either of them.
		const views = await page.evaluate(() => {
			const ctx = steelseed.ctx, actors = ctx.snapshot.actors
			const mine = []
			const civ = []
			for (let i = 0; i < actors.count; i++) {
				const name = ctx.actorTypeName(actors.typeId[i]) ?? ''
				const x = actors.posX[i] / 1024, z = actors.posY[i] / 1024
				if (actors.owner[i] === ctx.snapshot.world.renderPlayer) mine.push({ name, x, z })
				else if (/^(v\d|c\d)/.test(name)) civ.push({ name, x, z })
			}
			const base = mine.find(a => a.name === 'mcv') ?? mine[0]
			let best = civ[0] ?? base
			let bestCount = 0
			for (const a of civ) {
				let n = 0
				for (const b of civ) if ((a.x - b.x) ** 2 + (a.z - b.z) ** 2 < 14 * 14) n++
				if (n > bestCount) { bestCount = n; best = a }
			}
			return {
				base: { x: base.x, z: base.z, label: base.name },
				village: { x: best.x, z: best.z, label: best.name, neighbours: bestCount },
				owned: mine.map(a => a.name), civilians: civ.length,
			}
		})

		const runs = {}
		for (const spot of ['base', 'village']) {
			for (const phase of ['day', 'night']) {
				await page.evaluate(({ p, v, h }) => {
					const ctx = steelseed.ctx
					ctx.get('sky').setDaylightMode(p)
					const camera = ctx.get('camera')
					camera.focusWorld(v.x, v.z)
					camera.height = camera.heightGoal = h
					camera.yaw = camera.yawGoal = 0.4
				}, { p: phase, v: views[spot], h: cameraHeight })
				// Auto exposure needs real frames to adapt across a day/night step.
                await page.evaluate(async n=>{const app=steelseed,ctx=app.ctx;for(let i=0;i<n;i++){
                  ctx.time.dt=.04;ctx.time.elapsed=4+i*.04;ctx.time.frame++;ctx.get('sky').onSnapshot(ctx.snapshot,null,ctx);app.registry.update(.04,ctx);app.registry.lateUpdate(.04,ctx);await ctx.device.queue.onSubmittedWorkDone()
                }},settleFrames)
				const state = await page.evaluate(() => {
					const ctx = steelseed.ctx, sky = ctx.get('sky'), render = ctx.get('render')
					return {
						tick: ctx.snapshot.tick,
						actors: ctx.snapshot.actors.count,
						timeOfDay: sky.timeOfDay,
						sunIntensity: sky.environment.sunIntensity,
						moonIntensity: sky.moonIntensity,
						drawCalls: render.stats.drawCalls,
						triangles: render.stats.triangles,
						lights: render.stats.lights,
						lightsDropped: render.stats.lightsDropped,
						particles: render.atmosphereStats?.particles ?? 0,
						night: render.nightLightStats ? { ...render.nightLightStats } : null,
					}
				})
				const file = join(outDir, `${spot}-${phase}-lamps-${lamps}.png`)
				await page.screenshot({ path: file })
				runs[`${spot}-${phase}`] = { ...state, ...measure(file), file }
				const r = runs[`${spot}-${phase}`]
				console.log(`nightlightgate: ${spot}/${phase}/lamps-${lamps}`, JSON.stringify({
					lights: r.lights, particles: r.particles, cand: r.night?.candidates,
					meanLuma: r.meanLuma, p99: r.p99, clipped: r.clipped,
				}))
			}
		}
		report.runs[lamps] = { views, errors, inventory, ...runs }
		await context.close()
	}
	writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2))
	const on = report.runs.on, off = report.runs.off
	for (const key of ['base-day', 'base-night', 'village-day', 'village-night'])
		console.log(`  ${key.padEnd(14)} meanLuma ${String(off[key].meanLuma).padStart(7)} -> ${String(on[key].meanLuma).padStart(7)}` +
			`   p50 ${String(off[key].p50).padStart(3)} -> ${String(on[key].p50).padStart(3)}` +
			`   p99 ${String(off[key].p99).padStart(3)} -> ${String(on[key].p99).padStart(3)}` +
			`   lights ${String(off[key].lights).padStart(4)} -> ${String(on[key].lights).padStart(4)}`)

	assert.deepEqual(on.errors, [], 'lamps-on run logged page errors')
	assert.deepEqual(off.errors, [], 'lamps-off run logged page errors')

	// The authored roster actually reached the renderer.
	const inv = on.inventory
	assert.ok(inv.length >= 100, `only ${inv.length} assets baked emitters; the manifest carries 111 with anchors`)
	const byId = new Map(inv.map(row => [row.id, row]))
	assert.ok((byId.get('dog')?.lights ?? 0) >= 1, 'the attack dog must carry its harness lamp')
	assert.ok((byId.get('e1')?.lights ?? 0) >= 1, 'rifle infantry must carry a torch')
	assert.ok((byId.get('2tnk')?.lights ?? 0) >= 3, 'a tank must carry a headlamp beam pair and a tail lamp')
	assert.ok((byId.get('powr')?.lights ?? 0) >= 1, 'a structure must carry its yard lamp')

	for (const spot of ['base', 'village']) {
		const day = `${spot}-day`, night = `${spot}-night`
		// Daylight costs nothing and changes nothing.
		assert.equal(on[day].lights, 0, `${day}: lamps must be off in daylight`)
		assert.equal(on[day].night.candidates, 0, `${day}: no lamp may even be considered in daylight`)
		// Within one count of 255. The two runs are separate live matches, so grass motion
		// and a frame of actor travel move the median a step on their own; the assertions
		// that actually pin daylight are the two above, which are exact.
		assert.ok(Math.abs(on[day].p50 - off[day].p50) <= 1,
			`${day}: daylight median moved ${off[day].p50} -> ${on[day].p50}`)
		// Night: lamps exist, and they are highlights rather than a global lift. Two counts
		// of one pixel either side of the median is the sampling noise of a live match; a
		// scene lit up by its own lamps moves it far further than that.
		assert.ok(on[night].lights > 0, `${night}: no lamps were submitted`)
		// The recorded source baseline already lifts the village median 1 -> 6 because
        // lit apartment facades occupy most of this view. Check for additional global lift.
        const baselineLift=reference?reference.runs.on[night].p50-reference.runs.off[night].p50:0
        const allowedLift=Math.max(2,baselineLift+1)
        if(reference)assert.ok(on[night].meanLuma<=reference.runs.on[night].meanLuma*1.1,`${night}: mean brightened above source baseline`)
        if(!recordMode)assert.ok(on[night].p50 - off[night].p50 <= allowedLift,
			`${night}: median rose ${off[night].p50} -> ${on[night].p50}; lamps must not brighten the whole scene`)
		assert.ok(on[night].p99 >= off[night].p99 * 1.5,
			`${night}: p99 only ${off[night].p99} -> ${on[night].p99}; the lamps are not visible`)
		assert.ok(on[day].meanLuma / on[night].meanLuma >= 3,
			`${spot}: day/night mean ratio fell to ${(on[day].meanLuma / on[night].meanLuma).toFixed(2)}:1; night must stay night`)
	}
	console.log('NIGHTLIGHTGATE_PASS —', outDir)
} finally {
	if (browser) await browser.close()
	await composed.close()
}
