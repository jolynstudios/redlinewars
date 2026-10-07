import { ZONE_BYTE_OFFSET, type Mesh, type GpuMeshBuffers } from './mesh'

// Ground marks (tyre and track ruts) are unit squares stamped along travel. Without a
// rim fade each stamp drew as a hard-edged plate, and a trail on snow read as a row of
// overlapping squares. Same explicit opt-in as foam coverage: zone.w=6 asks the late
// translucent fragment for the mark rim mask.
const MARK = Symbol.for('steelseed.groundMarkCoverage')
export function markGroundMarkCoverage(mesh: Mesh): void { Object.defineProperty(mesh, MARK, { value: true }) }
export function hasGroundMarkCoverage(mesh: Mesh): boolean { return (mesh as unknown as Record<symbol, unknown>)[MARK] === true }
export function packGroundMarkCoverage(mesh: Mesh, packed: GpuMeshBuffers): void {
	if (!hasGroundMarkCoverage(mesh)) return
	const bytes = new Uint8Array(packed.vertexData)
	for (let v = 0; v < packed.vertexCount; v++) {
		const offset = v * packed.stride + ZONE_BYTE_OFFSET + 1
		if (bytes[offset] || bytes[offset + 1] || bytes[offset + 2]) throw new Error('Ground-mark coverage cannot replace existing terrain/track/window metadata')
		bytes[offset + 2] = 6 // zone.w=6: rim fade in the existing late translucent fragment.
	}
}
