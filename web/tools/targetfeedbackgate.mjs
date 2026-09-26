#!/usr/bin/env node
// Exercise production targeting against visible, non-targetable and hidden actor fixtures.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const temp = mkdtempSync(join(tmpdir(), 'steelseed-target-feedback-'))
try {
 const outfile=join(temp,'ui.mjs')
 await build({stdin:{contents:"export { Ui } from './src/ui/index.ts'; export { actionFeedback } from './src/ui/action-feedback.ts'",resolveDir:resolve(import.meta.dirname,'..'),loader:'ts'},loader:{'.m4a':'text'},bundle:true,platform:'node',format:'esm',outfile,define:{'import.meta.glob':'__gateGlob'},banner:{js:'const __gateGlob = () => ({})'},logLevel:'silent'})
 const {Ui,actionFeedback}=await import(pathToFileURL(outfile))
 globalThis.localStorage={getItem:()=>null,setItem:()=>{}}
 const ui=new Ui(), vp=new Float32Array(16);vp[0]=vp[5]=vp[10]=.1;vp[15]=1
 const names=['e7','e1','e6','spy','barr','t01','powr']
 const traits={e7:['Selectable','Armament'],e1:['Selectable','Armament'],e6:['Selectable'],spy:['Selectable'],barr:['Selectable','Targetable','Health','Building'],t01:[],powr:['Selectable','Targetable','Health','Building']}
 const actors={count:4,id:Uint32Array.of(10,20,30,40),typeId:Uint16Array.of(0,4,5,6),owner:Uint8Array.of(0,1,255,0),posX:Int32Array.of(-6144,0,0,6144),posY:new Int32Array(4),posZ:new Int32Array(4),health:Uint8Array.of(255,255,255,255)}
 let hidden=false, queries=0, answer={order:'C4',cursor:'c4'}
 const units={hasRaTrait:(n,t)=>traits[n]?.includes(t)??false,selectionRadiusM:()=>.5,selectionHeightM:()=>1,movementClass:()=> 'infantry',groupSelectable:()=>true,
  captureActorVisual(id,m,_offset,out){if(hidden&&id===20)return false;const i=[10,20,30,40].indexOf(id);m.fill(0);m[0]=m[5]=m[10]=m[15]=1;m[12]=actors.posX[i]/1024;out.mesh={aabbMin:[-.5,0,-.5],aabbMax:[.5,1,.5]};return true}}
 const pointer={x:500,y:475,pressed:0,released:0,buttons:0,inside:true}
 const camera={pickGroundCell:()=>({x:0,y:0}),pickGroundPoint:()=>({x:0,y:0,z:0}),selectActors:()=>{}}
 const orders=[], ctx={canvas:{clientWidth:1000,clientHeight:1000},input:{pointer,ctrl:false,shift:false,alt:false},snapshot:{tick:1,actors},actorTypeName:i=>names[i],get:id=>id==='units'?units:camera,
  queryContextOrder:i=>{queries++;return i.targetActorId===20?answer:{order:'Move',cursor:'move'}},issueOrder:o=>orders.push({...o,subjectIds:[...o.subjectIds.slice(0,o.subjectCount)]})}
 Object.assign(ui,{ctx,renderPlayerId:0,render:{camera:{viewProj:vp}},terrain:{heightAt:()=>0},selected:[10]})
 ui.eva={say:()=>{},sayUnit:()=>{},personaOf:()=>undefined,reset:()=>{},stop:()=>{}};ui.showNotice=()=>{};ui.refreshSelectionArmed=()=>{};ui.markOrder=()=>{};ui.selectionCanReach=()=>true
 const intent=ui.pointerContextIntent(ctx,actors,units,0)
 assert.equal(intent.targetActorId,20,'overlapping non-targetable tree cannot steal hit')
 const p0=ui.previewContext(ctx,intent);await Promise.resolve();const p1=ui.previewContext(ctx,intent);assert.equal(p1.order,'C4');assert.equal(queries,1,'stationary hover caches same snapshot')
 for(const [order,cursor,label] of [['C4','c4','C4 · demolish'],['CaptureActor','enter','Capture building'],['Infiltrate','enter','Infiltrate'],['Attack','attack','Attack'],['Heal','heal','Heal'],['Repair','goldwrench','Repair']]) {
  answer={order,cursor};ctx.snapshot.tick++
  Object.assign(pointer,{pressed:1,released:0,buttons:1});ui.updateSelectionInteraction(ctx,actors,units,false)
  const warmIntent=ui.pointerContextIntent(ctx,actors,units,0);ui.previewContext(ctx,warmIntent);await Promise.resolve()
  Object.assign(pointer,{pressed:0,released:1,buttons:0});ui.updateSelectionInteraction(ctx,actors,units,false)
  assert.equal(orders.at(-1).targetActorId,20);assert.deepEqual(ui.selected,[10],'action click keeps own unit selected')
  assert.equal(ui.orderAction.label,label);assert.equal(orders.at(-1).contextual,true)
 }
 assert.equal(orders.length,6,'exactly one order per click')
 answer={order:'Move',cursor:'move'};ctx.snapshot.tick++
 // Mirror the browser's hover frames: warm the async preview before each issue.
 const warm1=ui.pointerContextIntent(ctx,actors,units,0);ui.previewContext(ctx,warm1);await Promise.resolve()
 assert.equal(ui.issuePointerContextOrder(ctx,actors,units,0,true),false);assert.equal(orders.length,6)
 answer={order:'ForceAttack',cursor:'attack'};ctx.snapshot.tick++
 const warm2=ui.pointerContextIntent(ctx,actors,units,1);ui.previewContext(ctx,warm2);await Promise.resolve()
 ui.issuePointerContextOrder(ctx,actors,units,1,false)
 assert.equal(orders.at(-1).modifiers,1)
 // A capture miss keeps the target at its snapshot position (7fd3c64 fallback); fog hides an
 // actor by leaving it out of the shroud-filtered snapshot, so nothing is left to target.
 hidden=true;ctx.snapshot.tick++;assert.equal(ui.pointerContextIntent(ctx,actors,units,0).targetActorId,20,'capture miss keeps the target at its snapshot position')
 hidden=false
 const keep=[0,2,3],pick=(a,T)=>T.from(keep.map(i=>a[i])),fogged={count:3,id:pick(actors.id,Uint32Array),typeId:pick(actors.typeId,Uint16Array),owner:pick(actors.owner,Uint8Array),posX:pick(actors.posX,Int32Array),posY:pick(actors.posY,Int32Array),posZ:pick(actors.posZ,Int32Array),health:pick(actors.health,Uint8Array)}
 ctx.snapshot.tick++;assert.equal(ui.pointerContextIntent(ctx,fogged,units,0).targetActorId,0,'an actor absent from the snapshot cannot be targeted through fog')
 const dom=()=>({style:{display:'none'},attrs:{},setAttribute(k,v){this.attrs[k]=v}})
 ui.hoverMark=dom();ui.hoverMarkBack=dom();ui.actionHint=dom();ui.placementOverlay=dom();ui.commandCanvas={style:{},dataset:{}}
 answer={order:'Attack',cursor:'attack'};ctx.snapshot.tick++;ui.updateHoverTarget(ctx,actors,units,ui.terrain,ui.render)
 assert.equal(ui.hoverMark.attrs.d,'M-8 0A8 8 0 1 1 8 0A8 8 0 1 1 -8 0M-3 0H3M0-3V3')
 assert.equal(ui.commandCanvas.style.cursor,'none');assert.equal(ui.commandCanvas.dataset.targetAction,'Attack')
 pointer.inside=false;ui.updateHoverTarget(ctx,actors,units,ui.terrain,ui.render)
 assert.equal(ui.hoverMark.style.display,'none');assert.equal(ui.commandCanvas.style.cursor,'')
 assert.equal(actionFeedback({order:'Move',cursor:'move'}),null)
 assert.equal(actionFeedback({order:'CaptureActor',cursor:'enter-blocked'}).actorAction,false)
 // Exercise the production gesture-dispatch block around updateSelectionInteraction.
 // Sell targeting clears its flag during that call; the same right press must still
 // count as cancellation, not fall through to movement/attack afterward.
 const source=readFileSync(resolve(import.meta.dirname,'../src/ui/index.ts'),'utf8')
 const gestureStart=source.indexOf('\t\tconst pointer = ctx.input.pointer\n\t\tconst commandModeWasArmed')
 const gestureEnd=source.indexOf('\n\t\t// --- rings',gestureStart)
 assert.ok(gestureStart>=0&&gestureEnd>gestureStart)
 const dispatch=new Function('ctx','actors','units','placedThisFrame','MODIFIERS_NO_PRESS',source.slice(gestureStart,gestureEnd))
 const beforeCancel=orders.length
 ctx.input.wasPressed=()=>false;pointer.inside=true;pointer.pressed=4;pointer.released=0
 ui.sellMode=true;ui.attackMoveArmed=false;ui.supportPowerArmed=null
 ui.setSellMode=value=>{ui.sellMode=value}
 dispatch.call(ui,ctx,actors,units,false,-1)
 assert.equal(ui.sellMode,false,'right click must leave sell targeting')
 assert.equal(orders.length,beforeCancel,'sell cancellation cannot issue a contextual order')
 // A subsequent unarmed-mode right press still dispatches normally with press modifiers.
 answer={order:'ForceAttack',cursor:'attack'};ctx.snapshot.tick++
 ui.onCanvasPointerDown({button:2,ctrlKey:true,shiftKey:false,altKey:false})
 dispatch.call(ui,ctx,actors,units,false,-1)
 assert.equal(orders.length,beforeCancel+1)
 assert.equal(orders.at(-1).modifiers,1,'pointer press wins after keyboard state was cleared')
 console.log('targetfeedbackgate: PASS — C4/capture/infiltrate/attack/heal/repair clicks preserve selection; single dispatch; no scenery/fog targets; modifiers; sell cancellation; 16px cursor and cleanup')
} finally {rmSync(temp,{recursive:true,force:true})}
