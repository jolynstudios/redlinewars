import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({stdin:{contents:"export * from './src/core/tactical/model'; export * from './src/core/tactical/commands'; export * from './src/core/tactical/transport';export * from './src/core/tactical/vision'",resolveDir:new URL('../',import.meta.url).pathname,loader:'ts'},platform:'node',bundle:true,format:'esm',write:false});
const {TacticalModel,validateIntent,executeIntent,encodeFrame,decodeFrame,resolveVision} = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
function fixture() {
 const visibility=Array(100).fill(2);visibility[99]=0;
 const actors={count:5,id:[1,2,3,4,5],owner:[0,1,2,3,0],typeId:[0,1,2,1,1],displayTypeId:[0,1,1,1,1],flags:[0,0,0,0,8],health:[255,255,255,255,255],posX:[2,2,3,4,5].map(x=>x*1024),posY:[2,3,3,3,3].map(y=>y*1024)};
 const snap={world:{boundsLeft:0,boundsTop:0,boundsRight:10,boundsBottom:10,renderPlayer:0},tick:1,gameTimeMs:1000,flags:0,actors,players:[{relation:0},{relation:1},{relation:2},{relation:3}],terrainStatic:{w:10,h:10,surface:Array(100).fill(4),height:Array(100).fill(2)}};
 const units={semanticRole:n=>n==='base'?'barracks':'soldier',displayName:n=>n};
 const orders=[];const ctx={snapshot:snap,get:()=>units,peek:()=>({stateAt:(x,y)=>visibility[y*10+x]??0}),actorTypeName:id=>['base','soldier','secret-hero'][id],supportPowers:()=>({powers:[{key:'Airstrike',title:'Airstrike',ready:true,active:true,remainingTicks:0,totalTicks:100}]}),issueOrder:async o=>{orders.push(o);return 'ok'}};
 return {ctx,snap,visibility,orders};
}
test('projection hides unknown terrain, enemy health/identity and husks; heat only records observed enemy movement once per tick',()=>{
 const f=fixture(),model=new TacticalModel();const a=model.project(f.ctx,new Map(),'session',1);assert.equal(a.terrain[99],0);assert.equal(a.heights[99],0);assert.equal(a.counts.infantry,0);assert.equal(a.contacts.find(c=>c.id===3).label,'soldier');assert.equal(a.contacts.find(c=>c.id===3).health,undefined);assert.equal(a.contacts.some(c=>c.id===5),false);assert.equal(a.heat.length,0);
 f.snap.tick++;f.snap.gameTimeMs+=1000;f.snap.actors.posX[1]+=1024;f.snap.actors.posX[2]+=1024;f.snap.actors.posX[3]+=1024;
 const b=model.project(f.ctx,new Map(),'session',2);assert.equal(b.heat.length,1);assert.equal(b.heat[0].value,.25);assert.equal(model.project(f.ctx,new Map(),'session',3).heat[0].value,.25);
 f.visibility[34]=1;assert.equal(model.project(f.ctx,new Map(),'session',4).heat.length,0);f.snap.actors.count=2;f.snap.tick++;model.project(f.ctx,new Map(),'session',5);f.snap.actors.count=5;f.snap.actors.posX[2]+=1024;f.snap.tick++;assert.equal(model.project(f.ctx,new Map(),'session',6).heat.filter(h=>h.x===5).length,0);
});
test('commands require current owned groups, visible targets, allowed tiers and ready support; support stays player-level',async()=>{
 const f=fixture(),model=new TacticalModel(),state=model.project(f.ctx,new Map([[1,[1,3,5]]]),'session',20);assert.deepEqual(state.groups[0].members,[1]);const intent={id:'abc',session:'session',sequence:20,action:'move',group:1,revision:'1',x:3,y:4};assert.equal(validateIntent(intent,state,'command'),null);assert.ok(validateIntent(intent,state,'support'));assert.ok(validateIntent({...intent,revision:'3'},state,'command'));assert.ok(validateIntent({...intent,action:'attack',target:99},state,'command'));assert.ok(validateIntent({...intent,x:12},state,'command'));assert.ok(validateIntent({...intent,sequence:-1},state,'command'));assert.ok(validateIntent({...intent,action:'StartProduction'},state,'command'));
 const power={id:'power',session:'session',sequence:20,action:'support',power:'Airstrike',x:3,y:4};assert.equal(await executeIntent(f.ctx,power,state,'support'),'ok');assert.equal(f.orders[0].subjectCount,0);assert.equal(f.orders[0].extraData,0xffffffff);assert.equal(f.orders[0].origin,'companion');
});
test('packed map baselines and patches reconstruct safe state and reject a missing predecessor',()=>{
 const f=fixture(),model=new TacticalModel(),a=model.project(f.ctx,new Map(),'session',1),baseline=encodeFrame(a,null);assert.deepEqual(decodeFrame(baseline,null),a);f.visibility[99]=2;f.snap.tick++;const b=model.project(f.ctx,new Map(),'session',2),patch=encodeFrame(b,a);assert.equal(patch.grid,undefined);assert.equal(patch.cells.length,4);assert.deepEqual(decodeFrame(patch,a),b);assert.equal(decodeFrame(patch,null),null);assert.ok(JSON.stringify(patch).length<JSON.stringify(b).length);
});

test('owned inventory includes cargo and entry alerts only follow visible hostile contacts',()=>{
 const f=fixture();f.ctx.supportPowers=()=>({powers:[],inventory:{infantry:9,vehicles:3,aircraft:2,harvesters:1}});const model=new TacticalModel(),a=model.project(f.ctx,new Map(),'session',1);assert.equal(a.counts.infantry,9);assert.equal(a.alerts.length,1);f.snap.tick++;f.snap.gameTimeMs+=1000;assert.equal(model.project(f.ctx,new Map(),'session',2).alerts.length,1);f.visibility[33]=1;assert.equal(model.project(f.ctx,new Map(),'session',3).alerts.length,0);
});
test('malformed map frames fail closed and dense changes use a new baseline',()=>{
 const f=fixture(),model=new TacticalModel(),a=model.project(f.ctx,new Map(),'session',1);const baseline=encodeFrame(a,null);assert.equal(decodeFrame({...baseline,grid:'!'},null),null);assert.equal(decodeFrame({...baseline,sequence:-1},null),null);assert.equal(decodeFrame({...baseline,bounds:{...a.bounds,w:-10,h:-10}},null),null);const b={...a,sequence:2,terrain:a.terrain.map(()=>8)};assert.ok(encodeFrame(b,a).grid);assert.equal(decodeFrame({...encodeFrame({...a,sequence:2},a),cells:[0,4,0,9]},a),null);
});

test('automatic vision follows game lighting and manual styles remain explicit',()=>{assert.equal(resolveVision({lighting:{timeOfDay:720,night:false}}),'day');assert.equal(resolveVision({lighting:{timeOfDay:120,night:true}}),'white');assert.equal(resolveVision({lighting:{timeOfDay:120,night:true}},'auto','green'),'green');assert.equal(resolveVision({lighting:{timeOfDay:720,night:false}},'green'),'green')});
test('unit-only transport updates retain terrain cache identities and known terrain stays present',()=>{const f=fixture(),a=new TacticalModel().project(f.ctx,new Map(),'session',1);assert.equal(a.terrain[0],4);assert.equal(a.heights[0],2);const baseline=decodeFrame(encodeFrame(a,null),null),next={...a,sequence:2,contacts:a.contacts.map(c=>({...c,x:c.x+.1}))},decoded=decodeFrame(encodeFrame(next,a),baseline);assert.equal(decoded.terrain,baseline.terrain);assert.equal(decoded.visibility,baseline.visibility);assert.notEqual(decoded.contacts,baseline.contacts)});

test('a falling hull marks the building under attack, names it in the alerts, and recovers',()=>{
 const f=fixture(),model=new TacticalModel();
 const first=model.project(f.ctx,new Map(),'session',1);assert.equal(first.contacts.find(c=>c.id===1).underAttack,undefined);assert.equal(first.alerts.some(a=>a.label==='base under attack'),false);
 f.snap.tick++;f.snap.gameTimeMs+=500;f.snap.actors.health[0]=200;
 const hit=model.project(f.ctx,new Map(),'session',2);assert.equal(hit.contacts.find(c=>c.id===1).underAttack,true);assert.ok(hit.alerts.some(a=>a.label==='base under attack'&&a.x===2&&a.y===2));
 f.snap.tick++;f.snap.gameTimeMs+=5000;f.snap.actors.health[0]=195;
 const still=model.project(f.ctx,new Map(),'session',3);assert.equal(still.contacts.find(c=>c.id===1).underAttack,true);assert.equal(still.alerts.filter(a=>a.label==='base under attack').length,1);
 f.snap.tick++;f.snap.gameTimeMs+=14500;
 const calm=model.project(f.ctx,new Map(),'session',4);assert.equal(calm.contacts.find(c=>c.id===1).underAttack,undefined);
 f.snap.tick++;f.snap.gameTimeMs+=11000;assert.equal(model.project(f.ctx,new Map(),'session',5).alerts.filter(a=>a.label==='base under attack').length,0);
});
test('the ended state carries the render player\'s result',()=>{
 const f=fixture(),model=new TacticalModel();f.snap.flags=8;f.snap.players[0].flags=1<<4;
 assert.deepEqual([model.project(f.ctx,new Map(),'s',1).ended,model.project(f.ctx,new Map(),'s',1).outcome],[true,'defeat']);
 f.snap.players[0].flags=1<<3;assert.equal(model.project(f.ctx,new Map(),'s',2).outcome,'victory');
 f.snap.players[0].flags=0;assert.equal(model.project(f.ctx,new Map(),'s',3).outcome,'concluded');
});
test('repair intents aim at one owned damaged structure and issue the game\'s own order',async()=>{
 const f=fixture(),model=new TacticalModel(),state=model.project(f.ctx,new Map(),'session',20);
 const intact={id:'r1',session:'session',sequence:20,action:'repair',target:1};
 assert.equal(validateIntent(intact,state,'command'),'Building is undamaged');
 assert.equal(validateIntent({...intact,target:2},state,'command'),'Building is no longer standing');
 f.snap.tick++;f.snap.gameTimeMs+=500;f.snap.actors.health[0]=200;
 const damaged=model.project(f.ctx,new Map(),'session',21);
 assert.equal(validateIntent({...intact,sequence:21},damaged,'command'),null);
 assert.equal(validateIntent({...intact,sequence:21},damaged,'support'),null);
 assert.equal(await executeIntent(f.ctx,{...intact,sequence:21},damaged,'support'),'ok');
 const order=f.orders.at(-1);assert.equal(order.orderString,'RepairBuilding');assert.equal(order.targetActorId,1);assert.equal(order.subjectIds.length,0);assert.equal(order.origin,'companion');
});
