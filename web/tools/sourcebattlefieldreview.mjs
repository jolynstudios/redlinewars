#!/usr/bin/env node
// Real composed match + authoritative deployment/production/placement. No actor or cell edits.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchGpuBrowser, loadChromium, WEB_ROOT } from './harness.mjs'
import { configFor } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'

const base=process.argv.find(a=>a.startsWith('--url='))?.slice(6)??'http://127.0.0.1:8321/steelseed/index.html'
const labelPrefix=process.argv.find(a=>a.startsWith('--label='))?.slice(8)??'phase0-masked'
const foliage=process.argv.includes('--foliage')
const meadow=process.argv.includes('--meadow')
assert.match(labelPrefix,/^[a-z0-9-]+$/)
const out=join(WEB_ROOT,'.artifacts/visual-quality');mkdirSync(out,{recursive:true})
const {browser}=await launchGpuBrowser(await loadChromium('sourcebattlefieldreview'),'sourcebattlefieldreview')
try{
 const page=await browser.newPage({viewport:{width:1512,height:982},deviceScaleFactor:1}),errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 await page.goto(`${base}?mode=game&platform=null&quality=high&weather=clear`,{waitUntil:'domcontentloaded'})
 await page.waitForFunction(()=>globalThis.steelseed?.ctx.session.available,undefined,{timeout:180000,polling:100})
 const catalog=await page.evaluate(()=>steelseed.ctx.session.getCatalog())
 const map=catalog.maps.find(m=>m.title==='Marigold Town')??catalog.maps[0]
 const config=configFor(catalog,map,{withBot:false})
 const faction=['england','germany','france','allies'].find(id=>map.factions.some(f=>f.id===id));assert.ok(faction)
 config.local.faction=faction;config.slots.find(s=>s.slot===config.local.slot).faction=faction
 config.options.startingunits='heavy';config.options.explored='True';config.options.fog='False';config.options.crates='False'
 config.gameSpeed=catalog.gameSpeeds.find(s=>s.id==='fastest')?.id??config.gameSpeed
 await page.evaluate(c=>steelseed.ctx.session.startSkirmish(c),config)
 await page.waitForFunction(()=>steelseed.ctx.snapshot?.actors?.count>0&&document.getElementById('session-ui').hidden,undefined,{timeout:180000,polling:100})
 const start=await page.evaluate(()=>{
  const ctx=steelseed.ctx,a=ctx.snapshot.actors,out={}
  for(let i=0;i<a.count;i++)if(a.owner[i]===ctx.snapshot.world.renderPlayer){
   const name=ctx.actorTypeName(a.typeId[i]);if(!out[name])out[name]={id:a.id[i],x:a.posX[i]/1024,z:a.posY[i]/1024}
  }
  return out
 })
 assert.ok(start.mcv,JSON.stringify(start));assert.ok(start['1tnk'],`Allied heavy roster: ${Object.keys(start)}`)
 await page.evaluate(id=>steelseed.ctx.issueOrder({orderString:'DeployTransform',subjectIds:Uint32Array.of(id)}),start.mcv.id)
 await page.waitForFunction(()=>{
  const ctx=steelseed.ctx,a=ctx.snapshot.actors
  for(let i=0;i<a.count;i++)if(a.owner[i]===ctx.snapshot.world.renderPlayer&&ctx.actorTypeName(a.typeId[i])==='fact')return true
  return false
 },undefined,{timeout:60000,polling:100})
 await page.waitForFunction(()=>steelseed.ctx.snapshot.production.some(q=>q.playerId===steelseed.ctx.snapshot.world.renderPlayer&&
  q.items.some(i=>steelseed.ctx.actorTypeName(i.actorType)==='powr'&&(i.flags&2)!==0)),undefined,{timeout:30000,polling:100})
 await page.evaluate(()=>steelseed.ctx.issueOrder({orderString:'StartProduction',subjectIds:new Uint32Array(0),targetString:'powr',extraData:1}))
 await page.waitForFunction(()=>steelseed.ctx.snapshot.production.some(q=>q.playerId===steelseed.ctx.snapshot.world.renderPlayer&&
  q.items.some(i=>steelseed.ctx.actorTypeName(i.actorType)==='powr'&&(i.flags&16)!==0)),undefined,{timeout:120000,polling:100})
 const placement=await page.evaluate(base=>{
  const ctx=steelseed.ctx,q=ctx.snapshot.production.find(q=>q.playerId===ctx.snapshot.world.renderPlayer&&q.items.some(i=>ctx.actorTypeName(i.actorType)==='powr'&&(i.flags&16)!==0))
  for(let radius=2;radius<=12;radius++)for(let z=-radius;z<=radius;z++)for(let x=-radius;x<=radius;x++){
   if(Math.max(Math.abs(x),Math.abs(z))!==radius)continue
   const request={queueId:q.queueId,actorType:'powr',cellX:Math.floor(base.x)+x,cellY:Math.floor(base.z)+z}
   if(ctx.placement.query(request)?.valid){const result=ctx.placement.place(request);if(result?.issued)return request}
  }
  throw new Error('No legal power-building placement')
 },start.mcv)
 await page.waitForFunction(()=>{
  const ctx=steelseed.ctx,a=ctx.snapshot.actors
  for(let i=0;i<a.count;i++)if(a.owner[i]===ctx.snapshot.world.renderPlayer&&ctx.actorTypeName(a.typeId[i])==='powr')return true
  return false
 },undefined,{timeout:30000,polling:100})
 const views=[]
 const targets=[['tank',start['1tnk'],4.5],['building',{x:placement.cellX+1,z:placement.cellY+1},6]]
 if(foliage){
  const tree=await page.evaluate(()=>{
   const ctx=steelseed.ctx,a=ctx.snapshot.actors
   for(let i=0;i<a.count;i++)if(ctx.actorTypeName(a.typeId[i])==='t01')return {id:a.id[i],x:a.posX[i]/1024,z:a.posY[i]/1024}
   return null
  })
  assert.ok(tree,'composed map must contain an actual authoritative t01 actor')
  targets.push(['foliage',tree,4.2])
 }
 for(const [label,target,height] of targets){
  await page.evaluate(({target,height})=>{
   const cam=steelseed.ctx.get('camera');cam.focusWorld(target.x,target.z);cam.height=cam.heightGoal=height;cam.yaw=cam.yawGoal=.4
  },{target,height})
  await page.waitForTimeout(1200)
  const stats=await page.evaluate(()=>{
   const ctx=steelseed.ctx,u=ctx.get('units'),r=ctx.get('render'),grass=u.scenery.pools.get('grass')
   return {tick:ctx.snapshot.tick,actors:ctx.snapshot.actors.count,tankSet:u.slotBuckets.get('1tnk')?.surfaceSet,
    buildingSet:u.slotBuckets.get('powr')?.surfaceSet,forge:u.forgeStats,draws:r.stats.drawCalls,triangles:r.stats.triangles,
    materialVram:ctx.get('materials').totalVramBytes,ground:ctx.get('materials').groundSourceStats,
    foliage:{set:u.slotBuckets.get('t01')?.surfaceSet,cutout:u.slotBuckets.get('t01')?.item.alphaCutout,instances:u.slotBuckets.get('t01')?.count},
    meadow:{set:grass?.item.surfaceSet,cutout:grass?.item.alphaCutout,instances:grass?.count,indices:grass?.item.mesh.indexCount,error:u.scenery.stats.error}}
  })
  assert.equal(stats.tankSet,'industrial-v1:1tnk');assert.equal(stats.buildingSet,'industrial-v1:powr');assert.equal(stats.forge.fallback,0)
  if(label==='foliage'){assert.equal(stats.foliage.set,'foliage-v1');assert.equal(stats.foliage.cutout,true);assert.ok(stats.foliage.instances>0)}
  if(meadow){assert.equal(stats.meadow.set,'meadow-v1');assert.equal(stats.meadow.cutout,true);assert.ok(stats.meadow.instances>0);assert.equal(stats.meadow.indices,108);assert.equal(stats.meadow.error,'')}
  await page.screenshot({path:join(out,`${labelPrefix}-${label}.png`)})
  views.push({label,...stats})
 }
 assert.deepEqual(errors,[])
 const report={date:new Date().toISOString(),map:map.title,tier:'high',dpr:1,config,placement,views,
  note:'Actual composed OpenRA: normal MCV deployment, paid power-building production and validated placement; no snapshot mutation. Authored texture sets and per-actor mask bindings verified.'}
 writeFileSync(join(out,`${labelPrefix}-match.json`),JSON.stringify(report,null,2))
 console.log('sourcebattlefieldreview: PASS',JSON.stringify(report))
}finally{await browser.close()}
