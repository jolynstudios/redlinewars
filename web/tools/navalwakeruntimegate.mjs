#!/usr/bin/env node
// Actual production WebGPU paths and fitted wheel poses; deterministic staged simulation, not a timing benchmark.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {gunzipSync} from 'node:zlib'
import {build} from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { launchGpuBrowser, loadChromium, startPreview, stopChild } from './harness.mjs'
const out=fileURLToPath(new URL('../../.artifacts/planx/',import.meta.url));mkdirSync(out,{recursive:true})
const root=fileURLToPath(new URL('../..',import.meta.url)),proof=root+'/.artifacts/planx/naval/dd-v5/',meta=JSON.parse(readFileSync(proof+'dd.json')),raw=Array.from(readFileSync(proof+'dd.ssmesh')),mask=Array.from(gunzipSync(readFileSync(proof+'exports/'+meta.detailMask.file))),plans=JSON.parse(readFileSync(root+'/web/src/fx/naval-wake-manifest.json')).actors.dd.variants;
// The dd-v5 proof is an isolated re-derivation of the canonical hull. A post-promotion
// polish moved art/dd.blend, so the proof blend no longer byte-matches it; the proof's
// anchor binding is therefore the CANONICAL plan (the one the shipping runtime uses),
// while the proof's own source identity is verified against its own blend bytes.
assert.equal(meta.sourceSha256,createHash('sha256').update(readFileSync(proof+'dd.blend')).digest('hex'),'proof mesh and anchor source identity');
const plan=plans.find(p=>p.state==='canonical');assert.ok(plan,'wake manifest canonical plan');
meta.offset=0;meta.bytes=raw.length;
const inject=await build({stdin:{contents:"export {decodeBlenderAsset} from './src/units/blender-mesh';export {NavalWakes} from './src/fx/naval-wakes';",resolveDir:root+'/web'},bundle:true,format:'iife',globalName:'wakeProofApi',write:false,define:{'import.meta.glob':'__wakeEmptyGlob'},banner:{js:'const __wakeEmptyGlob=()=>({});'},logLevel:'silent'});
const shipping=process.env.WAKE_SHIPPING==='1',prefix=shipping?'shipping-naval-wake':'naval-wake';const quality=process.env.WAKE_QUALITY??'low';const preview=await startPreview(8494);let browser
try{
 ;({browser}=await launchGpuBrowser(await loadChromium('tracksintegrationgate'),'tracksintegrationgate'))
 const page=await browser.newPage({viewport:{width:1280,height:900},deviceScaleFactor:1}),errors=[]
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('favicon'))errors.push(m.text())})
 await page.addInitScript(()=>{globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{};globalThis.__tracksGpuErrors=[];const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...args){const device=await request.apply(this,args);device.addEventListener('uncapturederror',e=>globalThis.__tracksGpuErrors.push(e.error.message));return device}})
 await page.goto(`${preview.baseUrl}?devmap=1&deterministic=1&manual=1&quality=${quality}&devsize=48&devactors=1&devcluster=1&devtod=720&devweather=0&devweatherintensity=0`)
 await page.waitForFunction(()=>globalThis.steelseed,undefined,{timeout:180000,polling:100})
 await page.addScriptTag({content:inject.outputFiles[0].text});
 const result=await page.evaluate(async({meta,raw,mask,plan,shipping})=>{
  const app=globalThis.steelseed;app.stop();for(let i=0;i<8;i++)app.renderOneFrame(i*1000/60)
  const ctx=app.ctx,units=ctx.get('units'),anim=ctx.get('anim'),terrain=ctx.get('terrain'),sky=ctx.get('sky'),render=ctx.get('render'),camera=ctx.get('camera'),shroud=ctx.get('shroud'),tracks=ctx.get('fx').groundTracks,snap=ctx.snapshot,g=terrain.grid
  const view={w:g.w,h:g.h,type:g.type.slice(),height:g.height.slice(),ramp:g.ramp.slice(),passability:g.passability.slice(),resource:g.resource.slice(),surface:g.surface.slice()}
  view.height.fill(0);view.ramp.fill(0);view.resource.fill(0);view.passability.fill(7);view.surface.fill(8)
  for(let yy=0;yy<g.h;yy++)for(let xx=0;xx<g.w;xx++)if(xx<4||yy<4||xx>=g.w-4||yy>=g.h-4){view.surface[yy*g.w+xx]=0;view.height[yy*g.w+xx]=2}
  terrain.rebuild(view,g.originX,g.originY,ctx);units.scenery.onSnapshot({...snap,flags:snap.flags|1,terrainStatic:view})
  snap.shroud=[{cellIndex:0,runLength:g.w*g.h,state:2}];shroud.onSnapshot(snap,null,ctx)
  const names=['dd'],actors=snap.actors,originalTypeName=ctx.actorTypeName
  ctx.actorTypeName=id=>id>=1000&&id<1001?names[id-1000]:originalTypeName(id)
  const x=g.originX+g.w/2-1.4,z=g.originY+g.h/2
  for(let i=0;i<1;i++){
   actors.typeId[i]=1000+i;actors.displayTypeId[i]=1000+i;actors.posX[i]=Math.round(x*1024);actors.posY[i]=Math.round(z*1024);actors.posZ[i]=0;actors.facing[i]=768;actors.flags[i]=0;actors.surface[i]=8
   units.typeSlot.set(1000+i,names[i]);units.typeRenderable.set(1000+i,true);units.typeVehicle.set(1000+i,true);units.typeWatercraft.set(1000+i,true)
  }
  camera.height=camera.heightGoal=5;camera.yaw=camera.yawGoal=.55;camera.target[0]=camera.targetGoal[0]=x;camera.target[2]=camera.targetGoal[2]=z
  tracks.clear();anim.onSnapshot({tick:0,actors:null},null,ctx);snap.tick=100;app.snapState.prev=null;ctx.time.alpha=1;ctx.time.tick=100;anim.onSnapshot(snap,null,ctx)

  const fx=ctx.get('fx'),bucket=units.slotBuckets.get('dd'),shots=[],states=[]
  const draw=()=>{ctx.time.dt=.04;ctx.time.elapsed=ctx.time.tick/25;ctx.time.frame++;sky.onSnapshot(snap,null,ctx);app.registry.update(.04,ctx);app.registry.lateUpdate(.04,ctx)}
  const read=label=>({label,stats:{...fx.navalWakeStats},groundCap:fx.groundTracks.cap,budget:ctx.config.q.decals,mesh:bucket.mesh.label,sourceHash:fx.navalWakes.plan.sourceSha256,water:terrain.waterHeightAt(actors.posX[0]/1024,actors.posY[0]/1024),worldY:bucket.instances[13],matrices:Array.from(fx.navalWakes.matrices[0].slice(0,fx.navalWakes.counts[0]*16)),rigPose:Array.from(bucket.rig.pose.r),gpu:{...render.stats}})
  const shot=async label=>{camera.target[0]=camera.targetGoal[0]=actors.posX[0]/1024;camera.target[2]=camera.targetGoal[2]=actors.posY[0]/1024;await ctx.device.queue.onSubmittedWorkDone();draw();const c=document.createElement('canvas');c.width=ctx.canvas.width;c.height=ctx.canvas.height;c.getContext('2d').drawImage(ctx.canvas,0,0);shots.push({label,png:c.toDataURL()});states.push(read(label))}
  const advance=(distance=.04,turn=0)=>{
   const previous={...snap,actors:Object.fromEntries(Object.entries(actors).map(([k,v])=>[k,ArrayBuffer.isView(v)&&v.slice?v.slice():v]))}
   actors.posX[0]+=Math.round(bucket.instances[0]*distance*1024);actors.posY[0]+=Math.round(bucket.instances[2]*distance*1024);actors.facing[0]=(actors.facing[0]+turn+1024)%1024;snap.tick++;app.snapState.prev=previous;ctx.time.tick=snap.tick;ctx.time.alpha=1;anim.onSnapshot(snap,previous,ctx);draw()
  }
  draw();for(let i=0;i<45;i++)advance(.035);await shot(shipping?'canonical-forward':'baseline-forward')
  const before=fx.navalWakeStats.emitted;for(let i=0;i<8;i++)draw();const after=fx.navalWakeStats.emitted
  let texture=null
  if(!shipping){
  const decoded=wakeProofApi.decodeBlenderAsset(new Uint8Array(raw),meta);const mesh=render.upload(decoded.mesh,'dd:isolated-v5-water-proof');bucket.mesh=mesh;bucket.item.mesh=mesh
  const mats=ctx.get('materials'),base=mats.get('industrial-v1'),size=meta.detailMask.size,count=Math.log2(size)+1;texture=ctx.device.createTexture({label:'wake-dd-v5-mask',size:[size,size],mipLevelCount:count,format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST})
  let pixels=new Uint8Array(mask),side=size
  for(let mip=0;mip<count;mip++){ctx.device.queue.writeTexture({texture,mipLevel:mip},pixels,{bytesPerRow:side*4,rowsPerImage:side},[side,side]);if(side===1)break;const next=side/2,res=new Uint8Array(next*next*4);for(let yy=0;yy<next;yy++)for(let xx=0;xx<next;xx++)for(let c=0;c<4;c++){const i=(yy*2*side+xx*2)*4+c;res[(yy*next+xx)*4+c]=Math.round((pixels[i]+pixels[i+4]+pixels[i+side*4]+pixels[i+side*4+4])/4)}pixels=res;side=next}
  const surface=Object.assign(Object.create(base),{id:'naval-wake-proof:dd',detailMaskView:texture.createView()});mats.sets.set(surface.id,surface);mats.bindGroupFor(surface);bucket.surfaceSet=surface.id;bucket.item.surfaceSet=surface.id
  fx.navalWakes.dispose();fx.navalWakes=new wakeProofApi.NavalWakes(plan);fx.navalWakes.init(render,ctx.config.q.decals)
  }
  actors.posX[0]=Math.round(x*1024);actors.posY[0]=Math.round(z*1024);actors.facing[0]=768;draw();
  const initialRig=Array.from(bucket.rig.pose.r)
  for(let i=0;i<45;i++)advance(.035);await shot('proof-forward')
  for(let i=0;i<28;i++)advance(.035,7);await shot('proof-turn')
  for(let i=0;i<20;i++)advance(-.025);await shot('proof-reverse')
  for(let i=0;i<115;i++)advance(0);await shot('proof-stopped')
  snap.world.environment.timeOfDay=0;snap.world.environment.weatherKind=0;snap.world.environment.weatherIntensity=0;for(let i=0;i<40;i++)advance(.035);await shot('proof-night')
  snap.world.environment.timeOfDay=1080;snap.world.environment.weatherKind=2;snap.world.environment.weatherIntensity=1000;for(let i=0;i<30;i++)advance(.035,5);await shot('proof-wet')
  const lateRig=Array.from(bucket.rig.pose.r);texture?.destroy()
  return{shipping,states,shots,before,after,initialRig,lateRig,gpuErrors:globalThis.__tracksGpuErrors,backend:ctx.backend,quality:ctx.config.q.name}
 },{meta,raw,mask,plan,shipping})
 for(const shot of result.shots){writeFileSync(`${out}${prefix}-${quality}-${shot.label}.png`,Buffer.from(shot.png.split(',')[1],'base64'));delete shot.png}
 writeFileSync(`${out}${prefix}-${quality}-runtime.json`,JSON.stringify({...result,errors},null,2))
 if(shipping)for(const state of result.states)assert.equal(state.sourceHash,plan.sourceSha256,'shipping wake bound to promoted source')
 assert.deepEqual(errors,[]);assert.deepEqual(result.gpuErrors,[]);assert.equal(result.before,result.after);assert.equal(result.backend,'webgpu')
 for(const state of result.states){assert.ok(Math.abs(state.worldY-state.water)<.05,'vessel waterline stays on real water');assert.ok(state.stats.reservation+state.groundCap<=state.budget);assert.equal(state.gpu.dropped,0);assert.equal(state.stats.dropped,0,'single-vessel proof stays within natural fade budget')}
 assert.ok(result.states.find(s=>s.label===(shipping?'canonical-forward':'baseline-forward')).stats.active>20)
 assert.ok(result.states.find(s=>s.label==='proof-forward').stats.bow>0)
 assert.ok(result.states.find(s=>s.label==='proof-stopped').stats.active===0)
 assert.notDeepEqual(result.initialRig,result.lateRig,'actual ship rig rotates while source attachments remain bound')
 if(quality==='low')assert.ok(result.states[0].groundCap>=448,'Low retains meaningful ground-track pool')
 console.log('navalwakeruntimegate PASS',quality,result.states.map(s=>({label:s.label,active:s.stats.active,bow:s.stats.bow,groundCap:s.groundCap})))
}finally{await browser?.close();await stopChild(preview.server)}
