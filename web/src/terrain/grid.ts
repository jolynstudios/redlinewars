// STEELSEED — terrain/grid
// The CPU-side model of the battlefield: the sim's six u8 cell planes (§4.3) plus the
// two derived quantities the mesh and the queries need — corner heights and per-body
// water levels.
//
// This file is the single source of ground truth for the node. The mesh builder, the
// heightAt() used by anim for foot IK and vehicle suspension, and the cliff detector all
// read it, so they cannot disagree with each other or with the sim. §4.3 is explicit:
// "the render must match this grid exactly" and "terrain never invents its own
// passability", and the gate is an overlay proof against that section — which means the
// height a unit stands on and the height a triangle is drawn at have to come from the
// same function, not from two that happen to agree today.

import { Surface, type TerrainStaticView, WDIST_CELL } from '../core'
import { HERO_BRIDGE, bridgeContains, bridgeSupportHeight, type BridgeLandmark } from './bridge-contract'

/**
 * WDist per OpenRA cell-height step. §12.4 pins 1024 WDist = 1 metre and one cell = one
 * metre, so a height step is half a metre: on a rectangular grid a step is half a cell
 * of rise, which is the 26.6° ramp OpenRA's movement rules assume. This is the ONE
 * number to change if the bridge ever emits a different rise per step — nothing else in
 * the node hardcodes a height scale.
 */
export const HEIGHT_STEP_WDIST = 512
export const HEIGHT_STEP_M = HEIGHT_STEP_WDIST / WDIST_CELL

/**
 * A water body is guaranteed at least this much depth over its deepest bed cell, so the
 * water plane can never land exactly on the bed and z-fight it away.
 */
export const MIN_WATER_DEPTH_M = 0.12

/** Below this the water film is thinner than the tint can show; skip the quad instead. */
export const MIN_WATER_FILM_M = 0.02

/** How far the border skirt drops below the lowest cell, so the map edge is never see-through. */
export const SKIRT_DROP_M = 6

/**
 * Presentation relief scale for RA tilesets, in metres. One cell is one metre and a tank
 * is about two, so a terrace is a tank's length tall, and the tallest hill on a map is
 * capped well under the camera's lowest legal height (8 m above the ground it follows).
 */
export const RELIEF_WATER_DEPTH_M = 1.6
export const RELIEF_SHALLOW_DEPTH_M = 0.45
export const RELIEF_BEACH_M = 0.25
export const RELIEF_COAST_M = 0.55
export const RELIEF_PLAIN_RISE_M = 1.9
export const RELIEF_PLAIN_SCALE = 16
export const RELIEF_TERRACE_M = 1.6
export const RELIEF_MAX_TERRACE = 4
export const RELIEF_CLIFF_LIP_M = 0.55
export const RELIEF_ROUGH_M = 0.5
export const RELIEF_HILL_BASE_M = 1.5
/** Peak height grows this much per cell of half-thickness: a 5-cell mass peaks near 7 m, a 9-cell one at the cap. */
export const RELIEF_HILL_SLOPE_M = 2.6
export const RELIEF_HILL_CAP_M = 12
/** A rock band no thicker than this, and not between two levels, is a free-standing rock wall. */
export const RELIEF_WALL_MAX_INSET = 2
export const RELIEF_WALL_M = 2.0
export const RELIEF_NOISE_M = 0.45
export const RELIEF_ROLL_M = 0.6
/** Broad rolling hills on passable ground: long-wavelength, gentle enough to drive over. */
export const RELIEF_HILL_ROLL_M = 1.6
export const RELIEF_HILL_ROLL_CELLS = 37
/** Water sits this far below its lowest bank, so the waterline crosses the bank slope instead of lying on corner lines. */
export const RELIEF_BANK_M = 0.12
/** Steepest rise per cell between two passable cells: about 31°, a slope a tank still reads as driveable. */
export const RELIEF_MAX_GRADE_M = 0.6
export const RELIEF_SMOOTH_PASSES = 8
/** §8 has 13 surfaces; the relief histogram is sized to it without importing chunks. */
const SURFACE_COUNT_RELIEF = 13

/** Deterministic 2D hash in [0, 1). Negative coordinates are fine: the apron uses them. */
export function reliefHash(x: number, y: number, salt: number): number {
	let u = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ salt
	u = Math.imul(u ^ (u >>> 15), 0x85ebca6b)
	u = Math.imul(u ^ (u >>> 13), 0xc2b2ae35)
	return ((u ^ (u >>> 16)) >>> 0) / 4294967296
}

/** Smooth value noise in [0, 1) at the given wavelength in cells. */
export function reliefNoise(x: number, y: number, wavelength: number, salt: number): number {
	const fx = x / wavelength
	const fy = y / wavelength
	const x0 = Math.floor(fx)
	const y0 = Math.floor(fy)
	const tx = fx - x0
	const ty = fy - y0
	const sx = tx * tx * (3 - 2 * tx)
	const sy = ty * ty * (3 - 2 * ty)
	const a = reliefHash(x0, y0, salt)
	const b = reliefHash(x0 + 1, y0, salt)
	const c = reliefHash(x0, y0 + 1, salt)
	const d = reliefHash(x0 + 1, y0 + 1, salt)
	return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy
}

const EMPTY_U8 = new Uint8Array(0)
const EMPTY_F32 = new Float32Array(0)

/**
 * The decoded cell grid, copied out of the snapshot.
 *
 * The copy is not optional. `snapshot.terrainStatic` aliases the bridge's double buffer
 * — core/snapshot says so in as many words — and the bridge overwrites that buffer two
 * ticks later. Terrain outlives the buffer, so it owns its own planes.
 */
export class TerrainGrid {
    bridges: readonly BridgeLandmark[] = []
    private bridgeCells = new Uint8Array(0)
	w = 0
	h = 0
	ready = false

	type: Uint8Array = EMPTY_U8
	height: Uint8Array = EMPTY_U8
	ramp: Uint8Array = EMPTY_U8
	passability: Uint8Array = EMPTY_U8
	resource: Uint8Array = EMPTY_U8
	surface: Uint8Array = EMPTY_U8

	/** Water-surface level in metres per cell; NaN where the cell holds no water. */
	waterLevel: Float32Array = EMPTY_F32
	/** Presentation-only distance from water-cell centres to dry land, in metres. */
	waterShoreDistance: Float32Array = EMPTY_F32
	/** Continuous presentation height in metres. Empty when the snapshot already has a height plane. */
	protected heightM: Float32Array = EMPTY_F32
	/** Blurred water occupancy, used to round square cell shores into a smooth contour. */
	protected waterOcc: Float32Array = EMPTY_F32
	/** Blurred rock occupancy, used to round square rock footprints. */
	protected rockOcc: Float32Array = EMPTY_F32
	/**
	 * Shared corner heights, (w+1)*(h+1), built once per map for continuous relief. The mesh
	 * emits exactly these values and heightAt() interpolates exactly the mesh's triangles over
	 * them, so a probe and the drawn surface can never disagree. Empty for authored maps,
	 * whose cliffs give each cell its own corners.
	 */
	protected cornerY: Float32Array = EMPTY_F32
	/** Number of authoritative water/shallow cells in the loaded map. */
	waterCellCount = 0

	minHeightM = 0
	maxHeightM = 0
	/**
	 * True when this grid reconstructed elevation because OpenRA's height plane was
	 * uniformly zero (RA tilesets). Presentation only — passability is untouched.
	 */
	protected presentationRelief = false
	/** True when elevation was reconstructed from a flat RA height plane. Read by the apron. */
	get hasPresentationRelief(): boolean {
		return this.presentationRelief
	}
	/** Summary of the last reconstruction, for the terrain log line. Null when the map authored its own heights. */
	reliefInfo: { terraces: number; rockComponents: number; cliffBands: number; walls: number; hills: number; maxRockM: number } | null = null

	/**
	 * World cell of grid index (0,0) — the §4.2 playable bounds. World-space queries
	 * subtract it; the mesh builder adds it. See build().
	 */
	originX = 0
	originY = 0

	/**
	 * @param originX Map cell of grid column 0 — the world section's `boundsLeft` (§12.5).
	 * @param originY Map cell of grid row 0 — the world section's `boundsTop`.
	 *
	 * The §4.3 planes start at the playable bounds, not at map cell (0,0), while everything
	 * else in the frame — actor positions, projectiles, crater events — is ABSOLUTE. A grid
	 * that draws plane index (0,0) at render origin therefore displaces the whole
	 * battlefield by (boundsLeft, boundsTop) metres from the units standing on it. The
	 * bridge deliberately does not pre-shift; terrain offsets.
	 */
	build(view: TerrainStaticView, originX: number, originY: number): void {
		const n = view.w * view.h
		this.w = view.w
		this.h = view.h
		this.originX = originX
		this.originY = originY
		this.type = view.type.slice(0, n)
		this.height = view.height.slice(0, n)
		this.ramp = view.ramp.slice(0, n)
		this.passability = view.passability.slice(0, n)
		this.resource = view.resource.slice(0, n)
		this.surface = view.surface.slice(0, n)
		this.waterLevel = new Float32Array(n)
		this.waterShoreDistance = new Float32Array(n)
		this.heightM = EMPTY_F32
		this.waterOcc = EMPTY_F32
		this.rockOcc = EMPTY_F32
		this.cornerY = EMPTY_F32
		this.waterCellCount = 0
		this.presentationRelief = false
		this.reliefInfo = null
		this.reconstructPresentationRelief()
        this.applyBridgeGround()

		let lo = Infinity
		let hi = -Infinity
		for (let i = 0; i < n; i++) {
			const v = this.heightMetresAt(i)
			if (v < lo) lo = v
			if (v > hi) hi = v
		}
		this.minHeightM = n === 0 ? 0 : lo
		this.maxHeightM = n === 0 ? 0 : hi

		this.computeWaterLevels()
		this.computeShoreDistances()
		this.buildCornerGrid()
        this.flattenBridgeCorners()
		for (let i = 0; i < n; i++)
			if (Number.isFinite(this.waterLevel[i])) this.waterCellCount++
		this.ready = n > 0
	}

	/**
	 * Shared corner heights for continuous relief: each corner is the mean of the four cells
	 * around it, clamped at the border exactly as cornerHeightM() clamps. With connected()
	 * true everywhere this is what cornerHeightM() would compute per cell, stored once so the
	 * mesh and the probes read one array.
	 */
	protected buildCornerGrid(): void {
		if (!this.presentationRelief || this.w === 0 || this.h === 0) {
			this.cornerY = EMPTY_F32
			return
		}
		const w = this.w
		const h = this.h
		const corners = new Float32Array((w + 1) * (h + 1))
		for (let gy = 0; gy <= h; gy++) {
			const y0 = this.clampY(gy - 1)
			const y1 = this.clampY(gy)
			for (let gx = 0; gx <= w; gx++) {
				const x0 = this.clampX(gx - 1)
				const x1 = this.clampX(gx)
				corners[gy * (w + 1) + gx] = 0.25 * (
					this.heightMetresAt(this.index(x0, y0)) + this.heightMetresAt(this.index(x1, y0)) +
					this.heightMetresAt(this.index(x0, y1)) + this.heightMetresAt(this.index(x1, y1)))
			}
		}
		this.cornerY = corners
	}

	dispose(): void {
		this.type = EMPTY_U8
		this.height = EMPTY_U8
		this.ramp = EMPTY_U8
		this.passability = EMPTY_U8
		this.resource = EMPTY_U8
		this.surface = EMPTY_U8
		this.waterLevel = EMPTY_F32
		this.waterShoreDistance = EMPTY_F32
		this.heightM = EMPTY_F32
		this.waterOcc = EMPTY_F32
		this.rockOcc = EMPTY_F32
		this.cornerY = EMPTY_F32
		this.waterCellCount = 0
		this.presentationRelief = false
		this.w = 0
		this.h = 0
		this.ready = false
	}

	// -----------------------------------------------------------------------
	// Cell access
	// -----------------------------------------------------------------------

	/** Row-major, matching §4.3's "structure-of-arrays over w*h cells, row-major". */
	index(cx: number, cy: number): number {
		return cy * this.w + cx
	}

	/** Clamps to the border cell, so a query one metre off the map still answers. */
	clampX(cx: number): number {
		return cx < 0 ? 0 : cx >= this.w ? this.w - 1 : cx
	}

	clampY(cy: number): number {
		return cy < 0 ? 0 : cy >= this.h ? this.h - 1 : cy
	}

    renderedSurface(cell:number):number {return this.bridgeCells[cell]?Surface.gravel:this.surface[cell]}
    private applyBridgeGround():void {
        this.bridgeCells=new Uint8Array(this.w*this.h)
        if(!this.bridges.length)return
        if(this.heightM.length!==this.height.length)this.heightM=Float32Array.from(this.height,v=>v*HEIGHT_STEP_M)
        for(let cy=0;cy<this.h;cy++)for(let cx=0;cx<this.w;cx++){
            const x=cx+this.originX+.5,z=cy+this.originY+.5,i=this.index(cx,cy)
            for(const b of this.bridges){
                const dx=Math.abs(x-b.x),dz=Math.abs(z-b.z)
                if(bridgeContains(b,x,z)){this.bridgeCells[i]=1;this.heightM[i]=HERO_BRIDGE.bedM;continue}
                // Normal approach cells flatten to the simulator deck before blending into relief.
                if(dx>=4&&dx<9&&dz<6){const t=Math.min(1,Math.max((dx-5)/4,(dz-3)/3,0));this.heightM[i]*=t*t*(3-2*t)}
            }
        }
    }
    private flattenBridgeCorners():void {
        if(!this.bridges.length)return
        for(const b of this.bridges){
            const i=this.index(this.clampX(Math.floor(b.x-this.originX)),this.clampY(Math.floor(b.z-this.originY)))
            const old=this.waterLevel[i]
            if(Number.isFinite(old)){
                const seen=new Set<number>([i]),pending=[i]
                while(pending.length){
                    const cell=pending.pop()!;this.waterLevel[cell]=HERO_BRIDGE.waterM
                    const x=cell%this.w,y=Math.floor(cell/this.w)
                    for(const next of [x>0?cell-1:-1,x+1<this.w?cell+1:-1,y>0?cell-this.w:-1,y+1<this.h?cell+this.w:-1]){
                        if(next<0||seen.has(next)||this.waterLevel[next]!==old)continue
                        seen.add(next);pending.push(next)
                    }
                }
            }
        }
        for(let y=0;y<=this.h;y++)for(let x=0;x<=this.w;x++){
            const wx=x+this.originX,wz=y+this.originY
            for(const b of this.bridges){
                const dx=Math.abs(wx-b.x),dz=Math.abs(wz-b.z)
                if(dx<4&&dz<=2.5&&this.cornerY.length)this.cornerY[y*(this.w+1)+x]=HERO_BRIDGE.bedM
                else if(dx>=4&&dx<=5&&dz<=3&&this.cornerY.length)this.cornerY[y*(this.w+1)+x]=0
            }
        }
    }

    heightMetresAt(cell: number): number {
		if (this.heightM.length === this.height.length) return this.heightM[cell]
		return this.height[cell] * HEIGHT_STEP_M
	}

	/** Dense metres, filled once, so a worker can sample without the grid object. */
	heightMetres(): Float32Array {
		if (this.heightM.length !== this.height.length)
			this.heightM = Float32Array.from(this.height, v => v * HEIGHT_STEP_M)
		return this.heightM
	}

	cornerYView(): Float32Array {
		return this.cornerY
	}

	/**
	 * Shared mesh vertex on grid line (gx, gy). Interior points stay on the lattice;
	 * mixed water/rock/land neighbourhoods slide onto a smooth 0.5 occupancy contour
	 * so shores and mountain feet are not 1 m squares.
	 */
	contourAt(gx: number, gy: number, out: Float64Array): void {
		out[0] = gx
		out[1] = gy
        if(this.bridges.some(b=>Math.abs(gx+this.originX-b.x)<=5&&Math.abs(gy+this.originY-b.z)<=3))return
		if (this.waterOcc.length === 0) return
		const slide = (field: Float32Array): boolean => {
			const s00 = this.occSample(field, gx - 1, gy - 1)
			const s10 = this.occSample(field, gx, gy - 1)
			const s01 = this.occSample(field, gx - 1, gy)
			const s11 = this.occSample(field, gx, gy)
			const occ = (s00 + s10 + s01 + s11) * 0.25
			if (occ <= 0.08 || occ >= 0.92) return false
			const gx1 = this.occSample(field, gx + 1, gy)
			const gx0 = this.occSample(field, gx - 2, gy)
			const gy1 = this.occSample(field, gx, gy + 1)
			const gy0 = this.occSample(field, gx, gy - 2)
			const dx = (gx1 - gx0) * 0.5
			const dy = (gy1 - gy0) * 0.5
			const mag = dx * dx + dy * dy
			if (mag < 1e-6) return false
			const t = (0.5 - occ) / mag
			out[0] = gx + Math.max(-0.45, Math.min(0.45, dx * t))
			out[1] = gy + Math.max(-0.45, Math.min(0.45, dy * t))
			return true
		}
		// Presentation relief joins land into one surface, but water occupancy is still a
		// 1 m stencil. Sliding only mixed water/land corners onto the 0.5 contour rounds
		// the coast without moving playable interiors (the occupancy field is blurred and
		// would otherwise drag beach vertices inland). Rock feet stay on the lattice so a
		// tank's foot and the mesh cannot disagree. Cliff rims stay on the lattice so
		// walkability still matches the picture.
		if (this.presentationRelief) {
			if (!this.cornerTouchesCliff(gx, gy) && this.cornerMixesWater(gx, gy)) slide(this.waterOcc)
			return
		}
		if (!slide(this.waterOcc)) slide(this.rockOcc)
	}

	/** True when any of the four cells around grid line (gx, gy) is a reconstructed cliff. */
	private cornerTouchesCliff(gx: number, gy: number): boolean {
		for (let oy = -1; oy <= 0; oy++) {
			for (let ox = -1; ox <= 0; ox++) {
				const i = this.index(this.clampX(gx + ox), this.clampY(gy + oy))
				if (this.ramp[i] === 0) return true
			}
		}
		return false
	}

	/** True when the four cells around grid line (gx, gy) mix water and land. */
	private cornerMixesWater(gx: number, gy: number): boolean {
		let wet = false
		let dry = false
		for (let oy = -1; oy <= 0; oy++) {
			for (let ox = -1; ox <= 0; ox++) {
				const i = this.index(this.clampX(gx + ox), this.clampY(gy + oy))
				if (this.isWaterCell(i)) wet = true
				else dry = true
			}
		}
		return wet && dry
	}

	protected occSample(field: Float32Array, x: number, y: number): number {
		return field[this.index(this.clampX(x), this.clampY(y))]
	}

	isWaterCell(cell: number): boolean {
		const s = this.surface[cell]
        if (this.bridgeCells[cell]) return true
		return s === Surface.water || s === Surface.shallow
	}

	/**
	 * Whether two cells form one continuous surface, i.e. whether the mesh may slope
	 * between them instead of stepping.
	 *
	 * Equal height is continuous by definition. A difference is continuous only when the
	 * sim itself says so by marking one of the two a ramp — that is exactly what the
	 * `ramp` plane means, and deriving connectivity from a height threshold instead would
	 * be terrain inventing its own passability, which §4.3 forbids.
	 */
	connected(a: number, b: number): boolean {
		// Generated relief has no authored vertical cliffs. Keep a single continuous
		// surface across rock/soil boundaries; simulation passability is independent.
		if (this.presentationRelief) return true
		if (this.height[a] === this.height[b]) return true
		// Reconstructed RA cliffs are marked ramp=0. The sim's OR rule would still slope
		// them because neighbouring land is a ramp, so both cells must agree to slope.
		if (this.presentationRelief && (this.ramp[a] === 0 || this.ramp[b] === 0)) return false
		return this.ramp[a] !== 0 || this.ramp[b] !== 0
	}

	// -----------------------------------------------------------------------
	// The ground surface
	// -----------------------------------------------------------------------

	/**
	 * Height of corner (dx, dy) ∈ {0,1}² of cell (cx, cy), in metres.
	 *
	 * The corner is the average of the four cells that touch it, with any cell terrain is
	 * NOT continuous with replaced by the owning cell's own height. That single rule
	 * produces all three behaviours the battlefield needs from one pass: a plateau
	 * interior stays perfectly flat, a ramp slopes because its neighbours are declared
	 * continuous, and a cliff opens a gap because the two cells either side of it each
	 * pull their shared corner to their own level. The gap is where cliff geometry goes.
	 *
	 * Off the map the stencil clamps to the border cell — the same clamp heightAt() uses,
	 * and the reason the two agree at every corner. Substituting the owning cell's height
	 * instead looks equivalent and is not: on the border row it pinches each cell toward
	 * its own level, which opened a quarter-metre step between two cells the ramp plane
	 * had declared continuous, and put a spurious wall along the top and bottom edges of
	 * every map.
	 */
	cornerHeightM(cx: number, cy: number, dx: number, dy: number): number {
		if (this.cornerY.length > 0) return this.cornerY[(cy + dy) * (this.w + 1) + cx + dx]
		const base = this.index(cx, cy)
		const bh = this.heightMetresAt(base)
		let sum = 0
		for (let oy = dy - 1; oy <= dy; oy++) {
			const ny = this.clampY(cy + oy)
			for (let ox = dx - 1; ox <= dx; ox++) {
				const j = this.index(this.clampX(cx + ox), ny)
				sum += this.connected(base, j) ? this.heightMetresAt(j) : bh
			}
		}
		return sum * 0.25
	}

	/**
	 * Ground height in metres (render Y) at a world position.
	 *
	 * `worldX`/`worldY` are the two ground-plane axes: worldX is render X, worldY is
	 * render Z — the sim's southing. The names come from §12.3, which was written in the
	 * sim's XY ground plane; §12.4's swap puts height on render Y, which is the return
	 * value, so the second argument cannot also be Y.
	 *
	 * Bilinear over the cell-CENTRE lattice, with the same continuity clamp
	 * cornerHeightM() uses relative to the cell the query actually stands in. Both halves
	 * matter. Bilinear alone would sink a tank parked on a plateau edge halfway down the
	 * cliff it is standing above, because a cliff neighbour would drag the sample; the
	 * clamp discards exactly those neighbours. And because bilinear evaluated at a cell
	 * corner is the plain average of the four cells around it, this function and the mesh
	 * agree at every corner by construction rather than by coincidence.
	 *
	 * Allocation-free and called per frame per foot — no temporaries, no vectors.
	 */
    heightAt(worldXAbs:number,worldYAbs:number):number {
        for(const bridge of this.bridges){const support=bridgeSupportHeight(bridge,worldXAbs,worldYAbs);if(support!==null)return support}
        return this.groundHeightAt(worldXAbs,worldYAbs)
    }

    groundHeightAt(worldXAbs: number, worldYAbs: number): number {
		if (!this.ready) return 0
		// Absolute world metres in, grid-local out. The §4.3 planes start at the playable
		// bounds while actor positions are absolute (§12.5), so every world-space query
		// must shed the origin before indexing or a unit's foot samples the wrong cell.
		const worldX = worldXAbs - this.originX
		const worldY = worldYAbs - this.originY
		const bx = this.clampX(Math.floor(worldX))
		const by = this.clampY(Math.floor(worldY))
		if (this.cornerY.length > 0) {
			// Exactly the mesh: the chunk builder splits every cell along the (0,0)-(1,1)
			// diagonal into triangles (a,b,c) and (a,c,d), and this samples those same two
			// planes over the same shared corners. A probe under a wheel therefore returns
			// the drawn surface, not an approximation of it.
			const u = Math.min(1, Math.max(0, worldX - bx))
			const v = Math.min(1, Math.max(0, worldY - by))
			const stride = this.w + 1
			const o = by * stride + bx
			const h00 = this.cornerY[o]
			const h10 = this.cornerY[o + 1]
			const h01 = this.cornerY[o + stride]
			const h11 = this.cornerY[o + stride + 1]
			return v >= u
				? h00 * (1 - v) + h01 * (v - u) + h11 * u
				: h00 * (1 - u) + h11 * v + h10 * (u - v)
		}
		const base = this.index(bx, by)

		// Cell centres sit at (cx + 0.5, cy + 0.5), so the lattice is offset by half a cell.
		const fx = worldX - 0.5
		const fy = worldY - 0.5
		const x0 = Math.floor(fx)
		const y0 = Math.floor(fy)
		const tx = fx - x0
		const ty = fy - y0
		const cx0 = this.clampX(x0)
		const cx1 = this.clampX(x0 + 1)
		const cy0 = this.clampY(y0)
		const cy1 = this.clampY(y0 + 1)

		const h00 = this.sampleContinuous(base, cx0, cy0)
		const h10 = this.sampleContinuous(base, cx1, cy0)
		const h01 = this.sampleContinuous(base, cx0, cy1)
		const h11 = this.sampleContinuous(base, cx1, cy1)
		const a = h00 + (h10 - h00) * tx
		const b = h01 + (h11 - h01) * tx
		return a + (b - a) * ty
	}

	private sampleContinuous(base: number, cx: number, cy: number): number {
		const j = this.index(cx, cy)
		return this.connected(base, j) ? this.heightMetresAt(j) : this.heightMetresAt(base)
	}

	/**
	 * Surface type (§8) at a world position. Nearest cell, never interpolated — §8 is an
	 * enum, and a blend of `rock` and `water` is not a surface. Same axis convention as
	 * heightAt().
	 */
	surfaceAt(worldXAbs: number, worldYAbs: number): number {
		if (!this.ready) return Surface.soil
		// Same origin shift as heightAt — see there.
		const x = this.clampX(Math.floor(worldXAbs - this.originX))
		const y = this.clampY(Math.floor(worldYAbs - this.originY))
		return this.surface[this.index(x, y)]
	}

	/** Authoritative rendered water surface at a world position, or null on dry terrain. */
	waterHeightAt(worldXAbs: number, worldYAbs: number): number | null {
		if (!this.ready) return null
		const x = this.clampX(Math.floor(worldXAbs - this.originX))
		const y = this.clampY(Math.floor(worldYAbs - this.originY))
		const level = this.waterLevel[this.index(x, y)]
		return Number.isFinite(level) ? level : null
	}

	// -----------------------------------------------------------------------
	// Presentation relief for tilesets with no height plane
	// -----------------------------------------------------------------------

	/**
	 * RA is a 2D cell grid: every RA tileset publishes a height plane of zeros and
	 * a ramp plane of zeros. This view is 3D, so a zero plane is mapped like a small real
	 * landscape at the game's own scale — one cell is one metre and a tank is two — rather
	 * than drawn as a billiard table:
	 *
	 *   - water bodies sit in beds a metre and a half below their own shore;
	 *   - land is a gently rising coastal plain with metre-scale undulation;
	 *   - land regions separated by RA "Rock" cliff bands stack as terraces, each
	 *     RELIEF_TERRACE_M above the one nearer the sea, with a rocky rim and a vertical
	 *     face on the lower side — the "levels" the 2D cliff tiles imply;
	 *   - rock masses that do not separate levels are hills: their height grows with
	 *     their inset from their own edge, so a thin outcrop is a low ridge and a broad
	 *     mass is a mountain, capped at RELIEF_HILL_CAP_M so nothing rises higher than a
	 *     tenth of a typical map or above the camera's lowest legal height.
	 *
	 * Everything here is presentation. Passability, orders and the snapshot are untouched,
	 * and `heightAt()` feeds the same numbers back to the units standing on them.
	 */
	private reconstructPresentationRelief(): void {
		const n = this.w * this.h
		if (n === 0) return
		let authored = 0
		for (let i = 0; i < n; i++) if (this.height[i] > authored) authored = this.height[i]
		if (authored > 0) return

		this.presentationRelief = true
		const w = this.w
		const h = this.h
		// RA Clear/Tree currently fall through the host mapper to soil, which turns
		// temperate ground into dirt squares. Type indices 2/9/10 are Clear/Tree/Wall
		// on every outdoor RA tileset in this repo; the host also remaps them.
		for (let i = 0; i < n; i++) {
			if (this.surface[i] !== Surface.soil) continue
			const t = this.type[i]
			if (t === 2 || t === 9) this.surface[i] = Surface.grass
			else if (t === 10) this.surface[i] = Surface.concrete
		}

		const water = (i: number): boolean => {
			const s = this.surface[i]
			return s === Surface.water || s === Surface.shallow
		}
		const rock = (i: number): boolean => this.surface[i] === Surface.rock
		const land = (i: number): boolean => !water(i) && !rock(i)
		const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h

		// --- land regions: 4-connected components with water and rock as separators ---
		const regionOf = new Int32Array(n).fill(-1)
		const qx = new Int32Array(n)
		const qy = new Int32Array(n)
		let regionCount = 0
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			const start = this.index(x, y)
			if (regionOf[start] >= 0 || !land(start)) continue
			const id = regionCount++
			let head = 0
			let tail = 0
			regionOf[start] = id
			qx[tail] = x
			qy[tail] = y
			tail++
			while (head < tail) {
				const cx = qx[head]
				const cy = qy[head++]
				for (let d = 0; d < 4; d++) {
					const nx = cx + (d === 0 ? 1 : d === 1 ? -1 : 0)
					const ny = cy + (d === 2 ? 1 : d === 3 ? -1 : 0)
					if (!inside(nx, ny)) continue
					const j = this.index(nx, ny)
					if (regionOf[j] >= 0 || !land(j)) continue
					regionOf[j] = id
					qx[tail] = nx
					qy[tail] = ny
					tail++
				}
			}
		}

		// --- rock components, with the land regions each one touches ---
		const rockOf = new Int32Array(n).fill(-1)
		const rockRegions: number[][] = []
		let rockCount = 0
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			const start = this.index(x, y)
			if (rockOf[start] >= 0 || !rock(start)) continue
			const id = rockCount++
			const touched: number[] = []
			rockRegions.push(touched)
			let head = 0
			let tail = 0
			rockOf[start] = id
			qx[tail] = x
			qy[tail] = y
			tail++
			while (head < tail) {
				const cx = qx[head]
				const cy = qy[head++]
				for (let d = 0; d < 4; d++) {
					const nx = cx + (d === 0 ? 1 : d === 1 ? -1 : 0)
					const ny = cy + (d === 2 ? 1 : d === 3 ? -1 : 0)
					if (!inside(nx, ny)) continue
					const j = this.index(nx, ny)
					if (rock(j)) {
						if (rockOf[j] >= 0) continue
						rockOf[j] = id
						qx[tail] = nx
						qy[tail] = ny
						tail++
					} else if (land(j) && touched.indexOf(regionOf[j]) < 0) touched.push(regionOf[j])
				}
			}
		}

		// --- terraces: regions touching water are level 1, and each rock band crossed
		// away from the water adds a level. A map with no water starts at its largest region.
		const touchesWater = new Uint8Array(Math.max(regionCount, 1))
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			const i = this.index(x, y)
			if (!land(i)) continue
			for (let d = 0; d < 4; d++) {
				const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0)
				const ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0)
				if (inside(nx, ny) && water(this.index(nx, ny))) touchesWater[regionOf[i]] = 1
			}
		}
		const neighbors: number[][] = []
		for (let r = 0; r < regionCount; r++) neighbors.push([])
		for (let c = 0; c < rockCount; c++) {
			const rs = rockRegions[c]
			for (let a = 0; a < rs.length; a++) for (let b = a + 1; b < rs.length; b++) {
				if (neighbors[rs[a]].indexOf(rs[b]) < 0) neighbors[rs[a]].push(rs[b])
				if (neighbors[rs[b]].indexOf(rs[a]) < 0) neighbors[rs[b]].push(rs[a])
			}
		}
		const terrace = new Int32Array(Math.max(regionCount, 1))
		const rq = new Int32Array(Math.max(regionCount, 1))
		let rh = 0
		let rt = 0
		for (let r = 0; r < regionCount; r++) if (touchesWater[r] !== 0) {
			terrace[r] = 1
			rq[rt++] = r
		}
		if (rt === 0 && regionCount > 0) {
			const sizes = new Int32Array(regionCount)
			for (let i = 0; i < n; i++) if (regionOf[i] >= 0) sizes[regionOf[i]]++
			let best = 0
			for (let r = 1; r < regionCount; r++) if (sizes[r] > sizes[best]) best = r
			terrace[best] = 1
			rq[rt++] = best
		}
		while (rh < rt) {
			const r = rq[rh++]
			const adj = neighbors[r]
			for (let k = 0; k < adj.length; k++) {
				if (terrace[adj[k]] !== 0) continue
				terrace[adj[k]] = Math.min(terrace[r] + 1, RELIEF_MAX_TERRACE)
				rq[rt++] = adj[k]
			}
		}
		for (let r = 0; r < regionCount; r++) if (terrace[r] === 0) terrace[r] = 1

		const rockLo = new Int32Array(Math.max(rockCount, 1))
		const rockHi = new Int32Array(Math.max(rockCount, 1))
		for (let c = 0; c < rockCount; c++) {
			let lo = 99
			let hi = 0
			const rs = rockRegions[c]
			for (let k = 0; k < rs.length; k++) {
				const t = terrace[rs[k]]
				if (t < lo) lo = t
				if (t > hi) hi = t
			}
			if (hi === 0) {
				lo = 1
				hi = 1
			}
			rockLo[c] = lo
			rockHi[c] = hi
		}

		// --- distance fields: cells to water (plain rise) and rock cells to their own edge
		// (hill profile). Plain BFS, four-connected, once at map load.
		const waterDist = new Float32Array(n).fill(1e6)
		let head = 0
		let tail = 0
		for (let i = 0; i < n; i++) if (water(i)) {
			waterDist[i] = 0
			qx[tail] = i % w
			qy[tail] = (i / w) | 0
			tail++
		}
		while (head < tail) {
			const cx = qx[head]
			const cy = qy[head++]
			const i = this.index(cx, cy)
			for (let d = 0; d < 4; d++) {
				const nx = cx + (d === 0 ? 1 : d === 1 ? -1 : 0)
				const ny = cy + (d === 2 ? 1 : d === 3 ? -1 : 0)
				if (!inside(nx, ny)) continue
				const j = this.index(nx, ny)
				if (waterDist[j] <= waterDist[i] + 1) continue
				waterDist[j] = waterDist[i] + 1
				qx[tail] = nx
				qy[tail] = ny
				tail++
			}
		}
		const inset = new Float32Array(n)
		head = 0
		tail = 0
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			const i = this.index(x, y)
			if (!rock(i)) continue
			let edge = x === 0 || y === 0 || x === w - 1 || y === h - 1
			for (let d = 0; d < 4 && !edge; d++) {
				const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0)
				const ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0)
				if (!rock(this.index(nx, ny))) edge = true
			}
			inset[i] = edge ? 1 : 1e6
			if (edge) {
				qx[tail] = x
				qy[tail] = y
				tail++
			}
		}
		while (head < tail) {
			const cx = qx[head]
			const cy = qy[head++]
			const i = this.index(cx, cy)
			for (let d = 0; d < 4; d++) {
				const nx = cx + (d === 0 ? 1 : d === 1 ? -1 : 0)
				const ny = cy + (d === 2 ? 1 : d === 3 ? -1 : 0)
				if (!inside(nx, ny)) continue
				const j = this.index(nx, ny)
				if (!rock(j) || inset[j] <= inset[i] + 1) continue
				inset[j] = inset[i] + 1
				qx[tail] = nx
				qy[tail] = ny
				tail++
			}
		}

		const rockThickness = new Float32Array(Math.max(rockCount, 1))
		for (let i = 0; i < n; i++) if (rock(i) && inset[i] > rockThickness[rockOf[i]]) rockThickness[rockOf[i]] = inset[i]
		// Sand is a beach only where it fringes water on a map whose ground is not sand:
		// on a desert tileset every clear cell is sand and it is simply the plain.
		const landHist = new Int32Array(SURFACE_COUNT_RELIEF)
		for (let i = 0; i < n; i++) if (land(i) && this.surface[i] < SURFACE_COUNT_RELIEF) landHist[this.surface[i]]++
		let dominant = 0
		for (let k = 1; k < SURFACE_COUNT_RELIEF; k++) if (landHist[k] > landHist[dominant]) dominant = k
		const beach = (i: number): boolean => this.surface[i] === Surface.sand && dominant !== Surface.sand && waterDist[i] <= 4
		let maxTerrace = 1
		for (let r = 0; r < regionCount; r++) if (terrace[r] > maxTerrace) maxTerrace = terrace[r]
		let cliffBands = 0
		let walls = 0
		let hills = 0
		for (let c = 0; c < rockCount; c++) {
			if (rockHi[c] > rockLo[c]) cliffBands++
			else if (rockThickness[c] <= RELIEF_WALL_MAX_INSET) walls++
			else hills++
		}

		// --- heights ---
		const salt = ((w * 73856093) ^ (h * 19349663) ^ (this.originX * 83492791) ^ (this.originY * 2971215073)) | 0
		const undulation = (x: number, y: number): number =>
			(reliefNoise(x, y, RELIEF_HILL_ROLL_CELLS, salt ^ 0x2545f491) - 0.5) * 2 * RELIEF_HILL_ROLL_M +
			(reliefNoise(x, y, 23, salt ^ 0x68e31da4) - 0.5) * 2 * RELIEF_ROLL_M +
			(reliefNoise(x, y, 11, salt) - 0.5) * 2 * RELIEF_NOISE_M +
			(reliefNoise(x, y, 5, salt ^ 0x5bd1e995) - 0.5) * 0.8 * RELIEF_NOISE_M
		const plainM = (i: number): number => {
			const x = i % w
			const y = (i / w) | 0
			return RELIEF_COAST_M + RELIEF_PLAIN_RISE_M * (1 - Math.exp(-waterDist[i] / RELIEF_PLAIN_SCALE)) + undulation(x, y)
		}
		const terraceM = (t: number): number => Math.max(0, t - 1) * RELIEF_TERRACE_M

		const metres = new Float32Array(n)
		this.ramp.fill(1)
		for (let i = 0; i < n; i++) {
			if (water(i)) continue
			const x = i % w
			const y = (i / w) | 0
			if (rock(i)) {
				const c = rockOf[i]
				const base = plainM(i) + terraceM(rockHi[c])
				if (rockHi[c] > rockLo[c]) {
					// A cliff band between levels: a rocky rim over the upper terrace, with a
					// vertical face wherever it meets the lower one.
					metres[i] = base + RELIEF_CLIFF_LIP_M + Math.min(1.2, (inset[i] - 1) * 0.45)
					for (let d = 0; d < 4; d++) {
						const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0)
						const ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0)
						if (!inside(nx, ny)) continue
						const j = this.index(nx, ny)
						if (land(j) && terrace[regionOf[j]] < rockHi[c]) this.ramp[i] = 0
					}
				} else if (rockThickness[c] <= RELIEF_WALL_MAX_INSET) {
					// A thin band on one level — the RA cliff line with a pass in it, or a
					// rock wall. Vertical on both sides, a tank's length tall.
					metres[i] = base + RELIEF_WALL_M + (inset[i] - 1) * 0.35 + (reliefNoise(x, y, 4, salt ^ 0x1b873593) - 0.5) * 0.3
					this.ramp[i] = 0
				} else {
					// A hill or mountain. The peak follows the mass's half-thickness — the widest
					// masses on a map are its mountains, thin ones its knolls — and the dome
					// climbs from a foot at just under half the peak, so the outline the map
					// author drew stays the foot of the slope.
					const thickness = Math.max(1, rockThickness[c])
					const peak = Math.min(RELIEF_HILL_CAP_M, RELIEF_HILL_BASE_M + (thickness - 1) * RELIEF_HILL_SLOPE_M)
					const t = inset[i] / thickness
					const dome = 0.12 + 0.88 * Math.sin(t * Math.PI * .5)
					metres[i] = base + peak * dome * (1 + 0.12 * (reliefNoise(x, y, 7, salt ^ 0x1b873593) - 0.5) * 2)
				}
				continue
			}
			const t = regionOf[i] >= 0 ? terrace[regionOf[i]] : 1
			let m = plainM(i) + terraceM(t)
			if (beach(i)) m = RELIEF_BEACH_M + terraceM(t) + (m - RELIEF_COAST_M - terraceM(t)) * 0.25
			else if (this.surface[i] === Surface.gravel) m += RELIEF_ROUGH_M
			metres[i] = m
		}

		// Sea cliffs: a rock cell standing well above the water beside it drops vertically
		// into it rather than sloping through a two-metre bank in a single cell.
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			const i = this.index(x, y)
			if (!rock(i) || this.ramp[i] === 0) continue
			for (let d = 0; d < 4; d++) {
				const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0)
				const ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0)
				if (inside(nx, ny) && water(this.index(nx, ny)) && metres[i] > RELIEF_COAST_M + 1.2) this.ramp[i] = 0
			}
		}

		// Smooth the continuous surface. Faces (ramp 0) and water beds stay out so the
		// escarpments keep their edge and the beds keep their depth.
		const previous = new Float32Array(n)
		for (let pass = 0; pass < RELIEF_SMOOTH_PASSES; pass++) {
			previous.set(metres)
			for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
				const i = this.index(x, y)
				if (water(i)) continue
				let sum = previous[i] * 4
				let count = 4
				for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
					if (ox === 0 && oy === 0) continue
					const nx = x + ox
					const ny = y + oy
					if (!inside(nx, ny)) continue
					const j = this.index(nx, ny)
					if (water(j)) continue
					const wgt = ox !== 0 && oy !== 0 ? 0.7 : 1
					sum += previous[j] * wgt
					count += wgt
				}
				metres[i] = sum / count
			}
		}

		// Traversable means traversable-looking. Smoothing spreads a mountain's foot onto the
		// passable cells around it, and a passable cell that climbs a metre and a half in one
		// metre is a wall a unit drives up. Lower passable cells until no passable neighbour
		// is more than RELIEF_MAX_GRADE_M below them; rock (impassable) keeps its flanks and
		// the climb happens inside the rock footprint. Lowering only, so nothing can rise
		// above the height a unit already stood at, and it converges in a few sweeps.
		const passableCell = (i: number): boolean => !water(i) && !rock(i)
		for (let sweep = 0; sweep < 24; sweep++) {
			let changed = false
			for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
				const i = this.index(x, y)
				if (!passableCell(i)) continue
				let ceiling = Infinity
				if (x > 0 && passableCell(i - 1)) ceiling = Math.min(ceiling, metres[i - 1] + RELIEF_MAX_GRADE_M)
				if (x + 1 < w && passableCell(i + 1)) ceiling = Math.min(ceiling, metres[i + 1] + RELIEF_MAX_GRADE_M)
				if (y > 0 && passableCell(i - w)) ceiling = Math.min(ceiling, metres[i - w] + RELIEF_MAX_GRADE_M)
				if (y + 1 < h && passableCell(i + w)) ceiling = Math.min(ceiling, metres[i + w] + RELIEF_MAX_GRADE_M)
				if (metres[i] > ceiling) {
					metres[i] = ceiling
					changed = true
				}
			}
			if (!changed) break
		}

		// Water beds: each connected body lies a fixed depth below its own lowest shore,
		// so a lake on a terrace is as deep as the sea and neither one floods its banks.
		const bodySeen = new Uint8Array(n)
		const member = new Int32Array(n)
		for (let start = 0; start < n; start++) {
			if (bodySeen[start] !== 0 || !water(start)) continue
			let bh = 0
			let bt = 0
			let size = 0
			let shore = Infinity
			member[bt++] = start
			bodySeen[start] = 1
			while (bh < bt) {
				const c = member[bh++]
				size++
				const cx = c % w
				const cy = (c / w) | 0
				for (let d = 0; d < 4; d++) {
					const nx = cx + (d === 0 ? 1 : d === 1 ? -1 : 0)
					const ny = cy + (d === 2 ? 1 : d === 3 ? -1 : 0)
					if (!inside(nx, ny)) continue
					const j = this.index(nx, ny)
					if (water(j)) {
						if (bodySeen[j] === 0) {
							bodySeen[j] = 1
							member[bt++] = j
						}
					} else if (metres[j] < shore) shore = metres[j]
				}
			}
			const level = Number.isFinite(shore) ? shore : RELIEF_COAST_M
			for (let k = 0; k < size; k++) {
				const c = member[k]
				metres[c] = level - (this.surface[c] === Surface.shallow ? RELIEF_SHALLOW_DEPTH_M : RELIEF_WATER_DEPTH_M)
			}
		}

		let maxHill = 0
		for (let i = 0; i < n; i++) if (rock(i) && metres[i] > maxHill) maxHill = metres[i]
		this.reliefInfo = { terraces: maxTerrace, rockComponents: rockCount, cliffBands, walls, hills, maxRockM: maxHill }

		this.heightM = metres
		this.waterOcc = new Float32Array(n)
		this.rockOcc = new Float32Array(n)
		for (let i = 0; i < n; i++) {
			const steps = Math.round(metres[i] / HEIGHT_STEP_M)
			this.height[i] = steps < 0 ? 0 : steps > 255 ? 255 : steps
			this.waterOcc[i] = water(i) ? 1 : 0
			this.rockOcc[i] = rock(i) ? 1 : 0
		}
		const occPrev = new Float32Array(n)
		for (let pass = 0; pass < 5; pass++) {
			for (const field of [this.waterOcc, this.rockOcc]) {
				occPrev.set(field)
				for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
					const i = this.index(x, y)
					let sum = occPrev[i] * 2
					let count = 2
					if (x > 0) { sum += occPrev[i - 1]; count++ }
					if (x + 1 < w) { sum += occPrev[i + 1]; count++ }
					if (y > 0) { sum += occPrev[i - w]; count++ }
					if (y + 1 < h) { sum += occPrev[i + w]; count++ }
					field[i] = sum / count
				}
			}
		}
	}

	// -----------------------------------------------------------------------
	// Water
	// -----------------------------------------------------------------------

	/**
	 * One level per connected water body, found by flood fill.
	 *
	 * Water fills to the lowest lip of its basin, so the level is the minimum height of
	 * the land cells bordering the body — not the height of the water cells themselves,
	 * which is the bed. Doing it per body rather than per cell is what keeps a lake's
	 * surface a single plane; a per-cell rule makes the surface follow the bed and reads
	 * as a wet floor rather than as water. Runs once at map load, so the BFS is free.
	 *
	 * A body with no land border at all — a map that is water to its edge — has no lip to
	 * fill to, so it takes one step above its deepest bed instead of flooding the world.
	 */
	protected computeWaterLevels(): void {
		const n = this.w * this.h
		const level = this.waterLevel
		level.fill(Number.NaN)
		if (n === 0) return

		const queue = new Int32Array(n)
		const member = new Int32Array(n)
		const seen = new Uint8Array(n)

		for (let start = 0; start < n; start++) {
			if (seen[start] !== 0 || !this.isWaterCell(start)) continue
			let head = 0
			let tail = 0
			let size = 0
			let minShore = Infinity
			let bedMin = Infinity
			let bedMax = -Infinity
			queue[tail++] = start
			seen[start] = 1

			while (head < tail) {
				const c = queue[head++]
				member[size++] = c
				const bed = this.heightMetresAt(c)
				if (bed < bedMin) bedMin = bed
				if (bed > bedMax) bedMax = bed
				const cx = c % this.w
				const cy = (c / this.w) | 0
				for (let k = 0; k < 4; k++) {
					const nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0)
					const ny = cy + (k === 2 ? 1 : k === 3 ? -1 : 0)
					// The map edge is an open boundary, not a shore: it constrains nothing.
					if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue
					const j = this.index(nx, ny)
					if (this.isWaterCell(j)) {
						if (seen[j] === 0) {
							seen[j] = 1
							queue[tail++] = j
						}
					} else {
						// A rock face is a wall, not a basin lip. Filling to the cliff top
						// would put the water surface at the plateau instead of below it.
						if (this.surface[j] === Surface.rock) continue
						const shore = this.heightMetresAt(j)
						if (shore < minShore) minShore = shore
					}
				}
			}

			let lv = Number.isFinite(minShore) ? minShore : bedMax + HEIGHT_STEP_M
			// Continuous relief: the waterline crosses the bank's slope rather than lying on
			// the bank's corner line, which is what turns a cell-stepped shore into a curve.
			if (this.presentationRelief && Number.isFinite(minShore)) lv -= RELIEF_BANK_M
			if (lv < bedMin + MIN_WATER_DEPTH_M) lv = bedMin + MIN_WATER_DEPTH_M
			for (let i = 0; i < size; i++) level[member[i]] = lv
		}
	}

	/** Foam needs proximity to land, even beside a vertical, one-metre-deep bank. */
	protected computeShoreDistances(): void {
		const distances = this.waterShoreDistance
		distances.fill(10000)
		const queue = new Int32Array(this.w * this.h)
		let head = 0, tail = 0
		for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
			const i = this.index(x, y)
			if (!this.isWaterCell(i)) continue
			if ((x > 0 && !this.isWaterCell(i - 1)) || (x + 1 < this.w && !this.isWaterCell(i + 1)) ||
				(y > 0 && !this.isWaterCell(i - this.w)) || (y + 1 < this.h && !this.isWaterCell(i + this.w))) {
				distances[i] = .5
				queue[tail++] = i
			}
		}
		while (head < tail) {
			const i = queue[head++], x = i % this.w, y = (i / this.w) | 0
			for (let direction = 0; direction < 4; direction++) {
				const nx = x + (direction === 0 ? 1 : direction === 1 ? -1 : 0)
				const ny = y + (direction === 2 ? 1 : direction === 3 ? -1 : 0)
				if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue
				const j = this.index(nx, ny)
				if (!this.isWaterCell(j) || distances[j] <= distances[i] + 1) continue
				distances[j] = distances[i] + 1
				queue[tail++] = j
			}
		}
	}

	waterShoreDistanceAtCornerM(cx: number, cy: number, dx: number, dy: number): number {
		let sum = 0, count = 0
		for (let oy = dy - 1; oy <= dy; oy++) for (let ox = dx - 1; ox <= dx; ox++) {
			const x = cx + ox, y = cy + oy
			if (x < 0 || y < 0 || x >= this.w || y >= this.h) continue
			const i = this.index(x, y)
			if (!this.isWaterCell(i)) return 0
			sum += this.waterShoreDistance[i]
			count++
		}
		return count > 0 ? sum / count : 10000
	}

	/**
	 * Water depth in metres at corner (dx, dy) of cell (cx, cy), averaged across the water
	 * cells that touch the corner so the absorption tint runs smoothly into the shore
	 * instead of banding at every cell edge. Zero where the bed breaches the surface,
	 * which is how an island inside a lake stays dry.
	 */
	waterDepthAtCornerM(cx: number, cy: number, dx: number, dy: number): number {
		const cell = this.index(cx, cy)
		const lv = this.waterLevel[cell]
		if (!Number.isFinite(lv)) return 0
		let sum = 0
		let count = 0
		for (let oy = dy - 1; oy <= dy; oy++) {
			const ny = cy + oy
			for (let ox = dx - 1; ox <= dx; ox++) {
				const nx = cx + ox
				if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue
				const j = this.index(nx, ny)
				if (!this.isWaterCell(j) || this.waterLevel[j] !== lv) continue
				sum += this.heightMetresAt(j)
				count++
			}
		}
		const bed = count > 0 ? sum / count : this.heightMetresAt(cell)
		const d = lv - bed
		return d > 0 ? d : 0
	}
}
