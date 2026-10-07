#!/usr/bin/env node
// STEELSEED — tools/organicterraingate
// Continuous presentation relief on an RA-style zero-height map: no vertical faces inside
// the map, rolling but traversable ground, heightAt() equal to the emitted triangles at
// every probe, material boundaries blended over several cells instead of switching at a
// cell edge, water below its banks, and the authoritative planes untouched. Authored-height
// maps keep their literal cliffs and their old probe path.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const TOOL = 'organicterraingate'
const webRoot = resolve(import.meta.dirname, '..')
const temporary = mkdtempSync(join(tmpdir(), 'steelseed-organicterrain-'))
const entry = join(temporary, 'entry.ts')
const bundle = join(temporary, 'bundle.mjs')
writeFileSync(entry, [
	`export { TerrainGrid, HEIGHT_STEP_M, RELIEF_BANK_M } from ${JSON.stringify(resolve(webRoot, 'src/terrain/grid.ts'))}`,
	`export { ChunkBuilder, FLOATS_PER_VERTEX, VERTEX_STRIDE, VertexKind, GROUND_BUCKET } from ${JSON.stringify(resolve(webRoot, 'src/terrain/chunks.ts'))}`,
].join('\n'))
let api
try {
	await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', outfile: bundle, logLevel: 'silent' })
	api = await import(pathToFileURL(bundle).href)
} finally { rmSync(temporary, { recursive: true, force: true }) }

// A 48x40 temperate map: sea on the west with a sand fringe, grass inland, a rock mass,
// a thin rock line, a road, and a shallow ford. Zero height plane, as every RA map.
const W = 48, H = 40, N = W * H
const surface = new Uint8Array(N).fill(4)
const type = new Uint8Array(N).fill(2)
const passability = new Uint8Array(N).fill(7)
const paint = (x0, y0, x1, y1, s, pass) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { surface[y * W + x] = s; passability[y * W + x] = pass } }
paint(0, 0, 7, H, 8, 8)            // water
paint(7, 0, 9, H, 2, 7)            // beach
paint(28, 12, 37, 24, 1, 16)       // rock mass 9x12
paint(14, 30, 34, 31, 1, 16)       // thin rock line
paint(20, 0, 21, 40, 5, 7)         // road
paint(40, 18, 44, 22, 9, 15)       // shallow ford
const view = { w: W, h: H, type, height: new Uint8Array(N), ramp: new Uint8Array(N), passability, resource: new Uint8Array(N), surface }
const grid = new api.TerrainGrid()
grid.build(view, 5, 3)
if (!grid.reliefInfo) throw new Error(`${TOOL}: zero height plane did not trigger presentation relief`)

// 1. Authoritative planes untouched.
for (let i = 0; i < N; i++) if (grid.passability[i] !== passability[i]) throw new Error(`${TOOL}: passability changed at ${i}`)

// 2. Every emitted ground vertex is a top face inside the map: no vertical faces anywhere
//    but the outer skirt, and every top vertex sits exactly on the shared corner grid.
const builder = new api.ChunkBuilder()
const layers = new Uint8Array(13).fill(4)
builder.configure(layers, 0x1234, 4)
let interiorCliffs = 0, topVertices = 0, maxCornerMismatch = 0
const weightAt = new Map()
for (let z0 = 0; z0 < H; z0 += 16) for (let x0 = 0; x0 < W; x0 += 16) {
	const geo = builder.build(grid, x0 / 16, z0 / 16, x0, z0, Math.min(x0 + 16, W), Math.min(z0 + 16, H))
	const f = new Float32Array(geo.vertexData), b = new Uint8Array(geo.vertexData)
	for (let v = 0; v < geo.vertexCount; v++) {
		const o = v * api.FLOATS_PER_VERTEX
		const kind = b[v * api.VERTEX_STRIDE + 59]
		const x = f[o] - grid.originX, y = f[o + 1], z = f[o + 2] - grid.originY
		if (kind === api.VertexKind.cliff) {
			if (x > 0.001 && x < W - 0.001 && z > 0.001 && z < H - 0.001) interiorCliffs++
			continue
		}
		if (kind !== api.VertexKind.top) continue
		topVertices++
		const gx = Math.round(x), gz = Math.round(z)
		const offX = Math.abs(gx - x), offZ = Math.abs(gz - z)
		if (offX > 1e-6 || offZ > 1e-6) {
			// Shoreline contour may slide up to 0.45 m; playable interiors stay on the lattice.
			let nearWater = false
			for (let oy = -1; oy <= 0 && !nearWater; oy++) {
				for (let ox = -1; ox <= 0; ox++) {
					const sx = Math.min(W - 1, Math.max(0, gx + ox))
					const sy = Math.min(H - 1, Math.max(0, gz + oy))
					if (surface[sy * W + sx] === 8 || surface[sy * W + sx] === 9) { nearWater = true; break }
				}
			}
			if (!nearWater || offX > 0.45 + 1e-6 || offZ > 0.45 + 1e-6) {
				throw new Error(`${TOOL}: top vertex off the lattice at ${x},${z}`)
			}
		}
		const probe = grid.heightAt(grid.originX + gx, grid.originY + gz)
		maxCornerMismatch = Math.max(maxCornerMismatch, Math.abs(probe - y))
		// uv1.x is the secondary-surface weight; keep the value per corner for the seam test.
		weightAt.set(`${gx},${gz}`, Math.max(weightAt.get(`${gx},${gz}`) ?? 0, f[o + 12]))
	}
}
if (interiorCliffs !== 0) throw new Error(`${TOOL}: ${interiorCliffs} vertical face vertices inside the map; continuous relief must have none`)
if (maxCornerMismatch > 1e-4) throw new Error(`${TOOL}: probe differs from emitted corner by ${maxCornerMismatch} m`)

// 3. Probes inside cells equal the drawn triangles: reconstruct the mesh plane per probe.
let maxProbeMismatch = 0
let seed = 12345
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
for (let k = 0; k < 4000; k++) {
	const x = rnd() * W, z = rnd() * H
	const cx = Math.min(W - 1, Math.floor(x)), cz = Math.min(H - 1, Math.floor(z))
	const u = x - cx, v = z - cz
	const h00 = grid.cornerHeightM(cx, cz, 0, 0), h10 = grid.cornerHeightM(cx, cz, 1, 0)
	const h01 = grid.cornerHeightM(cx, cz, 0, 1), h11 = grid.cornerHeightM(cx, cz, 1, 1)
	const drawn = v >= u ? h00 * (1 - v) + h01 * (v - u) + h11 * u : h00 * (1 - u) + h11 * v + h10 * (u - v)
	maxProbeMismatch = Math.max(maxProbeMismatch, Math.abs(drawn - grid.heightAt(grid.originX + x, grid.originY + z)))
}
if (maxProbeMismatch > 1e-4) throw new Error(`${TOOL}: heightAt differs from the drawn triangle by ${maxProbeMismatch} m`)

// 4. Rolling but traversable: passable ground spans a real range and no single cell climbs a wall.
let lo = Infinity, hi = -Infinity, steepest = 0
for (let y = 0; y < H; y++) for (let x = 9; x < W - 1; x++) {
	const i = y * W + x
	if (surface[i] === 1 || surface[i] === 8 || surface[i] === 9) continue
	const m = grid.heightMetresAt(i)
	lo = Math.min(lo, m); hi = Math.max(hi, m)
	const right = grid.heightMetresAt(i + 1)
	if (surface[i + 1] !== 1 && surface[i + 1] !== 8 && surface[i + 1] !== 9) steepest = Math.max(steepest, Math.abs(right - m))
}
if (hi - lo < 1.2) throw new Error(`${TOOL}: passable ground is flat (${(hi - lo).toFixed(2)} m of relief)`)
if (steepest > 0.7) throw new Error(`${TOOL}: passable ground climbs ${steepest.toFixed(2)} m in one cell`)
let rockPeak = -Infinity
for (let i = 0; i < N; i++) if (surface[i] === 1) rockPeak = Math.max(rockPeak, grid.heightMetresAt(i))
if (rockPeak < hi + 2) throw new Error(`${TOOL}: the rock mass (${rockPeak.toFixed(1)} m) does not rise above the plain (${hi.toFixed(1)} m)`)

// 5. Material seams: crossing the beach→grass boundary along a row, the secondary weight
//    changes gradually over several corners rather than jumping at one cell edge.
const row = 20
const weights = []
for (let gx = 5; gx <= 14; gx++) weights.push(weightAt.get(`${gx},${row}`) ?? 0)
let biggestJump = 0, distinct = new Set()
for (let k = 1; k < weights.length; k++) biggestJump = Math.max(biggestJump, Math.abs(weights[k] - weights[k - 1]))
for (const w of weights) if (w > 0.05 && w < 0.95) distinct.add(w.toFixed(2))
if (biggestJump > 0.5) throw new Error(`${TOOL}: material weight jumps ${biggestJump.toFixed(2)} between neighbouring corners: ${weights.map(w => w.toFixed(2)).join(' ')}`)
if (distinct.size < 2) throw new Error(`${TOOL}: boundary has no intermediate blend values: ${weights.map(w => w.toFixed(2)).join(' ')}`)

// 6. Water below its banks, above its bed.
let level = NaN
for (let i = 0; i < N; i++) if (Number.isFinite(grid.waterLevel[i])) { level = grid.waterLevel[i]; break }
let lowestBank = Infinity
for (let y = 0; y < H; y++) { const i = y * W + 7; lowestBank = Math.min(lowestBank, grid.heightMetresAt(i)) }
if (!(level < lowestBank - api.RELIEF_BANK_M * 0.5)) throw new Error(`${TOOL}: water level ${level} is not below the bank ${lowestBank}`)
if (!(level > grid.heightMetresAt(3 * W + 3))) throw new Error(`${TOOL}: water level ${level} is not above its bed`)

// 7. An authored-height map keeps literal cliffs and the old probe path.
const authored = new api.TerrainGrid()
const ah = new Uint8Array(N); for (let i = 0; i < N; i++) ah[i] = (i % W) < 24 ? 0 : 4
authored.build({ ...view, height: ah, surface: new Uint8Array(N).fill(4) }, 0, 0)
if (authored.reliefInfo !== null) throw new Error(`${TOOL}: authored heights triggered reconstruction`)
if (authored.connected(24 + 5 * W, 23 + 5 * W)) throw new Error(`${TOOL}: authored cliff was smoothed away`)
authored.dispose(); grid.dispose()

console.log(`${TOOL}: PASS — ${topVertices} top vertices on the lattice, 0 interior faces, probe = mesh within ${maxProbeMismatch.toExponential(1)} m over 4000 points; ` +
	`passable relief ${(hi - lo).toFixed(2)} m with ≤${steepest.toFixed(2)} m per cell, rock peak ${rockPeak.toFixed(1)} m; beach→grass weights ${weights.map(w => w.toFixed(2)).join(' ')}; ` +
	`water ${level.toFixed(2)} m under bank ${lowestBank.toFixed(2)} m; authored cliffs literal`)
