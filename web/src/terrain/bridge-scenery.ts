import type { Ctx } from '../core'
import { fetchAssetPack } from '../core/asset-pack'
import { decodeMeshBake } from '../geo/mesh-bake'
import MANIFEST from '../../.forge/landmarks/manifest.json'
import { HERO_BRIDGE, type BridgeLandmark, type BridgeState } from './bridge-contract'
import type { GpuMesh, RenderApi } from './types'
const files=import.meta.glob<string>('../../.forge/landmarks/*.ssmesh.gz',{eager:true,query:'?url',import:'default'})
interface Instance {readonly matrix:Float32Array;readonly color:Uint8Array;readonly damage:Float32Array}
export class BridgeScenery {
 private readonly meshes=new Map<BridgeState,GpuMesh>();private readonly instances=new Map<number,Instance>()
 async init(ctx:Ctx,render:RenderApi):Promise<void>{
  if(!ctx.device)return
  for(const state of ['intact','partial','dead'] as const){
   const id='planx.bridge.'+state,entry=MANIFEST.assets[id as keyof typeof MANIFEST.assets],url=files['../../.forge/landmarks/'+entry.file]
   if(!url)throw Error('Missing bridge geometry '+id)
   const bytes=await fetchAssetPack(url,entry),{mesh,info}=decodeMeshBake(bytes)
   if(info.skinned||info.vertices!==entry.vertices||info.triangles!==entry.triangles)throw Error('Invalid static bridge payload '+id)
   const validation=mesh.validate();if(validation)throw Error('Bridge '+id+': '+validation)
   this.meshes.set(state,render.upload(mesh,id))
  }
 }
 submit(bridges:Iterable<BridgeLandmark>,render:RenderApi):void{
  for(const b of bridges){
   const mesh=this.meshes.get(b.state);if(!mesh)continue
   let instance=this.instances.get(b.id)
   if(!instance){instance={matrix:Float32Array.of(1,0,0,0,0,1,0,0,0,0,1,0,b.x,HERO_BRIDGE.meshOffsetM[1],b.z+HERO_BRIDGE.meshOffsetM[2],1),color:Uint8Array.of(0),damage:new Float32Array(1)};this.instances.set(b.id,instance)}
   instance.damage[0]=b.state==='intact'?0:b.state==='partial'?.55:.95
   render.submit({mesh,surfaceSet:'industrial-v1:planx.bridge.'+b.state,instances:instance.matrix,instanceCount:1,playerColors:instance.color,damages:instance.damage,castsShadow:true})
  }
 }
}
