#!/usr/bin/env node
// Authored source/manifest contract only: NOT proof of runtime lighting or shroud safety.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const web=resolve(import.meta.dirname,'..'), game=resolve(web,'..')
const manifest=JSON.parse(readFileSync(resolve(web,'.forge/blender/manifest.json')))
const before=new Map(), counts={headlamp:0,flashlight:0,yard:0,window:0}
let sources=0
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
for(const [id,asset] of Object.entries(manifest.assets)){
 if(!asset.lights)continue
 sources++
 const path=resolve(game,asset.sourcePath), sha=hash(readFileSync(path))
 assert.equal(sha,asset.sourceSha256,`${id}: source must match export`)
 before.set(path,sha)
 const names=new Set()
 for(const light of asset.lights){
  assert.ok(Object.hasOwn(counts,light.kind));counts[light.kind]++
  assert.equal(typeof light.name,'string');assert.ok(light.name.trim());assert.ok(!names.has(light.name));names.add(light.name)
  assert.ok(Number.isInteger(light.bone)&&light.bone>=0&&light.bone<(asset.rig?.bones.length??1))
  for(const field of ['position','direction','color'])assert.ok(light[field].length===3&&light[field].every(Number.isFinite))
  assert.ok(Math.abs(Math.hypot(...light.direction)-1)<.00001)
  assert.ok(light.color.every(v=>v>=0&&v<=1))
  assert.ok(light.rangeM>0&&light.rangeM<=30)
  assert.ok(light.innerConeDeg>=0&&light.innerConeDeg<light.outerConeDeg&&light.outerConeDeg<90)
 }
}
assert.equal(manifest.assets['2tnk'].lights.length,2)
assert.equal(manifest.assets.e1.lights[0].kind,'flashlight')
assert.equal(manifest.assets.weap.lights[0].kind,'yard')
assert.ok(manifest.assets.weap.lights[0].rangeM>manifest.assets['2tnk'].lights[0].rangeM)
assert.ok(manifest.assets['2tnk'].lights[0].rangeM>manifest.assets.e1.lights[0].rangeM)
const mac='/Applications/Blender.app/Contents/MacOS/Blender'
const result=spawnSync(process.env.BLENDER_BIN||(existsSync(mac)?mac:'blender'),[
 '--background','--factory-startup','--python-exit-code','1','--python',resolve(game,'art/blender/light_anchor_probe.py')
],{cwd:game,encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024})
if(result.error)throw result.error
assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`)
for(const [path,sha] of before)assert.equal(hash(readFileSync(path)),sha,'probe must not change source files')
console.log(`lightanchorgate: PASS — ${sources} saved sources; ${JSON.stringify(counts)}; physical lens anchors, in-memory source edits and invalid-transform rejection. Runtime lights not covered.`)
