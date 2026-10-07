// Real AI deployment observed, hidden by scout retreat, then observed again.
// The only scenario change is one normally-owned scout placed in the map VFS.
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {build} from '../../../web/node_modules/esbuild/lib/main.js'
import {bootVfsRuntime} from './runtime-vfs-fixture.mjs'
import {configFor,waitForSnapshot} from './runtime-fixture.mjs'
const root=resolve(import.meta.dirname,'../../..'),out=join(root,'.artifacts/planx/deployment-fog'),staged=process.argv.includes('--staged')
mkdirSync(out,{recursive:true});const lane=join(out,staged?'staged':'shipping');mkdirSync(lane,{recursive:true})
const code=await build({stdin:{contents:"export {SnapshotDecoder} from './src/core/snapshot';export {DeploymentStates} from './src/units/deployment-rig'",resolveDir:join(root,'web')},bundle:true,write:false,platform:'node',format:'cjs',logLevel:'silent'})
const m={exports:{}};new Function('module','exports',code.outputFiles[0].text)(m,m.exports)
const decoder=new m.exports.SnapshotDecoder(),states=new m.exports.DeploymentStates()
const runtime=await bootVfsRuntime(fs=>{
 const base='/openra/engine/mods/ra',map=base+'/maps/doubles/map.yaml',text=fs.readFile(map,{encoding:'utf8'})
 assert.match(text,/\nActors:\n/);fs.writeFile(map,text.replace('\nActors:\n','\nActors:\n\tPlanxScout: jeep\n\t\tOwner: Multi0\n\t\tLocation: 14,16\n'))
 if(staged){
  const path=base+'/sequences/structures.yaml',s=fs.readFile(path,{encoding:'utf8'}),start=s.indexOf('\nfact:\n'),end=s.indexOf('\nproc:\n',start),block=s.slice(start,end)
  assert.match(block,/\tmake:\n\t\tFilename: factmake.shp\n\t\tLength: 32\n/)
  fs.writeFile(path,s.slice(0,start)+block.replace(/(\tmake:\n\t\tFilename: factmake.shp\n\t\tLength: )32\n/,'$196\n\t\tTick: 40\n')+s.slice(end))
  for(const [source,target]of [['mod.yaml','mod.yaml'],['deployment-rules.yaml','rules/deployment-rules.yaml']])fs.writeFile(base+'/'+target,readFileSync(join(root,'engine/steelseed-host/mod',source)))
 }
})
const catalog=runtime.bridge.getSkirmishCatalog(),map=catalog.maps.find(m=>m.title==='Doubles');assert.ok(map)
const config=configFor(catalog,map,{withBot:true});config.options.fog='True';config.options.explored='False';config.local.faction='england';config.slots[0].faction='england';config.slots[1].faction='russia'
assert.equal(runtime.bridge.startSkirmish(config).status,'loading')
const rows=[],orders=[],captures={};let snap,scoutId=0,targetId=0,sourceId=0,retreated=false,returning=false,hiddenAt=-1,lastSeenProgress=-1,revealed=false
function move(x,y){const result=runtime.bridge.issueOrder({orderString:'Move',subjectIds:Uint32Array.of(scoutId),targetActorId:0,targetCellX:x,targetCellY:y,queued:false,targetString:'',extraData:0});assert.equal(result,'ok: issued 1/1 local orders');orders.push({tick:snap.tick,x,y,result})}
function capture(name,bytes){if(captures[name])return;const file=name+'.snapshot';writeFileSync(join(lane,file),bytes);captures[name]={file,tick:snap.tick}}
function observe(h,bytes){
 snap=decoder.decode(bytes);const names=runtime.bridge.snapshotTypeTable().split('\n'),a=snap.actors,d=snap.deployments
 for(let i=0;i<a.count;i++)if(a.owner[i]===snap.world.renderPlayer&&names[a.typeId[i]]==='jeep')scoutId=a.id[i]
 states.ingest(d,h.tick);states.retainActors(a,snap.frozenActors)
 let frame=0,frames=0
 if(d)for(let i=0;i<d.count;i++){
  const o=d.byteOffset+i*32,id=d.view.getUint32(o,true),ai=Array.from(a.id.subarray(0,a.count)).indexOf(id)
  if(ai<0||a.owner[ai]===snap.world.renderPlayer)continue
  if(!targetId){targetId=id;sourceId=d.view.getUint32(o+4,true)}
  if(id===targetId){frame=d.view.getUint16(o+22,true);frames=d.view.getUint16(o+24,true)}
 }
 if(!targetId)return
 const visible=Array.from(a.id.subarray(0,a.count)).includes(targetId),f=snap.frozenActors,frozen=!!f&&Array.from(f.id.subarray(0,f.count)).includes(targetId),progress=states.progressOf(targetId,1),remembered=states.rememberedProgressOf(targetId)
 if(visible&&frames){assert.equal(frames,96);lastSeenProgress=progress;capture('visible-make',bytes)}
 if(visible&&frames&&frame>=12&&!retreated){assert.ok(scoutId);move(9,12);retreated=true;capture('retreat',bytes)}
 if(retreated&&!visible&&frozen){
  if(hiddenAt<0){hiddenAt=h.tick;capture('hidden',bytes);assert.ok(lastSeenProgress>0&&lastSeenProgress<1)}
  assert.equal(remembered,lastSeenProgress,'Enemy animation must retain last observed progress');assert.equal(frames,0,'Hidden enemy make frame must not leak');
  if(h.tick>=hiddenAt+120){capture('hidden-later',bytes);if(!returning){move(14,16);returning=true}}
 }
 if(returning&&visible){assert.equal(frames,0);assert.equal(progress,1);revealed=true;capture('revealed-complete',bytes)}
 rows.push({tick:h.tick,targetId,sourceId,visible,frozen,frame,frames,progress,remembered,scoutId})
}
await waitForSnapshot(runtime,{minimumTick:380,timeoutMs:35000,onSnapshot:observe})
writeFileSync(join(lane,'observed.json'),JSON.stringify({staged,config,targetId,sourceId,scoutId,hiddenAt,retreated,returning,revealed,captures,rows,orders},null,2)+'\n')
assert.ok(targetId&&sourceId&&scoutId&&retreated&&hiddenAt>=0&&revealed,'Witness must cover an actual enemy deployment, retreat, fog hold and return')
assert.ok(captures['hidden-later']);assert.ok(rows.filter(r=>r.frozen&&!r.visible).length>=120)
writeFileSync(join(lane,'report.json'),JSON.stringify({status:'PASS',scope:'Real normal AI MCV and actual fog; only one scout inserted into the map before initialization, normal Move orders, no ownership/visibility/frame injection. Saved snapshots for renderer follow-up.',stagedRulesInMemory:staged,config,targetId,sourceId,scoutId,hiddenAt,lastSeenProgress,captures,orders,rows},null,2)+'\n')
console.log('DEPLOYMENT_FOG_ENGINE_PASS',targetId,hiddenAt,lastSeenProgress);process.exit(0)
