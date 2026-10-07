#!/usr/bin/env node
// STAGED preview fixture through production Units.update + WebGPU color-pass inputs.
// Does not import/call the clearance helper, rewrite placement, build, or compose.
// A private copy of an already-built dist is served on an OS-assigned local port.
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { launchGpuBrowser, loadChromium, WEB_ROOT } from './harness.mjs'
import { decodePng } from './png.mjs'

const TOOL = 'aircraftclearanceintegrationgate'
const dist = resolve(process.argv.find(a => a.startsWith('--dist='))?.slice(7) ?? join(WEB_ROOT, 'dist'))
const out = mkdtempSync(join(tmpdir(), 'steelseed-aircraft-integration-'))
const frozen = join(out, 'preview')
const sha256 = data => createHash('sha256').update(data).digest('hex')

// Check readiness before starting any preview; keep exact tested code as provenance.
function provenance(root) {
  const assets = join(root, 'assets')
  const maps = readdirSync(assets).filter(n => n.endsWith('.js.map')).map(name => ({
    name, data: JSON.parse(readFileSync(join(assets, name), 'utf8')),
  }))
  // Shared placement can move to another Vite chunk when imports change. Verify
  // the actual containing chunk for each source, retaining the same strict check.
  const sources = {}, chunks = {}
  for (const [name, dir] of [['index.ts', 'units'], ['aircraft-clearance.ts', 'units'], ['place.ts', 'core']]) {
    const matches = maps.filter(map => map.data.sources.some(s => s.endsWith(`/${dir}/${name}`)))
    assert.equal(matches.length, 1, `Need one built source map containing ${dir}/${name}`)
    const map = matches[0], index = map.data.sources.findIndex(s => s.endsWith(`/${dir}/${name}`))
    const built = map.data.sourcesContent[index], current = readFileSync(join(WEB_ROOT, 'src', dir, name), 'utf8')
    assert.equal(built, current, `${name} differs from dist; wait for the coordinator build (this gate never builds)`)
    sources[name] = sha256(built)
    const chunk = `assets/${map.name.slice(0, -4)}`
    chunks[chunk] = sha256(readFileSync(join(root, chunk)))
  }
  return {chunks, sources}
}
const expectedBuild = provenance(dist)
cpSync(dist, frozen, {recursive: true})
const build = provenance(frozen)
assert.deepEqual(build, expectedBuild, 'Build changed while making private preview copy; rerun after build completes')
const mime = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm'}
const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    if (path.endsWith('/')) path += 'index.html'
    const file = resolve(frozen, `.${path}`)
    if (!file.startsWith(frozen + sep)) {res.writeHead(403); res.end(); return}
    const data = await readFile(file)
    res.writeHead(200, {'content-type': mime[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store'})
    res.end(data)
  } catch (error) {res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end(String(error.code))}
})
let browser
try {
  await new Promise((resolveListen, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen)})
  const url = `http://127.0.0.1:${server.address().port}/?devmap=1&manual=1&deterministic=1&devsize=48&devactors=4&devtod=720&quality=medium`
  console.log(`${TOOL}: STAGED private preview`, JSON.stringify({url, out, build}))
  ;({browser} = await launchGpuBrowser(await loadChromium(TOOL), TOOL))
  const page = await browser.newPage({viewport: {width: 1280, height: 900}, deviceScaleFactor: 1})
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => {if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text())})
  await page.addInitScript(() => {window.requestAnimationFrame = () => 1; window.cancelAnimationFrame = () => {}})
  await page.goto(url, {waitUntil: 'domcontentloaded'})
  await page.waitForFunction(() => window.steelseed, undefined, {timeout: 180000, polling: 100})
  const result = await page.evaluate(async () => {
    const assert = (condition, message) => {if (!condition) throw new Error(message)}
    const app = window.steelseed
    app.stop(); app.renderOneFrame(0)
    let frame = 1
    // Snapshot intake awaits the actor table; synchronous frames cannot settle it.
    for (let i = 0; i < 120 && app.ctx.snapshot === null; i++) {
      await new Promise(resolve => setTimeout(resolve, 16))
      app.renderOneFrame(frame++ * 1000 / 60)
    }
    const ctx = app.ctx, units = ctx.get('units'), terrain = ctx.get('terrain')
    const render = ctx.get('render'), shroud = ctx.get('shroud'), camera = ctx.get('camera')
    assert(ctx.backend === 'webgpu', 'Actual WebGPU renderer required')
    assert(typeof units.flatAircraftSource === 'boolean', 'Built Units integration missing')
    const snapshot = ctx.snapshot, actors = snapshot.actors, grid = snapshot.terrainStatic
    const originX = snapshot.world.boundsLeft, originZ = snapshot.world.boundsTop
    assert(actors.count === 4 && grid.w === 48 && grid.h === 48, 'Unexpected dev fixture shape')
    // Explicitly staged type table and source snapshots. Production classification and
    // placement stay intact: no edits to typeSlot, slotGround, heightProbe or transforms.
    const names = ['yak', 'heli', '1tnk', 'ss']
    const typeNames = [...(await app.bridge.snapshotTypeTable()).split('\n')], baseType = typeNames.length
    typeNames.push(...names)
    app.bridge = {...app.bridge, pollSnapshot: () => null, snapshotTypeTable: () => typeNames.join('\n')}
    // refreshTypeTable() resolves in a later microtask; the staged table must be visible
    // to actorTypeName() before the synchronous onSnapshot below resolves the four types.
    app.typeTable = [...typeNames]
    app.snapState.prev = null
    for (let i = 0; i < 4; i++) {
      actors.id[i] = 7000 + i; actors.typeId[i] = baseType + i; actors.owner[i] = 0
      actors.displayTypeId[i] = actors.typeId[i]
      actors.facing[i] = 768; actors.health[i] = 255; actors.flags[i] = i === 3 ? 2 : 0
      actors.posX[i] = (originX + (i === 3 ? 5 : 24)) * 1024
      actors.posY[i] = (originZ + (i === 2 ? 10 : 24 + i * 2)) * 1024
      actors.posZ[i] = i < 2 ? 2560 : 0
      actors.turretCount[i] = 0
    }
    if (snapshot.frozenActors) snapshot.frozenActors.count = 0
    if (snapshot.projectiles) snapshot.projectiles.count = 0
    grid.height.fill(0); grid.ramp.fill(0); grid.resource.fill(0)
    grid.type.fill(2); grid.surface.fill(4); grid.passability.fill(7)
    for (let z = 0; z < 48; z++) for (let x = 0; x < 48; x++) {
      const i = z * 48 + x
      if (x < 9) {grid.surface[i] = 8; grid.passability[i] = 8}
      else if (x < 11) grid.surface[i] = 2
      if (x >= 23 && x < 37 && z >= 16 && z < 33) {grid.surface[i] = 1; grid.passability[i] = 16}
    }
    snapshot.flags |= 1 // HeaderFlag.terrainStaticPresent, same path as map load.
    snapshot.shroud = [{cellIndex: 0, runLength: 48 * 48, state: 2}]
    app.registry.onSnapshot(snapshot, null, ctx)
    assert(units.flatAircraftSource === true, 'Zero-height source must enable Units integration')
    assert(terrain.grid.hasPresentationRelief, 'Production Terrain must reconstruct relief')
    assert(names.every((name, i) => units.typeSlot.get(baseType + i) === name), 'Production role lookup must resolve all four real RA names')
    assert(units.slotGround.get('yak').airborne && units.slotGround.get('heli').airborne, 'Both plane and rotorcraft must classify as aircraft')
    assert(!units.slotGround.get('1tnk').airborne && units.typeSubmersible.get(baseType + 3), 'Tank/submarine roles must come from production metadata')
    camera.height = camera.heightGoal = 52
    camera.yaw = camera.yawGoal = .3
    camera.focusWorld(originX + 24, originZ + 24)
    // Remove UI overlays only for this staged screenshot; do not modify drawing data.
    for (const id of ['session-ui', 'hud', 'outcome-ui']) {const el = document.getElementById(id); if (el) el.hidden = true}
    const label = document.createElement('div')
    label.textContent = 'STAGED AIRCRAFT CLEARANCE · production Units + WebGPU · synthetic RA-style terrain'
    label.style.cssText = 'position:fixed;left:8px;top:8px;background:#111;color:white;padding:8px;z-index:9999;font:12px monospace'
    document.body.append(label)

    let uploaded = null, draws = null, submittedWitnesses = null, droppedWitnesses = []
    const submit = render.submit.bind(render)
    render.submit = function(item) {
      const before = this.droppedItems
      const result = submit(item)
      if (this.droppedItems > before) droppedWitnesses.push({surfaceSet: item.surfaceSet, count: item.instanceCount, ids: Array.from(item.motionIds ?? [])})
      return result
    }
    const queue = ctx.device.queue, writeBuffer = queue.writeBuffer.bind(queue)
    const encodeFrame = render.encodeFrame.bind(render)
    // Observe the real upload without changing its arguments or the buffer's flags.
    queue.writeBuffer = function(buffer, bufferOffset, data, dataOffset = 0, size) {
      if (buffer === render.instanceBuffer) {
        assert(bufferOffset === 0 && data instanceof ArrayBuffer, 'Renderer instance upload ABI changed')
        const bytes = new Uint8Array(data, dataOffset, size ?? data.byteLength - dataOffset).slice()
        uploaded = new Float32Array(bytes.buffer)
      }
      return writeBuffer(buffer, bufferOffset, data, dataOffset, size)
    }
    render.encodeFrame = function() {
      draws = []
      submittedWitnesses = []
      for (let it = 0; it < render.itemCount; it++) {
        const item = render.items[it], id = item.motionIds?.[0]
        if (id >= 7000 && id <= 7003) submittedWitnesses.push({id, count: item.instanceCount,
          included: render.itemIncluded[it], main: Array.from(render.itemMainCount.subarray(it * 3, it * 3 + 3)),
          position: Array.from(item.instances.subarray(12, 15))})
      }
      for (let order = 0; order < render.mainCount; order++) {
        const itemIndex = render.orderMain[order], item = render.items[itemIndex]
        if (item.instanceCount !== 1 || !item.motionIds) continue
        const id = item.motionIds[0], i = id - 7000
        if (i < 0 || i >= 4) continue
        for (let lod = 0; lod < 3; lod++) {
          const slot = itemIndex * 3 + lod, count = render.itemMainCount[slot]
          if (!count) continue
          assert(count === 1 && render.itemIncluded[itemIndex], 'Witness must survive main-pass culling/budget')
          const matrix = Array.from(item.instances.subarray(0, 16))
          const offset = render.itemMainBase[slot] * 24
          const packed = Array.from(uploaded.subarray(offset, offset + 16))
          assert(matrix.every((v, k) => v === packed[k]), 'Submitted transform differs from main-pass GPU upload')
          const x = matrix[12], z = matrix[14], ground = terrain.heightAt(x, z)
          const prior = draws.find(row => row.id === id)
          if (prior) {
            assert(prior.matrix.every((v, k) => v === packed[k]), `Duplicate ${names[i]} submissions disagree`)
            continue
          }
          draws.push({name: names[i], id, sourceAltitude: actors.posZ[i] / 1024,
            x, z, ground, drawnY: packed[13], clearance: packed[13] - ground,
            waterLevel: terrain.waterHeightAt(x, z), meshBottom: item.mesh.aabbMin[1], matrix, lod})
        }
      }
      return encodeFrame()
    }
    const sourceState = () => JSON.stringify({source: ['height', 'ramp', 'passability', 'surface'].map(k => Array.from(grid[k])),
      actors: ['id', 'typeId', 'displayTypeId', 'posX', 'posY', 'posZ', 'facing', 'flags', 'health'].map(k => Array.from(actors[k]))})
    // Paired placement controls share one simulation/interpolation instant.
    // A fixed wall-clock argument alone does not freeze deterministic Clock.alpha.
    snapshot.flags |= 2
    const takeFrame = () => {
      const before = sourceState()
      uploaded = null; draws = null; droppedWitnesses = []
      app.renderOneFrame(1000)
      assert(before === sourceState(), 'Rendering modified staged source terrain or actors')
      assert(draws && draws.length === 4, `Expected all four color-pass witnesses; got ${draws?.map(d => d.name)}; submissions ${JSON.stringify(submittedWitnesses)}`)
      assert(names.every((name, i) => draws.some(row => row.id === 7000 + i && row.name === name)), 'Every expected actor must reach the color pass')
      // Renderer stats also count empty terrain/material batches. They contain no
      // geometry; retain a strict check that every non-empty submission survives.
      assert(droppedWitnesses.every(item => item.count === 0), `Renderer dropped non-empty submissions: ${JSON.stringify(droppedWitnesses)}`)
      assert(render.stats.dropped === droppedWitnesses.length, 'Renderer drop accounting changed')
      return draws
    }
    const screenshot = () => {
      const copy = document.createElement('canvas'); copy.width = ctx.canvas.width; copy.height = ctx.canvas.height
      copy.getContext('2d').drawImage(ctx.canvas, 0, 0)
      return copy.toDataURL('image/png')
    }
    const uncaptured = []
    ctx.device.addEventListener('uncapturederror', e => uncaptured.push(e.error.message))
    ctx.device.pushErrorScope('validation')
    const sweep = []
    let peak = null
    for (let step = 0; step <= 32; step++) {
      actors.posX[0] = actors.posX[1] = (originX + 12 + step) * 1024
      const rows = takeFrame()
      for (const row of rows.filter(r => r.name === 'yak' || r.name === 'heli')) {
        assert(row.clearance >= row.sourceAltitude - .06, `${row.name} lost cruising clearance`)
        assert(row.drawnY >= row.sourceAltitude - .06, `${row.name} dropped below its source altitude`)
      }
      sweep.push(rows)
      const plane = rows.find(r => r.name === 'yak')
      if (!peak || plane.ground > peak.ground) peak = {x: plane.x, ground: plane.ground}
    }
    actors.posX[0] = actors.posX[1] = peak.x * 1024
    const enabled = takeFrame(), enabledPng = screenshot()
    // Negative control: feed an authored-source marker through Units.onSnapshot while
    // holding rendered terrain fixed. This intentionally inconsistent STAGED control
    // isolates the new branch; it is not an authored-map gameplay witness.
    grid.height[0] = 1; units.onSnapshot(snapshot, null, ctx)
    assert(units.flatAircraftSource === false, 'Authored-source marker must disable correction')
    const bypass = takeFrame(), bypassPng = screenshot()
    grid.height[0] = 0; units.onSnapshot(snapshot, null, ctx)
    const restored = takeFrame()
    for (const name of ['1tnk', 'ss']) {
      const a = enabled.find(r => r.name === name), b = bypass.find(r => r.name === name)
      assert(a.matrix.every((v, i) => v === b.matrix[i]), `${name} moved when aircraft correction changed`)
    }
    const submerged = restored.find(r => r.name === 'ss')
    assert(submerged.waterLevel !== null && Math.abs(submerged.drawnY - (submerged.waterLevel - .82)) < .025,
      'Idle submarine presentation depth incorrect')
    for (const name of ['yak', 'heli']) {
      const a = enabled.find(r => r.name === name), b = bypass.find(r => r.name === name)
      assert(a.drawnY > b.drawnY + 2, `${name} negative control did not expose the original low flight`)
      assert(b.clearance < 1.5, `${name} bypass must retain only the small corner-clearance envelope`)
      assert(a.matrix.every((v, i) => v === restored.find(r => r.name === name).matrix[i]), 'Restoring source must restore deterministic placement')
    }
    // Actual altitude input distinguishes a landed rotor, takeoff, and cruise.
    const rotor = []
    for (const altitude of [0, .125, .25, .5, 2.5]) {
      actors.posZ[1] = altitude * 1024
      rotor.push(takeFrame().find(r => r.name === 'heli'))
    }
    actors.posZ[1] = 0
    grid.height[0] = 1; units.onSnapshot(snapshot, null, ctx)
    const landedBypass = takeFrame().find(r => r.name === 'heli')
    assert(rotor[0].matrix.every((v, i) => v === landedBypass.matrix[i]), 'Landed rotor must retain old ground placement')
    grid.height[0] = 0; units.onSnapshot(snapshot, null, ctx)
    // Normal snapshots omit terrain-static; they must retain the source classification.
    snapshot.flags &= ~1; units.onSnapshot(snapshot, null, ctx)
    assert(units.flatAircraftSource === true, 'Steady-state snapshot lost terrain provenance')
    await ctx.device.queue.onSubmittedWorkDone()
    const validation = await ctx.device.popErrorScope()
    assert(!validation && uncaptured.length === 0, `GPU validation: ${validation?.message ?? uncaptured.join('; ')}`)
    queue.writeBuffer = writeBuffer; render.encodeFrame = encodeFrame; render.submit = submit
    units.dispose()
    assert(units.flatAircraftSource === false, 'dispose must reset source classification')
    return {sweep, enabled, bypass, restored, rotor, landedBypass, enabledPng, bypassPng,
      gpuErrors: uncaptured, backend: ctx.backend, origin: [originX, originZ], provenanceRetained: true, disposeReset: true,
      stage: 'Synthetic RA-style map, type table, and snapshot flight positions; unmodified production Units placement and main-pass upload/encoding.'}
  })
  assert.deepEqual(errors, [], 'No browser errors')
  for (const name of ['enabled', 'bypass']) {
    const png = Buffer.from(result[`${name}Png`].split(',')[1], 'base64')
    const decoded = decodePng(png)
    assert.ok(decoded.data.some((v, i) => i % 4 !== 3 && v > 32), `${name} canvas is blank`)
    writeFileSync(join(out, `${name}.png`), png)
    delete result[`${name}Png`]
  }
  const flights = result.sweep.flat().filter(r => ['yak', 'heli'].includes(r.name))
  const summary = {flightSamples: flights.length, minClearance: Math.min(...flights.map(r => r.clearance)),
    minGround: Math.min(...flights.map(r => r.ground)), maxGround: Math.max(...flights.map(r => r.ground)),
    maxDrawnY: Math.max(...flights.map(r => r.drawnY)), groundAndSubMatricesUnchanged: true,
    landedRotorUnchanged: true, mainPassUploadVerified: true, provenanceRetained: result.provenanceRetained,
    disposeReset: result.disposeReset}
  assert.ok(summary.maxGround - summary.minGround > 5, 'Witness must cross substantial reconstructed mountains')
  for (let i = 1; i < result.rotor.length; i++) assert.ok(result.rotor[i].drawnY > result.rotor[i - 1].drawnY, 'Rotor takeoff must increase height')
  writeFileSync(join(out, 'report.json'), JSON.stringify({date: new Date().toISOString(), build, summary, result,
    limitations: ['Staged preview, not a real OpenRA flight or gameplay clearance proof.',
      'Main-pass CPU upload bytes and GPU submission/validation observed; GPU storage buffer has no COPY_SRC readback.',
      'No full animated-wing collision, real flight interpolation, authored-map gameplay or visual climb-rate proof.',
      'Negative control changes source provenance while holding visual terrain fixed only to isolate the integrated branch.']}, null, 2))
  console.log(`${TOOL}: PASS`, JSON.stringify({out, summary, build}))
} finally {
  await browser?.close()
  server.closeAllConnections()
  if (server.listening) await new Promise(resolveClose => server.close(resolveClose))
  // Retain the private preview copy beside screenshots/report for reproducibility.
}
