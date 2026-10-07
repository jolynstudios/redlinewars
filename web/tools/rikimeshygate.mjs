#!/usr/bin/env node
// Exercises the shipped native Riki loader and pose mixer against the authored pack.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import ts from 'typescript'
const web = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dir = resolve(web, '.forge/riki-meshy')
const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8'))
globalThis.__rikiGlob = pattern => pattern.endsWith('manifest.json')
  ? { '../../.forge/riki-meshy/manifest.json': manifest }
  : Object.fromEntries(readdirSync(dir).filter(f => f.endsWith('.gz')).map(f => [`../../.forge/riki-meshy/${f}`, `http://riki.gate/${f}`]))
const compiled = await build({ stdin: { contents: `export * from './src/units/riki-assets'; export { Pose, computeWorldTransforms, computeSkinMatrices } from './src/geo/rig'`, resolveDir: web }, bundle: true, format: 'esm', platform: 'node', write: false, define: { 'import.meta.glob': '__rikiGlob' }, banner: { js: 'const __rikiGlob=globalThis.__rikiGlob;' } })
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
let corruptFile = ''
globalThis.fetch = async url => {
  const name = new URL(url).pathname.slice(1)
  assert(!name.includes('/'), 'local asset only')
  const bytes = Buffer.from(readFileSync(resolve(dir, name)))
  if (name === corruptFile) bytes[Math.floor(bytes.length / 2)] ^= 1
  return new Response(bytes)
}
api.validateRikiManifest(manifest, manifest.parentSourceSha256)
for (const level of manifest.levels) assert.equal(createHash('sha256').update(readFileSync(resolve(web, '..', level.sourcePath))).digest('hex'), level.sourceSha256, 'saved Blender source binding')
const assets = await api.loadRikiAssets(manifest.parentSourceSha256)
assert(assets && assets.levels.length === 3)
const skeleton = assets.levels[0].rig.skeleton
const pose = () => new api.Pose(skeleton)
const close = (a, b, message, epsilon = 2e-6) => { assert.equal(a.length, b.length); for (let i = 0; i < a.length; i++) assert(Math.abs(a[i] - b[i]) < epsilon, `${message} [${i}]: ${a[i]} != ${b[i]}`) }
const equalPose = (a, b, message) => { close(a.t, b.t, message); close(a.r, b.r, message); close(a.s, b.s, message) }
for (const clip of assets.clips.values()) {
  api.validateRikiMotion(clip.entry, clip.data, 26)
  for (const phase of [0, .125, .5, .875, 1]) {
    const p = pose(); api.sampleRikiClip(clip, p, phase)
    for (let b = 0; b < 26; b++) assert(Math.abs(Math.hypot(...p.r.slice(b * 4, b * 4 + 4)) - 1) < 1e-5)
    if (phase === 0 || phase === 1) for (let b = 0; b < 26; b++) close(p.t.slice(b * 3, b * 3 + 3), clip.data.slice((phase * (clip.entry.frames - 1) * 26 + b) * 7, (phase * (clip.entry.frames - 1) * 26 + b) * 7 + 3), 'absolute local endpoint')
  }
  if (clip.entry.loop) { const a = pose(), b = pose(); api.sampleRikiClip(clip, a, 0); api.sampleRikiClip(clip, b, 1); close(a.t, b.t, 'loop translation') }
  for (const mutate of [d => { d[0] = NaN }, d => { d[0] = 10 }, d => { d.fill(0, 3, 7) }]) {
    const d = clip.data.slice(); mutate(d); assert.throws(() => api.validateRikiMotion(clip.entry, d, 26))
  }
}
// Antipodal representations must not interpolate through the zero quaternion.
const synthetic = { entry: { frames: 2, boneCount: 1 }, data: Float32Array.from([.1,.2,.3,0,0,0,1, .3,.4,.5,0,0,0,-1]) }
const p = pose(); api.sampleRikiClip(synthetic, p, .5); close(p.t.slice(0,3), [.2,.3,.4], 'absolute midpoint'); assert(Math.abs(p.r[3]) > .99999)
const cases = [
  ['run', true, 0, 99, false], ['runfire', true, 1, .05, false],
  ['crawl', true, 0, 99, true], ['aim', false, 1, 99, false],
  ['fire', false, 1, .05, false], ['pronefire', false, 1, .05, true],
]
for (const [id, moving, aim, fire, prone] of cases) {
  const distance = .137, actual = pose(), expected = pose(), clip = assets.clips.get(id)
  api.poseRiki(assets, actual, distance, moving, aim, fire, prone)
  const phase = moving ? distance / (prone ? Math.max(assets.clips.get('crawl').entry.strideM,api.RIKI_PRONE_CYCLE_DISTANCE) : assets.clips.get('run').entry.strideM) % 1 : id === 'aim' ? aim : fire / clip.entry.durationS
  api.sampleRikiClip(clip, expected, phase)
  equalPose(actual, expected, `${id} selection`)
  actual.t.fill(.8); actual.r.fill(.1); actual.s.fill(2)
  api.poseRiki(assets, actual, distance, moving, aim, fire, prone)
  equalPose(actual, expected, `${id} reset independence`)
}
// Moving aim is a held upper-body aim pose, never the recoil-bearing runfire clip.
for(const aimWeight of [.35,1]) {
 const distance=.137,actual=pose(),expected=pose(),run=assets.clips.get('run')
 api.poseRiki(assets,actual,distance,true,aimWeight,99,false)
 api.sampleRikiClip(run,expected,(distance/run.entry.strideM)%1)
 api.sampleRikiClip(assets.clips.get('aim'),expected,1,aimWeight,assets.upperBones)
 equalPose(actual,expected,'moving aim without fire')
 const base=pose();api.sampleRikiClip(run,base,(distance/run.entry.strideM)%1)
 for(let b=0;b<26;b++) if(!assets.upperBones.includes(b)) {
  close(actual.t.slice(b*3,b*3+3),base.t.slice(b*3,b*3+3),'aim preserves running root/legs')
  close(actual.r.slice(b*4,b*4+4),base.r.slice(b*4,b*4+4),'aim preserves running root/legs')
 }
}
const crawl = assets.clips.get('crawl'), legIds = skeleton.names.map((n,i) => /^(thigh|shin|foot)\./.test(n) ? i : -1).filter(i => i >= 0)
let crawlChange = 0
const first = pose()
api.poseRiki(assets, first, 0, true, 1, .05, true)
for (const fraction of [.25,.5,.75]) {
  const actual = pose(), expected = pose()
  api.poseRiki(assets, actual, Math.max(crawl.entry.strideM,api.RIKI_PRONE_CYCLE_DISTANCE) * fraction, true, 1, .05, true)
  api.sampleRikiClip(crawl, expected, fraction)
  for (const b of legIds) {
    close(actual.r.slice(b*4,b*4+4), expected.r.slice(b*4,b*4+4), 'firing must preserve crawl legs')
    crawlChange = Math.max(crawlChange, ...actual.r.slice(b*4,b*4+4).map((v,c) => Math.abs(v-first.r[b*4+c])))
  }
}
assert(crawlChange > .01, 'moving prone must retain animated legs')
// CPU equivalent of the shipped four-weight vertex skinning, using actual mesh endpoints.
function deform(mesh, p) {
  const world = api.computeWorldTransforms(p, new Float32Array(26*16))
  const matrices = api.computeSkinMatrices(p.skeleton, world, new Float32Array(26*16))
  const result = new Float32Array(mesh.positions.length)
  for (let v=0;v<mesh.vertexCount;v++) for(let k=0;k<4;k++) {
    const w=mesh.skinWeights[v*4+k], o=mesh.skinIndices[v*4+k]*16
    for(let a=0;a<3;a++) result[v*3+a]+=w*(matrices[o+a]*mesh.positions[v*3]+matrices[o+4+a]*mesh.positions[v*3+1]+matrices[o+8+a]*mesh.positions[v*3+2]+matrices[o+12+a])
  }
  assert([...result].every(Number.isFinite), 'finite deformed vertices')
  return result
}
const bounds = data => { const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity]; for(let i=0;i<data.length;i++){const a=i%3;min[a]=Math.min(min[a],data[i]);max[a]=Math.max(max[a],data[i])} return {min,max,size:max.map((n,a)=>n-min[a])} }
for(const level of assets.levels) close(deform(level.mesh,new api.Pose(level.rig.skeleton)),level.mesh.positions,'bind skin identity',1e-5)
const mesh=assets.levels[0].mesh, standing=bounds(mesh.positions)
assert(standing.size[1]>.30 && standing.size[1]<.45,'standing height must remain native 0.37m Y-up scale')
assert(standing.size[1]>standing.size[2], 'standing body Y-up, not Z-up')
const deformations={}
for(const [id,clip] of assets.clips) {
  const extrema=[]
  for(const phase of [0,.25,.5,.75,1]) {
    const p=pose();api.sampleRikiClip(clip,p,phase)
    const b=bounds(deform(mesh,p)); extrema.push(b)
    assert(Math.max(...b.size)<1,'motion cannot explode the native-scale mesh')
    assert(b.min[1]>-.08,'motion cannot sink significantly beneath ground')
  }
  deformations[id]=extrema
}
assert(deformations.crawl.every(b=>b.size[1]<standing.size[1]*.8),'prone motion must visibly lower the body on Y')
for (const mutate of [m => {m.parentSourceSha256='0'.repeat(64)}, m => {m.levels[1].rig.bones[2].pos[0]+=.01}, m => {m.levels[0].rig.bones[1].parent=25}, m => {m.motions[0].boneCount=20}]) {
  const m=structuredClone(manifest); mutate(m); assert.throws(() => api.validateRikiManifest(m,manifest.parentSourceSha256))
}
const savedRig=structuredClone(manifest.levels.map(e=>e.rig))
for(const level of manifest.levels) level.rig.bones[2].pos[0]+=.001
await assert.rejects(() => api.loadRikiAssets(manifest.parentSourceSha256), /rig digest mismatch/)
manifest.levels.forEach((e,i)=>{e.rig=savedRig[i]})
for (const file of [manifest.file, ...manifest.motions.map(e=>e.file)]) { corruptFile=file; await assert.rejects(() => api.loadRikiAssets(manifest.parentSourceSha256)) }
corruptFile=''
// Execute the production Units.update articulation branch and muzzle-palette block.
// Unrelated render submission/terrain/HUD are excluded, not replaced with a second mixer.
const unitSource=readFileSync(resolve(web,'src/units/index.ts'),'utf8')
const tree=ts.createSourceFile('units.ts',unitSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
const unitClass=tree.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='Units')
assert(unitClass,'production Units class')
const update=unitClass.members.find(n=>n.name?.getText(tree)==='update')
let route, palette
function visit(node){
 if(ts.isIfStatement(node)&&node.expression.getText(tree)==='this.rikiAssets !== null && this.rikiRigs.has(b.rig)') route=node.getText(tree)
 if(ts.isIfStatement(node)&&node.expression.getText(tree)==='articulated'&&node.thenStatement.getText(tree).includes('posedRifleMuzzles')) palette=node.getText(tree)
 ts.forEachChild(node,visit)
}
visit(update);assert(route&&palette,'actual update routing and muzzle blocks')
const js=ts.transpileModule(`function run(b,anim,actors,actorId,g,alpha){const i=0;let articulated=false,paletteBase=0;const legs=b.rig.legBones;const reserved={base:0,matrices:new Float32Array(26*16)},skinStats={posedActors:0,bindPoseActors:0};${route};${palette};return reserved.matrices}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText
const runRoute=new Function('poseRiki','computeWorldTransforms','computeSkinMatrices','ActorAnimationState',`${js};return run`)(api.poseRiki,api.computeWorldTransforms,api.computeSkinMatrices,{prone:2})
const productionRig={...assets.levels[0].rig,pose:pose(),world:new Float32Array(26*16)}
const owner={rikiAssets:assets,rikiRigs:new Set([productionRig]),humanMotion:null,humanRigs:new Set(),posedRifleMuzzles:new Map()}
const legs=productionRig.legBones
assert.equal(productionRig.skeleton.boneCount,26)
// Actual source selection: only e7 claims the native asset; nearby roles remain unchanged.
assert(unitSource.includes("const rikiSlot = slot.name === 'e7' ? this.rikiAssets : null"))
const selectProfile=new Function('slot',unitSource.match(/const rikiSlot =[^\n]+/)[0]+';return rikiSlot')
assert.equal(selectProfile.call(owner,{name:'e7'}),assets)
for(const id of ['e1','e2','e3','spy'])assert.equal(selectProfile.call(owner,{name:id}),null)
let prior=0,current=.1,aim=0,since=99
const anim={interpolatedDistanceOf:(_id,a)=>prior+(current-prior)*a,interpolatedAimOf:()=>aim,secondsSinceFire:()=>since}
for(const scenario of [{prone:false,moving:true,fire:false},{prone:true,moving:true,fire:false},{prone:false,moving:false,fire:true},{prone:true,moving:true,fire:true}]){
 prior=.03;current=scenario.moving?.137:prior;aim=scenario.fire?1:0;since=scenario.fire?.05:99
 const expected=pose(),fit=1.7,alpha=.65,dist=anim.interpolatedDistanceOf(101,alpha)/fit
 api.poseRiki(assets,expected,dist,scenario.moving,aim,since,scenario.prone)
 const matrices=runRoute.call(owner,{rig:productionRig},anim,{animState:Uint16Array.of(scenario.prone?2:65535)},101,{fitScale:fit},alpha)
 equalPose(productionRig.pose,expected,'production Units routing')
 const world=api.computeWorldTransforms(expected,new Float32Array(26*16)),expectedPalette=api.computeSkinMatrices(skeleton,world,new Float32Array(26*16))
 close(matrices,expectedPalette,'production palette')
 const muzzle=owner.posedRifleMuzzles.get(101),k=assets.muzzleBone*16,{pos,direction}=manifest.muzzle
 for(let a=0;a<3;a++){
  assert(Math.abs(muzzle[a]-(expectedPalette[k+a]*pos[0]+expectedPalette[k+4+a]*pos[1]+expectedPalette[k+8+a]*pos[2]+expectedPalette[k+12+a]))<1e-6,'posed rifle muzzle tip')
  assert(Math.abs(muzzle[a+3]-(expectedPalette[k+a]*direction[0]+expectedPalette[k+4+a]*direction[1]+expectedPalette[k+8+a]*direction[2]))<1e-6,'posed rifle muzzle direction')
 }
}
// Stationary prone remains deterministic across repeated updates; resumed travel follows distance.
const paused=pose(),repeat=pose(),resumed=pose()
api.poseRiki(assets,paused,.19,false,0,99,true)
api.poseRiki(assets,repeat,.77,false,0,99,true)
equalPose(paused,repeat,'stationary prone is time-independent')
api.poseRiki(assets,resumed,.19,true,0,99,true)
const resumedExpected=pose();api.sampleRikiClip(crawl,resumedExpected,.19/Math.max(crawl.entry.strideM,api.RIKI_PRONE_CYCLE_DISTANCE))
equalPose(resumed,resumedExpected,'resumed prone follows cumulative distance')
const ordinaryRig={...productionRig,pose:pose(),legBones:new Int32Array(),strideM:0}
const ordinaryBefore=pose();runRoute.call(owner,{rig:ordinaryRig},anim,{animState:Uint16Array.of(2)},102,{fitScale:1},.5)
equalPose(ordinaryRig.pose,ordinaryBefore,'non-Riki pose remains untouched by native routing')
assert(!owner.posedRifleMuzzles.has(102),'non-Riki cannot acquire native rifle muzzle')
const out=resolve(web,'../.artifacts/riki-meshy'); mkdirSync(out,{recursive:true})
writeFileSync(resolve(out,'runtime-gate.json'),JSON.stringify({status:'passed',clips:[...assets.clips.keys()],boneCount:skeleton.boneCount,crawlChange,standing,deformations},null,2)+'\n')
console.log('rikimeshygate: PASS native loader integrity, absolute poses, interpolation, selection, reset, prone gait')
