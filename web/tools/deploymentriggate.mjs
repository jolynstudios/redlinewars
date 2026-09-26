#!/usr/bin/env node
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {build} from 'esbuild'
import {WEB_ROOT} from './harness.mjs'
const code=await build({stdin:{contents:"export * from './src/units/deployment-rig';export {placeActor} from './src/core/place';export {SnapshotDecoder,SNAPSHOT_MAGIC,SNAPSHOT_VERSION} from './src/core/snapshot'",resolveDir:WEB_ROOT},bundle:true,write:false,format:'cjs',platform:'node',logLevel:'silent'})
const m={exports:{}};new Function('module','exports',code.outputFiles[0].text)(m,m.exports)
const {DeploymentRig,DeploymentStates,settleDeploymentBasis,placeActor,SnapshotDecoder,SNAPSHOT_MAGIC,SNAPSHOT_VERSION}=m.exports
const contract=JSON.parse(readFileSync(WEB_ROOT+'/.forge/blender/manifest.json','utf8')).assets.fact.deployment,n=contract.boneCount
const skeleton={boneCount:n,names:Array(n).fill('donor'),parent:new Int16Array(n).fill(-1),bindT:new Float32Array(n*3),bindR:new Float32Array(n*4)}
for(let i=0;i<n;i++)skeleton.bindR[i*4+3]=1
for(const c of contract.channels){skeleton.names[c.index]=c.boneName;skeleton.parent[c.index]=c.parent;skeleton.bindT.set(c.bindTranslationM,c.index*3);skeleton.bindR.set(c.bindRotationQuat,c.index*4)}
const rig=new DeploymentRig(skeleton,contract),pose={skeleton,t:skeleton.bindT.slice(),r:skeleton.bindR.slice(),s:new Float32Array(n*3).fill(1)}
for(const progress of [0,.025,.05,.1,.25,.5,.75,.9,1]){
 rig.sample(pose,progress);assert.ok(pose.t.every(Number.isFinite));assert.ok(pose.s.every(v=>v===1),'no scale morph')
 for(const c of contract.channels){assert.ok(Math.abs(Math.hypot(...pose.r.slice(c.index*4,c.index*4+4))-1)<1e-6);if(progress===0||progress===1)for(let a=0;a<3;a++)assert.ok(Math.abs(pose.t[c.index*3+a]-(progress===0?c.foldedTranslationM:c.bindTranslationM)[a])<1e-6)}
 const paused=Array.from(pose.t);rig.sample(pose,progress);assert.deepEqual(Array.from(pose.t),paused)
}
assert.throws(()=>new DeploymentRig(skeleton,{...contract,scaleChannels:true}))
assert.throws(()=>rig.sample(pose,NaN))
for(const prefixEnd of [0,-1,1.1,NaN,Infinity])assert.throws(()=>new DeploymentRig(skeleton,{...contract,prefixEnd}))
assert.equal(new DeploymentRig(skeleton,{...contract,prefixEnd:31/95}).prefixEnd,31/95)
// A physical roof must rise on its authored long arc. Shortest-arc slerp has
// identical end orientations but sends the panel through the opposite half-space.
const hingeEnd=-.3607,hingeBind=[Math.sin(hingeEnd/2),0,0,Math.cos(hingeEnd/2)]
const roofSkeleton={boneCount:1,names:['roof'],parent:Int16Array.of(-1),bindT:Float32Array.of(0,2,0),bindR:Float32Array.from(hingeBind)}
const roofChannel={index:0,boneName:'roof',parent:-1,bindTranslationM:[0,2,0],foldedTranslationM:[0,0,0],bindRotationQuat:hingeBind,foldedRotationQuat:[1,0,0,0],phaseStart:.5,phaseEnd:.9,translationPhaseStart:0,translationPhaseEnd:.25,signedHinge:{axisLocal:[1,0,0],foldedAngleRad:Math.PI,bindAngleRad:hingeEnd}}
const roofContract={boneCount:1,scaleChannels:false,deployedIsBindPose:true,channels:[roofChannel]}
const roofRig=new DeploymentRig(roofSkeleton,roofContract),roofPose={skeleton:roofSkeleton,t:new Float32Array(3),r:new Float32Array(4),s:new Float32Array(3).fill(1)}
roofRig.sample(roofPose,.25);assert.equal(roofPose.t[1],2,'lift completes before roof rotation');assert.ok(Math.abs(roofPose.r[0]-1)<1e-6,'roof stays folded during lift')
roofRig.sample(roofPose,.7);assert.ok(2*roofPose.r[0]*roofPose.r[3]>.9,'signed hinge takes the clear positive half-space')
const shortest=new DeploymentRig(roofSkeleton,{...roofContract,channels:[{...roofChannel,signedHinge:undefined}]})
shortest.sample(roofPose,.7);assert.ok(2*roofPose.r[0]*roofPose.r[3]<-.9,'negative control: ordinary shortest arc crosses machinery')
for(const progress of [0,1]){
 roofRig.sample(roofPose,progress);const expected=progress?hingeBind:roofChannel.foldedRotationQuat
 assert.ok(Math.abs(Math.abs(roofPose.r.reduce((sum,v,i)=>sum+v*expected[i],0))-1)<1e-6,'source endpoint orientation retained')
 assert.equal(roofPose.t[1],progress?2:0);assert.ok(roofPose.s.every(v=>v===1))
}
const signedPause=Array.from(roofPose.r);roofRig.sample(roofPose,1);assert.deepEqual(Array.from(roofPose.r),signedPause)
for(const patch of [{translationPhaseEnd:undefined},{translationPhaseStart:NaN},{translationPhaseStart:.8,translationPhaseEnd:.5},{translationPhaseEnd:1.1},
 {signedHinge:{...roofChannel.signedHinge,axisLocal:[2,0,0]}},{signedHinge:{...roofChannel.signedHinge,axisLocal:[1,0]}},
 {signedHinge:{...roofChannel.signedHinge,foldedAngleRad:Infinity}},{signedHinge:{...roofChannel.signedHinge,bindAngleRad:0}}])
 assert.throws(()=>new DeploymentRig(roofSkeleton,{...roofContract,channels:[{...roofChannel,...patch}]}))
new DeploymentRig(roofSkeleton,{...roofContract,channels:[{...roofChannel,foldedRotationQuat:[-1,0,0,0]}]})
function snapshot(tick,frame,frames=32,id=132,source=131){
 const raw=new ArrayBuffer(80),v=new DataView(raw);v.setUint32(0,SNAPSHOT_MAGIC,true);v.setUint16(4,SNAPSHOT_VERSION,true);v.setUint16(6,1,true);v.setUint32(8,80,true);v.setUint32(12,tick,true)
 v.setUint16(32,12,true);v.setUint32(36,44,true);v.setUint32(40,36,true);v.setUint32(44,1,true)
 const o=48;v.setUint32(o,id,true);v.setUint32(o+4,source,true);v.setInt32(o+8,9728,true);v.setInt32(o+12,13824,true);v.setUint16(o+20,384,true);v.setUint16(o+22,frame,true);v.setUint16(o+24,frames,true);v.setUint16(o+26,frames?40:0,true);v.setInt32(o+28,17,true);return raw
}
const decoder=new SnapshotDecoder(),state=new DeploymentStates(),out=new Float64Array(5)
let decoded=decoder.decode(snapshot(17,0));state.ingest(decoded.deployments,17);assert.equal(state.progressOf(132,1),0);assert.ok(state.sourceOf(132,out));assert.deepEqual(Array.from(out),[131,9728,13824,0,384])
decoded=decoder.decode(snapshot(18,1));state.ingest(decoded.deployments,18);assert.ok(Math.abs(state.progressOf(132,.5)-.5/31)<1e-7)
const paused=state.progressOf(132,.5);state.ingest(decoded.deployments,18);assert.equal(state.progressOf(132,.5),paused)
state.ingest(null,19);assert.equal(state.progressOf(132,1),1);assert.equal(state.sourceOf(132,out),false,'hidden/removed record not retained as active')
assert.ok(Math.abs(state.rememberedProgressOf(132)-1/31)<1e-7,'fog memory freezes last observed progress');assert.ok(state.sourceOf(132,out,true),'copied source anchor available for frozen appearance')
decoded=decoder.decode(snapshot(26,9));state.ingest(decoded.deployments,26);assert.ok(Math.abs(state.progressOf(132,0)-9/31)<1e-7,'mid-sequence observer starts at actual frame')
decoded=decoder.decode(snapshot(49,0,0));state.ingest(decoded.deployments,49);assert.equal(state.progressOf(132,1),1,'explicit completion')
decoded=decoder.decode(snapshot(17,0));state.ingest(decoded.deployments,17);assert.equal(state.progressOf(132,1),0,'replay rewind resets')
// Full protocol-sized visible roster cannot evict an active or fog-remembered yard.
const crowded=new DeploymentStates(),buffer=new ArrayBuffer(4096*32),view=new DataView(buffer)
for(let i=0;i<4096;i++){const o=i*32;view.setUint32(o,10000+i,true);view.setUint32(o+4,9000,true);view.setUint16(o+22,i?0:10,true);view.setUint16(o+24,i?0:32,true)}
crowded.ingest({view,byteOffset:0,count:4096},1)
assert.equal(crowded.progressOf(10000,1),10/31)
view.setUint32(0,20000,true);view.setUint16(24,0,true)
crowded.ingest({view,byteOffset:0,count:4096},2)
assert.equal(crowded.rememberedProgressOf(10000),10/31)
crowded.retainActors({count:1,id:Uint32Array.of(20000)},{count:1,id:Uint32Array.of(10000)})
assert.equal(crowded.rememberedProgressOf(10000),10/31)
assert.equal(crowded.sourceOf(10001,out,true),false,'forgotten actors release memory')
crowded.retainActors(null,null);assert.equal(crowded.sourceOf(10000,out,true),false)
for(const bad of [snapshot(17,33),snapshot(17,0,32,131,131),snapshot(17,0,32,132,0)])assert.throws(()=>decoder.decode(bad))
const malformed=snapshot(17,0);new DataView(malformed).setUint32(44,4097,true);assert.throws(()=>decoder.decode(malformed))
for(const height of [()=>0,(x,z)=>.1*x-.06*z,(x,z)=>Math.sin(x)*.13+Math.cos(z)*.15]){
 const source=new Float32Array(16),target=new Float32Array(16)
 placeActor(source,0,9.5,13.5,Math.PI/2+384/1024*2*Math.PI,.8,.46,false,0,height,0)
 placeActor(target,0,9.5,13.5,Math.PI/2,1.2,1.2,false,0,height,0)
 for(const progress of [0,.025,.06,.1,.12,1]){
  const actual=target.slice();settleDeploymentBasis(actual,0,source,progress)
  for(const i of [0,4,8])assert.ok(Math.abs(Math.hypot(...actual.slice(i,i+3))-1)<1e-6,'settling retains unit axes')
  for(const [i,j]of[[0,4],[0,8],[4,8]])assert.ok(Math.abs(actual[i]*actual[j]+actual[i+1]*actual[j+1]+actual[i+2]*actual[j+2])<1e-6,'settling retains orthogonal axes')
  if(progress>=.12)assert.deepEqual(actual,target,'target support plane exact after jack phase')
  if(progress===0){for(let i=12;i<15;i++)assert.equal(actual[i],source[i]);for(let i=0;i<3;i++)assert.ok(Math.abs(actual[i]-(-source[i]+source[8+i])*Math.SQRT1_2)<1e-6,'folded donor keeps old placed orientation')}
 }
}
console.log('DEPLOYMENT_RIG_PASS',JSON.stringify({bones:n,channels:contract.channels.length,poses:9,signedRoofArc:true,separateTranslationPhase:true,shortestArcNegativeControl:true,scaleChannels:0,sourceId:131,targetId:132}))
