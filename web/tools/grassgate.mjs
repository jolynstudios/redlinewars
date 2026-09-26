#!/usr/bin/env node
// The near-camera grass scatter: determinism, eligibility, budget, recycling.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const web = fileURLToPath(new URL('..', import.meta.url)), temp = mkdtempSync(join(tmpdir(), 'steelseed-grassgate-'))
try {
  const file = join(temp, 'grass.mjs')
  await build({ stdin: { contents: `export { GrassScatter } from './src/units/grass';`, resolveDir: web, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'silent',
    define: { 'import.meta.glob': '__gateGlob' }, banner: { js: 'const __gateGlob = () => ({})' } })
  const { GrassScatter } = await import(pathToFileURL(file))

  // Fake living pack: the module globs the real manifest at import time; hand it a stub
  // asset through the same surface it reads. decodeBlenderAsset needs real bytes, so
  // point the scatter at the real pack via the manifest already on disk by re-globbing
  // here is impossible — instead verify the pure decision logic through rebuild() with a
  // stubbed render and the real terrain math stubbed to a flat grass field.
  const W = 128
  const terrain = {
    surfaceAt: (x, z) => (x < 0 || z < 0 || x >= W || z >= W) ? 8 : ((x * 7 + z * 13) % 41 === 0 ? 0 : 4),
    heightAt: () => 0,
    waterHeightAt: () => null,
  }
  const shroud = { stateAt: (x, z) => (x >= 0 && z >= 0 && x < W && z < W) ? 2 : 0 }
  const submitted = []
  const render = {
    camera: { focus: [64.5, 0, 64.5] },
    upload: (mesh, label) => ({ label }),
    submit: item => submitted.push(item.instanceCount),
  }
  const extras = { nearField: true, windGrass: false, weatherFx: true }
  const playCtx = () => ({ camera: { focus: render.camera.focus }, time: { tick: 0, alpha: 0 }, config: { extras } })

  const stubMesh = { label: 'stub' }
  // The pools are TS-private but this is plain JS: assign the stub meshes directly.
  const make = () => { const g = new GrassScatter(); g.grass.mesh = stubMesh; if (g.shrub) g.shrub.mesh = stubMesh; return g }

  // Seed the private item through init-less construction: exercise update() directly.
  const a = make(), b = make()
  render.camera.focus = [64.5, 0, 64.5]; a.update(playCtx(), render, terrain, shroud)
  const first = a.stats.instances
  assert.ok(first > 400, `ring density too low: ${first} tufts in a ${2 * 26}m circle`)
  assert.ok(first <= 3072, 'budget respected')
  // Determinism: a fresh scatter over the same focus replays identical placements.
  render.camera.focus = [64.5, 0, 64.5]; b.update(playCtx(), render, terrain, shroud)
  const ia = a.instances.subarray(0, first * 16), ib = b.instances.subarray(0, b.stats.instances * 16)
  assert.equal(b.stats.instances, first, 'same focus must place the same count')
  for (let i = 0; i < ia.length; i++) assert.equal(ia[i], ib[i], `transform ${i} diverges between identical runs`)
  // Ring bounds + eligibility of every placement.
  for (let i = 0; i < first; i++) {
    const x = a.instances[i * 16 + 12], z = a.instances[i * 16 + 14]
    const dx = x - 64.5, dz = z - 64.5
    assert.ok(dx * dx + dz * dz <= 26 * 26 + 1e-6, `tuft ${i} outside the ring`)
    const s = terrain.surfaceAt(x, z)
    assert.ok(s === 4 || s === 0, `tuft ${i} on surface ${s}`)
  }
  // Hysteresis: a 1 m drift must NOT rebuild; a 5 m move must.
  const before = a.stats.rebuilds
  render.camera.focus = [65.4, 0, 64.9]; a.update(playCtx(), render, terrain, shroud)
  assert.equal(a.stats.rebuilds, before, 'sub-threshold drift rebuilt the ring')
  render.camera.focus = [69.5, 0, 64.5]; a.update(playCtx(), render, terrain, shroud)
  assert.ok(a.stats.rebuilds > before, 'past-threshold move did not rebuild')
  // Rebuild after the move still deterministic from the new anchor.
  const c = make()
  render.camera.focus = [69.5, 0, 64.5]; c.update(playCtx(), render, terrain, shroud)
  const ca = a.instances.subarray(0, a.stats.instances * 16), cc = c.instances.subarray(0, c.stats.instances * 16)
  assert.equal(c.stats.instances, a.stats.instances)
  for (let i = 0; i < ca.length; i++) assert.equal(ca[i], cc[i])
  console.log('grassgate PASS', JSON.stringify({ instances: first, rebuilds: a.stats.rebuilds, ringCells: a.stats.ringCells }))
} finally { rmSync(temp, { recursive: true, force: true }) }
