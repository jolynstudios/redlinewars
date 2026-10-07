// STEELSEED — fx/building-materials (vfx.md Epic 5: "handle masonry, industrial, electrical, fuel
// and bridge materials appropriately"; Ultra and Ultra+ only)
//
// A building's collapse (fx/mushroom-cloud `start`) and its crossings into Heavy and Critical
// (`burst`) share one cloud for every structure. What the structure is made of adds a layer on
// top, from the model template the forge already records per actor:
//   electrical  power plants, coils, radar and tech buildings: arcing sparks off the body and
//               a crawl at the foot. No beam, no shield, no EMP ring.
//   fuel        refinery, silos, derricks, the airfield and the helipad: a fuel flash low in the
//               body and heavy soot rising out of it.
//   masonry     barracks, houses, hospitals, the command post and the concrete defences: grey
//               masonry dust and broken stone thrown from the walls.
//   industrial  the yard, factories, depots, docks and the missile silo: torn metal and
//               welding sparks.
// Bridges are not buildings in this roster; they keep the death their weapon draws.
//
// Cosmetic only, bounded (a dozen particles at most per call), seeded from the actor and the
// moment, so a replay draws the same layer, and never where the player cannot see.

import type { ShroudApi } from './types'

export type BuildingMaterial = 'electrical' | 'fuel' | 'masonry' | 'industrial'

/** Model template (art/blender/models.py STRUCTURES) -> what the structure is made of. */
export const MATERIAL_OF: Readonly<Record<string, BuildingMaterial>> = {
	power: 'electrical', coil: 'electrical', radar: 'electrical', tech: 'electrical', experimental: 'electrical',
	refinery: 'fuel', silo: 'fuel', derrick: 'fuel', airfield: 'fuel', helipad: 'fuel',
	barracks: 'masonry', tent: 'masonry', kennel: 'masonry', hospital: 'masonry', house: 'masonry', church: 'masonry',
	lighthouse: 'masonry', windmill: 'masonry', command: 'masonry', defense: 'masonry',
	yard: 'industrial', factory: 'industrial', depot: 'industrial', dock: 'industrial', missile_silo: 'industrial',
}

export interface MaterialSink {
	spawn(name: string, x: number, y: number, z: number, time: number, seed: number, scale: number, shroud: ShroudApi,
		countScale?: number, dirX?: number, dirY?: number, dirZ?: number, spread?: number): void
}

/** Per material: [preset, how many at full strength, height band on the body (0 foot .. 1 roof), size]. */
const LAYERS: Readonly<Record<BuildingMaterial, readonly (readonly [string, number, number, number, number])[]>> = {
	electrical: [['zapspark', 4, 0.35, 0.95, 0.9], ['teslacrawl', 2, 0.0, 0.1, 0.8]],
	fuel: [['fireball', 2, 0.15, 0.4, 1.0], ['soot', 3, 0.4, 0.8, 1.1]],
	masonry: [['rubble', 3, 0.2, 0.6, 0.9], ['hazerock', 3, 0.0, 0.2, 1.1]],
	industrial: [['frag', 3, 0.3, 0.7, 0.9], ['weldspark', 3, 0.3, 0.9, 0.8]],
}

function hash(value: number): number {
	let x = value | 0
	x ^= x << 13
	x ^= x >>> 17
	x ^= x << 5
	return (x >>> 0) / 4294967296
}

/**
 * The material layer at a building standing at (x, ground, z), `tall` metres high and `span`
 * across. `strength` is 1 for the collapse and about half for a crossing. Returns the particle
 * bursts spawned (0 for an unknown template or a building out of sight).
 */
export function spawnBuildingMaterial(template: string, x: number, ground: number, z: number, tall: number, span: number,
	time: number, seed: number, strength: number, density: number, particles: MaterialSink, shroud: ShroudApi): number {
	const material = MATERIAL_OF[template]
	if (material === undefined || !(strength > 0) || !shroud.isVisible(Math.floor(x), Math.floor(z))) return 0
	let spawned = 0
	for (const [preset, count, low, high, size] of LAYERS[material]) {
		const n = Math.max(1, Math.round(count * strength * density))
		for (let k = 0; k < n; k++) {
			const s = (seed * 31 + spawned * 104729 + 7919) | 0
			const a = hash(s) * Math.PI * 2, r = span * 0.5 * (0.35 + 0.6 * hash(s + 1013904223))
			const y = ground + tall * (low + (high - low) * hash(s + 1664525))
			particles.spawn(preset, x + Math.cos(a) * r, y, z + Math.sin(a) * r, time, s, size * (0.6 + 0.4 * strength), shroud)
			spawned++
		}
	}
	return spawned
}
