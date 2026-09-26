#!/usr/bin/env node
// STEELSEED — tools/unitlook
//
// Measures the rendered appearance of UNITS ONLY, by differencing a frame containing actors
// against a byte-identical frame containing none.
//
// This exists because I could not judge my own work. Three material changes landed on one
// day — mask coverage, paint mix, player-colour palette — each verified at its own layer and
// none verified end to end, because every whole-frame statistic is dominated by terrain. A
// chroma average over the last shot returned meanSat 0.371 with a max of 0.940, and the max
// was vegetation rather than a hull.
//
// It also exists because I misread the same frame twice in one session: once concluding the
// player-colour mask covered ~90% of a unit when the baked texture measures 39%, and once
// reading freshly generated archetype hulls as the old class hulls they had replaced. A
// glance is not a measurement, and this project has four recorded measurement failures that
// all returned confident, plausible, wrong numbers.
//
// METHOD. Two arms differing in exactly one parameter — `devactors` — with the same seed,
// same map size, same time of day, same camera, same frame count. Every pixel that differs
// belongs to a unit or to a unit's shadow. Statistics are then taken inside that mask.
//
// WHY DIFFERENCING RATHER THAN AN ID BUFFER. An object-id target would be exact, but it is a
// §12.2 render-contract addition — a new attachment, written every frame, for a tool. This
// needs nothing from the renderer, cannot drift from what the renderer actually draws, and
// measures the SHIPPING path rather than a debug one. Its cost is that a unit's shadow and
// its TAA halo count as unit pixels; that is stated below rather than hidden, and it is why
// the shadow-suppressed control exists.
//
// CONTROLS, because a difference image is exactly the kind of instrument that returns a
// confident empty result:
//   - `--falsify=null` runs BOTH arms with zero actors. The mask must come out empty. If it
//     does not, the two arms are not comparable and every number below is noise.
//   - Mask coverage is always reported. A mask of a few hundred pixels cannot support a
//     saturation average, and the tool says so rather than printing a mean over nothing.
//
// Usage:
//   node tools/unitlook.mjs [--actors n] [--cluster n] [--size n] [--tod n] [--falsify=null] [--json]

import { chromium } from 'playwright'
import { spawnProcessGroup, stopProcessGroup } from './process-group.mjs'

const TOOL = 'unitlook'
const WEB = new URL('..', import.meta.url).pathname
const arg = (n, d) => {
	const hit = process.argv.find(a => a.startsWith(`--${n}=`))
	return hit ? hit.slice(n.length + 3) : d
}
const ACTORS = Number(arg('actors', 14))
const CLUSTER = Number(arg('cluster', 5))
const SIZE = Number(arg('size', 48))
const TOD = arg('tod', '600')
const PORT = Number(arg('port', 8823))
const falsify = arg('falsify', null)
const asJson = process.argv.includes('--json')

// Refuse an occupied port. profile.mjs learned this the expensive way: --strictPort makes
// vite exit, the poll then answers from the OLDER server, and the tool measures an unknown
// build while reporting a confident number.
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

const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-angle=metal'] })
let exitCode = 0
try {
	const ctx = await browser.newContext({ viewport: { width: 900, height: 620 }, deviceScaleFactor: 1 })

	/** Render one arm and return raw RGBA. Frames are driven manually so both arms converge TAA identically. */
	async function arm(actorCount) {
		const page = await ctx.newPage()
		const errors = []
		page.on('pageerror', e => errors.push(e.message))
		const q = `devmap=1&seed=demo&devsize=${SIZE}&quality=high&devtod=${TOD}` +
			`&devactors=${actorCount}&devcluster=${CLUSTER}`
		await page.goto(`http://127.0.0.1:${PORT}/index.html?${q}`, { waitUntil: 'load', timeout: 60000 })
		await page.waitForFunction(() => globalThis.steelseed !== undefined, undefined,
			{ timeout: 120000, polling: 100 })
		await sleep(900)
		const data = await page.evaluate(async () => {
			const app = globalThis.steelseed
			app.stop()
			// Fixed timestamps: both arms must walk the same jitter sequence or TAA alone
			// produces a difference and the mask fills with noise.
			for (let i = 0; i < 90; i++) app.renderOneFrame(i * (1000 / 60))
			const cv = app.ctx.canvas
			const c = document.createElement('canvas')
			c.width = cv.width; c.height = cv.height
			c.getContext('2d').drawImage(cv, 0, 0)
			const d = c.getContext('2d').getImageData(0, 0, c.width, c.height)
			return { w: d.width, h: d.height, px: Array.from(d.data) }
		})
		await page.close()
		if (errors.length > 0) throw new Error(`${TOOL}: page errors: ${errors.slice(0, 2).join(' | ')}`)
		return data
	}

	const withUnits = await arm(falsify === 'null' ? 0 : ACTORS)
	const without = await arm(0)
	if (withUnits.w !== without.w || withUnits.h !== without.h)
		throw new Error(`${TOOL}: arms differ in size — not comparable`)

	// Difference mask. The threshold is deliberately low: a unit edge against similar terrain
	// differs by only a few code values, and a high threshold would silently drop exactly the
	// silhouette pixels that matter most.
	const A = withUnits.px, B = without.px
	const n = withUnits.w * withUnits.h
	const mask = new Uint8Array(n)
	let masked = 0
	for (let i = 0; i < n; i++) {
		const o = i * 4
		const d = Math.abs(A[o] - B[o]) + Math.abs(A[o + 1] - B[o + 1]) + Math.abs(A[o + 2] - B[o + 2])
		if (d > 10) { mask[i] = 1; masked++ }
	}

	const coverage = masked / n
	if (falsify === 'null') {
		// Both arms had zero actors. Anything above a trace means the arms are not comparable
		// and every statistic this tool prints is noise.
		const ok = coverage < 0.002
		console.log(`${TOOL}: --falsify=null coverage ${(coverage * 100).toFixed(3)}% (${masked} px)`)
		if (ok) {
			console.error(`${TOOL}: FAIL — the null arm produced an EMPTY mask, which is what it should do,`)
			console.error(`${TOOL}: so this run proves the differencing works and is NOT a measurement.`)
			console.error(`${TOOL}: A falsifier that passes is a method failure, never a green.`)
			exitCode = 1
		} else {
			console.error(`${TOOL}: FAIL — two identical arms differ over ${(coverage * 100).toFixed(3)}% of the frame.`)
			console.error(`${TOOL}: The arms are not comparable; unit statistics from this harness are noise.`)
			exitCode = 1
		}
	} else {
		// Split the mask into BODY and SHADOW.
		//
		// A unit's shadow is a differing pixel too, and it is DARKER than the ground it
		// replaced. Averaging body and shadow together drags the unit's value toward the
		// terrain's and hides exactly the contrast being measured — raising faction albedo by
		// a third moved the combined figure by 0.004, which is what exposed this.
		//
		// The discriminator needs nothing extra: a shadow pixel is darker than the SAME pixel
		// in the actor-free frame, a lit body pixel generally is not. Pixels that are darker
		// but also strongly chromatic are kept as body, because a dark painted panel is not a
		// shadow.
		let sat = 0, val = 0, cnt = 0
		let rr = 0, gg = 0, bb = 0
		let shadowCnt = 0
		// Peak brightness matters more than the mean for whether a unit CATCHES the eye. A
		// hull that is mean-dark but throws a specular highlight reads instantly; one that is
		// uniformly mid-grey does not. Kept as a distribution rather than a max, because a
		// single blown texel is not a highlight.
		const vals = []
		for (let i = 0; i < n; i++) {
			if (!mask[i]) continue
			const o = i * 4
			const r = A[o], g = A[o + 1], b = A[o + 2]
			const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
			if (mx < 12) continue
			const bmx = Math.max(B[o], B[o + 1], B[o + 2])
			const chroma = mx === 0 ? 0 : (mx - mn) / mx
			if (mx < bmx && chroma < 0.18) { shadowCnt++; continue }
			sat += chroma
			val += mx / 255
			vals.push(mx / 255)
			rr += r; gg += g; bb += b
			cnt++
		}
		// Ground statistics from the SAME frame, outside the mask. Units are read AGAINST the
		// terrain they stand on, so a unit's absolute value says nothing alone — the question
		// §9.1 actually asks ("distinguishable at max zoom-out") is a CONTRAST question, and
		// contrast needs both terms.
		let gsat = 0, gval = 0, gcnt = 0, gr = 0, gg2 = 0, gb2 = 0
		const gvals = []
		for (let i = 0; i < n; i++) {
			if (mask[i]) continue
			const o = i * 4
			const r = B[o], g = B[o + 1], b = B[o + 2]
			const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
			// Skip sky. It is the forward pass's clear value, responds to no lighting knob,
			// and averaging it into "the ground" is RESUME-CLAUDE's trap 4.
			if (mx < 12 || (b > r + 18 && b > g + 10 && mx > 120)) continue
			gsat += (mx - mn) / mx
			gval += mx / 255
			gvals.push(mx / 255)
			gr += r; gg2 += g; gb2 += b
			gcnt++
		}
		vals.sort((a, b) => a - b)
		const q = p2 => (vals.length > 0 ? vals[Math.min(vals.length - 1, Math.floor(vals.length * p2))] : 0)
		const bodyP95 = q(0.95)
		// Ground DYNAMIC RANGE, not just its mean. §14.5 measured that 81% of terrain value
		// variance is BETWEEN surface means rather than from shading, and t1-render-7 records
		// the symptom as "the terrain reads flat". A mean cannot show either; a spread can.
		gvals.sort((a, b) => a - b)
		const gq = f => (gvals.length > 0 ? gvals[Math.min(gvals.length - 1, Math.floor(gvals.length * f))] : 0)
		const unitVal = cnt > 0 ? val / cnt : 0
		const groundVal = gcnt > 0 ? gval / gcnt : 0
		// Weber contrast against the background the unit is actually seen on.
		const contrast = groundVal > 0 ? (unitVal - groundVal) / groundVal : 0

		const out = {
			maskPixels: masked,
			bodyPixels: cnt,
			shadowPixels: shadowCnt,
			coveragePct: +(coverage * 100).toFixed(3),
			meanSaturation: cnt > 0 ? +(sat / cnt).toFixed(4) : null,
			meanValue: cnt > 0 ? +(val / cnt).toFixed(4) : null,
			meanRgb: cnt > 0 ? [Math.round(rr / cnt), Math.round(gg / cnt), Math.round(bb / cnt)] : null,
			groundSaturation: gcnt > 0 ? +(gsat / gcnt).toFixed(4) : null,
			groundValue: gcnt > 0 ? +groundVal.toFixed(4) : null,
			groundRgb: gcnt > 0 ? [Math.round(gr / gcnt), Math.round(gg2 / gcnt), Math.round(gb2 / gcnt)] : null,
			bodyValueP95: +bodyP95.toFixed(4),
			// The number that decides whether a unit CATCHES the eye, as opposed to whether it
			// can be told apart once found.
			peakContrast: groundVal > 0 ? +((bodyP95 - groundVal) / groundVal).toFixed(4) : 0,
			groundP05: +gq(0.05).toFixed(4),
			groundP50: +gq(0.50).toFixed(4),
			groundP95: +gq(0.95).toFixed(4),
			// p95/p05. A flat surface sits near 1.0 whatever its mean.
			groundDynamicRange: gq(0.05) > 0 ? +(gq(0.95) / gq(0.05)).toFixed(3) : 0,
			weberContrast: +contrast.toFixed(4),
			actors: ACTORS,
		}
		if (asJson) console.log(JSON.stringify(out, null, 2))
		else {
			console.log(`${TOOL}: ${ACTORS} actors — mask ${masked} px (${out.coveragePct}% of frame)`)
			// Below a few thousand pixels a mean is dominated by edges and TAA halo. Say so
			// rather than printing a number that reads as authoritative.
			if (masked < 3000)
				console.log(`${TOOL}: mask is small; treat the means as indicative, not as a measurement`)
			console.log(`${TOOL}: body ${out.bodyPixels} px, shadow ${out.shadowPixels} px (shadow excluded from the means below)`)
			console.log(`${TOOL}: unit BODY — saturation ${out.meanSaturation} value ${out.meanValue} rgb(${out.meanRgb})`)
			console.log(`${TOOL}: ground value p05 ${out.groundP05} p50 ${out.groundP50} p95 ${out.groundP95} — dynamic range ${out.groundDynamicRange}x`)
			console.log(`${TOOL}: ground pixels — saturation ${out.groundSaturation} value ${out.groundValue} rgb(${out.groundRgb})`)
			// The number §9.1's zoom-out test actually turns on. Negative means units are
			// DARKER than the ground they stand on.
			console.log(`${TOOL}: unit body p95 value ${out.bodyValueP95} — peak contrast ${out.peakContrast >= 0 ? '+' : ''}${out.peakContrast}`)
			console.log(`${TOOL}: unit-vs-ground Weber contrast ${out.weberContrast >= 0 ? '+' : ''}${out.weberContrast}`)
			console.log(`${TOOL}: includes unit shadows and TAA halo; that is the cost of differencing over an id buffer`)
		}
	}
} catch (err) {
	console.error(`${TOOL}: FAIL — ${err.message}`)
	exitCode = 1
} finally {
	// Each cleanup step wrapped: a throw in one must not skip the next. profile leaked a vite
	// for eight minutes exactly this way, and that leak then broke the NEXT three runs.
	try { await browser.close() } catch {}
	try { stopProcessGroup(server) } catch {}
}
process.exit(exitCode)
