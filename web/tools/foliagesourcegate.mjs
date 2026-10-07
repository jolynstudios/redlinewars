#!/usr/bin/env node
// Saved geometry -> unlit atlas -> real opted-in actor. GPU holes are cutoutgate's job.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
const meadow=process.argv.includes('--meadow')
const game=resolve(import.meta.dirname,'../..'),root=join(game,meadow?'web/.forge/meadow':'web/.forge/foliage')
const source=join(game,'art/blender/assets/materials',meadow?'meadow-clump.blend':'broadleaf-bough.blend'),sha=b=>createHash('sha256').update(b).digest('hex')
const mac='/Applications/Blender.app/Contents/MacOS/Blender',blender=process.env.BLENDER_BIN||(existsSync(mac)?mac:'blender')
function load(path){const m=JSON.parse(readFileSync(join(path,'manifest.json'))),stored=readFileSync(join(path,m.file));return {m,stored,raw:gunzipSync(stored)}}
const {m,stored,raw}=load(root),original=sha(readFileSync(source))
assert.equal(m.sourceSha256,original);assert.equal(m.sha256,sha(raw));assert.equal(m.storedBytes,stored.length);assert.equal(m.bytes,raw.length)
assert.equal(m.id,meadow?'meadow-v1':'foliage-v1');assert.equal(m.layers.length,29);assert.equal(m.size,256);assert.equal(m.mipCount,9)
let channels=0
for(const layer of m.layers)for(let mip=0;mip<9;mip++){
 const size=256>>mip
 for(let c=0;c<4;c++){
  const r=layer.mips[mip][c],bytes=raw.subarray(r.offset,r.offset+r.bytes)
  assert.equal(r.bytes,size*size*[4,2,4,1][c]);assert.equal(sha(bytes),r.sha256);channels++
 }
 const a=layer.mips[mip][0],n=layer.mips[mip][1],leaves=[6,26].includes(layer.zone)
 let opaque=0,front=0;const colors=new Set(),normals=new Set()
 for(let p=0;p<size*size;p++){
  const alpha=raw[a.offset+p*4+3]
  if(alpha>=128){
   opaque++;colors.add(raw[a.offset+p*4+1]);normals.add(raw[n.offset+p*2]*256+raw[n.offset+p*2+1])
   const x=raw[n.offset+p*2]/255*2-1,y=raw[n.offset+p*2+1]/255*2-1
   if(1-Math.abs(x)-Math.abs(y)>0)front++
  }
  if(!leaves)assert.equal(alpha,255,'opaque trunk/hardware must not be punched out')
 }
 if(leaves){
  assert.ok(opaque>0,'tiny mips must retain some foliage')
  if(size>=8)assert.ok(Math.abs(opaque/(size*size)-m.layers[6].alphaCoverage[0])<.025,'preserve alpha coverage after byte quantisation')
  if(mip===0){assert.ok(colors.size>30,'real pigment/vein variation');assert.ok(normals.size>100,'curved source normals');assert.ok(front/opaque>.99,'OpenGL +Z tangent normals, not back-facing leaves')}
 }
}
const actor=meadow?JSON.parse(readFileSync(join(game,'web/.forge/environment/props.json'))).assets.grass:JSON.parse(readFileSync(join(game,'web/.forge/blender/manifest.json'))).assets.t01
assert.equal(actor.materialSet,m.id);assert.equal(actor.alphaCutout,true)
if(meadow)assert.equal(actor.triangles,36);else assert.ok(actor.rig.winds.length===9)
assert.ok(actor.triangles<2000)
const temp=mkdtempSync(join(tmpdir(),'steelseed-foliagesourcegate-'))
function run(args){const r=spawnSync(blender,['--background','--factory-startup','--python-exit-code','1',...args],{encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});assert.equal(r.status,0,r.stderr+'\n'+r.stdout)}
function bake(source,output){run(['--python',join(game,'art/blender/foliage_materials.py'),'--','--source',source,'--output',output]);return load(output)}
try{
 const repeat=bake(source,join(temp,'repeat'));assert.deepEqual(repeat.raw,raw,'saved original bough exports deterministically')
 const copy=join(temp,'bough.blend');copyFileSync(source,copy)
 // This modifies ONLY the temporary editable source, never output buffers. Moving half
 // the real leaves changes both silhouette and normals through the actual exporter.
 run(['--python-expr',`import bpy\nbpy.ops.wm.open_mainfile(filepath=${JSON.stringify(copy)},use_scripts=False)\ns=next(s for s in bpy.data.scenes if s.get('ss_foliage_source')==1)\nleaves=sorted((o for o in s.objects if o.type=='MESH'),key=lambda o:o.name)\nassert len(leaves)==64\nfor o in leaves[:32]: o.location.x+=.18\nbpy.data.libraries.write(${JSON.stringify(copy)},{s},fake_user=True,compress=True)`])
 const edited=bake(copy,join(temp,'edited'));assert.notEqual(edited.m.sha256,m.sha256,'source edits must reach runtime atlas')
 assert.equal(sha(readFileSync(source)),original,'canonical source preserved')
 console.log(`foliagesourcegate PASS ${m.id}: ${channels} channel hashes, coverage/normal polarity, ${meadow?'36-triangle rooted cards':'9 preserved wind joints'}, byte-identical repeat and saved-source edit witness; ${stored.length} gzip bytes`)
}finally{rmSync(temp,{recursive:true,force:true})}
