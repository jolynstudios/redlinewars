#!/usr/bin/env node
// Production math, source identity, each authored barrel, paused event intake, and voice budgets.
import assert from 'node:assert/strict'
import {readFileSync,mkdtempSync,writeFileSync,readdirSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {gunzipSync} from 'node:zlib'
import {build} from 'esbuild'
const root=resolve(import.meta.dirname,'../..'),web=join(root,'web'),out=mkdtempSync(join(tmpdir(),'airnavalgate-'))
const file=join(out,'bundle.mjs')
await build({stdin:{contents:`export * from './src/units/presentation-motion';export * from './src/units/attachments';export * from './src/core/weapon-events';export * from './src/core/clock';export * from './src/render/lights';export * from './src/audio/engines'`,resolveDir:web},bundle:true,format:'esm',outfile:file,logLevel:'silent'})
const {PresentationMotion,MOTION_PROFILES,Attachments,PRESENTATION_BINDINGS,transformSocket,AirspaceClearance,WeaponEvents,Clock,LightPool,LIGHT_BYTES,engineSamples,EngineVoices,ENGINE_LIMITS}=await import(file)
const identity=()=>new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1])
const close=(a,b,e=1e-5)=>assert(Math.abs(a-b)<e,`${a} != ${b}`)
const bounds=[new Float32Array([-1,0,-.5]),new Float32Array([1,1,.5])]
const motion=new PresentationMotion()
function pose(name,t,{id=1,x=0,z=0,yaw=0,alt=3,active=true,moving=false}={}) {
 const m=identity();m[12]=x;m[13]=alt;m[14]=z
 motion.apply(m,0,id,MOTION_PROFILES[name],t,x,z,yaw,alt,active,.3,.4,.6,...bounds,()=>0,moving)
 return m
}
const amplitudes={}
for(const name of Object.keys(MOTION_PROFILES)){
 motion.clear();let lo=Infinity,hi=-Infinity
 for(let i=0;i<300;i++){const m=pose(name,i/25);lo=Math.min(lo,m[13]);hi=Math.max(hi,m[13]);assert(m.every(Number.isFinite));close(Math.hypot(m[0],m[1],m[2]),1)}
 amplitudes[name]=hi-lo;assert(hi-lo>.005&&hi-lo<.15,name+' wave bounds')
 const frozen=pose(name,299/25);assert.deepEqual(pose(name,299/25),frozen,name+' pause')
 assert.deepEqual(pose(name,13,{active:false}),new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,3,0,1]),name+' wreck')
}
assert(amplitudes.tran<amplitudes.heli&&amplitudes.ca<amplitudes.pt,'mass response hierarchy')
assert(MOTION_PROFILES.tran.response<MOTION_PROFILES.heli.response)
assert(MOTION_PROFILES.mig.roll>MOTION_PROFILES.badr.roll)
assert.deepEqual(pose('heli',20,{alt:0}),identity(),'landed idle')
motion.clear();const sub=[]
for(let i=0;i<400;i++)sub.push(pose('ss',i/25,{alt:0,x:i<150?i*.02:3,moving:i<150})[13])
assert(sub[0]>-.05&&sub[180]>-.35&&sub[399]<-.77,'sub stop delay and gradual dive')
motion.clear();assert(pose('ss',0,{alt:0})[13]<-.8,'idle submarine begins submerged')
const clearance=new AirspaceClearance();clearance.add(2,3,1,1,4)
assert.equal(clearance.height(2,3,0),4);assert.equal(clearance.height(10,3,0),0)
assert(clearance.height(3.35,3,0)>1&&clearance.height(3.35,3,0)<3)
// Analytic transform oracle: socket (1,2,3), bone translation and 90deg hull yaw.
const hull=new Float32Array([0,0,-2,0,0,2,0,0,2,0,0,0,10,20,30,1]),skin=identity();skin[12]=4
const socket={part:'probe',bone:0,position:[1,2,3],direction:[1,0,0]},world=new Float32Array(6)
transformSocket(hull,0,skin,socket,world,0);assert.deepEqual([...world],[16,24,20,0,0,-1])
const roster=JSON.parse(readFileSync(join(web,'src/core/ra-visual-manifest.json'))).actors
let armaments=0,barrels=0,sockets=0
const attachments=new Attachments()
for(const [name,binding]of Object.entries(PRESENTATION_BINDINGS)){
 const bytes=readFileSync(join(root,'art/blender/assets',name+'.blend'))
 assert.equal(createHash('sha256').update(bytes).digest('hex'),binding.sourceSha256,name+' source identity')
 if(!/\.d[1-5]$/.test(name))assert.deepEqual(binding.armaments.map(a=>a.weapon),(roster[name]?.slot?.armaments??[]).map(a=>a.weapon),name+' actual arsenal')
 const mesh={};attachments.bind(mesh,name,binding.sourceSha256);attachments.begin();attachments.place(1,mesh,hull,0,null)
 for(let a=0;a<binding.armaments.length;a++){
  const arm=binding.armaments[a];armaments++
  for(let b=0;b<arm.barrels.length;b++){
   barrels++
   for(let k=0;k<arm.barrels[b].length;k++){
    const index=arm.barrels[b][k],s=arm.sockets[index];assert(s&&s.part,name+' missing physical source')
    assert.equal(attachments.resolve(1,a,b,world,k*arm.barrels.length+1),true)
    const expected=new Float32Array(6);transformSocket(hull,0,null,s,expected,0);assert.deepEqual(world,expected,name+' explicit tube selection');sockets++
   }
  }
 }
 attachments.end();attachments.begin();attachments.end();assert.equal(attachments.resolve(1,0,0,world),false,'hidden actor socket removed')
}
for(const [name,value]of Object.entries(roster))if(value.slot?.armaments?.length)assert(PRESENTATION_BINDINGS[name],name+' armed roster coverage')
// Source edits must retain authored damage masks and bind their bytes to the new source.
let masks=0
for(const actor of readdirSync(join(web,'.forge/damage-states'))){
 let pack;try{pack=JSON.parse(readFileSync(join(web,'.forge/damage-states',actor,'manifest.json')))}catch{continue}
 for(const state of pack.states){const mask=state.detailMask;if(!mask)continue
  assert.equal(mask.sourceSha256,state.sourceSha256,actor+' damage mask source')
  const bytes=gunzipSync(readFileSync(join(web,'.forge/damage-states',actor,mask.file)))
  assert.equal(createHash('sha256').update(bytes).digest('hex'),mask.sha256,actor+' damage mask payload');masks++
 }
}
assert(masks>0,'existing authored damage masks were dropped')
for(const name of ['heli','hind','mh60','tran']){
 const lights=PRESENTATION_BINDINGS[name].lights
 assert.equal(lights.length,name==='tran'?3:2);assert.equal(lights.filter(l=>l.direction[1]<-.9).length,name==='tran'?2:1)
 assert.equal(lights.filter(l=>l.direction[0]>.9).length,1)
}
assert.equal(PRESENTATION_BINDINGS.tran.armaments.length,0,'transport remains unarmed')
assert.throws(()=>attachments.bind({},'heli','stale'),/stale/)
// Queued bytes survive reuse; no callback is run before the pose is placed.
const queue=new WeaponEvents(),v=new DataView(new ArrayBuffer(64));v.setUint32(0,123,true)
queue.enqueue({kind:1,offset:0,byteLength:30},v);v.setUint32(0,456,true);queue.enqueue({kind:2,offset:0,byteLength:34},v);v.setUint32(0,999,true)
const recorded=[];queue.drain((e,v)=>recorded.push([e.kind,v.getUint32(e.offset,true)]));assert.deepEqual(recorded,[[1,123],[2,456]])
for(const deterministic of [true,false]){const clock=new Clock({deterministic});clock.onTick(10,0);clock.frame(15);const alpha=clock.time.alpha;clock.frame(1000,true);assert.equal(clock.time.alpha,alpha);assert.equal(clock.time.dt,0)}
globalThis.GPUBufferUsage={STORAGE:128,COPY_DST:8}
const device={createBuffer:args=>({...args,destroy(){}}),queue:{writeBuffer(){}}},lights=new LightPool(device,3)
assert.equal(LIGHT_BYTES,48)
lights.add(0,3,0,1,1,1,12,9,0,-1,0,.94,.82);lights.add(0,0,0,1,1,1,2,2);lights.flush(device,0,5,0)
close(lights.data[9],-.94);close(lights.data[11],.82);assert.equal(lights.data[23],-1)
for(let i=0;i<100;i++)lights.add(i,0,0,1,1,1,1,1)
lights.flush(device,0,5,0);assert.equal(lights.count,3);assert(lights.droppedThisFrame>0)
// Synthesized decoded storage, type distinctions, and shared combat-node budget.
const hashes=[];let decoded=0
for(let k=0;k<5;k++){const data=engineSamples(k,48000);decoded+=data.byteLength;assert(data.every(n=>Number.isFinite(n)&&Math.abs(n)<1));hashes.push(createHash('sha256').update(Buffer.from(data.buffer)).digest('hex'))}
assert.equal(new Set(hashes).size,5);assert(decoded<4*1024*1024);assert.equal(ENGINE_LIMITS.low,0);assert.equal(ENGINE_LIMITS.classic,0)
let sources=0,stops=0
const actx={sampleRate:48000,currentTime:0,createBuffer:()=>({copyToChannel(){}}),createBufferSource:()=>({playbackRate:{value:1},connect(){},start(){sources++},stop(){stops++},disconnect(){}})}
const engines=new EngineVoices();engines.init(actx)
const actors={count:200,id:Uint32Array.from({length:200},(_,i)=>i+1),typeId:new Uint16Array(200),posX:new Int32Array(200),posY:new Int32Array(200),posZ:new Int32Array(200),flags:new Uint8Array(200),owner:new Uint8Array(200),speed:new Uint16Array(200),health:new Uint8Array(200).fill(255)}
const ctx={snapshot:{actors,flags:0,world:{renderPlayer:0}},actorTypeName:()=> 'tran',config:{q:{name:'medium'}},time:{tick:0,alpha:0}}
const slots=Array.from({length:32},()=>({freeAt:0,gain:{gain:{value:0}},pan:{pan:{value:0}},lp:{frequency:{value:0}}})),eye=new Float32Array(3),right=new Float32Array([1,0,0])
engines.update(ctx,actx,slots,eye,right,()=>true);assert.equal(engines.stats.active,4)
ctx.config.q.name='ultra';engines.update(ctx,actx,slots,eye,right,()=>true);assert.equal(engines.stats.active,8)
for(let i=0;i<10;i++)engines.update(ctx,actx,slots,eye,right,()=>true);assert.equal(sources,8,'steady hover reuses source nodes')
engines.update(ctx,actx,slots,eye,right,()=>false);assert.equal(engines.stats.active,0);assert.equal(stops,8,'fog stops all loops')
const report={status:'passed',actors:Object.keys(PRESENTATION_BINDINGS).length,armaments,barrels,sockets,masks,amplitudes,decodedEngineBytes:decoded,checks:'source hashes, full arsenal, every barrel/tube, matrix/skin, motion bounds, pause, landing, submarine delay, roof envelope, lamp counts/directions/budget, copied shot events, engine caps/reuse/fog'}
writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2));console.log('airnavalgate: PASS',JSON.stringify(report));console.log(out)
