#!/usr/bin/env node
// Offline phase0 data checks, not a substitute for the composed visual witness.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

const web=resolve(import.meta.dirname,'..'),game=resolve(web,'..'),root=resolve(web,'.forge/surfaces')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const m=JSON.parse(readFileSync(resolve(root,'manifest.json'))),stored=readFileSync(resolve(root,m.file)),raw=gunzipSync(stored)
assert.equal(m.schema,1);assert.equal(m.id,'industrial-v1');assert.equal(m.origin,'bottom-left')
assert.equal(raw.length,m.bytes);assert.equal(stored.length,m.storedBytes);assert.equal(hash(raw),m.sha256)
const palette=JSON.parse(readFileSync(resolve(web,'src/core/blender-palette.json')))
assert.equal(m.size,512);assert.equal(m.mipCount,10);assert.equal(m.layers.length,palette.length)
const lock=JSON.parse(readFileSync(resolve(game,'art/sources.lock.json')))
for(const source of m.sources)assert.equal(source.sha256,lock.sources.find(e=>e.id===source.id)?.sha256)
let ranges=0
for(let zone=0;zone<m.layers.length;zone++){
 const layer=m.layers[zone];assert.equal(layer.zone,zone);assert.equal(layer.mips.length,m.mipCount)
 for(let mip=0;mip<m.mipCount;mip++){
  assert.equal(layer.mips[mip].length,4)
  for(let c=0;c<4;c++){
   const r=layer.mips[mip][c],side=m.size>>mip
   assert.ok(Number.isInteger(r.offset)&&r.offset>=0&&r.offset+r.bytes<=raw.length)
   assert.equal(r.bytes,side*side*[4,2,4,1][c]);assert.equal(hash(raw.subarray(r.offset,r.offset+r.bytes)),r.sha256);ranges++
  }
 }
}
for(const zone of [0,3]){
 const r=m.layers[zone].mips[0][0],data=raw.subarray(r.offset,r.offset+r.bytes)
 const values=new Set();for(let i=0;i<data.length;i+=4)values.add(data[i])
 assert.ok(values.size>20,`zone ${zone}: spatial surface variation, not a flat fill`)
}
const actors=JSON.parse(readFileSync(resolve(web,'.forge/blender/manifest.json'))).assets
// DERIVED, never a name table. This gate was written against the two-actor pilot and listed
// `['1tnk','powr']` literally, so when the promotion pass went roster-wide it would have kept
// reporting PASS while checking 2 of 280 actors — the exact stale-list failure `rosteradapt`
// warns about, and the reason 277 assets sat unsurfaced without any gate noticing.
const promoted=Object.keys(actors).filter(id=>actors[id].materialSet===m.id).sort()
assert.ok(promoted.length>=2,`no actor is bound to ${m.id}`)
// Every promoted actor must be fully promoted. A half-bound actor renders its table but
// samples projected UVs, which looks like smeared texture rather than a missing one.
const maskStats={},masked=[]
for(const id of promoted){
 const a=actors[id];assert.equal(a.materialSet,m.id)
 // Existing 29-row sources retain their exact tables when a new material is
 // appended. New sources declare the current palette; row semantics stay strict.
 assert.ok(a.materialTable.length===29||a.materialTable.length===palette.length)
 for(const row of a.materialTable){assert.equal(row.zone,row.layer);assert.equal(row.name,m.layers[row.layer].name)}
 assert.ok(a.uvMapping.authoredObjects>0,`${id}: material set bound with no authored UVs`)
 assert.equal(a.uvMapping.projectedObjects,0,`${id}: ${a.uvMapping.projectedObjects} objects still on projected UVs`)
 // The mask is optional by design: `t01`/`tc04` carry a material set with none, and
 // `blender-mesh.ts` requires only the table. Binding the set is the free half of the
 // promotion; the bake is the metered half. Check a mask only where one was baked.
 const d=a.detailMask
 if(!d)continue
 masked.push(id)
 assert.equal(d.uv,1);assert.equal(d.origin,'bottom-left')
 const compressed=readFileSync(resolve(web,'.forge/blender',d.file)),pixels=gunzipSync(compressed)
 assert.equal(compressed.length,d.storedBytes);assert.equal(pixels.length,d.size*d.size*4);assert.equal(hash(pixels),d.sha256)
 const unique=Array.from({length:4},()=>new Set())
 for(let i=0;i<pixels.length;i++)unique[i%4].add(pixels[i])
 assert.ok(unique[0].size>16,`${id}: AO must contain baked spatial occlusion`)
 maskStats[id]=unique.map(v=>v.size)
}
// Report the byte cost every run. The masks are the only part of the promotion that costs
// download and texture memory, and a number nobody prints is a budget nobody defends.
const maskBytes=masked.reduce((sum,id)=>sum+actors[id].detailMask.storedBytes,0)
const residentBytes=masked.reduce((sum,id)=>sum+actors[id].detailMask.bytes,0)
const sample=Object.fromEntries(Object.entries(maskStats).slice(0,3))
console.log(`surfacepackgate: PASS — ${ranges} verified mip/channel ranges, two pinned sources; `+
 `${promoted.length} actors bound to ${m.id}, all on authored UVs with zero projected objects; `+
 `${masked.length} carry a baked mask, ${(maskBytes/1e6).toFixed(1)} MB gzipped and `+
 `${(residentBytes/1e6).toFixed(1)} MB resident at full size; library ${stored.length} gzip bytes. `+
 `AO/cavity/dirt/wear distinct values, first three: ${JSON.stringify(sample)}. Runtime witness still required.`)
