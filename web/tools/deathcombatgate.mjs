#!/usr/bin/env node
// Real OpenRA damage/death through contextual forced attack, not snapshot/event injection.
import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {WEB_ROOT,launchGpuBrowser,loadChromium} from './harness.mjs'
import {configFor} from '../../engine/steelseed-host/tools/runtime-fixture.mjs'
import {startPrivateComposed} from './private-composed-preview.mjs'
const out=join(WEB_ROOT,'.artifacts/visual-quality/death-combat');mkdirSync(out,{recursive:true})
let preview,browser,context
try{
 preview=await startPrivateComposed()
 ;({browser}=await launchGpuBrowser(await loadChromium('deathcombatgate'),'deathcombatgate'))
 context=await browser.newContext({viewport:{width:1200,height:900},recordVideo:{dir:out,size:{width:1200,height:900}}})
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto(`${preview.baseUrl}?mode=game&platform=null&quality=medium&weather=clear&daylight=day`)
 await page.waitForFunction(()=>globalThis.steelseed?.ctx.session.available,undefined,{timeout:180000,polling:100})
 const catalog=await page.evaluate(()=>steelseed.ctx.session.getCatalog()),map=catalog.maps.find(m=>m.title==='Marigold Town')??catalog.maps[0]
 const config=configFor(catalog,map,{withBot:false}),faction=['england','germany','france','allies'].find(id=>map.factions.some(f=>f.id===id))
 assert.ok(faction);config.local.faction=faction;config.slots.find(s=>s.slot===config.local.slot).faction=faction
 Object.assign(config.options,{startingunits:'heavy',explored:'True',fog:'False',crates:'False'})
 await page.evaluate(c=>steelseed.ctx.session.startSkirmish(c),config)
 await page.waitForFunction(()=>steelseed.ctx.snapshot?.actors?.count>0&&document.getElementById('session-ui').hidden,undefined,{timeout:180000,polling:100})
 const start=await page.evaluate(()=>{
  const ctx=steelseed.ctx,a=ctx.snapshot.actors,out=[]
  for(let i=0;i<a.count;i++)if(a.owner[i]===ctx.snapshot.world.renderPlayer)out.push({id:a.id[i],type:ctx.actorTypeName(a.typeId[i]),x:a.posX[i]/1024,z:a.posY[i]/1024})
  globalThis.deathWitness={events:[],orders:[],frames:[]}
  ctx.events.on('sim:actor:destroyed',e=>{const id=ctx.snapshot.view.getUint32(e.offset,true),u=ctx.get('units');deathWitness.events.push({id,tick:ctx.time.tick,kind:u.deathKindOf(id),births:u.deathStats.births})})
  const units=ctx.get('units'),update=units.update.bind(units)
  units.update=(dt,c)=>{update(dt,c);if(units.deathStats.active&&deathWitness.frames.length<4000)deathWitness.frames.push({tick:c.time.tick,...units.deathStats})}
  return out
 })
 console.log('deathcombatgate starting roster',JSON.stringify(start.map(a=>({id:a.id,type:a.type}))))
 const human=start.find(a=>a.type==='e1'),victim=start.find(a=>a.type==='1tnk'),guns=start.filter(a=>['1tnk','2tnk','3tnk','4tnk'].includes(a.type)&&a.id!==victim?.id)
 assert.ok(human&&victim&&guns.length,JSON.stringify(start))
 for(const target of [human,victim]){
  await page.evaluate(t=>{const cam=steelseed.ctx.get('camera');cam.focusWorld(t.x,t.z);cam.height=cam.heightGoal=7;cam.yaw=cam.yawGoal=.4},target)
  await page.waitForTimeout(500)
  await page.screenshot({path:join(out,`${target.type}-before.png`)})
  await page.evaluate(async ({target,guns})=>{
   const subjects=guns.map(a=>a.id),result=await steelseed.bridge.issueContextOrder({subjectIds:Uint32Array.from(subjects),subjectCount:subjects.length,targetActorId:target.id,targetCellX:Math.floor(target.x),targetCellY:Math.floor(target.z),targetFrozen:false,modifiers:1})
   deathWitness.orders.push({subjects,target:target.id,modifiers:1,result})
  },{target,guns})
  await page.waitForFunction(id=>deathWitness.events.some(e=>e.id===id),target.id,{timeout:90000,polling:25})
  await page.screenshot({path:join(out,`${target.type}-death.png`)})
  await page.waitForTimeout(1100);await page.screenshot({path:join(out,`${target.type}-fallen.png`)})
  await page.waitForTimeout(5500)
 }
const report=await page.evaluate(()=>({witness:deathWitness,deaths:steelseed.ctx.get('units').deathStats,skins:steelseed.ctx.get('units').skinStats,fx:steelseed.ctx.get('fx').stats,tick:steelseed.ctx.time.tick}))
 writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2))
 assert.deepEqual(errors,[])
 for(const t of [human,victim]){
  assert.ok(report.witness.events.some(e=>e.id===t.id),`${t.type}: authoritative destruction event required`)
  assert.ok(report.witness.orders.some(o=>o.target===t.id&&o.modifiers===1&&/Attack/.test(o.result)),`${t.type}: force attack must resolve in OpenRA; orders=${JSON.stringify(report.witness.orders)}`)
 }
 assert.ok(report.witness.frames.some(f=>f.humans>0),'human retained fall reached actual frame')
 assert.ok(report.witness.frames.some(f=>f.vehicles>0&&f.parts>0),'detached vehicle parts reached actual frame')
 assert.equal(report.deaths.active,0,'corpses must expire')
 assert.equal(report.deaths.dropped,0,'normal real combat must not exhaust the death palette')
 console.log('deathcombatgate PASS',JSON.stringify({events:report.witness.events,orders:report.witness.orders,frames:report.witness.frames.length,tick:report.tick}))
}finally{await context?.close();await browser?.close();await preview?.close()}
