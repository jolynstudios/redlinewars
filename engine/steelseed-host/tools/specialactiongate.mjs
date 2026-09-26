#!/usr/bin/env node
// Real OpenRA simulation, stock traits and orders. Only the test map actors/terrain
// are replaced in the in-memory VFS before initialization; never shipping files.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { build } from '../../../web/node_modules/esbuild/lib/main.js'
import { bootVfsRuntime } from './runtime-vfs-fixture.mjs'
import { configFor, waitForSnapshot } from './runtime-fixture.mjs'
const root = resolve(import.meta.dirname, '../../..'), out = join(root, '.artifacts/special-actions')
mkdirSync(out, { recursive: true })
const bundled = await build({ stdin: { contents: "export {SnapshotDecoder} from './src/core/snapshot'", resolveDir: join(root, 'web') }, bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent' })
const mod = { exports: {} }; new Function('module', 'exports', bundled.outputFiles[0].text)(mod, mod.exports)
const decoder = new mod.exports.SnapshotDecoder()
const runtime = await bootVfsRuntime(fs => {
 const dir = '/openra/engine/mods/ra/maps/doubles', file = dir + '/map.yaml'
 const text = fs.readFile(file, { encoding: 'utf8' })
 const actors = [
  ['Spawn0','mpspawn','Neutral',80,40], ['Spawn1','mpspawn','Neutral',100,40],
  ['Spawn2','mpspawn','Neutral',80,46], ['Spawn3','mpspawn','Neutral',100,46],
  ['Commando','e7','Multi0',10,10], ['DemolishTarget','barr','Multi1',14,10],
  ['Engineer','e6','Multi0',10,20], ['CaptureTarget','powr','Multi1',14,20],
  ['Spy','spy','Multi0',10,30], ['InfiltrateTarget','proc','Multi1',14,30],
  ['OwnBuilding','powr','Multi0',20,10], ['Rifle','e1','Multi0',10,12],
  ['Scenery','t01','Neutral',20,15],
 ]
 fs.writeFile(file, text.split('\nActors:\n')[0] + '\nActors:\n' + actors.map(([id,type,owner,x,y]) => `\t${id}: ${type}\n\t\tOwner: ${owner}\n\t\tLocation: ${x},${y}\n`).join(''))
 const width=112,height=54,n=width*height, terrain=new Uint8Array(5+n*5), view=new DataView(terrain.buffer)
 terrain[0]=1;view.setUint16(1,width,true);view.setUint16(3,height,true)
 for(let i=0;i<n;i++)view.setUint16(5+i*3,255,true)
 fs.writeFile(dir+'/map.bin',terrain)
})
const catalog=runtime.bridge.getSkirmishCatalog(), map=catalog.maps.find(m=>m.title==='Doubles')
assert.ok(map)
const config=configFor(catalog,map,{withBot:true})
config.options.explored='True'; config.options.fog='False'
config.local.faction='england';config.slots[0].faction='england';config.slots[1].faction='russia'
assert.equal(runtime.bridge.startSkirmish(config).status,'loading')
let snap,names,events=[],startCash=0
function observe(header,bytes){
 snap=decoder.decode(bytes); names=runtime.bridge.snapshotTypeTable().split('\n')
 for(const event of snap.events)if(event.kind===5)events.push({tick:snap.tick,kind:event.kind,id:snap.view.getUint32(event.offset,true),bytes:event.byteLength})
}
await waitForSnapshot(runtime,{minimumTick:10,onSnapshot:observe})
function actor(type,x,y){const a=snap.actors;for(let i=0;i<a.count;i++)if(names[a.typeId[i]]===type&&Math.abs(a.posX[i]/1024-x)<3&&Math.abs(a.posY[i]/1024-y)<3)return{id:a.id[i],owner:a.owner[i],x:Math.floor(a.posX[i]/1024),y:Math.floor(a.posY[i]/1024)};throw Error(`Missing ${type} at ${x},${y}`)}
const tanya=actor('e7',10,10),c4=actor('barr',14,10),engineer=actor('e6',10,20),capture=actor('powr',14,20),spy=actor('spy',10,30),infiltrate=actor('proc',14,30),own=actor('powr',20,10),rifle=actor('e1',10,12),tree=actor('t01',20,15)
const local=snap.world.renderPlayer
const intent=(subjects,target,modifiers=0)=>({subjectIds:Uint32Array.from(subjects.map(a=>a.id)),targetActorId:target.id,targetCellX:target.x,targetCellY:target.y,targetFrozen:false,modifiers})
const queries=[]
function query(subjects,target,expected){const request=intent(subjects,target),result=runtime.bridge.queryContextOrder(request);queries.push({subjects:subjects.map(a=>a.id),target:target.id,result});if(expected)assert.equal(result?.order,expected);return result}
query([tanya],c4,'C4');query([engineer],capture,'CaptureActor');query([spy],infiltrate,'Infiltrate')
query([rifle,tanya],c4,'C4')
assert.notEqual(query([tanya],own)?.order,'C4','Own buildings require explicit force attack')
assert.ok(!['Attack','C4'].includes(query([tanya],tree)?.order),'Untargetable tree must not offer attack/C4')
// Repeated previews must neither queue a mission nor change ownership or consume units.
for(let i=0;i<20;i++)query([engineer],capture,'CaptureActor')
await waitForSnapshot(runtime,{minimumTick:35,onSnapshot:observe})
assert.equal(actor('powr',14,20).owner,capture.owner)
assert.equal(actor('e6',10,20).id,engineer.id)
startCash=snap.players.find(p=>p.id===local).cash
const originalCountry=snap.players.find(p=>p.id===capture.owner).factionId
const orders=[]
for(const [subject,target,expected]of [[tanya,c4,'C4'],[engineer,capture,'CaptureActor'],[spy,infiltrate,'Infiltrate']]){
 const result=runtime.bridge.issueContextOrder(intent([subject],target));assert.ok(result.includes(`(${expected})`),result);orders.push({subject:subject.id,target:target.id,result})
}
let c4Gone=false,captured=false,spyGone=false,cashAfter=startCash,ownerCountry=null
function witness(header,bytes){observe(header,bytes);const a=snap.actors,index=id=>Array.from(a.id.subarray(0,a.count)).indexOf(id)
 for(const event of snap.events)if(event.kind===5&&snap.view.getUint32(event.offset,true)===c4.id)
  writeFileSync(join(out,'c4-destroyed-payload.bin'),bytes.slice(event.offset,event.offset+event.byteLength))
 c4Gone ||= index(c4.id)<0
 const ci=index(capture.id);if(ci>=0&&a.owner[ci]===local){captured=true;ownerCountry=snap.players.find(p=>p.id===a.owner[ci]).factionId}
 spyGone ||= index(spy.id)<0
 cashAfter=Math.max(cashAfter,snap.players.find(p=>p.id===local).cash)
}
await waitForSnapshot(runtime,{minimumTick:430,timeoutMs:30000,onSnapshot:witness})
const report={queries,orders,c4Gone,captured,spyGone,startCash,cashAfter,originalCountry,ownerCountry,events,scope:'Stock OpenRA traits; only in-memory fixture map. No force damage, ownership mutations or cheat orders.'}
writeFileSync(join(out,'engine-report.json'),JSON.stringify(report,null,2)+'\n')
assert.ok(c4Gone,'One C4 action must demolish the eligible building')
assert.ok(events.some(e=>e.id===c4.id),'Demolition must publish actorDestroyed for visible explosion/death renderer')
assert.ok(captured,'Engineer must transfer ownership after canonical delay')
assert.notEqual(originalCountry,ownerCountry,'Captured building must resolve its new owner country/flag')
assert.ok(spyGone&&cashAfter>startCash,'Spy must complete infiltration and transfer cash')
console.log('SPECIAL_ACTION_GATE_PASS',JSON.stringify({c4Gone,captured,spyGone,startCash,cashAfter,originalCountry,ownerCountry}))
process.exit(0)
