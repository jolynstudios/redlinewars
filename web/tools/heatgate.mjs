// STEELSEED — the Atomic's heat shimmer, in a real match (vfx.md Epic 7: "a broad, dissipating
// blast-dust front plus restrained heat distortion"; Ultra+).
//
// The composed game at Ultra+ (and at Ultra for the negative), a missile silo, the Atomic fired
// through OpenRA's own order onto open ground in view. From the detonation on:
//   - the strike submits a shimmer every frame for its six seconds, then none (fx and renderer
//     counters), so the post shader's bend is live exactly as long as the heat;
//   - the post shader that carries it compiled and ran: no GPU validation error, no page error;
//   - no pipeline was created by the detonation (the bend rides the existing post pipeline);
//   - at Ultra there is no shimmer at all.
// Frames at +0.5 s and +2 s are kept for the eye.
//
// Usage (from web/, after `vite build` and compose): node tools/heatgate.mjs [--quality=ultra-max|ultra]
import assert from 'node:assert/strict'
import { openLiveMatch } from './live-match.mjs'
import { decodePng } from './png.mjs'

const QUALITY = process.argv.find(a => a.startsWith('--quality='))?.split('=')[1] ?? 'ultra-max'
const m = await openLiveMatch({ tool: `heatgate-${QUALITY}`, port: 8477, quality: QUALITY, viewport: { width: 1920, height: 1080 } })
try {
	const consoleErrors = []
	m.page.on('console', msg => { if (msg.type() === 'error' || msg.type() === 'warning') consoleErrors.push(msg.text().slice(0, 200)) })
	await m.devAll()
	await m.gate(() => globalThis.__live.playerOrder('DevGiveCash'))
	const yard = await m.yard()
	await m.build('mslo')
	await m.gate(() => {
		const app = globalThis.steelseed
		globalThis.__atomic = null
		app.events.on('sim:projectile:impact', e => {
			const view = app.ctx.snapshot?.view
			if (!view || e.byteLength < 24 || globalThis.__atomic) return
			if (app.ctx.actorTypeName(view.getUint16(e.offset + 22, true)).toLowerCase() === 'atomic') globalThis.__atomic = performance.now()
		})
	})
	const key = await m.waitFor(() => globalThis.__live.powers().find(p => /Nuke/.test(p.key) && p.ready)?.key ?? false, undefined, 'the nuke ready', 120000)
	const target = { x: Math.floor(yard.x) + 16, y: Math.floor(yard.y) + 6 }
	await m.hideHud()
	await m.view(target.x + 0.5, target.y + 0.5, { zoom: -1 })
	const pipelinesBefore = await m.gate(() => globalThis.steelseed.ctx.get('render').stats.pipelineCreations)
	const reply = await m.gate(({ key, x, y }) => globalThis.__live.playerOrder(key, { targetCell: { x, y }, extraData: 0xFFFFFFFF }), { key, ...target })
	assert.match(reply, /^ok/, `the nuke order was refused: ${reply}`)
	await m.waitFor(() => globalThis.__atomic !== null, undefined, 'the Atomic detonation', 60000)
	// Sample the counters every animation frame for eight seconds of simulation time, in the page,
	// while the frames are photographed from here.
	await m.gate(() => {
		const ctx = globalThis.steelseed.ctx, render = ctx.get('render'), fx = ctx.get('fx'), t0 = ctx.snapshot.tick
		globalThis.__heat = { done: false, samples: [] }
		const step = () => {
			const s = (ctx.snapshot.tick - t0) / 25
			globalThis.__heat.samples.push({ s, drawn: render.stats.heatSources, fx: fx.nuclearStats.heatNow })
			if (s < 8) requestAnimationFrame(step); else globalThis.__heat.done = true
		}
		requestAnimationFrame(step)
	})
	await m.page.waitForTimeout(500); await m.shot(`heat-${QUALITY}-0.5s`)
	// The bend itself: the simulation paused, the smoke stands still while the shimmer keeps
	// moving on the frame clock, so two frames a quarter second apart differ in its disc alone.
	await m.gate(() => globalThis.__live.paused(true))
	await m.page.waitForTimeout(500)
	const disc = await m.gate(() => { const r = globalThis.steelseed.ctx.get('render'); return { x: r.heatPacked[0], y: r.heatPacked[1], r: r.heatPacked[2], count: r.stats.heatSources } })
	const a = decodePng(await m.page.screenshot()), b = (await m.page.waitForTimeout(250), decodePng(await m.page.screenshot()))
	await m.gate(() => globalThis.__live.paused(false))
	const diff = (inside) => {
		let sum = 0, n = 0
		for (let y = 0; y < a.height; y += 2) for (let x = 0; x < a.width; x += 2) {
			const d = Math.hypot(x - disc.x, y - disc.y), within = disc.count > 0 && d < disc.r * 0.7
			if (inside ? !within : (disc.count > 0 && d < disc.r * 1.6)) continue
			const o = (y * a.width + x) * 4
			sum += Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1]) + Math.abs(a.data[o + 2] - b.data[o + 2]); n++
		}
		return n ? sum / n / 3 : 0
	}
	const bend = { inside: diff(true), outside: diff(false), disc }
	await m.page.waitForTimeout(1200); await m.shot(`heat-${QUALITY}-2s`)
	await m.waitFor(() => globalThis.__heat.done, undefined, 'eight seconds after the detonation', 30000)
	const samples = await m.gate(() => globalThis.__heat.samples)
	const shimmering = samples.filter(s => s.drawn > 0)
	const lastLit = shimmering.at(-1)?.s ?? -1
	const pipelinesAfter = await m.gate(() => globalThis.steelseed.ctx.get('render').stats.pipelineCreations)
	assert.equal(pipelinesAfter, pipelinesBefore, 'the detonation created a pipeline')
	assert.deepEqual(m.errors, [], 'page errors')
	const gpuErrors = consoleErrors.filter(e => /WGSL|shader|GPUValidationError|Invalid|binding/i.test(e))
	assert.deepEqual(gpuErrors, [], 'GPU validation errors')
	if (QUALITY === 'ultra-max') {
		assert.ok(shimmering.length > 20, `the shimmer never drew (${shimmering.length} frames)`)
		assert.ok(lastLit <= 6.2, `the shimmer outlived its six seconds (${lastLit} s)`)
		assert.ok(samples.at(-1).drawn === 0, 'the shimmer must be gone at the end')
		assert.ok(bend.disc.count > 0 && bend.inside > 0.5 && bend.inside > 4 * bend.outside, `the frozen frame must move inside the disc only: ${JSON.stringify(bend)}`)
		console.log(`heatgate ${QUALITY}: PASS — the Atomic shimmered in ${shimmering.length} of ${samples.length} frames, the last at +${lastLit.toFixed(2)} s; frozen frames differ by ${bend.inside.toFixed(2)} inside the ${Math.round(bend.disc.r)} px disc and ${bend.outside.toFixed(2)} outside; no pipeline created, no GPU error`)
	} else {
		assert.equal(shimmering.length, 0, `Ultra must not shimmer (${shimmering.length} frames)`)
		console.log(`heatgate ${QUALITY}: PASS — the Atomic drew no shimmer at ${QUALITY} (frozen frames differ by ${bend.outside.toFixed(2)}); no pipeline created, no GPU error`)
	}
} finally {
	await m.close()
}
