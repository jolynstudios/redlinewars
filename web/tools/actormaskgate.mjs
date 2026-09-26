#!/usr/bin/env node
// OWNER-DISABLED from the standard inventory (2026-09-19): known fixture-level red — staged fixture frames an empty view (mask shading untested in this state).
// See tools/DISABLED-GATES.md. The tool stays manually runnable; re-enable when fixed.
// KNOWN-RED (2026-09-19, under investigation): the staged surface-test scene renders
// an empty frame — 45 draw calls / 125k triangles are submitted (all 16 staged assets
// count>0, tank masked alias industrial-v1:1tnk bound) but the capture shows bare
// ground with the tree line pushed to the right edge, i.e. the camera views a spot
// left of the staged cluster. The mask-shading itself is untested in this state.
// Not a proven product break; a fixture framing/staging regression.

// Pixel evidence for UV1 shading, not an aesthetic or authoritative-gameplay gate.
// Each capture boots the built renderer independently with identical staged geometry.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { decodePng } from './png.mjs'

const web=resolve(import.meta.dirname,'..'),out=resolve(web,'.artifacts/living-battlefield')
if(!process.argv.includes('--reuse-captures'))for(const mode of ['on','off']){
 const args=['tools/artreview.mjs','--surface-test',`--label=phase0-masks-${mode}`]
 if(mode==='off')args.push('--noactormasks')
 const child=spawnSync(process.execPath,args,{cwd:web,stdio:'inherit',timeout:240000})
 assert.equal(child.status,0,child.error?.message??`mask ${mode} capture failed`)
}
const load=mode=>decodePng(readFileSync(resolve(out,`phase0-masks-${mode}.png`)))
const on=load('on'),off=load('off')
function compare(a,b){
 assert.equal(a.width,1400);assert.equal(a.height,900)
 assert.equal(b.width,a.width);assert.equal(b.height,a.height)
 const results={}
 // Fixed regions of the explicitly staged artreview --surface-test camera.
 for(const [name,x,y,w,h] of [['tank',530,390,240,270],['building',900,30,450,360],
  ['ground',320,710,480,130],['legacyFactory',380,40,250,260]]){
  let sum=0,changed=0
  for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++){
   let delta=0
   for(let c=0;c<3;c++)delta+=Math.abs(a.data[(yy*a.width+xx)*4+c]-b.data[(yy*b.width+xx)*4+c])
   sum+=delta;if(delta>3)changed++
  }
  results[name]={meanAbsoluteRgb:sum/(w*h*3),changedFraction:changed/(w*h)}
 }
 return results
}
function verify(r){
 for(const name of ['tank','building']){
  assert.ok(r[name].meanAbsoluteRgb>.5,`${name}: no readable mask contribution`)
  assert.ok(r[name].changedFraction>.05,`${name}: mask contribution too local`)
 }
 // One quantization level may change with exposure; unrelated surfaces must not acquire dirt.
 for(const name of ['ground','legacyFactory']){
  assert.ok(r[name].meanAbsoluteRgb<1,`${name}: neutral mask changed unrelated surface`)
  assert.ok(r[name].changedFraction<.01,`${name}: nonlocal material change`)
 }
}
assert.throws(()=>verify(compare(off,off)),/no readable mask contribution/,'unwired masks must fail')
const result=compare(on,off);verify(result)
writeFileSync(resolve(out,'phase0-mask-comparison.json'),JSON.stringify({result,
 falsification:'identical off/off images correctly fail',
 scope:'Built WebGPU staged diagnostic only; authoritative composed capture required separately'},null,2))
console.log('actormaskgate: PASS — mask contribution on both authored actors, neutral controls unchanged; off/off fails',JSON.stringify(result))
