#!/usr/bin/env node
// CPU-only measurements, never an aesthetic gate. No Blender, GPU, or runtime changes.
// node web/tools/meadowmorphologyreview.mjs [--pack=<dir>] [--label=<new-label>] [--self-test]
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..'), root = resolve(web, '..')
const palette = JSON.parse(readFileSync(resolve(web, 'src/core/blender-palette.json'), 'utf8'))
const sha = data => createHash('sha256').update(data).digest('hex')
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const BPP = [4, 2, 4, 1], MAX_BYTES = 32 * 1024 * 1024
const channels = ['rgba8-srgb-albedo-linear-alpha', 'rg8-octahedral-normal', 'rgba8-rough-metal-ao-height', 'r8-team-mask']
function keys(value, expected, why) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), why)
  assert.deepEqual(Object.keys(value).sort(), expected.split(' ').sort(), why)
}

function validate(manifest, compressed, bytes, source) {
  keys(manifest, 'schema id size mipCount origin tileMeters heightRange compression file bytes storedBytes sha256 sourcePath sourceSha256 layers', 'Exact original meadow schema')
  assert.equal(manifest.schema, 1); assert.equal(manifest.id, 'meadow-v1')
  assert.equal(manifest.size, 256); assert.equal(manifest.mipCount, 9)
  assert.equal(manifest.origin, 'bottom-left'); assert.equal(manifest.compression, 'gzip')
  assert.equal(manifest.tileMeters, 1); assert.equal(manifest.heightRange, 0)
  assert.equal(manifest.file, 'foliage.sspbr.gz')
  assert.ok(digest(manifest.sha256) && digest(manifest.sourceSha256))
  assert.equal(manifest.storedBytes, compressed.length, 'Compressed length')
  assert.equal(manifest.bytes, bytes.length, 'Decoded length')
  assert.equal(sha(bytes), manifest.sha256, 'Whole-pack hash')
  assert.equal(sha(source), manifest.sourceSha256, 'Saved source hash')
  assert.ok(palette.length >= 29, 'The frozen meadow prefix must still exist')
  assert.ok(Array.isArray(manifest.layers) && manifest.layers.length === 29)
  const checked = new Set(), spans = new Map()
  for (let zone = 0; zone < 29; zone++) {
    const layer = manifest.layers[zone]
    keys(layer, 'zone name mips alphaCoverage', 'Exact layer schema')
    assert.equal(layer.zone, zone); assert.equal(layer.name, palette[zone].name)
    assert.ok(Array.isArray(layer.mips) && layer.mips.length === 9)
    assert.ok(Array.isArray(layer.alphaCoverage) && layer.alphaCoverage.length === 9)
    for (let mip = 0; mip < 9; mip++) {
      const side = 256 >> mip, ranges = layer.mips[mip]
      assert.ok(Array.isArray(ranges) && ranges.length === 4, 'Four channels in fixed order')
      for (let c = 0; c < 4; c++) {
        const r = ranges[c]
        keys(r, 'offset bytes sha256', 'Exact range schema')
        assert.ok(Number.isSafeInteger(r.offset) && r.offset >= 0)
        assert.equal(r.bytes, side * side * BPP[c], channels[c])
        assert.ok(r.offset + r.bytes <= bytes.length && digest(r.sha256), 'Range bounds/hash')
        const key = `${r.offset}:${r.bytes}:${r.sha256}`
        if (!checked.has(key)) {
          assert.equal(sha(bytes.subarray(r.offset, r.offset + r.bytes)), r.sha256, 'Per-range hash')
          checked.add(key)
        }
        const span = `${r.offset}:${r.bytes}`
        if (spans.has(span)) assert.equal(spans.get(span).sha256, r.sha256, 'Exact aliases only')
        spans.set(span, r)
      }
      const a = ranges[0]
      let opaque = 0
      for (let i = 0; i < side * side; i++) if (bytes[a.offset + i * 4 + 3] >= 128) opaque++
      assert.equal(layer.alphaCoverage[mip], opaque / (side * side), 'Declared texel-center coverage')
    }
  }
  let end = 0
  for (const r of [...spans.values()].sort((a, b) => a.offset - b.offset)) {
    assert.equal(r.offset, end, 'No unreferenced bytes or partially overlapping ranges')
    end += r.bytes
  }
  assert.equal(end, bytes.length)
  return { uniqueRanges: checked.size, sourceSha256: manifest.sourceSha256, packSha256: manifest.sha256, compressedSha256: sha(compressed) }
}

function maskOf(bytes, range, side) {
  return Uint8Array.from({ length: side * side }, (_, i) => Number(bytes[range.offset + i * 4 + 3] >= 128))
}
function extent(mask, side) {
  let first = -1, last = -1
  for (let i = 0; i < mask.length; i++) if (mask[i]) { if (first < 0) first = i; last = i }
  return first < 0 ? null : { rootV: Math.floor(first / side) / side, topOpaqueV: (Math.floor(last / side) + 1) / side }
}
function components(mask, side, diagonal) {
  const seen = new Uint8Array(mask.length), queue = new Int32Array(mask.length)
  let count = 0, largest = 0, opaque = 0
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue
    count++; let head = 0, tail = 1; queue[0] = start; seen[start] = 1
    while (head < tail) {
      const i = queue[head++], x = i % side, y = Math.floor(i / side)
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || (!diagonal && dx && dy)) continue
        const xx = x + dx, yy = y + dy, next = yy * side + xx
        if (xx < 0 || xx >= side || yy < 0 || yy >= side || seen[next] || !mask[next]) continue
        seen[next] = 1; queue[tail++] = next
      }
    }
    largest = Math.max(largest, tail); opaque += tail
  }
  return { count, largestPixels: largest, largestFractionOfOpaque: opaque ? largest / opaque : null }
}
function summarize(values) {
  if (!values.length) return { count: 0, min: null, median: null, mean: null, max: null }
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length
  return { count: n, min: sorted[0], median: (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2,
    mean: sorted.reduce((a, b) => a + b, 0) / n, max: sorted[n - 1] }
}
function rowOf(mask, side, y) {
  const runs = []
  for (let x = 0; x < side;) {
    if (!mask[y * side + x]) { x++; continue }
    const start = x
    while (x < side && mask[y * side + x]) x++
    runs.push({ start, pixels: x - start })
  }
  const gaps = runs.slice(1).map((r, i) => r.start - runs[i].start - runs[i].pixels)
  const opaque = runs.reduce((sum, r) => sum + r.pixels, 0)
  return { row: y, centerV: (y + .5) / side, opaquePixels: opaque, coverage: opaque / side,
    runCount: runs.length, runWidthsPixels: runs.map(r => r.pixels), internalGapWidthsPixels: gaps,
    internalGapFractionOfCardWidth: gaps.reduce((a, b) => a + b, 0) / side }
}
function bandsOf(rows, side, reference) {
  if (!reference) return []
  return [[.2, .35], [.35, .5], [.5, .65], [.65, .8], [.8, 1]].map(([lo, hi]) => {
    const height = reference.topOpaqueV - reference.rootV, v0 = reference.rootV + lo * height, v1 = reference.rootV + hi * height
    const selected = rows.filter(r => r.centerV >= v0 && r.centerV < v1)
    return { relativeHeight: [lo, hi], atlasV: [v0, v1], rowCount: selected.length,
      blankRows: selected.filter(r => r.opaquePixels === 0).length,
      coverage: selected.length ? selected.reduce((s, r) => s + r.coverage, 0) / selected.length : null,
      runsPerRow: summarize(selected.map(r => r.runCount)),
      runWidthU: summarize(selected.flatMap(r => r.runWidthsPixels.map(n => n / side))),
      internalGapWidthU: summarize(selected.flatMap(r => r.internalGapWidthsPixels.map(n => n / side))) }
  })
}
function normalTilt(bytes, range, mask) {
  const degrees = []
  for (let i = 0; i < mask.length; i++) if (mask[i]) {
    let x = bytes[range.offset + i * 2] / 255 * 2 - 1, y = bytes[range.offset + i * 2 + 1] / 255 * 2 - 1
    const z = 1 - Math.abs(x) - Math.abs(y)
    if (z < 0) { const oldX = x; x = (1 - Math.abs(y)) * (x < 0 ? -1 : 1); y = (1 - Math.abs(oldX)) * (y < 0 ? -1 : 1) }
    const length = Math.hypot(x, y, z)
    assert.ok(Number.isFinite(length) && length > 0, 'Finite octahedral normal')
    degrees.push(Math.acos(Math.max(-1, Math.min(1, z / length))) * 180 / Math.PI)
  }
  return summarize(degrees)
}
function measure(bytes, layer) {
  const reference = extent(maskOf(bytes, layer.mips[0][0], 256), 256)
  return { zone: layer.zone, name: layer.name, mip0OpaqueExtent: reference, mips: layer.mips.map((ranges, mip) => {
    const side = 256 >> mip, mask = maskOf(bytes, ranges[0], side), bounds = extent(mask, side)
    const rows = Array.from({ length: side }, (_, y) => rowOf(mask, side, y))
    const opaquePixels = mask.reduce((a, b) => a + b, 0)
    return { mip, side, opaquePixels, coverage: opaquePixels / mask.length, topOpaqueV: bounds?.topOpaqueV ?? null,
      rootOpaqueV: bounds?.rootV ?? null,
      topLossVFromMip0: bounds && reference ? reference.topOpaqueV - bounds.topOpaqueV : null,
      connected4: components(mask, side, false), connected8: components(mask, side, true),
      nonRootBands: bandsOf(rows, side, reference),
      relativeHeightSamples: reference ? [.25, .5, .75, .9].map(h => {
        const targetV = reference.rootV + h * (reference.topOpaqueV - reference.rootV)
        return { relativeHeight: h, targetV, ...rows[Math.min(side - 1, Math.floor(targetV * side))] }
      }) : [], normalTiltFromTangentZDegrees: normalTilt(bytes, ranges[1], mask), rows }
  }) }
}

function selfTest(manifest, compressed, bytes, source) {
  const diagonal = Uint8Array.from([1, 0, 0, 1])
  assert.equal(components(diagonal, 2, false).count, 2)
  assert.deepEqual(components(diagonal, 2, true), { count: 1, largestPixels: 2, largestFractionOfOpaque: 1 })
  assert.equal(components(new Uint8Array(4), 2, true).largestFractionOfOpaque, null)
  assert.equal(extent(new Uint8Array(4), 2), null)
  const row = rowOf(Uint8Array.from([0, 1, 1, 0, 0, 1, 0, 0]), 8, 0)
  assert.deepEqual(row.runWidthsPixels, [2, 1]); assert.deepEqual(row.internalGapWidthsPixels, [2])
  assert.equal(row.internalGapFractionOfCardWidth, .25)
  assert.equal(extent(Uint8Array.from([1, 0, 0, 0]), 2).topOpaqueV, .5)
  assert.equal(bandsOf([rowOf(new Uint8Array(1), 1, 0)], 1, { rootV: 0, topOpaqueV: 1 })[0].coverage, null)
  const collapsed = Uint8Array.from({ length: 16 }, (_, i) => Number(i < 4))
  const fixedBands = bandsOf(Array.from({ length: 4 }, (_, y) => rowOf(collapsed, 4, y)), 4, { rootV: 0, topOpaqueV: 1 })
  assert.equal(fixedBands.at(-1).blankRows, 1, 'Missing tips must not rescale the reference height')
  assert.deepEqual(measure(bytes, manifest.layers[6]), measure(bytes, manifest.layers[6]), 'Repeat-deterministic measurements')
  let controls = 0
  for (const mutate of [m => { m.id = 'foliage-v1' }, m => { m.origin = 'top-left' },
    m => { m.layers[6].mips[0][1].bytes *= 2 }, m => { m.layers[6].mips[0][1].sha256 = '0'.repeat(64) },
    m => { m.layers[6].mips[0][1].offset = bytes.length }, m => { m.layers[6].alphaCoverage[0] = -1 },
    m => { m.sourceSha256 = '0'.repeat(64) }, m => { m.sha256 = '0'.repeat(64) }]) {
    const bad = structuredClone(manifest); mutate(bad)
    assert.throws(() => validate(bad, compressed, bytes, source)); controls++
  }
  const corrupt = Buffer.from(bytes); corrupt[manifest.layers[6].mips[0][1].offset] ^= 1
  const rebound = structuredClone(manifest); rebound.sha256 = sha(corrupt)
  assert.throws(() => validate(rebound, compressed, corrupt, source)); controls++
  console.log(`SELF_TEST: measurement fixtures and ${controls} validation negative controls passed; no aesthetic thresholds`)
}

function main() {
  const options = new Map()
  for (const arg of process.argv.slice(2)) {
    if (arg === '--help') { console.log('Usage: node web/tools/meadowmorphologyreview.mjs [--pack=<dir>] [--label=<new-label>] [--self-test]\nRelative pack paths use cwd. Labels never overwrite existing reports. --self-test writes no artifacts.'); return }
    const match = /^(--pack|--label)=(.+)$/.exec(arg)
    const key = match?.[1] ?? arg
    assert.ok(match || arg === '--self-test', `Unknown argument: ${arg}`)
    assert.ok(!options.has(key), `Duplicate argument: ${key}`); options.set(key, match?.[2] ?? true)
  }
  const packDir = realpathSync(resolve(options.get('--pack') ?? resolve(web, '.forge/meadow')))
  const manifestBytes = readFileSync(resolve(packDir, 'manifest.json'))
  assert.ok(manifestBytes.length <= 2 * 1024 * 1024, 'Bounded manifest')
  const manifest = JSON.parse(manifestBytes)
  assert.equal(manifest.file, 'foliage.sspbr.gz', 'Fixed local pack filename')
  assert.ok(typeof manifest.sourcePath === 'string' && !isAbsolute(manifest.sourcePath) && manifest.sourcePath.endsWith('.blend'), 'Repo-relative saved Blender source')
  const sourcePath = realpathSync(resolve(root, manifest.sourcePath)), sourceRelative = relative(realpathSync(root), sourcePath)
  assert.ok(sourceRelative && sourceRelative !== '..' && !sourceRelative.startsWith(`..${sep}`) && !isAbsolute(sourceRelative), 'Source remains in this repo')
  const source = readFileSync(sourcePath), compressed = readFileSync(resolve(packDir, manifest.file))
  assert.ok(compressed.length <= MAX_BYTES && Number.isSafeInteger(manifest.bytes) && manifest.bytes > 0 && manifest.bytes <= MAX_BYTES, 'Bounded pack')
  const bytes = gunzipSync(compressed, { maxOutputLength: MAX_BYTES })
  const validation = validate(manifest, compressed, bytes, source)
  if (options.has('--self-test')) { selfTest(manifest, compressed, bytes, source); return }
  const layers = [6, 26].map(zone => measure(bytes, manifest.layers[zone]))
  // No timestamps in report content: repeated measurement of the same input is identical.
  const report = { schema: 1, technicalValidation: 'passed', aestheticAcceptance: 'not-assessed',
    toolSha256: sha(readFileSync(fileURLToPath(import.meta.url))), manifestSha256: sha(manifestBytes),
    packDirectory: packDir, sourcePath: manifest.sourcePath, validation,
    conventions: { channels, alphaCutoff: 'byte >=128 (sample-center alpha >=0.5)', origin: 'bottom-left',
      connectivity: 'Both 4- and 8-neighbor, no wrapping; largest fraction divides by opaque pixels, not atlas area.',
      heights: 'Mip0 outer opaque-row edges define reference height, held fixed across all mips. Non-root means relative height >=0.2, not identified anatomy.',
      gaps: 'Horizontal transparent runs BETWEEN opaque runs only; excludes empty card margins. Width U = texels / mip side.',
      sampling: 'Rows selected by texel-center V; empty bands use null, blank sampled rows use zero. Coarse relative-height samples may share a row.',
      normals: 'RG8 octahedral decoded to unit vectors; tilt measured against tangent +Z, not world up. No lighting or linear albedo changes.' },
    layers, limits: ['Descriptive morphology only: collapse does not fail technical validation; no aesthetic PASS thresholds.',
      'Atlas texel-center masks, not bilinear/trilinear GPU coverage, TAA, or measured screen-space LOD.',
      'Connected components are not blade counts. Source hash verifies binding, not Blender topology or botanical quality.',
      'No physical blade dimensions inferred from atlas UVs. Grass geometry, source authoring, and GPU acceptance remain separate.'] }
  const label = options.get('--label') ?? `${basename(packDir)}-${manifest.sha256.slice(0, 12)}-${new Date().toISOString().replace(/[:.]/g, '-')}`
  assert.ok(typeof label === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(label), 'Safe artifact label')
  const base = resolve(web, '.artifacts/meadow-morphology')
  mkdirSync(base, { recursive: true })
  const out = resolve(base, label); mkdirSync(out) // Exclusive: preserve every previous review.
  writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log('TECHNICAL_VALIDATION: passed; MORPHOLOGY: descriptive, aesthetic acceptance not assessed')
  for (const layer of layers) for (const m of layer.mips) console.log(`zone=${layer.zone} mip=${m.mip} side=${m.side} coverage=${m.coverage.toFixed(6)} topV=${m.topOpaqueV ?? 'empty'} components8=${m.connected8.count} largestFraction=${m.connected8.largestFractionOfOpaque ?? 'empty'}`)
  console.log(`Report: ${resolve(out, 'report.json')}`)
}
try { main() } catch (error) { console.error(`MEADOW_MORPHOLOGY technical/input error: ${error.message}`); process.exitCode = 1 }
