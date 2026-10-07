#!/usr/bin/env node
// Unwrapped travel at render alpha, not a tick-stepped/wrapped walk phase.
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {resolve} from 'node:path'

const web=resolve(import.meta.dirname,'..')
const bundled=await build({stdin:{contents:"export {Anim} from './src/anim/index.ts'",resolveDir:web,loader:'ts'},
 bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'})
const {Anim}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
const anim=new Anim()
let tick=0
function snapshot(x=null){return {tick:tick++,actors:{count:x===null?0:1,id:Uint32Array.of(1),posX:Int32Array.of(x??0),posY:Int32Array.of(0),facing:Uint16Array.of(768)}}}
let previous=null
function step(x){const current=snapshot(x);anim.onSnapshot(current,previous,null);previous=current}
step(0);assert.equal(anim.interpolatedDistanceOf(1,.5),0)
step(1024)
for(const alpha of [0,.125,.5,.875,1])assert.ok(Math.abs(anim.interpolatedDistanceOf(1,alpha)-alpha)<1e-9)
assert.equal(anim.interpolatedDistanceOf(1,-5),0);assert.equal(anim.interpolatedDistanceOf(1,5),1)
assert.equal(anim.interpolatedDistanceOf(1,NaN),1)
step(512)
assert.equal(anim.distanceOf(1),.5);assert.equal(anim.interpolatedDistanceOf(1,.5),.75)
// Phase conversion happens only after interpolation; do not interpolate wrapped cycles.
const stride=.19,interpolated=anim.interpolatedDistanceOf(1,.37)
assert.ok(Math.abs(interpolated-(1-.5*.37))<1e-9)
assert.ok(interpolated>stride*4)
step(512);assert.equal(anim.interpolatedDistanceOf(1,.1),.5);assert.equal(anim.interpolatedDistanceOf(1,.9),.5)
step(102400);assert.equal(anim.interpolatedDistanceOf(1,.5),.5,'teleport must not become stride travel')
step(null);assert.equal(anim.interpolatedDistanceOf(1,0),0,'removed actors cannot expose stale travel')
step(100);assert.equal(anim.interpolatedDistanceOf(1,.5),0,'new sighting restarts without invented movement')
assert.equal(anim.interpolatedDistanceOf(900,.5),0)
anim.dispose();assert.equal(anim.interpolatedDistanceOf(1,.5),0)
console.log('animinterpolationgate PASS: endpoints, sub-tick alpha, reverse, unwrapped multi-cycle travel, pause, teleport, removal, first sighting and disposal')
