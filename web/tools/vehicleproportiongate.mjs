#!/usr/bin/env node
// OWNER-DISABLED from the standard inventory (2026-09-19): the Blender studies this
// gate compares against were reviewed and approved by the owner. The tool stays
// runnable for manual verification; re-enable in the inventory when models change.

// Private saved-source A/B through production GPU shaders. STAGED, not real combat/performance.
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { build } from 'esbuild'
import { WEB_ROOT, startPreview, stopChild, launchGpuBrowser, loadChromium } from './harness.mjs'
import { decodePng } from './png.mjs'
const root = resolve(WEB_ROOT, '..'), input = join(WEB_ROOT, '.artifacts/vehicle-proportions-v1')
const label = process.argv.find(arg => arg.startsWith('--label='))?.slice(8) ?? ''
assert.ok(!label || /^[a-z0-9-]+$/.test(label), 'Simple capture label required')
const out = join(WEB_ROOT, '.artifacts/visual-quality/vehicle-proportions-v1', label)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const variants = ['before', 'after']
for (const name of variants) for (const file of ['manifest.json', 'roster.ssasset.gz', 'masks/1tnk.mask.rgba.gz'])
  assert.ok(existsSync(join(input, name, file)), `Private export not ready: ${join(input, name, file)}; export saved source before running this gate`)
const inputs = variants.map(name => {
  const dir = join(input, name), manifest = JSON.parse(readFileSync(join(dir, 'manifest.json')))
  assert.equal(manifest.schema, 1); assert.deepEqual(Object.keys(manifest.assets), ['1tnk'])
  const packed = readFileSync(join(dir, 'roster.ssasset.gz')), raw = gunzipSync(packed, { maxOutputLength: 32 * 1024 * 1024 })
  assert.equal(packed.length, manifest.storedBytes); assert.equal(raw.length, manifest.bytes); assert.equal(hash(raw), manifest.sha256)
  const entry = manifest.assets['1tnk']
  assert.equal(entry.offset, 0); assert.equal(entry.bytes, raw.length); assert.equal(hash(raw), entry.sha256)
  assert.match(entry.sourceSha256, /^[a-f0-9]{64}$/)
  assert.equal(hash(readFileSync(resolve(root, entry.sourcePath))), entry.sourceSha256, 'Private saved source differs from export')
  assert.equal(entry.materialSet, 'industrial-v1'); assert.equal(entry.skinned, true)
  assert.equal(entry.uvMapping.projectedObjects, 0); assert.ok(entry.uvMapping.authoredObjects > 0)
  assert.equal(entry.rig.bones.length, 12); assert.equal(entry.rig.wheelBones.length, 10); assert.equal(entry.rig.turretBones.length, 1)
  const mask = entry.detailMask
  assert.equal(mask.file, 'masks/1tnk.mask.rgba.gz'); assert.equal(mask.uv, 1); assert.equal(mask.origin, 'bottom-left')
  assert.equal(mask.channels, 'ao,cavity,dirt,wear'); assert.equal(mask.compression, 'gzip')
  assert.ok([128, 256, 512].includes(mask.size)); assert.equal(mask.bytes, mask.size ** 2 * 4)
  const maskGzip = readFileSync(join(dir, mask.file)), maskRaw = gunzipSync(maskGzip, { maxOutputLength: mask.bytes })
  assert.equal(maskGzip.length, mask.storedBytes); assert.equal(maskRaw.length, mask.bytes); assert.equal(hash(maskRaw), mask.sha256)
  const variation = Array.from({ length: 4 }, (_, channel) => new Set(maskRaw.filter((_, i) => i % 4 === channel)).size)
  assert.ok(variation[0] > 16, 'AO needs real spatial information')
  return { name, manifest, entry, raw: Array.from(raw), maskRaw: Array.from(maskRaw), variation }
})
assert.notEqual(inputs[0].entry.sourceSha256, inputs[1].entry.sourceSha256, 'A/B requires different saved sources')
assert.notEqual(inputs[0].entry.sha256, inputs[1].entry.sha256, 'A/B mesh must actually change')
assert.notEqual(inputs[0].entry.detailMask.sha256, inputs[1].entry.detailMask.sha256, 'A/B must include changed rebaked masks')
assert.deepEqual(inputs[0].entry.materialTable, inputs[1].entry.materialTable, 'Shared industrial material zones')
assert.deepEqual(inputs[0].entry.rig.bones.map(b => [b.name, b.parent, b.kind]), inputs[1].entry.rig.bones.map(b => [b.name, b.parent, b.kind]))
for (const axis of [0, 2]) assert.ok(inputs[1].entry.bounds[1][axis] - inputs[1].entry.bounds[0][axis] <
  inputs[0].entry.bounds[1][axis] - inputs[0].entry.bounds[0][axis], 'After export must be shorter and narrower')
// Refuse stale production runtime. The gate injects helpers, never replacement shaders.
const maps = readdirSync(join(WEB_ROOT, 'dist/assets')).filter(name => name.endsWith('.js.map'))
const wanted = ['render/renderer.ts', 'render/shaders.ts', 'render/gpumesh.ts', 'materials/index.ts', 'materials/forge.ts', 'materials/actor-masks.ts', 'units/blender-mesh.ts', 'geo/rig.ts']
const seen = new Set()
for (const name of maps) {
  const map = JSON.parse(readFileSync(join(WEB_ROOT, 'dist/assets', name)))
  for (let i = 0; i < map.sources.length; i++) for (const path of wanted) if (map.sources[i].endsWith('/' + path)) {
    assert.equal(map.sourcesContent[i], readFileSync(join(WEB_ROOT, 'src', path), 'utf8'), `Stale dist ${path}; parent must finish its build`)
    seen.add(path)
  }
}
assert.equal(seen.size, wanted.length, 'Production source maps must identify every reviewed component')
const bundle = await build({ stdin: { contents: `
  export { decodeBlenderAsset } from './src/units/blender-mesh.ts';
  export { computeWorldTransforms, computeSkinMatrices, setBoneAngle } from './src/geo/rig.ts';
  export { placeActor } from './src/core/place.ts';
  export { HeaderFlag } from './src/core/snapshot.ts';
  export { maskMip } from './src/materials/actor-masks.ts';
  export { ForgedSurfaceSet } from './src/materials/forge.ts';
`, resolveDir: WEB_ROOT }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'vehicleProportionApi', logLevel: 'silent',
  define: { 'import.meta.glob': '__vehicleEmptyGlob' }, banner: { js: 'const __vehicleEmptyGlob=()=>({});' } })
let preview, browser
const results = [], gpuErrors = []
try {
  preview = await startPreview(8472)
  const launched = await launchGpuBrowser(await loadChromium('vehicleproportiongate'), 'vehicleproportiongate'); browser = launched.browser
  mkdirSync(out, { recursive: true })
  for (const source of inputs) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 }, deviceScaleFactor: 1 })
    page.on('pageerror', e => gpuErrors.push(e.message))
    page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) gpuErrors.push(m.text()) })
    await page.addInitScript(() => { globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {} })
    await page.goto(`${preview.baseUrl}?devmap=1&manual=1&deterministic=1&devsize=48&devactors=1&devtod=720&weather=clear&quality=high&noenvironment=1&noactormasks=1`)
    await page.waitForFunction(() => globalThis.steelseed, undefined, { timeout: 120000, polling: 100 })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const result = await page.evaluate(async source => {
      const check = (condition, why) => { if (!condition) throw Error(why) }
      const app = steelseed; app.stop(); app.renderOneFrame(0); app.bridge = null
      const ctx = app.ctx, r = ctx.get('render'), mats = ctx.get('materials'), camera = ctx.get('camera')
      const terrain = ctx.get('terrain'), shroud = ctx.get('shroud'), sky = ctx.get('sky'), api = vehicleProportionApi, device = ctx.device
      check(ctx.backend === 'webgpu' && device, 'Real WebGPU required')
      const errors = []; device.addEventListener('uncapturederror', event => errors.push(event.error.message))
      device.pushErrorScope('validation')
      const ground = ctx.snapshot.terrainStatic
      ground.height.fill(0); ground.ramp.fill(0); ground.surface.fill(7); ground.resource.fill(0)
      ctx.snapshot.flags |= api.HeaderFlag.terrainStaticPresent
      terrain.onSnapshot(ctx.snapshot, null, ctx); shroud.cells.fill(2); r.setShroud(shroud.cells, ground.w, ground.h, 0, 0)
      sky.environment.windStrength = 0; sky.environment.motionTime = 0; r.setEnvironment(sky.environment)
      check(mats.has('industrial-v1') && mats.sets instanceof Map, 'Expected production material store')
      const base = mats.get('industrial-v1'), decoded = api.decodeBlenderAsset(Uint8Array.from(source.raw), source.entry)
      const mesh = decoded.mesh, rig = decoded.rig
      check(rig && rig.skeleton.boneCount === 12, 'Expected tank rig')
      check(!mesh.validate(), 'Valid decoded mesh')
      const uploaded = r.upload(mesh, `vehicle-review:${source.name}`)
      const sk = rig.skeleton, pose = sk.createPose(), world = sk.createMatrixBuffer(), skin = sk.createMatrixBuffer()
      class ReviewMaskSet extends api.ForgedSurfaceSet {
        constructor(detail, info, vram) {
          super({ id: `industrial-v1:vehicle-review-${source.name}`, albedo: base.albedo, normal: base.normal, orm: base.orm, mask: base.mask,
            info, layerCount: base.layerCount, size: base.size, mipCount: base.mipCount, tileMeters: base.tileMeters, heightRange: base.heightRange, vramBytes: vram + 32 })
          this.detail = detail; this.detailMaskView = detail.createView()
        }
        dispose() { this.detail.destroy(); this.info.destroy() }
      }
      const size = source.entry.detailMask.size, mipCount = Math.log2(size) + 1
      const texture = device.createTexture({ label: `vehicle-review:${source.name}:ao-cavity-dirt-wear`, size: [size, size], format: 'rgba8unorm', mipLevelCount: mipCount,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
      let pixels = Uint8Array.from(source.maskRaw), side = size, maskBytes = 0
      for (let mip = 0; mip < mipCount; mip++) {
        device.queue.writeTexture({ texture, mipLevel: mip }, pixels, { bytesPerRow: side * 4, rowsPerImage: side }, [side, side])
        maskBytes += pixels.byteLength
        if (side > 1) { pixels = api.maskMip(pixels, side); side >>= 1 }
      }
      const info = device.createBuffer({ label: 'vehicle-review:mask-info', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      const data = new ArrayBuffer(32), u = new Uint32Array(data), f = new Float32Array(data)
      u[0] = base.layerCount; u[1] = base.mipCount; f[4] = base.tileMeters; f[5] = base.heightRange; f[6] = base.tileMeters / base.size
      device.queue.writeBuffer(info, 0, data)
      const masked = new ReviewMaskSet(texture, info, maskBytes)
      check(!mats.has(masked.id), 'No overwritten material set'); mats.sets.set(masked.id, masked)
      let maskBound = 0
      const bind = mats.bindGroupFor.bind(mats)
      mats.bindGroupFor = set => { if (set === masked) { check(set.detailMaskView && set instanceof api.ForgedSurfaceSet, 'Production mask binding'); maskBound++ } return bind(set) }
      const instances = new Float32Array(16), paletteBases = new Uint16Array(1), motionIds = Uint32Array.of(0x6fffff01)
      api.placeActor(instances, 0, 24, 24, 0, .5, .5, false, 0, (x, z) => terrain.heightAt(x, z), uploaded.aabbMin[1])
      const item = { mesh: uploaded, surfaceSet: masked.id, instances, instanceCount: 1, playerColors: Uint8Array.of(0), castsShadow: true,
        paletteBases, boneCount: sk.boneCount, phases: Float32Array.of(0), motionIds }
      const captures = [], witnesses = []
      let expectedSkin = null, frameSerial = 0
      const encode = r.encodeFrame.bind(r)
      r.encodeFrame = function () {
        frameSerial++
        for (let i = 0; i < r.itemCount; i++) if (r.items[i] === item) {
          const offset = paletteBases[0] * 16; let error = 0
          for (let k = 0; k < expectedSkin.length; k++) error = Math.max(error, Math.abs(r.boneData[offset + k] - expectedSkin[k]))
          check(error < 1e-6, 'Submitted palette differs from production rig calculation')
          check(r.itemIncluded[i] && r.itemMainCount.subarray(i * 3, i * 3 + 3).some(n => n > 0), 'Tank must survive main-view culling and budget: ' + JSON.stringify({
            serial: frameSerial, camera: Array.from(r.camera.position), target: Array.from(camera.target), included: r.itemIncluded[i],
            main: Array.from(r.itemMainCount.subarray(i * 3, i * 3 + 3)), sphere: Array.from(uploaded.sphere), placement: Array.from(instances), dropped: r.stats.dropped }))
          witnesses.push({ serial: frameSerial, error, main: Array.from(r.itemMainCount.subarray(i * 3, i * 3 + 3)), material: item.surfaceSet })
        }
        return encode()
      }
      function setPose(turretAngle, wheelAngle) {
        pose.resetToBind(); api.setBoneAngle(pose, rig.turretBones[0], turretAngle)
        for (const bone of rig.wheelBones) api.setBoneAngle(pose, bone, wheelAngle)
        api.computeWorldTransforms(pose, world); api.computeSkinMatrices(sk, world, skin)
        expectedSkin = skin
      }
      function frame() {
        const palette = r.reserveBones(sk.boneCount); check(palette, 'Bone capacity'); palette.matrices.set(skin); paletteBases[0] = palette.base
        terrain.update(0, ctx); r.submit(item); r.lateUpdate(0, ctx)
      }
      function capture(name, height, mask, turret, wheel, settle = Math.max(64, Math.ceil(r.probes.total / r.probes.updatesPerFrame) + 2)) {
        item.surfaceSet = mask ? masked.id : 'industrial-v1'; setPose(turret, wheel)
        r.historyValid = false; r.frameIndex = 0
        for (let i = 0; i < settle; i++) frame()
        const canvas = document.createElement('canvas'); canvas.width = ctx.canvas.width; canvas.height = ctx.canvas.height
        canvas.getContext('2d').drawImage(ctx.canvas, 0, 0)
        captures.push({ name, height, mask, turret, wheel, png: canvas.toDataURL(), serial: frameSerial, witness: witnesses.at(-1),
          palette: Array.from(skin), placement: Array.from(instances), camera: { position: Array.from(r.camera.position), view: Array.from(camera.view), proj: Array.from(camera.proj) },
          dropped: r.stats.dropped, debugView: r.debugView })
      }
      for (const [view, height] of [['close', 3.2], ['gameplay', 8]]) {
        camera.height = camera.heightGoal = height; camera.yaw = camera.yawGoal = .7; camera.focusWorld(24, 24)
        camera.target[0] = camera.targetGoal[0] = 24; camera.target[2] = camera.targetGoal[2] = 24
        // Manual scheduling still uses the production ground-following camera hook.
        camera.lateUpdate(0, ctx)
        camera.update(0, ctx); r.debugView = 0
        // Warm production probe volume without changing its normal per-frame budget.
        setPose(0, 0)
        for (let i = 0; i < Math.ceil(r.probes.total / r.probes.updatesPerFrame) + 2; i++) frame()
        capture(`${view}-neutral`, height, false, 0, 0)
        capture(`${view}-bind`, height, true, 0, 0)
        capture(`${view}-turret`, height, true, Math.PI / 2, 0)
        capture(`${view}-wheel`, height, true, Math.PI / 2, Math.PI / 2)
        capture(`${view}-paused`, height, true, Math.PI / 2, Math.PI / 2)
      }
      await device.queue.onSubmittedWorkDone()
      const validation = await device.popErrorScope(); check(!validation, validation?.message); check(errors.length === 0, errors.join('; ')); check(maskBound === 1, 'Exactly one production masked bind group')
      r.encodeFrame = encode; mats.bindGroupFor = bind
      const result = { captures, frames: frameSerial, witnessFrames: witnesses.length, maskBound, gpuErrors: errors,
        lodTriangles: uploaded.lods.map(l => l.indexCount / 3), bounds: [Array.from(uploaded.aabbMin), Array.from(uploaded.aabbMax)],
        sourceBounds: source.entry.bounds, bones: sk.boneCount, maskMipCount: mipCount, maskBytes,
        environment: { sunDirection: Array.from(sky.environment.sunDirection ?? sky.environment.sunDir ?? []), timeOfDay: sky.timeOfDay },
        stage: 'Private exported 1tnk, staged distance/quarter-turn poses, production shaders and terrain. Not real combat, authoritative movement, selection, light-anchor, muzzle, or performance acceptance.' }
      mats.sets.delete(masked.id); masked.dispose()
      return result
    }, source)
    assert.equal(result.frames, result.witnessFrames, 'Every rendered fixture frame witnessed')
    assert.deepEqual(result.gpuErrors, [])
    for (const frame of result.captures) {
      assert.equal(frame.dropped, 0); assert.equal(frame.debugView, 0)
      writeFileSync(join(out, `${source.name}-${frame.name}.png`), Buffer.from(frame.png.split(',')[1], 'base64'))
    }
    results.push({ name: source.name, ...result }); await page.close()
  }
  const difference = (a, b) => {
    const x = decodePng(Buffer.from(a.png.split(',')[1], 'base64')), y = decodePng(Buffer.from(b.png.split(',')[1], 'base64'))
    assert.equal(x.width, y.width); assert.equal(x.height, y.height)
    let changed = 0, sum = 0
    for (let i = 0; i < x.data.length; i += 4) { const d = Math.abs(x.data[i] - y.data[i]) + Math.abs(x.data[i + 1] - y.data[i + 1]) + Math.abs(x.data[i + 2] - y.data[i + 2]); sum += d; if (d > 9) changed++ }
    return { changedPixels: changed, meanAbsoluteRgb: sum / (x.width * x.height * 3) }
  }
  const metrics = []
  for (const result of results) for (const view of ['close', 'gameplay']) {
    const find = name => result.captures.find(f => f.name === `${view}-${name}`)
    const bind = find('bind'), turret = find('turret'), wheel = find('wheel'), paused = find('paused')
    const maskDelta = difference(find('neutral'), bind), turretDelta = difference(bind, turret), wheelDelta = difference(turret, wheel), pauseDelta = difference(wheel, paused)
    assert.ok(maskDelta.changedPixels > 5, 'Rebaked mask must visibly affect production shading')
    assert.ok(turretDelta.changedPixels > 10, 'Turret yaw must visibly change the render')
    assert.notDeepEqual(turret.palette, wheel.palette, 'Wheel quarter-turn must change submitted palette')
    if (view === 'close') assert.ok(wheelDelta.changedPixels > 0, 'Wheel quarter-turn needs visible close-up evidence')
    assert.deepEqual(wheel.palette, paused.palette); assert.deepEqual(wheel.placement, paused.placement)
    assert.ok(paused.serial >= wheel.serial + 3, 'Pause requires fresh rendered frames')
    assert.ok(pauseDelta.meanAbsoluteRgb < .1, 'Held pose must have stable converged appearance')
    metrics.push({ variant: result.name, view, maskDelta, turretDelta, wheelDelta, pauseDelta })
  }
  for (const view of ['close', 'gameplay']) {
    const a = results[0].captures.find(f => f.name === `${view}-bind`), b = results[1].captures.find(f => f.name === `${view}-bind`)
    assert.deepEqual(a.camera, b.camera, 'Identical A/B camera'); assert.deepEqual(results[0].environment, results[1].environment, 'Identical A/B environment')
    const delta = difference(a, b); assert.ok(delta.changedPixels > 10, 'Private revised model must change the actual image')
    metrics.push({ comparison: 'before/after', view, ...delta })
  }
  assert.deepEqual(gpuErrors, [])
  for (const source of inputs) assert.equal(hash(readFileSync(resolve(root, source.entry.sourcePath))), source.entry.sourceSha256,
    'Saved source changed during captures; rerun after private export is stable')
  const report = { status: 'PASS', browser: launched.label, inputs: inputs.map(({ name, entry, manifest, variation }) => ({ name, sourcePath: entry.sourcePath,
    sourceSha256: entry.sourceSha256, packSha256: manifest.sha256, maskSha256: entry.detailMask.sha256, maskVariation: variation, bounds: entry.bounds })), metrics,
    results: results.map(r => ({ ...r, captures: r.captures.map(({ png, ...rest }) => rest) })),
    scope: 'STAGED A/B only. Production public upload/reserveBones/submit/lateUpdate and material bindGroupFor; gate-only material alias registration. No production shader replacement, source promotion, shared compose, real combat or performance claim.' }
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log('vehicleproportiongate: PASS', JSON.stringify({ out, metrics }))
} finally { await browser?.close(); if (preview) await stopChild(preview.server) }