// STEELSEED — geo/greeble
// Surface detail: nothing perfectly straight, clean or repeated.
//
// A generated hull reads as generated for exactly two reasons: its surfaces are large,
// flat and unbroken, and its edges are mathematically exact. These passes break both.
// Each pass finds the planar regions of whatever mesh it is handed and adds geometry on
// top of them, which is what makes them compose by ordering alone — panelLines lays
// plates down, weldSeams then finds the creases those plates made, rivets then sees the
// plate tops as facets in their own right and borders them. No pass shares state with
// another; the mesh is the only channel between them.
//
// ── Additive, and what that means for a recess ──────────────────────────────────────
// Every pass here is strictly additive: it appends vertices and triangles and never
// rewrites an index, so the host mesh survives byte-for-byte and two LODs greebled from
// one stream stay in step. The consequence is absolute and easy to get wrong: **this
// file cannot dig.** The host skin is never opened, so anything emitted below the host
// plane is sealed inside the solid and renders as nothing at all.
// So every recess is built the only way an additive pass can build one — the floor sits
// ON the host surface and the surround is raised around it. `depth` is therefore the
// height of the rim above the hull, not a distance below it, and the relief a viewer
// reads is identical either way. A hatch floor at −depth, a vent louvre hanging at
// −depth·0.55, a hex tile sunk under an uncut skin: each of those is invisible geometry
// that still costs its triangles, which is strictly worse than not emitting it.
//
// Determinism (hard rule 5). Every pass is a pure function of (mesh, rng state, opts).
// A pass takes a *named* fork of the caller's stream and never advances it, so:
//   - reordering two passes cannot change either one's output, and
//   - greebling two LODs of the same part from the same rng places detail identically,
//     which is the only way an LOD swap stays invisible.
// Spatially coherent variation (bead lumps, wear depth) comes from a hash noise seeded
// out of that fork rather than from a draw per sample: a draw per sample is white noise,
// and a weld bead modulated by white noise reads as a jagged crust instead of as weld.
//
// Budget (§7). Every pass takes a triangle budget and stops dead at it. Greebling is the
// cheapest way in this project to blow the frame budget — 400 rivets at 16 triangles is
// 6 400 triangles per unit spent on bumps invisible past 20 m — so the budget defaults
// to a real number and never to Infinity, and every pass reports what it dropped.
//
// ── What this file touches on a Mesh ────────────────────────────────────────────────
// Reads `positions`, `indices`, `materialZone`, `vertexCount`, `triangleCount`; writes
// through `reserve`, `addVertex`, `addTriangle`, and `computeNormals` (wear only, which
// also writes `positions` in place). Nothing else. Every write is funnelled through the
// emit helpers at the foot of this file and every read through buildTopology(), so the
// coupling to ./mesh is two functions wide.
//
// Note that `materialZone` is per *vertex*, so an emitted feature carries its zone on
// the vertices it pushes — there is no per-triangle zone to set afterwards.

import type { Rng } from '../core/rng'
import { clamp, lerp, smoothstep, v3, vec3, type Vec3 } from '../core/math'
import { buildPositionGroups, DEFAULT_WELD_EPS, type Mesh } from './mesh'

// ---------------------------------------------------------------------------
// Constants and scratch
// ---------------------------------------------------------------------------

/**
 * Emitted detail sits this far off its host surface. Greeble is coplanar with the plate
 * it decorates by construction, and coplanar geometry z-fights at RTS camera distances
 * even under reverse-Z; a fifth of a millimetre is below the shading noise floor and
 * above the depth precision floor.
 */
const LIFT = 2e-4
/** Ring buffers are sized for this; every `sides` parameter is clamped into it. */
const MAX_SIDES = 24
/** Edge keys pack two welded ids into one exact double. Meshes stay far below this. */
const EDGE_KEY_BASE = 4194304
const DEG2RAD = Math.PI / 180

/**
 * Shared scratch, mirroring core/math's pool. Generation is synchronous and
 * single-threaded inside a worker, so a module-level pool is safe — but never hold an
 * `sv` slot across a call into an emit helper, and never hold an `ev` slot at all.
 */
const sv = {
	a: vec3(), b: vec3(), c: vec3(), d: vec3(),
	e: vec3(), f: vec3(), g: vec3(),
	o: vec3(), t: vec3(), r: vec3(),
}
/** Emit-local scratch, deliberately disjoint from `sv` so callers keep their values. */
const ev = {
	n: vec3(), e0: vec3(), e1: vec3(), o: vec3(),
	a: vec3(), b: vec3(), c: vec3(), d: vec3(),
}
const ringA = new Float32Array(MAX_SIDES * 3)
const ringB = new Float32Array(MAX_SIDES * 3)
const ringC = new Float32Array(MAX_SIDES * 3)
/** Zone ballot for a crease: at most three corners from each of the two faces on it. */
const zoneVote = new Uint8Array(6)

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GreebleStats {
	/** Triangles the pass added to the mesh. */
	triangles: number
	/**
	 * Features actually emitted — panels, rivets, hatches, vents, bead segments. `wear`
	 * emits no geometry, so it reports the vertices it displaced at a crease instead.
	 */
	features: number
	/** Features the triangle budget refused. Non-zero means the look was truncated. */
	dropped: number
}

/** Options shared by every pass. Defaults are metre-scale, tuned for vehicle hulls. */
export interface GreebleCommon {
	/** Hard ceiling on triangles this pass may add. Never defaults to Infinity. */
	triangleBudget?: number
	/** Material zone stamped on emitted triangles. Omit to inherit the host facet's. */
	zone?: number
	/** World units per UV tile on emitted geometry. */
	uvScale?: number
	/** Facets smaller than this (m²) are left alone — detail there would be noise. */
	minFacetArea?: number
	/** Max angle (degrees) between triangle normals still counted as one flat facet. */
	planarTolerance?: number
}

export interface PanelLineOpts extends GreebleCommon {
	/**
	 * `bsp` — seeded recursive rectangular split; the Foundry's rolled and bolted plate.
	 * `hex` — a hex tiling; the Lattice's ceramic-on-hex-frame.
	 */
	pattern?: 'bsp' | 'hex'
	/** Shortest allowed panel side. A split that would breach this is refused. */
	minPanel?: number
	/**
	 * A rect longer than this always splits, so no facet keeps one giant plate. Tested
	 * per axis: a 4 m × 0.5 m skirt is cut across its length even though its width can
	 * never be cut, because only a cut that would breach `minPanel` is refused.
	 */
	maxPanel?: number
	/**
	 * Split-position spread either side of the midpoint, 0..0.45. Zero gives a uniform
	 * grid, which is the single most recognisable procedural tell there is and the whole
	 * failure this pass exists to avoid — so the default is deliberately wide.
	 */
	splitBias?: number
	/** Chance to split an already-legal rect again, giving mixed panel densities. */
	splitChance?: number
	/** Recursion depth cap. Guards against a pathological facet aspect ratio. */
	maxDepth?: number
	/** Groove width between neighbouring plates. The panel line itself. */
	gap?: number
	/**
	 * Plate height. Positive lifts the plate proud of the hull and the gap between
	 * plates reads as a groove (Foundry). Negative inverts the relief into a pan: the
	 * plate's rim stands |plateHeight| proud, its floor sits on the hull, and the rims
	 * of neighbouring pans read as the raised frame (Lattice hex). The pass is additive
	 * and cannot open the skin, so a pan is raised walls, never a sunk floor.
	 */
	plateHeight?: number
	/** Chamfer width on the plate rim. Zero gives a razor edge, which never occurs. */
	bevel?: number
	/** Per-plate height variation as a fraction of plateHeight. */
	heightJitter?: number
	/** Fraction of panels left bare, so the plating is not a complete tiling. */
	skipChance?: number
	/** `hex` pattern only: hexagon circumradius. */
	hexRadius?: number
}

export interface RivetOpts extends GreebleCommon {
	/** Nominal centre-to-centre spacing along a facet border. */
	spacing?: number
	/** Along-border jitter as a fraction of spacing. */
	jitter?: number
	radius?: number
	/** Per-rivet radius variation, fraction of radius. */
	radiusJitter?: number
	height?: number
	/** Head sides. 6 reads as a bolt, 8+ as a dome rivet, 3–4 only for far LODs. */
	sides?: number
	/** Distance in from the facet border. A rivet sits on the plate, not on its edge. */
	inset?: number
	/** Fraction of stations left empty — a stamped-perfect row reads as a texture. */
	dropChance?: number
	/** Far-LOD form: the head disc only, no wall. Cuts the cost by two thirds. */
	capOnly?: boolean
	/** Cap on rivets per facet border, applied before the triangle budget. */
	maxPerFacet?: number
}

export interface HatchOpts extends GreebleCommon {
	/** Hatches to attempt across the whole mesh. */
	count?: number
	/** Long-side length of the opening. */
	size?: number
	sizeJitter?: number
	/** Long side ÷ short side. */
	aspect?: number
	/**
	 * Recess depth. The floor sits on the host surface and the coaming stands this far
	 * proud of it — an additive pass cannot cut the skin, so the datum for a recess is
	 * the rim, not the hull. The relief a viewer reads is the same either way.
	 */
	depth?: number
	/** Lip height above the recess rim, i.e. `depth + lipHeight` above the hull. */
	lipHeight?: number
	/** Width of the raised lip. */
	lipWidth?: number
	/** Corner fasteners per hatch: 0 or 4. */
	fasteners?: number
	fastenerRadius?: number
	fastenerSides?: number
	/** Placement attempts per hatch before giving up on a facet. */
	tries?: number
}

export interface VentOpts extends GreebleCommon {
	count?: number
	/** Long-side length of the grille opening. */
	size?: number
	sizeJitter?: number
	aspect?: number
	/**
	 * Recess depth — the height of the raised housing around the grille, the slats
	 * hanging inside it. Measured up from the host surface, which is the grille floor,
	 * because this pass adds material and never opens the skin.
	 */
	depth?: number
	/** Louvre count across the short axis. */
	slats?: number
	/** Slat pitch from the surface plane, degrees. */
	slatAngle?: number
	slatThickness?: number
	/** Slat overlap factor. Below 1 the hull interior is visible through the grille. */
	slatOverlap?: number
	/** Frame lip width and height around the opening. */
	frameWidth?: number
	frameHeight?: number
	tries?: number
}

export interface WeldSeamOpts extends GreebleCommon {
	/** Creases sharper than this (degrees) are seam candidates. */
	minAngle?: number
	/** Creases sharper than this are structural corners, not plate joins. */
	maxAngle?: number
	/** Follow convex creases only. A weld in a concave corner is a fillet, not a bead. */
	convexOnly?: boolean
	/** Bead radius. */
	radius?: number
	/** Bead height as a multiple of radius. Below 1 reads as ground back flush. */
	heightScale?: number
	/** Radius modulation, 0..1. A perfectly round bead is a pipe, not a weld. */
	lumpiness?: number
	/** World units per lump along the seam. */
	lumpScale?: number
	/** Lateral wander of the bead centreline, as a fraction of its radius. */
	wobble?: number
	/** Resample spacing along the path. */
	segmentLength?: number
	/** Cross-section arc segments. 3 is enough at gameplay zoom. */
	profileSides?: number
	/** Paths shorter than this are skipped — this is what keeps beads off rivet rims. */
	minPathLength?: number
}

export interface WearOpts {
	/**
	 * Max inward displacement on a fully convex edge. Wear removes material, so the
	 * displacement runs along -normal: a worn edge is a rounded edge, never a swollen one.
	 */
	amount?: number
	/** Displacement applied everywhere, giving flat spans a rolled-plate undulation. */
	baseAmount?: number
	/** World units per noise cell. */
	noiseScale?: number
	/** Creases below this angle (degrees) contribute no wear. */
	minAngle?: number
	/** Creases at or above this angle wear at the full amount. */
	maxAngle?: number
	/** Also round concave creases. Off by default: dirt fills valleys, wear cuts ridges. */
	includeConcave?: boolean
	/**
	 * Leave open-boundary vertices where they are. A kit part joins its neighbour along
	 * an open border, and moving that border opens a hole in the assembled unit.
	 */
	preserveBorder?: boolean
	/** Recompute vertex normals afterwards. Off only if the caller batches its own pass. */
	recomputeNormals?: boolean
	/** Weld tolerance override; must match the mesh's own vertex duplication scale. */
	weldEpsilon?: number
	/** Accepted for symmetry with the other passes. Wear adds no triangles, ever. */
	triangleBudget?: number
}

/** A whole greeble recipe. `null` disables a pass. */
export interface GreeblePlan {
	panels?: PanelLineOpts | null
	hatches?: HatchOpts | null
	vents?: VentOpts | null
	seams?: WeldSeamOpts | null
	rivets?: RivetOpts | null
	wear?: WearOpts | null
	/** Shared ceiling across the whole plan, spent in pass order rather than split evenly. */
	triangleBudget?: number
}

// ---------------------------------------------------------------------------
// Faction presets — ARCHITECTURE.md §9's two design languages, one toolkit
// ---------------------------------------------------------------------------

/**
 * Mass-produced steel: rolled plate bolted proud of the frame, welded at every join,
 * knocked about. Every plate edge is a rivet line and every crease is a bead.
 */
// Per-pass budgets are set explicitly rather than left to the fallbacks. greeble() spends
// the shared budget in pass order, so without these the first pass takes what it likes and
// starves the last — and the last pass here is rivets, which is the faction's whole read.
export const FOUNDRY_GREEBLE: GreeblePlan = {
	panels: {
		pattern: 'bsp', plateHeight: 0.012, bevel: 0.01, gap: 0.028,
		splitBias: 0.3, skipChance: 0.12, triangleBudget: 2600,
	},
	hatches: { count: 2, triangleBudget: 900 },
	vents: { count: 1, triangleBudget: 700 },
	seams: { minAngle: 24, radius: 0.017, lumpiness: 0.4, triangleBudget: 2200 },
	rivets: {
		spacing: 0.2, sides: 6, radius: 0.021, height: 0.011,
		dropChance: 0.07, triangleBudget: 2600,
	},
	wear: { amount: 0.009, baseAmount: 0.0016 },
	triangleBudget: 9000,
}

/**
 * Field-bolted framework: corrugated sheet and canvas fastened onto an open frame, every
 * join made with hardware rather than heat. §9.1's contrast with the Foundry is solid cast
 * mass against open bolted framework, so this is deliberately MORE fastener-heavy than
 * `FOUNDRY_GREEBLE`, not less — the faction ships frames flat and bolts them on site.
 *
 * Rewritten 2026-07-30. It previously read "printed in place: ceramic tiles sunk into a
 * raised hex frame, no fasteners, no beads" and implemented the SUPERSEDED science-fiction
 * spec in five separate decisions: a hex tiling, a negative `plateHeight` sinking tiles
 * under a raised frame, `fasteners: 0`, `seams: null`, and `rivets: null`. It survived the
 * 2026-07-28 art-direction change because nothing scanned `geo/` — it was the FOURTH place
 * that direction persisted, and it was found only because a human looked at the screen and
 * the search kept widening. See `issues/art-1.md`.
 */
export const LATTICE_GREEBLE: GreeblePlan = {
	// Sheet infill sits PROUD of the frame it is bolted to, so the height is positive. The
	// sign is the whole difference between bolted-on cladding and a tile sunk under a lip.
	panels: {
		pattern: 'bsp', plateHeight: 0.008, bevel: 0.008, gap: 0.022,
		splitBias: 0.45, skipChance: 0.14, heightJitter: 0.3, triangleBudget: 2400,
	},
	// A hatch on a bolted machine is bolted shut.
	hatches: { count: 1, lipHeight: 0.005, lipWidth: 0.03, fasteners: 6, depth: 0.02, triangleBudget: 700 },
	vents: {
		count: 1, slats: 8, slatAngle: 22, frameHeight: 0.005,
		slatThickness: 0.009, triangleBudget: 800,
	},
	// Angle-iron edging along the frame members rather than the Foundry's weld beads: this
	// faction bolts, so a continuous bead would be the wrong join. Tighter and less lumpy
	// than rolled plate welded hot.
	seams: { minAngle: 30, radius: 0.011, lumpiness: 0.15, triangleBudget: 1400 },
	// The faction's whole read, and denser than Foundry's 0.2 spacing on purpose. `sides: 6`
	// is a hexagonal BOLT HEAD — real hardware, and not to be confused with the hex
	// PANELLING this preset used to generate.
	rivets: {
		spacing: 0.13, sides: 6, radius: 0.017, height: 0.009,
		dropChance: 0.05, triangleBudget: 3200,
	},
	// More wear than the Foundry, not less. Zinc chalks, canvas frays, and steel rusts at
	// every fastener and edge — §9.0's "nothing is pristine" applies hardest to the faction
	// whose old spec claimed it "does not oxidise".
	wear: { amount: 0.011, baseAmount: 0.0020, minAngle: 32 },
	triangleBudget: 9000,
}

// ---------------------------------------------------------------------------
// Passes
// ---------------------------------------------------------------------------

/**
 * Partition every large flat region into panels and lift each one into a chamfered
 * plate, so the gap between neighbours reads as a groove.
 *
 * The split is recursive and seeded, with a jittered split position, so panel size
 * varies within a facet as well as between facets. A uniform grid is instantly legible
 * as generated output no matter how good the material on top of it is.
 */
export function panelLines(mesh: Mesh, rng: Rng, opts: PanelLineOpts = {}): GreebleStats {
	const r = rng.forkNamed('geo/greeble:panelLines')
	const budget = new TriBudget(opts.triangleBudget ?? 4000)
	const stats: GreebleStats = { triangles: 0, features: 0, dropped: 0 }

	const pattern = opts.pattern ?? 'bsp'
	const minPanel = opts.minPanel ?? 0.34
	const maxPanel = opts.maxPanel ?? 1.35
	const splitBias = clamp(opts.splitBias ?? 0.3, 0, 0.45)
	const splitChance = clamp(opts.splitChance ?? 0.55, 0, 1)
	const maxDepth = Math.max(1, Math.floor(opts.maxDepth ?? 7))
	const gap = opts.gap ?? 0.026
	const height = opts.plateHeight ?? 0.012
	const bevel = Math.max(0, opts.bevel ?? 0.01)
	const heightJitter = clamp(opts.heightJitter ?? 0.18, 0, 1)
	const skipChance = clamp(opts.skipChance ?? 0.1, 0, 1)
	const hexRadius = opts.hexRadius ?? 0.26
	const invUv = 1 / (opts.uvScale ?? 1)

	const topo = buildTopology(mesh)
	const facets = extractFacets(topo, opts.planarTolerance ?? 8, opts.minFacetArea ?? 0.14)
	const order = facetsByArea(facets)

	// Rect stack, flat: u0, v0, u1, v1, depth. Flat because one facet can produce a few
	// hundred nodes, and an object per node is a few hundred allocations per facet.
	const stack: number[] = []

	for (let oi = 0; oi < order.length; oi++) {
		const f = facets[order[oi]]
		const zone = opts.zone ?? f.zone

		if (pattern === 'hex') {
			stats.features += hexPanels(mesh, r, f, hexRadius, gap, height, bevel,
				heightJitter, skipChance, zone, invUv, budget)
			continue
		}

		stack.length = 0
		stack.push(f.u0, f.v0, f.u1, f.v1, 0)
		while (stack.length > 0) {
			const depth = stack.pop() as number
			const v1 = stack.pop() as number
			const u1 = stack.pop() as number
			const v0 = stack.pop() as number
			const u0 = stack.pop() as number
			const w = u1 - u0
			const h = v1 - v0

			// Splittability is per axis. Gating it on min(w, h) — the *short* side —
			// made a long thin rect unsplittable along its long side, so every side
			// skirt, boom and barrel kept one giant plate and maxPanel was silently
			// unenforced exactly where this pass earns its keep.
			const canU = w > 2 * minPanel
			const canV = h > 2 * minPanel
			const overU = w > maxPanel
			const overV = h > maxPanel
			// The depth cap guards *discretionary* recursion. A cut that attacks a
			// breached cap does not spend depth, or a run of lopsided splits could
			// exhaust the budget and leave an oversized plate behind anyway — the cap
			// silently outranking maxPanel is the same failure by a longer route. That
			// recursion is self-limiting: every such cut takes at least minPanel off the
			// offending side.
			const canSplit = (depth < maxDepth || overU || overV) && (canU || canV)
			if (canSplit && (overU || overV || r.bool(splitChance))) {
				let splitU: boolean
				if (!canU || !canV) splitU = canU
				// A breached cap decides the axis: cutting the other one leaves the
				// offending side just as long. Otherwise split the long side, except
				// when both are comfortably splittable — always taking the long side
				// drives every panel towards the same square, which is the uniform
				// grid arriving by another route.
				else if (overU !== overV) splitU = overU
				else {
					const bothOk = Math.min(w, h) > 2.4 * minPanel
					splitU = bothOk ? r.bool(w / (w + h)) : w >= h
				}
				const span = splitU ? w : h
				const lo = minPanel / span
				const t = clamp(0.5 + r.signed(splitBias), lo, 1 - lo)
				const nd = (splitU ? overU : overV) ? depth : depth + 1
				if (splitU) {
					const m = u0 + span * t
					stack.push(u0, v0, m, v1, nd)
					stack.push(m, v0, u1, v1, nd)
				} else {
					const m = v0 + span * t
					stack.push(u0, v0, u1, m, nd)
					stack.push(u0, m, u1, v1, nd)
				}
				continue
			}

			if (r.bool(skipChance)) continue
			const g = gap * 0.5
			const pu0 = u0 + g, pv0 = v0 + g, pu1 = u1 - g, pv1 = v1 - g
			if (pu1 - pu0 < minPanel * 0.5 || pv1 - pv0 < minPanel * 0.5) continue
			// A facet is rarely its own bounding box. Reject any plate that would hang
			// off an L-shaped or triangular region into empty space.
			if (!rectInFacet(f, pu0, pv0, pu1, pv1)) continue

			const hh = height * (1 + r.signed(heightJitter))
			if (plate4(mesh, f, pu0, pv0, pu1, pv1, hh, bevel, zone, invUv, budget) > 0) stats.features++
		}
	}

	stats.triangles = budget.used
	stats.dropped = budget.dropped
	return stats
}

/**
 * Stud the border of every facet at a seeded spacing.
 *
 * Run this *after* panelLines: a plate top is a facet in its own right, so "along every
 * facet border" becomes "along every panel edge" with no state shared between the two
 * passes. Run it on a bare mesh instead and it borders the raw hull plates, which is the
 * right answer for a part that was never plated.
 */
export function rivets(mesh: Mesh, rng: Rng, opts: RivetOpts = {}): GreebleStats {
	const r = rng.forkNamed('geo/greeble:rivets')
	const budget = new TriBudget(opts.triangleBudget ?? 3000)
	const stats: GreebleStats = { triangles: 0, features: 0, dropped: 0 }

	const spacing = Math.max(1e-3, opts.spacing ?? 0.2)
	const jitter = clamp(opts.jitter ?? 0.2, 0, 0.5)
	const radius = opts.radius ?? 0.021
	const radiusJitter = clamp(opts.radiusJitter ?? 0.16, 0, 0.9)
	const height = opts.height ?? 0.011
	const sides = Math.floor(clamp(opts.sides ?? 6, 3, MAX_SIDES))
	const inset = opts.inset ?? 0.045
	const dropChance = clamp(opts.dropChance ?? 0.07, 0, 1)
	const capOnly = opts.capOnly ?? false
	const maxPerFacet = Math.floor(opts.maxPerFacet ?? 64)
	const invUv = 1 / (opts.uvScale ?? 1)
	const cost = capOnly ? sides - 2 : 3 * sides - 2

	const topo = buildTopology(mesh)
	const facets = extractFacets(topo, opts.planarTolerance ?? 8, opts.minFacetArea ?? 0.05)
	const order = facetsByArea(facets)

	for (let oi = 0; oi < order.length; oi++) {
		const f = facets[order[oi]]
		const loop = f.border
		const n = loop.length >> 1
		if (n < 3) continue
		const zone = opts.zone ?? f.zone

		let perim = 0
		for (let i = 0; i < n; i++) {
			const j = (i + 1) % n
			perim += Math.hypot(loop[j * 2] - loop[i * 2], loop[j * 2 + 1] - loop[i * 2 + 1])
		}
		if (perim < spacing * 2) continue

		// A whole number of stations, so the row closes on itself instead of leaving one
		// visibly short gap where the walk wraps.
		const stations = Math.max(3, Math.round(perim / spacing))
		const step = perim / stations
		let cursor = r.next() * step
		let placed = 0
		let seg = 0
		let segStart = 0
		let segLen = Math.hypot(loop[2] - loop[0], loop[3] - loop[1])

		for (let s = 0; s < stations; s++) {
			// Jitter clamped to be monotonic: the walk down the loop is single-pass, so
			// a station that jittered backwards would be resolved against the wrong edge.
			let target = cursor + step + r.signed(jitter * step)
			if (target < cursor) target = cursor
			if (target >= perim) break
			cursor = target

			while (target >= segStart + segLen && seg < n - 1) {
				segStart += segLen
				seg++
				const nj = (seg + 1) % n
				segLen = Math.hypot(loop[nj * 2] - loop[seg * 2], loop[nj * 2 + 1] - loop[seg * 2 + 1])
			}
			if (segLen < 1e-9) continue
			const j = (seg + 1) % n
			const t = clamp((target - segStart) / segLen, 0, 1)
			const du = (loop[j * 2] - loop[seg * 2]) / segLen
			const dv = (loop[j * 2 + 1] - loop[seg * 2 + 1]) / segLen
			// The loop runs counter-clockwise about +normal, so the interior lies to the
			// left of every directed edge and the inward normal is (-dv, du).
			const u = lerp(loop[seg * 2], loop[j * 2], t) - dv * inset
			const v = lerp(loop[seg * 2 + 1], loop[j * 2 + 1], t) + du * inset

			if (r.bool(dropChance)) continue
			if (placed >= maxPerFacet) break
			if (!pointInFacet(f, u, v)) continue
			if (!budget.take(cost)) break

			stud(mesh, f, u, v, radius * (1 + r.signed(radiusJitter)), 0, height, sides,
				r.next() * Math.PI * 2, capOnly, zone, invUv)
			placed++
			stats.features++
		}
	}

	stats.triangles = budget.used
	stats.dropped = budget.dropped
	return stats
}

/**
 * Recessed access panels: a raised coaming, a floor, and corner fasteners. The one
 * greeble that reads as *purpose* rather than as texture, which is why it goes on the
 * largest facets, sparsely, rather than scattered.
 */
export function hatches(mesh: Mesh, rng: Rng, opts: HatchOpts = {}): GreebleStats {
	const r = rng.forkNamed('geo/greeble:hatches')
	const budget = new TriBudget(opts.triangleBudget ?? 1200)
	const stats: GreebleStats = { triangles: 0, features: 0, dropped: 0 }

	const count = Math.max(0, Math.floor(opts.count ?? 2))
	const size = opts.size ?? 0.55
	const sizeJitter = clamp(opts.sizeJitter ?? 0.22, 0, 0.9)
	const aspect = Math.max(1, opts.aspect ?? 1.35)
	const depth = opts.depth ?? 0.035
	const lipHeight = opts.lipHeight ?? 0.012
	const lipWidth = Math.max(1e-3, opts.lipWidth ?? 0.045)
	const fasteners = Math.floor(opts.fasteners ?? 4)
	const fastenerRadius = opts.fastenerRadius ?? 0.017
	const fastenerSides = Math.floor(clamp(opts.fastenerSides ?? 6, 3, MAX_SIDES))
	const tries = Math.max(1, Math.floor(opts.tries ?? 12))
	const invUv = 1 / (opts.uvScale ?? 1)
	const cost = 26 + fasteners * (3 * fastenerSides - 2)

	const topo = buildTopology(mesh)
	const facets = extractFacets(topo, opts.planarTolerance ?? 8, opts.minFacetArea ?? 0.2)
	const order = facetsByArea(facets)
	if (order.length === 0) return stats

	for (let k = 0; k < count; k++) {
		// Round-robin across the largest facets, so two hatches never land on one plate
		// while an equally large neighbour stays bare.
		const f = facets[order[k % order.length]]
		const zone = opts.zone ?? f.zone
		const long = size * (1 + r.signed(sizeJitter))
		const asp = aspect * (1 + r.signed(0.15))
		const swap = r.bool()
		const hw = (swap ? long / asp : long) * 0.5
		const hh = (swap ? long : long / asp) * 0.5
		const padU = hw + lipWidth
		const padV = hh + lipWidth
		if (f.u1 - f.u0 < 2 * padU || f.v1 - f.v0 < 2 * padV) continue

		let ok = false
		let cu = 0
		let cv = 0
		for (let t = 0; t < tries; t++) {
			cu = r.range(f.u0 + padU, f.u1 - padU)
			cv = r.range(f.v0 + padV, f.v1 - padV)
			if (rectInFacet(f, cu - padU, cv - padV, cu + padU, cv + padV)) {
				ok = true
				break
			}
		}
		if (!ok) continue
		if (!budget.take(cost)) continue

		frame(mesh, f, cu, cv, hw, hh, lipWidth, lipHeight, depth, zone, invUv)
		if (fasteners > 0) {
			const fu = hw + lipWidth * 0.5
			const fv = hh + lipWidth * 0.5
			// Driven into the coaming's top face, which is the rim — not into the hull,
			// which is now a whole recess depth below them.
			const rim = Math.max(LIFT, depth) + lipHeight
			for (let c = 0; c < fasteners; c++) {
				// Corners in order; any extra fasteners spill onto the long sides.
				const su = c === 0 || c === 3 ? -1 : 1
				const sw = c < 2 ? -1 : 1
				stud(mesh, f, cu + su * fu, cv + sw * fv, fastenerRadius, rim,
					lipHeight * 0.75 + 0.004, fastenerSides, r.next() * Math.PI * 2, false, zone, invUv)
			}
		}
		stats.features++
	}

	stats.triangles = budget.used
	stats.dropped = budget.dropped
	return stats
}

/**
 * Louvred grilles: angled slats in a recessed frame. The slats overlap by default so the
 * grille stays opaque at a grazing angle — a vent you can see the hull interior through
 * is worse than no vent at all.
 */
export function vents(mesh: Mesh, rng: Rng, opts: VentOpts = {}): GreebleStats {
	const r = rng.forkNamed('geo/greeble:vents')
	const budget = new TriBudget(opts.triangleBudget ?? 1400)
	const stats: GreebleStats = { triangles: 0, features: 0, dropped: 0 }

	const count = Math.max(0, Math.floor(opts.count ?? 1))
	const size = opts.size ?? 0.7
	const sizeJitter = clamp(opts.sizeJitter ?? 0.18, 0, 0.9)
	const aspect = Math.max(1, opts.aspect ?? 1.8)
	const depth = opts.depth ?? 0.085
	const slats = Math.max(1, Math.floor(opts.slats ?? 6))
	const slatAngle = (opts.slatAngle ?? 34) * DEG2RAD
	const slatThickness = opts.slatThickness ?? 0.013
	const slatOverlap = Math.max(0.5, opts.slatOverlap ?? 1.24)
	const frameWidth = Math.max(1e-3, opts.frameWidth ?? 0.04)
	const frameHeight = opts.frameHeight ?? 0.011
	const tries = Math.max(1, Math.floor(opts.tries ?? 12))
	const invUv = 1 / (opts.uvScale ?? 1)
	const cost = 26 + slats * 12

	const topo = buildTopology(mesh)
	const facets = extractFacets(topo, opts.planarTolerance ?? 8, opts.minFacetArea ?? 0.25)
	const order = facetsByArea(facets)
	if (order.length === 0) return stats

	for (let k = 0; k < count; k++) {
		const f = facets[order[k % order.length]]
		const zone = opts.zone ?? f.zone
		const long = size * (1 + r.signed(sizeJitter))
		const swap = r.bool()
		const hw = (swap ? long / aspect : long) * 0.5
		const hh = (swap ? long : long / aspect) * 0.5
		const padU = hw + frameWidth
		const padV = hh + frameWidth
		if (f.u1 - f.u0 < 2 * padU || f.v1 - f.v0 < 2 * padV) continue

		let ok = false
		let cu = 0
		let cv = 0
		for (let t = 0; t < tries; t++) {
			cu = r.range(f.u0 + padU, f.u1 - padU)
			cv = r.range(f.v0 + padV, f.v1 - padV)
			if (rectInFacet(f, cu - padU, cv - padV, cu + padU, cv + padV)) {
				ok = true
				break
			}
		}
		if (!ok) continue
		if (!budget.take(cost)) continue

		frame(mesh, f, cu, cv, hw, hh, frameWidth, frameHeight, depth, zone, invUv)

		// Louvres run along the opening's long axis and stack across its short one.
		const alongU = hw >= hh
		const halfLong = (alongU ? hw : hh) * 0.96
		const halfShort = alongU ? hh : hw
		const pitch = (2 * halfShort) / slats
		const halfSlat = pitch * 0.5 * slatOverlap
		const ca = Math.cos(slatAngle)
		const sa = Math.sin(slatAngle)
		const axU = alongU ? 1 : 0
		const axV = alongU ? 0 : 1
		// The grille interior is the volume the raised housing encloses: floor on the
		// host surface, rim at depth + frameHeight. Slats hang halfway up it, clamped so
		// a fat or steeply pitched louvre never sinks through the floor into the solid,
		// where it would cost 12 triangles and render as nothing.
		const rimTop = depth + frameHeight
		const slatHalfN = Math.abs(halfSlat * sa) + Math.abs(slatThickness * 0.5 * ca)
		const slatH = clamp(rimTop * 0.5, slatHalfN + LIFT, rimTop - slatHalfN)

		facetDir(f, axU, axV, sv.a)
		facetDir(f, axV, -axU, sv.b)
		for (let i = 0; i < slats; i++) {
			const off = -halfShort + (i + 0.5) * pitch + r.signed(pitch * 0.06)
			const slatU = alongU ? cu : cu + off
			const slatV = alongU ? cv + off : cv
			// Half-extents: the long axis, then the short axis and the surface normal
			// both rotated about the long axis by the louvre pitch.
			v3.scale(sv.d, sv.a, halfLong)
			v3.scale(sv.e, sv.b, ca)
			v3.addScaled(sv.e, sv.e, f.n, sa)
			v3.scale(sv.e, sv.e, halfSlat)
			v3.scale(sv.f, sv.b, -sa)
			v3.addScaled(sv.f, sv.f, f.n, ca)
			v3.scale(sv.f, sv.f, slatThickness * 0.5)
			facetPoint(f, slatU, slatV, slatH, sv.g)
			box(mesh, sv.g, sv.d, sv.e, sv.f, zone, invUv)
		}
		stats.features++
	}

	stats.triangles = budget.used
	stats.dropped = budget.dropped
	return stats
}

/**
 * Sweep a raised bead along every crease sharp enough to be a plate join.
 *
 * The path set comes from the mesh itself rather than from a caller-supplied spline, so
 * this composes with panelLines for free: plate the hull, then weld what plating made.
 * `minPathLength` is load-bearing — it is what keeps beads off the rims of rivets and
 * fastener heads, whose base loops are perfectly good creases too.
 */
export function weldSeams(mesh: Mesh, rng: Rng, opts: WeldSeamOpts = {}): GreebleStats {
	const r = rng.forkNamed('geo/greeble:weldSeams')
	const budget = new TriBudget(opts.triangleBudget ?? 3000)
	const stats: GreebleStats = { triangles: 0, features: 0, dropped: 0 }

	// Cosines, so the comparisons below are a dot product with no acos per edge. cos is
	// decreasing, hence the inverted senses.
	const cosMin = Math.cos((opts.minAngle ?? 24) * DEG2RAD)
	const cosMax = Math.cos((opts.maxAngle ?? 150) * DEG2RAD)
	const convexOnly = opts.convexOnly ?? true
	const radius = opts.radius ?? 0.017
	const heightScale = opts.heightScale ?? 0.85
	const lumpiness = clamp(opts.lumpiness ?? 0.38, 0, 1)
	const lumpScale = Math.max(1e-3, opts.lumpScale ?? 0.11)
	const wobble = clamp(opts.wobble ?? 0.25, 0, 1)
	const segLen = Math.max(1e-3, opts.segmentLength ?? 0.06)
	const sides = Math.floor(clamp(opts.profileSides ?? 3, 2, 8))
	const minPathLength = opts.minPathLength ?? 0.2
	// null means inherit, per GreebleCommon.zone. Defaulting to 0 stamped every bead
	// base metal — a seam crossing a player-colour panel stopped being that panel, and a
	// mesh with no zone 0 in it grew one that survived the whole LOD chain (§9: zone is
	// the repaint mask, not decoration).
	const zoneOpt = opts.zone ?? null
	const invUv = 1 / (opts.uvScale ?? 1)
	const noiseSeed = r.nextU32()

	const topo = buildTopology(mesh)
	const ec = topo.edgeCount

	const isCand = new Uint8Array(ec)
	const deg = new Map<number, number>()
	const adj0 = new Map<number, number>()
	const adj1 = new Map<number, number>()
	for (let e = 0; e < ec; e++) {
		const t0 = topo.edgeT0[e]
		const t1 = topo.edgeT1[e]
		if (t1 < 0) continue
		const d = topo.triN[t0 * 3] * topo.triN[t1 * 3] +
			topo.triN[t0 * 3 + 1] * topo.triN[t1 * 3 + 1] +
			topo.triN[t0 * 3 + 2] * topo.triN[t1 * 3 + 2]
		if (d > cosMin || d < cosMax) continue
		if (convexOnly && !isConvexEdge(topo, t0, t1)) continue
		isCand[e] = 1
		bumpDegree(deg, adj0, adj1, topo.edgeA[e], e)
		bumpDegree(deg, adj0, adj1, topo.edgeB[e], e)
	}

	const visited = new Uint8Array(ec)
	const path: number[] = []
	const px = new Float32Array((ec + 2) * 3)
	const pw = new Float32Array((ec + 2) * 3)
	/** Host zone per path vertex, resolved once per path rather than per emitted ring. */
	const pz = new Uint8Array(ec + 2)

	// Endpoints first, cycles second. Walking from an endpoint yields a whole seam in
	// one go; starting mid-path would split it into two beads meeting in a butt joint.
	for (let phase = 0; phase < 2; phase++) {
		for (let e = 0; e < ec; e++) {
			if (!isCand[e] || visited[e]) continue
			let start = topo.edgeA[e]
			if (phase === 0) {
				const da = deg.get(topo.edgeA[e]) ?? 0
				const db = deg.get(topo.edgeB[e]) ?? 0
				if (da === 2 && db === 2) continue
				start = da === 2 ? topo.edgeB[e] : topo.edgeA[e]
			}
			walkPath(topo, isCand, visited, deg, adj0, adj1, start, e, path)
			if (path.length < 2) continue
			stats.features += sweepBead(mesh, topo, path, px, pw, pz, radius, heightScale,
				lumpiness, lumpScale, wobble, segLen, sides, minPathLength, noiseSeed,
				zoneOpt, invUv, budget)
		}
	}

	stats.triangles = budget.used
	stats.dropped = budget.dropped
	return stats
}

/**
 * Displace vertices inward, concentrated on convex creases.
 *
 * The material forge drives wear and grime off generated curvature (§6.7). That only
 * works if the curvature is real: a sharp edge on a mathematically exact box has an
 * infinitely thin high-curvature band, so the wear mask has nothing to find. Rounding it
 * by a few millimetres gives the mask a band with actual width — and it is the reason
 * this pass exists at all, ahead of any silhouette benefit.
 *
 * Adds no triangles, so it is the one pass that is always affordable.
 */
export function wear(mesh: Mesh, rng: Rng, opts: WearOpts = {}): GreebleStats {
	const r = rng.forkNamed('geo/greeble:wear')
	const stats: GreebleStats = { triangles: 0, features: 0, dropped: 0 }

	const amount = opts.amount ?? 0.008
	const baseAmount = opts.baseAmount ?? 0.0015
	const noiseScale = Math.max(1e-4, opts.noiseScale ?? 0.25)
	const cosMin = Math.cos((opts.minAngle ?? 25) * DEG2RAD)
	const cosMax = Math.cos((opts.maxAngle ?? 110) * DEG2RAD)
	const includeConcave = opts.includeConcave ?? false
	const preserveBorder = opts.preserveBorder ?? true
	const recompute = opts.recomputeNormals ?? true
	const noiseSeed = r.nextU32()

	const topo = buildTopology(mesh, opts.weldEpsilon ?? DEFAULT_WELD_EPS)
	const vc = topo.vertexCount
	const gc = topo.groupCount
	if (vc === 0) return stats

	// Everything below is indexed by position group, never by the raw vertex. Two
	// vertices at one position with different normals are one point of the surface;
	// moving them apart tears the mesh open along every shading and UV seam it has.
	const conv = new Float32Array(gc)
	const nrm = new Float32Array(gc * 3)
	const locked = new Uint8Array(gc)

	for (let t = 0; t < topo.triCount; t++) {
		const a = topo.triArea[t]
		const nx = topo.triN[t * 3] * a
		const ny = topo.triN[t * 3 + 1] * a
		const nz = topo.triN[t * 3 + 2] * a
		for (let k = 0; k < 3; k++) {
			const w = topo.weld[topo.idx[t * 3 + k]]
			nrm[w * 3] += nx
			nrm[w * 3 + 1] += ny
			nrm[w * 3 + 2] += nz
		}
	}

	for (let e = 0; e < topo.edgeCount; e++) {
		const t0 = topo.edgeT0[e]
		const t1 = topo.edgeT1[e]
		const a = topo.edgeA[e]
		const b = topo.edgeB[e]
		if (t1 < 0) {
			if (preserveBorder) {
				locked[a] = 1
				locked[b] = 1
			}
			continue
		}
		const d = topo.triN[t0 * 3] * topo.triN[t1 * 3] +
			topo.triN[t0 * 3 + 1] * topo.triN[t1 * 3 + 1] +
			topo.triN[t0 * 3 + 2] * topo.triN[t1 * 3 + 2]
		if (d > cosMin) continue
		if (!includeConcave && !isConvexEdge(topo, t0, t1)) continue
		// Max, not sum: a vertex where four creases meet is not four times as worn as
		// one a single crease passes through — it is worn by the sharpest of them.
		const s = smoothstep(cosMin, cosMax, d)
		if (s > conv[a]) conv[a] = s
		if (s > conv[b]) conv[b] = s
	}

	const pos = mesh.positions
	const disp = new Float32Array(gc)
	for (let w = 0; w < gc; w++) {
		if (locked[w]) continue
		const l = Math.hypot(nrm[w * 3], nrm[w * 3 + 1], nrm[w * 3 + 2])
		if (l < 1e-12) continue
		const inv = 1 / l
		nrm[w * 3] *= inv
		nrm[w * 3 + 1] *= inv
		nrm[w * 3 + 2] *= inv
		const p = topo.rep[w] * 3
		const x = pos[p]
		const y = pos[p + 1]
		const z = pos[p + 2]
		const fine = noise3(noiseSeed, x / noiseScale, y / noiseScale, z / noiseScale)
		const coarse = noise3(noiseSeed ^ 0x5bf03635, x / (noiseScale * 3.2), y / (noiseScale * 3.2), z / (noiseScale * 3.2))
		// Chip depth varies along an edge. A uniformly rounded edge is a bevel, and a
		// bevel is manufacturing — it is not wear.
		disp[w] = -(amount * conv[w] * (0.35 + 0.65 * coarse) + baseAmount * (fine * 2 - 1))
		if (conv[w] > 0) stats.features++
	}

	for (let i = 0; i < vc; i++) {
		const w = topo.weld[i]
		const d = disp[w]
		if (d === 0) continue
		pos[i * 3] += nrm[w * 3] * d
		pos[i * 3 + 1] += nrm[w * 3 + 1] * d
		pos[i * 3 + 2] += nrm[w * 3 + 2] * d
	}

	if (recompute) mesh.computeNormals()
	return stats
}

/**
 * Run a whole recipe under one shared triangle budget, in the only order that composes:
 * plate, raise openings, weld the creases plating made, rivet the plate borders, then wear
 * the assembly. Rivets come after seams precisely so no bead ever traces a rivet rim.
 */
export function greeble(mesh: Mesh, rng: Rng, plan: GreeblePlan = FOUNDRY_GREEBLE): GreebleStats {
	const total: GreebleStats = { triangles: 0, features: 0, dropped: 0 }
	let left = plan.triangleBudget ?? 9000

	const run = (s: GreebleStats) => {
		total.triangles += s.triangles
		total.features += s.features
		total.dropped += s.dropped
		left -= s.triangles
	}
	/** Give the pass what is left, but never more than its own ceiling. */
	const cap = (o: { triangleBudget?: number }, fallback: number) =>
		Math.max(0, Math.min(left, o.triangleBudget ?? fallback))

	if (plan.panels) run(panelLines(mesh, rng, { ...plan.panels, triangleBudget: cap(plan.panels, 4000) }))
	if (plan.hatches) run(hatches(mesh, rng, { ...plan.hatches, triangleBudget: cap(plan.hatches, 1200) }))
	if (plan.vents) run(vents(mesh, rng, { ...plan.vents, triangleBudget: cap(plan.vents, 1400) }))
	if (plan.seams) run(weldSeams(mesh, rng, { ...plan.seams, triangleBudget: cap(plan.seams, 3000) }))
	if (plan.rivets) run(rivets(mesh, rng, { ...plan.rivets, triangleBudget: cap(plan.rivets, 3000) }))
	if (plan.wear) run(wear(mesh, rng, plan.wear))
	return total
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

class TriBudget {
	readonly limit: number
	used = 0
	dropped = 0

	constructor(limit: number) {
		this.limit = Math.max(0, limit)
	}

	/** Reserve `n` up front: a feature is emitted whole or not at all, never truncated. */
	take(n: number): boolean {
		if (this.used + n > this.limit) {
			this.dropped++
			return false
		}
		this.used += n
		return true
	}
}

// ---------------------------------------------------------------------------
// Topology — welded adjacency over an indexed triangle mesh
// ---------------------------------------------------------------------------

interface Topology {
	/** Raw vertex index → position-group id. The surface, not the vertex buffer. */
	readonly weld: Int32Array
	/** Position-group id → one raw vertex index in that group, for position lookups. */
	readonly rep: Int32Array
	readonly groupCount: number
	readonly pos: Float32Array
	readonly idx: Uint32Array
	/** Per-vertex material zone. */
	readonly zone: Uint8Array
	readonly vertexCount: number
	readonly triCount: number
	/** Unit face normal, 3 per triangle. */
	readonly triN: Float32Array
	/** Centroid, 3 per triangle. */
	readonly triC: Float32Array
	readonly triArea: Float32Array
	/** Edge index for the edge between local corners k and k+1, 3 per triangle. */
	readonly triEdge: Int32Array
	readonly edgeA: Uint32Array
	readonly edgeB: Uint32Array
	readonly edgeT0: Int32Array
	/** -1 on an open boundary. */
	readonly edgeT1: Int32Array
	readonly edgeCount: number
	/** Canonical (lo, hi) key → edge index. */
	readonly edgeKey: Map<number, number>
}

/**
 * Snapshot the mesh's channels and build welded adjacency.
 *
 * The snapshot matters: emitting into the mesh can reallocate its backing arrays, so a
 * pass builds topology once at entry, before it writes anything, and the arrays captured
 * here stay valid for the original geometry no matter what grows afterwards. A pass that
 * emitted and then re-read topology would be reading a moved buffer.
 */
function buildTopology(mesh: Mesh, weldEps = DEFAULT_WELD_EPS): Topology {
	const pos = mesh.positions
	const idx = mesh.indices
	const zone = mesh.materialZone
	const vc = mesh.vertexCount
	const tc = mesh.triangleCount
	if (vc >= EDGE_KEY_BASE) throw new Error(`greeble: ${vc} vertices exceeds the edge-key range`)

	// Position groups, not a local weld. mesh.ts owns this space — the simplifier and
	// crease clustering both reason in it — and greebling has to agree with them: a
	// facet border that disagreed about which vertices are one point would put a rivet
	// line down the middle of a UV seam.
	const groups = buildPositionGroups(pos, vc, weldEps)
	const weld = groups.group
	const rep = new Int32Array(groups.count).fill(-1)
	for (let i = 0; i < vc; i++) if (rep[weld[i]] < 0) rep[weld[i]] = i

	const triN = new Float32Array(tc * 3)
	const triC = new Float32Array(tc * 3)
	const triArea = new Float32Array(tc)
	for (let t = 0; t < tc; t++) {
		const i0 = idx[t * 3] * 3
		const i1 = idx[t * 3 + 1] * 3
		const i2 = idx[t * 3 + 2] * 3
		const e0x = pos[i1] - pos[i0], e0y = pos[i1 + 1] - pos[i0 + 1], e0z = pos[i1 + 2] - pos[i0 + 2]
		const e1x = pos[i2] - pos[i0], e1y = pos[i2 + 1] - pos[i0 + 1], e1z = pos[i2 + 2] - pos[i0 + 2]
		const cx = e0y * e1z - e0z * e1y
		const cy = e0z * e1x - e0x * e1z
		const cz = e0x * e1y - e0y * e1x
		const l = Math.hypot(cx, cy, cz)
		triArea[t] = l * 0.5
		if (l > 1e-14) {
			triN[t * 3] = cx / l
			triN[t * 3 + 1] = cy / l
			triN[t * 3 + 2] = cz / l
		}
		triC[t * 3] = (pos[i0] + pos[i1] + pos[i2]) / 3
		triC[t * 3 + 1] = (pos[i0 + 1] + pos[i1 + 1] + pos[i2 + 1]) / 3
		triC[t * 3 + 2] = (pos[i0 + 2] + pos[i1 + 2] + pos[i2 + 2]) / 3
	}

	const triEdge = new Int32Array(tc * 3).fill(-1)
	const edgeA = new Uint32Array(tc * 3)
	const edgeB = new Uint32Array(tc * 3)
	const edgeT0 = new Int32Array(tc * 3).fill(-1)
	const edgeT1 = new Int32Array(tc * 3).fill(-1)
	const edgeKey = new Map<number, number>()
	let ec = 0
	for (let t = 0; t < tc; t++) {
		for (let k = 0; k < 3; k++) {
			const a = weld[idx[t * 3 + k]]
			const b = weld[idx[t * 3 + ((k + 1) % 3)]]
			if (a === b) continue
			const lo = a < b ? a : b
			const hi = a < b ? b : a
			const key = lo * EDGE_KEY_BASE + hi
			let e = edgeKey.get(key)
			if (e === undefined) {
				e = ec++
				edgeKey.set(key, e)
				edgeA[e] = lo
				edgeB[e] = hi
				edgeT0[e] = t
			} else if (edgeT1[e] < 0) {
				edgeT1[e] = t
			}
			// A third face on one edge is non-manifold. It still gets the edge index so
			// facet flood-fill can reach it, but it is not recorded as an adjacency —
			// crease and border logic must always see a well-defined pair or nothing.
			triEdge[t * 3 + k] = e
		}
	}

	return {
		weld, rep, groupCount: groups.count, pos, idx, zone, vertexCount: vc, triCount: tc,
		triN, triC, triArea, triEdge, edgeA, edgeB, edgeT0, edgeT1, edgeCount: ec, edgeKey,
	}
}

/**
 * True when the surface folds outward across this edge — a ridge, where a bead of weld
 * sits and where wear cuts. Face 1's centroid lying below face 0's plane is the test.
 */
function isConvexEdge(topo: Topology, t0: number, t1: number): boolean {
	const dx = topo.triC[t1 * 3] - topo.triC[t0 * 3]
	const dy = topo.triC[t1 * 3 + 1] - topo.triC[t0 * 3 + 1]
	const dz = topo.triC[t1 * 3 + 2] - topo.triC[t0 * 3 + 2]
	return dx * topo.triN[t0 * 3] + dy * topo.triN[t0 * 3 + 1] + dz * topo.triN[t0 * 3 + 2] < 0
}

function edgeBetween(topo: Topology, a: number, b: number): number {
	const lo = a < b ? a : b
	const hi = a < b ? b : a
	return topo.edgeKey.get(lo * EDGE_KEY_BASE + hi) ?? -1
}

/**
 * The material zone of the surface a crease runs across.
 *
 * Read off the raw corners of the two faces meeting at the edge — not off the position
 * group, whose representative vertex at a box corner belongs to whichever of three faces
 * happens to hold the lowest index and so reports a neighbouring panel's zone. Majority
 * of at most six candidates, ties broken by the first one seen, so the answer is a
 * function of the mesh alone.
 */
function edgeHostZone(topo: Topology, e: number): number {
	const a = topo.edgeA[e]
	const b = topo.edgeB[e]
	let n = 0
	for (let s = 0; s < 2; s++) {
		const t = s === 0 ? topo.edgeT0[e] : topo.edgeT1[e]
		if (t < 0) continue
		for (let k = 0; k < 3; k++) {
			const raw = topo.idx[t * 3 + k]
			const g = topo.weld[raw]
			if (g === a || g === b) zoneVote[n++] = topo.zone[raw]
		}
	}
	if (n === 0) return 0
	let best = zoneVote[0]
	let bestCount = 0
	for (let i = 0; i < n; i++) {
		let c = 0
		for (let j = 0; j < n; j++) if (zoneVote[j] === zoneVote[i]) c++
		if (c > bestCount) {
			bestCount = c
			best = zoneVote[i]
		}
	}
	return best
}

// ---------------------------------------------------------------------------
// Facets — connected coplanar regions with a tangent frame and a border loop
// ---------------------------------------------------------------------------

interface Facet {
	readonly tris: Int32Array
	/** Plane normal. */
	readonly n: Vec3
	/** Plane origin — the area-weighted centroid. */
	readonly o: Vec3
	readonly tu: Vec3
	readonly tv: Vec3
	/** Facet triangles projected into (u,v): 6 floats per triangle. */
	readonly uv: Float32Array
	/** Outer border loop as flat u,v pairs, counter-clockwise about +n. */
	readonly border: Float32Array
	readonly u0: number
	readonly v0: number
	readonly u1: number
	readonly v1: number
	readonly area: number
	readonly zone: number
}

function extractFacets(topo: Topology, toleranceDeg: number, minArea: number): Facet[] {
	const tol = clamp(toleranceDeg, 0, 89)
	const cosTol = Math.cos(tol * DEG2RAD)
	const tc = topo.triCount
	const facetOf = new Int32Array(tc).fill(-1)
	const stack = new Int32Array(tc)
	const group: number[] = []
	const facets: Facet[] = []
	// Plane thickness scales with the tolerance, so a slightly domed "flat" panel still
	// comes out as one facet while a stair-stepped surface does not.
	const thickness = Math.max(2e-3, Math.tan(tol * DEG2RAD) * 0.25)
	// Group ids advance even for groups too small to publish. Reusing an id would let a
	// later facet mistake a rejected group's triangles for its own and lose its border.
	let gid = 0

	for (let seed = 0; seed < tc; seed++) {
		if (facetOf[seed] >= 0 || topo.triArea[seed] < 1e-12) continue
		const fi = gid++
		const snx = topo.triN[seed * 3]
		const sny = topo.triN[seed * 3 + 1]
		const snz = topo.triN[seed * 3 + 2]
		const scx = topo.triC[seed * 3]
		const scy = topo.triC[seed * 3 + 1]
		const scz = topo.triC[seed * 3 + 2]

		group.length = 0
		let sp = 0
		stack[sp++] = seed
		facetOf[seed] = fi
		while (sp > 0) {
			const t = stack[--sp]
			group.push(t)
			for (let k = 0; k < 3; k++) {
				const e = topo.triEdge[t * 3 + k]
				if (e < 0) continue
				const o = topo.edgeT0[e] === t ? topo.edgeT1[e] : topo.edgeT0[e]
				if (o < 0 || facetOf[o] >= 0 || topo.triArea[o] < 1e-12) continue
				// Compare against the *seed* plane, not the neighbour's. Chaining
				// neighbour-to-neighbour lets the tolerance accumulate and swallows a
				// whole cylinder one 8° step at a time.
				if (topo.triN[o * 3] * snx + topo.triN[o * 3 + 1] * sny + topo.triN[o * 3 + 2] * snz < cosTol) continue
				const dx = topo.triC[o * 3] - scx
				const dy = topo.triC[o * 3 + 1] - scy
				const dz = topo.triC[o * 3 + 2] - scz
				if (Math.abs(dx * snx + dy * sny + dz * snz) > thickness) continue
				facetOf[o] = fi
				stack[sp++] = o
			}
		}

		let area = 0
		for (let i = 0; i < group.length; i++) area += topo.triArea[group[i]]
		if (area < minArea) continue
		facets.push(makeFacet(topo, group, area, fi, facetOf))
	}
	return facets
}

function makeFacet(topo: Topology, group: number[], area: number, fi: number, facetOf: Int32Array): Facet {
	const tris = Int32Array.from(group)
	const n = vec3()
	const o = vec3()
	for (let i = 0; i < tris.length; i++) {
		const t = tris[i]
		const a = topo.triArea[t]
		n[0] += topo.triN[t * 3] * a
		n[1] += topo.triN[t * 3 + 1] * a
		n[2] += topo.triN[t * 3 + 2] * a
		o[0] += topo.triC[t * 3] * a
		o[1] += topo.triC[t * 3 + 1] * a
		o[2] += topo.triC[t * 3 + 2] * a
	}
	v3.normalize(n, n)
	v3.scale(o, o, 1 / Math.max(area, 1e-12))

	// Tangent frame from the world axis least aligned with the normal, ties broken by
	// axis order — so the frame is a deterministic function of the normal alone, which
	// is what makes a facet's UVs and its panel layout reproducible across runs.
	const tu = vec3()
	const tv = vec3()
	const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2])
	if (ax <= ay && ax <= az) v3.set(sv.t, 1, 0, 0)
	else if (ay <= az) v3.set(sv.t, 0, 1, 0)
	else v3.set(sv.t, 0, 0, 1)
	v3.normalize(tu, v3.cross(tu, sv.t, n))
	v3.cross(tv, n, tu)

	const uv = new Float32Array(tris.length * 6)
	let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity
	for (let i = 0; i < tris.length; i++) {
		const t = tris[i]
		for (let k = 0; k < 3; k++) {
			const p = topo.idx[t * 3 + k] * 3
			const dx = topo.pos[p] - o[0]
			const dy = topo.pos[p + 1] - o[1]
			const dz = topo.pos[p + 2] - o[2]
			const u = dx * tu[0] + dy * tu[1] + dz * tu[2]
			const v = dx * tv[0] + dy * tv[1] + dz * tv[2]
			uv[i * 6 + k * 2] = u
			uv[i * 6 + k * 2 + 1] = v
			if (u < u0) u0 = u
			if (u > u1) u1 = u
			if (v < v0) v0 = v
			if (v > v1) v1 = v
		}
	}

	return {
		tris, n, o, tu, tv, uv, border: facetBorder(topo, tris, fi, facetOf, o, tu, tv),
		u0, v0, u1, v1, area, zone: topo.zone[topo.idx[tris[0] * 3]],
	}
}

/**
 * The facet's outer boundary as a 2D loop.
 *
 * Built from triangle corner order rather than from raw edges, so the loop inherits the
 * triangles' winding and comes out counter-clockwise about +n. Rivet placement depends
 * on that orientation to know which side of the border is inward.
 */
function facetBorder(topo: Topology, tris: Int32Array, fi: number, facetOf: Int32Array,
	o: Vec3, tu: Vec3, tv: Vec3): Float32Array {
	const next = new Map<number, number>()
	for (let i = 0; i < tris.length; i++) {
		const t = tris[i]
		for (let k = 0; k < 3; k++) {
			const e = topo.triEdge[t * 3 + k]
			let outside = true
			if (e >= 0) {
				const other = topo.edgeT0[e] === t ? topo.edgeT1[e] : topo.edgeT0[e]
				outside = other < 0 || facetOf[other] !== fi
			}
			if (!outside) continue
			const a = topo.weld[topo.idx[t * 3 + k]]
			const b = topo.weld[topo.idx[t * 3 + ((k + 1) % 3)]]
			if (a === b) continue
			// Two outgoing border edges at one vertex means the border pinches through
			// it, and the walk below cannot be disambiguated. Abandon the border rather
			// than run a rivet line along a path that crosses itself.
			if (next.has(a)) return new Float32Array(0)
			next.set(a, b)
		}
	}
	if (next.size < 3) return new Float32Array(0)

	let bestLen = -1
	let best: number[] | null = null
	const seen = new Set<number>()
	const loop: number[] = []
	for (const start of next.keys()) {
		if (seen.has(start)) continue
		loop.length = 0
		let v = start
		let guard = next.size + 1
		while (guard-- > 0) {
			if (seen.has(v)) break
			seen.add(v)
			loop.push(v)
			const nv = next.get(v)
			if (nv === undefined) break
			v = nv
			if (v === start) break
		}
		if (v !== start || loop.length < 3) continue
		let len = 0
		for (let i = 0; i < loop.length; i++) {
			const p = topo.rep[loop[i]] * 3
			const q = topo.rep[loop[(i + 1) % loop.length]] * 3
			len += Math.hypot(topo.pos[q] - topo.pos[p], topo.pos[q + 1] - topo.pos[p + 1], topo.pos[q + 2] - topo.pos[p + 2])
		}
		// The longest loop is the outer boundary; the rest are holes, which get no
		// rivets — a bolt line around a hole reads as a second, phantom panel.
		if (len > bestLen) {
			bestLen = len
			best = loop.slice()
		}
	}
	if (!best) return new Float32Array(0)

	const out = new Float32Array(best.length * 2)
	for (let i = 0; i < best.length; i++) {
		const p = topo.rep[best[i]] * 3
		const dx = topo.pos[p] - o[0]
		const dy = topo.pos[p + 1] - o[1]
		const dz = topo.pos[p + 2] - o[2]
		out[i * 2] = dx * tu[0] + dy * tu[1] + dz * tu[2]
		out[i * 2 + 1] = dx * tv[0] + dy * tv[1] + dz * tv[2]
	}
	return out
}

/** Descending by area, index-tiebroken so the order is a function of the mesh alone. */
function facetsByArea(facets: Facet[]): Int32Array {
	const order = new Array<number>(facets.length)
	for (let i = 0; i < facets.length; i++) order[i] = i
	order.sort((a, b) => facets[b].area - facets[a].area || a - b)
	return Int32Array.from(order)
}

function pointInFacet(f: Facet, u: number, v: number): boolean {
	const uv = f.uv
	for (let i = 0; i < f.tris.length; i++) {
		const b = i * 6
		const ax = uv[b], ay = uv[b + 1]
		const bx = uv[b + 2], by = uv[b + 3]
		const cx = uv[b + 4], cy = uv[b + 5]
		const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
		// A degenerate triangle passes the sign test trivially and would report every
		// point in the plane as inside, so it is skipped outright.
		if (cross > -1e-12 && cross < 1e-12) continue
		const d0 = (u - ax) * (by - ay) - (v - ay) * (bx - ax)
		const d1 = (u - bx) * (cy - by) - (v - by) * (cx - bx)
		const d2 = (u - cx) * (ay - cy) - (v - cy) * (ax - cx)
		const neg = d0 < 0 || d1 < 0 || d2 < 0
		const pos = d0 > 0 || d1 > 0 || d2 > 0
		if (!(neg && pos)) return true
	}
	return false
}

/** Corners plus centre. Cheap, and enough to reject a plate hanging off a facet edge. */
function rectInFacet(f: Facet, u0: number, v0: number, u1: number, v1: number): boolean {
	return pointInFacet(f, u0, v0) && pointInFacet(f, u1, v0) &&
		pointInFacet(f, u1, v1) && pointInFacet(f, u0, v1) &&
		pointInFacet(f, (u0 + u1) * 0.5, (v0 + v1) * 0.5)
}

/** Facet (u, v, height) → world. */
function facetPoint(f: Facet, u: number, v: number, h: number, out: Vec3): Vec3 {
	out[0] = f.o[0] + f.tu[0] * u + f.tv[0] * v + f.n[0] * h
	out[1] = f.o[1] + f.tu[1] * u + f.tv[1] * v + f.n[1] * h
	out[2] = f.o[2] + f.tu[2] * u + f.tv[2] * v + f.n[2] * h
	return out
}

/** In-plane unit direction from facet-space components. */
function facetDir(f: Facet, du: number, dv: number, out: Vec3): Vec3 {
	out[0] = f.tu[0] * du + f.tv[0] * dv
	out[1] = f.tu[1] * du + f.tv[1] * dv
	out[2] = f.tu[2] * du + f.tv[2] * dv
	return v3.normalize(out, out)
}

// ---------------------------------------------------------------------------
// Feature geometry
// ---------------------------------------------------------------------------

/**
 * One rectangular plate, proud: a base ring on the surface, a rim ring inset by `bevel`
 * at `height`, four chamfer quads and a cap. 10 triangles.
 *
 * A negative height inverts the relief into a pan, which is what lets one pass serve
 * bolted steel plate and printed ceramic tile. The inversion is *not* a mirror of the
 * construction about the surface: this pass never opens the skin, so a pan built by
 * sinking the cap below it is sealed inside the solid and renders as nothing. The pan is
 * built the only way an additive pass can build one — a rim wall standing |height| proud
 * of the surface, a chamfer running back down inside it, and a floor on the surface
 * itself. 18 triangles: 8 rim wall, 8 chamfer, 2 floor.
 */
function plate4(mesh: Mesh, f: Facet, u0: number, v0: number, u1: number, v1: number,
	height: number, bevel: number, zone: number, invUv: number, budget: TriBudget): number {
	const bu = Math.min(bevel, (u1 - u0) * 0.35)
	const bv = Math.min(bevel, (v1 - v0) * 0.35)
	facetPoint(f, (u0 + u1) * 0.5, (v0 + v1) * 0.5, 0, sv.o)

	if (height >= 0) {
		if (!budget.take(10)) return 0
		setRect(ringA, f, u0, v0, u1, v1, LIFT)
		setRect(ringB, f, u0 + bu, v0 + bv, u1 - bu, v1 - bv, height + LIFT)
		skirt(mesh, ringA, ringB, 4, sv.o, 1, zone, invUv)
		polygon(mesh, ringB, 4, f.n, zone, invUv)
		return 10
	}

	if (!budget.take(18)) return 0
	setRect(ringA, f, u0, v0, u1, v1, LIFT)
	setRect(ringB, f, u0, v0, u1, v1, LIFT - height)
	setRect(ringC, f, u0 + bu, v0 + bv, u1 - bu, v1 - bv, LIFT)
	skirt(mesh, ringA, ringB, 4, sv.o, 1, zone, invUv)
	skirt(mesh, ringB, ringC, 4, sv.o, -1, zone, invUv)
	polygon(mesh, ringC, 4, f.n, zone, invUv)
	return 18
}

/**
 * Hex tiling of a facet. A proud tile is 16 triangles: 6 chamfer quads plus a
 * 4-triangle cap. A sunk tile — the Lattice's ceramic-in-a-frame — is 28: 6 rim wall
 * quads, 6 chamfer quads and a 4-triangle floor, because the recess is realised as a
 * raised rim on an unopened skin rather than as a hole in it. See plate4.
 */
function hexPanels(mesh: Mesh, r: Rng, f: Facet, radius: number, gap: number, height: number,
	bevel: number, heightJitter: number, skipChance: number, zone: number, invUv: number,
	budget: TriBudget): number {
	const rad = Math.max(1e-3, radius)
	const sx = Math.sqrt(3) * rad
	const sy = 1.5 * rad
	const cols = Math.ceil((f.u1 - f.u0) / sx) + 2
	const rows = Math.ceil((f.v1 - f.v0) / sy) + 2
	const inner = Math.max(1e-4, rad - gap * 0.5)
	const proud = height >= 0
	let placed = 0

	for (let j = 0; j < rows; j++) {
		const cv = f.v0 + j * sy
		const rowOff = (j & 1) === 0 ? 0 : sx * 0.5
		for (let i = 0; i < cols; i++) {
			const cu = f.u0 + i * sx + rowOff - sx * 0.5
			if (r.bool(skipChance)) continue
			// Test the inscribed square rather than the circumradius: cheaper, and it
			// keeps tiles clear of the facet edge instead of flush against it.
			if (!rectInFacet(f, cu - inner, cv - inner, cu + inner, cv + inner)) continue
			if (!budget.take(proud ? 16 : 28)) return placed
			// Per-tile radius and height wobble. A hex grid is a repeat by construction,
			// and a repeat is exactly what §9 forbids; the frame between tiles stays
			// straight, the tiles themselves do not.
			const tr = inner * (1 + r.signed(0.04))
			const hh = height * (1 + r.signed(heightJitter))
			const ir = Math.max(1e-4, tr - bevel)
			facetPoint(f, cu, cv, 0, sv.o)
			if (proud) {
				setHex(ringA, f, cu, cv, tr, Math.PI / 6, LIFT)
				setHex(ringB, f, cu, cv, ir, Math.PI / 6, hh + LIFT)
				skirt(mesh, ringA, ringB, 6, sv.o, 1, zone, invUv)
				polygon(mesh, ringB, 6, f.n, zone, invUv)
			} else {
				setHex(ringA, f, cu, cv, tr, Math.PI / 6, LIFT)
				setHex(ringB, f, cu, cv, tr, Math.PI / 6, LIFT - hh)
				setHex(ringC, f, cu, cv, ir, Math.PI / 6, LIFT)
				skirt(mesh, ringA, ringB, 6, sv.o, 1, zone, invUv)
				skirt(mesh, ringB, ringC, 6, sv.o, -1, zone, invUv)
				polygon(mesh, ringC, 6, f.n, zone, invUv)
			}
			placed++
		}
	}
	return placed
}

/**
 * A rectangular opening with a raised coaming and a floor — the shared body of a hatch
 * and of a vent. 26 triangles: coaming outer wall 8, lip top ring 8, recess wall 8,
 * floor 2.
 *
 * The recess is measured DOWN FROM THE RIM, not down from the hull: the floor sits on
 * the host surface and the coaming stands `depth + lipHeight` proud of it. Sinking the
 * floor to −depth instead puts it, and the whole recess wall, inside the solid behind a
 * skin this pass never opens — 10 of a hatch's 26 triangles paid for and invisible, and
 * an opening that shows flat hull. Relief is relative, so raising the surround reads the
 * same and is the only form an additive pass can actually deliver.
 */
function frame(mesh: Mesh, f: Facet, cu: number, cv: number, hw: number, hh: number,
	lipWidth: number, lipHeight: number, depth: number, zone: number, invUv: number): void {
	const ou = hw + lipWidth
	const ov = hh + lipWidth
	const rim = Math.max(LIFT, depth) + lipHeight
	facetPoint(f, cu, cv, 0, sv.o)

	// Outer wall: surface up to the lip top.
	setRect(ringA, f, cu - ou, cv - ov, cu + ou, cv + ov, LIFT)
	setRect(ringB, f, cu - ou, cv - ov, cu + ou, cv + ov, rim)
	skirt(mesh, ringA, ringB, 4, sv.o, 1, zone, invUv)

	// Lip top, outer ring to inner ring, both at lip height. Referenced against +n so
	// the ring faces the sky rather than sideways.
	setRect(ringC, f, cu - hw, cv - hh, cu + hw, cv + hh, rim)
	ringQuads(mesh, ringB, ringC, 4, f.n, true, zone, invUv)

	// Recess wall: lip inner edge down to the floor. Faces the opening's interior.
	setRect(ringA, f, cu - hw, cv - hh, cu + hw, cv + hh, LIFT)
	skirt(mesh, ringC, ringA, 4, sv.o, -1, zone, invUv)

	polygon(mesh, ringA, 4, f.n, zone, invUv)
}

/**
 * A bolt head: base ring, tapered top ring, cap. 3·sides−2 triangles, or sides−2 flat.
 *
 * `base` is the height of the surface it is driven into — 0 on the hull, the rim height
 * on a hatch coaming. A fastener that assumed the hull would be buried inside the
 * coaming it is supposed to hold down.
 */
function stud(mesh: Mesh, f: Facet, u: number, v: number, radius: number, base: number,
	height: number, sides: number, rot: number, capOnly: boolean, zone: number, invUv: number): void {
	const n = Math.floor(clamp(sides, 3, MAX_SIDES))
	if (capOnly) {
		setRing(ringB, f, u, v, radius * 0.86, n, rot, base + height)
		polygon(mesh, ringB, n, f.n, zone, invUv)
		return
	}
	setRing(ringA, f, u, v, radius, n, rot, base + LIFT)
	setRing(ringB, f, u, v, radius * 0.72, n, rot, base + height)
	facetPoint(f, u, v, 0, sv.o)
	skirt(mesh, ringA, ringB, n, sv.o, 1, zone, invUv)
	polygon(mesh, ringB, n, f.n, zone, invUv)
}

/** Solid box from a centre and three half-extent vectors. 12 triangles. */
function box(mesh: Mesh, c: Vec3, ex: Vec3, ey: Vec3, ez: Vec3, zone: number, invUv: number): void {
	for (let axis = 0; axis < 3; axis++) {
		const a = axis === 0 ? ex : axis === 1 ? ey : ez
		const b = axis === 0 ? ey : axis === 1 ? ez : ex
		const d = axis === 0 ? ez : axis === 1 ? ex : ey
		for (let s = -1; s <= 1; s += 2) {
			v3.scale(ev.o, a, s)
			boxCorner(ev.a, c, ev.o, b, d, -1, -1)
			boxCorner(ev.b, c, ev.o, b, d, 1, -1)
			boxCorner(ev.c, c, ev.o, b, d, 1, 1)
			boxCorner(ev.d, c, ev.o, b, d, -1, 1)
			quad(mesh, ev.a, ev.b, ev.c, ev.d, ev.o, zone, invUv)
		}
	}
}

function boxCorner(out: Vec3, c: Vec3, a: Vec3, b: Vec3, d: Vec3, sb: number, sd: number): Vec3 {
	out[0] = c[0] + a[0] + b[0] * sb + d[0] * sd
	out[1] = c[1] + a[1] + b[1] * sb + d[1] * sd
	out[2] = c[2] + a[2] + b[2] * sb + d[2] * sd
	return out
}

// ---------------------------------------------------------------------------
// Weld bead sweep
// ---------------------------------------------------------------------------

function bumpDegree(deg: Map<number, number>, adj0: Map<number, number>,
	adj1: Map<number, number>, v: number, e: number): void {
	const d = (deg.get(v) ?? 0) + 1
	deg.set(v, d)
	if (d === 1) adj0.set(v, e)
	else if (d === 2) adj1.set(v, e)
}

/** Walk a chain of candidate edges from `start` along `first`, consuming edges as it goes. */
function walkPath(topo: Topology, isCand: Uint8Array, visited: Uint8Array, deg: Map<number, number>,
	adj0: Map<number, number>, adj1: Map<number, number>, start: number, first: number,
	out: number[]): void {
	out.length = 0
	out.push(start)
	let v = start
	let e = first
	for (;;) {
		if (visited[e]) break
		visited[e] = 1
		const w = topo.edgeA[e] === v ? topo.edgeB[e] : topo.edgeA[e]
		out.push(w)
		if (w === start) break
		// Degree 3+ is a junction of several seams. Stopping there and letting the other
		// branches start their own paths is correct: a real weld terminates at a
		// junction, it does not arbitrarily pick one branch to continue along.
		if ((deg.get(w) ?? 0) !== 2) break
		const e0 = adj0.get(w)
		const e1 = adj1.get(w)
		const nx = e0 === e ? e1 : e0
		if (nx === undefined || !isCand[nx] || visited[nx]) break
		v = w
		e = nx
	}
}

/**
 * Sweep a half-round bead along one path. The profile is an arc running from one side of
 * the crease, over the bisector of the two faces, to the other side — so the bead's feet
 * sit on the surface and no cap is needed along its length, only at its two ends.
 */
function sweepBead(mesh: Mesh, topo: Topology, path: number[], px: Float32Array, pw: Float32Array,
	pz: Uint8Array, radius: number, heightScale: number, lumpiness: number, lumpScale: number,
	wobble: number, segLen: number, sides: number, minPathLength: number, noiseSeed: number,
	zoneOpt: number | null, invUv: number, budget: TriBudget): number {
	const pn = Math.min(path.length, px.length / 3 | 0)
	if (pn < 2) return 0
	const closed = path[0] === path[pn - 1] && pn > 3

	let total = 0
	for (let i = 0; i < pn; i++) {
		const rep = topo.rep[path[i]]
		const p = rep * 3
		px[i * 3] = topo.pos[p]
		px[i * 3 + 1] = topo.pos[p + 1]
		px[i * 3 + 2] = topo.pos[p + 2]
		pw[i * 3] = 0
		pw[i * 3 + 1] = 0
		pw[i * 3 + 2] = 0
		// Seeded from the path vertex itself so a vertex whose crease edge went missing
		// still inherits something local, never a stale zone left by the previous path.
		pz[i] = topo.zone[rep]
		if (i > 0) {
			total += Math.hypot(px[i * 3] - px[i * 3 - 3], px[i * 3 + 1] - px[i * 3 - 2],
				px[i * 3 + 2] - px[i * 3 - 1])
		}
	}
	if (total < minPathLength) return 0

	// Outward direction per path vertex: the bisector of the two faces meeting at each
	// incident crease, summed. That is the direction a real bead of filler sits in.
	// The host zone rides along in the same walk — the bead belongs to whatever it runs
	// across, so it is read off the faces that make the crease and can change part-way
	// along a seam that crosses a panel boundary.
	for (let i = 0; i + 1 < pn; i++) {
		const e = edgeBetween(topo, path[i], path[i + 1])
		if (e < 0) continue
		if (zoneOpt === null) {
			const z = edgeHostZone(topo, e)
			pz[i] = z
			if (i + 2 === pn) pz[i + 1] = z
		}
		const t0 = topo.edgeT0[e]
		const t1 = topo.edgeT1[e]
		if (t1 < 0) continue
		for (let k = 0; k < 2; k++) {
			const j = i + k
			pw[j * 3] += topo.triN[t0 * 3] + topo.triN[t1 * 3]
			pw[j * 3 + 1] += topo.triN[t0 * 3 + 1] + topo.triN[t1 * 3 + 1]
			pw[j * 3 + 2] += topo.triN[t0 * 3 + 2] + topo.triN[t1 * 3 + 2]
		}
	}
	if (closed) {
		// First and last are the same vertex. Without this the bead visibly kinks where
		// the loop closes, because each end saw only one of its two incident creases.
		const last = (pn - 1) * 3
		for (let k = 0; k < 3; k++) {
			const s = pw[k] + pw[last + k]
			pw[k] = s
			pw[last + k] = s
		}
	}

	const segs = Math.max(1, Math.round(total / segLen))
	const step = total / segs
	const ringCount = sides + 1
	const perSeg = sides * 2
	let emitted = 0

	let zone = zoneOpt ?? pz[0]
	for (let s = 0; s <= segs; s++) {
		if (closed && s === segs) {
			// Stitch the last ring back to the first instead of resampling a duplicate.
			if (budget.take(perSeg)) {
				ringQuads(mesh, ringB, ringC, ringCount, null, false, zone, invUv)
				emitted++
			}
			break
		}
		const arc = s * step
		const near = sampleBead(px, pw, pn, arc, sv.a, sv.b, sv.c)
		if (zoneOpt === null) zone = pz[near]
		const t = arc / lumpScale
		const lump = 1 + lumpiness * (noise1(noiseSeed, t) * 2 - 1)
		const rr = Math.max(1e-4, radius * lump)
		// Lateral wander: a hand-laid bead does not track its crease exactly, and a
		// perfectly centred bead is the clearest possible tell that geometry was swept.
		const off = wobble * rr * (noise1(noiseSeed ^ 0x1f83d9ab, t * 0.7 + 11.3) * 2 - 1)
		beadRing(ringA, sv.a, sv.b, sv.c, rr, radius * heightScale * lump, off, sides)

		if (s === 0) {
			ringC.set(ringA.subarray(0, ringCount * 3))
			if (!closed && budget.take(sides - 1)) {
				// Start cap, referenced back down the path so it faces out of the bead.
				v3.scale(ev.o, sv.b, -1)
				polygon(mesh, ringA, ringCount, ev.o, zone, invUv)
			}
		} else {
			if (!budget.take(perSeg)) break
			ringQuads(mesh, ringB, ringA, ringCount, null, false, zone, invUv)
			emitted++
			if (!closed && s === segs && budget.take(sides - 1)) {
				polygon(mesh, ringA, ringCount, sv.b, zone, invUv)
			}
		}
		ringB.set(ringA.subarray(0, ringCount * 3))
	}
	return emitted
}

/**
 * Position, tangent and outward direction at arclength `s` along the polyline. Returns
 * the index of the nearest path vertex, which is what the per-sample host zone is read
 * from — recovering it any other way would mean walking the arclength twice.
 */
function sampleBead(px: Float32Array, pw: Float32Array, pn: number, s: number,
	pos: Vec3, tan: Vec3, up: Vec3): number {
	let acc = 0
	let i = 0
	let len = 0
	for (; i + 1 < pn; i++) {
		len = Math.hypot(px[i * 3 + 3] - px[i * 3], px[i * 3 + 4] - px[i * 3 + 1], px[i * 3 + 5] - px[i * 3 + 2])
		if (acc + len >= s || i + 2 === pn) break
		acc += len
	}
	const t = len > 1e-9 ? clamp((s - acc) / len, 0, 1) : 0
	const near = t < 0.5 ? i : i + 1
	const a = i * 3
	const b = a + 3
	pos[0] = lerp(px[a], px[b], t)
	pos[1] = lerp(px[a + 1], px[b + 1], t)
	pos[2] = lerp(px[a + 2], px[b + 2], t)
	v3.set(tan, px[b] - px[a], px[b + 1] - px[a + 1], px[b + 2] - px[a + 2])
	v3.normalize(tan, tan)
	v3.set(up, lerp(pw[a], pw[b], t), lerp(pw[a + 1], pw[b + 1], t), lerp(pw[a + 2], pw[b + 2], t))
	if (v3.lenSq(up) < 1e-12) v3.set(up, 0, 0, 1)
	v3.normalize(up, up)
	// Re-orthogonalise so the profile stays square to the path even where the two faces
	// meeting at the crease are wildly asymmetric.
	v3.cross(sv.r, tan, up)
	if (v3.lenSq(sv.r) < 1e-12) return near
	v3.normalize(sv.r, sv.r)
	v3.cross(up, sv.r, tan)
	v3.normalize(up, up)
	return near
}

/** Half-round cross-section, from −side, over +up, to +side. */
function beadRing(ring: Float32Array, pos: Vec3, tan: Vec3, up: Vec3, radius: number,
	height: number, offset: number, sides: number): void {
	v3.normalize(sv.d, v3.cross(sv.d, tan, up))
	for (let k = 0; k <= sides; k++) {
		const a = (Math.PI * k) / sides
		const c = -Math.cos(a) * radius + offset
		const h = Math.sin(a) * height
		ring[k * 3] = pos[0] + sv.d[0] * c + up[0] * h
		ring[k * 3 + 1] = pos[1] + sv.d[1] * c + up[1] * h
		ring[k * 3 + 2] = pos[2] + sv.d[2] * c + up[2] * h
	}
}

// ---------------------------------------------------------------------------
// Ring builders — all in facet space, all writing into the shared ring buffers
// ---------------------------------------------------------------------------

function setRect(ring: Float32Array, f: Facet, u0: number, v0: number, u1: number, v1: number, h: number): void {
	writeRing(ring, 0, f, u0, v0, h)
	writeRing(ring, 1, f, u1, v0, h)
	writeRing(ring, 2, f, u1, v1, h)
	writeRing(ring, 3, f, u0, v1, h)
}

function setHex(ring: Float32Array, f: Facet, cu: number, cv: number, rad: number, rot: number, h: number): void {
	for (let k = 0; k < 6; k++) {
		const a = rot + (k * Math.PI) / 3
		writeRing(ring, k, f, cu + Math.cos(a) * rad, cv + Math.sin(a) * rad, h)
	}
}

function setRing(ring: Float32Array, f: Facet, cu: number, cv: number, rad: number,
	sides: number, rot: number, h: number): void {
	for (let k = 0; k < sides; k++) {
		const a = rot + (k * Math.PI * 2) / sides
		writeRing(ring, k, f, cu + Math.cos(a) * rad, cv + Math.sin(a) * rad, h)
	}
}

function writeRing(ring: Float32Array, i: number, f: Facet, u: number, v: number, h: number): void {
	ring[i * 3] = f.o[0] + f.tu[0] * u + f.tv[0] * v + f.n[0] * h
	ring[i * 3 + 1] = f.o[1] + f.tu[1] * u + f.tv[1] * v + f.n[1] * h
	ring[i * 3 + 2] = f.o[2] + f.tu[2] * u + f.tv[2] * v + f.n[2] * h
}

// ---------------------------------------------------------------------------
// Emit — the only code in this file that writes to a Mesh
// ---------------------------------------------------------------------------

/**
 * Closed quad strip between two rings, wound so the faces point away from `centre`
 * scaled by `outward`: +1 for a proud wall, −1 for the inside of a recess.
 */
function skirt(mesh: Mesh, a: Float32Array, b: Float32Array, count: number, centre: Vec3,
	outward: number, zone: number, invUv: number): void {
	for (let i = 0; i < count; i++) {
		const j = (i + 1) % count
		readRing(ev.a, a, i)
		readRing(ev.b, a, j)
		readRing(ev.c, b, j)
		readRing(ev.d, b, i)
		ev.o[0] = ((ev.a[0] + ev.b[0]) * 0.5 - centre[0]) * outward
		ev.o[1] = ((ev.a[1] + ev.b[1]) * 0.5 - centre[1]) * outward
		ev.o[2] = ((ev.a[2] + ev.b[2]) * 0.5 - centre[2]) * outward
		quad(mesh, ev.a, ev.b, ev.c, ev.d, ev.o, zone, invUv)
	}
}

/**
 * Quad strip between two rings. `outRef` null derives each quad's facing from the strip's
 * own centroid, which is what a swept bead needs — its rings rotate along the path and
 * have no fixed centre to reference.
 */
function ringQuads(mesh: Mesh, a: Float32Array, b: Float32Array, count: number,
	outRef: Vec3 | null, closed: boolean, zone: number, invUv: number): void {
	let cx = 0, cy = 0, cz = 0
	if (!outRef) {
		for (let i = 0; i < count; i++) {
			cx += (a[i * 3] + b[i * 3]) * 0.5
			cy += (a[i * 3 + 1] + b[i * 3 + 1]) * 0.5
			cz += (a[i * 3 + 2] + b[i * 3 + 2]) * 0.5
		}
		cx /= count
		cy /= count
		cz /= count
	}
	const last = closed ? count : count - 1
	for (let i = 0; i < last; i++) {
		const j = (i + 1) % count
		readRing(ev.a, a, i)
		readRing(ev.b, a, j)
		readRing(ev.c, b, j)
		readRing(ev.d, b, i)
		if (outRef) v3.copy(ev.o, outRef)
		else {
			ev.o[0] = (ev.a[0] + ev.b[0] + ev.c[0] + ev.d[0]) * 0.25 - cx
			ev.o[1] = (ev.a[1] + ev.b[1] + ev.c[1] + ev.d[1]) * 0.25 - cy
			ev.o[2] = (ev.a[2] + ev.b[2] + ev.c[2] + ev.d[2]) * 0.25 - cz
		}
		quad(mesh, ev.a, ev.b, ev.c, ev.d, ev.o, zone, invUv)
	}
}

/** Convex polygon as a fan from corner 0. count−2 triangles, vertices shared. */
function polygon(mesh: Mesh, ring: Float32Array, count: number, outRef: Vec3, zone: number, invUv: number): void {
	if (count < 3) return
	// Newell's method: correct for a slightly non-planar ring, where a single corner
	// cross product is not.
	let nx = 0, ny = 0, nz = 0
	for (let i = 0; i < count; i++) {
		const j = (i + 1) % count
		nx += (ring[i * 3 + 1] - ring[j * 3 + 1]) * (ring[i * 3 + 2] + ring[j * 3 + 2])
		ny += (ring[i * 3 + 2] - ring[j * 3 + 2]) * (ring[i * 3] + ring[j * 3])
		nz += (ring[i * 3] - ring[j * 3]) * (ring[i * 3 + 1] + ring[j * 3 + 1])
	}
	const l = Math.hypot(nx, ny, nz)
	if (l < 1e-14) return
	v3.set(ev.n, nx / l, ny / l, nz / l)
	const flip = v3.dot(ev.n, outRef) < 0
	if (flip) v3.scale(ev.n, ev.n, -1)

	// reserve() takes absolute capacity, not a delta.
	mesh.reserve(mesh.vertexCount + count, mesh.triangleCount + count - 2)
	const base = mesh.vertexCount
	for (let i = 0; i < count; i++) {
		readRing(ev.a, ring, i)
		pushVert(mesh, ev.a, ev.n, invUv, zone)
	}
	for (let i = 1; i + 1 < count; i++) {
		if (flip) mesh.addTriangle(base, base + i + 1, base + i)
		else mesh.addTriangle(base, base + i, base + i + 1)
	}
}

/** Flat-shaded quad. Four fresh vertices — hard-surface greeble never shares a normal. */
function quad(mesh: Mesh, a: Vec3, b: Vec3, c: Vec3, d: Vec3, outRef: Vec3, zone: number, invUv: number): void {
	// Normal from the diagonals, which stays correct on a slightly warped quad where a
	// corner-edge cross product does not.
	v3.sub(ev.e0, c, a)
	v3.sub(ev.e1, d, b)
	v3.cross(ev.n, ev.e0, ev.e1)
	if (v3.lenSq(ev.n) < 1e-20) return
	v3.normalize(ev.n, ev.n)
	const flip = v3.dot(ev.n, outRef) < 0
	if (flip) v3.scale(ev.n, ev.n, -1)

	mesh.reserve(mesh.vertexCount + 4, mesh.triangleCount + 2)
	const i0 = pushVert(mesh, a, ev.n, invUv, zone)
	const i1 = pushVert(mesh, b, ev.n, invUv, zone)
	const i2 = pushVert(mesh, c, ev.n, invUv, zone)
	const i3 = pushVert(mesh, d, ev.n, invUv, zone)
	if (flip) {
		mesh.addTriangle(i0, i2, i1)
		mesh.addTriangle(i0, i3, i2)
	} else {
		mesh.addTriangle(i0, i1, i2)
		mesh.addTriangle(i0, i2, i3)
	}
}

/**
 * Push one vertex with a box-projected UV and its material zone. §6.2 assigns real
 * per-zone UV projection elsewhere; this is the local fallback so emitted detail is never
 * left on a zero UV, which would collapse an entire greeble set onto one texel.
 */
function pushVert(mesh: Mesh, p: Vec3, n: Vec3, invUv: number, zone: number): number {
	const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2])
	let u: number, w: number
	if (ax >= ay && ax >= az) {
		u = p[1]
		w = p[2]
	} else if (ay >= az) {
		u = p[0]
		w = p[2]
	} else {
		u = p[0]
		w = p[1]
	}
	return mesh.addVertex(p[0], p[1], p[2], n[0], n[1], n[2], u * invUv, w * invUv, zone)
}

function readRing(out: Vec3, ring: Float32Array, i: number): Vec3 {
	out[0] = ring[i * 3]
	out[1] = ring[i * 3 + 1]
	out[2] = ring[i * 3 + 2]
	return out
}

// ---------------------------------------------------------------------------
// Hash noise
// ---------------------------------------------------------------------------

/**
 * Integer hash → [0,1). Seeded out of a pass's Rng fork, so output stays a pure function
 * of the asset seed. It exists because bead thickness and wear depth must be *spatially*
 * coherent: an Rng draw per sample is white noise, and a bead modulated by white noise
 * reads as a jagged crust rather than as weld.
 */
function hash1(seed: number, i: number): number {
	let h = (seed ^ Math.imul(i, 0x27d4eb2d)) >>> 0
	h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function hash3(seed: number, i: number, j: number, k: number): number {
	let h = (seed ^ Math.imul(i, 0x8da6b343) ^ Math.imul(j, 0xd8163841) ^ Math.imul(k, 0xcb1ab31f)) >>> 0
	h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function noise1(seed: number, x: number): number {
	const i = Math.floor(x)
	const f = x - i
	return lerp(hash1(seed, i), hash1(seed, i + 1), f * f * (3 - 2 * f))
}

function noise3(seed: number, x: number, y: number, z: number): number {
	const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z)
	const fx = x - ix, fy = y - iy, fz = z - iz
	const tx = fx * fx * (3 - 2 * fx)
	const ty = fy * fy * (3 - 2 * fy)
	const tz = fz * fz * (3 - 2 * fz)
	const c00 = lerp(hash3(seed, ix, iy, iz), hash3(seed, ix + 1, iy, iz), tx)
	const c10 = lerp(hash3(seed, ix, iy + 1, iz), hash3(seed, ix + 1, iy + 1, iz), tx)
	const c01 = lerp(hash3(seed, ix, iy, iz + 1), hash3(seed, ix + 1, iy, iz + 1), tx)
	const c11 = lerp(hash3(seed, ix, iy + 1, iz + 1), hash3(seed, ix + 1, iy + 1, iz + 1), tx)
	return lerp(lerp(c00, c10, ty), lerp(c01, c11, ty), tz)
}
