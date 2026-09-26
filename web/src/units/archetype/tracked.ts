// STEELSEED — units/archetype/tracked
//
// The first family generator. One function builds every tracked ground vehicle in the
// roster, and the differences between a scout, a main battle tank and a self-propelled gun
// come entirely from `ChassisParams` — which come entirely from the slot's functional
// numbers (§14.13). Nothing here is authored per unit type, and nothing may be: the moment
// a generator special-cases an actor name, the roster stops being derivable and the whole
// argument for archetype generation collapses.
//
// MODEL SPACE, and this file is where the project's most recent geometry bug was paid for:
// §12.4 pins the renderer to **Y up, X forward, Z lateral**, while every axial primitive in
// `geo` — cylinder, cappedCone, hexPrism — stands along **Z**. So a turret is a cylinder
// tipped Z->Y, and a barrel is a cylinder aimed Z->X. Use `sdf.rotateX` / `sdf.rotateY` for
// those. `sdf.rotateZ` on any of them is a NO-OP, which is how a turret shipped rendering as
// a disc standing on edge and a gun barrel shipped pointing sideways across the hull.
// `rulecheck` rule 12.4a now flags exactly that call shape.

import * as sdf from '../../geo/sdf'
import { Zone, type ZoneRegion } from '../../geo/zone'
import type { Rng } from '../../core'
import type { ChassisParams } from './params'

/**
 * A finished articulated region retained after the complete actor has been welded together.
 *
 * The region is not meshed separately: the Foundry fillet between turret and hull is part of
 * the faction silhouette. `shapes` uses this descriptor to place a bone and bind the welded
 * surface, just as material zones label a finished mesh without splitting its geometry.
 */
export interface TrackedTurretRegion {
	readonly tree: sdf.Sdf
	/** Rotation pivot in model space, metres. */
	readonly pivot: readonly [number, number, number]
}

/**
 * A tracked hull.
 *
 * Massing follows the faction operator: the Foundry smooth-unions into one casting with no
 * daylight under it, the Lattice hard-unions so its silhouette stays mostly holes. That is
 * `op.joinRadius`, and it is the single parameter carrying most of §9.1's monochrome
 * silhouette test.
 *
 * `rng` is used ONLY for per-instance variation (§9.2) — never for proportions, never for
 * anything a player learns to read. Two units of the same type must be recognisably the same
 * machine or the five-frame-flash gate is unpassable by construction.
 */
export function buildTrackedVehicle(
	p: ChassisParams,
	rng: Rng,
	zones?: ZoneRegion[],
	turrets?: TrackedTurretRegion[],
): sdf.Sdf {
	const len = p.lengthM
	const halfLen = p.lengthM * 0.5
	const halfWid = p.widthM * 0.5
	const k = p.op.joinRadius

	// --- lower hull ----------------------------------------------------------
	// Deck height sits above the running gear, not on the ground. `clearanceM` already
	// carries the faction's ride height (§9.1: the Foundry is planted low, the Lattice runs
	// tall), so the hull floats on it rather than re-deriving it.
	const deckY = p.clearanceM + p.trackWidthM * 0.35
	const hullH = p.heightM * 0.45
	const lower = sdf.translate(
		sdf.roundBox(halfLen, hullH, halfWid, p.bevelM * 4),
		0, deckY + hullH, 0,
	)

	// Sloped glacis, cut off the nose. A cut plate reads as rolled armour where a modelled
	// wedge reads as a chamfered box, and thicker plate slopes harder — that is what plate
	// thickness BUYS visually, and it comes from HP per m squared.
	//
	// Cut with a ROTATED BOX, not a half-space. The first version used
	// `subtract(lower, negate(plane(...)))`, and `subtract(base, tool)` removes where TOOL is
	// inside — so negating the tool removed everything on the plane's inside and kept the
	// outside. It carved away the entire hull: measured, evalSdf at the hull's own centre
	// came back +0.39, i.e. outside its own geometry, with a gradient magnitude of 0.002
	// because the field there was a nearly flat plane. Every tracked vehicle was a few
	// scattered fragments, and it looked like a small dark tank rather than like an error.
	//
	// A placed box has no sign convention to get wrong, which is the same reason the Lattice
	// cross-brace is written directly on its axis instead of being rotated into place.
	const slopeAng = 0.62 - 0.30 * (p.plateMm / 60)
	const cutter = sdf.rotateZ(sdf.roundBox(len, len, halfWid * 3, 0.02), slopeAng)
	const hull = sdf.subtract(lower, sdf.translate(
		cutter,
		halfLen + len * 0.62 * Math.cos(slopeAng),
		deckY + hullH * 2 + len * 0.62 * Math.sin(slopeAng) - hullH * 0.9,
		0,
	))

	// --- running gear --------------------------------------------------------
	// Road wheels are individually placed rather than faired into a skirt, because the
	// wheel count is a derived identity cue (faster tracks run larger, fewer wheels) and a
	// skirt would hide the one thing the parameter exists to show.
	const runLenCap = p.lengthM * 0.86
	const wheels: sdf.Sdf[] = []
	// Radius follows TRACK WIDTH and is capped against the run length, so a long hull gets
	// more wheels rather than bigger ones. Tying it to clearance made a tall-riding chassis
	// grow monster-truck wheels, which is backwards — clearance is the gap, not the wheel.
	const wheelR = Math.min(p.trackWidthM * 0.52, runLenCap / Math.max(p.roadWheels, 4) * 0.62)
	const runLen = p.lengthM * 0.86
	const n = Math.max(p.roadWheels, 2)
	for (let i = 0; i < n; i++) {
		const t = n === 1 ? 0.5 : i / (n - 1)
		const x = -runLen * 0.5 + t * runLen
		// A cylinder stands along Z and Z is lateral, so a road wheel needs NO rotation.
		// This is the one axis in the file that is correct unrotated, and it is exactly the
		// coincidence that made the historical bug look internally consistent.
		const w = sdf.cylinder(wheelR, p.trackWidthM * 0.5)
		wheels.push(sdf.translate(w, x, p.clearanceM * 0.55 + wheelR * 0.5, halfWid))
	}
	const wheelsR = sdf.union(...wheels)
	const wheelsL = sdf.mirror(wheelsR, false, false, true)

	// The track run itself: a long rounded box faired over the wheels on each side.
	//
	// It has to ENCLOSE the wheels, and it did not. At trackH = wheelR * 1.35 the band was
	// 1.35 radii tall against wheels 2 radii across, and it was centred on the band rather
	// than on the wheels — so every wheel stood proud of the track above and below, and the
	// contact sheet showed six hulls riding on strings of beads. A real track wraps its road
	// wheels; the wheels are detail INSIDE the run, never the outline of it.
	//
	// 2.6 radii of band, centred on the wheel centre, clears a 2-radius wheel with margin at
	// both ends. The wheels still read — they break the band's silhouette at its lower edge
	// and they carry the derived wheel COUNT, which is the identity cue this family spends
	// its geometry on — but they no longer replace the track run.
	const trackH = wheelR * 2.3
	const wheelCentreY = p.clearanceM * 0.55 + wheelR * 0.5
	// Slightly wider than the wheels, so they do not poke through the flanks either.
	const trackBox = sdf.roundBox(halfLen * 0.94, trackH * 0.5, p.trackWidthM * 0.54, p.trackWidthM * 0.3)
	let trackRun: sdf.Sdf = sdf.translate(trackBox, 0, wheelCentreY, halfWid)
	// Drive sprocket and idler, one at each end and larger than a road wheel.
	//
	// Enclosing the wheels fixed the string of beads and cost the run its ends, which came out
	// as rounded stubs. On a real track the band rises over the sprocket at one end and the
	// idler at the other, and that rise is the most recognisable thing about a track in
	// profile — more so than the road wheels, which from an RTS camera are looking straight
	// down at a flat band and cannot be seen at all.
	//
	// So the wheel COUNT stays derived and stays in the model, but it is no longer asked to
	// carry identity from a camera that cannot see it. The ends do that instead.
	const endR = wheelR * 1.42
	for (const sx of [-1, 1]) {
		trackRun = sdf.smoothUnion(trackRun, sdf.translate(
			sdf.cylinder(endR, p.trackWidthM * 0.5),
			sx * halfLen * 0.94, wheelCentreY + endR * 0.18, halfWid,
		), p.trackWidthM * 0.12)
	}
	const trackR = trackRun
	const trackL = sdf.mirror(trackR, false, false, true)

	// --- turret and gun ------------------------------------------------------
	// k * 0.08 was a 0.24 m fillet on the Foundry (k = 3.0) — enough to melt road wheels into
	// the hull and turn the whole vehicle into a blob. The faction contrast is smooth VERSUS
	// hard, not smooth versus soup: a casting has fillets at its joins, not a 24 cm radius on
	// every edge. Seen on the contact sheet, which is what the sheet is for.
	const running = sdf.union(trackL, trackR, wheelsL, wheelsR)
	// The running gear is a MATERIAL region, not a separate mesh. It is smooth-unioned into
	// the hull one line below, because that fillet is what makes a Foundry hull read as one
	// continuous casting (§9.1) — splitting it out to paint it would delete the faction's
	// silhouette. `geo/zone` labels the welded surface instead.
	zones?.push({ zone: Zone.running, tree: running })

	let body = sdf.smoothUnion(hull, running, k * 0.022)

	if (p.ringDiaM > 0 && p.turretHeightM > 0) {
		const ringR = p.ringDiaM * 0.5
		const turretY = deckY + hullH * 2 + p.turretHeightM * 0.5
		// Tipped Z->Y. A cylinder here without rotateX is a wheel standing on edge.
		const drum = sdf.rotateX(sdf.cylinder(ringR, p.turretHeightM * 0.5), Math.PI * 0.5)
		// Seeded lean, per-instance only, well under the threshold where it could be read
		// as a different unit type.
		const lean = (rng.next() - 0.5) * 0.04
		let turret = sdf.translate(drum, -p.lengthM * 0.05, turretY + lean, 0)

		// The breech bustle. A slow reload is a manual breech and a long recoil stroke; a
		// fast one is an autoloader carousel. Either way it hangs off the BACK of the ring,
		// which is what makes turret front and rear distinguishable in silhouette.
		if (p.breechLenM > 0) {
			const bustle = sdf.roundBox(
				p.breechLenM * 0.32, p.turretHeightM * 0.34, ringR * 0.72, p.bevelM * 3,
			)
			turret = sdf.smoothUnion(
				turret,
				sdf.translate(bustle, -p.lengthM * 0.05 - ringR * 0.9, turretY, 0),
				k * 0.02,
			)
		}

		// THE MANTLET SITS WHERE THE SIMULATION FIRES FROM.
		//
		// `p.muzzleM` is `Armament.LocalOffset` composed with the turret offset, and the engine
		// calls it the weapon's position in turret coordinates — it is the MOUNT, not the barrel
		// tip. The mantlet is the mount: the armoured collar the barrel passes through. Putting
		// it at the authored point is therefore what that point MEANS, not a fudge to satisfy a
		// measurement, and it makes the actor solid where the shot is spawned so the flash and
		// the tracer leave the machine instead of the air beside it. Eleven of twelve tracked
		// actors failed that before this existed.
		//
		// It also gives this family its first consumer for `armourBias`, which is the one fact
		// the roster states outright about a weapon's ROLE and which only `infantry.ts` had ever
		// read. A gun built to defeat armour sits behind a narrow, deep, forward-swept mantlet,
		// because what it must survive is the return fire of the thing it shoots at; a
		// general-purpose gun faces no such threat and sits behind a broad shallow shield
		// covering a wider arc. Opposite shapes from one signed number.
		const mantletLen = Math.max(ringR * 0.16, ringR * (0.44 + 0.55 * p.armourBias))
		const mantletWid = ringR * (0.86 - 0.44 * p.armourBias)
		const mantletH = Math.max(p.turretHeightM * (0.46 + 0.26 * p.armourBias), ringR * 0.24)
		turret = sdf.smoothUnion(
			turret,
			sdf.translate(
				sdf.roundBox(mantletLen, mantletH, mantletWid, p.bevelM * 2),
				p.muzzleM[0], p.muzzleM[1], p.muzzleM[2],
			),
			k * 0.03,
		)

		if (p.barrelLenM > 0) {
			const boreR = Math.max(p.boreMm / 2000, 0.03)
			// Aimed Z->X. rotateY, never rotateZ.
			const tube = sdf.rotateY(sdf.cylinder(boreR, p.barrelLenM * 0.5), Math.PI * 0.5)
			// The barrel emerges from the ring, so its centre sits half a length forward of
			// the mantlet rather than of the hull.
			//
			// THE AUTHORED MUZZLE IS NOT CONSULTED AT ANY POINT, and this comment used to claim
			// it was — "see the parity check in `rostergate`", which does not exist. Barrel
			// length is derived from bore and range and then clamped by
			// `min(barrelRaw, lengthM * 0.85)`, which saturates for six of the twelve tracked
			// actors. Measured, ELEVEN OF TWELVE tracked actors have their authored muzzle
			// sitting in open air outside this mesh, so the shot leaves from beside the gun.
			// `tools/muzzlegate.mjs` holds the debt and the target.
			//
			// Fixing it is NOT solving for a tip at `muzzleM`: that point is the mount's spawn
			// position and for most of this roster it sits behind the hull nose, so a tip there
			// would bury the gun in its own chassis. What is needed is that the mount and breech
			// be solid AT that point, which is a massing question, not a barrel-length one.
			//
			// The clamp is still worth removing on its own merits — it is why foundry_anvil and
			// foundry_tongs generate identical 1.381 m barrels, and therefore part of why their
			// silhouettes collide.
			const barrelX = -p.lengthM * 0.05 + ringR * 0.6 + p.barrelLenM * 0.5
			let gun = sdf.translate(tube, barrelX, turretY, 0)

			// A muzzle brake is a real device on a high-energy gun and it is the single most
			// legible tell that a barrel is a BIG gun rather than a long one.
			if (p.muzzleBrake) {
				const brake = sdf.rotateY(sdf.cylinder(boreR * 1.9, boreR * 1.6), Math.PI * 0.5)
				gun = sdf.union(gun, sdf.translate(brake, barrelX + p.barrelLenM * 0.46, turretY, 0))
			}

			// Multi-tube launchers: a rocket pack is a stack of tubes, not one bore. `tubes`
			// comes straight from Armament.Burst.
			if (p.tubes > 1) {
				const spread = ringR * 0.9
				for (let i = 1; i < Math.min(p.tubes, 6); i++) {
					const off = (i / (Math.min(p.tubes, 6) - 1) - 0.5) * spread * 2
					gun = sdf.union(gun, sdf.translate(tube, barrelX, turretY + Math.abs(off) * 0.35, off))
				}
			}
			turret = sdf.union(turret, gun)
		}
		// Retain the COMPLETE subtree, after bustle, barrel and brake have joined it but before
		// it is welded into the chassis. The mesh stays one surface; this is only the capture
		// description for the turret bone.
		turrets?.push({ tree: turret, pivot: [-p.lengthM * 0.05, turretY, 0] })
		body = sdf.smoothUnion(body, turret, k * 0.025)
	} else if (p.boreMm > 0) {
		// A CASEMATE, for a vehicle that carries a gun and no turret.
		//
		// Six armed actors in this roster have an Armament and no `Turreted` — three tracked and
		// three wheeled — and every scrap of weapon geometry above is gated on `ringDiaM > 0`,
		// which is zero without a turret. So all six were drawn as BARE HULLS. foundry_kiln
		// fields a 480-damage gun at 9 m range and rendered as an unarmed truck; lattice_aperture
		// carries 420 and did the same.
		//
		// A fixed mount is not a turret that failed to appear, it is a different machine, and it
		// should look like one. No ring and no traverse, and in exchange a low sloped fighting
		// compartment carrying a heavier gun than the same chassis could ever turn — which is
		// precisely why the class exists. That is a silhouette this family did not previously
		// own, so it separates as well as completes.
		const boreR = Math.max(p.boreMm / 2000, 0.03)
		const caseH = hullH * 0.85
		const caseY = deckY + hullH * 2 + caseH
		let mount = sdf.translate(
			sdf.roundBox(halfLen * 0.46, caseH, halfWid * 0.84, p.bevelM * 3),
			-halfLen * 0.10, caseY, 0,
		)
		// Sloped front, cut with a rotated box exactly as the glacis is, so the compartment
		// reads as rolled plate rather than as a crate left on the deck. Same `slopeAng`, so a
		// thickly armoured casemate slopes harder for the same reason its hull does.
		mount = sdf.subtract(mount, sdf.translate(
			sdf.rotateZ(sdf.roundBox(len, len, halfWid * 3, 0.02), slopeAng),
			-halfLen * 0.10 + halfLen * 0.46 + len * 0.62 * Math.cos(slopeAng),
			caseY + caseH + len * 0.62 * Math.sin(slopeAng) - caseH * 0.9,
			0,
		))
		// The mantlet, at the authored mount point — same reasoning as the turreted branch.
		mount = sdf.smoothUnion(
			mount,
			sdf.translate(
				sdf.roundBox(boreR * 2.4, boreR * 2.4, boreR * 2.8, p.bevelM * 2),
				p.muzzleM[0], p.muzzleM[1], p.muzzleM[2],
			),
			k * 0.03,
		)
		if (p.barrelLenM > 0) {
			// Aimed Z->X. rotateY, never rotateZ.
			const tube = sdf.rotateY(sdf.cylinder(boreR, p.barrelLenM * 0.5), Math.PI * 0.5)
			mount = sdf.union(mount, sdf.translate(
				tube, p.muzzleM[0] + p.barrelLenM * 0.5, p.muzzleM[1], p.muzzleM[2],
			))
		}
		body = sdf.smoothUnion(body, mount, k * 0.025)
	}

	// --- sensor mast ---------------------------------------------------------
	// Only where vision genuinely exceeds the roster median. A stub on everything would
	// make the cue meaningless, which is the whole reason `mastHeightM` clamps to 0.
	if (p.mastHeightM > 0.05) {
		const mast = sdf.roundBox(0.05, p.mastHeightM * 0.5, 0.05, 0.02)
		const mastY = deckY + hullH * 2 + p.mastHeightM * 0.5
		body = sdf.union(body, sdf.translate(mast, -halfLen * 0.72, mastY, halfWid * 0.55))
	}

	return body
}
