// STEELSEED — units/place
// How an actor meets the ground.
//
// This is one pure function, extracted out of `units.update()` for one reason: it has to be
// GATEABLE. A ground-contact check that reimplements the placement maths is checking its own
// copy, and this project has four recorded cases of an instrument reporting success while
// measuring something other than the thing that ships. `tools/groundgate.mjs` imports THIS
// function, so a green gate is a statement about the code the renderer runs.
//
// No allocation: the caller owns the matrix and the offset (rule 6). No state: two calls with
// the same arguments write the same sixteen floats (§4.11 — `units` remembers nothing).

/** A terrain height probe. Same shape as `TerrainApi.heightAt` (§12.3, worldX / worldZ). */
export type HeightProbe = (worldX: number, worldZ: number) => number

/**
 * Steepest slope a machine will lie down on.
 *
 * Past this the terrain is a §8 cliff rather than a hill: a discontinuity in the height
 * field, not something with a driveable gradient. Fitting a plane across one rolls a tank
 * onto its side, which reads far worse than clipping a corner into the rock.
 *
 * Derived from the angle rather than written as a rounded gradient. `0.364` is tan(20°) to
 * three places and clamps at 20.0017°, so a check written against 20° fails by a thousandth
 * of a degree — which is how a rounded constant wastes somebody's afternoon.
 */
export const MAX_TILT_DEG = 20
export const MAX_TILT_SLOPE = Math.tan((MAX_TILT_DEG * Math.PI) / 180)

/** Half-extents used when an actor has no roster slot and so no measured footprint. */
export const DEFAULT_HALF_EXTENT = 0.75
/** Visual depth used when OpenRA's synchronized Cloak state marks a submarine underwater. */
export const SUBMERGED_DEPTH_M = 0.22

/** Vessel meshes declare a waterline at y=0; docks declare their physical mesh bottom. */
export function waterSupportMinY(watercraft: boolean, meshMinY: number): number {
	return watercraft ? 0 : meshMinY
}

/** The water pass later occludes this lowered portion, leaving a semi-visible silhouette. */
export function submergedWaterOffset(submersible: boolean, cloaked: boolean): number {
	return submersible && cloaked ? SUBMERGED_DEPTH_M : 0
}

/**
 * Write an actor's model matrix, column-major, at `out[o .. o+15]`.
 *
 * The transform this replaces was yaw and translation only — row 1 hard-coded to (0,1,0,0)
 * — over a SINGLE terrain sample at the actor's centre. One sample cannot see a slope, so
 * every vehicle in the game stood bolt upright on a hillside with its uphill corner buried
 * and its downhill corner in the air.
 *
 * Four samples at the footprint corners give a least-squares plane, and a plane is what a
 * machine rests on. A centre sample plus a centre normal is not equivalent and is worse: a
 * tank spanning a ridge must STRADDLE it rather than tilt to the ridge line, and that
 * difference is precisely the case a viewer reads as wrong.
 *
 * @param altitudeM render-space Y for an airborne actor. Ground actors ignore it.
 * @param supportMinY lowest local-space mesh Y that must meet the terrain. Airborne
 * actors keep their authoritative altitude and ignore it.
 */
export function placeActor(
	out: Float32Array,
	o: number,
	x: number,
	z: number,
	yaw: number,
	halfLen: number,
	halfWid: number,
	airborne: boolean,
	altitudeM: number,
	heightAt: HeightProbe,
	supportMinY = 0,
): void {
	const c = Math.cos(yaw)
	const s = Math.sin(yaw)

	// Corner offsets in world XZ. The model maps local +X to (c,0,-s) and local +Z to (s,0,c),
	// so the samples land on the actor's own axes rather than on the world's.
	const fx = c * halfLen, fz = -s * halfLen
	const lx = s * halfWid, lz = c * halfWid
	const h00 = heightAt(x + fx + lx, z + fz + lz)
	const h01 = heightAt(x + fx - lx, z + fz - lz)
	const h10 = heightAt(x - fx + lx, z - fz + lz)
	const h11 = heightAt(x - fx - lx, z - fz - lz)

	let gF = (h00 + h01 - h10 - h11) / (4 * halfLen)
	let gL = (h00 - h01 + h10 - h11) / (4 * halfWid)
	if (gF > MAX_TILT_SLOPE) gF = MAX_TILT_SLOPE
	else if (gF < -MAX_TILT_SLOPE) gF = -MAX_TILT_SLOPE
	if (gL > MAX_TILT_SLOPE) gL = MAX_TILT_SLOPE
	else if (gL < -MAX_TILT_SLOPE) gL = -MAX_TILT_SLOPE

	const ground = (h00 + h01 + h10 + h11) * 0.25
	// Procedural meshes are not guaranteed to have their lowest vertex at model Y=0.
	// Anchor the actual mesh bottom to the fitted terrain plane instead of anchoring an
	// arbitrary origin and leaving buildings visibly hovering above their shadows.
	let y = ground - supportMinY
	if (airborne) {
		// The snapshot has carried real altitude in `posZ` since the bridge landed and `units`
		// discarded it, so every aircraft in the game taxied along the ground. Floored at the
		// terrain so one cannot fly through a hill; banking is `anim`'s, from d(facing)/dt.
		y = altitudeM > ground ? altitudeM : ground
		gF = 0
		gL = 0
	}

	// Orthonormal basis from the fitted plane. Local +X leans by the fore-aft gradient and
	// local +Z by the lateral one; up is their cross product, so the frame comes out
	// orthonormal without a separate fix-up pass.
	const fLen = Math.sqrt(1 + gF * gF)
	const tfx = c / fLen, tfy = gF / fLen, tfz = -s / fLen
	const lLen = Math.sqrt(1 + gL * gL)
	const tlx = s / lLen, tly = gL / lLen, tlz = c / lLen

	// up = normalize(cross(lateral, forward)). On flat ground this is exactly (0,1,0).
	let ux = tly * tfz - tlz * tfy
	let uy = tlz * tfx - tlx * tfz
	let uz = tlx * tfy - tly * tfx
	const uLen = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1
	ux /= uLen; uy /= uLen; uz /= uLen

	// lateral = cross(forward, up), re-derived so the three axes are exactly orthogonal.
	const rx = tfy * uz - tfz * uy
	const ry = tfz * ux - tfx * uz
	const rz = tfx * uy - tfy * ux

	out[o] = tfx; out[o + 1] = tfy; out[o + 2] = tfz; out[o + 3] = 0
	out[o + 4] = ux; out[o + 5] = uy; out[o + 6] = uz; out[o + 7] = 0
	out[o + 8] = rx; out[o + 9] = ry; out[o + 10] = rz; out[o + 11] = 0
	out[o + 12] = x; out[o + 13] = y; out[o + 14] = z; out[o + 15] = 1
}

/**
 * Place an actor against a flat simulation-derived surface such as a connected water body.
 * Vessels use local y=0 as their waterline; water structures pass their mesh bottom.
 */
export function placeActorAtLevel(
	out: Float32Array,
	o: number,
	x: number,
	z: number,
	yaw: number,
	level: number,
	supportMinY = 0,
): void {
	const c = Math.cos(yaw)
	const s = Math.sin(yaw)
	out[o] = c; out[o + 1] = 0; out[o + 2] = -s; out[o + 3] = 0
	out[o + 4] = 0; out[o + 5] = 1; out[o + 6] = 0; out[o + 7] = 0
	out[o + 8] = s; out[o + 9] = 0; out[o + 10] = c; out[o + 11] = 0
	out[o + 12] = x; out[o + 13] = level - supportMinY; out[o + 14] = z; out[o + 15] = 1
}

/**
 * Uniformly scale a placed actor so its mesh fits the occupancy cell.
 *
 * `placeActor` writes rotation at scale 1 and sits the mesh bottom on the ground with
 * `y = ground - supportMinY`. Scaling the 3×3 around the origin would lift that bottom
 * by `supportMinY * (1 - scale)`, so Y is corrected by the same amount.
 */
export function applyFitScale(out: Float32Array, o: number, scale: number, supportMinY: number): void {
	if (scale === 1) return
	out[o] *= scale; out[o + 1] *= scale; out[o + 2] *= scale
	out[o + 4] *= scale; out[o + 5] *= scale; out[o + 6] *= scale
	out[o + 8] *= scale; out[o + 9] *= scale; out[o + 10] *= scale
	out[o + 13] += supportMinY * (1 - scale)
}
