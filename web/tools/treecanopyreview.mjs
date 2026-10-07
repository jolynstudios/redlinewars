#!/usr/bin/env node
// Actual OpenRA tc04 actors; PRIVATE presentation-source replacement, not canonical boot acceptance.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { build } from 'esbuild'
import { WEB_ROOT, loadChromium, launchGpuBrowser } from './harness.mjs'
import { startPrivateComposed } from './private-composed-preview.mjs'
import { configFor } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'
import { decodePng } from './png.mjs'

const TOOL = 'treecanopyreview', root = resolve(WEB_ROOT, '..')
const arg = (name, fallback) => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const label = arg('label', 'review-v1'), sourceDir = resolve(arg('source-pack', join(WEB_ROOT, '.artifacts/cluster-canopy-v1/after')))
const cutoutReview = process.argv.includes('--cutout')
assert.match(label, /^[a-z0-9-]+$/)
const out = join(WEB_ROOT, '.artifacts/visual-quality/cluster-canopy-v1', label)
assert.ok(!existsSync(join(out, 'report.json')), 'Choose a new label; preserve completed captures')
const hash = b => createHash('sha256').update(b).digest('hex')
function sourceAudit(manifest, packed, limit) {
  assert.equal(manifest.schema, 1); assert.equal(manifest.compression, 'gzip')
  assert.ok(Number.isSafeInteger(manifest.bytes) && manifest.bytes > 0 && manifest.bytes <= limit)
  assert.equal(packed.length, manifest.storedBytes)
  const raw = gunzipSync(packed, { maxOutputLength: limit })
  assert.equal(raw.length, manifest.bytes); assert.equal(hash(raw), manifest.sha256)
  const e = manifest.assets.tc04
  assert.ok(e && !e.hidden && e.skinned && e.template === 'tree')
  assert.ok(Number.isSafeInteger(e.offset) && e.offset >= 0 && e.offset % 4 === 0 && Number.isSafeInteger(e.bytes) && e.bytes > 32 && e.offset + e.bytes <= raw.length)
  assert.equal(hash(raw.subarray(e.offset, e.offset + e.bytes)), e.sha256)
  const path = realpathSync(resolve(root, e.sourcePath)); assert.ok(path.startsWith(root + sep))
  assert.equal(hash(readFileSync(path)), e.sourceSha256)
  return { entry: e, raw }
}
const baselineManifest = JSON.parse(readFileSync(join(WEB_ROOT, '.forge/blender/manifest.json')))
const baseline = sourceAudit(baselineManifest, readFileSync(join(WEB_ROOT, '.forge/blender/roster.ssasset.gz')), 256 * 1048576)
const manifest = JSON.parse(readFileSync(join(sourceDir, 'manifest.json'))), packed = readFileSync(join(sourceDir, 'roster.ssasset.gz'))
const candidate = sourceAudit(manifest, packed, 8 * 1048576)
assert.deepEqual(Object.keys(manifest.assets), ['tc04']); assert.equal(candidate.entry.offset, 0); assert.equal(candidate.entry.bytes, manifest.bytes)
assert.equal(candidate.entry.materialSet, 'foliage-v1'); assert.equal(candidate.entry.alphaCutout, true)
assert.deepEqual(candidate.entry.rig, baseline.entry.rig, 'This bounded canopy study preserves the complete source rig')
assert.deepEqual(candidate.entry.bounds, baseline.entry.bounds, 'Preserve source placement bounds')
assert.ok(candidate.entry.triangles < baseline.entry.triangles); assert.notEqual(candidate.entry.sourceSha256, baseline.entry.sourceSha256)
const lod1Dir = arg('lod1-pack', null), lod2Dir = arg('lod2-pack', null)
assert.equal(!!lod1Dir, !!lod2Dir, 'Both authored LOD packs are required together')
const authored = [lod1Dir, lod2Dir].filter(Boolean).map(dir => {
  const m = JSON.parse(readFileSync(resolve(dir, 'manifest.json'))), packed = readFileSync(resolve(dir, 'roster.ssasset.gz'))
  const audited = sourceAudit(m, packed, 8 * 1048576), e = audited.entry
  assert.deepEqual(Object.keys(m.assets), ['tc04']); assert.equal(e.offset, 0); assert.equal(e.bytes, m.bytes)
  assert.deepEqual(e.rig, candidate.entry.rig); assert.deepEqual(e.materialTable, candidate.entry.materialTable)
  assert.equal(e.alphaCutout, true); assert.equal(e.materialSet, candidate.entry.materialSet)
  return { manifest: m, packed, entry: e }
})
let previousTriangles = candidate.entry.triangles
for (const level of authored) { assert.ok(level.entry.triangles > 0 && level.entry.triangles < previousTriangles); previousTriangles = level.entry.triangles }
const foliage = JSON.parse(readFileSync(join(WEB_ROOT, '.forge/foliage/manifest.json')))
const foliagePacked = readFileSync(join(WEB_ROOT, '.forge/foliage', foliage.file)), foliageRaw = gunzipSync(foliagePacked, { maxOutputLength: 40 * 1048576 })
assert.equal(foliageRaw.length, foliage.bytes); assert.equal(foliagePacked.length, foliage.storedBytes); assert.equal(hash(foliageRaw), foliage.sha256)
assert.equal(hash(readFileSync(resolve(root, foliage.sourcePath))), foliage.sourceSha256)
assert.equal(foliage.id, 'foliage-v1'); assert.equal(foliage.layers.length, 29)
for (const layer of foliage.layers) for (let m = 0; m < foliage.mipCount; m++) for (let c = 0; c < 4; c++) {
  const r = layer.mips[m][c]; assert.equal(r.bytes, (foliage.size >> m) ** 2 * [4, 2, 4, 1][c])
  assert.ok(Number.isSafeInteger(r.offset) && r.offset >= 0 && r.offset + r.bytes <= foliageRaw.length)
  assert.equal(hash(foliageRaw.subarray(r.offset, r.offset + r.bytes)), r.sha256)
}
const wanted = ['units/index.ts', 'units/blender-mesh.ts', 'units/mesh-bake.ts', 'core/place.ts', 'geo/rig.ts', 'geo/mesh.ts',
  'render/renderer.ts', 'render/gpumesh.ts', 'render/cutout-shaders.ts', 'render/shaders.ts', 'render/shadows.ts',
  'materials/index.ts', 'materials/foliage-surfaces.ts', 'camera/index.ts', 'core/asset-pack.ts']
const seen = new Set(), sourceMaps = []
for (const file of readdirSync(join(WEB_ROOT, 'dist/assets')).filter(f => f.endsWith('.js.map'))) {
  const bytes = readFileSync(join(WEB_ROOT, 'dist/assets', file)), map = JSON.parse(bytes); sourceMaps.push({ file, sha256: hash(bytes) })
  for (let i = 0; i < map.sources.length; i++) for (const p of wanted) if (map.sources[i].endsWith('/' + p)) {
    assert.equal(map.sourcesContent[i], readFileSync(join(WEB_ROOT, 'src', p), 'utf8'), `Stale dist ${p}; parent must finish build`); seen.add(p)
  }
}
assert.equal(seen.size, wanted.length)
const injection = await build({ stdin: { contents: `export {decodeBlenderAsset} from './src/units/blender-mesh.ts';
  export {fetchAssetPack} from './src/core/asset-pack.ts'; export {MeshStore} from './src/render/gpumesh.ts';`, resolveDir: WEB_ROOT },
  write: false, bundle: true, platform: 'browser', format: 'iife', globalName: 'treeApi', logLevel: 'silent' })
mkdirSync(out, { recursive: true })
const report = { status: 'running', sourceMaps, baseline: baseline.entry, candidate: candidate.entry,
  authoredLevels: authored.map(({ manifest, entry }) => ({ entry, packSha256: manifest.sha256 })),
  baselinePackSha256: baselineManifest.sha256, candidatePackSha256: manifest.sha256, candidateStoredSha256: hash(packed),
  foliage: { sourceSha256: foliage.sourceSha256, sha256: foliage.sha256 }, captures: [], shaderPatches: 0,
  promotionStatus: 'NOT_ACCEPTED', promotionBlockers: [],
  scope: 'Real private Marigold Town actors; only tc04 presentation bucket replaced. Same frozen snapshot A/B/A. No canonical boot, death/destruction, synthetic actors, FPS or aesthetic acceptance.',
  reflection: 'Not tested: screen-space reflections disabled by high preset. Cutout/shadow binding and submitted counts alone do not prove pixel holes or reflected canopy.' }
const flush = () => writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
let preview, browser, page
const errors = []
try {
  console.log(`${TOOL}: source/pack/rig and source-map checks PASS; starting private 8476`)
  preview = await startPrivateComposed(8476)
  const launched = await launchGpuBrowser(await loadChromium(TOOL), TOOL); browser = launched.browser; report.browser = launched.label
  page = await browser.newPage({ viewport: { width: 1512, height: 982 }, deviceScaleFactor: 1 })
  page.on('pageerror', e => errors.push(e.message))
  await page.route('http://127.0.0.1:8476/__tree-review/candidate.gz', route => route.fulfill({ body: packed, contentType: 'application/octet-stream' }))
  for (let i = 0; i < authored.length; i++) await page.route(`http://127.0.0.1:8476/__tree-review/lod${i + 1}.gz`,
    route => route.fulfill({ body: authored[i].packed, contentType: 'application/octet-stream' }))
  await page.addInitScript(withReadback => {
    globalThis.treeGpuErrors = []
    globalThis.treeShadowReadbackTextures = 0
    if (withReadback) {
      const create = GPUDevice.prototype.createTexture
      GPUDevice.prototype.createTexture = function(desc) {
        if (desc.label === 'render.shadow.map') {
          desc = { ...desc, usage: desc.usage | GPUTextureUsage.COPY_SRC }; treeShadowReadbackTextures++
        }
        return create.call(this, desc)
      }
    }
    const request = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = async function(...args) {
      const device = await request.apply(this, args)
      device.addEventListener('uncapturederror', e => treeGpuErrors.push(e.error.message)); return device
    }
  }, cutoutReview)
  await page.goto(`${preview.baseUrl}?mode=game&platform=null&daylight=day&weather=clear&quality=high`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(() => globalThis.steelseed?.ctx.session.available, undefined, { timeout: 120000, polling: 100 })
  const catalog = await page.evaluate(() => steelseed.ctx.session.getCatalog()), map = catalog.maps.find(m => m.title === 'Marigold Town')
  assert.ok(map)
  const config = configFor(catalog, map, { withBot: false }); config.options.explored = 'True'; config.options.fog = 'False'; config.options.startingunits = 'heavy'
  await page.evaluate(c => steelseed.ctx.session.startSkirmish(c), config)
  await page.waitForFunction(() => steelseed.ctx.snapshot?.actors.count > 0 && document.getElementById('session-ui').hidden, undefined, { timeout: 120000, polling: 100 })
  await page.evaluate(() => steelseed.stop())
  await page.addScriptTag({ content: injection.outputFiles[0].text })
  report.setup = await page.evaluate(async input => {
    const app = steelseed, ctx = app.ctx, renderer = ctx.get('render'), units = ctx.get('units'), terrain = ctx.get('terrain'), camera = ctx.get('camera'), sky = ctx.get('sky'), device = ctx.device
    const check = (ok, why) => { if (!ok) throw Error(why) }, bucket = units.slotBuckets.get('tc04')
    check(ctx.backend === 'webgpu' && bucket?.rig && bucket.paletteBases && sky.timeOfDay === 720, 'Real noon tc04 rig required')
    const original = { mesh: bucket.mesh, rig: bucket.rig, surfaceSet: bucket.surfaceSet, itemMesh: bucket.item.mesh,
      itemSurface: bucket.item.surfaceSet, cutout: bucket.item.alphaCutout, boneCount: bucket.item.boneCount, castsShadow: bucket.item.castsShadow }
    check(original.mesh.lods[0].indexCount / 3 === input.baseline.triangles && original.mesh.lods[0].vertexCount === input.baseline.vertices, 'Actual baseline mesh counts')
    check(original.surfaceSet === (input.baseline.materialSet ?? 'blender') && !!original.cutout === !!input.baseline.alphaCutout, 'Actual baseline material/alpha binding')
    const url = new URL('/__tree-review/candidate.gz', location.href); check(url.origin === location.origin, 'Same-origin source pack only')
    const raw = await treeApi.fetchAssetPack(url.href, input.manifest), decoded = treeApi.decodeBlenderAsset(raw, input.manifest.assets.tc04)
    check(decoded.rig && !decoded.mesh.validate(), 'Candidate production decoder and rig')
    const authoredMeshes = [decoded.mesh]
    for (let i = 0; i < input.lodManifests.length; i++) {
      const m = input.lodManifests[i], url = new URL(`/__tree-review/lod${i + 1}.gz`, location.href)
      check(url.origin === location.origin, 'Same-origin authored LOD only')
      const pack = await treeApi.fetchAssetPack(url.href, m), level = treeApi.decodeBlenderAsset(pack, m.assets.tc04)
      check(level.rig && !level.mesh.validate(), 'Authored LOD production decode'); authoredMeshes.push(level.mesh)
    }
    check(ctx.get('materials').has(input.manifest.assets.tc04.materialSet), 'Candidate authored material must already exist; no palette fallback')
    // A private production MeshStore gives the candidate an independent resource owner.
    // Restoring cannot destroy or disturb the renderer's original mesh store/accounting.
    const store = new treeApi.MeshStore(device), beforeBytes = renderer.meshes.uploadedBytes
    device.pushErrorScope('validation')
    const lodAudit = [], generate = decoded.mesh.generateLodChain
    // Observe the actual QEM output used by upload, including referenced leaf owners.
    // Do not infer preservation from leftover/unreferenced vertex-array entries.
    function auditLevels(levels) {
      for (let level = 0; level < levels.length; level++) {
        const mesh = levels[level], owners = new Set(), leafVertices = new Set()
        let leafTriangles = 0, mixedTangentTriangles = 0
        for (let t = 0; t < mesh.triangleCount; t++) {
          const ids = Array.from(mesh.indices.subarray(t * 3, t * 3 + 3))
          if (!ids.every(v => [6, 26].includes(mesh.materialZone[v] & 31))) continue
          leafTriangles++
          const signs = ids.map(v => mesh.tangents[v * 4 + 3])
          if (Math.min(...signs) < 0 && Math.max(...signs) > 0) mixedTangentTriangles++
          for (const v of ids) {
            leafVertices.add(v)
            for (let j = 0; j < 4; j++) if (mesh.skinWeights[v * 4 + j] > 0) owners.add(mesh.skinIndices[v * 4 + j])
          }
        }
        lodAudit.push({ level, triangles: mesh.triangleCount, vertices: mesh.vertexCount, leafTriangles,
          referencedLeafVertices: leafVertices.size, mixedTangentTriangles,
          missingWindBones: Array.from(decoded.rig.windBones).filter(b => !owners.has(b)) })
      }
      return levels
    }
    let gpu
    if (input.lodManifests.length) {
      auditLevels(authoredMeshes)
      check(lodAudit.every(l => !l.mixedTangentTriangles && !l.missingWindBones.length), 'Authored LOD must preserve every wind owner and consistent leaf tangent signs')
      // Poison simplification in this diagnostic so an accidental QEM path fails loudly.
      for (const mesh of authoredMeshes) mesh.generateLodChain = () => { throw Error('Authored LOD upload must never invoke QEM') }
      gpu = store.uploadLods(authoredMeshes, 'tree-review:tc04:authored')
    } else try {
      decoded.mesh.generateLodChain = function(...args) { return auditLevels(generate.apply(this, args)) }
      gpu = store.upload(decoded.mesh, 'tree-review:tc04:candidate')
    }
    finally { decoded.mesh.generateLodChain = generate }
    const error = await device.popErrorScope(); check(!error, error?.message)
    const rig = { ...decoded.rig, pose: decoded.rig.skeleton.createPose(), world: decoded.rig.skeleton.createMatrixBuffer() }
    const actors = ctx.snapshot.actors, targets = []
    for (let i = 0; i < actors.count; i++) if (ctx.actorTypeName(actors.typeId[i]) === 'tc04')
      targets.push({ id: actors.id[i], x: actors.posX[i] / 1024, z: actors.posY[i] / 1024 })
    targets.sort((a, b) => Math.hypot(a.x - 28, a.z - 36) - Math.hypot(b.x - 28, b.z - 36))
    check(targets.length > 0, 'Actual tc04 actor required'); const target = targets[0]
    const savedBridge = app.bridge; app.bridge = null
    const originalWrite = renderer.writeInstance, originalEncode = renderer.encodeFrame, originalSubmit = renderer.submit
    let variant = 'baseline', packedSlots = [], latest = null, serial = 0
    let omitTree = false
    renderer.submit = function(item) { if (!omitTree || item !== bucket.item) return originalSubmit.call(this, item) }
    renderer.writeInstance = function(...args) {
      if (args[12]?.[args[6]] === target.id) packedSlots.push(args[2])
      return originalWrite.apply(this, args)
    }
    renderer.encodeFrame = function(...args) {
      serial++
      const itemIndex = this.items.indexOf(bucket.item, 0)
      const index = Array.from(bucket.motionIds.subarray(0, bucket.count)).indexOf(target.id)
      const targetMain = [], targetShadow = [], main = [], shadow = []
      if (itemIndex >= 0 && itemIndex < this.itemCount) for (let level = 0; level < 3; level++) {
        const at = itemIndex * 3 + level, mb = this.itemMainBase[at], mc = this.itemMainCount[at], sb = this.itemShadowBase[at], sc = this.itemShadowCount[at]
        main.push(mc); shadow.push(sc)
        if (this.itemIncluded[itemIndex] && packedSlots.some(s => s >= mb && s < mb + mc)) targetMain.push(level)
        if (this.itemIncluded[itemIndex] && packedSlots.some(s => s >= sb && s < sb + sc)) targetShadow.push(level)
      }
      const palette = index >= 0 ? bucket.paletteBases[index] : 0, boneCount = bucket.rig.skeleton.boneCount
      latest = { serial, variant, targetMain, targetShadow, bucketMain: main, bucketShadow: shadow, palette,
        itemIncluded: itemIndex >= 0 ? !!this.itemIncluded[itemIndex] : false,
        bones: Array.from(this.boneData.subarray(palette * 16, (palette + boneCount) * 16)),
        transform: index >= 0 ? Array.from(bucket.instances.subarray(index * 16, index * 16 + 16)) : [],
        material: bucket.item.surfaceSet, cutout: !!bucket.item.alphaCutout, castsShadow: bucket.item.castsShadow,
        tick: ctx.snapshot.tick, motionTime: sky.environment.motionTime, wind: sky.environment.windStrength,
        alpha: ctx.time.alpha, skinStats: { ...units.skinStats }, triangles: bucket.mesh.lods.map(l => l.indexCount / 3) }
      packedSlots = []; return originalEncode.apply(this, args)
    }
    function install(candidate) {
      variant = candidate ? 'candidate' : 'baseline'
      bucket.mesh = bucket.item.mesh = candidate ? gpu : original.mesh
      bucket.rig = candidate ? rig : original.rig
      bucket.surfaceSet = bucket.item.surfaceSet = candidate ? input.manifest.assets.tc04.materialSet : original.surfaceSet
      bucket.item.alphaCutout = candidate ? input.manifest.assets.tc04.alphaCutout : original.cutout
      bucket.item.boneCount = bucket.rig.skeleton.boneCount; bucket.item.castsShadow = original.castsShadow
    }
    function setCamera(height) {
      check(height >= 3.5 && height <= 140, 'Production zoom bounds')
      camera.target[0] = camera.targetGoal[0] = target.x; camera.target[2] = camera.targetGoal[2] = target.z
      camera.height = camera.heightGoal = height; camera.yaw = camera.yawGoal = .4
      camera.lateUpdate(0, ctx); camera.update(0, ctx)
    }
    async function exposure() {
      const b = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      try { const e = device.createCommandEncoder(); e.copyBufferToBuffer(renderer.postChain.exposureBuffer, 0, b, 0, 16); device.queue.submit([e.finish()])
        await b.mapAsync(GPUMapMode.READ); return new Float32Array(b.getMappedRange())[0]
      } finally { b.destroy() }
    }
    const fixedExposure = await exposure(), fixedTime = JSON.stringify(ctx.time)
    const actorBytes = () => JSON.stringify([ctx.snapshot.tick, ...['id', 'typeId', 'posX', 'posY', 'posZ', 'facing', 'flags'].map(k => Array.from(actors[k]))])
    const frozenActors = actorBytes(), frames = Math.ceil(renderer.probes.total / renderer.probes.updatesPerFrame) + 66
    async function capture(height, allowAbsent = false) {
      setCamera(height); renderer.historyValid = false; renderer.frameIndex = 0; device.pushErrorScope('validation')
      for (let i = 0; i < frames; i++) { terrain.update(0, ctx); units.update(0, ctx); renderer.lateUpdate(0, ctx) }
      const canvas = document.createElement('canvas'); canvas.width = ctx.canvas.width; canvas.height = ctx.canvas.height
      canvas.getContext('2d').drawImage(ctx.canvas, 0, 0); const png = canvas.toDataURL()
      check(allowAbsent || (latest.targetMain.length === 1 && latest.palette > 0 && latest.itemIncluded), 'Target must actually draw with nonzero palette')
      check(!renderer.stats.dropped && !renderer.stats.lightsDropped, 'No dropped submissions')
      check(actorBytes() === frozenActors && JSON.stringify(ctx.time) === fixedTime, 'Frozen actors/time unchanged')
      check(await exposure() === fixedExposure, 'Frozen exposure scalar')
      const error = await device.popErrorScope(); check(!error, error?.message)
      return { png, height, witness: latest, camera: { eye: Array.from(renderer.camera.position), viewProj: Array.from(renderer.camera.viewProj) },
        frames, exposure: fixedExposure, stats: { ...renderer.stats }, environment: { timeOfDay: sky.timeOfDay, wetness: sky.environment.wetness, sunDir: Array.from(sky.environment.sunDir) } }
    }
    function leafDisplacement(a, b) {
      const mesh = decoded.mesh; let maxWorld = 0, vertices = 0
      for (let v = 0; v < mesh.vertexCount; v++) {
        if (![0, 1, 2, 3].some(k => mesh.skinIndices[v * 4 + k] > 0 && mesh.skinWeights[v * 4 + k] > 0)) continue
        vertices++
        const positions = []
        for (const sample of [a, b]) {
          const p = [0, 0, 0], x = mesh.positions[v * 3], y = mesh.positions[v * 3 + 1], z = mesh.positions[v * 3 + 2]
          for (let k = 0; k < 4; k++) {
            const weight = mesh.skinWeights[v * 4 + k], o = mesh.skinIndices[v * 4 + k] * 16, m = sample.bones
            for (let j = 0; j < 3; j++) p[j] += weight * (m[o + j] * x + m[o + j + 4] * y + m[o + j + 8] * z + m[o + j + 12])
          }
          const t = sample.transform; positions.push([0, 1, 2].map(j => t[j] * p[0] + t[j + 4] * p[1] + t[j + 8] * p[2] + t[j + 12]))
        }
        maxWorld = Math.max(maxWorld, Math.hypot(...positions[0].map((p, i) => p - positions[1][i])))
      }
      return { vertices, maxWorld }
    }
    async function readTexture(texture, bpp, depth = false) {
      const width = texture.width, height = texture.height, layers = texture.depthOrArrayLayers, row = Math.ceil(width * bpp / 256) * 256
      const buffer = device.createBuffer({ size: row * height * layers, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      try {
        const encoder = device.createCommandEncoder(); encoder.copyTextureToBuffer({ texture, ...(depth ? { aspect: 'depth-only' } : {}) },
          { buffer, bytesPerRow: row, rowsPerImage: height }, { width, height, depthOrArrayLayers: layers })
        device.queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ)
        const src = new Uint8Array(buffer.getMappedRange()), packed = new Uint8Array(width * height * layers * bpp)
        for (let y = 0; y < height * layers; y++) packed.set(src.subarray(y * row, y * row + width * bpp), y * width * bpp)
        return packed
      } finally { buffer.destroy() }
    }
    async function cutoutWitness() {
      check(treeShadowReadbackTextures > 0, 'Shadow COPY_SRC instrumentation required')
      install(true)
      const samples = [], images = []
      device.pushErrorScope('validation')
      try {
        for (const mode of ['absent', 'opaque', 'cutout']) {
          omitTree = mode === 'absent'; bucket.item.alphaCutout = mode === 'cutout'
          const shot = await capture(8, omitTree); images.push({ mode, ...shot })
          const [depth, metadata, shadow] = await Promise.all([readTexture(renderer.targets.depth, 4, true),
            readTexture(renderer.targets.reflection, 4), readTexture(renderer.shadows.texture, 4, true)])
          samples.push({ depth: new Float32Array(depth.buffer), metadata, shadow: new Float32Array(shadow.buffer) })
        }
      } finally { omitTree = false; bucket.item.alphaCutout = true }
      const [absent, opaque, cutout] = samples
      let full = 0, covered = 0, holes = 0, metadataLeaks = 0, metadataChanges = 0, shadowFull = 0, shadowCovered = 0, shadowHoles = 0
      for (let p = 0; p < opaque.depth.length; p++) if (opaque.depth[p] > absent.depth[p] + 1e-7) {
        full++
        if (cutout.depth[p] > absent.depth[p] + 1e-7) {
          covered++
          if ([0, 1, 2, 3].some(k => cutout.metadata[p * 4 + k] !== absent.metadata[p * 4 + k])) metadataChanges++
        } else if (Math.abs(cutout.depth[p] - absent.depth[p]) < 1e-7) {
          holes++
          if ([0, 1, 2, 3].some(k => cutout.metadata[p * 4 + k] !== absent.metadata[p * 4 + k])) metadataLeaks++
        }
      }
      const cascadeMetrics = [], perCascade = renderer.shadows.texture.width * renderer.shadows.texture.height
      for (let layer = 0; layer < renderer.shadows.texture.depthOrArrayLayers; layer++) {
        let full = 0, covered = 0, holes = 0
        for (let p = layer * perCascade; p < (layer + 1) * perCascade; p++) if (opaque.shadow[p] > absent.shadow[p] + 1e-7) {
          full++
          if (cutout.shadow[p] > absent.shadow[p] + 1e-7) covered++
          else if (Math.abs(cutout.shadow[p] - absent.shadow[p]) < 1e-7) holes++
        }
        cascadeMetrics.push({ layer, full, covered, holes }); shadowFull += full; shadowCovered += covered; shadowHoles += holes
      }
      const error = await device.popErrorScope(); check(!error, error?.message)
      const result = { full, covered, holes, metadataLeaks, metadataChanges, shadowFull, shadowCovered, shadowHoles, cascadeMetrics, images,
        limitation: 'Private actual tc04 bucket absent/opaque/cutout controls at one frozen pose, h8. Metadata-hole and cascade coverage witness, NOT reflected image or forward-color-hole equivalence. Other real scene geometry remains.' }
      // Return failed evidence too: the Node owner saves images/report before asserting.
      return result
    }
    globalThis.treeReview = { install, capture, cutoutWitness, latest: () => latest, leafDisplacement,
      startLive() { install(true); setCamera(3.5); app.bridge = savedBridge; app.start() },
      cleanup() {
        app.stop(); install(false); renderer.writeInstance = originalWrite; renderer.encodeFrame = originalEncode; renderer.submit = originalSubmit
        check(bucket.mesh === original.mesh && bucket.item.mesh === original.itemMesh && bucket.rig === original.rig, 'Original resources restored')
        store.dispose(); check(store.uploadedBytes === 0 && store.uploadedCount === 0, 'Only candidate store disposed')
        check(renderer.meshes.uploadedBytes === beforeBytes, 'Original renderer mesh accounting preserved')
        return { restored: true, candidateBytes: store.uploadedBytes, originalBytes: beforeBytes }
      } }
    return { target, actualTc04Actors: targets.length, baselineTriangles: original.mesh.lods.map(l => l.indexCount / 3),
      candidateTriangles: gpu.lods.map(l => l.indexCount / 3), candidateBytes: store.uploadedBytes, fixedExposure, frames, lodAudit,
      lodPolicy: input.lodManifests.length ? 'Candidate uses three decoded authored meshes through production MeshStore.uploadLods; zero QEM. Baseline remains current production QEM.' :
        'Both use current production MeshStore.upload runtime QEM (1,.5,.25); not authored LOD acceptance.',
      material: { id: ctx.get('materials').get('foliage-v1').id, layers: ctx.get('materials').get('foliage-v1').layerCount },
      sourcePlacementBounds: input.baseline.bounds, baselineGpuBounds: [Array.from(original.mesh.aabbMin), Array.from(original.mesh.aabbMax)],
      candidateGpuBounds: [Array.from(gpu.aabbMin), Array.from(gpu.aabbMax)] }
  }, { baseline: baseline.entry, manifest, lodManifests: authored.map(p => p.manifest) })
  for (const lod of report.setup.lodAudit) {
    if (lod.missingWindBones.length) report.promotionBlockers.push(`LOD${lod.level} loses referenced leaf owners ${lod.missingWindBones.join(',')}`)
    if (lod.mixedTangentTriangles) report.promotionBlockers.push(`LOD${lod.level} contains ${lod.mixedTangentTriangles} mixed-sign leaf tangent triangles`)
  }
  if (report.promotionBlockers.length) report.promotionStatus = 'BLOCKED'
  flush(); console.log(`${TOOL}: actual actor ${report.setup.target.id}, candidate decoded/uploaded; capturing A/B/A; promotion ${report.promotionStatus}`)
  const frames = new Map()
  // Each distance finishes its complete A/B/A before moving; first near pair is delivered early.
  for (const [view, height] of [['near', 3.5], ['game', 20], ['mid-lod1', 45], ['far', 100]]) {
    for (const [name, candidate] of [['baseline', false], ['candidate', true], ['restored', false]]) {
      await page.evaluate(v => treeReview.install(v), candidate)
      const c = await page.evaluate(h => treeReview.capture(h), height), png = Buffer.from(c.png.split(',')[1], 'base64')
      const decoded = decodePng(png); let lit = 0
      for (let p = 0; p < decoded.data.length; p += 4) if (decoded.data[p] + decoded.data[p + 1] + decoded.data[p + 2] > 30) lit++
      assert.ok(lit > decoded.width * decoded.height * .2, 'Reject invalid/blank canvas capture')
      writeFileSync(join(out, `${view}-${name}.png`), png)
      const { png: unused, ...meta } = c; report.captures.push({ name, view, ...meta, pngSha256: hash(png) }); frames.set(`${view}-${name}`, { ...meta, decoded })
      flush(); console.log(`${TOOL}: ${view}-${name}.png ready; target mainLOD ${c.witness.targetMain}, shadowLOD ${c.witness.targetShadow}; bucket counts ${c.witness.bucketMain}`)
    }
    const a = frames.get(`${view}-baseline`), b = frames.get(`${view}-candidate`), restored = frames.get(`${view}-restored`)
    assert.deepEqual(a.camera, b.camera); assert.deepEqual(a.camera, restored.camera)
    assert.deepEqual(a.witness.bones, restored.witness.bones); assert.deepEqual(a.witness.transform, restored.witness.transform)
    let delta = 0, restoredDelta = 0
    for (let i = 0; i < a.decoded.data.length; i++) { delta += Math.abs(a.decoded.data[i] - b.decoded.data[i]); restoredDelta += Math.abs(a.decoded.data[i] - restored.decoded.data[i]) }
    report[`${view}Comparison`] = { meanAbsRGBA: delta / a.decoded.data.length, restoredMeanAbsRGBA: restoredDelta / a.decoded.data.length }
    assert.ok(delta > 0, 'Candidate must change actual pixels'); assert.ok(restoredDelta / a.decoded.data.length < .25, 'Restored image convergence')
  }
  assert.equal(frames.get('near-candidate').witness.targetMain[0], 0, 'Near must witness actual LOD0')
  assert.equal(frames.get('mid-lod1-candidate').witness.targetMain[0], 1, 'Mid-distance must witness actual target LOD1')
  assert.equal(frames.get('far-candidate').witness.targetMain[0], 2, 'Far must witness actual LOD2')
  if (cutoutReview) {
    console.log(`${TOOL}: frozen A/B/A captures ready; measuring actual cutout depth/metadata/shadow holes`)
    const result = await page.evaluate(() => treeReview.cutoutWitness())
    for (const image of result.images) {
      writeFileSync(join(out, `cutout-${image.mode}.png`), Buffer.from(image.png.split(',')[1], 'base64')); delete image.png
    }
    report.cutout = result; report.reflection = 'Actual reflection metadata tested at alpha holes; no visible SSR/reflected-image claim.'; flush()
    assert.ok(result.full > 100 && result.covered > 20 && result.holes > 20, 'Actual card geometry needs measurable covered pixels and holes')
    assert.equal(result.metadataLeaks, 0, 'Alpha holes must retain underlying real-scene reflection metadata')
    assert.ok(result.metadataChanges > 20, 'Visible canopy must actually write metadata')
    assert.ok(result.shadowFull > 100 && result.shadowCovered > 20 && result.shadowHoles > 20, 'Actual cascades need retained canopy shadow AND holes')
    console.log(`${TOOL}: cutout depth ${result.holes} holes, metadata leaks ${result.metadataLeaks}, shadow ${result.shadowCovered} covered/${result.shadowHoles} holes`)
  }
  console.log(`${TOOL}: frozen captures ready; starting actual-clock candidate wind/pause/resume`)
  await page.evaluate(() => treeReview.startLive())
  await page.waitForFunction(() => treeReview.latest()?.variant === 'candidate' && treeReview.latest().targetMain.length === 1, undefined, { timeout: 10000 })
  const samples = []
  for (let i = 0; i < 12; i++) { await page.waitForTimeout(250); samples.push(await page.evaluate(() => treeReview.latest())) }
  await page.evaluate(() => steelseed.ctx.session.setPaused(true))
  await page.waitForFunction(() => (steelseed.ctx.snapshot.flags & 2) !== 0, undefined, { timeout: 30000 })
  const pauseSerial = await page.evaluate(() => treeReview.latest().serial)
  await page.waitForFunction(s => treeReview.latest().serial >= s + 3, pauseSerial, { timeout: 10000 })
  const pausedA = await page.evaluate(() => treeReview.latest())
  await page.waitForFunction(s => treeReview.latest().serial >= s + 3, pausedA.serial, { timeout: 10000 })
  const pausedB = await page.evaluate(() => treeReview.latest())
  assert.equal(pausedA.tick, pausedB.tick); assert.equal(pausedA.motionTime, pausedB.motionTime)
  assert.deepEqual(pausedA.bones, pausedB.bones); assert.deepEqual(pausedA.transform, pausedB.transform)
  await page.evaluate(() => steelseed.ctx.session.setPaused(false))
  await page.waitForFunction(t => treeReview.latest().tick > t, pausedB.tick, { timeout: 10000 })
  await page.waitForTimeout(500)
  const resumed = await page.evaluate(() => treeReview.latest())
  assert.ok(resumed.motionTime > pausedB.motionTime)
  const movement = await page.evaluate(samples => samples.slice(1).map(s => treeReview.leafDisplacement(samples[0], s)), samples)
  assert.ok(samples.at(-1).tick > samples[0].tick && Math.max(...movement.map(m => m.maxWorld)) > .001, 'Real clock moves actual submitted leaf geometry')
  for (const s of [...samples, pausedA, pausedB, resumed]) assert.ok(s.palette > 0 && s.targetMain.length === 1, 'Target keeps animated visible palette')
  report.wind = { samples, pausedA, pausedB, resumed, movement, maxWorld: Math.max(...movement.map(m => m.maxWorld)),
    caveat: 'World displacement from production-decoded source vertices and actual submitted palettes; not a per-pixel animation threshold.' }
  report.cleanup = await page.evaluate(() => treeReview.cleanup())
  assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => treeGpuErrors), [])
  for (const entry of [baseline.entry, candidate.entry, ...authored.map(p => p.entry)]) assert.equal(hash(readFileSync(resolve(root, entry.sourcePath))), entry.sourceSha256, 'Source changed during capture')
  report.status = 'PASS'; report.errors = errors; flush()
  console.log(`${TOOL}: diagnostic PASS, promotion ${report.promotionStatus}; live wind ${report.wind.maxWorld.toFixed(6)}m, pause stable across fresh frames; ${out}`)
} catch (e) { report.status = 'FAIL'; report.error = String(e.stack ?? e); report.errors = errors; flush(); throw e }
finally {
  if (page && !page.isClosed()) { try { await page.evaluate(() => globalThis.treeReview?.cleanup()) } catch { /* original error retained */ } }
  await browser?.close(); await preview?.close()
}
