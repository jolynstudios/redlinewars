// Local visual preview only. No game commands or production credentials.
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {createCompanionService} from '../../engine/steelseed-host/tools/companion-service.mjs';
const root=new URL('../',import.meta.url).pathname;
const {WebSocket}=createRequire(new URL('../../engine/package.json',import.meta.url))('ws');
// JOA_PREVIEW_PORT runs a second preview beside one that is already open (default 5319).
const port=Number(process.env.JOA_PREVIEW_PORT||5319),page=`http://127.0.0.1:${port}`;
const service=createCompanionService({enabled:true,originAllowed:origin=>origin===page});
const relay=http.createServer();relay.on('upgrade',(req,socket,head)=>service.upgrade(req,socket,head));await new Promise(r=>relay.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${relay.address().port}`;
const primary=new WebSocket(origin.replace('http:','ws:'),{origin:page});
await new Promise(r=>primary.once('open',r));primary.send(JSON.stringify({type:'create',kind:'skirmish'}));
const created=await new Promise(r=>primary.once('message',b=>r(JSON.parse(b))));
 const size=64*64, state={schema:1,session:created.id,sequence:1,tick:1,time:1000,paused:false,ended:false,bounds:{x:0,y:0,w:64,h:64},terrain:Array.from({length:size},(_,i)=>i%64<12?8:i%64===32?5:4),heights:Array(size).fill(0),visibility:Array.from({length:size},(_,i)=>i%64>54?0:2),contacts:[{id:1,x:24,y:24,role:'barracks',label:'Barracks',relation:'own',color:'#7DB9C8',remembered:false},{id:2,x:27,y:26,role:'soldier',label:'Jackson',relation:'own',color:'#7DB9C8',remembered:false},{id:3,x:35,y:32,role:'tracked-vehicle',label:'Tank',relation:'enemy',color:'#C93630',remembered:false}],counts:{infantry:12,vehicles:6,aircraft:1,harvesters:2},groups:[{id:1,revision:'2',members:[2],x:27,y:26}],aircraft:[],powers:[{key:'Airstrike',title:'Air strike',active:true,ready:true,remainingTicks:0,totalTicks:100}],heat:[{x:35,y:32,value:.8}],alerts:[{id:3,x:35,y:32,time:1000,label:'Hostile contact near your base'}]};
 const visual={...state,sequence:6,lighting:{timeOfDay:720,night:false},contacts:[],heat:[{x:40,y:37,value:1}],alerts:[],groups:[{id:1,revision:'1,2,3',members:[1,2,3],x:35,y:34}],terrain:Array.from({length:size},(_,i)=>{const x=i%64,y=Math.floor(i/64),river=10+Math.sin(y*.09)*4;return x<river?8:x<river+2?9:x===31||y===28?5:x>40&&y<20?1:x>45&&y>38?2:4}),heights:Array.from({length:size},(_,i)=>i%64>40&&Math.floor(i/64)<20?Math.floor((i%64-40)/4):0),production:[{kind:1,label:'Rifle infantry',progress:62,queued:2},{kind:2,label:'Light tank',progress:34,queued:0}]};
 for(let i=0;i<70;i++)visual.contacts.push({id:i+100,x:16+(i*7)%13,y:8+(i*11)%18,role:'tree',label:'Tree',relation:'neutral',color:'#596c40',remembered:false});
 for(let i=0;i<5;i++)visual.contacts.push({id:i+1,x:34+i*2,y:34+i,role:i%2?'soldier':'tracked-vehicle',label:i%2?'Infantry':'Tank',relation:'own',color:'#7DB9C8',remembered:false});
 for(const [id,x,y,role,label,w,h]of [[80,36,25,'factory','Factory',4,3],[81,41,25,'barracks','Barracks',3,2],[82,36,20,'powerplant','Power plant',2,3],[83,40,37,'tracked-vehicle','Tank',1,1]])visual.contacts.push({id,x,y,role,label,footprint:{w,h},relation:id===83?'enemy':'own',color:id===83?'#C93630':'#7DB9C8',remembered:false});

const bundle=await build({stdin:{contents:"export {encodeFrame} from './src/core/tactical/transport'",resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'esm',write:false});
const {encodeFrame}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
visual.alerts=[{id:10000,x:40,y:37,time:1000,label:'Design preview · staged battlefield data'}];
// --fixture=<file>: a real match's projection from tools/joa-fixture.mjs, for designing against real
// terrain. --own-allies shows the allied bot's forces as the viewer's own; --night starts at night.
const fixtureArg=process.argv.find(a=>a.startsWith('--fixture='))?.slice(10);
if(fixtureArg){const {readFileSync}=await import('node:fs');const f=JSON.parse(readFileSync(fixtureArg,'utf8'));
 const H_OFFSET=2,H_SCALE=28;if(f.reliefM)f.heights=f.reliefM.map(m=>Math.max(0,Math.min(255,Math.round((m+H_OFFSET)*H_SCALE))));delete f.reliefM;
 if(process.argv.includes('--own-allies'))for(const c of f.contacts)if(c.relation==='ally'){c.relation='own';c.color='#7DB9C8'}
 const own=f.contacts.filter(c=>c.relation==='own'&&!c.footprint&&c.role!=='tree');
 const group=(id,list)=>list.length?{id,revision:list.map(c=>c.id).join(','),members:list.map(c=>c.id),x:list.reduce((s,c)=>s+c.x,0)/list.length,y:list.reduce((s,c)=>s+c.y,0)/list.length}:null;
 f.groups=[group(1,own.slice(0,6)),group(2,own.slice(6,12)),group(4,own.slice(12,15))].filter(Boolean);
 f.counts={infantry:own.filter(c=>c.role==='soldier').length,vehicles:own.filter(c=>c.role!=='soldier'&&c.role!=='harvester').length,aircraft:0,harvesters:own.filter(c=>c.role==='harvester').length};
 f.powers=[{key:'Airstrike',title:'Air strike',active:true,ready:true,remainingTicks:0,totalTicks:4500},{key:'Paratroopers',title:'Paratroopers',active:true,ready:false,remainingTicks:1700,totalTicks:4500},{key:'NukePowerInfoOrder',title:'Atom bomb',active:true,ready:false,remainingTicks:9800,totalTicks:13500},{key:'Chronoshift',title:'Chronoshift',active:true,ready:true,remainingTicks:0,totalTicks:4500,needsSource:true}];
 const enemies=f.contacts.filter(c=>c.relation==='enemy'&&!c.footprint&&c.role!=='tree');
 f.heat=enemies.slice(0,14).map((c,i)=>({x:Math.floor(c.x),y:Math.floor(c.y),value:.4+(i%4)*.15}));
 f.alerts=enemies.slice(0,2).map((c,i)=>({id:c.id,x:Math.floor(c.x),y:Math.floor(c.y),time:f.time-4000*i,label:i?'Hostile armour near your refinery':'Hostile contact near your base'}));
 f.lighting=process.argv.includes('--night')?{timeOfDay:120,night:true}:{timeOfDay:720,night:false};
 Object.assign(visual,f,{session:created.id,schema:1,paused:false,ended:false})};
let sequence=1,previous=null;const publish=()=>{const next={...visual,sequence:sequence++,time:(visual.time??0)+Date.now()-started,lighting:visual.lighting??{timeOfDay:720,night:false}};primary.send(JSON.stringify({type:'state',state:encodeFrame(next,previous)}));previous=next;primary.send(JSON.stringify({type:'heartbeat'}))};const started=Date.now();
// The trimmed fixture carries no ledger: stage one, so the statistics sheet has its cards.
if(!visual.stats)visual.stats={credits:3120,ore:940,powerDrawn:82,powerSupplied:100,harvesters:2,enemies:{ai:1,human:0,ally:0},score:null,roster:[{label:'Rifle infantry',count:9},{label:'Light tank',count:4},{label:'Ranger',count:3}]};
// --nuke stages the batch 2 visuals: an incoming enemy missile (banner, countdown, alarm flag)
// and one of the commander's own in flight (the impact ring on its target).
if(process.argv.includes('--nuke')){visual.launches=[{id:9001,tick:1,allied:false,imminent:true,secondsLeft:74,targetX:40,targetY:37},{id:9002,tick:1,allied:true,imminent:false,secondsLeft:17,targetX:36,targetY:34}]}
// --tier=information|support|command approves the phone with that permission (default command);
// --accept answers orders as submitted, to walk the phone's flows (nothing is controlled either way).
const tier=process.argv.find(a=>a.startsWith('--tier='))?.slice(7)??'command',accept=process.argv.includes('--accept');
primary.on('message',b=>{const m=JSON.parse(b);if(m.type==='approval')primary.send(JSON.stringify({type:'approve',accept:true,tier}));if(m.type==='intent')primary.send(JSON.stringify(accept?{type:'result',id:m.intent.id,status:'submitted',reason:'ok'}:{type:'result',id:m.intent.id,status:'rejected',reason:'Design preview only — no running match is controlled.'}));if(m.type==='taunt')console.log(`TAUNT ${m.taunt}`);if(m.type==='request')console.log(`ASK ${m.request}`);if(m.type==='need-baseline')previous=null});
const timer=setInterval(publish,200);
// JOA_PREVIEW_CONFIG: another vite config (for example one without hot reload, for a page someone is using).
const vite=spawn(process.execPath,[root+'node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort',...(process.env.JOA_PREVIEW_CONFIG?['--config',process.env.JOA_PREVIEW_CONFIG]:[])],{cwd:root,env:{...process.env,JOA_ORIGIN:origin},stdio:'inherit'});
console.log(`PREVIEW_URL=${page}/companion.html#p=${created.secret}`);console.log(`PREVIEW_CODE=${created.code}`);
const stop=()=>{clearInterval(timer);primary.close();service.close();relay.close();vite.kill();process.exit()};process.on('SIGINT',stop);process.on('SIGTERM',stop);
