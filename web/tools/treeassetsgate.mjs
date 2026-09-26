#!/usr/bin/env node
// CPU-only actual loader/decoder; mocked same-origin fetch. No writes, GPU or runtime.
// Default: assemble the reviewed private three-pack study IN MEMORY, with honest paths.
// --pack=<dir>: validate an exported trees-v1 manifest + trees.ssmesh.gz instead.
import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { build } from 'esbuild'

const web = resolve(import.meta.dirname, '..'), repo = resolve(web, '..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = path => JSON.parse(readFileSync(path))
const args = process.argv.slice(2)
if (args.length > 1 || args.some(a => !a.startsWith('--pack='))) throw new Error('Usage: node tools/treeassetsgate.mjs [--pack=<directory>]')
const foliage = json(resolve(web, '.forge/foliage/manifest.json'))
let manifest, raw, stored
if (args.length) {
  const dir = resolve(args[0].slice(7))
  manifest = json(resolve(dir, 'manifest.json')); stored = readFileSync(resolve(dir, 'trees.ssmesh.gz'))
  raw = gunzipSync(stored, { maxOutputLength: 32 * 1024 * 1024 })
} else {
  const levels = [], chunks = []; let offset = 0
  for (const [level, name] of ['after-v2', 'lod1', 'lod2'].entries()) {
    const dir = resolve(web, '.artifacts/cluster-canopy-v1', name), m = json(resolve(dir, 'manifest.json'))
    const bytes = readFileSync(resolve(dir, 'roster.ssasset')), a = m.assets.tc04
    assert.equal(sha(bytes), m.sha256); assert.equal(bytes.length, m.bytes)
    assert.deepEqual(gunzipSync(readFileSync(resolve(dir, 'roster.ssasset.gz'))), bytes)
    const slice = bytes.subarray(a.offset, a.offset + a.bytes); assert.equal(sha(slice), a.sha256)
    levels.push({ ...a, level, offset }); chunks.push(slice); offset += slice.length
  }
  raw = Buffer.concat(chunks); stored = gzipSync(raw)
  manifest = { schema: 1, id: 'trees-v1', file: 'trees.ssmesh.gz', compression: 'gzip', bytes: raw.length,
    storedBytes: stored.length, sha256: sha(raw), foliageSourceSha256: foliage.sourceSha256,
    assets: { tc04: { parentSourcePath: levels[0].sourcePath, parentSourceSha256: levels[0].sourceSha256, levels } } }
}
const id = Object.keys(manifest.assets)[0], entry = manifest.assets[id]
const privatePaths = Object.values(manifest.assets).some(a => a.parentSourcePath.startsWith('web/.artifacts/') || a.levels.some(l => l.sourcePath.startsWith('web/.artifacts/')))
const options = { allowPrivateSources: privatePaths }
const slots = { manifests: {}, packs: {} }, url = '/assets/treeassetsgate.ssmesh.gz'
const saved = { fetch: globalThis.fetch, location: globalThis.location }
globalThis.__treeAssetsGateSlots = slots
globalThis.location = { href: 'http://localhost/steelseed/index.html', origin: 'http://localhost' }
let body = stored, requests = [], status = 200
globalThis.fetch = async requested => { assert.equal(requested, url, 'No source, atlas or external fetch'); requests.push(requested); return new Response(body, { status }) }
const bundle = await build({ stdin: { contents: `
  export * from './src/units/tree-assets.ts'
  export { decodeBlenderAsset } from './src/units/blender-mesh.ts'
  export { encodeMeshBake } from './src/units/mesh-bake.ts'
  export { Mesh } from './src/geo/mesh.ts'
`, resolveDir: web }, bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
  define: { 'import.meta.glob': '__treeGateGlob' }, banner: { js: `const __treeGateGlob = p => globalThis.__treeAssetsGateSlots[p.endsWith('manifest.json') ? 'manifests' : 'packs'];` } })
const api = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))
let qemCalls = 0
api.Mesh.prototype.generateLodChain = api.Mesh.prototype.simplify = () => { qemCalls++; throw new Error('Forbidden QEM') }
const checks = [], clone = () => structuredClone(manifest)
function reset() {
  for (const slot of Object.values(slots)) for (const key of Object.keys(slot)) delete slot[key]
  slots.manifests.file = manifest; slots.packs.file = url; body = stored; status = 200; requests = []
}
const check = async (name, f) => { reset(); await f(); checks.push(name) }
const verify = m => api.verifyTreeAssets(m, url, foliage.sourceSha256, options)
const channels = ['positions', 'normals', 'tangents', 'uv0', 'uv1', 'materialZone', 'indices', 'skinIndices', 'skinWeights']
function rebind(bytes, m, level) {
  level.sha256 = sha(bytes.subarray(level.offset, level.offset + level.bytes)); m.sha256 = sha(bytes)
  body = gzipSync(bytes); m.storedBytes = body.length; return m
}
function payloadChange(change, levelIndex = 2) {
  const m = clone(), level = m.assets[id].levels[levelIndex], bytes = Buffer.from(raw)
  const decoded = api.decodeBlenderAsset(Uint8Array.from(bytes), level)
  change(decoded.mesh)
  const encoded = api.encodeMeshBake(decoded.mesh)
  assert.equal(encoded.length, level.bytes, 'Negative fixture keeps layout/counts')
  bytes.set(encoded, level.offset); return rebind(bytes, m, level)
}
const leafVertex = mesh => { for (let i = 0; i < mesh.indices.length; i++) if (mesh.materialZone[mesh.indices[i]] === 6) return mesh.indices[i]; throw new Error('Missing leaf fixture') }
try {
  await check('optional absent pair: null and zero fetches', async () => {
    delete slots.manifests.file; delete slots.packs.file
    assert.equal(await api.loadTreeAssets(foliage.sourceSha256), null); assert.deepEqual(requests, [])
  })
  for (const slot of ['manifests', 'packs']) await check('missing optional dependency: ' + slot, async () => {
    delete slots[slot].file; await assert.rejects(() => api.loadTreeAssets(foliage.sourceSha256), /incomplete/); assert.deepEqual(requests, [])
  })
  await check('strict production paths / explicit honest private verifier', async () => {
    if (privatePaths) { await assert.rejects(() => api.loadTreeAssets(foliage.sourceSha256), /source/); assert.deepEqual(requests, []) }
    else { const result = await api.loadTreeAssets(foliage.sourceSha256); assert.ok(result.assets[id]) }
  })
  await check('actual three-level loader, exact channels, repeatability and immutable input', async () => {
    assert.equal(raw.length, manifest.bytes); assert.equal(stored.length, manifest.storedBytes); assert.equal(sha(raw), manifest.sha256)
    const before = JSON.stringify(manifest), hash = sha(raw), a = await verify(manifest), b = await verify(manifest)
    assert.deepEqual(requests, [url, url])
    for (const [name, asset] of Object.entries(manifest.assets)) for (let i = 0; i < 3; i++) {
      const expected = api.decodeBlenderAsset(Uint8Array.from(raw), asset.levels[i]), loaded = a.assets[name].levels[i]
      for (const key of channels) { assert.deepEqual(loaded.mesh[key], expected.mesh[key]); assert.deepEqual(loaded.mesh[key], b.assets[name].levels[i].mesh[key]) }
      assert.equal(loaded.rig.skeleton.boneCount, asset.levels[0].rig.bones.length)
    }
    assert.equal(JSON.stringify(manifest), before); assert.equal(sha(raw), hash)
  })
  await check('saved parent/LOD/foliage provenance really exists and hashes match', () => {
    const refs = [[foliage.sourcePath, foliage.sourceSha256]]
    for (const a of Object.values(manifest.assets)) refs.push([a.parentSourcePath, a.parentSourceSha256], ...a.levels.map(l => [l.sourcePath, l.sourceSha256]))
    for (const [path, hash] of refs) {
      const p = realpathSync(resolve(repo, path))
      assert.ok(p.startsWith(realpathSync(resolve(repo, 'art/blender')) + sep) || p.startsWith(realpathSync(resolve(web, '.artifacts')) + sep))
      assert.equal(sha(readFileSync(p)), hash, path)
    }
  })
  await check('decoded HTTP body accepted when server already decompressed gzip', async () => { body = raw; assert.ok((await verify(manifest)).assets[id]) })
  const metadataCases = [
    ['schema', m => { m.schema = 2 }, /schema/],
    ['budget', m => { m.bytes = 2 ** 40 }, /budget/],
    ['atlas binding', m => { m.foliageSourceSha256 = '0'.repeat(64) }, /foliage/],
    ['missing level', m => { m.assets[id].levels.pop() }, /missing LOD/],
    ['level order', m => { m.assets[id].levels[1].level = 2 }, /count/],
    ['nondecreasing count', m => { m.assets[id].levels[1].triangles = m.assets[id].levels[0].triangles }, /count/],
    ['overlapping range', m => { m.assets[id].levels[1].offset = 0 }, /ranges/],
    ['range byte size', m => { m.assets[id].levels[1].bytes += 4 }, /range/],
    ['unclaimed tail', m => { m.bytes += 4 }, /unclaimed/],
    ['LOD rig change', m => { m.assets[id].levels[1].rig.bones[1].pos[0] += .001 }, /rig\/material/],
    ['rig cycle', m => { m.assets[id].levels[0].rig.bones[1].parent = 1 }, /bone/],
    ['nonfinite bind', m => { m.assets[id].levels[0].rig.bones[1].pos[0] = NaN }, /bone/],
    ['invalid bone axis', m => { m.assets[id].levels[0].rig.bones[1].axis = 3 }, /bone/],
    ['duplicate wind owner', m => { m.assets[id].levels[0].rig.winds[1].bone = m.assets[id].levels[0].rig.winds[0].bone }, /wind/],
    ['invalid alpha mode', m => { m.assets[id].levels[1].alphaCutout = false }, /material/],
    ['invalid material table', m => { m.assets[id].levels[1].materialTable[6].layer = 5 }, /material/],
    ['outward lower bound', m => { m.assets[id].levels[1].bounds[0][0] -= 1 }, /escape/],
    ['inverted bounds', m => { m.assets[id].levels[0].bounds[0][0] = 99 }, /bounds/],
    ['traversal source', m => { m.assets[id].levels[1].sourcePath = 'art/blender/../outside.blend' }, /source/],
    ['encoded source traversal', m => { m.assets[id].levels[1].sourcePath = 'art/blender/%2e%2e/outside.blend' }, /source/],
    ['bad source hash', m => { m.assets[id].levels[1].sourceSha256 = 'invalid' }, /source/],
    ['parent path differs from L0', m => { m.assets[id].parentSourcePath = 'art/blender/assets/other.blend' }, /parent source/],
    ['parent SHA differs from L0', m => { m.assets[id].parentSourceSha256 = '0'.repeat(64) }, /parent source/],
    ['unsafe asset key', m => { m.assets['__proto__'] = m.assets[id]; Object.defineProperty(m.assets, '__proto__', { value: m.assets[id], enumerable: true }) }, /asset/],
  ]
  for (const [name, mutate, error] of metadataCases) await check('metadata negative: ' + name, async () => {
    const m = clone(); mutate(m); await assert.rejects(() => verify(m), error); assert.deepEqual(requests, [])
  })
  for (const remote of ['https://example.invalid/trees.ssmesh.gz', 'data:application/octet-stream,abc', 'http://user:pass@localhost/trees.gz']) await check('reject URL ' + remote, async () => {
    await assert.rejects(() => api.verifyTreeAssets(manifest, remote, foliage.sourceSha256, options), /same-origin/); assert.deepEqual(requests, [])
  })
  await check('HTTP failure', async () => { status = 404; await assert.rejects(() => verify(manifest), /HTTP 404/) })
  await check('compressed size mismatch', async () => { const m = clone(); m.storedBytes++; await assert.rejects(() => verify(m), /Compressed.*size/) })
  await check('whole SHA mismatch', async () => { const m = clone(); m.sha256 = '0'.repeat(64); await assert.rejects(() => verify(m), /SHA-256/) })
  await check('slice SHA mismatch despite correct whole hash', async () => { const m = clone(); m.assets[id].levels[2].sha256 = '0'.repeat(64); await assert.rejects(() => verify(m), /slice SHA/) })
  await check('header mismatch with rebound hashes', async () => {
    const m = clone(), l = m.assets[id].levels[2], b = Buffer.from(raw); b.writeUInt16LE(0, l.offset + 6)
    await assert.rejects(() => verify(rebind(b, m, l)), /header/)
  })
  await check('decoded bounds cannot lie inward', async () => { const m = clone(); m.assets[id].levels[2].bounds[0][2] += .001; await assert.rejects(() => verify(m), /decoded bounds/) })
  const payloadCases = [
    ['nonfinite position', mesh => { mesh.positions[0] = NaN }, /Non-finite/],
    ['out of range index', mesh => { mesh.indices[0] = mesh.vertexCount }, /index|Index/],
    ['invalid weight', mesh => { mesh.skinWeights[0] = -.1 }, /influence/],
    ['non-unit normal', mesh => { mesh.normals[0] = 3 }, /tangent frame/],
    ['mixed tangent w', mesh => { mesh.tangents[leafVertex(mesh) * 4 + 3] *= -1 }, /handedness/],
    ['wrong UV bitangent orientation', mesh => { for (let v = 0; v < mesh.vertexCount; v++) if (mesh.materialZone[v] === 6) mesh.tangents[v * 4 + 3] *= -1 }, /orientation/],
    ['partial atlas card', mesh => { for (let v = 0; v < mesh.vertexCount; v++) if (mesh.materialZone[v] === 6) mesh.uv0[v * 2] *= .5 }, /full UV/],
    ['nonrigid leaf', mesh => { const v = leafVertex(mesh); mesh.skinWeights[v * 4] = .5; mesh.skinWeights[v * 4 + 1] = .5; mesh.skinIndices[v * 4 + 1] = 0 }, /rigid owner/],
    ['lost leaf owner while branch retains bone', mesh => {
      const winds = entry.levels[0].rig.winds.map(w => w.bone), from = winds.at(-1), to = winds[0]
      for (let v = 0; v < mesh.vertexCount; v++) if (mesh.materialZone[v] === 6 && mesh.skinIndices[v * 4] === from) mesh.skinIndices[v * 4] = to
    }, /leaf owners/],
    ['missing triangle half replaced by duplicate', mesh => {
      const indices = []; for (let i = 0; i < mesh.triangleCount * 3; i += 3) if (mesh.materialZone[mesh.indices[i]] === 6) indices.push(i)
      mesh.indices.set(mesh.indices.slice(indices[1], indices[1] + 3), indices[0])
    }, /card/],
  ]
  for (const [name, mutate, error] of payloadCases) await check('binary negative (valid hashes/checksum): ' + name, async () => {
    await assert.rejects(() => verify(payloadChange(mutate)), error)
  })
  await check('LOD0 must cover every wind owner, not merely establish a reduced baseline', async () => {
    const mutate = payloadCases.find(([name]) => name === 'lost leaf owner while branch retains bone')[1]
    await assert.rejects(() => verify(payloadChange(mutate, 0)), /leaf owners must cover every wind bone/)
  })
  await check('record key order does not dictate contiguous range order (synthetic two-asset container)', async () => {
    // Append ONE asset's range, not the whole pack: with more than one tree declared, a pack
    // doubled end to end leaves every byte after the first copy unclaimed and the container
    // shape is never reached. The duplicate's levels are contiguous by construction.
    const m = clone(), extra = structuredClone(m.assets[id]), size = raw.length
    const span = extra.levels.reduce((total, l) => total + l.bytes, 0), base = extra.levels[0].offset
    const b = Buffer.concat([raw, raw.subarray(base, base + span)])
    for (const l of extra.levels) l.offset += size - base
    // Container-shape test only: deliberately reuse the exact source, not a claimed tc02 authoring.
    const extraId = Array.from({ length: 100 }, (_, i) => `tc${String(i).padStart(2, '0')}`).find(name => !m.assets[name])
    assert.ok(extraId, 'synthetic test needs an unused tree id')
    m.assets = { [extraId]: extra, ...m.assets }; m.bytes = b.length; m.sha256 = sha(b); body = gzipSync(b); m.storedBytes = body.length
    assert.equal(Object.keys((await verify(m)).assets).length, Object.keys(manifest.assets).length + 1)
  })
  assert.equal(qemCalls, 0)
  console.log('TREEASSETSGATE PASS', checks.length, 'checks; CPU only; no GPU/QEM; sources:', Object.fromEntries(Object.entries(manifest.assets).map(([name, a]) => [name, a.levels.map(l => l.sourceSha256)])))
  console.log(JSON.stringify({ packSha256: manifest.sha256, bytes: manifest.bytes, storedBytes: manifest.storedBytes, privateVerifier: privatePaths,
    triangles: Object.fromEntries(Object.entries(manifest.assets).map(([name, a]) => [name, a.levels.map(l => l.triangles)])), checks }))
} finally {
  globalThis.fetch = saved.fetch
  if (saved.location === undefined) delete globalThis.location; else globalThis.location = saved.location
  delete globalThis.__treeAssetsGateSlots
}
