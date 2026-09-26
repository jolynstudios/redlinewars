#!/usr/bin/env node
// Additive aircraft-paint layer: exact old bytes, real loader and upload budget.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {gunzipSync} from 'node:zlib'
import {build} from 'esbuild'
const web=resolve(import.meta.dirname,'..'),root=resolve(web,'..'),baseline=resolve(root,'.artifacts/planx/tb2/material-baseline')
const json=p=>JSON.parse(readFileSync(p)),palette=json(resolve(web,'src/core/blender-palette.json'))
assert.deepEqual(palette.slice(0,29),json(resolve(baseline,'blender-palette.json')))
assert.equal(palette.length,30);assert.equal(palette[29].name,'blue aircraft paint');assert.equal(palette[29].roughness,.43)
const old=json(resolve(baseline,'manifest.json')),current=json(resolve(web,'.forge/surfaces/manifest.json'))
const oldRaw=gunzipSync(readFileSync(resolve(baseline,'surfaces.sspbr.gz'))),currentRaw=gunzipSync(readFileSync(resolve(web,'.forge/surfaces/surfaces.sspbr.gz')))
for(let z=0;z<29;z++){
 assert.deepEqual(current.layers[z],old.layers[z])
 for(const mip of old.layers[z].mips)for(const r of mip)assert.deepEqual(currentRaw.subarray(r.offset,r.offset+r.bytes),oldRaw.subarray(r.offset,r.offset+r.bytes))
}
const bundle=await build({stdin:{contents:`export {verifySurfacePack,uploadSourceSurfaces} from './src/materials/source-surfaces.ts'`,resolveDir:web},bundle:true,write:false,platform:'node',format:'esm',define:{'import.meta.glob':'__paintGlob'},banner:{js:'const __paintGlob=()=>({});'},logLevel:'silent'})
const api=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64')),savedFetch=globalThis.fetch
let requests=0,stored;globalThis.fetch=async()=>{requests++;return new Response(stored)}
try{
 for(const [dir,id,size,file] of [['surfaces','industrial-v1',512,'surfaces.sspbr.gz'],['foliage','foliage-v1',256,'foliage.sspbr.gz'],['meadow','meadow-v1',256,'foliage.sspbr.gz']]){
  const m=json(resolve(web,'.forge',dir,'manifest.json'));stored=readFileSync(resolve(web,'.forge',dir,file))
  const p=await api.verifySurfacePack(m,'/gate',id,size);assert.equal(p.manifest.layers.length,id==='industrial-v1'?30:29)
  const wrong=structuredClone(m);wrong.layers[0].name='wrong material';await assert.rejects(()=>api.verifySurfacePack(wrong,'/gate',id,size),/Invalid source material layer/)
  const missing=structuredClone(m);missing.layers.pop();await assert.rejects(()=>api.verifySurfacePack(missing,'/gate',id,size),/Unsupported source material pack/)
 }
 stored=readFileSync(resolve(web,'.forge/surfaces/surfaces.sspbr.gz'))
 const p=await api.verifySurfacePack(current,'/gate','industrial-v1',512)
 globalThis.GPUTextureUsage={TEXTURE_BINDING:1,COPY_DST:2,COPY_SRC:4};globalThis.GPUBufferUsage={UNIFORM:1,COPY_DST:2}
 let allocated=0,destroyed=0,writes=0
 const device={createTexture(){allocated++;return{createView(){return{}},destroy(){destroyed++}}},createBuffer(){return{destroy(){}}},queue:{writeTexture(){writes++},writeBuffer(){}}}
 for(const size of [128,512]){
  const s=api.uploadSourceSurfaces(device,p,size,'paint-gate',[29]);assert.equal(s.layerCount,1)
  // The 32 B info uniform BUFFER is a buffer, not VRAM texture bytes (assetgate
  // accounting rule): the claim must be texture bytes only.
  assert.equal(s.vramBytes,Array.from({length:Math.log2(size)+1},(_,m)=>(size>>m)**2*11).reduce((a,b)=>a+b));s.dispose()
 }
 assert.throws(()=>api.uploadSourceSurfaces(device,p,128,'invalid',[30]),/Invalid source material upload plan/)
 assert.equal(allocated,destroyed);assert.equal(writes,72)
 console.log(JSON.stringify({status:'PASS',preservedLayers:29,preservedRanges:1160,verifiedNamedSets:3,wrongNameAndMissingLayerRejected:true,uploadBoundary30Rejected:true,lowAdditionalTextureBytes:240295,highAdditionalTextureBytes:3844775,textureDisposals:destroyed,requests}))
}finally{globalThis.fetch=savedFetch}
