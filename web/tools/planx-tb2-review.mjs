#!/usr/bin/env node
// Isolated supplied-base TB2 material fixture. No canonical assets, game rules or core edits.
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
import {gunzipSync} from 'node:zlib'
import {build} from 'esbuild'
import {WEB_ROOT,launchGpuBrowser,loadChromium,startPreview,stopChild} from './harness.mjs'
const root=resolve(WEB_ROOT,'..'),proof=process.env.TB2_PROOF?resolve(process.env.TB2_PROOF):join(root,'.artifacts/planx/tb2/material-v2'),out=process.env.TB2_OUT?resolve(process.env.TB2_OUT):join(root,'.artifacts/planx/tb2/runtime-high');mkdirSync(out,{recursive:true})
const hash=b=>createHash('sha256').update(b).digest('hex')
const lodRoot=proof
const readLevel=(folder,name)=>{const meta=JSON.parse(readFileSync(join(folder,name+'.json'))),raw=readFileSync(join(folder,name+'.ssmesh'));meta.offset=0;meta.bytes=raw.length;return{meta,raw:Array.from(raw),rawHash:hash(raw)}}
const input=(process.env.TB2_IDS??'ss_tb2').split(',').map(id=>{
 const levels=lodRoot?[0,1,2].map(n=>readLevel(join(lodRoot,'lod'+n),id)):null,base=levels?levels[0]:readLevel(proof,id),folder=join(proof,'lod0')
 const mask=gunzipSync(readFileSync(join(folder,'exports',base.meta.detailMask.file)));assert.equal(hash(mask),base.meta.detailMask.sha256)
 assert.ok(levels.every(l=>l.meta.detailMask.sha256===base.meta.detailMask.sha256)); let pixels=mask,maskSize=base.meta.detailMask.size; if(process.env.TB2_QUALITY==='low'){while(maskSize>128){const side=maskSize/2,next=new Uint8Array(side*side*4);for(let y=0;y<side;y++)for(let x=0;x<side;x++)for(let c=0;c<4;c++){const i=(y*2*maskSize+x*2)*4+c;next[(y*side+x)*4+c]=Math.round((pixels[i]+pixels[i+4]+pixels[i+maskSize*4]+pixels[i+maskSize*4+4])/4)}pixels=next;maskSize=side}} return{id,...base,mask:Array.from(pixels),maskSize,levels,views:process.env.TB2_VIEWS?.split(',')}
})
const injection=await build({stdin:{contents:`export {decodeBlenderAsset} from './src/units/blender-mesh.ts';export {MeshStore} from './src/render/gpumesh.ts';export {REFLECTION_METADATA_WGSL} from './src/render/reflection.ts';export {default as palette} from './src/core/blender-palette.json';export {setBoneAngle,computeWorldTransforms,computeSkinMatrices} from './src/geo/rig.ts';`,resolveDir:WEB_ROOT},write:false,bundle:true,platform:'browser',format:'iife',globalName:'tb2Api',logLevel:'silent'})
let preview,browser
try{
 preview=await startPreview(8502,process.env.TB2_URL??null);const launched=await launchGpuBrowser(await loadChromium('planx-tb2-review'),'planx-tb2-review');browser=launched.browser
 const page=await browser.newPage({viewport:{width:1000,height:800},deviceScaleFactor:1}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'||m.text().includes('ShaderModule'))console.log('BROWSER',m.text())})
 await page.addInitScript(()=>{globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{}})
 await page.goto(`${preview.baseUrl}?devmap=1&manual=1&deterministic=1&devsize=48&devactors=1&devtod=${process.env.TB2_TOD??720}&quality=${process.env.TB2_QUALITY??'high'}`);await page.waitForFunction(()=>globalThis.steelseed,undefined,{timeout:120000,polling:100});await page.addScriptTag({content:injection.outputFiles[0].text})
 const rows=await page.evaluate(async input=>{
  const app=steelseed;app.stop();app.renderOneFrame(0);app.bridge.pollSnapshot=()=>null
  const ctx=app.ctx,r=ctx.get('render'),units=ctx.get('units'),cam=ctx.get('camera'),device=ctx.device,mats=ctx.get('materials');if(ctx.backend!=='webgpu')throw Error('WebGPU required')
  units.shroud={isVisible(){return true},stateAt(){return 2},unmodelled:false};cam.target[0]=cam.targetGoal[0]=24;cam.target[1]=cam.targetGoal[1]=.6;cam.target[2]=cam.targetGoal[2]=24;cam.yawRaw=cam.yawGoal=.7;cam.height=cam.heightGoal=4.2
  app.renderOneFrame(1000/60);r.setShroud(new Uint8Array(48*48).fill(2),48,48,0,0);r.probes.updatesPerFrame=0;r.debugView=0
  // Execute the actual reflection metadata helper for every frozen-prefix and
  // current material layer. This protects sampled foliage's surface-kind bits.
  const reflectionCases=[...Array.from({length:29},(_,zone)=>({zone,layers:29})),...Array.from({length:30},(_,zone)=>({zone,layers:30})),{zone:4,layers:8}]
  const compute=device.createShaderModule({code:tb2Api.REFLECTION_METADATA_WGSL+`
@group(0) @binding(0) var<storage,read_write> out:array<vec4<f32>>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3<u32>){let i=id.x;let zone=select(select(i,i-29u,i>=29u),4u,i==59u);let layers=select(select(29.0,30.0,i>=29u),8.0,i==59u);out[i]=vec4<f32>(reflectionSurface(vec4<u32>(zone,0u,0u,0u),layers),0.0);}`})
  const pipeline=device.createComputePipeline({layout:'auto',compute:{module:compute,entryPoint:'main'}}),output=device.createBuffer({size:60*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),read=device.createBuffer({size:60*16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})
  const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:output}}]}));pass.dispatchWorkgroups(60);pass.end();encoder.copyBufferToBuffer(output,0,read,0,60*16);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const values=new Float32Array(read.getMappedRange()).slice();read.unmap();output.destroy();read.destroy()
  for(const [i,c] of reflectionCases.entries()){const p=tb2Api.palette[c.zone],expected=c.layers===8?[1,0,0]:[p.roughness,c.zone===4?.65:p.metalness>.3?Math.max(.4,p.metalness):0,/leaf|foliage/i.test(p.name)?2:0];for(let k=0;k<3;k++)if(Math.abs(values[i*4+k]-expected[k])>1e-5)throw Error('Reflection palette prefix changed '+i+':'+k)}
  if(mats.get('foliage-v1').layerCount!==29||mats.get('meadow-v1').layerCount!==29)throw Error('Frozen foliage prefix was expanded')
  const store=new tb2Api.MeshStore(device),rows=[],resources=[]
  for(const p of input){
   device.pushErrorScope('validation');const decoded=tb2Api.decodeBlenderAsset(new Uint8Array(p.raw),p.meta),error=decoded.mesh.validate();if(error)throw Error(error)
   const base=mats.get('industrial-v1'),mesh=p.levels?store.uploadLods(p.levels.map(l=>tb2Api.decodeBlenderAsset(new Uint8Array(l.raw),l.meta).mesh),p.id):store.upload(decoded.mesh,p.id),size=p.maskSize,count=Math.log2(size)+1
   const texture=device.createTexture({label:'tb2-proof-UV1',size:[size,size],mipLevelCount:count,format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});resources.push(texture)
   let pixels=new Uint8Array(p.mask),side=size
   for(let mip=0;mip<count;mip++){
    device.queue.writeTexture({texture,mipLevel:mip},pixels,{bytesPerRow:side*4,rowsPerImage:side},[side,side]);if(side===1)break
    const next=side/2,result=new Uint8Array(next*next*4);for(let y=0;y<next;y++)for(let x=0;x<next;x++)for(let c=0;c<4;c++){const i=(y*2*side+x*2)*4+c;result[(y*next+x)*4+c]=Math.round((pixels[i]+pixels[i+4]+pixels[i+side*4]+pixels[i+side*4+4])/4)}pixels=result;side=next
   }
   const surface=Object.assign(Object.create(base),{id:'tb2-proof:'+p.id,detailMaskView:texture.createView()});mats.sets.set(surface.id,surface);mats.bindGroupFor(surface)
   const damage=0;const pose=decoded.rig?.skeleton.createPose(),skin=decoded.rig?.skeleton.createMatrixBuffer(),world=decoded.rig?.skeleton.createMatrixBuffer()
   for(const [view,yaw,lod,height] of [['front',.7,0,3],['rear',3.85,0,3],['side',2.25,0,3],['close',.7,0,1.65],['propeller',3.85,0,3],['banked',.7,0,3],['lod1',.7,1,3],['lod2',.7,2,3],['gameplay-near',.7,0,12],['gameplay-mid',.7,1,12],['gameplay-far',.7,2,12],['terrain',.7,0,8],['terrain-far',.7,2,12]].filter(row=>!p.views||p.views.includes(row[0]))){
    const withTerrain=view.startsWith('terrain'),modelY=withTerrain?ctx.get('terrain').heightAt(24,24)+.65:view==='banked'?.3:0
    const drawMesh={...mesh,lods:[mesh.lods[lod],mesh.lods[lod],mesh.lods[lod]]}
    cam.height=cam.heightGoal=height;cam.yawRaw=cam.yawGoal=yaw;cam.target[1]=cam.targetGoal[1]=withTerrain?modelY+.1:.6;cam.update(0,ctx);let png
    for(let f=0;f<12;f++){
     let palette=null
     if(pose){pose.resetToBind();for(const bone of decoded.rig.rotorBones)tb2Api.setBoneAngle(pose,bone,view==='propeller'?1.15:view==='banked'?.7:0);tb2Api.computeWorldTransforms(pose,world);tb2Api.computeSkinMatrices(decoded.rig.skeleton,world,skin);palette=r.reserveBones(decoded.rig.skeleton.boneCount);if(!palette)throw Error('Bone palette reservation failed');palette.matrices.set(skin)}
     if(withTerrain)ctx.get('terrain').update(0,ctx)
     r.submit({mesh:drawMesh,paletteBases:palette?Uint16Array.of(palette.base):null,boneCount:decoded.rig?.skeleton.boneCount??0,surfaceSet:surface.id,instances:Float32Array.of(1,0,0,0,0,Math.cos(view==='banked'?.35:0),Math.sin(view==='banked'?.35:0),0,0,-Math.sin(view==='banked'?.35:0),Math.cos(view==='banked'?.35:0),0,24,modelY,24,1),instanceCount:1,playerColors:Uint8Array.of(0),damages:Float32Array.of(damage),castsShadow:true});r.historyValid=false;r.frameIndex=0;r.lateUpdate(1/60,ctx)
     if(f===11){const c=document.createElement('canvas');c.width=ctx.canvas.width;c.height=ctx.canvas.height;c.getContext('2d').drawImage(ctx.canvas,0,0);png=c.toDataURL()}
    }
    rows.push({id:p.id,view,lod,png,triangles:p.meta.triangles,dropped:r.stats.dropped,backend:ctx.backend,surfaceSet:surface.id,lodTriangles:mesh.lods.map(l=>l.indexCount/3),isolatedMaskBytes:(size*size*4-1)/3*4,quality:ctx.config.q.name,authoredLods:!!p.levels,rotorAngle:view==='propeller'?1.15:view==='banked'?.7:0,rotorAxis:p.meta.rig.bones[1].axis,boneCount:p.meta.rig.bones.length,materialLayers:base.layerCount,reflectionGpuCases:reflectionCases.length,foliageLayers:mats.get('foliage-v1').layerCount,terrainBackdrop:withTerrain,modelScale:1,modelY,materialTextureBytes:mats.totalVramBytes,materialCap:ctx.config.q.textureVram})
   }
   const gpuError=await device.popErrorScope();if(gpuError)throw Error(gpuError.message)
  }
  store.dispose();for(const t of resources)t.destroy();return rows
 },input)
 assert.deepEqual(errors,[]);for(const r of rows){assert.equal(r.dropped,0);assert.equal(r.materialLayers,30);assert.equal(r.rotorAxis,0);assert.equal(r.boneCount,2);assert.ok(r.materialTextureBytes+r.isolatedMaskBytes<=r.materialCap);writeFileSync(join(out,r.id+'-'+r.view+'.png'),Buffer.from(r.png.split(',')[1],'base64'));delete r.png}
 writeFileSync(join(out,'report.json'),JSON.stringify({status:'PASS',rows,geometryHashes:input.map(p=>({id:p.id,sha256:p.rawHash,maskSha256:p.meta.detailMask.sha256})),shaderEdits:0,scope:'Isolated TB2 using production decoder, shared PBR arrays, actual bone palette and renderer. Explicit authored LOD0/1/2, propeller articulation, banked pose, close and gameplay-distance comparison. Manual fixture poses; no gameplay flight/rearm or canonical actor acceptance.'},null,2)+'\n');console.log('TB2_RUNTIME_PASS',rows.length)
}finally{await browser?.close();if(preview)await stopChild(preview.server)}
