#!/usr/bin/env node
// Actual LOD+motion loaders/decoder, mocked same-origin fetch. No GPU, build output or compose.
import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { build } from 'esbuild'

const web = resolve(import.meta.dirname, '..'), game = resolve(web, '..')
const hash = data => createHash('sha256').update(data).digest('hex')
const readJson = path => JSON.parse(readFileSync(resolve(web, path)))
const manifest = readJson('.forge/human-lods/manifest.json'), motionManifest = readJson('.forge/human-motion/manifest.json')
const surface = readJson('.forge/human-surfaces/manifest.json')
const gzip = readFileSync(resolve(web, '.forge/human-lods/lods.ssmesh.gz'))
const raw = gunzipSync(gzip, { maxOutputLength: 6 * 1024 * 1024 })
const motionGzip = readFileSync(resolve(web, '.forge/human-motion/walk.ssanim.gz'))
const lodUrl = '/assets/lods.ssmesh-gate.gz', motionUrl = '/assets/walk.ssanim-gate.gz'
// The timed aim/fire packs are fetched by NAME out of the same glob record, so the mock has to
// be keyed by path rather than by position: a positional stub would silently hand every clip
// the walk's bytes and the mask check downstream would be proving nothing.
const clipUrl = clip => `/assets/${clip.file.replace('.ssanim.gz', '')}-gate.gz`
const clipGzip = new Map(motionManifest.clips.map(clip =>
  [clipUrl(clip), readFileSync(resolve(web, '.forge/human-motion', clip.file))]))
const clipUrls = motionManifest.clips.map(clipUrl)
const slots = { lodManifest: {}, lodPack: {}, motionManifest: {}, motionPack: {} }
const savedFetch = globalThis.fetch, savedLocation = globalThis.location
globalThis.__humanAssetsGateSlots = slots
globalThis.location = { href: 'http://localhost/steelseed/index.html?humanunits=1', origin: 'http://localhost' }
let lodBytes = gzip, motionBytes = motionGzip, requests = [], status = 200
globalThis.fetch = async requested => {
  assert.ok(requested === lodUrl || requested === motionUrl || clipGzip.has(requested),
    'No source/provenance or external fetch')
  requests.push(requested)
  if (clipGzip.has(requested)) return new Response(clipGzip.get(requested), { status })
  return new Response(requested === lodUrl ? lodBytes : motionBytes, { status })
}
function reset() {
  for (const slot of Object.values(slots)) for (const key of Object.keys(slot)) delete slot[key]
  slots.lodManifest.file = manifest; slots.lodPack.file = lodUrl
  slots.motionManifest.file = motionManifest
  // Walk first: the walk loader still takes the first value out of this record.
  slots.motionPack['../../.forge/human-motion/walk.ssanim.gz'] = motionUrl
  for (const clip of motionManifest.clips) slots.motionPack[`../../.forge/human-motion/${clip.file}`] = clipUrl(clip)
  lodBytes = gzip; motionBytes = motionGzip; requests = []; status = 200
}
const bundle = await build({ stdin: { contents: `
  export * from './src/units/human-assets.ts'
  export { validateHumanMotionPose, sampleHumanMotion } from './src/units/human-motion.ts'
  export { decodeBlenderAsset } from './src/units/blender-mesh.ts'
  export { Mesh } from './src/geo/mesh.ts'
`, resolveDir: web }, bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
  define: { 'import.meta.glob': '__gateGlob' }, banner: { js: `const __gateGlob = pattern => {
    const kind = pattern.includes('/human-lods/') ? 'lod' : 'motion';
    return globalThis.__humanAssetsGateSlots[kind + (pattern.endsWith('manifest.json') ? 'Manifest' : 'Pack')];
  };` } })
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
let qemCalls = 0
api.Mesh.prototype.generateLodChain = api.Mesh.prototype.simplify = () => { qemCalls++; throw new Error('Unexpected runtime decimation') }
const checks = [], check = async (name, run) => { reset(); await run(); checks.push(name) }
const channels = ['positions', 'normals', 'tangents', 'uv0', 'uv1', 'materialZone', 'indices', 'skinIndices', 'skinWeights']
const align4 = n => Math.ceil(n / 4) * 4
function patchedPayload(mutate, fixChecksum = true) {
  const m = structuredClone(manifest), bytes = Buffer.from(raw), level = m.levels[2]
  mutate(bytes, level)
  if (fixChecksum) {
    let checksum = 2166136261
    for (let i = level.offset + 32; i < level.offset + level.bytes; i++) checksum = Math.imul(checksum ^ bytes[i], 16777619) >>> 0
    bytes.writeUInt32LE(checksum, level.offset + 20)
  }
  level.sha256 = hash(bytes.subarray(level.offset, level.offset + level.bytes))
  const compressed = gzipSync(bytes); m.sha256 = hash(bytes); m.storedBytes = compressed.length
  return { manifest: m, bytes: compressed }
}
let actual
try {
  await check('optional absent pair returns null without fetching motion', async () => {
    delete slots.lodManifest.file; delete slots.lodPack.file
    assert.equal(await api.loadHumanAssets(surface.sourceSha256), null); assert.deepEqual(requests, [])
  })
  for (const slot of ['lodManifest', 'lodPack']) await check(`half LOD pair missing: ${slot}`, async () => {
    delete slots[slot].file
    await assert.rejects(() => api.loadHumanAssets(surface.sourceSha256), /incomplete/); assert.deepEqual(requests, [])
  })
  await check('actual loader, exact source channels and shared twenty-bone/material contract', async () => {
    assert.equal(raw.length, manifest.bytes); assert.equal(gzip.length, manifest.storedBytes); assert.equal(hash(raw), manifest.sha256)
    const metadataBefore = JSON.stringify(manifest), bytesBefore = hash(raw)
    actual = await api.loadHumanAssets(surface.sourceSha256)
    assert.deepEqual(requests, [lodUrl, motionUrl, ...clipUrls])
    // The authored LOD budgets, not a snapshot of one mesh: pinning exact counts made this
    // gate fail on any deliberate geometry edit while proving nothing the manifest does not.
    const counts = actual.levels.map(x => x.mesh.triangleCount)
    assert.deepEqual(counts, manifest.levels.map(level => level.triangles))
    assert.ok(counts[0] > counts[1] && counts[1] > counts[2], `LOD triangle counts must decrease: ${counts}`)
    counts.forEach((n, i) => assert.ok(n > 0 && n <= [10000, 5500, 2800][i], `LOD${i} outside its authored budget: ${n}`))
    const directBytes = Uint8Array.from(raw)
    for (let i = 0; i < 3; i++) {
      const direct = api.decodeBlenderAsset(directBytes, manifest.levels[i]), loaded = actual.levels[i]
      assert.equal(loaded.rig.skeleton.boneCount, 20)
      assert.deepEqual(loaded.rig.skeleton.names, actual.levels[0].rig.skeleton.names)
      assert.ok(loaded.rig.capturedVertices.every(n => n > 0))
      for (const channel of channels) assert.deepEqual(loaded.mesh[channel], direct.mesh[channel], channel)
      assert.ok(loaded.mesh.materialZone.every(zone => zone === 0))
      const pose = loaded.rig.skeleton.createPose(); api.validateHumanMotionPose(actual.motion, pose)
      api.sampleHumanMotion(actual.motion, pose, .071); assert.ok(pose.t.every(Number.isFinite) && pose.r.every(Number.isFinite))
    }
    assert.equal(hash(raw), bytesBefore); assert.equal(JSON.stringify(manifest), metadataBefore)
    assert.equal(actual.motion.data.byteLength, 18480)
  })
  await check('saved parent/LOD/motion sources match hashes, atlas binds exact parent', () => {
    const sources = [[manifest.parentSourcePath, manifest.parentSourceSha256], ...manifest.levels.map(l => [l.sourcePath, l.sourceSha256]),
      [motionManifest.sourcePath, motionManifest.sourceSha256]]
    const sourceRoot = realpathSync(resolve(game, 'art/blender')) + sep
    for (const [path, sha] of sources) {
      const absolute = realpathSync(resolve(game, path)); assert.ok(absolute.startsWith(sourceRoot)); assert.equal(hash(readFileSync(absolute)), sha, path)
    }
    assert.equal(surface.sourceSha256, manifest.parentSourceSha256)
  })
  await check('host-decompressed packs and reordered JSON object keys', async () => {
    lodBytes = raw; motionBytes = gunzipSync(motionGzip)
    const m = structuredClone(manifest)
    m.levels[1].rig = Object.fromEntries(Object.entries(m.levels[1].rig).reverse())
    m.levels[2].materialTable[0] = Object.fromEntries(Object.entries(m.levels[2].materialTable[0]).reverse())
    const result = await api.verifyHumanAssets(m, lodUrl, surface.sourceSha256)
    assert.equal(result.levels.length, 3); assert.deepEqual(result.motion.data, actual.motion.data)
  })
  const negative = [
    ['schema', m => { m.schema = 2 }], ['identity', m => { m.id = 'other' }],
    ['compression', m => { m.compression = 'none' }], ['filename', m => { m.file = 'elsewhere.gz' }],
    ['two levels', m => { m.levels.pop() }], ['four levels', m => { m.levels.push(m.levels[2]) }],
    ['missing level', m => { m.levels[1] = null }], ['raw budget', m => { m.bytes = 6 * 1024 * 1024 + 1 }],
    ['zero raw bytes', m => { m.bytes = 0 }], ['stored budget', m => { m.storedBytes = 7000000 }],
    ['zero stored bytes', m => { m.storedBytes = 0 }], ['whole SHA shape', m => { m.sha256 = 'bad' }],
    ['parent SHA', m => { m.parentSourceSha256 = '0'.repeat(64) }],
    ['parent path traversal', m => { m.parentSourcePath = 'art/blender/../bad.blend' }],
    ['LOD source hash', m => { m.levels[2].sourceSha256 = 'bad' }],
    ['LOD source path', m => { m.levels[2].sourcePath = 'https://example.com/source.blend' }],
    ['level ordinal', m => { m.levels[2].level = 1 }], ['static level', m => { m.levels[2].skinned = false }],
    ['hidden level', m => { m.levels[2].hidden = true }],
    ['LOD0 triangle cap', m => { m.levels[0].triangles = 10001 }],
    ['LOD1 triangle cap', m => { m.levels[1].triangles = 5501 }],
    ['LOD2 triangle cap', m => { m.levels[2].triangles = 2801 }],
    ['nondecreasing triangles', m => { m.levels[1].triangles = m.levels[0].triangles }],
    ['fractional count', m => { m.levels[2].vertices = 3.5 }],
    ['unbounded vertices', m => { m.levels[2].vertices = Number.MAX_SAFE_INTEGER }],
    ['empty triangles', m => { m.levels[2].triangles = 0 }],
    ['range gap', m => { m.levels[1].offset += 4 }], ['range overlap', m => { m.levels[1].offset -= 4 }],
    ['unaligned offset', m => { m.levels[2].offset++ }], ['incorrect slice length', m => { m.levels[2].bytes += 4 }],
    ['slice SHA shape', m => { m.levels[2].sha256 = 'bad' }], ['unclaimed bytes', m => { m.bytes += 4 }],
    ['missing provenance', m => { m.levels[2].externalSources = [] }],
    ['duplicate provenance', m => { m.levels[2].externalSources[1] = m.levels[2].externalSources[0] }],
    ['unlocked source', m => { m.levels[2].externalSources[0].sha256 = '0'.repeat(64) }],
    ['changed source URL', m => { m.levels[2].externalSources[0].url = 'https://example.com/fake' }],
    ['source license', m => { m.levels[2].externalSources[0].license = 'unknown' }],
    ['material set', m => { m.levels[2].materialSet = 'other' }],
    ['two material layers', m => { m.levels[2].materialTable.push(m.levels[2].materialTable[0]) }],
    ['wrong material layer', m => { m.levels[2].materialTable[0].layer = 1 }],
    ['wrong material zone', m => { m.levels[2].materialTable[0].zone = 1 }],
    ['different material binding', m => { m.levels[2].materialTable[0].name = 'different' }],
    ['cutout', m => { m.levels[2].alphaCutout = true }],
    ['projected UVs', m => { m.levels[2].uvMapping.projectedObjects = 1 }],
    ['no authored UVs', m => { m.levels[2].uvMapping.authoredObjects = 0 }],
    ['UV origin', m => { m.levels[2].uvMapping.origin = 'top-left' }],
    ['bounds nonfinite', m => { m.levels[2].bounds[0][0] = NaN }],
    ['bounds reversed', m => { m.levels[2].bounds[0][0] = 1 }],
    ['wrong bone count', m => { m.levels[2].rig.bones.pop() }],
    ['renamed bone', m => { m.levels[2].rig.bones[3].name = 'another' }],
    ['duplicate bone', m => { m.levels[2].rig.bones[3].name = m.levels[2].rig.bones[2].name }],
    ['parent order', m => { m.levels[2].rig.bones[3].parent = 4 }],
    ['nonfinite bone position', m => { m.levels[2].rig.bones[3].pos[0] = NaN }],
    ['bone kind', m => { m.levels[2].rig.bones[3].kind = 100 }],
    ['zero bind quaternion', m => { m.levels[2].rig.bones[3].rot = [0, 0, 0, 0] }],
    ['zero bind scale', m => { m.levels[2].rig.bones[3].scale = [1, 0, 1] }],
    ['unsupported bone field', m => { m.levels[2].rig.bones[3].axis = NaN }],
    ['invalid animation joint', m => { m.levels[2].rig.legBones[0] = 20 }],
    ['invalid animation phase', m => { m.levels[2].rig.legPhase[0] = NaN }],
    ['secondary animation', m => { m.levels[2].rig.rotors.push({ bone: 1, speed: 1 }) }],
  ]
  for (const [name, mutate] of negative) await check(`prefetch reject: ${name}`, async () => {
    const m = structuredClone(manifest); mutate(m)
    await assert.rejects(() => api.verifyHumanAssets(m, lodUrl, surface.sourceSha256))
    assert.deepEqual(requests, [])
  })
  await check('wrong/invalid atlas SHA rejected before fetch', async () => {
    for (const sha of ['bad', '0'.repeat(64)]) await assert.rejects(() => api.loadHumanAssets(sha), /atlas/)
    assert.deepEqual(requests, [])
  })
  await check('cross-origin/data URLs rejected before fetch', async () => {
    for (const url of ['https://example.com/a.gz', '//example.com/a.gz', 'data:application/gzip;base64,AA=='])
      await assert.rejects(() => api.verifyHumanAssets(manifest, url, surface.sourceSha256), /same-origin/)
    assert.deepEqual(requests, [])
  })
  await check('whole pack hash/size/HTTP/gzip corruption', async () => {
    await assert.rejects(() => api.verifyHumanAssets({ ...manifest, sha256: '0'.repeat(64) }, lodUrl, surface.sourceSha256), /SHA-256/)
    await assert.rejects(() => api.verifyHumanAssets({ ...manifest, storedBytes: manifest.storedBytes + 1 }, lodUrl, surface.sourceSha256), /size/)
    lodBytes = raw.subarray(4); await assert.rejects(() => api.loadHumanAssets(surface.sourceSha256), /size/)
    status = 404; await assert.rejects(() => api.loadHumanAssets(surface.sourceSha256), /HTTP 404/)
    status = 200; lodBytes = Buffer.from(gzip); lodBytes[lodBytes.length - 5] ^= 255
    await assert.rejects(() => api.loadHumanAssets(surface.sourceSha256))
    assert.ok(requests.every(r => r === lodUrl))
  })
  await check('individual slice SHA checked despite valid whole pack', async () => {
    const m = structuredClone(manifest); m.levels[2].sha256 = '0'.repeat(64)
    await assert.rejects(() => api.verifyHumanAssets(m, lodUrl, surface.sourceSha256), /slice SHA/)
    assert.deepEqual(requests, [lodUrl])
  })
  const payloadNegatives = [
    ['hostile header vertex count', (b, l) => b.writeUInt32LE(0xffffffff, l.offset + 8), /header/],
    ['header flags', (b, l) => b.writeUInt16LE(0, l.offset + 6), /header/],
    ['header size', (b, l) => b.writeUInt32LE(0, l.offset + 28), /header/],
    ['nonfinite position', (b, l) => b.writeFloatLE(NaN, l.offset + 32), /Non-finite/],
    ['nonfinite normal', (b, l) => b.writeFloatLE(NaN, l.offset + 32 + l.vertices * 12), /Non-finite/],
    ['out-of-range atlas UV', (b, l) => b.writeFloatLE(2, l.offset + 32 + l.vertices * 40), /atlas UV/],
    ['wrong material zone', (b, l) => { b[l.offset + 32 + l.vertices * 56] = 1 }, /Unmapped/],
    ['joint out of range', (b, l) => { b[l.offset + 32 + l.vertices * 56 + align4(l.vertices)] = 20 }, /skin influence/],
    ['invalid weight', (b, l) => b.writeFloatLE(-1, l.offset + 32 + l.vertices * 60 + align4(l.vertices)), /skin influence/],
    ['triangle index out of range', (b, l) => b.writeUInt32LE(l.vertices, l.offset + l.bytes - 4), /index out of range/],
  ]
  for (const [name, mutate, error] of payloadNegatives) await check(`rehash malformed payload: ${name}`, async () => {
    const p = patchedPayload(mutate); lodBytes = p.bytes
    await assert.rejects(() => api.verifyHumanAssets(p.manifest, lodUrl, surface.sourceSha256), error)
    assert.deepEqual(requests, [lodUrl])
  })
  await check('binary FNV still verified after matching SHA', async () => {
    const p = patchedPayload((b, l) => b.writeUInt32LE(0, l.offset + 20), false); lodBytes = p.bytes
    await assert.rejects(() => api.verifyHumanAssets(p.manifest, lodUrl, surface.sourceSha256), /checksum/)
  })
  await check('declared bounds checked against decoded vertices', async () => {
    const m = structuredClone(manifest); m.levels[2].bounds[1][0] += .01
    await assert.rejects(() => api.verifyHumanAssets(m, lodUrl, surface.sourceSha256), /decoded bounds/)
    assert.deepEqual(requests, [lodUrl])
  })
  for (const mode of ['absent', 'manifest', 'pack']) await check(`missing required motion ${mode}`, async () => {
    if (mode !== 'pack') delete slots.motionManifest.file
    if (mode !== 'manifest') for (const key of Object.keys(slots.motionPack)) delete slots.motionPack[key]
    await assert.rejects(() => api.loadHumanAssets(surface.sourceSha256), /[Mm]issing|[Ii]ncomplete/)
    assert.deepEqual(requests, [lodUrl])
  })
  await check('motion source binding mismatch', async () => {
    slots.motionManifest.file = { ...motionManifest, modelSourceSha256: '0'.repeat(64) }
    await assert.rejects(() => api.loadHumanAssets(surface.sourceSha256), /binding mismatch/)
    assert.deepEqual(requests, [lodUrl])
  })
  await check('motion integrity failure rejects entire bundle', async () => {
    slots.motionManifest.file = { ...motionManifest, sha256: '0'.repeat(64) }
    await assert.rejects(() => api.loadHumanAssets(surface.sourceSha256), /SHA-256/)
    // The walk is fetched and rejected before any clip is asked for: a bundle whose walk
    // fails integrity must not go on pulling the rest of the pack.
    assert.deepEqual(requests, [lodUrl, motionUrl])
  })
  assert.equal(qemCalls, 0)
  console.log('humanassetsgate: PASS', JSON.stringify({ checks: checks.length, metadataNegativeCases: negative.length,
    payloadNegativeCases: payloadNegatives.length, qemCalls,
    actual: { triangles: actual.levels.map(l => l.mesh.triangleCount), bones: actual.levels.map(l => l.rig.skeleton.boneCount),
      rawBytes: manifest.bytes, gzipBytes: manifest.storedBytes, meshSha256: manifest.sha256,
      motionRawBytes: actual.motion.data.byteLength, motionGzipBytes: motionManifest.storedBytes, motionSha256: motionManifest.sha256 },
    limitation: 'CPU asset dependency/decoder gate; no GPU upload, gameplay promotion or idle/aim validation. Shared fetchAssetPack buffers before final length checks.' }))
} finally {
  globalThis.fetch = savedFetch
  if (savedLocation === undefined) delete globalThis.location; else globalThis.location = savedLocation
  delete globalThis.__humanAssetsGateSlots
}
