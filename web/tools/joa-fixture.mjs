#!/usr/bin/env node
// Design fixture: the companion's own player-safe projection of a real match on a real map.
// Starts a local skirmish in the composed AppBundle (bots on every other slot), lets it run,
// and writes the TacticalState the primary would publish. With --explored the lobby's
// "explored map" and "fog of war" options reveal the whole map, so the terrain renderer can be
// designed against complete, real terrain; without it the fixture keeps the player's fog.
//
//   node tools/joa-fixture.mjs [--map=<title substring>] [--seconds=90] [--explored] [--out=<file>]
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { launchGpuBrowser, loadChromium } from './harness.mjs'

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const root = new URL('../../', import.meta.url).pathname
const mapQuery = arg('map', '').toLowerCase()
const seconds = Number(arg('seconds', '90'))
const explored = process.argv.includes('--explored')
const out = arg('out', `${root}web/.artifacts/joa/fixture-${explored ? 'explored' : 'fog'}.json`)

const server = spawn(process.execPath, [`${root}engine/OpenRA.Browser/tests/server.mjs`, '--port', '5324', '--root', `${root}engine/bin-browser/AppBundle`], { cwd: root, stdio: 'pipe' })
let browser
const errors = []
try {
	for (let i = 0; i < 100; i++) {
		try { if ((await fetch('http://127.0.0.1:5324/steelseed/index.html')).ok) break } catch { /* not up yet */ }
		await new Promise(r => setTimeout(r, 100))
	}
	;({ browser } = await launchGpuBrowser(await loadChromium('joa-fixture'), 'joa-fixture'))
	const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
	await context.route('**/net-config.json', r => r.fulfill({ json: { schema: 1, browserMultiplayer: 'off' } }))
	const main = await context.newPage()
	main.on('pageerror', e => errors.push(e.message))
	await main.goto('http://127.0.0.1:5324/steelseed/index.html?quality=low&mode=game')
	await main.waitForFunction(() => globalThis.steelseed && globalThis.steelseedBridge?.getSkirmishCatalog(), { timeout: 120000 })
	const started = await main.evaluate(async ({ mapQuery, explored }) => {
		const bridge = globalThis.steelseedBridge, c = await bridge.getSkirmishCatalog()
		const candidates = c.maps.filter(m => m.slots.length >= 4 && !m.slots[0].locks.faction)
		const m = candidates.find(m => mapQuery && m.title.toLowerCase().includes(mapQuery)) ?? candidates.sort((a, b) => b.bounds?.w * b.bounds?.h - a.bounds?.w * a.bounds?.h)[0] ?? c.maps[0]
		const factions = ['england', 'russia', 'germany', 'ukraine', 'france', 'russia']
		const slots = m.slots.map((s, i) => ({ slot: s.id, kind: i === 0 ? 'human' : i < 4 ? 'bot' : 'open', botType: i > 0 && i < 4 ? 'normal' : '', faction: s.locks.faction ? s.defaults.faction : factions[i % factions.length], color: s.locks.color ? s.defaults.color : m.colors[i % m.colors.length], team: i % 2 === 0 ? 1 : 2, spawn: s.locks.spawn ? s.defaults.spawn : i + 1 }))
		const options = Object.fromEntries(m.options.filter(o => o.id !== 'gamespeed').map(o => [o.id, o.defaultValue]))
		if (explored) for (const o of m.options) {
			if (/explored/i.test(o.id)) options[o.id] = 'True'
			if (/^fog/i.test(o.id)) options[o.id] = 'False'
		}
		const status = await bridge.startSkirmish({ schemaVersion: c.schemaVersion, transport: 'local', mapUid: m.uid, gameSpeed: c.gameSpeeds?.at?.(-1)?.id ?? c.defaultGameSpeed, randomSeed: 104729, local: { slot: slots[0].slot, name: 'JOA Commander', faction: slots[0].faction, color: slots[0].color, team: slots[0].team, spawn: slots[0].spawn }, slots, options })
		return { status: status.status, map: m.title, options: m.options.map(o => o.id) }
	}, { mapQuery, explored })
	console.log('match', JSON.stringify(started))
	await main.waitForFunction(() => globalThis.steelseed.ctx.snapshot?.world && (globalThis.steelseed.ctx.snapshot.flags & 16) !== 0, { timeout: 90000 })
	await new Promise(r => setTimeout(r, seconds * 1000))
	const state = await main.evaluate(() => {
		const ctx = globalThis.steelseed.ctx, ui = ctx.get('ui')
		const groups = new Map()
		const own = []
		const s = ctx.snapshot
		for (let i = 0; i < s.actors.count; i++) if (s.actors.owner[i] === s.world.renderPlayer) own.push(s.actors.id[i])
		groups.set(1, own.slice(0, 8))
		const state = ui.tacticalModel.project(ctx, groups, 'fixture', 1)
		// The 3D world's own relief at each cell centre (reconstructed for flat RA maps), for the
		// renderer's design; the live model quantises the same samples into its height plane.
		const terrain = ctx.peek('terrain'), b = state?.bounds
		if (state && terrain?.heightAt) state.reliefM = Array.from({ length: b.w * b.h }, (_, i) => state.visibility[i] ? Math.round(terrain.heightAt(b.x + (i % b.w) + 0.5, b.y + Math.floor(i / b.w) + 0.5) * 1000) / 1000 : 0)
		return state
	})
	if (!state) throw new Error('no tactical projection')
	mkdirSync(dirname(out), { recursive: true })
	writeFileSync(out, JSON.stringify({ ...state, map: started.map }))
	console.log(`fixture: ${started.map}, ${state.bounds.w}×${state.bounds.h}, ${state.contacts.length} contacts, ${state.visibility.filter(v => v > 0).length} known cells -> ${out}`)
	if (errors.length) console.log('page errors:', errors.slice(0, 5))
} finally {
	await browser?.close()
	server.kill()
}
