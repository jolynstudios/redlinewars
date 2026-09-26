#!/usr/bin/env node
// Dense runtime-sampler/weighted-sole contact checks, including subframes and wrap.
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {gunzipSync} from 'node:zlib'
import {build} from 'esbuild'

const web=resolve(import.meta.dirname,'..'),out=join(web,'.artifacts/visual-quality/human-motion')
const motion=JSON.parse(readFileSync(join(web,'.forge/human-motion/manifest.json')))
const lod=JSON.parse(readFileSync(join(web,'.forge/human-lods/manifest.json')))
const clipBytes=gunzipSync(readFileSync(join(web,'.forge/human-motion/walk.ssanim.gz')))
const meshBytes=gunzipSync(readFileSync(join(web,'.forge/human-lods/lods.ssmesh.gz')))
const bundled=await build({stdin:{contents:`export {verifyHumanMotionPack,sampleHumanMotion,validateHumanMotionPose} from './src/units/human-motion.ts';
 export {decodeBlenderAsset} from './src/units/blender-mesh.ts'; export {computeWorldTransforms,computeSkinMatrices} from './src/geo/rig.ts';`,resolveDir:web,loader:'ts'},
 bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent',define:{'import.meta.glob':'__emptyGlob'},banner:{js:'const __emptyGlob=()=>({});'}})
const api=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
const url='https://human-contact-gate.invalid/assets/walk.ssanim.gz'
const previousLocation=globalThis.location,previousFetch=globalThis.fetch;let clip
globalThis.location={href:'https://human-contact-gate.invalid/',origin:'https://human-contact-gate.invalid'}
globalThis.fetch=async input=>{
 assert.equal(String(input),url,'Only the local fixture may be fetched')
 return new Response(clipBytes)
}
try{clip=await api.verifyHumanMotionPack(motion,url,lod)}finally{
 globalThis.fetch=previousFetch
 if(previousLocation===undefined)delete globalThis.location;else globalThis.location=previousLocation
}
const phases=Array.from({length:1025},(_,i)=>i/1024)
for(const point of [0,.12,.62,1,-1])for(const offset of [-1e-6,0,1e-6])phases.push(point+offset)
const reports=[]
for(const entry of lod.levels){
 const {mesh,rig}=api.decodeBlenderAsset(meshBytes,entry),sk=rig.skeleton,pose=sk.createPose(),world=sk.createMatrixBuffer(),skin=sk.createMatrixBuffer()
 api.validateHumanMotionPose(clip,pose)
 const feet=['foot_l','foot_r'].map(name=>motion.rig.bones.findIndex(b=>b.name===name))
 const footWeighted=[]
 for(let v=0;v<mesh.vertexCount;v++){
  if([0,1,2,3].some(k=>mesh.skinWeights[v*4+k]>0&&feet.includes(mesh.skinIndices[v*4+k])))footWeighted.push(v)
 }
 const soles=feet.map(bone=>{
  const rigid=[];let bottom=Infinity
  for(let v=0;v<mesh.vertexCount;v++){
   let weight=0;for(let k=0;k<4;k++)if(mesh.skinIndices[v*4+k]===bone)weight+=mesh.skinWeights[v*4+k]
   if(weight>.99999){rigid.push(v);bottom=Math.min(bottom,mesh.positions[v*3+1])}
  }
  const vertices=rigid.filter(v=>mesh.positions[v*3+1]<bottom+.0001)
  assert.ok(vertices.length>=3,'Need actual sole vertices, not only an ankle target')
  assert.ok(bottom>=0&&bottom<.002,'Source sole starts close to ground')
  return {vertices,bottom}
 })
 let maxStanceX=0,maxStanceY=0,minSole=Infinity,measurements=0,worstSole=null
 for(const phase of phases){
  api.sampleHumanMotion(clip,pose,phase*clip.strideM);api.computeWorldTransforms(pose,world);api.computeSkinMatrices(sk,world,skin)
  for(let side=0;side<2;side++){
   const p=((phase+side*.5)%1+1)%1,stance=p<=motion.stanceFraction
   for(const v of soles[side].vertices){
    const x=mesh.positions[v*3],y=mesh.positions[v*3+1],z=mesh.positions[v*3+2]
    let sx=0,sy=0
    for(let k=0;k<4;k++){
     const weight=mesh.skinWeights[v*4+k],b=mesh.skinIndices[v*4+k]*16
     sx+=(skin[b]*x+skin[b+4]*y+skin[b+8]*z+skin[b+12])*weight
     sy+=(skin[b+1]*x+skin[b+5]*y+skin[b+9]*z+skin[b+13])*weight
    }
    if(stance){
     // Add the same actor displacement to both: stance feet must remain at the
     // corresponding fixed world footprint while the body advances through a cycle.
     const actual=sx+phase*clip.strideM
     const expected=x+clip.strideM*motion.stanceFraction*.5-clip.strideM*p+phase*clip.strideM
     maxStanceX=Math.max(maxStanceX,Math.abs(actual-expected));maxStanceY=Math.max(maxStanceY,Math.abs(sy-y-motion.contactClearanceM));measurements++
    }
   }
  }
  // Mixed ankle/foot vertices can sit below the rigid sole subset. Check every
  // positive foot influence for penetration, using its full four-weight skinning.
  for(const v of footWeighted){
   const x=mesh.positions[v*3],y=mesh.positions[v*3+1],z=mesh.positions[v*3+2];let sy=0
   for(let k=0;k<4;k++){
    const weight=mesh.skinWeights[v*4+k],b=mesh.skinIndices[v*4+k]*16
    sy+=(skin[b+1]*x+skin[b+5]*y+skin[b+9]*z+skin[b+13])*weight
   }
   if(sy<minSole){minSole=sy;worstSole={phase,v}}
  }
 }
 assert.ok(maxStanceX<.00015,`LOD${entry.level} stance slides ${maxStanceX}m`)
 assert.ok(maxStanceY<.00015,`LOD${entry.level} stance height drifts ${maxStanceY}m`)
 assert.ok(minSole>=-1e-6,`LOD${entry.level} sole penetrates ground: ${minSole}m at ${JSON.stringify(worstSole)}; stance drift ${maxStanceX}/${maxStanceY}`)
 reports.push({level:entry.level,phases:phases.length,soleVertices:soles.map(s=>s.vertices.length),footWeightedVertices:footWeighted.length,measurements,maxStanceX,maxStanceY,minSole})
}
mkdirSync(out,{recursive:true})
const report={reports,authoredClearanceM:motion.contactClearanceM,note:'Actual sampler: rigid sole stance drift and all positive foot-weighted vertices for penetration, at source scale on flat ground. Instance scale multiplies errors; not uneven-terrain contact or live actor/distance integration.'}
writeFileSync(join(out,'contact-report.json'),JSON.stringify(report,null,2));console.log('humancontactgate PASS',JSON.stringify(report))
