// STEELSEED — fx/tesla-arc
//
// The Tesla coil's bolt. Nothing in the renderer had ever drawn one: there was no tesla, zap or
// lightning code anywhere in web/src, so a coil killed its target in silence and the human's
// report was simply "the tesla coil should zap electricity, it doesnt happen now".
//
// WHY THIS IS NOT A PROJECTILE. `^TeslaWeapon` in engine/openra/mods/ra/weapons/other.yaml is
// `Projectile: TeslaZap`, which hits INSTANTLY — there is no travelling body to follow. So a
// bolt is not a missile, it is a shape drawn between two points that are both already known.
//
// WHERE THE TWO POINTS COME FROM. The weaponFire event carries the firing position but no
// target, so this looked like it needed a protocol change. It does not: `fx/index.ts` already
// pairs a fire with the damage it caused, in order to draw instant-hit tracers, and that pairing
// resolves exactly the source and target a bolt needs. This module is handed the endpoints the
// tracer pairing already found, so it costs no new event, no C# and no wire-format change.
//
// RANGE COMES FROM THE RULES, not from taste. `^TeslaWeapon` declares `Range: 7c0` — seven
// cells, and one cell is one render metre — so a bolt must stay coherent out to 7 m. The human
// asked for it to reach "to the distance according to the gameplay", so the segment count is
// derived from the span rather than fixed, and a long bolt gets more joints instead of longer
// straight runs.
//
// NO NONDETERMINISM. rulecheck rule 5 bans the platform random generator outright, and two
// machines must draw the same battle from the same snapshot regardless. Every
// offset here comes from a hash of the strike seed, the joint index and a discrete flicker step,
// so a bolt is identical everywhere and still appears to crackle.

import { Zone, ZoneFlag, withZoneFlag } from '../geo/zone'
import { Mesh } from '../geo/mesh'
import * as sdf from '../geo/sdf'
import type { ShroudApi } from './types'

/** Simultaneous bolts. A coil reloads every 3 ticks, so a few coils saturate this quickly. */
const MAX_ARCS = 24

/** Joints on the main channel at the shortest span; a long bolt earns more. See SEGMENTS_FOR. */
const MIN_JOINTS = 6
const MAX_JOINTS = 14

/**
 * Short forks that die partway, which is most of what makes a bolt read as lightning. Ultra draws
 * up to three per strike and Ultra+ up to five (the caller passes the cap per strike).
 */
const MAX_BRANCHES = 5
const BRANCH_JOINTS = 3

const SEGMENTS_PER_ARC = MAX_JOINTS + MAX_BRANCHES * BRANCH_JOINTS
const FLOATS_PER_SEGMENT = 16

/**
 * How long one strike stays on screen.
 *
 * The weapon reloads every 3 ticks (0.12 s at 25 ticks/s). A bolt shorter than that flickers
 * out between shots and reads as a rendering fault rather than a weapon; a bolt longer than the
 * reload would still be lit when the next one starts and the coil would appear to fire a
 * continuous beam. Just under two reloads keeps a firing coil almost always lit while still
 * showing discrete strikes.
 */
const ARC_LIFETIME_S = 0.22

/** Discrete re-jitters over that life. Continuous jitter looks like noise; steps look electric. */
const FLICKER_STEPS = 4

/** Lateral wander as a fraction of span, at the middle of the channel where it is widest. */
const WANDER = 0.085

/** Matches the tracer's screen-space sizing so a bolt cannot vanish at gameplay zoom. */
const PIXEL_WIDTH = 3.4
const METRES_PER_PIXEL = 0.00125
const MIN_R = 0.012
const MAX_R = 0.075

/** The authored capsule's own radius, so instance scale can be expressed as a multiplier. */
export const ARC_R = 0.05

function hash(value: number): number {
	let n = Math.imul(value ^ (value >>> 16), 0x45d9f3b)
	n = Math.imul(n ^ (n >>> 16), 0x45d9f3b)
	return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}

/** A long bolt gets more joints, so wander stays a similar size on screen at any range. */
function jointsFor(span: number): number {
	const wanted = MIN_JOINTS + Math.round(span * 1.1)
	return wanted < MIN_JOINTS ? MIN_JOINTS : wanted > MAX_JOINTS ? MAX_JOINTS : wanted
}

/** Build the capsule a single bolt segment is drawn with: a thin emissive rod along +X. */
export function buildArcMesh(): Mesh {
	const arc = new Mesh()
	sdf.surfaceNets(
		sdf.capsule(0, 0, 0, 1, 0, 0, ARC_R),
		sdf.setAabb(sdf.aabb(), -0.04, -0.05, -0.05, 1.04, 0.05, 0.05),
		14,
		arc,
		{ creaseAngle: 34, seal: true },
	)
	if (arc.vertexCount === 0)
		throw new Error('fx: the tesla arc meshed to zero vertices — the coil would fire in silence')
	// `optic` reads cool against the warm hull the muzzle flash and tracer use, which is what
	// separates electricity from burning propellant at a glance.
	const emissiveOptic = withZoneFlag(Zone.optic, ZoneFlag.emissive)
	for (let vertex = 0; vertex < arc.vertexCount; vertex++) arc.setZone(vertex, emissiveOptic)
	return arc
}

export interface TeslaArcStats {
	/** Bolts alive this frame. */
	active: number
	/** Segments actually written to the instance buffer. */
	segments: number
	/** Ultra layers this frame: white-hot core segments, violet fringe segments, pooled lights. */
	coreSegments: number
	fringeSegments: number
	lights: number
	/** Strikes accepted since boot; a coil that never fires leaves this at zero. */
	struck: number
	/** Strikes refused because MAX_ARCS was full. */
	dropped: number
}

export class TeslaArc {
	private count = 0
	private readonly sourceX = new Float32Array(MAX_ARCS)
	private readonly sourceY = new Float32Array(MAX_ARCS)
	private readonly sourceZ = new Float32Array(MAX_ARCS)
	private readonly targetX = new Float32Array(MAX_ARCS)
	private readonly targetY = new Float32Array(MAX_ARCS)
	private readonly targetZ = new Float32Array(MAX_ARCS)
	private readonly seed = new Uint32Array(MAX_ARCS)
	private readonly age = new Float32Array(MAX_ARCS)
	/** Thickness multiplier (the weapon's authored width, TTankZap = 1) and fork cap per strike. */
	private readonly width = new Float32Array(MAX_ARCS)
	private readonly branchCap = new Uint8Array(MAX_ARCS)

	readonly instances = new Float32Array(MAX_ARCS * SEGMENTS_PER_ARC * FLOATS_PER_SEGMENT)
	/** Ultra: a thin white-hot core along the same channel, and a wide faint violet fringe. */
	readonly coreInstances = new Float32Array(MAX_ARCS * SEGMENTS_PER_ARC * FLOATS_PER_SEGMENT)
	readonly fringeInstances = new Float32Array(MAX_ARCS * MAX_JOINTS * FLOATS_PER_SEGMENT)
	readonly stats: TeslaArcStats = { active: 0, segments: 0, struck: 0, dropped: 0, coreSegments: 0, fringeSegments: 0, lights: 0 }

	clear(): void {
		this.count = 0
		this.stats.active = 0
		this.stats.segments = 0
		this.stats.coreSegments = 0
		this.stats.fringeSegments = 0
		this.stats.lights = 0
	}

	/** True for the weapons that inherit `^TeslaWeapon` in the RA rules. */
	static isTeslaWeapon(weaponName: string): boolean {
		return weaponName === 'TeslaZap' || weaponName === 'PortaTesla' || weaponName === 'TTankZap'
	}

	/** Record a strike between two points the caller has already resolved. */
	strike(sx: number, sy: number, sz: number, tx: number, ty: number, tz: number, seed: number, width = 1, branches = 3): void {
		if (this.count >= MAX_ARCS) { this.stats.dropped++; return }
		const i = this.count++
		this.width[i] = width > 0 ? width : 1
		this.branchCap[i] = Math.max(1, Math.min(MAX_BRANCHES, branches | 0))
		this.sourceX[i] = sx; this.sourceY[i] = sy; this.sourceZ[i] = sz
		this.targetX[i] = tx; this.targetY[i] = ty; this.targetZ[i] = tz
		this.seed[i] = seed >>> 0
		this.age[i] = 0
		this.stats.struck++
	}

	/**
	 * Advance every bolt and write its segments as oriented instances.
	 *
	 * Returns how many segments were written. `write` is `writeAxisTransform` from fx/index.ts,
	 * passed in rather than imported so this module owns no drawing policy of its own.
	 */
	build(
		dt: number,
		shroud: ShroudApi,
		eyeX: number,
		eyeY: number,
		eyeZ: number,
		write: (out: Float32Array, o: number, x: number, y: number, z: number,
			ax: number, ay: number, az: number, sx: number, sy: number, sz: number) => boolean,
		layers = false,
		light: ((x: number, y: number, z: number, intensity: number, radius: number) => void) | null = null,
	): number {
		let alive = 0
		let segments = 0
		let coreSegments = 0
		let fringeSegments = 0
		let lights = 0
		for (let read = 0; read < this.count; read++) {
			const age = this.age[read]
			if (age >= ARC_LIFETIME_S) continue
			// Compact in place so a dead bolt cannot leave a stale record behind it.
			if (alive !== read) {
				this.sourceX[alive] = this.sourceX[read]; this.sourceY[alive] = this.sourceY[read]
				this.sourceZ[alive] = this.sourceZ[read]; this.targetX[alive] = this.targetX[read]
				this.targetY[alive] = this.targetY[read]; this.targetZ[alive] = this.targetZ[read]
				this.seed[alive] = this.seed[read]
				this.width[alive] = this.width[read]
				this.branchCap[alive] = this.branchCap[read]
			}
			const sx = this.sourceX[alive], sy = this.sourceY[alive], sz = this.sourceZ[alive]
			const tx = this.targetX[alive], ty = this.targetY[alive], tz = this.targetZ[alive]
			this.age[alive] = age + (dt > 0 ? dt : 0)
			alive++

			// Both ends must be seen. A bolt whose target sits in fog would otherwise draw a line
			// pointing straight at a unit the player has not discovered.
			if (!shroud.isVisible(Math.floor(sx), Math.floor(sz))) continue
			if (!shroud.isVisible(Math.floor(tx), Math.floor(tz))) continue

			const pathX = tx - sx, pathY = ty - sy, pathZ = tz - sz
			const span = Math.hypot(pathX, pathY, pathZ)
			if (!(span > 1e-4)) continue

			// A stable frame perpendicular to the channel, so wander is lateral rather than along it.
			const dx = pathX / span, dy = pathY / span, dz = pathZ / span
			const refY = Math.abs(dy) < 0.9 ? 1 : 0
			const refZ = Math.abs(dy) < 0.9 ? 0 : 1
			const d = dy * refY + dz * refZ
			let ux = -dx * d, uy = refY - dy * d, uz = refZ - dz * d
			const uLen = Math.hypot(ux, uy, uz)
			if (!(uLen > 1e-6)) continue
			ux /= uLen; uy /= uLen; uz /= uLen
			const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux

			const life = age / ARC_LIFETIME_S
			const step = Math.floor(life * FLICKER_STEPS)
			const seed = this.seed[alive - 1] + step * 7919
			const joints = jointsFor(span)
			const wander = span * WANDER

			// Screen-space thickness, so the bolt is legible whether the camera is on top of the
			// coil or watching the whole battle. A fixed world radius is exactly why firing used
			// to be invisible at gameplay zoom.
			const midX = (sx + tx) * 0.5, midY = (sy + ty) * 0.5, midZ = (sz + tz) * 0.5
			const distance = Math.hypot(midX - eyeX, midY - eyeY, midZ - eyeZ)
			const wanted = PIXEL_WIDTH * METRES_PER_PIXEL * distance * 0.5
			const radius = wanted < MIN_R ? MIN_R : wanted > MAX_R ? MAX_R : wanted
			// Bright at the strike, fading fast — the eye reads the decay as discharge.
			const fade = 1 - life * 0.75
			const thickness = (radius / ARC_R) * fade * this.width[alive - 1]
			// Ultra: a pooled light at the coil and one at the contact while the bolt lives, flickering
			// with the discharge steps. Unshadowed, and only for bolts whose both ends are seen.
			if (layers && light !== null) {
				const pulse = (0.75 + 0.25 * hash(seed + 29)) * fade
				light(sx, sy, sz, 0.9 * pulse * this.width[alive - 1], 1.6 + 1.2 * this.width[alive - 1])
				light(tx, ty, tz, 1.3 * pulse * this.width[alive - 1], 2.0 + 1.4 * this.width[alive - 1])
				lights += 2
			}

			let px = sx, py = sy, pz = sz
			for (let j = 1; j <= joints; j++) {
				const t = j / joints
				let qx: number, qy: number, qz: number
				if (j === joints) {
					// The last joint IS the target. A bolt that misses what it killed is a lie.
					qx = tx; qy = ty; qz = tz
				} else {
					// Wander peaks mid-span and returns to zero at both ends, so the channel leaves
					// the muzzle and arrives at the victim without a kink at either end.
					const taper = Math.sin(t * Math.PI)
					const a = (hash(seed + j * 131) - 0.5) * 2 * wander * taper
					const b = (hash(seed + j * 977) - 0.5) * 2 * wander * taper
					qx = sx + pathX * t + ux * a + vx * b
					qy = sy + pathY * t + uy * a + vy * b
					qz = sz + pathZ * t + uz * a + vz * b
				}
				const len = Math.hypot(qx - px, qy - py, qz - pz)
				if (write(this.instances, segments * FLOATS_PER_SEGMENT, px, py, pz,
					qx - px, qy - py, qz - pz, len, thickness, thickness)) segments++
				if (layers) {
					if (write(this.coreInstances, coreSegments * FLOATS_PER_SEGMENT, px, py, pz,
						qx - px, qy - py, qz - pz, len, thickness * 0.36, thickness * 0.36)) coreSegments++
					if (write(this.fringeInstances, fringeSegments * FLOATS_PER_SEGMENT, px, py, pz,
						qx - px, qy - py, qz - pz, len, thickness * 2.6, thickness * 2.6)) fringeSegments++
				}
				px = qx; py = qy; pz = qz
			}

			// Forks. They start at a joint on the main channel, run a short way off-axis and stop
			// in mid-air, which is what a real discharge does and what a single clean line never
			// looks like. Thinner than the channel so the eye still follows the main path.
			const branches = 1 + Math.floor(hash(seed + 613) * this.branchCap[alive - 1])
			for (let b = 0; b < branches; b++) {
				const at = 0.25 + hash(seed + b * 331) * 0.5
				let bx = sx + pathX * at, by = sy + pathY * at, bz = sz + pathZ * at
				const offA = (hash(seed + b * 17) - 0.5) * 2
				const offB = (hash(seed + b * 53) - 0.5) * 2
				const reach = span * (0.10 + hash(seed + b * 89) * 0.14)
				for (let j = 1; j <= BRANCH_JOINTS; j++) {
					const f = j / BRANCH_JOINTS
					const nx = bx + (ux * offA + vx * offB) * reach * f + dx * reach * 0.35 * f
					const ny = by + (uy * offA + vy * offB) * reach * f + dy * reach * 0.35 * f
					const nz = bz + (uz * offA + vz * offB) * reach * f + dz * reach * 0.35 * f
					const len = Math.hypot(nx - bx, ny - by, nz - bz)
					if (write(this.instances, segments * FLOATS_PER_SEGMENT, bx, by, bz,
						nx - bx, ny - by, nz - bz, len, thickness * 0.55, thickness * 0.55)) segments++
					if (layers && write(this.coreInstances, coreSegments * FLOATS_PER_SEGMENT, bx, by, bz,
						nx - bx, ny - by, nz - bz, len, thickness * 0.22, thickness * 0.22)) coreSegments++
					bx = nx; by = ny; bz = nz
				}
			}
		}
		this.count = alive
		this.stats.active = alive
		this.stats.segments = segments
		this.stats.coreSegments = coreSegments
		this.stats.fringeSegments = fringeSegments
		this.stats.lights = lights
		return segments
	}
}
