#!/usr/bin/env node
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
const web=resolve(import.meta.dirname,'..'),tmp=mkdtempSync(join(tmpdir(),'bridge-contract-')),entry=join(tmp,'entry.ts'),bundle=join(tmp,'bundle.mjs')
writeFileSync(entry,`export * from '${web}/src/terrain/bridge-contract';export {TerrainGrid} from '${web}/src/terrain/grid';export {Surface} from '${web}/src/core/surface'`)
await build({entryPoints:[entry],outfile:bundle,bundle:true,format:'esm',platform:'node',logLevel:'silent'})
const {BridgeKnowledge,bridgeSupportHeight,HERO_BRIDGE,TerrainGrid,Surface}=await import(pathToFileURL(bundle))
const b={id:100,x:32,z:23.5,state:'partial'},knowledge=new BridgeKnowledge(),ctx={actorTypeName:()=>HERO_BRIDGE.actor}
const snap={tick:1,world:{boundsLeft:1,boundsTop:1,boundsRight:65,boundsBottom:49},shroud:[{cellIndex:0,runLength:3072,state:0}],actors:{count:1,id:[100],posX:[32768],posY:[24064],typeId:[1],health:[125]}}
assert.equal(knowledge.observe(snap,ctx),false);assert.equal(knowledge.known.size,0)
snap.tick++;snap.shroud[0].state=2;assert.equal(knowledge.observe(snap,ctx),true);assert.equal(knowledge.known.get(100).state,'partial')
snap.tick++;snap.shroud[0].state=1;snap.actors.health[0]=0;snap.flags=1;assert.equal(knowledge.observe(snap,ctx),false);assert.equal(knowledge.known.get(100).state,'partial','hidden terrain reemit leaked death')
snap.tick++;snap.shroud[0].state=2;assert.equal(knowledge.observe(snap,ctx),true);assert.equal(knowledge.known.get(100).state,'dead')
const results=[]
for(const state of ['intact','partial','dead']){
 const w=64,h=48,n=w*h,view={w,h,type:new Uint8Array(n),height:new Uint8Array(n),ramp:new Uint8Array(n),passability:new Uint8Array(n).fill(7),resource:new Uint8Array(n),surface:new Uint8Array(n).fill(Surface.grass)}
 for(let z=1;z<49;z++)for(let x=28;x<36;x++){const i=(z-1)*w+x-1;view.passability[i]=8;view.surface[i]=Surface.water}
 for(let z=21;z<26;z++)for(let x=28;x<36;x++){const i=(z-1)*w+x-1,valid=HERO_BRIDGE.masks[state][z-21][x-28]==='B';view.passability[i]=valid?7:16;view.surface[i]=valid?Surface.road:Surface.rock}
 const original=view.passability.slice(),g=new TerrainGrid();g.bridges=[{...b,state}];g.build(view,1,1);assert.deepEqual(g.passability,original,'scenery changed authority')
 const paths=state==='intact'?[22.5,24.5]:state==='partial'?[22.5]:[]
 for(const z of paths)for(let x=27;x<=37;x+=.05)assert.ok(Math.abs(g.heightAt(x,z))<.002,`${state} path at ${x},${z}: ${g.heightAt(x,z)}`)
 assert.ok(g.groundHeightAt(32,23.5)<-.9);assert.ok(Math.abs(g.waterHeightAt(32,23.5)-HERO_BRIDGE.waterM)<.001)
 assert.equal(bridgeSupportHeight({...b,state},32,24.5),state==='intact'?0:null)
 if(state==='dead')assert.equal(bridgeSupportHeight({...b,state},32,22.5),null)
 results.push({state,terrainAuthorityPreserved:true,flatApproachAndDeck:true,riverbed:g.groundHeightAt(32,23.5),water:g.waterHeightAt(32,23.5)})
}
writeFileSync(resolve(web,'../.artifacts/planx/bridge-contract-report.json'),JSON.stringify({schema:1,syntheticVisibilityContract:true,unexploredNotShown:true,fogRetainsLastWitness:true,results},null,2)+'\n')
console.log('herobridgecontractgate: PASS — visibility cache, authoritative masks unchanged, shared deck and bank height, depressed riverbed')
