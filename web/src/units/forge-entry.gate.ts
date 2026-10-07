// Bundle entry for tools/forge.mjs only. The procedural generator remains source of truth.

import { rootRng } from '../core'
import { Mesh } from '../geo/mesh'
import ROSTER from './archetype/roster.json'
import type { RosterSlot } from './archetype/params'
import { encodeMeshBake } from './mesh-bake'
import { buildUnitFromSlot, type UnitBuildMetadata } from './shapes'

export const FORGE_SLOT = 'foundry_crucible'
export const FORGE_SEED = 'steelseed-default'
export const FORGE_VERSION = 1

export function bakeForgeProof(): { bytes: Uint8Array; vertices: number; triangles: number } {
	const mesh = new Mesh()
	const metadata: UnitBuildMetadata = { rig: null, rigSkipReason: null }
	// Runtime deliberately reuses one scratch mesh across roster order. Replaying the prefix
	// preserves its established vertex layout exactly; baking the target in isolation changed
	// stride 68 to 60 even though the rendered positions were identical.
	for (const slot of (ROSTER as { slots: RosterSlot[] }).slots) {
		buildUnitFromSlot(mesh, slot, rootRng(FORGE_SEED).forkNamed(`units/slot/${slot.name}`), metadata)
		if (slot.name !== FORGE_SLOT) continue
		if (metadata.rig !== null) throw new Error('forge proof selected a rigged mesh; rig metadata is not in the v1 bake')
		return { bytes: encodeMeshBake(mesh), vertices: mesh.vertexCount, triangles: mesh.triangleCount }
	}
	throw new Error(`forge slot '${FORGE_SLOT}' is absent from the roster`)
}
