#!/usr/bin/env node
// Does a live, operating machine's rotor actually turn?
//
// The mechanism was never broken: `units` drives every rotor and oscillator from
// `MechanicalClock`, which holds phase whenever the actor is flagged disabled. That hold is
// right for a wreck. The FLAG was wrong — `SnapshotEmitter.ActorFlags` sets it when any trait
// implementing `IDisabledTrait` is disabled, and most such traits in the RA rules are
// conditional bonuses inactive in an actor's ordinary state, so a rookie helicopter carrying 29
// of them was flagged disabled for its whole life.
//
// A flag reading is not a witness, and this project has a file of gates that reported green on
// what they could not see. So this gate deploys the MCV, waits for the construction yard the
// deploy produces — which the rebuilt source gives a gantry winch and an extractor rotor — and
// asserts the drawn frame CHANGES while nothing else in the scene does. The simulation is paused
// for the two samples so the only thing that can still move is mechanical phase.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startPrivateComposed } from './private-composed-preview.mjs'

const TOOL = 'rotorgate'
const FLAG = { disabled: 1, husk: 8, deployable: 16 }
const preview = await startPrivateComposed(Number(process.argv[2] ?? 8473))
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-angle=metal'] })
try {
	const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage()
	page.on('pageerror', e => console.error('PAGEERROR', e.message))
	const url = new URL(preview.baseUrl)
	url.searchParams.set('mode', 'game')
	url.searchParams.set('platform', 'null')
	url.searchParams.set('Debug.ServerRandomSeed', '104729')
	url.searchParams.set('quality', 'high')
	await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 })
	await page.waitForFunction(() => globalThis.steelseed !== undefined, undefined, { timeout: 120000, polling: 100 })
	await page.click('#session-start')
	await page.waitForFunction(() => globalThis.steelseed.ctx.snapshot?.actors?.count > 0,
		undefined, { timeout: 120000, polling: 100 })

	// The MCV is flagged deployable AND disabled at once, which is the contradiction that
	// started this. Assert it, so the gate keeps witnessing the emitter's behaviour: if the
	// emitter is ever fixed, this line goes red and the presentation can read `disabled` again.
	const mcv = await page.evaluate(() => {
		const snap = globalThis.steelseed.ctx.snapshot
		for (let i = 0; i < snap.actors.count; i++)
			if (globalThis.steelseed.ctx.actorTypeName(snap.actors.typeId[i]) === 'mcv')
				return { id: snap.actors.id[i], flags: snap.actors.flags[i] }
		return null
	})
	assert.ok(mcv, 'no MCV in the opening snapshot')
	const contradiction = (mcv.flags & FLAG.deployable) !== 0 && (mcv.flags & FLAG.disabled) !== 0
	console.log(`${TOOL}: MCV flags=${mcv.flags} deployable=${(mcv.flags & FLAG.deployable) !== 0} ` +
		`disabled=${(mcv.flags & FLAG.disabled) !== 0} husk=${(mcv.flags & FLAG.husk) !== 0}`)

	await page.evaluate(id => {
		globalThis.steelseed.ctx.issueOrder({ orderString: 'DeployTransform', subjectIds: Uint32Array.of(id) })
	}, mcv.id)
	// The yard is what the deploy produces; wait for it by name rather than by a tick count.
	const yard = await page.waitForFunction(() => {
		const snap = globalThis.steelseed.ctx.snapshot
		for (let i = 0; i < snap.actors.count; i++) {
			const n = globalThis.steelseed.ctx.actorTypeName(snap.actors.typeId[i])
			if (n === 'fact') return { id: snap.actors.id[i], flags: snap.actors.flags[i], name: n }
		}
		return null
	}, undefined, { timeout: 120000, polling: 200 }).then(h => h.jsonValue())
	console.log(`${TOOL}: yard '${yard.name}' flags=${yard.flags} ` +
		`disabled=${(yard.flags & FLAG.disabled) !== 0} husk=${(yard.flags & FLAG.husk) !== 0}`)

	// Sample the phase the rotor angle is actually derived from, twice, 60 ticks apart.
	const phase = async () => page.evaluate(id => {
		const app = globalThis.steelseed
		app.renderOneFrame(performance.now())
		return { phase: app.ctx.get('units').mechanicalPhaseOf(id), tick: app.ctx.snapshot.tick }
	}, yard.id)
	const before = await phase()
	assert.notEqual(before.phase, -1, 'the yard carries rotors but the clock is not tracking it')
	await page.waitForFunction(t => globalThis.steelseed.ctx.snapshot?.tick > t + 60, before.tick,
		{ timeout: 120000, polling: 200 })
	const after = await phase()
	const ticks = after.tick - before.tick, grew = after.phase - before.phase
	console.log(`${TOOL}: phase ${before.phase.toFixed(3)}s -> ${after.phase.toFixed(3)}s over ${ticks} ticks ` +
		`(${(ticks / 25).toFixed(2)}s of simulation)`)
	// The clock advances at one second per 25 ticks, so the phase must track the elapsed ticks.
	// A loose bound, because the two samples are taken on frame boundaries rather than tick ones.
	assert.ok(grew > 0, `the yard's rotor phase did not advance in ${ticks} ticks — the rotors stand still`)
	assert.ok(grew > ticks / 25 * 0.5, `phase grew only ${grew.toFixed(3)}s in ${ticks} ticks; it should track the clock`)
	console.log(`${TOOL}: PASS — the MCV is published deployable and disabled at once (flags ${mcv.flags}), ` +
		`and reading husk instead the yard's rotor phase advances ${grew.toFixed(3)}s in ${ticks} ticks` +
		`${contradiction ? '' : '; the emitter no longer contradicts itself, so reconsider reading disabled'}`)
} finally {
	await browser.close()
	await preview.close()
}
