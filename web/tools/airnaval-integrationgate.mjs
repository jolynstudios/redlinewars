#!/usr/bin/env node
// Staged authoritative-shaped snapshots through production Units/FX/Audio/Render, on a private port.
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {resolve,join,extname,sep} from 'node:path'
import {createHash} from 'node:crypto'
import {launchGpuBrowser,loadChromium,WEB_ROOT} from './harness.mjs'
const arg=(name,fallback)=>{const i=process.argv.indexOf('--'+name);const v=i>=0&&i<process.argv.length-1&&!process.argv[i+1].startsWith('--')?process.argv[i+1]:process.argv.find(s=>s.startsWith('--'+name+'='))?.split('=').slice(1).join('=');return v??fallback}
// Relative --out values anchor to the REPO root (WEB_ROOT/..), matching the default and
// enginebudgetgate's `<root>/.artifacts/air-naval/final-<quality>/report.json` contract,
// so the documented `--out .artifacts/...` invocation lands identically from any CWD.
const outArg=arg('out',join(WEB_ROOT,'../.artifacts/air-naval/gpu')),out=resolve(outArg.startsWith('.')?join(WEB_ROOT,'..'):'.',outArg),quality=arg('quality','medium'),baseline=process.argv.includes('--baseline'),record=process.argv.includes('--record')
const dist=resolve(arg('dist',join(WEB_ROOT,'dist')))
mkdirSync(out,{recursive:true})
const binding=JSON.parse(readFileSync(join(WEB_ROOT,'src/core/presentation-manifest.json'))).actors
const roster=JSON.parse(readFileSync(join(WEB_ROOT,'src/core/ra-visual-manifest.json'))).actors
const styles=JSON.parse(readFileSync(join(WEB_ROOT,'src/weapon-visual-manifest.json'))).profiles
const server=createServer(async(req,res)=>{try{let path=new URL(req.url,'http://localhost').pathname;if(path.endsWith('/'))path+='index.html';const f=resolve(dist,'.'+path);if(!f.startsWith(dist+sep))throw Error('path');const data=await readFile(f);res.writeHead(200,{'content-type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm','.png':'image/png','.svg':'image/svg+xml'})[extname(f)]??'application/octet-stream'});res.end(data)}catch{res.writeHead(404);res.end()}})
let browser
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));({browser}=await launchGpuBrowser(await loadChromium('airnaval-integrationgate'),'airnaval-integrationgate'))
 const page=await browser.newPage({viewport:{width:1280,height:900},deviceScaleFactor:1}),errors=[]
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('favicon'))errors.push(m.text())})
 await page.addInitScript(()=>{window.requestAnimationFrame=()=>1;window.cancelAnimationFrame=()=>{};window.gpuErrors=[];const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...args){const d=await request.apply(this,args);d.addEventListener('uncapturederror',e=>window.gpuErrors.push(e.error.message));return d}})
 await page.goto(`http://127.0.0.1:${server.address().port}/?devmap=1&manual=1&devsize=48&devactors=200&devtod=720&quality=${quality}&weather=clear&seed=airnaval-proof`,{waitUntil:'domcontentloaded'})
 await page.waitForFunction(()=>window.steelseed,undefined,{timeout:180000,polling:100})
 console.log('booted',quality,baseline?'baseline':'after')
 const setup=await page.evaluate(async({binding,roster,styles,baseline})=>{
  const app=window.steelseed;app.stop();app.renderOneFrame(0)
  const ctx=app.ctx,units=ctx.get('units'),render=ctx.get('render'),camera=ctx.get('camera'),sky=ctx.get('sky'),audio=ctx.get('audio'),fx=ctx.get('fx'),terrain=ctx.get('terrain')
  const snap=ctx.snapshot,a=snap.actors,grid=snap.terrainStatic,ox=snap.world.boundsLeft,oz=snap.world.boundsTop
  const names=['heli','hind','mh60','tran','yak','mig','u2','badr','badr.bomber','pt','lst','dd','ca','ss','msub']
  // snapshotTypeTable is async on the composed bridge (the actor-type table
  // arrives through the boot handshake); await the string before splitting.
  const table=(await app.bridge.snapshotTypeTable()).split('\n'),base=table.length,all=[...new Set([...names,...names.slice(0,9).map(n=>(n==='badr.bomber'?'badr':n)+'.husk'),...Object.keys(binding).filter(n=>! /\.d[1-5]$/.test(n)),...styles.map(p=>p.weapon)])];table.push(...all)
  const ids=Object.fromEntries(all.map((n,i)=>[n,base+i]));app.bridge={...app.bridge,pollSnapshot:()=>null,snapshotTypeTable:()=>table.join('\n')};app.typeTable=null;app.snapState.prev=null
  grid.height.fill(0);grid.ramp.fill(0);grid.resource.fill(0);grid.type.fill(2);grid.surface.fill(8);grid.passability.fill(8)
  for(let z=0;z<48;z++)for(let x=0;x<13;x++){grid.surface[z*48+x]=4;grid.passability[z*48+x]=7}
  snap.flags|=1;snap.shroud=[{cellIndex:0,runLength:48*48,state:2}];snap.world.environment=null;snap.world.renderPlayer=0
  if(snap.frozenActors)snap.frozenActors.count=0
  if(snap.projectiles)snap.projectiles.count=0
  const eventView=new DataView(new ArrayBuffer(128));snap.view=eventView
  const slots=[]
  function stage(list,columns=5){a.crashParentId?.fill(0);if(snap.projectiles)snap.projectiles.count=0;a.count=list.length;slots.length=0;for(let i=0;i<list.length;i++){
   const name=list[i],air=names.indexOf(name)<9&&names.includes(name),x=ox+20+(i%columns)*3,z=oz+19+Math.floor(i/columns)*3
	 a.id[i]=7000+i;a.typeId[i]=ids[name];a.owner[i]=0;a.health[i]=255;a.flags[i]=0;a.facing[i]=768;a.posX[i]=x*1024;a.posY[i]=z*1024;a.posZ[i]=air?2.6*1024:0;a.speed[i]=0;a.turretCount[i]=0
	 if(a.displayTypeId)a.displayTypeId[i]=a.typeId[i]
	 // The draw path resolves each actor's slot through the runtime type maps
	 // (units/index.ts typeSlot/typeClass); staged synthetic ids must be
	 // registered or every instance falls out of the draw loop unsubmitted.
	 units.typeSlot.set(a.typeId[i],name);units.typeClass.set(a.typeId[i],0)
	 units.typeVehicle.set(a.typeId[i],false);units.typeRenderable.set(a.typeId[i],true)
	 units.typeWatercraft.set(a.typeId[i],false);units.typeWaterStructure.set(a.typeId[i],false)
	 slots.push({name,x,z,air})
  }
  app.registry.onSnapshot(snap,null,ctx)}
  function draw(t){snap.tick=Math.floor(t*25);ctx.time.tick=snap.tick;ctx.time.alpha=t*25-snap.tick;ctx.time.elapsed=t;ctx.time.dt=.04;ctx.time.frame++;sky.onSnapshot(snap,null,ctx);app.registry.update(.04,ctx);app.registry.lateUpdate(.04,ctx)}
  function pose(i){const values=[];units.visitVisibleInstances(slots[i].name,(m,o,id)=>{if(id===a.id[i])values.push(...m.subarray(o,o+16))});return values}
  function fire(i,arm=0,barrel=0,shot=1){const armament=roster[slots[i].name]?.slot?.armaments?.[arm];if(!armament)return
   const p=styles.find(p=>p.weapon===armament.weapon),v=eventView;v.setUint32(0,a.id[i],true);v.setUint16(4,arm,true);v.setInt32(6,a.posX[i],true);v.setInt32(10,a.posY[i],true);v.setInt32(14,a.posZ[i],true);v.setUint16(18,a.facing[i],true);v.setUint16(20,ids[armament.weapon],true);v.setUint16(22,p.caliber,true);v.setUint16(24,barrel,true);v.setUint32(26,shot,true);app.events.emit('sim:weapon:fire',{kind:1,offset:0,byteLength:30})
  }
  function impact(i,arm=0,shot=1){const armament=roster[slots[i].name]?.slot?.armaments?.[arm];if(!armament)return;const p=styles.find(p=>p.weapon===armament.weapon),v=eventView,o=64
   v.setInt32(o,a.posX[i]+2048,true);v.setInt32(o+4,a.posY[i],true);v.setInt32(o+8,0,true);v.setInt16(o+12,-32767,true);v.setInt16(o+14,0,true);v.setInt16(o+16,5000,true);v.setUint8(o+18,8);v.setUint8(o+19,p.weaponClass);v.setUint16(o+20,p.caliber,true);v.setUint16(o+22,ids[armament.weapon],true);v.setUint32(o+24,a.id[i],true);v.setUint16(o+28,arm,true);v.setUint32(o+30,shot,true);app.events.emit('sim:projectile:impact',{kind:2,offset:o,byteLength:34})
  }
  function move(t){for(let i=0;i<a.count;i++){const s=slots[i],moving=t<6;const distance=moving?t*.3:1.8;a.posX[i]=(s.x+distance)*1024;a.posY[i]=(s.z+Math.sin(t*.4)*.3)*1024;a.speed[i]=moving?80:0;a.flags[i]=moving?64:0;a.facing[i]=((768+Math.sin(t*.4)*80)+1024)%1024}}
  function destroyed(i){const v=eventView;v.setUint32(0,a.id[i],true);v.setInt32(4,a.posX[i],true);v.setInt32(8,a.posY[i],true);v.setInt32(12,a.posZ[i],true);v.setUint8(16,0);v.setUint8(17,180);app.events.emit('sim:actor:destroyed',{kind:5,offset:0,byteLength:18})}
  function crashStart(at=200){
   units.deaths.clear();stage(names.slice(0,9),3);a.crashParentId=new Uint32Array(a.id.length)
   for(let i=0;i<a.count;i++){slots[i].x=ox+8+(i%3)*6;slots[i].z=oz+19+Math.floor(i/3)*4;slots[i].done=false;a.posX[i]=slots[i].x*1024;a.posY[i]=slots[i].z*1024;a.posZ[i]=4096;a.health[i]=30}
   camera.height=camera.heightGoal=25;camera.focusWorld(ox+15,oz+23);sky.setDaylightMode('day');draw(at-.4);draw(at)
   for(let i=0;i<a.count;i++){destroyed(i);a.crashParentId[i]=a.id[i];a.id[i]+=1000;a.typeId[i]=ids[(slots[i].name==='badr.bomber'?'badr':slots[i].name)+'.husk'];a.health[i]=255;a.flags[i]=8}
   app.registry.onSnapshot(snap,null,ctx)
  }
  function crashStep(t,at=200){
   let n=0
   for(let i=0;i<9;i++){
    const rotor=i<4,alt=Math.max(0,4-t*(rotor?1.05:2.1)),x=slots[i].x+Math.min(t,rotor?3.81:1.905)*(rotor?.08:.5),z=slots[i].z
    if(alt===0){if(!slots[i].done){slots[i].done=true;eventView.setUint32(0,8000+i,true);eventView.setInt32(4,x*1024,true);eventView.setInt32(8,z*1024,true);eventView.setInt32(12,0,true);app.events.emit('sim:actor:destroyed',{kind:5,offset:0,byteLength:18})}continue}
    a.id[n]=8000+i;a.typeId[n]=ids[(slots[i].name==='badr.bomber'?'badr':slots[i].name)+'.husk'];a.crashParentId[n]=7000+i;a.owner[n]=0;a.health[n]=255;a.flags[n]=8;a.turretCount[n]=0;a.speed[n]=0
    a.posZ[n]=alt*1024;a.posX[n]=x*1024;a.posY[n]=z*1024;a.facing[n]=(768+(rotor?t*70:0))%1024;n++
   }a.count=n;draw(at+t)
  }
  const shot=()=>{draw((ctx.time.tick+ctx.time.alpha)/25);const c=document.createElement('canvas');c.width=ctx.canvas.width;c.height=ctx.canvas.height;c.getContext('2d').drawImage(ctx.canvas,0,0);return c.toDataURL('image/png')}
  camera.height=camera.heightGoal=25;camera.yaw=camera.yawGoal=.3;camera.focusWorld(ox+26,oz+22)
  for(const id of ['session-ui','hud','outcome-ui']){const el=document.getElementById(id);if(el)el.hidden=true}
  stage(names);for(let n=0;n<30;n++)draw(n*.04)
  window.proof={app,ctx,units,render,camera,sky,audio,fx,terrain,snap,a,names,slots,ids,stage,draw,move,pose,fire,impact,shot,ox,oz,crashStart,crashStep}
  audio.wake();await audio.actx?.resume()
  return {backend:ctx.backend,ready:names.map((name,i)=>({name,drawn:pose(i).length===16})),lampStats:{...units.headlampStats},engineStats:audio.engineStats,device:ctx.adapter?.info??null}
 },{binding,roster,styles,baseline})
 assert.equal(setup.backend,'webgpu');console.log('setup',JSON.stringify(setup));assert(setup.ready.every(r=>r.drawn),'all air/naval actors must be submitted')
 const save=async name=>{const data=await page.evaluate(()=>window.proof.shot());writeFileSync(join(out,name+'.png'),Buffer.from(data.split(',')[1],'base64'))}
 await save('all-types-day')
 const evidence=await page.evaluate(async()=>{
  const p=window.proof,{a,units,sky,snap,draw,pose,audio}=p,rows=[]
  for(let f=0;f<180;f++){p.move(f*.04);draw(2+f*.04);if(f%30===0)rows.push({t:f*.04,positions:p.names.map((n,i)=>({name:n,matrix:pose(i)}))})}
  sky.setDaylightMode('night');for(let i=0;i<20;i++)draw(10+i*.04)
  return {rows,lamps:{...units.headlampStats},wakes:{...p.fx.navalWakeStats},engines:{...audio.engineStats},gpuErrors:window.gpuErrors}
 })
 await save('all-types-night')
 console.log('roster rendered',evidence.lamps,evidence.wakes);console.log('GPU errors',JSON.stringify(evidence.gpuErrors));writeFileSync(join(out,'early-report.json'),JSON.stringify({setup,evidence,errors},null,2))
 // Close inspection and socket witnesses for every real base actor, all of its barrels.
const sockets=baseline?null:await page.evaluate(async({binding,roster})=>{
  const p=window.proof;let count=0;const missing=[],invalid=[],names=Object.keys(binding).filter(n=>! /\.d[1-5]$/.test(n)&&binding[n].armaments.length)
  const v=new Float32Array(6)
  for(const name of names){p.stage([name]);p.a.posX[0]=(p.ox+8)*1024;p.a.posY[0]=(p.oz+24)*1024;p.a.turretCount[0]=Math.min(1,p.a.turretFacing.length);p.a.turretOffset[0]=0
   for(const facing of [0,256,512,768]){p.a.facing[0]=facing;if(p.a.turretFacing.length)p.a.turretFacing[0]=(facing+128)%1024;p.draw(12+count*.04)
    for(let arm=0;arm<binding[name].armaments.length;arm++)for(let barrel=0;barrel<binding[name].armaments[arm].barrels.length;barrel++){
     const choices=binding[name].armaments[arm].barrels[barrel]
     for(let k=0;k<choices.length;k++){const ok=p.units.attachmentWorldOf(7000,arm,barrel,v,k*binding[name].armaments[arm].barrels.length+1);count++;if(!ok)missing.push({name,arm,barrel,facing});else if(!v.every(Number.isFinite)||Math.abs(Math.hypot(v[3],v[4],v[5])-1)>.001)invalid.push({name,arm,barrel})}
    }
   }
  }
 // Condition ladders land in the BACKGROUND after the roster (units/index.ts fires
 // buildDamageLadders and forgets it), so the damage assertions below are only
 // meaningful once every rung they name has registered. Wait for exactly the
 // asserted set; if one never lands, fail with the loader's own diagnostics.
 const damageKeys=Object.keys(binding).filter(n=>/^(.*)\.d([1-4])$/.test(n)&&binding[n].armaments.length)
 {const t0=performance.now();let missing=damageKeys.filter(k=>!p.units.slotBuckets.has(k))
  while(missing.length&&performance.now()-t0<120000){await new Promise(r=>setTimeout(r,100));missing=damageKeys.filter(k=>!p.units.slotBuckets.has(k))}
  if(missing.length)throw Error('damage ladders never registered: '+JSON.stringify({missing,forgeErrors:[...p.units.forgeStats.errors],damageStats:{...p.units.damageStats}}))
 }
  let damageChecks=0
  for(const [name,variant] of Object.entries(binding)){
   const match=/^(.*)\.d([1-4])$/.exec(name);if(!match||!variant.armaments.length)continue
   p.stage([match[1]]);p.a.id[0]=50000+damageChecks;p.a.health[0]=[255,230,160,100,30][Number(match[2])]
   p.draw(100+damageChecks);p.draw(100.4+damageChecks)
   const placed=p.units.attachments.actors.get(p.a.id[0]);if(placed?.bound.binding.sourceSha256!==variant.sourceSha256)throw Error('damage attachment source mismatch '+name+' runtime='+(placed?.bound?.binding?.sourceSha256??'MISSING')+' manifest='+variant.sourceSha256)
   for(let arm=0;arm<variant.armaments.length;arm++)for(let barrel=0;barrel<variant.armaments[arm].barrels.length;barrel++){
    if(!p.units.attachmentWorldOf(p.a.id[0],arm,barrel,v)||!v.every(Number.isFinite))throw Error('damage socket missing '+name+':'+arm+':'+barrel)
    damageChecks++
   }
  }
  p.stage(['tran']);p.draw(19);const chinookLights=p.units.headlampStats.lights;if(chinookLights!==3)throw Error('Chinook requires exactly three directed lamps')
  p.stage(['tran','heli','hind','mh60'],2);p.camera.height=p.camera.heightGoal=15;p.camera.focusWorld(p.ox+22,p.oz+21);for(let f=0;f<30;f++)p.draw(20+f*.04)
  return {count,damageChecks,missing,invalid,chinookLights,helicopterLights:p.units.headlampStats.lights}
 },{binding,roster})
 if(sockets){assert.equal(sockets.missing.length,0,JSON.stringify(sockets.missing));assert.equal(sockets.invalid.length,0);await save('helicopters-night')}
 const lifecycle=baseline?null:await page.evaluate(()=>{
  const p=window.proof;p.stage(['tran','heli','ss'],3);p.sky.setDaylightMode('night');p.draw(25)
  p.app.clock.onTick(625,25000);p.app.renderOneFrame(25020);const before=p.pose(0);p.snap.flags|=2;p.app.renderOneFrame(28000)
  if(JSON.stringify(before)!==JSON.stringify(p.pose(0)))throw Error('paused posed matrix moved')
  p.snap.flags&=~2;p.app.clock.onTick(626,28000);p.app.renderOneFrame(28020)
  const shroud=p.ctx.get('shroud'),visible=shroud.isVisible.bind(shroud),stateAt=shroud.stateAt.bind(shroud);shroud.isVisible=()=>false;shroud.stateAt=()=>1;p.a.owner.fill(1,0,3);p.draw(25.1)
  const hidden={instances:p.pose(0).length,lamps:p.units.headlampStats.lights,engines:p.audio.engineStats.active,wakes:p.fx.navalWakeStats.active}
  if(Object.values(hidden).some(n=>n!==0))throw Error('fog presentation leak '+JSON.stringify(hidden))
  shroud.isVisible=visible;shroud.stateAt=stateAt;p.a.owner.fill(0,0,3);p.draw(25.2);const revealed=p.pose(0)
  if(revealed.length!==16||Math.abs(revealed[13]-before[13])>.15)throw Error('reveal pose jumped')
  p.a.flags.fill(8,0,3);p.a.health.fill(0,0,3);p.draw(25.3)
  if(p.units.headlampStats.lights!==0||p.audio.engineStats.active!==0)throw Error('wreck retained active lamp/engine')
  return {pause:true,hidden,reveal:true,wreckLightsAndEnginesOff:true}
 })
 const crashes=baseline?null:await page.evaluate(()=>{
  const p=window.proof;p.crashStart();const rows=[],signals=[];const off=p.ctx.events.on('presentation:aircraft:impact',e=>signals.push({...e}));const startImpacts=p.units.deathStats.impacts
  for(let f=0;f<=130;f++){const t=f*.04;p.crashStep(t);if(f%10===0)rows.push({t,entries:p.units.deaths.entries.filter(e=>e.active).map(e=>({id:e.id,y:e.matrix[13],x:e.matrix[12],opacity:e.item.opacity,impact:e.impactAt,linked:e.child,water:e.event.water}))})}
  if(rows[0].entries.length!==9||rows[0].entries.some(e=>!e.linked))throw Error('every damaged aircraft needs a linked crash')
  if(!rows.some(r=>r.entries.some(e=>e.water&&e.impact>=0))||!rows.some(r=>r.entries.some(e=>!e.water&&e.impact>=0)))throw Error('both water and ground crashes required')
  if(rows.some(r=>r.entries.some(e=>e.impact<0&&e.opacity!==1)))throw Error('airborne aircraft faded before impact')
  const impacts=p.units.deathStats.impacts-startImpacts;if(impacts!==9)throw Error('each crash needs exactly one surface contact: '+impacts+' '+JSON.stringify(signals))
  for(const n of ['heli.husk','mig.husk','tran.husk'])p.units.visitVisibleInstances(n,()=>{throw Error('duplicate native aircraft husk')})
  off();p.units.deaths.clear();p.fx.particles.dispose();return {rows,impacts,damaged:true,noDuplicateHusks:true}
 })
 // Optional loops measured on 200 mixed actors; battle pressure is measured separately.
 const perf=await page.evaluate(async({baseline})=>{
  const p=window.proof,list=Array.from({length:200},(_,i)=>p.names[i%p.names.length]);p.stage(list,14);for(let i=0;i<p.a.count;i++){p.slots[i].x=p.ox+14+(i%14)*1.8;p.slots[i].z=p.oz+12+Math.floor(i/14)*1.8};p.camera.height=p.camera.heightGoal=20;p.camera.focusWorld(p.ox+28,p.oz+23)
  const original=p.audio.engines?.update?.bind(p.audio.engines),eligible=(p.audio.engineStats?.decodedBytes??0)>0,samples=[]
  function mode(on){if(original){p.audio.engines.clear(p.audio.slots);if(on&&eligible)p.audio.engines.init(p.audio.actx);p.audio.engines.update=on?original:()=>{}}}
  for(const on of [false,true,false,true]){
   mode(on);let dropped0=p.audio.voicesDropped,active=0,cpu=[],wall=[],audioCpu=[]
   for(let i=0;i<180;i++){
    const t=30+i*.04;p.move(i*.04);
    const t0=performance.now();p.draw(t);const t1=performance.now();await p.ctx.device.queue.onSubmittedWorkDone();const t2=performance.now();if(i>=30){cpu.push(t1-t0);wall.push(t2-t0)}active=Math.max(active,p.audio.engineStats?.active??0)
   }
   const p95=vs=>vs.sort((a,b)=>a-b)[Math.floor(vs.length*.95)]
   samples.push({engines:on,cpuP95:p95(cpu),frameP95:p95(wall),dropped:p.audio.voicesDropped-dropped0,active,bytes:p.audio.engineStats?.decodedBytes??0,eye:Array.from(p.audio.eye)})
  }
  mode(true);return samples
 },{baseline})
 console.log('performance',JSON.stringify(perf))
 const battle=await page.evaluate(async({roster,styles})=>{
  const p=window.proof;const projectileWeapons=new Set(styles.filter(p=>p.style.projectile).map(p=>p.weapon))
  const sources=p.slots.map((s,i)=>({i,arm:roster[s.name]?.slot?.armaments?.findIndex(a=>projectileWeapons.has(a.weapon))??-1})).filter(s=>s.arm>=0).slice(0,32)
  const n=sources.length,flight={count:n};for(const k of ['id','sourceActorId','launchShot'])flight[k]=new Uint32Array(n)
  for(const k of ['posX','posY','posZ','tgtX','tgtY','tgtZ','launchX','launchY','launchZ'])flight[k]=new Int32Array(n)
  for(const k of ['velX','velY','velZ'])flight[k]=new Int16Array(n)
  for(const k of ['typeId','remainingTicks','launchArmament','launchBarrel'])flight[k]=new Uint16Array(n)
  flight.kind=new Uint8Array(n);p.snap.projectiles=flight
  const cpu=[],wall=[];let bodies=0,lights=0;const startDrops=p.audio.voicesDropped
  for(let f=0;f<240;f++){
   p.move(f*.04);const cycle=Math.floor(f/30),age=f%30,shot=1000+cycle
   for(let j=0;j<n;j++){
    const {i,arm}=sources[j],weapon=roster[p.slots[i].name].slot.armaments[arm].weapon
    if(age===0){p.fire(i,arm,0,shot);flight.launchX[j]=p.a.posX[i];flight.launchY[j]=p.a.posY[i];flight.launchZ[j]=p.a.posZ[i];flight.sourceActorId[j]=p.a.id[i];flight.launchArmament[j]=arm;flight.launchShot[j]=shot;flight.id[j]=100000+cycle*n+j;flight.typeId[j]=p.ids[weapon]}
    flight.posX[j]=flight.launchX[j]+age*120;flight.posY[j]=flight.launchY[j];flight.posZ[j]=flight.launchZ[j]+Math.round(Math.sin(age/30*Math.PI)*512);flight.velX[j]=120;flight.velZ[j]=0;flight.remainingTicks[j]=30-age
    if(age===29)p.impact(i,arm,shot)
   }
   if(f%5===0)for(let i=0;i<24;i++)p.fire(i,0,0,2000+f)
   const t0=performance.now();p.draw(60+f*.04);const t1=performance.now();await p.ctx.device.queue.onSubmittedWorkDone();if(f>=40){cpu.push(t1-t0);wall.push(performance.now()-t0)}
   bodies=Math.max(bodies,p.fx.projectileStats.bodiesDrawn);lights=Math.max(lights,p.render.stats.lights)
  }
  flight.count=0;const p95=a=>a.sort((a,b)=>a-b)[Math.floor(a.length*.95)]
  return {actors:p.a.count,publishedFlights:n,peakBodies:bodies,peakLights:lights,cpuP95:p95(cpu),frameP95:p95(wall),dropped:p.audio.voicesDropped-startDrops,enginePreemptions:p.audio.engineStats?.preemptions??0}
 },{roster,styles})
 console.log('night battle',JSON.stringify(battle))

 let clip=null
 if(record){
  // Real browser WebAudio + renderer canvas, captured together; staged events use actual manifests.
  await page.evaluate(async()=>{
   const p=window.proof;p.stage(['tran','heli','hind','mh60','dd','pt','ss','msub'],4);p.camera.height=p.camera.heightGoal=19;p.camera.focusWorld(p.ox+24,p.oz+20);p.sky.setDaylightMode('night');p.draw(60)
   const stream=p.ctx.canvas.captureStream(25),destination=p.audio.actx.createMediaStreamDestination();p.audio.master.connect(destination)
   const combined=new MediaStream([...stream.getVideoTracks(),...destination.stream.getAudioTracks()]),parts=[],recorder=new MediaRecorder(combined,{mimeType:'video/webm;codecs=vp9,opus',videoBitsPerSecond:4000000})
   window.recording={recorder,parts,stream,destination};recorder.ondataavailable=e=>{if(e.data.size)parts.push(e.data)};recorder.start()
  })
  for(let chunk=0;chunk<8;chunk++)await page.evaluate(async chunk=>{const p=window.proof;for(let f=0;f<25;f++){const t=chunk+f/25;p.move(t);if(f%10===0){p.fire(1,0,0,chunk*3+f+1);p.fire(4,0,0,chunk*3+f+1)}if(f%10===5){p.impact(1);p.impact(4)}p.draw(61+t);await new Promise(r=>setTimeout(r,40))}},chunk)
  const data=await page.evaluate(async()=>{const r=window.recording;await new Promise(resolve=>{r.recorder.onstop=resolve;r.recorder.stop()});r.stream.getTracks().forEach(t=>t.stop());window.proof.audio.master.disconnect(r.destination);const blob=new Blob(r.parts,{type:'video/webm'});return await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsDataURL(blob)})})
  clip='night-air-naval-audio.webm';writeFileSync(join(out,clip),Buffer.from(data.split(',')[1],'base64'))
 }
 if(record){
  // Every flying and floating type, including transports, in a day movement/landing clip.
  await page.evaluate(()=>{const p=window.proof;p.stage(p.names);p.camera.height=p.camera.heightGoal=23;p.camera.focusWorld(p.ox+26,p.oz+22);p.sky.setDaylightMode('day');p.draw(80)})
  await captureVideo(page,out,'day-all-types-audio.webm',10,async second=>{
   await page.evaluate(async second=>{const p=window.proof;for(let f=0;f<25;f++){const t=second+f/25;p.move(t);if(t>7)for(let i=0;i<4;i++)p.a.posZ[i]=Math.max(0,(10-t)/3*2.6)*1024;p.draw(81+t);await new Promise(r=>setTimeout(r,40))}},second)
  })
  await page.evaluate(()=>window.proof.crashStart(100))
  await captureVideo(page,out,'aircraft-crashes-audio.webm',8,async second=>{await page.evaluate(async second=>{const p=window.proof;for(let f=0;f<25;f++){p.crashStep(second+f/25,100);await new Promise(r=>setTimeout(r,40))}},second)})
  for(const [directory,videoName,crashReplay]of [['host-flights','real-weapon-flights-audio.webm',false],['host-crashes','real-aircraft-crashes-audio.webm',true]]){
  const replay=resolve(WEB_ROOT,'../.artifacts/air-naval/'+directory),files=readdirSync(replay).filter(n=>/^frame-\d+\.ssnp$/.test(n)).sort()
  assert(files.length>200,'actual host recording must contain enough simulation frames')
  const types=readFileSync(join(replay,'types.txt'),'utf8'),initial=readFileSync(join(replay,'initial.ssnp')).toString('base64')
  await page.evaluate(({types,initial,crashReplay})=>{const p=window.proof,app=p.app;app.events.emit('session:new-world');let pending=null
   app.bridge={...app.bridge,snapshotTypeTable:()=>types,pollSnapshot:()=>{const bytes=pending;pending=null;return bytes}};app.typeTable=null;app.snapState.prev=null
   p.loadActual=(encoded,at)=>{pending=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));app.renderOneFrame(at)}
   p.crashReplayFrames=0;p.crashReplayImpacts=p.units.deathStats.impacts;
   const load=p.loadActual;p.loadActual=(encoded,at)=>{load(encoded,at);if(p.units.deathStats.crashes>0)p.crashReplayFrames++};
   p.camera.height=p.camera.heightGoal=crashReplay?23:29;p.camera.focusWorld(19,crashReplay?18:22);p.sky.setDaylightMode('day');p.loadActual(initial,100000)
   const a=p.ctx.snapshot.actors,expected=types.split('\n')
   for(let i=0;i<a.count;i++){const name=expected[a.typeId[i]];if(['v2rl','4tnk','e3','heli','fact'].includes(name)&&p.units.typeSlot.get(a.typeId[i])!==name)throw Error('replay type binding stale: '+name)}
   for(let i=0;i<20;i++)app.renderOneFrame(100000+i*16)
  },{types,initial,crashReplay})
  await captureVideo(page,out,videoName,Math.ceil(files.length/25),async second=>{
   const frames=files.slice(second*25,(second+1)*25).map(file=>readFileSync(join(replay,file)).toString('base64'))
   await page.evaluate(async({frames,second})=>{for(let f=0;f<frames.length;f++){window.proof.loadActual(frames[f],101000+(second*25+f)*40);await new Promise(r=>setTimeout(r,40))}},{frames,second})
  })
  if(crashReplay){const proof=await page.evaluate(()=>({frames:window.proof.crashReplayFrames,impacts:window.proof.units.deathStats.impacts-window.proof.crashReplayImpacts}));assert(proof.frames>25&&proof.impacts>=4,'real destroyed aircraft must reach rendered crashes '+JSON.stringify(proof));writeFileSync(join(out,'real-crash-proof.json'),JSON.stringify(proof,null,2))}
  }
 }
 const finalGpuErrors=await page.evaluate(()=>window.gpuErrors)
 const report={status:errors.length||finalGpuErrors.length?'failed':'passed',staged:true,quality,baseline,dist,indexSha256:createHash('sha256').update(readFileSync(join(dist,'index.html'))).digest('hex'),setup,evidence,sockets,lifecycle,crashes,perf,battle,clip,errors,gpuErrors:finalGpuErrors}
 writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2));assert.equal(errors.length,0,JSON.stringify(errors));assert.equal(finalGpuErrors.length,0,JSON.stringify(finalGpuErrors));console.log('airnaval-integrationgate: PASS',out)
}finally{await browser?.close();await new Promise(r=>server.close(r))}

async function captureVideo(page,out,name,seconds,step){
 await page.evaluate(()=>{const p=window.proof,stream=p.ctx.canvas.captureStream(25),destination=p.audio.actx.createMediaStreamDestination();p.audio.master.connect(destination)
  const recorder=new MediaRecorder(new MediaStream([...stream.getVideoTracks(),...destination.stream.getAudioTracks()]),{mimeType:'video/webm;codecs=vp9,opus',videoBitsPerSecond:4000000}),parts=[]
  window.extraRecording={recorder,parts,stream,destination};recorder.ondataavailable=e=>{if(e.data.size)parts.push(e.data)};recorder.start()
 })
 for(let i=0;i<seconds;i++)await step(i)
 const data=await page.evaluate(async()=>{const r=window.extraRecording;await new Promise(resolve=>{r.recorder.onstop=resolve;r.recorder.stop()});r.stream.getTracks().forEach(t=>t.stop());window.proof.audio.master.disconnect(r.destination)
  return new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsDataURL(new Blob(r.parts,{type:'video/webm'}))})
 });writeFileSync(join(out,name),Buffer.from(data.split(',')[1],'base64'))
}
