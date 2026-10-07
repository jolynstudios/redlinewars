#!/usr/bin/env node
// STEELSEED — tools/rosteradapt
//
// Adapts the engine's `--steelseed-roster` export into the flat `RosterSlot` the archetype
// generators consume. Engine units in, metres out; trait-shaped in, flat out.
//
// EVERYTHING HERE IS DERIVED FROM THE EXPORT, never from a hand-written table of actor
// names. That is the rule I gave Codex and it binds me equally: if a tool cannot recompute a
// value from something else in the file, it is an authored constant and needs a reason
// beside it. A name table would go stale the first time an actor was renamed, and it would
// go stale SILENTLY, which is the failure mode this project keeps paying for.
//
// The family signal is `Buildable.Queue`. It is authoritative because it is what the SIM
// uses — an actor in FoundryInfantry is infantry by the same fact that makes the barracks
// build it. Locomotor cannot do this job: the mod uses only `ground` and `hover`, and
// `foundry_warden` (Selectable 768, HP 2100, Speed 44) is in FoundryInfantry despite
// reading like a vehicle from its numbers alone.

const CELL = 1024

/** §12.4: one cell is one metre. */
const m = wu => wu / CELL

const ARMOUR_INDEX = { LightFrame: 1, HeavyFrame: 3, StructureFrame: 4 }

/** Faction from the actor-name prefix. The one convention the mod does guarantee. */
function factionOf(name) {
	if (name.startsWith('foundry_')) return 0
	if (name.startsWith('lattice_')) return 1
	return 2
}

/**
 * Family from the production queue, plus one structural refinement.
 *
 * A building that carries an Armament is a defence, not a plant — that is a real functional
 * difference (it shoots) and it drives a completely different massing rule, so it must not
 * be decided by whether someone put "tower" in the name.
 */
function familyOf(a, faction) {
	const q = (a.Buildable?.Queue ?? []).join(' ')
	if (/Infantry/i.test(q)) return 2
	// Rotorcraft and fixed wing are DIFFERENT FAMILIES, split on the fact the mod states.
	//
	// `Family.fixedwing` (4) was defined and never assigned — every aircraft came back as
	// rotorcraft, and `buildAircraft` then re-derived the distinction from a bounding-box ratio
	// that was wrong in both directions. Now that `Aircraft.VTOL` crosses the bridge the split
	// belongs here, where family is decided, rather than being rebuilt downstream from a
	// correlate. A family constant nothing can produce is a lie about the roster's shape.
	//
	// An export with no Aircraft block still returns rotorcraft, so a stale roster keeps working
	// and `buildAircraft`'s ratio fallback stays reachable for exactly that case.
	if (/Aircraft/i.test(q)) return a.Aircraft !== undefined && a.Aircraft !== null && a.Aircraft.VTOL !== true ? 4 : 3
	// Naval before Vehicle: a vessel is its own family (5) and must not fall through to the
	// faction-split ground branch below, which would generate a destroyer as a tank.
	if (/Naval/i.test(q)) return 5
	if (/Vehicle/i.test(q)) return faction === 0 ? 0 : 1
	if (/Building/i.test(q)) return a.Armament ? 7 : 6
	return null
}

const ARCHETYPE = { 0: 'trackedVehicle', 1: 'wheeledVehicle', 2: 'soldier', 3: 'rotorcraft', 4: 'fixedWing', 6: 'plant', 7: 'emplacement' }

/**
 * Convert one exported actor. Returns null for a system actor (no queue, no family).
 *
 * `missing` collects every field the export cannot supply, so a caller can report the gap
 * rather than consume a zero. This matters more than it looks: §14.13 makes these numbers
 * drive geometry, so a silently-zeroed damage value becomes art direction — every gun in the
 * roster gets the same bore.
 */
export function adaptActor(a, missing, weapons) {
	const faction = factionOf(a.name)
	const family = familyOf(a, faction)
	if (family === null) return null
	if (typeof a.TargetsAir !== 'boolean') missing.add(`${a.name}: TargetsAir absent from the export`)

	// Plan size. A building's footprint is authoritative; everything else uses its selection
	// bounds, which are in world units.
	let lengthM, widthM
	if (a.Building?.Dimensions) {
		lengthM = a.Building.Dimensions[0]
		widthM = a.Building.Dimensions[1]
	} else if (a.Selectable?.Bounds) {
		lengthM = m(a.Selectable.Bounds[0])
		widthM = m(a.Selectable.Bounds[1])
	} else {
		lengthM = 1
		widthM = 1
		missing.add(`${a.name}: no Building.Dimensions and no Selectable.Bounds`)
	}

	const armaments = []
	for (const g of a.Armament ?? []) {
		const w = weapons?.[g.Weapon] ?? null
		if (w === null) missing.add(`${a.name}: weapon ${g.Weapon} not in the weapons table`)
		// LocalOffset is a LIST of mounts — twin barrels are two entries, and §14.13 makes
		// the first one authoritative for where the barrel tip lands.
		const off = g.LocalOffset?.[0] ?? null
		if (off === null) missing.add(`${a.name}: Armament ${g.Weapon} has no LocalOffset`)
		armaments.push({
			weapon: g.Weapon ?? 'unknown',
			muzzleM: off ? [m(off[0]), m(off[2]), m(off[1])] : [0, 0, 0],
			recoilM: m(g.Recoil ?? 0),
			rangeM: w?.Range != null ? m(w.Range) : 0,
			reloadTicks: w?.ReloadDelay ?? 0,
			// The FIRST damage warhead. Order is simulation order and is preserved by the
			// exporter, so this is the primary effect rather than an arbitrary pick.
			damage: w?.Warheads?.[0]?.Damage ?? 0,
			// Warhead Versus, reduced to one signed axis.
			//
			// The mod authors a weapon's ROLE here and it has never reached geometry: ClampDriver
			// is HeavyFrame 110 / LightFrame 70 and EmberArm is 62 / 120 — designed opposites,
			// 1.8x apart — and `rosteradapt` dropped the whole table while the exporter had been
			// writing it all along. That pair is exactly the one rostergate reports as 0.0269
			// apart in parameter space, below its 0.06 floor: two actors the mod says do opposite
			// jobs, generating as the same machine because the fact never crossed the boundary.
			//
			// +1 is purely anti-armour, -1 purely anti-light, 0 general purpose. A ratio rather
			// than the raw pair, because what a generator can spend is the BIAS — absolute
			// numbers are balance, and §14.12 keeps those out of here.
			armourBias: versusBias(w?.Warheads?.[0]?.Versus ?? null),
			burst: w?.Burst ?? g.Burst ?? 1,
			// The sim's projectile type, verbatim, for the record. It is NOT what decides
			// the muzzle geometry — see the note on muzzleBrake in params.ts.
			projectile: w?.Projectile ?? 'unknown',
		})
		if (w !== null && w.Warheads?.length === 0) missing.add(`${g.Weapon}: no damage warhead`)
	}

	return {
		name: a.name,
		faction,
		family,
		archetype: ARCHETYPE[family] ?? 'unknown',
		lengthM,
		widthM,
		hp: a.Health?.HP ?? 0,
		armourIndex: ARMOUR_INDEX[a.Armor?.Type] ?? 0,
		cost: a.Valued?.Cost ?? 0,
		buildTicks: a.BuildDuration ?? 0,
		speed: a.Mobile?.Speed ?? null,
		locomotor: a.Mobile?.Locomotor ?? null,
		visionM: a.RevealsShroud ? m(a.RevealsShroud.Range) : null,
		targetsAir: a.TargetsAir === true,
		// null means "this export predates the Aircraft block", which is NOT the same as false.
		// The generator falls back to its old bounding-box guess only in that case.
		vtol: a.Aircraft === undefined || a.Aircraft === null ? null : a.Aircraft.VTOL === true,
		turret: a.Turreted
			? {
				turnSpeed: a.Turreted.TurnSpeed ?? a.Turreted.turnSpeed ?? 12,
				offsetM: a.Turreted.Offset
					? [m(a.Turreted.Offset[0]), m(a.Turreted.Offset[2]), m(a.Turreted.Offset[1])]
					: [0, 0, 0],
			}
			: null,
		armaments,
		powerAmount: a.Power?.Amount ?? 0,
		// What the building DOES. Exported since the roster existed and dropped here until a
		// rostergate collision exposed it: `lattice_extruder` produces LatticeInfantry and
		// `lattice_reservoir` holds 5000 resources, and with neither field reaching the
		// generator the two differed only in HP and build time and drew as the same building.
		// The seventh piece of authored truth found with no consumer, after TargetsAir, the
		// HitShape polygons, Warhead Versus, the shroud, muzzleM and Aircraft.VTOL.
		produces: a.Produces ?? 0,
		storageCapacity: a.StorageCapacity ?? 0,
		refinery: a.Refinery === true,
		cargo: 0,
		footprint: a.Building?.Footprint ?? null,
		// The authored PLAN, when the mod drew one.
		//
		// Ten Lattice structures carry a hand-drawn six-point HitShape polygon — an irregular
		// outline authored per actor, in the mod, by a person. The generator has never seen it:
		// it reads Building.Footprint, which is a rectangle of cells, and throws the polygon
		// away. This is the third piece of authored truth found sitting in the export with no
		// consumer, after TargetsAir and Warhead Versus, and it is the most valuable of the
		// three because it is per-actor SHAPE rather than a scalar.
		//
		// Rectangles are not carried: a Rectangle HitShape is the cell footprint restated, so
		// passing it would hand the generator the same information twice under two names.
		plan: a.HitShape?.Type === 'Polygon' && Array.isArray(a.HitShape.Points)
			? a.HitShape.Points.map(pt => [m(pt[0]), m(pt[1])])
			: null,
		techDepth: (a.Buildable?.Prerequisites ?? []).length,
	}
}

/**
 * Reduce a Versus table to a signed anti-armour bias in -1..+1.
 *
 * Null and an all-equal table both give 0: a weapon with no stated preference is general
 * purpose, which is a real answer rather than a missing one.
 */
function versusBias(versus) {
	if (versus === null || versus === undefined) return 0
	const heavy = Number(versus.HeavyFrame ?? 100)
	const light = Number(versus.LightFrame ?? 100)
	const total = heavy + light
	if (!Number.isFinite(total) || total <= 0) return 0
	return (heavy - light) / total
}

/** Adapt a whole export. Returns { slots, missing }. */
export function adaptRoster(doc) {
	const missing = new Set()
	const slots = []
	const weapons = doc.weapons ?? null
	if (weapons === null) missing.add('the export carries no `weapons` table — every gun will derive the same bore')
	for (const a of doc.actors ?? []) {
		const s = adaptActor(a, missing, weapons)
		if (s !== null) slots.push(s)
	}
	return { slots, missing: [...missing] }
}
