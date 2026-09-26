#!/usr/bin/env node
// Normal move orders exercise exploration/fog; no simulation reveal or HP edits.
import assert from'node:assert/strict'
import {mkdirSync,writeFileSync}from'node:fs'
import {resolve}from'node:path'
import {bootRuntime,configFor,renderPlayerIndex,waitForSnapshot}from'./runtime-fixture.mjs'
const out=resolve(import.meta.dirname,'../../../.artifacts/planx/bridge-visibility');mkdirSync(out,{recursive:true})
const r=await bootRuntime(),catalog=r.bridge.getSkirmishCatalog(),map=catalog.maps.find(m=>m.title==='River Crossing — STEELSEED');assert.ok(map)
assert.equal(r.bridge.startSkirmish(configFor(catalog,map,{withBot:false})).status,'loading');const rows=[]
function save(result,label){
 const {header:h,bytes}=result,v=h.view,sh=h.sections.get(6),count=v.getUint32(sh.offset,true),states=new Uint8Array(64*48)
 for(let i=0;i<count;i++){const p=sh.offset+4+i*8,start=v.getUint32(p,true),length=v.getUint16(p+4,true);states.fill(v.getUint8(p+6),start,start+length)}
 const bridge=[0,0,0];for(let z=21;z<26;z++)for(let x=28;x<36;x++)bridge[states[(z-1)*64+x-1]]++
 const row={label,tick:h.tick,unexplored:bridge[0],explored:bridge[1],visible:bridge[2]};rows.push(row);writeFileSync(resolve(out,`snapshot-${label}-${h.tick}.bin`),bytes);console.log(label,JSON.stringify(row));return row
}
let current=await waitForSnapshot(r,{minimumTick:0,timeoutMs:30000});assert.equal(save(current,'unexplored').visible,0)
current=await waitForSnapshot(r,{minimumTick:2});assert.ok(save(current,'discovery').visible>0)
let names=r.bridge.snapshotTypeTable().split('\n');writeFileSync(resolve(out,'types.json'),JSON.stringify(names));const h=current.header,v=h.view,s=h.sections.get(3),n=v.getUint32(s.offset,true),base=s.offset+8,tail=(base+n*28+3)&~3,local=renderPlayerIndex(h),units=[]
for(let i=0;i<n;i++){const type=names[v.getUint16(base+n*16+i*2,true)];if(v.getUint8(tail+i)===local&&['e1','jeep','2tnk','e6'].includes(type))units.push({id:v.getUint32(base+i*4,true),type})}
function move(id,x,z){assert.match(r.bridge.issueOrder({orderString:'Move',subjectIds:Uint32Array.of(id),targetActorId:0,targetCellX:x,targetCellY:z,queued:false,targetString:'',extraData:0}),/ok: issued 1\/1/)}
units.forEach((u,i)=>move(u.id,15,19+i*2));current=await waitForSnapshot(r,{minimumTick:302,timeoutMs:25000});const hidden=save(current,'fog');assert.equal(hidden.visible,0);assert.ok(hidden.explored>0)
const jeep=units.find(u=>u.type==='jeep');assert.ok(jeep);move(jeep.id,36,22);current=await waitForSnapshot(r,{minimumTick:602,timeoutMs:25000});assert.ok(save(current,'reveal').visible>0)
writeFileSync(resolve(out,'report.json'),JSON.stringify({schema:1,pass:true,normalMoveOrders:true,rows},null,2)+'\n');console.log('herobridgevisibilitygate: PASS — actual unexplored/discovered/fogged/revealed bridge cells');process.exit(0)
