#!/usr/bin/env node
// Production-capable 1v1 combat cadence and destruction-artifact probe.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WEB_ROOT, launchGpuBrowser, loadChromium } from './harness.mjs'
import { configFor } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'

const baseUrl = process.env.COMBATPERF_URL ?? 'https://play.redlinewars.online/steelseed/index.html'
const quality = process.env.COMBATPERF_QUALITY ?? 'high'
const width = Number(process.env.COMBATPERF_WIDTH ?? 1280)
const height = Number(process.env.COMBATPERF_HEIGHT ?? 800)
const deviceScaleFactor = Number(process.env.COMBATPERF_DPR ?? 1)
const capture = process.env.COMBATPERF_CAPTURE !== '0'
const out = join(WEB_ROOT, '.artifacts/visual-quality/combat-perf')
mkdirSync(out, { recursive: true })

let browser
try {
	;({ browser } = await launchGpuBrowser(await loadChromium('combatperfgate'), 'combatperfgate'))
	const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor })
	const page = await context.newPage()
	const errors = []
	page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
	page.on('console', message => {
		if (message.type() === 'error' && !message.text().includes('favicon')) errors.push(`console: ${message.text()}`)
	})
	const url = new URL(baseUrl)
	url.searchParams.set('mode', 'game')
	url.searchParams.set('platform', 'null')
	url.searchParams.set('quality', quality)
	url.searchParams.set('combatperf', Date.now().toString())
	await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60_000 })
	await page.waitForFunction(() => globalThis.steelseed?.ctx?.session?.available,
		undefined, { timeout: 240_000, polling: 250 })
	const catalog = await page.evaluate(() => steelseed.ctx.session.getCatalog())
	const map = catalog.maps.find(candidate => candidate.title === 'Marigold Town') ?? catalog.maps[0]
	const config = configFor(catalog, map, { withBot: false })
	const faction = ['england', 'germany', 'france', 'allies'].find(id => map.factions.some(candidate => candidate.id === id))
	assert.ok(faction, 'allied faction required')
	config.local.faction = faction
	config.slots.find(slot => slot.slot === config.local.slot).faction = faction
	Object.assign(config.options, { startingunits: 'heavy', explored: 'True', fog: 'False', crates: 'False' })
	await page.evaluate(value => steelseed.ctx.session.startSkirmish(value), config)
	await page.waitForFunction(() => steelseed.ctx.snapshot?.tick > 120 && document.getElementById('session-ui')?.hidden,
		undefined, { timeout: 180_000, polling: 100 })
	const roster = await page.evaluate(() => {
		const ctx = steelseed.ctx, actors = ctx.snapshot.actors, own = []
		for (let i = 0; i < actors.count; i++) if (actors.owner[i] === ctx.snapshot.world.renderPlayer)
			own.push({ id: actors.id[i], type: ctx.actorTypeName(actors.typeId[i]), x: actors.posX[i] / 1024, z: actors.posY[i] / 1024 })
		return own
	})
	const victim = roster.find(actor => actor.type === '1tnk') ?? roster.find(actor => /tnk$/.test(actor.type))
	const attacker = roster.find(actor => actor.id !== victim?.id && ['4tnk', '3tnk', '2tnk', '1tnk'].includes(actor.type))
	assert.ok(victim && attacker, `1v1 tanks required: ${JSON.stringify(roster)}`)
	await page.evaluate(target => {
		const app = steelseed, camera = app.ctx.get('camera')
		camera.focusWorld(target.x, target.z); camera.height = camera.heightGoal = 7; camera.yaw = camera.yawGoal = .4
		const samples = [], intervals = [], longTasks = [], destroyed = []
		let running = true, last = performance.now()
		const observer = new PerformanceObserver(list => {
			for (const entry of list.getEntries()) longTasks.push({ at: performance.now(), duration: entry.duration })
		})
		observer.observe({ entryTypes: ['longtask'] })
		const frame = timestamp => {
			if (!running) return
			intervals.push({ at: timestamp, dt: timestamp - last }); last = timestamp; requestAnimationFrame(frame)
		}
		requestAnimationFrame(frame)
		app.ctx.events.on('sim:actor:destroyed', event => destroyed.push({
			at: performance.now(), tick: app.ctx.time.tick,
			id: app.ctx.snapshot.view.getUint32(event.offset, true),
		}))
		const snapshot = label => {
			const render = app.ctx.get('render'), units = app.ctx.get('units'), fx = app.ctx.get('fx'), wrecks = app.ctx.get('wrecks')
			samples.push({
				label, at: performance.now(), tick: app.ctx.snapshot.tick,
				render: { ...render.stats }, frame: { ...app.frameStats },
				damage: { ...units.damageStats }, death: { ...units.deathStats },
				fx: { ...fx.stats }, tracks: { ...fx.groundTrackStats },
				wrecks: { ...wrecks.stats },
			})
		}
		const timer = setInterval(() => snapshot('second'), 1000)
		globalThis.combatProbe = {
			samples, intervals, longTasks, destroyed, snapshot,
			finish() { running = false; clearInterval(timer); observer.disconnect(); snapshot('finish'); return { samples, intervals, longTasks, destroyed } },
		}
	}, victim)
	await page.waitForTimeout(1000)
	if (capture) await page.screenshot({ path: join(out, 'before.png') })
	const result = await page.evaluate(async ({ attacker, victim }) => steelseed.bridge.issueContextOrder({
		subjectIds: Uint32Array.of(attacker.id), subjectCount: 1, targetActorId: victim.id,
		targetCellX: Math.floor(victim.x), targetCellY: Math.floor(victim.z), targetFrozen: false, modifiers: 1,
	}), { attacker, victim })
	assert.match(result, /Attack/, `force attack required, got ${result}`)
	await page.waitForFunction(id => combatProbe.destroyed.some(event => event.id === id), victim.id,
		{ timeout: 120_000, polling: 25 })
	if (capture) await page.screenshot({ path: join(out, 'death.png') })
	await page.waitForTimeout(1500)
	if (capture) await page.screenshot({ path: join(out, 'after.png') })
	await page.waitForTimeout(8500)
	const raw = await page.evaluate(() => combatProbe.finish())
	const destroyedAt = raw.destroyed.find(event => event.id === victim.id).at
	const summarise = (label, from, to) => {
		const values = raw.intervals.filter(row => row.at >= from && row.at < to).map(row => row.dt).sort((a, b) => a - b)
		const percentile = p => values[Math.min(values.length - 1, Math.floor(values.length * p))] ?? Infinity
		return { label, frames: values.length, fps: values.length / ((to - from) / 1000), p50Ms: percentile(.5), p95Ms: percentile(.95), worstMs: percentile(1) }
	}
	const startAt = raw.intervals[0]?.at ?? destroyedAt
	const report = {
		url: url.href, requestedQuality: quality, quality: raw.samples.at(-1)?.frame?.tier,
		graphicsChoice: raw.samples.at(-1)?.frame?.choice,
		viewport: { width, height, deviceScaleFactor }, attacker, victim, order: result, errors,
		periods: [
			summarise('combat', startAt, destroyedAt),
			summarise('death+2s', destroyedAt, destroyedAt + 2000),
			summarise('post-death', destroyedAt + 2000, destroyedAt + 9000),
		],
		longTasks: raw.longTasks, destroyed: raw.destroyed, samples: raw.samples,
	}
	writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
	console.log(JSON.stringify(report, null, 2))
	assert.deepEqual(errors, [])
	assert.ok(report.periods[2].fps >= 55, `post-death cadence ${report.periods[2].fps.toFixed(1)} fps`)
	await context.close()
} finally {
	await browser?.close().catch(() => {})
}
