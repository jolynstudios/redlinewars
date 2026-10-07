import { ZONE_BYTE_OFFSET, type Mesh, type GpuMeshBuffers } from './mesh'

// Explicit runtime-only presentation metadata. A global symbol survives isolated proof
// bundles; ordinary geometry and source material zones never opt in by a label or colour.
const FOAM = Symbol.for('steelseed.foamCoverage')
export function markFoamCoverage(mesh: Mesh): void { Object.defineProperty(mesh, FOAM, { value: true }) }
export function hasFoamCoverage(mesh: Mesh): boolean { return (mesh as unknown as Record<symbol, unknown>)[FOAM] === true }
export function packFoamCoverage(mesh: Mesh, packed: GpuMeshBuffers): void {
 if (!hasFoamCoverage(mesh)) return
 const bytes = new Uint8Array(packed.vertexData)
 for (let v=0;v<packed.vertexCount;v++) {
  const offset=v*packed.stride+ZONE_BYTE_OFFSET+1
  if (bytes[offset] || bytes[offset+1] || bytes[offset+2]) throw new Error('Foam coverage cannot replace existing terrain/track/window metadata')
  bytes[offset+2]=5 // zone.w=5: coverage only in the existing late translucent fragment.
 }
}
