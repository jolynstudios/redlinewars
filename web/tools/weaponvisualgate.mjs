#!/usr/bin/env node
// Offline source/ABI/style gate, not a renderer or flight-observer integration claim.
// No full build, output writes, browser, GPU, engine mutation or running-game access.
// Usage: node web/tools/weaponvisualgate.mjs [--falsify=electric|heal|collision|missing]
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'
import {
  forgeWeaponVisuals, serializeManifest, stableWeaponClass, presentationCaliber,
  assertCompatibleProfiles, authorStyle, MAX_PROFILES, OUTPUT_URL,
} from './weaponvisual-forge.mjs'

const sourceText = readFileSync(new URL('../src/core/ra-visual-manifest.json', import.meta.url), 'utf8')
const diskText = readFileSync(OUTPUT_URL, 'utf8')
const manifest = JSON.parse(diskText)
const metadata = JSON.parse(sourceText)
const runtimePath = fileURLToPath(new URL('../src/fx/weapon-visuals.ts', import.meta.url))
const runtimeText = readFileSync(runtimePath, 'utf8')
const args = process.argv.slice(2)
const falsify = args[0]?.replace('--falsify=', '')
assert(args.length <= 1 && (!args.length || args[0].startsWith('--falsify=') && ['electric', 'heal', 'collision', 'missing'].includes(falsify)), 'Unknown gate argument')

// Validate on-disk determinism before injecting in-memory negative controls.
assert.equal(diskText, serializeManifest(forgeWeaponVisuals(sourceText)), 'Generated manifest is stale')
assert.equal(serializeManifest(forgeWeaponVisuals(sourceText)), serializeManifest(forgeWeaponVisuals(sourceText)), 'Repeat output differs')
const reordered = { ...metadata, actors: Object.fromEntries(Object.entries(metadata.actors).reverse()) }
assert.deepEqual(forgeWeaponVisuals(JSON.stringify(reordered)).profiles, manifest.profiles, 'Actor enumeration changes profiles')

if (falsify === 'electric') manifest.profiles.find(p => p.weapon === 'TeslaZap').style = authorStyle('Pistol')
if (falsify === 'heal') manifest.profiles.find(p => p.weapon === 'Heal').style = authorStyle('155mm')
if (falsify === 'missing') manifest.profiles.pop()
if (falsify === 'collision') {
  manifest.profiles[1].weaponClass = manifest.profiles[0].weaponClass
  manifest.profiles[1].caliber = manifest.profiles[0].caliber
  manifest.profiles[1].style = authorStyle('Heal')
}
assertCompatibleProfiles(manifest.profiles)

// Independent ABI oracle uses BigInt arithmetic instead of the forge's imul.
function referenceId(name) {
  let hash = 2166136261n
  for (let i = 0; i < name.length; i++) hash = ((hash ^ BigInt(name.charCodeAt(i))) * 16777619n) & 0xffffffffn
  return Number(hash % 255n) + 1
}
for (const name of ['', '25mm', 'TeslaZap', 'teslazap', 'weapon-\u{1f680}', 'é', 'x'.repeat(1024)])
  assert.equal(stableWeaponClass(name), referenceId(name), `FNV UTF-16/wrap mismatch: ${name}`)
for (const [damage, expected] of [[0, 0], [-5000, 5000], [100000, 65535], [-2147483648, 65535], [2147483647, 65535]])
  assert.equal(presentationCaliber(damage), expected)
for (const invalid of [NaN, Infinity, undefined, 1.5, 2147483648, -2147483649])
  assert.throws(() => presentationCaliber(invalid), /Invalid authoritative damage/)
const engine = readFileSync(new URL('../../engine/OpenRA.Mods.Common/Traits/Armament.cs', import.meta.url), 'utf8')
assert.match(engine, /presentationWeaponClass = StableId\(info\.Weapon\)/)
assert.match(engine, /uint hash = 2166136261;[\s\S]*?hash \^= value\[i\];[\s\S]*?hash \*= 16777619;[\s\S]*?hash % byte\.MaxValue \+ 1/)
assert.match(engine, /Math\.Clamp\(Math\.Abs\(\(long\)damage\.Damage\), 0, ushort\.MaxValue\)/)

const catalog = new Map()
const allRefs = new Map()
for (const [actor, data] of Object.entries(metadata.actors)) {
  for (const [index, arm] of (data.slot?.armaments ?? []).entries()) {
    catalog.set(arm.weapon, arm)
    const refs = allRefs.get(arm.weapon) ?? []
    refs.push(`${actor}/${index}`)
    allRefs.set(arm.weapon, refs)
  }
}
assert.equal(catalog.size, 50, 'Catalog changed; review authored coverage and expected class census')
assert.equal(manifest.profiles.length, catalog.size, 'Catalog coverage lost')
assert.equal(manifest.profileCount, catalog.size)
assert.deepEqual(manifest.profiles.map(p => p.weapon).sort(), [...catalog.keys()].sort())
const classCounts = {}
const pairs = new Set()
for (const profile of manifest.profiles) {
  const arm = catalog.get(profile.weapon)
  classCounts[arm.projectile] = (classCounts[arm.projectile] ?? 0) + 1
  assert.equal(profile.weaponClass, referenceId(arm.weapon))
  assert.equal(profile.caliber, Math.min(Math.abs(arm.damage), 65535))
  assert.equal(profile.projectileClass, arm.projectile)
  const key = `${profile.weaponClass}/${profile.caliber}`
  assert(!pairs.has(key), `Current catalog unexpectedly aliases pair ${key}`)
  pairs.add(key)
  assert.equal(profile.provenance.authoring.kind, 'original')
  assert.equal(profile.provenance.authoring.key, profile.weapon, 'Known weapon lacks explicit original authoring')
  assert.equal(profile.provenance.authoring.source, 'web/tools/weaponvisual-forge.mjs')
  assert.equal(profile.provenance.authoritative.source, 'web/src/core/ra-visual-manifest.json')
  assert.equal(profile.provenance.authoritative.damage, arm.damage)
  assert.deepEqual(profile.provenance.authoritative.refs.map(r => `${r.actor}/${r.armamentIndex}`).sort(), allRefs.get(arm.weapon).sort())
}
assert.deepEqual(classCounts, { ballistic: 20, rocket: 13, directFire: 16, lobbed: 1 })

// Collision controls: a real FNV alias, compatible style allowed, conflicting rejected;
// the same id with distinct calibers must remain separately resolvable.
const first = manifest.profiles.find(p => p.weapon === '25mm')
let alias
for (let i = 0; i < 10000; i++) {
  if (referenceId(`alias-${i}`) === first.weaponClass) { alias = `alias-${i}`; break }
}
assert(alias, 'Failed to construct independent FNV collision fixture')
const sameStyle = { ...first, weapon: alias, weaponClass: stableWeaponClass(alias) }
assert.doesNotThrow(() => assertCompatibleProfiles([first, sameStyle]))
assert.throws(() => assertCompatibleProfiles([first, { ...sameStyle, style: authorStyle('Heal') }]), /Conflicting weapon visual collision/)
assert.doesNotThrow(() => assertCompatibleProfiles([first, { ...sameStyle, caliber: first.caliber + 1, style: authorStyle('Heal') }]))
assert.throws(() => assertCompatibleProfiles(Array(MAX_PROFILES + 1).fill(first)), /budget exceeded/)

// Unknown names/classes never infer orange bullets from raw damage or transport class.
for (const name of ['FutureWeapon', '__proto__', 'constructor', 'toString']) {
  const future = { schemaVersion: 2, sourceCommit: 'fixture', actors: { fixture: { slot: { armaments: [{ weapon: name, damage: 123, projectile: 'futureTransport' }] } } } }
  const generated = forgeWeaponVisuals(JSON.stringify(future))
  assert.equal(generated.profiles[0].style.family, 'unknown')
  assert.deepEqual(generated.profiles[0].style, manifest.fallback)
}
const inconsistent = { schemaVersion: 2, actors: { fixture: { slot: { armaments: [
  { weapon: 'Pistol', damage: 100, projectile: 'directFire' }, { weapon: 'Pistol', damage: 101, projectile: 'directFire' },
] } } } }
assert.throws(() => forgeWeaponVisuals(JSON.stringify(inconsistent)), /Inconsistent weapon metadata/)
const collisionSource = { schemaVersion: 2, actors: { fixture: { slot: { armaments: [
  { weapon: first.weapon, damage: first.caliber, projectile: 'ballistic' },
  { weapon: alias, damage: first.caliber, projectile: 'futureTransport' },
] } } } }
assert.throws(() => forgeWeaponVisuals(JSON.stringify(collisionSource)), /Conflicting weapon visual collision/)
// Balance changes may change the ABI key but must not scale presentation by damage.
const balanced = damage => forgeWeaponVisuals(JSON.stringify({ schemaVersion: 2, actors: {
  fixture: { slot: { armaments: [{ weapon: 'Colt45', damage, projectile: 'directFire' }] } },
} })).profiles[0]
assert.notEqual(balanced(1).caliber, balanced(60000).caliber)
assert.deepEqual(balanced(1).style, balanced(60000).style)

// Typecheck just this helper and its JSON dependency, no emit and no app build.
const compilerOptions = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, resolveJsonModule: true,
  strict: true, noEmit: true, skipLibCheck: true, types: [],
}
const program = ts.createProgram([runtimePath], compilerOptions)
const diagnostics = ts.getPreEmitDiagnostics(program)
assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCurrentDirectory: () => process.cwd(), getCanonicalFileName: f => f, getNewLine: () => '\n',
}))

// Execute the actual runtime source in memory with exactly its generated JSON import.
const syntax = ts.createSourceFile(runtimePath, runtimeText, ts.ScriptTarget.ES2022, true)
const imports = syntax.statements.filter(ts.isImportDeclaration)
assert.deepEqual(imports.map(i => i.moduleSpecifier.text), ['../weapon-visual-manifest.json'])
const lookup = syntax.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'lookupWeaponVisual')
assert(lookup?.body)
function checkLookup(node) {
  assert(!ts.isNewExpression(node) && !ts.isArrayLiteralExpression(node) && !ts.isObjectLiteralExpression(node) &&
    !ts.isTemplateExpression(node) && !ts.isArrowFunction(node), 'Allocation expression in lookup')
  if (ts.isCallExpression(node)) assert.equal(node.expression.getText(syntax), 'Number.isInteger', 'Unreviewed lookup call could allocate')
  ts.forEachChild(node, checkLookup)
}
checkLookup(lookup.body)
const javascript = ts.transpileModule(runtimeText, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
function loadRuntime(data) {
  const exports = {}
  runInNewContext(javascript, { exports, require: spec => {
    assert.equal(spec, '../weapon-visual-manifest.json')
    return JSON.parse(JSON.stringify(data))
  } }, { timeout: 1000 })
  return exports
}
const runtime = loadRuntime(manifest)
const plain = value => JSON.parse(JSON.stringify(value))
assert.equal(runtime.WEAPON_VISUAL_COUNT, 50)
for (const profile of manifest.profiles) {
  const result = runtime.lookupWeaponVisual(profile.weaponClass, profile.caliber)
  assert.deepEqual(plain(result), profile.style)
  assert(Object.isFrozen(result) && Object.isFrozen(result.tracer) && Object.isFrozen(result.tracer.colorLinearRGB) && Object.isFrozen(result.muzzle))
  for (let i = 0; i < 1000; i++) assert.strictEqual(runtime.lookupWeaponVisual(profile.weaponClass, profile.caliber), result)
}
const sharedClass = loadRuntime({ ...manifest, profileCount: 2, profiles: [first, { ...sameStyle, caliber: first.caliber + 1, style: authorStyle('Heal') }] })
assert.equal(sharedClass.lookupWeaponVisual(first.weaponClass, first.caliber).family, 'cannon')
assert.equal(sharedClass.lookupWeaponVisual(first.weaponClass, first.caliber + 1).family, 'heal')
assert.throws(() => loadRuntime({ ...manifest, profileCount: 2, profiles: [first, { ...sameStyle, style: authorStyle('Heal') }] }), /Conflicting weapon visual binding/)
const maxTable = loadRuntime({ ...manifest, profileCount: 256, profiles: Array.from({ length: 256 }, (_, caliber) => ({ ...first, weaponClass: 1, caliber })) })
for (let caliber = 0; caliber < 256; caliber++) assert.equal(maxTable.lookupWeaponVisual(1, caliber).family, 'cannon')
assert.throws(() => loadRuntime({ ...manifest, profileCount: 257, profiles: Array(257).fill(first) }), /Invalid weapon visual manifest/)
for (const [id, caliber] of [[0, 0], [256, 1], [1.1, 0], [NaN, 0], [Infinity, 0], [first.weaponClass, -1],
  [first.weaponClass, 65536], [first.weaponClass, .5], [first.weaponClass, NaN], [first.weaponClass, undefined], [first.weaponClass, '2500']])
  assert.strictEqual(runtime.lookupWeaponVisual(id, caliber), runtime.UNKNOWN_WEAPON_VISUAL)
for (let id = 1; id <= 255; id++) {
  if (!pairs.has(`${id}/12345`)) assert.strictEqual(runtime.lookupWeaponVisual(id, 12345), runtime.UNKNOWN_WEAPON_VISUAL)
}

const style = weapon => {
  const p = manifest.profiles.find(p => p.weapon === weapon)
  return runtime.lookupWeaponVisual(p.weaponClass, p.caliber)
}
const representative = { Pistol: 'bullet', M60mg: 'mg', '90mm': 'cannon', '155mm': 'artillery', Dragon: 'rocket', TorpTube: 'torpedo', TeslaZap: 'electric', Flamer: 'flame', DogJaw: 'melee', Heal: 'heal' }
for (const [weapon, family] of Object.entries(representative)) assert.equal(style(weapon).family, family, `Wrong representative family: ${weapon}`)
assert.equal(new Set(Object.keys(representative).map(w => JSON.stringify(style(w)))).size, 10)
for (const names of [['25mm', '90mm', '105mm', '120mm'], ['PortaTesla', 'TTankZap', 'TeslaZap'], ['Flamer', 'AntFireball', 'FireballLauncher']]) {
  const widths = names.map(n => style(n).tracer.widthM)
  for (let i = 1; i < widths.length; i++) assert(widths[i] > widths[i - 1], 'Named size variants collapsed')
}
for (const name of ['PortaTesla', 'TTankZap', 'TeslaZap']) {
  const s = style(name)
  assert.equal(s.tracer.style, 'arc')
  assert(s.tracer.colorLinearRGB[2] > s.tracer.colorLinearRGB[0], 'Electric became an orange bullet')
  assert.equal(s.impact, 'electrical')
}
for (const name of ['Heal', 'Repair', 'DogJaw', 'claw', 'mandible', 'MandibleHeavy', 'DemoTruckTargeting']) {
  const s = style(name)
  assert.equal(s.tracer.style, 'none', `Suppressed weapon drew tracer: ${name}`)
  assert.equal(s.tracer.widthM, 0)
  assert.equal(s.tracer.lifetimeSeconds, 0)
  assert.equal(s.muzzle.style, 'none')
  assert.equal(s.muzzle.scaleM, 0)
  assert.equal(s.smoke, 'none')
  assert.equal(s.impact, 'none', `Suppressed weapon became explosion: ${name}`)
}
assert.equal(style('TorpTube').tracer.style, 'wake')
assert.equal(style('TorpTube').muzzle.style, 'none')
assert.equal(style('Flamer').tracer.style, 'flame')
for (const s of [...manifest.profiles.map(p => p.style), manifest.fallback]) {
  assert.deepEqual(Object.keys(s).sort(), ['family', 'impact', 'muzzle', ...(s.projectile ? ['projectile'] : []), 'smoke', 'tracer'])
  if (s.projectile) {
    const p = s.projectile
    assert(['missile', 'heavy-rocket', 'torpedo', 'bomb', 'depth-charge', 'grenade'].includes(p.body))
    assert(['off-white', 'light-grey', 'olive'].includes(p.material))
    assert(p.lengthM > .02 && p.lengthM < 1.5 && p.radiusM > .002 && p.radiusM < .1)
    assert(p.trail.widthM > 0 && p.trail.widthM < .5 && p.trail.lifetimeS > 0 && p.trail.lifetimeS < 5)
    assert.equal(p.trail.colorLinearRGB.length, 3)
    if (['torpedo','bomb','depth-charge'].includes(p.body)) assert.equal(p.exhaust, false)
  }
  assert.deepEqual(Object.keys(s.tracer).sort(), ['colorLinearRGB', 'lifetimeSeconds', 'style', 'widthM'])
  assert.deepEqual(Object.keys(s.muzzle).sort(), ['scaleM', 'style'])
  assert.equal(s.tracer.colorLinearRGB.length, 3)
  assert(s.tracer.colorLinearRGB.every(c => Number.isFinite(c) && c >= 0 && c <= 1))
  assert(Number.isFinite(s.tracer.widthM) && s.tracer.widthM >= 0 && s.tracer.widthM <= .3)
  assert(Number.isFinite(s.tracer.lifetimeSeconds) && s.tracer.lifetimeSeconds >= 0 && s.tracer.lifetimeSeconds <= .4)
  assert(Number.isFinite(s.muzzle.scaleM) && s.muzzle.scaleM >= 0 && s.muzzle.scaleM <= 1.25)
}
console.log('weaponvisualgate: PASS — 50 authoritative profiles; deterministic, bounded runtime, collision controls, linear colors, distinct styles and suppression verified. Renderer/projectile observer binding remains pending.')
