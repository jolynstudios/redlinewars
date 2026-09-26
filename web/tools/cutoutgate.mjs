#!/usr/bin/env node
// Diagnostic cards through the production renderer, not a gameplay/art-quality witness.
// Read actual depth, reflection metadata, HDR and every shadow cascade. Negative controls
// remove discard in one production shader only; each must make its matching assertion fail.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { launchGpuBrowser, loadChromium, startPreview, stopChild } from './harness.mjs'

// Unit-mesh vertex layout — byte offsets from geo/mesh (toGPUBuffers). mesh.ts
// cannot be imported here (extensionless ESM imports are node-unresolvable), so
// the constants are mirrored and TRIANGULATED against the source file below:
// if geo/mesh ever changes its layout, this gate refuses to run rather than
// validating the renderer against stale fixtures.
const MESH_SRC = readFileSync(new URL('../src/geo/mesh.ts', import.meta.url), 'utf8')
const layoutConst = (name) => {
 const m = new RegExp(`export const ${name} = (\\d+)`).exec(MESH_SRC)
 if (!m) throw new Error(`cutoutgate: ${name} missing from geo/mesh.ts — layout changed, port this gate`)
 return m[1] | 0
}
const VERTEX_STRIDE = layoutConst('VERTEX_STRIDE')
const VERTEX_STRIDE_SKINNED = layoutConst('VERTEX_STRIDE_SKINNED')
const NORMAL_OFFSET = layoutConst('NORMAL_OFFSET')
const TANGENT_OFFSET = layoutConst('TANGENT_OFFSET')
const UV0_OFFSET = layoutConst('UV0_OFFSET')
const UV1_OFFSET = layoutConst('UV1_OFFSET')
const ZONE_BYTE_OFFSET = layoutConst('ZONE_BYTE_OFFSET')
const SKIN_INDEX_OFFSET = layoutConst('SKIN_INDEX_OFFSET')
const SKIN_WEIGHT_OFFSET = layoutConst('SKIN_WEIGHT_OFFSET')

const falsify = process.argv.find(a => a.startsWith('--falsify='))?.slice(10) ?? null
assert.ok(falsify === null || ['prepass', 'shadow', 'forward'].includes(falsify))
const preview = await startPreview(8448)
let browser
try {
 ({ browser } = await launchGpuBrowser(await loadChromium('cutoutgate'), 'cutoutgate'))
 const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 })
 const errors = []
 page.on('pageerror', e => errors.push(e.message))
 page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()) })
 await page.addInitScript(({ falsify }) => {
  globalThis.requestAnimationFrame = () => 1
  globalThis.cancelAnimationFrame = () => {}
  globalThis.__cutoutgate = { replacements: 0, passes: 0 }
  const create = GPUDevice.prototype.createTexture
  GPUDevice.prototype.createTexture = function (desc) {
   // Readback capability only: no texture contents or render semantics are modified.
   if (desc.label === 'render.shadow.map') desc = { ...desc, usage: desc.usage | GPUTextureUsage.COPY_SRC }
   return create.call(this, desc)
  }
  const begin = GPUCommandEncoder.prototype.beginRenderPass
  GPUCommandEncoder.prototype.beginRenderPass = function (desc) {
   if (desc.label === 'render.pass.forward') {
    Object.assign(desc.colorAttachments[0].clearValue, { r: -13, g: -29, b: -47 })
    globalThis.__cutoutgate.passes++
   }
   return begin.call(this, desc)
  }
  const shader = GPUDevice.prototype.createShaderModule
  GPUDevice.prototype.createShaderModule = function (desc) {
   if (falsify && desc.label === `render.${falsify}.cutout`) {
    const code = desc.code.replaceAll('discard;', '')
    if (code !== desc.code) globalThis.__cutoutgate.replacements++
    desc = { ...desc, code }
   }
   return shader.call(this, desc)
  }
 }, { falsify })
 await page.goto(`${preview.baseUrl}?devmap=1&manual=1&deterministic=1&devsize=48&devactors=1&devtod=720&quality=low`)
 await page.waitForFunction(() => globalThis.steelseed, undefined, { timeout: 120000, polling: 100 })
 const result = await page.evaluate(async (L) => {
  const app = globalThis.steelseed; app.stop(); app.renderOneFrame(0)
  const ctx = app.ctx, render = ctx.get('render'), camera = ctx.get('camera'), device = ctx.device
  if (!device || ctx.backend !== 'webgpu') throw new Error('cutoutgate requires WebGPU')
  camera.height = camera.heightGoal = 7
  camera.yaw = camera.yawGoal = .25
  camera.target[0] = camera.targetGoal[0] = 24
  camera.target[2] = camera.targetGoal[2] = 24
  app.renderOneFrame(1000 / 60)
  render.setShroud(new Uint8Array(48 * 48).fill(2), 48, 48, 0, 0)
  render.debugView = 1
  const material = ctx.get('materials').get('grass'), tex = material.albedo
  // Diagnostic-only texture, exact half coverage in ALL mips; never persists to source/pack.
  for (let mip = 0; mip < tex.mipLevelCount; mip++) {
   const size = Math.max(1, tex.width >> mip), bytes = new Uint8Array(size * size * 4)
   for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const o = (y * size + x) * 4
    bytes[o] = 60; bytes[o + 1] = 180; bytes[o + 2] = 50; bytes[o + 3] = x < size / 2 ? 255 : 0
   }
   for(let layer=0;layer<tex.depthOrArrayLayers;layer++)
    device.queue.writeTexture({ texture: tex, mipLevel: mip, origin:[0,0,layer] }, bytes, { bytesPerRow: size * 4 }, { width: size, height: size, depthOrArrayLayers: 1 })
  }
  const ident = () => Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)
  function card(skinned) {
   // Unit-mesh vertex layout (geo/mesh toGPUBuffers, the quantized format):
   // f16x4 position at 0 (fourth half stays 0), octahedral snorm8 normal at
   // NORMAL_OFFSET and tangent at TANGENT_OFFSET (handedness byte + pad),
   // unorm16 UV0/UV1, zone byte, and for skinned meshes joint indices +
   // unorm8 weights. Offsets are triangulated from geo/mesh at the top of
   // this file, so a future layout change fails loudly rather than silently
   // in the shadow cascades.
   const stride = skinned ? L.VERTEX_STRIDE_SKINNED : L.VERTEX_STRIDE, vertexData = new ArrayBuffer(stride * 4), u16 = new Uint16Array(vertexData), i8 = new Int8Array(vertexData), u8 = new Uint8Array(vertexData)
   const f16 = new Float16Array(1), f16bits = new Uint16Array(f16.buffer)
   const half = (v) => { f16[0] = v; return f16bits[0] }
   const positions = [[-2, 0, -2], [-2, 0, 2], [2, 0, 2], [2, 0, -2]], uv = [[0, 0], [0, 1], [1, 1], [1, 0]]
   const oct = (x, y, z) => {
    const s = Math.abs(x) + Math.abs(y) + Math.abs(z)
    let u = x / s, v = y / s
    if (z < 0) {
     const fu = (1 - Math.abs(v)) * (u < 0 ? -1 : 1), fv = (1 - Math.abs(u)) * (v < 0 ? -1 : 1)
     u = fu; v = fv
    }
    let q = Math.max(-127, Math.min(127, Math.round(u * 127))), r = Math.max(-127, Math.min(127, Math.round(v * 127)))
    if (Math.abs(q) === 127 && Math.abs(r) === 127) r -= Math.sign(r)
    return [q, r]
   }
   for (let i = 0; i < 4; i++) {
    const bo = i * stride, p = positions[i], h = bo >> 1
    u16[h] = half(p[0]); u16[h + 1] = half(p[1]); u16[h + 2] = half(p[2]); u16[h + 3] = 0
    const n = oct(0, 1, 0), t = oct(1, 0, 0)
    i8[bo + L.NORMAL_OFFSET] = n[0]; i8[bo + L.NORMAL_OFFSET + 1] = n[1]
    i8[bo + L.TANGENT_OFFSET] = t[0]; i8[bo + L.TANGENT_OFFSET + 1] = t[1]; i8[bo + L.TANGENT_OFFSET + 2] = -127
    u16[(bo + L.UV0_OFFSET) >> 1] = Math.round(uv[i][0] * 65535); u16[((bo + L.UV0_OFFSET) >> 1) + 1] = Math.round(uv[i][1] * 65535)
    u16[(bo + L.UV1_OFFSET) >> 1] = Math.round(uv[i][0] * 65535); u16[((bo + L.UV1_OFFSET) >> 1) + 1] = Math.round(uv[i][1] * 65535)
    // The skinned case also exercises layer/phase addressing, not just bone position.
    // Baseline parity: zone.x = Zone.running (the layer/phase addressing exercise) and a
    // full weight on joint 1; joint 0 remains identity while joint 1 is the gate's
    // own translated matrix. Keeping a real two-joint palette avoids the shader's
    // all-zero-joints static fast path while staying within the reserved palette.
    if (skinned) { u8[bo + L.ZONE_BYTE_OFFSET] = 1; u8[bo + L.SKIN_INDEX_OFFSET] = 1; u8[bo + L.SKIN_WEIGHT_OFFSET] = 255 }
   }
   // Minimal geo upload contract; this fixture intentionally has no QEM simplification.
   const fixture = { generateLodChain() { return [this] }, toGPUBuffers() { return {
    vertexData, indexData: new Uint16Array([0, 1, 2, 0, 2, 3]).buffer,
    vertexCount: 4, indexCount: 6, indexFormat: 'uint16', stride, skinned,
    aabbMin: [-2, 0, -2], aabbMax: [2, 0, 2], boundingSphere: [0, 0, 0, Math.sqrt(8)],
   } } }
   return render.upload(fixture, `cutoutgate.${skinned ? 'skinned' : 'static'}`)
  }
  const meshes = [card(false), card(true)], instances = ident()
  instances[12] = 24; instances[13] = 2; instances[14] = 24
  const floor = ident(); floor[0] = floor[10] = 8; floor[12] = floor[14] = 24; floor[13] = -1
  async function read(texture, bpp, depth = false) {
   const width = texture.width, height = texture.height, layers = texture.depthOrArrayLayers
   const bytesPerRow = Math.ceil(width * bpp / 256) * 256
   const buffer = device.createBuffer({ size: bytesPerRow * height * layers, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
   try {
    const encoder = device.createCommandEncoder()
    encoder.copyTextureToBuffer({ texture, ...(depth ? { aspect: 'depth-only' } : {}) }, { buffer, bytesPerRow, rowsPerImage: height }, { width, height, depthOrArrayLayers: layers })
    device.queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ)
    const raw = new Uint8Array(buffer.getMappedRange()), packed = new Uint8Array(width * height * layers * bpp)
    for (let row = 0; row < height * layers; row++) packed.set(raw.subarray(row * bytesPerRow, row * bytesPerRow + width * bpp), row * width * bpp)
    buffer.unmap(); return packed
   } finally { buffer.destroy() }
  }
  const samples = []
  for (let skinned = 0; skinned < 2; skinned++) {
   const captures = []
   for (const mode of ['empty', 'opaque', 'cutout']) {
    render.frameIndex = 0; render.historyValid = false
    // A receiver behind the holes is essential: otherwise the sky pass overwrites any
    // erroneous forward-only fragments at depth=0 and conceals a missing alpha test.
    render.submit({ mesh: meshes[0], surfaceSet: 'concrete', instances: floor, instanceCount: 1, playerColors: null, castsShadow: false })
    if (mode !== 'empty') {
     const item = { mesh: meshes[skinned], surfaceSet: 'grass', instances, instanceCount: 1, playerColors: null, castsShadow: true, alphaCutout: mode === 'cutout' }
     if (skinned) {
      const palette = render.reserveBones(2), transform = ident(); transform[12] = .65
      if (!palette || palette.base === 0) throw new Error('missing real skin palette')
      palette.matrices.set(ident()); palette.matrices.set(transform, 16)
      item.paletteBases = Uint16Array.of(palette.base); item.boneCount = 2; item.phases = Float32Array.of(.17)
     }
     render.submit(item)
    }
    // Only our submitted card. No mutation of authoritative snapshot or game producers.
    render.lateUpdate(1 / 60, ctx)
    const [depth, reflection, color, shadow] = await Promise.all([
     read(render.targets.depth, 4, true), read(render.targets.reflection, 4),
     read(render.targets.color, 8), read(render.shadows.texture, 4, true),
    ])
    captures.push({ depth: new Float32Array(depth.buffer), reflection, color: new Uint16Array(color.buffer), shadow: new Float32Array(shadow.buffer) })
   }
   const [empty, opaque, cutout] = captures
   let full = 0, covered = 0, holes = 0, reflectionLeaks = 0, colorLeaks = 0, missingColor = 0, shadowFull = 0, shadowCovered = 0
   const width = render.targets.width
   let centroidX = 0
   for (let p = 0; p < opaque.depth.length; p++) {
    if (opaque.depth[p] > empty.depth[p] + 1e-7) {
     full++; centroidX += p % width
     if (cutout.depth[p] > empty.depth[p] + 1e-7) covered++
     else {
      holes++
      for (let k = 0; k < 4; k++) if (cutout.reflection[p * 4 + k] !== empty.reflection[p * 4 + k]) { reflectionLeaks++; break }
      // Exact pre-TAA raw albedo/background, not post/exposure differences.
      for (let k = 0; k < 3; k++) if (cutout.color[p * 4 + k] !== empty.color[p * 4 + k]) { colorLeaks++; break }
     }
    }
    if (cutout.depth[p] > 0 && cutout.color[p * 4] === 51840) missingColor++ // float16(-13)
   }
   for (let p = 0; p < opaque.shadow.length; p++) {
    if (opaque.shadow[p] > 0) shadowFull++
    if (cutout.shadow[p] > 0) shadowCovered++
   }
   samples.push({ skinned: !!skinned, full, covered, holes, reflectionLeaks, colorLeaks, missingColor, shadowFull, shadowCovered, centroidX: centroidX / full })
  }
  // --- Unit caster budget guard -----------------------------------------
  // `localShadowCasters` is enforced where the units system builds instance rows. This
  // fixture proves a unit-style skinned caster still reaches the real cascades on the
  // direct-submit path: if the budget ever regresses into the renderer gather (the
  // failed knob enforcement this gate once caught), casters like this silently stop.
  render.frameIndex = 0; render.historyValid = false
  render.submit({ mesh: meshes[0], surfaceSet: 'concrete', instances: floor, instanceCount: 1, playerColors: null, castsShadow: false })
  {
   const item = { mesh: meshes[1], surfaceSet: 'grass', instances: ident(), instanceCount: 1, playerColors: null, castsShadow: true }
   item.instances[12] = 8; item.instances[14] = 8
   const palette = render.reserveBones(2), transform = ident(); transform[12] = .65
   if (!palette || palette.base === 0) throw new Error('missing real skin palette')
   palette.matrices.set(ident()); palette.matrices.set(transform, 16)
   item.paletteBases = Uint16Array.of(palette.base); item.boneCount = 2; item.phases = Float32Array.of(.17)
   item.instances[12] = 28; item.instances[13] = 2; item.instances[14] = 28
   render.submit(item)
  }
  render.lateUpdate(1 / 60, ctx)
  const unitShadow = new Float32Array((await read(render.shadows.texture, 4, true)).buffer)
  let unitShadowFull = 0
  for (let p = 0; p < unitShadow.length; p++) if (unitShadow[p] > 0) unitShadowFull++
  // --- Terrain dispatch: a non-blend float32 TERRAIN chunk must reach the unquantized ---
  // forward pipelines. 051a683 exists because non-blend terrain fell into the QUANTIZED
  // unit pipelines (f32 bytes decoded as snorm8/unorm16: black ground, radial spikes).
  // This fixture is the exact shape of that hole: stride 60 float32, blendZones false.
  const terrainStride = 60, tVertexData = new ArrayBuffer(terrainStride * 8), tdv = new DataView(tVertexData)
  // A RING, not a quad: outer square 8x8 m with a 4x4 m hole. With the correct float32
  // decode the hole shows the receiver beneath; with the stride-32 misread the fetch
  // windows land on the wrong bytes, vertices collapse toward the origin and the slivers
  // span the middle. The hole is the discriminator the plain quad lacked.
  const tPositions = [[-4, -4], [-4, 4], [4, 4], [4, -4], [-2, -2], [-2, 2], [2, 2], [2, -2]]
  for (let i = 0; i < 8; i++) {
   const bo = i * terrainStride
   tdv.setFloat32(bo, tPositions[i][0] + 24, true); tdv.setFloat32(bo + 4, 0, true); tdv.setFloat32(bo + 8, tPositions[i][1] + 24, true)
   tdv.setFloat32(bo + 12, 0, true); tdv.setFloat32(bo + 16, 1, true); tdv.setFloat32(bo + 20, 0, true)
   for (let k = 0; k < 4; k++) tdv.setFloat32(bo + 24 + k * 4, 0, true)
   const u = tPositions[i][0] + 4, v = tPositions[i][1] + 4
   tdv.setFloat32(bo + 40, u, true); tdv.setFloat32(bo + 44, v, true)
   tdv.setFloat32(bo + 48, u, true); tdv.setFloat32(bo + 52, v, true)
   tdv.setUint8(bo + 56, 0); tdv.setUint8(bo + 57, 0); tdv.setUint8(bo + 58, 0); tdv.setUint8(bo + 59, 255)
  }
  // Same winding as the reference quad (CW in XZ); each ring segment follows it.
  const ring = [0, 5, 4, 0, 1, 5, 1, 6, 5, 1, 2, 6, 2, 7, 6, 2, 3, 7, 3, 4, 7, 3, 0, 4]
  const terrainFixture = { generateLodChain() { return [this] }, toGPUBuffers() { return {
   vertexData: tVertexData, indexData: new Uint16Array(ring).buffer,
   vertexCount: 8, indexCount: ring.length, indexFormat: 'uint16', stride: terrainStride, skinned: false,
   aabbMin: [-4, 0, -4], aabbMax: [4, 0, 4], boundingSphere: [24, 0, 24, Math.sqrt(32)],
  } } }
  const terrainMesh = render.upload(terrainFixture, 'cutoutgate.terrain')
  const terrainSamples = []
  // Opaque only: real non-blend terrain items (water chunks included) are opaque-flagged
  // in terrain/index.ts; nothing in the game submits a translucent TERRAIN-stride item.
  for (const kind of ['opaque']) {
   render.frameIndex = 0; render.historyValid = false
   render.submit({ mesh: meshes[0], surfaceSet: 'concrete', instances: floor, instanceCount: 1, playerColors: null, castsShadow: false })
   // Empty capture first: the floor receiver alone, so the hole's depth signature is known.
   const tDepth0 = new Float32Array((await read(render.targets.depth, 4, true)).buffer)
   const tItem = { mesh: terrainMesh, surfaceSet: 'grass', instances: ident(), instanceCount: 1, playerColors: null,
    castsShadow: false, blendZones: false }
   render.submit(tItem)
   render.lateUpdate(1 / 60, ctx)
   const [tDepthRaw, tColorRaw] = await Promise.all([read(render.targets.depth, 4, true), read(render.targets.color, 8)])
   const d = new Float32Array(tDepthRaw.buffer), col = new Uint16Array(tColorRaw.buffer)
   const w = render.targets.width
   let drew = 0, minX = w, maxX = 0, minY = d.length / w, maxY = 0
   for (let p = 0; p < d.length; p++) if (d[p] > tDepth0[p] + 1e-7) {
    drew++
    const x = p % w, y = (p / w) | 0
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
   }
   // Central half of the drawn bbox must still show the RECEIVER: the ring's hole.
   let hole = 0, holeSamples = 0
   const cx0 = minX + (maxX - minX) / 4, cx1 = maxX - (maxX - minX) / 4
   const cy0 = minY + (maxY - minY) / 4, cy1 = maxY - (maxY - minY) / 4
   for (let y = cy0 | 0; y <= cy1; y++) for (let x = cx0 | 0; x <= cx1; x++) {
    const p = y * w + x
    holeSamples++
    if (Math.abs(d[p] - tDepth0[p]) <= 1e-7) hole++
   }
   const sample = { kind, drew, holeFrac: hole / Math.max(1, holeSamples) }
   if (kind === 'opaque') {
    const picks = []
    let seen = 0
    for (let p = 0; p < d.length && picks.length < 6; p++) if (d[p] > tDepth0[p] + 1e-7) {
     seen++
     if (seen % 9973 === 0) picks.push([p % w, (p / w) | 0, col[p * 4], col[p * 4 + 1], col[p * 4 + 2]])
    }
    sample.picks = picks
   }
   terrainSamples.push(sample)
  }
  await device.queue.onSubmittedWorkDone()
  return { samples, terrainSamples, unitShadowFull, instrument: globalThis.__cutoutgate, pipelineCreations: render.stats.pipelineCreations }
 }, { VERTEX_STRIDE, VERTEX_STRIDE_SKINNED, NORMAL_OFFSET, TANGENT_OFFSET, UV0_OFFSET, UV1_OFFSET, ZONE_BYTE_OFFSET, SKIN_INDEX_OFFSET, SKIN_WEIGHT_OFFSET })
 assert.deepEqual(errors, [], 'no page/WebGPU errors')
 assert.ok(result.unitShadowFull > 100, 'unit fixture must still cast into real cascades')
 for (const sample of result.samples) {
  console.log(`[cutoutgate] skinned=${sample.skinned} covered/full=${(sample.covered / sample.full).toFixed(4)} (${sample.covered}/${sample.full}) shadowFull=${sample.shadowFull}`)
  assert.ok(sample.full > 1000, 'the opaque card must actually draw')
  // Perspective, the translated skinned card and pixel-centre rasterization do not
  // promise an exact 0.5 screen-space ratio. The quantized vertex path measures a
  // deterministic 0.3952 here; keep enough margin for that legitimate edge while
  // still making a missing discard (~1.0) or inverted/empty mask (~0.0) fail loudly.
  assert.ok(sample.covered / sample.full > .38 && sample.covered / sample.full < .62, `depth half coverage: ${JSON.stringify(sample)}`)
  assert.equal(sample.reflectionLeaks, 0, 'no reflection metadata in alpha holes')
  assert.equal(sample.colorLeaks, 0, 'forward must not shade alpha holes')
  assert.equal(sample.missingColor, 0, 'every depth-covered fragment must be shaded')
  assert.ok(sample.shadowFull > 100, 'card must cast into real cascades')
  assert.ok(sample.shadowCovered / sample.shadowFull > .35 && sample.shadowCovered / sample.shadowFull < .65, 'shadow must preserve alpha holes')
 }
 assert.ok(Math.abs(result.samples[1].centroidX - result.samples[0].centroidX) > 10, 'actual bone transform, not bind-pose-only witness')
 for (const t of result.terrainSamples) {
  assert.ok(t.drew > 1000, `terrain must draw: ${JSON.stringify(t)}`)
  // The ring's hole is the geometry discriminator: with a stride/layout mismatch the
  // fetch windows land on the wrong bytes, the vertices collapse toward the origin and
  // the slivers span the middle, driving holeFrac toward zero. Proven to bite: routing
  // the fixture down a quantized pipeline collapses the hole (negative control run).
  assert.ok(t.holeFrac > .4, `terrain ring must leave its hole open: ${JSON.stringify(t)}`)
 }
 assert.equal(result.pipelineCreations, 0)
 if (falsify) assert.fail(`negative control ${falsify} unexpectedly passed; ${JSON.stringify(result.instrument)}`)
 const output = fileURLToPath(new URL('../.artifacts/visual-quality/', import.meta.url))
 mkdirSync(output, { recursive: true }); writeFileSync(`${output}/cutoutgate.json`, JSON.stringify(result, null, 2))
 console.log('cutoutgate PASS', JSON.stringify(result))
} finally { await browser?.close(); await stopChild(preview.server) }
