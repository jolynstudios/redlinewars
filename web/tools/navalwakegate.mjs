import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
const root=new URL('../..',import.meta.url).pathname,bundle=await build({entryPoints:[root+'/web/src/fx/naval-wakes.ts'],bundle:true,format:'esm',write:false,define:{'import.meta.glob':'__emptyGlob'},banner:{js:'const __emptyGlob=()=>({});'},logLevel:'silent'})
writeFileSync(root+'/.artifacts/planx/naval-wake-bundle.mjs',bundle.outputFiles[0].text);const{NavalWakes,navalWakeReservation}=await import(root+'/.artifacts/planx/naval-wake-bundle.mjs')
const manifest=JSON.parse(readFileSync(root+'/web/src/fx/naval-wake-manifest.json')),plan=manifest.actors.dd.variants[0]
for(const entry of manifest.actors.dd.variants)assert.equal(createHash('sha256').update(readFileSync(root+'/'+entry.sourcePath)).digest('hex'),entry.sourceSha256)
let visible=true,onWater=true;const terrain={heightAt:()=>-1,waterHeightAt:(x,z)=>onWater&&x<50?2:null},shroud={isVisible:()=>visible},draws=[]
const render={upload:(mesh,label)=>({indexCount:mesh.triangleCount*3,label}),submit:item=>draws.push({count:item.instanceCount,opacity:item.opacity,data:item.instances.slice(0,item.instanceCount*16)}),camera:{position:new Float32Array([0,5,0])}}
const matrix=new Float32Array(16);matrix[0]=matrix[5]=matrix[10]=matrix[15]=1
// Owner 1 vs renderPlayer 0: the sim suppresses cloaked/submerged wakes for enemy vessels
// only (an own submarine still shows its wake), so the flag-suppression checks below need
// a hostile hull to stay meaningful for every suppressed state.
const ctx={snapshot:{world:{renderPlayer:0},actors:{count:1,id:new Uint32Array([7]),owner:new Uint16Array([1]),flags:new Uint16Array([0])}}},units={visitVisibleInstances:(slot,sink)=>{if(visible)sink(matrix,0,7)}}
const wakes=new NavalWakes(plan),reservation=wakes.init(render,512);assert.equal(reservation,64);assert.ok(512-reservation>=448)
const memories=[wakes.records,wakes.alive,wakes.history,...wakes.matrices],startBytes=wakes.stats.allocatedBytes
let time=0;function tick(dt=.04,dx=0,yaw=0){time+=dt;matrix[12]+=dx;matrix[0]=Math.cos(yaw);matrix[2]=Math.sin(yaw);matrix[8]=-Math.sin(yaw);matrix[10]=Math.cos(yaw);matrix[13]=2;draws.length=0;wakes.tick(time,ctx,units,render,terrain,shroud);assert.ok(draws.reduce((s,d)=>s+d.count,0)<=reservation);for(const draw of draws)for(let i=0;i<draw.count;i++)assert.ok(draw.data[i*16+13]>=2.008-1e-6);return{...wakes.stats}}
tick();for(let i=0;i<30;i++)tick(.04,.04);const forward={...wakes.stats};assert.ok(forward.bow===2&&forward.spray===4&&forward.active>20)
const paused=draws.map(d=>Array.from(d.data)),emitted=wakes.stats.emitted;tick(0);assert.equal(wakes.stats.emitted,emitted);assert.deepEqual(draws.map(d=>Array.from(d.data)),paused)
for(let i=0;i<20;i++)tick(.04,.04,i*.03);const curved=Array.from(wakes.records);assert.ok(curved.some((v,i)=>i%10===5&&Math.abs(v)>.1),'turn stores changing world-space normals')
for(let i=0;i<10;i++)tick(.04,-.04,.57);assert.ok(wakes.stats.bow>0,'reverse has leading stern foam');assert.ok(wakes.history[13]<0)
const count=wakes.stats.emitted;tick(.04,10,.57);assert.equal(wakes.stats.emitted,count,'teleport creates no connecting wake')
visible=false;tick(.04,.04);assert.equal(draws.length,0);visible=true;tick(.04,.04);assert.equal(wakes.stats.bow,0,'visibility resume resets historical path')
for(const flag of[2,8,128]){const before=wakes.stats.emitted;ctx.snapshot.actors.flags[0]=flag;tick(.04,.04);assert.equal(wakes.stats.bow,0);assert.equal(wakes.stats.emitted,before)}
ctx.snapshot.actors.flags[0]=0;onWater=false;tick(.04,.04);assert.equal(draws.length,0);onWater=true
for(let i=0;i<110;i++)tick(.04);assert.equal(wakes.stats.active,0);assert.equal(wakes.stats.bow,0)
time-=10;tick(0);assert.equal(wakes.stats.active,0)
for(let i=0;i<10000;i++)tick(.04,i%20<10?.01:-.01)
assert.equal(wakes.stats.allocatedBytes,startBytes);for(const [i,array]of[wakes.records,wakes.alive,wakes.history,...wakes.matrices].entries())assert.equal(array,memories[i])
for(const cap of[512,2048,4096,6144])assert.ok(navalWakeReservation(cap)<=256&&navalWakeReservation(cap)+cap-navalWakeReservation(cap)===cap)
wakes.dispose();assert.equal(wakes.items.length,0)
const proof=new NavalWakes(manifest.actors.dd.variants[1]);proof.init(render,512);matrix[0]=matrix[5]=matrix[10]=matrix[15]=1;matrix[2]=matrix[8]=matrix[12]=matrix[14]=0
let faded=false
for(let i=0;i<250;i++){matrix[12]+=.035;draws.length=0;proof.tick(i*.04,ctx,units,render,terrain,shroud);assert.ok(proof.stats.active+proof.stats.bow+proof.stats.spray<=64);if(proof.counts[3]>0)faded=true}
assert.ok(faded,'Low wakes reach the final fade band during steady motion');assert.equal(proof.stats.dropped,0,'Low steady motion expires records before ring reuse')
const lowSteady={...proof.stats};proof.dispose()
writeFileSync(root+'/.artifacts/planx/naval-wake-gate.json',JSON.stringify({passed:true,forward,reservation,groundMarksRemaining:448,allocatedBytes:startBytes,motionFramesAtLeast:10000,steadyFadeFrames:250,sourceAnchorsVerified:true,lowSteady},null,2));console.log('navalwakegate PASS',forward)

const coverageBundle=await build({stdin:{contents:"export * from './src/geo/foam-coverage';export {Mesh} from './src/geo/mesh';",resolveDir:root+'/web'},bundle:true,format:'esm',write:false,logLevel:'silent'})
writeFileSync(root+'/.artifacts/planx/naval-foam-tag-bundle.mjs',coverageBundle.outputFiles[0].text)
const {Mesh,markFoamCoverage,packFoamCoverage}=await import(root+'/.artifacts/planx/naval-foam-tag-bundle.mjs')
const ordinary=new Mesh(3,1);ordinary.addVertex(0,0,0,0,1,0,0,0);ordinary.addVertex(1,0,0,0,1,0,1,0);ordinary.addVertex(0,0,1,0,1,0,0,1);ordinary.addTriangle(0,2,1)
const untagged=ordinary.toGPUBuffers(),original=new Uint8Array(untagged.vertexData).slice();packFoamCoverage(ordinary,untagged);assert.deepEqual(new Uint8Array(untagged.vertexData),original)
markFoamCoverage(ordinary);const tagged=ordinary.toGPUBuffers();packFoamCoverage(ordinary,tagged);const taggedBytes=new Uint8Array(tagged.vertexData)
for(let i=0;i<taggedBytes.length;i++)assert.equal(taggedBytes[i],i%tagged.stride===31?5:original[i],'tag changes only reserved zone.w byte')
assert.throws(()=>packFoamCoverage(ordinary,tagged),/cannot replace/,'existing metadata cannot be overwritten')
console.log('naval foam metadata isolation PASS')
