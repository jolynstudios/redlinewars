#!/usr/bin/env node
// Isolated destroyer material fixture. No canonical assets, game rules or core edits.
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
import {gunzipSync} from 'node:zlib'
import {build} from 'esbuild'
import {WEB_ROOT,launchGpuBrowser,loadChromium,startPreview,stopChild} from './harness.mjs'
const root=resolve(WEB_ROOT,'..'),proof=process.env.NAVAL_PROOF?resolve(process.env.NAVAL_PROOF):join(root,'.artifacts/planx/naval/dd-v5'),out=process.env.NAVAL_OUT?resolve(process.env.NAVAL_OUT):join(root,'.artifacts/planx/naval/runtime-v5');mkdirSync(out,{recursive:true})
const hash=b=>createHash('sha256').update(b).digest('hex')
const input=(process.env.NAVAL_IDS??'dd').split(',').map(id=>{const meta=JSON.parse(readFileSync(join(proof,id+'.json'))),raw=readFileSync(join(proof,id+'.ssmesh')),mask=gunzipSync(readFileSync(join(proof,'exports',meta.detailMask.file)));assert.equal(hash(mask),meta.detailMask.sha256);meta.offset=0;meta.bytes=raw.length;return{id,meta,raw:Array.from(raw),mask:Array.from(mask),rawHash:hash(raw)}})
const parentMaskRoot=process.env.NAVAL_PARENT_MASK?resolve(process.env.NAVAL_PARENT_MASK):null
if(parentMaskRoot){const parent=JSON.parse(readFileSync(join(parentMaskRoot,'dd.json'))),mask=gunzipSync(readFileSync(join(parentMaskRoot,'exports',parent.detailMask.file)));for(const p of input){p.mask=Array.from(mask);p.maskControl='parent-negative-control'}}
const injection=await build({stdin:{contents:`export {decodeBlenderAsset} from './src/units/blender-mesh.ts';export {MeshStore} from './src/render/gpumesh.ts';export {setBoneAngle,computeWorldTransforms,computeSkinMatrices} from './src/geo/rig.ts';`,resolveDir:WEB_ROOT},write:false,bundle:true,platform:'browser',format:'iife',globalName:'navalApi',logLevel:'silent'})
let preview,browser
try{
 preview=await startPreview(8491,process.env.NAVAL_URL??null);const launched=await launchGpuBrowser(await loadChromium('planx-naval-review'),'planx-naval-review');browser=launched.browser
 const page=await browser.newPage({viewport:{width:1000,height:800},deviceScaleFactor:1}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'||m.text().includes('ShaderModule'))console.log('BROWSER',m.text())})
 await page.addInitScript(()=>{globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{}})
 await page.goto(`${preview.baseUrl}?devmap=1&manual=1&deterministic=1&devsize=48&devactors=1&devtod=720&quality=${process.env.NAVAL_QUALITY??'high'}`);await page.waitForFunction(()=>globalThis.steelseed,undefined,{timeout:120000,polling:100});await page.addScriptTag({content:injection.outputFiles[0].text})
 const rows=await page.evaluate(async ({input,production})=>{
  const app=steelseed;app.stop();app.renderOneFrame(0);app.bridge.pollSnapshot=()=>null
  const ctx=app.ctx,r=ctx.get('render'),units=ctx.get('units'),cam=ctx.get('camera'),device=ctx.device,mats=ctx.get('materials');if(ctx.backend!=='webgpu')throw Error('WebGPU required')
  units.shroud={isVisible(){return true},stateAt(){return 2},unmodelled:false};cam.target[0]=cam.targetGoal[0]=24;cam.target[1]=cam.targetGoal[1]=.6;cam.target[2]=cam.targetGoal[2]=24;cam.yawRaw=cam.yawGoal=.7;cam.height=cam.heightGoal=4.2
  app.renderOneFrame(1000/60);r.setShroud(new Uint8Array(48*48).fill(2),48,48,0,0);r.probes.updatesPerFrame=0;r.debugView=0
  const store=new navalApi.MeshStore(device),rows=[],resources=[]
  for(const p of input){
   device.pushErrorScope('validation');const decoded=navalApi.decodeBlenderAsset(new Uint8Array(p.raw),p.meta),error=decoded.mesh.validate();if(error)throw Error(error)
   const base=mats.get('industrial-v1');let mesh,surface
   if(production){const bucket=units.slotBuckets.get(p.id);if(!bucket?.mesh)throw Error('Production damage bucket absent: '+p.id);mesh=bucket.mesh;surface=mats.get(bucket.surfaceSet);if(surface.sourceSha256!==p.meta.sourceSha256)throw Error('Production rung material source mismatch');if(surface.albedo!==base.albedo||surface.normal!==base.normal)throw Error('Damage duplicated parent PBR arrays')}
   else {
   mesh=store.upload(decoded.mesh,p.id);const size=p.meta.detailMask.size,count=Math.log2(size)+1
   const texture=device.createTexture({label:'naval-proof-UV1',size:[size,size],mipLevelCount:count,format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});resources.push(texture)
   let pixels=new Uint8Array(p.mask),side=size
   for(let mip=0;mip<count;mip++){
    device.queue.writeTexture({texture,mipLevel:mip},pixels,{bytesPerRow:side*4,rowsPerImage:side},[side,side]);if(side===1)break
    const next=side/2,result=new Uint8Array(next*next*4);for(let y=0;y<next;y++)for(let x=0;x<next;x++)for(let c=0;c<4;c++){const i=(y*2*side+x*2)*4+c;result[(y*next+x)*4+c]=Math.round((pixels[i]+pixels[i+4]+pixels[i+side*4]+pixels[i+side*4+4])/4)}pixels=result;side=next
   }
   surface=Object.assign(Object.create(base),{id:'naval-proof:'+p.id,detailMaskView:texture.createView()});mats.sets.set(surface.id,surface);mats.bindGroupFor(surface)
   }
   const rung=Number(p.id.split('.d')[1]??0),damage=rung?Math.min(1,(rung-.5)/4):0;const pose=decoded.rig?.skeleton.createPose(),skin=decoded.rig?.skeleton.createMatrixBuffer(),world=decoded.rig?.skeleton.createMatrixBuffer()
   for(const [view,yaw,posed,lod] of [['front',.7,false,0],['rear',3.85,false,0],['side',2.25,false,0],['articulated',.7,true,0],...(production?[['lod1',.7,false,1],['lod2',.7,false,2],['glyph',.7,false,0]]:[])]){
    const drawMesh=lod?{...mesh,lods:[mesh.lods[lod],mesh.lods[lod],mesh.lods[lod]]}:mesh
    cam.height=cam.heightGoal=view==='glyph'?12:4.2;cam.yawRaw=cam.yawGoal=yaw;cam.target[1]=cam.targetGoal[1]=.6;cam.update(0,ctx);let png
    for(let f=0;f<12;f++){
     let palette=null
     if(pose){pose.resetToBind();if(posed){for(const b of decoded.rig.turretBones)navalApi.setBoneAngle(pose,b,.62);for(const b of decoded.rig.rotorBones)navalApi.setBoneAngle(pose,b,1.1)}navalApi.computeWorldTransforms(pose,world);navalApi.computeSkinMatrices(decoded.rig.skeleton,world,skin);palette=r.reserveBones(decoded.rig.skeleton.boneCount);if(!palette)throw Error('Bone palette reservation failed');palette.matrices.set(skin)}
     r.submit({mesh:drawMesh,paletteBases:palette?Uint16Array.of(palette.base):null,boneCount:decoded.rig?.skeleton.boneCount??0,surfaceSet:surface.id,instances:Float32Array.of(1,0,0,0,0,1,0,0,0,0,1,0,24,0,24,1),instanceCount:1,playerColors:Uint8Array.of(0),damages:Float32Array.of(damage),castsShadow:true});r.historyValid=false;r.frameIndex=0;r.lateUpdate(1/60,ctx)
     if(f===11){const c=document.createElement('canvas');c.width=ctx.canvas.width;c.height=ctx.canvas.height;c.getContext('2d').drawImage(ctx.canvas,0,0);png=c.toDataURL()}
    }
    rows.push({id:p.id,view,lod,damage,png,triangles:p.meta.triangles,dropped:r.stats.dropped,backend:ctx.backend,surfaceSet:surface.id,capturedVertices:Array.from(decoded.rig?.capturedVertices??[]),skin:skin?Array.from(skin):[],lodTriangles:mesh.lods.map(l=>l.indexCount/3),maskControl:p.maskControl??'fresh-rung',production,materialSourceSha256:surface.sourceSha256,maskVramBytes:[...mats.sets.values()].filter(s=>s.id.startsWith('industrial-v1:damage:dd:')).reduce((n,s)=>n+s.vramBytes,0),materialsVramBytes:mats.totalVramBytes,textureBudget:ctx.config.q.textureVram,quality:ctx.config.q.name})
   }
   const gpuError=await device.popErrorScope();if(gpuError)throw Error(gpuError.message)
  }
  store.dispose();for(const t of resources)t.destroy();return rows
 },{input,production:process.env.NAVAL_PRODUCTION==='1'})
 assert.deepEqual(errors,[]);for(const r of rows){assert.equal(r.dropped,0);writeFileSync(join(out,r.id+'-'+r.view+'.png'),Buffer.from(r.png.split(',')[1],'base64'));delete r.png}
 writeFileSync(join(out,'report.json'),JSON.stringify({status:'PASS',rows,geometryHashes:input.map(p=>({id:p.id,sha256:p.rawHash,maskSha256:p.meta.detailMask.sha256})),shaderEdits:0,production:process.env.NAVAL_PRODUCTION==='1',scope:'Isolated material witness with production industrial-v1 arrays, exact authored UV1 texture, decoder and GPU renderer. Per-rung damage shading and actual turret/radar palettes; three rest views plus articulated pose. No gameplay/waterline proof or shipping integration.'},null,2)+'\n');console.log('NAVAL_RUNTIME_PASS',rows.length)
}finally{await browser?.close();if(preview)await stopChild(preview.server)}
