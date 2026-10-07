#!/usr/bin/env node
// Behavioral checks for the new presentation seams, without substituting OpenRA rules.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'

const web=fileURLToPath(new URL('..',import.meta.url)),temp=mkdtempSync(join(tmpdir(),'steelseed-livinggate-'))
try {
 const output=join(temp,'api.mjs')
 await build({stdin:{contents:`export { MechanicalClock } from './src/units/mechanical-clock.ts';
 export { WallConnections } from './src/units/wall-connections.ts';
 export { SoftParticles } from './src/fx/particles.ts';
 export { MeshStore } from './src/render/gpumesh.ts';
 export { ParticleOrder } from './src/render/particle-order.ts';
 export { HeaderFlag } from './src/core';`,resolveDir:web,loader:'ts'},bundle:true,platform:'node',format:'esm',outfile:output,logLevel:'silent'})
 const {MechanicalClock,WallConnections,SoftParticles,MeshStore,ParticleOrder,HeaderFlag}=await import(pathToFileURL(output))
 const ordering=new ParticleOrder(4096)
 for(const count of [0,1,31,32,255,2048,4096])for(const pattern of ['ascending','descending','ties','mixed']){
  for(let i=0;i<count;i++)ordering.distances[i]=pattern==='ascending'?i:pattern==='descending'?count-i:pattern==='ties'?i%7:((Math.imul(i+31,2654435761)>>>0)/2**32)**3*1e6
  const expected=Array.from({length:count},(_,i)=>i).sort((a,b)=>ordering.distances[b]-ordering.distances[a])
  assert.deepEqual(Array.from(ordering.sort(count).subarray(0,count)),expected,`stable far-to-near particles ${count}/${pattern}`)
 }
 const clock=new MechanicalClock()
 clock.observe(7,0,false);clock.observe(7,25,false)
 assert.equal(clock.seconds(7,.5),.5)
 clock.observe(7,26,true);assert.equal(clock.seconds(7,0),1);assert.equal(clock.seconds(7,1),1)
 clock.observe(7,26,true);assert.equal(clock.seconds(7,.7),1,'paused phase must hold')
 clock.observe(7,27,false);assert.equal(clock.seconds(7,1),1.04,'resume from held pose')
 clock.prune(28);assert.equal(clock.seconds(7,1),0)

 const visible={isVisible:()=>true,stateAt:()=>2},hidden={isVisible:()=>false,stateAt:()=>1}
 const names=new Map([[1,'sbag'],[2,'brik']]),wall=new WallConnections()
 const actors=(cells)=>({count:cells.length,id:cells.map((_,i)=>i+1),typeId:cells.map(c=>c[2]??1),posX:cells.map(c=>(c[0]+.5)*1024),posY:cells.map(c=>(c[1]+.5)*1024)})
 for(let mask=0;mask<16;mask++){
  const cells=[[5,5]]
  for(const [bit,x,z] of [[1,5,4],[2,6,5],[4,5,6],[8,4,5]])if(mask&bit)cells.push([x,z])
  wall.sync({flags:HeaderFlag.terrainStaticPresent,actors:actors(cells)},names,visible)
  assert.equal(wall.masks.get(1),mask,`cardinal wall mask ${mask}`)
 }
 wall.sync({flags:HeaderFlag.terrainStaticPresent,actors:actors([[5,5],[6,5,2],[6,6]])},names,visible)
 assert.equal(wall.masks.get(1),0,'no diagonal or incompatible material connection')
 wall.sync({flags:HeaderFlag.terrainStaticPresent,actors:actors([[5,5],[6,5]])},names,visible)
 wall.sync({flags:0,actors:actors([])},names,hidden)
 assert.equal(wall.masks.get(1),2,'hidden destruction must not change remembered wall')
 wall.sync({flags:0,actors:actors([[5,5]])},names,visible)
 assert.equal(wall.masks.get(1),0,'visible removal disconnects neighbor')

 const samples=[],render={addParticle:(...values)=>samples.push(values)}
 const p=new SoftParticles();p.spawn('smoke',5,2,5,0,73,1,hidden)
 assert.equal(p.stats.births,0);assert.equal(p.stats.hiddenBirths,1)
 p.spawn('smoke',5,2,5,0,73,1,visible);p.update(.2,render,visible)
 assert.equal(samples.length,12);assert.ok(samples.every(v=>v.every(Number.isFinite)))
 const first=samples.map(v=>v.slice());samples.length=0
 const other=new SoftParticles();other.spawn('smoke',5,2,5,0,73,1,visible);other.update(.2,render,visible)
 assert.deepEqual(samples,first,'seeded particles independent of frame history')
 samples.length=0;p.update(.4,render,hidden);assert.equal(samples.length,0,'hidden effects never submit')
 p.update(40,render,visible);assert.equal(p.stats.alive,0)

 // Real upload code, odd uint16 triangle list: transfer padded, draw count unchanged.
 globalThis.GPUBufferUsage={VERTEX:1,INDEX:2,COPY_DST:4}
 const transfers=[]
 const device={createBuffer:({size})=>({size,destroy(){}}),queue:{writeBuffer(buffer,offset,data,start=0,length=data.byteLength){
  assert.equal(length%4,0,'WebGPU requires aligned upload size');assert.ok(length<=buffer.size);transfers.push(length)
 }}}
 const packed={vertexCount:3,indexCount:3,vertexData:new ArrayBuffer(180),indexData:new Uint16Array([0,1,2]).buffer,
  aabbMin:[0,0,0],aabbMax:[1,1,0],boundingSphere:[.5,.5,0,1],indexFormat:'uint16',stride:60,skinned:false}
 const mesh={toGPUBuffers:()=>packed,generateLodChain(){return [this]}},store=new MeshStore(device),handle=store.upload(mesh,'odd-triangle')
 assert.deepEqual(transfers,[180,8]);assert.equal(handle.indexCount,3);store.dispose()

 const dbpath=join(temp,'content.sqlite'),manifest=join(temp,'content.json')
 function run(){return spawnSync(process.execPath,[join(web,'tools/content-db.mjs'),dbpath,manifest],{encoding:'utf8'})}
 assert.equal(run().status,0);const before=readFileSync(manifest,'utf8');assert.equal(run().status,0)
 assert.equal(readFileSync(manifest,'utf8'),before,'database export must be byte stable')
 const content=JSON.parse(before);assert.equal(content.wallConnections.length,32);assert.ok(content.particles.length>=6,'particle roster present')
 const db=new DatabaseSync(dbpath)
 db.prepare("UPDATE particle_effects SET preset_json=? WHERE id='smoke'").run(JSON.stringify({...content.particles.find(p=>p.id==='smoke').preset,count:-1}));db.close()
 assert.notEqual(run().status,0,'invalid authoring data must fail export')
 assert.equal(readFileSync(manifest,'utf8'),before,'invalid data cannot replace valid manifest')
 console.log('livinggate: PASS — disabled/pause/resume mechanisms, all 16 wall masks and fog memory, deterministic shroud-safe particles, stable bounded particle ordering, odd-index GPU upload, reproducible/validated SQLite export')
} finally {rmSync(temp,{recursive:true,force:true})}
