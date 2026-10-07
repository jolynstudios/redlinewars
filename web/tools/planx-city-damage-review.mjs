#!/usr/bin/env node
// Isolated fixture: reviewed sources through production decoder, GPU and parent surfaces.
// No game rules, canonical pack or source renderer/shader changes.
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
import {build} from 'esbuild'
import {WEB_ROOT,launchGpuBrowser,loadChromium,startPreview,stopChild} from './harness.mjs'
import {decodePng} from './png.mjs'
const root=resolve(WEB_ROOT,'..'),proof=resolve(root,process.env.CITY_PROOF_DIR??'.artifacts/planx/city-damage-proof')
const out=resolve(root,process.env.CITY_RUNTIME_DIR??'.artifacts/planx/city-damage-runtime');mkdirSync(out,{recursive:true})
const hash=b=>createHash('sha256').update(b).digest('hex')
const input=(process.env.CITY_ACTORS??'v03,v25').split(',').map(actor=>{
 const manifest=JSON.parse(readFileSync(join(proof,'exports',actor,'manifest.json')))
 const bytes=readFileSync(join(proof,'exports',actor,'states.ssmesh'))
 assert.equal(hash(bytes),manifest.sha256)
 return {actor,manifest,bytes:Array.from(bytes)}
})
const injection=await build({stdin:{contents:`export {decodeBlenderAsset} from './src/units/blender-mesh.ts'; export {MeshStore} from './src/render/gpumesh.ts';`,resolveDir:WEB_ROOT},write:false,bundle:true,platform:'browser',format:'iife',globalName:'cityApi',logLevel:'silent'})
let preview,browser
try{
 preview=await startPreview(8489)
 const launched=await launchGpuBrowser(await loadChromium('planx-city-damage-review'),'planx-city-damage-review');browser=launched.browser
 const page=await browser.newPage({viewport:{width:900,height:800},deviceScaleFactor:1});const errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 page.on('console',m=>{if(m.type()==='error'||m.text().includes('ShaderModule'))console.log('BROWSER',m.text())})
 await page.addInitScript(()=>{globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{}})
 await page.goto(`${preview.baseUrl}?devmap=1&manual=1&deterministic=1&devsize=48&devactors=1&devtod=720&quality=high`)
 await page.waitForFunction(()=>globalThis.steelseed,undefined,{timeout:120000,polling:100})
 await page.addScriptTag({content:injection.outputFiles[0].text})
 const rows=await page.evaluate(async input=>{
  const app=steelseed;app.stop();app.renderOneFrame(0);app.bridge.pollSnapshot=()=>null
  const ctx=app.ctx,r=ctx.get('render'),units=ctx.get('units'),cam=ctx.get('camera'),device=ctx.device
  if(ctx.backend!=='webgpu')throw Error('WebGPU required')
  const visible={isVisible(){return true},stateAt(){return 2},unmodelled:false};units.shroud=visible
  cam.target[0]=cam.targetGoal[0]=24;cam.target[1]=cam.targetGoal[1]=1;cam.target[2]=cam.targetGoal[2]=24
  cam.yawRaw=cam.yawGoal=.7;cam.height=cam.heightGoal=8
  app.renderOneFrame(1000/60);r.setShroud(new Uint8Array(48*48).fill(2),48,48,0,0)
  r.probes.updatesPerFrame=0;r.debugView=0
  const store=new cityApi.MeshStore(device),rows=[]
  for(const pack of input){
   const parent=units.slotBuckets.get(pack.actor)
   if(!parent?.mesh)throw Error('missing parent bucket '+pack.actor)
   const raw=new Uint8Array(pack.bytes)
   for(let j=0;j<pack.manifest.states.length;j++){
    const entry=pack.manifest.states[j],decoded=cityApi.decodeBlenderAsset(raw,entry)
    const validation=decoded.mesh.validate();if(validation)throw Error(JSON.stringify(validation))
    device.pushErrorScope('validation');const mesh=store.upload(decoded.mesh,'city-proof:'+pack.actor+'.d'+(j+1))
    const bounds=entry.bounds,span=bounds[1].map((v,i)=>v-bounds[0][i]);const h=Math.max(span[0],span[2],span[1]*.9)*1.85;cam.height=cam.heightGoal=h
    cam.target[1]=cam.targetGoal[1]=(bounds[0][1]+bounds[1][1])*.4
    cam.update(0,ctx)
    for(const [label,damage] of [['clean',0],['damaged',[.15,.40,.70,.92,1][j]]]){
     const bones=decoded.rig?.skeleton.boneCount??0
     const transform=Float32Array.of(1,0,0,0,0,1,0,0,0,0,1,0,24,0,24,1)
     const frames=label==='clean'?16:2
     let png
     for(let f=0;f<frames;f++){
      const p=bones?r.reserveBones(bones):null
      if(bones&&!p)throw Error('palette overflow')
      if(p)for(let i=0;i<bones*16;i++)p.matrices[i]=i%16%5===0?1:0
      r.submit({mesh,surfaceSet:parent.surfaceSet,instances:transform,instanceCount:1,
       playerColors:Uint8Array.of(0),paletteBases:p?Uint16Array.of(p.base):null,boneCount:bones,
       damages:Float32Array.of(damage),castsShadow:true})
      r.historyValid=false;r.frameIndex=0;r.lateUpdate(1/60,ctx)
      if(f===frames-1){const c=document.createElement('canvas');c.width=ctx.canvas.width;c.height=ctx.canvas.height;c.getContext('2d').drawImage(ctx.canvas,0,0);png=c.toDataURL()}
     }
     rows.push({actor:pack.actor,rung:j+1,label,damage,png,surfaceSet:parent.surfaceSet,triangles:entry.triangles,
      draws:r.stats.drawCalls,dropped:r.stats.dropped,debugView:r.debugView,backend:ctx.backend})
    }
    const gpuError=await device.popErrorScope();if(gpuError)throw Error(gpuError.message)
   }
  }
  store.dispose();return rows
 },input)
 assert.deepEqual(errors,[])
 for(const row of rows)writeFileSync(join(out,`${row.actor}.d${row.rung}-${row.label}.png`),Buffer.from(row.png.split(',')[1],'base64'))
 const comparisons=[]
 for(let i=0;i<rows.length;i+=2){
  const pair=rows.slice(i,i+2),images=pair.map(row=>decodePng(Buffer.from(row.png.split(',')[1],'base64')))
  let diff=0,cleanLum=0,damagedLum=0,mask=0,totalClean=0,totalDamaged=0
  for(let p=0;p<images[0].data.length;p+=4){
   const a=images[0].data,b=images[1].data
   totalClean+=a[p]+a[p+1]+a[p+2];totalDamaged+=b[p]+b[p+1]+b[p+2]
   if(Math.abs(a[p]-b[p])+Math.abs(a[p+1]-b[p+1])+Math.abs(a[p+2]-b[p+2])>12){diff++;cleanLum+=a[p]+a[p+1]+a[p+2];damagedLum+=b[p]+b[p+1]+b[p+2];mask++}
  }
  console.log('PAIR',pair[0].actor,pair[0].rung,diff,cleanLum,damagedLum)
  assert.ok(diff>50,`${pair[0].actor}.d${pair[0].rung}: health material must visibly change pixels`)
  assert.ok(totalDamaged<totalClean,'damage must reduce integrated image luminance; a high-difference mask biases subtle light damage toward specular edges')
  comparisons.push({actor:pair[0].actor,rung:pair[0].rung,changedPixels:diff,integratedRgbDelta:totalDamaged-totalClean,changedMeanClean:cleanLum/(mask*3),changedMeanDamaged:damagedLum/(mask*3)})
  for(const row of pair){assert.equal(row.dropped,0);writeFileSync(join(out,`${row.actor}.d${row.rung}-${row.label}.png`),Buffer.from(row.png.split(',')[1],'base64'));delete row.png}
 }
 writeFileSync(join(out,'report.json'),JSON.stringify({status:'PASS',browser:launched.label,rows,comparisons,
  scope:'Synthetic visible single-asset fixture through actual production decoder, MeshStore, parent resolved material set, detail map and unmodified health shader. No combat/simulation/pathfinding certification.',packHashes:input.map(p=>({actor:p.actor,sha256:p.manifest.sha256})),shaderPatches:0},null,2))
 console.log('CITY_RUNTIME_PASS',JSON.stringify(comparisons))
}finally{await browser?.close();if(preview)await stopChild(preview.server)}
