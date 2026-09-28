// JOA terrain art: the player-known battlefield drawn as a reconnaissance image.
//
// Pure presentation of the TacticalState the primary already filtered: surface, the 3D world's
// relief and the explored flag per cell, plus the trees the player can see. Nothing here reads
// hidden state, and a cell the player has not explored stays transparent (the "no data" ground
// shows through), so the image can never disclose unexplored terrain.
//
// The map is cut into tiles of TILE cells. Each tile is synthesised once per vision mode and
// level of detail, then only drawn: panning, zooming and unit-only updates repaint nothing.
// Synthesis is time-sliced (see TerrainArt.work), so a phone never stalls on a whole map.
import type { TacticalState } from './model'
import type { VisionMode } from './vision'

export const TILE = 16
/** Pixels per cell for the whole-map level and the close-up level. */
export const LOD_PX = [8, 24] as const
/** Relief plane quantisation shared with the model: byte = round((metres + H_OFFSET) * H_SCALE). */
export const H_OFFSET = 2
export const H_SCALE = 28
export const decodeHeight = (byte: number): number => byte / H_SCALE - H_OFFSET

// --- Deterministic value noise from a small tileable table (no Math.random, no per-pixel hash).
const N = 256
const table = (() => {
	const t = new Float32Array(N * N)
	let s = 0x9e3779b9
	for (let i = 0; i < t.length; i++) {
		s ^= s << 13; s ^= s >>> 17; s ^= s << 5
		t[i] = ((s >>> 0) % 10000) / 10000
	}
	return t
})()
function noise(x: number, y: number): number {
	const ix = Math.floor(x), iy = Math.floor(y)
	let fx = x - ix, fy = y - iy
	fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy)
	const x0 = ix & (N - 1), y0 = iy & (N - 1), x1 = (x0 + 1) & (N - 1), y1 = (y0 + 1) & (N - 1)
	const a = table[y0 * N + x0], b = table[y0 * N + x1], c = table[y1 * N + x0], d = table[y1 * N + x1]
	return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
}
const fbm = (x: number, y: number): number => noise(x, y) * 0.55 + noise(x * 2.03 + 17.1, y * 2.03 + 3.7) * 0.3 + noise(x * 4.1 + 41.3, y * 4.1 + 29.9) * 0.15
function grain(x: number, y: number): number {
	let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263)
	n = Math.imul(n ^ (n >>> 13), 1274126177)
	return ((n ^ (n >>> 16)) >>> 0) / 4294967295
}

// --- Materials: surface index (core/surface.ts order) → satellite albedo and thermal emission.
type RGB = [number, number, number]
const ALBEDO: readonly (readonly [RGB, RGB])[] = [
	[[104, 92, 74], [86, 76, 61]],     // soil
	[[118, 116, 108], [84, 82, 77]],   // rock
	[[178, 160, 122], [156, 140, 106]],// sand
	[[132, 127, 116], [106, 102, 94]], // gravel
	[[86, 102, 62], [62, 80, 47]],     // grass
	[[140, 135, 124], [112, 108, 99]], // road
	[[104, 113, 120], [86, 94, 101]],  // metal
	[[152, 149, 140], [128, 125, 117]],// concrete
	[[14, 38, 46], [22, 54, 62]],      // water
	[[38, 84, 86], [52, 102, 98]],     // shallow
	[[222, 226, 223], [196, 204, 204]],// snow
	[[64, 58, 53], [48, 44, 41]],      // ash
	[[118, 98, 62], [96, 80, 52]],     // resource (ore field)
]
/** Relative long-wave emission: cold water and wet vegetation dark, sun-soaked stone and roads warm. */
const THERMAL = [0.42, 0.5, 0.48, 0.47, 0.3, 0.6, 0.66, 0.62, 0.07, 0.12, 0.2, 0.34, 0.5]
const WATER = 8, SHALLOW = 9, ROAD = 5, ROCK = 1, RESOURCE = 12, GRASS = 4

/** Sun from the north-west, as the game's default afternoon light. */
const LIGHT = (() => { const x = -0.55, y = -0.62, z = 0.56, l = Math.hypot(x, y, z); return [x / l, y / l, z / l] })()

interface Cells {
	w: number; h: number
	surface: Uint8Array
	height: Float32Array
	/** Relief averaged over a 7×7 neighbourhood: below it is a hollow, above it a ridge. */
	blur: Float32Array
	explored: Uint8Array
}

function cellsOf(state: TacticalState): Cells {
	const { w, h } = state.bounds, n = w * h
	const surface = new Uint8Array(n), height = new Float32Array(n), explored = new Uint8Array(n)
	for (let i = 0; i < n; i++) {
		if (!state.visibility[i]) continue
		explored[i] = 1
		surface[i] = state.terrain[i] ?? 0
		height[i] = decodeHeight(state.heights[i] ?? 0)
	}
	const blur = new Float32Array(n), row = new Float32Array(n), rowW = new Float32Array(n)
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		let sum = 0, weight = 0
		for (let k = -3; k <= 3; k++) { const xx = x + k; if (xx < 0 || xx >= w) continue; const i = y * w + xx; sum += height[i] * explored[i]; weight += explored[i] }
		row[y * w + x] = sum; rowW[y * w + x] = weight
	}
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		let sum = 0, weight = 0
		for (let k = -3; k <= 3; k++) { const yy = y + k; if (yy < 0 || yy >= h) continue; sum += row[yy * w + x]; weight += rowW[yy * w + x] }
		blur[y * w + x] = weight > 0 ? sum / weight : height[y * w + x]
	}
	return { w, h, surface, height, blur, explored }
}

/** Bilinear relief at a continuous cell position (cell centres at +0.5), unexplored cells ignored. */
function heightAt(c: Cells, x: number, y: number, plane: Float32Array = c.height): number {
	const fx = Math.min(c.w - 1, Math.max(0, x - 0.5)), fy = Math.min(c.h - 1, Math.max(0, y - 0.5))
	const i0 = Math.floor(fx), j0 = Math.floor(fy), i1 = Math.min(c.w - 1, i0 + 1), j1 = Math.min(c.h - 1, j0 + 1)
	const tx = fx - i0, ty = fy - j0
	const a = j0 * c.w + i0, b = j0 * c.w + i1, d = j1 * c.w + i0, e = j1 * c.w + i1
	const wa = (1 - tx) * (1 - ty) * c.explored[a], wb = tx * (1 - ty) * c.explored[b], wd = (1 - tx) * ty * c.explored[d], we = tx * ty * c.explored[e]
	const sum = wa + wb + wd + we
	return sum > 0 ? (plane[a] * wa + plane[b] * wb + plane[d] * wd + plane[e] * we) / sum : 0
}

interface Tree { x: number; y: number; r: number }

const IDX = new Int32Array(4), WTS = new Float32Array(4)

// Gradient of the noise table, for bump lighting: grad(x, y, f) is the slope of noise(x·f, y·f).
const GX = new Float32Array(N * N), GY = new Float32Array(N * N)
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
	GX[y * N + x] = (table[y * N + ((x + 1) & (N - 1))] - table[y * N + ((x - 1) & (N - 1))]) / 2
	GY[y * N + x] = (table[((y + 1) & (N - 1)) * N + x] - table[((y - 1) & (N - 1)) * N + x]) / 2
}
let gradX = 0, gradY = 0
/** Adds amplitude × the gradient of noise at frequency f (cycles per cell) into gradX/gradY. */
function bump(x: number, y: number, f: number, amplitude: number, px: number, ox = 0, oy = 0): void {
	// Octaves the tile's pixels cannot resolve would only sparkle: fade them out below ~3 px a cycle.
	const a = amplitude * Math.min(1, Math.max(0, px / f / 3 - 0.35))
	if (a <= 0) return
	const u = x * f + ox, v = y * f + oy, ix = Math.floor(u), iy = Math.floor(v), fx = u - ix, fy = v - iy
	const x0 = ix & (N - 1), y0 = iy & (N - 1), x1 = (x0 + 1) & (N - 1), y1 = (y0 + 1) & (N - 1)
	const i00 = y0 * N + x0, i10 = y0 * N + x1, i01 = y1 * N + x0, i11 = y1 * N + x1
	const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy
	gradX += a * f * (GX[i00] * w00 + GX[i10] * w10 + GX[i01] * w01 + GX[i11] * w11)
	gradY += a * f * (GY[i00] * w00 + GY[i10] * w10 + GY[i01] * w01 + GY[i11] * w11)
}
const clamp01 = (v: number): number => v < 0 ? 0 : v > 1 ? 1 : v
const smooth = (e0: number, e1: number, v: number): number => { const t = clamp01((v - e0) / (e1 - e0)); return t * t * (3 - 2 * t) }

/** One tile's pixels for one vision mode, at `px` pixels per cell. */
function synthesise(c: Cells, tx: number, ty: number, px: number, mode: VisionMode, into: ImageData, rowStart = 0, rowEnd = TILE * px): void {
	const out = into.data, size = TILE * px
	const exaggeration = 3.4
	for (let py = rowStart; py < rowEnd; py++) {
		const y = ty * TILE + (py + 0.5) / px
		if (y >= c.h) { out.fill(0, py * size * 4, (py + 1) * size * 4); continue }
		for (let qx = 0; qx < size; qx++) {
			const o = (py * size + qx) * 4
			const x = tx * TILE + (qx + 0.5) / px
			if (x >= c.w) { out[o + 3] = 0; continue }
			// Organic material boundaries: warp the sample point a little, never across more than a cell.
			const wx = x + (noise(x * 0.45, y * 0.45) - 0.5) * 0.9, wy = y + (noise(x * 0.45 + 91.7, y * 0.45 + 13.3) - 0.5) * 0.9
			const fx = Math.min(c.w - 1, Math.max(0, wx - 0.5)), fy = Math.min(c.h - 1, Math.max(0, wy - 0.5))
			const i0 = Math.floor(fx), j0 = Math.floor(fy), i1 = Math.min(c.w - 1, i0 + 1), j1 = Math.min(c.h - 1, j0 + 1)
			const u = fx - i0, v = fy - j0
			IDX[0] = j0 * c.w + i0; IDX[1] = j0 * c.w + i1; IDX[2] = j1 * c.w + i0; IDX[3] = j1 * c.w + i1
			WTS[0] = (1 - u) * (1 - v); WTS[1] = u * (1 - v); WTS[2] = (1 - u) * v; WTS[3] = u * v
			let known = 0, r = 0, g = 0, b = 0, water = 0, shallow = 0, road = 0, ore = 0, rock = 0, sand = 0, heat = 0
			const detail = fbm(x * 0.9, y * 0.9), fine = noise(x * 5.3, y * 5.3)
			const region = noise(x * 0.055 + 311, y * 0.055 + 17), patch = fbm(x * 0.21 + 5, y * 0.21 + 71)
			for (let k = 0; k < 4; k++) {
				const cell = IDX[k], wk = WTS[k] * c.explored[cell]
				if (wk <= 0) continue
				known += wk
				const s = c.surface[cell], pal = ALBEDO[s] ?? ALBEDO[0]
				if (s === GRASS) {
					// Meadow, dry grass and dark scrub drift across the map at three scales.
					const dry = clamp01((region - 0.42) * 2.2) * 0.8, dark = clamp01((patch - 0.52) * 3) * 0.75
					r += wk * (84 + dry * 30 - dark * 26 + (detail - 0.5) * 16)
					g += wk * (101 + dry * 10 - dark * 22 + (detail - 0.5) * 14)
					b += wk * (60 + dry * 8 - dark * 14 + (detail - 0.5) * 8)
				} else {
					const mixA = s === ROCK ? clamp01(noise(x * 1.6, y * 0.35) * 1.3 - 0.15) : detail
					r += wk * (pal[0][0] + (pal[1][0] - pal[0][0]) * mixA)
					g += wk * (pal[0][1] + (pal[1][1] - pal[0][1]) * mixA)
					b += wk * (pal[0][2] + (pal[1][2] - pal[0][2]) * mixA)
				}
				heat += wk * THERMAL[s]
				if (s === WATER) water += wk
				else if (s === SHALLOW) { water += wk; shallow += wk }
				else if (s === ROAD) road += wk
				else if (s === RESOURCE) ore += wk
				else if (s === ROCK) rock += wk
				else if (s === 2) sand += wk
			}
			// The explored edge fades inside explored cells only: unexplored data never contributes.
			const edge = clamp01((known - 0.34) / 0.4)
			if (known <= 0 || edge <= 0) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; continue }
			r /= known; g /= known; b /= known; water /= known; shallow /= known; road /= known; ore /= known; rock /= known; sand /= known; heat /= known

			// Rock breaks into boulders and scree instead of following the cell grid.
			const boulders = rock > 0.05 ? smooth(0.38, 0.62, rock + (noise(x * 1.25 + 7, y * 1.25 + 3) - 0.5) * 0.55 + (fine - 0.5) * 0.12) : 0
			if (boulders > 0) {
				const stone = 0.8 + noise(x * 2.4, y * 0.8) * 0.35
				r += (122 * stone - r) * boulders; g += (119 * stone - g) * boulders; b += (111 * stone - b) * boulders
				heat += (THERMAL[ROCK] - heat) * boulders
			}
			const oreClump = ore > 0.05 ? smooth(0.3, 0.6, ore + (noise(x * 2.1 + 51, y * 2.1 + 9) - 0.5) * 0.5) : 0

			// Relief: the 3D world's heights (macro) plus a material bump (micro), so close-ups stay crisp.
			const d = 0.5, hx = (heightAt(c, x + d, y) - heightAt(c, x - d, y)) / (2 * d), hy = (heightAt(c, x, y + d) - heightAt(c, x, y - d)) / (2 * d)
			gradX = 0; gradY = 0
			const grassy = clamp01(1 - water * 2 - road - boulders - oreClump - sand)
			if (grassy > 0) { bump(x, y, 4.2, 0.04 * grassy, px, 3.1, 7.7); bump(x, y, 9.5, 0.014 * grassy, px, 19.3, 1.9); bump(x, y, 2.1, 0.03 * grassy, px, 55.5, 31.1) }
			if (boulders > 0) { bump(x, y, 1.35, 0.5 * boulders, px, 5, 11); bump(x, y, 3.8, 0.16 * boulders, px, 41, 23); bump(x, y, 9, 0.05 * boulders, px, 2, 67) }
			if (oreClump > 0) bump(x, y, 3.2, 0.12 * oreClump, px, 77, 13)
			if (sand > 0) { const rip = Math.cos((x * 0.8 + y * 2.6 + noise(x * 0.6, y * 0.6) * 3) * 3.2); gradY += rip * 0.035 * sand * Math.min(1, px / 12) }
			if (road > 0.3) bump(x, y, 8, 0.012 * road, px, 13, 5)
			const micro = gradX * gradX + gradY * gradY
			let nx = -hx * exaggeration - gradX * 4, ny = -hy * exaggeration - gradY * 4
			const nl = Math.hypot(nx, ny, 1); nx /= nl; ny /= nl
			const nz = 1 / nl
			const diffuse = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2])
			const steep = 1 - nz
			const cavity = heightAt(c, x, y, c.blur) - heightAt(c, x, y)
			const occlusion = (1 - Math.min(0.34, Math.max(-0.12, cavity * 0.3))) * (1 - Math.min(0.18, micro * 1.4))

			// Water: a crisp shore with foam, depth tint and a faint swell.
			const wet = water > 0.5 ? Math.min(1, (water - 0.5) / 0.14) : 0
			if (wet > 0) {
				const deep = 1 - shallow / Math.max(water, 1e-3)
				const swell = noise(x * 1.7 + 3, y * 0.9) * 0.5 + noise(x * 3.9, y * 4.4) * 0.5
				const wr = 16 + (1 - deep) * 30 + swell * 9, wg = 42 + (1 - deep) * 44 + swell * 12, wb2 = 52 + (1 - deep) * 36 + swell * 12
				r = r + (wr - r) * wet; g = g + (wg - g) * wet; b = b + (wb2 - b) * wet
				heat = heat + (0.06 - heat) * wet
			}
			const foam = water > 0.36 && water < 0.64 ? 1 - Math.abs(water - 0.5) / 0.14 : 0

			// Roads stay straighter than the warped ground and read as pale compacted strips.
			const onRoad = road > 0.42 ? Math.min(1, (road - 0.42) / 0.16) : 0
			if (onRoad > 0) {
				const track = px >= 14 ? Math.max(0, Math.cos(((x + y) * 0.5 + noise(x * 0.3, y * 0.3)) * 16) - 0.6) * 0.25 : 0
				const rr = 150 + fine * 12 - track * 40, rg = 145 + fine * 11 - track * 40, rb = 132 + fine * 10 - track * 36
				r += (rr - r) * onRoad * 0.85; g += (rg - g) * onRoad * 0.85; b += (rb - b) * onRoad * 0.85
			}
			// Ore: golden clumps with mineral glints.
			if (oreClump > 0) { r += (150 - r) * oreClump * 0.45; g += (118 - g) * oreClump * 0.45; b += (58 - b) * oreClump * 0.45 }
			const glint = ore > 0.35 && grain(x * px * 3.1, y * px * 2.7) > 0.93 - oreClump * 0.03 ? ore : 0

			let R: number, G: number, B: number
			if (mode === 'day') {
				const tone = 0.86 + detail * 0.22 + (fine - 0.5) * 0.1
				const light = (0.36 + diffuse * 0.88 - steep * rock * 0.2) * occlusion
				// Cool shadows, warm light: the satellite grade of the game's afternoon.
				R = r * tone * (0.8 * light + 0.12) * 1.02
				G = g * tone * (0.8 * light + 0.13)
				B = b * tone * (0.8 * light + 0.18) * 1.04
				if (wet > 0) { const spec = Math.pow(Math.max(0, diffuse), 24) * wet * 60; R += spec; G += spec; B += spec }
				R += foam * 70; G += foam * 76; B += foam * 72
				if (glint) { R += 150 * glint; G += 120 * glint; B += 40 * glint }
			} else {
				if (mode === 'white') {
					// Night thermal: cold wet vegetation, roads and stone still giving off the day's heat.
					const shade = 0.8 + diffuse * 0.26
					let t = (heat * 0.78 + (detail - 0.5) * 0.16 + (patch - 0.5) * 0.12 + (fine - 0.5) * 0.05) * shade * occlusion + onRoad * 0.1 + glint * 0.3 + foam * 0.04 + oreClump * 0.06
					t = clamp01((t - 0.1) * 1.55)
					t = t * t * (3 - 2 * t) * 0.9 + t * 0.1
					R = 12 + t * 214; G = 14 + t * 218; B = 16 + t * 214
				} else {
					// Image intensifier: reflected moonlight through green phosphor, dark mids, bright highlights.
					const lum = Math.min(1, ((r * 0.3 + g * 0.55 + b * 0.15) / 255) * (0.26 + diffuse * 1.2) * occlusion * 1.3 + foam * 0.1 + glint * 0.4)
					const p = Math.pow(lum, 1.55)
					R = 3 + p * 92; G = 11 + p * 206; B = 7 + p * 104
				}
				const noiseGrain = (grain(x * px * 7.3, y * px * 5.9) - 0.5) * (mode === 'green' ? 24 : 10)
				R += noiseGrain; G += noiseGrain; B += noiseGrain
			}
			out[o] = R < 0 ? 0 : R > 255 ? 255 : R
			out[o + 1] = G < 0 ? 0 : G > 255 ? 255 : G
			out[o + 2] = B < 0 ? 0 : B > 255 ? 255 : B
			out[o + 3] = edge * 255
		}
	}
}

/** Canopies drawn over the synthesised ground: clustered crowns with a cast shadow. */
function paintTrees(g: CanvasRenderingContext2D, trees: readonly Tree[], tx: number, ty: number, px: number, mode: VisionMode): void {
	const ox = tx * TILE, oy = ty * TILE
	const crown = mode === 'day' ? ['#2b3d24', '#3a5230', '#4f6a3c'] : mode === 'white' ? ['#1c1f1e', '#2a2e2c', '#3a3f3c'] : ['#06200f', '#0f3a1c', '#1d5b2c']
	for (const t of trees) {
		const cx = (t.x - ox) * px, cy = (t.y - oy) * px, rad = t.r * px
		if (cx < -rad * 3 || cy < -rad * 3 || cx > TILE * px + rad * 3 || cy > TILE * px + rad * 3) continue
		g.fillStyle = mode === 'day' ? 'rgba(8,14,10,.42)' : 'rgba(0,0,0,.35)'
		g.beginPath(); g.ellipse(cx + rad * 0.55, cy + rad * 0.62, rad * 1.05, rad * 0.82, 0.5, 0, Math.PI * 2); g.fill()
		for (let k = 0; k < 5; k++) {
			const a = grain(t.x * 97 + k, t.y * 61 + k) * Math.PI * 2, d = rad * (k === 0 ? 0 : 0.5), rr = rad * (k === 0 ? 0.8 : 0.52)
			g.fillStyle = crown[Math.min(2, (k + 1) % 3)]
			g.beginPath(); g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rr, 0, Math.PI * 2); g.fill()
		}
		g.fillStyle = mode === 'day' ? 'rgba(170,196,120,.16)' : mode === 'white' ? 'rgba(200,210,205,.08)' : 'rgba(150,255,170,.12)'
		g.beginPath(); g.arc(cx - rad * 0.25, cy - rad * 0.3, rad * 0.42, 0, Math.PI * 2); g.fill()
	}
}

/** Whole-map pixels without the DOM, for tools and tests (no trees: those need a 2D context). */
export function synthesiseMap(state: TacticalState, px: number, mode: VisionMode): { width: number; height: number; data: Uint8ClampedArray } {
	const c = cellsOf(state), cols = Math.ceil(c.w / TILE), rows = Math.ceil(c.h / TILE), size = TILE * px
	const width = c.w * px, height = c.h * px, data = new Uint8ClampedArray(width * height * 4)
	const tile = { data: new Uint8ClampedArray(size * size * 4), width: size, height: size, colorSpace: 'srgb' } as ImageData
	for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
		synthesise(c, tx, ty, px, mode, tile)
		for (let y = 0; y < size && ty * size + y < height; y++) {
			const row = tile.data.subarray(y * size * 4, (y * size + Math.min(size, width - tx * size)) * 4)
			data.set(row, ((ty * size + y) * width + tx * size) * 4)
		}
	}
	return { width, height, data }
}

interface Tile { canvas: HTMLCanvasElement; signature: string; mode: VisionMode; lod: number; used: number }

/**
 * The tile cache for one map view. `tile()` returns what is ready (possibly an older signature
 * or the coarse level); `work(ms)` synthesises queued tiles within a time budget and reports
 * whether anything changed, so the caller redraws only then.
 */
export class TerrainArt {
	private cells: Cells | null = null
	private trees: Tree[] = []
	private treeTiles = new Map<number, Tree[]>()
	private session = ''
	private terrainRef: unknown = null
	private visibilityRef: unknown = null
	private heightsRef: unknown = null
	private treeKey = ''
	private signatures: string[] = []
	private tiles = new Map<string, Tile>()
	private queue: { key: string; tx: number; ty: number; lod: number; mode: VisionMode }[] = []
	private queued = new Set<string>()
	stats = { synthesised: 0, pixels: 0, ms: 0 }

	get cols(): number { return this.cells ? Math.ceil(this.cells.w / TILE) : 0 }
	get rows(): number { return this.cells ? Math.ceil(this.cells.h / TILE) : 0 }

	/** Accept a new state; only the tiles whose explored cells, surface, relief or trees changed go stale. */
	update(state: TacticalState): void {
		const sameGrid = state.session === this.session && state.terrain === this.terrainRef && state.visibility === this.visibilityRef && state.heights === this.heightsRef
		const trees = state.contacts.filter(c => c.role === 'tree')
		const treeKey = trees.map(t => t.id).join(',')
		if (sameGrid && treeKey === this.treeKey) return
		if (state.session !== this.session || !this.cells || this.cells.w !== state.bounds.w || this.cells.h !== state.bounds.h) {
			this.tiles.clear(); this.queue.length = 0; this.queued.clear(); this.signatures = []; this.current = null
		}
		this.session = state.session
		this.terrainRef = state.terrain; this.visibilityRef = state.visibility; this.heightsRef = state.heights; this.treeKey = treeKey
		this.cells = cellsOf(state)
		const b = state.bounds
		this.trees = trees.map(t => ({ x: t.x - b.x, y: t.y - b.y, r: 0.38 + grain(t.x * 13, t.y * 7) * 0.18 }))
		this.treeTiles.clear()
		for (const t of this.trees) {
			// A crown near a tile edge belongs to both tiles, so neither clips it.
			for (const [dx, dy] of [[0, 0], [-0.9, 0], [0.9, 0], [0, -0.9], [0, 0.9]]) {
				const key = Math.floor((t.y + dy) / TILE) * 4096 + Math.floor((t.x + dx) / TILE)
				const list = this.treeTiles.get(key) ?? []
				if (!list.includes(t)) list.push(t)
				this.treeTiles.set(key, list)
			}
		}
		const c = this.cells, next: string[] = []
		for (let ty = 0; ty < this.rows; ty++) for (let tx = 0; tx < this.cols; tx++) {
			// The signature covers one extra ring of cells: blending and relief read neighbours.
			let hash = 2166136261
			for (let y = ty * TILE - 1; y <= (ty + 1) * TILE; y++) for (let x = tx * TILE - 1; x <= (tx + 1) * TILE; x++) {
				if (x < 0 || y < 0 || x >= c.w || y >= c.h) continue
				const i = y * c.w + x
				hash = Math.imul(hash ^ (c.explored[i] ? c.surface[i] + 1 : 0), 16777619)
				hash = Math.imul(hash ^ (c.explored[i] ? state.heights[i] : 0), 16777619)
			}
			for (const t of this.treeTiles.get(ty * 4096 + tx) ?? []) hash = Math.imul(hash ^ Math.round(t.x * 64) ^ Math.round(t.y * 64) << 12, 16777619)
			next.push(String(hash >>> 0))
		}
		this.signatures = next
	}

	private key(tx: number, ty: number, lod: number, mode: VisionMode): string { return `${lod}:${mode}:${tx}:${ty}` }

	/**
	 * The best ready canvas for a tile: the requested level and mode when current, else the
	 * freshest fallback (so a map never flashes empty while it refines). Queues what is missing.
	 */
	tile(tx: number, ty: number, lod: number, mode: VisionMode): HTMLCanvasElement | null {
		const signature = this.signatures[ty * this.cols + tx]
		if (signature === undefined) return null
		const key = this.key(tx, ty, lod, mode), exact = this.tiles.get(key)
		const now = performance.now()
		if (exact && exact.signature === signature) { exact.used = now; return exact.canvas }
		if (!this.queued.has(key)) { this.queued.add(key); this.queue.push({ key, tx, ty, lod, mode }) }
		const fallback = exact ?? this.tiles.get(this.key(tx, ty, 0, mode)) ?? this.tiles.get(this.key(tx, ty, lod, 'day')) ?? this.tiles.get(this.key(tx, ty, 0, 'day'))
		if (fallback) fallback.used = now
		return fallback?.canvas ?? null
	}

	/** Whether every tile of the whole-map level is current for this mode (the first paint is done). */
	ready(mode: VisionMode): boolean {
		for (let i = 0; i < this.signatures.length; i++) {
			const t = this.tiles.get(this.key(i % this.cols, Math.floor(i / this.cols), 0, mode))
			if (!t || t.signature !== this.signatures[i]) return false
		}
		return this.signatures.length > 0
	}

	/** The tile being synthesised, row band by row band, so no frame waits for a whole close-up. */
	private current: { job: { key: string; tx: number; ty: number; lod: number; mode: VisionMode }; signature: string; image: ImageData; row: number; ms: number } | null = null

	/** Synthesise queued tiles for up to `budgetMs`; returns true when a tile completed. */
	work(budgetMs: number): boolean {
		if (!this.cells) return false
		const start = performance.now()
		let changed = false
		// Close-ups the viewer is looking at first, then the whole-map level.
		this.queue.sort((a, b) => b.lod - a.lod)
		while ((this.current || this.queue.length) && performance.now() - start < budgetMs) {
			if (!this.current) {
				const job = this.queue.shift()!
				this.queued.delete(job.key)
				const signature = this.signatures[job.ty * this.cols + job.tx]
				if (signature === undefined || this.tiles.get(job.key)?.signature === signature) continue
				const size = TILE * LOD_PX[job.lod]
				this.current = { job, signature, image: new ImageData(size, size), row: 0, ms: 0 }
			}
			const cur = this.current, job = cur.job, px = LOD_PX[job.lod], size = TILE * px
			// Bands of about 4000 pixels: a few milliseconds even on a phone.
			const band = Math.max(1, Math.floor(4096 / size)), t0 = performance.now()
			synthesise(this.cells, job.tx, job.ty, px, job.mode, cur.image, cur.row, Math.min(size, cur.row + band))
			cur.row += band; cur.ms += performance.now() - t0
			if (cur.row < size) continue
			this.current = null
			const signature = cur.signature, image = cur.image, existing = this.tiles.get(job.key)
			if (this.signatures[job.ty * this.cols + job.tx] !== signature) continue
			const canvas = existing?.canvas ?? document.createElement('canvas')
			canvas.width = size; canvas.height = size
			const g = canvas.getContext('2d')!
			g.putImageData(image, 0, 0)
			const trees = this.treeTiles.get(job.ty * 4096 + job.tx)
			if (trees?.length) paintTrees(g, trees, job.tx, job.ty, px, job.mode)
			this.tiles.set(job.key, { canvas, signature, mode: job.mode, lod: job.lod, used: performance.now() })
			this.stats.synthesised++; this.stats.pixels += size * size; this.stats.ms += cur.ms
			changed = true
		}
		this.evict()
		return changed
	}

	get pending(): number { return this.queue.length + (this.current ? 1 : 0) }

	/** Whether a tile is current at this level and mode (for a clean vision cross-fade). */
	has(tx: number, ty: number, lod: number, mode: VisionMode): boolean {
		const t = this.tiles.get(this.key(tx, ty, lod, mode))
		return !!t && t.signature === this.signatures[ty * this.cols + tx]
	}

	/** Close-up tiles are bounded: the least recently drawn go first. Whole-map tiles stay. */
	private evict(): void {
		const close = [...this.tiles.entries()].filter(([, t]) => t.lod > 0)
		if (close.length <= 48) return
		close.sort((a, b) => a[1].used - b[1].used)
		for (const [key] of close.slice(0, close.length - 48)) this.tiles.delete(key)
	}
}
