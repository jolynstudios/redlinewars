#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { build } from 'esbuild'

const web=fileURLToPath(new URL('..',import.meta.url)),temp=mkdtempSync(join(tmpdir(),'steelseed-wildlife-'))
try {
 const outfile=join(temp,'rig.mjs')
 await build({stdin:{contents:`export {decodeBlenderAsset} from './src/units/blender-mesh.ts';
 export {scenicPose} from './src/units/scenic-pose.ts';
 export {computeWorldTransforms,computeSkinMatrices} from './src/geo/rig.ts';`,resolveDir:web,loader:'ts'},bundle:true,platform:'node',format:'esm',outfile,logLevel:'silent'})
 const api=await import(pathToFileURL(outfile)),manifest=JSON.parse(readFileSync(join(web,'.forge/living/manifest.json')))
 const pack=new Uint8Array(gunzipSync(readFileSync(join(web,'.forge/living/living.ssasset.gz'))))
 assert.equal(createHash('sha256').update(pack).digest('hex'),manifest.sha256)
 let idleJoints=0
 for(const name of ['cow','sheep','deer','rabbit','fish']){
  const entry=manifest.assets[name],{mesh,rig}=api.decodeBlenderAsset(pack,entry)
  assert.ok(rig);assert.equal(rig.oscillatorBones.length,name==='fish'?1:2)
  assert.equal(rig.legBones.length,name==='fish'?0:4)
  const source=readFileSync(join(web,'..',entry.sourcePath))
  assert.equal(createHash('sha256').update(source).digest('hex'),entry.sourceSha256,`${name}: saved source exported`)
  const pose=rig.skeleton.createPose(),world=rig.skeleton.createMatrixBuffer(),skin=rig.skeleton.createMatrixBuffer()
  function frame(time,travel=0){api.scenicPose(rig,pose,time,travel,.3,.7);api.computeWorldTransforms(pose,world);api.computeSkinMatrices(rig.skeleton,world,skin);return skin.slice()}
  const a=frame(1),paused=frame(1),b=frame(1.6)
  assert.deepEqual(paused,a,`${name}: same simulation time holds pose`)
  for(const bone of rig.legBones)assert.deepEqual(a.slice(bone*16,bone*16+16),b.slice(bone*16,bone*16+16),`${name}: resting feet do not walk`)
  for(const bone of rig.oscillatorBones){
   let moved=false
   for(let v=0;v<mesh.vertexCount;v++)if(mesh.skinIndices[v*4]===bone){
    const p=v*3,o=bone*16,x=mesh.positions[p],y=mesh.positions[p+1],z=mesh.positions[p+2]
    const dx=(a[o]-b[o])*x+(a[o+4]-b[o+4])*y+(a[o+8]-b[o+8])*z+a[o+12]-b[o+12]
    const dy=(a[o+1]-b[o+1])*x+(a[o+5]-b[o+5])*y+(a[o+9]-b[o+9])*z+a[o+13]-b[o+13]
    const dz=(a[o+2]-b[o+2])*x+(a[o+6]-b[o+6])*y+(a[o+10]-b[o+10])*z+a[o+14]-b[o+14]
    if(Math.hypot(dx,dy,dz)>.0001){moved=true;break}
   }
   assert.ok(moved,`${name}: idle joint ${bone} moves actual exported geometry`);idleJoints++
  }
  if(name!=='fish')assert.notDeepEqual(frame(1,.03),a,`${name}: travel drives gait`)
 }
 console.log(`wildlifegate: PASS — five saved/exported animals, ${idleJoints} moving idle joints; paused pose stable, resting feet fixed, travel drives gait`)
} finally {rmSync(temp,{recursive:true,force:true})}
