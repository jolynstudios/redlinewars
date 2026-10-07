#!/usr/bin/env node
// Deliberately staged art review, NOT a gameplay/visibility acceptance fixture.
// Uses the shipping WebGPU renderer, shaders, Blender decoder, meshes, lighting and grass.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchGpuBrowser,loadChromium,startPreview,stopChild } from './harness.mjs'
const root=fileURLToPath(new URL('..',import.meta.url)),out=join(root,'.artifacts/living-battlefield')
const label=process.argv.find(a=>a.startsWith('--label='))?.slice(8)??'art-review'
assert.match(label,/^[a-z0-9-]+$/,'capture label must be a simple filename')
const exposureTest=process.argv.includes('--exposure-test')
const groundTest=process.argv.includes('--ground-test')
const foliageTest=process.argv.includes('--foliage-test')
const surfaceTest=process.argv.includes('--surface-test')||groundTest
const noGroundSources=process.argv.includes('--nogroundsources')
const noActorMasks=process.argv.includes('--noactormasks')
const preview=await startPreview(8438)
let browser
try{
 ({browser}=await launchGpuBrowser(await loadChromium('artreview'),'artreview'))
 const page=await browser.newPage({viewport:{width:1400,height:900},deviceScaleFactor:1}),errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('favicon'))errors.push(m.text())})
 await page.addInitScript(()=>{globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{}})
 if(exposureTest)await page.addInitScript(()=>{
  // Explicit diagnostic A/B only. Shipping shaders are unchanged by this capture.
  const create=GPUDevice.prototype.createShaderModule
  globalThis.exposureTestModules=0
  GPUDevice.prototype.createShaderModule=function(descriptor){
   if(descriptor.label==='render.exposure'){
    descriptor={...descriptor,code:descriptor.code.replace('EXPOSURE_MAX: f32 = 0.60','EXPOSURE_MAX: f32 = 0.95').replace('EXPOSURE_KNEE: f32 = 0.45','EXPOSURE_KNEE: f32 = 0.70')}
    globalThis.exposureTestModules++
   }
   return create.call(this,descriptor)
  }
 })
 await page.goto(`${preview.baseUrl}?devmap=1&deterministic=1&manual=1&devsize=48&devactors=16&devtod=630&weather=clear${noActorMasks?'&noactormasks=1':''}${noGroundSources?'&nogroundsources=1':''}`)
 await page.waitForFunction(()=>globalThis.steelseed,undefined,{timeout:120000,polling:100})
 // The dev snapshot (and its terrainStatic section) lands a beat after boot under load;
 // capturing before it decodes races the null deref below.
 await page.waitForFunction(()=>globalThis.steelseed?.ctx?.snapshot?.terrainStatic,undefined,{timeout:120000,polling:100})
 const result=await page.evaluate(({surfaceTest,groundTest,foliageTest})=>{
  const app=globalThis.steelseed;app.stop()
  app.renderOneFrame(0)
  // Freeze only this test producer; otherwise its next tick replaces the staged arrays.
  app.bridge=null
  const ctx=app.ctx,units=ctx.get('units'),terrain=ctx.get('terrain'),shroud=ctx.get('shroud'),render=ctx.get('render'),cam=ctx.get('camera')
  const snap=ctx.snapshot,ground=snap.terrainStatic
  ground.height.fill(0);ground.ramp.fill(0);ground.surface.fill(surfaceTest&&!groundTest?7:4);ground.resource.fill(0)
  // terrainStaticPresent rides only the one-shot tick; after any further pump the
  // flag is gone and the flag-guarded onSnapshot consumers silently skip. The
  // staged world IS the world's static, so re-assert the flag before rebaking.
  snap.flags=snap.flags|1
  terrain.onSnapshot(snap,null,ctx);units.scenery.onSnapshot(snap)
  shroud.cells.fill(2);render.setShroud(shroud.cells,ground.w,ground.h,0,0)
  const names=['weap','powr','2tnk','e1','e1','dog','t01','t02','t03','t05','t06','t07','t08','t10','t11','t12']
  if(surfaceTest)names[2]='1tnk'
  const positions=[[22,23],[26,23],[24,26],[25.4,26],[25.8,26.2],[25.6,26.7],[19,21],[21,19],[23,18.5],[26,19],[28,21],[29,23],[19,25],[20,27],[28,27],[22,28]]
  const a=snap.actors
  for(let i=0;i<a.count;i++){
   a.typeId[i]=i+3000;a.displayTypeId[i]=a.typeId[i];a.posX[i]=positions[i][0]*1024;a.posY[i]=positions[i][1]*1024;a.posZ[i]=0;a.health[i]=255;a.owner[i]=0;a.flags[i]=0
   units.typeSlot.set(a.typeId[i],names[i]);units.typeClass.set(a.typeId[i],0);units.typeVehicle.set(a.typeId[i],i===2)
   units.typeRenderable.set(a.typeId[i],true);units.typeWatercraft.set(a.typeId[i],false);units.typeWaterStructure.set(a.typeId[i],false)
  }
  if(surfaceTest){cam.height=cam.heightGoal=4.5;cam.target[2]=cam.targetGoal[2]=25.3}
  if(foliageTest){cam.height=cam.heightGoal=3.3;cam.target[2]=cam.targetGoal[2]=25.8}
  // The scenery scan is cadence-gated: with the bridge frozen the tick never
  // changes, and easing alone moves the camera less than a cell, so jump the
  // camera node once to make the staged ground (concrete vs grass) rescan.
  render.camera.position[0]=cam.targetGoal[0]+3;render.camera.position[2]=cam.targetGoal[2]+3
  units.living.spawns.length=0
  cam.height=cam.heightGoal=8.5;cam.yaw=cam.yawGoal=.35
  cam.target[0]=cam.targetGoal[0]=24;cam.target[2]=cam.targetGoal[2]=23.4
  if(surfaceTest){cam.height=cam.heightGoal=4.5;cam.target[2]=cam.targetGoal[2]=25.3}
  if(foliageTest){cam.height=cam.heightGoal=3.3;cam.target[2]=cam.targetGoal[2]=25.8}
  for(let i=1;i<=50;i++)app.renderOneFrame(i*1000/60)
  const copy=document.createElement('canvas');copy.width=ctx.canvas.width;copy.height=ctx.canvas.height;copy.getContext('2d').drawImage(ctx.canvas,0,0)
  return {png:copy.toDataURL('image/png'),stats:units.forgeStats,grass:units.sceneryStats,draws:render.stats.drawCalls,triangles:render.stats.triangles,
   materials:{tank:units.slotBuckets.get(names[2])?.surfaceSet,building:units.slotBuckets.get('powr')?.surfaceSet,vram:ctx.get('materials').totalVramBytes,ground:ctx.get('materials').groundSourceStats},
   active:names.map(name=>({name,count:units.slotBuckets.get(name)?.count??0,alphaCutout:units.slotBuckets.get(name)?.item.alphaCutout??false})),stage:'art fixture: staged terrain and visible actors, not an authoritative match'}
 },{surfaceTest,groundTest,foliageTest})
 assert.deepEqual(errors,[]);assert.ok(result.stats.available>0,'forge manifest must be present')
assert.equal(result.stats.loaded,result.stats.available,'every non-hidden authored model must load, however many the local .forge carries')
 if(surfaceTest&&!groundTest)assert.equal(result.grass.grass,0,'concrete fixture must not grow grass')
 else assert.ok(result.grass.grass>0)
 if(exposureTest){assert.ok(await page.evaluate(()=>globalThis.exposureTestModules>0));result.stage+='; DIAGNOSTIC brighter exposure shader, not shipping'}
 assert.ok(result.active.every(a=>a.count>0),`every staged asset must actually draw: ${JSON.stringify(result.active)}`)
 if(surfaceTest){assert.equal(result.materials.tank,noActorMasks?'industrial-v1':'industrial-v1:1tnk');assert.equal(result.materials.building,noActorMasks?'industrial-v1':'industrial-v1:powr')}
 if(foliageTest){assert.equal(result.materials.tank,'foliage-v1');assert.ok(result.active.find(a=>a.name==='t01')?.alphaCutout)}
 mkdirSync(out,{recursive:true});writeFileSync(join(out,`${label}.png`),Buffer.from(result.png.split(',')[1],'base64'))
 const {png,...stats}=result;writeFileSync(join(out,`${label}.json`),JSON.stringify(stats,null,2))
 console.log('artreview:',JSON.stringify(stats))
}finally{await browser?.close();await stopChild(preview.server)}
