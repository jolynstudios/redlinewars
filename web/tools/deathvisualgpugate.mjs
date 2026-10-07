#!/usr/bin/env node
// Staged destruction events in the production app/GPU. NOT a real combat witness.
import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {WEB_ROOT,launchGpuBrowser,loadChromium,startPreview,stopChild} from './harness.mjs'
import {decodePng} from './png.mjs'
const out=join(WEB_ROOT,'.artifacts/visual-quality/deaths')
let preview,browser
try{
 mkdirSync(out,{recursive:true});preview=await startPreview(8465)
 ;({browser}=await launchGpuBrowser(await loadChromium('deathvisualgpugate'),'deathvisualgpugate'))
 const page=await browser.newPage({viewport:{width:900,height:900},deviceScaleFactor:1}),errors=[]
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('favicon'))errors.push(m.text())})
 await page.addInitScript(()=>{globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{}})
 await page.goto(`${preview.baseUrl}?devmap=1&manual=1&deterministic=1&devsize=48&devactors=1&devtod=720&quality=low`)
 await page.waitForFunction(()=>globalThis.steelseed,undefined,{timeout:120000,polling:100})
 const result=await page.evaluate(async()=>{
  const app=steelseed;app.stop();app.renderOneFrame(0)
  let frame=1
  // Snapshot intake awaits the actor table; synchronous frames cannot settle it.
  for(let i=0;i<120&&app.ctx.snapshot===null;i++){
   await new Promise(resolve=>setTimeout(resolve,16))
   app.renderOneFrame(frame++*1000/60)
  }
  app.bridge.pollSnapshot=()=>null
  const ctx=app.ctx,r=ctx.get('render'),u=ctx.get('units'),cam=ctx.get('camera'),wrecks=app.registry.peek('wrecks'),fx=app.registry.peek('fx')
  const visible={isVisible(){return true},stateAt(){return 2},unmodelled:false},flat={heightAt(){return 0}}
  // Controlled visibility and flat support isolate skin/fade pixels from terrain/weather.
  u.shroud=visible
  cam.height=cam.heightGoal=5;cam.yaw=cam.yawGoal=.7;cam.target[0]=cam.targetGoal[0]=24;cam.target[1]=cam.targetGoal[1]=0;cam.target[2]=cam.targetGoal[2]=24
  app.renderOneFrame(frame++*1000/60);r.setShroud(new Uint8Array(48*48).fill(2),48,48,0,0);r.debugView=1;r.probes.updatesPerFrame=0
  function finish(){
   r.frameIndex=0;r.historyValid=false;r.lateUpdate(1/60,ctx)
   const c=document.createElement('canvas');c.width=ctx.canvas.width;c.height=ctx.canvas.height;c.getContext('2d').drawImage(ctx.canvas,0,0)
   return {png:c.toDataURL(),draws:r.stats.drawCalls,dropped:r.stats.dropped}
  }
  const rows=[]
  for(const [name,scale] of [['e1',8],['1tnk',2]]){
   u.deaths.clear();const b=u.slotBuckets.get(name);if(!b?.rig)throw Error(`missing saved ${name} rig`)
   const bones=b.rig.skeleton.boneCount,p=r.reserveBones(bones)
   if(!p)throw Error('capture palette overflow')
   for(let i=0;i<bones*16;i++)p.matrices[i]=i%16%5===0?1:0
   const m=Float32Array.of(scale,0,0,0,0,scale,0,0,0,0,scale,0,24,0,24,1),id=name==='e1'?0x7ffffff0:0x7ffffff1
   b.count=1;b.instances.set(m);b.motionIds[0]=id;b.colors[0]=2;b.paletteBases[0]=p.base
   r.submit({mesh:b.mesh,surfaceSet:b.surfaceSet,instances:m,instanceCount:1,playerColors:Uint8Array.of(2),paletteBases:Uint16Array.of(p.base),boneCount:bones,castsShadow:true})
   const standing=finish(),view=ctx.snapshot.view,off=view.byteLength-40
   view.setUint32(off,id,true);view.setInt32(off+4,24*1024,true);view.setInt32(off+8,24*1024,true);view.setInt32(off+12,0,true);view.setUint8(off+16,0);view.setUint8(off+17,200)
   const persistentBefore=wrecks.stats.retained,explosionBefore=fx.stats.acceptedDestroyedEvents,time=ctx.time.tick/25
   app.events.emit('sim:actor:destroyed',{kind:5,offset:off,byteLength:18})
   if(u.deathStats.births<1)throw Error(`${name} event did not capture a body`)
   if(wrecks.stats.retained!==persistentBefore)throw Error('duplicate persistent intact corpse')
   const captures=[]
   for(const age of [0,1,1,name==='e1'?4.5:2.2,6,6]){
    u.deaths.update(time+age,r,flat,visible)
    captures.push({...finish(),age,active:u.deathStats.active,parts:u.deathStats.parts})
   }
   const appearance=[]
   if(name==='1tnk'){
    const e=u.deaths.entries.find(e=>e.id===id)
    for(const damage of [0,1]){
     const p=r.reserveBones(bones);p.matrices.set(e.skin.subarray(0,bones*16));e.palette[0]=p.base
     e.damages[0]=damage;e.item.opacity=.5;e.item.castsShadow=false;r.submit(e.item);appearance.push(finish())
    }
   }
   rows.push({name,standing,captures,appearance,bones,acceptedDestroyed:fx.stats.acceptedDestroyedEvents-explosionBefore})
  }
  return rows
 })
 assert.deepEqual(errors,[])
 function diff(a,b){let n=0;for(let i=0;i<a.data.length;i+=4)if(Math.abs(a.data[i]-b.data[i])+Math.abs(a.data[i+1]-b.data[i+1])+Math.abs(a.data[i+2]-b.data[i+2])>9)n++;return n}
 const report=[]
 for(const row of result){
  const pixels=row.captures.map(c=>decodePng(Buffer.from(c.png.split(',')[1],'base64')))
  const motion=diff(pixels[0],pixels[1]),pause=diff(pixels[1],pixels[2]),fade=diff(pixels[2],pixels[3]),gone=diff(pixels[4],pixels[5]),visible=diff(pixels[1],pixels[4])
  for(let i=0;i<row.captures.length;i++)writeFileSync(join(out,`${row.name}-${i}.png`),Buffer.from(row.captures[i].png.split(',')[1],'base64'))
  console.log('deathvisualgpugate measurements',JSON.stringify({name:row.name,motion,pause,fade,gone,visible,captures:row.captures.map(({age,active,parts,draws,dropped})=>({age,active,parts,draws,dropped}))}))
  assert.ok(motion>100,`${row.name} animation must visibly change source geometry`);assert.equal(pause,0);assert.ok(fade>30);assert.equal(gone,0);assert.ok(visible>100)
  assert.equal(row.captures[4].active,0);for(const c of row.captures)assert.equal(c.dropped,0)
  if(row.appearance.length){
   const damagePixels=diff(...row.appearance.map(c=>decodePng(Buffer.from(c.png.split(',')[1],'base64'))))
   assert.ok(damagePixels>100,'damage must still affect GPU material while opacity is .5')
   console.log('deathvisualgpugate translucent damage pixels',damagePixels)
  }
  report.push({name:row.name,motion,pause,fade,gone,visible,bones:row.bones})
 }
 writeFileSync(join(out,'report.json'),JSON.stringify({report,note:'Staged events + enlarged production meshes in actual renderer; not real combat or completed art.'},null,2))
 console.log('deathvisualgpugate PASS',JSON.stringify(report))
}finally{await browser?.close();if(preview)await stopChild(preview.server)}
