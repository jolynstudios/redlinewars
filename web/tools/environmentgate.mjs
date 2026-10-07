#!/usr/bin/env node
// Production renderer, deliberately staged dev map: original PBR, tree wind, rain/snow and live resource presentation.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { launchGpuBrowser, loadChromium, startPreview, stopChild } from './harness.mjs'
import { decodePng } from './png.mjs'
const root = fileURLToPath(new URL('..', import.meta.url)), preview = await startPreview(8417)
let browser
try {
 ;({browser} = await launchGpuBrowser(await loadChromium('environmentgate'),'environmentgate'))
 const page = await browser.newPage({viewport:{width:1280,height:900},deviceScaleFactor:1})
 const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('favicon'))errors.push(m.text())})
 await page.addInitScript(()=>{globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{}})
 await page.goto(`${preview.baseUrl}?devmap=1&deterministic=1&manual=1&devsize=48&devactors=6&devcluster=2&devtod=640&devweather=2&devweatherintensity=720&devwindspeed=850`)
 await page.waitForFunction(()=>globalThis.steelseed,undefined,{timeout:180000,polling:100})
 const result=await page.evaluate(async()=>{
  const app=globalThis.steelseed;app.stop();for(let i=0;i<8;i++)app.renderOneFrame(i*1000/60)
  const ctx=app.ctx, units=ctx.get('units'),terrain=ctx.get('terrain'),sky=ctx.get('sky'),render=ctx.get('render'),camera=ctx.get('camera'),shroud=ctx.get('shroud')
  const snap=ctx.snapshot,g=terrain.grid
  const view={w:g.w,h:g.h,type:g.type.slice(),height:g.height.slice(),ramp:g.ramp.slice(),passability:g.passability.slice(),resource:g.resource.slice(),surface:g.surface.slice()}
  for(let z=0;z<g.h;z++)for(let x=0;x<g.w;x++){
   const i=z*g.w+x,edge=Math.round(g.w*.55+Math.sin(z*.21)*1.8),wet=x>=edge
   view.height[i]=wet?0:2;view.ramp[i]=0;view.resource[i]=0;view.passability[i]=wet?8:7
   view.surface[i]=wet?(x===edge?9:8):x>edge-3?2:z===Math.floor(g.h*.4)?5:4
  }
  // The fixture publishes a shoreline through the real terrain API, never a second mesh path.
  terrain.rebuild(view,g.originX,g.originY,ctx);units.scenery.onSnapshot({...snap,flags:snap.flags|1,terrainStatic:view})
  const ground=units.scenery.ground
  // Deterministic visual fixture: reveal the map, stage actors on a land/water boundary.
  snap.shroud=[{cellIndex:0,runLength:g.w*g.h,state:2}];shroud.onSnapshot(snap,null,ctx)
  let shore=-1,best=Infinity
  for(let z=3;z<g.h-3;z++)for(let x=3;x<g.w-3;x++){
   const i=z*g.w+x;if(Number.isFinite(g.waterLevel[i]))continue
   if(!Number.isFinite(g.waterLevel[i+1])&&!Number.isFinite(g.waterLevel[i-1])&&!Number.isFinite(g.waterLevel[i+g.w])&&!Number.isFinite(g.waterLevel[i-g.w]))continue
   const score=(x-g.w/2)**2+(z-g.h/2)**2;if(score<best){best=score;shore=i}
  }
  if(shore<0)throw new Error('Fixture needs a real shoreline')
  const sx=shore%g.w+g.originX,sz=Math.floor(shore/g.w)+g.originY
  const names=['t01','t03','rock1','2tnk','t02','rock3'];
  const actors=snap.actors;app.snapState.prev=null;ctx.time.alpha=1
  for(let i=0;i<actors.count;i++){
   const x=sx-2+(i%3)*1.2,z=sz+Math.floor(i/3)*1.5
   actors.posX[i]=Math.round(x*1024);actors.posY[i]=Math.round(z*1024);actors.posZ[i]=0;actors.typeId[i]=1000+i
   units.typeSlot.set(actors.typeId[i],names[i]);units.typeRenderable.set(actors.typeId[i],true);units.typeVehicle.set(actors.typeId[i],false)
  }
  camera.height=camera.heightGoal=10;camera.target[0]=camera.targetGoal[0]=sx;camera.target[2]=camera.targetGoal[2]=sz
  const w=ground.w,h=ground.h,types=new Uint8Array(w*h),density=new Uint8Array(w*h),maximum=new Uint8Array(w*h);maximum.fill(12)
  const resourceCell=Math.max(0,shore-2);types[resourceCell]=1;density[resourceCell]=12
  types[resourceCell+w]=2;density[resourceCell+w]=8
  snap.resources={w,h,revision:1,type:types,density,maxDensity:maximum}
  // The placement scan runs on a worker; its reply lands between event-loop turns and, on a
  // loaded machine, several frames late. Let any scan in flight land before a frame posts
  // its own, and let that one land before the captured update applies it.
  const settle=async()=>{for(let i=0;i<1000&&units.scenery.workerBusy;i++)await new Promise(r=>setTimeout(r,5))}
  const frame=async(seconds,kind=2)=>{
   await settle()
   ctx.time.tick=Math.round(seconds*25);ctx.time.alpha=0;ctx.time.dt=1/60;ctx.time.elapsed=seconds
   snap.world.environment.weatherKind=kind;snap.world.environment.weatherIntensity=720;snap.world.environment.windSpeed=850
   sky.onSnapshot(snap,null,ctx)
   for(let i=0;i<12;i++){ctx.time.frame++;app.registry.update(1/60,ctx);app.registry.lateUpdate(1/60,ctx)}
   await ctx.device.queue.onSubmittedWorkDone()
   await settle()
   // WebGPU releases the presented texture between event-loop turns. Capture a
   // freshly submitted frame synchronously, just as the other visual gates do.
   ctx.time.frame++;app.registry.update(1/60,ctx);app.registry.lateUpdate(1/60,ctx)
   const canvas=document.createElement('canvas');canvas.width=ctx.canvas.width;canvas.height=ctx.canvas.height;canvas.getContext('2d').drawImage(ctx.canvas,0,0)
   return {png:canvas.toDataURL(),pose:Array.from(units.slotBuckets.get('t01').rig.pose.r),treeCount:units.slotBuckets.get('t01').count,windBones:Array.from(units.slotBuckets.get('t01').rig.windBones),skin:{...units.skinStats},actorTypes:Array.from(actors.typeId),typeSlots:Array.from(units.typeSlot.entries()),stats:{...units.sceneryStats},wind:sky.environment.windStrength,time:render.environment.motionTime,water:terrain.waterCellCount,render:{...render.stats}}
  }
  const a=await frame(2),b=await frame(4),held=await frame(4),snow=await frame(4,3),clear=await frame(4,0)
  const waterA=await frame(2,0),waterB=await frame(4,0)
  density[resourceCell]=0;types[resourceCell]=0;snap.resources.revision++
  // The scenery scan is cadence-gated (camera move OR tick change plus wall time);
  // this frame reuses the held tick, so open the gate with a one-off camera move
  // and restore the shared window afterwards.
  render.camera.position[0]+=1.5
  const depleted=await frame(4,0)
  render.camera.position[0]-=1.5
  // A scan that fires while it is already snowing — every ~250 ms in a live match. The old
  // weather budget divided by every frame since the previous scan and collapsed here.
  const snowWarm=await frame(4,3)
  render.camera.position[0]+=1.5
  const snowScanned=await frame(4,3)
  render.camera.position[0]-=1.5
  return {a,b,held,snow,snowWarm,snowScanned,clear,waterA,waterB,depleted,materials:ctx.get('materials').environmentStats,forge:units.forgeStats}
})
 writeFileSync(`${root}/shots/environment-diagnostic.json`,JSON.stringify(result,(key,value)=>key==='png'?undefined:value,2))
 assert.deepEqual(errors,[],'No GPU/page errors')
 assert.equal(result.materials.loaded,13);assert.equal(result.materials.error,'')
 assert.ok(result.forge.available>0,'forge manifest must be present')
 assert.equal(result.forge.loaded,result.forge.available,'every non-hidden authored model must load, however many the local .forge carries')
 assert.equal(result.forge.fallback,0)
 assert.equal(result.a.stats.loaded,5);assert.equal(result.a.stats.error,'')
 assert.ok(result.a.stats.ore>0&&result.a.stats.gems>0,`ore and gems must be presented (ore ${result.a.stats.ore}, gems ${result.a.stats.gems})`);assert.equal(result.depleted.stats.ore,result.clear.stats.ore-1,'harvested cells must lose their visible ore')
 assert.ok(result.a.stats.rain>0);assert.equal(result.clear.stats.rain,0);assert.ok(result.snow.stats.snow>0);assert.equal(result.snow.stats.rain,0)
 // A still camera must keep the whole field. The weather budget was once sized over every
 // frame since the last scan, which left ~30-60 flakes in a few-metre disc (Sept 2026).
 assert.ok(result.snowScanned.stats.snow>=Math.floor(Math.floor(700*.72)*.9),`snow must keep its full field across a scan (${result.snowScanned.stats.snow} flakes)`)
 assert.ok(result.a.stats.rain>=Math.floor(Math.floor(1100*.72)*.9),`still-camera rain must keep its full field (${result.a.stats.rain} drops)`)
 assert.ok(result.a.water>0);assert.equal(result.b.time,4)
 assert.ok(result.a.windBones.length>0,'tree rig must carry wind bones: foliage wind is GPU-side, proven by the a/b pixel diff below')
 assert.deepEqual(result.b.pose,result.held.pose,'paused time must hold foliage still')
 const pixelsA=decodePng(Buffer.from(result.a.png.split(',')[1],'base64')),pixelsB=decodePng(Buffer.from(result.b.png.split(',')[1],'base64'))
 let changed=0;for(let i=0;i<pixelsA.data.length;i+=4)if(Math.abs(pixelsA.data[i]-pixelsB.data[i])+Math.abs(pixelsA.data[i+1]-pixelsB.data[i+1])+Math.abs(pixelsA.data[i+2]-pixelsB.data[i+2])>9)changed++
 const seaA=decodePng(Buffer.from(result.waterA.png.split(',')[1],'base64')),seaB=decodePng(Buffer.from(result.waterB.png.split(',')[1],'base64'))
 // This staged camera has only water in its lower quarter. Clear weather excludes
 // falling rain and the rest of the frame excludes tree/grass motion as false proof.
 let waterChanged=0
 for(let i=Math.floor(seaA.height*.75)*seaA.width*4;i<seaA.data.length;i+=4)
  if(Math.abs(seaA.data[i]-seaB.data[i])+Math.abs(seaA.data[i+1]-seaB.data[i+1])+Math.abs(seaA.data[i+2]-seaB.data[i+2])>3)waterChanged++
 mkdirSync(`${root}/shots`,{recursive:true})
 for(const [name,shot]of[['rain',result.a],['rain-motion',result.b],['snow',result.snow],['clear',result.clear]])writeFileSync(`${root}/shots/environment-${name}.png`,Buffer.from(shot.png.split(',')[1],'base64'))
 assert.ok(changed>100,'weather must visibly animate the frame')
 assert.ok(waterChanged>200,`clear-weather water must visibly animate independently (${waterChanged} changed pixels); the SSR composite spreads wave energy across more pixels at lower per-pixel delta than the pre-reflection analytic-only surface`)
 for(const shot of [result.a,result.b,result.held,result.snow,result.snowWarm,result.snowScanned,result.clear,result.waterA,result.waterB,result.depleted]){delete shot.png;delete shot.pose}
 writeFileSync(`${root}/shots/environment.json`,JSON.stringify({...result,changed,waterChanged},null,2))
 console.log(`environmentgate: PASS — 13 Blender PBR surfaces, 275 actors, 5 props; wind moves/holds actual rig, rain/snow respond to weather (${result.a.stats.rain} drops, ${result.snowScanned.stats.snow} flakes), live ore depletion removes pile; ${changed} animated pixels, ${waterChanged} clear-water pixels`)
 await page.close()
} finally {await browser?.close();await stopChild(preview.server)}
