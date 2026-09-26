#!/usr/bin/env node
// DIAGNOSTIC ONLY: four isolated shader variants on a staged production meadow.
// No production edits, rebuild, shared compose, or aesthetic acceptance claim.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { join, resolve, basename, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { build } from 'esbuild'
import { WEB_ROOT, startPreview, stopChild, launchGpuBrowser, loadChromium } from './harness.mjs'
import { decodePng, encodePng } from './png.mjs'

const tier = process.argv.find(a => a.startsWith('--quality='))?.slice(10) ?? 'medium'
assert.ok(['medium', 'high'].includes(tier), 'Use medium or high for this fixed comparison')
const sourceDirArg = process.argv.find(a => a.startsWith('--source-pack='))?.slice(14)
const sourceDir = sourceDirArg ? realpathSync(resolve(sourceDirArg)) : null
const withCaster = process.argv.includes('--caster')
assert.ok(!withCaster || sourceDir, '--caster requires --source-pack: only unchanged-shader baseline/source comparisons are permitted')
const heightsArg = process.argv.find(a => a.startsWith('--heights='))?.slice(10)
const heights = heightsArg === undefined ? [8, 16] : heightsArg.split(',').map(Number)
const cameraSource = readFileSync(join(WEB_ROOT, 'src/camera/index.ts'), 'utf8')
const heightBound = name => {
  const matches = [...cameraSource.matchAll(new RegExp(`const ${name} = ([0-9.]+)`, 'g'))]
  assert.equal(matches.length, 1, 'Production camera bound must be explicit and unique'); return Number(matches[0][1])
}
const heightMin = heightBound('HEIGHT_MIN'), heightMax = heightBound('HEIGHT_MAX')
assert.ok(heights.length >= 1 && heights.length <= 8 && new Set(heights).size === heights.length, 'Require one to eight distinct camera heights')
assert.ok(heights.every(h => Number.isFinite(h) && h >= heightMin && h <= heightMax), `Camera heights must respect production range ${heightMin}..${heightMax}`)
const out = join(WEB_ROOT, '.artifacts/visual-quality/meadow-lighting', sourceDir ? `source-${basename(sourceDir)}` : '',
  heightsArg === undefined ? '' : `heights-${heights.join('-')}`, withCaster ? 'caster-powr' : '')
const hash = value => createHash('sha256').update(value).digest('hex')
const manifest = JSON.parse(readFileSync(join(WEB_ROOT, '.forge/environment/props.json')))
const atlas = JSON.parse(readFileSync(join(WEB_ROOT, '.forge/meadow/manifest.json')))
assert.equal(atlas.layers.length, 29)
assert.deepEqual(['grass', 'grass-lod1', 'grass-lod2'].map(n => manifest.assets[n].triangles), [36, 24, 12])
assert.ok(Math.abs(manifest.assets.grass.bounds[1][1] - .25) < 1e-5, 'Require current half-height whole-card source')
const paths = ['render/shaders.ts', 'render/cutout-shaders.ts', 'render/renderer.ts', 'units/environment.ts', 'units/meadow-distribution.ts', 'materials/foliage-surfaces.ts']
paths.push('camera/index.ts')
if (sourceDir) paths.push('units/blender-mesh.ts', 'units/mesh-bake.ts', 'render/gpumesh.ts')
if (withCaster) paths.push('geo/rig.ts')
const seen = new Set()
for (const file of readdirSync(join(WEB_ROOT, 'dist/assets')).filter(f => f.endsWith('.js.map'))) {
  const map = JSON.parse(readFileSync(join(WEB_ROOT, 'dist/assets', file)))
  for (let i = 0; i < map.sources.length; i++) for (const path of paths) if (map.sources[i].endsWith('/' + path)) {
    assert.equal(map.sourcesContent[i], readFileSync(join(WEB_ROOT, 'src', path), 'utf8'), `Stale production dist ${path}; parent must build before review`)
    seen.add(path)
  }
}
assert.equal(seen.size, paths.length, 'Require production source-map evidence')
const meadow = '(textureNumLayers(matAlbedo) == 29u && vin.layer == 6u && vin.kind == 0u)'
const normal = 'var n = normalize(tbn * surfaceNormalTS);'
const visibility = 'let vis = sunVisibility(vin.worldPos, geoN, viewZ);'
const pigment = 'var baseColor = mix(albedoSample.rgb, paint, sat(mask * vin.tint.a) * 0.88);'
const variants = [
  { id: 'a-baseline', description: 'Unmodified production cutout shader', patch: null },
  { id: 'b-normal-up', description: 'DIAGNOSTIC: meadow mapped world-space shading normal, 60% bias toward up',
    patch: { from: normal, to: `${normal}\n if ${meadow} { n = normalize(mix(n, vec3<f32>(0.0, 1.0, 0.0), 0.60)); }` } },
  { id: 'c-sun-visible', description: 'DIAGNOSTIC: meadow receiver sun visibility forced to one; does not enable grass shadow casting',
    patch: { from: visibility, to: `var vis = sunVisibility(vin.worldPos, geoN, viewZ);\n if ${meadow} { vis = 1.0; }` } },
  { id: 'd-pigment-150', description: 'DIAGNOSTIC: meadow linear base pigment multiplied by 1.5, clamped at one',
    patch: { from: pigment, to: `${pigment}\n if ${meadow} { baseColor = min(baseColor * 1.5, vec3<f32>(1.0)); }` } },
]
let sourceInput = null, decoderBundle = null
let casterSource = null
if (withCaster) {
  const m = JSON.parse(readFileSync(join(WEB_ROOT, '.forge/blender/manifest.json'))), e = m.assets.powr
  assert.ok(e && e.skinned && e.rig && !e.alphaCutout, 'Require saved opaque powr source and rig')
  assert.equal(hash(readFileSync(resolve(WEB_ROOT, '..', e.sourcePath))), e.sourceSha256, 'Caster saved-source SHA')
  const packed = readFileSync(join(WEB_ROOT, '.forge/blender/roster.ssasset.gz'))
  assert.ok(Number.isSafeInteger(m.bytes) && m.bytes > 0 && m.bytes <= 256 * 1024 * 1024, 'Bound current full roster audit to 256MiB')
  const raw = gunzipSync(packed, { maxOutputLength: 256 * 1024 * 1024 })
  assert.equal(raw.length, m.bytes); assert.equal(packed.length, m.storedBytes); assert.equal(hash(raw), m.sha256)
  assert.equal(hash(raw.subarray(e.offset, e.offset + e.bytes)), e.sha256)
  casterSource = { slot: 'powr', entry: e, packSha256: m.sha256 }
}
if (sourceDir) {
  const root = realpathSync(resolve(WEB_ROOT, '..')), names = ['grass', 'grass-lod1', 'grass-lod2']
  const audit = dir => {
    const m = JSON.parse(readFileSync(join(dir, 'props.json'))), packed = readFileSync(join(dir, 'props.ssasset.gz'))
    const raw = gunzipSync(packed, { maxOutputLength: 8 * 1024 * 1024 })
    assert.equal(m.schema, 1); assert.equal(m.storedBytes, packed.length); assert.equal(m.bytes, raw.length); assert.equal(m.sha256, hash(raw))
    assert.deepEqual(Object.keys(m.assets).sort(), Object.keys(manifest.assets).sort())
    let end = 0
    for (const e of Object.values(m.assets).sort((a, b) => a.offset - b.offset)) {
      assert.equal(e.offset, end); assert.equal(e.offset % 4, 0); assert.ok(Number.isInteger(e.bytes) && e.bytes >= 32 && e.bytes % 4 === 0)
      end += e.bytes; assert.ok(end <= raw.length); assert.equal(hash(raw.subarray(e.offset, end)), e.sha256)
      const saved = realpathSync(resolve(root, e.sourcePath)); assert.ok(saved.startsWith(root + sep))
      assert.match(e.sourceSha256, /^[a-f0-9]{64}$/); assert.equal(hash(readFileSync(saved)), e.sourceSha256, 'Saved source/export mismatch')
    }
    assert.equal(end, raw.length)
    names.forEach((name, i) => {
      const e = m.assets[name]
      assert.equal(e.triangles, [36, 24, 12][i]); assert.equal(e.materialSet, 'meadow-v1'); assert.equal(e.alphaCutout, true)
      assert.equal(e.skinned, false); assert.deepEqual(e.materialTable, manifest.assets[name].materialTable)
      assert.deepEqual(e.bounds, manifest.assets[name].bounds)
      if (i) assert.equal(e.meadowParentSha256, m.assets.grass.sourceSha256)
    })
    return { manifest: m, raw: Array.from(raw) }
  }
  sourceInput = { baseline: audit(join(WEB_ROOT, '.forge/environment')), candidate: audit(sourceDir), names }
  for (const name of Object.keys(manifest.assets).filter(n => !names.includes(n)))
    assert.equal(sourceInput.candidate.manifest.assets[name].sha256, manifest.assets[name].sha256, 'Only grass source geometry may differ')
  decoderBundle = (await build({ stdin: { contents: "export { decodeBlenderAsset } from './src/units/blender-mesh.ts'; export { computeWorldTransforms, computeSkinMatrices } from './src/geo/rig.ts'", resolveDir: WEB_ROOT },
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'meadowSourceReviewApi', logLevel: 'silent' })).outputFiles[0].text
  variants.splice(1, variants.length - 1, { id: 'e-source-normals', description: 'STAGED private saved-source normals; unmodified production shader', patch: null, source: true })
}
let preview, browser
const results = []
try {
  preview = await startPreview(8474)
  const launched = await launchGpuBrowser(await loadChromium('meadowlightingreview'), 'meadowlightingreview'); browser = launched.browser
  mkdirSync(out, { recursive: true })
  for (const variant of variants) {
    console.log('meadowlightingreview start', variant.id)
    const page = await browser.newPage({ viewport: { width: 1000, height: 750 }, deviceScaleFactor: 1 }), errors = []
    page.on('pageerror', e => errors.push(e.message))
    page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()) })
    await page.addInitScript(({ variant, guards }) => {
      globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {}
      const create = GPUDevice.prototype.createShaderModule
      const record = { targetModules: 0, replacements: 0, otherLabels: [], modules: [] }
      globalThis.meadowLightingPatch = record
      GPUDevice.prototype.createShaderModule = function (descriptor) {
        if (descriptor.label !== 'render.forward.cutout') { record.otherLabels.push(descriptor.label); return create.call(this, descriptor) }
        if (++record.targetModules !== 1) throw Error('Expected exactly one production forward-cutout module')
        const original = descriptor.code
        for (const text of guards) if (original.split(text).length - 1 !== 1) throw Error('Cutout shader guard must match exactly once: ' + text)
        let patched = original
        if (variant.patch) {
          if (patched.split(variant.patch.from).length - 1 !== 1) throw Error('Diagnostic patch must match exactly once')
          patched = patched.replace(variant.patch.from, variant.patch.to); record.replacements++
        }
        const label = variant.patch ? `render.forward.cutout.DIAGNOSTIC.meadow-lighting.${variant.id}` : descriptor.label
        record.modules.push({ originalLabel: descriptor.label, label, original, patched })
        return create.call(this, { ...descriptor, label, code: patched })
      }
    }, { variant, guards: [normal, visibility, pigment, 'if(albedoSample.a<0.5){discard;}'] })
    await page.goto(`${preview.baseUrl}?devmap=1&manual=1&deterministic=1&devsize=48&devactors=1&devtod=720&weather=clear&quality=${tier}`)
    await page.waitForFunction(() => globalThis.steelseed, undefined, { timeout: 120000, polling: 100 })
    if (decoderBundle) await page.addScriptTag({ content: decoderBundle })
    const result = await page.evaluate(async ({ sourceInput, useSource, heights, casterSource }) => {
      const check = (ok, reason) => { if (!ok) throw Error(reason) }
      const app = steelseed; app.stop(); app.renderOneFrame(0); app.bridge = null
      const ctx = app.ctx, scenery = ctx.get('units').scenery, terrain = ctx.get('terrain'), shroud = ctx.get('shroud')
      const render = ctx.get('render'), sky = ctx.get('sky'), camera = ctx.get('camera'), snap = ctx.snapshot, ground = snap.terrainStatic
      check(ctx.backend === 'webgpu', 'Real WebGPU required')
      const gpuErrors = []; ctx.device.addEventListener('uncapturederror', event => gpuErrors.push(event.error.message)); ctx.device.pushErrorScope('validation')
      const readExposure = async () => {
        const buffer = ctx.device.createBuffer({ label: 'DIAGNOSTIC.meadow-lighting.exposure-readback', size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
        try {
          const encoder = ctx.device.createCommandEncoder()
          encoder.copyBufferToBuffer(render.postChain.exposureBuffer, 0, buffer, 0, 16)
          ctx.device.queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ)
          return Array.from(new Float32Array(buffer.getMappedRange()))
        } finally { buffer.destroy() }
      }
      const bootExposure = await readExposure()
      // Deterministic renderOneFrame(0) advances 1/60s, not zero: remove that boot-only
      // adaptation before the comparison. The production exposure pass then runs dt=0.
      ctx.device.queue.writeBuffer(render.postChain.exposureBuffer, 0, Float32Array.of(.6, .18, 0, 0))
      ground.height.fill(0); ground.ramp.fill(0); ground.resource.fill(0); ground.surface.fill(4)
      snap.flags |= 1 // HeaderFlag.terrainStaticPresent: deliberately publish edited fixture terrain.
      terrain.onSnapshot(snap, null, ctx); scenery.onSnapshot(snap); snap.resources = null
      shroud.cells.fill(2); render.setShroud(shroud.cells, ground.w, ground.h, 0, 0)
      const grass = scenery.pools.get('grass'), material = ctx.get('materials').get('meadow-v1')
      let sourceWitness = null
      if (sourceInput) {
        const { decodeBlenderAsset } = meadowSourceReviewApi
        const baselineBytes = Uint8Array.from(sourceInput.baseline.raw), sourceBytes = Uint8Array.from(sourceInput.candidate.raw)
        // Compare expanded ordered triangle corners: split-normal welding can legitimately
        // change vertex/index counts while preserving every face, UV and winding.
        const corners = mesh => {
          const triangles = []
          for (let t = 0; t < mesh.indices.length; t += 3) {
            const verts = Array.from(mesh.indices.subarray(t, t + 3), v => JSON.stringify([
              ...mesh.positions.subarray(v * 3, v * 3 + 3), ...mesh.uv0.subarray(v * 2, v * 2 + 2),
              ...mesh.uv1.subarray(v * 2, v * 2 + 2), mesh.materialZone[v]]))
            triangles.push([0, 1, 2].map(i => [...verts.slice(i), ...verts.slice(0, i)].join('|')).sort()[0])
          }
          return triangles.sort().join('\n')
        }
        const levels = [], witnesses = []
        for (const name of sourceInput.names) {
          const baseline = decodeBlenderAsset(baselineBytes, sourceInput.baseline.manifest.assets[name])
          const candidate = decodeBlenderAsset(sourceBytes, sourceInput.candidate.manifest.assets[name])
          check(baseline.rig === null && candidate.rig === null && !candidate.mesh.validate(), 'Unskinned valid source meadow')
          check(corners(baseline.mesh) === corners(candidate.mesh), 'Source must preserve exact positions, winding, UV0/UV1 and material per face')
          const m = candidate.mesh, ny = []; let maxTangentDot = 0
          for (let v = 0; v < m.vertexCount; v++) {
            const n = m.normals.subarray(v * 3, v * 3 + 3), tangent = m.tangents.subarray(v * 4, v * 4 + 3)
            check(Math.abs(Math.hypot(...n) - 1) < .001, 'Unit source normal')
            ny.push(n[1]); maxTangentDot = Math.max(maxTangentDot, Math.abs(n[0] * tangent[0] + n[1] * tangent[1] + n[2] * tangent[2]))
          }
          check(maxTangentDot < .001, 'Orthogonal exported source tangent frame')
          witnesses.push({ name, vertices: m.vertexCount, baselineVertices: baseline.mesh.vertexCount, triangles: m.triangleCount,
            expandedCornersUnchanged: true, normalY: { min: Math.min(...ny), max: Math.max(...ny), mean: ny.reduce((s, n) => s + n, 0) / ny.length }, maxTangentDot })
          levels.push(m)
        }
        sourceWitness = { sourcePackSha256: sourceInput.candidate.manifest.sha256, levels: witnesses, installed: !!useSource }
        if (useSource) grass.item.mesh = render.uploadLods(levels, 'DIAGNOSTIC.meadow-lighting.saved-source')
      }
      check(grass && grass.item.surfaceSet === 'meadow-v1' && grass.item.alphaCutout && material.layerCount === 29, 'Require actual meadow cutout material')
      check(grass.item.mesh.lods.map(l => l.indexCount / 3).join(',') === '36,24,12', 'Whole authored LODs required')
      check(Math.abs(grass.item.mesh.aabbMax[1] - .25) < 1e-5, 'Require half-height grass geometry')
      check(!grass.item.castsShadow, 'Current meadow does not cast shadows; variant c tests receiver visibility only')
      sky.environment.motionTime = 4; sky.environment.windStrength = 0; sky.environment.windX = .8; sky.environment.windZ = .6
      sky.environment.rainIntensity = 0; sky.environment.snowIntensity = 0
      render.setEnvironment(sky.environment); render.debugView = 0
      check(sky.timeOfDay === 720 && sky.environment.sunDir[1] > 0, 'Fixed daylight noon with sun above horizon')
      let caster = null, casterSkin = null, casterInfo = null
      if (casterSource) {
        const bucket = ctx.get('units').slotBuckets.get(casterSource.slot)
        check(bucket && bucket.rig && !bucket.item.alphaCutout && bucket.mesh.skinned, 'Require real saved opaque powr bucket')
        check(bucket.mesh.lods[0].indexCount === casterSource.entry.triangles * 3, 'Caster bucket matches saved source triangle count')
        for (let k = 0; k < 3; k++) {
          check(Math.abs(bucket.mesh.aabbMin[k] - casterSource.entry.bounds[0][k]) < 1e-5, 'Caster lower bounds match source')
          check(Math.abs(bucket.mesh.aabbMax[k] - casterSource.entry.bounds[1][k]) < 1e-5, 'Caster upper bounds match source')
        }
        const sk = bucket.rig.skeleton, pose = sk.createPose(), world = sk.createMatrixBuffer()
        casterSkin = sk.createMatrixBuffer()
        meadowSourceReviewApi.computeWorldTransforms(pose, world)
        meadowSourceReviewApi.computeSkinMatrices(sk, world, casterSkin)
        const x = 24, z = 26, scale = 1.5, y = terrain.heightAt(x, z) + 1.2 - bucket.mesh.aabbMin[1] * scale
        const instances = Float32Array.of(scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, x, y, z, 1)
        caster = { mesh: bucket.mesh, surfaceSet: bucket.surfaceSet, instances, instanceCount: 1, playerColors: Uint8Array.of(0),
          castsShadow: true, alphaCutout: false, paletteBases: Uint16Array.of(0), boneCount: sk.boneCount }
        casterInfo = { slot: casterSource.slot, surfaceSet: bucket.surfaceSet, scale, placement: Array.from(instances),
          palette: Array.from(casterSkin), sourceSha256: casterSource.entry.sourceSha256, meshLodTriangles: bucket.mesh.lods.map(l => l.indexCount / 3),
          bounds: [Array.from(bucket.mesh.aabbMin, (n, k) => n * scale + [x, y, z][k]), Array.from(bucket.mesh.aabbMax, (n, k) => n * scale + [x, y, z][k])],
          castsShadow: true, alphaCutout: false, elevationAboveGround: 1.2 }
      }
      const originalEncode = render.encodeFrame.bind(render)
      let serial = 0, latest = null, expectedGrass = false, expectedCaster = false, latestCaster = null
      render.encodeFrame = function () {
        serial++; let found = false, foundCaster = false
        for (let i = 0; i < render.itemCount; i++) {
          const item = render.items[i]
          if (item.alphaCutout) check(item === grass.item, 'No tree/non-meadow cutout may enter this fixture')
          if (item === caster) {
            foundCaster = true
            const main = Array.from(render.itemMainCount.subarray(i * 3, i * 3 + 3)), shadow = Array.from(render.itemShadowCount.subarray(i * 3, i * 3 + 3))
            check(item.castsShadow && !item.alphaCutout && shadow.some(n => n > 0), 'Opaque caster must reach production shadow draw list')
            latestCaster = { main, shadow }
          }
          if (item !== grass.item) continue
          found = true
          const main = Array.from(render.itemMainCount.subarray(i * 3, i * 3 + 3))
          check(render.itemIncluded[i] && main.some(n => n > 0), 'Grass must survive main culling and budget')
          latest = { serial, main, shadow: Array.from(render.itemShadowCount.subarray(i * 3, i * 3 + 3)), included: true }
        }
        check(found === expectedGrass, 'Grass-off reference must contain no grass submission')
        check(foundCaster === expectedCaster, 'Caster submission must match fixture state')
        return originalEncode()
      }
      const captures = []
      for (const height of heights) {
        camera.height = camera.heightGoal = height; camera.yaw = camera.yawGoal = .7
        camera.target[0] = camera.targetGoal[0] = 24; camera.target[2] = camera.targetGoal[2] = 24
        camera.lateUpdate(0, ctx); camera.update(0, ctx)
        check(Math.abs(camera.height - height) < 1e-5, 'Camera height must not be clamped')
        for (const casterVisible of caster ? [false, true] : [false]) for (const visible of [false, true]) {
          expectedGrass = visible; latest = null; expectedCaster = casterVisible; latestCaster = null
          // No global subsystem replacement: simply omit the scenery producer for its off reference.
          const draw = () => {
            terrain.update(0, ctx)
            if (visible) scenery.update(ctx, render, terrain, sky, shroud)
            if (casterVisible) {
              const palette = render.reserveBones(caster.boneCount); check(palette, 'Caster bone capacity')
              palette.matrices.set(casterSkin); caster.paletteBases[0] = palette.base; render.submit(caster)
            }
            render.lateUpdate(0, ctx) // Pause exposure adaptation and scene time, not TAA frame advancement.
          }
          render.historyValid = false; render.frameIndex = 0
          const warm = Math.ceil(render.probes.total / render.probes.updatesPerFrame) + 2
          for (let i = 0; i < warm; i++) draw()
          for (let i = 0; i < 64; i++) draw()
          const copy = document.createElement('canvas'); copy.width = ctx.canvas.width; copy.height = ctx.canvas.height
          copy.getContext('2d').drawImage(ctx.canvas, 0, 0)
          let rootError = 0
          const transforms = visible ? Array.from(grass.transforms.subarray(0, grass.count * 16)) : []
          for (let i = 0; i < transforms.length; i += 16) rootError = Math.max(rootError,
            Math.abs(transforms[i + 13] - (terrain.heightAt(transforms[i + 12], transforms[i + 14]) - .008)))
          check(rootError < 1e-5, 'Root anchoring'); check(render.stats.dropped === 0, 'No renderer budget drops')
          const png = copy.toDataURL(), exposure = await readExposure()
          check(exposure[0] === Math.fround(.6), 'Exposure must remain at identical fixed seed with dt=0')
          captures.push({ height, visible, casterVisible, casterDraw: latestCaster, png, exposure, transforms, count: visible ? grass.count : 0, rootError,
            main: latest?.main ?? [0, 0, 0], shadow: latest?.shadow ?? [0, 0, 0], serial, taaFrames: 64, probeWarmupFrames: warm,
            renderFrameIndex: render.frameIndex, dropped: render.stats.dropped,
            camera: { eye: Array.from(render.camera.position), view: Array.from(camera.view), proj: Array.from(camera.proj) } })
        }
      }
      await ctx.device.queue.onSubmittedWorkDone(); const validation = await ctx.device.popErrorScope()
      check(!validation, validation?.message); check(!gpuErrors.length, gpuErrors.join('; ')); render.encodeFrame = originalEncode
      return { captures, gpuErrors, bootExposure, exposureSeed: Math.fround(.6), sourceWitness, casterInfo, patch: meadowLightingPatch, meshLodTriangles: grass.item.mesh.lods.map(l => l.indexCount / 3),
        grassBounds: [Array.from(grass.item.mesh.aabbMin), Array.from(grass.item.mesh.aabbMax)], castsShadow: grass.item.castsShadow,
        material: { id: material.id, layers: material.layerCount, size: material.size, mipCount: material.mipCount },
        environment: { timeOfDay: sky.timeOfDay, sunDir: Array.from(sky.environment.sunDir), sunColor: Array.from(sky.environment.sunColor),
          sunIntensity: sky.environment.sunIntensity, ambientScale: sky.environment.ambientScale, wind: sky.environment.windStrength, motionTime: sky.environment.motionTime },
        tier: ctx.config.q.name, renderScale: app.frameStats.renderScale, grassBudget: scenery.grassLimit, perCell: scenery.grassPerCell }
    }, { sourceInput, useSource: !!variant.source, heights, casterSource })
    assert.deepEqual(errors, []); assert.equal(result.patch.targetModules, 1); assert.equal(result.patch.replacements, variant.patch ? 1 : 0)
    if (results.length) {
      assert.equal(hash(result.patch.modules[0].original), hash(results[0].patch.modules[0].original), 'Identical production shader source for every variant')
      assert.deepEqual(result.patch.otherLabels, results[0].patch.otherLabels, 'No added/removed shader subsystem')
    }
    if (!variant.patch) assert.equal(hash(result.patch.modules[0].original), hash(result.patch.modules[0].patched), 'Baseline/source mode must leave shader bytes unchanged')
    for (const frame of result.captures) writeFileSync(join(out, `${variant.id}-h${frame.height}-${frame.visible ? 'grass' : 'off'}${withCaster ? frame.casterVisible ? '-caster' : '-no-caster' : ''}.png`), Buffer.from(frame.png.split(',')[1], 'base64'))
    results.push({ variant, ...result }); await page.close(); console.log('meadowlightingreview captured', variant.id)
  }
  const imageOf = frame => decodePng(Buffer.from(frame.png.split(',')[1], 'base64'))
  const frameOf = (r, height, visible, casterVisible = false) => r.captures.find(c => c.height === height && c.visible === visible && c.casterVisible === casterVisible)
  const metrics = []
  for (const height of heights) {
    const baseline = frameOf(results[0], height, true), offFrame = frameOf(results[0], height, false)
    const base = imageOf(baseline), off = imageOf(offFrame), pixelCount = base.width * base.height
    const mask = new Uint8Array(pixelCount), darkMask = new Uint8Array(pixelCount), maskImage = new Uint8Array(pixelCount * 4)
    let influenced = 0, dark = 0
    for (let p = 0; p < pixelCount; p++) {
      const i = p * 4, delta = [0, 1, 2].reduce((s, c) => s + Math.abs(base.data[i + c] - off.data[i + c]), 0)
      const lumaDelta = .2126 * (base.data[i] - off.data[i]) + .7152 * (base.data[i + 1] - off.data[i + 1]) + .0722 * (base.data[i + 2] - off.data[i + 2])
      if (delta > 12) { mask[p] = 1; influenced++ }
      if (mask[p] && lumaDelta < -5) { darkMask[p] = 1; dark++ }
      maskImage[i] = maskImage[i + 1] = maskImage[i + 2] = mask[p] * 255; maskImage[i + 3] = 255
    }
    assert.ok(influenced > 100 && dark > 100, 'Baseline must contain measurable dark grass-influenced pixels')
    writeFileSync(join(out, `baseline-h${height}-influence-mask.png`), encodePng(base.width, base.height, Buffer.from(maskImage)))
    for (const r of results) {
      const onFrame = frameOf(r, height, true), reference = imageOf(frameOf(r, height, false)), on = imageOf(onFrame)
      assert.deepEqual(onFrame.camera, baseline.camera); assert.deepEqual(r.environment, results[0].environment)
      assert.deepEqual(onFrame.transforms, baseline.transforms, 'Exact geometry/placement across shader variants')
      assert.deepEqual(onFrame.main, baseline.main); assert.deepEqual(onFrame.shadow, baseline.shadow)
      assert.equal(hash(reference.data), hash(off.data), 'Grass-off image must remain identical: rejects global exposure/terrain changes')
      const measure = selected => {
        let count = 0, sumAbs = 0, changed = 0, lighter = 0, luminance = 0
        const rgb = [0, 0, 0], baseRgb = [0, 0, 0], offRgb = [0, 0, 0]
        for (let p = 0; p < pixelCount; p++) if (selected[p]) {
          count++; const i = p * 4; let delta = 0
          for (let c = 0; c < 3; c++) { rgb[c] += on.data[i + c]; baseRgb[c] += base.data[i + c]; offRgb[c] += off.data[i + c]; delta += Math.abs(on.data[i + c] - base.data[i + c]) }
          sumAbs += delta; if (delta > 9) changed++
          const d = .2126 * (on.data[i] - base.data[i]) + .7152 * (on.data[i + 1] - base.data[i + 1]) + .0722 * (on.data[i + 2] - base.data[i + 2])
          luminance += d; if (d > 2) lighter++
        }
        return { pixels: count, rgb255: rgb.map(v => v / count), baselineRgb255: baseRgb.map(v => v / count), offRgb255: offRgb.map(v => v / count),
          meanAbsoluteRgbDelta255: sumAbs / (count * 3), meanLumaDelta255: luminance / count, changedPixels: changed, lighterPixels: lighter }
      }
      metrics.push({ variant: r.variant.id, height, influence: measure(mask), baselineDarkInfluence: measure(darkMask) })
    }
  }
  const shadowMetrics = []
  if (withCaster) for (const height of heights) {
    const baseline = results[0], shadedOff = imageOf(frameOf(baseline, height, false, true)), sunnyOff = imageOf(frameOf(baseline, height, false))
    const sunnyGrass = imageOf(frameOf(baseline, height, true)), shadedGrass = imageOf(frameOf(baseline, height, true, true))
    const camera = frameOf(baseline, height, true, true).camera, width = sunnyOff.width, heightPx = sunnyOff.height
    const mul = (m, p) => [0, 1, 2, 3].map(row => m[row] * p[0] + m[4 + row] * p[1] + m[8 + row] * p[2] + m[12 + row] * p[3])
    const bounds = baseline.casterInfo.bounds, projected = []
    for (const x of [bounds[0][0], bounds[1][0]]) for (const y of [bounds[0][1], bounds[1][1]]) for (const z of [bounds[0][2], bounds[1][2]]) {
      const p = mul(camera.proj, mul(camera.view, [x, y, z, 1])); assert.ok(p[3] > 0, 'Caster bounds in front of camera')
      projected.push([(p[0] / p[3] * .5 + .5) * width, (.5 - p[1] / p[3] * .5) * heightPx])
    }
    const exclusion = [Math.min(...projected.map(p => p[0])) - 6, Math.min(...projected.map(p => p[1])) - 6,
      Math.max(...projected.map(p => p[0])) + 6, Math.max(...projected.map(p => p[1])) + 6]
    const cross = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
    const halfHull = points => {
      const hull = []
      for (const p of points) {
        while (hull.length >= 2 && cross(hull.at(-2), hull.at(-1), p) <= 0) hull.pop()
        hull.push(p)
      }
      return hull.slice(0, -1)
    }
    projected.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    const exclusionHull = [...halfHull(projected), ...halfHull([...projected].reverse())]
    assert.ok(exclusionHull.length >= 3, 'Nondegenerate projected caster bounds')
    const outsideCasterBounds = p => {
      let inside = true, near = false
      for (let j = 0; j < exclusionHull.length; j++) {
        const a = exclusionHull[j], b = exclusionHull[(j + 1) % exclusionHull.length]
        if (cross(a, b, p) < 0) inside = false
        const dx = b[0] - a[0], dy = b[1] - a[1]
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
        if (Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t) <= 6) near = true
      }
      return !inside && !near
    }
    const luma = (img, i) => .2126 * img.data[i] + .7152 * img.data[i + 1] + .0722 * img.data[i + 2]
    const mask = new Uint8Array(width * heightPx), maskImage = Buffer.alloc(width * heightPx * 4)
    let pixels = 0
    for (let p = 0; p < mask.length; p++) {
      const x = p % width, y = Math.floor(p / width), i = p * 4
      const outsideCaster = outsideCasterBounds([x, y])
      const grassInfluence = [0, 1, 2].reduce((s, c) => s + Math.abs(sunnyGrass.data[i + c] - sunnyOff.data[i + c]), 0)
      if (outsideCaster && grassInfluence > 12 && luma(shadedOff, i) - luma(sunnyOff, i) < -8 && luma(shadedGrass, i) - luma(sunnyGrass, i) < -5) { mask[p] = 1; pixels++ }
      maskImage[i] = maskImage[i + 1] = maskImage[i + 2] = mask[p] * 255; maskImage[i + 3] = 255
    }
    assert.ok(pixels > 500, `Need substantial grass-influenced terrain shadow outside caster silhouette; got ${pixels}`)
    writeFileSync(join(out, `h${height}-shadow-receiver-mask.png`), encodePng(width, heightPx, maskImage))
    for (const r of results) {
      assert.deepEqual(r.casterInfo, baseline.casterInfo, 'Exact same saved caster geometry, material, placement, and bind palette')
      const f = frameOf(r, height, true, true), sunFrame = frameOf(r, height, true)
      assert.deepEqual(f.camera, camera); assert.deepEqual(f.transforms, sunFrame.transforms)
      assert.deepEqual(f.main, sunFrame.main); assert.deepEqual(f.shadow, [0, 0, 0], 'Grass still casts no shadows')
      assert.deepEqual(f.casterDraw, frameOf(baseline, height, true, true).casterDraw)
      assert.equal(hash(imageOf(frameOf(r, height, false, true)).data), hash(shadedOff.data), 'Caster-on grass-off controls must be pixel-identical across source variants')
      const sun = imageOf(sunFrame), shade = imageOf(f)
      let sumSun = 0, sumShade = 0, darkened = 0
      for (let p = 0; p < mask.length; p++) if (mask[p]) {
        const a = luma(sun, p * 4), b = luma(shade, p * 4); sumSun += a; sumShade += b; if (b < a - 2) darkened++
      }
      const meanSun = sumSun / pixels, meanShade = sumShade / pixels
      assert.ok(meanSun - meanShade > 5 && darkened / pixels > .75, 'Authored grass must retain substantial received opaque-caster shading')
      shadowMetrics.push({ variant: r.variant.id, height, pixels, exclusion, exclusionHull, exclusionMarginPixels: 6, meanSunnyLuma255: meanSun, meanShadedLuma255: meanShade,
        darkening255: meanSun - meanShade, darkenedFraction: darkened / pixels, casterDraw: f.casterDraw })
    }
  }
  const report = { status: 'PASS', diagnostic: true, tier, sourceDir, heights, withCaster, casterSource, shadowMetrics, heightBounds: { min: heightMin, max: heightMax },
    candidateSource: sourceInput?.candidate.manifest ?? null,
    geometryPackSha256: manifest.sha256, meadowSourceSha256: manifest.assets.grass.sourceSha256,
    atlasSha256: atlas.sha256, metrics, results: results.map(r => ({ ...r, captures: r.captures.map(({ png, transforms, ...frame }) => ({ ...frame, transformsSha256: hash(JSON.stringify(transforms)) })),
      patch: { ...r.patch, modules: r.patch.modules.map(({ original, patched, ...m }) => ({ ...m, originalSha256: hash(original), patchedSha256: hash(patched) })) } })),
    limits: ['Variants b/c/d are tool-only diagnostics, not shipping changes or recommendations.',
      'Meadow is isolated by forward-cutout pipeline plus 29 layers, zone6, kind0, and grass-only fixture submissions; these shader fields alone cannot distinguish a tree using the same material layout.',
      'Mask is a fixed baseline grass-on/off influence proxy, including temporal edge pixels; it is not a per-fragment coverage/ID buffer.',
      'RGB measurements are display-referred PNG values, not isolated linear incident irradiance. Grass-off images must match exactly across variants.',
      'Current grass does not cast shadows: c isolates received sun visibility, not proof of grass self-shadowing.',
      'Source mode injects the current production decoder in memory and replaces only grass.item.mesh via production uploadLods; no pack is added to shipping.',
      'Source normals also feed production geoN and thus receiver bias; source mode is not identical to the shader-only mapped-normal diagnostic.',
      'Staged paused noon with validated production camera bounds, not real combat, moving-camera temporal quality, performance, or aesthetic acceptance.',
      withCaster ? 'Caster test reuses saved opaque powr through production skin/submit/shadow paths, elevated 1.2m; mask excludes projected caster bounds. Reports grass-influenced receiver pixels, not per-fragment visibility or shadow-edge bias equivalence.' : 'No deliberate external shadow caster: close captures show directional blade shading, not a controlled sunny-versus-occluded-shadow acceptance test.'] }
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log('meadowlightingreview PASS', JSON.stringify({ out, shadowMetrics, metrics: metrics.map(m => ({ variant: m.variant, height: m.height, pixels: m.baselineDarkInfluence.pixels,
    lumaDelta255: m.baselineDarkInfluence.meanLumaDelta255, absoluteRgbDelta255: m.baselineDarkInfluence.meanAbsoluteRgbDelta255 })) }))
} finally { await browser?.close(); if (preview) await stopChild(preview.server) }
