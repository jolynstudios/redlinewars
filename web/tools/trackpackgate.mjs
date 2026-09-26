#!/usr/bin/env node
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {gunzipSync} from 'node:zlib'
import {createHash} from 'node:crypto'
import {build} from 'esbuild'
const dir=process.argv[2]??'../.artifacts/planx/tracks-loop/production',manifest=JSON.parse(readFileSync(`${dir}/manifest.json`)),packed=readFileSync(`${dir}/tracks.ssmesh.gz`)
const built=await build({entryPoints:['src/units/track-assets.ts'],bundle:true,format:'esm',write:false,define:{'import.meta.glob':'__emptyGlob'},banner:{js:'const __emptyGlob=()=>({});'}})
writeFileSync('../.artifacts/planx/track-pack-bundle.mjs',built.outputFiles[0].text);const api=await import('../../.artifacts/planx/track-pack-bundle.mjs')
globalThis.location={href:'http://localhost/track-proof',origin:'http://localhost'};globalThis.fetch=async()=>new Response(packed)
const verify=m=>api.verifyTrackAssets(m,'http://localhost/tracks.ssmesh.gz',manifest.descriptor)
const result=await verify(manifest),details=[]
for(const [i,level]of result.levels.entries()) {
 const mesh=level.mesh,tags=Buffer.from(manifest.levels[i].trackTags,'base64'),uvByLink=new Map();let tagged=0,virtual=0
 for(let v=0;v<mesh.vertexCount;v++) {
  if(tags[v*3+2]===4)virtual++
  if(tags[v*3+2]!==3)continue
  tagged++;const key=`${Math.sign(mesh.positions[v*3+2])}:${tags[v*3]}`
  const values=uvByLink.get(key)??new Set();values.add([...mesh.uv0.slice(v*2,v*2+2),...mesh.uv1.slice(v*2,v*2+2)].join(','));uvByLink.set(key,values)
 }
 if(i<2){assert.equal(uvByLink.size,92);const first=[...uvByLink.values()][0];for(const uv of uvByLink.values())assert.deepEqual(uv,first,'identical source UV0 and rebaked UV1 masks at every repeating link')}
 else{assert.equal(tagged,0);assert.ok(virtual>0);assert.ok(mesh.triangleCount<=3100)}
 details.push({lod:i,triangles:mesh.triangleCount,vertices:mesh.vertexCount,taggedVertices:tagged,virtualVertices:virtual})
 assert.equal(createHash('sha256').update(readFileSync(`../${manifest.levels[i].sourcePath}`)).digest('hex'),manifest.levels[i].sourceSha256)
}
const bad=structuredClone(manifest);bad.levels[1].trackTags=Buffer.alloc(result.levels[1].mesh.vertexCount*3,128).toString('base64');await assert.rejects(()=>verify(bad),/Invalid track tag/)
const badRig=structuredClone(manifest);badRig.levels[2].rig.wheelRadii[0]*=2;await assert.rejects(()=>verify(badRig),/rig\/material\/path mismatch/)
const raw=gunzipSync(readFileSync(`${dir}/masks/1tnk.mask.rgba.gz`)),range=[];for(let c=0;c<4;c++){let lo=255,hi=0;for(let i=c;i<raw.length;i+=4){lo=Math.min(lo,raw[i]);hi=Math.max(hi,raw[i])}range.push([lo,hi])}assert.ok(range[0][1]-range[0][0]>100);assert.ok(range[3][1]>0)
writeFileSync('../.artifacts/planx/track-pack-gate.json',JSON.stringify({passed:true,details,maskChannelRanges:range,identicalLinkUv0Uv1:true,sourceHashesVerified:true},null,2))
console.log('trackpackgate: PASS',JSON.stringify(details))
