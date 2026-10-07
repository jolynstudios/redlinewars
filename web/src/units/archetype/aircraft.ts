// STEELSEED — units/archetype/aircraft
//
// Rotorcraft and fixed-wing, in one function, because they are the same machine with the
// lift surface moved: a fuselage, a lift device, a tail that stabilises it, and gear. The
// families are separate entries in the taxonomy but a single generator serves both, and the
// branch between them is derived rather than declared.
//
// THE ROTOR-VERSUS-WING SIGNAL, and its honest status.
//
// `Aircraft.CanHover` / `Aircraft.VTOL` is the authoritative fact, and it is NOT in the
// export — aircraft carry no `Mobile` trait at all, so speed and locomotor arrive null too.
// Until the exporter emits it, the signal used here is **span versus length**, taken from
// `Selectable.Bounds`, and it is a real aerodynamic fact rather than a convention: a wing
// aircraft is wider than it is long because the span IS the lift surface, while a rotorcraft
// is longer than it is wide because its lift is overhead and its length is tail boom.
//
// Measured on the current roster, it separates cleanly and along faction lines:
//
//   foundry_bellows   1.75 long x 1.13 span   ratio 0.64   -> rotorcraft
//   foundry_flywheel  1.63 long x 0.88 span   ratio 0.54   -> rotorcraft
//   lattice_helix     1.00 long x 1.63 span   ratio 1.63   -> fixed wing
//   lattice_vesper    0.88 long x 1.75 span   ratio 2.00   -> fixed wing
//
// That is a clean split with a wide margin, and it matches §9.1 — the Foundry is the heavy,
// planted faction and the Lattice the light, fast one. But it is an INFERENCE from a
// selection box, and a selection box is authored for picking rather than for aerodynamics.
// If the exporter ever emits `CanHover`, use it and delete this.

import * as sdf from '../../geo/sdf'
import { Zone, type ZoneRegion } from '../../geo/zone'
import type { Rng } from '../../core'
import type { ChassisParams } from './params'

/** Span-to-length ratio above which the lift surface is a wing rather than a rotor. */
const WING_RATIO = 1.0

export function buildAircraft(p: ChassisParams, rng: Rng, zones?: ZoneRegion[]): sdf.Sdf {
	const len = p.lengthM
	const span = p.widthM
	const halfLen = len * 0.5
	// ROTOR OR WING IS A FACT THE MOD STATES, NOT ONE TO INFER FROM A BOUNDING BOX.
	//
	// This was `span / len >= WING_RATIO` alone, and measured against the live roster that guess
	// was WRONG IN BOTH DIRECTIONS: foundry_flywheel is not VTOL and was drawn as a helicopter,
	// while lattice_helix is VTOL and was drawn as a fixed-wing plane. The proxy only looked
	// plausible because Foundry aircraft happen to be authored longer-than-wide and Lattice ones
	// wider-than-long — a coincidence of their selection boxes, not a fact about the machines.
	// It is the same failure as the old "Burst > 1 means anti-air" proxy that `plant.ts` records,
	// and it gets the same remedy: read what the mod says.
	//
	// The ratio survives ONLY as the fallback for an export that predates the `Aircraft` block,
	// so a stale roster still generates something rather than throwing. `vtol === null` is the
	// one case that reaches it; a stated `false` is a fixed wing and is obeyed.
	const isWing = p.vtol === null ? span / Math.max(len, 0.01) >= WING_RATIO : !p.vtol
	const k = p.op.joinRadius

	// Aircraft sit ON their gear, not on the ground, and the whole machine reads wrong if the
	// fuselage touches down. Gear height follows plate thickness only weakly — an aircraft is
	// thin-skinned whatever its armour class, which is itself a real distinction from a tank.
	const gearH = 0.16 + 0.10 * (p.plateMm / 60)
	// Fuselage radius follows LENGTH, never span. Taking max(span, len) meant that on a wing
	// aircraft — where span is by definition the larger — the LIFT SURFACE set the thickness of
	// the body, so the wider the wing the fatter the fuselage. That is backwards in the most
	// direct way: a glider has an enormous span and a needle of a body. Measured, it gave
	// lattice_vesper a radius of 0.198 of its own fuselage length against 0.115 for the two
	// rotorcraft, and the contact sheet duly showed two torpedoes with stub wings where the
	// Lattice's fast aircraft should be.
	//
	// Length alone puts all four at the same fineness ratio, about 8.7 to 1, which is an
	// ordinary aircraft proportion. The rotorcraft are unaffected: they are longer than they
	// are wide, so max() was already returning their length.
	const bodyR = len * 0.115
	const fuseY = gearH + bodyR * 1.3

	// --- fuselage ------------------------------------------------------------
	// A capsule down the X axis: endpoints, so no rotation to get wrong. Nose slightly
	// forward of the bounds so the silhouette has a direction at zoom.
	let body = sdf.capsule(-halfLen * 0.82, fuseY, 0, halfLen * 0.92, fuseY, 0, bodyR)

	// A cockpit blister, offset forward and up. At RTS zoom this is most of what says
	// "aircraft" rather than "tube".
	const cockpit = sdf.translate(
		sdf.sphere(bodyR * 1.05),
		halfLen * 0.42, fuseY + bodyR * 0.42, 0,
	)
	body = sdf.smoothUnion(body, cockpit, 0.06)

	if (isWing) {
		// --- fixed wing ------------------------------------------------------
		// The wing is the span, and it is the silhouette. Swept back, because a straight
		// rectangular plank reads as a paper dart and sweep is what makes it read as fast —
		// which is also what the Lattice's numbers say it is.
		const sweep = halfLen * 0.30
		const halfSpan = span * 0.5
		const chord = len * 0.26
		const wingR = bodyR * 0.30
		let liftSurface = sdf.union(sdf.capsule(
			sweep * 0.5, fuseY, 0,
			-sweep, fuseY - bodyR * 0.10, halfSpan,
			wingR,
		), sdf.capsule(
			sweep * 0.5, fuseY, 0,
			-sweep, fuseY - bodyR * 0.10, -halfSpan,
			wingR,
		))
		// Chord thickness: a thin plate along the wing so it is a surface, not a rod.
		for (const s of [1, -1]) {
			liftSurface = sdf.union(liftSurface, sdf.translate(
				sdf.roundBox(chord * 0.5, wingR * 0.55, halfSpan * 0.44, 0.02),
				-sweep * 0.35, fuseY - bodyR * 0.05, s * halfSpan * 0.55,
			))
		}
		if (p.plan !== null && p.plan.length >= 3) {
			// The authored plan becomes the thin structural lift surface seen from above. It
			// replaces only the generic wing members, not the aircraft: fuselage, tail, armament
			// and gear remain derived from their functional inputs. Merely intersecting the old
			// members with this outline moved one raster pixel on one actor and zero on the other;
			// a consumed value that cannot reach the player is still an unconsumed value.
			liftSurface = sdf.convexPlanPrism(p.plan, wingR * 0.55, fuseY - bodyR * 0.05)
		}
		body = sdf.union(body, liftSurface)
		// Tailplane and fin. The fin is vertical and it is the one part that survives a
		// head-on silhouette, which is when a wing aircraft is otherwise a dot.
		body = sdf.union(body, sdf.translate(
			sdf.roundBox(len * 0.09, wingR * 0.5, span * 0.20, 0.02),
			-halfLen * 0.80, fuseY, 0,
		))
		body = sdf.union(body, sdf.translate(
			sdf.roundBox(len * 0.10, bodyR * 1.5, wingR * 0.5, 0.02),
			-halfLen * 0.78, fuseY + bodyR * 1.5, 0,
		))
	} else {
		// --- rotorcraft ------------------------------------------------------
		// Mast, disc and tail boom. The rotor is drawn as a THIN DISC rather than as blades:
		// a turning rotor is a disc to the eye, blades would alias to noise at this size, and
		// the disc is also what `anim` will spin. `BoneKind.rotor` exists in geo/rig for it.
		const mastH = bodyR * 1.5
		const mastY = fuseY + bodyR * 0.7
		body = sdf.union(body, sdf.translate(
			sdf.roundBox(bodyR * 0.22, mastH * 0.5, bodyR * 0.22, 0.02),
			halfLen * 0.05, mastY + mastH * 0.5, 0,
		))
		// Diameter 1.04x fuselage length. Measured against real machines: a UH-60 runs 1.07x
		// and an AH-64 0.97x, and this was at 1.24x — a rotor a fifth larger than any
		// helicopter that exists.
		const discR = Math.max(len, span) * 0.52
		// An ANNULUS, not a solid disc. A turning rotor's mass is at the tips, and a solid
		// plate at RTS zoom hides the entire aircraft underneath it — the fuselage, the boom
		// and the weapons all disappear under a lid. A ring reads as rotation and lets the
		// machine show through, which is the whole reason the aircraft is drawn at all.
		//
		// Blades were the other option and are worse: at this size they alias into noise, and
		// they would have to be animated to read as anything but a static cross.
		const discY = mastY + mastH
		const ring = sdf.subtract(
			sdf.rotateX(sdf.cylinder(discR, 0.016), Math.PI * 0.5),
			sdf.rotateX(sdf.cylinder(discR * 0.78, 0.05), Math.PI * 0.5),
		)
		body = sdf.union(body, sdf.translate(ring, halfLen * 0.05, discY, 0))
		// A hub, so the ring is visibly attached to the mast rather than floating.
		body = sdf.union(body, sdf.translate(
			sdf.rotateX(sdf.cylinder(bodyR * 0.34, 0.03), Math.PI * 0.5),
			halfLen * 0.05, discY, 0,
		))
		// Tail boom and anti-torque rotor. The boom is what makes the length-dominant
		// footprint read as a helicopter rather than as a stubby plane.
		body = sdf.smoothUnion(body, sdf.capsule(
			-halfLen * 0.55, fuseY, 0,
			-halfLen * 1.18, fuseY + bodyR * 0.35, 0,
			bodyR * 0.34,
		), 0.05)
		// Anti-torque rotor, same reasoning: a ring rather than a plate on the tail.
		const tailR = discR * 0.24
		const tailRing = sdf.subtract(
			sdf.rotateY(sdf.cylinder(tailR, 0.013), Math.PI * 0.5),
			sdf.rotateY(sdf.cylinder(tailR * 0.72, 0.05), Math.PI * 0.5),
		)
		body = sdf.union(body, sdf.translate(tailRing, -halfLen * 1.20, fuseY + bodyR * 0.55, bodyR * 0.30))
		// A vertical fin on the boom, so the tail has a shape head-on.
		body = sdf.union(body, sdf.translate(
			sdf.roundBox(len * 0.07, bodyR * 1.0, bodyR * 0.18, 0.02),
			-halfLen * 1.02, fuseY + bodyR * 1.1, 0,
		))
	}

	// --- armament ------------------------------------------------------------
	// Wing or stub pylons. Aircraft weapons hang UNDER the lift surface, which is a real
	// constraint and also the only place they read from above — the camera angle this game
	// is played at sees the top of an aircraft and almost nothing of its flanks.
	if (p.barrelLenM > 0) {
		const podR = Math.max(p.boreMm / 2200, 0.03)
		const podLen = Math.max(p.barrelLenM * 0.45, 0.22)
		const at = isWing ? span * 0.30 : len * 0.24
		// THE MOUNT SITS WHERE THE SIMULATION FIRES FROM. `p.muzzleM` is `Armament.LocalOffset`
		// composed with the turret offset; the engine calls it the weapon's position in turret
		// coordinates, so it is the MOUNT and not the barrel tip. Being solid there is what
		// stops the shot and its flash leaving from open air. See tracked.ts for the argument.
		body = sdf.union(body, sdf.translate(
			sdf.roundBox(podR * 2.0, podR * 1.7, podR * 1.7, 0.02),
			p.muzzleM[0], p.muzzleM[1], p.muzzleM[2],
		))
		for (const s of [1, -1]) {
			body = sdf.union(body, sdf.capsule(
				podLen * 0.55, fuseY - bodyR * 0.75, s * at,
				-podLen * 0.45, fuseY - bodyR * 0.75, s * at,
				podR,
			))
		}
		// Burst > 1 means a pod rather than a single tube, and a visibly fatter pod is the
		// only way that difference survives the zoom.
		if (p.tubes > 1) {
			for (const s of [1, -1]) {
				body = sdf.union(body, sdf.translate(
					sdf.roundBox(podLen * 0.30, podR * 1.2, podR * 1.3, 0.02),
					0, fuseY - bodyR * 0.85, s * at,
				))
			}
		}
	}

	// --- landing gear --------------------------------------------------------
	// Skids for a rotorcraft, a wheel tricycle for a wing. Small, but an aircraft with no
	// gear looks like it is embedded in the ground when it lands, and both factions land.
	if (isWing) {
		for (const [x, z] of [[halfLen * 0.45, 0], [-halfLen * 0.25, span * 0.20], [-halfLen * 0.25, -span * 0.20]]) {
			body = sdf.union(body, sdf.capsule(x, fuseY - bodyR * 0.6, z, x, gearH * 0.4, z, 0.022))
			body = sdf.union(body, sdf.translate(sdf.cylinder(gearH * 0.34, 0.02), x, gearH * 0.34, z))
		}
	} else {
		for (const s of [1, -1]) {
			body = sdf.union(body, sdf.capsule(
				halfLen * 0.45, gearH * 0.30, s * bodyR * 1.15,
				-halfLen * 0.55, gearH * 0.30, s * bodyR * 1.15,
				0.026,
			))
			body = sdf.union(body, sdf.capsule(
				halfLen * 0.20, fuseY - bodyR * 0.7, s * bodyR * 0.5,
				halfLen * 0.20, gearH * 0.30, s * bodyR * 1.15,
				0.020,
			))
		}
	}

	// A sensor blister where vision genuinely exceeds the roster median — same rule as every
	// other family, so a scout aircraft is visibly a scout.
	if (p.mastHeightM > 0.02) {
		body = sdf.union(body, sdf.translate(
			sdf.sphere(bodyR * 0.42),
			halfLen * 0.66, fuseY - bodyR * 0.55, 0,
		))
	}

	// Per-instance only (§9.2): a small heading jitter so a flight does not read as a comb.
	const heading = (rng.next() - 0.5) * 0.10
	zones?.push({ zone: Zone.optic, tree: sdf.rotateY(cockpit, heading) })
	return sdf.rotateY(body, heading)
}
