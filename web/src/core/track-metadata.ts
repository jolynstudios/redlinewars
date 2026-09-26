import type { Mesh } from '../geo/mesh'

/** Boot-only source tags. Never inferred from positions or propagated through QEM. */
const tags = new WeakMap<Mesh, Uint8Array>()
export function bindTrackTags(mesh: Mesh, encoded: string): void {
 const raw = atob(encoded), data = Uint8Array.from(raw, c => c.charCodeAt(0))
 if (data.length !== mesh.vertexCount * 3) throw new Error('Track tag count mismatch')
 for (let v=0;v<mesh.vertexCount;v++) {
  const ordinal=data[v*3],descriptor=data[v*3+1],kind=data[v*3+2]
  if (descriptor!==0 || ![0,3,4].includes(kind) || (kind===3 ? ordinal>=46 : ordinal!==0)) throw new Error('Invalid track tag')
  if(kind && (!mesh.skinned || mesh.skinIndices![v*4]!==0 || mesh.skinWeights![v*4]!==1)) throw new Error('Track path vertex must belong rigidly to chassis')
 }
 for(let i=0;i<mesh.triangleCount*3;i+=3) {
  const a=mesh.indices[i]*3
  for(let j=1;j<3;j++)for(let k=0;k<3;k++)if(data[mesh.indices[i+j]*3+k]!==data[a+k])throw new Error('Mixed link tags within triangle')
 }
 tags.set(mesh,data)
}
export function trackTags(mesh: Mesh): Uint8Array|undefined { return tags.get(mesh) }
