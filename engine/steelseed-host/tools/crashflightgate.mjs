#!/usr/bin/env node
// Real, unchanged weapon rules on a staged map. Observe fire -> immutable flight -> true impact.
import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {build} from '../../../web/node_modules/esbuild/lib/main.js'
import {bootVfsRuntime} from './runtime-vfs-fixture.mjs'
import {configFor,waitForSnapshot} from './runtime-fixture.mjs'
const root=resolve(import.meta.dirname,'../../..'),out=join(root,'.artifacts/air-naval/host-crashes');mkdirSync(out,{recursive:true})
const bundle=await build({stdin:{contents:"export {SnapshotDecoder} from './src/core/snapshot'",resolveDir:join(root,'web')},bundle:true,write:false,format:'cjs',platform:'node',logLevel:'silent'})
const module={exports:{}};new Function('module','exports',bundle.outputFiles[0].text)(module,module.exports);const decoder=new module.exports.SnapshotDecoder()
const runtime=await bootVfsRuntime(fs=>{
 const dir='/openra/engine/mods/ra/maps/doubles',file=dir+'/map.yaml',text=fs.readFile(file,{encoding:'utf8'})
 const rows=[['Spawn0','mpspawn','Neutral',80,40],['Spawn1','mpspawn','Neutral',100,40],['Spawn2','mpspawn','Neutral',80,46],['Spawn3','mpspawn','Neutral',100,46]]
 for(const [i,name]of ['heli','mig','tran','hind','yak','mh60','badr'].entries()){
  const x=12+(i%3)*6,z=12+Math.floor(i/3)*6;rows.push(['Gun'+i,'4tnk','Multi0',x,z],['Air'+i,name,'Multi1',x+3,z])
 }
 fs.writeFile(file,text.split('\nActors:\n')[0]+'\nActors:\n'+rows.map(([id,type,owner,x,z])=>`\t${id}: ${type}\n\t\tOwner: ${owner}\n\t\tLocation: ${x},${z}\n`+(id.startsWith('Air')?`\t\tCenterPosition: ${Math.round((x+.5)*1024)},${Math.round((z+.5)*1024)},4096\n\t\tHealth: 5\n`:'')).join(''))
 const n=112*54,terrain=new Uint8Array(5+n*5),v=new DataView(terrain.buffer);terrain[0]=1;v.setUint16(1,112,true);v.setUint16(3,54,true);for(let i=0;i<n;i++)v.setUint16(5+i*3,255,true);fs.writeFile(dir+'/map.bin',terrain)
})
const catalog=runtime.bridge.getSkirmishCatalog(),map=catalog.maps.find(m=>m.title==='Doubles'),config=configFor(catalog,map,{withBot:true})
config.options.explored='True';config.options.fog='False';config.local.faction='england';config.slots[0].faction='england';config.slots[1].faction='russia';assert.equal(runtime.bridge.startSkirmish(config).status,'loading')
let snap,names;const deaths=[],removed=[],parents=new Map(),samples=[],orders=[]
function observe(header,bytes){
 bytes=bytes.subarray(0,header.length);snap=decoder.decode(bytes);names=runtime.bridge.snapshotTypeTable().split('\n')
 for(const e of snap.events)if(e.kind===5)deaths.push({id:snap.view.getUint32(e.offset,true),tick:snap.tick})
 for(const e of snap.lifecycle)if(e.kind===1)removed.push({id:e.actorId??e.id,tick:snap.tick})
 const a=snap.actors
 for(let i=0;i<a.count;i++)if(a.crashParentId?.[i]){
  assert((a.flags[i]&8)!==0,'falling husks must switch off active movement audio and rotors')
  const parent=a.crashParentId[i],old=parents.get(a.id[i]);if(old)assert.equal(old.parent,parent);else parents.set(a.id[i],{parent,type:names[a.typeId[i]],id:a.id[i],samples:0,minAltitude:Infinity,maxAltitude:0})
  const row=parents.get(a.id[i]);row.samples++;row.minAltitude=Math.min(row.minAltitude,a.posZ[i]);row.maxAltitude=Math.max(row.maxAltitude,a.posZ[i])
 }
 if((snap.flags&1)!==0)writeFileSync(join(out,'initial.ssnp'),bytes)
 writeFileSync(join(out,`frame-${String(snap.tick).padStart(4,'0')}.ssnp`),bytes)
}
await waitForSnapshot(runtime,{minimumTick:2,onSnapshot:observe})
const a=snap.actors
for(let i=0;i<a.count;i++)if(names[a.typeId[i]]==='4tnk'){
 let target=-1,distance=Infinity
 for(let j=0;j<a.count;j++)if(['heli','mig','tran','hind','yak','mh60','badr'].includes(names[a.typeId[j]])){
  const d=(a.posX[i]-a.posX[j])**2+(a.posY[i]-a.posY[j])**2;if(d<distance){distance=d;target=j}
 }
 if(target>=0)orders.push({source:a.id[i],target:a.id[target],type:names[a.typeId[target]],result:runtime.bridge.issueOrder({orderString:'Attack',subjectIds:Uint32Array.of(a.id[i]),targetActorId:a.id[target],targetCellX:Math.floor(a.posX[target]/1024),targetCellY:Math.floor(a.posY[target]/1024)})})
}
await waitForSnapshot(runtime,{minimumTick:220,timeoutMs:40000,onSnapshot:observe})
const linked=[...parents.values()],report={status:'failed',unchangedRules:true,stagedMap:true,orders,deaths,removed,linked}
writeFileSync(join(out,'types.txt'),names.join('\n'));writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2))
assert(linked.length>=4,'at least four real shootdowns required')
for(const row of linked){assert(deaths.some(d=>d.id===row.parent),'husk must identify the destroyed aircraft');assert(row.samples>3&&row.maxAltitude-row.minAltitude>1024,'husk must really fall');assert(removed.some(d=>d.id===row.id),'husk must finish its real crash')}
report.status='passed';writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2));
console.log('crashflightgate PASS',JSON.stringify(report));process.exit(0)
