#!/usr/bin/env node
// Isolated supplied-base stealth fighter material fixture. No canonical assets, game rules or core edits.
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
import {gunzipSync} from 'node:zlib'
import {build} from 'esbuild'
import {WEB_ROOT,launchGpuBrowser,loadChromium,startPreview,stopChild} from './harness.mjs'
const root=resolve(WEB_ROOT,'..'),proof=process.env.FIGHTER_PROOF?resolve(process.env.FIGHTER_PROOF):join(root,'.artifacts/planx/supplied-fighter/v2'),out=process.env.FIGHTER_OUT?resolve(process.env.FIGHTER_OUT):join(root,'.artifacts/planx/supplied-fighter/runtime-v2');mkdirSync(out,{recursive:true})
const hash=b=>createHash('sha256').update(b).digest('hex')
const lodRoot=process.env.FIGHTER_LODS?resolve(process.env.FIGHTER_LODS):null
const readLevel=(folder,name)=>{const meta=JSON.parse(readFileSync(join(folder,name+'.json'))),raw=readFileSync(join(folder,name+'.ssmesh'));meta.offset=0;meta.bytes=raw.length;return{meta,raw:Array.from(raw),rawHash:hash(raw)}}
const input=(process.env.FIGHTER_IDS??'ssstealthfighter').split(',').map(id=>{
 const levels=lodRoot?[0,1,2].map(n=>readLevel(lodRoot,id+'.lod'+n)):null,base=levels?levels[0]:readLevel(proof,id),folder=lodRoot??proof
 const mask=gunzipSync(readFileSync(join(folder,'exports',base.meta.detailMask.file)));assert.equal(hash(mask),base.meta.detailMask.sha256)
 return{id,...base,mask:Array.from(mask),levels}
})
const injection=await build({stdin:{contents:`export {decodeBlenderAsset} from './src/units/blender-mesh.ts';export {MeshStore} from './src/render/gpumesh.ts';export {setBoneAngle,computeWorldTransforms,computeSkinMatrices} from './src/geo/rig.ts';`,resolveDir:WEB_ROOT},write:false,bundle:true,platform:'browser',format:'iife',globalName:'fighterApi',logLevel:'silent'})
let preview,browser
try{
 preview=await startPreview(8498,process.env.FIGHTER_URL??null);const launched=await launchGpuBrowser(await loadChromium('planx-fighter-review'),'planx-fighter-review');browser=launched.browser
 const page=await browser.newPage({viewport:{width:1000,height:800},deviceScaleFactor:1}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'||m.text().includes('ShaderModule'))console.log('BROWSER',m.text())})
 await page.addInitScript(()=>{globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{}})
 await page.goto(`${preview.baseUrl}?devmap=1&manual=1&deterministic=1&devsize=48&devactors=1&devtod=720&quality=${process.env.FIGHTER_QUALITY??'high'}`);await page.waitForFunction(()=>globalThis.steelseed,undefined,{timeout:120000,polling:100});await page.addScriptTag({content:injection.outputFiles[0].text})
 const rows=await page.evaluate(async input=>{
  const app=steelseed;app.stop();app.renderOneFrame(0);app.bridge.pollSnapshot=()=>null
  const ctx=app.ctx,r=ctx.get('render'),units=ctx.get('units'),cam=ctx.get('camera'),device=ctx.device,mats=ctx.get('materials');if(ctx.backend!=='webgpu')throw Error('WebGPU required')
  units.shroud={isVisible(){return true},stateAt(){return 2},unmodelled:false};cam.target[0]=cam.targetGoal[0]=24;cam.target[1]=cam.targetGoal[1]=.6;cam.target[2]=cam.targetGoal[2]=24;cam.yawRaw=cam.yawGoal=.7;cam.height=cam.heightGoal=4.2
  app.renderOneFrame(1000/60);r.setShroud(new Uint8Array(48*48).fill(2),48,48,0,0);r.probes.updatesPerFrame=0;r.debugView=0
  const store=new fighterApi.MeshStore(device),rows=[],resources=[]
  for(const p of input){
   device.pushErrorScope('validation');const decoded=fighterApi.decodeBlenderAsset(new Uint8Array(p.raw),p.meta),error=decoded.mesh.validate();if(error)throw Error(error)
   const base=mats.get('industrial-v1'),mesh=p.levels?store.uploadLods(p.levels.map(l=>fighterApi.decodeBlenderAsset(new Uint8Array(l.raw),l.meta).mesh),p.id):store.upload(decoded.mesh,p.id),size=p.meta.detailMask.size,count=Math.log2(size)+1
   const texture=device.createTexture({label:'fighter-proof-UV1',size:[size,size],mipLevelCount:count,format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});resources.push(texture)
   let pixels=new Uint8Array(p.mask),side=size
   for(let mip=0;mip<count;mip++){
    device.queue.writeTexture({texture,mipLevel:mip},pixels,{bytesPerRow:side*4,rowsPerImage:side},[side,side]);if(side===1)break
    const next=side/2,result=new Uint8Array(next*next*4);for(let y=0;y<next;y++)for(let x=0;x<next;x++)for(let c=0;c<4;c++){const i=(y*2*side+x*2)*4+c;result[(y*next+x)*4+c]=Math.round((pixels[i]+pixels[i+4]+pixels[i+side*4]+pixels[i+side*4+4])/4)}pixels=result;side=next
   }
   const surface=Object.assign(Object.create(base),{id:'fighter-proof:'+p.id,detailMaskView:texture.createView()});mats.sets.set(surface.id,surface);mats.bindGroupFor(surface)
   const damage=0;const pose=decoded.rig?.skeleton.createPose(),skin=decoded.rig?.skeleton.createMatrixBuffer(),world=decoded.rig?.skeleton.createMatrixBuffer()
   for(const [view,yaw,lod,height] of [['front',.7,0,4.2],['rear',3.85,0,4.2],['side',2.25,0,4.2],['close',.7,0,2.2],['lod1',.7,1,4.2],['lod2',.7,2,4.2],['gameplay',.7,2,12]]){
    const drawMesh={...mesh,lods:[mesh.lods[lod],mesh.lods[lod],mesh.lods[lod]]}
    cam.height=cam.heightGoal=height;cam.yawRaw=cam.yawGoal=yaw;cam.target[1]=cam.targetGoal[1]=.6;cam.update(0,ctx);let png
    for(let f=0;f<12;f++){
     let palette=null
     if(pose){pose.resetToBind();fighterApi.computeWorldTransforms(pose,world);fighterApi.computeSkinMatrices(decoded.rig.skeleton,world,skin);palette=r.reserveBones(decoded.rig.skeleton.boneCount);if(!palette)throw Error('Bone palette reservation failed');palette.matrices.set(skin)}
     r.submit({mesh:drawMesh,paletteBases:palette?Uint16Array.of(palette.base):null,boneCount:decoded.rig?.skeleton.boneCount??0,surfaceSet:surface.id,instances:Float32Array.of(1,0,0,0,0,1,0,0,0,0,1,0,24,0,24,1),instanceCount:1,playerColors:Uint8Array.of(0),damages:Float32Array.of(damage),castsShadow:true});r.historyValid=false;r.frameIndex=0;r.lateUpdate(1/60,ctx)
     if(f===11){const c=document.createElement('canvas');c.width=ctx.canvas.width;c.height=ctx.canvas.height;c.getContext('2d').drawImage(ctx.canvas,0,0);png=c.toDataURL()}
    }
    rows.push({id:p.id,view,lod,png,triangles:p.meta.triangles,dropped:r.stats.dropped,backend:ctx.backend,surfaceSet:surface.id,lodTriangles:mesh.lods.map(l=>l.indexCount/3),isolatedMaskBytes:(size*size*4-1)/3*4,quality:ctx.config.q.name,authoredLods:!!p.levels})
   }
   const gpuError=await device.popErrorScope();if(gpuError)throw Error(gpuError.message)
  }
  store.dispose();for(const t of resources)t.destroy();return rows
 },input)
 assert.deepEqual(errors,[]);for(const r of rows){assert.equal(r.dropped,0);writeFileSync(join(out,r.id+'-'+r.view+'.png'),Buffer.from(r.png.split(',')[1],'base64'));delete r.png}
 writeFileSync(join(out,'report.json'),JSON.stringify({status:'PASS',rows,geometryHashes:input.map(p=>({id:p.id,sha256:p.rawHash,maskSha256:p.meta.detailMask.sha256})),shaderEdits:0,scope:'Isolated static fighter using production decoder, PBR arrays and renderer with its exact UV1 mask. Front/rear/side/close, forced LOD1/2 and gameplay-distance views. No flight/animation, terrain, performance or shipping acceptance.'},null,2)+'\n');console.log('FIGHTER_RUNTIME_PASS',rows.length)
}finally{await browser?.close();if(preview)await stopChild(preview.server)}
