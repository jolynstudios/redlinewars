#!/usr/bin/env node
import assert from 'node:assert/strict'
import {writeFileSync,mkdirSync}from'node:fs'
import {launchGpuBrowser,loadChromium,startPreview,stopChild}from'./harness.mjs'
const out=new URL('../../.artifacts/planx/warzone-runtime/',import.meta.url).pathname;mkdirSync(out,{recursive:true});const preview=await startPreview(8486);let browser
try{
 ({browser}=await launchGpuBrowser(await loadChromium('warzoneintegrationgate'),'warzoneintegrationgate'))
 const page=await browser.newPage({viewport:{width:1280,height:900},deviceScaleFactor:1}),errors=[]
 page.on('pageerror',e=>errors.push(e.message));page.on('console',e=>{if(e.type()==='error')errors.push(e.text())})
 await page.addInitScript(()=>{globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{}})
 await page.goto(`${preview.baseUrl}?devmap=1&manual=1&deterministic=1&devsize=48&devactors=100&devtod=720&quality=high`)
 await page.waitForFunction(()=>globalThis.steelseed,undefined,{timeout:180000,polling:100})
 // Condition ladders land in the background after boot (units loads 59 packs async);
 // the ambient pre-damage assertions below need the v01 rungs to exist first.
 await page.waitForFunction(()=>{const u=globalThis.steelseed?.ctx?.get('units');return !!u&&u.slotBuckets.has('v01.d4')},undefined,{timeout:120000,polling:200})
 const result=await page.evaluate(async()=>{
  const app=steelseed;app.stop();app.renderOneFrame(0);app.bridge.pollSnapshot=()=>null
  const ctx=app.ctx,units=ctx.get('units'),r=ctx.get('render'),terrain=ctx.get('terrain'),shroud=ctx.get('shroud'),cam=ctx.get('camera'),snap=ctx.snapshot,actors=snap.actors,g=terrain.grid,original=ctx.actorTypeName
  ctx.actorTypeName=id=>id===1000?'v01':original(id)
  const view={w:g.w,h:g.h,type:g.type.slice(),height:g.height.slice(),ramp:g.ramp.slice(),passability:g.passability.slice(),resource:g.resource.slice(),surface:g.surface.slice()}
  view.height.fill(2);view.ramp.fill(0);view.resource.fill(0);view.passability.fill(7);view.surface.fill(5)
  terrain.rebuild(view,g.originX,g.originY,ctx);units.scenery.onSnapshot({...snap,flags:snap.flags|1,terrainStatic:view})
  snap.shroud=[{cellIndex:0,runLength:g.w*g.h,state:2}];shroud.onSnapshot(snap,null,ctx)
  for(let i=0;i<actors.count;i++){actors.typeId[i]=1000;actors.displayTypeId[i]=1000;actors.posX[i]=(g.originX+9+(i%10)*3)*1024;actors.posY[i]=(g.originY+9+Math.floor(i/10)*3)*1024;actors.posZ[i]=0;actors.flags[i]=0;actors.health[i]=255;actors.facing[i]=768}
  snap.tick=100;app.snapState.prev=null;ctx.time.tick=100;ctx.time.alpha=1;units.onSnapshot(snap,null,ctx)
  cam.height=cam.heightGoal=28;cam.target[0]=cam.targetGoal[0]=g.originX+22.5;cam.target[2]=cam.targetGoal[2]=g.originY+22.5
  const draw=()=>{ctx.time.dt=.04;ctx.time.elapsed=ctx.time.tick/25;ctx.time.frame++;app.registry.update(.04,ctx);app.registry.lateUpdate(.04,ctx)}
  const read=()=>{const rows=[];for(const [slot,b]of units.slotBuckets)if(slot==='v01'||slot.startsWith('v01.d'))for(let i=0;i<b.count;i++)rows.push({id:b.motionIds[i],slot,damage:b.damages[i]});rows.sort((a,b)=>a.id-b.id);return{rows,health:Array.from(actors.health),water:{...ctx.get('fx').utilityWaterStats},render:{...r.stats}}}
  ctx.device.pushErrorScope('validation');for(let i=0;i<6;i++)draw();const before=read()
  const shot=()=>{const c=document.createElement('canvas');c.width=ctx.canvas.width;c.height=ctx.canvas.height;c.getContext('2d').drawImage(ctx.canvas,0,0);return c.toDataURL()}
  before.png=shot()
  actors.health.fill(40);snap.tick+=50;ctx.time.tick=snap.tick;draw();snap.tick+=50;ctx.time.tick=snap.tick;draw();const damaged=read()
  actors.health.fill(255);snap.tick+=50;ctx.time.tick=snap.tick;draw();snap.tick+=50;ctx.time.tick=snap.tick;draw();const repaired=read();repaired.png=shot()
  const error=await ctx.device.popErrorScope();if(error)throw Error(error.message)
  return{before,damaged,repaired,seed:ctx.config.assetSeed}
 })
 for(const name of ['before','repaired']){writeFileSync(out+name+'.png',Buffer.from(result[name].png.split(',')[1],'base64'));delete result[name].png}
 writeFileSync(out+'report.json',JSON.stringify({...result,errors},null,2));assert.deepEqual(errors,[])
 assert.equal(result.before.rows.length,100);assert.ok(result.before.health.every(h=>h===255))
 const damagedCount=result.before.rows.filter(r=>r.slot!=='v01').length
 assert.ok(damagedCount>=20&&damagedCount<=40,`100-building sample should be near30%, got${damagedCount}`)
 assert.ok(result.damaged.rows.every(r=>r.slot==='v01.d4'))
 assert.deepEqual(result.repaired.rows,result.before.rows,'repair must retain per-building condition and identity')
 assert.ok(result.repaired.health.every(h=>h===255));assert.equal(result.before.render.dropped,0)
 console.log('WARZONE_RUNTIME_PASS',JSON.stringify({buildings:100,preDamaged:damagedCount,initialLeaks:result.before.water,draws:result.before.render.drawCalls}))
}finally{await browser?.close();await stopChild(preview.server)}
