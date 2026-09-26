// Original Blender-baked UV1 shading masks; alpha is WEAR, never geometry transparency.
import { fetchAssetPack } from '../core/asset-pack'
import { ForgedSurfaceSet } from './forge'

interface Mask {
 readonly file:string;readonly compression:'gzip';readonly bytes:number;readonly storedBytes:number;readonly sha256:string
 readonly size:number;readonly uv:number;readonly channels:string;readonly origin:string
}
interface Actor {readonly materialSet?:string;readonly detailMask?:Mask}
const manifests=import.meta.glob<{readonly assets:Readonly<Record<string,Actor>>}>('../../.forge/blender/manifest.json',{eager:true,import:'default'})
const files=import.meta.glob<string>('../../.forge/blender/masks/*.gz',{eager:true,query:'?url',import:'default'})

export class MaskedSurfaceSet extends ForgedSurfaceSet {
 readonly detailMaskView:GPUTextureView
 constructor(base:ForgedSurfaceSet,id:string,private readonly detail:GPUTexture,info:GPUBuffer,bytes:number){
  super({id,albedo:base.albedo,normal:base.normal,orm:base.orm,mask:base.mask,info,layerCount:base.layerCount,
   // TEXTURE bytes only. This was `bytes+32`, adding the info uniform buffer, and
   // `vramBytes` is summed into `Materials.totalVramBytes`, which `vramgate` asserts against
   // the textures it can actually enumerate. A buffer is real VRAM but it is not a texture, so
   // every masked set over-claimed by 32 B against a measurement that could never see it.
   // With two masked actors that was 64 B and sat inside the gate's 1 KiB tolerance; the
   // roster-wide surface promotion took it to 231 sets and the gate went red on an accounting
   // gap rather than on a real overrun. The ceiling itself is `textureVram`, so texture bytes
   // are the honest thing to claim here.
   size:base.size,mipCount:base.mipCount,tileMeters:base.tileMeters,heightRange:base.heightRange,vramBytes:bytes})
  this.detailMaskView=detail.createView()
 }
 // Shared PBR arrays belong to the parent set. Only this alias's resources are destroyed.
 override dispose():void {this.detail.destroy();this.info.destroy()}
}

export function maskMip(input:Uint8Array,size:number):Uint8Array {
 const side=size>>1,out=new Uint8Array(side*side*4)
 for(let y=0;y<side;y++)for(let x=0;x<side;x++)for(let c=0;c<4;c++){
  const i=(y*2*size+x*2)*4+c
  out[(y*side+x)*4+c]=Math.round((input[i]+input[i+4]+input[i+size*4]+input[i+size*4+4])/4)
 }
 return out
}

export async function buildActorMasks(device:GPUDevice,base:ForgedSurfaceSet,maximumSize:number):Promise<ForgedSurfaceSet[]> {
 if(new URLSearchParams(location.search).get('noactormasks')==='1')return []
 const manifest=Object.values(manifests)[0],sets:ForgedSurfaceSet[]=[]
 if(!manifest)return sets
 try {
  for(const [actor,entry] of Object.entries(manifest.assets)){
   const m=entry.detailMask;if(entry.materialSet!==base.id||!m)continue
   if(m.file!==`masks/${actor}.mask.rgba.gz`||![128,256,512].includes(m.size)||m.bytes!==m.size*m.size*4||
    m.uv!==1||m.origin!=='bottom-left'||m.channels!=='ao,cavity,dirt,wear')throw new Error(`Invalid authored mask ${actor}`)
   const url=files[`../../.forge/blender/${m.file}`]
   if(!url)throw new Error(`Missing authored mask ${actor}`)
   let pixels=await fetchAssetPack(url,m),size=m.size
   while(size>maximumSize){pixels=maskMip(pixels,size);size>>=1}
   const mipCount=Math.log2(size)+1
   const texture=device.createTexture({label:`steelseed/materials/actor-mask/${actor}`,size:[size,size],format:'rgba8unorm',mipLevelCount:mipCount,
    usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST})
   let info:GPUBuffer|null=null
   try {
    let bytes=0,side=size
    for(let mip=0;mip<mipCount;mip++){
     device.queue.writeTexture({texture,mipLevel:mip},pixels as Uint8Array<ArrayBuffer>,{bytesPerRow:side*4,rowsPerImage:side},[side,side])
     bytes+=pixels.byteLength
     if(side>1){pixels=maskMip(pixels,side);side>>=1}
    }
    info=device.createBuffer({label:`actor-mask.${actor}.info`,size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
    const data=new ArrayBuffer(32),u=new Uint32Array(data),f=new Float32Array(data)
    u[0]=base.layerCount;u[1]=base.mipCount;f[4]=base.tileMeters;f[5]=base.heightRange;f[6]=base.tileMeters/base.size
    device.queue.writeBuffer(info,0,data)
    sets.push(new MaskedSurfaceSet(base,`${base.id}:${actor}`,texture,info,bytes))
   }catch(error){texture.destroy();info?.destroy();throw error}
  }
  return sets
 }catch(error){for(const set of sets)set.dispose();throw error}
}
