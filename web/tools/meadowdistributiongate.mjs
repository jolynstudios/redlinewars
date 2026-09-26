#!/usr/bin/env node
// Offline CPU distribution regression, not a GPU/visible-density quality claim.
// Executes the actual TS helper in memory; reads but never rewrites Environment.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const source = read('../src/units/meadow-distribution.ts')
const environment = read('../src/units/scenery-scan.ts')
const host = read('../src/units/environment.ts')
const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
function loadSample() {
  const exports = {}
  runInNewContext(ts.transpileModule(source, { compilerOptions: options }).outputText,
    { exports }, { timeout: 1000 })
  assert.equal(typeof exports.meadowSample, 'function')
  return exports.meadowSample
}
const sample = loadSample(), freshSample = loadSample()

function descendants(root, predicate) {
  const found = []
  function visit(node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit) }
  visit(root)
  return found
}
// Deliberately narrow AST contract for the current consumer. This proves channel
// routing and full-cell formulas, not execution of terrain/shroud/render branches.
function checkIntegration(text) {
  const tree = ts.createSourceFile('scenery-scan.ts', text, ts.ScriptTarget.ES2022, true)
  assert.equal(tree.parseDiagnostics.length, 0)
  const compact = node => node.getText(tree).replace(/\s+/g, '')
  const imports = tree.statements.filter(ts.isImportDeclaration).filter(node =>
    node.moduleSpecifier.text === './meadow-distribution')
  assert.equal(imports.length, 1, 'The scan must import the actual meadow helper')
  assert.equal(compact(imports[0].importClause), '{meadowSample}')
  const scan = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'scanScenery')
  assert(scan?.body)
  const branches = descendants(scan.body, node => ts.isIfStatement(node) && compact(node.expression) === 'cardGrass')
  assert.equal(branches.length, 1)
  const loops = descendants(branches[0].thenStatement, ts.isForStatement)
  assert.equal(loops.length, 1)
  const loop = loops[0]
  assert.equal(compact(loop.initializer), 'letblade=0')
  assert.equal(compact(loop.condition), 'blade<grassPerCell')
  assert.equal(compact(loop.incrementor), 'blade++')
  const declarations = descendants(loop.statement, ts.isVariableDeclaration)
  for (const [name, expected] of [['px', 'wx+meadowSample(wx,wz,blade,0)'], ['pz', 'wz+meadowSample(wx,wz,blade,1)']]) {
    const nodes = declarations.filter(node => node.name.getText(tree) === name)
    assert.equal(nodes.length, 1)
    assert.equal(compact(nodes[0].initializer), expected, `${name}: full-cell independent position channel`)
  }
  const places = descendants(loop.statement, node => ts.isCallExpression(node) && compact(node.expression) === 'place')
  assert.equal(places.length, 1)
  const args = places[0].arguments
  // The pool lookup is hoisted per frame (documented loop-invariant hoist in scan());
  // the staged identifier must still resolve to the grass pool.
  assert.equal(compact(args[0]), 'grassPool')
  assert.equal(compact(args[4]), 'px'); assert.equal(compact(args[6]), 'pz')
  assert.equal(compact(args[7]), '.7+meadowSample(wx,wz,blade,3)*.5', 'scale must use channel 3')
  assert.equal(compact(args[8]), 'meadowSample(wx,wz,blade,2)*Math.PI*2', 'yaw must use channel 2')
  const calls = descendants(tree, node => ts.isCallExpression(node) && compact(node.expression) === 'meadowSample')
  assert.equal(calls.length, 4, 'Meadow helper must stay confined to four card-grass channels')
  for (const call of calls) assert(call.pos >= loop.pos && call.end <= loop.end)
}
assert(host.includes('scanScenery('), 'Environment must run the shared scan')
checkIntegration(environment)
for (const [before, after] of [
  ['meadowSample(wx, wz, blade, 3)', 'meadowSample(wx, wz, blade, 0)'],
  ['meadowSample(wx, wz, blade, 2)', 'meadowSample(wx, wz, blade, 0)'],
  ['wx + meadowSample(wx, wz, blade, 0)', 'wx + .06 + meadowSample(wx, wz, blade, 0) * .88'],
]) {
  assert(environment.includes(before), 'Integration negative-control target must exist')
  assert.throws(() => checkIntegration(environment.replace(before, after)), assert.AssertionError)
}

const origins = [[0, 0], [32, 48], [-64, -64]]
const side = 128, clumps = 4, count = side * side * clumps
const directions = [[1, 0], [0, 1], [1, 1], [1, -1]]
const frequencies = [[1, 0], [0, 1], [1, 1], [1, -1]]
const correlationLimit = .02, harmonicLimit = .02
const boundaryExpected = 1 - .88 ** 2, boundaryTolerance = .01
function pearson(a, b) {
  let sx = 0, sy = 0, xx = 0, yy = 0, xy = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i]
    sx += x; sy += y; xx += x * x; yy += y * y; xy += x * y
  }
  return (a.length * xy - sx * sy) / Math.sqrt((a.length * xx - sx * sx) * (a.length * yy - sy * sy))
}
const actual = (x, z, b) => [0, 1, 2, 3].map(c => sample(x, z, b, c))
function measure(fn, origin, inset = false, repeat = false) {
  const channels = Array.from({ length: 4 }, () => new Float64Array(count))
  const neighbors = directions.map(() => Array.from({ length: 4 }, () => new Float64Array(count)))
  const real = [0, 0, 0, 0], imag = [0, 0, 0, 0]
  let edge = 0, i = 0
  for (let z = 0; z < side; z++) for (let x = 0; x < side; x++) for (let b = 0; b < clumps; b++, i++) {
    const wx = x + origin[0], wz = z + origin[1], values = fn(wx, wz, b)
    // Reverse channel order on a fresh module to catch state/order-dependent RNG.
    for (let c = 3; c >= 0; c--) {
      const value = values[c]
      assert(Number.isFinite(value) && value >= 0 && value < 1, 'Finite [0,1) sample required')
      channels[c][i] = value
      if (repeat) {
        assert.equal(value, sample(wx, wz, b, c), 'Repeated lookup changed')
        assert.equal(value, freshSample(wx, wz, b, c), 'Fresh module/reordered channels changed')
      }
    }
    const px = inset ? .06 + values[0] * .88 : values[0]
    const pz = inset ? .06 + values[1] * .88 : values[1]
    if (px < .06 || px >= .94 || pz < .06 || pz >= .94) edge++
    for (let k = 0; k < frequencies.length; k++) {
      // Integer world-cell terms vanish at these integer spatial frequencies.
      const phase = 2 * Math.PI * (px * frequencies[k][0] + pz * frequencies[k][1])
      real[k] += Math.cos(phase); imag[k] += Math.sin(phase)
    }
    for (let d = 0; d < directions.length; d++) {
      const next = fn(wx + directions[d][0], wz + directions[d][1], b)
      for (let c = 0; c < 4; c++) neighbors[d][c][i] = next[c]
    }
  }
  const cross = []
  for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) cross.push(pearson(channels[a], channels[b]))
  const adjacent = neighbors.map(group => group.map((values, c) => pearson(channels[c], values)))
  return { origin, cross, adjacent, harmonics: real.map((v, k) => Math.hypot(v, imag[k]) / count), boundary: edge / count }
}
function checkCorrelations(result) {
  for (const value of [...result.cross, ...result.adjacent.flat()])
    assert(Number.isFinite(value) && Math.abs(value) < correlationLimit, `correlation ${value} at ${result.origin}`)
}
function checkGrid(result) {
  for (const value of result.harmonics)
    assert(Number.isFinite(value) && value < harmonicLimit, `grid harmonic ${value} at ${result.origin}`)
}
function checkBoundary(result) {
  assert(Math.abs(result.boundary - boundaryExpected) <= boundaryTolerance, `boundary occupancy ${result.boundary}`)
}
const results = origins.map(origin => measure(actual, origin, false, true))
for (const result of results) { checkCorrelations(result); checkGrid(result); checkBoundary(result) }

// All quality-tier clump IDs plus signed-world edge cases: repeat keys in reverse
// traversal, not only adjacent repeated calls. No invalid-input policy is invented.
const keys = []
for (const x of [-2147483648, -4097, -1, 0, 1, 4097, 2147483647])
  for (const z of [-4097, -1, 0, 1, 4097]) for (let b = 0; b < 12; b++) for (let c = 0; c < 4; c++) {
    const value = sample(x, z, b, c)
    assert(Number.isFinite(value) && value >= 0 && value < 1)
    keys.push([x, z, b, c, value])
  }
for (const [x, z, b, c, value] of keys.reverse()) assert.equal(freshSample(x, z, b, c), value)

// Frozen pre-fix control: not imported from the now-fixed consumer. It MUST fail
// both correlation and spatial-grid tests, separately, on every fixed window.
function oldHash(x, z) {
  let h = Math.imul(x ^ 0x5bd1e995, 0x27d4eb2d) ^ Math.imul(z, 0x85ebca6b)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}
function oldSample(x, z, b) {
  const shared = oldHash(x * 19 + b * 71, z * 23 + b * 41)
  return [shared, oldHash(z * 13 + b * 29, x * 17 + b * 37), shared, shared]
}
const baseline = origins.map(origin => measure(oldSample, origin, true))
for (const result of baseline) {
  assert.throws(() => checkCorrelations(result), /correlation/)
  assert.throws(() => checkGrid(result), /grid harmonic/)
  assert.throws(() => checkBoundary(result), /boundary occupancy/)
  // Ensure rejection isn't only the perfectly shared yaw/scale channels.
  assert(Math.abs(result.adjacent[1][0]) > correlationLimit)
  assert(Math.abs(result.adjacent[0][1]) > correlationLimit)
}
// Isolate regressions: good hash cannot cure insets, nor shared style channels.
const insetOnly = measure(actual, origins[0], true)
checkCorrelations(insetOnly)
assert.throws(() => checkGrid(insetOnly), /grid harmonic/)
assert.throws(() => checkBoundary(insetOnly), /boundary occupancy/)
const sharedOnly = measure((x, z, b) => { const v = actual(x, z, b); return [v[0], v[1], v[0], v[0]] }, origins[0])
checkGrid(sharedOnly); checkBoundary(sharedOnly)
assert.throws(() => checkCorrelations(sharedOnly), /correlation/)

console.log('meadowdistributiongate: PASS', JSON.stringify({
  helperSha256: createHash('sha256').update(source).digest('hex'),
  samplesPerWindow: count, channels: ['x', 'z', 'yaw', 'scale'], directions, frequencies,
  limits: { correlationLimit, harmonicLimit, boundaryExpected, boundaryTolerance },
  results, baseline, signedTierRepeatKeys: keys.length, integrationNegativeControls: 3,
  isolatedNegativeControls: ['inset-only', 'shared-channels-only'],
  limitation: 'Actual helper CPU distribution + narrow Environment AST routing; no GPU, filtered-scene, visual-improvement or blue-noise claim.',
}))
