import { fetchAssetPack } from '../core/asset-pack'
import { decodeBlenderAsset, type BlenderAsset } from './blender-mesh'
import { bindTrackTags } from '../core/track-metadata'
import type { TrackLoop } from '../core/track-loop'
import DESCRIPTOR from '../core/track-loops.json'

interface TrackLevel extends BlenderAsset {
 readonly level:number; readonly offset:number; readonly bytes:number; readonly vertices:number; readonly triangles:number
 readonly sha256:string; readonly trackTags:string; readonly trackLoop:TrackLoop
}
export interface TrackManifest {
 readonly schema:number; readonly id:string; readonly file:string; readonly compression:string
 readonly bytes:number; readonly storedBytes:number; readonly sha256:string
 readonly parentSourcePath:string; readonly parentSourceSha256:string
 readonly descriptor: { readonly loop:TrackLoop; readonly sourceSha256:string; readonly roadBones:readonly number[]; readonly roadRadius:number; readonly sideZ:number }
 readonly levels:readonly TrackLevel[]
}
const manifests=import.meta.glob<TrackManifest>('../../.forge/track-lods/manifest.json',{eager:true,import:'default'})
const packs=import.meta.glob<string>('../../.forge/track-lods/tracks.ssmesh.gz',{eager:true,query:'?url',import:'default'})
const bad=(s:string):never=>{throw new Error('Track assets: '+s)}
const hash=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s)
const sha=async(b:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b as Uint8Array<ArrayBuffer>)),v=>v.toString(16).padStart(2,'0')).join('')
/** Base rig is fully populated; reduced levels may intentionally omit small wind-owned flags. */
export async function verifyTrackAssets(manifest:TrackManifest,url:string,descriptor=DESCRIPTOR):Promise<{manifest:TrackManifest;levels:readonly ReturnType<typeof decodeBlenderAsset>[]}> {
 const m=manifest
 if(m.schema!==1||m.id!=='1tnk-tracks-v1'||m.file!=='tracks.ssmesh.gz'||m.compression!=='gzip'||!hash(m.parentSourceSha256)||!Array.isArray(m.levels)||m.levels.length!==3||m.bytes>8*1048576)bad('manifest schema/budget')
 if(JSON.stringify(m.descriptor)!==JSON.stringify(descriptor)||m.descriptor.sourceSha256!==m.parentSourceSha256)bad('compiled descriptor/source mismatch')
 const local=new URL(url,location.href);if(local.origin!==location.origin)bad('cross-origin pack')
 let end=0,triangles=Infinity
 for(const [i,l]of m.levels.entries()) {
  if(l.level!==i||l.offset!==end||!Number.isSafeInteger(l.bytes)||l.bytes<32||l.bytes%4||!hash(l.sha256)||!hash(l.sourceSha256)||l.triangles>=triangles||l.triangles<1||!l.rig||l.materialSet!=='industrial-v1'||!l.materialTable?.length||typeof l.trackTags!=='string')bad('LOD metadata')
  if(i===0&&(l.sourceSha256!==m.parentSourceSha256||l.sourcePath!==m.parentSourcePath))bad('parent mismatch')
  if(JSON.stringify(l.rig)!==JSON.stringify(m.levels[0].rig)||JSON.stringify(l.materialTable)!==JSON.stringify(m.levels[0].materialTable)||JSON.stringify(l.trackLoop)!==JSON.stringify(m.descriptor.loop))bad('LOD rig/material/path mismatch')
  end+=l.bytes;triangles=l.triangles
 }
 if(end!==m.bytes)bad('pack range mismatch')
 const bytes=await fetchAssetPack(url,m),levels=[]
 for(const [i,l]of m.levels.entries()) {
  if(await sha(bytes.subarray(l.offset,l.offset+l.bytes))!==l.sha256)bad('LOD hash mismatch')
  const decoded=decodeBlenderAsset(bytes,l,i>0),mesh=decoded.mesh
  const problem=mesh.validate();if(problem)bad(problem)
  for(let v=0;v<mesh.vertexCount;v++) {
   let nn=0,tt=0,nt=0;for(let k=0;k<3;k++){const n=mesh.normals[v*3+k],t=mesh.tangents[v*4+k];nn+=n*n;tt+=t*t;nt+=n*t}
   if(Math.abs(nn-1)>1e-4||Math.abs(tt-1)>1e-4||Math.abs(nt)>1e-4||Math.abs(mesh.tangents[v*4+3])!==1)bad('tangent frame')
  }
  bindTrackTags(mesh,l.trackTags);levels.push(decoded)
 }
 return{manifest:m,levels}
}
export async function loadTrackAssets() {
 const m=Object.values(manifests)[0],url=Object.values(packs)[0]
 if(!m&&!url)return null
 if(!m||!url)bad('incomplete authored pack')
 return verifyTrackAssets(m,url)
}
