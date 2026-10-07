#!/usr/bin/env node
// Isolated GPU numerical/compilation gate; never builds or reloads the shared game.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { WEB_ROOT, launchGpuBrowser, loadChromium } from './harness.mjs'

const compiled = await build({ stdin: { contents: `
export { TERRAIN_MACRO_WGSL } from './src/render/terrain-macro.ts';
export { FORWARD_BLEND_WGSL, FORWARD_WGSL } from './src/render/shaders.ts';`, resolveDir: WEB_ROOT, loader: 'ts' },
 bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
assert.ok(api.FORWARD_BLEND_WGSL.includes('terrainMacroAlbedo(blendedAlbedo.rgb, vin.worldPos.xz, macroStrength)'))
assert.ok(!api.FORWARD_WGSL.includes('terrainMacro'), 'Actor pipeline must not acquire terrain variation')
assert.ok(!/frame\.|textureSample|sin\(/.test(api.TERRAIN_MACRO_WGSL), 'Macro field must not depend on time, extra textures or sine hashes')
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>terrain macro GPU gate</title>') })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
 ({ browser } = await launchGpuBrowser(await loadChromium('terrainmacrogate'), 'terrainmacrogate'))
 const page = await browser.newPage()
 await page.goto(`http://127.0.0.1:${server.address().port}/`)
 const report = await page.evaluate(async ({ macro, forward }) => {
  const adapter = await navigator.gpu.requestAdapter(); if (!adapter) throw Error('WebGPU adapter unavailable')
  const device = await adapter.requestDevice(), errors = []
  device.addEventListener('uncapturederror', e => errors.push(e.error.message))
  const resources = []
  try {
   const main = device.createShaderModule({ code: forward })
   const messages = (await main.getCompilationInfo()).messages.filter(m => m.type === 'error')
   if (messages.length) throw Error(messages.map(m => m.message).join('\n'))
   const points = []
   // Negative map bounds, integer cell/chunk boundaries, full repeats of 4m textures.
   for (let z = -64; z <= 64; z += 2) for (let x = -64; x <= 64; x += 2) points.push(x, z, 0, 0)
   const broadCount = points.length / 4, seams = []
   for (const x of [-64, -53, -32, -18, -16, 0, 16, 18, 32, 53, 64]) {
    seams.push(points.length / 4); points.push(x - .001, 7, 0, 0, x + .001, 7, 0, 0)
   }
   const count = points.length / 4, bytes = count * 16
   const make = (size, usage) => { const b = device.createBuffer({ size, usage }); resources.push(b); return b }
   const input = make(bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
   const output = make(bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
   const readback = make(bytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
   device.queue.writeBuffer(input, 0, Float32Array.from(points))
   const module = device.createShaderModule({ code: macro + `
@group(0) @binding(0) var<storage,read> points:array<vec4<f32>>;
@group(0) @binding(1) var<storage,read_write> values:array<vec4<f32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id:vec3<u32>) {
 if(id.x>=arrayLength(&points)){return;}
 let p=points[id.x].xy;
 let grass=terrainMacroAlbedo(vec3<f32>(0.3),p,terrainMacroStrength(4u));
 let road=terrainMacroAlbedo(vec3<f32>(0.005),p,terrainMacroStrength(5u));
 let snow=terrainMacroAlbedo(vec3<f32>(0.3),p,terrainMacroStrength(10u));
 values[id.x]=vec4<f32>(terrainMacroField(p),grass.r,road.r,snow.r);
}` })
   const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } })
   const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: input } }, { binding: 1, resource: { buffer: output } }] })
   const sample = async () => {
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass()
    pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(Math.ceil(count / 64)); pass.end()
    encoder.copyBufferToBuffer(output, 0, readback, 0, bytes); device.queue.submit([encoder.finish()])
    await readback.mapAsync(GPUMapMode.READ)
    const values = new Float32Array(readback.getMappedRange().slice(0)); readback.unmap(); return values
   }
   const a = await sample(), b = await sample()
   let lo = 1, hi = -1, maxSeam = 0, repeated = 0, variation = 0
   for (let i = 0; i < count; i++) {
    for (let c = 0; c < 4; c++) if (!Number.isFinite(a[i * 4 + c]) || a[i * 4 + c] !== b[i * 4 + c]) throw Error('Nonfinite or nondeterministic field')
    const field = a[i * 4], grass = a[i * 4 + 1], road = a[i * 4 + 2], snow = a[i * 4 + 3]
    // Strength pins track the product's current per-surface table (grass .38, snow .06;
    // recalibrated from .28/.04 when the surface palette was re-tuned). The normalised
    // deviations must still be the SAME field, independently bounded.
    if (field < -1 || field > 1 || grass < .186 || grass > .414) throw Error('Macro variation out of bounds')
    if (Math.abs(road - .005) > 1e-8) throw Error('Manufactured surface was changed/clamped')
    if (Math.abs((grass - .3) / .114 - (snow - .3) / .018) > 2e-6) throw Error('Snow strength not bounded independently')
    if (i < broadCount) { lo = Math.min(lo, field); hi = Math.max(hi, field) }
    if (i < broadCount && i % 65 < 63) { repeated++; variation += Math.abs(a[i * 4] - a[(i + 2) * 4]) }
   }
   for (const i of seams) maxSeam = Math.max(maxSeam, Math.abs(a[i * 4] - a[(i + 1) * 4]))
   if (maxSeam > .001) throw Error('Discontinuity at terrain/chunk boundary')
   if (hi - lo < .6 || variation / repeated < .02) throw Error('Field is flat or repeats with ground tile')
   if (errors.length) throw Error(errors.join('\n'))
   return { points: count, fieldRange: [lo, hi], maxSeamDelta: maxSeam, meanFourMetreDifference: variation / repeated,
    repeatDifferences: 0, productionShaderCompiled: true, extraTextureBytes: 0,
    limits: 'GPU field execution and production shader compilation, not an in-game art or frame-time acceptance capture.' }
  } finally { for (const resource of resources) resource.destroy(); device.destroy() }
 }, { macro: api.TERRAIN_MACRO_WGSL, forward: api.FORWARD_BLEND_WGSL })
 console.log('terrainmacrogate PASS', JSON.stringify(report))
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)) }
