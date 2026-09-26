#!/usr/bin/env node
// STEELSEED — tools/contactsheet
//
// Renders every actor in the roster through its archetype generator and lays the results out
// as one image, grouped by family.
//
// This exists to make review CHEAP rather than to lower the standard. `issues/art-1.md`
// records what happens otherwise: sixteen generators went unreviewed for two days, and a
// word-grep reported PASS on a full science-fiction spec the whole time, because looking at
// sixteen things one at a time is work nobody does. Forty-four is worse. One sheet is a
// glance.
//
// It is a SHADED ORTHOGRAPHIC render, not the silhouette mask `rostergate` compares — the
// mask answers "are these two different", which is a gate question, and this answers "is
// this any good", which is not automatable and needs eyes. Lambert shading off the SDF
// gradient is enough to read form; anything more would be reimplementing the renderer in a
// tool, and the renderer is where a real frame comes from.
//
// Usage:
//   node --experimental-strip-types tools/contactsheet.mjs [--roster path] [--out path] [--cell n]

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build as esbuild } from 'esbuild'
import { encodePng } from './png.mjs'
import { adaptRoster } from './rosteradapt.mjs'

const TOOL = 'contactsheet'
const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const arg = n => {
	const hit = process.argv.find(a => a.startsWith(`--${n}=`))
	return hit ? hit.slice(n.length + 3) : null
}
const rosterPath = resolve(arg('roster') ?? resolve(WEB_ROOT, '.forge/spec/roster.json'))
const outPath = resolve(arg('out') ?? resolve(WEB_ROOT, 'shots/roster-contact.png'))
const CELL = Number(arg('cell') ?? 168)

if (!existsSync(rosterPath)) {
	console.error(`${TOOL}: no roster at ${rosterPath}`)
	process.exit(2)
}

const tmp = mkdtempSync(join(tmpdir(), 'contactsheet-'))
const bundlePath = join(tmp, 'archetype.mjs')
await esbuild({
	entryPoints: [resolve(WEB_ROOT, 'src/units/archetype/index.gate.ts')],
	bundle: true, format: 'esm', platform: 'neutral', outfile: bundlePath, logLevel: 'silent',
})
const A = await import(bundlePath)

const GEN = {
	0: A.buildTrackedVehicle, 1: A.buildWheeledVehicle, 2: A.buildInfantryFigure,
	3: A.buildAircraft, 4: A.buildAircraft, 5: A.buildVessel, 6: A.buildPlantStructure, 7: A.buildEmplacement,
}
const FAMILY_NAME = {
	0: 'tracked', 1: 'wheeled', 2: 'infantry', 3: 'rotorcraft',
	4: 'fixedwing', 5: 'vessel', 6: 'plant', 7: 'emplacement',
}

const doc = JSON.parse(readFileSync(rosterPath, 'utf8'))
// Two shapes reach this tool and they must not be confused, because confusing them fails
// SILENTLY. `.forge/spec/roster.json` is the raw engine export, trait-shaped, and needs
// adaptRoster. `src/units/archetype/roster.json` is the committed table and is ALREADY the
// flat RosterSlot the generators consume. Running the adapter over an adapted roster finds no
// traits to read and yields nothing — which is how this tool came to render a 1536x0 sheet of
// 0 actors and exit 0.
//
// The discriminator is a field only the adapted form has. `faction` will not do it: the raw
// export has one too. `lengthM` is metres, which exists only after the adapter has converted
// world units, so it cannot appear on the way in.
const rawSlots = doc.slots ?? doc.actors ?? doc
const alreadyAdapted = Array.isArray(rawSlots) && rawSlots[0] !== undefined && 'lengthM' in rawSlots[0]
const { slots } = alreadyAdapted ? { slots: rawSlots } : adaptRoster(doc)

// Fixed stream: shape language is never seeded (§9.2), so the sheet is reproducible.
function fixedRng() {
	let s = 0x2545f491
	return { next: () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 65536) / 65536 } }
}

const entries = []
for (const slot of slots) {
	const build = GEN[slot.family]
	if (!build) continue
	entries.push({ slot, p: A.deriveChassis(slot), tree: build(A.deriveChassis(slot), fixedRng()) })
}
entries.sort((a, b) => a.slot.family - b.slot.family || a.slot.name.localeCompare(b.slot.name))

// --- shaded orthographic render ---------------------------------------------
// The gameplay view direction, so what is drawn here is the aspect the player sees. A
// top-down plan would flatter the geometry and hide exactly the massing errors worth finding.
const D = [-0.36, -0.48, -0.79]
const dl = Math.hypot(...D)
const dir = D.map(v => v / dl)
const rx = [dir[1] * 0 - dir[2] * 1, dir[2] * 0 - dir[0] * 0, dir[0] * 1 - dir[1] * 0]
const rl = Math.hypot(...rx)
const right = rx.map(v => v / rl)
const upv = [
	right[1] * dir[2] - right[2] * dir[1],
	right[2] * dir[0] - right[0] * dir[2],
	right[0] * dir[1] - right[1] * dir[0],
]
// Sun roughly over the shoulder, which is the lighting the game runs at mid-morning.
const SUN = (() => { const s = [0.42, 0.78, 0.46]; const l = Math.hypot(...s); return s.map(v => v / l) })()

/** Bounds by occupancy scan — the same method rostergate uses, for the same reason. */
function boundsOf(t, p) {
	const span = 2 * Math.max(p.lengthM, p.widthM) + 3
	const N = 30
	let e = 0, top = 0
	for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) for (let c = 0; c < N; c++) {
		const x = (a / (N - 1) - 0.5) * 2 * span
		const z = (b / (N - 1) - 0.5) * 2 * span
		const y = (c / (N - 1)) * span
		if (A.evalSdf(t, x, y, z) >= 0) continue
		e = Math.max(e, Math.abs(x), Math.abs(z))
		top = Math.max(top, y)
	}
	const pad = span / (N - 1)
	return { ext: (e || span * 0.25) + pad, top: (top || span * 0.25) + pad }
}

for (const e of entries) e.b = boundsOf(e.tree, e.p)

// One extent per FAMILY, so relative size reads inside a family — which is the comparison
// that matters — without a 6 m building shrinking every tank to four pixels.
const famExt = new Map()
for (const e of entries) {
	const cur = famExt.get(e.slot.family) ?? 0
	famExt.set(e.slot.family, Math.max(cur, e.b.ext, e.b.top * 0.5))
}

const COLS = 8
const ROWS = Math.ceil(entries.length / COLS)
const LABEL = 14
const W = COLS * CELL
const Hh = ROWS * (CELL + LABEL)
const img = new Uint8Array(W * Hh * 4)
// Mid grey ground, so both dark and light hulls read.
for (let i = 0; i < W * Hh; i++) { img[i * 4] = 30; img[i * 4 + 1] = 32; img[i * 4 + 2] = 36; img[i * 4 + 3] = 255 }

const DEPTH = 96
if (process.env.DBG) globalThis.__dbg = { n: 0, sum: 0, max: 0, gl: Infinity }
for (let idx = 0; idx < entries.length; idx++) {
	const e = entries[idx]
	const cx = (idx % COLS) * CELL
	const cy = Math.floor(idx / COLS) * (CELL + LABEL)
	const ext = (famExt.get(e.slot.family) ?? 2) * 1.12
	const cyw = e.b.top * 0.5
	for (let v = 0; v < CELL; v++) {
		for (let u = 0; u < CELL; u++) {
			const su = ((u + 0.5) / CELL - 0.5) * 2 * ext
			const sv = -((v + 0.5) / CELL - 0.5) * 2 * ext
			// March to a bracketing interval, then BISECT onto the surface.
			//
			// Breaking at the first sample where sdf < 0 lands up to one step INSIDE, and at
			// this ray step that is ~0.2 m for a building. Deep inside a union-heavy tree the
			// gradient is dominated by whichever primitive happens to be nearest and its
			// magnitude collapses, so the shading came out uniformly black with light only on
			// grazing edges — which reads as a plausible dark render rather than as an error.
			// NEAR to FAR. The first version marched t from 0 to 1 with tt = (t - 0.5)*2*ext,
			// which walks from +dir*ext to -dir*ext — away from the camera, so every hit was
			// the BACK-most surface and its normal faced away from both camera and sun.
			// Measured: mean N.L was 0.0017 across 290k shaded pixels. The silhouette gate
			// never noticed because occupancy does not care which surface you hit first.
			const at = t => {
				const tt = (0.5 - t) * 2 * ext
				return [
					right[0] * su + upv[0] * sv - dir[0] * tt,
					right[1] * su + upv[1] * sv - dir[1] * tt + cyw,
					right[2] * su + upv[2] * sv - dir[2] * tt,
				]
			}
			let hit = false, lo = 0, hi = 0
			let prev = 0
			for (let t = 0; t < DEPTH; t++) {
				const f = (t + 0.5) / DEPTH
				const q = at(f)
				if (A.evalSdf(e.tree, q[0], q[1], q[2]) < 0) { hit = true; lo = prev; hi = f; break }
				prev = f
			}
			if (!hit) continue
			for (let b = 0; b < 12; b++) {
				const mid = (lo + hi) * 0.5
				const q = at(mid)
				if (A.evalSdf(e.tree, q[0], q[1], q[2]) < 0) hi = mid
				else lo = mid
			}
			const hp = at(hi)
			const hx = hp[0], hy = hp[1], hz = hp[2]
			// Central-difference gradient for the normal. Coarse, but this is a review
			// artifact and a shading error here would not survive into a frame.
			const h = ext * 0.0015
			const nx = A.evalSdf(e.tree, hx + h, hy, hz) - A.evalSdf(e.tree, hx - h, hy, hz)
			const ny = A.evalSdf(e.tree, hx, hy + h, hz) - A.evalSdf(e.tree, hx, hy - h, hz)
			const nz = A.evalSdf(e.tree, hx, hy, hz + h) - A.evalSdf(e.tree, hx, hy, hz - h)
			const nl = Math.hypot(nx, ny, nz) || 1
			const ndl = Math.max((nx / nl) * SUN[0] + (ny / nl) * SUN[1] + (nz / nl) * SUN[2], 0)
			if (globalThis.__dbg) { globalThis.__dbg.n++; globalThis.__dbg.sum += ndl; globalThis.__dbg.max = Math.max(globalThis.__dbg.max, ndl); globalThis.__dbg.gl = Math.min(globalThis.__dbg.gl, nl) }
			// Faction tint, muted: the sheet is for FORM. §9.1 requires factions to separate
			// in monochrome, so if two hulls only differ here the sheet is telling you they
			// have already failed.
			const base = e.slot.faction === 0 ? [150, 138, 126] : e.slot.faction === 1 ? [132, 142, 152] : [128, 124, 118]
			const lit = 0.20 + 0.80 * ndl
            const o = ((cy + v) * W + (cx + u)) * 4
			img[o] = Math.min(255, base[0] * lit)
			img[o + 1] = Math.min(255, base[1] * lit)
			img[o + 2] = Math.min(255, base[2] * lit)
		}
	}
	// A one-pixel family stripe under each cell, so the grouping is visible without text.
	const stripe = [[200, 120, 60], [90, 160, 200], [120, 200, 120], [220, 200, 90], [220, 200, 90], [0, 0, 0], [180, 120, 200], [200, 90, 90]][e.slot.family] ?? [128, 128, 128]
	for (let u = 0; u < CELL; u++) {
		const o = ((cy + CELL + 2) * W + (cx + u)) * 4
		img[o] = stripe[0]; img[o + 1] = stripe[1]; img[o + 2] = stripe[2]
	}
}

if (globalThis.__dbg) console.log(`DBG hits=${globalThis.__dbg.n} meanNdL=${(globalThis.__dbg.sum / globalThis.__dbg.n).toFixed(4)} maxNdL=${globalThis.__dbg.max.toFixed(4)} minGradLen=${globalThis.__dbg.gl.toExponential(2)}`)
writeFileSync(outPath, encodePng(W, Hh, Buffer.from(img.buffer, img.byteOffset, img.byteLength)))
rmSync(tmp, { recursive: true, force: true })
console.log(`${TOOL}: ${entries.length} actors -> ${outPath} (${W}x${Hh})`)

// An empty sheet is not an empty roster, it is a broken tool, and this one proved it by
// writing a 1536x0 PNG and exiting 0. A review instrument that reviews nothing while
// reporting success is worse than one that crashes: the green gets quoted.
if (entries.length === 0) {
	console.error(`${TOOL}: FAIL — rendered NOTHING. The roster at ${rosterPath} produced no`)
	console.error(`${TOOL}: actors with a known generator. Either the file is not a roster, or`)
	console.error(`${TOOL}: every family in it is unimplemented. Do not read the empty sheet as`)
	console.error(`${TOOL}: a clean roster.`)
	process.exit(1)
}
// Families present in the roster but with no generator are the whole point of a coverage
// sheet, so name them rather than leaving them as a quiet difference in the actor count.
const missing = new Map()
for (const slot of slots) if (!GEN[slot.family]) missing.set(slot.family, (missing.get(slot.family) ?? 0) + 1)
if (missing.size > 0) {
	const parts = [...missing].map(([f, n]) => `family ${f} (${n} actor${n === 1 ? '' : 's'})`)
	console.log(`${TOOL}: NOT DRAWN — ${parts.join(', ')}: no generator. ${slots.length - entries.length} of ${slots.length} actors are missing from this sheet.`)
}
for (const [f, ext] of [...famExt].sort((a, b) => a[0] - b[0]))
	console.log(`  family ${f} ${(FAMILY_NAME[f] ?? '?').padEnd(12)} extent ${(ext * 2).toFixed(2)} m`)
console.log(`  order: ${entries.map(e => e.slot.name).join(' ')}`)
