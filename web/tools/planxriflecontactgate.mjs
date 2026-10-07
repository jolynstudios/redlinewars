#!/usr/bin/env node
// CPU measurement of the exact saved prototype and hashed existing distance-walk data.
import assert from'node:assert/strict'
import{readFileSync,writeFileSync}from'node:fs'
import{join,resolve}from'node:path'
import{createHash}from'node:crypto'
import{gunzipSync}from'node:zlib'
import{build}from'esbuild'
const web=resolve(import.meta.dirname,'..'),root=resolve(web,'..'),out=join(root,'.artifacts/planx/rifle-prototype'),hash=b=>createHash('sha256').update(b).digest('hex')
const compiled=await build({stdin:{contents:`export{decodeBlenderAsset}from'./src/units/blender-mesh.ts';export{sampleHumanMotion,validateHumanMotionPose}from'./src/units/human-motion.ts';export{computeWorldTransforms,computeSkinMatrices}from'./src/geo/rig.ts';`,resolveDir:web,loader:'ts'},bundle:true,format:'esm',platform:'node',write:false,define:{'import.meta.glob':'__emptyGlob'},banner:{js:'const __emptyGlob=()=>({});'}})
const api=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'))
const manifest=JSON.parse(readFileSync(join(out,'manifest.json'))),raw=gunzipSync(readFileSync(join(out,manifest.file))),motion=JSON.parse(readFileSync(join(web,'.forge/human-motion/manifest.json'))),motionRaw=gunzipSync(readFileSync(join(web,'.forge/human-motion',motion.file)))
assert.equal(hash(raw),manifest.sha256);assert.equal(hash(motionRaw),motion.sha256)
const clip={manifest:motion,data:new Float32Array(motionRaw.buffer,motionRaw.byteOffset,motionRaw.byteLength/4),frames:motion.frames,samples:motion.samples,boneCount:motion.boneCount,strideM:motion.strideM},levels=[]
for(const entry of manifest.levels){
 assert.deepEqual(entry.rig,motion.rig);const{mesh,rig}=api.decodeBlenderAsset(raw,entry,entry.level>0),sk=rig.skeleton,pose=sk.createPose(),world=sk.createMatrixBuffer(),skin=sk.createMatrixBuffer();api.validateHumanMotionPose(clip,pose);const lows=[]
 for(let f=0;f<=64;f++){
  api.sampleHumanMotion(clip,pose,clip.strideM*f/64);api.computeWorldTransforms(pose,world);api.computeSkinMatrices(sk,world,skin);let low=Infinity
  for(let v=0;v<mesh.vertexCount;v++){
   const x=mesh.positions[v*3],y=mesh.positions[v*3+1],z=mesh.positions[v*3+2];if(y>.06)continue
   let value=0;for(let k=0;k<4;k++){const at=v*4+k,b=mesh.skinIndices[at]*16,w=mesh.skinWeights[at];value+=w*(skin[b+1]*x+skin[b+5]*y+skin[b+9]*z+skin[b+13])}low=Math.min(low,value)
  }
  lows.push(low)
 }
 levels.push({level:entry.level,lowestFootBySample:lows,min:Math.min(...lows),max:Math.max(...lows)})
}
const report={schema:1,sourceSha256:manifest.parentSourceSha256,motionSha256:motion.sha256,samples:65,levels,pass:levels.every(l=>l.min>=-.003&&l.max<.006),scope:'Exact CPU skinning of saved low-foot vertices across one walk cycle, model-space ground at zero; not a terrain slope gait solver.'};writeFileSync(join(out,'contact-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report.levels.map(({level,min,max})=>({level,min,max}))),report.pass?'PASS':'FAIL');assert.equal(report.pass,true)
