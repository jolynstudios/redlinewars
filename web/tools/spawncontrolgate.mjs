// Actual setup clicks, snapshot/draw positions, AI spawn and visible MCV deploy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {loadChromium,launchGpuBrowser} from './harness.mjs';
import {fixtureManifest} from './fixture-manifest.mjs';
const output=process.argv.find(a=>a.startsWith('--out='))?.slice(6) ?? '.artifacts/spawn-ui/';
fs.mkdirSync(output,{recursive:true});
const out=new URL(output.endsWith('/')?output:output+'/',`file://${process.cwd()}/`);
const gameUrl=process.argv.find(a=>a.startsWith('--url='))?.slice(6) ?? 'http://127.0.0.1:8416/steelseed/index.html';
const url=new URL(gameUrl);url.searchParams.set('mode','game');url.searchParams.set('platform','null');url.searchParams.set('quality','dynamic');
const build=await fixtureManifest(new URL('./build.json',url));
const expectedMaps=JSON.parse(fs.readFileSync(new URL('../../engine/steelseed-host/generated/mods/ra/map-catalog.json',import.meta.url),'utf8')).length;
const results=[]; const errors=[]; const river=process.argv.includes('--river'); const prefix=river?'spawn-river':'spawn-agenda';
const {browser}=await launchGpuBrowser(await loadChromium('spawn-live-retest'),'spawn-live-retest');
try {
 for (const humanSpawn of [1,2]) {
  const page=await browser.newPage({viewport:{width:1512,height:982}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url.href, {waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForFunction(n=>document.querySelector('#session-map')?.options.length===n,expectedMaps,{timeout:120000});
  // Catalog readiness precedes hull/shader warmup. Real pointer actions must
  // wait until the loading overlay has left, including its normal fade.
  await page.locator('#boot').waitFor({state:'hidden',timeout:180000});
  if(river) await page.getByRole('combobox',{name:'Map — choose the battlefield',exact:true}).selectOption({label:'River Crossing — STEELSEED · 64×48'});
  await page.getByRole('group',{name:'Player 1 — you',exact:true}).getByRole('combobox',{name:'Faction',exact:true}).selectOption({label:'England'});
  await page.getByRole('group',{name:'Player 1 — you',exact:true}).getByRole('combobox',{name:'Spawn',exact:true}).selectOption({label:String(humanSpawn)});
  await page.getByRole('group',{name:'Player 2',exact:true}).getByRole('combobox',{name:'Faction',exact:true}).selectOption({label:'Russia'});
  await page.getByRole('group',{name:'Player 2',exact:true}).getByRole('combobox',{name:'Spawn',exact:true}).selectOption({label:String(3-humanSpawn)});
  await page.getByRole('button',{name:/03 Match rules/}).click();
  await page.getByRole('radio',{name:'Heavy Support',exact:true}).click();
  await page.getByRole('radio',{name:'Heavy Support',exact:true}).waitFor({state:'visible'});
  assert.equal(await page.getByRole('radio',{name:'Heavy Support',exact:true}).getAttribute('aria-checked'),'true');
  await page.getByRole('radiogroup',{name:'Fog of War',exact:true}).getByRole('radio',{name:'Off',exact:true}).click();
  const config=await page.evaluate(async()=>{
   const c=await globalThis.steelseedBridge.getSkirmishCatalog();const uid=document.querySelector('#session-map').value;const map=c.maps.find(m=>m.uid===uid);
   return {map:map.title,spawns:map.spawnPoints,choices:[...document.querySelectorAll('[data-slot-id]')].map(el=>Object.fromEntries([...el.querySelectorAll('select[data-field]')].map(s=>[s.dataset.field,s.value]))),startingunits:document.querySelector('select[data-field="startingunits"]').value};
  });
  await page.screenshot({path:new URL(`${prefix}-${humanSpawn}-setup.png`,out).pathname});
  await page.getByRole('button',{name:'Start skirmish',exact:true}).click();
  await page.waitForFunction(()=>globalThis.steelseed?.ctx.snapshot?.tick>0 && document.querySelector('#session-ui')?.hidden,{},{timeout:120000});
  const state=await page.evaluate(()=>{
   const a=globalThis.steelseed,s=a.ctx.snapshot,actors=s.actors; const render=a.ctx.get('render').camera.viewProj;
   return {tick:s.tick,renderPlayer:s.world.renderPlayer,players:s.players,world:s.world,camera:Array.from(a.ctx.get('camera').target),actors:Array.from({length:actors.count},(_,i)=>{
    const x=actors.posX[i]/1024,z=actors.posY[i]/1024,y=a.ctx.get('terrain').heightAt(x,z)+.6;const w=render[3]*x+render[7]*y+render[11]*z+render[15];
    const transform=new Float32Array(16),visual={mesh:null,surfaceSet:'',playerColor:0};const captured=a.ctx.get('units').captureActorVisual(actors.id[i],transform,0,visual);
    return {drawn:captured?{x:transform[12],z:transform[14]}:null,id:actors.id[i],type:a.ctx.actorTypeName(actors.typeId[i]),owner:actors.owner[i],x,z,screen:{x:(.5+.5*(render[0]*x+render[4]*y+render[8]*z+render[12])/w)*a.ctx.canvas.clientWidth,y:(.5-.5*(render[1]*x+render[5]*y+render[9]*z+render[13])/w)*a.ctx.canvas.clientHeight}};
   })};
  });
  fs.writeFileSync(new URL(`${prefix}-${humanSpawn}-initial.json`,out),JSON.stringify({humanSpawn,config,state},null,2));
  await page.screenshot({path:new URL(`${prefix}-${humanSpawn}-initial.png`,out).pathname});
  const start=config.spawns.find(s=>s.id===humanSpawn); assert.ok(start);
  const own=state.actors.filter(a=>a.owner===state.renderPlayer);const base=own.find(a=>a.type==='mcv'||a.type==='fact'); assert.ok(base,'human has MCV/yard');
  const dist=a=>Math.hypot(a.x-start.x,a.z-start.y);
  assert.ok(dist(base)<8,`human base is ${dist(base)} cells from selected spawn`);
  const troops=own.filter(a=>a.type!=='mcv'&&a.type!=='fact');assert.ok(troops.length===10,'Heavy Support has exactly the native ten support units');
  assert.ok(troops.every(a=>dist(a)<10),'starting troops share human spawn');
  assert.ok(base.screen.x>0&&base.screen.x<1512&&base.screen.y>0&&base.screen.y<982,'human base visible at match start');
  const enemy=state.players.find(p=>(p.flags&4)!==0);assert.ok(enemy,'AI player exists'); const enemyBase=state.actors.find(a=>a.owner===enemy.id&&(a.type==='mcv'||a.type==='fact'));assert.ok(enemyBase,'AI has base');const enemySpawn=config.spawns.find(s=>s.id===3-humanSpawn);assert.ok(Math.hypot(enemyBase.x-enemySpawn.x,enemyBase.z-enemySpawn.y)<8,'AI base shares assigned opposite spawn'); assert.ok(own.every(a=>!a.drawn||Math.hypot(a.x-a.drawn.x,a.z-a.drawn.z)<4),'rendered human units remain at engine positions');
  const record={humanSpawn,config,state,enemyBase,baseDistance:dist(base),startingTroops:troops.length};results.push(record); console.log(JSON.stringify({humanSpawn,tick:state.tick,base,startingTroops:troops.length,baseDistance:dist(base)}));
  await page.screenshot({path:new URL(`${prefix}-${humanSpawn}-playing.png`,out).pathname});
  if(base.type==='mcv'){
   await page.getByRole('region',{name:'Selection',exact:true}).filter({hasText:'MOBILE CONSTRUCTION VEHICLE'}).waitFor({state:'visible',timeout:10000});
   await page.getByRole('button',{name:'Deploy / expand',exact:true}).click();
   await page.waitForFunction(()=>{const a=globalThis.steelseed,s=a.ctx.snapshot;return Array.from({length:s.actors.count},(_,i)=>i).some(i=>s.actors.owner[i]===s.world.renderPlayer&&a.ctx.actorTypeName(s.actors.typeId[i])==='fact')},{},{timeout:20000});
   record.deployed=await page.evaluate(()=>{const a=globalThis.steelseed,s=a.ctx.snapshot,i=Array.from({length:s.actors.count},(_,i)=>i).find(i=>s.actors.owner[i]===s.world.renderPlayer&&a.ctx.actorTypeName(s.actors.typeId[i])==='fact');return {x:s.actors.posX[i]/1024,z:s.actors.posY[i]/1024,tick:s.tick};});
   assert.ok(Math.hypot(record.deployed.x-base.x,record.deployed.z-base.z)<4,'yard deploys at same base');
   await page.screenshot({path:new URL(`${prefix}-${humanSpawn}-yard.png`,out).pathname});
  }
  await page.close();
 }
 assert.equal(errors.length,0,errors.join('\n'));
 fs.writeFileSync(new URL(`${prefix}-report.json`,out),JSON.stringify({status:'passed',url:gameUrl,simBuild:build.simBuild,cases:results,errors},null,2));
} catch(e){fs.writeFileSync(new URL(`${prefix}-report.json`,out),JSON.stringify({status:'failed',cases:results,errors,error:e.stack},null,2));throw e;} finally{await browser.close();}
