#!/usr/bin/env node
// Real engine starts catch player-owned map fixtures that ignore chosen spawns.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { bootRuntime, configFor, renderPlayerIndex, waitForSnapshot } from './runtime-fixture.mjs'
const output = resolve(import.meta.dirname, '../../../.artifacts/spawn')
mkdirSync(output, {recursive:true})
const runtime = await bootRuntime(), catalog = runtime.bridge.getSkirmishCatalog()
const results = []
const actors = h => {
 const v=h.view,s=h.sections.get(3),n=v.getUint32(s.offset,true),o=s.offset+8,tail=(o+n*28+3)&~3
 const names=runtime.bridge.snapshotTypeTable().split('\n')
 return Array.from({length:n},(_,i)=>({id:v.getUint32(o+i*4,true),x:v.getInt32(o+n*4+i*4,true)/1024,z:v.getInt32(o+n*8+i*4,true)/1024,type:names[v.getUint16(o+n*16+i*2,true)],owner:v.getUint8(tail+i)}))
}
try {
 for (const title of ['Agenda', 'River Crossing — STEELSEED']) {
  const map = catalog.maps.find(m=>m.title===title)
  assert.ok(map, `${title}: map missing`)
  for (const humanSlot of [0,1]) for (const humanSpawn of [1,2]) for (const preset of ['none','light','heavy']) {
   const config = configFor(catalog,map,{humanSlot,withBot:true})
   config.local.spawn=humanSpawn;config.local.faction='england';config.options.startingunits=preset
   config.options.crates='False';config.options.fog='False';config.options.explored='True'
   const human=config.slots.find(s=>s.kind==='human'),bot=config.slots.find(s=>s.kind==='bot')
   human.spawn=humanSpawn;human.faction='england';bot.spawn=3-humanSpawn;bot.faction='russia'
   assert.equal(runtime.bridge.startSkirmish(config).status,'loading')
   const {header}=await waitForSnapshot(runtime,{minimumTick:1,timeoutMs:30000})
   const own=actors(header).filter(a=>a.owner===renderPlayerIndex(header)),spawn=map.spawnPoints.find(p=>p.id===humanSpawn)
   const record={map:title,humanSlot,humanSpawn,preset,tick:header.tick,own,all:actors(header)};results.push(record)
   writeFileSync(resolve(output,'report.json'),JSON.stringify({pass:false,cases:results},null,2)+'\n')
   const enemyBase=actors(header).find(a=>a.owner!==renderPlayerIndex(header)&&a.type==='mcv')
   assert.ok(enemyBase,`${title}: AI MCV missing`)
   const enemy=actors(header).filter(a=>a.owner===enemyBase.owner),enemySpawn=map.spawnPoints.find(p=>p.id===3-humanSpawn)
   record.enemy=enemy
   writeFileSync(resolve(output,'report.json'),JSON.stringify({pass:false,cases:results},null,2)+'\n')
   assert.ok(own.some(a=>a.type==='mcv'),`${title}: human MCV missing`)
   assert.ok(own.every(a=>Math.hypot(a.x-spawn.x,a.z-spawn.y)<10),`${title}: human units split from spawn ${humanSpawn}`)
   assert.ok(enemy.every(a=>Math.hypot(a.x-enemySpawn.x,a.z-enemySpawn.y)<10),`${title}: AI units split from assigned opposite spawn`)
   if(preset==='none')assert.equal(own.length,1,`${title}: MCV-only contains extra units`)
   else assert.ok(own.length>1,`${title}: support missing`)
   const mcv=own.find(a=>a.type==='mcv')
   assert.match(runtime.bridge.issueOrder({orderString:'DeployTransform',subjectIds:Uint32Array.of(mcv.id),targetActorId:0,targetCellX:0,targetCellY:0,queued:false,targetString:'',extraData:0}),/ok: issued 1\/1/)
   const deployed=await waitForSnapshot(runtime,{minimumTick:header.tick+50,timeoutMs:15000})
   const yard=actors(deployed.header).find(a=>a.owner===renderPlayerIndex(deployed.header)&&a.type==='fact')
   assert.ok(yard,`${title}: MCV did not deploy`)
   assert.ok(Math.hypot(yard.x-mcv.x,yard.z-mcv.z)<4,`${title}: yard shifted from MCV`)
   record.yard=yard
   console.log(`spawngate: ${title} slot=${humanSlot} spawn=${humanSpawn} preset=${preset} PASS`)
  }
 }
 writeFileSync(resolve(output,'report.json'),JSON.stringify({pass:true,cases:results},null,2)+'\n')
 console.log(`spawngate: PASS — ${results.length} actual player/AI starts and MCV deployments`)
 process.exit(0)
} catch(error) {
 writeFileSync(resolve(output,'report.json'),JSON.stringify({pass:false,cases:results,error:error.stack},null,2)+'\n')
 throw error
}
