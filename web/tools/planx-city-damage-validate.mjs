#!/usr/bin/env node
// Validate isolated city packs using the exact production decoder before promotion.
import assert from 'node:assert/strict'
import {readFileSync,readdirSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
import {build} from 'esbuild'
const root=resolve(import.meta.dirname,'../..'),proof=resolve(root,process.argv[2]??'.artifacts/planx/city-damage-expansion')
const bundle=await build({stdin:{contents:"export {decodeBlenderAsset} from './src/units/blender-mesh.ts'",resolveDir:join(root,'web')},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'})
const {decodeBlenderAsset}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))
const hash=b=>createHash('sha256').update(b).digest('hex'),rows=[]
for(const actor of readdirSync(join(proof,'exports')).sort()){
 const manifest=JSON.parse(readFileSync(join(proof,'exports',actor,'manifest.json'))),raw=readFileSync(join(proof,'exports',actor,'states.ssmesh'))
 assert.equal(hash(raw),manifest.sha256);assert.equal(hash(readFileSync(join(root,manifest.parentSourcePath))),manifest.parentSourceSha256)
 for(const entry of manifest.states){
  assert.equal(hash(raw.subarray(entry.offset,entry.offset+entry.bytes)),entry.sha256)
  const decoded=decodeBlenderAsset(raw,entry),validation=decoded.mesh.validate()
  assert.equal(validation,null,`${actor} ${entry.state}: ${JSON.stringify(validation)}`)
  assert.ok(!entry.detailMask,'new states must inherit the parent detail map')
  rows.push({actor,state:entry.state,triangles:entry.triangles,bytes:entry.bytes,sourceHash:entry.sourceSha256})
 }
}
const report={status:'PASS',actors:new Set(rows.map(r=>r.actor)).size,states:rows.length,maximumTriangles:Math.max(...rows.map(r=>r.triangles)),rows}
writeFileSync(join(proof,'decoder-validation.json'),JSON.stringify(report,null,2)+'\n');console.log('CITY_DECODER_PASS',report.actors,report.states,report.maximumTriangles)
