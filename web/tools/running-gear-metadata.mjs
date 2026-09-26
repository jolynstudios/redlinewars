#!/usr/bin/env node
// Derive contact geometry from inspected authored sources. Loads below are visual art direction.
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { build } from 'esbuild'
const root=fileURLToPath(new URL('../..',import.meta.url)),read=p=>JSON.parse(readFileSync(`${root}/${p}`,'utf8'))
const roster=read('web/src/core/ra-visual-manifest.json').actors,pack=read('web/.forge/blender/manifest.json').assets
// Relative visual contact load, dimensionless; neither tonnes nor inferred from hit points.
const load={ '1tnk':.45,'2tnk':.72,'3tnk':.82,'4tnk':1,apc:.60,arty:.65,ctnk:.72,dtrk:.85,ftrk:.65,harv:1,jeep:.25,mcv:.95,mgg:.75,mnly:.50,'mnly.ap':.50,'mnly.at':.50,mrj:.50,qtnk:1,stnk:.58,truk:.55,ttnk:.80,v2rl:.75 }
const temp=mkdtempSync(join(tmpdir(),'running-geometry-'))
await build({entryPoints:[`${root}/web/src/units/blender-mesh.ts`],bundle:true,format:'esm',platform:'node',outfile:join(temp,'mesh.mjs'),logLevel:'silent'})
const {decodeBlenderAsset}=await import(join(temp,'mesh.mjs'))
rmSync(temp,{recursive:true,force:true})
const bytes=new Uint8Array(gunzipSync(readFileSync(`${root}/web/.forge/blender/roster.ssasset.gz`)))
const actors={}
for(const [id,row]of Object.entries(roster)){
 if(!row.renderable||!['tracked','wheeled'].includes(row.visualFamily))continue
 const promoted=`.artifacts/planx/audit-promoted/${id}/structure.json`
 const audit=read(existsSync(`${root}/${promoted}`)?promoted:`.artifacts/planx/audit/${id}/structure.json`),asset=pack[id],tracked=row.visualFamily==='tracked'
 if(audit.sourceSha256!==asset.sourceSha256)throw new Error(`${id}: audit and baked source hashes differ`)
 const contacts=audit.meshes.filter(m=>!m.hiddenRender&&(tracked?m.name.startsWith('track belt')||m.name.startsWith('continuous track belt')||m.name.startsWith('continuous track band')||m.name.startsWith('PLANX continuous carrier belt'):m.name.startsWith('road wheel tire')||/^road wheel(\.\d+)?$/.test(m.name)))
 if(contacts.length<2)throw new Error(`${id}: no bilateral authored contacts`)
 const centers=contacts.map(m=>-(m.bounds[0][1]+m.bounds[1][1])*.5),widths=contacts.map(m=>m.bounds[1][1]-m.bounds[0][1])
 const left=centers.filter(z=>z<0),right=centers.filter(z=>z>0),avg=xs=>xs.reduce((a,b)=>a+b,0)/xs.length
 if(!left.length||!right.length)throw new Error(`${id}: contact sides missing`)
 const minX=Math.min(...contacts.map(m=>m.bounds[0][0])),maxX=Math.max(...contacts.map(m=>m.bounds[1][0]))
 let uvRepeatM=0
 if(tracked){
  const {mesh}=decodeBlenderAsset(bytes,asset),slopes=[]
  for(let t=0;t<mesh.triangleCount;t++){
   const a=mesh.indices[t*3],b=mesh.indices[t*3+1]
   if(mesh.materialZone[a]!==1||Math.abs(mesh.normals[a*3])>.2||mesh.skinIndices?.[a*4]!==0)continue
   const dx=mesh.positions[b*3]-mesh.positions[a*3],du=mesh.uv0[b*2]-mesh.uv0[a*2]
   if(Math.abs(dx)>.001&&Math.abs(du)>.001)slopes.push(Math.abs(dx/du))
  }
  slopes.sort((a,b)=>a-b);uvRepeatM=slopes[Math.floor(slopes.length/2)]
  if(!(uvRepeatM>0))throw new Error(`${id}: cannot measure running-gear UV repeat`)
  if(asset.trackLoop){const repeat=asset.trackLoop.length/asset.trackLoop.linkCount;if(Math.abs(uvRepeatM-repeat)>.001)throw new Error(`${id}: declared and measured track repeats disagree`);uvRepeatM=repeat}
 }
 actors[id]={kind:row.visualFamily,source:audit.source,sourceSha256:audit.sourceSha256,contactObjects:contacts.map(m=>m.name),leftZ:avg(left),rightZ:avg(right),width:avg(widths),pitch:Math.max(.12,Math.min(.28,(maxX-minX)*.18)),contactMinX:minX,contactMaxX:maxX,contactLength:maxX-minX,uvRepeatM,visualLoad:load[id],loadBasis:'authored relative visual contact load; not simulation mass'}
 if(!Number.isFinite(load[id]))throw new Error(`${id}: visual load needs an explicit authored value`)
}
writeFileSync(`${root}/web/src/units/running-gear.json`,JSON.stringify({schema:1,coordinates:'Source render metres; Blender Y maps to negative render Z. Runtime applies Units fitScale once.',actors},null,2)+'\n')
console.log(`running-gear-metadata: ${Object.keys(actors).length} authored contact profiles`)
