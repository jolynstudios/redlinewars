#!/usr/bin/env node
// Actual production WebGPU paths and fitted wheel poses; deterministic staged simulation, not a timing benchmark.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { launchGpuBrowser, loadChromium, startPreview, stopChild } from './harness.mjs'
const quality=process.env.TRACK_QUALITY??'ultra'
const out=fileURLToPath(new URL('../../.artifacts/planx/',import.meta.url))+(process.env.TRACK_QUALITY?`tracks-${quality}/`:'');mkdirSync(out,{recursive:true})
const preview=await startPreview(8485);let browser
try{
 ;({browser}=await launchGpuBrowser(await loadChromium('tracksintegrationgate'),'tracksintegrationgate'))
 const page=await browser.newPage({viewport:{width:1280,height:900},deviceScaleFactor:1}),errors=[]
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('favicon'))errors.push(m.text())})
 await page.addInitScript(()=>{globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{};globalThis.__tracksGpuErrors=[];const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...args){const device=await request.apply(this,args);device.addEventListener('uncapturederror',e=>globalThis.__tracksGpuErrors.push(e.error.message));return device}})
 await page.goto(`${preview.baseUrl}?devmap=1&deterministic=1&manual=1&quality=${quality}&devsize=48&devactors=3&devcluster=1&devtod=720&devweather=0&devweatherintensity=0`)
 await page.waitForFunction(()=>globalThis.steelseed,undefined,{timeout:180000,polling:100})
 const result=await page.evaluate(async()=>{
  const app=globalThis.steelseed;app.stop();for(let i=0;i<8;i++)app.renderOneFrame(i*1000/60)
  const ctx=app.ctx,units=ctx.get('units'),anim=ctx.get('anim'),terrain=ctx.get('terrain'),sky=ctx.get('sky'),render=ctx.get('render'),camera=ctx.get('camera'),shroud=ctx.get('shroud'),tracks=ctx.get('fx').groundTracks,snap=ctx.snapshot,g=terrain.grid
  const view={w:g.w,h:g.h,type:g.type.slice(),height:g.height.slice(),ramp:g.ramp.slice(),passability:g.passability.slice(),resource:g.resource.slice(),surface:g.surface.slice()}
  view.height.fill(2);view.ramp.fill(0);view.resource.fill(0);view.passability.fill(7);view.surface.fill(4)
  terrain.rebuild(view,g.originX,g.originY,ctx);units.scenery.onSnapshot({...snap,flags:snap.flags|1,terrainStatic:view})
  snap.shroud=[{cellIndex:0,runLength:g.w*g.h,state:2}];shroud.onSnapshot(snap,null,ctx)
  const names=['1tnk','4tnk','jeep'],actors=snap.actors,originalTypeName=ctx.actorTypeName
  ctx.actorTypeName=id=>id>=1000&&id<1003?names[id-1000]:originalTypeName(id)
  const x=g.originX+g.w/2-1.4,z=g.originY+g.h/2
  for(let i=0;i<3;i++){
   actors.typeId[i]=1000+i;actors.displayTypeId[i]=1000+i;actors.posX[i]=Math.round(x*1024);actors.posY[i]=Math.round((z+(i-1)*1.2)*1024);actors.posZ[i]=0;actors.facing[i]=768;actors.flags[i]=0;actors.surface[i]=4
   units.typeSlot.set(1000+i,names[i]);units.typeRenderable.set(1000+i,true);units.typeVehicle.set(1000+i,true)
  }
  camera.height=camera.heightGoal=5;camera.target[0]=camera.targetGoal[0]=x+.8;camera.target[2]=camera.targetGoal[2]=z
  tracks.clear();anim.onSnapshot({tick:0,actors:null},null,ctx);snap.tick=100;app.snapState.prev=null;ctx.time.alpha=1;ctx.time.tick=100;anim.onSnapshot(snap,null,ctx)
  const read=()=>({surface:{wetness:sky.environment.surfaceWetness,snowCoverage:sky.environment.snowCoverage},stats:{...tracks.stats},profiles:names.map(n=>({name:n,...units.runningGearOf(n)})),vehicles:names.map((name,i)=>{
   const b=units.slotBuckets.get(name),rig=b.rig,p=units.runningGearOf(name),id=actors.id[i]
   return {name,count:b.count,packed:b.phases?.[0],left:anim.sideDistanceOf(id,p.leftZ,ctx.time.alpha),right:anim.sideDistanceOf(id,p.rightZ,ctx.time.alpha),wheels:Array.from(rig.wheelBones,(bone,j)=>({bone,radius:rig.wheelRadii[j],lateral:rig.skeleton.bindT[bone*3+2]*p.fitScale,travel:anim.sideDistanceOf(id,rig.skeleton.bindT[bone*3+2]*p.fitScale,ctx.time.alpha),quat:Array.from(rig.pose.r.slice(bone*4,bone*4+4))}))}
  }),marks:Array.from(tracks.active,(v,i)=>v?{x:tracks.x[i],z:tracks.z[i],width:tracks.width[i],depth:tracks.depth[i],group:tracks.group[i]}:null).filter(Boolean),render:{...render.stats}})
  const draw=()=>{ctx.time.dt=.04;ctx.time.elapsed=ctx.time.tick/25;ctx.time.frame++;sky.onSnapshot(snap,null,ctx);app.registry.update(.04,ctx);app.registry.lateUpdate(.04,ctx)}
  const advance=(dx,turn=0)=>{
   const before={...snap,actors:Object.fromEntries(Object.entries(actors).map(([k,v])=>[k,ArrayBuffer.isView(v)&&v.slice?v.slice():v]))}
   for(let i=0;i<3;i++){actors.posX[i]+=Math.round(dx*1024);actors.facing[i]=(actors.facing[i]+turn+1024)%1024}
   snap.tick++;app.snapState.prev=before;ctx.time.tick=snap.tick;ctx.time.alpha=1;anim.onSnapshot(snap,before,ctx);draw()
  }
  const shot=async label=>{
   for(let i=0;i<5;i++)draw();await ctx.device.queue.onSubmittedWorkDone();draw()
   const canvas=document.createElement('canvas');canvas.width=ctx.canvas.width;canvas.height=ctx.canvas.height;canvas.getContext('2d').drawImage(ctx.canvas,0,0)
   return {label,...read(),png:canvas.toDataURL()}
  }
  draw();const start=read();advance(.02);const contactSign=read()
  for(let i=0;i<45;i++)advance(.04)
  const forward=await shot('tracks-forward')
  for(let i=0;i<15;i++)advance(-.04)
  const reverse=await shot('tracks-reverse')
  for(let i=0;i<16;i++)advance(0,16)
  const pivot=await shot('tracks-pivot')
  const pausedBefore=read();for(let i=0;i<15;i++)draw();const pausedAfter=read()
  // Teleport resets stamp history, then stand still beyond every mark's lifetime.
  advance(12);const teleport=read();ctx.time.tick+=300;snap.tick=ctx.time.tick;app.snapState.prev=null;anim.onSnapshot(snap,null,ctx);draw();const faded=read()
  const surfaceShot=async(kind,label)=>{
   tracks.clear();anim.onSnapshot({tick:0,actors:null},null,ctx)
   for(let i=0;i<3;i++){actors.posX[i]=Math.round(x*1024);actors.facing[i]=768}
   snap.tick+=200;ctx.time.tick=snap.tick;app.snapState.prev=null;snap.world.environment.weatherKind=kind;snap.world.environment.weatherIntensity=1000
   anim.onSnapshot(snap,null,ctx);draw()
   for(let i=0;i<22;i++)advance(.07)
   return shot(label)
  }
  const wet=await surfaceShot(2,'tracks-wet'),snow=await surfaceShot(3,'tracks-snow')
  return {start,contactSign,forward,reverse,pivot,pausedBefore,pausedAfter,teleport,faded,wet,snow,gpuErrors:globalThis.__tracksGpuErrors,requestedQuality:ctx.config.q.name,forge:units.forgeStats}
 })
 for(const label of ['forward','reverse','pivot','wet','snow']){const shot=result[label];writeFileSync(`${out}${shot.label}.png`,Buffer.from(shot.png.split(',')[1],'base64'));delete shot.png}
 writeFileSync(`${out}tracks-browser-witness.json`,JSON.stringify({...result,errors,note:'Production built renderer and Units wheel poses. Three staged actors advance deterministic snapshot ticks; this is a functional WebGPU witness, not frame-time performance evidence.'},null,2))
 assert.deepEqual(errors,[]);assert.deepEqual(result.gpuErrors,[])
 for(const state of [result.contactSign,result.forward,result.reverse,result.pivot]){
  for(const v of state.vehicles){assert.equal(v.count,1);for(const wheel of v.wheels){const angle=-wheel.travel/wheel.radius;assert.ok(Math.abs(Math.abs(wheel.quat[2]*Math.sin(angle/2)+wheel.quat[3]*Math.cos(angle/2))-1)<1e-5,`${v.name} real wheel quaternion matches signed side travel`)}}
 }
 const jeep=result.contactSign.vehicles[2];assert.ok(jeep.wheels.length>0);assert.ok(jeep.wheels.every(w=>w.travel>0&&2*w.quat[2]*w.quat[3]<0),'forward hull gives backward bottom-contact wheel velocity')
 assert.equal(result.forward.vehicles[2].packed,0,'rigged tyres do not also UV scroll')
 assert.ok(result.forward.stats.active>20);assert.ok(result.forward.stats.dropped===0)
 assert.ok(result.reverse.vehicles[0].left<result.forward.vehicles[0].left)
 for(let i=0;i<3;i++){const a=result.reverse.vehicles[i],b=result.pivot.vehicles[i];assert.ok((b.left-a.left)*(b.right-a.right)<0,'pivot moves sides oppositely')}
 assert.equal(result.pausedAfter.stats.stamped,result.pausedBefore.stats.stamped)
 assert.equal(result.teleport.stats.stamped,result.pausedAfter.stats.stamped)
 assert.equal(result.faded.stats.active,0)
 assert.ok(result.wet.surface.wetness>.8&&result.wet.marks.every(m=>m.group===0||m.group===3))
 assert.ok(result.snow.surface.snowCoverage>.5&&result.snow.marks.every(m=>m.group===2||m.group===5),'real accumulated sky snow selects snow material marks')
 assert.ok(Math.max(...result.wet.marks.map(m=>m.depth))>Math.max(...result.forward.marks.map(m=>m.depth)))
 assert.ok(result.forward.profiles[1].width>result.forward.profiles[0].width&&result.forward.profiles[0].width>result.forward.profiles[2].width)
 console.log(`tracksintegrationgate: PASS — real WebGPU forward/reverse/pivot frames, 3 fitted vehicles, signed wheel contact, no duplicate tyre scroll, ${result.forward.stats.active} grounded marks, pause/teleport/fade, no GPU errors`)
}finally{await browser?.close();await stopChild(preview.server)}
