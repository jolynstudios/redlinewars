#!/usr/bin/env node
// STEELSEED — tools/healthbargate
// World health bars: drawn for selected and damaged actors only, from the snapshot the
// host already filtered for the render player, coloured by RA thresholds, and for frozen
// structures only from their frozen health while their cell is explored but out of sight.
//
// Runs the production bundle on the deterministic dev map under vite preview, drives frames
// by hand so every assertion reads the DOM the same frame the snapshot changed.

import assert from 'node:assert/strict'
import { launchGpuBrowser, loadChromium, startPreview, stopChild } from './harness.mjs'

const TOOL = 'healthbargate'
const preview = await startPreview(8421)
let browser
try {
	;({ browser } = await launchGpuBrowser(await loadChromium(TOOL), TOOL))
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 })
	const errors = []
	page.on('pageerror', e => errors.push(e.message))
	page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()) })
	await page.addInitScript(() => { globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {} })
	await page.goto(`${preview.baseUrl}?devmap=1&deterministic=1&manual=1&devsize=48&devactors=12&devcluster=3`)
	await page.waitForFunction(() => globalThis.steelseed, undefined, { timeout: 180000, polling: 100 })
	const result = await page.evaluate(async () => {
		const app = globalThis.steelseed
		app.stop()
		let frameIndex = 0
		// Snapshot intake awaits the actor table; synchronous frames cannot settle it.
		// NOTE(flake): the 120-spin loop below is the only wait — if the actor table has not
		// settled by then, execution falls through with `snap` still null (intermittent
		// null-snapshot failure; there is no explicit timeout). Noted only, deliberately not fixed here.
		for (let i = 0; i < 120 && app.ctx.snapshot === null; i++) {
			await new Promise(resolve => setTimeout(resolve, 16))
			app.renderOneFrame(frameIndex++ * 1000 / 60)
		}
		for (let i = 0; i < 6; i++) app.renderOneFrame(frameIndex++ * 1000 / 60)
		const ctx = app.ctx, ui = ctx.get('ui'), camera = ctx.get('camera'), shroud = ctx.get('shroud'), units = ctx.get('units')
		const roles = {
			infantry: units.healthBarEligible('e1'),
			building: units.healthBarEligible('powr'),
			wall: units.healthBarEligible('brik'),
			tree: units.healthBarEligible('t01'),
			rock: units.healthBarEligible('rock1'),
			crate: units.healthBarEligible('ammobox1'),
			husk: units.healthBarEligible('badr.husk'),
		}
		const snap = ctx.snapshot, actors = snap.actors
		// The deterministic dev map uses synthetic Foundry actor names with no RA
		// manifest entry. Give its existing type ids real unit roles for this UI gate;
		// the separate tree override below tests the scenery rejection path.
		const originalActorTypeName = ctx.actorTypeName
		ctx.actorTypeName = typeId => originalActorTypeName(typeId).startsWith('foundry_')
			? 'e1' : originalActorTypeName(typeId)
		// Expected band colours are read from the live computed palette — the same custom
		// properties ui/readUiPalette (web/src/ui/index.ts:113) consumes at init — so a
		// palette rebrand cannot stale-pin this gate. The literals only mirror the
		// module's own fallback hexes for the case where the stylesheet has not applied.
		const css = getComputedStyle(document.documentElement)
		const bands = {
			healthy: css.getPropertyValue('--healthy').trim() || '#87BC91',
			warning: css.getPropertyValue('--warning').trim() || '#D9AE61',
			critical: css.getPropertyValue('--critical').trim() || '#FF6B63',
		}
		const bars = () => [...document.querySelectorAll('rect[data-healthbar="fill"]')].filter(r => r.style.display !== 'none')
		const frame = () => { ctx.time.frame++; app.registry.update(1 / 60, ctx); app.registry.lateUpdate(1 / 60, ctx) }
		// Reveal the map for the presentation, and put the camera over the actor cluster.
		snap.shroud = [{ cellIndex: 0, runLength: ctx.get('terrain').cellsWide * ctx.get('terrain').cellsHigh, state: 2 }]
		shroud.onSnapshot(snap, null, ctx)
		let cx = 0, cz = 0
		for (let i = 0; i < actors.count; i++) { cx += actors.posX[i] / 1024; cz += actors.posY[i] / 1024 }
		camera.focusWorld(cx / actors.count, cz / actors.count)
		camera.height = camera.heightGoal = 26
		// Baseline: everything full, nothing selected, no bars.
		for (let i = 0; i < actors.count; i++) actors.health[i] = 255
		ui.selection.length = 0
		frame()
		const none = bars().length
		// Damage three actors to green / yellow / red bands.
		const picks = [0, 1, 2].map(k => Math.floor(k * actors.count / 3))
		actors.health[picks[0]] = 200
		actors.health[picks[1]] = 120
		actors.health[picks[2]] = 40
		frame()
		const damaged = bars().map(r => ({ fill: r.getAttribute('fill'), width: Number(r.getAttribute('width')) }))
		const nonRenderableExpected = picks.filter(i => actors.typeId[i] !== actors.typeId[picks[0]]).length
		const actorTypeName = ctx.actorTypeName
		ctx.actorTypeName = typeId => typeId === actors.typeId[picks[0]] ? 't01' : actorTypeName(typeId)
		frame()
		const treeLive = bars().length
		ctx.actorTypeName = actorTypeName
		units.typeRenderable.set(actors.typeId[picks[0]], false)
		frame()
		const nonRenderableLive = bars().length
		units.typeRenderable.set(actors.typeId[picks[0]], true)
		// Select an undamaged actor: it gains a bar; a selected damaged one is not doubled.
		const healthy = [...Array(actors.count).keys()].find(i => !picks.includes(i))
		ui.selection.length = 0
		ui.selection.push(actors.id[healthy], actors.id[picks[0]])
		frame()
		const withSelection = bars().length
		// Frozen structures: one damaged frozen record on an explored-but-unseen cell draws
		// from frozen health; the same record on a visible cell does not (the live actor would).
		// Under an all-explored shroud the units node hides every live actor (a live actor on
		// an unseen cell never occurs in a real match), so that phase shows the frozen bar alone.
		const terrain = ctx.get('terrain')
		const fx = Math.floor(actors.posX[picks[1]] / 1024) + 2, fz = Math.floor(actors.posY[picks[1]] / 1024)
		const frozen = { count: 1, id: Uint32Array.of(999999), posX: Int32Array.of(fx * 1024 + 512), posY: Int32Array.of(fz * 1024 + 512), posZ: Int32Array.of(0), typeId: Uint16Array.of(actors.typeId[0]), owner: Uint8Array.of(7), health: Uint8Array.of(90) }
		snap.frozenActors = frozen
		ui.selection.length = 0
		frame()
		const frozenVisibleCell = bars().length
		const w = terrain.cellsWide, h = terrain.cellsHigh
		snap.shroud = [{ cellIndex: 0, runLength: w * h, state: 1 }]
		shroud.onSnapshot(snap, null, ctx)
		frame()
		const frozenExploredCell = bars().map(r => ({ fill: r.getAttribute('fill') }))
		units.typeRenderable.set(frozen.typeId[0], false)
		frame()
		const nonRenderableFrozen = bars().length
		units.typeRenderable.set(frozen.typeId[0], true)
		frozen.id[0] = actors.id[picks[1]]
		frame()
		const duplicateFrozen = bars().length
		// Full health again: every bar disappears.
		snap.frozenActors = null
		for (const i of picks) actors.health[i] = 255
		frame()
		const cleared = bars().length
		const pickNames = picks.map(i => ctx.actorTypeName(actors.typeId[i]))
		ctx.actorTypeName = originalActorTypeName
		return { roles, bands, none, damaged, treeLive, nonRenderableLive, nonRenderableExpected, withSelection, frozenVisibleCell, frozenExploredCell, nonRenderableFrozen, duplicateFrozen, cleared, actors: actors.count, pickNames }
	})
	assert.deepEqual(errors, [], 'no page errors')
	assert.deepEqual(result.roles, { infantry: true, building: true, wall: true, tree: false, rock: false, crate: false, husk: false },
		'only units and buildings may grow world health bars')
	assert.equal(result.none, 0, 'no bars when nothing is damaged or selected')
	assert.equal(result.damaged.length, 3, `three damaged actors draw three bars: ${JSON.stringify(result.damaged)} names=${result.pickNames.join(',')}`)
	const fills = result.damaged.map(d => d.fill)
	assert.ok(fills.includes(result.bands.healthy) && fills.includes(result.bands.warning) && fills.includes(result.bands.critical), `RA colour bands: ${fills.join(',')} vs live palette ${JSON.stringify(result.bands)}`)
	assert.equal(new Set(Object.values(result.bands)).size, 3, 'the three health bands stay distinct colours')
	assert.ok(result.damaged.every(d => d.width >= 1), 'fill width is never zero')
	assert.equal(result.treeLive, result.nonRenderableExpected, 'live tree scenery gets no health bar even if damaged')
	assert.equal(result.nonRenderableLive, result.nonRenderableExpected, 'unrenderable live actors have no health bar')
	assert.equal(result.withSelection, 4, 'a selected healthy actor adds one bar and a selected damaged one is not doubled')
	assert.equal(result.frozenVisibleCell, 3, 'a frozen record on a visible cell draws no bar of its own')
	assert.deepEqual(result.frozenExploredCell, [{ fill: result.bands.warning }], 'a damaged frozen record on an explored-unseen cell draws one bar from frozen health (90/255 → yellow) while hidden live actors draw none')
	assert.equal(result.nonRenderableFrozen, 0, 'unrenderable frozen actors have no health bar')
	assert.equal(result.duplicateFrozen, 0, 'a frozen record duplicated by a live actor has no extra health bar')
	assert.equal(result.cleared, 0, 'bars vanish when health returns to full')
	console.log(`${TOOL}: PASS — ${result.actors} dev actors: 0 bars at full health, 3 damaged bars in green/yellow/red, ` +
		'selection adds exactly one, frozen structures draw only from frozen data on explored-unseen cells')
} finally {
	await browser?.close()
	await stopChild(preview.server)
}
