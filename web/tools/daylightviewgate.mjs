#!/usr/bin/env node
// Validate the existing composed bundle in a separate, visible daytime match.
// Never compose/rebuild. The default run is unattended: capture evidence, assert,
// close the visible browser and exit. `--hold` restores the original interactive
// mandate — keep Chromium open until the human closes its window — which can never
// terminate on its own and therefore must stay opt-in.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadChromium } from './harness.mjs'
import { configFor } from '../../engine/steelseed-host/tools/runtime-fixture.mjs'

const url = new URL(process.argv.find(a => a.startsWith('--url='))?.slice(6)
  ?? 'http://127.0.0.1:8321/steelseed/index.html')
for (const [key, value] of Object.entries({mode: 'game', platform: 'null', quality: 'high', weather: 'clear', daylight: 'day'}))
  url.searchParams.set(key, value)
// Termination contract: every wait below is bounded, and the gate always exits on its
// own unless --hold pins it to the human-closes-the-window behavior.
const hold = process.argv.includes('--hold')
const startedAt = Date.now()
const phase = label => console.log('DAYLIGHT_PHASE', JSON.stringify({label, elapsedS: Math.round((Date.now() - startedAt) / 1000)}))
const out = mkdtempSync(join(tmpdir(), 'steelseed-daylight-'))
const chromium = await loadChromium('daylightviewgate')
const options = {headless: false, args: [
  '--use-angle=metal', '--enable-unsafe-webgpu',
  '--enable-features=Vulkan,UseSkiaRenderer', '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization', '--disable-gpu-sandbox',
]}
let browser
try { browser = await chromium.launch(options) }
catch (error) {
  if (!/Executable doesn't exist|please run|install/i.test(String(error.message))) throw error
  browser = await chromium.launch({...options, channel: 'chrome'})
}
phase('chromium-launched')
const disconnected = new Promise(resolve => browser.once('disconnected', resolve))
console.log('VISIBLE_BROWSER_STARTED', JSON.stringify({url: url.href, out, headless: false, hold, pid: process.pid}))
const page = await browser.newPage({viewport: {width: 1280, height: 800}, deviceScaleFactor: 1})
const errors = []
page.on('pageerror', error => errors.push(error.message))
try {
  const response = await page.goto(url.href, {waitUntil: 'domcontentloaded', timeout: 60000})
  assert.equal(response.status(), 200)
  await page.bringToFront()
  await page.waitForFunction(() => globalThis.steelseed?.ctx.session.available, undefined, {timeout: 180000, polling: 100})
  phase('session-available')
  const catalog = await page.evaluate(() => steelseed.ctx.session.getCatalog())
  const map = catalog.maps.find(m => m.title === 'Marigold Town')
  assert.ok(map, 'Marigold Town must exist in the served catalog')
  const config = configFor(catalog, map, {withBot: false})
  const faction = ['england', 'germany', 'france', 'allies'].find(id => map.factions.some(f => f.id === id))
  assert.ok(faction)
  config.local.name = 'Daylight Commander'
  config.local.faction = faction
  config.slots.find(s => s.slot === config.local.slot).faction = faction
  Object.assign(config.options, {startingunits: 'heavy', explored: 'True', fog: 'False', crates: 'False'})
  const started = await page.evaluate(c => steelseed.ctx.session.startSkirmish(c), config)
  assert.notEqual(started.status, 'error', JSON.stringify(started))
  await page.waitForFunction(() => steelseed.ctx.snapshot?.actors?.count > 0 && document.getElementById('session-ui').hidden,
    undefined, {timeout: 180000, polling: 100})
  phase('match-running')
  await page.evaluate(() => {
    const ctx = steelseed.ctx, actors = ctx.snapshot.actors
    for (let i = 0; i < actors.count; i++) {
      if (actors.owner[i] === ctx.snapshot.world.renderPlayer && ctx.actorTypeName(actors.typeId[i]) === 'mcv') {
        const camera = ctx.get('camera')
        camera.focusWorld(actors.posX[i] / 1024, actors.posY[i] / 1024)
        camera.height = camera.heightGoal = 16
        camera.yaw = camera.yawGoal = .4
        return
      }
    }
    throw new Error('No human MCV to focus')
  })
  const readState = () => page.evaluate(() => {
    const ctx = steelseed.ctx, sky = ctx.get('sky'), render = ctx.get('render')
    return {tick: ctx.snapshot.tick, actors: ctx.snapshot.actors.count, backend: ctx.backend,
      menuHidden: document.getElementById('session-ui').hidden,
      snapshotEnvironment: ctx.snapshot.world.environment ?? null,
      timeOfDay: sky.timeOfDay, weatherKind: sky.weatherKind,
      sunDir: Array.from(sky.environment.sunDir), sunIntensity: sky.environment.sunIntensity,
      moonIntensity: sky.moonIntensity, renderSunDir: Array.from(render.environment.sunDir),
      renderSunIntensity: render.environment.sunIntensity, draws: render.stats.drawCalls}
  })
  const first = await readState()
  await page.waitForFunction(tick => steelseed.ctx.snapshot.tick >= tick + 50, first.tick, {timeout: 30000, polling: 100})
  const final = await readState()
  phase('ticks-advanced')
  const screenshot = join(out, 'daylight-match.png')
  await page.screenshot({path: screenshot})
  const report = {date: new Date().toISOString(), url: url.href, headless: false, hold,
    map: map.title, config, first, final, screenshot, errors,
    note: 'Unmodified served bundle; separate visible browser and new local match; '
      + (hold ? 'browser left open until the human closes its window (--hold).'
        : 'browser closed by the gate after evidence; --hold keeps it open for viewing.')}
  writeFileSync(join(out, 'daylight-match.json'), JSON.stringify(report, null, 2))
  console.log('DAYLIGHT_EVIDENCE', JSON.stringify(report))
  phase('evidence-written')
  for (const state of [first, final]) {
    assert.equal(state.timeOfDay, 720, 'daylight=day must hold noon')
    assert.equal(state.weatherKind, 0, 'clear weather requested')
    assert.ok(state.sunDir[1] > .7 && state.sunIntensity > 3, 'daylight sun must be above horizon')
    assert.equal(state.moonIntensity, 0, 'must use sunlight, not moonlight')
    assert.ok(state.renderSunDir[1] > .7 && state.renderSunIntensity > 3, 'renderer must receive daylight')
    assert.ok(state.actors > 0 && state.draws > 0 && state.menuHidden, 'real match must render')
  }
  assert.deepEqual(errors, [])
  await page.bringToFront()
  if (hold) {
    console.log('DAYLIGHTVIEWGATE_PASS — visible daytime match is running; close its browser window when finished.')
    await disconnected
  } else {
    console.log('DAYLIGHTVIEWGATE_PASS — evidence captured; closing the visible browser (--hold keeps it open).')
    await browser.close()
  }
} catch (error) {
  console.error('DAYLIGHTVIEWGATE_FAIL', error.stack)
  try { await page.screenshot({path: join(out, 'failure.png')}) } catch {}
  process.exitCode = 1
  if (hold) {
    console.log('Browser left open for inspection:', out)
    await disconnected
  } else {
    console.log('Browser closed after failure; artifacts in', out)
    await browser.close()
  }
}
