#!/usr/bin/env node
// Real shared AppBundle, native WASM world, primary UI, phone and control service.
import {spawn} from 'node:child_process';
import http from 'node:http';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {launchGpuBrowser,loadChromium} from './harness.mjs';
import {createCompanionService} from '../../engine/steelseed-host/tools/companion-service.mjs';
const root=new URL('../../',import.meta.url).pathname;
const service=createCompanionService({enabled:true,originAllowed:()=>true});
const relay=http.createServer();relay.on('upgrade',(req,socket,head)=>service.upgrade(req,socket,head));await new Promise(r=>relay.listen(0,'127.0.0.1',r));
const relayOrigin=`http://127.0.0.1:${relay.address().port}`;
const server=spawn(process.execPath,[`${root}engine/OpenRA.Browser/tests/server.mjs`,'--port','5323','--root',`${root}engine/bin-browser/AppBundle`],{cwd:root,stdio:'pipe'});
let browser;const errors=[];
try{
 for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:5323/steelseed/index.html')).ok)break}catch{};await new Promise(r=>setTimeout(r,100))}
 ({browser}=await launchGpuBrowser(await loadChromium('joa-gamegate'),'joa-gamegate'));
 const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block'});await context.route('**/net-config.json',r=>r.fulfill({json:{schema:1,browserMultiplayer:'off',companionEnabled:true,companionOrigin:relayOrigin}}));
 const main=await context.newPage();main.on('pageerror',e=>errors.push(e.message));await main.goto('http://127.0.0.1:5323/steelseed/index.html?quality=low&mode=game');await main.waitForFunction(()=>globalThis.steelseed&&globalThis.steelseedBridge?.getSkirmishCatalog(),{timeout:120000});
 const start=await main.evaluate(async()=>{const bridge=globalThis.steelseedBridge,c=await bridge.getSkirmishCatalog(),m=c.maps.find(m=>m.slots.length>=2&&!m.slots[0].locks.faction),local=m.slots[0];const slots=m.slots.map((s,i)=>({slot:s.id,kind:i===0?'human':i===1?'bot':'open',botType:i===1?'normal':'',faction:s.locks.faction?s.defaults.faction:i===0?'england':'russia',color:s.locks.color?s.defaults.color:m.colors[i%m.colors.length],team:0,spawn:s.locks.spawn?s.defaults.spawn:i+1}));return bridge.startSkirmish({schemaVersion:c.schemaVersion,transport:'local',mapUid:m.uid,gameSpeed:c.defaultGameSpeed,randomSeed:104729,local:{slot:local.id,name:'JOA Commander',faction:slots[0].faction,color:slots[0].color,team:0,spawn:slots[0].spawn},slots,options:Object.fromEntries(m.options.filter(o=>o.id!=='gamespeed').map(o=>[o.id,o.defaultValue]))})});assert.equal(start.status,'loading');
 await main.waitForFunction(()=>globalThis.steelseed.ctx.snapshot?.world&&(globalThis.steelseed.ctx.snapshot.flags&16)!==0,{timeout:60000});
 const unit=await main.evaluate(()=>{const ctx=globalThis.steelseed.ctx,s=ctx.snapshot,u=ctx.get('units');for(let i=0;i<s.actors.count;i++)if(s.actors.owner[i]===s.world.renderPlayer&&!u.hasRaTrait(ctx.actorTypeName(s.actors.typeId[i]),'Building')){const id=s.actors.id[i];ctx.get('ui').groupMembers.set(1,[id]);return{id,x:s.actors.posX[i]/1024,y:s.actors.posY[i]/1024}}});assert.ok(unit);
 await main.getByRole('button',{name:'Companion',exact:true}).click();await main.locator('[data-connect]').click();await main.waitForFunction(()=>document.querySelector('[data-code]')?.textContent.length===8);const code=await main.locator('[data-code]').textContent();
 const phone=await context.newPage();await phone.setViewportSize({width:390,height:844});phone.on('pageerror',e=>errors.push(e.message));const results=[];phone.on('websocket',socket=>socket.on('framereceived',event=>{try{const m=JSON.parse(event.payload);if(m.type==='result')results.push(m)}catch{}}));await phone.goto('http://127.0.0.1:5323/steelseed/companion.html');await phone.getByLabel('Eight character pairing code').fill(code);await phone.getByRole('button',{name:'Connect',exact:true}).click();await main.locator('[data-approve]').waitFor({state:'visible'});await main.locator('[data-tier]').selectOption('command');await main.locator('[data-approve]').click();await phone.locator('.joa-connect').waitFor({state:'hidden'});
 await main.waitForFunction(()=>globalThis.steelseed.ctx.get('shroud').visibleCells>0,null,{timeout:60000});await main.evaluate(()=>globalThis.steelseed.ctx.get('sky').setDaylightMode('night'));await phone.waitForFunction(()=>document.body.dataset.vision==='white',null,{timeout:15000});await main.evaluate(()=>globalThis.steelseed.ctx.get('sky').setDaylightMode('day'));await phone.waitForFunction(()=>document.body.dataset.vision==='day',null,{timeout:15000});
 const selection=await main.evaluate(()=>[...globalThis.steelseed.ctx.get('ui').selected]);
 await phone.getByRole('button',{name:'Groups',exact:true}).click();await phone.getByRole('button',{name:'1 · 1',exact:true}).click();const box=await phone.locator('canvas').boundingBox();await phone.mouse.click(box.x+box.width*.5,box.y+box.height*.5);
 for(let i=0;i<50&&!results.length;i++)await new Promise(r=>setTimeout(r,100));assert.equal(results[0]?.status,'submitted',JSON.stringify(results));assert.deepEqual(await main.evaluate(()=>[...globalThis.steelseed.ctx.get('ui').selected]),selection,'companion must preserve primary selection');
 console.log('Map telemetry',await main.evaluate(()=>{const c=globalThis.steelseed.ctx,s=c.snapshot,g=c.get('shroud').grid();return {bounds:s.world,grid:[g.width,g.height,g.originX,g.originY],visible:c.get('shroud').visibleCells,projected:c.get('ui').companion.previous?.visibility.filter(v=>v>0).length,projectedSample:c.get('ui').companion.previous?.terrain.filter(v=>v>0).length,terrain:[s.terrainStatic.w,s.terrainStatic.h]}}));mkdirSync(`${root}web/.artifacts/joa`,{recursive:true});await phone.screenshot({path:`${root}web/.artifacts/joa/live-phone.png`});
 // Since f16aefe0 the pairing console closes itself the moment the device connects;
 // the HUD pill carries the link from there, so there is no close button left to click.
 assert.equal(await main.evaluate(() => document.querySelector('dialog.joa-pair')?.open ?? false), false, 'the pairing dialog must close itself once the device connects');
 await main.keyboard.press('m');await main.screenshot({path:`${root}web/.artifacts/joa/live-game.png`});assert.deepEqual(errors,[]);
 console.log('JOA live game: PASS native WASM world → primary approval → packed player map → phone group command → canonical engine acceptance');
}finally{await browser?.close();service.close();await new Promise(r=>relay.close(r));server.kill();}
