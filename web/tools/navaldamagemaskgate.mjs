import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {build} from 'esbuild'
const root=new URL('../..',import.meta.url).pathname,folder=root+'/.artifacts/planx/naval/promotion/damage-states/dd/',manifest=JSON.parse(readFileSync(folder+'manifest.json'))
globalThis.location={search:''};globalThis.GPUTextureUsage={TEXTURE_BINDING:1,COPY_DST:2};globalThis.GPUBufferUsage={UNIFORM:1,COPY_DST:2}
let current=structuredClone(manifest);globalThis.__navalMaskGlob=path=>path.includes('blender/manifest')?{roster:{assets:{dd:{sourceSha256:manifest.parentSourceSha256}}}}:path.includes('manifest.json')?{'../../.forge/damage-states/dd/manifest.json':current}:Object.fromEntries(manifest.states.map(e=>['../../.forge/damage-states/dd/'+e.detailMask.file,folder+e.detailMask.file]))
globalThis.fetch=async path=>new Response(readFileSync(path))
const bundle=await build({entryPoints:[root+'/web/src/materials/damage-masks.ts'],bundle:true,format:'esm',write:false,define:{'import.meta.glob':'globalThis.__navalMaskGlob'},logLevel:'silent'});writeFileSync(root+'/.artifacts/planx/naval/damage-mask-bundle.mjs',bundle.outputFiles[0].text)
const {buildDamageMasks,validateDamageMask}=await import(root+'/.artifacts/planx/naval/damage-mask-bundle.mjs')
let textureCount=0,textureDisposals=0,bufferCount=0,bufferDisposals=0,uploaded=0
const shared={createView:()=>({}),destroy:()=>{throw Error('Shared parent array disposed')}},base={id:'industrial-v1',albedo:shared,normal:shared,orm:shared,mask:shared,layerCount:29,size:256,mipCount:9,tileMeters:.5,heightRange:.01}
const device={createTexture:()=>{textureCount++;return{createView:()=>({}),destroy:()=>textureDisposals++}},createBuffer:()=>{bufferCount++;return{destroy:()=>bufferDisposals++}},queue:{writeTexture:(_,p)=>uploaded+=p.byteLength,writeBuffer:()=>{}}}
const evidence=[]
for(const size of[128,256]){const before=uploaded,sets=await buildDamageMasks(device,base,size);assert.equal(sets.length,5);const bytes=sets.reduce((n,s)=>n+s.vramBytes,0);assert.equal(bytes,uploaded-before);assert.equal(bytes,size===128?436900:1747620);for(const[s,e]of sets.map((s,i)=>[s,manifest.states[i]])){assert.equal(s.sourceSha256,e.sourceSha256);assert.equal(s.albedo,shared);s.dispose()}evidence.push({size,bytes,masks:sets.length})}
assert.equal(textureDisposals,textureCount);assert.equal(bufferDisposals,bufferCount)
for(const patch of[{size:128},{sourceSha256:'f'.repeat(64)},{sha256:'bad'},{bytes:1},{file:'../wrong.gz'},{channels:'rgba'}])assert.throws(()=>validateDamageMask('dd',{...manifest.states[0],detailMask:{...manifest.states[0].detailMask,...patch}},base.id))
assert.equal(validateDamageMask('dd',{...manifest.states[0],detailMask:undefined},base.id),null)
const bad=manifest.states[1].detailMask,originalHash=bad.sha256;bad.sha256='0'.repeat(64);current.states[1].detailMask.sha256=bad.sha256
await assert.rejects(()=>buildDamageMasks(device,base,128),/SHA-256 mismatch/);bad.sha256=originalHash
assert.equal(textureDisposals,textureCount,'partial mask loads dispose prior textures');assert.equal(bufferDisposals,bufferCount)
writeFileSync(root+'/.artifacts/planx/naval/damage-mask-gate.json',JSON.stringify({passed:true,evidence,compressedBytes:manifest.states.reduce((n,e)=>n+e.detailMask.storedBytes,0),textureCount,textureDisposals,bufferCount,bufferDisposals,negativeHash:true,invalidMetadata:true,parentArraysShared:true},null,2));console.log('navaldamagemaskgate PASS',evidence)
