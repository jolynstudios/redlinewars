#!/usr/bin/env node
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {readFileSync} from 'node:fs'
import {WEB_ROOT} from './harness.mjs'
const result=await build({entryPoints:[WEB_ROOT+'/src/fx/utility-water.ts'],bundle:true,write:false,format:'cjs',platform:'node',logLevel:'silent'})
const mod={exports:{}};new Function('module','exports',result.outputFiles[0].text)(mod,mod.exports)
const {UtilityWater,waterImpact}=mod.exports
const manifest=JSON.parse(readFileSync(WEB_ROOT+'/src/utility-manifest.json','utf8'))
for(const [slot,entry] of Object.entries(manifest.states)){
 const actor=slot.replace(/\.d[0-9]+$/,'')
 const pack=JSON.parse(readFileSync(WEB_ROOT+'/.forge/damage-states/'+actor+'/manifest.json','utf8'))
 const source=pack.states.find(s=>s.sourcePath.endsWith('/'+slot+'.blend'))
 assert.equal(entry.sourceSha256,source.sourceSha256,'utility anchor must match shipped source')
 assert.ok(['Medium','Heavy'].includes(source.state))
}
const hit=new Float64Array(4),flat={heightAt:()=>0},slope={heightAt:(x,z)=>.08*x-.03*z}
assert.ok(waterImpact(hit,0,.1,0,2,2,0,2,flat));assert.ok(Math.abs(hit[1])<1e-6);assert.ok(Math.abs(.1+2*hit[3]-4.905*hit[3]**2)<1e-5)
assert.ok(waterImpact(hit,0,.1,0,2,2,0,2,slope));assert.ok(Math.abs(hit[1]-slope.heightAt(hit[0],hit[2]))<1e-7)
assert.equal(waterImpact(hit,0,2,0,2,2,0,.1,flat),false,'bound prevents unreachable wet film')
let submissions=[],particles=0
const render={camera:{position:[0,5,0]},upload:m=>({indexCount:m.indexCount}),submit:item=>submissions.push({count:item.instanceCount,data:Array.from(item.instances.subarray(0,item.instanceCount*16))}),addParticle:()=>particles++}
const fx=new UtilityWater();fx.init(render)
const matrix=Float32Array.of(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)
const units={visitVisibleInstances:(slot,sink)=>{if(slot==='v03.d3')sink(matrix,0,123)}}
const visible={isVisible:()=>true},hidden={isVisible:()=>false}
fx.tick(2,'low',units,render,flat,visible);assert.equal(fx.stats.supplies,1);assert.equal(fx.stats.segments,8);assert.equal(fx.stats.droplets,0)
const lowJet=submissions[0].data,lowFilm=submissions[1].data
assert.ok(lowJet.every(Number.isFinite));assert.ok(lowFilm.every(Number.isFinite))
submissions=[];fx.tick(2,'ultra',units,render,flat,visible);assert.equal(fx.stats.segments,32);assert.equal(fx.stats.droplets,8)
assert.deepEqual(submissions[1].data,lowFilm,'quality cannot move the wet ground')
assert.deepEqual(submissions[0].data.slice(12,16),lowJet.slice(12,16),'quality cannot move the source')
const paused=JSON.stringify(submissions);submissions=[];fx.tick(2,'ultra',units,render,flat,visible);assert.equal(JSON.stringify(submissions),paused,'paused effect is exact')
submissions=[];fx.tick(3,'ultra',units,render,flat,hidden);assert.equal(submissions.length,0);assert.equal(fx.stats.supplies,0)
submissions=[];fx.tick(3,'ultra',{visitVisibleInstances:()=>{}},render,flat,visible);assert.equal(submissions.length,0,'repair/critical/dead have no persistent supply')
const crowd={visitVisibleInstances:(slot,sink)=>{if(slot==='v03.d3')for(let i=0;i<100;i++){matrix[12]=i*.2;sink(matrix,0,i)}}}
submissions=[];fx.tick(3,'ultra',crowd,render,flat,visible);assert.ok(fx.stats.supplies<=16);assert.ok(fx.stats.segments<=512);assert.ok(fx.stats.films<=320);assert.ok(fx.stats.dropped>0);assert.ok(submissions.every(s=>s.data.every(Number.isFinite)))
console.log('UTILITY_WATER_PASS',JSON.stringify(fx.stats))
