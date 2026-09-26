import {writeFileSync} from 'node:fs'
import {launchGpuBrowser,loadChromium} from './harness.mjs'
const {browser}=await launchGpuBrowser(await loadChromium('rebrand-smoke'),'rebrand-smoke')
const out=new URL('../../.artifacts/rebrand/',import.meta.url)
try{
 const p=await browser.newPage({viewport:{width:1440,height:900}})
 await p.goto('http://localhost:8791/play',{waitUntil:'networkidle'})
 await p.click('[data-quick-guest]')
 await p.locator('[data-start]').waitFor({state:'visible'})
 const callsign=await p.locator('[data-lobby-callsign]').innerText()
 await p.reload({waitUntil:'networkidle'})
 const retained=(await p.locator('[data-lobby-callsign]').innerText())===callsign
 await p.click('[data-start]')
 await p.waitForURL('**/steelseed/**')
 await p.waitForFunction(()=>globalThis.steelseed?.ctx.session.available,undefined,{timeout:180000})
 await p.waitForFunction(()=>document.getElementById('boot').hidden,undefined,{timeout:30000})
 await p.screenshot({path:new URL('composed-lobby-after.png',out).pathname,animations:'disabled'})
 await p.click('#session-tab-mp')
 await p.screenshot({path:new URL('multiplayer-after.png',out).pathname,animations:'disabled'})
 const result={callsign,retained,url:p.url(),multiplayerName:await p.locator('#session-mp-name').inputValue()}
 await p.goto('http://localhost:8791/leaderboard',{waitUntil:'networkidle'})
 result.leaderboardVisible=await p.locator('main').innerText()
 writeFileSync(new URL('smoke.json',out),JSON.stringify(result,null,2));console.log(result)
}finally{await browser.close()}
