#!/usr/bin/env node
// Replay the exact engine C4 destruction payload through production Fx. No weapon
// fire or impact is emitted: demolition must independently submit an explosion.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
const root=resolve(import.meta.dirname,'../..'),temp=mkdtempSync(join(tmpdir(),'specialactionfx-'))
const output=join(root,'.artifacts/special-actions'),file=join(output,'c4-destroyed-payload.bin')
const payload=readFileSync(file)
assert.equal(payload.length,18,'Run engine specialactiongate first to capture real C4 payload')
const view=new DataView(payload.buffer,payload.byteOffset,payload.byteLength),id=view.getUint32(0,true)
const x=view.getInt32(4,true)/1024,z=view.getInt32(8,true)/1024,y=view.getInt32(12,true)/1024
const entry=join(temp,'entry.ts'),bundle=join(temp,'bundle.mjs')
writeFileSync(entry,`export {Fx} from '${root}/web/src/fx/index';export {EventBus,SimEvent} from '${root}/web/src/core/events'`)
await build({entryPoints:[entry],bundle:true,format:'esm',platform:'neutral',outfile:bundle,logLevel:'silent',define:{'import.meta.glob':'__gateGlob'},banner:{js:'const __gateGlob=()=>({});'}})
const {Fx,EventBus,SimEvent}=await import(bundle)
const events=new EventBus(),draws=[],lights=[]
const render={camera:{position:Float32Array.of(x,24,z)},upload(mesh,label){return{indexCount:mesh.triangleCount*3,label}},submit(item){draws.push({label:item.mesh.label,count:item.instanceCount,matrix:Array.from(item.instances.slice(0,16))})},addLight(...args){lights.push(args)}}
const terrain={heightAt(){return 0}},shroud={isVisible(){return true},unmodelled:false}
// Building family is registered as death-kind 5 by Units from its authored roster.
const units={muzzleLiftOf(){return 0},deathKindOf(actor){assert.equal(actor,id);return 5},deathAltitudeOf(){return null},drainRungTransitions(){}}
const ctx={config:{q:{decals:512}},snapshot:{view,byteLength:18},events,time:{tick:0,alpha:0},actorTypeName(){return ''},peek(){return null},get(name){return {render,terrain,shroud,units}[name]}}
const fx=new Fx();fx.init(ctx)
events.emit(SimEvent.actorDestroyed,{kind:5,offset:0,byteLength:18})
ctx.time.alpha=25/60;fx.update(1/60,ctx)
assert.equal(fx.stats.acceptedDestroyedEvents,1)
const core=draws.find(d=>d.label==='fx:actor-destruction')
assert.equal(core?.count,1,'A C4 kill without a bullet hit must submit its explosion core')
assert.ok(Math.abs(core.matrix[12]-x)<1e-5&&Math.abs(core.matrix[13]-y)<1e-5&&Math.abs(core.matrix[14]-z)<1e-5,'Explosion must preserve C4 building position')
assert.ok(lights.some(l=>Math.abs(l[0]-x)<1e-5&&Math.abs(l[2]-z)<1e-5),'C4 blast must illuminate its building position')
writeFileSync(join(output,'fx-report.json'),JSON.stringify({status:'PASS',source:file,actorId:id,x,y,z,core,lights:lights.length,scope:'Exact real-engine demolition payload through production Fx to RenderApi seam. No weapon fire/impact. Empty authored cloud registry exercises guaranteed fallback explosion; this is draw submission, not a pixel screenshot.'},null,2)+'\n')
console.log('SPECIAL_ACTION_FX_PASS',JSON.stringify({actorId:id,core:core.label,lights:lights.length}))
fx.dispose();rmSync(temp,{recursive:true,force:true})
