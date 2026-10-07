#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'
import { resolve } from 'node:path'
const web=resolve(import.meta.dirname,'..'),root=resolve(web,'..')
const bundled=await build({stdin:{contents:`export {Anim} from './src/anim/index'; export {GroundTracks} from './src/fx/ground-tracks'; export {runningGearProfile,packRunningPhases} from './src/units/running-gear'; export {fitScaleForMesh} from './src/units/occupancy'; export {wangleToRadians} from './src/core';`,resolveDir:web},bundle:true,format:'esm',platform:'node',write:false,logLevel:'silent'})
const {Anim,GroundTracks,runningGearProfile,packRunningPhases,fitScaleForMesh,wangleToRadians}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
const metadata=JSON.parse(readFileSync(`${web}/src/units/running-gear.json`,'utf8')).actors,assets=JSON.parse(readFileSync(`${web}/.forge/blender/manifest.json`,'utf8')).assets
const profile=name=>{const b=assets[name].bounds;return runningGearProfile(name,fitScaleForMesh(b[1][0]-b[0][0],b[1][2]-b[0][2],1,1))}
const geometry={}
for(const name of Object.keys(metadata)){
 const p=profile(name);assert.equal(metadata[name].sourceSha256,assets[name].sourceSha256)
 assert.ok(p.leftZ<0&&p.rightZ>0&&p.width>0&&p.pitch>0)
 assert.ok(p.width<p.rightZ-p.leftZ);assert.ok(p.visualLoad>0&&p.visualLoad<=1)
 assert.equal(p.width,metadata[name].width*p.fitScale)
 geometry[name]=p
}
assert.ok(geometry['4tnk'].width>geometry['1tnk'].width&&geometry['1tnk'].width>geometry.jeep.width,'heavy/light/tyre contact widths are distinct actual source measurements')
function snapshot(tick,x=0,z=0,facing=768,id=7,typeId=1){return {tick,flags:0,actors:{count:1,id:Uint32Array.of(id),posX:Int32Array.of(Math.round(x*1024)),posY:Int32Array.of(Math.round(z*1024)),facing:Uint16Array.of(facing),flags:Uint8Array.of(0),typeId:Uint16Array.of(typeId),surface:Uint8Array.of(4)}}}
const anim=new Anim();let previous=null
function step(tick,x,z,facing=768){const snap=snapshot(tick,x,z,facing);anim.onSnapshot(snap,previous,null);previous=snap;return snap}
step(0,0,0);step(1,1,0)
assert.equal(anim.sideDistanceOf(7,-.25,1),1);assert.equal(anim.sideDistanceOf(7,.25,1),1)
assert.equal(anim.sideDistanceOf(7,-.25,.5),.5,'side travel interpolates with placement')
step(2,0,0);assert.equal(anim.sideDistanceOf(7,-.25,1),0,'reverse subtracts travel')
step(3,0,0,512)
const left=anim.sideDistanceOf(7,-.25,1),right=anim.sideDistanceOf(7,.25,1)
assert.ok(Math.abs(left+right)<1e-9&&Math.abs(Math.abs(left)-Math.PI/8)<1e-9,'neutral turn drives opposite treads')
const old=left;anim.onSnapshot(previous,snapshot(2,0,0),null);assert.equal(anim.sideDistanceOf(7,-.25,1),old,'duplicate tick cannot integrate twice')
step(4,100,100,256);assert.equal(anim.sideDistanceOf(7,-.25,1),old,'teleport does not integrate translation or yaw')
step(1,0,0);assert.equal(anim.sideDistanceOf(7,.25,1),0,'rewind resets presentation integrals')
step(2,.1,0,704)
assert.notEqual(anim.sideDistanceOf(7,-.25,1),anim.sideDistanceOf(7,.25,1),'moving turn has inner/outer differential')
const stable=anim.sideDistanceOf(7,.25,1);step(3,.1,0,704);assert.equal(anim.sideDistanceOf(7,.25,1),stable,'parked wheels hold')
for(let t=4;t<1004;t++)step(t,.1,0,704)
assert.equal(anim.trackedCount,1);assert.equal(anim.turn.size,1);assert.equal(anim.turnScratch.size,1)
anim.onSnapshot({tick:1005,actors:null},previous,null);assert.equal(anim.trackedCount,0);assert.equal(anim.turn.size,0)
// Float32 round trip, signed unwrapped input, and independent side decoding.
for(const l of [-123.875,-.01,0,.5,1,300.999])for(const r of [-27.5,0,.333,99.8]){
 const packed=new Float32Array([packRunningPhases(l,r)])[0],bits=packed>>>0
 assert.equal(packed,packRunningPhases(l,r));assert.ok(packed<=16777215)
 assert.ok(Math.abs((bits&4095)/4096-(l-Math.floor(l)))<=1/4096)
 assert.ok(Math.abs(((bits>>>12)&4095)/4096-(r-Math.floor(r)))<=1/4096)
}
const submitted=[],uploads=[],shroud={isVisible:()=>true},names={1:'1tnk',2:'4tnk',3:'jeep'},weather={environment:{surfaceWetness:0,snowCoverage:0}}
const render={upload(mesh,label){uploads.push({label,triangles:mesh.triangleCount});return {indexCount:mesh.indexCount}},submit(item){submitted.push(item)},camera:{position:new Float32Array([0,0,0])}}
function setup(name='1tnk',surface=4,cap=256){
 const typeId=Number(Object.keys(names).find(k=>names[k]===name)),tracks=new GroundTracks(),a=new Anim(),ctx={time:{alpha:1},snapshot:null,prevSnapshot:null,actorTypeName:id=>names[id]??'',peek:id=>id==='anim'?a:id==='units'?{runningGearOf:profile}:id==='sky'?weather:null}
 let last=null
 const terrain={heightAt:(x,z)=>.12+x*.03+z*.02,surfaceAt:()=>surface}
 tracks.init(render,cap)
 function move(tick,x,z=0,facing=768){const snap=snapshot(tick,x,z,facing,7,typeId);ctx.prevSnapshot=last;ctx.snapshot=snap;a.onSnapshot(snap,last,ctx);last=snap;submitted.length=0;tracks.tick(tick/25,ctx,render,terrain,shroud)}
 move(0,0)
 return {tracks,a,ctx,terrain,move}
}
for(const name of ['1tnk','4tnk','jeep']){
 const x=setup(name);x.move(1,.3)
 assert.ok(x.tracks.stats.stamped>0,`${name}: movement leaves marks`)
 const indexes=Array.from(x.tracks.active.keys()).filter(i=>x.tracks.active[i])
 assert.ok(indexes.every(i=>x.tracks.width[i]>=geometry[name].width&&x.tracks.width[i]<geometry[name].width*1.13))
 assert.ok(indexes.every(i=>x.tracks.depth[i]<.009),'imprints are millimetres, not raised black track shoes')
 const matrices=submitted.flatMap(item=>Array.from({length:item.instanceCount},(_,i)=>Array.from(item.instances.subarray(i*16,i*16+16))))
 for(const m of matrices)assert.ok(Math.abs(m[13]-(x.terrain.heightAt(m[12],m[14])+.0015))<1e-5,'imprint is supported by drawn ground')
 const stamped=x.tracks.stats.stamped;x.move(2,.3);assert.equal(x.tracks.stats.stamped,stamped)
 x.move(3,0);assert.ok(x.tracks.stats.stamped>stamped,'reverse stamps both contact paths')
 const prePivot=x.tracks.stats.stamped;x.move(4,0,0,512);assert.ok(x.tracks.stats.stamped>prePivot,'neutral turn stamps both pivot arcs')
 const preTeleport=x.tracks.stats.stamped;x.move(5,100);assert.equal(x.tracks.stats.stamped,preTeleport,'teleport makes no map-spanning streak')
 x.ctx.snapshot.flags=2;const held=x.tracks.stats.stamped;x.tracks.tick(5/25,x.ctx,render,x.terrain,shroud);assert.equal(x.tracks.stats.stamped,held,'pause does not stamp')
 x.ctx.snapshot.flags=0;x.tracks.tick(12,x.ctx,render,x.terrain,shroud);assert.equal(x.tracks.stats.active,0,'surface/load lifetime is at most ten seconds')
}
const dry=setup('4tnk',0);dry.move(1,.3);const dryDepth=dry.tracks.depth[0]
weather.environment.surfaceWetness=1;const mud=setup('4tnk',0);mud.move(1,.3);assert.ok(mud.tracks.depth[0]>dryDepth,'wet mud compresses more')
weather.environment.snowCoverage=.8;const snow=setup('1tnk',4);snow.move(1,.3);assert.ok(submitted.every(i=>i.surfaceSet==='snow'),'accumulated snow uses actual snow surface material')
for(const surface of [1,5,6,7]){const x=setup('1tnk',surface);x.move(1,.3);assert.ok(x.tracks.stats.stamped>0,`snow-covered hard land ${surface} must keep a continuous track`);assert.ok(submitted.every(i=>i.surfaceSet==='snow'))}
for(const surface of [8,12]){const x=setup('1tnk',surface);x.move(1,.3);assert.equal(x.tracks.stats.stamped,0,`water or resource ${surface} must not gain a snow rut`)}
const shallow=setup('1tnk',9);shallow.move(1,.3);assert.ok(shallow.tracks.stats.stamped>0&&submitted.every(i=>i.surfaceSet==='soil'),'shallow mud retains its existing non-snow imprint')
weather.environment.snowCoverage=0;weather.environment.surfaceWetness=0
for(const surface of [1,5,6,7,8,12]){const x=setup('4tnk',surface);x.move(1,.3);assert.equal(x.tracks.stats.stamped,0,`hard/water/resource ${surface} has no rut`)}
const budget=setup('4tnk',4,64),buffers=budget.tracks.bandInstances.flat(),bytes=budget.tracks.stats.instanceBytes
for(let t=1;t<400;t++)budget.move(t,t*.15)
assert.ok(budget.tracks.stats.active<=64&&budget.tracks.stats.submitted<=64);assert.ok(budget.tracks.stats.dropped>0)
for(let i=0;i<buffers.length;i++)assert.equal(budget.tracks.bandInstances.flat()[i],buffers[i],'instance storage is retained');assert.equal(budget.tracks.stats.instanceBytes,bytes)
assert.equal(budget.tracks.seenId.length,4096);assert.equal(budget.tracks.profileByType.size,1)
const zero=setup('1tnk',4,0);zero.move(1,1);assert.equal(zero.tracks.stats.stamped,0)
writeFileSync(`${root}/.artifacts/planx/tracks-geometry.json`,JSON.stringify({note:'Pure helper check using manifest bounds fitted into one cell. Actual Units runtime fit is independently recorded in tracks-browser-witness.json.',geometry,uploads:uploads.slice(0,3),budgetBytes:bytes},null,2))
console.log('differentialtracksgate: PASS — signed/interpolated/differential travel, reverse/pivot/teleport/replay, packed phases, 20 fitted contact profiles, grounded surface/load marks, fade and budget/allocation bounds')
