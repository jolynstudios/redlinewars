// STEELSEED — units/archetype/vessel
//
// The eighth and last family generator. A ship differs from every other family in one fact
// that drives its whole shape: it floats. The waterline is not a detail, it is the datum —
// everything below it is hull the player never sees, and everything above it has to read
// against a flat, reflective, moving surface rather than against ground.
//
// So this generator spends nothing on the underbody. The hull is drawn from the waterline up,
// with just enough below it that a wake and a shadow have something to attach to, and all of
// the geometry budget goes into the three things that separate ships at RTS zoom:
//
//   PLAN TAPER   a bow. Nothing else on the roster is pointed, so a taper is the single
//                strongest "this is a vessel" cue, and it survives to a few pixels.
//   SHEER        the deck line rising toward the bow. It is what stops a ship reading as a
//                floating brick, and it costs one extra section.
//   SUPERSTRUCTURE  massed amidships and aft, because that is where it goes on a real hull
//                and because it gives the silhouette a high point that is not the gun.
//
// §9.1 applies as everywhere else: the Foundry is solid cast mass with faired joins, the
// Lattice an open bolted framework with hard ones. On a ship that reads as a closed armoured
// casemate against an open lattice mast and railed deck.

import * as sdf from '../../geo/sdf'
import { Zone, type ZoneRegion } from '../../geo/zone'
import type { Rng } from '../../core'
import type { ChassisParams, RosterSlot } from './params'
import type { TrackedTurretRegion } from './tracked'

type TurretSlot = NonNullable<RosterSlot['turrets']>[number]

/** Cylinders and prisms stand along Z (§12.4); this is the rotation to stand one on Y. */
function upright(radius: number, halfHeight: number): sdf.Sdf {
	return sdf.rotateX(sdf.cylinder(radius, halfHeight), Math.PI * 0.5)
}

export function buildVessel(
	p: ChassisParams,
	_rng: Rng,
	zones?: ZoneRegion[],
	turretsOut?: TrackedTurretRegion[],
	turretSlots?: readonly TurretSlot[],
): sdf.Sdf {
	const halfLen = p.lengthM * 0.5
	const halfBeam = p.widthM * 0.5
	const k = p.op.joinRadius

	// The waterline is y = 0 and the hull straddles it. Freeboard — the height of deck above
	// water — follows plate, because a heavily armoured ship rides lower and shows less side.
	// Draught is deliberately shallow: it is never seen, and depth spent below the water is
	// depth not spent on the part that reads.
	const freeboard = 0.18 + 0.30 * (1 - p.plateMm / 60)
	const draught = 0.10
	// Antifouling is a property of the finished hull, not a second hull mesh. A half-space
	// claims every welded-surface vertex below the waterline, including the fillets between
	// tapered sections, while leaving the painted topside untouched. Rotation about Y cannot
	// move the waterline, so this region remains aligned with the final heading jitter below.
	zones?.push({ zone: Zone.running, tree: sdf.plane(0, 1, 0, 0) })

	// --- hull ----------------------------------------------------------------
	// Three sections along the length, narrowing forward. A single box with a cone on the
	// front reads as a bullet; three tapering sections read as a hull because the rate of
	// taper changes, which is what a real waterplane does.
	const sections: sdf.Sdf[] = []
	const STATIONS = [
		{ x: -0.78, beam: 0.82, rise: 0.00 },
		{ x: -0.20, beam: 1.00, rise: 0.02 },
		{ x: 0.38, beam: 0.92, rise: 0.06 },
		{ x: 0.82, beam: 0.54, rise: 0.13 },
	]
	for (let i = 0; i < STATIONS.length - 1; i++) {
		const a = STATIONS[i]
		const b = STATIONS[i + 1]
		const midX = (a.x + b.x) * 0.5 * halfLen
		const halfRun = Math.abs(b.x - a.x) * 0.5 * halfLen
        // Sheer: the deck rises toward the bow, so each section sits slightly higher than the
        // one behind it. Averaged across the section rather than lofted, which is a fair
        // approximation at a scale where the whole ship is a few dozen pixels.
		const rise = (a.rise + b.rise) * 0.5 * freeboard
		const beam = (a.beam + b.beam) * 0.5 * halfBeam
		sections.push(sdf.translate(
			sdf.roundBox(halfRun, (freeboard + draught) * 0.5 + rise * 0.5, beam, p.bevelM * 4),
			midX, (freeboard - draught) * 0.5 + rise * 0.5, 0,
		))
	}
	// Faired along the hull whatever the faction: a ship's plating is continuous even on the
	// Lattice, because a hull that leaks is not a hull. The faction shows above deck instead.
	let body = sections[0]
	for (let i = 1; i < sections.length; i++) body = sdf.smoothUnion(body, sections[i], halfBeam * 0.22)

	// The stem: a wedge closing the bow to a point. Without it the forward section ends in a
	// flat face and the taper stops looking like a bow.
	body = sdf.smoothUnion(body, sdf.translate(
		sdf.rotateY(sdf.hexPrism(halfBeam * 0.30, halfLen * 0.16), Math.PI * 0.5),
		halfLen * 0.94, (freeboard - draught) * 0.5 + freeboard * 0.08, 0,
	), halfBeam * 0.18)

	// --- superstructure ------------------------------------------------------
	// Amidships and aft, and stepped: a block, then a smaller block on it. Two steps is the
	// least that reads as a superstructure rather than as a crate, and the step height follows
	// tech depth, so a later ship stands taller without being longer.
	const deckY = freeboard
	const houseH = freeboard * (0.62 + 0.24 * Math.min(p.techDepth, 3))
	const house = sdf.translate(
		sdf.roundBox(halfLen * 0.26, houseH, halfBeam * 0.60, p.bevelM * 3),
		-halfLen * 0.16, deckY + houseH, 0,
	)
	const bridge = sdf.translate(
		sdf.roundBox(halfLen * 0.13, houseH * 0.62, halfBeam * 0.40, p.bevelM * 3),
		-halfLen * 0.04, deckY + houseH * 2 + houseH * 0.62, 0,
	)
	// §9.1 on the join, exactly as the wheeled chassis does it: the Foundry fairs its
	// superstructure into the deck as one casting, the Lattice bolts it down as a separate
	// assembly. Same two shapes, two different machines.
	body = sdf.smoothUnion(body, sdf.union(house, bridge), k * 0.05)

	// --- mast ----------------------------------------------------------------
	// Every ship gets one, because a vertical is what breaks a low horizontal silhouette, and
	// a ship without one reads as a barge. Height follows the sensor range that every other
	// family spends on a blister — on a ship the mast IS the sensor.
	const mastH = Math.max(p.mastHeightM, freeboard * 0.9)
	const mastY = deckY + houseH * 2 + houseH * 1.24
	body = sdf.union(body, sdf.translate(
		upright(Math.max(0.022, halfBeam * 0.045), mastH * 0.5),
		-halfLen * 0.04, mastY + mastH * 0.5, 0,
	))
	// A yard across the mast: two crossed lines read as rigging where one reads as a pole.
	body = sdf.union(body, sdf.translate(
		sdf.roundBox(Math.max(0.02, halfBeam * 0.04), Math.max(0.015, halfBeam * 0.03), halfBeam * 0.42, 0.01),
		-halfLen * 0.04, mastY + mastH * 0.78, 0,
	))

	// --- armament ------------------------------------------------------------
	// Forward of the superstructure, on the foredeck, which is where a main gun goes and the
	// one place it does not foul the bridge. Same derived numbers as every other family, so a
	// ship's gun and a tank's gun are visibly the same calibre when the mod says they are.
	if (p.ringDiaM > 0 && p.barrelLenM > 0) {
		const ringR = p.ringDiaM * 0.5
		const gunY = deckY + Math.max(p.turretHeightM, freeboard * 0.30) * 0.5
		const boreR = Math.max(p.boreMm / 2200, 0.026)
		const tube = sdf.rotateY(sdf.cylinder(boreR, p.barrelLenM * 0.5), Math.PI * 0.5)
		// Every resolved Turreted instance gets its own subtree and bone. OpenRA publishes the
		// facings in this same stable trait order; welding a second naval turret into the first
		// one's subtree would make the secondary authoritative facing impossible to represent.
		const mounts: readonly (TurretSlot | null)[] = turretSlots?.length ? turretSlots : [null]
		for (let mountIndex = 0; mountIndex < mounts.length; mountIndex++) {
			const mount = mounts[mountIndex]
			const offset = mount?.offsetM
			const authored = offset !== undefined &&
				(Math.abs(offset[0]) + Math.abs(offset[1]) + Math.abs(offset[2])) > 1e-6
			const pivot: readonly [number, number, number] = authored
				? offset!
				: [halfLen * 0.42, gunY, 0]
			let turret = sdf.translate(
				upright(ringR, Math.max(p.turretHeightM, freeboard * 0.30) * 0.5),
				pivot[0], pivot[1], pivot[2],
			)
			const mantlet = sdf.translate(
				sdf.roundBox(boreR * 2.4, boreR * 2.4, boreR * 2.8, p.bevelM * 2),
				pivot[0] + ringR * 0.45, pivot[1] + ringR * 0.20, pivot[2],
			)
			turret = sdf.smoothUnion(turret, mantlet, k * 0.04)
			// The first resolved armament's LocalOffset is composed with its Turreted offset in
			// deriveChassis. Keep that authoritative projectile/flash origin inside the same
			// rotating subtree. Removing this mount while adding multi-turret support detached
			// three existing naval fixtures from their firing point.
			if (mountIndex === 0) turret = sdf.smoothUnion(turret, sdf.translate(
				sdf.roundBox(boreR * 2.4, boreR * 2.4, boreR * 2.8, p.bevelM * 2),
				p.muzzleM[0], p.muzzleM[1], p.muzzleM[2],
			), k * 0.04)
			const n = Math.min(Math.max(p.tubes, 1), 3)
			for (let i = 0; i < n; i++) {
				const z = n === 1 ? 0 : ((i / (n - 1)) - 0.5) * ringR * 1.1
				turret = sdf.union(turret, sdf.translate(
					tube,
					pivot[0] + ringR * 0.5 + p.barrelLenM * 0.5,
					pivot[1] + ringR * 0.20,
					pivot[2] + z,
				))
			}
			turretsOut?.push({ tree: turret, pivot })
			body = sdf.smoothUnion(body, turret, k * 0.04)
		}
	}

	// Model space is pinned: local +X is forward. A seeded whole-model yaw here used to make
	// the mesh disagree with the authoritative body/turret facing chain.
	return body
}
