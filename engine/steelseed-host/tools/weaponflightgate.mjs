#!/usr/bin/env node
// Real, unchanged weapon rules on a staged map. Observe fire -> immutable flight -> true impact.
import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {build} from '../../../web/node_modules/esbuild/lib/main.js'
import {bootVfsRuntime} from './runtime-vfs-fixture.mjs'
import {configFor,waitForSnapshot} from './runtime-fixture.mjs'
const root=resolve(import.meta.dirname,'../../..'),out=join(root,'.artifacts/air-naval/host-flights');mkdirSync(out,{recursive:true})
const bundle=await build({stdin:{contents:"export {SnapshotDecoder} from './src/core/snapshot'",resolveDir:join(root,'web')},bundle:true,write:false,format:'cjs',platform:'node',logLevel:'silent'})
const module={exports:{}};new Function('module','exports',bundle.outputFiles[0].text)(module,module.exports);const decoder=new module.exports.SnapshotDecoder()
const runtime=await bootVfsRuntime(fs=>{
 const dir='/openra/engine/mods/ra/maps/doubles',file=dir+'/map.yaml',text=fs.readFile(file,{encoding:'utf8'})
 const rows=[['Spawn0','mpspawn','Neutral',80,40],['Spawn1','mpspawn','Neutral',100,40],['Spawn2','mpspawn','Neutral',80,46],['Spawn3','mpspawn','Neutral',100,46],
 ['V2','v2rl','Multi0',12,12],['V2target','fact','Multi1',18,12],['Tank','4tnk','Multi0',12,24],['TankTarget','fact','Multi1',18,24],['Rocket','e3','Multi0',12,34],['RocketTarget','fact','Multi1',16,34],['Heli','heli','Multi0',28,12],['HeliTarget','fact','Multi1',33,12]]
 fs.writeFile(file,text.split('\nActors:\n')[0]+'\nActors:\n'+rows.map(([id,type,owner,x,z])=>`\t${id}: ${type}\n\t\tOwner: ${owner}\n\t\tLocation: ${x},${z}\n`).join(''))
 const n=112*54,terrain=new Uint8Array(5+n*5),v=new DataView(terrain.buffer);terrain[0]=1;v.setUint16(1,112,true);v.setUint16(3,54,true);for(let i=0;i<n;i++)v.setUint16(5+i*3,255,true);fs.writeFile(dir+'/map.bin',terrain)
})
const catalog=runtime.bridge.getSkirmishCatalog(),map=catalog.maps.find(m=>m.title==='Doubles'),config=configFor(catalog,map,{withBot:true})
config.options.explored='True';config.options.fog='False';config.local.faction='england';config.slots[0].faction='england';config.slots[1].faction='russia';assert.equal(runtime.bridge.startSkirmish(config).status,'loading')
let snap,names,latestBytes,orderIssued=false;const launches=new Map(),flights=new Map(),impacts=[],orders=[],observed=[]
const key=(actor,arm,shot)=>`${actor}/${arm}/${shot}`
function observe(header,bytes){
 bytes=bytes.subarray(0,header.length)
 snap=decoder.decode(bytes);names=runtime.bridge.snapshotTypeTable().split('\n');latestBytes=bytes
 for(const e of snap.events){const v=snap.view,o=e.offset
  if(e.kind===1){assert.equal(e.byteLength,30);const r={actor:v.getUint32(o,true),arm:v.getUint16(o+4,true),barrel:v.getUint16(o+24,true),shot:v.getUint32(o+26,true),weapon:names[v.getUint16(o+20,true)],tick:snap.tick,position:[v.getInt32(o+6,true),v.getInt32(o+10,true),v.getInt32(o+14,true)]};assert(r.shot>0);launches.set(key(r.actor,r.arm,r.shot),r)}
  if(e.kind===2){assert.equal(e.byteLength,34);const r={actor:v.getUint32(o+24,true),arm:v.getUint16(o+28,true),shot:v.getUint32(o+30,true),weapon:names[v.getUint16(o+22,true)],tick:snap.tick};impacts.push(r)}
 }
 const p=snap.projectiles
 if(p)for(let i=0;i<p.count;i++){
  if(p.kind[i]!==0||!p.launchShot?.[i])continue
  const k=key(p.sourceActorId[i],p.launchArmament[i],p.launchShot[i]),start=[p.launchX[i],p.launchY[i],p.launchZ[i]],old=flights.get(p.id[i])
  if(old){assert.deepEqual(old.launch,start,'immutable launch position');assert.equal(old.key,k,'flight identity remains stable');old.samples++}
  else {const fire=launches.get(k);assert(fire,'flight must bind an actual fire event');assert.equal(p.launchBarrel[i],fire.barrel);assert.deepEqual(start,fire.position,'event and flight share captured launch');flights.set(p.id[i],{id:p.id[i],key:k,weapon:fire.weapon,launch:start,samples:1})}
 }
 if((snap.flags&1)!==0)writeFileSync(join(out,'initial.ssnp'),bytes)
 if(process.argv.includes('--capture'))writeFileSync(join(out,`frame-${String(snap.tick).padStart(4,'0')}.ssnp`),bytes)
 if(snap.tick%10===0&&observed.length<40){observed.push({tick:snap.tick,projectiles:p?.count??0,events:snap.events.length,syncHash:snap.syncHash});writeFileSync(join(out,`tick-${snap.tick}.ssnp`),bytes)}
}
await waitForSnapshot(runtime,{minimumTick:10,onSnapshot:observe})
function find(type,x,z){const a=snap.actors;for(let i=0;i<a.count;i++)if(names[a.typeId[i]]===type&&Math.abs(a.posX[i]/1024-x)<3&&Math.abs(a.posY[i]/1024-z)<3)return a.id[i];throw Error('missing fixture '+type)}
for(const [type,x,z,tx,tz]of [['v2rl',12,12,18,12],['4tnk',12,24,18,24],['e3',12,34,16,34],['heli',28,12,33,12]]){
 const request={orderString:'Attack',subjectIds:Uint32Array.of(find(type,x,z)),targetActorId:find('fact',tx,tz),targetCellX:tx,targetCellY:tz};orders.push({type,result:runtime.bridge.issueOrder(request)})
}
await waitForSnapshot(runtime,{minimumTick:300,timeoutMs:40000,onSnapshot:observe})
const paired=impacts.filter(i=>launches.has(key(i.actor,i.arm,i.shot))),longFlights=[...flights.values()].filter(f=>f.samples>2)
const report={status:'passed',stagedMap:true,unchangedWeaponRules:true,orders,fireEvents:launches.size,flights:[...flights.values()],impacts,paired:paired.length,observed}
writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2));writeFileSync(join(out,'types.txt'),names.join('\n'))
assert(launches.size>5&&longFlights.length>2&&paired.length>2,'real fire/flight/impact chain must be exercised')
assert([...launches.values()].some(f=>f.weapon.toLowerCase()==='scud'),'SCUD launch required')
assert([...launches.values()].some(f=>f.barrel===1),'second real barrel required')
console.log('weaponflightgate: PASS',JSON.stringify({fire:launches.size,flights:flights.size,paired:paired.length,longFlights:longFlights.length}));process.exit(0)
