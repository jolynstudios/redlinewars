import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {gunzipSync} from 'node:zlib'
import {build} from 'esbuild'
const shipping=process.argv.includes('--shipping')
const root=new URL('../..',import.meta.url).pathname,out=root+'/.artifacts/planx/naval/promotion/',read=p=>JSON.parse(readFileSync(p)),sha=b=>createHash('sha256').update(b).digest('hex'),plan=read(out+'promotion-plan.json'),packRoot=shipping?root+'/web/.forge/':out,roster=read(packRoot+'blender/manifest.json'),raw=readFileSync(packRoot+'blender/roster.ssasset'),damage=read(packRoot+'damage-states/dd/manifest.json'),dbytes=gunzipSync(readFileSync(packRoot+'damage-states/dd/states.ssmesh.gz'))
const bundle=await build({entryPoints:[root+'/web/src/units/blender-mesh.ts'],bundle:true,format:'esm',write:false,logLevel:'silent'});writeFileSync(out+'decoder.mjs',bundle.outputFiles[0].text);const{decodeBlenderAsset}=await import(out+'decoder.mjs')
assert.equal(sha(raw),roster.sha256);assert.equal(sha(dbytes),damage.sha256);assert.deepEqual(gunzipSync(readFileSync(packRoot+'blender/roster.ssasset.gz')),raw)
for(const e of plan.unchangedRosterPayloads){const x=roster.assets[e.id];assert.equal(sha(raw.subarray(x.offset,x.offset+x.bytes)),e.sha256,e.id+' untouched')}
for(const[path,hash]of Object.entries(plan.expectedCurrentFiles))assert.equal(sha(readFileSync((shipping?out+'baseline/files/':root+'/')+path)),hash,'original preserved: '+path)
if(shipping)for(const file of read(out+'promotion-result.json').files)assert.equal(sha(readFileSync(root+'/'+file.path)),file.sha256,'promoted file: '+file.path)
for(const[path,hash]of Object.entries(plan.unchangedDamageFiles))assert.equal(sha(readFileSync(root+'/web/.forge/'+path)),hash)
const parent=roster.assets.dd,base=decodeBlenderAsset(raw,parent),rows=[],sourceRows=read(root+'/.artifacts/planx/naval/damage-v4/report.json')
for(let i=0;i<5;i++){
 const e=damage.states[i],source=sourceRows[i],decoded=decodeBlenderAsset(dbytes,e);assert.equal(decoded.mesh.validate(),null);assert.deepEqual(e.rig.bones,parent.rig.bones,'exact shared parent rig d'+(i+1));assert.ok(Array.from(decoded.rig.capturedVertices).every(n=>n>0));assert.equal(sha(readFileSync((shipping?root+'/art/blender/assets/':out+'sources/')+'dd.d'+(i+1)+'.blend')),e.sourceSha256)
 const minY=Math.min(...source.metrics.filter(m=>!m.hiddenRender).map(m=>m.bounds[0][2])),maxY=Math.max(...source.metrics.filter(m=>!m.hiddenRender).map(m=>m.bounds[1][2]));assert.ok(Math.abs(e.bounds[0][1]-minY)<1e-5);assert.ok(Math.abs(e.bounds[1][1]-maxY)<1e-5,'authored height is not legacy-squashed')
 assert.ok(Math.abs(e.bounds[0][1]-parent.bounds[0][1])<1e-5,'keel continuity');const mask=gunzipSync(readFileSync(packRoot+'damage-states/dd/'+e.detailMask.file));assert.equal(sha(mask),e.detailMask.sha256);assert.equal(e.detailMask.sourceSha256,e.sourceSha256)
 rows.push({id:'dd.d'+(i+1),triangles:e.triangles,sourceHeight:[minY,maxY],exportHeight:[e.bounds[0][1],e.bounds[1][1]],capturedVertices:Array.from(decoded.rig.capturedVertices),sameRig:true})
}
const old=read(root+'/.artifacts/planx/naval/negative-squash/dd.d4.json');assert.notDeepEqual(old.rig.bones,parent.rig.bones);assert.equal(old.rig.bones[1].pos[1],parent.rig.bones[1].pos[1]*.75);assert.ok(Math.abs(old.bounds[1][1]-damage.states[3].bounds[1][1]*.75)<1e-7)
writeFileSync(out+(shipping?'shipping-gate.json':'package-gate.json'),JSON.stringify({passed:true,shipping,rows,untouchedRosterPayloads:plan.unchangedRosterPayloads.length,untouchedDamageFiles:Object.keys(plan.unchangedDamageFiles).length,negativeSquashRejected:true,sourceHashesUnchanged:true},null,2));console.log('navalpackagegate PASS',rows)
