#!/usr/bin/env node
// Before/after of the sole macro-albedo change in an isolated production build.
// Pass --url=... pointing at a private preview, never the human's live game.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WEB_ROOT, launchGpuBrowser, loadChromium } from './harness.mjs'
import { decodePng } from './png.mjs'

const base = process.argv.find(v => v.startsWith('--url='))?.slice(6)
assert.ok(base, 'A private preview --url is required')
const out = join(WEB_ROOT, '.artifacts/visual-quality/terrain-macro')
mkdirSync(out, { recursive: true })
const { browser } = await launchGpuBrowser(await loadChromium('terrainmacrovisualgate'), 'terrainmacrovisualgate')
try {
 const captures = [], measurements = []
 for (const baseline of [true, false]) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 750 }, deviceScaleFactor: 1 }), errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.addInitScript(({ baseline }) => {
   globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {}
   globalThis.macroDefeats = 0
   if (baseline) {
    const create = GPUDevice.prototype.createShaderModule
    GPUDevice.prototype.createShaderModule = function (descriptor) {
     if (descriptor.code.includes('fn terrainMacroAlbedo(')) {
      // The defeat point is the strength guard. Tolerates both authored shapes: the
      // current pure module ('if (strength <= 0.0)...') and older built bundles where
      // the guard carried a leading frame.debug read.
      const defeat = /if \((?:frame\.debug\.y != 0u \|\| )?strength <= 0\.0\) \{ return rgb; \}/
      if (!defeat.test(descriptor.code)) throw Error('Macro defeat point missing')
      descriptor = { ...descriptor, code: descriptor.code.replace(defeat, 'if (true) { return rgb; }') }
      globalThis.macroDefeats++
     }
     return create.call(this, descriptor)
    }
   }
  }, { baseline })
  const url = new URL(base)
  for (const [k, v] of Object.entries({ devmap: 1, manual: 1, deterministic: 1, devsize: 64, devactors: 0, devtod: 720, devweather: 0, devweatherintensity: 0, quality: 'low' })) url.searchParams.set(k, String(v))
  await page.goto(url.href)
  await page.waitForFunction(() => globalThis.steelseed, undefined, { timeout: 120000, polling: 100 })
  // Hide UI chrome so the pixel diff sees only the presented ground.
  await page.addStyleTag({ content: '#game-ui, #session-ui, #outcome-ui { display:none !important; }' })
  const measured = await page.evaluate(() => {
   const app = steelseed; app.stop()
   for (let frame = 0; frame < 40; frame++) app.renderOneFrame(1000 / 60)
   const ctx = app.ctx, cam = ctx.get('camera'), render = ctx.get('render')
   cam.height = cam.heightGoal = 42; cam.target[0] = cam.targetGoal[0] = 32; cam.target[2] = cam.targetGoal[2] = 32
   for (let frame = 0; frame < 16; frame++) app.renderOneFrame(1000 / 60)
   // Actor-free devmaps have no player sight. This is an explicitly unobscured
   // terrain-only diagnostic, not a gameplay visibility test or map-reveal change.
   render.setShroud(new Uint8Array(64 * 64).fill(2), 64, 64, 0, 0)
   render.historyValid = false
   ctx.get('terrain').update(0, ctx)
   render.lateUpdate(0, ctx)
   return { defeats: globalThis.macroDefeats, draws: render.stats.drawCalls, dropped: render.stats.dropped }
  })
  // Capture the COMPOSITOR's presented frame (page.screenshot), never drawImage off the
  // WebGPU canvas: it is presented at task boundaries and reads back black afterwards —
  // a black pair here looks exactly like an inert macro layer.
  const shot = join(out, baseline ? 'before.png' : 'after.png')
  await page.screenshot({ path: shot })
  assert.deepEqual(errors, []); assert.equal(measured.dropped, 0)
  assert.ok(baseline ? measured.defeats > 0 : measured.defeats === 0)
  const png = readFileSync(shot)
  captures.push(decodePng(png)); measurements.push(measured)
  await page.close()
 }
 assert.equal(captures[0].data.length, captures[1].data.length)
 let changed = 0, sum = 0
 for (let i = 0; i < captures[0].data.length; i += 4) {
  const delta = [0, 1, 2].reduce((s, c) => s + Math.abs(captures[0].data[i + c] - captures[1].data[i + c]), 0)
  if (delta > 3) changed++
  sum += delta
 }
 assert.ok(changed > 500, 'Macro layer must visibly affect the production ground')
 const report = { changedPixels: changed, meanChannelDifference: sum / (captures[0].data.length / 4 * 3), measurements,
  limitation: 'Private clear-day terrain-only devmap with diagnostic sight, not an updated live match or Manor Lords quality acceptance.' }
 writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
 console.log('terrainmacrovisualgate PASS', JSON.stringify(report))
} finally { await browser.close() }
