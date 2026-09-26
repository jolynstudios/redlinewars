// STEELSEED — units/archetype/wheeled
//
// The wheeled ground family. Shares every derived parameter with `tracked` and differs in
// exactly the way §9.1 says the factions differ: **solid cast mass versus open bolted
// framework**. That contrast is carried by `op.joinRadius` (the `smoothUnion` k) and by the
// running gear being individually mounted rather than faired into a hull.
//
// The Lattice's silhouette is supposed to be MOSTLY HOLES. Smoothing these joints would fill
// exactly the gaps that carry its identity, which is why the unions here are hard and the
// frame members are deliberately thin. A wheeled vehicle that reads as a solid box has failed
// the monochrome test regardless of how well it is textured.
//
// Model space and rotation rules are identical to `tracked.ts` — §12.4 pins Y up, X forward,
// Z lateral; geo primitives stand along Z. Wheels take NO rotation because a Z axle is
// already lateral.

import * as sdf from '../../geo/sdf'

import { Zone, type ZoneRegion } from '../../geo/zone'
import type { Rng } from '../../core'
import type { ChassisParams } from './params'
import type { TrackedTurretRegion } from './tracked'

/** A wheeled hull: a frame on exposed running gear, with daylight under the whole vehicle. */
/**
 * One rideable wheel, retained after the hull is welded together.
 *
 * Not meshed separately: §9.1's Lattice contrast is a thin spine over EXPOSED wheels, and the
 * hard union that produces it is the faction's silhouette. `shapes` places a bone at the axle
 * and binds the welded surface, exactly as the tracked turret does.
 *
 * `axleHalfWidth` is the capture segment's reach along the axle, and `radius` is what converts
 * travelled distance into rotation — a wheel turns once per 2*pi*r of ground, which is a fact
 * about the wheel rather than a number anyone chooses.
 */
export interface WheelRegion {
	readonly tree: sdf.Sdf
	/** Axle centre in model space, metres. */
	readonly pivot: readonly [number, number, number]
	readonly radius: number
	readonly axleHalfWidth: number
}

export function buildWheeledVehicle(
	p: ChassisParams,
	rng: Rng,
	zones?: ZoneRegion[],
	wheelsOut?: WheelRegion[],
	turretsOut?: TrackedTurretRegion[],
): sdf.Sdf {
	const halfLen = p.lengthM * 0.5
	const halfWid = p.widthM * 0.5
	const k = p.op.joinRadius

	// Ride height is the faction cue §9.1 names explicitly, and `clearanceM` already carries
	// the operator's scale — the Lattice runs tall, the Foundry sits planted.
	const clear = p.clearanceM
	// A wheel is smaller than the ride height it produces, not larger. Deriving radius from
	// clearance at 0.62 gave a 0.45 m radius on a 2.2 m vehicle — monster-truck proportions
	// that dominated the silhouette and buried the frame the faction is supposed to show.
	// The semantic radius still comes from clearance/axles, with one geometric lower bound:
	// a declared wheel must survive the production surface-net grid so it can own vertices and
	// rotate. Below ~7.5% of the chassis minor axis it is a sub-cell decoration, not running gear.
	const wheelR = Math.max(
		Math.min(clear * 0.42, p.lengthM / Math.max(p.axles, 2) * 0.30),
		Math.min(p.lengthM, p.widthM) * 0.11,
	)
	const deckY = clear + wheelR * 0.55

	// --- frame ---------------------------------------------------------------
	// A spine, not a hull. Thin, and everything else hangs off it. Its depth follows plate
	// thickness so an armoured wheeled gun still reads heavier than a scout, without the
	// frame closing up into a box.
	const spineH = 0.07 + 0.10 * (p.plateMm / 60)
	const spine = sdf.translate(
		sdf.roundBox(halfLen, spineH, halfWid * 0.30, p.bevelM * 2),
		0, deckY + spineH, 0,
	)

	// Two longitudinal rails, with visible air between them and the spine.
	const rail = sdf.roundBox(halfLen * 0.98, 0.055, 0.05, 0.02)
	const railR = sdf.translate(rail, 0, deckY + 0.02, halfWid * 0.78)
	const railL = sdf.mirror(railR, false, false, true)

	// Cross-braces. Long in Z — lateral — written on the axis they belong on so there is no
	// rotation to get wrong (rule 12.4a). Count follows length, so a long chassis is visibly
	// a longer truss rather than a stretched one.
	const braceCount = Math.max(2, Math.min(5, Math.round(p.lengthM / 0.85)))
	const braces: sdf.Sdf[] = []
	for (let i = 0; i < braceCount; i++) {
		const t = braceCount === 1 ? 0.5 : i / (braceCount - 1)
		const x = -halfLen * 0.82 + t * halfLen * 1.64
		braces.push(sdf.translate(
			sdf.roundBox(0.045, 0.045, halfWid * 0.82, 0.02),
			x, deckY + spineH * 0.6, 0,
		))
	}

	// --- the two masses the frame carries ------------------------------------
	//
	// §9.1 makes the Lattice an open bolted framework and this generator was right to build a
	// spine rather than a hull. It went one step too far: with nothing but a spine, rails and
	// braces there is no VOLUME anywhere on the vehicle, and the contact sheet showed six flat
	// trolleys. An open-framework machine — a technical, a buggy, a flatbed — is still not
	// empty. It has an engine over the drive axle and a crew station, and the frame is what
	// you can see BETWEEN them. Take those away and a chassis stops reading as a vehicle.
	//
	// Both are derived. The engine follows plate and length, because a heavier, longer chassis
	// needs more powerplant to move it; the cab follows the same plate, because that is the
	// armour the crew sits behind. Neither closes the frame — they sit ON it, forward and
	// amidships, with the rails and braces still visible fore, aft and between.
	const engineH = spineH * (1.5 + 1.4 * (p.plateMm / 60))
	const engine = sdf.translate(
		sdf.roundBox(halfLen * 0.24, engineH, halfWid * 0.52, p.bevelM * 3),
		halfLen * 0.56, deckY + spineH + engineH, 0,
	)
	// A crew box, set back from the engine and taller than it — the one place on a Lattice
	// machine where a person has to fit, so it is sized by a person and not by a curve.
	const cabH = Math.max(engineH * 1.15, 0.16)
	const cab = sdf.translate(
		sdf.roundBox(halfLen * 0.20, cabH, halfWid * 0.44, p.bevelM * 3),
		-halfLen * 0.06, deckY + spineH + cabH, 0,
	)

	// --- running gear --------------------------------------------------------
	// Axle count is derived (4x4 / 6x6 / 8x8 per §9.1) and must READ, so wheels are mounted
	// clear of the frame with nothing fairing them in.
	const axles = Math.max(p.axles, 2)
	const runLen = p.lengthM * 0.80
	const wheels: sdf.Sdf[] = []
	for (let i = 0; i < axles; i++) {
		const t = axles === 1 ? 0.5 : i / (axles - 1)
		const x = -runLen * 0.5 + t * runLen
		// Suspension travel offsets alternate axles very slightly, so a long chassis does not
		// read as a rigid comb. Well under the threshold where it could be mistaken for a
		// different vehicle (§9.2).
		const sag = (i % 2 === 0 ? 1 : -1) * p.suspTravelM * 0.12
		const halfW = Math.max(p.trackWidthM, 0.11) * 0.5
		const wy = clear * 0.62 + wheelR * 0.5 + sag
		const wz = halfWid * 0.92
		const wheelAt = (side: number): sdf.Sdf => {
			const tyre = sdf.translate(sdf.cylinder(wheelR, halfW), x, wy, wz * side)
			// An exposed outer hub guarantees that every declared wheel contributes finished
			// surface geometry even where a cab or weapon bustle overlaps the tyre's inner half.
			const hub = sdf.translate(
				sdf.cylinder(wheelR * 0.58, halfW * 0.24),
				x, wy, wz * side + side * halfW * 1.02,
			)
			return sdf.union(tyre, hub)
		}
		wheels.push(wheelAt(1))
		// Both sides, because the left bank is a MIRROR of this union and a mirrored SDF has no
		// separate sub-tree to hand a bone. Emitting the pair here keeps the rig's wheel count
		// equal to the axle count the roster derived, which is the identity cue this family
		// spends its geometry on.
		if (wheelsOut !== undefined) {
			for (const side of [1, -1]) {
				wheelsOut.push({
					tree: wheelAt(side),
					pivot: [x, wy, wz * side],
					radius: wheelR,
					axleHalfWidth: halfW,
				})
			}
		}
	}
	const wheelsR = sdf.union(...wheels)
	const wheelsL = sdf.mirror(wheelsR, false, false, true)
	// Tyres and the exposed undercarriage rails/cross-members are one running-material region on the welded
	// surface, not a separate mesh — see tracked.ts. The rails matter on the smallest chassis:
	// its tyre is thinner than one production mesher cell and contributes no finished-surface
	// vertices, while the undercarriage it bolts to remains visible. Labelling only the source
	// tyre would leave that uploaded actor flat-painted despite the generator being "zoned".
	zones?.push({ zone: Zone.running, tree: sdf.union(wheelsL, wheelsR, railL, railR, ...braces) })

	// Hard union throughout. This is the faction contrast and it is not negotiable.
	// The masses are smooth-unioned to the frame at the operator's radius and the frame members
	// are hard-unioned to each other, which is the §9.1 contrast doing its job on ONE model:
	// bolted where members meet, faired where a casting sits on them.
	let chassis = sdf.smoothUnion(
		sdf.union(spine, railL, railR, ...braces),
		sdf.union(engine, cab),
		p.op.joinRadius * 0.03,
	)
	let shapedSpine = spine
	if (p.plan !== null && p.plan.length >= 3) {
		// The authored HitShape is the chassis plan, not a replacement vehicle. Clip only the
		// frame and the two masses it carries; wheels, turret, mast and equipment keep their
		// functional geometry. Coordinates remain in the actor's authored model space — the
		// asymmetric outline is not recentered or fitted to the rectangular bounds.
		const planVolume = sdf.convexPlanPrism(p.plan, deckY + p.heightM, deckY)
		chassis = sdf.intersect(chassis, planVolume)
		shapedSpine = sdf.intersect(spine, planVolume)
	}
	let body = sdf.union(
		chassis,
		wheelsL, wheelsR,
	)

	// --- turret and gun ------------------------------------------------------
	if (p.ringDiaM > 0 && p.turretHeightM > 0) {
		const ringR = p.ringDiaM * 0.5
		const turretY = deckY + spineH * 2 + p.turretHeightM * 0.5
		// Tipped Z->Y. rotateZ here would be a no-op (rule 12.4a).
		const drum = sdf.rotateX(sdf.cylinder(ringR, p.turretHeightM * 0.5), Math.PI * 0.5)
		let turret = sdf.translate(drum, 0, turretY, 0)

		if (p.breechLenM > 0) {
			const bustle = sdf.roundBox(p.breechLenM * 0.28, p.turretHeightM * 0.30, ringR * 0.66, p.bevelM * 2)
			turret = sdf.union(turret, sdf.translate(bustle, -ringR * 0.95, turretY, 0))
		}

		// THE MANTLET SITS WHERE THE SIMULATION FIRES FROM.
		//
		// `p.muzzleM` is `Armament.LocalOffset` composed with the turret offset — the engine
		// calls it the weapon's position in turret coordinates, so it is the MOUNT and not the
		// barrel tip. The mantlet is the mount, so putting it at the authored point is what that
		// point means rather than a fudge to satisfy a measurement.
		//
		// TWELVE OF TWELVE wheeled actors had their authored muzzle floating in open air before
		// this existed, every one of them with the gun drawn too HIGH — a mean of 27 cm above the
		// point the simulation actually spawns the shot from.
		//
		// Unioned rather than smooth-unioned, for the same §9.1 reason the turret below is: on
		// this faction the weapon is a bolted-on module and a fillet would read as a casting.
		const mantletLen = Math.max(ringR * 0.16, ringR * (0.44 + 0.55 * p.armourBias))
		const mantletWid = ringR * (0.86 - 0.44 * p.armourBias)
		const mantletH = Math.max(p.turretHeightM * (0.46 + 0.26 * p.armourBias), ringR * 0.24)
		turret = sdf.union(turret, sdf.translate(
			sdf.roundBox(mantletLen, mantletH, mantletWid, p.bevelM * 2),
			p.muzzleM[0], p.muzzleM[1], p.muzzleM[2],
		))

		if (p.barrelLenM > 0) {
			const boreR = Math.max(p.boreMm / 2000, 0.028)
			// Aimed Z->X.
			const tube = sdf.rotateY(sdf.cylinder(boreR, p.barrelLenM * 0.5), Math.PI * 0.5)
			const barrelX = ringR * 0.6 + p.barrelLenM * 0.5
			let gun = sdf.translate(tube, barrelX, turretY, 0)
			if (p.muzzleBrake) {
				const brake = sdf.rotateY(sdf.cylinder(boreR * 1.85, boreR * 1.5), Math.PI * 0.5)
				gun = sdf.union(gun, sdf.translate(brake, barrelX + p.barrelLenM * 0.46, turretY, 0))
			}
			if (p.tubes > 1) {
				const n = Math.min(p.tubes, 6)
				const spread = ringR * 0.85
				for (let i = 1; i < n; i++) {
					const off = (i / (n - 1) - 0.5) * spread * 2
					gun = sdf.union(gun, sdf.translate(tube, barrelX, turretY + Math.abs(off) * 0.3, off))
				}
			}
			turret = sdf.union(turret, gun)
		}
		// Smoothed only against itself, never into the frame — the turret is a bolted-on
			// module on this faction, and a smooth join would read as a casting.
			turretsOut?.push({ tree: turret, pivot: [0, turretY, 0] })
			body = sdf.union(body, turret)
	} else if (p.boreMm > 0) {
		// A PINTLE CASEMATE, for a wheeled vehicle that carries a gun and no turret.
		//
		// Three wheeled actors have an Armament and no `Turreted`, and every scrap of weapon
		// geometry above is gated on `ringDiaM > 0`, which is zero without one. So lattice_kite,
		// lattice_phase and lattice_aperture — the last of them fielding 420 damage — were all
		// drawn as UNARMED TRUCKS.
		//
		// On a frame rather than a hull the answer is not the Foundry's sloped casemate box: it
		// is an open pintle mount on the spine, which is what a fixed gun looks like when it is
		// bolted to a framework instead of set into armour. §9.1's contrast holds right down to
		// how a vehicle carries a weapon it cannot turn.
		const boreR = Math.max(p.boreMm / 2000, 0.028)
		const pedH = Math.max(p.muzzleM[1] - (deckY + spineH * 2), boreR * 2)
		let mount = sdf.translate(
			sdf.roundBox(boreR * 1.5, pedH * 0.5, boreR * 1.5, p.bevelM * 2),
			p.muzzleM[0], deckY + spineH * 2 + pedH * 0.5, p.muzzleM[2],
		)
		// The cradle, at the authored mount point.
		mount = sdf.union(mount, sdf.translate(
			sdf.roundBox(boreR * 2.2, boreR * 2.2, boreR * 2.6, p.bevelM * 2),
			p.muzzleM[0], p.muzzleM[1], p.muzzleM[2],
		))
		if (p.barrelLenM > 0) {
			// Aimed Z->X. rotateY, never rotateZ.
			const tube = sdf.rotateY(sdf.cylinder(boreR, p.barrelLenM * 0.5), Math.PI * 0.5)
			mount = sdf.union(mount, sdf.translate(
				tube, p.muzzleM[0] + p.barrelLenM * 0.5, p.muzzleM[1], p.muzzleM[2],
			))
		}
		body = sdf.union(body, mount)
	}

	// --- mast and pannier ----------------------------------------------------
	// §9.1 calls the tall mast the Lattice's most recognisable feature at zoom-out, and it is
	// what makes its bounding silhouette tall and narrow where the Foundry's is low and wide.
	// Always present on this family, extended further where vision genuinely exceeds median.
	const mastH = 0.45 + p.mastHeightM
	const mastY = deckY + spineH * 2 + mastH * 0.5
	body = sdf.union(body, sdf.translate(
		sdf.roundBox(0.045, mastH * 0.5, 0.045, 0.02),
		-halfLen * 0.78, mastY, halfWid * 0.35,
	))
	// Amber hazard beacon on the mast head (§9.1). Geometry only — the emitter itself is a
	// punctual light submitted by `units`, and §12.1's emissive channel is not wired yet.
	body = sdf.union(body, sdf.translate(sdf.sphere(0.055), -halfLen * 0.78, mastY + mastH * 0.5, halfWid * 0.35))

	// Equipment pannier, offset to one side. Per-instance seed only (§9.2) — which side, not
	// whether. Asymmetry reads as improvised kit rather than as a different vehicle.
	const side = rng.next() < 0.5 ? -1 : 1
	body = sdf.union(body, sdf.translate(
		sdf.roundBox(p.lengthM * 0.14, 0.11, 0.07, 0.025),
		halfLen * 0.22, deckY + spineH * 0.9, side * halfWid * 0.72,
	))

	// A single smoothing pass at the operator's radius. For the Lattice `joinRadius` is 0.2,
	// so this is nearly a no-op and the frame stays open; for a Foundry-operated wheeled
	// exception it closes the gear into the body as that faction requires.
	return sdf.smoothUnion(body, shapedSpine, k * 0.03)
}
