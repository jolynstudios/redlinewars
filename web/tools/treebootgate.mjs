#!/usr/bin/env node
// Run ONLY after parent confirms canonical export + private dist/server ready.
// Natural boot: no routes, injected assets, mesh/palette/shader swaps or manual clock.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs'
import { resolve, join, basename, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { WEB_ROOT, loadChromium, launchGpuBrowser } from './harness.mjs'
import { configFor } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'
import { decodePng } from './png.mjs'

const TOOL = 'treebootgate', root = resolve(WEB_ROOT, '..'), args = process.argv.slice(2)
assert.ok(args.every(a => a === '--ready' || /^--label=[a-z0-9-]+$/.test(a) || a.startsWith('--url=')), 'Usage: treebootgate.mjs --ready --label=<new-label> [--url=http://127.0.0.1:8482/steelseed/index.html]')
assert.ok(args.filter(a => a.startsWith('--url=')).length <= 1, 'Only one --url is permitted')
assert.ok(args.includes('--ready'), 'Parent readiness required: canonical exports and private server/dist must be finished')
const label = args.find(a => a.startsWith('--label='))?.slice(8) ?? 'canonical-boot'
const targetUrl = new URL(args.find(a => a.startsWith('--url='))?.slice(6) ?? 'http://127.0.0.1:8482/steelseed/index.html')
assert.ok(targetUrl.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(targetUrl.hostname) && !targetUrl.username && !targetUrl.password, 'URL must be credential-free HTTP loopback (127.0.0.1 or localhost)')
assert.ok(!['8321', '8477'].includes(targetUrl.port), 'Protected port: shared game 8321 and unrelated app 8477 must remain untouched')
assert.ok(targetUrl.pathname === '/steelseed/index.html' && !targetUrl.search && !targetUrl.hash, 'URL must name /steelseed/index.html without query or fragment')
const base = targetUrl.href, out = join(WEB_ROOT, '.artifacts/visual-quality/treeboot', label)
assert.ok(!existsSync(out), 'Use a distinct label; preserve prior evidence')
const hash = b => createHash('sha256').update(b).digest('hex'), readJson = p => JSON.parse(readFileSync(p))
const tree = readJson(join(WEB_ROOT, '.forge/tree-lods/manifest.json')), roster = readJson(join(WEB_ROOT, '.forge/blender/manifest.json'))
const foliage = readJson(join(WEB_ROOT, '.forge/foliage/manifest.json')), entry = tree.assets.tc04
assert.equal(tree.id, 'trees-v1'); assert.equal(tree.foliageSourceSha256, foliage.sourceSha256)
for (const [id, declared] of Object.entries(tree.assets)) {
  assert.equal(declared.parentSourcePath, roster.assets[id].sourcePath)
  assert.equal(declared.parentSourceSha256, roster.assets[id].sourceSha256)
  // The chain is not restated here as a literal. `treelodgate` owns what a level may cost —
  // against the automatic chain `MeshStore.upload` would otherwise build — and a literal here
  // only records whatever shipped, which is how tc04 kept a chain more expensive than none.
  assert.equal(declared.levels.length, 3)
  assert.ok(declared.levels.every((l, i) => l.level === i && (!i || l.triangles < declared.levels[i - 1].triangles)))
}
const sources = [[foliage.sourcePath, foliage.sourceSha256],
  ...Object.values(tree.assets).flatMap(a => [[a.parentSourcePath, a.parentSourceSha256], ...a.levels.map(l => [l.sourcePath, l.sourceSha256])])]
function sourceCheck() {
  for (const [path, sha] of sources) {
    assert.ok(path.startsWith('art/blender/') && !path.split('/').includes('..'), 'Canonical sources only')
    const p = realpathSync(resolve(root, path)); assert.ok(p.startsWith(realpathSync(join(root, 'art/blender')) + sep)); assert.equal(hash(readFileSync(p)), sha)
  }
}
sourceCheck()
const packs = [['trees.ssmesh', 'tree-lods', tree], ['roster.ssasset', 'blender', roster], ['foliage.sspbr', 'foliage', foliage]]
for (const [, dir, m] of packs) {
  const compressed = readFileSync(join(WEB_ROOT, '.forge', dir, m.file ?? 'roster.ssasset.gz'))
  assert.equal(compressed.length, m.storedBytes); const bytes = gunzipSync(compressed, { maxOutputLength: 256 * 1048576 })
  assert.equal(bytes.length, m.bytes); assert.equal(hash(bytes), m.sha256)
}
// units/mesh-bake.ts is fully inlined into blender-mesh by the current bundler, so it
// no longer yields its own sourcemap entry; its runtime content is still asserted via
// blender-mesh.ts below.
const wanted = ['units/index.ts', 'units/tree-assets.ts', 'units/blender-mesh.ts', 'core/place.ts', 'geo/rig.ts', 'geo/mesh.ts',
  'render/renderer.ts', 'render/gpumesh.ts', 'render/shaders.ts', 'render/cutout-shaders.ts', 'materials/foliage-surfaces.ts', 'camera/index.ts', 'core/asset-pack.ts']
const report = { status: 'running', scope: 'Natural canonical Marigold boot, submitted tc04 LODs and real-clock wind/pause; no aesthetic/performance/shroud acceptance',
  treeSha256: tree.sha256, rosterSha256: roster.sha256, sources, served: [], sourceMaps: [], shots: [], errors: [],
  instrumentation: 'Pass-through GPU error listener and encodeFrame reader; camera controls and normal session pause/resume only' }
mkdirSync(out, { recursive: true })
const flush = () => writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
let browser
try {
  assert.ok((await fetch(base)).ok, `Parent must provide the private server at ${base}; gate never composes or starts servers`)
  const launched = await launchGpuBrowser(await loadChromium(TOOL), TOOL); browser = launched.browser; report.browser = launched.label
  const page = await browser.newPage({ viewport: { width: 1512, height: 982 }, deviceScaleFactor: 1 })
  const pending = [], downloaded = new Map(), packUrls = new Map()
  page.on('pageerror', e => report.errors.push(e.message))
  page.on('response', response => {
    const u = new URL(response.url()), name = basename(u.pathname)
    if (u.origin !== new URL(base).origin || !u.pathname.startsWith('/steelseed/assets/')) return
    if (packs.some(([stem]) => name.startsWith(stem))) {
      // The canonical roster decompresses to ~255 MB, and CDP evicts bodies that large
      // from the inspector cache before response.body() can read them — every failing
      // run died with 'Request content was evicted from inspector cache' on exactly that
      // pack while the smaller trees pack captured fine. Record the URL the natural boot
      // requested here, then fetch those same bytes node-side below: same loopback
      // server, so the content-identity assertions keep their exact meaning.
      packUrls.set(name, u.href); return
    }
    if (!name.endsWith('.js')) return
    pending.push((async () => { assert.ok(response.ok(), response.url()); downloaded.set(name, Buffer.from(await response.body())) })().catch(e => report.errors.push(String(e))))
  })
  await page.addInitScript(() => {
    globalThis.treeBootGpuErrors = []
    const request = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = async function(...args) {
      const device = await request.apply(this, args)
      device.addEventListener('uncapturederror', e => treeBootGpuErrors.push(e.error.message)); return device
    }
  })
  await page.goto(base + '?mode=game&platform=null&daylight=day&weather=clear&quality=high', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(() => globalThis.steelseed?.ctx.session.available, undefined, { timeout: 120000, polling: 100 })
  const catalog = await page.evaluate(() => steelseed.ctx.session.getCatalog()), map = catalog.maps.find(m => m.title === 'Marigold Town')
  assert.ok(map); report.mapUid = map.uid
  const mapDir = join(root, 'engine/openra/mods/ra/maps/marigold-town')
  assert.equal(map.uid, createHash('sha1').update(readFileSync(join(mapDir, 'map.bin'))).update(readFileSync(join(mapDir, 'map.yaml'))).digest('hex'), 'Actual current Marigold map identity')
  const config = configFor(catalog, map, { withBot: false }); config.options.explored = 'True'; config.options.fog = 'False'; config.options.crates = 'False'
  await page.evaluate(c => steelseed.ctx.session.startSkirmish(c), config)
  await page.waitForFunction(() => steelseed.ctx.snapshot?.tick >= 8 && steelseed.ctx.get('units').slotBuckets.get('tc04')?.count > 0 && document.getElementById('session-ui')?.hidden, undefined, { timeout: 120000, polling: 100 })
  await Promise.all(pending)
  const seen = new Set(), js = []
  for (const [file, bytes] of downloaded) if (file.endsWith('.js')) {
    assert.equal(hash(bytes), hash(readFileSync(join(WEB_ROOT, 'dist/assets', file))), 'Served JS differs from current dist'); js.push(bytes.toString())
    const path = join(WEB_ROOT, 'dist/assets', file + '.map'); if (!existsSync(path)) continue
    const local = readFileSync(path), response = await fetch(new URL('assets/' + file + '.map', base)); assert.ok(response.ok)
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(local), 'Served source map differs from dist')
    const sm = JSON.parse(local); report.sourceMaps.push({ file, sha256: hash(local) })
    for (const [i, s] of sm.sources.entries()) for (const p of wanted) if (s.endsWith('/' + p)) {
      assert.equal(sm.sourcesContent[i], readFileSync(join(WEB_ROOT, 'src', p), 'utf8'), 'Stale served source: ' + p); seen.add(p)
    }
  }
  assert.equal(seen.size, wanted.length, 'Every relevant module must be in naturally loaded, fresh JS')
  for (const [stem, , m] of packs) {
    // Meadow and canopy legitimately share the foliage.sspbr filename stem; identify by actual content.
    const matches = []
    for (const [file, href] of packUrls) {
      if (!file.startsWith(stem)) continue
      const response = await fetch(href); assert.ok(response.ok, href)
      let bytes = Buffer.from(await response.arrayBuffer())
      if (bytes[0] === 31 && bytes[1] === 139) bytes = gunzipSync(bytes, { maxOutputLength: 256 * 1048576 })
      if (hash(bytes) === m.sha256) matches.push({ file, bytes })
    }
    assert.equal(matches.length, 1, 'Natural boot must fetch current canonical ' + stem)
    const { file, bytes } = matches[0]
    assert.equal(bytes.length, m.bytes); assert.equal(hash(bytes), m.sha256); assert.ok(js.some(s => s.includes(m.sha256)), 'Current manifest fingerprint must be embedded in served JS')
    report.served.push({ file, bytes: bytes.length, sha256: hash(bytes) })
  }
  report.setup = await page.evaluate(() => {
    const ctx = steelseed.ctx, units = ctx.get('units'), renderer = ctx.get('render'), bucket = units.slotBuckets.get('tc04')
    const candidates = Array.from({ length: bucket.count }, (_, i) => ({ id: bucket.motionIds[i], x: bucket.instances[i * 16 + 12], z: bucket.instances[i * 16 + 14] }))
    candidates.sort((a, b) => Math.hypot(a.x - 28, a.z - 36) - Math.hypot(b.x - 28, b.z - 36)); const target = candidates[0]
    const original = renderer.encodeFrame, originalMesh = bucket.mesh, originalRig = bucket.rig
    globalThis.treeBootLatest = null
    // Read-only observer immediately before the real encoder consumes the packed instances.
    renderer.encodeFrame = function(...args) {
      const item = this.items.indexOf(bucket.item), i = Array.from(bucket.motionIds.subarray(0, bucket.count)).indexOf(target.id)
      const palette = i < 0 ? 0 : bucket.paletteBases[i], matrix = i < 0 ? [] : Array.from(bucket.instances.subarray(i * 16, i * 16 + 16)), levels = []
      if (item >= 0 && this.itemIncluded[item]) for (let l = 0; l < 3; l++) {
        const at = item * 3 + l, start = this.itemMainBase[at], end = start + this.itemMainCount[at]
        for (let slot = start; slot < end; slot++) if (this.instanceData[slot * 24 + 21] === palette && matrix.every((v, k) => this.instanceData[slot * 24 + k] === v)) levels.push(l)
      }
      treeBootLatest = { frame: ctx.time.frame, tick: ctx.snapshot.tick, paused: !!(ctx.snapshot.flags & 2), motionTime: ctx.get('sky').environment.motionTime,
        levels, palette, matrix, bones: Array.from(this.boneData.subarray(palette * 16, (palette + bucket.rig.skeleton.boneCount) * 16)),
        height: ctx.get('camera').height, eye: Array.from(this.camera.position), viewProj: Array.from(this.camera.viewProj), sameResources: bucket.mesh === originalMesh && bucket.rig === originalRig,
        skinStats: { ...units.skinStats }, material: bucket.item.surfaceSet, cutout: bucket.item.alphaCutout, triangles: bucket.mesh.lods.map(l => l.indexCount / 3) }
      return original.apply(this, args)
    }
    globalThis.treeBootTarget = target
    return { target, actors: candidates.length, backend: ctx.backend, winds: Array.from(bucket.rig.windBones), bones: bucket.rig.skeleton.boneCount,
      triangles: bucket.mesh.lods.map(l => l.indexCount / 3), labels: bucket.mesh.lods.map(l => l.label), material: bucket.item.surfaceSet, cutout: bucket.item.alphaCutout,
      foliageSourceSha256: ctx.get('materials').get('foliage-v1').sourceSha256, forgeErrors: units.forgeStats.errors }
  })
  assert.equal(report.setup.backend, 'webgpu'); assert.equal(report.setup.winds.length, 27); assert.equal(report.setup.bones, 28)
  assert.deepEqual(report.setup.triangles, entry.levels.map(l => l.triangles)); assert.equal(report.setup.material, 'foliage-v1'); assert.equal(report.setup.cutout, true)
  assert.equal(report.setup.foliageSourceSha256, tree.foliageSourceSha256); assert.deepEqual(report.setup.forgeErrors, [])
  const capture = async (name, expected) => {
    const state = await page.evaluate(() => treeBootLatest); assert.ok(state?.sameResources && state.palette > 0); assert.deepEqual(state.levels, [expected], name + ': actual target LOD')
    assert.equal(state.skinStats.paletteOverflows, 0); const path = join(out, name + '.png'); await page.screenshot({ path })
    const after = await page.evaluate(() => treeBootLatest); assert.deepEqual(after.levels, [expected]); assert.ok(after.sameResources)
    const png = readFileSync(path), image = decodePng(png); let lit = 0
    for (let i = 0; i < image.data.length; i += 4) if (image.data[i] + image.data[i + 1] + image.data[i + 2] > 24) lit++
    assert.ok(lit > image.width * image.height * .2, 'Reject blank capture'); report.shots.push({ name, ...state, screenshotEndFrame: after.frame, pngSha256: hash(png) }); flush(); return state
  }
  for (const [name, height, level] of [['near', 3.5, 0], ['mid', 45, 1], ['far', 100, 2]]) {
    console.log(TOOL + ': capturing ' + name)
    await page.evaluate(h => { const c = steelseed.ctx.get('camera'); c.height = c.heightGoal = h; c.yaw = c.yawGoal = .4; c.focusWorld(treeBootTarget.x, treeBootTarget.z) }, height)
    const frame = await page.evaluate(() => steelseed.ctx.time.frame)
    await page.waitForFunction(f => treeBootLatest?.frame >= f + 64, frame, { timeout: 30000 })
    await capture(name, level)
  }
  await page.evaluate(() => { const c = steelseed.ctx.get('camera'); c.height = c.heightGoal = 3.5; c.focusWorld(treeBootTarget.x, treeBootTarget.z) })
  await page.waitForTimeout(1500); const windA = await capture('wind-a', 0)
  await page.waitForTimeout(1600); const windB = await capture('wind-b', 0)
  assert.ok(windB.tick > windA.tick && windB.motionTime > windA.motionTime)
  assert.ok(windB.bones.some((v, i) => Math.abs(v - windA.bones[i]) > 1e-5), 'Live uploaded tree pose must move')
  await page.evaluate(() => steelseed.ctx.session.setPaused(true))
  await page.waitForFunction(() => treeBootLatest?.paused, undefined, { timeout: 30000 }); await page.waitForTimeout(300)
  const pauseA = await capture('pause-a', 0); await page.waitForTimeout(1000); const pauseB = await capture('pause-b', 0)
  assert.equal(pauseA.tick, pauseB.tick); assert.equal(pauseA.motionTime, pauseB.motionTime); assert.deepEqual(pauseA.bones, pauseB.bones)
  await page.evaluate(() => steelseed.ctx.session.setPaused(false)); await page.waitForTimeout(1200)
  const resumed = await capture('resumed', 0); assert.ok(resumed.tick > pauseB.tick && resumed.motionTime > pauseB.motionTime)
  report.errors.push(...await page.evaluate(() => treeBootGpuErrors)); assert.deepEqual(report.errors, []); sourceCheck()
  report.status = 'PASS'; flush(); console.log(TOOL + ': PASS — natural boot, LOD0/1/2 and live wind/pause; ' + out)
} catch (error) { report.status = 'FAIL'; report.failure = String(error); flush(); throw error }
finally { await browser?.close() }
