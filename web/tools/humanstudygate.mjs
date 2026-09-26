#!/usr/bin/env node
// OWNER-DISABLED from the standard inventory (2026-09-19): the Blender studies this
// gate compares against were reviewed and approved by the owner. The tool stays
// runnable for manual verification; re-enable in the inventory when models change.

// Isolated saved study through production mesh decoder, skin packing and GPU renderer.
// This is NOT a gameplay/locomotion/finished-art acceptance witness.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { WEB_ROOT, launchGpuBrowser,loadChromium,startPreview,stopChild } from './harness.mjs'
import { decodePng } from './png.mjs'
const temp=mkdtempSync(join(tmpdir(),'steelseed-humanstudy-')),out=join(WEB_ROOT,'.artifacts/visual-quality/human-study')
let preview,browser
try{
 const module=join(temp,'decode.mjs')
 await build({stdin:{contents:`export {decodeBlenderAsset} from './src/units/blender-mesh.ts';
 export {VERTEX_STRIDE_SKINNED,SKIN_WEIGHT_OFFSET} from './src/geo/mesh.ts';
 export {computeWorldTransforms,computeSkinMatrices,setBoneAngle} from './src/geo/rig.ts';`,resolveDir:WEB_ROOT,loader:'ts'},bundle:true,platform:'node',format:'esm',outfile:module,logLevel:'silent'})
 const api=await import(pathToFileURL(module)),raw=new Uint8Array(readFileSync(join(out,'study.ssasset'))),info=JSON.parse(readFileSync(join(out,'study.json')))
 const {mesh,rig}=api.decodeBlenderAsset(raw,{...info,offset:0,bytes:raw.byteLength})
 assert.equal(info.materialSet,'infantry-v1','study must bind its unique UV atlas')
 assert.ok(rig);assert.equal(rig.skeleton.boneCount,20)
 let blended=0
 for(let i=0;i<mesh.vertexCount;i++)if(mesh.skinWeights[i*4+1]>.01)blended++
 assert.ok(blended>1000,'anatomy must actually use smooth joint weights')
 const gpu=mesh.toGPUBuffers(),packed=new DataView(gpu.vertexData)
 assert.equal(gpu.stride,api.VERTEX_STRIDE_SKINNED)
 for(let i=0;i<gpu.vertexCount;i++)assert.equal([0,1,2,3].reduce((s,k)=>s+packed.getUint8(i*gpu.stride+api.SKIN_WEIGHT_OFFSET+k),0),255)
 const sk=rig.skeleton,pose=sk.createPose(),world=sk.createMatrixBuffer(),skin=sk.createMatrixBuffer()
 // Source locators are model-space, BoneDesc translations parent-local. Merely testing
 // a root-child thigh missed doubled parent offsets in knees, spine, elbows and head.
 const joint=name=>{const i=info.rig.bones.findIndex(b=>b.name===name);assert.ok(i>=0);return Array.from(sk.head.subarray(i*3,i*3+3))}
 for(const bone of info.rig.bones){const p=joint(bone.name);assert.ok(p[1]>=-.001&&p[1]<.37,`${bone.name}: joint lies outside the anatomical body`)}
 assert.ok(joint('head')[1]>.32&&joint('head')[1]<.34)
 assert.ok(joint('calf_l')[1]>.09&&joint('calf_l')[1]<.11)
 assert.ok(joint('hand_l')[0]>.08&&joint('hand_r')[0]>.04,'both wrists must meet the authored ready grips')
 const palettes=[]
 for(const angle of [0,.6,.6]){
  pose.resetToBind();api.setBoneAngle(pose,rig.legBones[0],angle)
  api.computeWorldTransforms(pose,world);api.computeSkinMatrices(sk,world,skin);palettes.push(Array.from(skin))
 }
 assert.deepEqual(palettes[1],palettes[2])
 // The calf must hinge around its own knee; rotating it cannot drag the knee itself.
 const knee=info.rig.bones.findIndex(b=>b.name==='calf_l'),kp=joint('calf_l')
 pose.resetToBind();api.setBoneAngle(pose,knee,.6);api.computeWorldTransforms(pose,world);api.computeSkinMatrices(sk,world,skin)
 for(let k=0;k<3;k++)assert.ok(Math.abs(skin[knee*16+k]*kp[0]+skin[knee*16+4+k]*kp[1]+skin[knee*16+8+k]*kp[2]+skin[knee*16+12+k]-kp[k])<1e-6)
 preview=await startPreview(8463)
 ;({browser}=await launchGpuBrowser(await loadChromium('humanstudygate'),'humanstudygate'))
 const page=await browser.newPage({viewport:{width:900,height:900},deviceScaleFactor:1}),errors=[]
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('favicon'))errors.push(m.text())})
 await page.addInitScript(()=>{globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{}})
 await page.goto(`${preview.baseUrl}?devmap=1&humanstudy=1&manual=1&deterministic=1&devsize=48&devactors=1&devtod=720&quality=low`)
 await page.waitForFunction(()=>globalThis.steelseed,undefined,{timeout:120000,polling:100})
 const desc={...gpu,vertexData:Array.from(new Uint8Array(gpu.vertexData)),indexData:Array.from(new Uint8Array(gpu.indexData))}
 const result=await page.evaluate(async({desc,palettes,bones})=>{
  const app=steelseed;app.stop();app.renderOneFrame(0)
  const ctx=app.ctx,r=ctx.get('render'),cam=ctx.get('camera')
  cam.height=cam.heightGoal=5;cam.yaw=cam.yawGoal=.7;cam.target[0]=cam.targetGoal[0]=24;cam.target[2]=cam.targetGoal[2]=24
  app.renderOneFrame(1000/60);r.setShroud(new Uint8Array(48*48).fill(2),48,48,0,0);r.debugView=1
  const data={...desc,vertexData:Uint8Array.from(desc.vertexData).buffer,indexData:Uint8Array.from(desc.indexData).buffer}
  const fixture={generateLodChain(){return [this]},toGPUBuffers(){return data}}
  const mesh=r.upload(fixture,'human-study.weighted'),instances=Float32Array.of(8,0,0,0,0,8,0,0,0,0,8,0,24,0,24,1)
  const captures=[]
  for(let frame=0;frame<5;frame++){
   const p=palettes[frame<3?frame:0]
   r.debugView=frame<3?1:frame===3?0:2
   r.frameIndex=0;r.historyValid=false
   const palette=r.reserveBones(bones);if(!palette)throw Error('Human bone palette rejected')
   palette.matrices.set(p)
   r.submit({mesh,surfaceSet:'infantry-v1',instances,instanceCount:1,playerColors:null,castsShadow:true,
    paletteBases:Uint16Array.of(palette.base),boneCount:bones,phases:Float32Array.of(0)})
   r.lateUpdate(1/60,ctx)
   // Copy within the same task: WebGPU canvas images may be cleared on presentation.
   // Waiting for queue completion before drawImage captured an empty presented canvas.
   const canvas=document.createElement('canvas');canvas.width=ctx.canvas.width;canvas.height=ctx.canvas.height;canvas.getContext('2d').drawImage(ctx.canvas,0,0)
   captures.push({png:canvas.toDataURL(),draws:r.stats.drawCalls,dropped:r.stats.dropped,debugView:r.debugView})
  }
  await ctx.device.queue.onSubmittedWorkDone()
  return captures
 },{desc,palettes,bones:sk.boneCount})
 assert.deepEqual(errors,[])
 const pixels=result.map(c=>decodePng(Buffer.from(c.png.split(',')[1],'base64')))
 function difference(a,b){let n=0;for(let i=0;i<a.data.length;i+=4)if(Math.abs(a.data[i]-b.data[i])+Math.abs(a.data[i+1]-b.data[i+1])+Math.abs(a.data[i+2]-b.data[i+2])>9)n++;return n}
 const changed=difference(pixels[0],pixels[1]),paused=difference(pixels[1],pixels[2])
 for(let i=0;i<result.length;i++)writeFileSync(join(out,`gpu-${i}.png`),Buffer.from(result[i].png.split(',')[1],'base64'))
 console.log('humanstudygate measurements',JSON.stringify({changed,paused,blended,frames:result.map(({draws,dropped})=>({draws,dropped}))}))
 assert.ok(changed>1000,'authored weighted leg must move visibly through production GPU skin path')
 assert.equal(paused,0,'same palette holds the image')
 for(let i=0;i<result.length;i++){assert.equal(result[i].dropped,0);writeFileSync(join(out,`gpu-${i}.png`),Buffer.from(result[i].png.split(',')[1],'base64'))}
 const report={vertices:mesh.vertexCount,triangles:info.triangles,bones:sk.boneCount,blendedVertices:blended,changedPixels:changed,pausedPixels:paused,
  materialSet:info.materialSet,views:['albedo-bind','albedo-pose','albedo-paused','lit-bind','normal-bind'],
  note:'Staged enlarged source study in production renderer; not a finished/playing infantry or frame-time witness.'}
 writeFileSync(join(out,'gpu-report.json'),JSON.stringify(report,null,2));console.log('humanstudygate PASS',JSON.stringify(report))
}finally{await browser?.close();if(preview)await stopChild(preview.server);rmSync(temp,{recursive:true,force:true})}