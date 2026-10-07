#!/usr/bin/env node
// PRIVATE diagnostic: real frozen OpenRA match, production shaders/materials, ORM-only A/B/A.
// No shipping mutation, build, shared compose, aesthetic acceptance or performance claim.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { build } from 'esbuild'
import { WEB_ROOT, launchGpuBrowser, loadChromium } from './harness.mjs'
import { startPrivateComposed } from './private-composed-preview.mjs'
import { configFor } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'
import { decodePng, encodePng } from './png.mjs'

const TOOL = 'groundroughnessreview', root = resolve(WEB_ROOT, '..')
const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const label = arg('label', 'review'), candidateDir = resolve(arg('source-pack', join(WEB_ROOT, '.artifacts/ground-roughness-v1/after')))
assert.match(label, /^[a-z0-9-]+$/)
const out = join(WEB_ROOT, '.artifacts/visual-quality/ground-roughness-v1', label)
assert.ok(!existsSync(join(out, 'report.json')), 'Use a new --label; preserve completed reviews')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const bpp = [4, 2, 4, 1], names = ['albedo', 'normal', 'orm', 'mask']
function auditPack(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'))), packed = readFileSync(join(dir, 'ground.sspbr.gz'))
  assert.equal(manifest.schema, 1); assert.equal(manifest.size, 512); assert.equal(manifest.mipCount, 10)
  assert.equal(manifest.origin, 'bottom-left'); assert.equal(manifest.compression, 'gzip')
  assert.equal(manifest.sourceKind, 'saved-blender-material-graphs')
  assert.ok(Number.isSafeInteger(manifest.bytes) && manifest.bytes > 0 && manifest.bytes <= 16 * 1024 * 1024)
  assert.equal(packed.length, manifest.storedBytes)
  const raw = gunzipSync(packed, { maxOutputLength: 16 * 1024 * 1024 })
  assert.equal(raw.length, manifest.bytes); assert.equal(hash(raw), manifest.sha256)
  const saved = realpathSync(resolve(root, manifest.sourcePath))
  assert.ok(saved.startsWith(root + sep)); assert.equal(hash(readFileSync(saved)), manifest.sourceSha256, 'Saved Blender source provenance')
  assert.deepEqual(manifest.surfaces.map(s => s.id), ['grass', 'soil', 'forest'])
  let end = 0
  for (const s of manifest.surfaces) {
    assert.ok(Number.isFinite(s.tileMeters) && s.tileMeters > 0 && Number.isFinite(s.heightRange) && s.heightRange > 0)
    assert.match(s.source.sha256, /^[a-f0-9]{64}$/); assert.equal(s.mips.length, 10)
    for (let m = 0; m < 10; m++) {
      assert.equal(s.mips[m].length, 4)
      for (let c = 0; c < 4; c++) {
        const r = s.mips[m][c]
        assert.equal(r.offset, end); assert.equal(r.bytes, (512 >> m) ** 2 * bpp[c])
        end += r.bytes; assert.ok(end <= raw.length); assert.equal(hash(raw.subarray(r.offset, end)), r.sha256)
      }
    }
  }
  assert.equal(end, raw.length)
  return { manifest, packed, raw, packedSha256: hash(packed) }
}
const baseline = auditPack(join(WEB_ROOT, '.forge/ground')), candidate = auditPack(candidateDir)
let preservedRanges = 0, changedRoughnessTexels = 0
for (let s = 0; s < 3; s++) {
  const a = baseline.manifest.surfaces[s], b = candidate.manifest.surfaces[s]
  for (const key of ['id', 'tileMeters', 'heightRange', 'source']) assert.deepEqual(a[key], b[key])
  for (let m = 0; m < 10; m++) for (let c = 0; c < 4; c++) {
    const ar = a.mips[m][c], br = b.mips[m][c]
    assert.equal(ar.offset, br.offset); assert.equal(ar.bytes, br.bytes)
    const av = baseline.raw.subarray(ar.offset, ar.offset + ar.bytes), bv = candidate.raw.subarray(br.offset, br.offset + br.bytes)
    if (s === 0 && c === 2) {
      for (let i = 0; i < av.length; i++) {
        if (i % 4) assert.equal(av[i], bv[i], 'Grass ORM GBA must remain byte-identical')
        else if (av[i] !== bv[i]) changedRoughnessTexels++
      }
    } else { assert.deepEqual(av, bv, 'No other source channel may change'); preservedRanges++ }
  }
}
assert.ok(changedRoughnessTexels > 0)
const sourcePaths = ['render/renderer.ts', 'render/shaders.ts', 'render/cutout-shaders.ts', 'render/post.ts', 'render/targets.ts',
  'materials/index.ts', 'materials/ground-surfaces.ts', 'materials/environment.ts', 'materials/atlas.ts',
  'terrain/index.ts', 'units/environment.ts', 'core/asset-pack.ts', 'camera/index.ts']
const seen = new Set(), sourceMaps = []
for (const file of readdirSync(join(WEB_ROOT, 'dist/assets')).filter(f => f.endsWith('.js.map'))) {
  const bytes = readFileSync(join(WEB_ROOT, 'dist/assets', file)), map = JSON.parse(bytes)
  sourceMaps.push({ file, sha256: hash(bytes) })
  for (let i = 0; i < map.sources.length; i++) for (const path of sourcePaths) if (map.sources[i].endsWith('/' + path)) {
    assert.equal(map.sourcesContent[i], readFileSync(join(WEB_ROOT, 'src', path), 'utf8'), `Stale dist: ${path}; parent must build`)
    seen.add(path)
  }
}
assert.equal(seen.size, sourcePaths.length, 'Require current production source-map evidence')
// Diagnostic imports only, compiled in memory: does not build or modify production dist.
const api = await build({ stdin: { contents: "export { fetchAssetPack } from './src/core/asset-pack.ts'; export { m4 } from './src/core/math.ts';", resolveDir: WEB_ROOT },
  bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'groundReviewApi', logLevel: 'silent' })
mkdirSync(out, { recursive: true })
const report = { status: 'running', staging: 'Real private Marigold Town snapshot, presentation-only GPU texture intervention. Not live combat, FPS or aesthetic acceptance.',
  baseline: { ...baseline.manifest, packedSha256: baseline.packedSha256 }, candidate: { ...candidate.manifest, packedSha256: candidate.packedSha256 },
  sourceMaps, preservedRanges, changedRoughnessTexels, shaderPatches: 0, captures: [], cameraSearch: [] }
let preview, browser
const errors = []
try {
  console.log(`${TOOL}: source packs and source-map freshness PASS; starting private 8475`)
  preview = await startPrivateComposed(8475)
  const launched = await launchGpuBrowser(await loadChromium(TOOL), TOOL); browser = launched.browser; report.browser = launched.label
  const page = await browser.newPage({ viewport: { width: 1512, height: 982 } })
  page.on('pageerror', e => errors.push(e.message))
  for (const [id, p] of [['baseline', baseline], ['candidate', candidate]])
    await page.route(`http://127.0.0.1:8475/__ground-review/${id}.gz`, route => route.fulfill({ body: p.packed, contentType: 'application/octet-stream' }))
  await page.goto(`${preview.baseUrl}?mode=game&platform=null&daylight=day&weather=clear&quality=medium`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(() => globalThis.steelseed?.ctx.session.available, undefined, { timeout: 120000, polling: 100 })
  const catalog = await page.evaluate(() => steelseed.ctx.session.getCatalog()), map = catalog.maps.find(m => m.title === 'Marigold Town')
  assert.ok(map, 'Real Marigold Town required')
  const config = configFor(catalog, map, { withBot: false })
  config.options.startingunits = 'heavy'; config.options.explored = 'True'; config.options.fog = 'False'
  config.local.faction = 'england'; config.slots.find(s => s.slot === config.local.slot).faction = 'england'
  await page.evaluate(c => steelseed.ctx.session.startSkirmish(c), config)
  await page.waitForFunction(() => steelseed.ctx.snapshot?.actors.count > 0 && document.getElementById('session-ui').hidden,
    undefined, { timeout: 120000, polling: 100 })
  // Freeze synchronously before any injected import/readback awaits.
  await page.evaluate(() => { steelseed.stop(); steelseed.bridge = null })
  await page.addScriptTag({ content: api.outputFiles[0].text })
  report.setup = await page.evaluate(async manifests => {
    const app = steelseed, ctx = app.ctx, device = ctx.device, render = ctx.get('render'), terrain = ctx.get('terrain'), units = ctx.get('units')
    const camera = ctx.get('camera'), mats = ctx.get('materials'), set = mats.get('grass'), atlas = mats.terrainAtlas
    const grass = units.scenery.pools.get('grass'), originalSubmit = render.submit, originalDebug = render.debugView
    const check = (v, why) => { if (!v) throw Error(why) }, channels = ['albedo', 'normal', 'orm', 'mask'], bpp = [4, 2, 4, 1]
    check(set && atlas && mats.groundSourceStats?.loaded, 'Source ground material and terrain atlas must be resident')
    const sky = ctx.get('sky'), env = sky.environment
    check(sky.timeOfDay === 720 && sky.weatherKind === 0 && env.wetness === 0, 'Require actual clear, dry noon')
    device.addEventListener('uncapturederror', e => { (globalThis.groundGpuErrors ??= []).push(e.error.message) })
    const digest = async v => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', v)), x => x.toString(16).padStart(2, '0')).join('')
    const raw = []
    for (let i = 0; i < 2; i++) {
      const url = new URL(`/__ground-review/${i ? 'candidate' : 'baseline'}.gz`, location.href)
      check(url.origin === location.origin, 'Pack fetch must be same-origin')
      raw.push(await groundReviewApi.fetchAssetPack(url.href, manifests[i]))
    }
    async function readTexture(texture, mip, bpp, aspect = 'all') {
      const width = Math.max(1, texture.width >> mip), height = Math.max(1, texture.height >> mip), layers = texture.depthOrArrayLayers
      const row = Math.ceil(width * bpp / 256) * 256
      const buffer = device.createBuffer({ label: 'ground-review.readback', size: row * height * layers, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      try {
        const enc = device.createCommandEncoder(); enc.copyTextureToBuffer({ texture, mipLevel: mip, aspect },
          { buffer, bytesPerRow: row, rowsPerImage: height }, { width, height, depthOrArrayLayers: layers }); device.queue.submit([enc.finish()])
        await buffer.mapAsync(GPUMapMode.READ)
        const src = new Uint8Array(buffer.getMappedRange()), dst = new Uint8Array(width * height * layers * bpp)
        for (let y = 0; y < height * layers; y++) dst.set(src.subarray(y * row, y * row + width * bpp), y * width * bpp)
        return dst
      } finally { buffer.destroy() }
    }
    async function exposure() {
      const b = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      try { const e = device.createCommandEncoder(); e.copyBufferToBuffer(render.postChain.exposureBuffer, 0, b, 0, 16); device.queue.submit([e.finish()])
        await b.mapAsync(GPUMapMode.READ); return Array.from(new Float32Array(b.getMappedRange()))
      } finally { b.destroy() }
    }
    const baselineExposure = (await exposure())[0], original = [], evidence = []
    const objects = [{ id: 'grass', object: set, firstLayer: 0, count: set.layerCount },
      { id: 'terrainAtlas', object: atlas, firstLayer: 4 * atlas.variantsPerSurface, count: atlas.variantsPerSurface }]
    // Read all live texture bytes BEFORE the first intervention. Grass ranges must match
    // .forge exactly; retain all other layers/channels to prove they never change.
    device.pushErrorScope('validation')
    for (const target of objects) {
      const firstMip = Math.log2(512 / target.object.size)
      check(Number.isInteger(firstMip) && firstMip >= 0 && Number.isInteger(target.object.mipCount) &&
        target.object.mipCount > 0 && target.object.mipCount <= 10 - firstMip &&
        target.object.orm.mipLevelCount === target.object.mipCount, `Resident mip contract ${target.id}: size=${target.object.size}, mips=${target.object.mipCount}`)
      for (let c = 0; c < 4; c++) for (let mip = 0; mip < target.object.mipCount; mip++) {
        const texture = target.object[channels[c]], bytes = await readTexture(texture, mip, bpp[c])
        const r = manifests[0].surfaces[0].mips[firstMip + mip][c], expected = raw[0].subarray(r.offset, r.offset + r.bytes)
        for (let layer = target.firstLayer; layer < target.firstLayer + target.count; layer++) {
          check((layer + 1) * r.bytes <= bytes.length, 'Atlas layer range')
          const actual = bytes.subarray(layer * r.bytes, (layer + 1) * r.bytes)
          check(actual.every((v, i) => v === expected[i]), `PRE-WRITE baseline-source mismatch ${target.id}/${channels[c]}/m${mip}/layer${layer}`)
        }
        const item = { target, c, mip, firstMip, bytes, texture, rangeBytes: r.bytes }
        original.push(item); evidence.push({ target: target.id, channel: channels[c], mip, byteLength: bytes.length, sha256: await digest(bytes) })
      }
    }
    const err = await device.popErrorScope(); check(!err, err?.message)
    const actors = ctx.snapshot.actors
    let tank = -1
    for (let i = 0; i < actors.count; i++) if (actors.owner[i] === ctx.snapshot.world.renderPlayer && ctx.actorTypeName(actors.typeId[i]) === '1tnk') { tank = i; break }
    check(tank >= 0, 'Require actual local tank camera anchor')
    const anchor = [actors.posX[tank] / 1024, actors.posY[tank] / 1024]
    const snapshotDigest = async () => {
      const fields = []
      for (const section of ['actors', 'terrain', 'world']) for (const [key, value] of Object.entries(ctx.snapshot[section] ?? {})) {
        if (ArrayBuffer.isView(value)) fields.push([section, key, await digest(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))])
        else if (typeof value === 'number') fields.push([section, key, value])
      }
      return JSON.stringify([ctx.snapshot.tick, ctx.time, fields])
    }
    const frozen = await snapshotDigest(), frames = Math.ceil(render.probes.total / render.probes.updatesPerFrame) + 66
    let enabled = true, writes = 0
    render.submit = function(item) { if (enabled || item !== grass.item) originalSubmit.call(render, item) }
    async function verify(state) {
      const hashes = []
      device.pushErrorScope('validation')
      for (const item of original) {
        const { target, c, mip, firstMip, texture, bytes, rangeBytes } = item, expected = bytes.slice()
        if (state === 1 && c === 2) {
          const r = manifests[1].surfaces[0].mips[firstMip + mip][c], patch = raw[1].subarray(r.offset, r.offset + r.bytes)
          for (let layer = target.firstLayer; layer < target.firstLayer + target.count; layer++) expected.set(patch, layer * rangeBytes)
        }
        const actual = await readTexture(texture, mip, bpp[c])
        check(actual.length === expected.length && actual.every((v, i) => v === expected[i]), `GPU byte mismatch state${state}/${target.id}/${channels[c]}/${mip}`)
        hashes.push({ target: target.id, channel: channels[c], mip, sha256: await digest(actual) })
      }
      const error = await device.popErrorScope(); check(!error, error?.message)
      return hashes
    }
    async function install(state) {
      check(state === 0 || state === 1, 'Only verified packs may be installed')
      device.pushErrorScope('validation')
      for (const { target, c, mip, firstMip, texture } of original) if (c === 2) {
        const r = manifests[state].surfaces[0].mips[firstMip + mip][2], patch = raw[state].subarray(r.offset, r.offset + r.bytes)
        const size = Math.max(1, texture.width >> mip)
        for (let layer = target.firstLayer; layer < target.firstLayer + target.count; layer++) {
          device.queue.writeTexture({ texture, mipLevel: mip, origin: [0, 0, layer] }, patch,
            { bytesPerRow: size * 4, rowsPerImage: size }, { width: size, height: size, depthOrArrayLayers: 1 }); writes++
        }
      }
      await device.queue.onSubmittedWorkDone(); const error = await device.popErrorScope(); check(!error, error?.message)
      return { writes, hashes: await verify(state) }
    }
    function setCamera({ yaw, height }) {
      check(writes === 0, 'Camera search must finish BEFORE candidate/restoration writes')
      check(height >= 3.5 && height <= 140 && Number.isFinite(yaw), 'Actual camera bounds')
      camera.target[0] = camera.targetGoal[0] = anchor[0]; camera.target[2] = camera.targetGoal[2] = anchor[1]
      camera.height = camera.heightGoal = height; camera.yaw = camera.yawGoal = yaw
      camera.lateUpdate(0, ctx); camera.update(0, ctx)
    }
    function actorBoxes(width, height) {
      const vp = render.camera.viewProj, boxes = [], transform = new Float32Array(16), visual = { mesh: null, surfaceSet: '', playerColor: 0 }
      for (let i = 0; i < actors.count; i++) if (units.captureActorVisual(actors.id[i], transform, 0, visual)) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (let c = 0; c < 8; c++) {
          const b = [0, 1, 2].map(k => (c & (1 << k) ? visual.mesh.aabbMax : visual.mesh.aabbMin)[k])
          const p = [0, 1, 2].map(k => transform[k] * b[0] + transform[k + 4] * b[1] + transform[k + 8] * b[2] + transform[k + 12])
          const w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15]
          if (w <= 0) continue
          const x = ((vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12]) / w * .5 + .5) * width
          const y = (.5 - (vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13]) / w * .5) * height
          minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
        }
        if (Number.isFinite(minX)) boxes.push([minX - 8, minY - 8, maxX + 8, maxY + 8])
      }
      return boxes
    }
    async function capture(visible, view = 0, makeMask = false) {
      device.pushErrorScope('validation'); enabled = visible; render.debugView = view
      render.historyValid = false; render.frameIndex = 0
      for (let i = 0; i < frames; i++) { terrain.update(0, ctx); units.update(0, ctx); render.lateUpdate(0, ctx) }
      // WebGPU current texture must be copied before ANY await/presentation boundary.
      const canvas = document.createElement('canvas'); canvas.width = ctx.canvas.width; canvas.height = ctx.canvas.height
      const g = canvas.getContext('2d'); g.drawImage(ctx.canvas, 0, 0); const png = canvas.toDataURL()
      const width = canvas.width, height = canvas.height, vp = Array.from(render.camera.viewProj), stats = { ...render.stats }
      const inverse = new Float32Array(16); check(groundReviewApi.m4.invert(inverse, render.jitteredViewProj), 'Invert actual jittered depth projection')
      let mask = null
      if (makeMask) {
        check(!visible && view === 0, 'Terrain mask uses meadow-off baseline beauty depth')
        const depth = new Float32Array((await readTexture(render.targets.depth, 0, 4, 'depth-only')).buffer)
        const dw = render.targets.depth.width, dh = render.targets.depth.height, boxes = actorBoxes(width, height)
        const mcanvas = document.createElement('canvas'); mcanvas.width = width; mcanvas.height = height
        const mg = mcanvas.getContext('2d'), pixels = mg.createImageData(width, height)
        let count = 0
        for (let y = 8; y < height - 8; y++) for (let x = 8; x < width - 8; x++) {
          if (boxes.some(b => x >= b[0] && y >= b[1] && x <= b[2] && y <= b[3])) continue
          const dx = Math.min(dw - 1, Math.floor((x + .5) * dw / width)), dy = Math.min(dh - 1, Math.floor((y + .5) * dh / height))
          const z = depth[dy * dw + dx]; if (!(z > 0 && z < 1)) continue
          const nx = (dx + .5) / dw * 2 - 1, ny = 1 - (dy + .5) / dh * 2
          const w = inverse[3] * nx + inverse[7] * ny + inverse[11] * z + inverse[15]
          const wx = (inverse[0] * nx + inverse[4] * ny + inverse[8] * z + inverse[12]) / w
          const wy = (inverse[1] * nx + inverse[5] * ny + inverse[9] * z + inverse[13]) / w
          const wz = (inverse[2] * nx + inverse[6] * ny + inverse[10] * z + inverse[14]) / w
          if (!Number.isFinite(wy) || Math.abs(wy - terrain.heightAt(wx, wz)) > .08) continue
          if ([[0, 0], [.5, 0], [-.5, 0], [0, .5], [0, -.5]].some(([ox, oz]) => terrain.surfaceAt(wx + ox, wz + oz) !== 4)) continue
          const p = (y * width + x) * 4; pixels.data[p] = pixels.data[p + 1] = pixels.data[p + 2] = pixels.data[p + 3] = 255; count++
        }
        mg.putImageData(pixels, 0, 0); mask = { png: mcanvas.toDataURL(), count, depthSize: [dw, dh], actorExclusionBoxes: boxes }
      }
      const exposureNow = await exposure(); check(exposureNow[0] === baselineExposure, 'Exposure scalar drift despite dt=0')
      check(await snapshotDigest() === frozen, 'Authoritative snapshot/time changed during frozen diagnostic')
      const error = await device.popErrorScope(); check(!error, error?.message); check(!stats.dropped && !stats.lightsDropped, 'No dropped production submissions')
      return { visible, view, png, mask, stats, exposure: exposureNow[0], viewProj: vp, eye: Array.from(render.camera.position), width, height }
    }
    globalThis.groundReview = { setCamera, install, verify, capture, cleanup() { render.submit = originalSubmit; render.debugView = originalDebug } }
    return { preWriteBaselineSourceMatched: true, textureAudit: evidence, baselineExposure, snapshotDigest: frozen, frames,
      material: { size: set.size, mipCount: set.mipCount, layers: set.layerCount }, atlas: { size: atlas.size, mipCount: atlas.mipCount, layers: atlas.layerCount, variants: atlas.variantsPerSurface },
      groundSourceStats: mats.groundSourceStats, anchor, environment: { timeOfDay: sky.timeOfDay, weatherKind: sky.weatherKind, wetness: env.wetness,
        sunDir: Array.from(env.sunDir), sunIntensity: env.sunIntensity, windStrength: env.windStrength, motionTime: env.motionTime },
      grass: { count: grass.count, triangles: grass.item.mesh.lods.map(l => l.indexCount / 3), surface: grass.item.surfaceSet, castsShadow: grass.item.castsShadow }, tick: ctx.snapshot.tick }
  }, [baseline.manifest, candidate.manifest])
  console.log(`${TOOL}: live baseline readback PASS (${report.setup.textureAudit.length} texture/mip records); exposure ${report.setup.baselineExposure}`)
  // Fixed, bounded camera-only baseline search; no candidate pixels participate.
  const views = [{ yaw: Math.PI, height: 20 }, { yaw: 2.738, height: 20 }, { yaw: 4.69, height: 20 },
    { yaw: 0, height: 20 }, { yaw: Math.PI, height: 16 }, { yaw: 2.738, height: 16 }]
  let best = null
  for (let i = 0; i < views.length; i++) {
    await page.evaluate(v => groundReview.setCamera(v), views[i])
    const capture = await page.evaluate(() => groundReview.capture(false, 0, true))
    const decoded = imageOf(capture.png), mask = imageOf(capture.mask.png), roi = maskIndices(mask)
    const measures = metrics(decoded, roi), item = { camera: views[i], ...measures, index: i }
    report.cameraSearch.push(item); saveCapture(capture, `search-${i}-baseline-meadow-off`)
    if (!best || item.above180 > best.above180 || (item.above180 === best.above180 && item.p99 > best.p99)) best = item
    console.log(`${TOOL}: baseline camera ${i} ROI ${roi.length}, >180 ${item.above180}, p99 ${item.p99.toFixed(2)}`)
    if (i === 0 && item.above180 >= 500) break
  }
  assert.ok(best?.above180 >= 100 && best.count >= 1000, 'No measurable terrain hotspot in bounded baseline camera matrix; report insufficient evidence, not acceptance')
  report.chosenCamera = best
  await page.evaluate(v => groundReview.setCamera(v), best.camera)
  const captures = {}
  for (const [variant, state] of [['a-baseline', 0], ['b-private', 1], ['a-restored', 0]]) {
    if (variant !== 'a-baseline') report[`${variant}-gpuAudit`] = await page.evaluate(s => groundReview.install(s), state)
    captures[variant] = {}
    for (const visible of [false, true]) {
      const c = await page.evaluate(v => groundReview.capture(v, 0, !v), visible)
      captures[variant][visible ? 'on' : 'off'] = c; saveCapture(c, `${variant}-meadow-${visible ? 'present' : 'absent'}`)
    }
    for (const view of [1, 2, 3]) {
      const c = await page.evaluate(v => groundReview.capture(false, v), view)
      captures[variant][`debug${view}`] = c; saveCapture(c, `${variant}-meadow-absent-debug-${view}`)
    }
    console.log(`${TOOL}: ${variant} captures and GPU checks complete`)
  }
  const a = captures['a-baseline'], b = captures['b-private'], restored = captures['a-restored']
  const roi = maskIndices(imageOf(a.off.mask.png)), base = imageOf(a.off.png)
  const hot = roi.filter(i => luma(base.data, i) > 180), control = roi.filter(i => luma(base.data, i) >= 60 && luma(base.data, i) <= 120)
  report.maskPolicy = 'Fixed baseline grass terrain pixels from actual jittered depth; depth-height agreement <=0.08m; grass surface at center and +/-0.5m cardinal neighbors; projected actor AABBs expanded 8px excluded. Hotspot is baseline meadow-off display luma >180/255. Excludes opaque props by depth, not semantic IDs; no exact pixel ownership claim at edges.'
  assert.ok(hot.length >= 100 && control.length >= 100, 'Need both hotspot and non-hotspot terrain controls')
  writeFileSync(join(out, 'hotspot-mask.png'), maskPng(base.width, base.height, hot))
  writeFileSync(join(out, 'terrain-roi.png'), maskPng(base.width, base.height, roi))
  report.metrics = {}
  for (const [id, group] of Object.entries(captures)) {
    report.metrics[id] = {}
    for (const visibility of ['off', 'on']) {
      const im = imageOf(group[visibility].png)
      report.metrics[id][visibility] = { hotspot: metrics(im, hot), control: metrics(im, control), terrainROI: metrics(im, roi) }
      assert.deepEqual(group[visibility].viewProj, a.off.viewProj, 'Chosen view must stay fixed')
      assert.equal(group[visibility].stats.triangles, a[visibility].stats.triangles, 'Same geometry per meadow control')
    }
  }
  report.controls = { albedo: difference(imageOf(a.debug1.png), imageOf(b.debug1.png), roi),
    normal: difference(imageOf(a.debug2.png), imageOf(b.debug2.png), roi),
    restoredOff: difference(imageOf(a.off.png), imageOf(restored.off.png), roi),
    restoredOn: difference(imageOf(a.on.png), imageOf(restored.on.png), roi) }
  assert.ok(report.controls.albedo.meanAbsRGB < .1 && report.controls.normal.meanAbsRGB < .1, 'Ground albedo/normal render controls unchanged')
  assert.ok(report.controls.restoredOff.meanAbsRGB < 1 && report.controls.restoredOn.meanAbsRGB < 1, 'A/B/A render restoration within quantization/temporal tolerance')
  assert.deepEqual(await page.evaluate(() => globalThis.groundGpuErrors ?? []), []); assert.deepEqual(errors, [])
  await page.evaluate(() => groundReview.cleanup())
  report.status = 'PASS'; report.errors = errors
  console.log(`${TOOL}: PASS — fixed hotspot ${hot.length}px; baseline ${report.metrics['a-baseline'].off.hotspot.mean.toFixed(2)} -> private ${report.metrics['b-private'].off.hotspot.mean.toFixed(2)} display luma; parent visual acceptance required`)
} catch (error) {
  report.status = 'FAIL'; report.error = String(error.stack ?? error); report.errors = errors; throw error
} finally {
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
  if (browser) await browser.close()
  if (preview) await preview.close()
}

function imageOf(url) { return decodePng(Buffer.from(url.split(',')[1], 'base64')) }
function maskIndices(im) { const ids = []; for (let i = 0; i < im.width * im.height; i++) if (im.data[i * 4] > 127) ids.push(i); return ids }
function luma(bytes, i) { return bytes[i * 4] * .2126 + bytes[i * 4 + 1] * .7152 + bytes[i * 4 + 2] * .0722 }
function metrics(im, ids) {
  const values = ids.map(i => luma(im.data, i)).sort((a, b) => a - b)
  const percentile = p => values[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0
  return { count: values.length, mean: values.reduce((a, b) => a + b, 0) / (values.length || 1),
    p95: percentile(.95), p99: percentile(.99), max: values.at(-1) ?? 0,
    above180: values.filter(v => v > 180).length, above220: values.filter(v => v > 220).length }
}
function difference(a, b, ids) {
  assert.equal(a.width, b.width); assert.equal(a.height, b.height)
  let total = 0, max = 0
  for (const i of ids) for (let c = 0; c < 3; c++) { const d = Math.abs(a.data[i * 4 + c] - b.data[i * 4 + c]); total += d; max = Math.max(max, d) }
  return { count: ids.length, meanAbsRGB: total / (ids.length * 3 || 1), maxAbsRGB: max }
}
function maskPng(width, height, ids) { const b = Buffer.alloc(width * height * 4); for (const i of ids) b.fill(255, i * 4, i * 4 + 4); return encodePng(width, height, b) }
function saveCapture(c, label) {
  const bytes = Buffer.from(c.png.split(',')[1], 'base64'), im = decodePng(bytes)
  if (c.view === 0) {
    let lit = 0; for (let i = 0; i < im.width * im.height; i++) if (luma(im.data, i) > 10) lit++
    assert.ok(lit > im.width * im.height * .2, 'Reject blank canvas capture')
  }
  writeFileSync(join(out, `${label}.png`), bytes)
  const { png, mask, ...meta } = c
  report.captures.push({ label, ...meta, pngSha256: hash(bytes), mask: mask && { count: mask.count, depthSize: mask.depthSize, actorExclusionBoxes: mask.actorExclusionBoxes } })
}
