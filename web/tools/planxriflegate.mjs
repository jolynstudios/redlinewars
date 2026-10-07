#!/usr/bin/env node
// Isolated prototype through production GPU upload, materials, skinning and all passes.
// 200 independent renderer actors are a load fixture, not an authoritative engine battle.
import assert from 'node:assert/strict'
import{readFileSync,writeFileSync,mkdirSync}from'node:fs'
import{join,resolve}from'node:path'
import{gunzipSync}from'node:zlib'
import{createHash}from'node:crypto'
import{build}from'esbuild'
import{decodePng}from'./png.mjs'
import{WEB_ROOT,startPreview,stopChild,launchGpuBrowser,loadChromium}from'./harness.mjs'
const integrated=process.argv.includes('--integrated')
const root=resolve(WEB_ROOT,'..'),dir=join(root,'.artifacts/planx/rifle-prototype'),out=join(dir,integrated?'gpu-integrated':'gpu');mkdirSync(out,{recursive:true})
const hash=b=>createHash('sha256').update(b).digest('hex'),manifest=JSON.parse(readFileSync(join(dir,'manifest.json'))),raw=gunzipSync(readFileSync(join(dir,manifest.file))),material=JSON.parse(readFileSync(join(dir,'surfaces/manifest.json'))),pbr=gunzipSync(readFileSync(join(dir,'surfaces',material.file))),baseline=JSON.parse(readFileSync(join(WEB_ROOT,'.forge/human-lods/manifest.json')))
assert.equal(hash(raw),manifest.sha256);assert.equal(hash(pbr),material.sha256);assert.equal(material.sourceSha256,manifest.parentSourceSha256)
for(const e of manifest.levels){assert.equal(e.sourceSha256,hash(readFileSync(join(root,e.sourcePath))));assert.equal(hash(raw.subarray(e.offset,e.offset+e.bytes)),e.sha256);assert.deepEqual(e.rig,baseline.levels[0].rig);assert.ok(e.triangles<=[6000,2000,600][e.level]);assert.ok(Math.abs(e.bounds[0][1]-.0001)<2e-6)}
for(const layer of material.layers)for(const mip of layer.mips)for(const r of mip)assert.equal(hash(pbr.subarray(r.offset,r.offset+r.bytes)),r.sha256)
const bundle=await build({stdin:{contents:`export {decodeBlenderAsset} from './src/units/blender-mesh.ts';export {uploadSourceSurfaces} from './src/materials/source-surfaces.ts';export {sampleHumanMotion,overlayHumanMotionClip} from './src/units/human-motion.ts';export {computeWorldTransforms,computeSkinMatrices} from './src/geo/rig.ts';`,resolveDir:WEB_ROOT,loader:'ts'},bundle:true,platform:'browser',format:'iife',globalName:'rifleApi',write:false,logLevel:'silent',define:{'import.meta.glob':'__emptyGlob'},banner:{js:'const __emptyGlob=()=>({});'}})
let preview,browser
try{
 preview=await startPreview(8491);({browser}=await launchGpuBrowser(await loadChromium('planxriflegate'),'planxriflegate'))
 // The app registers a service worker; SW-handled fetches bypass page.route, so block
 // SWs in this context or the /rifle-fixture fixture route never intercepts.
 const context=await browser.newContext({viewport:{width:1920,height:1080},deviceScaleFactor:1,serviceWorkers:'block'})
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('favicon'))errors.push(m.text())})
 await page.route('**/rifle-fixture/**',route=>route.fulfill({body:route.request().url().endsWith('/mesh')?raw:pbr,contentType:'application/octet-stream'}))
 await page.addInitScript(()=>{globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{}})
 await page.goto(`${preview.baseUrl}?devmap=1&manual=1&deterministic=1&devsize=48&devactors=1&devtod=720&quality=low&weather=clear`);await page.waitForFunction(()=>globalThis.steelseed,undefined,{timeout:120000,polling:100});await page.addScriptTag({content:bundle.outputFiles[0].text})
 const init=await page.evaluate(async({manifest,material,integrated})=>{
  const app=steelseed;app.stop();app.renderOneFrame(0);const ctx=app.ctx,r=ctx.get('render'),materials=ctx.get('materials'),u=ctx.get('units'),api=rifleApi
  const bytes=new Uint8Array(await(await fetch('/rifle-fixture/mesh')).arrayBuffer()),pbr=new Uint8Array(await(await fetch('/rifle-fixture/pbr')).arrayBuffer())
  const decoded=manifest.levels.map(e=>api.decodeBlenderAsset(bytes,e,e.level>0)),meshes=decoded.map(d=>d.mesh)
  for(const mesh of meshes){mesh.generateLodChain=()=>{throw Error('Runtime simplification forbidden for authored LODs')};const gpu=mesh.toGPUBuffers(),view=new DataView(gpu.vertexData);for(let i=0;i<gpu.vertexCount;i++)if([0,1,2,3].reduce((s,k)=>s+view.getUint8(i*gpu.stride+36+k),0)!==255)throw Error('Skin weights are not normalized')}
  const bucket=u.slotBuckets.get('e1')
  const gpu=integrated?bucket.mesh:r.uploadLods(meshes,'planx-rifle-isolated'),set=integrated?materials.get(material.id):api.uploadSourceSurfaces(ctx.device,{manifest:material,bytes:pbr},512)
  if(integrated){for(const name of ['e1','e1r1'])if(u.slotBuckets.get(name)?.surfaceSet!==material.id)throw Error('Integrated rifle role missing '+name);if(set.sourceSha256!==manifest.parentSourceSha256)throw Error('Integrated atlas source mismatch')}
  else materials.sets.set(set.id,set)
  const human=u.humanMotion;if(!human)throw Error('Current production human motion must be available')
  const skeleton=decoded[0].rig.skeleton,pose=skeleton.createPose(),world=skeleton.createMatrixBuffer(),skin=skeleton.createMatrixBuffer()
  const state={needSignatures:true,distinctPoses:0,count:200,scale:1,height:20,phase:0,action:'walk',yaw:.65,frame:0,stats:[],lods:[],palettes:[],enabled:true}
  const late=r.lateUpdate.bind(r)
  r.lateUpdate=(dt,ctx)=>{
   if(state.enabled){
    const signatures=state.needSignatures?new Set():null;const n=state.count,instances=new Float32Array(n*16),palettes=new Uint16Array(n),ids=new Uint32Array(n)
    for(let i=0;i<n;i++){
     pose.resetToBind();const distance=state.phase+(i*.61803398875%1)*human.clip.strideM;api.sampleHumanMotion(human.clip,pose,distance)
     if(state.action==='aim'&&human.aim)api.overlayHumanMotionClip(human.aim,pose,human.aim.durationS,1)
     if(state.action==='fire'&&human.fire){api.overlayHumanMotionClip(human.aim,pose,human.aim.durationS,1);api.overlayHumanMotionClip(human.fire,pose,.06,1)}
     api.computeWorldTransforms(pose,world);api.computeSkinMatrices(skeleton,world,skin);if(signatures)signatures.add(Array.from(skin,v=>Math.round(v*1e5)).join(','));const p=r.reserveBones(skeleton.boneCount);if(!p)throw Error('Palette budget exceeded');p.matrices.set(skin);palettes[i]=p.base;ids[i]=900000+i
     const x=n===1?24:24+(i%20-9.5)*.55,z=n===1?24:24+(Math.floor(i/20)-4.5)*.60,y=ctx.get('terrain').heightAt(x,z),o=i*16
     instances[o]=instances[o+5]=instances[o+10]=state.scale;instances[o+12]=x;instances[o+13]=y;instances[o+14]=z;instances[o+15]=1
    }
    if(signatures){state.distinctPoses=signatures.size;state.needSignatures=false}state.palettes=Array.from(palettes);r.submit({mesh:gpu,surfaceSet:set.id,instances,instanceCount:n,playerColors:null,castsShadow:true,paletteBases:palettes,boneCount:skeleton.boneCount,phases:new Float32Array(n),motionIds:ids})
   }
   r.setShroud(new Uint8Array(48*48).fill(2),48,48,0,0);late(dt,ctx);state.lods=Array.from(r.lodStats.mainInstances);state.stats.push({...r.stats});state.frame++
  }
  const sky=ctx.get('sky');sky.update=()=>{sky.model.evaluate(720,0,0,0,0);sky.model.advance(3);r.setEnvironment(sky.model)}
  globalThis.rifleFixture={state,gpu,set,manifest,human,skeleton,pose,world,skin}
  return {integrated,backend:ctx.backend,triangles:manifest.levels.map(e=>e.triangles),materialVram:set.vramBytes,sourceSha:manifest.parentSourceSha256,bones:skeleton.boneCount,internal:[ctx.canvas.width,ctx.canvas.height],quality:ctx.config.q.name}
 },{manifest,material,integrated});assert.equal(init.backend,'webgpu');assert.equal(init.quality,'low')
 const captures=[]
 for(const [label,count,scale,height,action,phase]of[['detail-ready',1,8,5,'walk',0],['detail-aim',1,8,5,'aim',0],['detail-fire',1,8,5,'fire',0],['normal-single',1,1,3.5,'walk',.03],['crowd-walk',200,1,20,'walk',.07]]){
  const row=await page.evaluate(async({label,count,scale,height,action,phase})=>{
   const app=steelseed,ctx=app.ctx,r=ctx.get('render'),cam=ctx.get('camera'),s=rifleFixture.state;s.count=count;s.needSignatures=true;s.scale=scale;s.action=action;s.phase=phase;cam.height=cam.heightGoal=height;cam.yawRaw=cam.yawGoal=.65;cam.target[0]=cam.targetGoal[0]=24;cam.target[2]=cam.targetGoal[2]=24;cam.target[1]=cam.targetGoal[1]=0
   ctx.device.pushErrorScope('validation');const times=[]
   for(let i=0;i<45;i++){const start=performance.now();s.phase=phase+i*.0007;r.historyValid=false;app.renderOneFrame(1000+s.frame*16.667);await ctx.device.queue.onSubmittedWorkDone();if(i>=15)times.push(performance.now()-start)}
   const e=await ctx.device.popErrorScope();if(e)throw Error(e.message)
   app.renderOneFrame(1000+s.frame*16.667)
   const c=document.createElement('canvas');c.width=ctx.canvas.width;c.height=ctx.canvas.height;c.getContext('2d').drawImage(ctx.canvas,0,0);times.sort((a,b)=>a-b)
   return {label,count,scale,height,action,png:c.toDataURL(),stats:{...r.stats},lods:s.lods,paletteCount:new Set(s.palettes).size,distinctPoses:s.distinctPoses,boneMatrices:count*20,frameCpuAndGpuWaitMs:{p50:times[Math.floor(times.length*.5)],p95:times[Math.floor(times.length*.95)]},internal:[ctx.canvas.width,ctx.canvas.height]}
  },{label,count,scale,height,action,phase});const png=Buffer.from(row.png.split(',')[1],'base64'),decoded=decodePng(png);let lit=0;for(let i=0;i<decoded.data.length;i+=4)if(decoded.data[i]+decoded.data[i+1]+decoded.data[i+2]>12)lit++;assert.ok(lit>1000,'Blank GPU capture');row.litPixels=lit;writeFileSync(join(out,label+'.png'),png);delete row.png;captures.push(row)
 }
 const crowd=captures.at(-1);assert.equal(crowd.paletteCount,200);assert.equal(crowd.distinctPoses,200);assert.equal(crowd.stats.dropped,0);assert.ok(crowd.stats.triangles<2_500_000);assert.deepEqual(errors,[])
 writeFileSync(join(out,'report.json'),JSON.stringify({schema:1,pass:true,scope:(integrated?'Integrated shipping rifle mesh/material; ':'Isolated prototype; ')+'200 independently skinned production renderer instances at normal scale. Separate enlarged detail views. Not an authoritative 200-unit engine battle; serial GPU-wait timings are not ordinary gameplay FPS.',init,captures,errors},null,2)+'\n');console.log('planxriflegate PASS',JSON.stringify({init,crowd}))
}finally{await browser?.close();if(preview)await stopChild(preview.server)}
