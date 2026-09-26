#!/usr/bin/env node
// Actual ordinary match and deployment, using shipping sources without substitution.
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {build} from 'esbuild'
import {WEB_ROOT,launchGpuBrowser,loadChromium} from './harness.mjs'
import {startPrivateComposed} from './private-composed-preview.mjs'
import {configFor} from '../../engine/steelseed-host/tools/runtime-fixture.mjs'
const root=resolve(WEB_ROOT,'..'),quality=process.env.DEPLOY_QUALITY??'low',out=process.env.DEPLOY_OUT?resolve(process.env.DEPLOY_OUT,quality):join(root,'.artifacts/planx/deployment-runtime/'+(process.env.DEPLOY_URL?'checkpoint-':'integrated-')+quality)
mkdirSync(out,{recursive:true})
const manifest=JSON.parse(readFileSync(join(WEB_ROOT,'.forge/blender/manifest.json'))),contract=manifest.assets.fact.deployment
assert.ok(contract,'Shipping yard must declare its source-bound deployment contract')
const code=await build({stdin:{contents:"export {DeploymentRig} from './src/units/deployment-rig';export {computeWorldTransforms,computeSkinMatrices,setBoneAngle} from './src/geo/rig'",resolveDir:WEB_ROOT},bundle:true,write:false,format:'iife',globalName:'deploymentApi',platform:'browser',logLevel:'silent'})
let preview,browser
try{
 preview=process.env.DEPLOY_URL?{baseUrl:process.env.DEPLOY_URL,async close(){}}:await startPrivateComposed(8494);({browser}=await launchGpuBrowser(await loadChromium('deploymentintegrationgate'),'deploymentintegrationgate'))
 const page=await browser.newPage({viewport:{width:1200,height:900}}),errors=[],roomMisses=[]
 page.on('response',r=>{if(r.status()===404&&r.url().endsWith('/rooms'))roomMisses.push(r.url())})
 // The lobby polls the room directory at the page origin; a bare test server has none.
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('favicon')){if(m.text().startsWith('Failed to load resource')&&roomMisses.length>0){roomMisses.pop();return}errors.push(m.text())}})
 await page.goto(`${preview.baseUrl}&quality=${quality}&weather=clear&daylight=day`)
 await page.waitForFunction(()=>globalThis.steelseed?.ctx.session.available,undefined,{timeout:180000,polling:100})
 const catalog=await page.evaluate(()=>steelseed.ctx.session.getCatalog()),map=catalog.maps.find(m=>m.title==='Doubles')??catalog.maps[0],config=configFor(catalog,map,{withBot:false,randomSeed:104729})
 await page.evaluate(c=>steelseed.ctx.session.startSkirmish(c),config)
 await page.waitForFunction(()=>steelseed.ctx.snapshot?.actors?.count>0&&document.getElementById('session-ui').hidden,undefined,{timeout:180000,polling:100})
 await page.addScriptTag({content:code.outputFiles[0].text})
 const setup=await page.evaluate(contract=>{
  const ctx=steelseed.ctx,u=ctx.get('units'),r=ctx.get('render'),a=ctx.snapshot.actors,owner=ctx.snapshot.world.renderPlayer
  const i=Array.from(a.id).findIndex((_,i)=>a.owner[i]===owner&&ctx.actorTypeName(a.typeId[i])==='mcv');if(i<0)throw Error('No starting MCV')
  const source={id:a.id[i],x:a.posX[i]/1024,z:a.posY[i]/1024},bucket=u.slotBuckets.get('fact'),sk=bucket.rig.skeleton,rig=new deploymentApi.DeploymentRig(sk,contract),pose=sk.createPose(),world=sk.createMatrixBuffer(),skin=sk.createMatrixBuffer()
  if(!u.deploymentRigs.has(bucket.rig))throw Error('Shipping units did not bind deployment rig')
  const cam=ctx.get('camera');cam.focusWorld(source.x,source.z);cam.height=cam.heightGoal=5;cam.yawRaw=cam.yawGoal=.7
  ctx.device.pushErrorScope('validation')
  globalThis.deploymentWitness={source,frames:[],latest:null,maxPaletteError:0,minProgress:1,maxProgress:0,sourceDrawn:false,riggedFrames:0,actualNewId:0}
  const encode=r.encodeFrame.bind(r)
  r.encodeFrame=function(){
   for(let it=0;it<r.itemCount;it++){
    const item=r.items[it]
    if(item===u.slotBuckets.get('mcv').item)for(let n=0;n<item.instanceCount;n++)if(item.motionIds[n]===source.id)deploymentWitness.sourceDrawn=true
    if(item!==bucket.item)continue
    for(let n=0;n<item.instanceCount;n++){
     const id=item.motionIds[n],values=new Float64Array(5)
     if(!u.deploymentStates.sourceOf(id,values)||values[0]!==source.id)continue
     const p=u.deploymentStates.progressOf(id,ctx.time.alpha);pose.resetToBind();
     // Retained donor antenna has its own ordinary oscillator, outside the deployment contract.
     for(let j=0;j<bucket.rig.oscillatorBones.length;j++){
      const phase=u.mechanicalClock.seconds(id,ctx.time.alpha)*bucket.rig.oscillatorSpeeds[j]+bucket.rig.oscillatorPhases[j]
      deploymentApi.setBoneAngle(pose,bucket.rig.oscillatorBones[j],Math.sin(phase)*bucket.rig.oscillatorAmplitudes[j])
     }
     rig.sample(pose,p);deploymentApi.computeWorldTransforms(pose,world);deploymentApi.computeSkinMatrices(sk,world,skin)
     const base=item.paletteBases[n]*16;let error=0;for(let k=0;k<skin.length;k++)error=Math.max(error,Math.abs(r.boneData[base+k]-skin[k]))
     const matrix=Array.from(item.instances.subarray(n*16,n*16+16)),lengths=[0,4,8].map(i=>Math.hypot(matrix[i],matrix[i+1],matrix[i+2]))
     const row={tick:ctx.time.tick,progress:p,id,sourceId:values[0],matrix,axisLengths:lengths,paletteError:error,paletteBase:item.paletteBases[n],included:!!r.itemIncluded[it],dropped:r.stats.dropped}
     deploymentWitness.latest={...row,bones:Array.from(r.boneData.subarray(base,base+skin.length))}
     if(deploymentWitness.frames.length<1000)deploymentWitness.frames.push(row)
     deploymentWitness.maxPaletteError=Math.max(deploymentWitness.maxPaletteError,error);deploymentWitness.minProgress=Math.min(deploymentWitness.minProgress,p);deploymentWitness.maxProgress=Math.max(deploymentWitness.maxProgress,p);deploymentWitness.riggedFrames++;deploymentWitness.actualNewId=id
    }
   }
   return encode()
  }
  return {source,bones:sk.boneCount,mcvSurface:u.slotBuckets.get('mcv').surfaceSet,factSurface:bucket.surfaceSet,mcvFit:u.slotGround.get('mcv').fitScale,factFit:u.slotGround.get('fact').fitScale,lodTriangles:bucket.mesh.lods.map(l=>l.indexCount/3)}
 },contract)
 assert.equal(setup.mcvFit,1);assert.equal(setup.factFit,1)
 await page.waitForFunction(()=>deploymentWitness.sourceDrawn,undefined,{timeout:20000,polling:50});await page.screenshot({path:join(out,'vehicle.png')})
 console.log('MCV ordinary match loaded',quality,setup.source.id)
 const order=await page.evaluate(()=>steelseed.bridge.issueOrder({orderString:'DeployTransform',subjectIds:Uint32Array.of(deploymentWitness.source.id),targetActorId:0,targetCellX:-1,targetCellY:-1,queued:false,targetString:'',extraData:0}))
 assert.match(order,/ok: issued 1\/1/)
 await page.waitForFunction(()=>deploymentWitness.latest?.progress>=.2,undefined,{timeout:30000,polling:10})
 await page.evaluate(()=>steelseed.ctx.session.setPaused(true));await page.waitForFunction(()=>(steelseed.ctx.snapshot.flags&2)!==0,undefined,{timeout:15000,polling:25});await page.waitForTimeout(200)
 const paused=await page.evaluate(()=>deploymentWitness.latest);await page.screenshot({path:join(out,'deploy-paused.png')});await page.waitForTimeout(250)
 const held=await page.evaluate(()=>deploymentWitness.latest);assert.deepEqual(held.bones,paused.bones);assert.deepEqual(held.matrix,paused.matrix)
 assert.ok(paused.progress<1,'Pause must exercise an active transform')
 await page.evaluate(()=>steelseed.ctx.session.setPaused(false))
 let appendedPause=null
 if(contract.prefixEnd){
  await page.waitForFunction(()=>deploymentWitness.latest?.progress>=.65,undefined,{timeout:30000,polling:10})
  await page.evaluate(()=>steelseed.ctx.session.setPaused(true));await page.waitForFunction(()=>(steelseed.ctx.snapshot.flags&2)!==0,undefined,{timeout:15000,polling:25});await page.waitForTimeout(150)
  const before=await page.evaluate(()=>deploymentWitness.latest);await page.screenshot({path:join(out,'afbouw-paused.png')});await page.waitForTimeout(200)
  const after=await page.evaluate(()=>deploymentWitness.latest);assert.ok(before.progress>contract.prefixEnd&&before.progress<1);assert.deepEqual(after.bones,before.bones);assert.deepEqual(after.matrix,before.matrix)
  appendedPause={progress:before.progress,tick:before.tick,held:true};await page.evaluate(()=>steelseed.ctx.session.setPaused(false))
 }
 await page.waitForFunction(()=>deploymentWitness.maxProgress===1,undefined,{timeout:30000,polling:25});await page.evaluate(()=>{const cam=steelseed.ctx.get('camera');cam.height=cam.heightGoal=8});await page.waitForTimeout(250);await page.screenshot({path:join(out,'operational.png')})
 await page.evaluate(()=>{const cam=steelseed.ctx.get('camera');cam.height=cam.heightGoal=14});await page.waitForTimeout(250);await page.screenshot({path:join(out,'gameplay.png')})
 const report=await page.evaluate(async()=>{
  const ctx=steelseed.ctx,u=ctx.get('units'),a=ctx.snapshot.actors,w=deploymentWitness
  const index=Array.from(a.id).indexOf(w.actualNewId)
  return {...w,latest:undefined,backend:ctx.backend,quality:ctx.config.q.name,actorType:index<0?null:ctx.actorTypeName(a.typeId[index]),sourceGone:!Array.from(a.id).includes(w.source.id),forgeErrors:u.forgeStats.errors,droppedSlots:u.droppedSlots,skin:u.skinStats,renderStats:ctx.get('render').stats,qualityConfig:ctx.config.q,gpuError:(await ctx.device.popErrorScope())?.message??null}
 })
 assert.equal(report.backend,'webgpu');assert.equal(report.quality,quality,'Named tier stays selected');assert.equal(report.actorType,'fact');assert.equal(report.sourceGone,true);assert.notEqual(report.actualNewId,setup.source.id)
 writeFileSync(join(out,'observed.json'),JSON.stringify({setup,pausedProgress:paused.progress,appendedPause,...report,errors},null,2)+'\n')
 assert.ok(report.minProgress<.2);assert.equal(report.maxProgress,1);assert.ok(report.riggedFrames>5);assert.ok(report.maxPaletteError<3e-5,`Actual submitted skin differs ${report.maxPaletteError}`)
 for(const row of report.frames){assert.ok(row.dropped<=2,'Submit-cap degradation stays invisible (2 items max, one frame)');for(const length of row.axisLengths)assert.ok(Math.abs(length-1)<2e-6,'No instance scale morph')}
 assert.deepEqual(report.forgeErrors,[]);assert.equal(report.skin.paletteOverflows,0);assert.equal(report.gpuError,null);assert.deepEqual(errors,[]);assert.deepEqual(report.droppedSlots,[])
 writeFileSync(join(out,'report.json'),JSON.stringify({status:'PASS',scope:'Ordinary shipping match/start/deploy with actual new ActorID, source-bound rigid channels, pause, endpoint and gameplay-distance rendering. No asset substitution; not a fleet benchmark.',setup,order,pausedProgress:paused.progress,appendedPause,...report,errors},null,2)+'\n')
 console.log('DEPLOYMENT_INTEGRATION_PASS',quality,report.riggedFrames,'frames',report.maxPaletteError,'palette error')
}finally{await browser?.close();if(preview)await preview.close()}
