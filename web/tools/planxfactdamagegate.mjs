#!/usr/bin/env node
// Isolated current-yard ladder: production decoder, exact parent/bone/material guards.
import assert from 'node:assert/strict'
import{readFileSync,writeFileSync}from'node:fs'
import{resolve,join}from'node:path'
import{gunzipSync}from'node:zlib'
import{createHash}from'node:crypto'
import{build}from'esbuild'
const root=resolve(import.meta.dirname,'../..'),web=join(root,'web'),dir=join(root,'.artifacts/planx/fact-damage/proof'),hash=b=>createHash('sha256').update(b).digest('hex'),m=JSON.parse(readFileSync(join(dir,'manifest.json'))),rows=JSON.parse(readFileSync(join(dir,'author-report.json'))),bytes=gunzipSync(readFileSync(join(dir,m.file)))
assert.equal(hash(readFileSync(join(root,m.parentSourcePath))),m.parentSourceSha256);assert.equal(hash(bytes),m.sha256);assert.equal(m.states.length,5);assert.equal(new Set(rows.map(r=>r.maskSha256)).size,1)
const b=await build({stdin:{contents:"export{decodeBlenderAsset}from'./src/units/blender-mesh.ts'",loader:'ts',resolveDir:web},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'}),api=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64')),results=[]
for(const s of m.states){assert.equal(hash(bytes.subarray(s.offset,s.offset+s.bytes)),s.sha256);assert.equal(hash(readFileSync(join(root,s.sourcePath))),s.sourceSha256);assert.deepEqual(s.rig.bones,m.states[0].rig.bones);assert.equal(s.rig.bones.length,119);assert.equal(s.materialSet,m.states[0].materialSet);assert.ok(s.fx.length);assert.ok(!s.detailMask);const d=api.decodeBlenderAsset(bytes,s);assert.equal(d.mesh.validate(),null);assert.equal(d.rig.skeleton.boneCount,119);for(const f of s.fx)for(let a=0;a<3;a++)assert.ok(f.atM[a]>=s.bounds[0][a]-.005&&f.atM[a]<=s.bounds[1][a]+.005);results.push({state:s.state,triangles:d.mesh.triangleCount,bones:d.rig.skeleton.boneCount,fx:s.fx.length})}
const report={schema:1,status:'ISOLATED_FACT_DAMAGE_DECODE_PASS',parentSourceSha256:m.parentSourceSha256,states:results,compressedBytes:m.storedBytes,UVAndPackedMaskPreserved:rows.every(r=>r.UVPreserved),canonicalPromotionApplied:false,remaining:['Root static review and combined production material/health witness','Agent01 must bind canonical byte-copied source paths when staging the final package']};writeFileSync(join(root,'.artifacts/planx/fact-damage/decode-report.json'),JSON.stringify(report,null,2)+'\n');console.log('PLANX_FACT_DAMAGE_DECODE_PASS',JSON.stringify(report))
