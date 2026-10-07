#!/usr/bin/env node
// Actual loader, integrity validation, and generic uploader with a recording GPU device.
// Synthetic fixtures always run. Saved artifacts/provenance run only when present;
// --require-artifact makes their absence a failing gate. No build, bake or remote fetch.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { build } from 'esbuild'

const web = resolve(import.meta.dirname, '..'), game = resolve(web, '..')
const root = join(web, '.forge/human-surfaces')
const url = 'https://human-surface-gate.invalid/assets/surfaces.sspbr.gz'
const hash = data => createHash('sha256').update(data).digest('hex')
const bpp = [4, 2, 4, 1]
const slots = {manifest: {}, pack: {}}
const originals = Object.fromEntries(['fetch', 'GPUTextureUsage', 'GPUBufferUsage', '__humanSurfaceGateSlots'].map(k => [k, globalThis[k]]))
globalThis.__humanSurfaceGateSlots = slots
globalThis.GPUTextureUsage = {COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4}
globalThis.GPUBufferUsage = {COPY_DST: 8, UNIFORM: 64}
let served = null, requests = []
globalThis.fetch = async requested => {
  assert.equal(String(requested), url, 'Loader must fetch only its bundled pack, never a source asset')
  requests.push(String(requested))
  assert.ok(served, 'Unexpected request without fixture')
  return new Response(served, {status: 200})
}

function device() {
  const textures = [], buffers = [], writes = [], views = []
  return {
    limits: {maxTextureDimension2D: 8192, maxTextureArrayLayers: 256}, textures, buffers, writes, views,
    createTexture(descriptor) {
      const texture = {descriptor: structuredClone(descriptor), destroyed: false,
        createView(view) {views.push(structuredClone(view)); return {texture, descriptor: view}},
        destroy() {this.destroyed = true}}
      textures.push(texture); return texture
    },
    createBuffer(descriptor) {
      const buffer = {descriptor, destroyed: false, destroy() {this.destroyed = true}}
      buffers.push(buffer); return buffer
    },
    queue: {
      writeTexture(destination, data, layout, extent) {
        writes.push({channel: textures.indexOf(destination.texture), mip: destination.mipLevel,
          origin: Array.from(destination.origin), bytes: data.byteLength, sha256: hash(data), layout, extent})
      },
      writeBuffer(buffer, offset, data) {assert.equal(offset, 0); buffer.data = data.slice(0)},
    },
  }
}

function fixture() {
  const channels = [], mips = []
  let offset = 0
  for (let mip = 0; mip < 11; mip++) {
    const ranges = [], side = 1024 >> mip
    for (let c = 0; c < 4; c++) {
      const data = Buffer.alloc(side * side * bpp[c])
      for (let i = 0; i < data.length; i++) data[i] = (i * 13 + mip * 7 + c * 29) & 255
      ranges.push({offset, bytes: data.length, sha256: hash(data)})
      channels.push(data); offset += data.length
    }
    mips.push(ranges)
  }
  const raw = Buffer.concat(channels), stored = gzipSync(raw)
  return {raw, stored, manifest: {schema: 1, id: 'infantry-v1', size: 1024, mipCount: 11,
    origin: 'bottom-left', tileMeters: 1, heightRange: .01, compression: 'gzip', file: 'surfaces.sspbr.gz',
    bytes: raw.length, storedBytes: stored.length, sha256: hash(raw),
    sourcePath: 'art/blender/assets/units/synthetic-human-gate.blend', sourceSha256: hash('synthetic Blender fixture'),
    layers: [{zone: 0, name: 'human unique UV atlas', mips}]}}
}

function setPack(manifest, bytes) {
  slots.manifest.file = manifest; slots.pack.file = url; served = bytes; requests = []
}

function checkUpload(gpu, set, manifest, low) {
  const size = low ? 512 : 1024, mipCount = low ? 10 : 11, firstMip = low ? 1 : 0
  assert.equal(set.id, 'infantry-v1'); assert.equal(set.layerCount, 1)
  assert.equal(set.size, size); assert.equal(set.mipCount, mipCount)
  assert.equal(gpu.textures.length, 4); assert.equal(gpu.buffers.length, 1)
  assert.equal(gpu.writes.length, 4 * mipCount)
  for (let c = 0; c < 4; c++) {
    const descriptor = gpu.textures[c].descriptor
    assert.deepEqual(descriptor.size, [size, size, 1], 'No duplicated atlas layers')
    assert.equal(descriptor.mipLevelCount, mipCount)
    assert.equal(descriptor.format, ['rgba8unorm', 'rg8unorm', 'rgba8unorm', 'r8unorm'][c])
  }
  assert.equal(gpu.views[0].format, 'rgba8unorm-srgb', 'Albedo hardware sRGB decoding retained')
  for (const write of gpu.writes) {
    const range = manifest.layers[0].mips[firstMip + write.mip][write.channel], side = size >> write.mip
    assert.deepEqual(write.origin, [0, 0, 0])
    assert.deepEqual(write.extent, [side, side, 1])
    assert.equal(write.layout.bytesPerRow, side * bpp[write.channel])
    assert.equal(write.layout.rowsPerImage, side)
    assert.equal(write.bytes, range.bytes); assert.equal(write.sha256, range.sha256, 'Uploader chose wrong source mip/channel')
  }
  const textureBytes = gpu.writes.reduce((sum, w) => sum + w.bytes, 0)
  assert.equal(set.sourceSha256,manifest.sourceSha256,'Runtime atlas must expose its unique-UV source binding')
  assert.equal(set.vramBytes, textureBytes, 'claim equals texture bytes; the info buffer is not VRAM')
  // The pinned budget shrank by 32 B: the per-set info uniform BUFFER is no longer
  // claimed as VRAM (it is a buffer, not a texture; same correction as the assetgate
  // 1 KiB accounting rule). Texture bytes alone are the honest claim.
  assert.equal(set.vramBytes, low ? 3844775 : 15379143 - 32, 'Pinned one-layer full-mip budget (texture bytes only)')
  const info = new Uint32Array(gpu.buffers[0].data)
  assert.equal(info[0], 1); assert.equal(info[1], mipCount)
  const report = {size, mipCount, layerCount: set.layerCount, writes: gpu.writes.length, vramBytes: set.vramBytes}
  set.dispose()
  assert.ok(gpu.textures.every(t => t.destroyed) && gpu.buffers.every(b => b.destroyed), 'Allocated resources must dispose')
  return report
}

try {
  const bundled = await build({entryPoints: [join(web, 'src/materials/human-surfaces.ts')], bundle: true,
    platform: 'node', format: 'esm', write: false, logLevel: 'silent',
    define: {'import.meta.glob': '__gateGlob'}, banner: {js: `const __gateGlob = pattern =>
      pattern.includes('/human-surfaces/') ? globalThis.__humanSurfaceGateSlots[pattern.endsWith('manifest.json') ? 'manifest' : 'pack'] : {};`}})
  const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
  const f = fixture(), positive = [], negative = []
  assert.equal(await api.loadHumanSurfaces(device(), false), null, 'Absent optional artifacts should return null')
  slots.manifest.file = f.manifest
  await assert.rejects(() => api.loadHumanSurfaces(device(), false), /Incomplete human/)
  delete slots.manifest.file; slots.pack.file = url
  await assert.rejects(() => api.loadHumanSurfaces(device(), false), /Incomplete human/)
  assert.equal(requests.length, 0)
  for (const low of [true, false]) {
    setPack(f.manifest, f.stored)
    const gpu = device(), set = await api.loadHumanSurfaces(gpu, low)
    positive.push(checkUpload(gpu, set, f.manifest, low))
    assert.deepEqual(requests, [url])
    assert.equal(api.planHumanSurfaces(low).vramBytes, positive.at(-1).vramBytes)
  }
  setPack(f.manifest, f.raw)
  const decoded = await api.verifyHumanSurfacePack(f.manifest, url)
  assert.equal(hash(decoded.bytes), f.manifest.sha256, 'Already Content-Encoding-decoded response supported')

  const badManifests = [
    ['schema', m => m.schema = 2], ['id', m => m.id = 'industrial-v1'],
    ['dimensions', m => m.size = 2048], ['fractional dimensions', m => m.size = 1024.5],
    ['origin', m => m.origin = 'top-left'], ['compression', m => m.compression = 'raw'],
    ['layer count', m => m.layers.push(structuredClone(m.layers[0]))],
    ['29-layer duplication', m => m.layers = Array.from({length: 29}, () => structuredClone(m.layers[0]))],
    ['missing layer', m => m.layers = []], ['wrong zone', m => m.layers[0].zone = 1],
    ['missing mip', m => m.layers[0].mips.pop()], ['extra mip', m => m.layers[0].mips.push(m.layers[0].mips[10])],
    ['mip count', m => m.mipCount = 10], ['channel count', m => m.layers[0].mips[2].pop()],
    ['negative offset', m => m.layers[0].mips[0][0].offset = -1],
    ['fractional offset', m => m.layers[0].mips[0][0].offset = .5],
    ['out-of-bounds range', m => m.layers[0].mips[0][0].offset = m.bytes],
    ['overflow offset', m => m.layers[0].mips[0][0].offset = Number.MAX_SAFE_INTEGER],
    ['range byte count', m => m.layers[0].mips[0][0].bytes--],
    ['overlapping ranges', m => m.layers[0].mips[0][1].offset = 1],
    ['channel SHA shape', m => m.layers[0].mips[0][0].sha256 = 'bad'],
    ['pack SHA shape', m => m.sha256 = 'bad'], ['raw byte budget', m => m.bytes *= 29],
    ['stored byte budget', m => m.storedBytes = 256 * 1048576],
    ['invalid scale', m => m.tileMeters = Infinity], ['GPU scale overflow', m => m.tileMeters = 1e100],
    ['GPU scale underflow', m => m.tileMeters = 1e-100], ['negative height', m => m.heightRange = -1],
    ['missing provenance', m => delete m.sourceSha256], ['bad provenance SHA', m => m.sourceSha256 = 'bad'],
    ['external source path', m => m.sourcePath = 'https://example.com/human.blend'],
    ['traversal source path', m => m.sourcePath = 'art/blender/../../human.blend'],
  ]
  for (const [name, mutate] of badManifests) {
    const m = structuredClone(f.manifest); mutate(m)
    setPack(m, f.stored); const gpu = device()
    await assert.rejects(() => api.loadHumanSurfaces(gpu, false), /human surface/i, name)
    assert.equal(requests.length, 0, `${name}: malformed manifest must fail before fetch`)
    assert.equal(gpu.textures.length, 0, `${name}: malformed pack must not allocate`)
    negative.push(name)
  }
  for (const [name, mutate, expected] of [
    ['wrong pack SHA', m => m.sha256 = '0'.repeat(64), /Art pack SHA-256 mismatch/],
    ['wrong channel SHA', m => m.layers[0].mips[6][2].sha256 = '0'.repeat(64), /channel checksum mismatch/],
    ['wrong gzip byte count', m => m.storedBytes++, /Compressed art pack size mismatch/],
  ]) {
    const m = structuredClone(f.manifest); mutate(m)
    setPack(m, f.stored); const gpu = device()
    await assert.rejects(() => api.loadHumanSurfaces(gpu, false), expected, name)
    assert.equal(gpu.textures.length, 0); negative.push(name)
  }
  // A matching whole-pack hash cannot hide a corrupt mip with an unchanged channel hash.
  const altered = Buffer.from(f.raw); altered[f.manifest.layers[0].mips[9][3].offset] ^= 1
  const recompressed = gzipSync(altered), mismatch = structuredClone(f.manifest)
  mismatch.sha256 = hash(altered); mismatch.storedBytes = recompressed.length
  setPack(mismatch, recompressed)
  await assert.rejects(() => api.loadHumanSurfaces(device(), false), /channel checksum mismatch/)
  negative.push('corrupt mip with recomputed whole-pack SHA')
  setPack(f.manifest, f.stored)
  const tooSmall = device(); tooSmall.limits.maxTextureDimension2D = 512
  await assert.rejects(() => api.loadHumanSurfaces(tooSmall, false), /device limits/)
  assert.equal(requests.length, 0); assert.equal(tooSmall.textures.length, 0)
  negative.push('device dimension limit')

  // Legal exact aliases are accepted by the normal schema; do not force 29-layer
  // exporter conventions or disallow deduplication of identical byte ranges.
  const aliasRaw = Buffer.from(f.raw), alias = structuredClone(f.manifest)
  const albedo = alias.layers[0].mips[10][0], orm = alias.layers[0].mips[10][2]
  aliasRaw.copy(aliasRaw, orm.offset, albedo.offset, albedo.offset + albedo.bytes)
  alias.layers[0].mips[10][2] = {...albedo}
  const aliasGzip = gzipSync(aliasRaw); alias.sha256 = hash(aliasRaw); alias.storedBytes = aliasGzip.length
  setPack(alias, aliasGzip)
  await api.verifyHumanSurfacePack(alias, url)

  const manifestPath = join(root, 'manifest.json'), packPath = join(root, 'surfaces.sspbr.gz')
  const manifestExists = existsSync(manifestPath), packExists = existsSync(packPath)
  let artifacts = {status: 'not-present', note: 'Synthetic loader/uploader tests only; saved human atlas has not been verified.'}
  assert.equal(manifestExists, packExists, 'Human artifacts incomplete; wait for exporter to finish both files')
  if (manifestExists) {
    const manifest = JSON.parse(readFileSync(manifestPath)), stored = readFileSync(packPath)
    setPack(manifest, stored)
    const verified = await api.verifyHumanSurfacePack(manifest, url)
    const source = realpathSync(resolve(game, manifest.sourcePath))
    assert.ok(source.startsWith(realpathSync(join(game, 'art/blender')) + sep), 'Saved source must stay under art/blender')
    assert.equal(hash(readFileSync(source)), manifest.sourceSha256, 'Saved Blender source differs from artifact provenance')
    assert.equal(hash(gunzipSync(stored)), hash(verified.bytes))
    const uploads = []
    for (const low of [true, false]) {
      setPack(manifest, stored); const gpu = device()
      uploads.push(checkUpload(gpu, await api.loadHumanSurfaces(gpu, low), manifest, low))
    }
    artifacts = {status: 'verified', bytes: verified.bytes.length, storedBytes: stored.length,
      sha256: manifest.sha256, sourcePath: manifest.sourcePath, sourceSha256: manifest.sourceSha256,
      ranges: 44, uploads}
  }
  console.log('humansurfacegate: CODE PASS', JSON.stringify({positive, rejectedCases: negative.length, negative, artifacts,
    limits: 'Recording GPU device verifies upload descriptors, bytes, sRGB views and disposal; no actual GPU or mesh UV/render witness.'}))
  if (process.argv.includes('--require-artifact')) assert.equal(artifacts.status, 'verified', 'Saved human artifacts required but absent')
} finally {
  for (const [name, value] of Object.entries(originals)) {
    if (value === undefined) delete globalThis[name]
    else globalThis[name] = value
  }
}
