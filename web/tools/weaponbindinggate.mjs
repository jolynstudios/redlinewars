#!/usr/bin/env node
// Active RA string-table/name binding, not the legacy FNV8 ABI. Entirely offline:
// no output files, app build, browser, host calls, game events or simulated flight.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const sha = text => createHash('sha256').update(text).digest('hex')
const plain = value => JSON.parse(JSON.stringify(value))
const manifestText = read('../src/weapon-visual-manifest.json')
const manifest = JSON.parse(manifestText)
const catalogText = read('../src/core/ra-visual-manifest.json')
const catalog = JSON.parse(catalogText)
const source = read('../src/fx/weapon-visuals.ts')
const names = [...new Set(Object.values(catalog.actors).flatMap(actor =>
  (actor.slot?.armaments ?? []).map(armament => armament.weapon)))].sort()
assert.equal(names.length, 50, 'Review RA catalog changes explicitly')
assert.equal(manifest.profileCount, 50)
assert.equal(manifest.profiles.length, 50)
assert.deepEqual(manifest.profiles.map(profile => profile.weapon).sort(), names)
assert.equal(manifest.source.sha256, sha(catalogText), 'RA catalog fingerprint is stale')

// Guard the actual host seam, not the legacy Armament.cs observer: field names are
// shared, but RA puts dynamic string-table IDs and positive-warhead sums on the wire.
const observer = read('../../engine/steelseed-host/OpenRA.Mods.Steelseed/SteelseedEventObserver.cs')
const emitter = read('../../engine/steelseed-host/OpenRA.Browser/SnapshotEmitter.cs')
assert.match(observer, /armament\.Info\.Weapon/)
assert.match(observer, /\.Sum\(warhead => Math\.Max\(0, warhead\.Damage\)\)/)
assert.match(emitter, /writer\.U16\(TypeId\(record\.Weapon\)\)/)
assert.match(emitter, /id = \(ushort\)typeNames\.Count/)

const syntax = ts.createSourceFile('weapon-visuals.ts', source, ts.ScriptTarget.ES2022, true)
assert.deepEqual(syntax.statements.filter(ts.isImportDeclaration).map(node => node.moduleSpecifier.text),
  ['../weapon-visual-manifest.json'], 'Runtime must import only its generated root manifest')
const lookup = syntax.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'lookupRaWeaponVisual')
assert(lookup?.body)
assert.equal(lookup.parameters.length, 1, 'RA binding must not depend on legacy caliber or numeric IDs')
function checkLookup(node) {
  assert(!ts.isNewExpression(node) && !ts.isArrayLiteralExpression(node) && !ts.isObjectLiteralExpression(node) &&
    !ts.isTemplateExpression(node) && !ts.isArrowFunction(node) && !ts.isFunctionExpression(node) &&
    !ts.isSpreadElement(node), 'Allocation expression in RA lookup')
  if (ts.isCallExpression(node)) {
    // Two boot-time Maps, not one: the host lowercases its weapon keys
    // (`Ruleset.Weapons` keys on `k.Key.ToLowerInvariant()`), so a live probe found it
    // publishing "dragon" against a manifest authored as "Dragon" and every projectile row
    // was decoded and silently discarded. `lookupRaWeaponVisual` now tries the exact name
    // and falls back to a lowercased Map. Both are built once at module load, so the rule
    // this gate exists to enforce -- no allocation, no per-call work, read only a
    // boot-time Map -- is unchanged. `.toLowerCase()` on the argument is a primitive
    // string op, not an allocation the checks above are aimed at.
    const called = node.expression.getText(syntax)
    assert.ok(called === 'raStylesByName.get' || called === 'raStylesByLowerName.get' ||
      called === 'weaponName.toLowerCase',
      `RA lookup may only read its boot-time Maps; saw ${called}`)
  }
  ts.forEachChild(node, checkLookup)
}
checkLookup(lookup.body)

// Execute the actual helper. Compilation is in memory only; the legacy gate also
// performs the strict no-emit TypeScript check of this helper and JSON dependency.
const javascript = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText
function loadRuntime(data) {
  const counters = { maps: 0, reads: 0, writes: 0 }
  class TrackedMap extends Map {
    constructor(...args) { super(...args); counters.maps++ }
    get(key) { counters.reads++; return super.get(key) }
    set(key, value) { counters.writes++; return super.set(key, value) }
  }
  const exports = {}
  runInNewContext(javascript, { exports, Map: TrackedMap, require: spec => {
    assert.equal(spec, '../weapon-visual-manifest.json')
    return plain(data)
  } }, { timeout: 1000 })
  return { runtime: exports, counters }
}
const { runtime, counters } = loadRuntime(manifest)
// TWO name Maps since the casing fix, not one, and both are still allocated exactly once at
// module boot -- which is the property this gate exists to protect. The host lowercases its
// weapon keys (`Ruleset.Weapons` keys on `k.Key.ToLowerInvariant()`), so a live probe found it
// publishing "dragon" against a manifest authored as "Dragon", and every projectile row was
// decoded and thrown away. The lookup now tries the exact name and falls back to a lowercased
// Map, so the catalog is indexed twice: 50 exact + 50 lowered.
assert.equal(counters.maps, 2, 'Both name Maps are allocated once at module boot')
assert.equal(counters.writes, 100, 'Exactly the current catalog is indexed at boot, once per Map')
const bootWrites = counters.writes
const expectedFingerprint = sha(JSON.stringify(names.map(name =>
  [name, manifest.profiles.find(profile => profile.weapon === name).style])))
function verifyBinding(candidate) {
  assert.equal(candidate.RA_WEAPON_VISUAL_SOURCE_SHA256, manifest.source.sha256, 'RA binding source fingerprint differs')
  const fingerprint = sha(JSON.stringify(names.map(name => [name, plain(candidate.lookupRaWeaponVisual(name))])))
  assert.equal(fingerprint, expectedFingerprint, 'Exact-name/style binding fingerprint differs')
}
verifyBinding(runtime)
verifyBinding(loadRuntime(manifest).runtime)
const reversed = plain(manifest); reversed.profiles.reverse()
verifyBinding(loadRuntime(reversed).runtime)

for (const profile of manifest.profiles) {
  const result = runtime.lookupRaWeaponVisual(profile.weapon)
  assert.deepEqual(plain(result), profile.style, `Wrong exact-name profile: ${profile.weapon}`)
  assert.strictEqual(result, runtime.lookupWeaponVisual(profile.weaponClass, profile.caliber), 'Legacy lookup must remain intact')
  assert(Object.isFrozen(result) && Object.isFrozen(result.tracer) && Object.isFrozen(result.tracer.colorLinearRGB) && Object.isFrozen(result.muzzle))
  const before = counters.reads
  for (let repeat = 0; repeat < 256; repeat++) assert.strictEqual(runtime.lookupRaWeaponVisual(profile.weapon), result)
  assert.equal(counters.reads - before, 256, 'Exactly one Map read per known-name lookup')
  // Even a valid legacy class is not a valid input to the RA name API.
  assert.strictEqual(runtime.lookupRaWeaponVisual(profile.weaponClass), runtime.UNKNOWN_WEAPON_VISUAL)
  assert.strictEqual(runtime.lookupRaWeaponVisual(String(profile.weaponClass)), runtime.UNKNOWN_WEAPON_VISUAL)
}

// Caller resolves the SAME ID through the CURRENT shared host table. Neither its
// value nor a matching legacy caliber can override the actual resolved name.
const tesla = manifest.profiles.find(profile => profile.weapon === 'TeslaZap')
const firstTable = new Map([[tesla.weaponClass, 'Heal'], [0, 'M1Carbine'], [4096, 'TeslaZap']])
const secondTable = new Map([[tesla.weaponClass, 'Dragon'], [0, 'Repair'], [4096, 'Pistol']])
const resolveFire = (table, fire) => runtime.lookupRaWeaponVisual(table.get(fire.weaponClass) ?? '')
assert.equal(runtime.lookupWeaponVisual(tesla.weaponClass, tesla.caliber).family, 'electric')
assert.equal(resolveFire(firstTable, { weaponClass: tesla.weaponClass, caliber: tesla.caliber }).family, 'heal')
assert.equal(resolveFire(secondTable, { weaponClass: tesla.weaponClass, caliber: tesla.caliber }).family, 'rocket')
assert.equal(resolveFire(firstTable, { weaponClass: 0, caliber: 1000 }).family, 'bullet')
assert.equal(resolveFire(firstTable, { weaponClass: 4096, caliber: 10000 }).family, 'electric')
assert.strictEqual(resolveFire(firstTable, { weaponClass: 65534, caliber: 10000 }), runtime.UNKNOWN_WEAPON_VISUAL)
for (const name of ['Heal', 'Repair']) {
  const table = new Map([[500, name]])
  assert.equal(resolveFire(table, { weaponClass: 500, caliber: 0 }).family, 'heal')
  assert.strictEqual(resolveFire(table, { weaponClass: 500, caliber: 0 }), runtime.lookupRaWeaponVisual(name))
}

const poison = { toString() { throw new Error('Lookup must not coerce an input into a name') } }
// CASE VARIANTS NOW RESOLVE, and that is the point rather than a relaxation. `Ruleset.Weapons`
// keys on `k.Key.ToLowerInvariant()`, so the host published "dragon" against a manifest
// authored as "Dragon"; a live probe showed the projectile section working and every row being
// decoded and thrown away by this lookup. A case-insensitive fallback was added at the source
// and here. Whitespace variants stay UNKNOWN below -- trimming an input is coercion, which is
// exactly what the `poison` object guards against, and the host never emits padded names.
for (const variant of ['teslazap', 'TESLAZAP', 'TeSlAzAp'])
  assert.strictEqual(runtime.lookupRaWeaponVisual(variant), runtime.lookupRaWeaponVisual('TeslaZap'),
    `a case variant must resolve to its authored profile, or the host's lowercased names are silently discarded: ${variant}`)
for (const name of ['', 'UnknownWeapon', 'unknown', 'TeslaZap ', ' TeslaZap', 'Heal\0',
  'e1', '1tnk', 'RivetArc', 'ClampDriver', '__proto__', 'constructor', 'toString', 'hasOwnProperty',
  null, undefined, NaN, Infinity, 0, 3, 4096, 65535, true, poison, ['TeslaZap']])
  assert.strictEqual(runtime.lookupRaWeaponVisual(name), runtime.UNKNOWN_WEAPON_VISUAL)
for (const name of ['Heal', 'Repair', 'DemoTruckTargeting', 'DogJaw', 'claw', 'mandible', 'MandibleHeavy', 'UnknownWeapon']) {
  const style = runtime.lookupRaWeaponVisual(name)
  assert.equal(style.tracer.style, 'none'); assert.equal(style.tracer.widthM, 0); assert.equal(style.tracer.lifetimeSeconds, 0)
  assert.equal(style.muzzle.style, 'none'); assert.equal(style.muzzle.scaleM, 0)
  assert.equal(style.smoke, 'none'); assert.equal(style.impact, 'none', `${name} must not become an explosion`)
}
assert.equal(runtime.lookupRaWeaponVisual('DemoTruckTargeting').family, 'utility')
// Still two, after every lookup above including the case variants: the fallback reads a Map
// built at boot, it does not build one on demand.
assert.equal(counters.maps, 2)
assert.equal(counters.writes, bootWrites, 'Lookup must never populate a cache or mutate the name Map')

// Falsification: name swaps and authored-style/source changes must break the binding
// fingerprint even when legacy numeric keys remain untouched and legal.
const swapped = plain(manifest)
;[swapped.profiles[0].weapon, swapped.profiles[1].weapon] = [swapped.profiles[1].weapon, swapped.profiles[0].weapon]
assert.throws(() => verifyBinding(loadRuntime(swapped).runtime), /binding fingerprint differs/)
const changed = plain(manifest); changed.profiles[0].style.tracer.widthM += .001
assert.throws(() => verifyBinding(loadRuntime(changed).runtime), /binding fingerprint differs/)
const changedSource = plain(manifest); changedSource.source.sha256 = '0'.repeat(64)
assert.throws(() => verifyBinding(loadRuntime(changedSource).runtime), /source fingerprint differs/)
const conflict = plain(manifest); conflict.profiles[1].weapon = conflict.profiles[0].weapon
assert.throws(() => loadRuntime(conflict), /Conflicting RA weapon visual name binding/)
const invalid = plain(manifest); invalid.profiles[0].weapon = ''
assert.throws(() => loadRuntime(invalid), /Invalid RA weapon visual name binding/)

console.log('weaponbindinggate: PASS', JSON.stringify({ names: names.length,
  sourceSha256: manifest.source.sha256, manifestSha256: sha(manifestText), bindingSha256: expectedFingerprint,
  bootMaps: counters.maps, bootNameEntries: bootWrites, repeatedLookups: names.length * 256, negativeControls: 5,
  limitation: 'Exact RA name binding only. Caller resolves host IDs; no renderer, live event or projectile-flight claim.' }))
