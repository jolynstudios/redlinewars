#!/usr/bin/env node
// Replays unmodified real-engine snapshots through all production presentation nodes.
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,readdirSync,mkdirSync}from'node:fs'
import {resolve,join}from'node:path'
import {WEB_ROOT,launchGpuBrowser,loadChromium,startPreview,stopChild}from'./harness.mjs'
const root=resolve(WEB_ROOT,'..'),input=join(root,'.artifacts/planx/'+(process.argv.includes('--visibility')?'bridge-visibility':'bridge-engine')),out=join(root,'.artifacts/planx/'+(process.argv.includes('--visibility')?'bridge-map-visibility':'bridge-map-runtime')+(process.argv.includes('--clear')?'-clear':''));mkdirSync(out,{recursive:true})
const names=JSON.parse(readFileSync(join(input,'types.json'))),engine=JSON.parse(readFileSync(join(input,'report.json'))),snapshots=readdirSync(input).filter(p=>p.endsWith('.bin')).map(file=>({file,bytes:Array.from(readFileSync(join(input,file))),tick:Number(file.match(/-(\d+)\.bin$/)[1])})).sort((a,b)=>a.tick-b.tick)
assert.ok(snapshots.length>=(process.argv.includes('--initial')?1:3),'requires actual initial, repair and destruction terrain emissions')
let preview,browser;const result=[]
try{
 preview=await startPreview(8489);({browser}=await launchGpuBrowser(await loadChromium('herobridgerendergate'),'herobridgerendergate'))
 const page=await browser.newPage({viewport:{width:1200,height:900},deviceScaleFactor:1}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())})
 await page.addInitScript(()=>{globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{}})
 await page.goto(`${preview.baseUrl}?devmap=1&manual=1&deterministic=1&devsize=48&devactors=1&devtod=720&quality=high`);await page.waitForFunction(()=>globalThis.steelseed,undefined,{timeout:120000,polling:100})
 await page.evaluate(({names,clear})=>{const app=steelseed;app.stop();app.renderOneFrame(0);app.typeTable=names;app.bridge.snapshotTypeTable=()=>names.join('\n');app.bridge.pollSnapshot=()=>null;app.ctx.get('render').probes.updatesPerFrame=0;if(clear){const sky=app.ctx.get('sky'),r=app.ctx.get('render');sky.update=()=>{sky.model.evaluate(720,0,0,0,0);sky.model.advance(3);r.setEnvironment(sky.model)}}},{names,clear:process.argv.includes('--clear')})
 for(const snapshot of snapshots){
  const rows=await page.evaluate(async snapshot=>{
   const app=steelseed,ctx=app.ctx,r=ctx.get('render'),cam=ctx.get('camera'),terrain=ctx.get('terrain'),device=ctx.device
   device.pushErrorScope('validation');let pending=new Uint8Array(snapshot.bytes);app.bridge.pollSnapshot=()=>{const p=pending;pending=null;return p};app.renderOneFrame(snapshot.tick*40)
   const bridges=[...terrain.bridgeKnowledge.known.values()];if(bridges.length>1)throw Error('Unexpected duplicate bridge')
   const b=bridges[0]??{x:32,z:23.5,state:'unexplored'},rows=[]
   for(const [view,yaw,height]of[['front',.7,14],['rear',3.85,14],['lane',1.57,10]]){
    cam.target[0]=cam.targetGoal[0]=b.x;cam.target[1]=cam.targetGoal[1]=-.3;cam.target[2]=cam.targetGoal[2]=b.z;cam.yawRaw=cam.yawGoal=yaw;cam.height=cam.heightGoal=height
    for(let f=0;f<12;f++){r.historyValid=false;app.renderOneFrame(snapshot.tick*40+f*16)}
    const c=document.createElement('canvas');c.width=ctx.canvas.width;c.height=ctx.canvas.height;c.getContext('2d').drawImage(ctx.canvas,0,0)
    rows.push({view,state:b.state,tick:snapshot.tick,png:c.toDataURL(),draws:r.stats.drawCalls,triangles:r.stats.triangles,dropped:r.stats.dropped,backend:ctx.backend,deck:terrain.heightAt(b.x,b.z-1),water:terrain.waterHeightAt(b.x,b.z)})
   }
   const error=await device.popErrorScope();if(error)throw Error(error.message);return rows
  },snapshot)
  for(const row of rows){assert.equal(row.backend,'webgpu');assert.equal(row.dropped,0);const file=`${row.state}-${row.tick}-${row.view}.png`;writeFileSync(join(out,file),Buffer.from(row.png.split(',')[1],'base64'));delete row.png;row.file=file;result.push(row)}
 }
 assert.deepEqual(errors,[]);writeFileSync(join(out,'report.json'),JSON.stringify({schema:1,pass:true,source:'Unmodified snapshots from actual OpenRA herobridgegate; production terrain/scenery/material/units nodes. No visibility override.',enginePassed:engine.pass===true,clearLightingFixture:process.argv.includes('--clear'),rows:result},null,2)+'\n');console.log('herobridgerendergate: PASS',result.length)
}finally{await browser?.close();if(preview)await stopChild(preview.server)}
