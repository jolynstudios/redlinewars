// Compare the appended yard with the accepted original using production skinning.
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
import {build} from 'esbuild'
const root=resolve(import.meta.dirname,'../..'),study=join(root,'.artifacts/planx/deployment-completion')
const oldFolder=join(root,'.artifacts/planx/deployment/promotion/blender'),newFolder=join(study,'exports/fact')
const read=p=>JSON.parse(readFileSync(p)),sha=b=>createHash('sha256').update(b).digest('hex')
const bundled=await build({stdin:{contents:"export {decodeBlenderAsset} from './src/units/blender-mesh';export {DeploymentRig} from './src/units/deployment-rig';export {computeWorldTransforms,computeSkinMatrices} from './src/geo/rig'",resolveDir:join(root,'web')},bundle:true,write:false,format:'cjs',platform:'node',logLevel:'silent'})
const m={exports:{}};new Function('module','exports',bundled.outputFiles[0].text)(m,m.exports)
const {decodeBlenderAsset,DeploymentRig,computeWorldTransforms,computeSkinMatrices}=m.exports
function load(folder){const meta=read(join(folder,'manifest.json')).assets.fact,bytes=readFileSync(join(folder,'roster.ssasset'));assert.equal(sha(bytes.subarray(meta.offset,meta.offset+meta.bytes)),meta.sha256);const decoded=decodeBlenderAsset(bytes,meta),skeleton=decoded.rig.skeleton;return {meta,skeleton,rig:new DeploymentRig(skeleton,meta.deployment),pose:skeleton.createPose(),world:skeleton.createMatrixBuffer(),skin:skeleton.createMatrixBuffer()}}
const old=load(oldFolder),next=load(newFolder),prefix=31/95,n=old.skeleton.boneCount
assert.equal(n,119);assert.equal(next.rig.prefixEnd,prefix);assert.ok(next.skeleton.boneCount>n&&next.skeleton.boneCount<=256)
assert.deepEqual(next.meta.rig.bones.slice(0,n),old.meta.rig.bones,'Original joint hierarchy and bind transforms retained')
for(const c of old.meta.deployment.channels){
 const actual=next.meta.deployment.channels.find(x=>x.index===c.index),expected=structuredClone(c);assert.ok(actual)
 for(const key of ['phaseStart','phaseEnd','translationPhaseStart','translationPhaseEnd'])if(expected[key]!==undefined)expected[key]*=prefix
 assert.deepEqual(actual,expected,'Original motion must only remap to preserved time interval: '+c.boneName)
}
function sample(model,p){model.pose.resetToBind();model.rig.sample(model.pose,p);computeWorldTransforms(model.pose,model.world);computeSkinMatrices(model.skeleton,model.world,model.skin);assert.ok(model.pose.s.every(v=>v===1));return model.skin}
function error(a,b){let max=0;for(let i=0;i<n*16;i++)max=Math.max(max,Math.abs(a[i]-b[i]));return max}
let maxError=0;const samples=[]
// Exact engine frames plus subframe interpolation, followed by held prefix endpoint.
for(let i=0;i<=310;i++)samples.push(i/310*prefix)
for(let frame=32;frame<=95;frame++)samples.push(frame/95)
for(const p of samples){const delta=error(sample(old,Math.min(p/prefix,1)),sample(next,p));assert.ok(delta<2e-6,'Preserved skin palette drift at '+p+': '+delta);maxError=Math.max(maxError,delta)}
const changed=next.skin.slice();changed[12]+=.01;assert.ok(error(old.skin,changed)>.009,'Negative control catches altered placement')
mkdirSync(study,{recursive:true});const report={status:'PASS',oldSourceSha256:old.meta.sourceSha256,newSourceSha256:next.meta.sourceSha256,preservedBones:n,totalBones:next.skeleton.boneCount,prefixEnd:prefix,enginePrefixFrames:32,totalFrames:96,sampledPoses:samples.length,maxSkinMatrixError:maxError,noScale:true,originalChannelsUnchangedExceptTimeNormalization:true,negativeControl:true,scope:'Actual exported rigs and production sampling/skinning; source mesh preservation is checked separately by the authoring audit.'}
writeFileSync(join(study,'prefix-runtime-report.json'),JSON.stringify(report,null,2)+'\n');console.log('DEPLOYMENT_PREFIX_PASS',JSON.stringify(report))
