// STEELSEED — units/archetype/infantry
//
// The largest family by slot count and the smallest by screen area, which inverts every
// priority the vehicle families have.
//
// A soldier is roughly 1.7 m tall against a camera 40 m up. At that size the readable signal
// is **stance, load and weapon length** — not plate thickness, not greebles, not anything
// below about 10 cm. So this generator spends its geometry on the outline and almost none on
// surface detail: a rifleman and a rocket trooper must be distinguishable by the shape of
// what they carry, because nothing finer survives the zoom.
//
// It is also the first caller `sdf.capsule` has ever had, and the primitive turns out to be
// exactly right for it: capsules here are given as two ENDPOINTS rather than an axis and a
// length, so a limb is described the same way a bone is. When `rig`'s skinning pass lands,
// these endpoints are already the joint positions it needs.

import * as sdf from '../../geo/sdf'
import { Zone, type ZoneRegion } from '../../geo/zone'
import type { Rng } from '../../core'
import type { ChassisParams } from './params'

/**
 * One leg, retained after the figure is welded together.
 *
 * Infantry are the family §14.13 has the hardest time with: stature is fixed at 1.72 m by
 * design, so the body cannot carry identity and the WALK has to. A figure that slides across
 * the ground reads as a chess piece however good its silhouette is.
 *
 * `hip` is the pivot the limb swings about and `reach` is hip-to-sole, which is what converts
 * a stride into an angle.
 */
export interface LegRegion {
	readonly tree: sdf.Sdf
	readonly hip: readonly [number, number, number]
	readonly reach: number
	/** Left legs lead by half a cycle. rig.ts has BoneFlags.mirrored for exactly this. */
	readonly mirrored: boolean
}

/**
 * Antenna ceiling and half-height, in metres.
 *
 * `ANT_MAX_M` is approached asymptotically and never reached, so it is a limit rather than a
 * clip. `ANT_HALF_M` is the mast height at which the antenna reaches half the ceiling — it
 * sets where the curve spends its resolution, and 0.9 puts the steep part across the 0.2-1.0 m
 * band where fourteen of the sixteen infantry masts actually land.
 */
const ANT_MAX_M = 0.62
const ANT_HALF_M = 0.9

/**
 * Infantry stature in metres, and the one number in this project that was measurably wrong
 * about the world it lives in.
 *
 * It was 1.72 — a real human's height in real metres — in a game where §12.4 makes one cell one
 * metre and the mod authors a tank hull at 1.09 to 2.00 of them. So a soldier stood TALLER THAN
 * THE TALLEST TANK (2.4346 m against 1.7241) and nearly DOUBLE THE HEIGHT OF A WARSHIP (1.2414).
 *
 * The mod's own scale is recoverable and it is consistent everywhere else. Muzzle height runs
 * 0.25 to 0.42 of an actor's own plan size across tracked, wheeled, vessel AND infantry alike —
 * every family agrees — and infantry weapons are authored at a median 0.313 m. The figure
 * carries its weapon at 0.68 of stature, so the mod describes a soldier about 0.46 m tall.
 * Nothing else in the roster disagreed; only this constant did.
 *
 * OVERSIZED ON PURPOSE, and stated rather than smuggled. RTS games draw infantry larger than
 * scale so they stay readable, and this file's own header makes that argument. 1.6x puts a
 * soldier at ~0.74 m against a 2.0 m tank hull, a ratio of 1:2.7 where reality is 1:3.9.
 *
 * MEASURED RATHER THAN ASSERTED. This was carried for several sessions as "a judgement the
 * owner should make", which is only honest if the owner is given numbers. Projected height in
 * CSS pixels at 982 px viewport height and the camera's own FOV_Y of 48 degrees, at the three
 * zoom stops that matter (HEIGHT_MIN 12, default heightGoal 70, HEIGHT_MAX 140):
 *
 *   oversize   soldier    12 m      70 m     140 m
 *   1.0        0.46 m    23.6 px   5.3 px    3.2 px
 *   1.6        0.74 m    37.8 px   8.4 px    5.1 px      <- current
 *   2.2        1.01 m    52.0 px  11.6 px    7.0 px
 *   2.8        1.29 m    66.2 px  14.8 px    9.0 px
 *   reference: the longest tank hull, 2.00 m, is 102.8 / 22.9 / 13.9 px
 *
 * THERE IS NO VALUE THAT SATISFIES BOTH CONSTRAINTS, and that is the actual finding. Reading a
 * figure's POSE — the stance and weapon this file spends its whole geometry budget on — wants
 * roughly 12-16 px of height, which needs 2.2 to 2.8. But 2.8 makes a soldier 1.29 m against a
 * 2.00 m tank, a ratio of 1:1.55, which is no longer stylisation but a different game.
 *
 * So 1.6 stays, and the tension is real but is NOT this constant's to resolve: at HEIGHT_MAX
 * the tank itself is only 13.9 px. The far camera is too far for a roster whose largest ground
 * hull is 2 m, and the lever that would actually fix infantry readability is `camera`'s
 * HEIGHT_MAX, not this number. Raising oversize instead trades a scale the whole roster agrees
 * on for pixels the zoom range is giving away anyway.
 */
const INFANTRY_OVERSIZE = 1.6
const INFANTRY_STATURE_M = 0.46 * INFANTRY_OVERSIZE

export function buildInfantryFigure(
	p: ChassisParams,
	rng: Rng,
	zones?: ZoneRegion[],
	legsOut?: LegRegion[],
): sdf.Sdf {
	// Height comes from the figure, not from the footprint. An infantry slot's Selectable
	// bounds describe a SELECTION BOX, and deriving stature from it would make a
	// heavy-weapons trooper a giant. A soldier is a soldier; what varies is what they carry.
	const H = INFANTRY_STATURE_M

	// The faction operator applies, but muted. §9.1's contrast is cast mass versus bolted
	// framework and a person is neither, so it survives only as build — which is about as
	// much as a 1.7 m figure can carry at RTS zoom.
	const build = 1 + (p.op.widthScale - 1) * 0.45

	const hipY = H * 0.46
	const shoulderY = hipY + H * 0.30
	// Widened from 0.075. The comment below was right about WHY the stance matters and the
	// number did not deliver it: at 0.075 the feet are 0.15 m apart while each leg has a
	// radius of 0.058, which leaves 3.4 cm of air between two 11.6 cm legs — and the legs then
	// converged inward going up, from 0.075 to 0.045. Two near-touching converging capsules
	// are a tapered post, and the contact sheet duly showed eight figures on pedestals.
	//
	// 0.115 puts the feet 0.23 m apart, which is where a braced human stance actually is, and
	// leaves 11 cm of daylight — comparable to the leg width rather than a third of it.
	const stance = 0.115 * build

	// --- legs ----------------------------------------------------------------
	// Apart and braced. A figure with its feet together reads as a post, and the stance is
	// most of what makes it read as a person at four pixels tall.
	//
	// The legs stay near-VERTICAL rather than converging to the hip. A converging pair closes
	// its own gap exactly where the figure is widest in silhouette, which throws away the
	// separation the stance just bought.
	const legR = 0.058 * build
	const legL = sdf.capsule(-0.02, 0.02, -stance, 0.005, hipY, -stance * 0.92, legR)
	const legR_ = sdf.capsule(0.03, 0.02, stance, 0.005, hipY, stance * 0.92, legR)
	// Feet. A leg that ends in a hemisphere reads as a peg; a boot gives the figure a base and
	// a facing, and it is the cheapest thing on the model — two boxes.
	const foot = (sz: number): sdf.Sdf => sdf.translate(
		sdf.roundBox(0.085, 0.030, legR * 0.95, 0.02),
		0.022, 0.030, sz * stance,
	)
	if (legsOut !== undefined) {
		// Leg plus its boot, because a limb that swings without its foot leaves the boot
		// standing on the ground while the leg walks away from it.
		legsOut.push({
			tree: sdf.union(legR_, foot(1)),
			hip: [0.005, hipY, stance * 0.92],
			reach: hipY,
			mirrored: false,
		})
		legsOut.push({
			tree: sdf.union(legL, foot(-1)),
			hip: [0.005, hipY, -stance * 0.92],
			reach: hipY,
			mirrored: true,
		})
	}

	// --- armour ----------------------------------------------------------------
	// Sixteen infantry shared ONE body. Everything that varied — weapon length, bore, pack,
	// antenna — hangs off the figure, and the figure itself was identical for all of them,
	// because `build` came only from the faction operator and stature is a constant. So the
	// roster's eight Foundry troopers were the same person carrying different things, and
	// rostergate needed a relaxed 0.995 ceiling for family 2 to tolerate it.
	//
	// plateMm is the toughness the roster already derives and it spans 17.03 to 25.54 across
	// these sixteen, 15 distinct values — a real signal that was being spent entirely on
	// `bevelM`, which at 6 to 9 mm is one to two orders of magnitude under the mesher grid and
	// therefore invisible. This is the same defect as the roof plant and the AA tubes: the
	// value IS consumed, somewhere nothing can see.
	//
	// Spent on the TORSO and SHOULDERS, deliberately. The camera looks down at 34-62 degrees,
	// so the head and shoulders are the part of a 1.7 m figure it actually sees; armour on the
	// legs would be the infantry version of a cue below the eaves.
	const armour01 = Math.min(1, Math.max(0, (p.plateMm - 17) / 9))

	// --- torso ---------------------------------------------------------------
	// Stature stays fixed and that remains right — a soldier is a soldier, and deriving height
	// from a selection box once made a heavy-weapons trooper a giant. What armour buys is
	// BULK, which is what armour buys in life.
	const torso = sdf.capsule(0, hipY, 0, 0, shoulderY, 0, (0.098 + 0.026 * armour01) * build)
	// A chest box so SHOULDERS exist in silhouette. Shoulders are what separate a person
	// from a bollard, and they are the last thing to disappear as the camera pulls back.
	const chest = sdf.translate(
		sdf.roundBox(
			(0.050 + 0.018 * armour01) * build,
			H * 0.09,
			(0.108 + 0.038 * armour01) * build,
			0.045,
		),
		0, shoulderY - H * 0.07, 0,
	)
	// Pauldrons, on the heavily armoured only. A plate over each shoulder is the one addition
	// that changes a figure's OUTLINE rather than its width, and the outline is what survives
	// to the far camera — a trooper in plate reads as square-shouldered against a rifleman's
	// taper long after neither has a face.
	const pauldrons: sdf.Sdf[] = []
	if (armour01 > 0.45) {
		const pw = (0.052 + 0.030 * armour01) * build
		const pz = (0.112 + 0.030 * armour01) * build
		for (const sz of [-1, 1]) {
			pauldrons.push(sdf.translate(
				sdf.roundBox(pw * 0.85, H * 0.030, pw, 0.022),
				-0.004, shoulderY - H * 0.030, sz * pz,
			))
		}
	}

	// --- head ----------------------------------------------------------------
	const headR = 0.082
	const head = sdf.translate(sdf.sphere(headR), 0.005, shoulderY + headR * 1.15, 0)
	// A helmet brim: at this scale it is the difference between a head and a ball. It grows
	// with armour too — the same number, so a plated trooper is plated all the way up.
	const helmetR = headR * (1.10 + 0.12 * armour01)
	const helmet = sdf.translate(
		sdf.rotateX(sdf.cylinder(helmetR, headR * (0.30 + 0.14 * armour01)), Math.PI * 0.5),
		0.005, shoulderY + headR * 1.32, 0,
	)
	// Helmet and weapon are the figure's unpainted hard parts. Keep their source regions so
	// the welded mesh can be labelled after the pose is assembled; splitting either out into
	// a second mesh would reopen seams at exactly the scale where the figure is most fragile.
	const hardParts: sdf.Sdf[] = [helmet, ...pauldrons]

	// Legs and feet hard-unioned, then blended to the torso. The blend radius has to stay well
	// under the gap the stance opens, or the smoothing quietly fills it back in at the hip and
	// the figure returns to being a post from the waist down.
	const lowerBody = sdf.union(legL, legR_, foot(-1), foot(1))
	// Pauldrons join HARD, not smoothly. A plate bolted over a shoulder has an edge, and
	// smoothing it into the torso would spend the one silhouette cue this adds on a fillet.
	const upperBody = pauldrons.length > 0
		? sdf.union(sdf.union(torso, chest), ...pauldrons)
		: sdf.union(torso, chest)
	let body = sdf.smoothUnion(
		sdf.smoothUnion(lowerBody, upperBody, 0.045),
		sdf.union(head, helmet),
		0.04,
	)

	// --- arms and weapon -----------------------------------------------------
	// The weapon IS the identity here. `barrelLenM` already encodes calibre ratio from range
	// and bore from damage, so a long anti-armour launcher and a short carbine fall out of
	// one expression with no per-type authoring — §14.13 working at the scale where it is
	// hardest to show anything at all.
	const armR = 0.045 * build
	const carryY = shoulderY - H * 0.08

	if (p.barrelLenM > 0) {
		// Held across the body and angled down: the universal carry, and the pose that puts
		// the most weapon length into a side-on silhouette.
		// The weapon IS the identity, so it must not be clamped flat — and it was. At
		// `max(barrelLenM * 0.55, 0.34)` the 0.55 scale compressed the roster's 0.30-0.68 m of
		// derived barrel into 0.17-0.37, and the 0.34 floor then swallowed the bottom half of
		// that outright: foundry_bolt at 0.411 and lattice_cipher at 0.413 and foundry_cinder
		// at 0.303 ALL came out at exactly 0.340, and foundry_ember at 0.637 reached 0.351 —
		// a 3% difference across a 2.1x spread of input. rostergate duly found two riflemen at
		// IoU 1.0000 and it was right.
		//
		// This is the fourth clamp this session to eat a whole family's variation: the road
		// wheel floor, the structure toughness scale, the wing-driven fuselage, and now this.
		// An offset plus a slope keeps the derived spread intact and still guarantees a weapon
		// long enough to read, without a floor that most of the roster sits on.
		// The warhead's ROLE, spent on the weapon's PROPORTION.
		//
		// armourBias is the one thing in the roster that states what a weapon is FOR rather
		// than what it physically is, and it reached nothing until it was carried through the
		// adapter. An anti-armour weapon is long and thin — length is velocity and velocity is
		// penetration — while an anti-light one is shorter and wider, because area beats
		// velocity against unarmoured targets. Same argument a real armoury would make, and it
		// falls out of a number the mod already authored.
		//
		// This is the pair rostergate reports at 0.0269 apart, below its 0.06 floor:
		// foundry_clamp at +0.222 and foundry_ember at -0.319 are designed opposites that
		// generated as the same soldier. Length and radius move in OPPOSITE directions so the
		// weapon keeps roughly its mass — a bias that just made guns bigger would read as
		// "better", which is a balance statement rather than a role one.
		const lenScale = 1 + p.armourBias * 0.35
		const radScale = 1 - p.armourBias * 0.30
		const wLen = (0.30 + p.barrelLenM * 0.70) * lenScale
		// Tube count widens the RECEIVER, not just the barrel count. A twin-tube weapon is a
		// bulkier object end to end, and that is what a silhouette can actually see: adding a
		// second thin capsule beside the first moved `rostergate`'s IoU for foundry_bolt /
		// foundry_rivet by exactly zero, because a 4 cm lateral offset on a 0.74 m figure sits
		// entirely inside the outline the first barrel already casts.
		const wR = Math.max(p.boreMm / 2400, 0.014) * radScale * (1 + 0.30 * (Math.min(p.tubes, 4) - 1))
		// THE WEAPON ENDS WHERE THE SIMULATION FIRES FROM.
		//
		// `p.muzzleM` is the authored mount point and all sixteen infantry had it floating in
		// open air — the figure was drawn at four times the scale its own roster data describes,
		// so the rifle sat a metre above the point the shot spawns from. With the stature
		// corrected the authored point lands on the weapon, and anchoring the forward end to it
		// keeps that true per actor instead of by coincidence.
		//
		// The rear end still carries `wLen`, so `armourBias` keeps saying what the weapon is FOR
		// — a long thin anti-armour tube against a short wide anti-light one — by deciding how
		// far the weapon projects BEHIND the grip rather than in front of it.
		const weapon = sdf.capsule(
			p.muzzleM[0] - wLen, carryY + 0.02 * (H / 1.72), p.muzzleM[2] + 0.02,
			p.muzzleM[0], p.muzzleM[1], p.muzzleM[2],
			wR,
		)
		hardParts.push(weapon)
		body = sdf.union(body, weapon)

		// EXTRA BARRELS, one per authored tube beyond the first.
		//
		// `p.tubes` is derived from the mod and was read by NOBODY in this file. It is the axis
		// that separates `foundry_bolt` (2) from `foundry_rivet` (1) — a pair `rostergate`
		// measured at 0.9242 IoU, the worst in the roster, while the roster itself said one
		// carries twice the barrels of the other. Sixteen infantry sharing one silhouette is
		// also why family 2 needs the relaxed 0.995 IoU exemption, and this is the first real
		// dent in that.
		//
		// Stacked laterally and slightly low, the way a real multi-barrel weapon is built,
		// because a second tube directly above the first is hidden by the first from every
		// camera angle this game has.
		for (let t = 1; t < Math.min(p.tubes, 4); t++) {
			const dz = wR * 2.05 * t
			body = sdf.union(body, sdf.capsule(
				p.muzzleM[0] - wLen * 0.92, carryY + 0.02 * (H / 1.72) - wR * 0.35, p.muzzleM[2] + 0.02 + dz,
				p.muzzleM[0] - wLen * 0.05, p.muzzleM[1] - wR * 0.35, p.muzzleM[2] + dz,
				wR * 0.86,
			))
		}
		// A launcher gets a visible tube; a rifle does not. One branch, driven by BORE rather
		// than by a name — an actor called "rocket trooper" proves nothing, a 90 mm bore does.
		if (p.boreMm > 70) {
			const launcher = sdf.capsule(
				-wLen * 0.34, carryY + 0.11, 0.02,
				wLen * 0.50, carryY + 0.02, 0.09,
				wR * 1.75,
			)
			hardParts.push(launcher)
			body = sdf.union(body, launcher)
		}
		// Arms brought forward to meet it. Hanging arms plus a floating weapon is the tell
		// that a figure was assembled from parts rather than posed.
		body = sdf.smoothUnion(body, sdf.capsule(
			-0.01, shoulderY - 0.02, 0.115 * build,
			wLen * 0.20, carryY - 0.02, 0.10, armR,
		), 0.035)
		body = sdf.smoothUnion(body, sdf.capsule(
			-0.01, shoulderY - 0.02, -0.115 * build,
			wLen * 0.02, carryY - 0.03, 0.02, armR,
		), 0.035)
	} else {
		// Unarmed — engineer, medic. Arms down, and the ABSENCE of a weapon is the read.
		body = sdf.smoothUnion(body, sdf.capsule(
			0, shoulderY - 0.02, 0.115 * build, 0.01, hipY + 0.04, 0.135 * build, armR,
		), 0.035)
		body = sdf.smoothUnion(body, sdf.capsule(
			0, shoulderY - 0.02, -0.115 * build, 0.01, hipY + 0.04, -0.135 * build, armR,
		), 0.035)
	}

	// --- carried load --------------------------------------------------------
	// Cost buys kit exactly as it buys greebles on a vehicle: an expensive specialist is
	// visibly loaded, a cheap conscript is not. Same number, spent on OUTLINE instead of
	// surface, because outline is the only thing visible at this size.
	if (p.greebleBudget > 900) {
		const packD = 0.075 + 0.055 * Math.min((p.greebleBudget - 900) / 2100, 1)
		body = sdf.smoothUnion(body, sdf.translate(
			sdf.roundBox(packD, H * 0.09, 0.10 * build, 0.03),
			-0.10 * build, shoulderY - H * 0.09, 0,
		), 0.04)
	}

	// Cargo means a carried container — a demolition charge, a supply crate, a medical case.
	if (p.cargo > 0) {
		body = sdf.union(body, sdf.translate(
			sdf.roundBox(0.06, 0.055, 0.05, 0.02),
			-0.02, hipY + 0.10, -0.155 * build,
		))
	}

	// A radio or sensor antenna, on the same rule as every other family: present wherever the
	// machine reveals shroud at all, and taller the further it sees.
	//
	// COMPRESSED, NOT CLIPPED. This was `Math.min(p.mastHeightM * 1.4, 0.55)`, and the moment
	// `mastHeightM` started reporting every sighted actor rather than only above-median ones,
	// that `min` saturated for FIFTEEN OF SIXTEEN infantry — every figure whose mast exceeded
	// 0.39 m came out at exactly 0.550, and only foundry_ingot at the roster's minimum vision
	// escaped. lattice_cipher sees 9 m and lattice_shard sees 4 m, a mast of 1.68 against 0.43,
	// and both were drawn with the identical antenna: rostergate put them at IoU 1.0000, which
	// is not "similar" but "the same mesh".
	//
	// A ceiling is genuinely needed — a 2 m whip on a 1.72 m figure is absurd, and the reason
	// the clip was there is real. But a hard ceiling reached by 94% of the family converts a
	// ranked cue into a uniform stamp, which is worse than not drawing it. The rational form
	// approaches the ceiling and never reaches it, so the ORDER is preserved everywhere: every
	// soldier who sees further has a visibly taller antenna than every soldier who sees less,
	// at every point in the range.
	if (p.mastHeightM > 0.02) {
		const antH = ANT_MAX_M * p.mastHeightM / (p.mastHeightM + ANT_HALF_M)
		body = sdf.union(body, sdf.capsule(
			-0.10 * build, shoulderY, 0.05,
			-0.12 * build, shoulderY + antH, 0.05,
			0.011,
		))
	}

	// Per-instance only (§9.2): a small heading jitter so a squad does not read as a comb.
	// Never proportion, never kit — those are what the player learns to read.
	const heading = (rng.next() - 0.5) * 0.16
	zones?.push({ zone: Zone.running, tree: sdf.rotateY(sdf.union(...hardParts), heading) })
	return sdf.rotateY(body, heading)
}
