#!/usr/bin/env node
// Isolated bridge material fixture. No canonical assets, game rules or core edits.
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
import {gunzipSync} from 'node:zlib'
import {build} from 'esbuild'
import {WEB_ROOT,launchGpuBrowser,loadChromium,startPreview,stopChild} from './harness.mjs'
const root=resolve(WEB_ROOT,'..'),proof=join(root,'.artifacts/planx/bridge-proof'),out=join(root,'.artifacts/planx/bridge-runtime');mkdirSync(out,{recursive:true})
const hash=b=>createHash('sha256').update(b).digest('hex')
const input=['planx.bridge.intact','planx.bridge.partial'].map(id=>{const meta=JSON.parse(readFileSync(join(proof,id+'.json'))),raw=readFileSync(join(proof,id+'.ssmesh')),mask=gunzipSync(readFileSync(join(proof,'exports',meta.detailMask.file)));assert.equal(hash(mask),meta.detailMask.sha256);meta.offset=0;meta.bytes=raw.length;return{id,meta,raw:Array.from(raw),mask:Array.from(mask),rawHash:hash(raw)}})
const injection=await build({stdin:{contents:`export {decodeBlenderAsset} from './src/units/blender-mesh.ts';export {MeshStore} from './src/render/gpumesh.ts';`,resolveDir:WEB_ROOT},write:false,bundle:true,platform:'browser',format:'iife',globalName:'bridgeApi',logLevel:'silent'})
let preview,browser
try{
 preview=await startPreview(8489);const launched=await launchGpuBrowser(await loadChromium('planx-bridge-review'),'planx-bridge-review');browser=launched.browser
 const page=await browser.newPage({viewport:{width:1000,height:800},deviceScaleFactor:1}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'||m.text().includes('ShaderModule'))console.log('BROWSER',m.text())})
 await page.addInitScript(()=>{globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{}})
 await page.goto(`${preview.baseUrl}?devmap=1&manual=1&deterministic=1&devsize=48&devactors=1&devtod=720&quality=high`);await page.waitForFunction(()=>globalThis.steelseed,undefined,{timeout:120000,polling:100});await page.addScriptTag({content:injection.outputFiles[0].text})
 const rows=await page.evaluate(async input=>{
  const app=steelseed;app.stop();app.renderOneFrame(0);app.bridge.pollSnapshot=()=>null
  const ctx=app.ctx,r=ctx.get('render'),units=ctx.get('units'),cam=ctx.get('camera'),device=ctx.device,mats=ctx.get('materials');if(ctx.backend!=='webgpu')throw Error('WebGPU required')
  units.shroud={isVisible(){return true},stateAt(){return 2},unmodelled:false};cam.target[0]=cam.targetGoal[0]=24;cam.target[1]=cam.targetGoal[1]=.6;cam.target[2]=cam.targetGoal[2]=24;cam.yawRaw=cam.yawGoal=.7;cam.height=cam.heightGoal=13
  app.renderOneFrame(1000/60);r.setShroud(new Uint8Array(48*48).fill(2),48,48,0,0);r.probes.updatesPerFrame=0;r.debugView=0
  const store=new bridgeApi.MeshStore(device),rows=[],resources=[]
  for(const p of input){
   device.pushErrorScope('validation');const decoded=bridgeApi.decodeBlenderAsset(new Uint8Array(p.raw),p.meta),error=decoded.mesh.validate();if(error)throw Error(error)
   const mesh=store.upload(decoded.mesh,p.id),base=mats.get('industrial-v1'),size=p.meta.detailMask.size,count=Math.log2(size)+1
   const texture=device.createTexture({label:'bridge-proof-UV1',size:[size,size],mipLevelCount:count,format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});resources.push(texture)
   let pixels=new Uint8Array(p.mask),side=size
   for(let mip=0;mip<count;mip++){
    device.queue.writeTexture({texture,mipLevel:mip},pixels,{bytesPerRow:side*4,rowsPerImage:side},[side,side]);if(side===1)break
    const next=side/2,result=new Uint8Array(next*next*4);for(let y=0;y<next;y++)for(let x=0;x<next;x++)for(let c=0;c<4;c++){const i=(y*2*side+x*2)*4+c;result[(y*next+x)*4+c]=Math.round((pixels[i]+pixels[i+4]+pixels[i+side*4]+pixels[i+side*4+4])/4)}pixels=result;side=next
   }
   const surface=Object.assign(Object.create(base),{id:'bridge-proof:'+p.id,detailMaskView:texture.createView()});mats.sets.set(surface.id,surface);mats.bindGroupFor(surface)
   for(const [view,yaw,damage] of [['front',.7,0],['rear',3.85,0],['side',2.25,0],...(p.id.endsWith('partial')?[['front-health',.7,.65]]:[])]){
    cam.yawRaw=cam.yawGoal=yaw;cam.target[1]=cam.targetGoal[1]=.6;cam.update(0,ctx);let png
    for(let f=0;f<12;f++){
     r.submit({mesh,surfaceSet:surface.id,instances:Float32Array.of(1,0,0,0,0,1,0,0,0,0,1,0,24,0,24,1),instanceCount:1,playerColors:Uint8Array.of(0),damages:Float32Array.of(damage),castsShadow:true});r.historyValid=false;r.frameIndex=0;r.lateUpdate(1/60,ctx)
     if(f===11){const c=document.createElement('canvas');c.width=ctx.canvas.width;c.height=ctx.canvas.height;c.getContext('2d').drawImage(ctx.canvas,0,0);png=c.toDataURL()}
    }
    rows.push({id:p.id,view,damage,png,triangles:p.meta.triangles,dropped:r.stats.dropped,backend:ctx.backend,surfaceSet:surface.id})
   }
   const gpuError=await device.popErrorScope();if(gpuError)throw Error(gpuError.message)
  }
  store.dispose();for(const t of resources)t.destroy();return rows
 },input)
 assert.deepEqual(errors,[]);for(const r of rows){assert.equal(r.dropped,0);writeFileSync(join(out,r.id+'-'+r.view+'.png'),Buffer.from(r.png.split(',')[1],'base64'));delete r.png}
 writeFileSync(join(out,'report.json'),JSON.stringify({status:'PASS',rows,geometryHashes:input.map(p=>({id:p.id,sha256:p.rawHash,maskSha256:p.meta.detailMask.sha256})),shaderEdits:0,scope:'Isolated material witness with production industrial-v1 arrays, exact authored UV1 texture, decoder and GPU renderer. Health=0 on all 3 views; additional partial health=.65 comparison. No gameplay traversal proof or shipping integration.'},null,2)+'\n');console.log('BRIDGE_RUNTIME_PASS',rows.length)
}finally{await browser?.close();if(preview)await stopChild(preview.server)}
