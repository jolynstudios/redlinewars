// Presentation-only aircraft clearance for reconstructed, flat-source RA maps.
// OpenRA's rectangular Map.DistanceAboveTerrain returns CenterPosition.Z; the bridge
// emits that absolute Z verbatim. Never add authored map elevation a second time.
import type { TerrainStaticView } from '../core'
import type { HeightProbe } from '../core/place'

/** Run on terrain-static snapshot boundaries, before its borrowed planes expire. */
export function isFlatAircraftSource(view: Pick<TerrainStaticView, 'w' | 'h' | 'height' | 'ramp'> | null | undefined): boolean {
	if (!view || view.w <= 0 || view.h <= 0) return false
	const n = view.w * view.h
	if (view.height.length < n || view.ramp.length < n) return false
	for (let i = 0; i < n; i++) if (view.height[i] !== 0 || view.ramp[i] !== 0) return false
	return true
}

/** Spatial anticipation; no velocity integration or per-actor history to desync. */
export const AIRCRAFT_LOOKAHEAD_M = 6
/** Fade anticipation/wing clearance out during the last half-metre of landing. */
export const AIRCRAFT_FULL_CLEARANCE_M = 0.5
const DIAGONAL = Math.SQRT1_2
const PROBE_X = [1, DIAGONAL, 0, -DIAGONAL, -1, -DIAGONAL, 0, DIAGONAL] as const
const PROBE_Z = [0, DIAGONAL, 1, DIAGONAL, 0, -DIAGONAL, -1, -DIAGONAL] as const

function smooth(value: number): number { return value * value * (3 - 2 * value) }

/**
 * Pass the returned render-space Y to placeActor's altitudeM argument. All input
 * positions remain authoritative interpolated values. Aircraft on a verified
 * zero-height/ramp source keep the flat-source offset below; aircraft on relieved
 * maps get their ground reference swapped to the anticipated local maximum so they
 * stop tracing every contour (see the branch comment). Ground actors, vessels,
 * unknown sources and fully landed aircraft pass through.
 *
 * The footprint samples include the centre and edge midpoints, not just the four
 * corners: an averaged corner height lets a narrow ridge pierce the aircraft.
 * Smoothly weighted radial probes anticipate hills in every travel direction (including
 * strafing helicopters). Sampling is spatial and deterministic under pause/replay,
 * with no heading-based prediction that can jump on a turn or a newly visible actor.
 *
 * This is terrain-following presentation, not pathfinding or a simulation climb-rate
 * change. It protects sampled hull points, not every vertex of a banked/animated mesh.
 * Authored discontinuous cliffs intentionally retain their existing placement policy.
 */
export function aircraftClearanceAltitude(
	airborne: boolean,
	flatSource: boolean,
	x: number,
	z: number,
	yaw: number,
	halfLen: number,
	halfWid: number,
	altitudeM: number,
	heightAt: HeightProbe,
	supportMinY = 0,
): number {
	if (!airborne || altitudeM <= 0) return altitudeM
	const c = Math.cos(yaw), s = Math.sin(yaw)
	const fx = c * halfLen, fz = -s * halfLen
	const lx = s * halfWid, lz = c * halfWid
	const h00 = heightAt(x + fx + lx, z + fz + lz)
	const h01 = heightAt(x + fx - lx, z + fz - lz)
	const h10 = heightAt(x - fx + lx, z - fz + lz)
	const h11 = heightAt(x - fx - lx, z - fz - lz)
	const ground = (h00 + h01 + h10 + h11) * 0.25
	const footprint = Math.max(h00, h01, h10, h11, heightAt(x, z),
		heightAt(x + fx, z + fz), heightAt(x - fx, z - fz),
		heightAt(x + lx, z + lz), heightAt(x - lx, z - lz))
	let anticipated = footprint
	// The fourth ring at radius 6 has zero weight and therefore needs no samples.
	for (let ring = 1; ring <= 3; ring++) {
		const radius = AIRCRAFT_LOOKAHEAD_M * ring / 4
		const weight = smooth(1 - ring / 4)
		for (let ray = 0; ray < PROBE_X.length; ray++) {
			const h = heightAt(x + PROBE_X[ray] * radius, z + PROBE_Z[ray] * radius)
			anticipated = Math.max(anticipated, footprint + (h - footprint) * weight)
		}
	}
	if (!flatSource) {
		// RELIEVED MAPS: the simulation's absolute Z follows the terrain under the
		// aircraft, so crossing a ridge at cruise reads as the plane falling out of
		// the sky. Swap the ground reference from the exact cell to the anticipated
		// local maximum: the aircraft holds cruise over dips and rises gently on
		// approach instead of tracing every contour. Purely spatial, so the module's
		// determinism invariant (no per-actor history) is intact; the offset is
		// never negative, and the landing fade keeps touchdown exact.
		const aboveGround = altitudeM - ground
		if (aboveGround <= AIRCRAFT_FULL_CLEARANCE_M) return altitudeM
		const landingBlend = smooth(Math.min(1, aboveGround / AIRCRAFT_FULL_CLEARANCE_M))
		return altitudeM + landingBlend * (anticipated - ground)
	}
	const blend = smooth(Math.min(1, altitudeM / AIRCRAFT_FULL_CLEARANCE_M))
	// Preserve the source altitude on an unraised plain; only large below-origin meshes
	// need extra lift to keep their bottom at least 5 cm above the sampled terrain.
	const bodyLift = Math.max(0, 0.05 - supportMinY - altitudeM)
	// Never lower aircraft below the authoritative altitude over a recessed water bed.
	return Math.max(altitudeM, ground + altitudeM + blend * (anticipated - ground + bodyLift))
}
