#!/usr/bin/env node
// Retained MakeHuman fallback: explicit rifleunits=0, real movement and pause.
import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync,readFileSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {build} from 'esbuild'
import {WEB_ROOT,launchGpuBrowser,loadChromium} from './harness.mjs'
import {configFor} from '../../engine/steelseed-host/tools/runtime-fixture.mjs'
import {startPrivateComposed} from './private-composed-preview.mjs'

const out=join(WEB_ROOT,'.artifacts/visual-quality/human-units');mkdirSync(out,{recursive:true})
const maps=readdirSync(join(WEB_ROOT,'dist/assets')).filter(name=>/^steelseed-units-.*\.js\.map$/.test(name))
assert.equal(maps.length,1,'Require one finished production units build')
const sourceMap=JSON.parse(readFileSync(join(WEB_ROOT,'dist/assets',maps[0])))
for(const file of ['index.ts','human-assets.ts','human-motion.ts']){
 const i=sourceMap.sources.findIndex(name=>name.endsWith(`/units/${file}`))
 assert.ok(i>=0,`${file} missing from dist: finish build before running this gate`)
 assert.equal(sourceMap.sourcesContent[i],readFileSync(join(WEB_ROOT,'src/units',file),'utf8'),`${file} is stale in dist`)
}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const atlasHash=hash(readFileSync(join(WEB_ROOT,'.forge/human-surfaces/surfaces.sspbr.gz')))
const atlasAsset=readdirSync(join(WEB_ROOT,'dist/assets')).find(name=>name.startsWith('surfaces.sspbr-')&&hash(readFileSync(join(WEB_ROOT,'dist/assets',name)))===atlasHash)
assert.ok(atlasAsset,'Matching built human atlas required')
const bundle=await build({stdin:{contents:`export {sampleHumanMotion,overlayHumanMotionClip} from './src/units/human-motion.ts';
 export {computeWorldTransforms,computeSkinMatrices} from './src/geo/rig.ts';`,resolveDir:WEB_ROOT,loader:'ts'},
 bundle:true,platform:'browser',format:'iife',globalName:'humanUnitsProbe',write:false,logLevel:'silent',
 define:{'import.meta.glob':'__emptyGlob'},banner:{js:'const __emptyGlob=()=>({});'}})
let preview,browser,context
try{
 preview=await startPrivateComposed(8469)
 ;({browser}=await launchGpuBrowser(await loadChromium('humanunitsgate'),'humanunitsgate'))
 context=await browser.newContext({viewport:{width:1200,height:900},recordVideo:{dir:out,size:{width:1200,height:900}}})
 const baselinePage=await context.newPage(),baselineRequests=[]
 baselinePage.on('request',r=>baselineRequests.push(r.url()))
 await baselinePage.goto(`${preview.baseUrl}?mode=game&platform=null&quality=medium&weather=clear&daylight=day&humanunits=0`)
 await baselinePage.waitForFunction(()=>globalThis.steelseed?.ctx.session.available,undefined,{timeout:180000,polling:100})
 const baseline=await baselinePage.evaluate(()=>{
  const ctx=steelseed.ctx,u=ctx.get('units')
  return {motion:u.humanMotion,atlas:ctx.get('materials').has('infantry-v1'),others:['e3','1tnk','apc'].map(name=>{
   const b=u.slotBuckets.get(name);return {name,triangles:b.mesh.lods.map(l=>l.indexCount/3),surface:b.item.surfaceSet,role:u.roleActors?.get(name)??null}
  })}
 })
 assert.equal(baseline.motion,null);assert.equal(baseline.atlas,false)
 assert.ok(!baselineRequests.some(url=>/\/lods\.ssmesh-|\/walk\.ssanim-/.test(url)||url.endsWith('/'+atlasAsset)),'humanunits=0 must fetch neither mesh, action nor atlas')
 await baselinePage.close()
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto(`${preview.baseUrl}?mode=game&platform=null&quality=medium&weather=clear&daylight=day&rifleunits=0`)
 await page.waitForFunction(()=>globalThis.steelseed?.ctx.session.available,undefined,{timeout:180000,polling:100})
 const catalog=await page.evaluate(()=>steelseed.ctx.session.getCatalog()),map=catalog.maps.find(m=>m.title==='Marigold Town')
 assert.ok(map,'Real Marigold Town catalog required')
 const config=configFor(catalog,map,{withBot:false}),faction=['england','germany','france','allies'].find(id=>map.factions.some(f=>f.id===id))
 assert.ok(faction);config.local.faction=faction;config.slots.find(s=>s.slot===config.local.slot).faction=faction
 Object.assign(config.options,{startingunits:'heavy',explored:'True',fog:'False',crates:'False'})
 await page.evaluate(c=>steelseed.ctx.session.startSkirmish(c),config)
 await page.waitForFunction(()=>steelseed.ctx.snapshot?.actors?.count>0&&document.getElementById('session-ui').hidden,undefined,{timeout:180000,polling:100})
 await page.addScriptTag({content:bundle.outputFiles[0].text})
 const lodManifest=JSON.parse(readFileSync(join(WEB_ROOT,'.forge/human-lods/manifest.json')))
// Compared against the manifest the mesh was exported with, not a pinned snapshot: an exact
// count here failed on every deliberate geometry edit while proving nothing extra.
const expectedLods=lodManifest.levels.map(level=>level.triangles).join(',')
const start=await page.evaluate(expectedLods=>{
  const ctx=steelseed.ctx,u=ctx.get('units'),r=ctx.get('render'),anim=ctx.get('anim'),a=ctx.snapshot.actors,human=u.humanMotion
  if(!human||human.scale!==1||human.rig.skeleton.boneCount!==20)throw Error('Opt-in skeletal integration missing')
  let actor=null
  for(let i=0;i<a.count;i++)if(a.owner[i]===ctx.snapshot.world.renderPlayer&&ctx.actorTypeName(a.typeId[i])==='e1'){
   actor={id:a.id[i],x:a.posX[i]/1024,z:a.posY[i]/1024};break
  }
  if(!actor)throw Error('Real starting rifleman required')
  const bucket=u.slotBuckets.get('e1')
  if(bucket.mesh.lods.map(l=>l.indexCount/3).join(',')!==expectedLods||bucket.item.surfaceSet!=='infantry-v1')throw Error('Wrong anatomical mesh or atlas')
  const cam=ctx.get('camera');cam.focusWorld(actor.x,actor.z);cam.height=cam.heightGoal=5;cam.yaw=cam.yawGoal=.6
  const sk=human.rig.skeleton,pose=sk.createPose(),world=sk.createMatrixBuffer(),skin=sk.createMatrixBuffer(),encode=r.encodeFrame.bind(r)
  const aimClip=human.aim,fireClip=human.fire
  globalThis.humanWitness={id:actor.id,frames:[],frameSerial:0,maxError:0,orders:[],overlayFrames:0,initialDistance:anim.distanceOf(actor.id),sourceSha:human.clip.manifest.sourceSha256}
  r.encodeFrame=function(){
   for(let it=0;it<r.itemCount;it++){
    const item=r.items[it];if(item!==bucket.item)continue
    for(let n=0;n<item.instanceCount;n++)if(item.motionIds[n]===actor.id){
     const distance=anim.interpolatedDistanceOf(actor.id,ctx.time.alpha)/human.scale
     humanUnitsProbe.sampleHumanMotion(human.clip,pose,distance)
     // Mirror what units draws, overlays included. Recomputing the walk alone would keep
     // this equality witness green while an aim overlay quietly wrote a different palette.
     const aimWeight=anim.interpolatedAimOf(actor.id,ctx.time.alpha)
     if(aimClip&&aimWeight>0)humanUnitsProbe.overlayHumanMotionClip(aimClip,pose,aimWeight*aimClip.durationS,aimWeight)
     if(fireClip){const since=anim.secondsSinceFire(actor.id,ctx.time.alpha)
      if(since>=0&&since<fireClip.durationS)humanUnitsProbe.overlayHumanMotionClip(fireClip,pose,since,1)}
     humanWitness.overlayFrames+=(aimWeight>0?1:0)
     humanUnitsProbe.computeWorldTransforms(pose,world);humanUnitsProbe.computeSkinMatrices(sk,world,skin)
     const base=item.paletteBases[n]*16;let error=0
     for(let k=0;k<skin.length;k++)error=Math.max(error,Math.abs(r.boneData[base+k]-skin[k]))
     humanWitness.maxError=Math.max(humanWitness.maxError,error)
     humanWitness.latest={serial:++humanWitness.frameSerial,tick:ctx.time.tick,alpha:ctx.time.alpha,distance,position:Array.from(item.instances.subarray(n*16+12,n*16+15)),
      bones:Array.from(r.boneData.subarray(base,base+skin.length)),included:!!r.itemIncluded[it],dropped:r.stats.dropped}
     if(humanWitness.frames.length<600)humanWitness.frames.push({...humanWitness.latest,bones:undefined})
    }
   }
   return encode()
  }
  return {...actor,triangles:bucket.mesh.lods.map(l=>l.indexCount/3),sourceSha:human.clip.manifest.sourceSha256,
   others:['e3','1tnk','apc'].map(name=>{const b=u.slotBuckets.get(name);return {name,triangles:b.mesh.lods.map(l=>l.indexCount/3),surface:b.item.surfaceSet,role:u.roleActors?.get(name)??null}})}
 },expectedLods)
 // rifleunits=0 governs e1/e1r1 only. A neighbour with its own role pack (web/.forge/troop-e3)
 // still wears it; what this fallback must never do is change any neighbour it does not govern.
 assert.ok(baseline.others.every(o=>o.role===null),'humanunits=0 must leave every role pack off')
 start.others.forEach((other,i)=>other.role!==null
  ?assert.equal(other.surface,other.role,`${other.name} must wear its own role pack, not the fallback figure`)
  :assert.deepEqual(other,baseline.others[i],'The experiment must not replace neighboring actor types'))
 await page.waitForFunction(()=>humanWitness.latest?.included,undefined,{timeout:30000,polling:50})
 await page.screenshot({path:join(out,'before.png')})
 const before=await page.evaluate(()=>humanWitness.latest)
 for(const [dx,dz] of [[4,1],[0,4],[-4,0]]){
  const result=await page.evaluate(({id,x,z})=>{
   const result=steelseed.bridge.issueContextOrder({subjectIds:Uint32Array.of(id),subjectCount:1,targetActorId:0,targetCellX:x,targetCellY:z,targetFrozen:false,modifiers:0})
   humanWitness.orders.push({x,z,result});return result
  },{id:start.id,x:Math.floor(start.x)+dx,z:Math.floor(start.z)+dz})
  assert.match(result,/Move/,'OpenRA must resolve the ground order')
  try{await page.waitForFunction(()=>Math.abs(humanWitness.latest.distance-humanWitness.initialDistance)>.5,undefined,{timeout:12000,polling:25});break}catch{}
 }
 const walking=await page.evaluate(()=>humanWitness.latest)
 assert.ok(Math.abs(walking.distance-before.distance)>.5,'Real actor must actually move')
 assert.notDeepEqual(walking.bones,before.bones,'Rendered skeleton must follow real movement')
 await page.screenshot({path:join(out,'walking.png')})
 const pauseResult=await page.evaluate(()=>steelseed.ctx.session.setPaused(true));assert.doesNotMatch(pauseResult,/error/i)
 await page.waitForFunction(()=>(steelseed.ctx.snapshot.flags&2)!==0,undefined,{timeout:10000,polling:50})
 await page.waitForTimeout(250)
 const paused=await page.evaluate(()=>humanWitness.latest)
 await page.waitForFunction(serial=>humanWitness.latest.serial>=serial+3,paused.serial,{timeout:15000,polling:50})
 const held=await page.evaluate(()=>humanWitness.latest)
 assert.deepEqual(held.bones,paused.bones,'Paused actual actor skeleton must remain identical')
 assert.deepEqual(held.position,paused.position,'Paused placement must remain identical')
 const report=await page.evaluate(()=>({witness:humanWitness,skin:steelseed.ctx.get('units').skinStats}))
 assert.ok(report.witness.maxError<2e-6,'Actual submitted palette must use interpolated, scale-correct distance')
 assert.ok(report.witness.frames.some(f=>f.included),'Pose must survive culling and budget')
 assert.deepEqual(errors,[])
 const summary={map:map.title,start,frames:report.witness.frames.length,maxPaletteError:report.witness.maxError,travel:walking.distance-before.distance,
  pauseStable:true,pausedFreshFrames:held.serial-paused.serial,disabledAssetRequests:0,unchangedOtherActors:baseline.others,
  orders:report.witness.orders,overlayFrames:report.witness.overlayFrames,note:'Real OpenRA movement/pause and production e1 draw routing, explicit rifleunits=0 verifies the retained MakeHuman fallback; humanunits=0 restores the procedural box and fetches nothing. The separate rifle integration gate validates the default e1/e1r1 remodel; this gate keeps its original fallback mesh and material assertions. Idle/aim/prone transitions, sloped contacts and representative crowd performance remain unaccepted.'}
 writeFileSync(join(out,'report.json'),JSON.stringify({summary,report},null,2));console.log('humanunitsgate PASS',JSON.stringify(summary))
}finally{await context?.close();await browser?.close();await preview?.close()}
