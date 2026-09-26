// Hash-pinned offline PBR output. Nothing here fetches the external source websites.
import { fetchAssetPack } from '../core/asset-pack'
import { ForgedSurfaceSet } from './forge'
import PALETTE from '../core/blender-palette.json'

interface Range { readonly offset: number; readonly bytes: number; readonly sha256: string }
interface Layer { readonly zone: number; readonly name: string; readonly mips: readonly (readonly Range[])[] }
export interface SurfaceManifest {
 readonly schema: number; readonly id: string; readonly size: number; readonly mipCount: number
 readonly origin: string; readonly tileMeters: number; readonly heightRange: number
 readonly compression: 'gzip'; readonly bytes: number; readonly storedBytes: number; readonly sha256: string
 readonly layers: readonly Layer[]
}
export interface SourceSurfaces { readonly manifest: SurfaceManifest; readonly bytes: Uint8Array }
const manifests=import.meta.glob<SurfaceManifest>('../../.forge/surfaces/manifest.json',{eager:true,import:'default'})
const packs=import.meta.glob<string>('../../.forge/surfaces/surfaces.sspbr.gz',{eager:true,query:'?url',import:'default'})
const BPP=[4,2,4,1] as const

export async function loadSourceSurfaces(): Promise<SourceSurfaces|null> {
 if(new URLSearchParams(location.search).get('nosourcematerials')==='1')return null
 const manifest=Object.values(manifests)[0],url=Object.values(packs)[0]
 if(!manifest&&!url)return null
 if(!manifest||!url)throw new Error('Incomplete source material pack')
 return verifySurfacePack(manifest,url,'industrial-v1',512)
}

/** Shared validation for original Blender and licensed-source PBR output. */
export async function verifySurfacePack(manifest:SurfaceManifest,url:string,id:string,size:number):Promise<SourceSurfaces> {
 const expectedLayers=id==='industrial-v1'?PALETTE.length:29
 if(manifest.schema!==1||manifest.id!==id||manifest.origin!=='bottom-left'||
  manifest.size!==size||manifest.mipCount!==Math.log2(size)+1||manifest.layers.length!==expectedLayers||
  !Number.isFinite(manifest.tileMeters)||manifest.tileMeters<=0||
  !Number.isFinite(manifest.heightRange)||manifest.heightRange<0)throw new Error('Unsupported source material pack')
 const bytes=await fetchAssetPack(url,manifest)
 const checked=new Set<string>()
 for(let zone=0;zone<manifest.layers.length;zone++){
  const layer=manifest.layers[zone]
  if(layer.zone!==zone||layer.name!==PALETTE[zone]?.name||layer.mips.length!==manifest.mipCount)throw new Error('Invalid source material layer')
  for(let mip=0;mip<manifest.mipCount;mip++){
   const ranges=layer.mips[mip],side=manifest.size>>mip
   if(ranges.length!==4)throw new Error('Invalid source material channels')
   for(let c=0;c<4;c++){
    const r=ranges[c]
    if(!Number.isSafeInteger(r.offset)||r.offset<0||r.bytes!==side*side*BPP[c]||r.offset+r.bytes>bytes.length||
      !/^[a-f0-9]{64}$/.test(r.sha256))throw new Error('Invalid source material range')
    const key=`${r.offset}:${r.bytes}:${r.sha256}`
    if(checked.has(key))continue
    const data=bytes.subarray(r.offset,r.offset+r.bytes)
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data as Uint8Array<ArrayBuffer>)),v=>v.toString(16).padStart(2,'0')).join('')
    if(hash!==r.sha256)throw new Error('Source material channel checksum mismatch')
    checked.add(key)
   }
  }
 }
 return {manifest,bytes}
}

/** Upload once before prewarm; optional zone copies feed existing terrain atlas dimensions. */
export function uploadSourceSurfaces(device:GPUDevice,pack:SourceSurfaces,size:number,
 id=pack.manifest.id,zones:readonly number[]=pack.manifest.layers.map(l=>l.zone),
 mipCount=Math.log2(size)+1,tileMeters=pack.manifest.tileMeters):ForgedSurfaceSet {
 const firstMip=Math.log2(pack.manifest.size/size),textures:GPUTexture[]=[]
 if(!Number.isInteger(firstMip)||firstMip<0||!Number.isInteger(mipCount)||mipCount<1||
  firstMip+mipCount>pack.manifest.mipCount||!Number.isFinite(tileMeters)||tileMeters<=0||
  !zones.length||zones.some(z=>!Number.isInteger(z)||z<0||z>=pack.manifest.layers.length))throw new Error('Invalid source material upload plan')
 // vram claims TEXTURE bytes only. The 32-byte info uniform below is a buffer, which
 // vramgate's texture census cannot enumerate — claiming it is an over-claim per set
 // (see the note in actor-masks.ts).
 let vram=0,info:GPUBuffer|null=null
 try {
  for(const [c,format] of (['rgba8unorm','rg8unorm','rgba8unorm','r8unorm'] as const).entries()){
   const texture=device.createTexture({label:`steelseed/materials/source/${id}/${c}`,size:[size,size,zones.length],format,mipLevelCount:mipCount,
    usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC,viewFormats:c===0?['rgba8unorm-srgb']:[]})
   textures.push(texture)
   for(let mip=0;mip<mipCount;mip++){
    const side=size>>mip
    for(let layer=0;layer<zones.length;layer++){
     const r=pack.manifest.layers[zones[layer]].mips[firstMip+mip][c]
     device.queue.writeTexture({texture,mipLevel:mip,origin:[0,0,layer]},pack.bytes.subarray(r.offset,r.offset+r.bytes) as Uint8Array<ArrayBuffer>,
      {bytesPerRow:side*BPP[c],rowsPerImage:side},[side,side,1])
    }
    vram+=side*side*zones.length*BPP[c]
   }
  }
  info=device.createBuffer({label:`source.${id}.info`,size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
  const data=new ArrayBuffer(32),u=new Uint32Array(data),f=new Float32Array(data)
  u[0]=zones.length;u[1]=mipCount;f[4]=tileMeters;f[5]=pack.manifest.heightRange;f[6]=tileMeters/size
  device.queue.writeBuffer(info,0,data)
  return new ForgedSurfaceSet({id,albedo:textures[0],normal:textures[1],orm:textures[2],mask:textures[3],info,
   size,mipCount,layerCount:zones.length,vramBytes:vram,tileMeters,heightRange:pack.manifest.heightRange})
 }catch(error){for(const texture of textures)texture.destroy();info?.destroy();throw error}
}
