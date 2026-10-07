#!/usr/bin/env node
// 800-unit scale gate on the composed AppBundle. Largest catalog map, 8 teams,
// live actor count at least 800. Degradation is a failure: render scale stays 1
// and preset extras stay on. The visible cadence is the requestAnimationFrame interval.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { configFor } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'

const base = process.env.STEELSEED_URL ?? 'http://127.0.0.1:8080/steelseed/index.html?mode=game&platform=null&quality=dynamic'

function pct(xs, p) {
	const s = [...xs].sort((a, b) => a - b)
	// rAF deltas are timestamp subtractions. 8.3 ms lands as 8.30000000000291, which
	// fails a raw <= against the decimal literal. A microsecond is inside the written bar.
	const v = s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]
	return Math.round(v * 1000) / 1000
}

const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-angle=metal'] })
try {
	const page = await (await browser.newContext({ viewport: { width: 1512, height: 982 }, deviceScaleFactor: 2 })).newPage()
	const errors = []
	page.on('pageerror', error => errors.push(error.message.slice(0, 240)))
	await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120000 })
	await page.waitForFunction(() => globalThis.steelseed?.ctx?.session?.available, undefined, { timeout: 180000, polling: 250 })
	const packed = await page.evaluate(async () => {
		const catalog = await globalThis.steelseed.ctx.session.getCatalog()
		const ranked = [...catalog.maps].map(m => ({
			title: m.title,
			area: m.bounds.width * m.bounds.height,
			w: m.bounds.width,
			h: m.bounds.height,
			slots: m.slots.filter(s => s.allowBots || s.required).length,
		})).sort((a, b) => b.area - a.area)
		const eligible = ranked.filter(m => m.slots >= 8)
		const pick = eligible[0]
		const map = catalog.maps.find(m => m.title === pick.title)
		return { catalog, map, ranked: ranked.slice(0, 4), compared: eligible.slice(0, 4) }
	})
	assert.ok(packed.map, 'no catalog map with 8 playable slots')
	const config = configFor(packed.catalog, packed.map, { withBot: true })
	const playable = packed.map.slots.filter(s => s.allowBots || s.required)
	let spawn = 1
	config.slots = packed.map.slots.map(descriptor => {
		const index = playable.findIndex(s => s.id === descriptor.id)
		const inPlay = index >= 0 && index < 8
		return {
			slot: descriptor.id,
			kind: index === 0 ? 'human' : inPlay ? 'bot' : 'closed',
			botType: index === 0 || !inPlay ? '' : (packed.map.bots.find(b => b.id === 'normal')?.id ?? packed.map.bots[0]?.id ?? ''),
			faction: descriptor.locks.faction ? descriptor.defaults.faction : packed.map.factions[index % packed.map.factions.length].id,
			color: descriptor.locks.color ? descriptor.defaults.color : packed.map.colors[index % packed.map.colors.length],
			team: inPlay ? index + 1 : 0,
			spawn: descriptor.locks.spawn ? descriptor.defaults.spawn : inPlay ? spawn++ : 0,
		}
	})
	const human = config.slots[0]
	config.local = { slot: human.slot, name: 'Player', faction: human.faction, color: human.color, team: human.team, spawn: human.spawn }
	Object.assign(config.options, { startingunits: 'army', explored: 'True', fog: 'False', crates: 'False' })
	const started = await page.evaluate(async c => await globalThis.steelseed.ctx.session.startSkirmish(c), config)
	if (started?.status === 'error') throw new Error(`${packed.map.title}: ${started.code} ${started.userMessage}`)
	await page.waitForFunction(() => (globalThis.steelseed?.ctx?.snapshot?.actors?.count ?? 0) >= 800, undefined, { timeout: 180000, polling: 250 })
	await page.waitForTimeout(2500)
	await page.evaluate(() => {
		globalThis.__samples = []
		let last = performance.now()
		const loop = now => {
			globalThis.__samples.push(now - last)
			last = now
			if (globalThis.__samples.length < 280) requestAnimationFrame(loop)
		}
		requestAnimationFrame(loop)
		window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', bubbles: true }))
	})
	await page.waitForFunction(() => (globalThis.__samples?.length ?? 0) >= 240, undefined, { timeout: 20000 })
	const row = await page.evaluate(() => {
		window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD', bubbles: true }))
		const units = steelseed.ctx.get('units')
		const stats = steelseed.frameStats
		return {
			samples: globalThis.__samples.slice(12),
			actors: steelseed.ctx.snapshot.actors.count,
			loaded: units.forgeStats.loaded,
			fallback: units.forgeStats.fallback,
			scale: stats.renderScale,
			contact: stats.contact,
			cascades: stats.cascades,
			presetCascades: stats.presetCascades,
			weatherFx: stats.weatherFx,
			nearField: stats.nearField,
			windGrass: stats.windGrass,
			presetNear: stats.presetNear,
			presetWind: stats.presetWind,
			sceneryStep: stats.sceneryStep,
		}
	})
	const p50 = pct(row.samples, 0.5)
	const p99 = pct(row.samples, 0.99)
	const worst = Math.round(Math.max(...row.samples) * 1000) / 1000
	let at83 = 0
	let at85 = 0
	let at167 = 0
	let at25 = 0
	let over25 = 0
	for (const v of row.samples) {
		if (v <= 8.3) at83++
		else if (v <= 8.5) at85++
		else if (v <= 16.7) at167++
		else if (v <= 25) at25++
		else over25++
	}
	const span = `n${row.samples.length} <=8.3 ${at83} <=8.5 ${at85} <=16.7 ${at167} <=25 ${at25} >25 ${over25} worst ${worst}`
	if (process.env.SCALE_SHOT) await page.screenshot({ path: process.env.SCALE_SHOT })
	assert.equal(errors.length, 0, errors.join('\n'))
	assert.ok(row.loaded > 0, 'Blender roster did not load')
	assert.equal(row.fallback, 0)
	assert.ok(row.actors >= 800, `live actors ${row.actors}`)
	assert.ok(p50 <= 8.3, `p50 ${p50} ${span}`)
	assert.ok(p99 <= 16.7, `p99 ${p99} ${span}`)
	assert.ok(worst <= 50, `worst ${worst} ${span}`)
	assert.equal(row.scale, 1)
	assert.equal(row.contact, true)
	assert.equal(row.cascades, row.presetCascades)
	assert.equal(row.weatherFx, true)
	assert.equal(row.sceneryStep, 1)
	assert.ok(row.presetNear !== true || row.nearField === true, 'near-field was shed')
	assert.ok(row.presetWind !== true || row.windGrass === true, 'wind grass was shed')
	const report = {
		pass: true,
		map: packed.map.title,
		area: packed.map.bounds.width * packed.map.bounds.height,
		w: packed.map.bounds.width,
		h: packed.map.bounds.height,
		largestCompared: packed.compared,
		actors: row.actors,
		loaded: row.loaded,
		fallback: row.fallback,
		p50: +p50.toFixed(2),
		p99: +p99.toFixed(2),
		renderScale: row.scale,
		contact: row.contact,
		cascades: row.cascades,
		weatherFx: row.weatherFx,
		nearField: row.nearField,
		windGrass: row.windGrass,
		sceneryStep: row.sceneryStep,
	}
	console.log(JSON.stringify(report))
	await page.close()
} finally {
	await browser.close()
}
