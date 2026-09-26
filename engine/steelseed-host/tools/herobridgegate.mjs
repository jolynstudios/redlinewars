#!/usr/bin/env node
import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {bootRuntime,configFor,renderPlayerIndex,waitForSnapshot} from './runtime-fixture.mjs'
const out=resolve(import.meta.dirname,'../../../.artifacts/planx/bridge-engine');mkdirSync(out,{recursive:true})
const runtime=await bootRuntime(),catalog=runtime.bridge.getSkirmishCatalog(),map=catalog.maps.find(m=>m.title==='River Crossing — STEELSEED')
assert.ok(map,'dedicated bridge map missing')
assert.equal(runtime.bridge.startSkirmish(configFor(catalog,map,{withBot:false})).status,'loading')
let current=await waitForSnapshot(runtime,{minimumTick:0,timeoutMs:30000}),names=runtime.bridge.snapshotTypeTable().split('\n'),local=renderPlayerIndex(current.header)
const report={schema:1,map:map.uid,orders:[],samples:[],terrain:[],stages:[]}
function actors(h){const v=h.view,s=h.sections.get(3),n=v.getUint32(s.offset,true),o=s.offset+8,tail=(o+n*28+3)&~3;return Array.from({length:n},(_,i)=>({id:v.getUint32(o+i*4,true),x:v.getInt32(o+n*4+i*4,true)/1024,z:v.getInt32(o+n*8+i*4,true)/1024,y:v.getInt32(o+n*12+i*4,true)/1024,type:names[v.getUint16(o+n*16+i*2,true)],owner:v.getUint8(tail+i),health:v.getUint8(tail+n+i)}))}
function save(){names=runtime.bridge.snapshotTypeTable().split('\n');writeFileSync(resolve(out,'types.json'),JSON.stringify(names));writeFileSync(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n')}
function terrain(h,label){const s=h.sections.get(1);if(!s)return;const v=h.view,w=v.getUint32(s.offset,true),height=v.getUint32(s.offset+4,true),world=h.sections.get(0),ox=v.getInt32(world.offset,true),oz=v.getInt32(world.offset+4,true);const n=w*height,base=s.offset+8;const rows=[];for(let z=21;z<=25;z++){const row=[];for(let x=28;x<36;x++)row.push(v.getUint8(base+n*3+(z-oz)*w+x-ox));rows.push(row)}report.terrain.push({label,tick:h.tick,w,height,ox,oz,rows});writeFileSync(resolve(out,`snapshot-${label}-${h.tick}.bin`),new Uint8Array(v.buffer,v.byteOffset,h.length))}
writeFileSync(resolve(out,'types.json'),JSON.stringify(names))
terrain(current.header,'initial')
current=await waitForSnapshot(runtime,{minimumTick:2});writeFileSync(resolve(out,'snapshot-discovery-2.bin'),current.bytes);names=runtime.bridge.snapshotTypeTable().split('\n');writeFileSync(resolve(out,'types.json'),JSON.stringify(names))
const all=actors(current.header);report.initial=all;save();console.log('INITIAL',JSON.stringify(all))
const bridge=all.find(a=>a.type==='ssherobridge');assert.ok(bridge,'bridge absent');assert.ok(bridge.health>0&&bridge.health<128,'map must start partially collapsed')
const own=t=>{const a=all.find(a=>a.type===t&&a.owner===local);assert.ok(a,'missing '+t);return a}
const foot=own('e1'),jeep=own('jeep'),tank=own('2tnk'),engineer=own('e6')
const huts=all.filter(a=>a.type==='bridgehut.small');assert.equal(huts.length,2)
function order(subject,kind,x,z,target=0){const result=runtime.bridge.issueOrder({orderString:kind,subjectIds:Uint32Array.of(subject.id),targetActorId:target,targetCellX:x,targetCellY:z,queued:false,targetString:'',extraData:0});assert.match(result,/ok: issued 1\/1/);report.orders.push({tick:current.header.tick,subject:subject.id,kind,x,z,target,result});save()}
async function advance(ticks,label,tracked=[]){current=await waitForSnapshot(runtime,{minimumTick:current.header.tick+ticks,timeoutMs:Math.max(15000,ticks*60),onSnapshot(h){const aa=actors(h);for(const id of tracked){const a=aa.find(a=>a.id===id);if(a)report.samples.push({label,tick:h.tick,...a})}terrain(h,label)}});report.stages.push({label,tick:current.header.tick,actors:actors(current.header)});save();console.log('STAGE',label,current.header.tick);return actors(current.header)}
order(foot,'Move',39,22);await advance(300,'foot-safe',[foot.id]);assert.ok(actors(current.header).find(a=>a.id===foot.id)?.x>36,'foot did not traverse healthy lane')
order(jeep,'Move',31,24);await advance(130,'jeep-gap-rejected',[jeep.id]);assert.ok(actors(current.header).find(a=>a.id===jeep.id)?.x<31,'jeep entered failed span')
order(jeep,'Move',39,24);order(tank,'Move',39,22);await advance(300,'vehicles-safe',[jeep.id,tank.id]);for(const id of [jeep.id,tank.id])assert.ok(actors(current.header).find(a=>a.id===id)?.x>36,'vehicle did not traverse safe lane')
for(const s of report.samples){assert.equal(s.y,0,'simulation elevation changed');if(s.x>=31&&s.x<33&&s.z>=21&&s.z<26)assert.ok(Math.floor(s.z)===22,'unit crossed blocked middle cell')}
const west=huts.sort((a,b)=>a.x-b.x)[0];order(engineer,'RepairBridge',-1,-1,west.id);await advance(220,'repair',[engineer.id,bridge.id]);assert.ok(actors(current.header).find(a=>a.id===bridge.id)?.health>=128,'engineer did not repair bridge')
order(tank,'ForceAttack',-1,-1,bridge.id);let dead=false;for(let i=0;i<12&&!dead;i++){await advance(250,'combat',[tank.id,bridge.id]);dead=actors(current.header).find(a=>a.id===bridge.id)?.health===0}assert.ok(dead,'normal tank fire did not destroy bridge within 3000 ticks')
order(jeep,'Move',25,22);await advance(160,'dead-reject',[jeep.id]);assert.ok(actors(current.header).find(a=>a.id===jeep.id)?.x>=36,'vehicle traversed fully failed bridge')
report.pass=true;save();console.log('herobridgegate: PASS — real foot/wheeled/tracked movement, failed-span rejection, engineer repair, combat destruction and dead crossing rejection');process.exit(0)
