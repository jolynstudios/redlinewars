#!/usr/bin/env node
// Native Riki draw witness in a private composed browser. Only map data is staged;
// ordinary OpenRA orders and positive damage drive movement/TakeCover/recovery.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {gunzipSync} from 'node:zlib'
import {build} from 'esbuild'
import {WEB_ROOT,launchGpuBrowser,loadChromium} from './harness.mjs'
import {startPrivateComposed} from './private-composed-preview.mjs'
import {configFor} from '../../engine/steelseed-host/tools/runtime-fixture.mjs'

const out=join(WEB_ROOT,'.artifacts/visual-quality/riki-native-gpu')
mkdirSync(out,{recursive:true})
const hash=b=>createHash('sha256').update(b).digest('hex')
const manifest=JSON.parse(readFileSync(join(WEB_ROOT,'.forge/riki-meshy/manifest.json')))
const surfaceManifest=JSON.parse(readFileSync(join(WEB_ROOT,'.forge/riki-meshy-surfaces/manifest.json')))
const surfacePayload=gunzipSync(readFileSync(join(WEB_ROOT,'.forge/riki-meshy-surfaces',surfaceManifest.file)))
for(const level of manifest.levels){
 assert.ok(level.doubleSidedMaterialBake?.reverseTriangles>0,`LOD ${level.level} lacks reverse-facing body geometry`)
}
for(const layer of surfaceManifest.layers)for(const mip of layer.mips){
 const color=surfacePayload.subarray(mip[0].offset,mip[0].offset+mip[0].bytes)
 let alphaMin=255
 for(let index=3;index<color.length;index+=4)alphaMin=Math.min(alphaMin,color[index])
 assert.equal(alphaMin,255,`Opaque atlas alpha is not fully opaque at ${layer.name} mip ${layer.mips.indexOf(mip)}`)
}
const maps=readdirSync(join(WEB_ROOT,'dist/assets')).filter(n=>n.endsWith('.js.map')).map(n=>JSON.parse(readFileSync(join(WEB_ROOT,'dist/assets',n))))
for(const file of ['units/index.ts','units/riki-assets.ts','ui/production.ts','geo/rig.ts']){
 const entries=maps.flatMap(m=>m.sources.flatMap((s,i)=>s.endsWith('/'+file)?[m.sourcesContent[i]]:[]))
 assert.ok(entries.length,`${file} missing from production source maps`)
 assert.ok(entries.every(s=>s===readFileSync(join(WEB_ROOT,'src',file),'utf8')),`${file} stale in dist`)
}
const portraitBytes=readFileSync(join(WEB_ROOT,'.forge/riki-meshy/portrait.png'))
const portraitAsset=readdirSync(join(WEB_ROOT,'dist/assets')).find(n=>n.startsWith('portrait-')&&n.endsWith('.png')&&hash(readFileSync(join(WEB_ROOT,'dist/assets',n)))===hash(portraitBytes))
assert.ok(portraitAsset,'Exact native portrait missing from finished build')
const probe=await build({stdin:{contents:"export {poseRiki} from './src/units/riki-assets'; export {Pose,computeWorldTransforms,computeSkinMatrices} from './src/geo/rig'",resolveDir:WEB_ROOT,loader:'ts'},bundle:true,platform:'browser',format:'iife',globalName:'rikiGpuProbe',write:false,logLevel:'silent',define:{'import.meta.glob':'__emptyGlob'},banner:{js:'const __emptyGlob=()=>({});'}})
function prepareFixture(fs){
 const dir='/openra/engine/mods/ra/maps/doubles',file=dir+'/map.yaml',text=fs.readFile(file,{encoding:'utf8'})
 const actors=[['Spawn0','mpspawn',80,40],['Spawn1','mpspawn',100,40],['Spawn2','mpspawn',80,46],['Spawn3','mpspawn',100,46],['Riki','e7',10,10],['Shooter','e1',14,10]]
 fs.writeFile(file,text.split('\nActors:\n')[0]+'\nActors:\n'+actors.map(([id,type,x,y])=>`\t${id}: ${type}\n\t\tOwner: ${type==='mpspawn'?'Neutral':'Multi0'}\n\t\tLocation: ${x},${y}\n`).join(''))
 const width=112,height=54,n=width*height,terrain=new Uint8Array(5+n*5),v=new DataView(terrain.buffer)
 terrain[0]=1;v.setUint16(1,width,true);v.setUint16(3,height,true)
 for(let i=0;i<n;i++)v.setUint16(5+i*3,255,true)
 fs.writeFile(dir+'/map.bin',terrain)
 globalThis.rikiFixturePrepared=true
}
let preview,browser,context,page
const errors=[]
try{
 preview=await startPrivateComposed(8478)
 ;({browser}=await launchGpuBrowser(await loadChromium('rikigpugate'),'rikigpugate'))
 context=await browser.newContext({viewport:{width:1200,height:900}})
 page=await context.newPage();page.on('pageerror',e=>errors.push(e.message))
 // Adapt only the private response. The shipping main.js, AppBundle and user's browser
 // remain untouched; no actor snapshot/animation fields or gameplay rules are injected.
 await page.route('**/main.js',async route=>{
  const response=await route.fetch();let text=await response.text()
  assert.ok(text.includes('getAssemblyExports, getConfig, localHeapViewU8, runMain'))
  assert.ok(text.includes('const config = getConfig()'))
  text=text.replace('getAssemblyExports, getConfig, localHeapViewU8, runMain','getAssemblyExports, getConfig, localHeapViewU8, runMain, Module')
		text=text.replace('const config = getConfig()',`;(${prepareFixture.toString()})(Module.FS);\n const config = getConfig()`)
  await route.fulfill({response,body:text})
 })
 const url=new URL(preview.baseUrl)
 for(const [k,v] of Object.entries({quality:'medium',weather:'clear',daylight:'day'}))url.searchParams.set(k,v)
// The map fixture is injected into main.js's page-hosted bootInline below. Under
// the default worker host the simulation boots in sim-worker.js, which page
// routing never touches — the rewrite then never runs and the engine loads the
// stock Doubles map (126 Neutral actors, no staged e7/e1). worker=0 pins the
// staged boot the fixture depends on (same contract as motiongate).
url.searchParams.set('worker','0')
 await page.goto(url.href)
 await page.waitForFunction(()=>globalThis.steelseed?.ctx.session.available,undefined,{timeout:180000,polling:100})
 const catalog=await page.evaluate(()=>steelseed.ctx.session.getCatalog()),map=catalog.maps.find(m=>m.title==='Doubles')
 assert.ok(map,'Doubles fixture catalog entry')
 const config=configFor(catalog,map,{withBot:false});config.local.faction='england';config.slots[0].faction='england'
 Object.assign(config.options,{fog:'False',explored:'True',crates:'False'})
 await page.evaluate(c=>steelseed.ctx.session.startSkirmish(c),config)
 await page.waitForFunction(()=>steelseed.ctx.snapshot?.actors?.count>0&&document.getElementById('session-ui').hidden,undefined,{timeout:180000,polling:100})
 await page.addScriptTag({content:probe.outputFiles[0].text})
 const start=await page.evaluate(expected=>{
  const ctx=steelseed.ctx,u=ctx.get('units'),r=ctx.get('render'),anim=ctx.get('anim'),a=ctx.snapshot.actors
  const find=type=>{for(let i=0;i<a.count;i++)if(ctx.actorTypeName(a.typeId[i])===type)return{id:a.id[i],x:a.posX[i]/1024,z:a.posY[i]/1024,health:a.health[i]};throw Error('Missing '+type)}
  const actor=find('e7'),shooter=find('e1'),assets=u.rikiAssets,b=u.slotBuckets.get('e7'),sk=b.rig.skeleton
  if(!rikiFixturePrepared||!assets||sk.boneCount!==26||!u.rikiRigs.has(b.rig))throw Error('Missing native rig')
  if(b.item.surfaceSet!=='riki-meshy-v1'||u.roleActors.get('e7')!=='riki-meshy-v1'||ctx.get('materials').get('riki-meshy-v1').sourceSha256!==expected.sha)throw Error('Native material/profile mismatch')
  if(b.mesh.lods.map(l=>l.indexCount/3).join(',')!==expected.triangles.join(','))throw Error('Native LOD mismatch')
  const cam=ctx.get('camera');cam.focusWorld(actor.x,actor.z);cam.height=cam.heightGoal=1.4;cam.yaw=cam.yawGoal=.5
  const pose=new rikiGpuProbe.Pose(sk),world=sk.createMatrixBuffer(),skin=sk.createMatrixBuffer()
  const w=globalThis.rikiGpuWitness={actor,shooter,frames:[],orders:[],gpuErrors:[],deviceLost:null,serial:0,maxPaletteError:0,maxUploadError:0,uploads:0,draws:0,submits:0,firstProne:null,recovered:null,fixtureOnly:true}
  r.device.addEventListener('uncapturederror',e=>w.gpuErrors.push(e.error.message))
  r.device.lost.then(info=>{w.deviceLost={reason:info.reason,message:info.message}})
  const order=(name,id,target=0,x=-1,z=-1)=>{
   const result=steelseed.bridge.issueOrder({orderString:name,subjectIds:Uint32Array.of(id),targetActorId:target,targetCellX:x,targetCellY:z,queued:false,targetString:'',extraData:0})
   w.orders.push({name,id,target,x,z,result});return result
  }
  globalThis.rikiGateOrder=order
  order('SetUnitStance',actor.id);order('SetUnitStance',shooter.id)
  const queue=r.device.queue,write=queue.writeBuffer.bind(queue),submit=queue.submit.bind(queue)
  let uploaded=null
  queue.writeBuffer=function(buffer,offset,data,dataOffset=0,size){
   if(buffer===r.boneBuffer){
    const bytes=ArrayBuffer.isView(data)?new Uint8Array(data.buffer,data.byteOffset+(dataOffset*(data.BYTES_PER_ELEMENT??1)),(size??data.length)*(data.BYTES_PER_ELEMENT??1)):new Uint8Array(data,dataOffset,size??data.byteLength-dataOffset)
    uploaded=new Float32Array(bytes.slice().buffer);w.uploads++
   }
   return write(buffer,offset,data,dataOffset,size)
  }
  queue.submit=function(cmds){w.submits++;return submit(cmds)}
  const passProto=GPURenderPassEncoder.prototype,origIndex=passProto.setIndexBuffer,origDraw=passProto.drawIndexed,indices=new WeakMap(),native=new Set(b.mesh.lods.map(l=>l.indexBuffer))
  passProto.setIndexBuffer=function(buffer,...args){indices.set(this,buffer);return origIndex.call(this,buffer,...args)}
  passProto.drawIndexed=function(...args){if(native.has(indices.get(this)))w.draws++;return origDraw.apply(this,args)}
  const encode=r.encodeFrame.bind(r)
  r.encodeFrame=function(){
   const a=ctx.snapshot.actors;let ai=-1
   for(let i=0;i<a.count;i++)if(a.id[i]===actor.id){ai=i;break}
   let row=null
   if(ai>=0)for(let it=0;it<r.itemCount;it++){
    const item=r.items[it];if(item!==b.item)continue
    for(let n=0;n<item.instanceCount;n++)if(item.motionIds[n]===actor.id){
     const distance=anim.interpolatedDistanceOf(actor.id,ctx.time.alpha)/(u.slotGround.get('e7')?.fitScale??1)
     const moving=Math.abs(anim.interpolatedDistanceOf(actor.id,1)-anim.interpolatedDistanceOf(actor.id,0))>1e-6,prone=a.animState[ai]===2
     rikiGpuProbe.poseRiki(assets,pose,distance,moving,anim.interpolatedAimOf(actor.id,ctx.time.alpha),anim.secondsSinceFire(actor.id,ctx.time.alpha),prone)
     rikiGpuProbe.computeWorldTransforms(pose,world);rikiGpuProbe.computeSkinMatrices(sk,world,skin)
     const base=item.paletteBases[n]*16;let paletteError=0,uploadError=0
     for(let k=0;k<skin.length;k++){paletteError=Math.max(paletteError,Math.abs(r.boneData[base+k]-skin[k]));uploadError=Math.max(uploadError,Math.abs((uploaded?.[base+k]??Infinity)-skin[k]))}
     w.maxPaletteError=Math.max(w.maxPaletteError,paletteError);w.maxUploadError=Math.max(w.maxUploadError,uploadError)
     row={serial:++w.serial,tick:ctx.time.tick,prone,moving,distance,health:a.health[ai],speed:a.speed[ai],x:a.posX[ai]/1024,z:a.posY[ai]/1024,paletteBase:item.paletteBases[n],included:!!r.itemIncluded[it],mainInstances:Array.from(r.itemMainCount.slice(it*3,it*3+3)),paletteError,uploadError,palette:Array.from(skin),position:Array.from(item.instances.subarray(n*16+12,n*16+15))}
     if(prone&&!w.firstProne){w.firstProne={tick:row.tick,health:row.health};order('Stop',shooter.id);order('Move',actor.id,0,26,10)}
     if(w.firstProne&&!prone&&!w.recovered)w.recovered={tick:row.tick,health:row.health}
    }
   }
   const draws=w.draws,submits=w.submits,result=encode()
   if(row){row.gpuDraws=w.draws-draws;row.gpuSubmits=w.submits-submits;w.latest=row;if(w.frames.length<1500)w.frames.push({...row,palette:undefined})}
   return result
  }
  return {actor,shooter,bones:sk.boneCount,surface:b.item.surfaceSet,alphaCutout:b.item.alphaCutout===true,triangles:b.mesh.lods.map(l=>l.indexCount/3),sourceSha:assets.manifest.parentSourceSha256,otherRoles:['e1','e2','e3','spy'].map(n=>[n,u.roleActors.get(n)??null])}
 },{sha:manifest.parentSourceSha256,triangles:manifest.levels.map(l=>l.triangles)})
 await page.waitForFunction(()=>rikiGpuWitness.latest?.gpuDraws>0&&rikiGpuWitness.latest?.included&&rikiGpuWitness.latest.mainInstances.some(n=>n>0),undefined,{timeout:30000,polling:50})
 const initial=await page.evaluate(()=>rikiGpuWitness.latest)
 await page.screenshot({path:join(out,'riki-standing.png')})
 const forceAttack=await page.evaluate(()=>{
  const w=rikiGpuWitness,result=steelseed.bridge.issueContextOrder({subjectIds:Uint32Array.of(w.shooter.id),targetActorId:w.actor.id,targetCellX:10,targetCellY:10,targetFrozen:false,modifiers:1})
  w.orders.push({name:'ForceAttack',result});return result
 })
 assert.match(forceAttack,/ForceAttack/)
 await page.waitForFunction(()=>rikiGpuWitness.latest?.prone&&rikiGpuWitness.latest?.moving&&rikiGpuWitness.latest.distance>.04,undefined,{timeout:45000,polling:20})
 await page.evaluate(()=>steelseed.ctx.session.setPaused(true))
 await page.waitForFunction(()=>(steelseed.ctx.snapshot.flags&2)!==0,undefined,{timeout:10000,polling:20})
 await page.waitForTimeout(200)
 const prone=await page.evaluate(()=>{const w=rikiGpuWitness,c=steelseed.ctx.get('camera');c.focusWorld(w.latest.x,w.latest.z);return w.latest})
 await page.waitForTimeout(200);await page.screenshot({path:join(out,'riki-prone.png')})
 const paused=await page.evaluate(()=>rikiGpuWitness.latest)
 await page.waitForFunction(serial=>rikiGpuWitness.latest.serial>=serial+3,paused.serial,{timeout:15000,polling:50})
 const held=await page.evaluate(()=>rikiGpuWitness.latest)
 assert.deepEqual(held.palette,paused.palette,'Paused prone palette stable')
 assert.deepEqual(held.position,paused.position,'Paused position stable')
 await page.evaluate(()=>steelseed.ctx.session.setPaused(false))
 await page.waitForFunction(()=>rikiGpuWitness.recovered&&rikiGpuWitness.latest.moving&&!rikiGpuWitness.latest.prone,undefined,{timeout:25000,polling:20})
 const moving=await page.evaluate(()=>{const w=rikiGpuWitness,c=steelseed.ctx.get('camera');c.focusWorld(w.latest.x,w.latest.z);return w.latest})
 await page.evaluate(()=>steelseed.ctx.session.setPaused(true));await page.waitForTimeout(200)
 await page.screenshot({path:join(out,'riki-moving-recovered.png')})
 const portrait=await page.evaluate(async asset=>{const url=new URL('./assets/'+asset,location.href),res=await fetch(url),buf=await res.arrayBuffer(),img=new Image();img.src=url.href;await img.decode();return {status:res.status,bytes:buf.byteLength,width:img.naturalWidth,height:img.naturalHeight,sha:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buf))).map(n=>n.toString(16).padStart(2,'0')).join('')}},portraitAsset)
 const report=await page.evaluate(()=>({witness:rikiGpuWitness,skin:steelseed.ctx.get('units').skinStats,hostFailure:globalThis.steelseedHostFailure??null}))
assert.equal(start.bones,26);assert.ok(prone.prone&&prone.health<initial.health,'Prone followed positive actual damage')
assert.equal(start.surface,'riki-meshy-v1');assert.equal(start.alphaCutout,false,'Riki must use the opaque forward pipeline')
 assert.ok(report.witness.frames.some(f=>f.prone&&f.moving&&f.gpuDraws>0&&f.included&&f.mainInstances.some(n=>n>0)),'Prone movement reached main-view GPU draw')
 assert.ok(report.witness.frames.some(f=>!f.prone&&f.moving&&f.gpuDraws>0&&f.included&&f.mainInstances.some(n=>n>0)),'Upright movement reached main-view GPU draw')
 assert.ok(report.witness.recovered.tick-report.witness.firstProne.tick>=49&&report.witness.recovered.tick-report.witness.firstProne.tick<=52,'Stock prone timeout')
 assert.equal(report.witness.recovered.health,report.witness.firstProne.health,'No additional hit refreshed prone')
 assert.notDeepEqual(prone.palette,initial.palette);assert.notDeepEqual(moving.palette,prone.palette)
 assert.ok(report.witness.maxPaletteError<2e-6&&report.witness.maxUploadError<2e-6,'Submitted and GPU-uploaded palette follows production mixer')
 assert.ok(report.witness.uploads>10&&report.witness.draws>10&&report.witness.submits>10)
 assert.equal(portrait.sha,hash(portraitBytes));assert.ok(portrait.width>0&&portrait.height>0)
 assert.equal(report.skin.paletteOverflows,0);assert.deepEqual(report.witness.gpuErrors,[]);assert.equal(report.witness.deviceLost,null);assert.equal(report.hostFailure,null);assert.deepEqual(errors,[])
 const summary={status:'PASS',start,portrait,opacity:{atlasAlphaMin:255,reverseTrianglesPerLod:manifest.levels.map(level=>level.doubleSidedMaterialBake.reverseTriangles),forwardPipeline:'opaque'},frames:report.witness.frames.length,firstProne:report.witness.firstProne,recovered:report.witness.recovered,maxPaletteError:report.witness.maxPaletteError,maxUploadError:report.witness.maxUploadError,actualIndexedDraws:report.witness.draws,actualQueueSubmits:report.witness.submits,pauseStable:true,scope:'Real e7 on a private flat test map in the composed production runtime. Ordinary force-fire causes TakeCover; ordinary Move causes native crawl/run palettes, verified at actual GPU buffer upload, indexed draw and captured gameplay frames. The atlas is fully opaque and every LOD carries reverse-facing body geometry. Portrait verifies exact built bytes and browser decode; production-card interaction, crawl-fire combat, slopes/crowds and broad gameplay are not claimed.'}
 writeFileSync(join(out,'report.json'),JSON.stringify({summary,...report},null,2)+'\n')
 console.log('RIKI_GPU_GATE_PASS',JSON.stringify(summary))
}catch(error){
 if(page)try{writeFileSync(join(out,'failure.json'),JSON.stringify({error:String(error.stack??error),errors,state:await page.evaluate(()=>({witness:globalThis.rikiGpuWitness,host:globalThis.steelseedHostFailure,body:document.body.innerText.slice(-2000)}))},null,2));await page.screenshot({path:join(out,'failure.png')})}catch{}
 throw error
}finally{await context?.close();await browser?.close();await preview?.close()}
