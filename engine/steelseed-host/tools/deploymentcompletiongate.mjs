// Authoritative make/operation/reverse witness. --staged installs only pending
// rule data into the host's virtual filesystem; ordinary mode tests shipping data.
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {build} from '../../../web/node_modules/esbuild/lib/main.js'
import {bootVfsRuntime} from './runtime-vfs-fixture.mjs'
import {bootRuntime,configFor,waitForSnapshot} from './runtime-fixture.mjs'
const root=resolve(import.meta.dirname,'../../..'),host=join(root,'engine/steelseed-host'),staged=process.argv.includes('--staged')
const out=join(root,'.artifacts/planx/deployment-completion/engine',staged?'staged':'shipping');mkdirSync(out,{recursive:true})
const bundled=await build({stdin:{contents:"export {SnapshotDecoder} from './src/core/snapshot'",resolveDir:join(root,'web')},bundle:true,write:false,format:'cjs',platform:'node',logLevel:'silent'})
const mod={exports:{}};new Function('module','exports',bundled.outputFiles[0].text)(mod,mod.exports);const decoder=new mod.exports.SnapshotDecoder()
const runtime=staged?await bootVfsRuntime(fs=>{
 const base='/openra/engine/mods/ra',path=base+'/sequences/structures.yaml'
 const text=fs.readFile(path,{encoding:'utf8'}),start=text.indexOf('\nfact:\n'),end=text.indexOf('\nproc:\n',start)
 assert.ok(start>=0&&end>start)
 const block=text.slice(start,end);assert.match(block,/\tmake:\n\t\tFilename: factmake.shp\n\t\tLength: 32\n/)
 fs.writeFile(path,text.slice(0,start)+block.replace(/(\tmake:\n\t\tFilename: factmake.shp\n\t\tLength: )32\n/,'$196\n\t\tTick: 40\n')+text.slice(end))
 for(const [source,target]of [['mod.yaml','mod.yaml'],['deployment-rules.yaml','rules/deployment-rules.yaml']])fs.writeFile(base+'/'+target,readFileSync(join(host,'mod',source)))
}):await bootRuntime()
const catalog=runtime.bridge.getSkirmishCatalog(),map=catalog.maps.find(m=>m.title==='Doubles');assert.ok(map)
const config=configFor(catalog,map,{withBot:false});config.local.faction='england';config.slots.find(s=>s.slot===config.local.slot).faction='england'
assert.equal(runtime.bridge.startSkirmish(config).status,'loading')
let snap,names,sourceId,targetId=0,firstTick=-1,earlyAttempt=false,lastFrame=0;const rows=[],orders=[]
function order(orderString,ids=[],targetString='',targetActorId=0){const result=runtime.bridge.issueOrder({orderString,subjectIds:Uint32Array.from(ids),targetActorId,targetCellX:-1,targetCellY:-1,queued:false,targetString,extraData:orderString==='StartProduction'?1:0});assert.equal(result,ids.length?'ok: issued 1/1 local orders':'ok: issued local player order');orders.push({orderString,result,tick:snap.tick});return result}
function observe(h,bytes){
 snap=decoder.decode(bytes);names=runtime.bridge.snapshotTypeTable().split('\n');const d=snap.deployments
 if(!d)return
 for(let i=0;i<d.count;i++){
  const o=d.byteOffset+i*32,v=d.view;if(v.getUint32(o+4,true)!==sourceId)continue
  targetId=v.getUint32(o,true);const frame=v.getUint16(o+22,true),frames=v.getUint16(o+24,true),ms=v.getUint16(o+26,true)
  if(firstTick<0)firstTick=h.tick
  const queues=snap.production.filter(q=>q.playerId===snap.world.renderPlayer),buildable=queues.flatMap(q=>q.items).filter(i=>names[i.actorType]==='powr'&&(i.flags&2)),queued=queues.reduce((n,q)=>n+q.itemsQueued,0)
  rows.push({tick:h.tick,id:targetId,frame,frames,ms,powerPlantBuildable:buildable.length,queued})
  if(frames){assert.equal(frames,96);assert.equal(ms,40);assert.equal(buildable.length,0,'Yard must not grant construction while walls close');assert.equal(queued,0,'Premature production order cannot queue');lastFrame=frame}
  if(frame>=40&&frames&&!earlyAttempt){earlyAttempt=true;order('StartProduction',[],'powr')}
 }
}
await waitForSnapshot(runtime,{minimumTick:5,onSnapshot:observe});const a=snap.actors
for(let i=0;i<a.count;i++)if(a.owner[i]===snap.world.renderPlayer&&names[a.typeId[i]]==='mcv')sourceId=a.id[i]
assert.ok(sourceId);order('DeployTransform',[sourceId])
await waitForSnapshot(runtime,{minimumTick:snap.tick+135,timeoutMs:30000,onSnapshot:observe})
assert.ok(earlyAttempt&&lastFrame>=94);assert.ok(rows.some(r=>r.frame===32&&r.frames===96));assert.ok(rows.some(r=>!r.frames&&r.powerPlantBuildable>0),'Completed yard must expose power-plant production')
order('StartProduction',[],'powr');await waitForSnapshot(runtime,{minimumTick:snap.tick+5,onSnapshot:observeAfter})
function observeAfter(h,bytes){snap=decoder.decode(bytes);names=runtime.bridge.snapshotTypeTable().split('\n')}
assert.ok(snap.production.some(q=>q.itemsQueued>0),'Completed yard accepts normal production')
order('CancelProduction',[],'powr');await waitForSnapshot(runtime,{minimumTick:snap.tick+4,onSnapshot:observeAfter})
const sellStart=snap.tick;order('Sell',[targetId], '',targetId);const reverse=[]
await waitForSnapshot(runtime,{minimumTick:sellStart+115,timeoutMs:25000,onSnapshot(h,bytes){observeAfter(h,bytes);const d=snap.deployments;if(d)for(let i=0;i<d.count;i++){const o=d.byteOffset+i*32;if(d.view.getUint32(o,true)===targetId)reverse.push({tick:h.tick,frame:d.view.getUint16(o+22,true),frames:d.view.getUint16(o+24,true)})}}})
assert.ok(reverse.some(r=>r.frames===96&&r.frame>80));assert.ok(reverse.some(r=>r.frames===96&&r.frame<10));assert.ok(reverse.at(-1).tick-sellStart>=94,'Reverse lasts the full closure interval');assert.ok(!Array.from(snap.actors.id.subarray(0,snap.actors.count)).includes(targetId),'Sold yard removed normally')
writeFileSync(join(out,'report.json'),JSON.stringify({status:'PASS',stagedRulesInMemory:staged,unchangedShippingAssemblies:true,sourceId,targetId,firstTick,forwardFrames:96,normalFrameMs:40,oldPhaseFrames:32,orders,rows,reverse,scope:'Actual host map/deploy, premature production rejection, production after completion and reverse sell. No simulation-state edits.'},null,2)+'\n')
console.log('DEPLOYMENT_COMPLETION_ENGINE_PASS',staged?'staged':'shipping',rows.length,reverse.length);process.exit(0)
