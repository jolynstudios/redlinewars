// STEELSEED — what smoke and dust cost the GPU against their projected coverage (vfx.md Epic 8:
// "rendered smoke/dust cards ... additionally constrained by projected coverage"; "enforce
// fill-rate and screen-coverage limits as well as object counts").
//
// A real match at 1920x1080, device pixel ratio 1, with the GPU pass timer (?gputime=1, WebGPU
// developer features so the stamps are not quantised). The session is paused, so nothing but
// the added smoke changes between steps: the same camera, the same world, the same frame. Smoke
// bursts (the `smoke` preset, half-way through their life so they stand at working size) are
// added in steps in front of the camera; each step holds for a measured window and records the
// pool's projected coverage and the GPU frame and forward-pass times.
//
// Calibration: the tier's `coverageBudget` (fx/vfx-budget) must hold the smoke's added GPU cost
// inside the headroom the battle baseline leaves under the qualification gate (GPU frame p95
// <= 14 ms; measured battle p95 7.3 ms Ultra, 7.55 ms Ultra+): 3.0 ms at Ultra, 4.5 ms at Ultra+.
// With --check, the budget is ON and the gate asserts the drawn smoke stays within that cost
// whatever is spawned.
//
// Usage (from web/, after `vite build` and compose):
//   node tools/coveragegate.mjs [--quality=ultra|ultra-max] [--check]
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { openLiveMatch } from './live-match.mjs'

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback
const QUALITY = arg('quality', 'ultra')
const CHECK = process.argv.includes('--check')
const ALLOWANCE_MS = { ultra: 3.0, 'ultra-max': 4.5 }[QUALITY]
assert.ok(ALLOWANCE_MS, `unknown quality ${QUALITY}`)
const STEPS = [0, 4, 8, 16, 32, 64, 128, 192, 256]

const m = await openLiveMatch({ tool: `coveragegate-${QUALITY}`, port: 8472, viewport: { width: 1920, height: 1080 }, quality: QUALITY,
	params: '&gputime=1', extraArgs: ['--enable-webgpu-developer-features'] })
const rows = []
try {
	const yard = await m.yard()
	const at = { x: Math.floor(yard.x) + 5.5, y: Math.floor(yard.y) + 5.5 }
	await m.view(at.x, at.y, { zoom: 1, settleMs: 1500 })
	await m.gate(() => globalThis.__live.paused(true))
	await m.page.waitForTimeout(1500)
	const budget = await m.gate(() => globalThis.steelseed.ctx.get('fx').budget?.coverageBudget ?? null)
	let spawned = 0
	for (const bursts of STEPS) {
		// Add bursts up to this step: a ring of puffs around the focus, half-way through their life.
		await m.gate(({ from, to, x, z }) => {
			const fx = globalThis.steelseed.ctx.get('fx'), terrain = globalThis.steelseed.ctx.get('terrain')
			const time = fx.effectTime, open = { isVisible: () => true }
			for (let k = from; k < to; k++) {
				const a = k * 2.399963, r = 0.4 + 0.22 * Math.sqrt(k)
				const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r
				fx.particles.spawn('smoke', px, terrain.heightAt(px, pz) + 0.6 + (k % 5) * 0.25, pz, time - 1.9, 7919 * (k + 1), 1, open)
			}
		}, { from: spawned, to: bursts, x: at.x, z: at.y })
		spawned = bursts
		await m.page.waitForTimeout(700)
		const sample = await m.gate(async () => {
			const ctx = globalThis.steelseed.ctx, render = ctx.get('render'), fx = ctx.get('fx')
			const start = render.gpuTimer?.latest?.frame ?? 0
			await new Promise(r => setTimeout(r, 2500))
			const frames = (render.gpuTimer?.history ?? []).filter(f => f.frame > start)
			const pct = (v, p) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null }
			const forward = frames.map(f => f.passes.filter(p => /forward/.test(p.label)).reduce((t, p) => t + p.exclusiveMs, 0))
			// The smoke's own pass (render/atmosphere): its begin-to-end time, free of the other
			// passes' variance that the frame total carries.
			const smoke = frames.map(f => f.passes.filter(p => p.label === 'render.atmosphere').reduce((t, p) => t + p.ms, 0))
			const s = fx.particles.stats
			return { frames: frames.length, gpuP50: pct(frames.map(f => f.totalMs), .5), gpuP95: pct(frames.map(f => f.totalMs), .95),
				forwardP50: pct(forward, .5), smokeP50: pct(smoke, .5), coverage: s.coverage, drawnCoverage: s.drawnCoverage, alive: s.alive, submitted: s.submitted, thinned: s.thinned }
		})
		assert.ok(sample.frames > 20, `too few GPU-timed frames (${sample.frames}); is ?gputime=1 honoured?`)
		rows.push({ bursts, ...sample })
		console.log(`  ${String(bursts).padStart(3)} bursts: coverage ${sample.coverage.toFixed(2)} (drawn ${sample.drawnCoverage.toFixed(2)}), ${sample.alive} alive, ${sample.thinned} thinned; GPU frame p50 ${sample.gpuP50.toFixed(2)} ms, p95 ${sample.gpuP95.toFixed(2)} ms, forward p50 ${sample.forwardP50.toFixed(2)} ms, smoke pass p50 ${sample.smokeP50.toFixed(2)} ms`)
	}
	await m.shot(`coverage-${QUALITY}`)
	const base = rows[0]
	// Cost per unit of drawn coverage: a least-squares line through the origin of the added GPU
	// time against the drawn coverage, over the steps that drew smoke.
	const pts = rows.slice(1).map(r => ({ c: r.drawnCoverage, t: r.gpuP50 - base.gpuP50 }))
	const slope = pts.reduce((s, p) => s + p.c * p.t, 0) / Math.max(1e-9, pts.reduce((s, p) => s + p.c * p.c, 0))
	const suggested = ALLOWANCE_MS / Math.max(1e-6, slope)
	const smokePts = rows.slice(1).map(r => ({ c: r.drawnCoverage, t: r.smokeP50 - base.smokeP50 }))
	const smokeSlope = smokePts.reduce((s, p) => s + p.c * p.t, 0) / Math.max(1e-9, smokePts.reduce((s, p) => s + p.c * p.c, 0))
	const peak = rows.at(-1)
	const added = peak.gpuP50 - base.gpuP50
	// The VFX resource account at the qualification resolution, against vfx.md's provision.
	const vfxBytes = await m.gate(() => globalThis.steelseed.ctx.get('render').vfxBytes)
	const PROVISION_MIB = { ultra: 128, 'ultra-max': 192 }[QUALITY]
	assert.ok(vfxBytes && vfxBytes.total > 0 && vfxBytes.total <= PROVISION_MIB * 1024 * 1024, `VFX GPU memory ${JSON.stringify(vfxBytes)} over ${PROVISION_MIB} MiB`)
	console.log(`coveragegate ${QUALITY}: VFX-owned GPU memory ${(vfxBytes.total / 1024 / 1024).toFixed(2)} MiB (meshes ${(vfxBytes.meshes / 1024).toFixed(0)} KiB, particles ${(vfxBytes.particles / 1024).toFixed(0)} KiB) of the ${PROVISION_MIB} MiB provision`)
	const report = { date: new Date().toISOString(), quality: QUALITY, check: CHECK, coverageBudget: budget, allowanceMs: ALLOWANCE_MS,
		msPerCoverage: +slope.toFixed(4), smokePassMsPerCoverage: +smokeSlope.toFixed(4), suggestedBudget: +suggested.toFixed(1), peakAddedMs: +added.toFixed(2), vfxBytes, provisionMiB: PROVISION_MIB, rows }
	const out = resolve(import.meta.dirname, '../../docs/vfx/baseline')
	mkdirSync(out, { recursive: true })
	writeFileSync(join(out, `coverage-${QUALITY}${CHECK ? '-check' : ''}.json`), JSON.stringify(report, null, '\t') + '\n')
	console.log(`coveragegate ${QUALITY}: ${slope.toFixed(3)} ms per unit of drawn coverage (the smoke pass alone ${smokeSlope.toFixed(3)}); the ${ALLOWANCE_MS} ms allowance buys ${suggested.toFixed(1)}; budget in force ${budget}`)
	if (CHECK) {
		assert.ok(Number.isFinite(budget), 'the tier has no coverage budget')
		assert.ok(peak.drawnCoverage <= budget * 1.15, `drawn coverage ${peak.drawnCoverage.toFixed(2)} above the budget ${budget}`)
		assert.ok(added <= ALLOWANCE_MS, `smoke added ${added.toFixed(2)} ms, above the ${ALLOWANCE_MS} ms allowance`)
		console.log(`coveragegate ${QUALITY}: PASS — ${peak.alive} particles alive, coverage ${peak.coverage.toFixed(1)} demanded, ${peak.drawnCoverage.toFixed(1)} drawn (budget ${budget}), +${added.toFixed(2)} ms GPU`)
	}
	assert.deepEqual(m.errors, [], 'page errors')
} finally {
	await m.close()
}
