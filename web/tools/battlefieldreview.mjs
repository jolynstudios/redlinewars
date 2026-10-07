#!/usr/bin/env node
// Actual OpenRA match, using supported explored/fog options. No snapshot/actor mutation.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchGpuBrowser, loadChromium, WEB_ROOT } from './harness.mjs'
import { configFor } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'

const base=process.argv.find(a=>a.startsWith('--url='))?.slice(6)??'http://127.0.0.1:8321/steelseed/index.html'
const out=join(WEB_ROOT,'.artifacts/living-battlefield')
mkdirSync(out,{recursive:true})
const {browser}=await launchGpuBrowser(await loadChromium('battlefieldreview'),'battlefieldreview')
try {
 const page=await browser.newPage({viewport:{width:1512,height:982},deviceScaleFactor:1})
 const errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 await page.goto(`${base}?mode=game&platform=null&quality=high&weather=clear`,{waitUntil:'domcontentloaded'})
 await page.waitForFunction(()=>globalThis.steelseed?.ctx.session.available,undefined,{timeout:180000,polling:100})
 const catalog=await page.evaluate(()=>steelseed.ctx.session.getCatalog())
 const map=catalog.maps.find(m=>m.title==='Marigold Town')??catalog.maps[0]
 const config=configFor(catalog,map,{withBot:true})
 config.options.startingunits='heavy';config.options.explored='True';config.options.fog='False'
 await page.evaluate(c=>steelseed.ctx.session.startSkirmish(c),config)
 await page.waitForFunction(()=>steelseed.ctx.snapshot?.actors?.count>0&&document.getElementById('session-ui').hidden,
  undefined,{timeout:180000,polling:100})
 const views=[]
 for(const [label,yaw,height] of [['battlefield-near',.4,10],['battlefield-overview',1.2,25]]) {
  await page.evaluate(({yaw,height})=>{
   const ctx=steelseed.ctx,cam=ctx.get('camera'),a=ctx.snapshot.actors
   let x=0,z=0,n=0
   for(let i=0;i<a.count;i++)if(a.owner[i]===ctx.snapshot.world.renderPlayer){x+=a.posX[i]/1024;z+=a.posY[i]/1024;n++}
   if(!n)throw new Error('no local army to frame')
   cam.focusWorld(x/n,z/n);cam.height=cam.heightGoal=height;cam.yaw=cam.yawGoal=yaw
  },{yaw,height})
  await page.waitForTimeout(2000)
  const stats=await page.evaluate(()=>{
   const ctx=steelseed.ctx
   return {tick:ctx.snapshot.tick,actors:ctx.snapshot.actors.count,forge:ctx.get('units').forgeStats,
    camera:Array.from(ctx.get('camera').target),draws:ctx.get('render').stats.drawCalls,triangles:ctx.get('render').stats.triangles}
  })
  assert.ok(stats.forge.available>0,'forge manifest must be present')
assert.equal(stats.forge.loaded,stats.forge.available,'every non-hidden authored model must load, however many the local .forge carries');assert.equal(stats.forge.fallback,0)
  await page.screenshot({path:join(out,`${label}.png`)})
  views.push({label,...stats})
 }
 assert.deepEqual(errors,[])
 assert.ok(views[1].tick>views[0].tick,'authoritative simulation must progress during captures')
 const report={map:map.title,options:config.options,views,note:'Actual match with supported explored=True/fog=False options; visual review, not a performance benchmark.'}
 writeFileSync(join(out,'battlefield-review.json'),JSON.stringify(report,null,2))
 console.log('battlefieldreview: PASS',JSON.stringify(report))
} finally {await browser.close()}
