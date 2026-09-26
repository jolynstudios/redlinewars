#!/usr/bin/env node
// Real browser AudioContext witness. Simulation advances faster than the hardware clock.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { launchGpuBrowser, loadChromium, startPreview, stopChild } from './harness.mjs'
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const out = join(root, '.artifacts/planx')
mkdirSync(out, { recursive: true })
const temp = mkdtempSync(join(tmpdir(), 'weather-demo-'))
try {
 await build({ entryPoints: [join(root, 'web/src/audio/synth.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile: join(temp, 'synth.mjs'), logLevel: 'silent' })
 const { renderRain, renderThunder } = await import(join(temp, 'synth.mjs'))
 const rate = 48000, duration = 14, rain = renderRain(rate, 12345 ^ 0x7261696e).samples, thunder = renderThunder(rate, 12345 ^ 0x7468756e).samples
 const wav = Buffer.alloc(44 + rate * duration * 2)
 wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16)
 wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
 wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40)
 for (let i = 0; i < rate * duration; i++) {
  const t = i / rate, rainGain = .28 * (1 - Math.exp(-t / .3)), thunderAt = i - rate * 5
  const sample = (rain[i % rain.length] * rainGain + (thunder[thunderAt] ?? 0) * .58 * .85) * .7 * Math.min(1, duration - t)
  wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), 44 + i * 2)
 }
 writeFileSync(join(out, 'weather-demo.wav'), wav)
} finally { rmSync(temp, { recursive: true, force: true }) }
if (!process.argv.includes('--sample-only')) {
 const preview = await startPreview(8483)
 let browser
 try {
  ;({ browser } = await launchGpuBrowser(await loadChromium('weatheraudiointegrationgate'), 'weatheraudiointegrationgate'))
  const page = await browser.newPage({ viewport: { width: 960, height: 640 }, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.addInitScript(() => {
   globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {}
   globalThis.__weatherStarts = []
   const create = AudioContext.prototype.createBufferSource
   AudioContext.prototype.createBufferSource = function (...args) {
    const source = create.apply(this, args), start = source.start.bind(source), actx = this
    source.start = (...values) => {
     const sky = globalThis.steelseed?.ctx.peek('sky'), audio = globalThis.steelseed?.ctx.peek('audio')
     globalThis.__weatherStarts.push({ source, pan: audio?.thunderSlot?.pan.pan.value ?? 0, when: values[0] ?? actx.currentTime, clock: actx.currentTime, sim: sky?.motionTime, flash: sky?.lightning, strike: sky?.lightningStrike ? { ...sky.lightningStrike } : null })
     return start(...values)
    }
    return source
   }
  })
  await page.goto(`${preview.baseUrl}?devmap=1&deterministic=1&manual=1&quality=low&devsize=24&devactors=0&devcluster=0&devtod=1080&devweather=2&devweatherintensity=1000&devwindspeed=900`)
  await page.waitForFunction(() => globalThis.steelseed, undefined, { timeout: 180000, polling: 100 })
  const before = await page.evaluate(async () => {
   const app = globalThis.steelseed; app.stop(); for (let i = 0; i < 12; i++) app.renderOneFrame(i * 1000 / 60)
   await app.ctx.device.queue.onSubmittedWorkDone()
   const audio = app.ctx.get('audio')
   const initialState = audio.actx.state
   // Headless Chromium may allow autoplay; explicitly suspend the REAL context so the
   // installed gesture handler must execute the native resume path.
   await audio.actx.suspend()
   return { initialState, state: audio.actx.state, sources: globalThis.__weatherStarts.length, bank: audio.bank !== null }
  })
  assert.equal(before.sources, 0); assert.equal(before.bank, false); assert.equal(before.state, 'suspended')
  // A trusted key gesture reaches the actual installed autoplay handler.
  await page.keyboard.press('Shift')
  await page.waitForFunction(() => globalThis.steelseed.ctx.get('audio').running, undefined, { timeout: 10000 })
  const result = await page.evaluate(async () => {
   const app = globalThis.steelseed, ctx = app.ctx, sky = ctx.get('sky'), audio = ctx.get('audio'), actx = audio.actx, snap = ctx.snapshot
   const audioClockAtStart = actx.currentTime
   // A zero-actor fixture otherwise has no explored cells: reveal this staged map.
   const grid = ctx.get('terrain').grid
   snap.shroud = [{ cellIndex: 0, runLength: grid.w * grid.h, state: 2 }]
   ctx.get('shroud').onSnapshot(snap, null, ctx)
   const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
   const step = t => { ctx.time.tick = Math.floor(t * 25); ctx.time.alpha = t * 25 - ctx.time.tick; sky.onSnapshot(snap, null, ctx); sky.update(1 / 60, ctx); audio.lateUpdate(1 / 60, ctx) }
   step(0)
   const analyser = actx.createAnalyser(); analyser.fftSize = 2048; audio.master.connect(analyser)
   const rms = () => { const wave = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(wave); return Math.sqrt(wave.reduce((n, v) => n + v * v, 0) / wave.length) }
   const gainBefore = audio.rain.gain.gain.value
   await wait(1100)
   const gainAfter = audio.rain.gain.gain.value, rainRms = rms()
   audio.setMasterVolume(0); await wait(100); const mutedRms = rms(); audio.setMasterVolume(.7)
   const flashes = [], snapshots = [], ids = new Set()
   const recordFrame = async label => {
    for (let i = 0; i < 12; i++) { ctx.time.frame++; app.registry.update(1 / 60, ctx); app.registry.lateUpdate(1 / 60, ctx) }
    await ctx.device.queue.onSubmittedWorkDone()
    ctx.time.frame++; app.registry.update(1 / 60, ctx); app.registry.lateUpdate(1 / 60, ctx)
    const canvas = document.createElement('canvas'); canvas.width = ctx.canvas.width; canvas.height = ctx.canvas.height; const painter = canvas.getContext('2d'); painter.drawImage(ctx.canvas, 0, 0)
    const image = painter.getImageData(0, 0, canvas.width, canvas.height); let luma = 0
    for (let i = 0; i < image.data.length; i += 4) luma += image.data[i] * .2126 + image.data[i + 1] * .7152 + image.data[i + 2] * .0722
    snapshots.push({ label, sim: sky.motionTime, lightning: sky.lightning, meanLuma: luma / (image.data.length / 4), png: canvas.toDataURL() })
   }
   let heard = 0, audioRms = []
   for (let frame = 0; frame <= 50 * 60; frame++) {
    const t = frame / 60; step(t)
    const strike = sky.lightningStrike
    if (strike && !ids.has(strike.id)) {
     ids.add(strike.id); flashes.push({ ...strike, observedSim: t, flash: sky.lightning, clock: actx.currentTime })
     if (flashes.length === 1) await recordFrame('lightning-peak')
    }
    if (flashes.length === 1 && snapshots.length === 1 && t > flashes[0].time + .3) await recordFrame('lightning-after')
    const thunders = globalThis.__weatherStarts.filter(e => e.source.buffer === audio.thunderBuffer)
    if (thunders.length > heard) {
     heard = thunders.length
     // Audio runs on hardware time. Let this six-second voice finish before the next
     // accelerated simulation strike; otherwise the bounded slot correctly drops it.
     await wait(250); audioRms.push({ strike: thunders.at(-1).strike.id, rms: rms(), clock: actx.currentTime })
     for (let i = 0; i < 20; i++) audio.lateUpdate(1 / 60, ctx)
     await wait(Math.max(0, (audio.thunderSlot.freeAt - actx.currentTime + .05) * 1000))
    }
   }
   const starts = globalThis.__weatherStarts.filter(e => e.source.buffer === audio.thunderBuffer).map(({ source, ...entry }) => ({ ...entry, duration: source.buffer.duration }))
   const rainSources = globalThis.__weatherStarts.filter(e => e.source === audio.rain.src).length
   const state = { state: actx.state, sampleRate: actx.sampleRate, audioClockAtStart, audioClockAtEnd: actx.currentTime, realAudioSeconds: actx.currentTime - audioClockAtStart, simSeconds: sky.motionTime, rainSources, gainBefore, gainAfter, rainRms, mutedRms, audioRms, flashes, starts, snapshots, voicesDropped: audio.voicesDropped }
   analyser.disconnect(); audio.dispose(); state.closed = actx.state === 'closed'
   return state
  })
  for (const shot of result.snapshots) { writeFileSync(join(out, `${shot.label}.png`), Buffer.from(shot.png.split(',')[1], 'base64')); delete shot.png }
  writeFileSync(join(out, 'weather-browser-witness.json'), JSON.stringify({ before, ...result, errors, note: '50 simulation seconds stepped deterministically; real AudioContext time drives synthesis/playback, with six-second waits for each thunder tail. This is not a 50-second real-time recording. weather-demo.wav is an offline mix of shipped PCM at shipped gain values.' }, null, 2))
  assert.deepEqual(errors, [])
  assert.equal(result.state, 'running'); assert.equal(result.rainSources, 1)
  assert.ok(result.gainAfter > .2 && result.gainAfter > result.gainBefore, 'real rain AudioParam ramps')
  assert.ok(result.rainRms > .005 && result.mutedRms < .00001, 'real audio samples obey master mute')
  assert.ok(result.flashes.length >= 2 && result.starts.length >= 2)
  assert.equal(result.starts.length, result.flashes.length, 'one real thunder start per observed strike')
  assert.equal(new Set(result.starts.map(e => e.strike.id)).size, result.starts.length, 'no repeated starts')
  for (const start of result.starts) { assert.ok(start.sim >= start.strike.thunderTime); assert.ok(start.sim - start.strike.thunderTime < 1 / 60 + .00001); assert.ok(Math.abs(start.when - start.clock) < .02) }
  assert.ok(result.audioRms.every(e => e.rms > .005), 'real mixed waveform during thunder is audible')
  assert.equal(result.closed, true)
  assert.ok(result.snapshots[0].lightning > .5 && result.snapshots[1].lightning === 0)
  assert.ok(result.snapshots[0].meanLuma > result.snapshots[1].meanLuma + .5, 'rendered flash actually brightens the captured scene')
  console.log(`weatheraudiointegrationgate: PASS — ${result.starts.length} real thunder sources for ${result.flashes.length} visible strikes across ${result.simSeconds}s sim / ${result.realAudioSeconds.toFixed(2)}s audio; rain gain ${result.gainBefore.toFixed(3)}→${result.gainAfter.toFixed(3)}, RMS ${result.rainRms.toFixed(4)}, master-mute RMS ${result.mutedRms}`)
 } finally { await browser?.close(); await stopChild(preview.server) }
}
