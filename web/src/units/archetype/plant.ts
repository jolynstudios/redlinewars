// STEELSEED — units/archetype/plant
//
// Production, economy and tech structures. The largest objects on screen, seen static and up
// close for the whole match, which makes them the buildings that set the visual tone — and
// `web/src/structures/` does not exist, so this family is the first geometry the game has for
// any of them.
//
// The functional data available for a structure is different from a vehicle's and drives
// different things (§14.13):
//
//   footprint (length x width)  ->  plan mass, plinth, apron
//   Power.Amount  > 0           ->  generation: stacks, cooling banks
//   Power.Amount  < 0           ->  consumption: service head, cable trunk
//   HP per plan area            ->  wall thickness, and whether it reads cast or framed
//   cost                        ->  greeble budget, i.e. visible complexity
//   BuildDuration               ->  construction stages
//
// Returns an `Sdf` rather than a mesh, deliberately. `geo/spline`'s extrude/shell/loft path
// is the better tool for a real building shell and it is still unexecuted — but it produces a
// `Mesh` directly, which would fork the pipeline and put this family outside `rostergate`'s
// silhouette rasteriser. One pipeline and one gate is worth more right now than a better
// shell; the spline path is the §14.11 build-time upgrade, where the cost of a second path
// is paid once offline rather than per boot.
//
// Model space per §12.4: Y up, X forward, Z lateral. Every axial primitive in geo stands
// along Z, so an upright stack is `rotateX(cylinder, PI/2)` — `rotateZ` would be a no-op
// (rulecheck 12.4a).

import * as sdf from '../../geo/sdf'
import { Zone, type ZoneRegion } from '../../geo/zone'
import type { Rng } from '../../core'
import type { ChassisParams } from './params'

/** Upright cylinder in render space. The rotation every stack, tank and silo needs. */
function upright(radius: number, halfHeight: number): sdf.Sdf {
	return sdf.rotateX(sdf.cylinder(radius, halfHeight), Math.PI * 0.5)
}

export function buildPlantStructure(p: ChassisParams, rng: Rng, zones?: ZoneRegion[]): sdf.Sdf {
	const halfLen = p.lengthM * 0.5
	const halfWid = p.widthM * 0.5
	const k = p.op.joinRadius
	// These are source regions for the FINISHED welded mesh. Roof machinery remains part of
	// the same SDF and the same draw; the region trees only say which material its vertices
	// sample after meshing.
	const machineryRegions: sdf.Sdf[] = []
	const exhaustRegions: sdf.Sdf[] = []
	const opticRegions: sdf.Sdf[] = []

	// Height is SUBLINEAR in plan area. A 5x5 depot must not generate as a tower just
	// because it is large — real industrial buildings get wider far faster than they get
	// taller, and a linear rule makes a base look like a skyline.
	const planCells = Math.max(p.lengthM * p.widthM, 1)
	// Industrial buildings are WIDE. The first curve gave a 3x3 depot 4.2 m of eaves and,
	// once roof and stacks were stacked on top, a 2.5:1 height-to-width tower — the contact
	// sheet showed a row of chess pieces rather than a base. Halved the coefficient and
	// dropped the constant; a 3x3 now reads about 2.7 m to the eaves.
	//
	// Plan area alone gave 7 distinct eaves heights across the 16 plants, while plateMm — HP
	// per square metre, the same fact expressed as construction — gives 16 distinct values.
	// The generator was reading its richest signal and spending it on a column radius, so the
	// contact sheet showed one building repeated at three sizes, which is exactly the failure
	// plan risk 1 describes and which rostergate could not report because it was reading zero
	// slots.
	//
	// The rule is the one real construction follows: mass per unit area buys THICKNESS, not
	// height. A heavily built structure is squat and bunkered over its plan; a lightly built
	// one is a taller shed over the same plan. So toughness LOWERS the eaves, and it does so
	// on top of the area curve rather than replacing it — a big building is still wide first.
	const stout = Math.min(1, Math.max(0, (p.plateMm - 6) / 34))

	// --- massing archetype ---------------------------------------------------
	//
	// Proportion alone was not enough. Varying the height of one box gave 16 distinct
	// buildings that still read as one building, because a shape LANGUAGE is not a set of
	// proportions — a silo and a machine hall differ in what they ARE, not in how tall the
	// same box is. These are the four things an industrial site is actually made of, and each
	// falls out of function without a single actor name:
	//
	//   yard   large plan, lowest mass per area. An open compound: low walls, no roof over
	//          most of it, gantries. trackyard and frameyard, plan 12 m2 at 517 and 467 HP/m2,
	//          the two lowest on the roster.
	//   stack  it MAKES power. Verticality is the whole point; flues carry the silhouette.
	//   hall   deep in the build tree, so it produces something big. Long-span shed, ridge
	//          roof, one large door — the form a production hall has for the reason it has it.
	//   silo   everything else. Storage and service: closed, round, no door, tallest per m2.
	//
	// Priority matters where they overlap: a large plan is a yard even if it draws power, and
	// a generator is a stack even if it sits deep in the tree. Ordered most-specific first.
	//
	// HALL now asks whether the building PRODUCES, which is what its own description above
	// always claimed ("deep in the build tree, SO IT PRODUCES SOMETHING BIG"). It could not ask
	// until 2026-08-06 because the fact never reached the generator — the exporter read
	// `ProductionQueueInfo`, a trait that lives on the player actor rather than on the factory,
	// so all 97 actors reported that they produce nothing and `buildStages >= 5` stood in as a
	// proxy for it. Build duration correlates with production; it is not production. That
	// substitution is the whole reason `lattice_extruder` and `lattice_reservoir` — a factory
	// that makes infantry and a tank that holds 5000 resources — came out as the same building.
	const YARD = 0, STACK = 1, HALL = 2, SILO = 3
	const massing = planCells >= 10 ? YARD
		: p.powerAmount > 0 ? STACK
			: p.produces > 0 ? HALL
				: SILO

	/**
	 * How full a silo is of the thing it exists to hold, against a committed anchor.
	 *
	 * 5000 in RESOURCE UNITS — the same units as the field — and deliberately not fitted to
	 * today's roster, on the same reasoning as `BREAKPOINTS`: fitting it would move every
	 * existing silo's proportions the moment the mod added a bigger one.
	 */
	const storeFill = Math.min(Math.max(p.storageCapacity, 0) / 5000, 1)

	// Each archetype has its own height rule, because that is most of what distinguishes them
	// at RTS zoom. Toughness still lowers the eaves within an archetype (mass per unit area
	// buys thickness, not height), so the two axes compose instead of overwriting each other.
	// A silo's height now tracks WHAT IT HOLDS. Storage is the one massing archetype whose
	// defining quantity is a volume, so a 5000-unit reservoir standing exactly as tall as a
	// service shed that holds nothing was the archetype refusing to use its own axis.
	const massingHeight = massing === YARD ? 0.62 : massing === STACK ? 1.24 : massing === HALL ? 0.92
		: 1.14 + 0.32 * storeFill
	const eaves = (1.0 + 0.55 * Math.log2(planCells)) * (1.16 - 0.32 * stout) * massingHeight

	// --- plinth and apron ----------------------------------------------------
	// The apron is the `=` bib row in a MiniYAML footprint made visible: a thin poured slab
	// wider than the building, which is what stops a structure looking like it was dropped on
	// the terrain rather than built into it.
	// SUNK, not sitting. Both slabs used to start exactly at grade (y=0), which exposed
	// their vertical faces as bright square panels around every structure — glaring on a
	// slope, where the downhill side grows by the whole grade drop. Sinking each slab keeps
	// the poured-concrete read of the top surface while the sides stay underground.
	const apron = sdf.translate(
		sdf.roundBox(halfLen * 1.16, 0.045, halfWid * 1.16, 0.03),
		0, 0.02, 0,
	)
	const plinth = sdf.translate(
		sdf.roundBox(halfLen * 1.02, 0.16, halfWid * 1.02, p.bevelM * 3),
		0, 0.09, 0,
	)

	// --- main mass -----------------------------------------------------------
	// Built from the OCCUPANCY MASK, one block per occupied cell, not from a single box over
	// the bounding rectangle.
	//
	// This is the difference between two buildings of the same size being the same building
	// and being different ones. The mask already carries §9.1's faction contrast in the mod
	// data — every Foundry footprint is a solid rectangle, while the Lattice's are notched and
	// open, including a full ring at ["xxx","x_x","xxx"] — and reading only Dimensions threw
	// all of it away. `rostergate` caught the consequence directly: foundry_forge and
	// foundry_skyhook generated at IoU 1.0000.
	//
	// Wall thickness still reads through the bevel: a heavily built structure has deep
	// chamfers, a thin-walled shed crisp ones. Same number that drives a vehicle's armour, so
	// a tough building and a tough tank are visibly made of the same stuff.
	const bodyH = eaves * 0.5
	const mask = p.footprint
	let body: sdf.Sdf
	if (p.plan !== null && p.plan.length >= 3) {
		// --- authored plan ---------------------------------------------------
		//
		// Ten Lattice structures carry a hand-drawn six-point outline in the mod, as a
		// HitShape polygon. A person sat down and drew each one, and the generator has never
		// seen it: it read Building.Footprint — a mask of one-metre CELLS — and threw the
		// polygon away. That is the third piece of authored truth found with no consumer,
		// after TargetsAir and Warhead Versus, and the most valuable of the three, because
		// the other two are scalars and this is per-actor SHAPE.
		//
		// It also breaks the ceiling the footprint mask imposes. A cell grid can only express
		// so many plans before it repeats — 26 plants had 14 distinct masks, and four of them
		// shared one 3x3 square — whereas a polygon is off-grid and every one of these ten is
		// unique by construction.
		//
		// Built as a convex prism: one outward half-space per edge, intersected with a slab.
		// Convex is the honest limit of this construction and these outlines are convex; a
		// concave plan would need the mask path and should say so rather than silently
		// filling its notch. The shared helper also keeps vehicle and structure consumers from
		// acquiring subtly different winding or origin rules for the same authored field.
		//
		// The plan sets only the PLAN. Height, roof and the massing archetype's own character
		// still come from the rules below, so an authored outline and a derived elevation
		// compose instead of one overwriting the other.
		body = sdf.convexPlanPrism(
			p.plan,
			bodyH,
			0.32 + bodyH,
			halfLen * 1.6,
			halfWid * 1.6,
			p.bevelM * 5,
		)
	} else if (massing === SILO) {
		// A silo is ROUND, and that is the point: it is the one plan shape no other archetype
		// on the site uses, so it separates in silhouette from any angle and at any zoom
		// without depending on a detail surviving minification. Round because it stores
		// something under pressure or under its own weight, which is also why it is the
		// tallest per unit of plan.
		//
		// Paired vessels where the footprint is not square: two tanks read as capacity in a way
		// one fat tank does not, and it keeps the plan honest to the cells the sim reserved.
		const oblong = Math.abs(p.lengthM - p.widthM) > 0.4
		const rad = Math.min(halfLen, halfWid) * (oblong ? 0.62 : 0.92)
		// `upright`, not a raw cylinder: §12.4 stands the primitives along Z, and a bare
		// cylinder here would lie on its side. This is the axis bug that put a turret on edge.
		const drum = (dx: number, dz: number): sdf.Sdf => sdf.translate(
			upright(rad, bodyH), dx, 0.32 + bodyH, dz,
		)
		const along = p.lengthM >= p.widthM
		body = oblong
			? sdf.smoothUnion(
				drum(along ? halfLen * 0.34 : 0, along ? 0 : halfWid * 0.34),
				drum(along ? -halfLen * 0.34 : 0, along ? 0 : -halfWid * 0.34),
				k * 0.08,
			)
			: drum(0, 0)
		// A conical shoulder, so the drum terminates instead of being cut off flat.
		body = sdf.smoothUnion(body, sdf.translate(
			sdf.rotateX(sdf.cappedCone(rad * 0.98, rad * 0.66, bodyH * 0.30), Math.PI * 0.5),
			0, 0.32 + bodyH * 2 + bodyH * 0.30, 0,
		), k * 0.06)
	} else if (mask !== null && mask.length > 0) {
		const rows = mask.length
		const cols = Math.max(...mask.map(r => r.length))
		const cellL = p.lengthM / cols
		const cellW = p.widthM / rows
		const cells: sdf.Sdf[] = []
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				const ch = mask[r][c]
				// '_' is reserved-but-free and '=' is a bib row — neither is building mass.
				if (ch !== 'x' && ch !== 'X') continue
				// Blocks overlap slightly so a union of cells reads as one structure with a
				// notched plan, not as a pile of separate sheds.
				cells.push(sdf.translate(
					sdf.roundBox(cellL * 0.56, bodyH, cellW * 0.56, p.bevelM * 5),
					(c - (cols - 1) * 0.5) * cellL,
					0.32 + bodyH,
					(r - (rows - 1) * 0.5) * cellW,
				))
			}
		}
		body = cells.length > 0
			? sdf.union(...cells)
			: sdf.translate(sdf.roundBox(halfLen, bodyH, halfWid, p.bevelM * 5), 0, 0.32 + bodyH, 0)
	} else {
		body = sdf.translate(sdf.roundBox(halfLen, bodyH, halfWid, p.bevelM * 5), 0, 0.32 + bodyH, 0)
	}

	// --- the faction contrast, applied to ARCHITECTURE -----------------------
	// §9.1's contrast is "solid cast mass vs open bolted framework", and until now the
	// buildings did not express it at all: `joinRadius` only changes a fillet radius, which
	// cannot turn a solid box into a frame. Sixteen of the roster's forty-four actors are
	// buildings, and both factions' read identically on the contact sheet.
	//
	// The Lattice ships flat and bolts together on site, so its structures are a FRAME with
	// infill rather than a mass: corner columns, a roof band, and the plan mass shrunk back
	// inside them so the frame stands proud and daylight shows at the corners. The Foundry
	// is unchanged — it casts, so a solid mass is correct for it.
	//
	// Keyed on joinRadius rather than on a faction id, so a Foundry-operated exception (or a
	// third faction) gets the right architecture without this function knowing who it is.
	const framed = k < 1.0
	if (framed) {
		// Shrink the mass so the frame reads as structure standing outside a skin.
		body = sdf.scale(body, 0.90)
		const colR = 0.055 + 0.05 * (p.plateMm / 60)
		const colH = 0.32 + bodyH * 2
		const members: sdf.Sdf[] = []
		for (const sx of [-1, 1]) {
			for (const sz of [-1, 1]) {
				members.push(sdf.capsule(
					sx * halfLen * 0.98, 0.10, sz * halfWid * 0.98,
					sx * halfLen * 0.94, colH, sz * halfWid * 0.94,
					colR,
				))
			}
		}
		// Roof band tying the columns together. Four members, written directly on the axis
		// each one runs along, so there is no rotation to get wrong (rule 12.4a).
		const beam = colR * 0.85
		for (const sz of [-1, 1]) {
			members.push(sdf.translate(
				sdf.roundBox(halfLen * 0.98, beam, beam, beam * 0.4),
				0, colH, sz * halfWid * 0.94,
			))
		}
		for (const sx of [-1, 1]) {
			members.push(sdf.translate(
				sdf.roundBox(beam, beam, halfWid * 0.98, beam * 0.4),
				sx * halfLen * 0.94, colH, 0,
			))
		}
		// A mid-height girt on the long walls, which is what makes it read as a bolted frame
		// rather than as four posts.
		for (const sz of [-1, 1]) {
			members.push(sdf.translate(
				sdf.roundBox(halfLen * 0.96, beam * 0.7, beam * 0.7, beam * 0.3),
				0, 0.32 + bodyH, sz * halfWid * 0.94,
			))
		}
		body = sdf.union(body, ...members)
	}

	// Tech depth buys height and a second storey step. Two buildings with the SAME footprint
	// still differ if one sits deeper in the tree — which is the case foundry_forge and
	// foundry_skyhook needed, both being solid 3x3.
	/**
	 * The occupancy mask as a set of blocks at a given half-cell fraction, or null when there
	 * is no mask. Shared by the body and the roof so the two cannot disagree about the plan —
	 * which they did, and it cost the mask its visibility from the only angle that sees it.
	 */
	const maskCells = (frac: number, hy: number, y: number): sdf.Sdf | null => {
		if (mask === null || mask.length === 0) return null
		const rows = mask.length
		const cols = Math.max(...mask.map(r => r.length))
		const cellL = p.lengthM / cols
		const cellW = p.widthM / rows
		const out: sdf.Sdf[] = []
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				const ch = mask[r][c]
				if (ch !== 'x' && ch !== 'X') continue
				out.push(sdf.translate(
					sdf.roundBox(cellL * frac, hy, cellW * frac, p.bevelM * 3),
					(c - (cols - 1) * 0.5) * cellL, y, (r - (rows - 1) * 0.5) * cellW,
				))
			}
		}
		return out.length > 0 ? sdf.union(...out) : null
	}

	const roofH = eaves * (0.13 + 0.05 * Math.min(p.techDepth, 3))
	// The roof is the second thing that separates the archetypes, and unlike surface detail it
	// is on the SKYLINE, which is the part of a building that survives being 80 px tall.
	let roof: sdf.Sdf
	if (massing === HALL) {
		// A ridge, running the long axis. A production hall spans its width with trusses and
		// sheds water off a pitch, and a pitched roof is the single most recognisable industrial
		// profile there is. Built as a rotated box rather than a prism so the ridge line reads
		// from the side as well as from above.
		const along = p.lengthM >= p.widthM
		const span = along ? halfWid : halfLen
		const run = along ? halfLen : halfWid
		const pitch = sdf.rotateZ(sdf.roundBox(span * 0.80, span * 0.80, run * 0.92, p.bevelM * 2), Math.PI * 0.25)
		const ridge = sdf.translate(
			along ? sdf.rotateY(pitch, Math.PI * 0.5) : pitch,
			0, 0.32 + bodyH * 2 + roofH * 0.35, 0,
		)
		// A ridge is a single span by definition, so it is CLIPPED to the plan rather than
		// rebuilt from it. Two halls with different footprints previously differed only below
		// the eaves, where the camera cannot see — the ridge covered both plans identically.
		// Intersecting with a tall extrusion of the mask keeps the pitch honest and gives the
		// notch back at the skyline.
		const envelope = maskCells(0.52, eaves * 2, 0.32 + bodyH * 2)
		roof = envelope === null ? ridge : sdf.intersect(ridge, envelope)
	} else if (massing === YARD) {
		// A yard is mostly SKY. Two gantry beams over an open compound instead of a slab —
		// the thing that says "this is a place where work happens outdoors" and the reason
		// trackyard and frameyard stop reading as small warehouses.
		const beam = Math.max(0.07, halfWid * 0.075)
		const gantryY = 0.32 + bodyH * 2 + roofH * 1.7
		const beams: sdf.Sdf[] = []
		for (const sz of [-0.52, 0.52]) {
			beams.push(sdf.translate(sdf.roundBox(halfLen * 0.94, beam, beam * 1.3, beam * 0.4), 0, gantryY, sz * halfWid))
			for (const sx of [-0.86, 0.86]) {
				beams.push(sdf.translate(
					sdf.roundBox(beam * 0.8, roofH * 1.7, beam * 0.8, beam * 0.3),
					sx * halfLen, gantryY - roofH * 1.7, sz * halfWid,
				))
			}
		}
		// One cross beam, so the two gantries read as a single structure spanning the yard.
		beams.push(sdf.translate(sdf.roundBox(beam * 1.2, beam, halfWid * 0.56, beam * 0.4), 0, gantryY + beam, 0))
		roof = sdf.union(...beams)
	} else {
		// The roof FOLLOWS THE MASK. It did not, and that made the mask invisible.
		//
		// The body is carved from the occupancy mask cell by cell — and then a single solid box
		// was laid over the whole bounding rectangle, filling every notch straight back in. The
		// RTS camera looks DOWN at the roof, so the plan shape was hidden exactly where it
		// matters most, and §9.1's faction contrast is encoded in that plan: solid Foundry
		// rectangles against notched and ringed Lattice footprints.
		//
		// Cells at 0.49 rather than the body's 0.56, so roof cells ABUT instead of overlapping
		// and a missing cell reads as a real void from above rather than being closed by its
		// neighbours bulging in.
		roof = maskCells(0.49, roofH, 0.32 + bodyH * 2 + roofH)
			?? sdf.translate(
				sdf.roundBox(halfLen * 0.88, roofH, halfWid * 0.88, p.bevelM * 3),
				0, 0.32 + bodyH * 2 + roofH, 0,
			)
	}

	let mass = sdf.smoothUnion(sdf.union(apron, plinth), sdf.union(body, roof), k * 0.05)

	// --- the production door -------------------------------------------------
	// Cut, not modelled. A structure that produces anything must show where the thing comes
	// out, and it is the single clearest cue separating a factory from a silo in silhouette.
	//
	// Gated on `produces` since 2026-08-06. It was `buildStages >= 3` — a PROXY for "probably a
	// factory" derived from build duration — because the real fact could not get here: the
	// exporter read `ProductionQueueInfo`, which lives on the player actor, so every structure
	// in the mod reported that it produces nothing. The proxy put doors on silos and denied
	// them to factories, and it is why `lattice_extruder` (produces LatticeInfantry) and
	// `lattice_reservoir` (holds 5000) generated as the same building.
	if (p.produces > 0) {
		const doorW = Math.min(halfWid * 0.62, 1.1)
		const doorH = Math.min(bodyH * 1.1, eaves * 0.42)
		const door = sdf.roundBox(halfLen * 0.30, doorH, doorW, 0.05)
		mass = sdf.subtract(mass, sdf.translate(door, halfLen * 0.86, 0.32 + doorH * 0.92, 0))
	}

	// --- power ---------------------------------------------------------------
	if (p.powerAmount > 0) {
		// A generator. Stacks scale with output, and they are the tallest thing on the
		// building so they carry its silhouette from across the map.
		const stacks = Math.max(2, Math.min(4, Math.round(p.powerAmount / 45) + 1))
		const stackH = eaves * 0.42
		const stackR = Math.max(0.13, halfWid * 0.10)
		for (let i = 0; i < stacks; i++) {
			const t = stacks === 1 ? 0.5 : i / (stacks - 1)
			const z = (t - 0.5) * halfWid * 1.15
			const y = 0.32 + bodyH * 2 + roofH * 2 + stackH * 0.5
			const flue = sdf.translate(upright(stackR, stackH * 0.5), -halfLen * 0.42, y, z)
			mass = sdf.smoothUnion(mass, flue, k * 0.03)
			// A cap ring, so a stack reads as a flue rather than a post.
			const cap = sdf.translate(upright(stackR * 1.28, stackR * 0.35), -halfLen * 0.42, y + stackH * 0.5, z)
			mass = sdf.union(mass, cap)
			exhaustRegions.push(flue, cap)
		}
		// Cooling bank: a horizontal drum along the flank.
		const drum = sdf.rotateY(sdf.cylinder(eaves * 0.11, halfLen * 0.42), Math.PI * 0.5)
		const coolingBank = sdf.translate(drum, 0, 0.32 + bodyH * 1.5, -halfWid * 1.02)
		mass = sdf.smoothUnion(mass, coolingBank, k * 0.03)
		exhaustRegions.push(coolingBank)
	} else if (p.powerAmount < 0) {
		// A consumer, and the MAGNITUDE matters. Two revisions of history, because the second
		// one is the more useful lesson.
		//
		// The FIRST version branched on the sign and ignored the amount, so a -50 building and
		// a -10 building grew the same service head. A branch that reads a value only to test
		// its sign is throwing the value away.
		//
		// The SECOND version — this comment used to claim it fixed foundry_forge and
		// foundry_skyhook — scaled by the amount and still failed, and rostergate measured it:
		// those two sat at IoU 0.9572 afterwards. The reason was SCALE, not absence. It spent
		// the magnitude on `headS = 0.10 + 0.16 * draw`, which across the actual roster spread
		// (draw .583 to .833) moves a 20 cm box by FOUR CENTIMETRES, and on cable trunks 8 cm
		// wide standing at bodyH * 0.8 — below the eaves, where the camera never sees them.
		// forge and retort even landed on the same trunk count.
		//
		// This is the recurring failure of this whole layer: the value IS consumed, but it is
		// spent somewhere that cannot survive the zoom. The producer branch twenty lines above
		// gets it right — count 2..4, height `eaves * 0.42`, on the roof — so the fix is to
		// give consumers the same treatment in their own vocabulary rather than to invent a
		// third mechanism.
		const draw = Math.min(Math.abs(p.powerAmount) / 60, 1)
		const roofY = 0.32 + bodyH * 2 + roofH * 2

		// Intake banks. Deliberately BOXY and squat where the generator's flues are round and
		// tall: a consumer must not read as a generator, and the two are told apart by the
		// shape of what they carry, not by size alone.
		//
		// Count is discrete because a continuously scaled single object is not legible at RTS
		// zoom while two objects against one is — that part of the old comment was right, it
		// was just applied to something invisible. Height is a FRACTION OF EAVES rather than
		// an absolute, so it scales with the building instead of vanishing on a large one.
		const banks = 1 + Math.round(draw * 3)
		const bankH = eaves * (0.15 + 0.27 * draw)
		const bankW = Math.max(0.20, halfWid * 0.15)
		for (let i = 0; i < banks; i++) {
			const t = banks === 1 ? 0.5 : i / (banks - 1)
			const z = (t - 0.5) * halfWid * 1.10
			const bank = sdf.translate(
				sdf.roundBox(halfLen * 0.20, bankH * 0.5, bankW, p.bevelM * 2),
				-halfLen * 0.40, roofY + bankH * 0.5, z,
			)
			mass = sdf.smoothUnion(mass, bank, k * 0.03)
			// A louvre lip along the top edge, so a bank reads as an intake rather than a crate.
			const lip = sdf.translate(
				sdf.roundBox(halfLen * 0.23, bankH * 0.10, bankW * 1.12, p.bevelM),
				-halfLen * 0.40, roofY + bankH, z,
			)
			mass = sdf.union(mass, lip)
			machineryRegions.push(bank, lip)
		}

		// The service trunk stays, but it is now DETAIL rather than the differentiator. It is
		// below the eaves and it is allowed to be, because nothing is being asked of it.
		const serviceTrunk = sdf.translate(
			sdf.roundBox(0.045, bodyH * 0.85, 0.045, 0.02),
			-halfLen * 0.62, 0.32 + bodyH * 0.85, halfWid * 1.0,
		)
		mass = sdf.union(mass, serviceTrunk)
		machineryRegions.push(serviceTrunk)
	}

	// --- sensor / comms ------------------------------------------------------
	// Only where vision genuinely exceeds the roster median, same rule as the vehicles. A
	// radar mast on every building would make the cue meaningless.
	if (p.mastHeightM > 0.05) {
		const mastY = 0.32 + bodyH * 2 + roofH * 2 + p.mastHeightM * 0.5
		// Sized against the BUILDING as well as the vision range. A mast at a fixed 5 cm is a
		// twig on a large structure: `foundry_relay` moved from HALL to SILO massing when the
		// archetype started reading `produces`, its body grew, and its optic zone fell to 2.64%
		// of the mesh — under `zonegate`'s 3% floor, which exists precisely to catch a material
		// zone that is claimed but too small to see. The dish is the point of a relay; it should
		// grow with the thing carrying it.
		const mastR = Math.max(0.05, halfWid * 0.055)
		const sensorMast = sdf.translate(
			sdf.roundBox(mastR, p.mastHeightM * 0.5, mastR, 0.02),
			halfLen * 0.55, mastY, -halfWid * 0.55,
		)
		mass = sdf.union(mass, sensorMast)
		// A dish, tipped to face out rather than up.
		const dish = sdf.translate(
			// 0.42 of mast height, not 0.22. A dish's aperture is what buys its range, so a
			// taller mast carrying a longer link should carry a bigger dish — the old
			// coefficient made every sensor a token. It is also what `zonegate` was telling us:
			// the optic zone on `foundry_relay` had fallen to 2.64% of its mesh, and a material
			// zone too small to see is a zone the shader paints and the player never reads.
			sdf.rotateY(sdf.cappedCone(Math.max(p.mastHeightM * 0.42, halfWid * 0.20), 0.03, 0.10), Math.PI * 0.35),
			halfLen * 0.55, mastY + p.mastHeightM * 0.5, -halfWid * 0.55,
		)
		mass = sdf.union(mass, dish)
		// The glass face is too small to survive as a material cue by itself at the production
		// mesh resolution. The mast is its housing, so claim the complete sensor assembly —
		// still a region on the same mesh, and large enough to remain readable.
		opticRegions.push(sdf.union(sensorMast, dish))
	}

	// --- per-instance variation ----------------------------------------------
	// §9.2: the `structures` gate requires two instances of the same building to differ
	// visibly, and §9.2 requires the difference to be per-instance detail only — never the
	// shape language. A roof plant box, placed by seed, satisfies both: it changes the
	// roofline without touching the mass, the door or the stacks.
	// Cost buys roof plant, in DISCRETE units. An expensive building carries visibly more
	// machinery than a cheap one, and a count reads at zoom where a continuous size change
	// does not. This is `greebleBudget` spent on massing because `geo/greeble` has no
	// consumer yet — when it does, this becomes surface detail and the count goes back down.
	const units = 1 + Math.min(Math.round(p.greebleBudget / 900), 3)
	// PLACEMENT IS DERIVED, NOT SEEDED, and that distinction is the whole value of this block.
	//
	// It used to place each box at `rng.next()`, which is shape language being seeded — the one
	// thing §9.2 forbids. Random placement varies per INSTANCE, so it encodes nothing about the
	// TYPE: two different buildings with the same budget got the same count of boxes scattered
	// differently, and the same building got a different roof every time it was built. It could
	// not separate anything, and 12 of the 26 plants collide.
	//
	// Derived from the building's own functional numbers instead, so the roof plant IS the
	// actor's signature and is identical every time that actor is built. Power draw, tech depth
	// and occupied cells are all things this structure genuinely is.
	const sig = (i: number): number => {
		const a = Math.abs(p.powerAmount) * 7 + p.techDepth * 31 + p.footprintCells * 13 + i * 97
		return ((a * 2654435761) % 1024) / 1024
	}
	for (let i = 0; i < units; i++) {
		const rx = (sig(i) - 0.5) * halfLen * 1.1
		const rz = (sig(i + 41) - 0.5) * halfWid * 1.1
		const boxH = roofH * (1.2 + sig(i + 83) * 1.2)
		const roofUnit = sdf.translate(
			sdf.roundBox(halfLen * 0.15, boxH, halfWid * 0.15, p.bevelM * 2),
			rx, 0.32 + bodyH * 2 + roofH * 2 + boxH, rz,
		)
		mass = sdf.union(mass, roofUnit)
		machineryRegions.push(roofUnit)
	}

	// COST buys a structural element, per archetype — the second axis the 26 plants needed.
	//
	// Four archetypes for twenty-six buildings meant every collision was WITHIN an archetype,
	// where members differed only by proportion. §14.13 already says an expensive machine
	// generates as a complicated one, and cost was spending that entirely on greeble, which
	// d2cecef measured as invisible at gameplay zoom. This puts it on the SKYLINE instead,
	// which is the only place a cue survives a camera that looks down.
	if (p.greebleBudget >= 1700) {
		const eavesY = 0.32 + bodyH * 2
		if (massing === HALL) {
			// A clerestory: a raised centre section along the ridge, which is what a hall gets
			// when it can afford top light.
			const along = p.lengthM >= p.widthM
			mass = sdf.union(mass, sdf.translate(
				sdf.roundBox(along ? halfLen * 0.46 : halfWid * 0.22, roofH * 1.5, along ? halfWid * 0.22 : halfLen * 0.46, p.bevelM * 2),
				0, eavesY + roofH * 2.4, 0,
			))
		} else if (massing === SILO) {
			// A gantry cage around the drum — external access, which a cheap tank does not get.
			const rad = Math.min(halfLen, halfWid) * 1.02
			for (const sx of [-1, 1]) {
				mass = sdf.union(mass, sdf.translate(
					sdf.roundBox(0.045, bodyH * 0.9, 0.045, 0.02), sx * rad, 0.32 + bodyH, 0,
				))
			}
			mass = sdf.union(mass, sdf.translate(
				sdf.rotateX(sdf.subtract(sdf.cylinder(rad, 0.035), sdf.cylinder(rad * 0.86, 0.08)), Math.PI * 0.5),
				0, 0.32 + bodyH * 1.55, 0,
			))
		} else if (massing === STACK) {
			// One tall flue above the rest — a bigger plant vents higher.
			const tallFlue = sdf.translate(
				upright(Math.max(0.10, halfWid * 0.13), eaves * 0.42),
				halfLen * 0.30, eavesY + roofH * 2 + eaves * 0.42, -halfWid * 0.30,
			)
			mass = sdf.union(mass, tallFlue)
			exhaustRegions.push(tallFlue)
		} else {
			// A covered bay over one end of the yard.
			mass = sdf.union(mass, sdf.translate(
				sdf.roundBox(halfLen * 0.30, roofH * 0.7, halfWid * 0.92, p.bevelM * 2),
				-halfLen * 0.62, eavesY + roofH * 1.6, 0,
			))
		}
	}

	if (machineryRegions.length > 0)
		zones?.push({ zone: Zone.running, tree: sdf.union(...machineryRegions) })
	if (exhaustRegions.length > 0)
		zones?.push({ zone: Zone.exhaust, tree: sdf.union(...exhaustRegions) })
	if (opticRegions.length > 0)
		zones?.push({ zone: Zone.optic, tree: sdf.union(...opticRegions) })
	return mass
}

/**
 * Defences and walls. The same plan logic with an aggressive vertical bias and an embrasure,
 * kept in this file because it shares every helper and differs only in massing.
 */
export function buildEmplacement(p: ChassisParams, rng: Rng, zones?: ZoneRegion[]): sdf.Sdf {
	const halfLen = p.lengthM * 0.5
	const halfWid = p.widthM * 0.5
	const k = p.op.joinRadius

	// A defence is TALL for its plan, which is the inverse of the plant rule and is what
	// separates a gun tower from a shed at a glance.
	// Plan area alone is not enough here for the same reason it was not enough for the plants:
	// emplacements cluster on a few footprints, so height driven by plan gives a handful of
	// distinct towers and the rest collide. foundry_bulwark and foundry_redoubt sat at IoU
	// 0.9975 on exactly that.
	//
	// Toughness participates, and it does so in the OPPOSITE direction to a plant. A heavy
	// plant is squat because mass per area buys thickness; a heavy DEFENCE is tall, because
	// what it buys is a commanding position and a longer field of fire. Same number, opposite
	// architectural consequence, and that opposition is itself a silhouette cue between the two
	// structure families.
	const empStout = Math.min(1, Math.max(0, (p.plateMm - 6) / 34))

	// THE WEAPON HAS TO BE IN THE MASS, NOT ON IT.
	//
	// Measured refutation, and it is the second time the same lesson arrived today. Classifying
	// anti-air correctly from the roster (p.targetsAir, replacing a tubes>1 proxy that was wrong
	// in both directions) and elevating the barrel 42 degrees moved foundry_casemate against
	// foundry_flakrack from IoU 0.9800 to 0.9840 — the WRONG WAY — and lattice_prong against
	// lattice_pylon from 0.9718 to 0.9723. The classification was now correct and the silhouette
	// still did not separate.
	//
	// The reason is that a barrel is a thin stick against a tower of several square metres, and
	// IoU is dominated by the mass. Rotating a stick cannot move it. The plant family taught the
	// identical lesson an hour earlier when power-draw cues moved onto roof banks and cleared
	// zero pairs: a cue OUTSIDE the main mass cannot separate two machines whose masses agree.
	//
	// So the two classes get OPPOSITE ARCHITECTURE in the mass itself. An anti-air mount is a
	// TALL SLIM pedestal: it buys sky, it needs to clear what surrounds it, and it carries a
	// light gun high. A direct-fire emplacement is a LOW BROAD block: it buys frontal armour and
	// a firing slit, and height would only expose it. Same functional numbers, opposite
	// architectural consequence — which is §9.1's cast-mass-versus-framework argument applied
	// inside a single family.
	//
	// Bore drives how squat the direct-fire case gets, because a bigger gun needs a heavier
	// mount and a deeper recoil path, and that reads as mass rather than as barrel.
	const throwWeight = Math.min(p.boreMm / 120, 1)
	const towerBase = 0.55 + 1.15 * Math.sqrt(Math.max(p.lengthM * p.widthM, 0.5))
	// LOW AND BROAD IS TWO STATEMENTS AND ONLY ONE OF THEM WAS BEING MADE.
	//
	// The paragraph above commits to it — a direct-fire emplacement is a LOW BROAD block — and
	// the code said "low" inside a multiplier spanning 0.68 to 0.78, then said nothing about
	// "broad" at all, because the plan radius was a flat 1.0 for every direct-fire actor in the
	// family. So a 2x difference in damage, which the roster does state, arrived here and was
	// spent inside a 10% band on one axis.
	//
	// Measured on the pair this generator has failed on twice: foundry_bulwark derives an 80 mm
	// bore and foundry_redoubt 112 mm, a real 40% difference, and the towers came out 3.1%
	// apart in height and 0% apart in plan. That is not a shortage of information — it is a
	// transfer function that refuses to spend it.
	//
	// Widened on both axes, in the direction the file already argued for. The batter still
	// never exceeds the footprint the sim reserved: separation is bought by making a LIGHT
	// gun's works slimmer, never by making a heavy one wider than the cells it owns.
	const emplaceBroad = 0.76 + 0.24 * throwWeight
	const towerH = towerBase * (0.82 + 0.42 * empStout)
		* (p.targetsAir ? 1.38 : 0.95 - 0.34 * throwWeight)

	const plinth = sdf.translate(sdf.roundBox(halfLen * 1.08, 0.12, halfWid * 1.08, p.bevelM * 3), 0, 0.12, 0)

	// Battered walls: wider at the base, and FACETED rather than round.
	//
	// This was a cappedCone, which was defensible on its own and is not any more: the plant
	// family now uses a round plan for its silos, and a round emplacement shares a silhouette
	// with a storage tank. Distinguishing a gun tower from a fuel drum by whether it happens
	// to have a barrel on top is exactly the kind of separation that fails the moment the
	// barrel is behind something.
	//
	// Faceted is also the truer shape. A fortification is poured or bolted in flat panels
	// because flat panels deflect, and the angular batter is what makes a pillbox read as a
	// pillbox. `hexPrism` stands along Z like every other prism here (§12.4), so it needs the
	// same rotateX a cylinder does.
	// The plan narrows for an anti-air mount and stays at the footprint for a direct-fire one.
	// Deliberately asymmetric: an emplacement may sit INSIDE its plan but must never spill
	// outside it, or the mesh stops agreeing with the footprint the sim reserved and buildings
	// visibly overlap their neighbours. So the separation is bought by making the AA pedestal
	// slimmer, never by making the casemate wider than the cells it owns.
	const apothem = Math.max(halfLen, halfWid) * (p.targetsAir ? 0.68 : emplaceBroad)
	const batter = (a: number, hy: number, y: number): sdf.Sdf => sdf.translate(
		sdf.rotateX(sdf.hexPrism(a, hy), Math.PI * 0.5), 0, y, 0,
	)
	// Two stacked courses instead of a continuous taper: a step reads at RTS zoom where a
	// smooth batter does not, and it is what a revetted wall actually looks like.
	const lower = batter(apothem * 0.98, towerH * 0.30, 0.24 + towerH * 0.30)
	const upper = batter(apothem * 0.80, towerH * 0.24, 0.24 + towerH * 0.60 + towerH * 0.24)
	let mass = sdf.smoothUnion(plinth, sdf.union(lower, upper), k * 0.05)

	// An EMBRASURE, cut rather than modelled. A horizontal firing slit is the single clearest
	// statement that a structure is a fortification — more than the gun, which a vehicle also
	// has, and more than the height, which a silo also has. Cut on the long axis so it faces
	// the direction the gun does.
	//
	// Its depth follows plate: a thickly armoured emplacement has a deep-set slit in a heavy
	// wall, a light one has a wide open one. The same number that gives a tank its armour.
	const slitH = towerH * (0.075 - 0.030 * (p.plateMm / 60))
	const slitY = 0.24 + towerH * 0.62
	mass = sdf.subtract(mass, sdf.translate(
		sdf.roundBox(apothem * 1.3, slitH, apothem * 0.42, 0.015),
		apothem * 0.52, slitY, 0,
	))

	// Parapet cap.
	const capH = towerH * 0.10
	mass = sdf.union(mass, sdf.translate(
		sdf.roundBox(halfLen * 1.02, capH, halfWid * 1.02, p.bevelM * 2),
		0, 0.24 + towerH + capH, 0,
	))
	if (p.plan !== null && p.plan.length >= 3) {
		// Shape the broad occupied mass, including plinth and parapet, with the authored plan.
		// The weapon is added afterwards because the plan describes its emplacement, not its
		// traverse envelope. No recentering: the polygon's small asymmetry is authored identity.
		mass = sdf.intersect(
			mass,
			sdf.convexPlanPrism(p.plan, towerH + capH + 0.5, towerH * 0.5),
		)
	}

	// An OBSERVATION CUPOLA, where the structure reveals shroud.
	//
	// This family consumed exactly two scalars — plate and bore — and spent both inside narrow
	// multipliers, so foundry_bulwark and foundry_redoubt came out as the same hexagonal stack
	// 3% apart in height and sat at IoU 0.9879. Their functional data is not 3% apart: 300
	// damage on a 22-tick reload against 600 on 54, and one of them REVEALS SHROUD AND THE
	// OTHER IS BLIND. That last fact is categorical, which is what makes it able to break a tie
	// that two continuous parameters could not, and it never reached this function at all —
	// `mastHeightM` is read by every other family in the project and by no emplacement.
	//
	// A CUPOLA, NOT A MAST. The lesson recorded twice above in this file is that a cue outside
	// the main mass cannot separate two machines whose masses agree: a barrel is a thin stick
	// against a tower of several square metres, and rotating or lengthening a stick does not
	// move IoU. A whip antenna would fail for exactly that reason. But an observation position
	// on a fortification is not a whip — it is a manned armoured box that has to be stood in,
	// and drawing it as one puts REAL MASS above the parapet where the silhouette is decided.
	//
	// Set to the rear, away from the embrasure on +X, so it neither fouls the gun nor fills the
	// firing slit. Bounded to 0.64 of the apothem by construction, because this is added after
	// the plan intersect — like the turret — and so is not clipped by the authored footprint.
	if (p.mastHeightM > 0.05) {
		const cupR = apothem * 0.34
		const neckH = p.mastHeightM * 0.55
		const baseY = 0.24 + towerH + capH * 2
		const cx = -apothem * 0.30
		const cz = apothem * 0.20
		const neck = sdf.translate(
			sdf.rotateX(sdf.cylinder(cupR * 0.46, neckH * 0.5), Math.PI * 0.5),
			cx, baseY + neckH * 0.5, cz,
		)
		// Faceted, like the courses below it. A round cupola on a faceted tower reads as a tank
		// someone left on the roof; the whole point of the batter is that a fortification is
		// built in flat deflecting panels, and the observation post is part of the fortification.
		const dome = sdf.translate(
			sdf.rotateX(sdf.hexPrism(cupR, cupR * 0.62), Math.PI * 0.5),
			cx, baseY + neckH + cupR * 0.62, cz,
		)
		// A vision slit around the cupola is the same statement the embrasure makes lower down,
		// and it is what stops the drum reading as a water tank.
		const cupola = sdf.subtract(
			sdf.union(neck, dome),
			sdf.translate(
				sdf.roundBox(cupR * 1.4, cupR * 0.16, cupR * 1.4, 0.01),
				cx, baseY + neckH + cupR * 0.72, cz,
			),
		)
		zones?.push({ zone: Zone.optic, tree: cupola })
		mass = sdf.smoothUnion(mass, cupola, k * 0.04)
	}

	// A wall segment has no turret and no embrasure — it is a wall. Everything else gets one.
	if (p.ringDiaM > 0 && p.barrelLenM > 0) {
		const ringR = p.ringDiaM * 0.5
		const gunY = 0.24 + towerH + capH * 2 + p.turretHeightM * 0.4
		const drum = sdf.rotateX(sdf.cylinder(ringR, Math.max(p.turretHeightM, 0.18) * 0.5), Math.PI * 0.5)
		let turret = sdf.translate(drum, 0, gunY, 0)
		const boreR = Math.max(p.boreMm / 2000, 0.03)
		// ELEVATION is the anti-air cue, not tube count.
		//
		// This previously added extra tubes at bore radius — about 0.03 m — to say "anti-air".
		// Measured, that failed completely: foundry_bulwark and foundry_flakrack sat at IoU
		// 0.9986 even after flakrack was given a real Burst of 4 and `tubes` arrived here as 4,
		// because 3 cm of extra barrel is sub-pixel at the raster the gate measures on and at
		// the zoom the game is played at. A cue drawn at DETAIL scale cannot separate two
		// machines whose SILHOUETTES are the same.
		//
		// What actually separates a flak mount from a direct-fire gun is where it points. A
		// direct-fire gun lies along the horizon; an anti-air mount sits at high elevation, and
		// that rotation moves the barrel across the whole height of the silhouette. It costs one
		// rotation and it reads at any size, which is the same argument that put the emissive
		// strip on a horizontal band and the silo on a round plan.
		// TUBE COUNT WAS A PROXY FOR A FACT THE ROSTER CAN NOW STATE DIRECTLY.
		//
		// This used to be `p.tubes > 1`, and measured, it was wrong in BOTH directions:
		//   foundry_casemate  ground-only, 2 tubes -> classed AA, so a 105 mm direct-fire
		//                     bunker gun was drawn elevated to 42 degrees
		//   lattice_prong     ANTI-AIR,    1 tube  -> classed ground, so a real flak mount
		//                     was drawn flat-firing
		// Since elevation is the dominant silhouette cue in this generator, getting the class
		// wrong swaps the whole outline. casemate/flakrack sat at IoU 0.9800 and prong/pylon
		// at 0.9718 on exactly that.
		//
		// The mod already authored the truth on the actor — AutoTargetPriority ValidTargets: Air
		// — and it is now exported and carried on ChassisParams, so the generator reads the fact
		// instead of guessing from a correlate. A twin direct-fire gun is not an AA mount, and
		// no amount of tube counting can tell you which one you are holding.
		//
		// Tube COUNT still drives how many tubes are drawn; it was only the CLASSIFICATION that
		// was ever wrong.
		const aa = p.targetsAir
		// 42 degrees. Enough to read unmistakably as elevated without pointing at the zenith,
		// where the barrel would foreshorten to a dot from the gameplay camera.
		const elevation = aa ? Math.PI * 0.233 : 0
		const tube = sdf.rotateY(sdf.cylinder(boreR, p.barrelLenM * 0.5), Math.PI * 0.5)
		const barrelX = ringR * 0.6 + p.barrelLenM * 0.5
		// Tube count still varies the mount, but SPREAD LATERALLY at ring radius rather than
		// stacked at bore radius, so the cluster occupies real width instead of real nothing.
		const n = aa ? Math.min(p.tubes, 4) : 1
		let gun = sdf.translate(sdf.rotateZ(tube, elevation), barrelX * Math.cos(elevation), gunY + barrelX * Math.sin(elevation), 0)
		for (let i = 1; i < n; i++) {
			const off = (i / Math.max(n - 1, 1) - 0.5) * ringR * 1.15
			gun = sdf.union(gun, sdf.translate(
				sdf.rotateZ(tube, elevation),
				barrelX * Math.cos(elevation), gunY + barrelX * Math.sin(elevation), off,
			))
		}
		// An elevated mount needs a trunnion to pivot on, and it is what stops the barrels
		// reading as sticks pushed into a drum.
		if (aa) {
			turret = sdf.union(turret, sdf.translate(
				sdf.rotateY(sdf.cylinder(ringR * 0.30, ringR * 0.95), Math.PI * 0.5),
				0, gunY + ringR * 0.35, 0,
			))
		}
		// Barrels, muzzle ends and their welded weapon mount are heat-affected metal on the same
		// mesh. Claiming the complete assembly matters: the smallest bores are below one mesher
		// cell, so a barrel-only region can label two vertices — or none — despite the visible
		// turret around it. The mount is the barrel's housing, not a separately painted hull.
		// THE MOUNT SITS WHERE THE SIMULATION FIRES FROM. `p.muzzleM` is `Armament.LocalOffset`
		// composed with the turret offset; the engine calls it the weapon's position in turret
		// coordinates, so it is the MOUNT and not the barrel tip. Being solid there is what
		// stops the shot and its flash leaving from open air. See tracked.ts for the argument.
		const mount = sdf.translate(
			sdf.roundBox(boreR * 2.6, boreR * 2.6, boreR * 2.6, p.bevelM * 2),
			p.muzzleM[0], p.muzzleM[1], p.muzzleM[2],
		)
		turret = sdf.union(turret, mount)
		zones?.push({ zone: Zone.exhaust, tree: sdf.union(turret, gun) })
		turret = sdf.union(turret, gun)
		mass = sdf.smoothUnion(mass, turret, k * 0.04)
	} else {
		// Wall: a crenellation, seeded per instance so a run of wall is not a comb.
		const notch = sdf.roundBox(halfLen * 0.24, capH * 1.2, halfWid * 1.1, 0.02)
		const at = (rng.next() - 0.5) * halfLen
		mass = sdf.subtract(mass, sdf.translate(notch, at, 0.24 + towerH + capH * 2, 0))
	}

	return mass
}
