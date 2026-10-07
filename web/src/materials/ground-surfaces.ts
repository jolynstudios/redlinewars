// Saved Blender graph bakes from pinned CC0 inputs. No remote source requests in play.
import { fetchAssetPack } from '../core/asset-pack'
import type { BakedEnvironment } from './environment'

type GroundManifest = BakedEnvironment['manifest'] & {
 readonly origin: string
 readonly mipCount: number
}
const manifests=import.meta.glob<GroundManifest>('../../.forge/ground/manifest.json',{eager:true,import:'default'})
const packs=import.meta.glob<string>('../../.forge/ground/ground.sspbr.gz',{eager:true,query:'?url',import:'default'})

export async function loadGroundSurfaces():Promise<BakedEnvironment|null>{
 if(new URLSearchParams(location.search).get('nogroundsources')==='1')return null
 const manifest=Object.values(manifests)[0],url=Object.values(packs)[0]
 if(!manifest&&!url)return null
 if(!manifest||!url||manifest.schema!==1||manifest.size!==512||manifest.mipCount!==10||
  manifest.origin!=='bottom-left')throw new Error('Unsupported ground source pack')
 const ids=manifest.surfaces.map(s=>s.id)
 if(ids.length!==3||new Set(ids).size!==3||['grass','soil','forest'].some(id=>!ids.includes(id)))throw new Error('Incomplete ground source pack')
 const bytes=await fetchAssetPack(url,manifest)
 for(const surface of manifest.surfaces){
  if(!Number.isFinite(surface.tileMeters)||surface.tileMeters<=0||!Number.isFinite(surface.heightRange)||
   surface.heightRange<=0||surface.mips.length!==10)throw new Error('Invalid ground source scale')
  for(let mip=0;mip<10;mip++){
   const side=512>>mip,ranges=surface.mips[mip]
   if(ranges.length!==4)throw new Error('Invalid ground source channels')
   for(let c=0;c<4;c++){
    const r=ranges[c]
    if(!Number.isSafeInteger(r.offset)||r.offset<0||r.bytes!==side*side*[4,2,4,1][c]||r.offset+r.bytes>bytes.length)
     throw new Error('Invalid ground source range')
   }
  }
 }
 // Forest graph is ready for the biome/variant pass; don't allocate an unused GPU set.
 return {manifest:{...manifest,surfaces:manifest.surfaces.filter(s=>s.id!=='forest')},bytes}
}
