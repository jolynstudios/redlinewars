// STEELSEED — terrain/apron
// Out-of-bounds scenery: a ring of synthesized landscape around the playable area, so the
// world ends in hills, sea and mountains instead of in the renderer's clear colour.
//
// The ring is a second TerrainGrid over the extended area, built AROUND the authoritative
// grid rather than from a snapshot. Its interior replicates the playable planes exactly and
// its first ring replicates the border cells cell for cell, so the ordinary chunk builder
// produces the same corner heights on both sides of the seam and closes every remaining
// crack with the walls it already emits. Nothing here is gameplay: the camera stays clamped
// to the playable bounds, units never stand on the apron, and `heightAt()` still answers
// from the authoritative grid.

import { Surface } from '../core'
import {
	HEIGHT_STEP_M,
	RELIEF_WATER_DEPTH_M,
	reliefNoise,
	TerrainGrid,
} from './grid'

/**
 * The character of the land outside the map. Change this ONE line to switch the game.
 *
 * The human on 2026-09-06: *"just make it flat or mountain country so it seems infinite but
 * just not accessible"*. `mountains` is the default because it is the richer read, and
 * because his standing rule — a mountain is at least three times the tallest building, so
 * 42 m against the 14.0 m construction yard — only means anything if part of the ring
 * actually reaches it. `plains` is the alternative, kept live so the choice can be made by
 * looking at both: flat open country running away in every direction with nothing but
 * ground haze to stop it. Nothing else moves between them — the mesh, the seam, the
 * triangle cost and the fade to fog are identical either way.
 */
export type ApronTerrain = 'mountains' | 'plains'

/** THE ONE LINE. `'plains'` for flat, `'mountains'` for mountain country. */
export const APRON_TERRAIN: ApronTerrain = 'mountains'

/** Metres of relief the ring's field produces, and the shape of the field that produces it. */
interface ApronProfile {
	/** Metres a full-strength crest reaches above the border it grows out of. */
	readonly crestM: number
	/** Metres of rolling foothill, present in every sector — the open ones included. */
	readonly footM: number
	/** Metres a valley floor sinks below the border profile where a sector stays open. */
	readonly hollowM: number
	/**
	 * Region-noise values bracketing open country and full range. Below `open` a sector
	 * carries no crest at all; above `range` it carries the whole of it. The gap between
	 * them is what makes some of the horizon foothills rather than either extreme.
	 *
	 * Two octaves of value noise concentrate near 0.5, so where this pair sits decides how
	 * much of a map's horizon is mountain at all, and it is not the same for every map: the
	 * salt is drawn from the map's own size and origin. Measured over four map shapes, 0.44
	 * and 0.72 gave 5-15% of the ring above 42 m and one of the four almost no mountain;
	 * 0.36 and 0.60 give 14-28% with 35-49% still open country on every one of them.
	 */
	readonly open: number
	readonly range: number
	/** Wavelength in cells of the field that decides which sector of the horizon is which. */
	readonly regionCells: number
	/** Wavelength in cells of the crest lines themselves. */
	readonly crestCells: number
}

const APRON_PROFILES: Readonly<Record<ApronTerrain, ApronProfile>> = {
	// crestM is the height of a crest at full field strength, not the height every crest
	// reaches: ridged noise squared rarely returns 1, so the tallest measured summits land
	// near 60 m and the median range sector nearer 30. That is deliberate — a summit that
	// every sector reaches is the rim this replaced.
	mountains: { crestM: 96, footM: 8, hollowM: 4, open: 0.36, range: 0.60, regionCells: 104, crestCells: 46 },
	plains: { crestM: 0, footM: 3.2, hollowM: 2.2, open: 0.36, range: 0.60, regionCells: 104, crestCells: 46 },
}

/** Rings over which the border profile fades into the synthesized landscape. */
const APRON_BLEND_CELLS = 5
/**
 * Smallest fraction of the ring's depth a feature takes to build, at zero field strength.
 *
 * The distance out is no longer what decides the height — it decides how far a feature
 * takes to reach the height the field gave it, and that distance scales with the height.
 * A 6 m foothill is complete a fifth of the way out, so an open sector is open right from
 * the border; a 60 m crest needs the whole ring, so it still leaves the seam flat.
 */
const APRON_REACH_MIN = 0.2
/** Metres of fine grain over the first rings, so the near apron is not a bare sheet. */
const APRON_GRAIN_M = 1.2
/**
 * Rock replaces the ground surface above this rise, or on steep flanks.
 *
 * Raised from 5.5 m when the ring stopped being uniformly tall: at 5.5 m every cell of the
 * old rim was above the line and the whole apron was rock, which is why it read as one
 * grey mass. With open sectors sitting at 3-8 m, 5.5 m would instead scatter rock through
 * grassland at random. 16 m puts the line where the ranges start and leaves open country green.
 */
const APRON_ROCKLINE_M = 16
/**
 * Metres of wander in the rockline, and the wavelength in cells it wanders over.
 *
 * A threshold with tight dither is a contour line: at the 3 m per cell a crest flank
 * climbs, ±3 m of five-cell noise moves the boundary by one cell and the eye reads the
 * result as a band painted round the mountain. ±14 m over 23 cells moves it by five and
 * it reads as a treeline.
 */
const APRON_ROCKLINE_WANDER_M = 14
const APRON_ROCKLINE_WANDER_CELLS = 23
/** Cells the ring carries the border's own surface before settling to the map's ground. */
const APRON_SURFACE_CARRY_CELLS = 5

/** Apron width in cells per quality preset: the ring is scenery and pays for itself in draws. */
export function apronWidthFor(quality: string): number {
	return quality === 'low' ? 24 : quality === 'medium' ? 32 : 40
}

/** Chunk side for apron chunks. Coarser than the playable area: nothing here needs fine culling. */
export const APRON_CHUNK = 64

export class ApronGrid extends TerrainGrid {
	/** Ring width in cells; the playable area occupies [apron, apron + inner.w) on each axis. */
	apron = 0
	/** Cells synthesized outside the playable bounds. */
	syntheticCells = 0
	private inner: TerrainGrid | null = null

	/**
	 * Build the ring around a finished grid. Replaces any previous content.
	 *
	 * @param inner The authoritative grid, already built (levels, relief and shore distances).
	 * @param apron Ring width in cells.
	 */
	buildAround(inner: TerrainGrid, apron: number): void {
		const a = Math.max(0, apron | 0)
		const iw = inner.w
		const ih = inner.h
		const w = iw + 2 * a
		const h = ih + 2 * a
		const n = w * h
		this.apron = a
		this.inner = inner
		this.w = w
		this.h = h
		this.originX = inner.originX - a
		this.originY = inner.originY - a
		this.type = new Uint8Array(n)
		this.height = new Uint8Array(n)
		this.ramp = new Uint8Array(n)
		this.passability = new Uint8Array(n).fill(1 << 4)
		this.resource = new Uint8Array(n)
		this.surface = new Uint8Array(n)
		this.waterLevel = new Float32Array(n)
		this.waterShoreDistance = new Float32Array(n)
		this.heightM = new Float32Array(n)
		this.waterOcc = new Float32Array(n)
		this.rockOcc = new Float32Array(n)
		this.presentationRelief = inner.hasPresentationRelief
		this.reliefInfo = null
		this.waterCellCount = 0
		this.syntheticCells = 0
		if (iw === 0 || ih === 0) {
			this.ready = false
			return
		}

		const innerLevel = inner.waterLevel
		const isWater = (s: number): boolean => s === Surface.water || s === Surface.shallow

		// The ground surface the ring continues: the most common playable land surface.
		const hist = new Int32Array(16)
		for (let i = 0; i < iw * ih; i++) {
			const s = inner.surface[i]
			if (s < 16 && !isWater(s) && s !== Surface.rock) hist[s]++
		}
		let base: number = Surface.grass
		for (let s = 0; s < 16; s++) if (hist[s] > hist[base]) base = s
		const snowTileset = base === Surface.snow
		// The playable plain's typical level, so the rise and the snowline are relative to it.
		let plainSum = 0
		let plainCount = 0
		for (let i = 0; i < iw * ih; i++) {
			if (isWater(inner.surface[i]) || inner.surface[i] === Surface.rock) continue
			plainSum += inner.heightMetresAt(i)
			plainCount++
		}
		const plainM = plainCount > 0 ? plainSum / plainCount : 0
		const salt = ((iw * 2654435761) ^ (ih * 40503) ^ (inner.originX * 97) ^ (inner.originY * 1013)) | 0

		// Border profile smoothed along the edge, so the far landscape does not inherit every
		// one-cell bump of the last playable row. Water cells contribute their surface level.
		const edgeHeight = (ix: number, iy: number, alongX: boolean): number => {
			let sum = 0
			let count = 0
			for (let k = -3; k <= 3; k++) {
				const x = alongX ? Math.min(iw - 1, Math.max(0, ix + k)) : ix
				const y = alongX ? iy : Math.min(ih - 1, Math.max(0, iy + k))
				const j = y * iw + x
				const lv = innerLevel[j]
				sum += Number.isFinite(lv) ? lv : inner.heightMetresAt(j)
				count++
			}
			return sum / count
		}

		// --- the land outside ------------------------------------------------------
		//
		// A radial ramp with a floor under it makes a bathtub. The previous profile was
		// `RISE * smoothstep(2, a, d)^1.4 * (0.70 + 0.30 * noise)`: `d` is the distance out,
		// so it climbed to the same 60 m in EVERY direction, and the 0.70 floor let noise
		// decorate a guaranteed wall by 30%. Measured, its outer ring ran 41-59 m with a
		// standard deviation of 4 m over 700 samples — an enclosure, and the human called it
		// what it is: "the arch upwards is ugly".
		//
		// What replaces it is a FIELD, and the distance out is not one of its terms:
		//
		//   region  a very long wavelength saying whether this sector of the horizon is open
		//           country or a range. Sectors are ~100 cells across, so a map's perimeter
		//           carries five to ten of them and two directions look different.
		//   crest   ridged noise — the field folded about its own midline — so high sectors
		//           get crest LINES with saddles between them, not round lumps.
		//   foot    small rolling relief everywhere, so open sectors are landscape too.
		//   hollow  open sectors sink slightly below the border, so a valley runs out of the
		//           map rather than a plain being merely the absence of a mountain.
		//
		// The sampling position is domain-warped first. Value noise on an axis-aligned
		// lattice reads as a grid of scallops however many octaves are stacked on it, and
		// that grid is visible in the before capture; warping the coordinates by a slower
		// noise bends the crest lines off the lattice, which is what makes them read as
		// geology rather than as a texture.
		const p = APRON_PROFILES[APRON_TERRAIN]
		const massScale = Math.max(1e-3, p.crestM + p.footM)
		/** Metres of relief this cell's field asks for, before the ring commits to it. */
		const massAt = (x: number, y: number): number => {
			const wx = x + 17 * (fbm(x, y, 62, 2, salt ^ 0x2545f491) - 0.5)
			const wy = y + 17 * (fbm(x, y, 62, 2, salt ^ 0x7feb352d) - 0.5)
			const region = fbm(wx, wy, p.regionCells, 2, salt ^ 0x1b873593)
			const range = smoothstep(p.open, p.range, region)
			const crest = ridges(wx, wy, p.crestCells, 4, salt ^ 0x85ebca6b)
			const foot = fbm(wx, wy, 27, 3, salt ^ 0xc2b2ae35)
			return p.crestM * range * crest +
				p.footM * (0.35 + 0.65 * foot) * (0.4 + 0.6 * range) -
				p.hollowM * (1 - range) * foot
		}

		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const i = y * w + x
				const ix = x - a
				const iy = y - a
				if (ix >= 0 && iy >= 0 && ix < iw && iy < ih) {
					const j = iy * iw + ix
					this.type[i] = inner.type[j]
					this.height[i] = inner.height[j]
					this.ramp[i] = inner.ramp[j]
					this.passability[i] = inner.passability[j]
					this.resource[i] = inner.resource[j]
					this.surface[i] = inner.surface[j]
					this.heightM[i] = inner.heightMetresAt(j)
					continue
				}
				this.syntheticCells++
				const cx = Math.min(iw - 1, Math.max(0, ix))
				const cy = Math.min(ih - 1, Math.max(0, iy))
				const j = cy * iw + cx
				const outX = ix < 0 ? -ix : ix >= iw ? ix - iw + 1 : 0
				const outY = iy < 0 ? -iy : iy >= ih ? iy - ih + 1 : 0
				// Quartic norm, not Euclidean. A corner cell is sqrt(2) further out under
				// hypot() than the edge cell on its own ring, so it realises more of the
				// field it was handed and every corner grows a mountain — measured, corner
				// cells averaged 20.5 m against 14.8 m on the edges. The quartic norm cuts
				// that to 1.19x while staying smooth, which max(outX, outY) is not: a
				// Chebyshev distance creases along the diagonal and the crease is drawn.
				const d = Math.pow(outX * outX * outX * outX + outY * outY * outY * outY, 0.25)
				const ring = Math.max(outX, outY)
				const s0 = inner.surface[j]
				const h0 = inner.heightMetresAt(j)
				const water0 = isWater(s0)

				if (ring <= 1) {
					// First ring, corners included: the border cell extruded one cell outward. This
					// is what makes the seam exact — both sides average the same four cells at every corner.
					this.type[i] = inner.type[j]
					this.height[i] = inner.height[j]
					this.ramp[i] = inner.ramp[j]
					this.surface[i] = s0
					this.heightM[i] = h0
					continue
				}

				const t = smoothstep(1, 1 + APRON_BLEND_CELLS, d)
				const mass = massAt(x, y)
				// How far out this cell's own feature takes to build, in cells. Proportional
				// to what the field asked for, so a foothill is finished a fifth of the way
				// out while a crest needs the whole ring — and the seam stays flat either way.
				const strength = Math.min(1, Math.max(0, mass / massScale))
				const reach = Math.max(4, 2 + (a - 2) * (APRON_REACH_MIN + (1 - APRON_REACH_MIN) * strength))
				const grain = (reliefNoise(x, y, 7, salt ^ 0x9e3779b1) - 0.5) * 2 * APRON_GRAIN_M
				const rise = smoothstep(2, reach, d) * mass + grain * smoothstep(1, 5, d)
				const alongX = outY > outX
				const profile = edgeHeight(cx, cy, alongX)
				let metres: number
				let surface: number
				if (water0) {
					// Open water continues to the middle of the ring, then a far shore rises
					// into the same landscape as the land edges — which means a far shore is
					// as free to stay a flat coastal plain as it is to become a headland.
					const shoreAt = a * 0.5
					const lv = innerLevel[j]
					const level = Number.isFinite(lv) ? lv : h0 + RELIEF_WATER_DEPTH_M
					if (d < shoreAt) {
						metres = lerp(h0, level - RELIEF_WATER_DEPTH_M, t)
						surface = Surface.water
					} else {
						const u = smoothstep(shoreAt, shoreAt + 4, d)
						// Never negative here: a hollow behind the shore would be a trench
						// filling with the same water it was supposed to end.
						const farReach = shoreAt + Math.max(4, (a - shoreAt) * (APRON_REACH_MIN + (1 - APRON_REACH_MIN) * strength))
						const farRise = smoothstep(shoreAt, farReach, d) * Math.max(0, mass)
						metres = lerp(level - RELIEF_WATER_DEPTH_M, level + 0.35, u) + farRise +
							(reliefNoise(x, y, 7, salt ^ 0x9e3779b1) - 0.5) * 2.0 * u
						surface = metres < level ? Surface.water : base
						if (metres >= level && metres < level + 0.6 && !snowTileset) surface = Surface.sand
					}
				} else {
					metres = lerp(h0, profile, t) + rise
					// The ring carries the border cell's own surface a few cells out and then
					// stops. Carrying it the whole way — which it used to, for every natural
					// surface — extrudes the last playable row's patchwork into stripes that
					// run straight out from the map and up the mountainside, and a stripe that
					// ignores the relief it lies on reads as paint, not as ground. Only the
					// old rockline hid them: with everything above 5.5 m turned to rock, there
					// was nothing left to stripe. The cutoff is dithered so it is not a line
					// parallel to the border.
					const carry = APRON_SURFACE_CARRY_CELLS *
						(0.5 + reliefNoise(x, y, 13, salt ^ 0x27d4eb2d))
					surface = d < carry && s0 !== Surface.road && s0 !== Surface.metal &&
						s0 !== Surface.concrete && s0 !== Surface.resource ? s0 : base
				}
				this.heightM[i] = metres
				this.surface[i] = surface
				this.ramp[i] = 1
			}
		}

		// Elevation overrides: rock on the steep and the high, snow above the snowline. Decided
		// from the finished field so a flank reads as rock all the way round a peak.
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const ix = x - a
				const iy = y - a
				if (ix >= -1 && iy >= -1 && ix <= iw && iy <= ih) continue
				const i = y * w + x
				if (isWater(this.surface[i])) continue
				const above = this.heightM[i] - plainM
				const l = this.heightM[y * w + Math.max(0, x - 1)]
				const r = this.heightM[y * w + Math.min(w - 1, x + 1)]
				const u = this.heightM[Math.max(0, y - 1) * w + x]
				const dn = this.heightM[Math.min(h - 1, y + 1) * w + x]
				const slope = Math.hypot(r - l, dn - u) * 0.5
				const steep = slope > 0.9 + 0.5 * reliefNoise(x, y, 3, salt ^ 0x27d4eb2d)
				// No snow caps on temperate or desert maps: a white sheet on the horizon read as
				// the world ending in nothing. Rock on the steep and the high is enough relief.
				const line = APRON_ROCKLINE_M + APRON_ROCKLINE_WANDER_M *
					(reliefNoise(x, y, APRON_ROCKLINE_WANDER_CELLS, salt ^ 0x85ebca6b) - 0.5)
				if (steep || above > line) this.surface[i] = Surface.rock
			}
		}

		let lo = Infinity
		let hi = -Infinity
		for (let i = 0; i < n; i++) {
			const v = this.heightM[i]
			if (v < lo) lo = v
			if (v > hi) hi = v
			const steps = Math.round(v / HEIGHT_STEP_M)
			this.height[i] = steps < 0 ? 0 : steps > 255 ? 255 : steps
		}
		this.minHeightM = lo
		this.maxHeightM = hi

		this.computeWaterLevels()
		// The seam must not move the water: interior cells keep the authoritative level and
		// replicated water beyond the edge continues the level of the border cell it extends.
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const i = y * w + x
				if (!Number.isFinite(this.waterLevel[i])) continue
				const cx = Math.min(iw - 1, Math.max(0, x - a))
				const cy = Math.min(ih - 1, Math.max(0, y - a))
				const lv = innerLevel[cy * iw + cx]
				if (Number.isFinite(lv)) this.waterLevel[i] = lv
			}
		}
		this.computeShoreDistances()
		this.buildCornerGrid()
		for (let i = 0; i < n; i++) if (Number.isFinite(this.waterLevel[i])) this.waterCellCount++

		if (this.presentationRelief) {
			for (let i = 0; i < n; i++) {
				this.waterOcc[i] = isWater(this.surface[i]) ? 1 : 0
				this.rockOcc[i] = this.surface[i] === Surface.rock ? 1 : 0
			}
			const previous = new Float32Array(n)
			for (let pass = 0; pass < 5; pass++) {
				for (const field of [this.waterOcc, this.rockOcc]) {
					previous.set(field)
					for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
						const i = y * w + x
						let sum = previous[i] * 2
						let count = 2
						if (x > 0) { sum += previous[i - 1]; count++ }
						if (x + 1 < w) { sum += previous[i + 1]; count++ }
						if (y > 0) { sum += previous[i - w]; count++ }
						if (y + 1 < h) { sum += previous[i + w]; count++ }
						field[i] = sum / count
					}
				}
			}
		}
		this.ready = true
	}

	/**
	 * Seam vertices must land exactly where the playable mesh put them. Inside and on the
	 * playable rectangle the authoritative grid decides the contour; the ring's own blurred
	 * occupancy, which can see the apron, only moves points strictly outside it.
	 */
	override contourAt(gx: number, gy: number, out: Float64Array): void {
		const inner = this.inner
		const a = this.apron
		if (inner && gx >= a && gy >= a && gx <= a + inner.w && gy <= a + inner.h) {
			inner.contourAt(gx - a, gy - a, out)
			out[0] += a
			out[1] += a
			return
		}
		super.contourAt(gx, gy, out)
	}
}

function smoothstep(a: number, b: number, x: number): number {
	const t = Math.min(1, Math.max(0, (x - a) / Math.max(1e-6, b - a)))
	return t * t * (3 - 2 * t)
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t
}

/**
 * Fractal value noise in [0, 1]. Each octave gets its own salt rather than its own
 * lattice offset, so the octaves are independent instead of sharing a correlated
 * skeleton at every scale — the visible symptom of sharing one is a field whose small
 * detail sits in the same places as its large detail.
 */
function fbm(x: number, y: number, wavelength: number, octaves: number, salt: number): number {
	let sum = 0
	let norm = 0
	let amp = 1
	let w = wavelength
	for (let o = 0; o < octaves; o++) {
		sum += amp * reliefNoise(x, y, w, (salt + o * 0x9e3779b1) | 0)
		norm += amp
		amp *= 0.5
		w *= 0.5
	}
	return sum / norm
}

/**
 * Ridged fractal noise in [0, 1]: the field folded about its own midline, so its maxima
 * are CRESTS running across the terrain with saddles between them rather than the round
 * lumps plain value noise makes. Squaring each octave sharpens the crest and flattens the
 * flank, which is the difference between a mountain range and a field of dunes.
 */
function ridges(x: number, y: number, wavelength: number, octaves: number, salt: number): number {
	let sum = 0
	let norm = 0
	let amp = 1
	let w = wavelength
	for (let o = 0; o < octaves; o++) {
		const f = 1 - Math.abs(2 * reliefNoise(x, y, w, (salt + o * 0x85ebca6b) | 0) - 1)
		sum += amp * f * f
		norm += amp
		amp *= 0.52
		w *= 0.46
	}
	return sum / norm
}
