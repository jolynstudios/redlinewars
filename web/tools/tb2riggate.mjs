#!/usr/bin/env node
// Strict shipped decoder and actual skin transforms against the isolated source.
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {build} from 'esbuild'
const web=resolve(import.meta.dirname,'..'),root=resolve(web,'..'),proof=resolve(root,'.artifacts/planx/tb2/material-v2')
const hash=x=>createHash('sha256').update(x).digest('hex')
const bundle=await build({stdin:{contents:`export {decodeBlenderAsset} from './src/units/blender-mesh.ts';export {setBoneAngle,computeWorldTransforms,computeSkinMatrices} from './src/geo/rig.ts'`,resolveDir:web},bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'})
const api=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64')),rows=[]
let rig0,mask0
for(let level=0;level<3;level++){
 const dir=resolve(proof,'lod'+level),meta=JSON.parse(readFileSync(resolve(dir,'ss_tb2.json'))),raw=new Uint8Array(readFileSync(resolve(dir,'ss_tb2.ssmesh')))
 assert.equal(hash(readFileSync(resolve(dir,'ss_tb2.blend'))),meta.sourceSha256)
 const {mesh,rig}=api.decodeBlenderAsset(raw,{...meta,offset:0,bytes:raw.length})
 assert.ok(rig);assert.equal(rig.skeleton.boneCount,2);assert.equal(rig.skeleton.axis[1],0)
 if(!rig0){rig0=meta.rig;mask0=meta.detailMask.sha256}assert.deepEqual(meta.rig,rig0);assert.equal(meta.detailMask.sha256,mask0)
 assert.deepEqual([...rig.rotorBones],[1]);assert.deepEqual([...rig.rotorSpeeds],[38]);assert.ok(rig.capturedVertices.every(n=>n>0))
 const pose=rig.skeleton.createPose(),world=rig.skeleton.createMatrixBuffer(),skin=rig.skeleton.createMatrixBuffer(),pivot=meta.rig.bones[1].pos
 let tip=-1,best=0
 for(let v=0;v<mesh.vertexCount;v++)if(mesh.skinIndices[v*4]===1){const r=Math.hypot(mesh.positions[v*3+1]-pivot[1],mesh.positions[v*3+2]-pivot[2]);if(r>best){best=r;tip=v}}
 assert.ok(tip>=0);const p=[...mesh.positions.subarray(tip*3,tip*3+3)],samples=[]
 for(let i=0;i<=64;i++){
  pose.resetToBind();api.setBoneAngle(pose,1,i*Math.PI*2/64);api.computeWorldTransforms(pose,world);api.computeSkinMatrices(rig.skeleton,world,skin)
  const at=16,q=[0,1,2].map(k=>skin[at+k]*p[0]+skin[at+4+k]*p[1]+skin[at+8+k]*p[2]+skin[at+12+k])
  assert.ok(Math.abs(q[0]-p[0])<1e-6,'Pusher moved along its shaft')
  assert.ok(Math.abs(Math.hypot(q[1]-pivot[1],q[2]-pivot[2])-best)<1e-6,'Pusher radius changed')
  for(let k=0;k<16;k++)assert.ok(Math.abs(skin[k]-(k%5===0?1:0))<1e-6,'Propeller moved static body')
  samples.push(q)
 }
 assert.ok(Math.hypot(...samples[16].map((x,k)=>x-samples[0][k]))>.1,'Quarter turn did not move real blade')
 assert.ok(Math.hypot(...samples[64].map((x,k)=>x-samples[0][k]))<1e-6,'One revolution did not close')
 assert.equal(mesh.validate(),null)
 rows.push({level,triangles:meta.triangles,sourceSha256:meta.sourceSha256,rotorVertices:rig.capturedVertices[1],radius:best,samples:65,quarterTurnDisplacement:Math.hypot(...samples[16].map((x,k)=>x-samples[0][k])),byteHash:hash(raw)})
}
writeFileSync(resolve(proof,'rig-gate.json'),JSON.stringify({status:'PASS',rows,scope:'Exact production decoder and CPU skin transforms; GPU articulation captured separately. No gameplay flight/rearm binding.'},null,2)+'\n')
console.log('TB2_RIG_PASS',JSON.stringify(rows))
