#!/usr/bin/env node
// CPU-only gate of the new helper and existing terrain/place code. No game compose,
// server, browser or snapshot mutation. This does NOT claim units/index.ts integration.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const bundle = await build({stdin: {contents: [
  `export * from './src/units/aircraft-clearance.ts'`,
  `export { placeActor } from './src/core/place.ts'`,
  `export { TerrainGrid } from './src/terrain/grid.ts'`,
].join('\n'), resolveDir: root}, bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent'})
const {aircraftClearanceAltitude: clearance, isFlatAircraftSource: flatSource,
  placeActor, TerrainGrid} = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-6, `${message}: ${a} vs ${b}`)
const plane = h => () => h
const sample = (probe, {x = 0, z = 0, yaw = 0, halfLen = 1, halfWid = .75,
  altitude = 2.5, airborne = true, source = true, bottom = -.3} = {}) =>
  clearance(airborne, source, x, z, yaw, halfLen, halfWid, altitude, probe, bottom)
const checks = []
const check = (name, body) => {body(); checks.push(name)}

check('source provenance, missing data, authored elevation and ramps', () => {
  const view = {w: 2, h: 2, height: new Uint8Array(4), ramp: new Uint8Array(4)}
  assert.equal(flatSource(view), true)
  view.height[3] = 4; assert.equal(flatSource(view), false)
  view.height[3] = 0; view.ramp[0] = 1; assert.equal(flatSource(view), false)
  assert.equal(flatSource(null), false)
  assert.equal(flatSource({...view, height: new Uint8Array(0)}), false)
  assert.equal(flatSource({...view, w: 0}), false)
})
check('absolute source altitude and no double lifting on authored terrain', () => {
  near(sample(plane(0)), 2.5, 'flat sea-level flight')
  near(sample(plane(8)), 10.5, '8m visual mountain plus 2.5m source clearance')
  near(sample(plane(8), {altitude: 10.5, source: false}), 10.5, 'authored 8m ground already included in absolute Z')
  near(sample(plane(-1.6)), 2.5, 'water bed must not lower flight')
})
check('ground, submarine and landed callers bypass without probing', () => {
  const forbidden = () => {throw new Error('unexpected terrain probe')}
  near(sample(forbidden, {airborne: false, altitude: 0}), 0, 'ground bypass')
  near(sample(forbidden, {airborne: false, altitude: -.22}), -.22, 'submarine bypass')
  near(sample(forbidden, {altitude: 0}), 0, 'landed bypass')
  near(sample(forbidden, {source: false}), 2.5, 'authored bypass')
  const a = new Float32Array(16), b = new Float32Array(16), slope = (x, z) => 4 + x * .1 + z * .05
  placeActor(a, 0, 0, 0, .4, 1, .75, false, 0, slope, -.2)
  placeActor(b, 0, 0, 0, .4, 1, .75, false, sample(slope, {airborne: false, altitude: 0}), slope, -.2)
  assert.deepEqual(a, b)
})
check('ridge at hull centre is missed by the old corner average', () => {
  const ridge = x => Math.max(0, 8 * (1 - Math.abs(x) / .2))
  const old = new Float32Array(16), corrected = new Float32Array(16)
  placeActor(old, 0, 0, 0, 0, 1, .75, true, 2.5, ridge)
  placeActor(corrected, 0, 0, 0, 0, 1, .75, true, sample(ridge), ridge)
  assert.ok(old[13] < ridge(0), 'negative control must show the old aircraft buried in the ridge')
  near(corrected[13] - ridge(0), 2.5, 'new centre clearance')
})
check('anticipatory ascent, smooth spatial motion, heading independence and replay', () => {
  const hill = (x, z) => 10 * Math.max(0, 1 - Math.hypot(x - 6, z) / 3)
  assert.ok(sample(hill, {x: 1}) > 2.5, 'rise before current footprint reaches the hill')
  let previous = sample(hill, {x: -2})
  for (let i = 1; i <= 1400; i++) {
    const x = -2 + i * .01, y = sample(hill, {x})
    assert.ok(Math.abs(y - previous) < .05, 'continuous hill should not cause altitude pops')
    near(sample(hill, {x}), y, 'pause/replay cannot advance hidden smoothing state')
    previous = y
  }
  near(sample(hill, {x: 1, yaw: 0}), sample(hill, {x: 1, yaw: Math.PI}), 'reverse heading')
  const northHill = (x, z) => hill(z, x)
  near(sample(hill, {x: 1, halfLen: .75}), sample(northHill, {z: 1, halfLen: .75}), 'radial anticipation covers sideways travel')
})
check('landing converges to old contact and low meshes clear at cruise', () => {
  const y = sample(plane(8), {altitude: 1e-7})
  near(y, 8, 'landing limit')
  near(sample(plane(8), {altitude: .5, bottom: -1}) - 1, 8.05, 'low mesh bottom clears ground')
})

// Production TerrainGrid: RA zero source, nonzero bounds, real reconstructed hills.
const W = 48, H = 40, N = W * H
const view = {w: W, h: H, type: new Uint8Array(N).fill(2), height: new Uint8Array(N),
  ramp: new Uint8Array(N), passability: new Uint8Array(N).fill(7), resource: new Uint8Array(N), surface: new Uint8Array(N).fill(4)}
for (let z = 12; z < 25; z++) for (let x = 24; x < 38; x++) {
  view.surface[z * W + x] = 1; view.passability[z * W + x] = 16
}
const before = Object.fromEntries(Object.entries(view).filter(([, value]) => ArrayBuffer.isView(value)).map(([key, value]) => [key, value.slice()]))
const grid = new TerrainGrid(); grid.build(view, 7, 11)
assert.equal(flatSource(view), true)
assert.equal(grid.hasPresentationRelief, true)
const probe = (x, z) => grid.heightAt(x, z)
let minimumClearance = Infinity, minimumSampledHullClearance = Infinity
let peakAltitude = -Infinity, oldWorstClearance = Infinity, samples = 0
check('production reconstructed mountain: origin, clearance, negative control, no authority writes', () => {
  const m = new Float32Array(16)
  for (let i = 0; i <= 800; i++) {
    const x = 18 + i * .04, z = 30, altitude = sample(probe, {x, z})
    placeActor(m, 0, x, z, 0, 1, .75, true, altitude, probe)
    minimumClearance = Math.min(minimumClearance, m[13] - probe(x, z))
    for (const dx of [-1, 0, 1]) for (const dz of [-.75, 0, .75])
      minimumSampledHullClearance = Math.min(minimumSampledHullClearance, m[13] - .3 - probe(x + dx, z + dz))
    peakAltitude = Math.max(peakAltitude, m[13])
    placeActor(m, 0, x, z, 0, 1, .75, true, 2.5, probe)
    oldWorstClearance = Math.min(oldWorstClearance, m[13] - probe(x, z))
    samples++
  }
  assert.ok(minimumClearance >= 2.5 - 1e-6)
  assert.ok(minimumSampledHullClearance >= 2.2 - 1e-6, 'cruising hull must visibly clear all nine footprint samples')
  assert.ok(peakAltitude > 10)
  assert.ok(oldWorstClearance < 1, 'old placement must fail the clearance requirement')
  for (const [key, value] of Object.entries(before)) assert.deepEqual(view[key], value, `${key} was modified`)
})
console.log('aircraftclearancegate: PASS', JSON.stringify({checks, samples, minimumClearance, minimumSampledHullClearance,
  peakAltitude, oldWorstClearance, integrated: false,
  limitation: 'CPU helper + production terrain/placement gate; no composed-runtime integration or whole animated-mesh collision proof.'}))
