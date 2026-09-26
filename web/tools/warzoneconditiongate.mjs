#!/usr/bin/env node
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {WEB_ROOT} from './harness.mjs'
const code=await build({stdin:{contents:"export * from './src/units/warzone-condition.ts';export {DamageStates} from './src/units/damage-states.ts'",resolveDir:WEB_ROOT},bundle:true,write:false,format:'cjs',platform:'node',logLevel:'silent',define:{'import.meta.glob':'__gateGlob'},banner:{js:'const __gateGlob=()=>({});'}})
const m={exports:{}};new Function('module','exports',code.outputFiles[0].text)(m,m.exports)
const {warzoneSeed,warzoneCondition,warzoneSurfaceDamage,DamageStates}=m.exports
const counts=[0,0,0],seed=warzoneSeed('steelseed-default:v03'),placements=[]
for(let i=0;i<10000;i++){const x=(i%100)*4096,z=Math.floor(i/100)*4096,c=warzoneCondition(seed,x,z);counts[c]++;placements.push([x,z,c])}
assert.ok((counts[1]+counts[2])/10000>.28&&(counts[1]+counts[2])/10000<.32,'approximately 30% pre-existing wear')
for(const [x,z,c] of placements.reverse())assert.equal(warzoneCondition(seed,x,z),c,'selection cannot depend on traversal order or camera')
const damage=new DamageStates();for(let r=0;r<6;r++)damage.register('v03',r,'v03.d'+r,{id:r},'material',0)
for(const minimum of [0,1,2]){
 const id=100+minimum;damage.beginFrame(0);assert.equal(damage.opaqueSlot(id,'v03',255,minimum),'v03.d'+minimum)
 assert.equal(damage.rememberedSlot('v03',255,minimum),'v03.d'+minimum,'fog memory retains pre-existing wear')
 let events=0;damage.drainTransitions(()=>events++);assert.equal(events,0,'pre-existing damage must not trigger a new explosion')
 damage.beginFrame(1);damage.opaqueSlot(id,'v03',40,minimum);damage.beginFrame(2);assert.equal(damage.opaqueSlot(id,'v03',40,minimum),'v03.d4','combat damage progresses beyond wear floor')
 damage.beginFrame(3);damage.opaqueSlot(id,'v03',255,minimum);damage.beginFrame(4);assert.equal(damage.opaqueSlot(id,'v03',255,minimum),'v03.d'+minimum,'repair stops at established visual condition')
 assert.ok(warzoneSurfaceDamage(minimum)<.2,'inhabited wear must not read as an active inferno')
 damage.drainTransitions(()=>{});
}
const before=damage.stats.transitions;damage.rememberedSlot('v03',30,2);assert.equal(damage.stats.transitions,before,'remembered health cannot emit new combat transitions')
assert.equal(damage.opaqueSlot(999,'unrelated',255,2),null)
console.log('WARZONE_CONDITION_PASS',JSON.stringify({intact:counts[0],light:counts[1],moderate:counts[2],damagedPercent:(counts[1]+counts[2])/100}))
