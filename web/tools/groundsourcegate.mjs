#!/usr/bin/env node
// Saved node graphs, source provenance, real bake channels, and edit/repeat round trips.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

const game=resolve(import.meta.dirname,'../..'),web=join(game,'web'),source=join(game,'art/blender/assets/materials/ground-library.blend')
const hash=b=>createHash('sha256').update(b).digest('hex'),json=p=>JSON.parse(readFileSync(p))
const original=hash(readFileSync(source)),lock=json(join(game,'art/sources.lock.json'))
function read(out){
 const m=json(join(out,'manifest.json')),stored=readFileSync(join(out,'ground.sspbr.gz')),raw=gunzipSync(stored)
 assert.equal(m.bytes,raw.length);assert.equal(m.storedBytes,stored.length);assert.equal(hash(raw),m.sha256)
 assert.equal(m.origin,'bottom-left');assert.equal(m.surfaces.length,3)
 for(const s of m.surfaces){
  assert.equal(s.source.sha256,lock.sources.find(e=>e.id===s.source.id)?.sha256)
  assert.equal(s.mips.length,Math.log2(m.size)+1)
  for(let mip=0;mip<s.mips.length;mip++)for(let c=0;c<4;c++){
   const r=s.mips[mip][c],side=m.size>>mip
   assert.equal(r.bytes,side*side*[4,2,4,1][c]);assert.equal(hash(raw.subarray(r.offset,r.offset+r.bytes)),r.sha256)
  }
 }
 return {m,raw}
}
const shipping=read(join(web,'.forge/ground'));assert.equal(shipping.m.sourceSha256,original)
for(const s of shipping.m.surfaces){
 const range=s.mips[0][0],values=new Set()
 for(let i=range.offset;i<range.offset+range.bytes;i+=4)values.add(shipping.raw[i])
 assert.ok(values.size>40,`${s.id}: packed albedo needs actual surface detail`)
}
const temp=mkdtempSync(join(tmpdir(),'steelseed-groundsource-'))
const mac='/Applications/Blender.app/Contents/MacOS/Blender',blender=process.env.BLENDER_BIN||(existsSync(mac)?mac:'blender')
function run(args){const r=spawnSync(blender,['--background','--factory-startup','--python-exit-code','1',...args],{cwd:game,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});assert.equal(r.status,0,`${r.error??''}\n${r.stdout}\n${r.stderr}`)}
function bake(label,input=source){const out=join(temp,label);run(['--python',join(game,'art/blender/ground_materials.py'),'--','--source',input,'--size','32','--output',out]);return read(out)}
try{
 const before=bake('before'),repeat=bake('repeat')
 assert.deepEqual(before.raw,repeat.raw,'unchanged saved graph must rebake identically')
 const copy=join(temp,'edited.blend'),script=join(temp,'edit.py')
 writeFileSync(script,[
  'import bpy',`bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(source)},use_scripts=False)`,
  'for im in bpy.data.images:',
  `    if im.source=='FILE':im.filepath=bpy.path.abspath(im.filepath,start=${JSON.stringify(resolve(source,'..'))})`,
  "assert all(not im.packed_file for im in bpy.data.images if im.source=='FILE'), 'downloads must not be packed into source'",
  "mat=bpy.data.materials['STEELSEED ground / grass']; nodes=mat.node_tree.nodes; links=mat.node_tree.links",
  "base=nodes['Terrain PBR'].inputs['Base Color']",
  'for link in list(base.links):links.remove(link)',
  'base.default_value=(.7,.1,.03,1)',
  "rough=nodes['Terrain PBR'].inputs['Roughness']",
  'for link in list(rough.links):links.remove(link)',
  'rough.default_value=.41',
  "nodes['Source tangent normal'].inputs['Strength'].default_value=0",
  "mat['ss_tile_metres']=2.25",
  `bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(copy)},relative_remap=False)`,
 ].join('\n'))
 run(['--python',script]);const after=bake('edited',copy)
 assert.notDeepEqual(before.raw,after.raw,'authored edits must reach packed pixels')
 const grass=after.m.surfaces.find(s=>s.id==='grass')
 assert.equal(grass.tileMeters,2.25)
 const orm=grass.mips[0][2],normal=grass.mips[0][1]
 for(let i=orm.offset;i<orm.offset+orm.bytes;i+=4)assert.ok(Math.abs(after.raw[i]-.41*255)<1)
 for(let i=normal.offset;i<normal.offset+normal.bytes;i++)assert.equal(after.raw[i],128,'zero normal strength reaches packed flat normal')
 assert.equal(hash(readFileSync(source)),original,'canonical Blender source preserved')
 console.log(`groundsourcegate: PASS — three pinned materials; repeat bake identical; saved tint/roughness/normal strength/tile edits reach output; original preserved; ${shipping.m.storedBytes} gzip bytes`)
}finally{rmSync(temp,{recursive:true,force:true})}
