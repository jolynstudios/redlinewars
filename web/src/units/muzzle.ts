// STEELSEED — units/muzzle
//
// Presentation-only barrel tips. OpenRA still fires from sprite-era LocalOffset; this module
// puts the FLASH and the TRACER on the barrel that is actually drawn.
//
// The old correction was a scalar Y lift. A yaw rotation preserves height, so that got the
// flash off the tracks, but it left the sim's lateral/forward offset in place. Measured
// against the authored 4tnk muzzle brake that offset is a quarter-metre beside the tube.
// Multi-gun tanks also share one lift, so a Mammoth Tusk left the cannon instead of its
// launcher. This writes the 3-D rest-pose point, yaws it with the turret, then multiplies
// by the same instance matrix units already placed.

export interface MuzzleBind {
	/** Authored primary barrel tip in model metres (X forward, Y up, Z lateral). */
	readonly ax: number
	readonly ay: number
	readonly az: number
	/** True when this armament's rules fire from a mirrored left/right pair. */
	readonly dual: Uint8Array
	readonly armX: Float32Array
	readonly armY: Float32Array
	readonly armZ: Float32Array
	/** Turret index per armament, or 255 when the gun is hull-mounted. */
	readonly armTurret: Uint8Array
	/** Hull-space turret origin per armament (forward, up, lateral). */
	readonly turretOx: Float32Array
	readonly turretOy: Float32Array
	readonly turretOz: Float32Array
	readonly weapons: readonly string[]
}

/** Column-major 4x4: world = M * (turretOrigin + Ry(turretRel) * (local - turretOrigin)). */
export function transformMuzzleWorld(
	matrix: Float32Array,
	matrixOffset: number,
	turretRel: number,
	lx: number,
	ly: number,
	lz: number,
	out: Float32Array,
	outOffset = 0,
	ox = 0,
	oy = 0,
	oz = 0,
): void {
	const c = Math.cos(turretRel)
	const s = Math.sin(turretRel)
	const rx = lx - ox
	const rz = lz - oz
	// Same yaw convention as placeActor: local +X -> (cos, 0, -sin). Pivot is the turret, not the hull.
	const x = ox + rx * c + rz * s
	const y = oy + (ly - oy)
	const z = oz - rx * s + rz * c
	const o = matrixOffset
	out[outOffset] = matrix[o] * x + matrix[o + 4] * y + matrix[o + 8] * z + matrix[o + 12]
	out[outOffset + 1] = matrix[o + 1] * x + matrix[o + 5] * y + matrix[o + 9] * z + matrix[o + 13]
	out[outOffset + 2] = matrix[o + 2] * x + matrix[o + 6] * y + matrix[o + 10] * z + matrix[o + 14]
	out[outOffset + 3] = matrix[o] * c + matrix[o + 8] * s
	out[outOffset + 4] = matrix[o + 1] * c + matrix[o + 9] * s
	out[outOffset + 5] = matrix[o + 2] * c + matrix[o + 10] * s
}

/**
 * Inverse of `transformMuzzleWorld`'s linear part: world point -> turret-local Z, used to
 * pick the left or right tube of a dual-barrel gun.
 */
export function turretLocalZ(
	matrix: Float32Array,
	matrixOffset: number,
	turretRel: number,
	wx: number,
	wy: number,
	wz: number,
	ox = 0,
	oz = 0,
): number {
	const o = matrixOffset
	const dx = wx - matrix[o + 12]
	const dy = wy - matrix[o + 13]
	const dz = wz - matrix[o + 14]
	const xLen = Math.hypot(matrix[o], matrix[o + 1], matrix[o + 2]) || 1
	const inv = 1 / xLen
	const hx = (matrix[o] * dx + matrix[o + 1] * dy + matrix[o + 2] * dz) * inv - ox
	const hz = (matrix[o + 8] * dx + matrix[o + 9] * dy + matrix[o + 10] * dz) * inv - oz
	const s = Math.sin(turretRel)
	const c = Math.cos(turretRel)
	return hx * s + hz * c
}

/** Rest-pose HULL-space point for this shot. Primary uses the authored barrel; others keep their own turret mount, lifted to barrel height. */
export function resolveMuzzleLocal(
	bind: MuzzleBind,
	armament: number,
	simLocalZ: number,
	out: Float32Array,
): void {
	const n = bind.weapons.length
	const arm = n === 0 ? 0 : Math.min(Math.max(armament, 0), n - 1)
	const primary = arm === 0 || n === 1
	const ox = bind.turretOx[arm] ?? 0
	const oy = bind.turretOy[arm] ?? 0
	const oz = bind.turretOz[arm] ?? 0
	let lx: number
	let ly: number
	let lz: number
	if (primary) {
		lx = bind.ax
		ly = bind.ay
		lz = bind.az
	} else {
		// Hull-center LocalOffset is real (a PT boat's depth charge). Do not steal the gun barrel.
		lx = ox + bind.armX[arm]
		lz = oz + bind.armZ[arm]
		const keel = Math.abs(bind.armX[arm]) < 0.05 && Math.abs(bind.armY[arm]) < 0.05
		ly = keel ? oy + bind.armY[arm] : bind.ay
	}
	const localZ = lz - oz
	if (bind.dual[arm] !== 0 && simLocalZ * localZ < 0 && Math.abs(localZ) > 0.04)
		lz = oz - localZ
	out[0] = lx
	out[1] = ly
	out[2] = lz
}
