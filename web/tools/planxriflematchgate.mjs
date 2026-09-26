#!/usr/bin/env node
// Isolated prototype through production GPU upload, materials, skinning and all passes.
// 200 independent renderer actors are a load fixture, not an authoritative engine battle.
import assert from 'node:assert/strict'
import{readFileSync,writeFileSync,mkdirSync}from'node:fs'
import{join,resolve}from'node:path'
import{gunzipSync}from'node:zlib'
import{createHash}from'node:crypto'
import{build}from'esbuild'
import{WEB_ROOT,launchGpuBrowser,loadChromium}from'./harness.mjs'
import{startPrivateComposed}from'./private-composed-preview.mjs'
import{configFor}from'../../engine/steelseed-host/tools/runtime-fixture.mjs'
const integrated=process.argv.includes('--integrated')
const root=resolve(WEB_ROOT,'..'),dir=join(root,'.artifacts/planx/rifle-prototype'),out=join(dir,integrated?'match-integrated':'match');mkdirSync(out,{recursive:true})
const hash=b=>createHash('sha256').update(b).digest('hex'),manifest=JSON.parse(readFileSync(join(dir,'manifest.json'))),raw=gunzipSync(readFileSync(join(dir,manifest.file))),material=JSON.parse(readFileSync(join(dir,'surfaces/manifest.json'))),pbr=gunzipSync(readFileSync(join(dir,'surfaces',material.file))),baseline=JSON.parse(readFileSync(join(WEB_ROOT,'.forge/human-lods/manifest.json')))
assert.equal(hash(raw),manifest.sha256);assert.equal(hash(pbr),material.sha256);assert.equal(material.sourceSha256,manifest.parentSourceSha256)
for(const e of manifest.levels){assert.equal(e.sourceSha256,hash(readFileSync(join(root,e.sourcePath))));assert.equal(hash(raw.subarray(e.offset,e.offset+e.bytes)),e.sha256);assert.deepEqual(e.rig,baseline.levels[0].rig);assert.ok(e.triangles<=[6000,2000,600][e.level]);assert.ok(Math.abs(e.bounds[0][1]-.0001)<2e-6)}
for(const layer of material.layers)for(const mip of layer.mips)for(const r of mip)assert.equal(hash(pbr.subarray(r.offset,r.offset+r.bytes)),r.sha256)
const bundle=await build({stdin:{contents:`export {decodeBlenderAsset} from './src/units/blender-mesh.ts';export {uploadSourceSurfaces} from './src/materials/source-surfaces.ts';export {sampleHumanMotion,overlayHumanMotionClip} from './src/units/human-motion.ts';export {computeWorldTransforms,computeSkinMatrices} from './src/geo/rig.ts';`,resolveDir:WEB_ROOT,loader:'ts'},bundle:true,platform:'browser',format:'iife',globalName:'rifleApi',write:false,logLevel:'silent',define:{'import.meta.glob':'__emptyGlob'},banner:{js:'const __emptyGlob=()=>({});'}})
let preview,browser
try{
 preview=await startPrivateComposed(8492);({browser}=await launchGpuBrowser(await loadChromium('planxriflematchgate'),'planxriflematchgate'))
 // The app registers a service worker; SW-handled fetches bypass page.route, so block
 // SWs in this context or the /rifle-fixture fixture route never intercepts.
 const context=await browser.newContext({viewport:{width:1200,height:900},deviceScaleFactor:1,serviceWorkers:'block'})
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('favicon')&&!m.location()?.url?.includes('/rooms'))errors.push(m.text())})
 await page.route('**/rifle-fixture/**',route=>route.fulfill({body:route.request().url().endsWith('/mesh')?raw:pbr,contentType:'application/octet-stream'}))
 await page.goto(`${preview.baseUrl}&quality=low&weather=clear&daylight=day`);await page.waitForFunction(()=>globalThis.steelseed?.ctx.session.available,undefined,{timeout:180000,polling:100})
 const catalog=await page.evaluate(()=>steelseed.ctx.session.getCatalog()),map=catalog.maps.find(m=>m.title==='Marigold Town');assert.ok(map)
 const config=configFor(catalog,map,{withBot:false});config.local.faction='england';config.slots.find(s=>s.slot===config.local.slot).faction='england';Object.assign(config.options,{startingunits:'heavy',explored:'True',fog:'False',crates:'False'})
 await page.evaluate(c=>steelseed.ctx.session.startSkirmish(c),config);await page.waitForFunction(()=>steelseed.ctx.snapshot?.actors?.count>0&&document.getElementById('session-ui').hidden,undefined,{timeout:180000,polling:100});await page.addScriptTag({content:bundle.outputFiles[0].text})
 const setup=await page.evaluate(async({manifest,material,integrated})=>{
  const ctx=steelseed.ctx,r=ctx.get('render'),u=ctx.get('units'),api=rifleApi,bytes=new Uint8Array(await(await fetch('/rifle-fixture/mesh')).arrayBuffer()),pbr=new Uint8Array(await(await fetch('/rifle-fixture/pbr')).arrayBuffer())
  const untouched=['e3','1tnk','apc'].map(n=>{const b=u.slotBuckets.get(n);return {name:n,mesh:b.mesh,surface:b.surfaceSet}}),bucket=u.slotBuckets.get('e1')
  let set
  if(integrated){set=ctx.get('materials').get(material.id);for(const name of ['e1','e1r1'])if(u.slotBuckets.get(name)?.surfaceSet!==material.id)throw Error('Integrated rifle role missing '+name);if(set.sourceSha256!==manifest.parentSourceSha256)throw Error('Integrated source mismatch')}
  else{const decoded=manifest.levels.map(e=>api.decodeBlenderAsset(bytes,e,e.level>0)),gpu=r.uploadLods(decoded.map(d=>d.mesh),'planx-rifle-real-match');set=api.uploadSourceSurfaces(ctx.device,{manifest:material,bytes:pbr},512);ctx.get('materials').sets.set(set.id,set);bucket.mesh=gpu;bucket.surfaceSet=set.id;bucket.item.mesh=gpu;bucket.item.surfaceSet=set.id}
  const a=ctx.snapshot.actors,owner=ctx.snapshot.world.renderPlayer,actors=[];for(let i=0;i<a.count;i++)actors.push({id:a.id[i],x:a.posX[i]/1024,z:a.posY[i]/1024,name:ctx.actorTypeName(a.typeId[i]),owner:a.owner[i]})
  const actor=actors.find(a=>a.owner===owner&&a.name==='e1');if(!actor)throw Error('No actual starting rifle infantry')
  const target=actors.filter(a=>a.id!==actor.id&&a.owner===owner&&['1tnk','apc','jeep'].includes(a.name)).sort((a,b)=>Math.hypot(a.x-actor.x,a.z-actor.z)-Math.hypot(b.x-actor.x,b.z-actor.z))[0];if(!target)throw Error('No normal force-attack test target')
  const cam=ctx.get('camera');cam.focusWorld(actor.x,actor.z);cam.height=cam.heightGoal=3.5;cam.yawRaw=cam.yawGoal=.65
  const human=u.humanMotion,sk=human.rig.skeleton,pose=sk.createPose(),world=sk.createMatrixBuffer(),skin=sk.createMatrixBuffer(),anim=ctx.get('anim'),original=r.encodeFrame.bind(r)
  globalThis.rifleMatch={actor,target,frames:[],orders:[],fireFrames:0,maxPaletteError:0,initialDistance:anim.distanceOf(actor.id),untouched}
  r.encodeFrame=function(){
   for(let it=0;it<r.itemCount;it++)if(r.items[it]===bucket.item){const item=r.items[it];for(let n=0;n<item.instanceCount;n++)if(item.motionIds[n]===actor.id){
    const distance=anim.interpolatedDistanceOf(actor.id,ctx.time.alpha)/human.scale,aim=anim.interpolatedAimOf(actor.id,ctx.time.alpha),since=anim.secondsSinceFire(actor.id,ctx.time.alpha)
    api.sampleHumanMotion(human.clip,pose,distance);if(human.aim&&aim>0)api.overlayHumanMotionClip(human.aim,pose,aim*human.aim.durationS,aim);if(human.fire&&since>=0&&since<human.fire.durationS){api.overlayHumanMotionClip(human.fire,pose,since,1);rifleMatch.fireFrames++}
    api.computeWorldTransforms(pose,world);api.computeSkinMatrices(sk,world,skin);const base=item.paletteBases[n]*16;let error=0;for(let k=0;k<skin.length;k++)error=Math.max(error,Math.abs(r.boneData[base+k]-skin[k]));rifleMatch.maxPaletteError=Math.max(rifleMatch.maxPaletteError,error)
    rifleMatch.latest={tick:ctx.time.tick,distance,aim,sinceFire:since,position:Array.from(item.instances.subarray(n*16+12,n*16+15)),included:!!r.itemIncluded[it],dropped:r.stats.dropped,bones:Array.from(r.boneData.subarray(base,base+skin.length))};if(rifleMatch.frames.length<1000)rifleMatch.frames.push({...rifleMatch.latest,bones:undefined})
   }}return original()
  }
  return {integrated,actor,target,rigBones:sk.boneCount,triangles:manifest.levels.map(e=>e.triangles),surface:set.id,scale:human.scale}
 },{manifest,material,integrated});assert.equal(setup.scale,1)
 await page.waitForFunction(()=>rifleMatch.latest?.included,undefined,{timeout:30000,polling:50});await page.screenshot({path:join(out,'ready.png')})
 const move=await page.evaluate(()=>{const a=rifleMatch.actor,x=Math.floor(a.x)+2,z=Math.floor(a.z)+1,result=steelseed.bridge.issueContextOrder({subjectIds:Uint32Array.of(a.id),subjectCount:1,targetActorId:0,targetCellX:x,targetCellY:z,targetFrozen:false,modifiers:0});rifleMatch.orders.push({kind:'Move',x,z,result});return result});assert.match(move,/Move/)
 await page.waitForFunction(()=>Math.abs(rifleMatch.latest.distance-rifleMatch.initialDistance)>.5,undefined,{timeout:30000,polling:50});await page.screenshot({path:join(out,'walking.png')})
 const attack=await page.evaluate(()=>{const result=steelseed.bridge.issueOrder({orderString:'ForceAttack',subjectIds:Uint32Array.of(rifleMatch.actor.id),targetActorId:rifleMatch.target.id,targetCellX:-1,targetCellY:-1,queued:false,targetString:'',extraData:0});rifleMatch.orders.push({kind:'ForceAttack',target:rifleMatch.target.id,result});return result});assert.match(attack,/ok: issued 1\/1/)
 await page.waitForFunction(()=>rifleMatch.fireFrames>1,undefined,{timeout:60000,polling:25});await page.screenshot({path:join(out,'firing.png')})
 await page.evaluate(()=>steelseed.ctx.session.setPaused(true));await page.waitForFunction(()=>(steelseed.ctx.snapshot.flags&2)!==0,undefined,{timeout:15000,polling:50});await page.waitForTimeout(300);const paused=await page.evaluate(()=>rifleMatch.latest);await page.waitForTimeout(350);const held=await page.evaluate(()=>rifleMatch.latest);assert.deepEqual(held.bones,paused.bones);assert.deepEqual(held.position,paused.position)
 const report=await page.evaluate(()=>{const u=steelseed.ctx.get('units'),untouched=rifleMatch.untouched.every(x=>{const b=u.slotBuckets.get(x.name);return b.mesh===x.mesh&&b.surfaceSet===x.surface});return {frames:rifleMatch.frames,orders:rifleMatch.orders,fireFrames:rifleMatch.fireFrames,maxPaletteError:rifleMatch.maxPaletteError,untouched,skin:u.skinStats}})
 assert.equal(report.untouched,true);assert.ok(report.maxPaletteError<2e-6);assert.ok(report.frames.some(f=>f.included));assert.ok(report.fireFrames>1);assert.deepEqual(errors,[])
 writeFileSync(join(out,'report.json'),JSON.stringify({schema:1,pass:true,scope:integrated?'Actual OpenRA Marigold Town using integrated shipping rifle with no mesh/material substitution. Normal move/force-attack and pause orders.':'Actual OpenRA Marigold Town with fixture-only e1 mesh/material substitution. Normal move/force-attack and pause orders; same authoritative actor, health and existing motion channels.',setup,...report,errors},null,2)+'\n');console.log('planxriflematchgate PASS',JSON.stringify({setup,fireFrames:report.fireFrames,maxPaletteError:report.maxPaletteError,frames:report.frames.length}))
}finally{await browser?.close();if(preview)await preview.close()}
