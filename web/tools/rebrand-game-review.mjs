import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {launchGpuBrowser,loadChromium,startPreview,stopChild} from './harness.mjs'
const out=new URL('../../.artifacts/rebrand/',import.meta.url);mkdirSync(out,{recursive:true})
const {browser}=await launchGpuBrowser(await loadChromium('rebrand-game'),'rebrand-game')
const preview=await startPreview(8464)
try{
 const p=await browser.newPage({viewport:{width:1512,height:982}})
 await p.addInitScript(()=>{localStorage.setItem('steelthorn-music','off');localStorage.setItem('steelthorn-music-vol','37')})
 const bad=[];p.on('response',r=>{if(r.status()>=400)bad.push([r.status(),r.url()])})
 await p.route('**/api/matches',r=>r.fulfill({status:200,contentType:'application/json',body:'{}'}))
 await p.goto(preview.baseUrl+'?devmap=1&manual=1&seed=first-playable-ux-v1',{waitUntil:'domcontentloaded'})
 await p.waitForFunction(()=>!!globalThis.steelseed,undefined,{timeout:180000})
 await p.waitForFunction(()=>document.getElementById('boot').hidden,undefined,{timeout:30000})
 const beforeCss=readFileSync(new URL('game-before.html',out),'utf8').match(/<style>([\s\S]*?)<\/style>/)[1]
 for(const width of [1512,900]){
  await p.setViewportSize({width,height:982})
  await p.screenshot({path:new URL(`game-${width}-after.png`,out).pathname,animations:'disabled'})
  await p.evaluate(css=>{const s=document.createElement('style');s.id='baseline-css';s.textContent=css;document.head.append(s)},beforeCss)
  await p.screenshot({path:new URL(`game-${width}-before.png`,out).pathname,animations:'disabled'})
  await p.evaluate(()=>document.getElementById('baseline-css').remove())
 }
 await p.setViewportSize({width:1512,height:982})
 await p.click('#session-start')
 await p.evaluate(()=>{const app=globalThis.steelseed;app.stop();for(let i=0;i<12;i++)app.renderOneFrame(i*1000/60)})
 const daylightStates=[]
 await p.evaluate(()=>{globalThis.steelseed.bridge.pollSnapshot=()=>null})
 for(const phase of ['day','night']) {
  daylightStates.push(await p.evaluate(phase=>{const app=globalThis.steelseed,sky=app.ctx.get('sky');app.ctx.snapshot.world.environment.timeOfDay=phase==='day'?720:0;sky.onSnapshot(app.ctx.snapshot,null,app.ctx);for(let i=0;i<120;i++)app.renderOneFrame((phase==='day'?3000:6000)+i*1000/60);return {phase,timeOfDay:sky.timeOfDay}},phase))
  await p.screenshot({path:new URL(`match-${phase}-after.png`,out).pathname,animations:'disabled'})
 }
 const healthStates=[]
 for(const health of [255,120,40]) {
  healthStates.push(await p.evaluate(health=>{const a=globalThis.steelseed,s=a.ctx.snapshot,u=a.ctx.get('ui');s.actors.health[0]=health;u.selection.length=0;u.selection.push(s.actors.id[0]);u.onSnapshot(s,null,a.ctx);return {health,fill:document.querySelector('#hud-health > i').style.background}},health))
  await p.screenshot({path:new URL(`health-${health}-after.png`,out).pathname,animations:'disabled'})
 }
 await p.click('#hud-menu')
 await p.screenshot({path:new URL('pause-after.png',out).pathname,animations:'disabled'})
 await p.click('#menu-resume')
 await p.evaluate(()=>{const a=globalThis.steelseed,s=a.ctx.snapshot;s.flags|=1<<3;const p=s.players.find(x=>(x.flags&(1<<1))!==0)??s.players[0];p.flags|=1<<3;a.ctx.get('ui').onSnapshot(s,null,a.ctx)})
 await p.screenshot({path:new URL('results-after.png',out).pathname,animations:'disabled'})
 const report=await p.evaluate(()=>({title:document.title,oldBrand:/steelthorn/i.test(document.body.innerText),palette:['brand','active','healthy','warning','critical'].map(k=>[k,getComputedStyle(document.documentElement).getPropertyValue('--'+k)]),dropped:globalThis.steelseed.ctx.get('units').droppedSlots??[]}))
 writeFileSync(new URL('game-review.json',out),JSON.stringify({...report,daylightStates,healthStates,httpErrors:bad},null,2))
 console.log(report,bad)
}finally{await browser.close();await stopChild(preview.server)}
