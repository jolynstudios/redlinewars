// Optional source-bound damage UV1 masks. PBR arrays remain shared with the parent.
import { fetchAssetPack } from '../core/asset-pack'
import { maskMip, MaskedSurfaceSet } from './actor-masks'
import type { ForgedSurfaceSet } from './forge'

export interface DamageMask {
 readonly file:string;readonly compression:'gzip';readonly bytes:number;readonly storedBytes:number;readonly sha256:string
 readonly size:number;readonly uv:number;readonly channels:string;readonly origin:string;readonly sourceSha256:string
}
interface Entry {readonly state:string;readonly sourceSha256?:string;readonly materialSet?:string;readonly detailMask?:DamageMask}
interface Manifest {readonly schema:number;readonly actor:string;readonly parentSourceSha256:string;readonly states:readonly Entry[]}
const manifests=import.meta.glob<Manifest>('../../.forge/damage-states/*/manifest.json',{eager:true,import:'default'})
const files=import.meta.glob<string>('../../.forge/damage-states/*/masks/*.gz',{eager:true,query:'?url',import:'default'})
const rosters=import.meta.glob<{assets:Record<string,{sourceSha256?:string}>}>('../../.forge/blender/manifest.json',{eager:true,import:'default'})
const RUNG:Readonly<Record<string,number>>={Light:1,Medium:2,Heavy:3,Critical:4,Dead:5}
export function validateDamageMask(actor:string,entry:Entry,baseId:string):DamageMask|null {
 const m=entry.detailMask;if(!m)return null
 const rung=RUNG[entry.state]
 if(!/^[a-z0-9_-]+$/.test(actor)||!rung||entry.materialSet!==baseId||m.file!==`masks/${actor}.d${rung}.mask.rgba.gz`||m.size!==256||m.bytes!==256*256*4||m.compression!=='gzip'||!Number.isInteger(m.storedBytes)||m.storedBytes<1||m.storedBytes>m.bytes+1024||m.uv!==1||m.origin!=='bottom-left'||m.channels!=='ao,cavity,dirt,wear'||!/^[a-f0-9]{64}$/.test(m.sha256)||!/^[a-f0-9]{64}$/.test(m.sourceSha256)||m.sourceSha256!==entry.sourceSha256)throw Error('Invalid source-bound damage mask '+actor+':'+entry.state)
 return m
}
export async function buildDamageMasks(device:GPUDevice,base:ForgedSurfaceSet,maximumSize:number):Promise<ForgedSurfaceSet[]> {
 const sets:ForgedSurfaceSet[]=[],roster=Object.values(rosters)[0]
 if(new URLSearchParams(location.search).get('noforge')==='1')return sets
 try{
  for(const [path,manifest]of Object.entries(manifests)){
   const actor=/\/damage-states\/([^/]+)\//.exec(path)?.[1]
   if(!actor||manifest.schema!==1||manifest.actor!==actor)throw Error('Invalid damage mask manifest')
   if(roster?.assets[actor]?.sourceSha256!==manifest.parentSourceSha256)continue
   const seen=new Set<string>()
   for(const entry of manifest.states){
    const m=validateDamageMask(actor,entry,base.id);if(!m)continue
    const id=base.id+':damage:'+actor+':'+entry.state;if(seen.has(id))throw Error('Duplicate damage mask '+id);seen.add(id)
    const url=files[`../../.forge/damage-states/${actor}/${m.file}`];if(!url)throw Error('Missing damage mask '+id)
    let pixels=await fetchAssetPack(url,m),size=m.size
    while(size>maximumSize){pixels=maskMip(pixels,size);size>>=1}
    const count=Math.log2(size)+1,texture=device.createTexture({label:'steelseed/materials/damage-mask/'+actor+'/'+entry.state,size:[size,size],mipLevelCount:count,format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST})
    let info:GPUBuffer|null=null
    try{
     let bytes=0,side=size
     for(let mip=0;mip<count;mip++){device.queue.writeTexture({texture,mipLevel:mip},pixels as Uint8Array<ArrayBuffer>,{bytesPerRow:side*4,rowsPerImage:side},[side,side]);bytes+=pixels.byteLength;if(side>1){pixels=maskMip(pixels,side);side>>=1}}
     info=device.createBuffer({label:'damage-mask-info/'+id,size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
     const buffer=new ArrayBuffer(32),u=new Uint32Array(buffer),f=new Float32Array(buffer);u[0]=base.layerCount;u[1]=base.mipCount;f[4]=base.tileMeters;f[5]=base.heightRange;f[6]=base.tileMeters/base.size;device.queue.writeBuffer(info,0,buffer)
     const set=new MaskedSurfaceSet(base,id,texture,info,bytes);Object.defineProperty(set,'sourceSha256',{value:entry.sourceSha256});sets.push(set)
    }catch(error){texture.destroy();info?.destroy();throw error}
   }
  }
  return sets
 }catch(error){for(const set of sets)set.dispose();throw error}
}
