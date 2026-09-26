#!/usr/bin/env node
// Real skirmish cadence on the composed AppBundle. requestAnimationFrame interval,
// Blender roster loaded, camera moving. Dynamic and High, Fog of War on and off.
// ?devmap=1 does not satisfy this gate.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { configFor } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'

const base = process.env.STEELSEED_URL ?? 'http://127.0.0.1:8080/steelseed/index.html?mode=game&platform=null'
const shot = process.argv.find(arg => arg.startsWith('--shot='))?.slice('--shot='.length) ?? ''

function pct(xs, p) {
	const s = [...xs].sort((a, b) => a - b)
	return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]
}

const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-angle=metal'] })
try {
	async function boot(quality) {
		const page = await (await browser.newContext({ viewport: { width: 1512, height: 982 }, deviceScaleFactor: 2 })).newPage()
		const errors = []
		page.on('pageerror', error => errors.push(error.message.slice(0, 240)))
		await page.goto(`${base}${base.includes('?') ? '&' : '?'}quality=${quality}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
		await page.waitForFunction(() => globalThis.steelseed?.ctx?.session?.available, undefined, { timeout: 180000, polling: 250 })
		return { page, errors }
	}

	async function start(page, { title, fog }) {
		const packed = await page.evaluate(async title => {
			const catalog = await globalThis.steelseed.ctx.session.getCatalog()
			const map = catalog.maps.find(m => m.title === title)
			return { catalog, map }
		}, title)
		assert.ok(packed.map, `missing map ${title}`)
		const config = configFor(packed.catalog, packed.map, { withBot: true })
		const playable = packed.map.slots.filter(s => s.allowBots || s.required)
		let spawn = 1
		config.slots = packed.map.slots.map(descriptor => {
			const index = playable.findIndex(s => s.id === descriptor.id)
			const inPlay = index >= 0 && index < 2
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
		Object.assign(config.options, { startingunits: 'heavy', explored: fog === 'False' ? 'True' : 'False', fog, crates: 'False' })
		const started = await page.evaluate(async c => await globalThis.steelseed.ctx.session.startSkirmish(c), config)
		if (started?.status === 'error') throw new Error(`${title}: ${started.code} ${started.userMessage}`)
		await page.waitForFunction(() => (globalThis.steelseed?.ctx?.snapshot?.actors?.count ?? 0) > 0, undefined, { timeout: 180000, polling: 250 })
		await page.waitForTimeout(2000)
		return packed.map.title
	}

	async function sample(page) {
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
		return page.evaluate(() => {
			window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD', bubbles: true }))
			const units = steelseed.ctx.get('units')
			const samples = globalThis.__samples.slice(12)
			return {
				samples,
				scale: steelseed.frameStats.renderScale,
				actors: steelseed.ctx.snapshot.actors.count,
				loaded: units.forgeStats.loaded,
				fallback: units.forgeStats.fallback,
			}
		})
	}

	const arms = []
	let pictured = false
	for (const [quality, fog] of [['dynamic', 'True'], ['dynamic', 'False'], ['high', 'True'], ['high', 'False']]) {
		const { page, errors } = await boot(quality)
		const map = await start(page, { title: 'Marigold Town', fog })
		if (shot && !pictured) {
			await page.screenshot({ path: shot })
			pictured = true
		}
		const row = await sample(page)
		const p50 = pct(row.samples, 0.5)
		const worst = Math.max(...row.samples)
		assert.equal(errors.length, 0, errors.join('\n'))
		assert.ok(row.loaded > 0, 'Blender roster did not load')
		assert.equal(row.fallback, 0)
		assert.ok(row.actors > 0)
		assert.ok(p50 <= 16.7, `${quality} fog ${fog} p50 ${p50}`)
		assert.ok(worst <= 50, `${quality} fog ${fog} worst ${worst}`)
		arms.push({
			quality, fog, map,
			p50: +p50.toFixed(2), worst: +worst.toFixed(2), p99: +pct(row.samples, 0.99).toFixed(2),
			actors: row.actors, loaded: row.loaded, fallback: row.fallback, scale: row.scale,
		})
		console.log(quality, 'fog', fog, 'p50', p50.toFixed(2), 'worst', worst.toFixed(1), 'actors', row.actors, 'blender', row.loaded)
		await page.close()
	}
	console.log(JSON.stringify({ pass: true, arms }))
} finally {
	await browser.close()
}
