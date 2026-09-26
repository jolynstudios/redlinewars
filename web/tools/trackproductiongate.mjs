#!/usr/bin/env node
// Actual production WebGPU paths and fitted wheel poses; deterministic staged simulation, not a timing benchmark.
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import DESCRIPTOR from '../src/core/track-loops.json' with {type:'json'}
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { launchGpuBrowser, loadChromium, startPreview, stopChild } from './harness.mjs'
const out=fileURLToPath(new URL('../../.artifacts/planx/',import.meta.url));mkdirSync(out,{recursive:true})
const bundled=await build({stdin:{contents:"export * from './src/render/track-deform';export * from './src/core/track-loop'",resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,format:'esm',write:false,logLevel:'silent'});writeFileSync(`${out}track-runtime-bundle.mjs`,bundled.outputFiles[0].text);const api=await import('../../.artifacts/planx/track-runtime-bundle.mjs');
const computeCode=`struct Instance{model:mat4x4<f32>,tint:vec4<f32>,misc:vec4<f32>}
@group(0)@binding(0)var<storage,read>instances:array<Instance>;
@group(0)@binding(1)var<storage,read>bones:array<mat4x4<f32>>;
@group(0)@binding(2)var<storage,read>previousInstances:array<Instance>;
@group(0)@binding(3)var<storage,read>previousBones:array<mat4x4<f32>>;
@group(0)@binding(4)var<storage,read_write>output:array<vec4<f32>>;
@group(0)@binding(5)var<uniform>which:vec4<u32>;
${api.TRACK_DEFORM_WGSL}${api.TRACK_PREVIOUS_WGSL}
@compute @workgroup_size(1)fn main(@builtin(global_invocation_id)id:vec3<u32>){let p=vec3<f32>(-.5,.016,select(-.3352,.3352,id.x==1u));let zone=vec4<u32>(2,0,0,3);let inst=instances[which.x];let prior=previousInstances[which.x];output[id.x*2u]=vec4<f32>(authoredTrackPosition(p,zone,inst.misc.z),1);output[id.x*2u+1u]=vec4<f32>(previousTrackPosition(p,zone,inst,prior),1);}`;
const preview=await startPreview(8493);let browser
try{
 ;({browser}=await launchGpuBrowser(await loadChromium('tracksintegrationgate'),'tracksintegrationgate'))
 const page=await browser.newPage({viewport:{width:1280,height:900},deviceScaleFactor:1}),errors=[]
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('favicon'))errors.push(m.text())})
 await page.addInitScript(()=>{globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{};globalThis.__tracksGpuErrors=[];const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...args){const device=await request.apply(this,args);device.addEventListener('uncapturederror',e=>globalThis.__tracksGpuErrors.push(e.error.message));return device}})
 await page.goto(`${preview.baseUrl}?devmap=1&deterministic=1&manual=1&quality=ultra&devsize=48&devactors=1&devcluster=1&devtod=720&devweather=0&devweatherintensity=0`)
 await page.waitForFunction(()=>globalThis.steelseed,undefined,{timeout:180000,polling:100})
 const result=await page.evaluate(async({computeCode,descriptor})=>{
  const app=globalThis.steelseed;app.stop();for(let i=0;i<8;i++)app.renderOneFrame(i*1000/60)
  const ctx=app.ctx,units=ctx.get('units'),anim=ctx.get('anim'),terrain=ctx.get('terrain'),sky=ctx.get('sky'),render=ctx.get('render'),camera=ctx.get('camera'),shroud=ctx.get('shroud'),tracks=ctx.get('fx').groundTracks,snap=ctx.snapshot,g=terrain.grid
  const view={w:g.w,h:g.h,type:g.type.slice(),height:g.height.slice(),ramp:g.ramp.slice(),passability:g.passability.slice(),resource:g.resource.slice(),surface:g.surface.slice()}
  view.height.fill(2);view.ramp.fill(0);view.resource.fill(0);view.passability.fill(7);view.surface.fill(4)
  terrain.rebuild(view,g.originX,g.originY,ctx);units.scenery.onSnapshot({...snap,flags:snap.flags|1,terrainStatic:view})
  snap.shroud=[{cellIndex:0,runLength:g.w*g.h,state:2}];shroud.onSnapshot(snap,null,ctx)
  const names=['1tnk'],actors=snap.actors,originalTypeName=ctx.actorTypeName
  ctx.actorTypeName=id=>id>=1000&&id<1001?names[id-1000]:originalTypeName(id)
  const x=g.originX+g.w/2-1.4,z=g.originY+g.h/2
  for(let i=0;i<1;i++){
   actors.typeId[i]=1000+i;actors.displayTypeId[i]=1000+i;actors.posX[i]=Math.round(x*1024);actors.posY[i]=Math.round(z*1024);actors.posZ[i]=0;actors.facing[i]=768;actors.flags[i]=0;actors.surface[i]=4
   units.typeSlot.set(1000+i,names[i]);units.typeRenderable.set(1000+i,true);units.typeVehicle.set(1000+i,true)
  }
  camera.height=camera.heightGoal=3.5;camera.yaw=camera.yawGoal=.7;camera.tilt=camera.tiltGoal=-.3;camera.target[0]=camera.targetGoal[0]=x;camera.target[2]=camera.targetGoal[2]=z
  tracks.clear();anim.onSnapshot({tick:0,actors:null},null,ctx);snap.tick=100;app.snapState.prev=null;ctx.time.alpha=1;ctx.time.tick=100;anim.onSnapshot(snap,null,ctx)

  const bucket=units.slotBuckets.get('1tnk'),profile=units.runningGearOf('1tnk'),device=ctx.device,rows=[],shots=[]
  let submitted=-1;const originalSubmit=render.submit.bind(render);render.submit=item=>{if(item.mesh===bucket.mesh)submitted=render.itemCount;originalSubmit(item)}
  const module=device.createShaderModule({code:computeCode}),compile=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message)
  if(compile.length)throw new Error(compile.join(';'))
  const compute=device.createComputePipeline({layout:'auto',compute:{module,entryPoint:'main'}})
  const output=device.createBuffer({size:64,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),readback=device.createBuffer({size:64,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),which=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})
  const group=device.createBindGroup({layout:compute.getBindGroupLayout(0),entries:[render.instanceBuffer,render.boneBuffer,render.previousInstanceBuffer,render.previousBoneBuffer,output,which].map((buffer,binding)=>({binding,resource:{buffer}}))})
  const travel=()=>[-1,1].map(side=>anim.sideDistanceOf(actors.id[0],side*descriptor.sideZ,ctx.time.alpha))
  const draw=()=>{ctx.time.dt=.04;ctx.time.elapsed=ctx.time.tick/25;ctx.time.frame++;sky.onSnapshot(snap,null,ctx);app.registry.update(.04,ctx);app.registry.lateUpdate(.04,ctx)}
  draw();let last=travel()
  const witness=async(label)=>{
   const item=submitted
   if(item<0)throw new Error('1tnk is not submitted')
   const counts=Array.from(render.itemMainCount.slice(item*3,item*3+3)),lod=counts.findIndex(c=>c>0),iid=render.itemMainBase[item*3+lod]
   device.queue.writeBuffer(which,0,new Uint32Array([iid,0,0,0]));const enc=device.createCommandEncoder(),pass=enc.beginComputePass();pass.setPipeline(compute);pass.setBindGroup(0,group);pass.dispatchWorkgroups(2);pass.end();enc.copyBufferToBuffer(output,0,readback,0,64);device.queue.submit([enc.finish()]);await readback.mapAsync(GPUMapMode.READ);const data=Array.from(new Float32Array(readback.getMappedRange().slice(0)));readback.unmap()
   const now=travel(),packed=render.instanceData[iid*24+22];rows.push({label,lod,counts,packed,now,previous:last,data,fit:profile.fitScale,triangles:bucket.mesh.lods[lod].indexCount/3,alpha:ctx.time.alpha});last=now
  }
  const advance=async(dx,turn,label,alphas=[1])=>{
   const before={...snap,actors:Object.fromEntries(Object.entries(actors).map(([k,v])=>[k,ArrayBuffer.isView(v)&&v.slice?v.slice():v]))}
   actors.posX[0]+=Math.round(dx*1024);actors.facing[0]=(actors.facing[0]+turn+1024)%1024;snap.tick++;app.snapState.prev=before;ctx.time.tick=snap.tick;anim.onSnapshot(snap,before,ctx)
   for(const alpha of alphas){ctx.time.alpha=alpha;draw();await witness(label)}
  }
  const shot=async label=>{await device.queue.onSubmittedWorkDone();draw();const canvas=document.createElement('canvas');canvas.width=ctx.canvas.width;canvas.height=ctx.canvas.height;canvas.getContext('2d').drawImage(ctx.canvas,0,0);shots.push({label,png:canvas.toDataURL()})}
  await witness('rest');await shot('rest')
  for(let i=0;i<6;i++)await advance(.04,0,'forward-interpolated',[.25,.5,.75,1]);await shot('forward')
  for(let i=0;i<4;i++)await advance(-.04,0,'reverse-interpolated',[.25,.5,.75,1]);await shot('reverse')
  for(let i=0;i<4;i++)await advance(0,16,'pivot-interpolated',[.25,.5,.75,1]);await shot('pivot')
  await advance(.12,0,'slow-frame');await advance(.30,0,'ambiguous-frame');await shot('slow')
  for(const height of [10,18,28,18,10,3.5]){camera.height=camera.heightGoal=height;camera.target[0]=camera.targetGoal[0]=actors.posX[0]/1024;draw();await witness('lod-transition');await shot('lod-'+height)}
  for(let i=0;i<3;i++){draw();await witness('paused')}
  bucket.item.alphaCutout=true;await advance(.02,0,'cutout');await shot('cutout');bucket.item.alphaCutout=false
  return {rows,shots,compile,gpuErrors:globalThis.__tracksGpuErrors,forge:units.forgeStats,fit:profile.fitScale,mesh:bucket.mesh.label,descriptor,alphaCutout:bucket.item.alphaCutout}
 },{computeCode,descriptor:DESCRIPTOR})
 for(const shot of result.shots){writeFileSync(`${out}production-track-${shot.label}.png`,Buffer.from(shot.png.split(',')[1],'base64'));delete shot.png}
 writeFileSync(`${out}track-production-witness.json`,JSON.stringify({...result,errors},null,2));assert.deepEqual(errors,[]);assert.deepEqual(result.gpuErrors,[]);assert.equal(result.fit,1);assert.ok(result.mesh.includes('circulating-tracks'));assert.equal(result.alphaCutout,false)
 const loop=DESCRIPTOR.loop,pitch=loop.length/loop.linkCount,p=new Float64Array(6),a=new Float64Array(6),b=new Float64Array(6);let maxError=0
 for(const row of result.rows)for(let side=0;side<2;side++){
  const phase=side?((row.packed>>>12)&4095)/4096:(row.packed&4095)/4096
  const delta=row.label==='ambiguous-frame'?0:row.now[side]-row.previous[side]
  for(let previous=0;previous<2;previous++){
   const expectedPhase=phase-(previous?delta/pitch:0);api.circulateTrackVertex(loop,0,expectedPhase*pitch,[-.5,.016,side?.3352:-.3352],[0,1,0],p,a,b)
   const offset=side*8+previous*4;maxError=Math.max(maxError,Math.hypot(...p.slice(0,3).map((v,k)=>v-row.data[offset+k])))
  }
 }
 assert.ok(maxError<1e-5,`actual previous palette correspondence error ${maxError}`)
 assert.deepEqual([...new Set(result.rows.map(r=>r.lod))].sort(),[0,1,2]);assert.ok(result.rows.every(r=>r.counts.reduce((a,b)=>a+b,0)===1),'one selected LOD per actor')
 writeFileSync(`${out}track-production-gate.json`,JSON.stringify({passed:true,maxError,frames:result.rows.length,lods:[0,1,2],instanceFloats:24,fit:result.fit,notes:['Actual production renderer, source-bound authored LODs and material mask.','Readback evaluates production helper using the exact uploaded current/previous actor and bone buffers.','Ordinary 40mm ticks interpolated, 120mm slow frame, 300mm ambiguous frame protects internal velocity.']},null,2))
 console.log('trackproductiongate PASS',maxError,result.rows.length)
}finally{await browser?.close();await stopChild(preview.server)}
