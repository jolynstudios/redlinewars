// STEELSEED — terrain/chunks
// Heightfield, cliff and water geometry for one chunk of the cell grid.
//
// Cells do not share vertices, and that is a decision rather than an oversight. The
// surface plane (§4.3) is per CELL while `materialZone` is per VERTEX, so a shared
// corner between a grass cell and a road cell would have to carry one of the two and lie
// about the other — the overlay proof against §4.3 fails on exactly that lie. Unshared
// corners also give cliffs somewhere to exist: two cells the sim does not declare
// continuous pull their shared corner to their own level, and the gap between them is
// the cliff face. At one metre per cell the vertex cost is trivial next to §7's triangle
// budget.
//
// Emits ONE ground bucket and one water bucket, with each ground vertex naming two §12.3b
// atlas layers and the weight between them.
//
// It used to emit a bucket per §8 surface, because a DrawItem carries exactly one
// surfaceSet, so a triangle belonged wholly to one material and the shader had nothing to
// blend toward. That is what put every surface boundary exactly on a cell edge —
// stair-stepped, and flickering under TAA jitter (measured a 151/255 albedo swing at a
// fixed pixel).
//
// The pair is chosen PER CELL, not per vertex, and that is the crux. WGSL integer varyings
// are flat: the fragment gets the provoking vertex's copy with no interpolation available.
// Per-vertex layer indices would therefore have silently taken one corner's pair for the
// whole triangle and blended the WRONG two materials — worst exactly at boundaries, the
// only place this feature exists to work. Because both triangles of a cell carry the same
// pair, flat is not a compromise here, it is correct. Only the WEIGHT varies per vertex,
// and it is a float.
//
// Continuity across a cell edge falls out of that: cell A being (grass, rock) and cell B
// being (rock, sand) still meet as rock on their shared edge, because A's weight runs
// toward rock there and B's runs toward its own primary, which is rock.
//
// This only reaches the screen because render draws it — terrain's own triplanar pipeline
// in gpu.ts is DEAD, `render` never calls terrain.encode(), and every terrain triangle
// goes through render's forward shader via submit(). Hence DrawItem.blendZones.

import { Surface } from '../core'
import { MIN_WATER_FILM_M, SKIRT_DROP_M, reliefNoise, type TerrainGrid } from './grid'

/**
 * Interleaved vertex stride in bytes, and the attribute offsets inside it.
 *
 * These MUST stay identical to `geo/mesh`'s canonical static layout (ARCHITECTURE.md
 * §3.1) — that is the layout `render` compiles its pipelines against, and rule 3 forbids
 * importing the module that declares it, so the constants are restated here and this
 * comment is the contract: position 0, normal 12, tangent 24, uv0 40, uv1 48,
 * materialZone 56.
 */
export const VERTEX_STRIDE = 60
export const FLOATS_PER_VERTEX = VERTEX_STRIDE / 4
const ZONE_BYTE_OFFSET = 56

/** §8 has 13 surfaces. */
export const SURFACE_COUNT = 13

/**
 * Two buckets, not fourteen. Ground and cliffs all sample the one §12.3b atlas, so they
 * share a bind group and an index buffer; water keeps its own because it is a different
 * pipeline, not merely a different material.
 */
export const GROUND_BUCKET = 0
export const WATER_BUCKET = 1
export const BUCKET_COUNT = 2

/** materialZone.w — which kind of face a vertex belongs to. */
export const VertexKind = { top: 0, cliff: 1, water: 2 } as const

/** Metres of world per texture repeat. Larger than a cell, rotated in the shader, so
 *  a grass field does not reprint the 1 m lattice. */
const GROUND_TEX_METRES = 12
const WATER_TEX_METRES = 8

/**
 * Deterministic per-wall hash in [0,1). 32-bit integer avalanche over the wall's grid
 * position and edge: the cliff bake must stay a pure function of the grid (rule 5), so
 * no rng state — the same wall hashes the same way on every rebuild.
 */
function wallHash(x: number, y: number, edge: number): number {
	let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(edge, 2246822519)) | 0
	h = Math.imul(h ^ (h >>> 13), 1274126177)
	h ^= h >>> 16
	return (h >>> 0) / 4294967296
}

/**
 * Cliff faces are drawn as rock regardless of the surface on top of them.
 *
 * This is not terrain inventing grid data — the cell's surface, extent and height all
 * still come from §4.3 untouched. It is the material for a face the grid does not
 * describe at all: the sim tags the horizontal cell, never the vertical wall beneath it,
 * and a grass wall reads as a texturing bug from the first frame.
 */
const CLIFF_SURFACE: number = Surface.rock

/** A step smaller than this is float noise in the corner average, not a cliff. */
const CLIFF_EPS_M = 1e-4

/**
 * Height over which a wall's collapsed end blends its normal back to vertical, in metres.
 *
 * A wall tapering to zero — a cliff dying out into a ramp — is CORRECT geometry and must
 * not be deleted. It was, briefly, by skipping walls under a threshold, and that traded a
 * flicker for something worse: measured 59 see-through pixels in a single interior gap at
 * camera height 12, still 5 at height 100. A hole is a worse defect than a shimmer.
 *
 * So the geometry stays and the CONTRAST goes. The flicker never came from the triangle
 * being thin; it came from a near-black vertical face alternating against lit ground under
 * TAA jitter. Where the wall has collapsed to nothing its normal is blended back to up, so
 * the tip shades like the ground it dies into and the alternation has nothing to swing
 * between. That is also what the surface is physically doing at that point — turning from
 * vertical to horizontal.
 */
const CLIFF_TAPER_M = 0.35

/** |edge1 x edge2|^2 below this is a triangle with no area. One micrometre squared. */
const DEGENERATE_AREA_SQ = 1e-12

/**
 * Material blending reach in cells. The weight field is a wide gaussian, so a square
 * cluster of cells rounds off at the corners before the shader draws it. A tight
 * window left the cell lattice visible as square plates at every transition.
 */
const BLEND_REACH = 4
const BLEND_SPAN = BLEND_REACH * 2 + 1
const BLEND_FALLOFF = 0.16
const BLEND_KERNEL = ((): Float64Array => {
	const k = new Float64Array(BLEND_SPAN * BLEND_SPAN)
	for (let oy = -BLEND_REACH; oy <= BLEND_REACH; oy++)
		for (let ox = -BLEND_REACH; ox <= BLEND_REACH; ox++)
			k[(oy + BLEND_REACH) * BLEND_SPAN + ox + BLEND_REACH] = Math.exp(-(ox * ox + oy * oy) * BLEND_FALLOFF)
	return k
})()

/**
 * The four cell edges, flat so the emitter can loop rather than repeat itself four times
 * with one index transposed. Per edge:
 * `[nbOffX, nbOffZ, myA.dx, myA.dy, myB.dx, myB.dy, nbA.dx, nbA.dy, nbB.dx, nbB.dy, faceNx, faceNz]`
 *
 * `nbA`/`nbB` are the neighbour's own corners standing at the SAME two world points as
 * `myA`/`myB` — which is why they are transposed rather than equal, and why they are
 * written down instead of derived at the call site.
 */
const EDGES: readonly Int8Array[] = [
	Int8Array.of(1, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0), // east  — wall at x+1, faces +X
	Int8Array.of(-1, 0, 0, 0, 0, 1, 1, 0, 1, 1, -1, 0), // west  — wall at x,   faces -X
	Int8Array.of(0, 1, 0, 1, 1, 1, 0, 0, 1, 0, 0, 1), // south — wall at z+1, faces +Z
	Int8Array.of(0, -1, 0, 0, 1, 0, 0, 1, 1, 1, 0, -1), // north — wall at z,   faces -Z
]

export interface ChunkGeometry {
	readonly chunkX: number
	readonly chunkZ: number
	/** Interleaved vertex data, VERTEX_STRIDE bytes per vertex. */
	readonly vertexData: ArrayBuffer
	readonly vertexCount: number
	/** Triangle indices per §8 surface, plus WATER_BUCKET. Null where the chunk has none. */
	readonly indices: readonly (Uint32Array | null)[]
	readonly aabbMin: Float32Array
	readonly aabbMax: Float32Array
	readonly triangleCount: number
}

/**
 * Builds one chunk at a time into reusable staging buffers.
 *
 * Reused across every chunk of the map, so a whole rebuild costs one growth curve rather
 * than one per chunk. Rebuilds happen at map load only, never during play.
 */
export class ChunkBuilder {
	private vertexCapacity = 0
	private vertexBuffer = new ArrayBuffer(0)
	private vf = new Float32Array(0)
	private vb = new Uint8Array(0)
	private vertexCount = 0
	/** World cell of grid (0,0) — §4.2 bounds. Added to every emitted vertex. */
	private originX = 0
	private originY = 0

	private readonly buckets: Uint32Array[] = []
	private readonly bucketCounts = new Int32Array(BUCKET_COUNT)
	/** The current cell's four corner heights, indexed `dy * 2 + dx`. */
	private readonly cornerY = new Float64Array(4)
	/** Smoothed grid-space X/Z of those corners, same index. */
	private readonly cornerX = new Float64Array(4)
	private readonly cornerZ = new Float64Array(4)
	private readonly contour = new Float64Array(2)
	/** Scratch for the quad orientation test, so the Newell loop allocates nothing. */
	private readonly quad = new Int32Array(4)
	/** Scratch for taperedNormal, so a per-wall normal costs no allocation. */
	private readonly wallNormal = new Float64Array(3)

	private minX = 0
	private minY = 0
	private minZ = 0
	private maxX = 0
	private maxY = 0
	private maxZ = 0

	/** Layer count per §8 surface set, so a variant index never runs off the array texture. */
	private readonly layerCounts = new Uint8Array(SURFACE_COUNT).fill(1)
	/** Per-map salt for the variant hash, so two maps of the same shape do not tile alike. */
	private variantSalt = 0
	/**
	 * Atlas stride: physical layer for (surface, variant) is `surface * this + variant`
	 * (§12.3b). 1 until configure() runs, which makes every surface collapse onto layer 0 —
	 * visibly wrong rather than subtly wrong, which is the right failure for a value that
	 * must be set before any geometry is built.
	 */
	private variantsPerSurface = 1
	/** Scratch for layerPalette. Reused every cell; this runs per cell over the whole map. */
	private readonly palette = new Int32Array(3)
	/** Scratch tally of neighbouring surface weight per §8 surface, for layerPalette. */
	private readonly surfaceTally = new Float64Array(SURFACE_COUNT)
	/** Scratch tally of TOUCHING surfaces (8-neighbourhood) per §8 surface, for layerPalette. */
	private readonly touchTally = new Float64Array(SURFACE_COUNT)
	/** Scratch for cornerWeights: [surfaceWeight, variantWeight]. */
	private readonly cornerW = new Float64Array(2)
	/** Set by layerPalette: the secondary's §8 surface, or -1 when it is a variant of the primary's. */
	private secondarySurface = -1

	constructor() {
		for (let i = 0; i < BUCKET_COUNT; i++) this.buckets.push(new Uint32Array(1536))
		this.reserveVertices(4096)
	}

	configure(layerCounts: Uint8Array, variantSalt: number, variantsPerSurface: number): void {
		for (let i = 0; i < SURFACE_COUNT; i++) {
			const n = layerCounts[i]
			this.layerCounts[i] = n > 0 ? n : 1
		}
		this.variantSalt = variantSalt >>> 0
		this.variantsPerSurface = Math.max(1, variantsPerSurface | 0)
	}

	/** Physical atlas layer for a cell's chosen surface. Mirrors materials/atlas.atlasLayer. */
	private layerFor(cx: number, cy: number, surface: number): number {
		return surface * this.variantsPerSurface + this.variantFor(cx, cy, surface)
	}

	/** The atlas layer a cell actually draws: its own surface at its own hashed variant. */
	private layerAt(grid: TerrainGrid, cx: number, cy: number): number {
		const x = Math.min(Math.max(cx, 0), grid.w - 1)
		const y = Math.min(Math.max(cy, 0), grid.h - 1)
		return this.layerFor(x, y, grid.renderedSurface(grid.index(x, y)))
	}

	/**
	 * The cell's THREE atlas layers: its own, its dominant differing-surface neighbour, and
	 * its dominant differing-variant neighbour of its own surface.
	 *
	 * Three slots, not two, and the third one is not a luxury. A cell has two independent
	 * transitions to represent and they can both be live at the same place:
	 *
	 *   - a SURFACE transition — snow meeting rock — which is the boundary a player reads
	 *     as a boundary, and which leaving unblended is what produced stair-stepped edges;
	 *   - a VARIANT transition, because neighbouring cells of the same surface can still
	 *     sit on different atlas layers, and a hard switch there is a 1 m stamp on
	 *     otherwise flat ground.
	 *
	 * With only two slots those compete, and ranking one above the other cannot fix it —
	 * it only chooses which defect to keep. Measured at the worst pixel on the map: cell
	 * (11,89) is snow variant 1 and cell (11,90) is snow variant 3, and each spent its one
	 * secondary slot correctly on a real surface boundary (resource and rock respectively).
	 * The two snow variants were therefore left unable to blend with EACH OTHER, switching
	 * layer 41 to 43 directly, for a 101/255 swing cycling exactly with the 8-phase Halton
	 * jitter. Slot 2 exists to hold that variant while slot 1 holds the surface.
	 *
	 * Slots are independent rather than ranked, so neither transition can starve the other.
	 * An absent transition leaves its slot equal to the primary, which weighs zero.
	 *
	 * Ties break toward the lower layer so the choice cannot depend on gather order (§5.2).
	 */
	private layerPalette(grid: TerrainGrid, cx: number, cy: number): void {
		const ownSurface = this.surfaceAt(grid, cx, cy)
		const own = this.layerAt(grid, cx, cy)
		this.palette[0] = own

		// Slot 1: the dominant differing SURFACE within BLEND_REACH cells, counted by surface
		// and weighted by distance. A wide window is what lets the transition start before
		// the boundary cell and end after it, instead of switching inside one metre.
		const counts = this.surfaceTally
		counts.fill(0)
		// A surface the cell TOUCHES outranks a heavier one further away. The wide window
		// alone let a road ring three cells off win over the rock cell right next door, and
		// a cell without its neighbour's surface in its palette cannot blend toward it: that
		// edge fell back to a hard cell boundary.
		const touch = this.touchTally
		touch.fill(0)
		let bestTouch = -1
		let bestTouchWeight = 0
		let bestSurface = -1
		let bestSurfaceWeight = 0
		// Slot 2: the dominant differing VARIANT of our own surface, from the 3x3 around us.
		let bestVariant = -1
		let bestVariantCount = 0
		for (let oy = -BLEND_REACH; oy <= BLEND_REACH; oy++) {
			for (let ox = -BLEND_REACH; ox <= BLEND_REACH; ox++) {
				if (ox === 0 && oy === 0) continue
				const nx = cx + ox
				const ny = cy + oy
				const ns = this.surfaceAt(grid, nx, ny)
				if (ns !== ownSurface) {
					const wgt = BLEND_KERNEL[(oy + BLEND_REACH) * BLEND_SPAN + ox + BLEND_REACH]
					const total = (counts[ns] += wgt)
					if (total > bestSurfaceWeight || (total === bestSurfaceWeight && bestSurface >= 0 && ns < bestSurface)) {
						bestSurface = ns
						bestSurfaceWeight = total
					}
					if (Math.abs(ox) <= 1 && Math.abs(oy) <= 1) {
						// A shared edge counts double a shared corner.
						const t = (touch[ns] += ox === 0 || oy === 0 ? 2 : 1)
						if (t > bestTouchWeight || (t === bestTouchWeight && bestTouch >= 0 && ns < bestTouch)) {
							bestTouch = ns
							bestTouchWeight = t
						}
					}
				} else if (Math.abs(ox) <= 1 && Math.abs(oy) <= 1) {
					const l = this.layerAt(grid, nx, ny)
					if (l === own) continue
					let count = 0
					for (let f = 0; f < 4; f++) {
						const fx = cx + (f === 0 ? -1 : f === 1 ? 1 : 0)
						const fy = cy + (f === 2 ? -1 : f === 3 ? 1 : 0)
						if (this.layerAt(grid, fx, fy) === l) count++
					}
					if (count > bestVariantCount || (count === bestVariantCount && bestVariant >= 0 && l < bestVariant)) {
						bestVariant = l
						bestVariantCount = count
					}
				}
			}
		}

		// A differing surface is re-hashed at THIS cell's coordinate rather than taken at the
		// neighbour's own variant, so the blend stays inside one tiling and the corner weight
		// can be counted by surface. Counting a neighbour's specific variant instead splits
		// the tally across whatever variants that region uses, which starves the blend
		// exactly where it matters most — measured, on an earlier build of this function.
		if (bestTouch >= 0) bestSurface = bestTouch
		this.palette[1] = bestSurface >= 0 ? this.layerFor(cx, cy, bestSurface) : own
		this.palette[2] = bestVariant >= 0 ? bestVariant : own
		this.secondarySurface = bestSurface
	}

	/**
	 * The atlas layer every cell draws, row-major over `grid`, for the per-pixel ground
	 * blend (render.setCellLayers): the shader mixes the four cells around each pixel from
	 * this map. Same layerAt the palettes use, so a cell's own layer is unchanged.
	 */
	cellLayerMap(grid: TerrainGrid): Uint8Array<ArrayBuffer> {
		const out = new Uint8Array(grid.w * grid.h)
		for (let y = 0; y < grid.h; y++)
			for (let x = 0; x < grid.w; x++) out[y * grid.w + x] = Math.min(this.layerAt(grid, x, y), 255)
		return out
	}

	private surfaceAt(grid: TerrainGrid, cx: number, cy: number): number {
		const x = Math.min(Math.max(cx, 0), grid.w - 1)
		const y = Math.min(Math.max(cy, 0), grid.h - 1)
		return grid.renderedSurface(grid.index(x, y))
	}

	/**
	 * Weights of palette slots 1 and 2 at corner (dx, dy), written into `out`.
	 *
	 * Slot 1 is the distance-weighted share of the secondary SURFACE among the cells within
	 * BLEND_REACH of the corner; slot 2 the same window over same-surface cells of the
	 * variant layer. Slot 0 takes what remains, so the three always sum to 1 and the
	 * shader needs two interpolants.
	 *
	 * Corner-centred and symmetric, so the two cells sharing an edge compute the same weight
	 * at both of its ends — including across chunk borders — and a boundary reads as a band
	 * several cells wide with no visible cell edge in it. The shader's height blend then
	 * interlocks the two materials inside that band rather than crossfading them.
	 */
	private cornerWeights(
		grid: TerrainGrid,
		cx: number,
		cy: number,
		dx: number,
		dy: number,
		out: Float64Array,
	): void {
		const own = this.palette[0]
		const surfaceLayer = this.palette[1]
		const variantLayer = this.palette[2]
		const secondarySurface = this.secondarySurface
		let surfaceWeight = 0
		let surfaceTotal = 0
		let variantWeight = 0
		let variantTotal = 0
		// The corner sits between cells (cx+dx-1, cy+dy-1) and (cx+dx, cy+dy); the window is
		// symmetric around it, BLEND_REACH cells to each side.
		const gx = cx + dx
		const gy = cy + dy
		// Both shares are PAIRWISE: only the two things this cell can draw count toward the
		// total. A third surface in the window (a road near a rock edge) used to dilute the
		// snow cell's rock share but not the rock cell's snow share, so the two cells sharing
		// a corner disagreed on the mixture there by exactly the road's share, and the edge
		// between them read as a seam. Pairwise, both sides compute the same ratio.
		const ownSurface = this.surfaceAt(grid, cx, cy)
		if (secondarySurface >= 0 && surfaceLayer !== own) {
			for (let oy = -BLEND_REACH; oy <= BLEND_REACH; oy++) {
				for (let ox = -BLEND_REACH; ox <= BLEND_REACH; ox++) {
					const s = this.surfaceAt(grid, gx + ox, gy + oy)
					if (s !== ownSurface && s !== secondarySurface) continue
					// Distance from the corner to the cell centre, in cells; gaussian falloff.
					const ddx = ox + 0.5
					const ddy = oy + 0.5
					const wgt = Math.exp(-(ddx * ddx + ddy * ddy) * BLEND_FALLOFF)
					surfaceTotal += wgt
					if (s === secondarySurface) surfaceWeight += wgt
				}
			}
		}
		if (variantLayer !== own) {
			for (let oy = -BLEND_REACH; oy <= BLEND_REACH; oy++) {
				for (let ox = -BLEND_REACH; ox <= BLEND_REACH; ox++) {
					const nx = gx + ox
					const ny = gy + oy
					if (this.surfaceAt(grid, nx, ny) !== ownSurface) continue
					const l = this.layerAt(grid, nx, ny)
					if (l !== own && l !== variantLayer) continue
					const ddx = ox + 0.5
					const ddy = oy + 0.5
					const wgt = Math.exp(-(ddx * ddx + ddy * ddy) * BLEND_FALLOFF)
					variantTotal += wgt
					if (l === variantLayer) variantWeight += wgt
				}
			}
		}
		out[0] = surfaceTotal > 0 ? surfaceWeight / surfaceTotal : 0
		out[1] = variantTotal > 0 ? variantWeight / variantTotal : 0
	}
	/**
	 * Builds the chunk covering cells [x0,x1) × [z0,z1). Returns null when the range is
	 * empty, which is the only way a chunk produces no geometry — every cell in bounds
	 * emits at least its top quad.
	 */
	build(grid: TerrainGrid, chunkX: number, chunkZ: number, x0: number, z0: number, x1: number, z1: number): ChunkGeometry | null {
		// Taken from the grid each build rather than stored at configure() time: the origin
		// arrives with the map, and a stale one silently offsets the whole battlefield.
		this.originX = grid.originX
		this.originY = grid.originY
		this.vertexCount = 0
		this.bucketCounts.fill(0)
		this.minX = Infinity
		this.minY = Infinity
		this.minZ = Infinity
		this.maxX = -Infinity
		this.maxY = -Infinity
		this.maxZ = -Infinity

		for (let cy = z0; cy < z1; cy++) for (let cx = x0; cx < x1; cx++) this.emitCell(grid, cx, cy)
		if (this.vertexCount === 0) return null

		const indices = new Array<Uint32Array | null>(BUCKET_COUNT).fill(null)
		let triangleCount = 0
		for (let b = 0; b < BUCKET_COUNT; b++) {
			const n = this.bucketCounts[b]
			if (n === 0) continue
			indices[b] = this.buckets[b].slice(0, n)
			triangleCount += n / 3
		}

		return {
			chunkX,
			chunkZ,
			vertexData: this.vertexBuffer.slice(0, this.vertexCount * VERTEX_STRIDE),
			vertexCount: this.vertexCount,
			indices,
			aabbMin: Float32Array.of(this.minX, this.minY, this.minZ),
			aabbMax: Float32Array.of(this.maxX, this.maxY, this.maxZ),
			triangleCount,
		}
	}

	// -----------------------------------------------------------------------
	// Cell emission
	// -----------------------------------------------------------------------

	private emitCell(grid: TerrainGrid, cx: number, cy: number): void {
		const cell = grid.index(cx, cy)
		const surface = grid.renderedSurface(cell)

		// The cell's two materials: its own, and the dominant differing edge neighbour.
		//
		// A cell touching three or more distinct surfaces can name only two, so the third is
		// approximated by whichever of the pair is nearer. Measured on the current default
		// dev map: 320 of 9,025 interior 2x2 neighbourhoods (3.55%) contain 3+ surfaces, and
		// 309 of those 320 involve `resource` — non-band overrides, not the elevation
		// ordering. Naming the DOMINANT pair is what keeps that residue small; an earlier
		// version kept the first two surfaces encountered and dropped the dominant one at
		// 17.1% of triple corners.
		this.layerPalette(grid, cx, cy)
		const l0 = this.palette[0]
		const l1 = this.palette[1]
		const l2 = this.palette[2]
		const cw = this.cornerW
		this.cornerWeights(grid, cx, cy, 0, 0, cw)
		const s00 = cw[0]
		const v00 = cw[1]
		this.cornerWeights(grid, cx, cy, 1, 0, cw)
		const s10 = cw[0]
		const v10 = cw[1]
		this.cornerWeights(grid, cx, cy, 0, 1, cw)
		const s01 = cw[0]
		const v01 = cw[1]
		this.cornerWeights(grid, cx, cy, 1, 1, cw)
		const s11 = cw[0]
		const v11 = cw[1]

		const y = this.cornerY
		y[0] = grid.cornerHeightM(cx, cy, 0, 0)
		y[1] = grid.cornerHeightM(cx, cy, 1, 0)
		y[2] = grid.cornerHeightM(cx, cy, 0, 1)
		y[3] = grid.cornerHeightM(cx, cy, 1, 1)
		const px = this.cornerX
		const pz = this.cornerZ
		const xz = this.contour
		grid.contourAt(cx, cy, xz); px[0] = xz[0]; pz[0] = xz[1]
		grid.contourAt(cx + 1, cy, xz); px[1] = xz[0]; pz[1] = xz[1]
		grid.contourAt(cx, cy + 1, xz); px[2] = xz[0]; pz[2] = xz[1]
		grid.contourAt(cx + 1, cy + 1, xz); px[3] = xz[0]; pz[3] = xz[1]

		// Gradient of the bilinear patch. One cell is one metre (§12.4), so the run is 1
		// and the divisor is just the two-sample average.
		const dhdx = (y[1] + y[3] - y[0] - y[2]) * 0.5
		const dhdz = (y[2] + y[3] - y[0] - y[1]) * 0.5
		const nl = Math.hypot(dhdx, 1, dhdz)
		const nx = -dhdx / nl
		const ny = 1 / nl
		const nz = -dhdz / nl
		// Tangent is +X carried onto the surface. Handedness is -1: uv0.v runs with +Z
		// while cross(n, t) points at -Z, and the shader rebuilds the bitangent as
		// w * cross(n, t).
		const tl = Math.hypot(1, dhdx)
		const tx = 1 / tl
		const ty = dhdx / tl
		const g = 1 / GROUND_TEX_METRES

		// uv1 carries the two blend weights for ground, NOT (slope, 0). `slope` had exactly one
		// consumer-to-be and no live reader, and the shader can recover it from the normal as
		// 1 - n.y for free; these two interpolants cannot be recovered from anything.
		const a = this.smoothTop(grid, cx, cy, px[0], y[0], pz[0], nx, ny, nz, tx, ty, g, s00, v00, l0, l1, l2)
		const b = this.smoothTop(grid, cx, cy+1, px[2], y[2], pz[2], nx, ny, nz, tx, ty, g, s01, v01, l0, l1, l2)
		const c = this.smoothTop(grid, cx+1, cy+1, px[3], y[3], pz[3], nx, ny, nz, tx, ty, g, s11, v11, l0, l1, l2)
		const d = this.smoothTop(grid, cx+1, cy, px[1], y[1], pz[1], nx, ny, nz, tx, ty, g, s10, v10, l0, l1, l2)
		this.emitQuad(GROUND_BUCKET, a, b, c, d, nx, ny, nz)

		for (let e = 0; e < 4; e++) this.emitWall(grid, cx, cy, e)
		this.emitWater(grid, cx, cy, cell, surface)
	}

	private smoothTop(grid:TerrainGrid,cx:number,cy:number,x:number,y:number,z:number,nx:number,ny:number,nz:number,tx:number,ty:number,g:number,s:number,v:number,l0:number,l1:number,l2:number):number {
		if(grid.hasPresentationRelief) {
			// A shared vertex gets the same derivative from every adjoining cell, including
			// chunk borders. Flat per-cell normals made even sloping hills look tiled.
			const wx=cx+grid.originX,wz=cy+grid.originY
			const dx=(grid.groundHeightAt(wx+.5,wz)-grid.groundHeightAt(wx-.5,wz))
			const dz=(grid.groundHeightAt(wx,wz+.5)-grid.groundHeightAt(wx,wz-.5))
			const length=Math.hypot(dx,1,dz),tangent=Math.hypot(1,dx)
			nx=-dx/length;ny=1/length;nz=-dz/length;tx=1/tangent;ty=dx/tangent
		}
		return this.pushVertex(x,y,z,nx,ny,nz,tx,ty,0,-1,x*g,z*g,s,v,l0,l1,l2,VertexKind.top)
	}

	/**
	 * One wall between this cell and one neighbour, or the border skirt where there is no
	 * neighbour.
	 *
	 * The higher cell always owns the face, so each wall is emitted exactly once and two
	 * cells never draw it back to back into a z-fight.
	 */
	private emitWall(grid: TerrainGrid, cx: number, cy: number, edge: number): void {
		const ed = EDGES[edge]
		const nbx = cx + ed[0]
		const nby = cy + ed[1]
		const ia = ed[3] * 2 + ed[2]
		const ib = ed[5] * 2 + ed[4]
		const ax = this.cornerX[ia]
		const az = this.cornerZ[ia]
		const bx = this.cornerX[ib]
		const bz = this.cornerZ[ib]
		const topA = this.cornerY[ia]
		const topB = this.cornerY[ib]

		let botA: number
		let botB: number
		if (nbx < 0 || nby < 0 || nbx >= grid.w || nby >= grid.h) {
			// No neighbour: drop a skirt so the world does not end in a see-through hole.
			botA = grid.minHeightM - SKIRT_DROP_M
			botB = botA
		} else {
			botA = grid.cornerHeightM(nbx, nby, ed[6], ed[7])
			botB = grid.cornerHeightM(nbx, nby, ed[8], ed[9])
		}
		// EVERY crack gets a face, however small. Skipping the small ones was tried and is
		// worse: see CLIFF_TAPER_M.
		if (topA - botA <= CLIFF_EPS_M && topB - botB <= CLIFF_EPS_M) return
		if (botA > topA) botA = topA
		if (botB > topB) botB = topB

		const fnx = ed[10]
		const fnz = ed[11]
		// One material throughout: secondary == primary, weight 0. Same bucket as the ground —
		// same atlas, same pipeline, one fewer draw.
		const cliffLayer = this.layerFor(cx + nbx, cy + nby, CLIFF_SURFACE)
		// Wall UVs run along the edge horizontally and up the face vertically, so a
		// four-metre cliff keeps the texel density of the ground it grows out of.
		const uA = fnz !== 0 ? ax : az
		const uB = fnz !== 0 ? bx : bz
		const tgx = fnz !== 0 ? 1 : 0
		const tgz = fnz !== 0 ? 0 : 1
		// Whichever sign makes cross(n, t) point at +Y, because uv0.v climbs the wall.
		const tw = fnx > 0 || fnz < 0 ? -1 : 1
		const g = 1 / GROUND_TEX_METRES
		// The world-aligned 12 m repeat made every cliff face show the same rock slice
		// at the same alignment — the "square tiles" read. A deterministic hash of the
		// wall's own grid position shifts u and v by a fraction of one period: adjacent
		// walls sample different slices (natural rock is chaotic), no seam can open
		// because the atlas tiles, and the bake stays a pure function of the grid.
		const uPhase = wallHash(cx + nbx, cy + nby, edge)
		const vPhase = wallHash(cy + nby, cx + nbx, edge + 4)

		// Per-END normal, tapered toward up as that end collapses. A wall is emitted whenever
		// EITHER end has a step, so one end is routinely zero-height while the other is a
		// full metre — 60 such walls on the dev map. The thin end is what aliases: sub-pixel
		// wide, and near black because a vertical face gets no sun at this elevation, so TAA
		// jitter swings it against the lit ground beside it.
		//
		// Blending its normal to up removes the swing at its source and is what the surface
		// is actually doing there, since the cliff is turning into the ramp it dies into.
		// The geometry is untouched, so no crack can open — which the alternative, skipping
		// short walls, could not say: it left 59 see-through pixels in one interior gap.
		// taperedNormal writes into one shared scratch vector. Snapshot A before computing
		// B, otherwise both names alias the same array and the second call silently gives
		// BOTH ends B's normal — exactly the asymmetry this per-end taper is meant to avoid.
		const nA = this.taperedNormal(fnx, fnz, topA - botA)
		const nAx = nA[0]
		const nAy = nA[1]
		const nAz = nA[2]
		const nB = this.taperedNormal(fnx, fnz, topB - botB)

		// uv1.x is ordinarily the second material's blend weight. A cliff names the same
		// atlas layer in all three slots, so that weight is otherwise inert and can carry
		// the normal-map fade without growing the pinned 60-byte vertex. `normal.y` is
		// exactly the taper amount we need: 1 at a collapsed tip, 0 on a full wall.
		const ta = this.pushVertex(ax, topA, az, nAx, nAy, nAz, tgx, 0, tgz, tw, uA * g + uPhase, topA * g + vPhase, nAy, 0, cliffLayer, cliffLayer, cliffLayer, VertexKind.cliff)
		const tb = this.pushVertex(bx, topB, bz, nB[0], nB[1], nB[2], tgx, 0, tgz, tw, uB * g + uPhase, topB * g + vPhase, nB[1], 0, cliffLayer, cliffLayer, cliffLayer, VertexKind.cliff)
		const bb = this.pushVertex(bx, botB, bz, nB[0], nB[1], nB[2], tgx, 0, tgz, tw, uB * g + uPhase, botB * g + vPhase, nB[1], 0, cliffLayer, cliffLayer, cliffLayer, VertexKind.cliff)
		const ba = this.pushVertex(ax, botA, az, nAx, nAy, nAz, tgx, 0, tgz, tw, uA * g + uPhase, botA * g + vPhase, nAy, 0, cliffLayer, cliffLayer, cliffLayer, VertexKind.cliff)
		this.emitQuad(GROUND_BUCKET, ta, tb, bb, ba, fnx, 0, fnz)
	}

	/**
	 * Wall normal at an end of given height: the face normal at full height, rotated
	 * smoothly to straight up as the height collapses to nothing.
	 *
	 * Writes into a reused array — this runs four times per wall over the whole map.
	 */
	private taperedNormal(fnx: number, fnz: number, height: number): Float64Array {
		const out = this.wallNormal
		const t = height >= CLIFF_TAPER_M ? 0 : 1 - Math.max(height, 0) / CLIFF_TAPER_M
		// Smoothstep rather than linear: a linear ramp puts the steepest normal change right
		// where the wall is thinnest, which is the one place it is most visible.
		const k = t * t * (3 - 2 * t)
		const x = fnx * (1 - k)
		const y = k
		const z = fnz * (1 - k)
		const len = Math.hypot(x, y, z) || 1
		out[0] = x / len
		out[1] = y / len
		out[2] = z / len
		return out
	}

	private emitWater(grid: TerrainGrid, cx: number, cy: number, cell: number, surface: number): void {
		const level = grid.waterLevel[cell]
		if (!Number.isFinite(level)) return
		// An island inside a lake has its bed above the surface; it stays dry.
		if (level - grid.heightMetresAt(cell) <= MIN_WATER_FILM_M) return

		const waterLayer = this.layerFor(cx, cy, surface === Surface.gravel && grid.isWaterCell(cell) ? Surface.water : surface)
		const d00 = grid.waterDepthAtCornerM(cx, cy, 0, 0)
		const d01 = grid.waterDepthAtCornerM(cx, cy, 0, 1)
		const d11 = grid.waterDepthAtCornerM(cx, cy, 1, 1)
		const d10 = grid.waterDepthAtCornerM(cx, cy, 1, 0)
		const s00 = grid.waterShoreDistanceAtCornerM(cx, cy, 0, 0)
		const s01 = grid.waterShoreDistanceAtCornerM(cx, cy, 0, 1)
		const s11 = grid.waterShoreDistanceAtCornerM(cx, cy, 1, 1)
		const s10 = grid.waterShoreDistanceAtCornerM(cx, cy, 1, 0)
		const g = 1 / WATER_TEX_METRES

		const p = this.contour
		grid.contourAt(cx, cy, p)
		const a = this.pushVertex(p[0], level, p[1], 0, 1, 0, 1, 0, 0, -1, p[0] * g, p[1] * g, s00, d00, waterLayer, waterLayer, waterLayer, VertexKind.water)
		grid.contourAt(cx, cy + 1, p)
		const b = this.pushVertex(p[0], level, p[1], 0, 1, 0, 1, 0, 0, -1, p[0] * g, p[1] * g, s01, d01, waterLayer, waterLayer, waterLayer, VertexKind.water)
		grid.contourAt(cx + 1, cy + 1, p)
		const c = this.pushVertex(p[0], level, p[1], 0, 1, 0, 1, 0, 0, -1, p[0] * g, p[1] * g, s11, d11, waterLayer, waterLayer, waterLayer, VertexKind.water)
		grid.contourAt(cx + 1, cy, p)
		const d = this.pushVertex(p[0], level, p[1], 0, 1, 0, 1, 0, 0, -1, p[0] * g, p[1] * g, s10, d10, waterLayer, waterLayer, waterLayer, VertexKind.water)
		this.emitQuad(WATER_BUCKET, a, b, c, d, 0, 1, 0)
	}

	// -----------------------------------------------------------------------
	// Staging
	// -----------------------------------------------------------------------

	/**
	 * Deterministic variant layer for a cell.
	 *
	 * Sampled from a rotated, interpolated field at several cells' scale rather than
	 * hashed per metre, so a grass plain is a few large patches instead of a
	 * checkerboard of independently stamped cells. Still a function of (cx, cy, surface,
	 * salt) only: two runs of the same seed stay byte-identical (§5.2) even if chunk
	 * size changes underneath.
	 */
	private variantFor(cx: number, cy: number, surface: number): number {
		const layers = surface >= 0 && surface < SURFACE_COUNT ? this.layerCounts[surface] : 1
		if (layers <= 1) return 0
		const px = cx * 0.8 - cy * 0.6
		const py = cx * 0.6 + cy * 0.8
		const n = reliefNoise(px, py, 9, (this.variantSalt ^ Math.imul(surface + 1, 0x9e3779b9)) >>> 0)
		return Math.min(layers - 1, (n * layers) | 0)
	}

	private reserveVertices(n: number): void {
		if (n <= this.vertexCapacity) return
		const cap = Math.max(n, this.vertexCapacity * 2, 4096)
		const buf = new ArrayBuffer(cap * VERTEX_STRIDE)
		new Uint8Array(buf).set(new Uint8Array(this.vertexBuffer, 0, this.vertexCount * VERTEX_STRIDE))
		this.vertexBuffer = buf
		this.vf = new Float32Array(buf)
		this.vb = new Uint8Array(buf)
		this.vertexCapacity = cap
	}

	private pushVertex(
		x: number,
		yy: number,
		z: number,
		nx: number,
		ny: number,
		nz: number,
		tx: number,
		ty: number,
		tz: number,
		tw: number,
		u0: number,
		v0: number,
		u1: number,
		v1: number,
		layer0: number,
		layer1: number,
		layer2: number,
		kind: number,
	): number {
		const i = this.vertexCount
		if (i >= this.vertexCapacity) this.reserveVertices(i + 1)
		const o = i * FLOATS_PER_VERTEX
		const f = this.vf
		// Grid-local index in, ABSOLUTE world metres out. §4.3's planes start at the
		// playable bounds while actor positions, projectiles and crater events are all
		// absolute (§12.5), so a mesh emitted at raw grid indices sits (boundsLeft,
		// boundsTop) metres away from everything standing on it. One cell is one metre
		// (§12.4), so the cell offset IS the metre offset. Applied in the one place every
		// vertex passes through, rather than at each of the three call sites.
		const worldX = x + this.originX
		const worldZ = z + this.originY
		f[o] = worldX
		f[o + 1] = yy
		f[o + 2] = worldZ
		f[o + 3] = nx
		f[o + 4] = ny
		f[o + 5] = nz
		f[o + 6] = tx
		f[o + 7] = ty
		f[o + 8] = tz
		f[o + 9] = tw
		f[o + 10] = u0
		f[o + 11] = v0
		f[o + 12] = u1
		f[o + 13] = v1
		// §12.3b payload: .xyz are three ATLAS LAYERS (surface * variantsPerSurface + variant)
		// and .w the face kind. The two weights live in uv1, because they must INTERPOLATE
		// and a byte channel read as an integer cannot.
		//
		// 13 surfaces x 4 variants = 52 layers, comfortably inside a byte. A wider atlas
		// would need this widened, so the invariant is worth stating: layers stay under 256.
		const bo = i * VERTEX_STRIDE + ZONE_BYTE_OFFSET
		const bytes = this.vb
		bytes[bo] = layer0
		bytes[bo + 1] = layer1
		bytes[bo + 2] = layer2
		bytes[bo + 3] = kind

		// Culling must use the same absolute coordinates written to the GPU. The old local
		// AABB was displaced by (boundsLeft,boundsTop), culling visible edge chunks and
		// exposing the renderer clear colour as large grey wedges around real RA maps.
		if (worldX < this.minX) this.minX = worldX
		if (yy < this.minY) this.minY = yy
		if (worldZ < this.minZ) this.minZ = worldZ
		if (worldX > this.maxX) this.maxX = worldX
		if (yy > this.maxY) this.maxY = yy
		if (worldZ > this.maxZ) this.maxZ = worldZ
		this.vertexCount = i + 1
		return i
	}

	/**
	 * Two triangles, wound so the face points at (dnx, dny, dnz).
	 *
	 * Winding is checked against the geometry rather than assumed from the corner order: a
	 * wall's corner order flips with the direction it faces, and a hand-written table of
	 * eight orderings is exactly the kind of thing that ships with one entry backwards and
	 * a hole in the world where it should be.
	 *
	 * The check is Newell's normal over all four corners, not one triangle's cross
	 * product. A wall that runs out of height at one end has a degenerate first triangle,
	 * whose cross product is zero and whose sign therefore decides nothing — that put two
	 * inside-out cliff triangles on the test map before this was Newell.
	 */
	private emitQuad(bucket: number, a: number, b: number, c: number, d: number, dnx: number, dny: number, dnz: number): void {
		const f = this.vf
		const q = this.quad
		q[0] = a
		q[1] = b
		q[2] = c
		q[3] = d
		let gx = 0
		let gy = 0
		let gz = 0
		for (let i = 0; i < 4; i++) {
			const o0 = q[i] * FLOATS_PER_VERTEX
			const o1 = q[(i + 1) & 3] * FLOATS_PER_VERTEX
			gx += (f[o0 + 1] - f[o1 + 1]) * (f[o0 + 2] + f[o1 + 2])
			gy += (f[o0 + 2] - f[o1 + 2]) * (f[o0] + f[o1])
			gz += (f[o0] - f[o1]) * (f[o0 + 1] + f[o1 + 1])
		}
		if (gx * dnx + gy * dny + gz * dnz >= 0) {
			this.pushTriangle(bucket, a, b, c)
			this.pushTriangle(bucket, a, c, d)
		} else {
			this.pushTriangle(bucket, a, d, c)
			this.pushTriangle(bucket, a, c, b)
		}
	}

	/** Drops zero-area triangles: a wall that is flush at one end emits one, and it would
	 *  cost index bandwidth and a rasteriser visit to draw nothing. */
	private pushTriangle(bucket: number, a: number, b: number, c: number): void {
		const f = this.vf
		const oa = a * FLOATS_PER_VERTEX
		const ob = b * FLOATS_PER_VERTEX
		const oc = c * FLOATS_PER_VERTEX
		const e1x = f[ob] - f[oa]
		const e1y = f[ob + 1] - f[oa + 1]
		const e1z = f[ob + 2] - f[oa + 2]
		const e2x = f[oc] - f[oa]
		const e2y = f[oc + 1] - f[oa + 1]
		const e2z = f[oc + 2] - f[oa + 2]
		const nx = e1y * e2z - e1z * e2y
		const ny = e1z * e2x - e1x * e2z
		const nz = e1x * e2y - e1y * e2x
		if (nx * nx + ny * ny + nz * nz < DEGENERATE_AREA_SQ) return

		let arr = this.buckets[bucket]
		const n = this.bucketCounts[bucket]
		if (n + 3 > arr.length) {
			const grown = new Uint32Array(Math.max(arr.length * 2, n + 3, 1536))
			grown.set(arr)
			this.buckets[bucket] = grown
			arr = grown
		}
		arr[n] = a
		arr[n + 1] = b
		arr[n + 2] = c
		this.bucketCounts[bucket] = n + 3
	}
}

/**
 * Chunk side in cells. Bigger chunks cull coarser; smaller ones cost draw calls, and
 * `low` is the WebGL2 preset with an 800-draw budget (§7), so it trades cull granularity
 * for a quarter of the calls.
 */
export function chunkSizeFor(quality: string): number {
	return quality === 'low' ? 32 : 16
}
