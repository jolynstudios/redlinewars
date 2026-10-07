import { chromium } from 'playwright'
import { spawnProcessGroup, stopProcessGroup } from './process-group.mjs'
const WEB = new URL('..', import.meta.url).pathname
const PORT = 8791
const server = spawnProcessGroup('npm',['exec','vite','preview','--','--host','127.0.0.1','--port',String(PORT),'--strictPort'],{cwd:WEB,stdio:['ignore','pipe','pipe']})
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
for(let i=0;i<60;i++){try{if((await fetch(`http://127.0.0.1:${PORT}/index.html`)).ok)break}catch{} await sleep(250)}
const b=await chromium.launch({args:['--enable-unsafe-webgpu','--use-angle=metal']})
const p=await (await b.newContext({viewport:{width:1512,height:982},deviceScaleFactor:2})).newPage()
await p.addInitScript(() => {
  const nativeRaf = globalThis.requestAnimationFrame.bind(globalThis)
  let nextId = 1; const pending = new Set()
  globalThis.requestAnimationFrame = () => { const id = nextId++; pending.add(id); return id }
  globalThis.cancelAnimationFrame = id => pending.delete(id)
  globalThis.__steelseedProfileRestoreRaf = () => { globalThis.requestAnimationFrame = nativeRaf; pending.clear() }
})
p.on('pageerror',e=>console.log('PAGEERROR:',e.message))
p.on('console',m=>{ if(m.type()==='error'||/units|boot|fail/i.test(m.text())) console.log('['+m.type()+']',m.text().slice(0,300)) })
await p.goto(`http://127.0.0.1:${PORT}/index.html?devmap=1&seed=demo&devsize=96&quality=high`,{waitUntil:'load',timeout:60000})
await sleep(20000)
console.log('steelseed defined:', await p.evaluate(()=>globalThis.steelseed!==undefined))
console.log('boot-fail:', await p.evaluate(()=>{const e=document.getElementById('boot-fail');return e?{hidden:e.hidden,text:(e.textContent||'').slice(0,300)}:null}))
await b.close(); stopProcessGroup(server)
