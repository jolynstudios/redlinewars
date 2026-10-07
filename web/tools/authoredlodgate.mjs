#!/usr/bin/env node
// Production MeshStore + Mesh, recording GPU only. No renderer, build output or compose.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

const root = resolve(import.meta.dirname, '..')
const bundle = await build({ stdin: { contents: `
  export { MeshStore } from './src/render/gpumesh.ts'
  export { Mesh, VERTEX_STRIDE, VERTEX_STRIDE_SKINNED, SKIN_INDEX_OFFSET, SKIN_WEIGHT_OFFSET } from './src/geo/mesh.ts'
  export { decodeMeshBake } from './src/units/mesh-bake.ts'
`, resolveDir: root }, bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
const { MeshStore, Mesh, decodeMeshBake, VERTEX_STRIDE, VERTEX_STRIDE_SKINNED, SKIN_INDEX_OFFSET, SKIN_WEIGHT_OFFSET } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
globalThis.GPUBufferUsage = { COPY_DST: 8, INDEX: 16, VERTEX: 32 }
const align4 = n => Math.ceil(n / 4) * 4
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const channels = ['positions', 'normals', 'tangents', 'uv0', 'uv1', 'materialZone', 'indices', 'skinIndices', 'skinWeights']
const snapshot = mesh => JSON.stringify({ vertices: mesh.vertexCount, triangles: mesh.triangleCount,
  channels: channels.map(key => mesh[key] === null ? null : sha(new Uint8Array(mesh[key].buffer, mesh[key].byteOffset, mesh[key].byteLength))) })
function device() {
  const buffers = [], writes = []
  return { buffers, writes, limits: { maxBufferSize: 256 * 1024 * 1024 },
    createBuffer(desc) {
      assert.equal(desc.size % 4, 0)
      const buffer = { ...desc, data: new Uint8Array(desc.size), destroyed: 0, destroy() { this.destroyed++ } }
      buffers.push(buffer); return buffer
    },
    queue: { writeBuffer(buffer, offset, input, from = 0, size = input.byteLength - from) {
      assert.equal(size % 4, 0); assert.ok(offset + size <= buffer.size)
      const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input)
      buffer.data.set(bytes.subarray(from, from + size), offset); writes.push({ buffer, offset, size })
    } },
  }
}
function fixture(triangles, shift = 0, skinned = true) {
  const mesh = new Mesh(triangles * 3, triangles)
  mesh.vertexCount = triangles * 3; mesh.triangleCount = triangles
  if (skinned) { mesh.skinIndices = new Uint8Array(mesh.vertexCount * 4); mesh.skinWeights = new Float32Array(mesh.vertexCount * 4) }
  for (let v = 0; v < mesh.vertexCount; v++) {
    mesh.positions.set([shift + Math.floor(v / 3), v % 3 === 1 ? 1 : 0, v % 3 === 2 ? 1 : 0], v * 3)
    mesh.normals.set([1, 0, 0], v * 3); mesh.tangents.set([0, 1, 0, 1], v * 4)
    mesh.uv0.set([v % 3 / 3, .25], v * 2); mesh.uv1.set([.125, v % 3 / 3], v * 2)
    mesh.materialZone[v] = v % 3; mesh.indices[v] = v
    if (skinned) { mesh.skinIndices.set([0, 3, 7, 19], v * 4); mesh.skinWeights.set([.31, .29, .23, .17], v * 4) }
  }
  return mesh
}
const chain = (skinned = true) => [fixture(7, 0, skinned), fixture(3, -12, skinned), fixture(1, 20, skinned)]
const checks = [], check = (name, fn) => { fn(); checks.push(name) }
let forbiddenCalls = 0
const originalGenerate = Mesh.prototype.generateLodChain, originalSimplify = Mesh.prototype.simplify
Mesh.prototype.generateLodChain = Mesh.prototype.simplify = function () { forbiddenCalls++; throw new Error('Forbidden runtime QEM') }

function witness(levels, label) {
  const before = levels.map(snapshot), expected = levels.map(m => m.toGPUBuffers())
  const gpu = device(), store = new MeshStore(gpu), handle = store.uploadLods(levels, label)
  assert.equal(handle.lods.length, 3); assert.equal(store.uploadedCount, 3)
  assert.equal(gpu.buffers.length, 6); assert.equal(gpu.writes.length, 6)
  assert.equal(handle.vertexBuffer, handle.lods[0].vertexBuffer)
  let bytes = 0
  for (let i = 0; i < 3; i++) {
    const lod = handle.lods[i], packed = expected[i]
    assert.equal(lod.label, `${label}.lod${i}`)
    assert.equal(lod.indexCount, levels[i].triangleCount * 3)
    assert.equal(lod.vertexCount, levels[i].vertexCount)
    assert.equal(lod.stride, levels[i].skinned ? VERTEX_STRIDE_SKINNED : VERTEX_STRIDE)
    assert.deepEqual(lod.vertexBuffer.data, new Uint8Array(packed.vertexData))
    const indices = new Uint8Array(align4(packed.indexData.byteLength)); indices.set(new Uint8Array(packed.indexData))
    assert.deepEqual(lod.indexBuffer.data, indices)
    bytes += packed.vertexData.byteLength + indices.byteLength
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(handle.aabbMin[axis] <= lod.aabbMin[axis]); assert.ok(handle.aabbMax[axis] >= lod.aabbMax[axis])
    }
    const distance = Math.hypot(...Array.from(lod.sphere.subarray(0, 3), (x, axis) => x - handle.sphere[axis]))
    assert.ok(distance + lod.sphere[3] <= handle.sphere[3] + 1e-5, 'union sphere encloses every level')
    if (levels[i].skinned) for (let v = 0; v < levels[i].vertexCount; v++) {
      const base = v * lod.stride
      assert.deepEqual(lod.vertexBuffer.data.slice(base + SKIN_INDEX_OFFSET, base + SKIN_INDEX_OFFSET + 4), levels[i].skinIndices.slice(v * 4, v * 4 + 4))
      assert.equal(lod.vertexBuffer.data.slice(base + SKIN_WEIGHT_OFFSET, base + SKIN_WEIGHT_OFFSET + 4).reduce((a, b) => a + b, 0), 255)
    }
  }
  assert.equal(store.uploadedBytes, bytes)
  assert.deepEqual(levels.map(snapshot), before, 'all CPU channel bytes/counts unchanged')
  store.dispose(); store.dispose()
  assert.equal(store.uploadedCount, 0); assert.equal(store.uploadedBytes, 0)
  assert.ok(gpu.buffers.every(b => b.destroyed === 1))
  return { triangles: levels.map(m => m.triangleCount), vertices: levels.map(m => m.vertexCount), gpuBytes: bytes }
}
check('skinned exact bytes, odd index padding, bounds union, ownership and disposal', () => witness(chain(), 'authored.skinned'))
check('static authored chain', () => witness(chain(false), 'authored.static'))
check('authored upload refreshes stale bounds after direct position writes', () => {
  const levels = chain()
  for (const mesh of levels) mesh.updateBounds()
  levels[0].positions[0] = 100
  assert.ok(levels[0].aabbMax[0] < 100, 'negative control: cache must be stale')
  const before = levels.map(snapshot), gpu = device(), store = new MeshStore(gpu)
  const handle = store.uploadLods(levels, 'stale.bounds')
  assert.equal(handle.lods[0].aabbMax[0], 100)
  assert.equal(handle.aabbMax[0], 100)
  for (const mesh of levels) for (let v = 0; v < mesh.vertexCount; v++) {
    const distance = Math.hypot(...Array.from(mesh.positions.subarray(v * 3, v * 3 + 3), (x, axis) => x - handle.sphere[axis]))
    assert.ok(distance <= handle.sphere[3] + 1e-5, 'refreshed union sphere encloses actual positions')
  }
  assert.deepEqual(levels.map(snapshot), before)
  store.dispose(); assert.ok(gpu.buffers.every(b => b.destroyed === 1))
})
check('existing handles survive rejected authored upload', () => {
  const gpu = device(), store = new MeshStore(gpu); store.uploadLods(chain(), 'kept')
  const bytes = store.uploadedBytes, count = gpu.buffers.length, bad = chain(); bad[2].uv1[0] = NaN
  assert.throws(() => store.uploadLods(bad, 'bad'), /non-finite/)
  assert.equal(gpu.buffers.length, count); assert.equal(store.uploadedBytes, bytes)
  assert.ok(gpu.buffers.every(b => b.destroyed === 0)); store.dispose()
})
// Inject synchronous WebGPU API failures at every buffer allocation/write, including
// LOD0's second allocation and LOD1 after a complete LOD0 has entered the store.
let injectedFailures = 0
for (const operation of ['createBuffer', 'writeBuffer']) for (let failAt = 1; failAt <= 6; failAt++) {
  for (const populated of [false, true]) check(`rollback ${operation} #${failAt}, populated=${populated}`, () => {
    const gpu = device(), store = new MeshStore(gpu)
    if (populated) store.uploadLods(chain(), 'previous')
    const oldBuffers = gpu.buffers.slice(), oldBytes = store.uploadedBytes, oldCount = store.uploadedCount
    const receiver = operation === 'createBuffer' ? gpu : gpu.queue, original = receiver[operation]
    const injected = new Error(`injected ${operation} #${failAt}`)
    let calls = 0
    receiver[operation] = function (...args) {
      if (++calls === failAt) throw injected
      return original.apply(this, args)
    }
    const levels = chain(), before = levels.map(snapshot)
    assert.throws(() => store.uploadLods(levels, 'failing'), error => error === injected)
    assert.equal(calls, failAt); injectedFailures++
    assert.equal(store.uploadedCount, oldCount); assert.equal(store.uploadedBytes, oldBytes)
    assert.deepEqual(levels.map(snapshot), before)
    assert.ok(oldBuffers.every(b => b.destroyed === 0), 'previous meshes must stay alive')
    const failedBuffers = gpu.buffers.slice(oldBuffers.length)
    assert.equal(failedBuffers.length, operation === 'createBuffer' ? failAt - 1 : Math.ceil(failAt / 2) * 2)
    assert.ok(failedBuffers.every(b => b.destroyed === 1), 'every partially/completely uploaded new buffer must be destroyed')
    receiver[operation] = original
    store.uploadLods(chain(), 'recovered')
    assert.equal(store.uploadedCount, oldCount + 3)
    const liveBytes = gpu.buffers.filter(b => b.destroyed === 0).reduce((n, b) => n + b.size, 0)
    assert.equal(store.uploadedBytes, liveBytes, 'accounting must match only live buffers after recovery')
    store.dispose(); store.dispose()
    assert.equal(store.uploadedCount, 0); assert.equal(store.uploadedBytes, 0)
    assert.ok(gpu.buffers.every(b => b.destroyed === 1), 'rollback buffers must not remain tracked or be destroyed twice')
  })
}
const invalid = [
  ['empty chain', levels => levels.splice(0)],
  ['two levels', levels => levels.pop()],
  ['four levels', levels => levels.push(fixture(1))],
  ['missing level', levels => { levels[2] = undefined }],
  ['equal counts', levels => { levels[2] = fixture(3) }],
  ['increasing counts', levels => { levels[2] = fixture(4) }],
  ['empty mesh', levels => { levels[2].triangleCount = 0 }],
  ['fractional count', levels => { levels[2].vertexCount = 3.5 }],
  ['unsafe count', levels => { levels[2].vertexCount = Number.MAX_SAFE_INTEGER + 1 }],
  ['too few vertices', levels => { levels[2].vertexCount = 2 }],
  ['mixed skinning', levels => { levels[2] = fixture(1, 0, false) }],
  ['missing weights', levels => { levels[2].skinWeights = null }],
  ['missing joints', levels => { levels[2].skinIndices = null }],
  ['short joints', levels => { levels[2].skinIndices = new Uint8Array(1) }],
  ['short weights', levels => { levels[2].skinWeights = new Float32Array(1) }],
  ['nan weights', levels => { levels[2].skinWeights[0] = NaN }],
  ['negative weight', levels => { levels[2].skinWeights[0] = -.1 }],
  ['excess weight', levels => { levels[2].skinWeights[0] = 1.1 }],
  ['unnormalized weights', levels => { levels[2].skinWeights[0] = 0 }],
  ['short zones', levels => { levels[2].materialZone = new Uint8Array(1) }],
  ['short indices', levels => { levels[2].indices = new Uint32Array(1) }],
  ['wrong index type', levels => { levels[2].indices = new Uint16Array(3) }],
  ['index out of range', levels => { levels[2].indices[0] = levels[2].vertexCount }],
  ['degenerate triangle', levels => { levels[2].indices[0] = levels[2].indices[1] }],
  ['buffer limit', () => {}, gpu => { gpu.limits.maxBufferSize = 64 }],
]
for (const key of ['positions', 'normals', 'tangents', 'uv0', 'uv1']) {
  invalid.push([`short ${key}`, levels => { levels[2][key] = new Float32Array(1) }])
  invalid.push([`nonfinite ${key}`, levels => { levels[2][key][0] = Infinity }])
}
for (const [name, mutate, configure] of invalid) check(`reject before allocation: ${name}`, () => {
  const levels = chain(); mutate(levels)
  const gpu = device(); configure?.(gpu); const store = new MeshStore(gpu)
  assert.throws(() => store.uploadLods(levels, name), /render\.uploadLods/)
  assert.equal(gpu.buffers.length, 0); assert.equal(gpu.writes.length, 0)
  assert.equal(store.uploadedCount, 0); assert.equal(store.uploadedBytes, 0)
})

let artifact = null
const manifestPath = resolve(root, '.forge/human-lods/manifest.json')
let manifest
try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) }
catch (error) { if (error.code !== 'ENOENT' || process.argv.includes('--require-artifact')) throw error }
if (manifest) {
  assert.equal(manifest.schema, 1); assert.equal(manifest.compression, 'gzip'); assert.equal(manifest.levels.length, 3)
  assert.equal(manifest.file, 'lods.ssmesh.gz')
  const stored = await readFile(resolve(root, '.forge/human-lods', manifest.file))
  assert.equal(stored.length, manifest.storedBytes)
  const raw = gunzipSync(stored, { maxOutputLength: manifest.bytes }); assert.equal(raw.length, manifest.bytes); assert.equal(sha(raw), manifest.sha256)
  const bytes = Uint8Array.from(raw), levels = []
  let end = 0
  for (const entry of manifest.levels) {
    assert.ok(Number.isSafeInteger(entry.offset) && entry.offset >= end && entry.offset % 4 === 0)
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 32 && entry.offset + entry.bytes <= bytes.length)
    end = entry.offset + entry.bytes
    const slice = bytes.subarray(entry.offset, end); assert.equal(sha(slice), entry.sha256)
    const decoded = decodeMeshBake(slice)
    assert.equal(decoded.info.vertices, entry.vertices); assert.equal(decoded.info.triangles, entry.triangles)
    assert.deepEqual(entry.rig.bones, manifest.levels[0].rig.bones)
    assert.deepEqual(entry.materialTable, manifest.levels[0].materialTable)
    for (const joint of decoded.mesh.skinIndices) assert.ok(joint < entry.rig.bones.length)
    levels.push(decoded.mesh)
  }
  assert.equal(end, bytes.length)
  artifact = { ...witness(levels, 'authored.actual'), sha256: manifest.sha256 }
  checks.push('actual human LOD pack hashes, skeleton compatibility and production upload')
}
assert.equal(forbiddenCalls, 0)
// Legacy path still invokes the original generator with the existing defaults.
let generated = 0, simplified = 0
Mesh.prototype.generateLodChain = function (...args) { generated++; assert.deepEqual(args, [3, .5]); return originalGenerate.apply(this, args) }
Mesh.prototype.simplify = function (...args) { simplified++; return originalSimplify.apply(this, args) }
check('legacy upload still runs original three-level QEM path', () => {
  const gpu = device(), store = new MeshStore(gpu), mesh = fixture(8, 0, false), before = snapshot(mesh)
  const uploaded = store.upload(mesh, 'legacy')
  assert.equal(uploaded.lods.length, 3); assert.equal(generated, 1); assert.equal(simplified, 2)
  assert.equal(snapshot(mesh), before); store.dispose(); assert.ok(gpu.buffers.every(b => b.destroyed === 1))
})
Mesh.prototype.generateLodChain = originalGenerate; Mesh.prototype.simplify = originalSimplify
console.log('authoredlodgate: PASS', JSON.stringify({ checks: checks.length, negativeCases: invalid.length,
  injectedFailures, authoredQemCalls: forbiddenCalls, artifact,
  limitation: 'Recording GPU and synchronous API failures; not asynchronous GPU validation/device loss or rendered LOD transitions.' }))
