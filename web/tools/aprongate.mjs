#!/usr/bin/env node
// STEELSEED — aprongate
//
// The scenery ring must read as LANDSCAPE, not as an enclosure.
//
// The apron used to be `RISE * smoothstep(2, a, d)^1.4 * (0.70 + 0.30 * noise)`. `d` is the
// distance out of the map, so it climbed to the same 60 m in every direction, and the 0.70
// floor let noise decorate a guaranteed wall by 30%. Measured on a 96x96 map with a 40-cell
// ring, its outer ring ran 41.0-58.8 m with a standard deviation of 4.05 m over 700 samples —
// a bathtub rim. The human: "the arch upwards is ugly".
//
// The thresholds are ratios wherever a ratio is meaningful, because an absolute metre
// threshold encodes the crest height it was written against and goes stale the moment that
// constant is retuned. MEASURED against the old rim by putting it back and running this file,
// which is the only way to know an assertion can fail:
//
//   1  coefficient of variation along the outer ring   old 0.090, floor 0.35    FAILS the rim
//   2  directions that climb monotonically outward     old 51-59/64, ceiling 45 FAILS the rim
//   3  fraction of the ring under 8 m                  old 30-35%, floor 15%    does NOT fail it
//   4  fraction clearing the three-times rule          old 24-27%, floor 6%     does NOT fail it
//
// 3 and 4 do not discriminate and are not pretended to: the near half of any ring is low
// whatever the far half does, so the old rim passed both. They are kept because they are the
// two halves of the AMBITION rather than of the diagnosis — 3 catches a ring that becomes
// mountain everywhere, 4 catches one that quietly loses its mountains — and because reporting
// the pair beside the two that do discriminate is worth more than dropping them. 1 and 2 are
// the assertions that would have caught the bathtub.
//
// It also holds the two invariants the ring exists under: the seam corner heights must equal
// the playable grid's on every border corner (a crack opens the whole boundary), and the
// field must be finite and deterministic for every map shape and ring width.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

/** Smallest sd/mean along the outer ring. The rim measured 0.090 against this. */
const MIN_RING_VARIATION = 0.35
/**
 * Fraction of the ring that must stay open country, under `OPEN_M` above the playable plain.
 *
 * Measured as AREA, not as a count of outward rays. A ray sample aliases badly against a
 * mountain: one massif twenty cells wide subtends about three of sixty-four rays on a 128-cell
 * map, so a ring with real mountains in it reported three summit directions and looked like a
 * failure. Area asks the question the eye asks — how much of the horizon is which.
 *
 * The old rim passed this at 30-35%, because the near half of any ring is low. It is an
 * ambition check, not the diagnosis; see the header.
 */
const MIN_OPEN_AREA = 0.15
const OPEN_M = 8
/** Fraction of the ring that must be genuine mountain. The old rim passed this too, at
 * 24-27%: it guards against losing the mountains, not against getting the wall back. */
const MIN_RANGE_AREA = 0.06
/** Outward directions, of 64, allowed to climb without ever falling back. A bowl is all of them. */
const MAX_MONOTONE_DIRECTIONS = 45
/**
 * Metres a mountain must clear, set by the human on 2026-09-06: three times the tallest
 * building, which is the 14.0 m construction yard. Absolute because the RULE is absolute.
 */
const MOUNTAIN_M = 42

const DIRECTIONS = 64

const web = fileURLToPath(new URL('..', import.meta.url))
const temp = mkdtempSync(join(tmpdir(), 'steelseed-apron-'))
const failures = []
const lines = []
try {
	const outfile = join(temp, 'apron.mjs')
	await build({
		stdin: {
			contents: "export { TerrainGrid } from './src/terrain/grid.ts'\n" +
				"export { ApronGrid, apronWidthFor, APRON_TERRAIN } from './src/terrain/apron.ts'\n" +
				"export { Surface } from './src/core/index.ts'\n",
			resolveDir: web,
			loader: 'ts',
		},
		bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent',
	})
	const { TerrainGrid, ApronGrid, apronWidthFor, APRON_TERRAIN, Surface } =
		await import(pathToFileURL(outfile).href)

	// A shipped-map-shaped grid: RA tilesets publish a uniformly zero height plane, so the
	// presentation relief reconstruction runs exactly as it does in a match. `variant` moves
	// the surfaces so the thresholds are not fitted to one arrangement of one map.
	const innerGrid = (w, h, originX, originY, variant) => {
		const n = w * h
		const view = {
			w, h,
			type: new Uint8Array(n),
			height: new Uint8Array(n),
			ramp: new Uint8Array(n),
			passability: new Uint8Array(n).fill(1 << 4),
			resource: new Uint8Array(n),
			surface: new Uint8Array(n).fill(Surface.grass),
		}
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			const i = y * w + x
			if (variant === 1 && x < w * 0.16 && y > h * 0.28 && y < h * 0.66) view.surface[i] = Surface.water
			else if (variant === 2 && y > h * 0.8) view.surface[i] = Surface.water
			else if (Math.abs((x - y * 0.4) - w * 0.72) < 3 && y < h * 0.55) view.surface[i] = Surface.rock
			else if (Math.abs(x - w * 0.5) < 1.5) view.surface[i] = Surface.road
		}
		const g = new TerrainGrid()
		g.build(view, originX, originY)
		return g
	}

	const spread = values => {
		let lo = Infinity, hi = -Infinity, sum = 0
		for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; sum += v }
		const mean = sum / values.length
		let sq = 0
		for (const v of values) sq += (v - mean) * (v - mean)
		return { min: lo, max: hi, mean, sd: Math.sqrt(sq / values.length) }
	}

	// --- 1-4: the ring reads as landscape ------------------------------------------
	const maps = [
		{ w: 96, h: 96, ox: 0, oy: 0, variant: 1, quality: 'high' },
		{ w: 128, h: 128, ox: 8, oy: 8, variant: 0, quality: 'high' },
		{ w: 148, h: 92, ox: 31, oy: 17, variant: 2, quality: 'medium' },
		{ w: 202, h: 159, ox: 4, oy: 60, variant: 0, quality: 'low' },
	]
	for (const map of maps) {
		const a = apronWidthFor(map.quality)
		const inner = innerGrid(map.w, map.h, map.ox, map.oy, map.variant)
		const apron = new ApronGrid()
		apron.buildAround(inner, a)
		const aw = apron.w, ah = apron.h
		const hm = apron.heightM

		// The plain the ring grows out of, measured the way the apron measures it.
		let plainSum = 0, plainCount = 0
		for (let i = 0; i < map.w * map.h; i++) {
			const s = inner.surface[i]
			if (s === Surface.water || s === Surface.shallow || s === Surface.rock) continue
			plainSum += inner.heightMetresAt(i); plainCount++
		}
		const plainM = plainCount > 0 ? plainSum / plainCount : 0

		// The silhouette a player standing anywhere on the map sees: the outermost ring.
		const ring = []
		for (let x = 0; x < aw; x++) { ring.push(hm[x] - plainM); ring.push(hm[(ah - 1) * aw + x] - plainM) }
		for (let y = 1; y < ah - 1; y++) { ring.push(hm[y * aw] - plainM); ring.push(hm[y * aw + aw - 1] - plainM) }
		const s = spread(ring)
		const variation = s.sd / Math.max(1e-6, Math.abs(s.mean))

		// One profile per direction, walking the perimeter and stepping straight out.
		let monotone = 0
		const peaks = []
		for (let k = 0; k < DIRECTIONS; k++) {
			const t = k / DIRECTIONS
			let bx, by, sx, sy
			if (t < 0.25) { bx = Math.floor(map.w * t * 4); by = 0; sx = 0; sy = -1 }
			else if (t < 0.5) { bx = map.w - 1; by = Math.floor(map.h * (t - 0.25) * 4); sx = 1; sy = 0 }
			else if (t < 0.75) { bx = Math.floor(map.w * (1 - (t - 0.5) * 4)); by = map.h - 1; sx = 0; sy = 1 }
			else { bx = 0; by = Math.floor(map.h * (1 - (t - 0.75) * 4)); sx = -1; sy = 0 }
			let peak = -Infinity
			let previous = -Infinity
			let climbs = true
			for (let d = 1; d <= a; d++) {
				const gx = Math.min(aw - 1, Math.max(0, a + bx + sx * d))
				const gy = Math.min(ah - 1, Math.max(0, a + by + sy * d))
				const v = hm[gy * aw + gx] - plainM
				if (v > peak) peak = v
				// A quarter metre of tolerance: noise grain is not a descent.
				if (previous > -Infinity && v < previous - 0.25) climbs = false
				previous = v
			}
			if (climbs) monotone++
			peaks.push(peak)
		}
		const tallest = Math.max(...peaks)

		// How much of the synthesized ring is mountain and how much is open, by area.
		let cells = 0, high = 0, low = 0
		for (let gy = 0; gy < ah; gy++) for (let gx = 0; gx < aw; gx++) {
			const ix = gx - a, iy = gy - a
			if (ix >= 0 && iy >= 0 && ix < map.w && iy < map.h) continue
			const v = hm[gy * aw + gx] - plainM
			cells++
			if (v >= MOUNTAIN_M) high++
			if (v < OPEN_M) low++
		}
		const rangeArea = high / cells
		const openArea = low / cells

		const where = `${map.w}x${map.h} ${map.quality} apron ${a}`
		lines.push(
			`${where}: ring ${s.min.toFixed(1)}..${s.max.toFixed(1)} m, mean ${s.mean.toFixed(1)}, ` +
			`sd ${s.sd.toFixed(2)}, variation ${variation.toFixed(3)}; ` +
			`${(100 * rangeArea).toFixed(0)}% mountain / ${(100 * openArea).toFixed(0)}% open of ${cells} cells; ` +
			`${monotone}/${DIRECTIONS} monotone; tallest ${tallest.toFixed(1)} m`)
		if (variation < MIN_RING_VARIATION)
			failures.push(`${where}: outer ring variation ${variation.toFixed(3)} < ${MIN_RING_VARIATION} — the horizon is one height in every direction`)
		if (openArea < MIN_OPEN_AREA)
			failures.push(`${where}: only ${(100 * openArea).toFixed(0)}% of the ring stays under ${OPEN_M} m — nowhere does the land run away from the map`)
		if (rangeArea < MIN_RANGE_AREA)
			failures.push(`${where}: only ${(100 * rangeArea).toFixed(0)}% of the ring clears ${MOUNTAIN_M} m — this is not mountain country`)
		if (monotone > MAX_MONOTONE_DIRECTIONS)
			failures.push(`${where}: ${monotone} of ${DIRECTIONS} directions climb without ever falling back — that is a bowl`)

		// --- 5: the seam ------------------------------------------------------------
		// Every corner of the playable rectangle must sit at exactly the height the
		// playable mesh puts it at. The apron reaches it through its own corner grid, so
		// this compares two independent computations rather than restating the copy.
		let worst = 0
		for (let gy = 0; gy <= map.h; gy++) for (let gx = 0; gx <= map.w; gx++) {
			if (gx > 0 && gx < map.w && gy > 0 && gy < map.h) continue
			const cx = Math.min(map.w - 1, gx), cy = Math.min(map.h - 1, gy)
			const dx = gx > cx ? 1 : 0, dy = gy > cy ? 1 : 0
			const mine = apron.cornerHeightM(a + cx, a + cy, dx, dy)
			const theirs = inner.cornerHeightM(cx, cy, dx, dy)
			worst = Math.max(worst, Math.abs(mine - theirs))
		}
		lines.push(`${where}: worst seam corner disagreement ${worst.toExponential(1)} m`)
		if (worst > 1e-6)
			failures.push(`${where}: seam corner off by ${worst.toFixed(4)} m — a crack opens along the whole border`)

		// --- 6: determinism ---------------------------------------------------------
		const again = new ApronGrid()
		again.buildAround(inner, a)
		for (let i = 0; i < hm.length; i++) if (hm[i] !== again.heightM[i]) {
			failures.push(`${where}: rebuilding the same map moved cell ${i}`)
			break
		}
	}

	// --- 7: finite for every shape the game can hand it ------------------------------
	let shapes = 0
	for (const [w, h] of [[1, 1], [3, 3], [16, 9], [96, 96], [202, 159], [5, 200]])
		for (const ap of [0, 1, 2, 24, 32, 40, 48]) {
			shapes++
			const inner = innerGrid(w, h, 0, 0, 1)
			const apron = new ApronGrid()
			apron.buildAround(inner, ap)
			let bad = 0
			for (let i = 0; i < apron.heightM.length; i++) if (!Number.isFinite(apron.heightM[i])) bad++
			if (bad > 0 || !Number.isFinite(apron.minHeightM) || !Number.isFinite(apron.maxHeightM))
				failures.push(`${w}x${h} apron ${ap}: ${bad} non-finite heights, span ${apron.minHeightM}..${apron.maxHeightM}`)
		}
	lines.push(`${shapes} map shapes x ring widths finite; profile '${APRON_TERRAIN}'`)
} finally {
	rmSync(temp, { recursive: true, force: true })
}

for (const line of lines) console.log(`  ${line}`)
assert.equal(failures.length, 0, `aprongate: FAIL\n  ${failures.join('\n  ')}`)
console.log('aprongate: PASS')
