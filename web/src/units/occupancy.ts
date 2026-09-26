// STEELSEED — units/occupancy
//
// OpenRA blocks building cells correctly. Units still look like they drive through
// houses because the drawn mesh is longer than the cell it occupies. Occupancy is
// gameplay and does not move; this module is the presentation shrink-to-fit.

/** One OpenRA cell in render metres (`WDist 1024` → 1 m). */
export const CELL_M = 1
/** Leave a visible gap so a hull parked in the next cell does not sit in the wall. */
export const FIT_INSET = 0.88

/**
 * Occupied rectangle in metres. Footprint rows are the occupancy mask (`x` / `_`);
 * `dimensions` is OpenRA `Building.Dimensions` as `"W,H"`. Mobile actors with neither
 * occupy one cell.
 */
export function occupancyMeters(
	footprint: readonly string[] | null | undefined,
	dimensions: string | null | undefined,
): { x: number; z: number } {
	if (footprint && footprint.length > 0) {
		let cols = 0
		for (const row of footprint) cols = Math.max(cols, row.length)
		return { x: Math.max(1, cols) * CELL_M, z: footprint.length * CELL_M }
	}
	if (dimensions) {
		const parts = dimensions.split(',')
		const dx = Number.parseFloat(parts[0] ?? '')
		const dz = Number.parseFloat(parts[1] ?? '')
		if (dx > 0 && dz > 0) return { x: dx * CELL_M, z: dz * CELL_M }
	}
	return { x: CELL_M, z: CELL_M }
}

/**
 * Uniform scale that puts a mesh's XZ span inside the occupancy rectangle.
 * Never enlarges: a small infantry already inside the cell stays as authored.
 */
export function fitScaleForMesh(spanX: number, spanZ: number, occX: number, occZ: number): number {
	const meshLong = Math.max(spanX, spanZ, 1e-4)
	const meshShort = Math.max(Math.min(spanX, spanZ), 1e-4)
	const occLong = Math.max(occX, occZ, 1e-4)
	const occShort = Math.max(Math.min(occX, occZ), 1e-4)
	const scale = Math.min(
		(occLong * FIT_INSET) / meshLong,
		(occShort * FIT_INSET) / meshShort,
	)
	if (!(scale > 0) || !Number.isFinite(scale)) return 1
	return scale >= 1 ? 1 : scale
}

/** Terrain support is measured from running gear, not gun barrels or stale CPU bounds.
 * The caller's existing visual fit remains unchanged. This does not alter engine occupancy.
 */
export function supportHalfExtents(
 mesh: {readonly aabbMin: ArrayLike<number>; readonly aabbMax: ArrayLike<number>},
 fitScale: number,
 contact?: {readonly contactMinX:number; readonly contactMaxX:number; readonly leftZ:number; readonly rightZ:number; readonly width:number} | null,
): {halfLen:number;halfWid:number} {
 const halfLen=contact ? Math.max(Math.abs(contact.contactMinX),Math.abs(contact.contactMaxX))
  : Math.max(Math.abs(mesh.aabbMin[0]),Math.abs(mesh.aabbMax[0]))*fitScale
 const halfWid=contact ? Math.max(Math.abs(contact.leftZ),Math.abs(contact.rightZ))+contact.width*.5
  : Math.max(Math.abs(mesh.aabbMin[2]),Math.abs(mesh.aabbMax[2]))*fitScale
 return {halfLen:Math.max(.12,Number.isFinite(halfLen)?halfLen:.12),halfWid:Math.max(.12,Number.isFinite(halfWid)?halfWid:.12)}
}
