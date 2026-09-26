#!/usr/bin/env node
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {WEB_ROOT} from './harness.mjs'
const result=await build({stdin:{contents:"export {supportHalfExtents} from './src/units/occupancy.ts';export {runningGearProfile} from './src/units/running-gear.ts';export {placeActor} from './src/core/place.ts'",resolveDir:WEB_ROOT},bundle:true,write:false,format:'cjs',platform:'node',logLevel:'silent'})
const m={exports:{}};new Function('module','exports',result.outputFiles[0].text)(m,m.exports)
const {supportHalfExtents,runningGearProfile,placeActor}=m.exports
const mesh={aabbMin:[-4,-.01,-2],aabbMax:[6,3,3]}
const tank=runningGearProfile('1tnk',1),bounds=supportHalfExtents(mesh,1,tank)
assert.ok(bounds.halfLen>.5&&bounds.halfLen<.7,'ground footprint follows tracks, not long barrel')
assert.ok(bounds.halfWid>.35&&bounds.halfWid<.45)
assert.deepEqual(supportHalfExtents(mesh,.5),{halfLen:3,halfWid:1.5},'static asymmetric bounds respect actual fit/pivot')
assert.deepEqual(supportHalfExtents(mesh,.5,runningGearProfile('1tnk',.5)),{halfLen:bounds.halfLen*.5,halfWid:bounds.halfWid*.5},'contact metadata is already fitted once')
const old=new Float32Array(16),now=new Float32Array(16)
placeActor(old,0,0,0,0,.12,.12,false,0,()=>0)
placeActor(now,0,0,0,0,bounds.halfLen,bounds.halfWid,false,0,()=>0)
assert.deepEqual(now,old,'flat-ground appearance and scale must stay unchanged')
const bump=x=>x>.3?.08:0
placeActor(old,0,0,0,0,.12,.12,false,0,bump)
placeActor(now,0,0,0,0,bounds.halfLen,bounds.halfWid,false,0,bump)
const oldContactY=old[1]*bounds.halfLen+old[13],newContactY=now[1]*bounds.halfLen+now[13]
assert.ok(Math.abs(newContactY-.08)<.001,'actual track span must see the raised front support')
assert.ok(Math.abs(oldContactY-.08)>.07,'negative control: stale .12m footprint clips raised support')
for(const yaw of [0,.4,1.57,3.14]){
 placeActor(now,0,0,0,yaw,bounds.halfLen,bounds.halfWid,false,0,(x,z)=>x*.1+z*.08)
 assert.ok([...now].every(Number.isFinite));for(const offset of [0,4,8])assert.ok(Math.abs(Math.hypot(...now.slice(offset,offset+3))-1)<1e-6,'grounding must not shrink silhouette')
}
console.log('GROUND_BINDING_PASS',JSON.stringify({bounds,oldContactY,newContactY,fit:1}))
