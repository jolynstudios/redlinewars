import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {writeFileSync} from 'node:fs'
import {createServer} from 'node:http'
import {launchGpuBrowser,loadChromium} from './harness.mjs'
const bundle=await build({stdin:{contents:"export {FORWARD_WGSL,FORWARD_BLEND_WGSL,FORWARD_TRANSLUCENT_WGSL,PREPASS_WGSL,SHADOW_WGSL} from './src/render/shaders';export {FORWARD_CUTOUT_WGSL,PREPASS_CUTOUT_WGSL,SHADOW_CUTOUT_WGSL} from './src/render/cutout-shaders';",resolveDir:process.cwd()},bundle:true,format:'esm',write:false,logLevel:'silent'})
writeFileSync('../.artifacts/planx/naval-foam-shader-bundle.mjs',bundle.outputFiles[0].text);const api=await import('../../.artifacts/planx/naval-foam-shader-bundle.mjs')
const server=createServer((q,r)=>r.end('<html></html>'));await new Promise(r=>server.listen(8496,'127.0.0.1',r));let browser
try{({browser}=await launchGpuBrowser(await loadChromium('navalfoamgate'),'navalfoamgate'));const page=await browser.newPage();await page.goto('http://127.0.0.1:8496');const report=await page.evaluate(async sources=>{const a=await navigator.gpu.requestAdapter(),d=await a.requestDevice(),results={};for(const [name,code]of Object.entries(sources)){const m=d.createShaderModule({code});results[name]=(await m.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message)}return results},api);writeFileSync('../.artifacts/planx/naval-foam-shader-gate.json',JSON.stringify(report,null,2));for(const [name,m]of Object.entries(report))assert.deepEqual(m,[],name);console.log('navalfoamgate PASS',Object.keys(report))}finally{await browser?.close();await new Promise(r=>server.close(r))}
