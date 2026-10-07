#!/usr/bin/env node
// Admission uses retained isolated A/B measurements and the production voice-priority gate.
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
const root=resolve(import.meta.dirname,'../..')
const out=resolve(process.argv.find(a=>a.startsWith('--reports='))?.slice(10)??join(root,'.artifacts/air-naval'))
const source=readFileSync(join(root,'web/src/audio/engines.ts'),'utf8')
const limits=Object.fromEntries([...source.match(/ENGINE_LIMITS[^=]*=\{([^}]+)\}/)[1].matchAll(/(\w+):(\d+)/g)].map(m=>[m[1],Number(m[2])]))
assert.equal(limits.classic,0);assert.equal(limits.low,0)
const rows=[]
for(const [quality,limit] of Object.entries(limits)){
 if(!limit){rows.push({quality,admitted:false,limit:0});continue}
 assert(limit<=(quality==='medium'?4:8))
 const reportPath=join(out,'final-'+quality,'report.json')
 let report
 try{report=JSON.parse(readFileSync(reportPath))}catch{
  throw new Error(`no measurement report at ${reportPath} — producer: node tools/airnaval-integrationgate.mjs --out ${join(out,'final-'+quality)} --quality ${quality} --dist ${join(root,'web/dist')}`)}
 assert.equal(report.status,'passed');assert.equal(report.quality,quality);assert.equal(report.baseline,false)
 assert.equal(report.indexSha256,createHash('sha256').update(readFileSync(join(root,'web/dist/index.html'))).digest('hex'),'measurement belongs to a different build')
 const deltas=[]
 for(let i=0;i<report.perf.length;i+=2){
  const off=report.perf[i],on=report.perf[i+1];assert.equal(off.engines,false);assert.equal(on.engines,true)
  assert.equal(off.active,0);assert.equal(on.active,limit);assert(on.bytes>0&&on.bytes<=4*1024*1024)
  const delta=on.frameP95-off.frameP95;assert(delta<=.50001,quality+' engine p95 exceeded: '+delta);deltas.push(delta)
 }
 assert(deltas.length>=2,'two independent A/B passes required')
 rows.push({quality,admitted:true,limit,deltaP95Ms:deltas,decodedBytes:report.perf[1].bytes})
}
const audio=spawnSync(process.execPath,[join(root,'web/tools/audionodegate.mjs')],{cwd:root,env:process.env,encoding:'utf8'})
writeFileSync(join(out,'audionodegate.log'),audio.stdout+audio.stderr)
assert.equal(audio.status,0,audio.stdout+audio.stderr)
assert(audio.stdout.includes('eight occupied motor slots -> eight combat reports, zero additional drops'))
const report={status:'passed',measurement:'CPU submission plus GPU completion, p95, 200 mixed actors',rows,combatPriority:'all eight occupied engine slots reclaimed; zero extra combat drops'}
writeFileSync(join(out,'enginebudget.json'),JSON.stringify(report,null,2)+'\n')
console.log('enginebudgetgate: PASS',JSON.stringify(report))
