#!/usr/bin/env node
// Per-object motion vectors feed the TAA reprojection. The gate drives a real match:
// MEASUREMENT CAVEAT: the grass wind animates against real time, so two boots' captures
// sit at different sway phases - the diff includes that noise (~300k px). Isolating
// pure object velocity needs the sway paused during the gate.
// a 1tnk is Ordered 14 cells across a framed patch and the sequence resolves twice
// around motiongateZeroObjectVelocity (identical deterministic boots). The pairwise
// pixel diff is INTEGRATED over twelve captures spread across the drive - the tank's
// per-frame smear is ~3 px, under the AgX threshold for any single frame, but the
// integrated total runs six figures. Measured: 832,994 changed pixels; zero would
// mean the resolve ignores the velocity texture and every moving unit ghosts.
import assert from 'node:assert/strict'
import { launchGpuBrowser, loadChromium } from './harness.mjs'
import { configFor } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'
// worker=0: this gate drives the simulation through a synchronous
// renderOneFrame capture loop, which requires the page-hosted runtime — worker
// postMessage cannot be serviced mid-task, so a worker-hosted sim freezes inside
// the loop by construction. The worker product path is covered by moveperfgate.
const BASE = 'http://127.0.0.1:8470/steelseed/index.html?worker=0&'
let browser
try {
  ;({ browser } = await launchGpuBrowser(await loadChromium('motiongate'), 'motiongate'))
  const captures = []
  for (const defeat of [true, false]) {
    const context = await browser.newContext({ viewport: { width: 1000, height: 750 }, deviceScaleFactor: 1 })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', e => errors.push(e.message.slice(0, 200)))
    await page.goto(`${BASE}mode=game&platform=null&quality=high&weather=clear&daylight=day`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForFunction(() => globalThis.steelseed?.ctx?.session?.available, undefined, { timeout: 180000, polling: 200 })
    const catalog = await page.evaluate(() => globalThis.steelseed.ctx.session.getCatalog())
    const map = catalog.maps.find(m => m.title === 'Marigold Town') ?? catalog.maps[0]
    const config = configFor(catalog, map, { withBot: false })
    const faction = ['england', 'germany', 'france', 'allies'].find(id => map.factions.some(f => f.id === id))
    config.local.faction = faction
    config.slots.find(s => s.slot === config.local.slot).faction = faction
    Object.assign(config.options, { startingunits: 'heavy', explored: 'True', fog: 'False', crates: 'False' })
    await page.evaluate(c => globalThis.steelseed.ctx.session.startSkirmish(c), config)
    await page.waitForFunction(() => globalThis.steelseed?.ctx?.snapshot?.actors?.count > 0 && document.getElementById('session-ui')?.hidden, undefined, { timeout: 180000, polling: 200 })
    const framed = await page.evaluate((defeat) => {
      const app = steelseed, ctx = app.ctx, render = ctx.get('render'), terrain = ctx.get('terrain'), units = ctx.get('units')
      render.motiongateZeroObjectVelocity = defeat
      const actors = ctx.snapshot.actors
      let tank = null
      for (let i = 0; i < actors.count; i++)
        if (actors.owner[i] === ctx.snapshot.world.renderPlayer && ctx.actorTypeName(actors.typeId[i]) === '1tnk') { tank = { id: actors.id[i], x: actors.posX[i] / 1024, z: actors.posY[i] / 1024 }; break }
      if (!tank) return { noTank: true }
      // Drive the tank 14 cells east-north-east, straight through the framed patch.
      const dest = { x: tank.x + 11, z: tank.z - 6 }
      const result = app.bridge.issueContextOrder({ subjectIds: Uint32Array.of(tank.id), subjectCount: 1, targetActorId: 0, targetCellX: Math.floor(dest.x), targetCellY: Math.floor(dest.z), targetFrozen: false, modifiers: 0 })
      const cam = ctx.get('camera')
      cam.focusWorld(tank.x + 5, tank.z - 2.5)
      cam.height = cam.heightGoal = 5
      cam.yaw = cam.yawGoal = 0.8
      cam.tilt = cam.tiltGoal = 0.6
      return { tank, dest, result: String(result).slice(0, 80) }
    }, defeat)
    if (framed.noTank) throw new Error('no player 1tnk in the heavy roster')
    await page.waitForTimeout(1500)
    // Integrated measurement: twelve captures spread across the whole drive. The
    // tank's per-frame smear is ~3 px - under the AgX threshold for ONE frame - so
    // the A/B sums the pairwise diff over the drive instead of reading one frame.
    const frames = await page.evaluate(() => {
      const out = []
      for (let f = 0; f < 360; f++) {
        steelseed.renderOneFrame(1000 / 60)
        if (f % 30 === 29) {
          const c = document.createElement('canvas'); c.width = steelseed.ctx.canvas.width; c.height = steelseed.ctx.canvas.height
          c.getContext('2d').drawImage(steelseed.ctx.canvas, 0, 0)
          out.push(c.toDataURL())
        }
      }
      return out
    })
    captures.push({ framed, frames, errors })
    await context.close()
  }
  for (const c of captures) assert.deepEqual(c.errors, [])
  assert.deepEqual(captures[0].framed.tank, captures[1].framed.tank, 'deterministic boots must spawn the tank identically')
  const decode = (await import('./png.mjs')).decodePng
  const perFrame = []
  let total = 0
  for (let f = 0; f < captures[0].frames.length; f++) {
    const a = decode(Buffer.from(captures[0].frames[f].split(',')[1], 'base64'))
    const b = decode(Buffer.from(captures[1].frames[f].split(',')[1], 'base64'))
    assert.equal(a.data.length, b.data.length)
    let changed = 0
    for (let i = 0; i < a.data.length; i += 4) {
      const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])
      if (d > 3) changed++
    }
    perFrame.push(changed)
    total += changed
  }
  assert.ok(total > 1200, `object motion must integrate over the drive: total ${total}, per frame ${JSON.stringify(perFrame)}`)
  // Deterministic mover-velocity assertion. The integrated pixel diff above is
  // noise-dominated (sky, clouds, flags), so it cannot distinguish "velocity feeds the
  // resolve" from "velocity is zero and everything ghosts". The velocity AOV itself can:
  // a 1tnk driving at this camera produces a ~0.003 UV/frame vector on its hull pixels.
  // Read the AOV back mid-drive and require that vector to exist. The readback runs
  // inside endFrame so it sees the exact frame the prepass wrote, busy-guarded because
  // the mapAsync roundtrip can outlast one rAF frame.
  {
    const context = await browser.newContext({ viewport: { width: 1000, height: 750 }, deviceScaleFactor: 1 })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', e => errors.push(e.message.slice(0, 200)))
    await page.goto(`${BASE}mode=game&platform=null&quality=high&weather=clear&daylight=day`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForFunction(() => globalThis.steelseed?.ctx?.session?.available, undefined, { timeout: 180000, polling: 200 })
    const catalog = await page.evaluate(() => globalThis.steelseed.ctx.session.getCatalog())
    const map = catalog.maps.find(m => m.title === 'Marigold Town') ?? catalog.maps[0]
    const config = configFor(catalog, map, { withBot: false })
    const faction = ['england', 'germany', 'france', 'allies'].find(id => map.factions.some(f => f.id === id))
    config.local.faction = faction
    config.slots.find(s => s.slot === config.local.slot).faction = faction
    Object.assign(config.options, { startingunits: 'heavy', explored: 'True', fog: 'False', crates: 'False' })
    await page.evaluate(c => globalThis.steelseed.ctx.session.startSkirmish(c), config)
    await page.waitForFunction(() => globalThis.steelseed?.ctx?.snapshot?.actors?.count > 0 && document.getElementById('session-ui')?.hidden, undefined, { timeout: 180000, polling: 200 })
    await page.evaluate(() => {
      const render = steelseed.ctx.get('render')
      if (!render.__velGateHooked) {
        render.__velGateHooked = true
        const stride = 4096
        const buf = render.device.createBuffer({ size: stride * 750, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
        render.endFrame = ((origEnd) => () => {
          origEnd()
          if (globalThis.__velGateBusy) return
          globalThis.__velGateBusy = true
          try {
            const t = render.targets
            const enc = render.device.createCommandEncoder()
            enc.copyTextureToBuffer({ texture: t.velocity }, { buffer: buf, bytesPerRow: stride, rowsPerImage: 750 }, { width: t.width, height: t.height, depthOrArrayLayers: 1 })
            render.device.queue.submit([enc.finish()])
            buf.mapAsync(GPUMapMode.READ).then(() => {
              const dv = new DataView(buf.getMappedRange())
              const half = h => { const sgn = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, mm = h & 0x3ff
                return sgn * (e === 0 ? mm / 1024 * 6.1035e-5 : (mm / 1024 + 1) * Math.pow(2, e - 15)) }
              let best = 0
              for (let y = 0; y < t.height; y += 2) for (let x = 0; x < t.width; x += 2) {
                const o = y * stride + x * 4
                if (o + 4 > dv.byteLength) break
                best = Math.max(best, Math.hypot(half(dv.getUint16(o, true)), half(dv.getUint16(o + 2, true))))
              }
              globalThis.__velGateMax = best
              buf.unmap()
              globalThis.__velGateBusy = false
            }).catch(() => { try { buf.unmap() } catch {} ; globalThis.__velGateBusy = false })
          } catch { globalThis.__velGateBusy = false }
        })(render.endFrame.bind(render))
      }
    })
    const drove = await page.evaluate(() => {
      const a = steelseed.ctx.snapshot.actors
      for (let i = 0; i < a.count; i++)
        if (a.owner[i] === steelseed.ctx.snapshot.world.renderPlayer && steelseed.ctx.actorTypeName(a.typeId[i]) === '1tnk') {
          const cam = steelseed.ctx.get('camera')
          cam.focusWorld(a.posX[i] / 1024 + 2, a.posY[i] / 1024)
          cam.height = cam.heightGoal = 5
          cam.yaw = cam.yawGoal = 0.8
          cam.tilt = cam.tiltGoal = 0.6
          steelseed.bridge.issueContextOrder({ subjectIds: Uint32Array.of(a.id[i]), subjectCount: 1, targetActorId: 0, targetCellX: Math.floor(a.posX[i] / 1024) + 11, targetCellY: Math.floor(a.posY[i] / 1024) - 6, targetFrozen: false, modifiers: 0 })
          globalThis.__velGateTankId = a.id[i]
          return { id: a.id[i], x: a.posX[i] / 1024, z: a.posY[i] / 1024 }
        }
      return null
    })
    assert.ok(drove, 'no player 1tnk for the velocity readback')
    await page.waitForTimeout(400)
    const tankPos = () => page.evaluate(() => {
      const a = steelseed.ctx.snapshot.actors
      for (let i = 0; i < a.count; i++)
        if (a.id[i] === globalThis.__velGateTankId) return { x: a.posX[i] / 1024, z: a.posY[i] / 1024 }
      return null
    })
    await page.waitForTimeout(300)
    const pos1 = await tankPos()
    // Wide window: the worker host adds an order round trip and the headless page
    // samples the last decoded snapshot, so a tight window under-reads a cruising
    // tank. The contract is mid-drive motion, not launch latency.
    await page.waitForTimeout(1200)
    const pos2 = await tankPos()
    assert.ok(pos1 && pos2, 'tank left the snapshot mid-drive')
    const moved = Math.hypot(pos2.x - pos1.x, pos2.z - pos1.z)
    assert.ok(moved > 0.3, `tank must be driving during the velocity readback: moved ${moved.toFixed(3)} m`)
    const velMax = await page.evaluate(() => globalThis.__velGateMax ?? 0)
    assert.ok(velMax > 0.0015, `per-object velocity must reach the AOV mid-drive: max ${velMax.toExponential(2)} UV/frame`)
    assert.deepEqual(errors, [])
    console.log(`motiongate velocity readback: max ${velMax.toExponential(2)} UV/frame, drive ${moved.toFixed(2)} m`)
    await context.close()
  }
   console.log('motiongate PASS', JSON.stringify({ total, perFrame, orders: captures.map(c => c.framed.result) }))
} finally {
  await browser?.close()
}
