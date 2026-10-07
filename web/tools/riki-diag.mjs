#!/usr/bin/env node
// Authoritative C4 regression: Riki must enter, plant, exit, and survive the demolition.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { launchGpuBrowser, loadChromium } from './harness.mjs'
import { startPrivateComposed } from './private-composed-preview.mjs'
import { configFor } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'

const web = resolve(import.meta.dirname, '..')
const root = resolve(web, '..')
const out = join(root, '.artifacts/visual-quality/riki-c4-gate')
mkdirSync(out, { recursive: true })

function prepareFixture(fs) {
	const dir = '/openra/engine/mods/ra/maps/doubles'
	const file = `${dir}/map.yaml`
	const text = fs.readFile(file, { encoding: 'utf8' })
	const actors = [
		['Spawn0', 'mpspawn', 80, 40], ['Spawn1', 'mpspawn', 100, 40],
		['Spawn2', 'mpspawn', 80, 46], ['Spawn3', 'mpspawn', 100, 46],
		['Riki', 'e7', 8, 10], ['Target', 'powr', 13, 10],
	]
	const rows = actors.map(([id, type, x, y]) => `\t${id}: ${type}\n\t\tOwner: ${type === 'mpspawn' ? 'Neutral' : id === 'Target' ? 'Multi1' : 'Multi0'}\n\t\tLocation: ${x},${y}\n`).join('')
	fs.writeFile(file, `${text.split('\nActors:\n')[0]}\nActors:\n${rows}`)
	const width = 112, height = 54, terrain = new Uint8Array(5 + width * height * 5), view = new DataView(terrain.buffer)
	terrain[0] = 1; view.setUint16(1, width, true); view.setUint16(3, height, true)
	for (let i = 0; i < width * height; i++) view.setUint16(5 + i * 3, 255, true)
	fs.writeFile(`${dir}/map.bin`, terrain)
	globalThis.rikiC4FixturePrepared = true
}

let preview, browser, page
try {
	preview = await startPrivateComposed(8481)
	;({ browser } = await launchGpuBrowser(await loadChromium('rikic4gate'), 'rikic4gate'))
	page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
	const errors = []
	page.on('pageerror', error => errors.push(error.message))
	await page.route('**/main.js', async route => {
		const response = await route.fetch()
		let text = await response.text()
		text = text.replace(
			'getAssemblyExports, getConfig, localHeapViewU8, runMain',
			'getAssemblyExports, getConfig, localHeapViewU8, runMain, Module',
		)
		text = text.replace(
			'const config = getConfig()',
			`;(${prepareFixture.toString()})(Module.FS);\n const config = getConfig()`,
		)
		await route.fulfill({ response, body: text })
	})
	const url = new URL(preview.baseUrl)
	for (const [key, value] of Object.entries({ quality: 'medium', weather: 'clear', daylight: 'day' })) url.searchParams.set(key, value)
	await page.goto(url.href)
	await page.waitForFunction(() => globalThis.steelseed?.ctx.session.available, undefined, { timeout: 180000, polling: 100 })
	const catalog = await page.evaluate(() => steelseed.ctx.session.getCatalog())
	const map = catalog.maps.find(entry => entry.title === 'Doubles')
	assert.ok(map, 'Doubles fixture map')
	const config = configFor(catalog, map, { withBot: false })
	config.local.faction = 'england'; config.slots[0].faction = 'england'
	Object.assign(config.options, { fog: 'False', explored: 'True', crates: 'False' })
	await page.evaluate(value => steelseed.ctx.session.startSkirmish(value), config)
	await page.waitForFunction(
		() => steelseed.ctx.snapshot?.actors?.count > 0 && document.getElementById('session-ui').hidden,
		undefined, { timeout: 180000, polling: 100 },
	)
	const initial = await page.evaluate(async () => {
		const ctx = steelseed.ctx
		const row = typeName => {
			const actors = ctx.snapshot.actors
			for (let i = 0; i < actors.count; i++) if (ctx.actorTypeName(actors.typeId[i]) === typeName)
				return { id: actors.id[i], x: actors.posX[i] / 1024, z: actors.posY[i] / 1024, health: actors.health[i] }
		}
		for (let attempt = 0; attempt < 40; attempt++) {
			const riki = row('e7'), target = row('powr')
			if (riki && target) return { riki, target, waitedMs: attempt * 250 }
			await new Promise(r => setTimeout(r, 250))
		}
		let status = null, players = null
		try { status = JSON.stringify(await steelseedBridge.getSessionStatus()) } catch (e) { status = String(e) }
		try { players = String(await steelseedBridge.getLobbyPlayersProbe()).slice(0, 300) } catch (e) { players = String(e) }
		return { riki: row('e7'), target: row('powr'), status, players, actorTypes: (() => { const a = ctx.snapshot.actors, t = new Set(); for (let i = 0; i < a.count; i++) t.add(ctx.actorTypeName(a.typeId[i])); return Array.from(t).slice(0, 24) })() }
	})
	console.log('RIKI-DIAG:', JSON.stringify(initial)); assert.ok(initial.riki && initial.target, 'fixture has Riki and a demolishable enemy building')

	const result = await page.evaluate(async ({ riki, target }) => {
		const ctx = steelseed.ctx
		const rows = []
		const start = { x: riki.x, z: riki.z }
		const order = steelseed.bridge.issueOrder({
			orderString: 'C4', subjectIds: Uint32Array.of(riki.id), targetActorId: target.id,
			targetCellX: Math.round(target.x), targetCellY: Math.round(target.z),
			queued: false, targetString: '', extraData: 0,
		})
		const deadline = performance.now() + 16000
		while (performance.now() < deadline) {
			const actors = ctx.snapshot.actors
			let currentRiki = null, currentTarget = null
			for (let i = 0; i < actors.count; i++) {
				if (actors.id[i] === riki.id) currentRiki = { x: actors.posX[i] / 1024, z: actors.posY[i] / 1024, health: actors.health[i], flags: actors.flags[i] }
				if (actors.id[i] === target.id) currentTarget = { health: actors.health[i], flags: actors.flags[i] }
			}
			rows.push({ tick: ctx.snapshot.tick, riki: currentRiki, target: currentTarget })
			if (currentTarget === null) break
			await new Promise(requestAnimationFrame)
		}
		return { order, initial: { riki, target }, start, final: rows.at(-1), rows }
	}, initial)

	assert.match(result.order, /ok: issued 1\/1 local orders/)
	assert.ok(result.rows.length > 50, 'C4 activity was observed across ticks')
	assert.equal(result.final.target, null, 'enemy building was demolished')
	assert.ok(result.final.riki, 'Riki still exists after demolition')
	assert.equal(result.final.riki.health, 255, 'Riki exits and survives at full health')
	const moved = result.rows.some(row => row.riki && Math.hypot(row.riki.x - result.start.x, row.riki.z - result.start.z) > 1)
	assert.ok(moved, 'Riki travelled to the target before planting')
	assert.deepEqual(errors, [])
	await page.screenshot({ path: join(out, 'survivor.png') })
	const summary = {
		status: 'PASS', order: result.order, initial: result.initial, final: result.final,
		scope: 'Real authoritative C4 order against an enemy power plant in the composed production runtime.',
	}
	writeFileSync(join(out, 'report.json'), JSON.stringify({ summary, samples: result.rows.filter((_, index) => index === 0 || index === result.rows.length - 1 || index % 25 === 0) }, null, 2) + '\n')
	console.log('RIKI_C4_GATE_PASS', JSON.stringify(summary))
} finally {
	await page?.close(); await browser?.close(); await preview?.close()
}
