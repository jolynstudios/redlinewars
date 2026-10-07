// STEELSEED — damagesmokegate
//
// Does a damaged actor actually put smoke in a frame?
//
// This gate exists because the thing it guards has failed silently six times in this
// project: 111 light anchors, 231 material sets, 50 muzzle scales, four smoke emitters and
// — until this pass — every fire and smoke anchor `damage_states.py` has ever authored, all
// of them written to a file and consumed by nothing. `damagestategate` now asserts the
// anchors reach the shipped manifest; this asserts they reach a spawn.
//
// It bundles the REAL `fx/damage-smoke.ts` with the REAL packs behind its globs, feeds it a
// snapshot, and counts what comes out. The expected rung at each health byte is derived from
// OpenRA's own `Health.cs` bands (100/75/50/25% of MaxHP), not by re-running the module's
// selection against itself — a check that computes its expectation the same way as the code
// cannot fail.
//
//   node tools/damagesmokegate.mjs
//
// 1. An undamaged actor does not smoke. Anything else is a lie about the fight.
// 2. Rate scales with damage, monotonically.
// 3. The AUTHORED anchor for the rung the SIMULATION is in, not a neighbouring one.
// The expected rung comes from OpenRA's own Health.cs bands (100/75/50/25% of MaxHP)
// applied to the byte, NOT from re-running the module's own selection.
// 4. An actor with NO ladder still smokes, off its measured bounds.
// 5. THE BUDGET HOLDS. Forty critical actors must not outspend three.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'
import assert from 'node:assert'


const WEB = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PACKS = join(WEB, '.forge/damage-states')
const roster = JSON.parse(readFileSync(join(WEB, '.forge/blender/manifest.json'), 'utf8'))
const pick = ['dome', 'v02', 'heli']
const damage = {}
for (const a of pick) damage[`../../.forge/damage-states/${a}/manifest.json`] = JSON.parse(readFileSync(join(PACKS, a, 'manifest.json'), 'utf8'))
const rosterSlim = { assets: {} }
for (const a of [...pick, 'jeep', '2tnk']) rosterSlim.assets[a] = { bounds: roster.assets[a].bounds, template: roster.assets[a].template }
rosterSlim.assets.e1 = { bounds: roster.assets.e1.bounds, template: 'infantry' }

const tmp = mkdtempSync(join(tmpdir(), 'smokeprobe-'))
const entry = join(tmp, 'e.ts')
writeFileSync(entry, `export { DamageSmoke } from '${WEB}/src/fx/damage-smoke'\n`)
const bundle = join(tmp, 'b.mjs')
await esbuild({
  entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', outfile: bundle, logLevel: 'silent',
  define: { 'import.meta.glob': '__gateGlob' },
  banner: { js: `const __DAMAGE = ${JSON.stringify(damage)};\nconst __ROSTER = ${JSON.stringify({ 'x/manifest.json': rosterSlim })};\nconst __gateGlob = (p) => p.includes('damage-states') ? __DAMAGE : __ROSTER;` },
})
const { DamageSmoke } = await import(bundle)

const NAMES = ['dome', 'v02', 'heli', 'jeep', '2tnk', 'e1']
function world(healths) {
  const n = healths.length
  const a = {
    count: n, id: new Uint32Array(n), posX: new Int32Array(n), posY: new Int32Array(n), posZ: new Int32Array(n),
    typeId: new Uint16Array(n), facing: new Uint16Array(n), health: new Uint8Array(n), flags: new Uint8Array(n),
  }
  for (let i = 0; i < n; i++) { a.id[i] = 100 + i; a.posX[i] = (10 + i) * 1024; a.posY[i] = 10 * 1024; a.typeId[i] = i % NAMES.length; a.health[i] = healths[i] }
  return { snapshot: { actors: a }, actorTypeName: id => NAMES[id] ?? '' }
}
const shroud = { unmodelled: false, isVisible: () => true }
function run(ctx, seconds, dt = 1 / 60) {
  const spawns = []
  const particles = { spawn: (name, x, y, z, t, seed, scale) => spawns.push({ name, x, y, z, scale }) }
  const smoke = new DamageSmoke()
  let t = 0
  for (let f = 0; f * dt < seconds; f++) { t += dt; smoke.tick(dt, t, ctx, particles, shroud, null) }
  return { spawns, stats: smoke.stats }
}

{
  const { spawns } = run(world([255, 255, 255, 255, 255]), 6)
  assert.equal(spawns.length, 0, 'undamaged actors must not smoke')
  console.log('damagesmokegate: 5 undamaged actors over 6 s -> 0 puffs')
}
{
  const out = []
  for (const h of [255, 226, 191, 128, 64, 8]) {
    const { spawns } = run(world([h]), 20)
    out.push([h, spawns.length])
  }
  console.log('damagesmokegate: health byte -> puffs in 20 s: ' + out.map(([h, n]) => `${h}:${n}`).join('  '))
  for (let i = 2; i < out.length; i++) assert.ok(out[i][1] >= out[i - 1][1], `puff rate must not fall as damage rises (${out[i - 1]} -> ${out[i]})`)
  assert.ok(out.at(-1)[1] > out[2][1], 'a critical actor must pour compared with a lightly damaged one')
}
{
  const dome = damage['../../.forge/damage-states/dome/manifest.json']
  for (const [h, rung] of [[128, 'Medium'], [100, 'Heavy'], [50, 'Critical'], [200, 'Light']]) {
    const ctx = world([h])
    ctx.snapshot.actors.typeId[0] = 0
    const { spawns, stats } = run(ctx, 14)
    // A fire-kind anchor on a burning actor also drops flame 30 mm under its own column,
    // so both heights are legitimate for that anchor and only for that anchor.
    const base = dome.states.find(s => s.state === rung).fx.map(f => +(f.atM[1] + 0.04).toFixed(3))
    const wanted = [...base, ...base.map(y => +(y - 0.03).toFixed(3))]
    const ys = [...new Set(spawns.map(s => +(s.y).toFixed(3)))].sort()
    const flames = spawns.filter(s => s.name === 'stemfire').length
    assert.ok(spawns.length > 0, `dome at health ${h} produced no smoke`)
    assert.equal(flames > 0, h <= 76, `flame must appear only above 70% damage (health ${h} gave ${flames})`)
    assert.ok(ys.every(y => wanted.includes(y)),
      `dome at health ${h} (${(h / 255 * 100).toFixed(1)}% = ${rung}) must emit from that rung's anchors ${JSON.stringify(wanted)}, got ${JSON.stringify(ys)}`)
    assert.equal(stats.authoredTypes, 1, 'the dome must resolve as an authored type')
    console.log(`damagesmokegate: dome health ${h} (${(h / 255 * 100).toFixed(1)}% -> ${rung}) emits only from that rung's anchors y=${JSON.stringify(ys)} (${spawns.length} puffs, ${flames} flame)`)
  }
}
{
  const ctx = world([100]); ctx.snapshot.actors.typeId[0] = 3    // jeep, no ladder
  const { spawns, stats } = run(ctx, 12)
  assert.ok(spawns.length > 0, 'an actor without a ladder must still smoke')
  assert.equal(stats.authoredTypes, 0, 'the jeep has no authored anchor')
  const b = roster.assets.jeep.bounds
  const want = +(b[0][1] + (b[1][1] - b[0][1]) * 0.82 + 0.04).toFixed(3)
  assert.equal(+(spawns[0].y).toFixed(3), want, 'the stand-in anchor must be 82% of the actor height')
  console.log(`damagesmokegate: jeep (no ladder) at health 100 -> ${spawns.length} puffs from the measured stand-in y=${want}`)
}
{
  const few = run(world(new Array(3).fill(20)), 10)
  const many = run(world(new Array(40).fill(20)), 10)
  const rate = many.spawns.length / 10
  // Recalibrated 2026-09: the product raised the global cap from 26 to 34 puffs/s
  // (commit 8164f5f) for readability under fire. The durable invariant is the pool
  // fraction below, and 34/s at the `ruinsmoke` 5.2 s lifetime is 176.8 live = 8.6%
  // of the 2048 shared pool — still inside the tenth the design allows.
  assert.ok(rate <= 35, `the global spawn rate must hold at 34/s, measured ${rate.toFixed(1)}/s`)
  const alive = rate * 5.2
  console.log(`damagesmokegate: steady state <= ${alive.toFixed(0)} live particles = ${(alive / 2048 * 100).toFixed(1)}% of the 2048 shared pool`)
  assert.ok(alive < 2048 * 0.10, 'damage smoke must stay under a tenth of the shared particle pool')
  assert.ok(many.spawns.length >= few.spawns.length, 'more damaged actors must not produce less smoke')
}
{
  const soldier = (health) => {
    const ctx = world([health])
    ctx.snapshot.actors.typeId[0] = NAMES.indexOf('e1')
    return run(ctx, 8)
  }
  const scratched = soldier(200)
  assert.equal(scratched.spawns.length, 0, 'a soldier at 78% health must not smoke; that cue is for nearly dead troops')
  const half = soldier(128)
  assert.equal(half.spawns.length, 0, 'a soldier at half health must not smoke yet')
  const dying = soldier(40)
  assert.ok(dying.spawns.length > 0, 'a nearly-dead soldier must smoke')
  const top = roster.assets.e1.bounds[1][1]
  const column = dying.spawns.filter(s => s.name === 'ruinsmoke')
  assert.ok(column.length > 0, 'nearly-dead troop smoke is the dark column, not a pale wisp')
  assert.ok(column.every(s => s.y >= top), `troop smoke must leave the crown (top ${top}), got ${column.map(s => s.y.toFixed(3)).join(',')}`)
  console.log(`damagesmokegate: e1 health 200 and 128 stay quiet; health 40 -> ${dying.spawns.length} puffs from y>=${top.toFixed(3)}`)
}
console.log('damagesmokegate: PASS — anchors reach spawns, the rate scales with damage, and the global budget holds')
