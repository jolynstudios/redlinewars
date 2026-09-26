#!/usr/bin/env node
// Production saved meshes + production remains, not a second animation implementation.
import assert from 'node:assert/strict'
import {readFileSync,mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {build} from 'esbuild'
const web=fileURLToPath(new URL('..',import.meta.url)),temp=mkdtempSync(join(tmpdir(),'steelseed-deathgate-'))
try{
 const file=join(temp,'death.mjs')
 await build({stdin:{contents:`export {DeathVisuals} from './src/units/death-visuals';
 export {decodeBlenderAsset} from './src/units/blender-mesh';
 export {Renderer} from './src/render/renderer';
 export {packDamageOpacity,INSTANCE_APPEARANCE_WGSL} from './src/render/instance-appearance';
 export {Units} from './src/units/index';
 export {computeWorldTransforms,computeSkinMatrices,setBoneAngle} from './src/geo/rig';`,resolveDir:web,loader:'ts'},
 bundle:true,platform:'node',format:'esm',outfile:file,logLevel:'silent',
 // Boot asset discovery is not exercised here; concrete saved meshes are decoded below.
 define:{'import.meta.glob':'__gateGlob'},banner:{js:'const __gateGlob = () => ({})'}})
 const api=await import(pathToFileURL(file)),manifest=JSON.parse(readFileSync(join(web,'.forge/blender/manifest.json'))),pack=new Uint8Array(readFileSync(join(web,'.forge/blender/roster.ssasset')))
 for(const damage of [0,.2,.5,1])for(const alpha of [.0001,.2,.5,.9999,1]){
  const packed=Math.fround(api.packDamageOpacity(damage,alpha))
  const decodedDamage=packed<0?Math.floor(-packed/2)/255:packed
  const decodedAlpha=packed<0?-packed-2*Math.floor(-packed/2):1
  assert.ok(Math.abs(decodedDamage-damage)<=1/255);assert.ok(Math.abs(decodedAlpha-alpha)<.00005)
 }
 assert.match(api.INSTANCE_APPEARANCE_WGSL,/floor\(-w\/2.0\)\/255.0/)
 const identity=()=>Float32Array.of(1,0,0,0,0,1,0,0,0,0,1,0,16.5,0,16.5,1)
 const hidden=new Set(),shroud={isVisible(x,z){return !hidden.has(`${x},${z}`)}},terrain={heightAt(x,z){return .1*(x-16.5)+.06*(z-16.5)}}
 let draw=null,palette=null,overflow=false
 const render={copyCompletedBones(base,count,out){return api.Renderer.prototype.copyCompletedBones.call(this,base,count,out)},
 reserveBones(count){if(overflow)return null;palette=new Float32Array(count*16);return {base:1,matrices:palette}},
 submit(item){draw={...item,instances:item.instances.slice(),palette:palette?.slice()??null}},boneData:null,completedBoneCount:0}
 const fixtures=[]
 for(const [name,kind] of [['e1',1],['1tnk',2],['dog',3]]){
  const {mesh,rig}=api.decodeBlenderAsset(pack,manifest.assets[name]),sk=rig.skeleton,pose=sk.createPose(),world=sk.createMatrixBuffer(),skin=sk.createMatrixBuffer()
  const articulated=rig.turretBones[0]??rig.legBones[0]
  if(articulated!==undefined)api.setBoneAngle(pose,articulated,.3)
  api.computeWorldTransforms(pose,world);api.computeSkinMatrices(sk,world,skin)
  const buffers=mesh.toGPUBuffers(),gpu={aabbMin:buffers.aabbMin,aabbMax:buffers.aabbMax,indexCount:mesh.triangleCount*3}
  fixtures.push({name,kind,mesh,rig,skin,gpu,capture:{mesh:gpu,surfaceSet:'blender',playerColor:2,boneCount:sk.boneCount,paletteBase:1}})
 }
 function previous(f){render.boneData=new Float32Array(f.skin.length+16);render.boneData.set(f.skin,16);render.completedBoneCount=f.skin.length/16+1}
 function frame(deaths,t){draw=null;palette=null;deaths.update(t,render,terrain,shroud);return draw}
 function contact(f,draw){
  const m=draw.instances,p=draw.palette;let min=Infinity
  for(let v=0;v<f.mesh.vertexCount;v++){
   const x=f.mesh.positions[v*3],y=f.mesh.positions[v*3+1],z=f.mesh.positions[v*3+2];let sx=0,sy=0,sz=0
   for(let j=0;j<4;j++){const w=f.mesh.skinWeights[v*4+j];if(!w)continue;const b=f.mesh.skinIndices[v*4+j]*16
    sx+=w*(p[b]*x+p[b+4]*y+p[b+8]*z+p[b+12]);sy+=w*(p[b+1]*x+p[b+5]*y+p[b+9]*z+p[b+13]);sz+=w*(p[b+2]*x+p[b+6]*y+p[b+10]*z+p[b+14])}
   const wx=m[0]*sx+m[4]*sy+m[8]*sz+m[12],wy=m[1]*sx+m[5]*sy+m[9]*sz+m[13],wz=m[2]*sx+m[6]*sy+m[10]*sz+m[14]
   min=Math.min(min,wy-terrain.heightAt(wx,wz))
  }
  assert.ok(min>=-.0001,`${f.name} terrain penetration ${min}`)
  return min
 }
 const report=[]
 for(const f of fixtures){
  const d=new api.DeathVisuals();d.register(f.gpu,f.kind,f.rig.skeleton,f.mesh);previous(f)
  assert.equal(d.kind(f.gpu),f.kind);assert.equal(d.kind({}),0)
  const out=new Float32Array(f.skin.length)
  assert.equal(render.copyCompletedBones(1,f.capture.boneCount,out),true);assert.deepEqual(out,f.skin)
  assert.equal(render.copyCompletedBones(2,f.capture.boneCount,out),false)
  assert.equal(render.copyCompletedBones(-1,1,out),false);assert.equal(render.copyCompletedBones(1,300,out),false)
  assert.equal(render.copyCompletedBones(0,f.capture.boneCount,out),true)
  for(let k=0;k<out.length;k++)assert.equal(out[k],k%16%5===0?1:0)
  hidden.add('16,16');assert.equal(d.start(1,0,identity(),f.capture,render,shroud),false);hidden.clear()
  assert.equal(d.start(1,0,identity(),{...f.capture,boneCount:257},render,shroud),false)
  assert.equal(d.start(1,0,identity(),f.capture,render,shroud),true)
  assert.equal(d.start(1,0,identity(),f.capture,render,shroud),false,'duplicate must not restart')
  const born=frame(d,0);assert.ok(born);assert.deepEqual(born.palette,f.skin,'last visible pose must be retained')
  const fallen=frame(d,1);assert.ok(fallen);const clearance=contact(f,fallen)
  assert.deepEqual(frame(d,1),fallen,'paused simulation must hold the exact matrices/opacity')
  if(f.kind===1)assert.ok(Math.abs(fallen.instances[5])<.001,'human must lie horizontally')
  if(f.kind===2){assert.notDeepEqual(fallen.palette,born.palette);assert.equal(d.stats.parts,f.rig.skeleton.boneCount-1)}
  const fading=frame(d,f.kind===2?2.2:4.5);assert.ok(fading.opacity>0&&fading.opacity<1);assert.equal(fading.castsShadow,false)
  hidden.add('16,16');assert.equal(frame(d,1),null);hidden.clear()
  overflow=true;assert.equal(frame(d,1),null);overflow=false
  assert.equal(frame(d,6),null);assert.equal(d.stats.active,0)
  assert.equal(d.start(2,10,identity(),f.capture,render,shroud),true);assert.equal(frame(d,9),null,'rewind clears old remains')
  report.push({name:f.name,bones:f.rig.skeleton.boneCount,clearance})
 }
 const f=fixtures[0],d=new api.DeathVisuals();d.register(f.gpu,1,f.rig.skeleton,f.mesh);previous(f)
 for(let id=0;id<64;id++)assert.equal(d.start(id,0,identity(),f.capture,render,shroud),true)
 assert.equal(d.start(64,0,identity(),f.capture,render,shroud),false);assert.equal(d.stats.dropped,1)
 d.clear();assert.equal(frame(d,1),null)
 // Actual Units event handler/capture path: no record means no corpse. Event payloads may
 // share a reused unaligned buffer; no reference to that buffer may survive capture.
 const u=new api.Units(),view=new DataView(new ArrayBuffer(32)),ctx={snapshot:{view,tick:10},prevSnapshot:{tick:9},time:{tick:10,alpha:.75}}
 u.deathContext=ctx;u.render=render;u.shroud=shroud;u.deaths.register(f.gpu,1,f.rig.skeleton,f.mesh)
 u.slotBuckets.set('e1',{mesh:f.gpu,count:1,motionIds:Uint32Array.of(42),instances:identity(),colors:Uint8Array.of(2),rig:f.rig,paletteBases:Uint16Array.of(1),surfaceSet:'blender'})
 assert.equal(u.deathStats.births,0);assert.equal(u.deathKindOf(42),1);assert.equal(u.deathKindOf(999),0)
 view.setUint32(3,42,true);u.onActorDestroyed({offset:3,byteLength:12});assert.equal(u.deathStats.births,0)
 u.onActorDestroyed({offset:3,byteLength:18});assert.equal(u.deathStats.births,1)
 assert.ok(frame(u.deaths,.4),'new snapshot alpha reset must not delete a death born with stale alpha .75')
 view.setUint32(3,999,true);u.onActorDestroyed({offset:3,byteLength:18});assert.equal(u.deathStats.births,1)
 assert.ok(frame(u.deaths,1),'retained mesh survives source actor disappearing')
 // An interior mound is invisible to corner-only contact. Probe a real source hull.
 const tank=fixtures[1],hill=new api.DeathVisuals();previous(tank);hill.register(tank.gpu,2,tank.rig.skeleton,tank.mesh)
 hill.start(90,0,identity(),tank.capture,render,shroud)
 const savedHeight=terrain.heightAt
 terrain.heightAt=(x,z)=>Math.max(0,.8*(1-Math.hypot(x-16.5,z-16.5)/.3))
 contact(tank,frame(hill,1));terrain.heightAt=savedHeight
 const air=api.decodeBlenderAsset(pack,manifest.assets.mig),sk=air.rig?.skeleton??null,buffers=air.mesh.toGPUBuffers()
 const plane={aabbMin:buffers.aabbMin,aabbMax:buffers.aabbMax,indexCount:air.mesh.triangleCount*3}
 const crash=new api.DeathVisuals();crash.register(plane,2,sk,air.mesh,true)
 const high=identity();high[13]=8
 assert.ok(crash.start(91,0,high,{mesh:plane,surfaceSet:'blender',playerColor:0,boneCount:sk?.boneCount??0,paletteBase:0},render,shroud))
 const crashStart=frame(crash,0),crashFall=frame(crash,.5)
 assert.ok(crashFall.instances[13]<crashStart.instances[13]-1,'destroyed aircraft hull must descend, not hang in midair')
 assert.equal(crashFall.damages[0],1,'vehicle must stay fully damaged')
 const helicopter=api.decodeBlenderAsset(pack,manifest.assets.heli),hb=helicopter.mesh.toGPUBuffers(),hs=helicopter.rig.skeleton
 const hg={aabbMin:hb.aabbMin,aabbMax:hb.aabbMax,indexCount:helicopter.mesh.triangleCount*3},hc=new api.DeathVisuals()
 hc.register(hg,2,hs,helicopter.mesh,true);const hm=identity();hm[13]=2
 hc.start(92,0,hm,{mesh:hg,surfaceSet:'blender',playerColor:0,boneCount:hs.boneCount,paletteBase:0},render,shroud)
 const struck=frame(hc,1.5),landed=frame(hc,1.9),later=frame(hc,2.6)
 assert(landed.instances[5]>struck.instances[5],'a crashed helicopter lies flatter than it fell')
 assert.deepEqual(later.instances,landed.instances,'crashed skinned aircraft hull must stay settled')
 assert.deepEqual(later.palette,landed.palette,'detached aircraft parts must not receive root contact lift twice')
 // Height must never make an aircraft expire in midair. Then test the actual husk handoff.
 const tall=new api.DeathVisuals();tall.register(plane,2,sk,air.mesh,true);const tm=identity();tm[13]=80
 const pc={mesh:plane,surfaceSet:'blender',playerColor:0,boneCount:sk?.boneCount??0,paletteBase:0}
 tall.start(100,0,tm,pc,render,shroud,80)
 assert.equal(frame(tall,3).opacity,1,'fixed vehicle fade must not erase a still-airborne aircraft')
 const linked=new api.DeathVisuals();linked.register(plane,2,sk,air.mesh,true);tm[13]=10;linked.start(101,0,tm,pc,render,shroud,8)
 assert.equal(linked.follow(999,1001,0,16.5,16.5,8,0),false,'unrelated parent must never take the captured model')
 const impacts=[],signals=(e,impact)=>{if(impact)impacts.push({...e})}
 function linkedFrame(t,alt=8-t*.8){linked.follow(101,1001,t,16.5+t*.2,16.5,alt,t*.1);draw=null;linked.update(t,render,terrain,shroud,signals);return draw}
 const original=linkedFrame(0),falling=linkedFrame(3)
 assert(linked.ownsHusk(1001));assert.equal(falling.opacity,1);assert(falling.instances[13]<original.instances[13]-1);assert(falling.instances[12]>original.instances[12]+.5)
 assert.notDeepEqual(falling.instances.slice(0,12),original.instances.slice(0,12),'fall must tilt and follow real husk heading')
 assert.deepEqual(linkedFrame(3),falling,'pause freezes crash matrix and opacity')
 hidden.add('17,16');assert.equal(linkedFrame(3),null);assert.equal(impacts.length,0);hidden.clear()
 assert.deepEqual(linkedFrame(3),falling,'fog reveal must not restart the crash')
 assert(linked.finishHusk(1001));const grounded=linkedFrame(4,0);assert.equal(impacts.length,1);assert.equal(impacts[0].water,false)
 assert.deepEqual(linkedFrame(4,0).instances,grounded.instances,'pause must not move the wreck');assert.equal(impacts.length,1,'pause must not replay impact')
 // The wreck lies down on what it struck; holding the flight attitude read as hanging in the air.
 const settled=linkedFrame(4.5,0),held=linkedFrame(5,0)
 assert.deepEqual(held.instances,settled.instances,'a crashed aircraft settles once, then holds');assert.equal(held.opacity,1)
 assert(settled.instances[5]>grounded.instances[5]+.1,'the wreck lies flat instead of keeping its flight attitude')
 assert(settled.instances[13]<grounded.instances[13],'the wreck drops onto the surface instead of resting on one corner')
 const wreckFade=linkedFrame(6,0);assert(wreckFade.opacity>0&&wreckFade.opacity<1,'the wreck fades on its own clock')
 linkedFrame(9,0);assert.equal(linked.ownsHusk(1001),false)
 // A husk that crashes out of sight never reports its end. The wreck still fades on its own, and
 // the husk it replaced stays hidden while the snapshot carries it, then ownership lapses.
 const lost=new api.DeathVisuals();lost.register(plane,2,sk,air.mesh,true);tm[13]=10;lost.start(103,0,tm,pc,render,shroud,8)
 const lostFrame=t=>{if(t<=7)lost.follow(103,1003,t,16.5,16.5,Math.max(0,8-t*4),0);draw=null;lost.update(t,render,terrain,shroud);return draw}
 for(let t=0;t<=3;t+=.25)lostFrame(t)
 assert.equal(lost.stats.impacts,1,'a husk lost from sight still reaches the surface once')
 assert.equal(lostFrame(7),null,'a wreck must not wait for an unseen husk to end')
 assert(lost.ownsHusk(1003),'a still-reported husk must not reappear as a second aircraft')
 lostFrame(8.5);assert.equal(lost.ownsHusk(1003),false,'ownership lapses once the husk leaves the snapshot')
 const waterCrash=new api.DeathVisuals();waterCrash.register(plane,2,sk,air.mesh,true);tm[13]=5;waterCrash.start(102,0,tm,pc,render,shroud,5)
 terrain.waterHeightAt=()=>2;draw=null;waterCrash.update(1,render,terrain,shroud,signals);assert.equal(impacts.at(-1).water,true);assert.equal(impacts.at(-1).y,2)
 const surface=draw.instances[13];waterCrash.update(2,render,terrain,shroud,signals);assert(draw.instances[13]<surface,'water crash must sink below waterline');delete terrain.waterHeightAt
 u.deaths.clear();ctx.snapshot.tick=1;u.onActorDestroyed({offset:3,byteLength:18});assert.equal(u.deathStats.births,1)
 console.log('deathvisualgate PASS',JSON.stringify({fixtures:report,capacity:64,checks:'captured pose, fall, breakup, contact, fade, pause, shroud, overflow, rewind, actual Units event routing'}))
}finally{rmSync(temp,{recursive:true,force:true})}
