import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { launchGpuBrowser, loadChromium } from './harness.mjs'
const out = new URL('../../.artifacts/rebrand/', import.meta.url)
mkdirSync(out, {recursive:true})
const {browser}=await launchGpuBrowser(await loadChromium('rebrand-review'),'rebrand-review')
const results=[]
try {
 for(const width of [1440,390]) {
  const page=await browser.newPage({viewport:{width,height:900},deviceScaleFactor:1})
  for(const route of ['','play','story','leaderboard']) {
   await page.goto(`http://localhost:8790/${route}`,{waitUntil:'networkidle'})
   await page.locator('body').evaluate(el=>{el.classList.add('loaded');document.querySelectorAll('.reveal').forEach(x=>x.classList.add('is-visible'))})
   await page.screenshot({path:new URL(`${route||'home'}-${width}-after.png`,out).pathname,fullPage:false,animations:'disabled'})
   results.push(await page.evaluate(({route,width})=>({route,width,title:document.title,overflow:document.documentElement.scrollWidth>innerWidth,oldBrand:/steelthorn/i.test(document.body.innerText),overflowElements:[...document.querySelectorAll('main *')].filter(e=>e.getBoundingClientRect().right>innerWidth+2).slice(0,8).map(e=>({tag:e.tagName,cls:e.className,width:e.getBoundingClientRect().width}))}),{route,width}))
  }
  await page.close()
 }
 writeFileSync(new URL('landing-review.json',out),JSON.stringify(results,null,2))
 console.log(results)
} finally {await browser.close()}
