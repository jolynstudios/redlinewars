#!/usr/bin/env node
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {gunzipSync} from 'node:zlib'
import {resolve} from 'node:path'
import {build} from 'esbuild'
import {WEB_ROOT} from './harness.mjs'
const bundled=await build({stdin:{contents:"export * from './src/render/window-occupancy.ts'; export {decodeBlenderAsset} from './src/units/blender-mesh.ts'",resolveDir:WEB_ROOT},bundle:true,write:false,format:'cjs',platform:'node',logLevel:'silent'})
const m={exports:{}};new Function('module','exports',bundled.outputFiles[0].text)(m,m.exports)
const {extractWindowGeometry,packWindowGeometry,buildingWindowSeed,windowState,windowWarmth,decodeBlenderAsset}=m.exports
const manifest=JSON.parse(readFileSync(resolve(WEB_ROOT,'.forge/blender/manifest.json')))
let bytes=readFileSync(resolve(WEB_ROOT,'.forge/blender',manifest.pack));if(bytes[0]===31&&bytes[1]===139)bytes=gunzipSync(bytes)
const rows=[];const levels=new Set()
for(const id of ['v01','v03','v24','v25','weap','fact']){
 const mesh=decodeBlenderAsset(bytes,manifest.assets[id]).mesh
 const before=mesh.toGPUBuffers(),original=Buffer.from(before.vertexData).toString('base64')
 const windows=extractWindowGeometry(mesh,id.startsWith('v')?1:2)
 assert.ok(windows.panes.length>0,id+' panes must be extracted')
 const packed=mesh.toGPUBuffers();packWindowGeometry(mesh,packed,windows)
 const b=new Uint8Array(packed.vertexData),a=new Uint8Array(before.vertexData);let annotated=0
 for(let v=0;v<mesh.vertexCount;v++)for(let k=0;k<packed.stride;k++){
  if(k>=29&&k<=31)continue
  assert.equal(b[v*packed.stride+k],a[v*packed.stride+k],id+' unrelated channel changed')
 }
 for(let v=0;v<mesh.vertexCount;v++)if(b[v*packed.stride+29]||b[v*packed.stride+30]){annotated++;assert.equal(mesh.materialZone[v]&127,4)}
 assert.ok(annotated>0);assert.equal(Buffer.from(mesh.toGPUBuffers().vertexData).toString('base64'),original,'CPU/source channels must stay untouched')
 const base=buildingWindowSeed(24,24),same=windows.panes.map(p=>windowState(p.seed,p.flags,base))
 for(const quality of ['low','medium','high','classic','ultra','ultra-max'])assert.deepEqual(windows.panes.map(p=>windowState(p.seed,p.flags,base)),same,quality)
 let differences=0
 for(const p of windows.panes){for(let x=-20;x<20;x++){const building=buildingWindowSeed(x,24),s=windowState(p.seed,p.flags,building);levels.add(s);const t=windowWarmth(p.seed,building);assert.ok(t>=0&&t<=1);if(s!==windowState(p.seed,p.flags,base))differences++}}
 assert.ok(differences>0,'separate instances must vary')
 rows.push({id,panes:windows.panes.length,annotated,occupied:same.filter(x=>x>0).length})
}
assert.deepEqual([...levels].sort(),[0,.18,.65,1])
console.log('WINDOW_OCCUPANCY_PASS',JSON.stringify(rows))
