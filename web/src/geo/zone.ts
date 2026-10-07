// STEELSEED — geo/zone
// Painting a finished mesh into material zones.
//
// §12.1 gives every surface set four texture layers and `render/shaders.ts` already selects
// between them per vertex — `out.layer = min(vin.zone.x, layers - 1u)`. The path works end to
// end. Nothing has ever used it: `surfaceNets` calls `addVertex` with six arguments, so the
// zone defaults to 0, and no generator has ever called `setZone`. The measured consequence is
// that all 97 actors sample layer 0 of one of two sets, so the entire roster is painted with
// exactly two appearances.
//
// WHY THIS LABELS RATHER THAN SPLITS. The obvious way to give a tank rubber tracks is to mesh
// the tracks separately. That would break §9.1. The Foundry reads as "one continuous casting"
// because `tracked.ts` smooth-unions the track run into the hull at `joinRadius` 3.0, and the
// fillet that produces IS the faction's silhouette. Meshing the parts apart deletes it.
//
// So the mesh stays exactly as it is — one welded surface, one draw — and vertices are
// LABELLED by which region they fall in. That is the same trick `geo/rig.ts` uses to bind
// skin weights to bones on an already-merged mesh, and it works for the same reason: the
// generator still knows where its parts are, even after the union has fused them.

import type { Mesh } from './mesh'
import { evalSdf, type Sdf } from './sdf'

/**
 * Material zone ids. These are indices into a surface set's texture layers, so the meaning of
 * each is set by `materials/sets.ts` and the two must be read together.
 *
 * Deliberately a small, FUNCTIONAL vocabulary rather than one entry per actor: a zone says
 * what a surface is made of and what happens to it, which is §14.13's kind of statement.
 */
export const Zone = {
	/** Painted structural steel. The default, and most of every actor. */
	hull: 0,
	/** Running gear — rubber track pad, tyre, road wheel. Dark, matte, dusty. */
	running: 1,
	/** Glass and sensor faces. Optics, vision blocks, dish faces. */
	optic: 2,
	/** Heat-affected metal — exhaust stacks, manifolds, muzzle. Scorched, discoloured. */
	exhaust: 3,
} as const
export type Zone = (typeof Zone)[keyof typeof Zone]

/**
 * Packed material-zone byte.
 *
 * Bits 0..6 are the material layer. Bit 7 is orthogonal SOURCE data: it says that this
 * finished surface emits light, while the sampled material's albedo alpha selects the warm
 * or cool emitter class. Keeping the flag out of the layer vocabulary is load-bearing:
 * Zone 4 becomes a legal material layer when §12.5 expands a set from four layers to eight.
 */
export const MATERIAL_ZONE_LAYER_MASK = 0x7f
export const ZoneFlag = {
	/** The surface contributes material emission in the forward fragment stage. */
	emissive: 0x80,
} as const
export type ZoneFlag = (typeof ZoneFlag)[keyof typeof ZoneFlag]

/** Resolve the material layer without allowing orthogonal source flags to change it. */
export function materialLayerOf(zone: number): number {
	return zone & MATERIAL_ZONE_LAYER_MASK
}

/** Add a packed source flag while preserving the material layer. */
export function withZoneFlag(zone: number, flag: ZoneFlag): number {
	return materialLayerOf(zone) | flag
}

/** Test one packed source flag without interpreting it as a material layer. */
export function hasZoneFlag(zone: number, flag: ZoneFlag): boolean {
	return (zone & flag) !== 0
}

// The GPU varying is flat and pinned to the primitive's first vertex. Uniformly flagged FX
// meshes are exact. A future PARTIALLY emissive mesh must split vertices/triangles at its flag
// boundary or it will inherit provoking-vertex artefacts across that boundary.

/** One labelled region: every vertex inside `tree` (or nearest to it) takes `zone`. */
export interface ZoneRegion {
	readonly zone: number
	readonly tree: Sdf
}

/**
 * Label `mesh`'s vertices by region, in place.
 *
 * A vertex takes the zone of the region whose field is most negative at its position — the
 * one it is deepest inside. `slack` lets a vertex just OUTSIDE a region still claim it, which
 * matters because the smooth union pulls the welded surface away from the sub-shape it was
 * built from: the fillet where a track meets a hull sits outside both. Without slack that
 * fillet stays hull-coloured and the join reads as a seam of the wrong material.
 *
 * Vertices matching no region keep whatever zone they already have, which is `Zone.hull`.
 *
 * Boot-time only. This is O(vertices x regions) SDF evaluations — a few thousand per actor,
 * against the ~2,700-vertex meshes this project builds — and it allocates nothing.
 */
export function applyZones(mesh: Mesh, regions: readonly ZoneRegion[], slack = 0.04): number {
	if (regions.length === 0) return 0
	const pos = mesh.positions
	let painted = 0
	for (let v = 0; v < mesh.vertexCount; v++) {
		const o = v * 3
		const x = pos[o], y = pos[o + 1], z = pos[o + 2]
		let best = slack
		let bestZone = -1
		for (let r = 0; r < regions.length; r++) {
			const d = evalSdf(regions[r].tree, x, y, z)
			if (d >= best) continue
			best = d
			bestZone = regions[r].zone
		}
		if (bestZone < 0) continue
		mesh.setZone(v, bestZone)
		painted++
	}
	return painted
}
