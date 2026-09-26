import { fetchAssetPack } from '../core/asset-pack'
import { maskMip, MaskedSurfaceSet } from './actor-masks'
import type { ForgedSurfaceSet } from './forge'
import MANIFEST from '../../.forge/landmarks/manifest.json'
const files=import.meta.glob<string>('../../.forge/landmarks/masks/*.gz',{eager:true,query:'?url',import:'default'})
export async function buildLandmarkMasks(device:GPUDevice,base:ForgedSurfaceSet,maximumSize:number):Promise<ForgedSurfaceSet[]> {
 const sets:ForgedSurfaceSet[]=[]
 try {
  for(const[id,entry]of Object.entries(MANIFEST.assets)){
   const m=entry.detailMask;if(entry.materialSet!==base.id||m.channels!=='ao,cavity,dirt,wear'||m.uv!==1||m.origin!=='bottom-left'||m.bytes!==m.size*m.size*4)throw Error('Invalid landmark material '+id)
   const url=files['../../.forge/landmarks/'+m.file];if(!url)throw Error('Missing landmark mask '+id)
   let pixels=await fetchAssetPack(url,m),size=m.size;while(size>maximumSize){pixels=maskMip(pixels,size);size>>=1}
   // The steelseed/materials/ prefix is load-bearing: tools/vramgate.mjs censuses textures by
   // it, and an unlabelled texture is claimed by vramBytes but invisible to that census —
   // three 256px masks here read as a 1.00 MiB accounting over-claim.
   const count=Math.log2(size)+1,texture=device.createTexture({label:'steelseed/materials/landmark-mask/'+id,size:[size,size],mipLevelCount:count,format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST})
   let bytes=0,side=size;for(let mip=0;mip<count;mip++){
    device.queue.writeTexture({texture,mipLevel:mip},pixels as Uint8Array<ArrayBuffer>,{bytesPerRow:side*4,rowsPerImage:side},[side,side]);bytes+=pixels.length
    if(side>1){pixels=maskMip(pixels,side);side>>=1}
   }
   const info=device.createBuffer({label:'steelseed/materials/landmark-mask-info/'+id,size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),buffer=new ArrayBuffer(32),u=new Uint32Array(buffer),f=new Float32Array(buffer)
   u[0]=base.layerCount;u[1]=base.mipCount;f[4]=base.tileMeters;f[5]=base.heightRange;f[6]=base.tileMeters/base.size;device.queue.writeBuffer(info,0,buffer)
   sets.push(new MaskedSurfaceSet(base,base.id+':'+id,texture,info,bytes))
  }
  return sets
 }catch(error){for(const set of sets)set.dispose();throw error}
}
