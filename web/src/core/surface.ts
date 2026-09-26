// STEELSEED — core/surface
// The shared surface-type enum. Tagged on terrain cells and hit results; consumed by
// fx (dust, debris, sparks), audio (footsteps, impacts, engine surface noise) and
// terrain (material blending).
//
// ARCHITECTURE.md §8: every consumer must handle all 13. A `default:` branch that
// silently does nothing is a gate failure — missing dust on `gravel` is exactly the
// kind of gap that ships unnoticed.

export const Surface = {
	soil: 0,
	rock: 1,
	sand: 2,
	gravel: 3,
	grass: 4,
	road: 5,
	metal: 6,
	concrete: 7,
	water: 8,
	shallow: 9,
	snow: 10,
	ash: 11,
	resource: 12,
} as const

export type SurfaceType = (typeof Surface)[keyof typeof Surface]

export const SURFACE_COUNT = 13

export const SURFACE_NAMES: readonly string[] = [
	'soil', 'rock', 'sand', 'gravel', 'grass', 'road', 'metal',
	'concrete', 'water', 'shallow', 'snow', 'ash', 'resource',
]

/**
 * Exhaustiveness helper. Build a lookup with this rather than a switch, and a missing
 * surface becomes a type error at compile time instead of silence at runtime.
 *
 *   const dust = surfaceTable({ soil: ..., rock: ..., /* all 13 *\/ })
 */
export function surfaceTable<T>(entries: Record<keyof typeof Surface, T>): readonly T[] {
	const out = new Array<T>(SURFACE_COUNT)
	for (const [name, idx] of Object.entries(Surface)) out[idx] = entries[name as keyof typeof Surface]
	return out
}
