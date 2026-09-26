#!/usr/bin/env node
// STEELSEED — tools/terrainlook
//
// Captures the §5.6 debug views over ground pixels and reports, per view, whether that term is
// CONSTANT or VARYING across the frame. That is a deliberately small claim, and the history
// below is why it is the only claim this instrument is entitled to make.
//
// WHAT THIS ANSWERS. "The terrain reads flat" is not actionable while the frame is a product of
// albedo, geometry, shadowing and occlusion — any one of them could be the missing signal. A
// term that is constant across the whole frame contributes no FORM, whatever its level. That is
// answerable here, and it is worth answering: it separates "this term is doing nothing" from
// "this term is doing something I do not like."
//
// WHAT THIS DOES NOT ANSWER, and must not be read as answering:
//
//   - AMPLITUDE. Every debug view leaves the forward pass and then goes through TAA, auto
//     exposure (shaders.ts:1195 is a TEMPORAL adaptation, `exposure[0] = prev + (wanted-prev)*alpha`),
//     AgX and dither. Each view is captured over its own 60 frames, so each meters its own
//     exposure. Numbers from different views are therefore NOT comparable as factor amplitudes
//     and this tool deliberately does not rank them. What survives a per-view monotonic
//     transform is the within-view ordinal question — constant versus varying — because a
//     constant stays constant under any monotone map.
//   - CAUSATION. An earlier revision printed "the flattest term is the one starving the frame."
//     That is backwards for a multiplicative term: visibility constant at 1 passes all light and
//     starves nothing. It confidently fingered a HEALTHY sunVisibility. Level and spread are
//     both printed now, and no verdict is.
//   - LOCAL FORM. Global percentiles cannot establish spatial structure; t1-render-7:131-134
//     asks for a same-frame sun-facing-versus-away metric and this tool does not provide it.
//
// SPREAD IS ABSOLUTE, NOT A RATIO. p95/p05 was the original statistic and it failed silently at
// grazing sun: when p05 reaches 0 the guard returned "0.000x", which prints as if it meant no
// variation when it actually means the widest variation possible — the signal reaching zero.
// Both grazing-sun runs hit it. p95-p05 has no such hole.
//
// CONTROLS, one per failure mode:
//   --falsify=constant  pushes a synthetic constant through the statistic; spread must be 0.
//                       Tests the arithmetic only, and cannot see the renderer at all.
//   --falsify=frozen    captures the SAME view under every label, skipping the view switch.
//                       Every row must come back identical. This is the main-path witness: it
//                       catches a dead setDebugView, a stale capture and a bad ground mask,
//                       none of which the arithmetic control can see.
//
// Usage:
//   node tools/terrainlook.mjs [--size n] [--tod n] [--falsify=constant|frozen] [--json]

import { chromium } from 'playwright'
import { spawnProcessGroup, stopProcessGroup } from './process-group.mjs'

const TOOL = 'terrainlook'
const WEB = new URL('..', import.meta.url).pathname
const arg = (n, d) => {
	const hit = process.argv.find(a => a.startsWith(`--${n}=`))
	return hit ? hit.slice(n.length + 3) : d
}
const SIZE = Number(arg('size', 96))
const TOD = arg('tod', '600')
const PORT = Number(arg('port', 8841))
const falsify = arg('falsify', null)
const asJson = process.argv.includes('--json')
const geometry = process.argv.includes('--geometry')

/** Level and absolute spread over an array of 0..1 values. Never a ratio — see the header. */
function statsOf(vals) {
	if (vals.length < 400) return null
	const v = Float64Array.from(vals).sort()
	const q = f => v[Math.min(v.length - 1, Math.floor(v.length * f))]
	const p05 = q(0.05), p50 = q(0.5), p95 = q(0.95)
	return { n: v.length, p05: +p05.toFixed(4), p50: +p50.toFixed(4), p95: +p95.toFixed(4), spread: +(p95 - p05).toFixed(4) }
}

/** Below this, a term carries no form. 4/255 — one dither step above quantisation noise. */
const CONSTANT_SPREAD = 0.0157

if (falsify === 'constant') {
	// Runs before the browser: the claim under test is about the statistic, not the renderer.
	const flat = statsOf(new Array(20000).fill(0.3137))
	console.log(`${TOOL}: --falsify=constant spread ${flat.spread.toFixed(4)} (must be 0.0000)`)
	if (flat.spread === 0) {
		console.error(`${TOOL}: FAIL — the statistic DID collapse on a constant, so it can detect a`)
		console.error(`${TOOL}: term that carries no form. A falsifier that passes is a method proof,`)
		console.error(`${TOOL}: never a green — and this one still cannot see the renderer at all.`)
	} else {
		console.error(`${TOOL}: FAIL — a constant array measured spread ${flat.spread}. The statistic`)
		console.error(`${TOOL}: cannot detect flatness, so every number this tool prints is fiction.`)
	}
	process.exit(1)
}

const occupied = await fetch(`http://127.0.0.1:${PORT}/index.html`, { method: 'HEAD' })
	.then(() => true).catch(() => false)
if (occupied) {
	console.error(`${TOOL}: FAIL — something is already serving port ${PORT}. Kill it or pass --port.`)
	process.exit(2)
}

const server = spawnProcessGroup('npm',
	['exec', 'vite', 'preview', '--', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
	{ cwd: WEB, stdio: ['ignore', 'pipe', 'pipe'] })
const sleep = ms => new Promise(r => setTimeout(r, ms))
for (let i = 0; i < 80; i++) {
	try { if ((await fetch(`http://127.0.0.1:${PORT}/index.html`)).ok) break } catch {}
	await sleep(250)
}

// Declared before the try so the finally can close a browser that failed partway through
// launching. Leaving the launch outside the try leaks the preview server and recreates the
// stale-port trap that this tool's own precondition check exists to catch.
let browser = null
let exitCode = 0
try {
	browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-angle=metal'] })
	const ctx = await browser.newContext({ viewport: { width: 1100, height: 720 }, deviceScaleFactor: 1 })
	const page = await ctx.newPage()
	const errors = []
	page.on('pageerror', e => errors.push(e.message))
	await page.goto(
		`http://127.0.0.1:${PORT}/index.html?devmap=1&seed=demo&devsize=${SIZE}&quality=high&devtod=${TOD}&devactors=0`,
		{ waitUntil: 'load', timeout: 60000 })
	await page.waitForFunction(() => globalThis.steelseed !== undefined, undefined,
		{ timeout: 120000, polling: 100 })
	await sleep(900)

	// `geoNormal` is the geometric normal BEFORE the normal map, and it is here because `nDotL`
	// is not a geometry read: shaders.ts:643 dots `n`, the normal-MAPPED shading normal, so a
	// flat plane wearing a rough material still produces a varying nDotL. Only geoNormal can
	// say whether the terrain has actual relief.
	if (geometry) {
		// The heightfield read straight off `terrain.heightAt()`, with NO renderer in the loop.
		//
		// This exists because the `geoNormal` view cannot answer the question it looks like it
		// answers. That view encodes the normal as n*0.5+0.5 and then sends it through exposure,
		// AgX and an 8-bit swapchain — and AgX compresses hardest near the top of its range,
		// which is exactly where a terrain normal lives (straight up). Measured through it,
		// terrain relief came back as a spread of 0.0157, precisely 4/255. Four quantisation
		// steps is not a measurement of slope; it is a measurement of the display path. Slope
		// in degrees off the source heightfield has no such ceiling.
		const geo = await page.evaluate(() => {
			const app = globalThis.steelseed
			const terrain = app.ctx.get('terrain')
			const w = terrain.cellsWide, h = terrain.cellsHigh
			const ox = terrain.originX, oy = terrain.originY
			let minH = Infinity, maxH = -Infinity
			// Slope at SEVERAL baselines, because one baseline cannot tell relief apart from
			// roughness and the difference is the whole question. A surface can be steep at
			// every cell and still have no landform: 8 m of relief spread over cell-scale steps
			// is texture, while 8 m organised into hills is terrain. A smooth 8 m ramp across
			// 96 m is only atan(8/96) = 4.8 deg, so a much steeper reading at 1 cell means the
			// height is high-frequency — and at RTS zoom the camera sees the coarse scale.
			const scales = [1, 2, 4, 8, 16]
			const out = {}
			for (const r of scales) {
				const slopes = []
				for (let j = r; j < h - r; j++) {
					for (let i = r; i < w - r; i++) {
						const x = ox + i + 0.5, z = oy + j + 0.5
						if (r === 1) {
							const c = terrain.heightAt(x, z)
							if (c < minH) minH = c
							if (c > maxH) maxH = c
						}
						const dx = terrain.heightAt(x + r, z) - terrain.heightAt(x - r, z)
						const dz = terrain.heightAt(x, z + r) - terrain.heightAt(x, z - r)
						// normal = normalize(-dh/dx, 1, -dh/dz) over a 2r metre baseline
						const nx = -dx / (2 * r), nz = -dz / (2 * r)
						const len = Math.hypot(nx, 1, nz)
						slopes.push(Math.acos(Math.min(1, 1 / len)) * 180 / Math.PI)
					}
				}
				out[r] = slopes
			}
			// Cliff census. terrain/grid.connected() slopes the mesh between two cells only
			// when their heights match or one is a declared ramp; anything else emits a
			// VERTICAL WALL quad. devsnapshot marks a one-step (0.5 m) difference as a ramp,
			// so every two-step-or-more neighbour becomes a wall. Walls stand vertical, take
			// almost no sun at ordinary elevations, and therefore render near black — so the
			// fraction of neighbour pairs that are walls IS the fraction of the ground
			// covered in dark banding. This is the number behind the corduroy artifact.
			let pairs = 0, ramps = 0, walls = 0, flats = 0
			const STEP = 0.5
			for (let j = 1; j < h - 1; j++) {
				for (let i = 1; i < w - 1; i++) {
					const c = terrain.heightAt(ox + i + 0.5, oy + j + 0.5)
					for (const [di, dj] of [[1, 0], [0, 1]]) {
						const nb = terrain.heightAt(ox + i + di + 0.5, oy + j + dj + 0.5)
						const steps = Math.round(Math.abs(nb - c) / STEP)
						pairs++
						if (steps === 0) flats++
						else if (steps === 1) ramps++
						else walls++
					}
				}
			}
			return { w, h, minH, maxH, byScale: out, pairs, ramps, walls, flats }
		})
		const reliefM = +(geo.maxH - geo.minH).toFixed(2)
		const rows = []
		for (const r of Object.keys(geo.byScale).map(Number).sort((a, b) => a - b)) {
			const s = Float64Array.from(geo.byScale[r]).sort()
			const q = f => s[Math.min(s.length - 1, Math.floor(s.length * f))]
			rows.push({
				baselineM: 2 * r,
				p50: +q(0.5).toFixed(2),
				p95: +q(0.95).toFixed(2),
				flatFraction: +(s.reduce((a, v) => a + (v < 1 ? 1 : 0), 0) / s.length).toFixed(4),
			})
		}
		// A single smooth landform spanning the map would produce this slope at every baseline.
		// Measured slope falling away as the baseline grows means the height is high-frequency.
		const rampDeg = +(Math.atan(reliefM / geo.w) * 180 / Math.PI).toFixed(2)
		const out = { cells: `${geo.w}x${geo.h}`, reliefM, smoothRampDeg: rampDeg, byBaseline: rows }
		if (asJson) console.log(JSON.stringify(out, null, 2))
		else {
			console.log(`${TOOL}: heightfield ${out.cells} cells, ${out.reliefM} m of relief, read with no renderer`)
			for (const r of rows)
				console.log(`  baseline ${String(r.baselineM).padStart(2)} m   slope p50 ${r.p50.toFixed(2)} deg   p95 ${r.p95.toFixed(2)} deg   flat<1deg ${(r.flatFraction * 100).toFixed(1)}%`)
			console.log(`  a single smooth ramp of ${out.reliefM} m across ${geo.w} m would read ${rampDeg} deg at EVERY baseline`)
			console.log(`  neighbour pairs: ${(100 * geo.flats / geo.pairs).toFixed(1)}% level, ${(100 * geo.ramps / geo.pairs).toFixed(1)}% ramp (sloped mesh), ${(100 * geo.walls / geo.pairs).toFixed(1)}% CLIFF WALL`)
			console.log(`  a cliff wall is vertical, takes almost no sun, and renders near black`)
			console.log(`${TOOL}: slope that falls away as the baseline grows is roughness, not landform.`)
			console.log(`${TOOL}: the camera sees the coarse baselines, so that is the scale that decides`)
			console.log(`${TOOL}: whether the ground reads as terrain or as texture.`)
		}
		exitCode = 0
	} else {

	const VIEWS = ['off', 'albedo', 'geoNormal', 'nDotL', 'sunVisibility', 'ao']
	const raw = await page.evaluate(async ({ views, frozen }) => {
		const app = globalThis.steelseed
		app.stop()
		const render = app.ctx.get('render')
		const out = {}
		for (const view of views) {
			const request = frozen ? 'off' : view
			if (!render.setDebugView(request)) throw new Error(`debug view rejected: ${request}`)
			// Render and read with no await between: a WebGPU canvas is not preserved across a
			// task boundary, and a split read returns a black frame that looks like a result.
			for (let i = 0; i < 60; i++) app.renderOneFrame(i * (1000 / 60))
			const cv = app.ctx.canvas
			const c = document.createElement('canvas')
			c.width = cv.width; c.height = cv.height
			c.getContext('2d').drawImage(cv, 0, 0)
			const d = c.getContext('2d').getImageData(0, 0, c.width, c.height)
			out[view] = { w: d.width, h: d.height, px: Array.from(d.data) }
		}
		render.setDebugView('off')
		return out
	}, { views: VIEWS, frozen: falsify === 'frozen' })
	if (errors.length > 0) throw new Error(`page errors: ${errors.slice(0, 2).join(' | ')}`)

	// Segment ONCE, off the shaded frame, and apply the same pixel set to every view. Deciding
	// sky-versus-ground per view would let each view measure a different population.
	const base = raw.off
	const n = base.w * base.h
	const isGround = new Uint8Array(n)
	let groundN = 0
	for (let i = 0; i < n; i++) {
		const o = i * 4
		const r = base.px[o], g = base.px[o + 1], b = base.px[o + 2]
		const mx = Math.max(r, g, b)
		if (mx < 12) continue
		// Sky is the forward pass's clear value and responds to no lighting knob. Averaging it
		// into "the ground" is RESUME-CLAUDE trap 4.
		if (b > r + 18 && mx > 120) continue
		isGround[i] = 1; groundN++
	}
	if (groundN < 400) throw new Error(`only ${groundN} ground pixels found — the frame is not the map`)

	// geoNormal encodes n*0.5+0.5, so the GREEN channel is the up component under §12.4's Y-up
	// convention: flat ground pins it high, slopes pull it down. Reading max-channel there would
	// mix the two lateral axes in and report a turning slope as a flat one.
	const channelFor = view => (view === 'geoNormal' ? 1 : -1)
	const collect = view => {
		const px = raw[view].px
		const ch = channelFor(view)
		const vals = []
		for (let i = 0; i < n; i++) {
			if (!isGround[i]) continue
			const o = i * 4
			vals.push((ch >= 0 ? px[o + ch] : Math.max(px[o], px[o + 1], px[o + 2])) / 255)
		}
		return statsOf(vals)
	}

	const views = {}
	for (const v of VIEWS) views[v] = collect(v)

	if (falsify === 'frozen') {
		// geoNormal is excluded: it reads the green channel by design, so it SHOULD differ here
		// and including it would make the control pass for the wrong reason.
		const rows = VIEWS.filter(v => v !== 'geoNormal').map(v => views[v])
		// Exact equality is the wrong assertion and asserting it was a mistake. Successive
		// captures continue from the previous frame's TAA history and exposure state, so the
		// same view captured twice differs slightly. That difference is not a defect — it is
		// this instrument's NOISE FLOOR, and the number that matters is whether the
		// constant-versus-varying threshold clears it.
		const spreads = rows.map(r => r.spread)
		const noise = Math.max(...spreads) - Math.min(...spreads)
		const margin = CONSTANT_SPREAD / Math.max(noise, 1e-9)
		console.log(`${TOOL}: --falsify=frozen captured 'off' under every label`)
		for (const v of VIEWS) console.log(`  ${v.padEnd(14)} p50 ${views[v].p50.toFixed(4)}  spread ${views[v].spread.toFixed(4)}`)
		console.log(`${TOOL}: noise floor ${noise.toFixed(4)} spread over ${rows.length} captures of one view`)
		console.log(`${TOOL}: CONSTANT threshold ${CONSTANT_SPREAD.toFixed(4)} clears it by ${margin.toFixed(1)}x`)
		if (noise >= CONSTANT_SPREAD) {
			console.error(`${TOOL}: FAIL — the noise floor SWALLOWS the constant threshold. A term`)
			console.error(`${TOOL}: called CONSTANT could be capture jitter, so no verdict is real.`)
		} else {
			console.error(`${TOOL}: FAIL — the floor is below the threshold, so view switching, capture`)
			console.error(`${TOOL}: freshness and the ground mask all reach the statistic and verdicts`)
			console.error(`${TOOL}: survive the jitter. A falsifier that passes is a method proof,`)
			console.error(`${TOOL}: never a green.`)
		}
		exitCode = 1
	} else if (asJson) {
		console.log(JSON.stringify({ groundPixels: groundN, tod: TOD, views }, null, 2))
	} else {
		const label = {
			off: 'delivered        what the player sees',
			albedo: 'albedo           material colour, no lighting',
			geoNormal: 'geoNormal.up     terrain relief, before the normal map',
			nDotL: 'nDotL            sun term on the NORMAL-MAPPED normal',
			sunVisibility: 'sunVisibility    cascaded shadow term',
			ao: 'ao               ambient occlusion term',
		}
		console.log(`${TOOL}: ${groundN} ground pixels at tod ${TOD}, size ${SIZE}`)
		for (const v of VIEWS) {
			const s = views[v]
			if (!s) { console.log(`  ${label[v]}  — too few pixels`); continue }
			const verdict = s.spread < CONSTANT_SPREAD ? 'CONSTANT — carries no form' : 'varying'
			console.log(`  ${label[v].padEnd(50)} p05 ${s.p05.toFixed(4)} p50 ${s.p50.toFixed(4)} p95 ${s.p95.toFixed(4)}  spread ${s.spread.toFixed(4)}  ${verdict}`)
		}
		console.log(`${TOOL}: values are post-exposure and post-AgX and each view metered its own`)
		console.log(`${TOOL}: exposure, so read CONSTANT-vs-varying only. Amplitudes are not`)
		console.log(`${TOOL}: comparable across views and a constant term is not thereby a defect.`)
		console.log(`${TOOL}: geoNormal in particular is NOT a slope measurement — AgX compresses`)
		console.log(`${TOOL}: hardest where terrain normals live. Use --geometry for real slope.`)
	}
	}
} catch (err) {
	console.error(`${TOOL}: FAIL — ${err.message}`)
	exitCode = 1
} finally {
	try { if (browser) await browser.close() } catch {}
	try { stopProcessGroup(server) } catch {}
}
process.exit(exitCode)
