#!/usr/bin/env node
// Exact stock TakeCover state: real rifle damage -> moving prone -> recovery.
// No rules, hitpoints, traits or timers are modified; only test actors/map in VFS.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { build } from '../../../web/node_modules/esbuild/lib/main.js'
import { bootVfsRuntime } from './runtime-vfs-fixture.mjs'
import { configFor, waitForSnapshot } from './runtime-fixture.mjs'
const root=resolve(import.meta.dirname,'../../..'),out=join(root,'.artifacts/riki-prone')
mkdirSync(out,{recursive:true})
const code=await build({stdin:{contents:"export {SnapshotDecoder,ActorAnimationState,SNAPSHOT_U16_ABSENT,SNAPSHOT_VERSION} from './src/core/snapshot'",resolveDir:join(root,'web')},bundle:true,write:false,platform:'node',format:'cjs',logLevel:'silent'})
const module={exports:{}};new Function('module','exports',code.outputFiles[0].text)(module,module.exports)
const {SnapshotDecoder,ActorAnimationState,SNAPSHOT_U16_ABSENT,SNAPSHOT_VERSION}=module.exports,decoder=new SnapshotDecoder()
const runtime=await bootVfsRuntime(fs=>{
 const dir='/openra/engine/mods/ra/maps/doubles',file=dir+'/map.yaml',text=fs.readFile(file,{encoding:'utf8'})
 const actors=[['Spawn0','mpspawn',80,40],['Spawn1','mpspawn',100,40],['Spawn2','mpspawn',80,46],['Spawn3','mpspawn',100,46],['Riki','e7',10,10],['Shooter','e1',14,10]]
 fs.writeFile(file,text.split('\nActors:\n')[0]+'\nActors:\n'+actors.map(([id,type,x,y])=>`\t${id}: ${type}\n\t\tOwner: ${type==='mpspawn'?'Neutral':'Multi0'}\n\t\tLocation: ${x},${y}\n`).join(''))
 const width=112,height=54,n=width*height,terrain=new Uint8Array(5+n*5),v=new DataView(terrain.buffer)
 terrain[0]=1;v.setUint16(1,width,true);v.setUint16(3,height,true)
 for(let i=0;i<n;i++)v.setUint16(5+i*3,255,true)
 fs.writeFile(dir+'/map.bin',terrain)
})
const catalog=runtime.bridge.getSkirmishCatalog(),map=catalog.maps.find(m=>m.title==='Doubles'),config=configFor(catalog,map,{withBot:false})
config.local.faction='england';config.slots[0].faction='england';config.options.fog='False';config.options.explored='True'
assert.equal(runtime.bridge.startSkirmish(config).status,'loading')
let snap,names
function decode(header,bytes){assert.equal(header.version,SNAPSHOT_VERSION);snap=decoder.decode(bytes);names=runtime.bridge.snapshotTypeTable().split('\n');assert.ok(snap.actors.flags instanceof Uint8Array);assert.ok(snap.actors.animState instanceof Uint16Array)}
await waitForSnapshot(runtime,{minimumTick:10,onSnapshot:decode})
function actor(type){const a=snap.actors;for(let i=0;i<a.count;i++)if(names[a.typeId[i]]===type)return{id:a.id[i],index:i};throw Error('Missing '+type)}
const riki=actor('e7'),shooter=actor('e1'),initialHealth=snap.actors.health[riki.index]
assert.equal(snap.actors.animState[riki.index],SNAPSHOT_U16_ABSENT)
function order(name,subject,target=0,x=-1,y=-1,extraData=0){const result=runtime.bridge.issueOrder({orderString:name,subjectIds:Uint32Array.of(subject),targetActorId:target,targetCellX:x,targetCellY:y,queued:false,targetString:'',extraData});assert.ok(result.startsWith('ok: issued 1/1'),result);return result}
order('SetUnitStance',riki.id);order('SetUnitStance',shooter.id)
const fired=runtime.bridge.issueContextOrder({subjectIds:Uint32Array.of(shooter.id),targetActorId:riki.id,targetCellX:10,targetCellY:10,targetFrozen:false,modifiers:1})
assert.match(fired,/ForceAttack/)
let firstProne=-1,lastProne=-1,recovered=-1,hitHealth=null,extraDamage=false
const rows=[]
await waitForSnapshot(runtime,{minimumTick:230,timeoutMs:30000,onSnapshot(header,bytes){
 decode(header,bytes);const r=actor('e7'),a=snap.actors,state=a.animState[r.index],health=a.health[r.index],speed=a.speed[r.index]
 if(firstProne<0&&state===ActorAnimationState.prone){
  assert.ok(health<initialHealth,'Prone must follow actual positive rifle damage')
  firstProne=header.tick;hitHealth=health
  order('Stop',shooter.id);order('Move',riki.id,0,26,10)
  writeFileSync(join(out,'first-prone.snapshot'),bytes)
 }
 if(firstProne>=0){
  if(health!==hitHealth)extraDamage=true
  if(state===ActorAnimationState.prone)lastProne=header.tick
  else if(recovered<0)recovered=header.tick
  rows.push({tick:header.tick,state,health,speed,x:a.posX[r.index]/1024,y:a.posY[r.index]/1024})
 }
 assert.equal(a.animState[actor('e1').index],SNAPSHOT_U16_ABSENT,'Untouched soldier must not inherit prone state')
}})
const proneMoving=rows.filter(r=>r.state===ActorAnimationState.prone&&r.speed>0&&r.speed<0xffff)
const normalMoving=rows.filter(r=>r.tick>recovered+4&&r.state===SNAPSHOT_U16_ABSENT&&r.speed>0&&r.speed<0xffff)
const maxProne=Math.max(...proneMoving.map(r=>r.speed)),maxNormal=Math.max(...normalMoving.map(r=>r.speed))
const report={status:'PASS',fired,rikiId:riki.id,shooterId:shooter.id,firstProne,lastProne,recovered,activeTicks:recovered-firstProne,initialHealth,hitHealth,extraDamage,maxProne,maxNormal,rows,scope:'Canonical TakeCover from positive friendly force-fire. Stop shooter after first hit; ordinary Move for Riki. No rule/state mutations. Existing ABI v2 section and U8 flags layout unchanged.'}
writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n')
assert.ok(firstProne>=0&&recovered>firstProne,'Prone and recovery must both be observed')
assert.ok(recovered-firstProne>=49&&recovered-firstProne<=51,'Stock50tick prone duration must be respected')
assert.equal(extraDamage,false,'No further hits may reset the recovery witness')
assert.ok(proneMoving.length>5&&normalMoving.length>5,'Moving prone and upright movement must both be observed')
assert.ok(maxProne<=maxNormal*.6,'TakeCover must retain its stock half-speed locomotion')
console.log('PRONE_GATE_PASS',JSON.stringify({firstProne,recovered,activeTicks:recovered-firstProne,maxProne,maxNormal,hitHealth}))
process.exit(0)
