#!/usr/bin/env node
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {validateDeploymentTiming,effectiveMakeFrames} from './deployment-timing.mjs'
const host=resolve(import.meta.dirname,'..'),baselineBytes=readFileSync(resolve(host,'sequence-timing.json')),baseline=JSON.parse(baselineBytes),contract=JSON.parse(readFileSync(resolve(host,'deployment-timing.json')))
validateDeploymentTiming(contract,baselineBytes)
let rejected=0
for(const mutate of [c=>c.overrides[0].image='proc',c=>c.overrides[0].sequence='idle',c=>c.overrides[0].baselineFrames=31,c=>c.overrides[0].appendedFrames=63,c=>c.overrides[0].frames=95,c=>c.overrides[0].frameMilliseconds=41,c=>c.overrides.push({...c.overrides[0],image:'powr'}),c=>c.baselineSha256='0'.repeat(64)]){const c=structuredClone(contract);mutate(c);assert.throws(()=>validateDeploymentTiming(c,baselineBytes));rejected++}
assert.throws(()=>effectiveMakeFrames('fact','make',31,contract));rejected++
for(const [image,n]of Object.entries(baseline.makeSequenceLengths))assert.equal(effectiveMakeFrames(image,'make',n,contract),image==='fact'?96:n)
assert.equal(effectiveMakeFrames('fact','build',25,contract),25)
assert.equal(96*40-32*40,2560)
const source=readFileSync(resolve(host,'../openra/mods/ra/rules/structures.yaml'),'utf8').split('FACT:\n')[1].split('\nPROC:')[0],overlay=readFileSync(resolve(host,'mod/deployment-rules.yaml'),'utf8'),traits=new Map();let actor='',trait=''
for(const line of overlay.split('\n')){if(!line||line.startsWith('#'))continue;if(!line.startsWith('\t')){actor=line;assert.equal(actor,'FACT:')}else if(!line.startsWith('\t\t')){trait=line.trim().slice(0,-1);assert.ok(!traits.has(trait));traits.set(trait,[])}else traits.get(trait).push(line.trim())}
const prerequisiteNames=[...source.matchAll(/^\t(ProvidesPrerequisite@[^:]+):$/gm)].map(m=>m[1]);assert.equal(traits.size,prerequisiteNames.length+2)
assert.deepEqual(traits.get('Production'),['RequiresCondition: !build-incomplete']);assert.deepEqual(traits.get('BaseProvider'),['PauseOnCondition: being-captured || build-incomplete'])
for(const name of prerequisiteNames)assert.deepEqual(traits.get(name),['RequiresCondition: !build-incomplete'])
assert.match(source,/BaseProvider:\n\t\tPauseOnCondition: being-captured\n/);assert.match(source,/\tProduction:\n\t\tProduces: Building, Defense\n/)
assert.ok(readFileSync(resolve(host,'mod/mod.yaml'),'utf8').includes('\tra|rules/deployment-rules.yaml'))
// Verify all three transforms independently on the pinned source without generating files.
const sequenceText=readFileSync(resolve(host,'../openra/mods/ra/sequences/structures.yaml'),'utf8')
function node(line){const m=/^(\t*)([^:#][^:]*):(?:\s*(.*))?$/.exec(line);return m?{indent:m[1].length,key:m[2],value:m[3]??''}:null}
const stripSequenceFields=new Set(JSON.parse(readFileSync(resolve(host,'assetless-policy.json'))).stripSequenceFields),policy=JSON.parse(readFileSync(resolve(host,'assetless-policy.json')))
const results=[]
for(const [file,name]of [['build-ra-mod.mjs','transformSequences'],['ruleparitygate.mjs','expectedSequences'],['integration-gates.mjs','independentlyResolveSequences']]){const text=readFileSync(resolve(host,'tools',file),'utf8'),start=text.indexOf('function '+name+'(');assert.ok(start>=0);const end=text.indexOf('\n}',start)+2;const fn=text.slice(start,end);const run=new Function('nodeOf','yamlNode','stripSequenceFields','policy','sequenceTiming','timing','deploymentTiming','effectiveMakeFrames','withSingleFinalNewline','finalNewline','normalizeFinalNewline','fail','falsifier','TOOL',fn+';return '+name+';');const nl=x=>(Array.isArray(x)?x.join('\n'):x).replace(/\n*$/,'\n');const transform=run(node,node,stripSequenceFields,policy,baseline,baseline,contract,effectiveMakeFrames,nl,nl,nl,m=>{throw Error(m)},null,'test');results.push(transform(sequenceText,'structures.yaml'))}
assert.equal(results[0],results[1]);assert.equal(results[0],results[2]);const fact=results[0].split('\nfact:\n')[1].split('\nproc:')[0];assert.match(fact,/\tmake:\n(?:\t\tFilename: [^\n]+\n)?\t\tLength: 96\n\t\tTick: 40\n/)
console.log('DEPLOYMENT_TIMING_PASS',JSON.stringify({negativeCases:rejected,pinnedMakeCount:Object.keys(baseline.makeSequenceLengths).length,forwardAndReverseMs:3840,originalPhaseMs:1280,addedMs:2560,prerequisiteTraits:prerequisiteNames.length,independentSequenceTransforms:3,generatedFilesWritten:0,hostBuild:false}))
