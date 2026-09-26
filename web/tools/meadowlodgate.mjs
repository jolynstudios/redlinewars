#!/usr/bin/env node
// CPU/source and production-init witness. In-memory transpilation only; no GPU or compose.
import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { build } from 'esbuild'

const web = resolve(import.meta.dirname, '..'), root = resolve(web, '..')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = name => JSON.parse(readFileSync(resolve(web, name)))
const manifest = json('.forge/environment/props.json')
const compressed = readFileSync(resolve(web, '.forge/environment/props.ssasset.gz'))
const bytes = Uint8Array.from(gunzipSync(compressed, { maxOutputLength: 8 * 1024 * 1024 }))
const atlas = json('.forge/meadow/manifest.json')
const atlasBytes = gunzipSync(readFileSync(resolve(web, '.forge/meadow', atlas.file)), { maxOutputLength: 32 * 1024 * 1024 })
const expectedNames = ['ore', 'gems', 'grass', 'grass-lod1', 'grass-lod2', 'rain', 'snow']
const lodNames = ['grass', 'grass-lod1', 'grass-lod2'], counts = [36, 24, 12]
const url = '/assets/props.meadowlodgate.ssasset.gz'
const slots = { manifest: { file: manifest }, pack: { file: url } }
const saved = { fetch: globalThis.fetch, location: globalThis.location, warn: console.warn }
globalThis.__meadowLodGate = slots
globalThis.location = { href: 'http://localhost/steelseed/index.html', origin: 'http://localhost', search: '' }
const bundle = await build({ stdin: { contents: `
  export { EnvironmentScenery } from './src/units/environment.ts'
  export { decodeBlenderAsset } from './src/units/blender-mesh.ts'
  export { Mesh } from './src/geo/mesh.ts'
`, resolveDir: web }, bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
  define: { 'import.meta.glob': '__gateGlob' }, banner: { js: `const __gateGlob = pattern => {
    if (!pattern.includes('/.forge/environment/')) return {};
    return globalThis.__meadowLodGate[pattern.endsWith('props.json') ? 'manifest' : 'pack'];
  };` } })
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const near = (a, b, why, tolerance = 2e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${why}: ${a} != ${b}`)
const cross2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
function sourceAudit(entry) {
  assert.match(entry.sourceSha256, /^[a-f0-9]{64}$/)
  const path = realpathSync(resolve(root, entry.sourcePath))
  assert.ok(path.startsWith(realpathSync(resolve(root, 'art/blender')) + sep), 'Source stays within Blender tree')
  assert.equal(hash(readFileSync(path)), entry.sourceSha256, entry.sourcePath)
}
function cardSides(mesh) {
  const sides = Array.from({ length: 6 }, () => [])
  for (let t = 0; t < mesh.triangleCount; t++) {
    const ids = [...mesh.indices.subarray(t * 3, t * 3 + 3)]
    const p = ids.map(i => [...mesh.positions.subarray(i * 3, i * 3 + 3)])
    const a = p[1].map((v, k) => v - p[0][k]), b = p[2].map((v, k) => v - p[0][k])
    const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
    assert.ok(Math.hypot(...n) > 1e-8, 'Nondegenerate card triangle')
    // Six card-face azimuths are 30 + k*60 degrees. Center bins on these, not their boundaries.
    const side = (Math.round((Math.atan2(n[2], n[0]) * 180 / Math.PI - 30) / 60) + 6) % 6
    sides[side].push({ ids, p, uv: ids.map(i => [...mesh.uv0.subarray(i * 2, i * 2 + 2)]) })
  }
  return sides
}
function coverage(sides) {
  const size = atlas.size, range = atlas.layers[6].mips[0][0]
  const rgba = atlasBytes.subarray(range.offset, range.offset + range.bytes)
  return sides.map(triangles => {
    let domain = 0, covered = 0
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const p = [(x + .5) / size, (y + .5) / size]
      if (!triangles.some(({ uv }) => {
        const signs = uv.map((a, i) => cross2(a, uv[(i + 1) % 3], p))
        return signs.every(v => v >= -1e-9) || signs.every(v => v <= 1e-9)
      })) continue
      domain++; if (rgba[(y * size + x) * 4 + 3] >= 128) covered++
    }
    return { domain, covered }
  })
}
function assertWholeCards(mesh, expectedTriangles) {
  assert.equal(mesh.triangleCount, expectedTriangles)
  assert.equal(mesh.validate(), null)
  assert.equal(mesh.skinWeights, null)
  mesh.updateBounds(); near(mesh.aabbMin[1], 0, 'Root'); near(mesh.aabbMax[1], .25, 'Infantry-proportional tip')
  const sides = cardSides(mesh)
  for (const side of sides) {
    assert.equal(side.length, expectedTriangles / 6, 'All six sides retained equally')
    near(side.reduce((sum, t) => sum + Math.abs(cross2(...t.uv)) / 2, 0), 1, 'Complete UV area')
    for (const { ids, p, uv } of side) for (let j = 0; j < 3; j++) {
      assert.ok(uv[j].every(v => v >= -1e-6 && v <= 1 + 1e-6), 'UV domain')
      near(p[j][1], uv[j][1] * .25, 'Height/UV binding')
      assert.equal(mesh.materialZone[ids[j]], 6)
      near(Math.hypot(...mesh.normals.subarray(ids[j] * 3, ids[j] * 3 + 3)), 1, 'Unit normal', 2e-5)
    }
    for (const u of [0, 1]) for (const v of [0, 1])
      assert.ok(side.some(t => t.uv.some(p => Math.abs(p[0] - u) < 1e-6 && Math.abs(p[1] - v) < 1e-6)), 'Every UV corner retained')
  }
  const result = coverage(sides)
  assert.ok(result.every(c => c.domain === atlas.size ** 2), 'Entire atlas domain covered on every side')
  return { sides, coverage: result }
}

const checks = []
async function check(name, fn) { await fn(); checks.push(name) }
let authored, oldQem, qemCalls = 0, requests = [], calls = [], warnings = [], responseBytes = compressed
const originalSimplify = api.Mesh.prototype.simplify, originalChain = api.Mesh.prototype.generateLodChain
try {
  await check('actual seven-prop pack, every range/hash/source, child-parent bindings', () => {
    assert.equal(manifest.schema, 1); assert.deepEqual(Object.keys(manifest.assets).sort(), [...expectedNames].sort())
    assert.equal(compressed.length, manifest.storedBytes); assert.equal(bytes.length, manifest.bytes); assert.equal(hash(bytes), manifest.sha256)
    assert.equal(hash(atlasBytes), atlas.sha256); sourceAudit(atlas)
    let end = 0
    for (const entry of Object.values(manifest.assets).sort((a, b) => a.offset - b.offset)) {
      assert.equal(entry.offset, end); assert.equal(entry.offset % 4, 0); assert.equal(entry.bytes % 4, 0)
      end += entry.bytes; assert.ok(end <= bytes.length)
      assert.equal(hash(bytes.subarray(entry.offset, end)), entry.sha256); sourceAudit(entry)
      const decoded = api.decodeBlenderAsset(bytes, entry); assert.equal(decoded.mesh.validate(), null)
    }
    assert.equal(end, bytes.length)
    for (const name of lodNames.slice(1)) {
      assert.equal(manifest.assets[name].meadowParentSha256, manifest.assets.grass.sourceSha256)
      assert.equal(manifest.assets[name].materialSet, 'meadow-v1'); assert.equal(manifest.assets[name].alphaCutout, true)
      assert.deepEqual(manifest.assets[name].materialTable, manifest.assets.grass.materialTable)
    }
  })
  await check('36/24/12 full domains, covered texels, roots/tips and all side corner positions', () => {
    authored = lodNames.map((name, level) => {
      const decoded = api.decodeBlenderAsset(bytes, manifest.assets[name]); assert.equal(decoded.rig, null)
      const result = assertWholeCards(decoded.mesh, counts[level])
      decoded.mesh.updateBounds()
      for (let k = 0; k < 3; k++) {
        near(decoded.mesh.aabbMin[k], manifest.assets.grass.bounds[0][k], 'Shared lower bound')
        near(decoded.mesh.aabbMax[k], manifest.assets.grass.bounds[1][k], 'Shared upper bound')
      }
      return { mesh: decoded.mesh, ...result }
    })
    for (const level of authored.slice(1)) {
      assert.deepEqual(level.coverage, authored[0].coverage)
      for (let s = 0; s < 6; s++) for (const u of [0, 1]) for (const v of [0, 1]) {
        const corner = side => { for (const t of side) for (let j = 0; j < 3; j++) if (Math.abs(t.uv[j][0] - u) < 1e-6 && Math.abs(t.uv[j][1] - v) < 1e-6) return t.p[j] }
        const p = corner(level.sides[s]), q = corner(authored[0].sides[s])
        p.forEach((value, k) => near(value, q[k], 'Shared root/tip corner'))
      }
    }
  })
  await check('negative control: actual old QEM loses authored card domains', () => {
    const chain = authored[0].mesh.generateLodChain(3, .5)
    oldQem = chain.map(mesh => {
      mesh.updateBounds()
      return { triangles: mesh.triangleCount, minY: mesh.aabbMin[1], maxY: mesh.aabbMax[1], coverage: coverage(cardSides(mesh)) }
    })
    for (let i = 1; i < 3; i++) {
      assert.throws(() => assertWholeCards(chain[i], chain[i].triangleCount))
      assert.ok(oldQem[i].coverage.reduce((sum, c) => sum + c.covered, 0) < oldQem[0].coverage.reduce((sum, c) => sum + c.covered, 0) * .9,
        'QEM must demonstrate actual alpha coverage loss, not merely fewer vertices')
    }
  })
  api.Mesh.prototype.generateLodChain = api.Mesh.prototype.simplify = () => { qemCalls++; throw Error('Unexpected scenery-init QEM') }
  globalThis.fetch = async requested => { assert.equal(requested, url, 'Only bundled same-origin props fetch'); requests.push(requested); return new Response(responseBytes) }
  console.warn = (...args) => warnings.push(args.join(' '))
  const render = {
    upload(mesh, label) { assert.notEqual(label, 'blender.environment.grass', 'Grass must bypass upload/QEM'); calls.push({ kind: 'upload', label, triangles: mesh.triangleCount }); return { label } },
    uploadLods(levels, label) {
      assert.equal(label, 'blender.environment.grass'); assert.equal(levels.length, 3)
      levels.forEach((mesh, i) => {
        assertWholeCards(mesh, counts[i])
        for (const channel of ['positions', 'normals', 'tangents', 'uv0', 'uv1', 'materialZone', 'indices'])
          assert.deepEqual(mesh[channel], authored[i].mesh[channel], 'Decoded channel preserved: ' + channel)
      })
      calls.push({ kind: 'uploadLods', label, triangles: levels.map(m => m.triangleCount) }); return { label }
    },
  }
  const ctx = { config: { q: { name: 'medium' } }, get(name) { assert.equal(name, 'materials'); return { has: () => true } } }
  async function init(m = manifest) {
    slots.manifest.file = m; requests = []; calls = []; warnings = []
    const scenery = new api.EnvironmentScenery(); await scenery.init(render, ctx); return scenery
  }
  await check('production init uploads grass once as three authored levels, no extra child pools/QEM', async () => {
    const scenery = await init()
    assert.equal(scenery.stats.error, ''); assert.equal(scenery.stats.loaded, 5)
    assert.deepEqual(requests, [url]); assert.deepEqual(warnings, [])
    assert.deepEqual(calls.filter(c => c.kind === 'uploadLods'), [{ kind: 'uploadLods', label: 'blender.environment.grass', triangles: counts }])
    assert.deepEqual(calls.filter(c => c.kind === 'upload').map(c => c.label), ['ore', 'gems', 'rain', 'snow'].map(id => 'blender.environment.' + id))
    const pool = scenery.pools.get('grass'); assert.equal(pool.item.surfaceSet, 'meadow-v1'); assert.equal(pool.item.alphaCutout, true)
    assert.equal(pool.item.castsShadow, false); assert.equal(scenery.pools.size, 5)
    scenery.dispose()
  })
  const negatives = [
    ['missing parent SHA', m => delete m.assets.grass.sourceSha256],
    ['invalid parent SHA', m => { m.assets.grass.sourceSha256 = 'bad' }],
    ...lodNames.slice(1).flatMap(name => [
      [name + ' missing', m => delete m.assets[name]],
      [name + ' wrong parent', m => { m.assets[name].meadowParentSha256 = '0'.repeat(64) }],
      [name + ' wrong material', m => { m.assets[name].materialSet = 'blender' }],
      [name + ' no cutout', m => { m.assets[name].alphaCutout = false }],
      [name + ' wrong table', m => { m.assets[name].materialTable[6].layer = 5 }],
    ]),
  ]
  for (const [name, mutate] of negatives) await check('production rejection: ' + name, async () => {
    const m = structuredClone(manifest); mutate(m)
    const scenery = await init(m)
    // Production intentionally catches init errors; assert its observable failure, not a rejected promise.
    assert.match(scenery.stats.error, /meadow/i); assert.equal(warnings.length, 1)
    assert.equal(scenery.pools.size,0); assert.equal(calls.length,0,'Invalid meadow dependencies must reject before any GPU upload')
    scenery.dispose()
  })
  await check('production rejects corrupted whole pack before upload', async () => {
    responseBytes = Uint8Array.from(bytes); responseBytes[responseBytes.length - 1] ^= 1
    const scenery = await init(); assert.match(scenery.stats.error, /SHA-256/); assert.deepEqual(calls, [])
    responseBytes = compressed; scenery.dispose()
  })
  await check('disabled scenery has no fetch or upload', async () => {
    globalThis.location.search = '?noenvironment=1'
    const scenery = await init(); assert.deepEqual(requests, []); assert.deepEqual(calls, []); assert.equal(scenery.stats.loaded, 0)
  })
  assert.equal(qemCalls, 0); assert.equal(hash(bytes), manifest.sha256)
  console.log('meadowlodgate: PASS', JSON.stringify({ checks: checks.length, triangles: counts, rawBytes: bytes.length,
    gzipBytes: compressed.length, sourceSha256: manifest.assets.grass.sourceSha256,
    authoredCoverage: authored.map(l => l.coverage), oldQem, productionInitQemCalls: qemCalls,
    limitation: 'CPU/source and recording-init evidence only; no GPU appearance or LOD switching proof. Invalid meadow dependencies reject before any prop upload.' }))
} finally {
  globalThis.fetch = saved.fetch; globalThis.location = saved.location; console.warn = saved.warn
  api.Mesh.prototype.simplify = originalSimplify; api.Mesh.prototype.generateLodChain = originalChain
  delete globalThis.__meadowLodGate
}
