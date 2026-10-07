// Original saved Blender bough geometry rendered at build time; no third-party leaf art.
import { verifySurfacePack, uploadSourceSurfaces, type SurfaceManifest } from './source-surfaces'
interface FoliageManifest extends SurfaceManifest { readonly sourceSha256:string }
const manifests=import.meta.glob<FoliageManifest>('../../.forge/foliage/manifest.json',{eager:true,import:'default'})
const packs=import.meta.glob<string>('../../.forge/foliage/foliage.sspbr.gz',{eager:true,query:'?url',import:'default'})
export async function loadFoliageSurfaces(device:GPUDevice,low:boolean) {
 const manifest=Object.values(manifests)[0],url=Object.values(packs)[0]
 if(!manifest&&!url)return null
 if(!manifest||!url)throw new Error('Incomplete original foliage pack')
 if(typeof manifest.sourceSha256!=='string'||!/^[a-f0-9]{64}$/.test(manifest.sourceSha256))throw new Error('Original foliage source binding is missing')
 const verified=await verifySurfacePack(manifest,url,'foliage-v1',256)
 // Preserve the surface class/prototype while exposing the verified atlas binding.
 return Object.assign(uploadSourceSurfaces(device,verified,low?128:256),{sourceSha256:manifest.sourceSha256})
}
const meadowManifests=import.meta.glob<SurfaceManifest>('../../.forge/meadow/manifest.json',{eager:true,import:'default'})
const meadowPacks=import.meta.glob<string>('../../.forge/meadow/foliage.sspbr.gz',{eager:true,query:'?url',import:'default'})
export async function loadMeadowSurfaces(device:GPUDevice,low:boolean) {
 const manifest=Object.values(meadowManifests)[0],url=Object.values(meadowPacks)[0]
 if(!manifest&&!url)return null
 if(!manifest||!url)throw new Error('Incomplete original meadow pack')
 return uploadSourceSurfaces(device,await verifySurfacePack(manifest,url,'meadow-v1',256),low?128:256)
}
